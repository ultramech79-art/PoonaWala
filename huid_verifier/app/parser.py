"""
Parse raw Appium page source / visible text from the BIS CARE result screen.

No Appium dependency — safe to unit-test standalone.
"""
import re
import xml.etree.ElementTree as ET
from typing import Optional

from app.models import VerificationStatus


def _extract_texts_from_xml(xml_str: str) -> list[str]:
    """Extract all non-empty text attribute values from Appium page_source XML in document order."""
    try:
        root = ET.fromstring(xml_str)
        texts = []
        for node in root.iter():
            t = node.attrib.get("text", "").strip()
            if t:
                texts.append(t)
        if texts:
            return texts
    except ET.ParseError:
        pass
    # Fallback: regex extraction of text="..." attributes (handles malformed XML)
    return [m for m in re.findall(r'text="([^"]+)"', xml_str) if m.strip()]


def _xml_to_flat(xml_str: str) -> str:
    """Convert XML page_source to a flat newline-separated string."""
    return "\n".join(_extract_texts_from_xml(xml_str))


def _extract_value_after_label(texts: list[str], label: str) -> Optional[str]:
    """
    In the ordered text list, find the first occurrence of *label* (case-insensitive)
    and return the next non-empty, non-label-looking text as the value.
    """
    label_lower = label.lower()
    for i, t in enumerate(texts):
        if t.lower().strip(": ") == label_lower:
            # Next item(s) that aren't just another label
            for j in range(i + 1, min(i + 4, len(texts))):
                candidate = texts[j].strip()
                if candidate and not candidate.endswith(":"):
                    return candidate
    return None

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


def detect_purity(text: str, xml_texts: Optional[list[str]] = None) -> Optional[str]:
    # Try XML label "Purity/Fineness" first — most precise
    if xml_texts:
        val = _extract_value_after_label(xml_texts, "Purity/Fineness")
        if val:
            norm_val = _normalise(val)
            for keywords, label in _PURITY_RULES:
                if any(kw in norm_val for kw in keywords):
                    return label
            # Return raw value if it looks like a purity code (e.g. "22K916")
            if re.match(r"^\d{2}K\d{3}$", val.strip(), re.IGNORECASE):
                return val.strip().upper()
    norm = _normalise(text)
    for keywords, label in _PURITY_RULES:
        if any(kw in norm for kw in keywords):
            return label
    return None


def detect_article_type(text: str, xml_texts: Optional[list[str]] = None) -> Optional[str]:
    if xml_texts:
        val = _extract_value_after_label(xml_texts, "Article Type")
        if val:
            return val.strip().lower()
    norm = _normalise(text)
    for article in sorted(_ARTICLE_TYPES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(article)}\b", norm):
            return article
    return None


def detect_jeweller_name(text: str, xml_texts: Optional[list[str]] = None) -> Optional[str]:
    if xml_texts:
        for label in ("Jeweller Name", "Jeweller", "BIS Licensed Jeweller"):
            val = _extract_value_after_label(xml_texts, label)
            if val and len(val) > 2:
                return val[:120]
    for pat in [r"jeweller\s*(?:name)?\s*[:\-]\s*(.+)", r"bis\s+licensed\s+jeweller\s*[:\-]\s*(.+)"]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()[:120]
    return None


def detect_hallmark_date(text: str, xml_texts: Optional[list[str]] = None) -> Optional[str]:
    _DATE_RE = re.compile(r"\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}")
    if xml_texts:
        for label in ("Date of Hallmarking", "Hallmark Date", "Assaying Date", "Date"):
            val = _extract_value_after_label(xml_texts, label)
            if val and _DATE_RE.search(val):
                return _DATE_RE.search(val).group(0)
    for pat in [
        r"date\s+of\s+hallmark(?:ing)?\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})",
        r"hallmark\s+date\s*[:\-]\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})",
    ]:
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
    Given raw Appium page_source (XML) or plain text from BIS CARE, return a ParseResult.

    Decision logic:
      1. If failure keyword found       → NOT_VERIFIED  (confidence 0)
      2. If purity found                → VERIFIED      (confidence 95)
      3. Otherwise                      → NEEDS_MANUAL_REVIEW (confidence 60)
    """
    if not raw_text or not raw_text.strip():
        return ParseResult(VerificationStatus.NEEDS_MANUAL_REVIEW, 60, None, None)

    # For XML page_source, build both a flat string and ordered text list
    is_xml = raw_text.lstrip().startswith("<")
    flat = _xml_to_flat(raw_text) if is_xml else raw_text
    xml_texts = _extract_texts_from_xml(raw_text) if is_xml else None

    if detect_failure(flat):
        return ParseResult(VerificationStatus.NOT_VERIFIED, 0, None, None)

    purity = detect_purity(flat, xml_texts)
    article = detect_article_type(flat, xml_texts)
    jeweller = detect_jeweller_name(flat, xml_texts)
    hallmark_date = detect_hallmark_date(flat, xml_texts)

    if purity:
        return ParseResult(VerificationStatus.VERIFIED, 95, purity, article, jeweller, hallmark_date)

    return ParseResult(VerificationStatus.NEEDS_MANUAL_REVIEW, 60, None, article, jeweller, hallmark_date)
