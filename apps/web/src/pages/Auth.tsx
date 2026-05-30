import { useEffect, useMemo, useState, useCallback, type ElementType, type HTMLAttributes } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle, ArrowRight, Camera, CheckCircle, KeyRound, Mail, Phone, UserRound } from 'lucide-react'
import { clsx } from 'clsx'
import regionsData from '../data/regions.json'
import {
  googleLoginAPI,
  passwordLoginAPI,
  registerAPI,
  sendOtpAPI,
  otpLoginAPI,
  uploadUserAssetAPI,
  verifyOtpAPI,
  type UserAsset,
} from '../lib/api'
import { useSessionStore } from '../store/session'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void
          prompt: (cb?: (notification: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean }) => void) => void
          renderButton: (parent: HTMLElement, config: Record<string, unknown>) => void
        }
      }
    }
  }
}

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || ''

type Mode = 'register' | 'login'
type AuthMethod = 'otp' | 'password'

export function Auth() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { state, setAuth, setLang } = useSessionStore()
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'login' ? 'login' : 'register')
  const [method, setMethod] = useState<AuthMethod>('otp')
  const [fullName, setFullName] = useState(state.name || '')
  const [dob, setDob] = useState('')
  const [language, setLanguage] = useState(state.lang || 'en')
  const [phone, setPhone] = useState((state.phone || '').replace(/^\+91/, ''))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [regionCode, setRegionCode] = useState('MH')
  const [city, setCity] = useState('')
  const [pincode, setPincode] = useState('')
  const [address, setAddress] = useState('')
  const [otpSessionId, setOtpSessionId] = useState('')
  const [otp, setOtp] = useState('')
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [otpSent, setOtpSent] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const copy = useMemo(() => {
    const hi = state.lang === 'hi'
    return {
      createProfile: hi ? 'प्रोफाइल बनाएं' : 'Create profile',
      login: hi ? 'लॉगिन' : 'Login',
      getStarted: hi ? 'शुरू करें' : 'Get started',
      welcomeBack: hi ? 'वापस स्वागत है' : 'Welcome back',
      registerSub: hi ? 'अपनी प्रोफाइल, फोटो, अनुमान और लोन सेशन सुरक्षित रखें।' : 'Save your profile, uploads, estimates, and loan sessions securely.',
      loginSub: hi ? 'OTP या पासवर्ड से जारी रखें।' : 'Continue with OTP or password.',
      register: hi ? 'रजिस्टर' : 'Register',
      profilePhoto: hi ? 'प्रोफाइल फोटो' : 'Profile photo',
      fullName: hi ? 'पूरा नाम' : 'Full name',
      dob: hi ? 'जन्म तिथि' : 'Date of birth',
      language: hi ? 'भाषा' : 'Language',
      region: hi ? 'क्षेत्र' : 'Region',
      phone: hi ? 'फोन नंबर' : 'Phone number',
      emailOptional: hi ? 'ईमेल (वैकल्पिक)' : 'Email (optional)',
      email: hi ? 'ईमेल' : 'Email',
      password: hi ? 'पासवर्ड' : 'Password',
      minPassword: hi ? 'कम से कम 8 अक्षर' : 'Minimum 8 characters',
      yourPassword: hi ? 'आपका पासवर्ड' : 'Your password',
      otp: hi ? 'OTP' : 'OTP',
      otpPlaceholder: hi ? '6 अंकों का कोड' : '6 digit code',
      send: hi ? 'भेजें' : 'Send',
      resend: hi ? 'फिर भेजें' : 'Resend',
      city: hi ? 'शहर' : 'City',
      pincode: hi ? 'पिनकोड' : 'Pincode',
      address: hi ? 'पता' : 'Address',
      addressPlaceholder: hi ? 'घर / सड़क / क्षेत्र' : 'House / street / locality',
      saveNote: hi ? 'आपकी ज्वेलरी फोटो प्रोफाइल और सेशन में सेव होंगी, इसलिए पूरा लोन फ्लो फिर से अपलोड किए बिना जारी हो सकेगा।' : 'Your uploaded jewellery images are stored against your profile and session, so completed loan steps can be resumed without uploading again.',
      pleaseWait: hi ? 'कृपया प्रतीक्षा करें...' : 'Please wait...',
      createAccount: hi ? 'खाता बनाएं' : 'Create account',
    }
  }, [state.lang])

  const regions = useMemo(() => {
    const states = (regionsData as unknown as { states: Array<{ code: string; name: string; type?: 'state' | 'union_territory' }> }).states
    return states.map(region => ({ code: region.code, name: region.name, type: region.type || 'state' }))
  }, [])

  useEffect(() => {
    if (state.authToken && state.userProfile) navigate('/consent')
  }, [state.authToken, state.userProfile, navigate])

  const finishAuth = useCallback(async (token: string, user: any) => {
    let uploadedProfile: UserAsset | null = null
    if (profilePhoto) {
      uploadedProfile = await uploadUserAssetAPI(token, profilePhoto, 'profile_photo')
    }
    const finalUser = uploadedProfile?.public_url ? { ...user, profile_photo_url: uploadedProfile.public_url } : user
    setAuth(token, finalUser)
    navigate('/consent')
  }, [profilePhoto, setAuth, navigate])

  // Initialize Google Sign-In button
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !window.google) return

    const handleCredentialResponse = async (response: { credential?: string }) => {
      if (!response.credential) return
      setGoogleBusy(true)
      setError('')
      try {
        const res = await googleLoginAPI(response.credential)
        await finishAuth(res.access_token, res.user)
      } catch (err: any) {
        setError(err.message || 'Google Sign-In failed')
      } finally {
        setGoogleBusy(false)
      }
    }

    try {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        cancel_on_tap_outside: true,
      })

      const btnContainer = document.getElementById('google-btn-container')
      if (btnContainer) {
        window.google.accounts.id.renderButton(btnContainer, {
          theme: 'outline',
          size: 'large',
          width: btnContainer.offsetWidth || 300,
          text: mode === 'register' ? 'continue_with' : 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'center'
        })
      }
    } catch (err: any) {
      console.error('Google Auth Init Error:', err)
    }
  }, [mode, finishAuth])

  const sendOtp = async () => {
    setError('')
    if (phone.replace(/\D/g, '').length !== 10) { setError('Enter a valid 10 digit mobile number'); return }
    setBusy(true)
    try {
      const res = await sendOtpAPI(phone.replace(/\D/g, ''))
      if (!res.success || !res.session_id) throw new Error(res.message || 'Unable to send OTP')
      setOtpSessionId(res.session_id)
      setOtpSent(true)
    } catch (err: any) {
      setError(err.message || 'Unable to send OTP')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') {
        const res = method === 'password'
          ? await passwordLoginAPI(email || phone, password)
          : await otpLoginAPI(phone.replace(/\D/g, ''), otpSessionId, otp)
        await finishAuth(res.access_token, res.user)
        return
      }

      if (!fullName.trim()) throw new Error('Name is required')
      if (!dob) throw new Error('Date of birth is required')
      if (!regionCode) throw new Error('Region is required')
      if (method === 'otp') {
        const verified = await verifyOtpAPI(otpSessionId, otp)
        if (!verified.success || !verified.valid) throw new Error(verified.message || 'OTP verification failed')
      }
      const res = await registerAPI({
        full_name: fullName.trim(),
        dob,
        language,
        phone: phone.replace(/\D/g, '') || undefined,
        email: email.trim() || undefined,
        password: password || undefined,
        region_code: regionCode,
        city: city.trim() || undefined,
        pincode: pincode.trim() || undefined,
        address: address.trim() || undefined,
        otp_session_id: method === 'otp' ? otpSessionId : undefined,
        otp: method === 'otp' ? otp : undefined,
      })
      await finishAuth(res.access_token, res.user)
    } catch (err: any) {
      setError(err.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = mode === 'login'
    ? method === 'password' ? Boolean((email || phone) && password) : Boolean(phone && otpSessionId && otp.length === 6)
    : Boolean(fullName && dob && regionCode && phone.length === 10 && (method === 'password' ? password.length >= 8 : otpSessionId && otp.length === 6))

  return (
    <div className="page bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30 animate-slide-up">
      <div className="page-header">
        <div className="w-11" />
        <span className="text-sm font-semibold text-stone-700">{mode === 'register' ? copy.createProfile : copy.login}</span>
        <div className="w-11" />
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        <div className="pt-6 pb-5">
          <h1 className="font-display font-black text-3xl text-stone-950 tracking-tight">
            {mode === 'register' ? copy.getStarted : copy.welcomeBack}
          </h1>
          <p className="text-sm text-stone-500 mt-2">
            {mode === 'register'
              ? copy.registerSub
              : copy.loginSub}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          {(['register', 'login'] as Mode[]).map(item => (
            <button key={item} onClick={() => setMode(item)} className={clsx('py-3 rounded-2xl text-sm font-bold border transition', mode === item ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-stone-600 border-stone-200')}>
              {item === 'register' ? copy.register : copy.login}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-5">
          {(['otp', 'password'] as AuthMethod[]).map(item => (
            <button key={item} onClick={() => setMethod(item)} className={clsx('py-3 rounded-2xl text-sm font-semibold border flex items-center justify-center gap-2 transition', method === item ? 'bg-brand-50 text-brand-800 border-brand-300' : 'bg-white text-stone-600 border-stone-200')}>
              {item === 'otp' ? <Phone className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
              {item === 'otp' ? 'OTP' : 'Password'}
            </button>
          ))}
        </div>

        {/* Google Sign-In Button */}
        {GOOGLE_CLIENT_ID && (
          <div className="mb-4">
            <div id="google-btn-container" className="flex justify-center w-full min-h-[44px]" />
            {googleBusy && <p className="text-center text-xs text-stone-500 mt-2">Signing in with Google...</p>}

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-stone-200" />
              <span className="text-xs font-bold text-stone-400 uppercase tracking-widest">or</span>
              <div className="flex-1 h-px bg-stone-200" />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 mb-4 rounded-2xl bg-red-50 border border-red-200 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-4">
          {mode === 'register' && (
            <>
              <label className="block">
                <span className="label mb-2 block">{copy.profilePhoto}</span>
                <div className="flex items-center gap-3">
                  <div className="w-14 h-14 rounded-2xl bg-brand-50 border border-brand-200 flex items-center justify-center overflow-hidden">
                    {profilePhoto ? <img src={URL.createObjectURL(profilePhoto)} className="w-full h-full object-cover" alt="" /> : <Camera className="w-6 h-6 text-brand-700" />}
                  </div>
                  <input type="file" accept="image/*" onChange={e => setProfilePhoto(e.target.files?.[0] || null)} className="text-sm text-stone-500 file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border-0 file:bg-stone-100 file:text-stone-700" />
                </div>
              </label>

              <Input icon={UserRound} label={copy.fullName} value={fullName} onChange={setFullName} placeholder="Rahul Sharma" />
              <Input label={copy.dob} type="date" value={dob} onChange={setDob} />

              <div className="grid grid-cols-2 gap-3">
                <Select label={copy.language} value={language} onChange={(value) => { setLanguage(value); setLang(value) }} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi' }]} />
                <Select label={copy.region} value={regionCode} onChange={setRegionCode} options={regions.map(region => ({ value: region.code, label: region.name }))} />
              </div>
            </>
          )}

          <Input icon={Phone} label={copy.phone} value={phone} onChange={v => setPhone(v.replace(/\D/g, '').slice(0, 10))} placeholder="9876543210" inputMode="numeric" />
          <Input icon={Mail} label={mode === 'register' ? copy.emailOptional : copy.email} value={email} onChange={setEmail} placeholder="name@example.com" />

          {method === 'password' && (
            <Input icon={KeyRound} label={copy.password} type="password" value={password} onChange={setPassword} placeholder={mode === 'register' ? copy.minPassword : copy.yourPassword} />
          )}

          {method === 'otp' && (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input label={copy.otp} value={otp} onChange={v => setOtp(v.replace(/\D/g, '').slice(0, 6))} placeholder={copy.otpPlaceholder} inputMode="numeric" />
              <button onClick={sendOtp} disabled={busy || phone.length !== 10} className="mt-7 px-4 rounded-2xl bg-stone-900 text-white text-sm font-bold disabled:opacity-40">
                {otpSent ? copy.resend : copy.send}
              </button>
            </div>
          )}

          {mode === 'register' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input label={copy.city} value={city} onChange={setCity} placeholder="Mumbai" />
                <Input label={copy.pincode} value={pincode} onChange={v => setPincode(v.replace(/\D/g, '').slice(0, 6))} placeholder="400001" inputMode="numeric" />
              </div>
              <label className="block">
                <span className="label mb-2 block">{copy.address}</span>
                <textarea value={address} onChange={e => setAddress(e.target.value)} className="input-field min-h-[92px] resize-none" placeholder={copy.addressPlaceholder} />
              </label>
            </>
          )}
        </div>

        <div className="card-gold p-4 mt-5">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-brand-700 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-stone-700 leading-relaxed">
              {copy.saveNote}
            </p>
          </div>
        </div>
      </div>

      <div className="px-5 pb-6 pt-4 border-t border-stone-200 bg-white/90">
        <button onClick={submit} disabled={!canSubmit || busy} className="btn-primary w-full text-lg py-4 disabled:opacity-40 mb-3">
          {busy ? copy.pleaseWait : mode === 'register' ? copy.createAccount : copy.login}
          <ArrowRight className="w-5 h-5" />
        </button>
        <button
          onClick={() => {
            setAuth('guest', {
              id: 0,
              full_name: 'Guest User',
              email: null,
              phone: null,
              region_code: 'MH',
              language: 'en',
              cibil_score: null,
              is_active: true,
              profile_photo_url: null,
            } as any)
            navigate('/consent')
          }}
          className="w-full py-3 text-sm font-semibold text-stone-500 hover:text-stone-700 transition"
        >
          Continue as Guest
        </button>
      </div>
    </div>
  )
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  icon: Icon,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
  icon?: ElementType
}) {
  return (
    <label className="block">
      <span className="label mb-2 block">{label}</span>
      <div className="relative">
        {Icon && <Icon className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-stone-400" />}
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode} className={clsx('input-field', Icon && 'pl-11')} />
      </div>
    </label>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="block">
      <span className="label mb-2 block">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="input-field">
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}
