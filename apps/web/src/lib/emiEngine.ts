export type RepaymentType = 'emi' | 'interest_only' | 'bullet'

export interface AmortizationRow {
  month: number
  openingBalance: number
  payment: number
  principal: number
  interest: number
  closingBalance: number
}

export interface EMIResult {
  repaymentType: RepaymentType
  monthlyPayment: number    // regular monthly payment (0 for bullet)
  bulletPayment: number     // lump-sum due at end (principal + accrued interest)
  totalPayment: number
  totalInterest: number
  schedule: AmortizationRow[]
}

/**
 * Standard reducing-balance EMI (most common NBFC gold loan structure).
 * EMI = P × r(1+r)^n / ((1+r)^n - 1)
 */
export function computeReducingEMI(
  principal: number,
  roiPaPct: number,
  tenureMonths: number,
): EMIResult {
  const r = roiPaPct / 100 / 12
  const n = tenureMonths
  const emi = principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)

  const schedule: AmortizationRow[] = []
  let balance = principal

  for (let i = 1; i <= n; i++) {
    const interest  = balance * r
    const princ     = emi - interest
    const closing   = Math.max(0, balance - princ)
    schedule.push({
      month: i,
      openingBalance: Math.round(balance),
      payment: Math.round(emi),
      principal: Math.round(princ),
      interest: Math.round(interest),
      closingBalance: Math.round(closing),
    })
    balance = closing
  }

  const totalPayment = Math.round(emi * n)
  return {
    repaymentType: 'emi',
    monthlyPayment: Math.round(emi),
    bulletPayment: 0,
    totalPayment,
    totalInterest: totalPayment - principal,
    schedule,
  }
}

/**
 * Interest-only monthly payments + principal bullet at end.
 * Common in Muthoot/Manappuram gold loan variants.
 */
export function computeInterestOnly(
  principal: number,
  roiPaPct: number,
  tenureMonths: number,
): EMIResult {
  const r = roiPaPct / 100 / 12
  const monthlyInterest = Math.round(principal * r)

  const schedule: AmortizationRow[] = []
  for (let i = 1; i <= tenureMonths; i++) {
    const isFinal = i === tenureMonths
    schedule.push({
      month: i,
      openingBalance: principal,
      payment: isFinal ? principal + monthlyInterest : monthlyInterest,
      principal: isFinal ? principal : 0,
      interest: monthlyInterest,
      closingBalance: isFinal ? 0 : principal,
    })
  }

  const totalInterest = monthlyInterest * tenureMonths
  return {
    repaymentType: 'interest_only',
    monthlyPayment: monthlyInterest,
    bulletPayment: principal,
    totalPayment: principal + totalInterest,
    totalInterest,
    schedule,
  }
}

/**
 * Pure bullet — nothing during tenure, everything at end.
 * RBI caps this at 12 months for NBFCs.
 */
export function computeBullet(
  principal: number,
  roiPaPct: number,
  tenureMonths: number,
): EMIResult {
  const totalInterest = Math.round(principal * roiPaPct / 100 * tenureMonths / 12)
  const bulletAmount  = principal + totalInterest

  return {
    repaymentType: 'bullet',
    monthlyPayment: 0,
    bulletPayment: bulletAmount,
    totalPayment: bulletAmount,
    totalInterest,
    schedule: [{
      month: tenureMonths,
      openingBalance: principal,
      payment: bulletAmount,
      principal,
      interest: totalInterest,
      closingBalance: 0,
    }],
  }
}

export function computeEMI(
  principal: number,
  roiPaPct: number,
  tenureMonths: number,
  type: RepaymentType,
): EMIResult {
  if (type === 'bullet')        return computeBullet(principal, roiPaPct, tenureMonths)
  if (type === 'interest_only') return computeInterestOnly(principal, roiPaPct, tenureMonths)
  return computeReducingEMI(principal, roiPaPct, tenureMonths)
}
