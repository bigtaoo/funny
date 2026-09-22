// UnitView's sprite construction (stickman-container acquire/pool-reuse/build, circle-placeholder
// build, faction-marker/draft-body painting), extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛"). All host collections are plain readonly Map/
// ObjectPool references, mutated in place — no getter/setter needed.
import * as PIXI from 'pixi.js-legacy';
import { Side, UnitType } from '@nw/engine/types';
import type { Unit } from '@nw/engine/Unit';
import { ObjectPool } from '../../cache/ObjectPool';
import { StickmanRuntime } from '../stickman/StickmanRuntime';
import type { TaoAsset } from '../stickman/StickmanRuntime';
import { fx } from '../theme';
import { drawStickmanDraft, draftTexture } from '../stickmanDraft';
import { targetScreenHeight } from '../unitSize';
import { barSprite } from '../barSprite';
import {
  DRAFT_SEED, drawFactionMarker, factionMarkerTexture, stickmanHpBarY,
  RADIUS, MARKER_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT,
} from './assets';

export interface BuildHost {
  readonly pool: ObjectPool<PIXI.Container>;
  readonly stickmanPools: Map<string, Array<{ wrapper: PIXI.Container; runtime: StickmanRuntime }>>;
  readonly stickmanPoolKeys: Map<number, string>;
  readonly stickmanRuntimes: Map<number, StickmanRuntime>;
  readonly localSkinAssets: Map<UnitType, TaoAsset>;
  readonly opponentSkinAssets: Map<UnitType, TaoAsset>;
  readonly assets: Map<UnitType, TaoAsset>;
  readonly localSide: Side;
  applyGear(runtime: StickmanRuntime, unit: Unit): void;
}

/**
 * Screen-relative side: the local player always renders at the bottom, the
 * opponent at the top — regardless of which game side (owner) they are. Drives
 * both sprite mirroring and faction tint so the joiner's view matches a vs-AI
 * view (own units face up un-mirrored, enemy units mirrored), never flipped twice.
 */
function renderSide(host: BuildHost, unit: Unit): Side {
  return unit.side === host.localSide ? Side.Bottom : Side.Top;
}

/**
 * A skin only ever re-skins its owner's own units (S3-4 rule, 2026-08-01 fix): the local player's
 * equipped skins render on their own side, the opponent's (if known — real PvP only, never AI/bot)
 * render on the opponent's side. A same-type unit on the other side always falls back to the
 * default look, exactly like an opponent with nothing equipped.
 */
export function acquireSprite(host: BuildHost, unit: Unit): PIXI.Container {
  const isLocal = unit.side === host.localSide;
  const skinned = (isLocal ? host.localSkinAssets : host.opponentSkinAssets).get(unit.unitType);
  const asset = skinned ?? host.assets.get(unit.unitType);
  if (asset) return buildStickmanContainer(host, unit, asset, isLocal);
  return buildCircleContainer(host, unit);
}

/**
 * Pool bucket key for a unit's stickman (wrapper + runtime) pair. Plain `unitType` for the common
 * case (no skin override on the relevant side — the vast majority of types, always). Types with a
 * skin equipped on this unit's own side get a distinct suffixed key so a skinned pooled instance is
 * never handed back out for a differently-skinned (or unskinned) reuse — `StickmanRuntime` binds its
 * textures at construction and can't swap them on reset (see {@link acquireSprite}).
 */
function poolKey(host: BuildHost, unitType: UnitType, isLocal: boolean): string {
  const skinMap = isLocal ? host.localSkinAssets : host.opponentSkinAssets;
  return skinMap.has(unitType) ? `${unitType}:${isLocal ? 'local' : 'opp'}` : unitType;
}

// ─── Stickman container (unit type with a loaded .tao asset) ───────────────

function buildStickmanContainer(host: BuildHost, unit: Unit, asset: TaoAsset, isLocal: boolean): PIXI.Container {
  const side    = renderSide(host, unit);
  const mirrorX = side === Side.Top;
  const targetHeight = targetScreenHeight(unit.unitType);
  const key = poolKey(host, unit.unitType, isLocal);
  host.stickmanPoolKeys.set(unit.id, key);

  // Reuse a pooled (wrapper + runtime) pair of the same bucket when available.
  const pooled = host.stickmanPools.get(key)?.pop();
  if (pooled) {
    pooled.runtime.reset({ mirrorX, targetHeight });
    pooled.wrapper.visible = true;
    pooled.wrapper.alpha   = 1;
    pooled.wrapper.scale.set(1);
    // A pooled wrapper may be reused for the opposite side — recolor + reposition.
    const markerSprite = pooled.wrapper.getChildByName('factionMarkerSprite') as PIXI.Sprite | null;
    const markerGfx     = pooled.wrapper.getChildByName('factionMarker') as PIXI.Graphics | null;
    if (markerSprite && markerGfx) drawUnitMarker(markerSprite, markerGfx, pooled.runtime, side);
    const hpBg   = pooled.wrapper.getChildByName('hpBg')   as PIXI.Sprite;
    const hpFill = pooled.wrapper.getChildByName('hpFill') as PIXI.Sprite;
    hpBg.visible = false;
    hpFill.visible = false;
    host.applyGear(pooled.runtime, unit);
    host.stickmanRuntimes.set(unit.id, pooled.runtime);
    return pooled.wrapper;
  }

  const wrapper = new PIXI.Container();
  wrapper.visible = true;

  // Faction ground marker — drawn first so it sits behind the figure (under the shadow).
  const markerSprite = new PIXI.Sprite(); markerSprite.name = 'factionMarkerSprite'; markerSprite.anchor.set(0.5);
  const markerGfx     = new PIXI.Graphics(); markerGfx.name = 'factionMarker';

  const runtime = new StickmanRuntime(asset, { mirrorX, targetHeight });
  host.stickmanRuntimes.set(unit.id, runtime);
  host.applyGear(runtime, unit);
  drawUnitMarker(markerSprite, markerGfx, runtime, side);

  // ── HP bar (positioned above the character's head) ────────────────────
  // Tier-aware: clears the crown at the unit's rendered height (see stickmanHpBarY).
  const HP_BAR_Y_STICKMAN = stickmanHpBarY(unit.unitType);

  const hpBg = barSprite(-HP_BAR_WIDTH / 2, HP_BAR_Y_STICKMAN, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0xcccccc, 0.7);
  hpBg.name    = 'hpBg';
  hpBg.visible = false;

  const hpFill = barSprite(-HP_BAR_WIDTH / 2, HP_BAR_Y_STICKMAN, HP_BAR_WIDTH, HP_BAR_HEIGHT, fx.hpHigh);
  hpFill.name    = 'hpFill';
  hpFill.visible = false;

  wrapper.addChild(markerSprite, markerGfx, runtime.container, hpBg, hpFill);
  return wrapper;
}

// ─── Circle container (PvE-only types, or stickman units before asset loads) ──

function buildCircleContainer(host: BuildHost, unit: Unit): PIXI.Container {
  const c = host.pool.acquire();
  c.visible = true;
  const side = renderSide(host, unit);

  // Procedural skeleton draft (§5.5) in faction ink — blue = us / red = enemy.
  // Keyed off render side so the joiner's own units stay "us"-colored.
  paintDraftBody(
    c.getChildByName('bodySprite') as PIXI.Sprite, c.getChildByName('body') as PIXI.Graphics,
    side, targetScreenHeight(unit.unitType), DRAFT_SEED[unit.unitType],
  );

  // Faction ground marker (also grounds the figure on the board).
  paintMarker(
    c.getChildByName('ringSprite') as PIXI.Sprite, c.getChildByName('ring') as PIXI.Graphics,
    side, 0, MARKER_Y, RADIUS * 1.1, RADIUS * 0.42,
  );

  return c;
}

/**
 * Draw the faction ground marker for a stickman unit, aligned to its shadow
 * (slightly larger than the shadow so it reads as a colored patch under it).
 * Falls back to a default ground ellipse when the shadow ground is unavailable.
 */
function drawUnitMarker(markerSprite: PIXI.Sprite, markerGfx: PIXI.Graphics, runtime: StickmanRuntime, side: Side): void {
  const g = runtime.getShadowGround();
  if (g) paintMarker(markerSprite, markerGfx, side, g.x, g.y, g.rx * 1.3, g.ry * 1.3);
  else   paintMarker(markerSprite, markerGfx, side, 0, MARKER_Y, 12, 4.4);
}

/**
 * Show a faction ground marker at `(cx, cy)` with half-extents `(rx, ry)`: the bake-texture sprite
 * when a bake renderer is available (real client, on-screen), the live `drawFactionMarker` fallback
 * otherwise (headless tests — same contract as `render/bake.ts`'s other callers). Exactly one of
 * `sprite`/`gfx` ends up visible.
 */
function paintMarker(
  sprite: PIXI.Sprite, gfx: PIXI.Graphics, side: Side, cx: number, cy: number, rx: number, ry: number,
): void {
  const tex = factionMarkerTexture(side, cx, cy, rx, ry);
  if (tex) {
    sprite.texture = tex;
    sprite.x = cx;
    sprite.y = cy;
    sprite.visible = true;
    gfx.visible = false;
    gfx.clear();
  } else {
    sprite.visible = false;
    gfx.clear();
    drawFactionMarker(gfx, side, cx, cy, rx, ry);
    gfx.visible = true;
  }
}

/**
 * Show the procedural draft figure (`stickmanDraft.ts`) for a circle-placeholder unit: the
 * bake-texture sprite when a bake renderer is available, the live `drawStickmanDraft` fallback
 * otherwise. Same two-node contract as {@link paintMarker}.
 */
function paintDraftBody(
  sprite: PIXI.Sprite, gfx: PIXI.Graphics, side: Side, targetHeight: number, seed: number,
): void {
  const tex = draftTexture(side, targetHeight, seed);
  if (tex) {
    sprite.texture = tex;
    sprite.visible = true;
    gfx.visible = false;
    gfx.clear();
  } else {
    sprite.visible = false;
    gfx.clear();
    drawStickmanDraft(gfx, side, targetHeight, seed);
    gfx.visible = true;
  }
}
