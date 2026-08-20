// Camera — the zoom/pan state extracted from index.ts's module-level `let`s (DESIGN.md §8,
// 2026-08-02 pass 2). This is the piece the refactor exists to make testable: `tp`/`panX`/`panY`
// had ~40 read/write sites in the entry point and the only way to check the math was to open the
// editor and drag.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLG_MAP_H, SLG_MAP_W } from '@nw/shared/slg';
import { DEFAULT_TP, VIEW_H, VIEW_PAD_FACTOR, VIEW_W, ZOOM_MAX, ZOOM_MIN } from '../src/constants';
import { Camera } from '../src/state/camera';
import { screenToTileF } from '../src/tiles/isoGrid';

let cam: Camera;
beforeEach(() => {
  cam = new Camera();
});

describe('Camera defaults', () => {
  it('opens at the game client\'s L1 tile density', () => {
    expect(cam.tp).toBe(DEFAULT_TP);
    expect(cam.panX).toBe(0);
    expect(cam.panY).toBe(0);
  });
});

describe('Camera.centerOnMap', () => {
  it('puts the map midpoint at the middle of the viewport', () => {
    cam.centerOnMap();
    const mid = cam.screenOf(SLG_MAP_W / 2, SLG_MAP_H / 2);
    expect(mid.x).toBeCloseTo(VIEW_W / 2, 6);
    expect(mid.y).toBeCloseTo(VIEW_H / 2, 6);
  });

  it('re-centers from anywhere, at any zoom', () => {
    for (const tp of [ZOOM_MIN, 40, DEFAULT_TP, ZOOM_MAX]) {
      cam.setZoom(tp);
      cam.panBy(-9999, 4321);
      cam.centerOnMap();
      const mid = cam.screenOf(SLG_MAP_W / 2, SLG_MAP_H / 2);
      expect(mid.x).toBeCloseTo(VIEW_W / 2, 6);
      expect(mid.y).toBeCloseTo(VIEW_H / 2, 6);
    }
  });
});

describe('Camera.panBy / clampPan', () => {
  it('moves by the delta while away from the map edges', () => {
    cam.centerOnMap();
    const { panX, panY } = cam;
    cam.panBy(-30, 17);
    expect(cam.panX).toBe(panX - 30);
    expect(cam.panY).toBe(panY + 17);
  });

  it('never lets blank space show past an edge, however far you drag', () => {
    for (const [dx, dy] of [[1e6, 1e6], [-1e6, -1e6], [1e6, -1e6], [-1e6, 1e6]]) {
      cam.centerOnMap();
      cam.panBy(dx!, dy!);
      // Both viewport corners must still land inside the map's projected bounding box.
      const tl = screenToTileF(0 - cam.panX, 0 - cam.panY, cam.tp);
      const br = screenToTileF(VIEW_W - cam.panX, VIEW_H - cam.panY, cam.tp);
      expect(tl.x + tl.y).toBeGreaterThanOrEqual(-1e-6); // above the map's top vertex
      expect(br.x + br.y).toBeLessThanOrEqual(SLG_MAP_W + SLG_MAP_H + 1e-6);
    }
  });

  it('is idempotent at a limit — dragging further changes nothing', () => {
    cam.panBy(1e6, 1e6);
    const { panX, panY } = cam;
    cam.panBy(1e6, 1e6);
    expect(cam.panX).toBe(panX);
    expect(cam.panY).toBe(panY);
  });

  it('notifies onChange so the render layer can sync worldLayer.position', () => {
    const onChange = vi.fn();
    cam.onChange = onChange;
    cam.panBy(10, 10);
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Camera.setZoom', () => {
  it('clamps to the configured zoom range', () => {
    cam.setZoom(-500);
    expect(cam.tp).toBe(ZOOM_MIN);
    cam.setZoom(99999);
    expect(cam.tp).toBe(ZOOM_MAX);
  });

  it('rounds fractional zoom targets (tp is a whole pixel width)', () => {
    cam.setZoom(42.7);
    expect(cam.tp).toBe(43);
  });

  it('returns false and changes nothing when the target equals the current zoom', () => {
    cam.centerOnMap();
    const { tp, panX, panY } = cam;
    expect(cam.setZoom(tp)).toBe(false);
    expect(cam.setZoom(tp + 0.2)).toBe(false); // rounds back to the same tp
    expect([cam.tp, cam.panX, cam.panY]).toEqual([tp, panX, panY]);
  });

  it('returns true when the zoom actually moves', () => {
    expect(cam.setZoom(cam.tp + 10)).toBe(true);
  });

  it('already at a limit, pushing further is a no-op rather than a redraw', () => {
    cam.setZoom(ZOOM_MAX);
    expect(cam.setZoom(ZOOM_MAX + 50)).toBe(false);
  });

  // The property that makes wheel-zoom feel right: whatever tile is under the cursor stays under
  // the cursor. Getting this wrong makes the map slide away as you scroll.
  it('keeps the tile under the anchor pinned in place', () => {
    for (const anchor of [{ sx: 0, sy: 0 }, { sx: 120, sy: 500 }, { sx: VIEW_W, sy: VIEW_H }]) {
      cam.setZoom(DEFAULT_TP);
      cam.centerOnMap();
      const before = screenToTileF(anchor.sx - cam.panX, anchor.sy - cam.panY, cam.tp);
      cam.setZoom(cam.tp + 30, anchor);
      const after = screenToTileF(anchor.sx - cam.panX, anchor.sy - cam.panY, cam.tp);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('anchors on the viewport center when no anchor is given (slider zoom)', () => {
    cam.centerOnMap();
    const center = { sx: VIEW_W / 2, sy: VIEW_H / 2 };
    const before = screenToTileF(center.sx - cam.panX, center.sy - cam.panY, cam.tp);
    cam.setZoom(cam.tp - 25);
    const after = screenToTileF(center.sx - cam.panX, center.sy - cam.panY, cam.tp);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zooming out then back in returns to the same view', () => {
    cam.centerOnMap();
    const { tp, panX, panY } = cam;
    cam.setZoom(ZOOM_MIN);
    cam.setZoom(tp);
    expect(cam.tp).toBe(tp);
    expect(cam.panX).toBeCloseTo(panX, 6);
    expect(cam.panY).toBeCloseTo(panY, 6);
  });
});

describe('Camera.tileAt', () => {
  it('inverts screenOf — clicking a tile\'s own pixel selects that tile', () => {
    cam.centerOnMap();
    for (const [tx, ty] of [[740, 750], [750, 750], [761, 744]]) {
      // screenOf gives the tile ORIGIN; nudge into the diamond's interior before hit-testing.
      const s = cam.screenOf(tx! + 0.5, ty! + 0.5);
      expect(cam.tileAt(s.x, s.y)).toEqual({ x: tx, y: ty });
    }
  });

  it('clamps a click that lands off the map instead of returning negatives', () => {
    cam.centerOnMap();
    const far = cam.tileAt(-1e6, -1e6);
    expect(far).toEqual({ x: 0, y: 0 });
    const other = cam.tileAt(1e6, 1e6);
    expect(other).toEqual({ x: SLG_MAP_W - 1, y: SLG_MAP_H - 1 });
  });

  it('stays in bounds for every corner of the viewport at every zoom', () => {
    for (const tp of [ZOOM_MIN, 37, DEFAULT_TP, ZOOM_MAX]) {
      cam.setZoom(tp);
      cam.centerOnMap();
      for (const [sx, sy] of [[0, 0], [VIEW_W, 0], [0, VIEW_H], [VIEW_W, VIEW_H]]) {
        const t = cam.tileAt(sx!, sy!);
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(SLG_MAP_W);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThan(SLG_MAP_H);
      }
    }
  });
});

describe('Camera.visibleRange', () => {
  it('covers every tile the viewport actually shows', () => {
    cam.centerOnMap();
    const r = cam.visibleRange(VIEW_PAD_FACTOR);
    for (let sy = 0; sy <= VIEW_H; sy += 20) {
      for (let sx = 0; sx <= VIEW_W; sx += 20) {
        const t = cam.tileAt(sx, sy);
        expect(t.x).toBeGreaterThanOrEqual(r.x0);
        expect(t.x).toBeLessThanOrEqual(r.x1);
        expect(t.y).toBeGreaterThanOrEqual(r.y0);
        expect(t.y).toBeLessThanOrEqual(r.y1);
      }
    }
  });

  it('never runs off the map', () => {
    for (const tp of [ZOOM_MIN, DEFAULT_TP, ZOOM_MAX]) {
      cam.setZoom(tp);
      cam.centerOnMap();
      const r = cam.visibleRange(VIEW_PAD_FACTOR);
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.y0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThan(SLG_MAP_W);
      expect(r.y1).toBeLessThan(SLG_MAP_H);
    }
  });

  it('pads past the visible edge so a short pan does not reveal blank space', () => {
    cam.centerOnMap();
    const padded = cam.visibleRange(VIEW_PAD_FACTOR);
    const exact = cam.visibleRange(1);
    expect(padded.x1 - padded.x0).toBeGreaterThan(exact.x1 - exact.x0);
    expect(padded.y1 - padded.y0).toBeGreaterThan(exact.y1 - exact.y0);
  });

  it('renders fewer tiles as you zoom in (cell count goes as tp⁻²)', () => {
    cam.setZoom(20);
    cam.centerOnMap();
    const wide = cam.visibleRange(VIEW_PAD_FACTOR);
    cam.setZoom(ZOOM_MAX);
    cam.centerOnMap();
    const close = cam.visibleRange(VIEW_PAD_FACTOR);
    const area = (r: { x0: number; x1: number; y0: number; y1: number }) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
    expect(area(close)).toBeLessThan(area(wide));
  });
});

// layerOf() is the busiest camera method in the render layer (every tile Graphics in baseMap.ts,
// every city sprite in citySprites.ts, every overlay polygon in overlay.ts positions itself with
// it) and had no test at all — it was the one uncovered line pair in this file. What makes it worth
// pinning is not the arithmetic but the contract in camera.ts's own header: the pan lives on
// `worldLayer.position`, so children must be positioned PAN-FREE. Get that wrong and a pan
// double-counts — the container moves and every child moves with it, which is the "drag the map and
// everything slides twice as fast" class of bug, invisible until you actually drag.
describe('Camera.layerOf', () => {
  it('is screenOf minus the pan, on both axes', () => {
    cam.centerOnMap();
    for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [375, 620], [SLG_MAP_W - 1, SLG_MAP_H - 1]]) {
      const layer = cam.layerOf(tx!, ty!);
      const screen = cam.screenOf(tx!, ty!);
      expect(layer.x).toBeCloseTo(screen.x - cam.panX, 10);
      expect(layer.y).toBeCloseTo(screen.y - cam.panY, 10);
    }
  });

  it('does not move when the camera pans — the pan is the container\'s job, not the child\'s', () => {
    cam.centerOnMap();
    const before = cam.layerOf(400, 400);
    cam.panBy(-137, 61);
    expect(cam.panX, 'the pan must actually have changed, or this asserts nothing').not.toBe(0);
    const after = cam.layerOf(400, 400);
    expect(after).toEqual(before);
    // ...while the viewport-space position DID move, by exactly the pan delta.
    expect(cam.screenOf(400, 400).x - before.x).toBeCloseTo(cam.panX, 10);
  });

  it('does move when the camera zooms — tp is baked into the child position', () => {
    cam.setZoom(20);
    const wide = cam.layerOf(400, 400);
    cam.setZoom(60);
    expect(cam.layerOf(400, 400)).not.toEqual(wide);
  });
});
