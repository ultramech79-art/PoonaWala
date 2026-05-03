"""
S4 — Specular reflectance signature signal worker.

Gold has a distinctive warm, concentrated specular highlight pattern distinct from
plated brass (duller, more diffuse) and silver-plate (cool/neutral highlights).

Pipeline:
  1. Decode available frames (top-down, 45°, side) + video (sample 5 frames).
  2. Run per-frame specular analysis via app.data.specular.
  3. Aggregate across frames — more frames → higher confidence.
  4. Return metal_score (0=non-gold, 1=strong gold signature) + confidence.

PRD references: S4 signal, Phase 5 (§10.2 of implementation_plan.md).
"""
import time
import logging

import numpy as np

from app.models.schemas import SignalResult
from app.data.specular import analyze_specular_multi
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s4_specular")


async def run(session_id: str, frames: list[str]) -> SignalResult:
    """
    Args:
        session_id: for logging / tracing.
        frames: list of image URLs or base64 data-URIs.
                Prefers top-down (0), 45° (1), side (2); ignores macro (3).
    """
    t0 = time.time()
    try:
        import cv2

        decoded_frames = []
        # Use first 3 frames only (not macro — too close-up for reliable specular reading)
        for idx in range(min(3, len(frames))):
            url = frames[idx]
            if not url or url.startswith("local://"):
                continue
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is not None:
                decoded_frames.append(img)

        if not decoded_frames:
            return SignalResult(
                signal_id="s4_specular",
                confidence=0.0,
                payload={"metal_score": 0.5, "reason": "no_frames_decoded"},
                error="no_frames_decoded",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="specular-heuristic-v1",
            )

        result = analyze_specular_multi(decoded_frames)
        metal_score = float(result.get("metal_score", 0.5))
        confidence = float(result.get("confidence", 0.0))

        return SignalResult(
            signal_id="s4_specular",
            confidence=round(confidence, 3),
            payload={
                "metal_score": round(metal_score, 4),
                "frames_analyzed": result.get("frames_analyzed", 0),
                "score_std": result.get("score_std", 0.0),
                "per_frame": result.get("per_frame", []),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="specular-heuristic-v1",
        )

    except Exception as exc:
        logger.exception(f"[{session_id}] S4 specular analysis failed: {exc}")
        return SignalResult(
            signal_id="s4_specular",
            confidence=0.0,
            payload={"metal_score": 0.5},
            error=str(exc),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="specular-heuristic-v1",
        )
