// WorldMapContext — shared mutable state + collaborator wiring for the world map (MVC split).
// Holds every field the Renderer / Net / Input controllers read & write, so behavior is
// preserved verbatim from the original single-class WorldMapScene.
import * as PIXI from 'pixi.js-legacy';
import { makeZoomCfgs } from './zoom';
import { DEFAULT_MAP_SIZE } from './constants';
import type { ILayout } from '../../layout/ILayout';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, OccupationView, NationView, SeasonView, SlgShopItemView, WorldChatMessage } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult } from '../../net/proto/transport';
import type { WorldMapRenderer } from './WorldMapRenderer';
import type { WorldMapPanels } from './WorldMapPanels';
import type { WorldMapNet } from './WorldMapNet';
import type { WorldMapInput } from './WorldMapInput';
import type { StickmanRuntime } from '../../render/stickman/StickmanRuntime';

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
  /** Own active occupation-holds (2026-07-15) — used alongside marches for the team-picker busy gate. */
  occupations: OccupationView[] = [];
  nations: NationView[] = [];
  season: SeasonView | null = null;
  shopItems: SlgShopItemView[] = [];
  infoTab: 'nations' | 'season' | 'shop' = 'nations';
  /** Territory Overview panel (SLG_DESIGN.md §26): opened by tapping the header resource cluster. */
  territoryPanelOpen = false;
  territoryTab: 'overview' | 'list' = 'overview';
  /** Full list of owned tiles — fetched lazily (WorldMapNet.refreshTerritories) when the list tab is opened, not on every ~5s poll (can be 200-300 rows). */
  territories: WorldTileView[] = [];
  /** Levels unchecked in the list-tab filter grid; empty = show all levels. */
  territoryHiddenLevels: Set<number> = new Set();
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
  /** March walk-cycle sprites, above overlayGfx so they read on top of the route line/arrowhead. */
  marchTokenLayer!: PIXI.Container;
  /** marchId → live StickmanRuntime riding that march's route (fog.ts syncMarchTokens). `runtime` is
   * null while the (cached-after-first-use) .tao asset is still loading. */
  marchTokenRuntimes: Map<string, { runtime: StickmanRuntime | null; kind: string }> = new Map();
  /** marchId → epoch-ms deadline to keep playing the 'attacking' clip after the march has
   * resolved (arrived off `ctx.marches`) instead of tearing its token down instantly (§ occupy
   * attack-animation fix). Populated by WorldMapNet.applySiegeResult, consumed/expired in
   * fog.ts syncMarchTokens. */
  marchAttackUntil: Map<string, number> = new Map();
  hudLayer!: PIXI.Container;
  /** Title bar + back button — static, drawn once (unlike hudLayer, which is torn down on every ~5s march-poll re-render). */
  topLayer!: PIXI.Container;
  /** Resource-production readout + auction button drawn on top of the header bar; torn down/rebuilt alongside hudLayer so production rates stay live. Sits above topLayer (added after it) so it isn't hidden by the header chrome. */
  headerHudLayer!: PIXI.Container;
  /** Header bar height (SceneHeader, unified with every other scene) — the map viewport and top-anchored HUD reserve this much space. Set once in build(). */
  topInset = 0;
  modalLayer!: PIXI.Container;
  toastLayer!: PIXI.Container;
  loadingLayer: PIXI.Container | null = null;
  loadingSpinner: PIXI.Graphics | null = null;
  loadingAngle = 0;
  /** Screen-edge red vignette (D-CITY-8): flashed when the player's own main-base durability is
   * deducted by a settled siege hit. Mirrors the battle scene's base-damage vignette (GameRenderer/events.ts). */
  vignetteGfx!: PIXI.Graphics;
  vignetteAlpha = 0;
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
  /** Header-bar resource production cluster (renderHeaderHud) — tapping it opens the Territory Overview panel. */
  resClusterRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  /** Latest world-chat message, polled alongside marches (§25 follow-up) — null until first fetch. */
  worldChatLatest: WorldChatMessage | null = null;
  /** Count of fetched messages newer than the local "last seen" mark; capped by refreshWorldChat's page size. */
  worldChatUnread = 0;
  marchRowRects: {
    marchId: string; worldId: string; destX: number; destY: number;
    rowRect: { x: number; y: number; w: number; h: number };
    recallRect: { x: number; y: number; w: number; h: number } | null;
  }[] = [];

  // ── Modal ──────────────────────────────────────────────────────────────────
  modalBtnRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalDimRect: { x: number; y: number; w: number; h: number } | null = null;

  // ── Info-panel list scroll (nations / shop tabs — see WorldMapPanels.renderInfoPanel) ──
  /** Viewport rect of the scrollable list body; null when no scrollable list is on screen. */
  infoScrollRect: { x: number; y: number; w: number; h: number } | null = null;
  infoScrollY = 0;
  infoMaxScroll = 0;
  infoScrollDragging = false;
  infoScrollDragMoved = false;
  infoScrollDragStartY = 0;
  infoScrollDragStartScroll = 0;
  /** Which panel's scroll list is currently active — WorldMapInput calls this instead of hardcoding renderInfoPanel, so any modal (world-info, Territory Overview) can host a beginScrollList region. Set by beginScrollList, cleared by closeModal. */
  infoScrollRerender: (() => void) | null = null;

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

  /** localStorage key for "last seen world-chat ts" — per world+account, so alts don't share a read marker. */
  private worldChatSeenKey(): string {
    return `nw_worldchat_seen_${this.cb.worldId}_${this.cb.accountId}`;
  }

  getWorldChatSeenTs(): number {
    const raw = localStorage.getItem(this.worldChatSeenKey());
    return raw ? Number(raw) || 0 : 0;
  }

  /** Marks all currently-fetched chat as read (called when the player opens the chat overlay). */
  markWorldChatSeen(): void {
    const ts = this.worldChatLatest?.ts ?? Date.now();
    localStorage.setItem(this.worldChatSeenKey(), String(ts));
    this.worldChatUnread = 0;
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
