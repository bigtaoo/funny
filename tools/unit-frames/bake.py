"""Bake a battle unit's animation clips into one frame sheet, from warped whole drawings or a
posed cutout rig (rig.py).
usage: python bake.py <spec.json> [--debug <clip> <out.png>] [--preview <out.png>]

Battle units are 46-81 design px tall, too small for a bone rig to read; what reads is the
silhouette and its whole-body motion. So every clip warps one complete drawing (no cut parts,
no seams) with soft-edged deformers, and the frames are shrunk to game size and packed into
one sheet. Ported from D:/standing tools/bake_mob.py; see design/product/art-direction.md §4.3.

spec.json (coordinates are pixels of the cut-out source, times are clip phase 0..1):
  {
    "out": "../../../client/src/assets/units/frames/mara",   # writes <out>.png + <out>.json
    "height": 120,              # sheet px from ground to crown of a standing figure
    "screenHeight": 46,         # design px the unit is drawn at (unitSize.ts), for the outline
    "colors": 256,              # optional: save the sheet as a palette PNG
    "points": {"hit": [0, -0.55]},   # attachment points, in figure heights from the ground
    "sources": {
      "base": {"file": "mara.png", "ground": [x, y], "crown": y}
    },
    "clips": {
      "walk": {
        "source": "base", "frames": 10, "fps": 12, "loop": true,
        "body": {"dy": f, "dx": f, "sx": f, "sy": f, "rot": f, "alpha": f},  # about ground
        "deform": [
          {"type": "rotate", "region": R, "pivot": [x, y], "angle": f},  # degrees, cw
          {"type": "move", "region": R, "dx": f, "dy": f},
          {"type": "wave", "region": R, "root": [x, y], "dir": [ux, uy],
           "length": px, "wavelength": px, "amp": f, "cycles": n}
        ]
      }
    }
  }
R is an ellipse {"c": [x, y], "r": [rx, ry], "a": degrees cw, "feather": 0..1}: the deformer acts fully inside
and fades out over the outer `feather` fraction of the radius. f is a number,
{"sin": amp, "phase": p, "bias": b, "cycles": n} or {"keys": [[t, v], ...]} (cosine-eased; a
looping clip wraps its keys, a one-shot clip holds the first and last value).
A one-shot clip samples t = i / (frames - 1) so its last frame is the end pose.

A source with "parts" instead of "file" is a cutout rig; its clips are keyframed poses rendered
by rig.py (see that file for the format). Both kinds share the outline, trim and packing below.
"""
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from cutout import cutout  # noqa: E402
import rig  # noqa: E402

SUPER = 2          # warp at this multiple of the output size, then shrink (anti-aliasing)
PACK_W = 1024      # sheet width
GAP = 6            # transparent px between packed frames (no bleed into mipmap levels)
OUTLINE_GAP_PX = 1.0     # screen px, matches client/src/render/stickman/constants.ts
OUTLINE_WIDTH_PX = 2.4


def value(f, t, loop=True):
    if isinstance(f, (int, float)):
        return float(f)
    if "sin" in f:
        return f.get("bias", 0) + f["sin"] * math.sin(2 * math.pi * (f.get("cycles", 1) * t + f.get("phase", 0)))
    keys = sorted(f["keys"])
    if loop:
        keys = [[k[0] - 1, k[1]] for k in keys[-1:]] + keys + [[k[0] + 1, k[1]] for k in keys[:1]]
    else:
        if t <= keys[0][0]:
            return keys[0][1]
        if t >= keys[-1][0]:
            return keys[-1][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            s = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return v0 + (v1 - v0) * (1 - math.cos(math.pi * s)) / 2
    return keys[0][1]


def weight(region, x, y):
    cx, cy = region["c"]
    rx, ry = region["r"]
    dx, dy = x - cx, y - cy
    if region.get("a"):   # the ellipse is turned this many degrees clockwise
        a = math.radians(region["a"])
        dx, dy = dx * math.cos(a) + dy * math.sin(a), -dx * math.sin(a) + dy * math.cos(a)
    r = np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    f = max(region.get("feather", 0.3), 1e-3)
    s = np.clip((1 - r) / f, 0, 1)
    return s * s * (3 - 2 * s)


def inverse(d, t, loop, x, y):
    """Where the pixel now at (x, y) came from, before deformer d."""
    w = weight(d["region"], x, y)
    kind = d["type"]
    if kind == "rotate":
        px, py = d["pivot"]
        a = -math.radians(value(d["angle"], t, loop)) * w
        c, s = np.cos(a), np.sin(a)
        return px + (x - px) * c - (y - py) * s, py + (x - px) * s + (y - py) * c
    if kind == "move":
        return x - w * value(d.get("dx", 0), t, loop), y - w * value(d.get("dy", 0), t, loop)
    if kind == "wave":
        ux, uy = d["dir"]
        n = math.hypot(ux, uy)
        ux, uy = ux / n, uy / n
        rx, ry = d["root"]
        along = np.clip(((x - rx) * ux + (y - ry) * uy) / d["length"], 0, 1)
        off = value(d["amp"], t, loop) * along * np.sin(
            2 * math.pi * (d.get("cycles", 1) * t - along * d["length"] / d["wavelength"]))
        return x + w * off * uy, y - w * off * ux
    raise ValueError(f"unknown deformer {kind}")


def scaled(d, k):
    """Deformer d with every source-pixel quantity multiplied by k."""
    d = json.loads(json.dumps(d))
    d["region"]["c"] = [v * k for v in d["region"]["c"]]
    d["region"]["r"] = [v * k for v in d["region"]["r"]]
    for key in ("pivot", "root"):
        if key in d:
            d[key] = [v * k for v in d[key]]
    for key in ("dx", "dy", "amp"):
        if key in d:
            d[key] = scale_f(d[key], k)
    for key in ("length", "wavelength"):
        if key in d:
            d[key] *= k
    return d


def scale_f(f, k):
    if isinstance(f, (int, float)):
        return f * k
    f = dict(f)
    if "sin" in f:
        f["sin"] *= k
        f["bias"] = f.get("bias", 0) * k
    else:
        f["keys"] = [[t, v * k] for t, v in f["keys"]]
    return f


def load_source(base, src):
    if "parts" in src:
        return rig.load(base, src)
    path = os.path.join(base, src["file"])
    im = Image.open(path)
    if im.mode == "RGBA" and np.array(im)[:, :, 3].min() < 10:
        im = im.crop(im.getbbox())          # already cut out
    else:
        im = cutout(path)
    return im


def premultiplied(im):
    a = np.array(im).astype(np.float32) / 255
    a[:, :, :3] *= a[:, :, 3:]
    return a


def bake_clip(clip, src_im, src, height):
    """Frames of one clip as premultiplied float RGBA arrays at output scale, plus each frame's
    ground anchor inside its array."""
    k_out = height / (src["ground"][1] - src["crown"])       # source px -> sheet px
    k = min(1.0, k_out * SUPER)                               # source px -> work px
    work = src_im.resize((round(src_im.width * k), round(src_im.height * k)), Image.LANCZOS)
    a = premultiplied(work)
    pad = round(max(a.shape[:2]) * 1.0)   # room for a whole-body fall
    H, W = a.shape[0] + 2 * pad, a.shape[1] + 2 * pad
    canvas = np.zeros((H, W, 4), np.float32)
    canvas[pad:pad + a.shape[0], pad:pad + a.shape[1]] = a
    gx, gy = src["ground"][0] * k + pad, src["ground"][1] * k + pad
    deform = []
    for d in clip.get("deform", []):
        d = scaled(d, k)
        d["region"]["c"] = [d["region"]["c"][0] + pad, d["region"]["c"][1] + pad]
        for key in ("pivot", "root"):
            if key in d:
                d[key] = [d[key][0] + pad, d[key][1] + pad]
        deform.append(d)

    loop = clip.get("loop", True)
    n = clip["frames"]
    body = clip.get("body", {})
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    shrink = k_out / k
    out = []
    for i in range(n):
        t = i / n if loop else (i / (n - 1) if n > 1 else 0)
        sx, sy = value(body.get("sx", 1), t, loop), value(body.get("sy", 1), t, loop)
        dx = value(body.get("dx", 0), t, loop) * k
        dy = value(body.get("dy", 0), t, loop) * k
        rot = math.radians(value(body.get("rot", 0), t, loop))
        alpha = value(body.get("alpha", 1), t, loop)
        # invert the body transform: translate, then rotate about the ground, then scale
        x0, y0 = xs - gx - dx, ys - gy - dy
        c, s = math.cos(-rot), math.sin(-rot)
        x1, y1 = x0 * c - y0 * s, x0 * s + y0 * c
        x, y = gx + x1 / sx, gy + y1 / sy
        for d in reversed(deform):
            x, y = inverse(d, t, loop, x, y)
        warped = cv2.remap(canvas, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        fw, fh = round(W * shrink), round(H * shrink)
        f = cv2.resize(warped, (fw, fh), interpolation=cv2.INTER_AREA) * alpha
        out.append((f, (gx * shrink, gy * shrink)))
    return out


def outline(f, gap, width):
    """White detached contour around frame f's silhouette (premultiplied RGBA)."""
    mask = (f[:, :, 3] > 0.35).astype(np.uint8)
    pad = math.ceil(gap + width) + 2
    mask = cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    dist = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5)
    ring = np.clip(np.minimum(dist - gap, gap + width - dist) + 0.5, 0, 1).astype(np.float32)
    ring = ring[pad:-pad, pad:-pad]
    o = np.zeros_like(f)
    o[:, :, :3] = ring[:, :, None]
    o[:, :, 3] = ring
    return o


def trim(f):
    ys, xs = np.nonzero(f[:, :, 3] > 1 / 255)
    if len(xs) == 0:
        return f[:1, :1], 0, 0
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return f[y0:y1, x0:x1], x0, y0


def bake(spec, base):
    height = spec["height"]
    k_screen = height / spec["screenHeight"]
    sources = {name: load_source(base, s) for name, s in spec["sources"].items()}
    images, meta_clips = [], {}
    for name, clip in spec["clips"].items():
        src = spec["sources"][clip["source"]]
        frames = []
        if "parts" in src:
            baked = rig.bake_clip(clip, sources[clip["source"]], src, height, SUPER)
        else:
            baked = bake_clip(clip, sources[clip["source"]], src, height)
        for f, (ax, ay) in baked:
            if f.shape[0] < 2:
                continue
            ring = outline(f, OUTLINE_GAP_PX * k_screen, OUTLINE_WIDTH_PX * k_screen)
            body, bx, by = trim(f)
            line, lx, ly = trim(ring)
            frames.append({"body": len(images), "line": len(images) + 1})
            images.append((body, bx - ax, by - ay))
            images.append((line, lx - ax, ly - ay))
        meta_clips[name] = {"fps": clip["fps"], "loop": clip.get("loop", True), "frames": frames}
        for key in ("hitAt",):
            if key in clip:
                meta_clips[name][key] = clip[key]

    # shelf-pack, tallest first
    order = sorted(range(len(images)), key=lambda i: -images[i][0].shape[0])
    rects = [None] * len(images)
    x = y = shelf = 0
    for i in order:
        h, w = images[i][0].shape[:2]
        if x + w > PACK_W:
            x, y, shelf = 0, y + shelf + GAP, 0
        rects[i] = (x, y, w, h)
        x += w + GAP
        shelf = max(shelf, h)
    sheet_h = 1 << math.ceil(math.log2(y + shelf))
    sheet = np.zeros((sheet_h, PACK_W, 4), np.float32)
    for (img, _, _), (x, y, w, h) in zip(images, rects):
        sheet[y:y + h, x:x + w] = img
    alpha = sheet[:, :, 3:]
    sheet[:, :, :3] = np.where(alpha > 1e-4, sheet[:, :, :3] / np.maximum(alpha, 1e-4), 0)
    out = Image.fromarray((np.clip(sheet, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")

    rect = lambda i: [*rects[i], round(images[i][1], 1), round(images[i][2], 1)]  # noqa: E731
    for clip in meta_clips.values():
        clip["frames"] = [{"body": rect(f["body"]), "line": rect(f["line"])} for f in clip["frames"]]
    meta = {
        "version": 1,
        # frame rects are [x, y, w, h, offsetX, offsetY]; the offset places the rect's top-left
        # relative to the figure's ground point
        "height": height,
        "points": spec.get("points", {}),
        "shadow": spec.get("shadow", [0.32, 0.09]),
        "clips": meta_clips,
    }
    return out, meta


def debug_overlay(spec, base, clip_name, path):
    """The clip's source with every deformer region drawn on it, for placing regions."""
    clip = spec["clips"][clip_name]
    src = spec["sources"][clip["source"]]
    im = load_source(base, src)
    bg = Image.new("RGBA", im.size, (90, 120, 90, 255))
    bg.alpha_composite(im)
    a = np.array(bg)
    for i, d in enumerate(clip.get("deform", [])):
        rg = d["region"]
        colour = [(255, 60, 60), (60, 160, 255), (255, 220, 0), (255, 0, 255), (0, 255, 200)][i % 5]
        c = tuple(int(v) for v in rg["c"])
        cv2.ellipse(a, c, tuple(int(v) for v in rg["r"]), rg.get("a", 0), 0, 360, (*colour, 255), 3)
        p = d.get("pivot", d.get("root"))
        if p:
            cv2.circle(a, tuple(int(v) for v in p), 8, (*colour, 255), -1)
        cv2.putText(a, str(i), c, cv2.FONT_HERSHEY_SIMPLEX, 1.6, (*colour, 255), 4)
    cv2.circle(a, tuple(int(v) for v in src["ground"]), 10, (255, 255, 255, 255), -1)
    cv2.line(a, (0, int(src["crown"])), (a.shape[1], int(src["crown"])), (255, 255, 255, 255), 2)
    Image.fromarray(a).save(path)


def preview(sheet, meta, path, scales=(1.0, 0.5)):
    """Every clip's frames in a row on paper, at sheet size and at roughly game size."""
    rows = []
    for scale in scales:
        for name, clip in meta["clips"].items():
            cells = []
            for fr in clip["frames"]:
                x, y, w, h, ox, oy = fr["body"]
                cells.append((sheet.crop((x, y, x + w, y + h)), ox, oy))
            minx = min(ox for _, ox, _ in cells)
            miny = min(oy for _, _, oy in cells)
            maxx = max(ox + c.width for c, ox, _ in cells)
            maxy = max(oy + c.height for c, _, oy in cells)
            cw, ch = int(maxx - minx) + 8, int(maxy - miny) + 8
            row = Image.new("RGBA", (cw * len(cells), ch), (243, 236, 220, 255))
            for i, (c, ox, oy) in enumerate(cells):
                row.alpha_composite(c, (int(i * cw + ox - minx + 4), int(oy - miny + 4)))
            if scale != 1.0:
                row = row.resize((max(1, int(row.width * scale)), max(1, int(row.height * scale))), Image.LANCZOS)
            rows.append(row)
    W = max(r.width for r in rows)
    H = sum(r.height + 6 for r in rows)
    board = Image.new("RGBA", (W, H), (200, 200, 200, 255))
    y = 0
    for r in rows:
        board.alpha_composite(r, (0, y))
        y += r.height + 6
    board.save(path)


def gif(sheet, meta, path, height):
    """Each clip played once after another at `height` px figure height, on paper, for review."""
    k = height / meta["height"]
    cells = []
    for name, clip in meta["clips"].items():
        reps = 3 if clip["loop"] else 1
        for _ in range(reps):
            for fr in clip["frames"]:
                cells.append((fr["body"], 1000 / clip["fps"]))
        if not clip["loop"]:
            cells.append((clip["frames"][-1]["body"], 600))
    W, H = int(height * 2.4), int(height * 1.5)
    gx, gy = W * 0.5, H * 0.85
    out, durs = [], []
    for (x, y, w, h, ox, oy), dur in cells:
        im = sheet.crop((x, y, x + w, y + h))
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
        board = Image.new("RGBA", (W, H), (243, 236, 220, 255))
        board.alpha_composite(im, (round(gx + ox * k), round(gy + oy * k)))
        out.append(board.convert("RGB"))
        durs.append(round(dur))
    out[0].save(path, save_all=True, append_images=out[1:], duration=durs, loop=0)


if __name__ == "__main__":
    spec_path = sys.argv[1]
    base = os.path.dirname(os.path.abspath(spec_path))
    with open(spec_path, encoding="utf-8") as fh_:
        spec = json.load(fh_)
    if "--debug" in sys.argv:
        i = sys.argv.index("--debug")
        debug_overlay(spec, base, sys.argv[i + 1], sys.argv[i + 2])
        sys.exit()
    sheet, meta = bake(spec, base)
    out = os.path.normpath(os.path.join(base, spec["out"]))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if spec.get("colors"):
        # watercolour survives a palette at game size; FASTOCTREE is the PIL quantizer that keeps alpha
        sheet.quantize(spec["colors"], method=Image.Quantize.FASTOCTREE,
                       dither=Image.Dither.FLOYDSTEINBERG).save(out + ".png", optimize=True)
    else:
        sheet.save(out + ".png", optimize=True)
    with open(out + ".json", "w", encoding="utf-8") as fh_:
        json.dump(meta, fh_, separators=(",", ":"))
    if "--preview" in sys.argv:
        p = sys.argv[sys.argv.index("--preview") + 1]
        preview(sheet, meta, p)
        gif(sheet, meta, p.rsplit(".", 1)[0] + ".gif", spec["screenHeight"] * 2)
    n = sum(len(c["frames"]) for c in meta["clips"].values())
    print(f"{out}.png {sheet.width}x{sheet.height} ({os.path.getsize(out + '.png') // 1024} KB), {n} frames")
