"""
Frame evaluation and live guidance endpoints.
Live guidance uses GROQ_GUIDANCE_API_KEY with GEMINI_GUIDANCE_FALLBACK_API_KEY fallback.
"""
import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.data.gemini import evaluate_frame, evaluate_live_guidance_frame
from app.data.image_utils import fetch_image_bytes

router = APIRouter()
logger = logging.getLogger("goldeye.frame_eval")


class FrameEvalRequest(BaseModel):
    frame_type: str
    image_data_url: Optional[str] = None
    image_url: Optional[str] = None


class FrameEvalResponse(BaseModel):
    approved: bool
    quality_score: float
    feedback: str
    issues: list
    detected: dict


def _extract_data_url_b64(image_data_url: Optional[str]) -> Optional[str]:
    if not image_data_url:
        return None
    if "," in image_data_url:
        return image_data_url.split(",", 1)[1]
    return image_data_url


@router.post("/api/evaluate-frame", response_model=FrameEvalResponse)
async def evaluate_frame_endpoint(req: FrameEvalRequest):
    image_b64 = _extract_data_url_b64(req.image_data_url)

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
            feedback="Could not load image - please retake",
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


@router.websocket("/api/ws/evaluate-frame")
async def evaluate_frame_ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket client connected for frame evaluation")
    try:
        while True:
            raw = await websocket.receive_text()
            req = json.loads(raw)

            frame_type = req.get("frame_type", "top")
            image_b64 = _extract_data_url_b64(req.get("image_data_url"))

            if not image_b64:
                await websocket.send_json({
                    "approved": False,
                    "quality_score": 0.0,
                    "feedback": "Could not load image - please retake",
                    "issues": ["image_load_failed"],
                    "detected": {},
                })
                continue

            result = await evaluate_frame(image_b64, frame_type)
            logger.info(
                f"WS eval [{frame_type}]: approved={result.get('approved')}, "
                f"score={result.get('quality_score')}"
            )

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
                "feedback": "Evaluation error - please retake image",
                "issues": ["evaluation_error"],
                "detected": {},
            })
        except Exception:
            pass


@router.websocket("/api/ws/live-guidance")
async def live_guidance_ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket client connected for live guidance")
    try:
        while True:
            raw = await websocket.receive_text()
            req = json.loads(raw)
            image_b64 = req.get("image_b64") or req.get("image_base64")
            frame_type = req.get("frame_type", "top")

            if not image_b64:
                await websocket.send_json({
                    "text": "Could not read the camera frame. Hold steady and try again.",
                    "approved": False,
                    "quality_score": 0.0,
                    "issues": ["image_load_failed"],
                })
                continue

            result = await evaluate_live_guidance_frame(image_b64, frame_type)
            logger.info(
                f"Live guidance [{frame_type}]: provider={result.get('provider', 'unknown')} "
                f"approved={result.get('approved')} score={result.get('quality_score')}"
            )
            await websocket.send_json({
                "text": result.get("feedback", "Hold the ornament steady in good light."),
                "approved": result.get("approved", True),
                "quality_score": float(result.get("quality_score", 0.5)),
                "issues": result.get("issues", []),
                "detected": result.get("detected", {}),
                "provider": result.get("provider"),
            })
    except WebSocketDisconnect:
        logger.info("Client disconnected from live guidance websocket")
    except Exception as e:
        logger.error(f"Live guidance websocket error: {e}")
        try:
            await websocket.send_json({
                "text": "Live guidance failed. Please continue with manual capture.",
                "approved": False,
                "quality_score": 0.0,
                "issues": ["live_guidance_error"],
            })
        except Exception:
            pass
