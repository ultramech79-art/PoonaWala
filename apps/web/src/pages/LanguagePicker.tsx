import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import i18n from '../i18n'
import { Globe, CheckCircle, Eye, ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'

const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'mr', label: 'Marathi', native: 'मराठी', disabled: true },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', disabled: true },
  { code: 'te', label: 'Telugu', native: 'తెలుగు', disabled: true },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', disabled: true },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી', disabled: true },
  { code: 'bn', label: 'Bengali', native: 'বাংলা', disabled: true },
]

export function LanguagePicker() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setLang, state } = useSessionStore()

  const select = (code: string) => {
    setLang(code)
    i18n.changeLanguage(code)
    navigate(state.authToken ? '/consent' : '/auth')
  }

  return (
    <div className="page animate-fade-in">
      {/* Back Button */}
      <div className="px-5 pt-4 pb-2">
        <button
          onClick={() => navigate('/')}
          className="btn-icon"
          title="Go back"
        >
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center pt-8 pb-8 px-5">
        <div className="w-14 h-14 rounded-2xl bg-brand-50 flex items-center justify-center mb-5 shadow-card border border-brand-200">
          <Eye className="w-7 h-7 text-brand-600" strokeWidth={2} />
        </div>
        <h1 className="font-display font-bold text-2xl text-stone-900 text-center mb-1">
          {t('lang_picker_title')}
        </h1>
        <p className="text-sm text-stone-500 text-center">
          {t('lang_picker_subtitle')}
        </p>
      </div>

      {/* Language list */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
        <div className="space-y-2">
          {LANGUAGES.map(lang => {
            const selected = state.lang === lang.code
            return (
              <button
                key={lang.code}
                id={`lang-${lang.code}`}
                onClick={() => !lang.disabled && select(lang.code)}
                disabled={lang.disabled}
                className={clsx(
                  'w-full flex items-center justify-between px-4 py-4 rounded-2xl border transition-all duration-200',
                    lang.disabled
                      ? 'opacity-35 cursor-not-allowed bg-stone-100 border-stone-200'
                      : selected
                        ? 'bg-brand-50 border-brand-600 shadow-brand-sm'
                        : 'bg-white border-stone-200 hover:border-stone-300 hover:bg-stone-50 active:scale-[0.98]'
                )}
              >
                <div className="flex items-center gap-3">
                  <Globe className={clsx('w-5 h-5', selected ? 'text-brand-600' : 'text-stone-400')} />
                  <div className="text-left">
                    <p className={clsx('font-display font-semibold text-base', selected ? 'text-brand-700' : 'text-stone-900')}>
                      {lang.native}
                    </p>
                    <p className="text-xs text-stone-500">{lang.label}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {lang.disabled && (
                    <span className="text-[10px] text-stone-400 font-medium uppercase tracking-wide">Soon</span>
                  )}
                  {selected && !lang.disabled && (
                    <CheckCircle className="w-5 h-5 text-brand-600" />
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
