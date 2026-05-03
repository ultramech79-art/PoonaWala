"""
Layer 1 XAI: Score-CAM-lite heatmap via ConvNeXt-V2 ONNX perturbation.
Phase 6: perturbation-based saliency map (7×7 grid, ~100ms).
Returns base64 data URI or None when model/frame unavailable.
"""
import base64
import logging
from typing import Optional

import numpy as np

logger = logging.getLogger("goldeye.xai.gradcam")


async def generate_gradcam_url(
    frame_url: str,
    session_id: str,
    model=None,
) -> Optional[str]:
    """
    Generate Score-CAM-lite heatmap for the given frame.
    Returns base64 PNG data URI, or None if model not loaded or frame unavailable.
    """
    if not frame_url or frame_url.startswith("local://"):
        return None

    try:
        import cv2
        from app.data.image_utils import fetch_image_bytes
        from app.data.convnext import score_cam_lite

        raw = await fetch_image_bytes(frame_url)
        if raw is None:
            return None

        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None

        overlay = score_cam_lite(img, grid=7)
        if overlay is None:
            return None

        _, buf = cv2.imencode(".jpg", overlay, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64 = base64.b64encode(buf.tobytes()).decode()
        return f"data:image/jpeg;base64,{b64}"

    except Exception as e:
        logger.warning(f"[{session_id}] gradcam generation failed: {e}")
        return None
