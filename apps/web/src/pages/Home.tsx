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
      tone: 'bg-brand-50 text-brand-700 border-brand-100'
    },
    {
      icon: HomeIcon,
      title: lang === 'hi' ? 'घर से शुरू करें' : 'From Home',
      desc: lang === 'hi' ? 'कोई शाखा यात्रा नहीं' : 'No Branch Visit',
      tone: 'bg-emerald-50 text-emerald-700 border-emerald-100'
    },
    {
      icon: Zap,
      title: lang === 'hi' ? 'तत्काल लोन' : 'Instant Loan',
      desc: lang === 'hi' ? '60 सेकंड में मंजूरी' : 'Approval in 60s',
      tone: 'bg-gold-50 text-gold-700 border-gold-100'
    },
    {
      icon: Shield,
      title: lang === 'hi' ? 'सुरक्षित एवं सरल' : 'Safe & Simple',
      desc: lang === 'hi' ? 'कोई छिपा हुआ शुल्क नहीं' : 'No Hidden Charges',
      tone: 'bg-stone-100 text-stone-700 border-stone-200'
    }
  ]

  const feature = features[currentIndex % features.length]
  const Icon = feature.icon

  return (
    <div className="relative h-[60px] flex items-center justify-center">
      <div className="text-center animate-fade-in flex items-center gap-3">
        <div className={`w-9 h-9 rounded-xl border ${feature.tone} flex items-center justify-center shadow-xs shrink-0`}>
          <Icon className="w-4 h-4" strokeWidth={2} />
        </div>
        <div className="text-left">
          <p className="font-display font-bold text-[13px] text-stone-900 leading-tight">{feature.title}</p>
          <p className="text-[11px] text-stone-500">{feature.desc}</p>
        </div>
      </div>
    </div>
  )
}

export function Home() {
  const navigate = useNavigate()
  const { setLang, setAuth, state } = useSessionStore()
  const [loading, setLoading] = useState(true)
  const [featureIndex, setFeatureIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setFeatureIndex(p => p + 1), 3500)
    return () => clearInterval(interval)
  }, [])

  const handleLanguageChange = (lang: string) => {
    setLang(lang)
    i18n.changeLanguage(lang)
  }

  const handleGetStarted = () => {
    navigate('/register')
  }

  const handleGuest = () => {
    setAuth('guest', {
      id: 0, full_name: 'Guest User', email: null, phone: null,
      region_code: 'MH', language: 'en', cibil_score: null,
      is_active: true, profile_photo_url: null,
    } as any)
    navigate('/dashboard-home')
  }

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30 overflow-hidden flex flex-col font-sans">

      {/* Ambient glow overlays — static, no animation */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-gradient-to-br from-brand-400/12 via-amber-400/8 to-transparent blur-3xl" />
        <div className="absolute top-1/3 right-0 w-80 h-80 rounded-full bg-gradient-to-l from-amber-300/5 to-transparent blur-3xl" />
      </div>

      {/* Header */}
      <div className="relative z-30 px-5 py-4 flex items-center justify-between">
        <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-14 w-auto object-contain" />
        {state.authToken && (
          <button onClick={() => navigate('/profile', { state: { from: '/' } })} className="w-9 h-9 rounded-2xl bg-white border border-stone-200 flex items-center justify-center shadow-xs">
            <UserRound className="w-4 h-4 text-stone-600" />
          </button>
        )}
      </div>

      {/* Language selector */}
      <div className="absolute top-[72px] right-5 z-20 flex gap-2">
        {['en', 'hi'].map(l => (
          <button key={l} onClick={() => handleLanguageChange(l)}
            className={clsx(
              'px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest transition-all border whitespace-nowrap',
              state.lang === l ? 'bg-charcoal text-white border-charcoal shadow-sm' : 'bg-white/80 text-stone-900 border-stone-200'
            )}>
            {l === 'en' ? 'EN' : 'हिन्दी'}
          </button>
        ))}
      </div>

      {/* Ring — 60% height, centered */}
      <div className="absolute inset-0 z-0 h-[60%] flex items-center justify-center">
<Suspense fallback={<Loader2 className="w-8 h-8 text-brand-600 animate-spin" />}>
          <div className="animate-ring w-full h-full flex items-center justify-center opacity-95">
            <Spline
              scene="/assets/demo/one_ring.spline"
              onLoad={() => setLoading(false)}
              className="w-full h-full"
            />
          </div>
        </Suspense>
      </div>

      <div className="flex-1" />

      {/* ── Compact bottom sheet ── */}
      <div className="relative z-10 px-6 pb-8 pt-4 backdrop-blur-3xl rounded-t-[2rem] shadow-[0_-24px_60px_rgba(32,24,18,0.14)] animate-slide-up"
        style={{
          background: 'linear-gradient(180deg, rgba(255,252,248,0.97) 0%, rgba(253,248,240,0.99) 100%)',
          borderTop: '1.5px solid rgba(196,130,48,0.25)',
          boxShadow: '0 -24px 60px rgba(32,24,18,0.14), inset 0 1px 0 rgba(255,200,80,0.15)',
        }}>

        {/* Feature carousel — compact */}
        <div className="mb-2">
          <FeatureCarousel currentIndex={featureIndex} lang={state.lang} />
          <div className="flex justify-center gap-1 mt-2">
            {[0,1,2,3].map(i => (
              <div key={i} className={clsx('rounded-full transition-all duration-500', featureIndex % 4 === i ? 'w-4 h-1 bg-stone-950' : 'w-1 h-1 bg-stone-300')} />
            ))}
          </div>
        </div>

        {/* Brand — compact */}
        <div className="text-center mb-3">
          <h1 className="font-display font-black text-[3.2rem] leading-none tracking-[-0.04em]"
            style={{ color: '#B45309' }}>
            {state.lang === 'hi' ? 'गोल्ड आई' : 'GoldEye'}
          </h1>
        </div>

        {/* Actions */}
        <div className="space-y-1">
          <button onClick={handleGetStarted}
            className="w-full h-[54px] rounded-2xl bg-stone-950 text-white font-semibold text-[15px] tracking-[-0.01em] flex items-center justify-center gap-2 active:opacity-75 transition-opacity">
            {state.lang === 'hi' ? 'रजिस्टर करें' : 'Create Account'}
            <ArrowRight className="w-4 h-4" />
          </button>
          <button onClick={() => navigate('/login')}
            className="w-full h-[46px] rounded-2xl bg-transparent border border-[#E2DDD6] text-stone-950 font-semibold text-[15px] tracking-[-0.01em] active:bg-stone-50 transition-colors">
            {state.lang === 'hi' ? 'लॉगिन करें' : 'Log In'}
          </button>
          <button onClick={handleGuest}
            className="w-full py-2 text-[12px] font-medium text-stone-400 active:text-stone-600 transition-colors">
            {state.lang === 'hi' ? 'अतिथि के रूप में जारी रखें' : 'Continue as Guest'}
          </button>
        </div>

        <p className="text-center text-[9px] font-bold text-stone-300 uppercase tracking-[0.2em] mt-4">
          Poonawalla Fincorp
        </p>
      </div>
    </div>
  )
}
