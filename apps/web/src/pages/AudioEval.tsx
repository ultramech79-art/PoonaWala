/**
 * AudioEval — 5-second acoustic gold authenticity test.
 *
 * Two modes:
 *   Drop — ONE drop from 15–20 cm onto a glass table top. Best discriminator.
 *           Use only for sturdy pieces (ring, bangle, coin).
 *   Tap  — tap 4–5 times with a coin edge. Safer for delicate pieces.
 *
 * Audio capture: DSP fully disabled, 48 kHz mono, raw Float32 PCM → base64.
 * The backend receives raw PCM bytes and runs a librosa physics pipeline.
 * LLM never affects the score — it only explains the measured parameters.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { ChevronRight, Mic, AlertCircle, User } from 'lucide-react'
import { clsx } from 'clsx'
import { apiBase } from '../lib/api'
import { speak } from '../lib/tts'
import { localizeAudioVerdict } from '../lib/feedbackMessages'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTranslation } from 'react-i18next'
import { AudioDemoControl } from '../components/AudioDemoControl'
import {
  REMOTE_AUDIO_DEMO_CHANNEL,
  buildAudioDemoResult,
  consumeRemoteAudioDemoCommand,
  type AudioDemoOutcome,
} from '../lib/audioDemoOverride'

const AUDIO_DURATION_MS = 5_000   // 5 s: one drop from 15–20 cm on glass

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

type Phase = 'intro' | 'ready' | 'recording' | 'analyzing' | 'result'

interface AudioParams {
  decay_time_ms:        number
  spectral_centroid_hz: number
  dominant_freq_hz:     number
  gold_band_ratio:      number
  hf_ratio:             number
  exp_decay_r2:         number
  snr_db:               number
  tap_events:           number
  attack_ms:            number
  q_factor:             number
}

interface TapResult {
  score:               number
  verdict:             string
  confidence:          'low' | 'medium' | 'high'
  params:              AudioParams | null
  explanation:         string
  low_confidence_flag: boolean
  disclaimer:          string
  valid:               boolean
  reject_reason:       string | null
  label:               string
  reasoning:           string
  demo_override?:      boolean
  decay_ms?:           number
  dominant_freq_hz?:   number
}

const STEPS = [
  { n: '1', text: 'Lay the phone flat on a glass surface, mic side down' },
  { n: '2', text: 'Hold the piece 15 to 20 cm above the glass' },
  { n: '3', text: 'Release once and let it ring out on its own' },
  { n: '4', text: 'Stay quiet for the full 5 seconds after the drop' },
]

export function AudioEval() {
  const navigate = useNavigate()
  const { setTapTestResult, skipCapture, setPageEvidence, state } = useSessionStore()
  const { t } = useTranslation()
  const lang = (localStorage.getItem('goldeye_lang') ?? 'en') as 'en' | 'hi'

  const streamRef      = useRef<MediaStream | null>(null)
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const chunksRef      = useRef<Float32Array[]>([])
  const sampleRateRef  = useRef(48000)
  const analyserRef    = useRef<AnalyserNode | null>(null)
  const levelRafRef    = useRef<number>(0)
  const peakDbRef      = useRef(-60)

  const ornament = 'ring'
  const mode     = 'drop'
  const restoredResult: TapResult | null = state.tapTestResult
    ? {
        score: state.tapTestResult.score,
        verdict: state.tapTestResult.label,
        confidence: 'medium',
        params: {
          decay_time_ms: state.tapTestResult.decay_ms,
          spectral_centroid_hz: 0,
          dominant_freq_hz: state.tapTestResult.dominant_freq_hz,
          gold_band_ratio: 0,
          hf_ratio: 0,
          exp_decay_r2: 0,
          snr_db: 0,
          tap_events: 0,
          attack_ms: 0,
          q_factor: 0,
        },
        explanation: state.tapTestResult.reasoning,
        low_confidence_flag: false,
        disclaimer: '',
        valid: true,
        reject_reason: null,
        label: state.tapTestResult.label,
        reasoning: state.tapTestResult.reasoning,
      }
    : null
  const [phase, setPhase]         = useState<Phase>(() => restoredResult ? 'result' : 'intro')
  const [secondsLeft, setSeconds] = useState(0)
  const [result, setResult]       = useState<TapResult | null>(restoredResult)
  const [error, setError]         = useState('')
  const [levelDb, setLevelDb]     = useState(-60)
  const [tapCount, setTapCount]   = useState(0)
  const [showTutorial, setShowTutorial] = useState(true)
  const tapCountRef = useRef(0)
  const lastTapRef  = useRef(0)
  const audioAttemptRef = useRef(0)
  const analysisRunRef = useRef(0)
  const demoResultSelectedRef = useRef(false)

  // Speak voice guide on intro
  useEffect(() => {
    const timer = setTimeout(() => speak(t('voice_audio')), 500)
    return () => clearTimeout(timer)
  }, [t])

  useEffect(() => {
    if (phase === 'result') return

    let cancelled = false
    let inFlight = false

    const pollRemoteCommand = async () => {
      if (cancelled || inFlight || demoResultSelectedRef.current) return
      inFlight = true
      try {
        const command = await consumeRemoteAudioDemoCommand(REMOTE_AUDIO_DEMO_CHANNEL)
        if (!cancelled && command.outcome && !demoResultSelectedRef.current) {
          showDemoResult(command.outcome, Date.now())
        }
      } catch (error) {
        console.warn('[AudioDemoRemote] poll failed:', error)
      } finally {
        inFlight = false
      }
    }

    pollRemoteCommand()
    const pollTimer = window.setInterval(pollRemoteCommand, 350)
    return () => {
      cancelled = true
      window.clearInterval(pollTimer)
    }
  }, [phase, mode, ornament])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    cancelAnimationFrame(levelRafRef.current)
  }, [])

  const pollLevel = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
    const db  = rms > 1e-10 ? 20 * Math.log10(rms) : -60
    setLevelDb(db)
    if (db > peakDbRef.current + 8 && db > -30) {
      const now = Date.now()
      if (now - lastTapRef.current > 350) {
        tapCountRef.current += 1
        setTapCount(tapCountRef.current)
        lastTapRef.current = now
      }
    }
    peakDbRef.current = Math.max(peakDbRef.current * 0.98, db)
    levelRafRef.current = requestAnimationFrame(pollLevel)
  }, [])

  async function openMic() {
    setError('')
    setTapCount(0)
    demoResultSelectedRef.current = false
    tapCountRef.current = 0
    peakDbRef.current = -60
    chunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 },
        video: false,
      })
      streamRef.current = stream
      const ctx = new AudioContext({ sampleRate: 48000 })
      audioCtxRef.current = ctx
      sampleRateRef.current = ctx.sampleRate
      const source  = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512
      analyserRef.current = analyser
      const gain = ctx.createGain(); gain.gain.value = 0
      source.connect(analyser); source.connect(gain); gain.connect(ctx.destination)
      ctx.resume().catch(() => {})
      levelRafRef.current = requestAnimationFrame(pollLevel)
      setPhase('ready')
    } catch (e: any) {
      setError(e?.message ?? 'Microphone access denied — grant permission and try again.')
    }
  }

  async function startRecording() {
    if (!streamRef.current || !audioCtxRef.current) return
    const attemptId = audioAttemptRef.current + 1
    audioAttemptRef.current = attemptId
    const shouldContinueAttempt = () =>
      audioAttemptRef.current === attemptId && !demoResultSelectedRef.current

    chunksRef.current = []
    lastTapRef.current = 0
    setPhase('recording')
    setSeconds(Math.ceil(AUDIO_DURATION_MS / 1000))

    try {
      const ctx = audioCtxRef.current
      const stream = streamRef.current
      const source    = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      const gain = ctx.createGain(); gain.gain.value = 0
      source.connect(processor); processor.connect(gain); gain.connect(ctx.destination)
      processor.onaudioprocess = e =>
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))

      const startedAt = Date.now()
      const tickIv = setInterval(() =>
        setSeconds(Math.max(0, Math.ceil((AUDIO_DURATION_MS - (Date.now() - startedAt)) / 1000))), 250)

      await new Promise(r => setTimeout(r, AUDIO_DURATION_MS))
      clearInterval(tickIv)
      cancelAnimationFrame(levelRafRef.current)

      processor.disconnect(); source.disconnect(); gain.disconnect()
      await ctx.close().catch(() => {})
      stream.getTracks().forEach(t => t.stop()); streamRef.current = null

      if (!shouldContinueAttempt()) return
      setPhase('analyzing')
      await runAnalysis()
    } catch (e: any) {
      if (!shouldContinueAttempt()) return
      cancelAnimationFrame(levelRafRef.current)
      setError(e?.message ?? 'Recording failed. Please try again.')
      setPhase('intro')
    }
  }

  async function runAnalysis() {
    const runId = analysisRunRef.current + 1
    analysisRunRef.current = runId
    const shouldApplyAnalysis = () =>
      analysisRunRef.current === runId && !demoResultSelectedRef.current

    try {
      const total = chunksRef.current.reduce((n, c) => n + c.length, 0)
      const flat  = new Float32Array(total)
      let off = 0
      for (const c of chunksRef.current) { flat.set(c, off); off += c.length }

      // Send raw Float32 PCM bytes — backend decodes and resamples with librosa
      const audioB64 = bytesToBase64(new Uint8Array(flat.buffer))

      const res = await fetch(`${apiBase}/api/audio-eval`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_base64: audioB64,
          sample_rate:  sampleRateRef.current,
          item_type:    ornament,
          mode,
          language:     lang,
        }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data: TapResult = await res.json()
      if (!shouldApplyAnalysis()) return
      setResult(data)
      setTapTestResult(data as any)
      setPageEvidence('audio', {
        skipped: false,
        captured: true,
        analysed: true,
        ignoredForConfidence: true,
        score: data.score,
        valid: data.valid,
        confidence: data.confidence,
        verdict: data.verdict,
        mode,
        ornament,
      })
      if (data.verdict) speak(localizeAudioVerdict(data.verdict, t))
    } catch (e: any) {
      if (!shouldApplyAnalysis()) return
      setError(e?.message ?? 'Analysis failed.')
      setPageEvidence('audio', {
        skipped: false,
        captured: true,
        analysed: false,
        ignoredForConfidence: true,
        error: e?.message ?? 'analysis_failed',
        mode,
        ornament,
      })
    }
    if (shouldApplyAnalysis()) setPhase('result')
  }

  function showDemoResult(outcome: Exclude<AudioDemoOutcome, 'off'>, updatedAt: number) {
    audioAttemptRef.current += 1
    demoResultSelectedRef.current = true
    analysisRunRef.current += 1
    cancelAnimationFrame(levelRafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    const data = buildAudioDemoResult({ outcome, mode, ornament, updatedAt }) as TapResult
    setError('')
    setShowTutorial(false)
    setResult(data)
    setTapTestResult(data as any)
    setPageEvidence('audio', {
      skipped: false,
      captured: true,
      analysed: true,
      ignoredForConfidence: true,
      score: data.score,
      valid: data.valid,
      confidence: data.confidence,
      verdict: data.verdict,
      mode,
      ornament,
      demoOverride: true,
      demoOutcome: outcome,
    })
    setPhase('result')
  }

  function returnToIntro() {
    audioAttemptRef.current += 1
    demoResultSelectedRef.current = false
    cancelAnimationFrame(levelRafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null
    audioCtxRef.current?.close().catch(() => {}); audioCtxRef.current = null
    setResult(null)
    setError('')
    setPhase('intro')
  }

  function skipAudio() {
    skipCapture('audio')
    setTapTestResult(null)
    setPageEvidence('audio', {
      skipped: true,
      captured: false,
      analysed: false,
      ignoredForConfidence: true,
      score: null,
    })
    navigate('/certificate-scan')
  }

  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400' : 'bg-red-400'
  const levelPct   = Math.min(100, Math.max(0, (levelDb + 60) / 60 * 100))

  return (
    <div className="page app-page-bg overflow-y-auto">

      {showTutorial && phase === 'intro' && (
        <TutorialOverlay stepType="audio" onDismiss={() => setShowTutorial(false)} />
      )}

      {/* Header */}
      <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
        <button
          onClick={() => phase !== 'recording' && navigate('/video-eval')}
          className={clsx('flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md', phase === 'recording' && 'opacity-30 cursor-not-allowed')}
          disabled={phase === 'recording'}
        >
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-0.5 rounded-full bg-stone-100/80 border border-stone-200/60">Step 7 / 8</span>
          <span className="text-base font-bold text-stone-950 tracking-tight">Audio Test</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => speak(t('voice_audio'))}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
            disabled={phase === 'recording'}
          >
            <Mic className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
          >
            <User className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="px-5 py-5 space-y-4">

        {/* INTRO */}
        {phase === 'intro' && (
          <div className="animate-fade-in">
            {/* Description */}
            <div className="pt-2 pb-6">
              <p className="text-3xl font-black text-stone-950 tracking-tight leading-none">5 seconds</p>
              <p className="text-base font-bold text-stone-400 mt-1">One Drop Test</p>
              <p className="text-stone-400 text-sm mt-2 leading-relaxed">
                Gold holds its ring far longer than imitation metals. The mic captures that decay.
              </p>
            </div>

            {/* Steps — no card, thin dividers */}
            <div className="border-t border-stone-200/70">
              {STEPS.map(({ n, text }, i) => (
                <div key={n} className={clsx('flex items-center gap-4 py-4', i < STEPS.length - 1 && 'border-b border-stone-200/50')}>
                  <span className="text-[11px] font-bold text-stone-300 tabular-nums w-5 flex-shrink-0">{n}</span>
                  <p className="text-[15px] text-stone-700 font-medium leading-snug">{text}</p>
                </div>
              ))}
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3 mt-4">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <div className="mt-6 space-y-3">
              <button onClick={openMic} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 hover:bg-stone-900 text-white font-semibold transition-colors active:scale-[0.98]">
                <Mic className="w-5 h-5" /> Start 5-Second Recording
              </button>
              <button onClick={skipAudio} className="w-full py-3 text-sm font-medium text-stone-400 hover:text-stone-600 transition-colors">
                Skip Audio Test
              </button>
            </div>
          </div>
        )}

        {/* READY — mic open, waiting for tap */}
        {phase === 'ready' && (
          <div className="flex flex-col items-center gap-5 py-10 animate-fade-in">
            <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold">Tap when about to drop</p>
            <button
              onClick={startRecording}
              className="w-20 h-20 rounded-full bg-stone-950 hover:bg-stone-800 active:scale-95 transition-all shadow-xl flex items-center justify-center"
            >
              <Mic className="w-8 h-8 text-white" />
            </button>
            <p className="text-stone-400 text-xs text-center px-8 leading-relaxed">
              Hold the piece 15 to 20 cm above the glass, then tap and drop.
            </p>
            <div className="w-full bg-stone-100 rounded-full h-3 overflow-hidden relative mt-2">
              <div className={clsx('h-3 rounded-full transition-all duration-75',
                levelPct > 65 ? 'bg-emerald-500' : levelPct > 30 ? 'bg-amber-400' : 'bg-stone-300')}
                style={{ width: `${levelPct}%` }} />
              <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white/70 uppercase tracking-widest">mic</span>
            </div>
          </div>
        )}

        {/* RECORDING */}
        {phase === 'recording' && (
          <div className="flex flex-col items-center gap-6 py-8 animate-fade-in">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-32 h-32 rounded-full bg-amber-400/15 animate-ping" style={{ animationDuration: '1.2s' }} />
              <div className="absolute w-20 h-20 rounded-full bg-amber-400/20 animate-ping" style={{ animationDuration: '1.2s', animationDelay: '0.25s' }} />
              <div className="w-16 h-16 rounded-full bg-stone-950 flex items-center justify-center shadow-2xl">
                <Mic className="w-7 h-7 text-white" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-stone-950 font-black text-5xl tabular-nums leading-none">{secondsLeft}</p>
              <p className="text-stone-400 text-xs mt-2">seconds remaining</p>
            </div>
            <div className="w-full bg-stone-200 rounded-full h-1">
              <div className="h-1 rounded-full bg-stone-950 transition-all duration-300"
                style={{ width: `${100 - (secondsLeft / (AUDIO_DURATION_MS / 1000)) * 100}%` }} />
            </div>
            <div className="w-full bg-stone-100 rounded-full h-3 overflow-hidden relative">
              <div className={clsx('h-3 rounded-full transition-all duration-75',
                levelPct > 65 ? 'bg-emerald-500' : levelPct > 30 ? 'bg-amber-400' : 'bg-stone-300')}
                style={{ width: `${levelPct}%` }} />
              <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white/70 uppercase tracking-widest">mic</span>
            </div>
            {tapCount > 0 && (
              <p className="text-emerald-600 text-sm font-semibold">Impact detected</p>
            )}
          </div>
        )}

        {/* ANALYZING */}
        {phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 animate-fade-in">
            <AudioDemoControl onOutcomeSelect={(outcome, updatedAt) => { if (outcome !== 'off') showDemoResult(outcome, updatedAt) }} />
            <img src="/assets/4aee05b8-1171-11ee-aebc-033b1299bb801-ezgif.com-gif-maker.gif" alt="Analysing…" className="w-44 h-44 object-contain" />
            <div className="text-center mt-2">
              <p className="font-bold text-stone-900 text-base tracking-tight">Analysing acoustic signature</p>
              <p className="text-stone-400 text-sm mt-1">Measuring decay profile and resonance</p>
            </div>
          </div>
        )}

        {/* RESULT */}
        {phase === 'result' && (
          <div className="space-y-4 animate-fade-in">
            {result && !result.valid ? (
              <div className="space-y-3">
                <div className="scan-panel rounded-3xl p-5 flex flex-col items-center gap-3 text-center">
                  <AlertCircle className="w-8 h-8 text-red-500" />
                  <p className="font-bold text-stone-900">Recording not usable</p>
                  <p className="text-sm text-stone-600 leading-relaxed">{result.reject_reason}</p>
                  <p className="text-xs text-stone-400">Drop once from 15 to 20 cm onto glass and let it ring out fully.</p>
                </div>
                <button onClick={returnToIntro} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 text-white font-semibold active:scale-[0.98]">
                  <Mic className="w-5 h-5" /> Try Again
                </button>
                <button onClick={skipAudio} className="w-full btn-secondary text-sm">Skip</button>
              </div>
            ) : result ? (
              <div className="space-y-3">
                <div className="scan-panel rounded-3xl p-5 space-y-3">
                  <p className="text-[10px] text-stone-400 uppercase tracking-widest font-semibold">Drop Test Result</p>
                  <div className="flex items-end gap-3">
                    <p className={clsx('text-5xl font-black', scoreColor(result.score))}>{result.score}</p>
                    <p className="text-stone-400 text-sm mb-1">/ 100</p>
                  </div>
                  <div className="w-full bg-stone-100 rounded-full h-2">
                    <div className={clsx('h-2 rounded-full transition-all', barColor(result.score))} style={{ width: `${result.score}%` }} />
                  </div>
                  <p className="text-sm font-semibold text-stone-800">{localizeAudioVerdict(result.verdict, t)}</p>
                  {result.explanation && <p className="text-xs text-stone-500 leading-relaxed">{result.explanation}</p>}
                </div>
                {(result.low_confidence_flag || result.confidence === 'low') && (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">Signal is ambiguous. Try again with one clean drop from 15 to 20 cm onto flat glass.</p>
                  </div>
                )}
                <button onClick={() => navigate('/certificate-scan')} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 text-white font-semibold active:scale-[0.98]">
                  Continue to Bill Scan <ChevronRight className="w-4 h-4" />
                </button>
                <button onClick={returnToIntro} className="w-full btn-secondary text-sm">Try Again</button>
              </div>
            ) : (
              <div className="scan-panel rounded-2xl px-4 py-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-stone-700">{error || 'Analysis failed. Please try again.'}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
