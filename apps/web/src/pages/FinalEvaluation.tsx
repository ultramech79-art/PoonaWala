import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import {
  getAllStates, getCitiesForState, resolveRegion,
} from '../lib/regionEngine'
import { computeLTV } from '../lib/ltvEngine'
import { getCibilTierKey, getCibilTierInfo } from '../lib/roiEngine'
import { validatePAN, deriveScoreFromPAN } from '../lib/panEngine'
import { apiBase } from '../lib/api'
import loanParams from '../data/loan_params.json'
import regionsData from '../data/regions.json'
import {
  ChevronRight, MapPin,
  ArrowRight, CheckCircle, AlertTriangle, Info, CreditCard, Loader,
} from 'lucide-react'
import { clsx } from 'clsx'

const fmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

const CIBIL_COLOR: Record<string, string> = {
  emerald: 'bg-emerald-50 border-emerald-300 text-emerald-700',
  blue:    'bg-blue-50 border-blue-300 text-blue-700',
  amber:   'bg-amber-50 border-amber-300 text-amber-700',
  orange:  'bg-orange-50 border-orange-300 text-orange-700',
  red:     'bg-red-50 border-red-300 text-red-700',
  purple:  'bg-purple-50 border-purple-300 text-purple-700',
}

interface CityPrices {
  '24k': number
  '22k': number
  '18k': number
}

export function FinalEvaluation() {
  const navigate = useNavigate()
  const { state, setEvalData } = useSessionStore()
  const result = state.result

  const canShowFinalEvaluation =
    result && (
      result.routing === 'INSTANT' ||
      result.routing === 'AGENT' ||
      ((result.routing === 'RECAPTURE' || result.routing === 'REJECT') && result.confidence.score > 0.50)
    )

  if (!canShowFinalEvaluation) {
    navigate('/result')
    return null
  }

  const defaultStateName = useMemo(() => {
    const code = state.userProfile?.region_code
    if (!code) return ''
    const match = loanParams.rbi_rules ? undefined : undefined // dummy check
    const states = (regionsData as any).states
    const s = states.find((x: any) => x.code === code)
    return s?.name || ''
  }, [state.userProfile?.region_code])

  // ── Location state ──────────────────────────────────────────────────────────
  const [selectedState, setSelectedState] = useState(defaultStateName)
  const [selectedCity, setSelectedCity]   = useState('')
  const allStates = useMemo(() => getAllStates(), [])
  const cities    = useMemo(() => selectedState ? getCitiesForState(selectedState) : [], [selectedState])
  const region    = useMemo(
    () => selectedState && selectedCity ? resolveRegion(selectedState, selectedCity) : null,
    [selectedState, selectedCity],
  )

  // ── City gold price from Times of India ─────────────────────────────────────
  const [cityPrices, setCityPrices]       = useState<CityPrices | null>(null)
  const [priceSource, setPriceSource]     = useState('')
  const [priceLoading, setPriceLoading]   = useState(false)
  const [priceError, setPriceError]       = useState(false)

  useEffect(() => {
    if (!selectedCity || !selectedState) {
      setCityPrices(null)
      return
    }
    let cancelled = false
    setPriceLoading(true)
    setPriceError(false)
    fetch(`${apiBase}/api/gold-price/city?city=${encodeURIComponent(selectedCity)}&state=${encodeURIComponent(selectedState)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        setCityPrices(data.prices_per_gram)
        setPriceSource(data.source)
      })
      .catch(() => { if (!cancelled) setPriceError(true) })
      .finally(() => { if (!cancelled) setPriceLoading(false) })
    return () => { cancelled = true }
  }, [selectedCity, selectedState])

  // ── Gold value using real city price ────────────────────────────────────────
  const detectedKarat = result.purity.point_estimate_karat
  const netWeightG = result.weight.method === 'BILL_CERTIFICATE_OCR'
    ? result.weight.estimated_g
    : Math.max(
      result.weight.estimated_g - (result.value_inr.stone_weight_excluded_g ?? 0),
      result.weight.estimated_g * 0.94,
    )

  const cityPriceForKarat = useMemo(() => {
    if (!cityPrices) return 0
    if (detectedKarat >= 23.5) return cityPrices['24k']
    if (detectedKarat >= 21.5 && detectedKarat < 22.5) return cityPrices['22k']
    if (detectedKarat >= 17.5 && detectedKarat < 18.5) return cityPrices['18k']
    return cityPrices['24k'] * detectedKarat / 24
  }, [cityPrices, detectedKarat])

  const cityGoldValue = cityPriceForKarat > 0
    ? Math.round(cityPriceForKarat * netWeightG)
    : 0
  // ── PAN + derived credit profile ────────────────────────────────────────────
  const [pan, setPan] = useState('')
  const panValidation = useMemo(() => validatePAN(pan), [pan])
  const derivedScore  = useMemo(() => deriveScoreFromPAN(pan), [pan])
  const cibilTierKey  = useMemo(() => getCibilTierKey(derivedScore), [derivedScore])
  const cibilInfo     = useMemo(() => getCibilTierInfo(cibilTierKey), [cibilTierKey])

  // ── LTV — RBI tier ceiling, offered against the assessment confidence ────────
  const ltvResult = useMemo(() => {
    if (!region || cityGoldValue === 0) return null
    return computeLTV({
      goldValueInr: cityGoldValue,
      confidence: result.confidence.score,
      goldType: 'jewelry',
    })
  }, [region, cityGoldValue, result])

  // ── Eligibility ──────────────────────────────────────────────────────────────
  const eligible = useMemo(() => {
    if (!region || !ltvResult) return false
    if (detectedKarat < loanParams.rbi_rules.min_purity_karat) return false
    if (result.weight.estimated_g > loanParams.rbi_rules.max_weight_per_applicant_kg * 1000) return false
    return true
  }, [region, ltvResult, detectedKarat, result])

  const rejectReason = useMemo(() => {
    if (detectedKarat < loanParams.rbi_rules.min_purity_karat)
      return `Gold purity ${detectedKarat}K is below RBI minimum ${loanParams.rbi_rules.min_purity_karat}K`
    if (result.weight.estimated_g > loanParams.rbi_rules.max_weight_per_applicant_kg * 1000)
      return `Weight exceeds ${loanParams.rbi_rules.max_weight_per_applicant_kg}kg per-applicant limit`
    return null
  }, [detectedKarat, result])

  const locationReady = Boolean(region)
  const canProceed    = locationReady && eligible && !priceLoading && cityGoldValue > 0
  const cumulativeItems = useMemo(() => {
    if (!result) return []
    const currentId = result.session_id || state.sessionId || 'current'
    return [
      {
        id: currentId,
        label: 'Current jewellery',
        purity: detectedKarat,
        weightG: result.weight.estimated_g,
        goldValueInr: cityGoldValue || Math.round((result.value_inr.band_low + result.value_inr.band_high) / 2),
        loanNowInr: ltvResult?.provisionalLowLoanInr ?? result.loan_offer.band_low_inr,
        loanMaxInr: ltvResult?.maxLoanInr ?? result.loan_offer.band_high_inr,
        isCurrent: true,
      },
      ...(state.assessedItems ?? [])
        .filter(item => item.sessionId !== currentId)
        .map((item, index) => {
          const itemResult = item.result
          return {
            id: item.sessionId,
            label: `Jewellery ${index + 2}`,
            purity: itemResult.purity.point_estimate_karat,
            weightG: itemResult.weight.estimated_g,
            goldValueInr: item.evalData?.cityGoldValueInr ?? Math.round((itemResult.value_inr.band_low + itemResult.value_inr.band_high) / 2),
            loanNowInr: item.evalData?.provisionalLoanLowInr ?? itemResult.loan_offer.band_low_inr,
            loanMaxInr: item.evalData?.maxLoanInr ?? itemResult.loan_offer.band_high_inr,
            isCurrent: false,
          }
        }),
    ]
  }, [result, state.sessionId, state.assessedItems, detectedKarat, cityGoldValue, ltvResult])
  const cumulativeGoldValue = cumulativeItems.reduce((sum, item) => sum + item.goldValueInr, 0)
  const cumulativeLoanNow = cumulativeItems.reduce((sum, item) => sum + item.loanNowInr, 0)
  const cumulativeLoanMax = cumulativeItems.reduce((sum, item) => sum + item.loanMaxInr, 0)

  function handleContinue() {
    if (!canProceed || !region || !ltvResult || !cityPrices || !result) return
    setEvalData({
      state: region.state,
      city: region.city,
      locationTier: region.tier,
      tierLabel: region.tierLabel,
      stampDutyInr: region.stampDutyInr,
      serviceable: region.serviceable,
      cityGoldValueInr: cityGoldValue,
      cityPricePerG: cityPriceForKarat,
      priceSource,
      cibilScore: derivedScore,
      cibilTierKey,
      cibilTierLabel: cibilInfo.label,
      pan,
      ltvFinalPct: ltvResult.finalLtvPct,
      ltvLowPct: ltvResult.provisionalLowLtvPct,
      tierCeilingPct: ltvResult.tierCeilingPct,
      confidenceScore: result.confidence.score,
      confidenceFactor: ltvResult.confidenceFactor,
      maxLoanInr: ltvResult.maxLoanInr,
      provisionalLoanLowInr: ltvResult.provisionalLowLoanInr,
      ticketTierLabel: ltvResult.ticketTierLabel,
      ticketTierDescription: ltvResult.ticketTierDescription,
      processingFeePct: loanParams.charges.processing_fee_pct,
      eligible: true,
      rejectReason: null,
    })
    navigate('/gold-loan-app')
  }

  return (
    <div className="flex flex-col app-page-bg final-evaluation-page animate-fade-in relative z-[5]" style={{ height: '100dvh' }}>
      <div className="page-header">
        <button onClick={() => navigate('/result')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">Loan Eligibility</span>
        <div className="w-11" />
      </div>

      <main className="flex-1 overflow-y-auto no-scrollbar px-5 pb-14 space-y-4 pt-4 final-evaluation-content">

        {/* Gold summary */}
        <div className="final-assessment-card rounded-3xl p-5">
          <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-gold-200/85 mb-2">Gold Assessment</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-display font-black text-2xl text-white">
                {detectedKarat}K · {result.weight.estimated_g.toFixed(1)}g
              </p>
              {cityGoldValue > 0 ? (
                <p className="text-xs text-white/62 mt-1">
                  City value ~{fmt(cityGoldValue)}
                  {priceSource === 'timesofindia' && (
                    <span className="ml-1 text-emerald-300 font-medium">· live city rate</span>
                  )}
                  {priceSource === 'ibja_national' && (
                    <span className="ml-1 text-stone-400">· IBJA national</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-white/55">Select city to load live rate…</p>
              )}
            </div>
            <div className="text-right">
              {result.purity.huid_verified && (
                <span className="badge-green text-[10px]"><CheckCircle className="w-3 h-3" /> HUID visible</span>
              )}
              {!result.purity.huid_verified && (
                <span className="text-[10px] bg-stone-100 text-stone-500 px-2 py-0.5 rounded-full font-semibold">Verification pending</span>
              )}
              <p className="text-xs text-white/55 mt-1">AI conf. {Math.round(result.confidence.score * 100)}%</p>
            </div>
          </div>
        </div>

        {/* Step 1: Location */}
        <div className="surface-panel final-step-panel rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-stone-950 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-white">1</span>
            </div>
            <p className="font-display font-semibold text-sm text-stone-900">Your Location</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label mb-1.5 block text-xs">State / Union Territory</label>
              <select
                value={selectedState}
                onChange={e => { setSelectedState(e.target.value); setSelectedCity('') }}
                className="input-field text-sm"
              >
                <option value="">Select state…</option>
                {allStates.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {selectedState && (
              <div>
                <label className="label mb-1.5 block text-xs">City</label>
                <select
                  value={selectedCity}
                  onChange={e => setSelectedCity(e.target.value)}
                  className="input-field text-sm"
                >
                  <option value="">Select city…</option>
                  {cities.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}

            {/* Live price loading indicator */}
            {priceLoading && (
              <div className="flex items-center gap-2 text-xs text-stone-500 bg-stone-50 rounded-lg px-3 py-2">
                <Loader className="w-3.5 h-3.5 animate-spin text-brand-600" />
                Fetching live gold rate for {selectedCity}…
              </div>
            )}

            {/* City gold price card */}
            {!priceLoading && cityPrices && region && (
              <div className="final-rate-card rounded-2xl px-3 py-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-brand-600 flex-shrink-0" />
                    <span className="text-xs font-semibold text-stone-700">
                      {region.city}, {region.state}
                    </span>
                  </div>
                  <span className={clsx(
                    'text-[10px] font-semibold px-2 py-1 rounded-full',
                    priceSource === 'timesofindia'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-stone-100 text-stone-500',
                  )}>
                    {priceSource === 'timesofindia' ? 'Live city rate' : 'IBJA national'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['24K', cityPrices['24k'], detectedKarat >= 23],
                    ['22K', cityPrices['22k'], detectedKarat >= 21 && detectedKarat < 23],
                    ['18K', cityPrices['18k'], detectedKarat >= 16 && detectedKarat < 19],
                  ] as [string, number, boolean][]).map(([label, price, highlight]) => (
                    <div
                      key={label}
                      className={clsx(
                        'final-rate-tile rounded-xl px-2 py-2 border',
                        highlight && 'is-active',
                      )}
                    >
                      <p className={clsx('text-[10px]', highlight ? 'text-stone-900 font-semibold' : 'text-stone-400')}>
                        {label}/g {highlight && '✓'}
                      </p>
                      <p className="text-xs font-bold text-stone-800">₹{Math.round(price).toLocaleString('en-IN')}</p>
                    </div>
                  ))}
                </div>

                {region.stampDutyInr > 0 && (
                  <p className="text-[10px] text-stone-500">Stamp duty: ₹{region.stampDutyInr}</p>
                )}
                <div className={clsx(
                  'flex items-center gap-1.5 text-[11px] font-medium',
                  region.serviceable ? 'text-emerald-600' : 'text-orange-500',
                )}>
                  {region.serviceable
                    ? <><CheckCircle className="w-3 h-3" /> Home pickup available</>
                    : <><AlertTriangle className="w-3 h-3" /> Branch visit required</>
                  }
                </div>
              </div>
            )}

            {!priceLoading && priceError && selectedCity && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5" />
                Could not load city rate — using IBJA national rate
              </div>
            )}
          </div>
        </div>

        {/* Step 2: PAN + auto credit profile */}
        <div className="surface-panel final-step-panel rounded-3xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-stone-950 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-white">2</span>
            </div>
            <div className="flex-1 flex items-center justify-between">
              <p className="font-display font-semibold text-sm text-stone-900">PAN & Credit Profile</p>
              <span className="text-[10px] text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">Optional</span>
            </div>
          </div>

          <input
            type="text"
            value={pan}
            onChange={e => setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
            placeholder="e.g. ABCDE1234F"
            className="input-field font-mono text-sm tracking-widest uppercase"
            maxLength={10}
          />

          {pan.length > 0 && (
            <div className={clsx(
              'mt-2 flex items-center gap-1.5 text-xs font-medium',
              panValidation.valid ? 'text-emerald-600' : pan.length < 10 ? 'text-stone-400' : 'text-red-500',
            )}>
              {panValidation.valid
                ? <><CheckCircle className="w-3.5 h-3.5" /> Valid PAN · {panValidation.entityType}</>
                : pan.length < 10
                ? <><CreditCard className="w-3.5 h-3.5" /> {pan.length}/10</>
                : <><AlertTriangle className="w-3.5 h-3.5" /> {panValidation.reason}</>
              }
            </div>
          )}

          {panValidation.valid && (
            <div className={clsx('mt-3 rounded-xl border px-3 py-3 space-y-1', CIBIL_COLOR[cibilInfo.color])}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">Credit: {cibilInfo.label}</span>
                {derivedScore && <span className="text-[10px] font-mono opacity-80">~{derivedScore}</span>}
              </div>
              <p className="text-[10px] opacity-75">{cibilInfo.description}</p>
              <p className="text-[10px] opacity-60 pt-0.5">
                Note: CIBIL affects interest rate only — not your loan eligibility or LTV
              </p>
            </div>
          )}

          {!panValidation.valid && !pan && (
            <div className="mt-3 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5">
              <p className="text-[11px] text-stone-500 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
                Enter PAN for your best rate. Gold is your primary collateral — low CIBIL doesn't block eligibility.
              </p>
            </div>
          )}

        </div>

        {/* Live Eligibility Card */}
        {locationReady && !priceLoading && ltvResult && cityGoldValue > 0 && (
          <div className={clsx('final-eligibility-panel rounded-3xl p-5', !eligible && 'is-rejected')}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-display font-semibold text-sm text-stone-900">Your Eligibility</p>
              {eligible
                ? <span className="final-status-pill"><CheckCircle className="w-3 h-3" /> Eligible</span>
                : <span className="final-status-pill is-rejected">Not Eligible</span>
              }
            </div>

            {rejectReason ? (
              <div className="flex items-start gap-2 text-sm text-red-600">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <p>{rejectReason}</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className="final-value-card rounded-2xl p-3">
                    <p className="text-[10px] text-stone-400 mb-1">City Gold Value</p>
                    <p className="font-display font-black text-base text-stone-900">{fmt(cityGoldValue)}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5">
                      ₹{Math.round(cityPriceForKarat).toLocaleString('en-IN')}/g · {detectedKarat}K
                    </p>
                  </div>
                  <div className="final-value-card rounded-2xl p-3">
                    <p className="text-[10px] text-stone-400 mb-1">Loan Available Now</p>
                    <p className="font-display font-black text-base text-stone-950 tabular-nums">{fmt(ltvResult.provisionalLowLoanInr)}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5 tabular-nums">
                      up to {fmt(ltvResult.maxLoanInr)} on verification
                    </p>
                  </div>
                </div>

                {/* Confidence → LTV — the one core formula */}
                <div className="final-ltv-card rounded-2xl p-3.5">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <p className="label text-stone-500">Loan-to-Value</p>
                    <span className="text-[10px] text-stone-500 text-right leading-snug">
                      {ltvResult.ticketTierDescription} · RBI cap {ltvResult.tierCeilingPct}%
                    </span>
                  </div>

                  {/* Provisional (now) → Final (after verification) */}
                  {(() => {
                    const floorPct = loanParams.ltv_adjusters.ltv_floor_pct
                    const span = Math.max(ltvResult.finalLtvPct - floorPct, 0.1)
                    const provWidth = Math.max(6, Math.min(100, ((ltvResult.provisionalLowLtvPct - floorPct) / span) * 100))
                    return (
                      <>
                        <div className="relative h-9 rounded-lg bg-stone-100 overflow-hidden">
                          <div
                            className="final-ltv-fill absolute inset-y-0 left-0 flex items-center justify-end pr-2 transition-all duration-500"
                            style={{ width: `${provWidth}%` }}
                          >
                            <span className="text-[11px] font-bold text-white tabular-nums">{ltvResult.provisionalLowLtvPct}%</span>
                          </div>
                          {ltvResult.provisionalLowLtvPct < ltvResult.finalLtvPct && provWidth < 80 && (
                            <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-bold text-stone-500 tabular-nums">
                              {ltvResult.finalLtvPct}%
                            </span>
                          )}
                        </div>
                        <div className="flex justify-between text-[10px] text-stone-400 mt-1">
                          <span>Now (provisional)</span>
                          <span>After verification (final)</span>
                        </div>
                      </>
                    )
                  })()}

                  {/* One core formula */}
                  <div className="final-formula-card mt-3 rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-stone-400 mb-1">Provisional LTV = floor + (RBI cap − floor) × confidence</p>
                    <p className="font-mono text-[12px] text-stone-700 tabular-nums">
                      {loanParams.ltv_adjusters.ltv_floor_pct} + ({ltvResult.finalLtvPct} − {loanParams.ltv_adjusters.ltv_floor_pct}) × {ltvResult.confidenceFactor}
                      {' = '}
                      <span className="font-bold text-stone-950">{ltvResult.provisionalLowLtvPct}%</span>
                    </p>
                  </div>

                  <p className="text-[11px] text-stone-500 mt-2 leading-snug">
                    Your assessment confidence of <b>{Math.round(result.confidence.score * 100)}%</b> unlocks{' '}
                    <b className="text-stone-950">{ltvResult.provisionalLowLtvPct}%</b> now; a branch visit unlocks the full{' '}
                    <b>{ltvResult.finalLtvPct}%</b>.
                  </p>
                </div>

                <p className="text-[10px] text-stone-400 mt-2 text-center">
                  LTV up to {loanParams.rbi_rules.headline_ltv_pct}% of gold value (RBI 2025 tiered) · upper range after agent verification
                </p>

                {region && !region.serviceable && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <p>Home pickup not available. Visit nearest Poonawalla Fincorp branch to submit your gold.</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {locationReady && !priceLoading && cumulativeItems.length > 0 && cityGoldValue > 0 && (
          <div className="final-cumulative-panel rounded-3xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-stone-500">Cumulative LTV result</p>
                <h2 className="mt-1 font-display text-xl font-black text-stone-950">{fmt(cumulativeLoanNow)}</h2>
                <p className="mt-1 text-xs font-semibold text-stone-500">
                  Up to {fmt(cumulativeLoanMax)} after verification
                </p>
              </div>
              <div className="rounded-2xl bg-stone-50 px-3 py-2 text-right">
                <p className="text-[10px] font-black uppercase tracking-wider text-stone-500">Total value</p>
                <p className="mt-0.5 text-xs font-black text-stone-900">{fmt(cumulativeGoldValue)}</p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {cumulativeItems.map(item => (
                <div key={item.id} className={clsx('final-cumulative-item rounded-2xl border p-3', item.isCurrent && 'is-current')}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-stone-900">{item.label}</p>
                      <p className="mt-0.5 text-[11px] font-semibold text-stone-500">
                        {item.purity}K - {item.weightG.toFixed(2)}g - value {fmt(item.goldValueInr)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-black text-stone-950 tabular-nums">{fmt(item.loanMaxInr)}</p>
                      <p className="text-[10px] font-semibold text-stone-400">loan cap</p>
                    </div>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-stone-950"
                      style={{ width: `${Math.max(8, Math.min(100, (item.loanMaxInr / Math.max(cumulativeLoanMax, 1)) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </main>

      {/* Sticky bottom CTA, matching dashboard-home */}
      <div
        className="sticky bottom-0 z-20 px-5 py-3 bg-white/90 backdrop-blur-xl border-t border-stone-200/70"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <button
          onClick={handleContinue}
          disabled={!canProceed}
          aria-label="Continue for Gold Loan"
          className={clsx(
            'w-full py-4 rounded-2xl bg-charcoal text-white font-display font-black text-base shadow-cta active:scale-[0.98] transition-transform flex items-center justify-center gap-2.5',
            !canProceed && 'opacity-40 cursor-not-allowed shadow-none'
          )}
        >
          {priceLoading ? <><Loader className="w-4 h-4 animate-spin" /> Loading city rate…</> : <>Continue for Gold Loan <ArrowRight className="w-5 h-5" /></>}
        </button>
        {!locationReady && <p className="text-center text-xs text-stone-400 mt-2">Select your city to load live gold rate</p>}
        {locationReady && !priceLoading && cityGoldValue === 0 && <p className="text-center text-xs text-amber-500 mt-2">Fetching gold rate…</p>}
      </div>
    </div>
  )
}
