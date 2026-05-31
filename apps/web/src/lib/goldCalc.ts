import loanParams from '../data/loan_params.json'

/**
 * RBI-standard gold valuation helpers.
 *
 * Banking formula:
 *   net_value_inr = net_weight_g × (karat / 24) × price_24k_per_g
 *   where net_weight_g = gross_weight_g − stone_weight_g
 *
 * LTV (Loan-to-Value) per the RBI 2025 tiered ceiling (effective 1 Apr 2026):
 *   Small ticket (≤₹2.5L): 85%
 *   Medium (₹2.5L–₹5L):   80%
 *   Large (>₹5L):          75%
 */

export const TROY_OZ_TO_GRAMS = 31.1035  // fixed physical constant

/** Convert metalpriceapi (base=USD) rates to INR per gram for 24K gold. */
export function metalpriceapiToInrPerGram(xauRatePerUsd: number, inrPerUsd: number): number {
  // xauRatePerUsd = XAU per 1 USD = 1/gold_price_usd
  // inrPerUsd = INR per 1 USD
  // INR per gram = (INR per USD ÷ XAU per USD) ÷ grams per oz
  //             = (USD per XAU × INR per USD) ÷ grams per oz
  return (inrPerUsd / xauRatePerUsd) / TROY_OZ_TO_GRAMS
}

export interface GoldValueBand {
  band_low: number
  band_high: number
}

/**
 * Compute gold market value band using the karat-specific price per gram.
 * Pass the live price for the detected karat directly (e.g. livePrice22K for 22K gold).
 * ±7% band matches banking confidence interval for valuation.
 */
export function computeGoldMarketValue(
  pricePerGramAtKarat: number,
  weightG: number,
  _karatEstimate: number,
  stoneExclusionG: number
): GoldValueBand {
  const netWeight = Math.max(weightG - stoneExclusionG, weightG * 0.94)
  const mid = pricePerGramAtKarat * netWeight
  return {
    band_low:  Math.round((mid * 0.93) / 100) * 100,
    band_high: Math.round((mid * 1.07) / 100) * 100,
  }
}

export interface LoanOffer {
  band_low_inr: number
  band_high_inr: number
  ltv_applied_pct: number
  tier: 'under_2_5L' | '2_5L_to_5L' | 'above_5L'
}

/**
 * Indicative pre-assessment loan range using the RBI 2025 tiered LTV ceiling.
 * The headline is the tier ceiling (85 / 80 / 75); the low edge sits 10 points
 * below it as a conservative provisional estimate. The Final Evaluation refines
 * the exact provisional LTV from the assessment confidence (see ltvEngine).
 */
export function computeLoanOffer(goldValue: GoldValueBand): LoanOffer {
  const tiers = loanParams.rbi_rules.ltv_tiers
  const ceilingPct =
    goldValue.band_high * (tiers[0].max_ltv_pct / 100) <= tiers[0].max_inr ? tiers[0].max_ltv_pct :
    goldValue.band_high * (tiers[1].max_ltv_pct / 100) <= tiers[1].max_inr ? tiers[1].max_ltv_pct :
    tiers[2].max_ltv_pct

  const tier: LoanOffer['tier'] =
    ceilingPct >= 85 ? 'under_2_5L' :
    ceilingPct >= 80 ? '2_5L_to_5L' :
    'above_5L'

  const ltvHigh = ceilingPct / 100
  const ltvLow = Math.max(loanParams.ltv_adjusters.ltv_floor_pct, ceilingPct - 10) / 100

  return {
    band_low_inr:   Math.round((goldValue.band_low  * ltvLow)  / 1000) * 1000,
    band_high_inr:  Math.round((goldValue.band_high * ltvHigh) / 1000) * 1000,
    ltv_applied_pct: ceilingPct,
    tier,
  }
}
