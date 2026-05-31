import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import i18n from '../i18n'
import { ArrowLeft, Check } from 'lucide-react'
import { clsx } from 'clsx'

const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', sub: 'Default' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', sub: 'Hindi' },
]

export function LanguagePicker() {
  const navigate = useNavigate()
  const { setLang, state } = useSessionStore()
  const [selectedLang, setSelectedLang] = useState(state.lang || 'en')

  const continueWithLanguage = () => {
    setLang(selectedLang)
    i18n.changeLanguage(selectedLang)
    navigate(state.authToken ? '/consent' : '/register')
  }

  return (
    <div className="page language-page animate-fade-in">
      {/* Back */}
      <div className="px-5 pt-5 pb-0">
        <button
          onClick={() => navigate('/')}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-stone-950 text-white transition-opacity active:opacity-70"
          title="Go back"
        >
          <ArrowLeft className="w-4 h-4" strokeWidth={2} />
        </button>
      </div>

      {/* Header */}
      <div className="flex flex-col px-6 pt-10 pb-10">
        <h1 className="font-display font-bold text-[36px] text-stone-950 leading-[1.1] tracking-[-0.03em]">
          Choose your<br />language
        </h1>
        <p className="text-[15px] text-stone-500 mt-3 leading-relaxed">
          You can change this anytime in settings.
        </p>
      </div>

      {/* Language list */}
      <div className="flex-1 px-5 pb-8">
        <div className="space-y-2.5">
          {LANGUAGES.map(lang => {
            const selected = selectedLang === lang.code
            return (
              <button
                key={lang.code}
                id={`lang-${lang.code}`}
                onClick={() => setSelectedLang(lang.code)}
                className={clsx(
                  'w-full flex items-center justify-between px-5 py-5 rounded-2xl border transition-all duration-150 text-left',
                  selected
                    ? 'language-row-selected'
                    : 'language-row active:scale-[0.99]'
                )}
              >
                <div className="flex flex-col gap-0.5">
                  <p className={clsx(
                    'font-display font-semibold text-[22px] tracking-[-0.02em] leading-tight',
                    selected ? 'text-stone-950' : 'text-stone-800'
                  )}>
                    {lang.native}
                  </p>
                  <p className="text-[13px] text-stone-400 font-medium">{lang.label}</p>
                </div>
                <span className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded-full transition-all',
                  selected ? 'bg-stone-950' : 'bg-transparent border border-[#D6D1C8]'
                )}>
                  {selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="px-5 pb-8 pt-2">
        <button onClick={continueWithLanguage} className="language-continue w-full">
          Continue
        </button>
      </div>
    </div>
  )
}
