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

// Idle animation constants
const BOB_SPEED     = 6.98;  // rad/s → ~0.9s period
const BOB_AMP       = 1.5;   // px
const FLAG_SPEED    = 9.0;   // rad/s — flag flutter (faster than body bob)
const FLAG_AMP      = 3.0;   // px wave amplitude
const TOWER_SWAY    = 5.0;   // rad/s
const TOWER_SWAY_DEG = 0.5;  // degrees

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
  sp.y     = 0;
  sp.angle = 0;
}

// ─── BuildingView ─────────────────────────────────────────────────────────────

export class BuildingView {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private sprites: Map<number, PIXI.Container> = new Map();
  private phases:  Map<number, number>          = new Map();
  private readonly pool = new ObjectPool<PIXI.Container>(
    createBuildingContainer,
    resetBuildingContainer,
    12,
    // 建筑容器：sprite + hpBg/hpFill/flag Graphics。
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
      this.updateIdleAnim(sprite, building);
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.sprites.delete(id);
        this.phases.delete(id);
        this.pool.release(sprite);
      }
    }
  }

  // ─── Event-driven effects ─────────────────────────────────────────────────

  playDestroyEffect(buildingId: number): void {
    const sprite = this.sprites.get(buildingId);
    if (!sprite) return;

    this.sprites.delete(buildingId);
    this.phases.delete(buildingId);

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
    const ratio = Math.max(0, building.hp / building.maxHp);
    hpFill.beginFill(ratio > 0.4 ? 0x44cc44 : 0xcc4444);
    hpFill.drawRect(-HP_BAR_W / 2, HP_BAR_Y, HP_BAR_W * ratio, 4);
    hpFill.endFill();
  }

  private updateIdleAnim(c: PIXI.Container, building: Building): void {
    const phase = this.phases.get(building.id) ?? 0;
    const t     = this.time;
    const sp    = c.getChildByName('sprite') as PIXI.Sprite;

    // All buildings: gentle vertical bob
    sp.y = Math.sin(t * BOB_SPEED + phase) * BOB_AMP;

    const flagGfx = c.getChildByName('flagGfx') as PIXI.Graphics;

    if (building.buildingType === BuildingType.Barracks) {
      this.drawFlagWave(flagGfx, t, phase);
    } else {
      // Arrow tower: subtle rotational sway, flag gfx unused
      sp.angle = Math.sin(t * TOWER_SWAY + phase) * TOWER_SWAY_DEG;
      flagGfx.clear();
    }
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
    this.texBarracks = null;
    this.texArcher   = null;
    this.container.destroy({ children: true });
  }
}
