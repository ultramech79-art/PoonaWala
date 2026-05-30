"""
Fast local ORB layer for same-item verification.

Empirically (on real session captures) RANSAC-verified ORB inliers on the
*cropped* jewelry are:
  • huge (100s–1000s) for the same item shot from the same/near angle or as a
    burst → an unmistakable "definitely same" signal,
  • ~0 for different items once the shared background mat is cropped away,
  • low/0 for the same item across a big angle change (ORB can't bridge that —
    the VLM handles those cases).

So ORB is used here only for what it is reliable at: collapsing near-duplicate /
same-angle frames into visual GROUPS, cheaply, with effectively no false merges
of different items. The VLM then judges the (few) group representatives.

Everything is pure OpenCV + numpy → tens of milliseconds, no network.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import numpy as np


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.getenv(name, default))))
    except (TypeError, ValueError):
        return default


# A pair with >= this many RANSAC inliers is treated as the SAME physical item
# with high confidence (collapse into one group). Set high to avoid ever merging
# two different rings (cross-item pairs measured ~0–8 inliers in real data).
STRONG_INLIERS = _int_env("ITEM_ORB_STRONG_INLIERS", 22, 10, 200)
ORB_FEATURES = _int_env("ITEM_ORB_FEATURES", 1200, 300, 4000)
ORB_WORK_PX = _int_env("ITEM_ORB_WORK_PX", 480, 240, 1024)

_orb = None


def _get_orb():
    global _orb
    if _orb is None:
        import cv2
        _orb = cv2.ORB_create(nfeatures=ORB_FEATURES, scaleFactor=1.2, nlevels=8)
    return _orb


_DETECT_PX = _int_env("ITEM_ORB_DETECT_PX", 640, 320, 1600)


def _crop_gray(img_bgr) -> Optional[np.ndarray]:
    """Crop to the jewelry (drop the shared background mat + the reference coin)
    and return an equalised grayscale for ORB.

    Speed: all heavy CV (coin Hough + bbox) runs on a ≤640px working copy, not
    the full-resolution image — coin detection on full-res was costing
    300–600 ms+/image (and pathologically more on big frames). Excluding the
    coin matters for correctness: the coin is identical across frames, so if it
    were left in the crop ORB would match it and inflate similarity between
    different rings.
    """
    import cv2

    h0, w0 = img_bgr.shape[:2]
    s = _DETECT_PX / max(h0, w0)
    work = cv2.resize(img_bgr, (max(1, int(w0 * s)), max(1, int(h0 * s))), interpolation=cv2.INTER_AREA) if s < 1.0 else img_bgr

    crop = work
    try:
        from app.data.image_utils import detect_coin_hough, estimate_jewelry_bbox_px
        coin = detect_coin_hough(work, "auto_coin")
        bbox = estimate_jewelry_bbox_px(work, coin)
        if bbox:
            h, w = work.shape[:2]
            x, y = int(bbox.get("x_px", 0)), int(bbox.get("y_px", 0))
            bw, bh = int(bbox.get("width_px", 0)), int(bbox.get("height_px", 0))
            if bw > 8 and bh > 8:
                m = int(max(bw, bh) * 0.18)
                c = work[max(0, y - m):min(h, y + bh + m), max(0, x - m):min(w, x + bw + m)]
                if c.size:
                    crop = c
    except Exception:
        pass

    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    h, w = g.shape[:2]
    scale = ORB_WORK_PX / max(h, w)
    if scale < 1.0:
        g = cv2.resize(g, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    try:
        g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)
    except Exception:
        pass
    return g


def orb_fingerprint(img_bgr) -> dict[str, Any]:
    """Compute ORB keypoints+descriptors once per image (cache this)."""
    if img_bgr is None:
        return {"valid": False, "kp": None, "des": None}
    gray = _crop_gray(img_bgr)
    if gray is None:
        return {"valid": False, "kp": None, "des": None}
    kp, des = _get_orb().detectAndCompute(gray, None)
    pts = np.float32([k.pt for k in kp]) if kp else None
    return {"valid": des is not None and len(kp) >= 8, "pts": pts, "des": des, "n": 0 if kp is None else len(kp)}


def orb_inliers(fp_a: dict, fp_b: dict) -> tuple[int, float]:
    """RANSAC-verified inlier count + inlier ratio between two fingerprints."""
    import cv2

    if not fp_a.get("valid") or not fp_b.get("valid"):
        return 0, 0.0
    des_a, des_b = fp_a["des"], fp_b["des"]
    pts_a, pts_b = fp_a["pts"], fp_b["pts"]
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    try:
        raw = bf.knnMatch(des_a, des_b, k=2)
    except cv2.error:
        return 0, 0.0
    good = []
    for pair in raw:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < 0.75 * n.distance:
            good.append(m)
    if len(good) < 6:
        return len(good), 0.0
    src = np.float32([pts_a[m.queryIdx] for m in good]).reshape(-1, 1, 2)
    dst = np.float32([pts_b[m.trainIdx] for m in good]).reshape(-1, 1, 2)
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    inliers = int(mask.sum()) if mask is not None else 0
    return inliers, (inliers / max(1, len(good)))


def group_by_orb(fingerprints: list[dict], strong: int = STRONG_INLIERS) -> tuple[list[list[int]], dict]:
    """
    Union-find frames into visual groups where any pair with >= `strong` inliers
    is the same item. Returns (groups, pair_inliers_matrix).

    Different items practically never reach `strong` inliers (after cropping), so
    a group never mixes two items; the same item shot in a burst/near-angle gets
    merged, which is exactly the cheap collapse we want before the VLM step.
    """
    n = len(fingerprints)
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    inlier_matrix: dict[tuple[int, int], int] = {}
    for i in range(n):
        for j in range(i + 1, n):
            inl, _ratio = orb_inliers(fingerprints[i], fingerprints[j])
            inlier_matrix[(i, j)] = inl
            if inl >= strong:
                parent[find(i)] = find(j)

    groups_map: dict[int, list[int]] = {}
    for i in range(n):
        groups_map.setdefault(find(i), []).append(i)
    groups = sorted(groups_map.values(), key=len, reverse=True)
    return groups, inlier_matrix
