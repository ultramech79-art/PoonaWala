"""
S3 — Gemini API color/purity analysis signal worker.
Uses Google Gemini 2.0 Flash to estimate gold karat purity from jewelry images.
"""
import time
import logging

from app.models.schemas import SignalResult
from app.data.image_utils import fetch_image_bytes
from app.data.gemini import analyze_image_fallback

logger = logging.getLogger("goldeye.workers.s3_color")


async def run(session_id: str, frames: list[str]) -> SignalResult:
    """
    Args:
        session_id: for logging / tracing.
        frames: list of image URLs or base64 data-URIs.
                Uses the first non-stub frame for Gemini analysis.
    """
    t0 = time.time()
    try:
        import base64

        # Find first real frame
        real_frame = None
        for url in frames:
            if url and not url.startswith("local://"):
                real_frame = url
                break

        if not real_frame:
            return SignalResult(
                signal_id="s3_color",
                confidence=0.0,
                payload={"reason": "no_real_frames", "karat_probabilities": {}},
                error="no_real_frames",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="gemini-color-v1",
            )

        # Fetch and encode image
        raw = await fetch_image_bytes(real_frame)
        if raw is None:
            return SignalResult(
                signal_id="s3_color",
                confidence=0.0,
                payload={"reason": "fetch_failed", "karat_probabilities": {}},
                error="fetch_failed",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="gemini-color-v1",
            )

        img_b64 = base64.b64encode(raw).decode('utf-8')

        # Use Gemini to analyze purity
        result = await analyze_image_fallback(
            image_base64=img_b64,
            analysis_type="purity"
        )

        if result.get("error"):
            return SignalResult(
                signal_id="s3_color",
                confidence=0.0,
                payload={"reason": result.get("error"), "karat_probabilities": {}},
                error=result.get("error"),
                duration_ms=int((time.time() - t0) * 1000),
                model_version="gemini-color-v1",
            )

        # Extract karat estimate
        estimated_karat = result.get("estimated_karat", 22)
        confidence = result.get("confidence", 0.5)
        karat_str = f"{estimated_karat}K"

        return SignalResult(
            signal_id="s3_color",
            confidence=round(confidence, 3),
            payload={
                "best_karat": karat_str,
                "best_karat_int": estimated_karat,
                "karat_probabilities": {karat_str: 1.0},
                "frames_analyzed": 1,
                "method": "gemini_purity_analysis",
                "color_analysis": result.get("color_analysis", ""),
                "hallmark_visible": result.get("hallmark_visible", False),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-color-v1",
        )

    except Exception as exc:
        logger.exception(f"[{session_id}] S3 color analysis failed: {exc}")
        return SignalResult(
            signal_id="s3_color",
            confidence=0.0,
            payload={},
            error=str(exc),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-color-v1",
        )
