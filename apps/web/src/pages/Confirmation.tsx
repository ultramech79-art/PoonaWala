import { useNavigate } from 'react-router-dom'
import { CheckCircle, Home } from 'lucide-react'

export function Confirmation() {
  const navigate = useNavigate()

  return (
    <div className="page animate-fade-in bg-stone-50 flex flex-col items-center justify-center min-h-screen px-5">
      {/* Branding */}
      <div className="mb-12 bg-white py-3 px-5 rounded-2xl shadow-sm border border-stone-100">
        <img src="/assets/poonawalla_logo_full.png" alt="Poonawalla Fincorp" className="h-8 object-contain" />
      </div>

      {/* Success Icon */}
      <div className="w-24 h-24 rounded-full bg-emerald-50 border-4 border-emerald-100 flex items-center justify-center mb-6">
        <CheckCircle className="w-12 h-12 text-emerald-500" />
      </div>

      {/* Message */}
      <h1 className="font-display font-black text-3xl text-stone-900 text-center mb-3">
        Request Confirmed
      </h1>
      <p className="text-base text-stone-500 text-center leading-relaxed max-w-sm mb-12">
        Your gold loan assessment has been securely submitted. An agent will call you shortly to schedule the final pickup.
      </p>

      {/* Action */}
      <div className="w-full max-w-sm">
        <button
          onClick={() => navigate('/')}
          className="btn-primary w-full shadow-brand"
        >
          <Home className="w-5 h-5 mr-1" />
          Back to Home
        </button>
      </div>
    </div>
  )
}
