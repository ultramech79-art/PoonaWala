import { useState, useCallback } from 'react'
import type { HuidVerificationResult } from '../lib/api'
import type { ConfidenceComputation } from '../lib/confidenceScoring'
import type { ROIComponent } from '../lib/roiEngine'
import type { RepaymentType, AmortizationRow } from '../lib/emiEngine'

export type CaptureType = 'top' | '45deg' | 'side' | 'macro' | 'video' | 'audio' | 'selfie' | 'certificate'

export interface CertificateData {
  source: 'ocr'
  authenticityFound: boolean
  karat: number | null
  weightG: number | null
  huid: string | null
  itemDescription: string | null
  billNumber: string | null
  jewellerName: string | null
  purchaseDate: string | null
  confidence: number
  notes: string[]
}

// ── Evaluation data (FinalEvaluation page output) ─────────────────────────────
export interface EvalData {
  state: string
  city: string
  locationTier: string
  tierLabel: string
  stampDutyInr: number
  serviceable: boolean
  cityGoldValueInr: number        // gold value at real city-specific price
  cityPricePerG: number           // fetched from Times of India city rates
  priceSource: string             // 'timesofindia' | 'ibja_national'
  cibilScore: number | null
  cibilTierKey: string
  cibilTierLabel: string
  pan: string
  ltvFinalPct: number          // final LTV = full RBI tier ceiling (post physical verification)
  ltvLowPct: number            // provisional (offered-now) LTV, scaled by assessment confidence
  tierCeilingPct: number       // nominal RBI tier cap (85 / 80 / 75)
  confidenceScore: number      // assessment confidence (0..1) that drove the provisional LTV
  confidenceFactor: number     // f ∈ [0,1] = (conf − cutoff) / (anchor − cutoff)
  maxLoanInr: number
  provisionalLoanLowInr: number
  ticketTierLabel: string
  ticketTierDescription: string
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

export interface LiveAuthResult {
  video_score: number
  audio_score: number
  combined_score: number
  verdict: string
  video_signals: string[]
  audio_signals: string[]
  purity_estimate: string | null
}

export interface TapTestResult {
  score: number
  label: string
  decay_ms: number
  dominant_freq_hz: number
  reasoning: string
}

export type EvidencePageKey = 'capture' | 'huid' | 'selfie' | 'video' | 'audio' | 'certificate' | 'weight' | 'processing'
export type PageEvidence = Record<string, unknown>

export interface SessionState {
  sessionId: string | null
  authToken: string | null
  userProfile: UserProfile | null
  lang: string
  consentAt: number | null
  phone: string | null
  name: string | null
  captures: Partial<Record<CaptureType, CapturedAsset>>
  skippedCaptures: Partial<Record<CaptureType, boolean>>
  pageEvidence: Partial<Record<EvidencePageKey, PageEvidence>>
  weightG: number | null
  huidCode: string | null
  scannedKarat: number | null
  certificateData: CertificateData | null
  huidVerification: HuidVerificationResult | null
  liveAuthResult: LiveAuthResult | null
  tapTestResult: TapTestResult | null
  result: AssessmentResult | null
  confidenceBreakdown: ConfidenceComputation | null
  evalData: EvalData | null
  loanAppData: LoanAppData | null
}

export interface UserProfile {
  id: string
  phone: string | null
  email: string | null
  full_name: string
  dob: string
  language: string
  region_code: string
  address: string | null
  city: string | null
  pincode: string | null
  profile_photo_url: string | null
  is_phone_verified: boolean
  is_email_verified: boolean
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

const SESSION_STORAGE_KEY = 'goldeye_session_state_v1'

type PersistedCapture = Omit<CapturedAsset, 'blob'>

function dataUrlToBlob(dataUrl: string): Blob {
  try {
    if (!dataUrl.startsWith('data:') || typeof atob === 'undefined') return new Blob([])
    const [header, payload] = dataUrl.split(',', 2)
    const mime = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream'
    const binary = atob(payload || '')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return new Blob([])
  }
}

function serializeState(state: SessionState) {
  const captures = Object.fromEntries(
    Object.entries(state.captures).map(([type, asset]) => [
      type,
      asset
        ? {
            type: asset.type,
            dataUrl: asset.dataUrl,
            timestamp: asset.timestamp,
            exif: asset.exif,
          } satisfies PersistedCapture
        : asset,
    ]),
  )
  return {
    sessionId: state.sessionId,
    lang: state.lang,
    consentAt: state.consentAt,
    phone: state.phone,
    name: state.name,
    captures,
    skippedCaptures: state.skippedCaptures,
    pageEvidence: state.pageEvidence,
    weightG: state.weightG,
    huidCode: state.huidCode,
    scannedKarat: state.scannedKarat,
    certificateData: state.certificateData,
    huidVerification: state.huidVerification,
    liveAuthResult: state.liveAuthResult,
    tapTestResult: state.tapTestResult,
    result: state.result,
    confidenceBreakdown: state.confidenceBreakdown,
    evalData: state.evalData,
    loanAppData: state.loanAppData,
  }
}

function readPersistedState(): Partial<SessionState> {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const captures = Object.fromEntries(
      Object.entries(parsed.captures ?? {}).map(([type, value]) => {
        const asset = value as PersistedCapture | undefined
        if (!asset?.dataUrl) return [type, undefined]
        return [type, { ...asset, blob: dataUrlToBlob(asset.dataUrl) }]
      }),
    ) as Partial<Record<CaptureType, CapturedAsset>>
    return { ...parsed, captures }
  } catch {
    return {}
  }
}

function persistState(state: SessionState) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(serializeState(state)))
  } catch {
    // Captures can exceed browser quota. Keep the critical result/session data.
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...serializeState(state), captures: {} }))
    } catch {}
  }
}

let storedToken = localStorage.getItem('goldeye_auth_token')
let storedProfile = localStorage.getItem('goldeye_user_profile')

if (storedToken === 'guest') {
  localStorage.removeItem('goldeye_auth_token')
  localStorage.removeItem('goldeye_user_profile')
  storedToken = null
  storedProfile = null
}

const persistedState = readPersistedState()

// Simple module-level singleton store (no external dependency)
let _state: SessionState = {
  sessionId: persistedState.sessionId ?? null,
  authToken: storedToken,
  userProfile: JSON.parse(storedProfile || 'null'),
  lang: persistedState.lang ?? localStorage.getItem('goldeye_lang') ?? 'en',
  consentAt: persistedState.consentAt ?? null,
  phone: persistedState.phone ?? null,
  name: persistedState.name ?? null,
  captures: persistedState.captures ?? {},
  skippedCaptures: persistedState.skippedCaptures ?? {},
  pageEvidence: persistedState.pageEvidence ?? {},
  weightG: persistedState.weightG ?? null,
  huidCode: persistedState.huidCode ?? null,
  scannedKarat: persistedState.scannedKarat ?? null,
  certificateData: persistedState.certificateData ?? null,
  huidVerification: persistedState.huidVerification ?? null,
  liveAuthResult: persistedState.liveAuthResult ?? null,
  tapTestResult: persistedState.tapTestResult ?? null,
  result: persistedState.result ?? null,
  confidenceBreakdown: persistedState.confidenceBreakdown ?? null,
  evalData: persistedState.evalData ?? null,
  loanAppData: persistedState.loanAppData ?? null,
}

type Listener = () => void
const listeners = new Set<Listener>()

function getState() { return _state }
function setState(patch: Partial<SessionState>) {
  _state = { ..._state, ...patch }
  persistState(_state)
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
    setAuth: (authToken: string, userProfile: UserProfile) => {
      if (authToken === 'guest') {
        localStorage.removeItem('goldeye_auth_token')
        localStorage.removeItem('goldeye_user_profile')
      } else {
        localStorage.setItem('goldeye_auth_token', authToken)
        localStorage.setItem('goldeye_user_profile', JSON.stringify(userProfile))
      }
      setState({ authToken, userProfile, phone: userProfile.phone, name: userProfile.full_name, lang: userProfile.language })
    },
    clearAuth: () => {
      localStorage.removeItem('goldeye_auth_token')
      localStorage.removeItem('goldeye_user_profile')
      setState({ authToken: null, userProfile: null })
    },
    setLang: (lang: string) => {
      localStorage.setItem('goldeye_lang', lang)
      setState({ lang })
    },
    setConsent: () => setState({ consentAt: Date.now() }),
    setPhone: (phone: string) => setState({ phone }),
    setName: (name: string) => setState({ name }),
    addCapture: (asset: CapturedAsset) => {
      const skippedCaptures = { ..._state.skippedCaptures }
      delete skippedCaptures[asset.type]
      const captures = { ..._state.captures, [asset.type]: asset }
      setState({
        captures,
        skippedCaptures,
        pageEvidence: {
          ..._state.pageEvidence,
          capture: {
            ..._state.pageEvidence.capture,
            capturedTypes: Object.keys(captures),
            skippedTypes: Object.keys(skippedCaptures),
            lastCapturedType: asset.type,
            updatedAt: Date.now(),
          },
        },
      })
    },
    skipCapture: (type: CaptureType) => {
      const captures = { ..._state.captures }
      delete captures[type]
      const skippedCaptures = { ..._state.skippedCaptures, [type]: true }
      setState({
        captures,
        skippedCaptures,
        pageEvidence: {
          ..._state.pageEvidence,
          capture: {
            ..._state.pageEvidence.capture,
            capturedTypes: Object.keys(captures),
            skippedTypes: Object.keys(skippedCaptures),
            lastSkippedType: type,
            updatedAt: Date.now(),
          },
        },
      })
    },
    setPageEvidence: (page: EvidencePageKey, evidence: PageEvidence) => setState({
      pageEvidence: {
        ..._state.pageEvidence,
        [page]: {
          ..._state.pageEvidence[page],
          ...evidence,
          updatedAt: Date.now(),
        },
      },
    }),
    clearPageEvidence: (page: EvidencePageKey) => {
      const pageEvidence = { ..._state.pageEvidence }
      delete pageEvidence[page]
      setState({ pageEvidence })
    },
    setWeight: (g: number | null) => setState({ weightG: g }),
    setHuid: (code: string | null) => setState({ huidCode: code }),
    setHuidVerification: (huidVerification: HuidVerificationResult | null) => setState({ huidVerification }),
    setScannedKarat: (karat: number | null) => setState({ scannedKarat: karat }),
    setCertificateData: (certificateData: CertificateData | null) => setState({ certificateData }),
    setLiveAuthResult: (liveAuthResult: LiveAuthResult | null) => setState({ liveAuthResult }),
    setTapTestResult: (tapTestResult: TapTestResult | null) => setState({ tapTestResult }),
    setResult: (result: AssessmentResult) => setState({ result }),
    setConfidenceBreakdown: (confidenceBreakdown: ConfidenceComputation | null) => setState({ confidenceBreakdown }),
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
      skippedCaptures: {},
      pageEvidence: {},
      weightG: null,
      huidCode: null,
      scannedKarat: null,
      certificateData: null,
      huidVerification: null,
      liveAuthResult: null,
      tapTestResult: null,
      result: null,
      confidenceBreakdown: null,
      evalData: null,
      loanAppData: null,
    }),
    resetAssessment: (sessionId: string | null = null) => setState({
      sessionId,
      consentAt: null,
      captures: {},
      skippedCaptures: {},
      pageEvidence: {},
      weightG: null,
      huidCode: null,
      scannedKarat: null,
      certificateData: null,
      huidVerification: null,
      liveAuthResult: null,
      tapTestResult: null,
      result: null,
      confidenceBreakdown: null,
      evalData: null,
      loanAppData: null,
    }),
  }
}
