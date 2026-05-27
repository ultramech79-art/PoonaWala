#!/usr/bin/env python3.11
"""
Standalone Python 3.11 script — runs the Pipecat pipeline for one guided session.
Launched as a subprocess by guided_session.py route handler.

Usage:
  python3.11 run_pipeline.py --session-id <id> --room-url <url> --bot-token <tok> --state-file <path>

Writes JSON progress to --state-file so the FastAPI route (Python 3.9) can poll it.
"""
import argparse
import asyncio
import base64
import json
import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("goldeye.pipeline.subprocess")

GROQ_API_KEY     = os.getenv("GROQ_API_KEY", "")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")

ANGLES = ["top", "45deg", "side", "macro", "selfie"]
SAMPLE_INTERVAL  = 3.0
QUALITY_THRESHOLD = 0.55


# ── State file helpers ────────────────────────────────────────────────────────

def write_state(state_file: str, data: dict):
    path = Path(state_file)
    path.write_text(json.dumps(data))


# ── Frame analyzer (Python 3.11 only) ────────────────────────────────────────

from pipecat.frames.frames import Frame, TextFrame, UserImageRawFrame, EndFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

ANGLE_LABELS = {
    "top":    "top-down shot",
    "45deg":  "45-degree angle",
    "side":   "side profile",
    "macro":  "close-up hallmark",
    "selfie": "selfie with your gold",
}

ANGLE_INSTRUCTIONS = {
    "top":    "Place your gold flat on a white surface and hold the camera directly above it.",
    "45deg":  "Tilt the camera to 45 degrees so I can see the depth and shape of the piece.",
    "side":   "Hold the camera level with the edge of the gold so I can see its thickness.",
    "macro":  "Move very close to the hallmark stamp — I need to read the karat marking.",
    "selfie": "Take a selfie holding the gold clearly in front of your face.",
}

CAPTURE_SUCCESS = {
    "top":    "Great top shot! I can see the piece clearly.",
    "45deg":  "Perfect angle — the depth is visible.",
    "side":   "Good side view — I can see the thickness.",
    "macro":  "Excellent! The hallmark is readable.",
    "selfie": "Identity captured. You're all set!",
}

SYSTEM_PROMPT = """\
You are GoldEye, a friendly gold loan assessment agent from Poonawalla Fincorp.
You are guiding a customer through a live video gold appraisal.
Keep responses SHORT — 1-2 sentences. This is a voice conversation.
When all 5 angles are captured, say: "Excellent! I have everything I need. Analyzing your gold now."
"""


class GoldFrameAnalyzer(FrameProcessor):
    def __init__(self, session_id: str, state_file: str, on_complete, **kwargs):
        super().__init__(**kwargs)
        self.session_id  = session_id
        self.state_file  = state_file
        self.on_complete = on_complete

        self._angle_index  = 0
        self._captured: dict[str, dict] = {}
        self._last_sample  = 0.0
        self._done         = False
        self._latest_frame: bytes | None = None
        self._lock = asyncio.Lock()

        self._write_state()

    @property
    def current_angle(self) -> str | None:
        if self._angle_index >= len(ANGLES):
            return None
        return ANGLES[self._angle_index]

    def _write_state(self):
        write_state(self.state_file, {
            "captured":      list(self._captured.keys()),
            "pending":       ANGLES[self._angle_index:],
            "current_angle": self.current_angle,
            "all_done":      self._done,
        })

    def get_intro_message(self) -> str:
        angle = self.current_angle
        if not angle:
            return "Ready to assess your gold!"
        return (
            f"Hello! I'm your GoldEye assessment agent. "
            f"Let's start with the {ANGLE_LABELS[angle]}. "
            f"{ANGLE_INSTRUCTIONS[angle]}"
        )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, UserImageRawFrame):
            async with self._lock:
                self._latest_frame = frame.image

        await self.push_frame(frame, direction)

        now = time.time()
        if (
            not self._done
            and self.current_angle
            and (now - self._last_sample) >= SAMPLE_INTERVAL
            and self._latest_frame is not None
        ):
            self._last_sample = now
            asyncio.create_task(self._analyze())

    async def _analyze(self):
        async with self._lock:
            raw = self._latest_frame
        if raw is None or self._done:
            return

        angle = self.current_angle
        if not angle:
            return

        try:
            b64 = base64.b64encode(raw).decode() if isinstance(raw, bytes) else raw
            sys.path.insert(0, str(Path(__file__).parent.parent.parent))
            from app.data.gemini import evaluate_frame
            result = await evaluate_frame(b64, angle)
        except Exception as e:
            logger.warning(f"Frame analysis error for {angle}: {e}")
            return

        quality  = float(result.get("quality_score", 0))
        approved = result.get("approved", False) and quality >= QUALITY_THRESHOLD

        logger.info(f"angle={angle} quality={quality:.2f} approved={approved}")

        if approved:
            await self._approve(angle, result)
        else:
            await self._fail(angle, result)

    async def _approve(self, angle: str, result: dict):
        self._captured[angle] = result
        self._angle_index += 1
        self._write_state()

        success = CAPTURE_SUCCESS.get(angle, "Got it!")

        if self._angle_index >= len(ANGLES):
            self._done = True
            self._write_state()
            guidance = "Excellent! I have everything I need. Analyzing your gold now — please wait."
            await self.push_frame(TextFrame(guidance), FrameDirection.DOWNSTREAM)
            if self.on_complete:
                asyncio.create_task(self.on_complete(self._captured))
        else:
            nxt = ANGLES[self._angle_index]
            guidance = f"{success} Now I need the {ANGLE_LABELS[nxt]}. {ANGLE_INSTRUCTIONS[nxt]}"
            await self.push_frame(TextFrame(guidance), FrameDirection.DOWNSTREAM)

    async def _fail(self, angle: str, result: dict):
        issues   = result.get("issues", [])
        feedback = result.get("feedback", "")
        issues_str = " ".join(issues).lower()

        if "blurry" in issues_str or "blur" in feedback.lower():
            hint = "It's a bit blurry — hold steady and try again."
        elif "dark" in issues_str:
            hint = "The lighting is too dark — move to a brighter spot."
        elif "gold" in issues_str and "not" in feedback.lower():
            hint = "I can't see the gold — make sure it fills most of the frame."
        else:
            hint = f"Let's try that again. {ANGLE_INSTRUCTIONS.get(angle, '')}"

        await self.push_frame(TextFrame(hint), FrameDirection.DOWNSTREAM)


# ── Pipeline ─────────────────────────────────────────────────────────────────

async def run(session_id: str, room_url: str, bot_token: str, state_file: str):
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineTask, PipelineParams
    from pipecat.frames.frames import LLMContextFrame
    from pipecat.transports.daily.transport import DailyTransport, DailyParams
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.services.groq.stt import GroqSTTService
    from pipecat.services.groq.llm import GroqLLMService
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

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

    stt = GroqSTTService(api_key=GROQ_API_KEY, model="whisper-large-v3-turbo")
    llm = GroqLLMService(api_key=GROQ_API_KEY, model="llama-3.3-70b-versatile")
    tts = _build_tts()

    done_event = asyncio.Event()

    async def on_complete(captured: dict):
        logger.info(f"[{session_id}] All angles done")
        await asyncio.sleep(5)
        done_event.set()

    analyzer = GoldFrameAnalyzer(
        session_id=session_id,
        state_file=state_file,
        on_complete=on_complete,
    )

    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}])
    aggregators = LLMContextAggregatorPair(context)

    pipeline = Pipeline([
        transport.input(),
        stt,
        analyzer,
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

    @transport.event_handler("on_participant_joined")
    async def on_join(transport_ref, participant):
        if participant.get("info", {}).get("userName") == "GoldEye Agent":
            return
        logger.info(f"[{session_id}] Customer joined")
        intro = analyzer.get_intro_message()
        context.add_message({"role": "assistant", "content": intro})
        await task.queue_frame(TextFrame(intro))

    runner = PipelineRunner()

    async def _wait_done():
        await done_event.wait()
        await task.queue_frame(EndFrame())

    asyncio.create_task(_wait_done())
    await runner.run(task)
    logger.info(f"[{session_id}] Pipeline complete")


def _build_tts():
    if CARTESIA_API_KEY:
        try:
            from pipecat.services.cartesia.tts import CartesiaTTSService
            return CartesiaTTSService(
                api_key=CARTESIA_API_KEY,
                voice_id="f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d",  # Kiara — Indian English
                model="sonic-2",
            )
        except ImportError:
            pass

    try:
        from pipecat.services.edge_tts import EdgeTTSService
        return EdgeTTSService(voice="en-IN-NeerjaNeural")
    except ImportError:
        pass

    raise RuntimeError("No TTS available. Install pipecat-ai[cartesia] or edge-tts.")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id",  required=True)
    parser.add_argument("--room-url",    required=True)
    parser.add_argument("--bot-token",   required=True)
    parser.add_argument("--state-file",  required=True)
    args = parser.parse_args()

    asyncio.run(run(
        session_id=args.session_id,
        room_url=args.room_url,
        bot_token=args.bot_token,
        state_file=args.state_file,
    ))
