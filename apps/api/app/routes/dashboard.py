from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List, Optional
from pydantic import BaseModel
import json
from datetime import datetime, timezone

from app.db.database import get_db
from app.db.models import Session, AuditLog
from app.limiter import limiter

router = APIRouter()

class SessionSummary(BaseModel):
    session_id: str
    phone: Optional[str]
    status: str
    created_at: str
    completed_at: Optional[str]
    confidence_score: Optional[float]
    routing: Optional[str]

class DashboardActionRequest(BaseModel):
    action: str  # "approve_dispatch", "request_recapture", "decline"
    reason: Optional[str] = None

@router.get("/sessions", response_model=List[SessionSummary])
async def list_sessions(db: AsyncSession = Depends(get_db)):
    """NBFC Dashboard: List all sessions."""
    res = await db.execute(select(Session).order_by(Session.created_at.desc()).limit(100))
    sessions = res.scalars().all()
    
    # In a real app we'd do a JOIN, but for MVP we fetch audits manually
    audit_res = await db.execute(select(AuditLog).where(AuditLog.event_type == 'assessment_complete'))
    audits = audit_res.scalars().all()
    audit_map = {a.session_id: json.loads(a.payload) for a in audits}
    
    summaries = []
    for s in sessions:
        payload = audit_map.get(s.id, {})
        confidence = payload.get("confidence", {}).get("score")
        routing = payload.get("routing")
        
        summaries.append(SessionSummary(
            session_id=s.id,
            phone=s.phone,
            status=s.status,
            created_at=s.created_at.isoformat() if s.created_at else "",
            completed_at=None, # Extract from payload/audit timestamp if needed
            confidence_score=confidence,
            routing=routing
        ))
    return summaries

@router.get("/sessions/{session_id}")
async def get_session_detail(session_id: str, db: AsyncSession = Depends(get_db)):
    """NBFC Dashboard: Get full session detail including SHAP, Grad-CAM, etc."""
    res = await db.execute(select(Session).where(Session.id == session_id))
    session = res.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    audit_res = await db.execute(select(AuditLog).where(
        AuditLog.session_id == session_id,
        AuditLog.event_type == 'assessment_complete'
    ).order_by(AuditLog.created_at.desc()).limit(1))
    
    audit = audit_res.scalar_one_or_none()
    payload = json.loads(audit.payload) if audit else None
    
    return {
        "session": {
            "id": session.id,
            "phone": session.phone,
            "status": session.status,
            "created_at": session.created_at.isoformat() if session.created_at else None,
        },
        "assessment": payload
    }

@router.post("/sessions/{session_id}/action")
async def dashboard_action(session_id: str, req: DashboardActionRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """NBFC Risk Officer Action."""
    res = await db.execute(select(Session).where(Session.id == session_id))
    session = res.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    session.status = f"nbfc_{req.action}"
    
    # Log the action immutably
    audit = AuditLog(
        trace_id=getattr(request.state, "trace_id", "manual-action"),
        session_id=session.id,
        event_type=f"nbfc_action_{req.action}",
        payload=json.dumps({"reason": req.reason, "timestamp": datetime.now(timezone.utc).isoformat()})
    )
    db.add(audit)
    await db.commit()
    
    return {"status": "ok", "new_status": session.status}

class GroundTruthRequest(BaseModel):
    xrf_karat: float
    scale_weight_g: float
    final_loan_inr: int
    agent_notes: Optional[str] = None

@router.post("/agent/{session_id}/ground-truth")
async def submit_ground_truth(session_id: str, req: GroundTruthRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Field Agent: Submit XRF and scale data for active learning."""
    res = await db.execute(select(Session).where(Session.id == session_id))
    session = res.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    session.status = "disbursed"
    
    audit = AuditLog(
        trace_id=getattr(request.state, "trace_id", "agent-action"),
        session_id=session.id,
        event_type="ground_truth_collected",
        payload=req.model_dump_json()
    )
    db.add(audit)
    await db.commit()
    
    return {"status": "ok", "message": "Ground truth recorded for active learning."}
