"""
RBI 2023-24 hard rules for gold loan pre-qualification (FR-DEC-01).

Regulatory basis:
  - RBI Master Direction on Gold Loans (updated Jan 2024, circular RBI/2023-24/107)
  - Max LTV: 75% for personal gold loans from NBFCs/banks
    (the COVID-era 90% relaxation ended Mar 2021; 85% was never a standing rule)
  - Minimum purity: 18 karat (below this, item is not eligible as gold collateral)
  - Stone/gem weight excluded before valuation (mandatory per RBI — handled by S5 upstream)
  - Weight cap: 1 kg per applicant (Poonawalla internal policy, not statutory)

Tiered LTV (internal risk policy, within 75% RBI ceiling):
  Under ₹2.5L ticket  → 75%   (small-ticket, retail; lowest concentration risk)
  ₹2.5L – ₹5L ticket → 72%   (medium-ticket; moderate documentation required)
  Above ₹5L ticket    → 70%   (large-ticket; full KYC + income proof required)
"""


def apply_rbi_rules(purity_karat: int, weight_g: float, value_inr: float) -> dict:
    """
    Returns RBI-compliant LTV percentage, loan amount, tier, and optional reject reason.

    Valuation formula (applied upstream in assess.py):
      value_inr = net_weight_g × (karat / 24) × price_24k_per_g
    This function only applies the LTV gate on top of that value.
    """

    # ── Gate 1: minimum purity ─────────────────────────────────────────────────
    # RBI: gold below 18K is not acceptable as collateral for gold loans.
    if purity_karat < 18:
        return {
            "reject_reason": "below_minimum_purity_18k",
            "ltv_pct": 0,
            "loan_inr": 0.0,
            "tier": "rejected",
        }

    # ── Gate 2: per-applicant weight cap ─────────────────────────────────────
    if weight_g > 1000:
        return {
            "reject_reason": "exceeds_1kg_per_applicant",
            "ltv_pct": 75,
            "loan_inr": 0.0,
            "tier": "above_5L",
        }

    # ── Tiered LTV (within RBI 75% ceiling) ──────────────────────────────────
    # Ticket size is loan amount at maximum 75% LTV — determines which tier applies.
    ticket_at_max = value_inr * 0.75

    if ticket_at_max < 250_000:      # under ₹2.5L
        ltv  = 0.75
        tier = "under_2_5L"
    elif ticket_at_max < 500_000:    # ₹2.5L – ₹5L
        ltv  = 0.72
        tier = "2_5L_to_5L"
    else:                             # above ₹5L
        ltv  = 0.70
        tier = "above_5L"

    loan_inr = value_inr * ltv
    return {
        "reject_reason": None,
        "ltv_pct": int(ltv * 100),
        "loan_inr": round(loan_inr, 2),
        "tier": tier,
    }
