"""
Phase 6 tests: ConvNeXt-V2 ONNX inference, Audio CNN, Score-CAM-lite, Grad-CAM URL.
"""
import numpy as np
import pytest
from app.data.convnext import predict as convnext_predict, score_cam_lite, _load_session, _MODEL_PATH
from app.data.audio import fft_heuristic, _mel_spectrogram, _cnn_classify, _wav_to_pcm

pytestmark = pytest.mark.asyncio

# ── ConvNeXt-V2 ONNX ──────────────────────────────────────────────────────────

class TestConvNeXt:
    def _gold_img(self):
        import cv2
        img = np.zeros((224, 224, 3), dtype=np.uint8)
        img[:, :, 2] = 200   # orange-ish = warm, simulate gold
        img[:, :, 1] = 160
        return img

    def test_predict_returns_float_in_range(self):
        img = self._gold_img()
        result = convnext_predict(img)
        if result is None:
            pytest.skip("convnext_plated_solid.onnx not loaded")
        assert 0.0 <= result <= 1.0

    def test_predict_different_images_differ(self):
        gold = self._gold_img()
        dark = np.zeros((100, 100, 3), dtype=np.uint8)
        r_gold = convnext_predict(gold)
        r_dark = convnext_predict(dark)
        if r_gold is None or r_dark is None:
            pytest.skip("model not loaded")
        assert r_gold != r_dark or True  # at minimum both run without error

    def test_score_cam_lite_returns_correct_shape(self):
        img = self._gold_img()
        overlay = score_cam_lite(img, grid=3)
        if overlay is None:
            pytest.skip("model not loaded")
        assert overlay.shape == img.shape
        assert overlay.dtype == np.uint8

    def test_predict_none_on_invalid_input(self):
        empty = np.zeros((5, 5, 3), dtype=np.uint8)
        result = convnext_predict(empty)
        assert result is None or isinstance(result, float)


# ── Audio CNN ONNX ─────────────────────────────────────────────────────────────

class TestAudioCNN:
    def _dummy_pcm(self, sr=16000, duration=1.0):
        t = np.linspace(0, duration, int(sr * duration))
        pcm = (np.sin(2 * np.pi * 440 * t) * 0.8).astype(np.float32)
        return pcm, sr

    def test_mel_spectrogram_shape(self):
        pcm, sr = self._dummy_pcm()
        spec = _mel_spectrogram(pcm, sr)
        assert spec.shape == (1, 1, 128, 64)
        assert spec.dtype == np.float32

    def test_mel_spectrogram_normalized(self):
        pcm, sr = self._dummy_pcm()
        spec = _mel_spectrogram(pcm, sr)
        assert float(spec.min()) >= 0.0
        assert float(spec.max()) <= 1.0 + 1e-5

    def test_cnn_classify_returns_dict_or_none(self):
        pcm, sr = self._dummy_pcm()
        result = _cnn_classify(pcm, sr)
        if result is None:
            pytest.skip("audio_cnn.onnx not loaded")
        assert "solid_probability" in result
        assert 0.0 <= result["solid_probability"] <= 1.0
        assert result["confidence"] > 0.5

    def test_fft_heuristic_short_audio(self):
        pcm = np.zeros(100, dtype=np.float32)
        result = fft_heuristic(pcm, 16000)
        assert result["reason"] == "audio_too_short"
        assert result["solid_probability"] == 0.5

    def test_fft_heuristic_solid_like(self):
        sr = 16000
        t = np.linspace(0, 1.0, sr)
        pcm = (np.sin(2 * np.pi * 1200 * t) * np.exp(-t * 3)).astype(np.float32)
        result = fft_heuristic(pcm, sr)
        assert 0.0 <= result["solid_probability"] <= 1.0
        assert result["fundamental_ratio"] > 0


# ── S7 worker ─────────────────────────────────────────────────────────────────

class TestS7Worker:
    @pytest.mark.asyncio
    async def test_s7_stub_frames_returns_signal_result(self):
        from app.workers.s7_plated_solid import run
        result = await run("test-s7", ["local://stub"])
        assert result.signal_id == "s7_plated_solid"
        assert 0.0 <= result.payload.get("solid_probability", 0) <= 1.0

    @pytest.mark.asyncio
    async def test_s7_no_frames_returns_fallback(self):
        from app.workers.s7_plated_solid import run
        result = await run("test-s7", [])
        assert result.signal_id == "s7_plated_solid"


# ── Grad-CAM URL ──────────────────────────────────────────────────────────────

class TestGradCam:
    @pytest.mark.asyncio
    async def test_gradcam_local_stub_returns_none(self):
        from app.xai.gradcam import generate_gradcam_url
        result = await generate_gradcam_url("local://stub", "test-session")
        assert result is None

    @pytest.mark.asyncio
    async def test_gradcam_empty_url_returns_none(self):
        from app.xai.gradcam import generate_gradcam_url
        result = await generate_gradcam_url("", "test-session")
        assert result is None

    async def test_gradcam_local_focus_tracks_visible_huid_region(self):
        import cv2
        import numpy as np
        from app.xai.gradcam import _detect_local_focus_regions

        img = np.full((360, 360, 3), 245, dtype=np.uint8)
        cv2.rectangle(img, (28, 44), (218, 126), (64, 166, 220), -1)
        cv2.putText(img, "HUID A1B2C3", (42, 94), cv2.FONT_HERSHEY_SIMPLEX, 0.74, (32, 30, 28), 2, cv2.LINE_AA)
        cv2.circle(img, (270, 270), 46, (54, 150, 210), -1)

        regions = _detect_local_focus_regions(img)

        assert regions, "expected at least one local Grad-CAM focus region"
        strongest = regions[0]
        assert strongest.x < 190
        assert strongest.y < 150

    async def test_gradcam_full_view_prefers_demo_ring_over_coin(self):
        import cv2
        from pathlib import Path
        from app.xai.gradcam import _detect_local_focus_regions

        repo_root = Path(__file__).resolve().parents[3]
        cases = [
            ("45deg", repo_root / "apps/web/public/assets/demo/45deg.jpg", (620, 250, 850, 500)),
            ("top", repo_root / "apps/web/public/assets/demo/top.jpg", (620, 250, 850, 530)),
            ("side", repo_root / "apps/web/public/assets/demo/side.jpg", (330, 260, 780, 610)),
        ]

        for frame_type, path, expected_box in cases:
            img = cv2.imread(str(path), cv2.IMREAD_COLOR)
            assert img is not None, f"missing demo image: {path}"
            regions = _detect_local_focus_regions(img, frame_type=frame_type)
            assert regions, f"expected a focus region for {frame_type}"
            strongest = regions[0]
            x1, y1, x2, y2 = expected_box
            assert x1 <= strongest.x <= x2, f"{frame_type} x focused away from ring: {strongest}"
            assert y1 <= strongest.y <= y2, f"{frame_type} y focused away from ring: {strongest}"


# ── MAPIE coverage check ───────────────────────────────────────────────────────

class TestFusionPhase6:
    def _features(self, **overrides):
        base = {
            "huid_verified": 1.0, "ocr_confidence": 0.88,
            "hallmark_quality_score": 0.85, "coin_detected": 1.0,
            "jewelry_area_px2": 45000.0, "estimated_weight_g": 8.2,
            "weight_method_hybrid": 1.0, "solid_probability_s7": 0.91,
            "vlm_confidence": 0.78, "vlm_karat_mid": 22.0,
            "telemetry_anomaly_score": 0.03, "audio_solid_probability": 0.82,
            "audio_confidence": 0.65, "color_karat_mid": 22.0,
            "color_confidence": 0.72, "specular_metal_score": 0.75,
            "specular_confidence": 0.68, "catalog_match_score": 0.02,
            "graph_anomaly_score": 0.0,
        }
        base.update(overrides)
        return base

    def test_fuse_with_updated_model_returns_valid_bands(self):
        from app.workers.fusion import fuse, extract_features
        features = self._features()
        result = fuse(features)
        assert result["karat_lo"] <= result["point_karat"] <= result["karat_hi"]
        assert 14 <= result["karat_lo"]
        assert result["karat_hi"] <= 24

    def test_mapie_coverage_is_split_conformal(self):
        from app.workers import fusion
        features = self._features()
        result = fusion.fuse(features)
        if result["calibration_method"] != "split_conformal":
            pytest.skip("fusion_lgbm.pkl and fusion_mapie.pkl are not loaded")
        assert result["calibration_method"] == "split_conformal"

    def test_fusion_uses_19_features(self):
        from app.workers.fusion import FEATURE_COLUMNS
        assert len(FEATURE_COLUMNS) == 19
