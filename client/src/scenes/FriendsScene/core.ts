// Shared foundation for the FriendsScene composition (see ../FriendsScene.ts assembly).
//
// FriendsSceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.friends, this.core.slgStatus, …) + pointer-input/
// drag dispatch, tab switching, toast, the confirm modal, and the inbound-push handlers — but NOT
// the render() dispatcher (which lives on the outer ../FriendsScene.ts assembly, since only it
// knows about all five tab-domain classes — Core takes a `render` callback injected at construction
// instead of owning render() itself) and NOT the shared chrome/render primitives (tab rail/header/
// hidden-input/scroll-region/button — see ./chrome.ts, split out purely to keep this file under the
// 500-line convention; every domain panel and the outer assembly call those as free functions taking
// `core` explicitly rather than through a Core method).
//
// switchTab/triggerTabLoads/the apply* inbound-push handlers all need NetworkPanel (refresh/
// loadSLGStatus/loadWorldMessages) — which doesn't exist yet at Core-construction time, same
// two-phase-construction shape as `render`. Rather than inventing a lazy callback per call site,
// Core holds one `net: NetworkHandlers` field (default a benign no-op stand-in), overwritten once by
// the outer assembly right after NetworkPanel is constructed and before the first real render.
//
// Each tab-domain panel (friendsList / search / orgForm / worldChat / mail) is its own independent
// class in a sibling file, constructed with `core` + `network: NetworkHandlers` (2026-08-11:
// converted from the former `XMixin(Base)` inheritance chain — the cross-mixin calls this used to
// reach via interface declaration merging are now explicit constructor params instead, see
// claudedocs/client-modules.md's split-form priority note). Every panel depends on NetworkPanel (via
// its full interface — each panel genuinely needs most of its surface) but NetworkPanel depends on
// none of them: one-way, so a plain composition rather than an inheritance chain.
import * as PIXI from 'pixi.js-legacy';
import { ILayout } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import { ProfilePopup, type ProfileExtra } from '../../ui/dialogs/ProfilePopup';
import { drawConfirmDialog, type ModalHit } from '../../ui/dialogs/confirmDialog';
import { tearDownChildren } from '../../render/sketchUi';
import { showToastMessage, type ToastKind } from '../../net/log';
import { sidebarNavW, bottomNavH } from '../../ui/widgets/HubTabs';
import { wheelScrollY } from '../../ui/wheelScroll';
import type {
  FriendView,
  FriendRequestView,
  ProfileView,
  ConversationView,
  MailView,
} from '../../net/ApiClient';
import type {
  FriendPresence,
  FriendRequestPush,
  FriendUpdate,
  ChatMessagePush,
  MailNew,
  DuelInvited,
  DuelCancelled,
} from '../../net/proto/transport';
import type { WorldChatMessage, FamilyView, FamilyDetailView } from '../../net/WorldApiClient';
import { serverNow } from '../../net/serverClock';
import type { NetworkHandlers } from './network';
import type { FriendsSceneCallbacks, Hit, Tab, View, SLGSocialStatus } from './types';

export type { SLGSocialStatus, FriendsSceneCallbacks, Tab, View, Hit } from './types';

const DRAG_THRESHOLD = 8;

/** Default `Core.net` before the outer assembly wires the real NetworkPanel — never actually
 *  reachable in practice (see `net`'s own doc comment) but keeps the field well-typed from the start. */
const NOOP_NETWORK: NetworkHandlers = {
  refresh: async () => {},
  loadSLGStatus: async () => {},
  loadWorldMessages: async () => {},
  doSearch: async () => {},
  doAdd: async () => {},
  doRespond: async () => {},
  doRemove: async () => {},
  doBlock: async () => {},
  doReport: async () => {},
  doDuel: () => {},
  doDuelRespond: () => {},
  doCreateFamily: async () => {},
  loadFamilyBrowse: async () => {},
  doJoinFamily: async () => {},
  doCreateSect: async () => {},
  doJoinSect: async () => {},
  doSendWorldChat: async () => {},
  doClaim: async () => {},
  doMailDelete: async () => {},
};

export class FriendsSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: FriendsSceneCallbacks;

  tab: Tab = 'friends';
  view: View = 'list';
  loading = true;
  friends: FriendView[] = [];
  incoming: FriendRequestView[] = [];
  /** Unread 1:1 chat conversations. Loaded alongside friends so the friends list can flag
   *  which friend has unread messages — the bottom-nav Social dot counts unread chat, and
   *  without surfacing it here that count opened onto a page showing nothing (aggregate-vs-
   *  specific badge bug — see mail-badge-social-aggregate-bug memory). */
  conversations: ConversationView[] = [];

  // Duel invites ("切磋", ADR friends-duel-confirm). At most one outstanding invite per direction:
  // matchsvc only tracks one pending sent-invite per account, so the client mirrors that instead of
  // letting the UI imply concurrent invites it can't actually track back to a specific inviteId
  // (the sender is never told the inviteId matchsvc minted — see DuelInvite proto doc).
  /** publicId of the friend I just invited, while awaiting their response — every row's duel button
   *  is disabled while this is set (not just theirs), matching the server's one-outstanding-invite rule. */
  sendingDuelTo: string | null = null;
  /** Invite currently shown as an accept/decline banner at the top of the friends list. expiresAt is a
   *  local-display-only countdown (authoritative timeout lives server-side, see applyDuelCancelled). */
  incomingDuelInvite: { inviteId: string; fromPublicId: string; fromName: string; expiresAt: number } | null = null;

  // Mail tab.
  mail: MailView[] = [];
  mailUnread = 0;
  openMailItem: MailView | null = null;

  // Search sub-view state.
  searchDigits: string[] = [];
  searchResult: ProfileView | null = null;
  searchMsgKey: TranslationKey | null = null;

  // ── SLG status ───────────────────────────────────────────────────────────────
  slgStatus: SLGSocialStatus | null = null;
  slgLoading = false;
  slgLoaded = false;

  // Family tab subview
  familySubview: 'info' | 'create' | 'joinById' = 'info';
  familyCreateName = '';
  familyCreateTag = '';
  familyActiveInput: 'name' | 'tag' | 'search' | null = null;
  // Join-by-search: default view (query='') shows top-prosperity families with an open slot;
  // typing a name fuzzy-filters the same list server-side.
  familyBrowseQuery = '';
  familyBrowseResults: FamilyView[] = [];
  familyBrowseLoading = false;
  familyBrowseLoaded = false;
  // Family info popup — opened by tapping a browse-result row (join button on the row itself
  // joins directly without going through this).
  familyDetailView: FamilyDetailView | null = null;
  familyDetailLoading = false;
  // Set once a join request is known to be outstanding (fresh success, or the server told us
  // ALREADY_REQUESTED on a retry) — only one pending request per account, so this disables every
  // Join button in the browse list/detail popup rather than tracking it per-family.
  familyJoinPending = false;

  // Sect tab subview
  sectSubview: 'info' | 'create' | 'joinById' = 'info';
  sectCreateName = '';
  sectCreateTag = '';
  sectJoinId = '';
  sectActiveInput: 'name' | 'tag' | 'id' | null = null;

  // World channel tab
  worldMessages: WorldChatMessage[] = [];
  worldLoaded = false;
  worldLoading = false;
  worldLoadError = false;
  worldChatInput = '';
  worldChatActive = false;
  worldSending = false;
  /** Pin the world channel to the latest message; cleared once the user scrolls up to read history,
   *  re-armed when they drag back to the bottom, re-enter the tab, or post (see drawWorldTab). */
  worldStick = true;

  // Shared HTML input (family/sect forms + world channel input box)
  hiddenInput: HTMLInputElement | null = null;
  /** Blink state for whichever field openHiddenInput last opened — shared across all callers. */
  caretOn = true;
  caretTimer = 0;
  /** Drives the incoming-duel-invite banner's once-a-second countdown re-render (see update()). */
  duelBannerTimer = 0;

  scrollY = 0;
  maxScroll = 0;
  regionTop = 0;
  regionBottom = 0;
  /** Set by onPointerMove during a drag, drained (render() called) once per frame in update()
   *  instead of rendering inline — see scroll-drag-throttle-pattern memory. */
  scrollDirty = false;
  pointerActive = false;
  dragging = false;
  downX = 0;
  downY = 0;
  dragStartScroll = 0;

  hits: Hit[] = [];
  readonly unsubs: Array<() => void> = [];
  readonly popup: ProfilePopup;
  dead = false;

  /**
   * Wired by the outer assembly right after NetworkPanel is constructed (Core is constructed first,
   * so a direct reference isn't available yet) — see the file-header comment. switchTab/
   * triggerTabLoads/the apply* inbound-push handlers below all go through this instead of calling
   * refresh()/loadSLGStatus()/loadWorldMessages() directly.
   */
  net: NetworkHandlers = NOOP_NETWORK;

  // ── Confirm modal (remove-friend, S6-1b) ──────────────────────────────────
  modalLayer!: PIXI.Container;
  modalHits: ModalHit[] = [];
  modalOpen = false;

  /** @param render Injected by the outer FriendsScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about all five tab-domain classes) — Core
   *  calls `this.render()` wherever the old flattened class called its own `render()` method
   *  verbatim. Does NOT auto-fire the initial render()/refresh()/triggerTabLoads — the outer
   *  assembly does that after all domain instances (incl. NetworkPanel, wired into `net` above)
   *  exist. */
  constructor(layout: ILayout, input: InputManager, cb: FriendsSceneCallbacks, readonly render: () => void) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    if (cb.defaultTab) this.tab = cb.defaultTab;
    this.popup = new ProfilePopup(this.w, this.h, (publicId) => cb.getProfileExtra(publicId));
    // Persistent singleton, added once and reused across renders — render()/tearDownChildren()
    // never touch it (mirrors FamilyScene/base.ts's modalLayer treatment).
    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));
    this.unsubs.push(input.onWheel((x, y, deltaY) => this.onWheel(y, deltaY)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.familyActiveInput || this.sectActiveInput || this.worldChatActive) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
    if (this.incomingDuelInvite) {
      // Local-only countdown display; if it runs out before the server's own duel_cancelled/match_found
      // arrives, just hide the banner — the authoritative outcome (declined/timeout) always resolves
      // server-side regardless of what this client shows in the meantime.
      if (serverNow() >= this.incomingDuelInvite.expiresAt) {
        this.incomingDuelInvite = null;
        this.render();
      } else {
        this.duelBannerTimer += dt;
        if (this.duelBannerTimer >= 1) { this.duelBannerTimer = 0; this.render(); }
      }
    }
  }

  destroy(): void {
    this.dead = true;
    this.clearHiddenInput();
    this.unsubs.forEach((u) => u());
    this.popup.destroy();
    this.container.destroy({ children: true });
  }

  // ── Inbound pushes ────────────────────────────────────────────────────────────

  applyFriendPresence(p: FriendPresence): void {
    const f = this.friends.find((x) => x.publicId === p.publicId);
    if (f) { f.online = p.online; this.render(); }
  }

  applyFriendRequest(_r: FriendRequestPush): void { void this.net.refresh(); }
  applyFriendUpdate(_u: FriendUpdate): void { void this.net.refresh(); }
  applyChatMessage(_m: ChatMessagePush): void { void this.net.refresh(); }
  applyMailNew(_m: MailNew): void { void this.net.refresh(); }

  applyDuelInvited(d: DuelInvited): void {
    this.incomingDuelInvite = { inviteId: d.inviteId, fromPublicId: d.fromPublicId, fromName: d.fromName, expiresAt: serverNow() + 60_000 };
    this.render();
  }

  /** Only ever about MY own outstanding sent invite (accept never reaches here — see DuelInvited doc;
   *  matchsvc allows exactly one at a time, so there's nothing to disambiguate by inviteId here). */
  applyDuelCancelled(d: DuelCancelled): void {
    this.sendingDuelTo = null;
    const key: TranslationKey =
      d.reason === 'declined' ? 'friends.duel.declined'
      : d.reason === 'timeout' ? 'friends.duel.timeout'
      : d.reason === 'offline' ? 'friends.duel.offline'
      // matchsvc restart-safety (matchsvc-prematch-persist, 2026-07-29): synthesized locally by
      // NetSession from a prematch_lost push when this outstanding invite couldn't be recovered.
      : d.reason === 'lost' ? 'friends.duel.lost'
      // gateway per-connection rate limit (2026-07-29): TIGHT-tier duel_invite throttled server-side.
      // Was previously falling into the 'notFound' default below, which reads as an outright wrong
      // "player not found" message rather than a rate-limit notice.
      : d.reason === 'rate_limited' ? 'friends.duel.rateLimited'
      : 'friends.duel.notFound';
    this.toast(key);
    this.render();
  }

  rowVisible(yTop: number, rowH: number): boolean {
    return yTop + rowH >= this.regionTop && yTop <= this.regionBottom;
  }

  /** Unread 1:1 chat messages from a given friend (0 if no conversation / all read). */
  unreadChatFor(publicId: string): number {
    const c = this.conversations.find((x) => x.peer.publicId === publicId);
    return c && c.unread > 0 ? c.unread : 0;
  }

  /** Total unread chat across all conversations — feeds the Friends rail-tab dot so the
   *  bottom-nav Social badge (which includes unread chat) is explained once Social opens. */
  get totalUnreadChat(): number {
    return this.conversations.reduce((s, c) => s + (c.unread > 0 ? c.unread : 0), 0);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onPointerDown(x: number, y: number): void {
    if (this.popup.isOpen || this.modalOpen) return;
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x;
    this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  onPointerMove(x: number, y: number): void {
    if (!this.pointerActive || this.popup.isOpen) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > DRAG_THRESHOLD) {
      this.dragging = true;
    }
    if (this.dragging && this.maxScroll > 0) {
      const next = clamp(this.dragStartScroll + (this.downY - y), 0, this.maxScroll);
      if (next !== this.scrollY) {
        this.scrollY = next;
        // World channel: dragging back to the bottom re-pins to the latest; scrolling up releases the
        // pin so a re-fetch (e.g. after posting) doesn't yank the reader down. Other tabs ignore it.
        if (this.tab === 'world') this.worldStick = next >= this.maxScroll - 1;
        this.scrollDirty = true;
      }
    }
  }

  onPointerUp(x: number, y: number): void {
    // onPointerDown returns before setting pointerActive while the popup/modal is open, so this must
    // be checked before the pointerActive guard below — otherwise a popup/modal tap-up short-circuits
    // with "no gesture in progress" and never reaches its own hit-test.
    if (this.popup.isOpen) { this.popup.handleTap(x, y); return; }
    if (this.modalOpen) {
      // Reverse order: the full-screen dim rect is pushed first, so checking in push order would
      // let it win over the OK/Cancel buttons drawn on top of it (see FamilyScene/base.ts precedent).
      for (let i = this.modalHits.length - 1; i >= 0; i--) {
        const { rect, action } = this.modalHits[i]!;
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { action(); return; }
      }
      return;
    }
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (hit.scroll && (y < this.regionTop || y > this.regionBottom)) continue;
        hit.fn();
        return;
      }
    }
  }

  onWheel(y: number, deltaY: number): void {
    if (this.popup.isOpen || this.modalOpen) return;
    const next = wheelScrollY(this.regionTop, this.regionBottom, y, deltaY, this.scrollY, this.maxScroll);
    if (next === null) return;
    this.scrollY = next;
    // World channel: scrolling up releases the "stick to latest" pin, same as drag — see onPointerMove.
    if (this.tab === 'world') this.worldStick = next >= this.maxScroll - 1;
    this.scrollDirty = true;
  }

  onBack(): void {
    if (this.openMailItem) { this.openMailItem = null; this.render(); return; }
    if (this.familyDetailView) { this.familyDetailView = null; this.render(); return; }
    if (this.view === 'search') { this.view = 'list'; this.render(); return; }
    this.cb.onBack();
  }

  switchTab(tab: Tab): void {
    if (this.tab === tab) {
      // Re-tapping the active tab backs out of a drilled-in detail view (e.g. an open
      // mail) back to that tab's list, instead of doing nothing.
      if (this.openMailItem) { this.openMailItem = null; this.render(); }
      return;
    }
    this.tab = tab;
    this.view = 'list';
    this.openMailItem = null;
    this.scrollY = 0;
    this.worldStick = true; // (re-)entering the world tab opens at the latest message
    this.clearHiddenInput();
    this.familySubview = 'info';
    this.sectSubview = 'info';
    this.render();
    void this.net.refresh();
    this.triggerTabLoads(tab);
  }

  /** Kicks off whichever background loads a given tab needs, shared by the constructor's
   * defaultTab entry path and switchTab() so neither can drift out of sync with the other.
   * Family/sect status is unrelated to world chat (worldId resolution for chat happens
   * transparently inside loadWorldChat/sendWorldChat) — only fetch it for those two tabs. */
  triggerTabLoads(tab: Tab): void {
    if ((tab === 'family' || tab === 'sect') && !this.slgLoaded && !this.slgLoading) {
      void this.net.loadSLGStatus();
    }
    if (tab === 'world' && !this.worldLoaded && !this.worldLoading) {
      void this.net.loadWorldMessages();
    }
  }

  // Body starts right under the header now that the tab bar is a vertical rail in
  // the left margin (no horizontal tab band to reserve below the header).
  get bodyTop(): number {
    return Math.round(this.h * 0.12);
  }

  // ── Left navigation rail + content column geometry ─────────────────────────────
  // Landscape: the 5 tabs live in a sidebar-nav rail LEFT of the red binding line (sidebarNavW,
  // matching every other left-edge tab rail in the game); all body content sits in the column to
  // its right. Portrait draws the 5 tabs as a bottom nav bar instead (§18), so the content column
  // no longer reserves any width for a rail — `railW` is 0 there and `cX`/`cW` fall back to a flat
  // margin. Every drawer routes its x math through cX/cW/cCX so this stays a single edit point.
  /** Width of the vertical tab rail (0 in portrait — see above). */
  get railW(): number {
    return this.landscape ? sidebarNavW(this.w, this.h, true) : 0;
  }
  /** Left edge of the content column (just right of the binding line, or a flat margin in portrait). */
  get cX(): number {
    return this.railW + Math.round(this.w * 0.02);
  }
  /** Width of the content column. */
  get cW(): number {
    return this.w - this.cX - Math.round(this.w * 0.03);
  }
  /** Horizontal center of the content column (replaces w/2 for centered content). */
  get cCX(): number {
    return this.cX + this.cW / 2;
  }
  /**
   * Bottom edge for scrollable/pinned-to-bottom content. Portrait's tab bar is always shown at the
   * screen bottom (drawTabBar has no orientation gate), so content there stops `bottomNavH` short of
   * `h` instead of running to the edge; landscape's rail doesn't occupy this space so no reservation
   * is needed. Used in place of the old `h - Math.round(h * 0.02)` wherever content sits below the
   * tab bar — the standalone search subview (search.ts) hides the tab bar entirely and keeps the
   * plain `h`-relative math instead.
   */
  get bodyBottom(): number {
    return this.h - Math.round(this.h * 0.02) - (this.landscape ? 0 : bottomNavH(this.h));
  }

  toast(key: TranslationKey, kind: ToastKind = 'error'): void {
    showToastMessage(t(key), kind);
  }

  // ── HTML hidden input helpers ────────────────────────────────────────────────
  // (openHiddenInput itself moved to chrome.ts — see the file-header comment)

  clearHiddenInput(): void {
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.familyActiveInput = null;
    this.sectActiveInput = null;
    this.worldChatActive = false;
  }

  // ── Confirm modal (remove-friend) ─────────────────────────────────────────

  showConfirm(msg: string, onOk: () => void): void {
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(this.modalLayer, this.w, this.h, msg, onOk, () => this.closeModal());
  }

  closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rankLabel(rank: string): string {
  return t(('rank.' + rank.replace(/^rank\./, '')) as TranslationKey);
}
