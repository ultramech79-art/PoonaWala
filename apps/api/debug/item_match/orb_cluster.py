"""Per-session ORB clustering: groups frames into 'same physical item' clusters
via an inlier graph, so we can see if ORB cleanly separates items on real data."""
from __future__ import annotations
import sys, os
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
os.chdir(HERE.parents[1])

from debug.item_match.orb_experiment import _prep, _frame_type, orb_inliers  # noqa: E402

INLIER_EDGE = int(os.getenv("INLIER_EDGE", "7"))   # >= this many RANSAC inliers ⇒ same-item edge


def components(nodes, edges):
    parent = {n: n for n in nodes}
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for a, b in edges:
        parent[find(a)] = find(b)
    groups: dict[str, list] = {}
    for n in nodes:
        groups.setdefault(find(n), []).append(n)
    return list(groups.values())


def run(run_dir: Path):
    for sdir in sorted(d for d in run_dir.iterdir() if d.is_dir()):
        imgs = sorted(sdir.glob("*.jpg"))
        if len(imgs) < 2:
            continue
        prepped = {p.name: (_prep(p), _frame_type(p.name)) for p in imgs}
        names = [n for n in prepped if prepped[n][0] is not None]
        edges = []
        pair_inliers = []
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                _, inl, _ = orb_inliers(prepped[names[i]][0], prepped[names[j]][0])
                pair_inliers.append(inl)
                if inl >= INLIER_EDGE:
                    edges.append((names[i], names[j]))
        comps = components(names, edges)
        comps.sort(key=len, reverse=True)
        nz = [x for x in pair_inliers if x > 0]
        print(f"\n=== {sdir.name}  frames={len(names)}  clusters={len(comps)} "
              f"(edge>={INLIER_EDGE})  pairs={len(pair_inliers)} nonzero={len(nz)} "
              f"max_inliers={max(pair_inliers) if pair_inliers else 0} ===")
        for k, comp in enumerate(comps, 1):
            types = [prepped[n][1] for n in comp]
            print(f"  cluster {k}: {len(comp)} frames -> {types}")


if __name__ == "__main__":
    rd = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted(d for d in (HERE / "runs").iterdir() if d.is_dir())[-1]
    print(f"run_dir: {rd}  INLIER_EDGE={INLIER_EDGE}")
    run(rd)
