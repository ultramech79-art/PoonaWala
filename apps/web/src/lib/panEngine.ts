import loanParams from '../data/loan_params.json'

const ENTITY_MAP: Record<string, string> = {
  P: 'Individual',
  C: 'Company',
  H: 'Hindu Undivided Family (HUF)',
  F: 'Firm / Partnership',
  A: 'Association of Persons',
  T: 'Trust',
  B: 'Body of Individuals',
  L: 'LLP',
  J: 'Artificial Juridical Person',
  G: 'Government Entity',
}

export interface PANValidation {
  valid: boolean
  entityType: string | null
  reason: string | null
  maskedPan: string | null
}

export interface PANKYCStatus {
  panRequired: boolean
  enhancedDDRequired: boolean
  form60Acceptable: boolean
}

/** Validates PAN format only (no API call — real verification needs NSDL sandbox in production). */
export function validatePAN(pan: string): PANValidation {
  const upper = pan.toUpperCase().trim()

  if (!upper) return { valid: false, entityType: null, reason: null, maskedPan: null }

  if (upper.length !== 10)
    return { valid: false, entityType: null, reason: 'Must be exactly 10 characters', maskedPan: null }

  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(upper))
    return { valid: false, entityType: null, reason: 'Format: ABCDE1234F (5 letters · 4 digits · 1 letter)', maskedPan: null }

  const entityType = ENTITY_MAP[upper[3]] ?? 'Other'
  const maskedPan  = `${upper.slice(0, 2)}XXX${upper.slice(5, 9)}${upper[9]}`

  return { valid: true, entityType, reason: null, maskedPan }
}

/**
 * Derives a deterministic mock CIBIL score from a valid individual PAN.
 * Same PAN always yields the same score (seed = numeric portion chars 5-8).
 * Returns null for non-individual PAN (entity type ≠ P) or invalid PAN.
 * In production this would be replaced by a real bureau API call.
 */
export function deriveScoreFromPAN(pan: string): number | null {
  const v = validatePAN(pan)
  if (!v.valid) return null
  // Only individuals (4th char = P) get a score; others treated as NTC
  if (pan[3].toUpperCase() !== 'P') return null
  const seed = parseInt(pan.slice(5, 9))    // 4-digit number 0–9999
  return 650 + Math.round((seed / 9999) * 150)  // deterministic range 650–800
}

/**
 * Returns KYC requirements based on loan amount thresholds from loan_params.json.
 * PMLA 2002 + RBI KYC Master Direction.
 */
export function getPANKYCStatus(estimatedLoanInr: number): PANKYCStatus {
  const { rbi_rules } = loanParams
  return {
    panRequired:        estimatedLoanInr >= rbi_rules.pan_mandatory_above_inr,
    enhancedDDRequired: estimatedLoanInr >= rbi_rules.pmla_enhanced_dd_above_inr,
    form60Acceptable:   estimatedLoanInr < rbi_rules.pmla_enhanced_dd_above_inr,
  }
}
