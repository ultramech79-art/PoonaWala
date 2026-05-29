"""
Unit tests for HUID format validation.
No Appium or network calls required.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app.main import validate_huid


# ── Valid HUIDs ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("huid", [
    "ABC123",
    "A1B2C3",
    "000000",
    "ZZZZZZ",
    "123456",
    "aaaaaa",   # lowercase — should be normalised to AAAAAA
    "  abc123 ", # surrounding whitespace
])
def test_valid_huids(huid):
    is_valid, normalised = validate_huid(huid)
    assert is_valid, f"Expected '{huid}' to be valid"
    assert normalised == huid.strip().upper()


# ── Invalid HUIDs ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("huid,reason", [
    ("ABC12",   "only 5 chars"),
    ("ABC1234", "7 chars"),
    ("ABC-12",  "hyphen not allowed"),
    ("ABC 12",  "internal space not allowed"),
    ("abc_12",  "underscore not allowed"),
    ("",        "empty string"),
    ("      ",  "whitespace only"),
    ("!@#$%^",  "special characters"),
    ("ABCDE.",  "dot not allowed"),
])
def test_invalid_huids(huid, reason):
    is_valid, _ = validate_huid(huid)
    assert not is_valid, f"Expected '{huid}' ({reason}) to be invalid"


# ── Normalisation ──────────────────────────────────────────────────────────────

def test_lowercase_normalised_to_uppercase():
    is_valid, normalised = validate_huid("abc123")
    assert is_valid
    assert normalised == "ABC123"


def test_whitespace_stripped():
    # "AB1234" is exactly 6 alphanumeric chars → valid after stripping spaces
    is_valid, normalised = validate_huid("  AB1234  ")
    assert is_valid
    assert normalised == "AB1234"

    # "ABC12" is only 5 chars → invalid
    is_valid2, _ = validate_huid("  ABC12  ")
    assert not is_valid2

    is_valid3, normalised3 = validate_huid("  ABC123  ")
    assert is_valid3
    assert normalised3 == "ABC123"
