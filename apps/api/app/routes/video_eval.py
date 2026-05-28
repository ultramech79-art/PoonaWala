"""
POST /api/video-eval
Accepts base64-encoded JPEG frames from a 15-second video.
Uses Gemini REST API (GEMINI_API_KEY) — no Vertex AI / service account needed.
Returns: video_score, verdict, video_signals, purity_estimate, guidance.
"""
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.data.gemini import _gemini_request

logger = logging.getLogger("goldeye.video_eval")
router = APIRouter()

MODEL = os.getenv("VIDEO_GEMINI_MODEL", "gemini-2.5-flash")


class VideoEvalRequest(BaseModel):
    frames_b64: list[str]
    language: str = "en"


class VideoEvalResponse(BaseModel):
    video_score: int
    verdict: str
    video_signals: list[str]
    purity_estimate: Optional[str]
    guidance: str


@router.post("/video-eval", response_model=VideoEvalResponse)
async def video_eval(req: VideoEvalRequest):
    if not req.frames_b64:
        return VideoEvalResponse(video_score=0, verdict="No frames received",
                                 video_signals=[], purity_estimate=None,
                                 guidance="Please record a video.")

    lang_out = "Hindi (Devanagari)" if req.language == "hi" else "English"
    n_frames = min(len(req.frames_b64), 8)

    prompt = f"""You are a gold authenticity analyst for Poonawalla Fincorp gold-loan appraisal.
You are given {n_frames} frames of the same ornament captured during a 15-second slow rotation.

IMPORTANT: Most ornaments ARE genuine Indian gold jewellery (BIS hallmarked 916/750).
Differentiate clearly — real gold scores HIGH (75+), imitation/plated scores LOW (under 35). Do NOT cluster at 40–55.

COLOUR — primary signal:
• Real 22K/916: rich deep warm yellow, uniform on all surfaces and edges.
• Real 18K/750: slightly paler yellow, still warm and consistent.
• Plated/imitation: thin or uneven colour — brassy, pale, coppery, differs at edges.

EDGE EXPOSURE — strongest single indicator:
• Real gold: ALL edges/corners same colour as surface. No difference.
• Plated: edges/clasps/hinges show DIFFERENT colour — silver, grey, copper, or base metal.

SURFACE & LUSTER:
• Real gold: warm deep luster, amber-yellow reflections.
• Imitation: overly mirror-bright or dull/flat.

SCORING:
75–100: Warm uniform colour + same-colour edges + good luster → REAL GOLD
55–74:  Mostly good, minor uncertainty → LIKELY REAL
35–54:  Genuinely mixed → UNCERTAIN
15–34:  Wrong edge colour OR thin/uneven colour → LIKELY PLATED
0–14:   Obvious non-gold, silver/copper edges clearly visible → IMITATION

Return ONLY valid JSON:
{{
  "video_score": integer 0-100,
  "color_analysis": "1-2 sentence observation",
  "surface_analysis": "1-2 sentence observation",
  "edge_wear_analysis": "1-2 sentence observation",
  "hallmark_analysis": "1-2 sentence observation",
  "red_flags": ["list", "of", "concerns"],
  "positive_signals": ["list", "of", "good", "signs"],
  "purity_estimate": "916 or 750 or null",
  "guidance": "1-2 sentences in {lang_out}"
}}"""

    # Build multipart payload: text prompt + all frames as inline images
    parts = [{"text": prompt}]
    for b64 in req.frames_b64[:n_frames]:
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": b64}})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.15,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
        },
    }

    try:
        data, success = await _gemini_request(payload, timeout=60)
        if not success:
            raise ValueError(data.get("error", "api_failed"))

        raw = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if raw.startswith("```json"): raw = raw[7:]
        if raw.startswith("```"):     raw = raw[3:]
        if raw.endswith("```"):       raw = raw[:-3]
        vres = json.loads(raw.strip())
    except Exception as e:
        logger.error(f"video_eval gemini error: {e}")
        return VideoEvalResponse(video_score=50, verdict="Analysis unavailable",
                                 video_signals=[f"Gemini error: {e}"],
                                 purity_estimate=None, guidance="Please try again.")

    v_score = max(0, min(100, int(vres.get("video_score", 50))))
    v_sigs  = []
    for field in ("color_analysis", "surface_analysis", "edge_wear_analysis", "hallmark_analysis"):
        val = str(vres.get(field, "")).strip()
        if val: v_sigs.append(val)
    red_flags = list(vres.get("red_flags", []))
    pos_sigs  = list(vres.get("positive_signals", []))
    if red_flags: v_sigs.append("⚠ " + "; ".join(red_flags))
    if pos_sigs:  v_sigs.append("✓ " + "; ".join(pos_sigs))

    if v_score >= 70:
        verdict = "Likely solid gold" if req.language == "en" else "संभवतः असली सोना"
    elif v_score >= 50:
        verdict = "Uncertain — further verification advised" if req.language == "en" else "अनिश्चित"
    else:
        verdict = "Possibly gold-plated" if req.language == "en" else "संभवतः गोल्ड-प्लेटेड"

    return VideoEvalResponse(
        video_score=v_score,
        verdict=verdict,
        video_signals=v_sigs,
        purity_estimate=vres.get("purity_estimate") or None,
        guidance=str(vres.get("guidance", "")),
    )
