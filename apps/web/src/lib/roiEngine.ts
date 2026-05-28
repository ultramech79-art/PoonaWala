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
  processing_fee_pct: number
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

/**
 * Compute annual ROI (%) using the fully parametric formula:
 *   ROI = repo_rate + base_spread + cibil_adj + location_adj + tenure_adj
 * Every coefficient comes from loan_params.json — zero hardcoding here.
 */
export function computeROI(
  cibilTierKey: string,
  locationTier: LocationTier,
  tenureMonths: number,
): ROIResult {
  const { base_rates, cibil_tiers, location_adjusters, tenure_options } = loanParams

  const cibil = (cibil_tiers as Record<string, { label: string; spread_adj_pct: number }>)[cibilTierKey]
  const loc   = (location_adjusters as Record<string, { roi_delta_pct: number }>)[locationTier]
  const tenureAdj = (tenure_options.roi_adjustments as Record<string, number>)[String(tenureMonths)] ?? 0

  const repoRate  = base_rates.repo_rate_pct
  const spread    = base_rates.base_spread_pct
  const cibilAdj  = cibil?.spread_adj_pct ?? 0
  const locAdj    = loc?.roi_delta_pct ?? 0

  const components: ROIComponent[] = [
    { name: 'RBI Repo Rate',           valuePct: repoRate  },
    { name: 'Base Spread (Gold Loan)', valuePct: spread    },
  ]
  if (cibilAdj !== 0) components.push({ name: `CIBIL — ${cibil?.label ?? cibilTierKey}`, valuePct: cibilAdj })
  if (locAdj   !== 0) components.push({ name: `Branch location premium`,                  valuePct: locAdj   })
  if (tenureAdj !== 0) components.push({ name: `${tenureMonths}-month tenure`,             valuePct: tenureAdj })

  const roiPaPct = Math.round((repoRate + spread + cibilAdj + locAdj + tenureAdj) * 100) / 100

  return { roiPaPct, components }
}

/** Return available repayment types for a given tenure from config. */
export function getRepaymentTypes(tenureMonths: number): string[] {
  return (loanParams.tenure_options.available_repayment_types as Record<string, string[]>)[String(tenureMonths)] ?? ['emi']
}

export function getRepaymentLabel(type: string): string {
  return (loanParams.tenure_options.repayment_labels as Record<string, string>)[type] ?? type
}
