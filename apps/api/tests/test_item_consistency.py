import base64

import cv2
import numpy as np
import pytest


pytestmark = pytest.mark.asyncio


def _data_uri(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("utf-8")


def _ring() -> np.ndarray:
    img = np.full((320, 320, 3), 255, dtype=np.uint8)
    cv2.circle(img, (160, 160), 90, (0, 190, 230), 24)
    return img


def _chain_like() -> np.ndarray:
    img = np.full((320, 320, 3), 255, dtype=np.uint8)
    for x in range(40, 280, 35):
        cv2.ellipse(img, (x, 160), (20, 9), 0, 0, 360, (0, 190, 230), 6)
    return img


async def test_item_match_local_same_image(monkeypatch):
    from app.data import item_match

    monkeypatch.setattr(item_match, "GEMINI_GUIDANCE_FALLBACK_API_KEYS", [])
    monkeypatch.setattr(item_match, "GEMINI_AUDIO_VIDEO_API_KEYS", [])

    img = _data_uri(_ring())
    result = await item_match.compare_item_images(img, img, candidate_frame_type="45deg")

    assert result["verdict"] == "same"
    assert result["same_item"] is True
    assert result["same_item_score"] >= 0.65


async def test_item_match_local_obvious_mismatch(monkeypatch):
    from app.data import item_match

    monkeypatch.setattr(item_match, "GEMINI_GUIDANCE_FALLBACK_API_KEYS", [])
    monkeypatch.setattr(item_match, "GEMINI_AUDIO_VIDEO_API_KEYS", [])

    result = await item_match.compare_item_images(
        _data_uri(_ring()),
        _data_uri(_chain_like()),
        candidate_frame_type="side",
    )

    assert result["verdict"] == "different"
    assert result["same_item"] is False
    assert item_match.is_blocking_mismatch(result)


async def test_s14_flags_in_session_mismatch(monkeypatch):
    from app.data import item_match
    from app.workers.s14_item_consistency import run

    monkeypatch.setattr(item_match, "GEMINI_GUIDANCE_FALLBACK_API_KEYS", [])
    monkeypatch.setattr(item_match, "GEMINI_AUDIO_VIDEO_API_KEYS", [])

    result = await run(
        "same-item-test",
        [_data_uri(_ring()), _data_uri(_chain_like())],
    )

    assert result.error is None
    assert result.payload["same_item_mismatch"] is True
    assert result.payload["item_mismatch_score"] > 0
    assert result.payload["mismatched_frames"]
