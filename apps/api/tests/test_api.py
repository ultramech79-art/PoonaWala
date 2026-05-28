"""
Smoke + integration tests for the GoldEye API.
Run: cd apps/api && pytest tests/ -v
"""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

pytestmark = pytest.mark.asyncio

ASSESS_PAYLOAD = {
    "session_id": "test-session-001",
    "frames": [
        "local://test-session-001/top",
        "local://test-session-001/45deg",
        "local://test-session-001/side",
        "local://test-session-001/macro",
    ],
    "weight_g": 8.2,
    "reference_object": "rs10_coin",
    "lang": "en",
    "device_metadata": {"capture_count": 7, "ua": "pytest"},
}


@pytest.fixture
async def client():
    from app.db.database import engine, Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_session_init(client):
    r = await client.post("/session/init", json={"lang": "en"})
    assert r.status_code == 200
    data = r.json()
    assert "session_id" in data
    assert data["session_id"]


async def test_session_consent(client):
    init = await client.post("/session/init", json={"lang": "hi"})
    sid = init.json()["session_id"]
    r = await client.post("/session/consent", json={"session_id": sid, "version": "v1.0"})
    assert r.status_code == 200
    assert r.json()["session_id"] == sid


async def test_assess_returns_valid_schema(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    data = r.json()

    assert data["schema_version"] == "1.0"
    assert data["session_id"] == ASSESS_PAYLOAD["session_id"]

    purity = data["purity"]
    assert purity["band_low_karat"] <= purity["point_estimate_karat"] <= purity["band_high_karat"]
    assert 14 <= purity["point_estimate_karat"] <= 24

    weight = data["weight"]
    assert weight["band_low_g"] <= weight["estimated_g"] <= weight["band_high_g"]

    vi = data["value_inr"]
    assert vi["band_low"] <= vi["band_high"]

    lo = data["loan_offer"]
    assert lo["band_low_inr"] <= lo["band_high_inr"]
    assert lo["ltv_applied_pct"] == 75   # RBI ceiling is 75% for NBFCs
    assert lo["tier"] in ("under_2_5L", "above_2_5L")

    conf = data["confidence"]
    assert 0.0 <= conf["score"] <= 1.0
    assert conf["coverage_guarantee_pct"] == 90

    assert data["routing"] in ("INSTANT", "AGENT", "RECAPTURE", "REJECT")
    assert len(data["xai"]["shap_top_features"]) > 0
    assert data["audit"]["trace_id"]


async def test_assess_without_weight(client):
    payload = {k: v for k, v in ASSESS_PAYLOAD.items() if k != "weight_g"}
    r = await client.post("/api/assess", json=payload)
    assert r.status_code == 200
    assert r.json()["weight"]["method"] == "depth_volume_x_density"


async def test_assess_graceful_degradation_no_audio(client):
    r = await client.post("/api/assess", json={**ASSESS_PAYLOAD, "audio": None})
    assert r.status_code == 200
    assert r.json()["routing"] in ("INSTANT", "AGENT", "RECAPTURE", "REJECT")


async def test_assess_rbi_ltv_for_small_loans(client):
    r = await client.post("/api/assess", json={**ASSESS_PAYLOAD, "weight_g": 5.0})
    assert r.status_code == 200
    assert r.json()["loan_offer"]["ltv_applied_pct"] == 75  # RBI ceiling is 75% for NBFCs


async def test_session_not_found(client):
    r = await client.post("/session/consent", json={"session_id": "nonexistent-id"})
    assert r.status_code == 404


async def test_assess_response_headers(client):
    r = await client.post("/api/assess", json=ASSESS_PAYLOAD)
    assert r.status_code == 200
    assert "x-trace-id" in r.headers
    assert "x-response-time-ms" in r.headers
