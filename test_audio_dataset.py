#!/usr/bin/env python3
"""
Run the full audio eval pipeline on every clip in the manifest and report:
  - Per-clip scores (heuristic + classifier)
  - Score distribution with gap analysis
  - Accuracy at different threshold boundaries

Run from repo root:
    python test_audio_dataset.py

or from apps/api/:
    python ../../test_audio_dataset.py
"""

import csv
import os
import sys

import numpy as np

# ── Resolve paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
API_DIR    = os.path.join(SCRIPT_DIR, "apps", "api")
sys.path.insert(0, API_DIR)

MANIFEST  = os.path.join(API_DIR, "data", "audio_gold", "manifest.csv")
MODEL_DIR = os.path.join(API_DIR, "data", "audio_gold")

from app.data.audio_features import (
    build_feature_vector,
    validate_recording,
    preprocess,
    SR_TARGET,
)
from app.routes.audio_eval import _physics_score, _classifier_score, _load_model

# Load classifier model
_load_model()
# Re-import after loading so _MODEL/_SCALER are populated
import app.routes.audio_eval as _eval_mod

import librosa


# ── Helpers ────────────────────────────────────────────────────────────────────

def load_audio(fp: str):
    arr, sr = librosa.load(fp, sr=SR_TARGET, mono=True)
    return arr.astype(np.float32), sr


def bar(score: int, width: int = 40) -> str:
    filled = round(score / 100 * width)
    return "[" + "█" * filled + "·" * (width - filled) + f"] {score:3d}"


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 78)
    print("  AUDIO EVAL — FULL DATASET RUN")
    print("=" * 78)
    print(f"  Manifest : {MANIFEST}")
    print(f"  Model    : {'LOADED (classifier active)' if _eval_mod._MODEL else 'NOT FOUND (heuristic only)'}")
    print()

    with open(MANIFEST, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    results = []
    rejected = []

    for row in rows:
        fp        = row["filepath"].strip()
        label     = row["label"].strip()          # "real" / "fake"
        item_type = row["item_type"].strip()
        mode      = row["mode"].strip()
        item_id   = row["item_id"].strip()
        fname     = os.path.basename(fp)

        if not os.path.exists(fp):
            print(f"  ⚠  MISSING  {fname}")
            rejected.append({"file": fname, "label": label, "reason": "missing"})
            continue

        try:
            arr, sr = load_audio(fp)
        except Exception as e:
            print(f"  ⚠  DECODE   {fname}: {e}")
            rejected.append({"file": fname, "label": label, "reason": f"decode:{e}"})
            continue

        arr = preprocess(arr)
        fv, physics, val = build_feature_vector(arr, sr, item_type, mode)

        if fv is None:
            reason = val.get("reason", "validation_failed")
            print(f"  ✗  REJECT  [{label:4s}|{item_type:7s}|{mode:4s}] {fname[:40]:<40}  — {reason}")
            rejected.append({"file": fname, "label": label, "reason": reason})
            continue

        # Physics heuristic score
        phy_score, phy_reasons = _physics_score(physics, item_type, mode)

        # Classifier score (None if model not loaded)
        clf_score = _classifier_score(fv)

        final_score = clf_score if clf_score is not None else phy_score
        tag = "REAL" if label == "real" else "FAKE"

        results.append({
            "file":      fname,
            "label":     label,
            "item_type": item_type,
            "mode":      mode,
            "item_id":   item_id,
            "phy_score": phy_score,
            "clf_score": clf_score,
            "score":     final_score,
            "physics":   physics,
            "reasons":   phy_reasons,
        })

    # ── Print per-clip table ───────────────────────────────────────────────────
    print(f"\n{'─'*78}")
    print(f"  {'FILE':<42} {'LBL':<4} {'TYPE':>7} {'MODE':>4}  HEUR CLF  FINAL")
    print(f"{'─'*78}")

    for r in sorted(results, key=lambda x: (x["mode"], x["label"], -x["score"])):
        clf_str = f"{r['clf_score']:3d}" if r["clf_score"] is not None else "  -"
        print(
            f"  {r['file'][:42]:<42} "
            f"{'['+r['label'].upper()+']':<4}  "
            f"{r['item_type']:>7} {r['mode']:>4}  "
            f"{r['phy_score']:3d}  {clf_str}  "
            f"{bar(r['score'], 28)}"
        )

    # ── Score summary by label ─────────────────────────────────────────────────
    real_scores = [r["score"] for r in results if r["label"] == "real"]
    fake_scores = [r["score"] for r in results if r["label"] == "fake"]

    print(f"\n{'═'*78}")
    print("  SCORE DISTRIBUTION")
    print(f"{'═'*78}")
    print(f"  Real gold  (n={len(real_scores):2d}):  "
          f"min={min(real_scores):3d}  max={max(real_scores):3d}  "
          f"mean={np.mean(real_scores):5.1f}  median={np.median(real_scores):5.1f}")
    print(f"  Fake/plated(n={len(fake_scores):2d}):  "
          f"min={min(fake_scores):3d}  max={max(fake_scores):3d}  "
          f"mean={np.mean(fake_scores):5.1f}  median={np.median(fake_scores):5.1f}")
    print(f"\n  Gap:  real min ({min(real_scores)}) vs fake max ({max(fake_scores)})")

    # ── Threshold sweep ────────────────────────────────────────────────────────
    print(f"\n{'─'*78}")
    print("  THRESHOLD SWEEP  (score >= threshold → verdict = 'likely real')")
    print(f"  {'Threshold':>9}  {'TP':>4} {'FP':>4} {'FN':>4} {'TN':>4}  "
          f"{'Sensitivity':>11} {'Specificity':>11} {'Accuracy':>8}")
    print(f"{'─'*78}")

    all_scores = [(r["score"], r["label"]) for r in results]
    best = {"acc": 0, "thr": 50, "tp": 0, "fp": 0, "fn": 0, "tn": 0}

    for thr in range(30, 90, 5):
        tp = sum(1 for s, l in all_scores if s >= thr and l == "real")
        fp = sum(1 for s, l in all_scores if s >= thr and l == "fake")
        fn = sum(1 for s, l in all_scores if s <  thr and l == "real")
        tn = sum(1 for s, l in all_scores if s <  thr and l == "fake")
        total = tp + fp + fn + tn
        acc = (tp + tn) / total if total else 0
        sens = tp / (tp + fn) if (tp + fn) else 0
        spec = tn / (tn + fp) if (tn + fp) else 0
        marker = "  ◄ BEST" if acc > best["acc"] else ""
        if acc > best["acc"]:
            best = {"acc": acc, "thr": thr, "tp": tp, "fp": fp, "fn": fn, "tn": tn}
        print(f"  {thr:>9}  {tp:4d} {fp:4d} {fn:4d} {tn:4d}  "
              f"{sens:>11.0%} {spec:>11.0%} {acc:>8.0%}{marker}")

    # ── Clear boundary summary ─────────────────────────────────────────────────
    print(f"\n{'═'*78}")
    print("  BOUNDARY RECOMMENDATION")
    print(f"{'═'*78}")
    print(f"  Best threshold: score >= {best['thr']}")
    print(f"  Accuracy:  {best['acc']:.0%}   (TP={best['tp']} FP={best['fp']} FN={best['fn']} TN={best['tn']})")
    print()

    # Show misclassified clips at best threshold
    misses = [r for r in results
              if (r["score"] >= best["thr"]) != (r["label"] == "real")]
    if misses:
        print(f"  Misclassified at threshold {best['thr']}:")
        for r in misses:
            pred = "PRED-REAL" if r["score"] >= best["thr"] else "PRED-FAKE"
            print(f"    [{r['label'].upper():4s}→{pred}] score={r['score']:3d}  "
                  f"{r['item_type']:8s}|{r['mode']:4s}  {r['file'][:45]}")
            if r.get("reasons"):
                for reason in r["reasons"]:
                    print(f"      • {reason}")
    else:
        print(f"  No misclassifications at threshold {best['thr']} ✓")

    # ── Mode split analysis ────────────────────────────────────────────────────
    for mode in ("tap", "drop"):
        mode_res = [r for r in results if r["mode"] == mode]
        if not mode_res:
            continue
        r_scores = [r["score"] for r in mode_res if r["label"] == "real"]
        f_scores = [r["score"] for r in mode_res if r["label"] == "fake"]
        print(f"\n  {mode.upper()} MODE  (real n={len(r_scores)}, fake n={len(f_scores)})")
        if r_scores:
            print(f"    Real:  min={min(r_scores):3d}  max={max(r_scores):3d}  mean={np.mean(r_scores):5.1f}")
        if f_scores:
            print(f"    Fake:  min={min(f_scores):3d}  max={max(f_scores):3d}  mean={np.mean(f_scores):5.1f}")
        if r_scores and f_scores:
            gap = min(r_scores) - max(f_scores)
            print(f"    Gap:   {gap:+d} (positive = no overlap ✓, negative = overlap ✗)")

    # ── Physics feature breakdown for understanding ────────────────────────────
    print(f"\n{'─'*78}")
    print("  KEY PHYSICS FEATURES")
    print(f"  {'FILE':<35} {'LBL':4} {'MODE':4}  {'DECAY':>7} {'CENTRD':>7} {'GOLD%':>6} {'R²':>5} {'SNR':>5}")
    print(f"{'─'*78}")
    for r in sorted(results, key=lambda x: (x["mode"], x["label"])):
        p = r["physics"]
        print(
            f"  {r['file'][:35]:<35} {r['label']:4s} {r['mode']:4s}  "
            f"{p['decay_ms']:>7.0f} {p['centroid_hz']:>7.0f} "
            f"{p['gold_ratio']:>6.1%} {p['decay_r2']:>5.2f} {p['snr_db']:>5.1f}"
        )

    # ── Rejected summary ───────────────────────────────────────────────────────
    if rejected:
        print(f"\n{'─'*78}")
        print(f"  REJECTED / MISSING ({len(rejected)} clips)")
        for r in rejected:
            print(f"    [{r['label'].upper():4s}] {r['file']:<45}  {r['reason']}")

    print(f"\n{'═'*78}")
    print("  DONE")
    print(f"{'═'*78}\n")


if __name__ == "__main__":
    main()
