// Shared foundation for the CardScene mixin chain (see ../CardScene.ts assembly).
//
// CardSceneBase holds every instance field (all `protected`, so the panel/action mixin bodies keep
// referencing them verbatim: this.bt, this.detailId, this.modalLayer, …) + the layer scaffold (build),
// the render dispatcher, the shared portrait helper (drawArtFit), modal/toast primitives, and the
// input/lifecycle plumbing. Each UI domain (list / detail modal / feed flow) and the network actions
// live in their own sibling file as `XMixin(Base)` and are chained into the final CardScene.
//
// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10).
//   List: card inventory grouped deployed-first, power desc within each group; capacity counter (n/500).
//   Detail modal: stats + skill + troop cap + gear 3 slots + fusion-readiness bar + lock toggle + fuse + list-auction.
//   Fuse flow: select target → fusion panel (center card + 5 material slots, same faction+level) → fuseCards().
// Server-authoritative (L2): all mutations go through server endpoints; SaveData is the read-only mirror.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t, type TranslationKey } from '../../i18n';
import {
  ui as C, txt, scaledTxt, buildPaperBackground, sketchPanel, seedFor,
  drawLoadingOverlay, tearDownChildren,
} from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { FS } from '../../render/fontScale';
import { getArtTexture } from '../../render/cardArt';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, cardPower } from '../../game/meta/cardDefs';
import type { UnitType } from '../../game/types';

export type CardActionResult = { ok: true } | { ok: false; key: TranslationKey };

export type CardSceneTab = 'list' | 'skins';

export interface CardCallbacks {
  onBack(): void;
  getSave(): SaveData;
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the save (wallet/inventory/...). Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
  /** SLG per-card state (troops/injury/teamId); undefined when outside SLG. */
  getCardState?(): Record<string, CardSLGState> | undefined;
  /** Human-readable name for an SLG team id; undefined when outside SLG or the team can't be resolved. */
  getTeamName?(teamId: string): string | undefined;
  /** Fuse cards: consumes exactly 5 materialCardIds (same faction+level as target), targetCardId +1 level. */
  fuseCards(targetCardId: string, materialCardIds: string[]): Promise<CardActionResult>;
  /** Toggle card lock. */
  setCardLock(cardInstanceId: string, locked: boolean): Promise<CardActionResult>;
  /** Recover an injured card by spending coins. Only present when in SLG context. */
  recoverCard?(cardInstanceId: string): Promise<CardActionResult>;
  /**
   * Navigate to equipment scene for a specific card. Absent offline (E5 is server-authoritative).
   * `slot`, when given (a specific gear-slot tap), pre-selects the matching filter tab instead of "All".
   */
  openEquipment?(cardInstanceId: string, slot?: EquipSlot): void;
  /**
   * Open the equipment bag as a peer of the roster (LOBBY_IA_REDESIGN). When injected, a
   * [Cards|Equipment] group tab strip is shown; tapping Equipment enters the bag (no active card).
   * Absent offline.
   */
  openEquipmentBag?(): void;
  /** Owned skin ids (server-authoritative inventory; readable offline from the local mirror). */
  getOwnedSkins(): string[];
  /** Currently equipped skin id for a character, or null for the default look (LOBBY_IA_REDESIGN §15). */
  getEquippedSkin(unitType: UnitType): string | null;
  /** Equip a skin on a character, or null to revert to the default look. */
  equipSkin(unitType: UnitType, skinId: string | null): void;
  /**
   * Content tab to open on first paint; defaults to the roster grid ('list'). Lets a caller land
   * directly on the Skins wardrobe — e.g. tapping the Skins peer from EquipmentScene's sidebar rail
   * (the [Cards | Equipment | Skins] growth group, LOBBY_IA_REDESIGN §15).
   */
  initialTab?: CardSceneTab;
}

/**
 * Handle returned by AppViews.showCardRoster, letting the caller push a late-arriving SLG fetch
 * (getCardState/getTeamName data resolving after the roster already opened without it) into an
 * already-open roster — see game.ts goCardRoster.
 */
export interface CardRosterView {
  /** Re-render just the SLG-derived bits of already-visible cells; see CardSceneBase.applyCardState. */
  applyCardState(): void;
}

export const MODAL_DIM = 0x000000;

// Roster grid: icon-card cells — a full-height portrait on the left with all the
// hero info (name / level / power / troops / gear) stacked immediately to its right.
// Narrower than the equipment cells so hero cards pack denser and don't read as empty.
export const CELL_GAP = 12;
// Taller than EquipmentScene's EQUIP_CELL_H (they used to be unified at 177): hero cards carry a
// full-height character portrait that reads better with more vertical room, so the roster grid is
// deliberately taller. Width is still deliberately narrower so hero cards pack denser.
export const CARD_CELL_H = 266; // 1.5x the previous 177 (taller hero cards)
export const CARD_CELL_W_TARGET = 300;

export interface Rect { x: number; y: number; w: number; h: number; }

const DEF_ORDER = Object.keys(CARD_DEFS);

/**
 * Sort cards for the roster grid: cards deployed to an SLG team come first, the rest after (2026-08-01
 * — deployed cards used to scatter across the level-grouped grid instead of reading as "my current
 * squad" at a glance). Within each group, highest combat power first (the stat that matters when
 * picking who to send out); ties fall back to level desc, then hero (CARD_DEFS declaration order,
 * keeps duplicate instances of one hero together), then id for stability.
 *
 * `cardState` is the SLG per-card state (teamId) — omit it, or pass one where a card has no entry, to
 * treat that card as not deployed (e.g. outside SLG, or before the async SLG fetch resolves).
 */
export function sortCards(
  cards: CardInstance[],
  equipInv: SaveData['equipmentInv'],
  cardState?: Record<string, CardSLGState>,
): CardInstance[] {
  return [...cards].sort((a, b) => {
    const ad = !!cardState?.[a.id]?.teamId;
    const bd = !!cardState?.[b.id]?.teamId;
    if (ad !== bd) return ad ? -1 : 1;
    const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
    if (pd !== 0) return pd;
    if (b.level !== a.level) return b.level - a.level;
    const gd = DEF_ORDER.indexOf(a.defId) - DEF_ORDER.indexOf(b.defId);
    if (gd !== 0) return gd;
    return a.id < b.id ? -1 : 1;
  });
}

/** Human-readable countdown string for injuredUntil timestamp. */
export function injuryCountdown(injuredUntil: number, now: number): string {
  const secsLeft = Math.max(0, Math.ceil((injuredUntil - now) / 1000));
  return secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type CardSceneBaseCtor = Constructor<CardSceneBase>;

export class CardSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: CardCallbacks;
  protected readonly bt = new BusyTracker();

  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;
  protected loadingLayer!: PIXI.Container;
  /** Drawn after the static header chrome so the coin balance + capacity readout sit on the same row as the title (matches EquipmentScene, EQUIPMENT_DESIGN header-alignment fix). */
  protected headerOverlayLayer!: PIXI.Container;

  protected backRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  protected headerH = 0;
  /** `owner` (card instance id) tags a roster-cell hit so applyCardState()'s refresh can drop and
   *  re-add just that cell's hit without touching the rest of the list — see ListMixin.refreshCardCell. */
  protected hitRects: { rect: Rect; action: () => void; owner?: string }[] = [];
  protected modalHits: { rect: Rect; action: () => void }[] = [];
  /**
   * Drag-slider hit zones for the modal layer (feed quantity slider, 2026-07-18): unlike modalHits
   * (tap-vs-drag deferred to pointer-up via ScrollTapGesture), a slider must track the pointer live
   * while down, so it's a separate list checked first in handleDown/handleMove.
   */
  protected modalSliders: { rect: Rect; onDrag: (x: number) => void }[] = [];
  /** Slider currently being dragged (set on a down inside a modalSliders rect), or null. */
  private activeModalSlider: ((x: number) => void) | null = null;
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

  protected detailId: string | null = null;
  protected scrollY = 0;
  /**
   * Vertical bounds + max scroll of whichever grid is currently on screen (roster list / skins
   * wardrobe — mutually exclusive, so one set of fields covers both). Set at the end of each
   * renderList/renderSkinsTab's layout pass; consumed by the wheel handler below (PC-only — see
   * wheelScroll.ts) since neither render pass otherwise stores its listY/viewH/maxScroll past the
   * render() call that computed them.
   */
  protected scrollRegionTop = 0;
  protected scrollRegionBottom = 0;
  protected maxScroll = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a cell's hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a card scrolls instead of opening its detail). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;
  /** [Cards|Equipment?|Skins] sidebar nav — always shown (Skins is always reachable, LOBBY_IA_REDESIGN §15). */
  protected readonly showSidebar = true;
  /** Active content tab: the card grid, or the skins wardrobe. */
  protected tab: CardSceneTab = 'list';
  /** Detail modal portrait flip state (front = art, back = lore) — tap the portrait to flip. */
  protected detailFlipped = false;
  /** Detail modal: whether the skin picker popover is open. */
  protected skinPickerOpen = false;
  /** Feed-select modal: pixel scroll offset of the (drag-scrollable) material list. */
  protected feedScrollPx = 0;
  /** Feed-select modal: largest valid {@link feedScrollPx} (contentH − listH); set each redraw. */
  protected feedScrollMax = 0;
  /** Feed-select modal: latched by a drag-move, consumed in update() to redraw at most once per frame. */
  protected feedScrollDirty = false;
  /** Feed-select modal: the panel redraw closure, so base input/update code can re-draw it. Null when closed. */
  protected feedRedraw: (() => void) | null = null;
  /** Removes the in-flight portrait flip's PIXI.Ticker.shared listener, if any (avoids leaking it across re-renders/destroy). */
  protected flipTickerCleanup: (() => void) | null = null;

  protected destroyed = false;
  /**
   * True for the whole span of a fuse (network call + `playFusionAnim`). While set, the busy-dots
   * re-render in `update()` must NOT run: `render()` would reopen the detail modal (detailId stays
   * set through the fuse) and `tearDownChildren(modalLayer)` would destroy the live fusion-animation
   * graphics out from under their own rAF loop — a `burst.clear()` on a destroyed Graphics then throws
   * "Cannot read properties of null (reading 'clear')", which also leaves the fuse promise unresolved
   * and `bt.busy` stuck on forever. The fuse ring is already drawn (feedRedraw) and stays put.
   */
  protected fuseInProgress = false;
  protected readonly unsubs: (() => void)[] = [];
  /** Portrait urls whose texture we've hooked for a one-shot re-render on load. */
  protected readonly artHooked = new Set<string>();
  /**
   * Ink-ring spinners currently drawn in place of not-yet-loaded portrait art (see drawArtFit /
   * drawLoadingSpinner). Repopulated every render() pass; update() spins whichever of these are
   * still alive (a render pass elsewhere — e.g. openDetail's own tearDownChildren — may have
   * destroyed one before the next full render() clears the array, hence the `destroyed` filter).
   */
  protected activeSpinners: PIXI.Graphics[] = [];
  /** Shared rotation angle for {@link activeSpinners}, advanced in update(). */
  private spinnerAngle = 0;

  constructor(layout: ILayout, input: InputManager, cb: CardCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.tab = cb.initialTab ?? 'list';
    this.container = new PIXI.Container();
    this.build();
    this.render();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    // Desktop mouse-wheel scroll (browser only — see wheelScroll.ts); the detail/feed modal doesn't
    // scroll via this path, so a wheel event while one is open is ignored, mirroring handleMove's
    // modalOpen guard below.
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      if (this.modalOpen) return;
      const next = wheelScrollY(this.scrollRegionTop, this.scrollRegionBottom, y, deltaY, this.scrollY, this.maxScroll);
      if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
    }));
    // Guarded like update()'s dirty-render below (see fuseInProgress): fuseCards() resolves the save
    // change synchronously via adoptServer, firing this listener mid-fuse, before playFusionAnim runs —
    // an unguarded render() here would tear down the fusion ring/animation out from under itself.
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.fuseInProgress) this.render(); }));
  }

  private build(): void {
    const { w, h, landscape, showSidebar } = this;
    // Landscape only for now, and only when the sidebar is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape && showSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('cardbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);
    this.loadingLayer = new PIXI.Container();
    this.container.addChild(this.loadingLayer);

    const hdr = drawSceneHeader(this.container, w, h, t('roster.title'), {
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
    tearDownChildren(this.loadingLayer);
    this.activeSpinners = [];
    this.hitRects.push({ rect: this.backRect, action: () => this.cb.onBack() });

    this.renderHeaderCurrency();
    this.renderSidebar();
    if (this.tab === 'skins') this.renderSkinsTab();
    else this.renderList();

    if (this.tab === 'list' && this.detailId) this.openDetail(this.detailId);
    else if (this.modalOpen) this.closeModal();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.loadingLayer, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  /**
   * Draw a unit portrait, centered & fit into a box; re-render once the texture loads.
   * Pass `boxH` to fit into a (possibly non-square) rectangle — the portrait scales to
   * whichever axis is tighter and stays centered, so tall cells never clip or stretch it.
   */
  protected drawArtFit(url: string, x: number, y: number, box: number, layer: PIXI.Container = this.bodyLayer, boxH?: number): void {
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
    const scale = Math.min(box / tex.width, bh / tex.height);
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

  protected closeDetail(): void {
    this.detailId = null;
    this.detailFlipped = false;
    this.skinPickerOpen = false;
    this.closeModal();
  }

  protected closeModal(): void {
    this.flipTickerCleanup?.();
    this.flipTickerCleanup = null;
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalSliders = [];
    this.activeModalSlider = null;
    this.modalOpen = false;
    this.modalScale = 1;
    this.modalOriginX = 0;
    this.modalOriginY = 0;
    this.feedRedraw = null;
    this.feedScrollPx = 0;
    this.feedScrollMax = 0;
    this.feedScrollDirty = false;
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

  // ── Toast ─────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Input / lifecycle ─────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      // The header Back button must stay reachable even with the detail modal open — otherwise a
      // tap there falls through to the modal's own dim-to-close catch-all and just closes the
      // modal instead of leaving the scene (LOBBY_IA_REDESIGN back-button-always-works fix, 2026-07-14).
      if (this.inRect(x, y, this.backRect)) { this.cb.onBack(); return; }
      // A slider (feed quantity drag bar) must track the pointer live, not defer to up like a tap —
      // check it first and, if hit, jump the value to the press point immediately.
      for (const { rect, onDrag } of this.modalSliders) {
        if (this.inRect(x, y, rect)) { this.activeModalSlider = onDrag; onDrag(x); return; }
      }
      // Defer the modal hit to pointer-UP and drop it if the pointer drags past the threshold, same
      // as the grid behind it — so a press-drag-release on a feed-select row (or any modal row) only
      // toggles on release, and a drag away doesn't accidentally toggle it (2026-07-17).
      let modalHit: (() => void) | null = null;
      for (const { rect, action } of this.modalHits) {
        if (this.inRect(x, y, rect)) { modalHit = action; break; }
      }
      // The feed modal is drag-scrollable: track from its own scroll base so a drag pans the list
      // (see handleMove). Other modals don't scroll — feedRedraw is null and the returned delta is ignored.
      this.gesture.down(this.feedScrollPx, y, modalHit);
      return;
    }
    // Don't fire the hit action here — capture it and start gesture tracking. If the pointer then
    // drags past the threshold it becomes a scroll and the tap is dropped on up; otherwise the tap
    // fires on up. This lets a drag that starts *on a card cell* scroll the grid instead of instantly
    // opening that card's detail.
    let hit: (() => void) | null = null;
    for (const { rect, action } of this.hitRects) {
      if (this.inRect(x, y, rect)) { hit = action; break; }
    }
    this.gesture.down(this.scrollY, y, hit);
  }

  private handleMove(x: number, y: number): void {
    if (this.activeModalSlider) { this.activeModalSlider(x); return; }
    // Feed the move to the gesture even while a modal is open: the modal doesn't scroll, but this
    // latches `moved` once the pointer crosses the drag threshold so the pending modal tap is dropped on up.
    const scroll = this.gesture.move(y);
    if (this.modalOpen) {
      // Only the feed modal scrolls; apply the drag delta to its pixel offset (clamped on redraw)
      // and latch a dirty flag so update() redraws the panel at most once per frame.
      if (scroll !== null && this.feedRedraw) {
        this.feedScrollPx = Math.max(0, Math.min(scroll, this.feedScrollMax));
        this.feedScrollDirty = true;
      }
      return;
    }
    if (scroll !== null) { this.scrollY = scroll; this.scrollDirty = true; }
  }

  private handleUp(): void {
    if (this.activeModalSlider) { this.activeModalSlider = null; return; }
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  private inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  update(dt: number): void {
    if (this.activeSpinners.length) {
      this.spinnerAngle += dt * 4;
      for (const g of this.activeSpinners) if (!g.destroyed) g.rotation = this.spinnerAngle;
      this.activeSpinners = this.activeSpinners.filter((g) => !g.destroyed);
    }
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
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
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.container.destroy({ children: true });
  }
}

// ── Panel/action entrypoints dispatched to from base-level code (render) and across sibling mixins
// (list → openDetail; detail → feed/actions; feed → actions). Declared via interface/class declaration
// merging so base-level `this.renderList()` / `this.openDetail()` type-check as METHODS (not properties,
// which would clash with the mixin override — TS2425). Emits NOTHING at runtime, so the real prototype
// methods provided by the mixins run and all method bodies stay verbatim.
export interface CardSceneBase {
  renderSidebar(): void;
  renderHeaderCurrency(): void;
  renderList(): void;
  renderCardCell(card: CardInstance, x: number, y: number, cellW: number, state: CardSLGState | undefined, now: number, save: SaveData): void;
  /**
   * Re-render only the SLG-derived bits (border color / troop count / deployed tag, + the detail
   * modal if open) of already-visible roster cells, after cb.getCardState()/getTeamName() data
   * changes — e.g. a worldsvc fetch that resolved after the roster's own load window gave up
   * (game.ts goCardRoster). No full render(): deliberately does NOT re-sort/reposition cells even
   * though sortCards' deployed-first grouping does read this same state — a card that *becomes*
   * deployed via this late patch stays wherever it was already drawn until the next full render(),
   * trading perfect ordering for not yanking the grid (and the user's scroll position) out from
   * under them right as they're looking at it.
   */
  applyCardState(): void;
  openDetail(cardId: string): void;
  renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void;
  openFuseSelect(target: CardInstance): void;
  doFuse(targetId: string, materialIds: string[], onSettled?: (success: boolean) => void): Promise<void>;
  doSetLock(cardId: string, locked: boolean): Promise<void>;
  doRecover(cardId: string): Promise<void>;
  renderSkinsTab(): void;
  /** Placeholder in-engine fusion animation (programmer art; see FeedMixin). Resolves when it finishes. */
  playFusionAnim?(): Promise<void>;
}
