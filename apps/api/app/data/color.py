"""
CIELAB color analysis for S3 signal.

Pipeline:
  1. Convert BGR image to Lab color space
  2. Mask out near-white background (L* > 90) and near-black shadows (L* < 20)
  3. Compute mean Lab of remaining (metal) pixels
  4. Compute CIE76 ΔE distance to each karat centroid
  5. Softmax over negative distances → karat probability vector
"""
import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger("goldeye.ml.color")

# Lab centroids per karat (calibrated from BlenderProc renders + catalog samples)
KARAT_CENTROIDS: dict[str, tuple[float, float, float]] = {
    "24K": (85.0,  5.5, 25.0),
    "22K": (82.0,  4.8, 24.0),
    "20K": (78.0,  4.2, 21.0),
    "18K": (74.0,  3.5, 18.0),
    "14K": (68.0,  2.0, 12.0),
    "plated": (65.0, 3.0, 15.0),
}
KARAT_VALUES = {"24K": 24, "22K": 22, "20K": 20, "18K": 18, "14K": 14, "plated": 0}


def analyze_color(img_bgr: np.ndarray) -> dict:
    """
    Returns:
      karat_probabilities: dict[str, float]  — sum to 1.0
      best_karat: str
      mean_lab: [L, a, b]
      color_confidence: float  (low when metal region is tiny or image is overexposed)
    """
    try:
        import cv2
    except ImportError:
        return {"error": "opencv not available", "color_confidence": 0.0}

    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    L, a, b = lab[:, :, 0], lab[:, :, 1] - 128, lab[:, :, 2] - 128

    # Metal mask: exclude white background and deep shadows
    metal_mask = (L > 20) & (L < 90) & (np.abs(a) < 40) & (np.abs(b) < 50)
    metal_pct = float(np.mean(metal_mask))

    if metal_pct < 0.03:
        return {"error": "insufficient_metal_pixels", "color_confidence": 0.0,
                "metal_fraction": metal_pct}

    mean_L = float(np.mean(L[metal_mask]))
    mean_a = float(np.mean(a[metal_mask]))
    mean_b = float(np.mean(b[metal_mask]))

    # CIE76 ΔE to each centroid
    delta_e: dict[str, float] = {}
    for label, (cL, ca, cb) in KARAT_CENTROIDS.items():
        delta_e[label] = math.sqrt((mean_L - cL)**2 + (mean_a - ca)**2 + (mean_b - cb)**2)

    # Softmax over negative ΔE (smaller distance → higher probability)
    max_neg = max(-v for v in delta_e.values())
    exp_vals = {k: math.exp(-v - max_neg) for k, v in delta_e.items()}
    total = sum(exp_vals.values())
    probs = {k: round(v / total, 4) for k, v in exp_vals.items()}
    best = max(probs, key=lambda k: probs[k])

    # Confidence: low when best probability is close to uniform (1/6 ≈ 0.167)
    color_confidence = float(np.clip((probs[best] - 1 / len(probs)) / (1 - 1 / len(probs)), 0, 1))
    # Scale by metal fraction (more metal pixels → more reliable)
    color_confidence *= min(1.0, metal_pct * 5)

    return {
        "karat_probabilities": probs,
        "best_karat": best,
        "best_karat_int": KARAT_VALUES.get(best, 18),
        "mean_lab": [round(mean_L, 2), round(mean_a, 2), round(mean_b, 2)],
        "delta_e": {k: round(v, 2) for k, v in delta_e.items()},
        "metal_fraction": round(metal_pct, 4),
        "color_confidence": round(color_confidence, 3),
    }


def white_balance_coin(img_bgr: np.ndarray) -> Optional[np.ndarray]:
    """
    Rough white-balance using the ₹10 coin's known neutral gray (L*≈72).
    Returns corrected image or None if no coin-like neutral region found.
    """
    try:
        import cv2
    except ImportError:
        return None

    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    L = lab[:, :, 0]
    # Coin region: neutral area (low chroma) around L* = 72 ± 15
    coin_mask = (L > 57) & (L < 87) & (np.abs(lab[:, :, 1] - 128) < 10) & (np.abs(lab[:, :, 2] - 128) < 10)
    if np.sum(coin_mask) < 100:
        return None

    mean_L_coin = float(np.mean(L[coin_mask]))
    scale = 72.0 / (mean_L_coin + 1e-6)
    corrected = np.clip(lab.copy(), 0, 255)
    corrected[:, :, 0] = np.clip(corrected[:, :, 0] * scale, 0, 100)
    return cv2.cvtColor(corrected.astype(np.uint8), cv2.COLOR_Lab2BGR)
