import pytest
import asyncio
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

@pytest.mark.asyncio
async def test_session_init_and_get():
    # 1. Init
    init_res = client.post("/session/init", json={"lang": "hi", "phone": "+919999999999"})
    assert init_res.status_code == 200
    data = init_res.json()
    session_id = data["session_id"]
    
    # 2. Get
    get_res = client.get(f"/session/{session_id}")
    assert get_res.status_code == 200
    assert get_res.json()["phone"] == "+919999999999"
    assert get_res.json()["status"] == "in_progress"

@pytest.mark.asyncio
async def test_session_finalize_idempotency():
    init_res = client.post("/session/init", json={"lang": "en", "phone": "+918888888888"})
    session_id = init_res.json()["session_id"]
    import uuid
    idem_key = f"IDEM-{uuid.uuid4().hex}"
    
    # First finalize
    fin1 = client.post("/session/finalize", json={
        "session_id": session_id,
        "idempotency_key": idem_key,
        "payload": {"result": "success"}
    })
    assert fin1.status_code == 200
    assert fin1.json()["status"] == "completed"
    
    # Second finalize with same idempotency key
    fin2 = client.post("/session/finalize", json={
        "session_id": session_id,
        "idempotency_key": idem_key,
        "payload": {"result": "different"}
    })
    assert fin2.status_code == 200
    assert fin2.json()["status"] == "already_finalized"
    
    # Check session status
    get_res = client.get(f"/session/{session_id}")
    assert get_res.json()["status"] == "completed"

@pytest.mark.asyncio
async def test_dpdp_delete():
    phone = "+917777777777"
    init_res = client.post("/session/init", json={"lang": "en", "phone": phone})
    session_id = init_res.json()["session_id"]
    
    # Confirm phone is there
    get_res = client.get(f"/session/{session_id}")
    assert get_res.json()["phone"] == phone
    
    # DPDP Delete
    del_res = client.delete(f"/session/dpdp/delete/{phone}")
    assert del_res.status_code == 200
    assert del_res.json()["deleted_sessions"] >= 1
    
    # Confirm phone is redacted
    get_res_after = client.get(f"/session/{session_id}")
    assert get_res_after.json()["phone"] == "REDACTED_DPDP"
