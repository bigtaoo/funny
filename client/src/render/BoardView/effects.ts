// BoardView's one-shot spell VFX (meteor impact flash, rockslide column sweep), extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). fxTicks/meteorPool are
// plain readonly references — every mutation on them is in-place (.add/.delete, .acquire/
// .release), never a wholesale reassignment — so no host object/getter-setter needed.
import * as PIXI from 'pixi.js-legacy';
import { BOARD_ROWS } from '@nw/engine/config';
import { ILayout } from '../../layout/ILayout';
import { ObjectPool } from '../../cache/ObjectPool';
import { SketchPen } from '../sketch';
import { palette, fx } from '../theme';
import { laneRect } from './highlights';

export function playMeteorEffect(
  container: PIXI.Container, layout: ILayout, meteorPool: ObjectPool<PIXI.Graphics>, fxTicks: Set<() => void>,
  col: number, row: number,
): void {
  const pos = layout.gridToScreen(col, row);
  const cs  = layout.cellSize;
  const gfx = meteorPool.acquire();
  gfx.lineStyle(4, fx.meteor);
  gfx.drawRect(pos.x - cs, pos.y - cs, cs * 2, cs * 2);
  container.addChild(gfx);

  let frames = 30;
  const tick = (): void => {
    gfx.alpha = frames / 30;
    if (--frames <= 0) {
      PIXI.Ticker.shared.remove(tick);
      fxTicks.delete(tick);
      meteorPool.release(gfx);
    }
  };
  fxTicks.add(tick);
  PIXI.Ticker.shared.add(tick);
}

/**
 * 直线伤害 (Rockslide) map effect: a brief red telegraph line flashes down the whole
 * lane, then rock impacts cascade cell-by-cell from one end to the other — so the
 * player reads "the ENTIRE column was hit" rather than a single localized poof (the
 * old single center VFX). Pure render (damage is applied instantly engine-side);
 * self-contained in one Graphics + one tracked tick, unregistered in BoardView.destroy().
 */
export function playRockslideEffect(container: PIXI.Container, layout: ILayout, fxTicks: Set<() => void>, col: number): void {
  const g = new PIXI.Graphics();
  container.addChild(g);

  const r        = laneRect(layout, col);
  const vertical = r.h >= r.w;
  const span     = vertical ? r.h : r.w;
  const cs       = layout.cellSize;
  const rows     = BOARD_ROWS;
  const seed     = ((col + 7) * 0x9e3779b1) >>> 0 || 1;

  const TELEGRAPH   = 0.18; // s — warning line before the first rock lands
  const PER_ROW     = 0.03; // s — stagger between successive cells
  const IMPACT_LIFE = 0.34; // s — how long each rock burst lingers
  const total       = TELEGRAPH + PER_ROW * rows + IMPACT_LIFE;

  let e = 0;
  const tick = (): void => {
    e += PIXI.Ticker.shared.deltaMS / 1000;
    g.clear();

    // Telegraph: bright warning line + faint lane tint, fading out early.
    const tel = Math.max(0, 1 - e / (TELEGRAPH * 2.2));
    if (tel > 0) {
      g.beginFill(fx.meteor, 0.16 * tel);
      g.drawRect(r.x, r.y, r.w, r.h);
      g.endFill();
      g.lineStyle(3, fx.meteor, 0.9 * tel);
      if (vertical) { g.moveTo(r.x + r.w / 2, r.y); g.lineTo(r.x + r.w / 2, r.y + r.h); }
      else          { g.moveTo(r.x, r.y + r.h / 2); g.lineTo(r.x + r.w, r.y + r.h / 2); }
    }

    // Cascading rock impacts, one per cell, front sweeping along the lane.
    const pen = new SketchPen(g, seed);
    for (let i = 0; i < rows; i++) {
      const age = e - (TELEGRAPH + i * PER_ROW);
      if (age < 0 || age > IMPACT_LIFE) continue;
      const f  = (i + 0.5) / rows;
      const mx = vertical ? r.x + r.w / 2 : r.x + span * f;
      const my = vertical ? r.y + span * f : r.y + r.h / 2;
      drawRockImpact(g, pen, mx, my, cs * 0.32, 1 - age / IMPACT_LIFE);
    }

    if (e >= total) {
      PIXI.Ticker.shared.remove(tick);
      fxTicks.delete(tick);
      g.destroy();
    }
  };
  fxTicks.add(tick);
  PIXI.Ticker.shared.add(tick);
}

/** One rock burst for the rockslide sweep: a jagged chunk + debris dots spreading as it settles (k: 1→0). */
function drawRockImpact(g: PIXI.Graphics, pen: SketchPen, x: number, y: number, sz: number, k: number): void {
  const a = 0.9 * k;
  pen.stroke([
    { x: x - sz,        y: y - sz * 0.6 },
    { x: x - sz * 0.2,  y: y - sz },
    { x: x + sz * 0.9,  y: y - sz * 0.3 },
    { x: x + sz * 0.5,  y: y + sz * 0.8 },
    { x: x - sz * 0.7,  y: y + sz * 0.6 },
    { x: x - sz,        y: y - sz * 0.6 },
  ], { color: palette.pencil, width: 2, alpha: a, taper: 0, double: false });

  const spread = sz * (0.8 + (1 - k) * 1.8);
  for (let d = 0; d < 4; d++) {
    const ang = d * 1.9; // fixed spokes — deterministic, exact angle is cosmetic
    g.beginFill(palette.pencilLight, 0.7 * k);
    g.drawCircle(x + Math.cos(ang) * spread, y + Math.sin(ang) * spread, 1.4 * k + 0.6);
    g.endFill();
  }
}
