"""
S1 — Hallmark OCR + BIS HUID detection.

Phase 8: Local-first approach using huid_detector.py (no VLM needed).
- Stub/empty frames → low-confidence valid SignalResult (no error)
- Real URL/data URI → OpenCV-based analyze_hallmark()
- VLM is additive only when VLM_API_URL is set to a non-localhost URL (production)
"""
import os
import time
import logging
import numpy as np

from app.models.schemas import SignalResult
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s1")

_VLM_API_URL = os.getenv("VLM_API_URL", "http://localhost:11434/v1")
_IS_PRODUCTION_VLM = (
    _VLM_API_URL
    and "localhost" not in _VLM_API_URL
    and "127.0.0.1" not in _VLM_API_URL
)

_STUB_PAYLOAD = {
    "bis_logo_present": False,
    "purity_mark": None,
    "huid_code": None,
    "stamp_appearance": "unclear",
}

_VLM_PROMPT = """Examine this gold jewelry image for BIS hallmark stamps.
Return ONLY valid JSON:
{
  "bis_logo_present": boolean,
  "purity_mark": "22K916" | "18K750" | null,
  "huid_code": "6-char alphanumeric or null",
  "stamp_appearance": "laser_engraved" | "embossed" | "stamped" | "unclear" | null,
  "ocr_confidence": 0.0 to 1.0
}"""


def _is_stub(url: str) -> bool:
    return not url or url.startswith("local://")


async def run(session_id: str, macro_url: str = "", **_) -> SignalResult:
    t0 = time.time()

    # ── Stub / empty frame → low-confidence, no error ────────────────────────
    if _is_stub(macro_url):
        return SignalResult(
            signal_id="s1_huid",
            confidence=0.1,
            payload=_STUB_PAYLOAD,
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-huid-v1",
        )

    # ── Real frame → fetch + local OpenCV analysis ────────────────────────────
    try:
        from app.data.huid_detector import analyze_hallmark

        raw = await fetch_image_bytes(macro_url)
        if raw is None:
            # Fetch failed but not a stub — return low confidence, no error
            return SignalResult(
                signal_id="s1_huid",
                confidence=0.1,
                payload=_STUB_PAYLOAD,
                error=None,
                duration_ms=int((time.time() - t0) * 1000),
                model_version="local-huid-v1",
            )

        arr = np.frombuffer(raw, dtype=np.uint8)
        import cv2
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return SignalResult(
                signal_id="s1_huid",
                confidence=0.1,
                payload=_STUB_PAYLOAD,
                error=None,
                duration_ms=int((time.time() - t0) * 1000),
                model_version="local-huid-v1",
            )

        result = analyze_hallmark(img)
        confidence = float(result.get("ocr_confidence", 0.3))
        if not result.get("huid_code"):
            confidence *= 0.7

        # ── Production VLM blend (only when non-localhost VLM configured) ────
        if _IS_PRODUCTION_VLM:
            try:
                from app.data.vlm import call_vlm
                vlm_result = await call_vlm(_VLM_PROMPT, [macro_url])
                vlm_conf = float(vlm_result.get("ocr_confidence", confidence))
                # Blend local (40%) + VLM (60%)
                confidence = round(confidence * 0.4 + vlm_conf * 0.6, 3)
                # Use VLM values when higher quality
                if vlm_result.get("purity_mark"):
                    result["purity_mark"] = vlm_result["purity_mark"]
                if vlm_result.get("huid_code"):
                    result["huid_code"] = vlm_result["huid_code"]
                if vlm_result.get("bis_logo_present") is not None:
                    result["bis_logo_present"] = bool(vlm_result["bis_logo_present"])
                if vlm_result.get("stamp_appearance"):
                    result["stamp_appearance"] = vlm_result["stamp_appearance"]
            except Exception as vlm_err:
                logger.debug(f"[{session_id}] VLM blend skipped: {vlm_err}")

        return SignalResult(
            signal_id="s1_huid",
            confidence=round(min(confidence, 0.99), 3),
            payload={
                "bis_logo_present": bool(result.get("bis_logo_present", False)),
                "purity_mark": result.get("purity_mark"),
                "huid_code": result.get("huid_code"),
                "stamp_appearance": result.get("stamp_appearance", "unclear"),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-huid-v1",
        )

    except Exception as e:
        logger.debug(f"[{session_id}] s1_huid local analysis exception (non-fatal): {e}")
        # Return low confidence, never an error result
        return SignalResult(
            signal_id="s1_huid",
            confidence=0.1,
            payload=_STUB_PAYLOAD,
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-huid-v1",
        )
