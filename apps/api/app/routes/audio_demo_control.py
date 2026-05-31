import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.future import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import AudioDemoCommand

router = APIRouter()

AudioDemoOutcome = Literal["pass", "fail"]


class AudioDemoCommandRequest(BaseModel):
    channel_id: str
    outcome: AudioDemoOutcome


class AudioDemoCommandResponse(BaseModel):
    ok: bool = True
    channel_id: str
    outcome: Optional[AudioDemoOutcome] = None
    command_id: Optional[str] = None
    consumed: bool = False


def normalize_channel_id(value: str) -> str:
    channel_id = "".join(ch for ch in value.upper().strip() if ch.isalnum() or ch in ("-", "_"))
    if not 4 <= len(channel_id) <= 64:
        raise HTTPException(status_code=422, detail="channel_id must be 4-64 letters/numbers")
    return channel_id


@router.post("/audio-demo-command", response_model=AudioDemoCommandResponse)
async def send_audio_demo_command(
    req: AudioDemoCommandRequest,
    db: AsyncSession = Depends(get_db),
):
    channel_id = normalize_channel_id(req.channel_id)
    command_id = str(uuid.uuid4())

    res = await db.execute(select(AudioDemoCommand).where(AudioDemoCommand.channel_id == channel_id))
    command = res.scalar_one_or_none()

    if command:
        command.outcome = req.outcome
        command.command_id = command_id
        command.consumed = False
    else:
        command = AudioDemoCommand(
            channel_id=channel_id,
            outcome=req.outcome,
            command_id=command_id,
            consumed=False,
        )
        db.add(command)

    await db.commit()
    return AudioDemoCommandResponse(
        channel_id=channel_id,
        outcome=req.outcome,
        command_id=command_id,
        consumed=False,
    )


@router.get("/audio-demo-command/{channel_id}", response_model=AudioDemoCommandResponse)
async def consume_audio_demo_command(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
):
    normalized = normalize_channel_id(channel_id)
    res = await db.execute(select(AudioDemoCommand).where(AudioDemoCommand.channel_id == normalized))
    command = res.scalar_one_or_none()

    if not command or command.consumed:
        return AudioDemoCommandResponse(ok=True, channel_id=normalized, consumed=True)

    outcome = command.outcome
    command_id = command.command_id
    command.consumed = True
    await db.commit()

    return AudioDemoCommandResponse(
        channel_id=normalized,
        outcome=outcome,
        command_id=command_id,
        consumed=True,
    )
