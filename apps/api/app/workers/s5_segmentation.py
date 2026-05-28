"""
S5 — Coin detection + jewelry segmentation.
Phase 2 (MVP): OpenCV Hough circles for ₹10 coin scale anchor.
Phase 3: SAM 2 Hiera-Tiny + Grounding DINO 1.5 Edge for pixel-accurate masks.
"""
import time
import logging
from typing import Optional
import numpy as np
from app.models.schemas import SignalResult
from app.data.image_utils import (
    fetch_image_bytes,
    detect_coin_hough,
    estimate_jewelry_bbox_px,
    estimate_volume_from_measurement,
    fuse_volume_estimates,
)

logger = logging.getLogger("goldeye.workers.s5")


async def run(
    session_id: str,
    frames: list[str],
    reference_object: str = "rs10_coin",
    **_,
) -> SignalResult:
    t0 = time.time()
    try:
        # Try top/45-degree/macro before side: top-down frames give the best
        # projected metal area, while macro is useful when it contains the coin.
        coin_result: Optional[dict] = None
        best_bbox: Optional[dict] = None
        best_volume: Optional[dict] = None
        used_frame_idx = -1
        frame_measurements: list[dict] = []
        frame_volume_estimates: list[dict] = []

        preferred = [0, 1, 3, 2]
        priority = [idx for idx in preferred if idx < len(frames)]
        priority.extend(idx for idx in range(len(frames)) if idx not in priority)
        for idx in priority:
            url = frames[idx] if idx < len(frames) else ""
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue

            import cv2
            arr = np.frombuffer(raw, np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue

            detected_coin = detect_coin_hough(img, reference_object=reference_object)
            bbox = estimate_jewelry_bbox_px(img, detected_coin)
            if detected_coin and (coin_result is None or detected_coin.get("confidence", 0) > coin_result.get("confidence", 0)):
                coin_result = detected_coin

            volume = None
            quality = 0.0
            if bbox:
                if detected_coin:
                    volume = estimate_volume_from_measurement(bbox, detected_coin["px_per_mm"], detected_coin)
                    quality = (
                        float(volume.get("confidence", 0.0))
                        + float(detected_coin.get("confidence", 0.0)) * 0.25
                        + min(0.12, float(bbox.get("area_px2", 0)) / max(float(img.shape[0] * img.shape[1]), 1.0))
                    )
                else:
                    volume = estimate_volume_from_measurement(bbox, None, None)
                    quality = (
                        float(volume.get("confidence", 0.0)) * 0.45
                        + min(0.06, float(bbox.get("area_px2", 0)) / max(float(img.shape[0] * img.shape[1]), 1.0))
                    )
                frame_volume_estimates.append({**volume, "frame_idx": idx, "_quality": quality})

            frame_measurements.append({
                "frame_idx": idx,
                "coin_detected": detected_coin is not None,
                "coin_confidence": detected_coin.get("confidence") if detected_coin else 0.0,
                "px_per_mm": round(detected_coin["px_per_mm"], 4) if detected_coin else None,
                "jewelry_area_px2": bbox.get("area_px2", 0) if bbox else 0,
                "jewelry_bbox": bbox,
                "volume_estimate": {k: v for k, v in (volume or {}).items() if not k.startswith("_")},
                "weight_frame_quality": round(quality, 4),
                "usable_for_weight": bool(volume),
            })

            if bbox and volume:
                if best_bbox is None or quality > best_volume.get("_quality", -1):
                    best_bbox = bbox
                    best_volume = {**volume, "_quality": quality}
                    used_frame_idx = idx

        px_per_mm = coin_result["px_per_mm"] if coin_result else None
        scale_mm_per_px = round(1.0 / px_per_mm, 4) if px_per_mm else None
        if best_bbox is None:
            # Keep a jewelry bbox if available even without same-frame coin, but
            # the downstream volume estimator will fall back to a broad band.
            for item in frame_measurements:
                if item.get("jewelry_bbox"):
                    best_bbox = item["jewelry_bbox"]
                    used_frame_idx = int(item["frame_idx"])
                    break
        if frame_volume_estimates:
            volume_payload = fuse_volume_estimates(frame_volume_estimates)
        else:
            volume_payload = dict(best_volume or estimate_volume_from_measurement(best_bbox, px_per_mm, coin_result))
        volume_payload.pop("_quality", None)

        area_px2 = best_bbox["area_px2"] if best_bbox else 0
        coin_detected = coin_result is not None
        confidence = float(volume_payload.get("confidence", 0.30))
        if coin_detected:
            confidence = min(0.92, confidence + 0.08)

        return SignalResult(
            signal_id="s5_segmentation",
            confidence=round(confidence, 3),
            payload={
                "coin_detected": coin_detected,
                "reference_object": reference_object,
                "coin": coin_result,
                "scale_mm_per_px": scale_mm_per_px,
                "px_per_mm": round(px_per_mm, 4) if px_per_mm else None,
                "jewelry_area_px2": area_px2,
                "jewelry_bbox": best_bbox,
                "jewelry_measurement": best_bbox,
                "volume_estimate": volume_payload,
                "frame_measurements": frame_measurements,
                "frames_used_for_weight": int(volume_payload.get("frame_count", len(frame_volume_estimates))),
                "used_frame_idx": used_frame_idx,
                "stone_mask_present": False,  # Phase 3: SAM2 stone masking
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="opencv-multiframe-coin-volume-v3",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s5_segmentation failed: {e}")
        return SignalResult(
            signal_id="s5_segmentation", confidence=0.0, payload={},
            error=str(e), duration_ms=int((time.time() - t0) * 1000),
            model_version="opencv-multiframe-coin-volume-v3",
        )
