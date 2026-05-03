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
from app.data.image_utils import fetch_image_bytes, detect_coin_hough, estimate_jewelry_bbox_px

logger = logging.getLogger("goldeye.workers.s5")


async def run(session_id: str, frames: list[str], **_) -> SignalResult:
    t0 = time.time()
    try:
        # Try each frame until we get a coin hit — macro frame (index 3) is best
        coin_result: Optional[dict] = None
        bbox: Optional[dict] = None
        used_frame_idx = -1

        for idx in ([3, 0, 1, 2] if len(frames) > 3 else list(range(len(frames)))):
            url = frames[idx] if idx < len(frames) else ""
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue

            import cv2
            arr = np.frombuffer(raw, np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue

            coin_result = detect_coin_hough(img)
            bbox = estimate_jewelry_bbox_px(img, coin_result)
            used_frame_idx = idx
            if coin_result:
                break

        px_per_mm = coin_result["px_per_mm"] if coin_result else None
        scale_mm_per_px = round(1.0 / px_per_mm, 4) if px_per_mm else None
        area_px2 = bbox["area_px2"] if bbox else 0
        coin_detected = coin_result is not None
        confidence = 0.88 if coin_detected else 0.45

        return SignalResult(
            signal_id="s5_segmentation",
            confidence=confidence,
            payload={
                "coin_detected": coin_detected,
                "scale_mm_per_px": scale_mm_per_px,
                "px_per_mm": round(px_per_mm, 4) if px_per_mm else None,
                "jewelry_area_px2": area_px2,
                "jewelry_bbox": bbox,
                "used_frame_idx": used_frame_idx,
                "stone_mask_present": False,  # Phase 3: SAM2 stone masking
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="opencv-hough-v1",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s5_segmentation failed: {e}")
        return SignalResult(
            signal_id="s5_segmentation", confidence=0.0, payload={},
            error=str(e), duration_ms=int((time.time() - t0) * 1000),
            model_version="opencv-hough-v1",
        )
