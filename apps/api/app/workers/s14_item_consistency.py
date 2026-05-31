"""
S14 — In-session same-item consistency (ORB-grouped + adjacent-chain + VLM).

Why a CHAIN (not everything-vs-one-reference):
  Real-data testing showed that comparing a ring's TOP view against its SIDE or
  MACRO view is unreliable for BOTH ORB and chat-VLMs — those big viewpoint gaps
  make the same ring look like a different object (Gemini/Groq returned
  "different" at conf 1.0 on genuine same-ring side/macro). The comparisons that
  ARE reliable are between adjacent capture steps (small angle change).

So we verify the capture as a chain:  top → 45° → side (→ video frames).
  selfie and macro/huid are excluded: selfie is a face shot; macro is an extreme
  hallmark closeup that looks nothing like the full-item reference views.
  • ORB collapses near-duplicate/same-angle bursts into groups (fast, reliable).
  • Consecutive groups are linked if they share strong ORB inliers; otherwise the
    VLM judges that one adjacent (similar-angle) pair — which it does reliably.
  • A swap breaks the chain exactly at the swapped step; everything after the
    break that can't re-link is the swapped item.
  • Blocking requires a CONFIDENT VLM "different" on a broken link (corroborated
    by low ORB) → safe for production (genuine users aren't wrongly rejected).

Output schema is unchanged so app/routes/assess.py consumes it as before.
"""
import asyncio
import logging
import os
import time
from typing import Optional

from app.data.item_match import (
    _decode_image,
    _groq_item_api_keys,
    _load_bytes,
    compare_item_images,
)
from app.data.item_match_orb import group_by_orb, orb_fingerprint
from app.models.schemas import SignalResult

logger = logging.getLogger("goldeye.workers.s14")

STILL_FRAME_LABELS = ["top", "45deg", "side", "macro"]
_PHASE_RANK = {"top": 0, "45deg": 1, "side": 2, "macro": 3}
_LABEL_PRIORITY = {"top": 0, "45deg": 1, "side": 2, "macro": 3}
# Frames excluded from same-item chain: selfie is a face shot; macro/huid are
# extreme hallmark closeups that look nothing like the full-item reference views.
_SKIP_FRAME_LABELS = {"selfie", "macro", "huid", "closeup"}
MAX_VIDEO_FRAMES = 3

# ORB inliers between adjacent groups to auto-link as the same item (no VLM).
LINK_INLIERS = int(os.getenv("ITEM_CHAIN_LINK_INLIERS", "10"))
# Confident VLM "different" needed on a broken (low-ORB) adjacent link to block.
VLM_DIFFERENT_MIN_CONF = float(os.getenv("ITEM_VLM_DIFF_CONF", "0.80"))


def _frame_label(idx: int) -> str:
    return STILL_FRAME_LABELS[idx] if idx < len(STILL_FRAME_LABELS) else f"video_{idx - len(STILL_FRAME_LABELS)}"


def _phase_rank(label: str) -> int:
    if label.startswith("video_"):
        try:
            return 4 + int(label.split("_", 1)[1])
        except ValueError:
            return 4
    return _PHASE_RANK.get(label, 60)


def _result(session_id, t0, *, mismatch=False, score=0.0, comparisons=None, mismatched=None,
            frames=0, groups=0, method="", conf=0.0, error=None, note=""):
    return SignalResult(
        signal_id="s14_item_consistency",
        confidence=round(conf, 3),
        payload={
            "same_item_mismatch": bool(mismatch),
            "item_mismatch_score": round(float(score), 3),
            "comparisons": comparisons or [],
            "mismatched_frames": (mismatched or [])[:5],
            "frames_compared": frames,
            "groups": groups,
            "method": method,
            "note": note,
        },
        error=error,
        duration_ms=int((time.time() - t0) * 1000),
        model_version="orb-chain-vlm-v3",
    )


async def _fingerprint_entry(label: str, url: str) -> Optional[dict]:
    raw = await _load_bytes(url)
    if not raw:
        return None
    img = await asyncio.to_thread(_decode_image, raw)
    if img is None:
        return None
    fp = await asyncio.to_thread(orb_fingerprint, img)
    if not fp.get("valid"):
        return None
    return {"label": label, "url": url, "fp": fp}


def _pick_rep(group: list[int], entries: list[dict]) -> int:
    return min(group, key=lambda i: (_LABEL_PRIORITY.get(entries[i]["label"], 9), -int(entries[i]["fp"].get("n", 0))))


def _max_inliers(ga: list[int], gb: list[int], inlier_matrix: dict) -> int:
    best = 0
    for a in ga:
        for b in gb:
            best = max(best, inlier_matrix.get((min(a, b), max(a, b)), 0))
    return best


async def run(session_id: str, frames: list[str], selfie_url: Optional[str] = None, **_) -> SignalResult:  # noqa: ARG001 selfie excluded from chain
    t0 = time.time()
    tag = f"ITEMCHK[{session_id}]"
    try:
        # ── Collect candidate frames ──────────────────────────────────────────
        # Only top / 45deg / side stills and video frames are included.
        # selfie (face shot) and macro/huid (hallmark closeup) are excluded
        # because they look nothing like the full-item reference views.
        raw_entries: list[tuple[str, str]] = []
        video_count = 0
        for idx, url in enumerate(frames or []):
            if not url:
                continue
            label = _frame_label(idx)
            if label in _SKIP_FRAME_LABELS:
                continue
            if label.startswith("video_"):
                if video_count >= MAX_VIDEO_FRAMES:
                    continue
                video_count += 1
            raw_entries.append((label, url))
        if len(raw_entries) < 2:
            return _result(session_id, t0, note="not_enough_frames")

        # ── Fingerprint once, in parallel ─────────────────────────────────────
        entries = [e for e in await asyncio.gather(*[_fingerprint_entry(l, u) for l, u in raw_entries]) if e]
        if len(entries) < 2:
            return _result(session_id, t0, note="insufficient_usable_frames")

        # ── ORB grouping (collapse near-duplicate / same-angle bursts) ────────
        fps = [e["fp"] for e in entries]
        groups, inlier_matrix = await asyncio.to_thread(group_by_orb, fps)

        # group metadata: representative + phase rank (min over members)
        gmeta = []
        for g in groups:
            rep = _pick_rep(g, entries)
            rank = min(_phase_rank(entries[i]["label"]) for i in g)
            gmeta.append({"members": g, "rep": rep, "rank": rank, "label": entries[rep]["label"]})
        gmeta.sort(key=lambda m: m["rank"])  # capture-order chain
        logger.info(
            f"{tag} {len(entries)} frames → {len(gmeta)} groups: "
            + " → ".join(m["label"] for m in gmeta)
        )

        if len(gmeta) == 1:
            return _result(session_id, t0, frames=len(entries), groups=1,
                           method="orb_single_group", conf=0.85,
                           note="all frames one item by strong ORB agreement")

        have_vlm = bool(_groq_item_api_keys()) or bool(os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_GUIDANCE_FALLBACK_API_KEY"))

        # ── Walk the chain: link each consecutive group pair ──────────────────
        comparisons: list[dict] = []
        broken_after: list[int] = []     # chain index k where link k→k+1 is broken
        for k in range(len(gmeta) - 1):
            ga, gb = gmeta[k], gmeta[k + 1]
            best = _max_inliers(ga["members"], gb["members"], inlier_matrix)
            if best >= LINK_INLIERS:
                comparisons.append({"link": f"{ga['label']}→{gb['label']}", "linked": True,
                                    "via": "orb", "orb_inliers": best})
                continue
            # Low ORB → ambiguous. Ask the VLM about this ADJACENT (similar-angle) pair.
            if not have_vlm:
                comparisons.append({"link": f"{ga['label']}→{gb['label']}", "linked": True,
                                    "via": "orb_low_no_vlm_inconclusive", "orb_inliers": best})
                continue
            res = await compare_item_images(
                entries[ga["rep"]]["url"], entries[gb["rep"]]["url"],
                reference_frame_type=ga["label"], candidate_frame_type=gb["label"],
                use_remote=True, local_first=False,
            )
            verdict = res.get("verdict")
            conf = float(res.get("confidence", 0.0))
            score = float(res.get("same_item_score", 0.5))
            broken = (verdict == "different" and conf >= VLM_DIFFERENT_MIN_CONF)
            comparisons.append({
                "link": f"{ga['label']}→{gb['label']}", "linked": not broken,
                "via": res.get("method"), "orb_inliers": best,
                "verdict": verdict, "same_item_score": score, "confidence": conf,
                "mismatch_reasons": res.get("mismatch_reasons", []),
            })
            if broken:
                broken_after.append(k)

        # ── Decide: a confirmed broken link ⇒ swap ───────────────────────────
        if not broken_after:
            return _result(session_id, t0, frames=len(entries), groups=len(gmeta),
                           method="orb_chain_consistent", conf=0.8, comparisons=comparisons,
                           note="capture chain is continuous (same item)")

        # Frames from the first break onward that aren't re-linked = swapped item.
        first_break = broken_after[0]
        mismatched = []
        for m in gmeta[first_break + 1:]:
            for i in m["members"]:
                mismatched.append({"frame_type": entries[i]["label"]})
        # score from the strongest broken link
        broken_scores = [
            (1.0 - float(c.get("same_item_score", 0.5))) * float(c.get("confidence", 0.0))
            for c in comparisons if not c.get("linked") and "verdict" in c
        ]
        score = max(broken_scores) if broken_scores else 0.9
        conf = max((float(c.get("confidence", 0.0)) for c in comparisons if "confidence" in c), default=0.8)
        logger.info(f"{tag} SWAP detected at link {first_break} ({comparisons[first_break]['link']}) score={score:.2f}")
        return _result(session_id, t0, mismatch=True, score=score, comparisons=comparisons,
                       mismatched=mismatched, frames=len(entries), groups=len(gmeta),
                       method="orb_chain_break", conf=conf,
                       note=f"capture chain broken at {comparisons[first_break]['link']}")
    except Exception as exc:
        logger.warning(f"{tag} failed: {exc}")
        return _result(session_id, t0, error=str(exc), note="exception")
