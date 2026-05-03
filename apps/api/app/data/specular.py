"""
Specular reflectance analysis for S4 signal.

Gold vs. plated brass have distinguishable highlight characteristics:
  - Pure gold:    warm highlights (hue ~30–45°), high brightness, smooth falloff
  - Plated brass: similar hue but duller, faster falloff, more diffuse
  - Silver-plated: neutral/cool highlights (hue ~180–220°)

MVP approach: analyze highlight hue and brightness distribution across frames.
Returns a metal_score (0–1) where 1 = strong gold-like specular signature.
"""
import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger("goldeye.ml.specular")

# Gold highlight hue range in OpenCV (0–180 scale): ~15–30
GOLD_HUE_LOW  = 12
GOLD_HUE_HIGH = 32
HIGHLIGHT_V_THRESHOLD = 200  # pixel brightness threshold (0–255)


def analyze_specular(img_bgr: np.ndarray) -> dict:
    """
    Analyze specular highlights in a single frame.
    Returns highlight_fraction, mean_hue, gold_hue_fraction, brightness_mean.
    """
    try:
        import cv2
    except ImportError:
        return {"error": "opencv not available", "metal_score": 0.5}

    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # Highlight mask: bright pixels with some saturation (not pure white)
    highlight_mask = (V > HIGHLIGHT_V_THRESHOLD) & (S > 20)
    highlight_frac = float(np.mean(highlight_mask))

    if highlight_frac < 0.001:
        return {"highlight_fraction": highlight_frac, "metal_score": 0.5,
                "confidence": 0.1, "reason": "no_highlights"}

    hues = H[highlight_mask]
    mean_hue = float(np.mean(hues))
    # Gold hue fraction among highlights
    gold_hue_mask = (hues >= GOLD_HUE_LOW) & (hues <= GOLD_HUE_HIGH)
    gold_frac = float(np.mean(gold_hue_mask))

    # Brightness mean of highlights (solid gold → higher concentrated brightness)
    brightness_mean = float(np.mean(V[highlight_mask])) / 255.0

    # Composite score
    metal_score = gold_frac * 0.6 + brightness_mean * 0.4
    confidence = min(1.0, highlight_frac * 20)  # more highlights → more confident

    return {
        "highlight_fraction": round(highlight_frac, 4),
        "mean_hue_deg": round(mean_hue * 2, 1),  # OpenCV hue is 0–180; *2 for degrees
        "gold_hue_fraction": round(gold_frac, 4),
        "brightness_mean": round(brightness_mean, 4),
        "metal_score": round(float(np.clip(metal_score, 0, 1)), 4),
        "confidence": round(confidence, 3),
    }


def analyze_specular_multi(frames_bgr: list) -> dict:
    """
    Aggregate specular analysis across multiple frames.
    More frames → more robust score.
    """
    if not frames_bgr:
        return {"metal_score": 0.5, "confidence": 0.0, "frames_analyzed": 0}

    results = [analyze_specular(f) for f in frames_bgr if f is not None]
    valid = [r for r in results if "error" not in r and r.get("highlight_fraction", 0) > 0.001]

    if not valid:
        return {"metal_score": 0.5, "confidence": 0.1, "frames_analyzed": 0}

    mean_metal_score = float(np.mean([r["metal_score"] for r in valid]))
    mean_confidence  = float(np.mean([r["confidence"]  for r in valid]))
    # Confidence bonus for having multiple frames with consistent scores
    std_score = float(np.std([r["metal_score"] for r in valid])) if len(valid) > 1 else 0.2
    consistency_bonus = max(0.0, 0.2 - std_score)

    return {
        "metal_score": round(mean_metal_score, 4),
        "confidence": round(min(1.0, mean_confidence + consistency_bonus), 3),
        "frames_analyzed": len(valid),
        "score_std": round(std_score, 4),
        "per_frame": [{"metal_score": r["metal_score"], "gold_hue_frac": r.get("gold_hue_fraction", 0)}
                      for r in valid],
    }
