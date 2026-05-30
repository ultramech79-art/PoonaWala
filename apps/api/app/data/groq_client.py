import logging
import asyncio
import aiohttp
from typing import Tuple

logger = logging.getLogger("goldeye.groq")

# Groq API Configuration
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
# Using Llama 4 Scout (17B Active/109B Total MoE) for state-of-the-art vision assessment
GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
GROQ_TEXT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

async def call_groq_vision(
    text_prompt: str,
    image_base64: str,
    api_key: str,
    mime_type: str = "image/jpeg",
    timeout: int = 45,
    retry_count: int = 0
) -> Tuple[dict, bool]:
    """
    Directly calls Groq's Vision API using OpenAI-compatible format.
    Returns (response_json, success_boolean).
    """
    payload = {
        "model": GROQ_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": text_prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{image_base64}"}
                }
            ]
        }],
        "temperature": 0.1,
        "response_format": {"type": "json_object"}
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                GROQ_API_URL,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 200:
                    res_json = await resp.json()
                    # Extract the JSON string from the assistant message
                    content_text = res_json["choices"][0]["message"]["content"]
                    
                    # Convert to Gemini-like format for seamless integration with existing evaluators
                    mock_gemini_resp = {
                        "candidates": [{
                            "content": {
                                "parts": [{"text": content_text}]
                            }
                        }]
                    }
                    return mock_gemini_resp, True
                
                elif resp.status == 429:
                    body = await resp.text()
                    logger.warning(f"Groq API rate limited, trying next key if available: {body[:180]}")
                    return {"error": "groq_rate_limited", "details": body[:200]}, False

                elif resp.status == 503 and retry_count < 1:
                    # Exponential backoff retry for transient errors
                    wait_time = 1.5 * (retry_count + 1)
                    logger.warning(f"Groq API {resp.status}, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    return await call_groq_vision(text_prompt, image_base64, api_key, mime_type, timeout, retry_count + 1)
                
                else:
                    body = await resp.text()
                    logger.error(f"Groq API error {resp.status}: {body[:300]}")
                    return {"error": f"groq_http_{resp.status}", "details": body[:200]}, False

    except asyncio.TimeoutError:
        logger.error("Groq API request timed out")
        return {"error": "groq_timeout"}, False
    except Exception as e:
        logger.error(f"Groq request exception: {e}")
        return {"error": str(e)}, False


async def call_groq_vision_with_keys(
    text_prompt: str,
    image_base64: str,
    api_keys: list[str],
    mime_type: str = "image/jpeg",
    timeout: int = 45,
) -> Tuple[dict, bool]:
    last: dict = {"error": "groq_key_missing"}
    for idx, key in enumerate([k for k in api_keys if k]):
        data, success = await call_groq_vision(text_prompt, image_base64, key, mime_type, timeout)
        if success:
            if idx:
                logger.info(f"Groq vision fallback succeeded with key #{idx + 1}")
            return data, True
        last = data
    return last, False


async def call_groq_json(
    text_prompt: str,
    api_key: str,
    timeout: int = 45,
    retry_count: int = 0,
) -> Tuple[dict, bool]:
    """
    Calls Groq's OpenAI-compatible chat API for JSON-only text reasoning.
    Used for audio fallback over measured FFT/acoustic metrics, not raw audio.
    """
    payload = {
        "model": GROQ_TEXT_MODEL,
        "messages": [{"role": "user", "content": text_prompt}],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                GROQ_API_URL,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 200:
                    res_json = await resp.json()
                    content_text = res_json["choices"][0]["message"]["content"]
                    return {
                        "candidates": [{
                            "content": {"parts": [{"text": content_text}]}
                        }]
                    }, True

                if resp.status == 429:
                    body = await resp.text()
                    logger.warning(f"Groq text API rate limited, trying next key if available: {body[:180]}")
                    return {"error": "groq_rate_limited", "details": body[:200]}, False

                if resp.status == 503 and retry_count < 1:
                    wait_time = 1.5 * (retry_count + 1)
                    logger.warning(f"Groq text API {resp.status}, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    return await call_groq_json(text_prompt, api_key, timeout, retry_count + 1)

                body = await resp.text()
                logger.error(f"Groq text API error {resp.status}: {body[:300]}")
                return {"error": f"groq_http_{resp.status}", "details": body[:200]}, False

    except asyncio.TimeoutError:
        logger.error("Groq text API request timed out")
        return {"error": "groq_timeout"}, False
    except Exception as e:
        logger.error(f"Groq text request exception: {e}")
        return {"error": str(e)}, False


async def call_groq_json_with_keys(
    text_prompt: str,
    api_keys: list[str],
    timeout: int = 45,
) -> Tuple[dict, bool]:
    last: dict = {"error": "groq_key_missing"}
    for idx, key in enumerate([k for k in api_keys if k]):
        data, success = await call_groq_json(text_prompt, key, timeout)
        if success:
            if idx:
                logger.info(f"Groq text fallback succeeded with key #{idx + 1}")
            return data, True
        last = data
    return last, False
