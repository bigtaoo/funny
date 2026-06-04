import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Building } from '../game/Building';
import { BuildingType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';
import barracksTexUrl from '../assets/game_infantry_barracks.png';
import archerTexUrl from '../assets/game_archer_barracks.png';

const SPRITE_SIZE = 56;
const HP_BAR_Y    = 32;
const HP_BAR_W    = 40;

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

  const hpFill = new PIXI.Graphics(); hpFill.name = 'hpFill';

  c.addChild(sprite, hpBg, hpFill);
  return c;
}

function resetBuildingContainer(c: PIXI.Container): void {
  c.removeFromParent();
  c.alpha   = 1;
  c.angle   = 0;
  c.scale.set(1);
  c.visible = false;
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
    12,
  );

  private texBarracks: PIXI.Texture | null = null;
  private texArcher:   PIXI.Texture | null = null;

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
    const c = this.pool.acquire();
    c.visible = true;

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

    // Spawn animation: scale 0→1, ease-out cubic, ~0.3s at 60fps
    c.scale.set(0);
    let elapsed = 0;
    const DURATION = 18; // frames at 60fps
    const onTick = (dt: number): void => {
      elapsed += dt;
      const t     = Math.min(elapsed / DURATION, 1);
      const scale = 1 - Math.pow(1 - t, 3);
      c.scale.set(scale);
      if (t >= 1) PIXI.Ticker.shared.remove(onTick);
    };
    PIXI.Ticker.shared.add(onTick);

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
    hpFill.drawRect(-HP_BAR_W / 2, HP_BAR_Y, HP_BAR_W * ratio, 4);
    hpFill.endFill();
  }
}
