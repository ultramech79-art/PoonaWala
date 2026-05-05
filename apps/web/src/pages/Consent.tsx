import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import { initSessionAPI, recordConsentAPI } from '../lib/api'
import {
  Camera, ScanLine, Cpu, Tag,
  CheckCircle, ChevronRight, ShieldCheck
} from 'lucide-react'
import { clsx } from 'clsx'

export function Consent() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const HOW_IT_WORKS = [
    { icon: Camera, title: t('consent_step1_title'), desc: t('consent_step1_desc') },
    { icon: ScanLine, title: t('consent_step2_title'), desc: t('consent_step2_desc') },
    { icon: Cpu, title: t('consent_step3_title'), desc: t('consent_step3_desc') },
    { icon: Tag, title: t('consent_step4_title'), desc: t('consent_step4_desc') },
  ]

  const CONSENT_POINTS = [
    t('consent_privacy1'),
    t('consent_privacy2'),
    t('consent_privacy3'),
  ]
  const { setConsent, initSession, setSessionId } = useSessionStore()
  const [loading, setLoading] = useState(false)
  const [agreed, setAgreed] = useState(false)

  const accept = async () => {
    if (!agreed) return
    setLoading(true)
    const lang = localStorage.getItem('goldeye_lang') ?? 'en'
    try {
      const { session_id } = await initSessionAPI(lang)
      setSessionId(session_id)
      recordConsentAPI(session_id).catch(() => {})
    } catch {
      initSession()
    } finally {
      setLoading(false)
      setConsent()
      navigate('/otp')
    }
  }

  const decline = () => navigate('/language')

  return (
    <div className="page animate-slide-up">
      {/* Header */}
      <div className="page-header">
        <button id="consent-back" onClick={() => navigate('/language')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">Before We Begin</span>
        <div className="w-11" />
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        {/* How It Works */}
        <div className="pt-6 pb-8">
          <h2 className="font-display font-bold text-xl text-stone-900 mb-1">How It Works</h2>
          <p className="text-sm text-stone-500 mb-6">6 simple steps to get your gold loan offer</p>

          <div className="grid grid-cols-2 gap-3">
            {HOW_IT_WORKS.map(({ icon: Icon, title, desc }, i) => (
              <div key={title} className="card p-4">
                <div className="w-10 h-10 rounded-2xl bg-brand-50 flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-brand-600" strokeWidth={1.8} />
                </div>
                <p className="font-display font-semibold text-sm text-stone-900 mb-0.5">{title}</p>
                <p className="text-xs text-stone-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Consent points */}
        <div className="card p-5 mb-5">
          <div className="flex items-center gap-2.5 mb-4">
            <ShieldCheck className="w-5 h-5 text-brand-600" strokeWidth={2} />
            <h3 className="font-display font-semibold text-base text-stone-900">Privacy Promise</h3>
          </div>
          <div className="space-y-3">
            {CONSENT_POINTS.map(point => (
              <div key={point} className="flex items-start gap-3">
                <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.5} />
                <span className="text-sm text-stone-700 leading-snug">{point}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Agreement checkbox */}
        <button
          onClick={() => setAgreed(a => !a)}
          className={clsx(
            "w-full flex items-start gap-3 p-4 rounded-2xl border transition-all duration-200 mb-6 text-left",
            agreed ? "border-brand-600 bg-brand-50" : "bg-white border-stone-200"
          )}
        >
          <div className={clsx(
            "w-5 h-5 rounded-md flex-shrink-0 mt-0.5 flex items-center justify-center transition-all",
            agreed ? "bg-brand-600" : "bg-white border-2 border-stone-300"
          )}>
            {agreed && <CheckCircle className="w-4 h-4 text-white" strokeWidth={3} />}
          </div>
          <span className="text-sm text-stone-700 leading-relaxed">
            I agree to the{' '}
            <span className="text-brand-600 font-medium">Terms & Conditions</span>
            {' '}and{' '}
            <span className="text-brand-600 font-medium">Privacy Policy</span>
          </span>
        </button>
      </div>

      {/* Actions */}
      <div className="px-5 pb-6 pt-4 border-t border-stone-200 space-y-3">
        <button
          id="consent-accept"
          onClick={accept}
          disabled={loading || !agreed}
          className="btn-primary w-full"
        >
          {loading ? t('loading') : 'I Agree & Continue'}
          {!loading && <ChevronRight className="w-5 h-5" />}
        </button>
        <button id="consent-decline" onClick={decline} className="btn-secondary w-full text-sm">
          {t('consent_decline')}
        </button>
      </div>
    </div>
  )
}
