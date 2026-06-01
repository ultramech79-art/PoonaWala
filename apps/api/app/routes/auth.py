from __future__ import annotations

import asyncio
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.data.india_regions import is_valid_region_code
from app.db.database import get_db
from app.db.models import User
from app.routes.otp import verify_otp_code

router = APIRouter()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

JWT_ALGORITHM = "HS256"


class UserProfile(BaseModel):
    id: str
    phone: Optional[str]
    email: Optional[str]
    full_name: str
    dob: str
    language: str
    region_code: str
    address: Optional[str]
    city: Optional[str]
    pincode: Optional[str]
    profile_photo_url: Optional[str]
    is_phone_verified: bool
    is_email_verified: bool


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserProfile


class RegisterRequest(BaseModel):
    full_name: str
    dob: str
    region_code: str
    language: str = "en"
    phone: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    pincode: Optional[str] = None
    otp_session_id: Optional[str] = None
    otp: Optional[str] = None
    google_id_token: Optional[str] = None
    profile_photo_url: Optional[str] = None
    profile_photo_public_id: Optional[str] = None

    @validator("full_name")
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("full_name is required")
        return value

    @validator("region_code")
    def validate_region(cls, value: str) -> str:
        code = value.upper().strip()
        if not is_valid_region_code(code):
            raise ValueError("invalid Indian region")
        return code

    @validator("password")
    def validate_password(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and len(value) < 8:
            raise ValueError("password must be at least 8 characters")
        return value

    @validator("email")
    def validate_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", normalized):
            raise ValueError("invalid email")
        return normalized


class PasswordLoginRequest(BaseModel):
    phone_or_email: str
    password: str


class OtpLoginRequest(BaseModel):
    phone: str
    otp_session_id: str
    otp: str


class GoogleLoginRequest(BaseModel):
    id_token: str


def _jwt_secret() -> str:
    return os.getenv("AUTH_JWT_SECRET", "dev-change-me")


def _jwt_minutes() -> int:
    try:
        return max(5, int(os.getenv("AUTH_JWT_EXPIRES_MINUTES", "43200")))
    except ValueError:
        return 43200


def _normalize_phone(phone: Optional[str]) -> Optional[str]:
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) != 10:
        raise HTTPException(status_code=422, detail="phone must be a 10 digit Indian mobile number")
    return f"+91{digits}"


def _profile(user: User) -> UserProfile:
    return UserProfile(
        id=user.id,
        phone=user.phone,
        email=user.email,
        full_name=user.full_name,
        dob=user.dob,
        language=user.language,
        region_code=user.region_code,
        address=user.address,
        city=user.city,
        pincode=user.pincode,
        profile_photo_url=user.profile_photo_url,
        is_phone_verified=bool(user.is_phone_verified),
        is_email_verified=bool(user.is_email_verified),
    )


def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=_jwt_minutes())).timestamp()),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


async def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found")
    return user


async def _verify_google_id_token(id_token: str) -> dict:
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(status_code=503, detail="google_auth_not_configured")

    def _verify() -> dict:
        from google.auth.transport import requests
        from google.oauth2 import id_token as google_id_token

        return google_id_token.verify_oauth2_token(id_token, requests.Request(), client_id)

    return await asyncio.to_thread(_verify)


async def _issue(user: User, db: AsyncSession) -> AuthResponse:
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    return AuthResponse(access_token=create_access_token(user.id), user=_profile(user))


@router.post("/auth/register", response_model=AuthResponse)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    phone = _normalize_phone(req.phone)
    email = str(req.email).lower() if req.email else None
    google_payload = None

    if req.google_id_token:
        google_payload = await _verify_google_id_token(req.google_id_token)
        email = email or google_payload.get("email")

    phone_verified = False
    if phone and req.otp_session_id and req.otp:
        otp_result = await verify_otp_code(req.otp_session_id, req.otp)
        phone_verified = bool(otp_result.success and otp_result.valid)
        if not phone_verified:
            raise HTTPException(status_code=401, detail="otp_verification_failed")

    if not phone and not email:
        raise HTTPException(status_code=422, detail="phone or email is required")

    filters = []
    if phone:
        filters.append(User.phone == phone)
    if email:
        filters.append(User.email == email)
    if filters:
        for condition in filters:
            existing = (await db.execute(select(User).where(condition))).scalar_one_or_none()
            if existing:
                raise HTTPException(status_code=409, detail="user already exists")

    user = User(
        id=str(uuid.uuid4()),
        phone=phone,
        email=email,
        password_hash=pwd_context.hash(req.password) if req.password else None,
        google_sub=google_payload.get("sub") if google_payload else None,
        full_name=req.full_name,
        dob=req.dob,
        language=req.language,
        region_code=req.region_code,
        address=req.address,
        city=req.city,
        pincode=req.pincode,
        profile_photo_url=req.profile_photo_url,
        profile_photo_public_id=req.profile_photo_public_id,
        is_phone_verified=phone_verified,
        is_email_verified=bool(google_payload and google_payload.get("email_verified")),
    )
    db.add(user)
    return await _issue(user, db)


@router.post("/auth/login/password", response_model=AuthResponse)
async def login_password(req: PasswordLoginRequest, db: AsyncSession = Depends(get_db)):
    identifier = req.phone_or_email.strip().lower()
    phone = _normalize_phone(identifier) if "@" not in identifier else None
    condition = User.phone == phone if phone else User.email == identifier
    user = (await db.execute(select(User).where(condition))).scalar_one_or_none()
    if not user or not user.password_hash or not pwd_context.verify(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid credentials")
    return await _issue(user, db)


@router.post("/auth/login/otp", response_model=AuthResponse)
async def login_otp(req: OtpLoginRequest, db: AsyncSession = Depends(get_db)):
    phone = _normalize_phone(req.phone)
    otp_result = await verify_otp_code(req.otp_session_id, req.otp)
    if not otp_result.success or not otp_result.valid:
        raise HTTPException(status_code=401, detail="otp_verification_failed")
    user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="user_not_registered")
    user.is_phone_verified = True
    return await _issue(user, db)


@router.post("/auth/login/google", response_model=AuthResponse)
async def login_google(req: GoogleLoginRequest, db: AsyncSession = Depends(get_db)):
    payload = await _verify_google_id_token(req.id_token)
    sub = payload.get("sub")
    email = payload.get("email")
    user = None
    if sub:
        user = (await db.execute(select(User).where(User.google_sub == sub))).scalar_one_or_none()
    if not user and email:
        user = (await db.execute(select(User).where(User.email == email.lower()))).scalar_one_or_none()

    if not user:
        # Auto-register new Google users with a minimal profile
        user = User(
            id=str(uuid.uuid4()),
            email=email.lower() if email else None,
            google_sub=sub,
            full_name=payload.get("name") or payload.get("given_name") or "User",
            dob="2000-01-01",
            language="en",
            region_code="MH",
            profile_photo_url=payload.get("picture"),
            is_email_verified=bool(payload.get("email_verified")),
        )
        db.add(user)
    else:
        if sub and not user.google_sub:
            user.google_sub = sub
        user.is_email_verified = bool(payload.get("email_verified"))
        # Update profile photo from Google if user doesn't have one
        if not user.profile_photo_url and payload.get("picture"):
            user.profile_photo_url = payload.get("picture")

    return await _issue(user, db)


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = None
    dob: Optional[str] = None
    language: Optional[str] = None
    region_code: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    pincode: Optional[str] = None
    profile_photo_url: Optional[str] = None


@router.patch("/auth/me", response_model=UserProfile)
async def update_profile(
    req: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's profile fields. Only non-null fields are updated."""
    if req.full_name is not None:
        name = req.full_name.strip()
        if len(name) < 2:
            raise HTTPException(status_code=422, detail="full_name must be at least 2 characters")
        user.full_name = name
    if req.dob is not None:
        user.dob = req.dob
    if req.language is not None:
        user.language = req.language
    if req.region_code is not None:
        code = req.region_code.upper().strip()
        if not is_valid_region_code(code):
            raise HTTPException(status_code=422, detail="invalid region_code")
        user.region_code = code
    if req.address is not None:
        user.address = req.address
    if req.city is not None:
        user.city = req.city
    if req.pincode is not None:
        user.pincode = req.pincode
    if req.profile_photo_url is not None:
        user.profile_photo_url = req.profile_photo_url

    await db.commit()
    await db.refresh(user)
    return _profile(user)


@router.get("/auth/me", response_model=UserProfile)
async def me(user: User = Depends(get_current_user)):
    return _profile(user)
