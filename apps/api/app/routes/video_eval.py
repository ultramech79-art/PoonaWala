"""
POST /api/video-eval
Multiple frames from 15-second rotation → multi-signal gold authenticity analysis.

RESEARCH BASIS (validated visual parameters for phone-camera gold authentication):

WEAR AND TEAR INDICATORS (strongest visual signals):
  Real gold: uniform wear throughout — same colour visible everywhere including worn areas
  Plated: contrasting metal exposed at high-contact points (clasps, hinges, bends, inner bands)
  Plating wears off first at: edges, clasps, hinges, ring inner bands, bracelet links

EDGE SUBSTRATE EXPOSURE (most reliable single indicator):
  Real gold: ALL edges, corners, clasps same warm yellow as body — no exceptions
  Plated: grey/copper/silver substrate shows through at any edge or contact point
  Even one patch of exposed substrate = plated

COLOUR SCIENCE (spectroscopy research):
  22K gold (916): hue 46-52° in HSL, warm orange-yellow, slightly reddish undertone
  18K gold (750): hue 48-54°, slightly paler, still warm
  Brass substrate: hue 55°+ (greener undertone), visibly different yellow
  Plated surfaces at wear points: brassy green-yellow or copper/grey showing

LUSTER / REFLECTION (optical research US patent 4278353):
  Real gold: lower reflectance in 450-500nm (blue) → warm amber appearance
             soft glow, NOT mirror-bright, "luxurious warmth" quality
  Plated brass: higher reflectance across all wavelengths, chrome-like brightness
  Gold-plated silver: very bright, cold reflection, almost white

SURFACE ORIGINALITY:
  Real gold: minimal porosity, consistent fine granular texture, smooth seams/solder joints
  Plated: visible micro-porosity at contact areas (dark spots/pitting), uneven solder near seams
  Authenticity: no flaking, no peeling, consistent hallmark depth

SIGNAL WEIGHTS (based on research reliability):
  Wear at contact points:  35%  — most definitive visual indicator
  Edge substrate exposure: 30%  — single strongest indicator
  Luster/reflection:       20%  — warm amber vs chrome
  Surface originality:     10%  — porosity, solder, consistency
  Colour hue accuracy:      5%  — 22K/18K specific hue range

Hard cap rules:
  Any visible substrate exposure at edges/clasps → cap score at 30
  Wrong colour at any contact point → cap score at 45
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.data.gemini import (
    GEMINI_AUDIO_VIDEO_API_KEYS,
    GEMINI_MODEL,
    GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS,
    _gemini_request,
    extract_gemini_text,
    parse_json_response,
)
from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys
from app.data.capture_assets import store_capture_asset
from app.data.item_match import compare_item_images, is_blocking_mismatch

logger = logging.getLogger("goldeye.video_eval")
router = APIRouter()
MAX_VIDEO_FRAMES = 11


class VideoEvalRequest(BaseModel):
    frames_b64: list[str]
    language: str = "en"
    session_id: Optional[str] = None
    reference_image_data_url: Optional[str] = None
    reference_frame_type: str = "top"


class VideoEvalResponse(BaseModel):
    video_score: int
    verdict: str
    wear_score: int                  # wear at contact points
    edge_substrate_score: int        # edge colour consistency
    luster_score: int                # warm amber vs chrome
    surface_originality_score: int   # porosity, solder, peeling
    hue_score: int                   # correct gold hue range
    video_signals: list[str]
    purity_estimate: Optional[str]
    guidance: str
    same_item: Optional[dict] = None


@router.post("/video-eval", response_model=VideoEvalResponse)
async def video_eval(req: VideoEvalRequest):
    if not req.frames_b64:
        return _error("No frames received", req.language)

    n_frames = min(len(req.frames_b64), MAX_VIDEO_FRAMES)
    analysis_frames = req.frames_b64[:n_frames]
    lang_out = "Hindi (Devanagari)" if req.language == "hi" else "English"

    prompt = f"""You are a gold authentication expert examining {n_frames} frames of a gold ornament rotating over 15 seconds.

Examine ALL frames carefully together. Score each signal 0-100 independently based on what you actually see.

━━━ SIGNAL 1: WEAR AT CONTACT POINTS (weight 35%) ━━━
Where plating wears off FIRST: inner ring bands, bracelet link joints, clasp mechanisms, hinge points, chain link interiors, pendant bails.
Score based on: is the colour at these high-contact/high-wear areas the SAME as the rest of the piece?

• 90-100: No wear exposure anywhere. All contact areas same warm yellow throughout. Consistent even wear with same underlying colour.
• 70-89:  Very minor variation at one contact point, still warm yellow colour.
• 50-69:  Some wear visible at joints/edges showing slightly different tone. Uncertain.
• 20-49:  Clear colour change at clasps, hinges, or link interiors — different metal showing.
• 0-19:   Obvious substrate exposure at multiple contact points — grey/copper/silver clearly visible at worn areas.

━━━ SIGNAL 2: EDGE SUBSTRATE EXPOSURE (weight 30%) ━━━
Examine ALL edges, corners, clasps, and the undersides of settings under any angle visible in the frames.
Real gold: every edge is identical warm yellow. No exceptions.

• 90-100: Every edge/corner identical warm yellow to body. Zero substrate exposure anywhere.
• 70-89:  Edges mostly match, one ambiguous corner under difficult lighting.
• 50-69:  Noticeable colour difference at some edge but uncertain about substrate vs lighting.
• 20-49:  Visibly different colour at edges — grey, silver-grey, or copper tones showing.
• 0-19:   Clear base metal (grey/copper/silver) at multiple edges/corners. Definitely plated.

━━━ SIGNAL 3: LUSTER AND REFLECTION CHARACTER (weight 20%) ━━━
Real gold: warm amber glow. Reflections have orange-yellow warmth. NOT mirror-bright.
Plated brass: chrome-like bright mirror. Cold, harsh reflections. Over-shiny.
Gold-plated silver: very bright cold white reflections, almost like chrome.

• 90-100: Rich warm amber luster. Soft glow. Reflections are warm orange-yellow. Looks deep not bright.
• 70-89:  Good warm luster with minor bright spots under direct light.
• 50-69:  Mixed — some warm areas, some overly bright patches.
• 20-49:  Chrome-like or cold reflections. Mirror-bright in most areas.
• 0-19:   Clearly wrong — bright silver/chrome appearance, cold metallic, or plastic-like sheen.

━━━ SIGNAL 4: SURFACE ORIGINALITY (weight 10%) ━━━
Look for: peeling, flaking, porosity (dark spots at contact areas), solder quality at joints.
Real gold: smooth throughout, even solder, no flaking. Solder joints same colour.
Plated: visible dark pores at contact areas, uneven solder near seams, any signs of peeling.

• 90-100: Perfect surface integrity. No pores, no peeling, smooth consistent seams. Solder joints same colour.
• 70-89:  Minor texture variation, no peeling or pores visible.
• 50-69:  Slight pitting or uneven texture at some point.
• 20-49:  Visible porosity/dark spots at contact areas, or discoloured solder joints.
• 0-19:   Peeling, flaking, or obvious defects inconsistent with solid gold.

━━━ SIGNAL 5: COLOUR HUE ACCURACY (weight 5%) ━━━
22K gold (916): warm orange-yellow, slightly reddish — not bright yellow, not greenish.
18K gold (750): slightly paler, still warm — not white, not green.
Brass: has greenish-yellow undertone compared to gold's warm orange-yellow.

• 90-100: Perfect warm orange-yellow throughout. Matches 22K or 18K reference exactly.
• 70-89:  Good warm yellow, minor variation in shaded areas.
• 50-69:  Slightly off — a bit pale (14K?) or slightly green-tinted in places.
• 20-49:  Noticeably greenish-yellow or brassy tone overall.
• 0-19:   Wrong colour — clearly not gold hue. Too green, too pale, or unnatural.

━━━ PURITY ESTIMATE ━━━
If any hallmark stamp digits are visible in any frame: report the fineness (999/916/875/750/585).
Otherwise: null.

━━━ HARD RULES ━━━
• If edge substrate exposure score < 30 (substrate clearly visible): cap video_score at 30 regardless.
• If wear score < 25 (clear substrate at contact areas): cap video_score at 40.
• Do NOT give scores in the 45-55 range unless genuinely uncertain. Commit to a position.
• Most ornaments presented for gold loans ARE real 22K/18K — score high when evidence supports it.
• video_score = round(wear*0.35 + edge_substrate*0.30 + luster*0.20 + surface_originality*0.10 + hue*0.05)
• Apply caps AFTER computing weighted score.

Return ONLY valid JSON:
{{
  "wear_score": integer 0-100,
  "edge_substrate_score": integer 0-100,
  "luster_score": integer 0-100,
  "surface_originality_score": integer 0-100,
  "hue_score": integer 0-100,
  "video_score": integer 0-100,
  "wear_observation": "specific 1-sentence finding about contact points and worn areas",
  "edge_observation": "specific 1-sentence finding about edge colour across all frames",
  "luster_observation": "specific 1-sentence finding about reflection character",
  "surface_observation": "specific 1-sentence finding about surface integrity",
  "red_flags": ["list only real specific concerns — empty if none"],
  "positive_signals": ["list specific evidence of authenticity"],
  "purity_estimate": "916 or 750 or 999 or null",
  "guidance": "1-2 sentences in {lang_out}"
}}"""

    parts = [{"text": prompt}]
    for b64 in analysis_frames:
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": b64}})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.10,
            "maxOutputTokens": 1600,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "wear_score": {"type": "INTEGER"},
                    "edge_substrate_score": {"type": "INTEGER"},
                    "luster_score": {"type": "INTEGER"},
                    "surface_originality_score": {"type": "INTEGER"},
                    "hue_score": {"type": "INTEGER"},
                    "video_score": {"type": "INTEGER"},
                    "wear_observation": {"type": "STRING"},
                    "edge_observation": {"type": "STRING"},
                    "luster_observation": {"type": "STRING"},
                    "surface_observation": {"type": "STRING"},
                    "red_flags": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "positive_signals": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "purity_estimate": {"type": "STRING", "nullable": True},
                    "guidance": {"type": "STRING"},
                },
                "required": [
                    "wear_score", "edge_substrate_score", "luster_score",
                    "surface_originality_score", "hue_score", "video_score",
                    "wear_observation", "edge_observation", "luster_observation",
                    "surface_observation", "red_flags", "positive_signals",
                    "purity_estimate", "guidance"
                ],
            },
        },
    }

    try:
        data, success = await _gemini_request(payload, timeout=60, api_keys=GEMINI_AUDIO_VIDEO_API_KEYS)
        if not success:
            raise ValueError(data.get("error", "api_failed"))
        raw = extract_gemini_text(data)
        res = parse_json_response(raw)
    except Exception as e:
        logger.warning(
            f"video_eval Gemini failed using {GEMINI_MODEL}: {e}. "
            f"Raw response: {raw if 'raw' in locals() else 'None'}"
        )
        try:
            res = await _groq_video_fallback(prompt, analysis_frames)
        except Exception as groq_error:
            logger.error(f"video_eval Groq fallback failed using {GROQ_MODEL}: {groq_error}")
            return _error(str(e), req.language)

    wear_score               = _clamp(res.get("wear_score", 50))
    edge_substrate_score     = _clamp(res.get("edge_substrate_score", 50))
    luster_score             = _clamp(res.get("luster_score", 50))
    surface_originality_score = _clamp(res.get("surface_originality_score", 50))
    hue_score                = _clamp(res.get("hue_score", 50))

    # Weighted score — computed server-side, not trusted from Gemini
    weighted = (
        wear_score               * 0.35 +
        edge_substrate_score     * 0.30 +
        luster_score             * 0.20 +
        surface_originality_score * 0.10 +
        hue_score                * 0.05
    )

    # Hard caps: substrate exposure or contact-point discolouration are disqualifiers
    if edge_substrate_score < 30:
        weighted = min(weighted, 30)
    if wear_score < 25:
        weighted = min(weighted, 40)

    video_score = max(0, min(100, round(weighted)))

    signals = []
    for field in ("wear_observation", "edge_observation", "luster_observation", "surface_observation"):
        val = str(res.get(field, "")).strip()
        if val:
            signals.append(val)
    red_flags = list(res.get("red_flags", []))
    pos_sigs  = list(res.get("positive_signals", []))
    if red_flags: signals.append("⚠ " + "; ".join(red_flags))
    if pos_sigs:  signals.append("✓ " + "; ".join(pos_sigs))

    same_item_summary = None
    if req.reference_image_data_url:
        comparisons = []
        for idx, b64 in enumerate(analysis_frames):
            item_result = await compare_item_images(
                req.reference_image_data_url,
                f"data:image/jpeg;base64,{b64}",
                reference_frame_type=req.reference_frame_type,
                candidate_frame_type=f"video_{idx}",
                use_gemini=False,
            )
            comparisons.append({**item_result, "frame_idx": idx, "frame_type": f"video_{idx}"})

        # All video frames get a fast local check. Confirm the riskiest frames
        # semantically so one bad local fingerprint does not unfairly block.
        suspect_frames = sorted(
            [
                item for item in comparisons
                if item.get("verdict") != "same" or float(item.get("same_item_score", 0.5)) < 0.55
            ],
            key=lambda item: (1.0 - float(item.get("same_item_score", 0.5))) * float(item.get("confidence", 0.0)),
            reverse=True,
        )[:3]
        for item in suspect_frames:
            idx = int(item["frame_idx"])
            confirmed = await compare_item_images(
                req.reference_image_data_url,
                f"data:image/jpeg;base64,{analysis_frames[idx]}",
                reference_frame_type=req.reference_frame_type,
                candidate_frame_type=f"video_{idx}",
            )
            comparisons[idx] = {**confirmed, "frame_idx": idx, "frame_type": f"video_{idx}"}

        mismatches = [item for item in comparisons if is_blocking_mismatch(item)]
        if mismatches:
            strongest = sorted(mismatches, key=lambda item: float(item.get("confidence", 0.0)), reverse=True)[0]
            same_item_summary = {
                **strongest,
                "frames_checked": len(comparisons),
                "mismatched_frames": mismatches,
                "comparisons": comparisons,
            }
            video_score = min(video_score, 35)
            signals.insert(0, "Different jewelry item detected compared with the top-view photo")
        elif comparisons:
            strongest = sorted(comparisons, key=lambda item: float(item.get("confidence", 0.0)), reverse=True)[0]
            same_item_summary = {
                **strongest,
                "frames_checked": len(comparisons),
                "mismatched_frames": [],
                "comparisons": comparisons,
            }

    if req.session_id:
        comparison_by_idx = {
            int(item["frame_idx"]): item
            for item in (same_item_summary or {}).get("comparisons", [])
            if "frame_idx" in item
        }
        for idx, b64 in enumerate(analysis_frames):
            try:
                await store_capture_asset(
                    req.session_id,
                    f"video_{idx}",
                    f"data:image/jpeg;base64,{b64}",
                    same_item=comparison_by_idx.get(idx) or same_item_summary,
                )
            except Exception as exc:
                logger.warning(f"video_eval asset store failed: {exc}")

    verdict = (
        "Likely solid gold"                          if video_score >= 70 else
        "Uncertain — further verification advised"   if video_score >= 50 else
        "Possibly gold-plated"
    )
    if req.language == "hi":
        verdict = (
            "संभवतः असली सोना"       if video_score >= 70 else
            "अनिश्चित"              if video_score >= 50 else
            "संभवतः गोल्ड-प्लेटेड"
        )
    if same_item_summary and same_item_summary.get("verdict") == "different":
        verdict = "Different jewelry item detected" if req.language == "en" else "अलग गहना मिला"

    logger.info(
        f"video_eval score={video_score} wear={wear_score} edge={edge_substrate_score} "
        f"luster={luster_score} surface={surface_originality_score} hue={hue_score}"
    )

    return VideoEvalResponse(
        video_score=video_score,
        verdict=verdict,
        wear_score=wear_score,
        edge_substrate_score=edge_substrate_score,
        luster_score=luster_score,
        surface_originality_score=surface_originality_score,
        hue_score=hue_score,
        video_signals=signals,
        purity_estimate=res.get("purity_estimate") or None,
        guidance=str(res.get("guidance", "")),
        same_item=same_item_summary,
    )


def _clamp(v) -> int:
    try: return max(0, min(100, int(v)))
    except (TypeError, ValueError): return 50


async def _groq_video_fallback(prompt: str, frames_b64: list[str]) -> dict:
    if not GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS:
        raise ValueError("groq_video_fallback_key_missing")
    if not frames_b64:
        raise ValueError("groq_video_fallback_no_frame")

    mid = len(frames_b64) // 2
    groq_prompt = (
        prompt
        + "\n\nFallback note: Gemini video analysis failed. You are seeing one representative "
          "frame from the rotation video. Be conservative about claims requiring motion or "
          "multiple angles. Do not infer purity from color; set purity_estimate to null unless "
          "a hallmark/fineness stamp is clearly readable in this image. Return the exact "
          "requested JSON object only."
    )
    data, success = await call_groq_vision_with_keys(
        groq_prompt,
        frames_b64[mid],
        GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS,
        "image/jpeg",
        timeout=45,
    )
    if not success:
        raise ValueError(data.get("error", "groq_video_fallback_failed"))
    raw = extract_gemini_text(data)
    result = parse_json_response(raw)
    logger.info(f"video_eval Groq fallback ok using {GROQ_MODEL}")
    return result


def _error(msg: str, lang: str) -> VideoEvalResponse:
    return VideoEvalResponse(
        video_score=0, verdict="Analysis unavailable",
        wear_score=0, edge_substrate_score=0, luster_score=0,
        surface_originality_score=0, hue_score=0,
        video_signals=[msg], purity_estimate=None,
        guidance="Please try again." if lang == "en" else "कृपया पुनः प्रयास करें।",
        same_item=None,
    )
