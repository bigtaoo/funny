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
import { buildIcon } from '../../render/icons';
import { buildDecorCLayer } from '../../render/decorCLayer';
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
import type { WorldChatMessage } from '../../net/WorldApiClient';

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
  createSect?(name: string, tag: string): Promise<void>;
  joinSect?(sectId: string): Promise<void>;
  openFamilyHub?(): void;
  openSectHub?(): void;
  loadWorldChat?(before?: number): Promise<WorldChatMessage[]>;
  sendWorldChat?(body: string, senderName: string): Promise<void>;
  playerName?(): string;
  /** Current coin balance — shown top-right on the world channel tab (each post costs coins). */
  getCoins?(): number;
  /** Pre-select a tab on open — used by the lobby mail shortcut to jump straight to the mail tab. */
  defaultTab?: 'friends' | 'mail';
}

export type Tab = 'friends' | 'family' | 'sect' | 'world' | 'mail';
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
  protected familyJoinId = '';
  protected familyActiveInput: 'name' | 'tag' | 'id' | null = null;

  // Sect tab subview
  protected sectSubview: 'info' | 'create' | 'joinById' = 'info';
  protected sectCreateName = '';
  protected sectCreateTag = '';
  protected sectJoinId = '';
  protected sectActiveInput: 'name' | 'tag' | 'id' | null = null;

  // World channel tab
  protected worldMessages: WorldChatMessage[] = [];
  protected worldLoaded = false;
  protected worldChatInput = '';
  protected worldChatActive = false;
  protected worldSending = false;

  // Shared HTML input (family/sect forms + world channel input box)
  protected hiddenInput: HTMLInputElement | null = null;
  /** Blink state for whichever field openHiddenInput last opened — shared across all callers. */
  protected caretOn = true;
  protected caretTimer = 0;

  protected toastKey: TranslationKey | null = null;
  protected toastT = 0;

  protected scrollY = 0;
  protected maxScroll = 0;
  protected regionTop = 0;
  protected regionBottom = 0;
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
    this.cb = cb;
    if (cb.defaultTab) this.tab = cb.defaultTab;
    this.popup = new ProfilePopup(this.w, this.h);

    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));

    this.render();
    void this.refresh();
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.toastKey) {
      this.toastT -= dt;
      if (this.toastT <= 0) { this.toastKey = null; this.render(); }
    }
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
      if (next !== this.scrollY) { this.scrollY = next; this.render(); }
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
    if ((tab === 'family' || tab === 'sect' || tab === 'world') && !this.slgLoaded && !this.slgLoading) {
      void this.loadSLGStatus();
    }
    if (tab === 'world' && !this.worldLoaded) {
      void this.loadWorldMessages();
    }
  }

  protected get bodyTop(): number {
    return Math.round(this.h * 0.12) + Math.round(this.h * 0.07);
  }

  protected toast(key: TranslationKey): void {
    this.toastKey = key;
    this.toastT = 2.5;
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
    onInput(v: string): void;
    onBlur?(): void;
    onEnter?(): void;
  }): void {
    this.clearHiddenInput();
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

    this.container.addChild(buildPaperBackground('friendsbg', this.w, this.h));
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

    this.drawToast();
    this.container.addChild(this.popup.container);
  }

  // ── Tab bar (5 tabs) ──────────────────────────────────────────────────────────

  protected drawTabBar(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const barH = Math.round(h * 0.07);
    const tabs: { id: Tab; key: TranslationKey; badge: number }[] = [
      { id: 'friends', key: 'friends.tab.friends', badge: this.incoming.length },
      { id: 'family',  key: 'friends.tab.family',  badge: 0 },
      { id: 'sect',    key: 'friends.tab.sect',     badge: 0 },
      { id: 'world',   key: 'friends.tab.world',    badge: 0 },
      { id: 'mail',    key: 'friends.tab.mail',     badge: this.mailUnread },
    ];
    const tw = Math.round(w / tabs.length);
    const fontSize = Math.round(barH * 0.36);
    tabs.forEach((tabDef, i) => {
      const tx = i * tw;
      const active = this.tab === tabDef.id;
      const bg = new PIXI.Graphics();
      bg.beginFill(active ? C.paper : C.dark, active ? 1 : 0.12);
      bg.drawRect(tx, tbH, tw, barH);
      bg.endFill();
      this.container.addChild(bg);
      if (active) {
        const underline = new PIXI.Graphics();
        underline.beginFill(C.accent);
        underline.drawRect(tx + tw * 0.18, tbH + barH - 3, tw * 0.64, 3);
        underline.endFill();
        this.container.addChild(underline);
      }
      const label = txt(t(tabDef.key), fontSize, active ? C.dark : C.mid, active);
      label.anchor.set(0.5, 0.5); label.x = tx + tw / 2; label.y = tbH + barH / 2;
      this.container.addChild(label);
      if (tabDef.badge > 0) {
        const dot = new PIXI.Graphics();
        dot.beginFill(C.red);
        dot.drawCircle(tx + tw / 2 + label.width / 2 + Math.round(barH * 0.18), tbH + barH / 2 - Math.round(barH * 0.18), Math.round(barH * 0.14));
        dot.endFill();
        this.container.addChild(dot);
      }
      this.hits.push({ rect: { x: tx, y: tbH, w: tw, h: barH }, fn: () => this.switchTab(tabDef.id) });
    });
  }

  protected drawHeader(): void {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('friends.title'), { titleSize: Math.round(h * 0.04) });
    this.hits.push({ rect: hdr.backRect, fn: () => this.onBack() });
    // World channel posts cost coins — show the current balance top-right while on that tab.
    if (this.tab === 'world' && this.cb.getCoins) drawHeaderCurrency(this.container, w, hdr.headerH, this.cb.getCoins());
  }

  // ── Toast & shared helpers ─────────────────────────────────────────────────────

  protected drawToast(): void {
    if (!this.toastKey) return;
    const { w, h } = this;
    const label = txt(t(this.toastKey), Math.round(h * 0.026), 0xffffff, true);
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.018);
    const bw = label.width + padX * 2;
    const bh = label.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.135);
    const bg = sketchPanel(bw, bh, { fill: C.dark, fillAlpha: 0.92, border: C.gold, width: 2, seed: seedFor(bw, bh, 1) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = by + bh / 2;
    this.container.addChild(label);
  }

  /** Center label (fixed position, not in the scroll layer). */
  protected centerLabelFixed(text: string): void {
    const regionH = this.regionBottom - this.regionTop;
    const lbl = txt(text, Math.round(this.h * 0.026), C.mid);
    lbl.anchor.set(0.5, 0.5); lbl.x = this.w / 2; lbl.y = this.regionTop + regionH / 2;
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
    const l = txt(t(key), Math.round(this.h * 0.026), C.mid);
    l.anchor.set(0.5, 0.5); l.x = this.w / 2; l.y = this.regionTop + regionH / 2;
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
      const tl = txt(label, fontSize ?? Math.round(h * 0.36), textColor, true);
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
  doJoinFamily(): Promise<void>;
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
