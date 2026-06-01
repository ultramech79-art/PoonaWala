import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'framer-motion'
import { useSessionStore } from '../store/session'
import type { CaptureType, CapturedAsset } from '../store/session'
import { generateGradcamMapsAPI } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'
import { useMetalPrices } from '../hooks/useGoldPrice'
import { computeGoldMarketValue, computeLoanOffer } from '../lib/goldCalc'
import { BottomSheet } from '../components/ui/BottomSheet'
import { listVariants, itemVariants } from '../theme/tokens'
import {
  Share2, RefreshCcw, ChevronLeft, ChevronRight,
  Zap, UserCheck, Camera, AlertTriangle, ArrowRight,
  Sparkles, Calculator, ScanLine,
  IndianRupee, BadgeCheck, Video,
} from 'lucide-react'
import { clsx } from 'clsx'

type ItemResultRow = {
  id: string
  label: string
  purity: number
  weightG: number
  stoneDeductionG: number
  netWeightG: number
  ratePerG: number
  purityLabel: string
  valueLow: number
  valueHigh: number
  loanLow: number
  loanHigh: number
  ltvPct: number
  confidencePct: number
  isCurrent: boolean
}

// ── Confidence ring (sheet only) ──────────────────────────────
function ConfidenceRing({ score }: { score: number }) {
  const { t } = useTranslation()
  const r = 40, circ = 2 * Math.PI * r
  const [pct, setPct] = useState(0)
  useEffect(() => { const id = setTimeout(() => setPct(score), 200); return () => clearTimeout(id) }, [score])
  const color = score >= 0.75 ? '#3F8F5B' : score >= 0.55 ? '#A9863A' : '#D4602A'
  const label = score >= 0.75 ? t('confidence_high') : score >= 0.55 ? t('confidence_medium') : t('confidence_low')
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#E3DCCD" strokeWidth="8" />
          <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} className="transition-all duration-[1.1s] ease-out" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-display font-semibold text-[22px] text-stone-900 tnum">{Math.round(pct * 100)}%</span>
        </div>
      </div>
      <span className="text-sm font-semibold mt-2" style={{ color }}>{label}</span>
      <span className="text-xs text-stone-400 mt-0.5">90% coverage</span>
    </div>
  )
}

const normalizeSignalScore = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
}

type SignalTone = 'strong' | 'medium' | 'weak' | 'missing'
type AssessmentSignal = {
  label: string
  score: number | null
  source: string
  detail: string
  icon: typeof Sparkles
}

function toneForScore(score: number | null): SignalTone {
  if (score === null) return 'missing'
  if (score >= 0.75) return 'strong'
  if (score >= 0.55) return 'medium'
  return 'weak'
}

function SignalConfidenceRow({ signal }: { signal: AssessmentSignal }) {
  const tone = toneForScore(signal.score)
  const Icon = signal.icon
  const fillColor =
    tone === 'strong' ? 'bg-emerald-600' :
    tone === 'medium' ? 'bg-gold-500' :
    tone === 'weak' ? 'bg-brand-600' :
    'bg-stone-300'
  const textColor =
    tone === 'strong' ? 'text-emerald-700' :
    tone === 'medium' ? 'text-gold-800' :
    tone === 'weak' ? 'text-brand-700' :
    'text-stone-400'

  return (
    <div className="py-4 border-b border-stone-100 last:border-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-stone-100 text-stone-700">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-[15px] font-black text-stone-950">{signal.label}</p>
              <p className="mt-0.5 text-[12px] font-semibold text-stone-500">{signal.source}</p>
            </div>
            <span className={clsx('font-display text-[18px] font-black tabular-nums', textColor)}>
              {signal.score === null ? '—' : `${Math.round(signal.score * 100)}%`}
            </span>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-stone-100 overflow-hidden">
            <span
              className={clsx('block h-full rounded-full transition-all duration-700 ease-out', fillColor)}
              style={{ width: `${Math.max(6, (signal.score ?? 0) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[12px] leading-snug text-stone-500">{signal.detail}</p>
        </div>
      </div>
    </div>
  )
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

function loanGaugeCeiling(high: number) {
  const target = Math.max(100000, high * 1.1)
  const step =
    target >= 10000000 ? 1000000 :
    target >= 2500000 ? 500000 :
    target >= 1000000 ? 250000 :
    target >= 250000 ? 50000 :
    10000
  return Math.ceil(target / step) * step
}

function shortInr(value: number) {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(value % 10000000 === 0 ? 0 : 1)}Cr`
  if (value >= 100000) return `₹${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L`
  return `₹${Math.round(value / 1000)}K`
}

function arcPoint(pct: number) {
  const radius = 88
  const angle = Math.PI * (1 - pct / 100)
  return {
    x: 120 + radius * Math.cos(angle),
    y: 98 - radius * Math.sin(angle),
  }
}

function LoanBandGauge({
  low,
  high,
  max,
  reduceMotion = false,
}: {
  low: number
  high: number
  max: number
  reduceMotion?: boolean
}) {
  const actualLow = Math.max(0, Math.min(low, high))
  const actualHigh = Math.max(actualLow, high)
  const lowPct = clampPercent((actualLow / max) * 100)
  const highPct = clampPercent((actualHigh / max) * 100)
  const [range, setRange] = useState(() => ({
    start: reduceMotion ? lowPct : 0,
    end: reduceMotion ? highPct : 0,
    settled: reduceMotion,
  }))

  useEffect(() => {
    if (reduceMotion) {
      setRange({ start: lowPct, end: highPct, settled: true })
      return
    }

    setRange({ start: 0, end: 0, settled: false })
    const sweep = window.setTimeout(() => setRange({ start: 0, end: highPct, settled: false }), 120)
    const settle = window.setTimeout(() => setRange({ start: lowPct, end: highPct, settled: true }), 1180)
    return () => {
      window.clearTimeout(sweep)
      window.clearTimeout(settle)
    }
  }, [lowPct, highPct, reduceMotion])

  const width = Math.max(2, range.end - range.start)
  const marker = arcPoint(range.end)
  const startMarker = arcPoint(range.start)

  return (
    <div className={clsx('prequal-loan-gauge', range.settled && 'is-settled')} aria-label={`Eligible loan band ${shortInr(actualLow)} to ${shortInr(actualHigh)}`}>
      <svg className="prequal-loan-gauge-svg" viewBox="0 0 240 124" role="img">
        <defs>
          <linearGradient id="loanBandGradient" x1="32" y1="98" x2="208" y2="98" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#b96b2c" />
            <stop offset="50%" stopColor="#d9a441" />
            <stop offset="100%" stopColor="#f3cf75" />
          </linearGradient>
        </defs>
        <path className="prequal-loan-gauge-track" d="M32 98 A88 88 0 0 1 208 98" pathLength="100" />
        <path
          className="prequal-loan-gauge-band"
          d="M32 98 A88 88 0 0 1 208 98"
          pathLength="100"
          style={{ strokeDasharray: `${width} 100`, strokeDashoffset: -range.start }}
        />
        <circle className="prequal-loan-gauge-start" cx={startMarker.x} cy={startMarker.y} r="4.5" />
        <circle className="prequal-loan-gauge-marker" cx={marker.x} cy={marker.y} r="6.5" />
      </svg>
      <div className="prequal-loan-gauge-center">
        <span>Eligible band</span>
        <b>{shortInr(actualLow)} - {shortInr(actualHigh)}</b>
      </div>
    </div>
  )
}

export function Result() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const reduce = useReducedMotion()

  const ROUTING = {
    INSTANT:   { label: t('routing_instant_label'),   icon: Zap,           action: t('routing_instant_action'),   desc: t('routing_instant_desc'),   tone: '#3F8F5B' },
    AGENT:     { label: t('routing_agent_label'),     icon: UserCheck,     action: t('routing_agent_action'),     desc: t('routing_agent_desc'),     tone: '#743018' },
    RECAPTURE: { label: t('routing_recapture_label'), icon: Camera,        action: t('routing_recapture_action'), desc: t('routing_recapture_desc'), tone: '#A9863A' },
    REJECT:    { label: t('routing_reject_label'),    icon: AlertTriangle, action: t('routing_reject_action'),    desc: t('routing_reject_desc'),    tone: '#574D40' },
  }

  const { state, reset, setResult } = useSessionStore()
  const [sheet, setSheet] = useState<null | 'why' | 'xai' | 'calc' | 'photos'>(null)
  const [generatedFocusUrls, setGeneratedFocusUrls] = useState<Partial<Record<CaptureType, string>>>({})
  const [focusLoading, setFocusLoading] = useState(false)
  const focusAttemptKey = useRef('')
  const { data: metalData } = useMetalPrices()

  const [pricePulse, setPricePulse] = useState(false)
  const prevFetchedAt = useRef<number>(0)
  useEffect(() => {
    const ts = metalData?.fetchedAt ?? 0
    if (ts && ts !== prevFetchedAt.current) {
      prevFetchedAt.current = ts; setPricePulse(true)
      const tm = setTimeout(() => setPricePulse(false), 1000)
      return () => clearTimeout(tm)
    }
  }, [metalData?.fetchedAt])

  const captureOrder: CaptureType[] = ['45deg', 'top', 'side', 'macro', 'selfie', 'certificate']
  const photoCaptures = state.captures
    ? Object.entries(state.captures)
        .filter(([type, c]) => c?.dataUrl && type !== 'video' && type !== 'audio')
        .sort(([a], [b]) => {
          const ai = captureOrder.indexOf(a as CaptureType)
          const bi = captureOrder.indexOf(b as CaptureType)
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
        }) as [CaptureType, CapturedAsset][]
    : []
  const photoCaptureKey = photoCaptures.map(([type, capture]) => `${type}:${capture.timestamp}`).join('|')

  const result = state.result
  useEffect(() => {
    if (sheet !== 'photos' || !result || photoCaptures.length === 0 || focusLoading) return

    const existing = { ...(result.xai.gradcam_urls ?? {}), ...generatedFocusUrls }
    const missing = photoCaptures.filter(([type, capture]) =>
      ['45deg', 'top', 'side', 'macro'].includes(type) &&
      !existing[type] &&
      capture.dataUrl?.startsWith('data:image/')
    )
    if (missing.length === 0) return

    const attemptKey = `${result.session_id}:${missing.map(([type, capture]) => `${type}:${capture.timestamp}`).join('|')}`
    if (focusAttemptKey.current === attemptKey) return
    focusAttemptKey.current = attemptKey

    let cancelled = false
    setFocusLoading(true)
    ;(async () => {
      const frames = Object.fromEntries(await Promise.all(missing.map(async ([type, capture]) => [
        type,
        await resizeDataUrl(capture.dataUrl, 1280, 0.82).catch(() => capture.dataUrl),
      ]))) as Partial<Record<'45deg' | 'top' | 'side' | 'macro', string>>

      const response = await generateGradcamMapsAPI({
        session_id: result.session_id,
        frames,
      })
      if (cancelled) return

      setGeneratedFocusUrls(prev => ({ ...prev, ...response.gradcam_urls }))
      if (Object.keys(response.gradcam_urls).length > 0) {
        setResult({
          ...result,
          xai: {
            ...result.xai,
            gradcam_urls: {
              ...(result.xai.gradcam_urls ?? {}),
              ...response.gradcam_urls,
            },
          },
        })
      }
    })().catch(err => {
      console.warn('[Grad-CAM] Could not generate focus maps:', err)
    }).finally(() => {
      if (!cancelled) setFocusLoading(false)
    })

    return () => { cancelled = true }
  }, [sheet, result?.session_id, photoCaptureKey])

  if (!result) { navigate('/'); return null }

  const effectiveRouting =
    (result.routing === 'RECAPTURE' || result.routing === 'REJECT') && result.confidence.score > 0.47
      ? 'AGENT' : result.routing
  const isFail = effectiveRouting === 'REJECT' || effectiveRouting === 'RECAPTURE'
  const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`

  const livePrice24K = metalData?.metals.find(m => m.id === 'xau_24k')?.price ?? 0
  const livePrice22K = metalData?.metals.find(m => m.id === 'xau_22k')?.price ?? 0
  const livePrice18K = metalData?.metals.find(m => m.id === 'xau_18k')?.price ?? 0
  const livePrice14K = metalData?.metals.find(m => m.id === 'xau_14k')?.price ?? 0
  const livePriceSrc = metalData?.source ?? 'cached'
  const hasLivePrice = livePrice24K > 8000
  const detectedKarat = result.purity.point_estimate_karat
  const livePriceForKarat =
    detectedKarat >= 23 ? livePrice24K :
    detectedKarat >= 21 ? (livePrice22K || livePrice24K * 22 / 24) :
    detectedKarat >= 17 ? (livePrice18K || livePrice24K * 18 / 24) :
    detectedKarat >= 13 ? (livePrice14K || livePrice24K * 14 / 24) :
    livePrice24K * detectedKarat / 24

  const displayValue = hasLivePrice
    ? computeGoldMarketValue(livePriceForKarat, result.weight.estimated_g, detectedKarat, result.value_inr.stone_weight_excluded_g ?? 0.4)
    : { band_low: result.value_inr.band_low, band_high: result.value_inr.band_high }
  const displayLoan = computeLoanOffer(displayValue)

  const routing = ROUTING[effectiveRouting]
  const RoutingIcon = routing.icon
  const gradcamUrls = { ...(result.xai.gradcam_urls ?? {}), ...generatedFocusUrls }
  const focusUrlFor = (type: CaptureType) => gradcamUrls[type] ?? null
  const focusEntries = photoCaptures
    .map(([type]) => ({ type, url: focusUrlFor(type) }))
    .filter((entry): entry is { type: CaptureType; url: string } => Boolean(entry.url))
  const primaryFocus = focusEntries[0] ?? null
  const confidencePct = Math.max(0, Math.min(100, Math.round(result.confidence.score * 100)))
  const primaryActionTarget =
    effectiveRouting === 'AGENT' || effectiveRouting === 'INSTANT'
      ? '/gold-loan-app'
      : effectiveRouting === 'RECAPTURE'
        ? '/capture'
      : '/dashboard-home'
  const loanLow = fmt(displayLoan.band_low_inr)
  const loanHigh = fmt(displayLoan.band_high_inr)
  const marketValueRange = `${fmt(displayValue.band_low)} - ${fmt(displayValue.band_high)}`
  const estimatedWeight = `${result.weight.estimated_g.toFixed(2)}g`
  const assessedItems = [
    {
      sessionId: result.session_id || state.sessionId || 'current',
      result,
      evalData: state.evalData,
      createdAt: result.timestamp_utc || new Date().toISOString(),
    },
    ...(state.assessedItems ?? []).filter(item => item.sessionId !== (result.session_id || state.sessionId)),
  ]
  const itemRows: ItemResultRow[] = assessedItems.map((item, index) => {
    const itemResult = item.result
    const itemKarat = itemResult.purity.point_estimate_karat
    const itemStoneDeduction = itemResult.value_inr.stone_weight_excluded_g || 0
    const itemNetWeight = Math.max(
      itemResult.weight.estimated_g - itemStoneDeduction,
      itemResult.weight.estimated_g * 0.94,
    )
    const itemPurityLabel = itemKarat >= 23 ? '999' : itemKarat >= 21 ? '916' : itemKarat >= 17 ? '750' : itemKarat >= 13 ? '585' : `${Math.round(itemKarat / 24 * 1000)}`
    const itemPriceForKarat =
      itemKarat >= 23 ? livePrice24K :
      itemKarat >= 21 ? (livePrice22K || livePrice24K * 22 / 24) :
      itemKarat >= 17 ? (livePrice18K || livePrice24K * 18 / 24) :
      itemKarat >= 13 ? (livePrice14K || livePrice24K * 14 / 24) :
      livePrice24K * itemKarat / 24
    const itemValue = hasLivePrice && itemPriceForKarat > 0
      ? computeGoldMarketValue(itemPriceForKarat, itemResult.weight.estimated_g, itemKarat, itemResult.value_inr.stone_weight_excluded_g ?? 0.4)
      : { band_low: itemResult.value_inr.band_low, band_high: itemResult.value_inr.band_high }
    const itemLoan = item.evalData
      ? {
          band_low_inr: item.evalData.provisionalLoanLowInr,
          band_high_inr: item.evalData.maxLoanInr,
        }
      : computeLoanOffer(itemValue)
    return {
      id: item.sessionId,
      label: index === 0 ? 'Current jewellery' : `Jewellery ${index + 1}`,
      purity: itemKarat,
      weightG: itemResult.weight.estimated_g,
      stoneDeductionG: itemStoneDeduction,
      netWeightG: itemNetWeight,
      ratePerG: itemPriceForKarat,
      purityLabel: itemPurityLabel,
      valueLow: itemValue.band_low,
      valueHigh: itemValue.band_high,
      loanLow: itemLoan.band_low_inr,
      loanHigh: itemLoan.band_high_inr,
      ltvPct: Math.round((itemLoan.band_high_inr / Math.max(itemValue.band_high, 1)) * 100),
      confidencePct: Math.max(0, Math.min(100, Math.round(itemResult.confidence.score * 100))),
      isCurrent: index === 0,
    }
  })
  const cumulativeValueLow = itemRows.reduce((sum, item) => sum + item.valueLow, 0)
  const cumulativeValueHigh = itemRows.reduce((sum, item) => sum + item.valueHigh, 0)
  const cumulativeLoanLow = itemRows.reduce((sum, item) => sum + item.loanLow, 0)
  const cumulativeLoanHigh = itemRows.reduce((sum, item) => sum + item.loanHigh, 0)
  const hasMultipleItems = itemRows.length > 1
  const aggregateLoanLow = hasMultipleItems ? fmt(cumulativeLoanLow) : loanLow
  const aggregateLoanHigh = hasMultipleItems ? fmt(cumulativeLoanHigh) : loanHigh
  const aggregateLoanRange = `${aggregateLoanLow} - ${aggregateLoanHigh}`
  const aggregateMarketValueRange = hasMultipleItems
    ? `${fmt(cumulativeValueLow)} - ${fmt(cumulativeValueHigh)}`
    : marketValueRange
  const aggregateLtvPct = hasMultipleItems
    ? Math.round((cumulativeLoanHigh / Math.max(cumulativeValueHigh, 1)) * 100)
    : displayLoan.ltv_applied_pct
  const aggregateLoanGaugeMax = loanGaugeCeiling(hasMultipleItems ? cumulativeLoanHigh : displayLoan.band_high_inr)
  const confidenceBreakdown = state.confidenceBreakdown
  const confidenceEvidence = confidenceBreakdown?.evidence
  const componentFor = (id: string) => confidenceBreakdown?.components.find(component => component.id === id)
  const componentScore = (id: string) => normalizeSignalScore(componentFor(id)?.score)
  const huidCode =
    confidenceEvidence?.currentHuid ||
    confidenceEvidence?.billHuid ||
    state.huidVerification?.huid ||
    state.huidCode ||
    state.certificateData?.huid ||
    ''
  const hallmarkScore =
    normalizeSignalScore(state.huidVerification?.confidence) ??
    componentScore('huid') ??
    componentScore('purity') ??
    (result.purity.huid_verified ? normalizeSignalScore(result.confidence.score) : null)
  const hallmarkSource =
    state.huidVerification?.status === 'VERIFIED' ? 'BIS verified' :
    confidenceEvidence?.huidVerified ? 'BIS verified' :
    confidenceEvidence?.photoHuidEvidence ? 'HUID read from photo' :
    confidenceEvidence?.photoKaratEvidence ? 'Karat mark read from macro photo' :
    confidenceEvidence?.huidPresent ? 'HUID supplied, verification pending' :
    huidCode ? 'HUID supplied, verification pending' :
    result.purity.huid_verified ? 'Hallmark evidence detected' :
    'No readable HUID returned'
  const hallmarkDetail = [
    state.huidVerification?.purity || `${detectedKarat}K purity`,
    state.huidVerification?.article_type,
    huidCode ? `HUID ${huidCode}` : null,
  ].filter(Boolean).join(' · ') || 'Derived from the hallmark/HUID evidence captured in this session.'
  const videoScore = normalizeSignalScore(state.liveAuthResult?.video_score ?? confidenceEvidence?.videoScore ?? null)
  const videoSignals = state.liveAuthResult?.video_signals?.filter(Boolean).slice(0, 2) ?? []
  const solidSource = state.liveAuthResult
    ? (state.liveAuthResult.verdict || 'Video authenticity result')
    : confidenceEvidence?.videoScore !== null && confidenceEvidence?.videoScore !== undefined
      ? 'Video confidence from evidence'
      : 'Video test not available'
  const solidDetail = videoSignals.length > 0
    ? videoSignals.join(' · ')
    : state.liveAuthResult
      ? 'Taken from the live video authenticity score for solid vs plated confidence.'
      : 'No live video confidence was returned for this session.'
  const visualComponent = componentFor('images')
  const visualScore = normalizeSignalScore(visualComponent?.score) ?? normalizeSignalScore(result.confidence.score)
  const visualDetail =
    visualComponent?.detail ||
    `${photoCaptures.length} captured image${photoCaptures.length === 1 ? '' : 's'}${primaryFocus ? ' with generated focus maps' : ''}`
  const assessmentSignals: AssessmentSignal[] = [
    {
      label: 'BIS Hallmark',
      score: hallmarkScore,
      source: hallmarkSource,
      detail: hallmarkDetail,
      icon: BadgeCheck,
    },
    {
      label: 'Solid / plated',
      score: videoScore,
      source: solidSource,
      detail: solidDetail,
      icon: Video,
    },
    {
      label: 'Visual AI',
      score: visualScore,
      source: 'Captured photo confidence',
      detail: visualDetail,
      icon: ScanLine,
    },
  ]

  function handlePrimaryAction() {
    navigate(primaryActionTarget)
  }

  const sl = reduce ? {} : { variants: listVariants, initial: 'initial', animate: 'enter' }
  const si = reduce ? {} : { variants: itemVariants }

  return (
    <div className="page no-scrollbar app-page-bg prequal-page-grid">
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header className="page-header sticky top-0 z-20">
        <button id="result-home" onClick={() => { reset(); navigate('/') }}
          className="btn-icon" aria-label="Home">
          <ChevronLeft className="w-5 h-5 text-stone-700" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">{t('result_heading')}</span>
        <button id="result-share"
          onClick={() => navigator.share?.({ title: 'Poonawalla Result', text: 'My gold loan pre-qualification' })}
          className="btn-icon" aria-label="Share">
          <Share2 className="w-[18px] h-[18px] text-stone-700" />
        </button>
      </header>

      <motion.div {...sl} className="result-content px-5 pb-24 pt-4 space-y-5">
        <motion.section {...si} className={clsx('prequal-hero', isFail && 'is-fail')}>
          <div className="relative z-[1] flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <span className="prequal-status-pill">
                <RoutingIcon className="h-3.5 w-3.5" aria-hidden />
                {routing.label}
              </span>
              <p className="prequal-eyebrow">{isFail ? 'Pre-qualification paused' : 'Estimated eligible loan'}</p>
              {!isFail ? (
                <>
                  <h1 className="prequal-amount prequal-amount-range">
                    <span>{aggregateLoanLow}</span>
                    <em>to</em>
                    <span>{aggregateLoanHigh}</span>
                  </h1>
                  <p className="prequal-amount-sub">
                    {hasMultipleItems ? `Aggregated across ${itemRows.length} jewellery items` : 'Eligible loan band after verification'}
                  </p>
                  <LoanBandGauge
                    low={hasMultipleItems ? cumulativeLoanLow : displayLoan.band_low_inr}
                    high={hasMultipleItems ? cumulativeLoanHigh : displayLoan.band_high_inr}
                    max={aggregateLoanGaugeMax}
                    reduceMotion={Boolean(reduce)}
                  />
                </>
              ) : (
                <>
                  <h1 className="prequal-fail-title">{t('fail_heading')}</h1>
                  <p className="prequal-fail-copy">
                    {t('fail_body', { score: confidencePct })}
                  </p>
                </>
              )}
            </div>
            <div className="prequal-route-mark" aria-hidden>
              <span>PF</span>
            </div>
          </div>
        </motion.section>

        <motion.section {...si} className="surface-panel rounded-3xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-stone-500">Aggregated result</p>
              <h2 className="mt-1 font-display text-xl font-black text-stone-950">
                {aggregateLoanRange}
              </h2>
              <p className="mt-1 text-xs font-semibold text-stone-500">
                {itemRows.length} jewellery item{itemRows.length === 1 ? '' : 's'} calculated separately
              </p>
            </div>
            <div className="rounded-2xl bg-brand-50 px-3 py-2 text-right">
              <p className="text-[10px] font-black uppercase tracking-wider text-brand-700">Gold value</p>
              <p className="mt-0.5 text-xs font-black text-stone-900">{aggregateMarketValueRange}</p>
            </div>
          </div>

          <div className="mt-4 flex gap-3 overflow-x-auto pb-1 no-scrollbar snap-x snap-mandatory">
            {itemRows.map(item => (
              <div key={item.id} className={clsx('min-w-[86%] snap-start rounded-3xl border p-4', item.isCurrent ? 'border-brand-200 bg-brand-50/60' : 'border-stone-200 bg-white')}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-400">{item.label}</p>
                    <h3 className="mt-1 font-display text-xl font-black text-stone-950">{fmt(item.loanLow)} - {fmt(item.loanHigh)}</h3>
                  </div>
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-black text-brand-700 shadow-sm">
                    {item.ltvPct}% LTV
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-xl bg-white/80 px-2.5 py-2">
                    <p className="text-[10px] font-semibold text-stone-400">Purity</p>
                    <p className="mt-0.5 text-sm font-black text-stone-900">{item.purity}K</p>
                  </div>
                  <div className="rounded-xl bg-white/80 px-2.5 py-2">
                    <p className="text-[10px] font-semibold text-stone-400">Weight</p>
                    <p className="mt-0.5 text-sm font-black text-stone-900">{item.weightG.toFixed(2)}g</p>
                  </div>
                  <div className="rounded-xl bg-white/80 px-2.5 py-2">
                    <p className="text-[10px] font-semibold text-stone-400">Confidence</p>
                    <p className="mt-0.5 text-sm font-black text-stone-900">{item.confidencePct}%</p>
                  </div>
                </div>

                <div className="mt-3 rounded-2xl bg-white/80 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-black uppercase tracking-wider text-stone-400">Calculation share</span>
                    <span className="text-xs font-black text-stone-700">{fmt(item.valueHigh)} value</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{ width: `${Math.max(8, Math.min(100, (item.loanHigh / Math.max(cumulativeLoanHigh, 1)) * 100))}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] font-semibold text-stone-500">
                    Loan cap {fmt(item.loanHigh)} contributes to aggregate {fmt(cumulativeLoanHigh)}.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </motion.section>

        {hasLivePrice && (
          <motion.section {...si} className="prequal-rate-card">
            <div className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold-50 text-gold-800">
                  <IndianRupee className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <div>
                  <p className="font-display text-[15px] font-black text-stone-950">Live gold rate</p>
                  <p className="text-[11px] text-stone-500">IBJA reference prices per gram</p>
                </div>
              </div>
              <span className={clsx('rounded-full px-2.5 py-1 text-[10px] font-black transition-all', pricePulse ? 'bg-success text-white' : 'bg-emerald-50 text-emerald-700')}>
                {livePriceSrc === 'live' ? '● Live' : 'Cached'}
              </span>
            </div>
            <div className="grid grid-cols-3">
              {[['24K', livePrice24K], ['22K', livePrice22K], ['18K', livePrice18K]].filter(([, p]) => (p as number) > 0).map(([k, p]) => (
                <div key={k as string} className="prequal-rate-cell">
                  <p>{k as string}</p>
                  <b>₹{Math.round(p as number).toLocaleString('en-IN')}<span>/g</span></b>
                </div>
              ))}
            </div>
          </motion.section>
        )}

        <motion.section {...si}>
          <div className="prequal-valuation-card">
            <button
              id="result-breakdown-quick"
              type="button"
              onClick={() => setSheet('calc')}
              className="prequal-valuation-action"
            >
              <span className="prequal-calc-icon">
                <Calculator className="h-4 w-4" aria-hidden />
              </span>
              <span className="prequal-calc-copy">
                <b>Calculation breakdown</b>
                <small>Market value {aggregateMarketValueRange}</small>
              </span>
              <span className="prequal-calc-view">View</span>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <div className="prequal-valuation-meta" aria-label="Evaluation inputs">
              <span>{detectedKarat}K gold</span>
              <span>{hasMultipleItems ? `${itemRows.length} items` : estimatedWeight}</span>
              <span>{aggregateLtvPct}% LTV</span>
              <span>{hasLivePrice ? 'Live IBJA' : 'IBJA ref'}</span>
            </div>
          </div>
        </motion.section>

        <motion.section {...si} className="space-y-3">
          <SectionLabel title="Supporting details" subtitle="Tap a row for the exact explanation." />
          <div className="surface-panel rounded-3xl overflow-hidden">
            <DetailRow id={undefined} icon={Sparkles} label="Why this estimate"
              hint={`${confidencePct}% calibrated confidence`}
              iconBg="#F5E9D9" iconColor="#8B650C" onClick={() => setSheet('why')} />
            <DetailRow id="result-xai-toggle" icon={ScanLine} label={t('xai_heading')}
              hint="Confidence signals · Grad-CAM focus"
              iconBg="#F5E9D9" iconColor="#8B650C" onClick={() => setSheet('xai')} last={photoCaptures.length === 0} />
            {photoCaptures.length > 0 && (
              <DetailRow icon={Camera} label="Captured photos"
                hint={focusLoading ? 'Generating focus maps...' : focusEntries.length > 0 ? `${photoCaptures.length} images · ${focusEntries.length} focus maps` : `${photoCaptures.length} raw images`}
                iconBg="#F5E9D9" iconColor="#8B650C" onClick={() => setSheet('photos')} last />
            )}
          </div>
        </motion.section>

        <motion.div {...si}>
          <button
            id="result-retry"
            type="button"
            onClick={() => { reset(); navigate('/setup') }}
            className="prequal-retry-button"
          >
            <RefreshCcw className="w-4 h-4" /> {t('result_retry')}
          </button>
        </motion.div>

        <motion.div {...si} className="pb-12 text-center">
          <div className="mb-5 h-px bg-stone-200" />
          <p className="text-[12px] text-stone-400">{t('footer_rbi')} · {t('footer_dpdp')}</p>
          <p className="mt-1 text-[11px] text-stone-400">{t('powered_by')}</p>
        </motion.div>
      </motion.div>

      <div
        className="sticky bottom-0 z-20 px-5 py-3 bg-white/90 backdrop-blur-xl border-t border-stone-200/70"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <button
          id="result-primary-action"
          onClick={handlePrimaryAction}
          className="w-full py-4 rounded-2xl bg-charcoal text-white font-display font-black text-base shadow-cta active:scale-[0.98] transition-transform flex items-center justify-center gap-2.5"
        >
          {routing.action}
          <ArrowRight className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* ════ BOTTOM SHEETS ══════════════════════════════════════════ */}
      {/* Why this estimate */}
      <BottomSheet open={sheet === 'why'} onClose={() => setSheet(null)} title="Why this estimate">
        <div className="flex gap-5 items-start mb-5">
          <ConfidenceRing score={result.confidence.score} />
          <p className="text-[14px] text-stone-600 leading-relaxed flex-1 pt-2">{result.reasoning_text.text}</p>
        </div>
        <div className="px-4 py-3.5 rounded-2xl text-[13px] text-stone-600 leading-relaxed" style={{ background: '#F5E9D9' }}>
          Confidence is conformally calibrated to a <span className="font-semibold text-stone-800">90% coverage</span> guarantee —
          the true value falls inside the shown band 9 times out of 10.
        </div>
      </BottomSheet>

      {/* XAI */}
      <BottomSheet open={sheet === 'xai'} onClose={() => setSheet(null)} title={t('xai_heading')}>
        <p className="text-[13px] text-stone-500 mb-3">Confidence values from the evidence captured in this session.</p>
        <div className="rounded-3xl border border-stone-200 bg-white px-4 shadow-[0_14px_40px_rgba(87,77,64,0.08)]">
          {assessmentSignals.map(signal => <SignalConfidenceRow key={signal.label} signal={signal} />)}
        </div>
        {primaryFocus && (
          <div className="mt-5 pt-4 border-t border-stone-100">
            <p className="text-[12px] font-semibold text-stone-400 uppercase tracking-wider mb-2">AI Focus Heatmap (Grad-CAM)</p>
            <div className="relative w-full rounded-2xl overflow-hidden bg-stone-900 aspect-video">
              <img src={primaryFocus.url} className="w-full h-full object-cover" alt="Grad-CAM heatmap" />
              <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white/90 backdrop-blur">
                {primaryFocus.type} focus
              </span>
            </div>
            <p className="text-[11px] text-stone-400 mt-2 leading-relaxed">
              <span className="text-rose-500 font-semibold">Warm zones</span> show the visual evidence used for the assessment.
            </p>
          </div>
        )}
        <p className="text-[10px] text-stone-400 font-mono break-all mt-5 pt-3 border-t border-stone-100">trace: {result.audit.trace_id}</p>
      </BottomSheet>

      {/* Calculation breakdown */}
      <BottomSheet open={sheet === 'calc'} onClose={() => setSheet(null)} title="Calculation breakdown">
        <div className="rounded-2xl border border-brand-200 bg-brand-50/70 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-700">Aggregate</p>
          <div className="mt-2 space-y-0">
            <CalcRow label="Jewellery items" value={`${itemRows.length}`} />
            <CalcRow label="Total gross weight" value={`${itemRows.reduce((sum, item) => sum + item.weightG, 0).toFixed(2)} g`} />
            <CalcRow label="Total net gold weight" value={`${itemRows.reduce((sum, item) => sum + item.netWeightG, 0).toFixed(2)} g`} tone="text-stone-900 font-semibold" />
            <CalcRow label="Market value range" value={aggregateMarketValueRange} />
            <CalcRow label={`Loan range (${aggregateLtvPct}% blended LTV)`} value={aggregateLoanRange} tone="text-brand-600 font-semibold" />
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {itemRows.map(item => (
            <div key={item.id} className={clsx('rounded-2xl border p-3', item.isCurrent ? 'border-brand-200 bg-brand-50/50' : 'border-stone-200 bg-white')}>
              <div className="mb-1 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-400">{item.label}</p>
                  <p className="mt-0.5 font-display text-base font-black text-stone-950">{fmt(item.loanLow)} - {fmt(item.loanHigh)}</p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-brand-700 shadow-sm">{item.ltvPct}% LTV</span>
              </div>
              <div className="space-y-0">
                <CalcRow label="Gross weight" value={`${item.weightG.toFixed(2)} g`} />
                <CalcRow label="Net gold weight" value={`${item.netWeightG.toFixed(2)} g`} tone="text-stone-900 font-semibold" />
                <CalcRow label="Purity (AI)" value={`${item.purity}K (${(item.purity / 24 * 100).toFixed(1)}%)`} />
                {hasLivePrice && item.ratePerG > 0 && (
                  <CalcRow label={`IBJA ${item.purity}K rate (${item.purityLabel})`} value={`${fmt(item.ratePerG)}/g`} tone="text-success font-semibold" />
                )}
                <CalcRow label="Market value range" value={`${fmt(item.valueLow)} - ${fmt(item.valueHigh)}`} />
                <CalcRow label={`Loan range (${item.ltvPct}% LTV)`} value={`${fmt(item.loanLow)} - ${fmt(item.loanHigh)}`} tone="text-brand-600 font-semibold" />
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-stone-400 leading-snug mt-4 pt-4 border-t border-stone-100">
          * Value = IBJA price × net weight × (karat / 24) ± 7% · LTV capped at 75% per RBI/2023-24/107
        </p>
      </BottomSheet>

      {/* Photos */}
      <BottomSheet open={sheet === 'photos'} onClose={() => setSheet(null)} title="Captured photos">
        {primaryFocus && (
          <div className="relative mb-4 overflow-hidden rounded-[1.35rem] border border-stone-200 bg-stone-950 shadow-[0_16px_40px_rgba(41,32,24,0.16)]">
            <img src={primaryFocus.url} alt="Primary Grad-CAM focus" className="h-56 w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/18 to-transparent p-4">
              <span className="inline-flex rounded-full bg-white/16 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/90 backdrop-blur">
                Computed focus
              </span>
              <p className="mt-2 font-display text-[18px] font-black leading-tight text-white">
                Ornament focus mapped on the {primaryFocus.type} view
              </p>
            </div>
          </div>
        )}
        <p className="text-[13px] text-stone-500 mb-4 leading-relaxed">
          {focusLoading
            ? 'Generating focus maps for these captures. Each tile will switch from raw photo to Grad-CAM as soon as it is ready.'
            : focusEntries.length > 0
            ? 'Heat overlays are generated on matching captured views so the assessed ornament stays clear while the coin remains only a scale reference.'
            : 'Showing the raw captures for this saved result. Run a fresh assessment to generate per-photo focus maps for these views.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {photoCaptures.map(([type, capture]) => (
            <FocusPhotoCard key={type} type={type} capture={capture} focusUrl={focusUrlFor(type)} loading={focusLoading && !focusUrlFor(type)} />
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}

// ── Small helpers ──────────────────────────────────────────────
function FocusPhotoCard({ type, capture, focusUrl, loading = false }: { type: CaptureType; capture: CapturedAsset; focusUrl: string | null; loading?: boolean }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-2xl bg-stone-100 shadow-[0_10px_24px_rgba(41,32,24,0.08)]">
      <img src={focusUrl || capture.dataUrl} alt={`${type} ${focusUrl ? 'Grad-CAM focus' : 'capture'}`} className="h-full w-full object-cover" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-stone-950/28 backdrop-blur-[1px]">
          <span className="rounded-full bg-white/92 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-stone-800 shadow-lg">
            Generating
          </span>
        </div>
      )}
      {focusUrl && (
        <img
          src={capture.dataUrl}
          alt={`${type} original`}
          className="absolute right-2 top-2 h-12 w-12 rounded-xl border border-white/70 object-cover shadow-lg"
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/62 via-black/12 to-transparent p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full bg-white/18 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white backdrop-blur-sm">
            {type}
          </span>
          <span className="rounded-full bg-black/28 px-2 py-1 text-[9px] font-bold text-white/85 backdrop-blur-sm">
            {focusUrl ? 'Focus map' : loading ? 'Working' : 'Raw'}
          </span>
        </div>
      </div>
    </div>
  )
}

function CalcRow({ label, value, tone = 'text-stone-700' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between items-center py-3 border-b border-stone-100 last:border-0 gap-4">
      <span className="text-[14px] text-stone-500">{label}</span>
      <span className={clsx('text-[14px] tnum text-right', tone)}>{value}</span>
    </div>
  )
}

function SectionLabel({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="prequal-section-label">
      <p>{title}</p>
      {subtitle && <span>{subtitle}</span>}
    </div>
  )
}

function DetailRow({ id, icon: Icon, label, hint, iconBg, iconColor, onClick, last = false }: {
  id?: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  label: string; hint?: string; iconBg: string; iconColor: string; onClick: () => void; last?: boolean
}) {
  return (
    <button id={id} onClick={onClick}
      className={clsx('w-full flex items-center gap-3.5 px-5 py-4 text-left active:opacity-60 transition-opacity', !last && 'border-b border-stone-100')}>
      <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: iconBg }}>
        <Icon className="w-[18px] h-[18px]" style={{ color: iconColor }} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium text-stone-900">{label}</span>
        {hint && <span className="block text-[12px] text-stone-400 truncate">{hint}</span>}
      </span>
      <ChevronRight className="w-4 h-4 text-stone-300 shrink-0" />
    </button>
  )
}
