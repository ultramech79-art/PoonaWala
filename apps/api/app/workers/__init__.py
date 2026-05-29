"""
Signal worker registry.
Each worker is an async function: run(session_id, **kwargs) -> SignalResult.
Phase 2 replaces these stubs with real Celery tasks backed by ML models.
"""
from .s1_huid import run as s1_huid
from .s2_hallmark import run as s2_hallmark
from .s5_segmentation import run as s5_segmentation
from .s6_dimensions import run as s6_dimensions
from .s7_plated_solid import run as s7_plated_solid
from .s8_vlm import run as s8_vlm
from .s10_telemetry import run as s10_telemetry
from .s11_audio import run as s11_audio
from .s14_item_consistency import run as s14_item_consistency

ACTIVE_WORKERS = {
    "s1_huid_ocr":       s1_huid,
    "s2_hallmark_visual": s2_hallmark,
    "s5_segmentation":   s5_segmentation,
    "s6_dimensions":     s6_dimensions,
    "s7_plated_solid":   s7_plated_solid,
    "s8_vlm_holistic":   s8_vlm,
    "s10_telemetry":     s10_telemetry,
    "s11_audio_pingcoin": s11_audio,
    "s14_item_consistency": s14_item_consistency,
}

__all__ = list(ACTIVE_WORKERS.keys()) + ["ACTIVE_WORKERS"]
