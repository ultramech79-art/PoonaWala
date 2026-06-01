import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, PlayCircle } from 'lucide-react'
import { speak, stopSpeech } from '../lib/tts'

interface Props {
  stepType: string        // 'top' | '45deg' | 'side' | 'macro' | 'selfie'
  title?: string
  hint?: string
  buttonText?: string
  onDismiss: () => void
}

export function TutorialOverlay({ stepType, title, hint, buttonText, onDismiss }: Props) {
  const { t, i18n } = useTranslation()
  const videoRef   = useRef<HTMLVideoElement>(null)
  const [videoError, setVideoError] = useState(false)

  const isPortraitVideo = ['45deg', 'certificate', 'macro', 'selfie'].includes(stepType)
  const videoSrc = `/assets/tutorial/${stepType}.mp4`

  const labelText = title || t(`tut_label_${stepType}`, { defaultValue: stepType })
  const hintText = hint || t(`tut_hint_${stepType}`, { defaultValue: '' })

  // Speak hint once in the active language; auto-dismiss when TTS ends
  useEffect(() => {
    speak(hintText, i18n.language, onDismiss)
    return () => stopSpeech()
  }, [stepType, hintText, i18n.language, onDismiss])

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-stone-900/40 backdrop-blur-xl">
      <div className="w-full max-w-md bg-white/95 backdrop-blur-2xl rounded-t-[32px] shadow-[0_-8px_40px_rgba(0,0,0,0.12)] border-t border-white/50 overflow-hidden pb-safe relative">
        {/* Pull handle */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1.5 bg-stone-300/60 rounded-full" />
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-8 pb-4">
          <div>
            <p className="text-[10px] text-brand-600 uppercase tracking-widest font-bold mb-0.5">{t('tutorial')}</p>
            <p className="text-xl font-bold text-stone-900 tracking-tight leading-tight">{labelText}</p>
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
                {t('tutorial_video_soon')}
              </p>
            </div>
          )}
        </div>
        </div>

        {/* Hint text */}
        <div className="px-6 pt-5 pb-3">
          <p className="text-sm font-medium text-stone-600 leading-relaxed">{hintText}</p>
        </div>

        {/* Actions */}
        <div className="px-6 pt-2 pb-6 flex gap-3">
          <button
            onClick={onDismiss}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-[20px] bg-stone-900 text-white font-semibold text-sm active:scale-[0.97] transition-all shadow-xl shadow-stone-900/20 hover:bg-stone-800"
          >
            {buttonText || t('got_it')}
          </button>
        </div>
      </div>
    </div>
  )
}
