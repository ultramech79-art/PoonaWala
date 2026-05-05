import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ArrowRight, Gem, Circle, Sparkles, RotateCcw, Link2, Package } from 'lucide-react'
import { clsx } from 'clsx'

export function Setup() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const ITEM_TYPES = [
    { id: 'necklace', icon: Gem,       label: t('item_necklace') },
    { id: 'ring',     icon: Circle,    label: t('item_ring') },
    { id: 'earrings', icon: Sparkles,  label: t('item_earrings') },
    { id: 'bangles',  icon: RotateCcw, label: t('item_bangles') },
    { id: 'chain',    icon: Link2,     label: t('item_chain') },
    { id: 'other',    icon: Package,   label: t('item_other') },
  ]
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <div className="page animate-slide-up">
      {/* Header */}
      <div className="page-header">
        <button id="setup-back" onClick={() => navigate('/otp')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">Select Item</span>
        <div className="w-11" />
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        {/* Heading */}
        <div className="pt-6 pb-8">
          <h1 className="font-display font-bold text-2xl text-stone-900 mb-1">
            What are you assessing?
          </h1>
          <p className="text-sm text-stone-500">Select the type of gold item</p>
        </div>

        {/* Item type grid */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          {ITEM_TYPES.map(({ id, icon: Icon, label }) => {
            const active = selected === id
            return (
              <button
                key={id}
                onClick={() => setSelected(id)}
                className={clsx(
                  'flex flex-col items-center gap-3 p-4 rounded-2xl border-2 transition-all duration-200 active:scale-[0.96]',
                  active
                    ? 'border-brand-500 bg-brand-50 shadow-brand-sm'
                    : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50'
                )}
              >
                <div className={clsx(
                  'w-11 h-11 rounded-2xl flex items-center justify-center transition-colors',
                  active ? 'bg-brand-500' : 'bg-stone-100'
                )}>
                  <Icon className={clsx('w-5 h-5', active ? 'text-white' : 'text-stone-500')} strokeWidth={1.8} />
                </div>
                <span className={clsx(
                  'text-xs font-semibold transition-colors',
                  active ? 'text-brand-700' : 'text-stone-700'
                )}>
                  {label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Setup tips */}
        <div className="card p-5 mb-4">
          <h3 className="font-display font-semibold text-sm text-stone-900 mb-3">Setup Tips</h3>
          <div className="space-y-3">
            {[
              { n: 1, text: t('setup_tip1') },
              { n: 2, text: t('setup_tip2') },
              { n: 3, text: t('setup_tip3') },
            ].map(({ n, text }) => (
              <div key={n} className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-brand-50 border border-brand-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-brand-600">{n}</span>
                </div>
                <p className="text-sm text-stone-600 leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Coin callout */}
        <div className="card-gold p-4 mb-2">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-gold-200 border-2 border-gold-300 flex items-center justify-center flex-shrink-0">
              <span className="text-[10px] font-bold text-gold-700">₹10</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-gold-800 mb-0.5">Place a ₹10 coin nearby</p>
              <p className="text-xs text-gold-700/80 leading-relaxed">
                Exactly 27mm across — used as a scale reference, white-balance anchor, and fraud check.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 pb-6 pt-4 border-t border-stone-200">
        <button
          id="setup-ready"
          onClick={() => navigate('/capture')}
          disabled={!selected}
          className={clsx('w-full text-lg py-4', selected ? 'btn-primary' : 'btn-secondary opacity-50 cursor-not-allowed')}
        >
          {t('setup_ready')}
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
