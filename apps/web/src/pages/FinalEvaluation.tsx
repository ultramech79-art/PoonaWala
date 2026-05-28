import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '../store/session'
import {
  getAllStates, getCitiesForState, resolveRegion,
} from '../lib/regionEngine'
import { computeLTV } from '../lib/ltvEngine'
import { getCibilTierKey, getCibilTierInfo } from '../lib/roiEngine'
import { validatePAN, getPANKYCStatus, deriveScoreFromPAN } from '../lib/panEngine'
import { apiBase } from '../lib/api'
import loanParams from '../data/loan_params.json'
import {
  ChevronRight, ChevronDown, ChevronUp, MapPin,
  ArrowRight, CheckCircle, AlertTriangle, Info, Shield, CreditCard, Loader,
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

  if (!result || (result.routing !== 'INSTANT' && result.routing !== 'AGENT')) {
    navigate('/result')
    return null
  }

  // ── Location state ──────────────────────────────────────────────────────────
  const [selectedState, setSelectedState] = useState('')
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
  const hallmarkVisible = Boolean(result.purity.huid_verified || state.certificateData?.huid || state.huidCode)
  const weightVerified = result.weight.method === 'BILL_CERTIFICATE_OCR' || Boolean(state.certificateData?.weightG)

  // ── PAN + derived credit profile ────────────────────────────────────────────
  const [pan, setPan] = useState('')
  const panValidation = useMemo(() => validatePAN(pan), [pan])
  const derivedScore  = useMemo(() => deriveScoreFromPAN(pan), [pan])
  const cibilTierKey  = useMemo(() => getCibilTierKey(derivedScore), [derivedScore])
  const cibilInfo     = useMemo(() => getCibilTierInfo(cibilTierKey), [cibilTierKey])

  // ── LTV — gold quality only, no CIBIL/location ──────────────────────────────
  const ltvResult = useMemo(() => {
    if (!region || cityGoldValue === 0) return null
    return computeLTV({
      goldValueInr: cityGoldValue,
      karatEstimate: detectedKarat,
      aiConfidence: result.confidence.score,
      goldType: 'jewelry',
      hallmarkVisible,
      weightVerified,
    })
  }, [region, cityGoldValue, detectedKarat, result, hallmarkVisible, weightVerified])

  const kycStatus = useMemo(
    () => getPANKYCStatus(ltvResult?.maxLoanInr ?? 0),
    [ltvResult],
  )

  const [showBreakdown, setShowBreakdown] = useState(false)

  // ── Eligibility ──────────────────────────────────────────────────────────────
  const eligible = useMemo(() => {
    if (!region || !ltvResult) return false
    if (detectedKarat < loanParams.rbi_rules.min_purity_karat) return false
    if (result.weight.estimated_g > loanParams.rbi_rules.max_weight_per_applicant_kg * 1000) return false
    if (kycStatus.panRequired && pan.length === 10 && !panValidation.valid) return false
    return true
  }, [region, ltvResult, kycStatus, pan, panValidation, detectedKarat, result])

  const rejectReason = useMemo(() => {
    if (detectedKarat < loanParams.rbi_rules.min_purity_karat)
      return `Gold purity ${detectedKarat}K is below RBI minimum ${loanParams.rbi_rules.min_purity_karat}K`
    if (result.weight.estimated_g > loanParams.rbi_rules.max_weight_per_applicant_kg * 1000)
      return `Weight exceeds ${loanParams.rbi_rules.max_weight_per_applicant_kg}kg per-applicant limit`
    if (kycStatus.panRequired && pan.length === 10 && !panValidation.valid)
      return 'Valid PAN required for loans above ₹50,000'
    return null
  }, [detectedKarat, result, kycStatus, pan, panValidation])

  const locationReady = Boolean(region)
  const panReady      = !kycStatus.panRequired || panValidation.valid
  const canProceed    = locationReady && panReady && eligible && !priceLoading && cityGoldValue > 0

  function handleContinue() {
    if (!canProceed || !region || !ltvResult || !cityPrices) return
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
      maxLoanInr: ltvResult.maxLoanInr,
      provisionalLoanLowInr: ltvResult.provisionalLowLoanInr,
      ltvComponents: ltvResult.components,
      ltvProvisionalComponents: ltvResult.provisionalComponents,
      ticketTierLabel: ltvResult.ticketTierLabel,
      processingFeePct: cibilInfo.processing_fee_pct,
      eligible: true,
      rejectReason: null,
    })
    navigate('/gold-loan-app')
  }

  return (
    <div className="page overflow-y-auto no-scrollbar animate-fade-in bg-gradient-to-b from-[#FEFDFC] via-white to-amber-50/30">
      <div className="page-header">
        <button onClick={() => navigate('/result')} className="btn-icon">
          <ChevronRight className="w-5 h-5 rotate-180 text-stone-500" />
        </button>
        <span className="font-display font-semibold text-sm text-stone-700">Loan Eligibility</span>
        <div className="w-11" />
      </div>

      <div className="px-5 pb-24 space-y-4 pt-4">

        {/* Gold summary */}
        <div className="card p-4 border-amber-200 bg-amber-50/50">
          <p className="label mb-2 text-amber-700">Gold Assessment</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-display font-black text-xl text-stone-900">
                {detectedKarat}K · {result.weight.estimated_g.toFixed(1)}g
              </p>
              {cityGoldValue > 0 ? (
                <p className="text-xs text-stone-500 mt-0.5">
                  City value ~{fmt(cityGoldValue)}
                  {priceSource === 'timesofindia' && (
                    <span className="ml-1 text-emerald-600 font-medium">· live city rate</span>
                  )}
                  {priceSource === 'ibja_national' && (
                    <span className="ml-1 text-stone-400">· IBJA national</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-stone-400">Select city to load live rate…</p>
              )}
            </div>
            <div className="text-right">
              {result.purity.huid_verified && (
                <span className="badge-green text-[10px]"><CheckCircle className="w-3 h-3" /> HUID visible</span>
              )}
              {!result.purity.huid_verified && (
                <span className="text-[10px] bg-stone-100 text-stone-500 px-2 py-0.5 rounded-full font-semibold">Verification pending</span>
              )}
              <p className="text-xs text-stone-400 mt-1">AI conf. {Math.round(result.confidence.score * 100)}%</p>
            </div>
          </div>
        </div>

        {/* Step 1: Location */}
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
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
              <div className="rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-brand-600 flex-shrink-0" />
                    <span className="text-xs font-semibold text-stone-700">
                      {region.city}, {region.state}
                    </span>
                  </div>
                  <span className={clsx(
                    'text-[10px] font-semibold px-2 py-0.5 rounded-full',
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
                        'rounded-lg px-2 py-1.5 border',
                        highlight ? 'border-brand-300 bg-brand-50' : 'border-stone-100 bg-white',
                      )}
                    >
                      <p className={clsx('text-[10px]', highlight ? 'text-brand-600 font-semibold' : 'text-stone-400')}>
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
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-white">2</span>
            </div>
            <div className="flex-1 flex items-center justify-between">
              <p className="font-display font-semibold text-sm text-stone-900">PAN & Credit Profile</p>
              {kycStatus.panRequired
                ? <span className="text-[10px] text-brand-600 bg-brand-50 px-2 py-0.5 rounded-full font-medium">Required</span>
                : <span className="text-[10px] text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">Optional</span>
              }
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
              <p className="text-[10px] opacity-70">
                {cibilInfo.processing_fee_pct === 0
                  ? 'Processing fee waived'
                  : `Processing fee: ${cibilInfo.processing_fee_pct}%`}
              </p>
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

          {kycStatus.panRequired && (
            <p className="text-[10px] text-stone-500 mt-2 flex items-center gap-1">
              <Shield className="w-3 h-3" /> Mandatory above {fmt(loanParams.rbi_rules.pan_mandatory_above_inr)} (PMLA 2002)
            </p>
          )}
          {kycStatus.enhancedDDRequired && (
            <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
              <Info className="w-3 h-3" /> Enhanced due diligence required above {fmt(loanParams.rbi_rules.pmla_enhanced_dd_above_inr)}
            </p>
          )}
        </div>

        {/* Live Eligibility Card */}
        {locationReady && !priceLoading && ltvResult && cityGoldValue > 0 && (
          <div className={clsx('card p-5', eligible ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/40')}>
            <div className="flex items-center justify-between mb-3">
              <p className="font-display font-semibold text-sm text-stone-900">Your Eligibility</p>
              {eligible
                ? <span className="badge-green text-[10px]"><CheckCircle className="w-3 h-3" /> Eligible</span>
                : <span className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">Not Eligible</span>
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
                  <div className="bg-white rounded-xl p-3 border border-stone-200">
                    <p className="text-[10px] text-stone-400 mb-1">City Gold Value</p>
                    <p className="font-display font-black text-base text-stone-900">{fmt(cityGoldValue)}</p>
                    <p className="text-[10px] text-stone-400 mt-0.5">
                      ₹{Math.round(cityPriceForKarat).toLocaleString('en-IN')}/g · {detectedKarat}K
                    </p>
                  </div>
                  <div className="bg-white rounded-xl p-3 border border-stone-200">
                    <p className="text-[10px] text-stone-400 mb-1">
                      {ltvResult.provisionalLowLoanInr < ltvResult.maxLoanInr ? 'Provisional Loan Range' : `Max Loan (LTV ${ltvResult.finalLtvPct}%)`}
                    </p>
                    {ltvResult.provisionalLowLoanInr < ltvResult.maxLoanInr ? (
                      <>
                        <p className="font-display font-black text-base text-brand-600">
                          {fmt(ltvResult.provisionalLowLoanInr)} - {fmt(ltvResult.maxLoanInr)}
                        </p>
                        <p className="text-[10px] text-stone-400 mt-0.5">
                          {ltvResult.provisionalLowLtvPct}% - {ltvResult.finalLtvPct}% LTV
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="font-display font-black text-base text-brand-600">{fmt(ltvResult.maxLoanInr)}</p>
                        <p className="text-[10px] text-stone-400 mt-0.5">{ltvResult.ticketTierLabel}</p>
                      </>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setShowBreakdown(!showBreakdown)}
                  className="w-full flex items-center justify-between text-xs text-stone-600 bg-stone-50 rounded-lg px-3 py-2 border border-stone-200"
                >
                  <span className="font-medium">How is {ltvResult.finalLtvPct}% LTV calculated?</span>
                  {showBreakdown ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                {showBreakdown && (
                  <div className="mt-2 rounded-lg bg-white border border-stone-200 divide-y divide-stone-100 overflow-hidden">
                    {ltvResult.components.map((c, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2">
                        <span className="text-[11px] text-stone-600 flex-1">{c.label}</span>
                        <span className={clsx(
                          'text-[11px] font-mono font-semibold w-12 text-right',
                          c.deltaPct < 0 ? 'text-red-500' : c.deltaPct > 0 ? 'text-emerald-600' : 'text-stone-400',
                        )}>
                          {c.deltaPct === 0 ? '—' : `${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}%`}
                        </span>
                        <span className="text-[11px] font-bold text-stone-800 w-14 text-right">{c.runningPct}%</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between px-3 py-2 bg-brand-50">
                      <span className="text-xs font-bold text-brand-700">Upper LTV after verification</span>
                      <span className="text-sm font-black text-brand-600">{ltvResult.finalLtvPct}%</span>
                    </div>
                    {ltvResult.provisionalComponents.map((c, i) => (
                      <div key={`provisional-${i}`} className="flex items-center justify-between px-3 py-2 bg-amber-50">
                        <span className="text-[11px] text-amber-700 flex-1">{c.label}</span>
                        <span className="text-[11px] font-mono font-semibold text-amber-600 w-12 text-right">
                          {c.deltaPct}%
                        </span>
                        <span className="text-[11px] font-bold text-amber-700 w-14 text-right">{c.runningPct}%</span>
                      </div>
                    ))}
                    {ltvResult.provisionalLowLtvPct < ltvResult.finalLtvPct && (
                      <div className="flex items-center justify-between px-3 py-2 bg-amber-100">
                        <span className="text-xs font-bold text-amber-800">Provisional digital floor</span>
                        <span className="text-sm font-black text-amber-700">{ltvResult.provisionalLowLtvPct}%</span>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-[10px] text-stone-400 mt-2 text-center">
                  LTV is up to 75% of accepted gold value · Range can increase after agent verification
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

        {!panReady && locationReady && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-600">
            <CreditCard className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p>PAN is required for your loan amount. Enter a valid PAN above to continue.</p>
          </div>
        )}
      </div>

      {/* Sticky CTA */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md px-5 pb-6 pt-4 bg-white/90 backdrop-blur-sm border-t border-stone-200">
        <button
          onClick={handleContinue}
          disabled={!canProceed}
          className={clsx('btn-primary w-full', !canProceed && 'opacity-40 cursor-not-allowed')}
        >
          {priceLoading ? <><Loader className="w-4 h-4 animate-spin" /> Loading city rate…</> : <>Continue for Gold Loan <ArrowRight className="w-5 h-5" /></>}
        </button>
        {!locationReady && <p className="text-center text-xs text-stone-400 mt-2">Select your city to load live gold rate</p>}
        {locationReady && !priceLoading && cityGoldValue === 0 && <p className="text-center text-xs text-amber-500 mt-2">Fetching gold rate…</p>}
        {locationReady && !panReady && <p className="text-center text-xs text-stone-400 mt-2">Enter valid PAN to continue</p>}
      </div>
    </div>
  )
}
