"""
Parse raw Appium page source / visible text from the BIS CARE result screen.

No Appium dependency — safe to unit-test standalone.
"""
import re
from typing import Optional

from app.models import VerificationStatus

# ── Failure signals ────────────────────────────────────────────────────────────
_FAILURE_PATTERNS = [
    r"not\s+found",
    r"invalid\s+huid",
    r"invalid\s+hallmark",
    r"no\s+record",
    r"does\s+not\s+exist",
    r"try\s+again",
    r"huid\s+not\s+registered",
    r"not\s+registered",
    r"hallmark\s+not\s+found",
]

# ── Purity mapping ─────────────────────────────────────────────────────────────
_PURITY_RULES: list[tuple[list[str], str]] = [
    (["999", "24k", "24 k"], "24K999"),
    (["916", "22k", "22 k"], "22K916"),
    (["750", "18k", "18 k"], "18K750"),
    (["585", "14k", "14 k"], "14K585"),
    (["375", "9k", "9 k"], "9K375"),
]

# ── Article types ──────────────────────────────────────────────────────────────
_ARTICLE_TYPES = [
    "ring", "chain", "bangle", "bracelet",
    "necklace", "earring", "pendant", "coin",
    "kangan", "haar", "mangalsutra",
]


def _normalise(text: str) -> str:
    """Lower-case, collapse whitespace, keep alphanumerics and spaces."""
    return re.sub(r"\s+", " ", text.lower().strip())


def detect_failure(text: str) -> bool:
    norm = _normalise(text)
    return any(re.search(pat, norm) for pat in _FAILURE_PATTERNS)


def detect_purity(text: str) -> Optional[str]:
    norm = _normalise(text)
    for keywords, label in _PURITY_RULES:
        if any(kw in norm for kw in keywords):
            return label
    return None


def detect_article_type(text: str) -> Optional[str]:
    norm = _normalise(text)
    # Sort longest first so "earring" is checked before "ring", "bracelet" before "bangle", etc.
    for article in sorted(_ARTICLE_TYPES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(article)}\b", norm):
            return article
    return None


def detect_jeweller_name(text: str) -> Optional[str]:
    """Extract jeweller name from BIS CARE result screen."""
    patterns = [
        r"jeweller\s*(?:name)?\s*[:\-]\s*(.+)",
        r"bis\s+licensed\s+jeweller\s*[:\-]\s*(.+)",
        r"hallmarking\s+(?:by|from)\s*[:\-]?\s*(.+)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()[:120]
    return None


def detect_hallmark_date(text: str) -> Optional[str]:
    """Extract hallmark/assaying date from BIS CARE result screen."""
    patterns = [
        r"date\s+of\s+hallmark(?:ing)?\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})",
        r"hallmark\s+date\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})",
        r"assay(?:ing)?\s+date\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})",
        r"date\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


class ParseResult:
    __slots__ = ("status", "confidence", "purity", "article_type", "jeweller_name", "hallmark_date")

    def __init__(
        self,
        status: VerificationStatus,
        confidence: int,
        purity: Optional[str],
        article_type: Optional[str],
        jeweller_name: Optional[str] = None,
        hallmark_date: Optional[str] = None,
    ) -> None:
        self.status = status
        self.confidence = confidence
        self.purity = purity
        self.article_type = article_type
        self.jeweller_name = jeweller_name
        self.hallmark_date = hallmark_date


def parse_result_screen(raw_text: str) -> ParseResult:
    """
    Given raw text captured from the BIS CARE result screen, return a ParseResult.

    Decision logic:
      1. If failure keyword found       → NOT_VERIFIED  (confidence 0)
      2. If purity found                → VERIFIED      (confidence 95)
      3. Otherwise (screen captured but parser can't extract) → NEEDS_MANUAL_REVIEW (confidence 60)
    """
    if not raw_text or not raw_text.strip():
        return ParseResult(VerificationStatus.NEEDS_MANUAL_REVIEW, 60, None, None)

    if detect_failure(raw_text):
        return ParseResult(VerificationStatus.NOT_VERIFIED, 0, None, None)

    purity = detect_purity(raw_text)
    article = detect_article_type(raw_text)
    jeweller = detect_jeweller_name(raw_text)
    hallmark_date = detect_hallmark_date(raw_text)

    if purity:
        return ParseResult(VerificationStatus.VERIFIED, 95, purity, article, jeweller, hallmark_date)

    return ParseResult(VerificationStatus.NEEDS_MANUAL_REVIEW, 60, None, article, jeweller, hallmark_date)
