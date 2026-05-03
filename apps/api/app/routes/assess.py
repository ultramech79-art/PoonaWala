"""
POST /api/assess — the stateless assessment endpoint.
PWA is one client. WhatsApp will be another. This decoupling is
a non-negotiable architectural rule (PRD §10, plan.md §2.2).

Workers fan out in parallel via asyncio.gather; each catches its own errors
so a single failed signal never blocks the session (PRD FR-ASS-02).

Phase 5: adds S3 (colour), S4 (specular), S9 (reverse catalog), S12 (graph).
"""
import uuid
import time
import json
import hashlib
import asyncio
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Request, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from app.db.database import get_db
from app.db.models import Session as SessionModel, AuditLog
from app.models.schemas import (
    AssessRequest, AssessmentResult,
    ModelVersions, Purity, Weight, ValueINR,
    LoanOffer, Confidence, FraudSignals,
    ReasoningText, SHAPFeature, XAI, AuditTrail,
)
from app.workers.s1_huid import run as run_s1
from app.workers.s2_hallmark import run as run_s2
from app.workers.s3_color import run as run_s3
from app.workers.s4_specular import run as run_s4
from app.workers.s5_segmentation import run as run_s5
from app.workers.s6_dimensions import run as run_s6
from app.workers.s7_plated_solid import run as run_s7
from app.workers.s8_vlm import run as run_s8
from app.workers.s9_reverse_catalog import run as run_s9
from app.workers.s10_telemetry import run as run_s10
from app.workers.s11_audio import run as run_s11
from app.workers.s12_graph import run as run_s12
from app.workers.s13_liveness import run as run_s13
from app.workers.fusion import extract_features, fuse
from app.xai.shap_explainer import explain
from app.xai.text_generator import generate_reasoning, generate_counterfactual
from app.xai.gradcam import generate_gradcam_url
from app.decision.rules import apply_rbi_rules
from app.decision.routing import route_session
from app.decision.ibja import price_for_karat, price_metadata
from app.limiter import limiter

logger = logging.getLogger("goldeye.assess")
router = APIRouter()


# ─── Assess endpoint ──────────────────────────────────────────────────────────

@router.post("/assess", response_model=AssessmentResult)
@limiter.limit("10/minute")
async def assess(request: Request, req: AssessRequest, db: AsyncSession = Depends(get_db)):
    t_start = time.time()
    trace_id = getattr(request.state, "trace_id", str(uuid.uuid4()))
    logger.info(f"[{trace_id}] assess start session={req.session_id} frames={len(req.frames)}")

    macro_url = req.frames[3] if len(req.frames) > 3 else (req.frames[0] if req.frames else "")

    # ── Phase 5: S1→S2 and S5→S6 mini-pipelines; S3/S4/S7/S8/S9/S10/S11/S12 independent ──
    async def chain_huid_hallmark():
        s1 = await run_s1(req.session_id, macro_url=macro_url)
        s2 = await run_s2(req.session_id, s1_payload=s1.payload, macro_url=macro_url)
        return s1, s2

    async def chain_seg_dimensions():
        s5 = await run_s5(req.session_id, frames=req.frames)
        s6 = await run_s6(req.session_id, frames=req.frames, weight_g=req.weight_g,
                          s5_payload=s5.payload)
        return s5, s6

    # Fan-out: all 13 signals in parallel (mini-chains preserve ordering within them)
    (s1, s2), (s5, s6), s3, s4, s7, s8, s9, s10, s11, s13 = await asyncio.gather(
        chain_huid_hallmark(),
        chain_seg_dimensions(),
        run_s3(req.session_id, frames=req.frames),
        run_s4(req.session_id, frames=req.frames),
        run_s7(req.session_id, frames=req.frames),
        run_s8(req.session_id, frames=req.frames),
        run_s9(req.session_id, frames=req.frames),
        run_s10(req.session_id, device_metadata=req.device_metadata),
        run_s11(req.session_id, audio_url=req.audio),
        run_s13(req.session_id, selfie_url=req.selfie),
        return_exceptions=False,
    )

    # S12 runs after S1 so it has the HUID code for graph lookup
    huid_code_for_graph = s1.payload.get("huid_code") if not s1.error else None
    s12 = await run_s12(req.session_id, frames=req.frames, huid_code=huid_code_for_graph)

    # ── Phase 3+5: LightGBM + MAPIE fusion (19-feature vector) ────────────────
    signals_dict = {
        "s1": s1.payload, "s1_conf": s1.confidence,
        "s2": s2.payload,
        "s3": s3.payload if not s3.error else {}, "s3_conf": s3.confidence if not s3.error else 0.0,
        "s4": s4.payload if not s4.error else {}, "s4_conf": s4.confidence if not s4.error else 0.0,
        "s5": s5.payload,
        "s6": s6.payload,
        "s7": s7.payload,
        "s8": s8.payload, "s8_conf": s8.confidence,
        "s9": s9.payload if not s9.error else {}, "s9_conf": s9.confidence if not s9.error else 0.0,
        "s10": s10.payload,
        "s11": s11.payload if not s11.error else {}, "s11_conf": s11.confidence if not s11.error else 0.0,
        "s12": s12.payload if not s12.error else {}, "s12_conf": s12.confidence if not s12.error else 0.0,
        "s13": s13.payload if not s13.error else {}, "s13_conf": s13.confidence if not s13.error else 0.5,
    }
    features = extract_features(signals_dict)
    fused = fuse(features, manual_weight_g=req.weight_g)

    huid_verified  = fused["huid_verified"]
    point_karat    = fused["point_karat"]
    band_low_k     = fused["karat_lo"]
    band_high_k    = fused["karat_hi"]
    final_weight   = fused["final_weight_g"]
    weight_low     = fused["weight_lo_g"]
    weight_high    = fused["weight_hi_g"]
    value_inr      = fused["value_inr"]
    value_low_inr  = fused["value_lo_inr"]
    value_high_inr = fused["value_hi_inr"]
    cal_method     = fused["calibration_method"]

    # ── Phase 4: live IBJA price (falls back to ₹7,200/g mock) ──────────────
    ibja_meta        = price_metadata()
    live_value_per_g = price_for_karat(point_karat)
    live_value_inr   = final_weight   * live_value_per_g
    live_value_lo    = weight_low     * price_for_karat(band_low_k)
    live_value_hi    = weight_high    * price_for_karat(band_high_k)
    # Use live prices if they look reasonable (not zero), else keep fused values
    if live_value_inr > 0:
        value_inr, value_low_inr, value_high_inr = live_value_inr, live_value_lo, live_value_hi

    # RBI hard rules
    rbi = apply_rbi_rules(point_karat, final_weight, value_inr)

    # ── Improved Fraud Score (Gemini-weighted) ──────────────────────────────────
    solid_prob    = features["solid_probability_s7"]        # S7 Gemini
    audio_solid   = features["audio_solid_probability"]     # S11 Gemini
    tele_anomaly  = features["telemetry_anomaly_score"]
    catalog_match = features["catalog_match_score"]
    graph_anomaly = features["graph_anomaly_score"]
    specular_score = features["specular_metal_score"]

    # Gemini signals (S7 + S11) weighted higher as they directly detect fake/plated gold
    fraud_score = min(1.0, max(0.0,
        (1 - solid_prob)    * 0.35  +  # S7 Gemini: PRIMARY detector (up from 0.25)
        (1 - audio_solid)   * 0.25  +  # S11 Gemini: CORROBORATING (up from 0.15)
        specular_score      * 0.15  +  # S4: Metal signature support
        catalog_match       * 0.15  +  # S9: Downgraded (down from 0.25)
        tele_anomaly        * 0.05  +  # S10: Weak signal (down from 0.20)
        graph_anomaly       * 0.05     # S12: Edge case (down from 0.15)
    ))

    fraud_triggers = []
    if solid_prob < 0.5:    fraud_triggers.append("plated_metal_suspected")
    if audio_solid < 0.5 and not s11.error: fraud_triggers.append("acoustic_inconsistent")
    if specular_score < 0.35: fraud_triggers.append("non_gold_specular_signature")
    if catalog_match >= 0.85: fraud_triggers.append("catalog_stock_photo_match")
    if graph_anomaly >= 0.4:  fraud_triggers.append("cross_session_reuse_detected")

    # ── Improved Base Confidence (Weighted by Signal Importance) ──────────────────
    s1_conf = s1.confidence if not s1.error else 0.3
    s2_conf = s2.confidence if not s2.error else 0.3
    s3_conf = s3.confidence if not s3.error else 0.3
    s4_conf = s4.confidence if not s4.error else 0.0
    s5_conf = s5.confidence if not s5.error else 0.3
    s6_conf = s6.confidence if not s6.error else 0.3
    s7_conf = s7.confidence if not s7.error else 0.3
    s8_conf = s8.confidence if not s8.error else 0.3
    s9_conf = s9.confidence if not s9.error else 0.0
    s10_conf = s10.confidence if not s10.error else 0.0

    # Weighted confidence: Gemini signals (S3, S7) get highest weight
    base_conf = (
        s1_conf * 0.10 +   # HUID
        s2_conf * 0.08 +   # Hallmark quality
        s3_conf * 0.18 +   # Gemini Color → CRITICAL (drives karat)
        s4_conf * 0.10 +   # Specular
        s5_conf * 0.12 +   # Coin detection
        s6_conf * 0.12 +   # Weight estimation
        s7_conf * 0.15 +   # Gemini Plated/Solid → CRITICAL
        s8_conf * 0.07 +   # VLM
        s9_conf * 0.05 +   # Catalog
        s10_conf * 0.03    # Telemetry
    )

    # Penalty if critical Gemini signals are uncertain
    s3_s7_avg_conf = (s3_conf + s7_conf) / 2
    if s3_s7_avg_conf < 0.4:
        base_conf *= 0.70  # 30% reduction if Gemini very uncertain
    elif s3_s7_avg_conf < 0.6:
        base_conf *= 0.85  # 15% reduction if Gemini somewhat uncertain

    # S13 liveness: strong multiplier (if no selfie, neutral 0.5)
    liveness_mult = max(0.5, s13.confidence) if req.selfie and not s13.error else 1.0

    # ── Dynamic Fraud Penalty (Increases with fraud severity) ────────────────────
    if fraud_score < 0.1:
        fraud_penalty = fraud_score * 0.10
    elif fraud_score < 0.3:
        fraud_penalty = fraud_score * 0.25
    elif fraud_score < 0.6:
        fraud_penalty = fraud_score * 0.40
    else:
        fraud_penalty = fraud_score * 0.60

    confidence = max(0.0, min(1.0, base_conf * liveness_mult - fraud_penalty))

    routing = route_session(confidence, fraud_score, rbi["loan_inr"], huid_verified,
                            rbi_reject_reason=rbi.get("reject_reason"))

    # ── Phase 3: XAI ─────────────────────────────────────────────────────────
    shap_data = explain(features)
    shap_features = [SHAPFeature(feature=d["feature"], contribution=d["contribution"]) for d in shap_data]

    reasoning    = generate_reasoning(routing, confidence, lang=req.lang)
    counterfactual = generate_counterfactual(routing, huid_verified, confidence, lang=req.lang)
    gradcam_url  = await generate_gradcam_url(macro_url, req.session_id)

    asset_hashes = [hashlib.sha256(url.encode()).hexdigest()[:16] for url in req.frames]
    elapsed_ms   = int((time.time() - t_start) * 1000)
    logger.info(f"[{trace_id}] assess done routing={routing} confidence={confidence:.2f} "
                f"calibration={cal_method} elapsed={elapsed_ms}ms")

    result = AssessmentResult(
        session_id=req.session_id,
        timestamp_utc=datetime.now(timezone.utc),
        model_versions=ModelVersions(),
        purity=Purity(
            band_low_karat=band_low_k, band_high_karat=band_high_k,
            point_estimate_karat=point_karat, huid_verified=huid_verified,
        ),
        weight=Weight(
            manual_entry_g=req.weight_g, estimated_g=final_weight,
            band_low_g=weight_low, band_high_g=weight_high,
            method="hybrid" if req.weight_g else "depth_volume_x_density",
        ),
        value_inr=ValueINR(
            band_low=int(value_low_inr), band_high=int(value_high_inr),
            ibja_reference_date=datetime.now(timezone.utc),
            stone_weight_excluded_g=s8.payload.get("stones_estimated_carat_total", 0.0),
        ),
        loan_offer=LoanOffer(
            band_low_inr=int(value_low_inr  * rbi["ltv_pct"] / 100),
            band_high_inr=int(value_high_inr * rbi["ltv_pct"] / 100),
            ltv_applied_pct=rbi["ltv_pct"],
            tier=rbi["tier"],
        ),
        confidence=Confidence(
            score=round(confidence, 3),
            coverage_guarantee_pct=90,
            calibration_method=cal_method,
        ),
        fraud_signals=FraudSignals(score=round(fraud_score, 3), triggers=fraud_triggers),
        routing=routing,
        reasoning_text=ReasoningText(lang=req.lang, text=reasoning),
        xai=XAI(
            gradcam_url=gradcam_url,
            shap_top_features=shap_features,
            counterfactual=counterfactual,
        ),
        audit=AuditTrail(trace_id=trace_id, input_asset_hashes=asset_hashes),
        conformal_width_karat=float(band_high_k - band_low_k),
    )

    # Persist: upsert session record + write immutable audit log
    try:
        existing = await db.execute(select(SessionModel).where(SessionModel.id == req.session_id))
        session_row = existing.scalar_one_or_none()
        if not session_row:
            session_row = SessionModel(id=req.session_id, lang=req.lang, status="completed")
            db.add(session_row)
        else:
            session_row.status = "completed"
        audit_log = AuditLog(
            trace_id=trace_id,
            session_id=req.session_id,
            event_type="assessment_complete",
            payload=result.model_dump_json(),
        )
        db.add(audit_log)
        await db.commit()
    except Exception as e:
        logger.warning(f"[{trace_id}] audit log write failed (non-fatal): {e}")

    return result
