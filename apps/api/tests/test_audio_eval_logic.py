import base64
import asyncio

import numpy as np


def _samples_b64(arr: np.ndarray) -> str:
    return base64.b64encode(arr.astype(np.float32).tobytes()).decode()


def _multi_tap(sr: int = 16000, freq: float = 720.0, decay: float = 0.10) -> np.ndarray:
    arr = np.zeros(sr * 3, dtype=np.float32)
    for at_s, amp in [(0.45, 0.22), (1.05, 0.18), (1.65, 0.16)]:
        start = int(at_s * sr)
        n = int(0.45 * sr)
        t = np.arange(n, dtype=np.float32) / sr
        impulse = amp * np.sin(2 * np.pi * freq * t) * np.exp(-t / decay)
        arr[start:start + n] += impulse.astype(np.float32)
    rng = np.random.default_rng(7)
    arr += rng.normal(0.0, 0.001, size=len(arr)).astype(np.float32)
    return arr


def test_necklace_tap_mode_accepts_multiple_soft_impulses():
    from app.routes.audio_eval import AudioEvalRequest, audio_eval

    sr = 16000
    response = asyncio.run(audio_eval(AudioEvalRequest(
        samples_b64=_samples_b64(_multi_tap(sr=sr)),
        sample_rate=sr,
        language="en",
        ornament_type="necklace",
        test_mode="tap",
    )))

    assert response.valid is True
    assert response.test_mode == "tap"
    assert response.event_count >= 2
    assert 0 <= response.score <= 100
    assert response.reject_reason is None


def test_silence_is_rejected_as_unusable_recording():
    from app.routes.audio_eval import AudioEvalRequest, audio_eval

    sr = 16000
    response = asyncio.run(audio_eval(AudioEvalRequest(
        samples_b64=_samples_b64(np.zeros(sr * 2, dtype=np.float32)),
        sample_rate=sr,
        language="en",
        ornament_type="ring",
        test_mode="drop",
    )))

    assert response.valid is False
    assert response.score == 0
    assert response.reject_reason
