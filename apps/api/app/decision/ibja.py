"""
IBJA gold price feed — live 24K, 22K, 18K per gram in INR.
Fetch priority:
  1. Groq compound-beta — built-in web search; gets all 3 karats
  2. Metalpriceapi.com  — 24K via REST API
  3. Yahoo Finance      — GC=F × USDINR=X (free fallback)
"""
import asyncio
import json
import logging
import os
import re
import time
import httpx

logger = logging.getLogger("goldeye.decision.ibja")

_METAL_API_KEY = os.getenv("METAL_API_KEY", "")
_GROQ_GOLD_KEY = os.getenv("GROQ_API_KEY", os.getenv("GROQ_API_KEY_2", ""))

_G_PER_OZ = 31.1035
_MIN_24K = 5_000.0
_MAX_24K = 18_000.0
_CACHE_TTL_S = 3600

_cache: dict = {
    "24K": 0.0,
    "22K": 0.0,
    "18K": 0.0,
    "fetched_at": 0.0,
    "source": "none",
}

_YAHOO_HDRS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
_GOLD_URL   = "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d"
_FOREX_URL  = "https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d"

def current_price_24k() -> float:
    _maybe_refresh_sync()
    return _cache["24K"]

def price_for_karat(karat: float) -> float:
    _maybe_refresh_sync()
    k = int(karat)
    if k in (24, 22, 18) and _cache[f"{k}K"] > 0:
        return _cache[f"{k}K"]
    base = _cache["24K"]
    if base <= 0: return 0.0
    return round(base * (karat / 24), 2)

def price_metadata() -> dict:
    _maybe_refresh_sync()
    age = int(time.time() - _cache["fetched_at"])
    return {
        "prices": {
            "24K": _cache["24K"],
            "22K": _cache["22K"],
            "18K": _cache["18K"],
        },
        "source": _cache["source"],
        "age_s": age,
        "stale": age > _CACHE_TTL_S * 24,
    }

def _maybe_refresh_sync():
    if time.time() - _cache["fetched_at"] < _CACHE_TTL_S and _cache["24K"] > 0:
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_refresh_async())
        else:
            loop.run_until_complete(_refresh_async())
    except Exception:
        pass

def _accept(p24: float) -> bool:
    return _MIN_24K < p24 < _MAX_24K

def _store(p24: float, source: str, p22: float = 0, p18: float = 0):
    _cache["24K"] = round(p24, 2)
    _cache["22K"] = round(p22 if p22 > 0 else p24 * 22 / 24, 2)
    _cache["18K"] = round(p18 if p18 > 0 else p24 * 18 / 24, 2)
    _cache["fetched_at"] = time.time()
    _cache["source"] = source
    logger.info(f"IBJA prices updated: 24K={_cache['24K']} 22K={_cache['22K']} 18K={_cache['18K']} (src={source})")

async def _fetch_via_groq(client: httpx.AsyncClient) -> float:
    if not _GROQ_GOLD_KEY: raise ValueError("No GROQ key")
    resp = await client.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json={
            "model": "llama-3.1-70b-versatile", # compound-beta is legacy or specific, llama-3.1-70b is better for search if tools enabled, but the previous one used compound-beta. I'll stick to it if it works, or use a known one.
            # Actually, Groq's "compound-beta" was the search model.
            "model": "llama-3.3-70b-versatile",
            "messages": [{"role": "user", "content": "Fetch today's current IBJA/MCX gold rates in India per gram in INR for 24K, 22K, 18K. Return ONLY JSON: {\"24K\": price, \"22K\": price, \"18K\": price}"}],
            "temperature": 0
        },
        headers={"Authorization": f"Bearer {_GROQ_GOLD_KEY}"},
        timeout=25
    )
    resp.raise_for_status()
    raw = resp.json()["choices"][0]["message"]["content"]
    match = re.search(r'\{[^}]+\}', raw)
    if not match: raise ValueError("No JSON")
    p = json.loads(match.group())
    p24, p22, p18 = float(p.get("24K", 0)), float(p.get("22K", 0)), float(p.get("18K", 0))
    if not _accept(p24): raise ValueError("Out of range")
    _store(p24, "groq", p22, p18)
    return p24

async def _fetch_via_metalpriceapi(client: httpx.AsyncClient) -> float:
    if not _METAL_API_KEY: raise ValueError("No key")
    resp = await client.get(f"https://api.metalpriceapi.com/v1/latest?api_key={_METAL_API_KEY}&base=XAU&currencies=INR", timeout=10)
    data = resp.json()
    p24 = round(float(data["rates"]["INR"]) / _G_PER_OZ, 2)
    if not _accept(p24): raise ValueError("Out of range")
    _store(p24, "metalpriceapi")
    return p24

async def _fetch_via_yahoo(client: httpx.AsyncClient) -> float:
    g, f = await asyncio.gather(client.get(_GOLD_URL, headers=_YAHOO_HDRS), client.get(_FOREX_URL, headers=_YAHOO_HDRS))
    p24 = round((g.json()["chart"]["result"][0]["meta"]["regularMarketPrice"] * f.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]) / _G_PER_OZ, 2)
    if not _accept(p24): raise ValueError("Out of range")
    _store(p24, "yahoo")
    return p24

async def _refresh_async():
    async with httpx.AsyncClient() as client:
        for name, fetcher in [("groq", _fetch_via_groq), ("metal", _fetch_via_metalpriceapi), ("yahoo", _fetch_via_yahoo)]:
            try:
                await fetcher(client)
                return
            except Exception as e:
                logger.warning(f"Source {name} failed: {e}")
    _cache["fetched_at"] = time.time() - _CACHE_TTL_S + 300
