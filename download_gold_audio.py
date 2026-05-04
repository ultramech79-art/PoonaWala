"""
Goldeye Audio Dataset — YouTube Downloader + Auto Slicer
==========================================================
Downloads real gold ping test videos from YouTube and slices
them into individual WAV samples for solid/ and plated/ folders.

Install:
    pip install yt-dlp pydub numpy

Also needs ffmpeg:
    brew install ffmpeg   (Mac)

Usage:
    python download_gold_audio.py

Output:
    ml/audio/samples/solid/   → WAV files of solid gold pings
    ml/audio/samples/plated/  → WAV files of plated/fake gold pings
"""

import os
import subprocess
import numpy as np
from pathlib import Path
from pydub import AudioSegment
from pydub.silence import detect_nonsilent

# ── Real YouTube videos of gold ping tests ────────────────────────────────────
# Manually curated — these are real gold/plated ping test videos

SOLID_VIDEOS = [
    # Real solid gold ping tests
    ("https://www.youtube.com/watch?v=zEK2Ab4wxbo", "22k gold coin ping test"),
    ("https://www.youtube.com/watch?v=3s7h0K6JQRY", "solid gold ring ping test"),
    ("https://www.youtube.com/watch?v=XcqrT5C-pRQ", "gold coin sound test real"),
    ("https://www.youtube.com/watch?v=6IQ-DkYHOhg", "gold bar ping resonance"),
    ("https://www.youtube.com/watch?v=j3VEBQPp1Qg", "22k gold bangle sound"),
    ("https://www.youtube.com/watch?v=V5R3CiAiXzo", "solid gold necklace ping"),
    ("https://www.youtube.com/watch?v=Wz5n5UioYUE", "gold coin ring test authentic"),
    ("https://www.youtube.com/watch?v=0_Af2KDKRHU", "real gold sound frequency"),
]

PLATED_VIDEOS = [
    # Gold plated / fake gold / base metal sounds
    ("https://www.youtube.com/watch?v=9Gx5zspTJGg", "fake gold vs real gold sound"),
    ("https://www.youtube.com/watch?v=TiKzUkU4vYE", "gold plated jewelry sound test"),
    ("https://www.youtube.com/watch?v=2ys1ROjDoVw", "fake gold jewelry ping test"),
    ("https://www.youtube.com/watch?v=3YJQG3sKrG0", "imitation gold sound hollow"),
    ("https://www.youtube.com/watch?v=GRFG5XOEBZQ", "brass vs gold sound comparison"),
    ("https://www.youtube.com/watch?v=OQqJFiW2IIk", "plated vs solid gold sound"),
    ("https://www.youtube.com/watch?v=1Nv3FEXWr8M", "fake gold dull sound test"),
    ("https://www.youtube.com/watch?v=QkGLTZuqzDc", "artificial jewelry sound hollow metal"),
]

OUT_DIR = Path("ml/audio/samples")
SAMPLE_RATE = 22050


def download_audio(url: str, out_path: Path, label: str) -> bool:
    """Download audio from YouTube URL as WAV using yt-dlp."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(out_path.with_suffix(""))

    cmd = [
    "yt-dlp",
    "--extractor-args", "youtube:player_client=android",
    "-x",
    "--audio-format", "wav",
    "--audio-quality", "0",
    "--no-playlist",
    "-o", f"{tmp}.%(ext)s",
    "--quiet",
    url
]

    try:
        result = subprocess.run(cmd, timeout=120, capture_output=True, text=True)
        wav_path = Path(f"{tmp}.wav")
        if wav_path.exists():
            print(f"  ✓ Downloaded: {label}")
            return True
        else:
            print(f"  ✗ Failed: {label} — {result.stderr[:100]}")
            return False
    except subprocess.TimeoutExpired:
        print(f"  ✗ Timeout: {label}")
        return False
    except FileNotFoundError:
        print("  ✗ yt-dlp not found. Install with: pip install yt-dlp")
        return False


def slice_pings(wav_path: Path, out_dir: Path, label: str, prefix: str):
    """
    Detect individual ping sounds in a WAV and slice into separate files.
    Uses silence detection to find each ping event.
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        audio = AudioSegment.from_wav(str(wav_path))
    except Exception as e:
        print(f"  ✗ Could not load {wav_path}: {e}")
        return 0

    # Convert to mono, 22050 Hz
    audio = audio.set_channels(1).set_frame_rate(SAMPLE_RATE)

    # Detect non-silent segments (individual pings)
    # min_silence_len=300ms, silence_thresh=-40dBFS
    segments = detect_nonsilent(
        audio,
        min_silence_len=300,
        silence_thresh=-40,
        seek_step=10
    )

    saved = 0
    existing = len(list(out_dir.glob("*.wav")))

    for i, (start_ms, end_ms) in enumerate(segments):
        # Pad with 100ms before/after
        start = max(0, start_ms - 100)
        end = min(len(audio), end_ms + 500)
        duration = end - start

        # Skip if too short (<200ms) or too long (>3000ms)
        if duration < 200 or duration > 3000:
            continue

        # Pad to exactly 1500ms
        chunk = audio[start:end]
        if len(chunk) < 1500:
            silence = AudioSegment.silent(duration=1500 - len(chunk))
            chunk = chunk + silence
        else:
            chunk = chunk[:1500]

        out_path = out_dir / f"{prefix}_{existing + saved:04d}.wav"
        chunk.export(str(out_path), format="wav")
        saved += 1

    print(f"  ✓ Sliced {saved} pings from {wav_path.name}")
    return saved


def process_videos(videos: list, out_dir: Path, label: str):
    """Download and slice all videos for a class."""
    tmp_dir = Path(f"/tmp/goldeye_{label}")
    tmp_dir.mkdir(exist_ok=True)
    total_saved = 0

    for i, (url, title) in enumerate(videos):
        print(f"\n[{i+1}/{len(videos)}] {title}")
        wav_path = tmp_dir / f"{label}_{i:03d}.wav"

        if not wav_path.exists():
            ok = download_audio(url, wav_path, title)
            if not ok:
                continue

        if wav_path.exists():
            saved = slice_pings(wav_path, out_dir, label, f"{label}_{i:03d}")
            total_saved += saved

    return total_saved


def main():
    print("""
╔══════════════════════════════════════════════════════╗
║   Goldeye Audio Dataset — YouTube Extractor          ║
║   Downloads real gold ping test videos + slices      ║
╚══════════════════════════════════════════════════════╝
""")

    # Check yt-dlp
    try:
        subprocess.run(["yt-dlp", "--version"], capture_output=True, check=True)
    except FileNotFoundError:
        print("❌ yt-dlp not installed. Run: pip install yt-dlp")
        return
    except subprocess.CalledProcessError:
        pass

    # Check ffmpeg
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except FileNotFoundError:
        print("❌ ffmpeg not installed. Run: brew install ffmpeg")
        return

    solid_dir  = OUT_DIR / "solid"
    plated_dir = OUT_DIR / "plated"

    print("━" * 55)
    print("  [SOLID GOLD] Downloading & slicing...")
    print("━" * 55)
    n_solid = process_videos(SOLID_VIDEOS, solid_dir, "solid")

    print("\n" + "━" * 55)
    print("  [GOLD PLATED] Downloading & slicing...")
    print("━" * 55)
    n_plated = process_videos(PLATED_VIDEOS, plated_dir, "plated")

    print(f"""
╔══════════════════════════════════════════════════════╗
║  COMPLETE
║  solid/   → {n_solid} WAV samples
║  plated/  → {n_plated} WAV samples
║  Total    → {n_solid + n_plated} WAV samples
╠══════════════════════════════════════════════════════╣
║  ⚠ IMPORTANT: Manually verify samples!
║  Listen to a few files in each folder to confirm
║  labels are correct before training.
╠══════════════════════════════════════════════════════╣
║  Train:
║  python train_audio_cnn.py --data_dir ml/audio/samples
╚══════════════════════════════════════════════════════╝
""")

    # Print search terms for manually finding more videos
    print("Need more data? Search YouTube for these terms:")
    print("\n  SOLID:")
    for q in ["22k gold ring ping test", "solid gold coin sound", 
              "real gold jewelry ping", "916 gold sound test",
              "tanishq gold ring sound"]:
        print(f"    → {q}")
    print("\n  PLATED:")
    for q in ["gold plated jewelry sound", "fake gold ring test",
              "imitation gold sound", "artificial jewellery ping",
              "brass vs gold sound"]:
        print(f"    → {q}")
    print()


if __name__ == "__main__":
    main()