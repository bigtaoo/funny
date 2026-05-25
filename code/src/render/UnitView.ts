import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { Side, UnitType } from '../game/types';

/** Notebook aesthetic unit colors (art direction §3.2) */
const UNIT_COLORS: Record<UnitType, number> = {
  [UnitType.Swordsman]: 0x222222, // pencil black
  [UnitType.Guardian]:  0x1a3a8a, // ballpoint blue
  [UnitType.Archer]:    0xcc2200, // red marker
};

const SIDE_MARKER: Record<Side, number> = {
  [Side.Bottom]: 0x4488ff, // blue dot = player
  [Side.Top]:    0xff6622, // orange dot = enemy
};

export class UnitView {
  readonly container: PIXI.Container;

  /** Sprite (placeholder graphics) per unit id */
  private sprites: Map<number, PIXI.Container> = new Map();

  constructor() {
    this.container = new PIXI.Container();
  }

  /** Called every frame — adds/removes/moves sprites to match board state */
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

    // Remove sprites for removed units
    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.container.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  playHitEffect(unitId: number): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;

    // Flash white briefly
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

  private createSprite(unit: Unit): PIXI.Container {
    const c = new PIXI.Container();

    // Placeholder: circle (tube-style body will replace this)
    const body = new PIXI.Graphics();
    body.beginFill(UNIT_COLORS[unit.unitType]);
    body.drawCircle(0, 0, 8);
    body.endFill();

    // Side marker dot on top
    const marker = new PIXI.Graphics();
    marker.beginFill(SIDE_MARKER[unit.side]);
    marker.drawCircle(0, -12, 3);
    marker.endFill();

    c.addChild(body, marker);

    // Flip enemy units horizontally
    if (unit.side === Side.Top) c.scale.x = -1;

    return c;
  }

  private updateSprite(sprite: PIXI.Container, unit: Unit): void {
    // Position will be set by the BoardView coordinate mapping
    // For now, use col × 48 + 24 and row × 47 + 24 (approximate)
    sprite.x = unit.col * 48 + 24;
    sprite.y = unit.row * 47 + 24;
  }
}
