"""
ORB-inlier separation experiment for same-item verification.

Runs on already-downloaded session images (debug/item_match/runs/<ts>/<session>/*.jpg).
For every pair of frames in a session it computes a fast, background-free
discriminator: ORB keypoints on the cropped jewelry → Lowe ratio match →
RANSAC homography inlier count. Same physical object shares many geometrically
consistent inliers across angle/zoom; different items share almost none.

Usage:
  python debug/item_match/orb_experiment.py <run_dir>
  (defaults to the newest run dir)
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"


def _frame_type(name: str) -> str:
    s = Path(name).stem.lower()
    for t in ("45deg", "hallmark", "huid", "closeup", "macro", "selfie", "side", "top"):
        if t in s:
            return t
    return "video"


def _crop_jewelry(img):
    """Crop to the jewelry region using the repo's bbox detector (mat removed)."""
    try:
        from app.data.image_utils import detect_coin_hough, estimate_jewelry_bbox_px
        coin = detect_coin_hough(img, "auto_coin")
        bbox = estimate_jewelry_bbox_px(img, coin)
        if bbox:
            h, w = img.shape[:2]
            x, y = int(bbox.get("x_px", 0)), int(bbox.get("y_px", 0))
            bw, bh = int(bbox.get("width_px", 0)), int(bbox.get("height_px", 0))
            if bw > 8 and bh > 8:
                m = int(max(bw, bh) * 0.18)
                crop = img[max(0, y - m):min(h, y + bh + m), max(0, x - m):min(w, x + bw + m)]
                if crop.size:
                    return crop
    except Exception:
        pass
    return img


def _prep(path: Path):
    img = cv2.imread(str(path))
    if img is None:
        return None
    crop = _crop_jewelry(img)
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # normalise size so keypoint counts are comparable
    h, w = g.shape[:2]
    scale = 480.0 / max(h, w)
    if scale < 1.0:
        g = cv2.resize(g, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)
    return g


_ORB = cv2.ORB_create(nfeatures=1500, scaleFactor=1.2, nlevels=8)


def _features(gray):
    kp, des = _ORB.detectAndCompute(gray, None)
    return kp, des


def orb_inliers(g1, g2) -> tuple[int, int, float]:
    """Return (raw_good_matches, ransac_inliers, inlier_ratio)."""
    kp1, des1 = _features(g1)
    kp2, des2 = _features(g2)
    if des1 is None or des2 is None or len(kp1) < 8 or len(kp2) < 8:
        return 0, 0, 0.0
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    raw = bf.knnMatch(des1, des2, k=2)
    good = []
    for m_n in raw:
        if len(m_n) < 2:
            continue
        m, n = m_n
        if m.distance < 0.75 * n.distance:   # Lowe ratio test
            good.append(m)
    if len(good) < 6:
        return len(good), 0, 0.0
    src = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    inliers = int(mask.sum()) if mask is not None else 0
    return len(good), inliers, (inliers / max(1, len(good)))


def run(run_dir: Path):
    sessions = sorted([d for d in run_dir.iterdir() if d.is_dir()])
    for sdir in sessions:
        imgs = sorted([p for p in sdir.glob("*.jpg")])
        if len(imgs) < 2:
            continue
        print(f"\n=== {sdir.name}  ({len(imgs)} frames) ===")
        prepped = {}
        for p in imgs:
            t0 = time.perf_counter()
            g = _prep(p)
            prepped[p.name] = (g, _frame_type(p.name), round((time.perf_counter() - t0) * 1000, 1))
        names = list(prepped.keys())
        print(f"{'pair':<48} {'types':<14} {'good':>5} {'inliers':>8} {'ratio':>6} {'ms':>6}")
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                n1, n2 = names[i], names[j]
                g1, t1, _ = prepped[n1]
                g2, t2, _ = prepped[n2]
                if g1 is None or g2 is None:
                    continue
                t0 = time.perf_counter()
                good, inl, ratio = orb_inliers(g1, g2)
                ms = round((time.perf_counter() - t0) * 1000, 1)
                pair = f"{n1[:22]}~{n2[:22]}"
                print(f"{pair:<48} {t1[:5]+'/'+t2[:5]:<14} {good:>5} {inl:>8} {ratio:>6.2f} {ms:>6}")


if __name__ == "__main__":
    import os
    sys.path.insert(0, str(HERE.parents[1]))  # apps/api on path for app.data imports
    os.chdir(HERE.parents[1])
    if len(sys.argv) > 1:
        rd = Path(sys.argv[1])
    else:
        rd = sorted([d for d in RUNS.iterdir() if d.is_dir()])[-1]
    print(f"run_dir: {rd}")
    run(rd)
