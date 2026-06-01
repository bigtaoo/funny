import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { Side, UnitType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';

const UNIT_COLORS: Record<UnitType, number> = {
  [UnitType.Swordsman]: 0x222222,
  [UnitType.Guardian]:  0x1a3a8a,
  [UnitType.Archer]:    0xcc2200,
};

const SIDE_TINT: Record<Side, number> = {
  [Side.Bottom]: 0x4488ff,
  [Side.Top]:    0xff6622,
};

const RADIUS        = 10;
const HP_BAR_WIDTH  = 20;
const HP_BAR_HEIGHT = 3;
/** Render frames the HP bar stays fully visible after a hit (~2 s at 60 fps). */
const HP_SHOW_FRAMES = 120;
/** Render frames to fade out after HP_SHOW_FRAMES. */
const HP_FADE_FRAMES = 30;
const HP_TOTAL_FRAMES = HP_SHOW_FRAMES + HP_FADE_FRAMES;

// ─── Pool factory / resetter ──────────────────────────────────────────────────

function createUnitContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const body   = new PIXI.Graphics(); body.name   = 'body';
  const ring   = new PIXI.Graphics(); ring.name   = 'ring';
  const hpBg   = new PIXI.Graphics(); hpBg.name   = 'hpBg';
  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH, HP_BAR_HEIGHT);
  hpBg.endFill();
  hpBg.visible = false;

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
  (c.getChildByName('hpBg')   as PIXI.Graphics).visible   = false;
  (c.getChildByName('hpFill') as PIXI.Graphics).visible   = false;
}

// ─── UnitView ─────────────────────────────────────────────────────────────────

export class UnitView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites:    Map<number, PIXI.Container> = new Map();
  /**
   * Per-unit HP bar visibility timer (render frames remaining).
   * 0 = hidden. Decremented every render frame in sync().
   */
  private hpTimers:   Map<number, number> = new Map();

  private readonly pool = new ObjectPool<PIXI.Container>(
    createUnitContainer,
    resetUnitContainer,
    20,
  );

  constructor(boardView: BoardView) {
    this.boardView = boardView;
    this.container = new PIXI.Container();
  }

  // ─── Per-frame sync ───────────────────────────────────────────────────────

  sync(board: Board): void {
    const seen = new Set<number>();

    for (const unit of board.units.values()) {
      seen.add(unit.id);

      let sprite = this.sprites.get(unit.id);
      if (!sprite) {
        sprite = this.acquireSprite(unit);
        this.sprites.set(unit.id, sprite);
        this.container.addChild(sprite);
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
        this.sprites.delete(id);
        this.hpTimers.delete(id);
        this.pool.release(sprite);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

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

    let frames = 20;
    const tick = (): void => {
      sprite.alpha = frames / 20;
      sprite.scale.set(1 + (1 - frames / 20) * 0.5);
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.pool.release(sprite);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private acquireSprite(unit: Unit): PIXI.Container {
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

  private updateSprite(sprite: PIXI.Container, unit: Unit): void {
    const { x, y } = this.boardView.gridToScreen(unit.colExact, unit.rowExact);
    sprite.x = x;
    sprite.y = y;

    // HP bar fill — always up-to-date so it's correct when made visible
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics;
    hpFill.clear();
    const ratio = Math.max(0, unit.hp / unit.maxHp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
    hpFill.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH * ratio, HP_BAR_HEIGHT);
    hpFill.endFill();
  }

  private setHpBarVisible(unitId: number, visible: boolean, alpha: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;
    const hpBg   = sprite.getChildByName('hpBg')   as PIXI.Graphics;
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics;
    hpBg.visible   = visible;
    hpFill.visible  = visible;
    hpBg.alpha   = alpha;
    hpFill.alpha = alpha;
  }
}
