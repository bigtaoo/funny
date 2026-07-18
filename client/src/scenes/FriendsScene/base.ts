// Shared foundation for the FriendsScene mixin chain (see ../FriendsScene.ts assembly).
// FriendsSceneBase holds every instance field (all `protected`, so panel/network mixin method bodies keep
// referencing them verbatim: this.friends, this.slgStatus, …) + the cross-cutting chrome/render dispatcher,
// input/drag, hidden-input helpers, toast, inbound-push handlers, onBack, and the shared render primitives
// (drawToast/centerLabelFixed/scrollRegion/centerLabel/addButton). Each panel/network domain lives in its
// own sibling file as an `XMixin(Base)` and is chained together into the final FriendsScene.
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import { ProfilePopup } from '../../render/ProfilePopup';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage, type ToastKind } from '../../net/log';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSocialTabRail, type SocialTab } from '../../render/socialTabRail';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { drawSceneHeader, drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
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
} from '../../net/proto/transport';
import type { WorldChatMessage, FamilyView, FamilyDetailView } from '../../net/WorldApiClient';

// ── FriendsScene (S6-1/S6-2/S6-3/S6-4) — Social Hub ─────────────────────────
//
// Five tabs: Friends / Family / Sect / World / Mail
// Family / Sect / World tabs require SLG world context (loadSLGStatus optional callback).
// World channel posts cost 50 coins each (deducted server-side).
// Direct chat (1:1) entry point stays in the friend profile popup → send message; Tab bar no longer lists it separately.

export interface SLGSocialStatus {
  worldId: string;
  familyId?: string;
  familyName?: string;
  familyTag?: string;
  sectId?: string;
  sectName?: string;
  /** Whether the current player is the family leader (only leaders can create sects). */
  isLeader: boolean;
  /** Open join requests awaiting this player's (leader/elder) review — drives the Family tab badge. */
  pendingJoinRequests?: number;
}

export interface FriendsSceneCallbacks {
  onBack(): void;
  onOpenRoom(): void;
  loadFriends(): Promise<FriendView[]>;
  loadRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>;
  search(publicId: string): Promise<ProfileView>;
  addFriend(publicId: string): Promise<void>;
  respond(requestId: string, accept: boolean): Promise<void>;
  removeFriend(publicId: string): Promise<void>;
  blockUser(publicId: string): Promise<void>;
  // Direct chat entry point (triggered from friend profile popup, Tab bar no longer lists it separately)
  loadConversations?(): Promise<ConversationView[]>;
  openChat(peerPublicId: string, peerName: string): void;
  // Mail
  loadMail(): Promise<{ mail: MailView[]; unread: number }>;
  markMailRead(mailId: string): Promise<void>;
  claimMail(mailId: string): Promise<boolean>;
  deleteMail(mailId: string): Promise<void>;
  // SLG social tabs (optional)
  loadSLGStatus?(): Promise<SLGSocialStatus | null>;
  createFamily?(name: string, tag: string): Promise<void>;
  joinFamily?(familyId: string): Promise<void>;
  /** Top-prosperity families with an open slot, or fuzzy-matched by name when `query` is non-empty. */
  browseFamilies?(query?: string): Promise<FamilyView[]>;
  /** Full detail (incl. member roster) for a family being browsed, e.g. to preview it before joining. */
  viewFamily?(familyId: string): Promise<FamilyDetailView>;
  createSect?(name: string, tag: string): Promise<void>;
  joinSect?(sectId: string): Promise<void>;
  openFamilyHub?(): void;
  openSectHub?(): void;
  loadWorldChat?(before?: number): Promise<WorldChatMessage[]>;
  sendWorldChat?(body: string, senderName: string): Promise<void>;
  playerName?(): string;
  /** Current coin balance — shown top-right on the world channel tab (each post costs coins). */
  getCoins?(): number;
  /**
   * Re-sync the authoritative wallet after a server-side coin spend (world-chat post).
   * World-chat coins are debited in the commercial service by worldsvc, which never touches
   * the metaserver save mirror the HUD reads — so without this the balance looks unchanged
   * ("post didn't cost anything"). Calling this re-fetches the save (GET /save re-mirrors the
   * live commercial balance) so getCoins() reflects the deduction.
   */
  refreshWallet?(): Promise<void>;
  /** Pre-select a tab on open — used by the lobby mail shortcut (mail) and the world-map chat bar (world). */
  defaultTab?: Tab;
}

export type Tab = SocialTab;
export type View = 'list' | 'search';

export interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

const DRAG_THRESHOLD = 8;

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type FriendsSceneBaseCtor = Constructor<FriendsSceneBase>;

export class FriendsSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: FriendsSceneCallbacks;

  protected tab: Tab = 'friends';
  protected view: View = 'list';
  protected loading = true;
  protected friends: FriendView[] = [];
  protected incoming: FriendRequestView[] = [];

  // Mail tab.
  protected mail: MailView[] = [];
  protected mailUnread = 0;
  protected openMailItem: MailView | null = null;

  // Search sub-view state.
  protected searchDigits: string[] = [];
  protected searchResult: ProfileView | null = null;
  protected searchMsgKey: TranslationKey | null = null;

  // ── SLG status ───────────────────────────────────────────────────────────────
  protected slgStatus: SLGSocialStatus | null = null;
  protected slgLoading = false;
  protected slgLoaded = false;

  // Family tab subview
  protected familySubview: 'info' | 'create' | 'joinById' = 'info';
  protected familyCreateName = '';
  protected familyCreateTag = '';
  protected familyActiveInput: 'name' | 'tag' | 'search' | null = null;
  // Join-by-search: default view (query='') shows top-prosperity families with an open slot;
  // typing a name fuzzy-filters the same list server-side.
  protected familyBrowseQuery = '';
  protected familyBrowseResults: FamilyView[] = [];
  protected familyBrowseLoading = false;
  protected familyBrowseLoaded = false;
  // Family info popup — opened by tapping a browse-result row (join button on the row itself
  // joins directly without going through this).
  protected familyDetailView: FamilyDetailView | null = null;
  protected familyDetailLoading = false;

  // Sect tab subview
  protected sectSubview: 'info' | 'create' | 'joinById' = 'info';
  protected sectCreateName = '';
  protected sectCreateTag = '';
  protected sectJoinId = '';
  protected sectActiveInput: 'name' | 'tag' | 'id' | null = null;

  // World channel tab
  protected worldMessages: WorldChatMessage[] = [];
  protected worldLoaded = false;
  protected worldLoading = false;
  protected worldLoadError = false;
  protected worldChatInput = '';
  protected worldChatActive = false;
  protected worldSending = false;

  // Shared HTML input (family/sect forms + world channel input box)
  protected hiddenInput: HTMLInputElement | null = null;
  /** Blink state for whichever field openHiddenInput last opened — shared across all callers. */
  protected caretOn = true;
  protected caretTimer = 0;


  protected scrollY = 0;
  protected maxScroll = 0;
  protected regionTop = 0;
  protected regionBottom = 0;
  /** Set by onPointerMove during a drag, drained (render() called) once per frame in update()
   *  instead of rendering inline — see scroll-drag-throttle-pattern memory. */
  protected scrollDirty = false;
  protected pointerActive = false;
  protected dragging = false;
  protected downX = 0;
  protected downY = 0;
  protected dragStartScroll = 0;

  protected hits: Hit[] = [];
  protected readonly unsubs: Array<() => void> = [];
  protected readonly popup: ProfilePopup;
  protected dead = false;

  constructor(layout: ILayout, input: InputManager, cb: FriendsSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    if (cb.defaultTab) this.tab = cb.defaultTab;
    this.popup = new ProfilePopup(this.w, this.h);

    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));

    this.render();
    void this.refresh();
    this.triggerTabLoads(this.tab);
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.familyActiveInput || this.sectActiveInput || this.worldChatActive) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
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

  applyFriendRequest(_r: FriendRequestPush): void { void this.refresh(); }
  applyFriendUpdate(_u: FriendUpdate): void { void this.refresh(); }
  applyChatMessage(_m: ChatMessagePush): void { void this.refresh(); }
  applyMailNew(_m: MailNew): void { void this.refresh(); }

  protected rowVisible(yTop: number, rowH: number): boolean {
    return yTop + rowH >= this.regionTop && yTop <= this.regionBottom;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  protected onPointerDown(x: number, y: number): void {
    if (this.popup.isOpen) return;
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x;
    this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  protected onPointerMove(x: number, y: number): void {
    if (!this.pointerActive || this.popup.isOpen) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > DRAG_THRESHOLD) {
      this.dragging = true;
    }
    if (this.dragging && this.maxScroll > 0) {
      const next = clamp(this.dragStartScroll + (this.downY - y), 0, this.maxScroll);
      if (next !== this.scrollY) { this.scrollY = next; this.scrollDirty = true; }
    }
  }

  protected onPointerUp(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging || this.popup.isOpen) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (hit.scroll && (y < this.regionTop || y > this.regionBottom)) continue;
        hit.fn();
        return;
      }
    }
  }

  protected onBack(): void {
    if (this.openMailItem) { this.openMailItem = null; this.render(); return; }
    if (this.familyDetailView) { this.familyDetailView = null; this.render(); return; }
    if (this.view === 'search') { this.view = 'list'; this.render(); return; }
    this.cb.onBack();
  }

  protected switchTab(tab: Tab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.view = 'list';
    this.openMailItem = null;
    this.scrollY = 0;
    this.clearHiddenInput();
    this.familySubview = 'info';
    this.sectSubview = 'info';
    this.render();
    void this.refresh();
    this.triggerTabLoads(tab);
  }

  /** Kicks off whichever background loads a given tab needs, shared by the constructor's
   * defaultTab entry path and switchTab() so neither can drift out of sync with the other.
   * Family/sect status is unrelated to world chat (worldId resolution for chat happens
   * transparently inside loadWorldChat/sendWorldChat) — only fetch it for those two tabs. */
  protected triggerTabLoads(tab: Tab): void {
    if ((tab === 'family' || tab === 'sect') && !this.slgLoaded && !this.slgLoading) {
      void this.loadSLGStatus();
    }
    if (tab === 'world' && !this.worldLoaded && !this.worldLoading) {
      void this.loadWorldMessages();
    }
  }

  // Body starts right under the header now that the tab bar is a vertical rail in
  // the left margin (no horizontal tab band to reserve below the header).
  protected get bodyTop(): number {
    return Math.round(this.h * 0.12);
  }

  // ── Left navigation rail + content column geometry ─────────────────────────────
  // The 5 tabs live in the sidebar-nav rail LEFT of the red binding line (sidebarNavW, matching
  // every other left-edge tab rail in the game); all body content sits in the column to its
  // right. Every drawer routes its x math through cX/cW/cCX so the tab rail and content never
  // overlap.
  /** Width of the vertical tab rail. */
  protected get railW(): number {
    return sidebarNavW(this.w, this.h, this.landscape);
  }
  /** Left edge of the content column (just right of the binding line). */
  protected get cX(): number {
    return this.railW + Math.round(this.w * 0.02);
  }
  /** Width of the content column. */
  protected get cW(): number {
    return this.w - this.cX - Math.round(this.w * 0.03);
  }
  /** Horizontal center of the content column (replaces w/2 for centered content). */
  protected get cCX(): number {
    return this.cX + this.cW / 2;
  }

  protected toast(key: TranslationKey, kind: ToastKind = 'error'): void {
    showToastMessage(t(key), kind);
  }

  // ── HTML hidden input helpers ────────────────────────────────────────────────

  protected clearHiddenInput(): void {
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.familyActiveInput = null;
    this.sectActiveInput = null;
    this.worldChatActive = false;
  }

  protected openHiddenInput(opts: {
    value: string;
    maxLength: number;
    placeholder?: string;
    /** Optional clamp applied to the raw value before onInput (e.g. display-width cap for org names). */
    clamp?(v: string): string;
    onInput(v: string): void;
    onBlur?(): void;
    onEnter?(): void;
  }): void {
    // Tear down only the previous DOM element — NOT via clearHiddenInput(), which also
    // resets the active-field flags (worldChatActive / family/sectActiveInput). Every
    // caller sets its flag *before* calling openHiddenInput, so calling clearHiddenInput
    // here would wipe the flag we just set → the field never shows its blinking caret
    // (the blink loop in update() and caretDisplay() are both gated on that flag).
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.caretOn = true;
    this.caretTimer = 0;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = opts.value;
    inp.maxLength = opts.maxLength;
    inp.placeholder = opts.placeholder ?? '';
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('input', () => {
      if (opts.clamp) {
        const clamped = opts.clamp(inp.value);
        if (clamped !== inp.value) inp.value = clamped;
      }
      opts.onInput(inp.value);
      if (!this.dead) this.render();
    });
    if (opts.onEnter) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onEnter!(); });
    }
    inp.addEventListener('blur', () => {
      opts.onBlur?.();
      if (inp.parentNode) inp.remove();
      if (this.hiddenInput === inp) this.hiddenInput = null;
      if (!this.dead) this.render();
    });
    this.hiddenInput = inp;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.dead) return;
    // popup.container is a persistent singleton (built once in ctor, reused across
    // renders) — detach it first so tearDownChildren doesn't destroy it. Otherwise
    // the next render re-adds a destroyed container (transform === null) and Pixi
    // throws "can't access property _parentID, e.transform is null".
    this.container.removeChild(this.popup.container);
    tearDownChildren(this.container);
    this.hits = [];
    // Cleared each render; only a scroll panel (friends list / world chat / mail) sets it
    // back > 0, so drawScrollbar() below is a no-op on the non-scrolling tabs.
    this.maxScroll = 0;

    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = this.landscape ? sidebarNavW(this.w, this.h, true) : undefined;
    this.container.addChild(buildPaperBackground('friendsbg', this.w, this.h, { railX }));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
    this.drawHeader();

    if (this.tab === 'friends' && this.view === 'search') {
      this.drawSearch();
    } else if (this.openMailItem) {
      this.drawTabBar();
      this.drawMailDetail(this.openMailItem);
    } else {
      this.drawTabBar();
      if (this.tab === 'friends') this.drawList();
      else if (this.tab === 'family') this.drawFamilyTab();
      else if (this.tab === 'sect') this.drawSectTab();
      else if (this.tab === 'world') this.drawWorldTab();
      else this.drawMailList();
    }

    // drawFamilyTab/drawSectTab can synchronously navigate away (openFamilyHub/
    // openSectHub) once a family/sect already exists, which destroys this scene
    // (incl. popup.container) mid-render — re-adding it below would then throw.
    if (this.dead) return;

    this.drawScrollbar();
    this.container.addChild(this.popup.container);
  }

  /**
   * Shared scroll indicator for whichever panel set a scrollable region this render
   * (friends list / world chat / mail all write regionTop/regionBottom + maxScroll).
   * No-op when maxScroll is 0 (reset at the top of render()).
   */
  protected drawScrollbar(): void {
    drawScrollIndicator(
      this.container,
      { x: 0, y: this.regionTop, w: this.w, h: this.regionBottom - this.regionTop },
      this.scrollY, this.maxScroll,
    );
  }

  // ── Tab rail (5 tabs, vertical, left of the binding line) ──────────────────────

  protected drawTabBar(): void {
    // Sect tab is only useful to a family leader (who can found/join one) or someone whose
    // family already belongs to a sect (who can view it) — everyone else hits a dead end, so
    // hide the tab rather than show a page that can only ever say "you can't do anything here".
    const s = this.slgStatus;
    const hidden: SocialTab[] = s && !s.isLeader && !s.sectId ? ['sect'] : [];
    const hits = drawSocialTabRail(
      this.container, this.w, this.h, this.bodyTop, this.landscape, this.tab,
      { friends: this.incoming.length, mail: this.mailUnread, family: this.slgStatus?.pendingJoinRequests ?? 0 },
      (tab) => this.switchTab(tab),
      hidden,
    );
    this.hits.push(...hits);
  }

  protected drawHeader(): void {
    const { w, h } = this;
    const titleKey = `friends.tab.${this.tab}` as TranslationKey;
    const hdr = drawSceneHeader(this.container, w, h, t(titleKey), { variant: 'paper' });
    this.hits.push({ rect: hdr.backRect, fn: () => this.onBack() });
    // World channel posts cost coins — show the current balance top-right while on that tab.
    if (this.tab === 'world' && this.cb.getCoins) drawHeaderCurrency(this.container, w, hdr.headerH, this.cb.getCoins());
  }

  // ── Toast & shared helpers ─────────────────────────────────────────────────────


  /** Center label (fixed position, not in the scroll layer). */
  protected centerLabelFixed(text: string): void {
    const regionH = this.regionBottom - this.regionTop;
    const lbl = txt(text, FS.heading, C.mid);
    lbl.anchor.set(0.5, 0.5); lbl.x = this.cCX; lbl.y = this.regionTop + regionH / 2;
    this.container.addChild(lbl);
  }

  protected scrollRegion(regionH: number): { layer: PIXI.Container } {
    const { w } = this;
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff); clip.drawRect(0, this.regionTop, w, regionH); clip.endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);
    return { layer };
  }

  protected centerLabel(layer: PIXI.Container, key: TranslationKey, regionH: number): void {
    const l = txt(t(key), FS.heading, C.mid);
    l.anchor.set(0.5, 0.5); l.x = this.cCX; l.y = this.regionTop + regionH / 2;
    layer.addChild(l);
  }

  protected addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void,
    textColor = 0xffffff, fontSize?: number, layer?: PIXI.Container,
  ): void {
    const target = layer ?? this.container;
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x; g.y = y;
    target.addChild(g);

    if (label === '✕') {
      // Hand-drawn close glyph instead of the bare dingbat.
      const sz = Math.round(Math.min(w, h) * 0.5);
      const ic = buildIcon('close', sz, textColor);
      ic.x = x + (w - sz) / 2; ic.y = y + (h - sz) / 2;
      target.addChild(ic);
    } else {
      const tl = txt(label, fontSize ?? snapFont(Math.round(h * 0.36)), textColor, true);
      tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
      target.addChild(tl);
    }

    this.hits.push({ rect: { x, y, w, h }, scroll: !!layer, fn });
  }
}

// ── Panel/network entrypoints dispatched to from base-level code (render/switchTab/constructor/apply*),
// plus cross-mixin calls (panel mixins invoke the search entry + network action methods that live in sibling
// mixins, invisible to each other and to the base). Declared via interface/class declaration merging so
// base-level `this.drawX()` / `this.refresh()` / `this.doX()` type-check as METHODS (not properties, which
// would clash with the mixin's method override — TS2425). Emits NOTHING at runtime, so the real prototype
// methods provided by the mixins run and all method bodies stay verbatim.
export interface FriendsSceneBase {
  drawList(): void;
  drawSearch(): void;
  drawFamilyTab(): void;
  drawFamilyDetail(fam: FamilyDetailView): void;
  drawSectTab(): void;
  drawWorldTab(): void;
  drawMailList(): void;
  drawMailDetail(m: MailView): void;
  refresh(): Promise<void>;
  loadSLGStatus(): Promise<void>;
  loadWorldMessages(): Promise<void>;
  openSearch(): void;
  doSearch(): Promise<void>;
  doAdd(publicId: string): Promise<void>;
  doRespond(requestId: string, accept: boolean): Promise<void>;
  doRemove(publicId: string): Promise<void>;
  doBlock(publicId: string): Promise<void>;
  doCreateFamily(): Promise<void>;
  loadFamilyBrowse(query: string): Promise<void>;
  doJoinFamily(familyId: string): Promise<void>;
  doCreateSect(): Promise<void>;
  doJoinSect(): Promise<void>;
  doSendWorldChat(): Promise<void>;
  doClaim(m: MailView): Promise<void>;
  doMailDelete(m: MailView): Promise<void>;
}

// ── helpers ────────────────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rankLabel(rank: string): string {
  return t(('rank.' + rank.replace(/^rank\./, '')) as TranslationKey);
}
