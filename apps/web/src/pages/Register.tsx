import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Delete, ShieldCheck, Zap, BadgeCheck } from 'lucide-react'
import { clsx } from 'clsx'
import { registerAPI, sendOtpAPI, verifyOtpAPI } from '../lib/api'
import { useSessionStore } from '../store/session'
import regionsData from '../data/regions.json'

const TOTAL = 7

const HEADINGS: Record<number, { tag: string; title: string; sub: string }> = {
  1: { tag: 'YOUR NAME',      title: 'What do we\ncall you?',      sub: 'Enter your full name as per your ID.' },
  2: { tag: 'DATE OF BIRTH',  title: 'When were\nyou born?',       sub: 'Used for KYC and eligibility checks.' },
  3: { tag: 'LOCATION',       title: 'Where are\nyou based?',      sub: 'Helps us apply the right loan rates.' },
  4: { tag: 'PHONE NUMBER',   title: 'Your mobile\nnumber',        sub: "We'll send a one-time code to verify." },
  5: { tag: 'VERIFICATION',   title: 'Enter the\nOTP',             sub: '' },
  6: { tag: 'SECURITY PIN',   title: 'Set your\n6-digit PIN',      sub: 'Used to access the app quickly.' },
  7: { tag: 'CONFIRM PIN',    title: 'Re-enter\nyour PIN',         sub: 'Make sure both PINs match.' },
}

export function Register() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setAuth } = useSessionStore()

  const [step, setStep] = useState(1)
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [animKey, setAnimKey] = useState(0)

  const [name, setName] = useState('')
  const [dobDay, setDobDay] = useState('')
  const [dobMonth, setDobMonth] = useState('')
  const [dobYear, setDobYear] = useState('')
  const [city, setCity] = useState('')
  const [regionCode, setRegionCode] = useState('MH')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState(Array<string>(6).fill(''))
  const [sessionId, setSessionId] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [pinShake, setPinShake] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const otpRefs = useRef<Array<HTMLInputElement | null>>(Array(6).fill(null))
  const regions = (regionsData as any).states.map((s: any) => ({ code: s.code, name: s.name }))

  const advance = useCallback(() => {
    setDir('fwd')
    setAnimKey(k => k + 1)
    setStep(s => Math.min(TOTAL, s + 1))
    setError('')
  }, [])

  const retreat = useCallback(() => {
    setDir('back')
    setAnimKey(k => k + 1)
    setStep(s => Math.max(1, s - 1))
    setError('')
  }, [])

  const sendOtp = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await sendOtpAPI(phone)
      if (!res.success || !res.session_id) throw new Error(res.message || 'Failed to send OTP')
      setSessionId(res.session_id)
      advance()
    } catch (e: any) {
      setError(e.message || 'Failed to send OTP')
    } finally {
      setBusy(false)
    }
  }

  const verifyOtp = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await verifyOtpAPI(sessionId, otp.join(''))
      if (!res.success || !res.valid) throw new Error(res.message || 'Invalid OTP')
      advance()
    } catch (e: any) {
      setError(e.message || 'Incorrect OTP. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const handleOtpChange = (index: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1)
    const next = [...otp]
    next[index] = digit
    setOtp(next)
    if (digit && index < 5) otpRefs.current[index + 1]?.focus()
  }

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus()
    }
  }

  const handlePinPress = (key: string) => {
    const isConfirm = step === 7
    const current = isConfirm ? confirmPin : pin
    const set = isConfirm ? setConfirmPin : setPin

    if (key === '⌫') { set(p => p.slice(0, -1)); return }

    const next = current + key
    if (next.length > 6) return
    set(next)

    if (next.length === 6) {
      if (!isConfirm) {
        setTimeout(advance, 260)
      } else {
        if (next === pin) {
          setTimeout(doRegister, 260)
        } else {
          setTimeout(() => {
            setPinShake(true)
            setTimeout(() => {
              setConfirmPin('')
              setPinShake(false)
              setError("PINs don't match. Try again.")
            }, 480)
          }, 80)
        }
      }
    }
  }

  const doRegister = async () => {
    setBusy(true)
    setError('')
    try {
      const dobStr = `${dobYear}-${dobMonth.padStart(2, '0')}-${dobDay.padStart(2, '0')}`
      // otp_session_id is passed so the backend marks is_phone_verified=true.
      // The OTP itself is NOT re-sent — it was already verified at step 5 via
      // verifyOtpAPI, which consumed the 2Factor.in session. Sending otp again
      // would trigger a second verification call that always fails.
      const res = await registerAPI({
        full_name: name.trim(),
        dob: dobStr,
        language: 'en',
        phone,
        region_code: regionCode,
        city: city.trim() || undefined,
        otp_session_id: sessionId,
        password: pin,
      })
      setAuth(res.access_token, res.user)
      setDone(true)
    } catch (e: any) {
      // OTP session is consumed — clear it and the PIN so the user can retry
      // cleanly. Name/DOB/city/region are preserved so they don't re-enter them.
      setOtp(Array<string>(6).fill(''))
      setSessionId('')
      setPin('')
      setConfirmPin('')
      setError(e.message || 'Registration failed. Please try again.')
      setDir('back')
      setAnimKey(k => k + 1)
      setStep(4) // back to phone step to send a fresh OTP
    } finally {
      setBusy(false)
    }
  }

  const isPinStep = step === 6 || step === 7
  const activePin = step === 6 ? pin : confirmPin
  const title = t(`reg_h${step}_title`, { defaultValue: HEADINGS[step].title })
  const sub = t(`reg_h${step}_sub`, { defaultValue: HEADINGS[step].sub })

  const inputCls = 'w-full bg-white border border-[#E2DDD6] rounded-2xl px-5 py-[18px] text-[18px] font-semibold text-stone-950 placeholder:text-stone-300 outline-none focus:border-stone-950 transition-colors'
  const btnCls = 'w-full h-[60px] rounded-2xl bg-stone-950 text-white font-semibold text-[16px] tracking-[-0.01em] disabled:opacity-25 active:opacity-75 transition-opacity'

  // ── Success screen ──────────────────────────────────────────────────────────
  if (done) {
    const initials = name.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'U'
    const features = [
      { icon: ShieldCheck, label: t('reg_feat_security'), sub: t('reg_feat_security_sub'), color: '#1C3552' },
      { icon: Zap,         label: t('reg_feat_instant'),  sub: t('reg_feat_instant_sub'),  color: '#7B3F00' },
      { icon: BadgeCheck,  label: t('reg_feat_kyc'),      sub: t('reg_feat_kyc_sub'),      color: '#134E4A' },
    ]
    return (
      <div className="page flex flex-col" style={{ background: '#FEFEFE', zIndex: 5, isolation: 'isolate' }}>
        <div className="flex-1 flex flex-col px-6 pt-14 pb-6">
          {/* Avatar */}
          <div className="flex justify-center mb-8">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-stone-950 flex items-center justify-center">
                <span className="text-[32px] font-bold text-white tracking-tight">{initials}</span>
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-white border-2 border-stone-950 flex items-center justify-center">
                <BadgeCheck className="w-4 h-4 text-stone-950" strokeWidth={2} />
              </div>
            </div>
          </div>

          {/* Heading */}
          <div className="text-center mb-10">
            <h1 className="font-display font-bold text-[36px] text-stone-950 tracking-[-0.03em] leading-tight">
              {t('reg_done_title')}
            </h1>
            <p className="text-[16px] text-stone-500 mt-2 font-medium">{name || t('reg_welcome')}</p>
            {phone && <p className="text-[14px] text-stone-400 mt-0.5">+91 {phone}</p>}
          </div>

          {/* Feature highlights */}
          <div className="space-y-3">
            {features.map(({ icon: Icon, label, sub: fsub, color }) => (
              <div key={label} className="flex items-center gap-4 px-4 py-4 bg-white rounded-2xl border border-[#E8E4DC]">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: color }}>
                  <Icon className="w-5 h-5 text-white" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-stone-950 leading-tight">{label}</p>
                  <p className="text-[12px] text-stone-400 mt-0.5">{fsub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="px-6 pb-8">
          <button
            onClick={() => navigate('/dashboard-home')}
            className="w-full h-[60px] rounded-2xl bg-stone-950 text-white font-semibold text-[16px] tracking-[-0.01em] active:opacity-75 transition-opacity"
          >
            {t('reg_enter_app')} →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page" style={{ background: '#FDFDFC', zIndex: 5, isolation: 'isolate' }}>
      {/* Progress bar */}
      <div className="h-[3px] bg-stone-100">
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{ width: `${(step / TOTAL) * 100}%`, background: '#C0392B' }}
        />
      </div>

      {/* Top bar */}
      <div className="flex items-center px-5 pt-4 pb-1">
        <button
          onClick={step === 1 ? () => navigate(-1) : retreat}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-stone-950 text-white active:opacity-70 transition-opacity"
        >
          <ArrowLeft className="w-4 h-4" strokeWidth={2.2} />
        </button>
      </div>

      {/* Animated content */}
      <div
        key={animKey}
        className={clsx('flex-1 flex flex-col', dir === 'fwd' ? 'register-step-fwd' : 'register-step-back')}
      >
        {/* Heading */}
        <div className={clsx('px-6 pt-7 pb-6', isPinStep && 'text-center')}>
          <h1 className="font-display font-bold text-[34px] text-stone-950 leading-[1.08] tracking-[-0.03em] whitespace-pre-line">
            {title}
          </h1>
          {sub && <p className="text-[15px] text-stone-500 mt-3 leading-relaxed">{sub}</p>}
          {step === 5 && (
            <p className="text-[15px] text-stone-500 mt-3 leading-relaxed">
              {t('reg_code_sent')} <span className="font-semibold text-stone-800">+91 {phone}</span>
            </p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-[13px] font-medium">
            {error}
          </div>
        )}

        {/* ── Step 1: Name ── */}
        {step === 1 && (
          <div className="flex-1 flex flex-col px-6">
            <div className="flex-1">
              <input
                autoFocus
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && name.trim().length >= 2 && advance()}
                placeholder={t('reg_name_ph')}
                className={inputCls}
              />
            </div>
            <div className="pb-8">
              <button disabled={name.trim().length < 2} onClick={advance} className={btnCls}>
                {t('continue')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: DOB ── */}
        {step === 2 && (
          <div className="flex-1 flex flex-col px-6">
            <div className="flex-1">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'DD', val: dobDay, set: setDobDay, max: 2, ph: '15' },
                  { label: 'MM', val: dobMonth, set: setDobMonth, max: 2, ph: '06' },
                  { label: 'YYYY', val: dobYear, set: setDobYear, max: 4, ph: '1995' },
                ].map(({ label, val, set, max, ph }) => (
                  <div key={label}>
                    <p className="text-[11px] font-bold text-stone-400 tracking-wider mb-2">{label}</p>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={val}
                      onChange={e => set(e.target.value.replace(/\D/g, '').slice(0, max))}
                      placeholder={ph}
                      className="w-full bg-white border border-[#E2DDD6] rounded-2xl px-3 py-[18px] text-[20px] font-bold text-stone-950 text-center placeholder:text-stone-300 outline-none focus:border-stone-950 transition-colors"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="pb-8">
              <button
                disabled={!dobDay || !dobMonth || dobYear.length !== 4}
                onClick={() => {
                  const day = parseInt(dobDay, 10)
                  const month = parseInt(dobMonth, 10)
                  const year = parseInt(dobYear, 10)
                  if (day < 1 || day > 31 || month < 1 || month > 12) {
                    setError(t('reg_err_date'))
                    return
                  }
                  const dob = new Date(year, month - 1, day)
                  const today = new Date()
                  let age = today.getFullYear() - dob.getFullYear()
                  if (today.getMonth() < dob.getMonth() || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate())) age--
                  if (age < 21) { setError(t('reg_err_min_age')); return }
                  if (age > 65) { setError(t('reg_err_max_age')); return }
                  setError('')
                  advance()
                }}
                className={btnCls}
              >
                {t('continue')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Location ── */}
        {step === 3 && (
          <div className="flex-1 flex flex-col px-6">
            <div className="flex-1 space-y-4">
              <div>
                <p className="text-[11px] font-bold text-stone-400 tracking-wider mb-2">{t('reg_city')}</p>
                <input
                  autoFocus
                  type="text"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  placeholder={t('reg_city_ph')}
                  className={inputCls}
                />
              </div>
              <div>
                <p className="text-[11px] font-bold text-stone-400 tracking-wider mb-2">{t('reg_state')}</p>
                <div className="relative">
                  <select
                    value={regionCode}
                    onChange={e => setRegionCode(e.target.value)}
                    className="w-full bg-white border border-[#E2DDD6] rounded-2xl px-5 py-[18px] text-[17px] font-semibold text-stone-950 outline-none focus:border-stone-950 transition-colors appearance-none"
                  >
                    {regions.map((r: any) => (
                      <option key={r.code} value={r.code}>{r.name}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-stone-400 text-sm">▾</span>
                </div>
              </div>
            </div>
            <div className="pb-8">
              <button onClick={advance} className={btnCls}>{t('continue')}</button>
            </div>
          </div>
        )}

        {/* ── Step 4: Phone ── */}
        {step === 4 && (
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
                  placeholder={t('reg_phone_ph')}
                  className="flex-1 bg-white border border-[#E2DDD6] rounded-2xl px-5 text-[20px] font-bold text-stone-950 placeholder:text-stone-300 outline-none focus:border-stone-950 transition-colors tracking-[0.06em]"
                />
              </div>
            </div>
            <div className="pb-8">
              <button
                disabled={phone.length !== 10 || busy}
                onClick={sendOtp}
                className={btnCls}
              >
                {busy ? t('reg_sending') : t('reg_send_otp')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: OTP ── */}
        {step === 5 && (
          <div className="flex-1 flex flex-col px-6">
            <div className="flex-1">
              <div className="flex gap-2 justify-center">
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={el => { otpRefs.current[i] = el }}
                    type="text"
                    inputMode="numeric"
                    value={digit}
                    maxLength={1}
                    onChange={e => handleOtpChange(i, e.target.value)}
                    onKeyDown={e => handleOtpKeyDown(i, e)}
                    className={clsx(
                      'w-[46px] h-[58px] bg-white border rounded-xl text-[22px] font-bold text-stone-950 text-center outline-none transition-all',
                      digit ? 'border-stone-950 scale-105' : 'border-[#E2DDD6] focus:border-stone-800'
                    )}
                  />
                ))}
              </div>
              <button
                onClick={sendOtp}
                disabled={busy}
                className="block mx-auto mt-6 text-[14px] font-semibold text-stone-400 disabled:opacity-40"
              >
                {t('reg_resend_otp')}
              </button>
            </div>
            <div className="pb-8">
              <button
                disabled={otp.join('').length !== 6 || busy}
                onClick={verifyOtp}
                className={btnCls}
              >
                {busy ? t('reg_verifying') : t('reg_verify')}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 6 & 7: PIN ── */}
        {isPinStep && (
          <div className="flex-1 flex flex-col">
            {/* Dots */}
            <div className={clsx('flex justify-center gap-5 pt-4 pb-8', pinShake && 'animate-pin-shake')}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: 16, height: 16, borderRadius: '50%',
                    border: `2px solid ${i < activePin.length ? '#0F0F0F' : '#D4CFC7'}`,
                    background: i < activePin.length ? '#0F0F0F' : 'transparent',
                    transform: i < activePin.length ? 'scale(1.18)' : 'scale(1)',
                    transition: 'all 180ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                  }}
                />
              ))}
            </div>

            {/* Numpad */}
            <div className="flex-1 flex flex-col justify-end px-5 pb-8">
              <div className="grid grid-cols-3 gap-2.5">
                {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, idx) => (
                  <button
                    key={idx}
                    onClick={() => k !== '' && handlePinPress(k)}
                    disabled={k === ''}
                    className={clsx(
                      'h-[68px] rounded-2xl font-semibold transition-all active:scale-95 select-none',
                      k === '' ? 'invisible' :
                      k === '⌫' ? 'text-stone-500 text-[20px] active:bg-stone-100 rounded-2xl' :
                      'bg-white text-stone-950 text-[22px] border border-[#E2DDD6] active:bg-stone-100 shadow-sm'
                    )}
                  >
                    {k === '⌫' ? <Delete className="w-5 h-5 mx-auto" strokeWidth={1.8} /> : k}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
