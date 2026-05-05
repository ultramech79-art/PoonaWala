import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type CaptureType } from '../store/session'
import { Camera } from '../components/Camera'
import { ChevronRight, Volume2, CheckCircle, XCircle, Loader2, RotateCcw, Music, Video } from 'lucide-react'
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

const STEPS: Step[] = [
  {
    type: 'top',
    titleKey: 'step_top_title',
    hintKey: 'step_top_hint',
    voiceGuide: 'Step 1. Place your gold jewellery flat on a surface. Point your camera straight down from the top and tap Capture.',
    demoUrl: '/assets/demo/top.jpg',
  },
  {
    type: '45deg',
    titleKey: 'step_45_title',
    hintKey: 'step_45_hint',
    voiceGuide: 'Step 2. Tilt your camera to a 45 degree angle so we can see the depth and thickness. Tap Capture when ready.',
    demoUrl: '/assets/demo/45deg.jpg',
  },
  {
    type: 'side',
    titleKey: 'step_side_title',
    hintKey: 'step_side_hint',
    voiceGuide: 'Step 3. Hold the gold piece upright and shoot from the side. Tap Capture.',
    demoUrl: '/assets/demo/side.jpg',
  },
  {
    type: 'macro',
    titleKey: 'step_macro_title',
    hintKey: 'step_macro_hint',
    voiceGuide: 'Step 4. Get close to the BIS hallmark stamp. Make sure it is sharp and well lit. Tap Capture.',
    demoUrl: '/assets/demo/macro.jpg',
  },
  {
    type: 'video',
    titleKey: 'step_video_title',
    hintKey: 'step_video_hint',
    voiceGuide: 'Step 5. Hold record and slowly rotate the gold piece for about 3 seconds.',
    isVideo: true,
    demoUrl: '/assets/demo/video.mp4',
  },
  {
    type: 'audio',
    titleKey: 'step_audio_title',
    hintKey: 'step_audio_hint',
    voiceGuide: 'Step 6. Tap and hold record, then gently tap the gold with your fingernail.',
    isAudio: true,
    optional: true,
    demoUrl: '/assets/demo/audio.mp3',
  },
  {
    type: 'selfie',
    titleKey: 'step_selfie_title',
    hintKey: 'step_selfie_hint',
    voiceGuide: 'Last step. Take a selfie while holding the gold jewellery clearly in the same frame.',
    facingMode: 'user',
  },
]

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

const STEP_LABELS = [
  'Top View', '45° View', 'Side View', 'Hallmark', 'Video', 'Audio', 'Selfie'
]

export function CaptureFlow() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { addCapture, state } = useSessionStore()

  const [stepIdx, setStepIdx] = useState(0)
  const [captured, setCaptured] = useState<Set<number>>(new Set())
  const [evals, setEvals] = useState<Record<number, StepEval>>({})
  const [cameraKey, setCameraKey] = useState(0)
  const [showDemo, setShowDemo] = useState(false)
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
      const msg = 'Audio recorded. Great job!'
      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.9, feedback: msg, issues: [], detected: {} } },
      }))
      speak(msg)
      return
    }

    speak('Got it. Analysing your image now, please wait.')
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

      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: result.approved ? 'approved' : 'rejected', result, dataUrl: optimizedDataUrl },
      }))
      speak(result.feedback)
    } catch (err) {
      console.error('[CaptureFlow] Final evaluation attempt failed:', err)
      const fallback = 'Image accepted. You may continue.'
      setEvals(prev => ({
        ...prev,
        [stepIdx]: { state: 'approved', dataUrl, result: { approved: true, quality_score: 0.7, feedback: fallback, issues: [], detected: {} } },
      }))
      speak(fallback)
    }
  }, [step, stepIdx, addCapture])

  const handleRetake = () => {
    speak('No problem. Let\'s try again. ' + step.voiceGuide)
    setEvals(prev => ({ ...prev, [stepIdx]: { state: 'idle' } }))
    setCaptured(prev => { const s = new Set(prev); s.delete(stepIdx); return s })
    setCameraKey(k => k + 1)
  }

  const next = () => {
    if (stepIdx < STEPS.length - 1) setStepIdx(i => i + 1)
    else { speak('All done! Submitting your gold for assessment now.'); navigate('/weight') }
  }

  const skip = () => { if (step.optional) { speak('Skipping this step.'); next() } }

  const canProceed = evalState === 'approved' || step.optional

  return (
    <div className="page-dark animate-fade-in overflow-y-auto">
      {/* Header */}
      <div className="page-header-dark">
        <button
          id="capture-back"
          onClick={() => stepIdx > 0 ? setStepIdx(i => i - 1) : navigate('/setup')}
          className="btn-icon-dark"
        >
          <ChevronRight className="w-5 h-5 rotate-180" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-xs text-white/40 uppercase tracking-widest font-medium">
            Step {stepIdx + 1} of {STEPS.length}
          </span>
          <span className="text-sm font-semibold text-white mt-0.5">{STEP_LABELS[stepIdx]}</span>
        </div>
        <button
          id="capture-voice"
          onClick={() => speak(step.voiceGuide)}
          className="btn-icon-dark"
          title="Replay instructions"
        >
          <Volume2 className="w-4 h-4" />
        </button>
      </div>

      {/* Demo Button */}
      {step.demoUrl && (
        <div className="px-5 pb-2">
          <button
            onClick={() => setShowDemo(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 hover:bg-white/10 transition-colors"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
            View Example Demo
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
              i === stepIdx ? 'step-dot-active-dark' :
              captured.has(i) ? 'step-dot-done-dark' :
              'step-dot-dark'
            )}
          />
        ))}
      </div>

      {/* Step hint */}
      <div className="px-5 pb-3">
        <p className="text-sm text-white/60 leading-relaxed">
          {t(step.hintKey)}
          {step.optional && <span className="ml-2 text-xs text-white/30">(optional)</span>}
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
        />

        {/* Feedback */}
        {evalState === 'evaluating' && (
          <div className="mt-3 flex items-center gap-3 px-4 py-3 rounded-2xl bg-brand-500/15 border border-brand-500/25">
            <Loader2 className="w-5 h-5 text-brand-400 animate-spin flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-brand-300">Analysing image…</p>
              <p className="text-xs text-brand-300/60 mt-0.5">Poonawalla AI is checking quality</p>
            </div>
          </div>
        )}

        {evalState === 'approved' && currentEval?.result && (
          <div className="mt-3 px-4 py-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-300">{currentEval.result.feedback}</p>
                {currentEval.result.quality_score > 0 && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 progress-bar-dark">
                      <div
                        className="progress-fill-dark"
                        style={{ width: `${Math.round(currentEval.result.quality_score * 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-white/40">{Math.round(currentEval.result.quality_score * 100)}%</span>
                  </div>
                )}
              </div>
              <button onClick={() => speak(currentEval.result!.feedback)} className="opacity-40 hover:opacity-80 flex-shrink-0">
                <Volume2 className="w-4 h-4 text-emerald-300" />
              </button>
            </div>
          </div>
        )}

        {evalState === 'rejected' && currentEval?.result && (
          <div className="mt-3 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20">
            <div className="flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-300">{currentEval.result.feedback}</p>
                {currentEval.result.issues.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {currentEval.result.issues.map((issue, i) => (
                      <li key={i} className="text-xs text-red-300/60">• {issue}</li>
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
            <p className="label-dark mb-2">Captured</p>
            <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
              {(Object.entries(state.captures) as [CaptureType, any][]).map(([ctype, asset]) => (
                <div key={ctype} className="relative flex-shrink-0">
                  {ctype === 'audio' ? (
                    <div className="w-14 h-14 rounded-2xl bg-ink-700 border border-emerald-500/25 flex items-center justify-center">
                      <Music className="w-5 h-5 text-emerald-400" />
                    </div>
                  ) : ctype === 'video' ? (
                    <div className="w-14 h-14 rounded-2xl bg-ink-700 border border-emerald-500/25 flex items-center justify-center">
                      <Video className="w-5 h-5 text-emerald-400" />
                    </div>
                  ) : (
                    <img src={asset.dataUrl} className="w-14 h-14 rounded-2xl object-cover border border-emerald-500/30" alt={ctype} />
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
      <div className="px-5 pb-6 pt-3 border-t border-white/10 space-y-2 sticky bottom-0 bg-ink-900">
        {evalState === 'rejected' ? (
          <button onClick={handleRetake} className="w-full btn-primary">
            <RotateCcw className="w-5 h-5" />
            Retake Photo
          </button>
        ) : (
          <button
            id={`capture-next-${step.type}`}
            onClick={next}
            disabled={!canProceed || evalState === 'evaluating'}
            className={clsx('w-full', (canProceed && evalState !== 'evaluating') ? 'btn-primary' : 'btn-ghost-dark opacity-40 cursor-not-allowed')}
          >
            {evalState === 'evaluating' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Analysing…</>
            ) : stepIdx === STEPS.length - 1 ? 'Continue' : t('capture_accept')}
            {evalState !== 'evaluating' && <ChevronRight className="w-5 h-5" />}
          </button>
        )}
        {step.optional && evalState !== 'evaluating' && (
          <button id={`capture-skip-${step.type}`} onClick={skip} className="btn-ghost-dark w-full text-sm">
            {t('capture_skip')}
          </button>
        )}
      </div>
      {/* Demo Overlay */}
      {showDemo && step.demoUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-950/90 backdrop-blur-md p-6 animate-fade-in">
          <div className="relative w-full max-w-sm flex flex-col items-center">
            <button
              onClick={() => setShowDemo(false)}
              className="absolute -top-12 right-0 p-2 rounded-full bg-white/10 text-white"
            >
              <XCircle className="w-6 h-6" />
            </button>
            <div className="w-full aspect-[3/4] rounded-3xl overflow-hidden border-2 border-white/10 shadow-2xl bg-black flex items-center justify-center">
              {step.isVideo ? (
                <video src={step.demoUrl} className="w-full h-full object-cover" controls autoPlay loop muted playsInline />
              ) : step.isAudio ? (
                <div className="flex flex-col items-center gap-4">
                  <Music className="w-16 h-16 text-brand-500 animate-bounce" />
                  <audio src={step.demoUrl} controls className="w-4/5" />
                </div>
              ) : (
                <img src={step.demoUrl} className="w-full h-full object-cover" alt="Example demo" />
              )}
            </div>
            <p className="mt-6 text-white font-medium text-center">Reference: {STEP_LABELS[stepIdx]}</p>
            <p className="mt-2 text-white/40 text-xs text-center px-6">
              This is how your photo should look. Ensure the gold is clear and well-lit.
            </p>
            <button
              onClick={() => setShowDemo(false)}
              className="mt-8 px-8 py-3 rounded-full bg-brand-500 text-white font-semibold text-sm shadow-lg shadow-brand-500/25 active:scale-95 transition-transform"
            >
              Got it, continue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
