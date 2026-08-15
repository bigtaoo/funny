// WorldMapContext — shared mutable state + collaborator wiring for the world map (MVC split).
// Holds every field the Renderer / Net / Input controllers read & write, so behavior is
// preserved verbatim from the original single-class WorldMapScene.
import * as PIXI from 'pixi.js-legacy';
import { makeZoomCfgs } from './zoom';
import { DEFAULT_MAP_SIZE } from './constants';
import type { ILayout } from '../../layout/ILayout';
import type { ZoomCfg, PoolSlot } from './zoom';
import type { WorldApiClient, WorldTileView, PlayerWorldView, MarchView, OccupationView, StationedView, NationView, SeasonView, SlgShopItemView, WorldChatMessage, SiegeSummaryView } from '../../net/WorldApiClient';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult, NationMsg } from '../../net/proto/transport';
import type { WorldMapRenderer } from './WorldMapRenderer';
import type { WorldMapPanels } from './WorldMapPanels';
import type { WorldMapNet } from './WorldMapNet';
import type { WorldMapInput } from './WorldMapInput';
import type { StickmanRuntime } from '../../render/stickman/StickmanRuntime';
import type { IStorage } from '../../platform/IPlatform';
import type { SaveData } from '../../game/meta/SaveData';
import type { EraseCrumb } from './WorldMapRenderer/loadingReveal';
import { GuideOverlay } from '../../render/GuideOverlay';

/**
 * A live march/occupy/stationed token (fog.ts syncMarchTokens/syncOccupyTokens/syncStationedTokens).
 * 'stickman' renders a full StickmanRuntime skeleton (walk/attack/idle clips; `runtime` is null
 * while the cached-after-first-use .tao asset is still loading). 'dot' (2026-07-26 LOD downgrade,
 * design/game/WORLD_MAP_ART_SPEC.md) is a single lightweight static portrait disc, used once the
 * live token count exceeds STICKMAN_TOKEN_BUDGET (siege-scale march counts) so cost stays O(budget)
 * instead of O(live count) regardless of how many squads are actually in transit/holding/stationed.
 * `kind` is the resolved unit-type key driving asset choice (see fog.ts resolveMarchUnitType) — kept
 * as the same field name across both variants and across march/occupy/stationed for a uniform
 * kind-changed → destroy-and-rebuild check.
 */
/** Family-emblem corner badge riding a map token (family-emblem-art-prompts.md, 2026-08-14) —
 *  its own top-level display object (not a child of the stickman/dot container) so the stickman's
 *  facing-direction mirror flip (see tokens.ts's mirrorX) never mirrors the badge art. `key` lets
 *  syncEmblemBadge tell "same badge, just reposition" from "badge changed, rebuild" without a redraw
 *  every frame. */
export interface MapTokenBadge {
  sprite: PIXI.DisplayObject;
  key: string;
}

export type MapTokenEntry =
  | { mode: 'stickman'; runtime: StickmanRuntime | null; kind: string; badge?: MapTokenBadge }
  | { mode: 'dot'; sprite: PIXI.Container; kind: string; badge?: MapTokenBadge };

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
  worldApi: WorldApiClient;
  worldId: string;
  playerName: string;
  /** current player's accountId — gates capital rename (must own the capital). */
  accountId: string;
  /** live coin balance getter (SaveData.wallet mirror) — shown in the SLG shop. */
  getCoins?: () => number;
  /** Full save snapshot (cardInv/equipmentInv) — the team picker uses it to rank teams by combat power (§ team-picker sort). */
  getSave?: () => SaveData;
  /** Platform storage (IPlatform.storage) — world-chat read-marker persistence must go through this,
   * not the global `localStorage`, so it also works under the WeChat mini-game runtime (no DOM storage). */
  storage: IStorage;
  /** SLG opening guide chain (ONBOARDING_DESIGN §4.2) — thin pass-through to SaveManager.getFlag/setFlag,
   * reusing the existing flags channel (no SaveData schema change) for `guide.world.step{1,4}`.
   * Optional (unlike the rest of the guide plumbing) purely so the many existing WorldMapScene UI
   * test fixtures that predate this feature don't all need updating; production wiring
   * (app/nav/world.ts) always provides both. */
  getFlag?(key: string): boolean;
  setFlag?(key: string, value: boolean): void;
}

/** March kinds the deploy dialog can dispatch (occupy/reinforce/attack/sweep). */
export type DeployKind = 'occupy' | 'reinforce' | 'attack' | 'sweep';

/** Live-push handle returned by showWorldMap — app forwards NetSession pushes here. */
export interface WorldMapView {
  applyMarchUpdate(m: MarchUpdate): void;
  applyTileUpdate(t: TileUpdate): void;
  applyUnderAttack(u: UnderAttack): void;
  applySiegeResult(s: SiegeResult): void;
  applyNationMsg(n: NationMsg): void;
  /** Re-fetch `me` (cardState/troops/resources) — call when an overlay that may have changed it
   * (City/team editor/defense editor/auction) is popped and the map becomes interactive again. */
  refreshMe(): void;
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
  /** Teams stationed on tiles — drives the idle-sprite rendering (fog.ts syncStationedTokens) and the team-picker busy gate.
   * ADR-051 (P4): includes ENEMY stationed teams within vision (mine === false) for field-troop + garrison-zone
   * rendering; own-only consumers (busy gate, recall / in-place-occupy lookups) must filter mine !== false. */
  stationed: StationedView[] = [];
  nations: NationView[] = [];
  season: SeasonView | null = null;
  shopItems: SlgShopItemView[] = [];
  /** Territory Overview panel (SLG_DESIGN_LOG.md §26): opened by tapping the header resource cluster. */
  territoryPanelOpen = false;
  territoryTab: 'overview' | 'list' | 'world' = 'overview';
  /** Full list of owned tiles — fetched lazily (WorldMapNet.refreshTerritories) when the list tab is opened, not on every ~5s poll (can be 200-300 rows). */
  territories: WorldTileView[] = [];
  /** Levels unchecked in the list-tab filter grid; empty = show all levels. */
  territoryHiddenLevels: Set<number> = new Set();
  /** Set while the list tab's Abandon confirm dialog is showing (which tile is pending). */
  territoryAbandonConfirm: { x: number; y: number } | null = null;
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
  /** cacheKey ("x:y" or "node:id") → local-space geometry of an active capital-protection shield
   *  bubble, cached by city.ts refreshCityLayer so lifecycle.update can re-animate it (spin/pulse)
   *  every frame without recomputing sprite layout — otherwise the shield only redraws whenever
   *  something else triggers refreshCityLayer (pan/zoom/poll) and sits visibly frozen the rest of
   *  the time, reading as a flat static overlay rather than an active field (2026-08-08 follow-up:
   *  "现在就叠加了一张图，不太能懂用途是什么"). See WorldMapRenderer/shieldFx.ts. */
  shieldGeom: Map<string, { cx: number; cy: number; rx: number; ry: number; tp: number }> = new Map();
  /** Seconds elapsed, feeds drawShieldDome/drawShieldGlow's rotation/pulse phase — a plain
   *  accumulator (not Date.now()) so shield animation stays deterministic/testable like the rest
   *  of update(dt). */
  shieldAnimT = 0;
  /** cacheKey → one-shot "shield just broke" pop flash in progress (borrowed from daydayup's
   *  shield_break flash, 2026-08-08 follow-up). `age` is seconds since the break was first
   *  observed; lifecycle.update ages it out and deletes the entry past shieldFx.SHIELD_BREAK_LIFE. */
  shieldBreakFx: Map<string, { cx: number; cy: number; rx: number; ry: number; tp: number; age: number }> = new Map();
  fogGfx!: PIXI.Graphics;
  overlayGfx!: PIXI.Graphics;
  /** March walk-cycle sprites, above overlayGfx so they read on top of the route line/arrowhead. */
  marchTokenLayer!: PIXI.Container;
  /** marchId → live token entry riding that march's route (fog.ts syncMarchTokens) — see MapTokenEntry. */
  marchTokenRuntimes: Map<string, MapTokenEntry> = new Map();
  /** marchId → epoch-ms deadline to keep playing the 'attacking' clip after the march has
   * resolved (arrived off `ctx.marches`) instead of tearing its token down instantly (§ occupy
   * attack-animation fix). Populated by WorldMapNet.applySiegeResult, consumed/expired in
   * fog.ts syncMarchTokens. */
  marchAttackUntil: Map<string, number> = new Map();
  /** tile key ("x:y") → live StickmanRuntime playing 'attacking' for the *entire* duration of one of
   * my own occupation holds (ctx.occupations), not just the brief post-arrival beat covered by
   * marchAttackUntil above — the user wants the attack motion to keep repeating for as long as the
   * hold countdown runs, not fire once and vanish. Synced in fog.ts syncOccupyTokens — see MapTokenEntry. */
  occupyTokenRuntimes: Map<string, MapTokenEntry> = new Map();
  /** tile key ("x:y") → live token standing idle on one of my stationed tiles (ctx.stationed).
   * Unlike march/occupy tokens these are NOT torn down on arrival — the team stands there until moved or
   * recalled (2026-07-23 field-stationing). Synced in fog.ts syncStationedTokens — see MapTokenEntry. */
  stationedTokenRuntimes: Map<string, MapTokenEntry> = new Map();
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
  /** Non-null only while the loading cover's eraser-wipe reveal is in flight — see
   *  WorldMapRenderer/loadingReveal.ts. `loadingEraseLayer` is the handed-off paper sheet (masked
   *  by `loadingEraseMask`); `loadingEraseCrumbs` draws the trailing rubber-fleck particles
   *  (state in `loadingEraseCrumbData`, spawn accumulator in `loadingEraseCrumbSpawnAcc`).
   *  `loadingEraseT` is wipe progress, 0 (untouched) → 1 (fully erased). */
  loadingEraseLayer: PIXI.Container | null = null;
  loadingEraseMask: PIXI.Graphics | null = null;
  loadingEraseCrumbs: PIXI.Graphics | null = null;
  loadingEraseCrumbData: EraseCrumb[] = [];
  loadingEraseCrumbSpawnAcc = 0;
  loadingEraseT = 0;
  /** Screen-edge red vignette (D-CITY-8): flashed when the player's own main-base durability is
   * deducted by a settled siege hit. Mirrors the battle scene's base-damage vignette (GameRenderer/events.ts). */
  vignetteGfx!: PIXI.Graphics;
  vignetteAlpha = 0;
  loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  selectedTile: { x: number; y: number } | null = null;
  toastTimer = 0;
  /** Accumulates update() dt; drives the once-per-second HUD countdown refresh (P1-1) — march/siege
   *  remaining-time text previously only advanced on the ~5s poll tick or an incoming push, so it sat
   *  visibly frozen in between. Runs independently of push arrivals: this only repaints existing
   *  state, it never fetches (the poll itself was removed in P1-2 — see WorldMapNet.start()). */
  hudTickTimer = 0;
  destroyed = false;
  readonly unsubs: (() => void)[] = [];
  /** Marches badge (top-right stack) toggles between collapsed count and the full expanded list (§25). */
  marchesExpanded = false;
  backRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  aucBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  /** Header-bar "Shop" entry (left of the auction button) — opens the standalone shop panel. */
  shopBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  /** Header-bar "Home" entry (left of the shop button) — recenters the camera on the player's own base. */
  homeBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  zoomBtnRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  marchBadgeRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  /** Top-right "battle replays" badge (below the marches badge) — tapping it opens the last-100 replay browser. */
  replayBadgeRect: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 };
  /** Whether the replay-browser list modal is open. */
  replayPanelOpen = false;
  /** Cached recent siege reports (fetched when the replay browser opens). */
  sieges: SiegeSummaryView[] = [];
  /** Whether the standalone Shop panel (item-card catalog) is open — opened from the header shopBtnRect. */
  shopPanelOpen = false;
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
    /** 2026-08-01 (SLG_DESIGN_LOG §46): "pay coins, instantly complete" button — only present on kind==='return' rows. */
    instantReturnRect: { x: number; y: number; w: number; h: number } | null;
  }[] = [];

  // ── Modal ──────────────────────────────────────────────────────────────────
  modalBtnRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalDimRect: { x: number; y: number; w: number; h: number } | null = null;

  // ── Info-panel list scroll (Territory Overview list/world tabs — see WorldMapPanels.renderTerritoryPanel) ──
  /** Viewport rect of the scrollable list body; null when no scrollable list is on screen. */
  infoScrollRect: { x: number; y: number; w: number; h: number } | null = null;
  infoScrollY = 0;
  infoMaxScroll = 0;
  infoScrollDragging = false;
  infoScrollDragMoved = false;
  infoScrollDragStartY = 0;
  infoScrollDragStartScroll = 0;
  /**
   * A button tap that started inside the scrollable list, captured at pointer-down and deferred to
   * pointer-up — fired only if the pointer never dragged past the threshold. Without this, a drag
   * starting on an in-list Buy/Rename button fired it instead of scrolling the list.
   */
  infoScrollPendingTap: (() => void) | null = null;
  /** Which panel's scroll list is currently active — WorldMapInput calls this instead of hardcoding a render method, so any modal hosting a beginScrollList region re-renders correctly. Set by beginScrollList, cleared by closeModal. */
  infoScrollRerender: (() => void) | null = null;

  // ── SLG opening guide chain (ONBOARDING_DESIGN §4.2) ─────────────────────────
  /** Non-null while step1 ("tap your main city") is actively highlighted; cleared once the base tile is tapped (WorldMapInput.onTileClick) or skipped. step4 (the closing "occupy nearby land" tip) has no ring/step state of its own — lifecycle.update derives it straight from flags. */
  guideStep: 'step1' | null = null;
  /** Mounted once in WorldMapRenderer/build.ts, right after the vignette layer — the topmost persistent child of `container`, so it survives every pool/city-layer/HUD refresh and never needs rebuilding. */
  guide!: GuideOverlay;

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
    const raw = this.cb.storage.getItem(this.worldChatSeenKey());
    return raw ? Number(raw) || 0 : 0;
  }

  /** Marks all currently-fetched chat as read (called when the player opens the chat overlay). */
  markWorldChatSeen(): void {
    const ts = this.worldChatLatest?.ts ?? Date.now();
    this.cb.storage.setItem(this.worldChatSeenKey(), String(ts));
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
