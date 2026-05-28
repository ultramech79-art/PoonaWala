"""
POST /api/live-session/analyze     — live frame analysis via Gemini 3.5 Flash
POST /api/live-session/tap-test    — audio tap analysis: Gemini native audio + algorithmic blend
POST /api/live-session/auth-check  — final authenticity: video frames + audio combined
"""
import base64 as b64lib
import asyncio
import io
import json
import logging
import math
import os
import struct
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("goldeye.live_session")
router = APIRouter()

PROJECT_ID          = "poonawala-497707"
LOCATION            = "global"
MODEL_NAME          = os.getenv("LIVE_GEMINI_MODEL", "gemini-3.5-flash")
AUTH_MODEL_NAME     = os.getenv("AUTH_GEMINI_MODEL", "gemini-3.5-flash")
AUTH_AUDIO_SECONDS  = 7

_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
        logger.info(f"google-genai client — project={PROJECT_ID} model={MODEL_NAME}")
    return _client


async def _gemini_json(parts: list, schema: type, max_tokens: int = 200) -> dict:
    """Fast Gemini call — Flash model, thinking disabled, for live frame analysis."""
    from google.genai import types
    client = _get_client()
    config = types.GenerateContentConfig(
        temperature=0.1,
        max_output_tokens=max_tokens,
        response_mime_type="application/json",
        response_schema=schema,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )
    r = await asyncio.to_thread(
        client.models.generate_content,
        model=MODEL_NAME,
        contents=parts,
        config=config,
    )
    return json.loads(r.text)


async def _gemini_json_deep(parts: list, schema: type, max_tokens: int = 700) -> dict:
    """Auth-check call — Flash model, thinking disabled, detailed structured prompt."""
    from google.genai import types
    client = _get_client()
    config = types.GenerateContentConfig(
        temperature=0.15,
        max_output_tokens=max_tokens,
        response_mime_type="application/json",
        response_schema=schema,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )
    r = await asyncio.to_thread(
        client.models.generate_content,
        model=AUTH_MODEL_NAME,
        contents=parts,
        config=config,
    )
    return json.loads(r.text)


def _float32_to_wav(samples: list[float], sample_rate: int) -> bytes:
    """Wrap raw float32 PCM samples into a valid WAV file."""
    n    = len(samples)
    data = struct.pack(f"<{n}f", *samples)
    buf  = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(data)))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 3))           # IEEE 754 float
    buf.write(struct.pack("<H", 1))           # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 4))
    buf.write(struct.pack("<H", 4))
    buf.write(struct.pack("<H", 32))
    buf.write(b"data")
    buf.write(struct.pack("<I", len(data)))
    buf.write(data)
    return buf.getvalue()


ANGLES_ORDER = ["top", "45deg", "side", "macro", "selfie"]

ANGLE_LABELS = {
    "top":    "overhead / top-down",
    "45deg":  "angled / 45-degree",
    "side":   "side / edge profile",
    "macro":  "close-up hallmark or purity stamp",
    "selfie": "selfie — customer holding the ornament",
}

NEXT_INSTRUCTION = {
    "en": {
        "top":    "Top shot saved! Now tilt to a 45-degree angle.",
        "45deg":  "Great! Now show the side edge.",
        "side":   "Side done! Get close to the hallmark or purity stamp.",
        "macro":  "Hallmark captured! Now take a selfie holding the gold.",
        "selfie": "All shots done! Running final authenticity check.",
    },
    "hi": {
        "top":    "टॉप शॉट सेव! अब 45 डिग्री पर झुकाएं।",
        "45deg":  "शानदार! अब किनारे से दिखाएं।",
        "side":   "साइड हो गया! हॉलमार्क के पास जाएं।",
        "macro":  "हॉलमार्क हो गया! अब सेल्फी लें।",
        "selfie": "सभी शॉट हो गए! असलियत जांच हो रही है।",
    },
}

PURITY_LABELS = {
    "999": "999 — 24K Pure Gold", "916": "916 — 22K Gold",
    "875": "875 — 21K Gold",      "750": "750 — 18K Gold",
    "708": "708 — 17K Gold",      "585": "585 — 14K Gold",
    "417": "417 — 10K Gold",      "375": "375 — 9K Gold",
}


# ── Pydantic schemas for structured output ─────────────────────────────────────

class _AnalyzeOut(BaseModel):
    approved: bool
    quality_score: float
    jewellery_visible: bool
    angle_ok: bool
    hallmark_visible: bool = False
    face_visible: bool = False
    detected_view: str = "unknown"
    observed_item: str
    guidance: str
    purity_hint: Optional[str] = None
    purity_confidence: float = 0.0


class _TapAudioOut(BaseModel):
    score: int                 # 0–100 solid gold likelihood
    decay_ms: float
    dominant_freq_hz: float
    label: str
    reasoning: str


class _VideoAuthOut(BaseModel):
    video_score: int                    # 0–100 solid gold confidence
    color_analysis: str                 # detailed colour/tone observation
    surface_analysis: str               # luster, finish, micro-texture
    edge_wear_analysis: str             # edge/corner/clasp wear findings
    hallmark_analysis: str              # hallmark depth, BIS mark, HUID quality
    reflection_analysis: str            # reflection pattern and warmth
    consistency_across_frames: str      # how the ornament looks across all frames
    red_flags: list[str]                # specific suspicious observations (empty if none)
    positive_signals: list[str]         # specific authentic-gold observations
    purity_estimate: Optional[str] = None
    guidance: str


# ── FastAPI models ─────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    frame_b64: str
    current_angle: str
    captured_angles: list[str] = []
    language: str = "en"

class AnalyzeResponse(BaseModel):
    approved: bool
    quality_score: float
    jewellery_visible: bool
    angle_ok: bool
    hallmark_visible: bool = False
    face_visible: bool = False
    observed_item: str
    guidance: str
    next_angle: Optional[str] = None
    purity_hint: Optional[str] = None
    purity_confidence: float = 0.0
    next_instruction: Optional[str] = None

class TapTestRequest(BaseModel):
    samples_b64: str
    sample_rate: int = 44100
    language: str = "en"

class TapTestResponse(BaseModel):
    score: int
    label: str
    decay_ms: float
    dominant_freq_hz: float
    reasoning: str

class AuthCheckRequest(BaseModel):
    frames_b64: list[str]
    audio_samples_b64: Optional[str] = None
    sample_rate: int = 44100
    language: str = "en"

class AuthCheckResponse(BaseModel):
    video_score: int
    audio_score: int
    combined_score: int
    verdict: str
    video_signals: list[str]
    audio_signals: list[str]
    purity_estimate: Optional[str]
    guidance: str


# ── /analyze ──────────────────────────────────────────────────────────────────

@router.post("/live-session/analyze", response_model=AnalyzeResponse)
async def analyze_frame(req: AnalyzeRequest):
    if req.current_angle not in ANGLES_ORDER:
        raise HTTPException(400, f"Unknown angle: {req.current_angle!r}")

    try: _get_client()
    except Exception as e:
        raise HTTPException(503, f"Vertex AI unavailable: {e}")

    lang        = req.language if req.language in ("en", "hi") else "en"
    is_macro    = req.current_angle == "macro"
    angle_label = ANGLE_LABELS[req.current_angle]
    done_str    = ", ".join(req.captured_angles) if req.captured_angles else "none yet"

    lang_rule = (
        "guidance field in Hindi (Devanagari), max 12 words."
        if lang == "hi" else
        "guidance field in friendly Indian English, max 12 words."
    )

    purity_instr = (
        "Also scan for any purity/karat stamp (999, 916, 750, 585, 375, 22K, 18K…). "
        "Set purity_hint to the digits found (e.g. '916') or null. "
        "Set purity_confidence 0.0–1.0."
    ) if is_macro else ""

    angle_rule = {
        "top": (
            "For top shot: angle_ok=true when the camera is roughly above the ornament showing the top surface. "
            "Allow hand-held overhead shots. Reject only obvious non-top views like pure selfies or side-on edges."
        ),
        "45deg": (
            "For 45-degree shot: angle_ok=true when the camera shows the ornament from a tilted angle (roughly 20-70 degrees) "
            "so both top and some depth/thickness are visible. Allow a range of tilt angles."
        ),
        "side": (
            "For side shot: angle_ok=true when the edge or thickness of the ornament is the main visible feature. "
            "If only the top surface dominates, set angle_ok=false and guide to lower the phone to show the edge."
        ),
        "macro": (
            "For macro shot: hallmark_visible=true when any engraved/stamped hallmark, HUID, BIS logo, karat/purity digits, "
            "or marking is visible. angle_ok=true for any close-up of the jewellery surface. "
            "If no hallmark is visible, still set angle_ok=true so the user can manually enter purity."
        ),
        "selfie": (
            "For selfie: face_visible=true when a customer face is visible. angle_ok=true when both face "
            "and ornament are roughly in frame. If only one is visible, guide to include the other."
        ),
    }[req.current_angle]

    prompt = (
        f"GoldEye gold-loan appraisal AI.\n"
        f"Shot type: {angle_label}. Shots already done: {done_str}.\n"
        f"Customer may hold the ornament by hand — that is fine.\n"
        "First identify what is visible in the frame.\n"
        "jewellery_visible=true if any ornament-like gold/yellow metal item is visible "
        "(ring, chain, bangle, bracelet, pendant, earring, coin/bar). If unsure whether it is real gold, still set true when an ornament is visible.\n"
        "jewellery_visible=false only when no ornament-like item is visible.\n"
        "detected_view must be exactly one of: top, 45deg, side, macro, selfie, none, other. "
        "Use top only for overhead/full top surface; 45deg only for clear tilted top+depth; side only for edge/profile thickness.\n"
        "observed_item: 2-5 plain words naming what you actually see, e.g. 'gold bangle', 'chain in hand', 'empty table', 'customer face only'.\n"
        "Return angle_ok, hallmark_visible, and face_visible as separate booleans.\n"
        f"{angle_rule}\n"
        "The requested shot type should roughly match — small variations in angle are acceptable. "
        "If detected_view is clearly wrong (e.g. selfie when top was requested), set angle_ok=false.\n"
        "guidance rule: If jewellery_visible=true, do NOT say 'show jewellery'. Start with what you see, then give one correction, "
        "e.g. 'I see a gold ring; hold steady closer.' If jewellery_visible=false, say what you see and ask for jewellery, "
        "e.g. 'I see a table; bring jewellery into frame.'\n"
        f"quality_score: confidence this frame is useful for the requested {angle_label} shot (0.0-1.0). "
        "Give 0.70+ only when the requested angle is exact. Give 0.45-0.60 when jewellery is visible but the angle is merely close. "
        "Give below 0.40 when the wrong angle is shown.\n"
        "approved=true only when all required booleans for this shot are true and quality_score is high enough.\n"
        f"{purity_instr}\n"
        f"{lang_rule}"
    )

    try:
        from google.genai import types
        image_bytes = b64lib.b64decode(req.frame_b64)
        result = await _gemini_json(
            [types.Part.from_text(text=prompt),
             types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
            schema=_AnalyzeOut,
            max_tokens=160,
        )
        logger.info(f"analyze [{req.current_angle}]: {result}")
    except Exception as e:
        logger.error(f"Gemini error: {e}")
        fb = "Hold steady, make sure ornament is visible." if lang == "en" else "स्थिर रहें, गहना दिखाएं।"
        return AnalyzeResponse(
            approved=False,
            quality_score=0.3,
            jewellery_visible=False,
            angle_ok=False,
            hallmark_visible=False,
            face_visible=False,
            observed_item="unknown",
            guidance=fb,
        )

    jewellery_visible = bool(result.get("jewellery_visible", False))
    angle_ok = bool(result.get("angle_ok", False))
    hallmark_visible = bool(result.get("hallmark_visible", False))
    face_visible = bool(result.get("face_visible", False))
    quality_score = float(result.get("quality_score", 0))

    # Trust angle_ok directly — it already encodes whether the shot matches.
    approved = False
    if req.current_angle == "macro":
        approved = jewellery_visible and angle_ok and hallmark_visible and quality_score >= 0.52
    elif req.current_angle == "selfie":
        approved = jewellery_visible and face_visible and angle_ok and quality_score >= 0.52
    else:
        approved = jewellery_visible and angle_ok and quality_score >= 0.55

    if not approved:
        if req.current_angle == "side" and jewellery_visible and (not angle_ok):
            result["guidance"] = (
                "I see jewellery; lower phone to table height and show the edge."
                if lang == "en" else
                "गहना दिख रहा है; फोन नीचे करके किनारा दिखाएं।"
            )
        elif req.current_angle == "45deg" and jewellery_visible and (not angle_ok):
            result["guidance"] = (
                "I see jewellery; tilt phone halfway to show depth."
                if lang == "en" else
                "गहना दिख रहा है; गहराई दिखाने के लिए फोन झुकाएं।"
            )
        elif req.current_angle == "top" and jewellery_visible and (not angle_ok):
            result["guidance"] = (
                "I see jewellery; move directly above for a top view."
                if lang == "en" else
                "गहना दिख रहा है; ऊपर से सीधा दिखाएं।"
            )
        elif req.current_angle == "macro" and jewellery_visible and not hallmark_visible:
            result["guidance"] = (
                "I see jewellery; zoom closer until hallmark or purity mark is readable."
                if lang == "en" else
                "गहना दिख रहा है; हॉलमार्क पढ़ने तक ज़ूम करें।"
            )
        elif req.current_angle == "selfie" and jewellery_visible and not face_visible:
            result["guidance"] = (
                "I see jewellery; include your face in the selfie frame."
                if lang == "en" else
                "गहना दिख रहा है; सेल्फी में चेहरा भी लाएं।"
            )
        elif req.current_angle == "selfie" and face_visible and not jewellery_visible:
            result["guidance"] = (
                "I see your face; hold the same jewellery beside it."
                if lang == "en" else
                "चेहरा दिख रहा है; वही गहना साथ में पकड़ें।"
            )

    next_angle = next_instruction = None
    if approved:
        captured_set = set(req.captured_angles) | {req.current_angle}
        remaining    = [a for a in ANGLES_ORDER if a not in captured_set]
        next_angle   = remaining[0] if remaining else None
        next_instruction = NEXT_INSTRUCTION[lang].get(req.current_angle)

    return AnalyzeResponse(
        approved=approved,
        quality_score=quality_score,
        jewellery_visible=jewellery_visible,
        angle_ok=angle_ok,
        hallmark_visible=hallmark_visible,
        face_visible=face_visible,
        observed_item=str(result.get("observed_item") or "unknown")[:80],
        guidance=str(result.get("guidance", "")),
        next_angle=next_angle,
        next_instruction=next_instruction,
        purity_hint=str(result["purity_hint"]) if result.get("purity_hint") else None,
        purity_confidence=float(result.get("purity_confidence", 0.0)),
    )


# ── Algorithmic audio analysis (fast fallback / blend) ────────────────────────
#
# SOLID GOLD (18K–24K, 15–18 g/cm³): damped, warm ring — decay 80–350ms, centroid 200–700Hz
# GOLD-PLATED BRASS (8.5 g/cm³):     bright, longer ring — decay 350–900ms, centroid 600–2500Hz
# GOLD-PLATED SILVER:                 very clear, >1s ring, centroid 1000–4000Hz

def _analyze_audio_algorithmic(samples: list[float], sample_rate: int) -> dict:
    abs_s = [abs(x) for x in samples]
    peak  = max(abs_s)
    if peak < 0.003:
        return {"score": 0, "decay_ms": 0.0, "dom_freq": 0.0, "reasons": ["Signal too quiet — tap ornament firmly."]}

    peak_i = abs_s.index(peak)
    decay_thresh = peak * 0.12
    decay_i = len(abs_s) - 1
    for i in range(peak_i, len(abs_s)):
        if abs_s[i] < decay_thresh:
            decay_i = i; break
    decay_ms = (decay_i - peak_i) / sample_rate * 1000

    fft_n = min(1024, len(samples) - peak_i)
    centroid = dom_freq = 0.0
    if fft_n >= 64:
        seg  = samples[peak_i:peak_i + fft_n]
        hann = [0.5*(1-math.cos(2*math.pi*i/(fft_n-1))) for i in range(fft_n)]
        wseg = [seg[i]*hann[i] for i in range(fft_n)]
        mags, half = [], fft_n // 2
        for k in range(half):
            re = sum(wseg[t]*math.cos(2*math.pi*k*t/fft_n) for t in range(fft_n))
            im = sum(wseg[t]*math.sin(2*math.pi*k*t/fft_n) for t in range(fft_n))
            mags.append(math.sqrt(re*re + im*im))
        freq_res = sample_rate / fft_n
        tot_mag  = sum(mags) or 1
        centroid = sum(i*freq_res*mags[i] for i in range(len(mags))) / tot_mag
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
        score -= 12; reasons.append(f"Bright/tinny {centroid:.0f}Hz")

    post = abs_s[peak_i:decay_i+1]
    if len(post) > 4:
        falling = sum(1 for i in range(len(post)-1) if post[i+1] <= post[i]*1.05)
        if falling / (len(post)-1) > 0.72:
            score += 4; reasons.append("Clean decay envelope")

    return {"score": max(5, min(95, score)), "decay_ms": decay_ms, "dom_freq": dom_freq, "reasons": reasons}


# ── /tap-test ─────────────────────────────────────────────────────────────────

@router.post("/live-session/tap-test", response_model=TapTestResponse)
async def tap_test(req: TapTestRequest):
    try:
        raw_b = b64lib.b64decode(req.samples_b64)
        n     = len(raw_b) // 4
        samps = list(struct.unpack(f"<{n}f", raw_b[:n*4]))
        logger.info(f"tap-test: {n} samples @ {req.sample_rate}Hz")
    except Exception as e:
        raise HTTPException(400, str(e))

    lang = req.language if req.language in ("en", "hi") else "en"

    # Algorithmic analysis — fast, always runs
    algo = _analyze_audio_algorithmic(samps, req.sample_rate)

    if algo["score"] == 0:
        return TapTestResponse(
            score=0, label="No tap detected",
            decay_ms=0.0, dominant_freq_hz=0.0,
            reasoning="Signal too quiet — tap ornament firmly on a hard surface.",
        )

    # Gemini native audio analysis — runs in parallel conceptually; await here
    gemini_score = None
    gemini_reasoning = ""
    try:
        from google.genai import types
        wav = _float32_to_wav(samps, req.sample_rate)
        audio_prompt = (
            "You are an expert metallurgical acoustics analyst for gold-loan appraisal.\n"
            "Listen carefully to this recording of a metal ornament being tapped.\n\n"
            "Key acoustic signatures:\n"
            "- SOLID GOLD (18K–24K): Dense (15–18 g/cm³), soft metal. Produces a warm, damped ring. "
            "Decay 80–350ms. Spectral centroid 200–700Hz. Clean exponential envelope.\n"
            "- GOLD-PLATED BRASS: Lighter, rings brighter and LONGER. Decay 350–900ms. Centroid 600–2500Hz. Tinny overtones.\n"
            "- GOLD-PLATED SILVER: Very clear, long ring >1s. High centroid 1000–4000Hz.\n\n"
            "Based on what you hear, score 0–100 for likelihood this is SOLID gold (100 = definitely solid, 0 = definitely plated).\n"
            f"{'guidance field in Hindi (Devanagari).' if lang == 'hi' else 'reasoning field in English.'}"
        )
        g_result = await _gemini_json(
            [types.Part.from_text(text=audio_prompt),
             types.Part.from_bytes(data=wav, mime_type="audio/wav")],
            schema=_TapAudioOut,
            max_tokens=200,
        )
        gemini_score    = int(max(0, min(100, g_result.get("score", 50))))
        gemini_reasoning = str(g_result.get("reasoning", ""))
        logger.info(f"tap-test gemini: score={gemini_score} {g_result.get('label','')}")
    except Exception as e:
        logger.warning(f"Gemini audio analysis skipped: {e}")

    # Blend: 60% Gemini (richer signal) + 40% algorithmic — fallback to algo only
    if gemini_score is not None:
        final_score = round(gemini_score * 0.60 + algo["score"] * 0.40)
        reasoning   = gemini_reasoning or " | ".join(algo["reasons"])
    else:
        final_score = algo["score"]
        reasoning   = " | ".join(algo["reasons"])

    final_score = max(5, min(95, final_score))
    label = ("Likely solid gold" if final_score >= 70
             else "Uncertain — may be plated" if final_score >= 50
             else "Possibly gold-plated")

    return TapTestResponse(
        score=final_score, label=label,
        decay_ms=round(algo["decay_ms"], 1),
        dominant_freq_hz=round(algo["dom_freq"], 1),
        reasoning=reasoning,
    )


# ── /auth-check ────────────────────────────────────────────────────────────────

@router.post("/live-session/auth-check", response_model=AuthCheckResponse)
async def auth_check(req: AuthCheckRequest):
    if not req.frames_b64:
        raise HTTPException(400, "At least one frame required")

    try: _get_client()
    except Exception as e:
        raise HTTPException(503, f"Vertex AI unavailable: {e}")

    lang = req.language if req.language in ("en", "hi") else "en"

    from google.genai import types

    n_frames    = min(len(req.frames_b64), 6)
    frame_parts = [
        types.Part.from_bytes(data=b64lib.b64decode(b), mime_type="image/jpeg")
        for b in req.frames_b64[:n_frames]
    ]

    lang_out = "Hindi (Devanagari)" if lang == "hi" else "English"

    video_prompt = f"""You are a gold authenticity analyst for Poonawalla Fincorp gold-loan appraisal.
You are given {n_frames} frames of the same ornament captured during an 8-second slow rotation via mobile phone camera.

IMPORTANT CONTEXT: Most ornaments presented for gold loans ARE genuine Indian gold jewellery (BIS hallmarked 916/750). Your job is to DIFFERENTIATE — real gold must score HIGH (75+), imitation/plated must score LOW (under 35). Do NOT give everything a score of 40–55. Commit to a clear assessment.

COLOUR — the primary signal:
• Real 22K/916: rich, deep warm yellow, uniform on all surfaces.
• Real 18K/750: slightly paler yellow, still warm and consistent.
• Plated/imitation: thin or uneven colour — brassy, pale, or coppery, often different on edges vs surface.
• Costume jewellery: noticeably lighter, whitish, or obviously non-gold colour.

EDGE EXPOSURE — the strongest single indicator:
• Real gold: ALL edges/corners are the same gold colour as the surface. No colour difference.
• Plated: edges/clasps/hinges show a DIFFERENT colour — silver, grey, copper, or base metal.
• Even 1–2 small exposed non-gold patches at edges = plated. Check every edge in every frame.

SURFACE & LUSTER:
• Real gold: warm deep luster, slightly matte to glossy. Amber-yellow reflections.
• Imitation: overly mirror-bright (chrome-like) or dull/flat surface. Wrong reflection colour.

HALLMARK:
• Deep BIS stamp / HUID present = strong positive. No hallmark = minor negative only.

SCORING — DO NOT default to the middle:
75–100: Warm uniform colour + same-colour edges + good luster = REAL GOLD → score 75–90+
55–74:  Mostly good but minor uncertainty (no hallmark, slight colour variation) = LIKELY REAL
35–54:  Genuinely mixed — cannot determine clearly = UNCERTAIN
15–34:  Wrong edge colour OR thin/uneven colour OR wrong luster = LIKELY PLATED
0–14:   Obvious non-gold colour, silver/copper edges clearly visible = IMITATION

OUTPUT: Each analysis field must be a specific observation about THIS ornament (1–2 sentences).
red_flags: only real concerns, not generic maybes. Leave [] if none.
guidance: 1–2 sentences in {lang_out}."""

    try:
        vres    = await _gemini_json_deep(
            [types.Part.from_text(text=video_prompt)] + frame_parts,
            schema=_VideoAuthOut,
            max_tokens=1200,
        )
        v_score = int(max(0, min(100, vres.get("video_score", 50))))
        # Combine all analysis fields into the signals list for frontend display
        v_sigs = []
        for field in ("color_analysis", "surface_analysis", "edge_wear_analysis",
                      "hallmark_analysis", "reflection_analysis", "consistency_across_frames"):
            val = str(vres.get(field, "")).strip()
            if val:
                v_sigs.append(val)
        red_flags = list(vres.get("red_flags", []))
        pos_sigs  = list(vres.get("positive_signals", []))
        if red_flags:
            v_sigs.append("⚠ Red flags: " + "; ".join(red_flags))
        if pos_sigs:
            v_sigs.append("✓ Positive: " + "; ".join(pos_sigs))
        purity  = vres.get("purity_estimate") or None
        v_guide = str(vres.get("guidance", ""))
        logger.info(f"auth-check video: score={v_score} red_flags={red_flags} pos={pos_sigs}")
    except Exception as e:
        logger.error(f"video auth error: {e}")
        v_score = 50; v_sigs = []; purity = None; v_guide = ""

    # Audio analysis — Gemini native if provided
    a_score = 0
    a_sigs  = []
    if req.audio_samples_b64:
        try:
            raw_b   = b64lib.b64decode(req.audio_samples_b64)
            n       = len(raw_b) // 4
            samps   = list(struct.unpack(f"<{n}f", raw_b[:n*4]))
            wav     = _float32_to_wav(samps, req.sample_rate)
            audio_prompt = (
                f"You are an expert metallurgical acoustics analyst.\n"
                f"Listen carefully to this {AUTH_AUDIO_SECONDS}-second recording of a gold ornament being repeatedly tapped.\n\n"
                "Analyse the full recording and extract:\n"
                "• Decay time: how long does each ring last before fading? (80–350ms = gold-like; >400ms = plated-like)\n"
                "• Dominant frequency and spectral character: warm/low (200–700Hz) = gold; bright/tinny (>700Hz) = plated\n"
                "• Consistency: do multiple taps sound similar? Inconsistency may indicate plating over hollow core.\n"
                "• Envelope shape: real gold has a clean exponential decay; plated metals often have a multi-modal ring.\n\n"
                "Real solid gold (18K–24K): dense, damped, warm ring — short clean decay, low centroid.\n"
                "Gold-plated brass: brighter, longer ring, tinny overtones.\n"
                "Gold-plated silver: very clear, sustained ring >1s, high centroid.\n\n"
                f"Score 0–100 for solid gold likelihood. reasoning in {lang_out}."
            )
            a_res   = await _gemini_json_deep(
                [types.Part.from_text(text=audio_prompt),
                 types.Part.from_bytes(data=wav, mime_type="audio/wav")],
                schema=_TapAudioOut,
                max_tokens=400,
            )
            a_score = int(max(0, min(100, a_res.get("score", 50))))
            a_sigs  = [str(a_res.get("reasoning", ""))]
            logger.info(f"auth-check audio: score={a_score}")
        except Exception as e:
            logger.warning(f"audio analysis error: {e}")
            # Fall back to algorithmic
            try:
                raw_b = b64lib.b64decode(req.audio_samples_b64)
                n     = len(raw_b) // 4
                samps = list(struct.unpack(f"<{n}f", raw_b[:n*4]))
                algo  = _analyze_audio_algorithmic(samps, req.sample_rate)
                a_score = algo["score"]
                a_sigs  = algo["reasons"]
            except Exception: pass

    combined = round(v_score * 0.60 + a_score * 0.40) if a_score > 0 else v_score

    if combined >= 70:
        verdict = "Likely solid gold" if lang == "en" else "संभवतः असली सोना"
    elif combined >= 50:
        verdict = "Uncertain — further verification advised" if lang == "en" else "अनिश्चित — और जांच सुझाई जाती है"
    else:
        verdict = "Possibly gold-plated" if lang == "en" else "संभवतः गोल्ड-प्लेटेड"

    guidance = v_guide or (
        f"Authenticity score: {combined}/100 — {verdict}." if lang == "en"
        else f"असलियत स्कोर: {combined}/100 — {verdict}।"
    )

    return AuthCheckResponse(
        video_score=v_score,
        audio_score=a_score,
        combined_score=combined,
        verdict=verdict,
        video_signals=v_sigs,
        audio_signals=a_sigs,
        purity_estimate=purity,
        guidance=guidance,
    )
