/**
 * AudioEval — 10-second tap test audio recorded on device, raw PCM sent to
 * POST /api/audio-eval (Vertex AI gemini-3.5-flash + algorithmic blend).
 * Navigates to /weight on completion or skip.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { ChevronRight, Mic, AlertCircle, SkipForward, CheckCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { apiBase } from '../lib/api'

const AUDIO_DURATION_MS = 10_000

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

type Phase = 'intro' | 'recording' | 'analyzing' | 'result'

interface TapResult {
  score: number
  label: string
  decay_ms: number
  dominant_freq_hz: number
  spectral_centroid_hz: number
  q_factor: number
  gold_band_ratio: number
  reasoning: string
}

export function AudioEval() {
  const navigate = useNavigate()
  const { setTapTestResult } = useSessionStore()
  const lang = (localStorage.getItem('goldeye_lang') ?? 'en') as 'en' | 'hi'

  const streamRef      = useRef<MediaStream | null>(null)
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const audioChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef  = useRef(44100)

  const [phase, setPhase]             = useState<Phase>('intro')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [result, setResult]           = useState<TapResult | null>(null)
  const [error, setError]             = useState('')

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close().catch(() => {})
  }, [])

  async function startRecording() {
    setError('')
    audioChunksRef.current = []
    setPhase('recording')
    setSecondsLeft(Math.ceil(AUDIO_DURATION_MS / 1000))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
      streamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current  = ctx
      sampleRateRef.current = ctx.sampleRate

      const source    = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      const gain      = ctx.createGain(); gain.gain.value = 0
      source.connect(processor); processor.connect(gain); gain.connect(ctx.destination)
      ctx.resume().catch(() => {})

      processor.onaudioprocess = e =>
        audioChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))

      const startedAt = Date.now()
      const tickIv = setInterval(() =>
        setSecondsLeft(Math.max(0, Math.ceil((AUDIO_DURATION_MS - (Date.now() - startedAt)) / 1000))), 300)

      await new Promise(r => setTimeout(r, AUDIO_DURATION_MS))
      clearInterval(tickIv)

      processor.disconnect(); source.disconnect(); gain.disconnect()
      await ctx.close().catch(() => {})
      stream.getTracks().forEach(t => t.stop()); streamRef.current = null

      setPhase('analyzing')
      await runAnalysis()
    } catch (e: any) {
      setError(e?.message ?? 'Microphone access denied — grant permission and try again.')
      setPhase('intro')
    }
  }

  async function runAnalysis() {
    try {
      const chunks = audioChunksRef.current
      const total  = chunks.reduce((n, c) => n + c.length, 0)
      const flat   = new Float32Array(total)
      let off = 0; for (const c of chunks) { flat.set(c, off); off += c.length }
      const samplesB64 = bytesToBase64(new Uint8Array(flat.buffer))

      const res = await fetch(`${apiBase}/api/audio-eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples_b64: samplesB64, sample_rate: sampleRateRef.current, language: lang }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data: TapResult = await res.json()
      setResult(data)
      setTapTestResult(data)
    } catch (e: any) {
      setError(e?.message ?? 'Tap test analysis failed.')
    }
    setPhase('result')
  }

  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div className="page bg-gradient-to-b from-stone-50 to-white overflow-y-auto">

      {/* Header */}
      <div className="page-header">
        <button
          onClick={() => phase !== 'recording' && navigate('/video-eval')}
          className={clsx('btn-icon', phase === 'recording' && 'opacity-30 cursor-not-allowed')}
          disabled={phase === 'recording'}
        >
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">Step 2 of 2</span>
          <span className="text-sm font-semibold text-stone-900 mt-0.5">Tap Test</span>
        </div>
        <div className="w-9" />
      </div>

      <div className="px-5 py-4 space-y-5">

        {/* INTRO */}
        {phase === 'intro' && (
          <div className="space-y-5 animate-fade-in">
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-3xl p-6 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
                <Mic className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-bold text-stone-900 text-lg">10-Second Tap Test</p>
                <p className="text-stone-600 text-sm mt-1 leading-relaxed">
                  Gently tap the gold piece on a hard surface. Solid gold produces a warm damped ring distinct from plated metal.
                </p>
              </div>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-4 space-y-2.5">
              {[
                'Place gold on a firm surface — table or marble',
                'Use a coin or knuckle to tap the piece',
                'Tap 3–5 times evenly during the 10 seconds',
                'Hold phone microphone within 15–20 cm',
              ].map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
                  <p className="text-sm text-stone-700">{tip}</p>
                </div>
              ))}
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button onClick={startRecording} className="w-full btn-primary">
              <Mic className="w-5 h-5" /> Start 10-Second Tap Test
            </button>
            <button
              onClick={() => navigate('/weight')}
              className="w-full btn-secondary text-sm flex items-center justify-center gap-2"
            >
              <SkipForward className="w-4 h-4" /> Skip Tap Test — Continue
            </button>
          </div>
        )}

        {/* RECORDING */}
        {phase === 'recording' && (
          <div className="flex flex-col items-center gap-6 py-8 animate-fade-in">
            <div className="relative flex items-center justify-center w-44 h-44">
              <div className="absolute inset-0 rounded-full bg-blue-400/20 animate-ping" />
              <div className="absolute inset-4 rounded-full bg-blue-400/15 animate-ping" style={{ animationDelay: '0.4s' }} />
              <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-2xl shadow-blue-500/30">
                <Mic className="w-14 h-14 text-white" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-stone-900 font-black text-4xl tabular-nums">{secondsLeft}s</p>
              <p className="text-stone-500 text-sm mt-1.5">Tap the gold piece now…</p>
            </div>
            <div className="w-56 bg-stone-100 rounded-full h-2.5">
              <div
                className="h-2.5 rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${100 - (secondsLeft / (AUDIO_DURATION_MS / 1000)) * 100}%` }}
              />
            </div>
            <p className="text-xs text-stone-400 text-center px-8">Keep the environment quiet for best results</p>
          </div>
        )}

        {/* ANALYZING */}
        {phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center gap-5 py-20">
            <div className="w-16 h-16 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="font-bold text-stone-900 text-base">Analysing tap recording…</p>
              <p className="text-stone-500 text-sm mt-1">Checking acoustic signature against solid gold profile</p>
            </div>
          </div>
        )}

        {/* RESULT */}
        {phase === 'result' && (
          <div className="space-y-4 animate-fade-in">
            {result ? (
              <div className="bg-white border border-stone-200 rounded-3xl p-5 space-y-4">
                <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold">Tap Test Result</p>

                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className={clsx('text-4xl font-black', scoreColor(result.score))}>{result.score}</p>
                    <p className="text-xs text-stone-400 mt-0.5">/ 100</p>
                  </div>
                  <div className="flex-1">
                    <div className="w-full bg-stone-100 rounded-full h-2.5">
                      <div className={clsx('h-2.5 rounded-full transition-all', barColor(result.score))} style={{ width: `${result.score}%` }} />
                    </div>
                    <p className="text-sm font-semibold text-stone-700 mt-2">{result.label}</p>
                  </div>
                </div>

                <div className="border-t border-stone-100 pt-3 space-y-2">
                  {[
                    { label: 'Decay time', value: `${result.decay_ms.toFixed(0)} ms`, ref: '60–350 ms = gold' },
                    { label: 'Dominant frequency', value: `${result.dominant_freq_hz.toFixed(0)} Hz`, ref: '200–1200 Hz' },
                    { label: 'Spectral centroid', value: `${result.spectral_centroid_hz?.toFixed(0) ?? '—'} Hz`, ref: '150–700 Hz = gold' },
                    { label: 'Q-factor', value: result.q_factor?.toFixed(1) ?? '—', ref: '5–30 = damped ring' },
                    { label: 'Gold-band energy', value: result.gold_band_ratio != null ? `${(result.gold_band_ratio * 100).toFixed(0)}%` : '—', ref: '>45% = solid gold' },
                  ].map(({ label, value, ref }) => (
                    <div key={label} className="flex items-center justify-between text-xs">
                      <span className="text-stone-500">{label}</span>
                      <div className="text-right">
                        <span className="font-semibold text-stone-800">{value}</span>
                        <span className="text-stone-400 ml-1.5">({ref})</span>
                      </div>
                    </div>
                  ))}
                </div>

                <p className="text-xs text-stone-500 leading-relaxed border-t border-stone-100 pt-3">{result.reasoning}</p>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Tap test unavailable</p>
                  <p className="text-xs text-amber-700 mt-0.5">{error || 'Analysis did not return a result. Continuing to weight entry.'}</p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2.5">
              <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <p className="text-xs font-semibold text-emerald-700">Tap test complete — next: Weight entry</p>
            </div>

            <button onClick={() => navigate('/weight')} className="w-full btn-primary">
              Continue to Weight Entry <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
