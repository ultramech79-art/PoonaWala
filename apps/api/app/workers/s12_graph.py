"""
S12 — Cross-application fraud graph signal worker.

Detects identity-reuse and ring fraud patterns across applicants by maintaining
an in-memory (and optionally Postgres-backed) index of:
  - HUID codes → list of sessions that claimed them
  - Photo pHashes → list of sessions that used them

Fraud patterns flagged:
  1. Same HUID across different applicant phones → HUID-reuse fraud
  2. Same photo pHash across different sessions → photo-reuse fraud

MVP: in-process dict (lost on restart; good enough for demo-day and single instance).
Pilot scope: persist to Postgres `applicant_graph` table (schema in implementation_plan §10.4).

PRD references: S12, FR-FRD-03, Phase 5 (§10.4 of implementation_plan.md).
"""
import time
import logging
from collections import defaultdict
from typing import Optional

import numpy as np

from app.models.schemas import SignalResult
from app.data.phash import compute_phash, hamming_distance, phash_to_hex
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s12_graph")

from app.db.database import AsyncSessionLocal
from app.db.models import HuidNode, PhashNode
from sqlalchemy.future import select

PHASH_HAMMING_THRESHOLD = 8   # tighter than S9 (same session = same person)

async def _update_graph(db_session, session_id: str, huid_code: Optional[str], photo_hashes: list[str]):
    """Register this session into the persistent graph."""
    if huid_code:
        node = HuidNode(session_id=session_id, huid=huid_code)
        db_session.add(node)
    
    for h in photo_hashes:
        node = PhashNode(session_id=session_id, phash=h)
        db_session.add(node)
        
    await db_session.commit()


async def _query_graph(db_session, session_id: str, huid_code: Optional[str], photo_hashes: list[str]) -> dict:
    """
    Check for prior sessions that share this HUID or photos.
    Returns anomaly signals.
    """
    huid_collision_sessions: list[str] = []
    photo_reuse_sessions: list[str] = []

    # Check HUID collisions
    if huid_code:
        res = await db_session.execute(
            select(HuidNode.session_id).where(HuidNode.huid == huid_code, HuidNode.session_id != session_id)
        )
        huid_collision_sessions = [r[0] for r in res.all()]

    # Check pHash collisions
    # For MVP scale, fetch all hashes and compare in python. 
    # For production, we'd use pgvector/Qdrant or Postgres BIT XOR.
    if photo_hashes:
        res = await db_session.execute(select(PhashNode.session_id, PhashNode.phash).where(PhashNode.session_id != session_id))
        stored_hashes = res.all()
        
        for new_hex in photo_hashes:
            try:
                new_int = int(new_hex, 16)
            except ValueError:
                continue
                
            for stored_session_id, stored_hex in stored_hashes:
                try:
                    stored_int = int(stored_hex, 16)
                    if hamming_distance(stored_int, new_int) <= PHASH_HAMMING_THRESHOLD:
                        photo_reuse_sessions.append(stored_session_id)
                except ValueError:
                    pass

    return {
        "huid_collision_sessions": list(set(huid_collision_sessions)),
        "photo_reuse_sessions": list(set(photo_reuse_sessions)),
    }


async def run(
    session_id: str,
    frames: list[str],
    huid_code: Optional[str] = None,
) -> SignalResult:
    """
    Args:
        session_id: current session UUID.
        frames: list of image URLs / data-URIs (still photos only — no video/audio).
        huid_code: the HUID extracted by S1 (may be None if not found).
    """
    t0 = time.time()
    try:
        import cv2

        photo_hashes: list[str] = []
        for url in frames[:4]:
            if not url or url.startswith("local://"):
                continue
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            h = compute_phash(img)
            if h is not None:
                photo_hashes.append(phash_to_hex(h))

        # Query and Update persistently
        async with AsyncSessionLocal() as db_session:
            collisions = await _query_graph(db_session, session_id, huid_code, photo_hashes)
            await _update_graph(db_session, session_id, huid_code, photo_hashes)

        huid_reuse = len(collisions["huid_collision_sessions"]) > 0
        photo_reuse = len(collisions["photo_reuse_sessions"]) > 0

        # Anomaly score: each collision type adds weight
        anomaly_score = 0.0
        if huid_reuse:
            anomaly_score += 0.5
        if photo_reuse:
            anomaly_score += 0.4
        anomaly_score = float(np.clip(anomaly_score, 0.0, 1.0))

        triggers = []
        if huid_reuse:
            triggers.append("huid_seen_in_prior_session")
        if photo_reuse:
            triggers.append("photo_reuse_detected")

        return SignalResult(
            signal_id="s12_graph",
            confidence=0.9 if photo_hashes else 0.3,
            payload={
                "graph_anomaly_score": round(anomaly_score, 3),
                "huid_reuse": huid_reuse,
                "photo_reuse": photo_reuse,
                "huid_collision_sessions": collisions["huid_collision_sessions"][:5],
                "photo_reuse_sessions": collisions["photo_reuse_sessions"][:5],
                "fraud_triggers": triggers,
                "photos_indexed": len(photo_hashes),
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="graph-inmemory-v1",
        )

    except Exception as exc:
        logger.exception(f"[{session_id}] S12 graph signal failed: {exc}")
        return SignalResult(
            signal_id="s12_graph",
            confidence=0.0,
            payload={"graph_anomaly_score": 0.0, "huid_reuse": False, "photo_reuse": False},
            error=str(exc),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="graph-inmemory-v1",
        )
