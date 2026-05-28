import { useEffect, useRef, useState } from 'react'
import { X, SkipForward, PlayCircle } from 'lucide-react'

interface Props {
  stepType: string        // 'top' | '45deg' | 'side' | 'macro' | 'selfie'
  onDismiss: () => void
}

const TUTORIAL_LABELS: Record<string, string> = {
  top:    'Top-Down Shot',
  '45deg': '45° Angle Shot',
  side:   'Side Profile Shot',
  macro:  'Hallmark Close-Up',
  selfie: 'Selfie with Gold',
}

const TUTORIAL_HINTS: Record<string, string> = {
  top:    'Hold your gold jewelry flat on a surface. Point the camera straight down from above.',
  '45deg': 'Tilt the camera to a 45° angle so you can see both the top surface and the depth of the piece.',
  side:   'Hold the camera at table-height, level with the edge of the gold, to show its thickness.',
  macro:  'Get very close to the BIS hallmark or purity stamp. The text should fill the frame.',
  selfie: 'Hold the gold piece beside your face. Both your face and the gold must be visible.',
}

export function TutorialOverlay({ stepType, onDismiss }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoError, setVideoError] = useState(false)
  const [autoTimer, setAutoTimer] = useState(4)

  // Placeholder video path — replace with real tutorial videos when ready
  const videoSrc = `/assets/tutorial/${stepType}.mp4`

  // Auto-dismiss after 4 seconds (or when video ends)
  useEffect(() => {
    const iv = setInterval(() => {
      setAutoTimer(t => {
        if (t <= 1) { clearInterval(iv); onDismiss(); return 0 }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(iv)
  }, [onDismiss])

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-stone-900/75 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md bg-white rounded-t-3xl shadow-2xl overflow-hidden animate-slide-up pb-safe">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <p className="text-[10px] text-stone-400 uppercase tracking-widest font-semibold">Tutorial</p>
            <p className="text-base font-bold text-stone-900 leading-tight">{TUTORIAL_LABELS[stepType] ?? stepType}</p>
          </div>
          <button
            onClick={onDismiss}
            className="w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center text-stone-500 hover:bg-stone-200 transition-colors"
            aria-label="Close tutorial"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Video or placeholder */}
        <div className="mx-5 rounded-2xl overflow-hidden bg-stone-900 aspect-video flex items-center justify-center relative">
          {!videoError ? (
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full object-cover"
              autoPlay
              muted
              playsInline
              loop={false}
              onEnded={onDismiss}
              onError={() => setVideoError(true)}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 px-4 text-center">
              <PlayCircle className="w-12 h-12 text-amber-400/60" />
              <p className="text-white/50 text-xs leading-relaxed">
                Tutorial video coming soon.<br />Follow the hint below.
              </p>
            </div>
          )}

          {/* Auto-dismiss countdown pill */}
          {autoTimer > 0 && (
            <div className="absolute bottom-3 right-3 bg-black/60 rounded-full px-2.5 py-1 text-white/70 text-[11px] font-semibold tabular-nums">
              {autoTimer}s
            </div>
          )}
        </div>

        {/* Hint text */}
        <div className="px-5 pt-3 pb-2">
          <p className="text-sm text-stone-600 leading-relaxed">{TUTORIAL_HINTS[stepType]}</p>
        </div>

        {/* Actions */}
        <div className="px-5 pt-2 pb-6 flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-amber-500 text-white font-bold text-sm active:scale-95 transition-transform shadow-lg shadow-amber-500/30"
          >
            <SkipForward className="w-4 h-4" />
            Got it — Start Capture
          </button>
        </div>
      </div>
    </div>
  )
}
