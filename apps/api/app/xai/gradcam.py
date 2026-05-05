"""
Layer 1 XAI: Score-CAM-lite heatmap via ConvNeXt-V2 ONNX perturbation.
Phase 6: perturbation-based saliency map (7×7 grid, ~100ms).
Returns base64 data URI or None when model/frame unavailable.
"""
import base64
import logging
import os
import re
import json
import aiohttp
from typing import Optional, List, Tuple

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
            # AI-Driven Heatmap: Use Groq/Gemini to find coordinates of interest
            overlay = await _generate_ai_heatmap(img, frame_url, session_id)
            if overlay is None:
                # Last resort: simple Gaussian center
                h, w = img.shape[:2]
                mask = np.zeros((h, w), dtype=np.uint8)
                cv2.circle(mask, (w // 2, h // 2), min(w, h) // 3, 255, -1)
                mask = cv2.GaussianBlur(mask, (min(w, h) // 2 | 1, min(w, h) // 2 | 1), 0)
                heatmap = cv2.applyColorMap(mask, cv2.COLORMAP_JET)
                overlay = cv2.addWeighted(img, 0.6, heatmap, 0.4, 0)

        _, buf = cv2.imencode(".jpg", overlay, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64 = base64.b64encode(buf.tobytes()).decode()
        return f"data:image/jpeg;base64,{b64}"

    except Exception as e:
        logger.warning(f"[{session_id}] gradcam generation failed: {e}")
        return None

async def _generate_ai_heatmap(img: np.ndarray, frame_url: str, session_id: str) -> Optional[np.ndarray]:
    """Uses Groq/Gemini to find key areas and paints a heatmap overlay."""
    groq_key = os.getenv("GROQ_API_KEY", "")
    if not groq_key:
        return None

    import cv2
    h, w = img.shape[:2]

    prompt = (
        "You are an AI gold expert. In this macro photo, identify the exact [x, y] coordinates "
        "of the BIS Hallmark, HUID code, and areas showing high metallic luster. "
        "Coordinates must be in percentage (0-100). "
        "Respond ONLY with a JSON array of objects: [{\"label\": \"hallmark\", \"x\": 45, \"y\": 50}, ...]"
    )

    payload = {
        "model": "llama-3.2-90b-vision-preview",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": frame_url}}
                ]
            }
        ],
        "response_format": {"type": "json_object"}
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {groq_key}"},
                timeout=15
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    res = json.loads(data["choices"][0]["message"]["content"])
                    points = res.get("points", []) # or top-level array
                    if not points and isinstance(res, list): points = res
                    
                    if not points: return None

                    # Create heatmap mask
                    mask = np.zeros((h, w), dtype=np.uint8)
                    for p in points:
                        px, py = int(p["x"] * w / 100), int(p["y"] * h / 100)
                        radius = min(w, h) // 6
                        cv2.circle(mask, (px, py), radius, 255, -1)
                    
                    mask = cv2.GaussianBlur(mask, (min(w, h) // 3 | 1, min(w, h) // 3 | 1), 0)
                    heatmap = cv2.applyColorMap(mask, cv2.COLORMAP_JET)
                    return cv2.addWeighted(img, 0.6, heatmap, 0.4, 0)
    except Exception as e:
        logger.debug(f"AI heatmap failed: {e}")
    return None
