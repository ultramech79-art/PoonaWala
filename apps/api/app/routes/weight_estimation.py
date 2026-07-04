import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.data.weight_estimation import WeightEstimationError, estimate_weight_from_image
from app.data.weight_vlm import _DENSITY_BY_KARAT, estimate_weight_vlm, locate_jewellery_roi

router = APIRouter()
logger = logging.getLogger("goldeye.weight_estimation")


class WeightEstimateRequest(BaseModel):
    image_data_url: str = Field(..., min_length=32)
    image_45_data_url: str = Field(..., min_length=32)
    side_image_data_url: str = Field(..., min_length=32)
    jewelry_type: Literal["ring", "bangle", "bracelet", "necklace", "pendant", "chain", "irregular", "auto"] = "auto"
    karat: Literal[24, 22, 18] = 22
    reference_object: Literal["rs10_coin"] = "rs10_coin"
    include_visualizations: bool = False
    include_mask_preview: bool = True
    jewelry_point: dict[str, float] | None = None
    use_vlm_roi: bool = True


@router.post("/weight-estimate")
async def estimate_weight(req: WeightEstimateRequest):
    started = time.perf_counter()
    try:
        vlm_roi = None
        angle_vlm_roi = None
        side_vlm_roi = None
        jewelry_point = req.jewelry_point
        jewelry_bbox = None
        angle_jewelry_point = None
        angle_jewelry_bbox = None
        side_jewelry_point = None
        side_jewelry_bbox = None
        coin_hint = None
        vlm_validated = False
        jewelry_type = req.jewelry_type
        if req.use_vlm_roi:
            roi_started = time.perf_counter()
            vlm_roi, angle_vlm_roi, side_vlm_roi = await asyncio.gather(
                _require_vlm_roi(req.image_data_url, "top view"),
                _require_vlm_roi(req.image_45_data_url, "45-degree view"),
                _require_vlm_roi(req.side_image_data_url, "side view"),
            )
            logger.info("Weight ROI validation complete in %.2fs", time.perf_counter() - roi_started)
            vlm_validated = True
            if jewelry_point is None:
                jewelry_point = vlm_roi["jewellery_point"]
            jewelry_bbox = vlm_roi["jewellery_bbox"]
            coin_hint = vlm_roi.get("coin_point")
            angle_jewelry_point = angle_vlm_roi["jewellery_point"]
            angle_jewelry_bbox = angle_vlm_roi["jewellery_bbox"]
            side_jewelry_point = side_vlm_roi["jewellery_point"]
            side_jewelry_bbox = side_vlm_roi["jewellery_bbox"]
            if jewelry_type == "auto" and vlm_roi["item_type"] in {
                "ring",
                "bangle",
                "bracelet",
                "necklace",
                "pendant",
                "chain",
                "irregular",
            }:
                jewelry_type = vlm_roi["item_type"]

        estimate_started = time.perf_counter()
        # CV physics (mass = density × coin-scaled volume) and an independent VLM
        # appraisal run in parallel; results are fused confidence-weighted below.
        cv_result, vlm_estimate = await asyncio.gather(
            asyncio.to_thread(
                estimate_weight_from_image,
                image_data_url=req.image_data_url,
                image_45_data_url=req.image_45_data_url,
                side_image_data_url=req.side_image_data_url,
                jewelry_type=jewelry_type,
                karat=req.karat,
                reference_object=req.reference_object,
                include_visualizations=req.include_visualizations,
                include_mask_preview=req.include_mask_preview,
                jewelry_point=jewelry_point,
                jewelry_bbox=jewelry_bbox,
                angle_jewelry_point=angle_jewelry_point,
                angle_jewelry_bbox=angle_jewelry_bbox,
                side_jewelry_point=side_jewelry_point,
                side_jewelry_bbox=side_jewelry_bbox,
                coin_hint=coin_hint,
                vlm_validated=vlm_validated,
            ),
            estimate_weight_vlm(
                req.image_data_url,
                req.image_45_data_url,
                req.side_image_data_url,
                jewelry_type,
                req.karat,
            ),
            return_exceptions=True,
        )
        if isinstance(vlm_estimate, BaseException):
            logger.warning("VLM weight estimate raised: %s", vlm_estimate)
            vlm_estimate = None

        if isinstance(cv_result, WeightEstimationError):
            if vlm_estimate is None:
                raise cv_result
            logger.warning(
                "Weight CV stage failed (%s); serving VLM-only estimate.", cv_result.code
            )
            estimate = _vlm_only_response(vlm_estimate, jewelry_type, req.karat, req.reference_object, cv_result.code)
        elif isinstance(cv_result, BaseException):
            raise cv_result
        else:
            estimate = _fuse_weight(cv_result, vlm_estimate)

        logger.info(
            "Weight estimate complete in %.2fs total=%.2fs method=%s weight=%.2fg",
            time.perf_counter() - estimate_started,
            time.perf_counter() - started,
            estimate["weight"].get("method", "cv_physics"),
            estimate["weight"]["estimated_g"],
        )
        return estimate | {
            "vlm_roi": vlm_roi,
            "angle_vlm_roi": angle_vlm_roi,
            "side_vlm_roi": side_vlm_roi,
        }
    except WeightEstimationError as exc:
        logger.warning("Weight estimation rejected: code=%s message=%s", exc.code, exc.message)
        raise HTTPException(
            status_code=422,
            detail={
                "code": exc.code,
                "message": exc.message,
                "details": exc.details,
            },
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected weight estimation failure")
        raise HTTPException(
            status_code=500,
            detail={
                "code": "weight_estimation_failed",
                "message": "Weight estimation failed unexpectedly. Please retry with a clearer image.",
            },
        ) from exc


def _fuse_weight(estimate: dict, vlm_estimate: dict | None) -> dict:
    """
    Confidence-weighted fusion of the CV physics estimate and the VLM appraisal.

    The CV pipeline is metrically grounded (coin scale), so it carries a base-trust
    bonus; the VLM contributes shape/hollowness judgment the CV mask cannot see.
    Large disagreement widens the band and is surfaced as an issue, never hidden.
    """
    cv_g = float(estimate["weight"]["estimated_g"])
    if vlm_estimate is None:
        estimate["weight"]["method"] = "cv_physics"
        return estimate

    vlm_g = float(vlm_estimate["weight_g"])
    cv_conf = float(estimate["confidence"]["score"])
    vlm_conf = float(vlm_estimate["confidence"])
    cv_w = 0.20 + cv_conf          # base trust for the metric pipeline
    vlm_w = max(0.10, vlm_conf)
    total = cv_w + vlm_w
    fused = (cv_g * cv_w + vlm_g * vlm_w) / total
    low = (float(estimate["weight"]["low_g"]) * cv_w + float(vlm_estimate["low_g"]) * vlm_w) / total
    high = (float(estimate["weight"]["high_g"]) * cv_w + float(vlm_estimate["high_g"]) * vlm_w) / total

    issues = estimate["confidence"].setdefault("issues", [])
    if max(cv_g, vlm_g) > 1.6 * max(0.1, min(cv_g, vlm_g)):
        issues.append("cv_vlm_weight_disagreement")
        low = min(low, min(cv_g, vlm_g) * 0.9)
        high = max(high, max(cv_g, vlm_g) * 1.1)
    if vlm_estimate.get("hollow"):
        issues.append("possibly_hollow_construction")
    estimate["confidence"]["issues"] = sorted(set(issues))

    estimate["weight"] = {
        "estimated_g": round(fused, 2),
        "low_g": round(max(0.1, min(low, fused)), 2),
        "high_g": round(max(high, fused), 2),
        "method": "cv_vlm_fused",
        "sources": {
            "cv_g": round(cv_g, 2),
            "vlm_g": round(vlm_g, 2),
            "cv_weight": round(cv_w / total, 2),
            "vlm_weight": round(vlm_w / total, 2),
            "vlm_reasoning": vlm_estimate.get("reasoning", ""),
        },
    }
    return estimate


def _vlm_only_response(
    vlm_estimate: dict, jewelry_type: str, karat: int, reference_object: str, cv_error_code: str
) -> dict:
    """Well-formed response when the CV stages fail but the VLM appraisal succeeded."""
    density = _DENSITY_BY_KARAT.get(int(karat), 17.7)
    weight_g = float(vlm_estimate["weight_g"])
    jtype = jewelry_type if jewelry_type != "auto" else "irregular"
    return {
        "ok": True,
        "jewelry_type": jtype,
        "requested_jewelry_type": jewelry_type,
        "karat": karat,
        "reference_object": reference_object,
        "scale": {"mm_per_pixel": 0.0, "pixels_per_mm": 0.0, "coin_diameter_px": 0.0, "coin_confidence": 0.0},
        "dimensions": {
            "width_mm": vlm_estimate.get("width_mm", 0.0),
            "height_mm": vlm_estimate.get("height_mm", 0.0),
            "estimated_depth_mm": vlm_estimate.get("thickness_mm", 0.0),
            "thickness_source": "vlm_estimate",
        },
        "geometry": {
            "segmentation_method": "vlm_estimate",
            "depth_method": "vlm_estimate",
            "volume_model": {"model": "vlm_appraisal", "effective_thickness_mm": vlm_estimate.get("thickness_mm", 0.0), "solidness": 0.0 if vlm_estimate.get("hollow") else 1.0},
        },
        "physics": {
            "density_g_cm3": density,
            "volume_cm3": round(weight_g / density, 4),
            "formula": "mass_g = density_g_cm3 * volume_cm3",
        },
        "weight": {
            "estimated_g": round(weight_g, 2),
            "low_g": float(vlm_estimate["low_g"]),
            "high_g": float(vlm_estimate["high_g"]),
            "method": "vlm_only",
            "sources": {"vlm_g": round(weight_g, 2), "vlm_reasoning": vlm_estimate.get("reasoning", "")},
        },
        "confidence": {
            "score": round(min(0.6, float(vlm_estimate["confidence"])), 3),
            "components": {"vlm_appraisal": float(vlm_estimate["confidence"])},
            "issues": [f"cv_stage_failed:{cv_error_code}"],
        },
        "visualizations": {},
    }


async def _require_vlm_roi(image_data_url: str, view_label: str) -> dict:
    """
    Locate the jewellery ROI for CV seeding.

    This is a SOFT validation step, not a hard re-gate: the photo has already been
    accepted by the capture flow, and the deterministic CV pipeline independently
    verifies the Rs 10 coin (scale reference) and segments the jewellery. We therefore
    only fail here when the VLM is confident there is genuinely no jewellery at all —
    we do NOT re-reject for coin presence or VLM confidence, which previously caused
    already-approved photos to be rejected at the weight stage. The VLM is flaky, so
    we retry once before giving up.
    """
    roi = await locate_jewellery_roi(image_data_url)
    if roi is None or not roi.get("jewellery_present"):
        # One retry to absorb transient VLM misses / empty responses.
        retry = await locate_jewellery_roi(image_data_url)
        if retry is not None:
            roi = retry

    if roi is None:
        raise WeightEstimationError(
            "vlm_validation_failed",
            f"Could not analyse the {view_label}. Please retry in a moment.",
        )

    if not roi["valid_image"] and not roi["jewellery_present"]:
        raise WeightEstimationError(
            "non_jewelry_photo",
            f"The {view_label} does not contain a clear physical gold jewellery item.",
            {"vlm_roi": roi, "view": view_label},
        )

    if not roi["coin_present"]:
        # Not a rejection — the CV coin detector is the authority on the scale
        # reference and will raise reference_object_missing if it truly can't find it.
        logger.info("VLM did not flag a coin in %s; deferring to CV coin detection.", view_label)

    return roi
