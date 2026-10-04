"""Split a standing character sheet into cutout-animation parts.
usage: python split_parts.py <spec.json> <out dir>

spec.json:
  {
    "source": "hero_apose.png",           # relative to the spec file
    "background": [[[x, y], ...], ...],   # optional: enclosed paper to treat as background
    "outline": {"width": 7, "rgb": [r, g, b]},  # optional: line redrawn along filled edges
    "parts": [                            # listed back to front
      {"name": "arm_r",
       "poly": [[x, y], ...],             # region of the source that belongs to this part
       "stroke": {"line": [[x, y], ...], "width": w},  # optional: thick polyline, added
       "discs": [[x, y, r], ...],         # optional: round joint caps, added (see below)
       "hsv": [[h, s, v], [h, s, v]],     # optional: keep only pixels in this OpenCV HSV
       "grow": 6,                         #   range, grown into dark outline pixels by this many px
       "exclude": [[[x, y], ...], ...],   # optional: areas removed from the part
       "exclude_parts": ["skirt"],        # optional: pixels owned by other parts, removed
       "open": 7,                         # optional: drop strokes thinner than this many px
                                          #   (e.g. a bowstring the rig draws itself)
       "hidden": [[[x, y], ...], ...],    # optional: areas covered by other parts, filled in;
                                          #   an entry may be {"poly": [...], "clone": [dx, dy]}
                                          #   to copy the part's own texture from that offset
       "pivot": [x, y]}                   # joint position in source pixels
    ]
  }

A limb cut flat at a joint shows the cut's corners as soon as the joint bends. Instead, cut
both limbs at the pivot and give each a disc of the limb's half-width centred on the pivot:
the two discs hold the same pixels, so the joint stays one round knee / elbow at any angle.

Every part keeps only foreground pixels (see cutout.background_mask). Hidden areas are
filled by OpenCV inpainting so a part still looks whole when a joint rotates.
Writes <name>.png per part, parts.json (size, pivot and source offset per part, so the rig
can rebuild the rest pose) and preview.png (the parts re-assembled over a checkerboard).
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from cutout import background_mask  # noqa: E402

PAD = 4  # transparent margin around each exported part
SPECK = 300  # px; smaller detached islands are dropped from a part
DARK = 80  # HSV value below this counts as outline, not paint
OUTLINE = 7  # px of outline redrawn along filled edges (default; matches Lena's source art)
OUTLINE_RGB = (28, 20, 16)


def poly_mask(size, polys):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    for p in polys:
        d.polygon([tuple(v) for v in p], fill=255)
    return m


def region_mask(src, hsv, part):
    """Pixels a part claims before other parts are subtracted (uint8 array, 0 or 255)."""
    m = poly_mask(src.size, [part["poly"]] if "poly" in part else [])
    if "stroke" in part:
        d = ImageDraw.Draw(m)
        pts = [tuple(v) for v in part["stroke"]["line"]]
        w = part["stroke"]["width"]
        d.line(pts, fill=255, width=w)
        for x, y in pts:  # round joints
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=255)
    if "discs" in part:
        d = ImageDraw.Draw(m)
        for x, y, r in part["discs"]:
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    m = np.array(m)
    if "hsv" in part:
        lo, hi = (np.array(v, np.uint8) for v in part["hsv"])
        keep = cv2.inRange(hsv, lo, hi)
        g = part.get("grow", 0)
        if g:
            # grow only into dark pixels, i.e. take the part's own outline but no neighbour paint
            grown = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * g + 1,) * 2))
            keep = np.maximum(keep, np.minimum(grown, (hsv[..., 2] < DARK).astype(np.uint8) * 255))
        m = np.minimum(m, keep)
    m = np.minimum(m, np.array(poly_mask(src.size, part.get("exclude", []))) ^ 255)
    return m


def opened(mask, k):
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))


def split(spec_path, out_dir):
    spec = json.load(open(spec_path, encoding="utf-8"))
    raw = Image.open(os.path.join(os.path.dirname(spec_path), spec["source"]))
    src = raw.convert("RGB")
    if raw.mode == "RGBA" and np.array(raw)[..., 3].min() < 10:
        fg = np.array(raw)[..., 3].copy()    # already cut out: its alpha is the foreground
    else:
        fg = np.array(ImageChops.invert(background_mask(src)))
    rgb = np.array(src)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    # paper enclosed by the figure (e.g. between an arm and the body) is not border-connected,
    # so the spec marks those spots; light grey pixels inside them become background
    paper = (hsv[..., 1] < 30) & (hsv[..., 2] > 200)
    fg[(np.array(poly_mask(src.size, spec.get("background", []))) > 0) & paper] = 0
    line_w = spec.get("outline", {}).get("width", OUTLINE)
    line_rgb = spec.get("outline", {}).get("rgb", OUTLINE_RGB)
    owned = {p["name"]: np.minimum(region_mask(src, hsv, p), fg) for p in spec["parts"]}
    os.makedirs(out_dir, exist_ok=True)
    meta, layers = [], []
    for part in spec["parts"]:
        own = owned[part["name"]]
        for other in part.get("exclude_parts", []):
            own = np.minimum(own, owned[other] ^ 255)
        if "open" in part:
            own = opened(own, part["open"])
        # hidden areas are covered by other parts at rest, so they never reach past the
        # silhouette
        entries = [h if isinstance(h, dict) else {"poly": h} for h in part.get("hidden", [])]
        hidden = np.minimum(np.array(poly_mask(src.size, [h["poly"] for h in entries])), fg)
        rgba = rgb.copy()
        alpha = np.maximum(own, hidden)
        fill = (hidden > 0) & (own <= 200)
        if fill.any():
            # paint from the part's own colours only (not its outline), so neither paper,
            # neighbouring parts nor smeared black lines bleed in
            known = (own > 200) & (hsv[..., 2] >= DARK)
            painted = cv2.inpaint(rgba, (~known).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
            rgba[fill] = painted[fill]
            # inpainting smears a large area into a flat grey; where the spec names an offset,
            # tile the part's own paint from there instead (chain mail stays chain mail)
            for h in entries:
                if "clone" not in h:
                    continue
                todo = fill & (np.array(poly_mask(src.size, [h["poly"]])) > 0)
                ys, xs = np.nonzero(todo)
                dx, dy = h["clone"]
                for step in range(1, 6):
                    if not len(ys):
                        break
                    sx, sy = xs + step * dx, ys + step * dy
                    ok = (sx >= 0) & (sx < src.width) & (sy >= 0) & (sy < src.height)
                    ok[ok] = known[sy[ok], sx[ok]]
                    rgba[ys[ok], xs[ok]] = rgb[sy[ok], sx[ok]]
                    ys, xs = ys[~ok], xs[~ok]
            # where the filled area becomes the part's edge, draw the sticker outline again
            solid = (alpha > 127).astype(np.uint8)
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * line_w + 1,) * 2)
            ring = (solid > 0) & (cv2.erode(solid, k) == 0) & fill
            rgba[ring] = line_rgb
        # drop specks a cut leaves behind (a neighbour's sliver, a fleck of shading), which
        # would otherwise float off the part once it moves
        n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 127).astype(np.uint8))
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] < SPECK:
                alpha[labels == i] = 0
        im = Image.fromarray(np.dstack([rgba, alpha]).astype(np.uint8), "RGBA")
        x0, y0, x1, y1 = im.getbbox()
        x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
        x1, y1 = min(src.width, x1 + PAD), min(src.height, y1 + PAD)
        im = im.crop((x0, y0, x1, y1))
        im.save(os.path.join(out_dir, part["name"] + ".png"), optimize=True)
        px, py = part["pivot"]
        meta.append({
            "name": part["name"],
            "w": im.width, "h": im.height,
            "x": x0, "y": y0,                   # top-left in source pixels
            "anchorX": round((px - x0) / im.width, 4),
            "anchorY": round((py - y0) / im.height, 4),
            "pivot": [px, py],
        })
        layers.append((im, x0, y0, px, py))
    json.dump({"source": spec["source"], "parts": meta},
              open(os.path.join(out_dir, "parts.json"), "w"), indent=2)
    preview(src.size, layers).save(os.path.join(out_dir, "preview.png"))


def preview(size, layers):
    w, h = size
    m = 120  # margin so the exploded view never lands at a negative offset
    board = Image.new("RGBA", (w * 2, h + 2 * m), (255, 255, 255, 255))
    d = ImageDraw.Draw(board)
    for y in range(0, h + 2 * m, 32):
        for x in range(0, w * 2, 32):
            if (x // 32 + y // 32) % 2:
                d.rectangle([x, y, x + 31, y + 31], fill=(210, 210, 210, 255))
    # left: rest pose; right: exploded view so seams and inpainting are visible
    cx = sum(l[3] for l in layers) / len(layers)
    cy = sum(l[4] for l in layers) / len(layers)
    for im, x0, y0, px, py in layers:
        board.alpha_composite(im, (x0, y0 + m))
        ex, ey = (px - cx) * 0.35, (py - cy) * 0.35
        board.alpha_composite(im, (int(x0 + w + ex), int(y0 + m + ey)))
    for _, _, _, px, py in layers:
        d.ellipse([px - 5, py + m - 5, px + 5, py + m + 5], outline=(255, 0, 0, 255), width=2)
    return board


if __name__ == "__main__":
    split(sys.argv[1], sys.argv[2])
