/**
 * VideoEval — 15-second gold video captured on device, frames sent to
 * POST /api/video-eval (Vertex AI gemini-3.5-flash auth-check).
 * Navigates to /audio-eval on completion or skip.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { ChevronRight, Video, AlertCircle, User, Zap, ZapOff } from 'lucide-react'
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

type Phase = 'intro' | 'preview' | 'recording' | 'analyzing' | 'result'

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
}

export function VideoEval() {
  const navigate = useNavigate()
  const { setLiveAuthResult, addCapture, skipCapture, setPageEvidence, state } = useSessionStore()
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
  const [recBtnActive, setRecBtnActive] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [zoomMin, setZoomMin] = useState(1)
  const [zoomMax, setZoomMax] = useState(4)
  const stopEarlyRef = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => speak(t('voice_video')), 500)
    return () => clearTimeout(timer)
  }, [t])

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()) }, [])

  // Wire stream to video element whenever phase enters preview/recording
  useEffect(() => {
    const vid = videoRef.current
    if (!vid || !streamRef.current) return
    if (phase === 'preview' || phase === 'recording') {
      vid.srcObject = streamRef.current
      vid.play().catch(() => {})
    }
  }, [phase])

  async function openCamera() {
    setError('')
    setRecBtnActive(false)
    setPhase('preview')
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
      // Detect torch + zoom support
      const track = stream.getVideoTracks()[0]
      const caps = track?.getCapabilities?.() as any
      if (caps?.torch) setTorchSupported(true)
      if (caps?.zoom && Number(caps.zoom.max ?? 1) > Number(caps.zoom.min ?? 1) + 0.1) {
        setZoomMin(Number(caps.zoom.min ?? 1)); setZoomMax(Number(caps.zoom.max ?? 1)); setZoom(Number(caps.zoom.min ?? 1))
      } else {
        setZoomMin(1); setZoomMax(4); setZoom(1)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Camera access denied — grant permission and try again.')
      setPhase('intro')
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try { await track.applyConstraints({ advanced: [{ torch: next } as any] }); setTorchOn(next) } catch {}
  }

  async function applyZoom(value: number) {
    const next = Math.max(zoomMin, Math.min(zoomMax, value))
    setZoom(next)
    const track = streamRef.current?.getVideoTracks()[0]
    if (track) {
      try { await track.applyConstraints({ advanced: [{ zoom: next } as any] }) } catch {}
    }
    if (videoRef.current) videoRef.current.style.transform = `scale(${next / zoomMin})`
  }

  async function startRecording() {
    if (!streamRef.current) return
    framesRef.current = []
    stopEarlyRef.current = false
    setPhase('recording')
    setSecondsLeft(Math.ceil(VIDEO_DURATION_MS / 1000))

    try {
      const startedAt = Date.now()
      const tickIv  = setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((VIDEO_DURATION_MS - (Date.now() - startedAt)) / 1000))), 300)
      const frameIv = setInterval(() => {
        if (videoRef.current) { const b64 = grabFrame(videoRef.current); if (b64) framesRef.current.push(b64) }
      }, FRAME_INTERVAL_MS)

      await new Promise<void>(r => {
        const t = setTimeout(r, VIDEO_DURATION_MS)
        const check = setInterval(() => { if (stopEarlyRef.current) { clearTimeout(t); clearInterval(check); r() } }, 100)
      })
      clearInterval(tickIv); clearInterval(frameIv)

      // Last frame
      if (videoRef.current) { const b64 = grabFrame(videoRef.current); if (b64) framesRef.current.push(b64) }
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null

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
        setPageEvidence('video', {
          skipped: false,
          captured: true,
          frameCount: dataUrls.length,
        })
      }

      setPhase('analyzing')
      await runAnalysis()
    } catch (e: any) {
      setError(e?.message ?? 'Recording failed. Please try again.')
      setPhase('preview')
    }
  }

  async function runAnalysis() {
    try {
      const res = await fetch(`${apiBase}/api/video-eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frames_b64: framesRef.current,
          language: lang,
          session_id: state.sessionId ?? undefined,
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
      setPageEvidence('video', {
        skipped: false,
        captured: true,
        analysed: true,
        score: data.video_score,
        verdict: data.verdict,
        frameCount: framesRef.current.length,
        signals: data.video_signals ?? [],
        purityEstimate: data.purity_estimate ?? null,
      })
    } catch (e: any) {
      setError(e?.message ?? 'Video analysis failed. Please try again.')
      setPageEvidence('video', {
        skipped: false,
        captured: framesRef.current.length > 0,
        analysed: false,
        frameCount: framesRef.current.length,
        error: e?.message ?? 'analysis_failed',
      })
    }
    setPhase('result')
  }

  function skipVideo() {
    skipCapture('video')
    setLiveAuthResult(null)
    setPageEvidence('video', {
      skipped: true,
      captured: false,
      analysed: false,
      score: null,
      frameCount: 0,
    })
    navigate('/audio-eval')
  }

  const scoreColor = (s: number) => s >= 70 ? 'text-emerald-600' : s >= 45 ? 'text-amber-500' : 'text-red-500'
  const barColor   = (s: number) => s >= 70 ? 'bg-emerald-500' : s >= 45 ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div className="page overflow-y-auto" style={{ backgroundColor: '#fdf8f6', backgroundImage: 'linear-gradient(rgba(180,100,80,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(180,100,80,0.9) 1px, transparent 1px)', backgroundSize: '28px 28px', backgroundRepeat: 'repeat' }}>

      {/* Tutorial overlay */}
      {showTutorial && phase === 'intro' && (
        <TutorialOverlay stepType="video" onDismiss={() => setShowTutorial(false)} />
      )}

      {/* Tutorial overlay — on intro only */}
      {showTutorial && phase === 'intro' && (
        <TutorialOverlay stepType="video" onDismiss={() => setShowTutorial(false)} />
      )}

      {/* Header */}
      <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
        <button
          onClick={() => phase !== 'recording' && (phase === 'preview' ? (streamRef.current?.getTracks().forEach(t => t.stop()), streamRef.current = null, setPhase('intro')) : navigate('/capture'))}
          className={clsx('flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md', phase === 'recording' && 'opacity-30 cursor-not-allowed')}
          disabled={phase === 'recording'}
        >
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
        <div className="flex flex-col items-center flex-1 gap-0.5">
          <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-0.5 rounded-full bg-stone-100/80 border border-stone-200/60">Step 6 / 8</span>
          <span className="text-base font-bold text-stone-950 tracking-tight">Video Scan</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => speak(t('voice_video'))}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
            disabled={phase === 'recording'}
          >
            <Video className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95"
          >
            <User className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* INTRO */}
      {phase === 'intro' && (
        <div className="px-5 py-5 space-y-4 animate-fade-in">
          <div className="scan-panel rounded-3xl px-5 py-4">
            <p className="text-sm font-semibold text-stone-800 leading-relaxed">
              A short video captures what still photos miss. Edge wear, surface consistency and the subtle signs that tell solid gold from plated.
            </p>
          </div>
          <div className="scan-panel rounded-2xl divide-y divide-stone-200/60">
            {[
              { n: '1', text: 'Place the piece flat on a white sheet or plain surface' },
              { n: '2', text: 'Film near a window or in bright, even light' },
              { n: '3', text: 'Rotate the piece steadily and slowly for the full 15 seconds' },
              { n: '4', text: 'Keep the edges, clasps and hallmark stamp visible throughout' },
            ].map(({ n, text }) => (
              <div key={n} className="flex items-start gap-3 px-4 py-3.5">
                <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{n}</span>
                <p className="text-sm text-stone-700 leading-snug">{text}</p>
              </div>
            ))}
          </div>
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          <button onClick={openCamera} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 hover:bg-stone-900 text-white font-semibold transition-colors active:scale-[0.98]">
            <Video className="w-5 h-5" /> Start 15-Second Video
          </button>
          <button onClick={skipVideo} className="w-full btn-secondary text-sm flex items-center justify-center gap-2">
            Skip Video
          </button>
        </div>
      )}

      <div className="px-5 py-5 space-y-4">

        {/* Shared viewfinder — visible in preview + recording */}
        {(phase === 'preview' || phase === 'recording') && (
          <div className="animate-fade-in">
            <div className="relative rounded-3xl overflow-hidden bg-stone-900 aspect-[3/4]">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
              <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: 'inset 0 0 60px rgba(0,0,0,0.35)' }} />
              {['top-3 left-3 border-t-2 border-l-2 rounded-tl-xl','top-3 right-3 border-t-2 border-r-2 rounded-tr-xl','bottom-3 left-3 border-b-2 border-l-2 rounded-bl-xl','bottom-3 right-3 border-b-2 border-r-2 rounded-br-xl'].map((cls, i) => (
                <div key={i} className={`absolute w-7 h-7 pointer-events-none ${cls}`} style={{ borderColor: 'rgba(255,255,255,0.55)' }} />
              ))}
              {/* Torch + REC overlay */}
              <div className="absolute top-3 right-3 flex flex-col gap-2">
                {torchSupported && (phase === 'preview' || phase === 'recording') && (
                  <button onClick={toggleTorch}
                    className={clsx('w-9 h-9 rounded-full flex items-center justify-center backdrop-blur-sm border transition-all',
                      torchOn ? 'bg-amber-400 border-amber-300 text-black' : 'bg-black/50 border-white/20 text-white/80')}>
                    {torchOn ? <Zap className="w-4 h-4 fill-current" /> : <ZapOff className="w-4 h-4" />}
                  </button>
                )}
              </div>
              {phase === 'recording' && (
                <div className="absolute top-4 left-4 flex items-center gap-2 bg-red-600/90 backdrop-blur-sm rounded-full px-3 py-1.5">
                  <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  <span className="text-white text-xs font-semibold tracking-wide">REC</span>
                </div>
              )}
            </div>

            {/* Zoom slider — above record button */}
            {(phase === 'preview' || phase === 'recording') && (
              <div className="mt-3 px-1">
                <input
                  type="range" min={zoomMin} max={zoomMax} step="0.1" value={zoom}
                  onChange={e => applyZoom(Number(e.target.value))}
                  className="zoom-slider-minimal w-full"
                  style={{ '--zoom-fill': `${((zoom - zoomMin) / (zoomMax - zoomMin)) * 100}%` } as React.CSSProperties}
                />
              </div>
            )}

            {/* Controls below zoom */}
            {phase === 'preview' && (
              <div className="mt-4 flex flex-col items-center gap-3">
                <button
                  onClick={() => {
                    setRecBtnActive(true)
                    setTimeout(() => startRecording(), 400)
                  }}
                  className="w-20 h-20 rounded-full flex items-center justify-center transition-transform active:scale-95"
                  style={{ background: 'rgba(50,50,50,0.5)', backdropFilter: 'blur(8px)' }}
                >
                  <div
                    className="transition-all duration-300 ease-in-out"
                    style={{
                      width: recBtnActive ? '2rem' : '2.5rem',
                      height: recBtnActive ? '2rem' : '2.5rem',
                      borderRadius: recBtnActive ? '0.5rem' : '9999px',
                      background: recBtnActive ? '#ef4444' : '#0c0a09',
                    }}
                  />
                </button>
                <button onClick={skipVideo} className="text-xs text-stone-400 font-medium py-2 px-4">
                  Skip Video
                </button>
              </div>
            )}

            {phase === 'recording' && (
              <div className="mt-4 flex flex-col items-center gap-3">
                {/* Tap to stop */}
                <button
                  onClick={() => { stopEarlyRef.current = true }}
                  className="w-20 h-20 rounded-full flex items-center justify-center active:scale-95 transition-transform"
                  style={{ background: 'rgba(50,50,50,0.5)', backdropFilter: 'blur(8px)' }}
                >
                  <div className="w-8 h-8 rounded-xl bg-red-500" />
                </button>
                <p className="text-stone-950 font-black text-5xl tabular-nums leading-none">{secondsLeft}</p>
                <p className="text-stone-400 text-xs">seconds remaining</p>
                <div className="w-full bg-stone-200 rounded-full h-1 mt-1">
                  <div
                    className="h-1 rounded-full bg-stone-950 transition-all duration-300"
                    style={{ width: `${100 - (secondsLeft / (VIDEO_DURATION_MS / 1000)) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3 mt-4">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ANALYZING */}
        {phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 animate-fade-in">
            <img
              src="/assets/4aee05b8-1171-11ee-aebc-033b1299bb801-ezgif.com-gif-maker.gif"
              alt="Analysing…"
              className="w-44 h-44 object-contain"
              style={{ imageRendering: 'auto' }}
            />
            <div className="text-center mt-2">
              <p className="font-bold text-stone-900 text-base tracking-tight">Reading {framesRef.current.length} frames</p>
              <p className="text-stone-400 text-sm mt-1">Checking wear, surface consistency and edge signals</p>
            </div>
          </div>
        )}

        {/* RESULT */}
        {phase === 'result' && (
          <div className="space-y-4 animate-fade-in">
            {result ? (
              <div className="surface-panel rounded-3xl p-5 space-y-4">
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

            <button
              onClick={() => navigate('/audio-eval')}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 hover:bg-stone-900 text-white font-semibold transition-colors active:scale-[0.98]"
            >
              Continue to Tap Test <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
