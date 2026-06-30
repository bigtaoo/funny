// WorldMapScene — SLG overworld map scene (S8)
// 300×300 grid with viewport clipping + drag-to-pan.
// Only tiles inside the visible window are rendered each frame; tile data is fetched on demand and cached.
//
// Interaction logic:
//   - Drag to pan (drag > 8px cancels the tap)
//   - Tap empty tile → show "Establish Capital" or "Occupy" confirmation depending on player state
//   - Tap owned tile → show "Abandon / March" menu
//   - Bottom toolbar: troops / territory / resources; "Family" and "Auction" shortcuts

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../net/proto/transport';
import { proceduralTile } from '@nw/shared';

// ── Public callbacks ────────────────────────────────────────────────────────

export interface WorldMapCallbacks {
  onBack(): void;
  onOpenFamily(): void;
  onOpenAuction(): void;
  /**
   * Spectate a finished siege (G3-2c): app fetches the replay (seed + both armies)
   * and runs it headless in spectator mode — pure play-back, non-authoritative
   * (worldsvc already ran the authoritative engine battle). Either combatant can watch.
   */
  onReplaySiege(siegeId: string): void;
  /**
   * Open the simplified defense editor (C3) for a tile. `tileKey` is 'base' for the
   * main city or the full tileId `{worldId}:{x}:{y}` for an owned territory.
   */
  onOpenDefense(tileKey: string): void;
  /** Open the attack-team manager (G3-2c) — 5 formation templates used when sieging. */
  onOpenTeams(): void;
  worldApi: WorldApiClient;
  worldId: string;
  playerName: string;
  /** current player's accountId — gates capital rename (must own the capital). */
  accountId: string;
  /** live coin balance getter (SaveData.wallet mirror) — shown in the SLG shop. */
  getCoins?: () => number;
}

/** March kinds the deploy dialog can dispatch (occupy/reinforce/attack/sweep). */
type DeployKind = 'occupy' | 'reinforce' | 'attack' | 'sweep' | 'scout';

/** Live-push handle returned by showWorldMap — app forwards NetSession pushes here. */
export interface WorldMapView {
  applyMarchUpdate(m: MarchUpdate): void;
  applyTileUpdate(t: TileUpdate): void;
  applyUnderAttack(u: UnderAttack): void;
  applySiegeResult(s: SiegeResult): void;
}

// ── Tile styling ─────────────────────────────────────────────────────────────
// Colors align with the server's TileType values (neutral/resource/territory/familyKeep/center/base/
// obstacle/gate). Enemy/ally colors follow the "enemy blue, player red" convention (project_art_direction):
// own territory/capital = red ink; enemy = blue ink. Capitals are overlaid as star markers via getNations() (not a tile type).

// Terrain base colors (unoccupied).
const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8, // paper-white empty land
  resource:   0xd4e8a0, // resource tile (resType subdivides further)
  familyKeep: 0xffd060, // strategic stronghold / chokepoint
  center:     0xffe88a, // world center
  obstacle:   0x9a9488, // impassable terrain (mountains/rivers)
  gate:       0xc8a878, // pass / bridge (corridor)
  stronghold: 0x8a4a4a, // stronghold (G8): dark-red stone fort, ultra-strong NPC garrison (unoccupied until captured)
  territory:  0xf5f0e8, // fallback (territory tiles are always overlaid by own/enemy color)
  base:       0xf5f0e8,
};

const RES_COLORS: Record<string, number> = {
  ink:      0xa8d870, // ink (sustain)
  paper:    0x90b860, // paper (basic build)
  graphite: 0xb0b0a8, // graphite (advanced build) — pencil-lead grey
  metal:    0xa0b8c8, // metal (military)
  sticker:  0xe6b8d0, // sticker (universal) — pink sticker
};

const MINE_TINT      = 0xe69090; // own territory (light red ink)
const MINE_BASE_TINT = 0xcc3333; // own capital (deep red ink)
const ENEMY_TINT     = 0x90a8e6; // enemy territory (light blue ink)
const ENEMY_BASE_TINT= 0x4477cc; // enemy capital (deep blue ink)
const ALLY_TINT      = 0x9cd6a4; // family-ally territory (light green ink — G5 friendly third color)
const ALLY_BASE_TINT = 0x46a85a; // family-ally capital (deep green ink)
const FOG_COLOR      = 0x6b6458; // fog of war (pencil grey, overlaid on terrain)
const ALLY_SECT_BORDER = 0xe6a817; // allied-sect territory yellow border (amber gold, G5; marks without shared vision, §8.2)

function tileColor(tile: WorldTileView): number {
  if (tile.mine)     return tile.type === 'base' ? MINE_BASE_TINT : MINE_TINT;
  if (tile.ally)     return tile.type === 'base' ? ALLY_BASE_TINT : ALLY_TINT;
  if (tile.occupied) return tile.type === 'base' ? ENEMY_BASE_TINT : ENEMY_TINT;
  if (tile.type === 'resource' && tile.resType) {
    return RES_COLORS[tile.resType] ?? TERRAIN_COLORS.resource!;
  }
  return TERRAIN_COLORS[tile.type] ?? TERRAIN_COLORS.neutral!;
}

/** Procedural terrain color for uncached tiles (no network request; purely local computation). */
function proceduralTileColor(worldId: string, x: number, y: number): number {
  const p = proceduralTile(worldId, x, y);
  if (p.type === 'resource' && p.resType) return RES_COLORS[p.resType] ?? TERRAIN_COLORS.resource!;
  return TERRAIN_COLORS[p.type] ?? TERRAIN_COLORS.neutral!;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAP_SIZE = 1500; // server default 1500×1500; actual value comes from getSeason
const HUD_H    = 80;   // bottom HUD bar height
const MARGIN   = 4;    // margin inside modal
const CONFIRM_H = 140;

// ── Zoom system ───────────────────────────────────────────────────────────────
// Three zoom levels cycled via a button:
//   L1 detail   25×≈14 tiles, 76px/tile (1920px design width) — full markers (level dots / watchtowers / sect borders)
//   L2 medium   50×≈27 tiles, 38px/tile — occupation color + capital stars + march arrows only
//   L3 overview ~96×≈50 tiles, 20px/tile — batched color-block rendering, coarsest, for situational awareness
// TILE_PX is computed dynamically from designWidth to keep visible tile counts consistent across resolutions.

interface ZoomCfg {
  tile: number;   // px per tile
  visW: number;   // visible tile columns
  visH: number;   // visible tile rows (mapH area)
  poolW: number;  // pool columns = visW + 2 (one buffer on each side)
  poolH: number;  // pool rows = visH + 2
}

function makeZoomCfgs(w: number, h: number): [ZoomCfg, ZoomCfg, ZoomCfg] {
  const mh = h - HUD_H;
  const mk = (tile: number): ZoomCfg => {
    const visW = Math.ceil(w / tile);
    const visH = Math.ceil(mh / tile);
    return { tile, visW, visH, poolW: visW + 2, poolH: visH + 2 };
  };
  return [mk(Math.floor(w / 25)), mk(Math.floor(w / 50)), mk(20)];
}

/** A single pooled tile object — one PIXI.Graphics reused for many map positions. */
interface PoolSlot {
  g: PIXI.Graphics;
  tx: number; // map tile currently displayed (-1 = unassigned)
  ty: number;
}

// Train economy mirrors (DRAFT; server @nw/shared is authoritative — these only
// size the client's preview/cost estimates for the C4 panel). Keep in sync with
// shared/slg.ts TROOP_TRAIN_INK_COST / TROOP_SPEEDUP_SECS_PER_COIN / *_BATCH_MAX.
const TRAIN_INK_PER         = 10;
const TRAIN_SPEEDUP_PER_COIN = 60; // seconds shortened per coin
const TRAIN_BATCH_MAX       = 500;
const TRAIN_PRESETS         = [10, 50];
/** Coin cost for a voluntary capital relocation (display only; server @nw/shared RELOCATE_COST is authoritative). */
const RELOCATE_COST = 500;
/** Resource cost to build a watchtower (display only; server @nw/shared WATCHTOWER_COST is authoritative). */
const WATCHTOWER_COST_METAL = 2000;
const WATCHTOWER_COST_PAPER = 3000;

// ── Scene ─────────────────────────────────────────────────────────────────────

export class WorldMapScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: WorldMapCallbacks;

  // Pan state (world-space pixel offset)
  private panX = 0;
  private panY = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragging = false;
  private dragMoved = false;

  // Map bounds (from getSeason; default to server's 1500×1500)
  private mapW = DEFAULT_MAP_SIZE;
  private mapH = DEFAULT_MAP_SIZE;

  // Tile data cache
  private tileCache: Map<string, WorldTileView> = new Map();
  private me: PlayerWorldView | null = null;
  private marches: MarchView[] = [];
  // Nations (10 capitals) — overlaid as star markers + Voronoi-nearest tint hint.
  private nations: NationView[] = [];
  // Season + SLG shop catalog (C5; season also gives map bounds, shop fetched lazily).
  private season: SeasonView | null = null;
  private shopItems: SlgShopItemView[] = [];
  private infoTab: 'nations' | 'season' | 'shop' = 'nations';
  private hiddenInput: HTMLInputElement | null = null;

  // ── Zoom & tile pool ──────────────────────────────────────────────────────
  private zoom: 1 | 2 | 3 = 1;
  private zoomCfgs!: [ZoomCfg, ZoomCfg, ZoomCfg];
  private get zc(): ZoomCfg { return this.zoomCfgs[this.zoom - 1]; }
  private get tp(): number  { return this.zc.tile; }   // current TILE_PX

  // Pool (L1/L2): (poolW × poolH) slot objects, indexed modulo.
  private pool: PoolSlot[] = [];
  private poolContainer!: PIXI.Container;

  // L3 overview: single batched Graphics (dirty-flag, rendered in update()).
  private mapGfxL3!: PIXI.Graphics;
  private l3Dirty = false;

  // Overlay: march arrows, selected tile highlight, capital stars (fast, always redrawn).
  private overlayGfx!: PIXI.Graphics;

  // Layers
  private hudLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // Selected tile
  private selectedTile: { x: number; y: number } | null = null;

  // Tiles this player launched an attack against this session — used to tell
  // whether an incoming siege_result is ours (attacker → offer replay) or the
  // defender's (just a toast). Keyed by full tileId "x:y:world".
  private myAttackTiles: Set<string> = new Set();

  // Toast
  private toastTimer = 0;
  private destroyed = false;

  // Train/resource panel (C4): when open, re-rendered ~1s for live countdowns.
  private trainPanelOpen = false;
  private panelRepaint = 0;

  // March poll interval
  private marchPoll: ReturnType<typeof setInterval> | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: WorldMapCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.zoomCfgs = makeZoomCfgs(this.w, this.h);
    this.container = new PIXI.Container();
    this.build();
    this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));

    // Center map on join initially; will be overridden once we know base location
    this.centerAt(Math.floor(this.mapW / 2), Math.floor(this.mapH / 2));

    this.marchPoll = setInterval(() => { if (!this.destroyed) this.refreshMarches(); }, 5000);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Paper background
    const bg = buildPaperBackground('worldmap', w, h);
    this.container.addChild(bg);

    // Map area (clip to above-HUD area)
    const mapClip = new PIXI.Container();
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, 0, w, h - HUD_H).endFill();
    mapClip.mask = mask;
    mapClip.addChild(mask);
    this.container.addChild(mapClip);

    // L3 overview graphics (underneath pool)
    this.mapGfxL3 = new PIXI.Graphics();
    mapClip.addChild(this.mapGfxL3);

    // Tile pool container (L1/L2)
    this.poolContainer = new PIXI.Container();
    mapClip.addChild(this.poolContainer);

    // Overlay: capitals, march arrows, selected tile highlight
    this.overlayGfx = new PIXI.Graphics();
    mapClip.addChild(this.overlayGfx);

    // HUD bar
    this.hudLayer = new PIXI.Container();
    this.container.addChild(this.hudLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.buildPool();
    this.renderHud();
    this.invalidatePool();
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    if (this.destroyed) return;
    // Map bounds + nations are world-static; fetch once up front (best-effort).
    try {
      const season = await this.cb.worldApi.getSeason(this.cb.worldId);
      this.season = season;
      if (season.mapW > 0) this.mapW = season.mapW;
      if (season.mapH > 0) this.mapH = season.mapH;
    } catch { /* offline — keep defaults */ }
    try {
      this.nations = await this.cb.worldApi.getNations(this.cb.worldId);
    } catch { /* offline — no nation overlay */ }
    try {
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      // First entry: the system automatically places the capital (§3.4, preferring proximity to the family) — the player no longer picks a coordinate manually.
      // If the world is full or no slot is available, stay in the unjoined state (the user can tap the map to retry); do not block map entry.
      if (!this.me.joined) {
        try {
          this.me = await this.cb.worldApi.joinWorld(this.cb.worldId);
          this.showToast(t('world.myBase'));
        } catch { /* world full / no slot available — remain in unjoined state */ }
      }
      if (this.me.mainBaseTile) {
        const [bx, by] = this.parseTileId(this.me.mainBaseTile);
        this.centerAt(bx, by);
      }
      await this.loadMapViewport();
      await this.refreshMarches();
    } catch { /* offline OK */ }
    if (!this.destroyed) { this.renderMap(); this.renderHud(); }
  }

  private parseTileId(tileId: string): [number, number] {
    const [xs, ys] = tileId.split(':');
    return [Number(xs) || 0, Number(ys) || 0];
  }

  private async loadMapViewport(): Promise<void> {
    if (this.destroyed) return;
    const { cx, cy, r } = this.viewportCenter();
    try {
      if (this.zoom === 1) {
        // Full detail: owner name / garrison / watchtower / visibility gating
        const map = await this.cb.worldApi.getMap(this.cb.worldId, cx, cy, r);
        for (const tile of map.tiles) {
          this.tileCache.set(`${tile.x}:${tile.y}`, tile);
        }
      } else {
        // Sparse occupation layer: only occupied tiles; unoccupied tiles are rendered locally via proceduralTile
        const lod = this.zoom === 3 ? 'thin' : 'mid';
        const sparse = await this.cb.worldApi.getMapSparse(this.cb.worldId, cx, cy, r, lod);
        for (const s of sparse.tiles) {
          // Synthesize a minimal WorldTileView; will be overwritten with full data when zoom 1 loads
          this.tileCache.set(`${s.x}:${s.y}`, {
            x: s.x,
            y: s.y,
            type: s.type as WorldTileView['type'],
            level: 1,
            occupied: true,
            ...(s.mine ? { mine: true } : {}),
            ...(s.ally ? { ally: true } : {}),
            ...(s.allySect ? { allySect: true } : {}),
          });
        }
      }
    } catch { /* offline */ }
  }

  private async refreshMarches(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      if (!this.destroyed) { this.renderHud(); this.renderMap(); }
    } catch { /* offline */ }
  }

  private async refreshMe(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      if (!this.destroyed) this.renderHud();
    } catch { /* offline */ }
  }

  /** Returns the tile coordinate of the viewport center + a radius to fetch. */
  private viewportCenter(): { cx: number; cy: number; r: number } {
    const tp = this.tp;
    const cx = Math.floor(-this.panX / tp + this.w / 2 / tp);
    const cy = Math.floor(-this.panY / tp + (this.h - HUD_H) / 2 / tp);
    const r  = Math.ceil(Math.max(this.w, this.h - HUD_H) / tp / 2) + 4;
    return { cx: Math.max(0, Math.min(this.mapW - 1, cx)), cy: Math.max(0, Math.min(this.mapH - 1, cy)), r };
  }

  // ── Zoom control ───────────────────────────────────────────────────────────

  private setZoom(z: 1 | 2 | 3): void {
    if (this.zoom === z) return;
    // Keep map center stable across zoom levels.
    const oldTp = this.tp;
    const centerTileX = (-this.panX + this.w / 2) / oldTp;
    const centerTileY = (-this.panY + (this.h - HUD_H) / 2) / oldTp;
    this.zoom = z;
    this.panX = this.w / 2 - centerTileX * this.tp;
    this.panY = (this.h - HUD_H) / 2 - centerTileY * this.tp;
    this.clampPan();
    this.buildPool();
    this.invalidatePool();
    this.renderHud();
    // After switching zoom, re-fetch viewport data at the new LOD (different levels require different endpoints / field sets)
    void this.loadMapViewport();
  }

  // ── Tile pool (L1 / L2) ────────────────────────────────────────────────────

  private buildPool(): void {
    // Destroy old slots.
    for (const s of this.pool) s.g.destroy();
    this.pool = [];
    this.poolContainer.removeChildren();
    if (this.zoom === 3) {
      // L3 uses the batched Graphics path — pool stays empty.
      this.poolContainer.visible = false;
      this.mapGfxL3.visible = true;
      this.l3Dirty = true;
      return;
    }
    this.poolContainer.visible = true;
    this.mapGfxL3.visible = false;
    const { poolW, poolH } = this.zc;
    for (let i = 0; i < poolW * poolH; i++) {
      const g = new PIXI.Graphics();
      this.pool.push({ g, tx: -999999, ty: -999999 });
      this.poolContainer.addChild(g);
    }
  }

  /** Mark all pool slots stale and refresh — called after data changes. */
  private invalidatePool(): void {
    if (this.zoom === 3) { this.l3Dirty = true; this.renderOverlay(); return; }
    for (const s of this.pool) { s.tx = -999999; s.ty = -999999; }
    this.refreshPool();
    this.renderOverlay();
  }

  /** Modulo-wrap pool update: reposition all slots, redraw only those whose
   *  tile content changed (i.e. that scrolled to a new map position). */
  private refreshPool(): void {
    if (this.zoom === 3) return;
    const { tile: tp, poolW, poolH } = this.zc;
    const x0 = Math.floor(-this.panX / tp);
    const y0 = Math.floor(-this.panY / tp);
    for (let dy = 0; dy < poolH; dy++) {
      for (let dx = 0; dx < poolW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        const si = (((ty % poolH) + poolH) % poolH) * poolW + (((tx % poolW) + poolW) % poolW);
        const slot = this.pool[si]!;
        slot.g.x = this.panX + tx * tp;
        slot.g.y = this.panY + ty * tp;
        if (slot.tx === tx && slot.ty === ty) continue;
        slot.tx = tx; slot.ty = ty;
        this.drawTileSlot(slot, tx, ty);
      }
    }
  }

  /** Redraw a single pool slot for the given map position. */
  private drawTileSlot(slot: PoolSlot, tx: number, ty: number): void {
    const g = slot.g;
    g.clear();
    const tp = this.tp;
    const inBounds = tx >= 0 && ty >= 0 && tx < this.mapW && ty < this.mapH;
    if (!inBounds) { g.visible = false; return; }
    g.visible = true;

    const tile = this.tileCache.get(`${tx}:${ty}`);
    const color = tile ? tileColor(tile) : proceduralTileColor(this.cb.worldId, tx, ty);
    const fogged = tile?.visible === false;

    if (this.zoom === 1) {
      this.drawTileL1(g, tile ?? null, color, fogged, tp);
    } else {
      this.drawTileL2(g, color, fogged, tp);
    }
  }

  /** L1 detail tile: full markers — border, level dot, watchtower, fog, allySect. */
  private drawTileL1(
    g: PIXI.Graphics, tile: WorldTileView | null,
    color: number, fogged: boolean, tp: number,
  ): void {
    g.lineStyle(0.8, 0xccbbaa, 0.5);
    g.beginFill(color, 0.85);
    g.drawRect(0, 0, tp - 1, tp - 1);
    g.endFill();

    if (fogged) {
      g.lineStyle(0);
      g.beginFill(FOG_COLOR, 0.4);
      g.drawRect(0, 0, tp - 1, tp - 1);
      g.endFill();
      return;
    }

    if (tile && tile.level > 1) {
      const dotColor = tile.mine ? 0xcc2222 : (tile.ally ? 0x2e8b40 : (tile.occupied ? 0x2266cc : 0x888888));
      g.lineStyle(0);
      g.beginFill(dotColor, 0.9);
      g.drawCircle(tp - 6, 6, 3);
      g.endFill();
    }

    if (tile?.allySect) {
      g.lineStyle(2, ALLY_SECT_BORDER, 0.95);
      g.beginFill(0, 0);
      g.drawRect(2, 2, tp - 5, tp - 5);
      g.endFill();
    }

    if (tile?.watchtower) {
      const tcx = tp / 2;
      const baseY = tp - 5;
      const towerW = Math.max(4, tp * 0.18);
      const towerH = Math.max(7, tp * 0.36);
      g.lineStyle(1, 0x4a3520, 0.9);
      g.beginFill(0xe8dcc0, 0.95);
      g.drawRect(tcx - towerW / 2, baseY - towerH, towerW, towerH);
      g.endFill();
      g.beginFill(0x4a3520, 0.95);
      g.drawPolygon([
        tcx - towerW / 2 - 1, baseY - towerH,
        tcx + towerW / 2 + 1, baseY - towerH,
        tcx, baseY - towerH - towerW,
      ]);
      g.endFill();
    }
  }

  /** L2 medium tile: occupation color + fog only, no markers. */
  private drawTileL2(g: PIXI.Graphics, color: number, fogged: boolean, tp: number): void {
    g.lineStyle(0);
    g.beginFill(color, 0.88);
    g.drawRect(0, 0, tp - 1, tp - 1);
    g.endFill();
    if (fogged) {
      g.beginFill(FOG_COLOR, 0.38);
      g.drawRect(0, 0, tp - 1, tp - 1);
      g.endFill();
    }
  }

  // ── L3 overview (batched Graphics) ─────────────────────────────────────────
  // Renders on a dirty flag in update(), so mousemove spam doesn't trigger it.
  // Tiles grouped by color → one beginFill + N drawRect per color group (fast).

  private renderMapL3(): void {
    this.l3Dirty = false;
    const g = this.mapGfxL3;
    g.clear();
    const tp = 20;
    const { w, h, panX, panY } = this;
    const mapH = h - HUD_H;
    const x0 = Math.floor(-panX / tp);
    const y0 = Math.floor(-panY / tp);
    const x1 = Math.ceil((-panX + w) / tp);
    const y1 = Math.ceil((-panY + mapH) / tp);

    // Group tiles by fill color for batched rendering.
    const groups = new Map<number, number[]>(); // color → [x0,y0, x1,y1, ...]
    for (let ty = Math.max(0, y0); ty <= Math.min(this.mapH - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(this.mapW - 1, x1); tx++) {
        const tile = this.tileCache.get(`${tx}:${ty}`);
        let color = tile ? tileColor(tile) : proceduralTileColor(this.cb.worldId, tx, ty);
        if (tile?.visible === false) color = (color & 0x7f7f7f) | 0x404040; // darken fogged
        if (!groups.has(color)) groups.set(color, []);
        groups.get(color)!.push(panX + tx * tp, panY + ty * tp);
      }
    }
    for (const [color, coords] of groups) {
      g.lineStyle(0);
      g.beginFill(color, 0.88);
      for (let i = 0; i < coords.length; i += 2) {
        g.drawRect(coords[i]!, coords[i + 1]!, tp - 1, tp - 1);
      }
      g.endFill();
    }
  }

  // ── Overlay (march arrows, capitals, selected tile) ────────────────────────
  // Drawn into a separate Graphics above the tile pool. Fast to redraw (~few dozen objects).

  private renderOverlay(): void {
    const g = this.overlayGfx;
    g.clear();
    const tp = this.tp;

    // Selected tile highlight.
    if (this.selectedTile) {
      const { x: tx, y: ty } = this.selectedTile;
      const px = this.panX + tx * tp;
      const py = this.panY + ty * tp;
      g.lineStyle(2, 0xffcc00, 1);
      g.beginFill(0xffff00, 0.15);
      g.drawRect(px, py, tp, tp);
      g.endFill();
    }

    // Capital star markers (10 nations).
    const starR = Math.max(6, tp * 0.45);
    for (const n of this.nations) {
      const cx = this.panX + n.x * tp + tp / 2;
      const cy = this.panY + n.y * tp + tp / 2;
      if (cx < -tp || cy < -tp || cx > this.w + tp || cy > this.h - HUD_H + tp) continue;
      this.drawStar(g, cx, cy, starR, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
    }

    // March arrows (L1/L2 only; L3 is too zoomed-out for detail).
    if (this.zoom < 3) {
      for (const march of this.marches) {
        const [fx, fy] = this.parseTileId(march.fromTile);
        const [tx2, ty2] = this.parseTileId(march.toTile);
        const fpx = this.panX + fx * tp + tp / 2;
        const fpy = this.panY + fy * tp + tp / 2;
        const px  = this.panX + tx2 * tp + tp / 2;
        const py  = this.panY + ty2 * tp + tp / 2;
        const enemy = march.mine === false;
        const col = enemy ? ENEMY_BASE_TINT
          : march.kind === 'return'   ? 0x44cc88
          : march.kind === 'attack'   ? 0xcc3333
          : march.kind === 'reinforce'? 0x44aacc
          : march.kind === 'scout'    ? 0x9b59b6
          : 0xcc8844;
        g.lineStyle(enemy ? 2.5 : 1.5, col, enemy ? 0.75 : 0.55);
        g.moveTo(fpx, fpy);
        g.lineTo(px, py);
        g.lineStyle(0);
        g.beginFill(col, 0.9);
        g.drawCircle(px, py, enemy ? 5 : 4);
        g.endFill();
      }
    }
  }

  /** Legacy entry point — called from action handlers after data changes. */
  private renderMap(): void {
    this.invalidatePool();
  }

  /** Draw a 5-point star (capital marker). Filled when the nation is owned. */
  private drawStar(g: PIXI.Graphics, cx: number, cy: number, r: number, color: number, filled: boolean): void {
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    g.lineStyle(1.5, 0x6a5a20, 0.9);
    if (filled) g.beginFill(color, 0.95);
    g.drawPolygon(pts);
    if (filled) g.endFill();
  }

  private renderHud(): void {
    const hud = this.hudLayer;
    tearDownChildren(hud); // rebuilt every ~5s by the march poll → free resource-count Text textures
    const { w, h } = this;

    // HUD background
    const panel = sketchPanel(w, HUD_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    panel.y = h - HUD_H;
    hud.addChild(panel);

    // Back button
    const backLbl = txt(t('world.back'), 12, C.accent);
    backLbl.x = 10; backLbl.y = h - HUD_H + 10;
    hud.addChild(backLbl);
    this.backRect = { x: 0, y: h - HUD_H, w: 80, h: 30 };

    // Resources row
    if (this.me?.joined) {
      const troops = this.me.troops ?? 0;
      const troopCap = this.me.troopCap ?? 0;
      const territory = this.me.territoryCount ?? 0;
      const infos = [
        `${t('world.troops')} ${troops}/${troopCap}`,
        `${t('world.territory')} ${territory}`,
      ];
      const res = this.me.resources ?? {};
      if (res['ink'] !== undefined) infos.push(`🖋️${res['ink']}`);
      if (res['paper'] !== undefined) infos.push(`📄${res['paper']}`);
      if (res['graphite'] !== undefined) infos.push(`✏️${res['graphite']}`);
      if (res['metal'] !== undefined) infos.push(`🔩${res['metal']}`);
      if (res['sticker'] !== undefined) infos.push(`⭐${res['sticker']}`);

      let ix = 90;
      for (const info of infos) {
        const lbl = txt(info, 11, C.dark);
        lbl.x = ix; lbl.y = h - HUD_H + 10;
        hud.addChild(lbl);
        ix += lbl.width + 14;
      }
    }

    // Active marches list (one row per march, recall button) — own marches only
    // (G5: this.marches may also hold in-vision enemy marches, which can't be recalled).
    this.marchRowRects = [];
    const myMarches = this.marches.filter((m) => m.mine !== false);
    if (myMarches.length > 0) {
      const now = Date.now();
      const MARCH_ROW_H = 22;
      const ROW_Y0 = h - HUD_H + 40;
      const RECALL_W = 46;
      for (let i = 0; i < myMarches.length; i++) {
        const m = myMarches[i];
        const [tx, ty] = this.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        const kindIcon = m.kind === 'attack' ? '⚔' : m.kind === 'reinforce' ? '🛡' : m.kind === 'scout' ? '🔭' : m.kind === 'return' ? '↩' : '→';
        const rowY = ROW_Y0 + i * MARCH_ROW_H;
        const rowLbl = txt(`${kindIcon}(${tx},${ty}) ${remaining}s`, 10, C.dark);
        rowLbl.x = 10; rowLbl.y = rowY + 3;
        hud.addChild(rowLbl);

        // Recall button (only for non-return marches)
        if (m.kind !== 'return') {
          const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
          recallBtn.x = 10 + 120; recallBtn.y = rowY + 1;
          hud.addChild(recallBtn);
          const recallLbl = txt(t('world.recall'), 9, C.light);
          recallLbl.anchor.set(0.5, 0.5);
          recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
          hud.addChild(recallLbl);
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: 10, y: rowY, w: 120, h: MARCH_ROW_H },
            recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
          });
        } else {
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: 10, y: rowY, w: 120, h: MARCH_ROW_H },
            recallRect: null,
          });
        }
      }
    }

    // Train / Family / Auction buttons (right side)
    const btnW = 70;

    // Train button — only meaningful once the player has a base.
    if (this.me?.joined) {
      const trainBtn = sketchPanel(btnW, 28, { fill: C.red, border: C.accent, seed: seedFor(2, 0, btnW) });
      trainBtn.x = w - btnW * 3 - 22; trainBtn.y = h - HUD_H + 26;
      hud.addChild(trainBtn);
      const inQ = (this.me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
      const trainLbl = txt(inQ > 0 ? `${t('world.train')} (${inQ})` : t('world.train'), 12, C.light);
      trainLbl.anchor.set(0.5, 0.5);
      trainLbl.x = trainBtn.x + btnW / 2; trainLbl.y = trainBtn.y + 14;
      hud.addChild(trainLbl);
      this.trainBtnRect = { x: trainBtn.x, y: trainBtn.y, w: btnW, h: 28 };
    } else {
      this.trainBtnRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    const famBtn = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
    famBtn.x = w - btnW * 2 - 14; famBtn.y = h - HUD_H + 26;
    hud.addChild(famBtn);
    const famLbl = txt(t('world.family'), 12, C.light);
    famLbl.anchor.set(0.5, 0.5);
    famLbl.x = famBtn.x + btnW / 2; famLbl.y = famBtn.y + 14;
    hud.addChild(famLbl);
    this.famBtnRect = { x: famBtn.x, y: famBtn.y, w: btnW, h: 28 };

    const aucBtn = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, btnW) });
    aucBtn.x = w - btnW - 6; aucBtn.y = h - HUD_H + 26;
    hud.addChild(aucBtn);
    const aucLbl = txt(t('world.auction'), 12, C.light);
    aucLbl.anchor.set(0.5, 0.5);
    aucLbl.x = aucBtn.x + btnW / 2; aucLbl.y = aucBtn.y + 14;
    hud.addChild(aucLbl);
    this.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: btnW, h: 28 };

    // World info button — floats top-right over the map (nations / season / shop).
    const infoW = 56, infoH = 26;
    const infoBtn = sketchPanel(infoW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, infoW) });
    infoBtn.x = w - infoW - 8; infoBtn.y = 8;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 12, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + infoW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: infoW, h: infoH };

    // Zoom cycle button — top-left over the map, cycles L1→L2→L3→L1.
    const zoomLabels: Record<number, string> = { 1: '🔍×1', 2: '🔍×2', 3: '🔍×3' };
    const zoomW = 56, zoomH = 26;
    const zoomBtn = sketchPanel(zoomW, zoomH, { fill: C.dark, border: C.accent, seed: seedFor(4, 2, zoomW) });
    zoomBtn.x = 8; zoomBtn.y = 8;
    hud.addChild(zoomBtn);
    const zoomLbl = txt(zoomLabels[this.zoom] ?? '🔍', 11, C.light);
    zoomLbl.anchor.set(0.5, 0.5);
    zoomLbl.x = zoomBtn.x + zoomW / 2; zoomLbl.y = zoomBtn.y + zoomH / 2;
    hud.addChild(zoomLbl);
    this.zoomBtnRect = { x: zoomBtn.x, y: zoomBtn.y, w: zoomW, h: zoomH };
  }

  // ── Hit rects ──────────────────────────────────────────────────────────────

  private backRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private trainBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private famBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private aucBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private infoBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private zoomBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  private marchRowRects: {
    marchId: string; worldId: string; destX: number; destY: number;
    rowRect: { x: number; y: number; w: number; h: number };
    recallRect: { x: number; y: number; w: number; h: number } | null;
  }[] = [];

  // ── Modal ──────────────────────────────────────────────────────────────────

  private showModal(lines: string[], buttons: { label: string; action: () => void }[]): void {
    const ml = this.modalLayer;
    ml.removeChildren();

    const { w, h } = this;
    const mw = Math.min(300, w - 32);
    const mh = CONFIRM_H;
    const mx = (w - mw) / 2;
    const my = (h - HUD_H - mh) / 2;

    // Dimmer
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let ly = my + 14;
    for (const line of lines) {
      const lbl = txt(line, 13, C.dark);
      lbl.anchor.set(0.5, 0);
      lbl.x = mx + mw / 2; lbl.y = ly;
      ml.addChild(lbl);
      ly += 20;
    }

    this.modalBtnRects = [];
    const btnW = Math.min(100, (mw - MARGIN * (buttons.length + 1)) / buttons.length);
    let bx = mx + (mw - (btnW + MARGIN) * buttons.length + MARGIN) / 2;
    const by = my + mh - 40;
    for (const btn of buttons) {
      const bp = sketchPanel(btnW, 28, { fill: C.dark, border: C.accent, seed: seedFor(bx, by, btnW) });
      bp.x = bx; bp.y = by;
      ml.addChild(bp);
      const bl = txt(btn.label, 12, C.light);
      bl.anchor.set(0.5, 0.5);
      bl.x = bx + btnW / 2; bl.y = by + 14;
      ml.addChild(bl);
      this.modalBtnRects.push({ rect: { x: bx, y: by, w: btnW, h: 28 }, action: btn.action });
      bx += btnW + MARGIN;
    }

    // Close on dim
    this.modalDimRect = { x: 0, y: 0, w: w, h: h };
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalBtnRects = [];
    this.modalDimRect = null;
    this.selectedTile = null;
    this.trainPanelOpen = false;
    this.renderMap();
  }

  private modalBtnRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalDimRect: { x: number; y: number; w: number; h: number } | null = null;

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const { w, h } = this;
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = w / 2; lbl.y = h - HUD_H - 50;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  // ── Tile actions ───────────────────────────────────────────────────────────

  private onTileClick(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return;
    this.selectedTile = { x: tx, y: ty };
    this.renderMap();

    const tile = this.tileCache.get(`${tx}:${ty}`);
    const me = this.me;

    if (!me?.joined) {
      // Not yet placed (normally auto-placed on map entry; this is the manual-retry path for the world-full / no-slot fallback).
      // The system picks the location automatically; the tap coordinate is no longer used for placement.
      this.showModal(
        [t('world.joinTitle'), t('world.confirmJoin')],
        [
          { label: t('world.confirmJoinBtn'), action: () => void this.doJoin() },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
      return;
    }

    if (tile?.mine) {
      // My tile — reinforce (march from base) + abandon. Base itself: no actions.
      const [bx, by] = me.mainBaseTile ? this.parseTileId(me.mainBaseTile) : [-1, -1];
      const isBase = bx === tx && by === ty;
      if (isBase) {
        // Main city — edit base defense config (C3).
        this.showModal(
          [t('world.myBase'), `(${tx}, ${ty})`],
          [
            { label: t('world.actDefense'), action: () => { this.closeModal(); this.cb.onOpenDefense('base'); } },
            { label: t('world.team.manage'), action: () => { this.closeModal(); this.cb.onOpenTeams(); } },
            { label: '✕', action: () => this.closeModal() },
          ],
        );
        return;
      }
      const tileKey = `${this.cb.worldId}:${tx}:${ty}`;
      const myButtons: { label: string; action: () => void }[] = [
        { label: t('world.actReinforce'), action: () => this.showDeployDialog(tx, ty, 'reinforce') },
        { label: t('world.actDefense'), action: () => { this.closeModal(); this.cb.onOpenDefense(tileKey); } },
      ];
      // Watchtower (§18 G5 V2): build a long-radius persistent vision source on an owned tile. If a tower already exists, show a status line instead of the build button.
      if (!tile.watchtower) {
        myButtons.push({ label: t('world.actWatchtower'), action: () => this.confirmWatchtower(tx, ty) });
      }
      myButtons.push({ label: t('world.actAbandon'), action: () => this.doAbandon(tx, ty) });
      myButtons.push({ label: '✕', action: () => this.closeModal() });
      const head = tile.watchtower ? [t('world.mine'), t('world.hasWatchtower'), `(${tx}, ${ty})`] : [t('world.mine'), `(${tx}, ${ty})`];
      this.showModal(head, myButtons);
      return;
    }

    if (tile?.occupied) {
      // Enemy tile — siege (attack march from base). Protected tiles can't be hit.
      const ownerLine = tile.ownerName
        ? `${tile.ownerName}${tile.ownerPublicId ? ' #' + tile.ownerPublicId : ''}`
        : (tile.ownerPublicId ? '#' + tile.ownerPublicId : t('world.unknownOwner'));
      const buttons: { label: string; action: () => void }[] = [];
      const protectedNow = (tile.protectedUntil ?? 0) > Date.now();
      if (!protectedNow) {
        buttons.push({ label: t('world.actAttack'), action: () => void this.showAttackTeamPicker(tx, ty) });
      }
      // Scout: no attack, no capture — send a scout to reveal enemy info / defenses then auto-return (scouting is also allowed during a protection window).
      buttons.push({ label: t('world.actScout'), action: () => void this.doScout(tx, ty) });
      buttons.push({ label: '✕', action: () => this.closeModal() });
      this.showModal([t('world.enemyTile'), ownerLine, `(${tx}, ${ty})`], buttons);
      return;
    }

    if (tile?.type === 'center') {
      this.showToast(t('world.center'));
      return;
    }

    // Stronghold (G8 §3.1): while unoccupied it is an ultra-strong NPC garrison — cannot be directly occupied or swept, only besieged (march with a team). Once captured it becomes a territory tile handled by the mine/occupied branches above.
    if (tile?.type === 'stronghold') {
      this.showModal(
        [t('world.stronghold'), t('world.strongholdHint'), `(${tx}, ${ty})`],
        [
          { label: t('world.actAttack'), action: () => void this.showAttackTeamPicker(tx, ty) },
          { label: t('world.actScout'), action: () => void this.doScout(tx, ty) },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
      return;
    }

    // Neutral tile. NPC garrison present → offer sweep (march). Always offer
    // direct occupy (S8-1, in-range; server rejects out-of-range).
    const garrison = tile?.garrison ?? 0;
    const buttons: { label: string; action: () => void }[] = [
      { label: t('world.actOccupy'), action: () => this.doOccupy(tx, ty) },
    ];
    if (garrison > 0) {
      buttons.push({ label: t('world.actSweep'), action: () => this.showDeployDialog(tx, ty, 'sweep') });
    }
    // Scout: send a scout to lift distant fog / reveal an unknown tile, then auto-return (no capture).
    buttons.push({ label: t('world.actScout'), action: () => void this.doScout(tx, ty) });
    // Voluntary relocation (§3.4): if the player already has a capital and the target tile is placeable (not obstacle/gate), spend 500 coins to move the capital here.
    const relocatable = this.me?.mainBaseTile && tile?.type !== 'obstacle' && tile?.type !== 'gate';
    if (relocatable) {
      buttons.push({ label: t('world.actRelocate'), action: () => this.confirmRelocate(tx, ty) });
    }
    buttons.push({ label: '✕', action: () => this.closeModal() });
    const head = garrison > 0 ? t('world.garrison').replace('{n}', String(garrison)) : t('world.actOccupy');
    this.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  // ── Deploy (troop-count dialog) ──────────────────────────────────────────────────
  // Pick how many troops to send for a march action. Presets ¼ / ½ / all of the
  // available pool. March source is the player's main base. Server enforces the
  // per-kind minimums (occupy/attack need OCCUPY_MIN_TROOPS) → toast on reject.

  private showDeployDialog(tx: number, ty: number, kind: DeployKind): void {
    const me = this.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const avail = Math.max(0, Math.floor(me.troops ?? 0));
    const kindLabel = kind === 'attack' ? t('world.actAttack')
      : kind === 'reinforce' ? t('world.actReinforce')
      : kind === 'sweep' ? t('world.actSweep')
      : t('world.actOccupy');
    const send = (qty: number): void => { void this.doMarch(tx, ty, kind, qty); };
    this.showModal(
      [t('world.deployTitle').replace('{avail}', String(avail)), `${kindLabel} → (${tx}, ${ty})`],
      [
        { label: t('world.deployQuarter'), action: () => send(Math.floor(avail / 4)) },
        { label: t('world.deployHalf'), action: () => send(Math.floor(avail / 2)) },
        { label: t('world.deployAll'), action: () => send(avail) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  // ── Siege team picker (G3-2c §16.2) ────────────────────────────────────────────────
  // A siege march must attach an attack formation template (team) — committed troops = sum of full HP of all units in the team, derived by the server (overrides the troop count). Empty team list → guide the player to manage teams.

  private async showAttackTeamPicker(tx: number, ty: number): Promise<void> {
    const me = this.me;
    if (!me?.joined || !me.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    let teams: { id: string; name: string; army: { initialHp?: number }[] }[] = [];
    try {
      teams = await this.cb.worldApi.getTeams(this.cb.worldId);
    } catch { /* offline — treat as empty */ }
    const usable = teams.filter((tm) => tm.army.length > 0);
    const buttons: { label: string; action: () => void }[] = [];
    for (const tm of usable) {
      const committed = tm.army.reduce((s, e) => s + Math.max(0, Math.floor(e.initialHp ?? 0)), 0);
      buttons.push({
        label: `${tm.name} · ${t('world.team.committed').replace('{n}', String(committed))}`,
        action: () => void this.doMarchTeam(tx, ty, tm.id),
      });
    }
    buttons.push({ label: t('world.team.manage'), action: () => this.cb.onOpenTeams() });
    buttons.push({ label: '✕', action: () => this.closeModal() });
    const head = usable.length > 0 ? t('world.team.pickTitle') : t('world.team.noTeams');
    this.showModal([head, `(${tx}, ${ty})`], buttons);
  }

  private async doMarchTeam(tx: number, ty: number, teamId: string): Promise<void> {
    this.closeModal();
    const me = this.me;
    if (!me?.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    const [fx, fy] = this.parseTileId(me.mainBaseTile);
    try {
      // troops=1 is a placeholder; the server overwrites it with the team's committed troop count (§16.2).
      const march = await this.cb.worldApi.startMarch(this.cb.worldId, fx, fy, tx, ty, 'attack', 1, teamId);
      this.myAttackTiles.add(march.toTile);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.dispatched'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doMarch(tx: number, ty: number, kind: DeployKind, troops: number): Promise<void> {
    this.closeModal();
    const me = this.me;
    if (!me?.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    if (troops < 1) { this.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.parseTileId(me.mainBaseTile);
    try {
      const march = await this.cb.worldApi.startMarch(this.cb.worldId, fx, fy, tx, ty, kind, troops);
      if (kind === 'attack') this.myAttackTiles.add(march.toTile);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.dispatched'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  /**
   * Scout march: send 1 scout (minimum troops, does not lock the main army) to the target tile,
   * revealing a wider vision radius along the route and at the destination (VISION_SCOUT_RADIUS),
   * then auto-return. No attack, no capture — dispatched directly without the troop-count dialog
   * (scouting is meant to be lightweight).
   */
  private async doScout(tx: number, ty: number): Promise<void> {
    this.closeModal();
    const me = this.me;
    if (!me?.mainBaseTile) { this.showToast(t('world.needBase'), C.red); return; }
    if ((me.troops ?? 0) < 1) { this.showToast(t('world.err.noTroops'), C.red); return; }
    const [fx, fy] = this.parseTileId(me.mainBaseTile);
    try {
      await this.cb.worldApi.startMarch(this.cb.worldId, fx, fy, tx, ty, 'scout', 1);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      this.showToast(t('world.scoutSent'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Join the world: the system automatically places the capital (§3.4, preferring proximity to the family); the position is determined by the server. After placement, pan the camera to the new capital. */
  private async doJoin(): Promise<void> {
    this.closeModal();
    try {
      this.me = await this.cb.worldApi.joinWorld(this.cb.worldId);
      this.showToast(t('world.myBase'));
      if (this.me.mainBaseTile) {
        const [bx, by] = this.parseTileId(this.me.mainBaseTile);
        this.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doOccupy(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.occupyTile(this.cb.worldId, tx, ty);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      await this.loadMapViewport();
      this.showToast(t('world.occupied'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doRecall(marchId: string, worldId: string): Promise<void> {
    try {
      await this.cb.worldApi.recallMarch(marchId, worldId);
      this.marches = await this.cb.worldApi.getMarches(this.cb.worldId);
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before relocation (shows cost); confirm → doRelocate. */
  private confirmRelocate(tx: number, ty: number): void {
    this.showModal(
      [t('world.relocateTitle'), t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST))],
      [
        { label: t('world.relocateBtn'), action: () => this.doRelocate(tx, ty) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  private async doRelocate(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      this.me = await this.cb.worldApi.relocateBase(this.cb.worldId, tx, ty);
      this.tileCache.clear(); // capital position changed + old location reverts to neutral — re-fetch the entire viewport
      if (this.me.mainBaseTile) {
        const [bx, by] = this.parseTileId(this.me.mainBaseTile);
        this.centerAt(bx, by);
      }
      await this.loadMapViewport();
      this.showToast(t('world.relocated'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  /** Second confirmation before building a watchtower (shows resource cost); confirm → doWatchtower. */
  private confirmWatchtower(tx: number, ty: number): void {
    this.showModal(
      [
        t('world.watchtowerTitle'),
        t('world.watchtowerConfirm')
          .replace('{paper}', String(WATCHTOWER_COST_PAPER))
          .replace('{metal}', String(WATCHTOWER_COST_METAL)),
      ],
      [
        { label: t('world.watchtowerBtn'), action: () => void this.doWatchtower(tx, ty) },
        { label: '✕', action: () => this.closeModal() },
      ],
    );
  }

  private async doWatchtower(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.buildWatchtower(this.cb.worldId, tx, ty);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId); // resources deducted — refresh local state
      this.tileCache.clear();                                  // new tower expands vision → re-fetch entire viewport to reveal tiles
      await this.loadMapViewport();
      this.showToast(t('world.watchtowerBuilt'));
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doAbandon(tx: number, ty: number): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.abandonTile(this.cb.worldId, tx, ty);
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
      // Remove from cache so it shows as empty
      this.tileCache.delete(`${tx}:${ty}`);
      await this.loadMapViewport();
      this.renderMap(); this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Train / resource panel (C4) ─────────────────────────────────────────────
  // A richer modal than showModal: full resources + yield, recruit presets, the
  // live training queue (countdown), and a one-tap coin speedup. Rendered into
  // modalLayer (reusing modalBtnRects for hit detection + dim-to-close), and
  // re-painted ~1s by update() so the queue countdowns tick.

  private openTrainPanel(): void {
    if (!this.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
    this.trainPanelOpen = true;
    this.panelRepaint = 0;
    void this.refreshMe().then(() => { if (this.trainPanelOpen) this.renderTrainPanel(); });
    this.renderTrainPanel();
  }

  /** A small filled button registered in modalBtnRects. */
  private panelButton(
    label: string, x: number, y: number, bw: number, bh: number,
    fill: number, action: () => void,
  ): void {
    const ml = this.modalLayer;
    const bp = sketchPanel(bw, bh, { fill, border: C.accent, seed: seedFor(x, y, bw) });
    bp.x = x; bp.y = y;
    ml.addChild(bp);
    const bl = txt(label, 11, C.light);
    bl.anchor.set(0.5, 0.5);
    bl.x = x + bw / 2; bl.y = y + bh / 2;
    ml.addChild(bl);
    this.modalBtnRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }

  private renderTrainPanel(): void {
    const me = this.me;
    if (!me?.joined) { this.closeModal(); return; }
    const ml = this.modalLayer;
    tearDownChildren(ml); // repainted once/sec while open (queue countdowns) → free Text textures
    this.modalBtnRects = [];

    const { w, h } = this;
    const pw = Math.min(340, w - 24);
    const ph = 300;
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(7, 7, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, ty: number, size = 12, color: number = C.dark, cx = px + 14, anchorX = 0): PIXI.Text => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = cx; lbl.y = ty;
      ml.addChild(lbl);
      return lbl;
    };

    let ly = py + 12;
    // Title
    const title = txt(t('world.trainTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = ly;
    ml.addChild(title);
    ly += 26;

    // Resources + yield
    const res = me.resources ?? {};
    const yield_ = me.yieldRate ?? {};
    const fmt = (icon: string, key: string): string => {
      const amt = Math.floor(res[key] ?? 0);
      const yr = yield_[key];
      return yr ? `${icon}${amt} (+${Math.round(yr)}/${t('world.resYield')})` : `${icon}${amt}`;
    };
    addText(`${fmt('🖋️', 'ink')}   ${fmt('📄', 'paper')}   ${fmt('✏️', 'graphite')}`, ly, 11);
    ly += 18;
    addText(`${fmt('🔩', 'metal')}   ${fmt('⭐', 'sticker')}`, ly, 11);
    ly += 20;

    // Troops
    const inQ = (me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
    const troops = Math.floor(me.troops ?? 0);
    const cap = Math.floor(me.troopCap ?? 0);
    let troopLine = `${t('world.troops')} ${troops}/${cap}`;
    if (inQ > 0) troopLine += `  ·  ${t('world.trainInQueue').replace('{n}', String(inQ))}`;
    addText(troopLine, ly, 12, C.red);
    ly += 24;

    // Recruit row
    addText(t('world.trainNew'), ly, 12);
    ly += 20;
    const ink = Math.floor(res['ink'] ?? 0);
    const capLeft = Math.max(0, cap - troops - inQ);
    const queueFull = (me.trainingQueue ?? []).length >= 2;
    const bw = (pw - 28 - MARGIN * 2) / 3;
    let bx = px + 14;
    for (const n of TRAIN_PRESETS) {
      const cost = n * TRAIN_INK_PER;
      const ok = !queueFull && capLeft >= n && ink >= cost;
      this.panelButton(
        `+${n}`, bx, ly, bw, 30,
        ok ? C.dark : C.mid,
        () => { if (ok) void this.doTrain(n); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < n ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
      );
      bx += bw + MARGIN;
    }
    // Max preset = min(batch cap, capacity left, ink-affordable)
    const maxQty = Math.min(TRAIN_BATCH_MAX, capLeft, Math.floor(ink / TRAIN_INK_PER));
    const maxOk = !queueFull && maxQty >= 1;
    this.panelButton(
      maxOk ? `${t('world.trainMax')} +${maxQty}` : t('world.trainMax'), bx, ly, bw, 30,
      maxOk ? C.red : C.mid,
      () => { if (maxOk) void this.doTrain(maxQty); else this.showToast(queueFull ? t('world.err.queueFull') : (capLeft < 1 ? t('world.err.troopCap') : t('world.err.noInk')), C.red); },
    );
    ly += 38;

    // Queue
    addText(t('world.trainQueue'), ly, 12);
    ly += 18;
    const queue = me.trainingQueue ?? [];
    if (queue.length === 0) {
      addText(t('world.trainQueueEmpty'), ly, 11, C.mid);
      ly += 18;
    } else {
      const now = Date.now();
      for (const e of queue) {
        const sec = Math.max(0, Math.ceil((e.completeAt - now) / 1000));
        addText(`• ${t('world.trainEntry').replace('{n}', String(e.qty)).replace('{sec}', String(sec))}`, ly, 11, C.dark);
        ly += 18;
      }
      // One-tap coin speedup: enough coins to clear the whole queue.
      const lastDone = queue[queue.length - 1]!.completeAt;
      const remainSec = Math.max(0, Math.ceil((lastDone - now) / 1000));
      const coins = Math.max(1, Math.ceil(remainSec / TRAIN_SPEEDUP_PER_COIN));
      ly += 4;
      this.panelButton(
        t('world.speedup').replace('{coins}', String(coins)),
        px + 14, ly, pw - 28, 28, C.accent,
        () => void this.doSpeedup(coins),
      );
      ly += 34;
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  private async doTrain(qty: number): Promise<void> {
    try {
      this.me = await this.cb.worldApi.trainTroops(this.cb.worldId, qty);
      this.showToast(t('world.trained'));
      if (this.trainPanelOpen) this.renderTrainPanel();
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doSpeedup(coins: number): Promise<void> {
    try {
      this.me = await this.cb.worldApi.speedupTraining(this.cb.worldId, coins);
      this.showToast(t('world.spedup'));
      if (this.trainPanelOpen) this.renderTrainPanel();
      this.renderHud();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── World info panel (C5): nations / season / SLG shop ───────────────────────
  // Tabbed modal rendered into modalLayer. Season is read-only; nations lets the
  // capital owner rename theirs (setNationName, server re-checks ownerId). The shop
  // buys via worldApi.buyShopItem → commercial.spend (server-authoritative, toast on
  // INSUFFICIENT_FUNDS) and shows the SaveData coin balance via the getCoins callback.

  private openInfoPanel(): void {
    this.trainPanelOpen = false;
    this.renderInfoPanel();
    // Lazy-load shop catalog + fresh nations/season the first time.
    if (this.shopItems.length === 0) {
      void this.cb.worldApi.getShopItems()
        .then((items) => { this.shopItems = items; if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel(); })
        .catch(() => { /* offline */ });
    }
    void this.cb.worldApi.getNations(this.cb.worldId)
      .then((n) => { this.nations = n; })
      .catch(() => {});
  }

  /** Localize an SLG shop item by kind + effect (server description is zh-only). */
  private shopLabel(it: SlgShopItemView): string {
    const eff = it.effect as Record<string, number>;
    switch (it.kind) {
      case 'troop_speedup': return t('world.shop.speedup').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'resource_pack': return t('world.shop.resPack').replace('{n}', String(eff.each ?? 0));
      case 'protection':    return t('world.shop.shield').replace('{h}', String(Math.round((eff.duration_sec ?? 0) / 3600)));
      case 'battle_pass':   return t('world.shop.battlePass');
      default:              return it.id;
    }
  }

  private renderInfoPanel(): void {
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalBtnRects = [];

    const { w, h } = this;
    const pw = Math.min(360, w - 20);
    const ph = Math.min(380, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(9, 9, pw) });
    panel.x = px; panel.y = py;
    ml.addChild(panel);

    const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark, anchorX = 0): void => {
      const lbl = txt(s, size, color);
      lbl.anchor.set(anchorX, 0);
      lbl.x = tx2; lbl.y = ty;
      ml.addChild(lbl);
    };

    // Title
    const title = txt(t('world.infoTitle'), 14, C.accent);
    title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
    ml.addChild(title);

    // Tabs
    const tabs: { id: 'nations' | 'season' | 'shop'; label: string }[] = [
      { id: 'nations', label: t('world.tabNations') },
      { id: 'season',  label: t('world.tabSeason') },
      { id: 'shop',    label: t('world.tabShop') },
    ];
    const tabW = (pw - 28 - MARGIN * 2) / 3;
    let tx = px + 14;
    const tabY = py + 34;
    for (const tab of tabs) {
      const active = this.infoTab === tab.id;
      this.panelButton(tab.label, tx, tabY, tabW, 26, active ? C.red : C.dark, () => {
        this.infoTab = tab.id; this.renderInfoPanel();
      });
      tx += tabW + MARGIN;
    }

    let ly = tabY + 38;
    const bodyBottom = py + ph - 42;

    if (this.infoTab === 'nations') {
      if (this.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, ly, 11, C.mid);
      } else {
        for (const n of this.nations) {
          if (ly > bodyBottom) break;
          const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
          const mine = !!n.ownerId && n.ownerId === this.cb.accountId;
          addText(`★ ${name}  (${n.x},${n.y})`, px + 14, ly, 11);
          if (mine) {
            // Owner may rename their capital (server re-checks ownerId).
            const bw = 54;
            this.panelButton(t('world.nationRename'), px + pw - bw - 14, ly - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
          } else {
            const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
            addText(status, px + pw - 14, ly, 11, n.ownerId ? C.red : C.mid, 1);
          }
          ly += 24;
        }
      }
    } else if (this.infoTab === 'season') {
      const s = this.season;
      if (!s) {
        addText('—', px + 14, ly, 11, C.mid);
      } else {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, ly, 13, C.red); ly += 22;
        const statusKey = `world.season.${s.status}`;
        addText(t(statusKey as Parameters<typeof t>[0]), px + 14, ly, 11); ly += 18;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, ly, 11); ly += 18;
        if (s.resetAt) {
          const days = Math.max(0, Math.ceil((s.resetAt - Date.now()) / 86400000));
          addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, ly, 11); ly += 18;
        }
      }
    } else {
      // Shop — show current coin balance (SaveData mirror) above the catalog.
      if (this.cb.getCoins) {
        addText(t('world.shopBalance').replace('{coins}', String(this.cb.getCoins())), px + 14, ly, 11, C.accent);
        ly += 22;
      }
      const rowH = 30;
      for (const it of this.shopItems) {
        if (ly + rowH > bodyBottom) break;
        addText(this.shopLabel(it), px + 14, ly + 4, 11);
        addText(t('world.shopCost').replace('{coins}', String(it.cost)), px + 14, ly + 18, 10, C.mid);
        const bw = 56;
        this.panelButton(t('world.shopBuy'), px + pw - bw - 14, ly + 2, bw, 24, C.accent, () => void this.doBuyShopItem(it.id));
        ly += rowH + 2;
      }
    }

    // Close
    this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
  }

  /** Open a hidden text input to rename an owned capital, then PATCH via worldsvc. */
  private openRenameInput(capitalIdx: number, current: string): void {
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = current;
    inp.maxLength = 24;
    inp.placeholder = t('world.nationNamePrompt');
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = inp.value.trim();
        inp.remove();
        if (name && name !== current) void this.doRename(capitalIdx, name);
      }
    });
    inp.addEventListener('blur', () => {
      inp.remove();
      if (this.hiddenInput === inp) this.hiddenInput = null;
    });
    this.hiddenInput = inp;
  }

  private async doRename(capitalIdx: number, name: string): Promise<void> {
    try {
      await this.cb.worldApi.setNationName(this.cb.worldId, capitalIdx, name);
      const n = this.nations.find(x => x.capitalIdx === capitalIdx);
      if (n) n.nationName = name;
      if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doBuyShopItem(itemId: string): Promise<void> {
    try {
      await this.cb.worldApi.buyShopItem(this.cb.worldId, itemId);
      this.showToast(t('world.shopBought'));
      await this.refreshMe();
      if (this.modalDimRect && !this.trainPanelOpen) this.renderInfoPanel();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Live push (worldsvc → gateway → NetSession → here, §14.5) ────────────────
  // Wired by createAppCore: it points session.handlers at these while the world
  // map is on-screen. Each one does a targeted authoritative refetch then redraws
  // — cheaper than hand-merging the push payload into the cached views.

  applyMarchUpdate(_m: MarchUpdate): void {
    if (this.destroyed) return;
    void this.refreshMarches();
  }

  applyTileUpdate(_tu: TileUpdate): void {
    if (this.destroyed) return;
    void this.loadMapViewport().then(() => { if (!this.destroyed) this.renderMap(); });
  }

  applyUnderAttack(u: UnderAttack): void {
    if (this.destroyed) return;
    const [tx, ty] = this.parseTileId(u.tile);
    const sec = Math.max(0, Math.ceil((u.arriveAt - Date.now()) / 1000));
    const name = u.attackerName || ('#' + (u.attackerPublicId || '?'));
    this.showToast(
      `${t('world.underAttack')} ${t('world.underAttackMsg')
        .replace('{name}', name)
        .replace('{tile}', `(${tx},${ty})`)
        .replace('{sec}', String(sec))}`,
      C.red,
    );
  }

  applySiegeResult(s: SiegeResult): void {
    if (this.destroyed) return;
    // Ownership / resources / troops may all have shifted — refetch the lot.
    void this.loadMapViewport().then(() => { if (!this.destroyed) this.renderMap(); });
    void this.refreshMe();
    void this.refreshMarches();

    if (this.myAttackTiles.has(s.tile)) {
      // We attacked — show the outcome + offer replay & verify (anti-cheat, C2).
      const loot = s.lootSummary ?? '';
      const line = s.outcome === 'attacker_win' ? t('world.siegeWin').replace('{loot}', loot)
        : s.outcome === 'defender_win' ? t('world.siegeLoss')
        : t('world.siegeDraw');
      this.showModal(
        [line],
        [
          { label: t('world.replaySiege'), action: () => { this.closeModal(); this.cb.onReplaySiege(s.siegeId); } },
          { label: '✕', action: () => this.closeModal() },
        ],
      );
    } else {
      // We were the defender (or a bystander) — toast only.
      const line = s.outcome === 'attacker_win' ? t('world.defendLost') : t('world.defendHeld');
      this.showToast(line, s.outcome === 'attacker_win' ? C.red : C.dark);
    }
  }

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        WORLD_FULL:    t('world.err.worldFull'),
        NO_TROOPS:     t('world.err.noTroops'),
        TILE_OCCUPIED: t('world.err.occupied'),
        PROTECTED:     t('world.err.protected'),
        OUT_OF_RANGE:  t('world.err.outOfRange'),
        NOT_OWNER:     t('world.err.notOwner'),
        NOT_IMPLEMENTED: t('world.err.notImpl'),
        TROOP_CAP_REACHED:      t('world.err.troopCap'),
        INSUFFICIENT_RESOURCES: t('world.err.noInk'),
        PATH_BLOCKED:  t('world.err.pathBlocked'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Pan ───────────────────────────────────────────────────────────────────

  private centerAt(tx: number, ty: number): void {
    const tp = this.tp;
    this.panX = this.w / 2 - tx * tp - tp / 2;
    this.panY = (this.h - HUD_H) / 2 - ty * tp - tp / 2;
    this.clampPan();
  }

  private clampPan(): void {
    const tp = this.tp;
    const maxX = tp * 2;
    const maxY = tp * 2;
    const minX = this.w - this.mapW * tp - tp * 2;
    const minY = (this.h - HUD_H) - this.mapH * tp - tp * 2;
    this.panX = Math.min(maxX, Math.max(minX, this.panX));
    this.panY = Math.min(maxY, Math.max(minY, this.panY));
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } {
    const tp = this.tp;
    return {
      x: Math.floor((sx - this.panX) / tp),
      y: Math.floor((sy - this.panY) / tp),
    };
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    // Modal buttons
    if (this.modalDimRect) {
      for (const { rect, action } of this.modalBtnRects) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action();
          return;
        }
      }
      this.closeModal();
      return;
    }

    // Zoom button (top-left over the map)
    const zb = this.zoomBtnRect;
    if (zb.w > 0 && x >= zb.x && x <= zb.x + zb.w && y >= zb.y && y <= zb.y + zb.h) {
      this.setZoom(((this.zoom % 3) + 1) as 1 | 2 | 3);
      return;
    }

    // World info button (floats top-right over the map)
    const ib = this.infoBtnRect;
    if (ib.w > 0 && x >= ib.x && x <= ib.x + ib.w && y >= ib.y && y <= ib.y + ib.h) {
      this.openInfoPanel();
      return;
    }

    // Back button
    const b = this.backRect;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      this.cb.onBack();
      return;
    }

    // Train / Family / Auction buttons
    const tr = this.trainBtnRect;
    if (tr.w > 0 && x >= tr.x && x <= tr.x + tr.w && y >= tr.y && y <= tr.y + tr.h) {
      this.openTrainPanel();
      return;
    }
    const f = this.famBtnRect;
    if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) {
      this.cb.onOpenFamily();
      return;
    }
    const a = this.aucBtnRect;
    if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) {
      this.cb.onOpenAuction();
      return;
    }

    // March row hit detection (recall button or click-to-center)
    for (const entry of this.marchRowRects) {
      if (entry.recallRect) {
        const r = entry.recallRect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
          void this.doRecall(entry.marchId, entry.worldId);
          return;
        }
      }
      const row = entry.rowRect;
      if (x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h) {
        this.centerAt(entry.destX, entry.destY);
        this.renderMap();
        return;
      }
    }

    // Begin drag
    if (y < this.h - HUD_H) {
      this.dragging = true;
      this.dragMoved = false;
      this.dragStartX = x - this.panX;
      this.dragStartY = y - this.panY;
    }
  }

  handleMove(x: number, y: number): void {
    if (!this.dragging) return;
    const dx = x - (this.dragStartX + this.panX);
    const dy = y - (this.dragStartY + this.panY);
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) this.dragMoved = true;
    if (this.dragMoved) {
      this.panX = x - this.dragStartX;
      this.panY = y - this.dragStartY;
      this.clampPan();
      // L1/L2: pool reposition — cheap, no Graphics.clear() needed.
      // L3: just flag dirty; actual redraw happens in update() at most 60fps.
      if (this.zoom < 3) {
        this.refreshPool();
        this.renderOverlay();
      } else {
        this.l3Dirty = true;
        this.renderOverlay();
      }
    }
  }

  handleUp(x: number, y: number): void {
    if (!this.dragging) return;
    const wasDragging = this.dragMoved;
    this.dragging = false;

    if (!wasDragging && y < this.h - HUD_H) {
      const { x: tx, y: ty } = this.screenToTile(x, y);
      this.onTileClick(tx, ty);
    } else if (wasDragging) {
      // Lazy-load new viewport tiles after pan
      void this.loadMapViewport().then(() => {
        if (!this.destroyed) this.renderMap();
      });
    }
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
    // L3 overview: flush dirty flag at most once per frame (60fps cap).
    if (this.l3Dirty && this.zoom === 3) {
      this.renderMapL3();
    }
    // Tick the train panel's queue countdowns once per second while open.
    if (this.trainPanelOpen) {
      this.panelRepaint += dt;
      if (this.panelRepaint >= 1) {
        this.panelRepaint = 0;
        this.renderTrainPanel();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.marchPoll) { clearInterval(this.marchPoll); this.marchPoll = null; }
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const s of this.pool) s.g.destroy();
    this.pool = [];
    this.container.destroy({ children: true });
  }
}
