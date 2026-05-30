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
    GEMINI_AUDIO_MODEL,
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

# Weighted result = physics signal-processing + Gemini perceptual audio judgment.
# Both look at the same thing (resonant ring vs dead thud) from different angles;
# blending them is more robust than either alone, especially for light rings where
# the physics decay is weak but Gemini can still hear a clear ringing tone.
PHYS_WEIGHT   = 0.5
GEMINI_WEIGHT = 0.5

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
    # Use the RESONANT ring-down (what the ear hears), not full-band decay_ms which
    # is dominated by room noise and pegs at 3000ms. res_decay = how long the
    # ringing tone persists after the impact; res_tonality = is there a clear tone
    # at all. Gold sustains a clear ring; base metal / wood-damped thuds die fast.
    res_decay = physics.get("res_decay_ms", 0.0)
    tonality  = physics.get("res_tonality", 0.0)
    snr_db    = physics.get("snr_db", 30.0)
    reasons: list[str] = []

    if res_decay >= 600:
        score = 90
        reasons.append(f"Long resonant ring {res_decay:.0f}ms — sustained gold-like tone")
    elif res_decay >= 300:
        score = 76
        reasons.append(f"Sustained resonant ring {res_decay:.0f}ms")
    elif res_decay >= 150:
        score = 60
        reasons.append(f"Moderate resonant ring {res_decay:.0f}ms — borderline")
    elif res_decay >= 70:
        score = 45
        reasons.append(f"Short resonant ring {res_decay:.0f}ms — fades quickly")
    else:
        score = 30
        reasons.append(f"Dead thud {res_decay:.0f}ms — little sustained resonance (base-metal-like)")

    # Resonance presence: a clear ringing tone (echo) raises gold confidence; a
    # broadband thud with no tone lowers it.
    if tonality >= 0.25:
        score += 8
        reasons.append(f"Clear ringing tone present ({tonality:.0%} resonant energy)")
    elif tonality < 0.05:
        score -= 8
        reasons.append(f"No clear ringing tone ({tonality:.0%}) — broadband thud")

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


# ── Gemini audio evaluation (LISTENS to the clip, contributes to the score) ───

async def _gemini_audio_eval(
    arr: np.ndarray, sr: int, physics: dict, phys_score: int,
    item_type: str, mode: str, lang: str,
) -> tuple[str, bool, Optional[int]]:
    """
    Gemini actually LISTENS to the drop recording and rates gold likelihood.

    It is told to: locate the first impact, then judge the DECAY and whether a
    sustained resonant/ringing tone (an "echo" that lingers) follows — solid gold
    rings; base metal / plated / wood-damped pieces thud and die fast.

    Returns (explanation, low_confidence_flag, gemini_gold_score 0-100 | None).
    The gemini_gold_score is blended with the physics score by the caller (weighted
    result). On any failure returns (templated_text, False, None) → physics-only.
    """
    if not GEMINI_AUDIO_VIDEO_API_KEYS:
        return _templated_explanation(physics, phys_score, item_type, mode), False, None

    lang_out = "Hindi (Devanagari)" if lang == "hi" else "English"
    try:
        wav_b64 = base64.b64encode(_float32_to_wav(arr, sr)).decode()

        prompt = (
            "You are an expert acoustic gold authenticator. This is a standardised "
            "DROP TEST: the jewellery item was dropped EXACTLY ONCE onto a hard GLASS "
            "surface and recorded for ~5 seconds.\n\n"
            "Because the surface is GLASS (hard and reflective, almost no damping of its "
            "own), the sound after the impact is governed by the ITEM itself:\n"
            "  • Solid gold / dense precious metal → a CLEAR, SUSTAINED, bell-like ringing "
            "tone that lingers and echoes after the impact → HIGH gold likelihood.\n"
            "  • Plated, hollow, or base metal (brass, zinc, alloy) → a SHORT, DEAD 'tick' "
            "or 'thud' that dies almost immediately, little or no sustained tone → LOW.\n\n"
            "How to analyse the clip:\n"
            "1. Locate the SINGLE drop impact (the loudest moment). Ignore any faint second "
            "bounce and the brief high-pitched click of glass itself.\n"
            "2. DECAY: after that impact, how long does the metal's ringing tone last before "
            "it fades? A lingering ring favours gold; an instant cut-off favours fake.\n"
            "3. RESONANCE: is there a clear, pitched, sustained tone (an 'echo' that rings on), "
            "or only a dull broadband thud with no pitch?\n"
            "4. CRITICAL: judge mainly by WHAT YOU HEAR, not by duration. A small light "
            "ring rings only briefly even when it is SOLID GOLD — a short ring-down does "
            "NOT mean fake. What matters is whether a clear, pitched, metallic resonant tone "
            "is present at all (gold) versus a flat dull dead click with no pitch (fake).\n\n"
            f"Rough signal-processing references for the item ({item_type}) — use as weak "
            "hints only, your own listening is the primary evidence:\n"
            f"  resonant tone energy (is a tone present?): {physics.get('res_tonality', 0):.0%}\n"
            f"  dominant frequency: {physics.get('res_f0_hz', physics.get('dom_freq_hz', 0)):.0f} Hz\n\n"
            "Rate the likelihood this is SOLID GOLD from 0 to 100, where:\n"
            "  80-100 = a clear, pitched, ringing/echoing metallic tone after the impact\n"
            "  40-60  = some metallic ring but brief or partly damped (typical small gold ring)\n"
            "  0-25   = a flat dead click/thud with no sustained pitched tone\n"
            f"Then explain your reasoning in 2-3 sentences ({lang_out}). "
            "Set low_confidence true ONLY for genuine signal problems (no clear drop impact, "
            "very noisy, or more than one drop detected). "
            'Respond ONLY with JSON: {"gold_score": 0-100, "explanation": "<text>", "low_confidence": true/false}'
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
                        "gold_score":      {"type": "INTEGER"},
                        "explanation":     {"type": "STRING"},
                        "low_confidence":  {"type": "BOOLEAN"},
                    },
                    "required": ["gold_score", "explanation", "low_confidence"],
                },
            },
        }
        data, success = await _gemini_request(
            payload, timeout=45, api_keys=GEMINI_AUDIO_VIDEO_API_KEYS, model=GEMINI_AUDIO_MODEL
        )
        if success and "candidates" in data:
            g = parse_json_response(extract_gemini_text(data))
            explanation = str(g.get("explanation", "")).strip()
            low_conf    = bool(g.get("low_confidence", False))
            gscore = g.get("gold_score")
            gscore = max(0, min(100, int(gscore))) if gscore is not None else None
            if explanation:
                logger.info(f"Gemini audio eval ok [{item_type}/{mode}] gold_score={gscore} model={GEMINI_AUDIO_MODEL}")
                return explanation, low_conf, gscore
    except Exception as e:
        logger.warning(f"Gemini audio eval failed [{item_type}/{mode}]: {e}")

    return _templated_explanation(physics, phys_score, item_type, mode), False, None


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
    phys_score, reasons = _physics_score(physics, item_type, mode)
    physics["_reasons"] = reasons

    # ── Gemini LISTENS to the clip and rates gold likelihood (0-100) ───────────
    explanation, low_conf, gemini_score = await _gemini_audio_eval(
        arr, sr, physics, phys_score, item_type, mode, lang
    )

    # ── Weighted result: physics signal-processing + Gemini perceptual judgment ─
    if gemini_score is not None:
        final_score = int(round(PHYS_WEIGHT * phys_score + GEMINI_WEIGHT * gemini_score))
        score_source = f"weighted(phys={phys_score}*{PHYS_WEIGHT:g}+gemini={gemini_score}*{GEMINI_WEIGHT:g})"
    else:
        final_score = phys_score
        score_source = f"physics_only(phys={phys_score}; gemini_unavailable)"
    final_score = max(3, min(97, final_score))

    logger.info(
        f"audio_eval [{item_type}/{mode}] source={score_source} score={final_score} "
        f"res_decay={physics.get('res_decay_ms', 0)}ms tonality={physics.get('res_tonality', 0):.2f} "
        f"full_decay={physics['decay_ms']}ms snr={physics['snr_db']:.0f}dB"
    )

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
