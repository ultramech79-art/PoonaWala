#!/usr/bin/env python3
"""
Gold acoustic authenticity classifier — training script v4.

v4 (ring-down CYCLES + bounce-truncated decay):
  - Trains on the COMPACT physics-only vector (audio_features.MODEL_FEATURES):
    q_cycles (log), decay_r2, q_factor, gold_ratio + mode bit. The 120 MFCCs and
    snr_db are deliberately excluded — on 33 clips MFCCs let the model memorise
    each recording (perfect train, ~0.44 held-out AUC) and snr_db is a recording-
    loudness artifact, not physics.
  - q_cycles = π·f·τ (ring-down cycles) is the mass-independent damping signature.
    It makes small gold RINGS separate from fakes where raw decay TIME is inverted
    (a solid gold ring decays fast but at high frequency = many cycles = high Q; a
    hollow fake rings longer but at low frequency = fewer cycles). Bangles still work.
  - measure_decay now truncates the Schroeder integral at the first rebound, so a
    bouncing drop measures the clean single ring-down (fixes the same gold ring
    reading 625 ms vs 3000 ms across two recordings).
  - Sigmoid (Platt) calibration; regularized linear models; shallow RF baseline.

Honest LeaveOneGroupOut CV on the current 33 clips: ~67% acc / 0.66 AUC, bangles
~86%, and the held-out deployed gold rings now score correctly (~0.85) where the
old raw-decay model failed them (~0.12). A hollow imitation that rings many cycles
can still read gold — that residual is physics, not a bug.

Dataset:   data/audio_gold/manifest.csv
Features:  4 physics metrics + 1 mode bit = 5 dims (see audio_features.MODEL_FEATURES)
Output:    data/audio_gold/model.joblib + data/audio_gold/feature_scaler.joblib
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
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict, StratifiedKFold
from sklearn.metrics import accuracy_score, confusion_matrix, roc_auc_score

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
MANIFEST     = os.path.join(SCRIPT_DIR, "data/audio_gold/manifest.csv")
MODEL_OUT    = os.path.join(SCRIPT_DIR, "data/audio_gold/model.joblib")
SCALER_OUT   = os.path.join(SCRIPT_DIR, "data/audio_gold/feature_scaler.joblib")

# ── Lazy import of the shared feature module ───────────────────────────────────
sys.path.insert(0, SCRIPT_DIR)
from app.data.audio_features import (
    build_feature_vector, build_model_vector, SR_TARGET, PHYSICS_KEYS, MODEL_FEATURES,
)


def load_audio(filepath: str) -> tuple:
    """Load any format (m4a, opus, wav) via librosa/ffmpeg at target SR."""
    arr, sr = librosa.load(filepath, sr=SR_TARGET, mono=True)
    return arr.astype(np.float32), sr


def build_dataset(manifest_path: str):
    """
    Returns:
        X          — (N, F) float32 feature matrix
        y          — (N,) int  labels (1=real, 0=fake)
        groups     — (N,) str  item_id for LeaveOneGroupOut
        meta       — list of dicts with per-clip info
        failed     — list of (filepath, reason) that failed validation
    """
    with open(manifest_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    X, y, groups, meta, failed = [], [], [], [], []

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

        # Train on the compact physics-only vector (NOT the 134-dim fv) so the
        # model can't memorise MFCCs or latch onto the SNR recording artifact.
        X.append(build_model_vector(physics, mode))
        y.append(label)
        groups.append(item_id)
        meta.append({
            "file": os.path.basename(fp),
            "label": label,
            "item_type": item_type,
            "mode": mode,
            "item_id": item_id,
            "physics": physics,
        })

    return np.array(X, dtype=np.float32), np.array(y, dtype=int), np.array(groups), meta, failed


def print_physics_table(meta: list):
    """Print a table showing key physics features per clip with REAL/FAKE label."""
    print("\n── Per-clip physics diagnostics ──────────────────────────────────────────────")
    print(f"  {'LABEL':4s} {'TYPE':8s} {'MODE':4s} {'decay_ms':>8s} {'tau_ms':>7s} {'R²':>5s} {'gold%':>6s} {'hf%':>5s} {'snr':>4s}  {'FILE'}")
    print("  " + "-"*110)

    # Sort: drop first, then tap, within each: real before fake
    sorted_meta = sorted(meta, key=lambda m: (m["mode"] == "tap", m["label"] == 0))

    real_drop_decays, fake_drop_decays = [], []
    real_tap_decays, fake_tap_decays   = [], []
    real_drop_taus,  fake_drop_taus    = [], []

    for m in sorted_meta:
        p = m["physics"]
        tag = "REAL" if m["label"] == 1 else "FAKE"
        tau = p.get("tau_ms", 0)
        print(f"  {tag:4s} {m['item_type']:8s} {m['mode']:4s} {p['decay_ms']:8.1f} {tau:7.1f} {p['decay_r2']:5.2f} {p['gold_ratio']:6.1%} {p['hf_ratio']:5.1%} {p['snr_db']:4.0f}  {m['file'][:55]}")

        if m["mode"] == "drop":
            if m["label"] == 1:
                real_drop_decays.append(p["decay_ms"])
                real_drop_taus.append(tau)
            else:
                fake_drop_decays.append(p["decay_ms"])
                fake_drop_taus.append(tau)
        else:
            if m["label"] == 1:
                real_tap_decays.append(p["decay_ms"])
            else:
                fake_tap_decays.append(p["decay_ms"])

    print()
    if real_drop_decays and fake_drop_decays:
        print(f"  DROP decay_ms  — REAL: mean={np.mean(real_drop_decays):.1f}ms  min={np.min(real_drop_decays):.1f}ms  max={np.max(real_drop_decays):.1f}ms")
        print(f"  DROP decay_ms  — FAKE: mean={np.mean(fake_drop_decays):.1f}ms  min={np.min(fake_drop_decays):.1f}ms  max={np.max(fake_drop_decays):.1f}ms")
        if real_drop_taus and fake_drop_taus:
            print(f"  DROP tau_ms    — REAL: mean={np.mean(real_drop_taus):.1f}ms  min={np.min(real_drop_taus):.1f}ms  max={np.max(real_drop_taus):.1f}ms")
            print(f"  DROP tau_ms    — FAKE: mean={np.mean(fake_drop_taus):.1f}ms  min={np.min(fake_drop_taus):.1f}ms  max={np.max(fake_drop_taus):.1f}ms")
        overlap = max(0, min(max(real_drop_decays), max(fake_drop_decays)) - max(min(real_drop_decays), min(fake_drop_decays)))
        print(f"  DROP decay overlap: {overlap:.1f}ms {'⚠ OVERLAPPING' if overlap > 10 else '✓ SEPARATED'}")
    if real_tap_decays and fake_tap_decays:
        print(f"  TAP  decay_ms  — REAL: mean={np.mean(real_tap_decays):.1f}ms  min={np.min(real_tap_decays):.1f}ms  max={np.max(real_tap_decays):.1f}ms")
        print(f"  TAP  decay_ms  — FAKE: mean={np.mean(fake_tap_decays):.1f}ms  min={np.min(fake_tap_decays):.1f}ms  max={np.max(fake_tap_decays):.1f}ms")


def logo_cv(name: str, clf_factory, X_scaled: np.ndarray, y: np.ndarray, groups: np.ndarray) -> dict:
    """Run LeaveOneGroupOut cross-validation and return metrics."""
    logo = LeaveOneGroupOut()
    n_splits = logo.get_n_splits(X_scaled, y, groups)

    # Sigmoid (Platt) calibration — isotonic over-fits on this few clips and was the
    # reason the old model showed perfect train scores but coin-flip held-out AUC.
    clf = CalibratedClassifierCV(clf_factory(), cv=min(3, n_splits // 2 + 1), method="sigmoid")
    y_pred = cross_val_predict(clf, X_scaled, y, groups=groups, cv=logo, method="predict")
    y_prob = cross_val_predict(clf, X_scaled, y, groups=groups, cv=logo, method="predict_proba")

    acc = accuracy_score(y, y_pred)
    cm  = confusion_matrix(y, y_pred)
    try:
        auc = roc_auc_score(y, y_prob[:, 1])
    except Exception:
        auc = float("nan")

    # Wilson score 95% CI
    n = len(y)
    z, p_hat = 1.96, acc
    denom  = 1 + z**2 / n
    center = (p_hat + z**2 / (2*n)) / denom
    margin = (z * np.sqrt(p_hat*(1-p_hat)/n + z**2/(4*n**2))) / denom
    ci_lo, ci_hi = max(0.0, center - margin), min(1.0, center + margin)

    return {
        "name": name, "acc": acc, "auc": auc, "ci": (ci_lo, ci_hi),
        "cm": cm, "n_splits": n_splits, "y_pred": y_pred, "y_prob": y_prob,
    }


def find_best_drop_threshold(meta: list):
    """
    Use the dataset to find the optimal decay_ms and tau_ms thresholds
    that separate real vs fake on DROP mode clips, printed for reference.
    """
    drop_clips = [(m["physics"]["decay_ms"], m["physics"].get("tau_ms", 0), m["label"]) for m in meta if m["mode"] == "drop"]
    if len(drop_clips) < 4:
        return
    decays = np.array([c[0] for c in drop_clips])
    taus   = np.array([c[1] for c in drop_clips])
    labels = np.array([c[2] for c in drop_clips])

    print("\n── Best drop-mode threshold search ──────────────────────────────────")
    best_acc, best_thr, best_key = 0, 0, "decay_ms"
    for key, vals in [("decay_ms", decays), ("tau_ms", taus)]:
        for thr in np.percentile(vals, np.arange(10, 91, 5)):
            preds = (vals >= thr).astype(int)
            acc = accuracy_score(labels, preds)
            if acc > best_acc:
                best_acc, best_thr, best_key = acc, thr, key
    print(f"  Best single-feature threshold: {best_key} >= {best_thr:.1f}ms  → acc={best_acc:.0%}")

    # Show where real and fake land relative to this threshold
    for key, vals in [("decay_ms", decays), ("tau_ms", taus)]:
        real_v = vals[labels == 1]
        fake_v = vals[labels == 0]
        if len(real_v) and len(fake_v):
            margin = np.min(real_v) - np.max(fake_v)
            print(f"  {key:10s}  REAL min={np.min(real_v):.1f}  FAKE max={np.max(fake_v):.1f}  margin={margin:+.1f}ms "
                  f"{'✓ CLEAN SEPARATION' if margin > 0 else '✗ OVERLAP'}")

    return best_thr, best_key


def main():
    print("=" * 75)
    print("Gold Acoustic Classifier — Training v2 (with rebound suppression + τ fit)")
    print("=" * 75)
    print(f"\nManifest: {MANIFEST}")
    print("\n── Loading and feature-extracting clips ──────────────────────────────────")

    X, y, groups, meta, failed = build_dataset(MANIFEST)

    print(f"\n── Dataset summary ───────────────────────────────────────────────────────")
    print(f"  Loaded:   {len(X)} clips")
    print(f"  Rejected: {len(failed)} clips")
    if failed:
        for fp, reason in failed:
            print(f"    ⚠  {os.path.basename(fp)}: {reason}")
    print(f"  Real:     {int(np.sum(y == 1))}   Fake: {int(np.sum(y == 0))}")
    unique_groups = list(dict.fromkeys(groups))
    print(f"  Groups (item_ids): {len(unique_groups)}")

    # ── Print full physics diagnostics ────────────────────────────────────────
    print_physics_table(meta)

    # ── Find best threshold from data ────────────────────────────────────────
    find_best_drop_threshold(meta)

    if len(X) < 6:
        print("\n❌  Too few valid clips to train. Add more recordings.")
        return

    # ── Scale features ────────────────────────────────────────────────────────
    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # ── LeaveOneGroupOut cross-validation ─────────────────────────────────────
    print("\n── LeaveOneGroupOut cross-validation ────────────────────────────────────")
    print("  (Groups = item_id — same physical piece never in train and test)\n")

    n_unique = len(unique_groups)
    cal_cv   = min(3, max(2, n_unique // 4))

    # Candidates suited to a compact 5-feature input. Regularized linear models
    # generalise best here; the shallow tree is kept only as a sanity baseline.
    results = []
    for name, factory in [
        ("LogisticRegression", lambda: LogisticRegression(C=0.5, max_iter=5000, class_weight="balanced", solver="lbfgs")),
        ("LogReg C=1.0",       lambda: LogisticRegression(C=1.0, max_iter=5000, class_weight="balanced", solver="lbfgs")),
        ("SVC linear",         lambda: SVC(kernel="linear", C=0.5, probability=True, class_weight="balanced")),
        ("SVC rbf",            lambda: SVC(kernel="rbf",    C=2.0, gamma="scale", probability=True, class_weight="balanced")),
        ("RandomForest d3",    lambda: RandomForestClassifier(n_estimators=300, max_depth=3, min_samples_leaf=3, class_weight="balanced", random_state=42)),
    ]:
        try:
            r = logo_cv(name, factory, X_scaled, y, groups)
            results.append(r)
            tn, fp_n, fn, tp = r["cm"].ravel() if r["cm"].size == 4 else (0, 0, 0, 0)
            sens = tp / (tp + fn + 1e-9)
            spec = tn / (tn + fp_n + 1e-9)
            print(f"  {r['name']:22s}  acc={r['acc']:.0%}  auc={r['auc']:.2f}  95%CI=[{r['ci'][0]:.0%},{r['ci'][1]:.0%}]")
            print(f"    TP={tp}  FP={fp_n}  FN={fn}  TN={tn}   Sensitivity={sens:.0%}  Specificity={spec:.0%}")
            print()
        except Exception as e:
            print(f"  {name}: FAILED ({e})")

    if not results:
        print("❌  All classifiers failed.")
        return

    # ── Pick best model: prioritise AUC, then accuracy ─────────────────────
    print("── Training final model on full dataset ──────────────────────────────────")
    best = max(results, key=lambda r: (r["auc"] if not np.isnan(r["auc"]) else 0, r["acc"]))
    print(f"  Best model: {best['name']}  (acc={best['acc']:.0%}, auc={best['auc']:.2f})")

    # Rebuild the chosen factory
    factory_map = {
        "LogisticRegression": lambda: LogisticRegression(C=0.5, max_iter=5000, class_weight="balanced", solver="lbfgs"),
        "LogReg C=1.0":       lambda: LogisticRegression(C=1.0, max_iter=5000, class_weight="balanced", solver="lbfgs"),
        "SVC linear":         lambda: SVC(kernel="linear", C=0.5, probability=True, class_weight="balanced"),
        "SVC rbf":            lambda: SVC(kernel="rbf",    C=2.0, gamma="scale", probability=True, class_weight="balanced"),
        "RandomForest d3":    lambda: RandomForestClassifier(n_estimators=300, max_depth=3, min_samples_leaf=3, class_weight="balanced", random_state=42),
    }
    base     = factory_map[best["name"]]()
    final_clf = CalibratedClassifierCV(base, cv=cal_cv, method="sigmoid")
    final_clf.fit(X_scaled, y)

    # ── Feature importance (if RF or GB) ─────────────────────────────────────
    try:
        inner = final_clf.calibrated_classifiers_[0].estimator
        if hasattr(inner, "feature_importances_"):
            fi = inner.feature_importances_
            all_keys = MODEL_FEATURES + ["mode_bin"]
            top_n = len(all_keys)
            top_idx = np.argsort(fi)[::-1][:top_n]
            print(f"\n  Top {top_n} features by importance:")
            for rank, i in enumerate(top_idx, 1):
                key = all_keys[i] if i < len(all_keys) else f"feat_{i}"
                print(f"    {rank:2d}. {key:25s}  {fi[i]:.4f}")
    except Exception:
        pass

    # ── Predict on training set — per clip confidence ─────────────────────────
    print("\n── Training set predictions (sanity check) ──────────────────────────────")
    probs = final_clf.predict_proba(X_scaled)[:, 1]
    for i, m in enumerate(meta):
        tag  = "REAL" if m["label"] == 1 else "FAKE"
        prob = probs[i]
        icon = "✓" if (prob >= 0.5) == (m["label"] == 1) else "✗"
        print(f"  {icon} {tag:4s} [{m['item_type']:8s}|{m['mode']:4s}]  P(real)={prob:.2f}  {m['file'][:55]}")

    # ── Save ─────────────────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    joblib.dump(final_clf, MODEL_OUT)
    joblib.dump(scaler,    SCALER_OUT)
    print(f"\n  ✅  Saved model  → {MODEL_OUT}")
    print(f"  ✅  Saved scaler → {SCALER_OUT}")

    print("""
╔══════════════════════════════════════════════════════════════════════════╗
║  ⚠️   POC SCALE WARNING — READ BEFORE TRUSTING                          ║
╠══════════════════════════════════════════════════════════════════════════╣
║  33 clips / ~20 item groups. Accuracy figures are ILLUSTRATIVE.          ║
║  For production you need: 15-20 clips per (type × mode × label) cell.   ║
║  Priority: ring/drop, ring/tap, bangle/drop (least data currently).     ║
╚══════════════════════════════════════════════════════════════════════════╝
""")


if __name__ == "__main__":
    main()
