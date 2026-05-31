import type { AssessmentResult, CaptureType, SessionState } from '../store/session'

const MAX_VIDEO_FRAMES = 11

type Route = AssessmentResult['routing']
type ModifierKind = 'multiplier' | 'ceiling'

/** One independently-scored evidence component (0..1) and its blend weight. */
export interface ComponentScore {
  id: string
  label: string
  score: number
  weight: number
  weighted: number
  detail: string
}

/** A fraud / hard rule applied AFTER the weighted blend of the components. */
export interface FraudModifier {
  id: string
  kind: ModifierKind
  active: boolean
  value: number
  detail: string
}

export interface ConfidenceEvidence {
  capturedTypes: string[]
  skippedTypes: string[]
  stillCoverage: number
  has45deg: boolean
  hasTop: boolean
  hasSide: boolean
  hasMacro: boolean
  hasSelfie: boolean
  selfieSkipped: boolean
  videoSkipped: boolean
  videoFrameCount: number
  videoFrameCoverage: number
  videoScore: number | null
  certificateSkipped: boolean
  billHuid: string
  currentHuid: string
  huidPresent: boolean
  huidVerified: boolean
  huidSource: 'photo' | 'manual' | 'bill' | null   // how the HUID was obtained
  huidVerifiedVia: 'photo' | 'manual' | null        // how a VERIFIED HUID was obtained
  manualHuidEntry: boolean                           // HUID was typed by hand
  photoHuidEvidence: boolean                         // HUID code was read from the hallmark photo
  photoKaratEvidence: boolean                        // karat (e.g. 18K/22K) was read from the photo
  billHuidMatch: boolean
  billHuidMismatch: boolean
  assessedItemType: string | null                    // item type being assessed (selected / BIS article)
  billItemTypeMatch: boolean                         // bill describes the same item type we're assessing
  usefulBillFields: number
  purityRange: number
  trustedWeightG: number | null
  weightDeltaRatio: number | null
  nonAudioTriggers: string[]
  sameItemMismatch: boolean
  hardMetalTrigger: boolean
  strongCounterEvidence: boolean
}

export interface ConfidenceComputation {
  score: number
  baseScore: number            // weighted blend of the components, before fraud modifiers
  route: Route
  evidence: ConfidenceEvidence
  components: ComponentScore[]  // every component scored individually
  modifiers: FraudModifier[]    // fraud / hard rules applied after the blend
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const normalizeHuid = (value?: string | null) =>
  (value ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase()

// Jewellery item-type keywords used to check whether a bill describes the same
// kind of item we're assessing (free-text OCR vs selected type / BIS article).
const ITEM_TYPE_KEYWORDS = [
  'ring', 'bangle', 'bracelet', 'kada', 'necklace', 'haar', 'choker', 'mangalsutra',
  'pendant', 'locket', 'chain', 'earring', 'jhumka', 'tops', 'nosepin', 'nose pin',
  'anklet', 'payal', 'coin', 'bar', 'bullion',
]
const itemTypesIn = (text: string) =>
  ITEM_TYPE_KEYWORDS.filter(keyword => text.includes(keyword))

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const bool = (value: unknown) => value === true

function videoFrameCount(state: SessionState): number {
  const video = state.captures.video
  const exif = video?.exif as Record<string, unknown> | undefined
  const frameCount = numberOrNull(exif?.videoFrameCount)
  const rawFrames = exif?.videoFramesDataUrl
  const frames = Array.isArray(rawFrames)
    ? rawFrames.filter((v): v is string => typeof v === 'string' && v.startsWith('data:image/'))
    : []
  return Math.max(frameCount ?? 0, frames.length, video?.dataUrl?.startsWith('data:image/') ? 1 : 0)
}

export function buildConfidenceEvidence(result: AssessmentResult, state: SessionState): ConfidenceEvidence {
  const capturedTypes = Object.keys(state.captures)
  const skippedTypes = Object.keys(state.skippedCaptures ?? {})
  const has = (type: CaptureType) => Boolean(state.captures[type])
  const stillViews = ['45deg', 'top', 'side', 'macro'] as const
  const stillCoverage = stillViews.filter(has).length / stillViews.length

  const huidEvidence = state.pageEvidence.huid ?? {}
  const certificateEvidence = state.pageEvidence.certificate ?? {}
  const videoEvidence = state.pageEvidence.video ?? {}
  const captureEvidence = state.pageEvidence.capture ?? {}

  const billHuid = normalizeHuid(state.certificateData?.huid ?? String(certificateEvidence.huid ?? ''))
  const currentHuid = normalizeHuid(state.huidCode ?? String(huidEvidence.code ?? ''))
  const huidStatus = String(state.huidVerification?.status ?? huidEvidence.status ?? '').toUpperCase()
  const huidVerified = Boolean(result.purity.huid_verified || huidStatus === 'VERIFIED')
  const huidPresent = Boolean(billHuid || currentHuid || result.purity.huid_verified)

  // HUID origin tracking — distinguishes a HUID READ FROM the hallmark photo from
  // one that was TYPED IN by hand (and how a verified HUID was obtained).
  const rawHuidSource = String(huidEvidence.source ?? '')
  const huidSource: ConfidenceEvidence['huidSource'] =
    rawHuidSource === 'photo' || rawHuidSource === 'photo_karat' ? 'photo' :
    rawHuidSource === 'manual' ? 'manual' :
    rawHuidSource === 'bill' ? 'bill' :
    billHuid && !currentHuid ? 'bill' :
    currentHuid ? 'manual' :
    null
  // HUID code read from the hallmark photo (binds the HUID to THIS physical item).
  const photoHuidEvidence = Boolean(rawHuidSource === 'photo' && currentHuid)
  const manualHuidEntry = Boolean(huidSource === 'manual' && currentHuid)
  const rawVerifiedVia = String(huidEvidence.verifiedVia ?? '')
  const huidVerifiedVia: ConfidenceEvidence['huidVerifiedVia'] = !huidVerified
    ? null
    : rawVerifiedVia === 'photo' ? 'photo'
    : rawVerifiedVia === 'manual' ? 'manual'
    : photoHuidEvidence ? 'photo'
    : 'manual'
  // Karat (e.g. 18K / 22K) read from the photo, even when the HUID code itself
  // could not be verified.
  const photoKaratEvidence = Boolean(
    bool(huidEvidence.photoKaratDetected) ||
    (state.scannedKarat && has('macro')) ||
    (numberOrNull(huidEvidence.photoKarat) && has('macro')),
  )
  const billComparisonHuid = currentHuid || normalizeHuid(state.huidVerification?.huid)
  const billHuidMatch = Boolean(billHuid && billComparisonHuid && billHuid === billComparisonHuid)
  const billHuidMismatch = Boolean(billHuid && billComparisonHuid && billHuid !== billComparisonHuid)

  // Item type being assessed (user-selected jewellery type and/or BIS article type)
  // vs the item type described on the bill. A match is positive corroboration.
  const weightEvidence = state.pageEvidence.weight ?? {}
  const assessedTypeText = `${String(weightEvidence.jewelryType ?? '')} ${String(state.huidVerification?.article_type ?? huidEvidence.articleType ?? '')}`.toLowerCase()
  const billTypeText = String(state.certificateData?.itemDescription ?? certificateEvidence.itemDescription ?? '').toLowerCase()
  const assessedTypes = itemTypesIn(assessedTypeText)
  const billTypes = itemTypesIn(billTypeText)
  const assessedItemType = assessedTypes[0] ?? null
  const billItemTypeMatch = Boolean(
    state.certificateData && assessedTypes.length && billTypes.some(keyword => assessedTypes.includes(keyword)),
  )

  const usefulBillFields = state.certificateData
    ? [
        state.certificateData.huid,
        state.certificateData.karat,
        state.certificateData.weightG,
        state.certificateData.itemDescription,
        state.certificateData.billNumber,
        state.certificateData.jewellerName,
        state.certificateData.purchaseDate,
      ].filter(Boolean).length
    : Number(numberOrNull(certificateEvidence.usefulFieldCount) ?? 0)

  const puritySources = [
    state.certificateData?.karat ?? null,
    state.scannedKarat,
    result.purity.point_estimate_karat,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  const purityRange = puritySources.length >= 2 ? Math.max(...puritySources) - Math.min(...puritySources) : 0

  const trustedWeightG = state.certificateData?.weightG ?? state.weightG ?? null
  const estimatedWeightG = result.weight.estimated_g
  const weightDeltaRatio = trustedWeightG && estimatedWeightG
    ? Math.abs(trustedWeightG - estimatedWeightG) / Math.max(trustedWeightG, estimatedWeightG, 1)
    : null

  const nonAudioTriggers = (result.fraud_signals.triggers ?? []).filter(
    trigger => !/audio|acoustic|tap/i.test(trigger),
  )
  const sameItemMismatch = Boolean(
    nonAudioTriggers.includes('same_item_mismatch') ||
    (captureEvidence.lastIssues as string[] | undefined)?.includes?.('same_item_mismatch') ||
    (videoEvidence.sameItem as { verdict?: string } | undefined)?.verdict === 'different',
  )
  const hardMetalTrigger = nonAudioTriggers.some(trigger =>
    ['plated_metal_suspected', 'non_gold_specular_signature'].includes(trigger),
  )
  const frames = videoFrameCount(state)
  const videoScore = state.liveAuthResult?.video_score ?? numberOrNull(videoEvidence.score)
  const strongCounterEvidence = Boolean(
    hardMetalTrigger &&
    stillCoverage >= 0.75 &&
    (videoScore ?? 0) >= 85 &&
    !sameItemMismatch,
  )

  return {
    capturedTypes,
    skippedTypes,
    stillCoverage,
    has45deg: has('45deg'),
    hasTop: has('top'),
    hasSide: has('side'),
    hasMacro: has('macro'),
    hasSelfie: has('selfie'),
    selfieSkipped: Boolean(state.skippedCaptures.selfie || bool(state.pageEvidence.selfie?.skipped)),
    videoSkipped: Boolean(state.skippedCaptures.video || bool(videoEvidence.skipped)),
    videoFrameCount: frames,
    videoFrameCoverage: clamp01(frames / MAX_VIDEO_FRAMES),
    videoScore,
    certificateSkipped: Boolean(state.skippedCaptures.certificate || bool(certificateEvidence.skipped)),
    billHuid,
    currentHuid,
    huidPresent,
    huidVerified,
    huidSource,
    huidVerifiedVia,
    manualHuidEntry,
    photoHuidEvidence,
    photoKaratEvidence,
    billHuidMatch,
    billHuidMismatch,
    assessedItemType,
    billItemTypeMatch,
    usefulBillFields,
    purityRange,
    trustedWeightG,
    weightDeltaRatio,
    nonAudioTriggers,
    sameItemMismatch,
    hardMetalTrigger,
    strongCounterEvidence,
  }
}

export function computeEvidenceConfidence(result: AssessmentResult, state: SessionState): ConfidenceComputation {
  const evidence = buildConfidenceEvidence(result, state)
  // ── Each evidence component is scored independently on 0..1, then blended ────

  // 1. Item photos: more angles = stronger geometry and anti-swap evidence.
  const imagesScore = clamp01(
    0.15 +
    (evidence.has45deg ? 0.28 : 0) +
    (evidence.hasTop ? 0.22 : 0) +
    (evidence.hasSide ? 0.16 : 0) +
    (evidence.hasMacro ? 0.22 : 0),
  )

  // 2. HUID identity — the single most decisive signal, scored by HOW the HUID was
  //    obtained. A hallmark PHOTO binds the HUID to THIS physical item, so a
  //    photo-read HUID scores high; a HUID merely TYPED IN (even BIS-verified) stays
  //    moderate unless a hallmark photo also exists. Every case is covered below.
  const huidScore =
    evidence.billHuidMismatch                       ? 0.05 :  // bill HUID contradicts entered HUID (fraud)
    evidence.photoHuidEvidence && evidence.huidVerified ? 0.98 :  // read from photo AND BIS-verified — best
    evidence.photoHuidEvidence                      ? 0.87 :  // read from photo (binds the item), not BIS-verified
    evidence.huidVerified && evidence.hasMacro      ? 0.90 :  // BIS-verified + a hallmark photo is present
    evidence.photoKaratEvidence                     ? 0.74 :  // karat (18K/22K) read from photo, HUID code not readable
    evidence.huidPresent && evidence.hasMacro       ? 0.72 :  // typed HUID + hallmark photo present (binds), unverified
    evidence.huidVerified                           ? 0.64 :  // manually typed + BIS-verified, NO hallmark photo
    evidence.billHuidMatch                          ? 0.62 :  // bill corroborates the typed HUID, no photo
    evidence.huidPresent                            ? 0.52 :  // typed HUID, unverified, no photo
    evidence.hasMacro                               ? 0.45 :  // hallmark photo present but nothing readable
    0.30                                                       // no HUID / hallmark evidence at all

  // 3. Purity agreement (hallmark / photo / bill / backend). A lone source is
  //    neutral; a big disagreement is low but, by its small weight, can't crater.
  //    A BIS-verified or photo-read HUID makes the karat authoritative, so the
  //    backend's (often photo-less) visual purity guess can't drag it down.
  const purityScore =
    evidence.huidVerified || evidence.photoHuidEvidence ? 0.85 :
    evidence.purityRange === 0 ? (evidence.photoKaratEvidence ? 0.85 : 0.60) :
    evidence.purityRange <= 0.75 ? 0.92 :
    evidence.purityRange <= 1.5 ? 0.78 :
    evidence.purityRange <= 3 ? 0.50 :
    0.28

  // 4. Weight agreement (bill / manual vs estimate); else visual-estimate quality.
  const visualBandWidthRatio = result.weight.estimated_g
    ? Math.abs(result.weight.band_high_g - result.weight.band_low_g) / Math.max(result.weight.estimated_g, 1)
    : 1
  const weightScore =
    evidence.weightDeltaRatio === null
      ? (state.pageEvidence.weight?.skipped
          ? 0.50
          : clamp01(0.55 + evidence.stillCoverage * 0.15 - Math.min(0.18, visualBandWidthRatio * 0.10)))
      : evidence.weightDeltaRatio <= 0.06 ? 0.95
      : evidence.weightDeltaRatio <= 0.14 ? 0.80
      : evidence.weightDeltaRatio <= 0.25 ? 0.55
      : 0.30

  // 5. Video authenticity test (video-only; audio excluded). Skipped = neutral.
  const videoScore =
    evidence.videoScore !== null ? clamp01(0.20 + (evidence.videoScore / 100) * 0.80) :
    evidence.videoSkipped ? 0.50 :
    evidence.videoFrameCount > 0 ? clamp01(0.45 + evidence.videoFrameCoverage * 0.30) :
    0.50

  // 6. Bill / certificate OCR. No bill is neutral (not a failure). A valid bill is
  //    strong corroboration, and a bill whose HUID matches the entered HUID is the
  //    strongest of all. The component's WEIGHT is raised accordingly below.
  const billScore =
    evidence.billHuidMismatch ? 0.08 :
    !state.certificateData ? (evidence.certificateSkipped ? 0.50 : 0.55) :
    clamp01(
      0.42 +
      (state.certificateData.confidence ?? 0) * 0.30 +
      Math.min(0.20, evidence.usefulBillFields * 0.035) +
      (evidence.billHuidMatch ? 0.16 : 0) +                 // bill HUID matches entered HUID
      (evidence.billItemTypeMatch ? 0.10 : 0) +             // bill describes the same item type
      (state.certificateData.authenticityFound ? 0.08 : -0.04),
    )
  // A "valid" bill has real OCR content and isn't contradicting the entered HUID.
  const billValid = Boolean(state.certificateData) && evidence.usefulBillFields >= 3 && !evidence.billHuidMismatch
  // Dynamic weight: a valid bill earns more say; a matching HUID earns the most; a
  // matching item type adds to it; a contradicting bill is trusted least (the
  // mismatch itself is penalised separately by the fraud multiplier).
  const billWeight =
    evidence.billHuidMismatch              ? 0.04 :  // bill HUID contradicts the entered HUID → trust it least
    billValid && evidence.billHuidMatch    ? 0.16 :  // valid bill whose HUID matches the entered HUID → strongest
    billValid && evidence.billItemTypeMatch ? 0.14 : // valid bill describing the same item type → strong
    billValid                              ? 0.12 :  // valid bill present → higher say
    0.06                                              // no / thin bill → low, neutral say

  // 7. Selfie (face). Skipped = neutral; with the small weight below, skipping the
  //    face only slightly reduces the final score.
  const selfieScore =
    evidence.hasSelfie ? 0.85 :
    evidence.selfieSkipped ? 0.50 :
    0.60

  // 8. Same-item consistency across the captured stages.
  const sameItemScore =
    evidence.sameItemMismatch ? 0.05 :
    evidence.stillCoverage >= 0.75 && evidence.videoFrameCoverage >= 0.6 ? 0.95 :
    evidence.stillCoverage >= 0.75 ? 0.88 :
    evidence.stillCoverage >= 0.5 ? 0.70 :
    0.55

  // Weights reflect each signal's decisiveness for a gold-loan assessment. HUID
  // identity dominates; photos are next (physical proof + they enable purity/weight/
  // same-item); the rest corroborate. The bill weight is DYNAMIC (see billWeight):
  // a valid / HUID-matching bill earns more say, so the total isn't fixed at 1.00 —
  // the blend normalises by the actual sum of weights.
  const componentDefs = [
    { id: 'huid',      label: 'HUID identity',                       score: huidScore,     weight: 0.30, detail: 'manual / photo / BIS / bill HUID — photo-bound = high' },
    { id: 'images',    label: 'Item photos (45°, top, side, macro)', score: imagesScore,   weight: 0.20, detail: 'angle coverage of the still photos' },
    { id: 'video',     label: 'Video authenticity test',             score: videoScore,    weight: 0.12, detail: 'video-only score; audio excluded' },
    { id: 'purity',    label: 'Purity (karat) agreement',            score: purityScore,   weight: 0.12, detail: 'karat across hallmark / photo / bill / backend' },
    { id: 'weight',    label: 'Weight agreement',                    score: weightScore,   weight: 0.10, detail: 'bill / manual vs estimated weight' },
    { id: 'bill',      label: 'Bill / certificate',                  score: billScore,     weight: billWeight, detail: 'bill OCR fields + HUID cross-check (dynamic weight: valid/matching bill counts more)' },
    { id: 'selfie',    label: 'Selfie (face) capture',               score: selfieScore,   weight: 0.05, detail: 'borrower selfie with the gold' },
    { id: 'same_item', label: 'Same-item consistency',               score: sameItemScore, weight: 0.05, detail: 'same jewellery across all stages' },
  ]

  const weightTotal = componentDefs.reduce((sum, component) => sum + component.weight, 0) || 1
  const components: ComponentScore[] = componentDefs.map(component => ({
    ...component,
    weighted: Math.round((component.score * component.weight / weightTotal) * 1000) / 1000,
  }))
  const baseScore = components.reduce((sum, component) => sum + component.score * component.weight, 0) / weightTotal

  // ── A small set of fraud / hard rules applied AFTER the blend ───────────────
  // Multipliers dampen the blend for genuine fraud; one ceiling keeps a HUID with
  // no hallmark photo out of the "high" band. There are no stacked floors/caps —
  // the rough target scores come from the component scores and weights above.
  //
  // The no-hallmark-photo ceiling is RAISED by a valid bill, because a bill (and
  // especially one whose HUID matches the entered HUID) corroborates identity even
  // without a hallmark photo. It still stays below the INSTANT threshold (0.75).
  const noHallmarkPhotoCeiling =
    billValid && evidence.billHuidMatch     ? 0.74 :  // valid bill whose HUID matches → strongest corroboration
    billValid && evidence.billItemTypeMatch ? 0.72 :  // valid bill describing the same item type
    billValid                               ? 0.70 :  // valid bill present
    0.64                                               // no corroborating bill
  const modifiers: FraudModifier[] = [
    { id: 'same_item_mismatch', kind: 'multiplier', active: evidence.sameItemMismatch, value: 0.30, detail: 'different jewellery detected across stages' },
    { id: 'bill_huid_mismatch', kind: 'multiplier', active: evidence.billHuidMismatch, value: 0.45, detail: 'bill HUID contradicts the entered / scanned HUID' },
    { id: 'metal_warning', kind: 'multiplier', active: evidence.hardMetalTrigger, value: evidence.strongCounterEvidence ? 0.92 : 0.66, detail: 'visual plated / non-gold warning' },
    { id: 'no_hallmark_photo_ceiling', kind: 'ceiling', active: evidence.huidPresent && !evidence.hasMacro && !evidence.photoHuidEvidence, value: noHallmarkPhotoCeiling, detail: 'HUID with no hallmark photo stays moderate (raised by a valid / HUID-matching bill)' },
  ]

  let adjusted = baseScore
  for (const modifier of modifiers) {
    if (!modifier.active) continue
    adjusted = modifier.kind === 'multiplier' ? adjusted * modifier.value : Math.min(adjusted, modifier.value)
  }
  const score = Math.round(clamp01(adjusted) * 1000) / 1000

  return {
    score,
    baseScore: Math.round(baseScore * 1000) / 1000,
    route: routeFromConfidence(score, evidence),
    evidence,
    components,
    modifiers,
  }
}

export function routeFromConfidence(score: number, evidence: ConfidenceEvidence): Route {
  return [
    { route: 'REJECT' as Route, active: evidence.sameItemMismatch || evidence.billHuidMismatch },
    { route: 'INSTANT' as Route, active: evidence.huidVerified && score > 0.75 && !evidence.hardMetalTrigger },
    { route: 'AGENT' as Route, active: score > 0.47 },
    { route: 'RECAPTURE' as Route, active: score > 0.40 },
    { route: 'REJECT' as Route, active: true },
  ].find(rule => rule.active)!.route
}
