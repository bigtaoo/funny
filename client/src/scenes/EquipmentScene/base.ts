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
import { ui as C, txt, scaledTxt, buildPaperBackground, sketchPanel, sketchButton, seedFor, drawLoadingOverlay, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import { showToastMessage } from '../../net/log';
import { FS, snapFont } from '../../render/fontScale';
import { sidebarNavW, drawHubTabs, hubTabsHeight, type HubTab } from '../../ui/widgets/HubTabs';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { BusyTracker } from '../../ui/busyTracker';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import type { SaveData, EquipSlot, EquipRarity, EquipmentInstance } from '../../game/meta/SaveData';
import { affixKind, EQUIPMENT_INV_CAP, EQUIP_MAX_LEVEL, type EnhanceCost } from '../../game/meta/equipmentDefs';
import { ENHANCE_COEFF_PER_LEVEL } from '@nw/engine/balance/equipment';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';
import { buildLevelStars as buildLevelStarsRow, levelStarsText } from '../../render/levelStars';

/**
 * Maxed-star sweep timing (2026-07-26 UX pass): a continuous per-frame flip read as flickery/noisy
 * once a grid held several maxed items flipping independently, so the row now sits static gold and
 * only sweeps briefly on an interval — see buildLevelStars()/update().
 */
/** Seconds between successive sweeps of a maxed star row; static gold in between. */
const STAR_SWEEP_INTERVAL = 6;
/** Seconds a single star's flip lasts once its sweep starts (one front-edge-back-edge-front cycle). */
const STAR_SWEEP_DURATION = 0.7;
/** Seconds delay between adjacent stars' sweep start, so the flip ripples left-to-right rather than firing as one synced blink. */
const STAR_SWEEP_STAGGER = 0.08;

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
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the save (wallet/inventory/...). Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
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
export type SectionKey = 'equipped' | 'bag';

export const RES_H = 30;       // resource bar (coins + three materials + inventory count)
export const LOADOUT_H = 90;   // loadout strip at the top of the inventory tab (three slots) — tall enough for icon+name+enhance-stars to stack without the stars clipping the slot cell's bottom border (2026-08-01)
export const ROW_H = 56;
export const FILTER_H = 48;   // slot filter bar (All / Weapon / Armor / Trinket)
export const MAT_BAND_H = 52; // materials band (scrap / lead / binding) below the header
export const SECTION_H = 36;  // section divider (Equipped / Bag) — clickable to collapse, text is 2x the previous size
// Top padding above the first section header, tighter than the inter-row CELL_GAP (2026-08-01):
// using CELL_GAP there read as an oversized gap under the loadout strip, since LOADOUT_H already
// carries its own bottom breathing room.
export const LIST_TOP_PAD = 12;
// Gap between the slot filter bar and the loadout strip beneath it (2026-08-01) — see renderHeaderRow.
export const TAB_LOADOUT_GAP = 14;

// Inventory grid: icon-card cells (name top / glyph left / rarity+level right)
// packed into columns sized to the wide (1920) landscape canvas.
export const CELL_GAP = 36;
export const CELL_GAP_X = CELL_GAP * 2; // horizontal gap between grid cells only — doubled per 2026-07-17 legibility pass
export const EQUIP_CELL_H = 266; // +50% atop the previous 177 (2026-07-16 inventory legibility pass)
export const EQUIP_CELL_W_TARGET = 360; // tightened from 480 (2026-07-17) — 480 left a wide empty band between the glyph and the craft/level column
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

/**
 * A single on-card action button (Enhance / Equip / Unequip / Reforge / Salvage / Salvage All).
 * Only *available* actions are emitted — unavailable ones (unaffordable enhance, reforge without a
 * matching material, salvage on an equipped/locked piece, …) are omitted entirely rather than shown
 * disabled, so the grid cell hides them rather than greying them out. A momentarily-busy action
 * (another action already in flight) is the one exception — it stays in the list with `disabled:
 * true` instead of being omitted (2026-07-28 fix: omitting it shrank the button band and resized
 * every cell's icon frame for the whole grid while any single action was in flight, reading as the
 * grid getting "stretched"). `fn` fires the action directly (equip / confirm dialog / material
 * picker), bypassing the info modal — except Enhance, whose `fn` opens that modal instead (it needs
 * the modal's protect-stone toggle before it can commit, 2026-07-22b). See DetailMixin.instanceActions.
 */
export interface CellAction {
  key: string;
  label: string;
  icon: IconKind;
  fill: number;
  stroke: number;
  disabled?: boolean;
  fn: () => void;
}

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
  /**
   * Whether the progression-group peer nav has more than just "Equipment" to show — i.e. a leading
   * peerTab and/or trailing peers (Skins) are injected. Portrait combines all of them into one bottom
   * nav bar (§18; see InventoryMixin.renderSidebar); this gates whether that bar (and the height it
   * reserves) actually appears, mirroring `showGroup && peerTab` / `trailingPeers.length` in landscape.
   */
  protected get hasGroupNav(): boolean {
    return (this.showGroup && !!this.cb.peerTab) || (this.cb.trailingPeers?.length ?? 0) > 0;
  }
  /**
   * Section headers (Equipped / Bag) tapped closed by the player; collapsed sections hide their item
   * cells but keep the header visible (InventoryMixin.renderSectionHeader). Lives on the base class
   * (not InventoryMixin) so DetailMixin.doEquip can also collapse "equipped" right after a successful
   * equip. A field initializer here runs before the constructor's render() call below, so — unlike
   * fields declared in a mixin subclass — no lazy-init workaround is needed.
   *
   * Starts with "equipped" folded: the player usually cares about the Bag list, not re-checking
   * gear they already know is equipped (2026-08-01 UX fix) — tapping the header expands it same as
   * before.
   */
  protected readonly collapsedSections = new Set<SectionKey>(['equipped']);
  protected readonly bt = new BusyTracker();
  /** Whether to use the protect-enhance item on the next enhance (E7); state is sticky until the player toggles it. */
  protected useProtectEnhance = false;

  protected backRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  protected headerH = 0;
  protected bodyLayer!: PIXI.Container;
  /** Coin/materials readout band — kept out of bodyLayer so an enhance/craft round-trip can refresh
   *  spent materials via refreshChromeAndModal() without tearing down (and relayout-ing) the grid. */
  protected materialsLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;
  protected loadingLayer!: PIXI.Container;
  /** Drawn *after* the static header chrome so the coin/material readout sits on top of the header bar (same row as the title), not in a separate band below it. */
  protected headerOverlayLayer!: PIXI.Container;

  /** Instance id of the currently open detail panel (null = none). Re-read from save on every repaint (closed if the item was salvaged). */
  protected detailId: string | null = null;
  /** Inventory tab slot filter ('all' = no filter); seeded from cb.initialFilterSlot in the constructor. */
  protected filterSlot: EquipSlot | 'all' = 'all';

  protected scrollY = 0;
  /**
   * Vertical bounds + max scroll of whichever list is currently on screen (inventory grid / craft
   * grid / assign card-picker — mutually exclusive, so one set of fields covers all three). Set at
   * the end of each renderX's layout pass; consumed by the wheel handler below (PC-only — see
   * wheelScroll.ts) since none of those render passes otherwise store their listY/listH/maxScroll
   * past the render() call that computed them.
   */
  protected scrollRegionTop = 0;
  protected scrollRegionBottom = 0;
  protected maxScroll = 0;
  /**
   * Tap-vs-drag gesture tracker: defers an item cell's hit action to pointer-up and drops it if the
   * pointer dragged (so a drag starting on an item scrolls instead of opening its detail; mirrors
   * CardSceneBase). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — pointermove can fire far faster than the
   *  display refresh rate, and render() fully tears down/rebuilds the scene, so calling it per-event
   *  caused visible jank while dragging. update() (ticker-gated, once per frame) drains this instead. */
  private scrollDirty = false;

  /**
   * Star sprites belonging to a maxed-out (EQUIP_MAX_LEVEL) star row. Sits static (scale.x = 1) most
   * of the time; update() briefly sweeps it (flip left-right) once per STAR_SWEEP_INTERVAL — a
   * periodic callout for fully-enhanced items instead of a permanent per-frame animation (which read
   * as flickery/noisy once several maxed items were on screen at once). `phase` is a per-star seconds
   * delay (not radians) so the sweep ripples left-to-right across the row. Populated by
   * buildLevelStars() on every render pass (inventory grid, detail modal, …); entries whose sprite has
   * since been torn down (scrolled off, modal closed, re-render) are pruned lazily in update() rather
   * than tracked per call site — self-healing, no reset needed.
   */
  private flipStars: { obj: PIXI.DisplayObject; phase: number }[] = [];
  private flipT = 0;

  /** owner (instance id) tags a grid-cell button/body hit so refreshInstanceCell() can drop and
   *  re-add just that cell's hits without touching the rest of the list — see InventoryMixin. */
  protected hitRects: { rect: Rect; action: () => void; owner?: string }[] = [];
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
    // Desktop mouse-wheel scroll (browser only — see wheelScroll.ts); the modal doesn't scroll, so a
    // wheel event while one is open is ignored, mirroring handleMove's modalOpen guard below.
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      if (this.modalOpen) return;
      const next = wheelScrollY(this.scrollRegionTop, this.scrollRegionBottom, y, deltaY, this.scrollY, this.maxScroll);
      if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
    }));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
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
    this.materialsLayer = new PIXI.Container();
    this.container.addChild(this.materialsLayer);
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);
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

  /**
   * Bumped on every full render() — lets doEnhance detect a full grid redraw that happened *during*
   * its own in-flight await (see the field's use site) rather than relying on `this.bt.busy` alone,
   * which only tells it busy was true at some point, not whether the grid actually got rebuilt.
   */
  protected renderGeneration = 0;

  protected render(): void {
    if (this.destroyed) return;
    this.renderGeneration++;
    tearDownChildren(this.bodyLayer);
    this.hitRects = [];
    tearDownChildren(this.loadingLayer);
    // Back button (header is static art; its hit lives here so re-render keeps it).
    // While assigning, Back cancels the card picker rather than leaving the scene.
    this.hitRects.push({ rect: this.backRect, action: () => this.backAction() });

    this.renderHeaderCurrency();
    this.renderSidebar();
    if (this.assign) {
      // The card picker replaces the header row entirely — hide the materials band left over from
      // whatever tab was showing before assign mode started (renderHeaderRow/renderMaterialsBand
      // aren't called on this path).
      tearDownChildren(this.materialsLayer);
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

  /**
   * Cheap alternative to a full render() for actions that spend materials/coins and toggle busy
   * state but don't change the grid's layout (see DetailMixin.doEnhance): refreshes the header coin
   * readout, the materials band, the open detail modal (busy/cost/rate all read from it) and the
   * loading overlay — everything except the sidebar and the item grid.
   */
  protected refreshChromeAndModal(): void {
    if (this.destroyed) return;
    this.renderHeaderCurrency();
    const { w, h, landscape } = this;
    // Portrait's materials band spans full width, below the Inventory/Craft header strip instead of
    // right of a left rail (see renderHeaderRow) — landscape keeps the sidebarNavW-offset band.
    const leftW = landscape ? sidebarNavW(w, h, true) : 0;
    const bandY = landscape ? this.headerH : this.headerH + hubTabsHeight(h);
    this.renderMaterialsBand(leftW, bandY, w - leftW);
    tearDownChildren(this.loadingLayer);
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
    tearDownChildren(this.headerOverlayLayer);
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
    tearDownChildren(this.materialsLayer);
    const save = this.cb.getSave();
    const bg = new PIXI.Graphics();
    bg.beginFill(0xf3f1ea).drawRect(x, y, w, MAT_BAND_H).endFill();
    this.materialsLayer.addChild(bg);

    const midY = y + MAT_BAND_H / 2;
    const iconSize = Math.round(MAT_BAND_H * 0.44);
    const fontSize = snapFont(Math.round(MAT_BAND_H * 0.4));
    const slotW = w / TRACKED_MATERIALS.length;
    TRACKED_MATERIALS.forEach((m, i) => {
      const cx = x + i * slotW + Math.round(slotW * 0.1);
      const ic = buildMaterialIcon(m as MaterialKind, iconSize, MAT_COLOR[m] ?? C.mid);
      ic.x = cx; ic.y = midY - iconSize / 2;
      this.materialsLayer.addChild(ic);
      const lbl = txt(`${t(`material.${m}` as TranslationKey)} ${save.materials[m] ?? 0}`, fontSize, C.dark);
      lbl.anchor.set(0, 0.5); lbl.x = cx + iconSize + 6; lbl.y = midY;
      this.materialsLayer.addChild(lbl);
    });
  }

  /**
   * Header row below the header/sidebar: the slot filter bar (Inventory tab only), capped left
   * at the red margin rule so it lines up with the bag-list / item-grid split below it. Returns
   * the y where body content (loadout / grid) should start.
   *
   * Portrait draws the Inventory/Craft sub-tabs here too, as a `drawHubTabs` strip (§18) — the
   * left rail they used to nest under (InventoryMixin.renderSidebar) is a bottom bar in portrait,
   * so there's nothing left to nest under; a header strip is the existing "sub-view switch within
   * one scene" convention used everywhere else in the game. Content spans full width (no leftW
   * reservation) since nothing occupies the left edge in portrait.
   */
  protected renderHeaderRow(): number {
    const { w, h, landscape } = this;
    const top = this.headerH;

    if (!landscape) {
      const stripH = hubTabsHeight(h);
      const subTabs: HubTab[] = [
        { label: t('equip.tabInv'), active: this.activeTab === 'inv' },
        { label: t('equip.tabCraft'), active: this.activeTab === 'craft' },
      ];
      const hits = drawHubTabs(this.bodyLayer, w, top, stripH, subTabs, (i) => {
        const key: EquipTab = i === 0 ? 'inv' : 'craft';
        if (this.activeTab !== key) { this.activeTab = key; this.scrollY = 0; this.render(); }
      });
      this.hitRects.push(...hits.map((hit) => ({ rect: hit.rect, action: hit.fn })));

      let bottom = top + stripH;
      this.renderMaterialsBand(0, bottom, w);
      bottom += MAT_BAND_H;
      if (this.activeTab === 'inv') {
        this.renderSlotFilter(0, bottom, w);
        // Breathing room before the loadout strip below — see the landscape branch's TAB_LOADOUT_GAP note.
        bottom += FILTER_H + TAB_LOADOUT_GAP;
      }
      return bottom;
    }

    const leftW = sidebarNavW(w, h, true);
    const rightX = leftW;
    const rightW = w - leftW;

    let rightBottom = top;
    // Materials band (both tabs) — the three crafting materials, relocated out of the header.
    this.renderMaterialsBand(rightX, rightBottom, rightW);
    rightBottom += MAT_BAND_H;
    if (this.activeTab === 'inv') {
      this.renderSlotFilter(rightX, rightBottom, rightW);
      // The slot filter bar and the loadout strip below it used to butt up against each other with
      // zero gap, reading as one fused block — the loadout's equipped-item star row visually looked
      // like it belonged to the tab bar itself rather than to a separate section (2026-08-01 fix).
      rightBottom += FILTER_H + TAB_LOADOUT_GAP;
    }

    return rightBottom;
  }

  // ── Confirm modal ───────────────────────────────────────────────────────────

  protected showConfirm(msg: string, onOk: () => void): void {
    // Confirm replaces detail; keep detailId so cancel returns to it via render().
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => {
      this.closeModal(); this.render();
    });
  }

  protected closeModal(): void {
    tearDownChildren(this.modalLayer);
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

  /**
   * `txt()` for content drawn onto {@link modalPanelRoot} — compensates PIXI.Text's raster
   * blur from the later `modalPanelRoot.scale.set(modalScale)` (see {@link scaledTxt}).
   */
  protected stxt(label: string, size: number, color: number, bold = false, wordWrapWidth?: number): PIXI.Text {
    return scaledTxt(this.modalScale)(label, size, color, bold, wordWrapWidth);
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
   * All instance ids sharing `inst`'s defId+rarity that the inventory grid merges into the same
   * stacked cell (mirrors InventoryMixin.buildDisplayEntries: +0, unequipped, unlocked only —
   * everything else is always its own row). Used by the detail modal to offer a "salvage all"
   * action for the whole stack instead of just the one representative instance it was opened with.
   */
  protected stackSiblingIds(save: SaveData, inst: EquipmentInstance): string[] {
    if (inst.level !== 0 || inst.locked) return [inst.id];
    const equipped = this.equippedIds(save);
    if (equipped.has(inst.id)) return [inst.id];
    return Object.values(save.equipmentInv)
      .filter(x => !equipped.has(x.id) && !x.locked && x.level === 0 && x.defId === inst.defId && x.rarity === inst.rarity)
      .map(x => x.id);
  }

  /**
   * Draw an equipment icon centered at (cx, cy) onto bodyLayer.
   * When defId is provided and the atlas is ready, renders the AI bitmap sprite
   * (EQUIPMENT_DESIGN §20.2); otherwise falls back to the procedural glyph (§20.3).
   * The rarity border is always drawn by the surrounding sketchPanel, not here.
   */
  protected addGlyph(slot: EquipSlot, rarity: EquipRarity, cx: number, cy: number, size: number, seed: number, alpha = 1, defId?: string): void {
    const icon = buildEquipIcon(defId, slot, rarity, size, seed);
    icon.x = cx; icon.y = cy; icon.alpha = alpha;
    this.bodyLayer.addChild(icon);
  }

  protected itemName(defId: string): string {
    const key = `equip.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  /** Item name + enhance level as text stars, e.g. "Marker ★★★" — omits stars entirely at level 0 (the vast majority of items, and printing a bare "+0" everywhere was pure noise). Used only where the label is embedded in a translated sentence; standalone item cards use buildLevelStars() for real gold-icon stars instead. */
  protected itemLabel(defId: string, level: number): string {
    const stars = levelStarsText(level, EQUIP_MAX_LEVEL);
    return stars ? `${this.itemName(defId)} ${stars}` : this.itemName(defId);
  }

  /**
   * Row of gold star icons for the enhance level (one per level, max EQUIP_MAX_LEVEL), scaled down to
   * fit maxW. Delegates the actual draw/fit to the shared render/levelStars helper (also used by
   * CardScene and AuctionScene) — this wrapper only owns the equipment-specific bits: clamping to
   * EQUIP_MAX_LEVEL and the maxed-row sweep. At EQUIP_MAX_LEVEL the whole row is registered for the
   * periodic left-right sweep driven by update() (see flipStars) — a maxed item's stars sit static gold
   * and flip briefly every few seconds to call it out among the static rows, rather than animating every frame.
   */
  protected buildLevelStars(level: number, maxW: number, size = 14, gap = 3): PIXI.Container {
    const starN = Math.max(0, Math.min(EQUIP_MAX_LEVEL, level));
    const { container, stars } = buildLevelStarsRow(starN, maxW, size, gap);
    if (starN === EQUIP_MAX_LEVEL) {
      stars.forEach((st, i) => this.flipStars.push({ obj: st, phase: i * STAR_SWEEP_STAGGER }));
    }
    return container;
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
    const labelSize = snapFont(Math.round(size * 0.8));
    const item = (kind: IconKind | null, fallback: string, iconColor: number, n: number): void => {
      if (kind) {
        const ic = (kind === 'scrap' || kind === 'lead' || kind === 'binding')
          ? buildMaterialIcon(kind, size, iconColor)
          : kind === 'coin'
            ? buildCoinIcon(kind, size, iconColor)
            : buildIcon(kind, size, iconColor);
        ic.x = cx; ic.y = midY - size / 2;
        parent.addChild(ic);
        cx += size + 1;
      } else {
        const fl = this.stxt(fallback, labelSize, color);
        fl.anchor.set(0, 0.5); fl.x = cx; fl.y = midY;
        parent.addChild(fl);
        cx += fl.width + 1;
      }
      const lbl = this.stxt(`${prefix}${n}`, labelSize, color);
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
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Scene interface / input ───────────────────────────────────────────────

  protected handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      // The header Back button must stay reachable even with a detail/craft modal open — otherwise
      // a tap there falls through to the modal's own dim-to-close catch-all and just closes the modal
      // instead of leaving the scene (LOBBY_IA_REDESIGN back-button-always-works fix, 2026-07-14).
      if (this.inRect(x, y, this.backRect)) { this.backAction(); return; }
      // Defer the modal hit to pointer-UP and drop it if the pointer drags past the threshold, same
      // as the grid behind it — so a press-drag-release on a reforge material-picker row only confirms
      // on release, and a drag away doesn't accidentally consume the wrong item (2026-07-17).
      let modalHit: (() => void) | null = null;
      for (const { rect, action } of this.modalHits) {
        if (this.inRect(x, y, rect)) { modalHit = action; break; }
      }
      this.gesture.down(this.scrollY, y, modalHit);
      return;
    }
    // Don't fire the hit action here — capture it and start gesture tracking. If the pointer then
    // drags past the threshold it becomes a scroll and the tap is dropped on up; otherwise the tap
    // fires on up. This lets a drag that starts *on an item cell* scroll the grid instead of instantly
    // opening that item's detail.
    let hit: (() => void) | null = null;
    for (const { rect, action } of this.hitRects) {
      if (this.inRect(x, y, rect)) { hit = action; break; }
    }
    this.gesture.down(this.scrollY, y, hit);
  }

  protected handleMove(_x: number, y: number): void {
    // Feed the move to the gesture even while a modal is open: the modal doesn't scroll, but this
    // latches `moved` once the pointer crosses the drag threshold so the pending modal tap is dropped on up.
    const scroll = this.gesture.move(y);
    if (this.modalOpen) return;
    if (scroll !== null) { this.scrollY = scroll; this.scrollDirty = true; }
  }

  protected handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  protected inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.bt.tick(dt)) this.render();
    if (this.flipStars.length) {
      this.flipT += dt;
      this.flipStars = this.flipStars.filter((f) => !f.obj.destroyed);
      const cyclePos = this.flipT % STAR_SWEEP_INTERVAL;
      for (const { obj, phase } of this.flipStars) {
        const localT = cyclePos - phase;
        obj.scale.x = localT >= 0 && localT < STAR_SWEEP_DURATION
          ? Math.cos((localT / STAR_SWEEP_DURATION) * Math.PI * 2)
          : 1;
      }
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
  /**
   * Redraw a single grid cell in place instead of a full renderInventory relayout — see
   * InventoryMixin. Returns false (caller should fall back to render()) when the cell isn't
   * currently tracked, or the sort/grouping may have changed since the last full render.
   */
  refreshInstanceCell(instanceId: string): boolean;
  renderCraft(bodyTop: number): void;
  renderAssign(save: SaveData): void;
  cancelAssign(): void;
  openDetail(instanceId: string): void;
  instanceActions(save: SaveData, inst: EquipmentInstance): CellAction[];
  beginAssign(instId: string, slot: EquipSlot): void;
  ownerCardId(save: SaveData, instId: string): string | null;
  openReforgeSelect(target: EquipmentInstance): void;
  doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void>;
}
