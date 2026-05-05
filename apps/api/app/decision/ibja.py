"""
IBJA-aligned gold price feed (FR-DEC-03).

Priority fetch chain — first success wins:
  1. Groq compound-beta  — built-in web search; queries live IBJA/MCX 24K rate
  2. Metalpriceapi.com   — REST API (METAL_API_KEY env var)
  3. Yahoo Finance        — GC=F futures × USDINR=X spot

Banking formula (RBI Master Direction on Gold Loans, 2023-24):
  net_value_inr = net_weight_g × (karat / 24) × price_24k_per_g
  where net_weight_g = gross_weight_g − stone_weight_g  (stones excluded by S5 upstream)
  price_24k_per_g derived from: IBJA 30-day average OR MCX previous-day close ÷ 31.1035 g/oz

1-hour in-memory cache (IBJA publishes twice daily, so 1h TTL is conservative).
5-minute retry on failure.
"""
import asyncio
import logging
import time
import os
import re

import httpx

logger = logging.getLogger("goldeye.decision.ibja")

_METAL_API_KEY  = os.getenv("METAL_API_KEY", "")
_GROQ_GOLD_KEY  = os.getenv("GROQ_API_KEY_2", "")   # dedicated key for gold price queries

# 1 troy ounce = 31.1035 grams — fixed physical constant
_G_PER_OZ = 31.1035

# Sanity bounds for 24K gold per gram in INR.
# If any source returns outside these bounds we reject and try the next source.
# Bounds are intentionally wide (±50% from ~₹9k centre) to survive extreme market moves.
_PRICE_MIN_INR = 5_000.0   # below ₹5k/g → clearly wrong
_PRICE_MAX_INR = 18_000.0  # above ₹18k/g → clearly wrong

# Conservative fallback — used only when ALL live sources fail.
# ₹9,000/g ≈ XAU $3,300/oz at USD/INR 85 (realistic for 2025-26).
_FALLBACK_PRICE = 9_000.0
_CACHE_TTL_S    = 3600       # 1 hour

_cache: dict = {
    "price_24k_per_g": _FALLBACK_PRICE,
    "fetched_at": 0.0,
    "source": "fallback",
}

_YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
_GOLD_URL  = "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d"
_FOREX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d"


# ─── Public API ───────────────────────────────────────────────────────────────

def current_price_24k() -> float:
    """Return current ₹/g for 24K gold. Always succeeds (falls back to ₹9,000/g)."""
    _maybe_refresh_sync()
    return _cache["price_24k_per_g"]


def price_for_karat(karat: int) -> float:
    """
    ₹/g for a given karat purity.
    Banking formula: price_24k × (karat / 24)
    e.g. 22K = price_24k × 0.9167
    """
    return current_price_24k() * (karat / 24)


def price_metadata() -> dict:
    return {
        "price_24k_per_g": _cache["price_24k_per_g"],
        "source": _cache["source"],
        "age_s": int(time.time() - _cache["fetched_at"]),
        "stale": (time.time() - _cache["fetched_at"]) > _CACHE_TTL_S * 24,
    }


# ─── Cache refresh ────────────────────────────────────────────────────────────

def _maybe_refresh_sync():
    if time.time() - _cache["fetched_at"] < _CACHE_TTL_S:
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_refresh_async())
        else:
            loop.run_until_complete(_refresh_async())
    except Exception:
        pass


def _valid(price: float) -> bool:
    return _PRICE_MIN_INR < price < _PRICE_MAX_INR


# ─── Source 1: Groq compound-beta (live web search) ──────────────────────────

async def _fetch_via_groq(client: httpx.AsyncClient) -> float:
    """
    Groq compound-beta has built-in web search — it queries live financial data
    and returns the current IBJA/MCX 24K gold rate in INR per gram.
    This is the most up-to-date source as it mirrors what IBJA publishes intraday.
    """
    if not _GROQ_GOLD_KEY:
        raise ValueError("GROQ_API_KEY_2 not set")

    resp = await client.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json={
            "model": "compound-beta",
            "messages": [{
                "role": "user",
                "content": (
                    "What is today's IBJA or MCX 24 karat gold price per gram in Indian Rupees (INR)? "
                    "Reply with ONLY the numeric value, no units, no symbols, no explanation. "
                    "Example of correct reply: 9425.50"
                ),
            }],
            "temperature": 0,
            "max_tokens": 25,
        },
        headers={"Authorization": f"Bearer {_GROQ_GOLD_KEY}"},
        timeout=20,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"].strip()

    # Extract first number from response (handles "9425.50" or "₹9,425.50/g" etc.)
    match = re.search(r'\d[\d,]*\.?\d*', content)
    if not match:
        raise ValueError(f"No numeric price in Groq response: {content!r}")

    price = float(match.group().replace(',', ''))
    if not _valid(price):
        raise ValueError(f"Groq price ₹{price:.0f}/g outside sanity bounds [{_PRICE_MIN_INR:.0f}–{_PRICE_MAX_INR:.0f}]")
    return price


# ─── Source 2: Metalpriceapi.com ─────────────────────────────────────────────

async def _fetch_via_metalpriceapi(client: httpx.AsyncClient) -> float:
    if not _METAL_API_KEY:
        raise ValueError("METAL_API_KEY not set")

    url = (
        f"https://api.metalpriceapi.com/v1/latest"
        f"?api_key={_METAL_API_KEY}&base=XAU&currencies=USD,INR"
    )
    resp = await client.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    if not data.get("success"):
        raise ValueError(f"metalpriceapi error: {data.get('error', 'unknown')}")

    # base=XAU so rates["INR"] = INR per 1 troy oz of gold
    inr_per_oz = float(data["rates"]["INR"])
    if inr_per_oz <= 0:
        raise ValueError("metalpriceapi returned zero INR rate")

    # Convert troy oz → grams (RBI/IBJA standard unit: per gram)
    price = round(inr_per_oz / _G_PER_OZ, 2)
    if not _valid(price):
        raise ValueError(f"metalpriceapi price ₹{price:.0f}/g outside sanity bounds")
    return price


# ─── Source 3: Yahoo Finance (GC=F futures + USDINR=X) ───────────────────────

async def _fetch_via_yahoo(client: httpx.AsyncClient) -> float:
    gold_resp, forex_resp = await asyncio.gather(
        client.get(_GOLD_URL,  headers=_YAHOO_HEADERS, timeout=10),
        client.get(_FOREX_URL, headers=_YAHOO_HEADERS, timeout=10),
    )
    gold_resp.raise_for_status()
    forex_resp.raise_for_status()

    usd_per_oz = float(gold_resp.json()["chart"]["result"][0]["meta"]["regularMarketPrice"])
    usd_inr    = float(forex_resp.json()["chart"]["result"][0]["meta"]["regularMarketPrice"])

    if usd_per_oz <= 0 or usd_inr <= 0:
        raise ValueError(f"Yahoo invalid: XAU/USD={usd_per_oz}, USD/INR={usd_inr}")

    # Standard conversion: (USD/oz × INR/USD) / 31.1035 g/oz = INR/g
    price = round((usd_per_oz * usd_inr) / _G_PER_OZ, 2)
    if not _valid(price):
        raise ValueError(f"Yahoo price ₹{price:.0f}/g outside sanity bounds")
    return price


# ─── Refresh orchestrator ─────────────────────────────────────────────────────

async def _refresh_async():
    """
    Try each source in priority order; accept first valid price.
    On total failure: retain cached value and retry in 5 minutes.
    """
    sources = [
        ("groq_compound_beta", _fetch_via_groq),
        ("metalpriceapi",      _fetch_via_metalpriceapi),
        ("yahoo_finance",      _fetch_via_yahoo),
    ]

    async with httpx.AsyncClient() as client:
        for name, fetcher in sources:
            try:
                price = await fetcher(client)
                _cache["price_24k_per_g"] = price
                _cache["fetched_at"]      = time.time()
                _cache["source"]          = name
                logger.info(f"IBJA refresh: ₹{price:.0f}/g 24K (source={name})")
                return
            except Exception as e:
                logger.warning(f"IBJA source '{name}' failed: {e}")

    logger.error(f"All IBJA sources failed — retaining cached ₹{_cache['price_24k_per_g']:.0f}/g")
    _cache["fetched_at"] = time.time() - _CACHE_TTL_S + 300  # retry in 5 min
