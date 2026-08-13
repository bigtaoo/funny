import * as PIXI from 'pixi.js-legacy';
import { Board } from '@nw/engine/Board';
import { Unit } from '@nw/engine/Unit';
import { Side, UnitType } from '@nw/engine/types';
import { BoardView } from './BoardView';
import { ObjectPool } from '../cache/ObjectPool';
import { registerPool } from '../cache/poolRegistry';
import { StickmanRuntime } from './stickman/StickmanRuntime';
import type { TaoAsset, GearGlyphSpec } from './stickman/StickmanRuntime';
import { TICK_RATE } from '@nw/engine';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { fx } from './theme';
import { drawStickmanDraft } from './stickmanDraft';
import { targetScreenHeight } from './unitSize';
import {
  STICKMAN_ASSETS, resolveSkinOverrides, DRAFT_SEED, drawFactionMarker, stickmanHpBarY,
  createUnitContainer, resetUnitContainer,
  RADIUS, MARKER_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, HP_BAR_Y, HP_TOTAL_FRAMES, HP_FADE_FRAMES,
} from './UnitView/assets';
import {
  setSpellTargetPreview, playHitEffect, playDeathEffect, getHitPoint, NO_SPELL_TARGETS, type EffectsHost,
} from './UnitView/effects';
import { applyGear, type GearHost } from './UnitView/gear';

export { STICKMAN_ASSETS, resolveSkinOverrides } from './UnitView/assets';

// ── UnitView ──────────────────────────────────────────────────────────────────
//
// 2026-08-13: per-unit-type asset URL tables + the pool factory/faction-marker/HP-bar-Y pure
// helpers were pulled out into UnitView/assets.ts; the event-driven effects (spell-target outline/
// hit flash/death fade) into UnitView/effects.ts; the equipment-overlay glyph resolution into
// UnitView/gear.ts — all form① (claudedocs/client-modules.md "单文件 500 行收敛"). This file kept
// the per-frame sync, stickman pooling/spawn, and sprite-position/HP-bar update logic that ties
// the three together.

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

  /** Pool bucket key of each active stickman unit — needed to return its pair to the matching pool. */
  private readonly stickmanPoolKeys: Map<number, string> = new Map();

  /**
   * Pools of idle stickman (wrapper + runtime) pairs for reuse, keyed by
   * {@link poolKey} (unit type, plus a skin-variant suffix for the handful of
   * types with a per-side skin override — see {@link poolKey}). Reusing the
   * ~11-sprite runtimes instead of new/destroy per spawn is the main
   * swarm-performance lever.
   */
  private readonly stickmanPools: Map<string, Array<{ wrapper: PIXI.Container; runtime: StickmanRuntime }>> = new Map();

  /**
   * Per-unit HP bar visibility timer (render frames remaining).
   * 0 = hidden. Decremented every render frame in sync().
   */
  private hpTimers: Map<number, number> = new Map();

  /** Default (unskinned) .tao assets keyed by unit type; entries appear as each fetch resolves. */
  private readonly assets: Map<UnitType, TaoAsset> = new Map();

  /**
   * Skin-overridden .tao assets for the LOCAL player's own equipped skins — applied only to units on
   * {@link localSide} (see {@link acquireSprite}). A type absent here has no local skin equipped and
   * always renders from {@link assets}.
   */
  private readonly localSkinAssets: Map<UnitType, TaoAsset> = new Map();

  /**
   * Skin-overridden .tao assets for the OPPONENT's equipped skins — applied only to units on the
   * non-local side. Empty for AI/bot opponents (they never equip skins) and for any match where the
   * server hasn't supplied opponent cosmetics (older client/replay paths) — those always render
   * from {@link assets}, same as an opponent with nothing equipped.
   */
  private readonly opponentSkinAssets: Map<UnitType, TaoAsset> = new Map();

  /**
   * Hero Roster card instances + equipment inventory for the battle-render gear
   * overlay (§20.4). PvE/siege only — PvP passes nothing (A5 hard wall), so PvP
   * units never show gear decals. Null/empty = no overlay.
   */
  private readonly cardInstances: EngineCardInstance[] | null;
  private readonly equipmentInv: EngineEquipInv | null;

  /** Resolved gear glyph specs per equippable unit type (constant per match), memoized. */
  private readonly gearSpecCache: Map<UnitType, GearGlyphSpec[]> = new Map();

  private readonly pool = new ObjectPool<PIXI.Container>(
    createUnitContainer,
    resetUnitContainer,
    20,
    // Circle placeholder container: body/ring/hpBg/hpFill — 4 Graphics + the container.
    { label: 'unit.circle', bytesEach: 8 * 1024 },
  );

  /**
   * In-flight hit/death effect ticks registered on the shared ticker. Tracked so
   * teardown can unregister any still running — otherwise the closure (which
   * captures the sprite/runtime → this UnitView → the whole battle scene) stays
   * reachable from `PIXI.Ticker.shared` (a GC root) forever, pinning the entire
   * match's display tree + textures in memory. This was the dominant client leak.
   */
  private readonly effectTicks = new Set<() => void>();

  /** Pool monitor deregister function (stickman pool data source); called in destroy(). */
  private readonly unregisterStickmanStat: () => void;

  /** Unit ids currently outlined by {@link setSpellTargetPreview} — tracked so the next call can clear exactly the ones that fell out of the new set. */
  private previewUnitIds: ReadonlySet<number> = NO_SPELL_TARGETS;

  constructor(
    boardView: BoardView,
    localSide: Side = Side.Bottom,
    /** The LOCAL player's own equipped skins — applied only to their own units, never the opponent's (see {@link acquireSprite}). */
    equippedSkins: readonly string[] = [],
    cardInstances: EngineCardInstance[] | null = null,
    equipmentInv: EngineEquipInv | null = null,
    /** The OPPONENT's equipped skins, if known — real PvP opponents who have one equipped; always empty for AI/bot opponents. */
    opponentSkins: readonly string[] = [],
  ) {
    this.boardView = boardView;
    this.localSide = localSide;
    this.cardInstances = cardInstances;
    this.equipmentInv = equipmentInv;
    this.container = new PIXI.Container();

    // Stickman pool (bucketed by type) registered with the pool monitor: each idle entry is a wrapper + ~11 sprites + outline.
    this.unregisterStickmanStat = registerPool({
      label: 'unit.stickman',
      idle: () => {
        let n = 0;
        for (const arr of this.stickmanPools.values()) n += arr.length;
        return n;
      },
      bytesEach: 16 * 1024,
    });

    // Start loading every stickman asset in the background. The game is playable
    // before the first unit can spawn, so by the time acquireSprite() runs for a
    // stickman-animated unit these Promises will normally be settled; until then
    // that unit falls back to the circle placeholder. The default bundle always
    // loads (an opponent of a type the local player has skinned still needs the
    // unskinned look) — the equipped skin (S3-4) additionally loads into a
    // side-scoped override map, applied only to that side's units (acquireSprite).
    this.loadAssetsInto(STICKMAN_ASSETS, this.assets);
    this.loadAssetsInto(resolveSkinOverrides(equippedSkins), this.localSkinAssets);
    this.loadAssetsInto(resolveSkinOverrides(opponentSkins), this.opponentSkinAssets);
  }

  private loadAssetsInto(urls: Partial<Record<UnitType, string>>, into: Map<UnitType, TaoAsset>): void {
    for (const [type, url] of Object.entries(urls) as [UnitType, string][]) {
      StickmanRuntime.loadAsset(url, targetScreenHeight(type))
        .then(asset => { into.set(type, asset); })
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

      // Update stickman animation state + advance clock. The 'attack' clip is
      // time-scaled to the unit's real attack interval (see
      // StickmanRuntime.setAttackInterval) so the swing animation's cadence
      // matches how often the unit actually deals damage, not the art's
      // authored clip duration.
      const runtime = this.stickmanRuntimes.get(unit.id);
      if (runtime) {
        runtime.setAttackInterval(unit.effectiveAttackIntervalTicks / TICK_RATE);
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

  // ── Event-driven effects — see render/UnitView/effects.ts ──────────────────

  /**
   * Show the HP bar for `unitId` for ~3 seconds, then fade out.
   * Called when the unit receives a hit.
   */
  showHpBar(unitId: number): void {
    this.hpTimers.set(unitId, HP_TOTAL_FRAMES);
  }

  getHitPoint(unitId: number): { x: number; y: number } | null {
    return getHitPoint(this.effectsHost(), unitId);
  }

  setSpellTargetPreview(unitIds: ReadonlySet<number>): void {
    setSpellTargetPreview(this.effectsHost(), unitIds);
  }

  playHitEffect(unitId: number): void {
    playHitEffect(this.effectsHost(), unitId);
  }

  playDeathEffect(unitId: number): void {
    playDeathEffect(this.effectsHost(), unitId);
  }

  /** Bundles what effects.ts's functions need instead of them closing over `this`. */
  private effectsHost(): EffectsHost {
    const view = this;
    return {
      sprites: this.sprites, stickmanRuntimes: this.stickmanRuntimes, hpTimers: this.hpTimers,
      effectTicks: this.effectTicks,
      get previewUnitIds() { return view.previewUnitIds; },
      set previewUnitIds(v) { view.previewUnitIds = v; },
      releaseUnit: (unitId: number, sprite: PIXI.Container) => this.releaseUnit(unitId, sprite),
    };
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

  /**
   * Draw the faction ground marker for a stickman unit, aligned to its shadow
   * (slightly larger than the shadow so it reads as a colored patch under it).
   * Falls back to a default ground ellipse when the shadow ground is unavailable.
   */
  private drawUnitMarker(marker: PIXI.Graphics, runtime: StickmanRuntime, side: Side): void {
    const g = runtime.getShadowGround();
    if (g) drawFactionMarker(marker, side, g.x, g.y, g.rx * 1.3, g.ry * 1.3);
    else   drawFactionMarker(marker, side, 0, MARKER_Y, 12, 4.4);
  }

  /** Bundles what gear.ts's functions need instead of them closing over `this`. */
  private gearHost(): GearHost {
    return {
      localSide: this.localSide, cardInstances: this.cardInstances, equipmentInv: this.equipmentInv,
      gearSpecCache: this.gearSpecCache,
    };
  }

  private applyGear(runtime: StickmanRuntime, unit: Unit): void {
    applyGear(this.gearHost(), runtime, unit);
  }

  /**
   * Pool bucket key for a unit's stickman (wrapper + runtime) pair. Plain `unitType` for the common
   * case (no skin override on the relevant side — the vast majority of types, always). Types with a
   * skin equipped on this unit's own side get a distinct suffixed key so a skinned pooled instance is
   * never handed back out for a differently-skinned (or unskinned) reuse — `StickmanRuntime` binds its
   * textures at construction and can't swap them on reset (see {@link acquireSprite}).
   */
  private poolKey(unitType: UnitType, isLocal: boolean): string {
    const skinMap = isLocal ? this.localSkinAssets : this.opponentSkinAssets;
    return skinMap.has(unitType) ? `${unitType}:${isLocal ? 'local' : 'opp'}` : unitType;
  }

  /**
   * A skin only ever re-skins its owner's own units (S3-4 rule, 2026-08-01 fix): the local player's
   * equipped skins render on their own side, the opponent's (if known — real PvP only, never AI/bot)
   * render on the opponent's side. A same-type unit on the other side always falls back to the
   * default look, exactly like an opponent with nothing equipped.
   */
  private acquireSprite(unit: Unit): PIXI.Container {
    const isLocal = unit.side === this.localSide;
    const skinned = (isLocal ? this.localSkinAssets : this.opponentSkinAssets).get(unit.unitType);
    const asset = skinned ?? this.assets.get(unit.unitType);
    if (asset) return this.buildStickmanContainer(unit, asset, isLocal);
    return this.buildCircleContainer(unit);
  }

  // ─── Stickman container (unit type with a loaded .tao asset) ───────────────

  private buildStickmanContainer(unit: Unit, asset: TaoAsset, isLocal: boolean): PIXI.Container {
    const side    = this.renderSide(unit);
    const mirrorX = side === Side.Top;
    const targetHeight = targetScreenHeight(unit.unitType);
    const poolKey = this.poolKey(unit.unitType, isLocal);
    this.stickmanPoolKeys.set(unit.id, poolKey);

    // Reuse a pooled (wrapper + runtime) pair of the same bucket when available.
    const pooled = this.stickmanPools.get(poolKey)?.pop();
    if (pooled) {
      pooled.runtime.reset({ mirrorX, targetHeight });
      pooled.wrapper.visible = true;
      pooled.wrapper.alpha   = 1;
      pooled.wrapper.scale.set(1);
      // A pooled wrapper may be reused for the opposite side — recolor + reposition.
      const marker = pooled.wrapper.getChildByName('factionMarker') as PIXI.Graphics | null;
      if (marker) this.drawUnitMarker(marker, pooled.runtime, side);
      const hpBg   = pooled.wrapper.getChildByName('hpBg')   as PIXI.Graphics;
      const hpFill = pooled.wrapper.getChildByName('hpFill') as PIXI.Graphics;
      hpBg.visible = false;
      hpFill.visible = false;
      hpFill.clear();
      this.applyGear(pooled.runtime, unit);
      this.stickmanRuntimes.set(unit.id, pooled.runtime);
      return pooled.wrapper;
    }

    const wrapper = new PIXI.Container();
    wrapper.visible = true;

    // Faction ground marker — drawn first so it sits behind the figure (under the shadow).
    const marker = new PIXI.Graphics();
    marker.name = 'factionMarker';

    const runtime = new StickmanRuntime(asset, { mirrorX, targetHeight });
    this.stickmanRuntimes.set(unit.id, runtime);
    this.applyGear(runtime, unit);
    this.drawUnitMarker(marker, runtime, side);

    // ── HP bar (positioned above the character's head) ────────────────────
    // Tier-aware: clears the crown at the unit's rendered height (see stickmanHpBarY).
    const HP_BAR_Y_STICKMAN = stickmanHpBarY(unit.unitType);

    const hpBg = new PIXI.Graphics();
    hpBg.name = 'hpBg';
    hpBg.beginFill(0xcccccc, 0.7);
    hpBg.drawRect(-HP_BAR_WIDTH / 2, HP_BAR_Y_STICKMAN, HP_BAR_WIDTH, HP_BAR_HEIGHT);
    hpBg.endFill();
    hpBg.visible = false;

    const hpFill = new PIXI.Graphics();
    hpFill.name    = 'hpFill';
    hpFill.visible = false;

    wrapper.addChild(marker, runtime.container, hpBg, hpFill);
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
    drawStickmanDraft(body, this.renderSide(unit), targetScreenHeight(unit.unitType), DRAFT_SEED[unit.unitType]);

    // Faction ground marker (also grounds the figure on the board).
    const ring = c.getChildByName('ring') as PIXI.Graphics;
    drawFactionMarker(ring, this.renderSide(unit), 0, MARKER_Y, RADIUS * 1.1, RADIUS * 0.42);

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
    const ratio = Math.max(0, unit.hp_fp / unit.maxHp_fp);
    hpFill.beginFill(ratio > 0.4 ? fx.hpHigh : fx.hpLow);

    // Determine HP bar Y offset: stickman containers have their own y offset baked in.
    const isStickman = this.stickmanRuntimes.has(unit.id);
    const barY = isStickman ? stickmanHpBarY(unit.unitType) : HP_BAR_Y;
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
      const key = this.stickmanPoolKeys.get(unitId)!;
      this.stickmanPoolKeys.delete(unitId);
      // Return the (wrapper + runtime) pair to its bucket's pool instead of destroying.
      sprite.removeFromParent();
      sprite.visible = false;
      let pool = this.stickmanPools.get(key);
      if (!pool) { pool = []; this.stickmanPools.set(key, pool); }
      pool.push({ wrapper: sprite, runtime });
    } else {
      this.pool.release(sprite);
    }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  /**
   * Release every resource this view holds when the match ends. Critically:
   *  1. Unregister all in-flight effect ticks from the shared ticker (the leak
   *     root — see {@link effectTicks}).
   *  2. Destroy the pooled (detached) stickman pairs and circle containers — they
   *     were `removeFromParent()`'d, so the container subtree below won't reach
   *     them.
   *  3. Destroy the container subtree (live sprites + their runtimes are children
   *     of it). Shared spritesheet textures (cached per-url in StickmanRuntime)
   *     are NOT destroyed — they're reused across battles.
   */
  destroy(): void {
    this.unregisterStickmanStat();
    for (const tick of this.effectTicks) PIXI.Ticker.shared.remove(tick);
    this.effectTicks.clear();

    for (const pool of this.stickmanPools.values()) {
      for (const { wrapper } of pool) wrapper.destroy({ children: true });
    }
    this.stickmanPools.clear();
    this.pool.drain((c) => c.destroy({ children: true }));

    this.stickmanRuntimes.clear();
    this.stickmanPoolKeys.clear();
    this.previewUnitIds = NO_SPELL_TARGETS;
    this.sprites.clear();
    this.hpTimers.clear();
    this.assets.clear();
    this.localSkinAssets.clear();
    this.opponentSkinAssets.clear();
    this.gearSpecCache.clear();

    this.container.destroy({ children: true });
  }
}
