// Overlay stack drawn above the tile pool: the L3 batched overview, the off-map cloud/mist veil,
// and the interactive overlay (selected-tile highlight, capital stars, march arrows).
import { ISO_RATIO, tileToScreen, diamondPath, visibleTileBounds, clipConvexToRect } from '../../../render/isoGrid';
import { occupyFrontierCells } from '../occupyFrontier';
import { HUD_H } from '../constants';
import { ENEMY_BASE_TINT, MINE_BASE_TINT, CLOUD_COLOR, tileColor, proceduralTileColor } from '../tileStyle';
import { baseFootprintCells } from '@nw/shared';
import { drawStar } from '../tileGraphics';
import { StickmanRuntime } from '../../../render/stickman/StickmanRuntime';
import { UnitType } from '../../../game/types';
import { targetScreenHeight } from '../../../render/unitSize';
import { STICKMAN_ASSETS } from '../../../render/UnitView';
import { buildAvatar, makeAvatarId } from '../../../render/avatar';
import { type Constructor, type WorldMapRendererBaseCtor } from './base';
import type { MapTokenEntry } from '../WorldMapContext';
import * as PIXI from 'pixi.js-legacy';

/**
 * March/occupy/stationed token art (2026-07-26): prefers the deployed team's actual leader
 * unit-type (server-resolved once at dispatch — see MarchView.leaderUnitType / design/game/
 * WORLD_MAP_ART_SPEC.md), so e.g. an archer-led team's march rides an archer rig instead of the
 * old fixed normal/siege split. Falls back to the pre-2026-07-26 default (shield-bearer for an
 * attack/siege identity, infantry otherwise) for flat-troop marches/holds with no team attached.
 * Guilds/banners are intentionally out of scope here (see the WORLD_MAP_ART_SPEC TODO) — this
 * only swaps which of the 6 already-authored unit rigs represents the token.
 */
function resolveMarchUnitType(fallbackKind: string | undefined, leaderUnitType: string | undefined): UnitType {
  if (leaderUnitType && STICKMAN_ASSETS[leaderUnitType as UnitType]) return leaderUnitType as UnitType;
  return fallbackKind === 'attack' ? UnitType.ShieldBearer : UnitType.Infantry;
}

function marchTokenAssetFor(unitType: UnitType): { url: string; type: UnitType } {
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

/** Build the lightweight LOD-downgrade token — a static portrait disc, no per-frame skeleton cost. */
function buildDotToken(tp: number, unitType: UnitType): PIXI.Container {
  return buildAvatar(Math.max(16, tp * 0.9), '', 7, makeAvatarId('hero', unitType));
}

/** Tear down either token-entry variant (also used by lifecycle.ts::destroy()). */
export function destroyTokenEntry(entry: MapTokenEntry): void {
  if (entry.mode === 'stickman') entry.runtime?.destroy();
  else entry.sprite.destroy({ children: true });
}

/** Shared mutable counter threaded through a single renderOverlay(dt) pass (see STICKMAN_TOKEN_BUDGET). */
export interface StickmanBudget { remaining: number; }

export interface FogHandlers {
  renderMapL3(): void;
  renderFog(): void;
  renderOccupyFrontier(): void;
  renderGarrisonZones(): void;
  renderOverlay(dt?: number): void;
  syncMarchTokens(dt: number, budget: StickmanBudget): void;
  syncOccupyTokens(dt: number, budget: StickmanBudget): void;
  syncStationedTokens(dt: number, budget: StickmanBudget): void;
  renderMap(): void;
}

export function FogMixin<TBase extends WorldMapRendererBaseCtor>(Base: TBase): TBase & Constructor<FogHandlers> {
  return class extends Base {
    renderMapL3(): void {
      this.ctx.l3Dirty = false;
      const g = this.ctx.mapGfxL3;
      g.clear();
      const { w, h, panX, panY, tp } = this.ctx;
      const mapH = h - HUD_H;
      const b = visibleTileBounds(w, mapH, panX, panY, tp);

      // Group tiles by fill color for batched rendering (coords = each tile's diamond center).
      const groups = new Map<number, number[]>(); // color → [cx,cy, cx,cy, ...]
      for (let ty = Math.max(0, b.minTy); ty <= Math.min(this.ctx.mapH - 1, b.maxTy); ty++) {
        for (let tx = Math.max(0, b.minTx); tx <= Math.min(this.ctx.mapW - 1, b.maxTx); tx++) {
          const tile = this.ctx.tileCache.get(`${tx}:${ty}`);
          let color = tile ? tileColor(tile) : proceduralTileColor(this.ctx.cb.worldId, tx, ty);
          if (tile?.visible === false) color = (color & 0x7f7f7f) | 0x404040; // darken fogged
          if (!groups.has(color)) groups.set(color, []);
          const s = tileToScreen(tx, ty, tp);
          groups.get(color)!.push(panX + s.x, panY + s.y);
        }
      }
      const diamond = diamondPath(tp - 1);
      for (const [color, coords] of groups) {
        g.lineStyle(0);
        g.beginFill(color, 0.88);
        for (let i = 0; i < coords.length; i += 2) {
          const cx = coords[i]!, cy = coords[i + 1]!;
          const pts: number[] = new Array(diamond.length);
          for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
          g.drawPolygon(pts);
        }
        g.endFill();
      }
    }

    /**
     * Cloud/mist veil over everything outside the map's tile area. The map's tile rectangle
     * (0..mapW-1 × 0..mapH-1) projects to a screen-space parallelogram; we fill the whole
     * viewport with cloud and punch that parallelogram out as a hole, then lay a soft thick
     * stroke along its edge so the map fades into mist rather than ending on a hard diamond.
     * Redrawn from renderOverlay(), which fires on every pan / zoom / data change.
     *
     * The map is up to 1500×1500, so the projected parallelogram is enormous — its outer
     * vertices sit hundreds of thousands of px past the viewport. Feeding that raw polygon
     * to beginHole() makes PIXI's earcut hole triangulation fail, leaving the cloud rect a
     * solid fill that blanks the whole map (the "SLG map went blank" regression). So we first
     * clip the parallelogram to the viewport rect: the hole then has bounded coordinates, and
     * when the map fully covers the viewport (camera centered on a big map) the clip collapses
     * to the rect itself → hole == fill → no veil shows, exactly as intended.
     */
    renderFog(): void {
      const g = this.ctx.fogGfx;
      g.clear();
      const tp = this.ctx.tp;
      const mapViewH = this.ctx.h - HUD_H;
      const hw = tp / 2;
      const hh = (tp * ISO_RATIO) / 2;
      const px = this.ctx.panX;
      const py = this.ctx.panY;
      // Outer vertices of the tile-area parallelogram (extreme corner tiles' outer diamond points).
      const top    = tileToScreen(0, 0, tp);
      const right  = tileToScreen(this.ctx.mapW - 1, 0, tp);
      const bottom = tileToScreen(this.ctx.mapW - 1, this.ctx.mapH - 1, tp);
      const left   = tileToScreen(0, this.ctx.mapH - 1, tp);
      const holePts = [
        { x: px + top.x,        y: py + top.y - hh },
        { x: px + right.x + hw, y: py + right.y },
        { x: px + bottom.x,     y: py + bottom.y + hh },
        { x: px + left.x - hw,  y: py + left.y },
      ];
      const clipped = clipConvexToRect(holePts, this.ctx.w, mapViewH);
      g.beginFill(CLOUD_COLOR, 0.97);
      g.drawRect(0, 0, this.ctx.w, mapViewH);
      // Only punch a hole when the map actually intersects the viewport; a degenerate clip
      // (< 3 vertices) means the map is entirely off-screen, so the veil covers everything.
      if (clipped.length >= 3) {
        const flat: number[] = [];
        for (const p of clipped) { flat.push(p.x, p.y); }
        g.beginHole();
        g.drawPolygon(flat);
        g.endHole();
      }
      g.endFill();
      // Misty rim: a soft thick stroke along the true map boundary (the un-clipped parallelogram,
      // so the stroke follows real map edges; the mapClip mask trims whatever falls off-screen).
      const hole = [holePts[0]!.x, holePts[0]!.y, holePts[1]!.x, holePts[1]!.y, holePts[2]!.x, holePts[2]!.y, holePts[3]!.x, holePts[3]!.y];
      g.lineStyle(Math.max(6, tp * 0.55), CLOUD_COLOR, 0.4);
      g.drawPolygon(hole);
      g.lineStyle(Math.max(3, tp * 0.22), CLOUD_COLOR, 0.55);
      g.drawPolygon(hole);
      g.lineStyle(0);
    }

    /**
     * Outline the occupiable "连地" frontier: neutral, occupiable tiles that are 4-directionally adjacent
     * to the player's own or same-family territory (the own capital's 3×3 footprint counts as guaranteed
     * initial territory even if a ring cell lost its ownerId). Solo players see their own border; family
     * players additionally see family-shared borders. Sibling-family (same sect) frontier isn't marked —
     * the client can't distinguish those tiles — but this is additive guidance, not a gate, so an
     * un-highlighted tile is never wrongly blocked (the Occupy button is still offered; server validates).
     */
    renderOccupyFrontier(): void {
      const me = this.ctx.me;
      if (!me?.joined || this.ctx.zoom >= 3) return; // L1/L2 only
      const g = this.ctx.overlayGfx;
      const tp = this.ctx.tp;
      const { w, h, panX, panY } = this.ctx;
      const mapH = h - HUD_H;

      const cells = occupyFrontierCells({
        worldId: this.ctx.cb.worldId,
        mapW: this.ctx.mapW,
        mapH: this.ctx.mapH,
        bounds: visibleTileBounds(w, mapH, panX, panY, tp),
        mainBaseTile: me.mainBaseTile,
        tileCache: this.ctx.tileCache,
        parseAnchor: (id) => this.ctx.parseTileStrict(id),
      });
      if (cells.length === 0) return;

      const diamond = diamondPath(tp);
      g.lineStyle(Math.max(2, tp * 0.08), 0x37d67a, 0.9);
      g.beginFill(0x37d67a, 0.14);
      for (const { x, y } of cells) {
        const s = tileToScreen(x, y, tp);
        const cx = panX + s.x, cy = panY + s.y;
        const pts: number[] = new Array(diamond.length);
        for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
        g.drawPolygon(pts);
      }
      g.endFill();
      g.lineStyle(0);
    }

    /**
     * ADR-051 (P4): draw the 3×3 defense-zone aura under every visible 驻扎 garrison team — own (red) and
     * enemy (blue), from ctx.stationed (getStationed now returns enemy stationed teams within vision). This
     * is the footprint the garrison actively intercepts through (worldsvc `cover` reverse-index): a march
     * that steps onto any of these 9 cells is fought by the garrison, so the halo tells the player which
     * ground to route around (enemy) or is safely held (own). 停留 idle teams have no zone — only their cell
     * is passively defended — so they get a token but no halo. L1/L2 only (matches token rendering).
     */
    renderGarrisonZones(): void {
      if (this.ctx.zoom >= 3) return;
      const stationed = this.ctx.stationed;
      if (!stationed.length) return;
      const g = this.ctx.overlayGfx;
      const tp = this.ctx.tp;
      const { panX, panY, mapW, mapH } = this.ctx;
      const diamond = diamondPath(tp);
      // Group by ownership so each color batches one fill/stroke pass (own = red ink, enemy = blue ink —
      // the same convention as territory tints / march arrows).
      for (const mine of [true, false]) {
        const zones = stationed.filter((s) => s.mode === 'garrison' && (s.mine !== false) === mine);
        if (!zones.length) continue;
        const col = mine ? MINE_BASE_TINT : ENEMY_BASE_TINT;
        g.lineStyle(Math.max(1.5, tp * 0.05), col, 0.55);
        g.beginFill(col, 0.12);
        for (const s of zones) {
          for (const { x, y } of baseFootprintCells(s.x, s.y)) {
            if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue; // clamp footprint to the map
            const scr = tileToScreen(x, y, tp);
            const cx = panX + scr.x, cy = panY + scr.y;
            const pts: number[] = new Array(diamond.length);
            for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
            g.drawPolygon(pts);
          }
        }
        g.endFill();
      }
      g.lineStyle(0);
    }

    renderOverlay(dt = 0): void {
      this.renderFog();
      const g = this.ctx.overlayGfx;
      g.clear();
      const tp = this.ctx.tp;

      // Occupy frontier highlight (三战/率土-style, ADR-039 连地): outline the neutral tiles that border
      // the player's own/family territory and are therefore occupiable, so "which tiles can I take" is
      // shown up front instead of eyeballed off the isometric projection (a grid-diagonal tile renders
      // directly N/S/E/W and *looks* adjacent even though it only touches at a corner — see occupyConnected).
      // 4-directional (shared-edge) adjacency, matching worldsvc isConnectedToSectTerritory. Guidance only;
      // drawn under everything else. L1/L2 only (L3 bird's-eye is too dense for per-tile outlines).
      this.renderOccupyFrontier();

      // 驻扎 garrison defense zones (ADR-051 P4): the 3×3 footprint each garrison actively defends /
      // intercepts through. Drawn low (under selection/stars/arrows) so it reads as a ground aura.
      this.renderGarrisonZones();

      // Selected tile highlight — diamond outline centered on the tile (was a square
      // anchored at its top-left corner; tileToScreen gives the diamond center instead).
      if (this.ctx.selectedTile) {
        const { x: tx, y: ty } = this.ctx.selectedTile;
        const s = tileToScreen(tx, ty, tp);
        const cx = this.ctx.panX + s.x;
        const cy = this.ctx.panY + s.y;
        const pts = diamondPath(tp).map((v, i) => v + (i % 2 === 0 ? cx : cy));
        g.lineStyle(2, 0xffcc00, 1);
        g.beginFill(0xffff00, 0.15);
        g.drawPolygon(pts);
        g.endFill();
      }

      // Capital star markers (10 nations).
      const starR = Math.max(6, tp * 0.45);
      for (const n of this.ctx.nations) {
        const s = tileToScreen(n.x, n.y, tp);
        const cx = this.ctx.panX + s.x;
        const cy = this.ctx.panY + s.y;
        if (cx < -tp || cy < -tp || cx > this.ctx.w + tp || cy > this.ctx.h - HUD_H + tp) continue;
        drawStar(g, cx, cy, starR, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
      }

      // March arrows (L1/L2 only; L3 is too zoomed-out for detail).
      if (this.ctx.zoom < 3) {
        for (const march of this.ctx.marches) {
          const fromXY = this.ctx.parseTileStrict(march.fromTile);
          const toXY = this.ctx.parseTileStrict(march.toTile);
          if (!fromXY || !toXY) continue; // skip malformed/out-of-bounds endpoints (no origin-crossing stray line)
          const [fx, fy] = fromXY;
          const [tx2, ty2] = toXY;
          const from = tileToScreen(fx, fy, tp);
          const to = tileToScreen(tx2, ty2, tp);
          const fpx = this.ctx.panX + from.x;
          const fpy = this.ctx.panY + from.y;
          const px  = this.ctx.panX + to.x;
          const py  = this.ctx.panY + to.y;
          const enemy = march.mine === false;
          const col = enemy ? ENEMY_BASE_TINT
            : march.kind === 'return'   ? 0x44cc88
            : march.kind === 'attack'   ? 0xcc3333
            : march.kind === 'reinforce'? 0x44aacc
            : march.kind === 'scout'    ? 0x9b59b6
            : 0x00b8f0; // occupy/sweep: azure — more blue-leaning than the earlier teal, distinct from reinforce's muted blue-gray
          // Full-length route trace — bold and opaque enough to read at a glance (was 1.5-2.5px @ 0.22-0.3 alpha, nearly invisible).
          g.lineStyle(enemy ? 8 : 5, col, enemy ? 0.85 : 0.8);
          g.moveTo(fpx, fpy);
          g.lineTo(px, py);
          g.lineStyle(0);

          const ang = Math.atan2(py - fpy, px - fpx);

          // Directed chevron head at the destination (kept as the route's endpoint marker).
          const headLen = enemy ? 11 : 9;
          const spread = 0.45; // radians off the shaft on each side
          g.lineStyle(enemy ? 3 : 2, col, 0.5);
          g.moveTo(px - Math.cos(ang - spread) * headLen, py - Math.sin(ang - spread) * headLen);
          g.lineTo(px, py);
          g.lineTo(px - Math.cos(ang + spread) * headLen, py - Math.sin(ang + spread) * headLen);
          g.lineStyle(0);
        }
      }

      // Shared across all three sync calls (2026-07-26): marches get first claim on the budget (most
      // visually important / dynamic), then occupations, then stationed — see STICKMAN_TOKEN_BUDGET.
      const budget: StickmanBudget = { remaining: STICKMAN_TOKEN_BUDGET };
      this.syncMarchTokens(dt, budget);
      this.syncOccupyTokens(dt, budget);
      this.syncStationedTokens(dt, budget);
    }

    /**
     * Walk-cycle sprite riding each visible march's route (replaces the earlier plain diamond
     * token). One pooled token per in-flight march, keyed by marchId — 'stickman' mode (subject to
     * STICKMAN_TOKEN_BUDGET) or the 'dot' LOD downgrade past budget (see MapTokenEntry). Runtimes
     * for marches no longer present (arrived, cancelled, or scrolled past zoom<3) are torn down.
     */
    syncMarchTokens(dt: number, budget: StickmanBudget): void {
      const live = new Set<string>();
      if (this.ctx.zoom < 3) {
        const now = Date.now();
        const tp = this.ctx.tp;
        for (const march of this.ctx.marches) {
          const fromXY = this.ctx.parseTileStrict(march.fromTile);
          const toXY = this.ctx.parseTileStrict(march.toTile);
          if (!fromXY || !toXY) continue;
          const [fx, fy] = fromXY;
          const [tx2, ty2] = toXY;
          const from = tileToScreen(fx, fy, tp);
          const to = tileToScreen(tx2, ty2, tp);
          const fpx = this.ctx.panX + from.x;
          const fpy = this.ctx.panY + from.y;
          const px  = this.ctx.panX + to.x;
          const py  = this.ctx.panY + to.y;

          const span = march.arriveAt - march.departAt;
          const frac = span > 0 ? Math.min(1, Math.max(0, (now - march.departAt) / span)) : 1;
          const hx = fpx + (px - fpx) * frac;
          const hy = fpy + (py - fpy) * frac;
          const mirrorX = px < fpx;

          live.add(march.marchId);
          const unitType = resolveMarchUnitType(march.kind, march.leaderUnitType);
          let entry = this.ctx.marchTokenRuntimes.get(march.marchId);
          if (entry && entry.kind !== unitType) {
            destroyTokenEntry(entry);
            this.ctx.marchTokenRuntimes.delete(march.marchId);
            entry = undefined;
          }
          if (!entry) {
            if (budget.remaining > 0) {
              budget.remaining--;
              // Placeholder while the (cached-after-first-use) .tao asset loads — the runtime
              // itself needs a resolved TaoAsset, so it's built async and starts absent/invisible.
              const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
              entry = stickmanEntry;
              this.ctx.marchTokenRuntimes.set(march.marchId, entry);
              const { url, type } = marchTokenAssetFor(unitType);
              const target = tp * 1.1;
              StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
                const current = this.ctx.marchTokenRuntimes.get(march.marchId);
                if (!current || current !== stickmanEntry) return; // march ended or asset swapped meanwhile
                const runtime = new StickmanRuntime(asset, { targetHeight: target, mirrorX, showShadow: false });
                this.ctx.marchTokenLayer.addChild(runtime.container);
                stickmanEntry.runtime = runtime;
              }).catch(err => { console.warn(`[WorldMap] march token .tao failed to load (${unitType}):`, err); });
            } else {
              // LOD downgrade (2026-07-26): past STICKMAN_TOKEN_BUDGET live tokens, render a single
              // static portrait disc instead of spinning up another full skeleton.
              const sprite = buildDotToken(tp, unitType);
              this.ctx.marchTokenLayer.addChild(sprite);
              entry = { mode: 'dot', sprite, kind: unitType };
              this.ctx.marchTokenRuntimes.set(march.marchId, entry);
            }
          } else if (entry.mode === 'stickman') {
            budget.remaining--; // existing stickman tokens still hold their slot
          }
          if (entry.mode === 'stickman') {
            if (entry.runtime) {
              entry.runtime.setSilhouette(march.mine === false ? ENEMY_BASE_TINT : null); // enemy march = flat blue (ADR-051 P4)
              entry.runtime.syncState('moving');
              entry.runtime.update(dt);
              entry.runtime.container.position.set(hx, hy);
              const baseScaleX = Math.abs(entry.runtime.container.scale.x);
              entry.runtime.container.scale.x = mirrorX ? -baseScaleX : baseScaleX;
            }
          } else {
            entry.sprite.position.set(hx - entry.sprite.width / 2, hy - entry.sprite.height / 2);
          }
        }
      }
      const now = Date.now();
      for (const [id, entry] of this.ctx.marchTokenRuntimes) {
        if (live.has(id)) continue;
        const attackUntil = this.ctx.marchAttackUntil.get(id);
        if (attackUntil != null && now < attackUntil) {
          // Resolved as an attack (occupy/siege) — keep the token alive playing 'attacking'
          // instead of tearing it down instantly; position stays wherever it last was.
          if (entry.mode === 'stickman' && entry.runtime) {
            entry.runtime.syncState('attacking');
            entry.runtime.update(dt);
          }
          continue;
        }
        this.ctx.marchAttackUntil.delete(id);
        destroyTokenEntry(entry);
        this.ctx.marchTokenRuntimes.delete(id);
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
    syncOccupyTokens(dt: number, budget: StickmanBudget): void {
      const live = new Set<string>();
      if (this.ctx.zoom < 3) {
        const tp = this.ctx.tp;
        for (const o of this.ctx.occupations) {
          const key = `${o.x}:${o.y}`;
          live.add(key);
          const s = tileToScreen(o.x, o.y, tp);
          const cx = this.ctx.panX + s.x;
          const cy = this.ctx.panY + s.y;

          const unitType = resolveMarchUnitType('attack', o.leaderUnitType);
          let entry = this.ctx.occupyTokenRuntimes.get(key);
          if (entry && entry.kind !== unitType) {
            destroyTokenEntry(entry);
            this.ctx.occupyTokenRuntimes.delete(key);
            entry = undefined;
          }
          if (!entry) {
            if (budget.remaining > 0) {
              budget.remaining--;
              const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
              entry = stickmanEntry;
              this.ctx.occupyTokenRuntimes.set(key, entry);
              const { url, type } = marchTokenAssetFor(unitType);
              StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
                const current = this.ctx.occupyTokenRuntimes.get(key);
                if (!current || current !== stickmanEntry) return; // hold ended meanwhile
                const runtime = new StickmanRuntime(asset, { targetHeight: tp * 1.1, showShadow: false });
                this.ctx.marchTokenLayer.addChild(runtime.container);
                stickmanEntry.runtime = runtime;
              }).catch(err => { console.warn('[WorldMap] occupy token .tao failed to load:', err); });
            } else {
              const sprite = buildDotToken(tp, unitType);
              this.ctx.marchTokenLayer.addChild(sprite);
              entry = { mode: 'dot', sprite, kind: unitType };
              this.ctx.occupyTokenRuntimes.set(key, entry);
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
        }
      }
      for (const [key, entry] of this.ctx.occupyTokenRuntimes) {
        if (live.has(key)) continue;
        destroyTokenEntry(entry);
        this.ctx.occupyTokenRuntimes.delete(key);
      }
    }

    /**
     * Idle-standing sprite on every tile holding a stationed team (ctx.stationed, refreshed alongside marches).
     * Unlike march/occupy tokens these are NOT torn down on arrival — the team stands there (playing the 'idle'
     * clip) until moved or recalled (2026-07-23 field-stationing). ADR-051 (P4): ctx.stationed now also carries
     * ENEMY stationed teams within vision (s.mine === false); those are recolored to a flat blue silhouette
     * (setSilhouette(ENEMY_BASE_TINT)) so friend/foe reads at a glance, while own teams keep their full-color
     * rig. 驻扎 vs 停留 is conveyed by the 3×3 zone aura (renderGarrisonZones), not the token itself. Mirrors
     * syncOccupyTokens' pooled-runtime pattern; runtimes for tiles no longer stationed are torn down.
     */
    syncStationedTokens(dt: number, budget: StickmanBudget): void {
      const live = new Set<string>();
      if (this.ctx.zoom < 3) {
        const tp = this.ctx.tp;
        for (const s of this.ctx.stationed) {
          const key = `${s.x}:${s.y}`;
          live.add(key);
          const scr = tileToScreen(s.x, s.y, tp);
          const cx = this.ctx.panX + scr.x;
          const cy = this.ctx.panY + scr.y;

          const unitType = resolveMarchUnitType(undefined, s.leaderUnitType);
          let entry = this.ctx.stationedTokenRuntimes.get(key);
          if (entry && entry.kind !== unitType) {
            destroyTokenEntry(entry);
            this.ctx.stationedTokenRuntimes.delete(key);
            entry = undefined;
          }
          if (!entry) {
            if (budget.remaining > 0) {
              budget.remaining--;
              const stickmanEntry: MapTokenEntry = { mode: 'stickman', runtime: null, kind: unitType };
              entry = stickmanEntry;
              this.ctx.stationedTokenRuntimes.set(key, entry);
              const { url, type } = marchTokenAssetFor(unitType);
              StickmanRuntime.loadAsset(url, targetScreenHeight(type)).then((asset) => {
                const current = this.ctx.stationedTokenRuntimes.get(key);
                if (!current || current !== stickmanEntry) return; // team moved/recalled meanwhile
                const runtime = new StickmanRuntime(asset, { targetHeight: tp * 1.1, showShadow: false });
                this.ctx.marchTokenLayer.addChild(runtime.container);
                stickmanEntry.runtime = runtime;
              }).catch(err => { console.warn('[WorldMap] stationed token .tao failed to load:', err); });
            } else {
              const sprite = buildDotToken(tp, unitType);
              this.ctx.marchTokenLayer.addChild(sprite);
              entry = { mode: 'dot', sprite, kind: unitType };
              this.ctx.stationedTokenRuntimes.set(key, entry);
            }
          } else if (entry.mode === 'stickman') {
            budget.remaining--;
          }
          if (entry.mode === 'stickman') {
            if (entry.runtime) {
              entry.runtime.setSilhouette(s.mine === false ? ENEMY_BASE_TINT : null); // enemy = flat blue; own keeps art
              entry.runtime.syncState('idle'); // unknown state → 'idle' clip (STATE_ANIM fallback)
              entry.runtime.update(dt);
              entry.runtime.container.position.set(cx, cy);
            }
          } else {
            entry.sprite.position.set(cx - entry.sprite.width / 2, cy - entry.sprite.height / 2);
          }
        }
      }
      for (const [key, entry] of this.ctx.stationedTokenRuntimes) {
        if (live.has(key)) continue;
        destroyTokenEntry(entry);
        this.ctx.stationedTokenRuntimes.delete(key);
      }
    }

    /** Legacy entry point — called from action handlers after data changes. */
    renderMap(): void {
      this.invalidatePool();
    }
  };
}
