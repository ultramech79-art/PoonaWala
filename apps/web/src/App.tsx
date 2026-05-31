import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Home } from './pages/Home'
import { LanguagePicker } from './pages/LanguagePicker'
import { Auth } from './pages/Auth'
import { Profile } from './pages/Profile'
import { Welcome } from './pages/Welcome'
import { Consent } from './pages/Consent'
import { OTP } from './pages/OTP'
import { Setup } from './pages/Setup'
import { CaptureFlow } from './pages/CaptureFlow'
import { LiveCapture } from './pages/LiveCapture'
import { CertificateScan } from './pages/CertificateScan'
import { WeightEntry } from './pages/WeightEntry'
import { Processing } from './pages/Processing'
import { Result } from './pages/Result'
import { FinalEvaluation } from './pages/FinalEvaluation'
import { GoldLoanApplication } from './pages/GoldLoanApplication'
import { Dashboard } from './pages/Dashboard'
import { DashboardHome } from './pages/DashboardHome'
import { DashboardDetail } from './pages/DashboardDetail'
import { FieldAgent } from './pages/FieldAgent'
import { Confirmation } from './pages/Confirmation'
import { VideoEval } from './pages/VideoEval'
import { AudioEval } from './pages/AudioEval'
import { useSessionStore } from './store/session'
import { FloatingAssistant } from './components/FloatingAssistant'
import { UserRound } from 'lucide-react'

function ProfileShortcut() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state } = useSessionStore()
  if (!state.authToken || location.pathname === '/profile' || location.pathname === '/auth') return null
  return (
    <button
      onClick={() => navigate('/profile', { state: { from: location.pathname } })}
      className="fixed right-4 top-4 z-[200] h-10 w-10 rounded-full border border-stone-200 bg-white/95 shadow-lg backdrop-blur flex items-center justify-center"
      aria-label="Open profile"
    >
      {state.userProfile?.profile_photo_url
        ? <img src={state.userProfile.profile_photo_url} className="h-full w-full rounded-full object-cover" alt="" />
        : <UserRound className="h-4 w-4 text-stone-600" />}
    </button>
  )
}

function App() {
  return (
    <BrowserRouter>
      <div className="max-w-md mx-auto relative w-full" style={{ height: '100dvh' }}>
        <ProfileShortcut />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/language" element={<LanguagePicker />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/consent" element={<Consent />} />
          <Route path="/otp" element={<OTP />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/capture" element={<CaptureFlow />} />
          <Route path="/live-capture" element={<LiveCapture />} />
          <Route path="/certificate-scan" element={<CertificateScan />} />
          <Route path="/video-eval" element={<VideoEval />} />
          <Route path="/audio-eval" element={<AudioEval />} />
          <Route path="/weight" element={<WeightEntry />} />
          <Route path="/processing" element={<Processing />} />
          <Route path="/result" element={<Result />} />
          <Route path="/final-eval" element={<FinalEvaluation />} />
          <Route path="/gold-loan-app" element={<GoldLoanApplication />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/dashboard-home" element={<DashboardHome />} />
          <Route path="/dashboard/session/:id" element={<DashboardDetail />} />
          <Route path="/agent" element={<FieldAgent />} />
          <Route path="/confirmation" element={<Confirmation />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <FloatingAssistant />
      </div>
    </BrowserRouter>
  )
}

export default App
