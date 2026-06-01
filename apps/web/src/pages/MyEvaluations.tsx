import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Filter,
  IndianRupee,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { apiBase } from '../lib/api'
import { useSessionStore } from '../store/session'

type ApiSessionSummary = {
  session_id: string
  phone: string | null
  status: string
  created_at: string
  confidence_score: number | null
  routing: string | null
}

type EvaluationStatus = 'completed' | 'branch-ready' | 'review' | 'action-needed' | 'rejected'
type EvaluationSource = 'api' | 'current' | 'sample'

type EvaluationItem = {
  id: string
  source: EvaluationSource
  title: string
  subtitle: string
  date: string
  timeLabel: string
  image: string
  purity: string
  weight: string
  eligibleLoan: string
  status: EvaluationStatus
  statusLabel: string
  confidence: number | null
  branch: string
  phone?: string | null
}

type FilterKey = 'all' | 'completed' | 'branch-ready' | 'action-needed' | 'review'

const SAMPLE_EVALUATIONS: EvaluationItem[] = [
  {
    id: 'sample-ring-22k',
    source: 'sample',
    title: 'Gold Ring',
    subtitle: 'BIS HUID verified',
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    timeLabel: '2 days ago',
    image: '/assets/hero/gold-rings-texture.jpg',
    purity: '22K',
    weight: '5.12 g',
    eligibleLoan: '₹1,82,000',
    status: 'completed',
    statusLabel: 'Completed',
    confidence: 92,
    branch: 'Pune - FC Road',
  },
  {
    id: 'sample-bangles-22k',
    source: 'sample',
    title: 'Gold Bangles',
    subtitle: 'Branch valuation ready',
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 9).toISOString(),
    timeLabel: '9 days ago',
    image: '/assets/hero/gold-ring-red-card.jpg',
    purity: '22K',
    weight: '18.40 g',
    eligibleLoan: '₹6,45,000',
    status: 'branch-ready',
    statusLabel: 'Branch Ready',
    confidence: 88,
    branch: 'Pune - FC Road',
  },
  {
    id: 'sample-chain-18k',
    source: 'sample',
    title: 'Gold Chain',
    subtitle: 'Macro image needs retake',
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 21).toISOString(),
    timeLabel: '21 days ago',
    image: '/assets/hero/gold-rings-texture.jpg',
    purity: '18K',
    weight: '9.70 g',
    eligibleLoan: '₹2,05,000',
    status: 'action-needed',
    statusLabel: 'Recapture',
    confidence: 64,
    branch: 'Pune - FC Road',
  },
]

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'branch-ready', label: 'Branch Ready' },
  { key: 'action-needed', label: 'Action Needed' },
  { key: 'review', label: 'Review' },
]

const POONAWALLA_GOLD_LOAN_URL = 'https://poonawallafincorp.com/gold-loan'

const statusStyles: Record<EvaluationStatus, { icon: typeof CheckCircle2; className: string }> = {
  completed: {
    icon: CheckCircle2,
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  'branch-ready': {
    icon: BadgeCheck,
    className: 'bg-gold-50 text-gold-800 border-gold-200',
  },
  review: {
    icon: Clock3,
    className: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  'action-needed': {
    icon: AlertTriangle,
    className: 'bg-orange-50 text-orange-700 border-orange-200',
  },
  rejected: {
    icon: XCircle,
    className: 'bg-red-50 text-red-700 border-red-200',
  },
}

function formatCurrency(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return 'Pending'
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recent'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function shortId(id: string) {
  return id.split('-')[0]?.toUpperCase() || 'GOLD'
}

function mapRoutingToStatus(routing: string | null, status?: string): EvaluationStatus {
  const normalized = `${routing || status || ''}`.toUpperCase()
  if (normalized.includes('INSTANT') || normalized.includes('COMPLETE')) return 'completed'
  if (normalized.includes('AGENT') || normalized.includes('BRANCH')) return 'branch-ready'
  if (normalized.includes('RECAPTURE') || normalized.includes('ACTION')) return 'action-needed'
  if (normalized.includes('REJECT')) return 'rejected'
  return 'review'
}

function statusLabel(status: EvaluationStatus) {
  if (status === 'branch-ready') return 'Branch Ready'
  if (status === 'action-needed') return 'Action Needed'
  if (status === 'review') return 'Under Review'
  if (status === 'rejected') return 'Not Eligible'
  return 'Completed'
}

function apiSessionToEvaluation(session: ApiSessionSummary): EvaluationItem {
  const status = mapRoutingToStatus(session.routing, session.status)
  const outcome: Record<EvaluationStatus, string> = {
    completed: 'Report ready',
    'branch-ready': 'Branch handoff',
    review: 'Pending',
    'action-needed': 'Retake needed',
    rejected: 'Not eligible',
  }
  return {
    id: session.session_id,
    source: 'api',
    title: `GoldEye Report ${shortId(session.session_id)}`,
    subtitle: session.routing ? `${session.routing} route` : session.status || 'Evaluation saved',
    date: session.created_at,
    timeLabel: formatDate(session.created_at),
    image: '/assets/hero/gold-rings-texture.jpg',
    purity: 'Gold',
    weight: 'Assessment',
    eligibleLoan: outcome[status],
    status,
    statusLabel: statusLabel(status),
    confidence: session.confidence_score == null ? null : Math.round(session.confidence_score * 100),
    branch: 'Poonawalla Fincorp',
    phone: session.phone,
  }
}

function currentStateEvaluation(state: ReturnType<typeof useSessionStore>['state']): EvaluationItem | null {
  if (!state.result) return null
  const result = state.result
  const status = mapRoutingToStatus(result.routing)
  const image =
    state.captures.macro?.dataUrl ||
    state.captures.top?.dataUrl ||
    '/assets/hero/gold-rings-texture.jpg'
  return {
    id: result.session_id || state.sessionId || 'current-evaluation',
    source: 'current',
    title: state.certificateData?.itemDescription || 'Current Gold Evaluation',
    subtitle: result.purity.huid_verified ? 'HUID verified in GoldEye' : 'GoldEye assessment saved',
    date: result.timestamp_utc || new Date().toISOString(),
    timeLabel: 'Current session',
    image,
    purity: `${result.purity.point_estimate_karat}K`,
    weight: `${result.weight.estimated_g.toFixed(2)} g`,
    eligibleLoan: formatCurrency(state.evalData?.maxLoanInr ?? result.loan_offer.band_high_inr),
    status,
    statusLabel: statusLabel(status),
    confidence: Math.round(result.confidence.score * 100),
    branch: state.evalData?.city ? `${state.evalData.city} branch` : 'Nearest branch pending',
    phone: state.phone,
  }
}

function StatusPill({ item }: { item: EvaluationItem }) {
  const config = statusStyles[item.status]
  const Icon = config.icon
  return (
    <span className={clsx('evaluation-status-pill', config.className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {item.statusLabel}
    </span>
  )
}

function ConfidenceMeter({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <div className="evaluation-confidence is-muted">
        <span>--</span>
      </div>
    )
  }
  const style = { '--confidence': `${Math.max(0, Math.min(100, value))}%` } as CSSProperties
  return (
    <div className="evaluation-confidence" style={style} aria-label={`Confidence ${value}%`}>
      <span>{value}</span>
    </div>
  )
}

function EvaluationCard({ item, onOpen }: { item: EvaluationItem; onOpen: (item: EvaluationItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="evaluation-card"
      aria-label={`Open ${item.title}`}
    >
      <div className="evaluation-card-image">
        <img src={item.image} alt="" draggable={false} />
      </div>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-display text-sm font-black leading-tight text-stone-950">{item.title}</h3>
            <p className="mt-1 truncate text-[11px] font-semibold text-stone-500">{item.subtitle}</p>
          </div>
          <StatusPill item={item} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="evaluation-mini-stat">
            <span>Purity</span>
            <b>{item.purity}</b>
          </div>
          <div className="evaluation-mini-stat">
            <span>Weight</span>
            <b>{item.weight}</b>
          </div>
          <div className="evaluation-mini-stat">
            <span>Outcome</span>
            <b>{item.eligibleLoan}</b>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-semibold text-stone-400">
            <CalendarDays className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {item.timeLabel}
          </span>
          <div className="flex flex-shrink-0 items-center gap-2">
            <ConfidenceMeter value={item.confidence} />
            <span className="inline-flex items-center gap-1 text-[11px] font-black text-charcoal">
              View
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}

export function MyEvaluations() {
  const navigate = useNavigate()
  const { state } = useSessionStore()
  const [sessions, setSessions] = useState<ApiSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetch(`${apiBase}/api/dashboard/sessions`)
      .then((response) => {
        if (!response.ok) throw new Error('sessions_fetch_failed')
        return response.json()
      })
      .then((data: ApiSessionSummary[]) => {
        if (!cancelled) setSessions(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const currentEvaluation = useMemo(() => currentStateEvaluation(state), [state])

  const realEvaluations = useMemo(() => {
    const apiItems = sessions.map(apiSessionToEvaluation)
    const combined = currentEvaluation
      ? [currentEvaluation, ...apiItems.filter((item) => item.id !== currentEvaluation.id)]
      : apiItems
    return combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [currentEvaluation, sessions])

  const evaluations = realEvaluations.length > 0 ? realEvaluations : SAMPLE_EVALUATIONS
  const sampleMode = !loading && realEvaluations.length === 0

  const filteredEvaluations = evaluations.filter((item) => {
    const matchesFilter = activeFilter === 'all' || item.status === activeFilter
    const searchable = `${item.title} ${item.subtitle} ${item.purity} ${item.weight} ${item.branch}`.toLowerCase()
    return matchesFilter && searchable.includes(query.trim().toLowerCase())
  })

  const actionCount = evaluations.filter((item) => item.status === 'action-needed' || item.status === 'review').length
  const avgConfidence = Math.round(
    evaluations.reduce((sum, item) => sum + (item.confidence ?? 0), 0) /
      Math.max(1, evaluations.filter((item) => item.confidence != null).length),
  )
  const latest = evaluations[0]
  const totalReady = evaluations.filter((item) => item.status === 'completed' || item.status === 'branch-ready').length
  const heroHeadline = realEvaluations.length > 0
    ? `${evaluations.length} reports`
    : latest?.eligibleLoan || 'Start your first scan'
  const heroSubtitle = realEvaluations.length > 0
    ? `${totalReady} ready · ${actionCount} pending`
    : latest ? `${latest.title} · ${latest.statusLabel}` : 'Track every GoldEye report in one place.'

  function openEvaluation(item: EvaluationItem) {
    if (item.source === 'sample') return
    navigate(`/my-evaluations/session/${item.id}`)
  }

  return (
    <div className="page app-page-bg animate-fade-in">
      <header className="page-header sticky top-0 z-30">
        <button onClick={() => navigate('/dashboard-home')} className="btn-icon" aria-label="Back to dashboard">
          <ChevronRight className="h-5 w-5 rotate-180 text-stone-500" />
        </button>
        <div className="text-center">
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-stone-400">GoldEye</p>
          <h1 className="font-display text-sm font-black text-stone-950">My Evaluations</h1>
        </div>
        <button
          type="button"
          onClick={() => setActiveFilter(activeFilter === 'all' ? 'action-needed' : 'all')}
          className="btn-icon"
          aria-label="Toggle filters"
        >
          <Filter className="h-5 w-5 text-stone-600" />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar px-5 pb-28 pt-4">
        <section className="evaluations-hero" aria-label="Evaluation summary">
          <div className="relative z-10">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gold-100/80">Evaluation Vault</p>
                <h2 className="mt-2 max-w-[13rem] font-display text-[28px] font-black leading-[0.98] text-white">
                  {heroHeadline}
                </h2>
                <p className="mt-2 text-xs font-medium leading-relaxed text-white/64">
                  {heroSubtitle}
                </p>
              </div>
              <div className="evaluations-hero-mark" aria-hidden>
                PF
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              <div className="evaluations-hero-stat">
                <span>Total</span>
                <b>{evaluations.length}</b>
              </div>
              <div className="evaluations-hero-stat">
                <span>Ready</span>
                <b>{totalReady}</b>
              </div>
              <div className="evaluations-hero-stat">
                <span>Avg Conf.</span>
                <b>{avgConfidence || '--'}%</b>
              </div>
            </div>
          </div>
        </section>

        {sampleMode && (
          <div className="mt-3 rounded-2xl border border-gold-200 bg-gold-50 px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-gold-700" aria-hidden />
              <p className="text-xs font-semibold leading-relaxed text-stone-700">
                No saved evaluations were returned yet, so this page is showing a styled preview layout.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-2xl border border-orange-200 bg-orange-50 px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-orange-800">Could not refresh saved evaluations.</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1 text-[11px] font-black text-orange-800"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          </div>
        )}

        <section className="mt-4 grid grid-cols-2 gap-3" aria-label="Evaluation actions">
          <button
            type="button"
            onClick={() => navigate('/setup')}
            className="evaluation-action-tile is-primary"
          >
            <Plus className="h-5 w-5" aria-hidden />
            <span>New Evaluation</span>
          </button>
          <a
            href={POONAWALLA_GOLD_LOAN_URL}
            className="evaluation-action-tile"
            aria-label="Open Poonawalla Fincorp gold loan eligibility website"
          >
            <ArrowUpRight className="h-5 w-5" aria-hidden />
            <span>Loan Eligibility</span>
          </a>
        </section>

        <section className="mt-4" aria-label="Search evaluations">
          <div className="evaluation-search">
            <Search className="h-4 w-4 text-stone-400" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by item, purity, branch"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-stone-800 outline-none placeholder:text-stone-400"
            />
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setActiveFilter(filter.key)}
                className={clsx('evaluation-filter-chip', activeFilter === filter.key && 'is-active')}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5" aria-labelledby="evaluation-list-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="evaluation-list-heading" className="font-display text-lg font-black leading-none text-stone-950">
                Evaluation History
              </h2>
              <p className="mt-1 text-xs font-medium text-stone-500">
                {filteredEvaluations.length} reports shown
              </p>
            </div>
            {actionCount > 0 && (
              <span className="rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[10px] font-black text-orange-700">
                {actionCount} pending
              </span>
            )}
          </div>

          {loading ? (
            <div className="evaluation-loading">
              <Loader2 className="h-5 w-5 animate-spin text-brand-600" />
              <span>Loading evaluations</span>
            </div>
          ) : filteredEvaluations.length === 0 ? (
            <div className="evaluation-empty">
              <FileText className="mx-auto h-7 w-7 text-stone-400" aria-hidden />
              <p className="mt-3 font-display text-sm font-black text-stone-950">No matching evaluations</p>
              <p className="mt-1 text-xs font-medium leading-relaxed text-stone-500">
                Try another filter or start a fresh GoldEye scan.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredEvaluations.map((item) => (
                <EvaluationCard key={`${item.source}-${item.id}`} item={item} onOpen={openEvaluation} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-stone-200 bg-white/82 p-4 shadow-card" aria-label="Evaluation safeguards">
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { Icon: ShieldCheck, label: 'RBI Norms' },
              { Icon: IndianRupee, label: 'LTV Check' },
              { Icon: MapPin, label: 'Branch Ready' },
            ].map(({ Icon, label }) => (
              <div key={label} className="space-y-1.5">
                <Icon className="mx-auto h-4 w-4 text-brand-600" aria-hidden />
                <p className="text-[10px] font-black text-stone-600">{label}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <div
        className="sticky bottom-0 z-20 px-5 py-3 bg-white/90 backdrop-blur-xl border-t border-stone-200/70"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={() => navigate('/setup')}
          className="w-full py-4 rounded-2xl bg-charcoal text-white font-display font-black text-base shadow-cta active:scale-[0.98] transition-transform flex items-center justify-center gap-2.5"
        >
          <TrendingUp className="h-5 w-5" aria-hidden />
          Start New Evaluation
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
