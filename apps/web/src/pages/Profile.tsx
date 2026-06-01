import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, History, Image as ImageIcon, LogOut, RefreshCw, Trash2, UserRound, X, AlertTriangle } from 'lucide-react'
import { assetImageDataUrlAPI, deleteUserAssetAPI, listLoanPredictionsAPI, listMyAssetsAPI, type UserAsset } from '../lib/api'
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
  const jewelleryType = String(asset.metadata?.jewelry_type || asset.metadata?.jewellery_type || '').replace(/_/g, ' ')
  const label = asset.frame_type
    ? FRAME_LABELS[asset.frame_type] || asset.frame_type
    : asset.asset_kind.replace(/_/g, ' ')
  return (
    <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 text-[9px] font-bold text-white capitalize truncate rounded-b-xl">
      {jewelleryType ? `${jewelleryType} · ${label}` : label}
    </span>
  )
}

export function Profile() {
  const navigate = useNavigate()
  const { state, clearAuth } = useSessionStore()
  const [assets, setAssets] = useState<UserAsset[]>([])
  const [predictions, setPredictions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<UserAsset | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())
  const [assetImageSrcs, setAssetImageSrcs] = useState<Record<number, string>>({})

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
      navigate('/')
      return
    }
    if (state.authToken === 'guest') {
      setLoading(false)
      return
    }
    loadData()
  }, [state.authToken, navigate, loadData])

  useEffect(() => {
    if (!state.authToken || state.authToken === 'guest') return
    assets.forEach(asset => {
      if (assetImageSrcs[asset.id]) return
      assetImageDataUrlAPI(state.authToken!, asset.id)
        .then(src => {
          setAssetImageSrcs(prev => ({ ...prev, [asset.id]: src }))
          setImgErrors(prev => {
            const next = new Set(prev)
            next.delete(asset.id)
            return next
          })
        })
        .catch(() => {
          if (!asset.public_url) handleImgError(asset.id)
        })
    })
  }, [assets, assetImageSrcs, state.authToken])

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

  const openAsset = (asset: UserAsset) => {
    const src = assetImageSrcs[asset.id] || asset.public_url
    if (src) setLightbox(src)
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
    <div className="page app-page-bg animate-slide-up">
      <div className="page-header">
        <button onClick={() => navigate(-1)} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">Profile</span>
        <button
          onClick={() => { clearAuth(); navigate('/') }}
          className="btn-icon"
          aria-label="Logout"
        >
          <LogOut className="w-4 h-4 text-stone-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-6 pt-5 space-y-4">
        {state.authToken === 'guest' ? (
          <div className="surface-panel rounded-3xl p-6 flex flex-col items-center justify-center text-center mt-10">
            <div className="w-16 h-16 rounded-full bg-stone-100 flex items-center justify-center mb-4">
              <UserRound className="w-8 h-8 text-stone-400" />
            </div>
            <h2 className="text-xl font-bold text-stone-900 mb-2">Guest Mode</h2>
            <p className="text-sm text-stone-500 mb-6">
              You are currently using the app as a guest. To save your loan predictions, captures, and view your profile history, please create an account.
            </p>
            <button
              onClick={() => { clearAuth(); navigate('/') }}
              className="btn-primary w-full"
            >
              Sign In / Register
            </button>
          </div>
        ) : (
          <div className="surface-panel rounded-3xl p-5">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-brand-50 border border-brand-200 flex items-center justify-center overflow-hidden">
                {user?.profile_photo_url
                  ? <img src={user.profile_photo_url} className="w-full h-full object-cover" alt="" />
                  : <UserRound className="w-7 h-7 text-brand-700" />}
              </div>
              <div className="min-w-0">
                <p className="font-display font-black text-xl text-stone-950 truncate">{user?.full_name}</p>
                <p className="text-sm text-stone-500 truncate">{user?.phone}</p>
                <p className="text-xs text-stone-400 mt-1">Region {user?.region_code} · {user?.language?.toUpperCase()}</p>
              </div>
            </div>
          </div>
        )}



        {state.authToken !== 'guest' && (
          <div className="surface-panel rounded-3xl p-4">
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
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                        {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                      <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">
                        ₹{item.provisional_loan_inr?.toLocaleString('en-IN') || '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-sm font-medium text-stone-700">
                      <span>{item.ltv_pct}% LTV</span>
                      <span className="text-stone-300">•</span>
                      <span>₹{item.city_gold_value_inr?.toLocaleString('en-IN') || '—'} Value</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Saved Assets */}
        {state.authToken !== 'guest' && (
          <div className="surface-panel rounded-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-brand-700" />
                <p className="font-display font-bold text-sm text-stone-900">Saved uploads</p>
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
              <p className="text-sm text-stone-400">No images saved yet.</p>
            ) : (
              <div className="space-y-6">
                {sessionKeys.map(sessionKey => {
                  const sessionAssets = grouped[sessionKey]
                  const sessionDate = new Date(sessionAssets[0].created_at)
                  return (
                    <div key={sessionKey}>
                      <p className="text-xs font-bold text-stone-500 uppercase tracking-widest mb-3 border-b border-stone-100 pb-2">
                        {sessionKey === '_none' ? 'Legacy Uploads' : sessionDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {sessionAssets.map(asset => (
                          <div key={asset.id} className="relative group aspect-square rounded-xl overflow-hidden bg-stone-100 border border-stone-200">
                            {assetImageSrcs[asset.id] || asset.public_url ? (
                              <img
                                src={assetImageSrcs[asset.id] || asset.public_url || ''}
                                alt={asset.frame_type || asset.asset_kind}
                                className="w-full h-full object-cover cursor-zoom-in transition-transform group-hover:scale-105"
                                onError={() => handleImgError(asset.id)}
                                onLoad={() => {
                                  setImgErrors(prev => {
                                    const next = new Set(prev)
                                    next.delete(asset.id)
                                    return next
                                  })
                                }}
                                onClick={() => openAsset(asset)}
                              />
                            ) : imgErrors.has(asset.id) ? (
                              <div className="w-full h-full flex items-center justify-center bg-stone-100">
                                <AlertTriangle className="w-5 h-5 text-stone-400" />
                              </div>
                            ) : (
                              <div className="w-full h-full animate-pulse bg-stone-100" />
                            )}
                            <AssetLabel asset={asset} />
                            <button
                              onClick={() => setConfirmDelete(asset)}
                              disabled={deleting === asset.id}
                              className="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-500/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 disabled:opacity-50"
                            >
                              {deleting === asset.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
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
        )}
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
            {(assetImageSrcs[confirmDelete.id] || confirmDelete.public_url) && (
              <div className="w-full h-32 rounded-xl overflow-hidden bg-stone-100">
                <img src={assetImageSrcs[confirmDelete.id] || confirmDelete.public_url || ''} className="w-full h-full object-cover" alt="" />
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
