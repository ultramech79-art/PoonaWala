"""
Gemini/Groq focus-region locator for Grad-CAM style explanations.

This file is intentionally separate from gradcam.py so we can test and tune
the multimodal coordinate prompt independently from the local OpenCV fallback.
It returns normalized region dictionaries; gradcam.py owns rendering.
"""
from __future__ import annotations

import base64
import logging
from typing import Any

import numpy as np

logger = logging.getLogger("goldeye.xai.gemini_focus")


FOCUS_REGION_PROMPT = """
Identify exact visual evidence locations in this gold jewellery image.

Prefer these targets in order:
1. visible HUID code
2. BIS logo / hallmark stamp
3. purity mark such as 916, 750, 22K, 18K
4. if no stamp is visible, the actual jewellery/ornament surface, edge, stone
   setting, clasp, or ring band.

Important: ignore any Indian Rs 10/Rs 20 coin or circular scale reference. The
coin is only for measuring scale and must not be selected as the focus region.
If both a coin and a ring are visible, choose the ring.

Return ONLY JSON:
{
  "regions": [
    {
      "label": "huid|bis_logo|purity_mark|hallmark|metal_detail",
      "x": 0-100,
      "y": 0-100,
      "width": 1-100,
      "height": 1-100,
      "confidence": 0-1
    }
  ]
}

Coordinates are percentages of the full image. Use the center of the evidence
region for x/y. Do not invent a center point if no visual evidence is visible.
""".strip()


def _encode_jpeg_base64(img_bgr: np.ndarray, quality: int = 86) -> str | None:
    try:
        import cv2

        ok, encoded = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None
        return base64.b64encode(encoded.tobytes()).decode()
    except Exception as exc:
        logger.debug(f"focus image encode failed: {exc}")
        return None


def _normalize_regions(data: Any) -> list[dict[str, float | str]]:
    if isinstance(data, dict):
        raw_regions = data.get("regions") or data.get("points") or data.get("focus_regions") or []
    else:
        raw_regions = data

    if not isinstance(raw_regions, list):
        return []

    regions: list[dict[str, float | str]] = []
    for item in raw_regions:
        if not isinstance(item, dict):
            continue
        try:
            label = str(item.get("label") or item.get("type") or "ai_focus")[:40]
            x = float(item["x"])
            y = float(item["y"])
            width = float(item.get("width", item.get("w", 10)))
            height = float(item.get("height", item.get("h", 10)))
            confidence = float(item.get("confidence", item.get("score", 0.65)))
        except Exception:
            continue

        if confidence < 0.2:
            continue

        # Keep everything in percent space. Some models emit 0..1 fractions.
        if 0 <= x <= 1 and 0 <= y <= 1:
            x *= 100
            y *= 100
        if 0 < width <= 1 and 0 < height <= 1:
            width *= 100
            height *= 100

        if not (0 <= x <= 100 and 0 <= y <= 100):
            continue

        regions.append({
            "label": label,
            "x": max(0.0, min(100.0, x)),
            "y": max(0.0, min(100.0, y)),
            "width": max(1.0, min(100.0, width)),
            "height": max(1.0, min(100.0, height)),
            "confidence": max(0.0, min(1.0, confidence)),
        })

    return regions[:5]


async def locate_focus_regions(
    img_bgr: np.ndarray,
    *,
    session_id: str = "gradcam-focus",
    prefer_gemini: bool = True,
) -> list[dict[str, float | str]]:
    """
    Return focus regions from Gemini, with Groq as an optional fallback.

    No exception escapes this function: Grad-CAM must keep working locally even
    if API keys are missing, quotas are exhausted, or network is unavailable.
    """
    image_b64 = _encode_jpeg_base64(img_bgr)
    if not image_b64:
        return []

    if prefer_gemini:
        regions = await _locate_with_gemini(image_b64, session_id=session_id)
        if regions:
            return regions

    regions = await _locate_with_groq(image_b64, session_id=session_id)
    if regions:
        return regions

    if not prefer_gemini:
        return await _locate_with_gemini(image_b64, session_id=session_id)

    return []


async def _locate_with_gemini(image_b64: str, *, session_id: str) -> list[dict[str, float | str]]:
    try:
        from app.data.gemini import (
            GEMINI_GUIDANCE_FALLBACK_API_KEYS,
            _gemini_request,
            extract_gemini_text,
            parse_json_response,
        )

        if not GEMINI_GUIDANCE_FALLBACK_API_KEYS:
            return []

        payload = {
            "contents": [{
                "parts": [
                    {"text": FOCUS_REGION_PROMPT},
                    {"inlineData": {"mimeType": "image/jpeg", "data": image_b64}},
                ],
            }],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 384,
                "responseMimeType": "application/json",
            },
        }

        data, success = await _gemini_request(
            payload,
            timeout=18,
            api_keys=GEMINI_GUIDANCE_FALLBACK_API_KEYS,
            max_retries=0,
        )
        if not success:
            logger.debug(f"[{session_id}] Gemini focus request failed: {data.get('error', 'unknown')}")
            return []

        parsed = parse_json_response(extract_gemini_text(data))
        return _normalize_regions(parsed)
    except Exception as exc:
        logger.debug(f"[{session_id}] Gemini focus detection failed: {exc}")
        return []


async def _locate_with_groq(image_b64: str, *, session_id: str) -> list[dict[str, float | str]]:
    try:
        from app.data.gemini import GROQ_PRIMARY_API_KEYS, extract_gemini_text, parse_json_response
        from app.data.groq_client import call_groq_vision_with_keys

        if not GROQ_PRIMARY_API_KEYS:
            return []

        data, success = await call_groq_vision_with_keys(
            FOCUS_REGION_PROMPT,
            image_b64,
            GROQ_PRIMARY_API_KEYS,
            "image/jpeg",
            timeout=18,
        )
        if not success:
            logger.debug(f"[{session_id}] Groq focus request failed: {data.get('error', 'unknown')}")
            return []

        parsed = parse_json_response(extract_gemini_text(data))
        return _normalize_regions(parsed)
    except Exception as exc:
        logger.debug(f"[{session_id}] Groq focus detection failed: {exc}")
        return []
