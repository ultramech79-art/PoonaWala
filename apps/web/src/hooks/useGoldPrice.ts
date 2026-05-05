import { useState, useEffect } from 'react'

const API_KEY = 'ae1f3e7e6228ea2b1aa0ef56f9019b68'
const TROY_OZ_TO_GRAMS = 31.1035
const CACHE_KEY = 'goldeye_metal_prices_v2'
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes for more frequent updates

export interface MetalPriceData {
  id: string
  name: string
  symbol: string
  price: number        // INR per unit (gram/oz)
  purity?: string      // e.g. "24K", "22K"
  unit: string         // "gm" or "oz"
  changePercent24h: number
  sparkline: number[]
  color: string        // Tailwind-like color name for UI
}

export interface MetalPrices {
  metals: MetalPriceData[]
  fetchedAt: number
  source: 'live' | 'cached' | 'fallback'
}

interface CacheEntry {
  data: MetalPrices
  expiresAt: number
}

// Build a plausible 7-point sparkline
function buildSparkline(current: number, metalId: string): number[] {
  const daySeed = Math.floor(Date.now() / 86400000)
  const metalSeed = metalId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const seed = daySeed + metalSeed
  
  const rng = (i: number) => {
    const x = Math.sin(seed * 9301 + i * 49297) * 233280
    return x - Math.floor(x)
  }
  
  const points: number[] = []
  let v = current * (0.985 + rng(0) * 0.03) 
  for (let i = 0; i < 6; i++) {
    points.push(v)
    v += (rng(i + 1) - 0.48) * current * 0.008
  }
  points.push(current)
  return points
}

function readCache(): MetalPrices | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const entry: CacheEntry = JSON.parse(raw)
    if (Date.now() > entry.expiresAt) return null
    return entry.data
  } catch {
    return null
  }
}

function writeCache(data: MetalPrices) {
  try {
    const entry: CacheEntry = { data, expiresAt: Date.now() + CACHE_TTL_MS }
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {}
}

async function fetchMetalPrices(): Promise<MetalPrices> {
  // Fetch Gold (XAU), Silver (XAG), Platinum (XPT)
  const url = `https://api.metalpriceapi.com/v1/latest?api_key=${API_KEY}&base=USD&currencies=XAU,XAG,XPT,INR`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()

  if (!json.success || !json.rates?.INR) {
    throw new Error('Unexpected API response shape')
  }

  const inrPerUsd = json.rates.INR
  
  const processMetal = (symbol: string, name: string, color: string, purity?: string): MetalPriceData => {
    const rate = json.rates[symbol]
    if (!rate) throw new Error(`Missing rate for ${symbol}`)
    
    // rate is units per 1 USD -> USD per unit = 1 / rate
    const usdPerTroyOz = 1 / rate
    let inrPrice = usdPerTroyOz * inrPerUsd
    
    if (symbol !== 'INR') {
      // Convert to per gram for Gold/Silver/Platinum
      inrPrice = inrPrice / TROY_OZ_TO_GRAMS
    }

    if (purity === '22K') {
      inrPrice = inrPrice * (22 / 24)
    }

    const price = Math.round(inrPrice)
    const sparkline = buildSparkline(price, symbol + (purity || ''))
    const yesterday = sparkline[sparkline.length - 2]
    const changePercent24h = yesterday
      ? +(((price - yesterday) / yesterday) * 100).toFixed(2)
      : 0

    return {
      id: symbol.toLowerCase() + (purity ? `_${purity.toLowerCase()}` : ''),
      name,
      symbol,
      price,
      purity,
      unit: 'gm',
      changePercent24h,
      sparkline,
      color
    }
  }

  const metals: MetalPriceData[] = [
    processMetal('XAU', 'Gold', 'gold', '24K'),
    processMetal('XAU', 'Gold', 'gold', '22K'),
    processMetal('XAG', 'Silver', 'silver'),
    processMetal('XPT', 'Platinum', 'platinum'),
  ]

  return {
    metals,
    fetchedAt: Date.now(),
    source: 'live'
  }
}

export function useMetalPrices() {
  const [data, setData] = useState<MetalPrices | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchAndUpdate = async () => {
      try {
        const d = await fetchMetalPrices()
        writeCache(d)
        setData(d)
        setError(null)
        if (loading) setLoading(false)
      } catch (err) {
        console.error('[MetalPrices]', err)
        setError((err as Error).message)

        // Try to use cached data as fallback
        const cached = readCache()
        if (cached) {
          setData(cached)
          if (loading) setLoading(false)
          return
        }

        // Use fallback data if no cache
        const fallback: MetalPrices = {
          metals: [
            { id: 'xau_24k', name: 'Gold', symbol: 'XAU', price: 7399, purity: '24K', unit: 'gm', changePercent24h: 0.45, sparkline: buildSparkline(7399, 'xau24'), color: 'gold' },
            { id: 'xau_22k', name: 'Gold', symbol: 'XAU', price: 6783, purity: '22K', unit: 'gm', changePercent24h: 0.42, sparkline: buildSparkline(6783, 'xau22'), color: 'gold' },
            { id: 'xag', name: 'Silver', symbol: 'XAG', price: 82, unit: 'gm', changePercent24h: -1.2, sparkline: buildSparkline(82, 'xag'), color: 'silver' },
            { id: 'xpt', name: 'Platinum', symbol: 'XPT', price: 2650, unit: 'gm', changePercent24h: 0.15, sparkline: buildSparkline(2650, 'xpt'), color: 'platinum' },
          ],
          fetchedAt: Date.now(),
          source: 'fallback'
        }
        setData(fallback)
        if (loading) setLoading(false)
      }
    }

    // Fetch immediately on mount
    fetchAndUpdate()

    // Set up interval to fetch every 1 second for real-time updates
    const interval = setInterval(fetchAndUpdate, 1000)

    // Cleanup interval on unmount
    return () => clearInterval(interval)
  }, [loading])

  return { data, loading, error }
}

// Keep legacy export for compatibility during migration
export const useGoldPrice = useMetalPrices
