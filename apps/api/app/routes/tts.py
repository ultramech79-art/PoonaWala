"""
POST /api/tts
Proxy to Sarvam AI text-to-speech — keeps the API key server-side.
"""
import os
import logging
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

SARVAM_URL = "https://api.sarvam.ai/text-to-speech"
SARVAM_KEY = os.getenv("SARVAM_API_KEY", "")


class TTSRequest(BaseModel):
    text: str
    speaker: str = "vidya"
    pace: float = 0.85
    pitch: float = 0.0
    loudness: float = 2.2
    language_code: str = "hi-IN"


@router.post("/api/tts")
async def tts_proxy(req: TTSRequest):
    if not SARVAM_KEY:
        raise HTTPException(status_code=503, detail="TTS service not configured")

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    payload = {
        "inputs": [req.text],
        "target_language_code": req.language_code,
        "speaker": req.speaker,
        "pitch": req.pitch,
        "pace": req.pace,
        "loudness": req.loudness,
        "speech_sample_rate": 22050,
        "enable_preprocessing": True,
        "model": "bulbul:v2",
    }

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            res = await client.post(
                SARVAM_URL,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "api-subscription-key": SARVAM_KEY,
                },
            )
        except httpx.RequestError as e:
            logger.error("Sarvam TTS request failed: %s", e)
            raise HTTPException(status_code=502, detail="TTS upstream unreachable")

    if not res.is_success:
        logger.error("Sarvam TTS error %s: %s", res.status_code, res.text)
        raise HTTPException(status_code=502, detail=f"TTS upstream error {res.status_code}")

    data = res.json()
    audio_b64 = data.get("audios", [None])[0] or data.get("audio")
    if not audio_b64:
        raise HTTPException(status_code=502, detail="No audio in TTS response")

    return {"audio_b64": audio_b64}
