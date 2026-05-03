"""
Image utilities for GoldEye signal workers.

fetch_image_bytes  — download or decode a frame URL to raw bytes
detect_coin_hough  — OpenCV Hough circles to find a ₹10 coin (27mm reference)
estimate_weight_from_bbox — volume→weight via density heuristic
"""
import base64
import logging
import math
from io import BytesIO
from typing import Optional

import httpx
import numpy as np

logger = logging.getLogger("goldeye.ml.image_utils")

# ₹10 coin physical diameter in mm
COIN_DIAMETER_MM = 27.0
# 18–22K gold density range (g/cm³)
GOLD_DENSITY_G_CM3 = 15.5


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


def detect_coin_hough(img_bgr: np.ndarray) -> Optional[dict]:
    """
    Detect a circular coin in the image using Hough circle transform.
    Returns {"radius_px": float, "center": (x, y), "px_per_mm": float} or None.

    Coin assumed to be the most prominent circle with reasonable size constraints.
    """
    try:
        import cv2
    except ImportError:
        logger.warning("opencv not available — skipping coin detection")
        return None

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)

    h, w = gray.shape
    min_r = int(min(h, w) * 0.04)
    max_r = int(min(h, w) * 0.40)

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

    if circles is None:
        return None

    circles = np.round(circles[0]).astype(int)
    # Pick the circle with the highest radius (most likely the coin, not a stone)
    best = sorted(circles, key=lambda c: c[2], reverse=True)[0]
    cx, cy, r = best
    px_per_mm = (r * 2) / COIN_DIAMETER_MM
    return {"radius_px": float(r), "center": (int(cx), int(cy)), "px_per_mm": px_per_mm}


def estimate_jewelry_bbox_px(
    img_bgr: np.ndarray,
    coin_result: Optional[dict] = None,
) -> Optional[dict]:
    """
    Estimate jewelry bounding box using simple thresholding / contour detection.
    Returns {"width_px", "height_px", "area_px2"} or None.
    """
    try:
        import cv2
    except ImportError:
        return None

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Invert if background is dark
    if np.mean(thresh) > 127:
        thresh = cv2.bitwise_not(thresh)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)
    return {"width_px": w, "height_px": h, "area_px2": w * h}


def estimate_weight_from_bbox(
    bbox: dict,
    px_per_mm: Optional[float],
    thickness_mm: float = 2.5,
) -> float:
    """
    Rough weight estimate from bounding box area × assumed thickness × density.
    Falls back to 7.9g population mean if scale anchor is unavailable.
    """
    if px_per_mm is None or px_per_mm <= 0:
        return 7.9  # population mean for Indian bangles (PRD §4.2)

    w_mm = bbox["width_px"] / px_per_mm
    h_mm = bbox["height_px"] / px_per_mm
    # Approximate solid volume as elliptical cross-section × thickness
    volume_cm3 = math.pi * (w_mm / 20) * (h_mm / 20) * (thickness_mm / 10)
    weight_g = volume_cm3 * GOLD_DENSITY_G_CM3
    # Clamp to plausible jewelry range
    return max(1.0, min(weight_g, 200.0))
