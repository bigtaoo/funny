// EquipmentScene — 装备系统客户端 UI（E5，EQUIPMENT_DESIGN §11）。
// 两个 Tab：背包（库存 + 全局 loadout 三槽 + 实例详情：强化/穿戴/分解）/ 锻造（合成基础装备）。
// 仿 AuctionScene：静态 header + bodyLayer 重绘 + 拖拽滚动 + modal 叠层 + toast + 错误码映射。
//
// 服务器权威（L2）：扣材料/金币、强化掷骰、库存全在服务端；本场景只发意图、读回执，
// 据 equipmentDefs 镜像**预览**成本/成功率，真实结果以回推的 SaveData 为准。

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t, type TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../game/meta/SaveData';
import {
  EQUIPMENT_DEFS,
  craftableDefs,
  getEquipDef,
  enhanceSuccessRate,
  enhanceCost,
  salvageRefund,
  affixKind,
  EQUIP_MAX_LEVEL,
  EQUIPMENT_INV_CAP,
  SALVAGE_MAX_LEVEL,
  REFORGE_MATERIAL_RARITY,
  PROTECT_ENHANCE_ITEM_ID,
  type EnhanceCost,
} from '../game/meta/equipmentDefs';
import { ENHANCE_COEFF_PER_LEVEL } from '@nw/engine/balance/equipment';
import { drawEquipmentGlyph } from '../render/equipmentGlyph';
import { buildIcon, type IconKind } from '../render/icons';

export type EquipResult = { ok: true } | { ok: false; key: TranslationKey };
export type EnhanceResult =
  | { ok: true; success: boolean; level: number }
  | { ok: false; key: TranslationKey };

export interface EquipmentCallbacks {
  onBack(): void;
  /**
   * 养成分组同级直达（LOBBY_IA_REDESIGN P1.5）。仅在「养成」分组语境（从收藏进入）
   * 注入；注入后 header 下出现 [收藏|装备] tab 条，点收藏回养成。战役入口不注入 → 纯 back。
   */
  openCollection?(): void;
  /** 读当前权威存档（每次动作后服务器回推 → adoptServer，本场景重读重绘）。 */
  getSave(): SaveData;
  craft(defId: string): Promise<EquipResult>;
  /** useProtect=true 时消耗保护道具，失败不损材料（E7 §6.2）。 */
  enhance(instanceId: string, useProtect?: boolean): Promise<EnhanceResult>;
  salvage(instanceIds: string[]): Promise<EquipResult>;
  equip(slot: EquipSlot, instanceId: string | null): Promise<EquipResult>;
  /** 洗练（E6）：消耗 materialId 件，重 roll targetId 的副词条。 */
  reforge(targetId: string, materialId: string): Promise<EquipResult>;
}

type EquipTab = 'inv' | 'craft';

const HUD_H = 50;
const TAB_H = 36;
const RES_H = 30;       // 资源条（金币 + 三材料 + 背包计数）
const LOADOUT_H = 78;   // 背包 tab 顶部三槽 loadout 带
const ROW_H = 56;

const SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];
const TRACKED_MATERIALS = ['scrap', 'lead', 'binding'] as const;

/** 稀有度 → 强调色（与盲盒/收藏共用视觉语言；fine 用墨蓝）。 */
const RARITY_COLOR: Record<EquipRarity, number> = {
  common: 0x9aa0a6,
  fine: 0x4477cc,
  rare: 0xe08a2c,
  epic: 0xaa55cc,
};

/** 材料图标墨色（三笔语言：碎屑=纸灰 / 铅芯=石墨黑 / 装订线=墨蓝）。 */
const MAT_COLOR: Record<string, number> = {
  scrap: 0x8a8278,
  lead: 0x3a3632,
  binding: 0x2b4f8c,
};

/** 材料 id → 图标种类（含金币）；未知材料返回 null（回退文字）。 */
function matIconKind(id: string): IconKind | null {
  if (id === 'scrap' || id === 'lead' || id === 'binding') return id;
  if (id === 'coins' || id === 'coin') return 'coin';
  return null;
}

/** 词条 id（去 m_/s_/k_ 前缀）→ 统计图标；未知返回 null。 */
function affixIconKind(affixId: string): IconKind | null {
  const stat = affixId.replace(/^[a-z]_/, '');
  if (stat === 'atk' || stat === 'hp' || stat === 'armor' || stat === 'spd' || stat === 'atkspd') return stat;
  return null;
}

export class EquipmentScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: EquipmentCallbacks;

  private activeTab: EquipTab = 'inv';
  /**
   * 分组 strip 高度（养成组 [收藏|装备]）；仅当 openCollection 注入时 >0。body 全部按
   * HUD_H + groupH 下移一条 strip（LOBBY_IA_REDESIGN P1.5）。
   */
  private readonly groupH: number;
  private readonly bt = new BusyTracker();
  /** 强化时是否使用保护道具（E7）；状态粘滞，玩家主动切换。 */
  private useProtectEnhance = false;

  private backRect = { x: 0, y: 0, w: 0, h: 0 };
  private bodyLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private loadingLayer!: PIXI.Container;

  /** 当前打开详情的实例 id（null = 无）。每次重绘从 save 重读实例（被分解则关闭）。 */
  private detailId: string | null = null;

  private scrollY = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;

  private hitRects: { rect: Rect; action: () => void }[] = [];
  private modalHits: { rect: Rect; action: () => void }[] = [];
  private modalOpen = false;

  private toastTimer = 0;
  private destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: EquipmentCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.groupH = cb.openCollection ? hubTabsHeight(this.h) : 0;
    this.container = new PIXI.Container();
    this.build();
    this.render();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('equipbg', w, h));

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);
    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);
    this.loadingLayer = new PIXI.Container();
    this.container.addChild(this.loadingLayer);

    // Static header (back + title); the back hit is (re)registered in render().
    const hdr = drawSceneHeader(this.container, w, h, t('equip.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 15,
    });
    this.backRect = hdr.backRect;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    this.bodyLayer.removeChildren();
    this.hitRects = [];
    this.loadingLayer.removeChildren();
    // Back button (header is static art; its hit lives here so re-render keeps it).
    this.hitRects.push({ rect: this.backRect, action: () => this.cb.onBack() });

    this.renderGroupTabs();
    this.renderTabs();
    this.renderResourceBar();
    if (this.activeTab === 'inv') this.renderInventory();
    else this.renderCraft();

    // Re-open detail modal if an instance is selected (refreshes after actions);
    // otherwise ensure no stale modal (e.g. confirm) lingers after it cleared detailId.
    if (this.detailId) this.openDetail(this.detailId);
    else if (this.modalOpen) this.closeModal();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  /**
   * 养成分组 tab 条 [收藏|装备]（LOBBY_IA_REDESIGN P1.5）：装备 active，点收藏回养成。
   * 仅分组语境（openCollection 注入，groupH>0）绘制；画在 header 下、内容 tab 之上。
   */
  private renderGroupTabs(): void {
    if (this.groupH <= 0) return;
    const tabs: HubTab[] = [
      { label: t('collection.title'), active: false },
      { label: t('equip.title'), active: true },
    ];
    const hits = drawHubTabs(this.bodyLayer, this.w, HUD_H, this.groupH, tabs, (i) => {
      if (i === 0) this.cb.openCollection?.();
    });
    for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
  }

  private renderTabs(): void {
    const { w } = this;
    const top = HUD_H + this.groupH;
    const tabs: { key: EquipTab; label: TranslationKey }[] = [
      { key: 'inv', label: 'equip.tabInv' },
      { key: 'craft', label: 'equip.tabCraft' },
    ];
    const tw = w / tabs.length;
    tabs.forEach((tab, i) => {
      const active = tab.key === this.activeTab;
      const tp = sketchPanel(tw, TAB_H, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tw) });
      tp.x = i * tw; tp.y = top;
      this.bodyLayer.addChild(tp);
      const tl = txt(t(tab.label), 13, active ? C.accent : C.dark, active);
      tl.anchor.set(0.5, 0.5); tl.x = i * tw + tw / 2; tl.y = top + TAB_H / 2;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({
        rect: { x: i * tw, y: top, w: tw, h: TAB_H },
        action: () => { if (this.activeTab !== tab.key) { this.activeTab = tab.key; this.scrollY = 0; this.render(); } },
      });
    });
  }

  private renderResourceBar(): void {
    const { w } = this;
    const save = this.cb.getSave();
    const y = HUD_H + this.groupH + TAB_H;
    const bg = new PIXI.Graphics();
    bg.beginFill(0xf3f1ea).drawRect(0, y, w, RES_H).endFill();
    this.bodyLayer.addChild(bg);

    // 余额（非消耗）：图标 + 数量，无 '×' 前缀。
    const midY = y + RES_H / 2;
    const bal: Record<string, number> = {};
    for (const m of TRACKED_MATERIALS) bal[m] = save.materials[m] ?? 0;
    let cx = 10;
    const coinIc = buildIcon('coin', 16, C.gold);
    coinIc.x = cx; coinIc.y = midY - 8; this.bodyLayer.addChild(coinIc); cx += 18;
    const coinLbl = txt(`${save.wallet.coins}`, 11, C.dark);
    coinLbl.anchor.set(0, 0.5); coinLbl.x = cx; coinLbl.y = midY; this.bodyLayer.addChild(coinLbl);
    cx += coinLbl.width + 12;
    this.drawCostChips(this.bodyLayer, cx, midY, bal, null, C.dark, 16, '');

    const count = Object.keys(save.equipmentInv).length;
    const cnt = txt(`${count}/${EQUIPMENT_INV_CAP}`, 11, count >= EQUIPMENT_INV_CAP ? C.red : C.mid);
    cnt.anchor.set(1, 0.5); cnt.x = w - 10; cnt.y = y + RES_H / 2;
    this.bodyLayer.addChild(cnt);
  }

  // ── Inventory tab ───────────────────────────────────────────────────────────

  private renderInventory(): void {
    const { w, h } = this;
    const save = this.cb.getSave();
    const loadoutY = HUD_H + this.groupH + TAB_H + RES_H;
    this.renderLoadout(save, loadoutY);

    const listY = loadoutY + LOADOUT_H;
    const listH = h - listY - 8;
    const instances = Object.values(save.equipmentInv);

    if (instances.length === 0) {
      const lbl = txt(t('equip.invEmpty'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    // Sort: equipped first, then rarity desc, then level desc — stable, deterministic.
    const rarOrder: EquipRarity[] = ['epic', 'rare', 'fine', 'common'];
    const equippedIds = this.equippedIds(save);
    instances.sort((a, b) => {
      const ea = equippedIds.has(a.id) ? 0 : 1;
      const eb = equippedIds.has(b.id) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ra = rarOrder.indexOf(a.rarity) - rarOrder.indexOf(b.rarity);
      if (ra !== 0) return ra;
      if (b.level !== a.level) return b.level - a.level;
      return a.id < b.id ? -1 : 1;
    });

    const totalH = instances.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
    let cy = listY - this.scrollY;
    for (const inst of instances) {
      if (cy + ROW_H >= listY && cy <= listY + listH) {
        this.renderInstanceRow(inst, cy, equippedIds.has(inst.id));
      }
      cy += ROW_H;
    }
  }

  private renderLoadout(save: SaveData, y: number): void {
    const { w } = this;
    const label = txt(t('equip.loadout'), 11, C.mid);
    label.x = 10; label.y = y + 4;
    this.bodyLayer.addChild(label);

    const gear = save.gear.global ?? {};
    const cellW = (w - 8 * 4) / 3;
    const cellH = LOADOUT_H - 28;
    SLOTS.forEach((slot, i) => {
      const x = 8 + i * (cellW + 8);
      const cy = y + 22;
      const instId = gear[slot];
      const inst = instId ? save.equipmentInv[instId] : undefined;
      const border = inst ? RARITY_COLOR[inst.rarity] : C.mid;
      const cell = sketchPanel(cellW, cellH, { fill: 0xfaf9f5, border, seed: seedFor(i, 7, cellW) });
      cell.x = x; cell.y = cy;
      this.bodyLayer.addChild(cell);

      const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), 10, C.mid);
      slotLbl.anchor.set(0.5, 0); slotLbl.x = x + cellW / 2; slotLbl.y = cy + 4;
      this.bodyLayer.addChild(slotLbl);

      if (inst) {
        this.addGlyph(slot, inst.rarity, x + cellW / 2, cy + cellH * 0.4, 30, seedFor(i, 13, cellW));
        const nm = txt(`${this.itemName(inst.defId)} +${inst.level}`, 11, C.dark);
        nm.anchor.set(0.5, 0.5); nm.x = x + cellW / 2; nm.y = cy + cellH * 0.82;
        this.bodyLayer.addChild(nm);
        this.hitRects.push({ rect: { x, y: cy, w: cellW, h: cellH }, action: () => this.openDetail(inst.id) });
      } else {
        // Faint slot-shape hint (common media, dimmed) so empty cells still read as "weapon/armor/trinket".
        this.addGlyph(slot, 'common', x + cellW / 2, cy + cellH * 0.4, 28, seedFor(i, 13, cellW), 0.28);
        const empty = txt(t('equip.slotEmpty'), 11, C.mid);
        empty.anchor.set(0.5, 0.5); empty.x = x + cellW / 2; empty.y = cy + cellH * 0.82;
        this.bodyLayer.addChild(empty);
      }
    });
  }

  private renderInstanceRow(inst: EquipmentInstance, cy: number, equipped: boolean): void {
    const { w } = this;
    const color = RARITY_COLOR[inst.rarity];
    const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: equipped ? color : C.mid, seed: seedFor(cy, 0, w) });
    row.x = 6; row.y = cy;
    this.bodyLayer.addChild(row);

    const slot = getEquipDef(inst.defId)?.slot ?? 'weapon';
    this.addGlyph(slot, inst.rarity, 32, cy + (ROW_H - 4) / 2, 38, seedFor(cy, 3, w));
    const tx = 56;

    const name = txt(`${this.itemName(inst.defId)} +${inst.level}`, 13, C.dark, true);
    name.x = tx; name.y = cy + 7;
    this.bodyLayer.addChild(name);

    const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), 10, color, true);
    rar.x = tx; rar.y = cy + 28;
    this.bodyLayer.addChild(rar);

    let tagX = name.x + name.width + 8;
    if (equipped) {
      const e = txt(`[${t('equip.equipped')}]`, 10, C.green, true);
      e.x = tagX; e.y = cy + 9; this.bodyLayer.addChild(e); tagX += e.width + 6;
    }
    if (inst.locked) {
      const l = txt('🔒', 11, C.mid);
      l.x = tagX; l.y = cy + 8; this.bodyLayer.addChild(l);
    }

    const chevron = txt('›', 18, C.mid);
    chevron.anchor.set(1, 0.5); chevron.x = w - 16; chevron.y = cy + ROW_H / 2 - 2;
    this.bodyLayer.addChild(chevron);

    this.hitRects.push({ rect: { x: 6, y: cy, w: w - 12, h: ROW_H - 4 }, action: () => this.openDetail(inst.id) });
  }

  // ── Craft tab ───────────────────────────────────────────────────────────────

  private renderCraft(): void {
    const { w, h } = this;
    const save = this.cb.getSave();
    const defs = craftableDefs();
    const listY = HUD_H + this.groupH + TAB_H + RES_H + 4;
    const listH = h - listY - 8;
    const full = Object.keys(save.equipmentInv).length >= EQUIPMENT_INV_CAP;

    const totalH = defs.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
    let cy = listY - this.scrollY;
    for (const def of defs) {
      if (cy + ROW_H >= listY && cy <= listY + listH) {
        this.renderCraftRow(def.defId, cy, save, full);
      }
      cy += ROW_H;
    }
  }

  private renderCraftRow(defId: string, cy: number, save: SaveData, full: boolean): void {
    const { w } = this;
    const def = getEquipDef(defId)!;
    const color = RARITY_COLOR[def.rarity];
    const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 1, w) });
    row.x = 6; row.y = cy;
    this.bodyLayer.addChild(row);

    this.addGlyph(def.slot, def.rarity, 32, cy + (ROW_H - 4) / 2, 38, seedFor(cy, 4, w));
    const tx = 56;

    const name = txt(this.itemName(defId), 13, C.dark, true);
    name.x = tx; name.y = cy + 7;
    this.bodyLayer.addChild(name);
    const rar = txt(t(`equip.rarity.${def.rarity}` as TranslationKey), 10, color, true);
    rar.x = name.x + name.width + 8; rar.y = cy + 9;
    this.bodyLayer.addChild(rar);

    const cost = def.craftCost ?? {};
    const affordable = this.canAffordMaterials(save, cost);
    this.drawCostChips(this.bodyLayer, tx, cy + 34, cost, null, affordable ? C.mid : C.red, 13);

    const enabled = affordable && !full && !this.bt.busy;
    const btn = sketchPanel(60, 28, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(cy, 2, 60) });
    btn.x = w - 70; btn.y = cy + 12;
    this.bodyLayer.addChild(btn);
    const bl = txt(t('equip.craftBtn'), 12, enabled ? C.light : C.mid);
    bl.anchor.set(0.5, 0.5); bl.x = w - 40; bl.y = cy + 26;
    this.bodyLayer.addChild(bl);
    if (enabled) this.hitRects.push({ rect: { x: w - 70, y: cy + 12, w: 60, h: 28 }, action: () => void this.doCraft(defId) });
  }

  // ── Detail modal (instance: enhance / equip / salvage) ───────────────────────

  private openDetail(instanceId: string): void {
    const save = this.cb.getSave();
    const inst = save.equipmentInv[instanceId];
    if (!inst) { this.detailId = null; this.closeModal(); return; }
    this.detailId = instanceId;

    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const color = RARITY_COLOR[inst.rarity];
    const equipped = this.equippedIds(save).has(inst.id);
    const slot = getEquipDef(inst.defId)?.slot;
    const maxed = inst.level >= EQUIP_MAX_LEVEL;
    const salvageable = inst.level <= SALVAGE_MAX_LEVEL && !equipped && !inst.locked;

    const mw = Math.min(330, w - 24);
    const affixCount = inst.affixes.length;
    const protectCount = save.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0;
    // 未满级时额外 22px 显示保护道具行
    const mh = 64 + affixCount * 20 + (maxed ? 24 : 64 + 22) + 44 + 24;
    const mx = (w - mw) / 2;
    const my = Math.max(HUD_H + 4, (h - mh) / 2);

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: color, width: 2.6, seed: seedFor(0, 9, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let cy = my + 12;
    const title = txt(`${this.itemName(inst.defId)} +${inst.level}`, 14, C.dark, true);
    title.x = mx + 12; title.y = cy;
    ml.addChild(title);
    const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), 11, color, true);
    rar.anchor.set(1, 0); rar.x = mx + mw - 12; rar.y = cy + 1;
    ml.addChild(rar);
    cy += 26;

    // Affix lines（统计图标 + 文字，主词条墨蓝强调）。
    for (const af of inst.affixes) {
      const col = affixKind(af.id) === 'main' ? C.accent : C.dark;
      const kind = affixIconKind(af.id);
      let tx = mx + 16;
      if (kind) {
        const ic = buildIcon(kind, 15, col);
        ic.x = mx + 16; ic.y = cy - 1;
        ml.addChild(ic);
        tx = mx + 16 + 19;
      }
      const line = txt(this.affixDesc(af.id, af.value, inst.level), 11, col);
      line.x = tx; line.y = cy;
      ml.addChild(line);
      cy += 20;
    }
    cy += 6;

    // Enhance section.
    if (maxed) {
      const lbl = txt(t('equip.maxLevel'), 12, C.gold, true);
      lbl.x = mx + 12; lbl.y = cy;
      ml.addChild(lbl);
      cy += 24;
    } else {
      const rate = Math.round(enhanceSuccessRate(inst.level) * 100);
      const cost = enhanceCost(inst.level);
      const rateLbl = txt(t('equip.enhanceRate').replace('{rate}', String(rate)), 11, C.dark);
      rateLbl.x = mx + 12; rateLbl.y = cy;
      ml.addChild(rateLbl);
      cy += 18;
      const affordable = this.canAffordEnhance(save, cost);
      const costColor = affordable ? C.mid : C.red;
      const costLbl = txt(`${t('equip.cost')}:`, 10, costColor);
      costLbl.anchor.set(0, 0.5); costLbl.x = mx + 12; costLbl.y = cy + 7;
      ml.addChild(costLbl);
      this.drawCostChips(ml, costLbl.x + costLbl.width + 8, cy + 7, cost.materials, cost.coins, costColor, 13);
      cy += 18;
      // 保护道具行（E7）：显示持有量 + 开关 toggle。
      const canToggle = protectCount > 0;
      const protecting = this.useProtectEnhance && canToggle;
      const checkStr = protecting ? '[✓]' : '[ ]';
      const protectColor = canToggle ? (protecting ? C.accent : C.dark) : C.mid;
      const protectLbl = txt(
        `${checkStr} ${t('equip.protect')} ×${protectCount}`,
        10, protectColor,
      );
      protectLbl.x = mx + 12; protectLbl.y = cy;
      ml.addChild(protectLbl);
      if (canToggle && !this.bt.busy) {
        this.modalHits.push({
          rect: { x: mx + 10, y: cy - 2, w: mw - 20, h: 18 },
          action: () => { this.useProtectEnhance = !this.useProtectEnhance; this.render(); },
        });
      }
      cy += 22;
    }

    // 洗练可用性
    const requiredMatRarity = REFORGE_MATERIAL_RARITY[inst.rarity];
    const hasMaterials = requiredMatRarity
      ? Object.values(save.equipmentInv ?? {}).some(
          (m) => m.id !== inst.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredMatRarity && !this.equippedIds(save).has(m.id),
        )
      : false;
    const reforgeOn = !!requiredMatRarity && hasMaterials && !equipped && !inst.locked && !this.bt.busy;

    // Action buttons row.
    const btnY = my + mh - 40;
    const btnH = 30;
    const buttons: { label: string; fill: number; stroke: number; fn: () => void; on: boolean }[] = [];
    if (!maxed) {
      const cost = enhanceCost(inst.level);
      const on = this.canAffordEnhance(save, cost) && !this.bt.busy;
      buttons.push({ label: t('equip.enhance'), fill: on ? C.dark : C.btnOff, stroke: on ? C.accent : C.mid, on, fn: () => void this.doEnhance(inst.id) });
    }
    if (slot) {
      buttons.push(equipped
        ? { label: t('equip.unequip'), fill: 0xf0e0e0, stroke: C.red, on: !this.bt.busy, fn: () => void this.doEquip(slot, null) }
        : { label: t('equip.equip'), fill: C.dark, stroke: C.green, on: !this.bt.busy, fn: () => void this.doEquip(slot, inst.id) });
    }
    if (requiredMatRarity) {
      buttons.push({ label: t('equip.reforge'), fill: reforgeOn ? 0x3355aa : C.btnOff, stroke: reforgeOn ? 0x6688dd : C.mid, on: reforgeOn, fn: () => this.openReforgeSelect(inst) });
    }
    if (salvageable) {
      buttons.push({ label: t('equip.salvage'), fill: 0xeeeeee, stroke: C.mid, on: !this.bt.busy, fn: () => this.confirmSalvage(inst) });
    }
    const n = buttons.length;
    const gap = 8;
    const bw = (mw - 24 - gap * (n - 1)) / n;
    buttons.forEach((b, i) => {
      const x = mx + 12 + i * (bw + gap);
      const g = sketchPanel(bw, btnH, { fill: b.on ? b.fill : C.btnOff, border: b.on ? b.stroke : C.mid, seed: seedFor(i, 11, bw) });
      g.x = x; g.y = btnY;
      ml.addChild(g);
      const lbl = txt(b.label, 12, b.on ? (b.fill === 0xeeeeee || b.fill === 0xf0e0e0 ? C.dark : C.light) : C.mid, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
      ml.addChild(lbl);
      if (b.on) this.modalHits.push({ rect: { x, y: btnY, w: bw, h: btnH }, action: b.fn });
    });

    // Hit priority is first-match: buttons (above) win, then panel-area is inert,
    // then a tap anywhere outside the panel closes the detail (added last = lowest).
    this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
    this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeDetail() });
  }

  private closeDetail(): void {
    this.detailId = null;
    this.closeModal();
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async doCraft(defId: string): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start(); this.render();
    try {
      const res = await withTimeout(this.cb.craft(defId));
      if (res.ok) this.showToast(t('equip.crafted').replace('{name}', this.itemName(defId)), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private async doEnhance(instanceId: string): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start(); this.render();
    const save = this.cb.getSave();
    const protectCount = save.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0;
    const useProtect = this.useProtectEnhance && protectCount > 0;
    try {
      const res = await withTimeout(this.cb.enhance(instanceId, useProtect || undefined));
      if (res.ok) {
        this.showToast(res.success
          ? t('equip.enhanceOk').replace('{lv}', String(res.level))
          : t('equip.enhanceFail'), res.success ? C.green : C.red);
      } else {
        this.showToast(t(res.key), C.red);
      }
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private confirmSalvage(inst: EquipmentInstance): void {
    const refund = salvageRefund(inst.defId);
    const msg = t('equip.confirmSalvage')
      .replace('{name}', this.itemName(inst.defId))
      .replace('{refund}', this.materialsStr(refund) || t('equip.nothing'));
    this.showConfirm(msg, () => void this.doSalvage(inst.id));
  }

  private async doSalvage(instanceId: string): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    try {
      const res = await withTimeout(this.cb.salvage([instanceId]));
      if (res.ok) { this.showToast(t('equip.salvaged'), C.green); this.detailId = null; }
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private async doEquip(slot: EquipSlot, instanceId: string | null): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    try {
      const res = await withTimeout(this.cb.equip(slot, instanceId));
      if (res.ok) this.showToast(instanceId ? t('equip.equipped') : t('equip.unequipped'), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  /** 打开洗练素材选择 modal（目标已在 detailId）。 */
  private openReforgeSelect(target: EquipmentInstance): void {
    const save = this.cb.getSave();
    const slot = getEquipDef(target.defId)?.slot;
    const requiredRarity = REFORGE_MATERIAL_RARITY[target.rarity];
    if (!slot || !requiredRarity) return;

    const equippedSet = this.equippedIds(save);
    const candidates = Object.values(save.equipmentInv ?? {}).filter(
      (m) => m.id !== target.id && getEquipDef(m.defId)?.slot === slot && m.rarity === requiredRarity && !equippedSet.has(m.id),
    );

    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(320, w - 24);
    const rowH = 48;
    const mh = Math.min(60 + candidates.length * rowH + 40, h - 80);
    const mx = (w - mw) / 2;
    const my = Math.max(HUD_H + 4, (h - mh) / 2);

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    const panel = sketchPanel(mw, mh, { fill: C.paper, border: 0x3355aa, width: 2, seed: seedFor(0, 20, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const titleLbl = txt(t('equip.reforgeSelectTitle').replace('{rarity}', t(`equip.rarity.${requiredRarity}` as import('../i18n').TranslationKey)), 13, C.dark, true);
    titleLbl.anchor.set(0.5, 0); titleLbl.x = mx + mw / 2; titleLbl.y = my + 10;
    ml.addChild(titleLbl);

    let cy = my + 36;
    for (const mat of candidates) {
      const def = getEquipDef(mat.defId);
      const color = RARITY_COLOR[mat.rarity];
      const rowBg = sketchPanel(mw - 16, rowH - 4, { fill: 0xf8f4e8, border: color, seed: seedFor(cy, 21, mw) });
      rowBg.x = mx + 8; rowBg.y = cy;
      ml.addChild(rowBg);
      const nameLbl = txt(`${this.itemName(mat.defId)} +${mat.level}`, 12, C.dark, true);
      nameLbl.x = mx + 18; nameLbl.y = cy + 6;
      ml.addChild(nameLbl);
      const rarLbl = txt(t(`equip.rarity.${mat.rarity}` as import('../i18n').TranslationKey), 10, color);
      rarLbl.x = mx + 18; rarLbl.y = cy + 24;
      ml.addChild(rarLbl);
      const matId = mat.id;
      this.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: rowH - 4 }, action: () => this.confirmReforge(target, matId) });
      cy += rowH;
    }
    if (candidates.length === 0) {
      const empty = txt(t('equip.reforgeNoMat'), 12, C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = mx + mw / 2; empty.y = my + mh / 2;
      ml.addChild(empty);
    }

    const closeBtn = sketchPanel(60, 26, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 22, 60) });
    closeBtn.x = mx + (mw - 60) / 2; closeBtn.y = my + mh - 34;
    ml.addChild(closeBtn);
    const closeLbl = txt(t('equip.cancel'), 12, C.dark);
    closeLbl.anchor.set(0.5, 0.5); closeLbl.x = closeBtn.x + 30; closeLbl.y = closeBtn.y + 13;
    ml.addChild(closeLbl);
    this.modalHits.push({ rect: { x: closeBtn.x, y: closeBtn.y, w: 60, h: 26 }, action: () => { this.closeModal(); this.render(); } });
    this.modalHits.push({ rect: { x: mx, y: my, w: mw, h: mh }, action: () => {} });
    this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { this.closeModal(); this.render(); } });
  }

  private confirmReforge(target: EquipmentInstance, materialId: string): void {
    const save = this.cb.getSave();
    const mat = save.equipmentInv?.[materialId];
    if (!mat) return;
    const msg = t('equip.confirmReforge')
      .replace('{target}', this.itemName(target.defId))
      .replace('{material}', `${this.itemName(mat.defId)} +${mat.level}`);
    this.showConfirm(msg, () => void this.doReforge(target.id, materialId));
  }

  private async doReforge(targetId: string, materialId: string): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    try {
      const res = await withTimeout(this.cb.reforge(targetId, materialId));
      if (res.ok) this.showToast(t('equip.reforged'), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Confirm modal ───────────────────────────────────────────────────────────

  private showConfirm(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;
    // Confirm replaces detail; keep detailId so cancel returns to it.

    const mw = Math.min(300, w - 36);
    const mh = 130;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 12, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const lbl = txt(msg, 12, C.dark);
    lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + 16;
    lbl.style.wordWrap = true; lbl.style.wordWrapWidth = mw - 24; lbl.style.align = 'center';
    ml.addChild(lbl);

    const okBtn = sketchPanel(84, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 13, 84) });
    okBtn.x = mx + mw / 2 - 92; okBtn.y = my + mh - 36;
    ml.addChild(okBtn);
    const ol = txt(t('equip.ok'), 12, C.light, true);
    ol.anchor.set(0.5, 0.5); ol.x = okBtn.x + 42; ol.y = okBtn.y + 14;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 84, h: 28 }, action: onOk });

    const caBtn = sketchPanel(84, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 14, 84) });
    caBtn.x = mx + mw / 2 + 8; caBtn.y = my + mh - 36;
    ml.addChild(caBtn);
    const cl = txt(t('equip.cancel'), 12, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = caBtn.x + 42; cl.y = caBtn.y + 14;
    ml.addChild(cl);
    // Cancel re-opens the detail (detailId still set) via render().
    this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 84, h: 28 }, action: () => { this.closeModal(); this.render(); } });
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private equippedIds(save: SaveData): Set<string> {
    const ids = new Set<string>();
    const g = save.gear.global;
    if (g) for (const slot of SLOTS) { const id = g[slot]; if (id) ids.add(id); }
    // byUnit loadouts also occupy instances (phase 2); count them so they can't be salvaged.
    if (save.gear.byUnit) {
      for (const map of Object.values(save.gear.byUnit)) {
        for (const slot of SLOTS) { const id = map[slot]; if (id) ids.add(id); }
      }
    }
    return ids;
  }

  /**
   * Draw a procedural stationery glyph (equipmentGlyph.ts) centered at (cx, cy)
   * into a fresh Graphics on bodyLayer. Replaces the old "name-only" placeholder
   * so each item shows its slot shape × rarity media (EQUIPMENT_DESIGN §20.3).
   */
  private addGlyph(slot: EquipSlot, rarity: EquipRarity, cx: number, cy: number, size: number, seed: number, alpha = 1): void {
    const gfx = new PIXI.Graphics();
    drawEquipmentGlyph(gfx, slot, rarity, size, seed);
    gfx.x = cx; gfx.y = cy; gfx.alpha = alpha;
    this.bodyLayer.addChild(gfx);
  }

  private itemName(defId: string): string {
    const key = `equip.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  /** 词条描述：i18n `affix.<id>` 模板 {v}；主词条按等级放大显示。 */
  private affixDesc(id: string, value: number, level: number): string {
    const shown = affixKind(id) === 'main'
      ? Math.round(value * (1 + ENHANCE_COEFF_PER_LEVEL * level))
      : value;
    const key = `affix.${id}` as TranslationKey;
    const s = t(key, { v: shown });
    return s === key ? `${id} +${shown}` : s;
  }

  private materialsStr(mats: Record<string, number>): string {
    return Object.entries(mats)
      .map(([m, n]) => `${t(`material.${m}` as TranslationKey)}×${n}`)
      .join(' ');
  }

  /**
   * 在 (x, midY) 起横排「图标 ×数量」消耗组（材料 + 可选金币），返回末端 x。
   * 图标缺失时回退文字标签，保证未知材料仍可读。size=图标边长，prefix=每项前缀（默认 '×'）。
   */
  private drawCostChips(
    parent: PIXI.Container,
    x: number, midY: number,
    mats: Record<string, number>,
    coins: number | null,
    color: number,
    size = 13,
    prefix = '×',
  ): number {
    let cx = x;
    const item = (kind: IconKind | null, fallback: string, iconColor: number, n: number): void => {
      if (kind) {
        const ic = buildIcon(kind, size, iconColor);
        ic.x = cx; ic.y = midY - size / 2;
        parent.addChild(ic);
        cx += size + 1;
      } else {
        const fl = txt(fallback, 10, color);
        fl.anchor.set(0, 0.5); fl.x = cx; fl.y = midY;
        parent.addChild(fl);
        cx += fl.width + 1;
      }
      const lbl = txt(`${prefix}${n}`, 10, color);
      lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = midY;
      parent.addChild(lbl);
      cx += lbl.width + 9;
    };
    for (const [m, n] of Object.entries(mats)) {
      item(matIconKind(m), t(`material.${m}` as TranslationKey), MAT_COLOR[m] ?? color, n);
    }
    if (coins != null) item('coin', t('equip.coins'), C.gold, coins);
    return cx;
  }

  private canAffordMaterials(save: SaveData, cost: Record<string, number>): boolean {
    return Object.entries(cost).every(([m, n]) => (save.materials[m] ?? 0) >= n);
  }

  private canAffordEnhance(save: SaveData, cost: EnhanceCost): boolean {
    return this.canAffordMaterials(save, cost.materials) && save.wallet.coins >= cost.coins;
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, 0xffffff, true);
    const padX = 14, padY = 8;
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (this.w - bw) / 2;
    const by = this.h - 92;
    const bg = sketchPanel(bw, bh, { fill: color, fillAlpha: 0.96, border: color, seed: seedFor(bw, bh, 3) });
    bg.x = bx; bg.y = by;
    tl.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    tl.addChild(lbl);
    this.toastTimer = 2200;
  }

  // ── Scene interface / input ───────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
        if (this.inRect(x, y, rect)) { action(); return; }
      }
      return;
    }
    for (const { rect, action } of this.hitRects) {
      if (this.inRect(x, y, rect)) { action(); return; }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
  }

  private handleMove(_x: number, y: number): void {
    if (!this.dragStart || this.modalOpen) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  private inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.container.destroy({ children: true });
  }
}

interface Rect { x: number; y: number; w: number; h: number; }
