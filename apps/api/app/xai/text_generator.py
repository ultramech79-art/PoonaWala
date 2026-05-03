from __future__ import annotations
"""
Layer 3 XAI: template-based reasoning text in English and Hindi.
PRD FR-OUT-02. Two languages at MVP; extend to 12 at pilot (Phase 8).
"""
from typing import Optional, Union

_TEMPLATES: dict[str, dict[str, str]] = {
    "en": {
        "INSTANT": (
            "✓ BIS hallmark verified  "
            "✓ Weight consistent with estimate  "
            "✓ No fraud signals detected  "
            "✓ Acoustic test: solid gold resonance"
        ),
        "AGENT": (
            "Confidence {conf}% — meets most criteria; "
            "physical verification recommended before final disbursement."
        ),
        "RECAPTURE": (
            "Confidence {conf}% — some signals are inconclusive. "
            "Please retake the {reason} photo for a better estimate."
        ),
        "REJECT": (
            "Confidence {conf}% — insufficient evidence for pre-approval. "
            "We recommend in-branch XRF verification."
        ),
    },
    "hi": {
        "INSTANT": (
            "✓ BIS हॉलमार्क सत्यापित  "
            "✓ वजन अनुमान से मेल खाता है  "
            "✓ कोई धोखाधड़ी संकेत नहीं  "
            "✓ ध्वनि परीक्षण: शुद्ध सोने की प्रतिध्वनि"
        ),
        "AGENT": (
            "विश्वास स्तर {conf}% — अधिकांश मानदंड पूरे होते हैं; "
            "अंतिम संवितरण से पहले भौतिक सत्यापन की सिफारिश की जाती है।"
        ),
        "RECAPTURE": (
            "विश्वास स्तर {conf}% — कुछ संकेत अनिर्णायक हैं। "
            "बेहतर अनुमान के लिए कृपया {reason} फोटो दोबारा लें।"
        ),
        "REJECT": (
            "विश्वास स्तर {conf}% — प्री-अप्रूवल के लिए पर्याप्त साक्ष्य नहीं। "
            "हम शाखा में XRF सत्यापन की सिफारिश करते हैं।"
        ),
    },
}


def generate_reasoning(
    routing: str,
    confidence: float,
    lang: str = "en",
    recapture_reason: str = "hallmark macro",
) -> str:
    templates = _TEMPLATES.get(lang, _TEMPLATES["en"])
    template = templates.get(routing, templates["REJECT"])
    return template.format(
        conf=int(confidence * 100),
        reason=recapture_reason,
    )


def generate_counterfactual(
    routing: str,
    huid_verified: bool,
    confidence: float,
    lang: str = "en",
) -> str | None:
    """
    Layer 4: one-sentence counterfactual.
    Returns None when routing is already INSTANT.
    """
    if routing == "INSTANT":
        return None
    if lang == "hi":
        if not huid_verified:
            return "यदि BIS हॉलमार्क सत्यापित हो जाता, तो विश्वास स्तर ~15–20% बढ़ जाता।"
        if confidence < 0.6:
            return "यदि हॉलमार्क मैक्रो फोटो स्पष्ट होती, तो अनुमानित बैंड ₹5,000–10,000 सँकरा हो सकता था।"
        return None

    if not huid_verified:
        return "If the BIS hallmark were verified, confidence would increase by ~15–20%."
    if confidence < 0.6:
        return (
            "If the hallmark macro photo were sharper, "
            "the estimated band would tighten by ₹5,000–10,000."
        )
    return None
