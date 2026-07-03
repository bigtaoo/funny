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
import { proceduralTile, type ProceduralTile } from '@nw/shared';
import { loadResAtlas, getResTexture, isResAtlasReady } from '../render/resAtlasLoader';
import { loadCityAtlas, getCityTexture, isCityAtlasReady } from '../render/cityAtlasLoader';
import { loadTerrainAtlas, getTerrainTexture, isTerrainAtlasReady, type TerrainTextureName } from '../render/terrainAtlasLoader';
import { ISO_RATIO, tileToScreen, screenToTile, screenToTileF, diamondPath, diamondVertices, visibleTileBounds } from '../render/isoGrid';

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
  /** Open the home-city internal management scene (SLG_CITY_DESIGN P1). */
  onOpenCity(): void;
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
// Two orthogonal signals, kept visually separate to preserve the hand-drawn notebook feel
// (project_art_direction) and stop the map reading as a confetti of colored blocks:
//   • TERRAIN / RESOURCE → a calm, near-paper base fill. Resource *type* is carried by the
//     hand-drawn motif sprite (drawResMotif at L1), NOT by a saturated background. RES_COLORS
//     are heavily desaturated (paper-adjacent, warm/neutral) so they never masquerade as an
//     ownership hue and only whisper the biome zone at the L2/L3 overview.
//   • OWNERSHIP → the only strong color, applied as a translucent wash + colored border/accent
//     (see ownerTint + drawTileL1/L2), following the "enemy blue, player red" convention:
//     own = red ink, enemy = blue ink, family-ally = green ink.

// Terrain base colors (unoccupied) — desaturated, paper-cohesive; specials stay distinct but muted.
const TERRAIN_COLORS: Record<string, number> = {
  neutral:    0xf5f0e8, // paper-white empty land
  resource:   0xf0ece0, // resource fallback → near-paper (type is carried by the motif, not the fill)
  familyKeep: 0xe8d29a, // strategic point / chokepoint — muted warm amber
  center:     0xf0dfa0, // world center — soft gold
  obstacle:   0xc4bdb0, // impassable terrain (mountains/rivers) — muted stone grey
  gate:       0xd8c2a0, // pass / bridge (corridor) — soft tan
  stronghold: 0x9a7a6a, // stronghold (G8): muted stone brown (was dark red — avoided clash with own-territory red)
  territory:  0xf5f0e8, // fallback (ownership is drawn as wash/border, not as the fill)
  base:       0xf5f0e8,
};

// Resource biome tints — deliberately faint & paper-adjacent. The real type signal is the motif;
// these only hint the biome zone at overview zooms. Kept warm/neutral so none reads as red/blue/green.
const RES_COLORS: Record<string, number> = {
  ink:      0xe4e2ea, // faint cool grey-lavender
  paper:    0xf0ebdd, // faint warm cream
  graphite: 0xe2e0da, // faint neutral grey
  metal:    0xe4e8e6, // faint cool steel
  sticker:  0xefe4ea, // faint warm rose-grey
};

const MINE_TINT      = 0xe69090; // own territory (light red ink)
const MINE_BASE_TINT = 0xcc3333; // own capital (deep red ink)
const ENEMY_TINT     = 0x90a8e6; // enemy territory (light blue ink)
const ENEMY_BASE_TINT= 0x4477cc; // enemy capital (deep blue ink)
const ALLY_TINT      = 0x9cd6a4; // family-ally territory (light green ink — G5 friendly third color)
const ALLY_BASE_TINT = 0x46a85a; // family-ally capital (deep green ink)
const FOG_COLOR      = 0x6b6458; // fog of war (pencil grey, overlaid on terrain)
const ALLY_SECT_BORDER = 0xe6a817; // allied-sect territory yellow border (amber gold, G5; marks without shared vision, §8.2)

/** Ownership color for the wash/border overlay, or null when the tile is unowned. */
function ownerTint(tile: WorldTileView): number | null {
  if (tile.mine)     return tile.type === 'base' ? MINE_BASE_TINT : MINE_TINT;
  if (tile.ally)     return tile.type === 'base' ? ALLY_BASE_TINT : ALLY_TINT;
  if (tile.occupied) return tile.type === 'base' ? ENEMY_BASE_TINT : ENEMY_TINT;
  return null;
}

/** Terrain/resource base fill (no ownership) — desaturated, paper-cohesive. */
function terrainFill(tile: WorldTileView): number {
  if (tile.type === 'resource' && tile.resType) {
    return RES_COLORS[tile.resType] ?? TERRAIN_COLORS.resource!;
  }
  return TERRAIN_COLORS[tile.type] ?? TERRAIN_COLORS.neutral!;
}

/**
 * Hand-drawn ground texture for a tile type (design/product/slg-terrain-art.md §0/§3).
 * `obstacle` covers both mountain and river (SLG_DESIGN §3.1) — a deterministic per-tile
 * hash picks one of the two doodle variants so a contiguous obstacle band doesn't look
 * monotone, without introducing a third TileType into the data model.
 */
function terrainTextureName(type: string, tx: number, ty: number): TerrainTextureName {
  switch (type) {
    case 'obstacle':    return (tx * 31 + ty * 17) % 2 === 0 ? 'terrain_mountain' : 'terrain_river';
    case 'gate':        return 'terrain_gate';
    case 'familyKeep':  return 'terrain_keep';
    case 'center':      return 'terrain_center';
    case 'stronghold':  return 'terrain_stronghold';
    default:            return 'terrain_grass'; // neutral / territory / base / resource default ground
  }
}

/**
 * L3 overview block color: ownership dominates when owned (the overview exists for
 * situational awareness — whose land is where), otherwise the calm terrain fill.
 */
function tileColor(tile: WorldTileView): number {
  return ownerTint(tile) ?? terrainFill(tile);
}

/** Procedural terrain color for uncached tiles (no network request; purely local computation). */
function proceduralTileColor(worldId: string, x: number, y: number): number {
  const p = proceduralTile(worldId, x, y);
  if (p.type === 'resource' && p.resType) return RES_COLORS[p.resType] ?? TERRAIN_COLORS.resource!;
  return TERRAIN_COLORS[p.type] ?? TERRAIN_COLORS.neutral!;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAP_SIZE = 1500; // server default 1500×1500; actual value comes from getSeason
const HUD_H    = 100;  // bottom HUD bar height
const MARGIN   = 4;    // margin inside modal
const CONFIRM_H = 140;

// City sprite side length in tiles (ADR-025). The base now really occupies a 3×3 footprint; the
// sprite is drawn slightly larger than 3 tiles to compensate the ~15% transparent margin baked into
// the isometric city art, so the drawn building visually fills its 3×3 block instead of floating small.
const BASE_SPRITE_TILES = 3.2;

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
    // Under isometric projection the screen rect back-projects to a rotated (diamond)
    // region in tile space, so the axis-aligned tile range covering it is wider/taller
    // than the orthogonal `w/tile` estimate — use the real bounding-box size (pan-
    // independent: translation doesn't change its width/height, only its origin).
    const b = visibleTileBounds(w, mh, 0, 0, tile);
    const visW = b.maxTx - b.minTx;
    const visH = b.maxTy - b.minTy;
    return { tile, visW, visH, poolW: visW + 2, poolH: visH + 2 };
  };
  return [mk(Math.floor(w / 19)), mk(Math.floor(w / 37)), mk(27)];
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

  // City sprite layer: 3×3-tile building sprites for base tiles, sits above the tile pool.
  private cityLayer!: PIXI.Container;
  // Keyed by "tx:ty". Each value is a Container holding a Sprite (image) + Graphics (level dots).
  private citySprites: Map<string, PIXI.Container> = new Map();

  // Overlay: march arrows, selected tile highlight, capital stars (fast, always redrawn).
  private overlayGfx!: PIXI.Graphics;

  // Layers
  private hudLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // First-paint loading gate: an opaque paper cover shown until the terrain / city /
  // resource atlases have decoded, so the map reveals fully textured rather than
  // flashing flat color blocks that then swap to the hand-drawn ground textures.
  private loadingLayer: PIXI.Container | null = null;
  private loadingSpinner: PIXI.Graphics | null = null;
  private loadingAngle = 0;
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null;

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

    // Load the map atlases (terrain ground tiles / city sprites / resource motifs)
    // behind the loading cover, then reveal the map fully textured in one paint —
    // rather than showing flat color blocks that visibly swap to textures. Each load
    // is best-effort: on decode failure that layer falls back to its flat-color /
    // programmatic rendering, so a failed atlas must not trap the player on the cover.
    const atlasLoads = [
      loadTerrainAtlas().catch((err) => console.warn('[WorldMapScene] terrain atlas load failed:', err)),
      loadCityAtlas().catch((err) => console.warn('[WorldMapScene] city atlas load failed:', err)),
      loadResAtlas().catch((err) => console.warn('[WorldMapScene] res atlas load failed:', err)),
    ];
    Promise.allSettled(atlasLoads).then(() => {
      if (this.destroyed) return;
      this.renderMap();
      this.hideLoading();
    });
    // Safety net: reveal anyway if an atlas hangs (e.g. a stalled decode), so the
    // player is never stuck staring at the loading cover.
    this.loadingTimeout = setTimeout(() => {
      if (!this.destroyed) { this.renderMap(); this.hideLoading(); }
    }, 8000);
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

    // City building sprites (above tiles, below overlay). sortableChildren + zIndex
    // (set per-sprite in refreshCityLayer) gives isometric-correct back-to-front draw order.
    this.cityLayer = new PIXI.Container();
    this.cityLayer.sortableChildren = true;
    mapClip.addChild(this.cityLayer);

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

    // Loading cover — top-most so the half-built / untextured map never peeks through.
    this.buildLoadingOverlay();

    this.buildPool();
    this.renderHud();
    this.invalidatePool();
  }

  /**
   * The first-paint loading cover: an opaque notebook-paper sheet + a hand-drawn
   * spinning ink ring + localized "loading map…" caption. Hidden by hideLoading()
   * once the map atlases have settled (see constructor). Sized to the full scene so
   * nothing underneath — flat color tiles, fog, half-loaded city sprites — shows.
   */
  private buildLoadingOverlay(): void {
    const { w, h } = this;
    const layer = new PIXI.Container();

    const sheet = buildPaperBackground('worldmap-loading', w, h);
    layer.addChild(sheet);

    const cx = w / 2;
    const cy = (h - HUD_H) / 2;

    // Broken ink ring (open arc) — rotated each frame in update() while active.
    const spinner = new PIXI.Graphics();
    spinner.lineStyle(3, 0x3a3a3a, 0.9);
    spinner.arc(0, 0, 22, -Math.PI * 0.15, Math.PI * 1.25);
    spinner.position.set(cx, cy);
    layer.addChild(spinner);

    const label = new PIXI.Text(t('world.loading'), {
      fontFamily: 'sans-serif', fontSize: 18, fill: 0x3a3a3a,
    });
    label.anchor.set(0.5);
    label.position.set(cx, cy + 50);
    layer.addChild(label);

    this.container.addChild(layer);
    this.loadingLayer = layer;
    this.loadingSpinner = spinner;
  }

  /** Remove the first-paint loading cover (idempotent); clears the safety timeout. */
  private hideLoading(): void {
    if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null; }
    if (this.loadingLayer) {
      this.loadingLayer.destroy({ children: true });
      this.loadingLayer = null;
      this.loadingSpinner = null;
    }
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
    // tileId = `{worldId}:{x}:{y}` (worldId itself contains no ':'); take the last
    // two segments. mainBaseTile / march.fromTile / toTile all carry the worldId
    // prefix — parsing the first two segments read the worldId as x (→ 0), which
    // mis-centered the map far from the base (all-fog viewport, no city/resources).
    const parts = tileId.split(':');
    const x = Number(parts[parts.length - 2]);
    const y = Number(parts[parts.length - 1]);
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
  }

  /**
   * Strict tile-id parse for rendering (marches): returns null — instead of parseTileId's (0,0)
   * fallback — when the id is missing/malformed or the coords fall outside the map. A march with a
   * bad endpoint would otherwise draw a line from the world origin (0,0) straight across the whole
   * screen (the "stray red line" artifact); callers skip drawing when this returns null.
   */
  private parseTileStrict(tileId: string | undefined | null): [number, number] | null {
    if (!tileId) return null;
    const parts = tileId.split(':');
    if (parts.length < 2) return null;
    const x = Number(parts[parts.length - 2]);
    const y = Number(parts[parts.length - 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return null;
    return [x, y];
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
    const b = visibleTileBounds(this.w, this.h - HUD_H, this.panX, this.panY, tp);
    const cx = Math.floor((b.minTx + b.maxTx) / 2);
    const cy = Math.floor((b.minTy + b.maxTy) / 2);
    const r  = Math.ceil(Math.max(b.maxTx - b.minTx, b.maxTy - b.minTy) / 2) + 4;
    return { cx: Math.max(0, Math.min(this.mapW - 1, cx)), cy: Math.max(0, Math.min(this.mapH - 1, cy)), r };
  }

  // ── Zoom control ───────────────────────────────────────────────────────────

  private setZoom(z: 1 | 2 | 3): void {
    if (this.zoom === z) return;
    // Keep map center stable across zoom levels: read which (fractional) tile is
    // under the screen center under the old projection, then re-pan so that same
    // tile lands on screen center under the new tile size.
    const oldTp = this.tp;
    const screenCx = this.w / 2;
    const screenCy = (this.h - HUD_H) / 2;
    const frac = screenToTileF(screenCx - this.panX, screenCy - this.panY, oldTp);
    this.zoom = z;
    const newCenterScreen = tileToScreen(frac.x, frac.y, this.tp);
    this.panX = screenCx - newCenterScreen.x;
    this.panY = screenCy - newCenterScreen.y;
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
    this.refreshCityLayer();
    if (this.zoom === 3) return;
    const { tile: tp, poolW, poolH } = this.zc;
    // Isometric visible region is a rotated (diamond) area in tile space — the pool
    // covers its axis-aligned bounding box, so poolW/poolH (widened in makeZoomCfgs)
    // must be paired with an origin computed the same way rather than a naive
    // `-panX / tp`.
    const b = visibleTileBounds(this.w, this.h - HUD_H, this.panX, this.panY, tp);
    const x0 = b.minTx - 1;
    const y0 = b.minTy - 1;
    for (let dy = 0; dy < poolH; dy++) {
      for (let dx = 0; dx < poolW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        const si = (((ty % poolH) + poolH) % poolH) * poolW + (((tx % poolW) + poolW) % poolW);
        const slot = this.pool[si]!;
        const s = tileToScreen(tx, ty, tp);
        slot.g.x = this.panX + s.x;
        slot.g.y = this.panY + s.y;
        if (slot.tx === tx && slot.ty === ty) continue;
        slot.tx = tx; slot.ty = ty;
        this.drawTileSlot(slot, tx, ty);
      }
    }
  }

  /**
   * Position and populate city building sprites for all base tiles currently
   * in the viewport. Each city occupies a 3×3-tile sprite centered on the base
   * tile — the image hovers above the tile pool layer so it never gets covered
   * by adjacent tiles.
   *
   * Programmatic level-within-tier distinction: filled / hollow dots below the
   * city image indicate how far into the current tier the city has upgraded.
   *   Tier 1 (lv 1-2):  ● ○  /  ● ●
   *   Tier 2 (lv 3-5):  ● ○ ○  /  ● ● ○  /  ● ● ●
   *   (etc.)
   */
  private refreshCityLayer(): void {
    if (!isCityAtlasReady()) {
      this.cityLayer.visible = false;
      return;
    }
    this.cityLayer.visible = true;

    const tp = this.tp;
    const b = visibleTileBounds(this.w, this.h - HUD_H, this.panX, this.panY, tp);
    const x0 = b.minTx - 2;
    const y0 = b.minTy - 2;
    const visW = (b.maxTx - b.minTx) + 4;
    const visH = (b.maxTy - b.minTy) + 4;

    const seen = new Set<string>();

    for (let dy = 0; dy < visH; dy++) {
      for (let dx = 0; dx < visW; dx++) {
        const tx = x0 + dx;
        const ty = y0 + dy;
        if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) continue;

        const cacheKey = `${tx}:${ty}`;
        const tile = this.tileCache.get(cacheKey);
        // A base occupies 9 tiles (ADR-025); draw the single city sprite only on the CENTER anchor,
        // so the 8 ring cells don't each spawn an overlapping 3×3 sprite.
        if (tile?.type !== 'base' || !this.isBaseAnchor(tx, ty)) continue;

        seen.add(cacheKey);

        const lv = tile.level ?? 1;
        const tier = lv <= 2 ? 1 : lv <= 5 ? 2 : lv <= 8 ? 3 : 4;
        const tex = getCityTexture(tier as 1 | 2 | 3 | 4);
        if (!tex) continue;

        // Reuse or create city container
        let cityC = this.citySprites.get(cacheKey);
        if (!cityC) {
          const sprite = new PIXI.Sprite(tex);
          sprite.name = 'img';
          sprite.anchor.set(0.5);
          const dotGfx = new PIXI.Graphics();
          dotGfx.name = 'dots';
          cityC = new PIXI.Container();
          cityC.addChild(sprite);
          cityC.addChild(dotGfx);
          this.cityLayer.addChild(cityC);
          this.citySprites.set(cacheKey, cityC);
        }

        // Position at tile diamond center; depth-sort so bases further back (smaller
        // tx+ty) never overdraw ones nearer camera when their sprites overlap.
        const s = tileToScreen(tx, ty, tp);
        cityC.x = this.panX + s.x;
        cityC.y = this.panY + s.y;
        cityC.zIndex = tx + ty;

        // Resize sprite: keep the atlas art's own square aspect (it already draws each
        // building in isometric perspective on its own implied ground plane, per
        // cityAtlasLoader.ts) rather than squashing it into the 3×3 diamond footprint's
        // flatter bounding box — width still matches BASE_SPRITE_TILES*tp so buildings
        // line up with the footprint; height keeps the art's natural proportion. Whether
        // this still reads well is a v1 question for the follow-up diamond-art pass.
        const sprite = cityC.getChildByName('img') as PIXI.Sprite;
        if (sprite.texture !== tex) sprite.texture = tex;
        sprite.width  = BASE_SPRITE_TILES * tp;
        sprite.height = BASE_SPRITE_TILES * tp;

        // Redraw level-within-tier dots
        const dots = cityC.getChildByName('dots') as PIXI.Graphics;
        dots.clear();
        const inkColor = tile.mine ? 0xcc2222 : (tile.ally ? 0x2e8b40 : (tile.occupied ? 0x2266cc : 0x888888));
        const tierStarts = [0, 0, 2, 5, 8] as const;
        const tierSizes  = [0, 2, 3, 3, 2] as const;
        const maxInTier = tierSizes[tier];
        const lvInTier  = lv - tierStarts[tier]; // 1-indexed
        if (maxInTier > 1) {
          const dotR  = Math.max(2.5, tp * 0.09);
          const gap   = dotR * 2.7;
          const totalW = maxInTier * gap - gap + 2 * dotR;
          const bx    = -totalW / 2 + dotR;
          const by    = (BASE_SPRITE_TILES / 2) * tp + dotR;   // just below the sprite's bottom edge
          dots.lineStyle(1, inkColor, 0.85);
          for (let d = 0; d < maxInTier; d++) {
            const cx = bx + d * gap;
            dots.beginFill(d < lvInTier ? inkColor : 0xfff8f0, d < lvInTier ? 0.9 : 0.85);
            dots.drawCircle(cx, by, dotR);
            dots.endFill();
          }
        }
      }
    }

    // Destroy sprites that have scrolled off-screen
    for (const [key, cityC] of this.citySprites) {
      if (!seen.has(key)) {
        this.cityLayer.removeChild(cityC);
        cityC.destroy({ children: true });
        this.citySprites.delete(key);
      }
    }
  }

  /** Redraw a single pool slot for the given map position. */
  private drawTileSlot(slot: PoolSlot, tx: number, ty: number): void {
    const g = slot.g;
    g.clear();
    // Remove any sprite children added by the previous draw (resource motifs).
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      if (c instanceof PIXI.Sprite) { g.removeChild(c); c.destroy({ children: false }); }
    }
    const tp = this.tp;
    const inBounds = tx >= 0 && ty >= 0 && tx < this.mapW && ty < this.mapH;
    if (!inBounds) { g.visible = false; return; }
    g.visible = true;

    const tile = this.tileCache.get(`${tx}:${ty}`);
    // Uncached tiles (outside the fetched viewport / never claimed) still have a deterministic
    // terrain identity — proceduralTile() is computable on either end (§14.2). Without this the
    // texture/motif layers fell back to 'neutral'→grass on every uncached tile, hiding the whole
    // map's variety (obstacles / gates / center / biome resources) under one repeated doodle.
    const proc: ProceduralTile | null = tile ? null : proceduralTile(this.cb.worldId, tx, ty);
    // Terrain fill and ownership are now two separate signals (see ownerTint/terrainFill).
    const fill = tile ? terrainFill(tile) : proceduralTileColor(this.cb.worldId, tx, ty);
    const owner = tile ? ownerTint(tile) : null;
    const fogged = tile?.visible === false;

    if (this.zoom === 1) {
      const isAnchor = tile?.type === 'base' && this.isBaseAnchor(tx, ty);
      const texName = terrainTextureName(tile?.type ?? proc?.type ?? 'neutral', tx, ty);
      this.drawTileL1(g, tile ?? null, fill, owner, fogged, tp, isAnchor, texName, proc);
    } else {
      this.drawTileL2(g, fill, owner, fogged, tp);
    }
  }

  /**
   * Is (tx,ty) the CENTER anchor of a 3×3 base (ADR-025)? True iff the tile and all 4 orthogonal
   * neighbors are base tiles of the same owner — only the center of a 3×3 satisfies this, so ring
   * cells return false. Used to draw the city sprite/icon exactly once per base.
   */
  private isBaseAnchor(tx: number, ty: number): boolean {
    const c = this.tileCache.get(`${tx}:${ty}`);
    if (c?.type !== 'base') return false;
    const ownerKey = this.ownerKeyOf(c);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const n = this.tileCache.get(`${tx + dx}:${ty + dy}`);
      if (n?.type !== 'base' || this.ownerKeyOf(n) !== ownerKey) return false;
    }
    return true;
  }

  /** Stable-ish owner identity for anchor detection: prefer ownerPublicId, else the mine/ally/enemy class. */
  private ownerKeyOf(t: WorldTileView): string {
    return t.ownerPublicId ?? (t.mine ? 'me' : t.ally ? 'ally' : t.occupied ? 'enemy' : 'none');
  }

  /**
   * L1 detail tile: paper terrain + motif, then ownership wash/border, then level/sect/watchtower markers.
   * `g`'s local origin is the tile's DIAMOND CENTER (set by refreshPool via isoGrid.tileToScreen),
   * not the old top-left square corner — every marker below is positioned relative to that center.
   */
  private drawTileL1(
    g: PIXI.Graphics, tile: WorldTileView | null,
    fill: number, owner: number | null, fogged: boolean, tp: number, isAnchor: boolean,
    texName: TerrainTextureName, proc: ProceduralTile | null = null,
  ): void {
    const hh = (tp * ISO_RATIO) / 2;
    // Soft sketch grid, then the ground: hand-drawn texture fill once the atlas has
    // decoded, falling back to the flat desaturated color (see terrainFill) until then.
    g.lineStyle(0.7, 0xccbbaa, 0.32);
    const tex = isTerrainAtlasReady() ? getTerrainTexture(texName) : null;
    if (tex) {
      const w = tp - 1;
      const h = w * ISO_RATIO;
      const m = new PIXI.Matrix(w / tex.width, 0, 0, h / tex.height, -w / 2, -h / 2);
      g.beginTextureFill({ texture: tex, matrix: m, alpha: 0.9 });
    } else {
      g.beginFill(fill, 0.7);
    }
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();

    // Resource motif is TERRAIN, not a dynamic layer — it stays visible even under
    // fog (§18 V1 model 2a: the procedural terrain layer is always visible map-wide;
    // only the dynamic layer — ownership / base / garrison / level detail — is
    // vision-gated). When fogged, drawResMotif reveals the resource TYPE only (single
    // dimmed motif, no abundance/defense detail), matching "地形可见、局势看不清".
    if (tile?.type === 'resource' && tile.resType) {
      this.drawResMotif(g, tile.resType, tile.level ?? 1, tp, fogged);
    } else if (!tile && proc && (proc.type === 'resource' || proc.type === 'familyKeep' || proc.type === 'stronghold') && proc.resType) {
      // Uncached tile: reveal its procedural resource TYPE (the terrain layer is always visible
      // map-wide, §18 V1 model 2a) so biome zones read as varied instead of uniform grass.
      this.drawResMotif(g, proc.resType, proc.level, tp, false);
    }

    // Ownership overlay (option-3): a light wash + colored border, not a full opaque fill —
    // territory reads clearly while the terrain/motif underneath stays legible. Motif sprites
    // are Graphics children and always render above this wash, so they are never covered.
    if (owner != null && !fogged) {
      const isBase = tile?.type === 'base';
      g.lineStyle(0);
      g.beginFill(owner, isBase ? 0.26 : 0.16);
      g.drawPolygon(diamondPath(tp - 1));
      g.endFill();
      g.lineStyle(isBase ? 2.4 : 1.6, owner, 0.9);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: 2.2 / tp }));
      g.endFill();
    }

    if (fogged) {
      g.lineStyle(0);
      g.beginFill(FOG_COLOR, 0.4);
      g.drawPolygon(diamondPath(tp - 1));
      g.endFill();
      return;  // dynamic markers (city icon, level dot, sect border, watchtower) stay hidden under fog
    }

    // City icon on capital tiles: sprite layer handles this once the atlas is ready.
    if (isAnchor && !isCityAtlasReady()) {
      // Programmatic fallback icon, drawn once on the base's center anchor until the atlas decodes.
      this.drawCityIcon(g, tile!.mine ?? false, tile!.ally ?? false, tile!.level ?? 1, tp);
    }

    if (tile && tile.level > 1) {
      // Was the square's top-right corner (tp-6,6); nearest diamond analog is the
      // midpoint of the top→right edge, nudged slightly inward.
      const dotColor = tile.mine ? 0xcc2222 : (tile.ally ? 0x2e8b40 : (tile.occupied ? 0x2266cc : 0x888888));
      const v = diamondVertices(tp - 1);
      const dotX = (v.top[0] + v.right[0]) / 2 * 0.85;
      const dotY = (v.top[1] + v.right[1]) / 2 * 0.85;
      g.lineStyle(0);
      g.beginFill(dotColor, 0.9);
      g.drawCircle(dotX, dotY, 3);
      g.endFill();
    }

    // ADR-026 §1: building HP bar on attackable buildings under siege. Only drawn while damaged
    // (hp < maxHp) so full-HP buildings keep the map uncluttered; a depleted bar signals an active siege.
    if (tile && tile.maxHp && tile.hp != null && tile.hp < tile.maxHp) {
      this.drawHpBar(g, tile.hp, tile.maxHp, tp);
    }

    if (tile?.allySect) {
      g.lineStyle(2, ALLY_SECT_BORDER, 0.95);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: Math.min(0.35, 5 / tp) }));
      g.endFill();
    }

    if (tile?.watchtower) {
      // Was anchored at the square's bottom-center (baseY=tp-5); the diamond analog
      // is the bottom vertex, nudged up slightly so the tower base still reads as
      // sitting inside the tile rather than poking past its edge.
      const tcx = 0;
      const baseY = hh - 4;
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

  /**
   * ADR-026 §1: a small building-HP bar near the bottom of an attackable tile. Green→amber→red by ratio,
   * so an enemy base being ground down under a siege reads at a glance. Width scales with the tile size.
   */
  private drawHpBar(g: PIXI.Graphics, hp: number, maxHp: number, tp: number): void {
    // `g`'s local origin is the tile's diamond center (see drawTileL1); the bar sits just
    // above the diamond's bottom vertex instead of the old square's bottom edge.
    const hh = (tp * ISO_RATIO) / 2;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    const barW = tp * 0.7;
    const barH = Math.max(3, tp * 0.06);
    const x = -barW / 2;
    const y = hh - barH - 3;
    // Track
    g.lineStyle(0.6, 0x3a2a1a, 0.8);
    g.beginFill(0x2a1e12, 0.75);
    g.drawRect(x, y, barW, barH);
    g.endFill();
    // Fill: green (full) → amber (mid) → red (low)
    const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
    g.lineStyle(0);
    g.beginFill(fillColor, 0.95);
    g.drawRect(x, y, barW * ratio, barH);
    g.endFill();
  }

  /**
   * Programmatic city icon drawn on capital (base) tiles.
   * Tier 1 (lv 1-2): camp silhouette; Tier 2 (lv 3-5): walled town; Tier 3 (lv 6-8): castle;
   * Tier 4 (lv 9-10): grand citadel. Will be replaced by AI-generated sprites once assets land.
   */
  private drawCityIcon(g: PIXI.Graphics, mine: boolean, ally: boolean, lv: number, tp: number): void {
    const tier = lv <= 2 ? 1 : lv <= 5 ? 2 : lv <= 8 ? 3 : 4;
    const ink = mine ? 0xcc2222 : (ally ? 0x2e8b40 : 0x224488);
    const fill = mine ? 0xf5d5d5 : (ally ? 0xd5f0e0 : 0xd5e0f5);
    const margin = Math.max(4, tp * 0.08);
    const inner = tp - 1 - margin * 2;
    // `g`'s local origin is now the tile's diamond CENTER (see drawTileL1), not the old
    // square's top-left corner — `og` re-anchors this icon's inner square there. The icon
    // itself stays a plain square drawing (it's a placeholder pending real art anyway).
    const og = -tp / 2 + margin;

    g.lineStyle(1.2, ink, 0.9);

    if (tier === 1) {
      // Two tents
      g.beginFill(fill, 0.85);
      const tentW = inner * 0.42;
      const tentH = inner * 0.55;
      const y0 = og + inner * 0.35;
      [0.15, 0.52].forEach((fx) => {
        const tx = og + inner * fx;
        g.moveTo(tx, y0); g.lineTo(tx + tentW / 2, y0 - tentH); g.lineTo(tx + tentW, y0);
        g.closePath();
      });
      g.endFill();
      // ground line
      g.lineStyle(0.8, ink, 0.6);
      g.moveTo(og, og + inner * 0.35); g.lineTo(og + inner, og + inner * 0.35);
    } else if (tier === 2) {
      // Walled town: rectangle perimeter + small house inside
      const wy = og + inner * 0.15;
      const wh = inner * 0.72;
      g.beginFill(fill, 0.75);
      g.drawRect(og, wy, inner, wh);
      g.endFill();
      g.lineStyle(1.5, ink, 0.9);
      g.drawRect(og, wy, inner, wh);
      // Gate in center-bottom
      const gw = inner * 0.28;
      g.lineStyle(0);
      g.beginFill(ink, 0.4);
      g.drawRect(og + inner / 2 - gw / 2, wy + wh - wh * 0.36, gw, wh * 0.36);
      g.endFill();
      // Central tower
      g.lineStyle(1.2, ink, 0.9);
      g.beginFill(fill, 0.9);
      const tw = inner * 0.22, th = inner * 0.46;
      g.drawRect(og + inner / 2 - tw / 2, wy - th * 0.3, tw, th);
      g.endFill();
    } else if (tier === 3) {
      // Castle: outer wall with crenels + keep
      const wy = og + inner * 0.22;
      const wh = inner * 0.65;
      g.beginFill(fill, 0.80);
      g.drawRect(og, wy, inner, wh);
      g.endFill();
      g.lineStyle(1.5, ink, 0.9);
      g.drawRect(og, wy, inner, wh);
      // Crenellations top
      const cs = Math.max(2, inner * 0.07);
      g.lineStyle(0);
      g.beginFill(ink, 0.7);
      for (let i = 0; i < 4; i++) {
        g.drawRect(og + i * (inner / 4), wy - cs, inner / 8, cs);
      }
      g.endFill();
      // Keep tower
      const tw = inner * 0.3, th = inner * 0.7;
      g.lineStyle(1.5, ink, 0.9);
      g.beginFill(fill, 0.95);
      g.drawRect(og + inner / 2 - tw / 2, og - th * 0.1, tw, th);
      g.endFill();
    } else {
      // Grand citadel: thick walls + 2 side towers + tall keep
      const wy = og + inner * 0.28;
      const wh = inner * 0.60;
      g.beginFill(fill, 0.80);
      g.drawRect(og, wy, inner, wh);
      g.endFill();
      g.lineStyle(2, ink, 0.95);
      g.drawRect(og, wy, inner, wh);
      // Side towers
      const stW = inner * 0.22, stH = inner * 0.55;
      g.beginFill(fill, 0.92);
      g.drawRect(og - stW * 0.3, wy - stH * 0.15, stW, stH);
      g.drawRect(og + inner - stW * 0.7, wy - stH * 0.15, stW, stH);
      g.endFill();
      // Central keep (tallest)
      const kw = inner * 0.32, kh = inner * 0.85;
      g.beginFill(fill, 0.98);
      g.drawRect(og + inner / 2 - kw / 2, og - kh * 0.1, kw, kh);
      g.endFill();
      g.lineStyle(2, ink, 0.95);
      g.drawRect(og + inner / 2 - kw / 2, og - kh * 0.1, kw, kh);
      // Flag on top
      g.lineStyle(1, ink, 0.9);
      const flagX = og + inner / 2;
      const flagY = og - kh * 0.1;
      g.moveTo(flagX, flagY); g.lineTo(flagX, flagY - kh * 0.2);
      g.beginFill(ink, 0.85);
      g.moveTo(flagX, flagY - kh * 0.2);
      g.lineTo(flagX + inner * 0.12, flagY - kh * 0.14);
      g.lineTo(flagX, flagY - kh * 0.08);
      g.closePath();
      g.endFill();
    }
  }

  /**
   * Render resource motif sprites + hand-drawn defense frames onto a tile Graphics.
   *
   * Abundance axis: replicate the same motif sprite — 1 unit at lv1 growing to
   * 4 units at lv10, laid out in pre-defined scatter positions so clusters feel
   * organic rather than grid-aligned.
   *
   * Defense axis (lv4+): pencil-stroke fence outline; lv7+ adds a heavier palisade
   * with arrow-tip markers; lv8–10 gets red danger corner accents.
   *
   * Falls back gracefully to color-only if the atlas hasn't decoded yet.
   */
  private drawResMotif(g: PIXI.Graphics, resType: string, level: number, tp: number, fogged = false): void {
    const lv = Math.max(1, Math.min(10, level));
    // `g`'s local origin is the tile's diamond center (see drawTileL1); scatter
    // fractions below are converted from the old "0..1 across the square" convention
    // to center-relative offsets, with the y-offset flattened (×0.6) to keep sprites
    // from poking past the shallower diamond edges near the tile's left/right tips.
    const toLocal = (fx: number, fy: number): [number, number] => [(fx - 0.5) * tp, (fy - 0.5) * tp * 0.6];

    // Outside vision: reveal the resource TYPE only — a single dimmed motif, no
    // abundance count / defense frames / danger accents (those encode level detail,
    // which §18 keeps hidden under fog, same as the level dot).
    if (fogged) {
      if (!isResAtlasReady()) { this.drawResMotifFallback(g, resType, 1, tp); return; }
      const ftex = getResTexture(resType);
      if (!ftex) return;
      const sp = new PIXI.Sprite(ftex);
      sp.anchor.set(0.5, 0.5);
      sp.scale.set((tp * 0.34) / Math.max(ftex.width, ftex.height));
      sp.alpha = 0.35;
      [sp.x, sp.y] = toLocal(0.5, 0.52);
      g.addChild(sp);
      return;
    }

    const v = diamondVertices(tp - 1);
    const edgeMid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    // ── Defense frames (drawn first so motif sprites sit on top) ──────────────
    if (lv >= 4) {
      const heavy = lv >= 7;
      const lw = heavy ? 1.5 : 0.9;
      const alpha = heavy ? 0.7 : 0.45;
      g.lineStyle(lw, 0x3a2a18, alpha);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: Math.min(0.35, 6 / tp) }));
      g.endFill();

      if (heavy) {
        // Tick marks at each diamond edge's midpoint, poking outward (stylised palisade stakes).
        const tk = 4;
        g.lineStyle(1.2, 0x3a2a18, 0.65);
        const edges: [[number, number], [number, number]][] = [
          [v.top, v.right], [v.right, v.bottom], [v.bottom, v.left], [v.left, v.top],
        ];
        for (const [a, b] of edges) {
          const mid = edgeMid(a, b);
          const len = Math.hypot(mid[0], mid[1]) || 1;
          const outX = mid[0] + (mid[0] / len) * tk;
          const outY = mid[1] + (mid[1] / len) * tk;
          g.moveTo(mid[0], mid[1]); g.lineTo(outX, outY);
        }
      }
    }

    // Red danger corner accents for high-level defended tiles (lv8–10) — traced
    // along the two edges meeting at each diamond vertex.
    if (lv >= 8) {
      const cs = 6;
      g.lineStyle(1.5, 0xcc3333, 0.75);
      const corners: [[number, number], [number, number], [number, number]][] = [
        [v.left, v.top, v.right], [v.top, v.right, v.bottom], [v.right, v.bottom, v.left], [v.bottom, v.left, v.top],
      ];
      for (const [prev, vert, next] of corners) {
        const d1 = Math.hypot(prev[0] - vert[0], prev[1] - vert[1]) || 1;
        const d2 = Math.hypot(next[0] - vert[0], next[1] - vert[1]) || 1;
        const p1: [number, number] = [vert[0] + ((prev[0] - vert[0]) / d1) * cs, vert[1] + ((prev[1] - vert[1]) / d1) * cs];
        const p2: [number, number] = [vert[0] + ((next[0] - vert[0]) / d2) * cs, vert[1] + ((next[1] - vert[1]) / d2) * cs];
        g.moveTo(p1[0], p1[1]); g.lineTo(vert[0], vert[1]); g.lineTo(p2[0], p2[1]);
      }
    }

    // ── Motif sprites (programmatic fallback when atlas not ready) ────────────
    if (!isResAtlasReady()) {
      this.drawResMotifFallback(g, resType, lv, tp);
      return;
    }
    const tex = getResTexture(resType);
    if (!tex) return;

    // Abundance: number of sprite instances keyed by level band.
    const count = lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4;

    // Pre-defined scatter positions (fraction of tp) for up to 4 sprites.
    // Chosen to look organic and avoid overlapping the level-dot corner (top-right).
    const POSITIONS: [number, number][] = [
      [0.5,  0.52],   // 1 sprite: centred, slightly low
      [0.32, 0.38], [0.65, 0.6],   // 2 sprites: upper-left + lower-right
      [0.32, 0.35], [0.65, 0.35], [0.48, 0.65],  // 3 sprites: triangle
      [0.28, 0.33], [0.62, 0.33], [0.28, 0.65], [0.65, 0.65], // 4 sprites: 2×2
    ];
    const offsets = POSITIONS.slice(
      count === 1 ? 0 : count === 2 ? 1 : count === 3 ? 3 : 6,
      count === 1 ? 1 : count === 2 ? 3 : count === 3 ? 6 : 10,
    );

    // Scale each sprite so the long edge is ~30% of the tile, shrinking slightly
    // for higher counts to prevent overcrowding.
    const targetPx = tp * (count <= 1 ? 0.34 : count === 2 ? 0.29 : 0.26);
    const scale = targetPx / Math.max(tex.width, tex.height);

    const alpha = lv <= 3 ? 0.6 : lv <= 6 ? 0.72 : lv <= 9 ? 0.82 : 0.92;

    for (const [fx, fy] of offsets) {
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5, 0.5);
      sp.scale.set(scale);
      sp.alpha = alpha;
      [sp.x, sp.y] = toLocal(fx, fy);
      g.addChild(sp);
    }
  }

  /** Programmatic fallback icon when res_atlas is not yet loaded. Draws a small stationery-themed shape. */
  private drawResMotifFallback(g: PIXI.Graphics, resType: string, lv: number, tp: number): void {
    const count = lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4;
    const alpha = lv <= 3 ? 0.55 : lv <= 6 ? 0.68 : lv <= 9 ? 0.80 : 0.90;
    const POSITIONS: [number, number][] = [
      [0.50, 0.52],
      [0.32, 0.38], [0.65, 0.60],
      [0.32, 0.35], [0.65, 0.35], [0.48, 0.65],
      [0.28, 0.33], [0.62, 0.33], [0.28, 0.65], [0.65, 0.65],
    ];
    const offsets = POSITIONS.slice(
      count === 1 ? 0 : count === 2 ? 1 : count === 3 ? 3 : 6,
      count === 1 ? 1 : count === 2 ? 3 : count === 3 ? 6 : 10,
    );
    const r = tp * (count <= 1 ? 0.12 : 0.10);
    // Center-relative, y flattened to match drawResMotif's diamond-safe scatter (`g`'s
    // local origin is the tile's diamond center, not the old square's top-left corner).
    for (const [fx, fy] of offsets) {
      const cx = (fx - 0.5) * tp, cy = (fy - 0.5) * tp * 0.6;
      g.lineStyle(0);
      if (resType === 'ink') {
        // Ink drop: teardrop shape
        g.beginFill(0x3355aa, alpha);
        g.drawEllipse(cx, cy + r * 0.2, r * 0.65, r * 0.85);
        g.endFill();
        g.beginFill(0x3355aa, alpha);
        g.moveTo(cx, cy - r * 0.9);
        g.lineTo(cx - r * 0.45, cy - r * 0.05);
        g.lineTo(cx + r * 0.45, cy - r * 0.05);
        g.closePath();
        g.endFill();
      } else if (resType === 'paper') {
        // Paper: small rectangle with folded corner
        g.lineStyle(0.8, 0x4477bb, alpha);
        g.beginFill(0xf0ecdd, alpha * 0.9);
        g.drawRect(cx - r * 0.7, cy - r * 0.85, r * 1.4, r * 1.7);
        g.endFill();
        g.lineStyle(0.6, 0x4477bb, alpha * 0.7);
        g.moveTo(cx - r * 0.3, cy - r * 0.85);
        g.lineTo(cx - r * 0.3, cy - r * 0.35);
        g.moveTo(cx - r * 0.3, cy - r * 0.15);
        g.lineTo(cx - r * 0.3, cy + r * 0.55);
        g.lineStyle(0);
      } else if (resType === 'graphite') {
        // Graphite/pencil: elongated hexagon
        g.beginFill(0x778899, alpha);
        g.moveTo(cx, cy - r);
        g.lineTo(cx + r * 0.5, cy - r * 0.5);
        g.lineTo(cx + r * 0.5, cy + r * 0.6);
        g.lineTo(cx, cy + r);
        g.lineTo(cx - r * 0.5, cy + r * 0.6);
        g.lineTo(cx - r * 0.5, cy - r * 0.5);
        g.closePath();
        g.endFill();
        g.beginFill(0xccaa44, alpha);
        g.moveTo(cx - r * 0.5, cy + r * 0.6);
        g.lineTo(cx + r * 0.5, cy + r * 0.6);
        g.lineTo(cx, cy + r);
        g.closePath();
        g.endFill();
      } else if (resType === 'metal') {
        // Metal: bolt head (circle) + shaft
        g.beginFill(0x889966, alpha);
        g.drawCircle(cx, cy - r * 0.3, r * 0.6);
        g.endFill();
        g.beginFill(0x778855, alpha);
        g.drawRect(cx - r * 0.22, cy + r * 0.2, r * 0.44, r * 0.8);
        g.endFill();
      } else {
        // sticker / default: 5-point star
        g.beginFill(0xcc9922, alpha);
        const pts = 5;
        const outer = r * 0.9, inner = r * 0.4;
        const startAngle = -Math.PI / 2;
        for (let i = 0; i < pts * 2; i++) {
          const angle = startAngle + (i * Math.PI) / pts;
          const rad = i % 2 === 0 ? outer : inner;
          if (i === 0) g.moveTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
          else g.lineTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
        }
        g.closePath();
        g.endFill();
      }
    }
  }

  /** L2 medium tile: calm terrain fill + ownership wash/border (no motifs at this zoom) + fog. */
  private drawTileL2(g: PIXI.Graphics, fill: number, owner: number | null, fogged: boolean, tp: number): void {
    g.lineStyle(0);
    g.beginFill(fill, 0.85);
    g.drawPolygon(diamondPath(tp - 1));
    g.endFill();
    if (owner != null && !fogged) {
      // No motif carries the signal at medium zoom, so ownership uses a stronger wash + border
      // to keep the territory map readable while terrain stays visible underneath.
      g.beginFill(owner, 0.42);
      g.drawPolygon(diamondPath(tp - 1));
      g.endFill();
      g.lineStyle(1.4, owner, 0.85);
      g.beginFill(0, 0);
      g.drawPolygon(diamondPath(tp - 1, { inset: 1.6 / tp }));
      g.endFill();
    }
    if (fogged) {
      g.lineStyle(0);
      g.beginFill(FOG_COLOR, 0.38);
      g.drawPolygon(diamondPath(tp - 1));
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
    const b = visibleTileBounds(w, mapH, panX, panY, tp);

    // Group tiles by fill color for batched rendering (coords = each tile's diamond center).
    const groups = new Map<number, number[]>(); // color → [cx,cy, cx,cy, ...]
    for (let ty = Math.max(0, b.minTy); ty <= Math.min(this.mapH - 1, b.maxTy); ty++) {
      for (let tx = Math.max(0, b.minTx); tx <= Math.min(this.mapW - 1, b.maxTx); tx++) {
        const tile = this.tileCache.get(`${tx}:${ty}`);
        let color = tile ? tileColor(tile) : proceduralTileColor(this.cb.worldId, tx, ty);
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

  // ── Overlay (march arrows, capitals, selected tile) ────────────────────────
  // Drawn into a separate Graphics above the tile pool. Fast to redraw (~few dozen objects).

  private renderOverlay(): void {
    const g = this.overlayGfx;
    g.clear();
    const tp = this.tp;

    // Selected tile highlight — diamond outline centered on the tile (was a square
    // anchored at its top-left corner; tileToScreen gives the diamond center instead).
    if (this.selectedTile) {
      const { x: tx, y: ty } = this.selectedTile;
      const s = tileToScreen(tx, ty, tp);
      const cx = this.panX + s.x;
      const cy = this.panY + s.y;
      const pts = diamondPath(tp).map((v, i) => v + (i % 2 === 0 ? cx : cy));
      g.lineStyle(2, 0xffcc00, 1);
      g.beginFill(0xffff00, 0.15);
      g.drawPolygon(pts);
      g.endFill();
    }

    // Capital star markers (10 nations).
    const starR = Math.max(6, tp * 0.45);
    for (const n of this.nations) {
      const s = tileToScreen(n.x, n.y, tp);
      const cx = this.panX + s.x;
      const cy = this.panY + s.y;
      if (cx < -tp || cy < -tp || cx > this.w + tp || cy > this.h - HUD_H + tp) continue;
      this.drawStar(g, cx, cy, starR, n.ownerId ? 0xffcc00 : 0xccb890, !!n.ownerId);
    }

    // March arrows (L1/L2 only; L3 is too zoomed-out for detail).
    if (this.zoom < 3) {
      for (const march of this.marches) {
        const fromXY = this.parseTileStrict(march.fromTile);
        const toXY = this.parseTileStrict(march.toTile);
        if (!fromXY || !toXY) continue; // skip malformed/out-of-bounds endpoints (no origin-crossing stray line)
        const [fx, fy] = fromXY;
        const [tx2, ty2] = toXY;
        const from = tileToScreen(fx, fy, tp);
        const to = tileToScreen(tx2, ty2, tp);
        const fpx = this.panX + from.x;
        const fpy = this.panY + from.y;
        const px  = this.panX + to.x;
        const py  = this.panY + to.y;
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
    const backW = 88, backH = 34;
    const backBtn = sketchPanel(backW, backH, { fill: C.dark, border: C.accent, seed: seedFor(5, 3, backW) });
    backBtn.x = 8; backBtn.y = h - HUD_H + 8;
    hud.addChild(backBtn);
    const backLbl = txt(t('world.back'), 13, C.light);
    backLbl.anchor.set(0.5, 0.5);
    backLbl.x = backBtn.x + backW / 2; backLbl.y = backBtn.y + backH / 2;
    hud.addChild(backLbl);
    this.backRect = { x: backBtn.x, y: backBtn.y, w: backW, h: backH };

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

      let ix = 106;
      for (const info of infos) {
        const lbl = txt(info, 11, C.dark);
        lbl.x = ix; lbl.y = h - HUD_H + 18;
        hud.addChild(lbl);
        ix += lbl.width + 14;
      }
    }

    // Active marches panel — own marches only
    // (G5: this.marches may also hold in-vision enemy marches, which can't be recalled).
    this.marchRowRects = [];
    const myMarches = this.marches.filter((m) => m.mine !== false);
    const MARCH_PANEL_X = 8;
    const MARCH_ROW_H = 22;
    const RECALL_W = 50;
    // Section header always visible when player has joined
    if (this.me?.joined) {
      const headerTxt = myMarches.length > 0
        ? `${t('world.marchList')} (${myMarches.length})`
        : t('world.marchList');
      const marchHeader = txt(headerTxt, 10, C.mid);
      marchHeader.x = MARCH_PANEL_X; marchHeader.y = h - HUD_H + 52;
      hud.addChild(marchHeader);
    }
    if (myMarches.length > 0) {
      const now = Date.now();
      const ROW_Y0 = h - HUD_H + 68;
      for (let i = 0; i < myMarches.length; i++) {
        const m = myMarches[i];
        const [tx, ty] = this.parseTileId(m.toTile);
        const remaining = Math.max(0, Math.ceil((m.arriveAt - now) / 1000));
        const kindIcon = m.kind === 'attack' ? '⚔' : m.kind === 'reinforce' ? '🛡' : m.kind === 'scout' ? '🔭' : m.kind === 'return' ? '↩' : '→';
        const rowY = ROW_Y0 + i * MARCH_ROW_H;
        const rowLbl = txt(`${kindIcon} (${tx},${ty})  ${remaining}s`, 11, C.dark);
        rowLbl.x = MARCH_PANEL_X; rowLbl.y = rowY + 2;
        hud.addChild(rowLbl);

        // Recall button (only for non-return marches)
        if (m.kind !== 'return') {
          const recallBtn = sketchPanel(RECALL_W, 18, { fill: C.accent, border: C.red, seed: seedFor(i, 99, RECALL_W) });
          recallBtn.x = MARCH_PANEL_X + 140; recallBtn.y = rowY + 1;
          hud.addChild(recallBtn);
          const recallLbl = txt(t('world.recall'), 10, C.light);
          recallLbl.anchor.set(0.5, 0.5);
          recallLbl.x = recallBtn.x + RECALL_W / 2; recallLbl.y = recallBtn.y + 9;
          hud.addChild(recallLbl);
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: { x: recallBtn.x, y: recallBtn.y, w: RECALL_W, h: 18 },
          });
        } else {
          this.marchRowRects.push({
            marchId: m.marchId,
            worldId: m.toTile.split(':')[2] ?? '',
            destX: tx, destY: ty,
            rowRect: { x: MARCH_PANEL_X, y: rowY, w: 140, h: MARCH_ROW_H },
            recallRect: null,
          });
        }
      }
    }

    // Train / Family / Auction buttons (right side)
    const btnW = 70;

    // Action buttons (right side, vertically centred in HUD)
    const btnH = 36;
    const btnY = h - HUD_H + (HUD_H - btnH) / 2;

    // Train button — only meaningful once the player has a base.
    if (this.me?.joined) {
      const trainBtn = sketchPanel(btnW, btnH, { fill: C.red, border: C.accent, seed: seedFor(2, 0, btnW) });
      trainBtn.x = w - btnW * 3 - 22; trainBtn.y = btnY;
      hud.addChild(trainBtn);
      const inQ = (this.me.trainingQueue ?? []).reduce((s, e) => s + e.qty, 0);
      const trainLbl = txt(inQ > 0 ? `${t('world.train')} (${inQ})` : t('world.train'), 13, C.light);
      trainLbl.anchor.set(0.5, 0.5);
      trainLbl.x = trainBtn.x + btnW / 2; trainLbl.y = trainBtn.y + btnH / 2;
      hud.addChild(trainLbl);
      this.trainBtnRect = { x: trainBtn.x, y: trainBtn.y, w: btnW, h: btnH };
    } else {
      this.trainBtnRect = { x: 0, y: 0, w: 0, h: 0 };
    }

    const famBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, btnW) });
    famBtn.x = w - btnW * 2 - 14; famBtn.y = btnY;
    hud.addChild(famBtn);
    const famLbl = txt(t('world.family'), 13, C.light);
    famLbl.anchor.set(0.5, 0.5);
    famLbl.x = famBtn.x + btnW / 2; famLbl.y = famBtn.y + btnH / 2;
    hud.addChild(famLbl);
    this.famBtnRect = { x: famBtn.x, y: famBtn.y, w: btnW, h: btnH };

    const aucBtn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, btnW) });
    aucBtn.x = w - btnW - 6; aucBtn.y = btnY;
    hud.addChild(aucBtn);
    const aucLbl = txt(t('world.auction'), 13, C.light);
    aucLbl.anchor.set(0.5, 0.5);
    aucLbl.x = aucBtn.x + btnW / 2; aucLbl.y = aucBtn.y + btnH / 2;
    hud.addChild(aucLbl);
    this.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: btnW, h: btnH };

    // World info button — floats top-right over the map (nations / season / shop).
    const infoW = 76, infoH = 34;
    const infoBtn = sketchPanel(infoW, infoH, { fill: C.dark, border: C.accent, seed: seedFor(3, 1, infoW) });
    infoBtn.x = w - infoW - 8; infoBtn.y = 8;
    hud.addChild(infoBtn);
    const infoLbl = txt(t('world.info'), 13, C.light);
    infoLbl.anchor.set(0.5, 0.5);
    infoLbl.x = infoBtn.x + infoW / 2; infoLbl.y = infoBtn.y + infoH / 2;
    hud.addChild(infoLbl);
    this.infoBtnRect = { x: infoBtn.x, y: infoBtn.y, w: infoW, h: infoH };

    // Zoom cycle button — top-left over the map, cycles L1→L2→L3→L1.
    const zoomLabels: Record<number, string> = { 1: '×1', 2: '×2', 3: '×3' };
    const zoomW = 76, zoomH = 34;
    const zoomBtn = sketchPanel(zoomW, zoomH, { fill: C.dark, border: C.accent, seed: seedFor(4, 2, zoomW) });
    zoomBtn.x = 8; zoomBtn.y = 8;
    hud.addChild(zoomBtn);
    const zoomLbl = txt(`🔍 ${zoomLabels[this.zoom] ?? ''}`, 13, C.light);
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
        // Main city — enter desk / defense / teams.
        this.showModal(
          [t('world.myBase'), `(${tx}, ${ty})`],
          [
            { label: t('world.actEnterCity'), action: () => { this.closeModal(); this.cb.onOpenCity(); } },
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
      const enemyHead = [t('world.enemyTile'), ownerLine, `(${tx}, ${ty})`];
      if (tile.maxHp && tile.hp != null) enemyHead.push(t('world.buildingHp').replace('{hp}', String(tile.hp)).replace('{max}', String(tile.maxHp)));
      this.showModal(enemyHead, buttons);
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
        ALLY_TILE:     t('world.err.allyTile'),
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
    const s = tileToScreen(tx, ty, tp);
    this.panX = this.w / 2 - s.x;
    this.panY = (this.h - HUD_H) / 2 - s.y;
    this.clampPan();
  }

  /**
   * Isometric pan bounds. The map's four corners (0,0)/(mapW,0)/(0,mapH)/(mapW,mapH)
   * project to a diamond in screen space whose axis-aligned bounding box is what pan
   * must stay within (plus a small buffer) — replaces the old orthogonal `mapW*tp`
   * bound, which under-constrained panning once tiles stopped being axis-aligned squares.
   */
  private clampPan(): void {
    const tp = this.tp;
    const corners = [
      tileToScreen(0, 0, tp), tileToScreen(this.mapW, 0, tp),
      tileToScreen(0, this.mapH, tp), tileToScreen(this.mapW, this.mapH, tp),
    ];
    const minSx = Math.min(...corners.map((c) => c.x));
    const maxSx = Math.max(...corners.map((c) => c.x));
    const minSy = Math.min(...corners.map((c) => c.y));
    const maxSy = Math.max(...corners.map((c) => c.y));
    const buf = tp * 2;
    const maxX = -minSx + buf;
    const minX = this.w - maxSx - buf;
    const maxY = -minSy + buf;
    const minY = (this.h - HUD_H) - maxSy - buf;
    this.panX = Math.min(maxX, Math.max(minX, this.panX));
    this.panY = Math.min(maxY, Math.max(minY, this.panY));
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } {
    return screenToTile(sx - this.panX, sy - this.panY, this.tp);
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
    // Spin the loading ring while the first-paint cover is up.
    if (this.loadingSpinner) {
      this.loadingAngle += dt * 4;
      this.loadingSpinner.rotation = this.loadingAngle;
    }
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
    if (this.loadingTimeout) { clearTimeout(this.loadingTimeout); this.loadingTimeout = null; }
    if (this.marchPoll) { clearInterval(this.marchPoll); this.marchPoll = null; }
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const s of this.pool) s.g.destroy();
    this.pool = [];
    for (const c of this.citySprites.values()) c.destroy({ children: true });
    this.citySprites.clear();
    this.container.destroy({ children: true });
  }
}
