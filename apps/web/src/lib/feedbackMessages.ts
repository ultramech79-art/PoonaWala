/**
 * Premium, localized capture feedback.
 *
 * The backend (Gemini/Groq) returns a free-form English `feedback` sentence plus
 * a structured `issues`/`detected` payload. We never surface the raw machine tags
 * (e.g. "no_coin") to the user — instead we map the structured result to a polished,
 * production-grade message in the user's chosen language. English unmapped cases keep
 * the rich backend sentence; Hindi unmapped cases fall back to a clean generic line so
 * the TTS never reads English text with a Hindi voice.
 */
import type { FrameEvalResult } from './api'

type Translate = (key: string, opts?: Record<string, unknown>) => string

/**
 * Localize the audio (drop-test) verdict for display + TTS. The backend returns a
 * fixed set of English verdicts; we map them to the active language by keyword and
 * fall back to the original text for anything unrecognised (so nothing is lost).
 */
export function localizeAudioVerdict(verdict: string, t: Translate): string {
  const v = (verdict || '').toLowerCase()
  if (!v) return verdict
  if (/plated|imitation/.test(v)) return v.includes('possibly') ? t('verdict_possibly_plated') : t('verdict_likely_plated')
  if (/inconclusive|mixed/.test(v)) return t('verdict_inconclusive')
  if (/solid gold|solid|genuine/.test(v)) return t('verdict_solid_gold')
  if (/invalid/.test(v)) return t('verdict_invalid')
  return verdict
}

export function localizeFeedback(
  stepType: string,
  result: FrameEvalResult,
  t: Translate,
  lang: string,
): string {
  const issues = result.issues ?? []
  const detected = (result.detected ?? {}) as Record<string, unknown>
  const has = (k: string) => issues.includes(k)

  if (result.approved) {
    if (stepType === 'macro') {
      const karat = typeof detected.karat_marking === 'string' ? detected.karat_marking : null
      const price = typeof detected.estimated_price_per_g === 'number' ? detected.estimated_price_per_g : null
      if (karat && price) return t('fb_macro_priced', { karat, price: Math.round(price).toLocaleString('en-IN') })
      if (karat) return t('fb_macro_karat', { karat })
      return t('fb_macro_ok')
    }
    if (stepType === 'selfie') return t('fb_selfie_ok')
    return t('fb_approved')
  }

  // Rejected — surface the single most important reason, in priority order.
  const goldMissing = has('no_gold') || detected.gold_jewelry_present === false || detected.jewelry_visible === false
  const coinMissing = has('no_coin') || detected.coin_visible === false
  if (goldMissing) return t('fb_no_gold')
  if (coinMissing) return t('fb_no_coin')
  if (has('coin_partially_cut_off')) return t('fb_coin_cut')
  if (has('coin_standing_upright')) return t('fb_coin_upright')
  if (detected.in_focus === false) return t('fb_blurry')
  if (detected.good_lighting === false) return t('fb_dark')
  if (stepType === 'macro' && detected.hallmark_visible === false) return t('fb_no_hallmark')
  if (stepType === 'selfie') return t('fb_selfie_retry')

  if (lang === 'hi') return t('fb_reject_generic')
  return result.feedback || t('fb_reject_generic')
}
