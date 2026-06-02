import { useState, useMemo, useEffect, useCallback, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AssessmentResult, EvalData, UserProfile } from '../store/session'
import { useSessionStore } from '../store/session'
import { computeROI, getCibilTierInfo, getRepaymentTypes, getRepaymentLabel } from '../lib/roiEngine'
import { computeEMI, type RepaymentType } from '../lib/emiEngine'
import { resolveRegion } from '../lib/regionEngine'
import loanParams from '../data/loan_params.json'
import regionsData from '../data/regions.json'
import { apiBase, createUserSessionAPI, saveLoanPredictionAPI, uploadUserAssetAPI } from '../lib/api'
import {
  ChevronRight, ChevronDown, ChevronUp, ArrowRight, TrendingUp,
  Calendar, IndianRupee, Info, CheckCircle, AlertTriangle, Zap,
} from 'lucide-react'
import { clsx } from 'clsx'

const fmt    = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtPct = (n: number) => `${n.toFixed(2)}%`
const fmtCompact = (n: number) => {
  const value = Math.round(n)
  if (value >= 10000000) {
    const cr = value / 10000000
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(1)}Cr`
  }
  if (value >= 100000) {
    const lakh = value / 100000
    return `₹${lakh % 1 === 0 ? lakh.toFixed(0) : lakh.toFixed(1)}L`
  }
  if (value >= 1000) {
    const thousand = value / 1000
    return `₹${thousand % 1 === 0 ? thousand.toFixed(0) : thousand.toFixed(1)}K`
  }
  return fmt(value)
}

interface PoonawallaDeal {
  scheme_name: string
  roi_min_pct: number | null
  roi_max_pct: number | null
  ltv_pct: number | null
  tenure_desc: string | null
  special_offer: string | null
  min_amount_inr: number | null
}

const POONAWALLA_MAX = loanParams.tenure_options.poonawalla_max_months
const NBFC_MONTHS = loanParams.tenure_options.nbfc_variant_months as number[]
const HEADLINE_LTV = loanParams.rbi_rules.headline_ltv_pct

function buildEvalDataFromAssessment(result: AssessmentResult, profile: UserProfile | null): EvalData {
  const states = (regionsData as any).states as Array<{ code: string; name: string }>
  const stateName = states.find(s => s.code === profile?.region_code)?.name || 'Maharashtra'
  const city = profile?.city?.trim() || 'Other'
  const region = resolveRegion(stateName, city)
  const cityGoldValueInr = Math.round((result.value_inr.band_low + result.value_inr.band_high) / 2)
  const cityPricePerG = result.weight.estimated_g > 0
    ? cityGoldValueInr / result.weight.estimated_g
    : 0
  const ltvFinalPct = Math.round((result.loan_offer.band_high_inr / Math.max(cityGoldValueInr, 1)) * 1000) / 10
  const ltvLowPct = Math.round((result.loan_offer.band_low_inr / Math.max(cityGoldValueInr, 1)) * 1000) / 10
  const cibilTierKey = 'NTC'
  const cibilInfo = getCibilTierInfo(cibilTierKey)

  return {
    state: region.state,
    city: region.city,
    locationTier: region.tier,
    tierLabel: region.tierLabel,
    stampDutyInr: region.stampDutyInr,
    serviceable: region.serviceable,
    cityGoldValueInr,
    cityPricePerG,
    priceSource: 'assessment',
    cibilScore: null,
    cibilTierKey,
    cibilTierLabel: cibilInfo.label,
    pan: '',
    ltvFinalPct,
    ltvLowPct,
    tierCeilingPct: ltvFinalPct,
    confidenceScore: result.confidence.score,
    confidenceFactor: result.confidence.score,
    maxLoanInr: result.loan_offer.band_high_inr,
    provisionalLoanLowInr: result.loan_offer.band_low_inr,
    ticketTierLabel: result.loan_offer.tier,
    ticketTierDescription: 'Assessment-based loan band',
    processingFeePct: loanParams.charges.processing_fee_pct,
    eligible: true,
    rejectReason: null,
  }
}

export function GoldLoanApplication() {
  const navigate = useNavigate()
  const { state, setLoanAppData } = useSessionStore()
  const evalData = useMemo(
    () => state.evalData?.eligible
      ? state.evalData
      : state.result
        ? buildEvalDataFromAssessment(state.result, state.userProfile)
        : null,
    [state.evalData, state.result, state.userProfile],
  )

  if (!evalData) {
    navigate('/result')
    return null
  }
  const activeEvalData = evalData

  const { available_months } = loanParams.tenure_options
  const policyMinLoan = loanParams.loan_limits.min_inr
  const maxLoan = Math.max(0, evalData.maxLoanInr)
  const provisionalLowLoan = Math.max(0, evalData.provisionalLoanLowInr)
  const hasVerificationRange = provisionalLowLoan < maxLoan
  const belowPolicyMinimum = maxLoan > 0 && maxLoan < policyMinLoan
  const minLoan = belowPolicyMinimum ? maxLoan : hasVerificationRange ? provisionalLowLoan : policyMinLoan
  const loanMax = Math.max(maxLoan, minLoan)
  const hasAdjustableLoan = loanMax > minLoan
  const loanStep = loanMax - minLoan <= 10000 ? 500 : 1000
  const clampLoanAmount = (value: number) => {
    const rounded = Math.round(value / loanStep) * loanStep
    return Math.min(loanMax, Math.max(minLoan, rounded))
  }
  const suggestedLoan = clampLoanAmount(
    hasVerificationRange
      ? provisionalLowLoan
      : minLoan + (loanMax - minLoan) * 0.75,
  )
  const middleLoan = clampLoanAmount(minLoan + (loanMax - minLoan) * 0.5)
  const amountPresets = hasAdjustableLoan
    ? [
        { label: hasVerificationRange ? 'Lower Range' : 'Minimum', value: minLoan },
        { label: hasVerificationRange ? 'Middle' : 'Suggested', value: middleLoan },
        { label: 'Maximum', value: loanMax },
      ]
    : []

  // ── User inputs ─────────────────────────────────────────────────────────────
  const [loanAmount, setLoanAmount] = useState(() => (
    state.loanAppData?.requestedLoanInr != null
      ? clampLoanAmount(state.loanAppData.requestedLoanInr)
      : suggestedLoan
  ))
  const [tenure, setTenure]         = useState(() => state.loanAppData?.tenureMonths ?? 12)
  // Default to interest_only — matches Poonawalla's actual product structure
  const [repayType, setRepayType]   = useState<RepaymentType>(() => state.loanAppData?.repaymentType ?? 'interest_only')

  useEffect(() => {
    setLoanAmount(prev => clampLoanAmount(prev))
  }, [minLoan, loanMax, loanStep])

  const availableRepay = useMemo(() => getRepaymentTypes(tenure) as RepaymentType[], [tenure])
  useEffect(() => {
    if (!availableRepay.includes(repayType)) setRepayType(availableRepay[0])
  }, [tenure, availableRepay])

  // ── Engines ─────────────────────────────────────────────────────────────────
  const roiResult = useMemo(
    () => computeROI(evalData.locationTier as any, tenure, {
      loanAmountInr: loanAmount,
      ltvPct: evalData.cityGoldValueInr > 0 ? (loanAmount / evalData.cityGoldValueInr) * 100 : undefined,
    }),
    [evalData.locationTier, tenure, loanAmount, evalData.cityGoldValueInr],
  )

  const emiResult = useMemo(
    () => computeEMI(loanAmount, roiResult.roiPaPct, tenure, repayType),
    [loanAmount, roiResult.roiPaPct, tenure, repayType],
  )
  const monthlyRatePct = roiResult.roiPaPct / 12
  const monthlyRateLabel = `${monthlyRatePct.toFixed(3).replace(/\.?0+$/, '')}%`

  // ── Charges ─────────────────────────────────────────────────────────────────
  const { charges } = loanParams
  const processingFeeInr = Math.round(loanAmount * evalData.processingFeePct / 100)
  const gstOnFeeInr      = Math.round(processingFeeInr * charges.gst_on_fees_pct / 100)
  const stampDutyInr     = evalData.stampDutyInr
  const netWeightG       = state.result
    ? Math.max(
        state.result.weight.estimated_g - (state.result.value_inr.stone_weight_excluded_g ?? 0),
        state.result.weight.estimated_g * 0.94,
      )
    : 0
  const safeCustodyInr   = Math.round(charges.safe_custody_inr_per_g_per_month * netWeightG * tenure)
  const totalDeductions  = processingFeeInr + gstOnFeeInr + stampDutyInr
  const disbursementInr  = loanAmount - totalDeductions
  const totalCustomerCost = emiResult.totalPayment + safeCustodyInr

  // ── Slider position for LTV bubble ─────────────────────────────────────────
  const sliderPct = hasAdjustableLoan ? ((loanAmount - minLoan) / (loanMax - minLoan)) * 100 : 100
  const sliderStyle = { '--loan-progress': `${Math.max(0, Math.min(100, sliderPct))}%` } as CSSProperties

  // ── Accordion state ─────────────────────────────────────────────────────────
  const [showROIBreakdown, setShowROIBreakdown] = useState(false)
  const [showSchedule, setShowSchedule]         = useState(false)
  const [showCharges, setShowCharges]           = useState(false)
  const [scheduleLimit, setScheduleLimit]       = useState(4)
  const displayedScheduleRows = useMemo(() => {
    if (scheduleLimit >= emiResult.schedule.length) return emiResult.schedule
    if (repayType === 'interest_only' && emiResult.schedule.length > 4) {
      return [
        ...emiResult.schedule.slice(0, 3),
        emiResult.schedule[emiResult.schedule.length - 1],
      ]
    }
    return emiResult.schedule.slice(0, scheduleLimit)
  }, [emiResult.schedule, repayType, scheduleLimit])

  // ── Live Poonawalla deals ───────────────────────────────────────────────────
  const [deals, setDeals]               = useState<PoonawallaDeal[]>([])
  const [dealsLoading, setDealsLoading] = useState(true)
  const [dealsError, setDealsError]     = useState(false)

  const fetchDeals = useCallback(async () => {
    try {
      setDealsLoading(true)
      const res = await fetch(`${apiBase}/api/poonawalla-deals`)
      if (!res.ok) throw new Error('fetch failed')
      const data = await res.json()
      setDeals(data.schemes ?? [])
    } catch {
      setDealsError(true)
    } finally {
      setDealsLoading(false)
    }
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // ── Apply ────────────────────────────────────────────────────────────────────
  async function handleApply() {
    const loanAppData = {
      requestedLoanInr: loanAmount,
      tenureMonths: tenure,
      repaymentType: repayType,
      roiPaPct: roiResult.roiPaPct,
      roiComponents: roiResult.components,
      monthlyPayment: emiResult.monthlyPayment,
      bulletPayment: emiResult.bulletPayment,
      totalInterest: emiResult.totalInterest,
      totalPayment: emiResult.totalPayment,
      processingFeeInr,
      gstOnFeeInr,
      stampDutyInr,
      safeCustodyInr,
      disbursementInr,
      schedule: emiResult.schedule,
    }
    setLoanAppData(loanAppData)
    if (state.authToken && state.authToken !== 'guest' && state.sessionId && state.result) {
      try {
        const regionCode = state.userProfile?.region_code || activeEvalData.state
        await createUserSessionAPI(state.authToken, state.sessionId, regionCode, 'loan_application')

        await saveLoanPredictionAPI(state.authToken, {
          session_id: state.sessionId,
          status: 'completed',
          region_code: regionCode,
          estimated_weight_g: state.result.weight.estimated_g,
          estimated_gold_value_inr: activeEvalData.cityGoldValueInr,
          eligible_loan_inr: loanAmount,
          ltv_pct: activeEvalData.ltvFinalPct,
          result: {
            assessment: state.result,
            eligibility: activeEvalData,
            loan_application: loanAppData,
          },
        })
      } catch (err) {
        console.warn('[history] failed to save loan prediction', err)
      }
    }
    navigate('/confirmation')
  }

  return (
    <div className="flex flex-col app-page-bg loan-app-page animate-fade-in relative z-[5]" style={{ height: '100dvh' }}>
      {/* Header */}
      <div className="page-header">
        <button onClick={() => navigate('/result')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">Gold Loan Application</span>
        <div className="w-11" />
      </div>

      <main className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8 space-y-4 pt-4">

        {/* Eligibility pill */}
        <div className="flex items-center gap-3 surface-panel rounded-2xl px-4 py-3">
          <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-stone-800">
              {hasVerificationRange ? (
                <>
                  Range <span className="text-stone-950 font-black">{fmt(provisionalLowLoan)} - {fmt(maxLoan)}</span>
                </>
              ) : (
                <>
                  {belowPolicyMinimum ? 'Branch review amount' : 'Eligible up to'} <span className="text-stone-950 font-black">{fmt(maxLoan)}</span>
                </>
              )}
            </p>
            <p className="text-[10px] text-stone-500 mt-0.5 truncate">
              {belowPolicyMinimum
                ? `Standard online minimum is ${fmt(policyMinLoan)} · branch can confirm final availability`
                : hasVerificationRange
                ? `Up to ${HEADLINE_LTV}% LTV · final amount stays within this approved band`
                : `Up to ${HEADLINE_LTV}% LTV · ${evalData.city}, ${evalData.state} · ${evalData.cibilTierLabel} credit`}
            </p>
          </div>
        </div>

        {/* ── Loan Setup ───────────────────────────────────────────────────── */}
        <div className="loan-app-card loan-setup-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="label">Customize loan</p>
              <p className="mt-1 text-xs text-stone-500">Amount and repayment period</p>
            </div>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[10px] font-black text-stone-600">
              Up to {HEADLINE_LTV}% LTV
            </span>
          </div>

          <section className="loan-setup-section">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-stone-500">Amount needed</p>
                <p className="mt-1 font-display text-[2rem] leading-none font-black text-stone-950 numeric-hero">{fmt(loanAmount)}</p>
              </div>
              <div className="text-right text-[10px] font-semibold text-stone-500">
                <span className="block">{belowPolicyMinimum ? 'Branch review' : `Max ${fmtCompact(loanMax)}`}</span>
                <span className="block text-stone-400">
                  Min {fmtCompact(minLoan)}
                </span>
              </div>
            </div>

            {hasAdjustableLoan ? (
              <>
                <input
                  type="range"
                  min={minLoan}
                  max={loanMax}
                  step={loanStep}
                  value={loanAmount}
                  onChange={e => setLoanAmount(clampLoanAmount(Number(e.target.value)))}
                  className="loan-amount-range compact"
                  style={sliderStyle}
                  aria-label="Requested loan amount"
                />
                <div className="mt-1 flex justify-between text-[10px] font-semibold text-stone-400">
                  <span>{fmtCompact(minLoan)}</span>
                  <span>{fmtCompact(loanMax)}</span>
                </div>
                <div className="loan-preset-grid">
                  {amountPresets.map(preset => {
                    const active = loanAmount === clampLoanAmount(preset.value)
                    return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setLoanAmount(clampLoanAmount(preset.value))}
                      className={clsx('loan-preset-chip', active && 'is-active')}
                    >
                      <span>{active ? preset.label : preset.label.replace('Lower Range', 'Min').replace('Minimum', 'Min').replace('Suggested', 'Mid').replace('Maximum', 'Max')}</span>
                      <strong>{fmtCompact(preset.value)}</strong>
                    </button>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="loan-fixed-band">
                <CheckCircle className="w-4 h-4" />
                <span>
                  Fixed by this assessment. Standard online minimum is {fmt(policyMinLoan)}.
                </span>
              </div>
            )}

            {hasVerificationRange && loanAmount > provisionalLowLoan && (
              <p className="mt-2 text-[10px] font-semibold text-amber-700">
                Above the instant band, final amount depends on branch verification.
              </p>
            )}
          </section>

          <section className="loan-setup-section">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-black uppercase tracking-[0.14em] text-stone-500 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-stone-700" />
                Tenure
              </p>
              <span className="shrink-0 text-xs font-black text-stone-900">{tenure} months</span>
            </div>
            <div className="tenure-pill-strip" role="radiogroup" aria-label="Choose loan tenure">
              {(available_months as number[]).map(m => {
                const isNBFC = NBFC_MONTHS.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTenure(m)}
                    className={clsx('tenure-pill', tenure === m && 'is-active')}
                    aria-pressed={tenure === m}
                  >
                    {m}m
                    {isNBFC && <small>NBFC</small>}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[10px] text-stone-400">
              Bullet repayment is available up to {loanParams.rbi_rules.max_bullet_repayment_months} months; longer plans keep monthly interest/EMI options.
            </p>
          </section>
        </div>

        {/* ── Repayment Type ─────────────────────────────────────────────────── */}
        {availableRepay.length > 1 && (
          <div className="loan-app-card p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="label">Repayment structure</p>
              <span className="text-[10px] font-black text-stone-500">
                {getRepaymentLabel(repayType)}
              </span>
            </div>
            <div className="repayment-segment">
              {availableRepay.map(type => (
                <button
                  key={type}
                  onClick={() => setRepayType(type)}
                  className={clsx('repayment-option', repayType === type && 'is-active')}
                >
                  {getRepaymentLabel(type)}
                </button>
              ))}
            </div>
            <div className="mt-3 rounded-2xl bg-white/72 border border-stone-200/80 px-3 py-3 text-[11px] text-stone-500">
              {repayType === 'interest_only' && (
                <p className="font-semibold text-emerald-700">
                  Pay {fmt(emiResult.monthlyPayment)}/month interest · Principal {fmt(emiResult.bulletPayment)} at month {tenure}
                </p>
              )}
              {repayType === 'emi' && (
                <p className="font-semibold text-stone-700">Reducing balance · pay {fmt(emiResult.monthlyPayment)}/month, principal reduces each month</p>
              )}
              {repayType === 'bullet' && (
                <p className="font-semibold text-amber-700">Full {fmt(emiResult.bulletPayment)} due at month {tenure} · no monthly payments</p>
              )}
            </div>
          </div>
        )}

        {/* ── Live Offer Card ─────────────────────────────────────────────────── */}
        <div className="loan-app-card p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="font-display font-bold text-sm text-stone-900">Your Loan Offer</p>
            <span className="text-[10px] bg-charcoal text-white px-2 py-0.5 rounded-full font-semibold">LIVE</span>
          </div>

          {/* Primary figure */}
          <div className="text-center mb-4">
            {repayType === 'emi' && (
              <>
                <p className="text-xs text-stone-500 mb-1">Monthly EMI</p>
                <p className="font-display font-black text-4xl text-stone-950 numeric-hero">{fmt(emiResult.monthlyPayment)}</p>
                <p className="text-xs text-stone-400 mt-1">for {tenure} months</p>
              </>
            )}
            {repayType === 'interest_only' && (
              <>
                <p className="text-xs text-stone-500 mb-1">Monthly Interest Payment</p>
                <p className="font-display font-black text-4xl text-stone-950 numeric-hero">{fmt(emiResult.monthlyPayment)}</p>
                <p className="text-xs text-stone-400 mt-1">+ {fmt(emiResult.bulletPayment)} principal at month {tenure}</p>
              </>
            )}
            {repayType === 'bullet' && (
              <>
                <p className="text-xs text-stone-500 mb-1">Due at End (Month {tenure})</p>
                <p className="font-display font-black text-4xl text-stone-950 numeric-hero">{fmt(emiResult.bulletPayment)}</p>
                <p className="text-xs text-stone-400 mt-1">No monthly payments during tenure</p>
              </>
            )}
          </div>

          {/* Core rows */}
          <div className="space-y-2 border-t border-stone-200/80 pt-3">
            {[
              { label: 'Loan Amount',       value: fmt(loanAmount) },
              { label: 'Annual Rate (ROI)', value: fmtPct(roiResult.roiPaPct) },
              { label: 'Total Interest',    value: fmt(emiResult.totalInterest) },
            ].map((row, i) => (
              <div key={i} className="flex justify-between items-center">
                <span className="text-xs text-stone-500">{row.label}</span>
                <span className="text-sm font-medium text-stone-800">{row.value}</span>
              </div>
            ))}

            {/* Charges accordion */}
            <div className="border-t border-stone-200/80 pt-2">
              <button
                onClick={() => setShowCharges(!showCharges)}
                className="w-full flex items-center justify-between text-xs text-stone-500 py-1"
              >
                <span>
                  Disbursement deductions
                </span>
                <div className="flex items-center gap-1">
                  <span className="font-medium text-stone-700">{fmt(totalDeductions)}</span>
                  {showCharges ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </div>
              </button>
              {showCharges && (
                <div className="mt-1 space-y-1.5 bg-stone-50 rounded-lg px-3 py-2 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-stone-500">Processing fee ({evalData.processingFeePct}%)</span>
                    <span className="font-medium">{fmt(processingFeeInr)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">GST on fees ({charges.gst_on_fees_pct}%)</span>
                    <span className="font-medium">{fmt(gstOnFeeInr)}</span>
                  </div>
                  {stampDutyInr > 0 && (
                    <div className="flex justify-between">
                      <span className="text-stone-500">Stamp duty ({evalData.state})</span>
                      <span className="font-medium">{fmt(stampDutyInr)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-amber-600 border-t border-stone-200 pt-1.5 mt-1">
                    <span className="font-medium">Safe custody ({charges.safe_custody_inr_per_g_per_month}₹/g/mo × {tenure}mo)</span>
                    <span className="font-semibold">{fmt(safeCustodyInr)}</span>
                  </div>
                  <p className="text-[10px] text-stone-400 pt-1">
                    Safe custody is billed separately, not deducted. GST applies only to fees — never to principal or interest.
                  </p>
                </div>
              )}
            </div>

            {/* Disbursement and total */}
            <div className="border-t border-stone-200/80 pt-2 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Net Disbursement</span>
                <span className="text-sm font-black text-stone-950">{fmt(disbursementInr)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Total Repayable</span>
                <span className="text-sm font-black text-stone-950">{fmt(emiResult.totalPayment)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Total Customer Cost</span>
                <span className="text-sm font-black text-stone-950">{fmt(totalCustomerCost)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── If a payment is late ─────────────────────────────────────────── */}
        <div className="loan-app-card p-4">
          <p className="label mb-2.5 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-stone-700" />
            If a payment is late
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([
              { rate: charges.late_payment_monthly_pct, label: 'Monthly-interest scheme', on: repayType !== 'bullet' },
              { rate: charges.late_payment_bullet_pct,  label: 'Bullet / rear-ended',     on: repayType === 'bullet' },
            ]).map((s, i) => (
              <div
                key={i}
                className={clsx(
                  'rounded-lg border px-3 py-2',
                  s.on ? 'border-stone-300 bg-white shadow-xs' : 'border-stone-200 bg-stone-50/80',
                )}
              >
                <p className="font-display font-black text-lg text-stone-800 tabular-nums">
                  {s.rate}%<span className="text-xs font-medium text-stone-400"> p.a.</span>
                </p>
                <p className="text-[10px] text-stone-500">
                  {s.label}{s.on && <span className="text-stone-900 font-semibold"> · yours</span>}
                </p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-stone-500 mt-2.5 leading-snug">
            Penal interest applies only to the <b>overdue amount</b> for the days it stays unpaid — your on-time
            {repayType === 'bullet' ? ' bullet' : repayType === 'emi' ? ' EMI' : ' interest'} payment never changes.
            A cheque/mandate bounce is ₹{charges.bounce_charge_inr}; foreclosure is up to {charges.foreclosure_within_30_days_pct}% within 30 days.
          </p>
        </div>

        {/* ── ROI Breakdown ────────────────────────────────────────────────── */}
        <div>
          <button
            onClick={() => setShowROIBreakdown(!showROIBreakdown)}
            className="w-full loan-app-card flex items-center justify-between p-4"
          >
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-stone-700" />
              <span className="text-sm font-medium text-stone-900">
                How {fmtPct(roiResult.roiPaPct)} ROI is calculated
              </span>
            </div>
            {showROIBreakdown ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
          </button>
          {showROIBreakdown && (
            <div className="loan-app-card mt-1 p-4 animate-slide-down">
              {roiResult.components.map((c, i) => (
                <div key={i} className="flex justify-between items-center py-1.5 border-b border-stone-100 last:border-0">
                  <span className="text-xs text-stone-500">{c.name}</span>
                  <span className={clsx(
                    'text-xs font-mono font-semibold',
                    c.valuePct < 0 ? 'text-emerald-600' : 'text-stone-800',
                  )}>
                    {c.valuePct >= 0 ? '+' : ''}{c.valuePct.toFixed(2)}%
                  </span>
                </div>
              ))}
              <div className="flex justify-between items-center pt-2 mt-1">
                <span className="text-sm font-bold text-stone-900">Final ROI</span>
                <span className="text-base font-black text-stone-950">{fmtPct(roiResult.roiPaPct)} pa</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Payment Schedule ──────────────────────────────────────────────── */}
        {emiResult.schedule.length > 0 && (
          <div>
            <button
              onClick={() => setShowSchedule(!showSchedule)}
              className="w-full loan-app-card flex items-center justify-between p-4"
            >
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-stone-700" />
                <span className="text-sm font-medium text-stone-900">
                  {repayType === 'bullet' ? 'Payment Schedule' : `Schedule (${tenure} payments)`}
                </span>
              </div>
              {showSchedule ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
            </button>
            {showSchedule && (
              <div className="loan-app-card mt-1 p-0 animate-slide-down overflow-hidden">
                <div className="px-3 py-2.5 border-b border-stone-200/80 bg-white/70">
                  <p className="text-[11px] font-semibold text-stone-600">
                    {repayType === 'interest_only'
                      ? `${fmt(loanAmount)} × ${fmtPct(roiResult.roiPaPct)} p.a. ÷ 12 (${monthlyRateLabel}/mo) = ${fmt(emiResult.monthlyPayment)} interest/month`
                      : repayType === 'emi'
                        ? `${fmt(emiResult.monthlyPayment)} monthly EMI at ${fmtPct(roiResult.roiPaPct)} p.a.`
                        : `${fmt(emiResult.bulletPayment)} payable at month ${tenure} at ${fmtPct(roiResult.roiPaPct)} p.a.`}
                  </p>
                  {repayType === 'interest_only' && (
                    <p className="mt-0.5 text-[10px] text-stone-400">
                      Principal paid is {fmt(0)} before the final month; {fmt(loanAmount)} closes in the last payment.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-1 bg-stone-100 px-3 py-2">
                  {['Mo.', 'Payment', 'Principal paid', 'Interest'].map(h => (
                    <span key={h} className="text-[10px] font-semibold text-stone-500 text-right first:text-left">{h}</span>
                  ))}
                </div>
                {displayedScheduleRows.map(row => {
                  const isFinalInterestOnlyRow = repayType === 'interest_only' && row.month === tenure
                  return (
                  <div key={row.month} className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-stone-100 last:border-0">
                    <span className="text-xs text-stone-500">
                      {row.month}
                      {isFinalInterestOnlyRow && (
                        <span className="ml-1 rounded-full bg-stone-100 px-1.5 py-0.5 text-[8px] font-black uppercase text-stone-500">
                          final
                        </span>
                      )}
                    </span>
                    <span className="text-xs font-medium text-stone-900 text-right">{fmt(row.payment)}</span>
                    <span className="text-xs text-stone-700 text-right">{fmt(row.principal)}</span>
                    <span className="text-xs text-amber-700 text-right">{fmt(row.interest)}</span>
                  </div>
                  )
                })}
                {scheduleLimit < emiResult.schedule.length && (
                  <button
                    onClick={() => setScheduleLimit(emiResult.schedule.length)}
                    className="w-full text-xs text-stone-800 font-bold py-2.5 hover:bg-stone-50"
                  >
                    Show all {emiResult.schedule.length} payments
                  </button>
                )}
                <div className="grid grid-cols-4 gap-1 px-3 py-2.5 bg-stone-50 border-t border-stone-200">
                  <span className="text-[10px] font-bold text-stone-700">Total</span>
                  <span className="text-xs font-black text-stone-950 text-right">{fmt(emiResult.totalPayment)}</span>
                  <span className="text-xs font-bold text-stone-950 text-right">{fmt(loanAmount)}</span>
                  <span className="text-xs font-bold text-amber-700 text-right">{fmt(emiResult.totalInterest)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Live Poonawalla Schemes ───────────────────────────────────────── */}
        <div className="loan-app-card p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-display font-semibold text-sm text-stone-900">Current Poonawalla Schemes</p>
            {!dealsLoading && !dealsError && deals.length > 0 && (
              <span className="flex items-center gap-1 text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                LIVE
              </span>
            )}
          </div>

          {dealsLoading && (
            <div className="space-y-2">
              {[1, 2].map(i => <div key={i} className="h-16 bg-stone-100 rounded-xl animate-pulse" />)}
            </div>
          )}

          {!dealsLoading && (dealsError || deals.length === 0) && (
            <div className="text-center py-6 text-stone-400">
              <Zap className="w-6 h-6 mx-auto mb-2 opacity-40" />
              <p className="text-xs">Could not load live schemes. Your dynamic offer above applies.</p>
            </div>
          )}

          {!dealsLoading && deals.length > 0 && (
            <div className="space-y-3">
              {deals.map((deal, i) => (
                <div key={i} className="rounded-xl border border-stone-200/80 bg-white/78 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-stone-900 leading-snug">{deal.scheme_name}</p>
                    {deal.ltv_pct && (
                      <span className="text-[10px] bg-stone-100 text-stone-700 px-2 py-0.5 rounded-full font-semibold flex-shrink-0">
                        {deal.ltv_pct}% LTV
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    {(deal.roi_min_pct || deal.roi_max_pct) && (
                      <span className="text-xs text-stone-600">
                        Rate: <span className="font-bold text-stone-950">
                          {deal.roi_min_pct && deal.roi_max_pct
                            ? `${deal.roi_min_pct}–${deal.roi_max_pct}%`
                            : `${deal.roi_min_pct ?? deal.roi_max_pct}%`} pa
                        </span>
                      </span>
                    )}
                    {deal.tenure_desc && <span className="text-xs text-stone-400">{deal.tenure_desc}</span>}
                  </div>
                  {deal.special_offer && (
                    <p className="text-[11px] text-emerald-600 mt-1.5 font-medium flex items-center gap-1">
                      <Zap className="w-3 h-3" /> {deal.special_offer}
                    </p>
                  )}
                  {deal.roi_max_pct && (
                    <p className={clsx(
                      'text-[10px] mt-1.5 font-medium',
                      roiResult.roiPaPct <= deal.roi_max_pct ? 'text-emerald-600' : 'text-amber-600',
                    )}>
                      {roiResult.roiPaPct <= deal.roi_max_pct
                        ? `Your offer (${fmtPct(roiResult.roiPaPct)}) is within scheme range`
                        : `Your rate (${fmtPct(roiResult.roiPaPct)}) — verify at branch`
                      }
                    </p>
                  )}
                </div>
              ))}
              <p className="text-[10px] text-stone-400 text-center">
                Scraped live · For final terms visit poonawallafincorp.com
              </p>
            </div>
          )}
        </div>

        {/* Compliance note */}
        <div className="flex items-start gap-2 p-3 bg-stone-50 border border-stone-200 rounded-xl text-[10px] text-stone-400 leading-relaxed">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <p>
            LTV up to {loanParams.rbi_rules.headline_ltv_pct}% per {loanParams.rbi_rules.circular_reference}.
            Gold is primary collateral — credit score adjusts rate only.
            All charges (GST on fees, stamp duty, safe custody) deducted at disbursement or billed separately.
          </p>
        </div>
      </main>

      {/* Sticky CTA, matching dashboard-home */}
      <div
        className="shrink-0 z-20 px-5 py-3 bg-white border-t border-stone-200/70 shadow-[0_-18px_44px_rgba(23,20,18,0.08)]"
        style={{ paddingBottom: 'max(24px, calc(env(safe-area-inset-bottom) + 14px))' }}
      >
        <div className="grid grid-cols-3 gap-2 mb-3 text-[10px] text-stone-500">
          <span className="min-w-0">
            Loan
            <span className="block truncate text-xs font-bold text-stone-900">{fmt(loanAmount)}</span>
          </span>
          <span className="min-w-0 text-center">
            ROI
            <span className="block truncate text-xs font-bold text-stone-900">{fmtPct(roiResult.roiPaPct)}</span>
          </span>
          <span className="min-w-0 text-right">
            {repayType === 'bullet' ? 'Bullet' : repayType === 'interest_only' ? 'Interest' : 'EMI'}
            <span className="block truncate text-xs font-bold text-stone-900">
              {repayType === 'bullet' ? fmt(emiResult.bulletPayment) : `${fmt(emiResult.monthlyPayment)}/mo`}
            </span>
          </span>
        </div>
        <button
          onClick={handleApply}
          className="w-full py-3.5 rounded-2xl bg-charcoal text-white font-display font-black text-base shadow-cta active:scale-[0.98] transition-transform flex items-center justify-center gap-2.5"
          aria-label="Apply for Gold Loan"
        >
          Apply for Gold Loan
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
