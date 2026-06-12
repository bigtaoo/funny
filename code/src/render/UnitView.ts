import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { Side, UnitState, UnitType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';
import { StickmanRuntime } from './stickman/StickmanRuntime';
import type { TaoAsset } from './stickman/StickmanRuntime';
import infantryTaoUrl from '../assets/infantry.tao';

const UNIT_COLORS: Record<UnitType, number> = {
  [UnitType.Swordsman]: 0x222222,
  [UnitType.Guardian]:  0x1a3a8a,
  [UnitType.Archer]:    0xcc2200,
  [UnitType.Ironclad]:  0x556677,  // steel — heavy armor
  [UnitType.Runner]:    0xddaa22,  // amber — fast rusher
};

const SIDE_TINT: Record<Side, number> = {
  [Side.Bottom]: 0x4488ff,
  [Side.Top]:    0xff6622,
};

const RADIUS        = 10;
const HP_BAR_WIDTH  = 20;
const HP_BAR_HEIGHT = 3;
/** HP bar Y offset above the unit centre (works for both circle and stickman). */
const HP_BAR_Y      = -(RADIUS + 8);
/** Render frames the HP bar stays fully visible after a hit (~2 s at 60 fps). */
const HP_SHOW_FRAMES  = 120;
/** Render frames to fade out after HP_SHOW_FRAMES. */
const HP_FADE_FRAMES  = 30;
const HP_TOTAL_FRAMES = HP_SHOW_FRAMES + HP_FADE_FRAMES;

// ── Pool factory / resetter (Guardian & Archer circle placeholder) ─────────────

function createUnitContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const body   = new PIXI.Graphics(); body.name   = 'body';
  const ring   = new PIXI.Graphics(); ring.name   = 'ring';
  const hpBg   = new PIXI.Graphics(); hpBg.name   = 'hpBg';
  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-HP_BAR_WIDTH / 2, HP_BAR_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT);
  hpBg.endFill();
  hpBg.visible  = false;
  hpFill.visible = false;

  c.addChild(body, ring, hpBg, hpFill);
  return c;
}

function resetUnitContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha   = 1;
  c.scale.set(1);
  c.visible = false;
  (c.getChildByName('hpFill') as PIXI.Graphics).clear();
  (c.getChildByName('hpBg')   as PIXI.Graphics).visible  = false;
  (c.getChildByName('hpFill') as PIXI.Graphics).visible  = false;
}

// ── UnitView ──────────────────────────────────────────────────────────────────

export class UnitView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;

  /** All active unit display containers (circle or stickman wrapper), keyed by unit id. */
  private sprites: Map<number, PIXI.Container> = new Map();

  /** Active StickmanRuntime instances for Swordsman units. */
  private readonly stickmanRuntimes: Map<number, StickmanRuntime> = new Map();

  /**
   * Pool of idle stickman (wrapper + runtime) pairs for reuse. Swordsmen are
   * the high-frequency unit, so reusing their ~11-sprite runtimes instead of
   * new/destroy per spawn is the main swarm-performance lever.
   */
  private readonly stickmanPool: Array<{ wrapper: PIXI.Container; runtime: StickmanRuntime }> = [];

  /**
   * Per-unit HP bar visibility timer (render frames remaining).
   * 0 = hidden. Decremented every render frame in sync().
   */
  private hpTimers: Map<number, number> = new Map();

  /** Loaded once for all Swordsman units; null until the fetch resolves. */
  private infantryAsset: TaoAsset | null = null;

  private readonly pool = new ObjectPool<PIXI.Container>(
    createUnitContainer,
    resetUnitContainer,
    20,
  );

  constructor(boardView: BoardView) {
    this.boardView = boardView;
    this.container = new PIXI.Container();

    // Start loading the infantry asset in the background.
    // The game will be playable before the first unit can spawn, so by the
    // time acquireSprite() is called for a Swordsman this Promise will be settled.
    StickmanRuntime.loadAsset(infantryTaoUrl as unknown as string)
      .then(asset => { this.infantryAsset = asset; })
      .catch(err  => { console.warn('[UnitView] infantry.tao failed to load:', err); });
  }

  // ── Per-frame sync ────────────────────────────────────────────────────────

  /**
   * @param board  Current board state.
   * @param dt     Wall-clock delta in seconds (used to advance stickman animations).
   */
  sync(board: Board, dt: number): void {
    const seen = new Set<number>();

    for (const unit of board.units.values()) {
      seen.add(unit.id);

      let sprite = this.sprites.get(unit.id);
      if (!sprite) {
        sprite = this.acquireSprite(unit);
        this.sprites.set(unit.id, sprite);
        this.container.addChild(sprite);
      }

      // Update stickman animation state + advance clock
      const runtime = this.stickmanRuntimes.get(unit.id);
      if (runtime) {
        runtime.syncState(unit.state);
        runtime.update(dt);
      }

      this.updateSprite(sprite, unit);
    }

    // Tick HP timers
    for (const [id, timer] of this.hpTimers) {
      if (!this.sprites.has(id)) { this.hpTimers.delete(id); continue; }
      const newTimer = timer - 1;
      if (newTimer <= 0) {
        this.hpTimers.delete(id);
        this.setHpBarVisible(id, false, 1);
      } else {
        this.hpTimers.set(id, newTimer);
        const alpha = newTimer <= HP_FADE_FRAMES ? newTimer / HP_FADE_FRAMES : 1;
        this.setHpBarVisible(id, true, alpha);
      }
    }

    // Return sprites for gone units
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.releaseUnit(id, sprite);
      }
    }
  }

  // ── Event-driven effects ──────────────────────────────────────────────────

  /**
   * Show the HP bar for `unitId` for ~3 seconds, then fade out.
   * Called when the unit receives a hit.
   */
  showHpBar(unitId: number): void {
    this.hpTimers.set(unitId, HP_TOTAL_FRAMES);
  }

  playHitEffect(unitId: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;

    let frames = 6;
    const tick = (): void => {
      if (!this.sprites.has(unitId)) { PIXI.Ticker.shared.remove(tick); return; }
      sprite.alpha = frames % 2 === 0 ? 0.3 : 1;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        sprite.alpha = 1;
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  playDeathEffect(unitId: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;

    this.sprites.delete(unitId);
    this.hpTimers.delete(unitId);

    // Switch to death animation while fading out
    const runtime = this.stickmanRuntimes.get(unitId);
    if (runtime) runtime.play('death');

    let frames = 20;
    const tick = (): void => {
      sprite.alpha = frames / 20;
      sprite.scale.set(1 + (1 - frames / 20) * 0.5);
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.releaseUnit(unitId, sprite);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private acquireSprite(unit: Unit): PIXI.Container {
    if (unit.unitType === UnitType.Swordsman && this.infantryAsset) {
      return this.buildStickmanContainer(unit);
    }
    return this.buildCircleContainer(unit);
  }

  // ─── Stickman container (Swordsman with loaded asset) ─────────────────────

  private buildStickmanContainer(unit: Unit): PIXI.Container {
    const mirrorX = unit.side === Side.Top;

    // Reuse a pooled (wrapper + runtime) pair when available.
    const pooled = this.stickmanPool.pop();
    if (pooled) {
      pooled.runtime.reset({ mirrorX });
      pooled.wrapper.visible = true;
      pooled.wrapper.alpha   = 1;
      pooled.wrapper.scale.set(1);
      const hpBg   = pooled.wrapper.getChildByName('hpBg')   as PIXI.Graphics;
      const hpFill = pooled.wrapper.getChildByName('hpFill') as PIXI.Graphics;
      hpBg.visible = false;
      hpFill.visible = false;
      hpFill.clear();
      this.stickmanRuntimes.set(unit.id, pooled.runtime);
      return pooled.wrapper;
    }

    const wrapper = new PIXI.Container();
    wrapper.visible = true;

    const runtime = new StickmanRuntime(this.infantryAsset!, { mirrorX });
    this.stickmanRuntimes.set(unit.id, runtime);

    // ── HP bar (positioned above the character's head) ────────────────────
    // At STICKMAN_SCALE=0.27, spine (68px) + head (24px) ≈ 25px above root.
    // We place the bar a few pixels higher than that.
    const HP_BAR_Y_STICKMAN = -32;

    const hpBg = new PIXI.Graphics();
    hpBg.name = 'hpBg';
    hpBg.beginFill(0xcccccc, 0.7);
    hpBg.drawRect(-HP_BAR_WIDTH / 2, HP_BAR_Y_STICKMAN, HP_BAR_WIDTH, HP_BAR_HEIGHT);
    hpBg.endFill();
    hpBg.visible = false;

    const hpFill = new PIXI.Graphics();
    hpFill.name    = 'hpFill';
    hpFill.visible = false;

    wrapper.addChild(runtime.container, hpBg, hpFill);
    return wrapper;
  }

  // ─── Circle container (Guardian / Archer, or Swordsman before asset loads) ──

  private buildCircleContainer(unit: Unit): PIXI.Container {
    const c = this.pool.acquire();
    c.visible = true;

    const body = c.getChildByName('body') as PIXI.Graphics;
    body.clear();
    body.beginFill(UNIT_COLORS[unit.unitType]);
    body.drawCircle(0, 0, RADIUS);
    body.endFill();

    const ring = c.getChildByName('ring') as PIXI.Graphics;
    ring.clear();
    ring.lineStyle(2, SIDE_TINT[unit.side]);
    ring.drawCircle(0, 0, RADIUS + 2);

    return c;
  }

  // ─── Sprite position update ───────────────────────────────────────────────

  private updateSprite(sprite: PIXI.Container, unit: Unit): void {
    const { x, y } = this.boardView.gridToScreen(unit.colExact, unit.rowExact);
    sprite.x = x;
    sprite.y = y;

    // HP bar fill — always up-to-date so it's correct when made visible
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (!hpFill) return;
    hpFill.clear();
    const ratio = Math.max(0, unit.hp / unit.maxHp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);

    // Determine HP bar Y offset: stickman containers have their own y offset baked in.
    const isStickman = this.stickmanRuntimes.has(unit.id);
    const barY = isStickman ? -32 : HP_BAR_Y;
    hpFill.drawRect(-HP_BAR_WIDTH / 2, barY, HP_BAR_WIDTH * ratio, HP_BAR_HEIGHT);
    hpFill.endFill();
  }

  // ─── HP bar visibility ────────────────────────────────────────────────────

  private setHpBarVisible(unitId: number, visible: boolean, alpha: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;
    const hpBg   = sprite.getChildByName('hpBg')   as PIXI.Graphics | null;
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (hpBg)   { hpBg.visible   = visible; hpBg.alpha   = alpha; }
    if (hpFill) { hpFill.visible = visible; hpFill.alpha = alpha; }
  }

  // ─── Releasing a unit back to pool ────────────────────────────────────────

  private releaseUnit(unitId: number, sprite: PIXI.Container): void {
    this.sprites.delete(unitId);
    this.hpTimers.delete(unitId);

    const runtime = this.stickmanRuntimes.get(unitId);
    if (runtime) {
      this.stickmanRuntimes.delete(unitId);
      // Return the (wrapper + runtime) pair to the pool instead of destroying.
      sprite.removeFromParent();
      sprite.visible = false;
      this.stickmanPool.push({ wrapper: sprite, runtime });
    } else {
      this.pool.release(sprite);
    }
  }
}
