/**
 * VideoEval — 15-second gold video captured on device, frames sent to
 * POST /api/video-eval (Vertex AI gemini-3.5-flash auth-check).
 * Navigates to /audio-eval on completion or skip.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { ChevronRight, Video, AlertCircle, SkipForward, CheckCircle } from 'lucide-react'
import { clsx } from 'clsx'
import { apiBase } from '../lib/api'
import { preferredCameraDeviceId } from '../lib/cameraQuality'
import { speak } from '../lib/tts'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTranslation } from 'react-i18next'

const VIDEO_DURATION_MS = 15_000
const FRAME_INTERVAL_MS = 1_500   // ≈10 frames plus final frame
const MAX_VIDEO_FRAMES = 11

function grabFrame(video: HTMLVideoElement): string {
  if (video.readyState < 2) return ''
  const W = 480, H = Math.round(video.videoHeight * W / video.videoWidth) || 360
  const c = document.createElement('canvas'); c.width = W; c.height = H
  c.getContext('2d')!.drawImage(video, 0, 0, W, H)
  return c.toDataURL('image/jpeg', 0.80).split(',')[1]
}

function frameDataUrl(b64: string): string {
  return `data:image/jpeg;base64,${b64}`
}

function frameBlob(b64: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

type Phase = 'intro' | 'recording' | 'analyzing' | 'result'

interface VideoResult {
  video_score: number
  verdict: string
  wear_score: number
  edge_substrate_score: number
  luster_score: number
  surface_originality_score: number
  hue_score: number
  video_signals: string[]
  purity_estimate: string | null
  guidance: string
  same_item?: {
    verdict: 'same' | 'different' | 'inconclusive'
    confidence: number
    same_item_score: number
    mismatch_reasons: string[]
  } | null
}

export function VideoEval() {
  const navigate = useNavigate()
  const { setLiveAuthResult, addCapture, state } = useSessionStore()
  const { t } = useTranslation()
  const lang = (localStorage.getItem('goldeye_lang') ?? 'en') as 'en' | 'hi'

  const videoRef  = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const framesRef = useRef<string[]>([])

  const [phase, setPhase]             = useState<Phase>('intro')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [result, setResult]           = useState<VideoResult | null>(null)
  const [error, setError]             = useState('')
  const [showTutorial, setShowTutorial] = useState(true)

  // Speak voice guide on intro
  useEffect(() => {
    const timer = setTimeout(() => speak(t('voice_video')), 500)
    return () => clearTimeout(timer)
  }, [t])

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()) }, [])

  async function startRecording() {
    setError('')
    framesRef.current = []
    setPhase('recording')
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
      const tickIv  = setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((VIDEO_DURATION_MS - (Date.now() - startedAt)) / 1000))), 300)
      const frameIv = setInterval(() => {
        if (videoRef.current) { const b64 = grabFrame(videoRef.current); if (b64) framesRef.current.push(b64) }
      }, FRAME_INTERVAL_MS)

      await new Promise(r => setTimeout(r, VIDEO_DURATION_MS))
      clearInterval(tickIv); clearInterval(frameIv)

      // Last frame
      if (videoRef.current) { const b64 = grabFrame(videoRef.current); if (b64) framesRef.current.push(b64) }
      stream.getTracks().forEach(t => t.stop()); streamRef.current = null

      framesRef.current = framesRef.current.filter(Boolean).slice(0, MAX_VIDEO_FRAMES)
      const usableFrames = framesRef.current
      if (usableFrames.length) {
        const dataUrls = usableFrames.map(frameDataUrl)
        addCapture({
          type: 'video',
          dataUrl: dataUrls[0],
          blob: frameBlob(usableFrames[0]),
          timestamp: Date.now(),
          exif: {
            videoFramesDataUrl: dataUrls,
            videoFrameCount: dataUrls.length,
            source: 'video-eval',
          },
        })
      }

      setPhase('analyzing')
      await runAnalysis()
    } catch (e: any) {
      setError(e?.message ?? 'Camera access denied — grant permission and try again.')
      setPhase('intro')
    }
  }

  async function runAnalysis() {
    try {
      const referenceCapture = state.captures['45deg'] ?? state.captures.top
      const referenceFrameType = state.captures['45deg'] ? '45deg' : 'top'
      const res = await fetch(`${apiBase}/api/video-eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frames_b64: framesRef.current,
          language: lang,
          session_id: state.sessionId ?? undefined,
          reference_image_data_url: referenceCapture?.dataUrl ?? null,
          reference_frame_type: referenceFrameType,
        }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setResult(data)
      if (data.verdict) speak(data.verdict)
      // Store full result (video_score + placeholder audio fields) in session
      setLiveAuthResult({
        video_score:    data.video_score,
        audio_score:    0,
        combined_score: data.video_score,
        verdict:        data.verdict,
        video_signals:  data.video_signals,
        audio_signals:  [],
        purity_estimate: data.purity_estimate ?? null,
      })
    } catch (e: any) {
      setError(e?.message ?? 'Video analysis failed. Please try again.')
    }
    setPhase('result')
  }

  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div className="page bg-gradient-to-b from-stone-50 to-white overflow-y-auto">

      {/* Tutorial overlay */}
      {showTutorial && phase === 'intro' && (
        <TutorialOverlay stepType="video" onDismiss={() => setShowTutorial(false)} />
      )}

      {/* Header */}
      <div className="page-header">
        <button
          onClick={() => phase !== 'recording' && navigate('/capture')}
          className={clsx('btn-icon', phase === 'recording' && 'opacity-30 cursor-not-allowed')}
          disabled={phase === 'recording'}
        >
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-xs text-stone-400 uppercase tracking-widest font-medium">Video Scan</span>
          <span className="text-sm font-semibold text-stone-900 mt-0.5">Video Analysis</span>
        </div>
        <button
          onClick={() => speak(t('voice_video'))}
          className="btn-icon"
          title="Replay instructions"
          disabled={phase === 'recording'}
        >
          <Video className="w-4 h-4 text-stone-500" />
        </button>
      </div>

      <div className="px-5 py-4 space-y-5">

        {/* INTRO */}
        {phase === 'intro' && (
          <div className="space-y-5 animate-fade-in">
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-3xl p-6 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-amber-500 flex items-center justify-center shadow-lg shadow-amber-500/30">
                <Video className="w-8 h-8 text-white" />
              </div>
              <div className="text-center">
                <p className="font-bold text-stone-900 text-lg">15-Second Video Scan</p>
                <p className="text-stone-600 text-sm mt-1 leading-relaxed">
                  Slowly rotate the gold piece. We analyse wear at contact points, edge colour consistency, luster, and surface originality.
                </p>
              </div>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-4 space-y-2.5">
              {[
                'Place gold on a clean white surface',
                'Good lighting — near a window works best',
                'Slowly rotate the piece during the 15 seconds',
                'Show all sides — edges, clasps, and hallmark area',
              ].map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{i + 1}</div>
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
              <Video className="w-5 h-5" /> Start 15-Second Video
            </button>
            <button
              onClick={() => navigate('/audio-eval')}
              className="w-full btn-secondary text-sm flex items-center justify-center gap-2"
            >
              <SkipForward className="w-4 h-4" /> Skip Video — Go to Tap Test
            </button>
          </div>
        )}

        {/* RECORDING */}
        {phase === 'recording' && (
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

        {/* ANALYZING */}
        {phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center gap-5 py-20">
            <div className="w-16 h-16 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-center">
              <p className="font-bold text-stone-900 text-base">Analysing {framesRef.current.length} frames…</p>
              <p className="text-stone-500 text-sm mt-1">Analysing wear, surface originality, and edge consistency…</p>
            </div>
          </div>
        )}

        {/* RESULT */}
        {phase === 'result' && (
          <div className="space-y-4 animate-fade-in">
            {result ? (
              <div className="bg-white border border-stone-200 rounded-3xl p-5 space-y-4">
                <p className="text-xs text-stone-400 uppercase tracking-widest font-semibold">Video Analysis Result</p>
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className={clsx('text-4xl font-black', scoreColor(result.video_score))}>{result.video_score}</p>
                    <p className="text-xs text-stone-400 mt-0.5">/ 100</p>
                  </div>
                  <div className="flex-1">
                    <div className="w-full bg-stone-100 rounded-full h-2.5">
                      <div className={clsx('h-2.5 rounded-full transition-all', barColor(result.video_score))} style={{ width: `${result.video_score}%` }} />
                    </div>
                    <p className="text-sm font-semibold text-stone-700 mt-2">{result.verdict}</p>
                  </div>
                </div>
                {/* Per-signal breakdown */}
                <div className="border-t border-stone-100 pt-3 space-y-2">
                  {[
                    { label: 'Wear at contact points', score: result.wear_score,               weight: '35%' },
                    { label: 'Edge substrate',          score: result.edge_substrate_score,     weight: '30%' },
                    { label: 'Luster / reflection',     score: result.luster_score,             weight: '20%' },
                    { label: 'Surface originality',     score: result.surface_originality_score, weight: '10%' },
                    { label: 'Colour hue',              score: result.hue_score,                weight: '5%' },
                  ].map(({ label, score, weight }) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="text-xs text-stone-500 w-32 flex-shrink-0">{label} <span className="text-stone-400">({weight})</span></span>
                      <div className="flex-1 bg-stone-100 rounded-full h-1.5">
                        <div className={clsx('h-1.5 rounded-full', barColor(score))} style={{ width: `${score}%` }} />
                      </div>
                      <span className={clsx('text-xs font-bold w-8 text-right', scoreColor(score))}>{score}</span>
                    </div>
                  ))}
                </div>

                {result.video_signals.slice(0, 3).map((sig, i) => (
                  <div key={i} className="flex items-start gap-2 border-t border-stone-100 pt-1.5">
                    <span className="text-amber-500 text-xs mt-0.5 flex-shrink-0">•</span>
                    <p className="text-xs text-stone-600 leading-snug">{sig}</p>
                  </div>
                ))}
                {result.purity_estimate && (
                  <div className="flex items-center justify-between border-t border-stone-100 pt-3">
                    <span className="text-sm text-stone-500">Purity estimate</span>
                    <span className="text-sm font-bold text-amber-600">{result.purity_estimate}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Video analysis unavailable</p>
                  <p className="text-xs text-amber-700 mt-0.5">{error || 'Video analysis did not return a result. Continuing with drop test.'}</p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2.5">
              <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <p className="text-xs font-semibold text-emerald-700">Video step complete — next: Tap Test</p>
            </div>

            <button onClick={() => navigate('/audio-eval')} className="w-full btn-primary">
              Continue to Tap Test <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
