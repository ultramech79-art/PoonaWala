import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { useMetalPrices } from '../hooks/useGoldPrice'
import {
  ChevronRight, ChevronDown, TrendingUp, TrendingDown,
  Sparkles, Shield, FileCheck, Clock, Zap, Percent,
  Scale, IndianRupee, Award, BadgeCheck, LayoutDashboard,
  UserRound, Landmark, RefreshCw, Phone, MessageCircle,
} from 'lucide-react'
import { clsx } from 'clsx'

// ─── Gold loan guidelines from Poonawalla Fincorp ─────────────────────────────

const GUIDELINES = [
  {
    id: 'loan-amount',
    Icon: IndianRupee,
    title: 'Loan Amount',
    summary: '₹10,000 – ₹1.5 Crore',
    detail:
      'Gold loans are offered from ₹10,000 up to ₹1.5 Crore based on the assessed gold value. Larger amounts are processed with in-branch physical verification. AI pre-qualification via GoldEye speeds up branch approval significantly.',
    badge: 'Flexible',
    badgeClass: 'bg-brand-50 text-brand-600 border-brand-200',
  },
  {
    id: 'ltv',
    Icon: Scale,
    title: 'LTV Ratio (Loan-to-Value)',
    summary: 'Up to 75% – 85% per RBI norms',
    detail:
      'RBI mandates LTV ≤75% for loans above ₹2.5 Lakh. Loans ≤₹2.5L may qualify for up to 85% LTV. A higher GoldEye confidence score (driven by BIS HUID match) unlocks the maximum LTV tier. Non-hallmarked gold attracts a 10–15% LTV reduction.',
    badge: 'RBI Regulated',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  {
    id: 'purity',
    Icon: Award,
    title: 'Eligible Gold Purity',
    summary: '18K to 24K BIS Hallmarked gold',
    detail:
      'We accept 18K, 20K, 22K, and 24K gold jewellery, coins, and bars. BIS Hallmarked gold with a valid 6-character HUID (verified against BIS CARE) qualifies for the highest LTV. Plain 999 bars and 916 hallmark pieces are also accepted.',
    badge: 'HUID Preferred',
    badgeClass: 'bg-gold-50 text-gold-700 border-gold-200',
  },
  {
    id: 'disbursement',
    Icon: Zap,
    title: 'Disbursement Speed',
    summary: 'Same-day · within 60 minutes',
    detail:
      'Once KYC is verified and gold is assessed, loan amount is credited to your bank account within 60 minutes. GoldEye\'s AI pre-qualification reduces branch evaluation time from hours to minutes, dramatically improving disbursement speed.',
    badge: 'Instant',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    id: 'documents',
    Icon: FileCheck,
    title: 'Documents Required',
    summary: 'Aadhaar · PAN · Gold ornaments only',
    detail:
      'Minimal documentation. You need a government-issued photo ID (Aadhaar, Passport, or Voter ID), PAN card, and your gold jewellery. No income proof, salary slips, or CIBIL check for standard amounts. Basic KYC only.',
    badge: 'Minimal KYC',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    id: 'interest',
    Icon: Percent,
    title: 'Interest Rate',
    summary: 'Starting from 10.5% p.a.',
    detail:
      'Rates start at 10.5% per annum and vary based on loan amount, tenor, and LTV. Monthly interest, overdraft, and bullet repayment options are available. No hidden fees — processing fee is clearly disclosed before disbursal.',
    badge: 'Competitive',
    badgeClass: 'bg-brand-50 text-brand-600 border-brand-200',
  },
  {
    id: 'tenure',
    Icon: Clock,
    title: 'Loan Tenure',
    summary: '3 months – 36 months',
    detail:
      'Choose tenures from 3 months to 36 months. Renew at maturity or close early with zero prepayment penalty. Overdraft (OD) facility provides maximum flexibility — pay interest only on what you withdraw.',
    badge: 'Flexible',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  {
    id: 'security',
    Icon: Shield,
    title: 'Gold Security & Storage',
    summary: '100% insured vault · fully audited',
    detail:
      'Your gold is stored in RBI-approved, fire-proof, tamper-evident vaults with comprehensive insurance. A physical receipt is issued at the time of pledging. You may inspect your gold at any time at a Poonawalla Fincorp branch.',
    badge: 'Fully Insured',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
]

// ─── Gold Price Bar ────────────────────────────────────────────────────────────

function GoldPriceBar() {
  const { data, loading } = useMetalPrices() as any

  if (loading || !data) {
    return <div className="mx-5 h-20 rounded-2xl bg-stone-100 animate-pulse" aria-label="Loading gold rates" />
  }

  const gold22 = data.metals?.find((m: any) => m.id === 'xau_22k')
  const gold18 = data.metals?.find((m: any) => m.id === 'xau_18k')
  if (!gold22) return null

  const metals = [gold22, gold18].filter(Boolean)

  return (
    <div className="mx-5 rounded-2xl bg-white border border-stone-200 shadow-card overflow-hidden" role="region" aria-label="Today's gold rates">
      <div className="px-4 py-2 border-b border-stone-100 flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[0.18em] text-stone-400">
          Today's Gold Rates · IBJA
        </span>
        <span className={clsx(
          'text-[10px] font-semibold px-2 py-0.5 rounded-full',
          data.source === 'live' ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'
        )}>
          {data.source === 'live' ? '● Live' : 'Cached'}
        </span>
      </div>
      <div className="flex divide-x divide-stone-100">
        {metals.map((metal: any) => {
          const pos = metal.changePercent24h >= 0
          return (
            <div key={metal.id} className="flex-1 px-4 py-3 flex flex-col gap-0.5">
              <span className="text-[10px] font-bold text-stone-400 uppercase tracking-wider">{metal.purity}</span>
              <span className="text-lg font-display font-black text-stone-900 tabular-nums leading-none">
                ₹{metal.price.toLocaleString('en-IN')}
                <span className="text-xs font-medium text-stone-400">/g</span>
              </span>
              <span className={clsx('flex items-center gap-0.5 text-[10px] font-bold', pos ? 'text-emerald-600' : 'text-red-600')}>
                {pos ? <TrendingUp className="w-3 h-3" aria-hidden /> : <TrendingDown className="w-3 h-3" aria-hidden />}
                {Math.abs(metal.changePercent24h).toFixed(2)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Quick Stats Strip ─────────────────────────────────────────────────────────

const STATS = [
  { label: 'Max LTV', value: '85%', sub: 'for ≤₹2.5L' },
  { label: 'Min Karat', value: '18K', sub: 'BIS standard' },
  { label: 'Disbursal', value: '60 min', sub: 'same-day' },
  { label: 'Rates from', value: '10.5%', sub: 'p.a.' },
]

function StatsStrip() {
  return (
    <div className="mx-5 mt-4 grid grid-cols-4 gap-2" role="list" aria-label="Loan at a glance">
      {STATS.map(s => (
        <div key={s.label} role="listitem"
          className="bg-white border border-stone-200 rounded-2xl px-2 py-3 flex flex-col items-center gap-0.5 shadow-card">
          <span className="text-sm font-display font-black text-stone-900 tabular-nums">{s.value}</span>
          <span className="text-[9px] font-bold text-stone-400 uppercase tracking-wider leading-none text-center">{s.label}</span>
          <span className="text-[8px] font-medium text-stone-400 leading-none text-center">{s.sub}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Guideline accordion item ──────────────────────────────────────────────────

function GuidelineItem({
  item, isOpen, onToggle,
}: { item: typeof GUIDELINES[0]; isOpen: boolean; onToggle: () => void }) {
  const { Icon } = item
  return (
    <div className={clsx(
      'border rounded-2xl overflow-hidden transition-all duration-200',
      isOpen ? 'border-brand-200 shadow-card bg-white' : 'border-stone-200 bg-white',
    )}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-stone-50 transition-colors"
        aria-expanded={isOpen}
        aria-controls={`guideline-${item.id}`}
      >
        <div className={clsx(
          'w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors',
          isOpen ? 'bg-brand-600' : 'bg-stone-100',
        )} aria-hidden>
          <Icon className={clsx('w-4 h-4', isOpen ? 'text-white' : 'text-stone-500')} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-display font-bold text-stone-900 leading-none mb-1">{item.title}</p>
          <p className="text-xs text-stone-500 leading-none">{item.summary}</p>
        </div>
        <ChevronDown
          className={clsx('w-4 h-4 text-stone-400 flex-shrink-0 transition-transform duration-200', isOpen && 'rotate-180')}
          aria-hidden
        />
      </button>
      <div
        id={`guideline-${item.id}`}
        role="region"
        className={clsx(
          'overflow-hidden transition-all duration-300 ease-in-out',
          isOpen ? 'max-h-56 opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <div className="px-4 pb-4 pt-1 border-t border-stone-100">
          <p className="text-sm text-stone-600 leading-relaxed mb-3">{item.detail}</p>
          <span className={clsx('inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border', item.badgeClass)}>
            {item.badge}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardHome() {
  const navigate = useNavigate()
  const { state } = useSessionStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [greeting, setGreeting] = useState('Good morning')

  useEffect(() => {
    const h = new Date().getHours()
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')
  }, [])

  const firstName = (state.userProfile?.full_name || state.name || 'there').split(' ')[0]

  return (
    <div className="flex flex-col bg-stone-50 animate-fade-in" style={{ height: '100dvh' }}>

      {/* ── Sticky header ──────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-3 bg-white/95 backdrop-blur-md border-b border-stone-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-600 to-brand-800 flex items-center justify-center shadow-sm flex-shrink-0" aria-hidden>
            <span className="text-white font-display font-black text-xs">PF</span>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-stone-400 leading-none">
              Poonawalla Fincorp
            </p>
            <p className="text-sm font-display font-bold text-stone-900 leading-tight">
              {greeting}, {firstName} 👋
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/dashboard')}
            className="w-9 h-9 rounded-xl bg-stone-100 border border-stone-200 flex items-center justify-center active:scale-95 transition-transform"
            aria-label="View past evaluations"
          >
            <LayoutDashboard className="w-4 h-4 text-stone-600" />
          </button>
          <button
            onClick={() => navigate('/profile', { state: { from: '/dashboard-home' } })}
            className="w-9 h-9 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center overflow-hidden active:scale-95 transition-transform"
            aria-label="Open profile"
          >
            {state.userProfile?.profile_photo_url
              ? <img src={state.userProfile.profile_photo_url} className="w-full h-full object-cover" alt={firstName} />
              : <UserRound className="w-4 h-4 text-stone-600" />}
          </button>
        </div>
      </header>

      {/* ── Scrollable body ─────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto no-scrollbar pb-6" id="main-content" tabIndex={-1}>

        {/* ── Hero evaluate card ─────────────────────────────────── */}
        <div className="mx-5 mt-5 rounded-3xl overflow-hidden shadow-lg relative">
          <div className="absolute inset-0 bg-gradient-to-br from-brand-700 via-brand-600 to-[#7A1F1F]" aria-hidden />
          <div
            className="absolute inset-0 opacity-[0.04] pointer-events-none"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg,transparent,transparent 32px,rgba(255,255,255,1) 32px,rgba(255,255,255,1) 33px),repeating-linear-gradient(90deg,transparent,transparent 32px,rgba(255,255,255,1) 32px,rgba(255,255,255,1) 33px)',
            }}
            aria-hidden
          />
          <div className="absolute -top-8 -right-8 w-44 h-44 rounded-full bg-gradient-to-br from-gold-400/20 to-gold-600/5 blur-2xl pointer-events-none" aria-hidden />
          <div className="absolute bottom-0 -left-6 w-32 h-32 rounded-full bg-gradient-to-tr from-brand-400/20 to-transparent blur-2xl pointer-events-none" aria-hidden />

          <div className="relative z-10 px-6 pt-6 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm border border-white/20">
                <Sparkles className="w-3 h-3 text-gold-300" aria-hidden />
                <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/80">AI-Powered · RBI Compliant</span>
              </div>
            </div>

            <h1 className="font-display font-black text-2xl text-white leading-tight mb-1.5">
              Evaluate Your<br />Gold Jewellery
            </h1>
            <p className="text-sm text-white/70 leading-snug mb-5">
              AI assessment in under 60 seconds.<br />Get your loan pre-qualification instantly.
            </p>

            {/* ✅ Goes directly to /setup (consent already done) */}
            <button
              onClick={() => navigate('/setup')}
              className="w-full flex items-center justify-between px-5 py-4 rounded-2xl bg-white active:scale-[0.97] transition-transform shadow-md"
              aria-label="Start gold jewellery evaluation — select item type first"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-sm" aria-hidden>
                  <Sparkles className="w-4 h-4 text-white" strokeWidth={2} />
                </div>
                <div className="text-left">
                  <p className="text-sm font-display font-black text-stone-900 leading-none mb-0.5">Start Evaluation</p>
                  <p className="text-[10px] font-medium text-stone-500 leading-none">45° angle capture first</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-brand-600 flex-shrink-0" aria-hidden />
            </button>

            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {['BIS HUID', 'RBI Norms', 'Instant'].map(chip => (
                <div key={chip} className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/10 border border-white/20">
                  <BadgeCheck className="w-3 h-3 text-gold-300" aria-hidden />
                  <span className="text-[10px] font-bold text-white/80">{chip}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Quick at-a-glance stats ────────────────────────────── */}
        <StatsStrip />

        {/* ── Live gold price ────────────────────────────────────── */}
        <div className="mt-4">
          <GoldPriceBar />
        </div>

        {/* ── Previous evaluations shortcut ─────────────────────── */}
        <div className="mx-5 mt-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="w-full flex items-center justify-between px-4 py-3.5 bg-white border border-stone-200 rounded-2xl shadow-card active:scale-[0.98] transition-transform"
            aria-label="View my past evaluations"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center" aria-hidden>
                <LayoutDashboard className="w-4 h-4 text-stone-600" />
              </div>
              <div className="text-left">
                <p className="text-sm font-display font-bold text-stone-900 leading-none mb-0.5">My Evaluations</p>
                <p className="text-[10px] text-stone-500 leading-none">View past sessions &amp; results</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-stone-400" aria-hidden />
          </button>
        </div>

        {/* ── Gold loan guidelines ───────────────────────────────── */}
        <section className="mt-6 px-5" aria-labelledby="guidelines-heading">
          <div className="flex items-center justify-between mb-1">
            <h2 id="guidelines-heading" className="font-display font-black text-lg text-stone-900">
              Gold Loan Guidelines
            </h2>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-50 border border-brand-200" aria-hidden>
              <Landmark className="w-3 h-3 text-brand-600" />
              <span className="text-[10px] font-black text-brand-600 uppercase tracking-wider">Poonawalla</span>
            </div>
          </div>
          <p className="text-xs text-stone-500 mb-4 leading-snug">
            Key eligibility criteria &amp; terms. Tap any item to expand.
          </p>
          <div className="flex flex-col gap-2.5">
            {GUIDELINES.map(item => (
              <GuidelineItem
                key={item.id}
                item={item}
                isOpen={openId === item.id}
                onToggle={() => setOpenId(openId === item.id ? null : item.id)}
              />
            ))}
          </div>
        </section>

        {/* ── Contact strip ──────────────────────────────────────── */}
        <div className="mx-5 mt-5 grid grid-cols-2 gap-3">
          <a href="tel:18001036444"
            className="flex items-center gap-2.5 px-3.5 py-3 bg-white border border-stone-200 rounded-2xl shadow-card active:scale-95 transition-transform"
            aria-label="Call Poonawalla Fincorp support"
          >
            <div className="w-8 h-8 rounded-xl bg-brand-50 flex items-center justify-center flex-shrink-0" aria-hidden>
              <Phone className="w-3.5 h-3.5 text-brand-600" />
            </div>
            <div>
              <p className="text-xs font-bold text-stone-900 leading-none mb-0.5">Call Us</p>
              <p className="text-[10px] text-stone-500 leading-none">1800-103-6444</p>
            </div>
          </a>
          <a href="https://wa.me/918888888888" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-3.5 py-3 bg-white border border-stone-200 rounded-2xl shadow-card active:scale-95 transition-transform"
            aria-label="WhatsApp Poonawalla Fincorp"
          >
            <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0" aria-hidden>
              <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
            </div>
            <div>
              <p className="text-xs font-bold text-stone-900 leading-none mb-0.5">WhatsApp</p>
              <p className="text-[10px] text-stone-500 leading-none">Chat with us</p>
            </div>
          </a>
        </div>

        {/* ── Trust footer ───────────────────────────────────────── */}
        <div className="mx-5 mt-5 p-4 rounded-2xl bg-gradient-to-r from-brand-50 to-stone-50 border border-brand-100">
          <div className="flex items-center justify-center gap-4 flex-wrap">
            {[
              { Icon: Shield,     text: 'RBI Regulated NBFC' },
              { Icon: BadgeCheck, text: 'BIS HUID Verified' },
              { Icon: Zap,        text: 'Same-Day Disbursal' },
            ].map(({ Icon, text }) => (
              <div key={text} className="flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 text-brand-600" aria-hidden />
                <span className="text-[10px] font-bold text-stone-600">{text}</span>
              </div>
            ))}
          </div>
          <p className="text-center text-[9px] font-medium text-stone-400 mt-2 tracking-wide">
            Poonawalla Fincorp Ltd · CIN: L65910MH2005PLC268542
          </p>
        </div>
      </main>

      {/* ── Sticky bottom Evaluate CTA ────────────────────────────── */}
      <div
        className="sticky bottom-0 z-20 px-5 py-3 bg-white/95 backdrop-blur-md border-t border-stone-100"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={() => navigate('/setup')}
          className="w-full py-4 rounded-2xl bg-gradient-to-r from-brand-600 to-brand-700 text-white font-display font-black text-base shadow-brand active:scale-[0.97] transition-transform flex items-center justify-center gap-2.5"
          aria-label="Evaluate my gold — select item type first"
        >
          <Sparkles className="w-5 h-5" aria-hidden />
          Evaluate My Gold
          <ChevronRight className="w-5 h-5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
