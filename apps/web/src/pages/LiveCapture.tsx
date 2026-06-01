import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore, type CaptureType } from '../store/session'
import { analyzeFrame, sendTapTest, authCheck, type AnalyzeResult, type TapTestResult, type AuthCheckResult } from '../lib/liveSession'
import { preferredCameraDeviceId } from '../lib/cameraQuality'
import { X, Zap, ZapOff, Mic, CheckCircle, SwitchCamera, Sparkles, AlertTriangle, ArrowRight } from 'lucide-react'

const ANGLES = ['top', '45deg', 'side', 'macro', 'selfie'] as const
type Angle = typeof ANGLES[number]
type Lang = 'en' | 'hi'

const LABELS: Record<Angle, string> = {
  top: 'Top-down', '45deg': '45° Angle', side: 'Side Profile', macro: 'Hallmark', selfie: 'Selfie',
}

const INTRO: Record<Lang, Record<Angle, string>> = {
  en: {
    top:    'Hold your gold ornament flat and point camera above it.',
    '45deg': 'Tilt camera 45 degrees to show the shape.',
    side:   'Show the side edge of the ornament.',
    macro:  'If hallmark is not visible, use manual entry below. Otherwise get very close to the stamp.',
    selfie: 'Take a selfie holding the gold ornament.',
  },
  hi: {
    top:    'गहना सपाट रखें, कैमरा ऊपर से पकड़ें।',
    '45deg': '45 डिग्री पर झुकाएं, आकार दिखाएं।',
    side:   'गहने का किनारा दिखाएं।',
    macro:  'हॉलमार्क नहीं दिखे तो नीचे मैन्युअल एंट्री करें। वरना स्टैम्प के पास जाएं।',
    selfie: 'सोना पकड़कर सेल्फी लें।',
  },
}

const ALL_DONE: Record<Lang, string> = {
  en: 'All photos captured! Analyzing your gold now.',
  hi: 'सभी फोटो हो गए! सोने का विश्लेषण हो रहा है।',
}

const PURITY_LABELS: Record<string, string> = {
  '24K': '24K — 999 Pure Gold', '22K': '22K — 916 Gold', '18K': '18K — 750 Gold',
  '999': '999 — 24K Pure Gold', '916': '916 — 22K Gold', '875': '875 — 21K Gold',
  '750': '750 — 18K Gold',      '585': '585 — 14K Gold', '417': '417 — 10K Gold',
  '375': '375 — 9K Gold',
}

const ANALYZE_INTERVAL_MS = 900
const AUTH_VIDEO_MS = 8000
const AUTH_AUDIO_MS = 7000
const AUTH_BUFFER_MS = 2000
type AuthPhase = 'ready' | 'video' | 'buffer' | 'audio' | 'analyzing' | 'results'

function purityToKarat(value: string): number | null {
  const clean = value.trim().toUpperCase()
  if (!clean) return null
  if (clean.endsWith('K')) {
    const karat = Number(clean.replace(/[^0-9.]/g, ''))
    return karat > 0 ? karat : null
  }
  const purity = Number(clean.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(purity) || purity <= 0) return null
  if (purity > 100) return Math.round((purity / 1000) * 24 * 10) / 10
  return purity <= 24 ? purity : null
}

function unlockTTS() {
  if (!('speechSynthesis' in window)) return
  const u = new SpeechSynthesisUtterance('')
  u.volume = 0
  window.speechSynthesis.speak(u)
  window.speechSynthesis.getVoices()
}

function speak(text: string, lang: Lang) {
  if (!('speechSynthesis' in window) || !text.trim()) return
  window.speechSynthesis.cancel()

  const doSpeak = () => {
    const u = new SpeechSynthesisUtterance(text)
    u.lang   = lang === 'hi' ? 'hi-IN' : 'en-IN'
    u.rate   = lang === 'hi' ? 0.88 : 0.95
    u.volume = 1
    const voices = window.speechSynthesis.getVoices()
    const v = voices.find(v => v.lang.startsWith(lang === 'hi' ? 'hi' : 'en') && v.localService)
           ?? voices.find(v => v.lang.startsWith(lang === 'hi' ? 'hi' : 'en'))
           ?? voices.find(v => v.lang.startsWith('en'))
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = () => { doSpeak(); window.speechSynthesis.onvoiceschanged = null }
  } else {
    doSpeak()
  }
}

function grabAnalysisFrame(video: HTMLVideoElement): string {
  if (video.readyState < 2) return ''
  const W = 256, H = Math.round(video.videoHeight * W / video.videoWidth)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  c.getContext('2d')!.drawImage(video, 0, 0, W, H)
  return c.toDataURL('image/jpeg', 0.68).split(',')[1]
}

function grabCaptureFrame(video: HTMLVideoElement): { dataUrl: string; blob: Promise<Blob> } {
  const W = Math.min(video.videoWidth, 1280), H = Math.round(video.videoHeight * W / video.videoWidth)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  c.getContext('2d')!.drawImage(video, 0, 0, W, H)
  const dataUrl = c.toDataURL('image/jpeg', 0.92)
  const blob = new Promise<Blob>(res => c.toBlob(b => res(b!), 'image/jpeg', 0.92))
  return { dataUrl, blob }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function videoFrameDataUrl(b64: string): string {
  return `data:image/jpeg;base64,${b64}`
}

function videoFrameBlob(b64: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

function drawOverlay(
  canvas: HTMLCanvasElement, quality: number, capturedCount: number, angle: Angle,
  flash: boolean, analyzing: boolean, ts: number,
) {
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)
  const color = flash ? '#22c55e' : quality > 0.65 ? '#22c55e' : quality > 0.40 ? '#f59e0b' : quality > 0 ? '#ef4444' : '#ffffff'
  const bracketAlpha = analyzing ? 0.45 + 0.55 * Math.abs(Math.sin(ts * 0.004)) : 1.0
  const mx = W * 0.06, my = H * 0.09, fw = W - 2 * mx, fh = H * 0.72, bl = Math.min(fw, fh) * 0.10

  if (flash) { ctx.fillStyle = 'rgba(34,197,94,0.20)'; ctx.fillRect(mx, my, fw, fh) }
  ctx.strokeStyle = color; ctx.globalAlpha = bracketAlpha; ctx.lineWidth = 4; ctx.lineCap = 'round'
  const corners: [number,number,number,number,number,number][] = [
    [mx,my+bl,mx,my,mx+bl,my], [mx+fw-bl,my,mx+fw,my,mx+fw,my+bl],
    [mx,my+fh-bl,mx,my+fh,mx+bl,my+fh], [mx+fw-bl,my+fh,mx+fw,my+fh,mx+fw,my+fh-bl],
  ]
  for (const [x1,y1,x2,y2,x3,y3] of corners) {
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.stroke()
  }
  ctx.globalAlpha = 1

  if (!analyzing && quality > 0 && !flash) {
    const scanT = (ts % 2200) / 2200, scanY = my + scanT * fh
    const grad = ctx.createLinearGradient(mx, scanY, mx+fw, scanY)
    grad.addColorStop(0,'transparent'); grad.addColorStop(0.5,`${color}70`); grad.addColorStop(1,'transparent')
    ctx.fillStyle = grad; ctx.fillRect(mx, scanY-1.5, fw, 3)
  }

  const labelText = LABELS[angle] ?? angle, fs = Math.max(12, Math.round(W * 0.040))
  ctx.font = `bold ${fs}px system-ui, sans-serif`; ctx.textAlign = 'center'
  const tw = ctx.measureText(labelText).width, px = 14, py = 8
  const lx = W/2 - tw/2 - px, ly = my - fs - 14
  ctx.fillStyle = 'rgba(0,0,0,0.68)'; ctx.beginPath()
  ;(ctx as any).roundRect?.(lx, ly, tw+2*px, fs+2*py, 8) ?? ctx.rect(lx, ly, tw+2*px, fs+2*py); ctx.fill()
  ctx.fillStyle = 'white'; ctx.fillText(labelText, W/2, ly+fs+py-2)

  const dr = 5, dsp = dr * 5.5, dox = W/2 - (ANGLES.length-1)*dsp/2, doy = my+fh+28
  for (let i = 0; i < ANGLES.length; i++) {
    ctx.beginPath(); ctx.arc(dox+i*dsp, doy, i===capturedCount ? dr+2 : dr, 0, Math.PI*2)
    ctx.fillStyle = i<capturedCount ? '#22c55e' : i===capturedCount ? color : 'rgba(255,255,255,0.22)'; ctx.fill()
    if (i===capturedCount) { ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.stroke() }
  }

  const bw=5, bh=fh*0.50, bx=mx+fw+12, by=my+(fh-bh)/2
  ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.beginPath()
  ;(ctx as any).roundRect?.(bx,by,bw,bh,3) ?? ctx.rect(bx,by,bw,bh); ctx.fill()
  if (quality > 0) {
    const qh=bh*quality; ctx.fillStyle=color; ctx.beginPath()
    ;(ctx as any).roundRect?.(bx,by+bh-qh,bw,qh,3) ?? ctx.rect(bx,by+bh-qh,bw,qh); ctx.fill()
  }
  if (analyzing) {
    for (let i=0; i<3; i++) {
      ctx.globalAlpha = 0.35+0.65*Math.abs(Math.sin(ts*0.006+i*1.15))
      ctx.beginPath(); ctx.arc(mx+fw-10-i*14, my+14, 4, 0, Math.PI*2); ctx.fillStyle='#f59e0b'; ctx.fill()
    }
    ctx.globalAlpha=1
  }
}

// ── Audio tap test ──────────────────────────────────────────────────────────────
async function recordTapAudio(durationMs = 3000): Promise<{ samplesB64: string; sampleRate: number } | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const collected: Float32Array[] = []

    source.connect(processor)
    processor.connect(ctx.destination)

    await new Promise<void>(resolve => {
      const start = Date.now()
      processor.onaudioprocess = e => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0))
        collected.push(data)
        if (Date.now() - start >= durationMs) {
          processor.disconnect(); source.disconnect(); stream.getTracks().forEach(t => t.stop()); ctx.close()
          resolve()
        }
      }
    })

    const total = collected.reduce((a, b) => a + b.length, 0)
    const flat = new Float32Array(total)
    let offset = 0
    for (const chunk of collected) { flat.set(chunk, offset); offset += chunk.length }
    const bytes = new Uint8Array(flat.buffer)
    const b64 = bytesToBase64(bytes)
    return { samplesB64: b64, sampleRate: ctx.sampleRate }
  } catch { return null }
}

function startAudioSamplingFromStream(stream: MediaStream): (() => Promise<{ samplesB64: string; sampleRate: number } | null>) | null {
  if (!stream.getAudioTracks().length) return null

  let ctx: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let gain: GainNode | null = null
  const collected: Float32Array[] = []

  try {
    ctx = new AudioContext()
    source = ctx.createMediaStreamSource(stream)
    processor = ctx.createScriptProcessor(4096, 1, 1)
    gain = ctx.createGain()
    gain.gain.value = 0

    source.connect(processor)
    processor.connect(gain)
    gain.connect(ctx.destination)
    ctx.resume().catch(() => {})

    processor.onaudioprocess = e => {
      collected.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
  } catch {
    processor?.disconnect()
    source?.disconnect()
    gain?.disconnect()
    ctx?.close()
    return null
  }

  return async () => {
    processor?.disconnect()
    source?.disconnect()
    gain?.disconnect()
    await ctx?.close().catch(() => {})

    const total = collected.reduce((a, b) => a + b.length, 0)
    if (total === 0 || !ctx) return null
    const flat = new Float32Array(total)
    let offset = 0
    for (const chunk of collected) { flat.set(chunk, offset); offset += chunk.length }
    const bytes = new Uint8Array(flat.buffer)
    return {
      samplesB64: bytesToBase64(bytes),
      sampleRate: ctx.sampleRate,
    }
  }
}


export function LiveCapture() {
  const navigate       = useNavigate()
  const { addCapture, setScannedKarat } = useSessionStore()

  const videoRef    = useRef<HTMLVideoElement | null>(null)
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const rafRef      = useRef<number>(0)
  const ivRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  const capturedRef = useRef<string[]>([])
  const angleRef    = useRef(0)
  const qualityRef  = useRef(0)
  const flashRef    = useRef(false)
  const analyzingRef= useRef(false)
  const langRef     = useRef<Lang>('en')
  const lastGuidanceRef = useRef('')
  const lastGuidanceAtRef = useRef(0)
  const approvalStreakRef = useRef<{ angle: Angle | null; count: number }>({ angle: null, count: 0 })
  const [capturedCount, setCapturedCount] = useState(0)
  const [guidance, setGuidance]           = useState('')
  const [observedItem, setObservedItem]   = useState('')
  const [isAnalyzing, setIsAnalyzing]     = useState(false)
  const [language, setLanguage]           = useState<Lang>('en')
  const [status, setStatus]               = useState<'tap'|'loading'|'active'|'auth'|'done'|'error'>('tap')
  const [errorMsg, setErrorMsg]           = useState('')
  const [torchOn, setTorchOn]             = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [cameraFacing, setCameraFacing]   = useState<'environment' | 'user'>('environment')
  const [zoomSupported, setZoomSupported] = useState(false)
  const [zoom, setZoom]                   = useState(1)
  const [zoomMin, setZoomMin]             = useState(1)
  const [zoomMax, setZoomMax]             = useState(1)
  // Purity modal (shown after macro shot)
  const [showPurityModal, setShowPurityModal]     = useState(false)
  const [purityPrediction, setPurityPrediction]   = useState<{hint: string; confidence: number} | null>(null)
  const [manualPurity, setManualPurity]           = useState('')
  const [selectedPurity, setSelectedPurity]       = useState('')

  // Tap test
  const [tapResult, setTapResult]     = useState<TapTestResult | null>(null)
  const [isTapTesting, setIsTapTesting] = useState(false)
  const [showTapPanel, setShowTapPanel] = useState(false)

  // Auth check step
  const [authPhase, setAuthPhase]         = useState<AuthPhase>('ready')
  const [authFrameCount, setAuthFrameCount] = useState(0)
  const [authSecondsLeft, setAuthSecondsLeft] = useState(0)
  const authFramesRef                       = useRef<string[]>([])
  const authAudioStopRef                    = useRef<null | (() => Promise<{ samplesB64: string; sampleRate: number } | null>)>(null)
  const [authAudioReady, setAuthAudioReady] = useState(false)
  const [authResult, setAuthResult]         = useState<AuthCheckResult | null>(null)

  useEffect(() => { angleRef.current = capturedCount }, [capturedCount])
  useEffect(() => { langRef.current  = language      }, [language])

  const bindVideoElement = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    if (!node) return
    node.muted = true
    node.defaultMuted = true
    node.playsInline = true
    const stream = streamRef.current
    if (!stream) return
    node.srcObject = stream
    const play = () => node.play().catch(() => {})
    if (node.readyState >= 1) play()
    else node.onloadedmetadata = play
  }, [])

  const configureCameraTrack = useCallback(async (preferredZoom?: number) => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const caps = track.getCapabilities?.() as any
    const settings = track.getSettings?.() as any

    if (caps?.torch) {
      setTorchSupported(true)
      try { await track.applyConstraints({ advanced: [{ torch: true } as any] }); setTorchOn(true) } catch {}
    } else {
      setTorchSupported(false)
      setTorchOn(false)
    }

    if (caps?.zoom) {
      const min = Number(caps.zoom.min ?? 1)
      const max = Number(caps.zoom.max ?? 1)
      const nextZoom = Math.max(min, Math.min(max, preferredZoom ?? Number(settings?.zoom ?? min)))
      setZoomSupported(max > min)
      setZoomMin(min)
      setZoomMax(max)
      setZoom(nextZoom)
      try { await track.applyConstraints({ advanced: [{ zoom: nextZoom } as any] }) } catch {}
    } else {
      setZoomSupported(false)
      setZoomMin(1)
      setZoomMax(1)
      setZoom(1)
    }
  }, [])

  const applyTorch = useCallback(async (on: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try { await track.applyConstraints({ advanced: [{ torch: on } as any] }); setTorchOn(on) } catch {}
  }, [])

  const applyZoom = useCallback(async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = Math.max(zoomMin, Math.min(zoomMax, value))
    setZoom(next)
    try {
      await track.applyConstraints({ advanced: [{ zoom: next } as any] })
      // Wait longer for zoom hardware to stabilize (200-300ms)
      await new Promise(r => setTimeout(r, 300))
      const settings = track.getSettings?.() as any
      console.log('[Zoom Applied]', { requested: next, actual: settings?.zoom })
    } catch (e) {
      console.warn('[Zoom Failed]', e)
    }
  }, [zoomMin, zoomMax])

  const switchCamera = useCallback(async (facingMode: 'user' | { ideal: 'environment' }, preferredZoom?: number, includeAudio = false) => {
    const previous = streamRef.current
    const facing: 'environment' | 'user' = facingMode === 'user' ? 'user' : 'environment'

    if (previous && facing !== cameraFacing) {
      previous.getVideoTracks().forEach(t => t.stop())
    }

    const deviceId = await preferredCameraDeviceId(facingMode)
    const next = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode }),
        width: { ideal: 1280 },
      },
      audio: includeAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    })
    streamRef.current = next
    if (videoRef.current) {
      videoRef.current.muted = true
      videoRef.current.defaultMuted = true
      videoRef.current.playsInline = true
      videoRef.current.srcObject = next
      await new Promise<void>(resolve => {
        const video = videoRef.current!
        const play = () => video.play().catch(() => {}).finally(resolve)
        if (video.readyState >= 1) play()
        else video.onloadedmetadata = play
      })
    }
    previous?.getTracks().forEach(t => {
      if (!next.getTracks().includes(t) && t.readyState !== 'ended') t.stop()
    })
    setCameraFacing(facing)
    await configureCameraTrack(preferredZoom)
  }, [cameraFacing, configureCameraTrack])

  useEffect(() => {
    if (status !== 'active' && status !== 'auth') return
      const video = videoRef.current
      const stream = streamRef.current
      if (!video || !stream || video.srcObject === stream) return
      video.muted = true
      video.defaultMuted = true
      video.playsInline = true
      video.srcObject = stream
      video.play().catch(() => {})
  }, [status, authPhase])

  const startCamera = useCallback(async () => {
    setStatus('loading')
    try {
      let deviceId = await preferredCameraDeviceId({ ideal: 'environment' })

      // If no preferred device found, use the first available camera
      if (!deviceId) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const videoInputs = devices.filter(d => d.kind === 'videoinput')
          if (videoInputs.length > 0) {
            deviceId = videoInputs[0].deviceId
          }
        } catch (e) {
          console.warn('Could not enumerate devices:', e)
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1280 },
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.muted = true
        videoRef.current.defaultMuted = true
        videoRef.current.playsInline = true
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraFacing('environment')
      await configureCameraTrack()
      const intro = INTRO[langRef.current].top
      setGuidance(intro)
      setTimeout(() => speak(intro, langRef.current), 300)
      setStatus('active')
    } catch (e) {
      setErrorMsg((e as Error).message ?? 'Camera access denied'); setStatus('error')
    }
  }, [configureCameraTrack])

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
      window.speechSynthesis?.cancel()
      clearInterval(ivRef.current!)
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const doAnalyze = useCallback(async () => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || inFlightRef.current) return
    const idx = angleRef.current
    if (idx >= ANGLES.length) return
    const b64 = grabAnalysisFrame(video)
    if (!b64) return

    inFlightRef.current = true; analyzingRef.current = true; setIsAnalyzing(true)
    let result: AnalyzeResult | null = null
    try {
      result = await analyzeFrame(b64, ANGLES[idx], capturedRef.current, langRef.current)
      qualityRef.current = result.quality_score
    } catch (e) { console.warn('Vertex error:', (e as Error).message) }
    finally { inFlightRef.current = false; analyzingRef.current = false; setIsAnalyzing(false) }

    if (!result) return

    if (result.observed_item) setObservedItem(result.observed_item)

    if (result.approved) {
      const angle = ANGLES[idx]
      const currentStreak = approvalStreakRef.current
      const nextCount = currentStreak.angle === angle ? currentStreak.count + 1 : 1
      approvalStreakRef.current = { angle, count: nextCount }

      if (nextCount < 2) {
        const hold = langRef.current === 'hi'
          ? 'अच्छा लग रहा है; एक पल स्थिर रखें।'
          : 'Looks correct; hold steady one more moment.'
        setGuidance(hold)
        return
      }

      approvalStreakRef.current = { angle: null, count: 0 }

      // Macro: pause analysis and show inline purity panel.
      // Frame is saved by completeMacroWithPurity() when user confirms.
      if (ANGLES[idx] === 'macro') {
        if (result.purity_hint) {
          setPurityPrediction({ hint: result.purity_hint, confidence: result.purity_confidence })
        }
        clearInterval(ivRef.current!)
        flashRef.current = true; setTimeout(() => { flashRef.current = false }, 900)
        const hint = result.purity_hint
          ? (langRef.current === 'hi'
              ? `हॉलमार्क मिला: ${result.purity_hint} — नीचे से कन्फर्म करें।`
              : `Hallmark found: ${result.purity_hint} — confirm or change below.`)
          : (langRef.current === 'hi'
              ? 'हॉलमार्क नहीं दिखा — नीचे शुद्धता चुनें।'
              : 'Hallmark not found — select purity below.')
        setGuidance(hint)
        speak(hint, langRef.current)
        return
      }

      const { dataUrl, blob } = grabCaptureFrame(video)
      const resolvedBlob = await blob
      addCapture({ type: ANGLES[idx] as CaptureType, dataUrl, blob: resolvedBlob, timestamp: Date.now() })
      flashRef.current = true; setTimeout(() => { flashRef.current = false }, 900)
      capturedRef.current = [...capturedRef.current, ANGLES[idx]]
      const nextIdx = idx + 1
      setCapturedCount(nextIdx)

      // Immediately speak the next instruction
      const instruction = result.next_instruction ?? ALL_DONE[langRef.current]
      setGuidance(instruction)
      speak(instruction, langRef.current)

      if (nextIdx >= ANGLES.length) {
        // Switch back to rear camera for one combined video + sound recording.
        clearInterval(ivRef.current!)
        setAuthAudioReady(false)
        // Reset zoom to 1x for auth check video
        try {
          await switchCamera({ ideal: 'environment' }, 1, true)
        } catch {
          try {
            await switchCamera({ ideal: 'environment' }, 1, false)
          } catch {
            await applyZoom(1)
          }
        }
        authFramesRef.current = []
        authAudioStopRef.current = null
        setAuthAudioReady(Boolean(streamRef.current?.getAudioTracks().length))
        setAuthFrameCount(0)
        setAuthSecondsLeft(0)
        setAuthPhase('ready')
        setStatus('auth')
        const msg = language === 'hi'
          ? 'तैयार होने पर अंतिम जांच शुरू करें।'
          : 'Start the final check when you are ready.'
        setGuidance(msg); speak(msg, langRef.current)
        return
      }
      if (ANGLES[nextIdx] === 'selfie') {
        clearInterval(ivRef.current!)
        setTorchOn(false); setTorchSupported(false)
        try {
          await switchCamera('user', 1)
        } catch {}
        const selfieIntro = INTRO[langRef.current].selfie
        setGuidance(selfieIntro)
        speak(selfieIntro, langRef.current)
        setTimeout(() => {
          if (angleRef.current === nextIdx && status === 'active') {
            clearInterval(ivRef.current!)
            ivRef.current = setInterval(doAnalyze, ANALYZE_INTERVAL_MS)
          }
        }, 900)
        return
      }
      if (ANGLES[nextIdx] === 'macro') {
        const macroZoom = Math.min(Math.max(2, zoomMin), zoomMax)
        if (zoomSupported) {
          await applyZoom(macroZoom)
          await new Promise(r => setTimeout(r, 500))
        }
      }
    } else if (result.guidance) {
      approvalStreakRef.current = { angle: null, count: 0 }
      const now = Date.now()
      const shouldSpeak = result.guidance !== lastGuidanceRef.current && now - lastGuidanceAtRef.current > 2800
      setGuidance(result.guidance)
      if (shouldSpeak) {
        speak(result.guidance, langRef.current)
        lastGuidanceRef.current = result.guidance
        lastGuidanceAtRef.current = now
      }
    }
  }, [addCapture, applyZoom, configureCameraTrack, navigate, status, switchCamera, zoom, zoomMax, zoomMin, zoomSupported])

  const flipCamera = useCallback(async (includeAudio = false) => {
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user'
    clearInterval(ivRef.current!)
    if (status === 'auth' && authAudioStopRef.current) {
      authAudioStopRef.current().catch(() => {})
      authAudioStopRef.current = null
      setAuthAudioReady(false)
    }
    const target: 'user' | { ideal: 'environment' } = nextFacing === 'user' ? 'user' : { ideal: 'environment' }
    try {
      await switchCamera(target, nextFacing === 'user' ? 1 : zoom, includeAudio)
      if (status === 'auth' && includeAudio) {
        setAuthAudioReady(Boolean(streamRef.current?.getAudioTracks().length))
      }
      const label = nextFacing === 'user' ? 'front' : 'rear'
      setGuidance(language === 'hi' ? 'कैमरा बदल गया।' : `Switched to ${label} camera.`)
    } catch {
      setGuidance(language === 'hi' ? 'कैमरा बदल नहीं पाया।' : 'Could not switch camera.')
    }
    if (status === 'active') {
      setTimeout(() => {
        clearInterval(ivRef.current!)
        ivRef.current = setInterval(doAnalyze, ANALYZE_INTERVAL_MS)
      }, 700)
    }
  }, [authPhase, cameraFacing, doAnalyze, language, status, switchCamera, zoom])

  useEffect(() => {
    if (status !== 'active') return
    ivRef.current = setInterval(doAnalyze, ANALYZE_INTERVAL_MS)
    return () => { clearInterval(ivRef.current!) }
  }, [status, doAnalyze])

  useEffect(() => {
    if (status !== 'active') return
    function loop(ts: number) {
      rafRef.current = requestAnimationFrame(loop)
      const video = videoRef.current, canvas = canvasRef.current
      if (!video || !canvas || video.readyState < 2) return
      const dw = canvas.offsetWidth, dh = canvas.offsetHeight
      if (canvas.width !== dw || canvas.height !== dh) { canvas.width = dw; canvas.height = dh }
      const idx = angleRef.current
      if (idx < ANGLES.length) drawOverlay(canvas, qualityRef.current, idx, ANGLES[idx], flashRef.current, analyzingRef.current, ts)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [status])

  const finishAuthEvaluation = useCallback(async (audio?: { samplesB64: string; sampleRate: number } | null) => {
    setAuthPhase('analyzing')
    const usableFrames = authFramesRef.current.filter(Boolean).slice(0, 10)
    if (usableFrames.length) {
      const dataUrls = usableFrames.map(videoFrameDataUrl)
      addCapture({
        type: 'video',
        dataUrl: dataUrls[0],
        blob: videoFrameBlob(usableFrames[0]),
        timestamp: Date.now(),
        exif: {
          videoFramesDataUrl: dataUrls,
          videoFrameCount: dataUrls.length,
          source: 'live-capture-auth',
        },
      })
    }
    try {
      const result = await authCheck(authFramesRef.current, langRef.current, audio?.samplesB64, audio?.sampleRate)
      setAuthResult(result)
      speak(result.guidance, langRef.current)
    } catch {
      setAuthResult(null)
    }
    setAuthPhase('results')
  }, [addCapture])

  const beginAuthEvaluation = useCallback(() => {
    authFramesRef.current = []
    if (authAudioStopRef.current) {
      authAudioStopRef.current().catch(() => {})
      authAudioStopRef.current = null
    }
    setAuthResult(null)
    setAuthFrameCount(0)
    setAuthSecondsLeft(Math.ceil(AUTH_VIDEO_MS / 1000))
    setAuthAudioReady(Boolean(streamRef.current?.getAudioTracks().length))
    const msg = langRef.current === 'hi'
      ? 'गहने को 8 सेकंड धीरे-धीरे घुमाएं — हर कोण दिखाएं।'
      : 'Slowly rotate the ornament for 8 seconds — show every angle.'
    setGuidance(msg)
    speak(msg, langRef.current)
    setAuthPhase('video')
  }, [])

  // Auth video phase — 12-second rotation clip, captures up to 10 high-res frames.
  useEffect(() => {
    if (status !== 'auth' || authPhase !== 'video') return

    const capture = () => {
      const video = videoRef.current
      if (!video || video.readyState < 2) return
      if (authFramesRef.current.length >= 10) return
      // Use higher resolution (480px) for auth frames — deep analysis needs detail
      const W = 480, H = Math.round(video.videoHeight * W / video.videoWidth)
      const c = document.createElement('canvas'); c.width = W; c.height = H
      c.getContext('2d')!.drawImage(video, 0, 0, W, H)
      const b64 = c.toDataURL('image/jpeg', 0.88).split(',')[1]
      if (!b64) return
      authFramesRef.current = [...authFramesRef.current, b64]
      setAuthFrameCount(authFramesRef.current.length)
    }

    const startedAt = Date.now()
    const first = setTimeout(capture, 250)
    const frameIv = setInterval(capture, 1000)
    const tickIv = setInterval(() => {
      const left = Math.max(0, Math.ceil((AUTH_VIDEO_MS - (Date.now() - startedAt)) / 1000))
      setAuthSecondsLeft(left)
    }, 250)
    const done = setTimeout(() => {
      clearTimeout(first)
      clearInterval(frameIv)
      clearInterval(tickIv)
      capture()
      setAuthSecondsLeft(Math.ceil(AUTH_BUFFER_MS / 1000))
      const msg = langRef.current === 'hi'
        ? 'अब गहने को सख्त सतह पर रखें। टैप टेस्ट शुरू होगा।'
        : 'Place the ornament on a fixed hard surface. Tap test starts next.'
      setGuidance(msg)
      speak(msg, langRef.current)
      setAuthPhase('buffer')
    }, AUTH_VIDEO_MS)

    return () => {
      clearTimeout(first)
      clearTimeout(done)
      clearInterval(frameIv)
      clearInterval(tickIv)
    }
  }, [status, authPhase])

  // Short buffer so the user can place the ornament on a fixed surface.
  useEffect(() => {
    if (status !== 'auth' || authPhase !== 'buffer') return
    const startedAt = Date.now()
    const tickIv = setInterval(() => {
      const left = Math.max(0, Math.ceil((AUTH_BUFFER_MS - (Date.now() - startedAt)) / 1000))
      setAuthSecondsLeft(left)
    }, 250)
    const t = setTimeout(() => {
      clearInterval(tickIv)
      setAuthSecondsLeft(Math.ceil(AUTH_AUDIO_MS / 1000))
      const msg = langRef.current === 'hi'
        ? '10 सेकंड तक सख्त सतह पर गहने को हल्के से टैप करें।'
        : 'For 10 seconds, gently tap the ornament against the hard surface.'
      setGuidance(msg)
      speak(msg, langRef.current)
      setAuthPhase('audio')
    }, AUTH_BUFFER_MS)

    return () => {
      clearTimeout(t)
      clearInterval(tickIv)
    }
  }, [status, authPhase])

  // Auth audio phase — fixed 10-second tap recording.
  useEffect(() => {
    if (status !== 'auth' || authPhase !== 'audio') return
    let cancelled = false
    let micStream: MediaStream | null = null

    const startAudio = async () => {
      let stopAudio = streamRef.current ? startAudioSamplingFromStream(streamRef.current) : null
      if (!stopAudio) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            video: false,
          })
          const rawStop = startAudioSamplingFromStream(micStream)
          if (rawStop) {
            stopAudio = async () => {
              const audio = await rawStop()
              micStream?.getTracks().forEach(t => t.stop())
              return audio
            }
          }
        } catch {}
      }

      if (cancelled) {
        await stopAudio?.().catch(() => null)
        micStream?.getTracks().forEach(t => t.stop())
        return
      }

      authAudioStopRef.current = stopAudio
      setAuthAudioReady(Boolean(stopAudio))

      const startedAt = Date.now()
      const tickIv = setInterval(() => {
        const left = Math.max(0, Math.ceil((AUTH_AUDIO_MS - (Date.now() - startedAt)) / 1000))
        setAuthSecondsLeft(left)
      }, 250)

      const done = setTimeout(async () => {
        clearInterval(tickIv)
        const stop = authAudioStopRef.current
        authAudioStopRef.current = null
        const audio = stop ? await stop() : null
        if (!cancelled) finishAuthEvaluation(audio)
      }, AUTH_AUDIO_MS)

      cleanup = () => {
        clearTimeout(done)
        clearInterval(tickIv)
      }
    }

    let cleanup = () => {}
    startAudio()

    return () => {
      cancelled = true
      cleanup()
      if (authAudioStopRef.current) {
        authAudioStopRef.current().catch(() => {})
        authAudioStopRef.current = null
      }
      micStream?.getTracks().forEach(t => t.stop())
    }
  }, [status, authPhase, finishAuthEvaluation])

  const handlePurityDone = useCallback(() => {
    const purity = selectedPurity || manualPurity || purityPrediction?.hint || ''
    const karat = purityToKarat(purity)
    if (karat) setScannedKarat(karat)
    setShowPurityModal(false)
    const nextIdx = capturedRef.current.length
    if (nextIdx >= ANGLES.length) {
      setStatus('done'); setTimeout(() => navigate('/processing'), 2800); return
    }
    // Resume analysis
    setGuidance(INTRO[langRef.current][ANGLES[nextIdx]])
    speak(INTRO[langRef.current][ANGLES[nextIdx]], langRef.current)
    ivRef.current = setInterval(doAnalyze, ANALYZE_INTERVAL_MS)
  }, [selectedPurity, manualPurity, purityPrediction, doAnalyze, navigate, setScannedKarat])

  const runTapTest = useCallback(async () => {
    setIsTapTesting(true)
    setTapResult(null)
    const msg = language === 'hi' ? 'तैयार हो जाएं — 3 सेकंड में गहना टैप करें' : 'Get ready — tap your ornament in 3 seconds'
    setGuidance(msg); speak(msg, langRef.current)
    await new Promise(r => setTimeout(r, 1500))
    const audio = await recordTapAudio(3000)
    if (!audio) { setIsTapTesting(false); return }
    try {
      const result = await sendTapTest(audio.samplesB64, audio.sampleRate, langRef.current)
      setTapResult(result)
      const summary = language === 'hi'
        ? `ध्वनि परीक्षण: ${result.score}% — ${result.label}`
        : `Sound test: ${result.score}% — ${result.label}`
      setGuidance(summary); speak(summary, langRef.current)
    } catch { /* ignore */ }
    setIsTapTesting(false)
  }, [language])

  const completeMacroWithPurity = useCallback(async (purity: string) => {
    const karat = purityToKarat(purity)
    if (karat) setScannedKarat(karat)

    clearInterval(ivRef.current!)
    approvalStreakRef.current = { angle: null, count: 0 }

    if (!capturedRef.current.includes('macro')) {
      const video = videoRef.current
      if (video && video.readyState >= 2) {
        const { dataUrl, blob } = grabCaptureFrame(video)
        addCapture({
          type: 'macro',
          dataUrl,
          blob: await blob,
          timestamp: Date.now(),
        })
      }
      capturedRef.current = [...capturedRef.current.filter(a => a !== 'macro'), 'macro']
    }

    const nextIdx = ANGLES.indexOf('selfie')
    setCapturedCount(nextIdx)
    setShowPurityModal(false)
    setSelectedPurity('')
    setManualPurity('')

    // Reset zoom and torch for selfie
    setTorchOn(false)
    setTorchSupported(false)
    if (zoomSupported) await applyZoom(1)

    try {
      await switchCamera('user', 1)
    } catch {}

    const selfieIntro = INTRO[langRef.current].selfie
    setGuidance(selfieIntro)
    speak(selfieIntro, langRef.current)
    setTimeout(() => {
      clearInterval(ivRef.current!)
      ivRef.current = setInterval(doAnalyze, ANALYZE_INTERVAL_MS)
    }, 900)
  }, [addCapture, doAnalyze, setScannedKarat, switchCamera, zoomSupported, applyZoom])

  const handleStart = () => { unlockTTS(); startCamera() }

  // ── Tap-to-start ─────────────────────────────────────────────────────────────
  if (status === 'tap') return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-6 px-6">
      <button onClick={() => navigate('/capture')} className="absolute top-5 left-4 flex items-center gap-1 text-white/40 text-xs">
        <X className="w-4 h-4" /> Manual
      </button>
      <div className="relative flex items-center justify-center">
        <div className="absolute w-32 h-32 rounded-full border border-amber-400/20 animate-ping" />
        <div className="absolute w-24 h-24 rounded-full border border-amber-400/30 animate-pulse" />
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-brand-500 to-brand-800 flex items-center justify-center shadow-2xl shadow-amber-500/40">
          <Sparkles className="w-9 h-9 text-white" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-white font-bold text-xl mb-1">AI Live Capture</p>
        <p className="text-white/50 text-sm">Gemini guides you through 5 shots<br/>with voice instructions</p>
      </div>
      <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
        <button onClick={() => setLanguage('en')} className={`text-sm font-semibold px-5 py-2 rounded-full transition-all ${language==='en' ? 'bg-amber-500 text-black' : 'text-white/50'}`}>English</button>
        <button onClick={() => setLanguage('hi')} className={`text-sm font-semibold px-5 py-2 rounded-full transition-all ${language==='hi' ? 'bg-amber-500 text-black' : 'text-white/50'}`}>हिंदी</button>
      </div>
      <button onClick={handleStart} className="w-full max-w-xs py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-base shadow-xl shadow-amber-500/30 active:scale-95 transition-transform">
        {language === 'hi' ? 'शुरू करें — कैमरा खोलें' : 'Start — Open Camera'}
      </button>
      <p className="text-white/25 text-[11px] text-center">Voice guidance in {language === 'hi' ? 'Hindi' : 'English'}<br/>Make sure volume is on</p>
    </div>
  )

  if (status === 'error') return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-4 px-6">
      <AlertTriangle className="w-10 h-10 text-brand-300" />
      <p className="text-white text-sm text-center">{errorMsg}</p>
      <button onClick={() => navigate('/capture')} className="btn-primary text-sm px-6">Use Manual Capture <ArrowRight className="w-4 h-4" /></button>
    </div>
  )

  if (status === 'auth') {
    const hi = language === 'hi'

    if (authPhase === 'analyzing') return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-white/70 text-sm">{hi ? 'प्रामाणिकता जांच हो रही है…' : 'Checking authenticity…'}</p>
      </div>
    )

    if (authPhase === 'results') {
      const r = authResult
      const score = r?.combined_score ?? 0
      const scoreColor = score >= 70 ? 'text-emerald-400' : score >= 45 ? 'text-amber-400' : 'text-red-400'
      const barColor   = score >= 70 ? 'bg-emerald-400' : score >= 45 ? 'bg-amber-400' : 'bg-red-400'
      return (
        <div className="fixed inset-0 bg-black flex flex-col overflow-y-auto">
          <div className="flex-1 flex flex-col items-center justify-center px-5 py-8 gap-5">
            <p className="text-white font-bold text-lg">{hi ? 'प्रामाणिकता परिणाम' : 'Authenticity Result'}</p>

            {/* Score ring */}
            <div className="flex flex-col items-center gap-1">
              <span className={`text-6xl font-black ${scoreColor}`}>{score}</span>
              <span className="text-white/40 text-xs">/ 100</span>
              <div className="w-48 bg-white/10 rounded-full h-2 mt-1">
                <div className={`h-2 rounded-full transition-all ${barColor}`} style={{ width: `${score}%` }} />
              </div>
            </div>

            {/* Verdict */}
            {r && (
              <div className={`px-5 py-2.5 rounded-full border font-semibold text-sm ${score >= 70 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : score >= 45 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-red-500/40 bg-red-500/10 text-red-300'}`}>
                {r.verdict}
              </div>
            )}

            {/* Score breakdown */}
            {r && (
              <div className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between text-xs text-white/60">
                  <span>{hi ? 'वीडियो स्कोर' : 'Video score'}</span>
                  <span className="font-semibold text-white">{r.video_score}/100</span>
                </div>
                <div className="flex justify-between text-xs text-white/60">
                  <span>{hi ? 'ऑडियो स्कोर' : 'Audio score'}</span>
                  <span className="font-semibold text-white">
                    {tapResult ? `${tapResult.score}%` : r.audio_score > 0 ? `${r.audio_score}/100` : '—'}
                  </span>
                </div>
                {r.purity_estimate && (
                  <div className="flex justify-between text-xs text-white/60">
                    <span>{hi ? 'शुद्धता अनुमान' : 'Purity estimate'}</span>
                    <span className="font-semibold text-amber-300">{r.purity_estimate}</span>
                  </div>
                )}
              </div>
            )}

            {/* Video signals */}
            {r && r.video_signals.length > 0 && (
              <div className="w-full">
                <p className="text-white/40 text-[10px] uppercase tracking-wide mb-2">{hi ? 'दृश्य संकेत' : 'Visual signals'}</p>
                <div className="space-y-1.5">
                  {r.video_signals.map((sig, i) => (
                    <div key={i} className="flex items-start gap-2 bg-white/5 rounded-xl px-3 py-2">
                      <span className="text-amber-400 text-xs mt-0.5">•</span>
                      <span className="text-white/70 text-xs leading-snug">{sig}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tap test result if available */}
            {tapResult && (
              <div className="w-full">
                <p className="text-white/40 text-[10px] uppercase tracking-wide mb-2">{hi ? 'ध्वनि संकेत' : 'Sound signals'}</p>
                <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                  <div className="flex justify-between items-center">
                    <span className="text-white/70 text-xs">{tapResult.label}</span>
                    <span className={`font-bold text-sm ${tapResult.score>=72?'text-emerald-400':tapResult.score>=52?'text-amber-400':'text-red-400'}`}>{tapResult.score}%</span>
                  </div>
                  <p className="text-white/40 text-[10px] mt-0.5">decay {tapResult.decay_ms.toFixed(0)}ms · {tapResult.dominant_freq_hz.toFixed(0)}Hz</p>
                </div>
              </div>
            )}

            {/* Guidance */}
            {r?.guidance && (
              <p className="text-white/50 text-[12px] text-center leading-relaxed">{r.guidance}</p>
            )}

            <button
              onClick={() => { setStatus('done'); setTimeout(() => navigate('/processing'), 400) }}
              className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-base shadow-xl shadow-amber-500/30 active:scale-95 transition-transform"
            >
              {hi ? 'विश्लेषण जारी रखें →' : 'Continue to Analysis →'}
            </button>
          </div>
        </div>
      )
    }

    const phaseTitle =
      authPhase === 'ready' ? (hi ? 'अंतिम जांच के लिए तैयार?' : 'Ready for final check?') :
      authPhase === 'video' ? (hi ? '5 सेकंड वीडियो' : '5-second rotation video') :
      authPhase === 'buffer' ? (hi ? 'सतह पर रखें' : 'Place on hard surface') :
      authPhase === 'audio' ? (hi ? '10 सेकंड टैप टेस्ट' : '10-second tap test') :
      (hi ? 'प्रामाणिकता जांच' : 'Authenticity Check')

    const phaseCopy =
      authPhase === 'ready'
        ? (hi ? 'पहले गहने को कैमरे के सामने घुमाएं, फिर सख्त सतह पर टैप करें।' : 'First rotate the ornament for video, then tap it on a fixed hard surface.')
      : authPhase === 'video'
        ? (hi ? 'गहने को धीरे-धीरे घुमाएं।' : 'Slowly rotate the ornament.')
      : authPhase === 'buffer'
        ? (hi ? 'गहने को टेबल जैसी सख्त सतह पर रखें।' : 'Put the ornament on a table or another fixed hard surface.')
      : authPhase === 'audio'
        ? (hi ? 'माइक के पास हल्के, साफ टैप करें।' : 'Tap lightly and clearly near the microphone.')
      : ''

    return (
      <div className="fixed inset-0 bg-black overflow-hidden">
        <video ref={bindVideoElement} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />

        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent px-5 pt-10 pb-6 z-10">
          <button
            onClick={() => flipCamera(true)}
            className="absolute right-4 top-9 w-10 h-10 rounded-full bg-black/45 border border-white/10 text-white/75 flex items-center justify-center backdrop-blur-sm"
            aria-label="Flip camera"
          >
            <SwitchCamera className="w-4 h-4" />
          </button>
          <p className="text-white font-bold text-base text-center">
            {phaseTitle}
          </p>
          <p className="text-white/50 text-xs text-center mt-1">
            {phaseCopy}
          </p>
        </div>

        {zoomSupported && (
          <div className="absolute top-24 left-4 right-4 z-10 bg-black border border-red-600/50 rounded-2xl px-5 py-4 backdrop-blur-md shadow-2xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-white/70 uppercase tracking-widest font-bold">Zoom</span>
              <span className="text-lg text-red-500 font-black">{zoom.toFixed(1)}×</span>
            </div>
            <input
              type="range"
              min={zoomMin}
              max={zoomMax}
              step="0.1"
              value={zoom}
              onChange={e => applyZoom(Number(e.target.value))}
              className="w-full accent-red-600"
            />
          </div>
        )}

        {authPhase === 'ready' && (
          <div className="absolute inset-x-4 bottom-10 z-20 bg-black/72 border border-white/10 rounded-3xl p-4 backdrop-blur-md">
            <div className="grid grid-cols-2 gap-2 mb-4">
              <div className="rounded-2xl bg-white/8 px-3 py-3">
                <p className="text-amber-300 text-[11px] font-bold mb-1">1. Video</p>
                <p className="text-white/70 text-xs">{hi ? '5 सेकंड धीमी रोटेशन' : '5s slow rotation'}</p>
              </div>
              <div className="rounded-2xl bg-white/8 px-3 py-3">
                <p className="text-amber-300 text-[11px] font-bold mb-1">2. Sound</p>
                <p className="text-white/70 text-xs">{hi ? '10 सेकंड सतह पर टैप' : '10s fixed-surface tap'}</p>
              </div>
            </div>
            <button
              onClick={beginAuthEvaluation}
              className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-base shadow-xl shadow-amber-500/30 active:scale-95 transition-transform"
            >
              {hi ? 'मैं तैयार हूं — शुरू करें' : 'I am ready — Start'}
            </button>
          </div>
        )}

        {/* Auth progress */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-5 pb-10 pt-8 z-10">
          {authPhase !== 'ready' && (
            <>
              <div className="flex justify-center gap-3 mb-4">
                {authPhase === 'video' ? Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={`w-3 h-3 rounded-full transition-all duration-300 ${i < authFrameCount ? 'bg-amber-400 scale-110' : i === authFrameCount ? 'bg-amber-400/40 animate-pulse' : 'bg-white/15'}`}
                  />
                )) : (
                  <div className="w-20 h-20 rounded-full border-2 border-amber-400/30 flex items-center justify-center bg-black/40">
                    <span className="text-amber-300 text-2xl font-black">{authSecondsLeft}</span>
                  </div>
                )}
              </div>
              <p className="text-white/70 text-xs text-center font-semibold">{phaseTitle}</p>
              <p className="text-white/40 text-[11px] text-center mt-1">
                {authPhase === 'video'
                  ? (hi ? `${authFrameCount}/6 फ्रेम` : `${authFrameCount}/6 frames`)
                  : authPhase === 'audio'
                    ? (hi ? `${authAudioReady ? 'आवाज़ रिकॉर्ड हो रही है' : 'माइक उपलब्ध नहीं'}` : `${authAudioReady ? 'Recording sound' : 'Microphone unavailable'}`)
                    : phaseCopy}
              </p>
            </>
          )}
        </div>

        {/* Rotation guide ring */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-52 h-52 rounded-full border-2 border-dashed border-amber-400/30 animate-spin" style={{ animationDuration: '8s' }} />
          <div className="absolute w-44 h-44 rounded-full border border-amber-400/15" />
        </div>
      </div>
    )
  }

  if (status === 'done') return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-4">
      <div className="w-20 h-20 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center">
        <CheckCircle className="w-10 h-10 text-emerald-400" />
      </div>
      <p className="text-white font-semibold text-lg">{language === 'hi' ? 'विश्लेषण हो रहा है…' : 'Analyzing your gold…'}</p>
    </div>
  )

  const currentAngle = ANGLES[Math.min(capturedCount, ANGLES.length-1)]

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {status === 'loading' && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3 z-20">
          <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-white/60 text-sm">Starting camera…</p>
        </div>
      )}

      <video ref={bindVideoElement} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {/* Circular lens aperture frame */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative w-96 h-96">
          {/* Outer black ring */}
          <div className="absolute inset-0 rounded-full border-8 border-black shadow-2xl shadow-black/80" />
          {/* Middle gray ring */}
          <div className="absolute inset-1 rounded-full border-2 border-stone-700" />
          {/* Inner circle mask */}
          <div className="absolute inset-4 rounded-full border border-stone-600 bg-gradient-to-b from-black/20 to-transparent" />
        </div>
      </div>

      {/* Top bar */}
      <div className="absolute top-4 left-0 right-0 flex items-center justify-between px-4 z-10">
        <button onClick={() => navigate('/capture')} className="flex items-center gap-1 text-white/50 text-xs bg-black/40 px-2.5 py-1.5 rounded-full backdrop-blur-sm">
          <X className="w-3 h-3" /> Manual
        </button>
        <button
          onClick={() => applyTorch(!torchOn)}
          className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${torchOn ? 'bg-amber-400 text-black shadow-lg shadow-amber-400/40' : torchSupported ? 'bg-white/15 text-white/70' : 'bg-white/8 text-white/25'}`}
        >
          {torchOn ? <Zap className="w-4 h-4 fill-current" /> : <ZapOff className="w-4 h-4" />}
        </button>
        <button
          onClick={() => flipCamera(false)}
          className="w-9 h-9 rounded-full bg-white/15 text-white/75 flex items-center justify-center backdrop-blur-sm"
          aria-label="Flip camera"
        >
          <SwitchCamera className="w-4 h-4" />
        </button>
        <div className="flex items-center bg-black/40 backdrop-blur-sm rounded-full p-1">
          <button onClick={() => setLanguage('en')} className={`text-[11px] font-semibold px-3 py-1 rounded-full transition-all ${language==='en' ? 'bg-amber-500 text-black' : 'text-white/50'}`}>EN</button>
          <button onClick={() => setLanguage('hi')} className={`text-[11px] font-semibold px-3 py-1 rounded-full transition-all ${language==='hi' ? 'bg-amber-500 text-black' : 'text-white/50'}`}>हिं</button>
        </div>
      </div>

      {zoomSupported && (
        <div className="absolute top-16 left-4 right-4 z-10 bg-black border border-red-600/50 rounded-2xl px-5 py-4 backdrop-blur-md shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-white/70 uppercase tracking-widest font-bold">
              {currentAngle === 'macro' ? 'Zoom for hallmark' : 'Zoom'}
            </span>
            <span className="text-lg text-red-500 font-black">{zoom.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min={zoomMin}
            max={zoomMax}
            step="0.1"
            value={zoom}
            onChange={e => applyZoom(Number(e.target.value))}
            className="w-full accent-red-600"
          />
        </div>
      )}

      {/* AI guidance bubble */}
      <div className={`absolute left-3 right-3 z-10 ${currentAngle === 'macro' ? 'bottom-60' : 'bottom-20'}`}>
        <div className={`rounded-2xl px-4 py-3 backdrop-blur-md border transition-colors duration-300 ${isAnalyzing ? 'bg-amber-950/60 border-amber-500/30' : 'bg-black/65 border-white/10'}`}>
          <div className="flex items-start gap-2.5">
            <div className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-black mt-0.5 transition-colors ${isAnalyzing ? 'bg-amber-500 text-black animate-pulse' : 'bg-amber-600 text-white'}`}>
              {isAnalyzing ? '…' : 'AI'}
            </div>
            <div className="min-w-0 flex-1">
              {observedItem && (
                <p className="text-amber-300/85 text-[10px] font-semibold mb-0.5 truncate">
                  Seeing: {observedItem}
                </p>
              )}
              <p className="text-white/90 text-[13px] leading-snug">{guidance || INTRO[language][currentAngle]}</p>
            </div>
          </div>
        </div>
      </div>

      {currentAngle === 'macro' && (
        <div className="absolute bottom-4 left-3 right-3 z-20 bg-stone-950/92 border border-amber-500/20 rounded-3xl p-4 backdrop-blur-md shadow-2xl">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-white font-bold text-sm">
                {language === 'hi' ? 'हॉलमार्क / शुद्धता' : 'Hallmark / purity'}
              </p>
              <p className="text-white/50 text-[11px] mt-0.5">
                {language === 'hi'
                  ? 'मार्क साफ नहीं दिख रहा तो शुद्धता चुनें।'
                  : 'If the mark is not readable, choose purity here.'}
              </p>
            </div>
            {purityPrediction && (
              <button
                onClick={() => completeMacroWithPurity(purityPrediction.hint)}
                className="shrink-0 rounded-full bg-amber-500/15 border border-amber-400/25 px-3 py-1.5 text-[11px] font-bold text-amber-200"
              >
                AI: {purityPrediction.hint}
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            {['24K','22K','18K'].map(p => (
              <button
                key={p}
                onClick={() => completeMacroWithPurity(p)}
                className="py-3 rounded-2xl bg-white/8 border border-white/10 text-white font-black text-sm active:scale-[0.98]"
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              placeholder={language === 'hi' ? 'अन्य, जैसे 20K' : 'Other, e.g. 20K'}
              value={manualPurity}
              onChange={e => { setManualPurity(e.target.value); setSelectedPurity('') }}
              className="min-w-0 flex-1 bg-white/8 border border-white/10 rounded-2xl px-3 py-3 text-white text-sm placeholder-white/35 focus:outline-none focus:border-amber-500"
            />
            <button
              onClick={() => completeMacroWithPurity(manualPurity)}
              disabled={!purityToKarat(manualPurity)}
              className="rounded-2xl bg-amber-500 px-4 py-3 text-black font-bold text-sm disabled:opacity-40"
            >
              {language === 'hi' ? 'आगे' : 'Next'}
            </button>
          </div>

          <button
            onClick={() => completeMacroWithPurity('')}
            className="w-full mt-3 py-2 text-white/40 text-xs"
          >
            {language === 'hi' ? 'हॉलमार्क नहीं दिख रहा — आगे बढ़ें' : 'Hallmark not visible — continue'}
          </button>
        </div>
      )}

      {/* Tap test button + result */}
      {currentAngle !== 'macro' && (
      <div className="absolute bottom-4 left-3 right-3 z-10 flex items-center gap-2">
        <button
          onClick={() => { setShowTapPanel(v => !v) }}
          className="flex items-center gap-1.5 bg-black/50 border border-white/10 rounded-full px-3 py-1.5 text-[11px] text-white/60 backdrop-blur-sm"
        >
          <Mic className="w-3 h-3" /> Sound Test
        </button>
        {tapResult && (
          <div className={`flex-1 flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold ${tapResult.score >= 72 ? 'bg-emerald-900/60 text-emerald-300' : tapResult.score >= 52 ? 'bg-amber-900/60 text-amber-300' : 'bg-red-900/60 text-red-300'}`}>
            <span>{tapResult.score}%</span>
            <span className="truncate">{tapResult.label}</span>
          </div>
        )}
      </div>
      )}

      {/* Tap test panel */}
      {showTapPanel && currentAngle !== 'macro' && (
        <div className="absolute bottom-14 left-3 right-3 z-20 bg-stone-900/95 border border-white/10 rounded-2xl p-4 backdrop-blur-md">
          <p className="text-white font-semibold text-sm mb-1">
            {language === 'hi' ? 'सोने की आवाज़ जांच' : 'Gold Sound Authenticity Test'}
          </p>
          <p className="text-white/50 text-[11px] mb-3">
            {language === 'hi'
              ? 'गहने को किसी सख्त सतह पर टैप करें और माइक के पास रखें।'
              : 'Tap your ornament on a hard surface near the mic. Real gold has a distinctive ring.'}
          </p>
          {tapResult && (
            <div className="mb-3 bg-white/5 rounded-xl p-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-white/70 text-xs">Authenticity</span>
                <span className={`font-bold text-sm ${tapResult.score>=72?'text-emerald-400':tapResult.score>=52?'text-amber-400':'text-red-400'}`}>{tapResult.score}%</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-1.5 mb-2">
                <div className={`h-1.5 rounded-full transition-all ${tapResult.score>=72?'bg-emerald-400':tapResult.score>=52?'bg-amber-400':'bg-red-400'}`} style={{width:`${tapResult.score}%`}} />
              </div>
              <p className="text-white/60 text-[10px]">{tapResult.label} · decay {tapResult.decay_ms.toFixed(0)}ms · {tapResult.dominant_freq_hz.toFixed(0)}Hz</p>
            </div>
          )}
          <button
            onClick={() => { runTapTest(); setShowTapPanel(false) }}
            disabled={isTapTesting}
            className="w-full py-2.5 rounded-xl bg-amber-500 text-black font-bold text-sm disabled:opacity-50"
          >
            {isTapTesting ? '🎙 Recording 3s…' : language === 'hi' ? '🎙 टेस्ट शुरू करें' : '🎙 Start Recording'}
          </button>
        </div>
      )}

      {/* Purity modal — shown after macro shot */}
      {showPurityModal && (
        <div className="absolute inset-0 bg-black/85 flex items-center justify-center z-30 px-5">
          <div className="w-full bg-stone-900 border border-white/10 rounded-3xl p-6">
            <p className="text-white font-bold text-base mb-1">
              {language === 'hi' ? 'सोने की शुद्धता' : 'Gold Purity'}
            </p>
            <p className="text-white/50 text-xs mb-4">
              {language === 'hi'
                ? 'हॉलमार्क साफ न हो तो शुद्धता चुनें।'
                : 'If the hallmark is unclear, choose the purity.'}
            </p>

            {/* AI prediction */}
            {purityPrediction && (
              <button
                onClick={() => setSelectedPurity(purityPrediction.hint)}
                className={`w-full flex items-center justify-between mb-3 p-3 rounded-2xl border transition-all ${selectedPurity===purityPrediction.hint ? 'border-amber-500 bg-amber-500/10' : 'border-white/10 bg-white/5'}`}
              >
                <div className="text-left">
                  <p className="text-white text-sm font-semibold">{PURITY_LABELS[purityPrediction.hint] ?? purityPrediction.hint}</p>
                  <p className="text-white/40 text-[10px]">AI detected · {Math.round(purityPrediction.confidence * 100)}% confident</p>
                </div>
                {selectedPurity===purityPrediction.hint && <CheckCircle className="w-5 h-5 text-amber-400 flex-shrink-0" />}
              </button>
            )}

            {/* Common purity options */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {['24K','22K','18K'].map(p => (
                <button
                  key={p}
                  onClick={() => setSelectedPurity(p)}
                  className={`py-3 rounded-xl text-sm font-bold transition-all ${selectedPurity===p ? 'bg-amber-500 text-black' : 'bg-white/8 text-white/60'}`}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Manual text entry */}
            <input
              type="text"
              placeholder={language === 'hi' ? 'अन्य दर्ज करें (जैसे 20K)' : 'Enter other (e.g. 20K)'}
              value={manualPurity}
              onChange={e => { setManualPurity(e.target.value); setSelectedPurity('') }}
              className="w-full bg-white/8 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-white/30 mb-4 focus:outline-none focus:border-amber-500"
            />

            <button
              onClick={handlePurityDone}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-black font-bold text-sm"
            >
              {language === 'hi' ? 'जारी रखें →' : 'Continue →'}
            </button>
            <button
              onClick={() => { setShowPurityModal(false); handlePurityDone() }}
              className="w-full mt-2 py-2 text-white/30 text-xs"
            >
              {language === 'hi' ? 'छोड़ें' : 'Skip'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
