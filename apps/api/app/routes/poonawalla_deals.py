"""
GET /api/poonawalla-deals

Scrapes live Poonawalla Fincorp gold loan schemes using:
  1. Direct fetch of poonawallafincorp.com/gold-loan
  2. SerpAPI fallback if direct fetch fails
  3. Groq (llama-3.3-70b-versatile) to extract structured scheme data from HTML
  4. Gemini as secondary fallback if Groq fails

Results cached in-memory for CACHE_TTL_SECONDS (1 hour).
"""
import os
import re
import json
import time
import logging
import httpx
from fastapi import APIRouter

logger = logging.getLogger("goldeye.poonawalla_deals")
router = APIRouter()

SERP_API_KEY  = os.getenv("SERP_API_KEY", "")
GROQ_API_KEY  = os.getenv("GROQ_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

CACHE_TTL_SECONDS = 3600  # 1 hour

GROQ_ENDPOINT   = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"

DIRECT_URLS = [
    "https://www.poonawallafincorp.com/gold-loan.php",
    "https://www.poonawallafincorp.com/gold-loan",
    "https://poonawallafincorp.com/gold-loan",
]

SERP_QUERIES = [
    "Poonawalla Fincorp gold loan interest rate scheme 2024 site:poonawallafincorp.com",
    "Poonawalla Fincorp gold loan ROI LTV scheme",
]

# In-memory cache
_cache_schemes: list = []
_cache_ts: float = 0.0
_cache_source_urls: list = []


def _strip_html(html: str) -> str:
    """Fast HTML → plain text for LLM context."""
    text = re.sub(r'<script[^>]*>.*?</script>', ' ', html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>',  ' ', text,  flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<!--.*?-->',                ' ', text,  flags=re.DOTALL)
    text = re.sub(r'<[^>]+>',                  ' ', text)
    text = re.sub(r'\s+',                       ' ', text)
    return text.strip()[:7000]


EXTRACTION_PROMPT = """\
You are a financial data extractor. Extract gold loan scheme details from the text below.

Return ONLY a valid JSON array — no explanation, no markdown fences.
Each object must have these fields (use null if not found):
  "scheme_name"    : string  — name of the scheme or product
  "roi_min_pct"    : number  — minimum annual interest rate
  "roi_max_pct"    : number  — maximum annual interest rate
  "ltv_pct"        : number  — Loan-to-Value percentage offered
  "tenure_desc"    : string  — tenure description (e.g. "up to 12 months")
  "special_offer"  : string  — any current promotion or highlight
  "min_amount_inr" : number  — minimum loan amount in INR

If no scheme data is found, return [].

Text:
{text}

JSON:"""


async def _fetch_page(url: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (compatible; GoldEyeBot/1.0)",
        }) as client:
            r = await client.get(url)
            if r.status_code == 200 and len(r.text) > 500:
                return _strip_html(r.text)
    except Exception as e:
        logger.debug(f"fetch {url} failed: {e}")
    return ""


async def _serp_urls() -> list[str]:
    if not SERP_API_KEY:
        return []
    urls = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for q in SERP_QUERIES:
                r = await client.get("https://serpapi.com/search", params={
                    "q": q, "api_key": SERP_API_KEY, "num": 4, "gl": "in", "hl": "en",
                })
                if r.status_code != 200:
                    continue
                for result in r.json().get("organic_results", [])[:4]:
                    link = result.get("link", "")
                    if link and "poonawalla" in link.lower() and link not in urls:
                        urls.append(link)
                if urls:
                    break
    except Exception as e:
        logger.debug(f"SerpAPI failed: {e}")
    return urls[:3]


async def _extract_groq(text: str) -> list[dict]:
    if not GROQ_API_KEY or not text:
        return []
    prompt = EXTRACTION_PROMPT.format(text=text)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(GROQ_ENDPOINT,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 1024,
                },
            )
        if r.status_code != 200:
            logger.debug(f"Groq returned {r.status_code}: {r.text[:200]}")
            return []
        raw = r.json()["choices"][0]["message"]["content"].strip()
        match = re.search(r'\[.*\]', raw, re.DOTALL)
        if match:
            return json.loads(match.group())
    except Exception as e:
        logger.warning(f"Groq extraction error: {e}")
    return []


async def _extract_gemini(text: str) -> list[dict]:
    if not GEMINI_API_KEY or not text:
        return []
    prompt = EXTRACTION_PROMPT.format(text=text)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{GEMINI_ENDPOINT}?key={GEMINI_API_KEY}",
                json={"contents": [{"parts": [{"text": prompt}]}]},
            )
        if r.status_code != 200:
            logger.debug(f"Gemini returned {r.status_code}: {r.text[:200]}")
            return []
        raw = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        match = re.search(r'\[.*\]', raw, re.DOTALL)
        if match:
            return json.loads(match.group())
    except Exception as e:
        logger.warning(f"Gemini extraction error: {e}")
    return []


async def _extract(text: str) -> list[dict]:
    """Try Groq first, fall back to Gemini."""
    schemes = await _extract_groq(text)
    if not schemes:
        schemes = await _extract_gemini(text)
    return schemes


def _deduplicate(schemes: list[dict]) -> list[dict]:
    seen, out = set(), []
    for s in schemes:
        name = (s.get("scheme_name") or "").strip().lower()
        if name and name not in seen:
            seen.add(name)
            out.append(s)
    return out[:6]


@router.get("/poonawalla-deals")
async def get_poonawalla_deals():
    """Return cached Poonawalla Fincorp gold loan schemes, refreshing every hour."""
    global _cache_schemes, _cache_ts, _cache_source_urls

    if _cache_schemes and (time.time() - _cache_ts) < CACHE_TTL_SECONDS:
        return {
            "cached": True,
            "fetched_at": _cache_ts,
            "schemes": _cache_schemes,
            "source_urls": _cache_source_urls,
        }

    all_schemes: list[dict] = []
    source_urls: list[str] = []

    # 1. Try direct fetch of Poonawalla gold loan page
    for url in DIRECT_URLS:
        text = await _fetch_page(url)
        if text:
            schemes = await _extract(text)
            if schemes:
                all_schemes.extend(schemes)
                source_urls.append(url)
                break

    # 2. If direct fetch didn't yield results, try SerpAPI → fetch those URLs
    if not all_schemes:
        serp_urls = await _serp_urls()
        for url in serp_urls:
            if url in source_urls:
                continue
            text = await _fetch_page(url)
            if text:
                schemes = await _extract(text)
                if schemes:
                    all_schemes.extend(schemes)
                    source_urls.append(url)
            if all_schemes:
                break

    unique = _deduplicate(all_schemes)

    _cache_schemes    = unique
    _cache_ts         = time.time()
    _cache_source_urls = source_urls

    return {
        "cached": False,
        "fetched_at": _cache_ts,
        "schemes": unique,
        "source_urls": source_urls,
    }
