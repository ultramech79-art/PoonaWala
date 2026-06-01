import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { stopSpeech } from './lib/tts'
import { Home } from './pages/Home'
import { LanguagePicker } from './pages/LanguagePicker'
import { Register } from './pages/Register'
import { Login } from './pages/Login'
import { Tutorial } from './pages/Tutorial'
import { Profile } from './pages/Profile'
import { Welcome } from './pages/Welcome'
import { OTP } from './pages/OTP'
import { Setup } from './pages/Setup'
import { BeforeCapture } from './pages/BeforeCapture'
import { CaptureFlow } from './pages/CaptureFlow'
import { LiveCapture } from './pages/LiveCapture'
import { CertificateScan } from './pages/CertificateScan'
import { WeightEntry } from './pages/WeightEntry'
import { Processing } from './pages/Processing'
import { Result } from './pages/Result'
import { FinalEvaluation } from './pages/FinalEvaluation'
import { GoldLoanApplication } from './pages/GoldLoanApplication'
import { DashboardHome } from './pages/DashboardHome'
import { MyEvaluations } from './pages/MyEvaluations'
import { DashboardDetail } from './pages/DashboardDetail'
import { FieldAgent } from './pages/FieldAgent'
import { Confirmation } from './pages/Confirmation'
import { VideoEval } from './pages/VideoEval'
import { AudioEval } from './pages/AudioEval'
import { AudioRemote } from './pages/AudioRemote'
import { AddItem } from './pages/AddItem'
import { useSessionStore } from './store/session'
import { FloatingAssistant } from './components/FloatingAssistant'
import { UserRound } from 'lucide-react'

// Stop any in-progress speech the moment the route changes, so the previous
// page's TTS never bleeds into the page the user just navigated to. The new
// page starts its own narration fresh on mount.
function TTSRouteGuard() {
  const location = useLocation()
  useEffect(() => {
    stopSpeech()
  }, [location.pathname])
  return null
}

function ProfileShortcut() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state } = useSessionStore()
  const hiddenRoutes = new Set([
    '/',
    '/register',
    '/login',
    '/profile',
    '/welcome',
    '/setup',
    '/before-capture',
    '/dashboard-home',
    '/my-evaluations',
    '/gold-loan-app',
  ])
  if (!state.authToken || hiddenRoutes.has(location.pathname)) return null
  return (
    <button
      onClick={() => navigate('/profile', { state: { from: location.pathname } })}
      className="absolute right-4 top-4 z-[200] h-10 w-10 rounded-2xl border border-stone-200/80 bg-white/90 shadow-sm backdrop-blur-xl flex items-center justify-center"
      aria-label="Open profile"
    >
      {state.userProfile?.profile_photo_url
        ? <img src={state.userProfile.profile_photo_url} className="h-full w-full rounded-2xl object-cover" alt="" />
        : <UserRound className="h-4 w-4 text-stone-600" />}
    </button>
  )
}

function RequireRegistered({ children }: { children: JSX.Element }) {
  const location = useLocation()
  const { state } = useSessionStore()

  if (!state.authToken || state.authToken === 'guest') {
    return <Navigate to="/register" replace state={{ from: location.pathname }} />
  }

  return children
}

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <TTSRouteGuard />
        <ProfileShortcut />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/language" element={<LanguagePicker />} />
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route path="/tutorial" element={<Tutorial />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/otp" element={<OTP />} />
          <Route path="/setup" element={<RequireRegistered><Setup /></RequireRegistered>} />
          <Route path="/before-capture" element={<RequireRegistered><BeforeCapture /></RequireRegistered>} />
          <Route path="/capture" element={<RequireRegistered><CaptureFlow /></RequireRegistered>} />
          <Route path="/live-capture" element={<RequireRegistered><LiveCapture /></RequireRegistered>} />
          <Route path="/certificate-scan" element={<RequireRegistered><CertificateScan /></RequireRegistered>} />
          <Route path="/video-eval" element={<RequireRegistered><VideoEval /></RequireRegistered>} />
          <Route path="/audio-eval" element={<RequireRegistered><AudioEval /></RequireRegistered>} />
          <Route path="/audio-remote" element={<RequireRegistered><AudioRemote /></RequireRegistered>} />
          <Route path="/add-item" element={<RequireRegistered><AddItem /></RequireRegistered>} />
          <Route path="/weight" element={<RequireRegistered><WeightEntry /></RequireRegistered>} />
          <Route path="/processing" element={<RequireRegistered><Processing /></RequireRegistered>} />
          <Route path="/result" element={<RequireRegistered><Result /></RequireRegistered>} />
          <Route path="/final-eval" element={<RequireRegistered><FinalEvaluation /></RequireRegistered>} />
          <Route path="/gold-loan-app" element={<RequireRegistered><GoldLoanApplication /></RequireRegistered>} />
          <Route path="/dashboard-home" element={<DashboardHome />} />
          <Route path="/dashboard-home/session/:id" element={<DashboardDetail />} />
          <Route path="/my-evaluations" element={<MyEvaluations />} />
          <Route path="/my-evaluations/session/:id" element={<DashboardDetail />} />
          <Route path="/chatbot" element={<DashboardHome />} />
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
