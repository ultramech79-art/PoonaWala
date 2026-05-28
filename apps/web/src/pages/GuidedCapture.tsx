import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import {
  startGuidedSession, pollProgress, endGuidedSession,
  ANGLE_LABELS, ANGLE_ICONS,
  type GuidedSessionInfo, type SessionProgress,
} from '../lib/guidedSession'
import {
  Mic, MicOff, Video, VideoOff, Loader, CheckCircle,
  AlertTriangle, ChevronRight, ArrowRight, X,
} from 'lucide-react'
import { clsx } from 'clsx'

const ANGLES = ['top', '45deg', 'side', 'macro', 'selfie']
const POLL_INTERVAL_MS = 2000

export function GuidedCapture() {
  const navigate = useNavigate()
  const { state } = useSessionStore()
  const callRef  = useRef<any>(null)      // Daily call object
  const videoRef = useRef<HTMLVideoElement>(null)

  const [sessionInfo, setSessionInfo]     = useState<GuidedSessionInfo | null>(null)
  const [progress, setProgress]           = useState<SessionProgress | null>(null)
  const [status, setStatus]               = useState<'loading' | 'joining' | 'active' | 'done' | 'error'>('loading')
  const [errorMsg, setErrorMsg]           = useState('')
  const [micOn, setMicOn]                 = useState(true)
  const [camOn, setCamOn]                 = useState(true)
  const [guidanceText, setGuidanceText]   = useState('Starting your guided session…')
  const [guidanceNew, setGuidanceNew]     = useState(false)   // flash animation
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Init session ────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true

    async function init() {
      try {
        const info = await startGuidedSession(state.sessionId ?? undefined)
        if (!mounted) return
        setSessionInfo(info)
        setStatus('joining')
        await joinDailyRoom(info)
      } catch (e: any) {
        if (!mounted) return
        setErrorMsg(e.message ?? 'Could not start guided session')
        setStatus('error')
      }
    }

    init()
    return () => { mounted = false }
  }, [])

  // ── Join Daily room ─────────────────────────────────────────────────────────
  const joinDailyRoom = useCallback(async (info: GuidedSessionInfo) => {
    try {
      // Dynamically import Daily to keep bundle lean
      const DailyIframe = (await import('@daily-co/daily-js')).default
      const call = DailyIframe.createCallObject({
        url: info.room_url,
        token: info.user_token,
        audioSource: true,
        videoSource: true,
      })
      callRef.current = call

      call.on('track-started', (event: any) => {
        if (event.participant?.local) return
        // Attach AI agent audio (agent speaks back to user)
        if (event.track?.kind === 'audio') {
          const audioEl = new Audio()
          audioEl.srcObject = new MediaStream([event.track])
          audioEl.play().catch(() => {})
        }
      })

      call.on('app-message', (event: any) => {
        // GoldEye agent can send text guidance via app-message
        const msg = event?.data?.text
        if (msg) {
          setGuidanceText(msg)
          setGuidanceNew(true)
          setTimeout(() => setGuidanceNew(false), 600)
        }
      })

      call.on('error', (e: any) => {
        setErrorMsg(e?.errorMsg ?? 'Video call error')
        setStatus('error')
      })

      await call.join({ url: info.room_url, token: info.user_token })

      // Show local camera preview
      const localVideo = call.participants()?.local?.videoTrack
      if (localVideo && videoRef.current) {
        videoRef.current.srcObject = new MediaStream([localVideo])
        videoRef.current.play().catch(() => {})
      }

      setStatus('active')
      startPolling(info.session_id)
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Failed to join video room')
      setStatus('error')
    }
  }, [])

  // ── Poll progress ───────────────────────────────────────────────────────────
  const startPolling = useCallback((sessionId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const p = await pollProgress(sessionId)
        setProgress(p)
        if (p.all_done) {
          clearInterval(pollRef.current!)
          setStatus('done')
          setGuidanceText('All angles captured! Analyzing your gold now…')
          setTimeout(() => navigate('/processing'), 3000)
        }
      } catch {
        // session ended on server — ignore
      }
    }, POLL_INTERVAL_MS)
  }, [navigate])

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(pollRef.current!)
      if (callRef.current) {
        callRef.current.leave().catch(() => {})
        callRef.current.destroy().catch(() => {})
      }
      if (sessionInfo?.session_id) {
        endGuidedSession(sessionInfo.session_id).catch(() => {})
      }
    }
  }, [sessionInfo])

  // ── Mic / cam toggles ───────────────────────────────────────────────────────
  const toggleMic = () => {
    if (!callRef.current) return
    micOn ? callRef.current.setLocalAudio(false) : callRef.current.setLocalAudio(true)
    setMicOn(v => !v)
  }
  const toggleCam = () => {
    if (!callRef.current) return
    camOn ? callRef.current.setLocalVideo(false) : callRef.current.setLocalVideo(true)
    setCamOn(v => !v)
  }

  // ── Skip to manual ──────────────────────────────────────────────────────────
  const handleSkip = async () => {
    clearInterval(pollRef.current!)
    if (callRef.current) {
      await callRef.current.leave().catch(() => {})
      await callRef.current.destroy().catch(() => {})
    }
    if (sessionInfo?.session_id) {
      await endGuidedSession(sessionInfo.session_id).catch(() => {})
    }
    navigate('/capture')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="page bg-black flex flex-col overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-safe pt-3 pb-2 z-10">
        <button onClick={handleSkip} className="text-white/60 flex items-center gap-1 text-xs">
          <X className="w-4 h-4" /> Manual
        </button>
        <div className="flex items-center gap-1.5">
          <div className={clsx(
            'w-2 h-2 rounded-full',
            status === 'active' ? 'bg-emerald-400 animate-pulse' :
            status === 'error'  ? 'bg-red-400' : 'bg-stone-500',
          )} />
          <span className="text-xs text-white/70">
            {status === 'loading' ? 'Starting…' :
             status === 'joining' ? 'Connecting…' :
             status === 'active'  ? 'GoldEye Live' :
             status === 'done'    ? 'Complete' : 'Error'}
          </span>
        </div>
        <div className="w-16" />
      </div>

      {/* Video feed */}
      <div className="flex-1 relative">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />

        {/* Loading overlay */}
        {(status === 'loading' || status === 'joining') && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3">
            <Loader className="w-8 h-8 text-brand-400 animate-spin" />
            <p className="text-white/80 text-sm">
              {status === 'loading' ? 'Creating session…' : 'Connecting to GoldEye agent…'}
            </p>
          </div>
        )}

        {/* Error overlay */}
        {status === 'error' && (
          <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-4 px-6">
            <AlertTriangle className="w-10 h-10 text-amber-400" />
            <p className="text-white text-sm text-center">{errorMsg}</p>
            <button
              onClick={() => navigate('/capture')}
              className="btn-primary text-sm px-6"
            >
              Use Manual Capture <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Done overlay */}
        {status === 'done' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3">
            <CheckCircle className="w-12 h-12 text-emerald-400" />
            <p className="text-white font-semibold">Analysis starting…</p>
          </div>
        )}

        {/* Angle progress pills — top of video */}
        {status === 'active' && (
          <div className="absolute top-3 left-0 right-0 flex justify-center gap-1.5 px-4">
            {ANGLES.map(angle => {
              const captured = progress?.captured.includes(angle)
              const isCurrent = progress?.current_angle === angle
              return (
                <div
                  key={angle}
                  className={clsx(
                    'flex items-center gap-0.5 px-2 py-1 rounded-full text-[10px] font-semibold transition-all',
                    captured
                      ? 'bg-emerald-500 text-white'
                      : isCurrent
                      ? 'bg-white text-stone-900 scale-105 shadow-md'
                      : 'bg-white/20 text-white/60',
                  )}
                >
                  {captured
                    ? <CheckCircle className="w-2.5 h-2.5" />
                    : <span>{ANGLE_ICONS[angle]}</span>
                  }
                  <span className="hidden sm:inline">{ANGLE_LABELS[angle].split(' ')[0]}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* AI guidance banner */}
      {status === 'active' && (
        <div className={clsx(
          'mx-4 mb-2 rounded-2xl bg-black/70 backdrop-blur-sm border border-white/10 px-4 py-3 transition-all',
          guidanceNew && 'border-brand-400/50 bg-brand-900/30',
        )}>
          <div className="flex items-start gap-2">
            <div className="w-6 h-6 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[9px] font-bold text-white">AI</span>
            </div>
            <p className="text-white/90 text-sm leading-relaxed">{guidanceText}</p>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between px-8 pb-safe pb-6 pt-2">
        <button
          onClick={toggleMic}
          className={clsx(
            'w-12 h-12 rounded-full flex items-center justify-center',
            micOn ? 'bg-white/20' : 'bg-red-500',
          )}
        >
          {micOn
            ? <Mic className="w-5 h-5 text-white" />
            : <MicOff className="w-5 h-5 text-white" />
          }
        </button>

        {/* Progress fraction */}
        <div className="flex flex-col items-center">
          <span className="text-white font-display font-black text-2xl">
            {progress?.captured.length ?? 0}<span className="text-white/40 text-lg">/5</span>
          </span>
          <span className="text-white/50 text-[10px]">angles</span>
        </div>

        <button
          onClick={toggleCam}
          className={clsx(
            'w-12 h-12 rounded-full flex items-center justify-center',
            camOn ? 'bg-white/20' : 'bg-red-500',
          )}
        >
          {camOn
            ? <Video className="w-5 h-5 text-white" />
            : <VideoOff className="w-5 h-5 text-white" />
          }
        </button>
      </div>

      {/* Skip to manual fallback */}
      {status === 'active' && (
        <button
          onClick={handleSkip}
          className="absolute bottom-24 right-4 text-[10px] text-white/30 flex items-center gap-1"
        >
          Switch to manual <ChevronRight className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
