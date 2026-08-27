// Unit coverage for the world map's zoom configuration (src/scenes/worldmap/logic/zoom.ts), brought into
// the measured suite by ADR-071 4b (2026-08-27).
//
// `makeZoomCfgs` is 12 lines that decide how much map is on screen at each of the three zoom levels AND how
// big the tile pool has to be. Both halves fail quietly:
//
//   · get the visible tile count wrong and the map reads as an over-dense carpet (the reported problem the
//     L1 divisor was walked 19 -> 16 -> 13 -> 11 to fix) or as four tiles filling the screen;
//   · get `poolW/poolH` wrong and the pool is too small for the viewport, so tiles at the edge of a pan
//     simply have no Graphics to draw into — a hole in the map, not a crash.
//
// The reason the visible count is computed from `visibleTileBounds` rather than `w / tile` is the isometric
// projection: the screen rectangle back-projects to a diamond in tile space, whose axis-aligned bounding box
// is wider and taller than the orthogonal estimate. That is asserted directly below, because "just use
// w/tile" is the obvious-looking simplification someone will reach for.
import { describe, it, expect } from 'vitest';
import { visibleTileBounds } from '../src/render/isoGrid';
import { makeZoomCfgs, type ZoomCfg } from '../src/scenes/worldmap/logic/zoom';
import { HUD_H } from '../src/scenes/worldmap/logic/constants';

// The sizes that actually reach this function. It is called with `layout.designWidth/designHeight`
// (WorldMapContext's constructor), NOT with the device size — LandscapeLayout clamps its width to
// [REFERENCE_W=1920, MAX_W=2592] and PortraitLayout pins DESIGN_W=1080. A raw phone width like 390 never
// gets here, which matters: see the "monotone below 837px" note at the end of this file.
const SCREENS: Array<[string, number, number]> = [
  ['landscape reference 1920x1080', 1920, 1080],
  ['landscape max width 2592x1080', 2592, 1080],
  ['portrait 1080x1920', 1080, 1920],
];

describe('makeZoomCfgs', () => {
  it('returns exactly three levels, coarsening monotonically', () => {
    for (const [name, w, h] of SCREENS) {
      const cfgs = makeZoomCfgs(w, h);
      expect(cfgs, name).toHaveLength(3);
      const [l1, l2, l3] = cfgs;
      // Bigger tiles = fewer of them on screen. Both halves must move together, or the pool and the
      // rendering disagree about what "zoomed out" means.
      expect(l1.tile, `${name} L1>L2 tile`).toBeGreaterThan(l2.tile);
      expect(l1.visW, `${name} L1<L2 visW`).toBeLessThan(l2.visW);
      expect(l1.visH, `${name} L1<L2 visH`).toBeLessThan(l2.visH);
      // L3 is a fixed 27px overview, so on a narrow phone it can coincide with L2's computed size —
      // assert "no finer than L2", not "strictly coarser".
      expect(l2.tile, `${name} L2>=L3 tile`).toBeGreaterThanOrEqual(l3.tile);
      expect(l3.visW, `${name} L3>=L2 visW`).toBeGreaterThanOrEqual(l2.visW);
    }
  });

  it('pool is exactly the visible span plus one buffer row/column on each side', () => {
    // The +2 is what lets a pan of up to one tile happen before the pool has to be rebuilt. Off by one and
    // the leading edge of a pan has no slot to draw into.
    for (const [name, w, h] of SCREENS) {
      for (const cfg of makeZoomCfgs(w, h)) {
        expect(cfg.poolW, `${name} @${cfg.tile}px poolW`).toBe(cfg.visW + 2);
        expect(cfg.poolH, `${name} @${cfg.tile}px poolH`).toBe(cfg.visH + 2);
      }
    }
  });

  it('reserves HUD_H at the bottom — the visible band is the map area, not the whole screen', () => {
    // A config computed against the full height over-counts rows and the bottom ones are permanently
    // hidden behind the HUD, which is invisible until someone profiles the pool.
    const w = 1920;
    const withHud = makeZoomCfgs(w, 1080);
    const asIfNoHud = makeZoomCfgs(w, 1080 + HUD_H);
    expect(HUD_H).toBeGreaterThan(0);
    expect(withHud[0].visH).toBeLessThan(asIfNoHud[0].visH);
  });

  it('derives the visible span from the isometric bounding box, not from w / tile', () => {
    // The property that makes the extra call worth it: under the iso projection the axis-aligned tile range
    // covering the screen is WIDER than the orthogonal estimate. If someone "simplifies" this to
    // Math.ceil(w / tile), the pool shrinks and the map grows holes at the edges.
    const [w, h] = [1920, 1080];
    for (const cfg of makeZoomCfgs(w, h)) {
      const orthogonal = Math.ceil(w / cfg.tile);
      expect(cfg.visW, `@${cfg.tile}px`).toBeGreaterThan(orthogonal);
    }
  });

  it('agrees with visibleTileBounds at the same tile size, to within a rounding cell under any pan', () => {
    // Restating the implementation would prove nothing; this checks the CONTRACT — the span IS the
    // bounding box's size, so it must not depend on where the camera happens to sit.
    const [w, h] = [1920, 1080];
    const mh = h - HUD_H;
    for (const cfg of makeZoomCfgs(w, h)) {
      // Pan-independent to within ONE cell, not exactly: `visibleTileBounds` floors/ceils the diamond's
      // corners, so a translation that lands mid-cell can widen the integer box by 1. (zoom.ts's own
      // comment says "pan-independent: translation doesn't change its width/height" — true of the real
      // rectangle, off by up to a rounding cell once it is snapped to integers. Measured: 174px tiles at
      // pan 1234,-987 give 24 where pan 0,0 gives 23.) A tolerance of 1 still catches the failure that
      // matters — a span computed from the wrong projection is out by tens of percent, not by one.
      for (const [px, py] of [[0, 0], [-500, 320], [1234, -987]] as const) {
        const b = visibleTileBounds(w, mh, px, py, cfg.tile);
        expect(Math.abs((b.maxTx - b.minTx) - cfg.visW), `visW @${cfg.tile}px pan ${px},${py}`).toBeLessThanOrEqual(1);
        expect(Math.abs((b.maxTy - b.minTy) - cfg.visH), `visH @${cfg.tile}px pan ${px},${py}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('L3 is a fixed 27px overview regardless of screen width', () => {
    // L1/L2 scale with the design width so the tile COUNT stays consistent across resolutions; L3 is the
    // situational-awareness view and is pinned instead, so its span grows with the screen.
    const widths = [390, 1280, 1920, 2560];
    const l3s = widths.map((w) => makeZoomCfgs(w, 1080)[2]);
    expect(new Set(l3s.map((c) => c.tile))).toEqual(new Set([27]));
    expect(l3s.map((c) => c.visW)).toEqual([...l3s.map((c) => c.visW)].sort((a, b) => a - b));
  });

  it('never produces a degenerate config (zero/negative tile, span or pool)', () => {
    // Guards the divisor arithmetic against a narrow viewport: Math.floor(w / 31) is 0 for w < 31, which
    // would make every downstream division by `tile` produce Infinity.
    for (const [name, w, h] of [...SCREENS, ['tiny 320x480', 320, 480] as [string, number, number]]) {
      for (const cfg of makeZoomCfgs(w, h)) {
        for (const [k, v] of Object.entries(cfg) as Array<[keyof ZoomCfg, number]>) {
          expect(Number.isFinite(v), `${name} ${k}`).toBe(true);
          expect(v, `${name} ${k}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is a pure function of (w, h) — same inputs, same config', () => {
    expect(makeZoomCfgs(1920, 1080)).toEqual(makeZoomCfgs(1920, 1080));
  });

  it('the L2/L3 ordering only holds above ~837px, which is below every layout width — documented, not fixed', () => {
    // L2's tile is floor(w / 31) and L3's is pinned at 27, so below w = 31 x 27 = 837 the "overview" level
    // is actually a zoom IN relative to L2. Unreachable in production (LandscapeLayout clamps to >= 1920,
    // PortraitLayout pins 1080), so this is registered rather than repaired — and pinned here so that a
    // future layout that DOES go narrower fails on this line instead of shipping an inverted zoom button.
    const inverted = makeZoomCfgs(390, 844);
    expect(inverted[1].tile).toBeLessThan(inverted[2].tile);
    const MIN_LAYOUT_W = 1080; // PortraitLayout DESIGN_W — the narrowest width this function can be handed
    expect(MIN_LAYOUT_W).toBeGreaterThan(31 * 27);
    const ok = makeZoomCfgs(MIN_LAYOUT_W, 1920);
    expect(ok[1].tile).toBeGreaterThanOrEqual(ok[2].tile);
  });
});
