import loanParams from '../data/loan_params.json'

export interface LTVResult {
  /** Final LTV (%) reachable after agent/branch physical verification = the full RBI tier ceiling. */
  finalLtvPct: number
  /** Nominal RBI tier cap for this ticket (85 / 80 / 75) before the boundary plateau. */
  tierCeilingPct: number
  /** Provisional (offered-now) LTV (%), scaled by the assessment confidence between the floor and the ceiling. */
  provisionalLowLtvPct: number
  /** Confidence factor f ∈ [0,1] that drives the provisional LTV up the curve. */
  confidenceFactor: number
  /** Max loan (₹) at the final LTV, rounded to ₹1,000. */
  maxLoanInr: number
  /** Provisional loan (₹) at the provisional LTV, rounded to ₹1,000. */
  provisionalLowLoanInr: number
  ticketTierLabel: string
  ticketTierDescription: string
  /** Whether the assessment cleared the acceptance cutoff (else no offer). */
  eligible: boolean
}

export interface LTVInput {
  goldValueInr: number
  /** Gaurang's evidence-based assessment confidence (0..1). Already encodes HUID / hallmark / photo / purity / weight / bill / video. */
  confidence: number
  goldType: 'jewelry' | 'coin' | 'bar'
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const roundToThousand = (v: number) => Math.floor(v / 1000) * 1000

interface LtvTier {
  label: string
  description: string
  max_inr: number
  max_ltv_pct: number
}

/**
 * Resolve the largest self-consistent loan against the RBI tiered LTV caps.
 *
 * The ceiling and the loan amount are mutually dependent (a bigger loan crosses
 * into a stricter tier), so we take the maximum loan L such that L never exceeds
 * its own tier's cap: for each tier, L is either the cap applied to the gold value
 * (if it fits the bracket) or the bracket's top (the ₹2.5L / ₹5L plateau).
 */
function resolveTierCeiling(goldValueInr: number, tiers: LtvTier[]) {
  let bestLoan = 0
  let bestTier = tiers[tiers.length - 1]

  for (const tier of tiers) {
    const loanAtCap = goldValueInr * (tier.max_ltv_pct / 100)
    const loan = Math.min(loanAtCap, tier.max_inr) // clamp to the bracket top
    if (loan > bestLoan) {
      bestLoan = loan
      bestTier = tier
    }
  }

  const effectiveCeilingPct = goldValueInr > 0 ? (bestLoan / goldValueInr) * 100 : 0
  return { maxLoanInr: bestLoan, tierCeilingPct: bestTier.max_ltv_pct, effectiveCeilingPct, tier: bestTier }
}

/**
 * Computes the offered LTV for a gold-loan assessment.
 *
 * Two LTV numbers per offer:
 *   • Final LTV  = the RBI tier ceiling (85% ≤₹2.5L · 80% ≤₹5L · 75% above) — reachable
 *                  after agent/branch physical verification removes collateral uncertainty.
 *   • Provisional LTV (offered now) = scaled by the assessment confidence:
 *
 *        ┌─────────────────────────────────────────────┐
 *        │  LTV = floor + (ceiling − floor) × f         │   (the one core formula)
 *        │  f   = (confidence − cutoff) / (anchor − cutoff)   clamped to [0,1]
 *        └─────────────────────────────────────────────┘
 *
 * floor = 60%, ceiling = the resolved tier ceiling, cutoff = 0.47 (acceptance),
 * anchor = 0.90 (full trust). Below the cutoff the assessment is not eligible.
 *
 * The confidence score already encodes HUID / hallmark / photo / purity / weight /
 * bill / video evidence, so LTV does NOT re-penalise those. CIBIL and location do
 * NOT affect LTV — this is a secured gold loan; they only adjust the interest rate.
 */
export function computeLTV(input: LTVInput): LTVResult {
  const { rbi_rules, ltv_adjusters } = loanParams
  const tiers = rbi_rules.ltv_tiers as LtvTier[]

  const cutoff = ltv_adjusters.confidence_acceptance_cutoff
  const anchor = ltv_adjusters.confidence_full_trust_anchor
  const floor = ltv_adjusters.ltv_floor_pct

  const { maxLoanInr, tierCeilingPct, effectiveCeilingPct, tier } =
    resolveTierCeiling(input.goldValueInr, tiers)
  const finalLtvPct = Math.round(effectiveCeilingPct * 10) / 10

  // The one core formula: confidence factor → provisional LTV.
  const confidenceFactor = clamp((input.confidence - cutoff) / (anchor - cutoff), 0, 1)
  let provisional = floor + (effectiveCeilingPct - floor) * confidenceFactor

  // Coin / bar — standardised weight & purity, more liquid on auction.
  if (input.goldType === 'coin' || input.goldType === 'bar') {
    provisional += ltv_adjusters.coin_or_bar_bonus_pct
  }
  provisional = clamp(provisional, floor, effectiveCeilingPct)

  return {
    finalLtvPct,
    tierCeilingPct,
    provisionalLowLtvPct: Math.round(provisional * 10) / 10,
    confidenceFactor: Math.round(confidenceFactor * 100) / 100,
    maxLoanInr: roundToThousand(maxLoanInr),
    provisionalLowLoanInr: roundToThousand(input.goldValueInr * provisional / 100),
    ticketTierLabel: tier.label,
    ticketTierDescription: tier.description,
    eligible: input.confidence >= cutoff,
  }
}
