"""
S7 — Gemini API plated vs. solid classifier.
Uses Google Gemini 2.0 Flash to analyze jewelry images and determine if solid or plated.
"""
import time
import logging
from typing import Optional

from app.models.schemas import SignalResult
from app.data.image_utils import fetch_image_bytes
from app.data.gemini import analyze_image_fallback

logger = logging.getLogger("goldeye.workers.s7")


def _is_stub(url: str) -> bool:
    return not url or url.startswith("local://")


async def run(session_id: str, frames: list[str], **_) -> SignalResult:
    t0 = time.time()

    real_frames = [f for f in frames if not _is_stub(f)]

    # ── All stub frames → default, no error ──────────────────────────────────
    if not real_frames:
        return SignalResult(
            signal_id="s7_plated_solid",
            confidence=0.2,
            payload={
                "solid_probability": 0.5,
                "plated_probability": 0.5,
                "visual_cues": [],
                "model": "stub_default",
                "frames_scored": 0,
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-plated-solid-v1",
        )

    # ── Real frames → Gemini API analysis ────────────────────────────────────
    try:
        import base64

        # Try each frame with Gemini until we get a confident result
        for url in real_frames[:2]:  # Try top-down and 45-degree frames
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue

            img_b64 = base64.b64encode(raw).decode('utf-8')
            result = await analyze_image_fallback(
                image_base64=img_b64,
                analysis_type="plated_solid"
            )

            if not result.get("error") and "is_solid" in result:
                is_solid = result.get("is_solid", False)
                confidence = result.get("confidence", 0.5)
                solid_prob = 1.0 if is_solid else 0.0

                return SignalResult(
                    signal_id="s7_plated_solid",
                    confidence=round(confidence, 3),
                    payload={
                        "solid_probability": round(solid_prob, 3),
                        "plated_probability": round(1.0 - solid_prob, 3),
                        "visual_cues": result.get("wear_indicators", ""),
                        "model": "image_analysis",
                        "frames_scored": 1,
                        "reason": result.get("reason", ""),
                    },
                    error=None,
                    duration_ms=int((time.time() - t0) * 1000),
                    model_version="plated-solid-v1",
                )

        # If all frames failed or returned errors
        return SignalResult(
            signal_id="s7_plated_solid",
            confidence=0.0,
            payload={
                "solid_probability": 0.5,
                "plated_probability": 0.5,
                "visual_cues": [],
                "model": "analysis_failed",
                "frames_scored": 0,
            },
            error="Could not analyze frames",
            duration_ms=int((time.time() - t0) * 1000),
            model_version="plated-solid-v1",
        )

    except Exception as e:
        logger.debug(f"[{session_id}] s7_plated_solid exception: {e}")
        return SignalResult(
            signal_id="s7_plated_solid",
            confidence=0.0,
            payload={
                "solid_probability": 0.5,
                "plated_probability": 0.5,
                "visual_cues": [],
                "model": "error",
                "frames_scored": 0,
            },
            error=str(e),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-plated-solid-v1",
        )
