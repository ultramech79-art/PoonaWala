import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera } from '../components/Camera'
import { useSessionStore, type CertificateData } from '../store/session'
import { certificateOcrAPI, type CertificateOCRResult } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'
import {
  ArrowRight, BadgeCheck, Camera as CameraIcon, ChevronRight,
  FileText, Loader2, RotateCcw, ShieldCheck, Upload,
} from 'lucide-react'
import { clsx } from 'clsx'
import { speak } from '../lib/tts'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTranslation } from 'react-i18next'

const BILL_CRUX_HI: Record<string, string> = {
  good:    'बिल मिलान सफल। यह वही आभूषण है।',
  warn:    'सावधान — बिल का HUID मेल नहीं खाता।',
  neutral: 'बिल मिला। विवरण की जांच करें।',
}

function toCertificateData(result: CertificateOCRResult): CertificateData {
  return {
    source: 'ocr',
    authenticityFound: Boolean(result.authenticity_found),
    karat: result.karat,
    weightG: result.weight_g,
    huid: result.huid,
    itemDescription: result.item_description,
    billNumber: result.bill_number,
    jewellerName: result.jeweller_name,
    purchaseDate: result.purchase_date,
    confidence: result.confidence,
    notes: result.notes ?? [],
  }
}

export function CertificateScan() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const {
    addCapture,
    setCertificateData,
    setWeight,
    setScannedKarat,
    setHuid,
    state,
  } = useSessionStore()

  const [capturedUrl, setCapturedUrl] = useState<string | null>(state.captures.certificate?.dataUrl ?? null)
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [data, setData] = useState<CertificateData | null>(state.certificateData)
  const [cameraKey, setCameraKey] = useState(0)
  const [showTutorial, setShowTutorial] = useState(true)
  const lang = localStorage.getItem('goldeye_lang') ?? 'en'

  // Speak intro on mount
  useEffect(() => {
    const timer = setTimeout(() => speak(t('voice_certificate')), 500)
    return () => clearTimeout(timer)
  }, [t])

  const scanDocument = useCallback(async (blob: Blob, dataUrl: string, exif?: Record<string, unknown>) => {
    addCapture({ type: 'certificate', blob, dataUrl, timestamp: Date.now(), exif })
    setCapturedUrl(dataUrl)
    setStatus('scanning')
    setError('')

    try {
      const optimized = await resizeDataUrl(dataUrl, 1400, 0.82)
      const result = await certificateOcrAPI(optimized, 60000)
      const extracted = toCertificateData(result)
      setData(extracted)
      setStatus('done')
      // Speak just the crux in the user's language
      const billResult = getBillMatchStatus(extracted, state.huidCode ?? null)
      const crux = lang === 'hi' ? BILL_CRUX_HI[billResult.tone] : billResult.label
      setTimeout(() => speak(crux), 400)
    } catch (err) {
      console.error('[CertificateScan] OCR failed:', err)
      setStatus('error')
      setError('Could not read the bill. Please retake the document or skip this step.')
    }
  }, [addCapture])

  const handleCapture = useCallback((blob: Blob, dataUrl: string, exif?: Record<string, unknown>) => {
    scanDocument(blob, dataUrl, exif)
  }, [scanDocument])

  const handleUpload = useCallback((file: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      scanDocument(file, dataUrl, { timestamp: Date.now(), source: 'gallery_upload', file_name: file.name })
    }
    reader.onerror = () => {
      setStatus('error')
      setError('Could not load this file. Please choose a clear bill image.')
    }
    reader.readAsDataURL(file)
  }, [scanDocument])

  function applyAndContinue(sourceData: CertificateData | null) {
    if (sourceData) {
      setCertificateData(sourceData)
      if (sourceData.karat) setScannedKarat(sourceData.karat)
      if (sourceData.weightG) setWeight(sourceData.weightG)
      if (sourceData.huid) setHuid(sourceData.huid)
    }
    navigate('/weight')
  }

  function continueWithoutDocument() {
    setCertificateData(null)
    navigate('/weight')
  }

  function useExtracted() {
    applyAndContinue(data)
  }

  function retake() {
    setCapturedUrl(null)
    setData(null)
    setStatus('idle')
    setError('')
    setCameraKey(k => k + 1)
  }

  const hasUsefulData = Boolean(data?.karat || data?.weightG || data?.huid)
  const scannedHallmarkHuid = state.huidCode
  const billMatch = getBillMatchStatus(data, scannedHallmarkHuid)

  return (
    <div className="page overflow-y-auto no-scrollbar animate-slide-up bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30">
      {/* Tutorial overlay */}
      {showTutorial && (
        <TutorialOverlay stepType="certificate" onDismiss={() => setShowTutorial(false)} />
      )}

      <div className="page-header">
        <button onClick={() => navigate('/audio-eval')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">Bill & Certificate</span>
        <button onClick={continueWithoutDocument} className="text-xs font-semibold text-stone-400 px-2">
          Skip
        </button>
      </div>

      <div className="px-5 pb-6 pt-4 space-y-4">
        <div className="card p-4 border-stone-200 bg-white">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gold-50 border border-gold-200 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-gold-700" strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-bold text-base leading-tight text-stone-900">
           
                Bill or authenticity certificate
              </h1>
              <p className="text-xs text-stone-500 leading-relaxed mt-1">
                Scan the bill for the same jewellery. HUID is matched first; otherwise we rely on description, purity, and weight.
              </p>
            </div>
          </div>
        </div>

        {!capturedUrl && (
          <>
            <div className="card overflow-hidden">
              <Camera
                key={cameraKey}
                type="certificate"
                onCapture={handleCapture}
                facingMode="environment"
              />
            </div>
            <label className="btn-secondary w-full text-sm cursor-pointer">
              <Upload className="w-4 h-4" />
              Upload bill from gallery
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => handleUpload(e.target.files?.[0] ?? null)}
              />
            </label>
          </>
        )}

        {capturedUrl && (
          <div className="card p-3">
            <img src={capturedUrl} alt="Captured bill or certificate" className="w-full rounded-xl border border-stone-200 object-contain max-h-80 bg-stone-50" />
            <button onClick={retake} className="btn-secondary w-full mt-3 text-sm">
              <RotateCcw className="w-4 h-4" />
              Retake
            </button>
          </div>
        )}

        {status === 'scanning' && (
          <div className="card p-4 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
            <div>
              <p className="text-sm font-semibold text-stone-800">Reading document</p>
              <p className="text-xs text-stone-400">Extracting purity, net weight, HUID, and authenticity details.</p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
            {error}
          </div>
        )}

        {data && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="font-display font-semibold text-sm text-stone-900">Extracted Details</p>
              <span className={clsx(
                'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                data.authenticityFound ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-500',
              )}>
                {data.authenticityFound ? 'Document found' : 'Review needed'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <InfoCell label="Purity" value={data.karat ? `${data.karat}K` : 'Not found'} />
              <InfoCell label="Net Weight" value={data.weightG ? `${data.weightG}g` : 'Not found'} />
              <InfoCell label="HUID" value={data.huid || 'Not found'} />
              <InfoCell label="Confidence" value={`${Math.round(data.confidence * 100)}%`} />
            </div>
            <div className={clsx(
              'mt-3 rounded-xl border px-3 py-2',
              billMatch.tone === 'good' && 'bg-emerald-50 border-emerald-200',
              billMatch.tone === 'warn' && 'bg-amber-50 border-amber-200',
              billMatch.tone === 'neutral' && 'bg-stone-50 border-stone-200',
            )}>
              <p className={clsx(
                'text-xs font-semibold',
                billMatch.tone === 'good' && 'text-emerald-700',
                billMatch.tone === 'warn' && 'text-amber-700',
                billMatch.tone === 'neutral' && 'text-stone-600',
              )}>
                {billMatch.label}
              </p>
              <p className="text-[10px] text-stone-500 leading-relaxed mt-0.5">{billMatch.detail}</p>
            </div>
            {(data.itemDescription || data.jewellerName || data.billNumber || data.purchaseDate) && (
              <div className="mt-3 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2 space-y-1">
                {data.itemDescription && <MetaLine label="Item" value={data.itemDescription} />}
                {data.jewellerName && <MetaLine label="Jeweller" value={data.jewellerName} />}
                {data.billNumber && <MetaLine label="Bill No." value={data.billNumber} />}
                {data.purchaseDate && <MetaLine label="Date" value={data.purchaseDate} />}
              </div>
            )}
            {data.notes.length > 0 && (
              <p className="text-[10px] text-stone-400 mt-3">{data.notes.slice(0, 2).join(' · ')}</p>
            )}
          </div>
        )}

        <div className="rounded-xl bg-stone-50 border border-stone-200 px-4 py-3 flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-stone-400 flex-shrink-0 mt-0.5" />
          <p className="text-[10px] text-stone-500 leading-relaxed">
            A matching bill for this same jewellery is treated as ground-truth evidence for printed purity and net weight before physical verification.
          </p>
        </div>

        <div className="sticky bottom-0 w-full px-5 pb-6 pt-4 bg-white/90 backdrop-blur-sm border-t border-stone-200 space-y-3">
          <button onClick={useExtracted} disabled={!hasUsefulData} className={clsx('btn-primary w-full', !hasUsefulData && 'opacity-50 cursor-not-allowed')}>
            <BadgeCheck className="w-5 h-5" />
            Use Scanned Details
            <ArrowRight className="w-5 h-5" />
          </button>
          <button onClick={continueWithoutDocument} className="btn-secondary w-full text-sm">
            <CameraIcon className="w-4 h-4" />
            Continue without document
          </button>
        </div>
      </div>
    </div>
  )
}

function getBillMatchStatus(data: CertificateData | null, scannedHallmarkHuid: string | null) {
  if (!data) {
    return {
      tone: 'neutral' as const,
      label: 'Bill match not checked',
      detail: 'Scan a document to compare HUID first, then item description and weight.',
    }
  }

  if (data.huid && scannedHallmarkHuid) {
    if (data.huid === scannedHallmarkHuid) {
      return {
        tone: 'good' as const,
        label: 'Same jewellery evidence',
        detail: 'Bill HUID matches the hallmark captured earlier.',
      }
    }
    return {
      tone: 'warn' as const,
      label: 'HUID mismatch',
      detail: 'Bill HUID does not match the scanned hallmark. Retake or skip this document.',
    }
  }

  const fallback = [
    data.itemDescription ? `description: ${data.itemDescription}` : null,
    data.weightG ? `weight: ${data.weightG}g` : null,
    data.karat ? `purity: ${data.karat}K` : null,
  ].filter(Boolean).join(' · ')

  if (fallback) {
    return {
      tone: 'neutral' as const,
      label: 'Match by bill details',
      detail: `No HUID match available. Review ${fallback} against the jewellery before using this document.`,
    }
  }

  return {
    tone: 'warn' as const,
    label: 'Weak bill match',
    detail: 'OCR did not find HUID, description, weight, or purity clearly enough.',
  }
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-stone-50 border border-stone-200 px-3 py-2">
      <p className="text-[10px] text-stone-400 mb-0.5">{label}</p>
      <p className="text-sm font-bold text-stone-800 truncate">{value}</p>
    </div>
  )
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-stone-400">{label}</span>
      <span className="font-medium text-stone-700 text-right truncate">{value}</span>
    </div>
  )
}
