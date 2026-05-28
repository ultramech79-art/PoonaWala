"""
Pipecat 1.2.1 pipeline for a continuous guided gold assessment session.

Flow:
  Daily WebRTC transport (browser camera + mic)
    → SileroVAD (voice activity detection)
    → GroqSTT (Whisper transcription)
    → GoldFrameAnalyzer (frame quality grading + angle tracking)
    → LLMUserAggregator (adds transcription to context)
    → GroqLLM (guidance generation — llama-3.3-70b-versatile)
    → CartesiaTTS (Kiara — Indian-accented English)
    → Daily transport out (AI voice back to browser)

When all 5 angles are captured:
  GoldFrameAnalyzer fires on_complete callback → sets all_done flag for polling
"""
import os
import asyncio
import logging
from typing import Optional

logger = logging.getLogger("goldeye.pipeline")

DAILY_API_KEY    = os.getenv("DAILY_API_KEY", "")
GROQ_API_KEY     = os.getenv("GROQ_API_KEY", "")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")
DAILY_API_URL    = "https://api.daily.co/v1"


# ── Daily room management ────────────────────────────────────────────────────

async def create_daily_room(session_id: str) -> dict:
    """Create a short-lived Daily room and return {room_url, bot_token, user_token}."""
    import httpx
    import time

    if not DAILY_API_KEY:
        raise RuntimeError("DAILY_API_KEY not set — cannot create Daily room")

    exp = int(time.time()) + 3600
    headers = {
        "Authorization": f"Bearer {DAILY_API_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{DAILY_API_URL}/rooms",
            headers=headers,
            json={
                "name": f"goldeye-{session_id[:8]}",
                "privacy": "private",
                "properties": {
                    "exp": exp,
                    "enable_chat": False,
                    "enable_screenshare": False,
                    "max_participants": 2,
                },
            },
        )
        r.raise_for_status()
        room_name = r.json()["name"]
        room_url  = r.json()["url"]

        # Bot token (owner)
        t = await client.post(
            f"{DAILY_API_URL}/meeting-tokens",
            headers=headers,
            json={"properties": {"room_name": room_name, "is_owner": True, "user_name": "GoldEye Agent", "exp": exp}},
        )
        t.raise_for_status()
        bot_token = t.json()["token"]

        # User token
        u = await client.post(
            f"{DAILY_API_URL}/meeting-tokens",
            headers=headers,
            json={"properties": {"room_name": room_name, "user_name": "Customer", "exp": exp}},
        )
        u.raise_for_status()
        user_token = u.json()["token"]

    return {"room_url": room_url, "room_name": room_name, "bot_token": bot_token, "user_token": user_token}


# ── Pipeline runner ──────────────────────────────────────────────────────────

async def run_gold_pipeline(
    session_id: str,
    room_url: str,
    bot_token: str,
    on_assessment_ready,
):
    """Build and run the Pipecat 1.2.1 pipeline. Blocks until session ends."""
    try:
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineTask, PipelineParams
        from pipecat.frames.frames import TextFrame, LLMContextFrame, EndFrame
        from pipecat.transports.daily.transport import DailyTransport, DailyParams
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.services.groq.stt import GroqSTTService
        from pipecat.services.groq.llm import GroqLLMService
        from pipecat.processors.aggregators.llm_context import LLMContext
        from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    except ImportError as e:
        logger.error(f"Pipecat import failed: {e}")
        logger.error("Run: /opt/homebrew/bin/python3.11 -m pip install 'pipecat-ai[daily,groq,silero,cartesia]'")
        return

    from app.pipeline.frame_analyzer import GoldFrameAnalyzer
    from app.pipeline.guidance_prompts import SYSTEM_PROMPT

    # ── Transport ──────────────────────────────────────────────────────────────
    transport = DailyTransport(
        room_url,
        bot_token,
        "GoldEye Agent",
        params=DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            video_in_enabled=True,
            microphone_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    # ── STT ────────────────────────────────────────────────────────────────────
    stt = GroqSTTService(
        api_key=GROQ_API_KEY,
        model="whisper-large-v3-turbo",
    )

    # ── LLM ────────────────────────────────────────────────────────────────────
    llm = GroqLLMService(
        api_key=GROQ_API_KEY,
        model="llama-3.3-70b-versatile",
    )

    # ── TTS ────────────────────────────────────────────────────────────────────
    tts = _build_tts()

    # ── Frame analyzer ─────────────────────────────────────────────────────────
    async def _on_complete(captured: dict):
        logger.info(f"[{session_id}] All 5 angles captured — triggering assessment callback")
        await on_assessment_ready(captured)
        await asyncio.sleep(5)
        await task.queue_frame(EndFrame())

    frame_analyzer = GoldFrameAnalyzer(session_id=session_id, on_complete=_on_complete)

    # ── LLM context + aggregator pair ──────────────────────────────────────────
    context = LLMContext(messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
    ])
    aggregators = LLMContextAggregatorPair(context)

    # ── Pipeline ───────────────────────────────────────────────────────────────
    pipeline = Pipeline([
        transport.input(),
        stt,
        frame_analyzer,
        aggregators.user(),
        llm,
        tts,
        transport.output(),
        aggregators.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        PipelineParams(allow_interruptions=True, enable_metrics=False),
    )

    # Speak the intro message when a non-bot participant joins
    @transport.event_handler("on_participant_joined")
    async def on_join(transport_ref, participant):
        # Skip the bot itself
        info = participant.get("info", {})
        if info.get("userName") == "GoldEye Agent":
            return
        logger.info(f"[{session_id}] Customer joined — queuing intro message")
        intro = frame_analyzer.get_intro_message()
        context.add_message({"role": "assistant", "content": intro})
        await task.queue_frame(TextFrame(intro))

    runner = PipelineRunner()
    await runner.run(task)
    logger.info(f"[{session_id}] Pipeline ended")


def _build_tts():
    """Cartesia Kiara (Indian English) → edge-tts fallback."""
    if CARTESIA_API_KEY:
        try:
            from pipecat.services.cartesia.tts import CartesiaTTSService
            return CartesiaTTSService(
                api_key=CARTESIA_API_KEY,
                # Kiara — English, Indian-accented female, clear enunciation
                voice_id="f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d",
                model="sonic-2",
            )
        except ImportError:
            logger.warning("Cartesia not installed — falling back to edge-tts")

    try:
        from pipecat.services.edge_tts import EdgeTTSService
        return EdgeTTSService(voice="en-IN-NeerjaNeural")
    except ImportError:
        pass

    raise RuntimeError("No TTS available. Install pipecat-ai[cartesia] or edge-tts.")
