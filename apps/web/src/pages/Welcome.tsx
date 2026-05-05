import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Zap, Shield, TrendingUp, ChevronRight, Eye, TrendingDown } from 'lucide-react'
import { useMetalPrices } from '../hooks/useGoldPrice'


function MarketTicker() {
  const { data, loading } = useMetalPrices()

  if (loading || !data) return (
    <div className="h-10 mx-5 rounded-xl bg-stone-200 animate-pulse" />
  )

  const displayMetals = data.metals.filter(m => ['xau_24k', 'xag', 'xpt'].includes(m.id))

  return (
    <div className="mx-5 overflow-hidden rounded-2xl bg-gold-50 border border-gold-200 py-2.5">
      <div className="flex items-center gap-8 animate-marquee whitespace-nowrap px-4">
        {[...displayMetals, ...displayMetals].map((metal, i) => {
          const positive = metal.changePercent24h >= 0
          return (
            <div key={`${metal.id}-${i}`} className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-gold-600/60 uppercase tracking-widest">{metal.name}</span>
              <span className="text-xs font-display font-bold text-gold-700">₹{metal.price.toLocaleString('en-IN')}</span>
              <span className={`flex items-center text-[10px] font-bold ${positive ? 'text-emerald-600' : 'text-red-600'}`}>
                {positive ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                {Math.abs(metal.changePercent24h)}%
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
    <div className="mx-5 mt-4 h-[180px] rounded-2xl bg-stone-200 animate-pulse" />
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
    <div className="mx-5 mt-4 p-5 rounded-2xl border border-gold-200 bg-gold-50/50 shadow-sm relative overflow-hidden" style={{ height: '180px' }}>
      <div className="relative z-10 flex justify-between items-start">
        <div>
          <p className="text-xs font-bold text-gold-600/80 uppercase tracking-widest">{gold.name}</p>
          <p className="text-2xl font-display font-bold text-stone-900 mt-1">
            ₹{gold.price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            <span className="text-sm font-medium text-stone-500 ml-1">/ g</span>
          </p>
        </div>
        <div className={`px-2 py-1 rounded-lg text-xs font-bold ${gold.changePercent24h >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
          {gold.changePercent24h >= 0 ? '+' : ''}{gold.changePercent24h.toFixed(2)}%
        </div>
      </div>
      
      <svg className="absolute bottom-0 left-0 w-full h-24 opacity-80" preserveAspectRatio="none" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#D4A017" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#D4A017" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={pathData} fill="url(#goldGrad)" />
        <path d={lineData} fill="none" stroke="#D4A017" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export function Welcome() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const FEATURES = [
    { icon: Zap, label: t('feature_instant') },
    { icon: Shield, label: t('feature_secure') },
    { icon: TrendingUp, label: t('feature_trusted') },
  ]

  return (
    <div className="page animate-fade-in">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-6 pb-4">
        <div className="flex items-center gap-2.5 bg-white py-2 px-3 rounded-xl shadow-lg border border-gold-100">
          <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-6 object-contain" />
        </div>
        <button
          id="change-language"
          onClick={() => navigate('/language')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-stone-100 border border-stone-200 text-xs text-stone-600 hover:bg-stone-200 hover:text-stone-700 transition-colors"
        >
          <ChevronRight className="w-3 h-3 rotate-90" />
          Language
        </button>
      </div>

      {/* Hero jewelry image */}
      <div className="relative mx-5 rounded-3xl overflow-hidden mb-6 shadow-lg" style={{ height: '240px' }}>
        <img
          src="https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&q=85&fm=jpg"
          alt="Gold jewelry"
          className="w-full h-full object-cover"
          onError={e => {
            (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&q=80'
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-stone-900/60 via-stone-900/20 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4">
          <p className="text-xs font-medium text-gold-400 uppercase tracking-widest mb-1">AI-Powered Assessment</p>
          <h1 className="font-display font-black text-2xl text-white leading-tight">
            Gold Assessment for<br />Instant Loan Eligibility
          </h1>
        </div>
      </div>

      {/* Feature list */}
      <div className="px-5 mb-8 space-y-2.5">
        {FEATURES.map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-3 p-3 rounded-xl bg-gold-50 border border-gold-100">
            <div className="w-6 h-6 rounded-full bg-gold-200 flex items-center justify-center flex-shrink-0">
              <Icon className="w-3.5 h-3.5 text-gold-700" strokeWidth={2} />
            </div>
            <span className="text-sm text-stone-700 font-medium">{label}</span>
          </div>
        ))}
      </div>

      {/* Live Market Ticker */}
      <MarketTicker />

      {/* Gold Chart */}
      <NativeGoldChart />

      {/* Spacer */}
      <div className="flex-1" />

      {/* CTA */}
      <div className="px-5 pb-8 space-y-3">
        <button
          id="welcome-cta"
          onClick={() => navigate('/consent')}
          className="btn-primary w-full text-base py-4 animate-pulse-brand"
        >
          {t('welcome_cta')}
          <ChevronRight className="w-5 h-5" />
        </button>
        <p className="text-center text-xs text-stone-400">
          {t('welcome_trusted')}
        </p>
      </div>
    </div>
  )
}
