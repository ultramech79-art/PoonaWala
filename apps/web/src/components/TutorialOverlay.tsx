import { useEffect, useRef, useState } from 'react'
import { X, PlayCircle } from 'lucide-react'
import { speak, stopSpeech } from '../lib/tts'

interface Props {
  stepType: string        // 'top' | '45deg' | 'side' | 'macro' | 'selfie'
  title?: string
  hint?: string
  buttonText?: string
  onDismiss: () => void
}

const TUTORIAL_LABELS: Record<string, string> = {
  top:         'Top-Down Shot',
  '45deg':     '45° Angle Shot',
  side:        'Side Profile Shot',
  selfie:      'Selfie with Gold',
  macro:       'Hallmark Close-Up',
  video:       '15-Second Video Scan',
  audio:       'Gold Ring Sound Test',
  certificate: 'Bill & Certificate',
}

const TUTORIAL_HINTS: Record<string, string> = {
  top:         'Hold your gold jewelry flat on a surface. Point the camera straight down from above.',
  '45deg':     'Tilt the camera to a 45° angle so you can see both the top surface and the depth of the piece.',
  side:        'Hold the camera at table-height, level with the edge of the gold, to show its thickness.',
  selfie:      'Hold the gold piece beside your face. Both your face and the gold must be clearly visible.',
  macro:       'Get very close to the BIS hallmark or purity stamp. The text should fill the frame.',
  video:       'Place gold on a white surface. Slowly rotate the piece during 15 seconds — show all edges, clasps, and the hallmark area.',
  audio:       'One drop from 15–20 cm onto glass (or tap with coin edge), then leave it. The 5-second recording captures the full ring decay — keep the room quiet.',
  certificate: 'Scan the original purchase bill or authenticity certificate. Ensure the HUID and purity stamp are clearly visible.',
}

export function TutorialOverlay({ stepType, title, hint, buttonText, onDismiss }: Props) {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const [videoError, setVideoError] = useState(false)

  const isPortraitVideo = ['45deg', 'certificate', 'macro', 'selfie'].includes(stepType)
  const videoSrc = `/assets/tutorial/${stepType}.mp4`

  // Speak hint once; auto-dismiss when TTS ends
  useEffect(() => {
    const hintText = hint || TUTORIAL_HINTS[stepType] || ''
    speak(hintText, undefined, onDismiss)
    return () => stopSpeech()
  }, [stepType, hint, onDismiss])

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-stone-900/40 backdrop-blur-xl">
      <div className="w-full max-w-md bg-white/95 backdrop-blur-2xl rounded-t-[32px] shadow-[0_-8px_40px_rgba(0,0,0,0.12)] border-t border-white/50 overflow-hidden pb-safe relative">
        {/* Pull handle */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1.5 bg-stone-300/60 rounded-full" />
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-8 pb-4">
          <div>
            <p className="text-[10px] text-brand-600 uppercase tracking-widest font-bold mb-0.5">Tutorial</p>
            <p className="text-xl font-bold text-stone-900 tracking-tight leading-tight">{(title || TUTORIAL_LABELS[stepType]) ?? stepType}</p>
          </div>
          <button
            onClick={onDismiss}
            className="w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center text-stone-500 hover:bg-stone-200 active:scale-95 transition-all"
            aria-label="Close tutorial"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video or placeholder */}
        <div className="w-full px-6 flex justify-center">
          <div className={`relative rounded-[24px] overflow-hidden bg-stone-900 shadow-xl flex items-center justify-center ${isPortraitVideo ? 'aspect-[9/16] h-[48vh] sm:h-[55vh]' : 'aspect-video w-full'}`}>
            {!videoError ? (
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full object-cover"
              autoPlay
              muted
              playsInline
              loop
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
        </div>
        </div>

        {/* Hint text */}
        <div className="px-6 pt-5 pb-3">
          <p className="text-sm font-medium text-stone-600 leading-relaxed">{hint || TUTORIAL_HINTS[stepType]}</p>
        </div>

        {/* Actions */}
        <div className="px-6 pt-2 pb-6 flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-[20px] bg-stone-900 text-white font-semibold text-sm active:scale-[0.97] transition-all shadow-xl shadow-stone-900/20 hover:bg-stone-800"
          >
            {buttonText || 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}
