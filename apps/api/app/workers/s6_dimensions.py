from typing import Optional, Union
"""
S6 — Weight estimation from scale anchor + manual entry.
Phase 2: coin-anchored bbox area → volume × density.
Phase 3: Depth Anything V2 Small monocular depth for volume.
"""
import time
import logging
from app.models.schemas import SignalResult
from app.data.image_utils import estimate_weight_from_bbox

logger = logging.getLogger("goldeye.workers.s6")

DENSITY_22K = 17.75  # g/cm³


async def run(
    session_id: str,
    frames: list[str],
    weight_g: Optional[float] = None,
    s5_payload: Optional[dict] = None,
    **_,
) -> SignalResult:
    t0 = time.time()
    try:
        s5 = s5_payload or {}
        px_per_mm = s5.get("px_per_mm")
        bbox = s5.get("jewelry_bbox")

        if bbox and px_per_mm:
            vision_weight = estimate_weight_from_bbox(bbox, px_per_mm)
            method = "bbox_volume_density"
            cv_confidence = 0.72
        else:
            vision_weight = 7.9  # population mean fallback
            method = "population_mean"
            cv_confidence = 0.30

        if weight_g:
            final_weight = weight_g * 0.7 + vision_weight * 0.3
            method = "hybrid"
            confidence = min(0.90, cv_confidence + 0.15)
        else:
            final_weight = vision_weight
            confidence = cv_confidence

        return SignalResult(
            signal_id="s6_dimensions",
            confidence=round(confidence, 3),
            payload={
                "estimated_weight_g": round(final_weight, 2),
                "vision_weight_g": round(vision_weight, 2),
                "manual_weight_g": weight_g,
                "volume_cm3": round(final_weight / DENSITY_22K, 3),
                "scale_mm_per_px": s5.get("scale_mm_per_px"),
                "method": method,
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="bbox-density-v1",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s6_dimensions failed: {e}")
        return SignalResult(
            signal_id="s6_dimensions", confidence=0.0, payload={},
            error=str(e), duration_ms=int((time.time() - t0) * 1000),
            model_version="bbox-density-v1",
        )
