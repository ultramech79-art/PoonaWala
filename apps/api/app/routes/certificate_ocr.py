"""
POST /api/certificate-ocr

Extracts bill/certificate details from a captured jewellery invoice or
authenticity certificate using Groq vision with Gemini fallback.
"""
import re
import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.data.gemini import (
    GEMINI_GUIDANCE_FALLBACK_API_KEYS,
    GEMINI_MODEL,
    GROQ_PRIMARY_API_KEYS,
    _gemini_request,
    extract_gemini_text,
    parse_json_response,
)
from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys

logger = logging.getLogger("goldeye.certificate_ocr")
router = APIRouter()

_HUID_RE = re.compile(r'^[A-Z0-9]{6}$')


class CertificateOCRRequest(BaseModel):
    image_data_url: str = Field(..., description="Base64 data URL captured by browser camera")
    item_type_hint: Optional[str] = Field(
        default=None,
        description="Jewellery type from previously analysed photos (e.g. 'ring'). "
                    "Used to select the matching line item when a bill lists multiple items.",
    )


class CertificateOCRResponse(BaseModel):
    authenticity_found: bool = False
    karat: Optional[float] = None
    weight_g: Optional[float] = None
    huid: Optional[str] = None
    huid_explicit: bool = False  # True when a proper 6-char BIS HUID was found (not an HSN tariff code)
    item_description: Optional[str] = None
    bill_number: Optional[str] = None
    jeweller_name: Optional[str] = None
    purchase_date: Optional[str] = None
    confidence: float = 0.0
    notes: list[str] = Field(default_factory=list)


_BASE_PROMPT = """You are extracting structured data from an Indian gold jewellery bill, invoice, hallmark card, or certificate of authenticity.

Return ONLY valid JSON with this exact schema:
{
  "authenticity_found": boolean,
  "karat": number|null,
  "weight_g": number|null,
  "huid": string|null,
  "item_description": string|null,
  "bill_number": string|null,
  "jeweller_name": string|null,
  "purchase_date": string|null,
  "confidence": number,
  "notes": string[]
}

Rules:
- Extract karat only when explicitly printed as 18K, 20K, 22K, 24K, 750, 916, 995, or 999.
- Convert 750→18, 916→22, 995/999→24.
- Extract net gold weight in grams if available. Prefer net weight over gross weight.
- If only gross weight is visible, use it only if it clearly refers to gold item weight and note that it is gross.
- Extract the BIS HUID if printed. A HUID is exactly 6 alphanumeric characters (e.g. "AB1234"). Do NOT extract HSN codes (purely numeric tariff codes like 711311 or 7113).
- Extract item_description from the bill line item, e.g. ring, chain, bangle, necklace, earrings, coin, or pendant. Include short identifying wording only.
- authenticity_found is true if the document appears to be a bill, invoice, certificate, BIS/HUID record, or authenticity card related to gold jewellery.
- confidence must be 0 to 1.
- If uncertain, use null and explain briefly in notes.
"""


def _build_prompt(item_type_hint: Optional[str]) -> str:
    if not item_type_hint:
        return _BASE_PROMPT
    hint = item_type_hint.strip().lower()
    return (
        _BASE_PROMPT
        + f"\nIMPORTANT: This bill may list multiple jewellery items. "
          f"Extract details ONLY for the {hint} item. "
          f"If no {hint} is listed, return the closest matching item and note the mismatch."
    )


def _normalize_result(raw: dict) -> CertificateOCRResponse:
    karat = raw.get("karat")
    try:
        karat = float(karat) if karat is not None else None
    except (TypeError, ValueError):
        karat = None
    if karat in (750, 916, 995, 999):
        karat = 18 if karat == 750 else 22 if karat == 916 else 24
    if karat is not None and not (18 <= karat <= 24):
        karat = None

    weight = raw.get("weight_g")
    try:
        weight = float(weight) if weight is not None else None
    except (TypeError, ValueError):
        weight = None
    if weight is not None and not (0 < weight <= 1000):
        weight = None

    confidence = raw.get("confidence", 0)
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0

    notes = raw.get("notes") if isinstance(raw.get("notes"), list) else []

    # HUID: must be exactly 6 alphanumeric characters and not purely numeric (HSN codes are numeric).
    raw_huid_input = raw.get("huid")
    # Clean separators/spaces the model may include ("AB 1234" / "AB-1234") before validating.
    raw_huid = re.sub(r"[^A-Za-z0-9]", "", str(raw_huid_input)).upper() if raw_huid_input else None
    huid_explicit = bool(raw_huid and _HUID_RE.match(raw_huid) and not raw_huid.isdigit())
    huid_val = raw_huid if huid_explicit else None

    logger.info(
        "certificate_ocr normalized: huid_raw=%r -> huid=%s (explicit=%s) | karat=%s weight_g=%s | "
        "item=%r bill_no=%r jeweller=%r date=%r | authenticity=%s confidence=%.2f",
        raw_huid_input,
        huid_val,
        huid_explicit,
        karat,
        weight,
        raw.get("item_description"),
        raw.get("bill_number"),
        raw.get("jeweller_name"),
        raw.get("purchase_date"),
        bool(raw.get("authenticity_found")),
        max(0.0, min(1.0, confidence)),
    )
    if raw_huid and not huid_explicit:
        logger.info(
            "certificate_ocr HUID rejected (not a 6-char BIS HUID — likely HSN/tariff code): %r",
            raw_huid,
        )

    return CertificateOCRResponse(
        authenticity_found=bool(raw.get("authenticity_found")),
        karat=karat,
        weight_g=weight,
        huid=huid_val,
        huid_explicit=huid_explicit,
        item_description=(str(raw.get("item_description")).strip() if raw.get("item_description") else None),
        bill_number=(str(raw.get("bill_number")).strip() if raw.get("bill_number") else None),
        jeweller_name=(str(raw.get("jeweller_name")).strip() if raw.get("jeweller_name") else None),
        purchase_date=(str(raw.get("purchase_date")).strip() if raw.get("purchase_date") else None),
        confidence=max(0.0, min(1.0, confidence)),
        notes=[str(n) for n in notes[:5]],
    )


@router.post("/certificate-ocr", response_model=CertificateOCRResponse)
async def certificate_ocr(req: CertificateOCRRequest):
    if not GROQ_PRIMARY_API_KEYS and not GEMINI_GUIDANCE_FALLBACK_API_KEYS:
        logger.warning("No OCR provider keys are configured")
        return CertificateOCRResponse(notes=["OCR unavailable: provider API keys not configured"])

    image_b64 = req.image_data_url.split(",", 1)[-1]
    prompt = _build_prompt(req.item_type_hint)

    errors: list[str] = []
    if GROQ_PRIMARY_API_KEYS:
        try:
            data, success = await call_groq_vision_with_keys(
                prompt,
                image_b64,
                GROQ_PRIMARY_API_KEYS,
                "image/jpeg",
                timeout=45,
            )
            if success:
                content = extract_gemini_text(data)
                logger.info("certificate_ocr Groq primary ok using %s", GROQ_MODEL)
                return _normalize_result(parse_json_response(content))
            errors.append(str(data.get("error") or "groq_failed"))
        except Exception as exc:
            logger.warning("Certificate OCR Groq primary failed: %s", exc)
            errors.append(f"groq: {exc}")

    if not GEMINI_GUIDANCE_FALLBACK_API_KEYS:
        return CertificateOCRResponse(notes=["Groq OCR failed and Gemini fallback is not configured"])

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": image_b64}},
            ]
        }],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 800,
            "responseMimeType": "application/json",
        },
    }
    try:
        data, success = await _gemini_request(payload, timeout=45, api_keys=GEMINI_GUIDANCE_FALLBACK_API_KEYS)
        if success:
            content = extract_gemini_text(data)
            logger.info("certificate_ocr Gemini fallback ok using %s", GEMINI_MODEL)
            return _normalize_result(parse_json_response(content))
        errors.append(str(data.get("error") or "gemini_failed"))
    except Exception as exc:
        logger.warning("Certificate OCR Gemini fallback failed: %s", exc)
        errors.append(f"gemini: {exc}")

    return CertificateOCRResponse(notes=["Could not extract document details", *errors[:2]])
