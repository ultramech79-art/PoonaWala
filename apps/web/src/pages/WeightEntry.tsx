import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Lottie from 'lottie-react'
import goldAnim from '../assets/gold-analysis.json'
import {
  AlertCircle,
  ArrowRight,
  ChevronRight,
  Coins,
  FileImage,
  ImageUp,
  Loader2,
  Scale,
  Sparkles,
  Volume2,
  User,
} from 'lucide-react'
import { estimateWeightAPI, urlToDataUrl, type GoldKarat, type JewelryType, type WeightEstimateResult } from '../lib/api'
import { useSessionStore } from '../store/session'
import { speak } from '../lib/tts'

function GoldLottie({ size = 40 }: { size?: number }) {
  const ref = useRef<import('lottie-react').LottieRefCurrentProps>(null)
  return (
    <Lottie
      animationData={goldAnim}
      loop autoplay
      lottieRef={ref}
      onDOMLoaded={() => ref.current?.setSpeed(3)}
      style={{ width: size, height: size }}
    />
  )
}

const JEWELRY_TYPES: Array<{ value: JewelryType; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'ring', label: 'Ring' },
  { value: 'bangle', label: 'Bangle' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'necklace', label: 'Necklace' },
  { value: 'pendant', label: 'Pendant' },
  { value: 'chain', label: 'Chain' },
  { value: 'irregular', label: 'Irregular' },
]

const KARATS: GoldKarat[] = [22, 24, 18]
const ANALYSING_MSG_KEYS = [
  'weight_analysing_coin',
  'weight_analysing_outline',
  'weight_analysing_weigh',
  'weight_analysing_done',
]

type WeightSlot = 'top' | 'angle' | 'side'

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read image file'))
    reader.readAsDataURL(file)
  })
}

async function compressImageFile(file: File, maxSide = 900, quality = 0.68): Promise<string> {
  const original = await readFileAsDataUrl(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = original
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Could not decode image file'))
  })

  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return original
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

function errorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : 'Weight estimation failed'
  try {
    const jsonText = text.slice(text.indexOf('{'))
    const parsed = JSON.parse(jsonText)
    return parsed?.detail?.message || text
  } catch {
    return text.replace('/api/weight-estimate -> 422:', '').trim()
  }
}

// UI-only display formatter — turns internal identifiers (snake_case, prefixes,
// key:value strings) into clean readable text. Does not change any logic/data.
function pretty(value: string): string {
  return String(value)
    .replace(/vlm[_ ]?roi[_ ]?/gi, '')
    .replace(/[_:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200/70 bg-white px-3.5 py-3 shadow-[0_1px_3px_rgba(120,113,108,0.06)]">
      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">{label}</p>
      <p className="mt-1 text-sm font-bold leading-snug text-stone-900 break-words">{value}</p>
    </div>
  )
}

function Visualization({ title, src }: { title: string; src: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <img src={src} alt={title} className="aspect-[4/3] w-full object-contain bg-stone-950" />
      <p className="px-3 py-2 text-xs font-semibold text-stone-600">{title}</p>
    </div>
  )
}

export function WeightEntry() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { setWeight, setPageEvidence, savePendingAssessmentItem, state } = useSessionStore()
  const [topImageDataUrl, setTopImageDataUrl] = useState<string | null>(null)
  const [angleImageDataUrl, setAngleImageDataUrl] = useState<string | null>(null)
  const [sideImageDataUrl, setSideImageDataUrl] = useState<string | null>(null)
  const [fileNames, setFileNames] = useState({ top: '', angle: '', side: '' })
  const [jewelryType, setJewelryType] = useState<JewelryType>('auto')
  const [karat, setKarat] = useState<GoldKarat>((state.scannedKarat as GoldKarat) || 22)
  // Step 1 = manual weight entry, Step 2 = AI photo estimate.
  const [mode, setMode] = useState<'manual' | 'ai'>('manual')
  // The bill/certificate weight is ground truth — prefill the manual entry with it.
  const billWeightG = state.certificateData?.weightG ?? null
  const [manualWeight, setManualWeight] = useState(() => (billWeightG ? String(billWeightG) : ''))
  const prefilledFromBill = billWeightG != null && manualWeight === String(billWeightG)
  // Photo carousel — show one view at a time, auto-rotating, so nothing overflows.
  const [viewIdx, setViewIdx] = useState(0)
  // Cycling status copy shown while the estimate runs.
  const [analysingMsg, setAnalysingMsg] = useState(0)
  const [dragActive, setDragActive] = useState<'top' | 'angle' | 'side' | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<WeightEstimateResult | null>(null)
  const [jewelryPoint, setJewelryPoint] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (mode === 'manual') {
      speak(t('weight_speak_manual'))
    } else {
      speak(t('weight_speak_ai'))
    }
  }, [mode, t])

  // Auto-populate from CaptureFlow captures (top, 45deg, side)
  useEffect(() => {
    const captures = state.captures
    let mounted = true

    async function prefill() {
      // Top view
      if (captures.top?.dataUrl && !topImageDataUrl) {
        const du = captures.top.dataUrl
        if (du.startsWith('data:')) {
          setTopImageDataUrl(du)
          setFileNames(prev => ({ ...prev, top: 'capture_top.jpg' }))
        } else {
          try {
            const converted = await urlToDataUrl(du)
            if (mounted) {
              setTopImageDataUrl(converted)
              setFileNames(prev => ({ ...prev, top: 'capture_top.jpg' }))
            }
          } catch { /* user can upload manually */ }
        }
      }
      // 45-degree view
      if (captures['45deg']?.dataUrl && !angleImageDataUrl) {
        const du = captures['45deg'].dataUrl
        if (du.startsWith('data:')) {
          setAngleImageDataUrl(du)
          setFileNames(prev => ({ ...prev, angle: 'capture_45deg.jpg' }))
        } else {
          try {
            const converted = await urlToDataUrl(du)
            if (mounted) {
              setAngleImageDataUrl(converted)
              setFileNames(prev => ({ ...prev, angle: 'capture_45deg.jpg' }))
            }
          } catch { /* user can upload manually */ }
        }
      }
      // Side view
      if (captures.side?.dataUrl && !sideImageDataUrl) {
        const du = captures.side.dataUrl
        if (du.startsWith('data:')) {
          setSideImageDataUrl(du)
          setFileNames(prev => ({ ...prev, side: 'capture_side.jpg' }))
        } else {
          try {
            const converted = await urlToDataUrl(du)
            if (mounted) {
              setSideImageDataUrl(converted)
              setFileNames(prev => ({ ...prev, side: 'capture_side.jpg' }))
            }
          } catch { /* user can upload manually */ }
        }
      }
    }

    prefill()

    return () => { mounted = false }
  }, [state.captures, topImageDataUrl, angleImageDataUrl, sideImageDataUrl])

  // Auto-advance the photo carousel while on the AI page.
  useEffect(() => {
    if (mode !== 'ai' || result) return
    const id = setInterval(() => setViewIdx(i => (i + 1) % 3), 3500)
    return () => clearInterval(id)
  }, [mode, result])

  // Cycle the analysing copy while the estimate is running.
  useEffect(() => {
    if (!loading) { setAnalysingMsg(0); return }
    const id = setInterval(() => setAnalysingMsg(i => Math.min(i + 1, ANALYSING_MSG_KEYS.length - 1)), 1400)
    return () => clearInterval(id)
  }, [loading])

  const confidencePct = useMemo(() => Math.round((result?.confidence.score ?? 0) * 100), [result])

  async function loadFile(slot: WeightSlot, file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError(t('weight_bad_image'))
      return
    }
    setError('')
    setResult(null)
    if (slot === 'top') setJewelryPoint(null)
    setFileNames((current) => ({ ...current, [slot]: file.name }))
    const dataUrl = await compressImageFile(file)
    if (slot === 'top') setTopImageDataUrl(dataUrl)
    if (slot === 'angle') setAngleImageDataUrl(dataUrl)
    if (slot === 'side') setSideImageDataUrl(dataUrl)
  }

  async function runEstimate() {
    if (!topImageDataUrl || !angleImageDataUrl || !sideImageDataUrl) {
      setError(t('weight_need_three'))
      return
    }
    setLoading(true)
    setError('')
    try {
      const estimate = await estimateWeightAPI(topImageDataUrl, angleImageDataUrl, sideImageDataUrl, jewelryType, karat, jewelryPoint)
      setResult(estimate)
      setWeight(estimate.weight.estimated_g)
      setPageEvidence('weight', {
        skipped: false,
        source: 'estimate',
        estimatedG: estimate.weight.estimated_g,
        confidence: estimate.confidence.score,
        method: estimate.weight.method,
        karat,
        jewelryType,
        hasTop: Boolean(topImageDataUrl),
        has45deg: Boolean(angleImageDataUrl),
        hasSide: Boolean(sideImageDataUrl),
      })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  function continueWithManual() {
    const grams = parseFloat(manualWeight)
    if (!isFinite(grams) || grams <= 0 || grams > 5000) {
      setError(t('weight_invalid'))
      return
    }
    setError('')
    const fromBill = billWeightG != null && grams === billWeightG
    setWeight(grams)
    setPageEvidence('weight', {
      skipped: false,
      source: fromBill ? 'bill' : 'manual',
      estimatedG: grams,
      confidence: 1,
      method: fromBill ? 'bill_extracted' : 'manual_entry',
      karat,
      jewelryType,
    })
    savePendingAssessmentItem()
    navigate('/add-item')
  }

  function continueFlow() {
    setWeight(result?.weight.estimated_g ?? null)
    setPageEvidence('weight', {
      skipped: !result,
      source: result ? 'estimate' : 'none',
      estimatedG: result?.weight.estimated_g ?? null,
      confidence: result?.confidence.score ?? null,
      method: result?.weight.method ?? null,
    })
    savePendingAssessmentItem()
    navigate('/add-item')
  }

  function UploadSlot({
    slot,
    title,
    hint,
    src,
    fileName,
    aspect = 'aspect-square',
  }: {
    slot: WeightSlot
    title: string
    hint: string
    src: string | null
    fileName: string
    aspect?: string
  }) {
    const isTop = slot === 'top'
    return (
      <div className="rounded-2xl border-2 border-dashed border-stone-200 bg-white p-3 text-center">
        <div
          className={`relative w-full overflow-hidden rounded-xl ${aspect} ${src ? 'bg-stone-100' : 'flex flex-col items-center justify-center bg-stone-50/60'} ${isTop && src ? 'cursor-crosshair' : ''}`}
          onClick={(event) => {
            if (!isTop || !src) return
            const rect = event.currentTarget.getBoundingClientRect()
            setJewelryPoint({
              x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
              y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
            })
            setResult(null)
          }}
        >
          {src ? (
            <>
              <img src={src} alt={`${title} preview`} className="absolute inset-0 h-full w-full object-cover" />
              {isTop && jewelryPoint && (
                <div
                  className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-600 shadow-lg ring-2 ring-brand-600/30"
                  style={{ left: `${jewelryPoint.x * 100}%`, top: `${jewelryPoint.y * 100}%` }}
                />
              )}
            </>
          ) : (
            <>
              <ImageUp className="mb-2 h-7 w-7 text-stone-300" />
              <p className="text-sm font-bold text-stone-400">{t('not_captured')}</p>
              <p className="mt-1 max-w-xs px-2 text-xs leading-relaxed text-stone-400">{t('view_skipped')}</p>
            </>
          )}
        </div>
        {fileName && src && (
          <div className="mt-3 flex max-w-full items-center gap-2 text-xs text-stone-500">
            <FileImage className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{fileName}</span>
          </div>
        )}
      </div>
    )
  }

  if (mode === 'manual') {
    const manualValid = (() => {
      const grams = parseFloat(manualWeight)
      return isFinite(grams) && grams > 0 && grams <= 5000
    })()
    return (
      <div className="page animate-slide-up">
        <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
          <button id="weight-back" onClick={() => navigate('/certificate-scan')} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md">
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-0.5 rounded-full bg-stone-100/80 border border-stone-200/60">{t('weight_chip')}</span>
            <span className="text-base font-bold text-stone-950 tracking-tight">{t('weight_title_manual')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => speak(t('weight_speak_manual'))} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
              <Volume2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
              <User className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6">
          <div className="py-5">
            <div className="mb-5">
              <h1 className="font-display text-xl font-bold text-stone-950">{t('weight_q')}</h1>
              <p className="text-xs leading-relaxed text-stone-500 mt-1">{t('weight_q_sub')}</p>
            </div>

            <div className="rounded-2xl border border-stone-200 bg-white p-5">
              <label htmlFor="manual-weight" className="label mb-2 block">{t('weight_label')}</label>
              <div className="relative">
                <Scale className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400" />
                <input
                  id="manual-weight"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={manualWeight}
                  onChange={(event) => { setManualWeight(event.target.value); setError('') }}
                  placeholder={t('weight_placeholder')}
                  className="input-field py-4 pl-12 pr-12 text-lg font-semibold"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-stone-400">g</span>
              </div>
              {prefilledFromBill && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  {t('weight_bill_note')}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => { setError(''); setMode('ai') }}
              className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-stone-200 bg-white p-4 text-left transition-colors hover:border-gold-300 hover:bg-gold-50/40 active:scale-[0.99]"
            >
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gold-100 text-gold-700">
                <Sparkles className="h-5 w-5" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-bold text-stone-900">{t('weight_ai_card_title')}</span>
                <span className="block text-xs text-stone-500">{t('weight_ai_card_sub')}</span>
              </span>
              <ArrowRight className="h-4 w-4 flex-shrink-0 text-stone-400" />
            </button>

            {error && (
              <div className="mt-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3 border-t border-stone-200 px-5 pb-6 pt-4">
          <button onClick={continueWithManual} disabled={!manualValid} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 text-white font-semibold transition-colors active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed">
            {t('continue')} <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page animate-slide-up">
      {/* Analysing overlay — gold animation while the weight estimate runs */}
      {loading && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[#fffdf8]/95 backdrop-blur-sm animate-fade-in">
          <GoldLottie size={176} />
          <div className="text-center mt-2">
            <p className="font-bold text-stone-900 text-base tracking-tight">{t('weight_analysing_title')}</p>
            <p className="text-stone-400 text-sm mt-1 transition-all duration-300">{t(ANALYSING_MSG_KEYS[analysingMsg])}</p>
          </div>
        </div>
      )}

      <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
        <button id="weight-back" onClick={() => { setError(''); setMode('manual') }} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md">
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-0.5 rounded-full bg-stone-100/80 border border-stone-200/60">{t('weight_chip')}</span>
          <span className="text-base font-bold text-stone-950 tracking-tight">{t('weight_title_ai')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => speak(t('weight_speak_ai'))} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
            <Volume2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
            <User className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="py-5">
          <div className="mb-4">
            <h1 className="font-display text-xl font-bold text-stone-950">{t('weight_opt_title')}</h1>
            <p className="text-xs leading-relaxed text-stone-500 mt-1">{t('weight_opt_sub')}</p>
          </div>

          {/* Auto-populated notice */}
          {(fileNames.top === 'capture_top.jpg' || fileNames.angle === 'capture_45deg.jpg' || fileNames.side === 'capture_side.jpg') && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {t('weight_prefilled_note')}
            </div>
          )}

          {/* Photo carousel — one view at a time, auto-rotating, no overflow */}
          {(() => {
            const views = [
              { slot: 'top' as WeightSlot, title: t('view_top_title'), short: t('view_top'), hint: t('view_top_hint'), src: topImageDataUrl, fileName: fileNames.top },
              { slot: 'angle' as WeightSlot, title: t('view_45_title'), short: t('view_45'), hint: t('view_45_hint'), src: angleImageDataUrl, fileName: fileNames.angle },
              { slot: 'side' as WeightSlot, title: t('view_side_title'), short: t('view_side'), hint: t('view_side_hint'), src: sideImageDataUrl, fileName: fileNames.side },
            ]
            const active = views[viewIdx]
            return (
              <div>
                <div key={active.slot} className="animate-fade-in">
                  <UploadSlot slot={active.slot} title={active.title} hint={active.hint} src={active.src} fileName={active.fileName} aspect="aspect-[4/3]" />
                </div>
                {/* Minimal premium indicator bar */}
                <div className="mt-3 flex items-center gap-2.5">
                  {views.map((v, i) => (
                    <button key={v.slot} type="button" onClick={() => setViewIdx(i)} className="flex flex-1 flex-col items-center gap-1.5 active:scale-95 transition-transform">
                      <span className={`h-1 w-full rounded-full transition-all duration-500 ${i === viewIdx ? 'bg-stone-900' : 'bg-stone-200'}`} />
                      <span className={`flex items-center gap-1 text-[10px] font-bold tracking-wide transition-colors ${i === viewIdx ? 'text-stone-900' : 'text-stone-400'}`}>
                        {v.short}
                        <span className={`h-1.5 w-1.5 rounded-full ${v.src ? 'bg-emerald-500' : 'bg-stone-300'}`} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}

          {topImageDataUrl && viewIdx === 0 && (
            <p className="mt-2 text-xs font-medium text-stone-500">
              {t('weight_tap_hint')}
            </p>
          )}

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div>
              <label className="label mb-2 block">{t('jewellery_type')}</label>
              <select className="input-field py-3 text-sm" value={jewelryType} onChange={(event) => setJewelryType(event.target.value as JewelryType)}>
                {JEWELRY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{t(`jt_${type.value}`, { defaultValue: type.label })}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label mb-2 block">{t('gold_karat')}</label>
              <select className="input-field py-3 text-sm" value={karat} onChange={(event) => setKarat(Number(event.target.value) as GoldKarat)}>
                {KARATS.map((value) => (
                  <option key={value} value={value}>{value}K</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
            <div className="flex gap-3">
              <Coins className="mt-0.5 h-5 w-5 flex-shrink-0 text-gold-700" />
              <div>
                <p className="text-sm font-bold text-stone-900">{t('ref_obj_title')}</p>
                <p className="mt-1 text-xs leading-relaxed text-stone-500">
                  {t('ref_obj_sub')}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="mt-5 space-y-4 animate-fade-in">
              {/* Hero — estimated weight */}
              <div className="relative overflow-hidden rounded-3xl border border-gold-200 bg-gradient-to-br from-gold-50 via-[#fffdf7] to-gold-50 p-5 shadow-[0_12px_34px_-14px_rgba(140,107,49,0.45)]">
                <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-gold-300 to-transparent" />
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-700">{t('result_est_weight')}</p>
                    <p className="mt-1 font-display text-[2.75rem] font-black leading-none tracking-tight bg-gradient-to-br from-[#B45309] via-[#8C6B31] to-[#57401F] bg-clip-text text-transparent">{result.weight.estimated_g}g</p>
                    <p className="mt-1.5 text-xs font-medium text-stone-500">{t('result_range', { low: result.weight.low_g, high: result.weight.high_g })}</p>
                  </div>
                  <div className="flex flex-col items-center rounded-2xl bg-white/80 px-3.5 py-2 shadow-sm backdrop-blur-sm">
                    <span className="font-display text-lg font-black text-stone-900">{confidencePct}%</span>
                    <span className="text-[8px] font-bold uppercase tracking-[0.12em] text-stone-400">{t('confidence')}</span>
                  </div>
                </div>
              </div>

              {/* Measurements & analysis */}
              <div>
                <p className="mb-2 px-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-stone-400">{t('measurements')}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Metric label={t('m_detected_type')} value={pretty(result.jewelry_type)} />
                  <Metric label={t('m_volume')} value={`${result.physics.volume_cm3} cm³`} />
                  <Metric label={t('m_width')} value={`${result.dimensions.width_mm} mm`} />
                  <Metric label={t('m_height')} value={`${result.dimensions.height_mm} mm`} />
                  <Metric label={t('m_thickness')} value={`${result.dimensions.estimated_depth_mm} mm`} />
                  <Metric label={t('m_density')} value={`${result.physics.density_g_cm3} g/cm³`} />
                  <Metric label={t('m_mask_method')} value={pretty(result.geometry.segmentation_method)} />
                  {result.geometry.profile_measurement && (
                    <Metric label={t('m_depth_source')} value={pretty(result.geometry.profile_measurement.method)} />
                  )}
                  {result.geometry.profile_measurement && (
                    <Metric label={t('m_side45_thickness')} value={`${result.geometry.profile_measurement.side_thickness_mm} / ${result.geometry.profile_measurement.angle_45_thickness_mm} mm`} />
                  )}
                  {result.geometry.volume_model?.minor_radius_mm && (
                    <Metric label={t('m_torus_radii')} value={`${result.geometry.volume_model.major_radius_mm} / ${result.geometry.volume_model.minor_radius_mm} mm`} />
                  )}
                  {result.geometry.volume_model?.band_width_mm && (
                    <Metric label={t('m_band_profile')} value={`${result.geometry.volume_model.band_width_mm} / ${result.geometry.volume_model.profile_input_mm ?? '-'} mm`} />
                  )}
                  {result.geometry.volume_model?.cross_section && (
                    <Metric
                      label={t('m_thickness_model')}
                      value={pretty(result.geometry.volume_model.cross_section.candidates.map((item) => `${item.source}:${item.weight}`).join(' '))}
                    />
                  )}
                </div>
              </div>

              {result.vlm_roi && (
                <div className="flex items-center gap-2.5 rounded-2xl border border-emerald-200/70 bg-emerald-50/60 px-3.5 py-3">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <p className="text-xs font-medium text-emerald-800">
                    {t('views_verified', { pct: Math.round(result.vlm_roi.confidence * 100) })}
                  </p>
                </div>
              )}

              {result.visualizations.contour_overlay && result.visualizations.depth_map && (
                <div className="grid grid-cols-2 gap-3">
                  <Visualization title="Contour and scale" src={result.visualizations.contour_overlay} />
                  <Visualization title="Depth map" src={result.visualizations.depth_map} />
                  {result.visualizations.scale_visualization && (
                    <Visualization title="Scale detection" src={result.visualizations.scale_visualization} />
                  )}
                </div>
              )}

              {result.confidence.issues.length > 0 && (
                <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-orange-700">{t('quality_notes')}</p>
                  <p className="mt-1 text-xs leading-relaxed text-orange-800">{result.confidence.issues.join(', ')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-stone-200 px-5 pb-6 pt-4">
        <button onClick={runEstimate} disabled={loading || !topImageDataUrl || !angleImageDataUrl || !sideImageDataUrl} className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 text-white font-semibold transition-colors active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
          {loading ? t('weight_estimating') : t('weight_estimate_btn')}
        </button>
        <button onClick={continueFlow} disabled={!result} className="btn-secondary w-full text-sm disabled:opacity-40">
          {t('weight_continue_estimate')} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
