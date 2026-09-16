// Zoom configuration + tile-pool slot types — extracted from WorldMapScene.
// Three zoom levels cycled via a button, coarsening L1 → L3:
//   L1 detail   full markers (level dots / watchtowers / sect borders)
//   L2 medium   occupation color + capital stars + march arrows only
//   L3 overview 27px/tile, batched color-block rendering, for situational awareness
// TILE_PX is computed dynamically from designWidth to keep visible tile counts consistent across
// resolutions. Portrait and landscape run DIFFERENT ladders — see makeZoomCfgs.

// No PIXI import: this file is part of worldmap's PURE layer (see logic/README-less convention —
// test/pureLayerBoundary.test.ts enforces it). `PoolSlot`, the one thing here that needed
// PIXI.Graphics, moved to WorldMapRenderer/pool.ts, which is the file that actually owns the pool.
import { BASE_FOOTPRINT } from '@nw/shared';
import { visibleTileBounds } from '../../../render/isoGrid';
import { HUD_H } from './constants';

export interface ZoomCfg {
  tile: number;   // px per tile
  visW: number;   // visible tile columns
  visH: number;   // visible tile rows (mapH area)
  poolW: number;  // pool columns = visW + 2 (one buffer on each side)
  poolH: number;  // pool rows = visH + 2
}

/**
 * Portrait L1 frames the player's own base at this fraction of the design width. The measured
 * thing is the base's PLOT — `BASE_FOOTPRINT` tiles wide — because that, not the slightly wider
 * `BASE_SPRITE_TILES` sprite, is what the player sees: WorldMapRenderer/city.ts masks every base
 * sprite to `cityPlotMaskPoints`, whose width is exactly `BASE_FOOTPRINT * tile`. The tile size
 * follows from these two numbers alone — change this, not a divisor, to re-frame the opening shot.
 */
export const PORTRAIT_L1_BASE_WIDTH_FRAC = 5 / 6;

export function makeZoomCfgs(w: number, h: number): [ZoomCfg, ZoomCfg, ZoomCfg] {
  const mh = h - HUD_H;
  const mk = (tile: number): ZoomCfg => {
    // Under isometric projection the screen rect back-projects to a rotated (diamond)
    // region in tile space, so the axis-aligned tile range covering it is wider/taller
    // than the orthogonal `w/tile` estimate — use the real bounding-box size (pan-
    // independent: translation doesn't change its width/height, only its origin).
    const b = visibleTileBounds(w, mh, 0, 0, tile);
    const visW = b.maxTx - b.minTx;
    const visH = b.maxTy - b.minTy;
    return { tile, visW, visH, poolW: visW + 2, poolH: visH + 2 };
  };
  // Divisor = tiles across screen width; smaller divisor = bigger tiles = fewer on screen.
  // L1 19→16→13→11 (each step cuts on-screen tile count, count ∝ divisor²) — the map read as an
  // over-dense carpet at higher divisors. L2 left at 31 (step to L1 now ~2.8×, still fine); L3
  // overview left dense. Editor's DEFAULT_TP mirrors this LANDSCAPE L1 divisor (map-editor parity).
  if (h <= w) return [mk(Math.floor(w / 11)), mk(Math.floor(w / 31)), mk(27)];
  // Portrait ladder. Same divisors read very differently here: the design width is the SHORT side
  // (PortraitLayout pins 1080), so "11 tiles across" put the player's own base — the thing the map
  // opens on — at under a third of the screen, which reads as a camera parked far too high
  // (2026-09-15 user call). Portrait L1 is therefore framed on the BASE, not on a tile count:
  // solve `BASE_FOOTPRINT * tile = w * PORTRAIT_L1_BASE_WIDTH_FRAC` for the tile size, i.e. an
  // effective divisor of 3 / (5/6) = 3.6. L2 is the old L1 (divisor 11), so the familiar wide view is
  // one tap away and the L1→L2 step stays ~3.1× (landscape's is ~2.8×); L3 is the pinned overview.
  return [
    mk(Math.floor((w * PORTRAIT_L1_BASE_WIDTH_FRAC) / BASE_FOOTPRINT)),
    mk(Math.floor(w / 11)),
    mk(27),
  ];
}

