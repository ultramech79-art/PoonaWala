"""
Image utilities for GoldEye signal workers.

fetch_image_bytes  — download or decode a frame URL to raw bytes
detect_coin_hough  — OpenCV Hough/contour detection for ₹10/₹20 scale coins
estimate_weight_from_bbox — legacy volume→weight fallback
estimate_volume_from_measurement — coin-anchored jewellery volume band
"""
import base64
import logging
import math
from typing import Optional

import httpx
import numpy as np

from app.data.gold_physics import density_for_karat

logger = logging.getLogger("goldeye.ml.image_utils")

# RBI/SPMCIL and Finance Ministry specifications. Both current ₹10 and ₹20
# circulation coins are 27 mm across, so either can be used as the scale anchor.
COIN_SPECS = {
    "rs10_coin": {
        "label": "Indian Rs 10 coin",
        "diameter_mm": 27.0,
        "weight_g": 7.71,
        "shape": "circular",
    },
    "rs20_coin": {
        "label": "Indian Rs 20 coin",
        "diameter_mm": 27.0,
        "weight_g": 8.54,
        "shape": "dodecagonal",
    },
    "auto_coin": {
        "label": "Indian Rs 10/Rs 20 coin",
        "diameter_mm": 27.0,
        "weight_g": None,
        "shape": "circular_or_dodecagonal",
    },
}

REFERENCE_OBJECT_ALIASES = {
    "10": "rs10_coin",
    "10rs": "rs10_coin",
    "10_rupee": "rs10_coin",
    "10_rupees": "rs10_coin",
    "rs10": "rs10_coin",
    "rs10_coin": "rs10_coin",
    "rupee10_coin": "rs10_coin",
    "20": "rs20_coin",
    "20rs": "rs20_coin",
    "20_rupee": "rs20_coin",
    "20_rupees": "rs20_coin",
    "rs20": "rs20_coin",
    "rs20_coin": "rs20_coin",
    "rupee20_coin": "rs20_coin",
}

# 22K default density is only used before purity fusion has run.
GOLD_DENSITY_G_CM3 = density_for_karat(22).mid
DEFAULT_REFERENCE_FREE_WEIGHT_G = 10.0
DEFAULT_REFERENCE_FREE_VOLUME_CM3 = DEFAULT_REFERENCE_FREE_WEIGHT_G / GOLD_DENSITY_G_CM3


async def fetch_image_bytes(url: str) -> Optional[bytes]:
    """Return raw image bytes from data URI, http(s), or None for local:// stubs."""
    if url.startswith("data:"):
        _, encoded = url.split(",", 1)
        return base64.b64decode(encoded)
    import os
    if os.getenv("MOCK_VLM_FOR_TESTING") == "1":
        # Create a tiny dummy image (blue 10x10) to avoid 404s
        try:
            import cv2
            import numpy as np
            _, encoded = cv2.imencode(".jpg", np.zeros((10, 10, 3), dtype=np.uint8))
            return encoded.tobytes()
        except:
            return b""
            
    if url.startswith("http://") or url.startswith("https://"):
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.content
    # local:// stub — no real bytes available in dev
    return None


def coin_spec(reference_object: str | None = None) -> dict:
    key = REFERENCE_OBJECT_ALIASES.get((reference_object or "").strip().lower(), "auto_coin")
    return {"key": key, **COIN_SPECS[key]}


def detect_coin_hough(
    img_bgr: np.ndarray,
    reference_object: str | None = "rs10_coin",
) -> Optional[dict]:
    """
    Detect a scale coin in the image.
    Returns radius/center/px-per-mm metadata or None.

    ₹10 is circular and ₹20 is a 12-edged polygon, but both are treated as a
    27 mm outside diameter reference. Hough circles are tried first; contour
    detection handles tilted or dodecagonal ₹20 coins.
    """
    try:
        import cv2
    except ImportError:
        logger.warning("opencv not available — skipping coin detection")
        return None

    spec = coin_spec(reference_object)
    diameter_mm = float(spec["diameter_mm"])
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)

    h, w = gray.shape
    min_r = int(min(h, w) * 0.04)
    max_r = int(min(h, w) * 0.40)
    candidates: list[dict] = []

    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=int(min(h, w) * 0.15),
        param1=80,
        param2=40,
        minRadius=min_r,
        maxRadius=max_r,
    )

    if circles is not None:
        for c in np.round(circles[0]).astype(int):
            cx, cy, r = int(c[0]), int(c[1]), int(c[2])
            if r <= 0:
                continue
            candidates.append({
                "center": (cx, cy),
                "radius_px": float(r),
                "diameter_px": float(r * 2),
                "tilt_ratio": 1.0,
                "method": "hough",
                "confidence": 0.78,
            })

    # Contour fallback/validator. This is useful for the ₹20 dodecagon and for
    # coins photographed at mild perspective where a circle appears elliptical.
    edges = cv2.Canny(gray, 60, 160)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = float(h * w)
    for cnt in contours:
        area = float(cv2.contourArea(cnt))
        if area < img_area * 0.003 or area > img_area * 0.35:
            continue
        perimeter = float(cv2.arcLength(cnt, True))
        if perimeter <= 0:
            continue
        circularity = 4.0 * math.pi * area / (perimeter * perimeter)
        if circularity < 0.52:
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(cnt)
        if radius < min_r or radius > max_r:
            continue

        tilt_ratio = 1.0
        diameter_px = radius * 2.0
        if len(cnt) >= 5:
            (_, _), (axis_a, axis_b), _ = cv2.fitEllipse(cnt)
            major = max(float(axis_a), float(axis_b))
            minor = max(1.0, min(float(axis_a), float(axis_b)))
            tilt_ratio = max(0.45, min(1.0, minor / major))
            # Use major axis: a tilted circular coin preserves real diameter
            # along the direction least affected by foreshortening.
            diameter_px = major
        confidence = max(0.55, min(0.90, 0.42 + circularity * 0.45 + tilt_ratio * 0.10))
        candidates.append({
            "center": (int(round(cx)), int(round(cy))),
            "radius_px": float(diameter_px / 2.0),
            "diameter_px": float(diameter_px),
            "tilt_ratio": float(tilt_ratio),
            "method": "contour",
            "confidence": float(confidence),
        })

    if not candidates:
        return None

    # Prefer large, confident candidates: stones/ring holes are usually smaller.
    best = sorted(candidates, key=lambda c: (c["confidence"], c["radius_px"]), reverse=True)[0]
    px_per_mm = best["diameter_px"] / diameter_mm
    return {
        "reference_object": spec["key"],
        "reference_label": spec["label"],
        "coin_diameter_mm": diameter_mm,
        "coin_weight_g": spec["weight_g"],
        "shape": spec["shape"],
        "radius_px": round(float(best["radius_px"]), 3),
        "diameter_px": round(float(best["diameter_px"]), 3),
        "center": (int(best["center"][0]), int(best["center"][1])),
        "px_per_mm": px_per_mm,
        "tilt_ratio": round(float(best["tilt_ratio"]), 3),
        "detection_method": best["method"],
        "confidence": round(float(best["confidence"]), 3),
    }


def estimate_jewelry_bbox_px(
    img_bgr: np.ndarray,
    coin_result: Optional[dict] = None,
) -> Optional[dict]:
    """
    Estimate jewelry bounding box using simple thresholding / contour detection.
    Returns geometry metadata or None.
    """
    try:
        import cv2
    except ImportError:
        return None

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)

    # Warm-metal mask catches yellow jewellery when lighting allows it. The Otsu
    # branch below is kept for grayscale/synthetic/demo frames.
    gold_mask = cv2.inRange(hsv, np.array([5, 35, 35]), np.array([45, 255, 255]))
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if np.mean(thresh) > 127:
        thresh = cv2.bitwise_not(thresh)
    mask = cv2.bitwise_or(thresh, gold_mask)

    if coin_result:
        cx, cy = coin_result["center"]
        radius = int(max(coin_result["radius_px"] * 1.15, 3))
        cv2.circle(mask, (int(cx), int(cy)), radius, 0, -1)

    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    h_img, w_img = gray.shape
    img_area = float(h_img * w_img)
    kept = []
    for cnt in contours:
        area = float(cv2.contourArea(cnt))
        if area < img_area * 0.001:
            continue
        if coin_result:
            m = cv2.moments(cnt)
            if m["m00"]:
                cx = m["m10"] / m["m00"]
                cy = m["m01"] / m["m00"]
                ccx, ccy = coin_result["center"]
                dist = math.hypot(cx - ccx, cy - ccy)
                if dist < coin_result["radius_px"] * 1.20:
                    continue
        kept.append(cnt)

    if not kept:
        return None

    all_points = np.vstack(kept)
    x, y, w, h = cv2.boundingRect(all_points)
    rect = cv2.minAreaRect(all_points)
    (_, _), (rw, rh), angle = rect
    major_px = float(max(rw, rh, w, h))
    minor_px = float(max(1.0, min(max(rw, 1.0), max(rh, 1.0), max(w, 1.0), max(h, 1.0))))

    component_area_px2 = float(sum(cv2.contourArea(c) for c in kept))
    mask_area_px2 = float(cv2.countNonZero(mask[y:y + h, x:x + w]))
    bbox_area_px2 = float(max(1, w * h))
    fill_ratio = max(0.0, min(1.0, mask_area_px2 / bbox_area_px2))
    external_area = max(component_area_px2, mask_area_px2, 1.0)
    hollow_ratio = max(0.0, min(1.0, 1.0 - (mask_area_px2 / external_area)))

    return {
        "x_px": int(x),
        "y_px": int(y),
        "width_px": int(w),
        "height_px": int(h),
        "image_width_px": int(w_img),
        "image_height_px": int(h_img),
        "image_area_px2": int(round(img_area)),
        "area_px2": int(round(mask_area_px2)),
        "area_fraction": round(mask_area_px2 / max(img_area, 1.0), 6),
        "contour_area_px2": round(component_area_px2, 2),
        "bbox_area_px2": int(round(bbox_area_px2)),
        "major_axis_px": round(major_px, 3),
        "minor_axis_px": round(minor_px, 3),
        "rotated_rect_angle_deg": round(float(angle), 3),
        "fill_ratio": round(fill_ratio, 4),
        "hollow_ratio": round(hollow_ratio, 4),
        "component_count": len(kept),
    }


def classify_jewelry_geometry(measurement: dict, px_per_mm: Optional[float]) -> str:
    if not measurement:
        return "unknown"
    width = float(measurement.get("width_px", 0))
    height = float(measurement.get("height_px", 0))
    major = float(measurement.get("major_axis_px", max(width, height, 1.0)))
    minor = float(measurement.get("minor_axis_px", max(1.0, min(width, height))))
    aspect = major / max(minor, 1.0)
    fill = float(measurement.get("fill_ratio", 0.5))
    components = int(measurement.get("component_count", 1))

    if components >= 4 or aspect >= 3.4:
        return "chain_like"
    if fill <= 0.42 and aspect <= 2.2:
        return "ring_or_bangle"
    if px_per_mm:
        major_mm = major / px_per_mm
        minor_mm = minor / px_per_mm
        if major_mm >= 45 and minor_mm >= 18 and fill <= 0.62:
            return "bangle_like"
    return "compact_or_pendant"


def _reference_free_volume_from_measurement(measurement: Optional[dict]) -> dict:
    """
    Broad visual prior for cases without a scale coin.

    Absolute weight is not identifiable from a single uncalibrated image, so
    this path intentionally returns a wide band and low confidence. It still
    uses visible geometry instead of the old fixed 7.9 g population mean.
    """
    if not measurement:
        low_g, mid_g, high_g = 2.0, DEFAULT_REFERENCE_FREE_WEIGHT_G, 45.0
        geometry_class = "unknown"
        coverage = 0.0
        confidence = 0.16
    else:
        geometry_class = classify_jewelry_geometry(measurement, None)
        area_px2 = float(measurement.get("area_px2", 0.0))
        image_area = float(measurement.get("image_area_px2") or 0.0)
        if image_area <= 0:
            image_area = float(measurement.get("image_width_px", 0.0)) * float(measurement.get("image_height_px", 0.0))
        coverage = area_px2 / max(image_area, 1.0)
        fill = float(measurement.get("fill_ratio", 0.5))

        if geometry_class == "chain_like":
            mid_g = 6.0 if coverage < 0.035 else 11.0 if coverage < 0.11 else 20.0
            low_g, high_g = mid_g * 0.30, mid_g * 2.60
        elif geometry_class == "ring_or_bangle" or fill <= 0.48:
            mid_g = 5.0 if coverage < 0.04 else 12.0 if coverage < 0.14 else 26.0
            low_g, high_g = mid_g * 0.35, mid_g * 2.15
        else:
            mid_g = 3.5 if coverage < 0.025 else 7.5 if coverage < 0.09 else 15.0
            low_g, high_g = mid_g * 0.34, mid_g * 2.10

        confidence = max(0.18, min(0.38, 0.18 + min(coverage, 0.18) * 0.75))

    return {
        "volume_cm3": round(mid_g / GOLD_DENSITY_G_CM3, 4),
        "volume_low_cm3": round(max(0.2, low_g) / density_for_karat(18).high, 4),
        "volume_high_cm3": round(min(5000.0, high_g) / density_for_karat(24).low, 4),
        "geometry_class": geometry_class,
        "method": "reference_free_visual_prior",
        "confidence": round(confidence, 3),
        "scale_uncertainty_pct": 0.75,
        "reference_free": True,
        "note": "No coin scale detected; absolute weight is a broad visual prior.",
        "area_fraction": round(coverage, 6),
    }


def estimate_volume_from_measurement(
    measurement: Optional[dict],
    px_per_mm: Optional[float],
    coin_result: Optional[dict] = None,
) -> dict:
    """
    Estimate jewellery volume from a top-view mask and coin scale.

    The output is a volume band independent of karat. Fusion later applies
    density for the estimated purity band.
    """
    if not measurement or px_per_mm is None or px_per_mm <= 0:
        return _reference_free_volume_from_measurement(measurement)

    area_px2 = float(measurement.get("area_px2", 0.0))
    major_px = float(measurement.get("major_axis_px", measurement.get("width_px", 0.0)))
    minor_px = float(measurement.get("minor_axis_px", measurement.get("height_px", 0.0)))
    if area_px2 <= 0 or major_px <= 0 or minor_px <= 0:
        return _reference_free_volume_from_measurement(measurement)

    area_mm2 = area_px2 / (px_per_mm * px_per_mm)
    major_mm = major_px / px_per_mm
    minor_mm = minor_px / px_per_mm
    avg_visible_width_mm = area_mm2 / max(major_mm, 1.0)
    geometry_class = classify_jewelry_geometry(measurement, px_per_mm)

    if geometry_class == "chain_like":
        thickness_mid = max(0.7, min(4.0, avg_visible_width_mm * 0.62))
        thickness_low = max(0.4, thickness_mid * 0.55)
        thickness_high = max(thickness_mid * 1.75, min(6.5, avg_visible_width_mm * 1.15))
        form_low, form_mid, form_high = 0.45, 0.62, 0.78
    elif geometry_class in ("ring_or_bangle", "bangle_like"):
        thickness_mid = max(0.9, min(8.0, avg_visible_width_mm * 0.82))
        thickness_low = max(0.55, thickness_mid * 0.62)
        thickness_high = max(thickness_mid * 1.45, min(10.0, avg_visible_width_mm * 1.35))
        form_low, form_mid, form_high = 0.62, 0.76, 0.90
    else:
        thickness_mid = max(0.6, min(5.5, min(minor_mm * 0.33, avg_visible_width_mm * 0.95)))
        thickness_low = max(0.35, thickness_mid * 0.58)
        thickness_high = max(thickness_mid * 1.60, min(7.5, avg_visible_width_mm * 1.50))
        form_low, form_mid, form_high = 0.58, 0.74, 0.96

    # Convert mm^3 to cm^3 by dividing by 1000.
    volume_mid = area_mm2 * thickness_mid * form_mid / 1000.0
    volume_low = area_mm2 * thickness_low * form_low / 1000.0
    volume_high = area_mm2 * thickness_high * form_high / 1000.0

    tilt = float((coin_result or {}).get("tilt_ratio", 1.0))
    coin_conf = float((coin_result or {}).get("confidence", 0.72))
    scale_uncertainty = 0.08
    if tilt < 0.85:
        scale_uncertainty += 0.07
    if coin_conf < 0.65:
        scale_uncertainty += 0.06

    volume_low *= max(0.55, 1.0 - scale_uncertainty)
    volume_high *= 1.0 + scale_uncertainty
    confidence = max(0.35, min(0.86, 0.90 - scale_uncertainty - (0.08 if geometry_class == "unknown" else 0.0)))

    return {
        "volume_cm3": round(volume_mid, 4),
        "volume_low_cm3": round(min(volume_low, volume_mid), 4),
        "volume_high_cm3": round(max(volume_high, volume_mid), 4),
        "top_area_mm2": round(area_mm2, 3),
        "major_mm": round(major_mm, 3),
        "minor_mm": round(minor_mm, 3),
        "avg_visible_width_mm": round(avg_visible_width_mm, 3),
        "thickness_mm": round(thickness_mid, 3),
        "thickness_low_mm": round(thickness_low, 3),
        "thickness_high_mm": round(thickness_high, 3),
        "form_factor": form_mid,
        "form_factor_low": form_low,
        "form_factor_high": form_high,
        "geometry_class": geometry_class,
        "method": "coin_scaled_mask_volume",
        "confidence": round(confidence, 3),
        "scale_uncertainty_pct": round(scale_uncertainty, 3),
    }


def _weighted_average(items: list[tuple[float, float]]) -> float:
    total_weight = sum(max(0.0, w) for _, w in items)
    if total_weight <= 0:
        return sum(v for v, _ in items) / max(len(items), 1)
    return sum(v * max(0.0, w) for v, w in items) / total_weight


def _weighted_quantile(items: list[tuple[float, float]], quantile: float) -> float:
    if not items:
        return 0.0
    ordered = sorted((float(v), max(0.0, float(w))) for v, w in items)
    total = sum(w for _, w in ordered)
    if total <= 0:
        idx = int(max(0, min(len(ordered) - 1, round((len(ordered) - 1) * quantile))))
        return ordered[idx][0]
    threshold = total * max(0.0, min(1.0, quantile))
    running = 0.0
    for value, weight in ordered:
        running += weight
        if running >= threshold:
            return value
    return ordered[-1][0]


def fuse_volume_estimates(estimates: list[dict]) -> dict:
    """
    Fuse per-frame volume estimates from all usable photos/video frames.

    Coin-scaled frames carry the most weight. Reference-free video/photo frames
    still contribute orientation and size evidence, but with a lower weight
    because absolute scale is underdetermined without a coin in that frame.
    """
    valid = [v for v in estimates if float(v.get("volume_cm3") or 0.0) > 0]
    if not valid:
        return estimate_volume_from_measurement(None, None)

    weighted_entries: list[tuple[dict, float, float]] = []
    for estimate in valid:
        confidence = max(0.05, min(0.95, float(estimate.get("confidence", 0.25))))
        method = str(estimate.get("method", ""))
        if estimate.get("reference_free"):
            source_weight = 0.28
        elif method == "coin_scaled_mask_volume":
            source_weight = 1.25
        else:
            source_weight = 0.65
        weighted_entries.append((estimate, float(estimate["volume_cm3"]), confidence * source_weight))

    weighted = [(mid, weight) for _, mid, weight in weighted_entries]
    center = _weighted_quantile(weighted, 0.50)
    if len(weighted) >= 4 and center > 0:
        filtered_entries = [
            (estimate, mid, weight)
            for estimate, mid, weight in weighted_entries
            if center * 0.35 <= mid <= center * 2.80
        ]
        if len(filtered_entries) >= max(2, len(weighted_entries) // 2):
            weighted_entries = filtered_entries
            weighted = [(mid, weight) for _, mid, weight in weighted_entries]

    mid = _weighted_average(weighted)
    interval_items = [(estimate, weight) for estimate, _, weight in weighted_entries]

    if not interval_items:
        interval_items = [(v, 0.2) for v in valid]

    low_q = _weighted_quantile(
        [(float(v.get("volume_low_cm3", v["volume_cm3"])), w) for v, w in interval_items],
        0.20,
    )
    high_q = _weighted_quantile(
        [(float(v.get("volume_high_cm3", v["volume_cm3"])), w) for v, w in interval_items],
        0.80,
    )

    deviations = [(abs(float(v["volume_cm3"]) - mid), w) for v, w in interval_items]
    disagreement = _weighted_quantile(deviations, 0.75) / max(mid, 0.0001)
    disagreement = max(0.08, min(0.70, disagreement))
    low = min(low_q, mid * (1.0 - disagreement))
    high = max(high_q, mid * (1.0 + disagreement))

    coin_scaled_count = sum(1 for v in valid if v.get("method") == "coin_scaled_mask_volume")
    reference_free_count = sum(1 for v in valid if v.get("reference_free"))
    avg_confidence = _weighted_average([
        (float(v.get("confidence", 0.25)), 1.0 if not v.get("reference_free") else 0.45)
        for v in valid
    ])
    confidence = min(0.92, avg_confidence + min(0.10, 0.015 * max(0, len(valid) - 1)))
    if coin_scaled_count == 0:
        confidence = min(0.42, confidence)

    geometry_weights: dict[str, float] = {}
    for v, weight in interval_items:
        geometry = str(v.get("geometry_class", "unknown"))
        geometry_weights[geometry] = geometry_weights.get(geometry, 0.0) + weight
    geometry_class = max(geometry_weights, key=geometry_weights.get) if geometry_weights else "unknown"

    return {
        "volume_cm3": round(mid, 4),
        "volume_low_cm3": round(max(0.0001, min(low, mid)), 4),
        "volume_high_cm3": round(max(high, mid), 4),
        "method": "multi_frame_volume_fusion",
        "geometry_class": geometry_class,
        "confidence": round(confidence, 3),
        "frame_count": len(valid),
        "coin_scaled_frame_count": coin_scaled_count,
        "reference_free_frame_count": reference_free_count,
        "volume_disagreement_pct": round(disagreement, 3),
    }


def estimate_weight_range_from_volume(volume: dict, karat: float | int = 22) -> dict:
    """Apply karat-aware density to a volume estimate."""
    density = density_for_karat(karat)
    mid_volume = float(volume.get("volume_cm3", DEFAULT_REFERENCE_FREE_VOLUME_CM3))
    low_volume = float(volume.get("volume_low_cm3", mid_volume * 0.65))
    high_volume = float(volume.get("volume_high_cm3", mid_volume * 1.45))
    estimate = mid_volume * density.mid
    low = min(estimate, low_volume * density.low)
    high = max(estimate, high_volume * density.high)
    return {
        "estimated_weight_g": round(estimate, 2),
        "band_low_g": round(max(0.2, low), 2),
        "band_high_g": round(min(5000.0, high), 2),
        "density_g_cm3": density.mid,
        "density_low_g_cm3": density.low,
        "density_high_g_cm3": density.high,
        "karat_for_density": float(karat),
    }


def estimate_weight_from_bbox(
    bbox: dict,
    px_per_mm: Optional[float],
    thickness_mm: float = 2.5,
) -> float:
    """
    Rough weight estimate from bounding box area × assumed thickness × density.
    Falls back to a wide visual prior if scale anchor is unavailable.
    """
    if px_per_mm is None or px_per_mm <= 0:
        volume = _reference_free_volume_from_measurement(bbox)
        return estimate_weight_range_from_volume(volume, karat=22)["estimated_weight_g"]

    if "area_px2" in bbox and "major_axis_px" in bbox:
        volume = estimate_volume_from_measurement(bbox, px_per_mm)
        return estimate_weight_range_from_volume(volume, karat=22)["estimated_weight_g"]

    w_mm = bbox["width_px"] / px_per_mm
    h_mm = bbox["height_px"] / px_per_mm
    volume_cm3 = math.pi * (w_mm / 20) * (h_mm / 20) * (thickness_mm / 10)
    weight_g = volume_cm3 * GOLD_DENSITY_G_CM3
    # Clamp to plausible jewelry range
    return max(1.0, min(weight_g, 200.0))
