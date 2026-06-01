import type { AssessmentResult } from '../store/session'

export const apiBase = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
const BASE = apiBase

async function post<T>(path: string, body: unknown, timeoutMs = 25000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const jsonBody = JSON.stringify(body)

    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${path} timed out. Weight estimation needs three image validations; retry with smaller images or wait for the server to finish.`)
      }
      throw error
    }
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

async function authPost<T>(path: string, body: unknown, token?: string | null, timeoutMs = 25000): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      let message = text
      try {
        const parsed = JSON.parse(text)
        message = parsed.detail || parsed.message || text
      } catch { /* not JSON */ }
      throw new Error(`${path} -> ${res.status}: ${String(message).slice(0, 500)}`)
    }
    return res.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

async function authGet<T>(path: string, token: string): Promise<T> {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const res = await fetch(`${BASE}${path}`, { headers })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 500)}`)
  return res.json() as Promise<T>
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

export interface AssistantAction {
  label: string
  route: string
}

export interface AssistantLink {
  label: string
  url: string
}

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantChatResponse {
  reply: string
  suggestions: string[]
  actions: AssistantAction[]
  links: AssistantLink[]
}

export function assistantChatAPI(
  message: string,
  page?: string,
  history: AssistantMessage[] = [],
  pageContext?: Record<string, unknown>,
): Promise<AssistantChatResponse> {
  return post('/api/assistant-chat', { message, page, history, page_context: pageContext }, 25000)
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

export interface GradcamMapsRequest {
  session_id: string
  frames: Partial<Record<'45deg' | 'top' | 'side' | 'macro', string>>
}

export interface GradcamMapsResponse {
  gradcam_urls: Partial<Record<'45deg' | 'top' | 'side' | 'macro', string>>
}

export function generateGradcamMapsAPI(req: GradcamMapsRequest): Promise<GradcamMapsResponse> {
  return post('/api/xai/gradcam', req, 30000)
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
  language?: string
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

    // Match backend's own timeout so we don't kill the socket prematurely
    // (the old 30s timeout was firing before the server finished, causing
    // 1005 errors and then a duplicate HTTP POST retry)
    const timer = setTimeout(() => {
      if (!settled) { settled = true; ws.close(); reject(new Error('ws_timeout')) }
    }, 48000)

    ws.onopen = () => {
      ws.send(JSON.stringify({
        frame_type: frameType,
        image_data_url: imageDataUrl,
        session_id: options.sessionId ?? undefined,
        reference_frame_type: options.referenceFrameType ?? 'top',
        reference_image_data_url: options.referenceImageDataUrl ?? undefined,
        reference_image_url: options.referenceImageUrl ?? undefined,
        language: options.language ?? 'en',
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
    language: options.language ?? 'en',
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

// Debug beacon: posts the fully-computed confidence breakdown to the server log
// so it can be inspected when testing on a phone (no browser console needed).
// Fire-and-forget; never throws. Disable with localStorage goldeye_debug_confidence='0'.
export function confidenceTraceAPI(trace: unknown): void {
  try {
    if (localStorage.getItem('goldeye_debug_confidence') === '0') return
  } catch { /* ignore */ }
  try {
    void post('/api/debug/confidence-trace', trace, 8000).catch(() => {})
  } catch { /* ignore */ }
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
  const res = await fetch(`${verifierBase}/verify-huid/${encodeURIComponent(huid)}`, {
    headers: { 'ngrok-skip-browser-warning': 'true' },
  })
  if (!res.ok) throw new Error(`HUID verifier ${res.status}: ${await res.text().catch(() => res.statusText)}`)
  return res.json() as Promise<HuidVerificationResult>
}

export type JewelryType = 'auto' | 'ring' | 'bangle' | 'bracelet' | 'necklace' | 'pendant' | 'chain' | 'irregular'
export type GoldKarat = 24 | 22 | 18

export interface WeightVlmRoi {
  valid_image: boolean
  jewellery_present: boolean
  coin_present: boolean
  item_type: string
  jewellery_point: { x: number; y: number }
  confidence: number
  issues: string[]
  provider: string
  model: string
}

export interface WeightEstimateResult {
  ok: boolean
  jewelry_type: string
  requested_jewelry_type: JewelryType
  karat: GoldKarat
  reference_object: 'rs10_coin'
  scale: {
    mm_per_pixel: number
    pixels_per_mm: number
    coin_diameter_px: number
    coin_confidence: number
  }
  dimensions: {
    width_mm: number
    height_mm: number
    projected_area_mm2: number
    hole_area_mm2: number
    estimated_depth_mm: number
    thickness_source?: string
  }
  geometry: {
    hole_ratio: number
    aspect_ratio: number
    circularity: number
    multiple_item_risk: number
    segmentation_method: string
    depth_method: string
    contour_count: number
    volume_model?: {
      model: string
      major_radius_mm?: number
      minor_radius_mm?: number
      effective_thickness_mm: number
      band_width_mm?: number
      profile_input_mm?: number | null
      profile_source?: string | null
      cross_section?: {
        candidates: Array<{ source: string; minor_radius_mm: number; weight: number }>
        selected_minor_radius_mm: number
      }
      solidness: number
    }
    profile_measurement?: {
      thickness_mm: number
      width_mm: number
      confidence: number
      method: string
      view: string
      scale_source: string
      side_thickness_mm: number
      angle_45_thickness_mm: number
    }
  }
  physics: {
    density_g_cm3: number
    volume_cm3: number
    formula: string
  }
  weight: {
    estimated_g: number
    low_g: number
    high_g: number
    method?: string
  }
  confidence: {
    score: number
    components: Record<string, number>
    issues: string[]
  }
  visualizations: {
    segmentation_mask?: string
    depth_map?: string
    contour_overlay?: string
    scale_visualization?: string
  }
  vlm_roi?: WeightVlmRoi | null
  angle_vlm_roi?: WeightVlmRoi | null
  side_vlm_roi?: WeightVlmRoi | null
}

export function estimateWeightAPI(
  imageDataUrl: string,
  image45DataUrl: string,
  sideImageDataUrl: string,
  jewelryType: JewelryType,
  karat: GoldKarat,
  jewelryPoint?: { x: number; y: number } | null,
  timeoutMs = 180000,
): Promise<WeightEstimateResult> {
  return post('/api/weight-estimate', {
    image_data_url: imageDataUrl,
    image_45_data_url: image45DataUrl,
    side_image_data_url: sideImageDataUrl,
    jewelry_type: jewelryType,
    karat,
    reference_object: 'rs10_coin',
    include_visualizations: false,
    include_mask_preview: false,
    jewelry_point: jewelryPoint ?? null,
    use_vlm_roi: true,
  }, timeoutMs)
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

export interface IndiaRegion {
  code: string
  name: string
  type: 'state' | 'union_territory'
}

export interface UserProfile {
  id: string
  phone: string | null
  full_name: string
  dob: string
  language: string
  region_code: string
  address: string | null
  city: string | null
  pincode: string | null
  profile_photo_url: string | null
  is_phone_verified: boolean
}

export interface AuthResponse {
  access_token: string
  token_type: 'bearer'
  user: UserProfile
}

export interface RegisterPayload {
  full_name: string
  dob: string
  region_code: string
  language: string
  phone?: string
  password?: string
  address?: string
  city?: string
  pincode?: string
  otp_session_id?: string
  otp?: string
  google_id_token?: string
  profile_photo_url?: string
  profile_photo_public_id?: string
}

export function getIndiaRegionsAPI(): Promise<{ regions: IndiaRegion[] }> {
  return authGet('/api/regions/india', '')
}

export function checkPhoneAPI(phone: string): Promise<{ registered: boolean; has_pin: boolean }> {
  return post('/api/auth/check-phone', { phone })
}

export function registerAPI(payload: RegisterPayload): Promise<AuthResponse> {
  return authPost('/api/auth/register', payload)
}

export function passwordLoginAPI(phone: string, password: string): Promise<AuthResponse> {
  return authPost('/api/auth/login/password', { phone, password })
}

export function otpLoginAPI(phone: string, otpSessionId: string, otp: string): Promise<AuthResponse> {
  return authPost('/api/auth/login/otp', { phone, otp_session_id: otpSessionId, otp })
}

export function googleLoginAPI(idToken: string): Promise<AuthResponse> {
  return authPost('/api/auth/login/google', { id_token: idToken })
}

export interface UserAsset {
  id: number
  session_id: string | null
  asset_kind: string
  frame_type: string | null
  public_url: string | null
  cloudinary_public_id: string | null
  width_px: number | null
  height_px: number | null
  size_bytes: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export async function uploadUserAssetAPI(
  token: string,
  file: File | Blob,
  assetKind: string,
  sessionId?: string | null,
  frameType?: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<UserAsset> {
  const form = new FormData()
  form.append('file', file)
  form.append('asset_kind', assetKind)
  if (sessionId) form.append('session_id', sessionId)
  if (frameType) form.append('frame_type', frameType)
  if (metadata) form.append('metadata_json', JSON.stringify(metadata))
  const res = await fetch(`${BASE}/api/assets/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) throw new Error(`/api/assets/upload -> ${res.status}: ${(await res.text()).slice(0, 500)}`)
  return res.json() as Promise<UserAsset>
}

export async function assetImageDataUrlAPI(token: string, assetId: number): Promise<string> {
  const res = await fetch(`${BASE}/api/me/assets/${assetId}/image`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`/api/me/assets/${assetId}/image -> ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const blob = await res.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function listMyAssetsAPI(token: string, sessionId?: string): Promise<UserAsset[]> {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
  return authGet(`/api/me/assets${query}`, token)
}

export function createUserSessionAPI(token: string, sessionId: string, regionCode?: string, currentStep?: string): Promise<unknown> {
  return authPost('/api/me/sessions', { session_id: sessionId, region_code: regionCode, current_step: currentStep }, token)
}

export function saveLoanPredictionAPI(token: string, payload: {
  session_id: string
  status?: string
  region_code: string
  estimated_weight_g?: number
  estimated_gold_value_inr?: number
  eligible_loan_inr?: number
  ltv_pct?: number
  result: Record<string, unknown>
}): Promise<unknown> {
  return authPost('/api/me/loan-predictions', payload, token)
}

export function listLoanPredictionsAPI(token: string): Promise<Array<{
  id: number
  session_id: string
  status: string
  region_code: string
  estimated_weight_g: number | null
  estimated_gold_value_inr: number | null
  eligible_loan_inr: number | null
  ltv_pct: number | null
  result: Record<string, unknown>
  created_at: string
}>> {
  return authGet('/api/me/loan-predictions', token)
}

export async function deleteUserAssetAPI(token: string, assetId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/me/assets/${assetId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`/api/me/assets/${assetId} → ${res.status}: ${(await res.text()).slice(0, 500)}`)
  }
}

/**
 * Convert a remote image URL to a data URL by fetching and reading as base64.
 * Useful for reusing Cloudinary-stored images in APIs that expect data URLs.
 */
export async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
