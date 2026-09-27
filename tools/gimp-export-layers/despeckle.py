#!/usr/bin/env python3
"""Remove stray speckle pixels from PNGs or from the images inside a .taoeditor,
then crop to what is left. Same rule as the GIMP export plugin (see speckle.py).

    python despeckle.py art/units/archer/archer.taoeditor
    python despeckle.py -n --preview out/ art/units/*/*.png

.taoeditor: every images/<slot>.png is cleaned and cropped, and the slot's
binding anchorX/anchorY is recomputed so the pivot stays on the same pixel
(anchors are fractions of the image size). Open it in the animator afterwards
and re-export the .tao.

.png: cleaned and cropped in place. If the PNG is already bound in a rig, run
this on the .taoeditor instead, or that rig's pivot will drift.

Requires Pillow.
"""

import argparse
import io
import json
import os
import sys
import zipfile

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speckle  # noqa: E402


def clean_image(im, opts):
    """Return (cleaned image or None if unchanged, crop offset (x, y), result)."""
    if im.mode != 'RGBA':
        if 'A' not in im.getbands() and 'transparency' not in im.info:
            return None, (0, 0), None
        im = im.convert('RGBA')
    w, h = im.size
    res = speckle.find_specks(im.getchannel('A').tobytes(), w, h,
                              opts.core_mass, opts.near, opts.faint)
    if res.bbox is None:
        return None, (0, 0), res
    if not res.remove_runs and res.bbox == (0, 0, w, h):
        return None, (0, 0), res
    px = bytearray(im.tobytes())
    speckle.clear_runs(px, w, 4, res.remove_runs)
    out = Image.frombytes('RGBA', (w, h), bytes(px)).crop(res.bbox)
    return out, res.bbox[:2], res


def write_preview(im, res, path):
    """Grey silhouette of the image, removed pixels in red, kept crop in green."""
    w, h = im.size
    a = im.convert('RGBA').getchannel('A')
    grey = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    grey.paste((110, 110, 110, 255), mask=a.point(lambda v: 255 if v else 0))
    px = grey.load()
    for y, x0, x1 in res.remove_runs:
        for x in range(x0, x1):
            px[x, y] = (230, 30, 30, 255)
    x0, y0, x1, y1 = res.bbox
    for x in range(x0, x1):
        px[x, y0] = px[x, y1 - 1] = (0, 170, 0, 255)
    for y in range(y0, y1):
        px[x0, y] = px[x1 - 1, y] = (0, 170, 0, 255)
    grey.save(path)


def encode_png(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def report(label, before, after, res):
    if res is None:
        print(f'  {label}: no alpha, skipped')
        return
    print(f'  {label}: {before[0]}x{before[1]} -> {after[0]}x{after[1]}'
          f'  ({res.removed_islands} of {res.islands} islands, {res.removed_pixels} px removed)')


def process_png(path, opts):
    with Image.open(path) as src:
        src.load()
    out, _, res = clean_image(src, opts)
    after = out.size if out else src.size
    report(os.path.basename(path), src.size, after, res)
    if opts.preview and res and res.bbox:
        write_preview(src, res, os.path.join(opts.preview, os.path.basename(path)))
    if out and not opts.dry_run:
        with open(path, 'wb') as f:
            f.write(encode_png(out))
    return out is not None


def process_taoeditor(path, opts):
    with zipfile.ZipFile(path) as z:
        entries = [(info, z.read(info)) for info in z.infolist()]
    project = json.loads(next(d for i, d in entries if i.filename == 'editor.json'))
    bindings = project.get('bindings', {})

    changed = False
    new_entries = []
    for info, data in entries:
        name = info.filename
        if name.startswith('images/') and name.lower().endswith('.png'):
            slot = name[len('images/'):-len('.png')]
            src = Image.open(io.BytesIO(data))
            src.load()
            out, (ox, oy), res = clean_image(src, opts)
            after = out.size if out else src.size
            report(slot, src.size, after, res)
            if opts.preview and res and res.bbox:
                base = os.path.splitext(os.path.basename(path))[0]
                write_preview(src, res, os.path.join(opts.preview, f'{base}-{slot}.png'))
            if out:
                changed = True
                data = encode_png(out)
                b = bindings.get(slot)
                if b is not None:
                    (w, h), (nw, nh) = src.size, out.size
                    # Skip untouched axes so they don't pick up float noise.
                    if (ox, nw) != (0, w):
                        b['anchorX'] = (b['anchorX'] * w - ox) / nw
                    if (oy, nh) != (0, h):
                        b['anchorY'] = (b['anchorY'] * h - oy) / nh
        new_entries.append((info, data))

    if changed and not opts.dry_run:
        # Match the animator's JSON.stringify(project, null, 2).
        editor_json = json.dumps(project, indent=2, ensure_ascii=False).encode('utf-8')
        tmp = path + '.tmp'
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
            for info, data in new_entries:
                if info.filename == 'editor.json':
                    data = editor_json
                z.writestr(info.filename, data)
        os.replace(tmp, path)
    return changed


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('paths', nargs='+', help='.png or .taoeditor files')
    p.add_argument('-n', '--dry-run', action='store_true', help='report only, write nothing')
    p.add_argument('--preview', metavar='DIR',
                   help='write overlays to DIR: removed pixels red, new crop box green')
    p.add_argument('--core-mass', type=float, default=speckle.DEFAULT_CORE_MASS,
                   help='islands worth at least this many opaque pixels are content (default %(default)s)')
    p.add_argument('--near', type=int, default=speckle.DEFAULT_NEAR,
                   help='light islands within this many px of content are kept (default %(default)s)')
    p.add_argument('--faint', type=int, default=speckle.DEFAULT_FAINT,
                   help='light islands whose max alpha is below this are removed anyway (default %(default)s)')
    opts = p.parse_args()
    if opts.preview:
        os.makedirs(opts.preview, exist_ok=True)

    touched = 0
    for path in opts.paths:
        print(path)
        ext = path.lower()
        if ext.endswith('.taoeditor') or ext.endswith('.tao.editor'):
            touched += process_taoeditor(path, opts)
        elif ext.endswith('.png'):
            touched += process_png(path, opts)
        else:
            print('  unsupported file type, skipped')
    verb = 'would change' if opts.dry_run else 'changed'
    print(f'{verb} {touched} file(s)')


if __name__ == '__main__':
    main()
