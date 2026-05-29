/**
 * AudioEval — 10-second acoustic gold authenticity test.
 *
 * Two modes:
 *   Drop — drop from ~20 cm onto a glass table top. Best discriminator.
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
import { ChevronRight, Mic, AlertCircle, SkipForward, CheckCircle, Zap, Hand } from 'lucide-react'
import { clsx } from 'clsx'
import { apiBase } from '../lib/api'
import { speak } from '../lib/tts'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTranslation } from 'react-i18next'

const AUDIO_DURATION_MS = 10_000

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

type Phase = 'intro' | 'recording' | 'analyzing' | 'result'
type TestMode = 'drop' | 'tap'

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
}

const ORNAMENTS = [
  { id: 'ring',     label: 'Ring',     safe: 'drop' as TestMode },
  { id: 'bangle',   label: 'Bangle',   safe: 'drop' as TestMode },
  { id: 'coin',     label: 'Coin/Bar', safe: 'drop' as TestMode },
  { id: 'necklace', label: 'Necklace', safe: 'tap'  as TestMode },
  { id: 'pendant',  label: 'Pendant',  safe: 'tap'  as TestMode },
  { id: 'earring',  label: 'Earring',  safe: 'tap'  as TestMode },
]

export function AudioEval() {
  const navigate = useNavigate()
  const { setTapTestResult } = useSessionStore()
  const { t } = useTranslation()
  const lang = (localStorage.getItem('goldeye_lang') ?? 'en') as 'en' | 'hi'

  const streamRef      = useRef<MediaStream | null>(null)
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const chunksRef      = useRef<Float32Array[]>([])
  const sampleRateRef  = useRef(48000)
  const analyserRef    = useRef<AnalyserNode | null>(null)
  const levelRafRef    = useRef<number>(0)
  const peakDbRef      = useRef(-60)

  const [ornament, setOrnament]   = useState('ring')
  const [mode, setMode]           = useState<TestMode>('drop')
  const [phase, setPhase]         = useState<Phase>('intro')
  const [secondsLeft, setSeconds] = useState(0)
  const [result, setResult]       = useState<TapResult | null>(null)
  const [error, setError]         = useState('')
  const [levelDb, setLevelDb]     = useState(-60)
  const [tapCount, setTapCount]   = useState(0)
  const [showTutorial, setShowTutorial] = useState(true)
  const tapCountRef = useRef(0)
  const lastTapRef  = useRef(0)

  // Speak voice guide on intro
  useEffect(() => {
    const timer = setTimeout(() => speak(t('voice_audio')), 500)
    return () => clearTimeout(timer)
  }, [t])

  // Auto-set safe mode when ornament changes
  useEffect(() => {
    const rec = ORNAMENTS.find(o => o.id === ornament)
    if (rec) setMode(rec.safe)
  }, [ornament])

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

  async function startRecording() {
    setError('')
    setTapCount(0)
    tapCountRef.current = 0
    peakDbRef.current = -60
    lastTapRef.current = 0
    chunksRef.current = []
    setPhase('recording')
    setSeconds(Math.ceil(AUDIO_DURATION_MS / 1000))

    try {
      // DSP fully disabled — critical: AGC / noise suppression flatten the decay
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       48000,
          channelCount:     1,
        },
        video: false,
      })
      streamRef.current = stream

      const ctx     = new AudioContext({ sampleRate: 48000 })
      audioCtxRef.current  = ctx
      sampleRateRef.current = ctx.sampleRate

      const source    = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      const analyser  = ctx.createAnalyser(); analyser.fftSize = 512
      analyserRef.current = analyser
      const gain = ctx.createGain(); gain.gain.value = 0

      source.connect(analyser)
      source.connect(processor)
      processor.connect(gain); gain.connect(ctx.destination)
      ctx.resume().catch(() => {})

      processor.onaudioprocess = e =>
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))

      levelRafRef.current = requestAnimationFrame(pollLevel)

      const startedAt = Date.now()
      const tickIv = setInterval(() =>
        setSeconds(Math.max(0, Math.ceil((AUDIO_DURATION_MS - (Date.now() - startedAt)) / 1000))), 250)

      await new Promise(r => setTimeout(r, AUDIO_DURATION_MS))
      clearInterval(tickIv)
      cancelAnimationFrame(levelRafRef.current)

      processor.disconnect(); source.disconnect(); analyser.disconnect(); gain.disconnect()
      await ctx.close().catch(() => {})
      stream.getTracks().forEach(t => t.stop()); streamRef.current = null

      setPhase('analyzing')
      await runAnalysis()
    } catch (e: any) {
      cancelAnimationFrame(levelRafRef.current)
      setError(e?.message ?? 'Microphone access denied — grant permission and try again.')
      setPhase('intro')
    }
  }

  async function runAnalysis() {
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
      setResult(data)
      setTapTestResult(data as any)
      if (data.verdict) speak(data.verdict)
    } catch (e: any) {
      setError(e?.message ?? 'Analysis failed.')
    }
    setPhase('result')
  }

  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400' : 'bg-red-400'
  const confColor  = (c: string) =>
    c === 'high' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' :
    c === 'medium' ? 'bg-amber-100 text-amber-700 border-amber-200' :
    'bg-red-100 text-red-700 border-red-200'

  const levelPct = Math.min(100, Math.max(0, (levelDb + 60) / 60 * 100))
  const isFragile = ['necklace', 'earring', 'pendant'].includes(ornament)

  const dropInstructions = [
    { icon: '🔵', step: 'Place phone flat on the glass table top, mic facing up', note: 'This picks up the ring directly through the glass surface' },
    { icon: '📏', step: 'Hold the ornament ~20 cm above the glass and release', note: 'Keep fingers relaxed — let it fall freely' },
    { icon: '⏱️', step: 'Wait until the ring sound fully stops — then drop once more', note: 'Max 2 drops total. Let each ring decay completely before the next.' },
    { icon: '🔇', step: 'Keep the room quiet', note: 'Background noise shortens the measurable ring time' },
  ]

  const tapInstructions = [
    { icon: '🪙', step: 'Hold the ornament near a hard glass or marble surface', note: 'Avoid cloth, carpet, or your palm — soft surfaces kill the ring' },
    { icon: '👆', step: 'Tap firmly 4–5 times with a coin edge or fingernail', note: 'Each tap should produce a clear metallic sound' },
    { icon: '📱', step: 'Keep the phone microphone 10–15 cm from the ornament', note: 'Too far = too quiet; too close = clipping' },
    { icon: '🔇', step: 'Keep the room quiet', note: 'Background noise reduces confidence' },
  ]

  const instructions = mode === 'drop' ? dropInstructions : tapInstructions

  return (
    <div className="page bg-gradient-to-b from-stone-50 to-white overflow-y-auto">

      {/* Tutorial overlay */}
      {showTutorial && phase === 'intro' && (
        <TutorialOverlay stepType="audio" onDismiss={() => setShowTutorial(false)} />
      )}

      {/* Header */}
      <div className="page-header">
        <button onClick={() => phase !== 'recording' && navigate('/video-eval')}
          className={clsx('btn-icon', phase === 'recording' && 'opacity-30 cursor-not-allowed')}
          disabled={phase === 'recording'}>
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">Acoustic Test</span>
          <span className="text-sm font-semibold text-stone-900 mt-0.5">10-Second Sound Test</span>
        </div>
        <button
          onClick={() => speak(t('voice_audio'))}
          className="btn-icon"
          title="Replay instructions"
          disabled={phase === 'recording'}
        >
          <Mic className="w-4 h-4 text-stone-500" />
        </button>
      </div>

      <div className="px-5 py-4 space-y-4">

        {/* ── INTRO ─────────────────────────────────────────────────────────── */}
        {phase === 'intro' && (
          <div className="space-y-4 animate-fade-in">

            {/* Hero */}
            <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-slate-900 to-blue-900 p-6">
              <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-blue-500/10 -translate-y-12 translate-x-12" />
              <div className="relative">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-2xl bg-blue-500 flex items-center justify-center shadow-lg">
                    <Mic className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <p className="font-bold text-white">Gold Ring Test</p>
                    <p className="text-blue-200 text-xs">Acoustic fingerprint analysis</p>
                  </div>
                </div>
                <p className="text-white/80 text-sm leading-relaxed">
                  Real gold has very low internal damping — it resonates longer after impact. Imitation metals (brass, zinc alloy) damp faster and ring for a shorter time. The mic captures the decay profile and our physics model scores the material.
                </p>
                <div className="mt-4 flex gap-3">
                  <div className="flex-1 bg-white/10 rounded-2xl px-3 py-2.5 text-center">
                    <p className="text-white font-bold text-sm">Drop test</p>
                    <p className="text-blue-200 text-[10px] mt-0.5">Most accurate · ~20 cm on glass</p>
                  </div>
                  <div className="flex-1 bg-white/10 rounded-2xl px-3 py-2.5 text-center">
                    <p className="text-white font-bold text-sm">Tap test</p>
                    <p className="text-blue-200 text-[10px] mt-0.5">Safer · for delicate pieces</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Ornament picker */}
            <div className="bg-white border border-stone-200 rounded-2xl p-4">
              <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold mb-3">What are you testing?</p>
              <div className="grid grid-cols-3 gap-2">
                {ORNAMENTS.map(({ id, label, safe }) => (
                  <button key={id} onClick={() => setOrnament(id)}
                    className={clsx(
                      'py-2.5 rounded-xl text-xs font-semibold border transition-all',
                      ornament === id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100'
                    )}>
                    <span className="block">{label}</span>
                    <span className={clsx('text-[9px] mt-0.5 block font-medium', ornament === id ? 'text-blue-200' : 'text-stone-400')}>
                      {safe === 'drop' ? '→ drop' : '→ tap'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Mode toggle */}
            <div className="bg-white border border-stone-200 rounded-2xl p-4">
              <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold mb-3">Test method</p>
              <div className="grid grid-cols-2 gap-2">
                {/* Drop */}
                <button onClick={() => setMode('drop')}
                  className={clsx('rounded-2xl p-3 border text-left transition-all', mode === 'drop' ? 'bg-blue-600 border-blue-600' : 'bg-stone-50 border-stone-200 hover:bg-stone-100')}>
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className={clsx('w-4 h-4', mode === 'drop' ? 'text-blue-200' : 'text-blue-600')} />
                    <span className={clsx('text-xs font-bold', mode === 'drop' ? 'text-white' : 'text-stone-800')}>Drop test</span>
                    {!isFragile && <span className="text-[9px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full font-bold">Best</span>}
                  </div>
                  <p className={clsx('text-[10px] leading-snug', mode === 'drop' ? 'text-blue-100' : 'text-stone-500')}>
                    Drop ~20 cm onto glass. Gold's long resonance is the clearest discriminator. Recommended for rings and bangles.
                  </p>
                </button>
                {/* Tap */}
                <button onClick={() => setMode('tap')}
                  className={clsx('rounded-2xl p-3 border text-left transition-all', mode === 'tap' ? 'bg-blue-600 border-blue-600' : 'bg-stone-50 border-stone-200 hover:bg-stone-100')}>
                  <div className="flex items-center gap-2 mb-1">
                    <Hand className={clsx('w-4 h-4', mode === 'tap' ? 'text-blue-200' : 'text-amber-500')} />
                    <span className={clsx('text-xs font-bold', mode === 'tap' ? 'text-white' : 'text-stone-800')}>Tap test</span>
                    {isFragile && <span className="text-[9px] bg-amber-500 text-white px-1.5 py-0.5 rounded-full font-bold">Safer</span>}
                  </div>
                  <p className={clsx('text-[10px] leading-snug', mode === 'tap' ? 'text-blue-100' : 'text-stone-500')}>
                    Tap with coin edge on glass. Use if the piece is fragile or has stones.
                  </p>
                </button>
              </div>

              {mode === 'drop' && isFragile && (
                <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-[10px] text-amber-700">Delicate piece detected. Switch to Tap to avoid damage.</p>
                </div>
              )}
            </div>

            {/* Step-by-step instructions */}
            <div className="bg-white border border-stone-200 rounded-2xl p-4">
              <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold mb-3">
                How to record — {mode === 'drop' ? 'Drop Test' : 'Tap Test'}
              </p>
              <div className="space-y-3">
                {instructions.map(({ icon, step, note }, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
                    <div>
                      <p className="text-sm text-stone-800 font-medium">{step}</p>
                      <p className="text-xs text-stone-400 mt-0.5">{note}</p>
                    </div>
                  </div>
                ))}
              </div>

              {mode === 'drop' && (
                <div className="mt-3 pt-3 border-t border-stone-100">
                  <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">
                    <span className="text-sm">📐</span>
                    <p className="text-[10px] text-blue-700 font-medium">
                      <strong>~20 cm drop, max 2 drops, wait between.</strong> Real gold rings for longer — its low internal damping sustains the resonance. Base metals damp and stop faster.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button onClick={startRecording} className="w-full btn-primary">
              <Mic className="w-5 h-5" />
              Start 10-Second Recording
            </button>
            <button onClick={() => navigate('/certificate-scan')}
              className="w-full btn-secondary text-sm flex items-center justify-center gap-2">
              <SkipForward className="w-4 h-4" /> Skip Acoustic Test
            </button>
          </div>
        )}

        {/* ── RECORDING ─────────────────────────────────────────────────────── */}
        {phase === 'recording' && (
          <div className="flex flex-col items-center gap-6 py-6 animate-fade-in">
            {/* Animated mic */}
            <div className="relative flex items-center justify-center">
              <div className="absolute w-40 h-40 rounded-full bg-blue-400/15 animate-ping" style={{ animationDuration: '1.5s' }} />
              <div className="absolute w-28 h-28 rounded-full bg-blue-400/20 animate-ping" style={{ animationDuration: '1.5s', animationDelay: '0.3s' }} />
              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-2xl shadow-blue-500/40">
                <Mic className="w-10 h-10 text-white" />
              </div>
            </div>

            {/* Countdown */}
            <div className="text-center">
              <p className="text-stone-900 font-black text-5xl tabular-nums">{secondsLeft}<span className="text-2xl text-stone-400 font-semibold">s</span></p>
              <p className="text-stone-500 text-sm mt-2 font-medium">
                {mode === 'drop'
                  ? 'Drop from ~20 cm onto glass — wait until silent — drop once more'
                  : 'Tap the ornament 4–5 times with coin edge'}
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-64 bg-stone-100 rounded-full h-2 overflow-hidden">
              <div className="h-2 rounded-full bg-blue-500 transition-all duration-250"
                style={{ width: `${100 - (secondsLeft / (AUDIO_DURATION_MS / 1000)) * 100}%` }} />
            </div>

            {/* Level meter */}
            <div className="w-64 space-y-2">
              <div className="w-full bg-stone-100 rounded-full h-4 overflow-hidden relative">
                <div className={clsx('h-4 rounded-full transition-all duration-75',
                  levelPct > 65 ? 'bg-emerald-500' : levelPct > 30 ? 'bg-blue-400' : 'bg-stone-300')}
                  style={{ width: `${levelPct}%` }} />
                <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white/70">MIC</span>
              </div>

              {/* Tap counter */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-400">
                  {mode === 'drop' ? 'Impacts detected:' : 'Taps detected:'}
                </span>
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: Math.max(3, tapCount + 1) }).map((_, i) => (
                    <div key={i} className={clsx('w-3 h-3 rounded-full transition-all',
                      i < tapCount ? 'bg-emerald-500 scale-110' : 'bg-stone-200')} />
                  ))}
                  {tapCount > 0 && (
                    <span className="text-emerald-600 text-xs font-bold ml-1">✓ {tapCount}</span>
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs text-stone-400 text-center px-6 leading-relaxed">
              Recording ends automatically. Keep environment quiet.
            </p>
          </div>
        )}

        {/* ── ANALYZING ─────────────────────────────────────────────────────── */}
        {phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center gap-5 py-24">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-blue-100 rounded-full" />
              <div className="absolute inset-0 w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
            <div className="text-center">
              <p className="font-bold text-stone-900 text-base">Analysing acoustic signature…</p>
              <p className="text-stone-400 text-sm mt-1">Running librosa decay + spectral analysis</p>
            </div>
          </div>
        )}

        {/* ── RESULT ────────────────────────────────────────────────────────── */}
        {phase === 'result' && (
          <div className="space-y-3 animate-fade-in">

            {/* Invalid recording */}
            {result && !result.valid ? (
              <div className="space-y-3">
                <div className="bg-red-50 border border-red-200 rounded-3xl p-5 flex flex-col items-center gap-3 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-red-100 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-500" />
                  </div>
                  <p className="font-bold text-red-800">Recording not usable</p>
                  <p className="text-sm text-red-700 leading-relaxed">{result.reject_reason}</p>
                  <div className="bg-red-100/60 rounded-xl px-3 py-2 w-full text-left">
                    <p className="text-[11px] text-red-600 font-medium">
                      {mode === 'drop'
                        ? '→ Drop from ~20 cm on glass, wait for the ring to fully stop, then drop once more'
                        : '→ Tap harder with a coin edge and hold the phone closer'}
                    </p>
                  </div>
                </div>
                <button onClick={() => { setResult(null); setError(''); setPhase('intro') }} className="w-full btn-primary">
                  <Mic className="w-5 h-5" /> Try Again
                </button>
                <button onClick={() => navigate('/certificate-scan')} className="w-full btn-secondary text-sm flex items-center justify-center gap-2">
                  <SkipForward className="w-4 h-4" /> Skip — Continue Without Acoustic Test
                </button>
              </div>

            ) : result ? (
              <div className="space-y-3">

                {/* Score card */}
                <div className="bg-white border border-stone-200 rounded-3xl overflow-hidden shadow-card">
                  {/* Score header */}
                  <div className={clsx('px-5 pt-5 pb-4',
                    result.score >= 70 ? 'bg-gradient-to-r from-emerald-50 to-white' :
                    result.score >= 45 ? 'bg-gradient-to-r from-amber-50 to-white' :
                    'bg-gradient-to-r from-red-50 to-white')}>
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold mb-1">
                          {mode === 'drop' ? 'Drop Test' : 'Tap Test'} Result
                        </p>
                        <p className={clsx('text-5xl font-black', scoreColor(result.score))}>{result.score}</p>
                        <p className="text-stone-400 text-xs mt-0.5">out of 100</p>
                      </div>
                      <div className="text-right space-y-1.5">
                        <span className={clsx('inline-block text-[10px] font-bold px-2.5 py-1 rounded-full border', confColor(result.confidence))}>
                          {result.confidence} confidence
                        </span>
                        {result.low_confidence_flag && (
                          <p className="text-[10px] text-amber-600 font-medium">⚠ Signal ambiguous</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 w-full bg-stone-100 rounded-full h-2.5">
                      <div className={clsx('h-2.5 rounded-full transition-all', barColor(result.score))}
                        style={{ width: `${result.score}%` }} />
                    </div>
                    <p className="text-sm font-semibold text-stone-700 mt-2">{result.verdict}</p>
                  </div>

                  {/* Params table */}
                  {result.params && (
                    <div className="px-5 py-4 border-t border-stone-100 space-y-2.5">
                      <p className="text-[10px] text-stone-400 uppercase tracking-widest font-semibold">Measured parameters</p>
                      {[
                        {
                          label: 'Decay time',
                          value: `${result.params.decay_time_ms.toFixed(0)} ms`,
                          ref:   mode === 'drop' ? 'Longer = more gold-like (low damping)' : 'Secondary in tap mode',
                          highlight: mode === 'drop',
                        },
                        {
                          label: 'Decay quality R²',
                          value: result.params.exp_decay_r2.toFixed(2),
                          ref:   '>0.85 = single pure material',
                          highlight: mode === 'drop',
                        },
                        {
                          label: 'Spectral centroid',
                          value: `${result.params.spectral_centroid_hz.toFixed(0)} Hz`,
                          ref:   'Warmer = more gold-like',
                          highlight: mode === 'tap',
                        },
                        {
                          label: 'Gold-band energy',
                          value: `${(result.params.gold_band_ratio * 100).toFixed(0)}%`,
                          ref:   'Higher = clearer dense-metal signature',
                          highlight: false,
                        },
                        {
                          label: 'High-freq ratio',
                          value: `${(result.params.hf_ratio * 100).toFixed(0)}%`,
                          ref:   '<15% = not tinny (plated indicator)',
                          highlight: false,
                        },
                        {
                          label: 'Recording SNR',
                          value: `${result.params.snr_db.toFixed(0)} dB`,
                          ref:   '>15 dB = usable',
                          highlight: false,
                        },
                        {
                          label: mode === 'drop' ? 'Drop impacts' : 'Tap events',
                          value: `${result.params.tap_events}`,
                          ref:   mode === 'drop' ? '1–2 drops recommended' : '2–3 = reliable result',
                          highlight: false,
                        },
                      ].map(({ label, value, ref, highlight }) => (
                        <div key={label} className={clsx('flex items-center justify-between text-xs rounded-lg px-2 py-1', highlight && 'bg-blue-50')}>
                          <span className={clsx('font-medium', highlight ? 'text-blue-700' : 'text-stone-500')}>
                            {highlight && '★ '}{label}
                          </span>
                          <div className="text-right">
                            <span className={clsx('font-bold', highlight ? 'text-blue-800' : 'text-stone-800')}>{value}</span>
                            <span className="text-stone-400 ml-1.5 text-[10px]">({ref})</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* AI explanation */}
                  {result.explanation && (
                    <div className="px-5 pb-4 border-t border-stone-100 pt-3">
                      <p className="text-[10px] text-stone-400 uppercase tracking-widest font-semibold mb-1.5">Analysis</p>
                      <p className="text-xs text-stone-600 leading-relaxed">{result.explanation}</p>
                    </div>
                  )}
                </div>

                {/* Disclaimer */}
                <div className="px-4 py-2.5 bg-stone-50 border border-stone-200 rounded-2xl">
                  <p className="text-[10px] text-stone-400 leading-relaxed">
                    ⚠ {result.disclaimer || 'Acoustic screening only — not a guarantee of authenticity. Confirm with a jeweller before any purchase decision.'}
                  </p>
                </div>

                {/* Low confidence suggestion */}
                {(result.low_confidence_flag || result.confidence === 'low') && (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      Signal is ambiguous. For a clearer result, {mode === 'tap' ? 'try a drop test — drop from ~20 cm on glass, wait for ring to stop, then drop once more' : 'drop from ~20 cm on a flat glass surface, wait until ring fully stops'}.
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2.5">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <p className="text-xs font-semibold text-emerald-700">Acoustic test complete — next: Bill scan</p>
                </div>
                <button onClick={() => navigate('/certificate-scan')} className="w-full btn-primary">
                  Continue to Weight Entry <ChevronRight className="w-5 h-5" />
                </button>
              </div>

            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-700">{error || 'Analysis failed. Please try again.'}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
