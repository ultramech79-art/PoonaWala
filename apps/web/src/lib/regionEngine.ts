import regionsData from '../data/regions.json'

export type LocationTier = 'metro' | 'tier1' | 'tier2' | 'tier3' | 'rural'

export interface ResolvedRegion {
  state: string
  stateCode: string
  city: string
  tier: LocationTier
  tierLabel: string
  stampDutyInr: number
  serviceable: boolean
}

const TIER_LABELS: Record<LocationTier, string> = {
  metro:  'Metro City',
  tier1:  'Tier-1 City',
  tier2:  'Tier-2 City',
  tier3:  'Tier-3 Town',
  rural:  'Rural Area',
}

const SERVICEABLE_TIERS: LocationTier[] = ['metro', 'tier1', 'tier2']

export function getAllStates(): string[] {
  return regionsData.states.map(s => s.name).sort()
}

export function getCitiesForState(stateName: string): string[] {
  const state = regionsData.states.find(s => s.name === stateName)
  if (!state) return ['Other']
  return [...state.cities.map(c => c.name).sort(), 'Other']
}

export function resolveRegion(stateName: string, cityName: string): ResolvedRegion {
  const state = regionsData.states.find(s => s.name === stateName)

  if (!state) {
    return {
      state: stateName, stateCode: 'XX', city: cityName,
      tier: 'tier3', tierLabel: TIER_LABELS.tier3,
      stampDutyInr: 0, serviceable: false,
    }
  }

  const cityData = state.cities.find(c => c.name === cityName)
  const tier = ((cityData?.tier ?? state.default_tier) as LocationTier)

  return {
    state: state.name,
    stateCode: state.code,
    city: cityName,
    tier,
    tierLabel: TIER_LABELS[tier] ?? 'City',
    stampDutyInr: state.stamp_duty_flat_inr,
    serviceable: SERVICEABLE_TIERS.includes(tier),
  }
}
