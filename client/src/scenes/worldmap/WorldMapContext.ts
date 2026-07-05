// WorldMapContext — shared mutable state + collaborator wiring for the world map (MVC split).
// Holds every field the Renderer / Net / Input controllers read & write, so behavior is
// preserved verbatim from the original single-class WorldMapScene.
import * as PIXI from 'pixi.js-legacy';
import { makeZoomCfgs } from './zoom';
import { DEFAULT_MAP_SIZE } from './constants';
import type { ILayout } from '../../layout/ILayout';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, NationView, SeasonView, SlgShopItemView } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../../net/proto/transport';
import type { WorldMapRenderer } from './WorldMapRenderer';
import type { WorldMapPanels } from './WorldMapPanels';
import type { WorldMapNet } from './WorldMapNet';
import type { WorldMapInput } from './WorldMapInput';

// ── Public callbacks ────────────────────────────────────────────────────────
export interface WorldMapCallbacks {
  onBack(): void;
  /** Open the social/chat overlay (FriendsScene, world channel tab) — also the entry point to family management (§25). */
  onOpenChat(): void;
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
export type DeployKind = 'occupy' | 'reinforce' | 'attack' | 'sweep' | 'scout';

/** Live-push handle returned by showWorldMap — app forwards NetSession pushes here. */
export interface WorldMapView {
  applyMarchUpdate(m: MarchUpdate): void;
  applyTileUpdate(t: TileUpdate): void;
  applyUnderAttack(u: UnderAttack): void;
  applySiegeResult(s: SiegeResult): void;
}

export class WorldMapContext {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: WorldMapCallbacks;
  panX = 0;
  panY = 0;
  dragStartX = 0;
  dragStartY = 0;
  dragging = false;
  dragMoved = false;
  mapW = DEFAULT_MAP_SIZE;
  mapH = DEFAULT_MAP_SIZE;
  tileCache: Map<string, WorldTileView> = new Map();
  me: PlayerWorldView | null = null;
  marches: MarchView[] = [];
  nations: NationView[] = [];
  season: SeasonView | null = null;
  shopItems: SlgShopItemView[] = [];
  infoTab: 'nations' | 'season' | 'shop' = 'nations';
  hiddenInput: HTMLInputElement | null = null;
  zoom: 1 | 2 | 3 = 1;
  zoomCfgs!: [ZoomCfg, ZoomCfg, ZoomCfg];
  get zc(): ZoomCfg { return this.zoomCfgs[this.zoom - 1]; }
  get tp(): number  { return this.zc.tile; }   // current TILE_PX
  pool: PoolSlot[] = [];
  poolContainer!: PIXI.Container;
  mapGfxL3!: PIXI.Graphics;
  l3Dirty = false;
  cityLayer!: PIXI.Container;
  citySprites: Map<string, PIXI.Container> = new Map();
  fogGfx!: PIXI.Graphics;
  overlayGfx!: PIXI.Graphics;
  hudLayer!: PIXI.Container;
  /** Top-left floating back button — static, drawn once (unlike hudLayer, which is torn down on every ~5s march-poll re-render). */
  topLayer!: PIXI.Container;
  modalLayer!: PIXI.Container;
  toastLayer!: PIXI.Container;
  loadingLayer: PIXI.Container | null = null;
  loadingSpinner: PIXI.Graphics | null = null;
  loadingAngle = 0;
  loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  selectedTile: { x: number; y: number } | null = null;
  myAttackTiles: Set<string> = new Set();
  toastTimer = 0;
  destroyed = false;
  trainPanelOpen = false;
  panelRepaint = 0;
  marchPoll: ReturnType<typeof setInterval> | null = null;
  readonly unsubs: (() => void)[] = [];
  /** Marches badge (top-right stack) toggles between collapsed count and the full expanded list (§25). */
  marchesExpanded = false;
  backRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  aucBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  infoBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  zoomBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  marchBadgeRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  chatBarRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  marchRowRects: {
    marchId: string; worldId: string; destX: number; destY: number;
    rowRect: { x: number; y: number; w: number; h: number };
    recallRect: { x: number; y: number; w: number; h: number } | null;
  }[] = [];

  // ── Modal ──────────────────────────────────────────────────────────────────
  modalBtnRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalDimRect: { x: number; y: number; w: number; h: number } | null = null;

  // Collaborators (assigned by WorldMapScene right after construction).
  view!: WorldMapRenderer;
  panels!: WorldMapPanels;
  net!: WorldMapNet;
  input!: WorldMapInput;

  constructor(layout: ILayout, cb: WorldMapCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.zoomCfgs = makeZoomCfgs(this.w, this.h);
    this.container = new PIXI.Container();
  }

  parseTileId(tileId: string): [number, number] {
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

  parseTileStrict(tileId: string | undefined | null): [number, number] | null {
    if (!tileId) return null;
    const parts = tileId.split(':');
    if (parts.length < 2) return null;
    const x = Number(parts[parts.length - 2]);
    const y = Number(parts[parts.length - 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return null;
    return [x, y];
  }
}
