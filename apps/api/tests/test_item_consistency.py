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


def _partial_ring() -> np.ndarray:
    img = np.full((320, 320, 3), 255, dtype=np.uint8)
    cv2.circle(img, (65, 160), 105, (0, 190, 230), 24)
    return img


def _chain_like() -> np.ndarray:
    img = np.full((320, 320, 3), 255, dtype=np.uint8)
    for x in range(40, 280, 35):
        cv2.ellipse(img, (x, 160), (20, 9), 0, 0, 360, (0, 190, 230), 6)
    return img


async def test_item_match_local_same_image(monkeypatch):
    from app.data import item_match

    monkeypatch.setattr(item_match, "GROQ_PRIMARY_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_GUIDANCE_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS", [])
    monkeypatch.setattr(item_match, "detect_coin_hough", lambda *_: None)

    img = _data_uri(_ring())
    result = await item_match.compare_item_images(img, img, candidate_frame_type="45deg")

    assert result["verdict"] == "same"
    assert result["same_item"] is True
    assert result["same_item_score"] == 1.0
    assert result["method"] == "exact_image_match"


async def test_item_match_local_obvious_type_mismatch_blocks(monkeypatch):
    from app.data import item_match

    monkeypatch.setattr(item_match, "GROQ_PRIMARY_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_GUIDANCE_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS", [])
    monkeypatch.setattr(item_match, "detect_coin_hough", lambda *_: None)

    result = await item_match.compare_item_images(
        _data_uri(_ring()),
        _data_uri(_chain_like()),
        candidate_frame_type="side",
    )

    assert result["verdict"] == "different"
    assert result["same_item"] is False
    assert item_match.is_blocking_mismatch(result)


async def test_groq_confirmed_side_mismatch_blocks():
    from app.data import item_match

    result = {
        "verdict": "different",
        "same_item": False,
        "same_item_score": 0.2,
        "confidence": 0.86,
        "method": "groq_multimodal_compare",
        "candidate_frame_type": "side",
    }

    assert item_match.is_blocking_mismatch(result)


async def test_semantic_same_is_vetoed_by_45deg_visual_conflict():
    from app.data import item_match

    semantic_same = {
        "verdict": "same",
        "same_item": True,
        "same_item_score": 0.9,
        "confidence": 0.9,
        "method": "groq_multimodal_compare",
        "candidate_frame_type": "side",
        "local_fingerprint": {
            "verdict": "inconclusive",
            "same_item_score": 0.52,
            "confidence": 0.44,
            "method": "local_visual_fingerprint",
            "reference_frame_type": "45deg",
            "candidate_frame_type": "side",
            "mismatch_reasons": ["item_geometry_changed_from_ring_or_bangle_to_compact_object"],
            "debug": {
                "distinct_type_mismatch": True,
                "shape_score": 0.59,
                "mismatch_signal_count": 1,
            },
        },
    }

    assert item_match._same_verdict_has_visual_conflict(semantic_same)
    hybrid = item_match._hybrid_visual_conflict_result(semantic_same)
    assert hybrid["verdict"] == "different"
    assert hybrid["method"] == "hybrid_visual_semantic_conflict"
    assert item_match.is_blocking_mismatch(hybrid)


async def test_local_side_view_requires_stronger_confirmation():
    from app.data import item_match

    bbox = {
        "width_px": 100,
        "height_px": 70,
        "major_axis_px": 100,
        "minor_axis_px": 70,
        "fill_ratio": 0.45,
        "hollow_ratio": 0.25,
        "area_fraction": 0.08,
        "image_width_px": 320,
        "image_height_px": 320,
        "x_px": 100,
        "y_px": 100,
    }
    ref = {
        "valid": True,
        "bbox": bbox,
        "geometry_class": "compact_or_pendant",
        "aspect": 1.42,
        "fill_ratio": 0.45,
        "hollow_ratio": 0.25,
        "area_fraction": 0.08,
        "mean_lab": [70, 8, 70],
        "metal_fraction": 0.2,
        "phash": 12345,
    }
    cand = {**ref, "phash": 12346}

    result = item_match._local_compare(ref, cand, "45deg", "side")

    assert result["same_item_score"] >= 0.66
    assert result["verdict"] == "inconclusive"
    assert result["same_item"] is None


async def test_top_side_timeout_is_unverified_not_accepted():
    from app.routes import frame_eval

    assert frame_eval._same_item_unverified({
        "method": "same_item_timeout",
        "mismatch_reasons": ["same_item_compare_timeout"],
    }, "top")
    assert frame_eval._same_item_unverified({
        "method": "local_visual_fingerprint_timeout",
        "mismatch_reasons": ["local_fingerprint_timeout"],
    }, "side")
    assert frame_eval._same_item_unverified({
        "method": "local_visual_fingerprint",
        "verdict": "inconclusive",
        "same_item_score": 0.5,
        "mismatch_reasons": [],
    }, "side")
    assert not frame_eval._same_item_unverified({
        "method": "local_visual_fingerprint",
        "verdict": "inconclusive",
        "same_item_score": 0.64,
        "mismatch_reasons": [],
    }, "top")
    assert not frame_eval._same_item_unverified({
        "method": "local_visual_fingerprint_timeout",
        "mismatch_reasons": ["local_fingerprint_timeout"],
    }, "macro")


async def test_partial_top_reference_does_not_block_shape_only_difference(monkeypatch):
    from app.data import item_match

    monkeypatch.setattr(item_match, "GROQ_PRIMARY_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_GUIDANCE_API_KEYS", [])
    monkeypatch.setattr(item_match, "GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS", [])

    result = await item_match.compare_item_images(
        _data_uri(_partial_ring()),
        _data_uri(_ring()),
        reference_frame_type="top",
        candidate_frame_type="side",
        use_remote=False,
    )

    assert result["reference_view_partial"] is True
    assert result["verdict"] != "different"
    assert not item_match.is_blocking_mismatch(result)


async def test_partial_top_reference_needs_stronger_groq_mismatch():
    from app.data import item_match

    moderate = {
        "verdict": "different",
        "same_item": False,
        "same_item_score": 0.25,
        "confidence": 0.86,
        "method": "groq_multimodal_compare",
        "candidate_frame_type": "side",
        "reference_view_partial": True,
    }
    strong = {**moderate, "same_item_score": 0.18, "confidence": 0.92}

    assert not item_match.is_blocking_mismatch(moderate)
    assert item_match.is_blocking_mismatch(strong)


async def test_s14_flags_in_session_mismatch(monkeypatch):
    s14 = importlib.import_module("app.workers.s14_item_consistency")

    async def fake_compare(reference_image, candidate_image, reference_frame_type="top", candidate_frame_type="unknown", use_remote=True, **_):
        if use_remote:
            return {
                "same_item": False,
                "verdict": "different",
                "same_item_score": 0.2,
                "confidence": 0.86,
                "method": "groq_multimodal_compare",
                "candidate_frame_type": candidate_frame_type,
                "matching_signals": [],
                "mismatch_reasons": ["overall_shape_differs"],
            }
        return {
            "same_item": False,
            "verdict": "different",
            "same_item_score": 0.28,
            "confidence": 0.6,
            "method": "local_visual_fingerprint",
            "candidate_frame_type": candidate_frame_type,
            "matching_signals": [],
            "mismatch_reasons": ["overall_shape_differs"],
        }

    monkeypatch.setattr(s14, "compare_item_images", fake_compare)
    monkeypatch.setattr(s14, "_groq_item_api_keys", lambda: ["test-key"])

    result = await s14.run(
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
        seen.append((reference_frame_type, candidate_frame_type))
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
    monkeypatch.setattr(s14, "_groq_item_api_keys", lambda: ["test-key"])

    async def fake_fingerprint_entry(label, url):
        return {"label": label, "url": url, "fp": {"valid": True, "n": 10}}

    def fake_group_by_orb(fingerprints):
        n = len(fingerprints)
        return [[i] for i in range(n)], {(i, j): 0 for i in range(n) for j in range(i + 1, n)}

    monkeypatch.setattr(s14, "_fingerprint_entry", fake_fingerprint_entry)
    monkeypatch.setattr(s14, "group_by_orb", fake_group_by_orb)

    frames = ["top", "45", "side", "macro"] + [f"video-{i}" for i in range(11)]
    result = await s14.run("same-item-test", frames, selfie_url="selfie")

    assert result.error is None
    assert seen == [
        ("top", "45deg"),
        ("45deg", "side"),
        ("side", "macro"),
        ("macro", "video_0"),
        ("video_0", "video_1"),
        ("video_1", "video_2"),
        ("video_2", "selfie"),
    ]
    assert result.payload["frames_compared"] == 8


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


async def test_video_eval_single_non_severe_video_mismatch_does_not_override(monkeypatch):
    from app.routes import video_eval as mod

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

    async def fake_compare(reference_image, candidate_image, reference_frame_type="top", candidate_frame_type="unknown", use_remote=True):
        if candidate_frame_type == "video_0":
            return {
                "same_item": False,
                "verdict": "different",
                "same_item_score": 0.27,
                "confidence": 0.83,
                "method": "groq_multimodal_compare" if use_remote else "local_visual_fingerprint",
                "candidate_frame_type": candidate_frame_type,
                "matching_signals": [],
                "mismatch_reasons": ["overall_shape_differs"],
            }
        return {
            "same_item": True,
            "verdict": "same",
            "same_item_score": 0.9,
            "confidence": 0.8,
            "method": "fake",
            "candidate_frame_type": candidate_frame_type,
            "matching_signals": [],
            "mismatch_reasons": [],
        }

    async def fake_store(*_, **__):
        return {"id": 1}

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
    assert result.verdict == "Likely solid gold"
    assert result.same_item["verdict"] == "different"
    assert result.same_item["blocking_mismatch"] is False
    assert result.same_item["mismatched_frames"] == []
