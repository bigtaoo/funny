"""Find stray "speckle" pixels in an alpha channel.

Pure Python (no numpy) so the same code runs inside GIMP's bundled interpreter
(export_layers_cropped.py) and from the command line (despeckle.py).

An *island* is an 8-connected group of pixels with alpha > 0. Each island is
weighed by its ink mass: sum(alpha) / 255, i.e. how many fully opaque pixels it
is worth. Islands with mass >= core_mass are real content ("core"). Every other
island is a speckle, and is removed, when it is either

  - faint: its most opaque pixel is below `faint`, so nobody can see it, or
  - far:   no core pixel lies within `near` pixels of it (Chebyshev distance).

Small islands close to the core are kept: they are usually detached bits of a
stroke, and they barely move the crop box anyway.

Islands are built from horizontal runs, not pixels, so a 1500x2000 layer is
labelled in well under a second.
"""

import re
from bisect import bisect_left

DEFAULT_CORE_MASS = 64.0
DEFAULT_NEAR = 16
DEFAULT_FAINT = 24

_NONZERO = re.compile(rb'[^\x00]+')


class Island:
    __slots__ = ('runs', 'pixels', 'mass', 'max_alpha')

    def __init__(self):
        self.runs = []        # (y, x0, x1), x1 exclusive
        self.pixels = 0
        self.mass = 0.0
        self.max_alpha = 0


class SpeckleResult:
    """remove_runs: (y, x0, x1) spans to clear.
    bbox: (x0, y0, x1, y1) of what is kept (exclusive), or None if nothing is."""

    def __init__(self, remove_runs, bbox, islands, removed_islands, removed_pixels):
        self.remove_runs = remove_runs
        self.bbox = bbox
        self.islands = islands
        self.removed_islands = removed_islands
        self.removed_pixels = removed_pixels


def _find(parent, i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def find_islands(alpha, width, height):
    """Label 8-connected islands of alpha > 0. `alpha` is one byte per pixel."""
    alpha = bytes(alpha)
    runs = []
    parent = []
    prev = []
    for y in range(height):
        base = y * width
        row = alpha[base:base + width]
        cur = []
        for m in _NONZERO.finditer(row):
            i = len(runs)
            runs.append((y, m.start(), m.end()))
            parent.append(i)
            cur.append(i)
        # 8-connectivity: runs on adjacent rows touch when they overlap after
        # widening one of them by a pixel on each side.
        a = b = 0
        while a < len(prev) and b < len(cur):
            _, pa0, pa1 = runs[prev[a]]
            _, cb0, cb1 = runs[cur[b]]
            if pa0 <= cb1 and cb0 <= pa1:
                ra, rb = _find(parent, prev[a]), _find(parent, cur[b])
                if ra != rb:
                    parent[rb] = ra
            if pa1 < cb1:
                a += 1
            else:
                b += 1
        prev = cur

    by_root = {}
    for i, (y, x0, x1) in enumerate(runs):
        isl = by_root.get(_find(parent, i))
        if isl is None:
            isl = by_root[_find(parent, i)] = Island()
        isl.runs.append((y, x0, x1))
        seg = alpha[y * width + x0:y * width + x1]
        isl.pixels += x1 - x0
        isl.mass += sum(seg) / 255.0
        m = max(seg)
        if m > isl.max_alpha:
            isl.max_alpha = m
    return list(by_root.values())


def _near_core(island, core_rows, near):
    for y, x0, x1 in island.runs:
        for yy in range(y - near, y + near + 1):
            row = core_rows.get(yy)
            if not row:
                continue
            starts, ends = row
            # Last core run starting before x1 + near; runs in a row are
            # disjoint and sorted, so it is the only one that can reach back.
            k = bisect_left(starts, x1 + near) - 1
            if k >= 0 and ends[k] > x0 - near:
                return True
    return False


def find_specks(alpha, width, height,
                core_mass=DEFAULT_CORE_MASS, near=DEFAULT_NEAR, faint=DEFAULT_FAINT):
    islands = find_islands(alpha, width, height)
    if not islands:
        return SpeckleResult([], None, 0, 0, 0)

    core = [i for i in islands if i.mass >= core_mass]
    if not core:
        # A layer made only of light strokes: never erase all of it.
        core = [max(islands, key=lambda i: i.mass)]
    core_ids = set(map(id, core))

    rows = {}
    for isl in core:
        for y, x0, x1 in isl.runs:
            rows.setdefault(y, []).append((x0, x1))
    core_rows = {}
    for y, spans in rows.items():
        spans.sort()
        core_rows[y] = ([s for s, _ in spans], [e for _, e in spans])

    remove_runs = []
    kept = []
    removed_islands = removed_pixels = 0
    for isl in islands:
        if id(isl) not in core_ids and (
                isl.max_alpha < faint or not _near_core(isl, core_rows, near)):
            remove_runs.extend(isl.runs)
            removed_islands += 1
            removed_pixels += isl.pixels
        else:
            kept.append(isl)

    bx0 = by0 = float('inf')
    bx1 = by1 = -1
    for isl in kept:
        for y, x0, x1 in isl.runs:
            bx0 = min(bx0, x0)
            bx1 = max(bx1, x1)
            by0 = min(by0, y)
            by1 = max(by1, y + 1)
    bbox = (bx0, by0, bx1, by1) if kept else None
    return SpeckleResult(remove_runs, bbox, len(islands), removed_islands, removed_pixels)


def clear_runs(pixels, width, bytes_per_pixel, runs):
    """Zero every pixel covered by `runs` in a bytearray of packed pixels.
    All-zero bytes are fully transparent in any RGBA format (u8/u16/float)."""
    for y, x0, x1 in runs:
        start = (y * width + x0) * bytes_per_pixel
        end = (y * width + x1) * bytes_per_pixel
        pixels[start:end] = bytes(end - start)
