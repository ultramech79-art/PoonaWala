"""
Phase 3 tests — Fusion, Calibration & XAI.
Verifies: feature extraction, heuristic fusion, SHAP, text generator, counterfactual.
"""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app.workers.fusion import extract_features, fuse
from app.xai.shap_explainer import explain
from app.xai.text_generator import generate_reasoning, generate_counterfactual

pytestmark = pytest.mark.asyncio  # applies only to async tests

ASSESS_PAYLOAD = {
    "session_id": "phase3-test-001",
    "frames": [
        "local://phase3-test-001/top",
        "local://phase3-test-001/45deg",
        "local://phase3-test-001/side",
        "local://phase3-test-001/macro",
    ],
    "weight_g": 8.2,
    "reference_object": "rs10_coin",
    "lang": "en",
    "device_metadata": {"capture_count": 7, "ua": "pytest"},
}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ─── Unit tests: fusion ───────────────────────────────────────────────────────

def test_extract_features_returns_all_columns():
    signals = {
        "s1": {"purity_mark": "22K916", "stamp_appearance": "laser_engraved"},
        "s1_conf": 0.9,
        "s2": {"hallmark_quality_score": 0.92},
        "s5": {"coin_detected": True, "jewelry_area_px2": 42000},
        "s6": {"estimated_weight_g": 8.2, "method": "hybrid"},
        "s7": {"solid_probability": 0.93},
        "s8": {"estimated_karat_band": [20, 22], "confidence": 0.88},
        "s8_conf": 0.88,
        "s10": {"telemetry_anomaly_score": 0.03},
        "s11": {"solid_probability": 0.89},
        "s11_conf": 0.87,
    }
    from app.workers.fusion import FEATURE_COLUMNS
    features = extract_features(signals)
    for col in FEATURE_COLUMNS:
        assert col in features, f"Missing feature: {col}"
    assert features["huid_verified"] == 1.0
    assert features["coin_detected"] == 1.0
    assert features["weight_method_hybrid"] == 1.0


def test_fuse_heuristic_returns_valid_bands():
    features = {
        "huid_verified": 1.0,
        "ocr_confidence": 0.9,
        "hallmark_quality_score": 0.92,
        "coin_detected": 1.0,
        "jewelry_area_px2": 42000.0,
        "estimated_weight_g": 8.2,
        "weight_method_hybrid": 1.0,
        "solid_probability_s7": 0.93,
        "vlm_confidence": 0.88,
        "vlm_karat_mid": 21.0,
        "telemetry_anomaly_score": 0.03,
        "audio_solid_probability": 0.89,
        "audio_confidence": 0.87,
    }
    result = fuse(features, manual_weight_g=8.2)
    assert result["karat_lo"] <= result["point_karat"] <= result["karat_hi"]
    assert 14 <= result["point_karat"] <= 24
    assert result["weight_lo_g"] <= result["final_weight_g"] <= result["weight_hi_g"]
    assert result["value_lo_inr"] <= result["value_hi_inr"]
    assert result["calibration_method"] in ("none", "split_conformal")


def test_fuse_no_huid_lowers_karat_confidence():
    features_with_huid = {
        "huid_verified": 1.0, "ocr_confidence": 0.9, "hallmark_quality_score": 0.9,
        "coin_detected": 1.0, "jewelry_area_px2": 40000.0, "estimated_weight_g": 8.0,
        "weight_method_hybrid": 1.0, "solid_probability_s7": 0.9, "vlm_confidence": 0.85,
        "vlm_karat_mid": 22.0, "telemetry_anomaly_score": 0.02,
        "audio_solid_probability": 0.9, "audio_confidence": 0.85,
    }
    features_no_huid = {**features_with_huid, "huid_verified": 0.0, "ocr_confidence": 0.3}
    r1 = fuse(features_with_huid)
    r2 = fuse(features_no_huid)
    # Without HUID, karat band should be same width or wider (more uncertainty)
    band_with = r1["karat_hi"] - r1["karat_lo"]
    band_without = r2["karat_hi"] - r2["karat_lo"]
    assert band_without >= band_with


# ─── Unit tests: SHAP ─────────────────────────────────────────────────────────

def test_explain_returns_top5_features():
    features = {
        "huid_verified": 1.0, "solid_probability_s7": 0.9,
        "weight_method_hybrid": 1.0, "audio_solid_probability": 0.89,
        "vlm_confidence": 0.88,
    }
    result = explain(features)
    assert len(result) == 5
    for item in result:
        assert "feature" in item
        assert "contribution" in item
        assert isinstance(item["contribution"], float)


# ─── Unit tests: text generator ──────────────────────────────────────────────

def test_reasoning_instant_english():
    text = generate_reasoning("INSTANT", 0.92, lang="en")
    assert "BIS" in text or "hallmark" in text.lower() or "✓" in text


def test_reasoning_reject_hindi():
    text = generate_reasoning("REJECT", 0.35, lang="hi")
    assert "35" in text or "विश्वास" in text


def test_reasoning_agent_confidence_substituted():
    text = generate_reasoning("AGENT", 0.72, lang="en")
    assert "72" in text


def test_counterfactual_none_for_instant():
    cf = generate_counterfactual("INSTANT", True, 0.92, lang="en")
    assert cf is None


def test_counterfactual_suggests_huid_when_missing():
    cf = generate_counterfactual("AGENT", False, 0.65, lang="en")
    assert cf is not None
    assert "hallmark" in cf.lower() or "BIS" in cf


def test_counterfactual_hindi():
    cf = generate_counterfactual("AGENT", False, 0.65, lang="hi")
    assert cf is not None


# ─── Integration tests ────────────────────────────────────────────────────────

async def test_assess_xai_shap_present(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    data = r.json()
    shap = data["xai"]["shap_top_features"]
    assert len(shap) >= 3
    features_returned = {s["feature"] for s in shap}
    assert "huid_verified" in features_returned or "plated_solid_score" in features_returned


async def test_assess_calibration_method_in_schema(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    cal = r.json()["confidence"]["calibration_method"]
    assert cal in ("none", "split_conformal")


async def test_assess_reasoning_text_non_empty(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    text = r.json()["reasoning_text"]["text"]
    assert len(text) > 10


async def test_assess_hindi_lang(client):
    r = await client.post("/api/assess", json={**ASSESS_PAYLOAD, "lang": "hi"})
    assert r.status_code == 200
    assert r.json()["reasoning_text"]["lang"] == "hi"


async def test_assess_value_bands_ordered(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    d = r.json()
    assert d["value_inr"]["band_low"] <= d["value_inr"]["band_high"]
    assert d["loan_offer"]["band_low_inr"] <= d["loan_offer"]["band_high_inr"]
