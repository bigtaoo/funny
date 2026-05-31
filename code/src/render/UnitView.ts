import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { Side, UnitType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';

/** Notebook aesthetic unit colors */
const UNIT_COLORS: Record<UnitType, number> = {
  [UnitType.Swordsman]: 0x222222, // pencil black
  [UnitType.Guardian]:  0x1a3a8a, // ballpoint blue
  [UnitType.Archer]:    0xcc2200, // red marker
};

const SIDE_TINT: Record<Side, number> = {
  [Side.Bottom]: 0x4488ff, // player = blue ring
  [Side.Top]:    0xff6622, // enemy  = orange ring
};

const RADIUS       = 10;
const HP_BAR_WIDTH = 20;
const HP_BAR_HEIGHT = 3;

// ─── Pool factory / resetter ──────────────────────────────────────────────────

function createUnitContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const body   = new PIXI.Graphics(); body.name   = 'body';
  const ring   = new PIXI.Graphics(); ring.name   = 'ring';
  const hpBg   = new PIXI.Graphics(); hpBg.name   = 'hpBg';
  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  // hpBg is static — drawn once here, reused every acquire
  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH, HP_BAR_HEIGHT);
  hpBg.endFill();

  c.addChild(body, ring, hpBg, hpFill);
  return c;
}

function resetUnitContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha   = 1;
  c.scale.set(1);
  c.visible = false;
  // Clear dynamic graphics; static hpBg is left as-is
  (c.getChildByName('hpFill') as PIXI.Graphics).clear();
}

// ─── UnitView ─────────────────────────────────────────────────────────────────

export class UnitView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites: Map<number, PIXI.Container> = new Map();
  private readonly pool = new ObjectPool<PIXI.Container>(
    createUnitContainer,
    resetUnitContainer,
    20, // prewarm — covers a typical peak unit count
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

    // Return sprites for units no longer on the board to the pool
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.sprites.delete(id);
        // Release only if not already mid-animation (death effect removes from map early)
        this.pool.release(sprite);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  playHitEffect(unitId: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;

    let frames = 6;
    const tick = (): void => {
      // Guard: sprite may have been released to pool mid-flash
      if (!this.sprites.has(unitId)) {
        PIXI.Ticker.shared.remove(tick);
        return;
      }
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

    // Remove from map immediately so sync() won't release it while the animation runs
    this.sprites.delete(unitId);

    let frames = 20;
    const tick = (): void => {
      sprite.alpha = frames / 20;
      sprite.scale.set(1 + (1 - frames / 20) * 0.5);
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.pool.release(sprite); // return to pool instead of destroy
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Acquire a container from the pool and configure it for the given unit. */
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
    const rowExact = unit.rowExact;
    const { x, y } = this.boardView.gridToScreen(unit.colExact, rowExact);
    sprite.x = x;
    sprite.y = y;

    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics;
    hpFill.clear();
    const ratio = Math.max(0, unit.hp / unit.maxHp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
    hpFill.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH * ratio, HP_BAR_HEIGHT);
    hpFill.endFill();
  }
}
