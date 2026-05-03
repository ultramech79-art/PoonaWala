from typing import Optional
"""
S11 — Gemini API audio analysis for solid vs. plated gold detection.
Uses Google Gemini 2.0 Flash as primary method for acoustic resonance analysis.
"""
import time
import logging
from app.models.schemas import SignalResult
from app.data.gemini import analyze_audio_gold_detection

logger = logging.getLogger("goldeye.workers.s11")


async def run(session_id: str, audio_url: Optional[str] = None, **_) -> SignalResult:
    t0 = time.time()
    if not audio_url:
        return SignalResult(
            signal_id="s11_audio",
            confidence=0.0,
            payload={"skipped": True},
            error="No audio provided",
            duration_ms=0,
            model_version="gemini-audio-v1",
        )
    try:
        # Use Gemini API for audio analysis
        result = await analyze_audio_gold_detection(audio_url=audio_url)

        if result.get("error"):
            return SignalResult(
                signal_id="s11_audio",
                confidence=0.0,
                payload={"reason": result.get("error")},
                error=result.get("error"),
                duration_ms=int((time.time() - t0) * 1000),
                model_version="gemini-audio-v1",
            )

        gemini_confidence = result.get("confidence", 0.5)
        gemini_solid = result.get("is_solid_gold", False)
        acoustic_sig = result.get("acoustic_signature", "unknown")

        solid_prob = 1.0 if gemini_solid else 0.0

        return SignalResult(
            signal_id="s11_audio",
            confidence=round(gemini_confidence, 3),
            payload={
                "solid_probability": round(solid_prob, 3),
                "plated_probability": round(1.0 - solid_prob, 3),
                "method": "gemini_audio_analysis",
                "acoustic_signature": acoustic_sig,
                "gemini_confidence": round(gemini_confidence, 3),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-audio-v1",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s11_audio failed: {e}")
        return SignalResult(
            signal_id="s11_audio",
            confidence=0.0,
            payload={},
            error=str(e),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-audio-v1",
        )
