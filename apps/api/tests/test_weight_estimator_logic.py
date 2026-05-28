def test_density_increases_with_karat():
    from app.data.gold_physics import density_for_karat

    d18 = density_for_karat(18)
    d22 = density_for_karat(22)
    d24 = density_for_karat(24)

    assert d18.low < d18.mid < d18.high
    assert d18.mid < d22.mid < d24.mid
    assert 15.0 <= d18.mid <= 16.5
    assert 17.0 <= d22.mid <= 18.5
    assert d24.mid == 19.32


def test_rs10_and_rs20_coin_reference_share_27mm_diameter():
    from app.data.image_utils import coin_spec

    rs10 = coin_spec("rs10_coin")
    rs20 = coin_spec("rs20_coin")

    assert rs10["diameter_mm"] == 27.0
    assert rs20["diameter_mm"] == 27.0
    assert rs10["weight_g"] == 7.71
    assert rs20["weight_g"] == 8.54


def test_same_volume_estimates_more_weight_for_higher_karat():
    from app.data.image_utils import estimate_weight_range_from_volume

    volume = {"volume_cm3": 1.0, "volume_low_cm3": 0.9, "volume_high_cm3": 1.1}
    w18 = estimate_weight_range_from_volume(volume, karat=18)
    w22 = estimate_weight_range_from_volume(volume, karat=22)
    w24 = estimate_weight_range_from_volume(volume, karat=24)

    assert w18["estimated_weight_g"] < w22["estimated_weight_g"] < w24["estimated_weight_g"]
    assert w18["band_low_g"] < w18["estimated_weight_g"] < w18["band_high_g"]
    assert w24["density_g_cm3"] == 19.32


def test_reference_free_visual_prior_uses_geometry_not_static_mean():
    from app.data.image_utils import estimate_volume_from_measurement, estimate_weight_range_from_volume

    small_compact = {
        "area_px2": 5_000,
        "image_area_px2": 1_000_000,
        "width_px": 90,
        "height_px": 80,
        "major_axis_px": 95,
        "minor_axis_px": 75,
        "fill_ratio": 0.72,
        "component_count": 1,
    }
    large_hollow = {
        "area_px2": 150_000,
        "image_area_px2": 1_000_000,
        "width_px": 520,
        "height_px": 440,
        "major_axis_px": 520,
        "minor_axis_px": 430,
        "fill_ratio": 0.34,
        "component_count": 1,
    }

    small_volume = estimate_volume_from_measurement(small_compact, None)
    large_volume = estimate_volume_from_measurement(large_hollow, None)
    small_weight = estimate_weight_range_from_volume(small_volume, karat=22)
    large_weight = estimate_weight_range_from_volume(large_volume, karat=22)

    assert small_volume["method"] == "reference_free_visual_prior"
    assert large_volume["method"] == "reference_free_visual_prior"
    assert small_weight["estimated_weight_g"] != 7.9
    assert large_weight["estimated_weight_g"] > small_weight["estimated_weight_g"]
    assert large_weight["band_high_g"] - large_weight["band_low_g"] > 20


def test_fusion_reapplies_density_from_purity_band_to_volume():
    from app.workers.fusion import fuse

    base = {
        "huid_verified": 0.0,
        "ocr_confidence": 0.5,
        "hallmark_quality_score": 0.5,
        "coin_detected": 1.0,
        "jewelry_area_px2": 40000.0,
        "estimated_weight_g": 17.0,
        "estimated_weight_low_g": 14.0,
        "estimated_weight_high_g": 20.0,
        "estimated_volume_cm3": 1.0,
        "volume_low_cm3": 0.95,
        "volume_high_cm3": 1.05,
        "weight_method_hybrid": 0.0,
        "solid_probability_s7": 0.9,
        "vlm_confidence": 0.8,
        "telemetry_anomaly_score": 0.02,
        "audio_solid_probability": 0.8,
        "audio_confidence": 0.6,
        "color_confidence": 0.0,
        "specular_metal_score": 0.7,
    }
    low_purity = fuse({**base, "vlm_karat_mid": 18.0}, manual_weight_g=None)
    high_purity = fuse({**base, "vlm_karat_mid": 22.0}, manual_weight_g=None)

    assert low_purity["final_weight_g"] < high_purity["final_weight_g"]
    assert low_purity["density_g_cm3"] < high_purity["density_g_cm3"]
    assert low_purity["weight_lo_g"] < low_purity["final_weight_g"] < low_purity["weight_hi_g"]
