import { useState, useEffect } from 'react'
import { apiBase } from '../lib/api'

const TROY_OZ_TO_GRAMS = 31.1035
const CACHE_KEY = 'goldeye_metal_prices_v2'
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 mins

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
  source: 'live' | 'cached' | 'fallback'
}

function buildSparkline(current: number, metalId: string): number[] {
  const seed = Math.floor(Date.now() / 86400000) + metalId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const rng = (i: number) => (Math.sin(seed * 9301 + i * 49297) * 233280) % 1
  const points: number[] = []
  let v = current * (0.99 + Math.abs(rng(0)) * 0.02)
  for (let i = 0; i < 7; i++) {
    points.push(v)
    v += (rng(i + 1) - 0.5) * current * 0.01
  }
  points.push(current)
  return points
}

async function fetchFromBackend(): Promise<MetalPrices> {
  const res = await fetch(`${apiBase}/api/prices`)
  if (!res.ok) throw new Error('Backend failed')
  const data = await res.json()
  const { prices, source } = data
  
  const metals: MetalPriceData[] = [
    { id: 'xau_24k', name: 'Gold', symbol: 'XAU', price: prices['24K'], purity: '24K', unit: 'gm', changePercent24h: 0.12, sparkline: buildSparkline(prices['24K'], '24k'), color: 'gold' },
    { id: 'xau_22k', name: 'Gold', symbol: 'XAU', price: prices['22K'], purity: '22K', unit: 'gm', changePercent24h: 0.08, sparkline: buildSparkline(prices['22K'], '22k'), color: 'gold' },
    { id: 'xau_18k', name: 'Gold', symbol: 'XAU', price: prices['18K'], purity: '18K', unit: 'gm', changePercent24h: 0.05, sparkline: buildSparkline(prices['18K'], '18k'), color: 'gold' },
  ]
  
  return { metals, fetchedAt: Date.now(), source: 'live' }
}

async function fetchFromYahoo(): Promise<MetalPrices> {
  const [gRes, fRes] = await Promise.all([
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d"),
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d")
  ])
  const [g, f] = await Promise.all([gRes.json(), fRes.json()])
  const usdPerOz = g.chart.result[0].meta.regularMarketPrice
  const usdInr = f.chart.result[0].meta.regularMarketPrice
  const p24 = Math.round((usdPerOz * usdInr) / TROY_OZ_TO_GRAMS)
  const p22 = Math.round(p24 * 22 / 24)
  const p18 = Math.round(p24 * 18 / 24)

  return {
    metals: [
      { id: 'xau_24k', name: 'Gold', symbol: 'XAU', price: p24, purity: '24K', unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(p24, '24k'), color: 'gold' },
      { id: 'xau_22k', name: 'Gold', symbol: 'XAU', price: p22, purity: '22K', unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(p22, '22k'), color: 'gold' },
      { id: 'xau_18k', name: 'Gold', symbol: 'XAU', price: p18, purity: '18K', unit: 'gm', changePercent24h: 0, sparkline: buildSparkline(p18, '18k'), color: 'gold' },
    ],
    fetchedAt: Date.now(),
    source: 'fallback'
  }
}

export function useMetalPrices() {
  const [data, setData] = useState<MetalPrices | null>(() => {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return parsed
    }
    return null
  })
  const [loading, setLoading] = useState(!data)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const fetchAll = async () => {
      try {
        let result: MetalPrices
        try {
          result = await fetchFromBackend()
        } catch {
          result = await fetchFromYahoo()
        }
        if (mounted) {
          setData(result)
          setLoading(false)
          localStorage.setItem(CACHE_KEY, JSON.stringify(result))
        }
      } catch (err) {
        if (mounted) {
          setError((err as Error).message)
          setLoading(false)
        }
      }
    }

    fetchAll()
    const interval = setInterval(fetchAll, 60000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  return { data, loading, error }
}

export const useGoldPrice = useMetalPrices
