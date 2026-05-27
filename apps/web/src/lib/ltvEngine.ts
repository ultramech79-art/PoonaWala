import loanParams from '../data/loan_params.json'

export interface LTVComponent {
  label: string
  deltaPct: number
  runningPct: number
}

export interface LTVResult {
  finalLtvPct: number
  maxLoanInr: number
  components: LTVComponent[]
  ticketTierLabel: string
}

export interface LTVInput {
  goldValueInr: number
  karatEstimate: number
  huidVerified: boolean
  aiConfidence: number
  goldType: 'jewelry' | 'coin' | 'bar'
}

/**
 * Computes eligible LTV based purely on gold collateral quality.
 *
 * Factors (all from loan_params.json):
 *   1. RBI ceiling: 75%
 *   2. Ticket tier cap (large loans have lower LTV)
 *   3. No BIS hallmark: -5% (lender cannot verify purity)
 *   4. Purity 18–20K: -3% (below 22K standard)
 *   5. Low AI confidence: -8% or -4%
 *   6. Coin / bar: +2% (more liquid, easier to auction)
 *
 * CIBIL score does NOT affect LTV — this is a secured gold loan.
 * Location does NOT affect LTV — collateral value is independent of where the borrower lives.
 */
export function computeLTV(input: LTVInput): LTVResult {
  const { rbi_rules, ticket_tiers, ltv_adjusters } = loanParams
  const components: LTVComponent[] = []

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

  // 3. BIS hallmark — unverified gold cannot be confidently graded
  if (!input.huidVerified) {
    const delta = ltv_adjusters.no_bis_hallmark_delta_pct
    running += delta
    components.push({ label: 'No BIS hallmark — purity unverified', deltaPct: delta, runningPct: running })
  }

  // 4. Purity below 22K (still ≥ 18K; below 18K is blocked by RBI)
  if (input.karatEstimate >= rbi_rules.min_purity_karat && input.karatEstimate < 20) {
    const delta = ltv_adjusters.purity_18k_to_20k_delta_pct
    running += delta
    components.push({ label: `Purity ${input.karatEstimate}K (18K – 20K range)`, deltaPct: delta, runningPct: running })
  }

  // 5. AI vision confidence penalty
  if (input.aiConfidence < 0.55) {
    const delta = ltv_adjusters.ai_confidence_below_55_delta_pct
    running += delta
    components.push({ label: 'AI assessment confidence < 55%', deltaPct: delta, runningPct: running })
  } else if (input.aiConfidence < 0.70) {
    const delta = ltv_adjusters.ai_confidence_55_to_70_delta_pct
    running += delta
    components.push({ label: 'AI assessment confidence 55–70%', deltaPct: delta, runningPct: running })
  }

  // 6. Coin / bar — standardised weight and purity, higher liquidity on auction
  if (input.goldType === 'coin' || input.goldType === 'bar') {
    const delta = ltv_adjusters.coin_or_bar_bonus_pct
    running += delta
    components.push({ label: 'Standardised coin / bar (higher liquidity)', deltaPct: delta, runningPct: running })
  }

  // Clamp
  const finalLtv = Math.max(ltv_adjusters.ltv_floor_pct, Math.min(ltv_adjusters.ltv_ceiling_pct, running))
  const maxLoanInr = Math.round((input.goldValueInr * finalLtv / 100) / 1000) * 1000

  return {
    finalLtvPct: Math.round(finalLtv * 10) / 10,
    maxLoanInr,
    components,
    ticketTierLabel: tier.label,
  }
}
