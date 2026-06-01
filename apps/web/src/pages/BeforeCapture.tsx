import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Camera, Zap, Brain, FileText, CheckCircle2 } from 'lucide-react'
import { clsx } from 'clsx'
import { useSessionStore } from '../store/session'

export function BeforeCapture() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { state } = useSessionStore()
  const [agreed, setAgreed] = useState(false)

  const steps = [
    {
      icon: Camera,
      title: 'Capture in clear light',
      desc: 'Get sharp photos of your gold pieces'
    },
    {
      icon: Zap,
      title: 'Our AI analyzes instantly',
      desc: 'Purity, weight, and market value'
    },
    {
      icon: Brain,
      title: 'Smart valuation',
      desc: 'Real-time assessment with confidence scores'
    },
    {
      icon: FileText,
      title: 'Instant pre-qualified offer',
      desc: 'Loan amount in seconds, no waiting'
    },
  ]

  return (
    <div className="page animate-slide-up" style={{ position: 'relative', zIndex: 4, isolation: 'isolate' }}>
      {/* Grid background */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          backgroundImage: `
            linear-gradient(rgba(120,113,108,0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(120,113,108,0.08) 1px, transparent 1px)
          `,
          backgroundSize: '28px 28px',
        }}
      />

      {/* Header with back button */}
      <div className="relative z-10 flex items-center gap-3 px-5 pt-6 pb-1">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-stone-950 text-white active:opacity-70 transition-opacity"
        >
          <ArrowLeft className="w-4 h-4" strokeWidth={2.2} />
        </button>
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        {/* Heading */}
        <div className="pt-3 pb-7">
          <h1 className="font-display font-black text-4xl leading-[1.1] tracking-[-0.04em] text-stone-950 mb-2">
            Before we begin
          </h1>
          <p className="text-sm text-stone-500 font-medium">
            Quick 4-step process to get your instant loan offer:
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-2.5 mb-8">
          {steps.map((step, idx) => {
            const Icon = step.icon
            return (
              <div
                key={idx}
                className="flex gap-4 bg-gradient-to-r from-white to-amber-50/30 rounded-2xl p-4 border border-amber-200/30 hover:border-amber-300/50 hover:shadow-md transition-all duration-200"
              >
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-gradient-to-br from-amber-100 to-yellow-50 flex-shrink-0 border border-amber-200/30 shadow-sm">
                  <Icon className="w-5 h-5" style={{ color: '#92400E' }} strokeWidth={2.3} />
                </div>
                <div className="flex-1 py-0.5">
                  <p className="text-sm font-bold text-stone-950 leading-tight">{step.title}</p>
                  <p className="text-xs text-stone-500 mt-1">{step.desc}</p>
                </div>
              </div>
            )
          })}
        </div>

        {/* ₹10 coin info */}
        <div className="bg-gradient-to-br from-amber-50/80 to-yellow-50/50 rounded-2xl p-5 mb-6 border border-amber-200/40 shadow-sm">
          <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-3">Our scale reference</p>
          <div className="flex gap-4 items-start">
            <div className="flex-1">
              <p className="text-base font-black text-stone-950 mb-2 leading-snug">
                Place a ₹10 coin nearby
              </p>
              <p className="text-xs text-stone-500 leading-relaxed">
                Exactly 27mm across — used as a scale reference, white-balance anchor, and fraud check.
              </p>
            </div>
            <div className="flex-shrink-0 w-28 h-28 flex items-center justify-center">
              <img
                src="/assets/items/coin.png"
                alt="₹10 coin"
                className="w-28 h-28 object-contain"
              />
            </div>
          </div>
        </div>

        {/* Consent checkbox */}
        <label className="flex items-start gap-3 mb-6 p-4 bg-gradient-to-r from-white to-amber-50/20 rounded-2xl border border-amber-200/40 cursor-pointer hover:border-amber-300/60 hover:shadow-sm transition-all group">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="w-5 h-5 mt-1 accent-amber-700 cursor-pointer"
          />
          <span className="text-xs text-stone-600 leading-relaxed group-hover:text-stone-700 transition-colors">
            I agree to the collection and use of my data as explained above and per{' '}
            <span className="font-semibold text-amber-900">PDPA Act</span>.
          </span>
        </label>
      </div>

      {/* Continue button */}
      <div className="relative z-10 px-5 pb-6 pt-4 border-t border-stone-200/80 bg-white/70 backdrop-blur-xl">
        <button
          onClick={() => navigate('/capture')}
          disabled={!agreed}
          className={clsx(
            'w-full py-4 rounded-2xl font-semibold text-white transition-all duration-200 active:scale-[0.97]',
            agreed
              ? 'bg-stone-950 shadow-xl shadow-stone-900/20 hover:shadow-2xl'
              : 'bg-stone-200 text-stone-400 cursor-not-allowed'
          )}
        >
          Continue
        </button>
      </div>
    </div>
  )
}
