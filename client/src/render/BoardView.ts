import * as PIXI from 'pixi.js-legacy';
import { ATTACK_LANES, BOARD_COLS, BOARD_ROWS } from '../game/config';
import { sideToOwner } from '../game';
import { ILayout, Rect } from '../layout/ILayout';
import { ObjectPool } from '../cache/ObjectPool';
import baseTexUrl from '../assets/game_base.png';
import { SketchPen } from './sketch';
import { palette, fx } from './theme';
import { bake } from './bake';
import { buildDecorLayer } from './decorLayer';
import { buildBattleLabels, type BattleLabelContext } from './battleLabels';

/** State/highlight colors sourced from theme.fx (art-direction §3.3). */
const HIGHLIGHT_LANE     = fx.laneValid;     // valid attack lane
const HIGHLIGHT_BUILDING = fx.buildingValid; // valid building slot
const HIGHLIGHT_ALPHA    = 0.18;
const HIGHLIGHT_METEOR   = fx.meteor;        // meteor targeting

// Base idle: alpha pulse only
const BASE_ALPHA_MIN    = 0.65;
const BASE_ALPHA_RANGE  = 0.35;    // 0.65 → 1.0
const BASE_PULSE_SPEED  = Math.PI / 2; // rad/s → period = 4s

// Base under-attack: a hand-drawn outline pops around the base and fades out.
const BASE_HIT_PULSE_SEC   = 0.5;   // duration of one pulse
const BASE_HIT_PULSE_GROW  = 0.18;  // outline expands by this fraction as it fades

interface BaseRef {
  sprite:   PIXI.Sprite;
  crackGfx: PIXI.Graphics;
  /** Hand-drawn outline shown briefly when the base takes damage. */
  pulseGfx: PIXI.Graphics;
  /** Remaining seconds of the current hit pulse (0 = idle). */
  pulseT:   number;
  /** Monotonic seed so each pulse scrawls with a fresh hand. */
  pulseSeed: number;
  rect:     Rect;
}

export class BoardView {
  readonly container: PIXI.Container;

  private readonly layout: ILayout;
  private readonly inactiveLaneLayer!: PIXI.Graphics;
  private readonly noBuildLayer: PIXI.Graphics;
  private readonly highlightLayer: PIXI.Graphics;

  private playerBase: BaseRef | null = null;
  private enemyBase:  BaseRef | null = null;
  private baseTime = 0;
  /** Monotonic seed so each accumulated crack scrawls with a fresh hand. */
  private crackSeed = 1;

  private readonly meteorPool = new ObjectPool<PIXI.Graphics>(
    () => new PIXI.Graphics(),
    (gfx) => { gfx.clear(); gfx.alpha = 1; gfx.removeFromParent(); },
    3,
    { label: 'fx.meteor', bytesEach: 2 * 1024 },
  );

  /** In-flight one-shot effect ticks (meteor), tracked so teardown can unregister them. */
  private readonly fxTicks = new Set<() => void>();

  constructor(layout: ILayout) {
    this.layout    = layout;
    this.container = new PIXI.Container();

    this.inactiveLaneLayer = new PIXI.Graphics();
    this.noBuildLayer   = new PIXI.Graphics();
    this.highlightLayer = new PIXI.Graphics();

    this.drawBoard();
    this.drawDecorations();
    this.drawBases(layout);
    this.container.addChild(this.inactiveLaneLayer); // below no-build + highlights
    this.container.addChild(this.noBuildLayer);
    this.container.addChild(this.highlightLayer);
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
      const r = this.laneRect(col);
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

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(dt: number): void {
    this.baseTime += dt;
    const t = this.baseTime;
    this.applyBasePulse(this.playerBase, t, 0);
    // Enemy base slightly out of phase
    this.applyBasePulse(this.enemyBase,  t, 1.2);
    this.applyHitPulse(this.playerBase, dt);
    this.applyHitPulse(this.enemyBase,  dt);
  }

  private applyBasePulse(base: BaseRef | null, t: number, phaseOffset: number): void {
    if (!base) return;
    const v = Math.sin(t * BASE_PULSE_SPEED + phaseOffset);
    base.sprite.alpha = BASE_ALPHA_MIN + BASE_ALPHA_RANGE * (v * 0.5 + 0.5); // map -1..1 → 0..1
  }

  /** Animate the under-attack outline: fade out + slight expand, then clear. */
  private applyHitPulse(base: BaseRef | null, dt: number): void {
    if (!base || base.pulseT <= 0) return;
    base.pulseT -= dt;
    if (base.pulseT <= 0) {
      base.pulseT = 0;
      base.pulseGfx.clear();
      return;
    }
    const frac = base.pulseT / BASE_HIT_PULSE_SEC;   // 1 → 0
    base.pulseGfx.alpha = frac;
    base.pulseGfx.scale.set(1 + (1 - frac) * BASE_HIT_PULSE_GROW);
  }

  // ── Base crack effect ─────────────────────────────────────────────────────

  /**
   * Accumulate pencil-sketch crack lines on a base when it takes damage.
   * No cracks above 85% HP; 2 cracks per hit below 40% HP.
   */
  playBaseCrackEffect(owner: 0 | 1, hp: number, maxHp: number): void {
    // `playerBase` is whichever base the local player owns (placed via
    // layout.playerBaseRect, which is localSide-aware). Map the event's raw
    // owner to the correct sprite so the joiner's cracks land on the right base.
    const localOwner = sideToOwner(this.layout.localSide);
    const base = owner === localOwner ? this.playerBase : this.enemyBase;
    if (!base) return;

    // Outline pulse on EVERY hit (immediate "this base got hit" feedback),
    // independent of the accumulated cracks below.
    this.triggerBaseHitPulse(base);

    const ratio = hp / maxHp;
    if (ratio > 0.85) return;

    const gfx = base.crackGfx;
    const hw = base.rect.w * 0.25;  // ±1/4 width, i.e. half the distance from center to edge
    const hh = base.rect.h * 0.25;
    const numCracks = ratio < 0.4 ? 2 : 1;

    // Draw with the shared hand-drawn pencil pen (art-direction §8) instead of a
    // raw line, so cracks read as scrawled marks. Seed bumps per call so each hit
    // adds a distinct jagged line on top of the accumulated ones.
    const pen = new SketchPen(gfx, (this.crackSeed++ * 0x9e3779b1) >>> 0 || 1);
    for (let i = 0; i < numCracks; i++) {
      // Random start near the base center (render-side jitter is fine).
      let x = (Math.random() * 2 - 1) * hw;
      let y = (Math.random() * 2 - 1) * hh;
      let dir = Math.random() * Math.PI * 2;
      const pts = [{ x, y }];
      for (let seg = 0; seg < 3; seg++) {   // 3-segment jagged line
        dir += (Math.random() - 0.5) * 1.2;
        x += Math.cos(dir) * (8 + Math.random() * 8);
        y += Math.sin(dir) * (8 + Math.random() * 8);
        pts.push({ x, y });
      }
      pen.stroke(pts, { color: palette.pencil, width: 1.3, alpha: 0.7, taper: 0.5, double: false });
    }
  }

  /**
   * Draw a hand-drawn red outline around the base footprint (centered on the
   * base container) and start its fade-out pulse. Red = the correcting pen /
   * damage; reads instantly as "under attack" on the clear-edged base bitmap.
   */
  private triggerBaseHitPulse(base: BaseRef): void {
    // Under sustained fire base_hp_changed fires almost every frame; don't restart
    // a pulse that's still animating, or it freezes at full alpha/scale (looks
    // like a static frame). Let the current pulse finish, then the next hit starts
    // a fresh one — a steady rhythm of expand-and-fade pulses.
    if (base.pulseT > 0) return;

    const g = base.pulseGfx;
    g.clear();
    g.alpha = 1;
    g.scale.set(1);
    const hw = base.rect.w / 2;
    const hh = base.rect.h / 2;
    const pen = new SketchPen(g, (base.pulseSeed++ * 0x9e3779b1) >>> 0 || 1);
    pen.rect(-hw - 3, -hh - 3, base.rect.w + 6, base.rect.h + 6, {
      color: palette.inkRed, width: 3, jitter: 1.4,
    });
    base.pulseT = BASE_HIT_PULSE_SEC;
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

  getPlayerBaseRect(): Rect {
    return this.layout.playerBaseRect();
  }

  // ── Placement highlights ──────────────────────────────────────────────────

  /**
   * Highlight unit lane columns with per-column state:
   * - blocked (spawn row occupied) → red
   * - hovered → brighter blue
   * - normal  → standard blue
   *
   * Works for both portrait (vertical stripes) and landscape (horizontal bands).
   */
  showUnitLaneHighlights(
    lanes: number[],
    blockedCols: Set<number>,
    hoveredCol: number,
  ): void {
    this.highlightLayer.clear();
    for (const col of lanes) {
      const isBlocked = blockedCols.has(col);
      const isHovered = col === hoveredCol;
      const color = isBlocked ? fx.laneBlocked : (isHovered ? fx.laneHover : HIGHLIGHT_LANE);
      const alpha = isBlocked ? 0.28 : (isHovered ? 0.30 : HIGHLIGHT_ALPHA);

      this.highlightLayer.beginFill(color, alpha);
      const r = this.laneRect(col);
      this.highlightLayer.drawRect(r.x, r.y, r.w, r.h);
      this.highlightLayer.endFill();
    }
  }

  showBuildingHighlights(validCols: number[], buildingRow: number): void {
    this.highlightLayer.clear();
    for (const col of validCols) {
      const pos = this.layout.gridToScreen(col, buildingRow);
      const cs  = this.layout.cellSize;
      this.highlightLayer.beginFill(HIGHLIGHT_BUILDING, HIGHLIGHT_ALPHA);
      this.highlightLayer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
      this.highlightLayer.endFill();
    }
  }

  /**
   * Show a 2×2 meteor target preview centered at (col, row) in game coords.
   * Draws a subtle full-board red tint + a bright 2×2 area.
   * Out-of-bounds cells are silently skipped.
   */
  showMeteorTargetHighlight(col: number, row: number): void {
    this.highlightLayer.clear();

    // Subtle full-board tint so the player knows meteor is selected
    const r = this.layout.boardRect;
    this.highlightLayer.beginFill(HIGHLIGHT_METEOR, 0.06);
    this.highlightLayer.drawRect(r.x, r.y, r.w, r.h);
    this.highlightLayer.endFill();

    // Bright 2×2 target area
    const cs = this.layout.cellSize;
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        const tc = col + dc;
        const tr = row + dr;
        if (tc < 0 || tc >= BOARD_COLS) continue;
        if (tr < 0 || tr >= BOARD_ROWS)  continue;
        const pos = this.layout.gridToScreen(tc, tr);
        this.highlightLayer.lineStyle(2, HIGHLIGHT_METEOR, 0.9);
        this.highlightLayer.beginFill(HIGHLIGHT_METEOR, 0.40);
        this.highlightLayer.drawRect(pos.x - cs / 2, pos.y - cs / 2, cs, cs);
        this.highlightLayer.endFill();
      }
    }
  }

  showBaseUpgradeHighlight(active: boolean): void {
    this.highlightLayer.clear();
    if (!active) return;
    const rect = this.layout.playerBaseRect();
    this.highlightLayer.beginFill(fx.upgrade, 0.3);
    this.highlightLayer.lineStyle(2, fx.upgrade, 0.8);
    this.highlightLayer.drawRect(rect.x, rect.y, rect.w, rect.h);
    this.highlightLayer.endFill();
  }

  clearHighlights(): void {
    this.highlightLayer.clear();
  }

  // ── One-shot effects ──────────────────────────────────────────────────────

  playMeteorEffect(col: number, row: number): void {
    const pos = this.layout.gridToScreen(col, row);
    const cs  = this.layout.cellSize;
    const gfx = this.meteorPool.acquire();
    gfx.lineStyle(4, fx.meteor);
    gfx.drawRect(pos.x - cs, pos.y - cs, cs * 2, cs * 2);
    this.container.addChild(gfx);

    let frames = 30;
    const tick = (): void => {
      gfx.alpha = frames / 30;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.fxTicks.delete(tick);
        this.meteorPool.release(gfx);
      }
    };
    this.fxTicks.add(tick);
    PIXI.Ticker.shared.add(tick);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Returns the screen-space rect for a single game-column lane.
   *
   * Portrait:  lane = vertical stripe (full board height, one column wide).
   * Landscape: lane = horizontal band (full board width, one column tall — because
   *            game cols map to screen Y in landscape).
   */
  private laneRect(gameCol: number): Rect {
    const r    = this.layout.boardRect;
    const cell = this.layout.cellSize;
    if (this.layout.orientation === 'portrait') {
      return { x: r.x + gameCol * cell, y: r.y, w: cell, h: r.h };
    }
    // In landscape, game col → screen Y band
    return { x: r.x, y: r.y + gameCol * cell, w: r.w, h: cell };
  }

  private drawBases(layout: ILayout): void {
    // Base art is a bitmap asset (art belongs to AI-drawn assets, not procedural
    // — see art-direction.md "Asset responsibility breakdown"). Enemy base mirrors by orientation.
    const baseTex = PIXI.Texture.from(baseTexUrl as string);
    this.playerBase = this.buildBaseRef(layout.playerBaseRect(), false, baseTex, layout);
    this.enemyBase  = this.buildBaseRef(layout.enemyBaseRect(),  true,  baseTex, layout);
  }

  private buildBaseRef(rect: Rect, mirror: boolean, tex: PIXI.Texture, layout: ILayout): BaseRef {
    const con = new PIXI.Container();
    con.x = rect.x + rect.w / 2;
    con.y = rect.y + rect.h / 2;

    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.width  = rect.w;
    s.height = rect.h;
    if (mirror) {
      // Distinguish the enemy base with a horizontal flip in BOTH orientations.
      // (Portrait used to flip vertically, but an upside-down castle reads as a
      // rendering bug — a left/right mirror is the cleaner distinction.)
      s.scale.x *= -1;
    }

    const crackGfx = new PIXI.Graphics();
    const pulseGfx = new PIXI.Graphics();   // under-attack outline, drawn on top
    con.addChild(s, crackGfx, pulseGfx);
    this.container.addChild(con);
    return { sprite: s, crackGfx, pulseGfx, pulseT: 0, pulseSeed: 1, rect };
  }

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
    const tex = bake(key, gfx, r.w, r.h);
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
    this.playerBase = null;
    this.enemyBase  = null;
    this.container.destroy({ children: true });
  }

}
