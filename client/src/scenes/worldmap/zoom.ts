// Zoom configuration + tile-pool slot types — extracted from WorldMapScene.
// Three zoom levels cycled via a button:
//   L1 detail   25×≈14 tiles, 76px/tile (1920px design width) — full markers (level dots / watchtowers / sect borders)
//   L2 medium   50×≈27 tiles, 38px/tile — occupation color + capital stars + march arrows only
//   L3 overview ~96×≈50 tiles, 20px/tile — batched color-block rendering, coarsest, for situational awareness
// TILE_PX is computed dynamically from designWidth to keep visible tile counts consistent across resolutions.

import * as PIXI from 'pixi.js-legacy';
import { visibleTileBounds } from '../../render/isoGrid';
import { HUD_H } from './constants';

export interface ZoomCfg {
  tile: number;   // px per tile
  visW: number;   // visible tile columns
  visH: number;   // visible tile rows (mapH area)
  poolW: number;  // pool columns = visW + 2 (one buffer on each side)
  poolH: number;  // pool rows = visH + 2
}

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
  // overview left dense. Editor's DEFAULT_TP mirrors this L1 divisor (tools/map-editor parity).
  return [mk(Math.floor(w / 11)), mk(Math.floor(w / 31)), mk(27)];
}

/** A single pooled tile object — one PIXI.Graphics reused for many map positions. */
export interface PoolSlot {
  g: PIXI.Graphics;
  tx: number; // map tile currently displayed (-1 = unassigned)
  ty: number;
}
