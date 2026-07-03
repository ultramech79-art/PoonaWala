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
_groq_org_restricted = False


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
    prompt = """You are a visual ROI selector for a gold weight-estimation system.

Inspect this single image and return ONLY valid JSON.

COIN IS A SCALE REFERENCE, NOT GOLD: The Indian Rs 10 coin is a plain bimetallic currency coin placed beside
the jewellery ONLY as a size reference. It is NOT gold and is NOT the jewellery item. NEVER treat the coin as
the jewellery, as a gold coin, or as the primary item. The gold jewellery piece (ring, bangle, chain, etc.) is
always the ONE AND ONLY item to locate — the presence of the coin must never make you mark the jewellery as
absent or as "secondary".

Task:
- Confirm whether a physical gold jewellery item is visible (this is the main job).
- Note whether an Indian Rs 10 reference coin is visible (a hint only — downstream CV verifies the coin itself).
- Identify the jewellery item, NOT the coin, not paper, not shadows, not text.
- Return a point at the center of the visible jewellery and a tight bounding box around the jewellery.
- ALSO locate the Rs 10 reference coin separately: return a point at the center of the coin and a tight
  bounding box around ONLY the coin. This is used to calibrate scale, so it must point at the coin, not the ring.

Rules:
- Do not estimate weight.
- Do not include the coin in the jewellery bbox, and do not include the jewellery in the coin bbox.
- The Rs 10 coin is round and bimetallic (a lighter/greenish inner disc inside a golden outer ring) with the
  numeral "10". A gold ring is also round — do NOT confuse them: the coin is flat with printed markings, the
  jewellery is a raised metal piece (often with a stone/pearl). coin_point/coin_bbox must be on the COIN.
- Do not select the printed black/white calibration square, writing, paper folds, shadows, or background.
- The jewellery bbox should tightly enclose only the visible metal jewellery pixels, with as little background as possible.
- For a ring, the bbox should surround the ring outline, not the empty paper area around it.
- If any physical gold jewellery is visible, set valid_image=true AND jewellery_present=true — even if a coin
  or other objects are also in the frame.
- Only set valid_image=false / jewellery_present=false when there is genuinely NO physical jewellery at all.
- If you see a coin-like circular reference object, set coin_present=true and fill coin_point/coin_bbox;
  otherwise set coin_present=false and leave coin_point/coin_bbox as null.
- "confidence" must reflect how sure you are that you located the jewellery (0.0-1.0). If a clear jewellery
  item is visible, this should be high (>= 0.7). Always include a numeric confidence.
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
  "coin_point": {"x": 0.20, "y": 0.48},
  "coin_bbox": {"x": 0.11, "y": 0.39, "width": 0.18, "height": 0.18},
  "confidence": 0.0,
  "issues": []
}"""

    image_b64 = _extract_b64(image_data_url)

    global _groq_org_restricted
    if GROQ_GUIDANCE_API_KEYS and not _groq_org_restricted:
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
                _groq_org_restricted = True
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


def _normalize_point(raw: Any) -> Optional[dict[str, float]]:
    if not isinstance(raw, dict):
        return None
    if raw.get("x") is None or raw.get("y") is None:
        return None
    return {"x": _clamp01(raw.get("x")), "y": _clamp01(raw.get("y"))}


def _normalize_bbox(raw: Any) -> Optional[dict[str, float]]:
    if not isinstance(raw, dict):
        return None
    width = _clamp01(raw.get("width"), 0.0)
    height = _clamp01(raw.get("height"), 0.0)
    if width <= 0.0 or height <= 0.0:
        return None
    return {
        "x": _clamp01(raw.get("x"), 0.0),
        "y": _clamp01(raw.get("y"), 0.0),
        "width": width,
        "height": height,
    }


def _normalize_roi_response(result: dict[str, Any], provider: str, model: str) -> dict[str, Any]:
    point = result.get("jewellery_point") or {}
    bbox = result.get("jewellery_bbox") or {}
    jewellery_present = bool(result.get("jewellery_present", False))
    coin_present = bool(result.get("coin_present", False))
    coin_point = _normalize_point(result.get("coin_point")) if coin_present else None
    coin_bbox = _normalize_bbox(result.get("coin_bbox")) if coin_present else None
    # If the model gave only one of the two, derive the other so downstream CV always has a center hint.
    if coin_point is None and coin_bbox is not None:
        coin_point = {
            "x": _clamp01(coin_bbox["x"] + coin_bbox["width"] / 2.0),
            "y": _clamp01(coin_bbox["y"] + coin_bbox["height"] / 2.0),
        }
    # When the model confirms jewellery but omits/garbles "confidence", default to a
    # passing value rather than 0.0 — otherwise a perfectly valid, already-approved
    # photo gets falsely rejected for "low confidence" at the weight stage.
    confidence = _clamp01(result.get("confidence"), 0.7 if jewellery_present else 0.0)
    normalized = {
        "valid_image": bool(result.get("valid_image", False)),
        "jewellery_present": jewellery_present,
        "coin_present": coin_present,
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
        "coin_point": coin_point,
        "coin_bbox": coin_bbox,
        "confidence": confidence,
        "issues": result.get("issues") if isinstance(result.get("issues"), list) else [],
        "provider": provider,
        "model": model,
    }
    logger.info(
        "VLM ROI: provider=%s valid=%s jewellery=%s coin=%s type=%s conf=%.2f point=%s coin_point=%s",
        provider,
        normalized["valid_image"],
        normalized["jewellery_present"],
        normalized["coin_present"],
        normalized["item_type"],
        normalized["confidence"],
        normalized["jewellery_point"],
        normalized["coin_point"],
    )
    return normalized
