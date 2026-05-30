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
    build_model_vector,
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
    ONE transparent rule for every item (ring, bangle, necklace) and both modes.

    Design goal (explicit product decision): a genuine gold piece must score HIGH
    and CONSISTENTLY. The same dropped ring measures decay anywhere from ~430 ms to
    the 3000 ms ceiling depending on how it bounces, so a brittle threshold made the
    score swing 16↔87. Here the bands are deliberately WIDE: any clean, sustained
    metallic ring lands 82–92 regardless of that run-to-run decay variation, so the
    verdict no longer flips.

    Physics: solid precious metal rings with a clean, sustained resonance (long
    decay and/or a clean exponential R²). A dead, instantly-damped strike is
    base-metal-like. Honest tradeoff (chosen): a hollow/plated fake that genuinely
    rings long also scores high — acoustics cannot separate those, only the
    XRF/density step can. The disclaimer makes that explicit.

    NOTE: this is deterministic (same input → same score). It replaces the 33-clip
    classifier, which could not generalise to new recordings and was the source of
    the wild score swings.
    """
    decay_ms   = physics["decay_ms"]
    gold_ratio = physics["gold_ratio"]
    decay_r2   = physics["decay_r2"]
    snr_db     = physics.get("snr_db", 30.0)

    clean = decay_r2 >= 0.55          # clean exponential ring-down (single material)
    reasons: list[str] = []

    if decay_ms >= 1200:
        score = 88
        reasons.append(f"Long sustained metallic ring {decay_ms:.0f}ms — solid-gold-like resonance")
    elif decay_ms >= 250 and clean:
        score = 82
        reasons.append(f"Clean sustained ring {decay_ms:.0f}ms (R²={decay_r2:.2f}) — gold-like")
    elif decay_ms >= 250:
        score = 72
        reasons.append(f"Sustained ring {decay_ms:.0f}ms — gold-like (decay envelope a little noisy)")
    elif decay_ms >= 120 and clean:
        score = 64
        reasons.append(f"Short but clean ring {decay_ms:.0f}ms (R²={decay_r2:.2f}) — borderline")
    elif decay_ms >= 120:
        score = 45
        reasons.append(f"Short ring {decay_ms:.0f}ms — mixed evidence")
    else:
        score = 26
        reasons.append(f"Dead / instantly-damped strike {decay_ms:.0f}ms — base-metal-like")

    # Small nudges (kept small so they cannot flip the verdict)
    if gold_ratio >= 0.20:
        score += 4
        reasons.append(f"Strong dense-metal band energy {gold_ratio:.0%}")
    if snr_db < 15:
        score -= 6
        reasons.append(f"Low SNR {snr_db:.0f}dB — recording quality reduces certainty")

    return max(5, min(97, score)), reasons


# Confidence-sharpening gain (logit temperature scaling, T = 1/gain < 1).
# Spreads the final score toward the extremes IN PROPORTION to the model's own
# confidence: a confident "gold" reads high, a confident "fake" reads low, while
# genuinely-borderline clips stay near 50 ("inconclusive"). Monotonic and centred
# on P=0.5, so it never flips a decision — it only increases display contrast.
# Tuned on the dataset: real golds → 90s, clear fakes → single digits, gap 20→32.
_SCORE_GAIN = 2.2

def _sharpen(prob: float) -> float:
    p = min(max(prob, 1e-4), 1.0 - 1e-4)
    logit = np.log(p / (1.0 - p))
    return float(1.0 / (1.0 + np.exp(-_SCORE_GAIN * logit)))


def _classifier_score(physics: dict, mode: str) -> Optional[int]:
    """
    Return calibrated classifier score (0–100) or None if model not loaded.

    The model is trained on the compact physics-only MODEL_FEATURES (decay, R²,
    Q, gold-band) + mode bit — NOT the 134-dim vector. MFCCs and SNR were dropped
    because they overfit / are recording artifacts; see audio_features.MODEL_FEATURES.
    The calibrated P(real) is sharpened (see _sharpen) so confident verdicts read
    decisively high/low rather than clustering near the middle.
    """
    if _MODEL is None or _SCALER is None:
        return None
    try:
        vec = build_model_vector(physics, mode)
        x = _SCALER.transform(vec.reshape(1, -1))
        prob = float(_MODEL.predict_proba(x)[0][1])  # P(real)
        return max(3, min(97, round(_sharpen(prob) * 100)))
    except Exception as e:
        logger.warning("Classifier predict failed: %s", e)
        return None


_CONF_RANK = {"low": 0, "medium": 1, "high": 2}

def _cap_conf(conf: str, ceiling: str) -> str:
    """Lower `conf` to `ceiling` if it is higher (string min() would mis-order these)."""
    return conf if _CONF_RANK[conf] <= _CONF_RANK[ceiling] else ceiling


def _verdict_and_confidence(score: int, mode: str, item_type: str, low_conf_flag: bool) -> tuple[str, str]:
    """
    Bands for the compact physics model (P(real)×100), honest LOGO AUC≈0.66.

    The model catches real gold reliably (sensitivity ~85%) but the physics of
    small jewelry on glass means some imitations also ring like gold — so the
    "gold" claim stays medium unless the score is strong, and we keep a wide
    inconclusive band rather than over-claiming either way.
    """
    is_chain = item_type in {"chain", "necklace", "earring"}

    if score >= 65:
        verdict = "Likely solid gold"
        conf = "high" if score >= 78 else "medium"
    elif score >= 42:
        verdict = "Inconclusive — acoustic evidence mixed"
        conf = "low"
    elif score >= 28:
        verdict = "Possibly plated or imitation"
        conf = "medium"
    else:
        verdict = "Likely plated or imitation"
        conf = "high"

    if is_chain:
        conf = _cap_conf(conf, "medium")   # chains always capped at medium
        if score >= 65:
            verdict = "Likely solid gold (chain signal — lower certainty)"

    # Gemini's signal-quality flag can demote confidence but not flip the verdict.
    if low_conf_flag:
        conf = _cap_conf(conf, "medium" if (score >= 65 or score < 28) else "low")

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
    # extract_physics_features directly (reuses the `val` above): the classifier
    # needs only the physics dict, not MFCCs, so we skip the redundant second
    # validation + MFCC pass that build_feature_vector would do.
    physics = extract_physics_features(arr, sr, val, item_type, mode)

    # ── Score: transparent deterministic physics rule ─────────────────────────
    # The 33-clip classifier could not generalise to new recordings (the same ring
    # scored 16↔87 across drops), so scoring is the explainable _physics_score:
    # same input → same score, real gold reliably high. See _physics_score.
    final_score, reasons = _physics_score(physics, item_type, mode)
    score_source = "physics_rule"
    physics["_reasons"] = reasons

    logger.info(
        f"audio_eval [{item_type}/{mode}] source={score_source} score={final_score} "
        f"decay={physics['decay_ms']}ms centroid={physics['centroid_hz']}Hz "
        f"r2={physics['decay_r2']:.2f} snr={physics['snr_db']:.0f}dB"
    )

    # ── Gemini explanation (never blocks, never changes score) ─────────────────
    explanation, low_conf = await _gemini_explain(arr, sr, physics, final_score, item_type, mode, lang)

    # ── Verdict + confidence ───────────────────────────────────────────────────
    verdict, confidence = _verdict_and_confidence(final_score, mode, item_type, low_conf)

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
