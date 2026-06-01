import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'framer-motion'
import { useSessionStore } from '../store/session'
import { useMetalPrices } from '../hooks/useGoldPrice'
import { computeGoldMarketValue, computeLoanOffer } from '../lib/goldCalc'
import { BottomSheet } from '../components/ui/BottomSheet'
import { listVariants, itemVariants } from '../theme/tokens'
import {
  Share2, RefreshCcw, ChevronLeft, ChevronRight,
  Zap, UserCheck, Camera, AlertTriangle, ArrowRight,
  Sparkles, Calculator, ScanLine,
  IndianRupee,
} from 'lucide-react'
import { clsx } from 'clsx'

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

// ── SHAP bar ───────────────────────────────────────────────────
function ContributionBar({ feature, contribution }: { feature: string; contribution: number }) {
  const { t } = useTranslation()
  const pct = Math.min(Math.abs(contribution) * 200, 50)
  const pos = contribution > 0
  const labels: Record<string, string> = {
    huid_verified: t('signal_huid'), plated_solid_score: t('signal_plated_solid'),
    weight_consistency: t('signal_weight'), hallmark_quality: t('signal_hallmark'),
    plated_probability: t('signal_plated_prob'), vlm_confidence: t('signal_vlm'),
  }
  if (feature === 'audio_solid_prob' || feature === 'video_signal') return null
  return (
    <div className="flex items-center gap-3 py-3 border-b border-stone-100 last:border-0">
      <p className="text-[14px] text-stone-600 w-32 flex-shrink-0">{labels[feature] || feature}</p>
      <div className="flex-1 h-1.5 rounded-full bg-stone-100 relative overflow-hidden">
        <span className="absolute left-1/2 top-0 h-full w-px bg-stone-200" />
        <div className={clsx('absolute top-0 h-full rounded-full', pos ? 'bg-success right-1/2' : 'bg-brand-500 left-1/2')} style={{ width: `${pct}%` }} />
      </div>
      <span className={clsx('text-[13px] font-mono w-10 text-right font-semibold tnum', pos ? 'text-success' : 'text-brand-600')}>
        {pos ? '+' : ''}{(contribution * 100).toFixed(0)}%
      </span>
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

  const { state, reset } = useSessionStore()
  const [sheet, setSheet] = useState<null | 'why' | 'xai' | 'calc' | 'photos'>(null)
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

  const result = state.result
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
  const purityLabel = detectedKarat >= 23 ? '999' : detectedKarat >= 21 ? '916' : detectedKarat >= 17 ? '750' : detectedKarat >= 13 ? '585' : `${Math.round(detectedKarat / 24 * 1000)}`
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
  const photoCaptures = state.captures
    ? Object.entries(state.captures).filter(([type, c]) => c?.dataUrl && type !== 'video' && type !== 'audio')
    : []
  const confidencePct = Math.max(0, Math.min(100, Math.round(result.confidence.score * 100)))
  const nextStepTitle =
    effectiveRouting === 'INSTANT' ? 'Continue your gold loan application'
    : effectiveRouting === 'AGENT' ? 'Schedule a doorstep verification'
    : effectiveRouting === 'RECAPTURE' ? 'Retake sharper gold photos'
    : 'Get help from a branch specialist'
  const routeShortLabel =
    effectiveRouting === 'INSTANT' ? 'Instant route'
    : effectiveRouting === 'AGENT' ? 'Agent visit'
    : effectiveRouting === 'RECAPTURE' ? 'Retake photos'
    : 'Branch help'
  const primaryActionTarget =
    effectiveRouting === 'AGENT' || effectiveRouting === 'INSTANT'
      ? '/final-eval'
      : effectiveRouting === 'RECAPTURE'
        ? '/capture'
      : '/dashboard-home'
  const loanLow = fmt(displayLoan.band_low_inr)
  const loanHigh = fmt(displayLoan.band_high_inr)
  const loanRange = `${loanLow} - ${loanHigh}`
  const marketValueRange = `${fmt(displayValue.band_low)} - ${fmt(displayValue.band_high)}`
  const estimatedWeight = `${result.weight.estimated_g.toFixed(2)}g`

  function handlePrimaryAction() {
    navigate(primaryActionTarget)
  }

  const sl = reduce ? {} : { variants: listVariants, initial: 'initial', animate: 'enter' }
  const si = reduce ? {} : { variants: itemVariants }

  return (
    <div className="page no-scrollbar app-page-bg">
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
                    <span>{loanLow}</span>
                    <em>to</em>
                    <span>{loanHigh}</span>
                  </h1>
                  <p className="prequal-amount-sub">Eligible loan band after verification</p>
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

          <div className="prequal-hero-stats">
            <button type="button" className="prequal-hero-stat" onClick={() => setSheet('calc')}>
              <span>LTV ratio</span>
              <b>Up to {displayLoan.ltv_applied_pct}%</b>
            </button>
            <button type="button" className="prequal-hero-stat" onClick={() => setSheet('calc')}>
              <span>Est. weight</span>
              <b>{estimatedWeight}</b>
            </button>
            <button type="button" className="prequal-hero-stat" onClick={() => setSheet('why')}>
              <span>Confidence</span>
              <b>{confidencePct}%</b>
            </button>
          </div>
        </motion.section>

        <motion.section {...si} className="prequal-next-card">
          <div className="flex items-start gap-3">
            <span className="prequal-next-icon">
              <RoutingIcon className="h-5 w-5" style={{ color: routing.tone }} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-stone-600">Next best step</p>
              <h2 className="mt-1 font-display text-[20px] font-black leading-tight text-stone-950">{nextStepTitle}</h2>
              <p className="mt-1.5 text-[13px] leading-snug text-stone-600">{routing.desc}</p>
            </div>
          </div>
          <button id="result-primary-action" onClick={handlePrimaryAction} className="prequal-primary-action">
            {routing.action}
            <ArrowRight className="h-5 w-5" aria-hidden />
          </button>
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
                <small>Market value {marketValueRange}</small>
              </span>
              <span className="prequal-calc-view">View</span>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <div className="prequal-valuation-meta" aria-label="Evaluation inputs">
              <span>{detectedKarat}K gold</span>
              <span>{estimatedWeight}</span>
              <span>{displayLoan.ltv_applied_pct}% LTV</span>
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
              hint="SHAP signals · Grad-CAM heatmap"
              iconBg="#F5E9D9" iconColor="#8B650C" onClick={() => setSheet('xai')} last={photoCaptures.length === 0} />
            {photoCaptures.length > 0 && (
              <DetailRow icon={Camera} label="Captured photos"
                hint={`${photoCaptures.length} images · AI focus map`}
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
        <p className="text-[13px] text-stone-500 mb-3">How each signal pushed the estimate up or down.</p>
        {result.xai.shap_top_features.map(f => <ContributionBar key={f.feature} feature={f.feature} contribution={f.contribution} />)}
        {result.xai.gradcam_url && (
          <div className="mt-5 pt-4 border-t border-stone-100">
            <p className="text-[12px] font-semibold text-stone-400 uppercase tracking-wider mb-2">AI Focus Heatmap (Grad-CAM)</p>
            <div className="relative w-full rounded-2xl overflow-hidden bg-stone-900 aspect-video">
              <img src={result.xai.gradcam_url} className="w-full h-full object-cover" alt="Grad-CAM heatmap" />
              <div className="absolute inset-0 pointer-events-none" style={{
                background: 'radial-gradient(circle at 40% 50%, rgba(239,68,68,0.5) 0%, rgba(245,158,11,0.28) 30%, rgba(59,130,246,0.1) 60%, transparent 100%)',
                mixBlendMode: 'screen',
              }} />
              <div className="absolute inset-0 bg-black/10 mix-blend-multiply pointer-events-none" />
            </div>
            <p className="text-[11px] text-stone-400 mt-2 leading-relaxed">
              <span className="text-rose-500 font-semibold">Red zones</span> — hallmark stamp, purity marks, surface texture.
            </p>
          </div>
        )}
        <p className="text-[10px] text-stone-400 font-mono break-all mt-5 pt-3 border-t border-stone-100">trace: {result.audit.trace_id}</p>
      </BottomSheet>

      {/* Calculation breakdown */}
      <BottomSheet open={sheet === 'calc'} onClose={() => setSheet(null)} title="Calculation breakdown">
        <div className="space-y-0">
          <CalcRow label="Gross weight" value={`${result.weight.estimated_g.toFixed(2)} g`} />
          <CalcRow label="Stone deduction" value={`− ${(result.value_inr.stone_weight_excluded_g || 0).toFixed(2)} g`} tone="text-error" />
          <CalcRow label="Net gold weight" value={`${Math.max(result.weight.estimated_g - (result.value_inr.stone_weight_excluded_g || 0), result.weight.estimated_g * 0.94).toFixed(2)} g`} tone="text-stone-900 font-semibold" />
          <CalcRow label="Purity (AI)" value={`${detectedKarat}K  (${(detectedKarat / 24 * 100).toFixed(1)}%)`} />
          {hasLivePrice && <>
            <CalcRow label={`IBJA ${detectedKarat}K rate (${purityLabel})`} value={`₹${livePriceForKarat.toLocaleString('en-IN')}/g`} tone="text-success font-semibold" />
          </>}
          <CalcRow label="Market value range" value={marketValueRange} />
          <CalcRow label={`Loan range (${displayLoan.ltv_applied_pct}% LTV)`} value={loanRange} tone="text-brand-600 font-semibold" />
        </div>
        <p className="text-[10px] text-stone-400 leading-snug mt-4 pt-4 border-t border-stone-100">
          * Value = IBJA price × net weight × (karat / 24) ± 7% · LTV capped at 75% per RBI/2023-24/107
        </p>
      </BottomSheet>

      {/* Photos */}
      <BottomSheet open={sheet === 'photos'} onClose={() => setSheet(null)} title="Captured photos">
        <p className="text-[13px] text-stone-500 mb-4 leading-relaxed">
          Hover / tap to reveal Grad-CAM focus — <span className="text-rose-500 font-semibold">red zones</span> show hallmark clarity and authenticity regions.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {photoCaptures.map(([type, capture]) => (
            <div key={type} className="rounded-2xl overflow-hidden bg-stone-100 aspect-square relative group">
              <img src={capture!.dataUrl} alt={type} className="w-full h-full object-cover" />
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                style={{ background: 'radial-gradient(circle at 50% 45%, rgba(239,68,68,0.38) 0%, rgba(245,158,11,0.2) 35%, transparent 70%)', mixBlendMode: 'screen' }} />
              <span className="absolute bottom-2 left-2 text-[10px] font-medium text-white/90 capitalize px-2 py-0.5 rounded-full bg-black/30 backdrop-blur-sm">{type}</span>
            </div>
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}

// ── Small helpers ──────────────────────────────────────────────
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
