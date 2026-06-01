from sqlalchemy import Boolean, Column, Integer, String, DateTime, func, BigInteger, Float, LargeBinary, Text
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


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    phone = Column(String, unique=True, index=True, nullable=True)
    password_hash = Column(String, nullable=True)
    google_sub = Column(String, unique=True, index=True, nullable=True)
    full_name = Column(String, nullable=False)
    dob = Column(String, nullable=False)
    language = Column(String, default="en", nullable=False)
    region_code = Column(String, index=True, nullable=False)
    address = Column(Text, nullable=True)
    city = Column(String, nullable=True)
    pincode = Column(String, nullable=True)
    profile_photo_url = Column(String, nullable=True)
    profile_photo_public_id = Column(String, nullable=True)
    is_phone_verified = Column(Boolean, default=False, nullable=False)
    is_email_verified = Column(Boolean, default=False, nullable=False)  # kept for DB compat; always False
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    last_login_at = Column(DateTime(timezone=True), nullable=True)


class OtpVerification(Base):
    __tablename__ = "otp_verifications"

    session_id = Column(String, primary_key=True, index=True)
    verified_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    consumed_at = Column(DateTime(timezone=True), nullable=True)


class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, nullable=False)
    session_id = Column(String, index=True, nullable=False)
    status = Column(String, default="in_progress", nullable=False)
    region_code = Column(String, index=True, nullable=True)
    current_step = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)


class UserAsset(Base):
    __tablename__ = "user_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, nullable=False)
    session_id = Column(String, index=True, nullable=True)
    asset_kind = Column(String, index=True, nullable=False)
    frame_type = Column(String, index=True, nullable=True)
    source = Column(String, default="cloudinary", nullable=False)
    cloudinary_public_id = Column(String, index=True, nullable=True)
    public_url = Column(String, nullable=True)
    content_sha256 = Column(String, index=True, nullable=True)
    content_type = Column(String, nullable=True)
    size_bytes = Column(Integer, nullable=True)
    width_px = Column(Integer, nullable=True)
    height_px = Column(Integer, nullable=True)
    metadata_json = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LoanPrediction(Base):
    __tablename__ = "loan_predictions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, nullable=False)
    session_id = Column(String, index=True, nullable=False)
    status = Column(String, default="draft", index=True, nullable=False)
    region_code = Column(String, index=True, nullable=False)
    estimated_weight_g = Column(Float, nullable=True)
    estimated_gold_value_inr = Column(Float, nullable=True)
    eligible_loan_inr = Column(Float, nullable=True)
    ltv_pct = Column(Float, nullable=True)
    result_json = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)


class AudioDemoCommand(Base):
    __tablename__ = "audio_demo_commands"

    channel_id = Column(String, primary_key=True, index=True)
    outcome = Column(String, nullable=False)
    command_id = Column(String, nullable=False)
    consumed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
