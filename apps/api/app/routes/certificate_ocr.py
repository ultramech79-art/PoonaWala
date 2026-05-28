"""
POST /api/certificate-ocr

Extracts bill/certificate details from a captured jewellery invoice or
authenticity certificate using Groq vision.
"""
import json
import logging
import os
import re
from typing import Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger("goldeye.certificate_ocr")
router = APIRouter()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")


class CertificateOCRRequest(BaseModel):
    image_data_url: str = Field(..., description="Base64 data URL captured by browser camera")


class CertificateOCRResponse(BaseModel):
    authenticity_found: bool = False
    karat: Optional[float] = None
    weight_g: Optional[float] = None
    huid: Optional[str] = None
    item_description: Optional[str] = None
    bill_number: Optional[str] = None
    jeweller_name: Optional[str] = None
    purchase_date: Optional[str] = None
    confidence: float = 0.0
    notes: list[str] = Field(default_factory=list)


PROMPT = """You are extracting structured data from an Indian gold jewellery bill, invoice, hallmark card, or certificate of authenticity.

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
- Extract HUID/BIS certificate ID if printed.
- Extract item_description from the bill line item, e.g. ring, chain, bangle, necklace, earrings, coin, or pendant. Include short identifying wording only.
- authenticity_found is true if the document appears to be a bill, invoice, certificate, BIS/HUID record, or authenticity card related to gold jewellery.
- confidence must be 0 to 1.
- If uncertain, use null and explain briefly in notes.
"""


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

    return CertificateOCRResponse(
        authenticity_found=bool(raw.get("authenticity_found")),
        karat=karat,
        weight_g=weight,
        huid=(str(raw.get("huid")).strip().upper() if raw.get("huid") else None),
        item_description=(str(raw.get("item_description")).strip() if raw.get("item_description") else None),
        bill_number=(str(raw.get("bill_number")).strip() if raw.get("bill_number") else None),
        jeweller_name=(str(raw.get("jeweller_name")).strip() if raw.get("jeweller_name") else None),
        purchase_date=(str(raw.get("purchase_date")).strip() if raw.get("purchase_date") else None),
        confidence=max(0.0, min(1.0, confidence)),
        notes=[str(n) for n in notes[:5]],
    )


def _parse_json_object(text: str) -> dict:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return {}
    return json.loads(match.group(0))


@router.post("/certificate-ocr", response_model=CertificateOCRResponse)
async def certificate_ocr(req: CertificateOCRRequest):
    if not GROQ_API_KEY:
        logger.warning("GROQ_API_KEY is not configured")
        return CertificateOCRResponse(notes=["OCR unavailable: GROQ_API_KEY not configured"])

    image_url = req.image_data_url
    if not image_url.startswith("data:image/"):
        image_url = f"data:image/jpeg;base64,{image_url.split(',', 1)[-1]}"

    try:
        async with httpx.AsyncClient(timeout=45) as client:
            res = await client.post(
                GROQ_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": GROQ_VISION_MODEL,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": PROMPT},
                            {"type": "image_url", "image_url": {"url": image_url}},
                        ],
                    }],
                    "temperature": 0,
                    "max_tokens": 800,
                },
            )
        if res.status_code != 200:
            logger.warning("Groq OCR returned %s: %s", res.status_code, res.text[:300])
            return CertificateOCRResponse(notes=[f"OCR provider error: {res.status_code}"])

        content = res.json()["choices"][0]["message"]["content"]
        return _normalize_result(_parse_json_object(content))
    except Exception as exc:
        logger.warning("Certificate OCR failed: %s", exc)
        return CertificateOCRResponse(notes=["Could not extract document details"])
