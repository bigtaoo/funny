import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS } from '@nw/engine/config';
import { ILayout } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import { SketchPen } from './sketch';
import { palette, fx } from './theme';
import { bake } from './bake';
import { buildDecorLayer } from './decorLayer';
import { buildBattleLabels, type BattleLabelContext } from './battleLabels';
import {
  buildBases, applyBaseBreath, applyHitPulse, applyCriticalRing,
  playBaseCrackEffect, setBaseCritical, setBaseUpgradeLevel, playBaseUpgradeEffect,
  type BaseRef, type BasesHost,
} from './BoardView/bases';
import { showUnitLaneHighlights, showBuildingHighlights, showMeteorTargetHighlight, showColumnTargetHighlight, laneRect } from './BoardView/highlights';
import { playMeteorEffect, playRockslideEffect } from './BoardView/effects';

export { drawFactionGroundPatch } from './BoardView/bases';

// 断路 (BridgeCollapse) persistent lane overlay. The 0.6s cast VFX alone was easy to
// miss while the lane stays blocked for 8s; this overlay marks the lane for its full
// duration and blinks in the final seconds to telegraph the lane reopening.
const BLOCK_BLINK_SEC   = 1.6; // start blinking when this many seconds of block remain
const BLOCK_BLINK_SPEED = 9;   // rad/s — fast "about to clear" pulse

// 2026-08-13: base lifecycle (breathe/crack/critical-ring/upgrade) -> BoardView/bases.ts;
// placement highlights -> BoardView/highlights.ts; one-shot meteor/rockslide VFX ->
// BoardView/effects.ts — all form① (claudedocs/client-modules.md "单文件 500 行收敛"). This file
// kept the board/decoration baking, no-build/inactive-lane/blocked-lane overlays, and the
// per-frame update() + owner-routing delegates to bases.ts.

export class BoardView {
  readonly container: PIXI.Container;

  private readonly layout: ILayout;
  private readonly inactiveLaneLayer!: PIXI.Graphics;
  private readonly noBuildLayer: PIXI.Graphics;
  private readonly highlightLayer: PIXI.Graphics;

  private playerBase: BaseRef | null = null;
  private enemyBase:  BaseRef | null = null;
  private baseTime = 0;
  /** Monotonic seed so each accumulated crack scrawls with a fresh hand — boxed so
   *  BoardView/bases.ts's playBaseCrackEffect can increment it in place. */
  private readonly crackSeed = { value: 1 };

  private readonly meteorPool = new ObjectPool<PIXI.Graphics>(
    () => new PIXI.Graphics(),
    (gfx) => { gfx.clear(); gfx.alpha = 1; gfx.removeFromParent(); },
    3,
    { label: 'fx.meteor', bytesEach: 2 * 1024 },
  );

  /** In-flight one-shot effect ticks (meteor / rockslide), tracked so teardown can unregister them. */
  private readonly fxTicks = new Set<() => void>();

  /** Persistent 断路 overlay layer (below highlights); one child Graphics per blocked column. */
  private blockedLaneLayer!: PIXI.Container;
  /** 断路 overlays keyed by blocked column — drawn once on appear, alpha-blinked per frame. */
  private readonly blockedLanes = new Map<number, PIXI.Graphics>();

  constructor(layout: ILayout) {
    this.layout    = layout;
    this.container = new PIXI.Container();

    this.inactiveLaneLayer = new PIXI.Graphics();
    this.noBuildLayer   = new PIXI.Graphics();
    this.highlightLayer = new PIXI.Graphics();
    this.blockedLaneLayer = new PIXI.Container();

    this.drawBoard();
    this.drawDecorations();
    const { playerBase, enemyBase } = buildBases(layout, this.container);
    this.playerBase = playerBase;
    this.enemyBase  = enemyBase;
    this.container.addChild(this.inactiveLaneLayer); // below no-build + highlights
    this.container.addChild(this.noBuildLayer);
    this.container.addChild(this.blockedLaneLayer);  // 断路 overlay: board floor, under units
    this.container.addChild(this.highlightLayer);
  }

  /** Bundles what bases.ts's owner-routing functions need instead of them closing over `this`. */
  private basesHost(): BasesHost {
    return { layout: this.layout, container: this.container, playerBase: this.playerBase, enemyBase: this.enemyBase };
  }

  // ── No-build cells (campaign coverage puzzle) ─────────────────────────────

  /** Draw a static blocked marker (gray fill + ✕) on each no-build cell. */
  markNoBuildCells(cells: { col: number; row: number }[]): void {
    const g  = this.noBuildLayer;
    const cs = this.layout.cellSize;
    g.clear();
    for (const { col, row } of cells) {
      const pos = this.layout.gridToScreen(col, row);
      const x = pos.x - cs / 2;
      const y = pos.y - cs / 2;
      g.beginFill(fx.noBuild, 0.30);
      g.drawRect(x, y, cs, cs);
      g.endFill();
      g.lineStyle(2, palette.pencil, 0.7);
      g.moveTo(x + cs * 0.22, y + cs * 0.22); g.lineTo(x + cs * 0.78, y + cs * 0.78);
      g.moveTo(x + cs * 0.78, y + cs * 0.22); g.lineTo(x + cs * 0.22, y + cs * 0.78);
      g.lineStyle(0);
    }
  }

  // ── Active-lane gray-out (campaign lane restriction) ─────────────────────

  /**
   * Draw a semi-transparent pencil overlay on every attack lane that is NOT in
   * `activeLanes`. If `activeLanes` is undefined/empty (no restriction), clears any
   * prior overlay. Called once from GameRenderer.buildSceneGraph().
   */
  markInactiveLanes(activeLanes: number[] | undefined): void {
    const g = this.inactiveLaneLayer;
    g.clear();
    if (!activeLanes || activeLanes.length === 0) return;

    const activeSet = new Set(activeLanes);
    for (const col of ATTACK_LANES) {
      if (activeSet.has(col)) continue;
      const r = laneRect(this.layout, col);
      g.beginFill(palette.pencil, 0.13);
      g.drawRect(r.x, r.y, r.w, r.h);
      g.endFill();
    }
  }

  /**
   * Overlay individual blocked cells (e.g. from laneLength) on the inactive-lane
   * layer. Must be called AFTER markInactiveLanes() — does NOT call g.clear().
   */
  markBlockedCells(cells: { col: number; row: number }[]): void {
    if (cells.length === 0) return;
    const g  = this.inactiveLaneLayer;
    const cs = this.layout.cellSize;
    for (const { col, row } of cells) {
      const pos = this.layout.gridToScreen(col, row);
      g.beginFill(palette.pencil, 0.13);
      g.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
      g.endFill();
    }
  }

  // ── 断路 (BridgeCollapse) persistent lane overlay ─────────────────────────

  /**
   * Reconcile the persistent blocked-lane overlays against the engine's blocked
   * columns (called every frame from GameRenderer with each lane's remaining
   * block seconds). Overlays are built once when a lane becomes blocked and torn
   * down when it clears; per frame only their alpha changes — steady while the
   * block has time left, blinking in the final BLOCK_BLINK_SEC to signal that the
   * lane is about to reopen. Empty `entries` clears any lingering overlay.
   */
  syncBlockedLanes(entries: { col: number; remainingSec: number }[]): void {
    const t = this.baseTime;
    const active = new Set<number>();
    for (const { col, remainingSec } of entries) {
      active.add(col);
      let gfx = this.blockedLanes.get(col);
      if (!gfx) {
        gfx = this.buildBarricade(col);
        this.blockedLaneLayer.addChild(gfx);
        this.blockedLanes.set(col, gfx);
      }
      gfx.alpha = remainingSec < BLOCK_BLINK_SEC
        ? 0.4 + 0.45 * (0.5 + 0.5 * Math.sin(t * BLOCK_BLINK_SPEED)) // fast pulse: reopening soon
        : 0.9;
    }
    for (const [col, gfx] of this.blockedLanes) {
      if (!active.has(col)) { gfx.destroy(); this.blockedLanes.delete(col); }
    }
  }

  /** True while at least one lane overlay is live (lets the caller skip clearing when idle). */
  hasBlockedLanes(): boolean {
    return this.blockedLanes.size > 0;
  }

  /**
   * Draw a hand-drawn "road blocked" barricade over one lane: a faint red rubble
   * tint, cross-hatch fill, a scribbled frame, and a row of ✕ marks down the lane.
   * Geometry is seeded per column (SketchPen fixed seed) so it never wobbles — the
   * overlay is drawn once and only alpha-animated afterwards. Orientation-agnostic:
   * the lane is a vertical stripe (portrait) or horizontal band (landscape).
   */
  private buildBarricade(col: number): PIXI.Graphics {
    const g = new PIXI.Graphics();
    const r = laneRect(this.layout, col);
    g.beginFill(fx.laneBlocked, 0.12);
    g.drawRect(r.x, r.y, r.w, r.h);
    g.endFill();

    const pen = new SketchPen(g, ((col + 1) * 0x9e3779b1) >>> 0 || 1);
    pen.hatch(r.x + 3, r.y + 3, r.w - 6, r.h - 6, { color: fx.laneBlocked, angle: Math.PI / 4, spacing: 18, width: 1.8, alpha: 0.45 });
    pen.rect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, { color: fx.laneBlocked, width: 2.4, jitter: 1.5, alpha: 0.8, double: false });

    const vertical = r.h >= r.w;
    const span = vertical ? r.h : r.w;
    const s = Math.min(r.w, r.h) * 0.26;
    const n = Math.max(3, Math.round(span / (this.layout.cellSize * 1.6)));
    for (let i = 0; i < n; i++) {
      const f  = (i + 0.5) / n;
      const mx = vertical ? r.x + r.w / 2 : r.x + span * f;
      const my = vertical ? r.y + span * f : r.y + r.h / 2;
      pen.stroke([{ x: mx - s, y: my - s }, { x: mx + s, y: my + s }], { color: fx.laneBlocked, width: 2.8, alpha: 0.9, taper: 0.3, double: false });
      pen.stroke([{ x: mx - s, y: my + s }, { x: mx + s, y: my - s }], { color: fx.laneBlocked, width: 2.8, alpha: 0.9, taper: 0.3, double: false });
    }
    return g;
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(dt: number): void {
    this.baseTime += dt;
    const t = this.baseTime;
    applyBaseBreath(this.playerBase, t, 0);
    // Enemy base slightly out of phase, same feel as the old alpha pulse.
    applyBaseBreath(this.enemyBase,  t, 1.2);
    applyHitPulse(this.playerBase, dt);
    applyHitPulse(this.enemyBase,  dt);
    applyCriticalRing(this.playerBase, t);
    applyCriticalRing(this.enemyBase,  t);
  }

  // ── Base lifecycle — delegates to BoardView/bases.ts ───────────────────────

  playBaseCrackEffect(owner: 0 | 1, hp: number, maxHp: number): void {
    playBaseCrackEffect(this.basesHost(), this.crackSeed, owner, hp, maxHp);
  }

  setBaseCritical(owner: 0 | 1, on: boolean): void {
    setBaseCritical(this.basesHost(), owner, on);
  }

  setBaseUpgradeLevel(owner: 0 | 1, upgradeLevel: number): void {
    setBaseUpgradeLevel(this.basesHost(), owner, upgradeLevel);
  }

  playBaseUpgradeEffect(owner: 0 | 1): void {
    playBaseUpgradeEffect(this.basesHost(), this.fxTicks, owner);
  }

  // ── Coordinate helpers (delegate to ILayout) ──────────────────────────────

  gridToScreen(col: number, rowExact: number): { x: number; y: number } {
    return this.layout.gridToScreen(col, rowExact);
  }

  screenToCol(sx: number, sy: number): number {
    return this.layout.screenToCol(sx, sy);
  }

  screenToRow(sx: number, sy: number): number {
    return this.layout.screenToRow(sx, sy);
  }

  isOutsideBoard(sx: number, sy: number): boolean {
    return this.layout.isOutsideBoard(sx, sy);
  }

  // ── Placement highlights — delegates to BoardView/highlights.ts ────────────

  showUnitLaneHighlights(lanes: number[], blockedCols: Set<number>, hoveredCol: number): void {
    showUnitLaneHighlights(this.highlightLayer, this.layout, lanes, blockedCols, hoveredCol);
  }

  showBuildingHighlights(validCols: number[], buildingRow: number): void {
    showBuildingHighlights(this.highlightLayer, this.layout, validCols, buildingRow);
  }

  showMeteorTargetHighlight(col: number, row: number): void {
    showMeteorTargetHighlight(this.highlightLayer, this.layout, col, row);
  }

  showColumnTargetHighlight(col: number): void {
    showColumnTargetHighlight(this.highlightLayer, this.layout, col);
  }

  clearHighlights(): void {
    this.highlightLayer.clear();
  }

  // ── One-shot effects — delegates to BoardView/effects.ts ───────────────────

  playMeteorEffect(col: number, row: number): void {
    playMeteorEffect(this.container, this.layout, this.meteorPool, this.fxTicks, col, row);
  }

  playRockslideEffect(col: number): void {
    playRockslideEffect(this.container, this.layout, this.fxTicks, col);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Procedural notebook board (replaces the old stretched map.png, which never
   * aligned with the runtime grid). Draws — in local 0,0-origin coords — an aged
   * paper fill, hand-drawn ruled grid lines, and a scribbled border, then bakes
   * the whole static layer to a texture (cached per orientation/size/cellSize)
   * so it costs nothing per frame. Falls back to live Graphics if no renderer
   * is wired (headless tests).
   *
   * The grid is drawn from the same cellSize the live overlays use, so the
   * baked board and the dynamic highlight/crack layers stay pixel-aligned.
   */
  private drawBoard(): void {
    const r    = this.layout.boardRect;
    const cell = this.layout.cellSize;

    // In portrait: BOARD_COLS cols × BOARD_ROWS rows
    // In landscape: BOARD_ROWS cols × BOARD_COLS rows (transposed display)
    const numCols = this.layout.orientation === 'portrait' ? BOARD_COLS : BOARD_ROWS;
    const numRows = this.layout.orientation === 'portrait' ? BOARD_ROWS : BOARD_COLS;

    const gfx = new PIXI.Graphics();

    // Aged paper fill for the board area (local coords).
    gfx.beginFill(palette.paperShade, 1);
    gfx.drawRect(0, 0, r.w, r.h);
    gfx.endFill();
    // Faint warm shadow strip along bottom/right edges — a hint of page curl.
    gfx.beginFill(palette.paperDeep, 0.35);
    gfx.drawRect(0, r.h - 6, r.w, 6);
    gfx.drawRect(r.w - 6, 0, 6, r.h);
    gfx.endFill();

    // Hand-drawn ruled grid. A fixed seed keeps the scrawl identical per battle.
    const pen = new SketchPen(gfx, 0x9e3779b1);
    for (let c = 0; c <= numCols; c++) {
      const x = c * cell;
      pen.line(x, 0, x, numRows * cell, {
        color: palette.ruleLine, width: 1.1, jitter: 0.6, taper: 0.85, double: false,
      });
    }
    for (let rr = 0; rr <= numRows; rr++) {
      const y = rr * cell;
      pen.line(0, y, numCols * cell, y, {
        color: palette.ruleLine, width: 1.1, jitter: 0.6, taper: 0.85, double: false,
      });
    }

    // Scribbled pencil border framing the play area.
    pen.rect(1, 1, numCols * cell - 2, numRows * cell - 2, {
      color: palette.pencil, width: 2, jitter: 1.0,
    });

    const key = `board:${this.layout.orientation}:${Math.round(r.w)}x${Math.round(r.h)}:${cell}`;
    const tex = bake(key, gfx, r.w, r.h, { pageScale: true });
    if (tex) {
      const sprite = new PIXI.Sprite(tex);
      sprite.position.set(r.x, r.y);
      this.container.addChild(sprite);
      gfx.destroy();
    } else {
      // No renderer (tests): draw live at the board offset.
      gfx.position.set(r.x, r.y);
      this.container.addChild(gfx);
    }
  }

  /**
   * Snap hand-drawn doodles onto the paper margins just outside the grid and
   * bake them into a static layer (art-direction §6.2). Added directly above the
   * baked board and below every dynamic/game layer; the doodles sit outside the
   * board rect so they never touch cells, bases, or HUD. No-op until the atlas
   * has loaded (decorations are optional ambience). See decorLayer.ts.
   */
  private drawDecorations(): void {
    const layer = buildDecorLayer(this.layout);
    if (layer) this.container.addChild(layer);
  }

  /**
   * Scrawl the B-group corner labels (art-direction §6.2) into the paper margins
   * — `[START]` by the local base, `BOSS` by the enemy base on boss levels. Called
   * by GameRenderer after construction (the battle context isn't known at ctor
   * time). No-op until the label PNGs have loaded (optional ambience). The layer
   * sits in the same margins as the doodle layer, so it never touches cells/HUD.
   */
  showBattleLabels(ctx: BattleLabelContext): void {
    const layer = buildBattleLabels(this.layout, ctx);
    if (layer) this.container.addChild(layer);
  }

  /**
   * Tear down everything this view owns. Unregisters in-flight effect ticks from
   * the shared ticker (else they pin this view — and the whole battle scene — as
   * a GC root forever), destroys the detached meteor-pool Graphics, then destroys
   * the container subtree. The baked board texture lives in the shared bake cache
   * (reused across battles) and is intentionally NOT destroyed here.
   */
  destroy(): void {
    for (const tick of this.fxTicks) PIXI.Ticker.shared.remove(tick);
    this.fxTicks.clear();
    this.meteorPool.drain((gfx) => gfx.destroy());
    // Blocked-lane overlays are children of blockedLaneLayer (a container child),
    // so container.destroy({children:true}) frees the Graphics; just drop the refs.
    this.blockedLanes.clear();
    this.playerBase = null;
    this.enemyBase  = null;
    this.container.destroy({ children: true });
  }
}
