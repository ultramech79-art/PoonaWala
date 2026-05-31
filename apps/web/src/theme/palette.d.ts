// Type declarations for the canonical palette (palette.js is plain ESM so it
// can be imported by both tailwind.config.js and the TS app).
type Ramp = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>

export const brand: Ramp
export const gold: Ramp
export const stone: Ramp
export const surface: {
  canvas: string; card: string; sand: string; sandSoft: string
  charcoal: string; ink: string; muted: string
}
export const semantic: { success: string; warning: string; error: string; info: string }
export const chart: { coral: string; mustard: string; purple: string; teal: string; sand: string }
export const shadow: { xs: string; sm: string; card: string; lg: string; cta: string }
export const radius: { '2xl': string; '3xl': string; '4xl': string }
export const motion: {
  ease: string; easeIn: string
  durFast: number; durBase: number; durSlow: number; stagger: number; rise: number
  spring: { type: string; stiffness: number; damping: number; mass: number }
}
export const font: { sans: string[]; display: string[]; mono: string[] }
