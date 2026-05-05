import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Zap, Shield, TrendingUp, ChevronRight, Eye, TrendingDown } from 'lucide-react'
import { useMetalPrices } from '../hooks/useGoldPrice'


const FEATURES = [
  { icon: Zap, label: 'Instant Assessment' },
  { icon: Shield, label: 'Secure & Private' },
  { icon: TrendingUp, label: 'Trusted by NBFCs' },
]

function MarketTicker() {
  const { data, loading } = useMetalPrices()
  
  if (loading || !data) return (
    <div className="h-10 mx-5 rounded-xl bg-white/5 animate-pulse" />
  )

  const displayMetals = data.metals.filter(m => ['xau_24k', 'xag', 'xpt'].includes(m.id))

  return (
    <div className="mx-5 overflow-hidden rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm py-2.5">
      <div className="flex items-center gap-8 animate-marquee whitespace-nowrap px-4">
        {[...displayMetals, ...displayMetals].map((metal, i) => {
          const positive = metal.changePercent24h >= 0
          return (
            <div key={`${metal.id}-${i}`} className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">{metal.name}</span>
              <span className="text-xs font-display font-bold text-white">₹{metal.price.toLocaleString('en-IN')}</span>
              <span className={`flex items-center text-[10px] font-bold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
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


export function Welcome() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  return (
    <div className="page-dark animate-fade-in">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-6 pb-4">
        <div className="flex items-center gap-2.5 bg-white py-2 px-3 rounded-xl shadow-lg">
          <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-6 object-contain" />
        </div>
        <button
          id="change-language"
          onClick={() => navigate('/language')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 border border-white/20 text-xs text-white/50 hover:text-white/80 transition-colors"
        >
          <ChevronRight className="w-3 h-3 rotate-90" />
          Language
        </button>
      </div>

      {/* Hero jewelry image */}
      <div className="relative mx-5 rounded-3xl overflow-hidden mb-6" style={{ height: '240px' }}>
        <img
          src="https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&q=85&fm=jpg"
          alt="Gold jewelry"
          className="w-full h-full object-cover"
          onError={e => {
            (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&q=80'
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-900/80 via-ink-900/20 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4">
          <p className="text-xs font-medium text-gold-300 uppercase tracking-widest mb-1">AI-Powered</p>
          <h1 className="font-display font-black text-2xl text-white leading-tight">
            Gold Assessment for<br />Instant Loan Eligibility
          </h1>
        </div>
      </div>

      {/* Feature list */}
      <div className="px-5 mb-8 space-y-2.5">
        {FEATURES.map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-gold-500/20 flex items-center justify-center flex-shrink-0">
              <Icon className="w-3.5 h-3.5 text-gold-400" strokeWidth={2} />
            </div>
            <span className="text-sm text-white/80 font-medium">{label}</span>
          </div>
        ))}
      </div>

      {/* Live Market Ticker */}
      <MarketTicker />

      {/* Gold Chart */}
      <div className="mx-5 mt-4 rounded-2xl overflow-hidden border border-white/10 shadow-lg" style={{ height: '200px' }}>
        <iframe 
          src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview_1&symbol=OANDA%3AXAUUSD&interval=D&hidesidetoolbar=1&symboledit=0&saveimage=0&toolbarbg=1c315e&studies=%5B%5D&theme=dark&style=2&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%22header_widget%22%5D&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=OANDA%3AXAUUSD" 
          width="100%" 
          height="100%" 
          frameBorder="0" 
          allowTransparency={true} 
          scrolling="no"
          style={{ pointerEvents: 'none' }}
        ></iframe>
      </div>


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
        <p className="text-center text-xs text-white/30">
          {t('welcome_trusted')}
        </p>
      </div>
    </div>
  )
}
