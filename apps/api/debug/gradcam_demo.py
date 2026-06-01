"""
Manual Grad-CAM demo runner.

Usage:
  PYTHONPATH=apps/api python apps/api/debug/gradcam_demo.py
  PYTHONPATH=apps/api python apps/api/debug/gradcam_demo.py --use-gemini

Outputs originals, overlays, contact sheets, and summary.json to /private/tmp by
default. Synthetic cases include expected target boxes so the script can flag
center-only or wrong-region behavior.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
API_ROOT = REPO_ROOT / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.xai.gemini_focus import locate_focus_regions
from app.xai.gradcam import (
    FocusRegion,
    _detect_local_focus_regions,
    _parse_ai_regions,
    _render_focus_overlay,
    generate_gradcam_url,
)


@dataclass
class DemoCase:
    name: str
    path: Path
    expected_box: tuple[int, int, int, int] | None = None
    note: str = ""
    frame_type: str | None = None


def _safe_name(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name)


def _write_image(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(path), img)
    if not ok:
        raise RuntimeError(f"Could not write image: {path}")


def _image_to_data_url(img: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise RuntimeError("Could not encode demo image")
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode()


def _data_url_to_image(data_url: str) -> np.ndarray | None:
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1])
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception:
        return None


def _make_synthetic_cases(out_dir: Path) -> list[DemoCase]:
    synthetic_dir = out_dir / "synthetic_inputs"
    synthetic_dir.mkdir(parents=True, exist_ok=True)
    cases: list[DemoCase] = []

    def base() -> np.ndarray:
        img = np.full((420, 420, 3), 246, dtype=np.uint8)
        cv2.circle(img, (310, 300), 62, (54, 154, 218), -1, cv2.LINE_AA)
        cv2.circle(img, (310, 300), 35, (246, 246, 246), -1, cv2.LINE_AA)
        return img

    img = base()
    cv2.rectangle(img, (30, 54), (238, 138), (58, 166, 224), -1, cv2.LINE_AA)
    cv2.putText(img, "HUID A1B2C3", (44, 106), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (34, 29, 24), 2, cv2.LINE_AA)
    path = synthetic_dir / "synthetic_huid_left.jpg"
    _write_image(path, img)
    cases.append(DemoCase("synthetic_huid_left", path, (30, 54, 238, 138), "HUID is off-center left", "macro"))

    img = base()
    cv2.rectangle(img, (196, 52), (390, 136), (58, 166, 224), -1, cv2.LINE_AA)
    cv2.putText(img, "916 BIS", (218, 104), cv2.FONT_HERSHEY_SIMPLEX, 0.82, (34, 29, 24), 2, cv2.LINE_AA)
    path = synthetic_dir / "synthetic_purity_right.jpg"
    _write_image(path, img)
    cases.append(DemoCase("synthetic_purity_right", path, (196, 52, 390, 136), "Purity mark is off-center right", "macro"))

    img = np.full((420, 420, 3), 245, dtype=np.uint8)
    cv2.circle(img, (210, 210), 88, (54, 154, 218), -1, cv2.LINE_AA)
    cv2.rectangle(img, (248, 310), (405, 386), (58, 166, 224), -1, cv2.LINE_AA)
    cv2.putText(img, "22K 916", (262, 358), cv2.FONT_HERSHEY_SIMPLEX, 0.68, (34, 29, 24), 2, cv2.LINE_AA)
    path = synthetic_dir / "synthetic_center_decoy_bottom_right_mark.jpg"
    _write_image(path, img)
    cases.append(DemoCase("synthetic_center_decoy_bottom_right_mark", path, (248, 310, 405, 386), "Center gold decoy; mark is bottom-right", "macro"))

    img = np.full((420, 420, 3), 246, dtype=np.uint8)
    cv2.ellipse(img, (210, 210), (115, 70), -22, 0, 360, (51, 151, 215), 18, cv2.LINE_AA)
    cv2.line(img, (130, 120), (315, 290), (70, 170, 225), 10, cv2.LINE_AA)
    path = synthetic_dir / "synthetic_no_text_bangle.jpg"
    _write_image(path, img)
    cases.append(DemoCase("synthetic_no_text_bangle", path, None, "No mark; should focus on jewellery detail or return no overlay", "top"))

    return cases


def _collect_cases(out_dir: Path, limit_real: int) -> list[DemoCase]:
    cases = _make_synthetic_cases(out_dir)

    demo_dir = REPO_ROOT / "apps" / "web" / "public" / "assets" / "demo"
    demo_paths = [path for path in sorted(demo_dir.glob("*.jpg")) if path.stem in {"45deg", "top", "side", "macro"}]
    for path in demo_paths[:limit_real]:
        expected = {
            "45deg": (620, 250, 850, 490),
            "top": (620, 250, 850, 520),
            "side": (330, 260, 780, 590),
            "macro": None,
        }.get(path.stem)
        cases.append(DemoCase(f"app_demo_{path.stem}", path, expected, "App demo capture", path.stem))

    for path in sorted((REPO_ROOT / "ml" / "synthetic" / "hallmarks" / "hallmark").glob("*.jpg"))[:limit_real]:
        cases.append(DemoCase(f"dataset_hallmark_{path.stem}", path, None, "Synthetic hallmark dataset", "macro"))

    for path in sorted((REPO_ROOT / "ml" / "synthetic" / "hallmarks" / "no_hallmark").glob("*.jpg"))[:max(1, limit_real // 2)]:
        cases.append(DemoCase(f"dataset_no_hallmark_{path.stem}", path, None, "Synthetic no-hallmark dataset", "macro"))

    return cases


def _region_to_dict(region: FocusRegion) -> dict[str, Any]:
    return {
        "label": region.label,
        "x": round(region.x, 2),
        "y": round(region.y, 2),
        "radius": round(region.radius, 2),
        "score": round(region.score, 4),
    }


def _hit_expected(region: FocusRegion | None, expected_box: tuple[int, int, int, int] | None) -> bool | None:
    if expected_box is None:
        return None
    if region is None:
        return False
    x1, y1, x2, y2 = expected_box
    return x1 <= region.x <= x2 and y1 <= region.y <= y2


def _is_centerish(region: FocusRegion | None, shape: tuple[int, int, int]) -> bool:
    if region is None:
        return False
    h, w = shape[:2]
    return abs(region.x - (w / 2)) < w * 0.11 and abs(region.y - (h / 2)) < h * 0.11


def _make_contact_sheet(original: np.ndarray, overlay: np.ndarray | None, title: str) -> np.ndarray:
    h, w = original.shape[:2]
    target_w = 360
    target_h = max(1, int(h * target_w / w))
    original_small = cv2.resize(original, (target_w, target_h), interpolation=cv2.INTER_AREA)
    overlay_small = cv2.resize(overlay if overlay is not None else original, (target_w, target_h), interpolation=cv2.INTER_AREA)
    gap = np.full((target_h, 16, 3), 248, dtype=np.uint8)
    sheet = np.hstack([original_small, gap, overlay_small])
    footer = np.full((54, sheet.shape[1], 3), 255, dtype=np.uint8)
    cv2.putText(footer, title[:70], (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (35, 30, 25), 1, cv2.LINE_AA)
    return np.vstack([sheet, footer])


async def _process_case(case: DemoCase, out_dir: Path, use_gemini: bool, force_gemini: bool) -> dict[str, Any]:
    img = cv2.imread(str(case.path), cv2.IMREAD_COLOR)
    if img is None:
        return {"name": case.name, "path": str(case.path), "status": "read_failed"}

    local_regions = _detect_local_focus_regions(img, frame_type=case.frame_type)
    ai_regions: list[FocusRegion] = []
    if use_gemini:
        raw_ai = await locate_focus_regions(img, session_id=case.name, prefer_gemini=True)
        ai_regions = _parse_ai_regions({"regions": raw_ai}, img.shape[1], img.shape[0])

    regions = ai_regions if force_gemini and ai_regions else (local_regions or ai_regions)
    overlay = _render_focus_overlay(img, regions)

    generated = await generate_gradcam_url(_image_to_data_url(img), case.name, frame_type=case.frame_type)
    generated_overlay = _data_url_to_image(generated) if generated else None

    name = _safe_name(case.name)
    original_path = out_dir / f"{name}_original.jpg"
    overlay_path = out_dir / f"{name}_overlay.jpg"
    pipeline_overlay_path = out_dir / f"{name}_pipeline_overlay.jpg"
    sheet_path = out_dir / f"{name}_sheet.jpg"
    shutil.copyfile(case.path, original_path)
    if overlay is not None:
        _write_image(overlay_path, overlay)
    if generated_overlay is not None:
        _write_image(pipeline_overlay_path, generated_overlay)
    _write_image(sheet_path, _make_contact_sheet(img, overlay, case.name))

    strongest = regions[0] if regions else None
    expected_hit = _hit_expected(strongest, case.expected_box)
    centerish = _is_centerish(strongest, img.shape)
    status = "ok"
    if expected_hit is False:
        status = "expected_miss"
    elif case.expected_box is None and centerish:
        status = "center_suspicious"
    elif not regions and case.expected_box is not None:
        status = "missing_expected_region"

    return {
        "name": case.name,
        "path": str(case.path),
        "note": case.note,
        "status": status,
        "expected_hit": expected_hit,
        "centerish": centerish,
        "overlay_path": str(overlay_path) if overlay is not None else None,
        "pipeline_overlay_path": str(pipeline_overlay_path) if generated_overlay is not None else None,
        "sheet_path": str(sheet_path),
        "local_regions": [_region_to_dict(region) for region in local_regions],
        "ai_regions": [_region_to_dict(region) for region in ai_regions],
        "chosen_regions": [_region_to_dict(region) for region in regions],
        "generated_url_returned": bool(generated),
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/private/tmp/goldeye_gradcam_demo")
    parser.add_argument("--limit-real", type=int, default=4)
    parser.add_argument("--use-gemini", action="store_true", help="Call Gemini/Groq focus locator if keys are configured")
    parser.add_argument("--force-gemini", action="store_true", help="Prefer Gemini/Groq regions over local regions when available")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cases = _collect_cases(out_dir, limit_real=args.limit_real)

    results = []
    for case in cases:
        result = await _process_case(case, out_dir, use_gemini=args.use_gemini, force_gemini=args.force_gemini)
        results.append(result)
        strongest = (result.get("chosen_regions") or [{}])[0]
        print(
            f"{result['status']:<24} {result['name']:<44} "
            f"x={strongest.get('x', '--')} y={strongest.get('y', '--')} "
            f"overlay={bool(result.get('overlay_path'))}"
        )

    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    await _close_provider_sessions()
    print(f"\nWrote {len(results)} demo results to {out_dir}")
    print(f"Summary: {summary_path}")


async def _close_provider_sessions() -> None:
    try:
        from app.data import gemini as gemini_module

        session = getattr(gemini_module, "_session", None)
        if session is not None and not session.closed:
            await session.close()
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())
