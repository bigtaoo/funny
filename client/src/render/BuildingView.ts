import * as PIXI from 'pixi.js-legacy';
import { Board } from '@nw/engine/Board';
import { Building } from '@nw/engine/Building';
import { BuildingType, Side } from '@nw/engine/types';
import { BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '@nw/engine/config';
import { palette } from './theme';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';
import barracksTexUrl from '../assets/buildings/game_infantry_barracks.png';
import archerTexUrl from '../assets/buildings/game_arrow_tower.png';

const SPRITE_SIZE = 56;
const HP_BAR_Y    = 32;
const HP_BAR_W    = 40;

// Idle animation constants
//
// The body idle used to be a vertical sp.y offset (±1.5px). That moved the sprite's *texture*
// while the HP bar and flag stayed drawn at the container's fixed coordinates — so the art
// visibly detached from its own health bar and flagpole every cycle, and combined with the
// tower's independent-frequency sway (below), two asynchronous position sources looked like
// jitter rather than breathing (user report 2026-08-25: "看着眼花，容易分散注意力"). A scale
// pulse fixes both problems at once: it can't desync from siblings drawn in the same local
// space, and the eye is far less sensitive to a few percent of size change than to the same
// magnitude of translation, so it reads as calm breathing even at a similar frequency.
const BOB_SPEED     = 6.98;   // rad/s → ~0.9s period
const BOB_SCALE_AMP = 0.012;  // ±1.2% size pulse, applied on top of each sprite's base scale
const FLAG_SPEED    = 9.0;   // rad/s — flag flutter (faster than body bob)
const FLAG_AMP      = 3.0;   // px wave amplitude
// Arrow tower. The sway used to be 5.0 rad/s / 0.5° — at SPRITE_SIZE that moves the roof tip by
// less than a third of a pixel, so the tower effectively had no idle animation at all while the
// barracks visibly fluttered its flag (user report 2026-08-19). Slower and wider now: a lazy lean,
// not a jitter.
const TOWER_SWAY    = 3.2;   // rad/s → ~2s period
const TOWER_SWAY_DEG = 1.6;  // degrees

// Fire feedback. The barracks' animated tell is its flag; a tower's is that you can SEE it shoot.
// Driven by real projectile_fired events (see playFireEffect), not a loop — a tower that has no
// target stays still, which is itself information.
const FIRE_SECONDS  = 0.26;  // recoil + ticks duration
const FIRE_KICK_PX  = 2.8;   // how far the tower kicks back, opposite the shot
// Recoil ticks: two short hand-drawn strokes BEHIND the tower. A first version drew a vibrating
// bowstring across the art's shooting gallery instead; the geometry was there (graphicsData === 2)
// but at SPRITE_SIZE it sat inside the busiest part of the drawing — the stone courses — and was
// invisible in a real capture. Ink that has to read at 56px belongs outside the silhouette.
const TICK_BACK     = 17;    // distance behind the tower centre, just clear of the art's body
const TICK_SPREAD   = 5;     // perpendicular offset of the two strokes
const TICK_LEN      = 8;     // stroke length at full strength

// ─── Pool factory / resetter ──────────────────────────────────────────────────

function createBuildingContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const sprite = new PIXI.Sprite();
  sprite.name = 'sprite';
  sprite.anchor.set(0.5);

  const hpBg = new PIXI.Graphics(); hpBg.name = 'hpBg';
  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-HP_BAR_W / 2, HP_BAR_Y, HP_BAR_W, 4);
  hpBg.endFill();

  const hpFill  = new PIXI.Graphics(); hpFill.name  = 'hpFill';
  const flagGfx = new PIXI.Graphics(); flagGfx.name = 'flagGfx';

  c.addChild(sprite, hpBg, hpFill, flagGfx);
  return c;
}

function resetBuildingContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha   = 1;
  c.angle   = 0;
  c.scale.set(1);
  c.visible = false;
  (c.getChildByName('hpFill')  as PIXI.Graphics).clear();
  (c.getChildByName('flagGfx') as PIXI.Graphics).clear();
  const sp = c.getChildByName('sprite') as PIXI.Sprite;
  sp.x     = 0;   // the fire kick writes sp.x — a pooled container must not inherit a stale offset
  sp.y     = 0;
  sp.angle = 0;
}

// ─── BuildingView ─────────────────────────────────────────────────────────────

export class BuildingView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites: Map<number, PIXI.Container> = new Map();
  private phases:  Map<number, number>          = new Map();
  /** Each sprite's non-idle scale (from SPRITE_SIZE / texture size) — the breathing pulse multiplies this. */
  private baseScales: Map<number, number>       = new Map();
  /** Cell + side per live building, so a fire event can be matched to the right sprite. */
  private cells:   Map<number, { col: number; row: number; side: Side }> = new Map();
  /** In-flight fire recoils: seconds left + the shot's screen-space unit vector. */
  private fires:   Map<number, { left: number; dx: number; dy: number }> = new Map();
  private readonly pool = new ObjectPool<PIXI.Container>(
    createBuildingContainer,
    resetBuildingContainer,
    12,
    // Building container: sprite + hpBg/hpFill/flag Graphics.
    { label: 'building', bytesEach: 6 * 1024 },
  );

  private texBarracks: PIXI.Texture | null = null;
  private texArcher:   PIXI.Texture | null = null;
  private time = 0;

  /** In-flight effect ticks (spawn/destroy anims), tracked so teardown can unregister them. */
  private readonly fxTicks = new Set<(dt: number) => void>();

  constructor(boardView: BoardView) {
    this.boardView = boardView;
    this.container = new PIXI.Container();
  }

  // ─── Per-frame update ─────────────────────────────────────────────────────

  update(dt: number): void {
    this.time += dt;
    for (const [id, fire] of this.fires) {
      fire.left -= dt;
      if (fire.left <= 0) this.fires.delete(id);
    }
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(board: Board): void {
    const seen = new Set<number>();

    for (const building of board.buildings.values()) {
      seen.add(building.id);

      let sprite = this.sprites.get(building.id);
      if (!sprite) {
        sprite = this.acquireSprite(building);
        this.sprites.set(building.id, sprite);
        this.container.addChild(sprite);
      }

      this.cells.set(building.id, { col: building.col, row: building.row, side: building.side });
      this.updateSprite(sprite, building);
      this.updateIdleAnim(sprite, building);
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.sprites.delete(id);
        this.phases.delete(id);
        this.baseScales.delete(id);
        this.cells.delete(id);
        this.fires.delete(id);
        this.pool.release(sprite);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  /**
   * A building fired a projectile: kick it back and trail recoil ticks for {@link FIRE_SECONDS}.
   *
   * Guarded by the origin cell, not just the id: `projectile_fired.attackerId` is a *building* id
   * when a tower shoots and a *unit* id when an archer shoots, and those two ids come from separate
   * counters (`allocBuildingId` / `allocUnitId`) — so they collide numerically and an archer's arrow
   * could otherwise make an unrelated tower recoil. A building's shot always originates exactly at
   * its own cell (`performBuildingAttack` → `fireProjectile(toFp(building.col), toFp(building.row))`),
   * which makes the cell a free, engine-guaranteed discriminator.
   */
  playFireEffect(buildingId: number, originCol: number, originRow: number): void {
    const cell = this.cells.get(buildingId);
    if (!cell || cell.col !== originCol || cell.row !== originRow) return;
    if (!this.sprites.has(buildingId)) return;

    const dir = this.shotDirection(cell);
    this.fires.set(buildingId, { left: FIRE_SECONDS, dx: dir.x, dy: dir.y });
  }

  playDestroyEffect(buildingId: number): void {
    const sprite = this.sprites.get(buildingId);
    if (!sprite) return;

    this.sprites.delete(buildingId);
    this.phases.delete(buildingId);
    this.baseScales.delete(buildingId);
    this.cells.delete(buildingId);
    this.fires.delete(buildingId);

    let frames = 20;
    const tick = (): void => {
      sprite.angle += 5;
      sprite.alpha  = frames / 20;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.fxTicks.delete(tick);
        this.pool.release(sprite);
      }
    };
    this.fxTicks.add(tick);
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private acquireSprite(building: Building): PIXI.Container {
    const c = this.pool.acquire();
    c.visible = true;

    this.phases.set(building.id, Math.random() * Math.PI * 2);

    const sp = c.getChildByName('sprite') as PIXI.Sprite;
    if (building.buildingType === BuildingType.Barracks) {
      if (!this.texBarracks) this.texBarracks = PIXI.Texture.from(barracksTexUrl as string);
      sp.texture = this.texBarracks;
    } else {
      if (!this.texArcher) this.texArcher = PIXI.Texture.from(archerTexUrl as string);
      sp.texture = this.texArcher;
    }
    sp.width  = SPRITE_SIZE;
    sp.height = SPRITE_SIZE;
    this.baseScales.set(building.id, sp.scale.x);

    // Spawn animation: scale 0→1, ease-out cubic, ~0.3s at 60fps
    c.scale.set(0);
    let elapsed = 0;
    const DURATION = 18;
    const onTick = (dt: number): void => {
      elapsed += dt;
      const t     = Math.min(elapsed / DURATION, 1);
      const scale = 1 - Math.pow(1 - t, 3);
      c.scale.set(scale);
      if (t >= 1) {
        PIXI.Ticker.shared.remove(onTick);
        this.fxTicks.delete(onTick);
      }
    };
    this.fxTicks.add(onTick);
    PIXI.Ticker.shared.add(onTick);

    return c;
  }

  private updateSprite(c: PIXI.Container, building: Building): void {
    const { x, y } = this.boardView.gridToScreen(building.col, building.row);
    c.x = x;
    c.y = y;

    const hpFill = c.getChildByName('hpFill') as PIXI.Graphics;
    hpFill.clear();
    const ratio = Math.max(0, building.hp_fp / building.maxHp_fp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
    hpFill.drawRect(-HP_BAR_W / 2, HP_BAR_Y, HP_BAR_W * ratio, 4);
    hpFill.endFill();
  }

  private updateIdleAnim(c: PIXI.Container, building: Building): void {
    const phase = this.phases.get(building.id) ?? 0;
    const base  = this.baseScales.get(building.id) ?? 1;
    const t     = this.time;
    const sp    = c.getChildByName('sprite') as PIXI.Sprite;

    // All buildings: gentle size-pulse breathing (see BOB_SCALE_AMP comment for why this
    // replaced a positional bob). Scale only — sp.y stays at 0 so the sprite never drifts
    // from the HP bar / flag drawn in the same container-local space.
    sp.scale.set(base * (1 + Math.sin(t * BOB_SPEED + phase) * BOB_SCALE_AMP));

    const flagGfx = c.getChildByName('flagGfx') as PIXI.Graphics;

    if (building.buildingType === BuildingType.Barracks) {
      this.drawFlagWave(flagGfx, t, phase);
      return;
    }

    // Arrow tower: idle lean, plus the recoil + bowstring twang of a shot in flight.
    sp.angle = Math.sin(t * TOWER_SWAY + phase) * TOWER_SWAY_DEG;

    const fire = this.fires.get(building.id);
    if (!fire) {
      sp.x = 0;
      sp.y = 0;
      flagGfx.clear();
      return;
    }

    // Two curves on purpose. The KICK is squared — it lands hard on the shot and settles back
    // fast, which is what a recoil feels like. The TICKS fade linearly, because on the squared
    // curve they were at full strength for ~40ms (2-3 frames at 60fps) and a real capture couldn't
    // see them at all: a 7px ink stroke needs to be on screen long enough to register.
    const left = fire.left / FIRE_SECONDS;
    sp.x  = -fire.dx * FIRE_KICK_PX * left * left;
    sp.y  = -fire.dy * FIRE_KICK_PX * left * left;
    this.drawFireTicks(flagGfx, left, fire.dx, fire.dy);
  }

  /**
   * Two short strokes trailing off the back of the tower as it kicks — the doodle-book way of
   * saying "this thing just went off". Drawn on the `flagGfx` node, which the tower branch used to
   * leave permanently empty, and in the same ink as the tower art.
   */
  private drawFireTicks(gfx: PIXI.Graphics, strength: number, dx: number, dy: number): void {
    gfx.clear();
    const bx = -dx * TICK_BACK, by = -dy * TICK_BACK;   // behind the tower, along the shot axis
    const px = -dy,             py = dx;                // perpendicular to it
    const len = TICK_LEN * (0.45 + 0.55 * strength);    // shrinks as it fades, never to nothing
    gfx.lineStyle(1.8, palette.inkBlue, 0.25 + 0.7 * strength);
    for (const sign of [1, -1]) {
      const ox = bx + px * TICK_SPREAD * sign;
      const oy = by + py * TICK_SPREAD * sign;
      gfx.moveTo(ox, oy);
      gfx.lineTo(ox - dx * len, oy - dy * len);
    }
  }

  /**
   * Unit vector, in screen space, from a building's cell toward the enemy building row — the way
   * its shots go, and (negated) the way it kicks. Recomputed per shot rather than cached because
   * the same cell maps to a different screen direction after an orientation flip (landscape lays
   * the columns out along y).
   */
  private shotDirection(cell: { col: number; row: number; side: Side }): { x: number; y: number } {
    const enemyRow = cell.side === Side.Bottom ? TOP_BUILDING_ROW : BOTTOM_BUILDING_ROW;
    const from = this.boardView.gridToScreen(cell.col, cell.row);
    const to   = this.boardView.gridToScreen(cell.col, enemyRow);
    const dx   = to.x - from.x;
    const dy   = to.y - from.y;
    const len  = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  /** Draw an animated hand-drawn flag at the top of a barracks. */
  private drawFlagWave(gfx: PIXI.Graphics, t: number, phase: number): void {
    gfx.clear();
    const amp = Math.sin(t * FLAG_SPEED + phase) * FLAG_AMP;

    // Flagpole: short vertical stroke at top-right of sprite
    const px = 12, poleTop = -30;
    gfx.lineStyle(1, 0x444444, 0.75);
    gfx.moveTo(px, poleTop + 10);
    gfx.lineTo(px, poleTop);

    // Three wavy flag strokes emanating from the pole
    for (let i = 0; i < 3; i++) {
      const fy       = poleTop + i * 3;
      const waveAmp  = amp * (0.6 + i * 0.2);
      gfx.moveTo(px, fy);
      gfx.quadraticCurveTo(px + 7, fy + waveAmp, px + 13, fy + waveAmp * 0.3);
    }
  }

  /**
   * Tear down everything this view owns. Unregisters in-flight effect ticks,
   * destroys the detached pool sprites, then destroys the container subtree.
   * texBarracks/texArcher come from the shared `PIXI.Texture.from` cache (reused
   * across battles) and are intentionally only dereferenced, never destroyed.
   */
  destroy(): void {
    for (const tick of this.fxTicks) PIXI.Ticker.shared.remove(tick);
    this.fxTicks.clear();
    this.pool.drain((c) => c.destroy({ children: true }));
    this.sprites.clear();
    this.phases.clear();
    this.baseScales.clear();
    this.cells.clear();
    this.fires.clear();
    this.texBarracks = null;
    this.texArcher   = null;
    this.container.destroy({ children: true });
  }
}
