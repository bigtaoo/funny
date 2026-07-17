// CityScene — Home-city management (SLG_CITY_DESIGN P1 + P3 D-CITY-11/12).
// Entry: WorldMapScene taps own base tile → "Enter Desk".
// Two switchable pages (D-CITY-11): 内政 (resource bar + build-queue strip +
//   scrollable building card grid, matches the Roster/Skins/Teams card-grid
//   language, tap-to-open detail modal) and 军事 (tech-tree panel for `academy`,
//   D-CITY-12; team panel D-CITY-10 still a placeholder below it).
// Troop training is surfaced via the drillYard detail modal (replaces the
// WorldMapScene train button for users who enter city).

import * as PIXI from 'pixi.js-legacy';
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import {
  ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren,
} from '../render/sketchUi';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { FS, snapFont } from '../render/fontScale';
import { formatDuration } from './worldmap/formatDuration';
import type {
  WorldApiClient, PlayerWorldView, BuildingKey, TeamTemplate, MarchView, OccupationView,
} from '../net/WorldApiClient';
import { teamSlotId, teamSlotName, TEAM_CAP } from './TeamsScene';
import {
  BUILDING_KEYS,
  RESOURCE_TYPES,
  DESK_MAX_LEVEL,
  BUILD_SPEEDUP_SECS_PER_COIN,
  CABINET_CAP_STEP,
  DRILL_TROOPCAP_STEP,
  DRILL_TRAIN_SPEED_STEP,
  baseDurabilityMax,
  ACADEMY_HP_STEP,
  ACADEMY_DAMAGE_STEP,
  SATCHEL_CARRY_STEP,
  buildingLevel,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingYieldMult,
  buildingSelfYield,
  resourceCapFor,
  troopCapFor,
  trainQueueMaxFor,
  satchelCarryCapFor,
  type ResourceType,
} from '@nw/shared';
import { BusyTracker } from '../ui/busyTracker';
import { buildDecorCLayer } from '../render/decorCLayer';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { buildIcon, type IconKind } from '../render/icons';
import { loadResAtlas, getResTexture } from '../render/resAtlasLoader';

// ── Public interface ─────────────────────────────────────────────────────────

export interface CitySceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** Called after a successful troop training to keep map troop count fresh. */
  onTrainTroops?(qty: number): Promise<PlayerWorldView>;
  onSpeedupTraining?(coins: number): Promise<PlayerWorldView>;
  getCoins?(): number;
  /** Tapping a team card on the military page opens that team's formation editor (D-CITY-10). */
  onEditTeam?(teamId: string, teamName: string): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const RES_COLORS: Readonly<Record<ResourceType, number>> = {
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

// Card-grid sizing — matches the CardScene/Skins wardrobe language (dynamic
// column count from a target width, rather than CityScene's old fixed 4-col table).
const CARD_GAP = 12;
const CARD_W_TARGET = 222;
const CARD_H = 192;
const GRID_PAD = 8;

// D-CITY-12: academy is pulled out of the domestic building grid into its own
// standalone tech-tree panel on the military page (see renderMilitaryPage).
const DOMESTIC_BUILDING_KEYS: readonly BuildingKey[] = BUILDING_KEYS.filter((k) => k !== 'academy');

// Team panel (D-CITY-10) — 2-col card grid; tapping a card opens that team's formation editor.
const TEAM_COLS = 2;
const TEAM_CARD_H = 144;

// ── CityScene ────────────────────────────────────────────────────────────────

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

type CityPage = 'domestic' | 'military';

export class CityScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: CitySceneCallbacks;

  private readonly bt = new BusyTracker();
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async load() re-render can't paint into a torn-down container. */
  private destroyed = false;

  private me: PlayerWorldView | null = null;
  private teams: TeamTemplate[] = [];
  private marches: MarchView[] = [];
  private occupations: OccupationView[] = [];
  private page: CityPage = 'domestic';
  /** Left edge of the body content, set each render() to sidebarNavW() — the vertical tab
   *  rail sits at x=0..contentX, left of the binding line, matching the roster/equipment
   *  card-scene sidebar-nav convention (HubTabs.ts drawSidebarTabs). */
  private contentX = 0;
  private selectedBuilding: BuildingKey | null = null;
  private toast: string | null = null;
  private toastColor: number = C.red;
  private toastTimer = 0;

  // Building-grid scroll state (drag-to-scroll, matches the CardScene/TeamsScene pattern).
  private scrollY = 0;
  private scrollMax = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a building cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — avoids a render() per pointermove (jank). */
  private scrollDirty = false;

  constructor(layout: ILayout, input: InputManager, cb: CitySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.render();
    void this.load();
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    // Refresh countdown display for build queue every second
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    for (const unsub of this.unsubs) unsub();
    this.container.destroy({ children: true });
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    // Resource / producer-building glyphs reuse the res_atlas motifs; re-render once decoded.
    void loadResAtlas().then(() => this.render()).catch(() => { /* color/emoji fallback */ });
    try {
      const [me, teams, marches, occupations] = await Promise.all([
        this.cb.worldApi.getMe(this.cb.worldId),
        this.cb.worldApi.getTeams(this.cb.worldId),
        this.cb.worldApi.getMarches(this.cb.worldId),
        this.cb.worldApi.getOccupations(this.cb.worldId),
      ]);
      this.me = me;
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
  private resIcon(rt: ResourceType, size: number): PIXI.DisplayObject {
    const tex = getResTexture(rt);
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.width = sp.height = size;
      return sp;
    }
    return txt(RES_ICON[rt], snapFont(Math.round(size * 0.85)), C.dark);
  }

  /** Building glyph: producer→res_atlas motif, others→icons.ts line-art, emoji as last resort. */
  private bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
    const res = BLD_RES[key];
    if (res) return this.resIcon(res, size);
    const kind = BLD_GLYPH[key];
    if (kind) return buildIcon(kind, size, color);
    return txt(BLD_ICON[key], snapFont(Math.round(size * 0.85)), color);
  }

  private async doUpgrade(key: BuildingKey): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    this.render();
    try {
      this.me = await this.cb.worldApi.upgradeBuilding(this.cb.worldId, key);
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

  private async doSpeedup(key: BuildingKey): Promise<void> {
    if (this.bt.busy) return;
    const entry = this.me?.buildQueue?.find(q => q.key === key);
    if (!entry) return;
    const secsLeft = Math.max(0, Math.ceil((entry.completeAt - Date.now()) / 1000));
    const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
    this.bt.start();
    this.render();
    try {
      this.me = await this.cb.worldApi.speedupBuild(this.cb.worldId, key, coins);
      this.showToast(t('city.speedupDone'), C.green as number);
    } catch {
      this.showToast(t('city.err.generic'), C.red as number);
    } finally {
      this.bt.stop();
    }
    this.render();
  }

  private showToast(msg: string, color: number = C.red as number): void {
    this.toast = msg;
    this.toastColor = color;
    this.toastTimer = 2.5;
    this.render();
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

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    // Draw the red binding line at the tab rail's right edge (railX) instead of the default
    // 9%-of-width position — otherwise the 20%-wide sidebar rail overhangs the line and the
    // Domestic/Military tabs cross it. Matches every other sidebar scene (CardScene/Equipment/…).
    const railX = sidebarNavW(w, h, this.landscape);
    this.container.addChild(buildPaperBackground('citybg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t(`city.page.${this.page}` as 'city.page.domestic'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    const backHit: Hit = { x: hdr.backRect.x, y: hdr.backRect.y, w: hdr.backRect.w, h: hdr.backRect.h, fn: () => this.cb.onBack() };
    this.hits.push(backHit);

    const y = hdr.headerH + 8;
    this.contentX = this.renderPageTabs(y);

    if (this.page === 'domestic') {
      // Resource bar
      let cy = this.renderResourceBar(y);
      cy += 8;

      // Build queue strip
      cy = this.renderBuildQueue(cy);
      cy += 8;

      // Building card grid (scrollable)
      this.renderBuildingGrid(cy);
    } else {
      this.scrollMax = 0;
      this.renderMilitaryPage(y);
    }

    // Detail modal (popup-scale-to-80% convention, tap-outside-to-close). The page content
    // sits dimmed underneath — drop its hits (keeping only Back) so a tap there can't
    // silently switch buildings or trigger speedup instead of dismissing the modal. Shared
    // across both pages: the military page's tech-tree panel (academy) opens it too.
    if (this.selectedBuilding) {
      this.hits = [backHit];
      this.renderDetailModal(this.selectedBuilding);
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

    // Toast
    if (this.toast !== null) {
      const tw = Math.min(w - 40, 720);
      const th = 84;
      const tg = sketchPanel(tw, th, { fill: C.dark, fillAlpha: 0.88, border: this.toastColor, width: 1, seed: 7 });
      tg.x = (w - tw) / 2;
      tg.y = Math.round(h * 2 / 3 - th / 2);
      this.container.addChild(tg);
      const tl = txt(this.toast, FS.headline, 0xffffff);
      tl.x = tg.x + 24;
      tl.y = tg.y + 22;
      this.container.addChild(tl);
    }
  }

  // ── Page tabs (D-CITY-11: 内政 / 军事 switch) ────────────────────────────────

  private switchPage(page: CityPage): void {
    if (this.page === page) return;
    this.page = page;
    this.scrollY = 0;
    this.render();
  }

  /** Draws the Domestic/Military rail left of the binding line (roster/equipment sidebar-nav
   *  convention) and returns the rail width — the x-offset where body content starts. */
  private renderPageTabs(startY: number): number {
    const { w, h, landscape } = this;
    const railW = sidebarNavW(w, h, landscape);
    const pages: CityPage[] = ['domestic', 'military'];
    const tabs: HubTab[] = pages.map((page) => ({
      label: t(`city.tab.${page}` as 'city.tab.domestic'),
      active: this.page === page,
    }));
    const { hits } = drawSidebarTabs(this.container, railW, startY, h, tabs, (i) => this.switchPage(pages[i]!));
    for (const hit of hits) {
      this.hits.push({ x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h, fn: hit.fn });
    }
    return railW;
  }

  // ── Military page (D-CITY-11 tab container) ──────────────────────────────────
  // Durability panel (D-CITY-8), tech-tree panel (D-CITY-12) and team panel
  // (D-CITY-10) are all implemented below.

  private renderMilitaryPage(startY: number): void {
    startY = this.renderDurabilityPanel(startY);
    startY = this.renderTechTreePanel(startY);

    const sectionLbl = txt(t('city.military.teams'), FS.bodyLg, C.mid, true);
    sectionLbl.x = this.contentX + 18;
    sectionLbl.y = startY;
    this.container.addChild(sectionLbl);
    this.renderTeamPanel(startY + 30);
  }

  // D-CITY-8: main-base durability panel — a persistent, self-healing HP bar for the
  // player's own base, capped by the `wall` building's level (baseDurabilityMax). Reads
  // `me.hp`/`me.maxHp` (same field names/semantics as WorldMapView's tile HP bar); falls
  // back to a full bar derived from the current wall level when the server hasn't resolved
  // a main-base anchor yet (e.g. brand-new account mid-joinWorld race).
  private renderDurabilityPanel(startY: number): number {
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const bld = this.me?.buildings;
    const maxHp = this.me?.maxHp ?? baseDurabilityMax(buildingLevel(bld, 'wall'));
    const hp = this.me?.hp ?? maxHp;
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;

    const panH = 84;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 11) });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.container.addChild(pg);

    const icon = this.bldIcon('wall', 42, C.dark);
    icon.x = cx0 + 20;
    icon.y = startY + (panH - 42) / 2;
    this.container.addChild(icon);

    const titleLbl = txt(t('city.military.durability'), FS.bodyLg, C.dark, true);
    titleLbl.x = cx0 + 84;
    titleLbl.y = startY + 13;
    this.container.addChild(titleLbl);

    const valLbl = txt(`${this.fmtNum(hp)} / ${this.fmtNum(maxHp)}`, FS.body, C.mid);
    valLbl.x = cx0 + 84;
    valLbl.y = startY + 45;
    this.container.addChild(valLbl);

    const barX = cx0 + 84 + Math.max(135, valLbl.width + 24);
    const barW = Math.max(20, cx0 + w - barX - 16);
    const barH = 15;
    const barY = startY + (panH - barH) / 2;

    const track = new PIXI.Graphics();
    track.beginFill(0x2a1e12, 0.15);
    track.drawRoundedRect(barX, barY, barW, barH, 3);
    track.endFill();
    this.container.addChild(track);

    // Green (healthy) → amber (mid) → red (low) — mirrors the world-map tile HP bar
    // (worldmap/tileGraphics.ts drawHpBar) so the color language is consistent everywhere.
    const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
    const fill = new PIXI.Graphics();
    fill.beginFill(fillColor, 0.9);
    fill.drawRoundedRect(barX, barY, Math.max(2, barW * ratio), barH, 3);
    fill.endFill();
    this.container.addChild(fill);

    return startY + panH + 8;
  }

  /** Current order tying up a team, if any — mirrors TeamsScene.teamOrder (server's TEAM_BUSY predicate). */
  private teamOrder(teamId: string): { march: MarchView } | { occ: OccupationView } | null {
    const march = this.marches.find(m => m.mine !== false && m.teamId === teamId);
    if (march) return { march };
    const occ = this.occupations.find(o => o.teamId === teamId);
    if (occ) return { occ };
    return null;
  }

  /** Total troops committed across a team's cards — mirrors TeamsScene.committedTroops. */
  private committedTroops(army: TeamTemplate['army']): number {
    const cardState = this.me?.cardState ?? {};
    let total = 0;
    for (const entry of army) {
      const cid = entry.cardInstanceId;
      total += cid ? (cardState[cid]?.currentTroops ?? 0) : Math.max(0, Math.floor(entry.initialHp ?? 0));
    }
    return total;
  }

  /** 2-col grid of the 5 team slots; each card taps through to the team formation editor. */
  private renderTeamPanel(startY: number): void {
    const { h } = this;
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const availW = w - GRID_PAD * 2;
    const cellW = Math.floor((availW - (TEAM_COLS - 1) * CARD_GAP) / TEAM_COLS);
    const rows = Math.ceil(TEAM_CAP / TEAM_COLS);
    const contentH = rows * TEAM_CARD_H + (rows - 1) * CARD_GAP;

    const viewY = startY;
    const viewH = Math.max(0, h - viewY - GRID_PAD);
    this.scrollMax = Math.max(0, contentH - viewH);
    if (this.scrollY > this.scrollMax) this.scrollY = this.scrollMax;

    const gridLayer = new PIXI.Container();
    gridLayer.x = cx0;
    gridLayer.y = viewY - this.scrollY;
    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRect(cx0, viewY, w, viewH).endFill();
    this.container.addChild(maskG);
    gridLayer.mask = maskG;
    this.container.addChild(gridLayer);

    const now = Date.now();
    for (let i = 0; i < TEAM_CAP; i++) {
      const col = i % TEAM_COLS;
      const row = Math.floor(i / TEAM_COLS);
      const cx = GRID_PAD + col * (cellW + CARD_GAP);
      const cy = row * (TEAM_CARD_H + CARD_GAP);
      this.renderTeamCard(i, cx, cy, cellW, gridLayer, now, viewY, viewH);
    }

    drawScrollIndicator(this.container, { x: cx0, y: viewY, w, h: viewH }, this.scrollY, this.scrollMax);
  }

  private renderTeamCard(i: number, x: number, y: number, cardW: number, layer: PIXI.Container, now: number, viewY: number, viewH: number): void {
    const id = teamSlotId(i);
    const team = this.teams.find(tm => tm.id === id);
    const filled = !!team && team.army.length > 0;
    const injuredUntil = this.me?.teamState?.[id]?.injuredUntil ?? 0;
    const injured = injuredUntil > now;
    const order = this.teamOrder(id);
    const pad = 12;

    const border = injured ? C.red : (order ? C.gold : (filled ? C.accent : C.mid));
    const panel = sketchPanel(cardW, TEAM_CARD_H, {
      fill: filled ? 0xfaf9f5 : C.paper, border, width: filled ? 2 : 1.2, seed: seedFor(x, y, cardW),
    });
    panel.x = x;
    panel.y = y;
    layer.addChild(panel);

    const name = txt(team?.name || teamSlotName(i), FS.bodyLg, C.dark, true);
    name.x = x + pad;
    name.y = y + pad;
    layer.addChild(name);

    let statusLbl: string;
    let statusColor: number;
    if (injured) {
      const secsLeft = Math.ceil((injuredUntil - now) / 1000);
      const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
      statusLbl = t('roster.injured').replace('{time}', timeStr);
      statusColor = C.red as number;
    } else if (order) {
      const remaining = Math.max(0, Math.ceil((('march' in order ? order.march.arriveAt : order.occ.dueAt) - now) / 1000));
      const timeStr = remaining >= 60 ? `${Math.ceil(remaining / 60)}m` : `${remaining}s`;
      statusLbl = 'march' in order
        ? t('world.team.marching')
        : t('world.team.occupying').replace('{time}', timeStr);
      statusColor = C.gold as number;
    } else if (filled) {
      statusLbl = t('city.military.teamIdle');
      statusColor = C.accent as number;
    } else {
      statusLbl = t('world.team.empty');
      statusColor = C.mid as number;
    }
    const statusTag = txt(statusLbl, FS.body, statusColor, true);
    statusTag.x = x + pad;
    statusTag.y = y + pad + 30;
    layer.addChild(statusTag);

    if (filled) {
      const committed = this.committedTroops(team!.army);
      const sub = `${t('world.defense.garrison').replace('{n}', String(team!.army.length))}   ${t('world.team.committed').replace('{n}', String(committed))}`;
      const subLbl = txt(sub, FS.body, C.mid, false, cardW - pad * 2);
      subLbl.x = x + pad;
      subLbl.y = y + TEAM_CARD_H - pad - 21;
      layer.addChild(subLbl);
    }

    // Tap-to-edit: the card lives inside gridLayer (offset by viewY - scrollY), so the hit rect
    // is in absolute screen space and only registered while the card is within the viewport —
    // same convention as the building grid. Editing itself lives in the team formation editor.
    const screenY = viewY - this.scrollY + y;
    if (this.cb.onEditTeam && screenY + TEAM_CARD_H > viewY && screenY < viewY + viewH) {
      const teamName = team?.name || teamSlotName(i);
      this.hits.push({
        x, y: screenY, w: cardW, h: TEAM_CARD_H,
        fn: () => this.cb.onEditTeam!(id, teamName),
      });
    }
  }

  // D-CITY-12: academy promoted from an ordinary building-grid card to its own standalone
  // panel — a season-scoped blueprint buff deserves more ceremony than a generic card.
  // Injection logic (buildSiegeBlueprints) is unchanged; only the UI presentation moved.
  private renderTechTreePanel(startY: number): number {
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const bld = this.me?.buildings;
    const lvl = buildingLevel(bld, 'academy');
    const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === 'academy');
    const bonusLines = this.buildingBonusLines('academy', bld);

    const panH = 144;
    const pg = sketchPanel(w - 16, panH, {
      fill: C.paper, border: inQueue ? C.gold : C.line, width: inQueue ? 2 : 1, seed: seedFor(w, panH, 10),
    });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.container.addChild(pg);

    const icon = this.bldIcon('academy', 54, C.dark);
    icon.x = cx0 + 30;
    icon.y = startY + (panH - 54) / 2;
    this.container.addChild(icon);

    const titleLbl = txt(t('city.military.techTree'), FS.label, C.dark, true);
    titleLbl.x = cx0 + 102;
    titleLbl.y = startY + 18;
    this.container.addChild(titleLbl);

    const lvlLbl = txt(t('city.lvlLabel').replace('{lvl}', String(lvl)), FS.body, C.mid);
    lvlLbl.x = cx0 + 102 + titleLbl.width + 15;
    lvlLbl.y = startY + 21;
    this.container.addChild(lvlLbl);

    let bly = startY + 51;
    for (const line of bonusLines) {
      const bl = txt(line, FS.body, C.mid, false, w - 144);
      bl.x = cx0 + 102;
      bl.y = bly;
      this.container.addChild(bl);
      bly += 24;
    }

    if (inQueue) {
      const qDot = buildIcon('hammer', 27, C.gold);
      qDot.x = cx0 + w - 60;
      qDot.y = startY + 18;
      this.container.addChild(qDot);
    }

    this.hits.push({
      x: cx0 + 8, y: startY, w: w - 16, h: panH,
      fn: () => { this.selectedBuilding = 'academy'; this.render(); },
    });

    return startY + panH + 8;
  }

  // ── Resource bar ──────────────────────────────────────────────────────────

  private renderResourceBar(startY: number): number {
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const bld = this.me?.buildings;
    const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;

    const panH = 108;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 3) });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.container.addChild(pg);

    const cellW = Math.floor((w - 16) / 5);
    RESOURCE_TYPES.forEach((rt, i) => {
      const cx = cx0 + 8 + i * cellW;
      const cur = resources?.[rt] ?? 0;
      const cap = resourceCapFor(bld);
      const yld = buildingYieldMult(bld, rt);
      const self = buildingSelfYield(bld, rt);

      // Color accent bar
      const ab = new PIXI.Graphics();
      ab.beginFill(RES_COLORS[rt], 0.45);
      ab.drawRect(cx + 9, startY + 6, cellW - 18, 10);
      ab.endFill();
      this.container.addChild(ab);

      const icon = this.resIcon(rt, 33);
      icon.x = cx + 12;
      icon.y = startY + 24;
      this.container.addChild(icon);

      const curLbl = txt(this.fmtNum(cur), FS.label, C.dark, true);
      curLbl.x = cx + 52;
      curLbl.y = startY + 24;
      this.container.addChild(curLbl);

      const capLbl = txt(`/${this.fmtNum(cap)}`, FS.small, C.mid);
      capLbl.x = cx + 12;
      capLbl.y = startY + 62;
      this.container.addChild(capLbl);

      const yldPct = Math.round(yld * 100);
      const yldStr = self > 0 ? `+${self}/h` : `×${yldPct}%`;
      const yldLbl = txt(yldStr, FS.small, C.mid);
      yldLbl.x = cx + 12;
      yldLbl.y = startY + 84;
      this.container.addChild(yldLbl);
    });

    return startY + panH + 4;
  }

  // ── Build queue ───────────────────────────────────────────────────────────

  private renderBuildQueue(startY: number): number {
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const queue = this.me?.buildQueue ?? [];
    const now = Date.now();

    const panH = queue.length > 0 ? 72 : 51;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 5) });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.container.addChild(pg);

    const hdr = txt(t('city.buildQueue'), FS.body, C.mid, true);
    hdr.x = cx0 + 24;
    hdr.y = startY + 14;
    this.container.addChild(hdr);

    if (queue.length === 0) {
      const empty = txt(t('city.queueEmpty'), FS.body, C.mid);
      empty.x = cx0 + 195;
      empty.y = startY + 14;
      this.container.addChild(empty);
    } else {
      const entry = queue[0]!;
      const secsLeft = Math.max(0, Math.ceil((entry.completeAt - now) / 1000));
      const name = t(`city.bld.${entry.key}` as 'city.bld.desk');
      const label = t('city.queueEntry')
        .replace('{name}', name)
        .replace('{to}', String(entry.toLevel))
        .replace('{sec}', formatDuration(secsLeft));

      const entryLbl = txt(label, FS.bodyLg, C.dark, true);
      entryLbl.x = cx0 + 195;
      entryLbl.y = startY + 14;
      this.container.addChild(entryLbl);

      if (secsLeft > 0) {
        const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
        const speedLabel = t('city.speedup').replace('{coins}', String(coins));
        this.addBtn(cx0 + w - 249, startY + 9, 228, 45, speedLabel, 0xffffff, C.gold, () => void this.doSpeedup(entry.key));
      }
    }

    return startY + panH + 4;
  }

  // ── Building grid ─────────────────────────────────────────────────────────

  private renderBuildingGrid(startY: number): void {
    const { h } = this;
    const cx0 = this.contentX;
    const w = this.w - cx0;
    const bld = this.me?.buildings;
    const keys = DOMESTIC_BUILDING_KEYS;

    const availW = w - GRID_PAD * 2;
    const cols = Math.max(1, Math.floor((availW + CARD_GAP) / (CARD_W_TARGET + CARD_GAP)));
    const cellW = Math.floor((availW - (cols - 1) * CARD_GAP) / cols);
    const rows = Math.ceil(keys.length / cols);
    const contentH = rows * CARD_H + (rows - 1) * CARD_GAP;

    const viewY = startY;
    const viewH = Math.max(0, h - viewY - GRID_PAD);
    this.scrollMax = Math.max(0, contentH - viewH);
    if (this.scrollY > this.scrollMax) this.scrollY = this.scrollMax;

    const gridLayer = new PIXI.Container();
    gridLayer.x = cx0;
    gridLayer.y = viewY - this.scrollY;
    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRect(cx0, viewY, w, viewH).endFill();
    this.container.addChild(maskG);
    gridLayer.mask = maskG;
    this.container.addChild(gridLayer);

    keys.forEach((key, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = GRID_PAD + col * (cellW + CARD_GAP);
      // Local to gridLayer (which is itself offset by viewY - scrollY), so this is NOT absolute screen space.
      const cy = row * (CARD_H + CARD_GAP);

      const lvl = buildingLevel(bld, key);
      const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === key);

      const bg = sketchPanel(cellW, CARD_H, {
        fill: C.paper,
        border: inQueue ? C.gold : C.line,
        width: inQueue ? 2 : 1,
        seed: seedFor(cx, cy, i),
      });
      bg.x = cx;
      bg.y = cy;
      gridLayer.addChild(bg);

      const icon = this.bldIcon(key, 60, C.dark);
      icon.x = cx + (cellW - 60) / 2;
      icon.y = cy + 18;
      gridLayer.addChild(icon);

      const nameLbl = txt(t(`city.bld.${key}` as 'city.bld.desk'), FS.body, C.dark, true, cellW - 18);
      nameLbl.x = cx + 9;
      nameLbl.y = cy + 90;
      gridLayer.addChild(nameLbl);

      const lvlLbl = txt(t('city.lvlLabel').replace('{lvl}', String(lvl)), FS.body, C.mid);
      lvlLbl.x = cx + 9;
      lvlLbl.y = cy + CARD_H - 33;
      gridLayer.addChild(lvlLbl);

      if (inQueue) {
        const qDot = buildIcon('hammer', 24, C.gold);
        qDot.x = cx + cellW - 36;
        qDot.y = cy + 12;
        gridLayer.addChild(qDot);
      }

      // Hit rect in absolute screen space (gridLayer's local `cy` + its own viewY/scroll offset) —
      // only reachable while the card is actually within the visible viewport.
      const screenY = viewY - this.scrollY + cy;
      if (screenY + CARD_H > viewY && screenY < viewY + viewH) {
        this.hits.push({
          x: cx0 + cx, y: screenY, w: cellW, h: CARD_H,
          fn: () => { this.selectedBuilding = key; this.render(); },
        });
      }
    });

    drawScrollIndicator(this.container, { x: cx0, y: viewY, w, h: viewH }, this.scrollY, this.scrollMax);
  }

  // ── Detail modal ──────────────────────────────────────────────────────────

  private renderDetailModal(key: BuildingKey): void {
    const { w, h } = this;
    const bld = this.me?.buildings;
    const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;

    const lvl = buildingLevel(bld, key);
    const toLevel = lvl + 1;
    const gateReason = buildGateReason(bld, key, toLevel);
    const cost = buildCost(key, toLevel);
    const timeSec = buildTimeSec(key, toLevel);
    const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === key);
    const canAfford = !gateReason && Object.entries(cost).every(
      ([rt, need]) => (resources?.[rt as ResourceType] ?? 0) >= (need ?? 0)
    );
    const atMax = lvl >= DESK_MAX_LEVEL && key === 'desk';

    // Natural (unscaled) content size — laid out in a local frame, then scaled to
    // fill 80% of the constrained screen axis (popup-scale-to-80% convention).
    const bonusLines = this.buildingBonusLines(key, bld);
    const mw = Math.min(340, w - 24);
    const costEntries = RESOURCE_TYPES.map((rt) => ({ rt, need: cost[rt] ?? 0 })).filter((e) => e.need > 0);
    const contentH = 12 + 28 + bonusLines.length * 16 + 4
      + (atMax ? 20 : (16 + (costEntries.length > 0 ? 16 : 0) + 24 + 36))
      + (key === 'drillYard' ? 24 : 0)
      + 12;
    const mh = Math.min(contentH, h - 16);

    const scale = this.landscape ? (h * 0.8) / mh : (w * 0.8) / mw;
    const screenW = mw * scale;
    const screenH = mh * scale;
    const screenX = (w - screenW) / 2;
    const screenY = Math.max(8, (h - screenH) / 2);

    // Dim covers the full screen; tapping it (outside interactive rects) closes the modal.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    this.container.addChild(dim);

    const panelRoot = new PIXI.Container();
    panelRoot.position.set(screenX, screenY);
    panelRoot.scale.set(scale);
    this.container.addChild(panelRoot);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(0, 5, mw) });
    panelRoot.addChild(panel);

    let iy = 12;

    // Header — building glyph + name + level.
    const hIcon = this.bldIcon(key, 22, C.dark);
    hIcon.x = 10;
    hIcon.y = iy - 2;
    panelRoot.addChild(hIcon);
    const hdrTxt = txt(`${t(`city.bld.${key}` as 'city.bld.desk')} ${t('city.lvlLabel').replace('{lvl}', String(lvl))}`, FS.small, C.dark, true);
    hdrTxt.x = 38;
    hdrTxt.y = iy;
    panelRoot.addChild(hdrTxt);
    iy += 28;

    for (const line of bonusLines) {
      const bl = txt(line, FS.tiny, C.mid);
      bl.x = 10;
      bl.y = iy;
      panelRoot.addChild(bl);
      iy += 16;
    }
    iy += 4;

    if (atMax) {
      const ml = txt(t('city.maxLevel'), FS.tiny, C.mid, true);
      ml.x = 10;
      ml.y = iy;
      panelRoot.addChild(ml);
    } else {
      const nextHdr = txt(`→ Lv.${toLevel}`, FS.tiny, C.mid);
      nextHdr.x = 10;
      nextHdr.y = iy;
      panelRoot.addChild(nextHdr);
      iy += 16;

      if (costEntries.length > 0) {
        const costLbl = txt(t('city.costLabel'), FS.tiny, C.dark);
        costLbl.x = 10;
        costLbl.y = iy;
        panelRoot.addChild(costLbl);
        let cxp = 10 + costLbl.width + 6;
        for (const { rt, need } of costEntries) {
          const ok = (resources?.[rt] ?? 0) >= need;
          const mi = this.resIcon(rt, 15);
          mi.x = cxp;
          mi.y = iy - 1;
          panelRoot.addChild(mi);
          cxp += 17;
          const nl = txt(this.fmtNum(need), FS.tiny, ok ? C.dark : C.red);
          nl.x = cxp;
          nl.y = iy;
          panelRoot.addChild(nl);
          cxp += nl.width + 8;
        }
        iy += 16;
      }

      const timeLbl = txt(t('city.timeLabel') + formatDuration(timeSec), FS.tiny, C.mid);
      timeLbl.x = 10;
      timeLbl.y = iy;
      panelRoot.addChild(timeLbl);
      iy += 24;

      if (gateReason?.includes('desk')) {
        const gl = txt(t('city.deskGate').replace('{lvl}', String(toLevel)), FS.tiny, C.red);
        gl.x = 10;
        gl.y = iy;
        panelRoot.addChild(gl);
      } else if (inQueue) {
        const ql = txt(t('city.upgrading'), FS.tiny, C.gold, true);
        ql.x = 10;
        ql.y = iy;
        panelRoot.addChild(ql);
      } else {
        const btnRectLocal = { x: 10, y: iy, w: mw - 20, h: 32 };
        const g = sketchPanel(btnRectLocal.w, btnRectLocal.h, {
          fill: canAfford ? C.paper : C.btnDis, border: C.line, width: 1, seed: seedFor(btnRectLocal.x, btnRectLocal.y, btnRectLocal.w),
        });
        g.x = btnRectLocal.x;
        g.y = btnRectLocal.y;
        panelRoot.addChild(g);
        const lbl = txt(t('city.upgrade'), FS.tiny, canAfford ? C.dark : C.mid, true);
        lbl.x = btnRectLocal.x + 8;
        lbl.y = btnRectLocal.y + (btnRectLocal.h - 16) / 2;
        panelRoot.addChild(lbl);

        const screenRect = this.toScreen(btnRectLocal, screenX, screenY, scale);
        this.hits.push({
          x: screenRect.x, y: screenRect.y, w: screenRect.w, h: screenRect.h,
          fn: canAfford ? () => void this.doUpgrade(key) : () => this.showToast(t('city.err.noResources'), C.red),
        });
        iy += 36;
      }
    }

    // DrillYard special: show troop cap info
    if (key === 'drillYard') {
      const tc = troopCapFor(bld);
      const ts = this.me?.troops ?? 0;
      const troopLbl = txt(t('city.troopCap').replace('{cur}', String(ts)).replace('{cap}', String(tc)), FS.tiny, C.mid);
      troopLbl.x = 10;
      troopLbl.y = iy;
      panelRoot.addChild(troopLbl);
    }

    // Close on tap-outside — pushed LAST so panel buttons above take priority.
    this.hits.push({ x: 0, y: 0, w, h, fn: () => { this.selectedBuilding = null; this.render(); } });
  }

  /** Convert a rect drawn in the modal's local (unscaled) frame into real screen space. */
  private toScreen(r: { x: number; y: number; w: number; h: number }, originX: number, originY: number, scale: number): { x: number; y: number; w: number; h: number } {
    return { x: originX + r.x * scale, y: originY + r.y * scale, w: r.w * scale, h: r.h * scale };
  }

  // ── Building bonus description lines ─────────────────────────────────────

  private buildingBonusLines(key: BuildingKey, bld: Partial<Record<BuildingKey, number>> | undefined): string[] {
    const lvl = buildingLevel(bld, key);
    const lines: string[] = [];
    switch (key) {
      case 'desk':
        lines.push(t('city.bonusGateMaster'));
        break;
      case 'inkPot':
        lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'ink') * 100))));
        break;
      case 'paperTray':
        lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'paper') * 100))));
        break;
      case 'graphiteMill':
        lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'graphite') * 100))));
        break;
      case 'metalForge':
        lines.push(t('city.bonusYield').replace('{pct}', String(Math.round(buildingYieldMult(bld, 'metal') * 100))));
        break;
      case 'stickerShop': {
        const s = buildingSelfYield(bld, 'sticker');
        lines.push(t('city.bonusSelf').replace('{n}', this.fmtNum(s)));
        break;
      }
      case 'cabinet': {
        const capPct = Math.round((1 + lvl * CABINET_CAP_STEP) * 100);
        lines.push(t('city.bonusCap').replace('{pct}', String(capPct)));
        break;
      }
      case 'drillYard':
        lines.push(t('city.bonusTroopCap').replace('{n}', String(lvl * DRILL_TROOPCAP_STEP)));
        lines.push(t('city.bonusTrainSpeed').replace('{pct}', String(Math.round(lvl * DRILL_TRAIN_SPEED_STEP * 100))));
        lines.push(t('city.bonusQueueSlots').replace('{n}', String(trainQueueMaxFor(bld))));
        break;
      case 'wall': {
        // D-CITY-8: wall no longer buffs battle-time garrison HP — it caps the base's persistent, self-healing durability instead.
        lines.push(t('city.bonusWallHp').replace('{n}', String(baseDurabilityMax(lvl))));
        break;
      }
      case 'academy': {
        const hpPct = Math.round(lvl * ACADEMY_HP_STEP * 100);
        const dmgPct = Math.round(lvl * ACADEMY_DAMAGE_STEP * 100);
        if (hpPct > 0) lines.push(t('city.bonusAcademyHp').replace('{pct}', String(hpPct)));
        if (dmgPct > 0) lines.push(t('city.bonusAcademyDmg').replace('{pct}', String(dmgPct)));
        break;
      }
      case 'satchel':
        lines.push(t('city.bonusSatchel').replace('{n}', String(satchelCarryCapFor(bld))));
        break;
    }
    return lines;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private addBtn(
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

  private fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
    return String(Math.floor(n));
  }
}
