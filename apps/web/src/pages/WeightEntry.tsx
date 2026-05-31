import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
} from 'lucide-react'
import { estimateWeightAPI, urlToDataUrl, type GoldKarat, type JewelryType, type WeightEstimateResult } from '../lib/api'
import { useSessionStore } from '../store/session'

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</p>
      <p className="mt-0.5 text-sm font-bold text-stone-900">{value}</p>
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
  const { setWeight, setPageEvidence, state } = useSessionStore()
  const [topImageDataUrl, setTopImageDataUrl] = useState<string | null>(null)
  const [angleImageDataUrl, setAngleImageDataUrl] = useState<string | null>(null)
  const [sideImageDataUrl, setSideImageDataUrl] = useState<string | null>(null)
  const [fileNames, setFileNames] = useState({ top: '', angle: '', side: '' })
  const [jewelryType, setJewelryType] = useState<JewelryType>('auto')
  const [karat, setKarat] = useState<GoldKarat>((state.scannedKarat as GoldKarat) || 22)
  const [dragActive, setDragActive] = useState<'top' | 'angle' | 'side' | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<WeightEstimateResult | null>(null)
  const [jewelryPoint, setJewelryPoint] = useState<{ x: number; y: number } | null>(null)

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

  const confidencePct = useMemo(() => Math.round((result?.confidence.score ?? 0) * 100), [result])

  async function loadFile(slot: 'top' | 'angle' | 'side', file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Upload a JPG, PNG, or HEIC image.')
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
      setError('Upload all three required photos: top view, 45-degree view, and side view. Keep the Rs 10 coin visible in each.')
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

  function continueFlow() {
    setWeight(result?.weight.estimated_g ?? null)
    setPageEvidence('weight', {
      skipped: !result,
      source: result ? 'estimate' : 'none',
      estimatedG: result?.weight.estimated_g ?? null,
      confidence: result?.confidence.score ?? null,
      method: result?.weight.method ?? null,
    })
    navigate('/processing')
  }

  function skipWeightEstimate() {
    setWeight(null)
    setPageEvidence('weight', {
      skipped: true,
      source: 'skipped',
      estimatedG: null,
      confidence: null,
    })
    navigate('/processing')
  }

  function UploadSlot({
    slot,
    title,
    hint,
    src,
    fileName,
  }: {
    slot: 'top' | 'angle' | 'side'
    title: string
    hint: string
    src: string | null
    fileName: string
  }) {
    const isTop = slot === 'top'
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-stone-200 bg-white px-4 py-5 text-center"
      >
        {src ? (
          <div
            className="relative max-h-52 w-full"
            onClick={(event) => {
              if (!isTop) return
              const rect = event.currentTarget.getBoundingClientRect()
              setJewelryPoint({
                x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
              })
              setResult(null)
            }}
          >
            <img src={src} alt={`${title} preview`} className="max-h-52 w-full rounded-xl object-contain" />
            {isTop && jewelryPoint && (
              <div
                className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-600 shadow-lg ring-2 ring-brand-600/30"
                style={{ left: `${jewelryPoint.x * 100}%`, top: `${jewelryPoint.y * 100}%` }}
              />
            )}
          </div>
        ) : (
          <>
            <ImageUp className="mb-3 h-8 w-8 text-stone-300" />
            <p className="text-sm font-bold text-stone-400">Not Captured</p>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-stone-400">This view was skipped during capture.</p>
          </>
        )}
        {fileName && src && (
          <div className="mt-3 flex max-w-full items-center gap-2 text-xs text-stone-500">
            <FileImage className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{fileName}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page animate-slide-up">
      <div className="page-header">
        <button id="weight-back" onClick={() => navigate('/certificate-scan')} className="btn-icon">
          <ChevronRight className="h-5 w-5 rotate-180 text-stone-500" />
        </button>
        <span className="text-sm font-semibold text-stone-700">AI Weight Estimate</span>
        <div className="w-11" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="py-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-gold-200 bg-gold-50">
              <Scale className="h-6 w-6 text-gold-700" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-stone-950">Optional weight estimate</h1>
              <p className="text-xs leading-relaxed text-stone-500">Use top, 45-degree, and side photos for a better estimate, or skip and continue with visual/certificate evidence.</p>
            </div>
          </div>

          {/* Auto-populated notice */}
          {(fileNames.top === 'capture_top.jpg' || fileNames.angle === 'capture_45deg.jpg' || fileNames.side === 'capture_side.jpg') && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Images pre-filled from your capture session. You can replace any by tapping.
            </div>
          )}

          <div className="space-y-3">
            <UploadSlot
              slot="top"
              title="Top view"
              hint="Flat overhead photo for diameter and outline. Coin must be fully visible."
              src={topImageDataUrl}
              fileName={fileNames.top}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <UploadSlot
                slot="angle"
                title="45-degree view"
                hint="Tilted photo to validate profile and reflective edges."
                src={angleImageDataUrl}
                fileName={fileNames.angle}
              />
              <UploadSlot
                slot="side"
                title="Side view"
                hint="Profile photo for actual thickness. Coin must stay in frame."
                src={sideImageDataUrl}
                fileName={fileNames.side}
              />
            </div>
          </div>

          {topImageDataUrl && (
            <p className="mt-2 text-xs font-medium text-stone-500">
              Optional: tap the jewellery in the top view if the automatic selector misses it. Avoid tapping the coin.
            </p>
          )}

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div>
              <label className="label mb-2 block">Jewellery type</label>
              <select className="input-field py-3 text-sm" value={jewelryType} onChange={(event) => setJewelryType(event.target.value as JewelryType)}>
                {JEWELRY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label mb-2 block">Gold karat</label>
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
                <p className="text-sm font-bold text-stone-900">Reference object</p>
                <p className="mt-1 text-xs leading-relaxed text-stone-500">
                  Rs 10 Indian coin, detected by Hough Circle Transform, diameter fixed at 27 mm.
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
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-gold-200 bg-gold-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gold-700">Estimated weight</p>
                    <p className="mt-1 font-display text-3xl font-black text-stone-950">{result.weight.estimated_g}g</p>
                    <p className="text-xs text-stone-600">Range {result.weight.low_g}g to {result.weight.high_g}g</p>
                  </div>
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-bold text-stone-700">
                    {confidencePct}% confidence
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Metric label="Detected type" value={result.jewelry_type} />
                <Metric label="Volume" value={`${result.physics.volume_cm3} cm3`} />
                <Metric label="Width" value={`${result.dimensions.width_mm} mm`} />
                <Metric label="Height" value={`${result.dimensions.height_mm} mm`} />
                <Metric label="Thickness" value={`${result.dimensions.estimated_depth_mm} mm`} />
                <Metric label="Density" value={`${result.physics.density_g_cm3} g/cm3`} />
                <Metric label="Mask method" value={result.geometry.segmentation_method} />
                {result.geometry.profile_measurement && (
                  <Metric label="Depth source" value={result.geometry.profile_measurement.method} />
                )}
                {result.geometry.profile_measurement && (
                  <Metric label="Side/45 thickness" value={`${result.geometry.profile_measurement.side_thickness_mm} / ${result.geometry.profile_measurement.angle_45_thickness_mm} mm`} />
                )}
                {result.geometry.volume_model?.minor_radius_mm && (
                  <Metric label="Torus radii" value={`${result.geometry.volume_model.major_radius_mm} / ${result.geometry.volume_model.minor_radius_mm} mm`} />
                )}
                {result.geometry.volume_model?.band_width_mm && (
                  <Metric label="Band/profile" value={`${result.geometry.volume_model.band_width_mm} / ${result.geometry.volume_model.profile_input_mm ?? '-'} mm`} />
                )}
                {result.geometry.volume_model?.cross_section && (
                  <Metric
                    label="Thickness model"
                    value={result.geometry.volume_model.cross_section.candidates.map((item) => `${item.source}:${item.weight}`).join(' ')}
                  />
                )}
              </div>

              {result.vlm_roi && (
                <div className="rounded-2xl border border-stone-200 bg-white p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-stone-400">VLM validation</p>
                  <p className="mt-1 text-xs text-stone-600">
                    Top, 45-degree, and side views validated by {result.vlm_roi.provider}. Top ROI confidence {Math.round(result.vlm_roi.confidence * 100)}%.
                  </p>
                </div>
              )}

              {result.visualizations.segmentation_mask && !result.visualizations.contour_overlay && (
                <Visualization title="Jewellery mask" src={result.visualizations.segmentation_mask} />
              )}

              {result.visualizations.contour_overlay && result.visualizations.segmentation_mask && result.visualizations.depth_map && (
                <div className="grid grid-cols-2 gap-3">
                  <Visualization title="Contour and scale" src={result.visualizations.contour_overlay} />
                  <Visualization title="Segmentation mask" src={result.visualizations.segmentation_mask} />
                  <Visualization title="Depth map" src={result.visualizations.depth_map} />
                  {result.visualizations.scale_visualization && (
                    <Visualization title="Scale detection" src={result.visualizations.scale_visualization} />
                  )}
                </div>
              )}

              {result.confidence.issues.length > 0 && (
                <div className="rounded-2xl border border-orange-200 bg-orange-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-orange-700">Quality notes</p>
                  <p className="mt-1 text-xs leading-relaxed text-orange-800">{result.confidence.issues.join(', ')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-stone-200 px-5 pb-6 pt-4">
        <button onClick={runEstimate} disabled={loading || !topImageDataUrl || !angleImageDataUrl || !sideImageDataUrl} className="btn-primary w-full disabled:opacity-50">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
          {loading ? 'Estimating weight' : 'Estimate weight'}
        </button>
        <button onClick={continueFlow} disabled={!result} className="btn-secondary w-full text-sm disabled:opacity-50">
          Continue with estimate
          <ArrowRight className="h-5 w-5" />
        </button>
        <button onClick={skipWeightEstimate} disabled={loading} className="btn-secondary w-full text-sm disabled:opacity-50">
          Skip weight estimate
          <ArrowRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
