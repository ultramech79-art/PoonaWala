"""
IBJA gold price feed (FR-DEC-03).
Fetches live gold price via multiple sources:
  1. Metal API (metals-api.com) — primary, 2x daily updates
  2. Yahoo Finance — fallback
1-hour in-memory cache with 5-minute retry on failure.

Fallback chain:
  1. In-memory cache (updated by background async refresh)
  2. Hardcoded fallback (₹7,200/g for 24K — conservative estimate)

All prices are per gram in INR.
24K price is the base; purity_ratio = karat/24 applied by callers.
"""
import asyncio
import logging
import time
import os

import httpx

logger = logging.getLogger("goldeye.decision.ibja")

# Metal API — specialized for precious metals
_METAL_API_KEY = os.getenv("METAL_API_KEY", "")
_METAL_API_URL = "https://api.metals.live/v1/spot/gold"

# Yahoo Finance fallback
_YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
_GOLD_URL   = "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d"
_FOREX_URL  = "https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d"
_G_PER_OZ   = 31.1035

# Updated fallback — conservative estimate (actual price usually higher)
_FALLBACK_PRICE = 7200.0  # ₹/g 24K — conservative fallback
_CACHE_TTL_S    = 3600     # 1 hour

_cache: dict = {
    "price_24k_per_g": _FALLBACK_PRICE,
    "fetched_at": 0.0,
    "source": "fallback",
}


def current_price_24k() -> float:
    """Return current ₹/g for 24K gold. Always succeeds (falls back to hardcoded rate)."""
    _maybe_refresh_sync()
    return _cache["price_24k_per_g"]


def price_for_karat(karat: int) -> float:
    return current_price_24k() * (karat / 24)


def _maybe_refresh_sync():
    age = time.time() - _cache["fetched_at"]
    if age < _CACHE_TTL_S:
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_refresh_async())
        else:
            loop.run_until_complete(_refresh_async())
    except Exception:
        pass


async def _refresh_async():
    """Fetch live gold price from Metal API (primary) or Yahoo Finance (fallback)."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            # Try Metal API first (no API key needed for basic endpoint)
            try:
                metal_resp = await client.get(_METAL_API_URL)
                metal_resp.raise_for_status()
                metal_data = metal_resp.json()

                # Metal API returns {bid, ask} in USD per oz
                usd_per_oz = float(metal_data.get("bid", metal_data.get("price", 0)))

                if usd_per_oz > 0:
                    # Fetch USD/INR rate from Yahoo
                    forex_resp = await client.get(_FOREX_URL, headers=_YAHOO_HEADERS)
                    forex_resp.raise_for_status()
                    forex_data = forex_resp.json()["chart"]["result"][0]["meta"]
                    usd_inr = float(forex_data["regularMarketPrice"])

                    if usd_inr > 0:
                        price_inr_g = round((usd_per_oz * usd_inr) / _G_PER_OZ, 2)
                        _cache["price_24k_per_g"] = price_inr_g
                        _cache["fetched_at"]      = time.time()
                        _cache["source"]          = "metal_api"
                        logger.info(f"IBJA refresh: ₹{price_inr_g:.0f}/g 24K (XAU ${usd_per_oz:.2f}/oz, USD/INR {usd_inr:.2f})")
                        return
            except Exception as e:
                logger.debug(f"Metal API failed: {e} — trying Yahoo Finance")

            # Fallback to Yahoo Finance
            gold_resp, forex_resp = await asyncio.gather(
                client.get(_GOLD_URL, headers=_YAHOO_HEADERS),
                client.get(_FOREX_URL, headers=_YAHOO_HEADERS),
            )
            gold_resp.raise_for_status()
            forex_resp.raise_for_status()

            gold_data  = gold_resp.json()["chart"]["result"][0]["meta"]
            forex_data = forex_resp.json()["chart"]["result"][0]["meta"]

            usd_per_oz = float(gold_data["regularMarketPrice"])
            usd_inr    = float(forex_data["regularMarketPrice"])

            if usd_per_oz > 0 and usd_inr > 0:
                price_inr_g = round((usd_per_oz * usd_inr) / _G_PER_OZ, 2)
                _cache["price_24k_per_g"] = price_inr_g
                _cache["fetched_at"]      = time.time()
                _cache["source"]          = "yahoo_finance"
                logger.info(f"IBJA refresh: ₹{price_inr_g:.0f}/g 24K (XAU ${usd_per_oz:.0f}/oz, USD/INR {usd_inr:.2f})")
    except Exception as e:
        logger.warning(f"IBJA refresh failed: {e} — using cached ₹{_cache['price_24k_per_g']:.0f}/g")
        _cache["fetched_at"] = time.time() - _CACHE_TTL_S + 300  # retry in 5 min


def price_metadata() -> dict:
    return {
        "price_24k_per_g": _cache["price_24k_per_g"],
        "source": _cache["source"],
        "age_s": int(time.time() - _cache["fetched_at"]),
        "stale": (time.time() - _cache["fetched_at"]) > _CACHE_TTL_S * 24,
    }
