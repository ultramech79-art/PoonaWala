"""
POST /api/debug/confidence-trace

A lightweight, no-DB debug beacon. The frontend posts the fully-computed
confidence breakdown (evidence flags + component scores + active modifiers +
final score) here so it shows up in the SERVER log — useful when testing on a
phone where the browser console isn't reachable.

This endpoint only logs; it stores nothing and returns immediately. It is safe
to leave enabled in dev. Disable from the frontend with:
  localStorage.setItem('goldeye_debug_confidence', '0')
"""
import logging
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("goldeye.debug_trace")
router = APIRouter()


class ConfidenceTrace(BaseModel):
    session_id: Optional[str] = None
    score: Optional[float] = None
    base_score: Optional[float] = None
    route: Optional[str] = None
    evidence: dict[str, Any] = {}
    components: list[dict[str, Any]] = []
    active_modifiers: list[dict[str, Any]] = []


@router.post("/debug/confidence-trace")
async def confidence_trace(trace: ConfidenceTrace):
    e = trace.evidence or {}
    logger.info("================ CONFIDENCE TRACE (from frontend) ================")
    logger.info(
        "session=%s  FINAL=%s  base=%s  route=%s",
        trace.session_id,
        f"{round((trace.score or 0) * 100)}%",
        f"{round((trace.base_score or 0) * 100)}%",
        trace.route,
    )
    logger.info(
        "IDENTITY: photoHuidEvidence=%s photoKaratEvidence=%s huidVerified=%s "
        "huidPresent=%s huidSource=%s currentHuid=%s hasMacro=%s",
        e.get("photoHuidEvidence"),
        e.get("photoKaratEvidence"),
        e.get("huidVerified"),
        e.get("huidPresent"),
        e.get("huidSource"),
        e.get("currentHuid"),
        e.get("hasMacro"),
    )
    logger.info(
        "BILL: billHuid=%s vs independentItemHuid=%s -> billHuidMatch=%s billHuidMismatch=%s "
        "billItemTypeMatch=%s usefulBillFields=%s",
        e.get("billHuid"),
        e.get("billComparisonHuid"),
        e.get("billHuidMatch"),
        e.get("billHuidMismatch"),
        e.get("billItemTypeMatch"),
        e.get("usefulBillFields"),
    )
    for c in trace.components:
        logger.info(
            "  component %-10s score=%-5s weight=%-5s weighted=%s",
            c.get("id"),
            c.get("score"),
            c.get("weight"),
            c.get("weighted"),
        )
    if trace.active_modifiers:
        for m in trace.active_modifiers:
            logger.info(
                "  MODIFIER %-26s kind=%-10s value=%s",
                m.get("id"),
                m.get("kind"),
                m.get("value"),
            )
    else:
        logger.info("  (no active fraud/hard modifiers)")
    logger.info("==================================================================")
    return {"ok": True}
