"""
POST /api/evaluate-frame
Gemini agent evaluates each captured frame in real-time.
Returns quality feedback so the user knows whether to retake.
"""
import base64
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from app.data.gemini import evaluate_frame
from app.data.image_utils import fetch_image_bytes

router = APIRouter()
logger = logging.getLogger("goldeye.frame_eval")


class FrameEvalRequest(BaseModel):
    frame_type: str          # top | 45deg | side | macro | selfie | video | audio
    image_data_url: Optional[str] = None   # base64 data URL from camera
    image_url: Optional[str] = None        # remote URL fallback


class FrameEvalResponse(BaseModel):
    approved: bool
    quality_score: float
    feedback: str
    issues: list
    detected: dict


@router.post("/api/evaluate-frame", response_model=FrameEvalResponse)
async def evaluate_frame_endpoint(req: FrameEvalRequest):
    """
    Gemini evaluates a single captured frame and returns actionable feedback.
    Called after every capture in the CaptureFlow before the user advances.
    """
    image_b64 = None

    # Extract base64 from data URL (data:image/jpeg;base64,...)
    if req.image_data_url:
        try:
            if "," in req.image_data_url:
                image_b64 = req.image_data_url.split(",", 1)[1]
            else:
                image_b64 = req.image_data_url
        except Exception:
            pass

    # Fallback: fetch from URL
    if not image_b64 and req.image_url and not req.image_url.startswith("local://"):
        try:
            raw = await fetch_image_bytes(req.image_url)
            if raw:
                image_b64 = base64.b64encode(raw).decode("utf-8")
        except Exception as e:
            logger.warning(f"Could not fetch image: {e}")

    if not image_b64:
        return FrameEvalResponse(
            approved=False,
            quality_score=0.0,
            feedback="Could not load image — please retake",
            issues=["image_load_failed"],
            detected={},
        )

    result = await evaluate_frame(image_b64, req.frame_type)

    return FrameEvalResponse(
        approved=result.get("approved", True),
        quality_score=float(result.get("quality_score", 0.5)),
        feedback=result.get("feedback", "Image captured"),
        issues=result.get("issues", []),
        detected=result.get("detected", {}),
    )


from fastapi import WebSocket, WebSocketDisconnect
import json
import asyncio

@router.websocket("/api/ws/evaluate-frame")
async def evaluate_frame_ws(websocket: WebSocket):
    """
    WebSocket endpoint for frame evaluation.
    Uses WebSocket transport (no HTTP timeouts) but calls the proven
    Gemini REST API internally via evaluate_frame().
    """
    await websocket.accept()
    logger.info("WebSocket client connected for frame evaluation")
    try:
        while True:
            raw = await websocket.receive_text()
            req = json.loads(raw)

            frame_type = req.get("frame_type", "top")
            image_data_url = req.get("image_data_url")

            # Extract base64 from data URL
            image_b64 = None
            if image_data_url:
                if "," in image_data_url:
                    image_b64 = image_data_url.split(",", 1)[1]
                else:
                    image_b64 = image_data_url

            if not image_b64:
                await websocket.send_json({
                    "approved": False,
                    "quality_score": 0.0,
                    "feedback": "Could not load image — please retake",
                    "issues": ["image_load_failed"],
                    "detected": {},
                })
                continue

            # Call the proven Gemini REST-based evaluate_frame
            result = await evaluate_frame(image_b64, frame_type)
            logger.info(f"WS eval [{frame_type}]: approved={result.get('approved')}, score={result.get('quality_score')}")

            await websocket.send_json({
                "approved": result.get("approved", True),
                "quality_score": float(result.get("quality_score", 0.5)),
                "feedback": result.get("feedback", "Image captured"),
                "issues": result.get("issues", []),
                "detected": result.get("detected", {}),
            })
    except WebSocketDisconnect:
        logger.info("Client disconnected from evaluation websocket")
    except Exception as e:
        logger.error(f"WebSocket evaluation error: {e}")
        try:
            await websocket.send_json({
                "approved": False,
                "quality_score": 0.0,
                "feedback": "Evaluation error — please retake image",
                "issues": ["evaluation_error"],
                "detected": {},
            })
        except:
            pass

@router.websocket("/api/ws/live-guidance")
async def live_guidance_ws(websocket: WebSocket):
    """
    Multimodal Live API proxy for real-time camera guidance.
    Temporarily disabled — Gemini Live API requires different setup.
    """
    await websocket.accept()
    await websocket.send_json({"error": "LIVE_GUIDANCE_UNAVAILABLE", "message": "Real-time guidance is temporarily unavailable. Frame evaluation via API is working normally."})
    await websocket.close()


