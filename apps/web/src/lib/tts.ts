/**
 * TTS — Sarvam AI (Hindi) + Web Speech API (English/fallback).
 * Sarvam "meera" is the warmest, most relaxed Hindi female voice.
 */

const SARVAM_KEY = 'sk_gb0t7hf0_XLAp44zXlvnsfgPwNlRl3X91'
const SARVAM_URL = 'https://api.sarvam.ai/text-to-speech'

let currentAudio: HTMLAudioElement | null = null
const audioCache = new Map<string, string>()

export function stopSpeech() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
    currentAudio = null
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export async function prefetchSpeech(text: string, lang?: string) {
  if (!text) return
  const cleanText = text.replace(/\*\*/g, '')
  const language = lang ?? localStorage.getItem('goldeye_lang') ?? 'en'
  if (language === 'hi' && !audioCache.has(cleanText)) {
    try {
      const res = await fetch(SARVAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY },
        body: JSON.stringify({
          inputs: [cleanText], target_language_code: 'hi-IN', speaker: 'vidya', pitch: 0, pace: 0.85, loudness: 1.5, speech_sample_rate: 22050, enable_preprocessing: true, model: 'bulbul:v2'
        })
      })
      if (res.ok) {
        const data = await res.json()
        if (data.audios?.[0]) audioCache.set(cleanText, data.audios[0])
      }
    } catch (e) {
      console.warn('Failed to prefetch TTS:', e)
    }
  }
}

async function sarvamSpeak(text: string): Promise<void> {
  let b64 = audioCache.get(text)

  if (!b64) {
    const res = await fetch(SARVAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': SARVAM_KEY,
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: 'hi-IN',
        speaker: 'vidya',
        pitch: 0,
        pace: 0.85,
        loudness: 1.5,
        speech_sample_rate: 22050,
        enable_preprocessing: true,
        model: 'bulbul:v2',
      }),
    })

    if (!res.ok) throw new Error(`Sarvam TTS ${res.status}`)

    const data = await res.json()
    b64 = data.audios?.[0]
    if (!b64) throw new Error('No audio returned')
    
    audioCache.set(text, b64)
  }

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
  // Strip markdown ** bolding before speaking
  const cleanText = text.replace(/\*\*/g, '')
  const language = lang ?? localStorage.getItem('goldeye_lang') ?? 'en'
  if (language === 'hi') {
    sarvamSpeak(cleanText).catch(() => webSpeak(cleanText, 'hi-IN'))
    return
  }
  webSpeak(cleanText, 'en-US')
}
