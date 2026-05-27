"""
POST /api/guided-session/start   — create Daily room + launch Python 3.11 Pipecat subprocess
GET  /api/guided-session/{id}/progress — poll capture progress (reads subprocess state file)
POST /api/guided-session/{id}/end      — terminate subprocess + cleanup

The pipeline runs under Python 3.11 (subprocess) because pipecat 1.2.1 requires Python 3.10+.
The FastAPI app runs on Python 3.9. Communication via a temp JSON state file.
"""
import json
import logging
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("goldeye.guided_session")
router = APIRouter()

PYTHON311 = "/opt/homebrew/bin/python3.11"
PIPELINE_SCRIPT = str(Path(__file__).parent.parent / "pipeline" / "run_pipeline.py")

# session_id → {proc, state_file, room_url, user_token}
_sessions: dict = {}


class StartRequest(BaseModel):
    session_id: Optional[str] = None


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
async def start_guided_session(req: StartRequest):
    if not os.getenv("DAILY_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="DAILY_API_KEY not configured — guided session unavailable.",
        )
    if not Path(PYTHON311).exists():
        raise HTTPException(
            status_code=503,
            detail="Python 3.11 not found at /opt/homebrew/bin/python3.11 — Pipecat requires Python 3.10+.",
        )

    from app.pipeline.gold_session import create_daily_room

    session_id = req.session_id or str(uuid.uuid4())

    try:
        room = await create_daily_room(session_id)
    except Exception as e:
        logger.error(f"Failed to create Daily room: {e}")
        raise HTTPException(status_code=503, detail=f"Could not create video room: {e}")

    # Temp file for progress state written by the subprocess
    state_fd, state_path = tempfile.mkstemp(suffix=".json", prefix=f"goldeye_{session_id[:8]}_")
    os.close(state_fd)
    # Write initial state
    Path(state_path).write_text(json.dumps({
        "captured": [], "pending": ["top", "45deg", "side", "macro", "selfie"],
        "current_angle": "top", "all_done": False,
    }))

    # Launch pipeline as Python 3.11 subprocess
    env = {**os.environ}  # inherit .env already loaded by load_dotenv in main.py
    proc = subprocess.Popen(
        [
            PYTHON311, PIPELINE_SCRIPT,
            "--session-id",  session_id,
            "--room-url",    room["room_url"],
            "--bot-token",   room["bot_token"],
            "--state-file",  state_path,
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    logger.info(f"[{session_id}] Pipeline subprocess PID={proc.pid}")

    _sessions[session_id] = {
        "proc":       proc,
        "state_file": state_path,
        "room_url":   room["room_url"],
        "user_token": room["user_token"],
    }

    return StartResponse(
        session_id=session_id,
        room_url=room["room_url"],
        user_token=room["user_token"],
    )


@router.get("/guided-session/{session_id}/progress", response_model=ProgressResponse)
async def get_progress(session_id: str):
    s = _sessions.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found or already ended")

    # Check if subprocess is still alive
    proc: subprocess.Popen = s["proc"]
    if proc.poll() is not None:
        # Process ended — read final state
        stderr_output = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
        if stderr_output:
            logger.info(f"[{session_id}] Pipeline subprocess ended. Last log: {stderr_output[-500:]}")

    # Read state from file
    state_path = s["state_file"]
    try:
        data = json.loads(Path(state_path).read_text())
    except Exception:
        data = {"captured": [], "pending": [], "current_angle": None, "all_done": False}

    return ProgressResponse(
        session_id=session_id,
        captured=data.get("captured", []),
        pending=data.get("pending", []),
        current_angle=data.get("current_angle"),
        all_done=data.get("all_done", False),
    )


@router.post("/guided-session/{session_id}/end")
async def end_session(session_id: str):
    s = _sessions.pop(session_id, None)
    if s:
        proc: subprocess.Popen = s["proc"]
        if proc.poll() is None:
            proc.terminate()
        try:
            Path(s["state_file"]).unlink(missing_ok=True)
        except Exception:
            pass
    return {"status": "ended", "session_id": session_id}
