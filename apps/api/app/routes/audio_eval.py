"""
POST /api/audio-eval
Impulse acoustic test for gold ornaments.

The previous implementation treated every sample as a hard-surface drop. That is
too brittle for necklaces, chains and earrings: these pieces produce multiple
short contact sounds and weakly coupled resonances. This route now supports:
  - drop: compact rings, bangles, coins/bars
  - tap: fingernail/coin/knuckle taps for delicate ornaments
  - rattle: multiple link/contact events for chains and necklaces
  - auto: server chooses from ornament type

Validity checks reject bad recordings, not valid jewellery forms:
  1. SNR above a mode-specific threshold
  2. One or more detected impulse events
  3. Tonal or metal-band spectral concentration
  4. Attack-time check only hard-rejects strict drop mode
  5. Softer chain/earring modes allow complex, shorter decays
"""
import base64
import io
import json
import logging
import struct
from typing import Optional

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel

from app.data.gemini import GEMINI_MODEL, _gemini_request, extract_gemini_text, parse_json_response

logger = logging.getLogger("goldeye.audio_eval")
router = APIRouter()


class AudioEvalRequest(BaseModel):
    samples_b64: str
    sample_rate: int = 44100
    language: str = "en"
    ornament_type: str = "unknown"  # ring | bangle | chain | necklace | pendant | earring | coin | unknown
    test_mode: str = "auto"         # auto | tap | drop | rattle


class AudioEvalResponse(BaseModel):
    score: int
    label: str
    valid: bool                  # False = no usable acoustic impulse detected
    reject_reason: Optional[str] # set when valid=False
    decay_ms: float
    dominant_freq_hz: float
    spectral_centroid_hz: float
    q_factor: float
    gold_band_ratio: float
    decay_r2: float
    snr_db: float
    attack_ms: float = 0.0
    event_count: int = 0
    test_mode: str = "auto"
    reasoning: str


def _float32_to_wav(arr: np.ndarray, sample_rate: int) -> bytes:
    data = arr.astype(np.float32).tobytes()
    buf  = io.BytesIO()
    buf.write(b"RIFF"); buf.write(struct.pack("<I", 36 + len(data))); buf.write(b"WAVE")
    buf.write(b"fmt "); buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 3)); buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sample_rate)); buf.write(struct.pack("<I", sample_rate * 4))
    buf.write(struct.pack("<H", 4)); buf.write(struct.pack("<H", 32))
    buf.write(b"data"); buf.write(struct.pack("<I", len(data))); buf.write(data)
    return buf.getvalue()


def _spectral_flatness(spectrum: np.ndarray) -> float:
    """
    Wiener entropy: geometric mean / arithmetic mean of spectrum.
    0.0 = perfectly tonal (single frequency), 1.0 = white noise.
    Metal drops: < 0.35. Voice/traffic/noise: > 0.55.
    """
    safe = np.maximum(spectrum, 1e-10)
    geo_mean = np.exp(np.mean(np.log(safe)))
    arith_mean = np.mean(safe)
    return float(np.clip(geo_mean / (arith_mean + 1e-10), 0.0, 1.0))


def _exponential_decay_r2(envelope: np.ndarray) -> float:
    """R² of exponential fit y = A·exp(-t/τ). Real gold > 0.85."""
    if len(envelope) < 20:
        return 0.0
    try:
        t = np.arange(len(envelope), dtype=np.float64)
        log_y = np.log(np.maximum(envelope, 1e-10))
        t_m = np.mean(t); ly_m = np.mean(log_y)
        slope = np.sum((t - t_m) * (log_y - ly_m)) / (np.sum((t - t_m) ** 2) + 1e-10)
        pred  = ly_m + slope * (t - t_m)
        ss_res = np.sum((log_y - pred) ** 2)
        ss_tot = np.sum((log_y - ly_m) ** 2) + 1e-10
        return float(np.clip(1.0 - ss_res / ss_tot, 0.0, 1.0))
    except Exception:
        return 0.0


SOFT_ORNAMENTS = {"chain", "necklace", "earring"}
COMPACT_ORNAMENTS = {"ring", "bangle", "coin", "bar"}
VALID_TEST_MODES = {"auto", "tap", "drop", "rattle"}


def _normalize_test_mode(test_mode: str, ornament_type: str) -> str:
    mode = (test_mode or "auto").lower().strip()
    otype = (ornament_type or "unknown").lower().strip()
    if mode not in VALID_TEST_MODES:
        mode = "auto"
    if mode != "auto":
        return mode
    if otype in SOFT_ORNAMENTS:
        return "tap"
    if otype in COMPACT_ORNAMENTS:
        return "drop"
    return "tap"


def _validation_thresholds(ornament_type: str, test_mode: str) -> dict:
    otype = (ornament_type or "unknown").lower().strip()
    soft = otype in SOFT_ORNAMENTS or test_mode in {"tap", "rattle"}
    if test_mode == "drop" and not soft:
        return {"snr_min": 14.0, "attack_max_ms": 90.0, "flatness_max": 0.56, "tonal_min": 0.16}
    if test_mode == "rattle":
        return {"snr_min": 8.0, "attack_max_ms": 260.0, "flatness_max": 0.78, "tonal_min": 0.06}
    return {"snr_min": 9.0, "attack_max_ms": 180.0, "flatness_max": 0.70, "tonal_min": 0.08}


def _preprocess_audio(arr: np.ndarray) -> np.ndarray:
    arr = np.nan_to_num(arr.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    if len(arr) == 0:
        return arr
    arr = arr - float(np.mean(arr))
    max_abs = float(np.max(np.abs(arr)))
    if max_abs > 1.5:
        arr = arr / max_abs
    return arr


def _smooth_abs(arr: np.ndarray, sample_rate: int, window_ms: float = 4.0) -> np.ndarray:
    win = max(1, int(sample_rate * window_ms / 1000.0))
    return np.convolve(np.abs(arr), np.ones(win, dtype=np.float32) / win, mode="same")


def _detect_impacts(arr: np.ndarray, sample_rate: int) -> list[dict]:
    envelope = _smooth_abs(arr, sample_rate, 4.0)
    if len(envelope) == 0:
        return []
    peak = float(np.max(envelope))
    if peak < 1e-4:
        return []
    baseline = float(np.percentile(envelope, 35))
    threshold = max(baseline * 5.0, peak * 0.10, 1e-4)
    above = np.where(envelope >= threshold)[0]
    if len(above) == 0:
        return []

    events: list[dict] = []
    start = int(above[0])
    prev = int(above[0])
    gap_limit = max(1, int(sample_rate * 0.035))
    for idx in above[1:]:
        idx = int(idx)
        if idx - prev > gap_limit:
            events.append({"start": start, "end": prev})
            start = idx
        prev = idx
    events.append({"start": start, "end": prev})

    min_gap = int(sample_rate * 0.075)
    merged: list[dict] = []
    for ev in events:
        if not merged or ev["start"] - merged[-1]["peak_idx"] > min_gap:
            s, e = ev["start"], min(len(envelope) - 1, ev["end"])
            peak_rel = int(np.argmax(envelope[s:e + 1]))
            peak_idx = s + peak_rel
            merged.append({
                "start": s,
                "end": e,
                "peak_idx": peak_idx,
                "peak": float(envelope[peak_idx]),
            })
        elif ev["end"] > merged[-1]["end"]:
            merged[-1]["end"] = ev["end"]

    merged.sort(key=lambda item: item["peak"], reverse=True)
    return merged[:8]


def _attack_ms(abs_arr: np.ndarray, peak_idx: int, peak: float, sample_rate: int) -> float:
    left = max(0, peak_idx - int(sample_rate * 0.25))
    pre_peak = abs_arr[left:peak_idx + 1]
    onset_candidates = np.where(pre_peak > peak * 0.12)[0]
    onset_idx = left + int(onset_candidates[0]) if len(onset_candidates) else left
    return (peak_idx - onset_idx) / sample_rate * 1000.0


def _validate_impulse(arr: np.ndarray, sample_rate: int, ornament_type: str, test_mode: str) -> dict:
    """
    Check if the recording contains a usable metal impulse/tap/drop sound.
    Returns {"valid": True/False, "reason": str, ...metrics...}
    """
    thresholds = _validation_thresholds(ornament_type, test_mode)
    abs_arr = np.abs(arr)
    if len(arr) < int(sample_rate * 0.25):
        return {"valid": False, "snr_db": 0.0, "reason": "Recording is too short. Record for the full 10 seconds."}

    # ── SNR check ──────────────────────────────────────────────────────────────
    noise_floor = max(float(np.percentile(abs_arr, 30)), float(np.sqrt(np.mean(abs_arr ** 2))) * 0.08, 1e-6)
    peak        = float(np.max(abs_arr))
    snr_linear  = peak / (noise_floor + 1e-10)
    snr_db      = float(20 * np.log10(snr_linear + 1e-10))

    if peak < 1e-4 or snr_db < thresholds["snr_min"]:
        return {"valid": False, "snr_db": snr_db,
                "reason": "Signal is too quiet or background noise is too high. "
                          "Keep the phone microphone close, record in a quiet room, and tap the ornament clearly."}

    events = _detect_impacts(arr, sample_rate)
    if not events:
        return {"valid": False, "snr_db": snr_db,
                "reason": "No tap or impact event was detected. Tap the ornament 3-5 times near the microphone."}

    best_event = events[0]
    peak_idx = int(best_event["peak_idx"])
    peak = float(max(best_event["peak"], peak))
    attack_ms = _attack_ms(abs_arr, peak_idx, peak, sample_rate)

    if test_mode == "drop" and attack_ms > thresholds["attack_max_ms"]:
        return {"valid": False, "snr_db": snr_db,
                "reason": "No sharp drop impact detected. For delicate ornaments choose Tap mode; "
                          "for rings/bangles use a hard surface and a short 2-3 cm drop."}

    # ── Spectral analysis ──────────────────────────────────────────────────────
    seg_len = min(int(sample_rate * 2.0), len(arr) - peak_idx)
    seg_len = max(seg_len, 1024)
    segment = arr[peak_idx:peak_idx + seg_len]
    window  = np.hanning(len(segment))
    spectrum = np.abs(np.fft.rfft(segment * window))
    freqs    = np.fft.rfftfreq(len(segment), 1.0 / sample_rate)
    spectrum[freqs < 80] = 0.0

    flatness = _spectral_flatness(spectrum)
    total_power = float(np.sum(spectrum)) or 1.0

    # Tonal energy: energy in top frequency bins vs total. Taps on chain/earring
    # may be less tonal than a ring drop, so validation also considers broad
    # metal-band energy rather than a single bell-like pitch.
    top_bins = max(5, min(16, len(spectrum) // 24))
    top5_energy = float(np.sum(np.sort(spectrum)[-top_bins:]))
    tonal_ratio = top5_energy / total_power
    metal_band = (freqs >= 160) & (freqs <= 6000)
    metal_band_ratio = float(np.sum(spectrum[metal_band]) / total_power)

    if flatness > thresholds["flatness_max"] and tonal_ratio < thresholds["tonal_min"] * 1.4:
        return {"valid": False, "snr_db": snr_db,
                "reason": "Audio sounds like noise or voice, not a metal drop. "
                          "Keep the room quiet and tap the ornament close to the microphone."}

    if tonal_ratio < thresholds["tonal_min"] and metal_band_ratio < 0.22:
        return {"valid": False, "snr_db": snr_db,
                "reason": "No clear metallic ring detected. "
                          "For chains, necklaces, and earrings use repeated gentle taps, not a drop."}

    return {
        "valid": True,
        "snr_db": snr_db,
        "attack_ms": attack_ms,
        "flatness": flatness,
        "tonal_ratio": tonal_ratio,
        "metal_band_ratio": metal_band_ratio,
        "peak_idx": peak_idx,
        "peak": peak,
        "spectrum": spectrum,
        "freqs": freqs,
        "total_power": total_power,
        "seg_len": seg_len,
        "event_count": len(events),
        "test_mode": test_mode,
    }


def _ornament_ranges(ornament_type: str) -> dict:
    """
    Ornament-specific acoustic reference ranges.
    Different gold ornaments have different resonance characteristics based on mass, shape, and form factor.

    Physics basis:
      f = (1/2L) * sqrt(E/ρ)  — resonant freq depends on length, Young's modulus, and density
      Larger/heavier pieces → lower fundamental frequency
      Thinner pieces (chains, earrings) → higher frequency, shorter ring
      Solid compact pieces (bangles, coins) → clearest, most sustained ring

    Ring:      Compact toroidal shape, 2-10g. Clear ring 400-900Hz. Decay 80-250ms.
    Bangle:    Large solid ring, 15-50g. Deep ring 200-500Hz. Decay 150-500ms.
    Chain:     Many small links, 5-30g. Complex, shorter ring 300-1200Hz. Decay 35-220ms.
    Necklace:  Heavy chain + pendant, 10-50g. Mixed 180-900Hz. Decay 45-320ms.
    Pendant:   Flat piece, 2-15g. Bright-ish ring 400-1200Hz. Decay 80-250ms.
    Earring:   Small piece, 0.5-5g. Higher frequency 500-1500Hz. Decay 40-150ms.
    Coin/bar:  Compact flat, 5-50g. Very clear ring 300-700Hz. Decay 200-600ms.
    """
    RANGES = {
        "ring":     {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 400, "centroid_hi": 1000},
        "bangle":   {"decay_lo": 100, "decay_hi": 600, "centroid_lo": 200, "centroid_hi": 600},
        "chain":    {"decay_lo": 35,  "decay_hi": 260, "centroid_lo": 250, "centroid_hi": 1200},
        "necklace": {"decay_lo": 45,  "decay_hi": 360, "centroid_lo": 180, "centroid_hi": 900},
        "pendant":  {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 350, "centroid_hi": 1200},
        "earring":  {"decay_lo": 30,  "decay_hi": 200, "centroid_lo": 400, "centroid_hi": 1600},
        "coin":     {"decay_lo": 150, "decay_hi": 700, "centroid_lo": 250, "centroid_hi": 650},
    }
    return RANGES.get(ornament_type.lower(), {"decay_lo": 60, "decay_hi": 450, "centroid_lo": 250, "centroid_hi": 1000})


def _acoustic_metrics(arr: np.ndarray, sample_rate: int, val: dict, ornament_type: str = "unknown") -> dict:
    """Compute gold-specific acoustic parameters after validation passes."""
    peak_idx    = val["peak_idx"]
    peak        = val["peak"]
    spectrum    = val["spectrum"]
    freqs       = val["freqs"]
    total_power = val["total_power"]
    snr_db      = val["snr_db"]
    attack_ms   = val.get("attack_ms", 0.0)
    test_mode   = val.get("test_mode", "tap")
    event_count = int(val.get("event_count", 1))
    abs_arr     = np.abs(arr)

    # ── Decay time ─────────────────────────────────────────────────────────────
    post = abs_arr[peak_idx:]
    smooth_win = max(1, int(sample_rate * 0.010))
    smoothed = np.convolve(post, np.ones(smooth_win) / smooth_win, mode='same')
    below = np.where(smoothed < peak * 0.10)[0]
    decay_idx = int(below[0]) if len(below) else len(post) - 1
    decay_ms  = decay_idx / sample_rate * 1000

    decay_envelope = smoothed[:max(decay_idx, 20)]
    decay_r2 = _exponential_decay_r2(decay_envelope)

    # ── Frequency metrics ──────────────────────────────────────────────────────
    centroid = float(np.dot(freqs, spectrum) / total_power)
    dom_idx  = int(np.argmax(spectrum))
    dom_freq = float(freqs[dom_idx])

    ranges = _ornament_ranges(ornament_type)
    d_lo, d_hi = ranges["decay_lo"], ranges["decay_hi"]
    c_lo, c_hi = ranges["centroid_lo"], ranges["centroid_hi"]

    # Ornament reference band. Compact ornaments concentrate lower; delicate
    # pieces often have useful evidence above 800 Hz.
    band_lo = max(120, c_lo * 0.75)
    band_hi = min(4500, c_hi * 1.25)
    gold_mask = (freqs >= band_lo) & (freqs <= band_hi)
    gold_ratio = float(np.sum(spectrum[gold_mask]) / total_power)

    # High-freq (>1500Hz): bright overtones indicate plated substrate
    hf_ratio = float(np.sum(spectrum[freqs > 1500]) / total_power)

    # Q-factor
    half_power = float(spectrum[dom_idx]) / np.sqrt(2)
    above = np.where(spectrum > half_power)[0]
    q = float(dom_freq / ((above[-1] - above[0]) * sample_rate / val["seg_len"] + 1e-6)) if len(above) >= 2 else 0.0

    # ── Physics-based score (ornament-type-aware ranges) ──────────────────────
    otype_label = ornament_type if ornament_type != "unknown" else "ornament"
    soft_mode = test_mode in {"tap", "rattle"} or ornament_type in SOFT_ORNAMENTS
    score, reasons = 50, []

    # DECAY — plated brass rings LONGER than real gold (confirmed research)
    if d_lo <= decay_ms <= d_hi:
        score += 18 if soft_mode else 25
        reasons.append(f"Decay {decay_ms:.0f}ms — expected range for solid gold {otype_label} ({d_lo}-{d_hi}ms)")
    elif decay_ms < d_lo:
        score -= 1 if soft_mode else 5
        reasons.append(f"Short decay {decay_ms:.0f}ms — acceptable for small/delicate pieces, but less decisive")
    elif decay_ms <= d_hi * 2:
        score -= 18
        reasons.append(f"Decay {decay_ms:.0f}ms — too long for solid gold {otype_label}; plated brass rings longer")
    else:
        score -= 28
        reasons.append(f"Very long ring {decay_ms:.0f}ms — gold-plated silver signature")

    # SPECTRAL CENTROID — ornament-type-aware (earrings ring higher than bangles)
    if c_lo <= centroid <= c_hi:
        score += 20
        reasons.append(f"Centroid {centroid:.0f}Hz — expected range for {otype_label} ({c_lo}-{c_hi}Hz)")
    elif centroid < c_lo * 0.7:
        score += 5
        reasons.append(f"Low centroid {centroid:.0f}Hz — heavy piece, borderline")
    elif centroid > c_hi * 1.5:
        score -= 20
        reasons.append(f"High centroid {centroid:.0f}Hz — bright/metallic (plated substrate resonance)")
    else:
        score -= 8
        reasons.append(f"Centroid {centroid:.0f}Hz — slightly outside expected range for {otype_label}")

    # GOLD-BAND ENERGY
    strong_band = 0.30 if soft_mode else 0.40
    medium_band = 0.18 if soft_mode else 0.25
    if gold_ratio >= strong_band:
        score += 10
        reasons.append(f"Reference-band {gold_ratio:.0%} in {band_lo:.0f}-{band_hi:.0f}Hz — useful dense-metal evidence")
    elif gold_ratio >= medium_band:
        score += 2
        reasons.append(f"Moderate reference-band energy {gold_ratio:.0%}")
    else:
        score -= 5 if soft_mode else 10
        reasons.append(f"Low reference-band energy {gold_ratio:.0%} — weak acoustic evidence")

    # HIGH-FREQUENCY RATIO (plated indicator)
    hf_bad = 0.42 if ornament_type in {"earring", "chain"} else 0.30
    hf_warn = 0.24 if ornament_type in {"earring", "chain"} else 0.15
    if hf_ratio > hf_bad:
        score -= 12
        reasons.append(f"High-freq energy {hf_ratio:.0%} >1500Hz — tinny plated signature")
    elif hf_ratio > hf_warn:
        score -= 4
        reasons.append(f"Some high-freq content {hf_ratio:.0%}")

    # EXPONENTIAL DECAY QUALITY
    if decay_r2 >= 0.85:
        score += 5
        reasons.append(f"Clean exponential decay R²={decay_r2:.2f} — single pure material")
    elif decay_r2 < 0.60 and not soft_mode:
        score -= 8
        reasons.append(f"Irregular decay R²={decay_r2:.2f} — composite/plated material")
    elif soft_mode:
        reasons.append(f"Complex decay R²={decay_r2:.2f} — expected with multiple links/settings")

    if soft_mode and event_count >= 2:
        score += 4
        reasons.append(f"{event_count} usable tap events detected — multi-tap evidence is more robust")

    # SNR BONUS (cleaner recording = more trustworthy score)
    if snr_db >= 30:
        score += 3
        reasons.append(f"Excellent recording quality (SNR {snr_db:.0f}dB)")

    return {
        "score": max(5, min(95, score)),
        "decay_ms": round(decay_ms, 1),
        "dom_freq": round(dom_freq, 1),
        "centroid": round(centroid, 1),
        "gold_ratio": round(gold_ratio, 4),
        "hf_ratio": round(hf_ratio, 4),
        "q_factor": round(q, 2),
        "decay_r2": round(decay_r2, 3),
        "snr_db": round(snr_db, 1),
        "attack_ms": round(attack_ms, 1),
        "event_count": event_count,
        "test_mode": test_mode,
        "reasons": reasons,
    }


@router.post("/audio-eval", response_model=AudioEvalResponse)
async def audio_eval(req: AudioEvalRequest):
    lang_out = "Hindi (Devanagari)" if req.language == "hi" else "English"

    # ── Decode ─────────────────────────────────────────────────────────────────
    try:
        raw_b = base64.b64decode(req.samples_b64)
        arr   = _preprocess_audio(np.frombuffer(raw_b, dtype=np.float32).copy())
    except Exception as e:
        logger.error(f"Audio decode error: {e}")
        return _invalid("Could not decode audio data. Please try again.", req.language)

    # ── Validate: reject non-metal / bad recordings ────────────────────────────
    test_mode = _normalize_test_mode(req.test_mode, req.ornament_type)
    val = _validate_impulse(arr, req.sample_rate, req.ornament_type, test_mode)
    if not val["valid"]:
        reason = val["reason"]
        if req.language == "hi":
            reason = f"कृपया फिर से रिकॉर्ड करें। {reason}"
        logger.info(f"audio_eval: invalid recording — {reason}")
        return _invalid(reason, req.language, snr_db=val.get("snr_db", 0.0), test_mode=test_mode)

    # ── Physics metrics ────────────────────────────────────────────────────────
    metrics = _acoustic_metrics(arr, req.sample_rate, val, req.ornament_type)

    # ── Gemini analysis with measured parameters ───────────────────────────────
    gemini_score: Optional[int] = None
    gemini_reasoning = ""

    try:
        wav_b64 = base64.b64encode(_float32_to_wav(arr, req.sample_rate)).decode()

        ranges = _ornament_ranges(req.ornament_type)
        otype_label = req.ornament_type if req.ornament_type != "unknown" else "gold ornament"

        prompt = (
            "You are an expert metallurgical acoustics analyst.\n"
            f"The user performed a {test_mode.upper()} acoustic test on a gold {otype_label}.\n"
            "Do not assume a necklace, chain, or earring will produce a single clean bell-like drop tone.\n"
            "You have the recording AND precise measurements. Use both to score.\n\n"

            f"ORNAMENT TYPE: {otype_label.upper()}\n"
            f"Expected decay range for solid gold {otype_label}: {ranges['decay_lo']}-{ranges['decay_hi']}ms\n"
            f"Expected centroid range for solid gold {otype_label}: {ranges['centroid_lo']}-{ranges['centroid_hi']}Hz\n\n"

            "MEASURED PARAMETERS (FFT + envelope analysis):\n"
            f"  Decay time:           {metrics['decay_ms']:.0f} ms\n"
            f"  Dominant frequency:   {metrics['dom_freq']:.0f} Hz\n"
            f"  Spectral centroid:    {metrics['centroid']:.0f} Hz\n"
            f"  Q-factor:             {metrics['q_factor']:.1f}\n"
            f"  Reference-band ratio: {metrics['gold_ratio']:.0%}\n"
            f"  High-freq ratio:      {metrics['hf_ratio']:.0%}  (>1500Hz = bright/tinny)\n"
            f"  Decay exponential R²: {metrics['decay_r2']:.2f}\n"
            f"  Recording SNR:        {metrics['snr_db']:.0f} dB\n\n"

            "ACOUSTIC BASIS:\n\n"
            "SOLID GOLD 18K-24K (19.32 g/cm³, velocity 3240 m/s):\n"
            "  Compact pieces: moderate decay, warmer lower centroid, not too bright.\n"
            "  Chain/necklace/earring: shorter/complex decay and multiple impacts are normal.\n\n"
            "GOLD-PLATED BRASS (8.5 g/cm³, velocity 4700 m/s):\n"
            "  Often brighter, higher centroid, more high-frequency shimmer, or over-sustained ringing.\n\n"
            "CRITICAL: Score acoustic evidence as supporting evidence only; do not reject solely because a delicate ornament lacks a clean drop ring.\n\n"
            f"Return ONLY valid JSON (reasoning in {lang_out}):\n"
            '{{"score": integer 0-100, '
            '"label": "Likely solid gold|Uncertain — may be plated|Possibly gold-plated", '
            '"reasoning": "2-3 sentences citing specific measured values as evidence"}}'
        )

        payload = {
            "contents": [{"parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "audio/wav", "data": wav_b64}},
            ]}],
            "generationConfig": {
                "temperature": 0.10,
                "maxOutputTokens": 800,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {
                        "score": {"type": "INTEGER"},
                        "label": {"type": "STRING"},
                        "reasoning": {"type": "STRING"},
                    },
                    "required": ["score", "label", "reasoning"],
                },
            },
        }

        data, success = await _gemini_request(payload, timeout=50)
        if success and "candidates" in data:
            raw = extract_gemini_text(data)
            g = parse_json_response(raw)
            gemini_score    = max(0, min(100, int(g.get("score", 50))))
            gemini_reasoning = str(g.get("reasoning", ""))
            logger.info(
                f"audio_eval ok: model={GEMINI_MODEL} gemini={gemini_score} algo={metrics['score']} "
                f"decay={metrics['decay_ms']}ms centroid={metrics['centroid']}Hz "
                f"R²={metrics['decay_r2']:.2f} SNR={metrics['snr_db']:.0f}dB"
            )
        else:
            err = data.get("error", "empty_response" if success else "api_failed")
            logger.warning(f"Gemini audio skipped: API keys exhausted or rate-limited ({err})")
    except Exception as e:
        logger.warning(
            f"Gemini audio skipped using {GEMINI_MODEL}: {e}. "
            f"Raw response: {raw if 'raw' in locals() else 'None'}"
        )

    # Acoustic scoring is primarily deterministic; Gemini only gives a cautious
    # second opinion because delicate jewellery often lacks a textbook ring.
    if gemini_score is not None:
        final_score = round(gemini_score * 0.35 + metrics["score"] * 0.65)
        reasoning   = gemini_reasoning
    else:
        final_score = metrics["score"]
        reasoning   = " | ".join(metrics["reasons"])

    final_score = max(5, min(95, final_score))
    label = (
        "Likely solid gold"         if final_score >= 70 else
        "Uncertain — may be plated" if final_score >= 50 else
        "Possibly gold-plated"
    )

    return AudioEvalResponse(
        score=final_score, label=label, valid=True, reject_reason=None,
        decay_ms=metrics["decay_ms"], dominant_freq_hz=metrics["dom_freq"],
        spectral_centroid_hz=metrics["centroid"], q_factor=metrics["q_factor"],
        gold_band_ratio=round(metrics["gold_ratio"], 3),
        decay_r2=metrics["decay_r2"], snr_db=metrics["snr_db"],
        attack_ms=metrics["attack_ms"], event_count=metrics["event_count"], test_mode=metrics["test_mode"],
        reasoning=reasoning,
    )


def _invalid(reason: str, lang: str, snr_db: float = 0.0, test_mode: str = "auto") -> AudioEvalResponse:
    return AudioEvalResponse(
        score=0, label="Invalid recording", valid=False, reject_reason=reason,
        decay_ms=0, dominant_freq_hz=0, spectral_centroid_hz=0,
        q_factor=0, gold_band_ratio=0, decay_r2=0, snr_db=snr_db,
        attack_ms=0, event_count=0, test_mode=test_mode,
        reasoning=reason,
    )
