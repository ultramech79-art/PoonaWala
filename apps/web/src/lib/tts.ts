/**
 * TTS — Sarvam AI via backend proxy (Hindi) + Web Speech API (English/fallback).
 * API key lives server-side in SARVAM_API_KEY env var on Render.
 */
import { apiBase } from './api'

let currentAudio: HTMLAudioElement | null = null

export function stopSpeech() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    currentAudio = null
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

async function sarvamSpeak(text: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker: 'vidya', pace: 0.85 }),
  })

  if (!res.ok) throw new Error(`TTS proxy ${res.status}`)

  const data = await res.json()
  const b64 = data.audio_b64
  if (!b64) throw new Error('No audio returned')

  stopSpeech()

  const audio = new Audio(`data:audio/wav;base64,${b64}`)
  currentAudio = audio
  audio.addEventListener('ended', () => { if (currentAudio === audio) currentAudio = null })
  await audio.play()
}

function webSpeak(text: string, lang: string): void {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = lang
  u.rate = 0.95
  window.speechSynthesis.speak(u)
}

export function speak(text: string, lang?: string): void {
  if (!text) return
  const language = lang ?? localStorage.getItem('goldeye_lang') ?? 'en'
  if (language === 'hi') {
    sarvamSpeak(text).catch(() => webSpeak(text, 'hi-IN'))
    return
  }
  webSpeak(text, 'en-US')
}
