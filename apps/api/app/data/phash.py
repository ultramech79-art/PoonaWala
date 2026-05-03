"""
Perceptual hash (pHash) for image deduplication.
Used by S9 (reverse-catalog) and S12 (cross-application graph).

pHash: resize to 32×32, DCT, compare top-left 8×8 coefficients.
Hamming distance ≤ 10 → likely duplicate / same source.
"""
import logging
from typing import Optional

import numpy as np

logger = logging.getLogger("goldeye.ml.phash")

HASH_SIZE = 8          # 8×8 DCT block → 64-bit hash
RESIZE_TO  = 32        # resize before DCT
DUPLICATE_THRESHOLD = 10  # Hamming distance


def compute_phash(img_bgr: np.ndarray) -> Optional[int]:
    """
    Compute 64-bit perceptual hash. Returns int or None on error.
    """
    try:
        import cv2
    except ImportError:
        logger.warning("opencv not available — phash disabled")
        return None

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (RESIZE_TO, RESIZE_TO), interpolation=cv2.INTER_AREA)
    dct = np.float32(resized)

    # 2D DCT via two 1D DCTs
    import cv2
    dct = cv2.dct(np.float32(resized))
    dct_low = dct[:HASH_SIZE, :HASH_SIZE]
    # Exclude DC component (top-left) to ignore overall brightness
    dct_flat = dct_low.flatten()[1:]
    median = float(np.median(dct_flat))
    bits = dct_flat > median
    # Pack bits into integer
    h = 0
    for bit in bits:
        h = (h << 1) | int(bit)
    return h


def hamming_distance(h1: int, h2: int) -> int:
    return bin(h1 ^ h2).count('1')


def is_duplicate(h1: int, h2: int) -> bool:
    return hamming_distance(h1, h2) <= DUPLICATE_THRESHOLD


def phash_to_hex(h: int) -> str:
    return format(h, '016x')
