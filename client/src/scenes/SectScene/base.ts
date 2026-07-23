// Shared foundation for the SectScene mixin chain (see ../SectScene.ts assembly).
//
// SectSceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.mode, this.sect, this.bodyLayer, this.modalLayer, …) + the layer
// scaffold (build), the static header, the permission getters, the render dispatcher, the shared
// close-modal / toast / error primitives, and the input/lifecycle plumbing. Each domain (data /
// render / input overlay / actions / modals) lives in its own sibling file as `XMixin(Base)` and is
// chained into the final SectScene.
//
// SectScene — SLG sect management scene (S8-4b, C6).
// A sect = a faction organization composed of families within a region; member unit is a family, linked by family.sectId.
// Most write operations require the requester to be the family leader (representing the whole family); disband/ally/unally are sect-master only.
// Channel is readable/writable by any sect member. Real-time push at scale goes through Redis (this slice uses REST polling, see SLG_DESIGN §9.3).
//
// Entry point: FamilyScene's "Sect" button (sects are the family of families, naturally belongs in the family UI).
// Aligned with FamilyScene pattern: modalLayer + hitRects/modalHits (dim click to close), hand-drawn sketchPanel/txt,
// subscribe input.onDown/Move/Up in constructor + unsubscribe in destroy (SLG scene input subscription was a latent bug, fixed in C3).

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import type {
  WorldApiClient, SectView, SectDetailView, SectMessageView,
} from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../render/socialTabRail';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { FS } from '../../render/fontScale';
import { wheelScrollY } from '../../ui/wheelScroll';

export interface SectSceneCallbacks {
  onBack(): void;
  /** Rail click for one of the other 4 social tabs (friends/family/world/mail); 'sect' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
  /** display name used as senderName for channel messages */
  playerName: string;
  /** current player's coin balance — drives the create-sect afford check */
  getCoins(): number;
  /** Re-syncs the local wallet cache after a spend the commercial service applied server-side (createSect). */
  refreshWallet(): Promise<void>;
}

/** Handle returned by showSect so the core can push live sect-channel messages in. */
export interface SectSceneView {
  applySectMsg(msg: SectMessageView): void;
}

export type SectTab = 'families' | 'channel';
export type ViewMode = 'loading' | 'noSect' | 'create' | 'mySect';

// Bumped from 48 so the enlarged (family-matched) row fonts — a heading-size name over a body-size
// stat line — fit without clipping. See RenderMixin.renderFamiliesList / renderChannel.
export const ROW_H = 68;

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type SectSceneBaseCtor = Constructor<SectSceneBase>;

export class SectSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: SectSceneCallbacks;

  protected mode: ViewMode = 'loading';
  protected activeTab: SectTab = 'families';

  // My family context (drives permission gating).
  protected myFamilyId: string | null = null;
  protected myFamilyRole: 'leader' | 'elder' | 'member' | null = null;
  protected inFamily = false;

  protected sect: SectDetailView | null = null;
  protected messages: SectMessageView[] = [];
  /** cache of all sects in the world — used for browse/ally name resolution. */
  protected sectsCache: SectView[] = [];

  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;

  // Create form
  protected hiddenInput: HTMLInputElement | null = null;
  protected createName = '';
  protected createTag = '';
  protected createField: 'name' | 'tag' | null = null;
  protected caretOn = true;
  protected caretTimer = 0;

  // Channel message draft — persists the hidden-input value so the visible Send button can send
  // it directly (previously the field and button both just reopened the hidden input, and the
  // only actual send path was a literal Enter keydown, which is unreliable on mobile keyboards).
  protected channelInput = '';
  protected channelActive = false;
  protected channelSending = false;

  // Scroll — `scrollY` is the families/single-column scroll; `scrollYChannel` only comes into play
  // in the landscape split view (see RenderMixin.renderSplitView), where the channel column scrolls
  // independently alongside the families column instead of sharing one tab's scroll state.
  protected scrollY = 0;
  protected scrollYChannel = 0;
  /** Pin the channel to the latest message; cleared once the user scrolls up to read history, re-armed
   *  when they drag back to the bottom or send a message (see renderChannel / handleMove). */
  protected channelStick = true;
  /** Channel scroll extent from the last renderChannel — lets handleMove classify a channel drag as
   *  "back at the bottom" (re-stick) vs "scrolled up" (unstick) without recomputing the content height. */
  protected channelMax = 0;
  /** X boundary between the families and channel columns in the landscape split view; used by
   *  handleDown to route a drag to the right column's scroll state. Unused (0) in portrait. */
  protected chatColX = 0;
  /** Families-list viewport vertical bounds + scroll extent, set each renderFamiliesList call — mirrors
   *  channelMax/channelRegion* but for the families column. Touch-drag scroll doesn't need an upfront
   *  region/max (it just clamps on the next render), but wheel scroll (onWheel) needs both known before
   *  the event is handled, so they're captured here purely for that. */
  protected familiesRegionTop = 0;
  protected familiesRegionBottom = 0;
  protected familiesMax = 0;
  /** Channel viewport vertical bounds, set each renderChannel call — same reasoning as familiesRegion*. */
  protected channelRegionTop = 0;
  protected channelRegionBottom = 0;
  /** Title-bar height, set from the shared header — drives all body layout below it. */
  protected headerH = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a member/list cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Which column the in-progress drag scrolls — captured at pointer-down, applied in handleMove. */
  private dragTarget: 'families' | 'channel' = 'families';
  /** Set by handleMove instead of rendering inline — see FamilySceneBase.scrollDirty for why. */
  private scrollDirty = false;

  // Hit rects
  protected hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalOpen = false;

  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: SectSceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((x, y, deltaY) => this.handleWheel(x, y, deltaY)));
  }

  /** Width of the social hub rail left of the notebook binding line (matches every other left-edge tab rail). */
  protected get railW(): number {
    return sidebarNavW(this.w, this.h, this.landscape);
  }

  private build(): void {
    const { w, h, landscape } = this;
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    const bg = buildPaperBackground('sect', w, h, { railX });
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.renderHeader();
  }

  protected renderHeader(): void {
    const { w } = this;
    const hdr = drawSceneHeader(this.container, w, this.h, t('sect.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Permission helpers ──────────────────────────────────────────────────────

  protected get isFamilyLeader(): boolean { return this.myFamilyRole === 'leader'; }
  protected get isSectLeader(): boolean { return !!this.sect && this.sect.leaderId === this.cb.myAccountId; }

  // ── Render ──────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer); // create-form input re-renders per keystroke → free Text textures
    this.hitRects = [];
    this.renderHeader();

    // Draw the social hub rail in every mode (not just 'mySect') — otherwise the other 4 tabs
    // vanish while this scene is still loading or has no sect yet, since it replaces FriendsScene
    // wholesale on navigation.
    // Hide the sect tab itself once we know the player is neither a family leader nor already
    // in a sect — same rule FriendsScene's rail applies, kept in sync so navigating between
    // scenes doesn't flicker the tab in and out.
    const hidden: SocialTab[] = !this.isFamilyLeader && !this.sect ? ['sect'] : [];
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'sect', {}, (tab) => this.cb.onNavTab(tab), hidden);
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noSect': this.renderNoSect(); break;
      case 'create': this.renderCreate(); break;
      case 'mySect': this.renderMySect(); break;
    }
  }

  // ── Modals ──────────────────────────────────────────────────────────────────

  protected closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ───────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  protected errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        ALREADY_IN_SECT:    t('sect.err.alreadyIn'),
        SECT_FULL:          t('sect.err.full'),
        NOT_IN_SECT:        t('sect.err.notIn'),
        NO_PERMISSION:      t('sect.err.noPermission'),
        NOT_FOUND:          t('sect.err.notFound'),
        ALLY_CAP_REACHED:   t('sect.err.allyCap'),
        INSUFFICIENT_FUNDS: t('sect.err.funds'),
        BAD_REQUEST:        t('sect.err.badReq'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ─────────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    if (this.modalOpen) {
      // Reverse order: the full-screen dim-to-close rect is always pushed first, so checking
      // in push order made it win over every button drawn on top of it — see FamilySceneBase's
      // handleDown for the same fix and the bug it addresses.
      for (let i = this.modalHits.length - 1; i >= 0; i--) {
        const { rect, action } = this.modalHits[i]!;
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action(); return;
        }
      }
      return;
    }
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a cell scrolls instead of firing it.
    let hit: (() => void) | null = null;
    for (const { rect, action } of this.hitRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { hit = action; break; }
    }
    // Landscape split view has two independently-scrolling columns — route by which side of the
    // divider the drag started on. Portrait's tab view has one column at a time, scrolled by
    // whichever tab is active (both share scrollY — see renderTabbedView).
    this.dragTarget =
      this.mode !== 'mySect' ? 'families'
      : this.landscape ? (x >= this.chatColX ? 'channel' : 'families')
      : 'families';
    this.gesture.down(this.dragTarget === 'channel' ? this.scrollYChannel : this.scrollY, y, hit);
  }

  handleMove(_x: number, y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll === null) return;
    // Dragging to the bottom re-pins the channel to the latest; scrolling up releases the pin so
    // incoming messages don't yank the reader back down. Portrait routes the channel tab through
    // scrollY (dragTarget stays 'families'), so classify by the active tab there.
    if (this.dragTarget === 'channel') {
      this.scrollYChannel = scroll;
      this.channelStick = scroll >= this.channelMax - 1;
    } else {
      this.scrollY = scroll;
      if (this.activeTab === 'channel') this.channelStick = scroll >= this.channelMax - 1;
    }
    this.scrollDirty = true;
  }

  handleUp(_x: number, _y: number): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** PC-only mouse-wheel scroll (see wheelScroll.ts). Mirrors handleMove's routing: in the landscape
   *  split view the families/channel columns scroll independently (routed by chatColX, same as
   *  handleDown); portrait's single-column tab view scrolls whichever tab is active, both sharing
   *  scrollY (see renderTabbedView). */
  handleWheel(x: number, y: number, deltaY: number): void {
    if (this.modalOpen || this.mode !== 'mySect') return;
    const useChannel = this.landscape ? x >= this.chatColX : this.activeTab === 'channel';
    if (useChannel) {
      // renderChannel is called with scrollKey='scrollYChannel' in the landscape split view but
      // 'scrollY' in the portrait tabbed view (single shared field) — see renderTabbedView/renderSplitView.
      const cur = this.landscape ? this.scrollYChannel : this.scrollY;
      const next = wheelScrollY(this.channelRegionTop, this.channelRegionBottom, y, deltaY, cur, this.channelMax);
      if (next === null) return;
      if (this.landscape) this.scrollYChannel = next; else this.scrollY = next;
      this.channelStick = next >= this.channelMax - 1;
      this.scrollDirty = true;
    } else {
      const next = wheelScrollY(this.familiesRegionTop, this.familiesRegionBottom, y, deltaY, this.scrollY, this.familiesMax);
      if (next === null) return;
      this.scrollY = next;
      this.scrollDirty = true;
    }
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.createField || this.channelActive) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    // Free descendant Text baseTextures before dropping the container (overlay over the live
    // WorldMapScene → leaks a screenful of Text per close otherwise). See sketchUi.tearDownChildren.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }
}

// ── Domain entrypoints dispatched to from base-level code (render / constructor) and across sibling
// mixins (render → input/actions; actions → modals/data; input → data). Declared via interface/class
// declaration merging so base-level `this.renderNoSect()` / cross-mixin `this.showSectPickModal()`
// type-check as METHODS (not properties, which would clash with the mixin override — TS2425). Emits
// NOTHING at runtime, so the real prototype methods provided by the mixins run and all bodies stay
// verbatim.
export interface SectSceneBase {
  // data
  loadData(): Promise<void>;
  loadMySect(sectId: string): Promise<void>;
  loadChannel(): Promise<void>;
  // render
  renderLoading(): void;
  renderNoSect(): void;
  renderCreate(): void;
  renderMySect(): void;
  // input overlay
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
  // actions
  doCreate(): Promise<void>;
  openBrowseList(): Promise<void>;
  confirmLeave(): void;
  confirmDissolve(): void;
  confirmVote(nomineeFamilyId: string, nomineeLabel: string): void;
  openAllyList(): Promise<void>;
  openAlliesView(): Promise<void>;
  openManageAllies(): Promise<void>;
  doSendChannelMessage(): Promise<void>;
  // modals
  showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies', readOnly?: boolean): void;
  showConfirm(msg: string, onOk: () => void): void;
}
