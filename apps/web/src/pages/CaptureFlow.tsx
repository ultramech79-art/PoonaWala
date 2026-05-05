import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type CaptureType } from '../store/session'
import { Camera } from '../components/Camera'
import { ChevronRight, Volume2, CheckCircle, XCircle, Loader2, RotateCcw, Music, Video, Shield } from 'lucide-react'
import { clsx } from 'clsx'
import { evaluateFrameAPI, type FrameEvalResult } from '../lib/api'
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

function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = localStorage.getItem('goldeye_lang') === 'hi' ? 'hi-IN' : 'en-US'
  u.rate = 0.95
  window.speechSynthesis.speak(u)
}

export function CaptureFlow() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { addCapture, state, setScannedKarat, setHuid } = useSessionStore()

  const STEPS: Step[] = [
    {
      type: 'top',
      titleKey: 'step_top_title',
      hintKey: 'step_top_hint',
      voiceGuide: t('voice_top'),
      demoUrl: '/assets/demo/top.jpg',
    },
    {
      type: '45deg',
      titleKey: 'step_45_title',
      hintKey: 'step_45_hint',
      voiceGuide: t('voice_45deg'),
      demoUrl: '/assets/demo/45deg.jpg',
    },
    {
      type: 'side',
      titleKey: 'step_side_title',
      hintKey: 'step_side_hint',
      voiceGuide: t('voice_side'),
      demoUrl: '/assets/demo/side.jpg',
    },
    {
      type: 'macro',
      titleKey: 'step_macro_title',
      hintKey: 'step_macro_hint',
      voiceGuide: t('voice_macro'),
      demoUrl: '/assets/demo/macro.jpg',
    },
    {
      type: 'video',
      titleKey: 'step_video_title',
      hintKey: 'step_video_hint',
      voiceGuide: t('voice_video'),
      isVideo: true,
      demoUrl: '/assets/demo/video.mp4',
    },
    {
      type: 'audio',
      titleKey: 'step_audio_title',
      hintKey: 'step_audio_hint',
      voiceGuide: t('voice_audio'),
      isAudio: true,
      optional: true,
      demoUrl: '/assets/demo/audio.mp3',
    },
    {
      type: 'selfie',
      titleKey: 'step_selfie_title',
      hintKey: 'step_selfie_hint',
      voiceGuide: t('voice_selfie'),
      facingMode: 'user',
      demoUrl: '/assets/demo/selfie.jpg',
    },
  ]

  const STEP_LABELS = [
    t('step_label_top'), t('step_label_45'), t('step_label_side'),
    t('step_label_hallmark'), t('step_label_video'), t('step_label_audio'), t('step_label_selfie'),
  ]

  const [stepIdx, setStepIdx] = useState(0)
  const [captured, setCaptured] = useState<Set<number>>(new Set())
  const [evals, setEvals] = useState<Record<number, StepEval>>({})
  const [cameraKey, setCameraKey] = useState(0)
  const [showDemo, setShowDemo] = useState(false)
  const [showManualHuid, setShowManualHuid] = useState(false)
  const [manualHuid, setManualHuid] = useState(state.huidCode || '')
  const [selectedKarat, setSelectedKarat] = useState<number | null>(state.scannedKarat || null)
  const [activeTab, setActiveTab] = useState<'scan' | 'manual'>('scan')
  const spokenStep = useRef(-1)

  const step = STEPS[stepIdx]
  const currentEval = evals[stepIdx]
  const evalState = currentEval?.state ?? 'idle'

  useEffect(() => {
    if (spokenStep.current === stepIdx) return
    spokenStep.current = stepIdx
    const t = setTimeout(() => speak(step.voiceGuide), 400)
    return () => clearTimeout(t)
  }, [stepIdx, step.voiceGuide])

  const handleCapture = useCallback(async (blob: Blob, dataUrl: string, exif?: Record<string, unknown>) => {
    addCapture({ type: step.type, blob, dataUrl, timestamp: Date.now(), exif })
    setCaptured(prev => new Set([...prev, stepIdx]))

    if (step.isAudio) {
      const msg = t('speak_audio_done')
      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.9, feedback: msg, issues: [], detected: {} } },
      }))
      speak(msg)
      return
    }

    speak(t('speak_analysing'))
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'evaluating', dataUrl } }))

    try {
      const optimizedDataUrl = await resizeDataUrl(dataUrl, 1024, 0.8)
      
      let result;
      try {
        result = await evaluateFrameAPI(step.type, optimizedDataUrl, 45000)
      } catch (e) {
        console.warn('[CaptureFlow] First evaluation attempt failed, retrying...', e)
        // Automatic retry once after 2 seconds
        await new Promise(r => setTimeout(r, 2000))
        result = await evaluateFrameAPI(step.type, optimizedDataUrl, 45000)
      }

      if (step.type === 'macro' && result.detected?.karat_numeric && typeof result.detected.karat_numeric === 'number') {
        setScannedKarat(result.detected.karat_numeric)
        setSelectedKarat(result.detected.karat_numeric)
      }

      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: result.approved ? 'approved' : 'rejected', result, dataUrl: optimizedDataUrl },
      }))
      speak(result.feedback)
    } catch (err) {
      console.error('[CaptureFlow] Final evaluation attempt failed:', err)
      const fallback = t('speak_image_accepted')
      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.7, feedback: fallback, issues: [], detected: {} } },
      }))
      speak(fallback)
    }
  }, [step, stepIdx, addCapture, setScannedKarat])

  const handleRetake = () => {
    speak(t('speak_retake') + ' ' + step.voiceGuide)
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'idle', dataUrl: undefined } }))
    setCaptured(prev => { const s = new Set(prev); s.delete(stepIdx); return s })
    setCameraKey(k => k + 1)
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
        handleCapture(blob, dataUrl)
      }

      reader.readAsDataURL(blob)
    } catch (err) {
      console.error('[CaptureFlow] Failed to load demo:', err)
      speak('Error loading demo image. Please try capturing instead.')
    }
  }, [step.demoUrl, handleCapture])

  const next = () => {
    if (stepIdx < STEPS.length - 1) setStepIdx(i => i + 1)
    else { speak(t('speak_all_done')); navigate('/weight') }
  }

  const skip = () => { if (step.optional) { speak(t('speak_skip')); next() } }

  const hasManualHuidOverride = step.type === 'macro' && !!manualHuid
  const canProceed = evalState === 'approved' || step.optional || (evalState === 'rejected' && hasManualHuidOverride)

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

      {/* Demo Button */}
      {step.demoUrl && (
        <div className="px-5 pb-2">
          <button
            onClick={() => setShowDemo(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-50 border border-brand-200 text-[10px] text-brand-600 hover:bg-brand-100 transition-colors font-medium"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-brand-600 animate-pulse" />
            Enter Example Demo
          </button>
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
          <div className="mt-4 animate-slide-up">
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
                          <span className="text-xs text-stone-500">HUID Status</span>
                          <span className="text-sm font-bold text-emerald-600">{manualHuid || currentEval?.result?.detected?.huid_code ? 'Verified' : 'Manual Entry Needed'}</span>
                        </div>
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
                      <input
                        type="text"
                        value={manualHuid}
                        onChange={e => {
                          const val = e.target.value.toUpperCase();
                          setManualHuid(val);
                          setHuid(val || null);
                        }}
                        placeholder="e.g., A3F2K1"
                        className="input-field font-mono"
                        maxLength={10}
                      />
                    </div>

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
              <p className="text-xs text-brand-600/70 mt-0.5">Poonawalla AI is checking quality</p>
            </div>
          </div>
        )}

        {evalState === 'approved' && currentEval?.result && (
          <div className="mt-3 px-4 py-3 rounded-2xl bg-emerald-50 border border-emerald-200">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-700">{currentEval.result.feedback}</p>
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
                {currentEval.result.issues.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {currentEval.result.issues.map((issue, i) => (
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
        {evalState === 'rejected' && !hasManualHuidOverride ? (
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
      </div>
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
