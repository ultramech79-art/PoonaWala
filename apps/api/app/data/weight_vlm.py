import logging
from typing import Any, Optional

from app.data.gemini import (
    GEMINI_GUIDANCE_FALLBACK_API_KEYS,
    GROQ_GUIDANCE_API_KEYS,
    _gemini_request,
    extract_gemini_text,
    parse_json_response,
)
from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys

logger = logging.getLogger("goldeye.weight_vlm")


def _extract_b64(image_data_url: str) -> str:
    return image_data_url.split(",", 1)[1] if "," in image_data_url else image_data_url


def _clamp01(value: Any, default: float = 0.5) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return default


async def locate_jewellery_roi(image_data_url: str) -> Optional[dict[str, Any]]:
    """
    VLM-assisted validation and ROI selection only.

    The returned point/bbox is used to seed CV segmentation. Weight, scale,
    dimensions, volume, and mass remain deterministic CV/physics outputs.
    """
    prompt = """You are a strict visual ROI selector for a gold weight-estimation system.

Inspect this single image and return ONLY valid JSON.

Task:
- Confirm whether a physical gold jewellery item is visible.
- Confirm whether an Indian Rs 10 coin/reference coin is visible.
- Identify the jewellery item, not the coin, not paper, not shadows, not text.
- Return a point at the center of the visible jewellery and a tight bounding box around the jewellery.

Rules:
- Do not estimate weight.
- Do not include the coin in the jewellery bbox.
- Do not select the printed black/white calibration square, writing, paper folds, shadows, or background.
- The jewellery bbox should tightly enclose only the visible metal jewellery pixels, with as little background as possible.
- For a ring, the bbox should surround the ring outline, not the empty paper area around it.
- If there is no physical jewellery, set valid_image=false.
- If there is no coin-like circular reference object, set coin_present=false.
- Coordinates must be normalized 0.0 to 1.0 relative to the full image.
- item_type must be one of: ring, bangle, bracelet, necklace, pendant, chain, irregular, unknown.

JSON schema:
{
  "valid_image": true,
  "jewellery_present": true,
  "coin_present": true,
  "item_type": "ring",
  "jewellery_point": {"x": 0.72, "y": 0.45},
  "jewellery_bbox": {"x": 0.62, "y": 0.36, "width": 0.18, "height": 0.16},
  "confidence": 0.0,
  "issues": []
}"""

    image_b64 = _extract_b64(image_data_url)

    if GROQ_GUIDANCE_API_KEYS:
        try:
            data, success = await call_groq_vision_with_keys(
                prompt,
                image_b64,
                GROQ_GUIDANCE_API_KEYS,
                "image/jpeg",
                timeout=20,
            )
            if success:
                return _normalize_roi_response(parse_json_response(extract_gemini_text(data)), "groq", GROQ_MODEL)
            logger.warning("VLM ROI failed: %s", data.get("error", "unknown"))
            if "organization_restricted" in str(data):
                logger.warning("Groq organization is restricted; using Gemini ROI fallback")
        except Exception as exc:
            logger.warning("VLM ROI Groq exception: %s", exc)

    if not GEMINI_GUIDANCE_FALLBACK_API_KEYS:
        return None

    try:
        payload = {
            "contents": [{
                "parts": [
                    {"text": prompt},
                    {"inlineData": {"mimeType": "image/jpeg", "data": image_b64}},
                ]
            }],
            "generationConfig": {
                "temperature": 0.0,
                "maxOutputTokens": 768,
                "responseMimeType": "application/json",
            },
        }
        data, success = await _gemini_request(
            payload,
            timeout=25,
            api_keys=GEMINI_GUIDANCE_FALLBACK_API_KEYS,
            max_retries=1,
        )
        if not success:
            logger.warning("VLM ROI Gemini fallback failed: %s", data.get("error", "unknown"))
            return None
        return _normalize_roi_response(parse_json_response(extract_gemini_text(data)), "gemini", "gemini_guidance_fallback")
    except Exception as exc:
        logger.warning("VLM ROI Gemini exception: %s", exc)
        return None


def _normalize_roi_response(result: dict[str, Any], provider: str, model: str) -> dict[str, Any]:
    point = result.get("jewellery_point") or {}
    bbox = result.get("jewellery_bbox") or {}
    normalized = {
        "valid_image": bool(result.get("valid_image", False)),
        "jewellery_present": bool(result.get("jewellery_present", False)),
        "coin_present": bool(result.get("coin_present", False)),
        "item_type": str(result.get("item_type", "unknown")).lower(),
        "jewellery_point": {
            "x": _clamp01(point.get("x")),
            "y": _clamp01(point.get("y")),
        },
        "jewellery_bbox": {
            "x": _clamp01(bbox.get("x"), 0.0),
            "y": _clamp01(bbox.get("y"), 0.0),
            "width": _clamp01(bbox.get("width"), 0.0),
            "height": _clamp01(bbox.get("height"), 0.0),
        },
        "confidence": _clamp01(result.get("confidence"), 0.0),
        "issues": result.get("issues") if isinstance(result.get("issues"), list) else [],
        "provider": provider,
        "model": model,
    }
    logger.info(
        "VLM ROI: provider=%s valid=%s jewellery=%s coin=%s type=%s conf=%.2f point=%s",
        provider,
        normalized["valid_image"],
        normalized["jewellery_present"],
        normalized["coin_present"],
        normalized["item_type"],
        normalized["confidence"],
        normalized["jewellery_point"],
    )
    return normalized
