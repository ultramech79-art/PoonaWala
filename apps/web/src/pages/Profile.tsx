import { useEffect, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronRight, History, Image as ImageIcon, LogOut, RefreshCw, Trash2, UserRound, X, AlertTriangle } from 'lucide-react'
import { deleteUserAssetAPI, listLoanPredictionsAPI, listMyAssetsAPI, type UserAsset } from '../lib/api'
import { useSessionStore } from '../store/session'

const FRAME_LABELS: Record<string, string> = {
  top: 'Top View',
  '45deg': '45° Angle',
  side: 'Side Profile',
  macro: 'Hallmark',
  selfie: 'Selfie',
  profile_photo: 'Profile',
}

function AssetLabel({ asset }: { asset: UserAsset }) {
  const label = asset.frame_type
    ? FRAME_LABELS[asset.frame_type] || asset.frame_type
    : asset.asset_kind.replace(/_/g, ' ')
  return (
    <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 text-[9px] font-bold text-white capitalize truncate rounded-b-xl">
      {label}
    </span>
  )
}

export function Profile() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, clearAuth } = useSessionStore()
  const [assets, setAssets] = useState<UserAsset[]>([])
  const [predictions, setPredictions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<UserAsset | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())

  const loadData = useCallback(async () => {
    if (!state.authToken) return
    setLoading(true)
    try {
      const [assetRows, predictionRows] = await Promise.all([
        listMyAssetsAPI(state.authToken),
        listLoanPredictionsAPI(state.authToken),
      ])
      setAssets(assetRows)
      setPredictions(predictionRows)
    } catch {
      setAssets([])
      setPredictions([])
    } finally {
      setLoading(false)
    }
  }, [state.authToken])

  useEffect(() => {
    if (!state.authToken) {
      navigate('/auth')
      return
    }
    loadData()
  }, [state.authToken, navigate, loadData])

  const handleDelete = async (asset: UserAsset) => {
    if (!state.authToken) return
    setDeleting(asset.id)
    try {
      await deleteUserAssetAPI(state.authToken, asset.id)
      setAssets(prev => prev.filter(a => a.id !== asset.id))
    } catch {
      // silently fail — user can retry
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  const handleImgError = (id: number) => {
    setImgErrors(prev => new Set([...prev, id]))
  }

  const user = state.userProfile

  // Group assets by session
  const grouped = assets.reduce<Record<string, UserAsset[]>>((acc, asset) => {
    const key = asset.session_id || '_none'
    ;(acc[key] ??= []).push(asset)
    return acc
  }, {})

  const sessionKeys = Object.keys(grouped).sort((a, b) => {
    const aDate = grouped[a][0]?.created_at || ''
    const bDate = grouped[b][0]?.created_at || ''
    return bDate.localeCompare(aDate) // newest first
  })

  return (
    <div className="page bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30 animate-slide-up">
      <div className="page-header">
        <button onClick={() => {
          const from = (location.state as { from?: string } | null)?.from
          if (from && from !== '/profile') navigate(from)
          else navigate(-1)
        }} className="btn-icon">
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
        {/* User Info Card */}
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

        {/* Loan History */}
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

        {/* Uploaded Images */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-brand-700" />
              <p className="font-display font-bold text-sm text-stone-900">Uploaded images</p>
              <span className="text-[10px] font-bold text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded-full">{assets.length}</span>
            </div>
            <button onClick={loadData} disabled={loading} className="flex items-center gap-1 text-[10px] font-bold text-brand-600 hover:text-brand-700 disabled:opacity-40">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} className="aspect-square rounded-xl bg-stone-100 animate-pulse" />
              ))}
            </div>
          ) : assets.length === 0 ? (
            <p className="text-sm text-stone-400">No saved images yet.</p>
          ) : (
            <div className="space-y-4">
              {sessionKeys.map(sessionKey => {
                const sessionAssets = grouped[sessionKey]
                const sessionDate = sessionAssets[0]?.created_at
                  ? new Date(sessionAssets[0].created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                  : ''
                return (
                  <div key={sessionKey}>
                    {sessionKeys.length > 1 && (
                      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                        {sessionKey === '_none' ? 'Unsorted' : `Session · ${sessionDate}`}
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {sessionAssets.map(asset => (
                        <div key={asset.id} className="relative group aspect-square rounded-xl bg-stone-100 border border-stone-200 overflow-hidden">
                          {asset.public_url && !imgErrors.has(asset.id) ? (
                            <img
                              src={asset.public_url}
                              className="w-full h-full object-cover cursor-pointer"
                              alt={asset.asset_kind}
                              loading="lazy"
                              onClick={() => setLightbox(asset.public_url)}
                              onError={() => handleImgError(asset.id)}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ImageIcon className="w-6 h-6 text-stone-300" />
                            </div>
                          )}
                          <AssetLabel asset={asset} />
                          {/* Delete button */}
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(asset) }}
                            disabled={deleting === asset.id}
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-500/80 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-red-600"
                          >
                            {deleting === asset.id
                              ? <div className="w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                              : <Trash2 className="w-3 h-3 text-white" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 animate-fade-in" onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
            <X className="w-5 h-5 text-white" />
          </button>
          <img src={lightbox} className="max-w-full max-h-[85vh] rounded-2xl object-contain" alt="" />
        </div>
      )}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-end justify-center p-4 animate-fade-in" onClick={() => setConfirmDelete(null)}>
          <div className="w-full max-w-sm bg-white rounded-3xl p-5 space-y-4 shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <p className="font-display font-bold text-stone-900">Delete image?</p>
                <p className="text-xs text-stone-500">This will permanently remove it from your profile and cloud storage.</p>
              </div>
            </div>
            {confirmDelete.public_url && (
              <div className="w-full h-32 rounded-xl overflow-hidden bg-stone-100">
                <img src={confirmDelete.public_url} className="w-full h-full object-cover" alt="" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="py-3 rounded-2xl text-sm font-bold border border-stone-200 text-stone-600 hover:bg-stone-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                disabled={deleting === confirmDelete.id}
                className="py-3 rounded-2xl text-sm font-bold bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50"
              >
                {deleting === confirmDelete.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
