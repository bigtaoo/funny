import * as PIXI from 'pixi.js-legacy';
import { Board } from '../game/Board';
import { Unit } from '../game/Unit';
import { Side, UnitState, UnitType } from '../game/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';
import { StickmanRuntime } from './stickman/StickmanRuntime';
import type { TaoAsset } from './stickman/StickmanRuntime';
import infantryTaoUrl from '../assets/infantry.tao';
import archerTaoUrl from '../assets/archer.tao';
import shieldBearerTaoUrl from '../assets/shieldbearer.tao';
import { fx, palette } from './theme';
import { drawStickmanDraft } from './stickmanDraft';

/**
 * .tao skeletal-animation bundle URL per unit type. Types listed here render as
 * animated stickmen; types absent fall back to the colored-circle placeholder.
 */
const STICKMAN_ASSETS: Partial<Record<UnitType, string>> = {
  [UnitType.Infantry]: infantryTaoUrl     as unknown as string,
  [UnitType.Archer]:    archerTaoUrl       as unknown as string,
  [UnitType.ShieldBearer]:  shieldBearerTaoUrl as unknown as string, // 盾兵
};

/**
 * Skin → per-type .tao override (S3-4). The equipped skin (CollectionScene writes
 * SaveData.equipped) swaps ONLY the texture bundle — never stats — so a skin
 * carried into PvP changes nothing but the picture (hard wall, §5.2). Empty until
 * skin .tao bundles are authored; an unknown / unmapped skin falls back to the
 * default look in STICKMAN_ASSETS. To add a skin: import its .tao here and map the
 * unit types it restyles, e.g. `gold: { [UnitType.Infantry]: goldInfantryTaoUrl }`.
 */
const SKIN_ASSETS: Record<string, Partial<Record<UnitType, string>>> = {};

/** Effective per-type asset URLs for an equipped skin (skin override ∪ default). */
function resolveAssets(equippedSkin: string | null): Partial<Record<UnitType, string>> {
  const skin = equippedSkin ? SKIN_ASSETS[equippedSkin] : undefined;
  return skin ? { ...STICKMAN_ASSETS, ...skin } : STICKMAN_ASSETS;
}

/**
 * Faction ink fills the unit body — blue = us, red = enemy (art-direction §3.2,
 * the primary readability rule). Sourced from theme so a re-skin can't break the
 * friend/foe split. NOTE: Bottom/Top here are render sides, not owners; the local
 * player always sits at Bottom after the localSide-aware layout flip.
 *
 * Placeholder units (PvE-only Ironclad/Runner, or any stickman type before its
 * .tao bundle loads) draw the procedural skeleton draft (stickmanDraft.ts) in
 * faction ink. Per-type figure height gives a silhouette cue (§3.2: types by
 * silhouette, not color — color is the faction).
 */
const DRAFT_HEIGHT: Record<UnitType, number> = {
  [UnitType.Infantry]:     30,
  [UnitType.ShieldBearer]: 32,
  [UnitType.Archer]:       29,
  [UnitType.Ironclad]:     40,  // heavy — bulkier silhouette
  [UnitType.Runner]:       24,  // small & fast
};

/** Stable pen seed per type so each draft scrawls consistently. */
const DRAFT_SEED: Record<UnitType, number> = {
  [UnitType.Infantry]:     1011,
  [UnitType.ShieldBearer]: 2027,
  [UnitType.Archer]:       3041,
  [UnitType.Ironclad]:     4057,
  [UnitType.Runner]:       5077,
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

// ── Pool factory / resetter (circle placeholder for non-stickman unit types) ───

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

  /**
   * The game side the local player controls. The layout already flips unit
   * *positions* 180° for the joiner (localSide=Top) so their own units sit at
   * the screen bottom. Facing/animation must NOT also key off the raw game side
   * or the joiner's units get mirrored twice (wrong way round). Instead every
   * unit renders relative to the screen: own side = bottom (un-mirrored, like
   * owner 0 vs AI), enemy = top (mirrored). See {@link renderSide}.
   */
  private readonly localSide: Side;

  /** All active unit display containers (circle or stickman wrapper), keyed by unit id. */
  private sprites: Map<number, PIXI.Container> = new Map();

  /** Active StickmanRuntime instances for stickman-animated units, keyed by unit id. */
  private readonly stickmanRuntimes: Map<number, StickmanRuntime> = new Map();

  /** Unit type of each active stickman unit — needed to return its pair to the matching pool. */
  private readonly stickmanTypes: Map<number, UnitType> = new Map();

  /**
   * Pools of idle stickman (wrapper + runtime) pairs for reuse, keyed by unit
   * type (textures differ per type so pools can't be shared). Reusing the
   * ~11-sprite runtimes instead of new/destroy per spawn is the main
   * swarm-performance lever.
   */
  private readonly stickmanPools: Map<UnitType, Array<{ wrapper: PIXI.Container; runtime: StickmanRuntime }>> = new Map();

  /**
   * Per-unit HP bar visibility timer (render frames remaining).
   * 0 = hidden. Decremented every render frame in sync().
   */
  private hpTimers: Map<number, number> = new Map();

  /** Loaded .tao assets keyed by unit type; entries appear as each fetch resolves. */
  private readonly assets: Map<UnitType, TaoAsset> = new Map();

  private readonly pool = new ObjectPool<PIXI.Container>(
    createUnitContainer,
    resetUnitContainer,
    20,
  );

  constructor(boardView: BoardView, localSide: Side = Side.Bottom, equippedSkin: string | null = null) {
    this.boardView = boardView;
    this.localSide = localSide;
    this.container = new PIXI.Container();

    // Start loading every stickman asset in the background. The game is playable
    // before the first unit can spawn, so by the time acquireSprite() runs for a
    // stickman-animated unit these Promises will normally be settled; until then
    // that unit falls back to the circle placeholder. The equipped skin (S3-4)
    // swaps the texture bundle per type; unmapped types use the default look.
    for (const [type, url] of Object.entries(resolveAssets(equippedSkin)) as [UnitType, string][]) {
      StickmanRuntime.loadAsset(url)
        .then(asset => { this.assets.set(type, asset); })
        .catch(err  => { console.warn(`[UnitView] ${type} .tao failed to load:`, err); });
    }
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

  /**
   * Screen position of the unit's `hit` attachment point (torso), for spawning
   * the hit spark on the body rather than the grid-cell centre. Falls back to
   * the unit's container origin when the unit has no stickman runtime (circle
   * placeholder / PvE-only types) or the .tao defines no `hit` attachment.
   * Returns null if the unit has no live sprite.
   */
  getHitPoint(unitId: number): { x: number; y: number } | null {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return null;
    const runtime = this.stickmanRuntimes.get(unitId);
    if (runtime) {
      const off = runtime.getAttachmentOffset('hit');
      if (off) return { x: sprite.x + off.x, y: sprite.y + off.y };
    }
    return { x: sprite.x, y: sprite.y };
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

  /**
   * Screen-relative side: the local player always renders at the bottom, the
   * opponent at the top — regardless of which game side (owner) they are. Drives
   * both sprite mirroring and faction tint so the joiner's view matches a vs-AI
   * view (own units face up un-mirrored, enemy units mirrored), never flipped twice.
   */
  private renderSide(unit: Unit): Side {
    return unit.side === this.localSide ? Side.Bottom : Side.Top;
  }

  private acquireSprite(unit: Unit): PIXI.Container {
    const asset = this.assets.get(unit.unitType);
    if (asset) return this.buildStickmanContainer(unit, asset);
    return this.buildCircleContainer(unit);
  }

  // ─── Stickman container (unit type with a loaded .tao asset) ───────────────

  private buildStickmanContainer(unit: Unit, asset: TaoAsset): PIXI.Container {
    const mirrorX = this.renderSide(unit) === Side.Top;
    this.stickmanTypes.set(unit.id, unit.unitType);

    // Reuse a pooled (wrapper + runtime) pair of the same type when available.
    const pooled = this.stickmanPools.get(unit.unitType)?.pop();
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

    const runtime = new StickmanRuntime(asset, { mirrorX });
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

  // ─── Circle container (PvE-only types, or stickman units before asset loads) ──

  private buildCircleContainer(unit: Unit): PIXI.Container {
    const c = this.pool.acquire();
    c.visible = true;

    const body = c.getChildByName('body') as PIXI.Graphics;
    body.clear();
    // Procedural skeleton draft (§5.5) in faction ink — blue = us / red = enemy.
    // Keyed off render side so the joiner's own units stay "us"-colored.
    drawStickmanDraft(body, this.renderSide(unit), DRAFT_HEIGHT[unit.unitType], DRAFT_SEED[unit.unitType]);

    // Faint pencil ground shadow so the figure sits on the board.
    const ring = c.getChildByName('ring') as PIXI.Graphics;
    ring.clear();
    ring.beginFill(palette.pencil, 0.16);
    ring.drawEllipse(0, RADIUS + 2, RADIUS * 0.9, RADIUS * 0.32);
    ring.endFill();

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
    hpFill.beginFill(ratio > 0.4 ? fx.hpHigh : fx.hpLow);

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
      const type = this.stickmanTypes.get(unitId)!;
      this.stickmanTypes.delete(unitId);
      // Return the (wrapper + runtime) pair to its type's pool instead of destroying.
      sprite.removeFromParent();
      sprite.visible = false;
      let pool = this.stickmanPools.get(type);
      if (!pool) { pool = []; this.stickmanPools.set(type, pool); }
      pool.push({ wrapper: sprite, runtime });
    } else {
      this.pool.release(sprite);
    }
  }
}
