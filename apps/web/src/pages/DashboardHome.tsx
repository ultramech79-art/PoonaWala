import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import { useMetalPrices } from '../hooks/useGoldPrice'
import {
  ChevronRight, ChevronDown, TrendingUp, TrendingDown,
  Sparkles, Shield, FileCheck, Clock, Zap, Percent,
  Scale, IndianRupee, Award, BadgeCheck, LayoutDashboard,
  UserRound, Landmark, Phone, BotMessageSquare, MapPin,
  Bell, BookOpen, Headphones,
  CircleHelp,
} from 'lucide-react'
import { clsx } from 'clsx'

// ─── Gold loan guidelines from Poonawalla Fincorp ─────────────────────────────

const GUIDELINES = [
  {
    id: 'loan-amount',
    Icon: IndianRupee,
    title: 'Loan Amount',
    summary: '₹25,000 – ₹50 Lakh',
    detail:
      'Poonawalla Fincorp advertises gold loans up to ₹50 Lakh, subject to branch verification, purity, weight, KYC, and policy checks. GoldEye keeps the pre-check ready before the branch handoff.',
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
    summary: '18K to 22K BIS Hallmarked gold',
    detail:
      'Poonawalla Fincorp eligibility mentions 18K to 22K gold. BIS Hallmarked ornaments with a valid HUID make the verification trail cleaner and faster for final branch assessment.',
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
    summary: 'Starting from 11% p.a.',
    detail:
      'Poonawalla Fincorp publishes gold-loan rates starting from 11% p.a. Final pricing may vary by scheme, loan amount, tenure, and policy checks, with charges disclosed before disbursal.',
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
    <div className="gold-rate-card mx-5 rounded-2xl overflow-hidden" role="region" aria-label="Today's gold rates">
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

// ─── Hero, quick actions, and Poonawalla carousel ──────────────────────────────

const QUICK_ACTIONS = [
  { id: 'evaluations', Icon: LayoutDashboard, title: 'My Evaluations', subtitle: 'View past results' },
  { id: 'guide', Icon: BookOpen, title: 'Loan Guide', subtitle: 'Gold loan terms' },
  { id: 'branch', Icon: MapPin, title: 'Branch Locator', subtitle: 'Nearest branch' },
  { id: 'support', Icon: Headphones, title: 'Support', subtitle: 'Call or chatbot' },
]

const POONAWALLA_BRANCH_LOCATOR_URL = 'https://poonawallafincorp.com/gold-loan-branch-locator'

const HERO_AD_SLIDES = [
  {
    id: 'gold-momentum',
    tone: 'is-copper',
    Icon: IndianRupee,
    kicker: 'Poonawalla Gold Loan',
    headline: 'Gold that moves your goals.',
    copy: 'Unlock funds against jewellery with quick approval and minimal paperwork.',
    image: '/assets/hero/gold-ring-red-card.jpg',
    cta: 'Start GoldEye scan',
    metrics: [
      { value: '₹50L', label: 'Up to' },
      { value: '11%', label: 'From p.a.' },
      { value: '75%', label: 'LTV' },
    ],
  },
  {
    id: 'trust-engine',
    tone: 'is-charcoal',
    Icon: Award,
    kicker: 'Trusted Financial Brand',
    headline: 'Trust that travels with you.',
    copy: '160M+ loans, 7M+ happy customers, and AAA/Stable CRISIL & CARE rating.',
    image: '/assets/hero/gold-rings-texture.jpg',
    cta: 'Explore loan benefits',
    metrics: [
      { value: '160M+', label: 'Loans' },
      { value: '7M+', label: 'Customers' },
      { value: 'AAA', label: 'Stable' },
    ],
  },
  {
    id: 'gold-safety',
    tone: 'is-gold',
    Icon: Shield,
    kicker: 'Gold Safety Promise',
    headline: 'Secure gold. Smooth funds.',
    copy: 'Complete safety, transparent charges, and flexible repayment options.',
    image: '/assets/hero/gold-ring-red-card.jpg',
    cta: 'Check eligibility',
    metrics: [
      { value: '18-22K', label: 'Purity' },
      { value: 'Zero', label: 'Hidden fees' },
      { value: 'Fast', label: 'Approval' },
    ],
  },
]

const FAQ_ITEMS = [
  {
    question: 'What type of gold is accepted for loan?',
    answer: 'Poonawalla Fincorp accepts eligible gold jewellery, generally 18K to 22K. BIS hallmarked gold with HUID keeps verification smoother.',
  },
  {
    question: 'How much loan can I get against my gold?',
    answer: 'The eligible loan depends on purity, weight, live gold rate, LTV norms, and branch verification. Published gold loans go up to ₹50 Lakh.',
  },
  {
    question: 'How long does disbursal take?',
    answer: 'After KYC and physical gold verification, the branch can move toward same-day disbursal based on policy checks and account readiness.',
  },
  {
    question: 'What documents are required?',
    answer: 'Carry Aadhaar, PAN, and the gold ornaments being pledged. The final branch team may ask for any additional KYC detail if required.',
  },
  {
    question: 'Is my pledged gold stored safely?',
    answer: 'Gold is stored through branch-led secured handling with receipts and audit controls. Confirm vault and insurance details at handoff.',
  },
  {
    question: 'What interest rate will I get?',
    answer: 'Poonawalla Fincorp publishes gold-loan rates starting from 11% p.a. Final rate depends on amount, tenure, scheme, and policy checks.',
  },
  {
    question: 'Can I repay early or renew the loan?',
    answer: 'Repayment and renewal options depend on the chosen scheme and tenure. The branch shares the exact terms before disbursal.',
  },
  {
    question: 'Does GoldEye give final approval?',
    answer: 'GoldEye helps with a fast pre-check. Final loan approval, valuation, and disbursal happen after Poonawalla branch verification.',
  },
]

const PRIMARY_ESSENTIAL_IDS = ['loan-amount', 'ltv', 'purity', 'interest']
const PRIMARY_ESSENTIALS = GUIDELINES.filter(item => PRIMARY_ESSENTIAL_IDS.includes(item.id))
const SECONDARY_ESSENTIALS = GUIDELINES.filter(item => !PRIMARY_ESSENTIAL_IDS.includes(item.id))
const ESSENTIAL_TILE_LABEL: Record<string, string> = {
  'loan-amount': 'Loan Amount',
  ltv: 'LTV Ratio',
  purity: 'Gold Purity',
  disbursement: 'Disbursal',
  documents: 'Documents',
  interest: 'Interest Rate',
  tenure: 'Tenure',
  security: 'Security',
}
const ESSENTIAL_TILE_SUMMARY: Record<string, string> = {
  'loan-amount': '₹25K - ₹50L',
  ltv: '75% - 85% LTV',
  purity: '18K - 22K BIS',
  disbursement: 'Same-day path',
  documents: 'Aadhaar + PAN',
  interest: 'From 11% p.a.',
  tenure: '3 - 36 months',
  security: 'Insured vault',
}

function LoanEssentialsPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const selected = selectedId ? GUIDELINES.find(item => item.id === selectedId) : null
  const DetailIcon = selected?.Icon

  const renderTile = (item: typeof GUIDELINES[number], compact = false) => {
    const TileIcon = item.Icon
    const active = selectedId === item.id

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
        className={clsx('loan-essential-tile', compact && 'is-compact', active && 'is-active')}
        aria-pressed={active}
      >
        <span className="loan-essential-icon" aria-hidden>
          <TileIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 text-left">
          <span className="block truncate font-display text-[12px] font-black leading-tight">{ESSENTIAL_TILE_LABEL[item.id] || item.title}</span>
          <span className="mt-1 block truncate text-[10px] font-semibold leading-none">{ESSENTIAL_TILE_SUMMARY[item.id] || item.summary}</span>
        </span>
      </button>
    )
  }

  return (
    <section className="mt-6 px-5" aria-labelledby="guidelines-heading">
      <div className="loan-essentials-panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="guidelines-heading" className="font-display font-black text-lg leading-none text-stone-950">
              Loan Essentials
            </h2>
            <p className="mt-1.5 text-[11px] font-medium leading-snug text-stone-500">
              Key terms before branch verification.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-brand-600 px-2.5 py-1 text-white" aria-hidden>
            <Landmark className="h-3 w-3 text-white" />
            <span className="text-[10px] font-black uppercase tracking-wider">Poonawalla</span>
          </div>
        </div>

        <div className="loan-essentials-hero mt-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.13em] text-gold-200">Gold loan snapshot</p>
            <p className="mt-1 whitespace-nowrap font-display text-[18px] font-black leading-none text-white">₹50L · 11% · 75% LTV</p>
          </div>
          <span className="rounded-full bg-white/10 px-2.5 py-1.5 text-[9px] font-black text-white/72">
            Branch ready
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {PRIMARY_ESSENTIALS.map(item => renderTile(item))}
        </div>

        <div className={clsx('loan-more-terms', showMore && 'is-open')}>
          <div className="grid grid-cols-2 gap-2 pt-2">
            {SECONDARY_ESSENTIALS.map(item => renderTile(item, true))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (showMore && selectedId && SECONDARY_ESSENTIALS.some(item => item.id === selectedId)) {
              setSelectedId(null)
            }
            setShowMore(!showMore)
          }}
          className="loan-more-button mt-3"
          aria-expanded={showMore}
        >
          <span>{showMore ? 'Hide extra terms' : 'More terms'}</span>
          {showMore
            ? <ChevronDown className="h-4 w-4 rotate-180 transition-transform duration-300 ease-smooth" aria-hidden />
            : <ChevronRight className="h-4 w-4 transition-transform duration-300 ease-smooth" aria-hidden />}
        </button>

        {selected && (
          <div className="loan-essential-detail mt-3">
            <div className="flex items-start gap-3">
              <span className="loan-detail-icon" aria-hidden>
                {DetailIcon && <DetailIcon className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-black leading-none text-stone-950">{selected.title}</p>
                    <p className="mt-1 text-[11px] font-semibold text-brand-700">{selected.summary}</p>
                  </div>
                  <span className={clsx('shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black', selected.badgeClass)}>
                    {selected.badge}
                  </span>
                </div>
                <p className="mt-2 text-[11px] font-medium leading-relaxed text-stone-600">
                  {selected.detail}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function SectionHeader({
  id,
  title,
  actionLabel,
  onAction,
  expanded,
}: {
  id?: string
  title: string
  actionLabel: string
  onAction: () => void
  expanded?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="font-display text-sm font-black text-stone-950">{title}</h2>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center gap-1 text-[11px] font-black text-charcoal active:scale-[0.96] transition-transform"
      >
        {actionLabel}
        {expanded === undefined
          ? <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          : expanded
            ? <ChevronDown className="h-3.5 w-3.5 rotate-180 transition-transform duration-300 ease-smooth" aria-hidden />
            : <ChevronRight className="h-3.5 w-3.5 transition-transform duration-300 ease-smooth" aria-hidden />}
      </button>
    </div>
  )
}

function PoonawallaHeroCarousel({ onStart }: { onStart: () => void }) {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setActive(prev => (prev + 1) % HERO_AD_SLIDES.length)
    }, 4600)
    return () => window.clearInterval(id)
  }, [])

  const slide = HERO_AD_SLIDES[active]
  const { Icon } = slide

  return (
    <section className="mx-5 mt-3" aria-label="Poonawalla Fincorp offers">
      <div className={clsx('poonawalla-ad-card', slide.tone)}>
        <div className="ad-card-media" aria-hidden>
          <img src={slide.image} alt="" />
        </div>

        <div className="relative z-10 flex min-h-[238px] flex-col">
          <div className="flex items-center justify-between gap-3">
            <span className="ad-brand-pill">
              <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" />
            </span>
            <span className="ad-slide-count">{active + 1}/{HERO_AD_SLIDES.length}</span>
          </div>

          <div className="mt-auto">
            <div className="max-w-[17rem]">
              <span className="ad-kicker">
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {slide.kicker}
              </span>
              <h1 className="mt-2.5 font-display text-[26px] font-black leading-[1] tracking-[-0.032em] text-white">
                {slide.headline}
              </h1>
              <p className="mt-2.5 max-w-[14.5rem] text-xs font-medium leading-snug text-white/72">
                {slide.copy}
              </p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              {slide.metrics.map(metric => (
                <div key={`${slide.id}-${metric.label}`} className="ad-stat">
                  <b>{metric.value}</b>
                  <small>{metric.label}</small>
                </div>
              ))}
            </div>

            <div className="mt-3.5 flex items-center gap-3">
              <button
                type="button"
                onClick={onStart}
                className="ad-cta group flex-1 active:scale-[0.98] transition-transform"
              >
                <span>{slide.cta}</span>
                <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
              <div className="flex gap-1.5" aria-label="Hero ad slides">
                {HERO_AD_SLIDES.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActive(idx)}
                    className={clsx('ad-dot', idx === active && 'is-active')}
                    aria-label={`Show ${item.headline}`}
                    aria-current={idx === active}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function FaqPreviewCard() {
  const [expanded, setExpanded] = useState(false)
  const [openQuestion, setOpenQuestion] = useState<string | null>(null)
  const primaryQuestions = FAQ_ITEMS.slice(0, 3)
  const extraQuestions = FAQ_ITEMS.slice(3)

  const toggleExpanded = () => {
    if (expanded) setOpenQuestion(null)
    setExpanded(!expanded)
  }

  const renderFaqItem = (item: typeof FAQ_ITEMS[number]) => (
    <div key={item.question} className="faq-preview-item">
      <button
        type="button"
        onClick={() => setOpenQuestion(openQuestion === item.question ? null : item.question)}
        className="faq-preview-row"
        aria-expanded={openQuestion === item.question}
      >
        <CircleHelp className="h-4 w-4 flex-shrink-0 text-gold-700" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-stone-700">
          {item.question}
        </span>
        <ChevronDown
          className={clsx('h-4 w-4 flex-shrink-0 text-stone-500 transition-transform duration-300 ease-smooth', openQuestion === item.question && 'rotate-180')}
          aria-hidden
        />
      </button>
      <div className={clsx('faq-preview-answer', openQuestion === item.question && 'is-open')}>
        <p>{item.answer}</p>
      </div>
    </div>
  )

  return (
    <section className="mx-5 mt-3" aria-labelledby="faq-preview-heading">
      <div className="dashboard-bottom-card overflow-hidden">
        <div className="px-3.5 pt-3.5 pb-2">
          <SectionHeader
            id="faq-preview-heading"
            title="Frequently Asked Questions"
            actionLabel={expanded ? 'Show Less' : 'View All'}
            onAction={toggleExpanded}
            expanded={expanded}
          />
        </div>

        <div className={clsx('faq-preview-list', expanded && 'is-expanded')}>
          {primaryQuestions.map(renderFaqItem)}
          <div className={clsx('faq-extra-list', expanded && 'is-open')} aria-hidden={!expanded}>
            {extraQuestions.map(renderFaqItem)}
          </div>
            </div>
      </div>
    </section>
  )
}

function QuickActions({ onAction }: { onAction: (id: string) => void }) {
  return (
    <section className="mx-5 mt-4" aria-label="Quick actions">
      <div className="quick-actions-panel">
        <h2 className="px-1 pb-2 font-display text-sm font-black text-stone-950">Quick Actions</h2>
        <div className="grid grid-cols-4 gap-2">
          {QUICK_ACTIONS.map(({ id, Icon, title, subtitle }) => (
            <button
              key={id}
              type="button"
              onClick={() => onAction(id)}
              className="quick-action-tile active:scale-[0.97] transition-transform"
            >
              <Icon className="mx-auto h-5 w-5 text-gold-700" strokeWidth={1.9} aria-hidden />
              <span className="mt-2 block text-[10px] font-display font-black leading-tight text-stone-950">{title}</span>
              <span className="mt-0.5 block text-[8px] font-medium leading-tight text-stone-400">{subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
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
  const location = useLocation()
  const { state } = useSessionStore()
  const [greeting, setGreeting] = useState('Good morning')
  const assistantOpen = location.pathname === '/chatbot'

  useEffect(() => {
    const h = new Date().getHours()
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')
  }, [])

  const fullName = state.userProfile?.full_name || state.name || ''
  const isGuest = !state.authToken || state.authToken === 'guest' || fullName === 'Guest User'
  const firstName = isGuest ? 'Guest' : (fullName.split(' ')[0] || 'there')
  const initials = fullName && !isGuest
    ? fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()
    : ''

  const startEvaluation = () => {
    navigate(isGuest ? '/register' : '/setup')
  }

  const handleQuickAction = (id: string) => {
    if (id === 'evaluations') {
      navigate('/my-evaluations')
      return
    }
    if (id === 'guide') {
      document.getElementById('guidelines-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (id === 'support') {
      navigate('/chatbot')
      return
    }
    if (id === 'branch') {
      window.location.href = POONAWALLA_BRANCH_LOCATOR_URL
      return
    }
    navigate('/dashboard-home')
  }

  return (
    <div className="flex flex-col app-page-bg animate-fade-in relative z-[5]" style={{ height: '100dvh' }}>

      {/* ── Sticky header ──────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-3 bg-white/80 backdrop-blur-xl border-b border-stone-200/70">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-2xl bg-charcoal flex items-center justify-center shadow-xs flex-shrink-0" aria-hidden>
            <span className="text-gold-200 font-display font-black text-xs">PF</span>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-stone-400 leading-none">
              Poonawalla Fincorp
            </p>
            <p className="text-sm font-display font-bold text-stone-900 leading-tight tracking-[-0.01em]">
              {greeting}, {firstName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="w-10 h-10 rounded-2xl bg-stone-100 text-stone-700 active:scale-95 transition-transform flex items-center justify-center"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5" strokeWidth={1.8} />
          </button>
          <button
            onClick={() => isGuest
              ? navigate('/register')
              : navigate('/profile', { state: { from: '/dashboard-home' } })
            }
            className="w-10 h-10 rounded-2xl overflow-hidden active:scale-95 transition-transform shadow-sm border border-stone-200 flex items-center justify-center"
            style={{ background: isGuest ? '#F0EDE8' : 'linear-gradient(135deg, #1C1A18 0%, #2C2820 100%)' }}
            aria-label={isGuest ? 'Create account' : 'Open profile'}
          >
            {state.userProfile?.profile_photo_url && !isGuest
              ? <img src={state.userProfile.profile_photo_url} className="w-full h-full object-cover" alt={firstName} />
              : isGuest
                ? <UserRound className="w-5 h-5 text-stone-500" strokeWidth={1.8} />
                : <span className="text-[13px] font-black text-gold-300 tracking-tight">{initials}</span>}
          </button>
        </div>
      </header>

      {/* ── Scrollable body ─────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto no-scrollbar pb-6" id="main-content" tabIndex={-1}>
        {/* ── Hero evaluate card ─────────────────────────────────── */}
        <PoonawallaHeroCarousel onStart={startEvaluation} />

        {/* ── Live gold price ────────────────────────────────────── */}
        <div className="mt-4">
          <GoldPriceBar />
        </div>

        <QuickActions onAction={handleQuickAction} />

        <LoanEssentialsPanel />
        <FaqPreviewCard />

        {/* ── Contact strip ──────────────────────────────────────── */}
        <div id="contact-strip" className="mx-5 mt-5 grid grid-cols-2 gap-3">
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
          <button
            type="button"
            onClick={() => navigate('/chatbot')}
            className="flex items-center gap-2.5 px-3.5 py-3 bg-white border border-stone-200 rounded-2xl shadow-card active:scale-95 transition-transform"
            aria-label="Open GoldEye chatbot"
          >
            <div className="w-8 h-8 rounded-xl bg-gold-50 flex items-center justify-center flex-shrink-0" aria-hidden>
              <BotMessageSquare className="w-3.5 h-3.5 text-gold-800" />
            </div>
            <div className="text-left">
              <p className="text-xs font-bold text-stone-900 leading-none mb-0.5">Chatbot</p>
              <p className="text-[10px] text-stone-500 leading-none">Ask GoldEye</p>
            </div>
          </button>
        </div>

        {/* ── Trust footer ───────────────────────────────────────── */}
        <div className="mx-5 mt-5 p-4 rounded-2xl surface-panel">
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

      {/* ── Chatbot bubble ───────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => {
          if (!assistantOpen) navigate('/chatbot')
        }}
        className={clsx(
          'assistant-bubble absolute z-[60] transition-transform',
          assistantOpen ? 'is-open' : 'active:scale-95'
        )}
        aria-label={assistantOpen ? 'GoldEye assistant is open' : 'Open GoldEye assistant'}
        aria-pressed={assistantOpen}
      >
        <img
          src="/assets/tutorial/1d64f64e-dfe1-11ee-a390-a7bd47dd18d6%20(1).gif"
          alt="GoldEye Assistant"
          className="w-full h-full object-contain"
          draggable={false}
        />
      </button>

      {/* ── Sticky bottom Evaluate CTA ────────────────────────────── */}
      <div
        className="sticky bottom-0 z-20 px-5 py-3 bg-white/90 backdrop-blur-xl border-t border-stone-200/70"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={startEvaluation}
          className="w-full py-4 rounded-2xl bg-charcoal text-white font-display font-black text-base shadow-cta active:scale-[0.98] transition-transform flex items-center justify-center gap-2.5"
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
