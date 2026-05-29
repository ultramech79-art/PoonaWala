"""
Gemini API integration for multimodal analysis.
Used for:
1. Audio analysis (S11) — gold solid vs plated detection
2. Image fallback (S3, S7, S8) — color, purity, authenticity
3. Structured decision-making — where ML models haven't been trained
"""
import os
import json
import re
import logging
import asyncio
from typing import Optional
import aiohttp

logger = logging.getLogger("goldeye.gemini")


def _split_keys(*names: str) -> list[str]:
    keys: list[str] = []
    for name in names:
        raw = os.getenv(name, "")
        for key in raw.split(","):
            key = key.strip()
            if key and key not in keys:
                keys.append(key)
    return keys


GROQ_PRIMARY_API_KEYS = _split_keys("GROQ_PRIMARY_API_KEY_1", "GROQ_PRIMARY_API_KEY_2")
GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS = _split_keys("GROQ_AUDIO_VIDEO_FALLBACK_API_KEY")
GROQ_GUIDANCE_API_KEYS = _split_keys("GROQ_GUIDANCE_API_KEY")

GEMINI_AUDIO_VIDEO_API_KEYS = _split_keys("GEMINI_AUDIO_VIDEO_API_KEY")
GEMINI_GUIDANCE_FALLBACK_API_KEYS = _split_keys("GEMINI_GUIDANCE_FALLBACK_API_KEY")
# Gemini API Configuration. Keep this env-driven so local and Render deployments
# can pin a released multimodal model without code changes.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
GEMINI_API_VERSION = os.getenv("GEMINI_API_VERSION", "v1beta").strip() or "v1beta"
GEMINI_THINKING_LEVEL = os.getenv("GEMINI_THINKING_LEVEL", "minimal").strip() or "minimal"
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/{GEMINI_API_VERSION}/models/{GEMINI_MODEL}:generateContent"


class GeminiResponseError(ValueError):
    """Raised when Gemini returns HTTP 200 without usable text content."""


def extract_gemini_text(data: dict) -> str:
    """Return concatenated Gemini text parts or raise with useful diagnostics."""
    candidates = data.get("candidates") or []
    if not candidates:
        raise GeminiResponseError(f"Gemini returned no candidates: {json.dumps(data)[:500]}")

    cand = candidates[0] or {}
    finish_reason = cand.get("finishReason")
    safety = cand.get("safetyRatings")
    parts = ((cand.get("content") or {}).get("parts") or [])
    texts = [str(part.get("text", "")) for part in parts if part.get("text")]
    text = "\n".join(t.strip() for t in texts if t and t.strip()).strip()
    if text:
        return text

    raise GeminiResponseError(
        "Gemini returned an empty text response "
        f"(model={GEMINI_MODEL}, finishReason={finish_reason}, safety={safety})"
    )


def parse_json_response(text: str) -> dict:
    """Robustly extracts and parses JSON from LLM conversational text."""
    text = text.strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strip standard markdown fences if present
    cleaned = text
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Fallback: extract the JSON object using regex search
    match = re.search(r'(\{.*\})', cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Extreme fallback: try cleaning trailing commas
    cleaned_fuzzy = re.sub(r',\s*([\]\}])', r'\1', cleaned)
    match_fuzzy = re.search(r'(\{.*\})', cleaned_fuzzy, re.DOTALL)
    if match_fuzzy:
        try:
            return json.loads(match_fuzzy.group(1))
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("Could not extract or parse valid JSON from LLM response", text, 0)

# Shared session to avoid socket exhaustion and 'instant' failures
_session: Optional[aiohttp.ClientSession] = None

async def _get_session() -> aiohttp.ClientSession:
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=100, keepalive_timeout=60),
            timeout=aiohttp.ClientTimeout(total=60)
        )
    return _session

async def _gemini_request(
    payload: dict,
    timeout: int = 45,
    attempt: int = 0,
    retry_count: int = 0,
    api_keys: Optional[list[str]] = None,
    max_retries: int = 3,
) -> tuple[dict, bool]:
    """
    Make a Gemini API request with fallback to other API keys and retries.
    Returns (response_data, success).
    """
    keys = api_keys if api_keys is not None else GEMINI_GUIDANCE_FALLBACK_API_KEYS
    if attempt >= len(keys):
        return {"error": "all_keys_failed"}, False

    current_key = keys[attempt]
    
    # REST v1 accepts proto-style snake_case; v1beta accepts camelCase.
    # Normalize in one place so route code can use the familiar Gemini SDK names.
    gc = payload.get("generationConfig") or payload.get("generation_config")
    if gc:
        gc = dict(gc)
        schema = gc.get("responseSchema") or gc.get("response_schema")
        max_tokens = gc.get("maxOutputTokens") or gc.get("max_output_tokens")
        response_mime = gc.get("responseMimeType") or gc.get("response_mime_type")
        thinking = gc.get("thinkingConfig") or gc.get("thinking_config")
        if not thinking and GEMINI_MODEL.startswith("gemini-3"):
            thinking = {"thinkingLevel": GEMINI_THINKING_LEVEL}

        if GEMINI_API_VERSION == "v1":
            normalized_gc = {}
            if "temperature" in gc:
                normalized_gc["temperature"] = gc["temperature"]
            if max_tokens:
                normalized_gc["max_output_tokens"] = max_tokens
            # The public v1 REST endpoint currently rejects response_mime_type
            # and response_schema for this model. Keep JSON enforcement in the
            # prompt and parser for v1; use strict fields only on v1beta.
            if thinking:
                level = thinking.get("thinkingLevel") or thinking.get("thinking_level")
                budget = thinking.get("thinkingBudget") or thinking.get("thinking_budget")
                normalized_thinking = {}
                if level:
                    normalized_thinking["thinking_level"] = level
                if budget is not None:
                    normalized_thinking["thinking_budget"] = budget
                if normalized_thinking:
                    normalized_gc["thinking_config"] = normalized_thinking
            payload["generation_config"] = normalized_gc
            if "generationConfig" in payload:
                del payload["generationConfig"]
        else:
            normalized_gc = {}
            if "temperature" in gc:
                normalized_gc["temperature"] = gc["temperature"]
            if max_tokens:
                normalized_gc["maxOutputTokens"] = max_tokens
            if response_mime:
                normalized_gc["responseMimeType"] = response_mime
            if schema:
                normalized_gc["responseSchema"] = schema
            if thinking:
                level = thinking.get("thinkingLevel") or thinking.get("thinking_level")
                budget = thinking.get("thinkingBudget") or thinking.get("thinking_budget")
                normalized_thinking = {}
                if level:
                    normalized_thinking["thinkingLevel"] = level
                if budget is not None:
                    normalized_thinking["thinkingBudget"] = budget
                if normalized_thinking:
                    normalized_gc["thinkingConfig"] = normalized_thinking
            payload["generationConfig"] = normalized_gc
            if "generation_config" in payload:
                del payload["generation_config"]
    
    try:
        session = await _get_session()
        async with session.post(
            f"{GEMINI_API_URL}?key={current_key}",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            if resp.status == 200:
                return await resp.json(), True
            
            # Handle specific error codes with better logging
            body = await resp.text()
            error_data = {}
            try:
                error_data = json.loads(body)
            except:
                pass

            if resp.status in (429, 503):
                if retry_count < max_retries:
                    wait_time = (2 ** retry_count) * 2
                    logger.warning(f"Gemini API {resp.status} (key #{attempt+1}), retrying in {wait_time}s... Error: {body[:200]}")
                    await asyncio.sleep(wait_time)
                    return await _gemini_request(payload, timeout, attempt, retry_count + 1, keys, max_retries)
                
                logger.warning(f"Gemini API {resp.status} exhausted for key #{attempt+1}, trying next key")
                return await _gemini_request(payload, timeout, attempt + 1, 0, keys, max_retries)
            
            else:
                logger.error(f"Gemini API Critical Error {resp.status} (key #{attempt+1}): {body[:500]}")
                # Fallback to next key on any failure
                return await _gemini_request(payload, timeout, attempt + 1, 0, keys, max_retries)

    except asyncio.TimeoutError:
        if retry_count < 1:
             return await _gemini_request(payload, timeout, attempt, retry_count + 1, keys, max_retries)
        logger.warning(f"Gemini API timeout with key #{attempt+1}, trying next key")
        return await _gemini_request(payload, timeout, attempt + 1, 0, keys, max_retries)
    except Exception as e:
        logger.error(f"Gemini client-side exception with key #{attempt+1}: {str(e)}")
        # Try next key if possible
        return await _gemini_request(payload, timeout, attempt + 1, 0, keys, max_retries)


async def analyze_audio_gold_detection(
    audio_base64: Optional[str] = None,
    audio_url: Optional[str] = None,
    mime_type: str = "audio/wav"
) -> dict:
    """
    Gemini audio analysis: is this solid gold or plated?
    Returns: {
        "is_solid_gold": bool,
        "confidence": 0.0–1.0,
        "acoustic_signature": str,
        "reason": str
    }
    """
    if not GEMINI_AUDIO_VIDEO_API_KEYS:
        logger.warning("GEMINI_AUDIO_VIDEO_API_KEY not set; audio analysis skipped")
        return {
            "is_solid_gold": None,
            "confidence": 0.0,
            "acoustic_signature": "unknown",
            "reason": "gemini_audio_video_api_key_missing"
        }

    if not audio_base64 and not audio_url:
        return {
            "is_solid_gold": None,
            "confidence": 0.0,
            "acoustic_signature": "no_input",
            "reason": "no_audio_provided"
        }

    prompt = """You are an expert in acoustic properties of precious metals.
Analyze this audio recording of a gold item being tapped or struck.

Determine:
1. Is this solid gold or plated gold?
2. Confidence level (0.0–1.0)
3. Acoustic signature (e.g., "clear_ring_tone", "dull_thud", "metallic_resonance")
4. Brief explanation

Solid gold characteristics:
- Clear, sustained ring tone (2–5 second decay)
- Fundamental frequency 600–1200 Hz
- Rich harmonic content
- No sudden dampening

Plated gold characteristics:
- Duller, shorter ring (< 1 second decay)
- Hollow or muted quality
- Fewer harmonics
- Quick attenuation

Return ONLY valid JSON:
{
  "is_solid_gold": boolean,
  "confidence": 0.0 to 1.0,
  "acoustic_signature": "string",
  "reason": "brief explanation"
}"""

    try:
        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        },
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": audio_base64
                            }
                        } if audio_base64 else {
                            "fileData": {
                                "mimeType": mime_type,
                                "fileUri": audio_url
                            }
                        }
                    ]
                }
            ]
        }

        data, success = await _gemini_request(payload, timeout=60, api_keys=GEMINI_AUDIO_VIDEO_API_KEYS)

        if not success:
            logger.error(f"Gemini audio API failed after all retries")
            return {
                "is_solid_gold": None,
                "confidence": 0.0,
                "acoustic_signature": "api_error",
                "reason": data.get("error", "gemini_api_failed")
            }

        if "candidates" not in data or not data["candidates"]:
            return {
                "is_solid_gold": None,
                "confidence": 0.0,
                "acoustic_signature": "no_response",
                "reason": "empty_gemini_response"
            }

        text_response = extract_gemini_text(data)
        result = parse_json_response(text_response)
        return result

    except asyncio.TimeoutError:
        logger.warning("Gemini audio API timeout")
        return {
            "is_solid_gold": None,
            "confidence": 0.0,
            "acoustic_signature": "timeout",
            "reason": "gemini_timeout"
        }
    except Exception as e:
        logger.exception(f"Gemini audio analysis error: {e}")
        return {
            "is_solid_gold": None,
            "confidence": 0.0,
            "acoustic_signature": "error",
            "reason": str(e)
        }


async def analyze_image_fallback(
    image_base64: Optional[str] = None,
    image_url: Optional[str] = None,
    analysis_type: str = "purity"  # "purity", "plated_solid", "authenticity", "weight"
) -> dict:
    """
    Groq-primary image analysis fallback when ML models unavailable.
    Returns structured result matching signal worker format.
    """
    prompts = {
        "purity": """Analyze this gold jewelry image for purity/karat.
Look for:
- Color saturation (deeper yellow = higher karat)
- Hallmark stamps visible
- Surface patina/aging indicators
- Comparison to reference colors

Return JSON:
{
  "estimated_karat": int (8–24),
  "confidence": 0.0–1.0,
  "hallmark_visible": boolean,
  "color_analysis": "string",
  "reason": "string"
}""",

        "plated_solid": """Analyze this gold jewelry to determine if solid or plated.
Look for:
- Edge wear revealing base metal
- Thickness indicators
- Surface uniformity
- Weight relative to size estimate

Return JSON:
{
  "is_solid": boolean,
  "confidence": 0.0–1.0,
  "wear_indicators": "string",
  "reason": "string"
}""",

        "authenticity": """Assess the authenticity of this gold jewelry.
Red flags for counterfeits:
- Hallmark inconsistencies
- Unusual color/patina for stated karat
- Manufacturing defects
- Weight/dimension mismatch

Return JSON:
{
  "is_authentic": boolean,
  "confidence": 0.0–1.0,
  "red_flags": [list of strings],
  "reason": "string"
}""",

        "weight": """Estimate the weight of this gold jewelry.
Based on:
- Visual size/thickness
- Density assumptions
- Item type (ring, pendant, bracelet, etc.)

Return JSON:
{
  "estimated_weight_g": float,
  "confidence": 0.0–1.0,
  "item_type": "string",
  "size_estimate": "string",
  "reason": "string"
}"""
    }

    prompt = prompts.get(analysis_type, prompts["purity"])

    if GROQ_PRIMARY_API_KEYS and image_base64:
        try:
            from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys

            data, success = await call_groq_vision_with_keys(
                prompt,
                image_base64,
                GROQ_PRIMARY_API_KEYS,
                "image/jpeg",
                timeout=45,
            )
            if success:
                text_response = extract_gemini_text(data)
                result = parse_json_response(text_response)
                result["groq_analyzed"] = True
                result["provider"] = "groq"
                result["model"] = GROQ_MODEL
                return result
            logger.warning(f"Groq {analysis_type} fallback failed: {data.get('error', 'unknown')}")
        except Exception as e:
            logger.warning(f"Groq {analysis_type} fallback error: {e}")

    if not GEMINI_GUIDANCE_FALLBACK_API_KEYS and not GROQ_PRIMARY_API_KEYS:
        logger.warning("Groq primary keys and Gemini guidance/fallback key unavailable; image fallback skipped")
        return {"error": "llm_image_provider_missing", "confidence": 0.0}

    try:
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": image_base64
                            }
                        } if image_base64 else {
                            "fileData": {
                                "mimeType": "image/jpeg",
                                "fileUri": image_url
                            }
                        }
                    ]
                }
            ]
        }

        data, success = await _gemini_request(payload, timeout=60, api_keys=GEMINI_GUIDANCE_FALLBACK_API_KEYS)

        if not success:
            logger.error(f"Gemini {analysis_type} API failed after all retries")
            return {"error": data.get("error", "gemini_api_failed"), "confidence": 0.0}

        if "candidates" not in data or not data["candidates"]:
            return {"error": "empty_response", "confidence": 0.0}

        text_response = extract_gemini_text(data)
        result = parse_json_response(text_response)
        result["gemini_analyzed"] = True
        result["provider"] = "gemini"
        return result

    except asyncio.TimeoutError:
        logger.warning(f"Gemini {analysis_type} API timeout")
        return {"error": "gemini_timeout", "confidence": 0.0}
    except Exception as e:
        logger.exception(f"Gemini {analysis_type} error: {e}")
        return {"error": str(e), "confidence": 0.0}


async def analyze_complex_decision(
    context: dict,
    question: str
) -> dict:
    """
    Use Groq first for complex decision-making when ML signals are unclear.
    E.g., "Should we RECAPTURE or REJECT given these conflicting signals?"
    """
    prompt = f"""You are an expert gold assessment system.
Given this assessment context and question, provide a structured decision.

Context:
{json.dumps(context, indent=2)}

Question: {question}

Respond with JSON:
{{
  "recommendation": "INSTANT|AGENT|RECAPTURE|REJECT",
  "confidence": 0.0–1.0,
  "reasoning": "brief explanation",
  "risk_level": "low|medium|high"
}}"""

    if GROQ_PRIMARY_API_KEYS:
        try:
            from app.data.groq_client import GROQ_TEXT_MODEL, call_groq_json_with_keys

            data, success = await call_groq_json_with_keys(prompt, GROQ_PRIMARY_API_KEYS, timeout=30)
            if success:
                text_response = extract_gemini_text(data)
                result = parse_json_response(text_response)
                result["provider"] = "groq"
                result["model"] = GROQ_TEXT_MODEL
                return result
            logger.warning(f"Groq decision failed: {data.get('error', 'unknown')}")
        except Exception as e:
            logger.warning(f"Groq decision error: {e}")

    if not GEMINI_GUIDANCE_FALLBACK_API_KEYS:
        return {"decision": None, "reasoning": "llm_decision_provider_missing"}

    try:
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt}
                    ]
                }
            ]
        }

        data, success = await _gemini_request(payload, timeout=30, api_keys=GEMINI_GUIDANCE_FALLBACK_API_KEYS)
        if not success:
            return {"decision": None, "error": data.get("error", "api_failed")}

        text_response = extract_gemini_text(data)
        result = parse_json_response(text_response)
        result["provider"] = "gemini"
        return result

    except Exception as e:
        logger.exception(f"Gemini decision error: {e}")
        return {"decision": None, "error": str(e)}

async def analyze_multimodal_fusion(
    signals: dict,
    images_urls: list[str],
    audio_url: Optional[str] = None
) -> dict:
    """
    A final high-level review using Groq/Gemini to cross-reference ALL signals.
    Identifies red flags (e.g. Color says 22K, but Audio says Plated).
    """
    import os
    import json
    import aiohttp
    groq_key = os.getenv("GROQ_API_KEY", "")
    if not groq_key:
        return {}

    prompt = f"""You are a Lead Gold Appraiser. Review these automated signals and find inconsistencies.
{json.dumps(signals, indent=2)}

Look for RED FLAGS:
1. Visual color (s3_color) says 22K but Audio (s11_audio) says Plated.
2. Hallmark (s2_ocr) is blurry but Weight (s6_weight) is too high for the size.
3. HUID (s1_huid) verified but Specular (s4_specular) shows non-metallic reflection.

Respond with JSON:
{{
  "final_purity_estimate": int,
  "risk_score": 0.0-1.0,
  "expert_commentary": "Detailed reasoning explaining any inconsistencies.",
  "verdict": "APPROVE|REJECT|MANUAL_REVIEW"
}}"""

    payload = {
        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                ] + [
                    {"type": "image_url", "image_url": {"url": url}}
                    for url in images_urls[:2] if url and not url.startswith('local://')
                ]
            }
        ],
        "response_format": {"type": "json_object"}
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {groq_key}"},
                timeout=15
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return json.loads(data["choices"][0]["message"]["content"])
    except Exception as e:
        logger.debug(f"Fusion review failed: {e}")
    return {}



def _build_frame_prompts(gold_price_24k: float = 0.0, language: str = "en") -> dict:
    """Build per-step evaluation prompts, optionally embedding the live gold price."""
    price_line = ""
    if gold_price_24k > 0:
        price_line = f"\nCurrent live gold price (IBJA): ₹{gold_price_24k:,.0f}/g for 24K gold.\n"

    lang_instruction = (
        "\nIMPORTANT: Write the 'feedback' field in Hindi (Devanagari script). All other fields remain as defined.\n"
        if language == "hi" else ""
    )

    return {
        "top": f"""{lang_instruction}You are a strict gold loan assessment agent evaluating a photo for a gold appraisal service.
CRITICAL VALIDATION: This image MUST contain ACTUAL PHYSICAL GOLD JEWELRY. Reject immediately if it does not.

REJECT THESE IMMEDIATELY (approved=false):
- Laptops, phones, computers, screens, electronics
- Photos, images, screenshots, pictures on screens
- Books, papers, documents
- Furniture, household items
- Plants, nature, landscapes
- People, faces, portraits
- ANY non-physical-gold items

ACCEPT ONLY IF the image shows ACTUAL GOLD JEWELRY like:
- Gold rings, bangles, bracelets, chains, pendants, earrings, necklaces
- Must be PHYSICAL GOLD items, not pictures/photos of gold

This should be a TOP-DOWN (overhead) shot of gold jewelry placed flat on a surface.
A ₹10 rupee coin may or may not be present — it is OPTIONAL and its absence must NOT cause rejection.

STEP 1: GOLD DETECTION (MANDATORY)
- Is this a PHYSICAL GOLD JEWELRY item? (Not a picture, not a laptop, not electronics)
- Gold is typically yellow/orange metallic, often shiny
- If this is a PHOTO/SCREENSHOT/IMAGE ON SCREEN → REJECT with approved=false immediately
- If this is a LAPTOP/PHONE/COMPUTER → REJECT with approved=false immediately
- If NO ACTUAL PHYSICAL gold jewelry is visible → REJECT with approved=false immediately

STEP 2: QUALITY SCORING (if gold is present)
  +0.30  jewelry clearly visible and recognisable
  +0.20  image in sharp focus (not blurry)
  +0.20  good lighting (not too dark, not overexposed / washed out)
  +0.15  top-down / overhead angle (not a steep side-angle)
  +0.10  ₹10 coin present (optional scale reference — adds confidence)
  +0.05  full piece fits inside the frame
  Deduct 0.25 if jewelry is barely or not visible at all.

approved = true if quality_score >= 0.55 AND jewelry is clearly visible.
Reject (approved=false) if: NO GOLD DETECTED, jewelry cannot be assessed (blurry, too dark), or jewelry is barely visible.

Return ONLY valid JSON (no markdown fences):
{{
  "approved": boolean,
  "quality_score": 0.0-1.0,
  "feedback": "One direct sentence. If approved, compliment and note any hallmarks/item type seen. If rejected, explain exactly why (not gold jewelry, too blurry, not visible, etc.)",
  "issues": ["list real blocking issues"],
  "detected": {{
    "gold_jewelry_present": boolean,
    "jewelry_visible": boolean,
    "coin_visible": boolean,
    "in_focus": boolean,
    "good_lighting": boolean,
    "top_down_angle": boolean,
    "item_type": "ring|bangle|chain|pendant|earring|bracelet|other|unknown|none"
  }}
}}""",

        "45deg": f"""{lang_instruction}You are a strict gold loan assessment agent evaluating a 45-DEGREE ANGLE photo of gold jewelry.
CRITICAL: This image MUST contain gold jewelry. Reject if it does not.
The goal: verify depth and thickness of the piece are clearly visible.

STEP 1: GOLD DETECTION (MANDATORY)
- Does the image show recognizable gold jewelry (ring, bangle, chain, pendant, bracelet, earring)?
- If NO gold is visible → REJECT immediately with approved=false

STEP 2: QUALITY SCORING (if gold present)
  +0.30  jewelry clearly visible
  +0.25  angled view (not flat top-down, not purely side-on) showing 3D form
  +0.20  depth or thickness visible
  +0.15  in focus
  +0.10  good lighting
  Deduct 0.30 if jewelry is not visible; 0.15 if angle is wrong.

approved = true if quality_score >= 0.55 AND gold jewelry clearly visible.

Return ONLY valid JSON:
{{
  "approved": boolean,
  "quality_score": 0.0-1.0,
  "feedback": "One direct sentence. If rejected, explain why (not gold jewelry, wrong angle, not visible, etc.)",
  "issues": [],
  "detected": {{
    "gold_jewelry_present": boolean,
    "jewelry_visible": boolean,
    "angle_correct": boolean,
    "depth_visible": boolean,
    "in_focus": boolean,
    "good_lighting": boolean
  }}
}}""",

        "side": f"""{lang_instruction}You are a strict gold loan assessment agent evaluating a SIDE/PROFILE view of gold jewelry.
CRITICAL: This image MUST contain gold jewelry. Reject if it does not.
Goal: clearly show thickness and cross-section of the piece.

STEP 1: GOLD DETECTION (MANDATORY)
- Does the image show recognizable gold jewelry in side profile?
- If NO gold jewelry visible → REJECT immediately with approved=false

STEP 2: QUALITY SCORING (if gold present)
  +0.30  jewelry visible
  +0.30  side profile view (not top-down, not angled)
  +0.20  thickness/cross-section clearly visible
  +0.15  in focus
  +0.05  good lighting
  Deduct 0.30 if jewelry not visible; 0.20 if angle is wrong.

approved = true if quality_score >= 0.55 AND gold jewelry visible.

Return ONLY valid JSON:
{{
  "approved": boolean,
  "quality_score": 0.0-1.0,
  "feedback": "One direct sentence. If rejected, explain why (not gold jewelry, wrong angle, not visible, etc.)",
  "issues": [],
  "detected": {{
    "gold_jewelry_present": boolean,
    "jewelry_visible": boolean,
    "side_profile_visible": boolean,
    "thickness_visible": boolean,
    "in_focus": boolean
  }}
}}""",

        "macro": f"""{lang_instruction}You are a strict expert gold hallmark examiner evaluating a MACRO/CLOSE-UP photo.
CRITICAL: This image MUST show gold jewelry with a visible hallmark/marking area. Reject if not gold.
Goal: identify BIS hallmark, karat purity markings, HUID code, or maker's marks.
{price_line}
STEP 1: GOLD DETECTION (MANDATORY)
- Is this clearly a gold jewelry item (yellow/orange metallic)?
- Is there a visible hallmark/marking area (the flat surface where stamps would appear)?
- If NO gold jewelry or NO marking area visible → REJECT immediately with approved=false

Hallmark knowledge:
- BIS logo looks like a triangular mark with "BIS" text
- Karat: "24K", "22K", "18K", "14K", "9K" or equivalent fineness "999", "958", "916", "750", "585", "375"
- HUID is a 6-character alphanumeric code (e.g. "AB1234")
- Maker's mark: brand or manufacturer initials

STEP 2: QUALITY SCORING (if gold and marking area present)
  +0.25  any hallmark or marking visible
  +0.25  marking is sharp and in focus
  +0.20  BIS logo clearly visible
  +0.15  karat or fineness number readable
  +0.10  good lighting (no glare, no shadow on stamp)
  +0.05  HUID code visible
  Deduct 0.30 if image is so blurry nothing can be read.

approved = true if quality_score >= 0.45 (even partial visibility of a marking counts).
{"Estimated price per gram at detected karat: use price_line above multiplied by (karat/24)." if gold_price_24k > 0 else ""}

Return ONLY valid JSON:
{{
  "approved": boolean,
  "quality_score": 0.0-1.0,
  "feedback": "One sentence: state exactly what hallmark was found (e.g. '22K BIS hallmark detected — estimated ₹X,XXX/g at current rate') or what to fix.",
  "issues": [],
  "detected": {{
    "gold_jewelry_present": boolean,
    "hallmark_visible": boolean,
    "karat_marking": "22K" or "18K" or "916" etc or null,
    "karat_numeric": number or null,
    "bis_logo": boolean,
    "huid_code": "string or null",
    "in_focus": boolean,
    "readable": boolean,
    "estimated_price_per_g": number or null
  }}
}}""",

        "selfie": f"""{lang_instruction}You are a strict gold loan assessment agent evaluating a SELFIE photo for identity + anti-fraud.
CRITICAL: This image MUST show BOTH a person's face AND visible gold jewelry. Reject if either is missing.
The selfie must show a person holding or wearing gold jewelry assessed in previous steps.

STEP 1: VALIDATION (MANDATORY)
- Is there a clear human face visible in the photo?
- Is there recognizable gold jewelry visible in the same frame (being held or worn)?
- If NO face OR NO gold jewelry visible → REJECT immediately with approved=false

STEP 2: QUALITY SCORING (if both face and jewelry present)
  +0.35  human face clearly visible and in focus
  +0.25  gold jewelry visible in the same frame
  +0.20  face well-lit (not in shadow, not overexposed)
  +0.10  photo appears live (not a photo-of-a-photo, no screen glare)
  +0.10  jewelry and face both sharp
  Deduct 0.35 if no face visible; 0.20 if no jewelry visible.

approved = true if quality_score >= 0.55 AND face visible AND jewelry visible.

Return ONLY valid JSON:
{{
  "approved": boolean,
  "quality_score": 0.0-1.0,
  "feedback": "One direct sentence. If rejected, explain why (no face, no jewelry, not gold, etc.)",
  "issues": [],
  "detected": {{
    "face_visible": boolean,
    "gold_jewelry_visible": boolean,
    "in_focus": boolean,
    "good_lighting": boolean,
    "appears_live": boolean
  }}
}}""",

        "video": """{
  "approved": true,
  "quality_score": 0.8,
  "feedback": "Video received — motion analysis will run during full assessment.",
  "issues": [],
  "detected": {"jewelry_visible": true}
}""",

        "audio": """{
  "approved": true,
  "quality_score": 0.8,
  "feedback": "Audio received — acoustic resonance analysis will run during full assessment.",
  "issues": [],
  "detected": {}
}""",
    }


# Static default (no price context); overridden at request time when price is available
_FRAME_PROMPTS = _build_frame_prompts(gold_price_24k=0.0)


async def evaluate_frame(image_base64: str, frame_type: str, language: str = "en") -> dict:
    """
    Capture validation routing:
      - image frames (top/45deg/side/macro/selfie/bill): Groq PRIMARY → Gemini STRICT fallback
      - video/audio frames: Gemini PRIMARY → Groq STRICT fallback
    No IBJA call — gold price context not needed for image quality checks.
    """
    # ── Video / audio: Gemini primary, Groq strict fallback ──────────────────
    if frame_type in ("video", "audio"):
        if GEMINI_AUDIO_VIDEO_API_KEYS:
            result = await _evaluate_frame_gemini(
                image_base64,
                frame_type,
                GEMINI_AUDIO_VIDEO_API_KEYS,
                "gemini_audio_video",
            )
            if result.get("provider") != "error":
                return result
            logger.warning(f"Gemini audio/video eval failed [{frame_type}], trying Groq fallback")

        # Groq strict fallback for video/audio
        if GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS:
            try:
                from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys
                prompts = _build_frame_prompts(gold_price_24k=0, language=language)
                prompt = prompts.get(frame_type, prompts["top"])
                data, success = await call_groq_vision_with_keys(
                    prompt, image_base64, GROQ_AUDIO_VIDEO_FALLBACK_API_KEYS, "image/jpeg", timeout=45,
                )
                if success:
                    text = extract_gemini_text(data)
                    result = parse_json_response(text)
                    result.setdefault("approved", True)
                    result.setdefault("quality_score", 0.7)
                    result.setdefault("feedback", "Evaluated")
                    result.setdefault("issues", [])
                    result.setdefault("detected", {})
                    result["provider"] = "groq_fallback"
                    return result
            except Exception as e:
                logger.warning(f"Groq fallback for audio/video failed [{frame_type}]: {e}")

        return {"approved": True, "quality_score": 0.5, "feedback": "Captured", "issues": [], "detected": {}, "provider": "passthrough"}

    # ── Image frames: Groq PRIMARY → Gemini STRICT fallback ──────────────────
    prompts = _build_frame_prompts(gold_price_24k=0, language=language)
    prompt = prompts.get(frame_type, prompts["top"])

    if GROQ_PRIMARY_API_KEYS:
        try:
            from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys
            data, success = await call_groq_vision_with_keys(
                prompt, image_base64, GROQ_PRIMARY_API_KEYS, "image/jpeg", timeout=45,
            )
            if success:
                text = extract_gemini_text(data)
                result = parse_json_response(text)
                result.setdefault("approved", True)
                result.setdefault("quality_score", 0.7)
                result.setdefault("feedback", "Image evaluated")
                result.setdefault("issues", [])
                result.setdefault("detected", {})
                result["quality_score"] = max(0.0, min(1.0, float(result["quality_score"])))
                result["provider"] = "groq"
                result["model"] = GROQ_MODEL
                logger.info(f"Groq frame eval [{frame_type}]: approved={result['approved']}, score={result['quality_score']}")
                return result
            logger.warning(f"Groq frame eval failed [{frame_type}], falling back to Gemini")
        except Exception as e:
            logger.warning(f"Groq frame eval error [{frame_type}]: {e}, falling back to Gemini")

    # Gemini strict fallback for image frames
    return await _evaluate_frame_gemini(
        image_base64,
        frame_type,
        GEMINI_GUIDANCE_FALLBACK_API_KEYS,
        "gemini_strict_fallback",
    )


async def evaluate_live_guidance_frame(image_base64: str, frame_type: str) -> dict:
    """Live guidance: Groq primary, Gemini fallback."""
    if GROQ_GUIDANCE_API_KEYS:
        try:
            from app.data.groq_client import GROQ_MODEL, call_groq_vision_with_keys

            try:
                from app.decision.ibja import current_price_24k
                live_price = current_price_24k()
            except Exception:
                live_price = 0.0

            prompts = _build_frame_prompts(gold_price_24k=live_price)
            prompt = prompts.get(frame_type, prompts["top"])
            data, success = await call_groq_vision_with_keys(
                prompt,
                image_base64,
                GROQ_GUIDANCE_API_KEYS,
                "image/jpeg",
                timeout=45,
            )
            if success:
                text = extract_gemini_text(data)
                groq_result = parse_json_response(text)
                groq_result.setdefault("approved", True)
                groq_result.setdefault("quality_score", 0.7)
                groq_result.setdefault("feedback", "Image evaluated")
                groq_result.setdefault("issues", [])
                groq_result.setdefault("detected", {})
                groq_result["quality_score"] = max(0.0, min(1.0, float(groq_result["quality_score"])))
                groq_result["provider"] = "groq_guidance"
                groq_result["model"] = GROQ_MODEL
                return groq_result
            logger.warning(f"Groq guidance failed [{frame_type}]: {data.get('error', 'unknown')}")
        except Exception as e:
            logger.warning(f"Groq guidance error [{frame_type}]: {e}")

    if GEMINI_GUIDANCE_FALLBACK_API_KEYS:
        return await _evaluate_frame_gemini(
            image_base64,
            frame_type,
            GEMINI_GUIDANCE_FALLBACK_API_KEYS,
            "gemini_guidance_fallback",
            max_retries=0,
        )

    return {
        "approved": True,
        "quality_score": 0.7,
        "feedback": "Image captured (offline mode - configure GROQ_GUIDANCE_API_KEY)",
        "issues": [],
        "detected": {},
    }


async def _evaluate_frame_gemini(
    image_base64: str,
    frame_type: str,
    api_keys: list[str],
    provider_name: str,
    max_retries: int = 3,
) -> dict:
    """
    Gemini evaluates a captured frame for quality and correctness.
    Returns approval status + actionable feedback to show the user.
    Injects live IBJA gold price into the macro prompt for price estimation.
    """
    import re

    # video/audio: return static approved response without calling Gemini
    if frame_type in ("video", "audio"):
        static = _FRAME_PROMPTS.get(frame_type, "{}")
        try:
            return json.loads(static)
        except Exception:
            return {"approved": True, "quality_score": 0.8, "feedback": "Received", "issues": [], "detected": {}}

    if not api_keys:
        return {
            "approved": True,
            "quality_score": 0.7,
            "feedback": "Image captured (offline mode - set GEMINI_GUIDANCE_FALLBACK_API_KEY for live evaluation)",
            "issues": [],
            "detected": {},
        }

    # Build price-injected prompts for this request
    try:
        from app.decision.ibja import current_price_24k
        live_price = current_price_24k()
    except Exception:
        live_price = 0.0

    prompts = _build_frame_prompts(gold_price_24k=live_price)
    prompt = prompts.get(frame_type, prompts["top"])

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": image_base64}},
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
        },
    }

    try:
        data, success = await _gemini_request(
            payload,
            timeout=45,
            api_keys=api_keys,
            max_retries=max_retries,
        )

        if not success:
            err = data.get("error", "unknown")
            logger.error(f"Gemini {provider_name} failed after all retries: {err}")
            # FALLBACK POLICY: If AI is busy/rate-limited or offline, don't mislead the user about blurriness
            feedback = "Image is blurry. Please try again."
            issues = ["blurry_image"]
            if err == "all_keys_failed":
                feedback = "Evaluation service is temporarily busy. Please try again in a few moments."
                issues = ["service_busy"]

            return {
                "approved": False,
                "quality_score": 0.0,
                "feedback": feedback,
                "issues": issues,
                "detected": {"gold_jewelry_present": None}
            }

        if "candidates" not in data or not data["candidates"]:
            logger.error(f"Gemini returned no candidates: {json.dumps(data)[:300]}")
            return {"approved": False, "quality_score": 0.0, "feedback": "Could not evaluate image — please retake", "issues": ["no_response"], "detected": {"gold_jewelry_present": None}}

        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        logger.info(f"Gemini {provider_name} raw response [{frame_type}]: {text[:200]}")

        # Strip markdown fences if present
        if text.startswith("```json"):
            text = text[7:]
        if text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        # Try direct parse first
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            # Fallback: extract first JSON object with regex
            match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
            if match:
                result = json.loads(match.group())
            else:
                logger.error(f"Could not parse Gemini response as JSON: {text[:200]}")
                return {"approved": False, "quality_score": 0.0, "feedback": "Response parsing failed — please retake image", "issues": ["parse_error"], "detected": {"gold_jewelry_present": None}}

        # Ensure all required fields exist
        result.setdefault("approved", True)
        result.setdefault("quality_score", 0.7)
        result.setdefault("feedback", "Image evaluated")
        result.setdefault("issues", [])
        result.setdefault("detected", {})

        # Clamp quality_score to [0.0, 1.0]
        result["quality_score"] = max(0.0, min(1.0, float(result["quality_score"])))

        # For macro: compute estimated price per gram if karat detected and price available
        if frame_type == "macro" and live_price > 0:
            detected = result.get("detected", {})
            karat_num = detected.get("karat_numeric")
            if karat_num is None:
                # Try parsing from karat_marking string
                km = detected.get("karat_marking") or ""
                import re as _re
                m = _re.search(r"(\d{1,2})[Kk]", km)
                if m:
                    karat_num = int(m.group(1))
                else:
                    # fineness like "916" → 22K, "750" → 18K
                    m2 = _re.search(r"(\d{3})", km)
                    if m2:
                        fineness = int(m2.group(1))
                        karat_num = round(fineness * 24 / 1000)

            if karat_num and 8 <= karat_num <= 24:
                price_per_g = round(live_price * karat_num / 24, 0)
                detected["estimated_price_per_g"] = price_per_g
                detected["karat_numeric"] = karat_num
                # Enrich feedback with price if hallmark was found
                if detected.get("hallmark_visible") and "₹" not in result["feedback"]:
                    result["feedback"] += f" Estimated ₹{int(price_per_g):,}/g at current IBJA rate."

        result["provider"] = provider_name
        result["model"] = GEMINI_MODEL

        logger.info(f"Frame eval [{frame_type}]: approved={result['approved']}, score={result['quality_score']}")
        return result

    except asyncio.TimeoutError:
        logger.warning("Gemini evaluate_frame timeout")
        return {"approved": False, "quality_score": 0.0, "feedback": "Evaluation timed out — please retake image", "issues": ["timeout"], "detected": {"gold_jewelry_present": None}}
    except Exception as e:
        logger.exception(f"Gemini evaluate_frame error: {e}")
        return {"approved": False, "quality_score": 0.0, "feedback": "Evaluation failed — please retake image", "issues": ["error"], "detected": {"gold_jewelry_present": None}}
