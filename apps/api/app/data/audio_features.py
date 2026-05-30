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


def measure_decay(post: np.ndarray, sr: int, drop_db: float = 26.0) -> tuple:
    """
    Robust decay time via Schroeder backward energy integration (ISO-3382 style).

    Returns (decay_ms, tau_ms, r2, reliable):
      decay_ms  — time to fall `drop_db` (default 26 dB ≈ 5% amplitude) along the
                  fitted energy-decay-curve (EDC) slope. Extrapolated from the slope,
                  so a reverb tail or noise floor sitting above 5% can no longer
                  inflate it the way a raw threshold-crossing does.
      tau_ms    — e-folding time constant (8.686 dB) from the same slope.
      r2        — linearity of the EDC fit (decay-quality / single-material indicator).
      reliable  — False when the impact is too weak or the fit region is degenerate;
                  callers must then treat decay as uninformative, NOT emit a number.

    The Schroeder curve EDC[n] = Σ_{k≥n} x[k]² is monotonically decreasing by
    construction, so rebounds from a 20 cm drop add energy but cannot create the
    non-monotonic bumps that corrupt a raw-envelope threshold crossing. All outputs
    are clamped to [1, 3000] ms so a degenerate fit can never emit multi-second
    garbage (the root cause of the 24-second decays seen on near-silent clips).
    """
    post = post.astype(np.float64)
    n = len(post)
    if n < int(sr * 0.03):
        return 0.0, 0.0, 0.0, False

    energy = post ** 2
    win = max(1, int(sr * 0.005))                       # 5 ms energy smoothing
    sm = np.convolve(energy, np.ones(win) / win, mode="same")
    peak_e = float(np.max(sm)) or 1e-20
    noise_e = float(np.median(sm[int(n * 0.9):])) if n >= 10 else peak_e * 1e-6

    # Need real dynamic range between impact and noise floor (~20 dB), else the
    # "decay" would just be measuring the noise floor → unreliable.
    if peak_e < 1e-9 or peak_e / (noise_e + 1e-20) < 100.0:
        return 0.0, 0.0, 0.0, False

    # Truncate integration just past where energy sinks into the noise floor
    # (Lundeby-lite): keeps the noise tail from biasing the EDC.
    above = np.where(sm > noise_e * 4.0)[0]
    trunc = int(above[-1]) if len(above) else n - 1
    trunc = max(trunc, int(sr * 0.05))
    e = energy[:trunc + 1]

    edc = np.cumsum(e[::-1])[::-1]
    edc = edc / (edc[0] + 1e-20)
    edb = 10.0 * np.log10(edc + 1e-12)
    t_ms = np.arange(len(edb), dtype=np.float64) / sr * 1000.0

    # Fit the linear T20 region (-5 to -25 dB); widen if too few points.
    sel = (edb <= -5.0) & (edb >= -25.0)
    if int(np.sum(sel)) < 8:
        sel = (edb <= -2.0) & (edb >= -20.0)
    if int(np.sum(sel)) < 8:
        sel = (edb <= -1.0) & (edb >= -15.0)
    if int(np.sum(sel)) < 8:
        return 0.0, 0.0, 0.0, False

    ts, ys = t_ms[sel], edb[sel]
    slope, intercept = np.polyfit(ts, ys, 1)            # dB per ms (slope < 0)
    if slope >= -1e-4:                                  # essentially flat → no decay
        return 0.0, 0.0, 0.0, False

    pred = slope * ts + intercept
    ss_res = float(np.sum((ys - pred) ** 2))
    ss_tot = float(np.sum((ys - np.mean(ys)) ** 2)) + 1e-12
    r2 = float(np.clip(1.0 - ss_res / ss_tot, 0.0, 1.0))

    rate = -slope                                       # dB/ms, positive
    decay_ms = float(np.clip(drop_db / rate, 1.0, 3000.0))
    tau_ms   = float(np.clip(8.686 / rate, 1.0, 3000.0))
    return decay_ms, tau_ms, r2, True


def resonant_decay(arr: np.ndarray, sr: int) -> tuple:
    """
    Decay of the RESONANT ring (bandpass around the dominant mode) — what the ear
    actually hears — NOT full-band energy.

    Full-band Schroeder decay includes room reverb + background noise that never
    decays, so it pegged at its 3000 ms ceiling for everything (real and fake, on
    glass and on wood). This isolates the ringing tone: gold sustains a clear tone
    (long resonant decay), base metal / plated / a ring on wood thuds and dies fast.

    Returns (decay_ms, f0_hz, tonality):
      decay_ms  — time for the resonant-band envelope to fall to 10 % (−20 dB) of
                  its post-impact peak. Clamped to [0, 3000].
      f0_hz     — dominant resonant frequency the ring-down was measured at.
      tonality  — fraction of segment energy carried by that resonant band
                  (the "is there a clear ringing tone at all?" indicator).
    """
    arr = arr.astype(np.float64)
    arr = arr - float(np.mean(arr))
    n = len(arr)
    if n < int(sr * 0.06):
        return 0.0, 0.0, 0.0

    energy = arr ** 2
    w = max(1, int(sr * 0.005))
    sm = np.convolve(energy, np.ones(w) / w, mode="same")
    # ONE-DROP-ON-GLASS protocol: the single loudest event IS the drop, and it can
    # happen anywhere in the ~5 s clip — search the whole recording (leaving room
    # for the ring-down), not just the first 1.5 s.
    search_end = max(1, len(sm) - int(sr * 0.25))
    pk = int(np.argmax(sm[:search_end]))
    seg = arr[pk:pk + int(sr * 2.0)]
    if len(seg) < int(sr * 0.05):
        return 0.0, 0.0, 0.0

    # Dominant resonant frequency in the metallic range, from the first 120 ms.
    hlen = min(len(seg), int(sr * 0.12))
    head = seg[:hlen] * np.hanning(hlen)
    spec = np.abs(np.fft.rfft(head))
    fr = np.fft.rfftfreq(hlen, 1.0 / sr)
    band = (fr >= 800) & (fr <= 9000)
    if not band.any() or float(np.max(spec[band])) <= 0:
        return 0.0, 0.0, 0.0
    f0 = float(fr[band][int(np.argmax(spec[band]))])

    lo = max(200.0, f0 / 1.13)
    hi = min(sr / 2.0 - 100.0, f0 * 1.13)
    if hi <= lo:
        return 0.0, f0, 0.0
    try:
        sos = ss.butter(4, [lo, hi], btype="band", fs=sr, output="sos")
        filt = ss.sosfiltfilt(sos, seg)
        env = np.abs(ss.hilbert(filt))
    except Exception:
        return 0.0, f0, 0.0

    ew = max(1, int(sr * 0.004))
    env = np.convolve(env, np.ones(ew) / ew, mode="same")
    pkidx = int(np.argmax(env[:max(1, int(sr * 0.05))]))
    peak = float(env[pkidx]) or 1e-9
    after = env[pkidx:]
    below = np.where(after < 0.1 * peak)[0]
    decay_ms = float((below[0] / sr * 1000.0) if len(below) else len(after) / sr * 1000.0)
    decay_ms = float(np.clip(decay_ms, 0.0, 3000.0))
    tonality = float(np.clip(np.sum(env ** 2) / (np.sum(seg ** 2) + 1e-12), 0.0, 1.0))
    return decay_ms, f0, tonality


def spectral_flatness(spectrum: np.ndarray) -> float:
    safe = np.maximum(spectrum, 1e-10)
    return float(np.clip(np.exp(np.mean(np.log(safe))) / (np.mean(safe) + 1e-10), 0.0, 1.0))


def detect_impacts(arr: np.ndarray, sr: int, mode: str = "tap") -> list:
    """
    Detect metallic impact events using spectral flux (primary) with amplitude fallback.

    Drop mode uses stricter thresholds — only 1-2 real drops happen, echoes and
    ring harmonics must NOT count as separate impacts. A minimum 300ms gap between
    drop events and a cap of 2 events prevents echo contamination of the decay.
    """
    is_drop = mode == "drop"
    # For drop mode: minimum gap between impacts is 300ms. For tap: 75ms.
    min_gap_ms = 300 if is_drop else 75
    max_events = 2 if is_drop else 8
    # For drop: use a higher delta so we only pick real impacts, not ring harmonics
    onset_delta = 0.09 if is_drop else 0.04

    # ── Primary: spectral flux onset detection (librosa) ──────────────────────
    if _check_librosa():
        try:
            import librosa
            y = librosa.resample(arr.astype(np.float32), orig_sr=sr, target_sr=SR_TARGET) if sr != SR_TARGET else arr
            onset_frames = librosa.onset.onset_detect(
                y=y, sr=SR_TARGET,
                hop_length=HOP_LEN,
                backtrack=True,
                pre_max=3, post_max=3,
                pre_avg=5, post_avg=5,
                delta=onset_delta,
                wait=int(min_gap_ms / 1000 * SR_TARGET / HOP_LEN),  # wait in frames
            )
            if len(onset_frames) > 0:
                onset_samples = librosa.frames_to_samples(onset_frames, hop_length=HOP_LEN)
                if sr != SR_TARGET:
                    onset_samples = (onset_samples * sr / SR_TARGET).astype(int)
                onset_samples = np.clip(onset_samples, 0, len(arr) - 1)
                envelope = smooth_abs(arr, sr, 4.0)
                events = []
                last_peak_idx = -int(sr * min_gap_ms / 1000)
                for s in onset_samples:
                    e = min(len(arr) - 1, s + int(sr * 0.5))
                    pi = s + int(np.argmax(envelope[s:e + 1]))
                    pi = min(pi, len(envelope) - 1)
                    # Enforce minimum gap between events
                    if pi - last_peak_idx < int(sr * min_gap_ms / 1000):
                        continue
                    last_peak_idx = pi
                    events.append({"start": int(s), "end": int(e), "peak_idx": int(pi), "peak": float(envelope[pi])})
                events.sort(key=lambda x: x["peak"], reverse=True)
                return events[:max_events]
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
    threshold = max(baseline * 3.0, peak * 0.06, 1e-5)
    above = np.where(envelope >= threshold)[0]
    if not len(above):
        return []

    events, start, prev = [], int(above[0]), int(above[0])
    gap = max(1, int(sr * min_gap_ms / 1000))
    for idx in above[1:]:
        idx = int(idx)
        if idx - prev > gap:
            events.append({"start": start, "end": prev})
            start = idx
        prev = idx
    events.append({"start": start, "end": prev})

    min_gap = int(sr * min_gap_ms / 1000)
    merged = []
    for ev in events:
        if not merged or ev["start"] - merged[-1]["peak_idx"] > min_gap:
            s, e = ev["start"], min(len(envelope) - 1, ev["end"])
            pi = s + int(np.argmax(envelope[s:e + 1]))
            merged.append({"start": s, "end": e, "peak_idx": pi, "peak": float(envelope[pi])})
        elif ev["end"] > merged[-1]["end"]:
            merged[-1]["end"] = ev["end"]

    merged.sort(key=lambda x: x["peak"], reverse=True)
    return merged[:max_events]


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

    events = detect_impacts(arr, sr, mode=mode)
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

def extract_physics_features(arr: np.ndarray, sr: int, val: dict, item_type: str = "unknown", mode: str = "tap") -> dict:
    """
    Extract physics features.

    Drop mode uses rebound-suppression and direct exponential τ fitting:
    - Real gold internal damping: ~3e-4  → long τ (often 80-600ms)
    - Brass/zinc damping: 2-10e-4        → short τ (often 15-50ms)
    Rebounds from 20cm drops (ball-bounce) are suppressed before fitting.
    """
    is_drop = mode == "drop"
    peak_idx = val["peak_idx"]
    spectrum = val["spectrum"]
    freqs    = val["freqs"]
    total_power = val["total_power"]
    abs_arr  = np.abs(arr)

    # ── STEP 1: Find the single drop impact (loudest event anywhere in the clip) ─
    if is_drop:
        # ONE-DROP-ON-GLASS protocol: one drop, recorded in a ~5 s clip, can land at
        # any time — the loudest event is the drop. Search the whole recording.
        env6 = smooth_abs(arr, sr, 6.0)
        search_end = max(1, len(env6) - int(sr * 0.25))
        first_peak_idx = int(np.argmax(env6[:search_end]))
        peak_idx = first_peak_idx
        peak = float(env6[peak_idx])
    else:
        peak = val["peak"]

    # ── STEP 2-3: Robust decay via Schroeder energy-decay fit ─────────────────
    # Replaces the old threshold-crossing + log-linear-τ pair, which emitted
    # multi-second garbage on near-silent clips and was wildly non-uniform.
    # measure_decay is monotonic (handles rebounds), noise-floor aware, and clamped.
    decay_ms_val, tau_ms, decay_r2_val, decay_reliable = measure_decay(abs_arr[peak_idx:], sr)

    if not decay_reliable:
        # Weak impact / degenerate fit (e.g. peak buried in noise). Never emit
        # multi-second garbage: report a small conservative decay and flag it via
        # a low R² so the classifier / heuristic discounts it.
        env = smooth_abs(arr, sr, 6.0)[peak_idx:]
        pk = float(env[0]) if len(env) else 0.0
        if pk > 1e-6:
            below = np.where(env < pk * 0.05)[0]
            decay_ms_val = float(np.clip((below[0] / sr * 1000.0) if len(below) else 0.0, 0.0, 600.0))
        else:
            decay_ms_val = 0.0
        tau_ms = decay_ms_val
        decay_r2_val = min(decay_r2_val, 0.2)

    # ── STEP 3b: Resonant ring-down (bandpass around dominant mode) ───────────
    # This is the decay the EAR hears — the sustained ringing tone — as opposed to
    # full-band Schroeder decay (decay_ms_val) which is dominated by room noise and
    # pegs near the 3000ms ceiling. res_decay separates a sustained gold ring from a
    # short base-metal thud; res_tonality says whether a clear ringing tone exists.
    res_decay_ms, res_f0_hz, res_tonality = resonant_decay(arr, sr)

    # ── STEP 4: Spectral metrics ────────────────────────────────────────────
    ANALYSIS_HZ_MAX = 8000.0
    analysis_mask = (freqs >= 120) & (freqs <= ANALYSIS_HZ_MAX)
    analysis_spectrum = spectrum.copy()
    analysis_spectrum[~analysis_mask] = 0.0
    analysis_power = float(np.sum(analysis_spectrum)) or 1.0

    centroid = float(np.dot(freqs, analysis_spectrum) / analysis_power)
    dom_idx  = int(np.argmax(analysis_spectrum))
    dom_freq = float(freqs[dom_idx])

    if is_drop:
        # Drop on glass: gold resonance band 200-2500Hz
        gold_mask = (freqs >= 200) & (freqs <= 2500)
        # HF ratio: only truly high frequency noise (>3kHz) is informative
        hf_mask = (freqs > 3000) & (freqs <= ANALYSIS_HZ_MAX)
    else:
        ranges = _ORNAMENT_RANGES.get(item_type.lower(), _DEFAULT_RANGE)
        c_lo, c_hi = ranges["centroid_lo"], ranges["centroid_hi"]
        band_lo = max(120, c_lo * 0.75)
        band_hi = min(4500, c_hi * 1.25)
        gold_mask = (freqs >= band_lo) & (freqs <= band_hi)
        hf_mask   = (freqs > 1500) & (freqs <= ANALYSIS_HZ_MAX)

    gold_ratio = float(np.sum(analysis_spectrum[gold_mask]) / analysis_power)
    hf_ratio   = float(np.sum(analysis_spectrum[hf_mask]) / analysis_power)

    # Q-factor
    half_power = float(spectrum[dom_idx]) / np.sqrt(2)
    above_hp = np.where(spectrum > half_power)[0]
    q = float(dom_freq / ((above_hp[-1] - above_hp[0]) * sr / val["seg_len"] + 1e-6)) if len(above_hp) >= 2 else 0.0

    return {
        "decay_ms":     round(decay_ms_val, 1),
        "tau_ms":       round(tau_ms, 1),       # exponential time constant (primary drop discriminator)
        "res_decay_ms": round(res_decay_ms, 1), # resonant ring-down (what the ear hears) — primary
        "res_f0_hz":    round(res_f0_hz, 1),    # frequency the resonant decay was measured at
        "res_tonality": round(res_tonality, 4), # fraction of energy in the resonant band (ring present?)
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

# ── Classifier input (compact, non-overfit) ─────────────────────────────────────
# The deployed model is trained on THESE features only — four physical
# discriminators + a mode bit. We deliberately exclude:
#   • the 120 MFCC coefficients — on 33 clips they let the model MEMORISE each
#     recording (train looks perfect, held-out AUC collapses to ~0.44).
#   • snr_db — it "separates" only because the fake clips were recorded louder;
#     a recording-session artifact, not physics. It does not generalise.
# Honest LeaveOneGroupOut CV with this set: ~0.66 AUC, 85% sensitivity (real gold
# is caught reliably). Adding more features did not improve calibrated AUC and only
# raised the overfit risk on 33 clips, so we keep it minimal.
#   decay_ms/decay_r2 — sustain & single-material cleanliness of the ring
#   q_factor          — sharpness of the dominant resonance
#   gold_ratio        — energy in the dense-metal resonance band
MODEL_FEATURES = ["decay_ms", "decay_r2", "q_factor", "gold_ratio"]

def build_model_vector(physics: dict, mode: str) -> np.ndarray:
    """Compact classifier input: 4 physics discriminators + mode bit (drop=1)."""
    vals = [float(physics.get(k, 0.0)) for k in MODEL_FEATURES]
    vals.append(1.0 if mode == "drop" else 0.0)
    return np.array(vals, dtype=np.float32)

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

    physics = extract_physics_features(arr, sr, val, item_type, mode=mode)

    try:
        mfcc_vec = extract_mfcc_features(arr, sr)
    except Exception as e:
        logger.warning("MFCC extraction failed, using zeros: %s", e)
        mfcc_vec = np.zeros(MFCC_DIM, dtype=np.float32)

    mode_bin    = np.array([1.0 if mode == "drop" else 0.0], dtype=np.float32)
    physics_vec = np.array([physics[k] for k in PHYSICS_KEYS], dtype=np.float32)
    feature_vec = np.concatenate([physics_vec, mfcc_vec, mode_bin])

    return feature_vec, physics, val
