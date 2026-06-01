import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { clsx } from 'clsx'
import { useSessionStore } from '../store/session'
import { createUserSessionAPI, initSessionAPI, recordConsentAPI } from '../lib/api'

/* ── Product image component ───────────────────────── */
function ProductImage({ type }: { type: string }) {
  const images: Record<string, string> = {
    ring: '/assets/items/ring.png',
    bangles: '/assets/items/bangles.png',
    necklace: '/assets/items/necklace.png',
    earrings: '/assets/items/earrings.png',
    other: '/assets/items/other.png',
  }

  return (
    <img
      src={images[type]}
      alt={type}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  )
}


export function Setup() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { state, resetAssessment, setPageEvidence } = useSessionStore()

  const ITEM_TYPES = [
    { id: 'ring',     label: t('item_ring') },
    { id: 'bangles',  label: t('item_bangles') },
    { id: 'necklace', label: t('item_necklace') },
    { id: 'earrings', label: t('item_earrings') },
    { id: 'other',    label: t('item_other') },
  ]
  const [selected, setSelected] = useState<string | null>(null)

  async function startCapture() {
    const fallbackSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    let sessionId = fallbackSessionId
    try {
      const res = await initSessionAPI(state.lang, state.userProfile?.phone ?? state.phone ?? undefined)
      sessionId = res.session_id
      recordConsentAPI(sessionId).catch(() => {})
      if (state.authToken && state.authToken !== 'guest') {
        createUserSessionAPI(state.authToken, sessionId, state.userProfile?.region_code, 'setup')
          .catch(err => console.warn('[session] failed to create user session', err))
      }
    } catch (err) {
      console.warn('[session] backend session init failed; using local session id', err)
    }
    resetAssessment(sessionId)
    setPageEvidence('capture', { jewelleryType: selected, jewelryType: selected })
    navigate('/before-capture')
  }

  return (
    <div
      className="page animate-slide-up"
      style={{ position: 'relative', zIndex: 4, isolation: 'isolate' }}
    >
      {/* Gold jewelry background + grid pattern */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          backgroundImage: `
            url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"><defs><radialGradient id="g1"><stop offset="0%25" style="stop-color:%23D4AF37;stop-opacity:0.08"/><stop offset="100%25" style="stop-color:%23D4AF37;stop-opacity:0"/></radialGradient></defs><circle cx="80" cy="150" r="120" fill="url(%23g1)"/><circle cx="320" cy="400" r="140" fill="url(%23g1)"/></svg>'),
            linear-gradient(rgba(120,113,108,0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(120,113,108,0.06) 1px, transparent 1px)
          `,
          backgroundSize: '400px 600px, 28px 28px, 28px 28px',
          backgroundRepeat: 'repeat, repeat, repeat',
          borderRadius: 'inherit',
        }}
      />

      <div className="relative z-10 flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        {/* Heading with back button */}
        <div className="pt-6 pb-7">
          <button
            id="setup-back"
            onClick={() => navigate('/dashboard-home')}
            className="flex items-center justify-center w-10 h-10 rounded-full bg-stone-950 text-white active:opacity-70 transition-opacity flex-shrink-0 mb-4"
          >
            <ArrowLeft className="w-4 h-4" strokeWidth={2.2} />
          </button>
          <div className="border-b border-stone-200/60 pb-5 mb-0">
            <h1 className="font-display font-black text-3xl leading-[1.15] tracking-[-0.04em] text-stone-950 mb-1">
              What are you assessing?
            </h1>
            <p className="text-sm text-stone-500">Select the type of gold item</p>
          </div>
        </div>

        {/* Item type grid — 2x2 + 1 */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          {ITEM_TYPES.slice(0, 4).map(({ id, label }) => {
            const active = selected === id
            return (
              <button
                key={id}
                onClick={() => setSelected(id)}
                className={clsx(
                  'flex flex-col rounded-3xl overflow-hidden transition-all duration-300 active:scale-[0.96]',
                  active
                    ? 'bg-gradient-to-b from-amber-700 to-amber-900 shadow-xl shadow-amber-900/40 ring-2 ring-amber-500/30'
                    : 'bg-white shadow-sm hover:shadow-md hover:shadow-stone-900/10'
                )}
              >
                <div className={clsx('w-full h-32 flex items-center justify-center overflow-hidden transition-colors', active ? 'bg-gradient-to-br from-amber-50 to-yellow-50' : 'bg-gradient-to-br from-stone-100 to-stone-50')}>
                  <ProductImage type={id} />
                </div>
                <div className={clsx('w-full text-center py-3 px-2 font-semibold transition-colors', active ? 'text-amber-950 bg-gradient-to-b from-amber-100 to-amber-50' : 'text-stone-700 bg-white/50')}>
                  <span className="text-xs tracking-wide">{label}</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* 5th item — centred */}
        <div className="flex justify-center mb-8">
          {(() => {
            const { id, label } = ITEM_TYPES[4]
            const active = selected === id
            return (
              <button
                onClick={() => setSelected(id)}
                className={clsx(
                  'flex flex-col rounded-3xl overflow-hidden transition-all duration-300 active:scale-[0.96]',
                  active
                    ? 'bg-gradient-to-b from-amber-700 to-amber-900 shadow-xl shadow-amber-900/40 ring-2 ring-amber-500/30'
                    : 'bg-white shadow-sm hover:shadow-md hover:shadow-stone-900/10'
                )}
                style={{ width: 'calc(50% - 8px)' }}
              >
                <div className={clsx('w-full h-32 flex items-center justify-center overflow-hidden transition-colors', active ? 'bg-gradient-to-br from-amber-50 to-yellow-50' : 'bg-gradient-to-br from-stone-100 to-stone-50')}>
                  <ProductImage type={id} />
                </div>
                <div className={clsx('w-full text-center py-3 px-2 font-semibold transition-colors', active ? 'text-amber-950 bg-gradient-to-b from-amber-100 to-amber-50' : 'text-stone-700 bg-white/50')}>
                  <span className="text-xs tracking-wide">{label}</span>
                </div>
              </button>
            )
          })()}
        </div>

      </div>

      <div className="relative z-10 px-5 pb-6 pt-4 border-t border-stone-200/80 bg-white/70 backdrop-blur-xl">
        <button
          id="setup-ready"
          onClick={startCapture}
          disabled={!selected}
          className={clsx(
            'w-full py-4 rounded-2xl font-semibold text-white flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98]',
            selected
              ? 'bg-stone-950 shadow-lg hover:shadow-xl'
              : 'bg-stone-300 cursor-not-allowed'
          )}
        >
          {t('setup_ready')}
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
