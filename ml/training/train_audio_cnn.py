"""
Train a 4-layer 2D CNN on log-mel spectrograms for PingCoin audio classification.
Labels: solid=1, plated=0, noise=-1 (noise is excluded from training).

Usage:
  python train_audio_cnn.py --data_dir ml/synthetic/audio --epochs 50 --export

Output:
  ml/models/audio_cnn.onnx  (~500KB)

PRD target: AUC > 0.85 on held-out set.
"""
import argparse
import os
import struct
import wave
from pathlib import Path

import numpy as np


# ─── Spectrogram helper (scipy optional dependency) ──────────────────────────

def wav_to_melspec(path: str, sr_target=22050, n_mels=128, n_frames=64) -> np.ndarray:
    """Return (1, n_mels, n_frames) float32 log-mel spectrogram."""
    try:
        from scipy.signal import resample
        from scipy.fft import rfft, rfftfreq
    except ImportError as e:
        raise ImportError("scipy required: pip install scipy") from e

    with wave.open(path, "rb") as wf:
        n_ch = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_ch > 1:
        pcm = pcm.reshape(-1, n_ch).mean(1)
    if sr != sr_target:
        n_out = int(len(pcm) * sr_target / sr)
        pcm = resample(pcm, n_out).astype(np.float32)
        sr = sr_target

    # Simple STFT-based mel filterbank
    hop = len(pcm) // n_frames
    win = min(hop * 2, 2048)
    frames_out = []
    for i in range(n_frames):
        seg = pcm[i * hop: i * hop + win]
        if len(seg) < win:
            seg = np.pad(seg, (0, win - len(seg)))
        spec = np.abs(rfft(seg * np.hanning(win))) ** 2
        frames_out.append(spec)

    spec2d = np.array(frames_out).T  # (freq_bins, n_frames)
    freqs = rfftfreq(win, 1 / sr)
    mel_filters = _mel_filterbank(freqs, n_mels, sr)
    mel_spec = mel_filters @ spec2d
    log_mel = np.log1p(mel_spec).astype(np.float32)
    # Normalize
    log_mel = (log_mel - log_mel.mean()) / (log_mel.std() + 1e-6)
    return log_mel[np.newaxis]  # (1, n_mels, n_frames)


def _mel_filterbank(freqs: np.ndarray, n_mels: int, sr: int) -> np.ndarray:
    f_min, f_max = 50.0, sr / 2
    mel_min = 2595 * np.log10(1 + f_min / 700)
    mel_max = 2595 * np.log10(1 + f_max / 700)
    mel_points = np.linspace(mel_min, mel_max, n_mels + 2)
    hz_points = 700 * (10 ** (mel_points / 2595) - 1)
    filters = np.zeros((n_mels, len(freqs)), dtype=np.float32)
    for m in range(1, n_mels + 1):
        f0, fc, f1 = hz_points[m - 1], hz_points[m], hz_points[m + 1]
        for k, f in enumerate(freqs):
            if f0 <= f <= fc:
                filters[m - 1, k] = (f - f0) / (fc - f0 + 1e-9)
            elif fc < f <= f1:
                filters[m - 1, k] = (f1 - f) / (f1 - fc + 1e-9)
    return filters


# ─── Model definition ─────────────────────────────────────────────────────────

def build_model():
    """4-layer 2D CNN. ~400K parameters, ~500KB ONNX export."""
    try:
        import torch
        import torch.nn as nn
    except ImportError as e:
        raise ImportError("torch required: pip install torch") from e

    class AudioCNN(nn.Module):
        def __init__(self):
            super().__init__()
            self.features = nn.Sequential(
                nn.Conv2d(1, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(),
                nn.MaxPool2d(2),
                nn.Conv2d(128, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.AdaptiveAvgPool2d((4, 4)),
            )
            self.classifier = nn.Sequential(
                nn.Flatten(),
                nn.Linear(64 * 16, 128), nn.ReLU(), nn.Dropout(0.4),
                nn.Linear(128, 1),  # sigmoid → solid probability
            )

        def forward(self, x):
            return torch.sigmoid(self.classifier(self.features(x)))

    return AudioCNN()


# ─── Training loop ────────────────────────────────────────────────────────────

def load_dataset(data_dir: str):
    """
    Expects data_dir/solid/*.wav and data_dir/plated/*.wav.
    Returns (X: list of np arrays, y: list of floats).
    """
    X, y = [], []
    for label, cls in [(1.0, "solid"), (0.0, "plated")]:
        folder = Path(data_dir) / cls
        if not folder.exists():
            print(f"  [warn] {folder} not found — skipping")
            continue
        for wav in folder.glob("*.wav"):
            try:
                spec = wav_to_melspec(str(wav))
                X.append(spec)
                y.append(label)
            except Exception as e:
                print(f"  [skip] {wav.name}: {e}")
    return X, y


def train(data_dir: str, epochs: int, export: bool, out_dir: str):
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset

    print(f"Loading dataset from {data_dir} …")
    X, y = load_dataset(data_dir)
    if len(X) == 0:
        print("No training data found. Skipping training (export scaffold only).")
        if export:
            _export_untrained(out_dir)
        return

    X_t = torch.tensor(np.stack(X), dtype=torch.float32)
    y_t = torch.tensor(y, dtype=torch.float32).unsqueeze(1)
    dataset = TensorDataset(X_t, y_t)
    loader = DataLoader(dataset, batch_size=16, shuffle=True)

    model = build_model()
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.BCELoss()
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    print(f"Training for {epochs} epochs on {len(X_t)} samples …")
    for ep in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        for xb, yb in loader:
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        scheduler.step()
        if ep % 10 == 0 or ep == epochs:
            print(f"  epoch {ep:3d}/{epochs}  loss={total_loss/len(loader):.4f}")

    if export:
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        out_path = str(Path(out_dir) / "audio_cnn.onnx")
        dummy = torch.randn(1, 1, 128, 64)
        torch.onnx.export(
            model, dummy, out_path,
            input_names=["mel_spec"], output_names=["solid_prob"],
            dynamic_axes={"mel_spec": {0: "batch"}},
            opset_version=17,
        )
        size_kb = os.path.getsize(out_path) // 1024
        print(f"  Exported → {out_path}  ({size_kb} KB)")


def _export_untrained(out_dir: str):
    """Export an untrained model so the ONNX scaffold exists for CI testing."""
    import torch
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    model = build_model()
    out_path = str(Path(out_dir) / "audio_cnn.onnx")
    dummy = torch.randn(1, 1, 128, 64)
    torch.onnx.export(model, dummy, out_path, opset_version=17)
    print(f"  Scaffold exported (untrained) → {out_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data_dir", default="ml/synthetic/audio")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--out_dir", default="ml/models")
    args = ap.parse_args()
    train(args.data_dir, args.epochs, args.export, args.out_dir)
