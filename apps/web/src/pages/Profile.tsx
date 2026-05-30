import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, History, Image as ImageIcon, LogOut, UserRound } from 'lucide-react'
import { listLoanPredictionsAPI, listMyAssetsAPI, type UserAsset } from '../lib/api'
import { useSessionStore } from '../store/session'

export function Profile() {
  const navigate = useNavigate()
  const { state, clearAuth } = useSessionStore()
  const [assets, setAssets] = useState<UserAsset[]>([])
  const [predictions, setPredictions] = useState<any[]>([])

  useEffect(() => {
    if (!state.authToken) {
      navigate('/auth')
      return
    }
    let cancelled = false
    Promise.all([
      listMyAssetsAPI(state.authToken),
      listLoanPredictionsAPI(state.authToken),
    ]).then(([assetRows, predictionRows]) => {
      if (!cancelled) {
        setAssets(assetRows)
        setPredictions(predictionRows)
      }
    }).catch(() => {
      if (!cancelled) {
        setAssets([])
        setPredictions([])
      }
    })
    return () => { cancelled = true }
  }, [state.authToken, navigate])

  const user = state.userProfile

  return (
    <div className="page bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30 animate-slide-up">
      <div className="page-header">
        <button onClick={() => navigate('/welcome')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">Profile</span>
        <button
          onClick={() => { clearAuth(); navigate('/auth') }}
          className="btn-icon"
          aria-label="Logout"
        >
          <LogOut className="w-4 h-4 text-stone-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6 pt-5 space-y-4">
        <div className="card p-5">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-brand-50 border border-brand-200 flex items-center justify-center overflow-hidden">
              {user?.profile_photo_url
                ? <img src={user.profile_photo_url} className="w-full h-full object-cover" alt="" />
                : <UserRound className="w-7 h-7 text-brand-700" />}
            </div>
            <div className="min-w-0">
              <p className="font-display font-black text-xl text-stone-950 truncate">{user?.full_name}</p>
              <p className="text-sm text-stone-500 truncate">{user?.phone || user?.email}</p>
              <p className="text-xs text-stone-400 mt-1">Region {user?.region_code} · {user?.language?.toUpperCase()}</p>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="w-4 h-4 text-brand-700" />
            <p className="font-display font-bold text-sm text-stone-900">Loan history</p>
          </div>
          {predictions.length === 0 ? (
            <p className="text-sm text-stone-400">No completed loan predictions yet.</p>
          ) : (
            <div className="space-y-2">
              {predictions.map(item => (
                <div key={item.id} className="rounded-xl border border-stone-200 bg-white p-3">
                  <div className="flex justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-stone-900">{item.eligible_loan_inr ? `₹${Math.round(item.eligible_loan_inr).toLocaleString('en-IN')}` : 'Loan estimate'}</p>
                      <p className="text-xs text-stone-500">{item.estimated_weight_g ? `${item.estimated_weight_g.toFixed(2)}g` : 'Weight unavailable'} · {item.region_code}</p>
                    </div>
                    <p className="text-[10px] text-stone-400 text-right">{new Date(item.created_at).toLocaleDateString('en-IN')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <ImageIcon className="w-4 h-4 text-brand-700" />
            <p className="font-display font-bold text-sm text-stone-900">Uploaded images</p>
          </div>
          {assets.length === 0 ? (
            <p className="text-sm text-stone-400">No saved images yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {assets.slice(0, 18).map(asset => (
                <div key={asset.id} className="aspect-square rounded-xl bg-stone-100 border border-stone-200 overflow-hidden">
                  {asset.public_url && <img src={asset.public_url} className="w-full h-full object-cover" alt={asset.asset_kind} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
