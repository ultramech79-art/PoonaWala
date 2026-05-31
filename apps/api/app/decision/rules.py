"""
RBI hard rules for gold loan pre-qualification (FR-DEC-01).

Regulatory basis:
  - RBI "Lending Against Gold & Silver Collateral" Directions, 2025 (effective 1 Apr 2026)
  - Tiered LTV by sanctioned loan amount:
        Up to ₹2.5L  → 85%
        ₹2.5L – ₹5L → 80%
        Above ₹5L    → 75%
    LTV must hold through the loan life (interest accrual cannot push it over the cap).
  - Minimum purity: 18 karat (below this, the item is not eligible as gold collateral)
  - Stone/gem weight excluded before valuation (mandatory — handled by S5 upstream)
  - Pledge limit: 1 kg gold ornaments per borrower (gold coins 50 g)

Aligned with Poonawalla Fincorp's gold-loan page (up to 85% LTV) and the frontend
ltvEngine / loan_params.json so the preview, final evaluation and backend agree.
"""

# Tiered LTV: (ceiling_fraction, bracket_top_inr, tier_key)
LTV_TIERS = [
    (0.85, 250_000, "under_2_5L"),
    (0.80, 500_000, "2_5L_to_5L"),
    (0.75, float("inf"), "above_5L"),
]


def apply_rbi_rules(purity_karat: int, weight_g: float, value_inr: float) -> dict:
    """
    Returns RBI-compliant LTV percentage, loan amount, tier, and optional reject reason.

    Valuation formula (applied upstream in assess.py):
      value_inr = net_weight_g × (karat / 24) × price_24k_per_g
    This function applies the tiered LTV gate on top of that value.
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

    # ── Tiered LTV — largest self-consistent loan ────────────────────────────
    # Ceiling and loan amount are mutually dependent (a bigger loan crosses into a
    # stricter tier), so take the maximum loan that never exceeds its own tier cap:
    # for each tier, the loan is the cap applied to the value, clamped to the
    # bracket top (the ₹2.5L / ₹5L plateau).
    best_loan = 0.0
    best_ltv = LTV_TIERS[-1][0]
    best_tier = LTV_TIERS[-1][2]
    for ltv, bracket_top, tier_key in LTV_TIERS:
        loan = min(value_inr * ltv, bracket_top)
        if loan > best_loan:
            best_loan = loan
            best_ltv = ltv
            best_tier = tier_key

    return {
        "reject_reason": None,
        "ltv_pct": int(round(best_ltv * 100)),
        "loan_inr": round(best_loan, 2),
        "tier": best_tier,
    }
