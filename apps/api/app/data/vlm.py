"""
VLM client — OpenAI-compatible chat/completions endpoint.
Targets vLLM serving Qwen2.5-VL-7B-Instruct but also works with
Groq (llama-3.2-11b-vision) and local Ollama for dev.

URL resolution order:
  1. VLM_API_URL env var
  2. http://localhost:11434/v1  (Ollama default — dev fallback)
"""
import os
import json
import base64
import logging
import re
from typing import Any

import httpx

logger = logging.getLogger("goldeye.ml.vlm")

_BASE_URL = os.getenv("VLM_API_URL", "http://localhost:11434/v1")
_MODEL    = os.getenv("VLM_MODEL", "qwen2.5vl")
_TIMEOUT  = float(os.getenv("VLM_TIMEOUT_S", "30"))
_API_KEY  = os.getenv("VLM_API_KEY", "none")


def _image_content(url: str) -> dict:
    """Build an image_url content block from a data: URI or http(s) URL."""
    if url.startswith("data:"):
        return {"type": "image_url", "image_url": {"url": url}}
    if url.startswith("http://") or url.startswith("https://"):
        return {"type": "image_url", "image_url": {"url": url}}
    # local:// handles (dev stubs) — send a tiny 1×1 transparent PNG so VLM doesn't crash
    DUMMY_PNG = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )
    return {"type": "image_url", "image_url": {"url": DUMMY_PNG}}


async def call_vlm(
    prompt: str,
    image_urls: list[str],
    system: str = "You are an expert jewelry appraiser. Always respond with valid JSON only.",
    max_tokens: int = 512,
) -> dict[str, Any]:
    """
    Send a multimodal request to the VLM endpoint.
    Returns parsed JSON dict from assistant message, or raises on HTTP/parse failure.
    """
    content: list[dict] = [{"type": "text", "text": prompt}]
    for url in image_urls[:6]:  # cap at 6 images to control token budget
        content.append(_image_content(url))

    payload = {
        "model": _MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.0,
    }

    if os.getenv("MOCK_VLM_FOR_TESTING") == "1":
        # Simulate VLM JSON responses based on prompt keywords to avoid worker fallbacks in E2E tests
        if "BIS hallmark" in prompt:
            return {
                "bis_logo_present": True,
                "purity_mark": "22K916",
                "huid_code": "A1B2C3",
                "stamp_appearance": "laser_engraved",
                "ocr_confidence": 0.95
            }
        elif "solid gold or gold-plated" in prompt:
            return {
                "solid_probability": 0.92,
                "plated_probability": 0.08,
                "visual_cues": ["uniform color at joints", "no worn edges"],
                "confidence": 0.90
            }
        elif "Indian gold jewelry" in prompt:
            # S8 holistic assessment mock — complete response
            return {
                "item_type": "ring",
                "estimated_karat_band": [20, 22],
                "stones_present": False,
                "stones_estimated_carat_total": 0.0,
                "visible_wear": "low",
                "concerns": [],
                "confidence": 0.82
            }
        else:
            # Generic fallback — still complete for S8-style callers
            return {
                "item_type": "other",
                "estimated_karat_band": [18, 22],
                "stones_present": False,
                "stones_estimated_carat_total": 0.0,
                "visible_wear": "low",
                "concerns": [],
                "confidence": 0.8
            }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{_BASE_URL}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {_API_KEY}"},
        )
        resp.raise_for_status()

    raw = resp.json()["choices"][0]["message"]["content"]
    # Strip markdown fences if model wraps JSON in ```json ... ```
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.DOTALL)
    return json.loads(clean)
