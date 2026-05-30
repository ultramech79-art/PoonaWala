from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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
        created_at=asset.created_at.isoformat() if asset.created_at else "",
    )


@router.post("/assets/upload", response_model=AssetResponse)
async def upload_asset(
    asset_kind: str = Form(...),
    session_id: Optional[str] = Form(default=None),
    frame_type: Optional[str] = Form(default=None),
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
    upload = await upload_image_bytes(
        raw,
        user_id=user.id,
        session_id=session_id,
        asset_kind=asset_kind,
        content_type=content_type,
    )

    asset = UserAsset(
        user_id=user.id,
        session_id=session_id,
        asset_kind=asset_kind,
        frame_type=frame_type,
        source="cloudinary",
        cloudinary_public_id=upload.get("public_id"),
        public_url=upload.get("secure_url") or upload.get("url"),
        content_sha256=meta.sha256,
        content_type=content_type,
        size_bytes=len(raw),
        width_px=meta.width_px or upload.get("width"),
        height_px=meta.height_px or upload.get("height"),
        metadata_json=json.dumps(
            {
                "original_filename": file.filename,
                "format": upload.get("format"),
                "resource_type": upload.get("resource_type"),
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
