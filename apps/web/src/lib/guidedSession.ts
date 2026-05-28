import { apiBase } from './api'

export interface GuidedSessionInfo {
  session_id: string
  room_url: string
  user_token: string
  status: string
}

export interface SessionProgress {
  session_id: string
  captured: string[]
  pending: string[]
  current_angle: string | null
  all_done: boolean
  assess_result: Record<string, unknown> | null
}

export const ANGLE_LABELS: Record<string, string> = {
  top:    'Top-down shot',
  '45deg': '45° angle',
  side:   'Side profile',
  macro:  'Hallmark close-up',
  selfie: 'Selfie with gold',
}

export const ANGLE_ICONS: Record<string, string> = {
  top:    '🔭',
  '45deg': '📐',
  side:   '➡️',
  macro:  '🔍',
  selfie: '🤳',
}

export async function startGuidedSession(existingSessionId?: string): Promise<GuidedSessionInfo> {
  const res = await fetch(`${apiBase}/api/guided-session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: existingSessionId ?? null }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail ?? 'Failed to start guided session')
  }
  return res.json()
}

export async function pollProgress(sessionId: string): Promise<SessionProgress> {
  const res = await fetch(`${apiBase}/api/guided-session/${sessionId}/progress`)
  if (!res.ok) throw new Error('Session not found')
  return res.json()
}

export async function endGuidedSession(sessionId: string): Promise<void> {
  await fetch(`${apiBase}/api/guided-session/${sessionId}/end`, { method: 'POST' })
}
