import loanParams from '../data/loan_params.json'

export interface LTVComponent {
  label: string
  deltaPct: number
  runningPct: number
}

export interface LTVResult {
  finalLtvPct: number
  provisionalLowLtvPct: number
  maxLoanInr: number
  provisionalLowLoanInr: number
  components: LTVComponent[]
  provisionalComponents: LTVComponent[]
  ticketTierLabel: string
}

export interface LTVInput {
  goldValueInr: number
  karatEstimate: number
  aiConfidence: number
  goldType: 'jewelry' | 'coin' | 'bar'
  hallmarkVisible: boolean
  weightVerified: boolean
}

/**
 * Computes eligible LTV based purely on gold collateral quality.
 *
 * Factors (all from loan_params.json):
 *   1. RBI ceiling: 75%
 *   2. Ticket tier cap (large loans have lower LTV)
 *   3. Low AI confidence: -10% or -5%
 *   4. Coin / bar: +2% (more liquid, easier to auction)
 *
 * Purity is already reflected in goldValueInr through 24K/22K/18K pricing.
 * Accepted 18K jewellery should not receive another LTV haircut for purity.
 * Hallmark/HUID visibility is not an LTV factor in the provisional offer.
 * Poonawalla states gold purity, gold value, and LTV as the basis; missing
 * hallmark in an image means physical verification is pending, not lower gold quality.
 * Missing digital proof only lowers the provisional floor; the upper bound remains
 * available subject to agent/branch verification.
 * CIBIL score does NOT affect LTV — this is a secured gold loan.
 * Location does NOT affect LTV — collateral value is independent of where the borrower lives.
 */
export function computeLTV(input: LTVInput): LTVResult {
  const { rbi_rules, ticket_tiers, ltv_adjusters } = loanParams
  const components: LTVComponent[] = []
  const provisionalComponents: LTVComponent[] = []

  // 1. Start at RBI ceiling
  let running = rbi_rules.max_ltv_pct
  components.push({ label: 'RBI maximum (Master Direction 2023-24)', deltaPct: 0, runningPct: running })

  // 2. Ticket-tier cap — larger loans carry stricter LTV
  const ticketAtMax = input.goldValueInr * (rbi_rules.max_ltv_pct / 100)
  const tier = ticket_tiers.find(t => ticketAtMax <= t.max_inr) ?? ticket_tiers[ticket_tiers.length - 1]
  if (tier.max_ltv_pct < running) {
    const delta = tier.max_ltv_pct - running
    running = tier.max_ltv_pct
    components.push({ label: `Ticket tier cap (${tier.description})`, deltaPct: delta, runningPct: running })
  }

  // 3. AI vision confidence penalty
  if (input.aiConfidence < 0.55) {
    const delta = ltv_adjusters.ai_confidence_below_55_delta_pct
    running += delta
    components.push({ label: 'AI assessment confidence < 55%', deltaPct: delta, runningPct: running })
  } else if (input.aiConfidence < 0.70) {
    const delta = ltv_adjusters.ai_confidence_55_to_70_delta_pct
    running += delta
    components.push({ label: 'AI assessment confidence 55–70%', deltaPct: delta, runningPct: running })
  }

  // 4. Coin / bar — standardised weight and purity, higher liquidity on auction
  if (input.goldType === 'coin' || input.goldType === 'bar') {
    const delta = ltv_adjusters.coin_or_bar_bonus_pct
    running += delta
    components.push({ label: 'Standardised coin / bar (higher liquidity)', deltaPct: delta, runningPct: running })
  }

  // Clamp
  const finalLtv = Math.max(ltv_adjusters.ltv_floor_pct, Math.min(ltv_adjusters.ltv_ceiling_pct, running))
  let provisionalLow = finalLtv

  if (!input.hallmarkVisible) {
    const delta = ltv_adjusters.hallmark_pending_low_delta_pct
    provisionalLow += delta
    provisionalComponents.push({
      label: 'Hallmark/HUID not visible digitally; can increase after agent verification',
      deltaPct: delta,
      runningPct: provisionalLow,
    })
  }

  if (!input.weightVerified) {
    const delta = ltv_adjusters.weight_pending_low_delta_pct
    provisionalLow += delta
    provisionalComponents.push({
      label: 'Net weight not backed by bill/certificate; can increase after physical weighing',
      deltaPct: delta,
      runningPct: provisionalLow,
    })
  }

  provisionalLow = Math.max(ltv_adjusters.ltv_floor_pct, Math.min(finalLtv, provisionalLow))

  const maxLoanInr = Math.floor((input.goldValueInr * finalLtv / 100) / 1000) * 1000
  const provisionalLowLoanInr = Math.floor((input.goldValueInr * provisionalLow / 100) / 1000) * 1000

  return {
    finalLtvPct: Math.round(finalLtv * 10) / 10,
    provisionalLowLtvPct: Math.round(provisionalLow * 10) / 10,
    maxLoanInr,
    provisionalLowLoanInr,
    components,
    provisionalComponents,
    ticketTierLabel: tier.label,
  }
}
