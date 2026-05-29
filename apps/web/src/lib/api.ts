import type { AssessmentResult } from '../store/session'

export const apiBase = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
const BASE = apiBase

async function post<T>(path: string, body: unknown, timeoutMs = 25000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const jsonBody = JSON.stringify(body)

    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody,
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      if (res.status === 422 && path === '/api/assess') {
        console.error('[422 Error] Assessment request failed validation')
        console.error('[422 Debug] Request body size:', jsonBody.length, 'bytes')
        console.error('[422 Debug] Frames count:', (body as any)?.frames?.length)
        console.error('[422 Debug] Response:', text)
        try {
          const parsed = JSON.parse(text)
          console.error('[422 Validation Details]:', parsed)
        } catch { /* not JSON */ }
      }
      throw new Error(`${path} → ${res.status}: ${text.substring(0, 500)}`)
    }
    return res.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

export interface SessionInitResponse {
  session_id: string
  created_at: string
  upload_url_prefix: string
}

export function initSessionAPI(lang: string, phone?: string): Promise<SessionInitResponse> {
  return post('/session/init', { lang, phone })
}

export function recordConsentAPI(sessionId: string): Promise<unknown> {
  return post('/session/consent', { session_id: sessionId, version: 'v1.0' })
}

export interface AssessRequest {
  session_id: string
  frames: string[]
  video?: string
  audio?: string
  selfie?: string
  weight_g?: number
  reference_object?: string
  lang?: string
  device_metadata?: Record<string, unknown>
}

export function assessAPI(req: AssessRequest): Promise<AssessmentResult> {
  const payload = {
    reference_object: 'rs10_coin',
    ...req,
  }

  // Validate request before sending
  if (!payload.session_id || payload.session_id.trim() === '') {
    throw new Error('session_id is required')
  }
  if (!payload.frames || !Array.isArray(payload.frames) || payload.frames.length === 0) {
    throw new Error('frames array must contain at least one frame')
  }

  console.log('[assessAPI] Sending request with', {
    session_id: payload.session_id,
    frames_count: payload.frames.length,
    has_video: !!payload.video,
    has_audio: !!payload.audio,
    has_selfie: !!payload.selfie,
    weight_g: payload.weight_g,
    reference_object: payload.reference_object,
    lang: payload.lang,
  })

  return post('/api/assess', payload)
}

export interface FrameEvalResult {
  approved: boolean
  quality_score: number
  feedback: string
  issues: string[]
  detected: Record<string, unknown>
  same_item?: {
    same_item: boolean | null
    verdict: 'same' | 'different' | 'inconclusive'
    same_item_score: number
    confidence: number
    method: string
    matching_signals: string[]
    mismatch_reasons: string[]
  } | null
  asset?: Record<string, unknown> | null
}

export interface EvaluateFrameOptions {
  sessionId?: string | null
  referenceFrameType?: string
  referenceImageDataUrl?: string | null
  referenceImageUrl?: string | null
}

// WebSocket-based evaluation (primary — avoids HTTP proxy timeouts)
function evaluateFrameWS(frameType: string, imageDataUrl: string, options: EvaluateFrameOptions = {}): Promise<FrameEvalResult> {
  return new Promise((resolve, reject) => {
    const originUrl = BASE ? BASE : window.location.origin
    const wsUrl = new URL(originUrl)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl.pathname = '/api/ws/evaluate-frame'

    let settled = false
    const ws = new WebSocket(wsUrl.toString())

    const timer = setTimeout(() => {
      if (!settled) { settled = true; ws.close(); reject(new Error('ws_timeout')) }
    }, 30000) // Increased to 30s as requested

    ws.onopen = () => {
      ws.send(JSON.stringify({
        frame_type: frameType,
        image_data_url: imageDataUrl,
        session_id: options.sessionId ?? undefined,
        reference_frame_type: options.referenceFrameType ?? 'top',
        reference_image_data_url: options.referenceImageDataUrl ?? undefined,
        reference_image_url: options.referenceImageUrl ?? undefined,
      }))
    }

    ws.onmessage = (event) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(event.data) as FrameEvalResult)
      } catch { reject(new Error('ws_parse')) }
      ws.close()
    }

    ws.onerror = () => {
      clearTimeout(timer)
      if (!settled) { settled = true; reject(new Error('ws_error')) }
    }

    ws.onclose = () => {
      clearTimeout(timer)
      if (!settled) { settled = true; reject(new Error('ws_closed')) }
    }
  })
}

// HTTP POST fallback (works everywhere, slightly slower)
function evaluateFrameHTTP(frameType: string, imageDataUrl: string, timeoutMs = 45000, options: EvaluateFrameOptions = {}): Promise<FrameEvalResult> {
  return post('/api/evaluate-frame', {
    frame_type: frameType,
    image_data_url: imageDataUrl,
    session_id: options.sessionId ?? undefined,
    reference_frame_type: options.referenceFrameType ?? 'top',
    reference_image_data_url: options.referenceImageDataUrl ?? undefined,
    reference_image_url: options.referenceImageUrl ?? undefined,
  }, timeoutMs)
}

// Primary export: tries WS, falls back to HTTP
export async function evaluateFrameAPI(frameType: string, imageDataUrl: string, timeoutMs = 45000, options: EvaluateFrameOptions = {}): Promise<FrameEvalResult> {
  try {
    return await evaluateFrameWS(frameType, imageDataUrl, options)
  } catch {
    console.warn('[evaluateFrame] WebSocket failed, falling back to HTTP POST')
    return evaluateFrameHTTP(frameType, imageDataUrl, timeoutMs, options)
  }
}

export interface CertificateOCRResult {
  authenticity_found: boolean
  karat: number | null
  weight_g: number | null
  huid: string | null
  item_description: string | null
  bill_number: string | null
  jeweller_name: string | null
  purchase_date: string | null
  confidence: number
  notes: string[]
}

export function certificateOcrAPI(imageDataUrl: string, timeoutMs = 45000): Promise<CertificateOCRResult> {
  return post('/api/certificate-ocr', { image_data_url: imageDataUrl }, timeoutMs)
}

// ─── HUID Verifier (local Mac via ngrok) ─────────────────
export type HuidStatus = 'VERIFIED' | 'NOT_VERIFIED' | 'NEEDS_MANUAL_REVIEW' | 'INVALID_FORMAT' | 'AGENT_ERROR'

export interface HuidVerificationResult {
  huid: string
  status: HuidStatus
  confidence: number
  purity: string | null
  article_type: string | null
  jeweller_name: string | null
  hallmark_date: string | null
  error: string | null
}

export async function verifyHuidAPI(huid: string): Promise<HuidVerificationResult> {
  const verifierBase = (import.meta.env.VITE_HUID_VERIFIER_URL as string | undefined)?.replace(/\/$/, '') ?? ''
  if (!verifierBase) throw new Error('HUID verifier URL not configured (VITE_HUID_VERIFIER_URL)')
  const res = await fetch(`${verifierBase}/verify-huid/${encodeURIComponent(huid)}`)
  if (!res.ok) throw new Error(`HUID verifier ${res.status}: ${await res.text().catch(() => res.statusText)}`)
  return res.json() as Promise<HuidVerificationResult>
}

// ─── 2Factor.in OTP API ──────────────────────────────────
export interface OtpSendResponse {
  success: boolean
  message: string
  session_id?: string
  error?: string
}

export interface OtpVerifyResponse {
  success: boolean
  valid: boolean
  message: string
  error?: string
}

async function otpPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

export function sendOtpAPI(phone: string): Promise<OtpSendResponse> {
  return otpPost('/otp/send-otp', { phone })
}

export function verifyOtpAPI(sessionId: string, otp: string): Promise<OtpVerifyResponse> {
  return otpPost('/otp/verify-otp', { session_id: sessionId, otp })
}
