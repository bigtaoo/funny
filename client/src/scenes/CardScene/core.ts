// Shared foundation for the CardScene composition (see ../CardScene.ts assembly).
//
// CardSceneCore holds every instance field (all public, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.bt, this.core.detailId, this.core.modalLayer, …)
// + the layer scaffold (build), the shared portrait helper (drawArtFit), modal/toast primitives, and
// the input/lifecycle plumbing — but NOT the render() dispatcher, which lives on the outer
// ../CardScene.ts assembly since only it knows about every domain class (Core takes a `render`
// callback injected at construction instead of owning render() itself, so it never has to call
// sideways into a sibling domain). Each domain (list / skins / detail / feed / actions) is its own
// independent class in a sibling file, constructed with `core` (2026-08-11: converted from the
// former `XMixin(Base)` inheritance chain — the render-dispatch upward calls this used to reach via
// interface declaration merging are now explicit constructor params/callbacks instead, see
// claudedocs/client-modules.md's split-form priority note).
//
// feed.ts's confirm-fuse button needs to call actions.ts's doFuse, but actions.ts is constructed
// AFTER feed.ts in the outer assembly (actions.ts itself needs a `feed` reference for
// playFusionAnim, so feed must exist first) — a genuine bidirectional dependency between feed and
// actions. Rather than merge the two classes, {@link doFuse} is a lazy hook on Core (default no-op)
// that the outer assembly overwrites with the real `(...) => this.actions.doFuse(...)` immediately
// after constructing ActionsPanel — same "default no-op field, overwritten right after the real
// sibling exists" pattern as AuctionScene's `reopenCreateForm`/SectScene's `allianceHooks`.
//
// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10).
//   List: card inventory grouped deployed-first, power desc within each group; capacity counter (n/500).
//   Detail modal: stats + skill + troop cap + gear 3 slots + fusion-readiness bar + lock toggle + fuse + list-auction.
//   Fuse flow: select target → fusion panel (center card + 5 material slots, same faction+level) → fuseCards().
// Server-authoritative (L2): all mutations go through server endpoints; SaveData is the read-only mirror.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import {
  ui as C, scaledTxt, buildPaperBackground, tearDownChildren,
} from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { getArtTexture, containScale } from '../../render/cardArt';
import { drawSceneHeader, sceneHeaderHeight, headerCurrencyWidth, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { subscribeInput, unsubscribeInput } from './input';
import { CARD_INV_CAP, CARD_INV_OVERFLOW_BUFFER } from '../../game/meta/cardDefs';

export type {
  CardActionResult, CardBatchResult, CardSceneTab, CardCallbacks, CardRosterView, Rect, Hit,
  DoFuseFn, PrepRound, DoPrepBatchFn,
} from './types';
export { MODAL_DIM, CELL_GAP, CARD_CELL_H, CARD_CELL_W_TARGET } from './types';
import type {
  CardCallbacks, CardSceneTab, Rect, Hit, DoFuseFn, DoPrepBatchFn,
} from './types';

// Roster ordering + injury countdown moved to ./cardSort.ts (2026-08-18) — pure functions with
// no dependency on this class's state; re-exported so importers keep the same module path.
export { sortCards, injuryCountdown } from './cardSort';

export class CardSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: CardCallbacks;
  readonly bt = new BusyTracker();

  bodyLayer!: PIXI.Container;
  /**
   * Persistent, masked home of the roster grid's per-card cells (ListPanel). Deliberately NOT part
   * of {@link bodyLayer}: the assembly's render() tears bodyLayer down wholesale, and the whole
   * point of the incremental grid is that a cell survives a re-render (and a scroll frame) instead
   * of being rebuilt — see ListPanel.syncCells. Sits below bodyLayer so the chrome drawn there (tab
   * rail, scroll indicator, empty-state label) still paints over the cells.
   */
  gridLayer!: PIXI.Container;
  /** Clip rect for {@link gridLayer}; ListPanel redraws it whenever the grid viewport changes. */
  gridClip!: PIXI.Graphics;
  modalLayer!: PIXI.Container;
  loadingLayer!: PIXI.Container;
  /**
   * The title bar itself, in its own layer because the title belongs to the active tab and so has
   * to be redrawn on every render() — see {@link renderHeader}.
   */
  headerLayer!: PIXI.Container;
  /** Drawn after the static header chrome so the coin balance + capacity readout sit on the same row as the title (matches EquipmentScene, EQUIPMENT_DESIGN header-alignment fix). */
  headerOverlayLayer!: PIXI.Container;

  backRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Right edge of the header's title group — drawHeaderCurrency's fit backstop. See build(). */
  titleRight = 0;
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  headerH = 0;
  /** `owner` (card instance id) tags a roster-cell hit so applyCardState()'s refresh can drop and
   *  re-add just that cell's hit without touching the rest of the list — see ListPanel.refreshCardCell. */
  hitRects: Hit[] = [];
  modalHits: { rect: Rect; action: () => void }[] = [];
  /**
   * Drag-slider hit zones for the modal layer (feed quantity slider, 2026-07-18): unlike modalHits
   * (tap-vs-drag deferred to pointer-up via ScrollTapGesture), a slider must track the pointer live
   * while down, so it's a separate list checked first in handleDown/handleMove.
   */
  modalSliders: { rect: Rect; onDrag: (x: number) => void }[] = [];
  /** Slider currently being dragged (set on a down inside a modalSliders rect), or null. */
  activeModalSlider: ((x: number) => void) | null = null;
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

  detailId: string | null = null;
  scrollY = 0;
  /**
   * Vertical bounds + max scroll of whichever grid is currently on screen (roster list / skins
   * wardrobe — mutually exclusive, so one set of fields covers both). Set at the end of each
   * renderList/renderSkinsTab's layout pass; consumed by the wheel handler below (PC-only — see
   * wheelScroll.ts) since neither render pass otherwise stores its listY/viewH/maxScroll past the
   * render() call that computed them.
   */
  scrollRegionTop = 0;
  scrollRegionBottom = 0;
  maxScroll = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a cell's hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a card scrolls instead of opening its detail). See ScrollTapGesture.
   */
  readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  scrollDirty = false;
  /**
   * Cheap redraw for a scroll step, installed by whichever grid is on screen (ListPanel.renderList).
   * A scroll only changes cell positions — never the card order, the cell contents or the chrome —
   * so a full render() there is pure waste: it used to re-mint every visible cell's ~7 PIXI.Text
   * every frame of a drag (~11 ms of rasterize + upload at 15 cells, measured). Null → update()
   * falls back to render(), which is still what the skins tab wants.
   */
  scrollRedraw: (() => void) | null = null;
  /** [Cards|Equipment?|Skins] sidebar nav — always shown (Skins is always reachable, LOBBY_IA_REDESIGN §15). */
  private readonly showSidebar = true;
  /** Active content tab: the card grid, or the skins wardrobe. */
  tab: CardSceneTab = 'list';
  /** Detail modal portrait flip state (front = art, back = lore) — tap the portrait to flip. */
  detailFlipped = false;
  /** Detail modal: whether the skin picker popover is open. */
  skinPickerOpen = false;
  /** Feed-select modal: pixel scroll offset of the (drag-scrollable) material list. */
  feedScrollPx = 0;
  /** Feed-select modal: largest valid {@link feedScrollPx} (contentH − listH); set each redraw. */
  feedScrollMax = 0;
  /** Feed-select modal: latched by a drag-move, consumed in update() to redraw at most once per frame. */
  feedScrollDirty = false;
  /** Feed-select modal: the panel redraw closure, so update()/handleMove can re-draw it. Null when closed. */
  feedRedraw: (() => void) | null = null;
  /** Removes the in-flight portrait flip's PIXI.Ticker.shared listener, if any (avoids leaking it across re-renders/destroy). */
  flipTickerCleanup: (() => void) | null = null;

  destroyed = false;
  /**
   * True for the whole span of a fuse (network call + `playFusionAnim`). While set, the busy-dots
   * re-render in `update()` must NOT run: `render()` would reopen the detail modal (detailId stays
   * set through the fuse) and `tearDownChildren(modalLayer)` would destroy the live fusion-animation
   * graphics out from under their own rAF loop — a `burst.clear()` on a destroyed Graphics then throws
   * "Cannot read properties of null (reading 'clear')", which also leaves the fuse promise unresolved
   * and `bt.busy` stuck on forever. The fuse ring is already drawn (feedRedraw) and stays put.
   */
  fuseInProgress = false;
  /**
   * True for the whole span the fusion ring is shown (openFuseSelect → actually closed/settled),
   * a strict superset of fuseInProgress (which only covers the network-call span). Pre-confirm —
   * while the player is still picking materials — `openFuseSelect` never clears `detailId`, so an
   * unguarded `render()`/`applyCardState()` (e.g. from `cb.onSaveChanged` firing for an unrelated
   * save change) would reopen the plain detail popup over the still-open ring (2026-08-03 fix) —
   * the assembly's `render()` dispatch and `applyCardState()` both check this before touching detailId.
   */
  fuseRingOpen = false;
  /**
   * Subscriptions torn down only at {@link destroy} — today just `cb.onSaveChanged`. Deliberately
   * NOT unsubscribed by {@link pause}: while an EquipmentScene overlay sits on top (ADR-072) every
   * equip/unequip writes the save, and the roster underneath has to keep folding those in, or the
   * player pops back to stale power/gear readouts on the cards they just changed. Only the pointer
   * subscriptions below are suspended for that span.
   */
  private readonly unsubs: (() => void)[] = [];
  /**
   * Pointer subscriptions, suspended by {@link pause} and re-established by {@link resume} — see
   * Scene.pause: InputManager broadcasts to every subscriber regardless of z-order, so a tap meant
   * for the overlay above would otherwise also run this scene's hit-rects underneath it.
   */
  inputUnsubs: (() => void)[] = [];
  /** Kept for {@link resume}'s re-subscribe — the constructor's `input` param is otherwise not retained. */
  private readonly input: InputManager;
  /** True between {@link pause} and {@link resume}: an overlay owns the screen, this scene is covered. */
  paused = false;
  /**
   * Set when a render() was requested while {@link paused} and skipped. A covered scene has nothing
   * to show for the work — and the overlay's own actions (equip/unequip/salvage/craft) each fire
   * `cb.onSaveChanged`, so an unguarded pass would rebuild the whole roster several times behind an
   * opaque panel. resume() renders once instead, off the final save.
   *
   * Set by the outer assembly's render() (the only gate that sees every render path), cleared here.
   */
  pendingRender = false;
  /** Portrait urls whose texture we've hooked for a one-shot re-render on load. */
  private readonly artHooked = new Set<string>();
  /**
   * Ink-ring spinners currently drawn in place of not-yet-loaded portrait art (see drawArtFit /
   * drawLoadingSpinner). Repopulated every render() pass (by the outer assembly); update() spins
   * whichever of these are still alive (a render pass elsewhere — e.g. openDetail's own
   * tearDownChildren — may have destroyed one before the next full render() clears the array, hence
   * the `destroyed` filter).
   */
  activeSpinners: PIXI.Graphics[] = [];
  /** Shared rotation angle for {@link activeSpinners}, advanced in update(). */
  private spinnerAngle = 0;

  /**
   * Fuse network action — see the file-header comment. Default no-op until the outer assembly
   * overwrites it right after constructing ActionsPanel.
   */
  doFuse: DoFuseFn = async () => {};

  /** Batch-prep network action — same lazy-hook arrangement as {@link doFuse}. */
  doPrepBatch: DoPrepBatchFn = async () => {};

  /** @param render Injected by the outer CardScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about every domain class) — Core and the
   *  domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *  called its own `render()` method verbatim. */
  constructor(
    layout: ILayout,
    input: InputManager,
    cb: CardCallbacks,
    readonly render: () => void,
  ) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.tab = cb.initialTab ?? 'list';
    this.container = new PIXI.Container();
    this.input = input;
    this.build();

    subscribeInput(this, input);
    // Guarded on fuseInProgress: fuseCards() resolves the save change synchronously via adoptServer,
    // firing this listener mid-fuse before playFusionAnim runs — an unguarded render() there would
    // tear the fusion ring/animation down out from under itself.
    //
    // Narrowed from fuseRingOpen to fuseInProgress (2026-08-18): the ring now stays open across a
    // settled fuse instead of closing, so the old, broader guard would have suppressed every save-
    // driven refresh for as long as the panel was up — leaving the header's coin/capacity readout and
    // the roster grid behind the panel stale after each fusion. The "don't reopen the plain detail
    // popup over the ring" half of the old rationale is already covered where it belongs: the
    // assembly's render() dispatch and applyCardState() both skip the detailId branch while
    // fuseRingOpen is set, so a render() during that span refreshes the background and leaves the
    // modal layer untouched.
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.fuseInProgress) this.render(); }));
  }

  /**
   * Scene.pause — an overlay (EquipmentScene, ADR-072) has been pushed on top; this scene stays
   * alive, mounted and subscribed to the save, but stops taking pointer input and stops rendering
   * (see {@link pendingRender}). Idempotent.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    unsubscribeInput(this);
    // A drag in flight when the overlay opened would otherwise resume mid-gesture on the way back,
    // turning the pop into a stray tap or a scroll jump.
    this.gesture.cancel();
    this.activeModalSlider = null;
  }

  /** Reverse of {@link pause}: re-take pointer input and flush the render the paused span skipped. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    subscribeInput(this, this.input);
    if (this.pendingRender) {
      this.pendingRender = false;
      this.render();
    }
  }

  private build(): void {
    const { w, h, landscape, showSidebar } = this;
    // Landscape only for now, and only when the sidebar is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape && showSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('cardbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.gridLayer = new PIXI.Container();
    this.gridClip = new PIXI.Graphics();
    this.container.addChild(this.gridLayer);
    this.container.addChild(this.gridClip);
    this.gridLayer.mask = this.gridClip;

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);
    this.loadingLayer = new PIXI.Container();
    this.container.addChild(this.loadingLayer);

    this.headerLayer = new PIXI.Container();
    this.container.addChild(this.headerLayer);
    this.renderHeader();

    this.headerOverlayLayer = new PIXI.Container();
    this.container.addChild(this.headerOverlayLayer);
  }

  /**
   * Title bar for the tab that is on screen. Drawn per render(), not once in build(): the header
   * used to be part of the one-shot layer scaffold, so switching to the wardrobe left "Hero Roster"
   * (and the roster glyph) sitting above a page of skins (2026-08-26). Same shape as FriendsScene's
   * drawHeader — title + glyph both keyed off the active tab.
   */
  renderHeader(): void {
    const { w, h } = this;
    tearDownChildren(this.headerLayer);
    const skins = this.tab === 'skins';
    // The title band has to know how wide the coin/capacity cluster ListPanel.renderHeaderCurrency()
    // draws on top of it: the old fixed 20%-of-width guess was ~7 points short of the real cluster on
    // a 430pt portrait viewport, so the centred "Hero Roster" ran straight under the coin number
    // (2026-08-24). Measured from the same spec the draw call uses.
    const spec = this.headerCurrencySpec();
    const hdr = drawSceneHeader(this.headerLayer, w, h, t(skins ? 'roster.tab.skins' : 'roster.title'), {
      variant: 'paper', accent: HEADER_ACCENT.spend, icon: skins ? 'skinIcon' : 'rosterIcon',
      rightReserve: headerCurrencyWidth(sceneHeaderHeight(h), spec.coins, [], spec.capacity, spec.scale),
    });
    this.backRect = hdr.backRect;
    this.headerH = hdr.headerH;
    this.titleRight = hdr.titleRight;
  }

  /**
   * Inputs for the header's coin + capacity cluster, in one place because two callers need the same
   * answer: renderHeader() measures it to size the title band, ListPanel.renderHeaderCurrency()
   * draws it. Splitting the expression between them is exactly how the reserve and the cluster
   * drift apart.
   *
   * The capacity readout counts CARDS, so it belongs to the roster grid only — on the wardrobe it
   * was a card count sitting over a page of skins (2026-08-26, same report as the stale title).
   */
  headerCurrencySpec(): { coins: number; capacity?: { text: string; color: number }; scale: number } {
    const save = this.cb.getSave();
    const count = Object.keys(save.cardInv ?? {}).length;
    const warn = count >= CARD_INV_CAP - CARD_INV_OVERFLOW_BUFFER;
    const full = count >= CARD_INV_CAP;
    return {
      coins: save.wallet.coins,
      capacity: this.tab === 'skins' ? undefined : {
        text: t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP)),
        color: full ? C.red : warn ? C.gold : C.mid,
      },
      // Keep the readout at a compact absolute size (matches EquipmentScene, its [Cards|Equipment]
      // peer) rather than scaling it up with the taller unified header.
      scale: 100 / sceneHeaderHeight(this.h),
    };
  }

  /**
   * Draw a unit portrait, centered & fit into a box; re-render once the texture loads.
   * Pass `boxH` to fit into a (possibly non-square) rectangle — the portrait scales to
   * whichever axis is tighter and stays centered, so tall cells never clip or stretch it.
   */
  drawArtFit(url: string, x: number, y: number, box: number, layer: PIXI.Container = this.bodyLayer, boxH?: number): void {
    const tex = getArtTexture(url);
    const bh = boxH ?? box;
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => this.render());
      }
      this.drawLoadingSpinner(x + box / 2, y + bh / 2, Math.min(box, bh), layer);
      return;
    }
    const scale = containScale(tex.width, tex.height, box, bh);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + box / 2, y + bh / 2);
    layer.addChild(sp);
  }

  /**
   * Hand-drawn spinning ink ring, drawn centered in a not-yet-loaded portrait's box (drawArtFit) so
   * the slot never sits blank while the texture streams in — matches the WorldMap first-paint
   * loading cover's spinner (WorldMapRenderer/build.ts buildLoadingOverlay). Registers itself in
   * {@link activeSpinners} so update() can spin it every frame.
   */
  private drawLoadingSpinner(cx: number, cy: number, boxMin: number, layer: PIXI.Container): void {
    const radius = Math.max(9, Math.min(boxMin * 0.18, 22));
    const spinner = new PIXI.Graphics();
    spinner.lineStyle(3, C.mid, 0.9);
    spinner.arc(0, 0, radius, -Math.PI * 0.15, Math.PI * 1.25);
    spinner.position.set(cx, cy);
    spinner.rotation = this.spinnerAngle;
    layer.addChild(spinner);
    this.activeSpinners.push(spinner);
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────

  closeDetail(): void {
    this.detailId = null;
    this.detailFlipped = false;
    this.skinPickerOpen = false;
    this.closeModal();
  }

  closeModal(): void {
    this.flipTickerCleanup?.();
    this.flipTickerCleanup = null;
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalSliders = [];
    this.activeModalSlider = null;
    this.modalOpen = false;
    this.fuseRingOpen = false;
    this.modalScale = 1;
    this.modalOriginX = 0;
    this.modalOriginY = 0;
    this.feedRedraw = null;
    this.feedScrollPx = 0;
    this.feedScrollMax = 0;
    this.feedScrollDirty = false;
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

  // ── Toast ─────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Input / lifecycle ─────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.activeSpinners.length) {
      this.spinnerAngle += dt * 4;
      for (const g of this.activeSpinners) if (!g.destroyed) g.rotation = this.spinnerAngle;
      this.activeSpinners = this.activeSpinners.filter((g) => !g.destroyed);
    }
    if (this.scrollDirty) {
      this.scrollDirty = false;
      if (this.scrollRedraw) this.scrollRedraw(); else this.render();
    }
    if (this.feedScrollDirty) { this.feedScrollDirty = false; this.feedRedraw?.(); }
    // Advance the busy-dot state every frame, but skip the re-render mid-fuse: rebuilding the scene
    // there tears down the fusion-animation graphics and crashes their rAF loop (see fuseInProgress).
    const dirty = this.bt.tick(dt);
    if (dirty && !this.fuseInProgress) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.flipTickerCleanup?.();
    this.flipTickerCleanup = null;
    unsubscribeInput(this);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    // tearDownChildren first, then destroy: the bare `destroy({ children: true })` this used to be
    // frees nested PIXI.Text objects but leaves their canvases orphaned (the `texture` flag defaults
    // to false for descendants — see tearDownChildren's doc). It also does the right thing by the
    // shared caches, freeing only Text and leaving Sprites' textures (fastText, bake, atlases) alone.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }
}
