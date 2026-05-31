/**
 * VideoAudioEval — Vertex AI-powered gold authenticity check.
 * Phase 1: 15-second video (colour, luster, edge-wear analysis via auth-check)
 * Phase 2: 10-second audio tap test (solid vs plated acoustic signature)
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { authCheck, sendTapTest, type AuthCheckResult, type TapTestResult } from '../lib/liveSession'
import { preferredCameraDeviceId } from '../lib/cameraQuality'
import { ChevronRight, Video, Mic, CheckCircle, AlertCircle, SkipForward } from 'lucide-react'
import { clsx } from 'clsx'

type Phase =
  | 'intro-video'
  | 'recording-video'
  | 'analyzing-video'
  | 'video-result'
  | 'intro-audio'
  | 'recording-audio'
  | 'analyzing-audio'
  | 'done'

const VIDEO_DURATION_MS  = 15_000
const AUDIO_DURATION_MS  = 10_000
const FRAME_INTERVAL_MS  = 1_500   // ~10 frames over 15 s

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function grabFrame(video: HTMLVideoElement): string {
  if (video.readyState < 2) return ''
  const W = 480, H = Math.round(video.videoHeight * W / video.videoWidth) || 360
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  c.getContext('2d')!.drawImage(video, 0, 0, W, H)
  return c.toDataURL('image/jpeg', 0.80).split(',')[1]
}

export function VideoAudioEval() {
  const navigate = useNavigate()
  const { setLiveAuthResult, setTapTestResult } = useSessionStore()
  const lang = (localStorage.getItem('goldeye_lang') ?? 'en') as 'en' | 'hi'

  const videoRef       = useRef<HTMLVideoElement>(null)
  const streamRef      = useRef<MediaStream | null>(null)
  const framesRef      = useRef<string[]>([])
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const audioChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef  = useRef<number>(44100)

  const [phase, setPhase]           = useState<Phase>('intro-video')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [authResult, setAuthResult] = useState<AuthCheckResult | null>(null)
  const [tapResult, setTapResult]   = useState<TapTestResult | null>(null)
  const [videoOk, setVideoOk]       = useState(false)   // video phase completed (even if API failed)
  const [audioOk, setAudioOk]       = useState(false)   // audio phase completed
  const [error, setError]           = useState('')

  const isRecording = phase === 'recording-video' || phase === 'recording-audio'

  // ── cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close().catch(() => {})
  }, [])

  // ── VIDEO PHASE ───────────────────────────────────────────────────────────────
  async function startVideoRecording() {
    setError('')
    framesRef.current = []
    setPhase('recording-video')
    setSecondsLeft(Math.ceil(VIDEO_DURATION_MS / 1000))

    try {
      const deviceId = await preferredCameraDeviceId({ ideal: 'environment' })
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      streamRef.current = stream
      const vid = videoRef.current
      if (vid) { vid.srcObject = stream; vid.play().catch(() => {}) }

      const startedAt = Date.now()
      const tickIv  = setInterval(() => {
        setSecondsLeft(Math.max(0, Math.ceil((VIDEO_DURATION_MS - (Date.now() - startedAt)) / 1000)))
      }, 300)
      const frameIv = setInterval(() => {
        if (videoRef.current) {
          const b64 = grabFrame(videoRef.current)
          if (b64) framesRef.current.push(b64)
        }
      }, FRAME_INTERVAL_MS)

      await new Promise(r => setTimeout(r, VIDEO_DURATION_MS))
      clearInterval(tickIv); clearInterval(frameIv)

      // Final frame
      if (videoRef.current) {
        const b64 = grabFrame(videoRef.current)
        if (b64) framesRef.current.push(b64)
      }
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null

      setPhase('analyzing-video')
      try {
        const result = await authCheck(framesRef.current, lang)
        setAuthResult(result)
        setLiveAuthResult(result)
      } catch (e: any) {
        setError(e?.message ?? 'Video analysis failed — Vertex AI may be unavailable.')
      }
      setVideoOk(true)
      setPhase('video-result')
    } catch (e: any) {
      setError(e?.message ?? 'Camera access denied. Grant permission and try again.')
      setPhase('intro-video')
    }
  }

  // ── AUDIO PHASE ───────────────────────────────────────────────────────────────
  async function startAudioRecording() {
    setError('')
    audioChunksRef.current = []
    setPhase('recording-audio')
    setSecondsLeft(Math.ceil(AUDIO_DURATION_MS / 1000))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
      streamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      sampleRateRef.current = ctx.sampleRate
      const source    = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      const gain      = ctx.createGain(); gain.gain.value = 0

      source.connect(processor); processor.connect(gain); gain.connect(ctx.destination)
      ctx.resume().catch(() => {})
      processor.onaudioprocess = e =>
        audioChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))

      const startedAt = Date.now()
      const tickIv = setInterval(() => {
        setSecondsLeft(Math.max(0, Math.ceil((AUDIO_DURATION_MS - (Date.now() - startedAt)) / 1000)))
      }, 300)

      await new Promise(r => setTimeout(r, AUDIO_DURATION_MS))
      clearInterval(tickIv)

      processor.disconnect(); source.disconnect(); gain.disconnect()
      await ctx.close().catch(() => {})
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null

      setPhase('analyzing-audio')
      try {
        const chunks = audioChunksRef.current
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const flat  = new Float32Array(total)
        let off = 0; for (const c of chunks) { flat.set(c, off); off += c.length }
        const samplesB64 = bytesToBase64(new Uint8Array(flat.buffer))
        const result = await sendTapTest(samplesB64, sampleRateRef.current, lang)
        setTapResult(result)
        setTapTestResult(result)
      } catch (e: any) {
        setError(e?.message ?? 'Tap test analysis failed.')
      }
      setAudioOk(true)
      setPhase('done')
    } catch (e: any) {
      setError(e?.message ?? 'Microphone access denied. Grant permission and try again.')
      setPhase('intro-audio')
    }
  }

  // ── score helpers ─────────────────────────────────────────────────────────────
  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400'    : 'bg-red-400'

  const completionMsg = videoOk && audioOk
    ? 'Both evaluations complete'
    : videoOk
    ? 'Video analysis complete'
    : audioOk
    ? 'Tap test complete'
    : 'Evaluation complete'

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="page app-page-bg overflow-y-auto">

      {/* Header */}
      <div className="page-header">
        <button
          onClick={() => !isRecording && navigate('/certificate-scan')}
          className={clsx('btn-icon', isRecording && 'opacity-30 cursor-not-allowed')}
          disabled={isRecording}
        >
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">Gold Evaluation</span>
          <span className="text-sm font-semibold text-stone-900 mt-0.5">
            {phase.includes('video') ? 'Video Analysis'
              : phase.includes('audio') || phase === 'done' ? 'Tap Test'
              : 'Authenticity Check'}
          </span>
        </div>
        <div className="w-9" />
      </div>

      <div className="px-5 py-4 space-y-5">

        {/* ── INTRO VIDEO ── */}
        {phase === 'intro-video' && (
          <div className="space-y-5 animate-fade-in">
            <div className="surface-panel rounded-3xl p-6 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 flex items-center justify-center shadow-lg">
                <Video className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-bold text-stone-900 text-lg">15-Second Video Scan</p>
                <p className="text-stone-600 text-sm mt-1 leading-relaxed">
                  Slowly rotate the gold piece. AI analyses colour, luster, edge wear, and surface texture.
                </p>
              </div>
            </div>

            <div className="surface-panel rounded-2xl p-4 space-y-2.5">
              {[
                'Place gold on a clean white surface',
                'Good lighting — near a window works best',
                'Slowly rotate the piece during the 15 seconds',
                'Show all sides including edges and clasps',
              ].map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
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

            <button onClick={startVideoRecording} className="w-full btn-primary">
              <Video className="w-5 h-5" /> Start 15-Second Video
            </button>
            <button onClick={() => { setVideoOk(true); setPhase('intro-audio') }} className="w-full btn-secondary text-sm flex items-center justify-center gap-2">
              <SkipForward className="w-4 h-4" /> Skip Video — Go to Tap Test
            </button>
          </div>
        )}

        {/* ── RECORDING VIDEO ── */}
        {phase === 'recording-video' && (
          <div className="space-y-4 animate-fade-in">
            <div className="relative rounded-3xl overflow-hidden bg-stone-900 aspect-[3/4]">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
              <div className="absolute inset-0 flex flex-col items-center justify-end pb-8 pointer-events-none">
                <div className="bg-black/70 backdrop-blur-sm rounded-2xl px-6 py-3 text-center">
                  <p className="text-white/60 text-xs uppercase tracking-widest">Recording</p>
                  <p className="text-white font-black text-4xl tabular-nums leading-none mt-1">{secondsLeft}</p>
                  <p className="text-white/50 text-xs mt-0.5">seconds left</p>
                </div>
                <div className="mt-3 w-48 bg-white/20 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-amber-400 transition-all duration-300"
                    style={{ width: `${100 - (secondsLeft / (VIDEO_DURATION_MS / 1000)) * 100}%` }}
                  />
                </div>
              </div>
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-red-600 rounded-full px-3 py-1.5">
                <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span className="text-white text-xs font-semibold">REC</span>
              </div>
            </div>
            <p className="text-center text-sm text-stone-500">Slowly rotate — show all edges and surfaces</p>
          </div>
        )}

        {/* ── ANALYZING VIDEO ── */}
        {phase === 'analyzing-video' && (
          <div className="flex flex-col items-center justify-center gap-5 py-20">
            <div className="w-16 h-16 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="font-bold text-stone-900 text-base">Analysing {framesRef.current.length} frames…</p>
              <p className="text-stone-500 text-sm mt-1">Gemini AI is checking colour, luster, and edge wear</p>
            </div>
          </div>
        )}

        {/* ── VIDEO RESULT ── */}
        {phase === 'video-result' && (
          <div className="space-y-4 animate-fade-in">
            <div className="surface-panel rounded-3xl p-5">
              <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold mb-3">Video Analysis</p>
              {authResult ? (
                <>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="text-center">
                      <p className={clsx('text-4xl font-black', scoreColor(authResult.video_score))}>{authResult.video_score}</p>
                      <p className="text-xs text-stone-400 mt-0.5">/ 100</p>
                    </div>
                    <div className="flex-1">
                      <div className="w-full bg-stone-100 rounded-full h-2.5">
                        <div className={clsx('h-2.5 rounded-full transition-all', barColor(authResult.video_score))} style={{ width: `${authResult.video_score}%` }} />
                      </div>
                      <p className="text-sm font-semibold text-stone-700 mt-2">{authResult.verdict}</p>
                    </div>
                  </div>
                  {authResult.video_signals.slice(0, 4).map((sig, i) => (
                    <div key={i} className="flex items-start gap-2 py-1.5 border-t border-stone-100">
                      <span className="text-amber-500 text-xs mt-0.5 flex-shrink-0">•</span>
                      <p className="text-xs text-stone-600 leading-snug">{sig}</p>
                    </div>
                  ))}
                </>
              ) : (
                <div className="flex items-start gap-3 py-2">
                  <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-stone-600">{error || 'Video analysis unavailable — continuing with tap test.'}</p>
                </div>
              )}
            </div>
            <button onClick={() => { setError(''); setPhase('intro-audio') }} className="w-full btn-primary">
              <Mic className="w-5 h-5" /> Continue to Tap Test
            </button>
          </div>
        )}

        {/* ── INTRO AUDIO ── */}
        {phase === 'intro-audio' && (
          <div className="space-y-5 animate-fade-in">
            <div className="surface-panel rounded-3xl p-6 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 flex items-center justify-center shadow-lg">
                <Mic className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-bold text-stone-900 text-lg">10-Second Tap Test</p>
                <p className="text-stone-600 text-sm mt-1 leading-relaxed">
                  Gently tap the gold piece on a hard surface. Solid gold produces a distinct warm ring tone different from plated metal.
                </p>
              </div>
            </div>

            <div className="surface-panel rounded-2xl p-4 space-y-2.5">
              {[
                'Place the gold on a firm surface (table or marble)',
                'Use a coin or knuckle to tap the piece',
                'Tap 3–5 times during the 10 seconds',
                'Keep phone microphone close (15–20 cm away)',
              ].map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
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

            <button onClick={startAudioRecording} className="w-full btn-primary">
              <Mic className="w-5 h-5" /> Start 10-Second Tap Test
            </button>
            <button onClick={() => { setAudioOk(true); setPhase('done') }} className="w-full btn-secondary text-sm flex items-center justify-center gap-2">
              <SkipForward className="w-4 h-4" /> Skip Tap Test — Continue
            </button>
          </div>
        )}

        {/* ── RECORDING AUDIO ── */}
        {phase === 'recording-audio' && (
          <div className="flex flex-col items-center gap-6 py-8 animate-fade-in">
            <div className="relative flex items-center justify-center w-40 h-40">
              <div className="absolute inset-0 rounded-full bg-blue-400/20 animate-ping" />
              <div className="absolute inset-3 rounded-full bg-blue-400/15 animate-ping" style={{ animationDelay: '0.4s' }} />
              <div className="w-28 h-28 rounded-full bg-gradient-to-br from-brand-500 to-brand-800 flex items-center justify-center shadow-2xl shadow-blue-500/30">
                <Mic className="w-12 h-12 text-white" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-stone-900 font-black text-3xl tabular-nums">{secondsLeft}s</p>
              <p className="text-stone-500 text-sm mt-1">Tap the gold piece now…</p>
            </div>
            <div className="w-56 bg-stone-100 rounded-full h-2">
              <div
                className="h-2 rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: `${100 - (secondsLeft / (AUDIO_DURATION_MS / 1000)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* ── ANALYZING AUDIO ── */}
        {phase === 'analyzing-audio' && (
          <div className="flex flex-col items-center justify-center gap-5 py-20">
            <div className="w-16 h-16 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="font-bold text-stone-900 text-base">Analysing tap recording…</p>
              <p className="text-stone-500 text-sm mt-1">Checking acoustic signature for solid gold</p>
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {phase === 'done' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
              <p className="text-sm font-semibold text-emerald-700">{completionMsg}</p>
            </div>

            {(authResult || tapResult) && (
              <div className="surface-panel rounded-3xl p-5 space-y-3">
                <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold">Summary</p>

                {authResult ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4 text-stone-400" />
                      <span className="text-sm text-stone-600">Video score</span>
                    </div>
                    <span className={clsx('text-sm font-bold', scoreColor(authResult.video_score))}>{authResult.video_score}/100</span>
                  </div>
                ) : videoOk ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4 text-stone-400" />
                      <span className="text-sm text-stone-500">Video</span>
                    </div>
                    <span className="text-sm text-stone-400 italic">Skipped / unavailable</span>
                  </div>
                ) : null}

                {tapResult ? (
                  <>
                    <div className="flex items-center justify-between border-t border-stone-100 pt-3">
                      <div className="flex items-center gap-2">
                        <Mic className="w-4 h-4 text-stone-400" />
                        <span className="text-sm text-stone-600">Tap test</span>
                      </div>
                      <span className={clsx('text-sm font-bold', scoreColor(tapResult.score))}>{tapResult.score}%</span>
                    </div>
                    <p className="text-xs text-stone-500 leading-relaxed border-t border-stone-100 pt-2">{tapResult.reasoning}</p>
                  </>
                ) : (
                  <div className="flex items-center justify-between border-t border-stone-100 pt-3">
                    <div className="flex items-center gap-2">
                      <Mic className="w-4 h-4 text-stone-400" />
                      <span className="text-sm text-stone-500">Tap test</span>
                    </div>
                    <span className="text-sm text-stone-400 italic">Skipped / unavailable</span>
                  </div>
                )}

                {authResult?.purity_estimate && (
                  <div className="flex items-center justify-between border-t border-stone-100 pt-3">
                    <span className="text-sm text-stone-600">Purity estimate</span>
                    <span className="text-sm font-bold text-amber-600">{authResult.purity_estimate}</span>
                  </div>
                )}
              </div>
            )}

            <button onClick={() => navigate('/weight')} className="w-full btn-primary">
              Continue to Weight Entry <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
