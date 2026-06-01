import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type CaptureType } from '../store/session'
import { Camera } from '../components/Camera'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { ChevronRight, Volume2, CheckCircle, XCircle, Loader2, RotateCcw, Music, Video, Shield, Info, ChevronDown, ImageIcon, PlayCircle, User, X } from 'lucide-react'
import { speak, prefetchSpeech } from '../lib/tts'
import { clsx } from 'clsx'
import { assetImageDataUrlAPI, evaluateFrameAPI, listMyAssetsAPI, verifyHuidAPI, uploadUserAssetAPI, type FrameEvalResult, type HuidVerificationResult, type UserAsset } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'
import Lottie from 'lottie-react'
import goldAnim from '../assets/gold-analysis.json'

function GoldLottie({ size = 40 }: { size?: number }) {
  const ref = useRef<import('lottie-react').LottieRefCurrentProps>(null)
  return (
    <Lottie
      animationData={goldAnim}
      loop autoplay
      lottieRef={ref}
      onDOMLoaded={() => ref.current?.setSpeed(2.5)}
      style={{ width: size, height: size }}
    />
  )
}

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

function normalizeJewelryType(value: unknown) {
  const raw = String(value || '').trim().toLowerCase()
  const aliases: Record<string, string> = {
    bangles: 'bangle',
    bangle: 'bangle',
    rings: 'ring',
    ring: 'ring',
    necklaces: 'necklace',
    necklace: 'necklace',
    chains: 'chain',
    chain: 'chain',
    bracelets: 'bracelet',
    bracelet: 'bracelet',
    pendants: 'pendant',
    pendant: 'pendant',
    earrings: 'earring',
    earring: 'earring',
    other: 'irregular',
    irregular: 'irregular',
  }
  return aliases[raw] || raw
}

function assetJewelryType(asset: UserAsset) {
  return normalizeJewelryType(asset.metadata?.jewelry_type ?? asset.metadata?.jewellery_type)
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
  const [manualHuid, setManualHuid] = useState(state.huidCode || '')
  const [selectedKarat, setSelectedKarat] = useState<number | null>(state.scannedKarat || null)
  const [activeTab, setActiveTab] = useState<'scan' | 'manual'>('scan')
  const [showHallmarkGuide, setShowHallmarkGuide] = useState(false)
  const [huidVerifying, setHuidVerifying] = useState(false)
  const [huidVerifyResult, setHuidVerifyResult] = useState<HuidVerificationResult | null>(state.huidVerification ?? null)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const spokenStep = useRef(-1)
  const [previousAssets, setPreviousAssets] = useState<UserAsset[]>([])
  const [previousAssetSrcs, setPreviousAssetSrcs] = useState<Record<number, string>>({})
  // Loading state kept for async asset fetch (even if value not visually used)
  const [, setLoadingPrevious] = useState(false)
  const step = STEPS[stepIdx]
  const selectedJewelryType = normalizeJewelryType((state.pageEvidence.capture as { jewelryType?: unknown; jewelleryType?: unknown } | undefined)?.jewelryType ?? (state.pageEvidence.capture as { jewelleryType?: unknown } | undefined)?.jewelleryType)

  // Fetch previously uploaded images from user's profile
  useEffect(() => {
    if (!state.authToken) return
    let cancelled = false
    setLoadingPrevious(true)
    listMyAssetsAPI(state.authToken)
      .then(assets => {
        if (!cancelled) {
          setPreviousAssets(assets.filter(a =>
            a.frame_type &&
            isWeightView(a.frame_type as CaptureType) &&
            (a.asset_kind === 'verified_view' || a.asset_kind === 'jewellery_capture') &&
            (!selectedJewelryType || assetJewelryType(a) === selectedJewelryType)
          ))
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingPrevious(false) })
    return () => { cancelled = true }
  }, [state.authToken, selectedJewelryType])

  useEffect(() => {
    if (!state.authToken || state.authToken === 'guest') return
    previousAssets.forEach(asset => {
      if (previousAssetSrcs[asset.id]) return
      assetImageDataUrlAPI(state.authToken!, asset.id)
        .then(src => setPreviousAssetSrcs(prev => ({ ...prev, [asset.id]: src })))
        .catch(() => {})
    })
  }, [previousAssets, previousAssetSrcs, state.authToken])

  const previousForStep = previousAssets
    .filter(a => a.frame_type === step.type)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 12)

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
        // The backend normalizes karat_numeric / huid_code for macro frames
        // (gemini.py::_normalize_macro_detected) and also returns boolean
        // huid_detected / karat_detected flags. We still defensively re-parse.
        const detected = result.detected ?? {}
        const detectedHuid = typeof detected.huid_code === 'string'
          ? detected.huid_code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
          : ''
        const detectedKarat = typeof detected.karat_numeric === 'number'
          ? detected.karat_numeric
          : null

        console.group('%c[CaptureFlow] MACRO hallmark detection', 'color:#b8860b;font-weight:bold')
        console.log('provider/model:', (detected as Record<string, unknown>).provider ?? '(see backend logs)')
        console.log('raw detected dict:', detected)
        console.log('huid_code (raw):', detected.huid_code, '| huid_code_raw:', (detected as Record<string, unknown>).huid_code_raw, '| backend huid_detected:', (detected as Record<string, unknown>).huid_detected)
        console.log('→ parsed detectedHuid:', detectedHuid || '(none)', '| valid 6-char:', detectedHuid.length === 6)
        console.log('karat_marking:', (detected as Record<string, unknown>).karat_marking, '| karat_numeric:', detected.karat_numeric, '| backend karat_detected:', (detected as Record<string, unknown>).karat_detected)
        console.log('→ parsed detectedKarat:', detectedKarat ?? '(none)')

        if (detectedHuid.length === 6) {
          setHuid(detectedHuid)
          setManualHuid(detectedHuid)
          setPageEvidence('huid', {
            code: detectedHuid,
            source: 'photo',
            status: 'PHOTO_DETECTED',
            verified: false,
          })
          console.log('%c✓ pageEvidence.huid set: source=photo, code=%s (photoHuidEvidence WILL be true)', 'color:green', detectedHuid)
        } else {
          console.log('%c✗ No 6-char HUID read from photo → photoHuidEvidence stays false', 'color:#888')
        }
        if (detectedKarat) {
          setScannedKarat(detectedKarat)
          setSelectedKarat(detectedKarat)
          setPageEvidence('huid', {
            source: detectedHuid.length === 6 ? 'photo' : 'photo_karat',
            photoKarat: detectedKarat,
            photoKaratDetected: true,
          })
          console.log('%c✓ pageEvidence.huid set: photoKaratDetected=true, photoKarat=%sK (photoKaratEvidence WILL be true)', 'color:green', detectedKarat)
        } else {
          console.log('%c✗ No karat read from photo → photoKaratEvidence stays false', 'color:#888')
        }
        console.groupEnd()
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
        uploadUserAssetAPI(state.authToken, blob, 'verified_view', sessionId, currentStepConfig.type, {
          jewelry_type: selectedJewelryType || null,
          jewellery_type: selectedJewelryType || null,
        })
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
  }, [stepIdx, addCapture, setPageEvidence, setHuid, setScannedKarat, state.sessionId, state.authToken, state.captures, state.skippedCaptures, initSession, t, selectedJewelryType])

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
    if (asset.frame_type !== step.type || !isWeightView(step.type)) {
      speak('This saved image belongs to a different view. Please use the matching view.')
      return
    }
    if (selectedJewelryType && assetJewelryType(asset) !== selectedJewelryType) {
      speak('This saved image belongs to a different jewellery type.')
      return
    }
    if (!state.authToken || state.authToken === 'guest') return
    speak(t('speak_analysing'))
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'evaluating', dataUrl: undefined } }))
    try {
      const dataUrl = previousAssetSrcs[asset.id] || await assetImageDataUrlAPI(state.authToken, asset.id)
      const res = await fetch(dataUrl)
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
  }, [step.type, stepIdx, addCapture, t, selectedJewelryType, previousAssetSrcs, state.authToken])

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
    <div className="page animate-fade-in overflow-y-auto relative" style={{
      background: 'linear-gradient(135deg, #fdfcfa 0%, #f8f5f0 50%, #f2ede5 100%)',
      backgroundAttachment: 'fixed'
    } as any}>
      {/* Animated gradient overlay */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-30">
        <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-br from-amber-200/20 via-transparent to-transparent rounded-full blur-3xl" style={{ animation: 'float 20s ease-in-out infinite' }} />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-gradient-to-tr from-stone-200/20 via-transparent to-transparent rounded-full blur-3xl" style={{ animation: 'float 25s ease-in-out infinite reverse' }} />
      </div>
      <div className="absolute inset-x-8 top-24 h-px bg-gradient-to-r from-transparent via-stone-300/20 to-transparent pointer-events-none z-0" />
      <div className="relative z-10">
        {/* Header */}
        <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
          <button
            id="capture-back"
            onClick={() => stepIdx > 0 ? setStepIdx(i => i - 1) : navigate('/setup')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md hover:shadow-lg"
          >
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
          <div className="flex flex-col items-center flex-1 gap-1">
            <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-1 rounded-full bg-stone-100/80 border border-stone-200/60">
              Step {stepIdx + 1} / {STEPS.length}
            </span>
            <span className="text-base font-bold text-stone-950 leading-tight tracking-[-0.01em]">{STEP_LABELS[stepIdx]}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => speak(step.voiceGuide)}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
              title="Replay instructions"
            >
              <Volume2 className="w-3.5 h-3.5" />
            </button>
            <div className="relative">
              <button
                onClick={() => state.authToken && state.authToken !== 'guest' ? setShowProfileMenu(!showProfileMenu) : setShowAuthModal(true)}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
                title={state.authToken && state.authToken !== 'guest' ? "Profile menu" : "Sign in"}
              >
                <User className="w-3.5 h-3.5" />
              </button>
              {showProfileMenu && state.authToken && state.authToken !== 'guest' && (
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-stone-200 z-50 overflow-hidden">
                  <button
                    onClick={() => { navigate('/dashboard-home'); setShowProfileMenu(false) }}
                    className="w-full text-left px-4 py-3 hover:bg-stone-50 text-sm font-medium text-stone-900 border-b border-stone-100"
                  >
                    My Evaluations
                  </button>
                  <button
                    onClick={() => { navigate('/dashboard-home'); setShowProfileMenu(false) }}
                    className="w-full text-left px-4 py-3 hover:bg-stone-50 text-sm font-medium text-stone-900 border-b border-stone-100"
                  >
                    Applications in Progress
                  </button>
                  <button
                    onClick={() => { navigate('/dashboard-home'); setShowProfileMenu(false) }}
                    className="w-full text-left px-4 py-3 hover:bg-stone-50 text-sm font-medium text-stone-900 border-b border-stone-100"
                  >
                    Loans
                  </button>
                  <button
                    onClick={() => { navigate('/profile'); setShowProfileMenu(false) }}
                    className="w-full text-left px-4 py-3 hover:bg-stone-50 text-sm font-medium text-stone-900 border-b border-stone-100"
                  >
                    Settings
                  </button>
                  <button
                    onClick={() => { navigate('/login'); setShowProfileMenu(false) }}
                    className="w-full text-left px-4 py-3 hover:bg-red-50 text-sm font-bold text-red-600"
                  >
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Demo / Previous Upload Buttons */}
        {previousForStep.length > 0 && (
          <div className="px-5 pb-2 space-y-2">
            <div className="flex gap-2">
            {previousForStep.length > 0 && step.type !== 'macro' && step.type !== 'selfie' && (
              <span className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-emerald-50 border border-emerald-200 text-[10px] text-emerald-700 font-semibold shadow-xs">
                <ImageIcon className="w-4 h-4" />
                {previousForStep.length} saved {step.type} view{previousForStep.length === 1 ? '' : 's'}
              </span>
            )}
            </div>
            {previousForStep.length > 0 && step.type !== 'macro' && step.type !== 'selfie' && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {previousForStep.map((asset, index) => {
                  const src = previousAssetSrcs[asset.id]
                  return (
                    <button
                      key={asset.id}
                      onClick={() => handleUsePreviousUpload(asset)}
                      disabled={evalState === 'evaluating'}
                      className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50 disabled:opacity-50"
                      title={`Use saved ${step.type} view`}
                    >
                      {src ? (
                        <img src={src} className="h-full w-full object-cover" alt="" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <ImageIcon className="h-5 w-5 text-emerald-600" />
                        </div>
                      )}
                      <span className="absolute bottom-0 inset-x-0 bg-black/50 px-1 py-0.5 text-[9px] font-bold text-white">
                        {index === 0 ? 'Latest' : `#${index + 1}`}
                      </span>
                    </button>
                  )
                })}
              </div>
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
          <div className="scan-panel rounded-3xl px-4 py-3">
            <p className="text-sm font-semibold text-stone-800 leading-relaxed">
              {t(step.hintKey)}
            </p>
          </div>
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
                <div className="surface-panel rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-stone-600">Hallmark Confidence</span>
                    <span className={clsx('text-sm font-black', hallmarkConfidence >= 80 ? 'text-emerald-600' : hallmarkConfidence >= 55 ? 'text-red-600' : 'text-red-500')}>
                      {hallmarkConfidence}%
                    </span>
                  </div>
                  <div className="w-full bg-stone-100 rounded-full h-2">
                    <div className={clsx('h-2 rounded-full transition-all duration-500', hallmarkConfidence >= 80 ? 'bg-emerald-500' : hallmarkConfidence >= 55 ? 'bg-red-500' : 'bg-red-400')}
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
              <div className="surface-panel rounded-2xl overflow-hidden">
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

              <div className="surface-panel rounded-2xl overflow-hidden">
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
                                  'bg-red-50 border-red-200'
                            )}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-bold text-stone-600">BIS CARE</span>
                                <span className={clsx(
                                  'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                                  huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700' :
                                    huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-100 text-red-700' :
                                      'bg-red-100 text-red-700'
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
                              const val = e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
                              setManualHuid(val);
                              setHuid(val || null);
                              setHuidVerifyResult(null);
                              // Record the typed HUID as an INDEPENDENT (manual) item HUID
                              // so the bill cross-check can match against it even before
                              // (or without) BIS verification.
                              if (val.length === 6) {
                                setPageEvidence('huid', { code: val, source: 'manual', status: 'MANUAL_ENTRY', verified: false })
                              }
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
                              'bg-red-50 border-red-200'
                        )}>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-stone-700">BIS CARE Result</span>
                            <span className={clsx(
                              'text-[10px] font-bold px-2 py-0.5 rounded-full',
                              huidVerifyResult.status === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700' :
                                huidVerifyResult.status === 'NOT_VERIFIED' ? 'bg-red-100 text-red-700' :
                                  'bg-red-100 text-red-700'
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
            <div className="mt-4 flex flex-col items-center gap-2">
              <GoldLottie size={96} />
              <p className="text-sm font-semibold text-brand-700 tracking-[-0.01em]">Analysing image…</p>
            </div>
          )}

          {evalState === 'approved' && currentEval?.result && (
            <div className="mt-3 px-4 py-3 rounded-2xl bg-emerald-50/90 border border-emerald-200/60">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-emerald-900">
                    {currentEval.result.feedback.split(/\*\*(.*?)\*\*/g).map((part, i) =>
                      i % 2 === 1 ? <strong key={i} className="font-bold">{part}</strong> : <span key={i}>{part}</span>
                    )}
                  </p>
                  {currentEval.result.quality_score > 0 && (
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1 progress-bar bg-emerald-100">
                        <div
                          className="progress-fill bg-emerald-500"
                          style={{ width: `${Math.round(currentEval.result.quality_score * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-emerald-600">{Math.round(currentEval.result.quality_score * 100)}%</span>
                    </div>
                  )}
                </div>
                <button onClick={() => speak(currentEval.result!.feedback)} className="opacity-70 hover:opacity-100 flex-shrink-0 transition-opacity">
                  <Volume2 className="w-4 h-4 text-emerald-600" />
                </button>
              </div>
            </div>
          )}

          {evalState === 'rejected' && currentEval?.result && (
            <div className="mt-3 px-4 py-3 rounded-2xl bg-red-50/90 border border-red-200/60">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-900">{currentEval.result.feedback}</p>
                  {visibleIssues.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {visibleIssues.map((issue, i) => (
                        <li key={i} className="text-xs text-red-700/70">• {issue}</li>
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
        <div className="px-5 pb-6 pt-3 space-y-2 sticky-action">
          {evalState === 'rejected' && !hasManualHuidOverride && !hasSelectedPurity && !huidVerifyResult ? (
            <button onClick={handleRetake} className="w-full bg-amber-600 hover:bg-amber-700 text-white rounded-2xl py-3 font-semibold transition-colors flex items-center justify-center gap-2">
              <RotateCcw className="w-5 h-5" />
              Retake Photo
            </button>
          ) : (
            <>
              <button
                id={`capture-next-${step.type}`}
                onClick={next}
                disabled={!canProceed || evalState === 'evaluating'}
                className={clsx('w-full rounded-2xl py-3 font-semibold transition-colors flex items-center justify-center gap-2', (canProceed && evalState !== 'evaluating') ? 'bg-black hover:bg-stone-900 text-white' : 'bg-stone-200 text-stone-400 cursor-not-allowed')}
              >
                {evalState === 'evaluating' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Analysing…</>
                ) : stepIdx === STEPS.length - 1 ? 'Continue' : t('capture_accept')}
                {evalState !== 'evaluating' && <ChevronRight className="w-5 h-5" />}
              </button>
              {evalState === 'rejected' && hasManualHuidOverride && (
                <button onClick={handleRetake} className="w-full text-sm mt-2 bg-amber-700 hover:bg-amber-800 text-white rounded-2xl py-2.5 font-semibold transition-colors">
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
              <p className="mt-6 text-white font-semibold text-center">Reference: {STEP_LABELS[stepIdx]}</p>
              <p className="mt-2 text-white/70 text-xs text-center px-6">
                This is how your photo should look. Ensure the gold is clear and well-lit.
              </p>
              <div className="mt-8 flex gap-3 w-full px-2">
                <button
                  onClick={handleEnterDemo}
                  className="flex-1 btn-primary px-4 py-3 text-sm"
                >
                  Enter Demo
                </button>
                <button
                  onClick={() => setShowDemo(false)}
                  className="flex-1 btn-secondary px-4 py-3 text-sm"
                >
                  View Only
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Auth Modal */}
        {showAuthModal && (
          <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 px-4">
            <div className="w-full max-w-sm bg-white rounded-3xl p-8 shadow-2xl">
              {/* Close button */}
              <button
                onClick={() => setShowAuthModal(false)}
                className="absolute top-4 right-4 text-stone-400 hover:text-stone-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              {/* Welcome message */}
              <h2 className="text-2xl font-bold text-stone-950 mb-8 text-center">Welcome</h2>

              {/* Login/Signup buttons */}
              <div className="space-y-3">
                <button
                  onClick={() => { navigate('/login'); setShowAuthModal(false) }}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-red-600 to-red-700 text-white font-bold text-base shadow-lg hover:shadow-xl transition-all active:scale-95"
                >
                  Login
                </button>
                <button
                  onClick={() => { navigate('/register'); setShowAuthModal(false) }}
                  className="w-full py-4 rounded-2xl bg-white border-2 border-stone-950 text-stone-950 font-bold text-base hover:bg-stone-50 transition-all active:scale-95"
                >
                  Sign Up
                </button>
              </div>

              <p className="text-xs text-stone-500 text-center mt-6">
                Sign in or create an account to get started
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
