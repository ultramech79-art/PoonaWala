import type { AssessmentResult, CaptureType, SessionState } from '../store/session'

const MAX_VIDEO_FRAMES = 11

type Route = AssessmentResult['routing']
type ModifierKind = 'multiplier' | 'ceiling' | 'floor'

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
  billComparisonHuid: string                         // INDEPENDENT item HUID the bill is matched against (empty = none / bill-sourced)
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
  audioPlated: boolean                               // tap/acoustic test suggests plating or imitation
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
  // A HUID is "verified" ONLY via a genuine BIS verification (the HUID verifier
  // returns status VERIFIED). The backend's result.purity.huid_verified is NOT a
  // real verification — it is derived from a local purity/karat-MARK heuristic
  // (s1.purity_mark, a colour-based karat guess) and reads true even when no HUID
  // exists, so it is deliberately NOT trusted here.
  const huidVerified = huidStatus === 'VERIFIED'
  const huidPresent = Boolean(billHuid || currentHuid || huidVerified)

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
  // Karat (e.g. 18K / 22K) ACTUALLY READ FROM the hallmark photo by OCR — NOT a
  // manually-selected karat. Manual selection is just a purity claim (feeds
  // purityRange); only a genuine OCR read counts as photo-bound karat evidence.
  const photoKaratEvidence = Boolean(
    bool(huidEvidence.photoKaratDetected) ||
    numberOrNull(huidEvidence.photoKarat),
  )
  // ── Bill HUID cross-check ──────────────────────────────────────────────────
  // To "match", the bill HUID must equal an INDEPENDENT item HUID — one that came
  // from the ITEM itself: read from the hallmark photo (source 'photo'), typed by
  // hand (source 'manual'), or BIS-verified (huidVerification.huid). It must NOT
  // be a HUID the bill itself supplied: CertificateScan can copy the bill HUID
  // into state.huidCode when the item had none, and comparing the bill against a
  // value the bill provided is a meaningless self-match (a false boost). So we
  // explicitly exclude bill-sourced HUIDs from the comparison value.
  const independentItemHuid =
    (rawHuidSource === 'photo' || rawHuidSource === 'manual')
      ? normalizeHuid(String(huidEvidence.code ?? ''))
      : ''
  const billComparisonHuid =
    independentItemHuid ||
    normalizeHuid(state.huidVerification?.huid) ||
    (huidSource !== 'bill' && rawHuidSource !== 'bill' ? currentHuid : '')
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
  // Audio (tap) test plated detection. The acoustic test is otherwise excluded
  // from the blend, but a "plated / imitation" verdict is a specific authenticity
  // red flag that must dampen the final score and force manual verification.
  const audioVerdictText = `${state.tapTestResult?.label ?? ''} ${state.tapTestResult?.reasoning ?? ''} ${String((state.pageEvidence.audio as { verdict?: string } | undefined)?.verdict ?? '')}`.toLowerCase()
  const audioPlated = /plated|imitation/.test(audioVerdictText)

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
    billComparisonHuid,
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
    audioPlated,
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
  // Ranking the user asked for: PHOTO-OCR HUID is the strongest; a TYPED HUID that
  // gets BIS-verified is also good but ranks BELOW photo-OCR; OCR-read karat is high;
  // a manually-selected karat (no OCR) gets no identity credit here.
  const huidScore =
    evidence.billHuidMismatch                       ? 0.05 :  // bill HUID contradicts entered HUID (fraud)
    evidence.photoHuidEvidence && evidence.huidVerified ? 1.00 :  // OCR-read HUID + BIS — strongest
    evidence.photoHuidEvidence && evidence.billHuidMatch ? 0.93 : // OCR-read HUID corroborated by the bill
    evidence.photoHuidEvidence                      ? 0.85 :  // HUID OCR-read from photo, no BIS/bill — strong but not 90+

    evidence.huidVerified && evidence.hasMacro      ? 0.88 :  // typed + BIS-verified + hallmark photo (below photo-OCR)
    evidence.photoKaratEvidence                     ? 0.84 :  // karat (18K/22K) OCR-read from photo
    evidence.huidVerified                           ? 0.80 :  // typed + BIS-verified, no photo — good, below photo-OCR
    evidence.huidPresent && evidence.hasMacro       ? 0.72 :  // typed HUID + hallmark photo, unverified
    evidence.billHuidMatch                          ? 0.66 :  // bill corroborates the typed HUID, no photo
    evidence.huidPresent                            ? 0.54 :  // typed HUID, unverified, no photo
    evidence.hasMacro                               ? 0.45 :  // hallmark photo present but nothing readable
    0.30                                                       // no HUID / hallmark evidence at all

  // 3. Purity agreement (hallmark / photo / bill / backend). A lone source is
  //    neutral; a big disagreement is low but, by its small weight, can't crater.
  //    A BIS-verified or photo-read HUID makes the karat authoritative, so the
  //    backend's (often photo-less) visual purity guess can't drag it down.
  const purityScore =
    evidence.photoHuidEvidence && evidence.huidVerified ? 0.96 :
    evidence.huidVerified || evidence.photoHuidEvidence ? 0.92 :
    evidence.purityRange === 0 ? (evidence.photoKaratEvidence ? 0.90 : 0.60) :
    evidence.purityRange <= 0.75 ? 0.92 :
    evidence.purityRange <= 1.5 ? 0.78 :
    evidence.purityRange <= 3 ? 0.50 :
    0.28

  // 4. Weight agreement (bill / manual vs estimate); else visual-estimate quality.
  const visualBandWidthRatio = result.weight.estimated_g
    ? Math.abs(result.weight.band_high_g - result.weight.band_low_g) / Math.max(result.weight.estimated_g, 1)
    : 1
  const photoHallmarkEvidence = evidence.photoHuidEvidence || evidence.photoKaratEvidence
  const visualWeightBase = evidence.huidVerified || photoHallmarkEvidence ? 0.68 : 0.55
  const visualWeightScore = clamp01(
    visualWeightBase +
    evidence.stillCoverage * 0.14 -
    Math.min(0.14, visualBandWidthRatio * 0.08),
  )
  const weightScore =
    evidence.weightDeltaRatio === null
      ? (state.pageEvidence.weight?.skipped
          ? (evidence.huidVerified || photoHallmarkEvidence ? 0.62 : 0.50)
          : visualWeightScore)
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
    evidence.hasSelfie ? 0.92 :
    evidence.selfieSkipped ? 0.50 :
    0.60

  // 8. Same-item consistency across the captured stages.
  const sameItemScore =
    evidence.sameItemMismatch ? 0.05 :
    evidence.stillCoverage >= 0.75 && evidence.videoFrameCoverage >= 0.6 ? 0.97 :
    evidence.stillCoverage >= 0.75 ? 0.78 :   // stills only, no video cross-check
    evidence.stillCoverage >= 0.5 ? 0.65 :
    0.55

  // Weights reflect each signal's decisiveness for a gold-loan assessment. HUID
  // identity dominates; photos are next (physical proof + they enable purity/weight/
  // same-item); the rest corroborate. The bill weight is DYNAMIC (see billWeight):
  // a valid / HUID-matching bill earns more say, so the total isn't fixed at 1.00 —
  // the blend normalises by the actual sum of weights.
  //
  // FIX A — skipped captures carry ZERO weight so they don't dilute the average.
  // A component that was explicitly skipped is excluded from the denominator entirely:
  // it neither drags the score toward 0.50 nor inflates it — it simply doesn't vote.
  // Only the components that were actually attempted or are "always present" (HUID,
  // images, purity, same-item) are included in the denominator.
  const videoAttempted = evidence.videoScore !== null || evidence.videoFrameCount > 0
  const videoWeight  = evidence.videoSkipped || !videoAttempted ? 0 : 0.12
  const selfieWeight = evidence.selfieSkipped || !evidence.hasSelfie ? 0 : 0.05
  // Bill/certificate is optional. If skipped or absent, it does not vote; a real
  // uploaded bill still gets dynamic weight.
  const billWeightInBlend = state.certificateData || evidence.billHuidMismatch ? billWeight : 0
  const componentDefs = [
    { id: 'huid',      label: 'HUID identity',                       score: huidScore,     weight: 0.30,         detail: 'manual / photo / BIS / bill HUID — photo-bound = high' },
    { id: 'images',    label: 'Item photos (45°, top, side, macro)', score: imagesScore,   weight: 0.20,         detail: 'angle coverage of the still photos' },
    { id: 'video',     label: 'Video authenticity test',             score: videoScore,    weight: videoWeight,  detail: 'video-only score; audio excluded (0 weight when skipped)' },
    { id: 'purity',    label: 'Purity (karat) agreement',            score: purityScore,   weight: 0.12,         detail: 'karat across hallmark / photo / bill / backend' },
    { id: 'weight',    label: 'Weight agreement',                    score: weightScore,   weight: 0.10,         detail: 'bill / manual vs estimated weight' },
    { id: 'bill',      label: 'Bill / certificate',                  score: billScore,     weight: billWeightInBlend, detail: billWeightInBlend > 0 ? 'bill OCR fields + HUID cross-check (dynamic weight: valid/matching bill counts more)' : 'skipped / not uploaded; omitted from confidence blend' },
    { id: 'selfie',    label: 'Selfie (face) capture',               score: selfieScore,   weight: selfieWeight, detail: 'borrower selfie with the gold (0 weight when skipped)' },
    { id: 'same_item', label: 'Same-item consistency',               score: sameItemScore, weight: 0.05,         detail: 'same jewellery across all stages' },
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
  // FIX C — no-hallmark-photo ceiling is corroboration-aware but intentionally
  // stays around 80%. Photo-bound HUID + matching bill can go >90; no-photo cases
  // need bill/video/selfie corroboration to reach ~80, not 95.
  const goodVideoEvidence = Boolean(
    (evidence.videoScore !== null && evidence.videoScore >= 85) ||
    evidence.videoFrameCoverage >= 0.6,
  )
  const noHallmarkPhotoCeiling = Math.min(
    0.82,
    0.64 +
      (billValid ? 0.06 : 0) +
      (billValid && evidence.billHuidMatch ? 0.02 : 0) +
      (billValid && evidence.billItemTypeMatch ? 0.02 : 0) +
      (goodVideoEvidence ? 0.06 : 0) +
      (evidence.hasSelfie ? 0.04 : 0),
  )
  // ── Identity is the dominant driver (this is Fix A's intent for strong cases) ─
  // A strong identity signal — verified / photo-read HUID, photo-detected karat, or
  // a bill HUID match — sets a FLOOR that skipped or missing corroboration cannot
  // drag below. Genuine fraud disables the floor (0) and is crushed by the
  // multipliers below.
  const hardMismatch = evidence.sameItemMismatch || evidence.billHuidMismatch
  const identityFloor =
    hardMismatch                                          ? 0 :
    evidence.photoHuidEvidence && evidence.billHuidMatch  ? 0.94 :  // bill HUID == photo-read HUID → >90
    evidence.photoHuidEvidence && evidence.huidVerified   ? 0.93 :  // photo-read HUID + BIS
    evidence.photoHuidEvidence                            ? 0.85 :  // HUID OCR-read, no BIS/bill — strong but reserve 90+ for verified/corroborated
    evidence.huidVerified && evidence.hasMacro            ? 0.86 :  // typed + BIS-verified + hallmark photo (below photo-OCR)
    evidence.photoKaratEvidence                           ? 0.80 :  // hallmark photo OCR-detected the karat → ~80% on its own
    evidence.billHuidMatch && evidence.hasMacro           ? 0.84 :  // bill HUID match + hallmark photo
    evidence.huidVerified                                 ? 0.80 :  // typed + BIS-verified, no photo — good, just below photo-OCR
    evidence.billHuidMatch && billValid && goodVideoEvidence && evidence.hasSelfie ? 0.80 : // no-photo but well corroborated
    evidence.billHuidMatch                                ? 0.76 :  // bill HUID matches typed HUID (no photo)
    evidence.huidPresent && evidence.hasMacro             ? 0.70 :  // typed HUID + hallmark photo, unverified
    0                                                                // no strong identity → no floor

  // No identity / purity established at all (just photos) → cannot exceed moderate,
  // even if a video/selfie were captured. Only EVIDENCE-BACKED karat lifts this:
  // a HUID, an OCR-read karat from the hallmark photo, or a bill karat. A manually
  // SELECTED karat is just a claim (not proof) and must NOT escape this cap.
  const noIdentity =
    !evidence.huidPresent &&
    !evidence.photoKaratEvidence &&
    (state.certificateData?.karat ?? null) == null

  // NOTE: The visual plated / non-gold "metal_warning" multiplier was REMOVED on
  // purpose. Authenticity (real gold vs plated/fake) is handled by the VIDEO
  // authenticity test, which already votes as its own weighted component above —
  // so applying an extra ML fraud multiplier here double-counted it AND fired on
  // an unreliable S7 VLM fallback (the convnext_plated_solid model is absent),
  // cratering clearly-hallmarked items. We do NOT add backend fraud_signals
  // (plated_metal_suspected / non_gold_specular_signature) into the score.
  // The remaining two multipliers are deterministic INTEGRITY contradictions, not
  // ML fraud guesses: a different item across stages, or a bill HUID that
  // contradicts the item HUID. They also drive REJECT routing.
  const modifiers: FraudModifier[] = [
    { id: 'identity_floor', kind: 'floor', active: identityFloor > 0, value: identityFloor, detail: 'strong HUID / hallmark / photo-karat identity sets a minimum — skipped captures cannot drag below it' },
    { id: 'same_item_mismatch', kind: 'multiplier', active: evidence.sameItemMismatch, value: 0.30, detail: 'different jewellery detected across stages' },
    { id: 'bill_huid_mismatch', kind: 'multiplier', active: evidence.billHuidMismatch, value: 0.45, detail: 'bill HUID contradicts the entered / scanned HUID' },
    { id: 'audio_plated', kind: 'multiplier', active: evidence.audioPlated, value: 0.92, detail: 'tap/acoustic test hints at possible plating — NOT conclusive, so only a small ~8% caution reduction; routed to manual agent verification' },
    { id: 'no_hallmark_photo_ceiling', kind: 'ceiling', active: evidence.huidPresent && !evidence.hasMacro && !evidence.photoHuidEvidence && !evidence.huidVerified, value: noHallmarkPhotoCeiling, detail: 'unverified HUID with no hallmark photo — ceiling raised by corroboration; BIS verification removes this cap' },
    { id: 'no_identity_ceiling', kind: 'ceiling', active: noIdentity, value: 0.47, detail: 'no HUID / karat established — photos alone cannot exceed ~47%; routed to manual agent verification' },
  ]

  // Apply in order: identity FLOOR lifts → fraud MULTIPLIERS crush → CEILINGS cap.
  let adjusted = baseScore
  for (const modifier of modifiers) {
    if (!modifier.active) continue
    if (modifier.kind === 'floor') adjusted = Math.max(adjusted, modifier.value)
    else if (modifier.kind === 'multiplier') adjusted = adjusted * modifier.value
    else adjusted = Math.min(adjusted, modifier.value)
  }
  const score = Math.round(Math.min(0.95, clamp01(adjusted)) * 1000) / 1000
  const route = routeFromConfidence(score, evidence)

  logConfidenceComputation({ evidence, components, modifiers, baseScore, score, route, weightTotal })

  return {
    score,
    baseScore: Math.round(baseScore * 1000) / 1000,
    route,
    evidence,
    components,
    modifiers,
  }
}

// ── Debug logging ────────────────────────────────────────────────────────────
// Set `localStorage.setItem('goldeye_debug_confidence', '0')` to silence, or
// '1' (default) to print the full confidence breakdown on every computation.
function confidenceDebugEnabled(): boolean {
  try {
    return localStorage.getItem('goldeye_debug_confidence') !== '0'
  } catch {
    return true
  }
}

function logConfidenceComputation(args: {
  evidence: ConfidenceEvidence
  components: ComponentScore[]
  modifiers: FraudModifier[]
  baseScore: number
  score: number
  route: Route
  weightTotal: number
}) {
  if (!confidenceDebugEnabled()) return
  const { evidence: e, components, modifiers, baseScore, score, route, weightTotal } = args
  const pct = (v: number) => `${Math.round(v * 100)}%`
  /* eslint-disable no-console */
  console.group(`%c[Confidence] final=${pct(score)} base=${pct(baseScore)} route=${route}`, 'color:#7c3aed;font-weight:bold')

  console.group('%c1. HUID / KARAT IDENTITY (the dominant signal)', 'color:#b8860b;font-weight:bold')
  console.table({
    currentHuid: e.currentHuid || '(none)',
    billHuid: e.billHuid || '(none)',
    huidPresent: e.huidPresent,
    huidVerified: e.huidVerified,
    huidSource: e.huidSource,
    huidVerifiedVia: e.huidVerifiedVia,
    manualHuidEntry: e.manualHuidEntry,
    'photoHuidEvidence (HUID read from photo)': e.photoHuidEvidence,
    'photoKaratEvidence (karat read from photo)': e.photoKaratEvidence,
    hasMacro: e.hasMacro,
  })
  if (!e.photoHuidEvidence && !e.photoKaratEvidence && !e.huidVerified) {
    console.log('%c⚠ No strong hallmark identity. If you DID do photo OCR and saw 18K/22K detected, check:', 'color:#d97706')
    console.log('   • backend macro logs: "macro detected normalized: ... karat_detected=true"')
    console.log('   • CaptureFlow MACRO log: "✓ pageEvidence.huid set: photoKaratDetected=true"')
    console.log('   • If both show detected but this is false → pageEvidence.huid was cleared/overwritten before scoring')
  }
  console.groupEnd()

  console.group('%c2. BILL / CERTIFICATE CROSS-CHECK', 'color:#0a7;font-weight:bold')
  console.table({
    billHuid: e.billHuid || '(none)',
    'independent item HUID (matched against)': e.billComparisonHuid || '(none — no photo/typed/verified HUID)',
    'billHuidMatch (boost)': e.billHuidMatch,
    'billHuidMismatch (fraud)': e.billHuidMismatch,
    assessedItemType: e.assessedItemType ?? '(unknown)',
    billItemTypeMatch: e.billItemTypeMatch,
    usefulBillFields: e.usefulBillFields,
  })
  if (e.billHuid && !e.billComparisonHuid) {
    console.log('%c… Bill has a HUID but there is no INDEPENDENT item HUID to match it against (capture/type the HUID, or BIS-verify). No self-match is counted.', 'color:#d97706')
  }
  console.groupEnd()

  console.group('%c3. COMPONENT SCORES (score × weight, normalized by Σweight=' + weightTotal.toFixed(2) + ')', 'color:#2563eb;font-weight:bold')
  console.table(
    components.reduce((acc, c) => {
      acc[c.label] = {
        score: pct(c.score),
        weight: c.weight,
        weighted: c.weighted,
        active: c.weight > 0 ? 'yes' : 'SKIPPED (0 weight)',
      }
      return acc
    }, {} as Record<string, unknown>),
  )
  console.groupEnd()

  console.group('%c4. FRAUD / HARD MODIFIERS (applied after the blend)', 'color:#dc2626;font-weight:bold')
  const activeMods = modifiers.filter(m => m.active)
  if (activeMods.length === 0) {
    console.log('none active')
  } else {
    console.table(
      activeMods.reduce((acc, m) => {
        acc[m.id] = { kind: m.kind, value: m.value, detail: m.detail }
        return acc
      }, {} as Record<string, unknown>),
    )
  }
  console.log(`base ${pct(baseScore)} → (floor/multiplier/ceiling) → final ${pct(score)}`)
  console.groupEnd()

  console.groupEnd()
  /* eslint-enable no-console */
}

export function routeFromConfidence(score: number, evidence: ConfidenceEvidence): Route {
  return [
    { route: 'REJECT' as Route, active: evidence.sameItemMismatch || evidence.billHuidMismatch },
    // A possible-plating acoustic verdict is never an instant approval — it always
    // prefers manual agent verification (we are not certain it is plated).
    { route: 'INSTANT' as Route, active: evidence.huidVerified && score > 0.75 && !evidence.hardMetalTrigger && !evidence.audioPlated },
    // Plated suspicion routes to a human agent even if the small caution reduction
    // dips the score just below the normal AGENT cutoff.
    { route: 'AGENT' as Route, active: score >= 0.47 || (evidence.audioPlated && score > 0.40) },
    { route: 'RECAPTURE' as Route, active: score > 0.40 },
    { route: 'REJECT' as Route, active: true },
  ].find(rule => rule.active)!.route
}
