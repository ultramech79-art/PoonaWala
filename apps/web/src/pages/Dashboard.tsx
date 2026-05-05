import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import {
  Bell, Menu, TrendingUp, TrendingDown, ArrowRight,
  Loader2, ChevronRight, Zap, UserCheck, AlertTriangle,
  Eye, RefreshCw, WifiOff
} from 'lucide-react'
import { clsx } from 'clsx'
import { BottomNav } from '../components/BottomNav'
import { useMetalPrices } from '../hooks/useGoldPrice'

import { apiBase } from '../lib/api'

interface SessionSummary {
  session_id: string
  phone: string | null
  status: string
  created_at: string
  confidence_score: number | null
  routing: string | null
}

// ── Sparkline SVG ─────────────────────────────────────────────
function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const W = 140, H = 40
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W
    const y = H - ((v - min) / range) * (H - 6) - 3
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const color = positive ? '#10b981' : '#ef4444'
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot */}
      {(() => {
        const last = data[data.length - 1]
        const x = W
        const y = H - ((last - min) / range) * (H - 6) - 3
        return <circle cx={x} cy={y} r="3" fill={color} />
      })()}
    </svg>
  )
}

// ── Metal Price Carousel ───────────────────────────────────────
function MetalPriceCarousel() {
  const { data, loading, error } = useMetalPrices()
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto no-scrollbar pb-2 mb-4 px-1">
        {[1, 2].map(i => (
          <div key={i} className="flex-shrink-0 w-64 h-40 rounded-3xl bg-white border border-stone-200 p-5 animate-pulse">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-2xl bg-stone-100" />
              <div className="space-y-2">
                <div className="w-16 h-2.5 bg-stone-100 rounded" />
                <div className="w-24 h-4 bg-stone-100 rounded" />
              </div>
            </div>
            <div className="w-32 h-8 bg-stone-100 rounded mb-4" />
            <div className="w-full h-8 bg-stone-50 rounded" />
          </div>
        ))}
      </div>
    )
  }

  if (!data?.metals) return null

  const isLive = data.source === 'live'
  const age = Math.round((Date.now() - data.fetchedAt) / 60000)

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <h2 className="font-display font-bold text-sm text-stone-900 uppercase tracking-tight">{t('dashboard_live_rates')}</h2>
          {isLive ? (
            <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-100">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {t('dashboard_live')}
            </span>
          ) : (
            <span className="text-[10px] text-stone-400 font-medium">{age}m ago</span>
          )}
        </div>
        {error && (
          <button
            onClick={() => { localStorage.removeItem('goldeye_metal_prices_v2'); window.location.reload() }}
            className="text-[10px] font-bold text-brand-600 hover:text-brand-700 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> {t('dashboard_retry')}
          </button>
        )}
      </div>

      <div className="flex gap-4 overflow-x-auto no-scrollbar pb-4 px-1 -mx-1 snap-x snap-mandatory">
        {data.metals.map((metal) => {
          const positive = metal.changePercent24h >= 0
          const absChange = Math.abs(metal.changePercent24h)
          
          const isGold = metal.id.startsWith('xau')
          const isSilver = metal.id.startsWith('xag')
          const isPlatinum = metal.id.startsWith('xpt')
          
          const styles = isGold 
            ? { bg: 'bg-gradient-to-br from-gold-50/50 to-white', border: 'border-gold-200/60', icon: 'bg-gold-500', text: 'text-gold-600' }
            : isSilver
            ? { bg: 'bg-gradient-to-br from-stone-100/50 to-white', border: 'border-stone-300/60', icon: 'bg-stone-500', text: 'text-stone-600' }
            : { bg: 'bg-gradient-to-br from-ink-50/50 to-white', border: 'border-ink-200/60', icon: 'bg-ink-500', text: 'text-ink-600' }

          return (
            <div 
              key={metal.id} 
              className={clsx(
                "flex-shrink-0 w-64 rounded-3xl border p-5 snap-start transition-all duration-300 hover:shadow-gold-sm",
                styles.bg, styles.border
              )}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className={clsx("w-10 h-10 rounded-2xl flex items-center justify-center text-white shadow-sm", styles.icon)}>
                    {isGold ? <Zap className="w-5 h-5" fill="currentColor" /> : <TrendingUp className="w-5 h-5" />}
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest leading-none mb-1">{metal.name}</p>
                    <p className="text-sm font-display font-bold text-stone-900 leading-none">
                      {metal.purity ? `${metal.purity} ${t('result_purity')}` : t('dashboard_spot_rate')}
                    </p>
                  </div>
                </div>
                <div className={clsx(
                  "flex items-center gap-0.5 px-2 py-1 rounded-xl text-[10px] font-black tracking-tight",
                  positive ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                )}>
                  {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {positive ? '+' : ''}{metal.changePercent24h}%
                </div>
              </div>

              <div className="mb-4">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-display font-black text-stone-900 tracking-tight">
                    ₹{metal.price.toLocaleString('en-IN')}
                  </span>
                  <span className="text-xs font-bold text-stone-400">/{metal.unit}</span>
                </div>
              </div>

              <div className="h-10 -mx-1 opacity-80">
                <Sparkline data={metal.sparkline} positive={positive} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ── Main Dashboard ────────────────────────────────────────────
export function Dashboard() {
  const navigate = useNavigate()
  const { state } = useSessionStore()
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? t('greeting_morning') : hour < 17 ? t('greeting_afternoon') : t('greeting_evening')
  const displayName = state.name || 'there'

  useEffect(() => {
    fetch(`${apiBase}/api/dashboard/sessions`)
      .then(r => r.json())
      .then(data => { setSessions(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const ROUTING_CONFIG = {
    INSTANT: { icon: Zap,           label: t('routing_instant'), color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
    AGENT:   { icon: UserCheck,     label: t('routing_agent'),   color: 'text-brand-600',   bg: 'bg-brand-50',   border: 'border-brand-200'   },
    REJECT:  { icon: AlertTriangle, label: t('routing_reject'),  color: 'text-orange-600',  bg: 'bg-orange-50',  border: 'border-orange-200'  },
  }

  return (
    <div className="page pb-28 animate-fade-in">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-4 bg-white border-b border-stone-200/70">
        <button className="btn-icon">
          <Menu className="w-5 h-5 text-stone-600" />
        </button>
        <div className="flex items-center gap-2 bg-white py-1.5 px-3 rounded-lg shadow-sm border border-stone-200">
          <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-5 object-contain" />
        </div>
        <button className="btn-icon relative">
          <Bell className="w-5 h-5 text-stone-600" />
          <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-brand-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5">
        {/* Greeting */}
        <div className="pt-6 pb-5">
          <p className="text-sm text-stone-500 mb-0.5">{greeting},</p>
          <h1 className="font-display font-bold text-2xl text-stone-900 capitalize">{displayName}</h1>
        </div>

        {/* Live Metal Prices Carousel */}
        <MetalPriceCarousel />


        {/* Start New Assessment CTA */}
        <button
          onClick={() => navigate('/setup')}
          className="w-full card p-4 flex items-center gap-4 hover:border-brand-300 hover:bg-brand-50/30 transition-all duration-200 active:scale-[0.98] mb-6"
        >
          <div className="w-12 h-12 rounded-2xl bg-brand-500 flex items-center justify-center flex-shrink-0 shadow-brand-sm">
            <Eye className="w-6 h-6 text-white" strokeWidth={2} />
          </div>
          <div className="flex-1 text-left">
            <p className="font-display font-semibold text-stone-900 text-base">{t('dashboard_start_assessment')}</p>
            <p className="text-xs text-stone-500 mt-0.5">{t('dashboard_start_subtitle')}</p>
          </div>
          <ArrowRight className="w-5 h-5 text-stone-400 flex-shrink-0" />
        </button>

        {/* Recent Sessions */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-semibold text-base text-stone-900">{t('dashboard_recent')}</h2>
            {sessions.length > 0 && (
              <span className="badge-brand">{t('dashboard_sessions', { count: sessions.length })}</span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-brand-400" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="w-12 h-12 rounded-2xl bg-stone-100 flex items-center justify-center mx-auto mb-3">
                <Eye className="w-6 h-6 text-stone-400" strokeWidth={1.5} />
              </div>
              <p className="text-sm font-medium text-stone-700 mb-1">{t('dashboard_no_assessments')}</p>
              <p className="text-xs text-stone-400">{t('dashboard_no_assessments_sub')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(session => {
                const rc = session.routing as keyof typeof ROUTING_CONFIG | null
                const cfg = rc && ROUTING_CONFIG[rc] ? ROUTING_CONFIG[rc] : null
                const RIcon = cfg?.icon
                return (
                  <button
                    key={session.session_id}
                    onClick={() => navigate(`/dashboard/session/${session.session_id}`)}
                    className="w-full card p-4 flex items-center justify-between hover:border-stone-300 transition-all active:scale-[0.98]"
                  >
                    <div className="space-y-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-stone-500">
                          {session.session_id.split('-')[0]}…
                        </span>
                        {cfg && RIcon && (
                          <span className={clsx(
                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border',
                            cfg.bg, cfg.border, cfg.color
                          )}>
                            <RIcon className="w-3 h-3" strokeWidth={2} />
                            {cfg.label}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-stone-400">
                        {new Date(session.created_at).toLocaleString('en-IN', {
                          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                        })}
                        {session.phone && ` · ${session.phone}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {session.confidence_score !== null && (
                        <div className="text-right">
                          <p className="text-xs text-stone-400">{t('dashboard_confidence')}</p>
                          <p className="text-sm font-semibold text-stone-900">
                            {(session.confidence_score * 100).toFixed(0)}%
                          </p>
                        </div>
                      )}
                      <ChevronRight className="w-4 h-4 text-stone-300" />
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="divider mb-4" />
        <div className="flex items-center justify-center gap-3 flex-wrap pb-4">
          <span className="badge-gold">{t('footer_rbi')}</span>
          <span className="badge-blue">{t('footer_dpdp')}</span>
          <span className="text-xs text-stone-400">{t('dashboard_trusted')}</span>
        </div>
      </div>

      <BottomNav />
    </div>
  )
}
