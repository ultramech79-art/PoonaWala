// ─────────────────────────────────────────────────────────────────────────
//  DEV-ONLY PREVIEW SEED — temporary. Not shipped (guarded by import.meta.env.DEV).
//  Visit /result?seed=1 (or add &fail=1) to render Result with sample data
//  without walking the whole capture flow.
//
//  Imported FIRST in main.tsx so it writes sessionStorage before the session
//  store module initializes. Delete this file + its import to remove.
//  Touches no routing, API, or business logic.
// ─────────────────────────────────────────────────────────────────────────

const STORE_KEY = 'goldeye_session_state_v1'

// tiny inline SVG "jewelry" placeholder so the photo-analysis grid + Grad-CAM render
const swatch = (label: string) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>
       <defs><radialGradient id='g' cx='50%' cy='45%'>
         <stop offset='0%' stop-color='#E6C66B'/><stop offset='60%' stop-color='#C8A24B'/>
         <stop offset='100%' stop-color='#8A6B2E'/></radialGradient></defs>
       <rect width='240' height='240' fill='#211D1A'/>
       <circle cx='120' cy='108' r='62' fill='none' stroke='url(#g)' stroke-width='16'/>
       <text x='120' y='220' fill='#9A9388' font-size='18' font-family='sans-serif' text-anchor='middle'>${label}</text>
     </svg>`)

const ts = Date.now()

const sampleResult = {
  schema_version: '1.0',
  session_id: 'dev_preview',
  timestamp_utc: new Date().toISOString(),
  purity: { band_low_karat: 21, band_high_karat: 22, point_estimate_karat: 22, huid_verified: true },
  weight: { manual_entry_g: null, estimated_g: 18.4, band_low_g: 17.9, band_high_g: 18.9, method: 'hybrid' },
  value_inr: { band_low: 92000, band_high: 105000, ibja_reference_date: new Date().toISOString().slice(0, 10), stone_weight_excluded_g: 0.4 },
  loan_offer: { band_low_inr: 64400, band_high_inr: 73500, ltv_applied_pct: 70, tier: '2_5L_to_5L' },
  confidence: { score: 0.86, coverage_guarantee_pct: 90, calibration_method: 'conformal' },
  fraud_signals: { score: 0.04, triggers: [] as string[] },
  routing: 'INSTANT' as const,
  reasoning_text: {
    lang: 'en',
    text: 'HUID hallmark verified against BIS CARE (916 · 22K). Weight is consistent across the four captures and the surface specular response matches solid gold. High calibrated confidence.',
  },
  xai: {
    gradcam_url: swatch('Grad-CAM'),
    shap_top_features: [
      { feature: 'huid_verified', contribution: 0.19 },
      { feature: 'weight_consistency', contribution: 0.12 },
      { feature: 'hallmark_quality', contribution: 0.09 },
      { feature: 'vlm_confidence', contribution: 0.07 },
      { feature: 'plated_probability', contribution: -0.05 },
    ],
    counterfactual: null,
  },
  audit: { trace_id: 'dev-preview-3f9a2c71', input_asset_hashes: [] },
}

// REJECT/RECAPTURE variant to preview the fail state
const failResult = {
  ...sampleResult,
  purity: { ...sampleResult.purity, huid_verified: false },
  confidence: { ...sampleResult.confidence, score: 0.31 },
  fraud_signals: { score: 0.62, triggers: ['plated_surface_suspected', 'weight_mismatch'] },
  routing: 'REJECT' as const,
}

export function maybeSeedResult() {
  if (!import.meta.env.DEV) return
  const params = new URLSearchParams(window.location.search)
  if (!params.has('seed')) return

  const result = params.has('fail') ? failResult : sampleResult
  const captures = params.has('fail') ? {} : {
    top:   { type: 'top',   dataUrl: swatch('top'),   timestamp: ts },
    macro: { type: 'macro', dataUrl: swatch('macro'), timestamp: ts },
  }

  const payload = {
    sessionId: 'dev_preview', lang: 'en', consentAt: ts, phone: null, name: 'Preview',
    captures, skippedCaptures: {}, pageEvidence: {}, weightG: 18.4, huidCode: 'HUID22KDEMO',
    scannedKarat: 22, certificateData: null, huidVerification: null, liveAuthResult: null,
    tapTestResult: null, result, confidenceBreakdown: null, evalData: null, loanAppData: null,
  }
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(payload)) } catch {}
}

maybeSeedResult()
