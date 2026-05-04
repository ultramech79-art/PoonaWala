"""
Train LightGBM fusion model with MAPIE conformal calibration.
Phase 6: Optuna hyperparameter search (100 trials by default).

19 input features covering all 12 signals (S1–S12, S5/S6/S10 rule-based).

Usage:
  python train_lgbm_fusion.py --out_dir ml/models            # synthetic scaffold
  python train_lgbm_fusion.py --data path/to/data.csv        # real data
  python train_lgbm_fusion.py --optuna_trials 100            # with Optuna search

Output:
  ml/models/fusion_lgbm.pkl   (best LightGBM model)
  ml/models/fusion_mapie.pkl  (MAPIE conformal wrapper — 90% coverage)
"""
import argparse
import os
import pickle
from pathlib import Path

import numpy as np


FEATURES = [
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


def generate_synthetic(n: int = 2000) -> tuple:
    """Generate synthetic training data. More realistic distributions than Phase 3."""
    rng = np.random.default_rng(42)

    # Simulate realistic karat distribution (Indian market: mostly 22K, some 18K)
    true_karat = rng.choice([14, 18, 20, 22, 24], n, p=[0.05, 0.25, 0.10, 0.50, 0.10]).astype(float)

    def noisy(base, noise=0.08):
        return np.clip(base + rng.normal(0, noise, n), 0.0, 1.0)

    # Heuristic: higher karat → more likely to have real hallmark
    huid_prob = np.where(true_karat >= 22, 0.80, np.where(true_karat >= 18, 0.55, 0.30))
    huid_verified = rng.binomial(1, huid_prob).astype(float)

    # Solid probability correlates with karat (plated pieces usually aren't 24K)
    solid_base = np.where(true_karat >= 20, 0.85, np.where(true_karat >= 18, 0.65, 0.40))

    import pandas as pd
    X = pd.DataFrame({
        "huid_verified":          huid_verified,
        "ocr_confidence":         noisy(huid_verified * 0.8 + 0.2),
        "hallmark_quality_score": noisy(huid_verified * 0.7 + 0.3),
        "coin_detected":          rng.choice([0, 1], n, p=[0.15, 0.85]).astype(float),
        "jewelry_area_px2":       rng.integers(5000, 120000, n).astype(float),
        "estimated_weight_g":     rng.uniform(3.0, 50.0, n),
        "weight_method_hybrid":   rng.choice([0, 1], n, p=[0.3, 0.7]).astype(float),
        "solid_probability_s7":   noisy(solid_base, 0.10),
        "vlm_confidence":         noisy(0.70, 0.12),
        "vlm_karat_mid":          true_karat + rng.normal(0, 1.5, n),
        "telemetry_anomaly_score":rng.beta(1.5, 10, n),
        "audio_solid_probability":noisy(solid_base, 0.12),
        "audio_confidence":       rng.uniform(0.0, 0.85, n),
        "color_karat_mid":        true_karat + rng.normal(0, 2.0, n),
        "color_confidence":       rng.uniform(0.1, 0.90, n),
        "specular_metal_score":   noisy(0.60, 0.15),
        "specular_confidence":    rng.uniform(0.2, 0.90, n),
        "catalog_match_score":    rng.choice([0.0, 0.1, 0.88, 1.0], n, p=[0.82, 0.10, 0.04, 0.04]),
        "graph_anomaly_score":    rng.choice([0.0, 0.5, 0.9], n, p=[0.88, 0.08, 0.04]),
    })
    X = X.clip(0.0, None)

    y = (true_karat + rng.normal(0, 0.8, n)).clip(14, 24)
    return X, y


def _optuna_search(X_tr, y_tr, X_val, y_val, n_trials: int):
    import optuna
    import lightgbm as lgb
    from sklearn.metrics import mean_absolute_error

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    def objective(trial):
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 600),
            "max_depth": trial.suggest_int("max_depth", 3, 8),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.15, log=True),
            "num_leaves": trial.suggest_int("num_leaves", 15, 127),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-4, 10.0, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-4, 10.0, log=True),
            "min_child_samples": trial.suggest_int("min_child_samples", 5, 50),
            "n_jobs": -1,
            "random_state": 42,
            "verbose": -1,
        }
        model = lgb.LGBMRegressor(**params)
        model.fit(X_tr, y_tr,
                  eval_set=[(X_val, y_val)],
                  callbacks=[lgb.early_stopping(30, verbose=False)])
        return mean_absolute_error(y_val, model.predict(X_val))

    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
    return study.best_params


def train(data_path: str | None, mode: str, out_dir: str, optuna_trials: int = 0):
    try:
        import lightgbm as lgb
        from mapie.regression import SplitConformalRegressor
        import pandas as pd
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import mean_absolute_error
    except ImportError as e:
        raise ImportError(f"Missing dep: {e}. pip install lightgbm mapie scikit-learn pandas") from e

    if data_path and Path(data_path).exists():
        df = pd.read_csv(data_path)
        y = df.pop("target")
        print(f"Loaded {len(df)} real samples from {data_path}")
    else:
        print(f"No dataset found — generating {2000} synthetic samples.")
        df, y = generate_synthetic(2000)

    X = df[FEATURES] if all(f in df.columns for f in FEATURES) else df
    X_tr, X_val, y_tr, y_val = train_test_split(X, y, test_size=0.20, random_state=42)
    print(f"Train: {len(X_tr)}  Val: {len(X_val)}  Features: {len(X.columns)}")

    if optuna_trials > 0:
        print(f"Running Optuna search ({optuna_trials} trials)…")
        best_params = _optuna_search(X_tr, y_tr, X_val, y_val, optuna_trials)
        best_params.update({"n_jobs": -1, "random_state": 42, "verbose": -1})
        print(f"Best params: {best_params}")
    else:
        best_params = {
            "n_estimators": 400,
            "max_depth": 6,
            "num_leaves": 63,
            "learning_rate": 0.04,
            "subsample": 0.80,
            "colsample_bytree": 0.80,
            "reg_alpha": 0.1,
            "reg_lambda": 1.0,
            "min_child_samples": 10,
            "n_jobs": -1,
            "random_state": 42,
            "verbose": -1,
        }

    base_model = lgb.LGBMRegressor(**best_params)
    base_model.fit(
        X_tr, y_tr,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(40, verbose=False)],
    )

    val_preds = base_model.predict(X_val)
    mae = mean_absolute_error(y_val, val_preds)
    print(f"Val MAE: {mae:.3f} karat")

    # MAPIE conformal prediction — 90% coverage interval
    mapie = SplitConformalRegressor(estimator=base_model, confidence_level=0.90, prefit=True)
    mapie.conformalize(X_val, y_val)
    _, intervals = mapie.predict_interval(X_val)
    y_val_arr = np.array(y_val)
    coverage = float(np.mean(
        (y_val_arr >= intervals[:, 0, 0]) & (y_val_arr <= intervals[:, 1, 0])
    ))
    print(f"MAPIE empirical coverage: {coverage:.1%}  (target ≥ 90%)")

    # Feature importance report
    importances = dict(zip(X.columns, base_model.feature_importances_))
    top5 = sorted(importances.items(), key=lambda kv: kv[1], reverse=True)[:5]
    print("Top-5 features:", ", ".join(f"{k}={v}" for k, v in top5))

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    lgb_path = str(Path(out_dir) / "fusion_lgbm.pkl")
    mapie_path = str(Path(out_dir) / "fusion_mapie.pkl")
    with open(lgb_path, "wb") as f:
        pickle.dump(base_model, f)
    with open(mapie_path, "wb") as f:
        pickle.dump(mapie, f)
    print(f"Saved → {lgb_path}  ({os.path.getsize(lgb_path) // 1024} KB)")
    print(f"Saved → {mapie_path}  ({os.path.getsize(mapie_path) // 1024} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="CSV with signal features + target column")
    ap.add_argument("--mode", default="karat", choices=["karat", "authentic"])
    ap.add_argument("--out_dir", default="ml/models")
    ap.add_argument("--optuna_trials", type=int, default=0, help="0 = skip Optuna, use default params")
    args = ap.parse_args()
    train(args.data, args.mode, args.out_dir, args.optuna_trials)
