from __future__ import annotations
from typing import Optional, Union
"""
ML-layer routing decision (FR-DEC-02).
Two-layer evaluation: RBI hard rules → ML confidence routing.

Buckets (PRD §9.1):
  INSTANT  — confidence > 0.85, fraud < 0.05, loan < ₹50k, HUID verified
  AGENT    — confidence 0.60–0.85, or large loan, or HUID missing but otherwise clean
  RECAPTURE — any signal returned low quality with recoverable cause
  REJECT   — fraud > 0.7, or confidence < 0.4
"""


def route_session(
    confidence: float,
    fraud_score: float,
    loan_inr: float,
    huid_verified: bool,
    rbi_reject_reason: Optional[str] = None,
) -> str:
    # Hard reject conditions (RBI rules)
    if rbi_reject_reason:
        return "REJECT"

    # Explicit fraud reject (improved thresholds)
    if fraud_score > 0.40:
        # NEW: Explicit reject for high fraud (up from 0.7)
        return "REJECT"
    if confidence < 0.4:
        return "REJECT"

    # INSTANT approval (stricter: confidence > 0.80, fraud < 0.05)
    if (confidence >= 0.80 and
        fraud_score < 0.05 and
        loan_inr < 50_000 and
        huid_verified):
        return "INSTANT"

    # AGENT review (stricter: confidence > 0.65)
    if confidence >= 0.65 and fraud_score < 0.15:
        return "AGENT"

    # Default: RECAPTURE for images requiring review
    return "RECAPTURE"
