import { useEffect, useState } from 'react'
import { apiBase } from './api'

export type AudioDemoOutcome = 'off' | 'pass' | 'fail' | 'retry'

export interface AudioDemoOverrideState {
  outcome: AudioDemoOutcome
  updatedAt: number
}

type AudioDemoMode = 'drop' | 'tap'
export type RemoteAudioDemoOutcome = 'pass' | 'fail'

const STORAGE_KEY = 'goldeye_audio_demo_override_v1'
const EVENT_NAME = 'goldeye:audio-demo-override'

export const REMOTE_AUDIO_DEMO_CHANNEL = 'GOLDEYE_AUDIO_DEMO'

const DEFAULT_STATE: AudioDemoOverrideState = {
  outcome: 'off',
  updatedAt: 0,
}

const SCORE_POOLS: Record<Exclude<AudioDemoOutcome, 'off'>, number[]> = {
  pass: [82, 87, 91, 94],
  fail: [31, 38, 44, 52],
  retry: [58, 63, 67, 69],
}

const CONFIDENCE_POOLS: Record<Exclude<AudioDemoOutcome, 'off'>, Array<'low' | 'medium' | 'high'>> = {
  pass: ['high', 'high', 'medium', 'high'],
  fail: ['medium', 'high', 'medium', 'low'],
  retry: ['low', 'medium', 'low', 'medium'],
}

function isOutcome(value: unknown): value is AudioDemoOutcome {
  return value === 'off' || value === 'pass' || value === 'fail' || value === 'retry'
}

function poolPick<T>(values: T[], updatedAt: number, salt = 0): T {
  return values[Math.abs(Math.floor(updatedAt / 97) + salt) % values.length]
}

export function readAudioDemoOverride(): AudioDemoOverrideState {
  if (!import.meta.env.DEV || typeof localStorage === 'undefined') return DEFAULT_STATE

  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!parsed || !isOutcome(parsed.outcome)) return DEFAULT_STATE
    return {
      outcome: parsed.outcome,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function writeAudioDemoOverride(outcome: AudioDemoOutcome): AudioDemoOverrideState {
  const next = {
    outcome,
    updatedAt: Date.now(),
  } satisfies AudioDemoOverrideState

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AudioDemoOverrideState>(EVENT_NAME, { detail: next }))
  }

  return next
}

export function useAudioDemoOverride() {
  const [override, setOverride] = useState<AudioDemoOverrideState>(() => readAudioDemoOverride())

  useEffect(() => {
    const onOverride = (event: Event) => {
      const detail = (event as CustomEvent<AudioDemoOverrideState>).detail
      setOverride(detail ?? readAudioDemoOverride())
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setOverride(readAudioDemoOverride())
    }

    window.addEventListener(EVENT_NAME, onOverride)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onOverride)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return override
}

function normalizeRemoteCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64)
}

export interface RemoteAudioDemoCommandResponse {
  ok: boolean
  channel_id: string
  outcome: RemoteAudioDemoOutcome | null
  command_id: string | null
  consumed: boolean
}

export async function sendRemoteAudioDemoCommand(
  channelId: string,
  outcome: RemoteAudioDemoOutcome,
): Promise<RemoteAudioDemoCommandResponse> {
  const res = await fetch(`${apiBase}/api/audio-demo-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: normalizeRemoteCode(channelId), outcome }),
  })
  if (!res.ok) throw new Error((await res.text()).slice(0, 300) || 'Failed to send command')
  return res.json()
}

export async function consumeRemoteAudioDemoCommand(
  channelId: string,
): Promise<RemoteAudioDemoCommandResponse> {
  const res = await fetch(`${apiBase}/api/audio-demo-command/${encodeURIComponent(normalizeRemoteCode(channelId))}`)
  if (!res.ok) throw new Error((await res.text()).slice(0, 300) || 'Failed to read command')
  return res.json()
}

export function buildAudioDemoResult({
  outcome,
  mode,
  ornament,
  updatedAt,
}: {
  outcome: Exclude<AudioDemoOutcome, 'off'>
  mode: AudioDemoMode
  ornament: string
  updatedAt: number
}) {
  const score = poolPick(SCORE_POOLS[outcome], updatedAt)
  const confidence = poolPick(CONFIDENCE_POOLS[outcome], updatedAt, 1)
  const isDrop = mode === 'drop'

  if (outcome === 'pass') {
    const decayMs = poolPick(isDrop ? [820, 910, 1040, 1180] : [560, 640, 720, 810], updatedAt, 2)
    const freqHz = poolPick([940, 1080, 1220, 1360], updatedAt, 3)

    return {
      score,
      verdict: 'Gold-like acoustic signature detected',
      confidence,
      params: {
        decay_time_ms: decayMs,
        spectral_centroid_hz: poolPick([1320, 1460, 1580, 1710], updatedAt, 4),
        dominant_freq_hz: freqHz,
        gold_band_ratio: poolPick([0.71, 0.76, 0.81, 0.84], updatedAt, 5),
        hf_ratio: poolPick([0.08, 0.1, 0.12, 0.14], updatedAt, 6),
        exp_decay_r2: poolPick([0.88, 0.91, 0.94, 0.96], updatedAt, 7),
        snr_db: poolPick([22, 25, 28, 31], updatedAt, 8),
        tap_events: isDrop ? 1 : poolPick([3, 4, 5], updatedAt, 9),
        attack_ms: poolPick([7, 9, 11, 14], updatedAt, 10),
        q_factor: poolPick([36, 42, 47, 53], updatedAt, 11),
      },
      explanation: `${ornament} sample shows a sustained warm resonance, low high-frequency noise, and a clean exponential decay profile consistent with a dense gold item.`,
      low_confidence_flag: false,
      disclaimer: 'Demo override result for local testing only. Not a real acoustic authenticity decision.',
      valid: true,
      reject_reason: null,
      label: 'Likely solid gold',
      reasoning: 'Demo pass profile selected from the local audio override control.',
      decay_ms: decayMs,
      dominant_freq_hz: freqHz,
      demo_override: true,
    }
  }

  if (outcome === 'fail') {
    const decayMs = poolPick(isDrop ? [210, 260, 310, 370] : [180, 240, 290, 340], updatedAt, 2)
    const freqHz = poolPick([1780, 2120, 2460, 2890], updatedAt, 3)

    return {
      score,
      verdict: 'Suspicious acoustic signature detected',
      confidence,
      params: {
        decay_time_ms: decayMs,
        spectral_centroid_hz: poolPick([2460, 2810, 3180, 3520], updatedAt, 4),
        dominant_freq_hz: freqHz,
        gold_band_ratio: poolPick([0.22, 0.29, 0.34, 0.39], updatedAt, 5),
        hf_ratio: poolPick([0.26, 0.31, 0.36, 0.42], updatedAt, 6),
        exp_decay_r2: poolPick([0.56, 0.62, 0.69, 0.74], updatedAt, 7),
        snr_db: poolPick([16, 18, 21, 23], updatedAt, 8),
        tap_events: isDrop ? 1 : poolPick([3, 4, 5], updatedAt, 9),
        attack_ms: poolPick([4, 6, 8, 10], updatedAt, 10),
        q_factor: poolPick([10, 14, 17, 21], updatedAt, 11),
      },
      explanation: `${ornament} sample damps quickly and contains extra high-frequency energy, a pattern that can appear with plated or lower-density metals.`,
      low_confidence_flag: confidence === 'low',
      disclaimer: 'Demo override result for local testing only. Not a real acoustic authenticity decision.',
      valid: true,
      reject_reason: null,
      label: 'Needs physical verification',
      reasoning: 'Demo fail profile selected from the local audio override control.',
      decay_ms: decayMs,
      dominant_freq_hz: freqHz,
      demo_override: true,
    }
  }

  return {
    score,
    verdict: 'Recording quality is not strong enough for a decision',
    confidence,
    params: {
      decay_time_ms: poolPick([390, 430, 470, 520], updatedAt, 2),
      spectral_centroid_hz: poolPick([1540, 1760, 1980, 2210], updatedAt, 3),
      dominant_freq_hz: poolPick([860, 990, 1140, 1280], updatedAt, 4),
      gold_band_ratio: poolPick([0.44, 0.48, 0.52, 0.56], updatedAt, 5),
      hf_ratio: poolPick([0.17, 0.2, 0.23, 0.25], updatedAt, 6),
      exp_decay_r2: poolPick([0.58, 0.63, 0.68, 0.72], updatedAt, 7),
      snr_db: poolPick([8, 10, 12, 14], updatedAt, 8),
      tap_events: isDrop ? 0 : poolPick([1, 2], updatedAt, 9),
      attack_ms: poolPick([16, 19, 23, 27], updatedAt, 10),
      q_factor: poolPick([18, 21, 24, 28], updatedAt, 11),
    },
    explanation: 'The demo retry profile simulates weak taps, room noise, or an unclear impact. Ask for a cleaner recording before deciding.',
    low_confidence_flag: true,
    disclaimer: 'Demo override result for local testing only. Not a real acoustic authenticity decision.',
    valid: false,
    reject_reason: 'Demo retry selected: recording is too noisy or too weak to analyse confidently.',
    label: 'Retry acoustic test',
    reasoning: 'Demo retry profile selected from the local audio override control.',
    decay_ms: poolPick([390, 430, 470, 520], updatedAt, 12),
    dominant_freq_hz: poolPick([860, 990, 1140, 1280], updatedAt, 13),
    demo_override: true,
  }
}
