"""
POST /api/audio-eval
10-second tap test: raw float32 PCM → numpy FFT measurements + Gemini acoustic analysis.
Strategy: compute precise acoustic parameters first (decay, centroid, Q-factor, harmonic ratio),
then send BOTH the WAV file and the measurements to Gemini so it can calibrate its
perception against objective data. Final score = 55% Gemini + 45% algorithmic.
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

from app.data.gemini import _gemini_request

logger = logging.getLogger("goldeye.audio_eval")
router = APIRouter()


class AudioEvalRequest(BaseModel):
    samples_b64: str
    sample_rate: int = 44100
    language: str = "en"


class AudioEvalResponse(BaseModel):
    score: int
    label: str
    decay_ms: float
    dominant_freq_hz: float
    spectral_centroid_hz: float
    q_factor: float
    gold_band_ratio: float
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


def _acoustic_metrics(arr: np.ndarray, sample_rate: int) -> dict:
    """
    Compute precise acoustic parameters using numpy FFT.
    Returns measurable physical properties of the tap sound.

    Gold reference ranges (from metallurgical research):
      Decay τ:          60–400 ms  (dense metal, high internal friction)
      Spectral centroid: 150–700 Hz (mass-dependent resonance)
      Dominant freq:    200–1200 Hz (size and alloy dependent)
      Q factor:          >8          (sustained resonance, low damping)
      Gold-band ratio:  >0.45       (energy concentration in 150-700 Hz)

    Plated/brass signatures:
      Decay τ:          400–2000 ms (lighter, low damping)
      Centroid:         600–3000 Hz (lighter substrate resonates higher)
      Q factor:         >15         (over-resonant, undamped)
      Gold-band ratio:  <0.30       (energy scattered to higher freqs)
    """
    abs_arr = np.abs(arr)
    peak_idx = int(np.argmax(abs_arr))
    peak = float(abs_arr[peak_idx])

    if peak < 0.002:
        return {"valid": False, "reason": "Signal too quiet"}

    # ── Decay time (τ) ─────────────────────────────────────────────────────────
    # Smooth post-peak envelope with 10ms window to suppress noise
    post = abs_arr[peak_idx:]
    smooth_win = max(1, int(sample_rate * 0.010))
    kernel = np.ones(smooth_win) / smooth_win
    smoothed = np.convolve(post, kernel, mode='same')

    threshold = peak * 0.10   # -20 dB
    below = np.where(smoothed < threshold)[0]
    decay_idx = int(below[0]) if len(below) else len(post) - 1
    decay_ms  = decay_idx / sample_rate * 1000

    # ── Spectral analysis via numpy rfft ───────────────────────────────────────
    # Use up to 2 seconds post-peak for frequency analysis
    seg_len = min(int(sample_rate * 2.0), len(arr) - peak_idx)
    seg_len = max(seg_len, 512)
    segment = arr[peak_idx:peak_idx + seg_len]
    window  = np.hanning(len(segment))
    spectrum = np.abs(np.fft.rfft(segment * window))
    freqs    = np.fft.rfftfreq(len(segment), 1.0 / sample_rate)

    # Suppress DC and sub-50Hz rumble
    spectrum[freqs < 50] = 0.0
    total_power = float(np.sum(spectrum)) or 1.0

    # Spectral centroid (frequency centre of mass)
    centroid = float(np.dot(freqs, spectrum) / total_power)

    # Dominant frequency (highest energy bin)
    dom_idx  = int(np.argmax(spectrum))
    dom_freq = float(freqs[dom_idx])

    # Gold band energy ratio: 150–700 Hz (characteristic of dense metals)
    gold_mask = (freqs >= 150) & (freqs <= 700)
    gold_ratio = float(np.sum(spectrum[gold_mask]) / total_power)

    # Q factor: dom_freq / bandwidth at -3dB
    half_power = float(spectrum[dom_idx]) / np.sqrt(2)
    above = np.where(spectrum > half_power)[0]
    if len(above) >= 2:
        bw = float((above[-1] - above[0]) * (sample_rate / len(segment)))
        q  = dom_freq / (bw + 1e-6)
    else:
        q = 0.0

    # ── Algorithmic score (physics-based) ─────────────────────────────────────
    score, reasons = 50, []

    # Decay: most discriminative — gold is damped, plated rings too long
    if 60 <= decay_ms <= 350:
        score += 22; reasons.append(f"Decay {decay_ms:.0f}ms — solid gold range (60-350ms)")
    elif decay_ms < 60:
        score -= 8;  reasons.append(f"Very short decay {decay_ms:.0f}ms — possible damping or noise")
    elif decay_ms <= 600:
        score -= 14; reasons.append(f"Moderate decay {decay_ms:.0f}ms — suggests lighter/plated metal")
    else:
        score -= 28; reasons.append(f"Long ring {decay_ms:.0f}ms — plated metal signature")

    # Spectral centroid
    if 150 <= centroid <= 700:
        score += 18; reasons.append(f"Centroid {centroid:.0f}Hz — dense metal (gold range 150-700Hz)")
    elif centroid <= 1200:
        score += 4;  reasons.append(f"Centroid {centroid:.0f}Hz — borderline (>700Hz suggests lighter metal)")
    else:
        score -= 16; reasons.append(f"High centroid {centroid:.0f}Hz — characteristic of plated/lighter metal")

    # Gold band energy concentration
    if gold_ratio >= 0.45:
        score += 10; reasons.append(f"Gold-band energy {gold_ratio:.0%} — concentrated in 150-700Hz")
    elif gold_ratio >= 0.30:
        score += 3;  reasons.append(f"Moderate gold-band energy {gold_ratio:.0%}")
    else:
        score -= 8;  reasons.append(f"Low gold-band energy {gold_ratio:.0%} — energy dispersed to higher freqs")

    # Q factor: real gold has moderate Q (damped but resonant), plated has very high Q
    if 5 <= q <= 40:
        score += 5;  reasons.append(f"Q-factor {q:.1f} — natural damped resonance")
    elif q > 40:
        score -= 5;  reasons.append(f"High Q-factor {q:.1f} — over-resonant (plated tendency)")

    return {
        "valid": True,
        "score": max(5, min(95, score)),
        "decay_ms": round(decay_ms, 1),
        "dom_freq": round(dom_freq, 1),
        "centroid": round(centroid, 1),
        "gold_ratio": round(gold_ratio, 4),
        "q_factor": round(q, 2),
        "reasons": reasons,
    }


@router.post("/audio-eval", response_model=AudioEvalResponse)
async def audio_eval(req: AudioEvalRequest):
    # ── Decode PCM ─────────────────────────────────────────────────────────────
    try:
        raw_b = base64.b64decode(req.samples_b64)
        arr   = np.frombuffer(raw_b, dtype=np.float32).copy()
    except Exception as e:
        logger.error(f"Audio decode error: {e}")
        return AudioEvalResponse(score=0, label="Invalid audio", decay_ms=0,
                                 dominant_freq_hz=0, spectral_centroid_hz=0,
                                 q_factor=0, gold_band_ratio=0,
                                 reasoning="Could not decode audio data.")

    # ── Algorithmic analysis ───────────────────────────────────────────────────
    metrics = _acoustic_metrics(arr, req.sample_rate)

    if not metrics.get("valid"):
        return AudioEvalResponse(score=0, label="No tap detected", decay_ms=0,
                                 dominant_freq_hz=0, spectral_centroid_hz=0,
                                 q_factor=0, gold_band_ratio=0,
                                 reasoning="Signal too quiet — tap the ornament firmly on a hard surface.")

    # ── Gemini acoustic analysis (with measured params as calibration) ─────────
    gemini_score: Optional[int] = None
    gemini_reasoning = ""
    lang_out = "Hindi (Devanagari)" if req.language == "hi" else "English"

    try:
        wav_b64 = base64.b64encode(_float32_to_wav(arr, req.sample_rate)).decode()

        prompt = (
            "You are an expert metallurgical acoustics analyst for gold-loan appraisal.\n"
            "You are given a tap-test recording AND the objectively measured acoustic parameters below.\n"
            "Listen to the audio carefully, then use BOTH your perception AND the measurements to score.\n\n"

            "MEASURED ACOUSTIC PARAMETERS (computed from signal):\n"
            f"  Decay time:        {metrics['decay_ms']:.0f} ms\n"
            f"  Dominant frequency: {metrics['dom_freq']:.0f} Hz\n"
            f"  Spectral centroid:  {metrics['centroid']:.0f} Hz\n"
            f"  Q-factor:           {metrics['q_factor']:.1f}\n"
            f"  Gold-band ratio:    {metrics['gold_ratio']:.0%} (energy in 150-700Hz)\n\n"

            "REFERENCE RANGES:\n"
            "SOLID GOLD (18K-24K, 15-18 g/cm³):\n"
            "  Decay: 60-350ms | Centroid: 150-700Hz | Q: 5-30 | Gold-band: >45%\n"
            "  Perceptual: warm, damped ring. Clean decay. No metallic shimmer.\n\n"
            "GOLD-PLATED BRASS (8.5 g/cm³):\n"
            "  Decay: 350-900ms | Centroid: 600-2500Hz | Q: >30 | Gold-band: <30%\n"
            "  Perceptual: bright, longer ring. Tinny overtones. Metallic shimmer.\n\n"
            "GOLD-PLATED SILVER:\n"
            "  Decay: >1000ms | Centroid: >1000Hz | Very clear, sustained ring.\n\n"

            "SCORING RULES:\n"
            "- If measurements AND your audio perception agree: score confidently (>70 or <30)\n"
            "- If measurements conflict with your perception: trust measurements more, score 40-60\n"
            "- Do NOT default to 50. Commit to a clear score.\n\n"

            f"Return ONLY valid JSON (reasoning in {lang_out}):\n"
            '{{"score": integer 0-100, "label": "Likely solid gold|Uncertain|Possibly gold-plated", '
            '"reasoning": "2-3 sentences citing specific evidence from audio and measurements"}}'
        )

        payload = {
            "contents": [{"parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "audio/wav", "data": wav_b64}},
            ]}],
            "generationConfig": {
                "temperature": 0.10,
                "maxOutputTokens": 400,
                "responseMimeType": "application/json",
            },
        }

        data, success = await _gemini_request(payload, timeout=45)
        if success and "candidates" in data:
            raw = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            if raw.startswith("```json"): raw = raw[7:]
            if raw.startswith("```"):     raw = raw[3:]
            if raw.endswith("```"):       raw = raw[:-3]
            g = json.loads(raw.strip())
            gemini_score    = max(0, min(100, int(g.get("score", 50))))
            gemini_reasoning = str(g.get("reasoning", ""))
            logger.info(f"audio_eval gemini={gemini_score} algo={metrics['score']} "
                        f"decay={metrics['decay_ms']}ms centroid={metrics['centroid']}Hz")
    except Exception as e:
        logger.warning(f"Gemini audio analysis skipped: {e}")

    # ── Blend: 55% Gemini perception + 45% objective measurements ─────────────
    if gemini_score is not None:
        final_score = round(gemini_score * 0.55 + metrics["score"] * 0.45)
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
        score=final_score,
        label=label,
        decay_ms=metrics["decay_ms"],
        dominant_freq_hz=metrics["dom_freq"],
        spectral_centroid_hz=metrics["centroid"],
        q_factor=metrics["q_factor"],
        gold_band_ratio=round(metrics["gold_ratio"], 3),
        reasoning=reasoning,
    )
