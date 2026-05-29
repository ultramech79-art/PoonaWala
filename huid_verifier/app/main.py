"""
HUID Verifier — FastAPI entry point.

Routes:
  GET /                      — service info
  GET /health                — liveness probe
  GET /verify-huid/{huid}    — BIS CARE HUID verification
"""
import re
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.logging_config import configure_logging, get_logger
from app.models import HUIDVerificationResponse, VerificationStatus

configure_logging(settings.log_level)
logger = get_logger("huid_verifier.api")

# Single-thread executor — enforces one Appium worker at a time
_executor = ThreadPoolExecutor(max_workers=1)

app = FastAPI(
    title="BIS CARE HUID Verifier",
    description=(
        "Automates BIS CARE Android app to verify hallmark UIDs. "
        "One-worker proof-of-concept — not for high-volume production use."
    ),
    version="1.0.0",
)

allowed_origins = [origin.strip() for origin in settings.allowed_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
def shutdown_appium_driver() -> None:
    from app.bis_agent import close_driver

    close_driver()


# ─── Error sanitizer ──────────────────────────────────────────────────────────

def _friendly_error_str(msg: str) -> str:
    m = msg.lower()
    if "connection refused" in m or "max retries exceeded" in m or "failed to establish" in m:
        return "Appium server is not running — start it on port 4723 and ensure the emulator is open."
    if "no such driver" in m or "session" in m and "not found" in m:
        return "Appium session lost — restart the verifier service."
    if "no such element" in m or "nosuchelement" in m:
        return "BIS CARE app element not found — the app UI may have changed."
    if "timeout" in m:
        return "BIS CARE app timed out — ensure the emulator is unlocked and BIS app is installed."
    return msg[:200]


def _friendly_error(exc: Exception) -> str:
    return _friendly_error_str(str(exc))


# ─── HUID validation ──────────────────────────────────────────────────────────

_HUID_RE = re.compile(r"^[A-Z0-9]{6}$")


def validate_huid(raw: str) -> tuple[bool, str]:
    """
    Returns (is_valid, normalised_huid).
    Strips whitespace, uppercases, then checks exactly 6 alphanumeric chars.
    """
    cleaned = raw.strip().upper()
    return _HUID_RE.match(cleaned) is not None, cleaned


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/", tags=["Info"])
async def root():
    return {
        "service": "BIS CARE HUID Verifier",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
        "verify": "/verify-huid/{huid}",
    }


@app.get("/health", tags=["Info"])
async def health():
    return {"status": "ok", "service": "huid-verifier"}


@app.get(
    "/verify-huid/{huid}",
    response_model=HUIDVerificationResponse,
    tags=["Verification"],
    summary="Verify a BIS hallmark HUID via the BIS CARE Android app",
)
async def verify_huid(huid: str):
    logger.info("Request received — huid=%s", huid)

    # ── 1. Validate format ────────────────────────────────────────────────────
    is_valid, normalised = validate_huid(huid)
    if not is_valid:
        logger.info("Invalid HUID format — input='%s'", huid)
        return HUIDVerificationResponse(
            huid=normalised or huid.strip().upper(),
            status=VerificationStatus.INVALID_FORMAT,
            confidence=0,
            raw_text="",
            error=f"HUID must be exactly 6 alphanumeric characters. Got: '{huid.strip()}'",
        )

    # ── 2. Run Appium automation in thread pool (blocking I/O) ────────────────
    from app.bis_agent import verify_huid_via_app
    from app.parser import parse_result_screen

    loop = asyncio.get_running_loop()
    try:
        agent_result = await loop.run_in_executor(_executor, verify_huid_via_app, normalised)
    except Exception as exc:
        logger.exception("Executor error for huid=%s", normalised)
        return HUIDVerificationResponse(
            huid=normalised,
            status=VerificationStatus.AGENT_ERROR,
            confidence=0,
            raw_text="",
            error=_friendly_error(exc),
        )

    # Sanitise agent-level error messages
    if agent_result.error:
        agent_result.error = _friendly_error_str(agent_result.error)

    # ── 3. Handle agent-level errors ──────────────────────────────────────────
    if agent_result.error:
        logger.error("Agent returned error for huid=%s — %s", normalised, agent_result.error)
        return HUIDVerificationResponse(
            huid=normalised,
            status=VerificationStatus.AGENT_ERROR,
            confidence=0,
            raw_text=agent_result.raw_text if settings.include_raw_text else "",
            screenshot_path=agent_result.screenshot_path,
            error=agent_result.error,
        )

    # ── 4. Parse result screen ────────────────────────────────────────────────
    parsed = parse_result_screen(agent_result.raw_text)
    logger.info(
        "Parse result — huid=%s status=%s confidence=%d purity=%s",
        normalised,
        parsed.status,
        parsed.confidence,
        parsed.purity,
    )

    return HUIDVerificationResponse(
        huid=normalised,
        status=parsed.status,
        confidence=parsed.confidence,
        purity=parsed.purity,
        article_type=parsed.article_type,
        jeweller_name=parsed.jeweller_name,
        hallmark_date=parsed.hallmark_date,
        raw_text=agent_result.raw_text if settings.include_raw_text else "",
        screenshot_path=agent_result.screenshot_path,
    )
