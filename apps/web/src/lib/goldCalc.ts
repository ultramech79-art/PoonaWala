/**
 * RBI-standard gold valuation helpers.
 *
 * Banking formula (RBI Master Direction on Gold Loans, 2023-24):
 *   net_value_inr = net_weight_g × (karat / 24) × price_24k_per_g
 *   where net_weight_g = gross_weight_g − stone_weight_g
 *
 * LTV (Loan-to-Value) per RBI cap (75% max):
 *   Small ticket (<₹2.5L): 75%
 *   Medium (₹2.5L–₹5L):   72%
 *   Large (>₹5L):          70%
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

/** RBI 2023-24 tiered LTV within the 75% regulatory ceiling. */
export function computeLoanOffer(goldValue: GoldValueBand): LoanOffer {
  const ticketAtMax = goldValue.band_high * 0.75
  let ltvLow: number, ltvHigh: number
  let tier: LoanOffer['tier']

  if (ticketAtMax < 250_000) {
    ltvLow = 0.65; ltvHigh = 0.75; tier = 'under_2_5L'
  } else if (ticketAtMax < 500_000) {
    ltvLow = 0.62; ltvHigh = 0.72; tier = '2_5L_to_5L'
  } else {
    ltvLow = 0.60; ltvHigh = 0.70; tier = 'above_5L'
  }

  return {
    band_low_inr:   Math.round((goldValue.band_low  * ltvLow)  / 1000) * 1000,
    band_high_inr:  Math.round((goldValue.band_high * ltvHigh) / 1000) * 1000,
    ltv_applied_pct: Math.round(ltvHigh * 100),
    tier,
  }
}
