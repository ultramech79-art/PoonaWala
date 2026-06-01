import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera } from '../components/Camera'
import { useSessionStore, type CertificateData } from '../store/session'
import { certificateOcrAPI, type CertificateOCRResult } from '../lib/api'
import { resizeDataUrl } from '../lib/utils'
import {
  ArrowRight, BadgeCheck, Camera as CameraIcon, ChevronRight,
  FileText, Loader2, RotateCcw, Upload, Volume2, User,
} from 'lucide-react'
import { clsx } from 'clsx'
import { speak } from '../lib/tts'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTranslation } from 'react-i18next'

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
    skipCapture,
    setCertificateData,
    setWeight,
    setScannedKarat,
    setHuid,
    setPageEvidence,
    state,
  } = useSessionStore()

  const [capturedUrl, setCapturedUrl] = useState<string | null>(state.captures.certificate?.dataUrl ?? null)
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [data, setData] = useState<CertificateData | null>(state.certificateData)
  const [cameraKey, setCameraKey] = useState(0)
  const [showTutorial, setShowTutorial] = useState(true)

  // Speak voice guide on mount
  useEffect(() => {
    if (showTutorial) {
      speak(t('voice_certificate'))
    }
  }, [t, showTutorial])

  const scanDocument = useCallback(async (blob: Blob, dataUrl: string, exif?: Record<string, unknown>) => {
    addCapture({ type: 'certificate', blob, dataUrl, timestamp: Date.now(), exif })
    setCapturedUrl(dataUrl)
    setStatus('scanning')
    setError('')

    try {
      const optimized = await resizeDataUrl(dataUrl, 1400, 0.82)
      const result = await certificateOcrAPI(optimized, 60000)
      const extracted = toCertificateData(result)

      const billHuidNorm = normalizeBillHuid(extracted.huid)
      const itemHuidNorm = normalizeBillHuid(state.huidCode)
      console.group('%c[CertificateScan] BILL / CERTIFICATE OCR', 'color:#0a7;font-weight:bold')
      console.log('raw OCR result:', result)
      console.log('extracted → huid:', extracted.huid, '| karat:', extracted.karat, '| weightG:', extracted.weightG, '| confidence:', extracted.confidence)
      console.log('item description:', extracted.itemDescription, '| jeweller:', extracted.jewellerName, '| bill#:', extracted.billNumber, '| date:', extracted.purchaseDate)
      console.log('bill HUID (normalized):', billHuidNorm || '(none)')
      console.log('hallmark/typed HUID captured earlier (normalized):', itemHuidNorm || '(none — capture or type HUID first)')
      if (billHuidNorm && itemHuidNorm) {
        console.log(
          billHuidNorm === itemHuidNorm
            ? '%c✓ HUID MATCH — bill HUID == item HUID → billHuidMatch WILL be true'
            : '%c✗ HUID MISMATCH — bill HUID != item HUID → billHuidMismatch WILL be true (fraud signal)',
          billHuidNorm === itemHuidNorm ? 'color:green;font-weight:bold' : 'color:red;font-weight:bold',
        )
      } else {
        console.log('%c… No HUID cross-check possible (one or both HUIDs missing) → fall back to description/weight/purity', 'color:#888')
      }
      console.groupEnd()

      setData(extracted)
      setPageEvidence('certificate', {
        skipped: false,
        captured: true,
        scanned: true,
        confidence: extracted.confidence,
        authenticityFound: extracted.authenticityFound,
        huid: extracted.huid,
        karat: extracted.karat,
        weightG: extracted.weightG,
        itemDescription: extracted.itemDescription,
        billNumber: extracted.billNumber,
        jewellerName: extracted.jewellerName,
        purchaseDate: extracted.purchaseDate,
        usefulFieldCount: [
          extracted.huid,
          extracted.karat,
          extracted.weightG,
          extracted.itemDescription,
          extracted.billNumber,
          extracted.jewellerName,
          extracted.purchaseDate,
        ].filter(Boolean).length,
      })
      setStatus('done')
    } catch (err) {
      console.error('[CertificateScan] OCR failed:', err)
      setPageEvidence('certificate', {
        skipped: false,
        captured: true,
        scanned: false,
        error: 'ocr_failed',
      })
      setStatus('error')
      setError('Could not read the bill. Please retake the document or skip this step.')
    }
  }, [addCapture, setPageEvidence])

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
      const existingHuid = state.huidCode
      console.group('%c[CertificateScan] APPLYING bill as certificateData', 'color:#0a7;font-weight:bold')
      console.log('certificateData.huid:', sourceData.huid, '| existing item huidCode:', existingHuid)
      console.log('will set item HUID from bill?', Boolean(sourceData.huid && !existingHuid), '(only when no item HUID already captured)')
      console.log('karat:', sourceData.karat, '| weightG:', sourceData.weightG, '| itemDescription:', sourceData.itemDescription)
      console.log('→ Confidence scorer will compute billHuidMatch using certificateData.huid vs (huidCode || huidVerification.huid)')
      console.groupEnd()
      setCertificateData(sourceData)
      if (sourceData.karat) setScannedKarat(sourceData.karat)
      if (sourceData.weightG) setWeight(sourceData.weightG)
      // Do not let the bill overwrite a HUID already captured from the item.
      // The scorer needs both values so it can detect match vs mismatch.
      // When the item had NO HUID of its own, we still copy the bill HUID into
      // huidCode for downstream use — but we tag its source as 'bill' so the
      // confidence scorer does NOT treat it as an independent item HUID and
      // produce a meaningless self-match (bill compared against itself).
      if (sourceData.huid && !existingHuid) {
        setHuid(sourceData.huid)
        setPageEvidence('huid', { code: sourceData.huid, source: 'bill', status: 'BILL_OCR', verified: false })
      }
      setPageEvidence('certificate', {
        skipped: false,
        applied: true,
        confidence: sourceData.confidence,
        authenticityFound: sourceData.authenticityFound,
        huid: sourceData.huid,
        karat: sourceData.karat,
        weightG: sourceData.weightG,
      })
    }
    navigate('/weight')
  }

  function continueWithoutDocument() {
    setCertificateData(null)
    skipCapture('certificate')
    setPageEvidence('certificate', {
      skipped: true,
      captured: false,
      applied: false,
    })
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
    <div className="page app-page-bg overflow-y-auto no-scrollbar animate-slide-up">
      {/* Tutorial overlay */}
      {showTutorial && (
        <TutorialOverlay
          stepType="certificate"
          title={t('tutorial_title_certificate')}
          hint={t('tutorial_hint_certificate')}
          buttonText={t('tutorial_got_it')}
          onDismiss={() => setShowTutorial(false)}
        />
      )}

      <div className="px-5 py-2.5 flex items-center justify-between border-b border-stone-200/50 bg-white/60 backdrop-blur-sm">
        <button onClick={() => navigate('/audio-eval')} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-900 text-white active:scale-95 transition-transform shadow-md">
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-stone-500 uppercase tracking-[0.18em] font-bold px-2.5 py-0.5 rounded-full bg-stone-100/80 border border-stone-200/60">Step 8 / 8</span>
          <span className="text-base font-bold text-stone-950 tracking-tight">Bill & Certificate</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => speak(t('voice_certificate'))} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-800 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
            <Volume2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => state.authToken && state.authToken !== 'guest' ? navigate('/dashboard-home') : navigate('/login')} className="flex items-center justify-center w-9 h-9 rounded-full bg-stone-700 text-white shadow-sm hover:shadow-md transition-all active:scale-95">
            <User className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="px-5 pb-6 pt-4 space-y-4">

        {!capturedUrl && (
          <>
            <div className="scan-panel rounded-3xl overflow-hidden p-2">
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
          <div className="surface-panel rounded-3xl p-3">
            <img src={capturedUrl} alt="Captured bill or certificate" className="w-full rounded-xl border border-stone-200 object-contain max-h-80 bg-stone-50" />
            <button onClick={retake} className="btn-secondary w-full mt-3 text-sm">
              <RotateCcw className="w-4 h-4" />
              Retake
            </button>
          </div>
        )}

        {status === 'scanning' && (
          <div className="surface-panel rounded-3xl p-4 flex items-center gap-3">
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
          <div className="surface-panel rounded-3xl p-4">
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

        {/* Info card — at bottom */}
        <div className="scan-panel rounded-2xl px-4 py-3 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0 mt-0.5">
            <FileText className="w-4 h-4 text-brand-600" strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-stone-900 leading-tight">Bill or authenticity certificate</p>
            <p className="text-xs text-stone-500 leading-relaxed mt-0.5">
              HUID is matched first. Otherwise we use purity, weight, and item description.
            </p>
          </div>
        </div>

        <div className="space-y-3 pt-1">
          <button onClick={useExtracted} disabled={!hasUsefulData} className={clsx('w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-stone-950 text-white font-semibold transition-colors active:scale-[0.98]', !hasUsefulData && 'opacity-40 cursor-not-allowed')}>
            <BadgeCheck className="w-5 h-5" />
            Use Scanned Details
            <ArrowRight className="w-4 h-4" />
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

function normalizeBillHuid(value?: string | null) {
  return (value ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase()
}

function getBillMatchStatus(data: CertificateData | null, scannedHallmarkHuid: string | null) {
  if (!data) {
    return {
      tone: 'neutral' as const,
      label: 'Bill match not checked',
      detail: 'Scan a document to compare HUID first, then item description and weight.',
    }
  }

  const billHuid = normalizeBillHuid(data.huid)
  const itemHuid = normalizeBillHuid(scannedHallmarkHuid)
  if (billHuid && itemHuid) {
    if (billHuid === itemHuid) {
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
