from typing import Optional, Union
"""
S9 — Reverse-catalog fraud defense signal worker.

Detects stock-photo submissions by comparing customer images against a hash set
of known jewelry catalog images (Tanishq, Kalyan, Malabar, Bluestone).

MVP approach: in-process pHash deduplication.
  - Catalog hashes are loaded once from ml/models/catalog_phashes.npy (if available).
  - Per-session: compute pHash of customer frames, query in-memory set.
  - If Hamming distance ≤ threshold → catalog_match detected.

Pilot scope upgrade (Phase 6):
  - EVA-02-Large embeddings → Qdrant ANN search for semantic-level matching.

PRD references: S9, FR-FRD-01, Phase 5 (§10.3 of implementation_plan.md).
"""
import os
import time
import logging

import numpy as np

from app.models.schemas import SignalResult
from app.data.phash import compute_phash, hamming_distance, phash_to_hex
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s9_reverse_catalog")

# In-memory catalog hash set: list of 64-bit ints
# Populated at startup from ml/models/catalog_phashes.npy
_catalog_hashes: list[int] = []
_catalog_loaded = False
HAMMING_THRESHOLD = 10  # same as phash.py DUPLICATE_THRESHOLD


def _load_catalog():
    global _catalog_hashes, _catalog_loaded
    if _catalog_loaded:
        return
    _catalog_loaded = True

    base = os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "ml", "models"
    )
    path = os.path.normpath(os.path.join(base, "catalog_phashes.npy"))
    if os.path.exists(path):
        try:
            arr = np.load(path, allow_pickle=False)
            _catalog_hashes = arr.tolist()
            logger.info(f"Loaded {len(_catalog_hashes)} catalog pHashes from {path}")
        except Exception as e:
            logger.warning(f"Failed to load catalog_phashes.npy: {e}")
    else:
        logger.info("No catalog_phashes.npy found — S9 will report no catalog matches (expected in dev)")


async def run(session_id: str, frames: list[str]) -> SignalResult:
    """
    Args:
        session_id: for logging / tracing.
        frames: list of image URLs or base64 data-URIs.
    """
    t0 = time.time()
    _load_catalog()

    try:
        import cv2

        session_hashes: list[int] = []
        best_match_score = 0.0       # 0 = no match, 1 = exact catalog hit
        best_match_hash_hex: Optional[str] = None

        for idx, url in enumerate(frames[:4]):   # check all 4 still photos
            if not url or url.startswith("local://"):
                continue
            raw = await fetch_image_bytes(url)
            if raw is None:
                continue
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue

            h = compute_phash(img)
            if h is None:
                continue
            session_hashes.append(h)

            # Query catalog
            for cat_hash in _catalog_hashes:
                dist = hamming_distance(h, cat_hash)
                similarity = max(0.0, 1.0 - dist / 64.0)   # 64 bits total
                if similarity > best_match_score:
                    best_match_score = similarity
                    best_match_hash_hex = phash_to_hex(cat_hash)

        catalog_match = best_match_score >= (1.0 - HAMMING_THRESHOLD / 64.0)

        return SignalResult(
            signal_id="s9_reverse_catalog",
            confidence=0.8 if session_hashes else 0.0,
            payload={
                "catalog_match": catalog_match,
                "catalog_match_score": round(best_match_score, 4),
                "best_match_hash": best_match_hash_hex,
                "catalog_size": len(_catalog_hashes),
                "frames_checked": len(session_hashes),
                "session_hashes": [phash_to_hex(h) for h in session_hashes],
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="phash-v1",
        )

    except Exception as exc:
        logger.exception(f"[{session_id}] S9 reverse catalog failed: {exc}")
        return SignalResult(
            signal_id="s9_reverse_catalog",
            confidence=0.0,
            payload={"catalog_match": False, "catalog_match_score": 0.0},
            error=str(exc),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="phash-v1",
        )
