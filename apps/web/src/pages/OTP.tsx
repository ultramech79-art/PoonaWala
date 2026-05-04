import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../store/session'
import { ChevronRight, Phone, CheckCircle, AlertCircle, User, ArrowRight } from 'lucide-react'
import { clsx } from 'clsx'
import { sendOtpAPI, verifyOtpAPI } from '../lib/api'

type Step = 'name' | 'phone' | 'otp' | 'verified'

export function OTP() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setPhone, setName } = useSessionStore()

  const [name, setNameLocal] = useState('')
  const [phone, setPhoneLocal] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [step, setStep] = useState<Step>('name')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState('')
  const [sessionId, setSessionId] = useState('')
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCountdown = () => {
    setCountdown(30)
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(countdownRef.current!); return 0 }
        return c - 1
      })
    }, 1000)
  }

  const sendOTP = async () => {
    if (phone.length !== 10) return
    setError('')
    setSending(true)
    try {
      const res = await sendOtpAPI(phone)
      if (!res.success) throw new Error(res.error || 'Failed to send OTP')
      setSessionId(res.session_id || '')
      setStep('otp')
      startCountdown()
      setTimeout(() => refs.current[0]?.focus(), 100)
    } catch (err: any) {
      setError(err.message || 'Failed to send OTP')
    } finally {
      setSending(false)
    }
  }

  const handleOtpChange = (i: number, v: string) => {
    if (!/^\d*$/.test(v)) return
    const next = [...otp]
    next[i] = v.slice(-1)
    setOtp(next)
    if (v && i < 5) refs.current[i + 1]?.focus()
    const code = next.join('')
    if (code.length === 6) verifyCode(code)
  }

  const handleOtpKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[i] && i > 0) refs.current[i - 1]?.focus()
  }

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text.length >= 4) {
      e.preventDefault()
      const next = text.split('').concat(Array(6 - text.length).fill(''))
      setOtp(next.slice(0, 6))
      if (text.length === 6) verifyCode(text)
    }
  }

  const verifyCode = async (code: string) => {
    if (!sessionId) { setError('No session — resend OTP'); return }
    setError('')
    setVerifying(true)
    try {
      const res = await verifyOtpAPI(sessionId, code)
      if (!res.success || !res.valid) throw new Error(res.message || 'Invalid or expired OTP')
      setStep('verified')
      setPhone(phone)
      setTimeout(() => navigate('/setup'), 1500)
    } catch (err: any) {
      setError(err.message || 'Verification failed')
      setOtp(['', '', '', '', '', ''])
      setTimeout(() => refs.current[0]?.focus(), 100)
    } finally {
      setVerifying(false)
    }
  }

  const verify = () => {
    const code = otp.join('')
    if (code.length !== 6) return
    verifyCode(code)
  }

  const skipDemo = () => {
    setPhone('demo')
    navigate('/setup')
  }

  const STEP_LABELS: Record<Step, string> = {
    name: 'Your Name',
    phone: 'Mobile Number',
    otp: 'OTP Verification',
    verified: 'Verified',
  }

  const backAction = () => {
    if (step === 'name') navigate('/consent')
    else if (step === 'phone') setStep('name')
    else if (step === 'otp') { setStep('phone'); setOtp(['', '', '', '', '', '']); setError('') }
  }

  return (
    <div className="page animate-slide-up">
      {/* Header */}
      <div className="page-header">
        {step !== 'verified' ? (
          <button id="otp-back" onClick={backAction} className="btn-icon">
            <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
          </button>
        ) : <div className="w-11" />}
        <span className="text-sm font-semibold text-stone-700">{STEP_LABELS[step]}</span>
        <div className="w-11" />
      </div>

      {/* Step progress */}
      {step !== 'verified' && (
        <div className="flex items-center gap-2 px-5 pt-4 pb-2">
          {(['name', 'phone', 'otp'] as Step[]).map((s, i) => (
            <div
              key={s}
              className={clsx(
                'h-1.5 flex-1 rounded-full transition-all duration-300',
                s === step ? 'bg-brand-500' :
                i < (['name', 'phone', 'otp'] as Step[]).indexOf(step) ? 'bg-brand-300' :
                'bg-stone-200'
              )}
            />
          ))}
        </div>
      )}

      <div className="flex-1 px-5 pt-6 pb-6">
        {/* Icon */}
        <div className="flex flex-col items-center mb-8">
          <div className={clsx(
            'w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-all duration-500',
            step === 'verified' ? 'bg-emerald-50 border border-emerald-200' :
            step === 'name' ? 'bg-brand-50 border border-brand-200' :
            'bg-stone-100 border border-stone-200'
          )}>
            {step === 'verified'
              ? <CheckCircle className="w-8 h-8 text-emerald-500" />
              : step === 'name'
                ? <User className="w-8 h-8 text-brand-500" />
                : <Phone className="w-8 h-8 text-stone-600" />
            }
          </div>
          <h1 className="font-display font-bold text-2xl text-stone-900 text-center mb-1.5">
            {step === 'name' && "What should we call you?"}
            {step === 'phone' && t('otp_heading')}
            {step === 'otp' && 'Verify OTP'}
            {step === 'verified' && 'Verified!'}
          </h1>
          <p className="text-sm text-stone-500 text-center">
            {step === 'name' && "We'll personalise your experience"}
            {step === 'phone' && t('otp_body')}
            {step === 'otp' && `Enter the 6-digit code sent to +91 ${phone}`}
            {step === 'verified' && `+91 ${phone} confirmed`}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mb-4 rounded-2xl bg-red-50 border border-red-200 text-red-600 text-sm animate-slide-up">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Name step */}
        {step === 'name' && (
          <div className="space-y-4">
            <div>
              <label className="label mb-2 block">Your Name</label>
              <input
                id="name-input"
                type="text"
                value={name}
                onChange={e => setNameLocal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { setName(name.trim()); setStep('phone') } }}
                placeholder="e.g. Rahul Sharma"
                className="input-field"
                autoFocus
              />
            </div>
            <button
              onClick={() => { if (name.trim()) { setName(name.trim()); setStep('phone') } }}
              disabled={!name.trim()}
              className="btn-primary w-full"
            >
              Continue
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Phone step */}
        {step === 'phone' && (
          <div className="space-y-4">
            <div>
              <label className="label mb-2 block">Mobile Number</label>
              <div className="flex gap-2">
                <div className="flex items-center justify-center px-4 rounded-2xl bg-stone-100 border border-stone-200 text-stone-600 text-sm font-mono font-medium">
                  +91
                </div>
                <input
                  id="phone-input"
                  type="tel"
                  value={phone}
                  onChange={e => { setPhoneLocal(e.target.value.replace(/\D/g, '').slice(0, 10)); setError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') sendOTP() }}
                  placeholder="98765 43210"
                  className="input-field flex-1 font-mono tracking-widest"
                  inputMode="numeric"
                  autoFocus
                />
              </div>
            </div>
            <button
              id="send-otp"
              onClick={sendOTP}
              disabled={phone.length !== 10 || sending}
              className="btn-primary w-full"
            >
              {sending ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Sending OTP…
                </span>
              ) : (
                <>{t('otp_send')}<ArrowRight className="w-5 h-5" /></>
              )}
            </button>
          </div>
        )}

        {/* OTP step */}
        {step === 'otp' && (
          <div className="space-y-5">
            {/* Number grid (1-9, 0, backspace) style from mockup */}
            <div className="flex gap-2 justify-center" onPaste={handleOtpPaste}>
              {otp.map((digit, i) => (
                <input
                  key={i}
                  id={`otp-digit-${i}`}
                  ref={el => refs.current[i] = el}
                  type="text"
                  inputMode="numeric"
                  value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)}
                  onKeyDown={e => handleOtpKey(i, e)}
                  maxLength={1}
                  disabled={verifying}
                  className={clsx(
                    'w-12 h-14 text-center text-xl font-mono font-bold rounded-2xl border-2 outline-none transition-all duration-200',
                    verifying ? 'opacity-50' : '',
                    digit
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-stone-200 bg-white text-stone-900 focus:border-brand-400 focus:bg-white'
                  )}
                />
              ))}
            </div>

            <button
              id="verify-otp"
              onClick={verify}
              disabled={otp.join('').length !== 6 || verifying}
              className="btn-primary w-full"
            >
              {verifying ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Verifying…
                </span>
              ) : t('otp_verify')}
            </button>

            <div className="space-y-2">
              <button
                id="resend-otp"
                onClick={sendOTP}
                disabled={countdown > 0 || sending}
                className="btn-secondary w-full text-sm"
              >
                {sending ? 'Sending…' : countdown > 0 ? `Resend in ${countdown}s` : 'Resend OTP'}
              </button>
              <button
                onClick={() => { setStep('phone'); setOtp(['', '', '', '', '', '']); setError('') }}
                className="w-full text-center text-sm text-stone-400 hover:text-stone-600 py-2 transition-colors"
              >
                Change number
              </button>
            </div>
          </div>
        )}

        {/* Verified */}
        {step === 'verified' && (
          <div className="flex flex-col items-center py-8 animate-slide-up">
            <div className="w-20 h-20 rounded-full bg-emerald-50 border-2 border-emerald-400 flex items-center justify-center mb-4">
              <CheckCircle className="w-10 h-10 text-emerald-500" />
            </div>
            <p className="text-stone-500 text-sm">Redirecting to setup…</p>
          </div>
        )}

        {/* Demo skip */}
        {step !== 'verified' && step !== 'name' && (
          <div className="mt-8 pt-5 border-t border-stone-200">
            <button id="otp-skip" onClick={skipDemo} className="w-full text-center text-sm text-stone-400 hover:text-stone-600 transition-colors py-2">
              {t('otp_skip')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
