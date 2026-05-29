"""
Shared audio feature extraction for gold acoustic authentication.

Used by BOTH:
  - train_audio_classifier.py  (offline training)
  - routes/audio_eval.py       (inference)

Do not import FastAPI or any web-framework code here.
"""
import logging
from typing import Optional

import numpy as np
import scipy.signal as ss

logger = logging.getLogger("goldeye.audio_features")

# ── Constants ──────────────────────────────────────────────────────────────────

SR_TARGET = 22050          # resample everything to this for consistent features
N_MFCC    = 40             # MFCC coefficients (40 per 2025 Applied Acoustics paper)
N_FFT     = 2048
HOP_LEN   = 512

SOFT_ITEMS   = {"chain", "necklace", "earring"}
COMPACT_ITEMS = {"ring", "bangle", "coin", "bar"}

_ORNAMENT_RANGES = {
    "ring":     {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 400, "centroid_hi": 1000},
    "bangle":   {"decay_lo": 100, "decay_hi": 600, "centroid_lo": 200, "centroid_hi": 600},
    "chain":    {"decay_lo": 35,  "decay_hi": 260, "centroid_lo": 250, "centroid_hi": 1200},
    "necklace": {"decay_lo": 45,  "decay_hi": 360, "centroid_lo": 180, "centroid_hi": 900},
    "pendant":  {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 350, "centroid_hi": 1200},
    "earring":  {"decay_lo": 30,  "decay_hi": 200, "centroid_lo": 400, "centroid_hi": 1600},
    "coin":     {"decay_lo": 150, "decay_hi": 700, "centroid_lo": 250, "centroid_hi": 650},
}
_DEFAULT_RANGE = {"decay_lo": 60, "decay_hi": 450, "centroid_lo": 250, "centroid_hi": 1000}


# ── Low-level helpers ──────────────────────────────────────────────────────────

def preprocess(arr: np.ndarray) -> np.ndarray:
    arr = np.nan_to_num(arr.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    if len(arr) == 0:
        return arr
    arr = arr - float(np.mean(arr))
    mx = float(np.max(np.abs(arr)))
    if mx > 1.5:
        arr = arr / mx
    return arr


def smooth_abs(arr: np.ndarray, sr: int, win_ms: float = 4.0) -> np.ndarray:
    win = max(1, int(sr * win_ms / 1000.0))
    return np.convolve(np.abs(arr), np.ones(win, dtype=np.float32) / win, mode="same")


def exp_decay_r2(envelope: np.ndarray) -> float:
    """R² of exponential fit. Real gold > 0.85 for drops."""
    if len(envelope) < 20:
        return 0.0
    try:
        t = np.arange(len(envelope), dtype=np.float64)
        log_y = np.log(np.maximum(envelope, 1e-10))
        t_m, ly_m = np.mean(t), np.mean(log_y)
        slope = np.sum((t - t_m) * (log_y - ly_m)) / (np.sum((t - t_m) ** 2) + 1e-10)
        pred = ly_m + slope * (t - t_m)
        ss_res = np.sum((log_y - pred) ** 2)
        ss_tot = np.sum((log_y - ly_m) ** 2) + 1e-10
        return float(np.clip(1.0 - ss_res / ss_tot, 0.0, 1.0))
    except Exception:
        return 0.0


def spectral_flatness(spectrum: np.ndarray) -> float:
    safe = np.maximum(spectrum, 1e-10)
    return float(np.clip(np.exp(np.mean(np.log(safe))) / (np.mean(safe) + 1e-10), 0.0, 1.0))


def detect_impacts(arr: np.ndarray, sr: int) -> list:
    """
    Detect metallic impact events using spectral flux (primary) with amplitude fallback.

    Spectral flux measures frame-to-frame spectral change — works on poor/quiet mics
    because a metallic tap causes a distinctive frequency shift even at low amplitude.
    Amplitude-only thresholds fail when the mic is far away or gain is low.
    """
    # ── Primary: spectral flux onset detection (librosa) ──────────────────────
    if _check_librosa():
        try:
            import librosa
            y = librosa.resample(arr.astype(np.float32), orig_sr=sr, target_sr=SR_TARGET) if sr != SR_TARGET else arr
            # onset_detect uses spectral flux by default — robust to quiet mics
            onset_frames = librosa.onset.onset_detect(
                y=y, sr=SR_TARGET,
                hop_length=HOP_LEN,
                backtrack=True,          # snap to actual attack, not flux peak
                pre_max=3, post_max=3,   # local max window
                pre_avg=5, post_avg=5,
                delta=0.04,              # low delta = catch quiet impacts too
                wait=4,
            )
            if len(onset_frames) > 0:
                onset_samples = librosa.frames_to_samples(onset_frames, hop_length=HOP_LEN)
                # Scale sample indices back to original sr if resampled
                if sr != SR_TARGET:
                    onset_samples = (onset_samples * sr / SR_TARGET).astype(int)
                onset_samples = np.clip(onset_samples, 0, len(arr) - 1)
                envelope = smooth_abs(arr, sr, 4.0)
                events = []
                for s in onset_samples:
                    e = min(len(arr) - 1, s + int(sr * 0.5))
                    pi = s + int(np.argmax(envelope[s:e + 1]))
                    pi = min(pi, len(envelope) - 1)
                    events.append({"start": int(s), "end": int(e), "peak_idx": int(pi), "peak": float(envelope[pi])})
                events.sort(key=lambda x: x["peak"], reverse=True)
                return events[:8]
        except Exception as e:
            logger.warning("librosa onset detection failed, falling back: %s", e)

    # ── Fallback: amplitude envelope threshold ─────────────────────────────────
    envelope = smooth_abs(arr, sr, 4.0)
    if not len(envelope):
        return []
    peak = float(np.max(envelope))
    if peak < 1e-5:
        return []
    baseline = float(np.percentile(envelope, 30))
    # Adaptive threshold: 3× local baseline (was 5×) — catches quieter impacts
    threshold = max(baseline * 3.0, peak * 0.06, 1e-5)
    above = np.where(envelope >= threshold)[0]
    if not len(above):
        return []

    events, start, prev = [], int(above[0]), int(above[0])
    gap = max(1, int(sr * 0.035))
    for idx in above[1:]:
        idx = int(idx)
        if idx - prev > gap:
            events.append({"start": start, "end": prev})
            start = idx
        prev = idx
    events.append({"start": start, "end": prev})

    min_gap = int(sr * 0.075)
    merged = []
    for ev in events:
        if not merged or ev["start"] - merged[-1]["peak_idx"] > min_gap:
            s, e = ev["start"], min(len(envelope) - 1, ev["end"])
            pi = s + int(np.argmax(envelope[s:e + 1]))
            merged.append({"start": s, "end": e, "peak_idx": pi, "peak": float(envelope[pi])})
        elif ev["end"] > merged[-1]["end"]:
            merged[-1]["end"] = ev["end"]

    merged.sort(key=lambda x: x["peak"], reverse=True)
    return merged[:8]


def attack_ms(abs_arr: np.ndarray, peak_idx: int, peak: float, sr: int) -> float:
    left = max(0, peak_idx - int(sr * 0.25))
    pre = abs_arr[left:peak_idx + 1]
    cands = np.where(pre > peak * 0.12)[0]
    onset = left + int(cands[0]) if len(cands) else left
    return (peak_idx - onset) / sr * 1000.0


# ── Validation ────────────────────────────────────────────────────────────────

def _thresholds(item_type: str, mode: str) -> dict:
    """
    Looser thresholds for live phone recordings vs. controlled studio clips.
    Drop on glass: attack can be >90ms depending on phone placement.
    Metal-band and tonal checks lowered — phone mics capture more room sound.
    """
    soft = item_type in SOFT_ITEMS
    if mode == "drop" and not soft:
        return {"snr_min": 10.0, "attack_max_ms": 220.0, "flatness_max": 0.72, "tonal_min": 0.06}
    return {"snr_min": 7.0, "attack_max_ms": 300.0, "flatness_max": 0.80, "tonal_min": 0.04}


def validate_recording(arr: np.ndarray, sr: int, item_type: str = "unknown", mode: str = "tap") -> dict:
    """
    Returns {"valid": True/False, "reason": str, ...metrics}.
    Caller checks valid before proceeding to feature extraction.
    """
    thr = _thresholds(item_type, mode)
    abs_arr = np.abs(arr)

    if len(arr) < int(sr * 0.25):
        return {"valid": False, "snr_db": 0.0, "reason": "Recording too short."}

    noise_floor = max(float(np.percentile(abs_arr, 30)),
                      float(np.sqrt(np.mean(abs_arr ** 2))) * 0.08, 1e-6)
    peak = float(np.max(abs_arr))
    snr_db = float(20 * np.log10(peak / (noise_floor + 1e-10) + 1e-10))

    if peak < 1e-4 or snr_db < thr["snr_min"]:
        return {"valid": False, "snr_db": snr_db,
                "reason": "Signal too quiet or background noise too high."}

    events = detect_impacts(arr, sr)
    if not events:
        return {"valid": False, "snr_db": snr_db,
                "reason": "No tap or impact event detected."}

    best = events[0]
    peak_idx = int(best["peak_idx"])
    atk = attack_ms(abs_arr, peak_idx, float(max(best["peak"], peak)), sr)
    # Attack time is kept as a feature for scoring but NOT used as a hard reject.
    # Drop recordings on a phone vary too much by surface, mic distance, and device.

    seg_len = min(int(sr * 2.0), len(arr) - peak_idx)
    seg_len = max(seg_len, 1024)
    segment = arr[peak_idx:peak_idx + seg_len]
    window = np.hanning(len(segment))
    spectrum = np.abs(np.fft.rfft(segment * window))
    freqs = np.fft.rfftfreq(len(segment), 1.0 / sr)
    spectrum[freqs < 80] = 0.0

    flatness = spectral_flatness(spectrum)
    total_power = float(np.sum(spectrum)) or 1.0
    top_bins = max(5, min(16, len(spectrum) // 24))
    tonal_ratio = float(np.sum(np.sort(spectrum)[-top_bins:])) / total_power
    metal_band = (freqs >= 160) & (freqs <= 6000)
    metal_ratio = float(np.sum(spectrum[metal_band]) / total_power)

    if flatness > thr["flatness_max"] and tonal_ratio < thr["tonal_min"] * 1.4:
        return {"valid": False, "snr_db": snr_db,
                "reason": "Audio sounds like noise or voice, not a metal strike."}
    if tonal_ratio < thr["tonal_min"] and metal_ratio < 0.12:
        return {"valid": False, "snr_db": snr_db,
                "reason": "No clear metallic ring detected. Tap harder or hold the phone closer to the ornament."}

    return {
        "valid": True, "snr_db": snr_db, "attack_ms": atk,
        "flatness": flatness, "tonal_ratio": tonal_ratio, "metal_ratio": metal_ratio,
        "peak_idx": peak_idx, "peak": peak,
        "spectrum": spectrum, "freqs": freqs,
        "total_power": total_power, "seg_len": seg_len,
        "event_count": len(events), "mode": mode,
    }


# ── Physics feature extraction ────────────────────────────────────────────────

def extract_physics_features(arr: np.ndarray, sr: int, val: dict, item_type: str = "unknown") -> dict:
    """Extract hand-crafted acoustic physics features after validation passes."""
    peak_idx = val["peak_idx"]
    peak     = val["peak"]
    spectrum = val["spectrum"]
    freqs    = val["freqs"]
    total_power = val["total_power"]
    abs_arr  = np.abs(arr)

    # Decay time — use smoothed envelope peak, not raw peak.
    # Raw peak and smoothed envelope use different window sizes; comparing them
    # causes smoothed[0] < raw_peak * 0.10 immediately → decay=0ms (wrong).
    post = abs_arr[peak_idx:]
    win = max(1, int(sr * 0.010))  # 10ms smoothing
    smoothed = np.convolve(post, np.ones(win) / win, mode="same")
    # Find the smoothed envelope's own peak to use as the reference
    smooth_peak_idx = int(np.argmax(smoothed[:min(len(smoothed), int(sr * 0.1))]))  # peak within first 100ms
    smooth_peak = float(smoothed[smooth_peak_idx])
    if smooth_peak < 1e-6:
        smooth_peak = float(np.max(smoothed)) or 1e-6
    # Measure from smoothed peak onwards.
    # 5% threshold (not 10%): gold's low internal damping (3e-4) sustains the ring
    # well below half-amplitude. At typical phone SNR of 40-55 dB, 5% of peak is
    # still 14-26 dB above the noise floor — reliable to measure.
    post_peak = smoothed[smooth_peak_idx:]
    below = np.where(post_peak < smooth_peak * 0.05)[0]
    decay_idx = int(below[0]) if len(below) else len(post_peak) - 1
    decay_ms_val = (smooth_peak_idx + decay_idx) / sr * 1000.0
    decay_env = post_peak[:max(decay_idx, 20)]
    decay_r2_val = exp_decay_r2(decay_env)

    # Spectral metrics — bandpass 120–8000 Hz before centroid.
    # Glass surface resonance and room noise live above 8kHz; including them
    # pulls centroid to 15kHz+ and kills the score on valid gold recordings.
    ANALYSIS_HZ_MAX = 8000.0
    analysis_mask = (freqs >= 120) & (freqs <= ANALYSIS_HZ_MAX)
    analysis_spectrum = spectrum.copy()
    analysis_spectrum[~analysis_mask] = 0.0
    analysis_power = float(np.sum(analysis_spectrum)) or 1.0

    centroid = float(np.dot(freqs, analysis_spectrum) / analysis_power)
    dom_idx  = int(np.argmax(analysis_spectrum))
    dom_freq = float(freqs[dom_idx])

    ranges = _ORNAMENT_RANGES.get(item_type.lower(), _DEFAULT_RANGE)
    c_lo, c_hi = ranges["centroid_lo"], ranges["centroid_hi"]
    band_lo = max(120, c_lo * 0.75)
    band_hi = min(4500, c_hi * 1.25)
    gold_mask  = (freqs >= band_lo) & (freqs <= band_hi)
    gold_ratio = float(np.sum(analysis_spectrum[gold_mask]) / analysis_power)
    hf_mask    = (freqs > 1500) & (freqs <= ANALYSIS_HZ_MAX)
    hf_ratio   = float(np.sum(analysis_spectrum[hf_mask]) / analysis_power)

    # Q-factor
    half_power = float(spectrum[dom_idx]) / np.sqrt(2)
    above_hp = np.where(spectrum > half_power)[0]
    q = float(dom_freq / ((above_hp[-1] - above_hp[0]) * sr / val["seg_len"] + 1e-6)) if len(above_hp) >= 2 else 0.0

    return {
        "decay_ms":     round(decay_ms_val, 1),
        "dom_freq_hz":  round(dom_freq, 1),
        "centroid_hz":  round(centroid, 1),
        "gold_ratio":   round(gold_ratio, 4),
        "hf_ratio":     round(hf_ratio, 4),
        "q_factor":     round(q, 2),
        "decay_r2":     round(decay_r2_val, 3),
        "snr_db":       round(val["snr_db"], 1),
        "attack_ms":    round(val.get("attack_ms", 0.0), 1),
        "event_count":  int(val.get("event_count", 1)),
        "tonal_ratio":  round(float(val.get("tonal_ratio", 0.0)), 4),
        "flatness":     round(float(val.get("flatness", 0.5)), 4),
    }


# ── MFCC feature extraction ───────────────────────────────────────────────────

_LIBROSA_AVAILABLE: Optional[bool] = None  # None = not checked yet

def _check_librosa() -> bool:
    global _LIBROSA_AVAILABLE
    if _LIBROSA_AVAILABLE is None:
        try:
            import librosa  # noqa: F401
            _LIBROSA_AVAILABLE = True
        except ImportError:
            logger.warning("librosa not installed — MFCC features unavailable, using physics-only mode")
            _LIBROSA_AVAILABLE = False
    return _LIBROSA_AVAILABLE

MFCC_DIM = N_MFCC * 3  # 120


def extract_mfcc_features(arr: np.ndarray, sr: int) -> np.ndarray:
    """
    Returns 120-dim vector: 40 MFCC + 40 delta + 40 delta-delta, mean-aggregated.
    Returns zeros if librosa is not installed (physics-only fallback).
    """
    if not _check_librosa():
        return np.zeros(MFCC_DIM, dtype=np.float32)

    import librosa
    if sr != SR_TARGET:
        arr = librosa.resample(arr.astype(np.float32), orig_sr=sr, target_sr=SR_TARGET)
        sr = SR_TARGET

    mfcc = librosa.feature.mfcc(y=arr, sr=sr, n_mfcc=N_MFCC, n_fft=N_FFT, hop_length=HOP_LEN)
    delta1 = librosa.feature.delta(mfcc, order=1)
    delta2 = librosa.feature.delta(mfcc, order=2)

    feats = np.concatenate([
        np.mean(mfcc,   axis=1),
        np.mean(delta1, axis=1),
        np.mean(delta2, axis=1),
    ])
    return feats.astype(np.float32)


# ── Combined feature vector ───────────────────────────────────────────────────

PHYSICS_KEYS = [
    "decay_ms", "dom_freq_hz", "centroid_hz", "gold_ratio",
    "hf_ratio", "q_factor", "decay_r2", "snr_db",
    "attack_ms", "event_count", "tonal_ratio", "flatness",
]

def build_feature_vector(
    arr: np.ndarray,
    sr: int,
    item_type: str = "unknown",
    mode: str = "tap",
) -> tuple[Optional[np.ndarray], dict, dict]:
    """
    Run full pipeline and return (feature_vector, physics_dict, val_dict).
    Returns (None, {}, val_dict) if validation fails.
    """
    arr = preprocess(arr)
    val = validate_recording(arr, sr, item_type, mode)
    if not val["valid"]:
        return None, {}, val

    physics = extract_physics_features(arr, sr, val, item_type)

    try:
        mfcc_vec = extract_mfcc_features(arr, sr)
    except Exception as e:
        logger.warning("MFCC extraction failed, using zeros: %s", e)
        mfcc_vec = np.zeros(MFCC_DIM, dtype=np.float32)

    mode_bin    = np.array([1.0 if mode == "drop" else 0.0], dtype=np.float32)
    physics_vec = np.array([physics[k] for k in PHYSICS_KEYS], dtype=np.float32)
    feature_vec = np.concatenate([physics_vec, mfcc_vec, mode_bin])

    return feature_vec, physics, val
