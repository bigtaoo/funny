"""Cutout rig renderer for bake.py: poses split_parts.py parts with forward kinematics and
renders every frame of a clip, so a clip can bend knees, cross legs and swing a weapon instead of
warping one flat drawing.

A rig source in the bake spec:
  "sources": {"rig": {
    "parts": "parts/parts.json",          # split_parts.py output (listed back to front)
    "ground": [x, y], "crown": y,          # source px, as for a drawing source
    "parent": {"shin_b": "thigh_b", ...},  # missing / null = child of the body root
    "order": ["shin_b", ...],              # optional draw order override, back to front
    "soles": [["boot_b", [x, y]], ...]     # source px points that can touch the ground
  }}

A rig clip:
  {"source": "rig", "frames": 10, "fps": 12, "loop": true,
   "interp": "spline" | "ease",            # spline: Catmull-Rom through the keys (default for
                                           #   loops); ease: cubic in-out per segment
   "plant": true,                          # lift / drop the body so the lowest sole is at its
                                           #   rest height (gives the walk bob for free)
   "keys": [{"t": 0, "ease": "out", "pose": {"thigh_b": 20, "shield.x": 30, "dy": -4}}, ...]}

Pose channels: "<part>" = rotation in degrees (clockwise on screen) about the part's pivot,
"<part>.x" / "<part>.y" = shift in source px in the parent's frame, and the body channels
"dx", "dy", "rot" (about the ground point), "sx", "sy", "alpha". A channel a key leaves out is
interpolated between the keys that set it; a channel no key sets stays at rest.
"""
import json
import math
import os

import cv2
import numpy as np
from PIL import Image

BODY = {"dx": 0.0, "dy": 0.0, "rot": 0.0, "sx": 1.0, "sy": 1.0, "alpha": 1.0}


def load(base, src):
    path = os.path.join(base, src["parts"])
    meta = json.load(open(path, encoding="utf-8"))
    d = os.path.dirname(path)
    parts = {}
    for p in meta["parts"]:
        im = Image.open(os.path.join(d, p["name"] + ".png")).convert("RGBA")
        parts[p["name"]] = {**p, "image": im}
    order = src.get("order", [p["name"] for p in meta["parts"]])
    w = max(p["x"] + p["w"] for p in meta["parts"])
    h = max(p["y"] + p["h"] for p in meta["parts"])
    return {"parts": parts, "order": order, "size": (w, h)}


# ── interpolation ────────────────────────────────────────────────────────────────────────

def ease(u, kind):
    if kind == "linear":
        return u
    if kind == "hold":
        return 0.0
    if kind == "in":
        return u * u * u
    if kind == "out":
        return 1 - (1 - u) ** 3
    return u * u * (3 - 2 * u) if kind == "smooth" else (4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2)


def catmull(p0, p1, p2, p3, u):
    return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                  + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u)


def channel(keys, name, t, loop, interp, rest):
    pts = [(k["t"], k["pose"][name], k.get("ease")) for k in keys if name in k.get("pose", {})]
    if not pts:
        return rest
    if len(pts) == 1:
        return pts[0][1]
    ts = [p[0] for p in pts]
    if loop:
        # one virtual key on each side so the cycle closes smoothly
        pts = [(pts[-1][0] - 1, pts[-1][1], pts[-1][2])] + pts + [(pts[0][0] + 1, pts[0][1], pts[0][2]),
                                                                  (pts[1][0] + 1, pts[1][1], pts[1][2])]
        if t < ts[0]:
            t += 1
    else:
        if t <= ts[0]:
            return pts[0][1]
        if t >= ts[-1]:
            return pts[-1][1]
        pts = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(pts) - 2):
        (t1, v1, e1), (t2, v2, _) = pts[i], pts[i + 1]
        if t1 <= t <= t2:
            u = (t - t1) / (t2 - t1) if t2 > t1 else 0
            if interp == "spline" and e1 is None:
                return catmull(pts[i - 1][1], v1, v2, pts[i + 2][1], u)
            return v1 + (v2 - v1) * ease(u, e1 or "inout")
    return pts[-2][1]


def pose_at(clip, t):
    keys = clip["keys"]
    loop = clip.get("loop", True)
    interp = clip.get("interp", "spline" if loop else "ease")
    names = {n for k in keys for n in k.get("pose", {})}
    return {n: channel(keys, n, t, loop, interp, BODY.get(n, 0.0)) for n in names}


# ── forward kinematics ───────────────────────────────────────────────────────────────────

def affine(a, b):
    """a ∘ b for 2x3 affine matrices."""
    A = np.vstack([a, [0, 0, 1]])
    B = np.vstack([b, [0, 0, 1]])
    return (A @ B)[:2]


def about(px, py, deg, tx=0.0, ty=0.0):
    """Rotate `deg` clockwise (screen) about (px, py), then shift by (tx, ty)."""
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return np.array([[c, -s, px - c * px + s * py + tx],
                     [s, c, py - s * px - c * py + ty]], np.float64)


def world(rig, src, pose):
    """2x3 source-to-source transform per part, before the body transform."""
    parent = src.get("parent", {})
    out = {}

    def solve(name):
        if name in out:
            return out[name]
        p = rig["parts"][name]
        local = about(*p["pivot"], pose.get(name, 0.0), pose.get(name + ".x", 0.0), pose.get(name + ".y", 0.0))
        up = parent.get(name)
        out[name] = affine(solve(up), local) if up else local
        return out[name]

    for n in rig["parts"]:
        solve(n)
    return out


def apply(m, x, y):
    return m[0, 0] * x + m[0, 1] * y + m[0, 2], m[1, 0] * x + m[1, 1] * y + m[1, 2]


def body_matrix(src, pose, plant_dy):
    gx, gy = src["ground"]
    sx, sy = pose.get("sx", 1.0), pose.get("sy", 1.0)
    scale = np.array([[sx, 0, gx - sx * gx], [0, sy, gy - sy * gy]], np.float64)
    turn = about(gx, gy, pose.get("rot", 0.0), pose.get("dx", 0.0), pose.get("dy", 0.0) + plant_dy)
    return affine(turn, scale)


# ── rendering ────────────────────────────────────────────────────────────────────────────

def premultiplied(im):
    a = np.asarray(im).astype(np.float32) / 255
    a[:, :, :3] *= a[:, :, 3:]
    return a


def bake_clip(clip, rig, src, height, super_):
    """Like bake.bake_clip: premultiplied frames at output scale plus each frame's ground point."""
    k_out = height / (src["ground"][1] - src["crown"])
    k = min(1.0, k_out * super_)
    W0, H0 = rig["size"]
    pad = round(max(W0, H0) * k * 1.0)
    W, H = round(W0 * k) + 2 * pad, round(H0 * k) + 2 * pad
    to_canvas = np.array([[k, 0, pad], [0, k, pad]], np.float64)
    gx, gy = src["ground"][0] * k + pad, src["ground"][1] * k + pad
    # shrink each part once with a proper filter; the per-frame warp then only rotates
    images = {n: premultiplied(p["image"].resize((max(1, round(p["w"] * k)), max(1, round(p["h"] * k))),
                                                 Image.LANCZOS))
              for n, p in rig["parts"].items()}
    soles = src.get("soles", [])

    loop = clip.get("loop", True)
    n = clip["frames"]
    shrink = k_out / k
    out = []
    for i in range(n):
        t = i / n if loop else (i / (n - 1) if n > 1 else 0)
        pose = pose_at(clip, t)
        fk = world(rig, src, pose)
        plant = 0.0
        if clip.get("plant") and soles:
            body0 = body_matrix(src, pose, 0.0)
            # each sole may sit at its own rest height (a 3/4 view puts the far foot higher), so
            # the body shifts until the lowest-reaching sole is back at its rest height
            plant = -max(apply(affine(body0, fk[name]), *pt)[1] - pt[1] for name, pt in soles)
        body = body_matrix(src, pose, plant)
        canvas = np.zeros((H, W, 4), np.float32)
        for name in rig["order"]:
            p = rig["parts"][name]
            im = images[name]
            # resized part px -> source px
            place = np.array([[p["w"] / im.shape[1], 0, p["x"]], [0, p["h"] / im.shape[0], p["y"]]], np.float64)
            m = affine(to_canvas, affine(body, affine(fk[name], place)))
            layer = cv2.warpAffine(im, m.astype(np.float32), (W, H), flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            canvas = layer + canvas * (1 - layer[:, :, 3:])
        f = cv2.resize(canvas, (round(W * shrink), round(H * shrink)), interpolation=cv2.INTER_AREA)
        out.append((f * pose.get("alpha", 1.0), (gx * shrink, gy * shrink)))
    return out
