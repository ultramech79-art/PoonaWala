"""
Timing test for same-item comparison.
Run from apps/api/:
  python debug/test_same_item_timing.py
"""
import asyncio
import os
import sys
import time

# Allow imports from app/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load .env from apps/api/
_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./goldeye.db")

DEMO_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "web", "public", "assets", "demo",
)


def _load(name: str) -> bytes:
    path = os.path.join(DEMO_DIR, name)
    with open(path, "rb") as f:
        return f.read()


async def run():
    from app.data.item_match import compare_item_images

    pairs = [
        ("45deg.jpg", "top.jpg",  "45deg", "top",  "same item — angle change"),
        ("top.jpg",   "side.jpg", "top",   "side",  "same item — top→side"),
        ("top.jpg",   "top.jpg",  "top",   "top",   "exact duplicate"),
    ]

    import base64
    for ref_file, cand_file, ref_type, cand_type, label in pairs:
        ref_raw  = _load(ref_file)
        cand_raw = _load(cand_file)
        ref_src  = "data:image/jpeg;base64," + base64.b64encode(ref_raw).decode()
        cand_src = "data:image/jpeg;base64," + base64.b64encode(cand_raw).decode()

        t0 = time.monotonic()
        result = await compare_item_images(
            ref_src, cand_src,
            reference_frame_type=ref_type,
            candidate_frame_type=cand_type,
        )
        elapsed = time.monotonic() - t0

        verdict    = result.get("verdict", "?")
        score      = result.get("same_item_score", 0)
        confidence = result.get("confidence", 0)
        method     = result.get("method", "?")
        print(
            f"[{elapsed:5.2f}s] {label:<35} "
            f"verdict={verdict:<12} score={score:.2f}  conf={confidence:.2f}  method={method}"
        )


if __name__ == "__main__":
    asyncio.run(run())
