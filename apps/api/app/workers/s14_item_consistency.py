"""
S14 — In-session same-item consistency.

Compares the first/top-view capture against later stills and a small sample of
video frames. This detects a borrower switching jewelry between capture steps.
"""
import time

from app.data.item_match import compare_item_images, is_blocking_mismatch
from app.models.schemas import SignalResult


FRAME_LABELS = ["top", "45deg", "side", "macro"]


async def run(session_id: str, frames: list[str], **_) -> SignalResult:
    t0 = time.time()
    try:
        if not frames or len(frames) < 2:
            return SignalResult(
                signal_id="s14_item_consistency",
                confidence=0.0,
                payload={
                    "same_item_mismatch": False,
                    "item_mismatch_score": 0.0,
                    "comparisons": [],
                    "mismatched_frames": [],
                },
                error=None,
                duration_ms=int((time.time() - t0) * 1000),
                model_version="gemini-local-item-match-v1",
            )

        reference = frames[0]
        candidates = []
        for idx, url in enumerate(frames[1:4], start=1):
            if url:
                label = FRAME_LABELS[idx] if idx < len(FRAME_LABELS) else f"frame_{idx}"
                candidates.append((idx, label, url))

        # Video frames are appended after the still photos by the web client.
        for idx, url in list(enumerate(frames[4:8], start=4))[:2]:
            if url:
                candidates.append((idx, "video", url))

        comparisons = []
        mismatched = []
        for idx, label, url in candidates:
            result = await compare_item_images(
                reference,
                url,
                reference_frame_type="top",
                candidate_frame_type=label,
            )
            result = {**result, "frame_idx": idx, "frame_type": label}
            comparisons.append(result)
            if is_blocking_mismatch(result):
                mismatched.append({"frame_idx": idx, "frame_type": label, "result": result})

        mismatch_scores = [
            (1.0 - float(item.get("same_item_score", 0.5))) * float(item.get("confidence", 0.0))
            for item in comparisons
            if item.get("verdict") == "different"
        ]
        item_mismatch_score = max(mismatch_scores) if mismatch_scores else 0.0
        same_item_mismatch = bool(mismatched)
        usable = [c for c in comparisons if float(c.get("confidence", 0.0)) > 0.0]
        confidence = max([float(c.get("confidence", 0.0)) for c in usable], default=0.0)

        return SignalResult(
            signal_id="s14_item_consistency",
            confidence=round(confidence, 3),
            payload={
                "same_item_mismatch": same_item_mismatch,
                "item_mismatch_score": round(float(item_mismatch_score), 3),
                "comparisons": comparisons,
                "mismatched_frames": mismatched[:5],
                "frames_compared": len(comparisons),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-local-item-match-v1",
        )
    except Exception as exc:
        return SignalResult(
            signal_id="s14_item_consistency",
            confidence=0.0,
            payload={
                "same_item_mismatch": False,
                "item_mismatch_score": 0.0,
                "comparisons": [],
                "mismatched_frames": [],
            },
            error=str(exc),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="gemini-local-item-match-v1",
        )
