"""
Audio analysis for S11 PingCoin signal.

MVP path (Phase 2): FFT heuristic on PCM audio.
  - Solid gold: strong fundamental, clean decay, low noise floor
  - Plated/hollow: weaker fundamental, faster decay, higher noise

Phase 6: replace fft_heuristic() with ONNX CNN inference.
  Model: 4-layer 2D CNN on 128-mel log-spectrogram (128 mels × 64 frames).
  Target AUC > 0.85 on held-out set of 200 self-recorded samples.
"""
import base64
import logging
import math
import os
import struct
import wave
from io import BytesIO
from typing import Optional

import httpx
import numpy as np

logger = logging.getLogger("goldeye.ml.audio")

_ONNX_SESSION = None
_ONNX_LOADED = False
_ONNX_MODEL_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "ml", "models", "audio_cnn.onnx"
))


def _load_audio_onnx():
    global _ONNX_SESSION, _ONNX_LOADED
    if _ONNX_LOADED:
        return
    _ONNX_LOADED = True
    if os.path.exists(_ONNX_MODEL_PATH):
        try:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            _ONNX_SESSION = ort.InferenceSession(
                _ONNX_MODEL_PATH, sess_options=opts,
                providers=["CPUExecutionProvider"]
            )
            logger.info(f"Audio CNN model loaded from {_ONNX_MODEL_PATH}")
        except Exception as e:
            logger.warning(f"Audio CNN load failed: {e}")
    else:
        logger.info("audio_cnn.onnx not found — using FFT heuristic only")


async def fetch_audio_bytes(url: str) -> Optional[bytes]:
    if url.startswith("data:"):
        _, encoded = url.split(",", 1)
        return base64.b64decode(encoded)
    import os
    if os.getenv("MOCK_VLM_FOR_TESTING") == "1":
        import wave, io
        bio = io.BytesIO()
        with wave.open(bio, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(8000)
            wf.writeframes(b'\x00\x00' * 8000)
        return bio.getvalue()

    if url.startswith("http://") or url.startswith("https://"):
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.content
    return None


def _wav_to_pcm(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Parse WAV bytes → (float32 mono array, sample_rate). Raises on bad data."""
    with wave.open(BytesIO(audio_bytes), "rb") as wf:
        n_ch = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    if sampwidth == 2:
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        pcm = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2**31
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth}")

    if n_ch > 1:
        pcm = pcm.reshape(-1, n_ch).mean(axis=1)
    return pcm, sr


def fft_heuristic(pcm: np.ndarray, sr: int) -> dict:
    """
    Compute FFT-based solid-gold probability heuristic.

    Key features:
      - fundamental_ratio: power of dominant freq / total power (solid → higher)
      - decay_rate: power drop in first 0.2s (solid → slower decay)
      - noise_floor: mean power below 200Hz (plated → higher noise)
    """
    n = len(pcm)
    if n < sr * 0.1:
        return {"solid_probability": 0.5, "confidence": 0.1, "reason": "audio_too_short"}

    spectrum = np.abs(np.fft.rfft(pcm[:sr]))  # first second
    freqs = np.fft.rfftfreq(sr, 1 / sr)

    total_power = float(np.sum(spectrum ** 2)) + 1e-9
    dominant_idx = int(np.argmax(spectrum))
    fundamental_power = float(spectrum[dominant_idx] ** 2)
    fundamental_ratio = fundamental_power / total_power

    noise_mask = freqs < 200
    noise_floor = float(np.sum(spectrum[noise_mask] ** 2)) / total_power

    # Decay rate: RMS of first 0.1s vs RMS of 0.1s–0.2s
    seg1 = pcm[:int(sr * 0.10)]
    seg2 = pcm[int(sr * 0.10):int(sr * 0.20)]
    rms1 = float(np.sqrt(np.mean(seg1 ** 2))) + 1e-9
    rms2 = float(np.sqrt(np.mean(seg2 ** 2))) + 1e-9 if len(seg2) > 10 else rms1
    decay_rate = rms2 / rms1  # solid gold: decay_rate ~0.4–0.7; plated: closer to 1.0

    # Heuristic scoring (tuned to match Phase 6 CNN ballpark)
    score = (
        min(fundamental_ratio * 2.0, 1.0) * 0.45
        + max(0.0, (0.8 - decay_rate)) * 0.35
        + max(0.0, (0.3 - noise_floor)) / 0.3 * 0.20
    )
    solid_prob = float(np.clip(score, 0.0, 1.0))

    dominant_freq = float(freqs[dominant_idx]) if dominant_idx < len(freqs) else 0.0
    return {
        "solid_probability": round(solid_prob, 3),
        "plated_probability": round(1.0 - solid_prob, 3),
        "confidence": 0.65,  # FFT heuristic is coarse — CNN will improve this
        "dominant_freq_hz": round(dominant_freq, 1),
        "fundamental_ratio": round(fundamental_ratio, 4),
        "decay_rate": round(decay_rate, 4),
    }


def _mel_spectrogram(pcm: np.ndarray, sr: int, n_mels: int = 128, n_frames: int = 64) -> np.ndarray:
    """
    Compute log-mel spectrogram [1, 1, n_mels, n_frames] matching audio_cnn.onnx input.
    Uses a pure-numpy approximate filterbank (no librosa dependency required).
    """
    # Take up to 1 second
    max_samples = sr
    pcm_clip = pcm[:max_samples]
    if len(pcm_clip) < max_samples:
        pcm_clip = np.pad(pcm_clip, (0, max_samples - len(pcm_clip)))

    # STFT: 512 FFT, hop=sr//n_frames
    n_fft = 512
    hop = max(1, len(pcm_clip) // n_frames)
    frames_list = []
    for i in range(n_frames):
        start = i * hop
        segment = pcm_clip[start: start + n_fft]
        if len(segment) < n_fft:
            segment = np.pad(segment, (0, n_fft - len(segment)))
        window = np.hanning(n_fft)
        spectrum = np.abs(np.fft.rfft(segment * window)) ** 2
        frames_list.append(spectrum)

    stft = np.stack(frames_list, axis=1)  # [n_fft//2+1, n_frames]

    # Triangular mel filterbank (approximate)
    n_freqs = n_fft // 2 + 1
    freq_bins = np.linspace(0, sr / 2, n_freqs)
    mel_low = 0.0
    mel_high = 2595 * np.log10(1 + (sr / 2) / 700)
    mel_points = np.linspace(mel_low, mel_high, n_mels + 2)
    hz_points = 700 * (10 ** (mel_points / 2595) - 1)

    filterbank = np.zeros((n_mels, n_freqs), dtype=np.float32)
    for m in range(1, n_mels + 1):
        f_left, f_center, f_right = hz_points[m - 1], hz_points[m], hz_points[m + 1]
        for k in range(n_freqs):
            f = freq_bins[k]
            if f_left <= f <= f_center:
                filterbank[m - 1, k] = (f - f_left) / (f_center - f_left + 1e-9)
            elif f_center < f <= f_right:
                filterbank[m - 1, k] = (f_right - f) / (f_right - f_center + 1e-9)

    mel = filterbank @ stft  # [n_mels, n_frames]
    log_mel = np.log(mel + 1e-9)

    # Normalize to [0, 1]
    log_mel = (log_mel - log_mel.min()) / (log_mel.max() - log_mel.min() + 1e-9)
    return log_mel[np.newaxis, np.newaxis].astype(np.float32)  # [1, 1, 128, 64]


def _cnn_classify(pcm: np.ndarray, sr: int) -> Optional[dict]:
    """Run audio CNN ONNX model. Returns result dict or None if model unavailable."""
    _load_audio_onnx()
    if _ONNX_SESSION is None:
        return None
    try:
        x = _mel_spectrogram(pcm, sr)
        # Try both output name conventions (old: "sigmoid", new: "solid_prob")
        try:
            outputs = _ONNX_SESSION.run(["solid_prob"], {"mel_spec": x})
        except Exception:
            outputs = _ONNX_SESSION.run(["sigmoid"], {"x": x})
        solid_prob = float(np.clip(outputs[0][0, 0], 0.0, 1.0))
        fft = fft_heuristic(pcm, sr)
        # Blend CNN (0.7) + FFT (0.3) for robustness
        blended = solid_prob * 0.7 + fft["solid_probability"] * 0.3
        return {
            "solid_probability": round(blended, 3),
            "plated_probability": round(1.0 - blended, 3),
            "confidence": 0.82,
            "dominant_freq_hz": fft.get("dominant_freq_hz"),
            "fundamental_ratio": fft.get("fundamental_ratio"),
            "decay_rate": fft.get("decay_rate"),
            "cnn_solid_prob": round(solid_prob, 3),
        }
    except Exception as e:
        logger.warning(f"Audio CNN inference failed: {e}")
        return None


async def classify_audio(audio_url: str) -> dict:
    """
    Full audio classification pipeline: CNN ONNX → FFT heuristic fallback.
    """
    raw = await fetch_audio_bytes(audio_url)
    if raw is None:
        return {"solid_probability": 0.5, "confidence": 0.0, "error": "fetch_failed"}

    try:
        pcm, sr = _wav_to_pcm(raw)
    except Exception as e:
        logger.warning(f"WAV parse failed: {e}")
        return {"solid_probability": 0.5, "confidence": 0.0, "error": f"wav_parse: {e}"}

    cnn_result = _cnn_classify(pcm, sr)
    if cnn_result is not None:
        return cnn_result
    return fft_heuristic(pcm, sr)
