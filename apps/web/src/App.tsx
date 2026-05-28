import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Home } from './pages/Home'
import { LanguagePicker } from './pages/LanguagePicker'
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
import { DashboardDetail } from './pages/DashboardDetail'
import { FieldAgent } from './pages/FieldAgent'
import { Confirmation } from './pages/Confirmation'
import { VideoAudioEval } from './pages/VideoAudioEval'
import { useSessionStore } from './store/session'

function App() {
  return (
    <BrowserRouter>
      <div className="max-w-md mx-auto relative w-full" style={{ height: '100dvh' }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/language" element={<LanguagePicker />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/consent" element={<Consent />} />
          <Route path="/otp" element={<OTP />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/capture" element={<CaptureFlow />} />
          <Route path="/live-capture" element={<LiveCapture />} />
          <Route path="/certificate-scan" element={<CertificateScan />} />
          <Route path="/video-eval" element={<VideoAudioEval />} />
          <Route path="/weight" element={<WeightEntry />} />
          <Route path="/processing" element={<Processing />} />
          <Route path="/result" element={<Result />} />
          <Route path="/final-eval" element={<FinalEvaluation />} />
          <Route path="/gold-loan-app" element={<GoldLoanApplication />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/dashboard/session/:id" element={<DashboardDetail />} />
          <Route path="/agent" element={<FieldAgent />} />
          <Route path="/confirmation" element={<Confirmation />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
