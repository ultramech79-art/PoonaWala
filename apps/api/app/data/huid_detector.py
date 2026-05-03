"""
Local BIS hallmark detector using OpenCV — no VLM, no tesseract needed.
Detects BIS logo triangle and estimates purity from hallmark region color.
Returns structured dict compatible with S1 VLM output format.
"""
import logging
from typing import Optional

import cv2
import numpy as np

from app.data.color import KARAT_CENTROIDS, KARAT_VALUES

logger = logging.getLogger("goldeye.ml.huid_detector")

_PURITY_MARK_MAP = {
    24: "24K999",
    22: "22K916",
    20: "20K833",
    18: "18K750",
    14: "14K585",
}


def detect_bis_logo(img_bgr: np.ndarray) -> dict:
    """
    Find bright metallic triangle (BIS logo) in image using HSV analysis.

    Returns:
      {"found": bool, "bbox": (x, y, w, h) or None, "confidence": float}
    """
    try:
        hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
        # Bright (V>180), slightly warm-hued (H 15–35 in OpenCV → 30–70° hue)
        mask = cv2.inRange(hsv, (10, 30, 180), (20, 200, 255))

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        best_bbox = None
        best_score = 0.0

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < 50:
                continue
            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
            n_verts = len(approx)

            if 3 <= n_verts <= 6:
                # Score by triangularity + area (larger hallmark → more confident)
                aspect = float(area) / (peri ** 2 + 1e-6) * 4 * np.pi
                score = min(1.0, aspect * 2.0) * min(1.0, area / 500.0)
                if score > best_score:
                    best_score = score
                    x, y, w, h = cv2.boundingRect(cnt)
                    best_bbox = (x, y, w, h)

        if best_bbox is not None and best_score > 0.05:
            return {"found": True, "bbox": best_bbox, "confidence": round(min(best_score, 0.85), 3)}
        return {"found": False, "bbox": None, "confidence": 0.0}

    except Exception as e:
        logger.warning(f"detect_bis_logo error: {e}")
        return {"found": False, "bbox": None, "confidence": 0.0}


def estimate_purity_mark(img_bgr: np.ndarray, bis_region_bbox: Optional[tuple]) -> Optional[str]:
    """
    Estimate purity mark by CIELAB color matching of the hallmark crop.

    Returns purity mark string like "22K916" or None.
    """
    try:
        h_img, w_img = img_bgr.shape[:2]

        if bis_region_bbox is not None:
            x, y, w, h = bis_region_bbox
            # Expand crop slightly for context
            margin = 10
            x1 = max(0, x - margin)
            y1 = max(0, y - margin)
            x2 = min(w_img, x + w + margin)
            y2 = min(h_img, y + h + margin)
            crop = img_bgr[y1:y2, x1:x2]
        else:
            # Use central region of image
            cy, cx = h_img // 2, w_img // 2
            r = min(h_img, w_img) // 4
            crop = img_bgr[max(0, cy - r):cy + r, max(0, cx - r):cx + r]

        if crop.size == 0:
            return None

        # Compute mean Lab
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2Lab).astype(np.float32)
        L_mean = float(np.mean(lab[:, :, 0]))
        a_mean = float(np.mean(lab[:, :, 1])) - 128
        b_mean = float(np.mean(lab[:, :, 2])) - 128

        # Match against KARAT_CENTROIDS
        best_karat_key = None
        best_dist = float("inf")
        for key, (cL, ca, cb) in KARAT_CENTROIDS.items():
            if key == "plated":
                continue
            dist = ((L_mean - cL) ** 2 + (a_mean - ca) ** 2 + (b_mean - cb) ** 2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_karat_key = key

        if best_karat_key is None:
            return None

        karat_int = KARAT_VALUES.get(best_karat_key, 18)
        return _PURITY_MARK_MAP.get(karat_int, f"{karat_int}K")

    except Exception as e:
        logger.warning(f"estimate_purity_mark error: {e}")
        return None


def detect_huid(img_bgr: np.ndarray, bis_region_bbox: Optional[tuple],
                karat_int: int = 22) -> Optional[str]:
    """
    Simplified HUID region detection via edge density.

    Returns a synthetic HUID-format string if fine-print structure detected, else None.
    Format: "DET{:03d}{:02d}".format(hash % 1000, karat_int)
    """
    try:
        h_img, w_img = img_bgr.shape[:2]
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

        if bis_region_bbox is not None:
            x, y, w, h = bis_region_bbox
            # Crop region above/below BIS logo
            above_y1 = max(0, y - h)
            above_y2 = max(0, y)
            below_y1 = min(h_img, y + h)
            below_y2 = min(h_img, y + 2 * h)

            regions = []
            if above_y2 > above_y1:
                regions.append(gray[above_y1:above_y2, max(0, x):min(w_img, x + w)])
            if below_y2 > below_y1:
                regions.append(gray[below_y1:below_y2, max(0, x):min(w_img, x + w)])
        else:
            # Use bottom quarter of image
            regions = [gray[3 * h_img // 4:, :]]

        if not regions:
            return None

        # Edge density analysis
        edge_densities = []
        for region in regions:
            if region.size < 100:
                continue
            edges = cv2.Canny(region, 50, 150)
            density = float(np.mean(edges > 0))
            edge_densities.append(density)

        if not edge_densities:
            return None

        avg_density = float(np.mean(edge_densities))

        # High edge density (>0.05) suggests fine print / structured content
        if avg_density > 0.05:
            # Synthetic HUID using image hash for demo purposes
            img_hash = hash(img_bgr.tobytes()) % 1000
            return "DET{:03d}{:02d}".format(img_hash, karat_int % 100)
        return None

    except Exception as e:
        logger.warning(f"detect_huid error: {e}")
        return None


def analyze_hallmark(img_bgr: np.ndarray) -> dict:
    """
    Full BIS hallmark analysis pipeline.

    Returns:
      {
        "bis_logo_present": bool,
        "purity_mark": "22K916" | "18K750" | None,
        "huid_code": "DETxxx" | None,
        "stamp_appearance": "laser_engraved" | "embossed" | "unclear",
        "ocr_confidence": float  # 0–1
      }
    """
    try:
        # Step 1: detect BIS logo
        bis_result = detect_bis_logo(img_bgr)
        bis_found = bis_result["found"]
        bbox = bis_result["bbox"]
        bis_conf = bis_result["confidence"]

        # Step 2: estimate purity from color
        purity_mark = estimate_purity_mark(img_bgr, bbox)

        # Step 3: parse karat int from purity mark
        karat_int = 22  # default
        if purity_mark and purity_mark[0].isdigit():
            try:
                karat_int = int(purity_mark.split("K")[0])
            except (ValueError, IndexError):
                karat_int = 22

        # Step 4: HUID detection
        huid_code = detect_huid(img_bgr, bbox, karat_int) if bis_found else None

        # Step 5: stamp appearance heuristic
        if bis_found and bis_conf > 0.5:
            # High-confidence bright region → likely laser engraved
            stamp_appearance = "laser_engraved"
        elif bis_found:
            stamp_appearance = "embossed"
        else:
            stamp_appearance = "unclear"

        # Overall confidence
        ocr_confidence = round(bis_conf * 0.7 + (0.3 if purity_mark else 0.0), 3)

        return {
            "bis_logo_present": bis_found,
            "purity_mark": purity_mark,
            "huid_code": huid_code,
            "stamp_appearance": stamp_appearance,
            "ocr_confidence": min(ocr_confidence, 0.85),
        }

    except Exception as e:
        logger.warning(f"analyze_hallmark error: {e}")
        return {
            "bis_logo_present": False,
            "purity_mark": None,
            "huid_code": None,
            "stamp_appearance": "unclear",
            "ocr_confidence": 0.0,
        }
