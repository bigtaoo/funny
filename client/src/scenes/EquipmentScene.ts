// EquipmentScene — Equipment system client UI (E5, EQUIPMENT_DESIGN §11).
// Two tabs: Inventory (item list + global loadout three slots + instance detail: enhance / equip / salvage) / Forge (craft base equipment).
// Modeled after AuctionScene: static header + bodyLayer repaint + drag-to-scroll + modal overlay + toast + error code mapping.
//
// Server-authoritative (L2): material/coin deduction, enhance dice rolls, and inventory state all live on the server.
// This scene only sends intent and reads receipts; cost/success-rate previews are mirrored from equipmentDefs,
// and the true result uses the server-pushed SaveData as the source of truth.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t, type TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren, marginLineX } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance, CardInstance } from '../game/meta/SaveData';
import { CARD_DEFS, cardPower } from '../game/meta/cardDefs';
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
import { getEquipIconTexture } from '../render/equipmentAtlas';
import { buildIcon, type IconKind } from '../render/icons';

export type EquipResult = { ok: true } | { ok: false; key: TranslationKey };
export type EnhanceResult =
  | { ok: true; success: boolean; level: number }
  | { ok: false; key: TranslationKey };

export interface EquipmentCallbacks {
  onBack(): void;
  /**
   * Peer-level navigation within a progression hub group (LOBBY_IA_REDESIGN P1.5).
   * Injected only in a group context; when set, a [<peer>|Equipment] tab strip appears below the
   * header and tapping the peer runs onSelect (back to the sibling scene). Absent from the campaign
   * entry and the per-card edit entry → no strip, plain back.
   *   - from Collection : { labelKey: 'collection.title', ... }  → [Collection|Equipment]
   *   - from Card roster : { labelKey: 'roster.title', ... }      → [Cards|Equipment]
   */
  peerTab?: { labelKey: TranslationKey; icon?: IconKind; onSelect(): void };
  /** Read the current authoritative save (server pushes after each action → adoptServer; this scene re-reads and redraws). */
  getSave(): SaveData;
  craft(defId: string): Promise<EquipResult>;
  /** When useProtect=true, consume a protect-enhance item; on failure no materials are lost (E7 §6.2). */
  enhance(instanceId: string, useProtect?: boolean): Promise<EnhanceResult>;
  salvage(instanceIds: string[]): Promise<EquipResult>;
  /**
   * Equip / unequip an equipment piece onto the active card (CC-1).
   * cardInstanceId is the hero card that owns this loadout slot.
   */
  equip(slot: EquipSlot, instanceId: string | null, cardInstanceId: string): Promise<EquipResult>;
  /** Reforge (E6): consume the item identified by materialId to re-roll the secondary affixes of targetId. */
  reforge(targetId: string, materialId: string): Promise<EquipResult>;
  /** The card instance whose gear this EquipmentScene is editing (CC-1 flow: CardScene → EquipmentScene). */
  readonly activeCardInstanceId: string;
}

type EquipTab = 'inv' | 'craft';

const HUD_H = 50;
const TAB_H = 36;
const RES_H = 30;       // resource bar (coins + three materials + inventory count)
const LOADOUT_H = 78;   // loadout strip at the top of the inventory tab (three slots)
const ROW_H = 56;
const FILTER_H = 28;   // slot filter bar (All / Weapon / Armor / Trinket)
const SECTION_H = 20;  // section divider (Equipped / Bag)

// Inventory grid: icon-card cells (name top / glyph left / rarity+level right)
// packed into columns sized to the wide (1920) landscape canvas.
const CELL_GAP = 12;
const EQUIP_CELL_H = 92;
const EQUIP_CELL_W_TARGET = 320;
// Craft grid: same column sizing as the inventory grid, a bit taller to fit
// the cost chips + craft button beneath the glyph.
const CRAFT_CELL_H = 116;

const SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];
const TRACKED_MATERIALS = ['scrap', 'lead', 'binding'] as const;

/** Rarity → accent color (shared visual language with gacha/collection; fine uses ink-blue). */
const RARITY_COLOR: Record<EquipRarity, number> = {
  common: 0x9aa0a6,
  fine: 0x4477cc,
  rare: 0xe08a2c,
  epic: 0xaa55cc,
};

/** Material icon ink colors (three-pen language: scrap = paper grey / lead = graphite black / binding = ink blue). */
const MAT_COLOR: Record<string, number> = {
  scrap: 0x8a8278,
  lead: 0x3a3632,
  binding: 0x2b4f8c,
};

/** Material id → icon kind (including coins); returns null for unknown materials (falls back to text label). */
function matIconKind(id: string): IconKind | null {
  if (id === 'scrap' || id === 'lead' || id === 'binding') return id;
  if (id === 'coins' || id === 'coin') return 'coin';
  return null;
}

/** Affix id (strip m_/s_/k_ prefix) → stat icon kind; returns null for unknown affixes. */
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
   * Height of the group strip ([<peer>|Equipment] within a progression group);
   * >0 only when peerTab is injected. All body content is offset down by HUD_H + groupH
   * (LOBBY_IA_REDESIGN P1.5).
   */
  private readonly groupH: number;
  /**
   * Bag "assign" sub-mode: active only in bag mode (no active card) after tapping Equip on an item.
   * While set, the inventory list is replaced by a card picker; choosing a card equips instId into slot.
   */
  private assign: { instId: string; slot: EquipSlot } | null = null;
  /** Bag mode = no active card (standalone bag from the roster group); equip then prompts for a card. */
  private get bag(): boolean { return !this.cb.activeCardInstanceId; }
  private readonly bt = new BusyTracker();
  /** Whether to use the protect-enhance item on the next enhance (E7); state is sticky until the player toggles it. */
  private useProtectEnhance = false;

  private backRect = { x: 0, y: 0, w: 0, h: 0 };
  private bodyLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private loadingLayer!: PIXI.Container;

  /** Instance id of the currently open detail panel (null = none). Re-read from save on every repaint (closed if the item was salvaged). */
  private detailId: string | null = null;
  /** Inventory tab slot filter ('all' = no filter). */
  private filterSlot: EquipSlot | 'all' = 'all';

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
    this.groupH = cb.peerTab ? hubTabsHeight(this.h) : 0;
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
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

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
    tearDownChildren(this.bodyLayer);
    this.hitRects = [];
    this.loadingLayer.removeChildren();
    // Back button (header is static art; its hit lives here so re-render keeps it).
    // While assigning, Back cancels the card picker rather than leaving the scene.
    this.hitRects.push({ rect: this.backRect, action: () => (this.assign ? this.cancelAssign() : this.cb.onBack()) });

    this.renderGroupTabs();
    if (this.assign) {
      this.renderAssign(this.cb.getSave());
      if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
      return;
    }
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
   * Progression group tab strip [<peer>|Equipment] (LOBBY_IA_REDESIGN P1.5): Equipment is active;
   * tapping the peer returns to the sibling scene (Collection or Card roster).
   * Drawn only in the group context (peerTab injected, groupH>0); rendered below the header and above the content tabs.
   */
  private renderGroupTabs(): void {
    if (this.groupH <= 0 || !this.cb.peerTab) return;
    const tabs: HubTab[] = [
      { label: t(this.cb.peerTab.labelKey), active: false, icon: this.cb.peerTab.icon },
      { label: t('equip.title'), active: true, icon: 'armor' },
    ];
    const hits = drawHubTabs(this.bodyLayer, this.w, HUD_H, this.groupH, tabs, (i) => {
      if (i === 0) this.cb.peerTab?.onSelect();
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

    // Balance (non-cost display): icon + amount, no '×' prefix.
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
    // Bag mode (no active card) has no single-card loadout to show; the list starts right below the resource bar.
    const base = HUD_H + this.groupH + TAB_H + RES_H;
    let filterY = base;
    if (!this.bag) { this.renderLoadout(save, base); filterY = base + LOADOUT_H; }
    this.renderSlotFilter(filterY);
    const listY = filterY + FILTER_H;
    const listH = h - listY - 8;

    const allInstances = Object.values(save.equipmentInv);
    const instances = this.filterSlot === 'all'
      ? allInstances
      : allInstances.filter(x => getEquipDef(x.defId)?.slot === this.filterSlot);

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

    const entries = this.buildDisplayEntries(instances, equippedIds);
    // Item cells start right of the red margin rule; right pad stays one CELL_GAP.
    const left = marginLineX(w) + CELL_GAP;
    const avail = w - left - CELL_GAP;
    const cols = Math.max(1, Math.floor((avail + CELL_GAP) / (EQUIP_CELL_W_TARGET + CELL_GAP)));
    const cellW = (avail - CELL_GAP * (cols - 1)) / cols;

    // Layout pass: headers span a full row and reset the column cursor; item
    // cells pack left-to-right into `cols` columns. `off` is the vertical
    // offset from listY (pre-scroll), computed up-front to clamp scrollY.
    type Placed =
      | { kind: 'header'; label: string; off: number }
      | { kind: 'item'; inst: EquipmentInstance; isEquipped: boolean; count: number; x: number; off: number };
    const placed: Placed[] = [];
    let off = CELL_GAP;
    let col = 0;
    for (const entry of entries) {
      if (entry.kind === 'header') {
        if (col !== 0) { off += EQUIP_CELL_H + CELL_GAP; col = 0; }
        placed.push({ kind: 'header', label: entry.label, off });
        off += SECTION_H;
        continue;
      }
      const x = left + col * (cellW + CELL_GAP);
      placed.push({ kind: 'item', inst: entry.inst, isEquipped: entry.isEquipped, count: entry.count, x, off });
      col++;
      if (col >= cols) { col = 0; off += EQUIP_CELL_H + CELL_GAP; }
    }
    if (col !== 0) off += EQUIP_CELL_H + CELL_GAP;
    const totalH = off + CELL_GAP;

    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
    for (const p of placed) {
      const y = listY + p.off - this.scrollY;
      const eh = p.kind === 'header' ? SECTION_H : EQUIP_CELL_H;
      if (y + eh < listY || y > listY + listH) continue;
      if (p.kind === 'header') this.renderSectionHeader(p.label, y);
      else this.renderInstanceCell(p.inst, p.x, y, cellW, p.isEquipped, p.count);
    }
  }

  /** Slot filter bar (All / Weapon / Armor / Trinket). */
  private renderSlotFilter(y: number): void {
    const { w } = this;
    const filters: { key: EquipSlot | 'all'; label: string }[] = [
      { key: 'all',     label: t('equip.filterAll') },
      { key: 'weapon',  label: t('equip.slot.weapon') },
      { key: 'armor',   label: t('equip.slot.armor') },
      { key: 'trinket', label: t('equip.slot.trinket') },
    ];
    const fw = w / filters.length;
    const bg = new PIXI.Graphics();
    bg.beginFill(0xe8e5da).drawRect(0, y, w, FILTER_H).endFill();
    this.bodyLayer.addChild(bg);

    filters.forEach((f, i) => {
      const active = this.filterSlot === f.key;
      const fx = i * fw;
      if (active) {
        const hlt = new PIXI.Graphics();
        hlt.beginFill(0xfaf9f5).drawRoundedRect(fx + 3, y + 3, fw - 6, FILTER_H - 6, 3).endFill();
        this.bodyLayer.addChild(hlt);
      }
      const lbl = txt(f.label, 11, active ? C.accent : C.dark, active);
      lbl.anchor.set(0.5, 0.5); lbl.x = fx + fw / 2; lbl.y = y + FILTER_H / 2;
      this.bodyLayer.addChild(lbl);
      this.hitRects.push({
        rect: { x: fx, y, w: fw, h: FILTER_H },
        action: () => {
          if (this.filterSlot !== f.key) { this.filterSlot = f.key; this.scrollY = 0; this.render(); }
        },
      });
    });
  }

  /** Section divider header ("Equipped" / "Bag"). */
  private renderSectionHeader(label: string, cy: number): void {
    const { w } = this;
    const lbl = txt(label, 10, C.mid);
    lbl.x = 14; lbl.y = cy + (SECTION_H - lbl.height) / 2;
    this.bodyLayer.addChild(lbl);
    const lineX = lbl.x + lbl.width + 6;
    const lineY = cy + SECTION_H / 2;
    const line = new PIXI.Graphics();
    line.lineStyle(0.5, C.mid, 0.35).moveTo(lineX, lineY).lineTo(w - 14, lineY);
    this.bodyLayer.addChild(line);
  }

  /**
   * Convert a sorted instance list into display entries with section headers and stack counts.
   * - Same defId + rarity + level=0, not equipped and not locked → merged into one row (shows ×N).
   * - Equipped / locked / level>0 → always a separate row.
   * - One section header is inserted for the Equipped section and one for the Bag section.
   */
  private buildDisplayEntries(
    sorted: EquipmentInstance[],
    equippedIds: Set<string>,
  ): DisplayEntry[] {
    const entries: DisplayEntry[] = [];
    let inEquippedSection = false;
    let inBagSection = false;
    const seenStacks = new Set<string>();

    for (const inst of sorted) {
      const isEquipped = equippedIds.has(inst.id);

      if (isEquipped && !inEquippedSection) {
        inEquippedSection = true;
        entries.push({ kind: 'header', label: t('equip.sectionEquipped') });
      }
      if (!isEquipped && !inBagSection) {
        inBagSection = true;
        entries.push({ kind: 'header', label: t('equip.sectionBag') });
      }

      if (isEquipped || inst.locked || inst.level > 0) {
        entries.push({ kind: 'item', inst, count: 1, isEquipped });
        continue;
      }

      // Unenhanced items are stackable: merge by defId+rarity.
      const key = `${inst.defId}:${inst.rarity}`;
      if (seenStacks.has(key)) continue;
      seenStacks.add(key);
      const count = sorted.filter(
        x => !equippedIds.has(x.id) && !x.locked && x.level === 0 &&
             x.defId === inst.defId && x.rarity === inst.rarity,
      ).length;
      entries.push({ kind: 'item', inst, count, isEquipped: false });
    }

    return entries;
  }

  private renderLoadout(save: SaveData, y: number): void {
    const { w } = this;
    const label = txt(t('equip.loadout'), 11, C.mid);
    label.x = 10; label.y = y + 4;
    this.bodyLayer.addChild(label);

    // CC-1: gear lives on the active card instance, not on a global loadout.
    const activeCard = save.cardInv?.[this.cb.activeCardInstanceId];
    const gear = activeCard?.gear ?? {};
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

      // Slot label: when equipped, show the slot type in small text as a secondary hint; when empty, show it bold so the player can easily identify open slots.
      const slotLbl = txt(t(`equip.slot.${slot}` as TranslationKey), inst ? 10 : 11, inst ? C.mid : C.dark, !inst);
      slotLbl.anchor.set(0.5, 0); slotLbl.x = x + cellW / 2; slotLbl.y = cy + 4;
      this.bodyLayer.addChild(slotLbl);

      if (inst) {
        this.addGlyph(slot, inst.rarity, x + cellW / 2, cy + cellH * 0.4, 30, seedFor(i, 13, cellW), 1, inst.defId);
        const nm = txt(`${this.itemName(inst.defId)} +${inst.level}`, 11, C.dark);
        nm.anchor.set(0.5, 0.5); nm.x = x + cellW / 2; nm.y = cy + cellH * 0.82;
        this.bodyLayer.addChild(nm);
        this.hitRects.push({ rect: { x, y: cy, w: cellW, h: cellH }, action: () => this.openDetail(inst.id) });
      } else {
        // Empty slot: darken the glyph alpha (0.40) and add the "empty" label so the player can clearly identify available equip positions.
        this.addGlyph(slot, 'common', x + cellW / 2, cy + cellH * 0.45, 28, seedFor(i, 13, cellW), 0.40);
        const empty = txt(t('equip.slotEmpty'), 11, C.mid);
        empty.anchor.set(0.5, 0.5); empty.x = x + cellW / 2; empty.y = cy + cellH * 0.88;
        this.bodyLayer.addChild(empty);
      }
    });
  }

  /**
   * Icon-card cell: name +level across the top, equipment glyph on the left,
   * rarity / equipped tag / stack count on the right, action hint bottom-right.
   * Border color encodes rarity when equipped, neutral otherwise.
   */
  private renderInstanceCell(inst: EquipmentInstance, x: number, y: number, cellW: number, equipped: boolean, count = 1): void {
    const pad = 8;
    const color = RARITY_COLOR[inst.rarity];
    const cell = sketchPanel(cellW, EQUIP_CELL_H, { fill: 0xfaf9f5, border: equipped ? color : C.mid, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    this.bodyLayer.addChild(cell);

    // Top: name +level (scaled down to fit if too wide).
    const name = txt(`${this.itemName(inst.defId)} +${inst.level}`, 13, C.dark, true);
    name.x = x + pad; name.y = y + pad;
    if (name.width > cellW - pad * 2 - 16) name.scale.set(Math.min(1, cellW / (name.width + 32)));
    this.bodyLayer.addChild(name);

    // Lock badge (top-right).
    if (inst.locked) {
      const l = buildIcon('lock', 14, C.mid);
      l.x = x + cellW - pad - 14; l.y = y + pad;
      this.bodyLayer.addChild(l);
    }

    // Left: glyph in a rarity-bordered frame.
    const slot = getEquipDef(inst.defId)?.slot ?? 'weapon';
    const imgBox = EQUIP_CELL_H - (pad + 24) - pad;
    const imgX = x + pad;
    const imgY = y + pad + 24;
    const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
    frame.x = imgX; frame.y = imgY;
    this.bodyLayer.addChild(frame);
    this.addGlyph(slot, inst.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, inst.defId);

    // Right: rarity / equipped tag / stack count.
    const ax = imgX + imgBox + 12;
    let ay = imgY;
    const rar = txt(t(`equip.rarity.${inst.rarity}` as TranslationKey), 12, color, true);
    rar.x = ax; rar.y = ay; this.bodyLayer.addChild(rar); ay += 19;
    if (equipped) {
      const e = txt(`[${t('equip.equipped')}]`, 11, C.green, true);
      e.x = ax; e.y = ay; this.bodyLayer.addChild(e); ay += 18;
    }
    if (count > 1) {
      const badge = txt(`×${count}`, 12, C.mid);
      badge.x = ax; badge.y = ay; this.bodyLayer.addChild(badge);
    }

    // Bottom-right action hint: "Equip ›" (accent) when unequipped, quiet "›" when equipped.
    const hint = txt(equipped ? '›' : t('equip.hintEquip'), equipped ? 16 : 11, equipped ? C.mid : C.accent, !equipped);
    hint.anchor.set(1, 1); hint.x = x + cellW - pad; hint.y = y + EQUIP_CELL_H - pad;
    this.bodyLayer.addChild(hint);

    this.hitRects.push({ rect: { x, y, w: cellW, h: EQUIP_CELL_H }, action: () => this.openDetail(inst.id) });
  }

  // ── Craft tab ───────────────────────────────────────────────────────────────

  private renderCraft(): void {
    const { w, h } = this;
    const save = this.cb.getSave();
    const defs = craftableDefs();
    const listY = HUD_H + this.groupH + TAB_H + RES_H + 4;
    const listH = h - listY - 8;
    const full = Object.keys(save.equipmentInv).length >= EQUIPMENT_INV_CAP;

    // Cells start right of the red margin rule; right pad stays one CELL_GAP.
    const left = marginLineX(w) + CELL_GAP;
    const avail = w - left - CELL_GAP;
    const cols = Math.max(1, Math.floor((avail + CELL_GAP) / (EQUIP_CELL_W_TARGET + CELL_GAP)));
    const cellW = (avail - CELL_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(defs.length / cols);
    const totalH = CELL_GAP + rows * (CRAFT_CELL_H + CELL_GAP);
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

    defs.forEach((def, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + CELL_GAP);
      const y = listY + CELL_GAP + row * (CRAFT_CELL_H + CELL_GAP) - this.scrollY;
      if (y + CRAFT_CELL_H < listY || y > listY + listH) return;
      this.renderCraftCell(def.defId, x, y, cellW, save, full);
    });
  }

  /**
   * Craft icon-card cell: name +rarity across the top, equipment glyph in a
   * rarity-bordered frame on the left, cost chips + Craft button on the right.
   * Mirrors the inventory grid's `renderInstanceCell` visual language.
   */
  private renderCraftCell(defId: string, x: number, y: number, cellW: number, save: SaveData, full: boolean): void {
    const pad = 8;
    const def = getEquipDef(defId)!;
    const color = RARITY_COLOR[def.rarity];
    const cell = sketchPanel(cellW, CRAFT_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    this.bodyLayer.addChild(cell);

    // Top: name (scaled to fit) + rarity tag.
    const name = txt(this.itemName(defId), 13, C.dark, true);
    name.x = x + pad; name.y = y + pad;
    if (name.width > cellW - pad * 2 - 60) name.scale.set(Math.min(1, (cellW - pad * 2 - 60) / name.width));
    this.bodyLayer.addChild(name);
    const rar = txt(t(`equip.rarity.${def.rarity}` as TranslationKey), 11, color, true);
    rar.anchor.set(1, 0); rar.x = x + cellW - pad; rar.y = y + pad + 1;
    this.bodyLayer.addChild(rar);

    // Left: glyph in a rarity-bordered frame.
    const imgBox = CRAFT_CELL_H - (pad + 22) - pad;
    const imgX = x + pad;
    const imgY = y + pad + 22;
    const frame = sketchPanel(imgBox, imgBox, { fill: 0xf0eee7, border: color, seed: seedFor(x, y, imgBox) });
    frame.x = imgX; frame.y = imgY;
    this.bodyLayer.addChild(frame);
    this.addGlyph(def.slot, def.rarity, imgX + imgBox / 2, imgY + imgBox / 2, imgBox - 8, seedFor(x, imgBox, cellW), 1, defId);

    // Right: cost chips (top) + Craft button (bottom).
    const ax = imgX + imgBox + 12;
    const cost = def.craftCost ?? {};
    const affordable = this.canAffordMaterials(save, cost);
    this.drawCostChips(this.bodyLayer, ax, imgY + 10, cost, null, affordable ? C.mid : C.red, 13);

    const enabled = affordable && !full && !this.bt.busy;
    const btnW = Math.min(80, x + cellW - pad - ax);
    const btnH = 28;
    const btnX = x + cellW - pad - btnW;
    const btnY = y + CRAFT_CELL_H - pad - btnH;
    const btn = sketchPanel(btnW, btnH, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(x, y, btnW) });
    btn.x = btnX; btn.y = btnY;
    this.bodyLayer.addChild(btn);
    const bl = txt(t('equip.craftBtn'), 12, enabled ? C.light : C.mid);
    bl.anchor.set(0.5, 0.5); bl.x = btnX + btnW / 2; bl.y = btnY + btnH / 2;
    this.bodyLayer.addChild(bl);
    if (enabled) this.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, action: () => void this.doCraft(defId) });
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
    // Extra 22px for the protect-item row when not max level
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

    // Affix lines (stat icon + text; main affixes highlighted in ink-blue).
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
      // Protect-item row (E7): show quantity held + toggle switch.
      const canToggle = protectCount > 0;
      const protecting = this.useProtectEnhance && canToggle;
      const protectColor = canToggle ? (protecting ? C.accent : C.dark) : C.mid;
      // Toggle checkbox: a small ink box, ticked with a hand-drawn check when on (replaces [✓]/[ ]).
      const boxSz = 14;
      const box = new PIXI.Graphics();
      box.lineStyle(1.5, protectColor, 1);
      box.drawRect(mx + 12, cy, boxSz, boxSz);
      ml.addChild(box);
      if (protecting) {
        const ck = buildIcon('check', boxSz, C.accent);
        ck.x = mx + 12; ck.y = cy;
        ml.addChild(ck);
      }
      const protectLbl = txt(`${t('equip.protect')} ×${protectCount}`, 10, protectColor);
      protectLbl.x = mx + 12 + boxSz + 4; protectLbl.y = cy + 2;
      ml.addChild(protectLbl);
      if (canToggle && !this.bt.busy) {
        this.modalHits.push({
          rect: { x: mx + 10, y: cy - 2, w: mw - 20, h: 18 },
          action: () => { this.useProtectEnhance = !this.useProtectEnhance; this.render(); },
        });
      }
      cy += 22;
    }

    // Reforge availability
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
      if (equipped) {
        // Unequip: in bag mode the item may be on any card → look up its owner; otherwise the active card.
        buttons.push({ label: t('equip.unequip'), fill: 0xf0e0e0, stroke: C.red, on: !this.bt.busy, fn: () => {
          const cardId = this.bag ? this.ownerCardId(save, inst.id) : this.cb.activeCardInstanceId;
          if (cardId) void this.doEquip(slot, null, cardId);
        } });
      } else {
        // Equip: in bag mode we don't know the target card yet → open the card picker; otherwise the active card.
        buttons.push({ label: t('equip.equip'), fill: C.dark, stroke: C.green, on: !this.bt.busy, fn: () => {
          if (this.bag) this.beginAssign(inst.id, slot);
          else void this.doEquip(slot, inst.id, this.cb.activeCardInstanceId);
        } });
      }
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

  private async doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void> {
    if (this.bt.busy) return;
    this.bt.start();
    try {
      const res = await withTimeout(this.cb.equip(slot, instanceId, cardId));
      if (res.ok) this.showToast(instanceId ? t('equip.equipped') : t('equip.unequipped'), C.green);
      else this.showToast(t(res.key), C.red);
    } catch (e) {
      this.showToast(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'equip.err.generic'), C.red);
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Bag "assign to card" sub-mode ─────────────────────────────────────────
  // Reached only in bag mode (roster group): tapping Equip on a bag item opens a full-view card
  // picker (reusing the main drag-scroll), and choosing a card equips the item onto that card.

  /** Find the card currently wearing `instId` in any slot (bag-mode unequip needs the owner). */
  private ownerCardId(save: SaveData, instId: string): string | null {
    for (const card of Object.values(save.cardInv ?? {})) {
      for (const slot of SLOTS) if (card.gear[slot] === instId) return card.id;
    }
    return null;
  }

  private beginAssign(instId: string, slot: EquipSlot): void {
    this.assign = { instId, slot };
    this.detailId = null;
    this.closeModal();
    this.scrollY = 0;
    this.render();
  }

  private cancelAssign(): void {
    this.assign = null;
    this.scrollY = 0;
    this.render();
  }

  private async doEquipTo(cardId: string): Promise<void> {
    if (!this.assign || this.bt.busy) return;
    const { instId, slot } = this.assign;
    this.assign = null;
    this.scrollY = 0;
    await this.doEquip(slot, instId, cardId);
  }

  /** Full-view card picker shown while assigning a bag item to a card (reuses the main scrollY). */
  private renderAssign(save: SaveData): void {
    const { w, h } = this;
    if (!this.assign) return;
    const inst = save.equipmentInv[this.assign.instId];
    if (!inst) { this.assign = null; this.render(); return; }
    const slot = this.assign.slot;

    const top = HUD_H + this.groupH;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0xf3f1ea).drawRect(0, top, w, RES_H).endFill();
    this.bodyLayer.addChild(barBg);
    const title = txt(t('equip.assignTitle').replace('{name}', `${this.itemName(inst.defId)} +${inst.level}`), 12, C.dark, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = top + RES_H / 2;
    this.bodyLayer.addChild(title);

    const listY = top + RES_H;
    const listH = h - listY - 8;
    const cards = Object.values(save.cardInv ?? {});
    if (cards.length === 0) {
      const lbl = txt(t('equip.assignEmpty'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    const equipInv = save.equipmentInv ?? {};
    const sorted = [...cards].sort((a, b) => {
      const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
      if (pd !== 0) return pd;
      if (b.level !== a.level) return b.level - a.level;
      return a.id < b.id ? -1 : 1;
    });
    const totalH = sorted.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));
    let cy = listY - this.scrollY;
    for (const card of sorted) {
      if (cy + ROW_H >= listY && cy <= listY + listH) this.renderAssignRow(card, cy, slot, save);
      cy += ROW_H;
    }
  }

  private renderAssignRow(card: CardInstance, cy: number, slot: EquipSlot, save: SaveData): void {
    const { w } = this;
    const def = CARD_DEFS[card.defId];
    const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 30, w) });
    row.x = 6; row.y = cy;
    this.bodyLayer.addChild(row);

    const factionColor = def?.faction === 'anna' ? 0xcc4466 : 0x4477cc;
    const dot = new PIXI.Graphics();
    dot.beginFill(factionColor).drawCircle(0, 0, 5).endFill();
    dot.x = 18; dot.y = cy + 18;
    this.bodyLayer.addChild(dot);

    const nameLbl = txt(t(`card.${card.defId}.name` as TranslationKey), 13, C.dark, true);
    nameLbl.x = 30; nameLbl.y = cy + 8;
    this.bodyLayer.addChild(nameLbl);
    const lvLbl = txt(`Lv.${card.level}`, 11, C.mid);
    lvLbl.x = 30; lvLbl.y = cy + 26;
    this.bodyLayer.addChild(lvLbl);

    // Current occupant of the target slot (so the player knows an equip here will swap it out).
    const curId = card.gear[slot];
    const cur = curId ? save.equipmentInv[curId] : undefined;
    const curLbl = txt(
      cur ? t('equip.assignCurrent').replace('{name}', `${this.itemName(cur.defId)} +${cur.level}`) : t('equip.assignSlotFree'),
      10, cur ? C.gold : C.mid,
    );
    curLbl.anchor.set(1, 0.5); curLbl.x = w - 18; curLbl.y = cy + ROW_H / 2 - 2;
    this.bodyLayer.addChild(curLbl);

    const cardId = card.id;
    this.hitRects.push({ rect: { x: 6, y: cy, w: w - 12, h: ROW_H - 4 }, action: () => void this.doEquipTo(cardId) });
  }

  /** Open the reforge material selection modal (the target item is already set in detailId). */
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

  /** Collect all equipment instance ids currently worn across ALL card instances (CC-1). */
  private equippedIds(save: SaveData): Set<string> {
    const ids = new Set<string>();
    for (const card of Object.values(save.cardInv ?? {})) {
      for (const slot of SLOTS) {
        const id = card.gear[slot];
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Draw an equipment icon centered at (cx, cy) onto bodyLayer.
   * When defId is provided and the atlas is ready, renders the AI bitmap sprite
   * (EQUIPMENT_DESIGN §20.2); otherwise falls back to the procedural glyph (§20.3).
   * The rarity border is always drawn by the surrounding sketchPanel, not here.
   */
  private addGlyph(slot: EquipSlot, rarity: EquipRarity, cx: number, cy: number, size: number, seed: number, alpha = 1, defId?: string): void {
    const tex = defId ? getEquipIconTexture(defId) : null;
    if (tex) {
      const sprite = new PIXI.Sprite(tex);
      const scale = size / 128;
      sprite.scale.set(scale);
      sprite.anchor.set(0.5, 0.5);
      sprite.x = cx; sprite.y = cy; sprite.alpha = alpha;
      this.bodyLayer.addChild(sprite);
    } else {
      const gfx = new PIXI.Graphics();
      drawEquipmentGlyph(gfx, slot, rarity, size, seed);
      gfx.x = cx; gfx.y = cy; gfx.alpha = alpha;
      this.bodyLayer.addChild(gfx);
    }
  }

  private itemName(defId: string): string {
    const key = `equip.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  /** Affix description: i18n `affix.<id>` template with {v}; main affixes are scaled up by level. */
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
   * Render a horizontal row of "icon ×amount" cost chips starting at (x, midY) for materials plus optional coins; returns the trailing x.
   * Falls back to a text label when no icon is available, ensuring unknown materials remain readable.
   * size = icon side length; prefix = per-item prefix string (default '×').
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

type DisplayEntry =
  | { kind: 'header'; label: string }
  | { kind: 'item'; inst: EquipmentInstance; count: number; isEquipped: boolean };
