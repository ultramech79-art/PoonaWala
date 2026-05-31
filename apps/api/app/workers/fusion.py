"""
Fusion worker — combines all 12 signal outputs into calibrated bands.

Phase 3 (MVP):
  - Extracts 13 features from signals S1/S2/S5/S6/S7/S8/S10/S11
  - Loads LightGBM + MAPIE from ml/models/ if available
  - Falls back to heuristic fusion if models not yet trained

Phase 5 (cut signals):
  - Extended feature vector to 19 columns: adds S3 (CIELAB colour),
    S4 (specular), S9 (reverse catalog), S12 (cross-app graph)

Phase 6: retrain with full 19-feature set after pilot data.
"""
import os
import logging
import pickle
from typing import Any, Optional

import numpy as np
from app.data.image_utils import DEFAULT_REFERENCE_FREE_WEIGHT_G
from app.data.gold_physics import density_band_for_karat_range, density_for_karat

logger = logging.getLogger("goldeye.workers.fusion")

# Feature columns — must match train_lgbm_fusion.py FEATURES list
# Phase 3: 13 cols (S1/S2/S5/S6/S7/S8/S10/S11)
# Phase 5: +6 cols for S3/S4/S9/S12  → 19 total
FEATURE_COLUMNS = [
    "huid_verified", "ocr_confidence",
    "hallmark_quality_score",
    "coin_detected", "jewelry_area_px2",
    "estimated_weight_g", "weight_method_hybrid",
    "solid_probability_s7",
    "vlm_confidence", "vlm_karat_mid",
    "telemetry_anomaly_score",
    "audio_solid_probability", "audio_confidence",
    # Phase 5 additions
    "color_karat_mid", "color_confidence",
    "specular_metal_score", "specular_confidence",
    "catalog_match_score",
    "graph_anomaly_score",
]

# Fallback price used only when IBJA fetch fails in assess.py (live price overrides this).
# ₹9,000/g ≈ XAU $3,300/oz at USD/INR 85 — realistic estimate for 2025-26.
GOLD_24K_PER_G = 9_000.0

_lgbm_model = None
_mapie_model = None
_models_loaded = False


def _load_models():
    global _lgbm_model, _mapie_model, _models_loaded
    if _models_loaded:
        return
    _models_loaded = True
    base = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "ml", "models")
    lgbm_path = os.path.normpath(os.path.join(base, "fusion_lgbm.pkl"))
    mapie_path = os.path.normpath(os.path.join(base, "fusion_mapie.pkl"))
    if os.path.exists(lgbm_path):
        with open(lgbm_path, "rb") as f:
            _lgbm_model = pickle.load(f)
        logger.info("Loaded LightGBM fusion model")
    if os.path.exists(mapie_path):
        with open(mapie_path, "rb") as f:
            _mapie_model = pickle.load(f)
        logger.info("Loaded MAPIE conformal model")


def extract_features(signals: dict[str, Any]) -> dict[str, float]:
    """Convert raw signal payloads to the flat feature vector (19 columns after Phase 5)."""
    s1  = signals.get("s1",  {})
    s2  = signals.get("s2",  {})
    s5  = signals.get("s5",  {})
    s6  = signals.get("s6",  {})
    s7  = signals.get("s7",  {})
    s8  = signals.get("s8",  {})
    s10 = signals.get("s10", {})
    s11 = signals.get("s11", {})
    # Phase 5 signals
    s3  = signals.get("s3",  {})
    s4  = signals.get("s4",  {})
    s9  = signals.get("s9",  {})
    s12 = signals.get("s12", {})

    karat_band = s8.get("estimated_karat_band", [18, 22])
    if not isinstance(karat_band, list) or len(karat_band) != 2:
        karat_band = [18, 22]
    vlm_karat_mid = sum(karat_band) / 2

    # S3: color karat mid-point (convert best_karat_int → mid)
    color_karat_mid = float(s3.get("best_karat_int", 20))
    color_confidence = float(signals.get("s3_conf", 0.0))

    # S4: specular metal score
    specular_metal_score = float(s4.get("metal_score", 0.5))
    specular_confidence  = float(signals.get("s4_conf", 0.0))

    # S9: catalog match score (1.0 = exact catalog hit = likely fraud)
    catalog_match_score = float(s9.get("catalog_match_score", 0.0))

    # S12: cross-app graph anomaly score
    graph_anomaly_score = float(s12.get("graph_anomaly_score", 0.0))

    return {
        # huid_verified must require an actual detected HUID CODE — NOT merely a
        # purity/karat mark. s1.purity_mark is a colour-based karat guess that is
        # almost always non-null, so keying off it flagged huid_verified=true even
        # when no HUID exists. A genuine BIS verification happens in the frontend
        # HUID verifier; this backend flag now only reflects a read HUID code.
        "huid_verified":           1.0 if s1.get("huid_code") else 0.0,
        "ocr_confidence":          float(signals.get("s1_conf", 0.5)),
        "hallmark_quality_score":  float(s2.get("hallmark_quality_score", 0.5)),
        "coin_detected":           1.0 if s5.get("coin_detected") else 0.0,
        "jewelry_area_px2":        float(s5.get("jewelry_area_px2", 0)),
        "estimated_weight_g":      float(s6.get("estimated_weight_g", DEFAULT_REFERENCE_FREE_WEIGHT_G)),
        "weight_method_hybrid":    1.0 if s6.get("method") == "hybrid" else 0.0,
        "solid_probability_s7":    float(s7.get("solid_probability", 0.5)),
        "vlm_confidence":          float(signals.get("s8_conf", 0.5)),
        "vlm_karat_mid":           float(vlm_karat_mid),
        "telemetry_anomaly_score": float(s10.get("telemetry_anomaly_score", 0.03)),
        "audio_solid_probability": float(s11.get("solid_probability", 0.5)),
        "audio_confidence":        float(signals.get("s11_conf", 0.0)),
        # Phase 5 additions
        "color_karat_mid":         color_karat_mid,
        "color_confidence":        color_confidence,
        "specular_metal_score":    specular_metal_score,
        "specular_confidence":     specular_confidence,
        "catalog_match_score":     catalog_match_score,
        "graph_anomaly_score":     graph_anomaly_score,
    }


def extract_weight_context(signals: dict[str, Any]) -> dict[str, float]:
    """Return deterministic non-model weight data used after karat is fused."""
    s6 = signals.get("s6", {})
    return {
        "estimated_weight_low_g": float(s6.get("band_low_g", 0.0)),
        "estimated_weight_high_g": float(s6.get("band_high_g", 0.0)),
        "estimated_volume_cm3": float(s6.get("volume_cm3", 0.0)),
        "volume_low_cm3": float(s6.get("volume_low_cm3", 0.0)),
        "volume_high_cm3": float(s6.get("volume_high_cm3", 0.0)),
        "weight_geometry_confidence": float(signals.get("s6_conf", 0.0)),
    }


def fuse(
    features: dict[str, float],
    manual_weight_g: Optional[float] = None,
    weight_context: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    """
    Fuse features → karat + weight + value bands.
    Returns calibration_method: 'split_conformal' when MAPIE loaded, 'none' otherwise.
    """
    _load_models()

    est_weight = features["estimated_weight_g"]
    weight_context = weight_context or {
        "estimated_weight_low_g": features.get("estimated_weight_low_g", 0.0),
        "estimated_weight_high_g": features.get("estimated_weight_high_g", 0.0),
        "estimated_volume_cm3": features.get("estimated_volume_cm3", 0.0),
        "volume_low_cm3": features.get("volume_low_cm3", 0.0),
        "volume_high_cm3": features.get("volume_high_cm3", 0.0),
    }
    huid_verified = features["huid_verified"] > 0.5

    if _lgbm_model is not None and _mapie_model is not None:
        return _lgbm_mapie_fuse(features, est_weight, huid_verified, manual_weight_g, weight_context)
    return _heuristic_fuse(features, est_weight, huid_verified, manual_weight_g, weight_context)


def _lgbm_mapie_fuse(
    features: dict,
    est_weight: float,
    huid_verified: bool,
    manual_weight_g: Optional[float],
    weight_context: Optional[dict] = None,
) -> dict:
    try:
        import pandas as pd
        row = pd.DataFrame([{k: features.get(k, 0.0) for k in FEATURE_COLUMNS}])
        # LightGBM predicts karat point estimate
        point_karat = float(np.clip(_lgbm_model.predict(row)[0], 14, 24))
        # MAPIE gives 90% coverage interval (model init with confidence_level=0.90)
        _, pis = _mapie_model.predict_interval(row)
        point_karat_int = int(round(point_karat))
        karat_lo = min(point_karat_int, int(round(float(np.clip(pis[0, 0, 0], 14, 24)))))
        karat_hi = max(point_karat_int, int(round(float(np.clip(pis[0, 1, 0], 14, 24)))))
        return _build_result(
            point_karat=point_karat_int,
            karat_lo=karat_lo,
            karat_hi=karat_hi,
            est_weight=est_weight,
            manual_weight_g=manual_weight_g,
            huid_verified=huid_verified,
            calibration_method="split_conformal",
            weight_context=weight_context,
        )
    except Exception as e:
        logger.warning(f"LGBM/MAPIE fuse failed: {e} — falling back to heuristic")
        return _heuristic_fuse(features, est_weight, huid_verified, manual_weight_g, weight_context)


def _heuristic_fuse(
    features: dict,
    est_weight: float,
    huid_verified: bool,
    manual_weight_g: Optional[float],
    weight_context: Optional[dict] = None,
) -> dict:
    vlm_karat_mid   = features["vlm_karat_mid"]
    color_karat_mid = features.get("color_karat_mid", vlm_karat_mid)
    color_conf      = features.get("color_confidence", 0.0)

    # Blend VLM karat with color karat (weighted by color confidence)
    blended_karat = (
        vlm_karat_mid * (1 - color_conf * 0.4)
        + color_karat_mid * (color_conf * 0.4)
    )
    claimed_karat = 22 if blended_karat >= 20 else 18

    point_karat = int(round(
        claimed_karat if huid_verified
        else (claimed_karat * 0.5 + blended_karat * 0.5)
    ))
    karat_lo = max(14, point_karat - 2)
    karat_hi = min(24, point_karat + 2)

    # Specular metal score: if low → widen uncertainty band
    specular_metal_score = features.get("specular_metal_score", 0.5)
    if specular_metal_score < 0.35:
        karat_lo = max(14, karat_lo - 2)   # extra uncertainty for non-gold specular

    return _build_result(
        point_karat=point_karat,
        karat_lo=karat_lo,
        karat_hi=karat_hi,
        est_weight=est_weight,
        manual_weight_g=manual_weight_g,
        huid_verified=huid_verified,
        calibration_method="none",
        weight_context=weight_context,
    )


def _build_result(
    point_karat: int,
    karat_lo: int,
    karat_hi: int,
    est_weight: float,
    manual_weight_g: Optional[float],
    huid_verified: bool,
    calibration_method: str,
    weight_context: Optional[dict] = None,
) -> dict:
    weight_context = weight_context or {}
    density_point = density_for_karat(point_karat)
    density_band = density_band_for_karat_range(karat_lo, karat_hi)

    volume_mid = float(weight_context.get("estimated_volume_cm3") or 0.0)
    volume_low = float(weight_context.get("volume_low_cm3") or 0.0)
    volume_high = float(weight_context.get("volume_high_cm3") or 0.0)
    if volume_mid > 0:
        est_weight = volume_mid * density_point.mid
        vision_lo = (volume_low or volume_mid * 0.75) * density_band.low
        vision_hi = (volume_high or volume_mid * 1.35) * density_band.high
    else:
        vision_lo = float(weight_context.get("estimated_weight_low_g") or est_weight * 0.78)
        vision_hi = float(weight_context.get("estimated_weight_high_g") or est_weight * 1.30)

    if manual_weight_g:
        final_weight = manual_weight_g * 0.70 + est_weight * 0.30
        manual_lo = manual_weight_g * 0.96
        manual_hi = manual_weight_g * 1.04
        weight_lo = manual_lo * 0.70 + vision_lo * 0.30
        weight_hi = manual_hi * 0.70 + vision_hi * 0.30
    else:
        final_weight = est_weight
        weight_lo = vision_lo
        weight_hi = vision_hi

    weight_lo = min(weight_lo, final_weight * 0.985)
    weight_hi = max(weight_hi, final_weight * 1.015)
    weight_lo = max(0.2, weight_lo)
    weight_hi = min(5000.0, weight_hi)

    purity_ratio = point_karat / 24
    value_per_g = GOLD_24K_PER_G * purity_ratio
    value_inr = final_weight * value_per_g
    value_lo = weight_lo * GOLD_24K_PER_G * (karat_lo / 24)
    value_hi = weight_hi * GOLD_24K_PER_G * (karat_hi / 24)

    return {
        "point_karat": point_karat,
        "karat_lo": karat_lo,
        "karat_hi": karat_hi,
        "final_weight_g": round(final_weight, 2),
        "weight_lo_g": round(weight_lo, 2),
        "weight_hi_g": round(weight_hi, 2),
        "value_inr": value_inr,
        "value_lo_inr": value_lo,
        "value_hi_inr": value_hi,
        "calibration_method": calibration_method,
        "huid_verified": huid_verified,
        "density_g_cm3": round(density_point.mid, 3),
        "density_lo_g_cm3": round(density_band.low, 3),
        "density_hi_g_cm3": round(density_band.high, 3),
        "volume_cm3": round(volume_mid, 4) if volume_mid > 0 else None,
    }
