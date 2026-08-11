// Shared foundation for the CityScene composition (see ../CityScene.ts assembly).
//
// CitySceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.me, this.core.teams, this.core.hits, …) + the
// input/scroll plumbing, resource-total simulation (setMe/liveResource/tickResourceTotals), data
// loading, icon resolution (resIcon/bldIcon), the network actions (doUpgrade/doSpeedup/doTrain/
// doSpeedupTraining), and shared layout helpers (addBtn/fmtNum/modalScaleFor/toScreen/teamOrder/
// committedTroops/drawArtFit) — but NOT the render() dispatcher, which lives on the outer
// ../CityScene.ts assembly since only it knows about every domain class (Core takes a `render`
// callback injected at construction instead of owning render() itself, so it never has to call
// sideways into a sibling domain). Each domain (render / modals) is its own independent class in
// a sibling file, constructed with `core` (2026-08-11: converted from the former `XMixin(Base)`
// inheritance chain — the render-dispatch upward calls this used to reach via interface
// declaration merging are now explicit constructor params/callbacks instead, see
// claudedocs/client-modules.md's split-form priority note).
//
// CityScene — Home-city management (SLG_CITY_DESIGN P1 + P3 D-CITY-8/10/12).
// Entry: WorldMapScene taps own base tile → "Enter Desk".
// Single page (the old D-CITY-11 内政/军事 tab split was merged back into one scene
//   2026-07-23): base durability sits in the header bar, then resource bar +
//   build-queue strip + a scrollable building card grid (incl. academy/tech-tree,
//   matches the Roster/Skins/Teams card-grid language, tap-to-open detail modal),
//   with the 5 team slots pinned as one compact row along the bottom.
// Troop training is its own home-desk grid tile (renderTrainModal), spliced
// next to the drillYard building; the drillYard detail modal itself only
// shows cap/speed/queue bonuses, no training controls.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import type {
  WorldApiClient,
  PlayerWorldView,
  BuildingKey,
  TeamTemplate,
  MarchView,
  OccupationView,
} from '../../net/WorldApiClient';
import { carriedTroops } from '../../game/meta/teamTroops';
import { troopCap, cardPower } from '../../game/meta/cardDefs';
import {
  BUILDING_KEYS,
  BUILD_SPEEDUP_SECS_PER_COIN,
  resourceCapFor,
  type ResourceType,
} from '@nw/shared';
import { BusyTracker } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { buildIcon, type IconKind } from '../../render/icons';
import { loadResAtlas, getResTexture } from '../../render/atlas/resAtlasLoader';
import { loadCityBldAtlas, getCityBldTexture } from '../../render/atlas/cityBldAtlasLoader';
import { getArtTexture } from '../../render/cardArt';
import { serverNow } from '../../net/serverClock';
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import { teamSlotId, TEAM_CAP } from '../../game/meta/teamTroops';

// ── Public interface ─────────────────────────────────────────────────────────

export interface CitySceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  getCoins?(): number;
  /** Tapping a team card on the military page opens that team's formation editor (D-CITY-10). */
  onEditTeam?(teamId: string, teamName: string): void;
  /** Current authoritative save — the team row needs cardInv for each team's troop cap + leader portrait. */
  getSave?(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. Auction opened as a sibling overlay) changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const RES_COLORS: Readonly<Record<ResourceType, number>> = {
  ink: 0xa8d870,
  paper: 0x90b860,
  graphite: 0xb0b0a8,
  metal: 0xa0b8c8,
  sticker: 0xe6b8d0,
};

// Emoji fallbacks — only used while res_atlas is still decoding (rare: the atlas is
// a module singleton usually already loaded by WorldMapScene before city entry).
const RES_ICON: Readonly<Record<ResourceType, string>> = {
  ink: '🖊',
  paper: '📄',
  graphite: '✏️',
  metal: '🔩',
  sticker: '🏷',
};

const BLD_ICON: Readonly<Record<BuildingKey, string>> = {
  desk: '🗂',
  inkPot: '🖊',
  paperTray: '📄',
  graphiteMill: '✏️',
  metalForge: '🔩',
  stickerShop: '🏷',
  cabinet: '🗄',
  drillYard: '⚔️',
  wall: '🏯',
  academy: '📚',
  satchel: '🎒',
};

// Building glyph source: the five resource-producer buildings reuse the res_atlas
// motif of what they yield (strong resource↔building visual link, zero new art);
// the rest use hand-drawn icons.ts line-art.
const BLD_RES: Partial<Record<BuildingKey, ResourceType>> = {
  inkPot: 'ink',
  paperTray: 'paper',
  graphiteMill: 'graphite',
  metalForge: 'metal',
  stickerShop: 'sticker',
};
const BLD_GLYPH: Partial<Record<BuildingKey, IconKind>> = {
  desk: 'desk',
  cabinet: 'cabinet',
  drillYard: 'swords',
  wall: 'castle',
  academy: 'book',
};

// Hand-drawn atlas art (art/ui/slg-desk → city_bld_atlas) supersedes the BLD_GLYPH
// programmatic line-art / emoji fallback for these five once the atlas has decoded.
const BLD_ATLAS: Partial<Record<BuildingKey, string>> = {
  desk: 'bld_desk',
  cabinet: 'bld_cabinet',
  drillYard: 'bld_drillYard',
  wall: 'bld_wall',
  satchel: 'bld_satchel',
};

// Card-grid sizing — matches the CardScene/Skins wardrobe language (dynamic
// column count from a target width, rather than CityScene's old fixed 4-col table).
export const CARD_GAP = 12;
export const CARD_W_TARGET = 222;
export const CARD_H = 192;
export const GRID_PAD = 8;
// Ultra-wide viewports would otherwise fit 8 columns for the current 12-tile grid (11 buildings +
// the synthetic train tile), leaving a half-empty last row. Capping columns widens the cards
// instead of adding more of them, so 12 tiles always lay out as clean full rows (currently 2×6).
export const MAX_GRID_COLS = 6;

// Category accent for the building grid's level-progress stripe (2026-08-01 card redesign): ties
// producer cards to the resource-bar color language above them, and gives the remaining buildings
// a category tint so the grid reads as groups rather than one undifferentiated row of look-alikes.
const MILITARY_COLOR = 0xb85c38;
export function bldAccentColor(key: BuildingKey): number {
  const res = BLD_RES[key];
  if (res) return RES_COLORS[res];
  if (key === 'drillYard' || key === 'wall') return MILITARY_COLOR;
  return C.accent as number;
}

// The building grid holds every building (incl. academy). D-CITY-12 briefly pulled academy
// out into a standalone tech-tree panel on a separate military page; once that military page
// was merged back into this single scene (2026-07-23), academy returned to being a normal grid
// card (option 2 of the merge) — its detail modal already renders the tech-tree bonus lines.
export const GRID_BUILDING_KEYS: readonly BuildingKey[] = BUILDING_KEYS;

// Team row (D-CITY-10) — the 5 team slots laid out as one compact row pinned to the bottom of
// the scene; tapping a card opens that team's formation editor.
export const TEAM_ROW_CARD_H = 128;
export const TEAM_ROW_LABEL_H = 26;

export interface Hit {
  x: number;
  y: number;
  w: number;
  h: number;
  fn: () => void;
}

export class CitySceneCore {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: CitySceneCallbacks;

  readonly bt = new BusyTracker();
  hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async load() re-render can't paint into a torn-down container. */
  destroyed = false;
  /** Portrait urls we've already subscribed a one-shot 'loaded' re-render to (see drawArtFit). */
  private readonly artHooked = new Set<string>();

  me: PlayerWorldView | null = null;
  /** Wall-clock (ms) when `me` was last fetched from the server. Baseline for the client-side
   *  resource-total simulation — mirrors worldsvc settle() so the displayed totals climb between
   *  server round-trips instead of sitting frozen until the next action. */
  private meLoadedAt = 0;
  /** Accumulates update() dt; drives the once-per-second resource-total tick. */
  private simTimer = 0;
  /** Guards against overlapping getMe() calls from the once-per-second queue-completion check
   *  below (queueRefreshPending). */
  private queueRefreshPending = false;
  /** Resource-bar total labels, repopulated each render() and updated in place per second by
   *  tickResourceTotals() — a text-only nudge that avoids a full scene rebuild every second. */
  resTotalLbls: Array<{ rt: ResourceType; lbl: PIXI.Text }> = [];
  teams: TeamTemplate[] = [];
  marches: MarchView[] = [];
  occupations: OccupationView[] = [];
  /** True once GET /world/teams has settled (either way). Until then the team row draws loading
   *  placeholders instead of five real cards reading "(empty)" — that label claims "you own no
   *  teams", which is a lie during a fetch that takes most of a second against a remote shard. */
  teamsLoaded = false;
  /** True once BOTH GET /world/march and GET /world/occupations have settled. teamOrder() needs both,
   *  so a filled team's status line stays in its loading state until then rather than flashing
   *  "闲置" at a team that turns out to be marching. */
  ordersLoaded = false;
  /** 0–2 dot-animation phase for the team-row loading placeholders; advanced by tickLoadDots(). */
  loadDots = 0;
  private loadDotTimer = 0;
  /** Left edge of the body content, set each render() to marginLineX() — the red notebook
   *  binding line. Content starts just right of it (no sidebar rail on this single-page scene). */
  contentX = 0;
  selectedBuilding: BuildingKey | null = null;
  /** Train-troops modal open flag. Training is its own home-desk tile (sibling to drillYard), not
   *  a drillYard sub-panel — drillYard the building only grants troopCap / train-speed / queue slots. */
  selectedTrain = false;

  // Building-grid scroll state (drag-to-scroll, matches the CardScene/TeamsScene pattern).
  scrollY = 0;
  scrollMax = 0;
  /** Vertical bounds of whichever grid (domestic building grid / military team panel) is currently
   *  on-screen — set each render() by that grid's own renderer, so the wheel handler below can gate
   *  on the currently-active region without guessing which page is showing. */
  regionTop = 0;
  regionBottom = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a building cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — avoids a render() per pointermove (jank). */
  private scrollDirty = false;

  /** @param render Injected by the outer CityScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about all domain classes) — Core and the
   *  domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *  called its own `render()` method verbatim. Does NOT auto-fire the initial render/load — the
   *  outer assembly does that once domains exist (see ../CityScene.ts). */
  constructor(
    layout: ILayout,
    input: InputManager,
    cb: CitySceneCallbacks,
    readonly render: () => void
  ) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    // prettier-ignore: `unsubs.push(input.onWheel(` must stay on one line — the static scanner
    // (test/input-subscription-cleanup.test.ts) checks per-line for `unsubs.push(...onWheel(`.
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
        // Scroll is disabled while a building is selected — mirrors handleMove exactly.
        if (this.selectedBuilding) return;
        const next = wheelScrollY(
          this.regionTop,
          this.regionBottom,
          y,
          deltaY,
          this.scrollY,
          this.scrollMax
        );
        if (next !== null) {
          this.scrollY = next;
          this.scrollDirty = true;
        }
      })
    );
    if (cb.onSaveChanged)
      this.unsubs.push(
        cb.onSaveChanged(() => {
          if (!this.destroyed) this.render();
        })
      );
  }

  update(dt: number): void {
    if (this.scrollDirty) {
      this.scrollDirty = false;
      this.render();
    }
    if (this.bt.tick(dt)) this.render();
    if (this.tickLoadDots(dt)) this.render();
    this.simTimer += dt;
    if (this.simTimer >= 1) {
      this.simTimer = 0;
      this.tickResourceTotals();
      this.checkQueueCompletion();
    }
  }

  /** Advances the team-row loading placeholders' trailing dots while their fetches are in flight.
   *  Returns true when a re-render is needed (same contract as BusyTracker.tick). */
  private tickLoadDots(dt: number): boolean {
    if (this.teamsLoaded && this.ordersLoaded) return false;
    this.loadDotTimer += dt;
    if (this.loadDotTimer < 0.4) return false;
    this.loadDotTimer = 0;
    this.loadDots = (this.loadDots + 1) % 3;
    return true;
  }

  /**
   * Build/train queue completion has no push and no other refresh path — worldsvc's 2s scheduler
   * settles the queue server-side but never notifies gateway, so without this the countdown text
   * only updates on the next render() (scroll/action-driven) and the finished entry never
   * disappears until the player leaves and re-enters CityScene (P0-9, comm-audit-2026-07-27
   * finding B10). Once a queue entry's completeAt has passed, re-fetch `me` — if the server hasn't
   * processed it yet (scheduler lag), the entry is still there and this simply retries next tick.
   */
  private checkQueueCompletion(): void {
    if (this.queueRefreshPending || this.destroyed || !this.me) return;
    const now = Date.now();
    const due =
      (this.me.buildQueue ?? []).some((q) => q.completeAt <= now) ||
      (this.me.trainingQueue ?? []).some((q) => q.completeAt <= now);
    if (!due) return;
    this.queueRefreshPending = true;
    this.cb.worldApi
      .getMe(this.cb.worldId)
      .then((me) => {
        if (!this.destroyed) {
          this.setMe(me);
          this.render();
        }
      })
      .catch(() => {
        /* offline: retry next tick */
      })
      .finally(() => {
        this.queueRefreshPending = false;
      });
  }

  /** Advance the resource-bar total labels in place (no full render). Mirrors worldsvc settle():
   *  displayed total = min(cap, base + yieldRate·elapsedHours). Cheap enough to run every second. */
  private tickResourceTotals(): void {
    for (const { rt, lbl } of this.resTotalLbls) {
      const next = this.fmtNum(this.liveResource(rt));
      if (lbl.text !== next) lbl.text = next;
    }
  }

  /** Assign `me` and stamp the sim baseline so liveResource() grows from this fetch onward.
   *  Every consuming action (upgrade/speedup/train) round-trips through here, re-syncing the
   *  simulated totals to the server's authoritative post-consume amounts. */
  private setMe(me: PlayerWorldView): void {
    this.me = me;
    this.meLoadedAt = Date.now();
  }

  /** Server-consistent client-side resource total: base amount fetched with `me`, grown by the
   *  hourly yield rate since fetch, capped at the cabinet-adjusted storage cap. */
  liveResource(rt: ResourceType): number {
    const base = this.me?.resources?.[rt] ?? 0;
    const rate = this.me?.yieldRate?.[rt] ?? 0;
    const cap = resourceCapFor(this.me?.buildings);
    const dtHours = Math.max(0, (Date.now() - this.meLoadedAt) / 3_600_000);
    return Math.min(cap, base + rate * dtHours);
  }

  destroy(): void {
    this.destroyed = true;
    for (const unsub of this.unsubs) unsub();
    // Free the Text baseTextures across the whole tree before dropping the container — a bare
    // container.destroy({children:true}) destroys the Text objects but orphans their textures
    // (texture defaults to false for descendants). This scene opens/closes as an overlay on top of
    // the long-lived WorldMapScene, so an un-freed screenful of Text leaks on every close (§mem-leak).
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  /**
   * Fetch the four independent data slices this scene needs. Deliberately NOT a `Promise.all`
   * barrier (2026-08-02): awaiting all four before the first paint made every slice as slow as the
   * slowest one — the team row in particular sat on placeholder content until getMe/getMarches/
   * getOccupations had also answered, long after /world/teams itself had landed. Each slice now
   * paints the moment its own request resolves.
   *
   * Issue order matters: rateGate.ts hands out its 5-token bucket strictly FIFO, so when the bucket
   * is drained (world-map entry, a burst of taps) requests are served in the order they were made.
   * getTeams goes first because the team row is what the player is waiting on here.
   */
  load(): void {
    // Resource / producer-building glyphs reuse the res_atlas motifs; re-render once decoded.
    void loadResAtlas()
      .then(() => this.render())
      .catch(() => {
        /* color/emoji fallback */
      });
    void loadCityBldAtlas()
      .then(() => this.render())
      .catch(() => {
        /* icons.ts/emoji fallback */
      });

    const paint = (): void => {
      if (!this.destroyed) this.render();
    };

    void this.cb.worldApi
      .getTeams(this.cb.worldId)
      .then((teams) => {
        this.teams = teams;
      })
      .catch(() => {
        /* offline — the row falls through to its real empty state */
      })
      .finally(() => {
        this.teamsLoaded = true;
        paint();
      });

    void this.cb.worldApi
      .getMe(this.cb.worldId)
      .then((me) => {
        this.setMe(me);
        paint();
      })
      .catch(() => {
        /* offline — resource bar / building grid keep their pre-load zeros */
      });

    // marches + occupations both feed teamOrder(), so `ordersLoaded` only flips once both have
    // settled — see the field's doc comment for why the status line waits on that.
    let ordersPending = 2;
    const orderSettled = (): void => {
      if (--ordersPending === 0) this.ordersLoaded = true;
      paint();
    };
    void this.cb.worldApi
      .getMarches(this.cb.worldId)
      .then((marches) => {
        this.marches = marches;
      })
      .catch(() => {
        /* offline — treated as no active march */
      })
      .finally(orderSettled);
    void this.cb.worldApi
      .getOccupations(this.cb.worldId)
      .then((occupations) => {
        this.occupations = occupations;
      })
      .catch(() => {
        /* offline — treated as no active hold */
      })
      .finally(orderSettled);
  }

  // ── Icon resolution ─────────────────────────────────────────────────────────

  /** Resource glyph: res_atlas motif sprite when decoded, else the emoji fallback. */
  resIcon(rt: ResourceType, size: number): PIXI.DisplayObject {
    const tex = getResTexture(rt);
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.width = sp.height = size;
      return sp;
    }
    return txt(RES_ICON[rt], snapFont(Math.round(size * 0.85)), C.dark);
  }

  /** Building glyph: producer→res_atlas motif, hand-drawn city_bld_atlas art, then icons.ts line-art, emoji as last resort. */
  bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
    const res = BLD_RES[key];
    if (res) return this.resIcon(res, size);
    const frame = BLD_ATLAS[key];
    const tex = frame ? getCityBldTexture(frame) : null;
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.width = sp.height = size;
      return sp;
    }
    const kind = BLD_GLYPH[key];
    if (kind) return buildIcon(kind, size, color);
    return txt(BLD_ICON[key], snapFont(Math.round(size * 0.85)), color);
  }

  async doUpgrade(key: BuildingKey): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    this.render();
    try {
      this.setMe(await this.cb.worldApi.upgradeBuilding(this.cb.worldId, key));
      this.showToast(t('city.upgrading'), C.green as number);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('resources')) this.showToast(t('city.err.noResources'), C.red as number);
      else if (msg.includes('queue')) this.showToast(t('city.err.queueFull'), C.red as number);
      else if (msg.includes('desk')) this.showToast(t('city.err.deskGate'), C.red as number);
      else this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  async doSpeedup(key: BuildingKey): Promise<void> {
    if (this.bt.busy) return;
    const entry = this.me?.buildQueue?.find((q) => q.key === key);
    if (!entry) return;
    // serverNow() (P1-1): this determines how many coins are actually charged, so it must use the
    // same server-corrected clock as the price the player was shown (render.ts's renderBuildQueue) —
    // a client with a fast/slow local clock would otherwise over/under-charge relative to the
    // server's real remaining time (comm-audit-2026-07-27 finding).
    const secsLeft = Math.max(0, Math.ceil((entry.completeAt - serverNow()) / 1000));
    const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
    this.bt.start();
    this.render();
    try {
      this.setMe(await this.cb.worldApi.speedupBuild(this.cb.worldId, key, coins));
      this.showToast(t('city.speedupDone'), C.green as number);
    } catch {
      this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  async doTrain(qty: number): Promise<void> {
    if (this.bt.busy || qty <= 0) return;
    this.bt.start();
    this.render();
    try {
      this.setMe(await this.cb.worldApi.trainTroops(this.cb.worldId, qty));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('cap')) this.showToast(t('city.err.troopCap'), C.red as number);
      else if (msg.includes('queue')) this.showToast(t('city.err.trainQueueFull'), C.red as number);
      else if (msg.includes('Insufficient'))
        this.showToast(t('city.err.noResources'), C.red as number);
      else this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  async doSpeedupTraining(coins: number): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    this.render();
    try {
      this.setMe(await this.cb.worldApi.speedupTraining(this.cb.worldId, coins));
      this.showToast(t('city.speedupDone'), C.green as number);
    } catch {
      this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  /**
   * "填满所有队伍" — distribute the home troop pool across all 5 teams in slot order (t1..t5),
   * highest combat-power card first within each team (mirrors DefenseEditorScene's §6.5 一键补满).
   * A team only takes what's left in the pool once earlier teams are topped up, so an exhausted
   * pool partially fills whichever team is next in line and leaves the rest untouched.
   */
  async doFillAllTeams(): Promise<void> {
    if (this.bt.busy) return;
    const save = this.cb.getSave?.();
    const cardInv = save?.cardInv ?? {};
    const equipmentInv = save?.equipmentInv ?? {};
    const cardState = this.me?.cardState ?? {};
    let pool = this.me?.troops ?? 0;
    const allocations: Record<string, number> = {};
    const filledTeamIds = new Set<string>();

    for (let i = 0; i < TEAM_CAP && pool > 0; i++) {
      const team = this.teams.find((tm) => tm.id === teamSlotId(i));
      if (!team) continue;
      const placed = team.army
        .filter((e) => !!e.cardInstanceId)
        .map((e) => ({ id: e.cardInstanceId!, card: cardInv[e.cardInstanceId!] }))
        .filter((x): x is { id: string; card: CardInstance } => !!x.card);
      if (placed.length === 0) continue;
      placed.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));
      for (const { id, card } of placed) {
        if (pool <= 0) break;
        const current = cardState[id]?.currentTroops ?? 0;
        const gap = Math.max(0, troopCap(card) - current);
        if (gap <= 0) continue;
        const amount = Math.min(gap, pool);
        allocations[id] = amount;
        pool -= amount;
        filledTeamIds.add(team.id);
      }
    }

    if (Object.keys(allocations).length === 0) {
      this.showToast(t('city.military.fillAllTeamsNone'), C.red as number);
      return;
    }

    this.bt.start();
    this.render();
    try {
      await this.cb.worldApi.distributeTroops(this.cb.worldId, allocations);
      let total = 0;
      const nextCardState = { ...cardState };
      for (const [id, amount] of Object.entries(allocations)) {
        total += amount;
        const cs = nextCardState[id];
        nextCardState[id] = { ...cs, currentTroops: (cs?.currentTroops ?? 0) + amount };
      }
      if (this.me)
        this.me = { ...this.me, troops: (this.me.troops ?? 0) - total, cardState: nextCardState };
      this.showToast(
        t('city.military.fillAllTeamsDone')
          .replace('{n}', String(total))
          .replace('{teams}', String(filledTeamIds.size)),
        C.green as number
      );
    } catch {
      this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  showToast(msg: string, color: number = C.red as number): void {
    showToastMessage(msg, color === (C.red as number) ? 'error' : 'success');
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(px: number, py: number): void {
    if (this.bt.busy) return;
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a building cell scrolls instead of firing it.
    let hit: (() => void) | null = null;
    for (const h of this.hits) {
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
        hit = h.fn;
        break;
      }
    }
    this.gesture.down(this.scrollY, py, hit);
  }

  private handleMove(py: number): void {
    // Scroll is disabled while a building is selected (the detail panel owns the view); taps still fire.
    if (this.selectedBuilding) return;
    const scroll = this.gesture.move(py);
    if (scroll !== null) {
      this.scrollY = Math.min(this.scrollMax, scroll);
      this.scrollDirty = true;
    }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /** Current order tying up a team, if any — mirrors TeamsScene.teamOrder (server's TEAM_BUSY predicate). */
  teamOrder(teamId: string): { march: MarchView } | { occ: OccupationView } | null {
    const march = this.marches.find((m) => m.mine !== false && m.teamId === teamId);
    if (march) return { march };
    const occ = this.occupations.find((o) => o.teamId === teamId);
    if (occ) return { occ };
    return null;
  }

  /** Total troops committed across a team's cards — legacy non-card entries count 0 (see teamTroops.ts). */
  committedTroops(army: TeamTemplate['army']): number {
    return carriedTroops(army, this.me?.cardState);
  }

  /** Draw a card portrait centred inside a box; re-render once its texture decodes (mirrors DefenseEditorScene). */
  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
    const tex = getArtTexture(url);
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => {
          if (!this.destroyed) this.render();
        });
      }
      return;
    }
    const scale = Math.min(boxW / tex.width, boxH / tex.height);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + boxW / 2, y + boxH / 2);
    this.container.addChild(sp);
  }

  addBtn(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    textColor: number,
    fill: number,
    fn: () => void
  ): void {
    const g = sketchPanel(w, h, { fill, border: C.line, width: 1, seed: seedFor(x, y, w) });
    g.x = x;
    g.y = y;
    this.container.addChild(g);
    const lbl = txt(label, FS.body, textColor, true);
    lbl.x = x + 12;
    lbl.y = y + (h - 22) / 2;
    this.container.addChild(lbl);
    this.hits.push({ x, y, w, h, fn });
  }

  fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
    return String(Math.floor(n));
  }

  modalScaleFor(mw: number, mh: number): number {
    const { w, h } = this;
    const ref = Math.min(w, h); // fitted axis — 1080 for both portrait & landscape
    const target = (ref * 0.8) / mw; // popup ≈ 80% of the fitted axis wide (matches old portrait)
    return Math.min(target, (w * 0.92) / mw, (h * 0.92) / mh);
  }

  /** Convert a rect drawn in the modal's local (unscaled) frame into real screen space. */
  toScreen(
    r: { x: number; y: number; w: number; h: number },
    originX: number,
    originY: number,
    scale: number
  ): { x: number; y: number; w: number; h: number } {
    return { x: originX + r.x * scale, y: originY + r.y * scale, w: r.w * scale, h: r.h * scale };
  }
}
