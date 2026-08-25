// Shared foundation for the FamilyScene composition (see ../FamilyScene.ts assembly).
//
// FamilySceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.mode, this.core.family, this.core.bodyLayer, …) +
// the layer scaffold (build), the static header, the shared confirm-modal / toast / error
// primitives, the member-profile popup, and the pointer-input/lifecycle plumbing. Core wires all
// four InputManager subscriptions itself AND owns handleDown/handleMove/handleUp/handleWheel
// directly — they only ever dispatch through pre-registered `hitRects`/`modalHits` closures (set by
// whichever domain rendered them), never calling a domain method by name, so there's no
// two-phase-construction concern here. Core does NOT own the render() dispatcher (which calls into
// RenderPanel's mode-specific methods) — that lives on the outer ../FamilyScene.ts assembly since
// only it knows about every domain instance (Core takes a `render` callback injected at
// construction instead of owning render() itself).
//
// Each domain (data / input-overlay / actions / render) is its own independent class in a sibling
// file, constructed with `core` (2026-08-11: converted from the former `XMixin(Base)` inheritance
// chain — the cross-mixin calls this used to reach via interface declaration merging are now
// explicit constructor params instead, see claudedocs/client-modules.md's split-form priority
// note). Dependency shape: Render → Actions, Input; Actions → Data; Input → Data; Data depends only
// on Core.
//
// One genuine bidirectional dependency surfaced during the conversion: the old actions.ts's
// doSendMsg() called input.ts's openSendInput() (when there's no draft yet) while input.ts's Enter-
// key handler called actions.ts's submitMessage() (to actually send). Splitting "open the hidden
// input" and "submit whatever it collected" across two domain classes was the wrong boundary — both
// are just two faces of the channel's single text-entry flow, so submitMessage() and doSendMsg()
// moved to InputPanel alongside openSendInput()/openInputFor() (submitMessage needs DataPanel's
// loadChannel() to reconcile after sending, hence InputPanel takes `data` too). ActionsPanel no
// longer references Input at all — one-way (Render → Actions, Input) like every other pair.
//
// FamilyScene — SLG family management scene (S8-4).
// State machine: noFamily → search/create branch; myFamily → channel/members
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import { ProfilePopup, type ProfileAction } from '../../ui/dialogs/ProfilePopup';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import type { FamilyDetailView, FamilyMemberView, FamilyMessageView, FamilyJoinRequestView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { drawSocialTabRail, type SocialTab } from '../../ui/widgets/socialTabRail';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { BusyTracker, TimeoutError } from '../../ui/busyTracker';
import { drawHeaderTitle } from './header';
import { FamilyRepaint, type ScrollCol } from './repaint';
import type { FamilySceneCallbacks, FamilyTab, ViewMode } from './types';

// Pure declarations live in ./types.ts (form ①, no logic) — re-exported here so existing
// `from './FamilyScene/core'` imports keep resolving to the same names.
export type { FamilySceneCallbacks, FamilySceneView, FamilyTab, ViewMode } from './types';

export class FamilySceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: FamilySceneCallbacks;

  mode: ViewMode = 'loading';
  activeTab: FamilyTab = 'members';

  family: FamilyDetailView | null = null;
  members: FamilyMemberView[] = [];
  messages: FamilyMessageView[] = [];
  /** Pending join requests for my family — populated only when I'm a leader/elder (see isFamilyApprover). */
  joinRequests: FamilyJoinRequestView[] = [];
  /** publicIds of the caller's current friends (see FamilySceneCallbacks.getFriendPublicIds) — gates the
   *  member-profile popup's "Add Friend" action so it doesn't show on rows that are already friends. */
  friendPublicIds: Set<string> = new Set();

  bodyLayer!: PIXI.Container;
  modalLayer!: PIXI.Container;
  /** Unified player-info popup — opened by tapping a member's name in the roster. */
  readonly profilePopup: ProfilePopup;

  // Input overlay for create form
  hiddenInput: HTMLInputElement | null = null;
  // Input overlay for the channel send box — set while open so the Send button can read its value.
  // `sendText` mirrors its value so the on-canvas field shows what's being typed (+ blinking caret),
  // instead of staying stuck on the placeholder (the "can't type into chat" bug).
  sendInput: HTMLInputElement | null = null;
  sendText = '';
  createName = '';
  createTag = '';
  createField: 'name' | 'tag' | null = null;
  caretOn = true;
  caretTimer = 0;

  // Scroll — `scrollY` is the roster/single-column scroll; `scrollYChannel` only comes into play
  // in the landscape split view (see RenderPanel.renderSplitView), where the channel column
  // scrolls independently alongside the roster column instead of sharing one tab's scroll state.
  scrollY = 0;
  scrollYChannel = 0;
  /** Pin the channel to the latest message; cleared once the user scrolls up to read history, re-armed
   *  when they drag back to the bottom or send a message (see renderChannel / handleMove / submitMessage). */
  channelStick = true;
  /** Channel scroll extent from the last renderChannel — lets handleMove classify a channel drag as
   *  "back at the bottom" (re-stick) vs "scrolled up" (unstick) without recomputing the content height. */
  channelMax = 0;
  /** X boundary between the roster and channel columns in the landscape split view; used by
   *  handleDown to route a drag to the right column's scroll state. Unused (0) in portrait. */
  chatColX = 0;
  /** Roster viewport vertical bounds + scroll extent, set each renderMembers call — mirrors
   *  channelMax/channelRegion* but for the members column. Touch-drag scroll doesn't need an upfront
   *  region/max (it just clamps on the next render), but wheel scroll (handleWheel) needs both known
   *  before the event is handled, so they're captured here purely for that. */
  membersRegionTop = 0;
  membersRegionBottom = 0;
  membersMax = 0;
  /** Channel viewport vertical bounds, set each renderChannel call — same reasoning as membersRegion*. */
  channelRegionTop = 0;
  channelRegionBottom = 0;
  /** Title-bar height, set from the shared header — drives all body layout below it. */
  headerH = 0;
  /** Live header text nodes (title + landscape family identity), drawn on top of the cached header
   *  chrome. Destroyed and rebuilt each renderHeader() so repeated renders (e.g. scroll drags) don't
   *  stack duplicate Text nodes on the container. Public: header.ts (a form① free-function module,
   *  not a domain class) rebuilds this list directly — see drawHeaderTitle's file-header comment. */
  headerExtras: PIXI.DisplayObject[] = [];
  /**
   * Tap-vs-drag gesture tracker: defers a hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a member/message cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Which column the in-progress drag scrolls — captured at pointer-down, applied in handleMove. */
  private dragCol: ScrollCol = 'members';
  /** The column a drag/wheel just moved, set by handleMove/handleWheel instead of acting inline —
   *  pointermove fires far faster than the display refresh rate. update() (ticker-gated, once per
   *  frame) drains it through repaint.applyScroll, which translates the pre-built column instead of
   *  tearing down and rebuilding every Text/Graphics node in it. */
  private scrollDirtyCol: ScrollCol | null = null;
  /** Handles for the incremental repaint paths (per-column scroll translate / caret blink /
   *  keystroke) — everything that used to be an unconditional full render(). See ./repaint.ts. */
  readonly repaint = new FamilyRepaint(this);

  // Hit rects. `scroll` marks a rect recorded in a scroll layer's build space (see ./repaint.ts):
  // handleDown maps the tap into that space and drops it when the tap landed outside the column's
  // viewport, where the overscan band's pre-built rows live.
  hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void; scroll?: ScrollCol }[] = [];
  modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalOpen = false;

  destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  /** Guards every mutating action below (create/join/leave/dissolve/kick/setRole/join-request
   *  response/send message): blocks a repeat click while one is in flight and drives the busy-button
   *  greying in render.ts. */
  readonly bt = new BusyTracker();

  /** @param render Injected by the outer FamilyScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about every domain instance) — Core and the
   *  domain classes call `this.render()`/`core.render()` wherever the old flattened class called
   *  its own `render()` method verbatim. Does NOT auto-fire the initial loadData() — the outer
   *  assembly does that after all domain instances exist.
   *  @param openEmblemPicker Same lazy-callback trick as `render` above: header.ts (drawHeaderTitle,
   *  owned by Core, not RenderPanel) needs to open ActionsPanel's emblem-picker modal for the leader's
   *  badge tap, but ActionsPanel doesn't exist yet when Core is constructed — this closure is only
   *  ever invoked later (on tap), by which point the outer assembly has assigned `this.actions`. */
  constructor(layout: ILayout, input: InputManager, cb: FamilySceneCallbacks, readonly render: () => void, readonly openEmblemPicker: () => void) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.container = new PIXI.Container();
    this.profilePopup = new ProfilePopup(this.w, this.h, (publicId) => cb.worldApi.getProfileExtra(publicId));
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((x, y, deltaY) => this.handleWheel(x, y, deltaY)));
  }

  /** Width of the social hub rail left of the notebook binding line (matches every other left-edge tab
   *  rail); 0 in portrait, where the rail is drawn as a bottom nav bar instead (§18) and reserves no
   *  horizontal space. */
  get railW(): number {
    return this.landscape ? sidebarNavW(this.w, this.h, true) : 0;
  }

  /** Bottom edge for portrait's tabbed body content — stops `bottomNavH` short of the screen so the
   *  bottom nav bar (always shown; drawSocialTabRail has no orientation gate) never overlaps the
   *  roster/channel viewport. Landscape's split view has no such bar to avoid. */
  get bodyBottom(): number {
    return this.landscape ? this.h : this.h - bottomNavH(this.h);
  }

  /** Font size as a fraction of design height. The family scene originally hardcoded 10–15px, which
   *  renders tiny in the 1920×1080 / 1080×1920 design space — sizing off `h` matches FriendsScene and
   *  the rest of the social hub so the text is legible instead of near-invisible. */
  fs(frac: number): number {
    return Math.round(this.h * frac);
  }

  /** Roster / channel list row height (was a fixed 48px — too short for legible two-line rows). */
  get rowH(): number {
    return Math.round(this.h * 0.062);
  }

  /** Height of the family identity band below the header. Portrait keeps the full name/count +
   *  prosperity + announcement band; landscape lifts the identity into the header (see
   *  drawHeaderTitle) and reserves the band only for an announcement, if any. */
  get infoBandH(): number {
    if (this.landscape) return this.family?.announcement ? Math.round(this.h * 0.04) : 0;
    return Math.round(this.h * 0.085);
  }

  /**
   * Which column a pointer at screen `x` scrolls. The landscape split view shows both columns side
   * by side (routed by the divider); portrait shows one at a time, so the active tab decides. Modes
   * other than 'myFamily' have neither column, and a scroll there falls back to a full render anyway.
   */
  scrollColAt(x: number): ScrollCol {
    if (this.mode !== 'myFamily') return 'members';
    if (this.landscape) return x >= this.chatColX ? 'channel' : 'members';
    return this.activeTab;
  }

  /** Which of the two scroll fields a column's position lives in — mirrors the `scrollKey` every
   *  render path passes to renderMembers/renderChannel: unlike the sect page, both orientations map
   *  the roster to `scrollY` and the channel to `scrollYChannel`. */
  scrollKeyFor(col: ScrollCol): 'scrollY' | 'scrollYChannel' {
    return col === 'channel' ? 'scrollYChannel' : 'scrollY';
  }

  /** Is screen `y` inside a column's viewport? See handleDown for why a hit needs this. */
  private inViewport(col: ScrollCol, y: number): boolean {
    return col === 'channel'
      ? y >= this.channelRegionTop && y <= this.channelRegionBottom
      : y >= this.membersRegionTop && y <= this.membersRegionBottom;
  }

  get isFamilyLeader(): boolean {
    return this.family?.members?.find((m) => m.accountId === this.cb.myAccountId)?.role === 'leader';
  }

  /** Leader or elder — the two roles allowed to review join requests (matches familyService's server-side gate). */
  get isFamilyApprover(): boolean {
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

    // Persistent singleton, added once and reused across renders — render()/tearDownChildren()
    // never touch it (mirrors modalLayer above, not the bodyLayer that gets rebuilt each render).
    this.container.addChild(this.profilePopup.container);

    this.renderHeader();
  }

  renderHeader(): void {
    const { w } = this;
    // Draw only the bar chrome + back button from the shared header; the title (and, in landscape,
    // the family identity lifted out of the info band) are drawn live below so we control layout.
    const hdr = drawSceneHeader(this.container, w, this.h, null, {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
    drawHeaderTitle(this, hdr.headerH);
  }

  // ── Rail + mode dispatch shell (called from the outer render() dispatcher before it hands off to
  // RenderPanel's mode-specific method) ──────────────────────────────────────────

  /** Tears down + redraws the header/rail chrome shared by every mode; returns nothing — the outer
   *  render() dispatcher calls this, then draws the rail itself, then switches on `mode`. */
  beginRender(): void {
    tearDownChildren(this.bodyLayer); // free the Text baseTextures this frame's tree is about to drop
    this.hitRects = [];
    // Everything the incremental-repaint paths hold onto lived in bodyLayer and was just destroyed —
    // drop the refs so each path falls back to a full render instead of touching a dead node.
    this.repaint.reset();
    this.renderHeader();
  }

  /** Draw the social hub rail in every mode (not just 'myFamily') — otherwise the other 4 tabs
   *  vanish while this scene is still loading or has no family yet, since it replaces FriendsScene
   *  wholesale on navigation. Same sect-tab visibility rule as FriendsScene's rail: hide it unless
   *  this player is a family leader (who could found/join a sect) or their family is already in one. */
  drawRail(): void {
    const hidden: SocialTab[] = !this.isFamilyLeader && !this.family?.sectId ? ['sect'] : [];
    const railHits = drawSocialTabRail(this.bodyLayer, this.w, this.h, this.headerH, this.landscape, 'family', { family: this.joinRequests.length }, (tab) => this.cb.onNavTab(tab), hidden);
    this.hitRects.push(...railHits.map((hit) => ({ rect: hit.rect, action: hit.fn })));
  }

  // ── Confirm modal ─────────────────────────────────────────────────────────

  showConfirm(msg: string, onOk: () => void): void {
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => this.closeModal());
  }

  closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  errorMsg(e: unknown): string {
    if (e instanceof TimeoutError) return t('common.networkTimeout');
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
    if (this.profilePopup.isOpen) return;
    if (this.modalOpen) {
      // Reverse order: the full-screen dim-to-close rect is always pushed first, so checking
      // in push order made it win over every button drawn on top of it (approve/reject, pick
      // rows, ...) — clicks looked like they did nothing because they just closed the modal.
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
    //
    // A rect tagged `scroll` was recorded in its column's build space, and that layer may since have
    // been translated by a cheap scroll — so map the tap into the same space, deliberately by the
    // APPLIED delta rather than the pending one (see FamilyRepaint.appliedDelta).
    let hit: (() => void) | null = null;
    for (const { rect, action, scroll } of this.hitRects) {
      const py = scroll ? y + this.repaint.appliedDelta(scroll) : y;
      if (x < rect.x || x > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      // Rows are built one viewport beyond the region in each direction, so a hit rect alone no
      // longer implies "on screen" — a tap outside the column's viewport must miss.
      if (scroll && !this.inViewport(scroll, y)) continue;
      hit = action; break;
    }
    this.dragCol = this.scrollColAt(x);
    this.gesture.down(this[this.scrollKeyFor(this.dragCol)], y, hit);
  }

  handleMove(_x: number, y: number): void {
    const next = this.gesture.move(y);
    if (next === null) return;
    const col = this.dragCol;
    this[this.scrollKeyFor(col)] = next;
    // Dragging to the bottom re-pins to the latest; scrolling up releases the pin so incoming
    // messages don't yank the reader back down (the "channel jumps while I'm reading" complaint).
    if (col === 'channel') this.channelStick = next >= this.channelMax - 1;
    this.scrollDirtyCol = col;
  }

  handleUp(x: number, y: number): void {
    // Popup taps never reach `gesture` (handleDown returned before arming it while open) — route
    // them through the popup's own manual hit-test instead of trusting its PIXI-native pointertap
    // alone (see ProfilePopup.handleTap doc comment: safe even if that native path also fires).
    if (this.profilePopup.isOpen) { this.profilePopup.handleTap(x, y); return; }
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** PC-only mouse-wheel scroll (see wheelScroll.ts). Mirrors handleMove's routing: in the landscape
   *  split view the roster/channel columns scroll independently (routed by chatColX, same as
   *  handleDown); portrait's single-column tab view scrolls whichever tab is active (members ↔
   *  scrollY, channel ↔ scrollYChannel — see renderTabbedView). */
  handleWheel(x: number, y: number, deltaY: number): void {
    if (this.profilePopup.isOpen || this.modalOpen || this.mode !== 'myFamily') return;
    const col = this.scrollColAt(x);
    const key = this.scrollKeyFor(col);
    const channel = col === 'channel';
    const top = channel ? this.channelRegionTop : this.membersRegionTop;
    const bottom = channel ? this.channelRegionBottom : this.membersRegionBottom;
    const max = channel ? this.channelMax : this.membersMax;
    const next = wheelScrollY(top, bottom, y, deltaY, this[key], max);
    if (next === null) return;
    this[key] = next;
    if (channel) this.channelStick = next >= this.channelMax - 1;
    this.scrollDirtyCol = col;
  }

  update(dt: number): void {
    // Deliberately no redraw off the busy tracker: nothing on this scene draws its dots/loading
    // overlay (bt only greys buttons while a mutating action is in flight), and every bt.start()/
    // stop() already pairs with its own render() (actions.ts / input.ts's submitMessage) — so
    // ticking it used to cost 2.5 full rebuilds a second for zero visual change. Add a dots overlay
    // and it has to route through `repaint`, not render().
    this.bt.tick(dt);
    // Both tickers below move exactly one thing where render() rebuilds the whole body, so they go
    // through `repaint` instead (see ./repaint.ts).
    if (this.scrollDirtyCol) {
      const col = this.scrollDirtyCol;
      this.scrollDirtyCol = null;
      this.repaint.applyScroll(col);
    }
    // Blink the caret while either the create-form fields or the channel send box are focused.
    if (this.createField || this.sendInput) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.repaint.blinkCaret(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    if (this.sendInput) { this.sendInput.remove(); this.sendInput = null; }
    this.profilePopup.destroy();
    // Free descendant Text baseTextures before dropping the container (overlay over the live
    // WorldMapScene → leaks a screenful of Text per close otherwise). See sketchUi.tearDownChildren.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }

  // ── Member profile popup ──────────────────────────────────────────────────

  /** Opens the unified profile popup for a roster row: "Message" when we're already friends with
   *  them, "Add Friend" otherwise (neither for my own row). Rank/ELO/family/sect are fetched by the
   *  popup itself (see ProfilePopup's `fetchExtra`) — this only supplies what the roster already has
   *  for free (name/avatar). */
  openMemberProfile(mem: FamilyMemberView): void {
    const isMe = mem.accountId === this.cb.myAccountId;
    const alreadyFriend = !!mem.publicId && this.friendPublicIds.has(mem.publicId);
    const actions: ProfileAction[] = [];
    if (!isMe && mem.publicId) {
      const publicId = mem.publicId;
      actions.push(
        alreadyFriend
          ? { labelKey: 'friends.message', fn: () => this.cb.openChat(publicId, mem.displayName ?? publicId) }
          : { labelKey: 'friends.add', fn: () => void this.doAddFriend(publicId) },
      );
    }
    this.profilePopup.show({
      name: mem.displayName ?? mem.publicId ?? t('family.unknownMember'),
      publicId: mem.publicId ?? '',
      isSelf: isMe,
      actions,
      ...(mem.avatarId ? { avatarId: mem.avatarId } : {}),
    });
  }

  private async doAddFriend(publicId: string): Promise<void> {
    try {
      await this.cb.addFriend(publicId);
      this.showToast(t('friends.requestSent'), C.dark);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      const map: Record<string, string> = {
        ALREADY_FRIEND: t('friends.alreadyFriend'),
        FRIEND_CAP_REACHED: t('friends.capReached'),
        BLOCKED: t('friends.blocked'),
        NOT_FOUND: t('friends.notFound'),
      };
      this.showToast((code && map[code]) ?? t('friends.error'), C.red);
    }
  }
}
