import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Lottie, { type LottieRefCurrentProps } from 'lottie-react'

const WELCOME_ANIM_URL = '/assets/tutorial/welcome.json'
const TUTORIAL_KEY = 'goldeye_tutorial_seen'

export function Tutorial() {
  const navigate = useNavigate()
  const lottieRef = useRef<LottieRefCurrentProps>(null)
  const [animData, setAnimData] = useState<object | null>(null)

  useEffect(() => {
    localStorage.setItem(TUTORIAL_KEY, '1')
    fetch(WELCOME_ANIM_URL).then(r => r.json()).then(setAnimData).catch(() => {})
  }, [])

  const goToDashboard = () => navigate('/dashboard-home', { replace: true })

  return (
    <div
      className="page flex flex-col items-center justify-between"
      style={{ background: '#FEFEFE', zIndex: 5, isolation: 'isolate' }}
    >
      {/* Top label */}
      <div className="pt-14 text-center px-8">
        <p className="text-[11px] font-bold text-stone-400 tracking-[0.14em] uppercase mb-3">Welcome</p>
        <h1 className="font-display font-black text-[2.2rem] text-stone-950 leading-tight tracking-[-0.03em]">
          You're all set!
        </h1>
        <p className="text-[15px] text-stone-500 mt-3 leading-relaxed">
          Your gold loan journey starts here.
        </p>
      </div>

      {/* Lottie animation */}
      <div className="flex-1 flex items-center justify-center w-full max-w-xs px-6">
        {animData && (
          <Lottie
            lottieRef={lottieRef}
            animationData={animData}
            loop={false}
            autoplay
            onComplete={goToDashboard}
            style={{ width: '100%' }}
          />
        )}
      </div>

      {/* Skip */}
      <div className="pb-10 px-6 w-full">
        <button
          onClick={goToDashboard}
          className="w-full h-[58px] rounded-2xl bg-stone-950 text-white font-semibold text-[16px] tracking-[-0.01em] active:opacity-75 transition-opacity"
        >
          Go to Dashboard →
        </button>
        <button
          onClick={goToDashboard}
          className="w-full py-3 mt-1 text-[13px] font-medium text-stone-400"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

export function shouldShowTutorial(): boolean {
  return !localStorage.getItem(TUTORIAL_KEY)
}
