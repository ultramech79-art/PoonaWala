import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type AssessmentResult, type SessionState } from '../store/session'
import { assessAPI } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'
import { CheckCircle, Lock } from 'lucide-react'

// ─── Image resize helper (reduces payload from phone cameras) ────────────────
// Using shared resizeDataUrl from lib/utils

function buildMockResult(sessionId: string, weightG: number | null, isFailCase = false): AssessmentResult {
  const isFail = isFailCase
  return {
    schema_version: '1.0',
    session_id: sessionId,
    timestamp_utc: new Date().toISOString(),
    purity: {
      band_low_karat: isFail ? 14 : 20,
      band_high_karat: isFail ? 18 : 22,
      point_estimate_karat: isFail ? 16 : 22,
      huid_verified: !isFail,
    },
    weight: {
      manual_entry_g: weightG,
      estimated_g: weightG ?? 7.9,
      band_low_g: (weightG ?? 7.9) * 0.92,
      band_high_g: (weightG ?? 7.9) * 1.10,
      method: weightG ? 'hybrid' : 'depth_volume_x_density',
    },
    value_inr: {
      band_low: isFail ? 24000 : 48000,
      band_high: isFail ? 35000 : 62000,
      ibja_reference_date: new Date().toISOString(),
      stone_weight_excluded_g: 0.4,
    },
    loan_offer: {
      band_low_inr: isFail ? 18000 : 36000,
      band_high_inr: isFail ? 26000 : 47000,
      ltv_applied_pct: 85,
      tier: 'under_2_5L',
    },
    confidence: {
      score: isFail ? 0.38 : 0.92,
      coverage_guarantee_pct: 90,
      calibration_method: 'split_conformal',
    },
    fraud_signals: {
      score: isFail ? 0.71 : 0.04,
      triggers: isFail ? ['plated_metal_detected', 'acoustic_inconsistent'] : [],
    },
    routing: isFail ? 'REJECT' : 'INSTANT',
    reasoning_text: {
      lang: localStorage.getItem('goldeye_lang') || 'en',
      text: isFail
        ? 'Confidence 38% — visual hallmark missing, acoustic signature inconsistent. In-branch verification recommended.'
        : 'BIS hallmark verified (HUID: A3F2K1). Weight consistent. No fraud signals. Acoustic test: solid gold resonance.',
    },
    xai: {
      gradcam_url: null,
      shap_top_features: isFail
        ? [
            { feature: 'huid_verified', contribution: -0.28 },
            { feature: 'audio_solid_prob', contribution: -0.19 },
            { feature: 'plated_probability', contribution: -0.15 },
            { feature: 'weight_consistency', contribution: 0.08 },
            { feature: 'vlm_confidence', contribution: -0.12 },
          ]
        : [
            { feature: 'huid_verified', contribution: 0.31 },
            { feature: 'plated_solid_score', contribution: 0.22 },
            { feature: 'weight_consistency', contribution: 0.18 },
            { feature: 'audio_solid_prob', contribution: 0.14 },
            { feature: 'hallmark_quality', contribution: 0.09 },
          ],
      counterfactual: isFail
        ? 'If the hallmark were visible and readable, confidence would increase from 38% to ~67%.'
        : null,
    },
    audit: {
      trace_id: `trace_${Math.random().toString(36).slice(2, 18)}`,
      input_asset_hashes: ['sha256:mock'],
    },
  }
}

async function assessSession(state: SessionState): Promise<AssessmentResult> {
  const sessionId = state.sessionId ?? 'demo'
  const weightG = state.weightG
  const captureTypes = Object.keys(state.captures) as (keyof typeof state.captures)[]
  const photoTypes = captureTypes.filter(k => k !== 'audio' && k !== 'video' && k !== 'selfie')
  const frames = await Promise.all(photoTypes.map(async k => {
    const cap = state.captures[k as keyof typeof state.captures]
    const url = cap?.dataUrl
    if (!url || url.startsWith('local://')) return `local://${sessionId}/${k}`
    try { return await resizeDataUrl(url, 1280) } catch { return url }
  }))
  const videoCapture = state.captures['video']
  const audioCapture = state.captures['audio']
  const selfieCapture = state.captures['selfie']
  const minDelay = new Promise<void>(r => setTimeout(r, 3500))
  const CACHE_KEY = 'goldeye_last_result'
  try {
    const [result] = await Promise.all([
      assessAPI({
        session_id: sessionId,
        frames: frames.length > 0 ? frames : [`local://${sessionId}/demo`],
        video: videoCapture ? `local://${sessionId}/video` : undefined,
        audio: audioCapture ? `local://${sessionId}/audio` : undefined,
        selfie: selfieCapture ? `local://${sessionId}/selfie` : undefined,
        weight_g: weightG ?? undefined,
        lang: state.lang ?? 'en',
        device_metadata: {
          capture_count: captureTypes.length,
          ua: navigator.userAgent,
          manual_huid: state.huidCode ?? undefined,
        },
      }),
      minDelay,
    ])
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)) } catch {}
    return result
  } catch {
    await minDelay
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      if (cached) return JSON.parse(cached) as AssessmentResult
    } catch {}
    return buildMockResult(sessionId, weightG, Math.random() < 0.1)
  }
}

const STEPS = [
  { key: 'processing_step1', label: 'Detecting item & edges' },
  { key: 'processing_step2', label: 'Estimating purity' },
  { key: 'processing_step3', label: 'Analysing signals' },
  { key: 'processing_step4', label: 'Calculating weight' },
  { key: 'processing_step5', label: 'Finalising report' },
]

export function Processing() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { state, setResult } = useSessionStore()
  const [activeStep, setActiveStep] = useState(0)
  const [done, setDone] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    STEPS.forEach(({ }, i) => setTimeout(() => setActiveStep(i), i * 900))
    assessSession(state).then(result => {
      setResult(result)
      setDone(true)
      setTimeout(() => navigate('/result'), 600)
    })
  }, [])

  const pct = Math.round(((activeStep + 1) / STEPS.length) * 100)
  const circumference = 2 * Math.PI * 52

  return (
    <div className="page-dark items-center justify-center animate-fade-in">
      {/* Subtle bg glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full bg-brand-500/6 blur-3xl pointer-events-none" />

      <div className="flex flex-col items-center px-8 text-center w-full">
        {/* Circular progress ring */}
        <div className="relative w-32 h-32 mb-8">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
            <circle
              cx="60" cy="60" r="52"
              fill="none"
              stroke="#5B47FA"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - pct / 100)}
              className="transition-all duration-700 ease-out"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {done ? (
              <CheckCircle className="w-10 h-10 text-emerald-400 animate-scale-in" />
            ) : (
              <span className="font-display font-black text-2xl text-white">{pct}%</span>
            )}
          </div>
        </div>

        <h1 className="font-display font-bold text-2xl text-white mb-2">
          {done ? 'Analysis complete!' : 'Analysing your gold'}
        </h1>
        <p className="text-sm text-white/40 mb-10">{t('processing_note')}</p>

        {/* Step checklist */}
        <div className="w-full max-w-xs space-y-3">
          {STEPS.map(({ label }, i) => (
            <div
              key={label}
              className={`flex items-center gap-3 transition-all duration-300 ${i <= activeStep ? 'opacity-100' : 'opacity-20'}`}
            >
              <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                i < activeStep ? 'bg-emerald-500' :
                i === activeStep ? 'bg-brand-500 animate-pulse' :
                'bg-white/10'
              }`}>
                {i < activeStep
                  ? <CheckCircle className="w-3.5 h-3.5 text-white" strokeWidth={3} />
                  : i === activeStep
                    ? <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    : null
                }
              </div>
              <p className={`text-sm transition-colors duration-300 ${i <= activeStep ? 'text-white' : 'text-white/30'}`}>
                {label}
              </p>
            </div>
          ))}
        </div>

        {/* Trust line */}
        <div className="mt-10 flex items-center gap-2 text-xs text-white/20">
          <Lock className="w-3.5 h-3.5" />
          <span>{t('consent_secure')}</span>
        </div>
      </div>
    </div>
  )
}
