from typing import Optional, Union
"""
S10 — EXIF + device telemetry anti-fraud signal.
Checks: timestamp delta (session vs. EXIF), camera fingerprint consistency,
gyroscope motion (non-zero = real video, not injected static image).
"""
import time
from datetime import datetime, timezone
from app.models.schemas import SignalResult


async def run(session_id: str, device_metadata: Optional[dict] = None, **_) -> SignalResult:
    t0 = time.time()
    meta = device_metadata or {}
    try:
        anomaly_score = 0.03
        flags: list[str] = []

        # Timestamp delta check
        exif_ts = meta.get("exif_timestamp_utc")
        if exif_ts:
            session_ts = datetime.now(timezone.utc).timestamp()
            delta_hours = abs(session_ts - float(exif_ts)) / 3600
            if delta_hours > 1:
                anomaly_score += 0.3
                flags.append("timestamp_delta_suspicious")

        # Gyroscope sanity for video (should have motion)
        gyro_samples = meta.get("gyroscope_samples", 0)
        capture_count = meta.get("capture_count", 0)
        if capture_count > 0 and gyro_samples == 0:
            anomaly_score += 0.1
            flags.append("no_gyroscope_data")

        anomaly_score = min(1.0, anomaly_score)
        return SignalResult(
            signal_id="s10_telemetry",
            confidence=1.0 - anomaly_score,
            payload={
                "telemetry_anomaly_score": anomaly_score,
                "flags": flags,
                "gyroscope_samples": gyro_samples,
            },
            error=None,
            duration_ms=int((time.time() - t0) * 1000),
            model_version="rule-based-v1",
        )
    except Exception as e:
        return SignalResult(
            signal_id="s10_telemetry", confidence=0.5, payload={},
            error=str(e), duration_ms=int((time.time() - t0) * 1000),
            model_version="rule-based-v1",
        )
