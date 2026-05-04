import os, time, argparse, hashlib, requests, random
from pathlib import Path
from PIL import Image
from io import BytesIO

SOLID_QUERIES = [
    "22k solid gold necklace jewelry",
    "24 karat solid gold bangle",
    "18k solid gold ring",
    "hallmarked solid gold chain",
    "pure gold jewellery tanishq",
    "916 gold jewelry necklace",
    "solid gold earrings 22k",
    "real gold bracelet close up",
    "real gold jewelry India",
    "gold jewellery set bridal",
]

PLATED_QUERIES = [
    "gold plated jewelry necklace",
    "gold plated fashion bracelet",
    "imitation gold jewelry artificial",
    "gold plated ring earrings fashion",
    "gold filled jewelry chain",
    "artificial jewellery gold plated India",
    "gold plated costume jewelry",
    "gold tone plated necklace",
    "cheap gold plated jewelry",
    "fashion jewelry gold tone",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
}

def is_valid_image(data, min_size=4000):
    if len(data) < min_size:
        return False
    try:
        img = Image.open(BytesIO(data))
        img.verify()
        return True
    except Exception:
        return False

def resize_and_save(data, out_path, size=224):
    img = Image.open(BytesIO(data)).convert("RGB")
    img = img.resize((size, size), Image.LANCZOS)
    img.save(out_path, "JPEG", quality=90)

def scrape_pexels(queries, out_dir, target, label, api_key):
    if not api_key:
        print("  No Pexels key provided, skipping.")
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)
    seen = set()
    saved = 0
    headers = {**HEADERS, "Authorization": api_key}

    for query in queries:
        if saved >= target:
            break
        print(f"  Searching: {query}")
        for page in range(1, 10):
            if saved >= target:
                break
            try:
                resp = requests.get(
                    f"https://api.pexels.com/v1/search?query={query}&per_page=40&page={page}",
                    headers=headers, timeout=10
                )
                photos = resp.json().get("photos", [])
                if not photos:
                    break
                for photo in photos:
                    if saved >= target:
                        break
                    img_url = photo.get("src", {}).get("large", "")
                    if not img_url:
                        continue
                    try:
                        r = requests.get(img_url, timeout=15, headers=HEADERS)
                        img_data = r.content
                        if not is_valid_image(img_data):
                            continue
                        h = hashlib.md5(img_data).hexdigest()
                        if h in seen:
                            continue
                        seen.add(h)
                        resize_and_save(img_data, out_dir / f"{label}_{saved:04d}.jpg")
                        saved += 1
                        print(f"  [{label}] {saved}/{target}", end="\r")
                    except Exception:
                        continue
                time.sleep(0.3)
            except Exception as e:
                print(f"\n  Error: {e}")
                break

    print(f"\n  Done [{label}]: {saved} images saved to {out_dir}")
    return saved

def scrape_ddg(queries, out_dir, target, label):
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
            return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    seen = set()
    saved = 0

    for query in queries:
        if saved >= target:
            break
        print(f"  DDG: {query}")
        try:
            time.sleep(random.uniform(3, 5))
            with DDGS() as ddgs:
                results = list(ddgs.images(query, max_results=40))
        except Exception as e:
            print(f"    Skipped: {e}")
            continue

        for r in results:
            if saved >= target:
                break
            url = r.get("image", "")
            if not url:
                continue
            try:
                resp = requests.get(url, timeout=8, headers=HEADERS)
                data = resp.content
                if not is_valid_image(data):
                    continue
                h = hashlib.md5(data).hexdigest()
                if h in seen:
                    continue
                seen.add(h)
                resize_and_save(data, out_dir / f"{label}_ddg{saved:04d}.jpg")
                saved += 1
                print(f"  [{label}] {saved}/{target}", end="\r")
            except Exception:
                continue

    return saved

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--solid", type=int, default=200)
    ap.add_argument("--plated", type=int, default=200)
    ap.add_argument("--out", default="ml/synthetic/images")
    ap.add_argument("--pexels-key", default=None)
    args = ap.parse_args()

    base = Path(args.out)
    print(f"\nGoldeye Dataset Scraper")
    print(f"Target : {args.solid} solid + {args.plated} plated")
    print(f"Output : {base.resolve()}\n")

    # Pexels first (most reliable)
    n_solid = scrape_pexels(SOLID_QUERIES, base / "solid", args.solid, "solid", args.pexels_key)
    # Top up with DDG if needed
    if n_solid < args.solid:
        print(f"\n  Topping up solid with DDG ({args.solid - n_solid} more needed)...")
        n_solid += scrape_ddg(SOLID_QUERIES, base / "solid", args.solid - n_solid, "solid")

    n_plated = scrape_pexels(PLATED_QUERIES, base / "plated", args.plated, "plated", args.pexels_key)
    if n_plated < args.plated:
        print(f"\n  Topping up plated with DDG ({args.plated - n_plated} more needed)...")
        n_plated += scrape_ddg(PLATED_QUERIES, base / "plated", args.plated - n_plated, "plated")

    print(f"\n{'='*50}")
    print(f"  COMPLETE")
    print(f"  solid/  -> {n_solid} images")
    print(f"  plated/ -> {n_plated} images")
    print(f"  Total   -> {n_solid + n_plated} images")
    print(f"\n  Train:")
    print(f"  python train_convnext.py --data_dir {args.out} --epochs 10 --export")
    print(f"{'='*50}\n")

if __name__ == "__main__":
    main()