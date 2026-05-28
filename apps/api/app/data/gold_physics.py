"""
Gold alloy physics helpers used by the weight estimator.

Karat controls density. A camera can estimate volume from geometry, but grams
must be calculated after purity is known or bounded.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DensityBand:
    low: float
    mid: float
    high: float


AU_DENSITY_G_CM3 = 19.32
AG_DENSITY_G_CM3 = 10.49
CU_DENSITY_G_CM3 = 8.96
ZN_DENSITY_G_CM3 = 7.14


def _alloy_density(gold_fraction: float, alloy_mix: dict[str, float]) -> float:
    """Density from mass fractions using the inverse rule of mixtures."""
    gold_fraction = max(0.0, min(0.999, gold_fraction))
    remainder = 1.0 - gold_fraction
    specific_volume = gold_fraction / AU_DENSITY_G_CM3
    specific_volume += remainder * (
        alloy_mix.get("ag", 0.0) / AG_DENSITY_G_CM3
        + alloy_mix.get("cu", 0.0) / CU_DENSITY_G_CM3
        + alloy_mix.get("zn", 0.0) / ZN_DENSITY_G_CM3
    )
    return 1.0 / specific_volume


def density_for_karat(karat: float | int) -> DensityBand:
    """
    Return a practical density band for yellow Indian jewellery gold.

    The mid value assumes a balanced silver/copper alloy. The low value assumes
    copper/zinc-rich alloying; the high value assumes silver-rich alloying.
    """
    k = max(8.0, min(24.0, float(karat)))
    if k >= 23.9:
        return DensityBand(low=19.20, mid=AU_DENSITY_G_CM3, high=19.32)

    gold_fraction = k / 24.0
    low = _alloy_density(gold_fraction, {"cu": 0.80, "zn": 0.20})
    mid = _alloy_density(gold_fraction, {"ag": 0.50, "cu": 0.50})
    high = _alloy_density(gold_fraction, {"ag": 1.00})
    return DensityBand(low=round(low, 3), mid=round(mid, 3), high=round(high, 3))


def density_band_for_karat_range(karat_low: float | int, karat_high: float | int) -> DensityBand:
    """Density band covering both purity uncertainty and alloy-composition spread."""
    lo = density_for_karat(karat_low)
    mid = density_for_karat((float(karat_low) + float(karat_high)) / 2.0)
    hi = density_for_karat(karat_high)
    return DensityBand(low=lo.low, mid=mid.mid, high=hi.high)

