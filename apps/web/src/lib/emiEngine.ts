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

const toRupee = (value: number) => Math.round(Number.isFinite(value) ? value : 0)
const normalizeMonths = (months: number) => Math.max(1, Math.round(months))
const sumRows = (rows: AmortizationRow[], key: 'payment' | 'principal' | 'interest') =>
  rows.reduce((total, row) => total + row[key], 0)

/**
 * Standard reducing-balance EMI (most common NBFC gold loan structure).
 * EMI = P × r(1+r)^n / ((1+r)^n - 1)
 */
export function computeReducingEMI(
  principal: number,
  roiPaPct: number,
  tenureMonths: number,
): EMIResult {
  const principalInr = toRupee(principal)
  const r = roiPaPct / 100 / 12
  const n = normalizeMonths(tenureMonths)
  const emi = r === 0
    ? principalInr / n
    : principalInr * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1)
  const monthlyPayment = toRupee(emi)

  const schedule: AmortizationRow[] = []
  let balance = principalInr

  for (let i = 1; i <= n; i++) {
    const interest = toRupee(balance * r)
    const principalPaid = i === n
      ? balance
      : Math.min(balance, Math.max(0, monthlyPayment - interest))
    const payment = principalPaid + interest
    const closing = Math.max(0, balance - principalPaid)

    schedule.push({
      month: i,
      openingBalance: balance,
      payment,
      principal: principalPaid,
      interest,
      closingBalance: closing,
    })
    balance = closing
  }

  return {
    repaymentType: 'emi',
    monthlyPayment,
    bulletPayment: 0,
    totalPayment: sumRows(schedule, 'payment'),
    totalInterest: sumRows(schedule, 'interest'),
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
  const principalInr = toRupee(principal)
  const r = roiPaPct / 100 / 12
  const n = normalizeMonths(tenureMonths)
  const monthlyInterest = toRupee(principalInr * r)

  const schedule: AmortizationRow[] = []
  for (let i = 1; i <= n; i++) {
    const isFinal = i === n
    schedule.push({
      month: i,
      openingBalance: principalInr,
      payment: isFinal ? principalInr + monthlyInterest : monthlyInterest,
      principal: isFinal ? principalInr : 0,
      interest: monthlyInterest,
      closingBalance: isFinal ? 0 : principalInr,
    })
  }

  return {
    repaymentType: 'interest_only',
    monthlyPayment: monthlyInterest,
    bulletPayment: principalInr,
    totalPayment: sumRows(schedule, 'payment'),
    totalInterest: sumRows(schedule, 'interest'),
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
  const principalInr = toRupee(principal)
  const n = normalizeMonths(tenureMonths)
  const totalInterest = toRupee(principalInr * roiPaPct / 100 * n / 12)
  const bulletAmount  = principalInr + totalInterest

  return {
    repaymentType: 'bullet',
    monthlyPayment: 0,
    bulletPayment: bulletAmount,
    totalPayment: bulletAmount,
    totalInterest,
    schedule: [{
      month: n,
      openingBalance: principalInr,
      payment: bulletAmount,
      principal: principalInr,
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
