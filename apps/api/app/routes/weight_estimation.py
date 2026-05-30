import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.data.weight_estimation import WeightEstimationError, estimate_weight_from_image
from app.data.weight_vlm import locate_jewellery_roi

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
        estimate = await asyncio.to_thread(
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
            vlm_validated=vlm_validated,
        )
        logger.info(
            "Weight CV estimate complete in %.2fs total=%.2fs",
            time.perf_counter() - estimate_started,
            time.perf_counter() - started,
        )
        return estimate | {
            "vlm_roi": vlm_roi,
            "angle_vlm_roi": angle_vlm_roi,
            "side_vlm_roi": side_vlm_roi,
        }
    except WeightEstimationError as exc:
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


async def _require_vlm_roi(image_data_url: str, view_label: str) -> dict:
    roi = await locate_jewellery_roi(image_data_url)
    if roi is None:
        raise WeightEstimationError(
            "vlm_validation_failed",
            f"Gemini could not validate the {view_label}. Check Gemini API keys and retry.",
        )
    if not roi["valid_image"] or not roi["jewellery_present"]:
        raise WeightEstimationError(
            "non_jewelry_photo",
            f"The {view_label} does not contain a clear physical gold jewellery item.",
            {"vlm_roi": roi, "view": view_label},
        )
    if not roi["coin_present"]:
        raise WeightEstimationError(
            "reference_object_missing",
            f"The {view_label} does not contain a clear Rs 10 coin/reference coin.",
            {"vlm_roi": roi, "view": view_label},
        )
    if roi["confidence"] < 0.35:
        raise WeightEstimationError(
            "low_vlm_confidence",
            f"Gemini could not confidently locate jewellery in the {view_label}. Retake that view on a plain background.",
            {"vlm_roi": roi, "view": view_label},
        )
    return roi
