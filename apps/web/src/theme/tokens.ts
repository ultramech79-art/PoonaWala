// ─────────────────────────────────────────────────────────────────────────
//  Runtime design tokens — re-exports the canonical palette with TS types,
//  plus Framer Motion variants and semantic helpers used across the app.
//  Raw values live in ./palette.js (also consumed by tailwind.config.js).
// ─────────────────────────────────────────────────────────────────────────
import type { Variants, Transition } from 'framer-motion'
import {
  brand, gold, stone, surface, semantic, chart, shadow, radius, motion, font,
} from './palette.js'

export { brand, gold, stone, surface, semantic, chart, shadow, radius, motion, font }

// ── Motion ────────────────────────────────────────────────────────────────
export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]
export const spring: Transition = motion.spring as Transition

/** Page push — native slide/fade. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter:   { opacity: 1, y: 0, transition: { duration: motion.durBase, ease: EASE } },
  exit:    { opacity: 0, y: -8, transition: { duration: motion.durBase * 0.66, ease: EASE } },
}

/** Staggered fade-up container for card lists. */
export const listVariants: Variants = {
  enter: { transition: { staggerChildren: motion.stagger, delayChildren: 0.04 } },
}

/** Single card / row in a staggered list (12px rise). */
export const itemVariants: Variants = {
  initial: { opacity: 0, y: motion.rise },
  enter:   { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
}

/** Bottom-sheet slide-up. */
export const sheetVariants: Variants = {
  initial: { y: '100%' },
  enter:   { y: 0, transition: spring },
  exit:    { y: '100%', transition: { duration: 0.25, ease: EASE } },
}

/** Press feedback for tappable cards/buttons. */
export const pressable = { whileTap: { scale: 0.97 } }

// ── Semantic helpers ────────────────────────────────────────────────────────
/** Confidence band → traffic-light tone (warm, muted). */
export function confidenceTone(score: number) {
  if (score >= 0.75) return { color: semantic.success, key: 'high' as const }
  if (score >= 0.55) return { color: gold[600],        key: 'medium' as const }
  return { color: brand[500], key: 'low' as const }
}
