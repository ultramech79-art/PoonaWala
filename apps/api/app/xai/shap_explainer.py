"""
SHAP explainability for LightGBM fusion model.
Phase 3 (MVP): uses TreeExplainer when model is loaded, heuristic approximation otherwise.
Phase 6: re-run after full model training.
"""
import logging
from typing import Any, Optional

logger = logging.getLogger("goldeye.xai.shap")


def explain(
    features: dict[str, float],
    model=None,
) -> list[dict]:
    """
    Compute top-5 SHAP-style feature contributions.
    If LightGBM model is provided, uses TreeExplainer.
    Otherwise returns rule-based approximations (same sign, calibrated magnitude).

    Returns list of {"feature": str, "contribution": float} sorted by abs value desc.
    """
    if model is not None:
        return _tree_shap(features, model)
    return _heuristic_shap(features)


def _tree_shap(features: dict, model) -> list[dict]:
    try:
        import shap
        import numpy as np
        import pandas as pd

        from app.workers.fusion import FEATURE_COLUMNS
        row = pd.DataFrame([{k: features.get(k, 0.0) for k in FEATURE_COLUMNS}])
        explainer = shap.TreeExplainer(model)
        shap_vals = explainer.shap_values(row)[0]
        pairs = list(zip(FEATURE_COLUMNS, shap_vals.tolist()))
        pairs.sort(key=lambda x: abs(x[1]), reverse=True)
        return [{"feature": f, "contribution": round(v, 4)} for f, v in pairs[:5]]
    except Exception as e:
        logger.warning(f"TreeExplainer failed: {e} — falling back to heuristic")
        return _heuristic_shap(features)


def _heuristic_shap(features: dict) -> list[dict]:
    """
    Rule-based contribution estimates. Signs and magnitudes calibrated
    to match expected LightGBM TreeExplainer ballpark on synthetic data.
    """
    huid = float(features.get("huid_verified", 0))
    solid = float(features.get("solid_probability_s7", 0.5))
    manual_w = float(features.get("weight_method_hybrid", 0))
    audio = float(features.get("audio_solid_probability", 0.5))
    vlm_c = float(features.get("vlm_confidence", 0.5))

    contribs = [
        ("huid_verified",          0.31 if huid > 0.5 else -0.25),
        ("plated_solid_score",     (solid - 0.5) * 0.5),
        ("weight_consistency",     0.18 if manual_w > 0.5 else 0.05),
        ("audio_solid_prob",       (audio - 0.5) * 0.3),
        ("vlm_confidence",         (vlm_c - 0.5) * 0.25),
    ]
    contribs.sort(key=lambda x: abs(x[1]), reverse=True)
    return [{"feature": f, "contribution": round(v, 4)} for f, v in contribs[:5]]
