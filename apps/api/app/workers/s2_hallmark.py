"""
S2 — Hallmark visual integrity check.
Uses S1 stamp_appearance + a VLM cross-check on the macro frame.
Phase 3: add forgery classifier (printed sticker vs. genuine stamp).
"""
import time
import logging
from typing import Optional
from app.models.schemas import SignalResult
from app.data.vlm import call_vlm

logger = logging.getLogger("goldeye.workers.s2")

_PROMPT = """Assess the physical authenticity of any hallmark stamps visible on this gold jewelry.
Return ONLY valid JSON:
{
  "hallmark_genuine": boolean,
  "quality_score": 0.0 to 1.0,
  "reason": "brief description"
}"""

_APPEARANCE_SCORES = {
    "laser_engraved": 0.95,
    "embossed": 0.85,
    "stamped": 0.75,
    "unclear": 0.50,
    "printed_sticker": 0.10,
}


async def run(session_id: str, s1_payload: Optional[dict] = None, macro_url: str = "", **_) -> SignalResult:
    t0 = time.time()
    try:
        appearance = (s1_payload or {}).get("stamp_appearance", "unclear")
        base_score = _APPEARANCE_SCORES.get(appearance, 0.5)

        if macro_url and not macro_url.startswith("local://"):
            vlm = await call_vlm(_PROMPT, [macro_url])
            vlm_score = float(vlm.get("quality_score", base_score))
            score = (base_score + vlm_score) / 2
        else:
            score = base_score

        return SignalResult(
            signal_id="s2_hallmark",
            confidence=round(score, 3),
            payload={"hallmark_quality_score": round(score, 3), "stamp_appearance": appearance},
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="qwen2.5vl-hallmark-v1",
        )
    except Exception as e:
        logger.warning(f"[{session_id}] s2_hallmark failed: {e}")
        appearance = (s1_payload or {}).get("stamp_appearance", "unclear")
        fallback = _APPEARANCE_SCORES.get(appearance, 0.5)
        return SignalResult(
            signal_id="s2_hallmark",
            confidence=round(fallback, 3),
            payload={"hallmark_quality_score": round(fallback, 3), "stamp_appearance": appearance},
            error=str(e),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="qwen2.5vl-hallmark-v1",
        )
