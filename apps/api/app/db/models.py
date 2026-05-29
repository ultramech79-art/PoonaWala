from sqlalchemy import Column, Integer, String, DateTime, func, BigInteger, Float, LargeBinary
from .database import Base

class HuidNode(Base):
    __tablename__ = "huid_nodes"
    
    session_id = Column(String, primary_key=True, index=True)
    huid = Column(String, index=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PhashNode(Base):
    __tablename__ = "phash_nodes"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, index=True, nullable=False)
    # Storing 64-bit pHash as BigInteger or String. 
    # Python ints can be larger than 64-bit, but pHashes are exactly 64-bit uints.
    # String is safer across DBs if signedness is an issue.
    phash = Column(String, index=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ImageAsset(Base):
    __tablename__ = "image_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, index=True, nullable=False)
    frame_type = Column(String, index=True, nullable=False)
    storage_path = Column(String, nullable=True)
    public_url = Column(String, nullable=True)
    content_sha256 = Column(String, index=True, nullable=False)
    phash = Column(String, index=True, nullable=True)
    width_px = Column(Integer, nullable=True)
    height_px = Column(Integer, nullable=True)
    same_item_score = Column(Float, nullable=True)
    same_item_verdict = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ImageBlob(Base):
    __tablename__ = "image_blobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    asset_id = Column(Integer, index=True, nullable=True)
    session_id = Column(String, index=True, nullable=False)
    frame_type = Column(String, index=True, nullable=False)
    content_type = Column(String, default="image/jpeg")
    size_bytes = Column(Integer, nullable=False)
    image_bytes = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Session(Base):
    __tablename__ = "sessions"
    
    id = Column(String, primary_key=True, index=True)
    lang = Column(String, default="en")
    phone = Column(String, index=True, nullable=True)
    status = Column(String, default="in_progress")
    consent_at = Column(DateTime(timezone=True), nullable=True)
    consent_version = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    idempotency_key = Column(String, unique=True, index=True, nullable=True)


class AuditLog(Base):
    """Immutable audit trail (WORM)."""
    __tablename__ = "audit_logs"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    trace_id = Column(String, index=True, nullable=False)
    session_id = Column(String, index=True, nullable=False)
    event_type = Column(String, nullable=False)  # 'assessment_complete', 'dpdp_delete'
    payload = Column(String, nullable=False)     # JSON blob of the AssessmentResult or deletion proof
    created_at = Column(DateTime(timezone=True), server_default=func.now())
