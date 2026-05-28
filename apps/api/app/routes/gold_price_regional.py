"""
GET /api/gold-price/city?city=Mumbai&state=Maharashtra

Scrapes Times of India city gold-rate pages:
  /business/gold-rates-today/gold-price-in-{city-slug}

TOI exposes the exact per-gram 24K, 22K, and 18K card values on the page.
Other karats are intentionally not scraped; callers may derive them from 24K.

Falls back to IBJA national rate for cities not covered by the site.
Cache: 1 hour per city.
"""
import re
import time
import logging
from html import unescape
from typing import Optional
import httpx
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

# ── City slug overrides ────────────────────────────────────────────────────────
# Format: "app city name (lowercase)" → "TOI city slug"
CITY_OVERRIDES: dict = {
    "bengaluru":    "bangalore",
    "mysuru":       "mysore",
    "mangaluru":    "mangalore",
    "gurugram":     "gurgaon",

    # Delhi — all sub-areas map to the single city page
    "new delhi":    "delhi",
    "south delhi":  "delhi",
    "east delhi":   "delhi",
    "north delhi":  "delhi",
    "west delhi":   "delhi",
    "dwarka":       "delhi",
    "rohini":       "delhi",

    "secunderabad": "hyderabad",

    # Cities with alternate spellings
    "prayagraj":    "allahabad",
    "navi mumbai":  "mumbai",
    "vasai virar":  "mumbai",
}


def _slugify(name: str) -> str:
    """'Uttar Pradesh' → 'uttar-pradesh'"""
    return re.sub(r"[^a-z0-9]+", "-", name.lower().strip()).strip("-")


def _resolve_city_slug(city: str) -> str:
    """Return TOI city slug for /gold-price-in-{city_slug}."""
    city_lower  = city.lower().strip()
    return CITY_OVERRIDES.get(city_lower, _slugify(city))


def _html_to_text(html: str) -> str:
    """Convert TOI HTML to compact text while preserving card labels."""
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_price_after_label(text: str, karat: int) -> Optional[float]:
    """Extract the first rupee value after e.g. '22K gold/gm'."""
    pattern = rf"{karat}\s*K\s+gold/gm\s*₹\s*([0-9,]+)"
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1).replace(",", ""))


def _parse_toi_prices(html: str) -> Optional[dict]:
    """Extract TOI's exact 24K/22K/18K per-gram card prices."""
    text = _html_to_text(html)
    p24 = _parse_price_after_label(text, 24)
    p22 = _parse_price_after_label(text, 22)
    p18 = _parse_price_after_label(text, 18)
    if not (p24 and p22 and p18):
        return None
    return _exact_karats(p24=p24, p22=p22, p18=p18)


async def _fetch_toi_prices(city: str) -> tuple[Optional[dict], str]:
    """Fetch per-gram city gold prices from Times of India."""
    city_slug = _resolve_city_slug(city)
    url = f"https://timesofindia.indiatimes.com/business/gold-rates-today/gold-price-in-{city_slug}"
    logger.info(f"Fetching: {url}")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers=HEADERS) as client:
            r = await client.get(url)
        if r.status_code != 200:
            logger.debug(f"{city}: HTTP {r.status_code} — IBJA fallback")
            return None, "ibja_national"
        prices = _parse_toi_prices(r.text)
        if prices:
            logger.info(f"{city}: TOI 24K=₹{prices['24k']}/g, 22K=₹{prices['22k']}/g, 18K=₹{prices['18k']}/g")
            return prices, "timesofindia"
        logger.debug(f"{city}: TOI gold cards not found — IBJA fallback")
        return None, "ibja_national"
    except Exception as e:
        logger.debug(f"{city} fetch error: {e}")
        return None, "ibja_national"


def _exact_karats(p24: float, p22: Optional[float] = None, p18: Optional[float] = None) -> dict:
    """Return only the three rates shown on TOI. Missing values are derived from 24K."""
    return {
        "24k": round(p24, 2),
        "22k": round(p22 if p22 is not None else p24 * 22 / 24, 2),
        "18k": round(p18 if p18 is not None else p24 * 18 / 24, 2),
    }


@router.get("/gold-price/city")
async def city_gold_price(
    city:  str = Query("", description="City name e.g. Mumbai"),
    state: str = Query("", description="State name e.g. Maharashtra"),
):
    """
    Live city gold rates from Times of India city pages.
    Falls back to IBJA national rate for cities not covered by TOI.
    """
    from app.decision.ibja import price_metadata

    cache_key = f"{state.lower()}|{city.lower()}"

    if cache_key in _cache:
        fetched_at, prices, src = _cache[cache_key]
        if time.time() - fetched_at < CACHE_TTL:
            return _build_response(city, state, prices, src, fetched_at, cached=True)

    prices, source = await _fetch_toi_prices(city)

    if not prices:
        ibja = price_metadata()
        ibja_prices = ibja.get("prices", {})
        p24 = float(ibja_prices.get("24K", 0))
        prices = _exact_karats(p24)
        source = "ibja_national"

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
        "prices_per_gram": prices,   # exact/supported: 24k, 22k, 18k
        "source": source,
        "cached": cached,
        "fetched_at": fetched_at,
    }
