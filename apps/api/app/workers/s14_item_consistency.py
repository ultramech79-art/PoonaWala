"""
S14 — In-session same-item consistency.

Compares the first/top-view capture against later stills, the selfie, and every
video frame supplied in the final assessment request. This detects a borrower
switching jewelry between capture steps.
"""
import time

from app.data.item_match import compare_item_images, is_blocking_mismatch
from app.models.schemas import SignalResult


STILL_FRAME_LABELS = ["top", "45deg", "side", "macro"]


def _frame_label(idx: int) -> str:
    if idx < len(STILL_FRAME_LABELS):
        return STILL_FRAME_LABELS[idx]
    return f"video_{idx - len(STILL_FRAME_LABELS)}"


async def run(session_id: str, frames: list[str], selfie_url: str | None = None, **_) -> SignalResult:
    t0 = time.time()
    try:
        if not frames or (len(frames) < 2 and not selfie_url):
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
        for idx, url in enumerate(frames[1:], start=1):
            if url:
                candidates.append((idx, _frame_label(idx), url))
        if selfie_url:
            candidates.append((len(frames), "selfie", selfie_url))

        comparisons = []
        for idx, label, url in candidates:
            result = await compare_item_images(
                reference,
                url,
                reference_frame_type="top",
                candidate_frame_type=label,
                use_gemini=False,
            )
            result = {**result, "frame_idx": idx, "frame_type": label}
            comparisons.append(result)

        suspect_frames = sorted(
            [
                item for item in comparisons
                if item.get("verdict") != "same" or float(item.get("same_item_score", 0.5)) < 0.55
            ],
            key=lambda item: (1.0 - float(item.get("same_item_score", 0.5))) * float(item.get("confidence", 0.0)),
            reverse=True,
        )[:3]
        candidates_by_idx = {idx: (label, url) for idx, label, url in candidates}
        for item in suspect_frames:
            idx = int(item["frame_idx"])
            label, url = candidates_by_idx[idx]
            confirmed = await compare_item_images(
                reference,
                url,
                reference_frame_type="top",
                candidate_frame_type=label,
            )
            comparisons = [
                {**confirmed, "frame_idx": idx, "frame_type": label} if c.get("frame_idx") == idx else c
                for c in comparisons
            ]

        mismatched = []
        for item in comparisons:
            if is_blocking_mismatch(item):
                mismatched.append({
                    "frame_idx": item["frame_idx"],
                    "frame_type": item["frame_type"],
                    "result": item,
                })

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
