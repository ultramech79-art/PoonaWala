"""
Session management — init, upload, finalize.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel
from sqlalchemy.future import select
import json

from app.limiter import limiter
from app.db.database import get_db
from app.db.models import Session, AuditLog, HuidNode, PhashNode
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class SessionInitRequest(BaseModel):
    lang: str = "en"
    phone: Optional[str] = None


class SessionInitResponse(BaseModel):
    session_id: str
    created_at: str
    upload_url_prefix: str  # MinIO/R2 prefix for asset uploads


class ConsentRequest(BaseModel):
    session_id: str
    version: str = "v1.0"


class ConsentResponse(BaseModel):
    session_id: str
    consent_recorded_at: str


class FinalizeRequest(BaseModel):
    session_id: str
    idempotency_key: str
    # The actual assessment result would go here in production.
    payload: dict

class FinalizeResponse(BaseModel):
    session_id: str
    status: str
    trace_id: str


@router.post("/init", response_model=SessionInitResponse)
@limiter.limit("5/minute")
async def init_session(request: Request, req: SessionInitRequest, db: AsyncSession = Depends(get_db)):
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    new_session = Session(
        id=session_id,
        lang=req.lang,
        phone=req.phone,
        status="in_progress",
    )
    db.add(new_session)
    await db.commit()
    
    return SessionInitResponse(
        session_id=session_id,
        created_at=now.isoformat(),
        upload_url_prefix=f"sessions/{session_id}/",
    )


@router.post("/consent", response_model=ConsentResponse)
@limiter.limit("10/minute")
async def record_consent(request: Request, req: ConsentRequest, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Session).where(Session.id == req.session_id))
    session = res.scalar_one_or_none()
    
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    now = datetime.now(timezone.utc)
    session.consent_at = now
    session.consent_version = req.version
    await db.commit()
    
    return ConsentResponse(session_id=req.session_id, consent_recorded_at=now.isoformat())


@router.get("/{session_id}")
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Session).where(Session.id == session_id))
    session = res.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "id": session.id,
        "lang": session.lang,
        "phone": session.phone,
        "status": session.status,
        "created_at": session.created_at.isoformat() if session.created_at else None,
    }


@router.post("/finalize", response_model=FinalizeResponse)
async def finalize_session(request: Request, req: FinalizeRequest, db: AsyncSession = Depends(get_db)):
    """
    Idempotent endpoint to finalize a session and write an immutable audit log.
    """
    trace_id = getattr(request.state, "trace_id", str(uuid.uuid4()))
    
    # 1. Check idempotency key first
    res = await db.execute(select(Session).where(Session.idempotency_key == req.idempotency_key))
    existing_session = res.scalar_one_or_none()
    if existing_session:
        # Idempotent response
        return FinalizeResponse(session_id=existing_session.id, status="already_finalized", trace_id=trace_id)
        
    # 2. Get the session
    res = await db.execute(select(Session).where(Session.id == req.session_id))
    session = res.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    if session.status == "completed":
        raise HTTPException(status_code=400, detail="Session already finalized without idempotency match")

    # 3. Mark completed and set idempotency key
    session.status = "completed"
    session.idempotency_key = req.idempotency_key
    
    # 4. Write Immutable Audit Log (WORM)
    audit = AuditLog(
        trace_id=trace_id,
        session_id=session.id,
        event_type="assessment_complete",
        payload=json.dumps(req.payload),
    )
    db.add(audit)
    
    await db.commit()
    return FinalizeResponse(session_id=session.id, status="completed", trace_id=trace_id)


@router.delete("/dpdp/delete/{phone}")
async def dpdp_delete(request: Request, phone: str, db: AsyncSession = Depends(get_db)):
    """
    DPDP compliant Right-to-be-Forgotten.
    Scrub phone from session records, and write a deletion audit log.
    """
    trace_id = getattr(request.state, "trace_id", str(uuid.uuid4()))
    
    res = await db.execute(select(Session).where(Session.phone == phone))
    sessions = res.scalars().all()
    
    if not sessions:
        return {"status": "ok", "deleted_sessions": 0, "message": "No records found for phone"}
        
    deleted_count = 0
    for s in sessions:
        s.phone = "REDACTED_DPDP"
        
        audit = AuditLog(
            trace_id=trace_id,
            session_id=s.id,
            event_type="dpdp_delete",
            payload=json.dumps({"action": "phone_redacted", "deleted_at": datetime.now(timezone.utc).isoformat()}),
        )
        db.add(audit)
        deleted_count += 1
        
    await db.commit()
    
    return {"status": "ok", "deleted_sessions": deleted_count, "trace_id": trace_id}
