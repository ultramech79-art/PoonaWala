"""
Capture asset persistence.

Images are stored in Supabase Storage when the Supabase environment variables
are configured. The database row is still written in local/dev mode so the
session has a durable audit trail even when object storage is disabled.
"""
from __future__ import annotations

import base64
import hashlib
import os
import time
from typing import Optional

import numpy as np

from app.data.image_utils import fetch_image_bytes
from app.data.phash import compute_phash, phash_to_hex
from app.db.database import AsyncSessionLocal
from app.db.models import ImageAsset, ImageBlob


def _supabase_configured() -> bool:
    return bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


def _cloudinary_configured() -> bool:
    return bool(
        os.getenv("CLOUDINARY_CLOUD_NAME")
        and os.getenv("CLOUDINARY_API_KEY")
        and os.getenv("CLOUDINARY_API_SECRET")
    )


def _bucket() -> str:
    return os.getenv("SUPABASE_STORAGE_BUCKET", "jewelry-captures").strip() or "jewelry-captures"


def _db_image_storage_enabled() -> bool:
    return os.getenv("STORE_CAPTURE_IMAGES_IN_DB", "0").lower() in ("1", "true", "yes")


def _max_db_image_bytes() -> int:
    try:
        return max(1, int(os.getenv("CAPTURE_IMAGE_DB_MAX_BYTES", "2000000")))
    except ValueError:
        return 2_000_000


def _safe_frame_type(frame_type: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in frame_type)


async def _load_bytes(source: str) -> Optional[bytes]:
    if not source:
        return None
    if source.startswith("data:") or source.startswith("http://") or source.startswith("https://") or source.startswith("local://"):
        return await fetch_image_bytes(source)
    try:
        return base64.b64decode(source, validate=True)
    except Exception:
        return None


def _image_metadata(raw: bytes) -> dict:
    meta = {
        "content_sha256": hashlib.sha256(raw).hexdigest(),
        "phash": None,
        "width_px": None,
        "height_px": None,
    }
    try:
        import cv2

        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is not None:
            h, w = img.shape[:2]
            meta["width_px"] = int(w)
            meta["height_px"] = int(h)
            hsh = compute_phash(img)
            if hsh is not None:
                meta["phash"] = phash_to_hex(hsh)
    except Exception:
        pass
    return meta


async def _upload_to_supabase(raw: bytes, storage_path: str, content_type: str) -> dict:
    if not _supabase_configured():
        return {
            "storage_enabled": False,
            "storage_path": None,
            "public_url": None,
            "error": "supabase_env_missing",
        }

    import httpx

    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    bucket = _bucket()
    url = f"{supabase_url}/storage/v1/object/{bucket}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": content_type,
        "x-upsert": "true",
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(url, headers=headers, content=raw)
            if response.status_code not in (200, 201):
                return {
                    "storage_enabled": True,
                    "storage_path": storage_path,
                    "public_url": None,
                    "error": f"supabase_upload_failed_{response.status_code}",
                }

        public_url = None
        if os.getenv("SUPABASE_STORAGE_PUBLIC", "0").lower() in ("1", "true", "yes"):
            public_url = f"{supabase_url}/storage/v1/object/public/{bucket}/{storage_path}"

        return {
            "storage_enabled": True,
            "storage_path": storage_path,
            "public_url": public_url,
            "error": None,
        }
    except Exception as exc:
        return {
            "storage_enabled": True,
            "storage_path": storage_path,
            "public_url": None,
            "error": str(exc),
        }


async def _upload_to_cloudinary(raw: bytes, storage_path: str, content_type: str) -> dict:
    if not _cloudinary_configured():
        return {
            "storage_enabled": False,
            "storage_path": None,
            "public_url": None,
            "error": "cloudinary_env_missing",
        }
    try:
        from app.data.cloudinary_storage import upload_image_bytes

        parts = storage_path.split("/")
        session_id = parts[1] if len(parts) > 1 else "unknown"
        uploaded = await upload_image_bytes(
            raw,
            user_id="session-captures",
            session_id=session_id,
            asset_kind=parts[-1].rsplit(".", 1)[0],
            content_type=content_type,
        )
        return {
            "storage_enabled": True,
            "storage_path": uploaded.get("public_id"),
            "public_url": uploaded.get("secure_url") or uploaded.get("url"),
            "error": None,
        }
    except Exception as exc:
        return {
            "storage_enabled": True,
            "storage_path": None,
            "public_url": None,
            "error": str(exc),
        }


async def _upload_object(raw: bytes, storage_path: str, content_type: str) -> dict:
    if _cloudinary_configured():
        uploaded = await _upload_to_cloudinary(raw, storage_path, content_type)
        if not uploaded.get("error"):
            return uploaded
    return await _upload_to_supabase(raw, storage_path, content_type)


async def store_capture_asset(
    session_id: Optional[str],
    frame_type: str,
    image_source: str,
    same_item: Optional[dict] = None,
    content_type: str = "image/jpeg",
) -> Optional[dict]:
    if not session_id or not image_source:
        return None

    raw = await _load_bytes(image_source)
    if not raw:
        return None

    meta = _image_metadata(raw)
    ts = int(time.time() * 1000)
    storage_path = f"sessions/{session_id}/{ts}_{_safe_frame_type(frame_type)}.jpg"
    upload = await _upload_object(raw, storage_path, content_type)
    stored_path = upload.get("storage_path") if upload.get("storage_enabled") and not upload.get("error") else None

    asset = ImageAsset(
        session_id=session_id,
        frame_type=frame_type,
        storage_path=stored_path,
        public_url=upload.get("public_url"),
        content_sha256=meta["content_sha256"],
        phash=meta["phash"],
        width_px=meta["width_px"],
        height_px=meta["height_px"],
        same_item_score=float(same_item["same_item_score"]) if same_item and same_item.get("same_item_score") is not None else None,
        same_item_verdict=same_item.get("verdict") if same_item else None,
    )

    blob_id = None
    db_blob_skipped_reason = None
    async with AsyncSessionLocal() as db:
        db.add(asset)
        await db.flush()

        if _db_image_storage_enabled():
            max_bytes = _max_db_image_bytes()
            if len(raw) <= max_bytes:
                blob = ImageBlob(
                    asset_id=asset.id,
                    session_id=session_id,
                    frame_type=frame_type,
                    content_type=content_type,
                    size_bytes=len(raw),
                    image_bytes=raw,
                )
                db.add(blob)
                await db.flush()
                blob_id = blob.id
            else:
                db_blob_skipped_reason = f"image_too_large_{len(raw)}_gt_{max_bytes}"

        await db.commit()
        await db.refresh(asset)

    return {
        "id": asset.id,
        "session_id": session_id,
        "frame_type": frame_type,
        "storage_path": stored_path,
        "public_url": upload.get("public_url"),
        "content_sha256": meta["content_sha256"],
        "phash": meta["phash"],
        "width_px": meta["width_px"],
        "height_px": meta["height_px"],
        "storage_enabled": upload.get("storage_enabled", False),
        "storage_error": upload.get("error"),
        "db_image_storage_enabled": _db_image_storage_enabled(),
        "db_blob_id": blob_id,
        "db_blob_skipped_reason": db_blob_skipped_reason,
    }
