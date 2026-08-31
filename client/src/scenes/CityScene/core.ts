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
import { ui as C, tearDownChildren } from '../../render/sketchUi';
import type {
  WorldApiClient,
  PlayerWorldView,
  BuildingKey,
  TeamTemplate,
  MarchView,
  OccupationView,
  StationedView,
} from '../../net/WorldApiClient';
import {
  BUILDING_KEYS,
  resourceCapFor,
  type ResourceType,
} from '@nw/shared';
import { BusyTracker } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { GuideOverlay } from '../../render/GuideOverlay';
import type { SaveData } from '../../game/meta/SaveData';
import * as actions from './actions';
import * as helpers from './helpers';
import * as icons from './icons';
import * as data from './data';
import { hitAction, type Hit } from '../../ui/hits';

// ── Public interface ─────────────────────────────────────────────────────────

export interface CitySceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  getCoins?(): number;
  /**
   * Re-syncs the local wallet cache after a spend the commercial service applied server-side
   * (build speed-up / training speed-up). worldsvc's responses carry the updated *world* state but
   * never the SaveData wallet, so without this the coin readout keeps showing the pre-spend
   * balance. Same contract as SectScene's `refreshWallet` and WorldMapCallbacks'. Optional so the
   * CityScene UI fixtures that predate it don't all need updating.
   */
  refreshWallet?(): Promise<void>;
  /** Tapping a team card on the military page opens that team's formation editor (D-CITY-10). */
  onEditTeam?(teamId: string, teamName: string): void;
  /** Current authoritative save — the team row needs cardInv for each team's troop cap + leader portrait. */
  getSave?(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. Auction opened as a sibling overlay) changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /** SLG opening guide chain (ONBOARDING_DESIGN §4.2) — thin pass-through to SaveManager.getFlag/setFlag,
   * reusing the existing flags channel for `guide.world.step{2,3}`. Optional purely so the many
   * existing CityScene UI test fixtures that predate this feature don't all need updating;
   * production wiring (app/nav/world.ts) always provides both. */
  getFlag?(key: string): boolean;
  setFlag?(key: string, value: boolean): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

export { RES_COLORS, bldAccentColor, chipped, producerResource } from './icons';

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

// The building grid holds every building (incl. academy). D-CITY-12 briefly pulled academy
// out into a standalone tech-tree panel on a separate military page; once that military page
// was merged back into this single scene (2026-07-23), academy returned to being a normal grid
// card (option 2 of the merge) — its detail modal already renders the tech-tree bonus lines.
export const GRID_BUILDING_KEYS: readonly BuildingKey[] = BUILDING_KEYS;

// Team row (D-CITY-10) — the 5 team slots laid out as one compact row pinned to the bottom of
// the scene; tapping a card opens that team's formation editor.
export const TEAM_ROW_CARD_H = 128;
export const TEAM_ROW_LABEL_H = 26;

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
  /** Own teams parked on field tiles (停留/驻扎). Loaded alongside marches/occupations because a
   *  stationed team is away from home too — see helpers.teamOrder. */
  stationed: StationedView[] = [];
  /** True once GET /world/teams has settled (either way). Until then the team row draws loading
   *  placeholders instead of five real cards reading "(empty)" — that label claims "you own no
   *  teams", which is a lie during a fetch that takes most of a second against a remote shard. */
  teamsLoaded = false;
  /** True once ALL THREE of GET /world/march, /world/occupations and /world/stationed have settled.
   *  teamOrder() needs all three, so a filled team's status line stays in its loading state until
   *  then rather than flashing "闲置" at a team that turns out to be marching or parked on a tile. */
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
   *  outer assembly does that once domains exist (see ../CityScene.ts).
   *  @param guide SLG opening guide chain (ONBOARDING_DESIGN §4.2) — also injected by the outer
   *  assembly, which mounts `guide.root` as a sibling of `container` that survives every
   *  `tearDownChildren(core.container)` call inside render() (see ../CityScene.ts's constructor). */
  constructor(
    layout: ILayout,
    input: InputManager,
    cb: CitySceneCallbacks,
    readonly render: () => void,
    readonly guide: GuideOverlay
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
    // SLG opening guide chain (ONBOARDING_DESIGN §4.2) — advance the ring's breathing animation
    // every frame regardless of whether a full render() fires this tick (render() decides *what* to
    // show; this just keeps whatever is showing animated).
    this.guide.update(dt);
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
    // guide.root is mounted on the outer wrapper container (../CityScene.ts's constructor), not
    // `this.container` above — destroy it explicitly, it does not fall out of the line above.
    this.guide.destroy();
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
    const core = this;
    data.load({
      cb: this.cb,
      get destroyed() { return core.destroyed; },
      get teams() { return core.teams; },
      set teams(v) { core.teams = v; },
      get marches() { return core.marches; },
      set marches(v) { core.marches = v; },
      get occupations() { return core.occupations; },
      set occupations(v) { core.occupations = v; },
      get stationed() { return core.stationed; },
      set stationed(v) { core.stationed = v; },
      get teamsLoaded() { return core.teamsLoaded; },
      set teamsLoaded(v) { core.teamsLoaded = v; },
      get ordersLoaded() { return core.ordersLoaded; },
      set ordersLoaded(v) { core.ordersLoaded = v; },
      setMe: (me) => this.setMe(me),
      render: () => this.render(),
    });
  }

  // ── Icon resolution — see CityScene/icons.ts ───────────────────────────────

  resIcon(rt: ResourceType, size: number): PIXI.DisplayObject {
    return icons.resIcon(rt, size);
  }

  bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
    return icons.bldIcon(key, size, color);
  }

  /** Bundles what actions.ts's network-action functions need instead of them closing over `this`. */
  private actionsHost(): actions.ActionsHost {
    const core = this;
    return {
      bt: this.bt, cb: this.cb, teams: this.teams,
      get me() { return core.me; },
      set me(v) { core.me = v; },
      setMe: (me) => this.setMe(me),
      render: () => this.render(),
      showToast: (msg, color) => this.showToast(msg, color),
    };
  }

  async doUpgrade(key: BuildingKey): Promise<void> { return actions.doUpgrade(this.actionsHost(), key); }
  async doSpeedup(key: BuildingKey): Promise<void> { return actions.doSpeedup(this.actionsHost(), key); }
  async doTrain(qty: number): Promise<void> { return actions.doTrain(this.actionsHost(), qty); }
  async doSpeedupTraining(coins: number): Promise<void> { return actions.doSpeedupTraining(this.actionsHost(), coins); }
  async doFillAllTeams(): Promise<void> { return actions.doFillAllTeams(this.actionsHost()); }

  showToast(msg: string, color: number = C.red as number): void {
    showToastMessage(msg, color === (C.red as number) ? 'error' : 'success');
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(px: number, py: number): void {
    if (this.bt.busy) return;
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a building cell scrolls instead of firing it.
    this.gesture.down(this.scrollY, py, hitAction(this.hits, px, py));
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

  // ── Shared helpers — see CityScene/helpers.ts ──────────────────────────────

  teamOrder(
    teamId: string
  ): { march: MarchView } | { occ: OccupationView } | { station: StationedView } | null {
    return helpers.teamOrder(this.marches, this.occupations, this.stationed, teamId);
  }

  committedTroops(army: TeamTemplate['army']): number {
    return helpers.committedTroops(this.me, army);
  }

  /** Bundles what helpers.ts's drawArtFit/addBtn need instead of them closing over `this`. */
  private artHost(): helpers.ArtHost {
    const core = this;
    return {
      container: this.container,
      get destroyed() { return core.destroyed; },
      artHooked: this.artHooked, hits: this.hits, render: () => this.render(),
    };
  }

  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
    helpers.drawArtFit(this.artHost(), url, x, y, boxW, boxH);
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
    helpers.addBtn(this.artHost(), x, y, w, h, label, textColor, fill, fn);
  }

  fmtNum(n: number): string {
    return helpers.fmtNum(n);
  }

  modalScaleFor(mw: number, mh: number): number {
    return helpers.modalScaleFor(this.w, this.h, mw, mh);
  }

  /** Convert a rect drawn in the modal's local (unscaled) frame into real screen space. */
  toScreen(
    r: { x: number; y: number; w: number; h: number },
    originX: number,
    originY: number,
    scale: number
  ): { x: number; y: number; w: number; h: number } {
    return helpers.toScreen(r, originX, originY, scale);
  }
}
