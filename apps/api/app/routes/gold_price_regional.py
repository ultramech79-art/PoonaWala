"""
GET /api/gold-price/city?city=Mumbai&state=Maharashtra

Scrapes allindiabullion.com which covers 120+ Indian cities.
Uses JSON-LD structured data (schema.org Dataset) — no fragile HTML parsing.

All karat prices (24K, 23K, 22K, 20K, 18K, 14K) are derived from the
24K (Gold Retail 999) base price, exactly as the site does:
  price_NK = price_24K × N/24

Falls back to IBJA national rate for cities not covered by the site.
Cache: 1 hour per city.
"""
import re
import json
import time
import logging
from typing import Optional, Tuple
import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Query

logger = logging.getLogger("goldeye.gold_price_regional")
router = APIRouter()

CACHE_TTL = 3600
_cache: dict = {}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-IN,en;q=0.9",
}

# ── State slug overrides (allindiabullion.com uses hyphens, no special chars) ─
STATE_OVERRIDES: dict = {
    "jammu & kashmir":                      "jammu-and-kashmir",
    "jammu and kashmir":                    "jammu-and-kashmir",
    "andaman & nicobar islands":            "andaman-and-nicobar-islands",
    "andaman and nicobar islands":          "andaman-and-nicobar-islands",
    "dadra & nagar haveli and daman & diu": "dadra-and-nagar-haveli",
    "dadra and nagar haveli and daman and diu": "dadra-and-nagar-haveli",
    "delhi":                                "delhi",
}

# ── City slug overrides ────────────────────────────────────────────────────────
# Format: "app city name (lowercase)" → (city_slug, optional_state_slug_override)
CITY_OVERRIDES: dict = {
    # Karnataka — site uses old English names for some
    "bengaluru":    ("bangalore",   None),
    "mysuru":       ("mysuru",      None),    # verified ✓
    "mangaluru":    ("mangaluru",   None),    # try exact first; site may not have it → IBJA fallback

    # Haryana
    "gurugram":     ("gurgaon",     None),

    # Delhi — all sub-areas map to the single city page
    "new delhi":    ("delhi",       "delhi"),
    "south delhi":  ("delhi",       "delhi"),
    "east delhi":   ("delhi",       "delhi"),
    "north delhi":  ("delhi",       "delhi"),
    "west delhi":   ("delhi",       "delhi"),
    "dwarka":       ("delhi",       "delhi"),
    "rohini":       ("delhi",       "delhi"),

    # Telangana
    "secunderabad": ("hyderabad",   None),

    # Goa — site splits into north/south-goa, no panaji/margao pages
    "panaji":           ("north-goa",  "goa"),
    "mapusa":           ("north-goa",  "goa"),
    "margao":           ("south-goa",  "goa"),
    "vasco da gama":    ("south-goa",  "goa"),

    # Puducherry / Karaikal
    "puducherry":   ("puducherry",  "puducherry"),
    "karaikal":     ("puducherry",  "puducherry"),

    # Cities with alternate spellings
    "prayagraj":    ("prayagraj",   None),
    "allahabad":    ("prayagraj",   None),
    "aurangabad":   ("aurangabad",  None),
    "navi mumbai":  ("navi-mumbai", None),
}


def _slugify(name: str) -> str:
    """'Uttar Pradesh' → 'uttar-pradesh'"""
    return re.sub(r"[^a-z0-9]+", "-", name.lower().strip()).strip("-")


def _resolve_slugs(state: str, city: str) -> Tuple[str, str]:
    """Return (state_slug, city_slug) for the allindiabullion.com URL."""
    city_lower  = city.lower().strip()
    state_lower = state.lower().strip()

    if city_lower in CITY_OVERRIDES:
        city_slug, state_slug_override = CITY_OVERRIDES[city_lower]
        state_slug = state_slug_override or STATE_OVERRIDES.get(state_lower, _slugify(state))
    else:
        city_slug  = _slugify(city)
        state_slug = STATE_OVERRIDES.get(state_lower, _slugify(state))

    return state_slug, city_slug


def _parse_jsonld(html: str) -> Optional[float]:
    """Extract 24K price per gram from JSON-LD Dataset on allindiabullion.com."""
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, AttributeError):
            continue
        if not isinstance(data, dict) or data.get("@type") != "Dataset":
            continue
        for var in data.get("variableMeasured", []):
            name  = (var.get("name") or "").lower()
            value = var.get("value")
            if not isinstance(value, (int, float)) or value <= 0:
                continue
            # "24K gold per 10 grams" or "Gold Retail 999"
            if ("24k" in name or "retail 999" in name or "gold retail" in name) and "silver" not in name:
                return round(value / 10, 2)
    return None


async def _fetch_24k(state: str, city: str) -> Tuple[Optional[float], str]:
    """Fetch 24K/gram price from allindiabullion.com. Returns (price, source)."""
    state_slug, city_slug = _resolve_slugs(state, city)
    url = f"https://allindiabullion.com/gold-rate/{state_slug}/{city_slug}"
    logger.info(f"Fetching: {url}")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=HEADERS) as client:
            r = await client.get(url)
        if r.status_code != 200:
            logger.debug(f"{city}: HTTP {r.status_code} — IBJA fallback")
            return None, "ibja_national"
        p24 = _parse_jsonld(r.text)
        if p24:
            logger.info(f"{city}, {state}: 24K=₹{p24}/g")
            return p24, "allindiabullion.com"
        logger.debug(f"{city}: JSON-LD not found — IBJA fallback")
        return None, "ibja_national"
    except Exception as e:
        logger.debug(f"{city} fetch error: {e}")
        return None, "ibja_national"


def _all_karats(p24: float) -> dict:
    """
    Derive all standard karat prices from 24K base.
    Formula: p_NK = p_24K × N/24  (same as allindiabullion.com)
    """
    return {
        "24k": round(p24, 2),
        "23k": round(p24 * 23 / 24, 2),
        "22k": round(p24 * 22 / 24, 2),
        "20k": round(p24 * 20 / 24, 2),
        "18k": round(p24 * 18 / 24, 2),
        "14k": round(p24 * 14 / 24, 2),
    }


@router.get("/gold-price/city")
async def city_gold_price(
    city:  str = Query("", description="City name e.g. Mumbai"),
    state: str = Query("", description="State name e.g. Maharashtra"),
):
    """
    Live city gold rates (all karats) from allindiabullion.com JSON-LD.
    Falls back to IBJA national rate for cities not on the site.
    """
    from app.decision.ibja import price_metadata

    cache_key = f"{state.lower()}|{city.lower()}"

    if cache_key in _cache:
        fetched_at, prices, src = _cache[cache_key]
        if time.time() - fetched_at < CACHE_TTL:
            return _build_response(city, state, prices, src, fetched_at, cached=True)

    p24, source = await _fetch_24k(state, city)

    if not p24:
        ibja = price_metadata()
        ibja_prices = ibja.get("prices", {})
        p24 = float(ibja_prices.get("24K", 0))
        source = "ibja_national"

    prices = _all_karats(p24)
    fetched_at = time.time()
    _cache[cache_key] = (fetched_at, prices, source)
    return _build_response(city, state, prices, source, fetched_at, cached=False)


def _build_response(
    city: str, state: str, prices: dict,
    source: str, fetched_at: float, cached: bool,
) -> dict:
    return {
        "city": city,
        "state": state,
        "prices_per_gram": prices,   # 24k, 23k, 22k, 20k, 18k, 14k
        "source": source,
        "cached": cached,
        "fetched_at": fetched_at,
    }
