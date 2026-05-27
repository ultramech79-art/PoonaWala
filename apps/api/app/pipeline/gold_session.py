"""
Pipecat pipeline for a continuous guided gold assessment session.

Flow:
  Daily WebRTC transport (browser camera + mic)
    → SileroVAD (voice activity detection)
    → GroqSTT (Whisper transcription)
    → GoldFrameAnalyzer (frame quality grading + angle tracking)
    → GroqLLM (guidance generation — llama-3.3-70b-versatile)
    → TTS (Cartesia or edge-tts fallback)
    → Daily transport out (AI voice back to browser)

When all 5 angles are captured:
  GoldFrameAnalyzer fires on_complete callback → triggers /api/assess
"""
import os
import asyncio
import logging
from typing import Optional

logger = logging.getLogger("goldeye.pipeline")

DAILY_API_KEY   = os.getenv("DAILY_API_KEY", "")
GROQ_API_KEY    = os.getenv("GROQ_API_KEY", "")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")
DAILY_API_URL   = "https://api.daily.co/v1"


# ── Daily room management ────────────────────────────────────────────────────

async def create_daily_room(session_id: str) -> dict:
    """Create a short-lived Daily room and return {url, token}."""
    import httpx
    if not DAILY_API_KEY:
        raise RuntimeError("DAILY_API_KEY not set — cannot create Daily room")

    headers = {
        "Authorization": f"Bearer {DAILY_API_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=10) as client:
        # Create room
        r = await client.post(
            f"{DAILY_API_URL}/rooms",
            headers=headers,
            json={
                "name": f"goldeye-{session_id[:8]}",
                "privacy": "private",
                "properties": {
                    "exp": int(asyncio.get_event_loop().time()) + 3600,
                    "enable_chat": False,
                    "enable_screenshare": False,
                    "start_video_off": False,
                    "start_audio_off": False,
                    "max_participants": 2,
                },
            },
        )
        r.raise_for_status()
        room = r.json()
        room_url = room["url"]
        room_name = room["name"]

        # Create meeting token for the bot
        t = await client.post(
            f"{DAILY_API_URL}/meeting-tokens",
            headers=headers,
            json={
                "properties": {
                    "room_name": room_name,
                    "is_owner": True,
                    "user_name": "GoldEye Agent",
                    "exp": int(asyncio.get_event_loop().time()) + 3600,
                }
            },
        )
        t.raise_for_status()
        bot_token = t.json()["token"]

        # Create meeting token for the user (browser)
        u = await client.post(
            f"{DAILY_API_URL}/meeting-tokens",
            headers=headers,
            json={
                "properties": {
                    "room_name": room_name,
                    "user_name": "Customer",
                    "exp": int(asyncio.get_event_loop().time()) + 3600,
                }
            },
        )
        u.raise_for_status()
        user_token = u.json()["token"]

    return {
        "room_url": room_url,
        "room_name": room_name,
        "bot_token": bot_token,
        "user_token": user_token,
    }


# ── Pipeline runner ──────────────────────────────────────────────────────────

async def run_gold_pipeline(
    session_id: str,
    room_url: str,
    bot_token: str,
    on_assessment_ready,   # async callback(captured_frames_dict)
):
    """
    Build and run the Pipecat pipeline. Blocks until session ends.
    Meant to be run as a background asyncio task.
    """
    try:
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineTask, PipelineParams
        from pipecat.frames.frames import TextFrame, EndFrame
        from pipecat.transports.services.daily import DailyTransport, DailyParams
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.services.groq import GroqSTTService, GroqLLMService
        from pipecat.processors.aggregators.openai_llm_context import (
            OpenAILLMContext,
            OpenAILLMContextAggregator,
        )
    except ImportError as e:
        logger.error(f"Pipecat not installed: {e}. Run: pip install 'pipecat-ai[daily,groq,silero]'")
        return

    from app.pipeline.frame_analyzer import GoldFrameAnalyzer
    from app.pipeline.guidance_prompts import SYSTEM_PROMPT

    # ── Transport ──────────────────────────────────────────────────────────────
    transport = DailyTransport(
        room_url,
        bot_token,
        "GoldEye Agent",
        DailyParams(
            audio_out_enabled=True,
            audio_in_enabled=True,
            video_out_enabled=False,
            video_in_enabled=True,       # we need to see the customer's camera
            transcription_enabled=False,  # we use Groq STT instead
            vad_enabled=True,
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
        logger.info(f"[{session_id}] All angles captured — triggering assessment")
        await on_assessment_ready(captured)
        # Give TTS time to finish speaking before ending
        await asyncio.sleep(5)
        await task.queue_frame(EndFrame())

    frame_analyzer = GoldFrameAnalyzer(session_id=session_id, on_complete=_on_complete)

    # ── LLM context ────────────────────────────────────────────────────────────
    context = OpenAILLMContext(messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "assistant", "content": frame_analyzer.get_intro_message()},
    ])
    context_aggregator = llm.create_context_aggregator(context)

    # ── Pipeline ───────────────────────────────────────────────────────────────
    pipeline = Pipeline([
        transport.input(),
        stt,
        frame_analyzer,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        PipelineParams(allow_interruptions=True, enable_metrics=False),
    )

    # Speak the intro message as soon as the bot joins
    @transport.event_handler("on_participant_joined")
    async def on_join(transport_ref, participant):
        if participant.get("info", {}).get("userName") == "GoldEye Agent":
            return
        logger.info(f"[{session_id}] Customer joined — sending intro")
        await task.queue_frame(
            TextFrame(frame_analyzer.get_intro_message())
        )

    runner = PipelineRunner()
    await runner.run(task)
    logger.info(f"[{session_id}] Pipeline ended")


def _build_tts():
    """Return a TTS service. Cartesia if key present, else edge-tts fallback."""
    if CARTESIA_API_KEY:
        try:
            from pipecat.services.cartesia import CartesiaTTSService
            return CartesiaTTSService(
                api_key=CARTESIA_API_KEY,
                voice_id="79a125e8-cd45-4c13-8a67-188112f4dd22",  # British Lady
            )
        except ImportError:
            pass

    # edge-tts is free and requires no API key
    try:
        from pipecat.services.edge_tts import EdgeTTSService
        return EdgeTTSService(voice="en-IN-NeerjaNeural")
    except ImportError:
        pass

    # Last resort: Google TTS via gTTS (pip install pipecat-ai[google])
    try:
        from pipecat.services.google import GoogleTTSService
        return GoogleTTSService(voice_id="en-IN-Standard-A")
    except ImportError:
        pass

    raise RuntimeError(
        "No TTS service available. "
        "Install one of: pipecat-ai[cartesia], pipecat-ai[google], or edge-tts"
    )


# ── Active sessions registry ─────────────────────────────────────────────────
# Maps session_id → {task, progress_getter, room_url}
_active_sessions: dict = {}


def get_session_progress(session_id: str) -> Optional[dict]:
    entry = _active_sessions.get(session_id)
    if not entry:
        return None
    return entry["progress_getter"]()


def end_session(session_id: str):
    _active_sessions.pop(session_id, None)
