// Shared foundation for the EquipmentScene mixin chain (see ../EquipmentScene.ts assembly).
// EquipmentSceneBase holds every instance field (all `protected`, so domain mixin method bodies keep
// referencing them verbatim: this.bt, this.detailId, this.hitRects, …) + the constructor/build, the
// chrome render dispatcher (render/renderHeaderRow), input handling, toast, confirm modal, and the
// shared cost/rarity/glyph helpers used across tabs. Each domain (inventory / craft / detail / assign /
// reforge) lives in its own sibling file as an `XMixin(Base)` and is chained together into EquipmentScene.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import type { Scene } from '../SceneManager';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../../render/sketchUi';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { BusyTracker } from '../../ui/busyTracker';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../../game/meta/SaveData';
import { affixKind, EQUIPMENT_INV_CAP, type EnhanceCost } from '../../game/meta/equipmentDefs';
import { ENHANCE_COEFF_PER_LEVEL } from '@nw/engine/balance/equipment';
import { drawEquipmentGlyph } from '../../render/equipmentGlyph';
import { getEquipIconTexture } from '../../render/equipmentAtlas';
import { buildIcon, type IconKind } from '../../render/icons';

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
  /**
   * Peers that sit *after* Equipment in the growth group and so must render below Equipment's own
   * Inventory/Craft sub-tabs, not be dropped. The roster group is [Cards | Equipment | Skins]: the
   * leading Cards peer comes in via {@link peerTab}, and Skins is injected here so it stays visible —
   * shifted down under the sub-tabs — instead of vanishing when Equipment is the active scene
   * (LOBBY_IA_REDESIGN §15). See the inventory mixin's renderSidebar.
   */
  trailingPeers?: { labelKey: TranslationKey; icon?: IconKind; onSelect(): void }[];
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
  /** Slot to pre-select in the inventory filter bar on entry (a specific gear-slot tap from CardScene); defaults to "All". */
  readonly initialFilterSlot?: EquipSlot;
}

export type EquipTab = 'inv' | 'craft';

export const RES_H = 30;       // resource bar (coins + three materials + inventory count)
export const LOADOUT_H = 78;   // loadout strip at the top of the inventory tab (three slots)
export const ROW_H = 56;
export const FILTER_H = 48;   // slot filter bar (All / Weapon / Armor / Trinket)
export const MAT_BAND_H = 52; // materials band (scrap / lead / binding) below the header
export const SECTION_H = 20;  // section divider (Equipped / Bag)

// Inventory grid: icon-card cells (name top / glyph left / rarity+level right)
// packed into columns sized to the wide (1920) landscape canvas.
export const CELL_GAP = 12;
export const EQUIP_CELL_H = 177; // 1.5x the previous 118 (unified with CARD_CELL_H in CardScene.ts)
export const EQUIP_CELL_W_TARGET = 480; // 1.5x the previous 320 (unified with CARD_CELL_W_TARGET in CardScene.ts)
// Craft grid: same column + cell sizing as the inventory grid so the icon
// frames read at the same scale; cost chips + craft button sit beside the glyph.
export const CRAFT_CELL_H = EQUIP_CELL_H;

export const SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];
export const TRACKED_MATERIALS = ['scrap', 'lead', 'binding'] as const;

/**
 * Rarity → accent color (shared visual language with gacha/collection).
 * Ascending grey → green → blue → purple so a higher tier always reads as
 * "more important" than a lower one (previously rare was orange, which read
 * louder/higher than epic's purple — inverted the intended hierarchy).
 */
export const RARITY_COLOR: Record<EquipRarity, number> = {
  common: 0x9aa0a6,
  fine: 0x4a9e4a,
  rare: 0x4477cc,
  epic: 0xaa55cc,
};

/** Material icon ink colors (three-pen language: scrap = paper grey / lead = graphite black / binding = ink blue). */
export const MAT_COLOR: Record<string, number> = {
  scrap: 0x8a8278,
  lead: 0x3a3632,
  binding: 0x2b4f8c,
};

/** Material id → icon kind (including coins); returns null for unknown materials (falls back to text label). */
export function matIconKind(id: string): IconKind | null {
  if (id === 'scrap' || id === 'lead' || id === 'binding') return id;
  if (id === 'coins' || id === 'coin') return 'coin';
  return null;
}

export interface Rect { x: number; y: number; w: number; h: number; }

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type EquipmentSceneBaseCtor = Constructor<EquipmentSceneBase>;

export class EquipmentSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: EquipmentCallbacks;

  protected activeTab: EquipTab = 'inv';
  /**
   * Whether the group nav ([<peer>|Equipment] within a progression group) is shown; only when
   * peerTab is injected (LOBBY_IA_REDESIGN P1.5). Lives in the left sidebar rail, stacked above
   * the Inventory/Craft sub-tabs — see the inventory mixin's renderSidebar.
   */
  protected readonly showGroup: boolean;
  /**
   * Bag "assign" sub-mode: active only in bag mode (no active card) after tapping Equip on an item.
   * While set, the inventory list is replaced by a card picker; choosing a card equips instId into slot.
   */
  protected assign: { instId: string; slot: EquipSlot } | null = null;
  /** Bag mode = no active card (standalone bag from the roster group); equip then prompts for a card. */
  protected get bag(): boolean { return !this.cb.activeCardInstanceId; }
  protected readonly bt = new BusyTracker();
  /** Whether to use the protect-enhance item on the next enhance (E7); state is sticky until the player toggles it. */
  protected useProtectEnhance = false;

  protected backRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  protected headerH = 0;
  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;
  protected toastLayer!: PIXI.Container;
  protected loadingLayer!: PIXI.Container;
  /** Drawn *after* the static header chrome so the coin/material readout sits on top of the header bar (same row as the title), not in a separate band below it. */
  protected headerOverlayLayer!: PIXI.Container;

  /** Instance id of the currently open detail panel (null = none). Re-read from save on every repaint (closed if the item was salvaged). */
  protected detailId: string | null = null;
  /** Inventory tab slot filter ('all' = no filter); seeded from cb.initialFilterSlot in the constructor. */
  protected filterSlot: EquipSlot | 'all' = 'all';

  protected scrollY = 0;
  protected dragStart: { x: number; y: number; scroll: number } | null = null;
  /** Set by handleMove instead of rendering inline — pointermove can fire far faster than the
   *  display refresh rate, and render() fully tears down/rebuilds the scene, so calling it per-event
   *  caused visible jank while dragging. update() (ticker-gated, once per frame) drains this instead. */
  private scrollDirty = false;

  protected hitRects: { rect: Rect; action: () => void }[] = [];
  protected modalHits: { rect: Rect; action: () => void }[] = [];
  protected modalOpen = false;
  /**
   * Detail-modal scale transform (popup-scale-to-80pct fix, 2026-07-14): the whole modal panel is
   * drawn in a local (unscaled) frame onto {@link modalPanelRoot}, then that container is scaled up
   * to fill 80% of the constrained screen axis. modalHits for anything drawn onto modalPanelRoot must
   * be converted to real screen space via {@link toModalScreen} — identity (scale 1, origin 0) when
   * no modal is open.
   */
  protected modalScale = 1;
  protected modalOriginX = 0;
  protected modalOriginY = 0;
  /** Container for modal-panel content that should scale/position as one unit — see {@link modalScale}. */
  protected modalPanelRoot!: PIXI.Container;

  protected toastTimer = 0;
  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: EquipmentCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    if (cb.initialFilterSlot) this.filterSlot = cb.initialFilterSlot;
    this.showGroup = !!cb.peerTab;
    this.container = new PIXI.Container();
    this.build();
    this.render();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
  }

  protected build(): void {
    const { w, h, landscape } = this;
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('equipbg', w, h, { railX }));
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
      variant: 'paper', accent: HEADER_ACCENT.spend,
    });
    this.backRect = hdr.backRect;
    this.headerH = hdr.headerH;

    this.headerOverlayLayer = new PIXI.Container();
    this.container.addChild(this.headerOverlayLayer);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer);
    this.hitRects = [];
    this.loadingLayer.removeChildren();
    // Back button (header is static art; its hit lives here so re-render keeps it).
    // While assigning, Back cancels the card picker rather than leaving the scene.
    this.hitRects.push({ rect: this.backRect, action: () => this.backAction() });

    this.renderHeaderCurrency();
    this.renderSidebar();
    if (this.assign) {
      this.renderAssign(this.cb.getSave());
      if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
      return;
    }
    const bodyTop = this.renderHeaderRow();
    if (this.activeTab === 'inv') this.renderInventory(bodyTop);
    else this.renderCraft(bodyTop);

    // Re-open detail modal if an instance is selected (refreshes after actions);
    // otherwise ensure no stale modal (e.g. confirm) lingers after it cleared detailId.
    if (this.detailId) this.openDetail(this.detailId);
    else if (this.modalOpen) this.closeModal();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  /** Header Back button behavior: cancels the card picker while assigning, otherwise leaves the scene. */
  protected backAction(): void {
    if (this.assign) this.cancelAssign();
    else this.cb.onBack();
  }

  /**
   * Coin + material + capacity readout drawn into the header row itself (headerOverlayLayer sits
   * on top of the static header chrome), so it lines up with the "Equipment" title instead of floating
   * in its own band underneath. Called on every render(), independent of renderHeaderRow/assign
   * mode, so it stays visible even while the card-assign picker is open.
   */
  protected renderHeaderCurrency(): void {
    this.headerOverlayLayer.removeChildren();
    const save = this.cb.getSave();
    const count = Object.keys(save.equipmentInv).length;
    // Header carries only the coin balance + capacity — a compact right cluster that leaves room
    // for the left-aligned title on the narrow portrait bar. The three crafting materials are too
    // wide to fit here with readable labels, so they get their own body band (renderMaterialsBand).
    drawHeaderCurrency(this.headerOverlayLayer, this.w, this.headerH, save.wallet.coins, [], {
      text: `${count}/${EQUIPMENT_INV_CAP}`,
      color: count >= EQUIPMENT_INV_CAP ? C.red : C.mid,
    }, 100 / this.headerH);
  }

  /**
   * Slim materials band at the top of the body (right of the sidebar rail): the three crafting
   * materials as icon + name + amount, at a readable size. Moved out of the header (see
   * renderHeaderCurrency) so the labels no longer collide with the title on the narrow portrait bar.
   */
  protected renderMaterialsBand(x: number, y: number, w: number): void {
    const save = this.cb.getSave();
    const bg = new PIXI.Graphics();
    bg.beginFill(0xf3f1ea).drawRect(x, y, w, MAT_BAND_H).endFill();
    this.bodyLayer.addChild(bg);

    const midY = y + MAT_BAND_H / 2;
    const iconSize = Math.round(MAT_BAND_H * 0.44);
    const fontSize = Math.round(MAT_BAND_H * 0.4);
    const slotW = w / TRACKED_MATERIALS.length;
    TRACKED_MATERIALS.forEach((m, i) => {
      const cx = x + i * slotW + Math.round(slotW * 0.1);
      const ic = buildIcon(matIconKind(m) ?? 'coin', iconSize, MAT_COLOR[m] ?? C.mid);
      ic.x = cx; ic.y = midY - iconSize / 2;
      this.bodyLayer.addChild(ic);
      const lbl = txt(`${t(`material.${m}` as TranslationKey)} ${save.materials[m] ?? 0}`, fontSize, C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = cx + iconSize + 6; lbl.y = midY;
      this.bodyLayer.addChild(lbl);
    });
  }

  /**
   * Header row below the header/sidebar: the slot filter bar (Inventory tab only), capped left
   * at the red margin rule so it lines up with the bag-list / item-grid split below it. Returns
   * the y where body content (loadout / grid) should start.
   */
  protected renderHeaderRow(): number {
    const { w, h, landscape } = this;
    const top = this.headerH;
    const leftW = sidebarNavW(w, h, landscape);
    const rightX = leftW;
    const rightW = w - leftW;

    let rightBottom = top;
    // Materials band (both tabs) — the three crafting materials, relocated out of the header.
    this.renderMaterialsBand(rightX, rightBottom, rightW);
    rightBottom += MAT_BAND_H;
    if (this.activeTab === 'inv') {
      this.renderSlotFilter(rightX, rightBottom, rightW);
      rightBottom += FILTER_H;
    }

    return rightBottom;
  }

  // ── Confirm modal ───────────────────────────────────────────────────────────

  protected showConfirm(msg: string, onOk: () => void): void {
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

  protected closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
    this.modalScale = 1;
    this.modalOriginX = 0;
    this.modalOriginY = 0;
  }

  /** Convert a rect drawn in {@link modalPanelRoot}'s local (unscaled) space into real screen space. */
  protected toModalScreen(r: Rect): Rect {
    return {
      x: this.modalOriginX + r.x * this.modalScale,
      y: this.modalOriginY + r.y * this.modalScale,
      w: r.w * this.modalScale,
      h: r.h * this.modalScale,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Collect all equipment instance ids currently worn across ALL card instances (CC-1). */
  protected equippedIds(save: SaveData): Set<string> {
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
  protected addGlyph(slot: EquipSlot, rarity: EquipRarity, cx: number, cy: number, size: number, seed: number, alpha = 1, defId?: string): void {
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

  protected itemName(defId: string): string {
    const key = `equip.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  /** Affix description: i18n `affix.<id>` template with {v}; main affixes are scaled up by level. */
  protected affixDesc(id: string, value: number, level: number): string {
    const shown = affixKind(id) === 'main'
      ? Math.round(value * (1 + ENHANCE_COEFF_PER_LEVEL * level))
      : value;
    const key = `affix.${id}` as TranslationKey;
    const s = t(key, { v: shown });
    return s === key ? `${id} +${shown}` : s;
  }

  protected materialsStr(mats: Record<string, number>): string {
    return Object.entries(mats)
      .map(([m, n]) => `${t(`material.${m}` as TranslationKey)}×${n}`)
      .join(' ');
  }

  /**
   * Render a horizontal row of "icon ×amount" cost chips starting at (x, midY) for materials plus optional coins; returns the trailing x.
   * Falls back to a text label when no icon is available, ensuring unknown materials remain readable.
   * size = icon side length; prefix = per-item prefix string (default '×').
   */
  protected drawCostChips(
    parent: PIXI.Container,
    x: number, midY: number,
    mats: Record<string, number>,
    coins: number | null,
    color: number,
    size = 13,
    prefix = '×',
  ): number {
    let cx = x;
    const labelSize = Math.round(size * 0.8);
    const item = (kind: IconKind | null, fallback: string, iconColor: number, n: number): void => {
      if (kind) {
        const ic = buildIcon(kind, size, iconColor);
        ic.x = cx; ic.y = midY - size / 2;
        parent.addChild(ic);
        cx += size + 1;
      } else {
        const fl = txt(fallback, labelSize, color);
        fl.anchor.set(0, 0.5); fl.x = cx; fl.y = midY;
        parent.addChild(fl);
        cx += fl.width + 1;
      }
      const lbl = txt(`${prefix}${n}`, labelSize, color);
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

  protected canAffordMaterials(save: SaveData, cost: Record<string, number>): boolean {
    return Object.entries(cost).every(([m, n]) => (save.materials[m] ?? 0) >= n);
  }

  protected canAffordEnhance(save: SaveData, cost: EnhanceCost): boolean {
    return this.canAffordMaterials(save, cost.materials) && save.wallet.coins >= cost.coins;
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
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

  protected handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      // The header Back button must stay reachable even with a detail/craft modal open — otherwise
      // a tap there falls through to the modal's own dim-to-close catch-all and just closes the modal
      // instead of leaving the scene (LOBBY_IA_REDESIGN back-button-always-works fix, 2026-07-14).
      if (this.inRect(x, y, this.backRect)) { this.backAction(); return; }
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

  protected handleMove(_x: number, y: number): void {
    if (!this.dragStart || this.modalOpen) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.scrollDirty = true;
    }
  }

  protected handleUp(): void {
    this.dragStart = null;
  }

  protected inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
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

// ── Domain entrypoints dispatched to from base-level code (render/renderHeaderRow/constructor),
// plus cross-mixin calls (the detail modal invokes the assign/reforge entry points that live in
// sibling mixins, invisible to each other and to the base). Declared via interface/class declaration
// merging so base-level `this.renderX()` / `this.openDetail()` / … type-check as METHODS (not
// properties, which would clash with the mixin's method override — TS2425). Emits NOTHING at
// runtime, so the real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface EquipmentSceneBase {
  renderSidebar(): void;
  renderInventory(bodyTop: number): void;
  renderSlotFilter(x: number, y: number, w: number): void;
  renderCraft(bodyTop: number): void;
  renderAssign(save: SaveData): void;
  cancelAssign(): void;
  openDetail(instanceId: string): void;
  beginAssign(instId: string, slot: EquipSlot): void;
  ownerCardId(save: SaveData, instId: string): string | null;
  openReforgeSelect(target: EquipmentInstance): void;
  doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void>;
}
