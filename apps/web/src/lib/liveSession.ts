import { apiBase } from './api'

export interface AnalyzeResult {
  approved: boolean
  quality_score: number
  jewellery_visible: boolean
  angle_ok: boolean
  hallmark_visible: boolean
  face_visible: boolean
  observed_item: string
  guidance: string
  next_angle: string | null
  purity_hint: string | null
  purity_confidence: number
  next_instruction: string | null
}

export interface TapTestResult {
  score: number
  label: string
  valid?: boolean
  reject_reason?: string | null
  decay_ms: number
  dominant_freq_hz: number
  spectral_centroid_hz?: number
  q_factor?: number
  gold_band_ratio?: number
  decay_r2?: number
  snr_db?: number
  attack_ms?: number
  event_count?: number
  test_mode?: string
  reasoning: string
}

export async function analyzeFrame(
  frameB64: string,
  currentAngle: string,
  capturedAngles: string[],
  language: 'en' | 'hi',
): Promise<AnalyzeResult> {
  const res = await fetch(`${apiBase}/api/live-session/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frame_b64: frameB64,
      current_angle: currentAngle,
      captured_angles: capturedAngles,
      language,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail ?? 'Analysis failed')
  }
  return res.json()
}

export async function sendTapTest(
  samplesB64: string,
  sampleRate: number,
  language: 'en' | 'hi',
  ornamentType = 'unknown',
  testMode = 'tap',
): Promise<TapTestResult> {
  const res = await fetch(`${apiBase}/api/audio-eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      samples_b64: samplesB64,
      sample_rate: sampleRate,
      language,
      ornament_type: ornamentType,
      test_mode: testMode,
    }),
  })
  if (!res.ok) throw new Error('Tap test failed')
  return res.json()
}

export interface AuthCheckResult {
  video_score: number
  audio_score: number
  combined_score: number
  verdict: string
  video_signals: string[]
  audio_signals: string[]
  purity_estimate: string | null
  guidance: string
}

export async function authCheck(
  framesB64: string[],
  language: 'en' | 'hi',
  audioSamplesB64?: string,
  sampleRate?: number,
): Promise<AuthCheckResult> {
  const res = await fetch(`${apiBase}/api/live-session/auth-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frames_b64: framesB64,
      language,
      audio_samples_b64: audioSamplesB64 ?? null,
      sample_rate: sampleRate ?? 44100,
    }),
  })
  if (!res.ok) throw new Error('Auth check failed')
  return res.json()
}
