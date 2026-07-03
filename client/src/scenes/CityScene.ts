// CityScene — Home-city management (SLG_CITY_DESIGN P1).
// Entry: WorldMapScene taps own base tile → "Enter Desk".
// Layout: paper background + top resource bar (5 resources) +
//   building grid (P1 keys) + detail panel (tap a building) +
//   build queue strip + back button.
// Troop training is surfaced via the drillYard detail panel (replaces
// the WorldMapScene train button for users who enter city).

import * as PIXI from 'pixi.js-legacy';
import type { Scene } from './SceneManager';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import {
  ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren,
} from '../render/sketchUi';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../net/WorldApiClient';
import {
  BUILDING_KEYS,
  RESOURCE_TYPES,
  DESK_MAX_LEVEL,
  BUILD_SPEEDUP_SECS_PER_COIN,
  buildingLevel,
  deskLevel,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingYieldMult,
  buildingSelfYield,
  resourceCapFor,
  troopCapFor,
  drillTrainMult,
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

  private me: PlayerWorldView | null = null;
  private selectedBuilding: BuildingKey | null = null;
  private toast: string | null = null;
  private toastColor: number = C.red;
  private toastTimer = 0;

  constructor(layout: ILayout, input: InputManager, cb: CitySceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.load();
  }

  update(dt: number): void {
    // Refresh countdown display for build queue every second
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    // Resource / producer-building glyphs reuse the res_atlas motifs; re-render once decoded.
    void loadResAtlas().then(() => this.render()).catch(() => { /* color/emoji fallback */ });
    try {
      this.me = await this.cb.worldApi.getMe(this.cb.worldId);
    } catch {
      /* use null — shows loading skeleton */
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
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;
    const bld = this.me?.buildings;

    this.container.addChild(buildPaperBackground('citybg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // Red margin line (art direction)
    const mg = new PIXI.Graphics();
    mg.lineStyle(2, C.margin, 1);
    mg.moveTo(48, 0).lineTo(48, h);
    this.container.addChild(mg);

    let y = 12;

    // Title
    const titleTxt = txt(t('city.title'), 18, C.dark, true);
    titleTxt.x = 56;
    titleTxt.y = y;
    this.container.addChild(titleTxt);

    // Back button
    this.addBtn(w - 80, y, 68, 26, t('city.back'), C.dark, C.paper, () => this.cb.onBack());
    y += 38;

    // Resource bar
    y = this.renderResourceBar(y);
    y += 8;

    // Build queue strip
    y = this.renderBuildQueue(y);
    y += 8;

    // Building grid
    const gridBottom = this.renderBuildingGrid(y);

    // Detail panel (right side in landscape, bottom in portrait)
    if (this.selectedBuilding) {
      if (this.landscape) {
        this.renderDetailPanel(Math.floor(w * 0.55), 100, Math.floor(w * 0.42), h - 110);
      } else {
        this.renderDetailPanel(8, gridBottom + 8, w - 16, h - gridBottom - 16);
      }
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

    const panH = 58;
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
      ab.beginFill(RES_COLORS[rt], 0.4);
      ab.drawRect(cx + 4, startY + 2, cellW - 8, 6);
      ab.endFill();
      this.container.addChild(ab);

      const icon = this.resIcon(rt, 16);
      icon.x = cx + 6;
      icon.y = startY + 9;
      this.container.addChild(icon);

      const curLbl = txt(this.fmtNum(cur), 11, C.dark, true);
      curLbl.x = cx + 6;
      curLbl.y = startY + 26;
      this.container.addChild(curLbl);

      const capLbl = txt(`/${this.fmtNum(cap)}`, 9, C.mid);
      capLbl.x = cx + 6;
      capLbl.y = startY + 40;
      this.container.addChild(capLbl);

      const yldPct = Math.round(yld * 100);
      const yldStr = self > 0 ? `+${self}/h` : `×${yldPct}%`;
      const yldLbl = txt(yldStr, 9, C.mid);
      yldLbl.x = cx + 6;
      yldLbl.y = startY + 50;
      this.container.addChild(yldLbl);
    });

    return startY + panH + 4;
  }

  // ── Build queue ───────────────────────────────────────────────────────────

  private renderBuildQueue(startY: number): number {
    const { w } = this;
    const queue = this.me?.buildQueue ?? [];
    const now = Date.now();

    const panH = queue.length > 0 ? 44 : 32;
    const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(w, panH, 5) });
    pg.x = 8;
    pg.y = startY;
    this.container.addChild(pg);

    const hdr = txt(t('city.buildQueue'), 11, C.mid);
    hdr.x = 16;
    hdr.y = startY + 8;
    this.container.addChild(hdr);

    if (queue.length === 0) {
      const empty = txt(t('city.queueEmpty'), 11, C.mid);
      empty.x = 120;
      empty.y = startY + 8;
      this.container.addChild(empty);
    } else {
      const entry = queue[0]!;
      const secsLeft = Math.max(0, Math.ceil((entry.completeAt - now) / 1000));
      const name = t(`city.bld.${entry.key}` as 'city.bld.desk');
      const label = t('city.queueEntry')
        .replace('{name}', name)
        .replace('{to}', String(entry.toLevel))
        .replace('{sec}', String(secsLeft));

      const entryLbl = txt(label, 12, C.dark);
      entryLbl.x = 120;
      entryLbl.y = startY + 8;
      this.container.addChild(entryLbl);

      if (secsLeft > 0) {
        const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
        const speedLabel = t('city.speedup').replace('{coins}', String(coins));
        this.addBtn(w - 150, startY + 4, 138, 24, speedLabel, 0xffffff, C.gold, () => void this.doSpeedup(entry.key));
      }
    }

    return startY + panH + 4;
  }

  // ── Building grid ─────────────────────────────────────────────────────────

  private renderBuildingGrid(startY: number): number {
    const { w, landscape } = this;
    const bld = this.me?.buildings;
    const keys = BUILDING_KEYS;

    const cols = landscape ? 4 : 4;
    const cellW = landscape ? Math.floor(w * 0.52 / cols) : Math.floor((w - 16) / cols);
    const cellH = 72;
    const gridW = cellW * cols;
    const gridX = 8;

    const rows = Math.ceil(keys.length / cols);

    keys.forEach((key, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = gridX + col * cellW;
      const cy = startY + row * cellH;

      const isSelected = this.selectedBuilding === key;
      const lvl = buildingLevel(bld, key);
      const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === key);

      const bg = sketchPanel(cellW - 4, cellH - 4, {
        fill: isSelected ? C.accent : C.paper,
        fillAlpha: isSelected ? 0.15 : 1,
        border: isSelected ? C.accent : C.line,
        width: isSelected ? 2 : 1,
        seed: seedFor(cx, cy, i),
      });
      bg.x = cx + 2;
      bg.y = cy + 2;
      this.container.addChild(bg);

      const icon = this.bldIcon(key, 22, isSelected ? C.accent : C.dark);
      icon.x = cx + 8;
      icon.y = cy + 6;
      this.container.addChild(icon);

      const nameLbl = txt(t(`city.bld.${key}` as 'city.bld.desk'), 10, isSelected ? C.accent : C.dark, isSelected);
      nameLbl.x = cx + 8;
      nameLbl.y = cy + 34;
      this.container.addChild(nameLbl);

      const lvlLbl = txt(t('city.lvlLabel').replace('{lvl}', String(lvl)), 10, C.mid);
      lvlLbl.x = cx + 8;
      lvlLbl.y = cy + 48;
      this.container.addChild(lvlLbl);

      if (inQueue) {
        const qDot = buildIcon('hammer', 14, C.gold);
        qDot.x = cx + cellW - 24;
        qDot.y = cy + 5;
        this.container.addChild(qDot);
      }

      this.hits.push({
        x: cx, y: cy, w: cellW, h: cellH,
        fn: () => {
          this.selectedBuilding = this.selectedBuilding === key ? null : key;
          this.render();
        },
      });
    });

    return startY + rows * cellH + 4;
  }

  // ── Detail panel ──────────────────────────────────────────────────────────

  private renderDetailPanel(px: number, py: number, panW: number, panH: number): void {
    const key = this.selectedBuilding;
    if (!key) return;
    const bld = this.me?.buildings;
    const resources = this.me?.resources as Partial<Record<ResourceType, number>> | undefined;

    const lvl = buildingLevel(bld, key);
    const toLevel = lvl + 1;
    const gateReason = buildGateReason(bld, key, toLevel);
    const cost = buildCost(key, toLevel);
    const timeSec = buildTimeSec(key, toLevel);
    const deskLvl = deskLevel(bld);
    const inQueue = (this.me?.buildQueue ?? []).some(q => q.key === key);
    const canAfford = !gateReason && Object.entries(cost).every(
      ([rt, need]) => (resources?.[rt as ResourceType] ?? 0) >= (need ?? 0)
    );

    const pg = sketchPanel(panW, panH, { fill: C.paper, border: C.line, width: 1, seed: seedFor(px, py, 9) });
    pg.x = px;
    pg.y = py;
    this.container.addChild(pg);

    let iy = py + 10;

    // Header — building glyph + name + level.
    const hIcon = this.bldIcon(key, 18, C.dark);
    hIcon.x = px + 10;
    hIcon.y = iy - 1;
    this.container.addChild(hIcon);
    const hdr = txt(`${t(`city.bld.${key}` as 'city.bld.desk')} ${t('city.lvlLabel').replace('{lvl}', String(lvl))}`, 14, C.dark, true);
    hdr.x = px + 32;
    hdr.y = iy;
    this.container.addChild(hdr);
    iy += 22;

    // Bonus description
    const bonusLines = this.buildingBonusLines(key, bld);
    for (const line of bonusLines) {
      const bl = txt(line, 11, C.mid);
      bl.x = px + 10;
      bl.y = iy;
      this.container.addChild(bl);
      iy += 16;
    }
    iy += 4;

    if (lvl >= DESK_MAX_LEVEL && key === 'desk') {
      const ml = txt(t('city.maxLevel'), 12, C.mid);
      ml.x = px + 10;
      ml.y = iy;
      this.container.addChild(ml);
      return;
    }

    // Next level header
    const nextHdr = txt(`→ Lv.${toLevel}`, 11, C.mid);
    nextHdr.x = px + 10;
    nextHdr.y = iy;
    this.container.addChild(nextHdr);
    iy += 16;

    // Cost — label, then each resource as a mini motif + amount (red when short).
    const costEntries = RESOURCE_TYPES
      .map((rt) => ({ rt, need: cost[rt] ?? 0 }))
      .filter((e) => e.need > 0);
    if (costEntries.length > 0) {
      const costLbl = txt(t('city.costLabel'), 11, C.dark);
      costLbl.x = px + 10;
      costLbl.y = iy;
      this.container.addChild(costLbl);
      let cxp = px + 10 + costLbl.width + 6;
      for (const { rt, need } of costEntries) {
        const ok = (resources?.[rt] ?? 0) >= need;
        const mi = this.resIcon(rt, 14);
        mi.x = cxp;
        mi.y = iy - 1;
        this.container.addChild(mi);
        cxp += 16;
        const nl = txt(this.fmtNum(need), 11, ok ? C.dark : C.red);
        nl.x = cxp;
        nl.y = iy;
        this.container.addChild(nl);
        cxp += nl.width + 8;
      }
      iy += 16;
    }

    // Time
    const timeLbl = txt(t('city.timeLabel') + this.fmtSec(timeSec), 11, C.mid);
    timeLbl.x = px + 10;
    timeLbl.y = iy;
    this.container.addChild(timeLbl);
    iy += 20;

    // Gate reason or upgrade button
    if (gateReason?.includes('desk')) {
      const gl = txt(t('city.deskGate').replace('{lvl}', String(toLevel)), 11, C.red);
      gl.x = px + 10;
      gl.y = iy;
      this.container.addChild(gl);
    } else if (inQueue) {
      const ql = txt(t('city.upgrading'), 12, C.gold);
      ql.x = px + 10;
      ql.y = iy;
      this.container.addChild(ql);
    } else {
      this.addBtn(
        px + 10, iy, panW - 20, 28,
        t('city.upgrade'),
        canAfford ? C.dark : C.mid,
        canAfford ? C.paper : C.btnDis,
        canAfford ? () => void this.doUpgrade(key) : () => this.showToast(t('city.err.noResources'), C.red),
      );
      iy += 32;
    }

    // DrillYard special: show troop cap info
    if (key === 'drillYard') {
      iy += 8;
      const tc = troopCapFor(bld);
      const ts = this.me?.troops ?? 0;
      const troopLbl = txt(t('city.troopCap').replace('{cur}', String(ts)).replace('{cap}', String(tc)), 11, C.mid);
      troopLbl.x = px + 10;
      troopLbl.y = iy;
      this.container.addChild(troopLbl);
    }
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
    const lbl = txt(label, 11, textColor);
    lbl.x = x + 6;
    lbl.y = y + (h - 14) / 2;
    this.container.addChild(lbl);
    this.hits.push({ x, y, w, h, fn });
  }

  private fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
    return String(Math.floor(n));
  }

  private fmtSec(sec: number): string {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }
}
