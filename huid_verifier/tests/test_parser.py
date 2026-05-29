"""
Unit tests for the BIS CARE result-screen parser.
No Appium or network calls required.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app.models import VerificationStatus
from app.parser import parse_result_screen, detect_purity, detect_failure, detect_article_type


# ── detect_failure ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "HUID not found",
    "Invalid HUID",
    "No record found for this hallmark",
    "This HUID does not exist",
    "Please try again later",
    "HUID not registered",
    "Hallmark not found in database",
])
def test_failure_detected(text):
    assert detect_failure(text), f"Expected failure in: '{text}'"


def test_no_false_failure_on_valid_text():
    assert not detect_failure("Purity: 22K916  Ring  Registered")


# ── detect_purity ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("Purity 22K", "22K916"),
    ("Fineness: 916", "22K916"),
    ("18K gold bangle", "18K750"),
    ("Fineness 750", "18K750"),
    ("14K ring 585 fineness", "14K585"),
    ("Fineness: 585", "14K585"),
    ("24K coin 999 pure", "24K999"),
    ("Fineness 999", "24K999"),
])
def test_purity_detected(text, expected):
    assert detect_purity(text) == expected, f"Expected {expected} from: '{text}'"


def test_purity_not_found_on_failure_text():
    assert detect_purity("HUID not found") is None


def test_purity_none_on_empty():
    assert detect_purity("") is None


# ── detect_article_type ────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("Article: Ring  Fineness 22K", "ring"),
    ("Gold Chain 916", "chain"),
    ("Bangle 18K750", "bangle"),
    ("Bracelet fineness 585", "bracelet"),
    ("Necklace 22K916", "necklace"),
    ("Earring  Purity 750", "earring"),
    ("Gold Pendant 14K", "pendant"),
    ("Coin 24K999 pure gold", "coin"),
])
def test_article_type_detected(text, expected):
    assert detect_article_type(text) == expected


# ── parse_result_screen ────────────────────────────────────────────────────────

def test_verified_with_22k():
    result = parse_result_screen("HUID: ABC123  Purity: 22K916  Article: Ring  Registered")
    assert result.status == VerificationStatus.VERIFIED
    assert result.confidence == 95
    assert result.purity == "22K916"
    assert result.article_type == "ring"


def test_verified_with_18k():
    result = parse_result_screen("Fineness 18K 750 Chain article verified")
    assert result.status == VerificationStatus.VERIFIED
    assert result.purity == "18K750"


def test_not_verified():
    result = parse_result_screen("HUID not found in database. Please check the number.")
    assert result.status == VerificationStatus.NOT_VERIFIED
    assert result.confidence == 0
    assert result.purity is None


def test_needs_manual_review_on_ambiguous():
    # Result screen captured but no purity keyword and no failure keyword
    result = parse_result_screen("BIS CARE  Hallmark Verification  Details loading...")
    assert result.status == VerificationStatus.NEEDS_MANUAL_REVIEW
    assert result.confidence == 60


def test_needs_manual_review_on_empty():
    result = parse_result_screen("")
    assert result.status == VerificationStatus.NEEDS_MANUAL_REVIEW
    assert result.confidence == 60


def test_not_verified_with_try_again():
    result = parse_result_screen("Invalid HUID. Please try again.")
    assert result.status == VerificationStatus.NOT_VERIFIED


def test_verified_with_14k():
    result = parse_result_screen("Article type: Pendant  Fineness: 585 (14K) Gold  Status: Verified")
    assert result.status == VerificationStatus.VERIFIED
    assert result.purity == "14K585"
    assert result.article_type == "pendant"
