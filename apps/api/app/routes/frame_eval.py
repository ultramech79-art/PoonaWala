"""
Frame evaluation and live guidance endpoints.
Live guidance uses GROQ_GUIDANCE_API_KEY with GEMINI_GUIDANCE_FALLBACK_API_KEY fallback.
"""
import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.data.gemini import evaluate_frame, evaluate_live_guidance_frame
from app.data.image_utils import fetch_image_bytes
from app.data.capture_assets import store_capture_asset
from app.data.item_match import COMPARE_FRAME_TYPES, compare_item_images, is_blocking_mismatch

router = APIRouter()
logger = logging.getLogger("goldeye.frame_eval")


class FrameEvalRequest(BaseModel):
    frame_type: str
    image_data_url: Optional[str] = None
    image_url: Optional[str] = None
    session_id: Optional[str] = None
    reference_frame_type: str = "top"
    reference_image_data_url: Optional[str] = None
    reference_image_url: Optional[str] = None
    language: str = "en"


class FrameEvalResponse(BaseModel):
    approved: bool
    quality_score: float
    feedback: str
    issues: list
    detected: dict
    same_item: Optional[dict] = None
    asset: Optional[dict] = None


def _extract_data_url_b64(image_data_url: Optional[str]) -> Optional[str]:
    if not image_data_url:
        return None
    if "," in image_data_url:
        return image_data_url.split(",", 1)[1]
    return image_data_url


def _candidate_data_url(image_b64: str) -> str:
    return f"data:image/jpeg;base64,{image_b64}"


async def _evaluate_compare_store(
    *,
    frame_type: str,
    image_b64: str,
    image_source: str,
    session_id: Optional[str],
    reference_frame_type: str = "top",
    reference_image_data_url: Optional[str] = None,
    reference_image_url: Optional[str] = None,
    language: str = "en",
) -> FrameEvalResponse:
    result = await evaluate_frame(image_b64, frame_type, language=language)
    detected = result.get("detected", {}) or {}
    issues = list(result.get("issues", []) or [])
    approved = bool(result.get("approved", True))
    feedback = result.get("feedback", "Image captured")
    quality_score = float(result.get("quality_score", 0.5))

    same_item = None
    reference_source = reference_image_data_url or reference_image_url
    if reference_source and frame_type in COMPARE_FRAME_TYPES:
        try:
            same_item = await asyncio.wait_for(
                compare_item_images(
                    reference_source,
                    image_source,
                    reference_frame_type=reference_frame_type or "top",
                    candidate_frame_type=frame_type,
                ),
                timeout=12.0,
            )
        except asyncio.TimeoutError:
            logger.warning("same_item comparison timed out for [%s vs %s] — skipping", reference_frame_type, frame_type)
            same_item = None
        detected["same_item"] = same_item
        blocking_mismatch = is_blocking_mismatch(same_item)
        if same_item:
            logger.info(
                "same_item [%s vs %s]: verdict=%s score=%s confidence=%s method=%s blocking=%s",
                reference_frame_type or "top",
                frame_type,
                same_item.get("verdict"),
                same_item.get("same_item_score"),
                same_item.get("confidence"),
                same_item.get("method"),
                blocking_mismatch,
            )
        if blocking_mismatch:
            approved = False
            quality_score = min(quality_score, 0.35)
            if "same_item_mismatch" not in issues:
                issues.append("same_item_mismatch")
            reference_label = "45-degree photo" if (reference_frame_type or "top") == "45deg" else "top-view photo"
            feedback = (
                f"This does not look like the same jewelry item as the {reference_label}. "
                "Please retake using the same item."
            )

    asset = None
    try:
        asset = await store_capture_asset(session_id, frame_type, image_source, same_item=same_item)
    except Exception as exc:
        logger.warning(f"Could not store capture asset: {exc}")

    return FrameEvalResponse(
        approved=approved,
        quality_score=quality_score,
        feedback=feedback,
        issues=issues,
        detected=detected,
        same_item=same_item,
        asset=asset,
    )


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

    return await _evaluate_compare_store(
        frame_type=req.frame_type,
        image_b64=image_b64,
        image_source=req.image_data_url or _candidate_data_url(image_b64),
        session_id=req.session_id,
        reference_frame_type=req.reference_frame_type,
        reference_image_data_url=req.reference_image_data_url,
        reference_image_url=req.reference_image_url,
        language=req.language,
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

            response = await _evaluate_compare_store(
                frame_type=frame_type,
                image_b64=image_b64,
                image_source=req.get("image_data_url") or _candidate_data_url(image_b64),
                session_id=req.get("session_id"),
                reference_frame_type=req.get("reference_frame_type", "top"),
                reference_image_data_url=req.get("reference_image_data_url"),
                reference_image_url=req.get("reference_image_url"),
                language=req.get("language", "en"),
            )
            logger.info(
                f"WS eval [{frame_type}]: approved={response.approved}, "
                f"score={response.quality_score}"
            )

            await websocket.send_json(response.dict())
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
