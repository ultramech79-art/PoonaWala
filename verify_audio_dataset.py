"""
Goldeye Audio Dataset Verifier
================================
Run this after build_audio_dataset_fsd50k.py to verify everything is correct.

Usage:
    python verify_audio_dataset.py --dir ml/audio/samples
"""

import wave
import argparse
import numpy as np
from pathlib import Path

TARGET_SR = 22050
TARGET_DURATION = 1.5
TARGET_SAMPLES = int(TARGET_SR * TARGET_DURATION)

PASS = "✅"
FAIL = "❌"
WARN = "⚠️ "


def check_wav(path: Path):
    """Check a single WAV file. Returns (ok, issues)."""
    issues = []
    try:
        with wave.open(str(path), 'rb') as wf:
            channels   = wf.getnchannels()
            sampwidth  = wf.getsampwidth()
            sr         = wf.getframerate()
            n_frames   = wf.getnframes()
            raw        = wf.readframes(n_frames)

        duration = n_frames / sr

        if channels != 1:
            issues.append(f"not mono ({channels} channels)")
        if sr != TARGET_SR:
            issues.append(f"wrong sample rate ({sr} != {TARGET_SR})")
        if sampwidth != 2:
            issues.append(f"not 16-bit (sampwidth={sampwidth})")
        if abs(duration - TARGET_DURATION) > 0.1:
            issues.append(f"wrong duration ({duration:.2f}s != {TARGET_DURATION}s)")

        # Check audio is not silent
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        rms = np.sqrt(np.mean(pcm ** 2))
        if rms < 0.001:
            issues.append(f"nearly silent (RMS={rms:.4f})")

        # Run same fft_heuristic as audio.py
        spectrum = np.abs(np.fft.rfft(pcm[:sr]))
        freqs    = np.fft.rfftfreq(sr, 1 / sr)
        total_power = float(np.sum(spectrum ** 2)) + 1e-9
        dominant_idx = int(np.argmax(spectrum))
        fundamental_ratio = float(spectrum[dominant_idx] ** 2) / total_power
        seg1 = pcm[:int(sr * 0.10)]
        seg2 = pcm[int(sr * 0.10):int(sr * 0.20)]
        rms1 = float(np.sqrt(np.mean(seg1 ** 2))) + 1e-9
        rms2 = float(np.sqrt(np.mean(seg2 ** 2))) + 1e-9 if len(seg2) > 10 else rms1
        decay_rate = rms2 / rms1
        noise_mask = freqs < 200
        noise_floor = float(np.sum(spectrum[noise_mask] ** 2)) / total_power
        score = (
            min(fundamental_ratio * 2.0, 1.0) * 0.45
            + max(0.0, (0.8 - decay_rate)) * 0.35
            + max(0.0, (0.3 - noise_floor)) / 0.3 * 0.20
        )
        solid_prob = float(np.clip(score, 0.0, 1.0))

        return len(issues) == 0, issues, solid_prob, dominant_idx and freqs[dominant_idx], decay_rate

    except Exception as e:
        return False, [f"could not open: {e}"], 0.0, 0.0, 0.0


def verify_folder(folder: Path, expected_label: str):
    wav_files = list(folder.glob("*.wav"))
    if not wav_files:
        print(f"  {FAIL} No WAV files found in {folder}")
        return 0, 0

    ok_count   = 0
    fail_count = 0
    solid_probs = []
    wrong_label = 0

    for path in wav_files[:5]:  # Show details for first 5
        ok, issues, solid_prob, dom_freq, decay = check_wav(path)
        solid_probs.append(solid_prob)
        status = PASS if ok else FAIL
        label_ok = (solid_prob > 0.5) == (expected_label == "solid")
        if not label_ok:
            wrong_label += 1

        print(f"  {status} {path.name}")
        print(f"       solid_prob={solid_prob:.3f}  freq={dom_freq:.0f}Hz  decay={decay:.3f}")
        if issues:
            for issue in issues:
                print(f"       ⚠  {issue}")

    # Check remaining files silently
    for path in wav_files[5:]:
        ok, issues, solid_prob, _, _ = check_wav(path)
        solid_probs.append(solid_prob)
        if ok:
            ok_count += 1
        else:
            fail_count += 1
        if (solid_prob > 0.5) != (expected_label == "solid"):
            wrong_label += 1

    ok_count  += 5
    avg_prob   = np.mean(solid_probs)
    total      = len(wav_files)

    print(f"\n  Summary [{expected_label.upper()}]:")
    print(f"    Total files     : {total}")
    print(f"    Format OK       : {total - fail_count}/{total}")
    print(f"    Avg solid_prob  : {avg_prob:.3f}  (expected {'> 0.5' if expected_label == 'solid' else '< 0.5'})")

    if expected_label == "solid" and avg_prob > 0.5:
        print(f"    Label check     : {PASS} Sounds like solid gold")
    elif expected_label == "plated" and avg_prob < 0.5:
        print(f"    Label check     : {PASS} Sounds like plated/base metal")
    else:
        print(f"    Label check     : {WARN} avg_prob={avg_prob:.3f} doesn't match expected label")
        print(f"                      {wrong_label} files may be mislabeled")

    return total - fail_count, fail_count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="ml/audio/samples")
    args = ap.parse_args()

    base = Path(args.dir)

    print(f"""
╔══════════════════════════════════════════════════════╗
║   Goldeye Audio Dataset Verifier                     ║
╚══════════════════════════════════════════════════════╝
  Checking: {base.resolve()}
""")

    solid_dir  = base / "solid"
    plated_dir = base / "plated"

    if not solid_dir.exists() and not plated_dir.exists():
        print(f"{FAIL} Neither solid/ nor plated/ folder found at {base}")
        print(f"   Run: python build_audio_dataset_fsd50k.py first")
        return

    total_ok = 0
    total_fail = 0

    if solid_dir.exists():
        n = len(list(solid_dir.glob("*.wav")))
        print(f"{'─'*55}")
        print(f"  SOLID/ ({n} files)")
        print(f"{'─'*55}")
        ok, fail = verify_folder(solid_dir, "solid")
        total_ok += ok; total_fail += fail
    else:
        print(f"{FAIL} solid/ folder missing")

    print()

    if plated_dir.exists():
        n = len(list(plated_dir.glob("*.wav")))
        print(f"{'─'*55}")
        print(f"  PLATED/ ({n} files)")
        print(f"{'─'*55}")
        ok, fail = verify_folder(plated_dir, "plated")
        total_ok += ok; total_fail += fail
    else:
        print(f"{FAIL} plated/ folder missing")

    print(f"""
{'═'*55}
  FINAL RESULT
  {'─'*51}
  Valid files : {total_ok}
  Bad files   : {total_fail}
  Status      : {"✅ Dataset looks good — ready to train!" if total_fail == 0 else "⚠️  Some files have issues — check above"}
  {'─'*51}
  Next step:
  python train_audio_cnn.py --data_dir {args.dir}
{'═'*55}
""")


if __name__ == "__main__":
    main()