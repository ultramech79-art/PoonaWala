"""
GoldFrameAnalyzer — Pipecat FrameProcessor that:
  - Samples video frames from the Daily transport (every SAMPLE_INTERVAL seconds)
  - Calls the existing evaluate_frame() function for quality grading
  - Tracks which of the 5 angles have been approved
  - Pushes a TextFrame into the pipeline with the guidance instruction for the LLM
"""
import asyncio
import base64
import time
import logging
from typing import Optional

from pipecat.frames.frames import (
    Frame,
    TextFrame,
    UserImageRawFrame,
    EndFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

from app.pipeline.guidance_prompts import (
    ANGLES, ANGLE_LABELS, ANGLE_INSTRUCTIONS,
    CAPTURE_SUCCESS_PHRASES, CORRECTION_PHRASES, ALL_DONE_MESSAGE,
)

logger = logging.getLogger("goldeye.frame_analyzer")

SAMPLE_INTERVAL = 3.0      # seconds between frame grabs
QUALITY_THRESHOLD = 0.55   # minimum quality_score to approve an angle


class GoldFrameAnalyzer(FrameProcessor):
    """
    Sits between the Daily transport and the LLM service.
    Captures frames from the video stream, grades them, and injects
    guidance text into the pipeline for the LLM to speak.
    """

    def __init__(self, session_id: str, on_complete=None):
        super().__init__()
        self.session_id = session_id
        self.on_complete = on_complete  # async callback when all angles done

        # Session state
        self._angle_index = 0           # which angle we're currently capturing
        self._captured: dict[str, dict] = {}  # angle → evaluate_frame result
        self._last_sample_ts = 0.0
        self._done = False
        self._latest_frame: Optional[bytes] = None
        self._lock = asyncio.Lock()

    # ── Properties ──────────────────────────────────────────────────────────────

    @property
    def current_angle(self) -> Optional[str]:
        if self._angle_index >= len(ANGLES):
            return None
        return ANGLES[self._angle_index]

    @property
    def progress(self) -> dict:
        return {
            "captured": list(self._captured.keys()),
            "pending": ANGLES[self._angle_index:],
            "current_angle": self.current_angle,
            "all_done": self._done,
        }

    # ── Pipecat frame processing ─────────────────────────────────────────────────

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # Capture raw video frames from Daily
        if isinstance(frame, UserImageRawFrame):
            async with self._lock:
                self._latest_frame = frame.image  # raw bytes or base64

        # Always pass frames downstream
        await self.push_frame(frame, direction)

        # Periodic analysis on downstream pass
        now = time.time()
        if (
            not self._done
            and self.current_angle
            and (now - self._last_sample_ts) >= SAMPLE_INTERVAL
            and self._latest_frame is not None
        ):
            self._last_sample_ts = now
            asyncio.create_task(self._analyze_current_frame())

    # ── Frame analysis ───────────────────────────────────────────────────────────

    async def _analyze_current_frame(self):
        async with self._lock:
            frame_bytes = self._latest_frame

        if frame_bytes is None or self._done:
            return

        angle = self.current_angle
        if angle is None:
            return

        try:
            # Convert raw bytes to base64 for evaluate_frame
            if isinstance(frame_bytes, bytes):
                b64 = base64.b64encode(frame_bytes).decode("utf-8")
            else:
                b64 = frame_bytes  # already b64

            from app.data.gemini import evaluate_frame
            result = await evaluate_frame(b64, angle)
        except Exception as e:
            logger.warning(f"[{self.session_id}] frame analysis error for {angle}: {e}")
            return

        quality = float(result.get("quality_score", 0))
        approved = result.get("approved", False) and quality >= QUALITY_THRESHOLD

        logger.info(f"[{self.session_id}] angle={angle} quality={quality:.2f} approved={approved}")

        if approved:
            await self._on_angle_approved(angle, result)
        else:
            await self._on_angle_failed(angle, result)

    async def _on_angle_approved(self, angle: str, result: dict):
        self._captured[angle] = result
        self._angle_index += 1

        success_text = CAPTURE_SUCCESS_PHRASES.get(angle, "Got it!")

        if self._angle_index >= len(ANGLES):
            # All done
            self._done = True
            guidance = ALL_DONE_MESSAGE
            await self.push_frame(TextFrame(guidance), FrameDirection.DOWNSTREAM)
            if self.on_complete:
                asyncio.create_task(self.on_complete(self._captured))
        else:
            # Move to next angle
            next_angle = ANGLES[self._angle_index]
            next_instruction = ANGLE_INSTRUCTIONS[next_angle]
            guidance = (
                f"{success_text} "
                f"Now I need the {ANGLE_LABELS[next_angle]}. "
                f"{next_instruction}"
            )
            await self.push_frame(TextFrame(guidance), FrameDirection.DOWNSTREAM)

    async def _on_angle_failed(self, angle: str, result: dict):
        issues = result.get("issues", [])
        feedback = result.get("feedback", "")

        # Build correction hint
        if "blurry" in " ".join(issues).lower() or "blur" in feedback.lower():
            hint = CORRECTION_PHRASES["blurry"]
        elif "dark" in " ".join(issues).lower() or "dark" in feedback.lower():
            hint = CORRECTION_PHRASES["dark"]
        elif "gold" in " ".join(issues).lower() and "not" in feedback.lower():
            hint = CORRECTION_PHRASES["no_gold"]
        else:
            instruction = ANGLE_INSTRUCTIONS.get(angle, "")
            hint = f"{CORRECTION_PHRASES['default']}{instruction}"

        await self.push_frame(TextFrame(hint), FrameDirection.DOWNSTREAM)

    # ── Public helpers ───────────────────────────────────────────────────────────

    def get_intro_message(self) -> str:
        angle = self.current_angle
        if not angle:
            return "I'm ready to assess your gold. Please show me the first angle."
        return (
            f"Hello! I'm your GoldEye assessment agent. Let's start with the {ANGLE_LABELS[angle]}. "
            f"{ANGLE_INSTRUCTIONS[angle]}"
        )
