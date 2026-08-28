// Overlay stack drawn above the tile pool: the L3 batched overview, the off-map cloud/mist veil,
// and the interactive overlay (selected-tile highlight, capital stars, march arrows).
//
// 2026-08-12 composition conversion note: the old FogMixin also owned `renderMap()` — a one-line
// forward to `this.invalidatePool()` (pool.ts) — which made fog.ts the other half of this chain's
// pool.ts↔fog.ts bidirectional pair (pool.invalidatePool() called `this.renderOverlay()` right
// back). Per ../WorldMapRenderer.ts's file-header comment, `renderMap()` moves to the assembly,
// which is the only place that legitimately needs to sequence pool + city + fog together; this
// class no longer references pool at all. The march/occupy/stationed token helpers (previously
// the back half of this file) also moved out, to ./tokens.ts — see that file's header for why.
import { ISO_RATIO, tileToScreen, diamondPath, visibleTileBounds, clipConvexToRect } from '../../../render/isoGrid';
import { occupyFrontierCells } from '../logic/occupyFrontier';
import { HUD_H } from '../logic/constants';
import { ENEMY_BASE_TINT, MINE_BASE_TINT, CLOUD_COLOR, tileColor, proceduralTileColor } from '../logic/tileStyle';
import { baseFootprintCells } from '@nw/shared';
import { drawStar, drawDashedPolygon, drawPolygonCornerTicks, drawFadedLine } from '../tileGraphics';
import type { WorldMapRendererCore } from './core';
import { STICKMAN_TOKEN_BUDGET, syncMarchTokens, syncOccupyTokens, syncStationedTokens, type StickmanBudget } from './tokens';

// Re-exported for backward compatibility — moved to ./tokens.ts (2026-08-12), but
// `test/ui/marchTokenLod.ui.ts` still imports it from here.
export { STICKMAN_TOKEN_BUDGET };

export interface FogHandlers {
  renderMapL3(): void;
  renderFog(): void;
  renderOccupyFrontier(): void;
  renderGarrisonZones(): void;
  renderOverlay(dt?: number): void;
}

export class WorldMapRendererFog implements FogHandlers {
  constructor(private readonly core: WorldMapRendererCore) {}

  renderMapL3(): void {
    const ctx = this.core.ctx;
    ctx.l3Dirty = false;
    const g = ctx.mapGfxL3;
    g.clear();
    const { w, h, panX, panY, tp } = ctx;
    const mapH = h - HUD_H;
    const b = visibleTileBounds(w, mapH, panX, panY, tp);

    // Group tiles by fill color for batched rendering (coords = each tile's diamond center).
    const groups = new Map<number, number[]>(); // color → [cx,cy, cx,cy, ...]
    for (let ty = Math.max(0, b.minTy); ty <= Math.min(ctx.mapH - 1, b.maxTy); ty++) {
      for (let tx = Math.max(0, b.minTx); tx <= Math.min(ctx.mapW - 1, b.maxTx); tx++) {
        const tile = ctx.tileCache.get(`${tx}:${ty}`);
        let color = tile ? tileColor(tile) : proceduralTileColor(ctx.cb.worldId, tx, ty);
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
    const ctx = this.core.ctx;
    const g = ctx.fogGfx;
    g.clear();
    const tp = ctx.tp;
    const mapViewH = ctx.h - HUD_H;
    const hw = tp / 2;
    const hh = (tp * ISO_RATIO) / 2;
    const px = ctx.panX;
    const py = ctx.panY;
    // Outer vertices of the tile-area parallelogram (extreme corner tiles' outer diamond points).
    const top    = tileToScreen(0, 0, tp);
    const right  = tileToScreen(ctx.mapW - 1, 0, tp);
    const bottom = tileToScreen(ctx.mapW - 1, ctx.mapH - 1, tp);
    const left   = tileToScreen(0, ctx.mapH - 1, tp);
    const holePts = [
      { x: px + top.x,        y: py + top.y - hh },
      { x: px + right.x + hw, y: py + right.y },
      { x: px + bottom.x,     y: py + bottom.y + hh },
      { x: px + left.x - hw,  y: py + left.y },
    ];
    const clipped = clipConvexToRect(holePts, ctx.w, mapViewH);
    g.beginFill(CLOUD_COLOR, 0.97);
    g.drawRect(0, 0, ctx.w, mapViewH);
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
    const ctx = this.core.ctx;
    const me = ctx.me;
    if (!me?.joined || ctx.zoom >= 3) return; // L1/L2 only
    const g = ctx.overlayGfx;
    const tp = ctx.tp;
    const { w, h, panX, panY } = ctx;
    const mapH = h - HUD_H;

    const cells = occupyFrontierCells({
      worldId: ctx.cb.worldId,
      mapW: ctx.mapW,
      mapH: ctx.mapH,
      bounds: visibleTileBounds(w, mapH, panX, panY, tp),
      mainBaseTile: me.mainBaseTile,
      tileCache: ctx.tileCache,
      parseAnchor: (id) => ctx.parseTileStrict(id),
    });
    if (cells.length === 0) return;

    const diamond = diamondPath(tp);
    // Fill pass: soft tint only, no solid stroke — this reads as a "guidance" hint distinct from
    // territory's solid border and the garrison zone's dashes (2026-08-01 declutter pass, see
    // tileGraphics.ts).
    g.lineStyle(0);
    g.beginFill(0x37d67a, 0.13);
    for (const { x, y } of cells) {
      const s = tileToScreen(x, y, tp);
      const cx = panX + s.x, cy = panY + s.y;
      const pts: number[] = new Array(diamond.length);
      for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
      g.drawPolygon(pts);
    }
    g.endFill();
    // 2026-08-17 ("目前太显眼了…要能让玩家一眼看到，但不能太抢夺焦点"): the previous full dashed
    // perimeter (tp*0.08 wide @ alpha 0.9, dash tp*0.16) drew a continuous fat green rope through
    // every frontier cell and dominated the whole screen. Corner brackets instead — a third of the
    // stroke weight, half the alpha, and only ~4×2 short stubs per cell, so the band still pops out
    // of the pale paper at a glance without out-shouting the buildings and marches on top of it.
    // The slightly stronger fill above carries the "which exact cells" read the outline used to.
    g.lineStyle(Math.max(1, tp * 0.022), 0x37d67a, 0.45);
    for (const { x, y } of cells) {
      const s = tileToScreen(x, y, tp);
      const cx = panX + s.x, cy = panY + s.y;
      const pts: number[] = new Array(diamond.length);
      for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
      drawPolygonCornerTicks(g, pts, 0.13);
    }
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
    const ctx = this.core.ctx;
    if (ctx.zoom >= 3) return;
    const stationed = ctx.stationed;
    if (!stationed.length) return;
    const g = ctx.overlayGfx;
    const tp = ctx.tp;
    const { panX, panY, mapW, mapH } = ctx;
    const diamond = diamondPath(tp);
    // Group by ownership so each color batches one fill/stroke pass (own = blue ink, enemy = red ink —
    // the same convention as territory tints / march arrows).
    for (const mine of [true, false]) {
      const zones = stationed.filter((s) => s.mode === 'garrison' && (s.mine !== false) === mine);
      if (!zones.length) continue;
      const col = mine ? MINE_BASE_TINT : ENEMY_BASE_TINT;
      // Fill pass over all 9 footprint cells (incl. center) with no stroke set — the ring's
      // shared inner edges only ever get filled, never a doubled-up border from both sides.
      g.lineStyle(0);
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
      // Short-dash border pass, ring cells only (skip the center — baseFootprintCells(s.x,s.y)
      // always includes (s.x,s.y) itself; outlining it would read as a cross through the
      // halo's middle, same idea as tileGraphics.ts's ownerBorder declutter). Short dash/gap
      // distinguishes this "defended zone" warning from the frontier's longer guidance dashes.
      g.lineStyle(Math.max(1.5, tp * 0.05), col, 0.38);
      for (const s of zones) {
        for (const { x, y } of baseFootprintCells(s.x, s.y)) {
          if (x === s.x && y === s.y) continue;
          if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
          const scr = tileToScreen(x, y, tp);
          const cx = panX + scr.x, cy = panY + scr.y;
          const pts: number[] = new Array(diamond.length);
          for (let k = 0; k < diamond.length; k += 2) { pts[k] = diamond[k]! + cx; pts[k + 1] = diamond[k + 1]! + cy; }
          drawDashedPolygon(g, pts, tp * 0.06, tp * 0.05);
        }
      }
    }
    g.lineStyle(0);
  }

  renderOverlay(dt = 0): void {
    const ctx = this.core.ctx;
    this.renderFog();
    const g = ctx.overlayGfx;
    g.clear();
    const tp = ctx.tp;

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
    if (ctx.selectedTile) {
      const { x: tx, y: ty } = ctx.selectedTile;
      const s = tileToScreen(tx, ty, tp);
      const cx = ctx.panX + s.x;
      const cy = ctx.panY + s.y;
      const pts = diamondPath(tp).map((v, i) => v + (i % 2 === 0 ? cx : cy));
      g.lineStyle(2, 0xffcc00, 1);
      g.beginFill(0xffff00, 0.15);
      g.drawPolygon(pts);
      g.endFill();
    }

    // Capital star markers (10 nations).
    const starR = Math.max(6, tp * 0.45);
    for (const n of ctx.nations) {
      const s = tileToScreen(n.x, n.y, tp);
      const cx = ctx.panX + s.x;
      const cy = ctx.panY + s.y;
      if (cx < -tp || cy < -tp || cx > ctx.w + tp || cy > ctx.h - HUD_H + tp) continue;
      drawStar(g, cx, cy, starR, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
    }

    // March arrows (L1/L2 only; L3 is too zoomed-out for detail).
    if (ctx.zoom < 3) {
      for (const march of ctx.marches) {
        const fromXY = ctx.parseTileStrict(march.fromTile);
        const toXY = ctx.parseTileStrict(march.toTile);
        if (!fromXY || !toXY) continue; // skip malformed/out-of-bounds endpoints (no origin-crossing stray line)
        const [fx, fy] = fromXY;
        const [tx2, ty2] = toXY;
        const from = tileToScreen(fx, fy, tp);
        const to = tileToScreen(tx2, ty2, tp);
        const fpx = ctx.panX + from.x;
        const fpy = ctx.panY + from.y;
        const px  = ctx.panX + to.x;
        const py  = ctx.panY + to.y;
        const enemy = march.mine === false;
        const col = enemy ? ENEMY_BASE_TINT
          : march.kind === 'return'   ? 0x44cc88
          : march.kind === 'attack'   ? 0xcc3333
          : march.kind === 'reinforce'? 0x44aacc
          : 0x00b8f0; // occupy/sweep/move: azure — more blue-leaning than the earlier teal, distinct from reinforce's muted blue-gray
        // Faded route trace (2026-08-01 declutter pass): starts thin/dim at the origin and
        // ramps to full strength (was a flat 1.5-2.5px @ 0.22-0.3 alpha full-length trace,
        // then bumped to a flat bold 5-8px — both read as an equal-weight bar end to end) so
        // several marches converging on one tile don't bundle into a solid mass; the last
        // ~28% holds at full strength so the arrowhead below never looks like it's fading in.
        const endW = enemy ? 8 : 5;
        const endA = enemy ? 0.85 : 0.8;
        drawFadedLine(g, fpx, fpy, px, py, col, endW * 0.4, endA * 0.35, endW, endA, 0.28, 9);

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
    syncMarchTokens(this.core, dt, budget);
    syncOccupyTokens(this.core, dt, budget);
    syncStationedTokens(this.core, dt, budget);
  }
}
