import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import { Scale, ChevronRight, ArrowRight, AlertCircle, CheckCircle } from 'lucide-react'

export function WeightEntry() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setWeight, setHuid } = useSessionStore()

  const [value, setValue] = useState('')
  const [huid, setHuidValue] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [skipped, setSkipped] = useState(false)

  const grams = parseFloat(value)
  const valid = !isNaN(grams) && grams >= 0.5 && grams <= 500

  const proceed = (w: number | null) => {
    setWeight(w)
    setHuid(huid || null)
    navigate('/processing')
  }

  const ACCURACY_ROWS = [
    { label: t('weight_accuracy_scale'), band: '±8%', pct: '85%', color: 'bg-emerald-500' },
    { label: t('weight_accuracy_video'), band: '±22%', pct: '55%', color: 'bg-gold-400' },
    { label: t('weight_accuracy_none'), band: '±35%', pct: '30%', color: 'bg-orange-400' },
  ]

  return (
    <div className="page animate-slide-up">
      {/* Header */}
      <div className="page-header">
        <button id="weight-back" onClick={() => navigate('/capture')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">Weight Entry</span>
        <div className="w-11" />
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        {/* Icon */}
        <div className="flex flex-col items-center pt-6 pb-8">
          <div className="w-16 h-16 rounded-2xl bg-gold-50 border border-gold-200 flex items-center justify-center mb-5">
            <Scale className="w-8 h-8 text-gold-600" strokeWidth={1.8} />
          </div>
          <h1 className="font-display font-bold text-2xl text-stone-900 text-center mb-1.5">
            {t('weight_heading')}
          </h1>
          <p className="text-sm text-stone-500 text-center leading-relaxed max-w-xs">
            {t('weight_body')}
          </p>
        </div>

        {/* Input */}
        <div className="mb-5">
          <label className="label mb-2 block">{t('weight_label')}</label>
          <div className="relative">
            <input
              id="weight-input"
              type="number"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder={t('weight_placeholder')}
              className="input-field pr-20 text-xl font-mono font-bold"
              step="0.1"
              min="0.5"
              max="500"
              inputMode="decimal"
              autoFocus
            />
            <div className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-stone-400 font-medium">
              grams
            </div>
          </div>
          {value && !valid && (
            <p className="text-xs text-red-500 mt-2 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Weight must be between 0.5g and 500g
            </p>
          )}
          {valid && (
            <p className="text-xs text-emerald-600 mt-2 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" />
              {grams}g entered — this improves accuracy significantly
            </p>
          )}
        </div>

        {/* HUID input moved to Hallmark screen */}
        {/* How to weigh tip */}
        <div className="card p-4 mb-6">

          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center flex-shrink-0">
              <Scale className="w-4.5 h-4.5 text-stone-500" strokeWidth={2} />
            </div>
            <div>
              <p className="text-sm font-semibold text-stone-900 mb-0.5">Kitchen scale tip</p>
              <p className="text-xs text-stone-500 leading-relaxed">
                A kitchen scale (₹200–400 online) gives accurate readings. Remove clasps if possible, write down in grams.
              </p>
            </div>
          </div>
        </div>

        {/* Accuracy chart */}
        <div className="card-gold p-4 mb-2">
          <h3 className="text-xs font-semibold text-gold-700 uppercase tracking-wider mb-3">
            Impact on loan band width
          </h3>
          {ACCURACY_ROWS.map(row => (
            <div key={row.label} className="flex items-center gap-3 mb-2.5">
              <p className="text-xs text-stone-600 w-32 flex-shrink-0">{row.label}</p>
              <div className="flex-1 band-track">
                <div className={`${row.color} band-fill`} style={{ width: row.pct }} />
              </div>
              <span className="text-xs font-mono text-stone-600 w-9 text-right">{row.band}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 pb-6 pt-4 border-t border-stone-200 space-y-3">
        <button
          id="weight-continue"
          onClick={() => proceed(grams)}
          disabled={!valid}
          className={valid ? 'btn-primary w-full' : 'btn-secondary w-full opacity-50 cursor-not-allowed'}
        >
          {t('weight_continue')}
          <ArrowRight className="w-5 h-5" />
        </button>
        <button
          id="weight-skip"
          onClick={() => proceed(null)}
          className="btn-secondary w-full text-sm"
        >
          {t('weight_skip')}
        </button>
      </div>
    </div>
  )
}
