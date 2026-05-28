import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Building } from '../game/Building';
import { BuildingType } from '../game/types';
import { BoardView } from './BoardView';

const BUILDING_COLORS: Record<BuildingType, number> = {
  [BuildingType.Barracks]:   0x2a6a2a, // green marker
  [BuildingType.ArrowTower]: 0x1a3a8a, // blue marker
};

export class BuildingView {
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

    for (const building of board.buildings.values()) {
      seen.add(building.id);

      let sprite = this.sprites.get(building.id);
      if (!sprite) {
        sprite = this.createSprite(building);
        this.sprites.set(building.id, sprite);
        this.container.addChild(sprite);
      }

      this.updateSprite(sprite, building);
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.container.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  playDestroyEffect(buildingId: number): void {
    const sprite = this.sprites.get(buildingId);
    if (!sprite) return;

    let frames = 20;
    const tick = (): void => {
      sprite.angle += 5;
      sprite.alpha = frames / 20;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.container.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(buildingId);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private createSprite(building: Building): PIXI.Container {
    const c = new PIXI.Container();
    const gfx = new PIXI.Graphics();
    const color = BUILDING_COLORS[building.buildingType];

    if (building.buildingType === BuildingType.Barracks) {
      // Simple house shape
      gfx.lineStyle(3, color);
      gfx.drawRect(-16, -12, 32, 24);
      // Flag
      gfx.moveTo(16, -12);
      gfx.lineTo(16, -24);
      gfx.lineTo(26, -18);
      gfx.lineTo(16, -12);
    } else {
      // Arrow tower: trapezoid body
      gfx.lineStyle(3, color);
      gfx.drawPolygon([-10, 16, 10, 16, 8, -8, -8, -8]);
      // Triangle roof
      gfx.drawPolygon([-10, -8, 10, -8, 0, -22]);
    }

    // HP bar background
    const hpBg = new PIXI.Graphics();
    hpBg.beginFill(0xcccccc, 0.7);
    hpBg.drawRect(-16, 20, 32, 4);
    hpBg.endFill();

    // HP bar fill
    const hpFill = new PIXI.Graphics();
    hpFill.name = 'hpFill';

    c.addChild(gfx, hpBg, hpFill);
    return c;
  }

  private updateSprite(sprite: PIXI.Container, building: Building): void {
    const { x, y } = this.boardView.gridToScreen(building.col, building.row);
    sprite.x = x;
    sprite.y = y;

    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (hpFill) {
      hpFill.clear();
      const ratio = Math.max(0, building.hp / building.maxHp);
      hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
      hpFill.drawRect(-16, 20, 32 * ratio, 4);
      hpFill.endFill();
    }
  }
}
