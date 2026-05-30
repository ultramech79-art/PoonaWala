import { Suspense, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Spline from '@splinetool/react-spline'
import { Loader2, Zap, Shield, Clock, Home as HomeIcon, ArrowRight, UserRound } from 'lucide-react'
import { useSessionStore } from '../store/session'
import i18n from '../i18n'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'

const FeatureCarousel = ({ currentIndex, lang }: { currentIndex: number; lang: string }) => {
  const features = [
    {
      icon: Clock,
      title: lang === 'hi' ? '60 सेकंड में' : '< 60 Seconds',
      desc: lang === 'hi' ? 'तत्काल पूर्व योग्यता' : 'Instant Pre-qualification',
      color: 'from-orange-400 to-amber-500'
    },
    {
      icon: HomeIcon,
      title: lang === 'hi' ? 'घर से शुरू करें' : 'From Home',
      desc: lang === 'hi' ? 'कोई शाखा यात्रा नहीं' : 'No Branch Visit',
      color: 'from-emerald-400 to-teal-500'
    },
    {
      icon: Zap,
      title: lang === 'hi' ? 'तत्काल लोन' : 'Instant Loan',
      desc: lang === 'hi' ? '60 सेकंड में मंजूरी' : 'Approval in 60s',
      color: 'from-amber-500 to-amber-600'
    },
    {
      icon: Shield,
      title: lang === 'hi' ? 'सुरक्षित एवं सरल' : 'Safe & Simple',
      desc: lang === 'hi' ? 'कोई छिपा हुआ शुल्क नहीं' : 'No Hidden Charges',
      color: 'from-stone-600 to-stone-800'
    }
  ]

  const feature = features[currentIndex % features.length]
  const Icon = feature.icon

  return (
    <div className="relative h-24 flex items-center justify-center">
      <div className="absolute inset-0 flex items-center justify-center opacity-0 animate-fade-out" />
      <div className={`text-center animate-fade-in`}>
        <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feature.color} flex items-center justify-center mx-auto mb-2`}>
          <Icon className="w-6 h-6 text-white" strokeWidth={2} />
        </div>
        <p className="font-display font-bold text-sm text-stone-900">{feature.title}</p>
        <p className="text-xs text-stone-600">{feature.desc}</p>
      </div>
    </div>
  )
}

export function Home() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setLang, state } = useSessionStore()
  const [loading, setLoading] = useState(true)
  const [featureIndex, setFeatureIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFeatureIndex(prev => prev + 1)
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  const handleLanguageChange = (lang: string) => {
    setLang(lang)
    i18n.changeLanguage(lang)
  }

  const handleGetStarted = () => {
    navigate('/language')
  }

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30 overflow-hidden flex flex-col font-sans">
      {/* Premium Header with Poonawala Branding */}
      <div className="relative z-30 px-6 py-4 bg-gradient-to-r from-white/80 via-white to-white/80 backdrop-blur-md">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/assets/poonawala-logo.png" alt="Poonawala" className="w-8 h-8" />
            <p className="text-xs font-display font-bold text-stone-900">Poonawalla</p>
          </div>
          {state.authToken && (
            <button onClick={() => navigate('/profile', { state: { from: '/' } })} className="w-9 h-9 rounded-full bg-white border border-stone-200 flex items-center justify-center shadow-sm">
              <UserRound className="w-4 h-4 text-stone-600" />
            </button>
          )}
        </div>
      </div>

      {/* Premium gradient overlays */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
        {/* Radial glow behind ring */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-gradient-to-br from-brand-400/15 via-amber-400/10 to-transparent blur-3xl" />
        {/* Left accent */}
        <div className="absolute top-20 left-0 w-64 h-64 rounded-full bg-gradient-to-r from-blue-300/5 to-transparent blur-3xl" />
        {/* Right accent */}
        <div className="absolute top-1/3 right-0 w-80 h-80 rounded-full bg-gradient-to-l from-amber-300/5 to-transparent blur-3xl" />
      </div>

      {/* Spline Ring - Hero Element (60% height) */}
      <div className="absolute inset-0 z-0 h-[60%] mt-0 flex items-center justify-center">
        <Suspense fallback={
          <div className="w-full h-full flex items-center justify-center bg-transparent">
            <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
          </div>
        }>
          <div className="animate-ring w-full h-full flex items-center justify-center">
            <Spline
              scene="/assets/demo/one_ring.spline"
              onLoad={() => setLoading(false)}
              className="w-full h-full"
            />
          </div>
        </Suspense>
      </div>

      {/* Language Selector Overlay */}
      <div className="absolute top-16 right-5 z-20 flex gap-2 animate-fade-in" style={{ animationDelay: '0.3s' }}>
        <button
          onClick={() => handleLanguageChange('en')}
          className={clsx(
            'px-4 py-1.5 rounded-full text-[10px] font-black tracking-widest transition-all border whitespace-nowrap',
            state.lang === 'en'
              ? 'bg-brand-600 text-white border-brand-600 shadow-md'
              : 'bg-white/90 backdrop-blur-md text-stone-900 border-stone-100 hover:bg-white'
          )}
        >
          EN
        </button>
        <button
          onClick={() => handleLanguageChange('hi')}
          className={clsx(
            'px-4 py-1.5 rounded-full text-[10px] font-black tracking-widest transition-all border whitespace-nowrap',
            state.lang === 'hi'
              ? 'bg-brand-600 text-white border-brand-600 shadow-md'
              : 'bg-white/90 backdrop-blur-md text-stone-900 border-stone-100 hover:bg-white'
          )}
        >
          हिन्दी
        </button>
      </div>

      {/* Content Spacer */}
      <div className="flex-1" />

      {/* Minimal Bottom Card with Gradient */}
      <div className="relative z-10 px-6 pb-10 pt-6 bg-gradient-to-b from-white/90 via-white/85 to-white/80 backdrop-blur-3xl rounded-t-[3.5rem] shadow-[0_-20px_80px_rgba(146,64,14,0.12)] border-t border-white/30 animate-slide-up">
        {/* Feature Carousel - Compact */}
        <div className="mb-4 animate-fade-in" style={{ animationDelay: '0.2s' }}>
          <FeatureCarousel currentIndex={featureIndex} lang={state.lang} />
          {/* Progress Dots */}
          <div className="flex justify-center gap-1 mt-3">
            {[0, 1, 2, 3].map(i => (
              <div
                key={i}
                className={clsx(
                  'rounded-full transition-all duration-500',
                  featureIndex % 4 === i
                    ? 'w-5 h-1.5 bg-brand-600'
                    : 'w-1.5 h-1.5 bg-stone-300'
                )}
              />
            ))}
          </div>
        </div>

        <div className="max-w-xs mx-auto text-center">
          {/* GoldEye Title - Premium Gradient */}
          <h1
            className="font-display font-black text-3xl bg-gradient-to-r from-amber-950 via-brand-600 to-amber-600 bg-clip-text text-transparent leading-tight mb-0.5 tracking-tight animate-fade-in"
            style={{ animationDelay: '0.4s' }}
          >
            {state.lang === 'hi' ? 'गोल्ड आई' : 'GoldEye'}
          </h1>

          <p
            className="text-transparent bg-gradient-to-r from-stone-600 to-stone-500 bg-clip-text text-xs font-medium leading-snug mb-7 px-2 animate-fade-in"
            style={{ animationDelay: '0.5s' }}
          >
            {state.lang === 'hi'
              ? 'एआई मूल्यांकन • तत्काल ऋण'
              : 'AI Assessment • Instant Loans'}
          </p>

          <div className="w-full flex justify-center animate-fade-in" style={{ animationDelay: '0.6s' }}>
            <button
              onClick={handleGetStarted}
              className="px-10 py-3.5 rounded-full bg-gradient-to-r from-brand-700 via-brand-600 to-amber-600 hover:from-brand-800 hover:via-brand-700 hover:to-amber-700 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-lg shadow-brand-600/30 hover:shadow-2xl hover:shadow-brand-600/40 transition-all active:scale-95 border border-brand-500/40 backdrop-blur-sm"
            >
              {state.lang === 'hi' ? 'शुरू करें' : 'Get Started'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          {!state.authToken && (
            <button
              onClick={() => navigate('/auth?mode=login')}
              className="mt-3 text-sm font-bold text-brand-700 underline underline-offset-4"
            >
              {state.lang === 'hi' ? 'लॉगिन करें' : 'Login'}
            </button>
          )}

          <p
            className="mt-5 text-[8px] font-bold bg-gradient-to-r from-stone-400 to-stone-500 bg-clip-text text-transparent uppercase tracking-[0.15em] opacity-70 animate-fade-in"
            style={{ animationDelay: '0.7s' }}
          >
            Poonawalla Fincorp
          </p>
        </div>
      </div>
    </div>
  )
}
