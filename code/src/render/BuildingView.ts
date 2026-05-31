import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Building } from '../game/Building';
import { BuildingType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';

const BUILDING_COLORS: Record<BuildingType, number> = {
  [BuildingType.Barracks]:   0x2a6a2a, // green marker
  [BuildingType.ArrowTower]: 0x1a3a8a, // blue marker
};

// ─── Pool factory / resetter ──────────────────────────────────────────────────

function createBuildingContainer(): PIXI.Container {
  const c = new PIXI.Container();

  const gfx    = new PIXI.Graphics(); gfx.name    = 'gfx';
  const hpBg   = new PIXI.Graphics(); hpBg.name   = 'hpBg';
  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  hpBg.beginFill(0xcccccc, 0.7);
  hpBg.drawRect(-16, 20, 32, 4);
  hpBg.endFill();

  c.addChild(gfx, hpBg, hpFill);
  return c;
}

function resetBuildingContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha    = 1;
  c.angle    = 0;
  c.scale.set(1);
  c.visible  = false;
  (c.getChildByName('gfx')    as PIXI.Graphics).clear();
  (c.getChildByName('hpFill') as PIXI.Graphics).clear();
}

// ─── BuildingView ─────────────────────────────────────────────────────────────

export class BuildingView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites: Map<number, PIXI.Container> = new Map();
  private readonly pool = new ObjectPool<PIXI.Container>(
    createBuildingContainer,
    resetBuildingContainer,
    12, // prewarm — 6 lanes × 2 players
  );

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
        sprite = this.acquireSprite(building);
        this.sprites.set(building.id, sprite);
        this.container.addChild(sprite);
      }

      this.updateSprite(sprite, building);
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.sprites.delete(id);
        this.pool.release(sprite);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  playDestroyEffect(buildingId: number): void {
    const sprite = this.sprites.get(buildingId);
    if (!sprite) return;

    // Remove from map immediately so sync() won't release it while animation runs
    this.sprites.delete(buildingId);

    let frames = 20;
    const tick = (): void => {
      sprite.angle += 5;
      sprite.alpha  = frames / 20;
      if (--frames <= 0) {
        PIXI.Ticker.shared.remove(tick);
        this.pool.release(sprite);
      }
    };
    PIXI.Ticker.shared.add(tick);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private acquireSprite(building: Building): PIXI.Container {
    const c     = this.pool.acquire();
    c.visible   = true;
    const color = BUILDING_COLORS[building.buildingType];
    const gfx   = c.getChildByName('gfx') as PIXI.Graphics;

    gfx.clear();
    gfx.lineStyle(3, color);

    if (building.buildingType === BuildingType.Barracks) {
      gfx.drawRect(-16, -12, 32, 24);
      gfx.moveTo(16, -12);
      gfx.lineTo(16, -24);
      gfx.lineTo(26, -18);
      gfx.lineTo(16, -12);
    } else {
      gfx.drawPolygon([-10, 16, 10, 16, 8, -8, -8, -8]);
      gfx.drawPolygon([-10, -8, 10, -8, 0, -22]);
    }

    return c;
  }

  private updateSprite(sprite: PIXI.Container, building: Building): void {
    const { x, y } = this.boardView.gridToScreen(building.col, building.row);
    sprite.x = x;
    sprite.y = y;

    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics;
    hpFill.clear();
    const ratio = Math.max(0, building.hp / building.maxHp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
    hpFill.drawRect(-16, 20, 32 * ratio, 4);
    hpFill.endFill();
  }
}
