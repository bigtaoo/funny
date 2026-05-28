import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { FP_SCALE } from '../game/math/fixed';
import { Side, UnitType } from '../game/types';
import { BoardView } from './BoardView';

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

const RADIUS = 10; // circle radius in pixels (placeholder)
const HP_BAR_WIDTH = 20;
const HP_BAR_HEIGHT = 3;

export class UnitView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites: Map<number, PIXI.Container> = new Map();

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
        sprite = this.createSprite(unit);
        this.sprites.set(unit.id, sprite);
        this.container.addChild(sprite);
      }

      this.updateSprite(sprite, unit);
    }

    // Remove sprites for units no longer on the board
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.container.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  playHitEffect(unitId: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;

    let frames = 6;
    const tick = (): void => {
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

    let frames = 20;
    const tick = (): void => {
      sprite.alpha = frames / 20;
      sprite.scale.set(1 + (1 - frames / 20) * 0.5);
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.container.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(unitId);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private createSprite(unit: Unit): PIXI.Container {
    const c = new PIXI.Container();

    // Body circle
    const body = new PIXI.Graphics();
    body.name = 'body';
    body.beginFill(UNIT_COLORS[unit.unitType]);
    body.drawCircle(0, 0, RADIUS);
    body.endFill();

    // Side ring (hollow circle showing player/enemy)
    const ring = new PIXI.Graphics();
    ring.lineStyle(2, SIDE_TINT[unit.side]);
    ring.drawCircle(0, 0, RADIUS + 2);

    // HP bar background
    const hpBg = new PIXI.Graphics();
    hpBg.name = 'hpBg';
    hpBg.beginFill(0xcccccc, 0.7);
    hpBg.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH, HP_BAR_HEIGHT);
    hpBg.endFill();

    // HP bar fill (will be redrawn each frame)
    const hpFill = new PIXI.Graphics();
    hpFill.name = 'hpFill';

    c.addChild(body, ring, hpBg, hpFill);
    return c;
  }

  private updateSprite(sprite: PIXI.Container, unit: Unit): void {
    // Smooth sub-row positioning using fixed-point y
    const rowExact = unit.y_fp / FP_SCALE;
    const { x, y } = this.boardView.gridToScreen(unit.col, rowExact);
    sprite.x = x;
    sprite.y = y;

    // Update HP bar fill
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (hpFill) {
      hpFill.clear();
      const ratio = Math.max(0, unit.hp / unit.maxHp);
      hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
      hpFill.drawRect(-HP_BAR_WIDTH / 2, -(RADIUS + 8), HP_BAR_WIDTH * ratio, HP_BAR_HEIGHT);
      hpFill.endFill();
    }
  }
}
