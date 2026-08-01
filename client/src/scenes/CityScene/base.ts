// Shared foundation for the CityScene mixin chain (see ../CityScene.ts assembly).
//
// CitySceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.me, this.teams, this.hits, …) + the constructor, the input/scroll
// plumbing, resource-total simulation (setMe/liveResource/tickResourceTotals), data loading, icon
// resolution (resIcon/bldIcon), the network actions (doUpgrade/doSpeedup/doTrain/doSpeedupTraining),
// the render dispatcher, and shared layout helpers (addBtn/fmtNum/modalScaleFor/toScreen/teamOrder/
// committedTroops/drawArtFit). Each domain (render / modals) lives in its own sibling file as an
// `XMixin(Base)` and is chained together into the final CityScene.
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
import {
  ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren, marginLineX,
} from '../../render/sketchUi';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { FS, snapFont } from '../../render/fontScale';
import type {
  WorldApiClient, PlayerWorldView, BuildingKey, TeamTemplate, MarchView, OccupationView,
} from '../../net/WorldApiClient';
import { carriedTroops } from '../../game/meta/teamTroops';
import {
  BUILDING_KEYS,
  BUILD_SPEEDUP_SECS_PER_COIN,
  resourceCapFor,
  type ResourceType,
} from '@nw/shared';
import { BusyTracker } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { buildIcon, type IconKind } from '../../render/icons';
import { loadResAtlas, getResTexture } from '../../render/resAtlasLoader';
import { loadCityBldAtlas, getCityBldTexture } from '../../render/cityBldAtlasLoader';
import { getArtTexture } from '../../render/cardArt';
import { serverNow } from '../../net/serverClock';
import type { SaveData } from '../../game/meta/SaveData';

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
  ink:      0xa8d870,
  paper:    0x90b860,
  graphite: 0xb0b0a8,
  metal:    0xa0b8c8,
  sticker:  0xe6b8d0,
};

// Emoji fallbacks — only used while res_atlas is still decoding (rare: the atlas is
// a module singleton usually already loaded by WorldMapScene before city entry).
const RES_ICON: Readonly<Record<ResourceType, string>> = {
  ink: '🖊', paper: '📄', graphite: '✏️', metal: '🔩', sticker: '🏷',
};

const BLD_ICON: Readonly<Record<BuildingKey, string>> = {
  desk:         '🗂',
  inkPot:       '🖊',
  paperTray:    '📄',
  graphiteMill: '✏️',
  metalForge:   '🔩',
  stickerShop:  '🏷',
  cabinet:      '🗄',
  drillYard:    '⚔️',
  wall:         '🏯',
  academy:      '📚',
  satchel:      '🎒',
};

// Building glyph source: the five resource-producer buildings reuse the res_atlas
// motif of what they yield (strong resource↔building visual link, zero new art);
// the rest use hand-drawn icons.ts line-art.
const BLD_RES: Partial<Record<BuildingKey, ResourceType>> = {
  inkPot: 'ink', paperTray: 'paper', graphiteMill: 'graphite', metalForge: 'metal', stickerShop: 'sticker',
};
const BLD_GLYPH: Partial<Record<BuildingKey, IconKind>> = {
  desk: 'desk', cabinet: 'cabinet', drillYard: 'swords', wall: 'castle', academy: 'book',
};

// Hand-drawn atlas art (art/ui/slg-desk → city_bld_atlas) supersedes the BLD_GLYPH
// programmatic line-art / emoji fallback for these five once the atlas has decoded.
const BLD_ATLAS: Partial<Record<BuildingKey, string>> = {
  desk: 'bld_desk', cabinet: 'bld_cabinet', drillYard: 'bld_drillYard', wall: 'bld_wall', satchel: 'bld_satchel',
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

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type CitySceneBaseCtor = Constructor<CitySceneBase>;

export class CitySceneBase {
  readonly container: PIXI.Container;
  protected readonly w: number;
  protected readonly h: number;
  protected readonly cb: CitySceneCallbacks;

  protected readonly bt = new BusyTracker();
  protected hits: Hit[] = [];
  protected readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async load() re-render can't paint into a torn-down container. */
  protected destroyed = false;
  /** Portrait urls we've already subscribed a one-shot 'loaded' re-render to (see drawArtFit). */
  protected readonly artHooked = new Set<string>();

  protected me: PlayerWorldView | null = null;
  /** Wall-clock (ms) when `me` was last fetched from the server. Baseline for the client-side
   *  resource-total simulation — mirrors worldsvc settle() so the displayed totals climb between
   *  server round-trips instead of sitting frozen until the next action. */
  protected meLoadedAt = 0;
  /** Accumulates update() dt; drives the once-per-second resource-total tick. */
  protected simTimer = 0;
  /** Guards against overlapping getMe() calls from the once-per-second queue-completion check
   *  below (queueRefreshPending). */
  protected queueRefreshPending = false;
  /** Resource-bar total labels, repopulated each render() and updated in place per second by
   *  tickResourceTotals() — a text-only nudge that avoids a full scene rebuild every second. */
  protected resTotalLbls: Array<{ rt: ResourceType; lbl: PIXI.Text }> = [];
  protected teams: TeamTemplate[] = [];
  protected marches: MarchView[] = [];
  protected occupations: OccupationView[] = [];
  /** Left edge of the body content, set each render() to marginLineX() — the red notebook
   *  binding line. Content starts just right of it (no sidebar rail on this single-page scene). */
  protected contentX = 0;
  protected selectedBuilding: BuildingKey | null = null;
  /** Train-troops modal open flag. Training is its own home-desk tile (sibling to drillYard), not
   *  a drillYard sub-panel — drillYard the building only grants troopCap / train-speed / queue slots. */
  protected selectedTrain = false;

  // Building-grid scroll state (drag-to-scroll, matches the CardScene/TeamsScene pattern).
  protected scrollY = 0;
  protected scrollMax = 0;
  /** Vertical bounds of whichever grid (domestic building grid / military team panel) is currently
   *  on-screen — set each render() by that grid's own renderer, so the wheel handler below can gate
   *  on the currently-active region without guessing which page is showing. */
  protected regionTop = 0;
  protected regionBottom = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a building cell scrolls instead of firing it). See ScrollTapGesture.
   */
  protected readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — avoids a render() per pointermove (jank). */
  protected scrollDirty = false;

  constructor(layout: ILayout, input: InputManager, cb: CitySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      // Scroll is disabled while a building is selected — mirrors handleMove exactly.
      if (this.selectedBuilding) return;
      const next = wheelScrollY(this.regionTop, this.regionBottom, y, deltaY, this.scrollY, this.scrollMax);
      if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
    }));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));
    this.render();
    void this.load();
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.bt.tick(dt)) this.render();
    this.simTimer += dt;
    if (this.simTimer >= 1) {
      this.simTimer = 0;
      this.tickResourceTotals();
      this.checkQueueCompletion();
    }
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
      (this.me.buildQueue ?? []).some(q => q.completeAt <= now) ||
      (this.me.trainingQueue ?? []).some(q => q.completeAt <= now);
    if (!due) return;
    this.queueRefreshPending = true;
    this.cb.worldApi.getMe(this.cb.worldId)
      .then(me => { if (!this.destroyed) { this.setMe(me); this.render(); } })
      .catch(() => { /* offline: retry next tick */ })
      .finally(() => { this.queueRefreshPending = false; });
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
  protected liveResource(rt: ResourceType): number {
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

  private async load(): Promise<void> {
    // Resource / producer-building glyphs reuse the res_atlas motifs; re-render once decoded.
    void loadResAtlas().then(() => this.render()).catch(() => { /* color/emoji fallback */ });
    void loadCityBldAtlas().then(() => this.render()).catch(() => { /* icons.ts/emoji fallback */ });
    try {
      const [me, teams, marches, occupations] = await Promise.all([
        this.cb.worldApi.getMe(this.cb.worldId),
        this.cb.worldApi.getTeams(this.cb.worldId),
        this.cb.worldApi.getMarches(this.cb.worldId),
        this.cb.worldApi.getOccupations(this.cb.worldId),
      ]);
      this.setMe(me);
      this.teams = teams;
      this.marches = marches;
      this.occupations = occupations;
    } catch {
      /* use null/empty — shows loading state */
    }
    this.render();
  }

  // ── Icon resolution ─────────────────────────────────────────────────────────

  /** Resource glyph: res_atlas motif sprite when decoded, else the emoji fallback. */
  protected resIcon(rt: ResourceType, size: number): PIXI.DisplayObject {
    const tex = getResTexture(rt);
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.width = sp.height = size;
      return sp;
    }
    return txt(RES_ICON[rt], snapFont(Math.round(size * 0.85)), C.dark);
  }

  /** Building glyph: producer→res_atlas motif, hand-drawn city_bld_atlas art, then icons.ts line-art, emoji as last resort. */
  protected bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
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

  protected async doUpgrade(key: BuildingKey): Promise<void> {
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

  protected async doSpeedup(key: BuildingKey): Promise<void> {
    if (this.bt.busy) return;
    const entry = this.me?.buildQueue?.find(q => q.key === key);
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

  protected async doTrain(qty: number): Promise<void> {
    if (this.bt.busy || qty <= 0) return;
    this.bt.start();
    this.render();
    try {
      this.setMe(await this.cb.worldApi.trainTroops(this.cb.worldId, qty));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('ink')) this.showToast(t('city.err.noInk'), C.red as number);
      else if (msg.includes('cap')) this.showToast(t('city.err.troopCap'), C.red as number);
      else if (msg.includes('queue')) this.showToast(t('city.err.trainQueueFull'), C.red as number);
      else this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  protected async doSpeedupTraining(coins: number): Promise<void> {
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

  protected showToast(msg: string, color: number = C.red as number): void {
    showToastMessage(msg, color === (C.red as number) ? 'error' : 'success');
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(px: number, py: number): void {
    if (this.bt.busy) return;
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a building cell scrolls instead of firing it.
    let hit: (() => void) | null = null;
    for (const h of this.hits) {
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) { hit = h.fn; break; }
    }
    this.gesture.down(this.scrollY, py, hit);
  }

  private handleMove(py: number): void {
    // Scroll is disabled while a building is selected (the detail panel owns the view); taps still fire.
    if (this.selectedBuilding) return;
    const scroll = this.gesture.move(py);
    if (scroll !== null) { this.scrollY = Math.min(this.scrollMax, scroll); this.scrollDirty = true; }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    this.resTotalLbls = [];
    const { w, h } = this;

    // No sidebar rail on this single-page scene, so the red binding line keeps its default
    // 9%-of-width position (marginLineX) and body content starts just right of it.
    this.container.addChild(buildPaperBackground('citybg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('city.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    const backHit: Hit = { x: hdr.backRect.x, y: hdr.backRect.y, w: hdr.backRect.w, h: hdr.backRect.h, fn: () => this.cb.onBack() };
    this.hits.push(backHit);
    // Base durability (D-CITY-8) rides in the header bar's free right side.
    this.renderHeaderDurability(hdr.headerH);

    this.contentX = marginLineX(w);
    const y = hdr.headerH + 8;

    // Resource bar
    let cy = this.renderResourceBar(y);
    cy += 8;

    // Build queue strip
    cy = this.renderBuildQueue(cy);
    cy += 8;

    // The 5 team slots pin to the bottom as one compact row; the building grid fills the gap above.
    const teamsTop = this.renderTeamsRow();

    // Building card grid (scrollable), bottom-limited so it never runs under the team row.
    this.renderBuildingGrid(cy, teamsTop - 8);

    // Detail modal (popup-scale-to-80% convention, tap-outside-to-close). The page content
    // sits dimmed underneath — drop its hits (keeping only Back) so a tap there can't
    // silently switch buildings or trigger speedup instead of dismissing the modal. Opening
    // a building card (incl. academy/tech-tree) or the train tile routes through here.
    if (this.selectedBuilding) {
      this.hits = [backHit];
      this.renderDetailModal(this.selectedBuilding);
    } else if (this.selectedTrain) {
      this.hits = [backHit];
      this.renderTrainModal();
    }

    // Busy overlay
    if (this.bt.busy) {
      const ov = new PIXI.Graphics();
      ov.beginFill(0x000000, 0.25);
      ov.drawRect(0, 0, w, h);
      ov.endFill();
      this.container.addChild(ov);
      const lbl = txt('…', FS.headline, 0xffffff, true);
      lbl.x = w / 2 - 15;
      lbl.y = h / 2 - 21;
      this.container.addChild(lbl);
    }

  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /** Current order tying up a team, if any — mirrors TeamsScene.teamOrder (server's TEAM_BUSY predicate). */
  protected teamOrder(teamId: string): { march: MarchView } | { occ: OccupationView } | null {
    const march = this.marches.find(m => m.mine !== false && m.teamId === teamId);
    if (march) return { march };
    const occ = this.occupations.find(o => o.teamId === teamId);
    if (occ) return { occ };
    return null;
  }

  /** Total troops committed across a team's cards — legacy non-card entries count 0 (see teamTroops.ts). */
  protected committedTroops(army: TeamTemplate['army']): number {
    return carriedTroops(army, this.me?.cardState);
  }

  /** Draw a card portrait centred inside a box; re-render once its texture decodes (mirrors DefenseEditorScene). */
  protected drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
    const tex = getArtTexture(url);
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => { if (!this.destroyed) this.render(); });
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

  protected addBtn(
    x: number, y: number, w: number, h: number,
    label: string, textColor: number, fill: number,
    fn: () => void,
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

  protected fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
    return String(Math.floor(n));
  }

  protected modalScaleFor(mw: number, mh: number): number {
    const { w, h } = this;
    const ref = Math.min(w, h);            // fitted axis — 1080 for both portrait & landscape
    const target = (ref * 0.8) / mw;       // popup ≈ 80% of the fitted axis wide (matches old portrait)
    return Math.min(target, (w * 0.92) / mw, (h * 0.92) / mh);
  }

  /** Convert a rect drawn in the modal's local (unscaled) frame into real screen space. */
  protected toScreen(r: { x: number; y: number; w: number; h: number }, originX: number, originY: number, scale: number): { x: number; y: number; w: number; h: number } {
    return { x: originX + r.x * scale, y: originY + r.y * scale, w: r.w * scale, h: r.h * scale };
  }
}

// ── Domain entrypoints dispatched to from base-level code (render dispatcher) and across sibling
// mixins (render → base helpers; modals → base helpers). Declared via interface/class declaration
// merging so base-level `this.renderHeaderDurability()` / `this.renderDetailModal()` type-check as
// METHODS (not properties, which would clash with the mixin override — TS2425). Emits NOTHING at
// runtime, so the real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface CitySceneBase {
  renderHeaderDurability(headerH: number): void;
  renderTeamsRow(): number;
  renderTeamCard(i: number, x: number, y: number, cardW: number, cardH: number, now: number): void;
  renderResourceBar(startY: number): number;
  renderBuildQueue(startY: number): number;
  renderBuildingGrid(startY: number, bottomY: number): void;
  renderDetailModal(key: BuildingKey): void;
  renderTrainModal(): void;
  buildingBonusLines(key: BuildingKey, bld: Partial<Record<BuildingKey, number>> | undefined): string[];
}
