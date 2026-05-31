import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { computeROI, getRepaymentTypes, getRepaymentLabel } from '../lib/roiEngine'
import { computeEMI, type RepaymentType } from '../lib/emiEngine'
import loanParams from '../data/loan_params.json'
import { apiBase, createUserSessionAPI, saveLoanPredictionAPI, uploadUserAssetAPI } from '../lib/api'
import {
  ChevronRight, ChevronDown, ChevronUp, ArrowRight, TrendingUp,
  Calendar, IndianRupee, Info, CheckCircle, AlertTriangle, Zap,
} from 'lucide-react'
import { clsx } from 'clsx'

const fmt    = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtPct = (n: number) => `${n.toFixed(2)}%`

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

export function GoldLoanApplication() {
  const navigate = useNavigate()
  const { state, setLoanAppData } = useSessionStore()
  const evalData = state.evalData

  if (!evalData || !evalData.eligible) {
    navigate('/final-eval')
    return null
  }
  const activeEvalData = evalData

  const { available_months } = loanParams.tenure_options
  const minLoan = loanParams.loan_limits.min_inr
  const maxLoan = evalData.maxLoanInr
  const provisionalLowLoan = evalData.provisionalLoanLowInr
  const hasVerificationRange = provisionalLowLoan < maxLoan

  // ── User inputs ─────────────────────────────────────────────────────────────
  const [loanAmount, setLoanAmount] = useState(() => Math.round(maxLoan * 0.75 / 1000) * 1000)
  const [tenure, setTenure]         = useState(12)
  // Default to interest_only — matches Poonawalla's actual product structure
  const [repayType, setRepayType]   = useState<RepaymentType>('interest_only')

  const availableRepay = useMemo(() => getRepaymentTypes(tenure) as RepaymentType[], [tenure])
  useEffect(() => {
    if (!availableRepay.includes(repayType)) setRepayType(availableRepay[0])
  }, [tenure, availableRepay])

  // ── Engines ─────────────────────────────────────────────────────────────────
  const roiResult = useMemo(
    () => computeROI(evalData.cibilTierKey, evalData.locationTier as any, tenure),
    [evalData.cibilTierKey, evalData.locationTier, tenure],
  )

  const emiResult = useMemo(
    () => computeEMI(loanAmount, roiResult.roiPaPct, tenure, repayType),
    [loanAmount, roiResult.roiPaPct, tenure, repayType],
  )

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
  const sliderPct = maxLoan > minLoan ? ((loanAmount - minLoan) / (maxLoan - minLoan)) * 100 : 0
  const effectiveLtvPct = ((loanAmount / evalData.cityGoldValueInr) * 100).toFixed(1)

  // ── Accordion state ─────────────────────────────────────────────────────────
  const [showROIBreakdown, setShowROIBreakdown] = useState(false)
  const [showSchedule, setShowSchedule]         = useState(false)
  const [showCharges, setShowCharges]           = useState(false)
  const [scheduleLimit, setScheduleLimit]       = useState(4)

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
    <div className="page overflow-y-auto no-scrollbar animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <button onClick={() => navigate('/final-eval')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">Gold Loan Application</span>
        <div className="w-11" />
      </div>

      <div className="px-5 pb-28 space-y-4 pt-4">

        {/* Eligibility pill */}
        <div className="flex items-center gap-3 surface-panel rounded-2xl px-4 py-3">
          <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-stone-800">
              {hasVerificationRange ? (
                <>
                  Range <span className="text-brand-600 font-black">{fmt(provisionalLowLoan)} - {fmt(maxLoan)}</span>
                </>
              ) : (
                <>
                  Eligible up to <span className="text-brand-600 font-black">{fmt(maxLoan)}</span>
                </>
              )}
            </p>
            <p className="text-[10px] text-stone-500 mt-0.5 truncate">
              {hasVerificationRange
                ? `LTV ${evalData.ltvLowPct}% - ${evalData.ltvFinalPct}% · upper subject to agent verification`
                : `LTV ${evalData.ltvFinalPct}% · ${evalData.city}, ${evalData.state} · ${evalData.cibilTierLabel} credit`}
            </p>
          </div>
        </div>

        {/* ── Loan Amount — draggable slider ───────────────────────────────── */}
        <div className="card p-5">
          <p className="label mb-3 flex items-center gap-2">
            <IndianRupee className="w-4 h-4 text-brand-600" />
            How much do you need?
          </p>

          {/* Amount display */}
          <div className="text-center mb-4">
          <p className="font-display font-black text-4xl text-stone-950 numeric-hero">{fmt(loanAmount)}</p>
            <p className="text-[10px] text-stone-400 mt-0.5">
              Effective LTV: <span className="font-bold text-stone-600">{effectiveLtvPct}%</span>
              <span className="mx-1 text-stone-300">·</span>
              Max {evalData.ltvFinalPct}%
            </p>
            {hasVerificationRange && loanAmount > provisionalLowLoan && (
              <p className="text-[10px] text-amber-600 mt-1">
                Amount above {fmt(provisionalLowLoan)} depends on agent verification of hallmark/net weight.
              </p>
            )}
          </div>

          {/* Draggable range slider with floating LTV bubble */}
          <div className="relative px-1 mb-5 mt-6">
            {/* Floating bubble tracks thumb */}
            <div
              className="absolute -top-8 bg-charcoal text-white text-[10px] font-black px-2 py-1 rounded-lg pointer-events-none shadow-sm whitespace-nowrap transition-all duration-75"
              style={{
                left: `clamp(20px, calc(${sliderPct}% - 20px), calc(100% - 20px))`,
              }}
            >
              {effectiveLtvPct}% LTV
            </div>
            <input
              type="range"
              min={minLoan}
              max={maxLoan}
              step={1000}
              value={loanAmount}
              onChange={e => setLoanAmount(Number(e.target.value))}
              className="w-full h-3 rounded-full cursor-grab active:cursor-grabbing accent-brand-600"
              style={{ WebkitAppearance: 'none', appearance: 'none' }}
            />
            <div className="flex justify-between text-[10px] text-stone-400 mt-1.5">
              <span>{fmt(minLoan)}</span>
              <span className="text-stone-500 font-medium">Max {fmt(maxLoan)}</span>
            </div>
          </div>

          {/* Quick amount shortcuts */}
          <div className="flex gap-2 flex-wrap mt-1">
            {[0.25, 0.50, 0.75, 1.00].map(frac => {
              const v = Math.round(maxLoan * frac / 1000) * 1000
              return (
                <button
                  key={frac}
                  onClick={() => setLoanAmount(v)}
                  className={clsx(
                    'flex-1 py-1.5 text-[11px] font-semibold rounded-lg border transition-all',
                    loanAmount === v
                      ? 'border-charcoal bg-charcoal text-white'
                      : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300',
                  )}
                >
                  {Math.round(frac * 100)}%
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Tenure ───────────────────────────────────────────────────────── */}
        <div className="card p-4">
          <p className="label mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-brand-600" />
            Choose Tenure
          </p>
          <div className="flex gap-2 flex-wrap">
            {(available_months as number[]).map(m => {
              const isNBFC = NBFC_MONTHS.includes(m)
              return (
                <button
                  key={m}
                  onClick={() => setTenure(m)}
                  className={clsx(
                    'relative px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-all',
                    tenure === m
                      ? 'border-charcoal bg-charcoal text-white'
                      : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300',
                  )}
                >
                  {m}mo
                  {isNBFC && (
                    <span className="absolute -top-2 -right-1 text-[8px] bg-amber-400 text-white px-1 rounded-full font-bold leading-none py-0.5">
                      NBFC
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-stone-400 mt-2 flex items-center gap-1">
            <Info className="w-3 h-3" />
            Poonawalla gold loan — up to {POONAWALLA_MAX} months. Bullet repayment is capped at {loanParams.rbi_rules.max_bullet_repayment_months} months per RBI.
          </p>
        </div>

        {/* ── Repayment Type ─────────────────────────────────────────────────── */}
        {availableRepay.length > 1 && (
          <div className="card p-4">
            <p className="label mb-3">Repayment Structure</p>
            <div className="flex gap-2 flex-wrap">
              {availableRepay.map(type => (
                <button
                  key={type}
                  onClick={() => setRepayType(type)}
                  className={clsx(
                    'px-3 py-2 rounded-xl text-xs font-semibold border-2 transition-all',
                    repayType === type
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-stone-200 bg-white text-stone-600',
                  )}
                >
                  {getRepaymentLabel(type)}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[10px] text-stone-500">
              {repayType === 'interest_only' && (
                <p className="text-emerald-600 font-medium">
                  Pay {fmt(emiResult.monthlyPayment)}/month interest · Principal {fmt(emiResult.bulletPayment)} at month {tenure}
                </p>
              )}
              {repayType === 'emi' && (
                <p>Reducing balance — pay {fmt(emiResult.monthlyPayment)}/month, principal reduces each month</p>
              )}
              {repayType === 'bullet' && (
                <p className="text-amber-600">Full {fmt(emiResult.bulletPayment)} due at end of month {tenure} — no monthly payments</p>
              )}
            </div>
          </div>
        )}

        {/* ── Live Offer Card ─────────────────────────────────────────────────── */}
        <div className="card p-5 border-brand-200/70 bg-white/90">
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
          <div className="space-y-2 border-t border-brand-200 pt-3">
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
            <div className="border-t border-brand-200 pt-2">
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
            <div className="border-t border-brand-200 pt-2 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Net Disbursement</span>
                <span className="text-sm font-black text-brand-600">{fmt(disbursementInr)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Total Repayable</span>
                <span className="text-sm font-black text-brand-600">{fmt(emiResult.totalPayment)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-stone-900">Total Customer Cost</span>
                <span className="text-sm font-black text-brand-600">{fmt(totalCustomerCost)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── If a payment is late ─────────────────────────────────────────── */}
        <div className="card p-4">
          <p className="label mb-2.5 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
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
                  s.on ? 'border-amber-300 bg-amber-50' : 'border-stone-200 bg-stone-50',
                )}
              >
                <p className="font-display font-black text-lg text-stone-800 tabular-nums">
                  {s.rate}%<span className="text-xs font-medium text-stone-400"> p.a.</span>
                </p>
                <p className="text-[10px] text-stone-500">
                  {s.label}{s.on && <span className="text-amber-600 font-semibold"> · yours</span>}
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
            className="w-full card flex items-center justify-between p-4"
          >
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-brand-600" />
              <span className="text-sm font-medium text-stone-900">
                How {fmtPct(roiResult.roiPaPct)} ROI is calculated
              </span>
            </div>
            {showROIBreakdown ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
          </button>
          {showROIBreakdown && (
            <div className="card mt-1 p-4 animate-slide-down">
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
                <span className="text-base font-black text-brand-600">{fmtPct(roiResult.roiPaPct)} pa</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Payment Schedule ──────────────────────────────────────────────── */}
        {emiResult.schedule.length > 0 && (
          <div>
            <button
              onClick={() => setShowSchedule(!showSchedule)}
              className="w-full card flex items-center justify-between p-4"
            >
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-brand-600" />
                <span className="text-sm font-medium text-stone-900">
                  {repayType === 'bullet' ? 'Payment Schedule' : `Schedule (${tenure} payments)`}
                </span>
              </div>
              {showSchedule ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
            </button>
            {showSchedule && (
              <div className="card mt-1 p-0 animate-slide-down overflow-hidden">
                <div className="grid grid-cols-4 gap-1 bg-stone-100 px-3 py-2">
                  {['Mo.', 'Payment', 'Principal', 'Interest'].map(h => (
                    <span key={h} className="text-[10px] font-semibold text-stone-500 text-right first:text-left">{h}</span>
                  ))}
                </div>
                {emiResult.schedule.slice(0, scheduleLimit).map(row => (
                  <div key={row.month} className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-stone-100 last:border-0">
                    <span className="text-xs text-stone-500">{row.month}</span>
                    <span className="text-xs font-medium text-stone-900 text-right">{fmt(row.payment)}</span>
                    <span className="text-xs text-brand-600 text-right">{fmt(row.principal)}</span>
                    <span className="text-xs text-red-400 text-right">{fmt(row.interest)}</span>
                  </div>
                ))}
                {scheduleLimit < emiResult.schedule.length && (
                  <button
                    onClick={() => setScheduleLimit(emiResult.schedule.length)}
                    className="w-full text-xs text-brand-600 font-medium py-2.5 hover:bg-stone-50"
                  >
                    Show all {emiResult.schedule.length} payments
                  </button>
                )}
                <div className="grid grid-cols-4 gap-1 px-3 py-2.5 bg-brand-50 border-t border-brand-200">
                  <span className="text-[10px] font-bold text-stone-700">Total</span>
                  <span className="text-xs font-black text-brand-600 text-right">{fmt(emiResult.totalPayment)}</span>
                  <span className="text-xs font-bold text-brand-600 text-right">{fmt(loanAmount)}</span>
                  <span className="text-xs font-bold text-red-500 text-right">{fmt(emiResult.totalInterest)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Live Poonawalla Schemes ───────────────────────────────────────── */}
        <div className="card p-4">
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
                <div key={i} className="rounded-xl border border-stone-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-stone-900 leading-snug">{deal.scheme_name}</p>
                    {deal.ltv_pct && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold flex-shrink-0">
                        {deal.ltv_pct}% LTV
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    {(deal.roi_min_pct || deal.roi_max_pct) && (
                      <span className="text-xs text-stone-600">
                        Rate: <span className="font-bold text-brand-600">
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
      </div>

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] px-5 pb-6 pt-4 bg-white/90 backdrop-blur-xl border-t border-stone-200/80">
        <div className="flex items-center justify-between mb-3 text-xs text-stone-500">
          <span>Loan <span className="font-bold text-stone-800">{fmt(loanAmount)}</span></span>
          <span>ROI <span className="font-bold text-brand-600">{fmtPct(roiResult.roiPaPct)}</span></span>
          <span>
            {repayType === 'bullet' ? 'Bullet' : repayType === 'interest_only' ? 'Interest' : 'EMI'}
            {' '}<span className="font-bold text-stone-800">
              {repayType === 'bullet' ? fmt(emiResult.bulletPayment) : `${fmt(emiResult.monthlyPayment)}/mo`}
            </span>
          </span>
        </div>
        <button onClick={handleApply} className="btn-primary w-full">
          Apply for Gold Loan
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
