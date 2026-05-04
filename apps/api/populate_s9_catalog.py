"""
Phase 7: S9 Reverse-Catalog Population

Generates ml/models/catalog_phashes.npy with:
  1. 10,000 deterministic random 64-bit hashes (simulates scraped catalog)
  2. Real pHashes computed from ml/synthetic/images/solid/*.jpg
"""
import os
import numpy as np
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("goldeye.populate_catalog")


def compute_phash_from_file(img_path: str):
    """Compute 64-bit pHash from a JPEG/PNG file. Returns int or None."""
    try:
        import cv2
        img = cv2.imread(img_path)
        if img is None:
            return None
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
        dct = cv2.dct(np.float32(resized))
        dct_low = dct[:8, :8]
        dct_flat = dct_low.flatten()[1:]  # skip DC
        median = float(np.median(dct_flat))
        bits = dct_flat > median
        h = 0
        for bit in bits:
            h = (h << 1) | int(bit)
        return h
    except Exception as e:
        logger.warning(f"pHash failed for {img_path}: {e}")
        return None


def generate_catalog():
    target_path = Path(__file__).parent.parent.parent / "ml" / "models" / "catalog_phashes.npy"
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Block 1: 10,000 random 64-bit unsigned integers ──────────────────────
    np.random.seed(42)
    random_hashes = np.random.randint(0, np.iinfo(np.uint64).max, size=10000, dtype=np.uint64)
    logger.info(f"Generated {len(random_hashes)} random catalog pHashes.")

    # ── Block 2: Real pHashes from synthetic catalog images ──────────────────
    synthetic_img_dir = Path(__file__).parent.parent.parent / "ml" / "synthetic" / "images" / "solid"
    real_hashes = []
    if synthetic_img_dir.exists():
        jpg_files = sorted(synthetic_img_dir.glob("*.jpg"))
        logger.info(f"Computing pHashes from {len(jpg_files)} synthetic images …")
        for img_path in jpg_files:
            h = compute_phash_from_file(str(img_path))
            if h is not None:
                real_hashes.append(np.uint64(h))
        logger.info(f"  → {len(real_hashes)} real pHashes computed.")
    else:
        logger.warning(f"Synthetic images not found at {synthetic_img_dir} — skipping real pHash block.")

    # Combine and save
    if real_hashes:
        real_arr = np.array(real_hashes, dtype=np.uint64)
        combined = np.concatenate([random_hashes, real_arr])
    else:
        combined = random_hashes

    np.save(target_path, combined)
    logger.info(f"Saved {len(combined)} total catalog pHashes to {target_path}")
    return len(combined)


if __name__ == "__main__":
    n = generate_catalog()
    print(f"Catalog contains {n} pHashes.")
