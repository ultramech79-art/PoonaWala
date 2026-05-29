import { useRef, useState, useCallback, useEffect } from 'react'
import { clsx } from 'clsx'
import { Camera as CameraIcon, Video, RotateCcw, Music, CheckCircle, Zap, ZapOff, SwitchCamera, Focus } from 'lucide-react'
import type { CaptureType } from '../store/session'

type MotionSample = { x: number; y: number; z: number; t: number }

export interface QualityResult {
  ok: boolean
  reasons: string[]
  score: number
}

function evaluateSharpness(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  const d = ctx.getImageData(0, 0, w, h).data
  let sum = 0, mean = 0
  for (let i = 0; i < d.length; i += 4) mean += d[i]
  mean /= (d.length / 4)
  for (let i = 0; i < d.length; i += 4) sum += Math.abs(d[i] - mean)
  return sum / (d.length / 4)
}

function evaluateExposure(ctx: CanvasRenderingContext2D, w: number, h: number): { mean: number; blown: number } {
  const d = ctx.getImageData(0, 0, w, h).data
  let sum = 0, blown = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3
    sum += l
    if (l > 245) blown++
  }
  return { mean: sum / n, blown: blown / n }
}

function quickQualityCheck(canvas: HTMLCanvasElement): QualityResult {
  const w = Math.min(canvas.width, 320)
  const h = Math.min(canvas.height, 240)
  const tmp = document.createElement('canvas')
  tmp.width = w; tmp.height = h
  tmp.getContext('2d')!.drawImage(canvas, 0, 0, w, h)
  const ctx2 = tmp.getContext('2d')!

  const reasons: string[] = []
  const sharpness = evaluateSharpness(ctx2, w, h)
  const { mean, blown } = evaluateExposure(ctx2, w, h)

  if (sharpness < 8) reasons.push('blurry')
  if (mean < 35)     reasons.push('dark')
  if (mean > 220)    reasons.push('bright')
  if (blown > 0.05)  reasons.push('bright')

  const score = Math.min(100, Math.round((sharpness / 25) * 80 + (blown < 0.01 ? 20 : 0)))
  return { ok: reasons.length === 0, reasons, score }
}

interface CameraProps {
  type: CaptureType
  onCapture: (blob: Blob, dataUrl: string, exif?: Record<string, unknown>) => void
  onError?: (err: string) => void
  facingMode?: 'environment' | 'user'
  isVideo?: boolean
  isAudio?: boolean
  capturedDataUrl?: string
}

export function Camera({ type, onCapture, onError, facingMode: initialFacing = 'environment', isVideo, isAudio, capturedDataUrl }: CameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const gyroRef = useRef<MotionSample[]>([])
  const qualityRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasAutoStarted = useRef(false)

  const [status, setStatus] = useState<'idle' | 'starting' | 'live' | 'recording' | 'done' | 'error'>('idle')
  const [quality, setQuality] = useState<QualityResult>({ ok: false, reasons: [], score: 0 })
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null)
  const [recordingSeconds, setRecordingSeconds] = useState(0)

  // Camera controls
  const [currentFacing, setCurrentFacing] = useState<'environment' | 'user'>(initialFacing)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [zoomMin, setZoomMin] = useState(1)
  const [zoomMax, setZoomMax] = useState(1)
  const [zoomSupported, setZoomSupported] = useState(false)
  const [focusTap, setFocusTap] = useState<{x: number; y: number} | null>(null)

  const applyTrackConstraints = useCallback(async (stream: MediaStream, facing: 'environment' | 'user') => {
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const caps = track.getCapabilities?.() as any

    if (caps?.torch && facing === 'environment') {
      setTorchSupported(true)
    } else {
      setTorchSupported(false)
      setTorchOn(false)
    }

    if (caps?.zoom && Number(caps.zoom.max ?? 1) > Number(caps.zoom.min ?? 1) + 0.1) {
      const min = Number(caps.zoom.min ?? 1)
      const max = Number(caps.zoom.max ?? 1)
      setZoomSupported(true)
      setZoomMin(min); setZoomMax(max); setZoom(min)
    } else {
      // Software zoom always available: 1×–4×
      setZoomSupported(true)
      setZoomMin(1); setZoomMax(4); setZoom(1)
    }
  }, [])

  const startCamera = useCallback(async (facing: 'environment' | 'user' = initialFacing) => {
    setStatus('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // Ask for higher frame rate for better focus
          frameRate: { ideal: 30 },
        },
        audio: !!(isAudio || isVideo),
      })
      mediaRef.current = stream

      const video = videoRef.current!
      video.muted = true
      video.srcObject = stream
      setStatus('live')
      setCurrentFacing(facing)

      await new Promise(r => setTimeout(r, 100))
      try { await video.play() } catch (_) {}

      await applyTrackConstraints(stream, facing)

      if (!isVideo && !isAudio) {
        qualityRef.current = setInterval(() => {
          const v = videoRef.current
          const c = canvasRef.current
          if (!v || !c || v.videoWidth <= 0) return
          c.width = v.videoWidth
          c.height = v.videoHeight
          c.getContext('2d')!.drawImage(v, 0, 0)
          setQuality(quickQualityCheck(c))
        }, 500)
      }
    } catch (e: any) {
      setStatus('error')
      onError?.(e?.message || 'Camera error')
    }
  }, [initialFacing, isVideo, isAudio, onError, applyTrackConstraints])

  const stopCamera = useCallback(() => {
    if (qualityRef.current) clearInterval(qualityRef.current)
    mediaRef.current?.getTracks().forEach(t => t.stop())
    mediaRef.current = null
  }, [])

  const switchCamera = useCallback(async () => {
    const next: 'environment' | 'user' = currentFacing === 'environment' ? 'user' : 'environment'
    stopCamera()
    await startCamera(next)
  }, [currentFacing, stopCamera, startCamera])

  const toggleTorch = useCallback(async () => {
    const track = mediaRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      const next = !torchOn
      await track.applyConstraints({ advanced: [{ torch: next } as any] })
      setTorchOn(next)
    } catch {}
  }, [torchOn])

  const applyZoom = useCallback(async (value: number) => {
    const next = Math.max(zoomMin, Math.min(zoomMax, value))
    setZoom(next)
    // Hardware zoom via constraints
    const track = mediaRef.current?.getVideoTracks()[0]
    if (track) {
      try { await track.applyConstraints({ advanced: [{ zoom: next } as any] }) } catch {}
    }
    // CSS software zoom — always applied as visual feedback
    if (videoRef.current) {
      videoRef.current.style.transform = `scale(${next / zoomMin})`
      videoRef.current.style.transformOrigin = 'center center'
    }
  }, [zoomMin, zoomMax])

  const tapToFocus = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const track = mediaRef.current?.getVideoTracks()[0]
    if (!track) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    setFocusTap({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setTimeout(() => setFocusTap(null), 1200)
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'manual', pointOfInterest: { x, y } } as any],
      })
      // Switch back to continuous after locking
      setTimeout(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => {}), 2000)
    } catch {}
  }, [])

  // Capture with brief stabilisation delay to avoid motion blur
  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const doCapture = () => {
      const v = videoRef.current!
      const c = canvasRef.current!
      c.width = v.videoWidth; c.height = v.videoHeight
      c.getContext('2d')!.drawImage(v, 0, 0)
      const exif: Record<string, unknown> = {
        timestamp: Date.now(),
        width: v.videoWidth,
        height: v.videoHeight,
        facing_mode: currentFacing,
        zoom,
        user_agent: navigator.userAgent,
      }
      c.toBlob(blob => {
        if (!blob) return
        const url = c.toDataURL('image/jpeg', 0.95)
        setCapturedUrl(url)
        setStatus('done')
        stopCamera()
        onCapture(blob, url, exif)
      }, 'image/jpeg', 0.95)
    }
    // 300ms stabilisation — reduces motion blur from button press shake
    setTimeout(doCapture, 300)
  }, [stopCamera, onCapture, currentFacing, zoom])

  const startRecording = useCallback(() => {
    if (!mediaRef.current) return
    chunksRef.current = []
    const recorder = new MediaRecorder(mediaRef.current, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm'
    })
    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      setCapturedUrl(url)
      setStatus('done')
      stopCamera()
      const exif: Record<string, unknown> = {
        timestamp: Date.now(),
        gyroscope_samples: gyroRef.current.length,
        gyroscope: gyroRef.current.slice(0, 600),
        duration_ms: (isAudio ? 3 : 5) * 1000,
        user_agent: navigator.userAgent,
      }
      gyroRef.current = []
      onCapture(blob, url, exif)
    }
    recorder.start(100)
    recorderRef.current = recorder
    setStatus('recording')
    setRecordingSeconds(0)
    const timer = setInterval(() => setRecordingSeconds(s => {
      if (s >= (isAudio ? 3 : 5) - 1) { clearInterval(timer); recorder.stop() }
      return s + 1
    }), 1000)
  }, [stopCamera, onCapture, isAudio])

  const retake = useCallback(() => {
    setCapturedUrl(null)
    setStatus('idle')
  }, [])

  const useDemoCapture = useCallback(async () => {
    const demoMap: Record<string, string> = {
      top: '/assets/demo/top.jpg', side: '/assets/demo/side.jpg',
      '45deg': '/assets/demo/45deg.jpg', macro: '/assets/demo/macro.jpg',
      selfie: '/assets/demo/selfie.jpg', video: '/assets/demo/video.mp4',
      audio: '/assets/demo/audio.mp3',
    }
    const url = demoMap[type as string] || demoMap.top
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      if (isVideo || isAudio) {
        setCapturedUrl(url); setStatus('done')
        onCapture(blob, url, { timestamp: Date.now(), source: 'demo', is_placeholder: true })
      } else {
        const reader = new FileReader()
        reader.onloadend = () => {
          const dataUrl = reader.result as string
          setCapturedUrl(dataUrl); setStatus('done')
          onCapture(blob, dataUrl, { timestamp: Date.now(), source: 'demo', width: 1280, height: 720 })
        }
        reader.readAsDataURL(blob)
      }
    } catch { onError?.('Demo asset not found') }
  }, [type, isVideo, isAudio, onCapture, onError])

  useEffect(() => {
    if (status !== 'recording') return
    const handler = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity
      if (a) gyroRef.current.push({ x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0, t: Date.now() })
    }
    window.addEventListener('devicemotion', handler, { passive: true })
    return () => window.removeEventListener('devicemotion', handler)
  }, [status])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && status === 'live' && !mediaRef.current?.active) startCamera(currentFacing)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [status, startCamera, currentFacing])

  useEffect(() => {
    if (hasAutoStarted.current) return
    hasAutoStarted.current = true
    startCamera(initialFacing)
  }, [startCamera, initialFacing])

  useEffect(() => {
    if (status === 'idle' && !mediaRef.current?.active) startCamera(currentFacing)
  }, [status])

  useEffect(() => () => stopCamera(), [stopCamera])

  useEffect(() => {
    if (capturedDataUrl) { setCapturedUrl(capturedDataUrl); setStatus('done'); stopCamera() }
    else { setCapturedUrl(null); setStatus('idle') }
  }, [capturedDataUrl, stopCamera])

  const maxSec = isAudio ? 3 : 5
  const isLive = status === 'live' || status === 'recording'

  return (
    <div className="w-full">
      <canvas ref={canvasRef} className="hidden" />

      {status === 'idle' && (
        <div className="space-y-3">
          <div className="camera-viewport flex items-center justify-center bg-black rounded-3xl">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 rounded-full border-2 border-gold-400 border-t-transparent animate-spin" />
              <p className="text-sm text-white/50">Starting camera…</p>
            </div>
          </div>
          <button id={`demo-capture-${type}`} onClick={useDemoCapture}
            className="w-full py-2.5 text-xs font-semibold text-brand-400 hover:text-brand-300 transition-colors text-center border border-brand-500/20 rounded-2xl hover:border-brand-500/40 hover:bg-brand-500/5">
            ⚡ TenzorX Hackathon Demo
          </button>
        </div>
      )}

      {status === 'starting' && (
        <div className="camera-viewport flex items-center justify-center bg-black rounded-3xl">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-gold-400 border-t-transparent animate-spin" />
            <p className="text-sm text-white/50">Starting camera…</p>
          </div>
        </div>
      )}

      <div className="relative" style={{ display: isLive ? 'block' : 'none' }}>
        {/* Tap-to-focus overlay */}
        <div
          className="camera-viewport rounded-3xl overflow-hidden bg-black relative cursor-crosshair"
          onClick={!isVideo && !isAudio ? tapToFocus : undefined}
        >
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover bg-black" style={{ display: 'block' }} />

          {/* Corner guides */}
          <div className="cam-overlay">
            <div className="cam-corner cam-corner-tl" />
            <div className="cam-corner cam-corner-tr" />
            <div className="cam-corner cam-corner-bl" />
            <div className="cam-corner cam-corner-br" />
          </div>

          {/* Tap-to-focus ring */}
          {focusTap && (
            <div
              className="absolute w-14 h-14 border-2 border-yellow-400 rounded-full pointer-events-none animate-ping"
              style={{ left: focusTap.x - 28, top: focusTap.y - 28 }}
            />
          )}

          {/* Recording indicator */}
          {status === 'recording' && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/80 backdrop-blur-sm">
              <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
              <span className="text-xs font-semibold text-white">{recordingSeconds}/{maxSec}s</span>
            </div>
          )}
          {status === 'recording' && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div className="h-full bg-red-500 transition-all duration-1000" style={{ width: `${(recordingSeconds / maxSec) * 100}%` }} />
            </div>
          )}

          {/* Camera controls overlay (top-right) */}
          {!isVideo && !isAudio && (
            <div className="absolute top-3 right-3 flex flex-col gap-2">
              {torchSupported && (
                <button onClick={e => { e.stopPropagation(); toggleTorch() }}
                  className={clsx('w-9 h-9 rounded-full flex items-center justify-center backdrop-blur-sm border transition-all',
                    torchOn ? 'bg-amber-400 border-amber-300 text-black' : 'bg-black/50 border-white/20 text-white/80')}>
                  {torchOn ? <Zap className="w-4 h-4 fill-current" /> : <ZapOff className="w-4 h-4" />}
                </button>
              )}
              <button onClick={e => { e.stopPropagation(); switchCamera() }}
                className="w-9 h-9 rounded-full bg-black/50 border border-white/20 text-white/80 flex items-center justify-center backdrop-blur-sm">
                <SwitchCamera className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Quality indicator */}
          {!isVideo && !isAudio && quality.score > 0 && (
            <div className="absolute top-3 left-3">
              <div className={clsx('text-[10px] font-bold px-2 py-1 rounded-full backdrop-blur-sm',
                quality.ok ? 'bg-emerald-500/70 text-white' : 'bg-red-500/70 text-white')}>
                {quality.ok ? '✓ Good' : quality.reasons[0]}
              </div>
            </div>
          )}
        </div>

        {/* Zoom slider */}
        {zoomSupported && !isVideo && !isAudio && (
          <div className="mt-3 px-1 space-y-1">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10px] font-semibold tracking-widest uppercase text-stone-400">Zoom</span>
              <span className="text-[11px] font-bold tabular-nums text-brand-500">{zoom.toFixed(1)}×</span>
            </div>
            <input
              type="range" min={zoomMin} max={zoomMax} step="0.1" value={zoom}
              onChange={e => applyZoom(Number(e.target.value))}
              className="zoom-slider"
              style={{ '--zoom-fill': `${((zoom - zoomMin) / (zoomMax - zoomMin)) * 100}%` } as React.CSSProperties}
            />
          </div>
        )}

        {/* Tap hint */}
        {!isVideo && !isAudio && !focusTap && (
          <p className="text-center text-[10px] text-stone-400 mt-1 flex items-center justify-center gap-1">
            <Focus className="w-3 h-3" /> Tap viewfinder to focus
          </p>
        )}

        {/* Capture / Record button */}
        <div className="flex flex-col items-center gap-3 mt-4">
          <div className="flex justify-center">
            {isVideo || isAudio ? (
              status === 'live' ? (
                <button id={`record-start-${type}`} onClick={startRecording}
                  className="w-20 h-20 rounded-full bg-red-500 border-4 border-white/20 flex items-center justify-center shadow-lg active:scale-95 transition-transform">
                  <div className="w-7 h-7 rounded-sm bg-white" />
                </button>
              ) : (
                <div className="w-20 h-20 rounded-full bg-red-500 border-4 border-white/20 flex items-center justify-center shadow-lg">
                  <div className="w-5 h-5 rounded-full bg-white animate-pulse" />
                </div>
              )
            ) : (
              <button id={`capture-${type}`} onClick={capture}
                className="w-20 h-20 rounded-full border-4 flex items-center justify-center shadow-lg transition-all bg-white border-brand-400/40 active:scale-90 shadow-brand">
                <div className="w-14 h-14 rounded-full bg-white" />
              </button>
            )}
          </div>
          <button id={`demo-capture-live-${type}`} onClick={useDemoCapture}
            className="px-4 py-1.5 text-[11px] font-semibold text-brand-400 hover:text-brand-300 transition-colors border border-brand-500/20 rounded-full hover:border-brand-500/40 hover:bg-brand-500/5">
            ⚡ TenzorX Hackathon Demo
          </button>
        </div>
      </div>

      {status === 'error' && (
        <div className="camera-viewport flex flex-col items-center justify-center gap-4 bg-red-500/5 border border-red-500/20 rounded-3xl p-6">
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center">
            <CameraIcon className="w-6 h-6 text-red-400" strokeWidth={1.8} />
          </div>
          <div className="text-center px-4">
            <p className="font-semibold text-white mb-2">Camera unavailable</p>
            <p className="text-xs text-white/50 mb-4">
              <strong>Allow camera access:</strong><br/><br/>
              <strong>Android:</strong> Settings → Apps → Browser → Permissions → Camera → Allow<br/><br/>
              <strong>iPhone:</strong> Settings → Safari/Chrome → Camera → Allow<br/><br/>
              <strong>Mac:</strong> System Preferences → Security & Privacy → Camera → Allow
            </p>
            <p className="text-xs text-white/40 mb-3">Or use demo mode to test without hardware.</p>
          </div>
          <div className="flex flex-col gap-2 w-full">
            <button id={`camera-retry-${type}`} onClick={() => startCamera(currentFacing)} className="w-full btn-primary">Retry Camera</button>
            <button id={`demo-capture-error-${type}`} onClick={useDemoCapture}
              className="w-full py-2.5 text-xs font-semibold text-brand-400 hover:text-brand-300 transition-colors text-center border border-brand-500/20 rounded-2xl hover:border-brand-500/40 hover:bg-brand-500/5">
              ⚡ TenzorX Hackathon Demo
            </button>
          </div>
        </div>
      )}

      {status === 'done' && capturedUrl && (
        <div className="relative">
          {isVideo ? (
            <video src={capturedUrl} controls className="w-full rounded-3xl" playsInline />
          ) : isAudio ? (
            <div className="camera-viewport flex flex-col items-center justify-center gap-4 bg-ink-800 rounded-3xl border border-emerald-500/20">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                <Music className="w-7 h-7 text-emerald-400" strokeWidth={1.8} />
              </div>
              <p className="font-semibold text-white">Audio recorded</p>
              <audio src={capturedUrl} controls className="w-48" />
            </div>
          ) : (
            <img src={capturedUrl} className="w-full rounded-3xl object-cover" style={{ aspectRatio: '3/4' }} alt="Captured" />
          )}
          <div className="absolute top-3 right-3">
            <span className="badge-green"><CheckCircle className="w-3 h-3" /> Captured</span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <button id={`retake-${type}`} onClick={retake} className="w-full btn-secondary text-sm">Retake</button>
            <button id={`demo-capture-done-${type}`} onClick={useDemoCapture}
              className="w-full py-2 text-xs font-semibold text-brand-400 hover:text-brand-300 transition-colors text-center border border-brand-500/20 rounded-2xl hover:border-brand-500/40 hover:bg-brand-500/5">
              ⚡ TenzorX Hackathon Demo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
