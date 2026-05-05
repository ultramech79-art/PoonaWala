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
_SERPAPI_KEY = os.getenv("SERPAPI_KEY", "")
_TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

_G_PER_OZ = 31.1035
_MIN_24K = 8_000.0
_MAX_24K = 30_000.0
_CACHE_TTL_S = 10 # 10 seconds for live market updates

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
    
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [
            {"role": "system", "content": "You are a financial API. You must return the current estimated market gold rate for India (IBJA). Due to no live search, you must estimate the current realistic price for today based on recent trends (which is around ₹7300-₹7500 for 24K). Return EXACTLY AND ONLY this JSON format: {\"24K\": <price>, \"22K\": <price>, \"18K\": <price>}"},
            {"role": "user", "content": "Get the gold rate now."}
        ],
        "temperature": 0
    }
    
    resp = await client.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {_GROQ_GOLD_KEY}"},
        timeout=25
    )
    resp.raise_for_status()
    raw = resp.json()["choices"][0]["message"]["content"]
    
    # Extract JSON robustly
    match = re.search(r'\{[^}]+\}', raw)
    if not match: raise ValueError(f"No JSON in response: {raw}")
    
    p = json.loads(match.group())
    p24, p22, p18 = float(p.get("24K", 0)), float(p.get("22K", 0)), float(p.get("18K", 0))
    if not _accept(p24): raise ValueError(f"Price {p24} out of range")
    _store(p24, "groq", p22, p18)
    return p24

async def _fetch_via_yahoo(client: httpx.AsyncClient) -> float:
    g, f = await asyncio.gather(
        client.get(_GOLD_URL, headers=_YAHOO_HDRS),
        client.get(_FOREX_URL, headers=_YAHOO_HDRS)
    )
    usd_per_oz = g.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
    inr_per_usd = f.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
    p24 = round((usd_per_oz * inr_per_usd) / _G_PER_OZ, 2)
    if not _accept(p24): raise ValueError(f"Price {p24} out of range")
    p22 = round(p24 * 22 / 24, 2)
    p18 = round(p24 * 18 / 24, 2)
    _store(p24, "yahoo", p22, p18)
    return p24

def _parse_inr(s: str) -> float:
    """Parse Indian rupee string to float: '₹14,918', '15,122.18', '1,51,780' → float"""
    clean = re.sub(r'[₹Rs,\s]', '', s)
    try:
        return float(clean)
    except ValueError:
        return 0.0

async def _fetch_via_search_api(client: httpx.AsyncClient) -> float:
    if not _SERPAPI_KEY:
        raise ValueError("No SerpAPI key")

    params = {
        "engine": "google",
        "q": "gold rate today india 24k 22k 18k per gram",
        "api_key": _SERPAPI_KEY,
        "gl": "in",
        "hl": "en",
        "num": "5",
    }
    resp = await client.get("https://serpapi.com/search", params=params, timeout=20)
    resp.raise_for_status()
    data = resp.json()

    snippets: list[str] = []
    if "answer_box" in data:
        snippets.append(str(data["answer_box"]))
    for r in data.get("organic_results", [])[:5]:
        t = r.get("title", "")
        s = r.get("snippet", "")
        if s:
            snippets.append(f"{t}: {s}")

    context = "\n".join(snippets)
    if not context:
        raise ValueError("No content from SerpAPI")

    p24, p22, p18 = 0.0, 0.0, 0.0

    # Indian gold prices are 5-digit per gram (e.g. 14918, 15122) or
    # 6-digit per 10g in Indian comma format (e.g. 1,51,780 → 151780 → /10 = 15178).
    # Patterns target "24 karat ... ₹14,918 per gram" and "1 gm. ₹15,122.18" style.
    for karat, store_var in [("24", "p24"), ("22", "p22"), ("18", "p18")]:
        # Direct per-gram mention near karat label
        per_gram = re.search(
            rf'{karat}\s*[Kk](?:arat|carat)?[^₹\d]{{0,40}}[₹₹]\s*([\d,]+(?:\.\d{{1,2}})?)\s*(?:per gram|/g)',
            context, re.IGNORECASE
        )
        # "1 gm" table style: karat mentioned then ₹ amount
        one_gm = re.search(
            rf'{karat}\s*[Kk][^₹\d]{{0,60}}1\s*gm[^₹\d]{{0,10}}[₹₹]\s*([\d,]+(?:\.\d{{1,2}})?)',
            context, re.IGNORECASE
        )
        # Reverse: "₹14,918 per gram for 24 karat"
        reverse = re.search(
            rf'[₹₹]\s*([\d,]+(?:\.\d{{1,2}})?)\s*per gram[^.{{0,60}}]{karat}\s*[Kk]',
            context, re.IGNORECASE
        )

        raw_val = 0.0
        for m in [per_gram, one_gm, reverse]:
            if m:
                raw_val = _parse_inr(m.group(1))
                break

        # Fallback: "18K Gold. ₹1,12,210" style (per 10g in Indian comma format)
        if raw_val == 0.0:
            fallback = re.search(
                rf'{karat}\s*[Kk][^₹₹\d]{{0,30}}[₹₹]\s*([\d,]{{5,10}}(?:\.\d{{1,2}})?)',
                context, re.IGNORECASE
            )
            if fallback:
                raw_val = _parse_inr(fallback.group(1))

        # If value looks like per-10g (> 50000), divide by 10
        if raw_val > 50_000:
            raw_val = round(raw_val / 10, 2)

        if karat == "24": p24 = raw_val
        elif karat == "22": p22 = raw_val
        elif karat == "18": p18 = raw_val

    logger.info(f"SerpAPI parsed: 24K={p24} 22K={p22} 18K={p18}")

    if _accept(p24):
        _store(p24, "serp", p22, p18)
        return p24

    raise ValueError(f"SerpAPI: could not parse valid 24K price. Got {p24}. Context snippet: {context[:400]}")

async def _refresh_async():
    async with httpx.AsyncClient() as client:
        # 1. SerpAPI — Google Search, actual Indian market price (IBJA/goodreturns)
        if _SERPAPI_KEY:
            try:
                await _fetch_via_search_api(client)
                return
            except Exception as e:
                logger.warning(f"Source serp failed: {e}")

        # 2. Yahoo Finance — international GC=F × USDINR (excludes Indian import duty)
        try:
            await _fetch_via_yahoo(client)
            return
        except Exception as e:
            logger.warning(f"Source yahoo failed: {e}")

        # 3. Groq estimate — last resort
        try:
            await _fetch_via_groq(client)
            return
        except Exception as e:
            logger.warning(f"Source groq failed: {e}")

    _cache["fetched_at"] = time.time() - _CACHE_TTL_S + 300
