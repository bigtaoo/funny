import * as PIXI from 'pixi.js-legacy';
import { BATTLEPASS_DEFS, BATTLEPASS_MAX_LEVEL } from '../../game/balance/battlepassDefs';
import { cellState, drawCurrentLevelFrame, drawCell } from './cell';

// ── Reward-row virtualization for BattlePassScene ─────────────────────────────
//
// Extracted from the scene class (form① independent module, client-modules.md's split-priority
// convention: ①独立函数模块 → ②独立类+组合 → ③继承链) so BattlePassScene.ts stays under the
// 500-line convention. Composed via a single `RewardRowVirtualizer` instance rather than a bag of
// loose functions (form②) because it needs its own persistent `built` map across renders/drags —
// a bare module function would just push that same state back onto the scene class.
//
// Why this exists at all (2026-08-12 bug report): render() used to build all BATTLEPASS_MAX_LEVEL
// (30) levels × 2 tracks unconditionally — up to 3 PIXI.Text + a hand-sketched Graphics border
// per cell, ~150-200 GPU objects in one frame. Mobile WebViews (iOS Safari in particular) treat
// that many textures created synchronously as a memory spike and kill/reload the whole tab, which
// is what made opening the Battle Pass page on a phone browser reload the page (character-card
// inventory, which is draw-culled the same way CardScene/list.ts does, was unaffected). Mirrors
// LeaderboardScene's builtRows/updateVisibleRows fix (commit 6c42450d) for the same root cause.

/** Per-render level/track state needed to build a reward row's visuals; cached by the scene and
 *  passed back in on every sync() (including scroll-drag's reposition-only fast path). */
export interface RowVizContext {
  currentLevel: number;
  claimedFree: Set<number>;
  claimedPaid: Set<number>;
  hasPass: boolean;
  headerH: number;
  cellH: number;
  cellGap: number;
  freeX: number;
  paidX: number;
  halfW: number;
}

export class RewardRowVirtualizer {
  private readonly built: Map<number, PIXI.Container> = new Map();

  /** Number of levels currently built as real display objects (test/debug hook). */
  get size(): number { return this.built.size; }
  has(i: number): boolean { return this.built.has(i); }

  /** Drops all tracked rows without destroying them — call only after the scene's own
   *  tearDownChildren() has already destroyed the whole container tree (avoids double-destroy). */
  clear(): void {
    this.built.clear();
  }

  /**
   * Builds/destroys row visuals so only levels within one viewport-height of the visible area
   * actually exist as PIXI DisplayObjects. Call on every render() and on every scroll
   * position change (drag/wheel fast path), same cadence as LeaderboardScene.updateVisibleRows().
   */
  sync(scrollContainer: PIXI.Container, scrollY: number, scrollMax: number, viewportH: number, ctx: RowVizContext): void {
    const sy = Math.min(scrollY, scrollMax);
    const buffer = viewportH * 0.5;
    const viewTop = sy - buffer;
    const viewBottom = sy + viewportH + buffer;
    const stride = ctx.cellH + ctx.cellGap;
    const needed = new Set<number>();
    for (let i = 0; i < BATTLEPASS_MAX_LEVEL; i++) {
      const cellY = ctx.headerH + i * stride;
      if (cellY + ctx.cellH < viewTop || cellY > viewBottom) continue;
      needed.add(i);
      if (!this.built.has(i)) {
        const rowC = new PIXI.Container();
        rowC.y = cellY;
        this.drawRow(rowC, i, ctx);
        scrollContainer.addChild(rowC);
        this.built.set(i, rowC);
      }
    }
    for (const [i, rowC] of this.built) {
      if (needed.has(i)) continue;
      rowC.destroy({ children: true });
      this.built.delete(i);
    }
  }

  /** Draws one level's free+paid cells (and the current-level frame, if applicable) into a row
   *  container positioned at that level's absolute cellY — so cell-drawing coordinates here are
   *  row-local (y=0), matching cell.ts's (x,y) = top-left-of-cell contract. */
  private drawRow(parent: PIXI.Container, i: number, ctx: RowVizContext): void {
    const def = BATTLEPASS_DEFS[i]!;
    const lvl = def.level;
    if (lvl === ctx.currentLevel) drawCurrentLevelFrame(parent, ctx.freeX, ctx.paidX, ctx.halfW, 0, ctx.cellH);
    const freeState = cellState('free', lvl, ctx.currentLevel, ctx.claimedFree, ctx.claimedPaid, ctx.hasPass, !!def.free);
    drawCell(parent, ctx.freeX, 0, ctx.halfW, ctx.cellH, lvl, def.free ?? null, freeState);
    const paidState = cellState('paid', lvl, ctx.currentLevel, ctx.claimedFree, ctx.claimedPaid, ctx.hasPass, !!def.paid);
    drawCell(parent, ctx.paidX, 0, ctx.halfW, ctx.cellH, lvl, def.paid ?? null, paidState);
  }
}
