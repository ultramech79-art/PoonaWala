"""
BlenderProc synthetic jewelry dataset generator.
Phase 3: 10k images (enough for LightGBM fusion + conformal calibration).
Phase 7: scale to 1M images.

Usage (run inside a BlenderProc environment):
  blenderproc run ml/synthetic/blenderproc_pipeline.py \
    --output_dir ml/synthetic/rendered \
    --n_images 10000

Requirements:
  pip install blenderproc==2.7.0
  # Blender 3.5+ installed separately; BlenderProc manages it

Output per image:
  rendered/<idx>.png         — 384×384 RGBA
  rendered/<idx>.json        — label {karat, weight_g, item_type, stone_count, lighting}
"""
import argparse
import json
import os
import random
from pathlib import Path

# ─── Item + material catalogue ────────────────────────────────────────────────

ITEM_TYPES = ["ring", "bangle", "chain", "earring"]

# CIELAB centroids per karat (approximate — Phase 7 refines with measured samples)
KARAT_CIELAB = {
    24: (85.0,  5.5, 25.0),  # pure yellow
    22: (82.0,  4.8, 24.0),
    20: (78.0,  4.2, 21.0),
    18: (74.0,  3.5, 18.0),
    14: (68.0,  2.0, 12.0),
    "plated_brass": (65.0, 3.0, 15.0),  # similar to 14K but softer sheen
    "silver_plated": (92.0, -1.0, 2.0),
}

CAMERA_POSES = [
    "top_down",       # straight down at piece + coin
    "angle_45",       # 45° tilt
    "side_view",      # nearly horizontal
    "hallmark_macro", # tight crop on stamp area
]

HDRI_NAMES = [
    "indoor_warm",
    "indoor_cool",
    "daylight_window",
    "evening_ambient",
    "fluorescent_office",
]


def render_image(
    item_type: str,
    karat,
    weight_g: float,
    pose: str,
    hdri: str,
    stone_count: int,
    output_path: str,
    label_path: str,
):
    """
    Render one synthetic image via BlenderProc.
    This function is called inside a blenderproc run context.
    """
    try:
        import blenderproc as bproc
        import numpy as np
    except ImportError:
        print("BlenderProc not available — use: blenderproc run <this_script>")
        return

    bproc.init()

    # Load parametric mesh (simplified — Phase 7 uses high-poly assets)
    mesh_map = {
        "ring":    "meshes/ring_basic.obj",
        "bangle":  "meshes/bangle_basic.obj",
        "chain":   "meshes/chain_basic.obj",
        "earring": "meshes/earring_basic.obj",
    }
    mesh_path = os.path.join(os.path.dirname(__file__), mesh_map.get(item_type, "meshes/bangle_basic.obj"))
    if not os.path.exists(mesh_path):
        print(f"Mesh not found: {mesh_path} — skipping")
        return

    objs = bproc.loader.load_obj(mesh_path)

    # Assign karat-dependent BRDF
    lab = KARAT_CIELAB.get(karat, KARAT_CIELAB[22])
    # Convert L*a*b* → approximate sRGB (rough mapping)
    r = min(1.0, lab[0] / 100 + lab[1] / 128)
    g = min(1.0, lab[0] / 100 - lab[1] / 256)
    b = min(1.0, lab[0] / 100 - lab[2] / 256)
    metallic = 0.95 if karat != "plated_brass" else 0.60
    roughness = 0.08 + random.uniform(-0.02, 0.04)

    for obj in objs:
        mat = obj.get_materials()[0]
        mat.set_principled_shader_value("Base Color", [r, g, b, 1.0])
        mat.set_principled_shader_value("Metallic", metallic)
        mat.set_principled_shader_value("Roughness", roughness)

    # ₹10 reference coin (27mm diameter)
    coin_mesh = os.path.join(os.path.dirname(__file__), "meshes/coin_rs10.obj")
    if os.path.exists(coin_mesh):
        bproc.loader.load_obj(coin_mesh)

    # Lighting
    hdri_path = os.path.join(os.path.dirname(__file__), "hdris", f"{hdri}.hdr")
    if os.path.exists(hdri_path):
        bproc.world.set_world_background_hdr_img(hdri_path)
    else:
        bproc.lighting.create_light_object(location=[2, -2, 3], energy=500)

    # Camera pose
    pose_map = {
        "top_down":      ([0, 0, 0.4], [0.0, 0.0, 0.0]),
        "angle_45":      ([0.3, -0.3, 0.35], [0.6, 0.0, 0.785]),
        "side_view":     ([0.4, 0.0, 0.1], [1.4, 0.0, 1.57]),
        "hallmark_macro":([0.05, 0.05, 0.15], [0.2, 0.0, 0.785]),
    }
    loc, rot = pose_map.get(pose, pose_map["top_down"])
    cam_pose = bproc.math.build_transformation_mat(loc, rot)
    bproc.camera.add_camera_pose(cam_pose)
    bproc.camera.set_resolution(384, 384)

    data = bproc.renderer.render()
    imgs = data["colors"]
    if imgs:
        import imageio
        imageio.imwrite(output_path, imgs[0])

    with open(label_path, "w") as f:
        json.dump({
            "karat": str(karat),
            "weight_g": weight_g,
            "item_type": item_type,
            "stone_count": stone_count,
            "pose": pose,
            "hdri": hdri,
        }, f)

    bproc.clean_up()


def generate_dataset(output_dir: str, n_images: int):
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    karat_choices = [24, 22, 22, 20, 18, 18, 14, "plated_brass"]  # weighted toward 22K

    for i in range(n_images):
        item_type  = random.choice(ITEM_TYPES)
        karat      = random.choice(karat_choices)
        weight_g   = random.uniform(3.0, 40.0)
        stone_count = random.choices([0, 1, 2, 4], weights=[60, 20, 15, 5])[0]
        pose       = random.choice(CAMERA_POSES)
        hdri       = random.choice(HDRI_NAMES)

        out_img   = os.path.join(output_dir, f"{i:06d}.png")
        out_label = os.path.join(output_dir, f"{i:06d}.json")
        render_image(item_type, karat, weight_g, pose, hdri, stone_count, out_img, out_label)

        if (i + 1) % 500 == 0:
            print(f"  Rendered {i+1}/{n_images}")

    print(f"Done. {n_images} images written to {output_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--output_dir", default="ml/synthetic/rendered")
    ap.add_argument("--n_images", type=int, default=10_000)
    args = ap.parse_args()
    generate_dataset(args.output_dir, args.n_images)
