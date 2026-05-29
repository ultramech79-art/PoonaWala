"""
Same-item comparison for multi-step jewelry capture.

The local scorer is intentionally conservative. It only produces a confident
"different" verdict for strong visual conflicts. When Gemini keys are present,
Gemini is used as the semantic judge because it handles top/side/macro angle
changes better than pure pHash or shape descriptors.
"""
from __future__ import annotations

import base64
import math
from typing import Optional

import numpy as np

from app.data.color import analyze_color
from app.data.gemini import (
    GEMINI_AUDIO_VIDEO_API_KEYS,
    GEMINI_GUIDANCE_FALLBACK_API_KEYS,
    GEMINI_MODEL,
    _gemini_request,
    extract_gemini_text,
    parse_json_response,
)
from app.data.image_utils import (
    classify_jewelry_geometry,
    estimate_jewelry_bbox_px,
    fetch_image_bytes,
)
from app.data.phash import compute_phash, hamming_distance


COMPARE_FRAME_TYPES = {"45deg", "side", "macro", "hallmark", "huid", "closeup", "selfie", "video"}
LOW_CONTEXT_FRAME_TYPES = {"macro", "hallmark", "huid", "closeup", "selfie"}


async def _load_bytes(source: str) -> Optional[bytes]:
    if not source:
        return None
    if source.startswith("data:") or source.startswith("http://") or source.startswith("https://") or source.startswith("local://"):
        return await fetch_image_bytes(source)
    try:
        return base64.b64decode(source, validate=True)
    except Exception:
        return None


def _decode_image(raw: bytes):
    try:
        import cv2

        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception:
        return None


def _lab_distance(a: list[float] | None, b: list[float] | None) -> Optional[float]:
    if not a or not b or len(a) != 3 or len(b) != 3:
        return None
    return math.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b)))


def _fingerprint(raw: bytes) -> dict:
    img = _decode_image(raw)
    if img is None:
        return {"valid": False}

    bbox = estimate_jewelry_bbox_px(img, None)
    color = analyze_color(img)
    hsh = compute_phash(img)

    aspect = None
    fill = None
    hollow = None
    area_fraction = None
    geometry = "unknown"
    if bbox:
        major = float(bbox.get("major_axis_px") or max(bbox.get("width_px", 1), bbox.get("height_px", 1)))
        minor = max(1.0, float(bbox.get("minor_axis_px") or min(bbox.get("width_px", 1), bbox.get("height_px", 1))))
        aspect = major / minor
        fill = float(bbox.get("fill_ratio", 0.5))
        hollow = float(bbox.get("hollow_ratio", 0.0))
        area_fraction = float(bbox.get("area_fraction", 0.0))
        geometry = classify_jewelry_geometry(bbox, None)

    return {
        "valid": True,
        "bbox": bbox,
        "geometry_class": geometry,
        "aspect": aspect,
        "fill_ratio": fill,
        "hollow_ratio": hollow,
        "area_fraction": area_fraction,
        "mean_lab": color.get("mean_lab") if not color.get("error") else None,
        "color_confidence": float(color.get("color_confidence", 0.0)),
        "metal_fraction": float(color.get("metal_fraction", 0.0)),
        "best_karat": color.get("best_karat"),
        "phash": hsh,
    }


def _bounded_log_ratio(a: Optional[float], b: Optional[float], denominator: float) -> float:
    if not a or not b or a <= 0 or b <= 0:
        return 0.5
    return min(1.0, abs(math.log(a / b)) / denominator)


def _local_compare(ref: dict, cand: dict, candidate_frame_type: str) -> dict:
    if not ref.get("valid") or not cand.get("valid"):
        return {
            "same_item": None,
            "verdict": "inconclusive",
            "same_item_score": 0.5,
            "confidence": 0.0,
            "method": "local_visual_fingerprint",
            "matching_signals": [],
            "mismatch_reasons": ["image_decode_failed"],
        }

    reasons: list[str] = []
    matches: list[str] = []

    delta_e = _lab_distance(ref.get("mean_lab"), cand.get("mean_lab"))
    if delta_e is None:
        color_score = 0.48
        reasons.append("metal_color_not_reliable")
    else:
        color_score = max(0.0, min(1.0, math.exp(-delta_e / 32.0)))
        if color_score >= 0.68:
            matches.append("gold_color_similar")
        elif color_score <= 0.35:
            reasons.append("gold_color_differs")

    aspect_score = 1.0 - _bounded_log_ratio(ref.get("aspect"), cand.get("aspect"), math.log(5.0))
    fill_score = 1.0 - min(1.0, abs(float(ref.get("fill_ratio") or 0.5) - float(cand.get("fill_ratio") or 0.5)) * 1.8)
    hollow_score = 1.0 - min(1.0, abs(float(ref.get("hollow_ratio") or 0.0) - float(cand.get("hollow_ratio") or 0.0)) * 1.7)
    area_score = 1.0 - _bounded_log_ratio(ref.get("area_fraction"), cand.get("area_fraction"), math.log(18.0))
    shape_score = max(0.0, min(1.0, aspect_score * 0.35 + fill_score * 0.30 + hollow_score * 0.25 + area_score * 0.10))
    if shape_score >= 0.68:
        matches.append("overall_shape_consistent")
    elif shape_score <= 0.38:
        reasons.append("overall_shape_differs")

    phash_score = 0.5
    if ref.get("phash") is not None and cand.get("phash") is not None:
        dist = hamming_distance(int(ref["phash"]), int(cand["phash"]))
        phash_score = max(0.0, min(1.0, 1.0 - dist / 64.0))
        if phash_score >= 0.82:
            matches.append("near_duplicate_visual_hash")

    ref_geom = str(ref.get("geometry_class") or "unknown")
    cand_geom = str(cand.get("geometry_class") or "unknown")
    geometry_conflict = (
        ref_geom != "unknown"
        and cand_geom != "unknown"
        and ref_geom != cand_geom
        and {ref_geom, cand_geom} not in ({"ring_or_bangle", "bangle_like"},)
    )
    if geometry_conflict:
        reasons.append(f"item_geometry_changed_from_{ref_geom}_to_{cand_geom}")
    strong_geometry_conflict = geometry_conflict and (shape_score <= 0.45 or color_score < 0.52)

    if ref.get("best_karat") and cand.get("best_karat") and ref.get("best_karat") == cand.get("best_karat"):
        matches.append("karat_color_hint_consistent")

    frame_factor = 0.82 if candidate_frame_type in LOW_CONTEXT_FRAME_TYPES else 1.0
    same_item_score = color_score * 0.42 + shape_score * 0.40 + phash_score * 0.18
    if strong_geometry_conflict:
        same_item_score = min(same_item_score, 0.28)

    evidence_quality = min(
        1.0,
        0.35
        + min(float(ref.get("metal_fraction") or 0.0), 0.18) * 1.5
        + min(float(cand.get("metal_fraction") or 0.0), 0.18) * 1.5
        + (0.12 if ref.get("bbox") else 0.0)
        + (0.12 if cand.get("bbox") else 0.0),
    )
    confidence = max(0.0, min(1.0, evidence_quality * frame_factor * (0.55 + abs(same_item_score - 0.5))))
    if strong_geometry_conflict:
        confidence = max(confidence, 0.68 * frame_factor)

    if same_item_score >= 0.66 and confidence >= 0.45:
        verdict = "same"
        same_item = True
    elif same_item_score <= 0.34 and confidence >= 0.58:
        verdict = "different"
        same_item = False
    else:
        verdict = "inconclusive"
        same_item = None

    return {
        "same_item": same_item,
        "verdict": verdict,
        "same_item_score": round(float(same_item_score), 3),
        "confidence": round(float(confidence), 3),
        "method": "local_visual_fingerprint",
        "matching_signals": matches[:5],
        "mismatch_reasons": reasons[:5],
        "debug": {
            "color_score": round(float(color_score), 3),
            "shape_score": round(float(shape_score), 3),
            "phash_score": round(float(phash_score), 3),
            "reference_geometry": ref_geom,
            "candidate_geometry": cand_geom,
        },
    }


def _normalize_gemini_result(raw: dict, local_result: dict) -> dict:
    verdict = str(raw.get("verdict") or "").strip().lower()
    same_item = raw.get("same_item")
    if verdict not in ("same", "different", "inconclusive"):
        if same_item is True:
            verdict = "same"
        elif same_item is False:
            verdict = "different"
        else:
            verdict = "inconclusive"

    if verdict == "same":
        same_item = True
    elif verdict == "different":
        same_item = False
    else:
        same_item = None

    confidence = max(0.0, min(1.0, float(raw.get("confidence", local_result.get("confidence", 0.5)))))
    score = raw.get("same_item_score")
    if score is None:
        score = 0.5 + confidence * 0.5 if same_item is True else 0.5 - confidence * 0.5 if same_item is False else 0.5

    return {
        "same_item": same_item,
        "verdict": verdict,
        "same_item_score": round(max(0.0, min(1.0, float(score))), 3),
        "confidence": round(confidence, 3),
        "method": "gemini_multimodal_compare",
        "matching_signals": list(raw.get("matching_signals") or [])[:5],
        "mismatch_reasons": list(raw.get("mismatch_reasons") or [])[:5],
        "local_fingerprint": local_result,
    }


async def _gemini_compare(
    reference_raw: bytes,
    candidate_raw: bytes,
    reference_frame_type: str,
    candidate_frame_type: str,
    local_result: dict,
) -> Optional[dict]:
    keys = GEMINI_GUIDANCE_FALLBACK_API_KEYS or GEMINI_AUDIO_VIDEO_API_KEYS
    if not keys:
        return None

    prompt = f"""You are a fraud-control visual examiner for a gold-loan app.
Compare whether image A and image B show the SAME physical jewelry item.

Image A is the baseline {reference_frame_type} capture. Image B is the later {candidate_frame_type} capture.
Jewelry may look different because of angle, zoom, crop, lighting, or a macro close-up.
Do not require duplicate photos. Focus on item type, distinctive shape, thickness, hollow/open regions, chain/link pattern, stones, hallmark area, color family, wear marks, and visible engravings.

Return ONLY valid JSON:
{{
  "same_item": true|false|null,
  "verdict": "same|different|inconclusive",
  "confidence": 0.0-1.0,
  "same_item_score": 0.0-1.0,
  "matching_signals": ["short evidence"],
  "mismatch_reasons": ["short evidence"]
}}

Use "different" only when there is clear evidence the physical jewelry item changed.
Use "inconclusive" for macro/selfie crops where identity cannot be proven."""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(reference_raw).decode("utf-8")}},
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(candidate_raw).decode("utf-8")}},
            ]
        }],
        "generationConfig": {
            "temperature": 0.05,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
        },
    }

    data, success = await _gemini_request(payload, timeout=45, api_keys=keys, max_retries=1)
    if not success:
        return None

    text = extract_gemini_text(data)
    parsed = parse_json_response(text)
    result = _normalize_gemini_result(parsed, local_result)
    result["model"] = GEMINI_MODEL
    return result


async def compare_item_images(
    reference_image: str,
    candidate_image: str,
    reference_frame_type: str = "top",
    candidate_frame_type: str = "unknown",
    use_gemini: bool = True,
) -> dict:
    reference_raw = await _load_bytes(reference_image)
    candidate_raw = await _load_bytes(candidate_image)
    if not reference_raw or not candidate_raw:
        return {
            "same_item": None,
            "verdict": "inconclusive",
            "same_item_score": 0.5,
            "confidence": 0.0,
            "method": "none",
            "matching_signals": [],
            "mismatch_reasons": ["missing_reference_or_candidate_image"],
        }

    local_result = _local_compare(_fingerprint(reference_raw), _fingerprint(candidate_raw), candidate_frame_type)

    if use_gemini:
        try:
            gemini_result = await _gemini_compare(
                reference_raw,
                candidate_raw,
                reference_frame_type,
                candidate_frame_type,
                local_result,
            )
            if gemini_result:
                return gemini_result
        except Exception:
            pass

    return local_result


def is_blocking_mismatch(result: Optional[dict]) -> bool:
    if not result:
        return False
    return (
        result.get("verdict") == "different"
        and float(result.get("confidence", 0.0)) >= 0.65
        and float(result.get("same_item_score", 0.5)) <= 0.38
    )
