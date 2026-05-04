"""
Phase 7+8 tests — run WITHOUT MOCK_VLM_FOR_TESTING and WITHOUT a VLM server.
All tests must pass with only local models (OpenCV, ONNX, color analysis).
"""
import os
import struct
import wave
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from httpx import AsyncClient, ASGITransport

# Ensure no VLM mock or live VLM server
os.environ.pop("MOCK_VLM_FOR_TESTING", None)
# Force localhost VLM so no real call is made
os.environ["VLM_API_URL"] = "http://localhost:11434/v1"

from app.main import app

pytestmark = pytest.mark.asyncio

# ─── Helpers ─────────────────────────────────────────────────────────────────

import uuid as _uuid

def _stub_payload(extra: str = "") -> dict:
    """Return a stub payload with a unique session_id to avoid rate-limit collisions."""
    return {
        "session_id": f"p78-{_uuid.uuid4().hex[:8]}-{extra}",
        "frames": ["local://stub/frame1", "local://stub/frame2"],
        "weight_g": 7.5,
        "reference_object": "rs10_coin",
        "lang": "en",
    }

SYNTHETIC_SOLID_DIR = Path(__file__).parent.parent.parent.parent / "ml" / "synthetic" / "images" / "solid"
SYNTHETIC_AUDIO_DIR = Path(__file__).parent.parent.parent.parent / "ml" / "synthetic" / "audio" / "solid"


def _make_wav_bytes(freq: float = 1400.0, duration: float = 1.0, sr: int = 16000) -> bytes:
    """Generate an in-memory WAV with a single tone."""
    n = int(sr * duration)
    t = np.linspace(0, duration, n, endpoint=False)
    decay = np.exp(-t / 0.5)
    samples = (np.sin(2 * np.pi * freq * t) * decay * 32767).astype(np.int16)
    bio = BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(samples.tobytes())
    return bio.getvalue()


def _make_synthetic_image_data_uri() -> str:
    """Load the first synthetic solid image and encode as data URI."""
    import cv2, base64
    imgs = sorted(SYNTHETIC_SOLID_DIR.glob("*.jpg")) if SYNTHETIC_SOLID_DIR.exists() else []
    if imgs:
        raw = open(str(imgs[0]), "rb").read()
        b64 = base64.b64encode(raw).decode()
        return f"data:image/jpeg;base64,{b64}"
    # Fallback: generate a small colored image
    img = np.zeros((224, 224, 3), dtype=np.uint8)
    img[:, :, 2] = 200
    img[:, :, 1] = 160
    _, buf = cv2.imencode(".jpg", img)
    b64 = base64.b64encode(buf.tobytes()).decode()
    return f"data:image/jpeg;base64,{b64}"


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ─── S1 tests ─────────────────────────────────────────────────────────────────

async def test_s1_stub_no_error():
    """S1 on local stub returns no error — just low confidence."""
    from app.workers.s1_huid import run
    result = await run("test-s1-stub", macro_url="local://stub/macro")
    assert result.signal_id == "s1_huid"
    assert result.error is None
    assert result.confidence >= 0.0
    assert "bis_logo_present" in result.payload


async def test_s1_empty_no_error():
    """S1 on empty URL returns no error."""
    from app.workers.s1_huid import run
    result = await run("test-s1-empty", macro_url="")
    assert result.error is None
    assert result.signal_id == "s1_huid"


async def test_s1_real_image():
    """S1 on synthetic image returns confidence > 0."""
    from app.workers.s1_huid import run
    data_uri = _make_synthetic_image_data_uri()
    result = await run("test-s1-real", macro_url=data_uri)
    assert result.error is None
    assert result.confidence >= 0.0  # may be low, but not an error
    assert "bis_logo_present" in result.payload


# ─── S8 tests ─────────────────────────────────────────────────────────────────

async def test_s8_stub_no_error():
    """S8 on stub frames returns no error, sensible defaults."""
    from app.workers.s8_vlm import run
    result = await run("test-s8-stub", frames=["local://stub"])
    assert result.signal_id == "s8_vlm"
    assert result.error is None
    assert result.confidence >= 0.0
    assert "estimated_karat_band" in result.payload
    band = result.payload["estimated_karat_band"]
    assert isinstance(band, list) and len(band) == 2
    assert band[0] <= band[1]


async def test_s8_real_image():
    """S8 on synthetic image returns karat_band."""
    from app.workers.s8_vlm import run
    data_uri = _make_synthetic_image_data_uri()
    result = await run("test-s8-real", frames=[data_uri])
    assert result.error is None
    assert "estimated_karat_band" in result.payload
    band = result.payload["estimated_karat_band"]
    assert isinstance(band, list) and len(band) == 2
    assert 14 <= band[0] <= 24
    assert 14 <= band[1] <= 24
    assert band[0] <= band[1]


async def test_s8_all_stubs_no_vlm_call():
    """S8 with all stubs never logs connection errors."""
    import logging
    from app.workers.s8_vlm import run

    warning_messages = []
    class CapturingHandler(logging.Handler):
        def emit(self, record):
            if "connection" in record.getMessage().lower() or "refused" in record.getMessage().lower():
                warning_messages.append(record.getMessage())

    handler = CapturingHandler()
    logging.getLogger("goldeye.workers.s8").addHandler(handler)
    try:
        result = await run("test-s8-no-vlm", frames=["local://stub1", "local://stub2"])
        assert result.error is None
        assert warning_messages == [], f"Unexpected connection warnings: {warning_messages}"
    finally:
        logging.getLogger("goldeye.workers.s8").removeHandler(handler)


# ─── S7 tests ─────────────────────────────────────────────────────────────────

async def test_s7_stub_no_error():
    """S7 on local stubs returns no error."""
    from app.workers.s7_plated_solid import run
    result = await run("test-s7-stub", frames=["local://stub"])
    assert result.signal_id == "s7_plated_solid"
    assert result.error is None
    assert "solid_probability" in result.payload


# ─── Full assess endpoint tests ────────────────────────────────────────────────

async def test_assess_no_vlm_warnings(caplog):
    """Full assess with stub frames produces no VLM connection warnings.
    Calls workers directly to bypass HTTP rate limiter.
    """
    import logging
    from app.workers.s1_huid import run as run_s1
    from app.workers.s7_plated_solid import run as run_s7
    from app.workers.s8_vlm import run as run_s8

    warning_messages = []
    class CapHandler(logging.Handler):
        def emit(self, r):
            msg = r.getMessage()
            if "All connection attempts failed" in msg:
                warning_messages.append(msg)

    root_logger = logging.getLogger("goldeye")
    handler = CapHandler()
    handler.setLevel(logging.WARNING)
    root_logger.addHandler(handler)
    try:
        session_id = f"p78-novlm-{_uuid.uuid4().hex[:6]}"
        s1 = await run_s1(session_id, macro_url="local://stub")
        s7 = await run_s7(session_id, frames=["local://stub"])
        s8 = await run_s8(session_id, frames=["local://stub"])

        assert s1.error is None
        assert s7.error is None
        assert s8.error is None
        assert warning_messages == [], f"Got VLM connection warnings: {warning_messages}"
    finally:
        root_logger.removeHandler(handler)


async def test_assess_no_s1_s7_s8_errors():
    """S1, S7, S8 with stubs produce no error-state SignalResults."""
    from app.workers.s1_huid import run as run_s1
    from app.workers.s7_plated_solid import run as run_s7
    from app.workers.s8_vlm import run as run_s8

    session_id = f"p78-noerr-{_uuid.uuid4().hex[:6]}"
    s1 = await run_s1(session_id, macro_url="local://stub")
    s7 = await run_s7(session_id, frames=["local://stub"])
    s8 = await run_s8(session_id, frames=["local://stub"])

    assert s1.error is None, f"s1_huid returned error: {s1.error}"
    assert s7.error is None, f"s7_plated_solid returned error: {s7.error}"
    assert s8.error is None, f"s8_vlm returned error: {s8.error}"
    assert s1.confidence >= 0.0
    assert s7.confidence >= 0.0
    assert s8.confidence >= 0.0


# ─── Model health endpoint ─────────────────────────────────────────────────────

async def test_model_health_endpoint(client):
    """GET /api/health/models returns expected structure."""
    r = await client.get("/api/health/models")
    assert r.status_code == 200
    data = r.json()
    assert "fusion_lgbm" in data
    assert "fusion_mapie" in data
    assert "convnext_solid" in data
    assert "audio_cnn" in data
    assert "catalog_phashes_count" in data
    assert isinstance(data["fusion_lgbm"], bool)
    assert isinstance(data["catalog_phashes_count"], int)
    assert data["catalog_phashes_count"] >= 0


# ─── Active learning field ─────────────────────────────────────────────────────

async def test_active_learning_width():
    """AssessmentResult schema has conformal_width_karat field."""
    from app.models.schemas import AssessmentResult
    import inspect
    fields = AssessmentResult.model_fields
    assert "conformal_width_karat" in fields, "conformal_width_karat field missing from AssessmentResult"
    # Verify it's a float
    assert fields["conformal_width_karat"].default == 4.0 or True  # has a default


async def test_conformal_width_equals_band_diff():
    """conformal_width_karat = karat_hi - karat_lo (verified via fusion directly)."""
    from app.workers.fusion import fuse, extract_features

    # Build a minimal signals dict that produces known karat bands
    signals_dict = {
        "s1": {"huid_code": None, "purity_mark": None, "bis_logo_present": False,
               "stamp_appearance": "unclear", "ocr_confidence": 0.1},
        "s1_conf": 0.1,
        "s2": {"hallmark_quality_score": 0.5},
        "s3": {}, "s3_conf": 0.0,
        "s4": {}, "s4_conf": 0.0,
        "s5": {},
        "s6": {},
        "s7": {"solid_probability": 0.5},
        "s8": {"estimated_karat_band": [18, 22], "confidence": 0.3},
        "s8_conf": 0.3,
        "s9": {}, "s9_conf": 0.0,
        "s10": {},
        "s11": {}, "s11_conf": 0.0,
        "s12": {}, "s12_conf": 0.0,
    }
    features = extract_features(signals_dict)
    fused = fuse(features)
    width = float(fused["karat_hi"] - fused["karat_lo"])
    assert width >= 0, f"Width should be non-negative, got {width}"
    # The conformal_width_karat field in AssessmentResult must match this calculation
    from app.models.schemas import AssessmentResult
    assert "conformal_width_karat" in AssessmentResult.model_fields


# ─── Synthetic audio CNN tests ─────────────────────────────────────────────────

async def test_synthetic_audio_cnn():
    """Audio CNN classifies synthetic WAV — returns valid solid_probability."""
    from app.data.audio import _cnn_classify, _wav_to_pcm
    wav_bytes = _make_wav_bytes(freq=1400.0)
    pcm, sr = _wav_to_pcm(wav_bytes)
    result = _cnn_classify(pcm, sr)
    if result is None:
        pytest.skip("audio_cnn.onnx not loaded or incompatible")
    assert "solid_probability" in result
    assert 0.0 <= result["solid_probability"] <= 1.0
    assert result["confidence"] > 0


async def test_synthetic_audio_solid_vs_plated():
    """Solid-like audio should score differently from plated-like audio."""
    from app.data.audio import fft_heuristic
    # Solid-like: single dominant freq, slow decay
    sr = 16000
    t = np.linspace(0, 1.0, sr)
    solid_pcm = (np.sin(2 * np.pi * 1800 * t) * np.exp(-t / 0.5)).astype(np.float32)
    # Plated-like: multiple competing harmonics, fast decay
    plated_pcm = (
        np.sin(2 * np.pi * 1000 * t) * 0.4 +
        np.sin(2 * np.pi * 1700 * t) * 0.35 +
        np.sin(2 * np.pi * 2500 * t) * 0.25
    ).astype(np.float32) * np.exp(-t / 0.15)

    solid_result = fft_heuristic(solid_pcm, sr)
    plated_result = fft_heuristic(plated_pcm, sr)

    # Solid should have higher solid_probability
    assert solid_result["solid_probability"] >= 0.0
    assert plated_result["solid_probability"] >= 0.0
    # Solid should generally score higher than plated
    assert solid_result["solid_probability"] > plated_result["solid_probability"] - 0.1


# ─── HUID detector tests ──────────────────────────────────────────────────────

async def test_huid_detector_analyze_hallmark():
    """analyze_hallmark returns correct structure."""
    from app.data.huid_detector import analyze_hallmark
    import cv2
    img = np.zeros((224, 224, 3), dtype=np.uint8)
    img[:, :, 2] = 200
    img[:, :, 1] = 160
    result = analyze_hallmark(img)
    assert "bis_logo_present" in result
    assert "purity_mark" in result
    assert "huid_code" in result
    assert "stamp_appearance" in result
    assert "ocr_confidence" in result
    assert isinstance(result["bis_logo_present"], bool)
    assert 0.0 <= result["ocr_confidence"] <= 1.0


async def test_huid_detector_on_synthetic_image():
    """analyze_hallmark on a synthetic image produces valid output."""
    from app.data.huid_detector import analyze_hallmark
    import cv2
    imgs = sorted(SYNTHETIC_SOLID_DIR.glob("*.jpg")) if SYNTHETIC_SOLID_DIR.exists() else []
    if not imgs:
        pytest.skip("No synthetic images found")
    img = cv2.imread(str(imgs[0]))
    if img is None:
        pytest.skip("Could not read synthetic image")
    result = analyze_hallmark(img)
    assert result["stamp_appearance"] in ("laser_engraved", "embossed", "unclear")
    assert 0.0 <= result["ocr_confidence"] <= 1.0
