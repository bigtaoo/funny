// CityScene — Home-city management (SLG_CITY_DESIGN P1).
// Entry: WorldMapScene taps own base tile → "Enter Desk".
// Layout: shared SceneHeader (title + back) + resource bar + build-queue strip +
//   scrollable building card grid (matches the Roster/Skins/Teams card-grid
//   language) + tap-to-open detail modal (popup-scale-to-80% convention).
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
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { formatDuration } from './worldmap/formatDuration';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../net/WorldApiClient';
import {
  BUILDING_KEYS,
  RESOURCE_TYPES,
  DESK_MAX_LEVEL,
  BUILD_SPEEDUP_SECS_PER_COIN,
  buildingLevel,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingYieldMult,
  buildingSelfYield,
  resourceCapFor,
  troopCapFor,
  trainQueueMaxFor,
  type ResourceType,
} from '@nw/shared';
import { BusyTracker } from '../ui/busyTracker';
import { buildDecorCLayer } from '../render/decorCLayer';
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
const CARD_W_TARGET = 148;
const CARD_H = 128;
const GRID_PAD = 8;

// ── CityScene ────────────────────────────────────────────────────────────────

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

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
  private selectedBuilding: BuildingKey | null = null;
  private toast: string | null = null;
  private toastColor: number = C.red;
  private toastTimer = 0;

  // Building-grid scroll state (drag-to-scroll, matches the CardScene/TeamsScene pattern).
  private scrollY = 0;
  private scrollMax = 0;
  private dragStart: { y: number; scroll: number } | null = null;
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
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
    } catch {
      /* use null — shows loading state */
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
    return txt(RES_ICON[rt], Math.round(size * 0.85), C.dark);
  }

  /** Building glyph: producer→res_atlas motif, others→icons.ts line-art, emoji as last resort. */
  private bldIcon(key: BuildingKey, size: number, color: number): PIXI.DisplayObject {
    const res = BLD_RES[key];
    if (res) return this.resIcon(res, size);
    const kind = BLD_GLYPH[key];
    if (kind) return buildIcon(kind, size, color);
    return txt(BLD_ICON[key], Math.round(size * 0.85), color);
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
    for (const h of this.hits) {
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
        h.fn();
        return;
      }
    }
    if (!this.selectedBuilding) this.dragStart = { y: py, scroll: this.scrollY };
  }

  private handleMove(py: number): void {
    if (!this.dragStart || this.selectedBuilding) return;
    const dy = py - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragStart.scroll - dy));
      this.scrollDirty = true;
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('citybg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('city.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    const backHit: Hit = { x: hdr.backRect.x, y: hdr.backRect.y, w: hdr.backRect.w, h: hdr.backRect.h, fn: () => this.cb.onBack() };
    this.hits.push(backHit);

    let y = hdr.headerH + 8;

    // Resource bar
    y = this.renderResourceBar(y);
    y += 8;

    // Build queue strip
    y = this.renderBuildQueue(y);
    y += 8;

    // Building card grid (scrollable)
    this.renderBuildingGrid(y);

    // Detail modal (popup-scale-to-80% convention, tap-outside-to-close). The grid/queue
    // sit dimmed underneath — drop their hits (keeping only Back) so a tap there can't
    // silently switch buildings or trigger speedup instead of dismissing the modal.
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
      const lbl = txt('…', 28, 0xffffff, true);
      lbl.x = w / 2 - 10;
      lbl.y = h / 2 - 14;
      this.container.addChild(lbl);
    }

    // Toast
    if (this.toast !== null) {
      const tw = Math.min(w - 40, 320);
      const tg = sketchPanel(tw, 36, { fill: C.dark, fillAlpha: 0.88, border: this.toastColor, width: 1, seed: 7 });
      tg.x = (w - tw) / 2;
      tg.y = h - 60;
      this.container.addChild(tg);
      const tl = txt(this.toast, 13, 0xffffff);
      tl.x = tg.x + 10;
      tl.y = tg.y + 10;
      this.container.addChild(tl);
    }
  }

  // ── Resource bar ──────────────────────────────────────────────────────────

  private renderResourceBar(startY: number): number {
    const { w } = this;
    const bld = this.me?.buildings;
    const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;

    const panH = 72;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 3) });
    pg.x = 8;
    pg.y = startY;
    this.container.addChild(pg);

    const cellW = Math.floor((w - 16) / 5);
    RESOURCE_TYPES.forEach((rt, i) => {
      const cx = 8 + i * cellW;
      const cur = resources?.[rt] ?? 0;
      const cap = resourceCapFor(bld);
      const yld = buildingYieldMult(bld, rt);
      const self = buildingSelfYield(bld, rt);

      // Color accent bar
      const ab = new PIXI.Graphics();
      ab.beginFill(RES_COLORS[rt], 0.45);
      ab.drawRect(cx + 6, startY + 4, cellW - 12, 7);
      ab.endFill();
      this.container.addChild(ab);

      const icon = this.resIcon(rt, 22);
      icon.x = cx + 8;
      icon.y = startY + 15;
      this.container.addChild(icon);

      const curLbl = txt(this.fmtNum(cur), 15, C.dark, true);
      curLbl.x = cx + 34;
      curLbl.y = startY + 15;
      this.container.addChild(curLbl);

      const capLbl = txt(`/${this.fmtNum(cap)}`, 10, C.mid);
      capLbl.x = cx + 8;
      capLbl.y = startY + 40;
      this.container.addChild(capLbl);

      const yldPct = Math.round(yld * 100);
      const yldStr = self > 0 ? `+${self}/h` : `×${yldPct}%`;
      const yldLbl = txt(yldStr, 10, C.mid);
      yldLbl.x = cx + 8;
      yldLbl.y = startY + 54;
      this.container.addChild(yldLbl);
    });

    return startY + panH + 4;
  }

  // ── Build queue ───────────────────────────────────────────────────────────

  private renderBuildQueue(startY: number): number {
    const { w } = this;
    const queue = this.me?.buildQueue ?? [];
    const now = Date.now();

    const panH = queue.length > 0 ? 48 : 34;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 5) });
    pg.x = 8;
    pg.y = startY;
    this.container.addChild(pg);

    const hdr = txt(t('city.buildQueue'), 12, C.mid, true);
    hdr.x = 16;
    hdr.y = startY + 9;
    this.container.addChild(hdr);

    if (queue.length === 0) {
      const empty = txt(t('city.queueEmpty'), 12, C.mid);
      empty.x = 130;
      empty.y = startY + 9;
      this.container.addChild(empty);
    } else {
      const entry = queue[0]!;
      const secsLeft = Math.max(0, Math.ceil((entry.completeAt - now) / 1000));
      const name = t(`city.bld.${entry.key}` as 'city.bld.desk');
      const label = t('city.queueEntry')
        .replace('{name}', name)
        .replace('{to}', String(entry.toLevel))
        .replace('{sec}', formatDuration(secsLeft));

      const entryLbl = txt(label, 13, C.dark, true);
      entryLbl.x = 130;
      entryLbl.y = startY + 9;
      this.container.addChild(entryLbl);

      if (secsLeft > 0) {
        const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
        const speedLabel = t('city.speedup').replace('{coins}', String(coins));
        this.addBtn(w - 166, startY + 6, 152, 30, speedLabel, 0xffffff, C.gold, () => void this.doSpeedup(entry.key));
      }
    }

    return startY + panH + 4;
  }

  // ── Building grid ─────────────────────────────────────────────────────────

  private renderBuildingGrid(startY: number): void {
    const { w, h } = this;
    const bld = this.me?.buildings;
    const keys = BUILDING_KEYS;

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
    gridLayer.y = viewY - this.scrollY;
    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRect(0, viewY, w, viewH).endFill();
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

      const icon = this.bldIcon(key, 40, C.dark);
      icon.x = cx + (cellW - 40) / 2;
      icon.y = cy + 12;
      gridLayer.addChild(icon);

      const nameLbl = txt(t(`city.bld.${key}` as 'city.bld.desk'), 12, C.dark, true, cellW - 12);
      nameLbl.x = cx + 6;
      nameLbl.y = cy + 60;
      gridLayer.addChild(nameLbl);

      const lvlLbl = txt(t('city.lvlLabel').replace('{lvl}', String(lvl)), 11, C.mid);
      lvlLbl.x = cx + 6;
      lvlLbl.y = cy + CARD_H - 22;
      gridLayer.addChild(lvlLbl);

      if (inQueue) {
        const qDot = buildIcon('hammer', 16, C.gold);
        qDot.x = cx + cellW - 24;
        qDot.y = cy + 8;
        gridLayer.addChild(qDot);
      }

      // Hit rect in absolute screen space (gridLayer's local `cy` + its own viewY/scroll offset) —
      // only reachable while the card is actually within the visible viewport.
      const screenY = viewY - this.scrollY + cy;
      if (screenY + CARD_H > viewY && screenY < viewY + viewH) {
        this.hits.push({
          x: cx, y: screenY, w: cellW, h: CARD_H,
          fn: () => { this.selectedBuilding = key; this.render(); },
        });
      }
    });

    drawScrollIndicator(this.container, { x: 0, y: viewY, w, h: viewH }, this.scrollY, this.scrollMax);
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
    const hdrTxt = txt(`${t(`city.bld.${key}` as 'city.bld.desk')} ${t('city.lvlLabel').replace('{lvl}', String(lvl))}`, 16, C.dark, true);
    hdrTxt.x = 38;
    hdrTxt.y = iy;
    panelRoot.addChild(hdrTxt);
    iy += 28;

    for (const line of bonusLines) {
      const bl = txt(line, 12, C.mid);
      bl.x = 10;
      bl.y = iy;
      panelRoot.addChild(bl);
      iy += 16;
    }
    iy += 4;

    if (atMax) {
      const ml = txt(t('city.maxLevel'), 13, C.mid, true);
      ml.x = 10;
      ml.y = iy;
      panelRoot.addChild(ml);
    } else {
      const nextHdr = txt(`→ Lv.${toLevel}`, 12, C.mid);
      nextHdr.x = 10;
      nextHdr.y = iy;
      panelRoot.addChild(nextHdr);
      iy += 16;

      if (costEntries.length > 0) {
        const costLbl = txt(t('city.costLabel'), 12, C.dark);
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
          const nl = txt(this.fmtNum(need), 12, ok ? C.dark : C.red);
          nl.x = cxp;
          nl.y = iy;
          panelRoot.addChild(nl);
          cxp += nl.width + 8;
        }
        iy += 16;
      }

      const timeLbl = txt(t('city.timeLabel') + formatDuration(timeSec), 12, C.mid);
      timeLbl.x = 10;
      timeLbl.y = iy;
      panelRoot.addChild(timeLbl);
      iy += 24;

      if (gateReason?.includes('desk')) {
        const gl = txt(t('city.deskGate').replace('{lvl}', String(toLevel)), 12, C.red);
        gl.x = 10;
        gl.y = iy;
        panelRoot.addChild(gl);
      } else if (inQueue) {
        const ql = txt(t('city.upgrading'), 13, C.gold, true);
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
        const lbl = txt(t('city.upgrade'), 13, canAfford ? C.dark : C.mid, true);
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
      const troopLbl = txt(t('city.troopCap').replace('{cur}', String(ts)).replace('{cap}', String(tc)), 12, C.mid);
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
        const capPct = Math.round((1 + lvl * 0.1) * 100);
        lines.push(t('city.bonusCap').replace('{pct}', String(capPct)));
        break;
      }
      case 'drillYard':
        lines.push(t('city.bonusTroopCap').replace('{n}', String(lvl * 500)));
        lines.push(t('city.bonusTrainSpeed').replace('{pct}', String(Math.round(lvl * 4))));
        lines.push(t('city.bonusQueueSlots').replace('{n}', String(trainQueueMaxFor(bld))));
        break;
      case 'wall': {
        const wallPct = Math.round(lvl * 5);
        lines.push(t('city.bonusWallHp').replace('{pct}', String(wallPct)));
        break;
      }
      case 'academy': {
        const hpPct = Math.round(lvl * 2);
        const dmgPct = Math.round(lvl * 1.5);
        if (hpPct > 0) lines.push(t('city.bonusAcademyHp').replace('{pct}', String(hpPct)));
        if (dmgPct > 0) lines.push(t('city.bonusAcademyDmg').replace('{pct}', String(dmgPct)));
        break;
      }
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
    const lbl = txt(label, 12, textColor, true);
    lbl.x = x + 8;
    lbl.y = y + (h - 15) / 2;
    this.container.addChild(lbl);
    this.hits.push({ x, y, w, h, fn });
  }

  private fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
    return String(Math.floor(n));
  }
}
