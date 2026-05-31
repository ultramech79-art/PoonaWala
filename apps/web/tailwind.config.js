import { brand, gold, stone, surface, semantic, chart, shadow, radius, font } from './src/theme/palette.js'

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Brand (burnt orange) — primary accent, CTAs, active states
        brand,
        // ── Gold — trust badges, purity/value highlights, verified states
        gold,
        // ── Warm neutral ramp (replaces cold grey app-wide)
        stone,
        // ── Named surfaces
        canvas:   surface.canvas,
        surface:  surface.card,
        sand:     surface.sand,
        'sand-soft': surface.sandSoft,
        charcoal: surface.charcoal,
        muted:    surface.muted,
        // Warm-charcoal ramp — keeps legacy dark surfaces (ink-800/900) rendering
        // in warm tones until each dark screen is migrated to light mode.
        ink: {
          50:  '#F5F3EF', 100: '#E7E3DC', 200: '#CFC8BD', 300: '#A89F90',
          400: '#6E665A', 500: '#4A4339', 600: '#36302A', 700: '#2B2622',
          800: '#211D1A', 900: '#171411', 950: '#0F0D0B',
        },
        // ── Semantic (warm-toned)
        success:  semantic.success,
        warning:  semantic.warning,
        error:    semantic.error,
        info:     semantic.info,
        // ── Confidence / chart accents
        coral:    chart.coral,
        mustard:  chart.mustard,
        'chart-purple': chart.purple,
        // ── Legacy compat (old red theme → mapped onto warm system)
        poonawala: { red: brand[500], gold: gold[500] },
      },
      fontFamily: {
        sans: font.sans,
        display: font.display,
        mono: font.mono,
      },
      fontSize: {
        // tuned mobile type scale
        'display-xl': ['2.75rem', { lineHeight: '1.04', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display-lg': ['2.25rem', { lineHeight: '1.06', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display':    ['1.75rem', { lineHeight: '1.1',  letterSpacing: '-0.01em', fontWeight: '600' }],
      },
      boxShadow: {
        xs:   shadow.xs,
        sm:   shadow.sm,
        card: shadow.card,
        'card-hover': shadow.lg,
        lg:   shadow.lg,
        cta:  shadow.cta,
        // legacy aliases retuned to warm palette
        brand: shadow.cta,
        'brand-sm': shadow.sm,
        'brand-lg': shadow.lg,
        gold: shadow.sm,
        'gold-sm': shadow.xs,
      },
      borderRadius: {
        '2xl': radius['2xl'],
        '3xl': radius['3xl'],
        '4xl': radius['4xl'],
      },
      spacing: {
        safe: 'env(safe-area-inset-bottom)',
      },
      keyframes: {
        fadeIn:    { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp:   { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideDown: { from: { opacity: '0', transform: 'translateY(-10px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        scaleIn:   { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        shimmer:   { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        bandDraw:  { from: { transform: 'scaleX(0)', transformOrigin: 'left' }, to: { transform: 'scaleX(1)', transformOrigin: 'left' } },
        marquee:   { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
      },
      animation: {
        'fade-in':    'fadeIn 0.4s cubic-bezier(0.22,1,0.36,1)',
        'slide-up':   'slideUp 0.45s cubic-bezier(0.22,1,0.36,1)',
        'slide-down': 'slideDown 0.35s cubic-bezier(0.22,1,0.36,1)',
        'scale-in':   'scaleIn 0.3s cubic-bezier(0.22,1,0.36,1)',
        'shimmer':    'shimmer 1.6s ease-in-out infinite',
        'spin-slow':  'spin 3s linear infinite',
        'marquee':    'marquee 24s linear infinite',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundImage: {
        'sheen': 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
      },
      backdropBlur: { xs: '2px' },
    },
  },
  safelist: [
    'bg-brand-500', 'bg-brand-600', 'text-brand-600', 'border-brand-500',
    'bg-gold-500', 'text-gold-700', 'border-gold-300',
    'text-stone-900', 'bg-canvas', 'bg-sand', 'bg-charcoal',
    'text-poonawala-red', 'bg-poonawala-red',
  ],
  plugins: [],
}
