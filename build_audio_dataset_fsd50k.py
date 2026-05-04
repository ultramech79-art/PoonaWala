"""
Goldeye Audio Dataset Builder — FSD50K (Fixed v3)
==================================================
Install:
    pip install datasets soundfile numpy librosa huggingface_hub

Usage:
    python build_audio_dataset_fsd50k.py --solid 300 --plated 300 --out ml/audio/samples
"""

import argparse, io, wave, csv, numpy as np
from pathlib import Path

TARGET_SR       = 22050
TARGET_DURATION = 1.5
TARGET_SAMPLES  = int(TARGET_SR * TARGET_DURATION)

SOLID_CLASSES = {
    "Bell", "Chime", "Coin", "Cowbell", "Tubular_bells",
    "Glockenspiel", "Wind_chime", "Jingle_bell", "Church_bell",
    "Bicycle_bell", "Singing_bowl",
}

PLATED_CLASSES = {
    "Metal", "Clank", "Clatter", "Knock", "Thud",
    "Rattle", "Bang", "Slam", "Clang", "Clink",
    "Tap", "Mechanisms", "Hammer", "Keys_jangling",
}

def save_wav(samples, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if np.max(np.abs(samples)) > 0:
        samples = samples / np.max(np.abs(samples)) * 0.9
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(1); wf.setsampwidth(2)
        wf.setframerate(TARGET_SR); wf.writeframes(pcm.tobytes())

def process_audio(audio_bytes):
    import soundfile as sf, librosa
    audio, sr = sf.read(io.BytesIO(audio_bytes))
    audio = audio.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != TARGET_SR:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=TARGET_SR)
    if len(audio) < TARGET_SAMPLES:
        audio = np.pad(audio, (0, TARGET_SAMPLES - len(audio)))
    return audio[:TARGET_SAMPLES]

def get_class(labels_str):
    labels = [l.strip() for l in str(labels_str).split(",")]
    for l in labels:
        if l in SOLID_CLASSES: return "solid"
    for l in labels:
        if l in PLATED_CLASSES: return "plated"
    return None

def build(n_solid, n_plated, out_dir):
    try:
        import soundfile, librosa
    except ImportError:
        print("❌ Run: pip install soundfile librosa"); return

    from datasets import load_dataset, Features, Value
    from huggingface_hub import hf_hub_download

    # Step 1: Download CSV ground truth directly (correct way)
    print("Step 1/2: Downloading ground truth CSV...")
    csv_path = hf_hub_download(
        repo_id="philgzl/fsd50k",
        filename="ground_truth/dev.csv",
        repo_type="dataset"
    )
    name_to_labels = {}
    with open(csv_path, newline='') as f:
        reader = csv.DictReader(f)
        print(f"  CSV columns: {reader.fieldnames}")
        for row in reader:
            fname  = str(row.get("fname", "")).strip()
            labels = str(row.get("labels", "")).strip()
            name_to_labels[fname] = labels
    print(f"  Loaded {len(name_to_labels)} label mappings\n")

    # Show sample labels
    sample = list(name_to_labels.items())[:5]
    print("  Sample labels:")
    for k, v in sample:
        print(f"    {k} → {v}")
    print()

    # Step 2: Stream audio
    print("Step 2/2: Streaming audio clips...")
    ds = load_dataset(
        "philgzl/fsd50k", split="dev", streaming=True,
        features=Features({"audio": Value("binary"), "name": Value("string")})
    )

    solid_dir  = out_dir / "solid"
    plated_dir = out_dir / "plated"
    n_solid_saved = n_plated_saved = n_scanned = 0

    for item in ds:
        if n_solid_saved >= n_solid and n_plated_saved >= n_plated:
            break
        n_scanned += 1
        name = str(item["name"])
        # Try multiple key formats
        labels_str = (name_to_labels.get(name) or
                      name_to_labels.get(Path(name).stem) or
                      name_to_labels.get(name.replace(".opus","")) or "")
        if not labels_str:
            continue

        cls = get_class(labels_str)

        if cls == "solid" and n_solid_saved < n_solid:
            try:
                audio = process_audio(item["audio"])
                save_wav(audio, solid_dir / f"solid_{n_solid_saved:04d}.wav")
                n_solid_saved += 1
                print(f"  [solid]  {n_solid_saved}/{n_solid} | {labels_str[:50]:<50}", end="\r")
            except Exception as e:
                continue

        elif cls == "plated" and n_plated_saved < n_plated:
            try:
                audio = process_audio(item["audio"])
                save_wav(audio, plated_dir / f"plated_{n_plated_saved:04d}.wav")
                n_plated_saved += 1
                print(f"  [plated] {n_plated_saved}/{n_plated} | {labels_str[:50]:<50}", end="\r")
            except Exception as e:
                continue

    print(f"\n\n{'='*55}")
    print(f"  solid/  → {n_solid_saved} files")
    print(f"  plated/ → {n_plated_saved} files")
    print(f"  scanned → {n_scanned} clips")
    if n_solid_saved == 0 and n_plated_saved == 0:
        print(f"\n  ⚠  0 files — label names may not match. Check sample labels above.")
    else:
        print(f"\n  ✅ Run: python3 verify_audio_dataset.py --dir {out_dir}")
    print(f"{'='*55}\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--solid",  type=int, default=300)
    ap.add_argument("--plated", type=int, default=300)
    ap.add_argument("--out", default="ml/audio/samples")
    args = ap.parse_args()
    print(f"""
╔══════════════════════════════════════════════════════╗
║   Goldeye Audio Dataset Builder — FSD50K v3          ║
╚══════════════════════════════════════════════════════╝
  Target : {args.solid} solid + {args.plated} plated
  Output : {Path(args.out).resolve()}
""")
    build(args.solid, args.plated, Path(args.out))

if __name__ == "__main__":
    main()