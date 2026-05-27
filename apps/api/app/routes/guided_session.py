"""
POST /api/guided-session/start   — create Daily room + launch Pipecat pipeline
GET  /api/guided-session/{id}/progress — poll angle capture progress
POST /api/guided-session/{id}/end      — cleanly close session

These endpoints bridge the frontend GuidedCapture page with the Pipecat pipeline.
"""
import uuid
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("goldeye.guided_session")
router = APIRouter()

# session_id → {room_url, user_token, task, analyzer_ref, result}
_sessions: dict = {}


class StartRequest(BaseModel):
    session_id: Optional[str] = None   # reuse existing GoldEye session if provided


class StartResponse(BaseModel):
    session_id: str
    room_url: str
    user_token: str
    status: str = "started"


class ProgressResponse(BaseModel):
    session_id: str
    captured: list
    pending: list
    current_angle: Optional[str]
    all_done: bool
    assess_result: Optional[dict] = None


@router.post("/guided-session/start", response_model=StartResponse)
async def start_guided_session(req: StartRequest, background_tasks: BackgroundTasks):
    """
    Creates a Daily.co room, launches the Pipecat pipeline as a background task,
    and returns the room URL + user token for the browser to join.
    """
    import os
    if not os.getenv("DAILY_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="DAILY_API_KEY not configured — guided session unavailable. Use manual capture instead.",
        )

    from app.pipeline.gold_session import create_daily_room, run_gold_pipeline
    from app.pipeline.frame_analyzer import GoldFrameAnalyzer

    session_id = req.session_id or str(uuid.uuid4())

    # Create Daily room
    try:
        room = await create_daily_room(session_id)
    except Exception as e:
        logger.error(f"Failed to create Daily room: {e}")
        raise HTTPException(status_code=503, detail=f"Could not create video room: {e}")

    # Shared state for this session
    _sessions[session_id] = {
        "room_url": room["room_url"],
        "user_token": room["user_token"],
        "captured": [],
        "pending": ["top", "45deg", "side", "macro", "selfie"],
        "current_angle": "top",
        "all_done": False,
        "assess_result": None,
    }

    async def on_assessment_ready(captured: dict):
        """Called by GoldFrameAnalyzer when all 5 angles are done."""
        _sessions[session_id]["all_done"] = True
        _sessions[session_id]["captured"] = list(captured.keys())
        _sessions[session_id]["pending"] = []
        _sessions[session_id]["current_angle"] = None
        logger.info(f"[{session_id}] triggering /api/assess")
        # The frontend polls /progress and will navigate to /processing
        # when all_done=True; the actual assess call happens from the frontend.

    async def run_pipeline():
        try:
            await run_gold_pipeline(
                session_id=session_id,
                room_url=room["room_url"],
                bot_token=room["bot_token"],
                on_assessment_ready=on_assessment_ready,
            )
        except Exception as e:
            logger.error(f"[{session_id}] Pipeline error: {e}")
        finally:
            _sessions.pop(session_id, None)

    # Run pipeline as a background asyncio task (not a Starlette BackgroundTask —
    # we need it to stay alive for the duration of the session).
    asyncio.create_task(run_pipeline())

    return StartResponse(
        session_id=session_id,
        room_url=room["room_url"],
        user_token=room["user_token"],
    )


@router.get("/guided-session/{session_id}/progress", response_model=ProgressResponse)
async def get_progress(session_id: str):
    """Poll this endpoint to get live capture progress."""
    s = _sessions.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    return ProgressResponse(
        session_id=session_id,
        captured=s["captured"],
        pending=s["pending"],
        current_angle=s["current_angle"],
        all_done=s["all_done"],
        assess_result=s.get("assess_result"),
    )


@router.post("/guided-session/{session_id}/end")
async def end_session(session_id: str):
    """Cleanly remove session state (called when browser leaves the room)."""
    _sessions.pop(session_id, None)
    return {"status": "ended", "session_id": session_id}
