import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type CaptureType } from '../store/session'
import { Camera } from '../components/Camera'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { ChevronRight, Volume2, CheckCircle, XCircle, Loader2, RotateCcw, Music, Video, Shield, Info, ChevronDown, ImageIcon, PlayCircle } from 'lucide-react'
import { speak, prefetchSpeech } from '../lib/tts'
import { clsx } from 'clsx'
import { evaluateFrameAPI, listMyAssetsAPI, urlToDataUrl, verifyHuidAPI, uploadUserAssetAPI, type FrameEvalResult, type HuidVerificationResult, type UserAsset } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'

interface Step {
  type: CaptureType
  titleKey: string
  hintKey: string
  voiceGuide: string
  demoUrl?: string
  isVideo?: boolean
  isAudio?: boolean
  facingMode?: 'environment' | 'user'
  optional?: boolean
}

type EvalState = 'idle' | 'evaluating' | 'approved' | 'rejected'

interface StepEval {
  state: EvalState
  result?: FrameEvalResult
  dataUrl?: string
}

const WEIGHT_VIEW_TYPES = new Set<CaptureType>(['top', '45deg', 'side'])

function isWeightView(type: CaptureType) {
  return WEIGHT_VIEW_TYPES.has(type)
}

/**
 * Returns the reference image to compare against for each step.
 * Strategy: always anchor to the FIRST captured frame (45deg), so a user
 * cannot swap jewelry after any step. If 45deg isn't captured yet (shouldn't
 * happen since it's step 0), fall back to top.
 */
function referenceForStep(
  stepType: CaptureType,
  captures: Partial<Record<CaptureType, { dataUrl: string }>>,
) {
  // The first step (45deg) has nothing to compare against — it IS the reference.
  if (stepType === '45deg') {
    return { referenceFrameType: 'top', referenceImageDataUrl: undefined }
  }

  // For every subsequent step, always compare against 45deg (the anchor).
  // This prevents swapping the item between any two steps.
  const angleReference = captures['45deg']?.dataUrl
  if (angleReference) {
    return { referenceFrameType: '45deg', referenceImageDataUrl: angleReference }
  }

  // Fallback: use top if somehow 45deg is missing
  const topReference = captures.top?.dataUrl
  return { referenceFrameType: 'top', referenceImageDataUrl: topReference }
}


export function CaptureFlow() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const {
    addCapture,
    skipCapture,
    state,
    setScannedKarat,
    setHuid,
    setHuidVerification,
    setPageEvidence,
    initSession,
  } = useSessionStore()

  const STEPS: Step[] = [
    {
      type: '45deg',
      titleKey: 'step_45_title',
      hintKey: 'step_45_hint',
      voiceGuide: t('voice_45deg'),
      demoUrl: '/assets/demo/45deg.jpg',
    },
    {
      type: 'top',
      titleKey: 'step_top_title',
      hintKey: 'step_top_hint',
      voiceGuide: t('voice_top'),
      demoUrl: '/assets/demo/top.jpg',
    },
    {
      type: 'side',
      titleKey: 'step_side_title',
      hintKey: 'step_side_hint',
      voiceGuide: t('voice_side'),
      demoUrl: '/assets/demo/side.jpg',
    },
    {
      type: 'selfie',
      titleKey: 'step_selfie_title',
      hintKey: 'step_selfie_hint',
      voiceGuide: t('voice_selfie'),
      facingMode: 'user',
      demoUrl: '/assets/demo/selfie.jpg',
      optional: true,
    },
    {
      type: 'macro',
      titleKey: 'step_macro_title',
      hintKey: 'step_macro_hint',
      voiceGuide: t('voice_macro'),
      demoUrl: '/assets/demo/macro.jpg',
    },
  ]

  const STEP_LABELS = [
    t('step_label_45'), t('step_label_top'), t('step_label_side'),
    t('step_label_selfie'), t('step_label_hallmark'),
  ]

  const getInitialStep = () => {
    for (let i = 0; i < STEPS.length; i++) {
      if (!state.captures[STEPS[i].type]) return i
    }
    return STEPS.length - 1
  }

  const [stepIdx, setStepIdx] = useState(getInitialStep)
  const [captured, setCaptured] = useState<Set<number>>(new Set(
    STEPS.map((s, i) => state.captures[s.type] ? i : -1).filter(i => i !== -1)
  ))
  const [evals, setEvals] = useState<Record<number, StepEval>>(() => {
    const initialEvals: Record<number, StepEval> = {}
    STEPS.forEach((s, i) => {
      const cap = state.captures[s.type]
      if (cap) {
        initialEvals[i] = {
          state: 'approved',
          dataUrl: cap.dataUrl,
          result: { approved: true, quality_score: 1.0, feedback: '', issues: [], detected: {} }
        }
      }
    })
    return initialEvals
  })
  const [cameraKey, setCameraKey] = useState(0)
  const [showDemo, setShowDemo] = useState(false)
  const [showTutorial, setShowTutorial] = useState(true)  // auto-show on first step
  const [showManualHuid, setShowManualHuid] = useState(false)
  const [manualHuid, setManualHuid] = useState(state.huidCode || '')
  const [selectedKarat, setSelectedKarat] = useState<number | null>(state.scannedKarat || null)
  const [activeTab, setActiveTab] = useState<'scan' | 'manual'>('scan')
  const [showHallmarkGuide, setShowHallmarkGuide] = useState(false)
  const [huidVerifying, setHuidVerifying] = useState(false)
  const [huidVerifyResult, setHuidVerifyResult] = useState<HuidVerificationResult | null>(state.huidVerification ?? null)
  const spokenStep = useRef(-1)
  const [previousAssets, setPreviousAssets] = useState<UserAsset[]>([])
  const [loadingPrevious, setLoadingPrevious] = useState(false)
  const step = STEPS[stepIdx]

  // Fetch previously uploaded images from user's profile
  useEffect(() => {
    if (!state.authToken) return
    let cancelled = false
    setLoadingPrevious(true)
    listMyAssetsAPI(state.authToken)
      .then(assets => {
        if (!cancelled) {
          setPreviousAssets(assets.filter(a =>
            a.public_url &&
            a.frame_type &&
            isWeightView(a.frame_type as CaptureType) &&
            (a.asset_kind === 'verified_view' || a.asset_kind === 'jewellery_capture')
          ))
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingPrevious(false) })
    return () => { cancelled = true }
  }, [state.authToken])

  // Find previous upload for current step
  const previousForStep = previousAssets.find(a => a.frame_type === step.type)

  const currentEval = evals[stepIdx]
  const evalState = currentEval?.state ?? 'idle'
  const sameItemMismatch = currentEval?.result?.issues?.includes('same_item_mismatch') ?? false
  const visibleIssues = currentEval?.result?.issues?.filter(issue => issue !== 'same_item_mismatch') ?? []

  useEffect(() => {
    // Eagerly prefetch all voice guides to eliminate network delay
    STEPS.forEach(s => prefetchSpeech(s.voiceGuide))
  }, [t])

  useEffect(() => {
    if (spokenStep.current === stepIdx) return
    spokenStep.current = stepIdx
    speak(step.voiceGuide)
  }, [stepIdx, step.voiceGuide])

  const handleCapture = useCallback(async (blob: Blob, dataUrl: string, exif?: Record<string, unknown>, isDemo?: boolean) => {
    const currentStep = stepIdx
    const currentStepConfig = STEPS[currentStep]
    const nextCapturedTypes = Array.from(new Set([...Object.keys(state.captures), currentStepConfig.type]))

    const sessionId = state.sessionId || initSession()

    if (currentStepConfig.isAudio) {
      const msg = t('speak_audio_done')
      addCapture({ type: currentStepConfig.type, blob, dataUrl, timestamp: Date.now(), exif })
      setCaptured(prev => new Set([...prev, currentStep]))
      setEvals(prev => ({
        ...prev,
        [currentStep]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.9, feedback: msg, issues: [], detected: {} } },
      }))
      speak(msg)
      return
    }

    speak(t('speak_analysing'))
    setEvals(prev => ({ ...prev, [currentStep]: { state: 'evaluating', dataUrl } }))

    try {
      const optimizedDataUrl = await resizeDataUrl(dataUrl, 1024, 0.8)
      const { referenceFrameType, referenceImageDataUrl } = referenceForStep(currentStepConfig.type, state.captures)
      const evalOptions = {
        sessionId,
        referenceFrameType,
        referenceImageDataUrl,
        language: localStorage.getItem('goldeye_lang') || 'en',
      }

      let result;
      try {
        result = await evaluateFrameAPI(currentStepConfig.type, optimizedDataUrl, 45000, evalOptions)
      } catch (e) {
        console.warn('[CaptureFlow] First evaluation attempt failed, retrying...', e)
        // Automatic retry once after 2 seconds
        await new Promise(r => setTimeout(r, 2000))
        result = await evaluateFrameAPI(currentStepConfig.type, optimizedDataUrl, 45000, evalOptions)
      }

      if (currentStepConfig.type === 'macro') {
        const detectedHuid = typeof result.detected?.huid_code === 'string'
          ? result.detected.huid_code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
          : ''
        const detectedKarat = typeof result.detected?.karat_numeric === 'number'
          ? result.detected.karat_numeric
          : null

        if (detectedHuid.length === 6) {
          setHuid(detectedHuid)
          setManualHuid(detectedHuid)
          setPageEvidence('huid', {
            code: detectedHuid,
            source: 'photo',
            status: 'PHOTO_DETECTED',
            verified: false,
          })
        }
        if (detectedKarat) {
          setScannedKarat(detectedKarat)
          setSelectedKarat(detectedKarat)
          setPageEvidence('huid', {
            source: detectedHuid.length === 6 ? 'photo' : 'photo_karat',
            photoKarat: detectedKarat,
            photoKaratDetected: true,
          })
        }
      }

      setEvals(prev => ({
        ...prev,
        [currentStep]: { state: result.approved ? 'approved' : 'rejected', result, dataUrl: optimizedDataUrl },
      }))
      setPageEvidence('capture', {
        capturedTypes: nextCapturedTypes,
        skippedTypes: Object.keys(state.skippedCaptures ?? {}).filter(type => type !== currentStepConfig.type),
        lastEvaluatedType: currentStepConfig.type,
        lastApproved: result.approved,
        lastQualityScore: result.quality_score,
        lastIssues: result.issues ?? [],
        lastDetected: result.detected ?? {},
      })
      speak(result.feedback)

      if (result.approved) {
        addCapture({ type: currentStepConfig.type, blob, dataUrl: optimizedDataUrl, timestamp: Date.now(), exif })
        setCaptured(prev => new Set([...prev, currentStep]))
      }

      if (result.approved && state.authToken && state.authToken !== 'guest' && !isDemo && isWeightView(currentStepConfig.type)) {
        uploadUserAssetAPI(state.authToken, blob, 'verified_view', sessionId, currentStepConfig.type)
          .then(asset => {
            setPreviousAssets(prev => [asset, ...prev.filter(item => item.id !== asset.id)])
          })
          .catch(err => console.error('[CaptureFlow] Verified view upload failed:', err))
      }
    } catch (err) {
      console.error('[CaptureFlow] Final evaluation attempt failed:', err)
      const fallback = t('speak_image_accepted')
      setEvals(prev => ({
        ...prev,
        [currentStep]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.7, feedback: fallback, issues: [], detected: {} } },
      }))
      setPageEvidence('capture', {
        capturedTypes: nextCapturedTypes,
        skippedTypes: Object.keys(state.skippedCaptures ?? {}).filter(type => type !== currentStepConfig.type),
        lastEvaluatedType: currentStepConfig.type,
        lastApproved: true,
        lastQualityScore: 0.7,
        lastIssues: [],
        fallbackAccepted: true,
      })
      speak(fallback)
    }
  }, [stepIdx, addCapture, setPageEvidence, setHuid, setScannedKarat, state.sessionId, state.authToken, state.captures, state.skippedCaptures, initSession, t])

  const handleRetake = () => {
    speak(t('speak_retake') + ' ' + step.voiceGuide)
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'idle', dataUrl: undefined } }))
    setCaptured(prev => { const s = new Set(prev); s.delete(stepIdx); return s })
    setCameraKey(k => k + 1)
  }

  const handleVerifyHuid = async (huid: string, origin: 'photo' | 'manual' = 'manual') => {
    if (!huid || huid.length !== 6) return
    setHuid(huid)
    setHuidVerifying(true)
    setHuidVerifyResult(null)
    try {
      const result = await verifyHuidAPI(huid)
      const isVerified = String(result.status).toUpperCase() === 'VERIFIED'
      setHuidVerifyResult(result)
      setHuidVerification(result)
      // Preserve how the HUID was obtained ('photo' vs 'manual') so the scoring
      // system can tell a photo-verified HUID apart from a manually-typed one.
      setPageEvidence('huid', {
        code: huid,
        source: origin,
        verifiedVia: isVerified ? origin : null,
        status: result.status,
        verified: isVerified,
        confidence: result.confidence,
        purity: result.purity,
        articleType: result.article_type,
        jewellerName: result.jeweller_name,
        hallmarkDate: result.hallmark_date,
      })
      if (result.purity) {
        const kMap: Record<string, number> = { '24K999': 24, '22K916': 22, '18K750': 18, '14K585': 14, '9K375': 9 }
        const k = kMap[result.purity]
        if (k) { setScannedKarat(k); setSelectedKarat(k) }
      }
    } catch {
      const errorResult = { huid, status: 'AGENT_ERROR' as const, confidence: 0, purity: null, article_type: null, jeweller_name: null, hallmark_date: null, error: 'Verifier unavailable — check ngrok URL' }
      setHuidVerifyResult(errorResult)
      setPageEvidence('huid', {
        code: huid,
        source: origin,
        verifiedVia: null,
        status: errorResult.status,
        verified: false,
        confidence: 0,
      })
    }
    setHuidVerifying(false)
  }

  const handleEnterDemo = useCallback(async () => {
    if (!step.demoUrl) return

    speak(t('speak_demo'))
    setShowDemo(false)

    try {
      const response = await fetch(step.demoUrl)
      const blob = await response.blob()
      const reader = new FileReader()

      reader.onload = async () => {
        const dataUrl = reader.result as string
        handleCapture(blob, dataUrl, undefined, true)
      }

      reader.readAsDataURL(blob)
    } catch (err) {
      console.error('[CaptureFlow] Failed to load demo:', err)
      speak('Error loading demo image. Please try capturing instead.')
    }
  }, [step.demoUrl, handleCapture])

  const handleUsePreviousUpload = useCallback(async (asset: UserAsset) => {
    if (!asset.public_url) return
    if (asset.frame_type !== step.type || !isWeightView(step.type)) {
      speak('This saved image belongs to a different view. Please use the matching view.')
      return
    }
    speak(t('speak_analysing'))
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'evaluating', dataUrl: undefined } }))
    try {
      const dataUrl = await urlToDataUrl(asset.public_url)
      const res = await fetch(asset.public_url)
      const blob = await res.blob()
      addCapture({ type: step.type, blob, dataUrl, timestamp: Date.now() })
      setCaptured(prev => new Set([...prev, stepIdx]))
      // Mark as approved directly — these were already approved in a prior session
      setEvals(prev => ({
        ...prev,
        [stepIdx]: {
          state: 'approved',
          dataUrl,
          result: { approved: true, quality_score: 0.95, feedback: 'Using previously approved image.', issues: [], detected: {} },
        },
      }))
      speak('Previous image loaded successfully.')
    } catch (err) {
      console.error('[CaptureFlow] Failed to load previous upload:', err)
      setEvals(prev => ({ ...prev, [stepIdx]: { state: 'idle', dataUrl: undefined } }))
      speak('Could not load previous image. Please capture a new one.')
    }
  }, [step.type, stepIdx, addCapture, t])

  const next = () => {
    if (stepIdx < STEPS.length - 1) {
      setStepIdx(i => i + 1)
      setShowTutorial(true)   // show tutorial when entering each new step
    } else {
      speak(t('speak_all_done'))
      navigate('/video-eval')
    }
  }

  const skip = () => {
    if (!step.optional) return
    skipCapture(step.type)
    setPageEvidence(step.type === 'selfie' ? 'selfie' : 'capture', {
      skipped: true,
      captured: false,
      type: step.type,
    })
    setCaptured(prev => { const s = new Set(prev); s.delete(stepIdx); return s })
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'idle', dataUrl: undefined } }))
    speak(t('speak_skip'))
    next()
  }

  // ── Hallmark confidence score ─────────────────────────────────────────────
  const hallmarkConfidence = step.type === 'macro' ? (() => {
    if (huidVerifyResult?.status === 'VERIFIED') return 98
    if (evalState === 'approved' && selectedKarat) return 85
    if (evalState === 'approved') return 80
    if (huidVerifyResult?.status === 'NEEDS_MANUAL_REVIEW') return 60
    if (selectedKarat && manualHuid) return 60
    if (selectedKarat) return 60
    if (manualHuid) return 60
    return 0
  })() : 0

  const hasManualHuidOverride = step.type === 'macro' && !!manualHuid && !sameItemMismatch
  const hasSelectedPurity = step.type === 'macro' && !!selectedKarat && !sameItemMismatch
  const photoKaratVisible = step.type === 'macro' && !!selectedKarat && evalState === 'approved'
  // Macro step: proceed if photo approved, OR purity selected/manual HUID entered (photo optional), OR BIS verified
  const macroCanProceed = step.type === 'macro' && !sameItemMismatch && (
    evalState === 'approved' ||
    hasSelectedPurity ||
    hasManualHuidOverride ||
    !!huidVerifyResult
  )
  const canProceed = !sameItemMismatch && (
    macroCanProceed ||
    evalState === 'approved' ||
    (step.optional && step.type !== 'selfie') ||
    (evalState === 'rejected' && hasManualHuidOverride)
  )

  return (
    <div className="page animate-fade-in overflow-y-auto relative bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30">
      {/* Premium gradient overlays */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
        {/* Radial glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-gradient-to-br from-brand-400/15 via-amber-400/10 to-transparent blur-3xl" />
        {/* Left accent */}
        <div className="absolute top-20 left-0 w-64 h-64 rounded-full bg-gradient-to-r from-blue-300/5 to-transparent blur-3xl" />
        {/* Right accent */}
        <div className="absolute top-1/3 right-0 w-80 h-80 rounded-full bg-gradient-to-l from-amber-300/5 to-transparent blur-3xl" />
        {/* Popping circles */}
        <div className="absolute top-1/3 left-1/4 w-12 h-12 rounded-full bg-gradient-to-br from-brand-400 to-amber-400 animate-pop-expand" style={{ animationDelay: '0s' }} />
        <div className="absolute top-2/3 right-1/4 w-8 h-8 rounded-full bg-gradient-to-br from-amber-300 to-orange-400 animate-pop-pulse" style={{ animationDelay: '0.3s' }} />
        <div className="absolute top-1/2 left-1/3 w-10 h-10 rounded-full bg-gradient-to-br from-brand-500 to-amber-500 animate-pop-contract" style={{ animationDelay: '0.6s' }} />
        <div className="absolute top-1/4 right-1/3 w-6 h-6 rounded-full bg-gradient-to-br from-amber-400 to-yellow-400 animate-pop-expand" style={{ animationDelay: '0.9s' }} />
        <div className="absolute top-3/5 left-1/2 w-9 h-9 rounded-full bg-gradient-to-br from-brand-300 to-amber-400 animate-pop-pulse" style={{ animationDelay: '1.2s' }} />
      </div>
      <div className="relative z-10">
        {/* Header */}
        <div className="page-header">
          <button
            id="capture-back"
            onClick={() => stepIdx > 0 ? setStepIdx(i => i - 1) : navigate('/setup')}
            className="btn-icon"
          >
            <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
          </button>
          <div className="flex flex-col items-center">
            <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">
              Step {stepIdx + 1} of {STEPS.length}
            </span>
            <span className="text-sm font-semibold text-stone-900 mt-0.5">{STEP_LABELS[stepIdx]}</span>
          </div>
          <button
            id="capture-voice"
            onClick={() => speak(step.voiceGuide)}
            className="btn-icon"
            title="Replay instructions"
          >
            <Volume2 className="w-4 h-4 text-stone-500" />
          </button>
        </div>

        {/* Demo / Previous Upload Buttons */}
        {(step.demoUrl || previousForStep) && (
          <div className="px-5 pb-2 flex gap-2">
            {step.demoUrl && (
              <button
                onClick={() => setShowDemo(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-50 border border-brand-200 text-[10px] text-brand-600 hover:bg-brand-100 transition-colors font-medium"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-brand-600 animate-pulse" />
                Enter Example Demo
              </button>
            )}
            {previousForStep && step.type !== 'macro' && step.type !== 'selfie' && (
              <button
                onClick={() => handleUsePreviousUpload(previousForStep)}
                disabled={evalState === 'evaluating'}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-[10px] text-emerald-700 hover:bg-emerald-100 transition-colors font-medium disabled:opacity-50"
              >
                <img
                  src={previousForStep.public_url!}
                  className="w-4 h-4 rounded object-cover"
                  alt=""
                />
                Use Previous Upload
              </button>
            )}
          </div>
        )}

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 px-5 py-3">
          {STEPS.map((s, i) => (
            <div
              key={s.type}
              className={clsx(
                'transition-all duration-300 rounded-full',
                i === stepIdx ? 'step-dot-active' :
                  captured.has(i) ? 'step-dot-done' :
                    'step-dot'
              )}
            />
          ))}
        </div>

        {/* Step hint */}
        <div className="px-5 pb-3">
          <p className="text-sm font-semibold text-stone-800 leading-relaxed">
            {t(step.hintKey)}
            {step.optional && <span className="ml-2 text-xs text-stone-500">(optional)</span>}
          </p>
        </div>

        {/* Camera */}
        <div className="px-5 pb-3">
          <Camera
            key={`${cameraKey}-${stepIdx}`}
            type={step.type}
            onCapture={handleCapture}
            facingMode={step.facingMode || 'environment'}
            isVideo={step.isVideo}
            isAudio={step.isAudio}
            capturedDataUrl={currentEval?.dataUrl}
          />

          {/* Hallmark Analysis & Manual Override Widget */}
          {step.type === 'macro' && (
            <div className="mt-4 animate-slide-up space-y-3">

              {/* Confidence Score */}
              {hallmarkConfidence > 0 && (
                <div className="bg-white border border-stone-200 rounded-2xl p-3 shadow-card">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-stone-600">Hallmark Confidence</span>
                    <span className={clsx('text-sm font-black', hallmarkConfidence >= 80 ? 'text-emerald-600' : hallmarkConfidence >= 55 ? 'text-amber-600' : 'text-red-500')}>
                      {hallmarkConfidence}%
                    </span>
                  </div>
                  <div className="w-full bg-stone-100 rounded-full h-2">
                    <div className={clsx('h-2 rounded-full transition-all duration-500', hallmarkConfidence >= 80 ? 'bg-emerald-500' : hallmarkConfidence >= 55 ? 'bg-amber-500' : 'bg-red-400')}
                      style={{ width: `${hallmarkConfidence}%` }} />
                  </div>
                  <p className="text-[10px] text-stone-400 mt-1">
                    {huidVerifyResult?.status === 'VERIFIED' ? 'BIS CARE verified — highest confidence' :
                      evalState === 'approved' && selectedKarat ? 'Photo + purity detected' :
                        evalState === 'approved' ? 'Photo quality approved' :
                          selectedKarat && manualHuid ? 'Manual purity + HUID entered' :
                            selectedKarat ? 'Manual purity only — lower confidence' :
                              'Enter purity or verify HUID to increase confidence'}
                  </p>
                </div>
              )}

              {/* Hallmark Symbol Guide */}
              <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-card">
                <button
                  onClick={() => setShowHallmarkGuide(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                >
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-brand-500" />
                    <span className="text-xs font-bold text-stone-700">What do hallmark symbols mean?</span>
                  </div>
                  <ChevronDown className={clsx('w-4 h-4 text-stone-400 transition-transform', showHallmarkGuide && 'rotate-180')} />
                </button>
                {showHallmarkGuide && (
                  <div className="px-4 pb-4 space-y-2 border-t border-stone-100">
                    <p className="text-[10px] text-stone-400 pt-2 mb-2">Look for these marks stamped on the gold piece:</p>
                    {[
                      { mark: '916 / 22K', meaning: '22 Karat gold — 91.6% pure (most common in India)' },
                      { mark: '750 / 18K', meaning: '18 Karat gold — 75% pure' },
                      { mark: '958 / 23K', meaning: '23 Karat gold — 95.8% pure' },
                      { mark: '875 / 21K', meaning: '21 Karat gold — 87.5% pure' },
                      { mark: '585 / 14K', meaning: '14 Karat gold — 58.5% pure' },
                      { mark: '375 / 9K', meaning: '9 Karat gold — 37.5% pure' },
                      { mark: '999 / 24K', meaning: '24 Karat — 99.9% pure gold bar/coin' },
                      { mark: 'BIS ▲', meaning: 'Bureau of Indian Standards certified mark' },
                      { mark: 'HUID', meaning: '6-digit unique ID — verifiable on BIS Care app' },
                      { mark: 'DM', meaning: "Dealer's Mark — jeweller's own identification code" },
                      { mark: 'AHC mark', meaning: 'Assaying & Hallmarking Centre seal' },
                      { mark: 'KDM', meaning: 'Old cadmium solder mark — now banned by BIS' },
                    ].map(({ mark, meaning }) => (
                      <div key={mark} className="flex gap-2 items-start">
                        <span className="font-mono text-[10px] font-bold text-brand-600 bg-brand-50 border border-brand-100 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">{mark}</span>
                        <span className="text-[11px] text-stone-600 leading-snug">{meaning}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-card">
                {/* Tabs */}
                <div className="flex border-b border-stone-200">
                  <button
                    onClick={() => setActiveTab('scan')}
                    className={clsx(
                      'flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors',
                      activeTab === 'scan' ? 'bg-brand-50 text-brand-600 border-b-2 border-brand-600' : 'text-stone-400 hover:text-stone-600'
                    )}
                  >
                    Scan Result
                  </button>
                  <button
                    onClick={() => setActiveTab('manual')}
                    className={clsx(
                      'flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors',
                      activeTab === 'manual' ? 'bg-brand-50 text-brand-600 border-b-2 border-brand-600' : 'text-stone-400 hover:text-stone-600'
                    )}
                  >
                    Manual Entry
                  </button>
                </div>

                <div className="p-4">
                  {activeTab === 'scan' ? (
                    <div className="min-h-[100px] flex flex-col justify-center">
                      {evalState === 'idle' ? (
                        <p className="text-center text-xs text-stone-400 italic">Capture an image to see hallmark details</p>
                      ) : evalState === 'evaluating' ? (
                        <div className="flex items-center justify-center gap-3">
                          <Loader2 className="w-5 h-5 text-brand-600 animate-spin" />
                          <span className="text-xs text-brand-600">Scanning for markings...</span>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-stone-500">Detected Purity</span>
                            <span className="text-sm font-bold text-emerald-600">{selectedKarat ? `${selectedKarat}K` : 'Not Detected'}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-stone-500">HUID</span>
                            <span className="text-sm font-mono font-bold text-stone-700">
                              {(currentEval?.result?.detected?.huid_code as string) || manualHuid || '—'}
                            </span>
                          </div>
                          {/* Verify HUID via BIS when detected */}
                          {((currentEval?.result?.detected?.huid_code as string) || manualHuid) && !huidVerifyResult && (
                            <button
                              onClick={() => {
                                const detectedCode = currentEval?.result?.detected?.huid_code as string
                                handleVerifyHuid(detectedCode || manualHuid, detectedCode ? 'photo' : 'manual')
                              }}
                              disabled={huidVerifying}
                              className="w-full py-2 rounded-xl text-xs font-bold bg-brand-600 text-white disabled:opacity-50"
                            >
                              {huidVerifying ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Verify HUID with BIS CARE →'}
                            </button>
                          )}
                          {/* BIS result inline */}
                          {huidVerifyResult && (
                            <div className={clsx(
                              'rounded-xl border p-3 space-y-1.5',
                              huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-50 border-emerald-200' :
                                huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-50 border-red-200' :
                                  'bg-amber-50 border-amber-200'
                            )}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-bold text-stone-600">BIS CARE</span>
                                <span className={clsx(
                                  'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                                  huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700' :
                                    huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-100 text-red-700' :
                                      'bg-amber-100 text-amber-700'
                                )}>
                                  {huidVerifyResult.status.replace('_', ' ')}
                                </span>
                              </div>
                              {huidVerifyResult.error ? (
                                <p className="text-xs text-red-600">{huidVerifyResult.error}</p>
                              ) : (
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                  {huidVerifyResult.purity && <><span className="text-stone-500">Purity</span><span className="font-semibold">{huidVerifyResult.purity}</span></>}
                                  {huidVerifyResult.jeweller_name && <><span className="text-stone-500">Jeweller</span><span className="font-semibold">{huidVerifyResult.jeweller_name}</span></>}
                                  {huidVerifyResult.hallmark_date && <><span className="text-stone-500">Date</span><span className="font-semibold">{huidVerifyResult.hallmark_date}</span></>}
                                  {huidVerifyResult.article_type && <><span className="text-stone-500">Article</span><span className="font-semibold capitalize">{huidVerifyResult.article_type}</span></>}
                                </div>
                              )}
                            </div>
                          )}
                          <p className="text-[11px] text-stone-600 leading-relaxed italic border-t border-stone-200 pt-2">
                            {currentEval?.result?.feedback || 'Take a clear photo of the Hallmark stamp for automatic extraction.'}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="label mb-2 block">HUID Alphanumeric Code</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={manualHuid}
                            onChange={e => {
                              const val = e.target.value.toUpperCase();
                              setManualHuid(val);
                              setHuid(val || null);
                              setHuidVerifyResult(null);
                            }}
                            placeholder="e.g., A3F2K1"
                            className="input-field font-mono flex-1"
                            maxLength={6}
                          />
                          <button
                            onClick={() => handleVerifyHuid(manualHuid, 'manual')}
                            disabled={manualHuid.length !== 6 || huidVerifying}
                            className={clsx(
                              'px-3 py-2 rounded-xl text-xs font-bold transition-all border whitespace-nowrap',
                              manualHuid.length === 6 && !huidVerifying
                                ? 'bg-brand-600 border-brand-600 text-white'
                                : 'bg-stone-100 border-stone-200 text-stone-400 cursor-not-allowed'
                            )}
                          >
                            {huidVerifying ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify BIS'}
                          </button>
                        </div>
                      </div>

                      {/* BIS Verification Result */}
                      {huidVerifyResult && (
                        <div className={clsx(
                          'rounded-2xl border p-3 space-y-2',
                          huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-50 border-emerald-200' :
                            huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-50 border-red-200' :
                              'bg-amber-50 border-amber-200'
                        )}>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-stone-700">BIS CARE Result</span>
                            <span className={clsx(
                              'text-[10px] font-bold px-2 py-0.5 rounded-full',
                              huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700' :
                                huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-100 text-red-700' :
                                  'bg-amber-100 text-amber-700'
                            )}>
                              {huidVerifyResult.status.replace('_', ' ')}
                            </span>
                          </div>
                          {huidVerifyResult.error ? (
                            <p className="text-xs text-red-600">{huidVerifyResult.error}</p>
                          ) : (
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                              {huidVerifyResult.purity && (
                                <>
                                  <span className="text-stone-500">Purity</span>
                                  <span className="font-semibold text-stone-800">{huidVerifyResult.purity}</span>
                                </>
                              )}
                              {huidVerifyResult.article_type && (
                                <>
                                  <span className="text-stone-500">Article</span>
                                  <span className="font-semibold text-stone-800 capitalize">{huidVerifyResult.article_type}</span>
                                </>
                              )}
                              {huidVerifyResult.jeweller_name && (
                                <>
                                  <span className="text-stone-500">Jeweller</span>
                                  <span className="font-semibold text-stone-800">{huidVerifyResult.jeweller_name}</span>
                                </>
                              )}
                              {huidVerifyResult.hallmark_date && (
                                <>
                                  <span className="text-stone-500">Hallmark Date</span>
                                  <span className="font-semibold text-stone-800">{huidVerifyResult.hallmark_date}</span>
                                </>
                              )}
                              <span className="text-stone-500">Confidence</span>
                              <span className="font-semibold text-stone-800">{huidVerifyResult.confidence}%</span>
                            </div>
                          )}
                        </div>
                      )}

                      <div>
                        <label className="label mb-2 block">Purity / Karat</label>
                        <div className="flex gap-2">
                          {[18, 22, 24].map(k => (
                            <button
                              key={k}
                              onClick={() => {
                                setSelectedKarat(k);
                                setScannedKarat(k);
                              }}
                              className={clsx(
                                'flex-1 py-2.5 rounded-xl text-xs font-bold transition-all border',
                                selectedKarat === k
                                  ? 'bg-brand-600 border-brand-600 text-white shadow-brand-sm'
                                  : 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100'
                              )}
                            >
                              {k}K
                            </button>
                          ))}
                        </div>
                      </div>

                      <p className="text-[10px] text-brand-600 flex items-center gap-1.5 pt-1 font-medium">
                        <Shield className="w-3 h-3" />
                        Settings saved instantly to your assessment.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Feedback */}
          {evalState === 'evaluating' && (
            <div className="mt-3 flex items-center gap-3 px-4 py-3 rounded-2xl bg-brand-50 border border-brand-200">
              <Loader2 className="w-5 h-5 text-brand-600 animate-spin flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-brand-700">Analysing image…</p>
                <p className="text-xs text-brand-600/70 mt-0.5">Checking image quality…</p>
              </div>
            </div>
          )}

          {evalState === 'approved' && currentEval?.result && (
            <div className="mt-3 px-4 py-3 rounded-2xl bg-emerald-50 border border-emerald-200">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-emerald-700">
                    {currentEval.result.feedback.split(/\*\*(.*?)\*\*/g).map((part, i) =>
                      i % 2 === 1 ? <strong key={i} className="font-bold">{part}</strong> : <span key={i}>{part}</span>
                    )}
                  </p>
                  {currentEval.result.quality_score > 0 && (
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1 progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.round(currentEval.result.quality_score * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-stone-400">{Math.round(currentEval.result.quality_score * 100)}%</span>
                    </div>
                  )}
                </div>
                <button onClick={() => speak(currentEval.result!.feedback)} className="opacity-50 hover:opacity-80 flex-shrink-0">
                  <Volume2 className="w-4 h-4 text-emerald-600" />
                </button>
              </div>
            </div>
          )}

          {evalState === 'rejected' && currentEval?.result && (
            <div className="mt-3 px-4 py-3 rounded-2xl bg-red-50 border border-red-200">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-700">{currentEval.result.feedback}</p>
                  {visibleIssues.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {visibleIssues.map((issue, i) => (
                        <li key={i} className="text-xs text-red-600/70">• {issue}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Captured thumbnails */}
          {Object.keys(state.captures).length > 0 && (
            <div className="mt-3">
              <p className="label mb-2">Captured</p>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                {(Object.entries(state.captures) as [CaptureType, any][]).map(([ctype, asset]) => (
                  <div key={ctype} className="relative flex-shrink-0">
                    {ctype === 'audio' ? (
                      <div className="w-14 h-14 rounded-2xl bg-stone-100 border border-stone-300 flex items-center justify-center">
                        <Music className="w-5 h-5 text-brand-600" />
                      </div>
                    ) : ctype === 'video' ? (
                      <div className="w-14 h-14 rounded-2xl bg-stone-100 border border-stone-300 flex items-center justify-center">
                        <Video className="w-5 h-5 text-brand-600" />
                      </div>
                    ) : (
                      <img src={asset.dataUrl} className="w-14 h-14 rounded-2xl object-cover border border-stone-300" alt={ctype} />
                    )}
                    <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
                      <CheckCircle className="w-3 h-3 text-white" strokeWidth={3} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Bottom actions */}
        <div className="px-5 pb-6 pt-3 border-t border-stone-200 space-y-2 sticky bottom-0 bg-white/95 backdrop-blur-sm">
          {evalState === 'rejected' && !hasManualHuidOverride && !hasSelectedPurity && !huidVerifyResult ? (
            <button onClick={handleRetake} className="w-full btn-primary">
              <RotateCcw className="w-5 h-5" />
              Retake Photo
            </button>
          ) : (
            <>
              <button
                id={`capture-next-${step.type}`}
                onClick={next}
                disabled={!canProceed || evalState === 'evaluating'}
                className={clsx('w-full', (canProceed && evalState !== 'evaluating') ? 'btn-primary' : 'btn-secondary opacity-50 cursor-not-allowed')}
              >
                {evalState === 'evaluating' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Analysing…</>
                ) : stepIdx === STEPS.length - 1 ? 'Continue' : t('capture_accept')}
                {evalState !== 'evaluating' && <ChevronRight className="w-5 h-5" />}
              </button>
              {evalState === 'rejected' && hasManualHuidOverride && (
                <button onClick={handleRetake} className="btn-secondary w-full text-sm mt-2">
                  <RotateCcw className="w-4 h-4 mr-2 inline" /> Retake Photo Instead
                </button>
              )}
            </>
          )}
          {step.optional && evalState !== 'evaluating' && (
            <button id={`capture-skip-${step.type}`} onClick={skip} className="btn-secondary w-full text-sm">
              {t('capture_skip')}
            </button>
          )}
          {!showTutorial && !step.isVideo && !step.isAudio && (
            <button onClick={() => setShowTutorial(true)} className="w-full py-2 text-sm font-semibold text-brand-600 flex items-center justify-center gap-2 mt-1 active:scale-95 transition-transform">
              <PlayCircle className="w-4 h-4" /> Watch Tutorial
            </button>
          )}
        </div>
        {/* Tutorial Overlay — auto-shows on each new step */}
        {showTutorial && !step.isVideo && !step.isAudio && (
          <TutorialOverlay
            stepType={step.type}
            title={t(step.titleKey)}
            hint={t(step.hintKey)}
            buttonText={t('tutorial_got_it')}
            onDismiss={() => setShowTutorial(false)}
          />
        )}

        {/* Demo Overlay */}
        {showDemo && step.demoUrl && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-900/60 backdrop-blur-md p-6 animate-fade-in">
            <div className="relative w-full max-w-sm flex flex-col items-center">
              <button
                onClick={() => setShowDemo(false)}
                className="absolute -top-12 right-0 p-2 rounded-full bg-stone-200 text-stone-600 hover:bg-stone-300 transition-colors"
              >
                <XCircle className="w-6 h-6" />
              </button>
              <div className="w-full aspect-[3/4] rounded-3xl overflow-hidden border-2 border-stone-300 shadow-2xl bg-stone-100 flex items-center justify-center">
                {step.isVideo ? (
                  <video src={step.demoUrl} className="w-full h-full object-cover" controls autoPlay loop muted playsInline />
                ) : step.isAudio ? (
                  <div className="flex flex-col items-center gap-4">
                    <Music className="w-16 h-16 text-brand-600 animate-bounce" />
                    <audio src={step.demoUrl} controls className="w-4/5" />
                  </div>
                ) : (
                  <img src={step.demoUrl} className="w-full h-full object-cover" alt="Example demo" />
                )}
              </div>
              <p className="mt-6 text-black font-semibold text-center">Reference: {STEP_LABELS[stepIdx]}</p>
              <p className="mt-2 text-stone-700 text-xs text-center px-6">
                This is how your photo should look. Ensure the gold is clear and well-lit.
              </p>
              <div className="mt-8 flex gap-3 w-full px-2">
                <button
                  onClick={handleEnterDemo}
                  className="flex-1 px-6 py-3 rounded-full bg-brand-600 text-white font-semibold text-sm shadow-brand active:scale-95 transition-transform hover:bg-brand-700"
                >
                  Enter Demo
                </button>
                <button
                  onClick={() => setShowDemo(false)}
                  className="flex-1 px-6 py-3 rounded-full bg-white text-stone-700 font-semibold text-sm border border-stone-300 active:scale-95 transition-transform hover:bg-stone-50"
                >
                  View Only
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
