"""
OTP send/verify via 2Factor.in.
POST /otp/send-otp   → sends OTP to mobile, returns 2factor session_id
POST /otp/verify-otp → verifies 6-digit code, returns valid flag
"""
import os
import logging
from typing import Optional
import aiohttp
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("goldeye.otp")

TWOFACTOR_API_KEY = os.getenv("TWOFACTOR_API_KEY", "")
_BASE = "https://2factor.in/API/V1"


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


@router.post("/otp/send-otp", response_model=SendOtpResponse)
async def send_otp(req: SendOtpRequest):
    phone = req.phone.strip()
    if len(phone) != 10 or not phone.isdigit():
        return SendOtpResponse(success=False, message="Invalid phone number", error="bad_phone")

    if not TWOFACTOR_API_KEY:
        # Dev fallback: accept any number, return a fake session
        logger.warning("TWOFACTOR_API_KEY not set — using dev bypass (session: dev_session)")
        return SendOtpResponse(success=True, message="OTP sent (dev mode)", session_id="dev_session")

    url = f"{_BASE}/{TWOFACTOR_API_KEY}/SMS/{phone}/AUTOGEN"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json(content_type=None)
                logger.info(f"2Factor send response: {data}")

                if data.get("Status") == "Success":
                    return SendOtpResponse(
                        success=True,
                        message="OTP sent successfully",
                        session_id=data.get("Details", ""),
                    )
                else:
                    return SendOtpResponse(
                        success=False,
                        message=data.get("Details", "Failed to send OTP"),
                        error=str(data.get("Details", "unknown")),
                    )
    except Exception as e:
        logger.exception(f"2Factor send error: {e}")
        return SendOtpResponse(success=False, message="OTP service unavailable", error=str(e))


@router.post("/otp/verify-otp", response_model=VerifyOtpResponse)
async def verify_otp(req: VerifyOtpRequest):
    if not TWOFACTOR_API_KEY:
        # Dev bypass: any 6-digit code is valid
        is_valid = len(req.otp) == 6 and req.otp.isdigit()
        return VerifyOtpResponse(
            success=True,
            valid=is_valid,
            message="Verified (dev mode)" if is_valid else "Invalid OTP",
        )

    if req.session_id == "dev_session":
        is_valid = len(req.otp) == 6 and req.otp.isdigit()
        return VerifyOtpResponse(success=True, valid=is_valid, message="Verified (dev mode)")

    url = f"{_BASE}/{TWOFACTOR_API_KEY}/SMS/VERIFY/{req.session_id}/{req.otp}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json(content_type=None)
                logger.info(f"2Factor verify response: {data}")

                if data.get("Status") == "Success" and data.get("Details") == "OTP Matched":
                    return VerifyOtpResponse(success=True, valid=True, message="OTP verified successfully")
                else:
                    detail = data.get("Details", "OTP mismatch")
                    return VerifyOtpResponse(success=True, valid=False, message=detail)
    except Exception as e:
        logger.exception(f"2Factor verify error: {e}")
        return VerifyOtpResponse(success=False, valid=False, message="Verification service unavailable", error=str(e))
