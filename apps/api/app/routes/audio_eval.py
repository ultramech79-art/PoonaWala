"""
POST /api/audio-eval
Accepts raw float32 PCM audio (base64) from a 10-second tap test.
Blends Gemini REST API acoustic analysis (60%) with algorithmic FFT (40%).
No Vertex AI / service account needed — uses GEMINI_API_KEY.
"""
import io
import json
import logging
import math
import os
import struct
from typing import Optional

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
    reasoning: str


def _float32_to_wav(samples: list[float], sample_rate: int) -> bytes:
    n    = len(samples)
    data = struct.pack(f"<{n}f", *samples)
    buf  = io.BytesIO()
    buf.write(b"RIFF"); buf.write(struct.pack("<I", 36 + len(data))); buf.write(b"WAVE")
    buf.write(b"fmt "); buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 3)); buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sample_rate)); buf.write(struct.pack("<I", sample_rate * 4))
    buf.write(struct.pack("<H", 4)); buf.write(struct.pack("<H", 32))
    buf.write(b"data"); buf.write(struct.pack("<I", len(data))); buf.write(data)
    return buf.getvalue()


def _analyze_algorithmic(samples: list[float], sample_rate: int) -> dict:
    abs_s = [abs(x) for x in samples]
    peak  = max(abs_s) if abs_s else 0
    if peak < 0.003:
        return {"score": 0, "decay_ms": 0.0, "dom_freq": 0.0,
                "reasons": ["Signal too quiet — tap ornament firmly."]}

    peak_i  = abs_s.index(peak)
    decay_i = len(abs_s) - 1
    thresh  = peak * 0.12
    for i in range(peak_i, len(abs_s)):
        if abs_s[i] < thresh: decay_i = i; break
    decay_ms = (decay_i - peak_i) / sample_rate * 1000

    fft_n    = min(1024, len(samples) - peak_i)
    centroid = dom_freq = 0.0
    if fft_n >= 64:
        seg  = samples[peak_i:peak_i + fft_n]
        hann = [0.5 * (1 - math.cos(2 * math.pi * i / (fft_n - 1))) for i in range(fft_n)]
        wseg = [seg[i] * hann[i] for i in range(fft_n)]
        mags, half = [], fft_n // 2
        for k in range(half):
            re = sum(wseg[t] * math.cos(2 * math.pi * k * t / fft_n) for t in range(fft_n))
            im = sum(wseg[t] * math.sin(2 * math.pi * k * t / fft_n) for t in range(fft_n))
            mags.append(math.sqrt(re * re + im * im))
        freq_res = sample_rate / fft_n
        tot_mag  = sum(mags) or 1
        centroid = sum(i * freq_res * mags[i] for i in range(len(mags))) / tot_mag
        dom_freq = mags.index(max(mags[1:] or [mags[0]])) * freq_res if mags else 0.0

    score, reasons = 50, []
    if 60 <= decay_ms <= 300:
        score += 28; reasons.append(f"Decay {decay_ms:.0f}ms — gold range")
    elif decay_ms < 60:
        score -= 5;  reasons.append(f"Very short decay {decay_ms:.0f}ms")
    elif decay_ms <= 500:
        score -= 8;  reasons.append(f"Moderate decay {decay_ms:.0f}ms (brass-like)")
    else:
        score -= 22; reasons.append(f"Long ring {decay_ms:.0f}ms — plated likely")

    if 0 < centroid < 600:
        score += 18; reasons.append(f"Warm tone {centroid:.0f}Hz")
    elif centroid < 1200:
        score += 5;  reasons.append(f"Mid tone {centroid:.0f}Hz")
    elif centroid > 0:
        score -= 12; reasons.append(f"Bright/tinny {centroid:.0f}Hz — plated indicator")

    return {"score": max(5, min(95, score)), "decay_ms": decay_ms,
            "dom_freq": dom_freq, "reasons": reasons}


@router.post("/audio-eval", response_model=AudioEvalResponse)
async def audio_eval(req: AudioEvalRequest):
    import base64

    try:
        raw_b = base64.b64decode(req.samples_b64)
        n     = len(raw_b) // 4
        samps = list(struct.unpack(f"<{n}f", raw_b[:n * 4]))
    except Exception as e:
        logger.error(f"Audio decode error: {e}")
        return AudioEvalResponse(score=0, label="Invalid audio",
                                 decay_ms=0, dominant_freq_hz=0,
                                 reasoning="Could not decode audio data.")

    algo = _analyze_algorithmic(samps, req.sample_rate)
    if algo["score"] == 0:
        return AudioEvalResponse(score=0, label="No tap detected",
                                 decay_ms=0.0, dominant_freq_hz=0.0,
                                 reasoning="Signal too quiet — tap the ornament firmly on a hard surface.")

    # Gemini REST API audio analysis
    gemini_score: Optional[int] = None
    gemini_reasoning = ""
    try:
        wav_bytes  = _float32_to_wav(samps, req.sample_rate)
        wav_b64    = base64.b64encode(wav_bytes).decode()
        lang_out   = "Hindi (Devanagari)" if req.language == "hi" else "English"

        prompt = (
            "You are an expert metallurgical acoustics analyst for gold-loan appraisal.\n"
            "Listen carefully to this recording of a metal ornament being tapped.\n\n"
            "Key acoustic signatures:\n"
            "- SOLID GOLD (18K–24K): Dense (15–18 g/cm³). Warm, damped ring. "
            "Decay 80–350ms. Spectral centroid 200–700Hz. Clean exponential envelope.\n"
            "- GOLD-PLATED BRASS: Rings brighter and LONGER. Decay 350–900ms. "
            "Centroid 600–2500Hz. Tinny overtones.\n"
            "- GOLD-PLATED SILVER: Very clear, long ring >1s. High centroid 1000–4000Hz.\n\n"
            f"Score 0–100 for solid gold likelihood (100=definitely solid, 0=definitely plated).\n\n"
            f"Return ONLY valid JSON:\n"
            '{{"score": integer, "decay_ms": float, "dominant_freq_hz": float, '
            f'"label": "string", "reasoning": "in {lang_out}"}}'
        )

        payload = {
            "contents": [{
                "parts": [
                    {"text": prompt},
                    {"inlineData": {"mimeType": "audio/wav", "data": wav_b64}},
                ]
            }],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 300,
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
            logger.info(f"audio_eval gemini: score={gemini_score}")
    except Exception as e:
        logger.warning(f"Gemini audio analysis skipped: {e}")

    # Blend: 60% Gemini + 40% algorithmic
    if gemini_score is not None:
        final_score = round(gemini_score * 0.60 + algo["score"] * 0.40)
        reasoning   = gemini_reasoning or " | ".join(algo["reasons"])
    else:
        final_score = algo["score"]
        reasoning   = " | ".join(algo["reasons"])

    final_score = max(5, min(95, final_score))
    label = (
        "Likely solid gold"         if final_score >= 70 else
        "Uncertain — may be plated" if final_score >= 50 else
        "Possibly gold-plated"
    )

    return AudioEvalResponse(
        score=final_score,
        label=label,
        decay_ms=round(algo["decay_ms"], 1),
        dominant_freq_hz=round(algo["dom_freq"], 1),
        reasoning=reasoning,
    )
