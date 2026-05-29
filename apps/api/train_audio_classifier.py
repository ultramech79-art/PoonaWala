#!/usr/bin/env python3
"""
Gold acoustic authenticity classifier — training script.

Dataset:   data/audio_gold/manifest.csv
Features:  12 physics metrics + 120 MFCC (40 + delta + delta-delta) + 1 mode bit = 133 dims
Classifier: SVC(linear, probability=True) + LogisticRegression, both via CalibratedClassifierCV
Evaluation: LeaveOneGroupOut on item_id (prevents item/device leakage)
Output:    data/audio_gold/model.joblib + data/audio_gold/feature_scaler.joblib

⚠️  POC SCALE WARNING:
    This dataset has ~33 clips across ~20 item groups.
    ~2–3 examples per (item_type × mode × label) cell.
    Accuracy numbers are ILLUSTRATIVE ONLY — not shippable.
    See the sample-size recommendation printed at the end.
"""

import csv
import os
import sys
import warnings
import logging

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.WARNING)

import numpy as np
import joblib
import librosa

from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict
from sklearn.metrics import accuracy_score, confusion_matrix

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
MANIFEST     = os.path.join(SCRIPT_DIR, "data/audio_gold/manifest.csv")
MODEL_OUT    = os.path.join(SCRIPT_DIR, "data/audio_gold/model.joblib")
SCALER_OUT   = os.path.join(SCRIPT_DIR, "data/audio_gold/feature_scaler.joblib")

# ── Lazy import of the shared feature module ───────────────────────────────────
sys.path.insert(0, SCRIPT_DIR)
from app.data.audio_features import build_feature_vector, SR_TARGET


def load_audio(filepath: str) -> tuple[np.ndarray, int]:
    """Load any format (m4a, opus, wav) via librosa/ffmpeg at target SR."""
    arr, sr = librosa.load(filepath, sr=SR_TARGET, mono=True)
    return arr.astype(np.float32), sr


def build_dataset(manifest_path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, list]:
    """
    Returns:
        X          — (N, F) float32 feature matrix
        y          — (N,) int  labels (1=real, 0=fake)
        groups     — (N,) str  item_id for LeaveOneGroupOut
        failed     — list of (filepath, reason) that failed validation
    """
    with open(manifest_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    X, y, groups, failed = [], [], [], []

    for row in rows:
        fp        = row["filepath"].strip()
        label     = 1 if row["label"].strip() == "real" else 0
        item_type = row["item_type"].strip()
        mode      = row["mode"].strip()
        item_id   = row["item_id"].strip()

        if not os.path.exists(fp):
            print(f"  ⚠  MISSING: {os.path.basename(fp)}")
            failed.append((fp, "file_not_found"))
            continue

        try:
            arr, sr = load_audio(fp)
        except Exception as e:
            print(f"  ⚠  DECODE ERROR {os.path.basename(fp)}: {e}")
            failed.append((fp, f"decode_error: {e}"))
            continue

        fv, physics, val = build_feature_vector(arr, sr, item_type, mode)
        if fv is None:
            reason = val.get("reason", "validation_failed")
            print(f"  ✗  REJECTED {os.path.basename(fp)} [{label}]: {reason}")
            failed.append((fp, reason))
            continue

        X.append(fv)
        y.append(label)
        groups.append(item_id)
        tag = "REAL" if label == 1 else "FAKE"
        print(f"  ✓  {tag:4s} [{item_type:8s}|{mode:4s}] {os.path.basename(fp)[:45]:<45} "
              f"decay={physics['decay_ms']:5.0f}ms  snr={physics['snr_db']:4.0f}dB  "
              f"r2={physics['decay_r2']:.2f}")

    return np.array(X, dtype=np.float32), np.array(y, dtype=int), np.array(groups), failed


def logo_cv(name: str, clf_factory, X_scaled: np.ndarray, y: np.ndarray, groups: np.ndarray) -> dict:
    """Run LeaveOneGroupOut cross-validation and return metrics."""
    logo = LeaveOneGroupOut()
    n_splits = logo.get_n_splits(X_scaled, y, groups)

    clf = CalibratedClassifierCV(clf_factory(), cv=3, method="isotonic")
    y_pred = cross_val_predict(clf, X_scaled, y, groups=groups, cv=logo, method="predict")
    y_prob = cross_val_predict(clf, X_scaled, y, groups=groups, cv=logo, method="predict_proba")

    acc = accuracy_score(y, y_pred)
    cm  = confusion_matrix(y, y_pred)

    # Wilson score 95% confidence interval
    n = len(y)
    z = 1.96
    p_hat = acc
    denom = 1 + z**2 / n
    center = (p_hat + z**2 / (2*n)) / denom
    margin = (z * np.sqrt(p_hat*(1-p_hat)/n + z**2/(4*n**2))) / denom
    ci_lo, ci_hi = max(0.0, center - margin), min(1.0, center + margin)

    return {
        "name": name, "acc": acc, "ci": (ci_lo, ci_hi),
        "cm": cm, "n_splits": n_splits, "y_pred": y_pred,
    }


def main():
    print("=" * 70)
    print("Gold Acoustic Classifier — Training")
    print("=" * 70)
    print(f"\nManifest: {MANIFEST}")
    print("\n── Loading and feature-extracting clips ──────────────────────────────")

    X, y, groups, failed = build_dataset(MANIFEST)

    print(f"\n── Dataset summary ───────────────────────────────────────────────────")
    print(f"  Loaded:   {len(X)} clips")
    print(f"  Rejected: {len(failed)} clips")
    print(f"  Real:     {int(np.sum(y == 1))}   Fake: {int(np.sum(y == 0))}")
    unique_groups = list(dict.fromkeys(groups))
    print(f"  Groups (item_ids): {len(unique_groups)}")
    for g in unique_groups:
        mask = groups == g
        lbl  = "REAL" if y[mask][0] == 1 else "FAKE"
        print(f"    {g:30s}  {int(mask.sum())} clips  [{lbl}]")

    if len(X) < 6:
        print("\n❌  Too few valid clips to train. Add more recordings.")
        return

    # ── Scale features ─────────────────────────────────────────────────────────
    scaler  = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # ── LeaveOneGroupOut cross-validation ──────────────────────────────────────
    print("\n── LeaveOneGroupOut cross-validation ─────────────────────────────────")
    print("  (Groups = item_id — same physical piece never in train and test)\n")

    results = []
    for name, factory in [
        ("SVC linear",          lambda: SVC(kernel="linear", C=1.0, probability=True, class_weight="balanced")),
        ("LogisticRegression",  lambda: LogisticRegression(C=0.5, max_iter=1000, class_weight="balanced", solver="lbfgs")),
    ]:
        r = logo_cv(name, factory, X_scaled, y, groups)
        results.append(r)
        print(f"  {r['name']:22s}  acc={r['acc']:.0%}  95%CI=[{r['ci'][0]:.0%},{r['ci'][1]:.0%}]  "
              f"(n_splits={r['n_splits']})")
        tn, fp, fn, tp = r["cm"].ravel() if r["cm"].size == 4 else (0, 0, 0, 0)
        print(f"    Confusion matrix:  TP={tp}  FP={fp}  FN={fn}  TN={tn}")
        print(f"    Sensitivity (real gold detected): {tp/(tp+fn+1e-9):.0%}")
        print(f"    Specificity (fake caught):        {tn/(tn+fp+1e-9):.0%}")
        print()

    # ── Train final model on ALL data ─────────────────────────────────────────
    print("── Training final model on full dataset ──────────────────────────────")
    best = min(results, key=lambda r: -r["acc"])  # pick best accuracy
    print(f"  Using: {best['name']}")

    if best["name"].startswith("SVC"):
        base = SVC(kernel="linear", C=1.0, probability=True, class_weight="balanced")
    else:
        base = LogisticRegression(C=0.5, max_iter=1000, class_weight="balanced", solver="lbfgs")

    # CalibratedClassifierCV with cv='prefit' would need separate cal set.
    # With 33 samples we train on all and use cv=3 for calibration.
    final_clf = CalibratedClassifierCV(base, cv=min(3, len(unique_groups)), method="isotonic")
    final_clf.fit(X_scaled, y)

    joblib.dump(final_clf, MODEL_OUT)
    joblib.dump(scaler,    SCALER_OUT)
    print(f"  Saved model  → {MODEL_OUT}")
    print(f"  Saved scaler → {SCALER_OUT}")

    # ── POC scale warning ─────────────────────────────────────────────────────
    print("""
╔══════════════════════════════════════════════════════════════════════╗
║  ⚠️   POC SCALE WARNING — READ BEFORE DEPLOYING                     ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  This dataset has ~33 clips across ~20 item groups.                  ║
║  ~2–3 examples per (item_type × mode × label) cell.                  ║
║  Accuracy numbers above are ILLUSTRATIVE ONLY.                       ║
║                                                                      ║
║  Minimum recommended clips before trusting this in production:       ║
║                                                                      ║
║  Cell = (item_type × mode × label):  15–20 clips per cell           ║
║                                                                      ║
║  Priority cells (highest commercial volume):                         ║
║    ring   × tap  × real    ← currently ~9 clips, need 15+           ║
║    ring   × drop × real    ← currently ~5 clips, need 15+           ║
║    ring   × tap  × fake    ← currently ~4 clips, need 15+           ║
║    bangle × tap  × real    ← currently ~4 clips, need 15+           ║
║    bangle × drop × real    ← currently ~2 clips, need 15+           ║
║    necklace × *  × *       ← 2 per cell, essentially untestable     ║
║                                                                      ║
║  Fundamental weakness — chains/necklaces:                            ║
║    Multiple links = overlapping decays = exp-decay-R² is            ║
║    meaningless. Physics score is a heuristic for these items.        ║
║    Acoustic discrimination for chains needs 50+ clips minimum.       ║
║                                                                      ║
║  Total target before production: ~400 clips (~10 items × 2 modes    ║
║    × 2 labels × 10 recordings each), recorded on 3+ devices.        ║
╚══════════════════════════════════════════════════════════════════════╝
""")


if __name__ == "__main__":
    main()
