import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { CheckCircle, Home, TrendingUp, Calendar, IndianRupee, Shield, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { clsx } from 'clsx'

const fmt    = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtPct = (n: number) => `${n.toFixed(2)}%`

export function Confirmation() {
  const navigate = useNavigate()
  const { state, reset } = useSessionStore()
  const loan    = state.loanAppData
  const evalD   = state.evalData
  const result  = state.result
  const [showDetails, setShowDetails] = useState(false)

  // Fallback if someone lands here directly without data
  if (!loan || !evalD || !result) {
    return (
      <div className="page flex flex-col items-center justify-center px-5 bg-stone-50">
        <div className="w-20 h-20 rounded-full bg-emerald-50 border-4 border-emerald-100 flex items-center justify-center mb-6">
          <CheckCircle className="w-10 h-10 text-emerald-500" />
        </div>
        <h1 className="font-display font-black text-2xl text-stone-900 text-center mb-3">Request Submitted</h1>
        <p className="text-sm text-stone-500 text-center mb-10">An agent will contact you shortly.</p>
        <button onClick={() => { reset(); navigate('/') }} className="btn-primary w-full max-w-sm">
          <Home className="w-5 h-5 mr-1" /> Back to Home
        </button>
      </div>
    )
  }

  const repayLabel = loan.repaymentType === 'emi'
    ? `${fmt(loan.monthlyPayment)}/month`
    : loan.repaymentType === 'interest_only'
    ? `${fmt(loan.monthlyPayment)}/mo interest + ${fmt(loan.bulletPayment)} at end`
    : `${fmt(loan.bulletPayment)} at month ${loan.tenureMonths}`
  const totalCustomerCost = loan.totalPayment + loan.safeCustodyInr

  return (
    <div className="page overflow-y-auto no-scrollbar animate-fade-in bg-gradient-to-b from-[#FEFDFC] via-white to-emerald-50/20">
      {/* Branding */}
      <div className="flex justify-center pt-8 pb-2">
        <div className="bg-white py-3 px-5 rounded-2xl shadow-sm border border-stone-100">
          <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-8 object-contain" />
        </div>
      </div>

      <div className="px-5 pb-10 pt-4 space-y-4">
        {/* Success header */}
        <div className="flex flex-col items-center text-center py-4">
          <div className="w-20 h-20 rounded-full bg-emerald-50 border-4 border-emerald-100 flex items-center justify-center mb-4">
            <CheckCircle className="w-10 h-10 text-emerald-500" />
          </div>
          <h1 className="font-display font-black text-2xl text-stone-900 mb-2">Application Submitted!</h1>
          <p className="text-sm text-stone-500 leading-relaxed max-w-sm">
            Your gold loan application has been securely submitted.
            {evalD.serviceable
              ? ' An agent will call you within 2 hours to schedule home gold pickup.'
              : ' Please visit your nearest Poonawalla Fincorp branch to submit your gold.'}
          </p>
        </div>

        {/* Loan summary card */}
        <div className="card p-5 border-brand-600/20 bg-brand-50/40">
          <p className="font-display font-bold text-sm text-stone-900 mb-4">Your Confirmed Loan Terms</p>
          <div className="space-y-3">
            <LoanRow icon={<IndianRupee className="w-4 h-4 text-brand-600" />}
              label="Loan Amount" value={fmt(loan.requestedLoanInr)} bold />
            <LoanRow icon={<TrendingUp className="w-4 h-4 text-brand-600" />}
              label="Annual Interest Rate" value={fmtPct(loan.roiPaPct)} />
            <LoanRow icon={<Calendar className="w-4 h-4 text-brand-600" />}
              label="Tenure" value={`${loan.tenureMonths} months`} />
            <div className="border-t border-brand-200 pt-3">
              <LoanRow icon={<IndianRupee className="w-4 h-4 text-emerald-600" />}
                label="Repayment" value={repayLabel} bold />
            </div>
          </div>
        </div>

        {/* Cost breakdown */}
        <div className="card p-4">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full flex items-center justify-between"
          >
            <span className="text-sm font-medium text-stone-900">Full Cost Breakdown</span>
            {showDetails ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
          </button>
          {showDetails && (
            <div className="mt-3 space-y-2 pt-3 border-t border-stone-100 animate-slide-down">
              {[
                { label: `Gold Value (${evalD.city})`, value: fmt(evalD.cityGoldValueInr) },
                { label: `LTV Range`,               value: evalD.ltvLowPct < evalD.ltvFinalPct ? `${evalD.ltvLowPct}% - ${evalD.ltvFinalPct}%` : `${evalD.ltvFinalPct}%` },
                { label: 'Total Interest',          value: fmt(loan.totalInterest) },
                { label: `Processing Fee (${evalD.processingFeePct}%)`, value: fmt(loan.processingFeeInr) },
                { label: 'GST on Processing (18%)', value: fmt(loan.gstOnFeeInr) },
                ...(loan.stampDutyInr > 0 ? [{ label: `Stamp Duty (${evalD.state})`, value: fmt(loan.stampDutyInr) }] : []),
                { label: `Safe Custody (₹5/g/mo × ${loan.tenureMonths}mo)`, value: `${fmt(loan.safeCustodyInr)} billed separately` },
                { label: 'Net Disbursement',        value: fmt(loan.disbursementInr), bold: true },
                { label: 'Total Repayable',         value: fmt(loan.totalPayment),    bold: true },
                { label: 'Total Customer Cost',      value: fmt(totalCustomerCost),    bold: true },
              ].map((r, i) => (
                <div key={i} className={clsx('flex justify-between items-center', (r as any).bold && 'border-t border-stone-200 pt-2')}>
                  <span className={clsx('text-xs', (r as any).bold ? 'font-bold text-stone-900' : 'text-stone-500')}>{r.label}</span>
                  <span className={clsx('text-sm', (r as any).bold ? 'font-black text-brand-600' : 'font-medium text-stone-800')}>{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Gold + location summary */}
        <div className="card p-4">
          <p className="label mb-3">Assessment Summary</p>
          <div className="space-y-2 text-xs text-stone-600">
            <div className="flex justify-between">
              <span>Gold</span>
              <span className="font-medium">{result.purity.point_estimate_karat}K · {result.weight.estimated_g.toFixed(1)}g</span>
            </div>
            <div className="flex justify-between">
              <span>CIBIL</span>
              <span className="font-medium">{evalD.cibilTierLabel}</span>
            </div>
            <div className="flex justify-between">
              <span>Location</span>
              <span className="font-medium">{evalD.city}, {evalD.state} ({evalD.tierLabel})</span>
            </div>
            <div className="flex justify-between">
              <span>Pickup</span>
              <span className={clsx('font-medium', evalD.serviceable ? 'text-emerald-600' : 'text-amber-600')}>
                {evalD.serviceable ? 'Home Pickup' : 'Branch Visit Required'}
              </span>
            </div>
          </div>
        </div>

        {/* Compliance badges */}
        <div className="flex items-center justify-center gap-3 flex-wrap pt-2">
          <span className="badge-gold">RBI Compliant</span>
          <span className="badge-blue">DPDP 2023</span>
          <span className="flex items-center gap-1 text-[10px] bg-stone-100 text-stone-500 px-2.5 py-1 rounded-full font-medium">
            <Shield className="w-3 h-3" /> PMLA Compliant
          </span>
        </div>
        <p className="text-center text-xs text-stone-400">{state.result && `Trace: ${state.result.audit.trace_id.slice(0, 16)}…`}</p>

        {/* CTA */}
        <button
          onClick={() => { reset(); navigate('/') }}
          className="btn-primary w-full mt-2"
        >
          <Home className="w-5 h-5 mr-1" />
          Back to Home
        </button>
      </div>
    </div>
  )
}

function LoanRow({ icon, label, value, bold = false }: {
  icon: React.ReactNode; label: string; value: string; bold?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon}
        <span className={clsx('text-xs', bold ? 'font-semibold text-stone-800' : 'text-stone-500')}>{label}</span>
      </div>
      <span className={clsx('text-sm', bold ? 'font-black text-brand-600' : 'font-medium text-stone-800')}>{value}</span>
    </div>
  )
}
