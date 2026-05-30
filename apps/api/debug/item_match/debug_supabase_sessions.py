from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = Path(__file__).resolve().parent / "runs"
FRAME_ORDER = {
    "45deg": 0,
    "top": 1,
    "side": 2,
    "macro": 3,
    "hallmark": 4,
    "huid": 5,
    "closeup": 6,
    "selfie": 7,
    "video": 8,
}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def api_request(method: str, url: str, key: str, body: dict[str, Any] | None = None) -> Any:
    data = None
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            return json.loads(raw.decode("utf-8"))
        return raw


def list_objects(supabase_url: str, bucket: str, key: str, prefix: str, limit: int = 1000) -> list[dict[str, Any]]:
    url = f"{supabase_url.rstrip('/')}/storage/v1/object/list/{bucket}"
    body = {
        "prefix": prefix,
        "limit": limit,
        "offset": 0,
        "sortBy": {"column": "name", "order": "desc"},
    }
    result = api_request("POST", url, key, body)
    return result if isinstance(result, list) else []


def download_object(supabase_url: str, bucket: str, key: str, path: str) -> bytes:
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
    url = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{encoded_path}"
    return api_request("GET", url, key)


def frame_type_from_name(name: str) -> str:
    stem = Path(name).stem.lower()
    if "45deg" in stem or "45_deg" in stem or "45-degree" in stem:
        return "45deg"
    if "hallmark" in stem:
        return "hallmark"
    if "huid" in stem:
        return "huid"
    if "closeup" in stem:
        return "closeup"
    if "macro" in stem:
        return "macro"
    if "selfie" in stem:
        return "selfie"
    if "side" in stem:
        return "side"
    if "top" in stem:
        return "top"
    if "video" in stem or re.search(r"frame[_-]?\d+", stem):
        return "video"
    return stem.rsplit("_", 1)[-1] or "unknown"


def timestamp_from_name(name: str) -> int:
    match = re.match(r"(\d+)", Path(name).name)
    return int(match.group(1)) if match else 0


def data_url(raw: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


def compact_result(result: dict[str, Any]) -> dict[str, Any]:
    local = result.get("local_fingerprint") or {}
    debug = result.get("debug") or local.get("debug") or {}
    return {
        "verdict": result.get("verdict"),
        "same_item": result.get("same_item"),
        "score": result.get("same_item_score"),
        "confidence": result.get("confidence"),
        "method": result.get("method"),
        "reference_view_partial": result.get("reference_view_partial") or local.get("reference_view_partial"),
        "matching_signals": result.get("matching_signals"),
        "mismatch_reasons": result.get("mismatch_reasons"),
        "debug": debug,
    }


async def compare_session(session_dir: Path, files: list[dict[str, Any]], use_remote: bool) -> dict[str, Any]:
    from app.data.item_match import compare_item_images, is_blocking_mismatch

    captures: list[dict[str, Any]] = []
    for item in files:
        name = item["name"]
        path = item["path"]
        local_path = session_dir / name
        raw = local_path.read_bytes()
        captures.append({
            "name": name,
            "path": path,
            "local_path": str(local_path),
            "frame_type": frame_type_from_name(name),
            "timestamp": timestamp_from_name(name),
            "data_url": data_url(raw),
            "size_bytes": len(raw),
        })

    captures.sort(key=lambda c: (FRAME_ORDER.get(c["frame_type"], 99), c["timestamp"], c["name"]))
    refs = [c for c in captures if c["frame_type"] == "45deg"] or [c for c in captures if c["frame_type"] == "top"]
    if not refs:
        return {"error": "missing_45deg_or_top_reference", "captures": [{k: v for k, v in c.items() if k != "data_url"} for c in captures]}

    reference = refs[0]
    comparisons = []
    for capture in captures:
        if capture is reference:
            continue
        started = time.perf_counter()
        result = await compare_item_images(
            reference["data_url"],
            capture["data_url"],
            reference_frame_type=reference["frame_type"],
            candidate_frame_type=capture["frame_type"],
            use_remote=use_remote,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        comparisons.append({
            "candidate": {k: v for k, v in capture.items() if k != "data_url"},
            "elapsed_ms": elapsed_ms,
            "blocking": is_blocking_mismatch(result),
            "result": compact_result(result),
        })

    return {
        "reference": {k: v for k, v in reference.items() if k != "data_url"},
        "captures": [{k: v for k, v in c.items() if k != "data_url"} for c in captures],
        "comparisons": comparisons,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    lines = ["# Item Match Session Report", ""]
    ref = report.get("reference") or {}
    lines.append(f"Reference: `{ref.get('name', 'missing')}` ({ref.get('frame_type', 'unknown')})")
    lines.append("")
    lines.append("| Candidate | Frame | Verdict | Score | Confidence | Method | Blocking | Time ms | Reasons |")
    lines.append("|---|---:|---:|---:|---:|---|---:|---:|---|")
    for item in report.get("comparisons", []):
        candidate = item.get("candidate") or {}
        result = item.get("result") or {}
        reasons = ", ".join(result.get("mismatch_reasons") or [])
        lines.append(
            "| `{}` | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                candidate.get("name"),
                candidate.get("frame_type"),
                result.get("verdict"),
                result.get("score"),
                result.get("confidence"),
                result.get("method"),
                item.get("blocking"),
                item.get("elapsed_ms"),
                reasons.replace("|", "/"),
            )
        )
    path.write_text("\n".join(lines) + "\n")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-sessions", type=int, default=20)
    parser.add_argument("--session", action="append", default=[])
    parser.add_argument("--remote", action="store_true")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "jewelry-captures")
    if not supabase_url or not service_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required", file=sys.stderr)
        return 2

    run_dir = RUNS_DIR / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    session_rows = list_objects(supabase_url, bucket, service_key, "sessions", limit=1000)
    session_names = [row["name"] for row in session_rows if row.get("name")]
    if args.session:
        wanted = set(args.session)
        session_names = [name for name in session_names if name in wanted]
    else:
        session_names = session_names[: args.max_sessions]

    aggregate: dict[str, Any] = {
        "run_dir": str(run_dir),
        "remote": args.remote,
        "session_count": len(session_names),
        "sessions": [],
    }

    for session_name in session_names:
        session_prefix = f"sessions/{session_name}"
        files = list_objects(supabase_url, bucket, service_key, session_prefix, limit=200)
        image_files = []
        session_dir = run_dir / session_name
        session_dir.mkdir(parents=True, exist_ok=True)
        for item in files:
            name = item.get("name")
            if not name or not name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            object_path = f"{session_prefix}/{name}"
            local_path = session_dir / name
            try:
                raw = download_object(supabase_url, bucket, service_key, object_path)
            except urllib.error.HTTPError as exc:
                print(f"download failed {object_path}: HTTP {exc.code}", file=sys.stderr)
                continue
            local_path.write_bytes(raw)
            image_files.append({"name": name, "path": object_path})

        report = await compare_session(session_dir, image_files, args.remote)
        report["session"] = session_name
        (session_dir / "report.json").write_text(json.dumps(report, indent=2))
        write_markdown(session_dir / "summary.md", report)
        aggregate["sessions"].append({
            "session": session_name,
            "image_count": len(image_files),
            "report": str(session_dir / "report.json"),
            "summary": str(session_dir / "summary.md"),
            "blocking_count": sum(1 for c in report.get("comparisons", []) if c.get("blocking")),
            "same_count": sum(1 for c in report.get("comparisons", []) if (c.get("result") or {}).get("verdict") == "same"),
            "inconclusive_count": sum(1 for c in report.get("comparisons", []) if (c.get("result") or {}).get("verdict") == "inconclusive"),
        })

    (run_dir / "all_sessions_report.json").write_text(json.dumps(aggregate, indent=2))
    print(json.dumps({"run_dir": str(run_dir), "sessions": len(session_names)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
