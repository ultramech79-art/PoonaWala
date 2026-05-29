"""
POST /api/audio-eval
Acoustic gold-authenticity screening.

Architecture:
  1. VALIDATE  — SNR, onset detection, attack time. Reject silence/noise.
  2. FEATURES  — physics metrics (decay, centroid, gold-band, HF ratio, R²)
                 + MFCC-40 + delta + delta-delta (librosa)
  3. SCORE     — calibrated SVC classifier (if model exists) OR
                 physics heuristic (fallback). LLM never touches the number.
  4. EXPLAIN   — Gemini 2.5 Flash: 2–3 sentence explanation + low_confidence_flag.
                 Gemini failure never blocks the score.
  5. RESPOND   — score, verdict, confidence, params, explanation, disclaimer.

Hard constraints:
  - Groq is NOT used here. Groq = speech-to-text (Whisper); useless on metallic taps.
  - Gemini model name: gemini-2.5-flash (set via GEMINI_MODEL env var).
  - Score = classifier probability × 100 (or heuristic). LLM never edits it.
  - Drop mode → longer clean decay = primary discriminator for real gold.
  - Tap mode → spectral features (centroid, gold band) matter more.
"""
import base64
import io
import logging
import os
import struct
from typing import Optional

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel

from app.data.audio_features import (
    build_feature_vector,
    extract_physics_features,
    validate_recording,
    preprocess,
    PHYSICS_KEYS,
)
from app.data.gemini import (
    GEMINI_AUDIO_VIDEO_API_KEYS,
    GEMINI_MODEL,
    _gemini_request,
    extract_gemini_text,
    parse_json_response,
)

logger = logging.getLogger("goldeye.audio_eval")
router = APIRouter()

DISCLAIMER = (
    "Acoustic screening only — not a guarantee of authenticity. "
    "Confirm with a jeweller (XRF/acid/density) before any purchase decision."
)

# ── Load classifier at startup (once). Falls back to None if not trained yet. ──
_MODEL  = None
_SCALER = None

def _load_model():
    global _MODEL, _SCALER
    _dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "audio_gold")
    mp = os.path.join(_dir, "model.joblib")
    sp = os.path.join(_dir, "feature_scaler.joblib")
    if os.path.exists(mp) and os.path.exists(sp):
        try:
            import joblib
            _MODEL  = joblib.load(mp)
            _SCALER = joblib.load(sp)
            logger.info("Audio classifier loaded from %s", mp)
        except Exception as e:
            logger.warning("Could not load audio classifier: %s", e)

_load_model()


# ── Request / Response models ─────────────────────────────────────────────────

class AudioEvalRequest(BaseModel):
    # Primary field names
    audio_base64: Optional[str] = None
    sample_rate:  int = 48000
    item_type:    str = "unknown"
    mode:         str = "tap"   # "tap" or "drop" only — rattle removed
    language:     str = "en"

    # Legacy aliases
    samples_b64:   Optional[str] = None
    ornament_type: Optional[str] = None
    test_mode:     Optional[str] = None


class AudioParams(BaseModel):
    decay_time_ms:        float
    spectral_centroid_hz: float
    dominant_freq_hz:     float
    gold_band_ratio:      float
    hf_ratio:             float
    exp_decay_r2:         float
    snr_db:               float
    tap_events:           int
    attack_ms:            float
    q_factor:             float


class AudioEvalResponse(BaseModel):
    score:              int               # 0–100, classifier or heuristic — LLM never touches this
    verdict:            str
    confidence:         str               # low | medium | high
    params:             Optional[AudioParams]
    explanation:        str
    low_confidence_flag: bool
    disclaimer:         str
    valid:              bool
    reject_reason:      Optional[str]
    # Legacy flat fields kept for old frontend compatibility
    label:              str
    decay_ms:           float = 0.0
    dominant_freq_hz:   float = 0.0
    spectral_centroid_hz: float = 0.0
    q_factor:           float = 0.0
    gold_band_ratio:    float = 0.0
    decay_r2:           float = 0.0
    snr_db:             float = 0.0
    attack_ms:          float = 0.0
    event_count:        int   = 0
    test_mode:          str   = "tap"
    reasoning:          str   = ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve_request(req: AudioEvalRequest) -> tuple[str, int, str, str, str]:
    """Normalise legacy + new field names."""
    audio_b64  = req.audio_base64 or req.samples_b64 or ""
    sr         = req.sample_rate
    item_type  = (req.ornament_type or req.item_type or "unknown").lower().strip()
    mode       = (req.test_mode    or req.mode      or "tap").lower().strip()
    if mode not in {"tap", "drop"}:
        mode = "tap"   # rattle and auto no longer accepted
    lang = req.language or "en"
    return audio_b64, sr, item_type, mode, lang


def _float32_to_wav(arr: np.ndarray, sr: int) -> bytes:
    data = arr.astype(np.float32).tobytes()
    buf  = io.BytesIO()
    buf.write(b"RIFF"); buf.write(struct.pack("<I", 36 + len(data))); buf.write(b"WAVE")
    buf.write(b"fmt "); buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 3)); buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sr)); buf.write(struct.pack("<I", sr * 4))
    buf.write(struct.pack("<H", 4)); buf.write(struct.pack("<H", 32))
    buf.write(b"data"); buf.write(struct.pack("<I", len(data))); buf.write(data)
    return buf.getvalue()


def _invalid_response(reason: str, mode: str = "tap") -> AudioEvalResponse:
    return AudioEvalResponse(
        score=0, verdict="Invalid recording", confidence="low",
        params=None, explanation=reason, low_confidence_flag=True,
        disclaimer=DISCLAIMER, valid=False, reject_reason=reason,
        label="Invalid recording", decay_ms=0, dominant_freq_hz=0,
        spectral_centroid_hz=0, q_factor=0, gold_band_ratio=0,
        decay_r2=0, snr_db=0, attack_ms=0, event_count=0,
        test_mode=mode, reasoning=reason,
    )


# ── Scoring ───────────────────────────────────────────────────────────────────

_ORNAMENT_RANGES = {
    "ring":     {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 400, "centroid_hi": 1000},
    "bangle":   {"decay_lo": 100, "decay_hi": 600, "centroid_lo": 200, "centroid_hi": 600},
    "necklace": {"decay_lo": 45,  "decay_hi": 360, "centroid_lo": 180, "centroid_hi": 900},
    "pendant":  {"decay_lo": 60,  "decay_hi": 300, "centroid_lo": 350, "centroid_hi": 1200},
    "earring":  {"decay_lo": 30,  "decay_hi": 200, "centroid_lo": 400, "centroid_hi": 1600},
    "coin":     {"decay_lo": 150, "decay_hi": 700, "centroid_lo": 250, "centroid_hi": 650},
}
_DEFAULT_RANGE = {"decay_lo": 60, "decay_hi": 450, "centroid_lo": 250, "centroid_hi": 1000}


def _physics_score(physics: dict, item_type: str, mode: str) -> tuple[int, list[str]]:
    """
    Drop mode: decay time is the PRIMARY discriminator and carries most of the weight.

    Physics basis:
      Gold internal damping: 3×10⁻⁴ → very low energy loss → long sustained ring
      Brass/zinc damping:    2–10×10⁻⁴ → 3–10× faster decay → dead, short ring
      At 5% threshold (phone on glass): real gold 100ms–2500ms, fakes 80–200ms.
      LONGER = more gold-like. Secondary features (gold-band, R²) are confirmatory only.

    Weight design:
      DROP: decay contributes ±48 of the ~45-point swing above/below 50.
            All secondary features combined cap at ~±10.
      TAP:  gold-band is primary; decay secondary (multiple taps obscure decay).
    """
    decay_ms   = physics["decay_ms"]
    gold_ratio = physics["gold_ratio"]
    hf_ratio   = physics["hf_ratio"]
    decay_r2   = physics["decay_r2"]
    events     = physics["event_count"]
    is_drop    = mode == "drop"

    score, reasons = 50, []

    # ── DECAY TIME (drop: primary / tap: secondary) ───────────────────────────
    if is_drop:
        # Fakes (5% threshold): 80–200ms.  Real gold: 80ms (small ring) – 2500ms (bangle).
        # Thresholds sized so that the ≥150ms band covers real necklaces / medium rings
        # and the ≥250ms / ≥500ms bands cover rings and bangles that ring visibly longer.
        if decay_ms >= 500:
            score += 48
            reasons.append(f"Very long ring {decay_ms:.0f}ms — solid gold sustains resonance (damping 3×10⁻⁴)")
        elif decay_ms >= 250:
            score += 38
            reasons.append(f"Long drop decay {decay_ms:.0f}ms — well above typical base-metal range")
        elif decay_ms >= 150:
            score += 16
            reasons.append(f"Drop decay {decay_ms:.0f}ms — moderate; secondary features determine verdict")
        elif decay_ms >= 80:
            score += 4
            reasons.append(f"Drop decay {decay_ms:.0f}ms — borderline overlap zone")
        else:
            score -= 25
            reasons.append(f"Short drop decay {decay_ms:.0f}ms — consistent with high-damping base metal")
    else:
        # Tap: decay less reliable (multiple taps extend apparent decay for both classes)
        if decay_ms >= 80:
            score += 10
            reasons.append(f"Tap decay {decay_ms:.0f}ms — supportive")
        elif decay_ms < 35:
            score -= 8
            reasons.append(f"Very short tap decay {decay_ms:.0f}ms")

    # ── SECONDARY FEATURES (confirmatory, total max ±10) ─────────────────────

    # Gold-band energy: real avg 16.6% vs fake avg 10.8%
    if gold_ratio >= 0.20:
        score += 6
        reasons.append(f"Gold-band energy {gold_ratio:.0%} — above real-gold average (16.6%)")
    elif gold_ratio >= 0.12:
        score += 2
        reasons.append(f"Gold-band energy {gold_ratio:.0%} — moderate")
    else:
        score -= 5
        reasons.append(f"Low gold-band energy {gold_ratio:.0%} — below fake average (10.8%)")

    # R²: only meaningful paired with a long decay (multi-mode bangles have low R²)
    if decay_r2 >= 0.95 and decay_ms >= 150:
        score += 4
        reasons.append(f"R²={decay_r2:.2f} with long decay — clean single-material ring")

    # HF ratio: 60–90% normal on glass — only flag true extremes
    if hf_ratio > 0.92:
        score -= 2
        reasons.append(f"Very high HF {hf_ratio:.0%} — possible noise")
    elif hf_ratio < 0.20:
        score += 3
        reasons.append(f"Low HF {hf_ratio:.0%} — warm acoustic signature")

    # Multi-tap bonus (tap mode only — drop mode onset count reflects ring harmonics)
    if not is_drop and events >= 3:
        score += 3
        reasons.append(f"{events} tap impacts detected")

    return max(5, min(95, score)), reasons


def _classifier_score(feature_vec: np.ndarray) -> Optional[int]:
    """Return calibrated classifier score (0–100) or None if model not loaded."""
    if _MODEL is None or _SCALER is None:
        return None
    try:
        x = _SCALER.transform(feature_vec.reshape(1, -1))
        prob = float(_MODEL.predict_proba(x)[0][1])  # P(real)
        return max(5, min(95, round(prob * 100)))
    except Exception as e:
        logger.warning("Classifier predict failed: %s", e)
        return None


def _verdict_and_confidence(score: int, mode: str, item_type: str, low_conf_flag: bool, language: str = "en") -> tuple[str, str]:
    is_chain = item_type in {"chain", "necklace", "earring"}
    hi = language == "hi"

    # Boundaries calibrated on 33-clip dataset (real min=63, fake max=77).
    # Classifier output compresses to 53–77; "high" fires only for physics heuristic scores >= 82.
    # Lower boundary raised 50 → 62: fakes at 53–58 now correctly reach "Possibly plated"
    # without pushing real gold (dataset min=63) into that zone.
    if score >= 72:
        verdict = "संभवतः ठोस सोना है" if hi else "Likely solid gold"
        conf = "high" if score >= 82 and not is_chain else "medium"
    elif score >= 62:
        verdict = "अनिश्चित — ध्वनि प्रमाण मिश्रित है" if hi else "Inconclusive — acoustic evidence mixed"
        conf = "medium"
    else:
        verdict = "संभवतः प्लेटेड या नकली है" if hi else "Possibly plated or imitation"
        conf = "medium" if score >= 40 else "low"

    if is_chain:
        conf = min(conf, "medium")  # chains always capped at medium
        if score >= 72:
            verdict = "संभवतः ठोस सोना (चेन सिग्नल — कम निश्चितता)" if hi else "Likely solid gold (chain signal — lower certainty)"

    # Gemini low_confidence_flag can demote confidence, but not override a clear
    # physics verdict. Score >= 72 already signals "Likely solid gold" — Gemini's
    # signal-quality uncertainty should not collapse that to "low confidence".
    if low_conf_flag:
        if score >= 72:
            conf = "medium"   # cap at medium; don't go to low for a clear score
        else:
            conf = "low"

    return verdict, conf


# ── Gemini explanation (explanation only, never affects score) ────────────────

async def _gemini_explain(
    arr: np.ndarray, sr: int, physics: dict, score: int,
    item_type: str, mode: str, lang: str,
) -> tuple[str, bool]:
    """
    Ask Gemini to explain the measured parameters in plain language.
    Returns (explanation_text, low_confidence_flag).
    On any failure, returns a templated explanation — score is unaffected.
    """
    if not GEMINI_AUDIO_VIDEO_API_KEYS:
        return _templated_explanation(physics, score, item_type, mode), False

    lang_out = "Hindi (Devanagari)" if lang == "hi" else "English"
    try:
        wav_b64 = base64.b64encode(_float32_to_wav(arr, sr)).decode()

        # Mode-specific context: critical because Gemini's prior for gold is
        # free-air ring (1–3 seconds). Phone recordings on glass are much shorter.
        # Without this context Gemini calls 120–300ms "extremely short" which is WRONG.
        if mode == "drop":
            mode_ctx = (
                "DROP TEST — phone recording on glass surface:\n"
                "  Real solid gold (2–15g jewelry): decay 100–2000 ms depending on mass.\n"
                "  Imitation/plated (brass, zinc): decay 50–160 ms — shorter, more damped.\n"
                "  Gold internal damping = 3e-4 (very low) → LONGER ring. Brass 3–10× higher.\n"
                "  LONGER decay = more gold-like. High-freq ratio 60–90% is NORMAL on glass.\n"
                "  Do NOT call a decay of 100–500 ms 'short' — it is typical for phone tests.\n"
            )
        else:
            mode_ctx = (
                "TAP TEST — phone held near ornament:\n"
                "  Gold-band energy >15% and decay >80 ms favour real gold.\n"
                "  High-freq ratio 60–90% is normal for glass surface — not an indicator.\n"
            )

        prompt = (
            f"You are an acoustic-analysis assistant for jewelry authentication. "
            f"A separate physics classifier scored this {item_type} at {score}/100. "
            f"You ONLY explain the measured parameters — you do NOT change the score.\n\n"
            f"{mode_ctx}\n"
            f"Measured parameters:\n"
            f"  Decay time: {physics['decay_ms']:.0f} ms\n"
            f"  Dominant freq: {physics['dom_freq_hz']:.0f} Hz\n"
            f"  Spectral centroid: {physics['centroid_hz']:.0f} Hz\n"
            f"  Gold-band energy: {physics['gold_ratio']:.0%}\n"
            f"  High-freq ratio: {physics['hf_ratio']:.0%}\n"
            f"  Decay R²: {physics['decay_r2']:.2f}\n"
            f"  SNR: {physics['snr_db']:.0f} dB\n\n"
            f"In 2–3 sentences ({lang_out}), explain what these parameters suggest. "
            f"Set low_confidence to true ONLY for genuine signal quality problems: "
            f"SNR < 20 dB, or no clear impact detected. "
            f"Do NOT set low_confidence based on physics interpretation — the classifier handles that.\n"
            f"Respond ONLY with JSON: "
            '{"explanation": "<text>", "low_confidence": true/false}'
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
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {
                        "explanation":     {"type": "STRING"},
                        "low_confidence":  {"type": "BOOLEAN"},
                    },
                    "required": ["explanation", "low_confidence"],
                },
            },
        }
        data, success = await _gemini_request(payload, timeout=45, api_keys=GEMINI_AUDIO_VIDEO_API_KEYS)
        if success and "candidates" in data:
            g = parse_json_response(extract_gemini_text(data))
            explanation = str(g.get("explanation", "")).strip()
            low_conf    = bool(g.get("low_confidence", False))
            if explanation:
                logger.info(f"Gemini explanation ok [{item_type}/{mode}] model={GEMINI_MODEL}")
                return explanation, low_conf
    except Exception as e:
        logger.warning(f"Gemini explanation failed [{item_type}/{mode}]: {e}")

    return _templated_explanation(physics, score, item_type, mode), False


def _templated_explanation(physics: dict, score: int, item_type: str, mode: str) -> str:
    d   = physics["decay_ms"]
    c   = physics["centroid_hz"]
    r2  = physics["decay_r2"]
    hf  = physics["hf_ratio"]
    is_drop = mode == "drop"

    if score >= 72:
        base = (
            f"The {mode} test on this {item_type} shows a decay of {d:.0f} ms "
            f"with a spectral centroid at {c:.0f} Hz, consistent with solid gold. "
        )
        if is_drop and r2 >= 0.75:
            base += f"The clean exponential decay (R²={r2:.2f}) suggests a single-material composition."
    elif score >= 50:
        base = (
            f"The acoustic signature is mixed. Decay of {d:.0f} ms and centroid at {c:.0f} Hz "
            f"are within range for some gold ornaments but inconclusive for this {item_type}. "
            f"Try a {'drop' if mode == 'tap' else 'tap'} test for additional evidence."
        )
    else:
        base = (
            f"The {mode} test shows a centroid at {c:.0f} Hz "
            f"{'and high-frequency energy (' + str(round(hf*100)) + '%) suggesting a bright substrate. ' if hf > 0.20 else ''}"
            f"This pattern is more consistent with plated or imitation metal than solid gold."
        )
    return base


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("/audio-eval", response_model=AudioEvalResponse)
async def audio_eval(req: AudioEvalRequest):
    audio_b64, sr, item_type, mode, lang = _resolve_request(req)

    # ── Decode ─────────────────────────────────────────────────────────────────
    if not audio_b64:
        return _invalid_response("No audio data provided.", mode)
    try:
        raw_b = base64.b64decode(audio_b64)
        # Truncate to nearest multiple of 4 bytes (float32 = 4 bytes)
        trim = len(raw_b) - (len(raw_b) % 4)
        if trim == 0:
            return _invalid_response("Audio data too short. Please try again.", mode)
        arr = preprocess(np.frombuffer(raw_b[:trim], dtype=np.float32).copy())
    except Exception as e:
        logger.error(f"Audio decode error: {e}")
        return _invalid_response("Could not decode audio. Please try again.", mode)

    # ── Validate ───────────────────────────────────────────────────────────────
    val = validate_recording(arr, sr, item_type, mode)
    if not val["valid"]:
        reason = val["reason"]
        if lang == "hi":
            reason = f"कृपया फिर से रिकॉर्ड करें। {reason}"
        logger.info(f"audio_eval invalid: {reason}")
        return _invalid_response(reason, mode)

    # ── Feature extraction ────────────────────────────────────────────────────
    feature_vec, physics, _ = build_feature_vector(arr, sr, item_type, mode)

    # ── Score (classifier > physics heuristic) ────────────────────────────────
    clf_score = _classifier_score(feature_vec) if feature_vec is not None else None
    if clf_score is not None:
        final_score = clf_score
        score_source = "classifier"
    else:
        heuristic, reasons = _physics_score(physics, item_type, mode)
        final_score  = heuristic
        score_source = "physics_heuristic"
        physics["_reasons"] = reasons

    logger.info(
        f"audio_eval [{item_type}/{mode}] source={score_source} score={final_score} "
        f"decay={physics['decay_ms']}ms centroid={physics['centroid_hz']}Hz "
        f"r2={physics['decay_r2']:.2f} snr={physics['snr_db']:.0f}dB"
    )

    # ── Gemini explanation (never blocks, never changes score) ─────────────────
    explanation, low_conf = await _gemini_explain(arr, sr, physics, final_score, item_type, mode, lang)

    # ── Verdict + confidence ───────────────────────────────────────────────────
    verdict, confidence = _verdict_and_confidence(final_score, mode, item_type, low_conf, language=lang)

    params = AudioParams(
        decay_time_ms=physics["decay_ms"],
        spectral_centroid_hz=physics["centroid_hz"],
        dominant_freq_hz=physics["dom_freq_hz"],
        gold_band_ratio=physics["gold_ratio"],
        hf_ratio=physics["hf_ratio"],
        exp_decay_r2=physics["decay_r2"],
        snr_db=physics["snr_db"],
        tap_events=physics["event_count"],
        attack_ms=physics["attack_ms"],
        q_factor=physics["q_factor"],
    )

    return AudioEvalResponse(
        score=final_score, verdict=verdict, confidence=confidence,
        params=params, explanation=explanation,
        low_confidence_flag=low_conf, disclaimer=DISCLAIMER,
        valid=True, reject_reason=None,
        # Legacy flat fields
        label=verdict, decay_ms=physics["decay_ms"],
        dominant_freq_hz=physics["dom_freq_hz"],
        spectral_centroid_hz=physics["centroid_hz"],
        q_factor=physics["q_factor"],
        gold_band_ratio=physics["gold_ratio"],
        decay_r2=physics["decay_r2"],
        snr_db=physics["snr_db"],
        attack_ms=physics["attack_ms"],
        event_count=physics["event_count"],
        test_mode=mode,
        reasoning=explanation,
    )
