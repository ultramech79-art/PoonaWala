"""
Phase 7 — Synthetic Jewelry Data Generator
Pure OpenCV/NumPy/scipy — NO BlenderProc needed.

Generates:
  ml/synthetic/images/solid/   — 200 JPEGs (224×224)
  ml/synthetic/images/plated/  — 200 JPEGs (224×224)
  ml/synthetic/audio/solid/    — 100 WAVs (1s, 16kHz, 16-bit PCM)
  ml/synthetic/audio/plated/   — 100 WAVs (1s, 16kHz, 16-bit PCM)

Run from goldeye root:
  python ml/synthetic/generate_jewelry.py
"""
import os
import random
import struct
import wave
from pathlib import Path

import cv2
import numpy as np
from scipy.signal import butter, lfilter

# ─── CIELAB centroids (from blenderproc_pipeline.py) ─────────────────────────
KARAT_CIELAB = {
    24: (85.0,  5.5, 25.0),
    22: (82.0,  4.8, 24.0),
    20: (78.0,  4.2, 21.0),
    18: (74.0,  3.5, 18.0),
    14: (68.0,  2.0, 12.0),
}
PLATED_LAB = (62.0, 2.5, 13.0)  # duller, less saturated

SOLID_KARATS = [24, 22, 22, 20, 18, 18, 14]  # weighted toward 22K

IMG_SIZE = 224
IMAGES_PER_CLASS = 200
AUDIO_PER_CLASS = 100
SR = 16000
AUDIO_DURATION = 1  # seconds


# ─── Color helpers ────────────────────────────────────────────────────────────

def lab_to_bgr(L: float, a: float, b: float) -> tuple[int, int, int]:
    """Approximate Lab → BGR (uint8) via OpenCV pipeline."""
    lab_img = np.array([[[L, a + 128, b + 128]]], dtype=np.float32)
    bgr = cv2.cvtColor(lab_img.astype(np.uint8), cv2.COLOR_Lab2BGR)
    return int(bgr[0, 0, 0]), int(bgr[0, 0, 1]), int(bgr[0, 0, 2])


def karat_to_bgr(karat: int, jitter: float = 0.05) -> tuple[int, int, int]:
    L, a, b = KARAT_CIELAB.get(karat, KARAT_CIELAB[22])
    L += random.uniform(-jitter * 10, jitter * 10)
    a += random.uniform(-jitter * 5, jitter * 5)
    b += random.uniform(-jitter * 5, jitter * 5)
    # Convert via float32 Lab image
    lab_img = np.array([[[L, a + 128, b + 128]]], dtype=np.float32)
    lab_clamped = np.clip(lab_img, 0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(lab_clamped, cv2.COLOR_Lab2BGR)
    return int(bgr[0, 0, 0]), int(bgr[0, 0, 1]), int(bgr[0, 0, 2])


def plated_bgr(jitter: float = 0.05) -> tuple[int, int, int]:
    L, a, b = PLATED_LAB
    L += random.uniform(-jitter * 12, jitter * 12)
    a += random.uniform(-jitter * 4, jitter * 4)
    b += random.uniform(-jitter * 4, jitter * 4)
    lab_img = np.array([[[L, a + 128, b + 128]]], dtype=np.float32)
    lab_clamped = np.clip(lab_img, 0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(lab_clamped, cv2.COLOR_Lab2BGR)
    return int(bgr[0, 0, 0]), int(bgr[0, 0, 1]), int(bgr[0, 0, 2])


# ─── Image drawing primitives ─────────────────────────────────────────────────

def draw_ring(canvas: np.ndarray, color: tuple, cx: int, cy: int, r: int):
    """Filled circle (ring top-down view)."""
    cv2.circle(canvas, (cx, cy), r, color, -1)
    # Inner hole
    hole_r = max(5, r // 3)
    cv2.circle(canvas, (cx, cy), hole_r, (30, 30, 30), -1)


def draw_bangle(canvas: np.ndarray, color: tuple, cx: int, cy: int, rx: int, ry: int):
    """Hollow ellipse."""
    cv2.ellipse(canvas, (cx, cy), (rx, ry), 0, 0, 360, color, thickness=max(8, rx // 5))


def draw_chain(canvas: np.ndarray, color: tuple, cx: int, cy: int, length: int):
    """Zigzag chain pattern."""
    pts = []
    n_links = 12
    for i in range(n_links + 1):
        x = cx - length // 2 + i * (length // n_links)
        y = cy + (8 if i % 2 == 0 else -8)
        pts.append([x, y])
    pts_arr = np.array([pts], dtype=np.int32)
    cv2.polylines(canvas, pts_arr, False, color, thickness=6)
    # Draw small ovals for links
    for i, (x, y) in enumerate(pts[::2]):
        cv2.ellipse(canvas, (x, y), (6, 4), 0, 0, 360, color, -1)


def draw_pendant(canvas: np.ndarray, color: tuple, cx: int, cy: int, size: int):
    """Diamond/rhombus shape."""
    pts = np.array([
        [cx, cy - size],
        [cx + size // 2, cy],
        [cx, cy + size],
        [cx - size // 2, cy],
    ], dtype=np.int32)
    cv2.fillPoly(canvas, [pts], color)
    # Bail at top
    cv2.line(canvas, (cx, cy - size), (cx, cy - size - 12), color, 3)


def add_worn_spots(canvas: np.ndarray, n_spots: int = 8):
    """Add worn edge spots showing base metal (plated indicator)."""
    h, w = canvas.shape[:2]
    for _ in range(n_spots):
        x = random.randint(20, w - 20)
        y = random.randint(20, h - 20)
        r = random.randint(3, 8)
        # Dark copper/brass color at wear points
        worn_color = (random.randint(30, 80), random.randint(50, 100), random.randint(80, 140))
        cv2.circle(canvas, (x, y), r, worn_color, -1)


def add_lighting_jitter(canvas: np.ndarray, is_solid: bool) -> np.ndarray:
    """Apply brightness/noise jitter to simulate lighting variations."""
    # Additive Gaussian noise
    noise_std = 8 if is_solid else 15  # plated = more noise
    noise = np.random.normal(0, noise_std, canvas.shape).astype(np.int16)
    # Brightness jitter
    brightness = random.uniform(0.85, 1.15)
    out = np.clip(canvas.astype(np.int16) * brightness + noise, 0, 255).astype(np.uint8)
    return out


def generate_jewelry_image(item_type: str, is_solid: bool, seed: int) -> np.ndarray:
    """Generate a 224×224 jewelry image."""
    random.seed(seed)
    np.random.seed(seed)

    # Background: slightly off-white
    bg = random.randint(220, 245)
    canvas = np.full((IMG_SIZE, IMG_SIZE, 3), bg, dtype=np.uint8)

    cx, cy = IMG_SIZE // 2, IMG_SIZE // 2

    if is_solid:
        karat = random.choice(SOLID_KARATS)
        color = karat_to_bgr(karat)
    else:
        color = plated_bgr()

    if item_type == "ring":
        r = random.randint(50, 70)
        draw_ring(canvas, color, cx, cy, r)
    elif item_type == "bangle":
        rx = random.randint(60, 80)
        ry = random.randint(45, 65)
        draw_bangle(canvas, color, cx, cy, rx, ry)
    elif item_type == "chain":
        length = random.randint(120, 160)
        draw_chain(canvas, color, cx, cy, length)
    else:  # pendant
        size = random.randint(45, 65)
        draw_pendant(canvas, color, cx, cy, size)

    if not is_solid:
        add_worn_spots(canvas, n_spots=random.randint(4, 12))

    canvas = add_lighting_jitter(canvas, is_solid)
    return canvas


# ─── Audio synthesis ──────────────────────────────────────────────────────────

def generate_solid_audio(seed: int) -> np.ndarray:
    """
    Solid gold: dominant 1200–2400 Hz, slow exponential decay (τ=0.5s), low noise.
    """
    random.seed(seed)
    np.random.seed(seed)

    n_samples = SR * AUDIO_DURATION
    t = np.linspace(0, AUDIO_DURATION, n_samples, endpoint=False)

    # Fundamental with ±5% pitch variation
    base_freq = random.uniform(1200, 2400)
    freq = base_freq * random.uniform(0.95, 1.05)
    tau = 0.5
    decay = np.exp(-t / tau)

    # Strong fundamental + weak harmonics
    signal = decay * (
        np.sin(2 * np.pi * freq * t) * 0.80
        + np.sin(2 * np.pi * freq * 2 * t) * 0.12
        + np.sin(2 * np.pi * freq * 3 * t) * 0.05
    )

    # Amplitude jitter
    amp = random.uniform(0.75, 1.0)
    signal *= amp

    # Low noise floor
    noise = np.random.normal(0, 0.01, n_samples)
    signal += noise

    return np.clip(signal, -1.0, 1.0).astype(np.float32)


def generate_plated_audio(seed: int) -> np.ndarray:
    """
    Plated: competing harmonics, fast decay (τ=0.15s), higher noise floor.
    """
    random.seed(seed)
    np.random.seed(seed)

    n_samples = SR * AUDIO_DURATION
    t = np.linspace(0, AUDIO_DURATION, n_samples, endpoint=False)

    base_freq = random.uniform(800, 1800)
    freq = base_freq * random.uniform(0.95, 1.05)
    tau = 0.15
    decay = np.exp(-t / tau)

    # Multiple competing harmonics (no dominant fundamental)
    amp1 = random.uniform(0.3, 0.5)
    amp2 = random.uniform(0.25, 0.45)
    amp3 = random.uniform(0.15, 0.35)
    signal = decay * (
        np.sin(2 * np.pi * freq * t) * amp1
        + np.sin(2 * np.pi * freq * 1.7 * t) * amp2
        + np.sin(2 * np.pi * freq * 2.5 * t) * amp3
        + np.sin(2 * np.pi * freq * 0.5 * t) * random.uniform(0.1, 0.3)
    )

    amp_total = random.uniform(0.5, 0.85)
    signal *= amp_total

    # Higher noise floor
    noise = np.random.normal(0, 0.06, n_samples)
    # Low-frequency rumble
    lf_noise = np.random.normal(0, 0.03, n_samples)
    b, a = butter(2, 200 / (SR / 2), btype='low')
    lf_noise = lfilter(b, a, lf_noise)
    signal += noise + lf_noise

    return np.clip(signal, -1.0, 1.0).astype(np.float32)


def save_wav(path: Path, audio: np.ndarray, sr: int = SR):
    """Save float32 audio as 16-bit PCM WAV."""
    pcm = (audio * 32767).astype(np.int16)
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


# ─── Main generation pipeline ─────────────────────────────────────────────────

def generate_all(base_dir: str = "ml/synthetic"):
    base = Path(base_dir)
    img_solid_dir = base / "images" / "solid"
    img_plated_dir = base / "images" / "plated"
    audio_solid_dir = base / "audio" / "solid"
    audio_plated_dir = base / "audio" / "plated"

    for d in [img_solid_dir, img_plated_dir, audio_solid_dir, audio_plated_dir]:
        d.mkdir(parents=True, exist_ok=True)

    item_types = ["ring", "bangle", "chain", "pendant"]

    # ── Images ────────────────────────────────────────────────────────────────
    print(f"Generating {IMAGES_PER_CLASS} solid images …")
    for i in range(IMAGES_PER_CLASS):
        item = item_types[i % len(item_types)]
        img = generate_jewelry_image(item, is_solid=True, seed=i)
        out = img_solid_dir / f"{item}_{i:04d}.jpg"
        cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"  → {img_solid_dir}")

    print(f"Generating {IMAGES_PER_CLASS} plated images …")
    for i in range(IMAGES_PER_CLASS):
        item = item_types[i % len(item_types)]
        img = generate_jewelry_image(item, is_solid=False, seed=i + 10000)
        out = img_plated_dir / f"{item}_{i:04d}.jpg"
        cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"  → {img_plated_dir}")

    # ── Audio ─────────────────────────────────────────────────────────────────
    print(f"Generating {AUDIO_PER_CLASS} solid audio samples …")
    for i in range(AUDIO_PER_CLASS):
        audio = generate_solid_audio(seed=i + 20000)
        save_wav(audio_solid_dir / f"solid_{i:04d}.wav", audio)
    print(f"  → {audio_solid_dir}")

    print(f"Generating {AUDIO_PER_CLASS} plated audio samples …")
    for i in range(AUDIO_PER_CLASS):
        audio = generate_plated_audio(seed=i + 30000)
        save_wav(audio_plated_dir / f"plated_{i:04d}.wav", audio)
    print(f"  → {audio_plated_dir}")

    print("Done.")
    return {
        "images_solid": IMAGES_PER_CLASS,
        "images_plated": IMAGES_PER_CLASS,
        "audio_solid": AUDIO_PER_CLASS,
        "audio_plated": AUDIO_PER_CLASS,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--base_dir", default="ml/synthetic")
    args = ap.parse_args()
    stats = generate_all(args.base_dir)
    print(stats)
