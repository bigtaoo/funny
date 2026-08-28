// March/occupy/stationed token art + the pooled walk-cycle/idle sync loops that ride them across
// the map. Split out of fog.ts (2026-08-12 composition conversion, secondary split — fog.ts was
// already over the 500-line convention before conversion and stayed over after): syncMarchTokens/
// syncOccupyTokens/syncStationedTokens only ever read/write `core.ctx` and call the free-function
// helpers below — none of them call any other Fog method — so unlike renderMapL3/renderFog/
// renderOccupyFrontier/renderGarrisonZones/renderOverlay (which cohere as one class, calling each
// other), these have no `this.*` cross-call reason to be class methods at all. Pure form① module,
// same pattern as this directory's sibling shieldFx.ts: every function takes the state it needs
// as an explicit parameter (`core`) instead of leaving a delegating method on Fog.
import * as PIXI from 'pixi.js-legacy';
import { tileToScreen } from '../../../render/isoGrid';
import { ENEMY_BASE_TINT } from '../logic/tileStyle';
import { StickmanRuntime } from '../../../render/stickman/StickmanRuntime';
import { UnitType } from '@nw/engine/types';
import { targetScreenHeight } from '../../../render/unitSize';
import { STICKMAN_ASSETS } from '../../../render/UnitView';
import { buildAvatar, makeAvatarId } from '../../../render/avatar';
import { buildEmblemIcon, loadEmblemAtlas, type EmblemKey } from '../../../render/emblemIcon';
import type { MapTokenEntry } from '../WorldMapContext';
import type { WorldMapRendererCore } from './core';

/**
 * March/occupy/stationed token art (2026-07-26): prefers the deployed team's actual leader
 * unit-type (server-resolved once at dispatch — see MarchView.leaderUnitType / design/game/
 * WORLD_MAP_ART_SPEC.md), so e.g. an archer-led team's march rides an archer rig instead of the
 * old fixed normal/siege split. Falls back to the pre-2026-07-26 default (shield-bearer for an
 * attack/siege identity, infantry otherwise) for flat-troop marches/holds with no team attached.
 * Guilds/banners are intentionally out of scope here (see the WORLD_MAP_ART_SPEC TODO) — this
 * only swaps which of the 6 already-authored unit rigs represents the token.
 */
export function resolveMarchUnitType(fallbackKind: string | undefined, leaderUnitType: string | undefined): UnitType {
  if (leaderUnitType && STICKMAN_ASSETS[leaderUnitType as UnitType]) return leaderUnitType as UnitType;
  return fallbackKind === 'attack' ? UnitType.ShieldBearer : UnitType.Infantry;
}

export function marchTokenAssetFor(unitType: UnitType): { url: string; type: UnitType } {
  const url = STICKMAN_ASSETS[unitType] ?? STICKMAN_ASSETS[UnitType.Infantry]!;
  return { url, type: unitType };
}

/**
 * Shared per-frame budget (2026-07-26) capping how many march/occupy/stationed tokens render as a
 * full StickmanRuntime skeleton (6-12 sprites + per-frame bone updates) across all three systems
 * combined — a large siege can have far more in-flight/holding/stationed squads than are worth
 * animating individually (design/game/WORLD_MAP_ART_SPEC.md perf TODO). Tokens beyond the budget
 * render as a single lightweight static portrait disc instead (see buildAvatar). Existing tokens
 * keep whatever mode they were created with (no mid-life demotion/promotion, to avoid flicker) —
 * the budget only gates NEW tokens, so it bounds the rate new skeletons can spin up, not a hard cap
 * on total live tokens (each still counts against it for as long as it's alive, see renderOverlay).
 */
export const STICKMAN_TOKEN_BUDGET = 80;

/** March/occupy/stationed tokens render at this fraction of a tile's pixel size (2026-08-01: halved so units read less crowded on the map). */
const MAP_TOKEN_SCALE = 0.55;

/** Build the lightweight LOD-downgrade token — a static portrait disc, no per-frame skeleton cost. */
function buildDotToken(tp: number, unitType: UnitType): PIXI.Container {
  return buildAvatar(Math.max(16, tp * MAP_TOKEN_SCALE), '', 7, makeAvatarId('hero', unitType));
}

/** Tear down either token-entry variant (also used by lifecycle.ts::destroy()). */
export function destroyTokenEntry(entry: MapTokenEntry): void {
  if (entry.mode === 'stickman') entry.runtime?.destroy();
  else entry.sprite.destroy({ children: true });
  entry.badge?.sprite.destroy();
}

/** Corner-badge size as a fraction of the token's own pixel size (small enough to read as a badge, not compete with the unit rig). */
const BADGE_SCALE = 0.42;

/**
 * March/occupy/stationed map-token family-emblem corner badge (family-emblem-art-prompts.md,
 * 2026-08-14 TODO item 4 — WORLD_MAP_ART_SPEC.md §五). A small tinted overlay in the token's
 * bottom-right corner, NOT a replacement of the unit-rig token itself (that would regress the
 * 2026-07-26 "show the deployed team's real leader unit-type" decision this module already
 * implements — see resolveMarchUnitType's doc comment). Its own top-level display object on
 * `ctx.marchTokenLayer` (not a child of the stickman/dot container) so the stickman's
 * facing-direction mirror flip never mirrors the badge art; repositioned every frame independent
 * of that flip. No-op (and tears down any existing badge) when the owner has no emblem.
 */
function syncEmblemBadge(
  core: WorldMapRendererCore,
  entry: MapTokenEntry,
  emblemKey: string | undefined,
  emblemColor: number | undefined,
  cx: number,
  cy: number,
  tokenSize: number,
): void {
  const ctx = core.ctx;
  if (!emblemKey) {
    if (entry.badge) { entry.badge.sprite.destroy(); entry.badge = undefined; }
    return;
  }
  // Atlas is lazy-loaded (not boot L0 — see emblemAtlas.ts); this runs every frame there's a live
  // token with a badge to show, so a plain load() kick here (idempotent — cheap no-op once
  // resolved/in-flight) is enough to eventually surface it, no separate scene-entry wiring needed.
  void loadEmblemAtlas().catch(() => {});
  const size = Math.max(10, Math.round(tokenSize * BADGE_SCALE));
  if (!entry.badge || entry.badge.key !== emblemKey) {
    entry.badge?.sprite.destroy();
    const icon = buildEmblemIcon(emblemKey as EmblemKey, size, emblemColor ?? 0x2f2a26);
    if (!icon) { entry.badge = undefined; return; } // atlas not loaded yet — next frame retries once it is
    ctx.marchTokenLayer.addChild(icon);
    entry.badge = { sprite: icon, key: emblemKey };
  }
  // Bottom-right corner of the token's own footprint.
  entry.badge.sprite.x = cx + tokenSize * 0.22;
  entry.badge.sprite.y = cy + tokenSize * 0.22;
}

/** Shared mutable counter threaded through a single renderOverlay(dt) pass (see STICKMAN_TOKEN_BUDGET). */
export interface StickmanBudget { remaining: number; }

/**
 * Walk-cycle sprite riding each visible march's route (replaces the earlier plain diamond
 * token). One pooled token per in-flight march, keyed by marchId — 'stickman' mode (subject to
 * STICKMAN_TOKEN_BUDGET) or the 'dot' LOD downgrade past budget (see MapTokenEntry). Runtimes
 * for marches no longer present (arrived, cancelled, or scrolled past zoom<3) are torn down.
 */
export function syncMarchTokens(core: WorldMapRendererCore, dt: number, budget: StickmanBudget): void {
  const ctx = core.ctx;
  const live = new Set<string>();
  if (ctx.zoom < 3) {
    const now = Date.now();
    const tp = ctx.tp;
    for (const march of ctx.marches) {
      const fromXY = ctx.parseTileStrict(march.fromTile);
      const toXY = ctx.parseTileStrict(march.toTile);
      if (!fromXY || !toXY) continue;
      const [fx, fy] = fromXY;
      const [tx2, ty2] = toXY;
      const from = tileToScreen(fx, fy, tp);
      const to = tileToScreen(tx2, ty2, tp);
      const fpx = ctx.panX + from.x;
      const fpy = ctx.panY + from.y;
      const px  = ctx.panX + to.x;
      const py  = ctx.panY + to.y;

      const span = march.arriveAt - march.departAt;
      const frac = span > 0 ? Math.min(1, Math.max(0, (now - march.departAt) / span)) : 1;
      const hx = fpx + (px - fpx) * frac;
      const hy = fpy + (py - fpy) * frac;
      const mirrorX = px < fpx;

      live.add(march.marchId);
      const unitType = resolveMarchUnitType(march.kind, march.leaderUnitType);
      let entry = ctx.marchTokenRuntimes.get(march.marchId);
      if (entry && entry.kind !== unitType) {
        destroyTokenEntry(entry);
        ctx.marchTokenRuntimes.delete(march.marchId);
        entry = undefined;
      }
      if (!entry) {
        if (budget.remaining > 0) {
          budget.remaining--;
          // Placeholder while the (cached-after-first-use) .tao asset loads — the runtime
          // itself needs a resolved TaoAsset, so it's built async and starts absent/invisible.
          const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
          entry = stickmanEntry;
          ctx.marchTokenRuntimes.set(march.marchId, entry);
          const { url, type } = marchTokenAssetFor(unitType);
          const target = tp * MAP_TOKEN_SCALE;
          StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
            const current = ctx.marchTokenRuntimes.get(march.marchId);
            if (!current || current !== stickmanEntry) return; // march ended or asset swapped meanwhile
            const runtime = new StickmanRuntime(asset, { targetHeight: target, mirrorX, showShadow: false });
            ctx.marchTokenLayer.addChild(runtime.container);
            stickmanEntry.runtime = runtime;
          }).catch(err => { console.warn(`[WorldMap] march token .tao failed to load (${unitType}):`, err); });
        } else {
          // LOD downgrade (2026-07-26): past STICKMAN_TOKEN_BUDGET live tokens, render a single
          // static portrait disc instead of spinning up another full skeleton.
          const sprite = buildDotToken(tp, unitType);
          ctx.marchTokenLayer.addChild(sprite);
          entry = { mode: 'dot', sprite, kind: unitType };
          ctx.marchTokenRuntimes.set(march.marchId, entry);
        }
      } else if (entry.mode === 'stickman') {
        budget.remaining--; // existing stickman tokens still hold their slot
      }
      if (entry.mode === 'stickman') {
        if (entry.runtime) {
          entry.runtime.setSilhouette(march.mine === false ? ENEMY_BASE_TINT : null); // enemy march = flat red (ADR-051 P4)
          entry.runtime.syncState('moving');
          entry.runtime.update(dt);
          entry.runtime.container.position.set(hx, hy);
          const baseScaleX = Math.abs(entry.runtime.container.scale.x);
          entry.runtime.container.scale.x = mirrorX ? -baseScaleX : baseScaleX;
        }
      } else {
        entry.sprite.position.set(hx - entry.sprite.width / 2, hy - entry.sprite.height / 2);
      }
      syncEmblemBadge(core, entry, march.emblemKey, march.emblemColor, hx, hy, tp * MAP_TOKEN_SCALE);
    }
  }
  const now = Date.now();
  for (const [id, entry] of ctx.marchTokenRuntimes) {
    if (live.has(id)) continue;
    const attackUntil = ctx.marchAttackUntil.get(id);
    if (attackUntil != null && now < attackUntil) {
      // Resolved as an attack (occupy/siege) — keep the token alive playing 'attacking'
      // instead of tearing it down instantly; position stays wherever it last was.
      if (entry.mode === 'stickman' && entry.runtime) {
        entry.runtime.syncState('attacking');
        entry.runtime.update(dt);
      }
      continue;
    }
    ctx.marchAttackUntil.delete(id);
    destroyTokenEntry(entry);
    ctx.marchTokenRuntimes.delete(id);
  }
}

/**
 * Keep a siege-rig token playing the 'attacking' clip on every tile I currently have an
 * occupation hold on (ctx.occupations, refreshed alongside marches), for the full hold
 * duration rather than the brief post-arrival beat syncMarchTokens/marchAttackUntil covers.
 * syncState('attacking') replays a finished non-loop clip on every call (see
 * StickmanRuntime.syncState), so simply calling it every frame the hold is still active
 * makes the swing repeat for as long as the countdown runs.
 */
export function syncOccupyTokens(core: WorldMapRendererCore, dt: number, budget: StickmanBudget): void {
  const ctx = core.ctx;
  const live = new Set<string>();
  if (ctx.zoom < 3) {
    const tp = ctx.tp;
    for (const o of ctx.occupations) {
      const key = `${o.x}:${o.y}`;
      live.add(key);
      const s = tileToScreen(o.x, o.y, tp);
      const cx = ctx.panX + s.x;
      const cy = ctx.panY + s.y;

      const unitType = resolveMarchUnitType('attack', o.leaderUnitType);
      let entry = ctx.occupyTokenRuntimes.get(key);
      if (entry && entry.kind !== unitType) {
        destroyTokenEntry(entry);
        ctx.occupyTokenRuntimes.delete(key);
        entry = undefined;
      }
      if (!entry) {
        if (budget.remaining > 0) {
          budget.remaining--;
          const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
          entry = stickmanEntry;
          ctx.occupyTokenRuntimes.set(key, entry);
          const { url, type } = marchTokenAssetFor(unitType);
          StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
            const current = ctx.occupyTokenRuntimes.get(key);
            if (!current || current !== stickmanEntry) return; // hold ended meanwhile
            const runtime = new StickmanRuntime(asset, { targetHeight: tp * MAP_TOKEN_SCALE, showShadow: false });
            ctx.marchTokenLayer.addChild(runtime.container);
            stickmanEntry.runtime = runtime;
          }).catch(err => { console.warn('[WorldMap] occupy token .tao failed to load:', err); });
        } else {
          const sprite = buildDotToken(tp, unitType);
          ctx.marchTokenLayer.addChild(sprite);
          entry = { mode: 'dot', sprite, kind: unitType };
          ctx.occupyTokenRuntimes.set(key, entry);
        }
      } else if (entry.mode === 'stickman') {
        budget.remaining--;
      }
      if (entry.mode === 'stickman') {
        if (entry.runtime) {
          entry.runtime.syncState('attacking');
          entry.runtime.update(dt);
          entry.runtime.container.position.set(cx, cy);
        }
      } else {
        entry.sprite.position.set(cx - entry.sprite.width / 2, cy - entry.sprite.height / 2);
      }
      syncEmblemBadge(core, entry, o.emblemKey, o.emblemColor, cx, cy, tp * MAP_TOKEN_SCALE);
    }
  }
  for (const [key, entry] of ctx.occupyTokenRuntimes) {
    if (live.has(key)) continue;
    destroyTokenEntry(entry);
    ctx.occupyTokenRuntimes.delete(key);
  }
}

/**
 * Idle-standing sprite on every tile holding a stationed team (ctx.stationed, refreshed alongside marches).
 * Unlike march/occupy tokens these are NOT torn down on arrival — the team stands there (playing the 'idle'
 * clip) until moved or recalled (2026-07-23 field-stationing). ADR-051 (P4): ctx.stationed now also carries
 * ENEMY stationed teams within vision (s.mine === false); those are recolored to a flat red silhouette
 * (setSilhouette(ENEMY_BASE_TINT)) so friend/foe reads at a glance, while own teams keep their full-color
 * rig. 驻扎 vs 停留 is conveyed by the 3×3 zone aura (renderGarrisonZones), not the token itself. Mirrors
 * syncOccupyTokens' pooled-runtime pattern; runtimes for tiles no longer stationed are torn down.
 */
export function syncStationedTokens(core: WorldMapRendererCore, dt: number, budget: StickmanBudget): void {
  const ctx = core.ctx;
  const live = new Set<string>();
  if (ctx.zoom < 3) {
    const tp = ctx.tp;
    for (const s of ctx.stationed) {
      const key = `${s.x}:${s.y}`;
      live.add(key);
      const scr = tileToScreen(s.x, s.y, tp);
      const cx = ctx.panX + scr.x;
      const cy = ctx.panY + scr.y;

      const unitType = resolveMarchUnitType(undefined, s.leaderUnitType);
      let entry = ctx.stationedTokenRuntimes.get(key);
      if (entry && entry.kind !== unitType) {
        destroyTokenEntry(entry);
        ctx.stationedTokenRuntimes.delete(key);
        entry = undefined;
      }
      if (!entry) {
        if (budget.remaining > 0) {
          budget.remaining--;
          const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
          entry = stickmanEntry;
          ctx.stationedTokenRuntimes.set(key, entry);
          const { url, type } = marchTokenAssetFor(unitType);
          StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
            const current = ctx.stationedTokenRuntimes.get(key);
            if (!current || current !== stickmanEntry) return; // team moved/recalled meanwhile
            const runtime = new StickmanRuntime(asset, { targetHeight: tp * MAP_TOKEN_SCALE, showShadow: false });
            ctx.marchTokenLayer.addChild(runtime.container);
            stickmanEntry.runtime = runtime;
          }).catch(err => { console.warn('[WorldMap] stationed token .tao failed to load:', err); });
        } else {
          const sprite = buildDotToken(tp, unitType);
          ctx.marchTokenLayer.addChild(sprite);
          entry = { mode: 'dot', sprite, kind: unitType };
          ctx.stationedTokenRuntimes.set(key, entry);
        }
      } else if (entry.mode === 'stickman') {
        budget.remaining--;
      }
      if (entry.mode === 'stickman') {
        if (entry.runtime) {
          entry.runtime.setSilhouette(s.mine === false ? ENEMY_BASE_TINT : null); // enemy = flat red; own keeps art
          entry.runtime.syncState('idle'); // unknown state → 'idle' clip (STATE_ANIM fallback)
          entry.runtime.update(dt);
          entry.runtime.container.position.set(cx, cy);
        }
      } else {
        entry.sprite.position.set(cx - entry.sprite.width / 2, cy - entry.sprite.height / 2);
      }
      syncEmblemBadge(core, entry, s.emblemKey, s.emblemColor, cx, cy, tp * MAP_TOKEN_SCALE);
    }
  }
  for (const [key, entry] of ctx.stationedTokenRuntimes) {
    if (live.has(key)) continue;
    destroyTokenEntry(entry);
    ctx.stationedTokenRuntimes.delete(key);
  }
}
