// Shared foundation for the CardScene mixin chain (see ../CardScene.ts assembly).
//
// CardSceneBase holds every instance field (all `protected`, so the panel/action mixin bodies keep
// referencing them verbatim: this.bt, this.detailId, this.modalLayer, …) + the layer scaffold (build),
// the render dispatcher, the shared portrait helper (drawArtFit), modal/toast primitives, and the
// input/lifecycle plumbing. Each UI domain (list / detail modal / feed flow) and the network actions
// live in their own sibling file as `XMixin(Base)` and are chained into the final CardScene.
//
// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10).
//   List: card inventory sorted by power desc → level desc; capacity counter (n/150).
//   Detail modal: stats + skill + troop cap + gear 3 slots + XP bar + lock toggle + feed + list-auction.
//   Feed flow: select target → material selection panel (same-faction, multi-select) → feedCards().
// Server-authoritative (L2): all mutations go through server endpoints; SaveData is the read-only mirror.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t, type TranslationKey } from '../../i18n';
import {
  ui as C, txt, buildPaperBackground, sketchPanel, seedFor,
  drawLoadingOverlay, tearDownChildren,
} from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { FS } from '../../render/fontScale';
import { getArtTexture } from '../../render/cardArt';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, cardPower } from '../../game/meta/cardDefs';
import type { UnitType } from '../../game/types';

export type CardActionResult = { ok: true } | { ok: false; key: TranslationKey };

export type CardSceneTab = 'list' | 'skins';

export interface CardCallbacks {
  onBack(): void;
  getSave(): SaveData;
  /** SLG per-card state (troops/injury/teamId); undefined when outside SLG. */
  getCardState?(): Record<string, CardSLGState> | undefined;
  /** Feed cards: consumes materialCardIds, grants XP to targetCardId. */
  feedCards(targetCardId: string, materialCardIds: string[]): Promise<CardActionResult & { levelsGained?: number }>;
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
 * Sort cards: grouped by hero (CARD_DEFS declaration order) so duplicate instances of the same
 * hero sit together instead of interleaving with others at the same power — same-name cards were
 * scattering across the grid and reading as visual noise. Within a group: power desc, level desc,
 * id for stability.
 */
export function sortCards(cards: CardInstance[], equipInv: SaveData['equipmentInv']): CardInstance[] {
  return [...cards].sort((a, b) => {
    const gd = DEF_ORDER.indexOf(a.defId) - DEF_ORDER.indexOf(b.defId);
    if (gd !== 0) return gd;
    const pd = cardPower(b, equipInv) - cardPower(a, equipInv);
    if (pd !== 0) return pd;
    if (b.level !== a.level) return b.level - a.level;
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
  protected toastLayer!: PIXI.Container;
  protected loadingLayer!: PIXI.Container;
  /** Drawn after the static header chrome so the coin balance + capacity readout sit on the same row as the title (matches EquipmentScene, EQUIPMENT_DESIGN header-alignment fix). */
  protected headerOverlayLayer!: PIXI.Container;

  protected backRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Title-bar height, set from the shared header in build() — drives all body layout below it. */
  protected headerH = 0;
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

  protected detailId: string | null = null;
  protected scrollY = 0;
  protected dragStart: { x: number; y: number; scroll: number } | null = null;
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
  /** Feed-select modal: index of the first visible material row (paged list, not free-scroll). */
  protected feedScrollIdx = 0;
  /** Removes the in-flight portrait flip's PIXI.Ticker.shared listener, if any (avoids leaking it across re-renders/destroy). */
  protected flipTickerCleanup: (() => void) | null = null;

  protected toastTimer = 0;
  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];
  /** Portrait urls whose texture we've hooked for a one-shot re-render on load. */
  protected readonly artHooked = new Set<string>();

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
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
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
    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);
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
    this.loadingLayer.removeChildren();
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
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => this.render());
      }
      return;
    }
    const bh = boxH ?? box;
    const scale = Math.min(box / tex.width, bh / tex.height);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + box / 2, y + bh / 2);
    layer.addChild(sp);
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

  // ── Toast ─────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, FS.heading, 0xffffff, true);
    const padX = 28, padY = 16;
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (this.w - bw) / 2;
    const by = Math.round(this.h * 2 / 3 - bh / 2);
    const bg = sketchPanel(bw, bh, { fill: color, fillAlpha: 0.96, border: color, seed: seedFor(bw, bh, 3) });
    bg.x = bx; bg.y = by;
    tl.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    tl.addChild(lbl);
    this.toastTimer = 2200;
  }

  // ── Input / lifecycle ─────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    if (this.modalOpen) {
      // The header Back button must stay reachable even with the detail modal open — otherwise a
      // tap there falls through to the modal's own dim-to-close catch-all and just closes the
      // modal instead of leaving the scene (LOBBY_IA_REDESIGN back-button-always-works fix, 2026-07-14).
      if (this.inRect(x, y, this.backRect)) { this.cb.onBack(); return; }
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

  private handleMove(y: number): void {
    if (!this.dragStart || this.modalOpen) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.scrollDirty = true;
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  private inRect(x: number, y: number, r: Rect): boolean {
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
  openDetail(cardId: string): void;
  renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void;
  openFeedSelect(target: CardInstance): void;
  doFeed(targetId: string, materialIds: string[]): Promise<void>;
  doSetLock(cardId: string, locked: boolean): Promise<void>;
  doRecover(cardId: string): Promise<void>;
  renderSkinsTab(): void;
}
