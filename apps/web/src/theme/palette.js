// ─────────────────────────────────────────────────────────────────────────
//  GoldEye — Design Tokens (single source of truth)
//  Quiet ivory canvas · copper accent · muted gold trust · charcoal structure.
//  Consumed by tailwind.config.js (build-time) and src/theme/tokens.ts (runtime).
//  Designed for a premium mobile finance flow: low glare, clear contrast, and
//  deliberate accent color only where it helps decision-making.
// ─────────────────────────────────────────────────────────────────────────

/** Burnt orange — primary CTAs, active states, progress fill, key highlights. 500 = brand. */
export const brand = {
  50:  '#FFF1E8',
  100: '#F9D8C7',
  200: '#EEA981',
  300: '#DE7A46',
  400: '#C96634',
  500: '#B8522A', // red-orange copper
  600: '#974020',
  700: '#743018',
  800: '#512112',
  900: '#32140B',
}

/** Gold — trust badges, purity/value highlights, verified states. Sparing, elegant. */
export const gold = {
  50:  '#FBF4E4',
  100: '#F2E1B8',
  200: '#DFC77F',
  300: '#C8A65C',
  400: '#AA8641',
  500: '#8C6B31',
  600: '#725528',
  700: '#57401F',
  800: '#3C2B17',
  900: '#271C10',
}

/** Warm neutral ramp — replaces cold greys app-wide. 900 = ink, 800 = charcoal CTA. */
export const stone = {
  50:  '#FBFAF6',
  100: '#F0EBDD',
  200: '#DDD4C1',
  300: '#C4B9A4',
  400: '#958A79',
  500: '#706756',
  600: '#574D40',
  700: '#3F382F',
  800: '#29241F',
  900: '#171412',
}

/** Named surfaces. */
export const surface = {
  canvas:   '#F8F4EA', // light warm ivory
  card:     '#FFFFFF', // primary card surface
  sand:     '#F5E4CC', // soft peach info card
  sandSoft: '#FCF4E7', // lighter sand wash
  charcoal: '#27211E', // warm charcoal dark button
  ink:      '#171412', // primary text
  muted:    '#887D6F', // secondary text
}

/** Semantic — muted, warm-toned. */
export const semantic = {
  success: '#3F7D56',
  warning: '#B88936',
  error:   '#B4543F',
  info:    '#496D8F',
}

/** Confidence / chart accents. */
export const chart = {
  coral:  '#C96A55',
  mustard:'#C89A4B',
  purple: '#88729C',
  teal:   '#5F958B',
  sand:   '#B89C62',
}

/** Soft warm shadows — no harsh borders/hairlines. */
export const shadow = {
  xs:   '0 1px 2px rgba(32,24,18,0.035)',
  sm:   '0 2px 10px rgba(32,24,18,0.045)',
  card: '0 10px 28px rgba(32,24,18,0.055)',
  lg:   '0 18px 46px rgba(32,24,18,0.07)',
  cta:  '0 10px 22px rgba(36,32,29,0.12)',
}

/** Card radius 14–18px. */
export const radius = {
  '2xl': '0.875rem',
  '3xl': '1.125rem',
  '4xl': '1.5rem',
}

/** Motion constants — native-feeling, premium. */
export const motion = {
  ease:       'cubic-bezier(0.22, 1, 0.36, 1)', // primary easing (out-expo-ish)
  easeIn:     'cubic-bezier(0.55, 0, 1, 0.45)',
  durFast:    0.18,
  durBase:    0.35, // page push spring ~350ms
  durSlow:    0.5,
  stagger:    0.04, // 40ms list stagger
  rise:       12,   // px translateY on fade-up
  spring:     { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
}

/** Font stacks — Switzer (Latin) + Noto Sans Devanagari (Hindi), graceful fallback. */
export const font = {
  sans:    ['Switzer', 'Noto Sans Devanagari', 'system-ui', '-apple-system', 'sans-serif'],
  display: ['Switzer', 'Noto Sans Devanagari', 'system-ui', 'sans-serif'],
  mono:    ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
}
