import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import {
  Share2, RefreshCcw, ChevronRight, ChevronDown, ChevronUp,
  Info, Zap, UserCheck, Camera, AlertTriangle, CheckCircle,
  TrendingUp, ArrowRight
} from 'lucide-react'
import { clsx } from 'clsx'

// ── Animated counter ──────────────────────────────────────────
function AnimatedNumber({ target, prefix = '', suffix = '', duration = 1200 }: {
  target: number; prefix?: string; suffix?: string; duration?: number
}) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    const start = performance.now()
    const frame = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setVal(Math.round(eased * target))
      if (progress < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, [target, duration])
  return <>{prefix}{val.toLocaleString('en-IN')}{suffix}</>
}

// ── Confidence ring ────────────────────────────────────────────
function ConfidenceRing({ score }: { score: number }) {
  const { t } = useTranslation()
  const r = 42, circ = 2 * Math.PI * r
  const [pct, setPct] = useState(0)
  useEffect(() => { setTimeout(() => setPct(score), 300) }, [score])
  const color = score >= 0.75 ? '#10b981' : score >= 0.55 ? '#f59e0b' : '#f97316'
  const label = score >= 0.75 ? t('confidence_high') : score >= 0.55 ? t('confidence_medium') : t('confidence_low')

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-20 h-20">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#E5E7EB" strokeWidth="8" />
          <circle
            cx="50" cy="50" r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - pct)}
            className="transition-all duration-[1.2s] ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display font-black text-lg text-stone-900">
            {Math.round(pct * 100)}%
          </span>
        </div>
      </div>
      <span className="text-xs font-semibold mt-1.5" style={{ color }}>{label}</span>
      <span className="text-[10px] text-stone-400 mt-0.5">90% coverage</span>
    </div>
  )
}

// ── SHAP bar ───────────────────────────────────────────────────
function SHAPBar({ feature, contribution }: { feature: string; contribution: number }) {
  const { t } = useTranslation()
  const pct = Math.abs(contribution) * 200
  const pos = contribution > 0
  const labels: Record<string, string> = {
    huid_verified: t('signal_huid'),
    plated_solid_score: t('signal_plated_solid'),
    weight_consistency: t('signal_weight'),
    audio_solid_prob: t('signal_audio'),
    hallmark_quality: t('signal_hallmark'),
    plated_probability: t('signal_plated_prob'),
    vlm_confidence: t('signal_vlm'),
  }
  return (
    <div className="flex items-center gap-3 py-1.5">
      <p className="text-xs text-stone-500 w-28 flex-shrink-0">{labels[feature] || feature}</p>
      <div className="flex-1 flex items-center gap-1">
        <div className="flex-1 h-2 rounded-full bg-stone-100 relative overflow-hidden">
          <div
            className={clsx('absolute top-0 h-full rounded-full transition-all duration-700', pos ? 'bg-emerald-500 right-1/2' : 'bg-red-400 left-1/2')}
            style={{ width: `${Math.min(pct, 50)}%` }}
          />
        </div>
      </div>
      <span className={clsx('text-xs font-mono w-10 text-right font-semibold', pos ? 'text-emerald-600' : 'text-red-500')}>
        {pos ? '+' : ''}{(contribution * 100).toFixed(0)}%
      </span>
    </div>
  )
}

export function Result() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const ROUTING = {
    INSTANT: {
      label: t('routing_instant_label'),
      icon: Zap,
      colorClass: 'text-emerald-700',
      bgClass: 'bg-emerald-50',
      borderClass: 'border-emerald-200',
      action: t('routing_instant_action'),
      desc: t('routing_instant_desc'),
    },
    AGENT: {
      label: t('routing_agent_label'),
      icon: UserCheck,
      colorClass: 'text-brand-700',
      bgClass: 'bg-brand-50',
      borderClass: 'border-brand-200',
      action: t('routing_agent_action'),
      desc: t('routing_agent_desc'),
    },
    RECAPTURE: {
      label: t('routing_recapture_label'),
      icon: Camera,
      colorClass: 'text-amber-700',
      bgClass: 'bg-amber-50',
      borderClass: 'border-amber-200',
      action: t('routing_recapture_action'),
      desc: t('routing_recapture_desc'),
    },
    REJECT: {
      label: t('routing_reject_label'),
      icon: AlertTriangle,
      colorClass: 'text-orange-700',
      bgClass: 'bg-orange-50',
      borderClass: 'border-orange-200',
      action: t('routing_reject_action'),
      desc: t('routing_reject_desc'),
    },
  }
  const { state, reset } = useSessionStore()
  const [showXAI, setShowXAI] = useState(false)

  const result = state.result
  if (!result) { navigate('/'); return null }

  const routing = ROUTING[result.routing]
  const RoutingIcon = routing.icon
  const isFail = result.routing === 'REJECT' || result.routing === 'RECAPTURE'
  const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`

  return (
    <div className="page overflow-y-auto no-scrollbar animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <button id="result-home" onClick={() => { reset(); navigate('/') }} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">{t('result_heading')}</span>
        <button
          id="result-share"
          onClick={() => navigator.share?.({ title: 'Poonawalla Result', text: 'My gold loan pre-qualification' })}
          className="btn-icon"
        >
          <Share2 className="w-4 h-4 text-stone-500" />
        </button>
      </div>

      {/* Routing banner */}
      <div className={clsx('mx-5 mt-4 mb-4 p-4 rounded-2xl border flex items-start gap-3', routing.bgClass, routing.borderClass)}>
        <div className={clsx('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0', routing.bgClass)}>
          <RoutingIcon className={clsx('w-5 h-5', routing.colorClass)} strokeWidth={2} />
        </div>
        <div>
          <h2 className={clsx('font-display font-bold text-base', routing.colorClass)}>{routing.label}</h2>
          <p className="text-xs text-stone-500 mt-0.5 leading-snug">{routing.desc}</p>
        </div>
      </div>

      {/* Happy path */}
      {!isFail && (
        <>
          {/* Purity + Weight cards */}
          <div className="px-5 mb-4 grid grid-cols-2 gap-3">
            <div className="card p-4">
              <p className="label mb-2">{t('result_purity')}</p>
              <div className="font-display font-black text-3xl text-stone-900">
                <AnimatedNumber target={result.purity.point_estimate_karat} suffix="K" />
              </div>
              <p className="text-xs text-stone-400 mt-1">
                {result.purity.band_low_karat}K – {result.purity.band_high_karat}K band
              </p>
              {result.purity.huid_verified && (
                <span className="badge-green mt-2">
                  <CheckCircle className="w-3 h-3" /> BIS Verified
                </span>
              )}
            </div>
            <div className="card p-4">
              <p className="label mb-2">{t('result_weight')}</p>
              <div className="font-display font-black text-3xl text-stone-900">
                <AnimatedNumber target={result.weight.estimated_g} suffix="g" />
              </div>
              <p className="text-xs text-stone-400 mt-1">
                {result.weight.band_low_g.toFixed(1)}g – {result.weight.band_high_g.toFixed(1)}g
              </p>
              <p className="text-[10px] text-stone-400 mt-1">
                {result.weight.method === 'hybrid' ? t('result_weight_hybrid') : t('result_weight_ai')}
              </p>
            </div>
          </div>

          {/* Gold value band */}
          <div className="mx-5 mb-4">
            <div className="card p-5">
              <div className="flex items-center justify-between mb-2">
                <p className="label">{t('result_value')}</p>
                <span className="text-xs text-stone-400">IBJA ref price</span>
              </div>
              <div className="font-display font-black text-3xl text-stone-900 mb-1">
                <AnimatedNumber target={result.value_inr.band_low} prefix="₹" />
                <span className="text-stone-300 text-xl mx-2">–</span>
                <AnimatedNumber target={result.value_inr.band_high} prefix="₹" />
              </div>
              <div className="band-track mt-3">
                <div className="band-fill bg-gold-400" style={{ width: '100%' }} />
              </div>
              <p className="text-xs text-stone-400 mt-2">
                Stone weight ({result.value_inr.stone_weight_excluded_g}g) excluded
              </p>
            </div>
          </div>

          {/* Loan offer */}
          <div className="mx-5 mb-4">
            <div className="card p-5 border-brand-200 bg-brand-50">
              <p className="label mb-2">{t('result_loan')}</p>
              <div className="font-display font-black text-4xl text-brand-700 mb-0.5 leading-none">
                <AnimatedNumber target={result.loan_offer.band_low_inr} prefix="₹" duration={1400} />
              </div>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-stone-400 text-lg">–</span>
                <span className="font-display font-bold text-2xl text-stone-700">
                  <AnimatedNumber target={result.loan_offer.band_high_inr} prefix="₹" duration={1400} />
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="badge-brand">{result.loan_offer.ltv_applied_pct}% LTV</span>
                <span className="badge-brand">Under ₹2.5L tier</span>
              </div>
            </div>
          </div>

          {/* Confidence + reasoning */}
          <div className="mx-5 mb-4">
            <div className="card p-5">
              <div className="flex items-center gap-5">
                <ConfidenceRing score={result.confidence.score} />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-stone-700 mb-1.5 uppercase tracking-wider">Why this estimate</p>
                  <p className="text-xs text-stone-500 leading-relaxed">{result.reasoning_text.text}</p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Fail path */}
      {isFail && (
        <div className="mx-5 mb-4">
          <div className="card p-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8 text-orange-500" strokeWidth={1.8} />
            </div>
            <h2 className="font-display font-bold text-xl text-stone-900 mb-2">{t('fail_heading')}</h2>
            <p className="text-sm text-stone-500 leading-relaxed mb-5">
              {t('fail_body', { score: Math.round(result.confidence.score * 100) })}
            </p>
            <ConfidenceRing score={result.confidence.score} />
          </div>
        </div>
      )}

      {/* XAI accordion */}
      <div className="mx-5 mb-4">
        <button
          id="result-xai-toggle"
          onClick={() => setShowXAI(!showXAI)}
          className="w-full card flex items-center justify-between p-4"
        >
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-brand-500" />
            <span className="text-sm font-medium text-stone-900">{t('xai_heading')}</span>
          </div>
          {showXAI
            ? <ChevronUp className="w-4 h-4 text-stone-400" />
            : <ChevronDown className="w-4 h-4 text-stone-400" />
          }
        </button>

        {showXAI && (
          <div className="card mt-1 p-4 animate-slide-down">
            <p className="label mb-3">SHAP Feature Attribution</p>
            {result.xai.shap_top_features.map(f => (
              <SHAPBar key={f.feature} feature={f.feature} contribution={f.contribution} />
            ))}
            <div className="mt-4 pt-3 border-t border-stone-100">
              <p className="text-[10px] text-stone-400 font-mono break-all">
                trace: {result.audit.trace_id}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Fraud signals */}
      {result.fraud_signals.triggers.length > 0 && (
        <div className="mx-5 mb-4">
          <div className="card p-4 border-orange-200 bg-orange-50">
            <p className="text-xs font-semibold text-orange-600 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> Fraud signals detected
            </p>
            <div className="flex flex-wrap gap-1.5">
              {result.fraud_signals.triggers.map(t => (
                <span key={t} className="badge-orange text-[10px]">{t.replace(/_/g, ' ')}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* CTAs */}
      <div className="mx-5 mb-4 space-y-3">
        <button
          id="result-primary-action"
          onClick={() => navigate(result.routing === 'AGENT' || result.routing === 'INSTANT' ? '/confirmation' : '/')}
          className="btn-primary w-full"
        >
          {routing.action}
          <ArrowRight className="w-5 h-5" />
        </button>
        <button
          id="result-retry"
          onClick={() => { reset(); navigate('/setup') }}
          className="btn-secondary w-full text-sm flex items-center justify-center gap-2"
        >
          <RefreshCcw className="w-4 h-4" />
          {t('result_retry')}
        </button>
      </div>

      {/* Footer */}
      <div className="px-5 pb-8">
        <div className="divider mb-5" />
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <span className="badge-gold">{t('footer_rbi')}</span>
          <span className="badge-blue">{t('footer_dpdp')}</span>
        </div>
        <p className="text-center text-xs text-stone-400 mt-3">{t('powered_by')}</p>
      </div>
    </div>
  )
}
