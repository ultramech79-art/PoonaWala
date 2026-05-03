"""
S8 — Holistic visual assessment.

Phase 8: Local-first via CIELAB color analysis + shape heuristics.
- Stub frames → sensible defaults, confidence=0.3, NO error
- Real frames → analyze_color() from color.py + aspect ratio heuristic
- VLM is additive only when VLM_API_URL is non-localhost (production)
"""
import os
import time
import logging
import numpy as np

from app.models.schemas import SignalResult
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s8")

_VLM_API_URL = os.getenv("VLM_API_URL", "http://localhost:11434/v1")
_IS_PRODUCTION_VLM = (
    _VLM_API_URL
    and "localhost" not in _VLM_API_URL
    and "127.0.0.1" not in _VLM_API_URL
)

_VLM_PROMPT = """You are analyzing Indian gold jewelry for a loan pre-qualification system.
Examine all provided images holistically. Return ONLY valid JSON:
{
  "item_type": "ring|bangle|chain|earring|pendant|necklace|other",
  "estimated_karat_band": [low_int, high_int],
  "stones_present": boolean,
  "stones_estimated_carat_total": float,
  "visible_wear": "low|medium|high",
  "concerns": ["list of issues if any"],
  "confidence": 0.0 to 1.0
}"""

_STUB_PAYLOAD = {
    "item_type": "other",
    "estimated_karat_band": [18, 22],
    "stones_present": False,
    "stones_estimated_carat_total": 0.0,
    "visible_wear": "low",
    "concerns": [],
}


def _is_stub(url: str) -> bool:
    return not url or url.startswith("local://")


def _infer_item_type(img_bgr: np.ndarray) -> str:
    """
    Heuristic item type from image dimensions and aspect ratio.
    Tall narrow → "chain"; near-square → "ring"; wide flat → "bangle"; small compact → "pendant"
    """
    try:
        import cv2
        h, w = img_bgr.shape[:2]
        aspect = w / (h + 1e-6)

        # Try to find the object bounding box via edge detection
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 30, 100)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if contours:
            # Largest contour
            largest = max(contours, key=cv2.contourArea)
            x, y, bw, bh = cv2.boundingRect(largest)
            if bw > 0 and bh > 0:
                obj_aspect = bw / bh
                obj_area_frac = (bw * bh) / (w * h)

                if obj_aspect < 0.4:
                    return "chain"
                elif obj_aspect > 2.5:
                    return "bangle"
                elif obj_area_frac < 0.15:
                    return "pendant"
                else:
                    return "ring"

        # Fallback to full-image aspect
        if aspect < 0.5:
            return "chain"
        elif aspect > 2.0:
            return "bangle"
        else:
            return "ring"
    except Exception:
        return "other"


async def _analyze_real_frame(url: str) -> dict:
    """Fetch a real frame and run local analysis. Returns partial payload dict."""
    try:
        from app.data.color import analyze_color
        import cv2

        raw = await fetch_image_bytes(url)
        if raw is None:
            return {}

        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return {}

        color_result = analyze_color(img)
        best_karat = color_result.get("best_karat_int", 18)
        color_conf = color_result.get("color_confidence", 0.3)

        # karat band [best-2, best+2] clamped to valid range
        karat_lo = max(14, best_karat - 2)
        karat_hi = min(24, best_karat + 2)

        item_type = _infer_item_type(img)

        return {
            "item_type": item_type,
            "estimated_karat_band": [karat_lo, karat_hi],
            "stones_present": False,
            "stones_estimated_carat_total": 0.0,
            "visible_wear": "low",
            "concerns": [],
            "confidence": color_conf,
        }
    except Exception as e:
        logger.debug(f"_analyze_real_frame error: {e}")
        return {}


async def run(session_id: str, frames: list[str], **_) -> SignalResult:
    t0 = time.time()

    # ── All stub frames → sensible defaults, no error ────────────────────────
    real_frames = [f for f in frames if not _is_stub(f)]

    if not real_frames:
        return SignalResult(
            signal_id="s8_vlm",
            confidence=0.3,
            payload=_STUB_PAYLOAD,
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-color-v1",
        )

    # ── Real frames → local color + shape analysis ────────────────────────────
    try:
        # Analyze up to 3 frames and aggregate
        analyses = []
        for url in real_frames[:3]:
            result = await _analyze_real_frame(url)
            if result:
                analyses.append(result)

        if not analyses:
            # Fetch/decode failed — still return valid defaults
            return SignalResult(
                signal_id="s8_vlm",
                confidence=0.25,
                payload=_STUB_PAYLOAD,
                error=None,
                duration_ms=int((time.time() - t0) * 1000),
                model_version="local-color-v1",
            )

        # Aggregate: average karat bands, take most common item type, avg confidence
        karat_los = [a["estimated_karat_band"][0] for a in analyses]
        karat_his = [a["estimated_karat_band"][1] for a in analyses]
        confs = [a.get("confidence", 0.3) for a in analyses]
        item_types = [a.get("item_type", "other") for a in analyses]

        avg_karat_lo = int(round(sum(karat_los) / len(karat_los)))
        avg_karat_hi = int(round(sum(karat_his) / len(karat_his)))
        avg_conf = float(sum(confs) / len(confs))
        # Most common item type
        item_type = max(set(item_types), key=item_types.count)

        payload = {
            "item_type": item_type,
            "estimated_karat_band": [avg_karat_lo, avg_karat_hi],
            "stones_present": False,
            "stones_estimated_carat_total": 0.0,
            "visible_wear": "low",
            "concerns": [],
        }

        # ── Production VLM override ───────────────────────────────────────────
        if _IS_PRODUCTION_VLM:
            try:
                from app.data.vlm import call_vlm
                vlm_result = await call_vlm(_VLM_PROMPT, real_frames[:6])
                karat_band = vlm_result.get("estimated_karat_band", [avg_karat_lo, avg_karat_hi])
                if not isinstance(karat_band, list) or len(karat_band) != 2:
                    karat_band = [avg_karat_lo, avg_karat_hi]
                avg_conf = float(vlm_result.get("confidence", avg_conf))
                payload.update({
                    "item_type": vlm_result.get("item_type", item_type),
                    "estimated_karat_band": [int(karat_band[0]), int(karat_band[1])],
                    "stones_present": bool(vlm_result.get("stones_present", False)),
                    "stones_estimated_carat_total": float(vlm_result.get("stones_estimated_carat_total", 0.0)),
                    "visible_wear": vlm_result.get("visible_wear", "low"),
                    "concerns": vlm_result.get("concerns", []),
                })
            except Exception as vlm_err:
                logger.debug(f"[{session_id}] VLM blend skipped: {vlm_err}")

        return SignalResult(
            signal_id="s8_vlm",
            confidence=round(max(0.1, min(avg_conf, 0.99)), 3),
            payload=payload,
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-color-v1",
        )

    except Exception as e:
        logger.debug(f"[{session_id}] s8_vlm exception (non-fatal): {e}")
        return SignalResult(
            signal_id="s8_vlm",
            confidence=0.3,
            payload=_STUB_PAYLOAD,
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="local-color-v1",
        )
