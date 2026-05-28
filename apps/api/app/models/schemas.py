from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field

Routing = Literal["INSTANT", "AGENT", "RECAPTURE", "REJECT"]

class ModelVersions(BaseModel):
    vlm: str = "qwen2.5-vl-7b-v1"
    segmentation: str = "sam2-hiera-tiny-v1"
    plated_solid: str = "convnextv2-base-finetuned-v3"
    fusion: str = "lgbm-v7"
    conformal: str = "mapie-v1-alpha-0.1"

class Purity(BaseModel):
    band_low_karat: int
    band_high_karat: int
    point_estimate_karat: int
    huid_verified: bool

class Weight(BaseModel):
    manual_entry_g: Optional[float] = None
    estimated_g: float
    band_low_g: float
    band_high_g: float
    method: Literal["depth_volume_x_density", "manual_only", "hybrid"]

class ValueINR(BaseModel):
    band_low: int
    band_high: int
    ibja_reference_date: datetime
    stone_weight_excluded_g: float

class LoanOffer(BaseModel):
    band_low_inr: int
    band_high_inr: int
    ltv_applied_pct: int
    tier: Literal["under_2_5L", "above_2_5L"]

class Confidence(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    coverage_guarantee_pct: int = 90
    calibration_method: Literal["split_conformal", "none"]

class FraudSignals(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    triggers: list[str]

class ReasoningText(BaseModel):
    lang: str
    text: str

class SHAPFeature(BaseModel):
    feature: str
    contribution: float

class XAI(BaseModel):
    gradcam_url: Optional[str] = None
    shap_top_features: list[SHAPFeature]
    counterfactual: Optional[str] = None

class AuditTrail(BaseModel):
    trace_id: str
    input_asset_hashes: list[str]

class AssessmentResult(BaseModel):
    schema_version: str = "1.0"
    session_id: str
    timestamp_utc: datetime
    model_versions: ModelVersions
    purity: Purity
    weight: Weight
    value_inr: ValueINR
    loan_offer: LoanOffer
    confidence: Confidence
    fraud_signals: FraudSignals
    routing: Routing
    reasoning_text: ReasoningText
    xai: XAI
    audit: AuditTrail
    conformal_width_karat: float = 4.0  # karat_hi - karat_lo; drives active-learning queue


# ─── Assess request ────────────────────────────────────────────────────────────

class AssessRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    frames: list[str] = Field(..., min_length=1, max_length=20)  # Signed R2/MinIO URLs or data URIs
    video: Optional[str] = None
    audio: Optional[str] = None
    selfie: Optional[str] = None
    weight_g: Optional[float] = Field(None, gt=0, lt=5000)
    reference_object: str = Field("rs10_coin", min_length=1)
    lang: str = Field("en", min_length=2, max_length=10)
    device_metadata: Optional[dict] = None


# ─── Signal worker result ──────────────────────────────────────────────────────

class SignalResult(BaseModel):
    signal_id: str           # "s1_huid", "s7_plated_solid", …
    confidence: float        # worker's self-assessed confidence
    payload: dict            # signal-specific structured output
    error: Optional[str] = None
    duration_ms: int
    model_version: str
