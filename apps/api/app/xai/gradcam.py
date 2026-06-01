"""
Layer 1 XAI: targeted visual heatmap for jewellery assessment.

The old implementation fell back to a center Gaussian whenever model/AI saliency
was unavailable. That made every Grad-CAM look confident but wrong. This module
now prefers visible evidence regions: HUID / BIS / purity marks, engraved text,
and high-detail jewellery regions. Model Score-CAM is kept only as a final
fallback when the image has no local targetable evidence.
"""
import base64
import logging
from dataclasses import dataclass
from typing import Optional, Any

import numpy as np

logger = logging.getLogger("goldeye.xai.gradcam")

_MIN_REGION_SCORE = 0.16
_MAX_FOCUS_REGIONS = 5


@dataclass(frozen=True)
class FocusRegion:
    label: str
    x: float
    y: float
    radius: float
    score: float


async def generate_gradcam_url(
    frame_url: str,
    session_id: str,
    model=None,
    s1_payload: Optional[dict[str, Any]] = None,
    frame_type: Optional[str] = None,
) -> Optional[str]:
    """
    Generate a targeted heatmap for the given frame.
    Returns base64 JPEG data URI, or None if the frame is unavailable.
    """
    if not frame_url or frame_url.startswith("local://"):
        return None

    try:
        import cv2

        raw = await _fetch_frame_bytes(frame_url)
        if raw is None:
            return None

        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None

        regions = _detect_local_focus_regions(img, s1_payload=s1_payload, frame_type=frame_type)
        if not regions:
            regions = await _generate_ai_focus_regions(img, frame_url, session_id)

        overlay = _render_focus_overlay(img, regions)
        if overlay is None:
            # Last resort is model saliency, never a fake center blob.
            try:
                from app.data.convnext import score_cam_lite
                overlay = score_cam_lite(img, grid=7)
            except Exception as model_err:
                logger.debug(f"[{session_id}] Score-CAM fallback skipped: {model_err}")

        if overlay is None:
            logger.info(f"[{session_id}] no Grad-CAM target found for frame")
            return None

        _, buf = cv2.imencode(".jpg", overlay, [cv2.IMWRITE_JPEG_QUALITY, 80])
        b64 = base64.b64encode(buf.tobytes()).decode()
        return f"data:image/jpeg;base64,{b64}"

    except Exception as e:
        logger.warning(f"[{session_id}] gradcam generation failed: {e}")
        return None


async def _fetch_frame_bytes(frame_url: str) -> Optional[bytes]:
    """Decode data URLs locally; defer network URLs to the shared fetcher."""
    if frame_url.startswith("data:"):
        try:
            _, encoded = frame_url.split(",", 1)
            return base64.b64decode(encoded)
        except Exception:
            return None

    if frame_url.startswith("http://") or frame_url.startswith("https://"):
        from app.data.image_utils import fetch_image_bytes
        return await fetch_image_bytes(frame_url)

    return None


def _odd(value: int) -> int:
    value = max(3, int(value))
    return value if value % 2 else value + 1


def _clamp_bbox(x: int, y: int, w: int, h: int, width: int, height: int) -> tuple[int, int, int, int]:
    x1 = max(0, min(width - 1, int(x)))
    y1 = max(0, min(height - 1, int(y)))
    x2 = max(x1 + 1, min(width, int(x + w)))
    y2 = max(y1 + 1, min(height, int(y + h)))
    return x1, y1, x2 - x1, y2 - y1


def _region_from_bbox(label: str, bbox: tuple[int, int, int, int], score: float) -> FocusRegion:
    x, y, w, h = bbox
    return FocusRegion(
        label=label,
        x=float(x + w / 2),
        y=float(y + h / 2),
        radius=float(max(w, h) * 0.82),
        score=float(max(0.0, min(1.0, score))),
    )


def _is_macro_like_frame(frame_type: Optional[str]) -> bool:
    label = (frame_type or "").strip().lower().replace("_", "-")
    return label in {"macro", "hallmark", "huid", "closeup", "close-up", "stamp"}


def _gold_context_mask(img: np.ndarray) -> np.ndarray:
    import cv2

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    warm = cv2.inRange(hsv, np.array([4, 24, 35]), np.array([48, 255, 255]))
    bright_warm = cv2.inRange(hsv, np.array([8, 12, 90]), np.array([44, 190, 255]))
    mask = cv2.bitwise_or(warm, bright_warm)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    return mask


def _valid_coin_for_mask(coin: Optional[dict], width: int, height: int) -> bool:
    if not coin:
        return False
    radius = float(coin.get("radius_px") or 0.0)
    confidence = float(coin.get("confidence") or 0.0)
    min_dim = float(max(1, min(width, height)))
    if confidence < 0.58:
        return False
    # Hough sometimes locks onto the ring/body shadow as a huge circle. A real
    # scale coin in these capture views is visible, but not half the frame.
    return min_dim * 0.035 <= radius <= min_dim * 0.18


def _detect_jewellery_focus_regions(img: np.ndarray) -> list[FocusRegion]:
    """Find the actual ornament while suppressing the Rs 10 coin reference."""
    import cv2

    h, w = img.shape[:2]
    img_area = float(max(1, h * w))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    strong_gold = cv2.inRange(hsv, np.array([5, 54, 32]), np.array([54, 255, 255]))
    soft_gold = cv2.inRange(hsv, np.array([5, 34, 64]), np.array([56, 255, 255]))
    near_strong = cv2.dilate(
        strong_gold,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(min(w, h) // 28), _odd(min(w, h) // 28))),
        iterations=1,
    )
    mask = cv2.bitwise_or(strong_gold, cv2.bitwise_and(soft_gold, near_strong))

    coin = None
    try:
        from app.data.image_utils import detect_coin_hough

        candidate = detect_coin_hough(img, "rs10_coin")
        if _valid_coin_for_mask(candidate, w, h):
            coin = candidate
            cx, cy = coin["center"]
            radius = int(float(coin["radius_px"]) * 1.22)
            cv2.circle(mask, (int(cx), int(cy)), max(4, radius), 0, -1)
    except Exception as coin_err:
        logger.debug(f"coin suppression skipped for Grad-CAM: {coin_err}")

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)

    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(gray)
    edges = cv2.Canny(clahe, 50, 150)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions: list[FocusRegion] = []
    for cnt in contours:
        area = float(cv2.contourArea(cnt))
        if area < img_area * 0.00035 or area > img_area * 0.16:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        if bw < max(12, w * 0.025) or bh < max(12, h * 0.025):
            continue
        if bw > w * 0.68 or bh > h * 0.68:
            continue

        touches_edge = x <= 2 or y <= 2 or x + bw >= w - 2 or y + bh >= h - 2
        if touches_edge and area > img_area * 0.003:
            continue

        crop_mask = mask[y:y + bh, x:x + bw]
        crop_edges = edges[y:y + bh, x:x + bw]
        gold_density = float(np.mean(crop_mask > 0))
        edge_density = float(np.mean(crop_edges > 0))
        if gold_density < 0.06:
            continue

        aspect = bw / max(bh, 1)
        coin_like_disk = aspect > 1.85 and gold_density > 0.62 and edge_density < 0.04
        if coin_like_disk:
            continue
        shape_score = 1.0 - min(1.0, abs(np.log(max(aspect, 1e-3))) / 2.1)
        area_score = min(1.0, area / (img_area * 0.028))
        score = (
            area_score * 0.34
            + min(1.0, gold_density * 2.0) * 0.28
            + min(1.0, edge_density * 8.0) * 0.22
            + shape_score * 0.16
        )

        if coin:
            cx, cy = coin["center"]
            distance = float(np.hypot((x + bw / 2) - cx, (y + bh / 2) - cy))
            score += min(0.12, max(0.0, distance / max(w, h) * 0.18))

        if score < 0.28:
            continue

        radius = max(20.0, max(bw, bh) * 0.46)
        regions.append(FocusRegion(
            label="jewellery_focus",
            x=float(x + bw / 2),
            y=float(y + bh / 2),
            radius=float(radius),
            score=float(max(0.35, min(0.88, score))),
        ))

    return _dedupe_regions(regions)[:1]


def _dedupe_regions(regions: list[FocusRegion]) -> list[FocusRegion]:
    kept: list[FocusRegion] = []
    for region in sorted(regions, key=lambda r: r.score, reverse=True):
        duplicate = False
        for existing in kept:
            dist = float(np.hypot(region.x - existing.x, region.y - existing.y))
            if dist < max(region.radius, existing.radius) * 0.55:
                duplicate = True
                break
        if not duplicate:
            kept.append(region)
        if len(kept) >= _MAX_FOCUS_REGIONS:
            break
    return kept


def _detect_local_focus_regions(
    img: np.ndarray,
    s1_payload: Optional[dict[str, Any]] = None,
    frame_type: Optional[str] = None,
) -> list[FocusRegion]:
    """
    Locate visible explanation targets without network calls.

    Priority:
    1. BIS/HUID/purity stamp region if OpenCV can find it.
    2. Text-like engraved/stamped high-frequency regions on warm metal.
    3. Highest-detail region inside the detected jewellery bbox.
    """
    import cv2
    h, w = img.shape[:2]
    img_area = float(max(1, h * w))
    regions: list[FocusRegion] = []
    gold_mask = _gold_context_mask(img)
    macro_like = _is_macro_like_frame(frame_type)
    jewellery_regions = _detect_jewellery_focus_regions(img)

    # In full-view captures the UX expectation is "show me the item you assessed",
    # not the scale coin or a tiny texture speck. Prefer a broad ornament focus.
    if not macro_like and jewellery_regions:
        return jewellery_regions

    payload_bbox = (s1_payload or {}).get("bis_logo_bbox") or (s1_payload or {}).get("hallmark_bbox")
    if macro_like and isinstance(payload_bbox, (list, tuple)) and len(payload_bbox) == 4:
        try:
            bbox = _clamp_bbox(*(int(v) for v in payload_bbox), w, h)
            regions.append(_region_from_bbox("hallmark", bbox, 0.92))
        except Exception:
            pass

    if macro_like:
        try:
            from app.data.huid_detector import detect_bis_logo

            bis = detect_bis_logo(img)
            if bis.get("found") and bis.get("bbox"):
                bbox = _clamp_bbox(*bis["bbox"], w, h)
                _, _, bw, bh = bbox
                bbox_fraction = (bw * bh) / img_area
                if 0.0001 <= bbox_fraction <= 0.045:
                    regions.append(_region_from_bbox("bis_logo", bbox, 0.86 + float(bis.get("confidence", 0.0)) * 0.12))
        except Exception as bis_err:
            logger.debug(f"local BIS focus detection skipped: {bis_err}")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.4, tileGridSize=(8, 8)).apply(gray)
    text_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (_odd(w // 42), _odd(h // 115)))
    blackhat = cv2.morphologyEx(clahe, cv2.MORPH_BLACKHAT, text_kernel)
    tophat = cv2.morphologyEx(clahe, cv2.MORPH_TOPHAT, text_kernel)
    grad_x = cv2.Sobel(clahe, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(clahe, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.normalize(cv2.magnitude(grad_x, grad_y), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    detail = cv2.addWeighted(blackhat, 0.46, tophat, 0.34, 0)
    detail = cv2.addWeighted(detail, 0.78, gradient, 0.22, 0)
    percentile = max(70, float(np.percentile(detail, 92)))
    _, detail_mask = cv2.threshold(detail, percentile, 255, cv2.THRESH_BINARY)
    detail_mask = cv2.morphologyEx(
        detail_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (_odd(w // 70), _odd(h // 135))),
        iterations=1,
    )
    detail_mask = cv2.dilate(
        detail_mask,
        cv2.getStructuringElement(cv2.MORPH_RECT, (_odd(w // 130), _odd(h // 180))),
        iterations=1,
    )

    edges = cv2.Canny(clahe, 60, 155)
    contours, _ = cv2.findContours(detail_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        area = float(cw * ch)
        if area < img_area * 0.00006 or area > img_area * 0.12:
            continue
        aspect = cw / max(ch, 1)
        if aspect < 0.18 or aspect > 14.0:
            continue
        if cw < max(5, w * 0.012) or ch < max(4, h * 0.008):
            continue

        margin = int(max(cw, ch) * 0.45)
        ex, ey, ew, eh = _clamp_bbox(x - margin, y - margin, cw + 2 * margin, ch + 2 * margin, w, h)
        crop_detail = detail[y:y + ch, x:x + cw]
        crop_edges = edges[y:y + ch, x:x + cw]
        crop_gold = gold_mask[ey:ey + eh, ex:ex + ew]
        detail_score = float(np.mean(crop_detail) / 255.0)
        edge_density = float(np.mean(crop_edges > 0))
        stroke_density = float(np.mean(detail_mask[y:y + ch, x:x + cw] > 0))
        gold_context = float(np.mean(crop_gold > 0))

        # Text/stamp marks are high-frequency, compact, and usually sit on/near gold.
        score = (
            min(1.0, detail_score * 2.2) * 0.38
            + min(1.0, edge_density * 7.0) * 0.24
            + min(1.0, stroke_density * 5.0) * 0.18
            + gold_context * 0.20
        )
        if score >= _MIN_REGION_SCORE:
            label = "huid_or_purity_mark" if aspect > 1.15 else "hallmark_detail"
            regions.append(_region_from_bbox(label, (x, y, cw, ch), score))

    if not regions and jewellery_regions:
        regions.extend(jewellery_regions)

    if not regions:
        try:
            from app.data.image_utils import estimate_jewelry_bbox_px

            bbox = estimate_jewelry_bbox_px(img)
            if bbox:
                x = int(bbox["x_px"])
                y = int(bbox["y_px"])
                bw = int(bbox["width_px"])
                bh = int(bbox["height_px"])
                roi = detail[y:y + bh, x:x + bw]
                if roi.size:
                    _, max_val, _, max_loc = cv2.minMaxLoc(cv2.GaussianBlur(roi, (_odd(min(bw, bh) // 18), _odd(min(bw, bh) // 18)), 0))
                    if max_val > 0:
                        regions.append(FocusRegion(
                            label="jewellery_detail",
                            x=float(x + max_loc[0]),
                            y=float(y + max_loc[1]),
                            radius=float(max(18, min(bw, bh) * 0.18)),
                            score=0.45,
                        ))
        except Exception as bbox_err:
            logger.debug(f"jewellery detail fallback skipped: {bbox_err}")

    return _dedupe_regions(regions)


async def _generate_ai_focus_regions(img: np.ndarray, frame_url: str, session_id: str) -> list[FocusRegion]:
    """Ask a configured multimodal model for HUID/BIS/purity-mark coordinates."""
    h, w = img.shape[:2]
    try:
        from app.xai.gemini_focus import locate_focus_regions

        raw_regions = await locate_focus_regions(img, session_id=session_id, prefer_gemini=True)
        return _parse_ai_regions({"regions": raw_regions}, w, h)
    except Exception as e:
        logger.debug(f"[{session_id}] multimodal focus detection skipped: {e}")
        return []


def _parse_ai_regions(data: Any, width: int, height: int) -> list[FocusRegion]:
    raw_regions: Any
    if isinstance(data, dict):
        raw_regions = data.get("regions") or data.get("points") or data.get("focus_regions") or []
    else:
        raw_regions = data

    regions: list[FocusRegion] = []
    if not isinstance(raw_regions, list):
        return regions

    for item in raw_regions:
        if not isinstance(item, dict):
            continue
        try:
            label = str(item.get("label") or item.get("type") or "ai_focus")[:40]
            x = float(item.get("x"))
            y = float(item.get("y"))
            rw = float(item.get("width", item.get("w", 10)))
            rh = float(item.get("height", item.get("h", 10)))
            confidence = float(item.get("confidence", item.get("score", 0.65)))

            if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0:
                px, py = x * width, y * height
            elif 0.0 <= x <= 100.0 and 0.0 <= y <= 100.0:
                px, py = x * width / 100.0, y * height / 100.0
            else:
                px, py = x, y

            if rw <= 1.0 and rh <= 1.0:
                radius = max(rw * width, rh * height) * 0.85
            elif rw <= 100.0 and rh <= 100.0:
                radius = max(rw * width / 100.0, rh * height / 100.0) * 0.85
            else:
                radius = max(rw, rh) * 0.85

            if not (0 <= px <= width and 0 <= py <= height):
                continue
            if confidence < 0.2:
                continue
            regions.append(FocusRegion(label, px, py, max(12.0, radius), max(0.0, min(1.0, confidence))))
        except Exception:
            continue

    return _dedupe_regions(regions)


def _render_focus_overlay(img: np.ndarray, regions: list[FocusRegion]) -> Optional[np.ndarray]:
    """Render red/yellow heat only where evidence regions exist."""
    if not regions:
        return None

    import cv2

    h, w = img.shape[:2]
    mask = np.zeros((h, w), dtype=np.float32)
    for region in regions[:_MAX_FOCUS_REGIONS]:
        radius = int(max(8, min(max(w, h), region.radius)))
        intensity = float(max(0.30, min(1.0, region.score)))
        layer = np.zeros((h, w), dtype=np.float32)
        cv2.circle(layer, (int(round(region.x)), int(round(region.y))), radius, intensity, -1)
        blur = _odd(radius * 2 + 1)
        layer = cv2.GaussianBlur(layer, (blur, blur), 0)
        mask = np.maximum(mask, layer)

    max_val = float(mask.max())
    if max_val <= 0:
        return None
    mask = np.clip(mask / max_val, 0.0, 1.0)

    # Suppress very low activations so the whole photo is not tinted.
    heat_strength = np.clip((mask - 0.08) / 0.92, 0.0, 1.0)
    amber = np.array([12, 178, 255], dtype=np.float32)  # BGR
    red = np.array([32, 40, 242], dtype=np.float32)
    white_hot = np.array([224, 238, 255], dtype=np.float32)
    t = heat_strength[:, :, None].astype(np.float32)
    heatmap = amber * (1.0 - t) + red * t
    core = np.clip((t - 0.72) / 0.28, 0.0, 1.0)
    heatmap = heatmap * (1.0 - core) + white_hot * core
    alpha = (heat_strength ** 0.88) * 0.56
    alpha_3 = alpha[:, :, None]
    overlay = img.astype(np.float32) * (1.0 - alpha_3) + heatmap.astype(np.float32) * alpha_3
    return np.clip(overlay, 0, 255).astype(np.uint8)
