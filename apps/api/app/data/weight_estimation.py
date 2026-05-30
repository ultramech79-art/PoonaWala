"""
AI-assisted gold jewellery weight estimation from a single image.

The estimator uses reference-object scaling, OpenCV geometry extraction,
optional SAM segmentation, optional MiDaS depth, and density-based physics.
No LLM/VLM path is used for estimation.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Optional

import cv2
import numpy as np

JewelryType = Literal["ring", "bangle", "bracelet", "necklace", "pendant", "chain", "irregular", "auto"]
Karat = Literal[24, 22, 18]
logger = logging.getLogger("goldeye.weight_estimation")


class WeightEstimationError(ValueError):
    def __init__(self, code: str, message: str, details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class CoinDetection:
    center: tuple[int, int]
    radius_px: float
    confidence: float

    @property
    def diameter_px(self) -> float:
        return self.radius_px * 2.0


@dataclass(frozen=True)
class ImageQuality:
    blur_laplacian: float
    brightness: float
    brightness_score: float
    sharpness_score: float


@dataclass(frozen=True)
class SegmentationResult:
    mask: np.ndarray
    method: str
    quality: float
    contour_count: int


@dataclass(frozen=True)
class DepthResult:
    depth: np.ndarray
    method: str
    consistency: float


@dataclass(frozen=True)
class ProfileMeasurement:
    thickness_mm: float
    width_mm: float
    confidence: float
    method: str
    view: str
    scale_source: str


@lru_cache(maxsize=1)
def _config() -> dict[str, Any]:
    path = Path(__file__).with_name("weight_calibration.json")
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _decode_image_data_url(data_url: str) -> np.ndarray:
    try:
        payload = data_url.split(",", 1)[1] if "," in data_url else data_url
        raw = base64.b64decode(payload, validate=False)
        arr = np.frombuffer(raw, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as exc:
        raise WeightEstimationError("image_decode_failed", "Could not decode uploaded image.") from exc
    if img is None or img.size == 0:
        raise WeightEstimationError("image_decode_failed", "Uploaded image is not a valid image.")
    return _resize_for_cpu(img)


def _resize_for_cpu(img: np.ndarray, max_side: int = 1280) -> np.ndarray:
    h, w = img.shape[:2]
    side = max(h, w)
    if side <= max_side:
        return img
    scale = max_side / float(side)
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def _encode_png_data_url(img: np.ndarray, max_side: int = 720) -> str:
    h, w = img.shape[:2]
    side = max(h, w)
    if side > max_side:
        scale = max_side / float(side)
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise WeightEstimationError("visualization_failed", "Could not encode visualization output.")
    return "data:image/png;base64," + base64.b64encode(buf).decode("ascii")


def _image_quality(img: np.ndarray) -> ImageQuality:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(np.mean(gray))
    brightness_score = max(0.0, min(1.0, 1.0 - abs(brightness - 135.0) / 135.0))
    sharpness_score = max(0.0, min(1.0, blur / 180.0))
    return ImageQuality(blur, brightness, brightness_score, sharpness_score)


def _validate_quality(q: ImageQuality) -> list[str]:
    thresholds = _config()["quality_thresholds"]
    issues: list[str] = []
    if q.blur_laplacian < thresholds["min_blur_laplacian"]:
        issues.append("blurry_image")
    if q.brightness < thresholds["min_brightness"]:
        issues.append("low_lighting")
    if q.brightness > thresholds["max_brightness"]:
        issues.append("overexposed_image")
    return issues


def _detect_rs10_coin(img: np.ndarray) -> CoinDetection:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.equalizeHist(gray)
    gray = cv2.medianBlur(gray, 5)
    h, w = gray.shape[:2]
    min_side = min(h, w)
    found: list[np.ndarray] = []
    for param2 in (34, 28, 22, 16):
        circles = cv2.HoughCircles(
            gray,
            cv2.HOUGH_GRADIENT,
            dp=1.15,
            minDist=max(40, int(min_side * 0.12)),
            param1=95,
            param2=param2,
            minRadius=max(9, int(min_side * 0.025)),
            maxRadius=max(24, int(min_side * 0.22)),
        )
        if circles is not None:
            found.extend(np.round(circles[0]).astype(int))
    if not found:
        raise WeightEstimationError(
            "reference_object_missing",
            "Place a Rs 10 coin in the image. The reference object is mandatory for scale.",
        )

    candidates = found
    best: Optional[CoinDetection] = None
    best_score = -1.0
    for cx, cy, radius in candidates:
        if radius <= 0:
            continue
        circle_mask = np.zeros(gray.shape, dtype=np.uint8)
        cv2.circle(circle_mask, (int(cx), int(cy)), int(radius), 255, -1)
        ring_mask = np.zeros(gray.shape, dtype=np.uint8)
        cv2.circle(ring_mask, (int(cx), int(cy)), int(radius * 1.08), 255, 2)
        inside = gray[circle_mask > 0]
        if inside.size < 50:
            continue
        sat_inside = hsv[:, :, 1][circle_mask > 0]
        edge = cv2.Canny(gray, 80, 160)
        edge_support = float(np.mean(edge[ring_mask > 0] > 0)) if np.any(ring_mask > 0) else 0.0
        texture = min(1.0, float(np.std(inside)) / 70.0)
        neutral_metal = max(0.0, min(1.0, 1.0 - float(np.mean(sat_inside)) / 95.0))
        size_prior = 1.0 - min(1.0, abs((2 * radius / min_side) - 0.14) / 0.22)
        score = 0.34 * edge_support + 0.22 * texture + 0.22 * size_prior + 0.22 * neutral_metal
        if score > best_score:
            best = CoinDetection((int(cx), int(cy)), float(radius), max(0.2, min(0.98, score)))
            best_score = score

    if best is None:
        raise WeightEstimationError(
            "reference_object_missing",
            "Could not localize the Rs 10 coin. Use a flat coin fully visible in the frame.",
        )
    best = _refine_rs10_outer_coin_radius(img, gray, hsv, best)
    if best.confidence < 0.42:
        raise WeightEstimationError(
            "reference_object_missing",
            "Could not confidently detect a Rs 10 coin. Keep the coin flat, sharp, and fully visible.",
            {"coin_confidence": round(best.confidence, 3)},
        )
    return best


def _refine_rs10_outer_coin_radius(
    img: np.ndarray,
    gray: np.ndarray,
    hsv: np.ndarray,
    coin: CoinDetection,
) -> CoinDetection:
    h, w = gray.shape[:2]
    cx, cy = coin.center
    max_r = int(min(cx, cy, w - 1 - cx, h - 1 - cy, coin.radius_px * 1.85))
    min_r = int(max(coin.radius_px * 0.92, 6))
    if max_r <= min_r + 3:
        return coin

    edges = cv2.Canny(gray, 70, 155)
    yy, xx = np.ogrid[:h, :w]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    best_radius = coin.radius_px
    best_score = -1.0

    for radius in np.linspace(min_r, max_r, num=max(8, min(34, max_r - min_r))):
        ring = np.abs(dist - radius) <= 1.7
        if np.count_nonzero(ring) < 20:
            continue
        edge_support = float(np.mean(edges[ring] > 0))

        metal_annulus = (dist >= radius * 0.70) & (dist <= radius * 0.96)
        outside_annulus = (dist >= radius * 1.04) & (dist <= min(radius * 1.22, max_r + 2))
        if np.count_nonzero(metal_annulus) < 25 or np.count_nonzero(outside_annulus) < 25:
            continue

        hue = hsv[:, :, 0]
        sat = hsv[:, :, 1].astype(np.float32)
        val = hsv[:, :, 2].astype(np.float32)
        warm_coin_ring = (
            (hue >= 5)
            & (hue <= 45)
            & (sat >= 25)
            & (val >= 35)
            & metal_annulus
        )
        warm_ratio = float(np.count_nonzero(warm_coin_ring) / max(1, np.count_nonzero(metal_annulus)))
        sat_contrast = abs(float(np.mean(sat[metal_annulus])) - float(np.mean(sat[outside_annulus]))) / 120.0
        val_contrast = abs(float(np.mean(val[metal_annulus])) - float(np.mean(val[outside_annulus]))) / 145.0
        boundary_contrast = min(1.0, 0.55 * sat_contrast + 0.45 * val_contrast)
        expansion_prior = min(1.0, max(0.0, (float(radius) / max(coin.radius_px, 1.0) - 1.0) / 0.55))
        score = 0.38 * edge_support + 0.25 * warm_ratio + 0.24 * boundary_contrast + 0.13 * expansion_prior
        if score > best_score:
            best_score = score
            best_radius = float(radius)

    if best_radius > coin.radius_px * 1.08 and best_score >= 0.18:
        return CoinDetection(
            coin.center,
            best_radius,
            max(coin.confidence, min(0.98, coin.confidence + 0.08 + 0.12 * best_score)),
        )
    return coin


def _coin_exclusion_mask(shape: tuple[int, int], coin: CoinDetection) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.circle(mask, coin.center, int(coin.radius_px * 1.35), 255, -1)
    return mask


@lru_cache(maxsize=1)
def _load_sam_mask_generator() -> Any:
    checkpoint = os.getenv("SAM_CHECKPOINT")
    model_type = os.getenv("SAM_MODEL_TYPE", "vit_b")
    if not checkpoint:
        return None
    try:
        from segment_anything import SamAutomaticMaskGenerator, sam_model_registry  # type: ignore
        sam = sam_model_registry[model_type](checkpoint=checkpoint)
        return SamAutomaticMaskGenerator(
            sam,
            points_per_side=16,
            pred_iou_thresh=0.82,
            stability_score_thresh=0.86,
            min_mask_region_area=180,
        )
    except Exception:
        return None


def _gold_likelihood_mask(img: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    warm = cv2.inRange(hsv, (5, 22, 38), (46, 255, 255))
    bright_yellow = cv2.inRange(lab, (45, 114, 136), (255, 178, 225))
    saturated = cv2.inRange(hsv[:, :, 1], 18, 255)
    bright_yellow = cv2.bitwise_and(bright_yellow, saturated)
    mask = cv2.bitwise_or(warm, bright_yellow)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    return mask


def _coin_calibrated_gold_mask(img: np.ndarray, coin: CoinDetection) -> np.ndarray:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    yy, xx = np.ogrid[:h, :w]
    dist = np.sqrt((xx - coin.center[0]) ** 2 + (yy - coin.center[1]) ** 2)
    annulus = (dist >= coin.radius_px * 0.55) & (dist <= coin.radius_px * 0.98)
    useful = annulus & (hsv[:, :, 1] > 28) & (hsv[:, :, 2] > 35)
    if np.count_nonzero(useful) < 40:
        return _gold_likelihood_mask(img)

    hue_values = hsv[:, :, 0][useful].astype(np.float32)
    sat_values = hsv[:, :, 1][useful].astype(np.float32)
    ref_hue = float(np.median(hue_values))
    ref_sat = max(28.0, float(np.percentile(sat_values, 35)))
    hue = hsv[:, :, 0].astype(np.float32)
    sat = hsv[:, :, 1].astype(np.float32)
    val = hsv[:, :, 2].astype(np.float32)
    hue_delta = np.minimum(np.abs(hue - ref_hue), 180.0 - np.abs(hue - ref_hue))
    calibrated = ((hue_delta <= 18.0) & (sat >= ref_sat * 0.55) & (val >= 35.0)).astype(np.uint8) * 255

    generic = _gold_likelihood_mask(img)
    mask = cv2.bitwise_or(calibrated, cv2.bitwise_and(generic, cv2.dilate(calibrated, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)), iterations=1)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)


def _segment_with_sam(img: np.ndarray, coin: CoinDetection) -> Optional[SegmentationResult]:
    generator = _load_sam_mask_generator()
    if generator is None:
        return None
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    masks = generator.generate(rgb)
    if not masks:
        return None

    gold_hint = _gold_likelihood_mask(img)
    coin_mask = _coin_exclusion_mask(img.shape[:2], coin)
    h, w = img.shape[:2]
    best_mask: Optional[np.ndarray] = None
    best_score = -1.0
    for item in masks:
        raw = item.get("segmentation")
        if raw is None:
            continue
        mask = (raw.astype(np.uint8) * 255)
        mask[coin_mask > 0] = 0
        area_fraction = float(np.mean(mask > 0))
        if area_fraction < 0.003 or area_fraction > 0.72:
            continue
        overlap = float(np.mean(gold_hint[mask > 0] > 0)) if np.any(mask > 0) else 0.0
        stability = float(item.get("stability_score", 0.65))
        iou = float(item.get("predicted_iou", 0.65))
        bbox = item.get("bbox") or [0, 0, w, h]
        touches_edge = bbox[0] < 4 or bbox[1] < 4 or bbox[0] + bbox[2] > w - 4 or bbox[1] + bbox[3] > h - 4
        score = 0.45 * overlap + 0.25 * stability + 0.20 * iou + 0.10 * min(1.0, area_fraction * 12.0)
        if touches_edge:
            score -= 0.15
        if score > best_score:
            best_score = score
            best_mask = mask
    if best_mask is None:
        return None
    refined = _refine_mask(best_mask)
    return SegmentationResult(refined, "sam", max(0.0, min(1.0, best_score)), _contour_count(refined))


def _point_to_pixel(point: Optional[dict[str, float]], shape: tuple[int, int]) -> Optional[tuple[int, int]]:
    if not point:
        return None
    try:
        x_norm = float(point.get("x", -1.0))
        y_norm = float(point.get("y", -1.0))
    except (TypeError, ValueError):
        return None
    if not (0.0 <= x_norm <= 1.0 and 0.0 <= y_norm <= 1.0):
        return None
    h, w = shape[:2]
    return (int(round(x_norm * (w - 1))), int(round(y_norm * (h - 1))))


def _point_seed_mask(shape: tuple[int, int], point_px: Optional[tuple[int, int]], radius: int = 18) -> np.ndarray:
    mask = np.zeros(shape[:2], dtype=np.uint8)
    if point_px is not None:
        cv2.circle(mask, point_px, radius, 255, -1)
    return mask


def _bbox_to_mask(bbox: Optional[dict[str, float]], shape: tuple[int, int], pad_fraction: float = 0.18) -> Optional[np.ndarray]:
    if not bbox:
        return None
    try:
        x = float(bbox.get("x", -1.0))
        y = float(bbox.get("y", -1.0))
        width = float(bbox.get("width", 0.0))
        height = float(bbox.get("height", 0.0))
    except (TypeError, ValueError):
        return None
    if width <= 0.0 or height <= 0.0:
        return None

    h, w = shape[:2]
    pad_x = width * pad_fraction
    pad_y = height * pad_fraction
    x0 = max(0, int(round((x - pad_x) * w)))
    y0 = max(0, int(round((y - pad_y) * h)))
    x1 = min(w, int(round((x + width + pad_x) * w)))
    y1 = min(h, int(round((y + height + pad_y) * h)))
    if x1 <= x0 or y1 <= y0:
        return None

    mask = np.zeros((h, w), dtype=np.uint8)
    mask[y0:y1, x0:x1] = 255
    return mask


def _bbox_center(bbox: Optional[dict[str, float]]) -> Optional[dict[str, float]]:
    if not bbox:
        return None
    try:
        return {
            "x": max(0.0, min(1.0, float(bbox["x"]) + float(bbox["width"]) / 2.0)),
            "y": max(0.0, min(1.0, float(bbox["y"]) + float(bbox["height"]) / 2.0)),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _ring_annulus_mask_from_bbox(shape: tuple[int, int], bbox: Optional[dict[str, float]], thickness_ratio: float = 0.16) -> Optional[np.ndarray]:
    if not bbox:
        return None
    try:
        x = float(bbox.get("x", -1.0))
        y = float(bbox.get("y", -1.0))
        width = float(bbox.get("width", 0.0))
        height = float(bbox.get("height", 0.0))
    except (TypeError, ValueError):
        return None
    if width <= 0.0 or height <= 0.0:
        return None

    h, w = shape[:2]
    cx = int(round((x + width / 2.0) * w))
    cy = int(round((y + height / 2.0) * h))
    outer_axes = (
        max(3, int(round(width * w / 2.0))),
        max(3, int(round(height * h / 2.0))),
    )
    thickness_px = max(2, int(round(min(outer_axes) * thickness_ratio)))
    inner_axes = (
        max(1, outer_axes[0] - thickness_px),
        max(1, outer_axes[1] - thickness_px),
    )
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.ellipse(mask, (cx, cy), outer_axes, 0, 0, 360, 255, -1)
    cv2.ellipse(mask, (cx, cy), inner_axes, 0, 0, 360, 0, -1)
    return mask


def _segment_with_opencv(
    img: np.ndarray,
    coin: CoinDetection,
    jewelry_point: Optional[dict[str, float]] = None,
    jewelry_bbox: Optional[dict[str, float]] = None,
) -> SegmentationResult:
    calibrated_gold = _coin_calibrated_gold_mask(img, coin)
    mask = calibrated_gold.copy()
    coin_mask = _coin_exclusion_mask(img.shape[:2], coin)
    mask[coin_mask > 0] = 0
    roi_mask = _bbox_to_mask(jewelry_bbox, img.shape[:2])
    if jewelry_point is None:
        jewelry_point = _bbox_center(jewelry_bbox)
    point_px = _point_to_pixel(jewelry_point, img.shape[:2])
    if point_px is not None and coin_mask[point_px[1], point_px[0]] > 0:
        raise WeightEstimationError(
            "invalid_jewelry_point",
            "The selected point is on the reference coin. Tap the jewellery, not the coin.",
        )

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 55, 145)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)
    edges[coin_mask > 0] = 0
    mask = cv2.bitwise_or(mask, cv2.bitwise_and(edges, _near_gold_regions(mask)))
    point_seed = _point_seed_mask(img.shape[:2], point_px, radius=max(8, int(min(img.shape[:2]) * 0.018)))
    mask = cv2.bitwise_or(mask, cv2.bitwise_and(edges, cv2.dilate(point_seed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (45, 45)), iterations=1)))
    mask = cv2.bitwise_or(mask, cv2.bitwise_and(calibrated_gold, cv2.dilate(point_seed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (75, 75)), iterations=1)))
    if roi_mask is not None:
        mask = cv2.bitwise_and(mask, roi_mask)
    refined = _refine_mask(mask)
    refined = _select_jewelry_component(img, refined, calibrated_gold, point_px, roi_mask)
    refined = _grabcut_refine_jewelry(img, refined, coin_mask, point_px, roi_mask)
    refined = _select_jewelry_component(img, refined, calibrated_gold, point_px, roi_mask)
    quality = _mask_quality(refined, img.shape[:2], method_bonus=0.0)
    return SegmentationResult(refined, "opencv", quality, _contour_count(refined))


def _grabcut_refine_jewelry(
    img: np.ndarray,
    seed: np.ndarray,
    coin_mask: np.ndarray,
    point_px: Optional[tuple[int, int]] = None,
    roi_mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    if not np.any(seed > 0):
        return seed

    contours, _ = cv2.findContours(seed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return seed

    h, w = seed.shape[:2]
    points = np.vstack(contours)
    x, y, bw, bh = cv2.boundingRect(points)
    pad = max(10, int(max(bw, bh) * 0.18))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(w, x + bw + pad)
    y1 = min(h, y + bh + pad)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return seed

    gc = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
    gc[y0:y1, x0:x1] = cv2.GC_PR_BGD

    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    kernel9 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    kernel21 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
    sure_fg = cv2.morphologyEx(seed, cv2.MORPH_OPEN, kernel3, iterations=1)
    probable_fg = cv2.dilate(seed, kernel9, iterations=1)
    local_band = cv2.dilate(seed, kernel21, iterations=2)
    point_seed = _point_seed_mask(seed.shape, point_px, radius=max(6, int(min(seed.shape[:2]) * 0.014)))

    gc[probable_fg > 0] = cv2.GC_PR_FGD
    gc[sure_fg > 0] = cv2.GC_FGD
    gc[point_seed > 0] = cv2.GC_FGD
    gc[coin_mask > 0] = cv2.GC_BGD
    gc[:y0, :] = cv2.GC_BGD
    gc[y1:, :] = cv2.GC_BGD
    gc[:, :x0] = cv2.GC_BGD
    gc[:, x1:] = cv2.GC_BGD

    bg_model = np.zeros((1, 65), np.float64)
    fg_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(img, gc, None, bg_model, fg_model, 3, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return seed

    result = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    result[coin_mask > 0] = 0
    if roi_mask is not None:
        result = cv2.bitwise_and(result, roi_mask)
    result = cv2.bitwise_and(result, local_band)
    result = cv2.bitwise_or(result, seed)
    return _refine_mask(result)


def _select_jewelry_component(
    img: np.ndarray,
    mask: np.ndarray,
    gold_reference: Optional[np.ndarray] = None,
    point_px: Optional[tuple[int, int]] = None,
    roi_mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), connectivity=8)
    if count <= 1:
        return mask

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 55, 145)
    image_area = float(mask.shape[0] * mask.shape[1])
    candidates: list[tuple[float, np.ndarray]] = []

    for label in range(1, count):
        area = float(stats[label, cv2.CC_STAT_AREA])
        if area < 80:
            continue
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])
        bbox_area = float(max(1, w * h))
        bbox_fraction = bbox_area / image_area
        if bbox_fraction > 0.34:
            continue

        component = np.zeros(mask.shape, dtype=np.uint8)
        component[labels == label] = 255
        pixels = component > 0
        if not np.any(pixels):
            continue
        roi_overlap = 1.0
        if roi_mask is not None:
            roi_overlap = float(np.mean(roi_mask[pixels] > 0))
            if roi_overlap < 0.35:
                continue
        point_bonus = 0.0
        if point_px is not None:
            px, py = point_px
            if component[py, px] > 0:
                point_bonus = 1.2
            else:
                ys, xs = np.where(pixels)
                if xs.size:
                    min_dist = float(np.min((xs - px) ** 2 + (ys - py) ** 2) ** 0.5)
                    point_bonus = max(0.0, 0.55 - min_dist / max(mask.shape[:2]))

        hue = hsv[:, :, 0][pixels]
        sat = hsv[:, :, 1][pixels]
        val = hsv[:, :, 2][pixels]
        gold_ratio = float(np.mean((hue >= 5) & (hue <= 46) & (sat >= 22) & (val >= 45)))
        ref_overlap = float(np.mean(gold_reference[pixels] > 0)) if gold_reference is not None else gold_ratio
        if ref_overlap < 0.08 and gold_ratio < 0.12:
            continue
        mean_sat = float(np.mean(sat))
        edge_density = float(np.mean(edges[pixels] > 0))
        fill_ratio = float(np.count_nonzero(component) / bbox_area)
        size_score = min(1.0, max(0.0, area / (image_area * 0.035)))
        compact_penalty = 0.20 if fill_ratio > 0.96 and edge_density < 0.025 else 0.0
        score = (
            0.38 * gold_ratio
            + 0.22 * ref_overlap
            + 0.20 * min(1.0, mean_sat / 120.0)
            + 0.12 * min(1.0, edge_density / 0.12)
            + 0.08 * size_score
            + 0.45 * roi_overlap
            + point_bonus
            - compact_penalty
        )
        candidates.append((score, component))

    if not candidates:
        return np.zeros_like(mask)

    candidates.sort(key=lambda item: item[0], reverse=True)
    best_score, best = candidates[0]
    selected = best.copy()
    if point_px is None:
        for score, component in candidates[1:]:
            if score >= best_score * 0.72:
                selected = cv2.bitwise_or(selected, component)
    return _refine_mask(selected)


def _near_gold_regions(mask: np.ndarray) -> np.ndarray:
    return cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)), iterations=2)


def _refine_mask(mask: np.ndarray) -> np.ndarray:
    mask = (mask > 0).astype(np.uint8) * 255
    kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    kernel7 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel7, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel3, iterations=1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return np.zeros_like(mask)
    areas = stats[1:, cv2.CC_STAT_AREA]
    max_area = float(np.max(areas))
    cleaned = np.zeros_like(mask)
    for label in range(1, count):
        area = float(stats[label, cv2.CC_STAT_AREA])
        if area >= max(80.0, max_area * 0.04):
            cleaned[labels == label] = 255
    return cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel3, iterations=1)


def _contour_count(mask: np.ndarray) -> int:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return len([c for c in contours if cv2.contourArea(c) > 80])


def _mask_quality(mask: np.ndarray, shape: tuple[int, int], method_bonus: float) -> float:
    h, w = shape
    area_fraction = float(np.mean(mask > 0))
    thresholds = _config()["quality_thresholds"]
    if area_fraction < thresholds["min_mask_area_fraction"] or area_fraction > thresholds["max_mask_area_fraction"]:
        return 0.0
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0
    largest = max(contours, key=cv2.contourArea)
    perimeter = max(cv2.arcLength(largest, True), 1.0)
    area = cv2.contourArea(largest)
    compactness = min(1.0, 4.0 * math.pi * area / (perimeter * perimeter))
    x, y, bw, bh = cv2.boundingRect(largest)
    edge_penalty = 0.25 if min(x, y, w - x - bw, h - y - bh) < 4 else 0.0
    contour_penalty = min(0.25, max(0, len(contours) - 2) * 0.04)
    area_score = min(1.0, area_fraction * 9.0)
    return max(0.0, min(1.0, 0.46 * area_score + 0.34 * compactness + 0.20 + method_bonus - edge_penalty - contour_penalty))


def _segment_jewellery(
    img: np.ndarray,
    coin: CoinDetection,
    jewelry_point: Optional[dict[str, float]] = None,
    jewelry_bbox: Optional[dict[str, float]] = None,
) -> SegmentationResult:
    result = _segment_with_sam(img, coin)
    if result is None:
        result = _segment_with_opencv(img, coin, jewelry_point, jewelry_bbox)
    else:
        result = SegmentationResult(result.mask, result.method, _mask_quality(result.mask, img.shape[:2], 0.12), result.contour_count)

    if result.quality <= 0.05 or not np.any(result.mask > 0):
        raise WeightEstimationError(
            "segmentation_failed",
            "Could not isolate the jewellery from the background. Use a plain matte background and good lighting.",
            {"method": result.method, "quality": result.quality},
        )
    return result


@lru_cache(maxsize=1)
def _load_midas() -> Any:
    if os.getenv("WEIGHT_ENABLE_MIDAS", "0") != "1":
        return None
    try:
        import torch  # type: ignore
        model = torch.hub.load("intel-isl/MiDaS", "DPT_Large")
        transforms = torch.hub.load("intel-isl/MiDaS", "transforms")
        model.eval()
        return {"torch": torch, "model": model, "transform": transforms.dpt_transform}
    except Exception:
        return None


def _estimate_depth(img: np.ndarray, mask: np.ndarray) -> DepthResult:
    midas = _load_midas()
    if midas is not None:
        try:
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            inp = midas["transform"](rgb)
            with midas["torch"].no_grad():
                pred = midas["model"](inp)
                pred = midas["torch"].nn.functional.interpolate(
                    pred.unsqueeze(1),
                    size=img.shape[:2],
                    mode="bicubic",
                    align_corners=False,
                ).squeeze()
            depth = pred.cpu().numpy().astype(np.float32)
            depth = _normalize_depth(depth, mask)
            depth = cv2.bilateralFilter(depth, 7, 35, 35)
            return DepthResult(depth, "midas_dpt_large", _depth_consistency(depth, mask))
        except Exception as exc:
            raise WeightEstimationError("depth_estimation_failed", "MiDaS depth estimation failed.") from exc

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    distance = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    if float(distance.max()) <= 0.0:
        raise WeightEstimationError("depth_estimation_failed", "Depth proxy could not be computed from the mask.")
    distance = distance / float(distance.max())
    highlights = cv2.GaussianBlur(gray, (0, 0), 3)
    depth = 0.72 * distance + 0.28 * highlights
    depth = _normalize_depth(depth.astype(np.float32), mask)
    depth = cv2.bilateralFilter(depth, 7, 30, 30)
    return DepthResult(depth, "opencv_pseudo_depth", _depth_consistency(depth, mask))


def _normalize_depth(depth: np.ndarray, mask: np.ndarray) -> np.ndarray:
    values = depth[mask > 0]
    if values.size < 20:
        return np.zeros_like(depth, dtype=np.float32)
    lo, hi = np.percentile(values, [4, 96])
    if hi <= lo:
        return np.zeros_like(depth, dtype=np.float32)
    norm = (depth.astype(np.float32) - float(lo)) / float(hi - lo)
    return np.clip(norm, 0.0, 1.0).astype(np.float32)


def _depth_consistency(depth: np.ndarray, mask: np.ndarray) -> float:
    values = depth[mask > 0]
    if values.size < 20:
        return 0.0
    mean = float(np.mean(values))
    std = float(np.std(values))
    if mean <= 1e-4:
        return 0.0
    cv = std / mean
    return max(0.0, min(1.0, 1.0 - cv / 1.35))


def _extract_geometry(mask: np.ndarray, mm_per_pixel: float, requested_type: JewelryType) -> dict[str, Any]:
    contours_ext, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours_all, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if not contours_ext:
        raise WeightEstimationError("segmentation_failed", "No jewellery contour was found.")
    outer = max(contours_ext, key=cv2.contourArea)
    area_px = float(np.count_nonzero(mask))
    contour_area_px = float(cv2.contourArea(outer))
    x, y, w, h = cv2.boundingRect(outer)
    perimeter_px = float(cv2.arcLength(outer, True))
    circularity = 4.0 * math.pi * contour_area_px / (perimeter_px * perimeter_px + 1e-6)
    hole_area_px = 0.0
    if hierarchy is not None:
        hier = hierarchy[0]
        largest_index = max(range(len(contours_all)), key=lambda idx: cv2.contourArea(contours_all[idx]))
        for idx, meta in enumerate(hier):
            if int(meta[3]) == largest_index:
                hole_area_px += float(cv2.contourArea(contours_all[idx]))

    aspect_ratio = w / float(max(h, 1))
    hole_ratio = hole_area_px / max(hole_area_px + contour_area_px, 1.0)
    inferred_type = _infer_type(requested_type, circularity, aspect_ratio, hole_ratio, max(w, h) * mm_per_pixel)
    dimensions = {
        "width_mm": round(w * mm_per_pixel, 2),
        "height_mm": round(h * mm_per_pixel, 2),
        "projected_area_mm2": round(area_px * mm_per_pixel * mm_per_pixel, 2),
        "hole_area_mm2": round(hole_area_px * mm_per_pixel * mm_per_pixel, 2),
    }
    return {
        "type": inferred_type,
        "requested_type": requested_type,
        "bbox_px": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
        "area_px": area_px,
        "contour_area_px": contour_area_px,
        "hole_area_px": hole_area_px,
        "hole_ratio": round(hole_ratio, 4),
        "aspect_ratio": round(aspect_ratio, 4),
        "circularity": round(float(circularity), 4),
        "bbox_fill_ratio": round(float(area_px / max(w * h, 1)), 4),
        "dimensions": dimensions,
        "multiple_item_risk": _multiple_item_risk(contours_ext, contour_area_px),
    }


def _jewelry_material_features(img: np.ndarray, mask: np.ndarray) -> dict[str, float]:
    pixels = mask > 0
    if not np.any(pixels):
        return {
            "gold_hue_ratio": 0.0,
            "metallic_highlight_ratio": 0.0,
            "edge_density": 0.0,
            "mean_saturation": 0.0,
            "mean_value": 0.0,
        }

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0]
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gold_hue = ((hue >= 5) & (hue <= 46) & (sat >= 22) & (val >= 45))
    highlights = ((val >= 172) & (sat <= 105))
    edges = cv2.Canny(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 55, 145)
    mask_edge_band = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1) > 0

    return {
        "gold_hue_ratio": float(np.mean(gold_hue[pixels])),
        "metallic_highlight_ratio": float(np.mean(highlights[pixels])),
        "edge_density": float(np.mean(edges[mask_edge_band] > 0)) if np.any(mask_edge_band) else 0.0,
        "mean_saturation": float(np.mean(sat[pixels])),
        "mean_value": float(np.mean(val[pixels])),
    }


def _validate_jewelry_candidate(
    img: np.ndarray,
    mask: np.ndarray,
    geometry: dict[str, Any],
    vlm_validated: bool = False,
) -> dict[str, float]:
    features = _jewelry_material_features(img, mask)
    area_fraction = float(np.mean(mask > 0))
    width_mm = geometry["dimensions"]["width_mm"]
    height_mm = geometry["dimensions"]["height_mm"]
    type_name = geometry["type"]
    elongated_or_hollow = (
        type_name in {"ring", "bangle", "chain", "necklace", "bracelet"}
        or geometry["hole_ratio"] > 0.08
        or geometry["aspect_ratio"] > 2.2
        or geometry["aspect_ratio"] < 0.46
    )
    material_score = (
        0.46 * min(1.0, features["gold_hue_ratio"] / 0.44)
        + 0.24 * min(1.0, features["metallic_highlight_ratio"] / 0.16)
        + 0.18 * min(1.0, features["edge_density"] / 0.16)
        + 0.12 * (1.0 if elongated_or_hollow else 0.45)
    )
    features["jewelry_material_score"] = round(float(material_score), 4)
    features["area_fraction"] = round(area_fraction, 4)
    vlm_ring_override = vlm_validated and geometry["type"] == "ring"

    if area_fraction < _config()["quality_thresholds"]["min_mask_area_fraction"] and not vlm_ring_override:
        raise WeightEstimationError(
            "non_jewelry_photo",
            "No jewellery-like object was found beside the coin.",
            features,
        )
    if area_fraction > _config()["quality_thresholds"]["max_mask_area_fraction"]:
        raise WeightEstimationError(
            "non_jewelry_photo",
            "The detected object is too large or background-like to be treated as jewellery.",
            features,
        )
    if max(width_mm, height_mm) > 110 and geometry["type"] not in {"necklace", "chain"}:
        raise WeightEstimationError(
            "segmentation_failed",
            "Detected jewellery dimensions are implausibly large. Retake on a plain matte background with the coin and ornament separated.",
            {**features, "width_mm": width_mm, "height_mm": height_mm},
        )
    if geometry["type"] in {"necklace", "chain"} and max(width_mm, height_mm) > 160 and area_fraction < 0.18:
        raise WeightEstimationError(
            "segmentation_failed",
            "The mask appears to include background rather than only jewellery. Retake on a plain matte background.",
            {**features, "width_mm": width_mm, "height_mm": height_mm},
        )
    if material_score < 0.30 and not vlm_ring_override:
        raise WeightEstimationError(
            "non_jewelry_photo",
            "The object beside the coin does not look like gold jewellery. Use a clear photo of the ornament only.",
            features,
        )
    flat_low_detail = (
        geometry["bbox_fill_ratio"] > 0.78
        and geometry["hole_ratio"] < 0.03
        and features["edge_density"] < 0.04
        and features["metallic_highlight_ratio"] < 0.08
    )
    if flat_low_detail and not vlm_ring_override:
        raise WeightEstimationError(
            "non_jewelry_photo",
            "The detected object looks like a flat non-jewellery item, not an ornament.",
            {**features, "bbox_fill_ratio": geometry["bbox_fill_ratio"]},
        )
    return features


def _infer_type(requested_type: JewelryType, circularity: float, aspect_ratio: float, hole_ratio: float, max_dim_mm: float) -> str:
    if requested_type != "auto":
        return requested_type
    if hole_ratio > 0.12 and circularity > 0.16:
        return "bangle" if max_dim_mm > 48.0 else "ring"
    if circularity > 0.52 and max_dim_mm < 55.0:
        return "ring"
    if aspect_ratio > 2.45 or aspect_ratio < 0.41:
        return "chain"
    return "pendant"


def _multiple_item_risk(contours: list[np.ndarray], largest_area: float) -> float:
    significant = [cv2.contourArea(c) for c in contours if cv2.contourArea(c) > max(80.0, largest_area * 0.08)]
    if len(significant) <= 1:
        return 0.0
    return min(1.0, (len(significant) - 1) * 0.28)


def _profile_measurement(
    image_data_url: str,
    view: Literal["angle_45", "side"],
    fallback_mm_per_pixel: float,
    jewelry_bbox: Optional[dict[str, float]] = None,
    jewelry_point: Optional[dict[str, float]] = None,
) -> ProfileMeasurement:
    img = _decode_image_data_url(image_data_url)
    scale_source = "top_view_coin"
    mm_per_pixel = fallback_mm_per_pixel
    coin: Optional[CoinDetection] = None
    try:
        coin = _detect_rs10_coin(img)
        mm_per_pixel = float(_config()["reference_objects"]["rs10_coin"]["diameter_mm"]) / coin.diameter_px
        scale_source = f"{view}_coin"
    except WeightEstimationError:
        coin = None

    thickness_scale = _coin_thickness_scale_from_side_profile(img, coin)
    if thickness_scale is not None:
        mm_per_pixel = thickness_scale
        scale_source = f"{view}_coin_thickness"

    coin_mask = _coin_exclusion_mask(img.shape[:2], coin) if coin is not None else np.zeros(img.shape[:2], dtype=np.uint8)
    roi_mask = _bbox_to_mask(jewelry_bbox, img.shape[:2], pad_fraction=0.10)
    point_px = _point_to_pixel(jewelry_point or _bbox_center(jewelry_bbox), img.shape[:2])
    gold = _coin_calibrated_gold_mask(img, coin) if coin is not None else _gold_likelihood_mask(img)
    gold[coin_mask > 0] = 0
    if roi_mask is not None:
        gold = cv2.bitwise_and(gold, roi_mask)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 45, 135)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)
    edges[coin_mask > 0] = 0
    if roi_mask is not None:
        edges = cv2.bitwise_and(edges, roi_mask)
    seed = cv2.bitwise_or(gold, cv2.bitwise_and(edges, _near_gold_regions(gold)))
    if point_px is not None:
        local = _point_seed_mask(img.shape[:2], point_px, radius=max(8, int(min(img.shape[:2]) * 0.018)))
        seed = cv2.bitwise_or(seed, cv2.bitwise_and(edges, cv2.dilate(local, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)), iterations=1)))

    mask = _refine_mask(seed)
    mask = _select_jewelry_component(img, mask, gold, point_px, roi_mask)
    if np.count_nonzero(mask) < 30 and roi_mask is not None:
        mask = _refine_mask(roi_mask)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise WeightEstimationError(
            "profile_segmentation_failed",
            f"Could not isolate jewellery in the {view.replace('_', '-')} photo. Use a plain background and keep the coin visible.",
        )
    contour = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(contour)
    side_a, side_b = rect[1]
    short_px = max(1.0, min(float(side_a), float(side_b)))
    long_px = max(1.0, max(float(side_a), float(side_b)))
    raw_thickness_mm = short_px * mm_per_pixel
    width_mm = long_px * mm_per_pixel

    if view == "side":
        thickness_mm = max(0.45, min(5.0, raw_thickness_mm * 0.92))
    else:
        thickness_mm = max(0.45, min(5.0, raw_thickness_mm * 0.62))
    if roi_mask is not None:
        x, y, w, h = cv2.boundingRect(contour)
        roi_overlap = float(np.mean(roi_mask[y:y + h, x:x + w] > 0)) if w > 0 and h > 0 else 0.0
    else:
        roi_overlap = 0.55
    quality = _mask_quality(mask, img.shape[:2], 0.08)
    confidence = max(0.18, min(0.96, 0.50 * quality + 0.30 * roi_overlap + 0.20 * (1.0 if scale_source != "top_view_coin" else 0.65)))
    return ProfileMeasurement(
        thickness_mm=round(float(thickness_mm), 2),
        width_mm=round(float(width_mm), 2),
        confidence=round(float(confidence), 3),
        method="gemini_roi_profile_mask",
        view=view,
        scale_source=scale_source,
    )


def _coin_thickness_scale_from_side_profile(img: np.ndarray, coin: Optional[CoinDetection]) -> Optional[float]:
    if coin is None:
        return None

    ref = _config()["reference_objects"]["rs10_coin"]
    known_diameter_mm = float(ref["diameter_mm"])
    known_thickness_mm = float(ref.get("thickness_mm", 1.8))
    h, w = img.shape[:2]
    cx, cy = coin.center
    r = int(round(coin.radius_px))
    x0 = max(0, cx - int(r * 1.35))
    x1 = min(w, cx + int(r * 1.35))
    y0 = max(0, cy - int(r * 1.35))
    y1 = min(h, cy + int(r * 1.35))
    if x1 <= x0 or y1 <= y0:
        return None

    crop = img[y0:y1, x0:x1]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    coin_like = (
        ((hsv[:, :, 1] > 18) & (hsv[:, :, 2] > 35))
        | ((gray > 60) & (gray < 230))
    ).astype(np.uint8) * 255
    coin_like = cv2.morphologyEx(
        coin_like,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )
    contours, _ = cv2.findContours(coin_like, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    best: Optional[tuple[float, float, float]] = None
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < max(20.0, (r * r) * 0.015):
            continue
        rect = cv2.minAreaRect(contour)
        side_a, side_b = rect[1]
        short_px = max(1.0, min(float(side_a), float(side_b)))
        long_px = max(1.0, max(float(side_a), float(side_b)))
        aspect = long_px / short_px
        if best is None or area > best[0]:
            best = (float(area), short_px, aspect)

    if best is None:
        return None

    _, short_px, aspect = best
    diameter_px = coin.diameter_px
    expected_thickness_px = diameter_px * (known_thickness_mm / known_diameter_mm)
    is_edge_on = aspect >= 5.2 and short_px <= diameter_px * 0.14
    plausible = expected_thickness_px * 0.55 <= short_px <= expected_thickness_px * 2.4
    if not (is_edge_on and plausible):
        return None

    return known_thickness_mm / short_px


def _combine_profile_thickness(side: ProfileMeasurement, angle: ProfileMeasurement) -> ProfileMeasurement:
    if side.confidence >= 0.32:
        blended = 0.78 * side.thickness_mm + 0.22 * angle.thickness_mm
        return ProfileMeasurement(
            thickness_mm=round(float(blended), 2),
            width_mm=side.width_mm,
            confidence=round(min(0.98, 0.74 * side.confidence + 0.26 * angle.confidence), 3),
            method="side_profile_with_45deg_check",
            view="side",
            scale_source=side.scale_source,
        )
    return angle


def _clamp_float(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _ring_minor_radius_mm(
    major_radius_mm: float,
    band_width_mm: float,
    measured_thickness_mm: Optional[float],
    measured_thickness_source: Optional[str],
) -> tuple[float, dict[str, Any]]:
    band_radius = _clamp_float(band_width_mm * 0.60, 0.45, 1.35)
    diameter_prior_radius = _clamp_float(major_radius_mm * 0.061, 0.62, 1.18)

    candidates: list[tuple[str, float, float]] = [
        ("top_band", band_radius, 0.72),
        ("diameter_prior", diameter_prior_radius, 0.28),
    ]

    profile_radius: Optional[float] = None
    profile_weight = 0.0
    if measured_thickness_mm is not None:
        measured = float(measured_thickness_mm)
        direct_coin_scaled = measured_thickness_source is not None and measured_thickness_source.endswith("_coin_thickness")
        if direct_coin_scaled and 0.75 <= measured <= 3.0:
            profile_radius = _clamp_float(measured / 2.0, 0.45, 1.5)
            profile_weight = 1.25
        elif 0.75 <= measured <= 2.65:
            profile_radius = _clamp_float(measured / 2.0, 0.45, 1.32)
            profile_weight = 0.38

    if profile_radius is not None and profile_weight > 0:
        candidates.append(("profile", profile_radius, profile_weight))

    total_weight = sum(weight for _, _, weight in candidates)
    radius = sum(value * weight for _, value, weight in candidates) / max(total_weight, 1e-6)
    radius = _clamp_float(radius, 0.45, 1.35)
    return radius, {
        "candidates": [
            {"source": source, "minor_radius_mm": round(value, 3), "weight": round(weight, 3)}
            for source, value, weight in candidates
        ],
        "selected_minor_radius_mm": round(radius, 3),
    }


def _volume_cm3(
    geometry: dict[str, Any],
    depth: np.ndarray,
    mask: np.ndarray,
    mm_per_pixel: float,
    measured_thickness_mm: Optional[float] = None,
    measured_thickness_source: Optional[str] = None,
) -> tuple[float, float, dict[str, Any]]:
    cfg = _config()["type_coefficients"][geometry["type"]]
    area_mm2 = geometry["area_px"] * mm_per_pixel * mm_per_pixel
    depth_values = depth[mask > 0]
    if depth_values.size == 0:
        raise WeightEstimationError("depth_estimation_failed", "Depth map has no jewellery pixels.")

    bbox = geometry["bbox_px"]
    width_mm = bbox["width"] * mm_per_pixel
    height_mm = bbox["height"] * mm_per_pixel
    min_dim_mm = max(0.1, min(width_mm, height_mm))
    mean_depth = float(np.mean(depth_values))
    p90_depth = float(np.percentile(depth_values, 90))
    base_thickness_mm = _base_thickness_mm(geometry["type"], min_dim_mm, width_mm, height_mm)
    estimated_depth_mm = max(0.35, base_thickness_mm * (0.58 + 0.74 * p90_depth) * cfg["depth_scale"])
    if measured_thickness_mm is not None and geometry["type"] not in {"ring", "bangle"}:
        estimated_depth_mm = max(0.35, min(7.0, float(measured_thickness_mm)))

    if geometry["type"] in {"ring", "bangle"}:
        if geometry["hole_ratio"] > 0.08:
            outer_area_mm2 = (geometry["contour_area_px"] + geometry["hole_area_px"]) * mm_per_pixel * mm_per_pixel
            inner_area_mm2 = geometry["hole_area_px"] * mm_per_pixel * mm_per_pixel
            outer_r = math.sqrt(max(outer_area_mm2, 1e-6) / math.pi)
            inner_r = math.sqrt(max(inner_area_mm2, 1e-6) / math.pi)
            major_r = max(0.2, (outer_r + inner_r) / 2.0)
        else:
            outer_r = max(width_mm, height_mm) / 2.0
            inner_r = max(0.2, outer_r - max(1.6, min(width_mm, height_mm) * 0.08))
            major_r = max(0.2, (outer_r + inner_r) / 2.0)
        distance = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
        band_half_width_px = float(np.percentile(distance[mask > 0], 75)) if np.any(mask > 0) else 1.0
        band_width_mm = max(0.6, 2.0 * band_half_width_px * mm_per_pixel)
        if geometry["type"] == "ring":
            minor_r, cross_section_debug = _ring_minor_radius_mm(
                major_r,
                band_width_mm,
                measured_thickness_mm,
                measured_thickness_source,
            )
        else:
            cross_section_debug = {}
            if measured_thickness_mm is not None:
                minor_r = max(0.45, min(2.75, min(float(measured_thickness_mm) / 2.0, band_width_mm * 0.72)))
            else:
                minor_r = max(0.45, min(2.25, band_width_mm * 0.44))
        estimated_depth_mm = max(0.7, 2.0 * minor_r)
        volume_mm3 = 2.0 * (math.pi ** 2) * major_r * (minor_r ** 2)
        volume_mm3 *= cfg["solidness"]
        return volume_mm3 / 1000.0, estimated_depth_mm, {
            "model": "torus",
            "major_radius_mm": round(float(major_r), 3),
            "minor_radius_mm": round(float(minor_r), 3),
            "effective_thickness_mm": round(float(estimated_depth_mm), 3),
            "band_width_mm": round(float(band_width_mm), 3),
            "profile_input_mm": round(float(measured_thickness_mm), 3) if measured_thickness_mm is not None else None,
            "profile_source": measured_thickness_source,
            "cross_section": cross_section_debug,
            "solidness": round(float(cfg["solidness"]), 3),
        }

    pixel_area_mm2 = mm_per_pixel * mm_per_pixel
    local_depth_mm = np.maximum(0.25, estimated_depth_mm * (0.42 + 0.92 * depth_values))
    volume_mm3 = float(np.sum(pixel_area_mm2 * local_depth_mm)) * cfg["solidness"]

    if geometry["type"] in {"chain", "necklace", "bracelet"}:
        volume_mm3 *= 0.84 + 0.28 * mean_depth
    elif geometry["type"] == "pendant":
        volume_mm3 *= 0.92
    return volume_mm3 / 1000.0, estimated_depth_mm, {
        "model": "depth_weighted_area",
        "effective_thickness_mm": round(float(estimated_depth_mm), 3),
        "profile_input_mm": round(float(measured_thickness_mm), 3) if measured_thickness_mm is not None else None,
        "solidness": round(float(cfg["solidness"]), 3),
    }


def _base_thickness_mm(jewelry_type: str, min_dim_mm: float, width_mm: float, height_mm: float) -> float:
    if jewelry_type == "ring":
        return max(1.1, min_dim_mm * 0.18)
    if jewelry_type == "bangle":
        return max(1.4, min_dim_mm * 0.12)
    if jewelry_type == "chain":
        return max(0.6, min(min_dim_mm * 0.16, 3.2))
    if jewelry_type == "necklace":
        return max(0.8, min(min_dim_mm * 0.12, 4.0))
    if jewelry_type == "bracelet":
        return max(0.8, min(min_dim_mm * 0.14, 4.2))
    if jewelry_type == "pendant":
        return max(0.7, min(min_dim_mm * 0.10, 5.5))
    return max(0.7, min(min_dim_mm * 0.12, 5.0))


def _visualizations(img: np.ndarray, mask: np.ndarray, depth: np.ndarray, coin: CoinDetection) -> dict[str, str]:
    overlay = img.copy()
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(overlay, contours, -1, (0, 210, 255), 3)
    cv2.circle(overlay, coin.center, int(coin.radius_px), (50, 220, 80), 3)
    cv2.putText(overlay, "Rs 10 coin: 27 mm", (max(4, coin.center[0] - 80), max(18, coin.center[1] - int(coin.radius_px) - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (40, 180, 70), 2, cv2.LINE_AA)

    mask_vis = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    mask_vis[:, :, 1] = np.maximum(mask_vis[:, :, 1], mask)
    depth_u8 = np.clip(depth * 255.0, 0, 255).astype(np.uint8)
    depth_color = cv2.applyColorMap(depth_u8, cv2.COLORMAP_TURBO)
    depth_color[mask == 0] = (20, 20, 20)
    return {
        "segmentation_mask": _encode_png_data_url(mask_vis),
        "depth_map": _encode_png_data_url(depth_color),
        "contour_overlay": _encode_png_data_url(overlay),
        "scale_visualization": _encode_png_data_url(overlay),
    }


def _mask_preview(
    img: np.ndarray,
    mask: np.ndarray,
    coin: CoinDetection,
    jewelry_bbox: Optional[dict[str, float]] = None,
) -> dict[str, str]:
    mask_vis = img.copy()
    green = np.zeros_like(mask_vis)
    green[:, :, 1] = 255
    measured = mask > 0
    mask_vis[measured] = cv2.addWeighted(mask_vis, 0.35, green, 0.65, 0)[measured]

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(mask_vis, contours, -1, (0, 255, 0), 2)

    # Red marks the excluded reference coin region. It is intentionally not measured.
    cv2.circle(mask_vis, coin.center, int(coin.radius_px * 1.35), (0, 0, 255), 2)
    roi_mask = _bbox_to_mask(jewelry_bbox, mask.shape[:2], pad_fraction=0.0)
    if roi_mask is not None:
        contours, _ = cv2.findContours(roi_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(mask_vis, contours, -1, (255, 128, 0), 2)
    cv2.putText(mask_vis, "green=measured jewellery", (12, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (0, 130, 0), 2, cv2.LINE_AA)
    cv2.putText(mask_vis, "red=excluded coin", (12, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (0, 0, 180), 2, cv2.LINE_AA)
    cv2.putText(mask_vis, "blue=VLM ROI", (12, 76), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (180, 90, 0), 2, cv2.LINE_AA)
    return {"segmentation_mask": _encode_png_data_url(mask_vis, max_side=480)}


def _confidence(
    segmentation: SegmentationResult,
    coin: CoinDetection,
    quality: ImageQuality,
    depth: DepthResult,
    geometry: dict[str, Any],
) -> tuple[float, dict[str, float]]:
    cfg = _config()["type_coefficients"][geometry["type"]]
    components = {
        "segmentation_quality": segmentation.quality,
        "reference_detection": coin.confidence,
        "image_sharpness": quality.sharpness_score,
        "lighting": quality.brightness_score,
        "depth_consistency": depth.consistency,
        "geometry_prior": float(cfg["confidence_prior"]),
    }
    score = (
        0.25 * components["segmentation_quality"]
        + 0.22 * components["reference_detection"]
        + 0.18 * components["image_sharpness"]
        + 0.12 * components["lighting"]
        + 0.16 * components["depth_consistency"]
        + 0.07 * components["geometry_prior"]
    )
    score -= 0.18 * geometry["multiple_item_risk"]
    return round(max(0.0, min(1.0, score)), 3), {k: round(v, 3) for k, v in components.items()}


def estimate_weight_from_image(
    image_data_url: str,
    image_45_data_url: str,
    side_image_data_url: str,
    jewelry_type: JewelryType,
    karat: Karat,
    reference_object: str = "rs10_coin",
    include_visualizations: bool = True,
    include_mask_preview: bool = False,
    jewelry_point: Optional[dict[str, float]] = None,
    jewelry_bbox: Optional[dict[str, float]] = None,
    angle_jewelry_point: Optional[dict[str, float]] = None,
    angle_jewelry_bbox: Optional[dict[str, float]] = None,
    side_jewelry_point: Optional[dict[str, float]] = None,
    side_jewelry_bbox: Optional[dict[str, float]] = None,
    vlm_validated: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    cfg = _config()
    if reference_object != "rs10_coin":
        raise WeightEstimationError("unsupported_reference_object", "Only Rs 10 coin scaling is currently supported.")
    img = _decode_image_data_url(image_data_url)
    quality = _image_quality(img)
    quality_issues = _validate_quality(quality)
    logger.info("Weight stage decode_quality complete in %.2fs", time.perf_counter() - started)

    coin = _detect_rs10_coin(img)
    ref = cfg["reference_objects"]["rs10_coin"]
    mm_per_pixel = float(ref["diameter_mm"]) / coin.diameter_px
    logger.info(
        "Weight stage top_coin_scale complete in %.2fs coin_diameter_px=%.2f mm_per_pixel=%.5f",
        time.perf_counter() - started,
        coin.diameter_px,
        mm_per_pixel,
    )
    ring_mask = None
    if jewelry_type == "ring" and jewelry_bbox and vlm_validated:
        ring_mask = _ring_annulus_mask_from_bbox(img.shape[:2], jewelry_bbox)
    if ring_mask is not None and np.count_nonzero(ring_mask) > 50:
        segmentation = SegmentationResult(
            ring_mask,
            "vlm_roi_ring_annulus",
            0.78,
            _contour_count(ring_mask),
        )
    else:
        segmentation = _segment_jewellery(img, coin, jewelry_point, jewelry_bbox)
    if jewelry_type == "ring" and jewelry_bbox and segmentation.method != "vlm_roi_ring_annulus":
        ring_mask = _ring_annulus_mask_from_bbox(img.shape[:2], jewelry_bbox)
        if ring_mask is not None and np.count_nonzero(ring_mask) > 50:
            segmentation = SegmentationResult(
                ring_mask,
                "vlm_roi_ring_annulus",
                max(segmentation.quality, 0.72),
                _contour_count(ring_mask),
            )
    logger.info(
        "Weight stage segmentation complete in %.2fs method=%s quality=%.3f pixels=%d",
        time.perf_counter() - started,
        segmentation.method,
        segmentation.quality,
        int(np.count_nonzero(segmentation.mask)),
    )
    depth = _estimate_depth(img, segmentation.mask)
    geometry = _extract_geometry(segmentation.mask, mm_per_pixel, jewelry_type)
    material_features = _validate_jewelry_candidate(img, segmentation.mask, geometry, vlm_validated)
    logger.info(
        "Weight stage geometry_depth complete in %.2fs type=%s width=%.2f height=%.2f depth_method=%s",
        time.perf_counter() - started,
        geometry["type"],
        geometry["dimensions"]["width_mm"],
        geometry["dimensions"]["height_mm"],
        depth.method,
    )
    angle_profile = _profile_measurement(
        image_45_data_url,
        "angle_45",
        mm_per_pixel,
        angle_jewelry_bbox,
        angle_jewelry_point,
    )
    side_profile = _profile_measurement(
        side_image_data_url,
        "side",
        mm_per_pixel,
        side_jewelry_bbox,
        side_jewelry_point,
    )
    profile = _combine_profile_thickness(side_profile, angle_profile)
    logger.info(
        "Weight stage profile complete in %.2fs side=%.2f angle=%.2f selected=%.2f source=%s",
        time.perf_counter() - started,
        side_profile.thickness_mm,
        angle_profile.thickness_mm,
        profile.thickness_mm,
        profile.scale_source,
    )
    volume_cm3, estimated_depth_mm, volume_model = _volume_cm3(
        geometry,
        depth.depth,
        segmentation.mask,
        mm_per_pixel,
        measured_thickness_mm=profile.thickness_mm,
        measured_thickness_source=profile.scale_source,
    )
    density = float(cfg["densities_g_cm3"][str(karat)])
    estimated_weight_g = volume_cm3 * density
    confidence, components = _confidence(segmentation, coin, quality, depth, geometry)
    logger.info(
        "Weight stage physics complete in %.2fs volume=%.4f weight=%.2f confidence=%.3f",
        time.perf_counter() - started,
        volume_cm3,
        estimated_weight_g,
        confidence,
    )

    issues = list(quality_issues)
    if geometry["multiple_item_risk"] > 0.25:
        issues.append("multiple_jewelry_items_possible")
    if segmentation.quality < 0.35:
        issues.append("low_segmentation_quality")
    if depth.consistency < 0.32:
        issues.append("low_depth_consistency")

    band_pct = 0.16 + (1.0 - confidence) * 0.42
    low = max(0.01, estimated_weight_g * (1.0 - band_pct))
    high = estimated_weight_g * (1.0 + band_pct)

    response = {
        "ok": True,
        "jewelry_type": geometry["type"],
        "requested_jewelry_type": jewelry_type,
        "karat": karat,
        "reference_object": reference_object,
        "scale": {
            "mm_per_pixel": round(mm_per_pixel, 5),
            "pixels_per_mm": round(1.0 / mm_per_pixel, 3),
            "coin_diameter_px": round(coin.diameter_px, 2),
            "coin_confidence": round(coin.confidence, 3),
        },
        "dimensions": {
            **geometry["dimensions"],
            "estimated_depth_mm": round(estimated_depth_mm, 2),
            "thickness_source": profile.method,
        },
        "geometry": {
            "hole_ratio": geometry["hole_ratio"],
            "aspect_ratio": geometry["aspect_ratio"],
            "circularity": geometry["circularity"],
            "bbox_fill_ratio": geometry["bbox_fill_ratio"],
            "multiple_item_risk": round(geometry["multiple_item_risk"], 3),
            "segmentation_method": segmentation.method,
            "depth_method": depth.method,
            "contour_count": segmentation.contour_count,
            "volume_model": volume_model,
            "material": {k: round(v, 3) for k, v in material_features.items()},
            "profile_measurement": {
                "thickness_mm": profile.thickness_mm,
                "width_mm": profile.width_mm,
                "confidence": profile.confidence,
                "method": profile.method,
                "view": profile.view,
                "scale_source": profile.scale_source,
                "side_thickness_mm": side_profile.thickness_mm,
                "angle_45_thickness_mm": angle_profile.thickness_mm,
            },
        },
        "physics": {
            "density_g_cm3": density,
            "volume_cm3": round(volume_cm3, 4),
            "formula": "mass_g = density_g_cm3 * volume_cm3",
        },
        "weight": {
            "estimated_g": round(estimated_weight_g, 2),
            "low_g": round(low, 2),
            "high_g": round(high, 2),
        },
        "confidence": {
            "score": confidence,
            "components": components,
            "issues": sorted(set(issues)),
        },
        "visualizations": {},
    }
    if include_visualizations:
        response["visualizations"] = _visualizations(img, segmentation.mask, depth.depth, coin)
    elif include_mask_preview:
        response["visualizations"] = _mask_preview(img, segmentation.mask, coin, jewelry_bbox)
    logger.info("Weight response ready in %.2fs", time.perf_counter() - started)
    return response
