import base64
import importlib
import json

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


async def test_s14_compares_selfie_and_all_video_frames(monkeypatch):
    s14 = importlib.import_module("app.workers.s14_item_consistency")

    seen = []

    async def fake_compare(reference_image, candidate_image, reference_frame_type="top", candidate_frame_type="unknown", **_):
        seen.append(candidate_frame_type)
        return {
            "same_item": True,
            "verdict": "same",
            "same_item_score": 0.9,
            "confidence": 0.8,
            "method": "fake",
            "matching_signals": [],
            "mismatch_reasons": [],
        }

    monkeypatch.setattr(s14, "compare_item_images", fake_compare)

    frames = ["top", "45", "side", "macro"] + [f"video-{i}" for i in range(11)]
    result = await s14.run("same-item-test", frames, selfie_url="selfie")

    assert result.error is None
    assert seen == ["45deg", "side", "macro"] + [f"video_{i}" for i in range(11)] + ["selfie"]
    assert result.payload["frames_compared"] == 15


async def test_video_eval_checks_and_stores_all_11_frames(monkeypatch):
    from app.routes import video_eval as mod

    checked = []
    stored = []

    async def fake_gemini_request(*_, **__):
        payload = {
            "wear_score": 90,
            "edge_substrate_score": 90,
            "luster_score": 90,
            "surface_originality_score": 90,
            "hue_score": 90,
            "video_score": 90,
            "wear_observation": "consistent wear",
            "edge_observation": "consistent edges",
            "luster_observation": "warm luster",
            "surface_observation": "clean surface",
            "red_flags": [],
            "positive_signals": ["consistent item"],
            "purity_estimate": None,
            "guidance": "Looks good.",
        }
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]}, True

    async def fake_compare(reference_image, candidate_image, reference_frame_type="top", candidate_frame_type="unknown", **_):
        checked.append(candidate_frame_type)
        return {
            "same_item": True,
            "verdict": "same",
            "same_item_score": 0.9,
            "confidence": 0.8,
            "method": "fake",
            "matching_signals": [],
            "mismatch_reasons": [],
        }

    async def fake_store(session_id, frame_type, image_source, same_item=None, content_type="image/jpeg"):
        stored.append(frame_type)
        return {"id": len(stored), "frame_type": frame_type}

    monkeypatch.setattr(mod, "_gemini_request", fake_gemini_request)
    monkeypatch.setattr(mod, "compare_item_images", fake_compare)
    monkeypatch.setattr(mod, "store_capture_asset", fake_store)

    req = mod.VideoEvalRequest(
        frames_b64=["AAAA"] * 11,
        language="en",
        session_id="video-test",
        reference_image_data_url="data:image/jpeg;base64,AAAA",
    )
    result = await mod.video_eval(req)

    assert result.video_score == 90
    assert checked == [f"video_{i}" for i in range(11)]
    assert stored == [f"video_{i}" for i in range(11)]
    assert result.same_item["frames_checked"] == 11
