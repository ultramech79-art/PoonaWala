import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Delete, Check, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import { checkPhoneAPI, passwordLoginAPI } from '../lib/api'
import { useSessionStore } from '../store/session'

export function Login() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setAuth } = useSessionStore()

  const [step, setStep] = useState<1 | 2>(1)
  const [animKey, setAnimKey] = useState(0)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')

  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [pinShake, setPinShake] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const finishLogin = useCallback(() => {
    setDone(true)
    setTimeout(() => navigate('/dashboard-home'), 1900)
  }, [navigate])

  const advance = useCallback(() => {
    setDir('fwd'); setAnimKey(k => k + 1); setStep(2); setError(''); setBusy(false)
  }, [])

  const handleContinue = async () => {
    if (phone.length !== 10) return
    setBusy(true)
    setError('')
    try {
      const res = await checkPhoneAPI(phone)
      if (!res.registered) {
        setError(t('login_err_not_registered'))
        return
      }
      if (!res.has_pin) {
        setError(t('login_err_no_pin'))
        return
      }
      advance()
    } catch (e: any) {
      setError(e.message || t('login_err_verify'))
    } finally {
      setBusy(false)
    }
  }

  const retreat = useCallback(() => {
    setDir('back'); setAnimKey(k => k + 1); setStep(1); setPin(''); setError('')
  }, [])

  const handlePinPress = (key: string) => {
    if (key === '⌫') { setPin(p => p.slice(0, -1)); return }
    const next = pin + key
    if (next.length > 6) return
    setPin(next)
    if (next.length === 6) setTimeout(() => verifyPin(next), 260)
  }

  const verifyPin = async (enteredPin: string) => {
    setBusy(true)
    setError('')
    try {
      const res = await passwordLoginAPI(phone, enteredPin)
      setAuth(res.access_token, res.user)
      finishLogin()
    } catch (e: any) {
      const message = String(e?.message || '')
      if (message.includes('pin_not_set')) {
        setPinShake(true)
        setTimeout(() => {
          setPin('')
          setPinShake(false)
          setBusy(false)
          setError(t('login_err_no_pin'))
        }, 480)
        return
      }
      setPinShake(true)
      setTimeout(() => { setPin(''); setPinShake(false); setBusy(false); setError(t('login_err_wrong_pin')) }, 480)
    }
  }

  const btnCls = 'w-full h-[60px] rounded-2xl bg-stone-950 text-white font-semibold text-[16px] tracking-[-0.01em] disabled:opacity-25 active:opacity-75 transition-opacity'

  if (done) {
    return (
      <div className="page flex flex-col items-center justify-center" style={{ background: '#FDFDFC' }}>
        <div className="flex flex-col items-center text-center animate-fade-in">
          <div className="w-24 h-24 rounded-full bg-stone-950 flex items-center justify-center animate-slide-up">
            <Check className="w-11 h-11 text-white" strokeWidth={2.5} />
          </div>
          <h1 className="font-display font-bold text-[30px] text-stone-950 tracking-[-0.03em] mt-7">
            {t('login_welcome_back')}
          </h1>
          <p className="text-[15px] text-stone-500 mt-2">{t('login_signing_in')}</p>
          <Loader2 className="w-5 h-5 text-stone-400 animate-spin mt-6" />
        </div>
      </div>
    )
  }

  return (
    <div className="page" style={{ position: 'relative' }}>

      {/* Progress bar */}
      <div className="h-[3px] bg-stone-100">
        <div className="h-full transition-all duration-500 ease-out"
          style={{ width: step === 1 ? '50%' : '100%', background: '#C0392B' }} />
      </div>

      {/* Top bar */}
      <div className="flex items-center px-5 pt-4 pb-1 relative z-10">
        <button
          onClick={step === 1 ? () => navigate(-1) : retreat}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-stone-950 text-white active:opacity-70 transition-opacity"
        >
          <ArrowLeft className="w-4 h-4" strokeWidth={2.2} />
        </button>
      </div>

      <div key={animKey} className={clsx('flex-1 flex flex-col relative z-10', dir === 'fwd' ? 'register-step-fwd' : 'register-step-back')}>

        {/* Step 1: Phone */}
        {step === 1 && (
          <>
            <div className="px-6 pt-7 pb-6">
              <h1 className="font-display font-bold text-[34px] text-stone-950 leading-[1.08] tracking-[-0.03em]">
                {t('login_welcome_back')}
              </h1>
              <p className="text-[15px] text-stone-500 mt-3 leading-relaxed">
                {t('login_enter_mobile')}
              </p>
            </div>

            {error && (
              <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-[13px] font-medium">{error}</div>
            )}

            <div className="flex-1 flex flex-col px-6">
              <div className="flex-1">
                <div className="flex gap-3">
                  <div className="flex items-center justify-center h-[60px] px-4 bg-white border border-[#E2DDD6] rounded-2xl shrink-0">
                    <span className="text-[17px] font-bold text-stone-500">+91</span>
                  </div>
                  <input
                    autoFocus
                    type="tel"
                    inputMode="numeric"
                    value={phone}
                    onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    onKeyDown={e => e.key === 'Enter' && phone.length === 10 && !busy && handleContinue()}
                    placeholder={t('reg_phone_ph')}
                    className="flex-1 bg-white border border-[#E2DDD6] rounded-2xl px-5 text-[20px] font-bold text-stone-950 placeholder:text-stone-300 outline-none focus:border-stone-950 transition-colors tracking-[0.06em]"
                  />
                </div>
              </div>
              <div className="pb-8">
                <button disabled={phone.length !== 10 || busy} onClick={handleContinue} className={btnCls}>
                  {busy ? t('login_checking') : t('continue')}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Step 2: PIN */}
        {step === 2 && (
          <>
            <div className="px-6 pt-7 pb-4 text-center">
              <h1 className="font-display font-bold text-[34px] text-stone-950 leading-[1.08] tracking-[-0.03em]">
                {t('login_enter_pin')}
              </h1>
              <p className="text-[15px] text-stone-500 mt-3">
                {t('login_pin_for')} <span className="font-semibold text-stone-800">+91 {phone}</span>
              </p>
            </div>

            {error && (
              <div className="mx-6 mb-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-[13px] font-medium">{error}</div>
            )}

            <div className="flex-1 flex flex-col">
              <div className={clsx('flex justify-center gap-5 py-6', pinShake && 'animate-pin-shake')}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} style={{
                    width: 16, height: 16, borderRadius: '50%',
                    border: `2px solid ${i < pin.length ? '#0F0F0F' : '#D4CFC7'}`,
                    background: i < pin.length ? '#0F0F0F' : 'transparent',
                    transform: i < pin.length ? 'scale(1.18)' : 'scale(1)',
                    transition: 'all 180ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                  }} />
                ))}
              </div>

              <div className="flex-1 flex flex-col justify-end px-5 pb-6">
                <div className="grid grid-cols-3 gap-2.5">
                  {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, idx) => (
                    <button key={idx} onClick={() => !busy && k !== '' && handlePinPress(k)} disabled={k === '' || busy}
                      className={clsx(
                        'h-[66px] rounded-2xl font-semibold transition-all active:scale-95 select-none',
                        k === '' ? 'invisible' :
                        k === '⌫' ? 'text-stone-500 text-[20px] active:bg-stone-100' :
                        'bg-white text-stone-950 text-[22px] border border-[#E2DDD6] active:bg-stone-100 shadow-sm'
                      )}>
                      {k === '⌫' ? <Delete className="w-5 h-5 mx-auto" strokeWidth={1.8} /> : k}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => navigate('/register')}
                  className="w-full pt-5 pb-2 text-[13px] font-medium text-stone-400 active:text-stone-600"
                >
                  {t('login_forgot_pin')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
