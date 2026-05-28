from typing import Optional, Union
"""
S6 — Weight estimation from scale anchor + manual entry.
Phase 2: coin-anchored bbox area → volume × density.
Phase 3: Depth Anything V2 Small monocular depth for volume.
"""
import time
import logging
from app.models.schemas import SignalResult
from app.data.image_utils import (
    estimate_volume_from_measurement,
    estimate_weight_range_from_volume,
)

logger = logging.getLogger("goldeye.workers.s6")

DENSITY_22K = 17.83  # g/cm³, balanced Ag/Cu 22K yellow gold


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
        measurement = s5.get("jewelry_measurement") or s5.get("jewelry_bbox")
        coin = s5.get("coin")
        volume = s5.get("volume_estimate")

        if not volume:
            volume = estimate_volume_from_measurement(measurement, px_per_mm, coin)

        if measurement and px_per_mm:
            weight_range = estimate_weight_range_from_volume(volume, karat=22)
            vision_weight = weight_range["estimated_weight_g"]
            method = "coin_scaled_volume_density_22k_pending_fusion"
            cv_confidence = float(volume.get("confidence", 0.64))
        elif measurement:
            weight_range = estimate_weight_range_from_volume(volume, karat=22)
            vision_weight = weight_range["estimated_weight_g"]
            method = "reference_free_visual_prior_density"
            cv_confidence = float(volume.get("confidence", 0.28))
        else:
            weight_range = estimate_weight_range_from_volume(volume, karat=22)
            vision_weight = weight_range["estimated_weight_g"]
            method = "fallback_visual_prior_density"
            cv_confidence = float(volume.get("confidence", 0.16))

        if weight_g:
            # Keep estimated_weight_g as the CV estimate; fusion performs the
            # single manual/CV blend after purity-aware density is known.
            final_weight = vision_weight
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
                "band_low_g": weight_range["band_low_g"],
                "band_high_g": weight_range["band_high_g"],
                "volume_cm3": volume["volume_cm3"],
                "volume_low_cm3": volume["volume_low_cm3"],
                "volume_high_cm3": volume["volume_high_cm3"],
                "density_g_cm3": weight_range["density_g_cm3"],
                "density_low_g_cm3": weight_range["density_low_g_cm3"],
                "density_high_g_cm3": weight_range["density_high_g_cm3"],
                "density_note": "22K provisional; final fusion reapplies density from purity band",
                "geometry_class": volume.get("geometry_class", "unknown"),
                "top_area_mm2": volume.get("top_area_mm2"),
                "thickness_mm": volume.get("thickness_mm"),
                "weight_model": volume.get("method"),
                "scale_mm_per_px": s5.get("scale_mm_per_px"),
                "method": method,
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="coin-volume-density-v2",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s6_dimensions failed: {e}")
        return SignalResult(
            signal_id="s6_dimensions", confidence=0.0, payload={},
            error=str(e), duration_ms=int((time.time() - t0) * 1000),
            model_version="coin-volume-density-v2",
        )
