"""
Same-item comparison for multi-step jewelry capture.

The local scorer is intentionally conservative. It only produces a confident
"different" verdict for strong visual conflicts. Groq vision is used as the
semantic judge because it handles top/side/macro angle changes better than pure
pHash or shape descriptors.
"""
from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import logging
import math
import os
import re
import time
from typing import Optional

import numpy as np

from app.data.color import analyze_color
from app.data.image_utils import (
    classify_jewelry_geometry,
    detect_coin_hough,
    estimate_jewelry_bbox_px,
    fetch_image_bytes,
)
from app.data.phash import compute_phash, hamming_distance


logger = logging.getLogger("goldeye.item_match")


def _split_keys(*names: str) -> list[str]:
    keys: list[str] = []
    for name in names:
        raw = os.getenv(name, "")
        for key in raw.split(","):
            key = key.strip()
            if key and key not in keys:
                keys.append(key)
    return keys


GROQ_PRIMARY_API_KEYS = _split_keys("GROQ_PRIMARY_API_KEY_1", "GROQ_PRIMARY_API_KEY_2", "GROQ_API_KEY", "GROQ_API_KEY_2")
GROQ_GUIDANCE_API_KEYS = _split_keys("GROQ_GUIDANCE_API_KEY", "GROQ_API_KEY")
GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS = _split_keys("GROQ_AUDIO_VIDEO_FALLBACK_API_KEY", "GROQ_API_KEY")

COMPARE_FRAME_TYPES = {"top", "45deg", "side", "macro", "hallmark", "huid", "closeup", "selfie", "video"}
LOW_CONTEXT_FRAME_TYPES = {"macro", "hallmark", "huid", "closeup", "selfie"}
ANGLE_VARIANT_FRAME_TYPES = {"45deg", "side"}
_IMAGE_BYTES_CACHE: dict[str, tuple[float, bytes]] = {}
_IMAGE_BYTES_CACHE_MAX = 48
_IMAGE_BYTES_CACHE_TTL_S = 15 * 60


def _float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def parse_json_response(text: str) -> dict:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    cleaned = text
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    match = re.search(r"(\{.*\})", cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    cleaned_fuzzy = re.sub(r",\s*([\]\}])", r"\1", cleaned)
    match_fuzzy = re.search(r"(\{.*\})", cleaned_fuzzy, re.DOTALL)
    if match_fuzzy:
        try:
            return json.loads(match_fuzzy.group(1))
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("Could not extract or parse valid JSON from LLM response", text, 0)


def _frame_context(frame_type: str | None) -> dict:
    normalized = str(frame_type or "").strip().lower()
    return {
        "normalized": normalized,
        "is_low_context": normalized in LOW_CONTEXT_FRAME_TYPES,
        "is_angle_variant": normalized in ANGLE_VARIANT_FRAME_TYPES,
        "is_video": normalized == "video" or normalized.startswith("video_"),
    }


def _cache_key(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8", "ignore")).hexdigest()


def _get_cached_bytes(source: str) -> Optional[bytes]:
    key = _cache_key(source)
    cached = _IMAGE_BYTES_CACHE.get(key)
    if not cached:
        return None
    now = time.monotonic()
    cached_at, raw = cached
    if now - cached_at > _IMAGE_BYTES_CACHE_TTL_S:
        _IMAGE_BYTES_CACHE.pop(key, None)
        return None
    _IMAGE_BYTES_CACHE[key] = (now, raw)
    return raw


def _set_cached_bytes(source: str, raw: Optional[bytes]) -> Optional[bytes]:
    if not raw:
        return raw
    now = time.monotonic()
    _IMAGE_BYTES_CACHE[_cache_key(source)] = (now, raw)
    if len(_IMAGE_BYTES_CACHE) > _IMAGE_BYTES_CACHE_MAX:
        oldest = sorted(_IMAGE_BYTES_CACHE.items(), key=lambda item: item[1][0])
        for key, _ in oldest[: len(_IMAGE_BYTES_CACHE) - _IMAGE_BYTES_CACHE_MAX]:
            _IMAGE_BYTES_CACHE.pop(key, None)
    return raw


async def _load_bytes(source: str) -> Optional[bytes]:
    if not source:
        return None
    cached = _get_cached_bytes(source)
    if cached is not None:
        return cached
    if source.startswith("data:"):
        return _set_cached_bytes(source, await asyncio.to_thread(_decode_data_url, source))
    if source.startswith("http://") or source.startswith("https://") or source.startswith("local://"):
        return _set_cached_bytes(source, await fetch_image_bytes(source))
    return _set_cached_bytes(source, await asyncio.to_thread(_decode_base64, source))


def _decode_data_url(source: str) -> Optional[bytes]:
    try:
        _, encoded = source.split(",", 1)
        return base64.b64decode(encoded)
    except Exception:
        return None


def _decode_base64(source: str) -> Optional[bytes]:
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

    coin = None
    try:
        coin = detect_coin_hough(img, "auto_coin")
    except Exception:
        coin = None
    bbox = estimate_jewelry_bbox_px(img, coin)
    color = analyze_color(img)
    hsh = compute_phash(img)

    aspect = None
    fill = None
    hollow = None
    area_fraction = None
    geometry = "unknown"
    touches_image_edge = False
    spans_frame = False
    visible_area_weak = False
    partial_view = False
    if bbox:
        major = float(bbox.get("major_axis_px") or max(bbox.get("width_px", 1), bbox.get("height_px", 1)))
        minor = max(1.0, float(bbox.get("minor_axis_px") or min(bbox.get("width_px", 1), bbox.get("height_px", 1))))
        aspect = major / minor
        fill = float(bbox.get("fill_ratio", 0.5))
        hollow = float(bbox.get("hollow_ratio", 0.0))
        area_fraction = float(bbox.get("area_fraction", 0.0))
        geometry = classify_jewelry_geometry(bbox, None)
        image_w = max(1.0, float(bbox.get("image_width_px") or 1.0))
        image_h = max(1.0, float(bbox.get("image_height_px") or 1.0))
        x = float(bbox.get("x_px") or 0.0)
        y = float(bbox.get("y_px") or 0.0)
        width = float(bbox.get("width_px") or 0.0)
        height = float(bbox.get("height_px") or 0.0)
        margin_x = image_w * 0.025
        margin_y = image_h * 0.025
        touches_image_edge = (
            x <= margin_x
            or y <= margin_y
            or x + width >= image_w - margin_x
            or y + height >= image_h - margin_y
        )
        spans_frame = width >= image_w * 0.92 or height >= image_h * 0.92
        visible_area_weak = area_fraction < 0.006
        partial_view = touches_image_edge or spans_frame or visible_area_weak

    return {
        "valid": True,
        "bbox": bbox,
        "geometry_class": geometry,
        "aspect": aspect,
        "fill_ratio": fill,
        "hollow_ratio": hollow,
        "area_fraction": area_fraction,
        "touches_image_edge": touches_image_edge,
        "spans_frame": spans_frame,
        "visible_area_weak": visible_area_weak,
        "partial_view": partial_view,
        "mean_lab": color.get("mean_lab") if not color.get("error") else None,
        "color_confidence": float(color.get("color_confidence", 0.0)),
        "metal_fraction": float(color.get("metal_fraction", 0.0)),
        "best_karat": color.get("best_karat"),
        "phash": hsh,
    }


def _local_compare_raw(
    reference_raw: bytes,
    candidate_raw: bytes,
    reference_frame_type: str,
    candidate_frame_type: str,
) -> dict:
    local_result = _local_compare(
        _fingerprint(reference_raw),
        _fingerprint(candidate_raw),
        reference_frame_type,
        candidate_frame_type,
    )
    local_result["reference_frame_type"] = reference_frame_type
    local_result["candidate_frame_type"] = candidate_frame_type
    return local_result


def _crop_jewelry_bytes(raw: bytes) -> bytes:
    img = _decode_image(raw)
    if img is None:
        return raw

    try:
        import cv2

        coin = detect_coin_hough(img, "auto_coin")
        bbox = estimate_jewelry_bbox_px(img, coin)
        if not bbox:
            return raw

        h, w = img.shape[:2]
        x = int(bbox.get("x_px") or 0)
        y = int(bbox.get("y_px") or 0)
        bw = int(bbox.get("width_px") or 0)
        bh = int(bbox.get("height_px") or 0)
        if bw <= 8 or bh <= 8:
            return raw

        margin = int(max(bw, bh) * 0.32)
        x0 = max(0, x - margin)
        y0 = max(0, y - margin)
        x1 = min(w, x + bw + margin)
        y1 = min(h, y + bh + margin)
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return raw

        ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        if ok:
            return buf.tobytes()
    except Exception:
        return raw

    return raw


def _groq_item_api_keys() -> list[str]:
    keys: list[str] = []
    for group in (GROQ_PRIMARY_API_KEYS, GROQ_GUIDANCE_API_KEYS, GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS):
        for key in group:
            if key and key not in keys:
                keys.append(key)
    return keys


def _bounded_log_ratio(a: Optional[float], b: Optional[float], denominator: float) -> float:
    if not a or not b or a <= 0 or b <= 0:
        return 0.5
    return min(1.0, abs(math.log(a / b)) / denominator)


def _reference_is_weak(ref: dict, reference_frame_type: str) -> bool:
    if str(reference_frame_type or "").strip().lower() != "top":
        return False
    if not ref.get("valid") or not ref.get("bbox"):
        return True
    return bool(
        ref.get("partial_view")
        or float(ref.get("area_fraction") or 0.0) < 0.006
    )


def _local_compare(ref: dict, cand: dict, reference_frame_type: str, candidate_frame_type: str) -> dict:
    frame_context = _frame_context(candidate_frame_type)
    reference_weak = _reference_is_weak(ref, reference_frame_type)
    if not ref.get("valid") or not cand.get("valid"):
        return {
            "same_item": None,
            "verdict": "inconclusive",
            "same_item_score": 0.5,
            "confidence": 0.0,
            "method": "local_visual_fingerprint",
            "reference_frame_type": reference_frame_type,
            "candidate_frame_type": candidate_frame_type,
            "reference_view_partial": reference_weak,
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
    distinct_type_mismatch = geometry_conflict and {ref_geom, cand_geom} not in (
        {"ring_or_bangle", "bangle_like"},
        {"ring_or_bangle"},
        {"bangle_like"},
    )
    shape_mismatch_threshold = 0.35 if distinct_type_mismatch else 0.22 if reference_weak else 0.34
    shape_mismatch = shape_score <= shape_mismatch_threshold
    geometry_mismatch = geometry_conflict and (
        not reference_weak
        or shape_mismatch
        or color_score <= 0.32
        or phash_score <= 0.32
    )
    angle_identity_conflict = (
        str(reference_frame_type or "").strip().lower() == "45deg"
        and str(candidate_frame_type or "").strip().lower() in {"top", "side"}
        and distinct_type_mismatch
        and color_score <= 0.52
        and shape_score <= 0.66
    )
    if angle_identity_conflict:
        reasons.append("45deg_reference_conflicts_with_later_ring_design")

    mismatch_signal_count = sum(
        [
            color_score <= 0.32,
            shape_mismatch,
            phash_score <= 0.32,
            geometry_mismatch,
            angle_identity_conflict,
        ]
    )
    strong_geometry_conflict = geometry_mismatch and mismatch_signal_count >= 2 and (shape_score <= 0.45 or color_score < 0.52)

    if ref.get("best_karat") and cand.get("best_karat") and ref.get("best_karat") == cand.get("best_karat"):
        matches.append("karat_color_hint_consistent")

    if frame_context["is_low_context"] or frame_context["is_video"]:
        frame_factor = 0.74
    elif frame_context["is_angle_variant"]:
        frame_factor = 0.88
    else:
        frame_factor = 1.0

    if reference_weak:
        same_item_score = color_score * 0.50 + shape_score * 0.26 + phash_score * 0.24
    else:
        same_item_score = color_score * 0.42 + shape_score * 0.40 + phash_score * 0.18
    if strong_geometry_conflict:
        same_item_score = min(same_item_score, 0.28)
    if angle_identity_conflict:
        same_item_score = min(same_item_score, 0.33)

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
    if angle_identity_conflict:
        confidence = max(confidence, 0.64)
    if (frame_context["is_low_context"] or frame_context["is_video"] or frame_context["is_angle_variant"]) and mismatch_signal_count < 2:
        confidence = min(confidence, 0.54)
    if reference_weak and mismatch_signal_count < 2:
        confidence = min(confidence, 0.52)

    if frame_context["is_angle_variant"]:
        same_confidence_threshold = 0.56
    elif frame_context["is_low_context"] or frame_context["is_video"]:
        same_confidence_threshold = 0.58
    else:
        same_confidence_threshold = 0.45
    if same_item_score >= 0.66 and confidence >= same_confidence_threshold:
        verdict = "same"
        same_item = True
    elif same_item_score <= 0.34 and confidence >= 0.58 and mismatch_signal_count >= 2:
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
        "reference_frame_type": reference_frame_type,
        "candidate_frame_type": candidate_frame_type,
        "reference_view_partial": reference_weak,
        "matching_signals": matches[:5],
        "mismatch_reasons": reasons[:5],
        "debug": {
            "color_score": round(float(color_score), 3),
            "shape_score": round(float(shape_score), 3),
            "phash_score": round(float(phash_score), 3),
            "mismatch_signal_count": int(mismatch_signal_count),
            "distinct_type_mismatch": bool(distinct_type_mismatch),
            "angle_identity_conflict": bool(angle_identity_conflict),
            "reference_view_partial": bool(reference_weak),
            "reference_touches_image_edge": bool(ref.get("touches_image_edge")),
            "reference_spans_frame": bool(ref.get("spans_frame")),
            "reference_visible_area_weak": bool(ref.get("visible_area_weak")),
            "reference_geometry": ref_geom,
            "candidate_geometry": cand_geom,
        },
    }


def _normalize_semantic_result(raw: dict, local_result: dict) -> dict:
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
        "method": "semantic_multimodal_compare",
        "reference_view_partial": bool(local_result.get("reference_view_partial")),
        "matching_signals": list(raw.get("matching_signals") or [])[:5],
        "mismatch_reasons": list(raw.get("mismatch_reasons") or [])[:5],
        "local_fingerprint": local_result,
    }


def _identity_prompt(reference_frame_type: str, candidate_frame_type: str) -> str:
    return f"""Gold-loan fraud check. Image A={reference_frame_type}, Image B={candidate_frame_type}.
Are these the SAME physical jewelry item? Angles/zoom/lighting may differ — that is normal.
Mark "different" ONLY for clear item substitution (different type, color family, or distinct design).
Do NOT mark "different" for angle change, blur, crop, or partial view.

Return ONLY valid JSON:
{{"same_item":true|false|null,"verdict":"same|different|inconclusive","confidence":0.0-1.0,"same_item_score":0.0-1.0,"matching_signals":["1-3 words"],"mismatch_reasons":["1-3 words"]}}"""


def _resize_for_compare(raw: bytes, max_px: int = 512) -> bytes:
    """Shrink to 512px longest side before sending to Groq same-item check.
    Reduces image tokens ~8x vs a 1024px capture without losing identity cues."""
    try:
        import cv2
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return raw
        h, w = img.shape[:2]
        if max(h, w) <= max_px:
            return raw
        scale = max_px / max(h, w)
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return buf.tobytes() if ok else raw
    except Exception:
        return raw


def _build_groq_compare_payload(
    *,
    model: str,
    prompt: str,
    reference_raw: bytes,
    candidate_raw: bytes,
) -> dict:
    # Send only the jewelry crops resized to 512px.
    # 4 full-frame images at 1024px = ~4400 image tokens → exhausts Groq TPM in one call.
    # 2 crops at 512px = ~512 image tokens, well within per-minute budget.
    ref_img = _resize_for_compare(_crop_jewelry_bytes(reference_raw))
    cand_img = _resize_for_compare(_crop_jewelry_bytes(candidate_raw))
    return {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "text", "text": "A:"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{base64.b64encode(ref_img).decode('utf-8')}"},
                },
                {"type": "text", "text": "B:"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{base64.b64encode(cand_img).decode('utf-8')}"},
                },
            ]
        }],
        "response_format": {"type": "json_object"},
        "temperature": 0.05,
        "max_tokens": 200,
    }




async def _groq_compare(
    reference_raw: bytes,
    candidate_raw: bytes,
    reference_frame_type: str,
    candidate_frame_type: str,
    local_result: dict,
) -> Optional[dict]:
    keys = _groq_item_api_keys()
    if not keys:
        return None

    import aiohttp
    from app.data.groq_client import GROQ_API_URL, GROQ_MODEL

    per_key_timeout = _float_env("ITEM_MATCH_GROQ_PER_KEY_TIMEOUT_S", 3.0, 2.0, 20.0)
    total_timeout = _float_env("ITEM_MATCH_GROQ_TOTAL_TIMEOUT_S", 4.0, 3.0, 26.0)
    max_keys = _int_env("ITEM_MATCH_GROQ_MAX_KEYS", 2, 1, 5)
    keys = keys[:max_keys]
    deadline = time.monotonic() + total_timeout

    prompt = _identity_prompt(reference_frame_type, candidate_frame_type)
    try:
        payload = await asyncio.wait_for(
            asyncio.to_thread(
                _build_groq_compare_payload,
                model=GROQ_MODEL,
                prompt=prompt,
                reference_raw=reference_raw,
                candidate_raw=candidate_raw,
            ),
            timeout=_float_env("ITEM_MATCH_PAYLOAD_TIMEOUT_S", 2.0, 1.0, 8.0),
        )
    except asyncio.TimeoutError:
        logger.warning("Groq item compare payload preparation timed out")
        return None

    last_error = None
    async with aiohttp.ClientSession() as session:
        for idx, key in enumerate(keys):
            remaining = deadline - time.monotonic()
            if remaining <= 1.0:
                last_error = "groq_item_compare_budget_exhausted"
                break
            request_timeout = min(per_key_timeout, remaining)
            try:
                async with session.post(
                    GROQ_API_URL,
                    json=payload,
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=aiohttp.ClientTimeout(total=request_timeout),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        text = data["choices"][0]["message"]["content"]
                        parsed = parse_json_response(text)
                        result = _normalize_semantic_result(parsed, local_result)
                        result["method"] = "groq_multimodal_compare"
                        result["model"] = GROQ_MODEL
                        if idx:
                            logger.info("Groq item compare succeeded with fallback Groq key #%s", idx + 1)
                        return result

                    body = await resp.text()
                    last_error = f"groq_http_{resp.status}: {body[:160]}"
            except asyncio.TimeoutError:
                last_error = f"groq_item_compare_timeout_after_{request_timeout:.1f}s"
            except Exception as exc:
                last_error = str(exc)

    if last_error:
        logger.warning("Groq item compare failed: %s", last_error)
    return None


async def _gemini_compare(
    reference_raw: bytes,
    candidate_raw: bytes,
    reference_frame_type: str,
    candidate_frame_type: str,
    local_result: dict,
) -> Optional[dict]:
    """Same-item judge using Gemini (stronger fine-grained visual ID than the
    Groq scout model, and on a separate quota). Sends 4 images: ref full, ref
    crop, cand full, cand crop."""
    try:
        from app.data.gemini import _gemini_request, _split_keys
    except Exception:
        return None

    keys = _split_keys("GEMINI_GUIDANCE_FALLBACK_API_KEY", "GEMINI_API_KEY", "GEMINI_AUDIO_VIDEO_API_KEY")
    if not keys:
        return None

    prompt = _identity_prompt(reference_frame_type, candidate_frame_type)
    try:
        ref_crop, cand_crop = await asyncio.gather(
            asyncio.to_thread(_crop_jewelry_bytes, reference_raw),
            asyncio.to_thread(_crop_jewelry_bytes, candidate_raw),
        )
    except Exception:
        ref_crop, cand_crop = reference_raw, candidate_raw
    
    ref_img = _resize_for_compare(ref_crop)
    cand_img = _resize_for_compare(cand_crop)

    def _img(b: bytes) -> dict:
        return {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(b).decode("utf-8")}}

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"text": "A (Reference):"},
                _img(ref_img),
                {"text": "B (Candidate):"},
                _img(cand_img),
            ]
        }],
        "generationConfig": {
            "temperature": 0.05,
            "maxOutputTokens": 200,
            "responseMimeType": "application/json",
        }
    }
    timeout = _float_env("ITEM_MATCH_GEMINI_TIMEOUT_S", 5.0, 2.0, 12.0)
    try:
        data, ok = await _gemini_request(payload, timeout=int(timeout), api_keys=keys, max_retries=0)
        if not ok:
            return None
        from app.data.gemini import extract_gemini_text
        parsed = parse_json_response(extract_gemini_text(data))
        result = _normalize_semantic_result(parsed, local_result)
        result["method"] = "gemini_multimodal_compare"
        result["reference_frame_type"] = reference_frame_type
        result["candidate_frame_type"] = candidate_frame_type
        return result
    except Exception as exc:
        logger.warning("Gemini item compare failed: %s", exc)
        return None


def _semantic_result_priority(result: dict) -> tuple[int, float]:
    verdict = result.get("verdict")
    confidence = float(result.get("confidence", 0.0))
    if verdict == "different":
        return (3, confidence)
    if verdict == "same":
        return (2, confidence)
    return (1, confidence)


def _same_verdict_has_visual_conflict(semantic_result: dict) -> bool:
    if semantic_result.get("verdict") != "same":
        return False
    local_result = semantic_result.get("local_fingerprint") or {}
    debug = local_result.get("debug") or {}
    reference_type = str(local_result.get("reference_frame_type") or "").lower()
    candidate_type = str(local_result.get("candidate_frame_type") or "").lower()
    if reference_type != "45deg" or candidate_type not in {"top", "side"}:
        return False
    local_score = float(local_result.get("same_item_score", 0.5))
    color_score = float(debug.get("color_score", 1.0))
    shape_score = float(debug.get("shape_score", 1.0))
    phash_score = float(debug.get("phash_score", 1.0))
    mismatch_count = int(debug.get("mismatch_signal_count") or 0)
    # 45-degree to top-view comparisons are noisy for the local geometry
    # detector: the coin and the tilted ring can get merged into one bbox.
    # If the semantic judge says "same", only veto it for a truly severe
    # local conflict.
    if reference_type == "45deg" and candidate_type == "top":
        return (
            mismatch_count >= 2
            and local_score <= 0.42
            and (shape_score <= 0.50 or color_score <= 0.32 or phash_score <= 0.30)
        )
    if (
        mismatch_count >= 2
        and local_score <= 0.55
        and (shape_score <= 0.62 or color_score <= 0.36 or phash_score <= 0.32)
    ):
        return True
    if color_score <= 0.28 and shape_score <= 0.68 and local_score <= 0.58:
        return True
    return (
        bool(debug.get("distinct_type_mismatch"))
        and local_score <= 0.62
        and shape_score <= 0.68
    )


def _local_supports_same_despite_semantic_block(local_result: dict) -> bool:
    reference_type = str(local_result.get("reference_frame_type") or "").lower()
    candidate_type = str(local_result.get("candidate_frame_type") or "").lower()
    if reference_type != "45deg" or candidate_type not in {"top", "side"}:
        return False
    if is_blocking_mismatch(local_result):
        return False

    debug = local_result.get("debug") or {}
    local_score = float(local_result.get("same_item_score", 0.5))
    shape_score = float(debug.get("shape_score", 0.0))
    phash_score = float(debug.get("phash_score", 0.0))
    mismatch_count = int(debug.get("mismatch_signal_count") or 0)
    angle_conflict = bool(debug.get("angle_identity_conflict"))
    return (
        local_score >= 0.62
        and shape_score >= 0.72
        and phash_score >= 0.42
        and mismatch_count <= 1
        and not angle_conflict
    )


def _hybrid_visual_conflict_result(semantic_result: dict) -> dict:
    local_result = dict(semantic_result.get("local_fingerprint") or {})
    reasons = list(local_result.get("mismatch_reasons") or [])
    if "45deg_reference_conflicts_with_later_ring_design" not in reasons:
        reasons.append("45deg_reference_conflicts_with_later_ring_design")

    score = min(float(local_result.get("same_item_score", 0.5)), 0.33)
    confidence = max(
        float(local_result.get("confidence", 0.0)),
        min(0.74, float(semantic_result.get("confidence", 0.0)) - 0.08),
        0.62,
    )

    return {
        **local_result,
        "same_item": False,
        "verdict": "different",
        "same_item_score": round(score, 3),
        "confidence": round(confidence, 3),
        "method": "hybrid_visual_semantic_conflict",
        "semantic_verdict": semantic_result.get("verdict"),
        "semantic_method": semantic_result.get("method"),
        "semantic_confidence": semantic_result.get("confidence"),
        "matching_signals": list(local_result.get("matching_signals") or [])[:5],
        "mismatch_reasons": reasons[:5],
    }


async def compare_item_images(
    reference_image: str,
    candidate_image: str,
    reference_frame_type: str = "top",
    candidate_frame_type: str = "unknown",
    use_remote: bool = True,
    local_first: bool = True,
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

    if reference_raw == candidate_raw:
        return {
            "same_item": True,
            "verdict": "same",
            "same_item_score": 1.0,
            "confidence": 1.0,
            "method": "exact_image_match",
            "reference_frame_type": reference_frame_type,
            "candidate_frame_type": candidate_frame_type,
            "reference_view_partial": False,
            "matching_signals": ["exact_same_image_bytes"],
            "mismatch_reasons": [],
        }

    # Fast ORB short-circuit: many RANSAC-verified inliers on the cropped jewelry
    # is a near-certain "same item" (different items score ~0 after cropping), so
    # we can confirm same instantly without the slow VLM call. This is the common
    # case for consecutive captures, near-duplicates, and same/near angles.
    try:
        from app.data.item_match_orb import orb_fingerprint, orb_inliers, STRONG_INLIERS

        ref_fp, cand_fp = await asyncio.gather(
            asyncio.to_thread(orb_fingerprint, _decode_image(reference_raw)),
            asyncio.to_thread(orb_fingerprint, _decode_image(candidate_raw)),
        )
        orb_count, orb_ratio = await asyncio.to_thread(orb_inliers, ref_fp, cand_fp)
        if orb_count >= STRONG_INLIERS:
            return {
                "same_item": True,
                "verdict": "same",
                "same_item_score": round(min(0.99, 0.90 + orb_ratio * 0.09), 3),
                "confidence": round(min(0.99, 0.90 + min(orb_count, 200) / 2000.0), 3),
                "method": "orb_strong_inliers",
                "reference_frame_type": reference_frame_type,
                "candidate_frame_type": candidate_frame_type,
                "reference_view_partial": False,
                "matching_signals": [f"orb_ransac_inliers_{orb_count}"],
                "mismatch_reasons": [],
                "orb_inliers": int(orb_count),
            }
    except Exception as exc:  # never let the fast path break the comparison
        logger.debug("ORB short-circuit skipped: %s", exc)

    if not local_first:
        # Arbitration mode (e.g. S14): the caller already grouped frames with ORB,
        # so skip the heavy local fingerprint and let the VLM judge directly.
        local_result = {
            "same_item": None,
            "verdict": "inconclusive",
            "same_item_score": 0.5,
            "confidence": 0.0,
            "method": "local_skipped_arbitration",
            "reference_frame_type": reference_frame_type,
            "candidate_frame_type": candidate_frame_type,
            "reference_view_partial": False,
            "matching_signals": [],
            "mismatch_reasons": [],
        }
    else:
        try:
            local_result = await asyncio.wait_for(
                asyncio.to_thread(
                    _local_compare_raw,
                    reference_raw,
                    candidate_raw,
                    reference_frame_type,
                    candidate_frame_type,
                ),
                timeout=_float_env("ITEM_MATCH_LOCAL_TIMEOUT_S", 1.5, 1.0, 12.0),
            )
        except asyncio.TimeoutError:
            logger.warning("Local item fingerprint timed out")
            local_result = {
                "same_item": None,
                "verdict": "inconclusive",
                "same_item_score": 0.5,
                "confidence": 0.0,
                "method": "local_visual_fingerprint_timeout",
                "reference_frame_type": reference_frame_type,
                "candidate_frame_type": candidate_frame_type,
                "reference_view_partial": False,
                "matching_signals": [],
                "mismatch_reasons": ["local_fingerprint_timeout"],
            }

    if use_remote:
        semantic_results: list[dict] = []

        # Primary judge: Groq (fast, consistent)
        try:
            groq_result = await asyncio.wait_for(
                _groq_compare(
                    reference_raw, candidate_raw,
                    reference_frame_type, candidate_frame_type, local_result,
                ),
                timeout=_float_env("ITEM_MATCH_GROQ_TOTAL_TIMEOUT_S", 4.0, 3.0, 26.0) + 1.0,
            )
            if groq_result:
                groq_result["reference_frame_type"] = reference_frame_type
                groq_result["candidate_frame_type"] = candidate_frame_type
                semantic_results.append(groq_result)
        except asyncio.TimeoutError:
            logger.warning("Groq item compare timed out inside same-item matcher")
        except Exception as exc:
            logger.warning("Groq item compare exception: %s", exc)

        # Fallback: Gemini
        if not semantic_results:
            try:
                gemini_result = await asyncio.wait_for(
                    _gemini_compare(
                        reference_raw, candidate_raw,
                        reference_frame_type, candidate_frame_type, local_result,
                    ),
                    timeout=_float_env("ITEM_MATCH_GEMINI_TIMEOUT_S", 5.0, 2.0, 12.0) + 1.0,
                )
                if gemini_result:
                    gemini_result["reference_frame_type"] = reference_frame_type
                    gemini_result["candidate_frame_type"] = candidate_frame_type
                    semantic_results.append(gemini_result)
            except asyncio.TimeoutError:
                logger.warning("Gemini item compare timed out inside same-item matcher")
            except Exception as exc:
                logger.warning("Gemini item compare exception: %s", exc)

        if semantic_results:
            blocking_semantic = [item for item in semantic_results if is_blocking_mismatch(item)]
            if blocking_semantic:
                if _local_supports_same_despite_semantic_block(local_result):
                    # Try Gemini as tie-breaker if Llama blocks
                    try:
                        arb_result = await asyncio.wait_for(
                            _gemini_compare(
                                reference_raw,
                                candidate_raw,
                                reference_frame_type,
                                candidate_frame_type,
                                local_result,
                            ),
                            timeout=_float_env("ITEM_MATCH_GEMINI_TOTAL_TIMEOUT_S", 6.0, 3.0, 30.0) + 1.0,
                        )
                        if arb_result:
                            arb_result["reference_frame_type"] = reference_frame_type
                            arb_result["candidate_frame_type"] = candidate_frame_type
                            if not is_blocking_mismatch(arb_result):
                                return arb_result
                            blocking_semantic.append(arb_result)
                    except asyncio.TimeoutError:
                        logger.warning("Arbitration timed out after semantic mismatch")
                    except Exception as exc:
                        logger.warning("Arbitration exception after semantic mismatch: %s", exc)
                    local_result["semantic_verdict"] = ",".join(str(item.get("verdict")) for item in blocking_semantic)
                    local_result["semantic_method"] = ",".join(str(item.get("method")) for item in blocking_semantic)
                    local_result["mismatch_reasons"] = list(local_result.get("mismatch_reasons") or [])[:5]
                    return local_result
                return sorted(blocking_semantic, key=lambda item: float(item.get("confidence", 0.0)), reverse=True)[0]

            visual_conflicts = [item for item in semantic_results if _same_verdict_has_visual_conflict(item)]
            if visual_conflicts:
                strongest_conflict = sorted(
                    visual_conflicts,
                    key=lambda item: float(item.get("confidence", 0.0)),
                    reverse=True,
                )[0]
                return _hybrid_visual_conflict_result(strongest_conflict)

            if is_blocking_mismatch(local_result) and all(item.get("verdict") != "same" for item in semantic_results):
                local_result["semantic_verdict"] = ",".join(str(item.get("verdict")) for item in semantic_results)
                return local_result

            return sorted(semantic_results, key=_semantic_result_priority, reverse=True)[0]

    return local_result


def is_blocking_mismatch(result: Optional[dict]) -> bool:
    if not result:
        return False
    if result.get("verdict") != "different":
        return False

    confidence = float(result.get("confidence", 0.0))
    same_item_score = float(result.get("same_item_score", 0.5))
    method = str(result.get("method") or "")
    frame_type = result.get("frame_type") or result.get("candidate_frame_type")
    frame_context = _frame_context(frame_type)
    reference_weak = bool(
        result.get("reference_view_partial")
        or (result.get("local_fingerprint") or {}).get("reference_view_partial")
    )

    if method in ("groq_multimodal_compare", "gemini_multimodal_compare"):
        local_debug = ((result.get("local_fingerprint") or {}).get("debug") or {})
        local_distinct = bool(local_debug.get("distinct_type_mismatch"))
        if reference_weak:
            if local_distinct and confidence >= 0.78 and same_item_score <= 0.32:
                return True
            if frame_context["is_low_context"] or frame_context["is_video"] or frame_context["is_angle_variant"]:
                return confidence >= 0.88 and same_item_score <= 0.22
            return confidence >= 0.82 and same_item_score <= 0.28
        if frame_context["is_low_context"]:
            return confidence >= 0.84 and same_item_score <= 0.25
        if frame_context["is_video"]:
            return confidence >= 0.82 and same_item_score <= 0.28
        if frame_context["is_angle_variant"]:
            return confidence >= 0.76 and same_item_score <= 0.32
        return confidence >= 0.70 and same_item_score <= 0.36

    if method == "hybrid_visual_semantic_conflict":
        return confidence >= 0.58 and same_item_score <= 0.38 and str(frame_type or "").lower() in {"top", "side"}

    debug = result.get("debug") or {}
    if debug.get("distinct_type_mismatch") and int(debug.get("mismatch_signal_count") or 0) >= 2:
        if frame_context["is_low_context"] or frame_context["is_video"]:
            return confidence >= 0.72 and same_item_score <= 0.30
        return confidence >= 0.56 and same_item_score <= 0.36
    if reference_weak:
        return confidence >= 0.94 and same_item_score <= 0.16
    if frame_context["is_low_context"] or frame_context["is_video"]:
        return confidence >= 0.88 and same_item_score <= 0.20
    if frame_context["is_angle_variant"]:
        return confidence >= 0.82 and same_item_score <= 0.24
    return confidence >= 0.72 and same_item_score <= 0.32
