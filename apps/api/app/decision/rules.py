"""
RBI 2025 hard rules for gold loan pre-qualification (FR-DEC-01).
These are compliance gates — they override ML routing if triggered.
"""


def apply_rbi_rules(purity_karat: int, weight_g: float, value_inr: float) -> dict:
    """
    Returns RBI-compliant LTV, loan amount, tier, and optional reject reason.
    Stones excluded — already separated upstream by S5 segmentation.

    RBI 2025:
    - Per-applicant gold cap: 1 kg
    - LTV: 85% for loans where value×0.75 < ₹2.5L, else 75%
    """
    if weight_g > 1000:
        return {
            "reject_reason": "exceeds_1kg_per_applicant",
            "ltv_pct": 75,
            "loan_inr": 0.0,
            "tier": "above_2_5L",
        }

    ltv = 0.85 if value_inr * 0.75 < 250_000 else 0.75
    loan_inr = value_inr * ltv
    return {
        "reject_reason": None,
        "ltv_pct": int(ltv * 100),
        "loan_inr": loan_inr,
        "tier": "under_2_5L" if loan_inr < 250_000 else "above_2_5L",
    }
