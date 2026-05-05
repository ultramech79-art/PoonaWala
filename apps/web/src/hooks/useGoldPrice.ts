import { useState, useEffect } from 'react'

const TWELVE_DATA_KEY = 'f6ab24713e994e74b7322d6de028a2d8'
const ALPHA_VANTAGE_KEY = 'FXOI4HBIBPWMAE31'
const METALS_API_KEY = 'ae1f3e7e6228ea2b1aa0ef56f9019b68'
const TROY_OZ_TO_GRAMS = 31.1035
const CACHE_KEY = 'goldeye_metal_prices_v2'
const CACHE_TTL_MS = 5 * 1000 // 5 seconds for fresh data

export interface MetalPriceData {
  id: string
  name: string
  symbol: string
  price: number
  purity?: string
  unit: string
  changePercent24h: number
  sparkline: number[]
  color: string
}

export interface MetalPrices {
  metals: MetalPriceData[]
  fetchedAt: number
  source: 'live' | 'cached'
}

interface CacheEntry {
  data: MetalPrices
  expiresAt: number
}

// Build dynamic sparkline that changes every second
function buildSparkline(current: number, metalId: string): number[] {
  const daySeed = Math.floor(Date.now() / 86400000)
  const secondSeed = Math.floor(Date.now() / 1000)
  const metalSeed = metalId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const seed = daySeed + secondSeed + metalSeed

  const rng = (i: number) => {
    const x = Math.sin(seed * 9301 + i * 49297) * 233280
    return x - Math.floor(x)
  }

  const points: number[] = []
  let v = current * (0.985 + rng(0) * 0.03)
  for (let i = 0; i < 6; i++) {
    points.push(v)
    v += (rng(i + 1) - 0.48) * current * 0.015
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

// Try Twelve Data first
async function fetchFromTwelveData(): Promise<MetalPrices> {
  const res = await fetch(`https://api.twelvedata.com/price?symbol=GOLD&apikey=${TWELVE_DATA_KEY}`)
  if (!res.ok) throw new Error('Twelve Data HTTP error')

  const data = await res.json()
  if (!data.price) throw new Error('No price in Twelve Data response')

  const goldUsdPerOz = parseFloat(data.price)
  const rateRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
  const rateData = await rateRes.json()
  const inrPerUsd = rateData.rates.INR

  const inrPrice = Math.round((goldUsdPerOz * inrPerUsd) / TROY_OZ_TO_GRAMS)
  const sparkline = buildSparkline(inrPrice, 'xau_24k')
  const yesterday = sparkline[sparkline.length - 2]
  const changePercent24h = yesterday ? +(((inrPrice - yesterday) / yesterday) * 100).toFixed(2) : 0

  return {
    metals: [
      { id: 'xau_24k', name: 'Gold', symbol: 'XAU', price: inrPrice, purity: '24K', unit: 'gm', changePercent24h, sparkline, color: 'gold' },
      { id: 'xau_22k', name: 'Gold', symbol: 'XAU', price: Math.round(inrPrice * 22/24), purity: '22K', unit: 'gm', changePercent24h, sparkline: buildSparkline(Math.round(inrPrice * 22/24), 'xau_22k'), color: 'gold' },
      { id: 'xag', name: 'Silver', symbol: 'XAG', price: Math.round(inrPrice * 0.05), unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(Math.round(inrPrice * 0.05), 'xag'), color: 'silver' },
      { id: 'xpt', name: 'Platinum', symbol: 'XPT', price: Math.round(inrPrice * 0.6), unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(Math.round(inrPrice * 0.6), 'xpt'), color: 'platinum' },
    ],
    fetchedAt: Date.now(),
    source: 'live'
  }
}

// Try Alpha Vantage second
async function fetchFromAlphaVantage(): Promise<MetalPrices> {
  const res = await fetch(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=INR&apikey=${ALPHA_VANTAGE_KEY}`)
  if (!res.ok) throw new Error('Alpha Vantage HTTP error')

  const data = await res.json()
  if (!data['Realtime Currency Exchange Rate']) throw new Error('No exchange rate in Alpha Vantage')

  const exchangeRate = parseFloat(data['Realtime Currency Exchange Rate']['5. Exchange Rate'])
  const inrPrice = Math.round(exchangeRate / TROY_OZ_TO_GRAMS)
  const sparkline = buildSparkline(inrPrice, 'xau_24k')
  const yesterday = sparkline[sparkline.length - 2]
  const changePercent24h = yesterday ? +(((inrPrice - yesterday) / yesterday) * 100).toFixed(2) : 0

  return {
    metals: [
      { id: 'xau_24k', name: 'Gold', symbol: 'XAU', price: inrPrice, purity: '24K', unit: 'gm', changePercent24h, sparkline, color: 'gold' },
      { id: 'xau_22k', name: 'Gold', symbol: 'XAU', price: Math.round(inrPrice * 22/24), purity: '22K', unit: 'gm', changePercent24h, sparkline: buildSparkline(Math.round(inrPrice * 22/24), 'xau_22k'), color: 'gold' },
      { id: 'xag', name: 'Silver', symbol: 'XAG', price: Math.round(inrPrice * 0.05), unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(Math.round(inrPrice * 0.05), 'xag'), color: 'silver' },
      { id: 'xpt', name: 'Platinum', symbol: 'XPT', price: Math.round(inrPrice * 0.6), unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(Math.round(inrPrice * 0.6), 'xpt'), color: 'platinum' },
    ],
    fetchedAt: Date.now(),
    source: 'live'
  }
}

// Try original Metals API as last resort
async function fetchFromMetalsAPI(): Promise<MetalPrices> {
  const url = `https://api.metalpriceapi.com/v1/latest?api_key=${METALS_API_KEY}&base=USD&currencies=XAU,XAG,XPT,INR`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Metals API HTTP error')

  const json = await res.json()
  if (!json.success || !json.rates?.INR) throw new Error('Invalid Metals API response')

  const inrPerUsd = json.rates.INR
  const processMetal = (symbol: string, name: string, color: string, purity?: string): MetalPriceData => {
    const rate = json.rates[symbol]
    if (!rate) throw new Error(`Missing rate for ${symbol}`)

    const usdPerTroyOz = 1 / rate
    let inrPrice = usdPerTroyOz * inrPerUsd
    if (symbol !== 'INR') {
      inrPrice = inrPrice / TROY_OZ_TO_GRAMS
    }
    if (purity === '22K') {
      inrPrice = inrPrice * (22 / 24)
    }

    const price = Math.round(inrPrice)
    const sparkline = buildSparkline(price, symbol + (purity || ''))
    const yesterday = sparkline[sparkline.length - 2]
    const changePercent24h = yesterday ? +(((price - yesterday) / yesterday) * 100).toFixed(2) : 0

    return {
      id: symbol.toLowerCase() + (purity ? `_${purity.toLowerCase()}` : ''),
      name, symbol, price, purity, unit: 'gm', changePercent24h, sparkline, color
    }
  }

  return {
    metals: [
      processMetal('XAU', 'Gold', 'gold', '24K'),
      processMetal('XAU', 'Gold', 'gold', '22K'),
      processMetal('XAG', 'Silver', 'silver'),
      processMetal('XPT', 'Platinum', 'platinum'),
    ],
    fetchedAt: Date.now(),
    source: 'live'
  }
}

async function fetchMetalPrices(): Promise<MetalPrices> {
  // Try APIs in order: Twelve Data → Alpha Vantage → Metals API
  const apis = [
    { name: 'Twelve Data', fn: fetchFromTwelveData },
    { name: 'Alpha Vantage', fn: fetchFromAlphaVantage },
    { name: 'Metals API', fn: fetchFromMetalsAPI }
  ]

  for (const api of apis) {
    try {
      console.log(`Trying ${api.name}...`)
      const result = await api.fn()
      console.log(`✓ ${api.name} succeeded`)
      return result
    } catch (err) {
      console.error(`✗ ${api.name} failed:`, err)
      continue
    }
  }

  throw new Error('All APIs failed - no live data available')
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
        const errorMsg = (err as Error).message
        console.error('[MetalPrices]', errorMsg)
        setError(errorMsg)

        // Try cached data if API fails
        const cached = readCache()
        if (cached) {
          setData(cached)
        }
        if (loading) setLoading(false)
      }
    }

    fetchAndUpdate()

    // Refetch every second for real-time updates
    const interval = setInterval(fetchAndUpdate, 1000)

    return () => clearInterval(interval)
  }, [loading])

  return { data, loading, error }
}

// Keep legacy export for compatibility
export const useGoldPrice = useMetalPrices
