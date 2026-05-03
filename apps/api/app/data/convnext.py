"""
ConvNeXt-V2 plated/solid ONNX inference (Phase 6).

Model: facebook/convnextv2-base-22k-224 fine-tuned binary head.
Input: BGR image (any size) → resized 224×224, normalized (ImageNet μ/σ).
Output: solid_prob ∈ [0, 1].

Also provides score_cam_lite() — perturbation-based saliency in ~120ms.
"""
import os
import logging
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger("goldeye.ml.convnext")

# ImageNet normalization
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

_session = None
_session_loaded = False

_MODEL_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "ml", "models",
    "convnext_plated_solid.onnx",
))


def _load_session():
    global _session, _session_loaded
    if _session_loaded:
        return
    _session_loaded = True
    if os.path.exists(_MODEL_PATH):
        try:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 2
            opts.intra_op_num_threads = 2
            _session = ort.InferenceSession(_MODEL_PATH, sess_options=opts,
                                            providers=["CPUExecutionProvider"])
            logger.info(f"ConvNeXt-V2 model loaded from {_MODEL_PATH}")
        except Exception as e:
            logger.warning(f"ConvNeXt-V2 load failed: {e}")
    else:
        logger.info("convnext_plated_solid.onnx not found — S7 falls back to VLM")


def _preprocess(img_bgr: np.ndarray) -> np.ndarray:
    """BGR → normalized float32 [1, 3, 224, 224]."""
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (224, 224), interpolation=cv2.INTER_LINEAR)
    x = resized.astype(np.float32) / 255.0
    x = (x - _MEAN) / _STD
    return x.transpose(2, 0, 1)[np.newaxis]  # [1, 3, 224, 224]


def predict(img_bgr: np.ndarray) -> Optional[float]:
    """
    Run ConvNeXt-V2 forward pass. Returns solid_prob ∈ [0, 1], or None on error.
    """
    _load_session()
    if _session is None:
        return None
    try:
        x = _preprocess(img_bgr)
        outputs = _session.run(["solid_prob"], {"image": x})
        return float(np.clip(outputs[0][0, 0], 0.0, 1.0))
    except Exception as e:
        logger.warning(f"ConvNeXt inference error: {e}")
        return None


def score_cam_lite(
    img_bgr: np.ndarray,
    grid: int = 7,
) -> Optional[np.ndarray]:
    """
    Score-CAM-lite: perturbation-based saliency heatmap via 7×7 grid masking.
    Returns uint8 BGR heatmap overlay (same size as input), or None on error.

    ~49 forward passes at ~2ms each ≈ 100ms total.
    """
    _load_session()
    if _session is None:
        return None
    try:
        h, w = img_bgr.shape[:2]
        ph, pw = h // grid, w // grid

        baseline = predict(img_bgr) or 0.5
        saliency = np.zeros((grid, grid), dtype=np.float32)

        batch_size = 7  # run one row at a time for memory efficiency
        for row in range(grid):
            batch_imgs = []
            for col in range(grid):
                masked = img_bgr.copy()
                y0, y1 = row * ph, (row + 1) * ph
                x0, x1 = col * pw, (col + 1) * pw
                masked[y0:y1, x0:x1] = 0
                batch_imgs.append(_preprocess(masked)[0])  # [3, 224, 224]

            batch = np.stack(batch_imgs)  # [7, 3, 224, 224]
            outputs = _session.run(["solid_prob"], {"image": batch})
            probs = outputs[0][:, 0]     # [7]
            saliency[row] = baseline - probs  # importance = prob drop when masked

        # Normalize and resize to full image size
        sal_min, sal_max = saliency.min(), saliency.max()
        if sal_max > sal_min:
            saliency = (saliency - sal_min) / (sal_max - sal_min)
        saliency_resized = cv2.resize(saliency, (w, h), interpolation=cv2.INTER_CUBIC)
        heatmap_uint8 = np.uint8(255 * np.clip(saliency_resized, 0, 1))
        heatmap_color = cv2.applyColorMap(heatmap_uint8, cv2.COLORMAP_JET)
        overlay = cv2.addWeighted(img_bgr, 0.55, heatmap_color, 0.45, 0)
        return overlay
    except Exception as e:
        logger.warning(f"Score-CAM-lite failed: {e}")
        return None
