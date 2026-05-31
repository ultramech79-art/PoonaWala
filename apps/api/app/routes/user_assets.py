from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.data.cloudinary_storage import delete_image, image_metadata, upload_image_bytes
from app.db.database import get_db
from app.db.models import LoanPrediction, User, UserAsset, UserSession
from app.routes.auth import get_current_user

logger = logging.getLogger("goldeye.user_assets")

router = APIRouter()

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


class AssetResponse(BaseModel):
    id: int
    session_id: Optional[str]
    asset_kind: str
    frame_type: Optional[str]
    public_url: Optional[str]
    cloudinary_public_id: Optional[str]
    width_px: Optional[int]
    height_px: Optional[int]
    size_bytes: Optional[int]
    metadata: Optional[dict[str, Any]] = None
    created_at: str


class UserSessionResponse(BaseModel):
    id: int
    session_id: str
    status: str
    region_code: Optional[str]
    current_step: Optional[str]
    created_at: str
    completed_at: Optional[str]


class LoanPredictionResponse(BaseModel):
    id: int
    session_id: str
    status: str
    region_code: str
    estimated_weight_g: Optional[float]
    estimated_gold_value_inr: Optional[float]
    eligible_loan_inr: Optional[float]
    ltv_pct: Optional[float]
    result: dict
    created_at: str
    completed_at: Optional[str]


class CreateUserSessionRequest(BaseModel):
    session_id: str
    region_code: Optional[str] = None
    current_step: Optional[str] = None


class SaveLoanPredictionRequest(BaseModel):
    session_id: str
    status: str = "completed"
    region_code: str
    estimated_weight_g: Optional[float] = None
    estimated_gold_value_inr: Optional[float] = None
    eligible_loan_inr: Optional[float] = None
    ltv_pct: Optional[float] = None
    result: dict


def _asset_response(asset: UserAsset) -> AssetResponse:
    metadata = None
    if asset.metadata_json:
        try:
            parsed = json.loads(asset.metadata_json)
            if isinstance(parsed, dict):
                metadata = parsed
        except Exception:
            metadata = None
    return AssetResponse(
        id=asset.id,
        session_id=asset.session_id,
        asset_kind=asset.asset_kind,
        frame_type=asset.frame_type,
        public_url=asset.public_url,
        cloudinary_public_id=asset.cloudinary_public_id,
        width_px=asset.width_px,
        height_px=asset.height_px,
        size_bytes=asset.size_bytes,
        metadata=metadata,
        created_at=asset.created_at.isoformat() if asset.created_at else "",
    )


@router.post("/assets/upload", response_model=AssetResponse)
async def upload_asset(
    asset_kind: str = Form(...),
    session_id: Optional[str] = Form(default=None),
    frame_type: Optional[str] = Form(default=None),
    metadata_json: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    content_type = file.content_type or "application/octet-stream"
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WEBP images are supported")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="empty upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="image is larger than 8MB")

    meta = image_metadata(raw)
    extra_metadata: dict[str, Any] = {}
    if metadata_json:
        try:
            parsed = json.loads(metadata_json)
            if isinstance(parsed, dict):
                extra_metadata = parsed
        except Exception:
            extra_metadata = {}
    
    from app.data.capture_assets import _upload_object
    ts = int(time.time() * 1000)
    storage_path = f"users/{user.id}/sessions/{session_id or 'unknown'}/{ts}_{asset_kind}.jpg"
    
    upload = await _upload_object(
        raw,
        storage_path=storage_path,
        content_type=content_type,
    )
    if upload.get("error"):
        raise HTTPException(status_code=500, detail=f"Upload failed: {upload.get('error')}")

    asset = UserAsset(
        user_id=user.id,
        session_id=session_id,
        asset_kind=asset_kind,
        frame_type=frame_type,
        source="supabase" if "supabase" in (upload.get("public_url") or "") else "cloudinary",
        cloudinary_public_id=upload.get("storage_path"),
        public_url=upload.get("public_url"),
        content_sha256=meta.sha256,
        content_type=content_type,
        size_bytes=len(raw),
        width_px=meta.width_px,
        height_px=meta.height_px,
        metadata_json=json.dumps(
            {
                "original_filename": file.filename,
                "storage_enabled": upload.get("storage_enabled"),
                **extra_metadata,
            }
        ),
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return _asset_response(asset)


@router.get("/me/assets", response_model=list[AssetResponse])
async def my_assets(
    session_id: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(UserAsset).where(UserAsset.user_id == user.id)
    if session_id:
        query = query.where(UserAsset.session_id == session_id)
    result = await db.execute(query.order_by(desc(UserAsset.created_at)).limit(100))
    return [_asset_response(asset) for asset in result.scalars().all()]


async def _read_asset_bytes(asset: UserAsset) -> bytes:
    if asset.public_url:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(asset.public_url)
            if response.status_code == 200 and response.content:
                return response.content
        except Exception as exc:
            logger.warning("public asset fetch failed asset=%s: %s", asset.id, exc)

    if asset.source == "supabase" and asset.cloudinary_public_id:
        supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
        service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "jewelry-captures").strip() or "jewelry-captures"
        if supabase_url and service_key:
            url = f"{supabase_url}/storage/v1/object/{bucket}/{asset.cloudinary_public_id}"
            headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(url, headers=headers)
            if response.status_code == 200 and response.content:
                return response.content

    raise HTTPException(status_code=404, detail="asset_image_unavailable")


@router.get("/me/assets/{asset_id}/image")
async def my_asset_image(
    asset_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    asset = await db.get(UserAsset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset_not_found")
    if asset.user_id != user.id:
        raise HTTPException(status_code=403, detail="not_your_asset")
    raw = await _read_asset_bytes(asset)
    return Response(
        content=raw,
        media_type=asset.content_type or "image/jpeg",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post("/me/sessions", response_model=UserSessionResponse)
async def create_user_session(
    req: CreateUserSessionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    existing = (
        await db.execute(
            select(UserSession).where(
                UserSession.user_id == user.id,
                UserSession.session_id == req.session_id,
            )
        )
    ).scalar_one_or_none()
    session = existing or UserSession(user_id=user.id, session_id=req.session_id)
    session.region_code = req.region_code or user.region_code
    session.current_step = req.current_step
    if not existing:
        db.add(session)
    await db.commit()
    await db.refresh(session)
    return UserSessionResponse(
        id=session.id,
        session_id=session.session_id,
        status=session.status,
        region_code=session.region_code,
        current_step=session.current_step,
        created_at=session.created_at.isoformat() if session.created_at else "",
        completed_at=session.completed_at.isoformat() if session.completed_at else None,
    )


@router.get("/me/sessions", response_model=list[UserSessionResponse])
async def my_sessions(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(UserSession).where(UserSession.user_id == user.id).order_by(desc(UserSession.created_at)).limit(50)
    )
    return [
        UserSessionResponse(
            id=session.id,
            session_id=session.session_id,
            status=session.status,
            region_code=session.region_code,
            current_step=session.current_step,
            created_at=session.created_at.isoformat() if session.created_at else "",
            completed_at=session.completed_at.isoformat() if session.completed_at else None,
        )
        for session in result.scalars().all()
    ]


@router.post("/me/loan-predictions", response_model=LoanPredictionResponse)
async def save_loan_prediction(
    req: SaveLoanPredictionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    prediction = LoanPrediction(
        user_id=user.id,
        session_id=req.session_id,
        status=req.status,
        region_code=req.region_code,
        estimated_weight_g=req.estimated_weight_g,
        estimated_gold_value_inr=req.estimated_gold_value_inr,
        eligible_loan_inr=req.eligible_loan_inr,
        ltv_pct=req.ltv_pct,
        result_json=json.dumps(req.result),
    )
    db.add(prediction)
    await db.commit()
    await db.refresh(prediction)
    return LoanPredictionResponse(
        id=prediction.id,
        session_id=prediction.session_id,
        status=prediction.status,
        region_code=prediction.region_code,
        estimated_weight_g=prediction.estimated_weight_g,
        estimated_gold_value_inr=prediction.estimated_gold_value_inr,
        eligible_loan_inr=prediction.eligible_loan_inr,
        ltv_pct=prediction.ltv_pct,
        result=json.loads(prediction.result_json),
        created_at=prediction.created_at.isoformat() if prediction.created_at else "",
        completed_at=prediction.completed_at.isoformat() if prediction.completed_at else None,
    )


@router.get("/me/loan-predictions", response_model=list[LoanPredictionResponse])
async def my_loan_predictions(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(LoanPrediction).where(LoanPrediction.user_id == user.id).order_by(desc(LoanPrediction.created_at)).limit(50)
    )
    return [
        LoanPredictionResponse(
            id=prediction.id,
            session_id=prediction.session_id,
            status=prediction.status,
            region_code=prediction.region_code,
            estimated_weight_g=prediction.estimated_weight_g,
            estimated_gold_value_inr=prediction.estimated_gold_value_inr,
            eligible_loan_inr=prediction.eligible_loan_inr,
            ltv_pct=prediction.ltv_pct,
            result=json.loads(prediction.result_json),
            created_at=prediction.created_at.isoformat() if prediction.created_at else "",
            completed_at=prediction.completed_at.isoformat() if prediction.completed_at else None,
        )
        for prediction in result.scalars().all()
    ]


@router.delete("/me/assets/{asset_id}", status_code=204)
async def delete_asset(
    asset_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete an uploaded asset. Removes from database and Cloudinary."""
    asset = await db.get(UserAsset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset_not_found")
    if asset.user_id != user.id:
        raise HTTPException(status_code=403, detail="not_your_asset")

    # Delete from Cloudinary first
    if asset.cloudinary_public_id:
        deleted = await delete_image(asset.cloudinary_public_id)
        if not deleted:
            logger.warning(
                "Cloudinary delete failed for public_id=%s (asset=%d, user=%s)",
                asset.cloudinary_public_id, asset_id, user.id,
            )

    await db.delete(asset)
    await db.commit()
