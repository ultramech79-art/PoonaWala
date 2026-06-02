import loanParams from '../data/loan_params.json'
import type { LocationTier } from './regionEngine'

export interface ROIComponent {
  name: string
  valuePct: number
}

export interface ROIResult {
  roiPaPct: number
  components: ROIComponent[]
}

export interface CibilTierInfo {
  label: string
  color: string
  description: string
  spread_adj_pct: number
}

/** Derive the CIBIL tier key from a raw score (or null = NTC). */
export function getCibilTierKey(score: number | null): string {
  if (score === null || score === 0) return 'NTC'
  const tiers = loanParams.cibil_tiers as Record<string, { min_score: number; max_score: number }>
  for (const [key, t] of Object.entries(tiers)) {
    if (key === 'NTC') continue
    if (score >= t.min_score && score <= t.max_score) return key
  }
  return 'NTC'
}

export function getCibilTierInfo(tierKey: string): CibilTierInfo {
  return (loanParams.cibil_tiers as Record<string, CibilTierInfo>)[tierKey] ?? (loanParams.cibil_tiers as Record<string, CibilTierInfo>)['NTC']
}

interface ROIOptions {
  /** Requested loan amount (₹) — drives the ticket-size adjustment. */
  loanAmountInr?: number
  /** Effective loan-to-value (%) of the requested amount — drives the LTV-risk premium. */
  ltvPct?: number
}

/**
 * Compute annual ROI (%) using the fully parametric formula:
 *   ROI = repo_rate + base_spread + cibil_adj + location_adj + tenure_adj
 *         + ltv_risk_adj + ticket_size_adj
 *
 * The repo rate is the live RBI policy rate (loan_params.base_rates, kept current
 * — 5.25% as of Jun 2026); the gold-loan spread absorbs the rest of pricing. Higher
 * LTV adds a risk premium and larger tickets earn a discount, so the rate reflects
 * the actual risk/size of THIS loan. Every coefficient comes from loan_params.json.
 */
export function computeROI(
  cibilTierKey: string,
  locationTier: LocationTier,
  tenureMonths: number,
  opts: ROIOptions = {},
): ROIResult {
  const { base_rates, cibil_tiers, location_adjusters, tenure_options } = loanParams
  const ltvAdjusters = (loanParams as { ltv_risk_adjusters?: Array<{ up_to_ltv_pct: number; roi_delta_pct: number; label: string }> }).ltv_risk_adjusters ?? []
  const ticketAdjusters = (loanParams as { ticket_size_adjusters?: Array<{ min_inr: number; roi_delta_pct: number; label: string }> }).ticket_size_adjusters ?? []

  const cibil = (cibil_tiers as Record<string, { label: string; spread_adj_pct: number }>)[cibilTierKey]
  const loc   = (location_adjusters as Record<string, { roi_delta_pct: number }>)[locationTier]
  const tenureAdj = (tenure_options.roi_adjustments as Record<string, number>)[String(tenureMonths)] ?? 0

  const repoRate  = base_rates.repo_rate_pct
  const spread    = base_rates.base_spread_pct
  const cibilAdj  = cibil?.spread_adj_pct ?? 0
  const locAdj    = loc?.roi_delta_pct ?? 0

  // LTV-risk premium: the higher the loan-to-value, the higher the risk → higher rate.
  const ltvBand = opts.ltvPct != null
    ? ltvAdjusters.find(b => opts.ltvPct! <= b.up_to_ltv_pct) ?? ltvAdjusters[ltvAdjusters.length - 1]
    : undefined
  const ltvAdj = ltvBand?.roi_delta_pct ?? 0

  // Ticket-size adjustment: larger loans earn a discount, small tickets a premium.
  const ticketBand = opts.loanAmountInr != null
    ? ticketAdjusters.find(b => opts.loanAmountInr! >= b.min_inr)
    : undefined
  const ticketAdj = ticketBand?.roi_delta_pct ?? 0

  const repoLabel = base_rates.repo_rate_as_of
    ? `RBI Repo Rate (${base_rates.repo_rate_as_of})`
    : 'RBI Repo Rate'

  const components: ROIComponent[] = [
    { name: repoLabel,                 valuePct: repoRate  },
    { name: 'Base Spread (Gold Loan)', valuePct: spread    },
  ]
  if (cibilAdj !== 0)  components.push({ name: `CIBIL — ${cibil?.label ?? cibilTierKey}`, valuePct: cibilAdj })
  if (locAdj   !== 0)  components.push({ name: `Branch location premium`,                 valuePct: locAdj   })
  if (tenureAdj !== 0) components.push({ name: `${tenureMonths}-month tenure`,            valuePct: tenureAdj })
  if (ltvAdj   !== 0)  components.push({ name: `${ltvBand?.label ?? 'LTV'} premium`,       valuePct: ltvAdj   })
  if (ticketAdj !== 0) components.push({ name: `${ticketBand?.label ?? 'Ticket size'}`,    valuePct: ticketAdj })

  // Clamp to Poonawalla's published gold-loan ROI band (11%–28% p.a.).
  const roiMin = (base_rates as { roi_min_pct?: number }).roi_min_pct ?? 11
  const roiMax = (base_rates as { roi_max_pct?: number }).roi_max_pct ?? 28
  const rawRoi = repoRate + spread + cibilAdj + locAdj + tenureAdj + ltvAdj + ticketAdj
  const roiPaPct = Math.round(Math.max(roiMin, Math.min(roiMax, rawRoi)) * 100) / 100

  return { roiPaPct, components }
}

/** Return available repayment types for a given tenure from config. */
export function getRepaymentTypes(tenureMonths: number): string[] {
  return (loanParams.tenure_options.available_repayment_types as Record<string, string[]>)[String(tenureMonths)] ?? ['emi']
}

export function getRepaymentLabel(type: string): string {
  return (loanParams.tenure_options.repayment_labels as Record<string, string>)[type] ?? type
}
