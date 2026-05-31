"""
Tests for the HUID / karat detection + bill-matching pipeline.

These cover the parts the confidence score depends on:
  1. gemini._normalize_macro_detected  — turns a model's free-form macro output
     into reliable karat_numeric / huid_code + boolean *_detected flags, on BOTH
     the Groq-primary and Gemini-fallback paths.
  2. certificate_ocr._normalize_result — extracts + validates the bill HUID,
     rejecting HSN/tariff codes, and converts fineness karats.
  3. A frontend-mirrored bill-HUID match check, so the "bill HUID == typed HUID"
     logic is exercised end to end.
"""
import re

import pytest

from app.data.gemini import _coerce_karat_numeric, _normalize_macro_detected
from app.routes.certificate_ocr import _normalize_result


# ─────────────────────────── 1. karat coercion ───────────────────────────────

@pytest.mark.parametrize("detected,expected", [
    ({"karat_numeric": 18}, 18),                      # already numeric
    ({"karat_numeric": 22.0}, 22),                    # float
    ({"karat_numeric": "18"}, 18),                    # numeric string
    ({"karat_numeric": "18K"}, 18),                   # marking-as-numeric string
    ({"karat_numeric": None, "karat_marking": "18K"}, 18),   # only the marking
    ({"karat_marking": "22K"}, 22),
    ({"karat_marking": "750"}, 18),                   # fineness → 18K
    ({"karat_marking": "916"}, 22),                   # fineness → 22K
    ({"karat_marking": "999"}, 24),                   # fineness → 24K
    ({"karat_marking": None, "karat_numeric": None}, None),
    ({"karat_numeric": 2}, None),                     # out of range
    ({"karat_numeric": 30}, None),                    # out of range
    ({"karat_numeric": True}, None),                  # bool must not be treated as 1
])
def test_coerce_karat_numeric(detected, expected):
    assert _coerce_karat_numeric(detected) == expected


def test_normalize_macro_sets_karat_detected_from_marking_only():
    """The #1 reported bug: model returned '18K' as a marking but no numeric, so
    photo-karat evidence silently dropped. Normalization must recover it."""
    detected = _normalize_macro_detected({"karat_marking": "18K", "karat_numeric": None})
    assert detected["karat_numeric"] == 18
    assert detected["karat_detected"] is True


def test_normalize_macro_price_enrichment():
    detected = _normalize_macro_detected({"karat_marking": "22K"}, live_price=10000.0)
    assert detected["karat_numeric"] == 22
    # 10000 * 22/24 ≈ 9166.67 → rounded
    assert detected["estimated_price_per_g"] == round(10000.0 * 22 / 24, 0)


def test_normalize_macro_no_price_still_detects_karat():
    detected = _normalize_macro_detected({"karat_marking": "22K"}, live_price=0.0)
    assert detected["karat_numeric"] == 22
    assert detected["karat_detected"] is True
    assert "estimated_price_per_g" not in detected


# ─────────────────────────── 2. macro HUID parsing ───────────────────────────

@pytest.mark.parametrize("raw,expected_code,expected_detected", [
    ("AB1234", "AB1234", True),         # valid BIS HUID
    ("ab1234", "AB1234", True),         # lowercased
    ("AB-1234", "AB1234", True),        # separators stripped
    ("AB 1234", "AB1234", True),        # spaces stripped
    ("711311", None, False),            # HSN/tariff code (purely numeric) → rejected
    ("7113", None, False),              # too short numeric
    ("ABC12", None, False),             # 5 chars → rejected
    ("ABC1234", None, False),           # 7 chars → rejected
    (None, None, False),                # nothing read
    ("", None, False),
])
def test_normalize_macro_huid(raw, expected_code, expected_detected):
    detected = _normalize_macro_detected({"huid_code": raw})
    assert detected["huid_code"] == expected_code
    assert detected["huid_detected"] is expected_detected
    # raw is always preserved for debugging
    assert detected["huid_code_raw"] == raw


def test_normalize_macro_handles_non_dict():
    assert _normalize_macro_detected(None)["karat_detected"] is False
    assert _normalize_macro_detected(None)["huid_detected"] is False


# ─────────────────────── 3. certificate / bill OCR HUID ───────────────────────

def test_certificate_ocr_valid_huid():
    res = _normalize_result({
        "authenticity_found": True,
        "karat": 22,
        "weight_g": 10.5,
        "huid": "AB1234",
        "item_description": "ring",
        "confidence": 0.9,
    })
    assert res.huid == "AB1234"
    assert res.huid_explicit is True
    assert res.karat == 22
    assert res.weight_g == 10.5


def test_certificate_ocr_rejects_hsn_code():
    res = _normalize_result({"huid": "711311", "confidence": 0.5})
    assert res.huid is None
    assert res.huid_explicit is False


def test_certificate_ocr_strips_separators_in_huid():
    res = _normalize_result({"huid": "ab-1234", "confidence": 0.5})
    assert res.huid == "AB1234"
    assert res.huid_explicit is True


@pytest.mark.parametrize("fineness,expected", [(750, 18), (916, 22), (995, 24), (999, 24)])
def test_certificate_ocr_fineness_conversion(fineness, expected):
    res = _normalize_result({"karat": fineness, "confidence": 0.5})
    assert res.karat == expected


# ───────────────── 4. bill HUID ↔ typed/photo HUID matching ──────────────────
# Mirrors the frontend normalizeHuid + billHuidMatch / billHuidMismatch logic so
# the cross-check the confidence score relies on is verified here too.

def _norm_huid(value):
    return re.sub(r"[^a-z0-9]", "", (value or ""), flags=re.IGNORECASE).upper()


def _bill_match(bill_huid, item_huid):
    b, i = _norm_huid(bill_huid), _norm_huid(item_huid)
    return {
        "billHuidMatch": bool(b and i and b == i),
        "billHuidMismatch": bool(b and i and b != i),
    }


def test_bill_huid_match_exact():
    m = _bill_match("AB1234", "AB1234")
    assert m["billHuidMatch"] is True and m["billHuidMismatch"] is False


def test_bill_huid_match_different_formatting():
    # Bill OCR returns "ab-1234", item typed "AB1234" → still a match.
    m = _bill_match("ab-1234", "AB1234")
    assert m["billHuidMatch"] is True and m["billHuidMismatch"] is False


def test_bill_huid_mismatch_is_fraud_signal():
    m = _bill_match("AB1234", "XY9999")
    assert m["billHuidMatch"] is False and m["billHuidMismatch"] is True


def test_bill_huid_missing_one_side_is_neutral():
    # No item HUID captured yet → neither match nor mismatch (fall back to other fields).
    m = _bill_match("AB1234", "")
    assert m["billHuidMatch"] is False and m["billHuidMismatch"] is False
