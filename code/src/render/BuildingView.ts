import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Building } from '../game/Building';
import { BuildingType, Side } from '../game/types';

const BUILDING_COLORS: Record<BuildingType, number> = {
  [BuildingType.Barracks]:   0x2a6a2a, // green marker
  [BuildingType.ArrowTower]: 0x1a3a8a, // blue marker (thicker lines)
};

export class BuildingView {
  readonly container: PIXI.Container;
  private sprites: Map<number, PIXI.Container> = new Map();

  constructor() {
    this.container = new PIXI.Container();
  }

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
      // Arrow tower: trapezoid
      gfx.lineStyle(3, color);
      gfx.drawPolygon([-10, 16, 10, 16, 8, -8, -8, -8]);
      // Triangle roof
      gfx.drawPolygon([-10, -8, 10, -8, 0, -22]);
    }

    // HP bar placeholder (will be replaced by proper UI)
    const hpBg = new PIXI.Graphics();
    hpBg.beginFill(0xcccccc);
    hpBg.drawRect(-16, 18, 32, 4);
    hpBg.endFill();

    c.addChild(gfx, hpBg);
    return c;
  }

  private updateSprite(sprite: PIXI.Container, building: Building): void {
    sprite.x = building.col * 48 + 24;
    sprite.y = building.row * 47 + 24;

    // Update HP bar (second child)
    const hpBar = sprite.children[1] as PIXI.Graphics;
    if (hpBar) {
      hpBar.clear();
      hpBar.beginFill(0x44aa44);
      hpBar.drawRect(-16, 18, 32 * (building.hp / building.maxHp), 4);
      hpBar.endFill();
    }
  }
}
