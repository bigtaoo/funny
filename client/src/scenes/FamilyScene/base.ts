// Shared foundation for the FamilyScene mixin chain (see ../FamilyScene.ts assembly).
//
// FamilySceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.mode, this.family, this.bodyLayer, …) + the layer scaffold (build),
// the render dispatcher, the shared confirm-modal / toast / error primitives, and the input/lifecycle
// plumbing. Each UI domain (data / render / input overlay / actions) lives in its own sibling file as
// `XMixin(Base)` and is chained into the final FamilyScene.
//
// FamilyScene — SLG family management scene (S8-4)
// State machine: noFamily → search/create branch; myFamily → channel/members
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../render/confirmDialog';
import { showToastMessage } from '../../net/log';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { FAMILY_CAP } from '@nw/shared';
import type { WorldApiClient, FamilyDetailView, FamilyMemberView, FamilyMessageView, FamilyJoinRequestView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../render/socialTabRail';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';

export interface FamilySceneCallbacks {
  onBack(): void;
  /** Open the sect hub (S8-4b) — sect = a family-of-families, rooted in the family UI. */
  onOpenSect(): void;
  /** Rail click for one of the other 4 social tabs (friends/sect/world/mail); 'family' is a no-op. */
  onNavTab(tab: SocialTab): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
  /** current player's display name, denormalized onto sent family messages */
  playerName: string;
}

export type FamilyTab = 'members' | 'channel';
export type ViewMode = 'loading' | 'noFamily' | 'create' | 'myFamily';

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type FamilySceneBaseCtor = Constructor<FamilySceneBase>;

export class FamilySceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: FamilySceneCallbacks;

  protected mode: ViewMode = 'loading';
  protected activeTab: FamilyTab = 'members';

  protected family: FamilyDetailView | null = null;
  protected members: FamilyMemberView[] = [];
  protected messages: FamilyMessageView[] = [];
  /** Pending join requests for my family — populated only when I'm a leader/elder (see isFamilyApprover). */
  protected joinRequests: FamilyJoinRequestView[] = [];

  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;

  // Input overlay for create form
  protected hiddenInput: HTMLInputElement | null = null;
  // Input overlay for the channel send box — set while open so the Send button can read its value.
  // `sendText` mirrors its value so the on-canvas field shows what's being typed (+ blinking caret),
  // instead of staying stuck on the placeholder (the "can't type into chat" bug).
  protected sendInput: HTMLInputElement | null = null;
  protected sendText = '';
  protected createName = '';
  protected createTag = '';
  protected createField: 'name' | 'tag' | null = null;
  protected caretOn = true;
  protected caretTimer = 0;

  // Scroll — `scrollY` is the roster/single-column scroll; `scrollYChannel` only comes into play
  // in the landscape split view (see RenderMixin.renderSplitView), where the channel column
  // scrolls independently alongside the roster column instead of sharing one tab's scroll state.
  protected scrollY = 0;
  protected scrollYChannel = 0;
  /** X boundary between the roster and channel columns in the landscape split view; used by
   *  handleDown to route a drag to the right column's scroll state. Unused (0) in portrait. */
  protected chatColX = 0;
  /** Title-bar height, set from the shared header — drives all body layout below it. */
  protected headerH = 0;
  /** Live header text nodes (title + landscape family identity), drawn on top of the cached header
   *  chrome. Destroyed and rebuilt each renderHeader() so repeated renders (e.g. scroll drags) don't
   *  stack duplicate Text nodes on the container. */
  private headerExtras: PIXI.DisplayObject[] = [];
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a member/message cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Which column the in-progress drag scrolls — captured at pointer-down, applied in handleMove. */
  private dragTarget: 'members' | 'channel' = 'members';
  /** Set by handleMove instead of rendering inline — pointermove can fire far faster than the display
   *  refresh rate, and render() fully tears down/rebuilds every Text/Graphics node in the roster and
   *  channel lists, so calling it per-event caused visible jank while dragging. update() (ticker-gated,
   *  once per frame) drains this instead. */
  private scrollDirty = false;

  // Hit rects
  protected hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalOpen = false;

  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: FamilySceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    // Paint the rail + loading state on the same frame the scene mounts, so switching to the
    // family tab shows the chrome instantly instead of a blank body while loadData()'s network
    // round-trips are in flight (the "tab switch takes several seconds" complaint).
    this.render();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
  }

  /** Width of the social hub rail left of the notebook binding line (matches every other left-edge tab rail). */
  protected get railW(): number {
    return sidebarNavW(this.w, this.h, this.landscape);
  }

  /** Font size as a fraction of design height. The family scene originally hardcoded 10–15px, which
   *  renders tiny in the 1920×1080 / 1080×1920 design space — sizing off `h` matches FriendsScene and
   *  the rest of the social hub so the text is legible instead of near-invisible. */
  protected fs(frac: number): number {
    return Math.round(this.h * frac);
  }

  /** Roster / channel list row height (was a fixed 48px — too short for legible two-line rows). */
  protected get rowH(): number {
    return Math.round(this.h * 0.062);
  }

  /** Height of the family identity band below the header. Portrait keeps the full name/count +
   *  prosperity + announcement band; landscape lifts the identity into the header (see
   *  drawHeaderTitle) and reserves the band only for an announcement, if any. */
  protected get infoBandH(): number {
    if (this.landscape) return this.family?.announcement ? Math.round(this.h * 0.04) : 0;
    return Math.round(this.h * 0.085);
  }

  protected get isFamilyLeader(): boolean {
    return this.family?.members?.find((m) => m.accountId === this.cb.myAccountId)?.role === 'leader';
  }

  /** Leader or elder — the two roles allowed to review join requests (matches familyService's server-side gate). */
  protected get isFamilyApprover(): boolean {
    const role = this.family?.members?.find((m) => m.accountId === this.cb.myAccountId)?.role;
    return role === 'leader' || role === 'elder';
  }

  private build(): void {
    const { w, h, landscape } = this;
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    const bg = buildPaperBackground('family', w, h, { railX });
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
    // the family identity lifted out of the info band) are drawn live below so we control layout.
    const hdr = drawSceneHeader(this.container, w, this.h, null, {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
    this.drawHeaderTitle(hdr.headerH);
  }

  /** Muted secondary ink (a step below C.dark, still legible on paper) — matches RenderMixin's MUTED. */
  private static readonly MUTED = 0x5a574f;

  /** Header title row. Always shows the "Family" title just right of the back pill. In landscape
   *  (where there's horizontal room) it also carries the family identity the info band used to hold:
   *  `[TAG] Name` + prosperity on the left, member count pinned far-right. Portrait keeps that identity
   *  in the info band below the header, since the narrow bar can't hold it all on one line. */
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

    // Left cluster must clear the back-button pill. Replicates SceneHeader's back-chip
    // metrics (BACK_X=10, size=0.039·h, padX=0.7·size) so the title always clears the pill.
    const backSize = Math.round(h * 0.039);
    const backNode = txt(`← ${t('common.back')}`, backSize, C.accent);
    const chipW = backNode.width + Math.round(backSize * 0.7) * 2;
    backNode.destroy();
    const leftBound = 10 + chipW + Math.round(backSize * 0.6);

    const showIdentity = this.landscape && this.family && this.mode === 'myFamily';
    const gap = Math.round(w * 0.02);
    const fam = showIdentity ? this.family! : null;

    // Build every node up front (unpositioned) so we can measure the whole cluster's width and
    // center it in the space between the back pill and the member count, instead of it always
    // starting flush against the back button — which read lopsided once the identity was moved
    // into the landscape header.
    const titleNode = add(txt(t('family.title'), FS.headline, C.dark, true));
    let clusterW = titleNode.width;

    let nameNode: PIXI.Text | null = null;
    let star: PIXI.DisplayObject | null = null;
    let starSize = 0;
    let prosNode: PIXI.Text | null = null;
    let countNode: PIXI.Text | null = null;
    if (fam) {
      nameNode = add(txt(`[${fam.tag}] ${fam.name}`, FS.title, C.dark));
      starSize = Math.round(h * 0.026);
      star = add(buildIcon('star', starSize, 0xd4a030));
      prosNode = add(txt(t('family.prosperity', { n: fam.prosperity }), FS.heading, 0xa9750f));
      countNode = add(txt(t('family.memberCount', { n: fam.memberCount, cap: FAMILY_CAP }), FS.heading, FamilySceneBase.MUTED));
      clusterW += gap + nameNode.width + gap + starSize + 6 + prosNode.width;
    }

    const rightBound = countNode ? w - 16 - countNode.width - gap : w - 16;
    const available = rightBound - leftBound;
    let x = leftBound + Math.max(0, (available - clusterW) / 2);

    titleNode.anchor.set(0, 0.5); titleNode.x = x; titleNode.y = midY;
    x += titleNode.width;

    if (fam && nameNode && star && prosNode && countNode) {
      x += gap;
      nameNode.anchor.set(0, 0.5); nameNode.x = x; nameNode.y = midY;
      x += nameNode.width + gap;

      star.x = x; star.y = midY - starSize / 2;
      x += starSize + 6;
      prosNode.anchor.set(0, 0.5); prosNode.x = x; prosNode.y = midY;

      countNode.anchor.set(1, 0.5); countNode.x = w - 16; countNode.y = midY;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer); // create-form input re-renders per keystroke → free Text textures
    this.hitRects = [];
    this.renderHeader();

    // Draw the social hub rail in every mode (not just 'myFamily') — otherwise the other 4 tabs
    // vanish while this scene is still loading or has no family yet, since it replaces FriendsScene
    // wholesale on navigation.
    // Same sect-tab visibility rule as FriendsScene's rail: hide it unless this player is a
    // family leader (who could found/join a sect) or their family is already in one.
    const hidden: SocialTab[] = !this.isFamilyLeader && !this.family?.sectId ? ['sect'] : [];
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'family', {}, (tab) => this.cb.onNavTab(tab), hidden);
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noFamily': this.renderNoFamily(); break;
      case 'create': this.renderCreate(); break;
      case 'myFamily': this.renderMyFamily(); break;
    }
  }

  // ── Confirm modal ─────────────────────────────────────────────────────────

  protected showConfirm(msg: string, onOk: () => void): void {
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => this.closeModal());
  }

  protected closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  protected errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        ALREADY_IN_FAMILY: t('family.err.alreadyIn'),
        FAMILY_FULL:       t('family.err.cap'),
        NOT_IN_FAMILY:     t('family.err.notIn'),
        NO_PERMISSION:     t('family.err.noPermission'),
        INVALID_TAG:       t('family.err.badTag'),
        NOT_FOUND:         t('family.err.notFound'),
        ALREADY_REQUESTED: t('family.err.alreadyRequested'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
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
    // whichever tab is active (members ↔ scrollY, channel ↔ scrollYChannel — see renderTabbedView).
    this.dragTarget =
      this.mode !== 'myFamily' ? 'members'
      : this.landscape ? (x >= this.chatColX ? 'channel' : 'members')
      : this.activeTab;
    this.gesture.down(this.dragTarget === 'channel' ? this.scrollYChannel : this.scrollY, y, hit);
  }

  handleMove(_x: number, y: number): void {
    const next = this.gesture.move(y);
    if (next === null) return;
    if (this.dragTarget === 'channel') this.scrollYChannel = next;
    else this.scrollY = next;
    this.scrollDirty = true;
  }

  handleUp(_x: number, _y: number): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    // Blink the caret while either the create-form fields or the channel send box are focused.
    if (this.createField || this.sendInput) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    if (this.sendInput) { this.sendInput.remove(); this.sendInput = null; }
    this.container.destroy({ children: true });
  }
}

// ── Domain entrypoints dispatched to from base-level code (render dispatcher, constructor) and across
// sibling mixins (render → input/actions; actions → data; input → data). Declared via interface/class
// declaration merging so base-level `this.renderLoading()` / `this.loadData()` type-check as METHODS
// (not properties, which would clash with the mixin override — TS2425). Emits NOTHING at runtime, so
// the real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface FamilySceneBase {
  // data
  loadData(): Promise<void>;
  loadMyFamily(familyId: string): Promise<void>;
  loadChannel(): Promise<void>;
  loadJoinRequests(): Promise<void>;
  // render
  renderLoading(): void;
  renderNoFamily(): void;
  renderCreate(): void;
  renderMyFamily(): void;
  // input overlay
  openInputFor(field: 'name' | 'tag'): void;
  openSendInput(): void;
  // actions
  doCreate(): Promise<void>;
  openJoinList(): Promise<void>;
  doSendMsg(): Promise<void>;
  submitMessage(body: string): Promise<void>;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  confirmKick(targetId: string, name: string): void;
  confirmDissolve(): void;
  confirmLeave(): void;
  openJoinRequests(): void;
}
