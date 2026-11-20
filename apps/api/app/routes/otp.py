"""
OTP send/verify (fixed OTP: 123456, no SMS provider).
POST /otp/send-otp   → returns a dev session id
POST /otp/verify-otp → valid only for 123456
"""
import logging
from typing import Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import OtpVerification

router = APIRouter()
logger = logging.getLogger("goldeye.otp")

FIXED_OTP = "123456"


class SendOtpRequest(BaseModel):
    phone: str   # 10-digit Indian mobile number


class SendOtpResponse(BaseModel):
    success: bool
    message: str
    session_id: Optional[str] = None
    error: Optional[str] = None


class VerifyOtpRequest(BaseModel):
    session_id: str
    otp: str


class VerifyOtpResponse(BaseModel):
    success: bool
    valid: bool
    message: str
    error: Optional[str] = None


async def verify_otp_code(session_id: str, otp: str) -> VerifyOtpResponse:
    """OTP is fixed: 123456 is always the valid code (no SMS provider)."""
    is_valid = (otp or "").strip() == FIXED_OTP
    return VerifyOtpResponse(
        success=True,
        valid=is_valid,
        message="OTP verified successfully" if is_valid else "Invalid OTP",
    )


async def mark_otp_session_verified(db: AsyncSession, session_id: str) -> None:
    if session_id:
        record = await db.get(OtpVerification, session_id)
        if record:
            record.consumed_at = None
        else:
            db.add(OtpVerification(session_id=session_id))
        await db.commit()


async def consume_verified_otp_session(db: AsyncSession, session_id: str) -> bool:
    if not session_id:
        return False
    record = await db.get(OtpVerification, session_id)
    if not record or record.consumed_at is not None:
        return False
    await db.delete(record)
    await db.commit()
    return True


@router.post("/otp/send-otp", response_model=SendOtpResponse)
async def send_otp(req: SendOtpRequest):
    phone = req.phone.strip()
    if len(phone) != 10 or not phone.isdigit():
        return SendOtpResponse(success=False, message="Invalid phone number", error="bad_phone")
    # No SMS is sent — the OTP is always FIXED_OTP.
    return SendOtpResponse(success=True, message="Use OTP 123456", session_id="dev_session")


@router.post("/otp/verify-otp", response_model=VerifyOtpResponse)
async def verify_otp(req: VerifyOtpRequest, db: AsyncSession = Depends(get_db)):
    result = await verify_otp_code(req.session_id, req.otp)
    if result.success and result.valid:
        await mark_otp_session_verified(db, req.session_id)
    return result
