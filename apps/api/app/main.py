"""
GoldEye FastAPI — main entry point.
Provides the stateless POST /api/assess endpoint plus session management.
All signal workers run as async Celery tasks fanned out from /api/assess.
"""
import os
import uuid
import time
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from prometheus_fastapi_instrumentator import Instrumentator

from app.limiter import limiter
from app.routes.session import router as session_router
from app.routes.assess import router as assess_router
from app.routes.dashboard import router as dashboard_router
from app.routes.frame_eval import router as frame_eval_router
from app.routes.otp import router as otp_router
from app.routes.prices import router as prices_router
from app.routes.poonawalla_deals import router as deals_router
from app.routes.gold_price_regional import router as regional_price_router
from app.routes.certificate_ocr import router as certificate_ocr_router
from app.routes.guided_session import router as guided_session_router
from app.routes.live_session import router as live_session_router
from app.routes.video_eval import router as video_eval_router
from app.routes.audio_eval import router as audio_eval_router
from app.decision.ibja import price_metadata, _refresh_async

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("goldeye")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("GoldEye API starting up…")

    # Initialize database schema if it doesn't exist
    try:
        from app.db.database import engine, Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("✓ Database schema initialized")
    except Exception as e:
        logger.error(f"✗ Database initialization failed: {e}")

    await _refresh_async()   # prime IBJA price cache on startup
    yield
    logger.info("GoldEye API shutting down.")


app = FastAPI(
    title="GoldEye API",
    description="AI-powered gold-loan pre-qualification — stateless assessment API.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# CORS — set ALLOWED_ORIGINS env var to a comma-separated list of origins in production
_raw_origins = os.getenv("ALLOWED_ORIGINS", "*")
origins = [o.strip() for o in _raw_origins.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Prometheus metrics setup
Instrumentator().instrument(app).expose(app)


# ─── Request-ID middleware ─────────────────────────────────────────────────────
@app.middleware("http")
async def add_trace_id(request: Request, call_next):
    trace_id = request.headers.get("X-Trace-ID", str(uuid.uuid4()))
    request.state.trace_id = trace_id
    t0 = time.time()
    response = await call_next(request)
    response.headers["X-Trace-ID"] = trace_id
    response.headers["X-Response-Time-Ms"] = str(int((time.time() - t0) * 1000))
    return response


# ─── Routes ────────────────────────────────────────────────────────────────────
app.include_router(session_router,        prefix="/session",       tags=["Session"])
app.include_router(assess_router,         prefix="/api",           tags=["Assessment"])
app.include_router(dashboard_router,      prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(frame_eval_router,                              tags=["FrameEval"])
app.include_router(otp_router,                                     tags=["OTP"])
app.include_router(prices_router,         prefix="/api",           tags=["Assessment"])
app.include_router(deals_router,          prefix="/api",           tags=["Deals"])
app.include_router(regional_price_router, prefix="/api",           tags=["Prices"])
app.include_router(certificate_ocr_router,prefix="/api",           tags=["OCR"])
app.include_router(guided_session_router, prefix="/api",           tags=["GuidedSession"])
app.include_router(live_session_router,   prefix="/api",           tags=["LiveSession"])
app.include_router(video_eval_router,     prefix="/api",           tags=["VideoEval"])
app.include_router(audio_eval_router,     prefix="/api",           tags=["AudioEval"])


@app.get("/health", tags=["Infra"])
async def health():
    ibja = price_metadata()
    return {
        "status": "ok",
        "service": "goldeye-api",
        "version": "0.1.0",
        "ibja_price_per_g_24k": ibja["prices"]["24K"],
        "ibja_source": ibja["source"],
        "ibja_age_s": ibja["age_s"],
    }


@app.get("/api/price", tags=["Assessment"])
async def gold_price():
    """Current IBJA gold price used in assessments. Cached; refreshes hourly."""
    return price_metadata()


@app.get("/api/health/models", tags=["Infra"])
async def model_health():
    """Returns loaded state of each ONNX/ML model."""
    # Import module-level session objects — do not reload
    from app.data import audio as audio_mod
    from app.data import convnext as convnext_mod

    # Trigger lazy loads if not yet done
    audio_mod._load_audio_onnx()
    convnext_mod._load_session()

    # Fusion models
    fusion_lgbm_loaded = False
    fusion_mapie_loaded = False
    try:
        from app.workers.fusion import _lgbm_model, _mapie_model
        fusion_lgbm_loaded = _lgbm_model is not None
        fusion_mapie_loaded = _mapie_model is not None
    except (ImportError, AttributeError):
        pass

    # Catalog pHashes count
    catalog_count = 0
    try:
        from app.workers.s9_reverse_catalog import _catalog_hashes, _load_catalog
        _load_catalog()
        catalog_count = int(len(_catalog_hashes))
    except (ImportError, AttributeError):
        pass

    return {
        "fusion_lgbm": fusion_lgbm_loaded,
        "fusion_mapie": fusion_mapie_loaded,
        "convnext_solid": convnext_mod._session is not None,
        "audio_cnn": audio_mod._ONNX_SESSION is not None,
        "catalog_phashes_count": catalog_count,
    }


# ── Serve React PWA (must be last — catches all non-API routes) ───────────────
_WEB_DIST = os.path.join(os.path.dirname(__file__), "..", "..", "..", "apps", "web", "dist")
_WEB_DIST = os.path.normpath(_WEB_DIST)

if os.path.isdir(_WEB_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(_WEB_DIST, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        # Serve specific files (sw.js, manifest, etc.) directly
        candidate = os.path.join(_WEB_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        # All other routes → index.html (React Router handles it)
        return FileResponse(os.path.join(_WEB_DIST, "index.html"))
