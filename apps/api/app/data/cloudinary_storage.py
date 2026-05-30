from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass(frozen=True)
class ImageMeta:
    sha256: str
    width_px: Optional[int]
    height_px: Optional[int]


def cloudinary_configured() -> bool:
    return bool(
        os.getenv("CLOUDINARY_CLOUD_NAME")
        and os.getenv("CLOUDINARY_API_KEY")
        and os.getenv("CLOUDINARY_API_SECRET")
    )


def image_metadata(raw: bytes) -> ImageMeta:
    width = None
    height = None
    try:
        import cv2

        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is not None:
            height, width = img.shape[:2]
    except Exception:
        pass
    return ImageMeta(sha256=hashlib.sha256(raw).hexdigest(), width_px=width, height_px=height)


def _folder() -> str:
    return os.getenv("CLOUDINARY_UPLOAD_FOLDER", "poona-wala").strip().strip("/") or "poona-wala"


def _safe_part(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value)[:80]


async def upload_image_bytes(
    raw: bytes,
    *,
    user_id: str,
    asset_kind: str,
    content_type: str,
    session_id: Optional[str] = None,
) -> dict:
    if not cloudinary_configured():
        raise RuntimeError("cloudinary_not_configured")

    def _upload() -> dict:
        import cloudinary
        import cloudinary.uploader

        cloudinary.config(
            cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
            api_key=os.getenv("CLOUDINARY_API_KEY"),
            api_secret=os.getenv("CLOUDINARY_API_SECRET"),
            secure=True,
        )
        ts = int(time.time() * 1000)
        parent = f"{_folder()}/users/{_safe_part(user_id)}"
        if session_id:
            parent = f"{parent}/sessions/{_safe_part(session_id)}"
        data_url = f"data:{content_type};base64,{base64.b64encode(raw).decode('ascii')}"
        return cloudinary.uploader.upload(
            data_url,
            folder=parent,
            public_id=f"{ts}_{_safe_part(asset_kind)}",
            resource_type="image",
            overwrite=False,
            unique_filename=True,
        )

    return await asyncio.to_thread(_upload)


async def delete_image(public_id: str) -> bool:
    """Delete an image from Cloudinary by its public_id. Returns True if deleted."""
    if not cloudinary_configured() or not public_id:
        return False

    def _delete() -> bool:
        import cloudinary
        import cloudinary.uploader

        cloudinary.config(
            cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
            api_key=os.getenv("CLOUDINARY_API_KEY"),
            api_secret=os.getenv("CLOUDINARY_API_SECRET"),
            secure=True,
        )
        result = cloudinary.uploader.destroy(public_id, resource_type="image")
        return result.get("result") == "ok"

    try:
        return await asyncio.to_thread(_delete)
    except Exception:
        return False
