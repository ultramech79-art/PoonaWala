import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client():
    from app.db.database import Base, engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_audio_demo_command_is_one_time(client):
    send = await client.post("/api/audio-demo-command", json={"channel_id": "ABCD12", "outcome": "pass"})
    assert send.status_code == 200
    assert send.json()["outcome"] == "pass"

    first_read = await client.get("/api/audio-demo-command/ABCD12")
    assert first_read.status_code == 200
    assert first_read.json()["outcome"] == "pass"
    assert first_read.json()["consumed"] is True

    second_read = await client.get("/api/audio-demo-command/ABCD12")
    assert second_read.status_code == 200
    assert second_read.json()["outcome"] is None
