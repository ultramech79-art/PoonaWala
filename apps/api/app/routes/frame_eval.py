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


class FrameEvalResponse(BaseModel):
    approved: bool
    quality_score: float
    feedback: str
    issues: list
    detected: dict
    same_item: Optional[dict] = None
    asset: Optional[dict] = None


async def _store_capture_asset_background(
    session_id: Optional[str],
    frame_type: str,
    image_source: str,
    same_item: Optional[dict] = None,
) -> None:
    try:
        await store_capture_asset(session_id, frame_type, image_source, same_item=same_item)
    except Exception as exc:
        logger.warning(f"Could not store capture asset: {exc}")


def _consume_task_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc:
        logger.warning("Background frame task failed: %s", exc)


def _extract_data_url_b64(image_data_url: Optional[str]) -> Optional[str]:
    if not image_data_url:
        return None
    if "," in image_data_url:
        return image_data_url.split(",", 1)[1]
    return image_data_url


def _candidate_data_url(image_b64: str) -> str:
    return f"data:image/jpeg;base64,{image_b64}"


def _is_normal_ws_close(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "1005" in text
        or "1000" in text
        or "websocket is not connected" in text
        or "cannot call" in text and "send" in text and "close" in text
    )


def _same_item_unverified(same_item: Optional[dict], frame_type: str) -> bool:
    if str(frame_type or "").strip().lower() not in {"top", "side"}:
        return False
    if not same_item:
        return True
    method = str(same_item.get("method") or "")
    reasons = set(same_item.get("mismatch_reasons") or [])
    verdict = same_item.get("verdict")
    score = float(same_item.get("same_item_score") or 0.5)
    reference_frame_type = str(same_item.get("reference_frame_type") or "").strip().lower()

    # 45deg reference produces a large angle change — inconclusive is the
    # expected outcome, not a fraud signal.  Only block when score is very
    # low (strong mismatch evidence) or reference image was missing.
    if reference_frame_type == "45deg":
        if "missing_reference_or_candidate_image" in reasons:
            return True
        if verdict == "inconclusive" or method in {
            "same_item_timeout", "local_visual_fingerprint_timeout", "none"
        }:
            return score < 0.40
        return False  # same/different verdicts handled by is_blocking_mismatch

    if method == "local_visual_fingerprint" and verdict == "inconclusive" and score >= 0.62:
        return False
    return (
        verdict == "inconclusive"
        or method in {"same_item_timeout", "local_visual_fingerprint_timeout", "none"}
        or "same_item_compare_timeout" in reasons
        or "local_fingerprint_timeout" in reasons
        or "missing_reference_or_candidate_image" in reasons
    )


async def _evaluate_compare_store(
    *,
    frame_type: str,
    image_b64: str,
    image_source: str,
    session_id: Optional[str],
    reference_frame_type: str = "top",
    reference_image_data_url: Optional[str] = None,
    reference_image_url: Optional[str] = None,
) -> FrameEvalResponse:
    # Start same-item compare immediately so it runs in parallel with evaluate_frame.
    # By the time evaluate_frame returns (~2-3s) compare is often already done.
    same_item = None
    reference_source = reference_image_data_url or reference_image_url
    compare_task = None
    if reference_source and frame_type in COMPARE_FRAME_TYPES:
        compare_task = asyncio.create_task(compare_item_images(
            reference_source,
            image_source,
            reference_frame_type=reference_frame_type or "top",
            candidate_frame_type=frame_type,
        ))

    result = await evaluate_frame(image_b64, frame_type)
    detected = result.get("detected", {}) or {}
    issues = list(result.get("issues", []) or [])
    approved = bool(result.get("approved", True))
    feedback = result.get("feedback", "Image captured")
    quality_score = float(result.get("quality_score", 0.5))

    if compare_task is not None:
        # Give at most 5 extra seconds after eval (deployed servers are slower).
        done, _pending = await asyncio.wait({compare_task}, timeout=5.0)
        if compare_task not in done:
            compare_task.cancel()
            compare_task.add_done_callback(_consume_task_exception)
            logger.warning("same_item [%s vs %s] timed out", reference_frame_type or "top", frame_type)
            same_item = {
                "same_item": None,
                "verdict": "inconclusive",
                "same_item_score": 0.5,
                "confidence": 0.0,
                "method": "same_item_timeout",
                "reference_frame_type": reference_frame_type or "top",
                "candidate_frame_type": frame_type,
                "matching_signals": [],
                "mismatch_reasons": ["same_item_compare_timeout"],
            }
        else:
            same_item = compare_task.result()
        detected["same_item"] = same_item
        blocking_mismatch = is_blocking_mismatch(same_item)
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
            cat_a = same_item.get("category_a")
            cat_b = same_item.get("category_b")
            if same_item.get("category_mismatch") and cat_a and cat_b:
                feedback = (
                    f"Different jewelry detected: the {reference_label} shows a {cat_a} "
                    f"but this appears to be a {cat_b}. Please use the same item."
                )
            else:
                feedback = (
                    f"This does not look like the same jewelry item as the {reference_label}. "
                    "Please retake using the same item."
                )
        elif _same_item_unverified(same_item, frame_type):
            approved = False
            quality_score = min(quality_score, 0.45)
            if "same_item_unverified" not in issues:
                issues.append("same_item_unverified")
            feedback = "Could not verify the jewelry item clearly. Please retake using the same item."

    asset = None
    if session_id and image_source:
        asyncio.create_task(_store_capture_asset_background(session_id, frame_type, image_source, same_item=same_item))

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
            )
            logger.info(
                f"WS eval [{frame_type}]: approved={response.approved}, "
                f"score={response.quality_score}"
            )

            try:
                await websocket.send_json(response.dict())
            except Exception as send_exc:
                if _is_normal_ws_close(send_exc):
                    logger.info("Client disconnected before frame evaluation response could be sent")
                    return
                raise
    except WebSocketDisconnect:
        logger.info("Client disconnected from evaluation websocket")
    except Exception as e:
        if _is_normal_ws_close(e):
            logger.info(f"Frame evaluation websocket closed: {e}")
            return
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
            try:
                await websocket.send_json({
                    "text": result.get("feedback", "Hold the ornament steady in good light."),
                    "approved": result.get("approved", True),
                    "quality_score": float(result.get("quality_score", 0.5)),
                    "issues": result.get("issues", []),
                    "detected": result.get("detected", {}),
                    "provider": result.get("provider"),
                })
            except Exception as send_exc:
                if _is_normal_ws_close(send_exc):
                    logger.info("Client disconnected before live guidance response could be sent")
                    return
                raise
    except WebSocketDisconnect:
        logger.info("Client disconnected from live guidance websocket")
    except Exception as e:
        if _is_normal_ws_close(e):
            logger.info(f"Live guidance websocket closed: {e}")
            return
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
