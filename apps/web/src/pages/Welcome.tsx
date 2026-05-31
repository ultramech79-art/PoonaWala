import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Zap, Shield, TrendingUp, ChevronRight, Eye, TrendingDown, RefreshCw } from 'lucide-react'
import { useMetalPrices } from '../hooks/useGoldPrice'
import { useState } from 'react'
import { useSessionStore } from '../store/session'


function MarketTicker() {
  const { data, loading } = useMetalPrices()

  if (loading || !data) return (
    <div className="mx-5 h-11 rounded-xl bg-stone-200 animate-pulse" />
  )

  const displayMetals = data.metals.filter(m => ['xau_24k', 'xau_22k', 'xau_18k'].includes(m.id))

  return (
    <div className="mx-5 overflow-hidden rounded-2xl surface-panel py-3 relative">
      <div className="absolute left-0 top-0 w-1 h-full bg-brand-500/70" />
      <div className="flex items-center gap-8 animate-marquee whitespace-nowrap px-4">
        {[...displayMetals, ...displayMetals].map((metal, i) => {
          const positive = metal.changePercent24h >= 0
          return (
            <div key={`${metal.id}-${i}`} className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-brand-600 uppercase tracking-widest">{metal.name}</span>
              <span className="text-sm font-display font-bold text-stone-900">₹{metal.price.toLocaleString('en-IN')}</span>
              <span className={`flex items-center text-[10px] font-bold gap-0.5 ${positive ? 'text-emerald-600' : 'text-red-600'}`}>
                {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {Math.abs(metal.changePercent24h).toFixed(2)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}


function NativeGoldChart() {
  const { data, loading } = useMetalPrices()

  if (loading || !data) return (
    <div className="h-[160px] bg-stone-100 animate-pulse" />
  )

  const gold = data.metals.find(m => m.id === 'xau_24k')
  if (!gold) return null

  const min = Math.min(...gold.sparkline)
  const max = Math.max(...gold.sparkline)
  const range = max - min || 1

  const pts = gold.sparkline.map((val, i) => {
    const x = (i / (gold.sparkline.length - 1)) * 100
    const y = 100 - ((val - min) / range) * 80 - 10
    return `${x},${y}`
  })

  const lineData = `M ${pts.join(' L ')}`
  const pathData = `${lineData} L 100,100 L 0,100 Z`

  return (
    <div className="mx-5 mt-4 p-5 rounded-3xl surface-panel relative overflow-hidden" style={{ height: '180px' }}>
      <div className="relative z-10 flex justify-between items-start">
        <div>
          <p className="text-[10px] font-black text-stone-400 uppercase tracking-[0.2em]">{gold.name}</p>
          <p className="text-2xl font-display font-black text-stone-950 mt-1 numeric-hero">
            ₹{gold.price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            <span className="text-sm font-medium text-stone-400 ml-1">/ g</span>
          </p>
        </div>
        <div className={`px-3 py-2 rounded-lg text-xs font-bold ${gold.changePercent24h >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
          {gold.changePercent24h >= 0 ? '+' : ''}{gold.changePercent24h.toFixed(2)}%
        </div>
      </div>

      <svg className="absolute bottom-0 left-0 w-full h-24 opacity-70" preserveAspectRatio="none" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9B2C2C" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#9B2C2C" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={pathData} fill="url(#goldGrad)" />
        <path d={lineData} fill="none" stroke="#9B2C2C" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
      </svg>
    </div>
  )
}

export function Welcome() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { state } = useSessionStore()

  const FEATURES = [
    { icon: Zap, label: t('feature_instant') },
    { icon: Shield, label: t('feature_secure') },
    { icon: TrendingUp, label: t('feature_trusted') },
  ]

  return (
    <div className="page app-page-bg animate-fade-in pb-40">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-6 pb-4 bg-white/75 backdrop-blur-xl border-b border-stone-200/70">
        <div className="flex items-center gap-2.5 bg-white/70 py-3 px-4 rounded-2xl shadow-xs border border-stone-200/80 hover:bg-white transition-colors">
          <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-10 object-contain" />
        </div>
        <button
          id="change-language"
          onClick={() => navigate('/language')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white/70 border border-stone-200 text-xs font-medium text-stone-700 hover:bg-white transition-colors"
        >
          <ChevronRight className="w-3 h-3 rotate-90" />
          {t('lang_button')}
        </button>
      </div>

      {/* Hero section - With background image */}
      <div
        className="relative mx-5 mt-6 rounded-3xl overflow-hidden mb-8 hero-card"
        style={{
          minHeight: '240px',
          backgroundImage: 'url(https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&q=85&fm=jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        {/* Enhanced gradient overlay for better readability */}
        <div className="absolute inset-0 bg-gradient-to-r from-stone-950/92 via-stone-900/78 to-brand-700/52" />

        {/* Decorative circles */}
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-stone-950/50 to-transparent" />

        <div className="relative z-10 p-6 flex flex-col justify-between h-full">
          <div>
            <p className="text-xs font-bold text-gold-200 uppercase tracking-widest mb-2 opacity-95">{t('welcome_ai_powered')}</p>
            <h1 className="font-display font-black text-3xl text-white leading-tight tracking-[-0.04em]">
              {t('welcome_hero_title')}
            </h1>
          </div>
          <p className="text-xs text-white/75 font-medium">{t('welcome_hero_subtitle')}</p>
        </div>
      </div>

      {/* Feature list - 3 columns grid with enhanced styling */}
      <div className="px-5 mb-8">
        <div className="grid grid-cols-3 gap-2.5">
          {FEATURES.map(({ icon: Icon, label }, index) => (
            <div
              key={label}
              className="relative flex flex-col items-center p-4 rounded-2xl surface-panel hover:border-brand-200 transition-all overflow-hidden group"
            >
              {/* Decorative background accent */}
              <div className="w-12 h-12 rounded-2xl bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0 mb-3 relative z-10">
                <Icon className="w-6 h-6 text-brand-700" strokeWidth={2} />
              </div>
              <span className="text-xs text-center text-stone-700 font-medium leading-snug relative z-10">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Live Market Ticker */}
      <MarketTicker />

      {/* Gold Chart - Enhanced with better spacing */}
      <div className="mx-5 mt-6 mb-8">
        <div className="surface-panel rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-stone-100 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-brand-500" />
                <h2 className="text-sm font-display font-bold text-stone-900">{t('market_overview')}</h2>
              </div>
              <p className="text-xs text-stone-500">{t('market_overview_desc')}</p>
            </div>
            <button
              onClick={() => {
                localStorage.removeItem('goldeye_metal_prices_v2')
                window.location.reload()
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-brand-600 hover:bg-brand-50 hover:text-brand-700 transition-colors"
              title="Refresh prices"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <NativeGoldChart />
        </div>
      </div>

      {/* CTA */}
      <div className="px-5 pb-8 space-y-4">
        <div className="relative group">
          <button
            id="welcome-cta"
            onClick={() => navigate(state.authToken ? '/consent' : '/register')}
            className="btn-primary w-full text-base py-4 relative font-semibold flex items-center justify-center gap-2"
          >
            {t('welcome_cta')}
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <div className="flex items-center justify-center gap-2 px-4 py-2 rounded-2xl bg-white/70 border border-stone-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <p className="text-center text-xs text-stone-600">
            {t('welcome_trusted')}
          </p>
        </div>
      </div>
    </div>
  )
}
