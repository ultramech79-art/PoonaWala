"""
POST /api/video-eval
Multiple frames from 15-second rotation → Gemini 2.5-flash multi-frame analysis.
Gemini evaluates weighted signals across ALL frames simultaneously:
  - Edge color consistency  (35%) — strongest single indicator
  - Surface hue uniformity  (30%) — warm uniform yellow = real
  - Luster quality          (20%) — warm amber vs chrome/flat
  - Temporal consistency    (10%) — colour must not shift across frames
  - Hallmark presence       (5%)  — depth/quality of BIS stamp
Each signal is scored independently, then weighted into a final 0-100.
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
    edge_score: int
    hue_score: int
    luster_score: int
    consistency_score: int
    hallmark_score: int
    video_signals: list[str]
    purity_estimate: Optional[str]
    guidance: str


@router.post("/video-eval", response_model=VideoEvalResponse)
async def video_eval(req: VideoEvalRequest):
    if not req.frames_b64:
        return _error_response("No frames received", req.language)

    n_frames  = min(len(req.frames_b64), 10)
    lang_out  = "Hindi (Devanagari)" if req.language == "hi" else "English"

    prompt = f"""You are a gold authentication expert for Poonawalla Fincorp gold-loan appraisal.
You are given {n_frames} frames from a 15-second slow rotation of a gold ornament.
Analyse ALL frames together. Each signal must be scored 0-100 independently — do NOT average them.

━━━ SIGNAL 1: EDGE COLOR CONSISTENCY (weight 35%) ━━━
Score 0-100 based on: do ALL visible edges, corners, clasps, and hinges match the surface colour?
• 90-100: Every edge is identical warm yellow as the surface — classic solid gold
• 70-89:  Edges mostly match, minor variation at one clasp or corner
• 50-69:  Noticeable colour difference at some edges, uncertain
• 20-49:  Clear colour difference — grey, silver, or copper showing at edges
• 0-19:   Obvious base metal exposed at edges — definitely plated

━━━ SIGNAL 2: HUE UNIFORMITY (weight 30%) ━━━
Score 0-100 based on: is the gold colour warm, deep, and consistent across all surfaces?
• 90-100: Rich deep warm yellow (22K: #D4A017 range), completely uniform
• 70-89:  Warm yellow, slight variation in lighting areas
• 50-69:  Pale or uneven yellow, may be 14K or uncertain
• 20-49:  Thin, brassy, or coppery tone — surface plating characteristics
• 0-19:   Obviously wrong colour — silver-toned, bright chrome, or clearly artificial

━━━ SIGNAL 3: LUSTER QUALITY (weight 20%) ━━━
Score 0-100 based on: what is the reflection character?
• 90-100: Warm amber-toned luster, soft glow, depth — solid gold characteristic
• 70-89:  Good warm luster with minor bright spots
• 50-69:  Mixed — some warm areas, some overly bright
• 20-49:  Overly mirror-bright (chrome-like) or completely flat/dull
• 0-19:   Clearly wrong — metallic shimmer or plastic-like sheen

━━━ SIGNAL 4: TEMPORAL CONSISTENCY (weight 10%) ━━━
Score 0-100 based on: does the colour remain stable as the ornament rotates across all frames?
• 90-100: Colour is completely stable — no hue shift between frames
• 70-89:  Stable with minor lighting-induced variation
• 40-69:  Noticeable colour shift between frames — suspicious
• 0-39:   Strong colour shift across frames — suggests thin plating or coating

━━━ SIGNAL 5: HALLMARK PRESENCE (weight 5%) ━━━
Score 0-100 based on: any BIS hallmark, HUID, or purity stamp visible?
• 90-100: Clear deep BIS stamp with purity digits (916/750/999) visible
• 60-89:  Partial or slightly blurred hallmark visible
• 20-59:  No hallmark visible but surface looks correct for stamping
• 0-19:   No hallmark AND surface shows signs of covering marks

━━━ PURITY ESTIMATE ━━━
If any hallmark digits are visible, report the purity code (999/916/875/750/585).
Otherwise report null.

━━━ SCORING RULES ━━━
• Commit to clear scores — do NOT cluster at 50.
• If edge colour is wrong (score <40), cap video_score at 45 regardless of other signals.
• If hue is obviously wrong (score <30), cap video_score at 35.
• video_score = round(edge*0.35 + hue*0.30 + luster*0.20 + consistency*0.10 + hallmark*0.05)
• Most ornaments presented for gold loans ARE real 22K/18K gold — score accordingly.

Return ONLY valid JSON:
{{
  "edge_score": integer 0-100,
  "hue_score": integer 0-100,
  "luster_score": integer 0-100,
  "consistency_score": integer 0-100,
  "hallmark_score": integer 0-100,
  "video_score": integer 0-100,
  "edge_observation": "specific 1-sentence observation about edges across frames",
  "hue_observation": "specific 1-sentence observation about colour",
  "luster_observation": "specific 1-sentence observation about reflections",
  "consistency_observation": "specific 1-sentence on colour stability across frames",
  "red_flags": ["list only real concerns, empty if none"],
  "positive_signals": ["list confirmed positive evidence"],
  "purity_estimate": "916 or 750 or 999 or null",
  "guidance": "1-2 sentences in {lang_out}"
}}"""

    parts = [{"text": prompt}]
    for b64 in req.frames_b64[:n_frames]:
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": b64}})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.10,
            "maxOutputTokens": 1000,
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
        res = json.loads(raw.strip())
    except Exception as e:
        logger.error(f"video_eval gemini error: {e}")
        return _error_response(f"Analysis error: {e}", req.language)

    # Extract per-signal scores
    edge_score        = _clamp(res.get("edge_score", 50))
    hue_score         = _clamp(res.get("hue_score", 50))
    luster_score      = _clamp(res.get("luster_score", 50))
    consistency_score = _clamp(res.get("consistency_score", 50))
    hallmark_score    = _clamp(res.get("hallmark_score", 50))

    # Recompute weighted score server-side (don't trust Gemini's arithmetic)
    weighted = (
        edge_score        * 0.35 +
        hue_score         * 0.30 +
        luster_score      * 0.20 +
        consistency_score * 0.10 +
        hallmark_score    * 0.05
    )
    # Apply caps: bad edges or bad hue are hard disqualifiers
    if edge_score < 40:
        weighted = min(weighted, 45)
    if hue_score < 30:
        weighted = min(weighted, 35)

    video_score = max(0, min(100, round(weighted)))

    # Build signal list from specific observations
    signals = []
    for field in ("edge_observation", "hue_observation", "luster_observation", "consistency_observation"):
        val = str(res.get(field, "")).strip()
        if val:
            signals.append(val)
    red_flags = list(res.get("red_flags", []))
    pos_sigs  = list(res.get("positive_signals", []))
    if red_flags:
        signals.append("⚠ " + "; ".join(red_flags))
    if pos_sigs:
        signals.append("✓ " + "; ".join(pos_sigs))

    if video_score >= 70:
        verdict = "Likely solid gold" if req.language == "en" else "संभवतः असली सोना"
    elif video_score >= 50:
        verdict = "Uncertain — further verification advised" if req.language == "en" else "अनिश्चित"
    else:
        verdict = "Possibly gold-plated" if req.language == "en" else "संभवतः गोल्ड-प्लेटेड"

    logger.info(
        f"video_eval score={video_score} edge={edge_score} hue={hue_score} "
        f"luster={luster_score} consistency={consistency_score} hallmark={hallmark_score}"
    )

    return VideoEvalResponse(
        video_score=video_score,
        verdict=verdict,
        edge_score=edge_score,
        hue_score=hue_score,
        luster_score=luster_score,
        consistency_score=consistency_score,
        hallmark_score=hallmark_score,
        video_signals=signals,
        purity_estimate=res.get("purity_estimate") or None,
        guidance=str(res.get("guidance", "")),
    )


def _clamp(v) -> int:
    try:
        return max(0, min(100, int(v)))
    except (TypeError, ValueError):
        return 50


def _error_response(msg: str, lang: str) -> VideoEvalResponse:
    return VideoEvalResponse(
        video_score=0, verdict="Analysis unavailable",
        edge_score=0, hue_score=0, luster_score=0,
        consistency_score=0, hallmark_score=0,
        video_signals=[msg], purity_estimate=None,
        guidance="Please try again." if lang == "en" else "कृपया पुनः प्रयास करें।",
    )
