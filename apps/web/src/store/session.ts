import { useState, useCallback } from 'react'
import type { LTVComponent } from '../lib/ltvEngine'
import type { ROIComponent } from '../lib/roiEngine'
import type { RepaymentType, AmortizationRow } from '../lib/emiEngine'

export type CaptureType = 'top' | '45deg' | 'side' | 'macro' | 'video' | 'audio' | 'selfie'

// ── Evaluation data (FinalEvaluation page output) ─────────────────────────────
export interface EvalData {
  state: string
  city: string
  locationTier: string
  tierLabel: string
  stampDutyInr: number
  serviceable: boolean
  cityGoldValueInr: number        // gold value at real city-specific price
  cityPricePerG: number           // fetched from allindiabullion.com
  priceSource: string             // 'allindiabullion.com' | 'ibja_national'
  cibilScore: number | null
  cibilTierKey: string
  cibilTierLabel: string
  pan: string
  ltvFinalPct: number
  maxLoanInr: number
  ltvComponents: LTVComponent[]
  ticketTierLabel: string
  processingFeePct: number
  eligible: boolean
  rejectReason: string | null
}

// ── Loan application data (GoldLoanApplication page output) ───────────────────
export interface LoanAppData {
  requestedLoanInr: number
  tenureMonths: number
  repaymentType: RepaymentType
  roiPaPct: number
  roiComponents: ROIComponent[]
  monthlyPayment: number
  bulletPayment: number
  totalInterest: number
  totalPayment: number
  processingFeeInr: number
  gstOnFeeInr: number
  stampDutyInr: number
  safeCustodyInr: number
  disbursementInr: number
  schedule: AmortizationRow[]
}

export interface CapturedAsset {
  type: CaptureType
  dataUrl: string
  blob: Blob
  timestamp: number
  exif?: Record<string, unknown>
}

export interface SessionState {
  sessionId: string | null
  lang: string
  consentAt: number | null
  phone: string | null
  name: string | null
  captures: Partial<Record<CaptureType, CapturedAsset>>
  weightG: number | null
  huidCode: string | null
  scannedKarat: number | null
  result: AssessmentResult | null
  evalData: EvalData | null
  loanAppData: LoanAppData | null
}

export interface PurityBand {
  band_low_karat: number
  band_high_karat: number
  point_estimate_karat: number
  huid_verified: boolean
}

export interface WeightBand {
  manual_entry_g: number | null
  estimated_g: number
  band_low_g: number
  band_high_g: number
  method: string
}

export interface ValueBand {
  band_low: number
  band_high: number
  ibja_reference_date: string
  stone_weight_excluded_g: number
}

export interface LoanBand {
  band_low_inr: number
  band_high_inr: number
  ltv_applied_pct: number
  tier: string
}

export interface Confidence {
  score: number
  coverage_guarantee_pct: number
  calibration_method: string
}

export interface SHAPFeature {
  feature: string
  contribution: number
}

export interface AssessmentResult {
  schema_version: string
  session_id: string
  timestamp_utc: string
  purity: PurityBand
  weight: WeightBand
  value_inr: ValueBand
  loan_offer: LoanBand
  confidence: Confidence
  fraud_signals: { score: number; triggers: string[] }
  routing: 'INSTANT' | 'AGENT' | 'RECAPTURE' | 'REJECT'
  reasoning_text: { lang: string; text: string }
  xai: {
    gradcam_url: string | null
    shap_top_features: SHAPFeature[]
    counterfactual: string | null
  }
  audit: { trace_id: string; input_asset_hashes: string[] }
}

// Simple module-level singleton store (no external dependency)
let _state: SessionState = {
  sessionId: null,
  lang: localStorage.getItem('goldeye_lang') || 'en',
  consentAt: null,
  phone: null,
  name: null,
  captures: {},
  weightG: null,
  huidCode: null,
  scannedKarat: null,
  result: null,
  evalData: null,
  loanAppData: null,
}

type Listener = () => void
const listeners = new Set<Listener>()

function getState() { return _state }
function setState(patch: Partial<SessionState>) {
  _state = { ..._state, ...patch }
  listeners.forEach(l => l())
}

export function useSessionStore() {
  const [, forceUpdate] = useState(0)

  const subscribe = useCallback(() => {
    const listener = () => forceUpdate(n => n + 1)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])

  // Auto-subscribe
  useState(() => subscribe())

  return {
    state: getState(),
    setLang: (lang: string) => {
      localStorage.setItem('goldeye_lang', lang)
      setState({ lang })
    },
    setConsent: () => setState({ consentAt: Date.now() }),
    setPhone: (phone: string) => setState({ phone }),
    setName: (name: string) => setState({ name }),
    addCapture: (asset: CapturedAsset) => {
      setState({ captures: { ..._state.captures, [asset.type]: asset } })
    },
    setWeight: (g: number | null) => setState({ weightG: g }),
    setHuid: (code: string | null) => setState({ huidCode: code }),
    setScannedKarat: (karat: number | null) => setState({ scannedKarat: karat }),
    setResult: (result: AssessmentResult) => setState({ result }),
    setEvalData: (evalData: EvalData) => setState({ evalData }),
    setLoanAppData: (loanAppData: LoanAppData) => setState({ loanAppData }),
    setSessionId: (id: string) => setState({ sessionId: id }),
    initSession: () => {
      const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      setState({ sessionId: id })
      return id
    },
    reset: () => setState({
      sessionId: null,
      consentAt: null,
      phone: null,
      captures: {},
      weightG: null,
      huidCode: null,
      scannedKarat: null,
      result: null,
      evalData: null,
      loanAppData: null,
    }),
  }
}
