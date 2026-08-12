// Shared foundation for the EquipmentScene composition (see ../EquipmentScene.ts assembly).
//
// EquipmentSceneCore holds every instance field (all public, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.bt, this.core.detailId, this.core.hitRects, …)
// + the layer scaffold (build), the chrome/header helpers, the shared cost/rarity/glyph helpers,
// the confirm modal, and the input/lifecycle plumbing — but NOT the render() dispatcher, which
// lives on the outer ../EquipmentScene.ts assembly since only it knows about every domain class
// (Core takes a `render` callback injected at construction instead of owning render() itself, so
// it never has to call sideways into a sibling domain). Each domain (inventory / craft / detail /
// assign / reforge) is its own independent class in a sibling file, constructed with `core`
// (2026-08-11: converted from the former `XMixin(Base)` inheritance chain — the render-dispatch
// upward calls this used to reach via interface declaration merging are now explicit constructor
// params/callbacks instead, see claudedocs/client-modules.md's split-form priority note).
//
// Two genuine bidirectional dependencies surfaced during the conversion (both resolved the same
// way CardScene's feed↔actions pair was: a lazy hook on Core, default no-op, overwritten by the
// outer assembly right after the real sibling is constructed):
//   - inventory.ts ↔ detail.ts: inventory's renderInstanceCell calls detail.instanceActions/
//     openDetail (so InventoryPanel takes `detail` as a direct constructor param — detail must be
//     built first); detail's doEnhance calls inventory's refreshInstanceCell (a single-cell
//     in-place redraw optimization that only inventory can perform — it owns the grid's
//     cellContainers/cellRects/lastEntrySig state, and going through a full render() would regress
//     the 2026-07-28 flicker fix that optimization exists for) — see {@link refreshInstanceCellHook}.
//   - detail.ts ↔ assign.ts: detail's instanceActions calls assign.beginAssign/ownerCardId (so
//     DetailPanel takes `assign` as a direct constructor param — assign must be built first);
//     assign's doEquipTo calls detail's doEquip — see {@link doEquipHook}.
// Construction order in the assembly is therefore: reforge → assign → detail (needs assign +
// reforge) → inventory (needs detail) → craft (needs only core, any position).
//
// A third case doesn't need a hook at all: Core's own backAction() (fired from the header Back
// button, wired at construction time before assign.ts exists) needs to call assign.cancelAssign()
// while in assign mode — same lazy-hook shape, see {@link cancelAssignHook}.
//
// EquipmentScene — Equipment system client UI (E5, EQUIPMENT_DESIGN §11).
// Server-authoritative (L2): material/coin deduction, enhance dice rolls, and inventory state all
// live on the server. This scene only sends intent and reads receipts; cost/success-rate previews
// are mirrored from equipmentDefs, and the true result uses the server-pushed SaveData as the
// source of truth.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, scaledTxt, buildPaperBackground, drawLoadingOverlay, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import { showToastMessage } from '../../net/log';
import { snapFont } from '../../render/fontScale';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { BusyTracker } from '../../ui/busyTracker';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import type { SaveData, EquipSlot, EquipRarity } from '../../game/meta/SaveData';
import { EQUIPMENT_INV_CAP, EQUIP_MAX_LEVEL } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildLevelStars as buildLevelStarsRow } from '../../render/levelStars';
import { MAT_BAND_H, MAT_COLOR, TRACKED_MATERIALS, matIconKind } from './layout';
import type { EquipTab, SectionKey, Rect } from './types';

export type { EquipResult, EnhanceResult, EquipmentCallbacks, EquipTab, SectionKey, Rect, CellAction, EquipGridLayout } from './types';
export * from './layout';
export * from './helpers';

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

export class EquipmentSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: import('./types').EquipmentCallbacks;

  activeTab: EquipTab = 'inv';
  /**
   * Whether the group nav ([<peer>|Equipment] within a progression group) is shown; only when
   * peerTab is injected (LOBBY_IA_REDESIGN P1.5). Lives in the left sidebar rail, stacked above
   * the Inventory/Craft sub-tabs — see InventoryPanel.renderSidebar.
   */
  readonly showGroup: boolean;
  /**
   * Bag "assign" sub-mode: active only in bag mode (no active card) after tapping Equip on an item.
   * While set, the inventory list is replaced by a card picker; choosing a card equips instId into slot.
   */
  assign: { instId: string; slot: EquipSlot } | null = null;
  /** Bag mode = no active card (standalone bag from the roster group); equip then prompts for a card. */
  get bag(): boolean { return !this.cb.activeCardInstanceId; }
  /**
   * Whether the progression-group peer nav has more than just "Equipment" to show — i.e. a leading
   * peerTab and/or trailing peers (Skins) are injected. Portrait combines all of them into one bottom
   * nav bar (§18; see InventoryPanel.renderSidebar), this gates whether that bar (and the height it
   * reserves) actually appears, mirroring `showGroup && peerTab` / `trailingPeers.length` in landscape.
   */
  get hasGroupNav(): boolean {
    return (this.showGroup && !!this.cb.peerTab) || (this.cb.trailingPeers?.length ?? 0) > 0;
  }
  /**
   * Section headers (Equipped / Bag) tapped closed by the player; collapsed sections hide their item
   * cells but keep the header visible (InventoryPanel.renderSectionHeader). Lives on Core (not
   * InventoryPanel) so DetailPanel.doEquip can also collapse "equipped" right after a successful
   * equip.
   *
   * Starts with "equipped" folded: the player usually cares about the Bag list, not re-checking
   * gear they already know is equipped (2026-08-01 UX fix) — tapping the header expands it same as
   * before.
   */
  readonly collapsedSections = new Set<SectionKey>(['equipped']);
  readonly bt = new BusyTracker();
  /** Whether to use the protect-enhance item on the next enhance (E7); state is sticky until the player toggles it. */
  useProtectEnhance = false;

  backRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  headerH = 0;
  bodyLayer!: PIXI.Container;
  /** Coin/materials readout band — kept out of bodyLayer so an enhance/craft round-trip can refresh
   *  spent materials via detail.ts's refreshChromeAndModal() without tearing down (and relayout-ing) the grid. */
  materialsLayer!: PIXI.Container;
  modalLayer!: PIXI.Container;
  loadingLayer!: PIXI.Container;
  /** Drawn *after* the static header chrome so the coin/material readout sits on top of the header bar (same row as the title), not in a separate band below it. */
  headerOverlayLayer!: PIXI.Container;

  /** Instance id of the currently open detail panel (null = none). Re-read from save on every repaint (closed if the item was salvaged). */
  detailId: string | null = null;
  /** Inventory tab slot filter ('all' = no filter); seeded from cb.initialFilterSlot in the constructor. */
  filterSlot: EquipSlot | 'all' = 'all';

  scrollY = 0;
  /**
   * Vertical bounds + max scroll of whichever list is currently on screen (inventory grid / craft
   * grid / assign card-picker — mutually exclusive, so one set of fields covers all three). Set at
   * the end of each renderX's layout pass; consumed by the wheel handler below (PC-only — see
   * wheelScroll.ts) since none of those render passes otherwise store their listY/listH/maxScroll
   * past the render() call that computed them.
   */
  scrollRegionTop = 0;
  scrollRegionBottom = 0;
  maxScroll = 0;
  /**
   * Tap-vs-drag gesture tracker: defers an item cell's hit action to pointer-up and drops it if the
   * pointer dragged (so a drag starting on an item scrolls instead of opening its detail; mirrors
   * CardSceneCore). See ScrollTapGesture.
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

  /** owner (instance id) tags a grid-cell button/body hit so InventoryPanel.refreshInstanceCell()
   *  can drop and re-add just that cell's hits without touching the rest of the list. */
  hitRects: { rect: Rect; action: () => void; owner?: string }[] = [];
  modalHits: { rect: Rect; action: () => void }[] = [];
  modalOpen = false;
  /**
   * Detail-modal scale transform (popup-scale-to-80pct fix, 2026-07-14): the whole modal panel is
   * drawn in a local (unscaled) frame onto {@link modalPanelRoot}, then that container is scaled up
   * to fill 80% of the constrained screen axis. modalHits for anything drawn onto modalPanelRoot must
   * be converted to real screen space via {@link toModalScreen} — identity (scale 1, origin 0) when
   * no modal is open.
   */
  modalScale = 1;
  modalOriginX = 0;
  modalOriginY = 0;
  /** Container for modal-panel content that should scale/position as one unit — see {@link modalScale}. */
  modalPanelRoot!: PIXI.Container;

  destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  /**
   * Bumped by the outer assembly's render() on every full render() call — lets detail.ts's doEnhance
   * detect a full grid redraw that happened *during* its own in-flight await (see the field's use
   * site) rather than relying on `bt.busy` alone, which only tells it busy was true at some point,
   * not whether the grid actually got rebuilt.
   */
  renderGeneration = 0;

  /**
   * detail.ts's doEnhance calls this instead of a full render() to redraw just the touched grid cell
   * (see the file-header comment) — default no-op until the outer assembly overwrites it right after
   * constructing InventoryPanel. Returns false (caller falls back to render()) when the cell isn't
   * currently tracked, or the sort/grouping may have changed since the last full render.
   */
  refreshInstanceCellHook: (instanceId: string) => boolean = () => false;
  /**
   * assign.ts's doEquipTo calls this to hand off to detail.ts's doEquip (see the file-header
   * comment) — default no-op until the outer assembly overwrites it right after constructing
   * DetailPanel.
   */
  doEquipHook: (slot: EquipSlot, instanceId: string | null, cardId: string) => Promise<void> = async () => {};
  /**
   * backAction() (below) calls this while in assign mode to cancel the card picker (see the
   * file-header comment) — default no-op until the outer assembly overwrites it right after
   * constructing AssignPanel.
   */
  cancelAssignHook: () => void = () => {};

  /** @param render Injected by the outer EquipmentScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about every domain class) — Core and the
   *  domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *  called its own `render()` method verbatim. */
  constructor(
    layout: ILayout,
    input: InputManager,
    cb: import('./types').EquipmentCallbacks,
    readonly render: () => void,
  ) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    if (cb.initialFilterSlot) this.filterSlot = cb.initialFilterSlot;
    this.showGroup = !!cb.peerTab;
    this.container = new PIXI.Container();
    this.build();

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

  private build(): void {
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

    // Static header (back + title); the back hit is (re)registered by the assembly's render().
    const hdr = drawSceneHeader(this.container, w, h, t('equip.title'), {
      variant: 'paper', accent: HEADER_ACCENT.spend,
    });
    this.backRect = hdr.backRect;
    this.headerH = hdr.headerH;

    this.headerOverlayLayer = new PIXI.Container();
    this.container.addChild(this.headerOverlayLayer);
  }

  /** Header Back button behavior: cancels the card picker while assigning, otherwise leaves the scene. */
  backAction(): void {
    if (this.assign) this.cancelAssignHook();
    else this.cb.onBack();
  }

  /**
   * Coin + material + capacity readout drawn into the header row itself (headerOverlayLayer sits
   * on top of the static header chrome), so it lines up with the "Equipment" title instead of floating
   * in its own band underneath. Called on every render(), independent of the assembly's renderHeaderRow/
   * assign mode, so it stays visible even while the card-assign picker is open.
   */
  renderHeaderCurrency(): void {
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
  renderMaterialsBand(x: number, y: number, w: number): void {
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

  // ── Confirm modal ───────────────────────────────────────────────────────────

  showConfirm(msg: string, onOk: () => void): void {
    // Confirm replaces detail; keep detailId so cancel returns to it via render().
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => {
      this.closeModal(); this.render();
    });
  }

  closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
    this.modalScale = 1;
    this.modalOriginX = 0;
    this.modalOriginY = 0;
  }

  /** Convert a rect drawn in {@link modalPanelRoot}'s local (unscaled) space into real screen space. */
  toModalScreen(r: Rect): Rect {
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
  stxt(label: string, size: number, color: number, bold = false, wordWrapWidth?: number): PIXI.Text {
    return scaledTxt(this.modalScale)(label, size, color, bold, wordWrapWidth);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Draw an equipment icon centered at (cx, cy) onto bodyLayer.
   * When defId is provided and the atlas is ready, renders the AI bitmap sprite
   * (EQUIPMENT_DESIGN §20.2); otherwise falls back to the procedural glyph (§20.3).
   * The rarity border is always drawn by the surrounding sketchPanel, not here.
   */
  addGlyph(slot: EquipSlot, rarity: EquipRarity, cx: number, cy: number, size: number, seed: number, alpha = 1, defId?: string): void {
    const icon = buildEquipIcon(defId, slot, rarity, size, seed);
    icon.x = cx; icon.y = cy; icon.alpha = alpha;
    this.bodyLayer.addChild(icon);
  }

  /**
   * Row of gold star icons for the enhance level (one per level, max EQUIP_MAX_LEVEL), scaled down to
   * fit maxW. Delegates the actual draw/fit to the shared render/levelStars helper (also used by
   * CardScene and AuctionScene) — this wrapper only owns the equipment-specific bits: clamping to
   * EQUIP_MAX_LEVEL and the maxed-row sweep. At EQUIP_MAX_LEVEL the whole row is registered for the
   * periodic left-right sweep driven by update() (see flipStars) — a maxed item's stars sit static gold
   * and flip briefly every few seconds to call it out among the static rows, rather than animating every frame.
   */
  buildLevelStars(level: number, maxW: number, size = 14, gap = 3): PIXI.Container {
    const starN = Math.max(0, Math.min(EQUIP_MAX_LEVEL, level));
    const { container, stars } = buildLevelStarsRow(starN, maxW, size, gap);
    if (starN === EQUIP_MAX_LEVEL) {
      stars.forEach((st, i) => this.flipStars.push({ obj: st, phase: i * STAR_SWEEP_STAGGER }));
    }
    return container;
  }

  /**
   * Render a horizontal row of "icon ×amount" cost chips starting at (x, midY) for materials plus optional coins; returns the trailing x.
   * Falls back to a text label when no icon is available, ensuring unknown materials remain readable.
   * size = icon side length; prefix = per-item prefix string (default '×').
   */
  drawCostChips(
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

  // ── Toast ───────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Scene interface / input ───────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
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

  private handleMove(_x: number, y: number): void {
    // Feed the move to the gesture even while a modal is open: the modal doesn't scroll, but this
    // latches `moved` once the pointer crosses the drag threshold so the pending modal tap is dropped on up.
    const scroll = this.gesture.move(y);
    if (this.modalOpen) return;
    if (scroll !== null) { this.scrollY = scroll; this.scrollDirty = true; }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  private inRect(x: number, y: number, r: Rect): boolean {
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
