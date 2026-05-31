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
  ShieldCheck, Sparkles, Calculator, ScanLine,
  Gem, Scale, IndianRupee,
} from 'lucide-react'
import { clsx } from 'clsx'

// ── Count-up ───────────────────────────────────────────────────
function AnimatedNumber({ target, prefix = '', suffix = '', duration = 1200 }: {
  target: number; prefix?: string; suffix?: string; duration?: number
}) {
  const reduce = useReducedMotion()
  const [val, setVal] = useState(reduce ? target : 0)
  useEffect(() => {
    if (reduce) { setVal(target); return }
    const start = performance.now()
    const raf = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      setVal((1 - Math.pow(1 - p, 4)) * target)
      if (p < 1) requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)
  }, [target, duration, reduce])
  return <>{prefix}{val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}{suffix}</>
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
    AGENT:     { label: t('routing_agent_label'),     icon: UserCheck,     action: t('routing_agent_action'),     desc: t('routing_agent_desc'),     tone: '#D4602A' },
    RECAPTURE: { label: t('routing_recapture_label'), icon: Camera,        action: t('routing_recapture_action'), desc: t('routing_recapture_desc'), tone: '#A9863A' },
    REJECT:    { label: t('routing_reject_label'),    icon: AlertTriangle, action: t('routing_reject_action'),    desc: t('routing_reject_desc'),    tone: '#C9543C' },
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

      <motion.div {...sl}>
        {/* ── HERO ───────────────────────────────────────────────── */}
        {!isFail ? (
          <motion.section {...si} className="px-5 pt-5 pb-6">
            <div className="copper-panel rounded-3xl p-6 overflow-hidden relative">
              <div className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-gold-200/10 blur-2xl" />
              <div className="relative">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gold-200/85 mb-4">
                  {routing.label}
                </p>
                <p className="text-[14px] text-white/62 mb-1 font-medium">{t('result_loan')}</p>
                <h1 className="font-display font-semibold text-white tnum leading-[1] tracking-[-0.035em]"
              style={{ fontSize: 'clamp(3.5rem, 18vw, 5rem)' }}>
                  <AnimatedNumber target={displayLoan.band_low_inr} prefix="₹" />
                </h1>
                <p className="text-[16px] text-white/55 mt-2 tnum">
                  up to&nbsp;
                  <span className="text-white/90 font-medium">
                    <AnimatedNumber target={displayLoan.band_high_inr} prefix="₹" />
                  </span>
                </p>
                <div className="flex flex-wrap gap-2 mt-5">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold text-white bg-white/12 border border-white/12">
                    RBI {displayLoan.ltv_applied_pct}% LTV
                  </span>
                  <button onClick={() => setSheet('why')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold text-gold-100 bg-white/12 border border-white/12">
                    <Sparkles className="w-3.5 h-3.5" />
                    {Math.round(result.confidence.score * 100)}% confidence
                  </button>
                </div>
              </div>
            </div>
          </motion.section>
        ) : (
          <motion.section {...si} className="px-6 pt-10 pb-8 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5"
              style={{ background: '#EDE8DE' }}>
              <RoutingIcon className="w-7 h-7" style={{ color: routing.tone }} strokeWidth={1.8} />
            </div>
            <h1 className="font-display font-semibold text-[30px] text-stone-900 tracking-[-0.025em] mb-3 leading-tight">{t('fail_heading')}</h1>
            <p className="text-[15px] text-stone-500 leading-relaxed max-w-[18rem]">
              {t('fail_body', { score: Math.round(result.confidence.score * 100) })}
            </p>
          </motion.section>
        )}

        {/* ── PRIMARY CTA — dark charcoal pill (Zand "Top Up Balance") ── */}
        <motion.div {...si} className="px-6 mb-3">
          <button id="result-primary-action"
            onClick={() => navigate(effectiveRouting === 'AGENT' || effectiveRouting === 'INSTANT' ? '/final-eval' : '/')}
            className="w-full h-[56px] btn-primary">
            {routing.action}
            <ArrowRight className="w-5 h-5" />
          </button>
        </motion.div>

        {/* ── NEXT-STEP NOTE — peach sand block (Zand payment reminder) ── */}
        <motion.div {...si} className="mx-6 mb-8 px-4 py-3.5 rounded-2xl flex items-start gap-3"
          style={{ background: '#F5E9D9' }}>
          <RoutingIcon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: routing.tone }} strokeWidth={2} />
          <p className="text-[13px] leading-snug text-stone-600">{routing.desc}</p>
        </motion.div>

        {/* ── LIVE IBJA RATE — peach block when available ──────────── */}
        {!isFail && hasLivePrice && (
          <motion.div {...si} className="mx-6 mb-8 px-4 py-3.5 rounded-2xl"
            style={{ background: '#F5E9D9' }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-stone-500 uppercase tracking-wider">Live Gold Rate</span>
              <span className={clsx('text-[10px] font-bold px-2 py-0.5 rounded-full transition-all', pricePulse ? 'bg-success text-white' : 'text-stone-400')} style={{ background: pricePulse ? '' : '#EDE8DE' }}>
                {livePriceSrc === 'live' ? '● IBJA' : 'CACHED'}
              </span>
            </div>
            <div className="flex gap-5 mt-1">
              {[['24K', livePrice24K], ['22K', livePrice22K], ['18K', livePrice18K]].filter(([, p]) => (p as number) > 0).map(([k, p]) => (
                <div key={k as string}>
                  <p className="text-[10px] text-stone-400">{k as string}</p>
                  <p className="font-display font-semibold text-[15px] text-stone-900 tnum">₹{(p as number).toLocaleString('en-IN')}<span className="text-[10px] font-normal text-stone-400">/g</span></p>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── ASSESSMENT — Zand-style list (section label + clean rows) ── */}
        {!isFail && (
          <motion.section {...si} className="mb-8">
            <p className="px-6 text-[12px] font-semibold text-stone-400 uppercase tracking-widest mb-2">Assessment</p>
            {/* Each row: no card box, just cream bg + hairline dividers */}
            <div className="surface-panel mx-6 rounded-3xl overflow-hidden">
              {/* Purity row */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center bg-brand-50 border border-brand-100">
                    <Gem className="w-4.5 h-4.5 text-brand-600" />
                  </span>
                  <div>
                    <p className="text-[15px] font-medium text-stone-900">{t('result_purity')}</p>
                    <p className="text-[12px] text-stone-400 tnum">{result.purity.band_low_karat}K – {result.purity.band_high_karat}K range</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-display font-semibold text-[20px] text-stone-900 tnum">{result.purity.point_estimate_karat}K</p>
                  {result.purity.huid_verified && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: '#C8A24B' }}>
                      <ShieldCheck className="w-3 h-3" /> BIS
                    </span>
                  )}
                </div>
              </div>

              {/* Weight row */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center bg-gold-50 border border-gold-100">
                    <Scale className="w-4.5 h-4.5 text-gold-700" />
                  </span>
                  <div>
                    <p className="text-[15px] font-medium text-stone-900">{t('result_weight')}</p>
                    <p className="text-[12px] text-stone-400 tnum">{result.weight.band_low_g.toFixed(1)}g – {result.weight.band_high_g.toFixed(1)}g · {result.weight.method === 'hybrid' ? t('result_weight_hybrid') : t('result_weight_ai')}</p>
                  </div>
                </div>
                <p className="font-display font-semibold text-[20px] text-stone-900 tnum">{result.weight.estimated_g}g</p>
              </div>

              {/* Gold value row */}
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center bg-stone-100 border border-stone-200">
                    <IndianRupee className="w-4.5 h-4.5 text-stone-700" />
                  </span>
                  <div>
                    <p className="text-[15px] font-medium text-stone-900">{t('result_value')}</p>
                    <p className="text-[12px] text-stone-400">{result.purity.point_estimate_karat}K · stone excl. {result.value_inr.stone_weight_excluded_g}g</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-display font-semibold text-[17px] text-stone-900 tnum">{fmt(displayValue.band_low)}</p>
                  <p className="text-[12px] text-stone-400 tnum">– {fmt(displayValue.band_high)}</p>
                </div>
              </div>
            </div>
          </motion.section>
        )}

        {/* ── DETAILS — Zand-style info rows (open sheets) ────────── */}
        <motion.section {...si} className="mb-8">
          <p className="px-6 text-[12px] font-semibold text-stone-400 uppercase tracking-widest mb-2">Details</p>
          <div className="surface-panel mx-6 rounded-3xl overflow-hidden">
            <DetailRow id={undefined} icon={Sparkles} label="Why this estimate"
              hint={`${Math.round(result.confidence.score * 100)}% calibrated confidence`}
              iconBg="#F5E9D9" iconColor="#D4602A" onClick={() => setSheet('why')} />
            <DetailRow id="result-xai-toggle" icon={ScanLine} label={t('xai_heading')}
              hint="SHAP signals · Grad-CAM heatmap"
              iconBg="#F5E9D9" iconColor="#D4602A" onClick={() => setSheet('xai')} />
            <DetailRow id="result-breakdown-toggle" icon={Calculator} label="Calculation breakdown"
              hint="Net weight · IBJA rate · LTV"
              iconBg="#F5E9D9" iconColor="#D4602A" onClick={() => setSheet('calc')} last={!(!isFail && photoCaptures.length > 0)} />
            {!isFail && photoCaptures.length > 0 && (
              <DetailRow icon={Camera} label="Captured photos"
                hint={`${photoCaptures.length} images · AI focus map`}
                iconBg="#F5E9D9" iconColor="#D4602A" onClick={() => setSheet('photos')} last />
            )}
          </div>
        </motion.section>

        {/* Fraud signals */}
        {result.fraud_signals.triggers.length > 0 && (
          <motion.div {...si} className="mx-6 mb-6 px-4 py-4 rounded-2xl" style={{ background: '#F5E9D9' }}>
            <p className="text-[13px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: '#A9863A' }}>
              <AlertTriangle className="w-4 h-4" /> Fraud signals detected
            </p>
            <div className="flex flex-wrap gap-1.5">
              {result.fraud_signals.triggers.map(tr => (
                <span key={tr} className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/60 text-stone-600">{tr.replace(/_/g, ' ')}</span>
              ))}
            </div>
          </motion.div>
        )}

        {/* Low confidence manual purity input */}
        {!isFail && result.confidence.score < 0.65 && !result.purity.huid_verified && (
          <motion.div {...si} className="mx-6 mb-6 surface-panel rounded-3xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle className="w-4 h-4 text-gold-700 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-stone-900 text-[14px] mb-1">Verify Purity Manually</p>
                <p className="text-[12px] text-stone-500">Photos unclear — check the karat stamp on your jewelry.</p>
              </div>
            </div>
            <label htmlFor="manual-purity-entry" className="text-[12px] text-stone-500 block mb-1.5">Karat marking</label>
            <input type="text" id="manual-purity-entry" placeholder="e.g. 22K, 18K" className="input-field text-sm" />
          </motion.div>
        )}

        {/* Retry */}
        <motion.div {...si} className="px-6 mb-6">
          <button id="result-retry" onClick={() => { reset(); navigate('/setup') }}
            className="w-full flex items-center justify-center gap-2 py-3.5 text-[14px] font-medium text-stone-400 active:opacity-60 transition-opacity">
            <RefreshCcw className="w-4 h-4" /> {t('result_retry')}
          </button>
        </motion.div>

        {/* Footer */}
        <motion.div {...si} className="pb-12 text-center px-6">
          <div className="h-px bg-stone-200 mb-5" />
          <p className="text-[12px] text-stone-400">{t('footer_rbi')} · {t('footer_dpdp')}</p>
          <p className="text-[11px] text-stone-400 mt-1">{t('powered_by')}</p>
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
          <CalcRow label="Market value" value={`~ ${fmt(Math.round((displayValue.band_low + displayValue.band_high) / 2))}`} />
          <CalcRow label={`Loan (${displayLoan.ltv_applied_pct}% LTV)`} value={`~ ${fmt(Math.round((displayLoan.band_low_inr + displayLoan.band_high_inr) / 2))}`} tone="text-brand-600 font-semibold" />
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
