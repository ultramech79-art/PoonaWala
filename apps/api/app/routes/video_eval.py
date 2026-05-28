"""
POST /api/video-eval
Accepts base64-encoded JPEG frames captured from a 15-second video.
Sends them to Vertex AI gemini-3.5-flash for gold authenticity analysis.
Returns: video_score, verdict, video_signals, purity_estimate, guidance.
"""
import asyncio
import base64
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("goldeye.video_eval")
router = APIRouter()

MODEL_NAME = os.getenv("VIDEO_GEMINI_MODEL", "gemini-3.5-flash")
PROJECT_ID = "poonawala-497707"
LOCATION   = "global"

_client = None

def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    return _client


class _VideoAuthOut(BaseModel):
    video_score: int
    color_analysis: str
    surface_analysis: str
    edge_wear_analysis: str
    hallmark_analysis: str
    reflection_analysis: str
    consistency_across_frames: str
    red_flags: list[str]
    positive_signals: list[str]
    purity_estimate: Optional[str] = None
    guidance: str


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
        return VideoEvalResponse(video_score=0, verdict="No frames received", video_signals=[], purity_estimate=None, guidance="Please record a video.")

    try:
        _get_client()
    except Exception as e:
        logger.error(f"Vertex AI client init failed: {e}")
        return VideoEvalResponse(video_score=50, verdict="Analysis unavailable", video_signals=["Vertex AI connection failed"], purity_estimate=None, guidance="Please check Vertex AI credentials.")

    from google.genai import types

    lang_out = "Hindi (Devanagari)" if req.language == "hi" else "English"
    n_frames = min(len(req.frames_b64), 8)

    frame_parts = []
    for b64 in req.frames_b64[:n_frames]:
        try:
            frame_parts.append(types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/jpeg"))
        except Exception:
            continue

    if not frame_parts:
        return VideoEvalResponse(video_score=0, verdict="Invalid frames", video_signals=["Could not decode frames"], purity_estimate=None, guidance="Please try recording again.")

    prompt = f"""You are a gold authenticity analyst for Poonawalla Fincorp gold-loan appraisal.
You are given {len(frame_parts)} frames of the same ornament captured during a 15-second slow rotation via mobile phone camera.

IMPORTANT: Most ornaments presented for gold loans ARE genuine Indian gold jewellery (BIS hallmarked 916/750). Differentiate clearly — real gold must score HIGH (75+), imitation/plated LOW (under 35). Do NOT cluster at 40–55.

COLOUR — primary signal:
• Real 22K/916: rich deep warm yellow, uniform on all surfaces and edges.
• Real 18K/750: slightly paler yellow, still warm and consistent.
• Plated/imitation: thin or uneven colour — brassy, pale, coppery, differs at edges.

EDGE EXPOSURE — strongest single indicator:
• Real gold: ALL edges/corners same colour as the surface. No difference.
• Plated: edges/clasps/hinges show DIFFERENT colour — silver, grey, copper, or base metal.

SURFACE & LUSTER:
• Real gold: warm deep luster, amber-yellow reflections.
• Imitation: overly mirror-bright or dull/flat. Wrong reflection colour.

HALLMARK:
• Deep BIS stamp / HUID = strong positive. No hallmark = minor negative only.

SCORING:
75–100: Warm uniform colour + same-colour edges + good luster → REAL GOLD
55–74:  Mostly good, minor uncertainty → LIKELY REAL
35–54:  Genuinely mixed → UNCERTAIN
15–34:  Wrong edge colour OR thin/uneven colour → LIKELY PLATED
0–14:   Obvious non-gold colour, silver/copper edges → IMITATION

Each analysis field must be a specific observation (1–2 sentences). red_flags: only real concerns.
guidance: 1–2 sentences in {lang_out}."""

    try:
        client = _get_client()
        config = types.GenerateContentConfig(
            temperature=0.15,
            max_output_tokens=1200,
            response_mime_type="application/json",
            response_schema=_VideoAuthOut,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        )
        r = await asyncio.to_thread(
            client.models.generate_content,
            model=MODEL_NAME,
            contents=[types.Part.from_text(text=prompt)] + frame_parts,
            config=config,
        )
        vres = json.loads(r.text)
    except Exception as e:
        logger.error(f"Vertex AI video eval error: {e}")
        return VideoEvalResponse(video_score=50, verdict="Analysis failed", video_signals=[str(e)], purity_estimate=None, guidance="Video analysis could not complete.")

    v_score = max(0, min(100, int(vres.get("video_score", 50))))
    v_sigs  = []
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

    if v_score >= 70:
        verdict = "Likely solid gold" if req.language == "en" else "संभवतः असली सोना"
    elif v_score >= 50:
        verdict = "Uncertain — further verification advised" if req.language == "en" else "अनिश्चित — और जांच करें"
    else:
        verdict = "Possibly gold-plated" if req.language == "en" else "संभवतः गोल्ड-प्लेटेड"

    return VideoEvalResponse(
        video_score=v_score,
        verdict=verdict,
        video_signals=v_sigs,
        purity_estimate=vres.get("purity_estimate") or None,
        guidance=str(vres.get("guidance", "")),
    )
