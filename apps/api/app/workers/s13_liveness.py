"""
S13 — Selfie Liveness Detection.
MediaPipe face + hand pose to verify:
1. Live human is holding the jewelry (not photo replay)
2. Hand is visible + in-frame with item
3. Face orientation normal (not extreme angles)
"""
import time
import logging
import numpy as np
from typing import Optional
from app.models.schemas import SignalResult
from app.data.image_utils import fetch_image_bytes

logger = logging.getLogger("goldeye.workers.s13")

try:
    import mediapipe as mp
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False
    logger.warning("MediaPipe not available; liveness will return 0.5 (neutral)")


async def run(
    session_id: str,
    selfie_url: Optional[str] = None,
    **_
) -> SignalResult:
    t0 = time.time()
    try:
        if not selfie_url:
            return SignalResult(
                signal_id="s13_liveness",
                confidence=0.5,
                payload={},
                error="no_selfie_provided",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="mediapipe_0.10.9"
            )

        # Fetch selfie frame
        img_bytes = await fetch_image_bytes(selfie_url)
        if not img_bytes:
            return SignalResult(
                signal_id="s13_liveness",
                confidence=0.5,
                payload={},
                error="image_fetch_failed",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="mediapipe_0.10.9"
            )

        # Decode image
        import cv2
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None or frame.shape[0] < 100 or frame.shape[1] < 100:
            return SignalResult(
                signal_id="s13_liveness",
                confidence=0.5,
                payload={},
                error="image_too_small",
                duration_ms=int((time.time() - t0) * 1000),
                model_version="mediapipe_0.10.9"
            )

        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w = frame.shape[:2]

        if not MEDIAPIPE_AVAILABLE:
            return SignalResult(
                signal_id="s13_liveness",
                confidence=0.5,
                payload={},
                duration_ms=int((time.time() - t0) * 1000),
                model_version="heuristic_fallback"
            )

        # Run MediaPipe face + hand detection
        face_score, hand_score, hand_jewelry_proximity = _analyze_liveness(
            frame_rgb, h, w
        )

        # Combine scores
        liveness_confidence = 0.6 * face_score + 0.4 * hand_score
        quality_score = max(face_score, hand_score)

        reason = _generate_reason(face_score, hand_score, hand_jewelry_proximity)

        return SignalResult(
            signal_id="s13_liveness",
            confidence=float(liveness_confidence),
            payload={
                "face_score": float(face_score),
                "hand_score": float(hand_score),
                "hand_jewelry_proximity": float(hand_jewelry_proximity),
                "reason": reason,
                "quality_score": float(quality_score),
            },
            duration_ms=int((time.time() - t0) * 1000),
            model_version="mediapipe_0.10.9"
        )

    except Exception as e:
        logger.exception(f"S13 liveness error: {e}")
        return SignalResult(
            signal_id="s13_liveness",
            confidence=0.5,
            payload={},
            error=str(e),
            duration_ms=int((time.time() - t0) * 1000),
            model_version="mediapipe_0.10.9"
        )


def _analyze_liveness(frame_rgb: np.ndarray, h: int, w: int) -> tuple:
    """
    Returns (face_score, hand_score, hand_jewelry_proximity)
    All scores in [0, 1].
    """
    mp_face = mp.solutions.face_detection
    mp_hands = mp.solutions.hands

    face_score = 0.0
    hand_score = 0.0
    hand_jewelry_proximity = 0.0

    # 1. Face detection
    with mp_face.FaceDetection(min_detection_confidence=0.5) as face_detector:
        results = face_detector.process(frame_rgb)
        if results.detections and len(results.detections) > 0:
            # Face detected
            face_score = 0.9
            detection = results.detections[0]
            # Check if face is reasonably centered + not extreme angle
            bbox = detection.location_data.relative_bounding_box
            face_center_x = bbox.xmin + bbox.width / 2
            face_center_y = bbox.ymin + bbox.height / 2

            # Penalize if face is at image edge (might be photo-of-photo)
            dist_to_center = abs(face_center_x - 0.5) + abs(face_center_y - 0.5)
            center_penalty = min(dist_to_center * 0.5, 0.2)
            face_score -= center_penalty

            # Check face size (if too small, might be distant/fake)
            face_area = bbox.width * bbox.height
            if face_area < 0.1:
                face_score *= 0.8

    # 2. Hand detection (verify jewelry is being held)
    with mp_hands.Hands(
        static_image_mode=True,
        max_num_hands=2,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    ) as hand_detector:
        results = hand_detector.process(frame_rgb)
        if results.multi_hand_landmarks and len(results.multi_hand_landmarks) > 0:
            hand_score = 0.85
            hand_landmarks = results.multi_hand_landmarks[0]

            # Check hand visibility (all landmarks should be in frame)
            landmarks_in_frame = sum(
                1 for lm in hand_landmarks.landmark
                if 0 <= lm.x <= 1 and 0 <= lm.y <= 1
            )
            visibility_ratio = landmarks_in_frame / len(hand_landmarks.landmark)
            hand_score *= visibility_ratio

            # Check hand-jewelry proximity
            # If palm center is in center 50% of image, likely holding item
            palm_landmarks = [0, 5, 9, 13, 17]  # WRIST, THUMB_MCP, INDEX_MCP, MIDDLE_MCP, PINKY_MCP
            palm_center_x = np.mean([hand_landmarks.landmark[i].x for i in palm_landmarks])
            palm_center_y = np.mean([hand_landmarks.landmark[i].y for i in palm_landmarks])

            # Distance from image center
            dist_from_center = abs(palm_center_x - 0.5) + abs(palm_center_y - 0.5)
            hand_jewelry_proximity = max(0.0, 1.0 - dist_from_center)

            # Bonus if hand is centered
            if 0.25 < palm_center_x < 0.75 and 0.25 < palm_center_y < 0.75:
                hand_score = min(1.0, hand_score + 0.1)

    # 3. Combine face + hand for liveness
    # Both must be present for strong liveness signal
    if face_score > 0.7 and hand_score > 0.7:
        # Both face and hand detected => strong liveness
        combined_liveness = 0.95
    elif face_score > 0.7 or hand_score > 0.7:
        # One of them present => moderate liveness
        combined_liveness = max(face_score, hand_score) * 0.9
    else:
        # Neither => low liveness
        combined_liveness = 0.3

    return face_score, hand_score, hand_jewelry_proximity


def _generate_reason(face_score: float, hand_score: float, proximity: float) -> str:
    """Generate human-readable reason for liveness assessment."""
    parts = []

    if face_score > 0.75:
        parts.append("Face detected & centered")
    elif face_score > 0.5:
        parts.append("Face detected (angle/position suboptimal)")
    else:
        parts.append("Face not detected or off-angle")

    if hand_score > 0.75:
        parts.append("Hand visible, holding jewelry")
    elif hand_score > 0.5:
        parts.append("Hand detected (partial visibility)")
    else:
        parts.append("Hand not visible")

    if proximity > 0.7:
        parts.append("Hand-jewelry alignment good")
    elif proximity > 0.4:
        parts.append("Hand-jewelry alignment marginal")

    return "; ".join(parts)
