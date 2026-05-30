"""Run the new S14 worker against downloaded session image folders."""
from __future__ import annotations
import asyncio, base64, glob, os, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.chdir(HERE.parents[1]); sys.path.insert(0, str(HERE.parents[1]))

# optional: load .env so Groq keys are available for VLM arbitration
def load_env(p: Path):
    if not p.exists(): return
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

if os.getenv("S14_USE_ENV", "1") == "1":
    load_env(HERE.parents[1] / ".env")

from app.workers.s14_item_consistency import run as run_s14  # noqa: E402

_ORDER = {"top": 0, "45deg": 1, "side": 2, "macro": 3}
def ftype(n):
    s = n.lower()
    for t in ("45deg", "macro", "side", "top", "selfie", "hallmark", "huid"):
        if t in s: return t
    return "video"

def data_url(p):
    return "data:image/jpeg;base64," + base64.b64encode(Path(p).read_bytes()).decode()

async def main(run_dir):
    for sdir in sorted(d for d in Path(run_dir).iterdir() if d.is_dir()):
        imgs = sorted(sdir.glob("*.jpg"))
        if len(imgs) < 2: continue
        # order: one of each still type first, then the rest (as 'video' slots)
        imgs = sorted(imgs, key=lambda p: (_ORDER.get(ftype(p.name), 9), p.name))
        frames = [data_url(p) for p in imgs]
        t0 = time.time()
        res = await run_s14(sdir.name, frames=frames, selfie_url=None)
        dt = (time.time() - t0) * 1000
        p = res.payload
        print(f"\n=== {sdir.name[:34]}  ({len(imgs)} frames) — {dt:.0f}ms ===")
        print(f"  mismatch={p.get('same_item_mismatch')} score={p.get('item_mismatch_score')} "
              f"groups={p.get('groups')} method={p.get('method')} frames_compared={p.get('frames_compared')}")
        for c in p.get("comparisons", []):
            print(f"    rep {c['frame_type']:7} group={c['group_labels']} -> {c['verdict']} "
                  f"score={c['same_item_score']} conf={c['confidence']} ({c['method']})")
        if p.get("mismatched_frames"):
            print(f"    MISMATCHED: {[m['frame_type'] for m in p['mismatched_frames']]}")

if __name__ == "__main__":
    rd = sys.argv[1] if len(sys.argv) > 1 else sorted(str(d) for d in (HERE/'runs').glob('*') if d.is_dir())[-1]
    print(f"run_dir: {rd}  VLM(env)={os.getenv('S14_USE_ENV','1')}")
    asyncio.run(main(rd))
