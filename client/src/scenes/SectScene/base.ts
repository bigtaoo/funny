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
import { ui as C, txt, buildPaperBackground, tearDownChildren, sketchPanel, seedFor } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { buildIcon } from '../../render/icons';
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
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. the world map underneath) changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
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
  /** Live header text/button nodes (title +, in landscape, the sect identity + alliance controls
   *  lifted out of the body — see drawHeaderTitle), drawn on top of the cached header chrome.
   *  Destroyed and rebuilt each renderHeader() so repeated renders don't stack duplicate nodes. */
  private headerExtras: PIXI.DisplayObject[] = [];
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
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));
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
    // Draw only the bar chrome + back button from the shared header; the title (and, in landscape,
    // the sect identity + alliance controls lifted out of the body) are drawn live below so we
    // control layout — mirrors FamilySceneBase.renderHeader/drawHeaderTitle.
    const hdr = drawSceneHeader(this.container, w, this.h, null, {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
    this.drawHeaderTitle(hdr.headerH);
  }

  /** Header title row. Always shows the "Sect" title just right of the back pill. In landscape
   *  (where there's horizontal room) it also carries the sect identity that used to live in a
   *  separate hand-drawn band below the header — `[TAG] Name` + families count + prosperity
   *  centered, alliance buttons pinned far-right (see the 25.07.2026 header-declutter pass, which
   *  removed the stacked hand-drawn bands that used to crowd the top-left corner). Portrait keeps
   *  identity in the body below the header, since the narrow bar can't hold it all on one line. */
  private drawHeaderTitle(headerH: number): void {
    const { w, h } = this;
    for (const n of this.headerExtras) n.destroy();
    this.headerExtras = [];
    const add = <T extends PIXI.DisplayObject>(node: T): T => {
      this.headerExtras.push(node);
      this.container.addChild(node);
      return node;
    };
    const midY = headerH / 2;

    // Left cluster must clear the back-button pill. Replicates SceneHeader's back-chip metrics
    // (BACK_X=10, size=0.039·h, padX=0.7·size) so the title always clears the pill.
    const backSize = Math.round(h * 0.039);
    const backNode = txt(`← ${t('common.back')}`, backSize, C.accent);
    const chipW = backNode.width + Math.round(backSize * 0.7) * 2;
    backNode.destroy();
    const leftBound = 10 + chipW + Math.round(backSize * 0.6);

    const showIdentity = this.landscape && this.sect && this.mode === 'mySect';
    const gap = Math.round(w * 0.02);
    const sect = showIdentity ? this.sect! : null;

    // Build every node up front (unpositioned) so the whole cluster's width can be measured and
    // centered in the space between the back pill and the alliance buttons.
    const titleNode = add(txt(t('sect.title'), FS.headline, C.dark, true));
    let clusterW = titleNode.width;

    let nameNode: PIXI.Text | null = null;
    let famNode: PIXI.Text | null = null;
    let star: PIXI.DisplayObject | null = null;
    let starSize = 0;
    let prosNode: PIXI.Text | null = null;
    if (sect) {
      nameNode = add(txt(`[${sect.tag}] ${sect.name}`, FS.title, C.dark));
      famNode = add(txt(t('sect.families', { n: sect.memberFamilyCount }), FS.heading, C.mid));
      starSize = Math.round(h * 0.026);
      star = add(buildIcon('star', starSize, 0xd4a030));
      prosNode = add(txt(t('sect.prosperity', { n: sect.prosperity }), FS.heading, 0xa9750f));
      clusterW += gap + nameNode.width + gap + famNode.width + gap + starSize + 6 + prosNode.width;
    }

    // Alliance buttons pinned to the header's right edge — placed before centering so their width
    // is reserved from the available cluster space (mirrors FamilySceneBase pinning the member
    // count far-right before centering its own title cluster).
    const btnsLeftX = sect ? this.drawHeaderAllianceButtons(w - 16, headerH, add) : w - 16;
    const rightBound = sect ? btnsLeftX - gap : btnsLeftX;
    const available = rightBound - leftBound;
    let x = leftBound + Math.max(0, (available - clusterW) / 2);

    titleNode.anchor.set(0, 0.5); titleNode.x = x; titleNode.y = midY;
    x += titleNode.width;

    if (sect && nameNode && famNode && star && prosNode) {
      x += gap;
      nameNode.anchor.set(0, 0.5); nameNode.x = x; nameNode.y = midY;
      x += nameNode.width + gap;

      famNode.anchor.set(0, 0.5); famNode.x = x; famNode.y = midY;
      x += famNode.width + gap;

      star.x = x; star.y = midY - starSize / 2;
      x += starSize + 6;
      prosNode.anchor.set(0, 0.5); prosNode.x = x; prosNode.y = midY;
    }
  }

  /** Alliance controls anchored to the header's right edge, laid out right-to-left. Viewing the
   *  ally list is open to every member (regular members need to know who the sect's allies are);
   *  forming (ally) and breaking (manage allies) alliances stay sect-leader only. Returns the x it
   *  stopped at, so the caller can reserve that space when centering the title cluster. Landscape
   *  only — see drawHeaderTitle's showIdentity gate (portrait keeps these in the body instead,
   *  via RenderMixin.renderFamilies' drawAllianceControlsRow). */
  private drawHeaderAllianceButtons(rightEdge: number, headerH: number, add: <T extends PIXI.DisplayObject>(node: T) => T): number {
    if (!this.sect) return rightEdge;
    const bh = Math.round(headerH * 0.4);
    const by = (headerH - bh) / 2;
    const padX = 14;
    let x = rightEdge;

    const addBtn = (label: string, color: number, action: () => void, seed: number): void => {
      const lbl = add(txt(label, FS.tiny, color));
      const bw = Math.ceil(lbl.width) + padX * 2;
      const bx = x - bw;
      const btn = add(sketchPanel(bw, bh, { fill: 0xf8f8f0, border: color, seed: seedFor(seed, 3, bw) }));
      btn.x = bx; btn.y = by;
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
      this.hitRects.push({ rect: { x: bx, y: by, w: bw, h: bh }, action });
      x = bx - 8;
    };

    if (this.isSectLeader) {
      addBtn(t('sect.manageAllies'), C.dark, () => void this.openManageAllies(), 2);
      addBtn(t('sect.ally'), C.accent, () => void this.openAllyList(), 1);
    } else {
      addBtn(t('sect.allies', { n: this.sect.allySectIds.length }), C.accent, () => void this.openAlliesView(), 1);
    }
    return x;
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
