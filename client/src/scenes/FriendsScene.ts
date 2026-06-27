import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup } from '../render/ProfilePopup';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import type {
  FriendView,
  FriendRequestView,
  ProfileView,
  ConversationView,
  MailView,
  MailAttachmentView,
} from '../net/ApiClient';
import type {
  FriendPresence,
  FriendRequestPush,
  FriendUpdate,
  ChatMessagePush,
  MailNew,
} from '../net/proto/transport';
import type { WorldChatMessage } from '../net/WorldApiClient';

// ── FriendsScene (S6-1/S6-2/S6-3/S6-4) — 社交 Hub ────────────────────────────
//
// 五 Tab：好友 / 家族 / 宗门 / 世界 / 邮件
// 家族 / 宗门 / 世界 Tab 需要 SLG 世界上下文（loadSLGStatus 可选回调）。
// 世界频道每条发言扣 50 金币（server-side 扣）。
// 私聊（1:1）入口保留在好友资料弹层 → 发消息，Tab bar 不再单独列出。

export interface SLGSocialStatus {
  worldId: string;
  familyId?: string;
  familyName?: string;
  familyTag?: string;
  sectId?: string;
  sectName?: string;
  /** 当前玩家是否为家族族长（仅族长可创建宗门）。 */
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
  // 私聊入口（从好友资料弹层触发，Tab bar 不再单列）
  loadConversations?(): Promise<ConversationView[]>;
  openChat(peerPublicId: string, peerName: string): void;
  // 邮件
  loadMail(): Promise<{ mail: MailView[]; unread: number }>;
  markMailRead(mailId: string): Promise<void>;
  claimMail(mailId: string): Promise<boolean>;
  deleteMail(mailId: string): Promise<void>;
  // SLG 社交 Tab（可选）
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
}

type Tab = 'friends' | 'family' | 'sect' | 'world' | 'mail';
type View = 'list' | 'search';

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

const DRAG_THRESHOLD = 8;

export class FriendsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: FriendsSceneCallbacks;

  private tab: Tab = 'friends';
  private view: View = 'list';
  private loading = true;
  private friends: FriendView[] = [];
  private incoming: FriendRequestView[] = [];

  // Mail tab.
  private mail: MailView[] = [];
  private mailUnread = 0;
  private openMailItem: MailView | null = null;

  // Search sub-view state.
  private searchDigits: string[] = [];
  private searchResult: ProfileView | null = null;
  private searchMsgKey: TranslationKey | null = null;

  // ── SLG 状态 ─────────────────────────────────────────────────────────────────
  private slgStatus: SLGSocialStatus | null = null;
  private slgLoading = false;
  private slgLoaded = false;

  // 家族 Tab 子视图
  private familySubview: 'info' | 'create' | 'joinById' = 'info';
  private familyCreateName = '';
  private familyCreateTag = '';
  private familyJoinId = '';
  private familyActiveInput: 'name' | 'tag' | 'id' | null = null;

  // 宗门 Tab 子视图
  private sectSubview: 'info' | 'create' | 'joinById' = 'info';
  private sectCreateName = '';
  private sectCreateTag = '';
  private sectJoinId = '';
  private sectActiveInput: 'name' | 'tag' | 'id' | null = null;

  // 世界频道 Tab
  private worldMessages: WorldChatMessage[] = [];
  private worldLoaded = false;
  private worldChatInput = '';
  private worldChatActive = false;
  private worldSending = false;

  // 共享 HTML input（家族/宗门表单 + 世界频道输入框）
  private hiddenInput: HTMLInputElement | null = null;

  private toastKey: TranslationKey | null = null;
  private toastT = 0;

  private scrollY = 0;
  private maxScroll = 0;
  private regionTop = 0;
  private regionBottom = 0;
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private readonly popup: ProfilePopup;
  private dead = false;

  constructor(layout: ILayout, input: InputManager, cb: FriendsSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
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

  // ── Data ───────────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    try {
      const [friends, requests, mail] = await Promise.all([
        this.cb.loadFriends(),
        this.cb.loadRequests(),
        this.cb.loadMail(),
      ]);
      this.friends = friends;
      this.incoming = requests.incoming;
      this.mail = mail.mail;
      this.mailUnread = mail.unread;
    } catch {
      if (this.loading) this.toast('friends.error');
    } finally {
      this.loading = false;
      if (!this.dead) this.render();
    }
  }

  private async loadSLGStatus(): Promise<void> {
    if (!this.cb.loadSLGStatus || this.slgLoading) return;
    this.slgLoading = true;
    this.render();
    try {
      this.slgStatus = await this.cb.loadSLGStatus();
    } catch {
      this.slgStatus = null;
    } finally {
      this.slgLoading = false;
      this.slgLoaded = true;
      if (!this.dead) this.render();
    }
  }

  private async loadWorldMessages(): Promise<void> {
    if (!this.cb.loadWorldChat) return;
    try {
      const msgs = await this.cb.loadWorldChat();
      this.worldMessages = msgs.slice().reverse(); // server newest-first → oldest-first for display
      this.worldLoaded = true;
    } catch { /* keep existing */ }
    if (!this.dead) this.render();
  }

  private rowVisible(yTop: number, rowH: number): boolean {
    return yTop + rowH >= this.regionTop && yTop <= this.regionBottom;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onPointerDown(x: number, y: number): void {
    if (this.popup.isOpen) return;
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x;
    this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  private onPointerMove(x: number, y: number): void {
    if (!this.pointerActive || this.popup.isOpen) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > DRAG_THRESHOLD) {
      this.dragging = true;
    }
    if (this.dragging && this.maxScroll > 0) {
      const next = clamp(this.dragStartScroll + (this.downY - y), 0, this.maxScroll);
      if (next !== this.scrollY) { this.scrollY = next; this.render(); }
    }
  }

  private onPointerUp(x: number, y: number): void {
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

  // ── Actions ──────────────────────────────────────────────────────────────────

  private openSearch(): void {
    this.view = 'search';
    this.searchDigits = [];
    this.searchResult = null;
    this.searchMsgKey = null;
    this.render();
  }

  private async doSearch(): Promise<void> {
    if (this.searchDigits.length === 0) return;
    const id = this.searchDigits.join('');
    this.searchResult = null;
    this.searchMsgKey = 'friends.searching';
    this.render();
    try {
      this.searchResult = await this.cb.search(id);
      this.searchMsgKey = null;
    } catch {
      this.searchResult = null;
      this.searchMsgKey = 'friends.notFound';
    }
    this.render();
  }

  private async doAdd(publicId: string): Promise<void> {
    try {
      await this.cb.addFriend(publicId);
      this.toast('friends.requestSent');
      this.view = 'list';
      this.render();
      void this.refresh();
    } catch (e) {
      this.toast(addErrorKey(e));
      this.render();
    }
  }

  private async doRespond(requestId: string, accept: boolean): Promise<void> {
    try { await this.cb.respond(requestId, accept); } catch { this.toast('friends.error'); }
    void this.refresh();
  }

  private async doRemove(publicId: string): Promise<void> {
    this.popup.hide();
    try { await this.cb.removeFriend(publicId); this.toast('friends.removed'); } catch { this.toast('friends.error'); }
    void this.refresh();
  }

  private async doBlock(publicId: string): Promise<void> {
    try { await this.cb.blockUser(publicId); this.toast('friends.blockedDone'); } catch { this.toast('friends.error'); }
    void this.refresh();
  }

  private onBack(): void {
    if (this.openMailItem) { this.openMailItem = null; this.render(); return; }
    if (this.view === 'search') { this.view = 'list'; this.render(); return; }
    this.cb.onBack();
  }

  private switchTab(tab: Tab): void {
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

  private get bodyTop(): number {
    return Math.round(this.h * 0.12) + Math.round(this.h * 0.07);
  }

  private toast(key: TranslationKey): void {
    this.toastKey = key;
    this.toastT = 2.5;
  }

  // ── HTML hidden input helpers ────────────────────────────────────────────────

  private clearHiddenInput(): void {
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.familyActiveInput = null;
    this.sectActiveInput = null;
    this.worldChatActive = false;
  }

  private openHiddenInput(opts: {
    value: string;
    maxLength: number;
    placeholder?: string;
    onInput(v: string): void;
    onBlur?(): void;
    onEnter?(): void;
  }): void {
    this.clearHiddenInput();
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

  private render(): void {
    if (this.dead) return;
    this.container.removeChildren();
    this.hits = [];

    this.container.addChild(buildPaperBackground('friendsbg', this.w, this.h));
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

  private drawTabBar(): void {
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

  private drawHeader(): void {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('friends.title'), { titleSize: Math.round(h * 0.04) });
    this.hits.push({ rect: hdr.backRect, fn: () => this.onBack() });
  }

  // ── 好友 Tab ──────────────────────────────────────────────────────────────────

  private drawList(): void {
    const { w, h } = this;
    const aY = this.bodyTop + Math.round(h * 0.01);
    const aH = Math.round(h * 0.075);
    const aGap = Math.round(w * 0.04);
    const aW = Math.round((w * 0.92 - aGap) / 2);
    const aX0 = (w - (2 * aW + aGap)) / 2;
    this.addButton(t('friends.search'), aX0, aY, aW, aH, C.dark, C.accent, () => this.openSearch());
    this.addButton(t('friends.room'), aX0 + aW + aGap, aY, aW, aH, C.dark, C.gold, () => this.cb.onOpenRoom());

    this.regionTop = aY + aH + Math.round(h * 0.02);
    this.regionBottom = h - Math.round(h * 0.02);
    const regionH = this.regionBottom - this.regionTop;

    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff);
    clip.drawRect(0, this.regionTop, w, regionH);
    clip.endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);

    if (this.loading) {
      const l = txt(t('friends.loading'), Math.round(h * 0.03), C.mid);
      l.anchor.set(0.5, 0.5); l.x = w / 2; l.y = this.regionTop + regionH / 2;
      layer.addChild(l);
      this.maxScroll = 0;
      return;
    }

    let cy = 0;
    const rowGap = Math.round(h * 0.014);
    const screenY = (contentY: number) => this.regionTop + contentY - this.scrollY;

    const sectionLabel = (key: TranslationKey, count?: number): void => {
      const label = txt(count !== undefined ? `${t(key)} (${count})` : t(key), Math.round(h * 0.024), C.mid, true);
      label.anchor.set(0, 0.5); label.x = Math.round(w * 0.05); label.y = screenY(cy + Math.round(h * 0.018));
      layer.addChild(label);
      cy += Math.round(h * 0.045);
    };

    if (this.incoming.length > 0) {
      sectionLabel('friends.requests', this.incoming.length);
      const reqH = Math.round(h * 0.09);
      for (const r of this.incoming) {
        const sy = screenY(cy);
        if (this.rowVisible(sy, reqH)) this.drawRequestRow(layer, r, cy, sy);
        cy += reqH + rowGap;
      }
      cy += Math.round(h * 0.01);
    }

    sectionLabel('friends.sectionFriends', this.friends.length);
    if (this.friends.length === 0) {
      const empty = txt(t('friends.empty'), Math.round(h * 0.024), C.mid);
      empty.anchor.set(0.5, 0); empty.x = w / 2; empty.y = screenY(cy + Math.round(h * 0.02));
      layer.addChild(empty);
      cy += Math.round(h * 0.08);
    } else {
      const sorted = [...this.friends].sort(
        (a, b) => (a.online === b.online ? a.displayName.localeCompare(b.displayName) : a.online ? -1 : 1),
      );
      const fH = Math.round(h * 0.10);
      for (const f of sorted) {
        const sy = screenY(cy);
        if (this.rowVisible(sy, fH)) this.drawFriendRow(layer, f, cy, sy);
        cy += fH + rowGap;
      }
    }

    this.maxScroll = Math.max(0, cy - regionH);
    if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
  }

  private drawRequestRow(layer: PIXI.Container, r: FriendRequestView, _contentY: number, y: number): void {
    const { w, h } = this;
    const rh = Math.round(h * 0.09);
    const rx = Math.round(w * 0.04);
    const rw = Math.round(w * 0.92);

    const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(rx, 0, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, C.gold, seedFor(rx, rh, 5));
    layer.addChild(bg);

    const name = txt(r.fromName || t('friends.you'), Math.round(rh * 0.32), C.dark, true);
    name.anchor.set(0, 0.5); name.x = rx + Math.round(rw * 0.06); name.y = y + rh * 0.36;
    layer.addChild(name);
    const id = txt(`#${r.fromPublicId}`, Math.round(rh * 0.22), C.mid);
    id.anchor.set(0, 0.5); id.x = rx + Math.round(rw * 0.06); id.y = y + rh * 0.70;
    layer.addChild(id);

    const bW = Math.round(rw * 0.18);
    const bH = Math.round(rh * 0.5);
    const bY = y + (rh - bH) / 2;
    const rejX = rx + rw - bW - Math.round(rw * 0.03);
    const accX = rejX - bW - Math.round(rw * 0.02);
    this.addButton(t('friends.accept'), accX, bY, bW, bH, C.green, C.green,
      () => void this.doRespond(r.requestId, true), 0xffffff, Math.round(bH * 0.4), layer);
    this.addButton(t('friends.reject'), rejX, bY, bW, bH, C.paper, C.red,
      () => void this.doRespond(r.requestId, false), C.red, Math.round(bH * 0.4), layer);
  }

  private drawFriendRow(layer: PIXI.Container, f: FriendView, _contentY: number, y: number): void {
    const { w, h } = this;
    const rh = Math.round(h * 0.10);
    const rx = Math.round(w * 0.04);
    const rw = Math.round(w * 0.92);
    const accent = f.online ? C.green : C.mid;

    const bg = sketchPanel(rw, rh, { fill: C.paper, border: accent, width: 2, seed: seedFor(rx, 1, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, accent, seedFor(rx, rh, 7));
    layer.addChild(bg);

    const dot = new PIXI.Graphics();
    dot.beginFill(f.online ? C.green : C.btnOff);
    dot.drawCircle(0, 0, Math.round(rh * 0.1));
    dot.endFill();
    dot.x = rx + Math.round(rw * 0.06); dot.y = y + rh / 2;
    layer.addChild(dot);

    const tx = rx + Math.round(rw * 0.12);
    const name = txt(f.alias || f.displayName, Math.round(rh * 0.30), C.dark, true);
    name.anchor.set(0, 0.5); name.x = tx; name.y = y + rh * 0.34;
    layer.addChild(name);

    const statusTxt = t(f.online ? 'friends.online' : 'friends.offline');
    const idRank = `#${f.publicId}${f.rank ? '  ·  ' + rankLabel(f.rank) : ''}  ·  ${statusTxt}`;
    const sub = txt(idRank, Math.round(rh * 0.2), C.mid);
    sub.anchor.set(0, 0.5); sub.x = tx; sub.y = y + rh * 0.68;
    layer.addChild(sub);

    const xW = Math.round(rh * 0.62);
    const xX = rx + rw - xW - Math.round(rw * 0.03);
    const xY = y + (rh - xW) / 2;
    this.addButton('✕', xX, xY, xW, xW, C.paper, C.red,
      () => void this.doRemove(f.publicId), C.red, Math.round(xW * 0.5), layer);

    this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openFriendProfile(f) });
  }

  private openFriendProfile(f: FriendView): void {
    this.popup.show({
      name: f.alias || f.displayName,
      publicId: f.publicId,
      ...(f.rank ? { rankKey: 'rank.' + f.rank } : {}),
      actions: [
        { labelKey: 'friends.message', fn: () => this.cb.openChat(f.publicId, f.alias || f.displayName) },
        { labelKey: 'friends.block', fn: () => void this.doBlock(f.publicId), danger: true },
      ],
    });
  }

  // ── 家族 Tab ──────────────────────────────────────────────────────────────────

  private drawFamilyTab(): void {
    const { w, h } = this;
    this.regionTop = this.bodyTop + Math.round(h * 0.01);
    this.regionBottom = h - Math.round(h * 0.02);

    if (!this.cb.loadSLGStatus) {
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }
    if (!this.slgLoaded) {
      if (!this.slgLoading) void this.loadSLGStatus();
      this.centerLabelFixed(t('friends.loading'));
      return;
    }
    if (!this.slgStatus) {
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }

    const s = this.slgStatus;
    const px = Math.round(w * 0.06);
    const panelW = w - px * 2;
    let cy = this.regionTop + Math.round(h * 0.03);

    if (s.familyId) {
      const ph = Math.round(h * 0.15);
      const bg = sketchPanel(panelW, ph, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(px, cy, panelW) });
      bg.x = px; bg.y = cy;
      sketchAccentBar(bg, ph, C.accent, seedFor(px, ph, 3));
      this.container.addChild(bg);

      const nameLabel = txt(s.familyName ?? s.familyId, Math.round(h * 0.034), C.dark, true);
      nameLabel.anchor.set(0, 0.5); nameLabel.x = px + Math.round(panelW * 0.08); nameLabel.y = cy + ph * 0.38;
      this.container.addChild(nameLabel);
      if (s.familyTag) {
        const tagLabel = txt(`[${s.familyTag}]`, Math.round(h * 0.024), C.mid);
        tagLabel.anchor.set(0, 0.5); tagLabel.x = px + Math.round(panelW * 0.08); tagLabel.y = cy + ph * 0.68;
        this.container.addChild(tagLabel);
      }

      cy += ph + Math.round(h * 0.03);
      const bH = Math.round(h * 0.08);
      this.addButton(t('social.family.enter'), px, cy, panelW, bH, C.dark, C.accent,
        () => this.cb.openFamilyHub?.());
    } else {
      if (this.familySubview === 'info') {
        const lbl = txt(t('social.family.none'), Math.round(h * 0.026), C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = w / 2; lbl.y = cy;
        this.container.addChild(lbl);
        cy += Math.round(h * 0.06);

        const bH = Math.round(h * 0.08);
        const bGap = Math.round(w * 0.04);
        const bW = Math.round((panelW - bGap) / 2);
        this.addButton(t('social.family.create'), px, cy, bW, bH, C.dark, C.accent,
          () => { this.familySubview = 'create'; this.render(); });
        this.addButton(t('social.family.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
          () => { this.familySubview = 'joinById'; this.render(); }, C.dark);
      } else if (this.familySubview === 'create') {
        this.drawFamilyCreateForm(px, panelW, cy);
      } else {
        this.drawFamilyJoinForm(px, panelW, cy);
      }
    }
  }

  private drawFamilyCreateForm(px: number, panelW: number, startY: number): void {
    const { w, h } = this;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const nameLbl = txt(t('social.family.namePlaceholder'), Math.round(h * 0.024), C.mid);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
    this.container.addChild(nameLbl);
    cy += fH + gap;

    const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    nameBg.x = px; nameBg.y = cy;
    this.container.addChild(nameBg);
    const nameVal = txt(this.familyCreateName || ' ', Math.round(fH * 0.4), C.dark);
    nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
    this.container.addChild(nameVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.familyActiveInput = 'name';
      this.openHiddenInput({
        value: this.familyCreateName, maxLength: 24,
        onInput: (v) => { this.familyCreateName = v; },
        onBlur: () => { this.familyActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + gap;

    const tagLbl = txt(t('social.family.tagPlaceholder'), Math.round(h * 0.024), C.mid);
    tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
    this.container.addChild(tagLbl);
    cy += fH + gap;

    const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
    tagBg.x = px; tagBg.y = cy;
    this.container.addChild(tagBg);
    const tagVal = txt(this.familyCreateTag || ' ', Math.round(fH * 0.4), C.dark);
    tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
    this.container.addChild(tagVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.familyActiveInput = 'tag';
      this.openHiddenInput({
        value: this.familyCreateTag, maxLength: 5,
        onInput: (v) => { this.familyCreateTag = v.toUpperCase(); },
        onBlur: () => { this.familyActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    this.addButton(t('social.family.confirm'), px, cy, bW, bH, C.dark, C.accent, () => void this.doCreateFamily());
    this.addButton(t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { this.familySubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
  }

  private drawFamilyJoinForm(px: number, panelW: number, startY: number): void {
    const { w, h } = this;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const lbl = txt(t('social.family.idPlaceholder'), Math.round(h * 0.024), C.mid);
    lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
    this.container.addChild(lbl);
    cy += fH + gap;

    const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.familyActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    idBg.x = px; idBg.y = cy;
    this.container.addChild(idBg);
    const idVal = txt(this.familyJoinId || ' ', Math.round(fH * 0.4), C.dark);
    idVal.anchor.set(0, 0.5); idVal.x = px + Math.round(panelW * 0.04); idVal.y = cy + fH / 2;
    this.container.addChild(idVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.familyActiveInput = 'id';
      this.openHiddenInput({
        value: this.familyJoinId, maxLength: 64,
        onInput: (v) => { this.familyJoinId = v; },
        onBlur: () => { this.familyActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    this.addButton(t('social.family.confirm'), px, cy, bW, bH, C.dark, C.accent, () => void this.doJoinFamily());
    this.addButton(t('social.family.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { this.familySubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
  }

  private async doCreateFamily(): Promise<void> {
    const name = this.familyCreateName.trim();
    const tag = this.familyCreateTag.trim().toUpperCase();
    if (!name || !tag) return;
    this.clearHiddenInput();
    try {
      await this.cb.createFamily?.(name, tag);
      this.toast('social.family.created');
      this.familySubview = 'info';
      this.familyCreateName = '';
      this.familyCreateTag = '';
      this.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      this.toast('social.family.createFail');
    }
    this.render();
  }

  private async doJoinFamily(): Promise<void> {
    const id = this.familyJoinId.trim();
    if (!id) return;
    this.clearHiddenInput();
    try {
      await this.cb.joinFamily?.(id);
      this.toast('social.family.joined');
      this.familySubview = 'info';
      this.familyJoinId = '';
      this.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      this.toast('social.family.joinFail');
    }
    this.render();
  }

  // ── 宗门 Tab ──────────────────────────────────────────────────────────────────

  private drawSectTab(): void {
    const { w, h } = this;
    this.regionTop = this.bodyTop + Math.round(h * 0.01);
    this.regionBottom = h - Math.round(h * 0.02);

    if (!this.cb.loadSLGStatus) {
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }
    if (!this.slgLoaded) {
      if (!this.slgLoading) void this.loadSLGStatus();
      this.centerLabelFixed(t('friends.loading'));
      return;
    }
    if (!this.slgStatus) {
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }

    const s = this.slgStatus;
    const px = Math.round(w * 0.06);
    const panelW = w - px * 2;
    let cy = this.regionTop + Math.round(h * 0.03);

    if (!s.familyId) {
      this.centerLabelFixed(t('social.sect.noFamily'));
      return;
    }

    if (s.sectId) {
      const ph = Math.round(h * 0.13);
      const bg = sketchPanel(panelW, ph, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(px, cy, panelW) });
      bg.x = px; bg.y = cy;
      sketchAccentBar(bg, ph, C.gold, seedFor(px, ph, 5));
      this.container.addChild(bg);

      const nameLabel = txt(s.sectName ?? s.sectId, Math.round(h * 0.032), C.dark, true);
      nameLabel.anchor.set(0.5, 0.5); nameLabel.x = w / 2; nameLabel.y = cy + ph / 2;
      this.container.addChild(nameLabel);

      cy += ph + Math.round(h * 0.03);
      const bH = Math.round(h * 0.08);
      this.addButton(t('social.sect.enter'), px, cy, panelW, bH, C.dark, C.gold,
        () => this.cb.openSectHub?.());
    } else {
      if (this.sectSubview === 'info') {
        const lbl = txt(t('social.sect.none'), Math.round(h * 0.026), C.mid);
        lbl.anchor.set(0.5, 0); lbl.x = w / 2; lbl.y = cy;
        this.container.addChild(lbl);
        cy += Math.round(h * 0.06);

        const bH = Math.round(h * 0.08);
        const bGap = Math.round(w * 0.04);

        if (s.isLeader) {
          const bW = Math.round((panelW - bGap) / 2);
          this.addButton(t('social.sect.create'), px, cy, bW, bH, C.dark, C.gold,
            () => { this.sectSubview = 'create'; this.render(); });
          this.addButton(t('social.sect.joinById'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
            () => { this.sectSubview = 'joinById'; this.render(); }, C.dark);
        } else {
          const hint = txt(t('social.sect.leaderOnly'), Math.round(h * 0.022), C.mid);
          hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = cy;
          this.container.addChild(hint);
          cy += Math.round(h * 0.05);
          this.addButton(t('social.sect.joinById'), px, cy, panelW, bH, C.paper, C.line,
            () => { this.sectSubview = 'joinById'; this.render(); }, C.dark);
        }
      } else if (this.sectSubview === 'create') {
        this.drawSectCreateForm(px, panelW, cy);
      } else {
        this.drawSectJoinForm(px, panelW, cy);
      }
    }
  }

  private drawSectCreateForm(px: number, panelW: number, startY: number): void {
    const { w, h } = this;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const nameLbl = txt(t('social.sect.namePlaceholder'), Math.round(h * 0.024), C.mid);
    nameLbl.anchor.set(0, 0.5); nameLbl.x = px; nameLbl.y = cy + fH / 2;
    this.container.addChild(nameLbl);
    cy += fH + gap;

    const nameBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'name' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    nameBg.x = px; nameBg.y = cy;
    this.container.addChild(nameBg);
    const nameVal = txt(this.sectCreateName || ' ', Math.round(fH * 0.4), C.dark);
    nameVal.anchor.set(0, 0.5); nameVal.x = px + Math.round(panelW * 0.04); nameVal.y = cy + fH / 2;
    this.container.addChild(nameVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.sectActiveInput = 'name';
      this.openHiddenInput({
        value: this.sectCreateName, maxLength: 24,
        onInput: (v) => { this.sectCreateName = v; },
        onBlur: () => { this.sectActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + gap;

    const tagLbl = txt(t('social.sect.tagPlaceholder'), Math.round(h * 0.024), C.mid);
    tagLbl.anchor.set(0, 0.5); tagLbl.x = px; tagLbl.y = cy + fH / 2;
    this.container.addChild(tagLbl);
    cy += fH + gap;

    const tagBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'tag' ? C.accent : C.line, width: 2, seed: seedFor(px, cy + 1, panelW) });
    tagBg.x = px; tagBg.y = cy;
    this.container.addChild(tagBg);
    const tagVal = txt(this.sectCreateTag || ' ', Math.round(fH * 0.4), C.dark);
    tagVal.anchor.set(0, 0.5); tagVal.x = px + Math.round(panelW * 0.04); tagVal.y = cy + fH / 2;
    this.container.addChild(tagVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.sectActiveInput = 'tag';
      this.openHiddenInput({
        value: this.sectCreateTag, maxLength: 5,
        onInput: (v) => { this.sectCreateTag = v.toUpperCase(); },
        onBlur: () => { this.sectActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    this.addButton(t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.doCreateSect());
    this.addButton(t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { this.sectSubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
  }

  private drawSectJoinForm(px: number, panelW: number, startY: number): void {
    const { w, h } = this;
    const fH = Math.round(h * 0.07);
    const gap = Math.round(h * 0.02);
    let cy = startY;

    const lbl = txt(t('social.sect.idPlaceholder'), Math.round(h * 0.024), C.mid);
    lbl.anchor.set(0, 0.5); lbl.x = px; lbl.y = cy + fH / 2;
    this.container.addChild(lbl);
    cy += fH + gap;

    const idBg = sketchPanel(panelW, fH, { fill: C.paper, border: this.sectActiveInput === 'id' ? C.accent : C.line, width: 2, seed: seedFor(px, cy, panelW) });
    idBg.x = px; idBg.y = cy;
    this.container.addChild(idBg);
    const idVal = txt(this.sectJoinId || ' ', Math.round(fH * 0.4), C.dark);
    idVal.anchor.set(0, 0.5); idVal.x = px + Math.round(panelW * 0.04); idVal.y = cy + fH / 2;
    this.container.addChild(idVal);
    this.hits.push({ rect: { x: px, y: cy, w: panelW, h: fH }, fn: () => {
      this.sectActiveInput = 'id';
      this.openHiddenInput({
        value: this.sectJoinId, maxLength: 64,
        onInput: (v) => { this.sectJoinId = v; },
        onBlur: () => { this.sectActiveInput = null; },
      });
      this.render();
    }});
    cy += fH + Math.round(h * 0.04);

    const bH = Math.round(h * 0.08);
    const bGap = Math.round(w * 0.04);
    const bW = Math.round((panelW - bGap) / 2);
    this.addButton(t('social.sect.confirm'), px, cy, bW, bH, C.dark, C.gold, () => void this.doJoinSect());
    this.addButton(t('social.sect.cancel'), px + bW + bGap, cy, bW, bH, C.paper, C.line,
      () => { this.sectSubview = 'info'; this.clearHiddenInput(); this.render(); }, C.dark);
  }

  private async doCreateSect(): Promise<void> {
    const name = this.sectCreateName.trim();
    const tag = this.sectCreateTag.trim().toUpperCase();
    if (!name || !tag) return;
    this.clearHiddenInput();
    try {
      await this.cb.createSect?.(name, tag);
      this.toast('social.sect.created');
      this.sectSubview = 'info';
      this.sectCreateName = '';
      this.sectCreateTag = '';
      this.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      this.toast('social.sect.createFail');
    }
    this.render();
  }

  private async doJoinSect(): Promise<void> {
    const id = this.sectJoinId.trim();
    if (!id) return;
    this.clearHiddenInput();
    try {
      await this.cb.joinSect?.(id);
      this.toast('social.sect.joined');
      this.sectSubview = 'info';
      this.sectJoinId = '';
      this.slgLoaded = false;
      void this.loadSLGStatus();
    } catch {
      this.toast('social.sect.joinFail');
    }
    this.render();
  }

  // ── 世界频道 Tab ────────────────────────────────────────────────────────────────

  private drawWorldTab(): void {
    const { w, h } = this;

    if (!this.cb.loadSLGStatus || !this.cb.loadWorldChat) {
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }
    if (!this.slgLoaded) {
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      if (!this.slgLoading) void this.loadSLGStatus();
      this.centerLabelFixed(t('friends.loading'));
      return;
    }
    if (!this.slgStatus) {
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.centerLabelFixed(t('social.noSlg'));
      return;
    }

    // Input area pinned at the bottom
    const inputH = Math.round(h * 0.1);
    const inputY = h - inputH - Math.round(h * 0.01);
    const px = Math.round(w * 0.04);
    const sendBtnW = Math.round(w * 0.3);
    const inputW = w - px * 2 - sendBtnW - Math.round(w * 0.02);

    const inputBg = sketchPanel(inputW, Math.round(inputH * 0.75), {
      fill: C.paper, border: this.worldChatActive ? C.accent : C.line, width: 2, seed: seedFor(px, inputY, inputW),
    });
    inputBg.x = px; inputBg.y = inputY + Math.round(inputH * 0.125);
    this.container.addChild(inputBg);
    const inputTxt = txt(
      this.worldChatInput || t('social.world.placeholder'),
      Math.round(inputH * 0.3),
      this.worldChatInput ? C.dark : C.mid,
    );
    inputTxt.anchor.set(0, 0.5);
    inputTxt.x = px + Math.round(inputW * 0.04);
    inputTxt.y = inputY + inputH / 2;
    this.container.addChild(inputTxt);
    this.hits.push({ rect: { x: px, y: inputY, w: inputW, h: inputH }, fn: () => {
      this.worldChatActive = true;
      this.openHiddenInput({
        value: this.worldChatInput, maxLength: 200,
        onInput: (v) => { this.worldChatInput = v; },
        onBlur: () => { this.worldChatActive = false; },
        onEnter: () => { void this.doSendWorldChat(); },
      });
      this.render();
    }});

    const sendLabel = this.worldSending ? t('social.world.sending') : t('social.world.sendBtn');
    const sendFill = this.worldSending ? C.btnOff : C.dark;
    this.addButton(sendLabel,
      px + inputW + Math.round(w * 0.02), inputY + Math.round(inputH * 0.125),
      sendBtnW, Math.round(inputH * 0.75), sendFill, C.gold,
      () => { if (!this.worldSending) void this.doSendWorldChat(); });

    // Message list above input
    this.regionTop = this.bodyTop + Math.round(h * 0.01);
    this.regionBottom = inputY - Math.round(h * 0.01);
    const regionH = this.regionBottom - this.regionTop;
    const { layer } = this.scrollRegion(regionH);

    if (!this.worldLoaded) {
      this.centerLabel(layer, 'friends.loading', regionH);
      this.maxScroll = 0;
      return;
    }
    if (this.worldMessages.length === 0) {
      this.centerLabel(layer, 'social.world.empty', regionH);
      this.maxScroll = 0;
      return;
    }

    const rh = Math.round(h * 0.095);
    const rowGap = Math.round(h * 0.01);
    let cy = Math.round(h * 0.01);
    const screenY = (c: number) => this.regionTop + c - this.scrollY;

    for (const m of this.worldMessages) {
      const sy = screenY(cy);
      if (this.rowVisible(sy, rh)) this.drawWorldMsgRow(layer, m, sy);
      cy += rh + rowGap;
    }
    this.maxScroll = Math.max(0, cy - regionH);
    // Auto-scroll to bottom on first load
    if (this.scrollY === 0 && this.maxScroll > 0) this.scrollY = this.maxScroll;
    if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
  }

  private drawWorldMsgRow(layer: PIXI.Container, m: WorldChatMessage, y: number): void {
    const { w, h } = this;
    const rh = Math.round(h * 0.095);
    const rx = Math.round(w * 0.04);
    const rw = Math.round(w * 0.92);
    const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.line, width: 1, seed: seedFor(rx, m.ts % 1000, rw) });
    bg.x = rx; bg.y = y;
    layer.addChild(bg);

    const sender = txt(m.senderName, Math.round(rh * 0.28), C.accent, true);
    sender.anchor.set(0, 0.5); sender.x = rx + Math.round(rw * 0.04); sender.y = y + rh * 0.32;
    layer.addChild(sender);

    const body = txt(m.body.slice(0, 60), Math.round(rh * 0.26), C.dark);
    body.anchor.set(0, 0.5); body.x = rx + Math.round(rw * 0.04); body.y = y + rh * 0.68;
    layer.addChild(body);
  }

  private async doSendWorldChat(): Promise<void> {
    const body = this.worldChatInput.trim();
    if (!body || this.worldSending || !this.cb.sendWorldChat) return;
    this.clearHiddenInput();
    this.worldSending = true;
    this.render();
    try {
      const senderName = this.cb.playerName?.() ?? '';
      await this.cb.sendWorldChat(body, senderName);
      this.worldChatInput = '';
      this.toast('social.world.sent');
      void this.loadWorldMessages();
    } catch {
      this.toast('social.world.sendFail');
    } finally {
      this.worldSending = false;
    }
    this.render();
  }

  // ── 邮件 Tab ──────────────────────────────────────────────────────────────────

  private drawMailList(): void {
    const { w, h } = this;
    this.regionTop = this.bodyTop + Math.round(h * 0.01);
    this.regionBottom = h - Math.round(h * 0.02);
    const regionH = this.regionBottom - this.regionTop;
    const { layer } = this.scrollRegion(regionH);

    if (this.loading) { this.centerLabel(layer, 'friends.loading', regionH); this.maxScroll = 0; return; }
    if (this.mail.length === 0) { this.centerLabel(layer, 'mail.empty', regionH); this.maxScroll = 0; return; }

    let cy = Math.round(h * 0.01);
    const screenY = (c: number) => this.regionTop + c - this.scrollY;
    const rowGap = Math.round(h * 0.014);
    const rh = Math.round(h * 0.10);
    for (const m of this.mail) {
      const sy = screenY(cy);
      if (this.rowVisible(sy, rh)) this.drawMailRow(layer, m, sy);
      cy += rh + rowGap;
    }
    this.maxScroll = Math.max(0, cy - regionH);
    if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
  }

  private drawMailRow(layer: PIXI.Container, m: MailView, y: number): void {
    const { w, h } = this;
    const rh = Math.round(h * 0.10);
    const rx = Math.round(w * 0.04);
    const rw = Math.round(w * 0.92);
    const hasAtt = !!m.attachments && m.attachments.length > 0;
    const unclaimed = hasAtt && !m.claimed;
    const accent = !m.read ? C.gold : unclaimed ? C.green : C.mid;
    const bg = sketchPanel(rw, rh, { fill: C.paper, border: accent, width: 2, seed: seedFor(rx, 3, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, accent, seedFor(rx, rh, 11));
    layer.addChild(bg);

    if (!m.read) {
      const dot = new PIXI.Graphics();
      dot.beginFill(C.gold); dot.drawCircle(rx + Math.round(rw * 0.05), y + rh / 2, Math.round(rh * 0.08)); dot.endFill();
      layer.addChild(dot);
    }
    const tx = rx + Math.round(rw * 0.1);
    const subj = txt((hasAtt ? '🎁 ' : '') + m.subject, Math.round(rh * 0.3), C.dark, true);
    subj.anchor.set(0, 0.5); subj.x = tx; subj.y = y + rh * 0.34;
    layer.addChild(subj);
    const from = txt(m.fromName || (m.from === 'system' ? t('mail.system') : `#${m.from}`), Math.round(rh * 0.22), C.mid);
    from.anchor.set(0, 0.5); from.x = tx; from.y = y + rh * 0.70;
    layer.addChild(from);

    this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openMail(m) });
  }

  private openMail(m: MailView): void {
    this.openMailItem = m;
    this.scrollY = 0;
    if (!m.read) void this.cb.markMailRead(m.mailId).then(() => { m.read = true; });
    this.render();
  }

  private drawMailDetail(m: MailView): void {
    const { w, h } = this;
    const top = this.bodyTop + Math.round(h * 0.02);
    const px = Math.round(w * 0.06);
    const panelW = w - px * 2;

    const subj = txt(m.subject, Math.round(h * 0.034), C.dark, true);
    subj.anchor.set(0, 0); subj.x = px; subj.y = top;
    this.container.addChild(subj);
    const from = txt(m.fromName || (m.from === 'system' ? t('mail.system') : `#${m.from}`), Math.round(h * 0.024), C.mid);
    from.anchor.set(0, 0); from.x = px; from.y = top + Math.round(h * 0.05);
    this.container.addChild(from);

    const bodyTxt = new PIXI.Text(m.body, {
      fontSize: Math.round(h * 0.026), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: panelW, breakWords: true,
    });
    bodyTxt.x = px; bodyTxt.y = top + Math.round(h * 0.10);
    this.container.addChild(bodyTxt);

    let cy = bodyTxt.y + bodyTxt.height + Math.round(h * 0.03);
    const hasAtt = !!m.attachments && m.attachments.length > 0;
    if (hasAtt) {
      const label = txt(t('mail.attachments'), Math.round(h * 0.024), C.mid, true);
      label.anchor.set(0, 0); label.x = px; label.y = cy;
      this.container.addChild(label);
      cy += Math.round(h * 0.04);
      for (const a of m.attachments!) {
        const desc = attachmentLabel(a);
        const row = txt('· ' + desc, Math.round(h * 0.026), C.dark);
        row.anchor.set(0, 0); row.x = px + Math.round(w * 0.02); row.y = cy;
        this.container.addChild(row);
        cy += Math.round(h * 0.04);
      }
      cy += Math.round(h * 0.02);
      const bH = Math.round(h * 0.08);
      if (m.claimed) {
        const done = txt(t('mail.claimed'), Math.round(h * 0.028), C.green, true);
        done.anchor.set(0.5, 0.5); done.x = w / 2; done.y = cy + bH / 2;
        this.container.addChild(done);
      } else {
        this.addButton(t('mail.claim'), px, cy, panelW, bH, C.green, C.green, () => void this.doClaim(m), 0xffffff);
      }
      cy += bH + Math.round(h * 0.02);
    }

    const dH = Math.round(h * 0.07);
    this.addButton(t('mail.delete'), px, h - dH - Math.round(h * 0.03), panelW, dH, C.paper, C.red,
      () => void this.doMailDelete(m), C.red);
  }

  private async doClaim(m: MailView): Promise<void> {
    try {
      const ok = await this.cb.claimMail(m.mailId);
      if (ok) { m.claimed = true; this.toast('mail.claimDone'); }
      else this.toast('mail.claimFail');
    } catch (e) {
      this.toast(((e as { code?: string } | null)?.code) === 'ALREADY_CLAIMED' ? 'mail.alreadyClaimed' : 'mail.claimFail');
    }
    this.render();
    void this.refresh();
  }

  private async doMailDelete(m: MailView): Promise<void> {
    this.openMailItem = null;
    try { await this.cb.deleteMail(m.mailId); } catch { this.toast('friends.error'); }
    this.render();
    void this.refresh();
  }

  // ── 搜索子视图 ──────────────────────────────────────────────────────────────────

  private drawSearch(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);

    const prompt = txt(t('friends.searchTitle'), Math.round(h * 0.028), C.dark, true);
    prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = tbH + Math.round(h * 0.05);
    this.container.addChild(prompt);

    const fW = Math.round(w * 0.7);
    const fH = Math.round(h * 0.08);
    const fX = (w - fW) / 2;
    const fY = tbH + Math.round(h * 0.10);
    const field = sketchPanel(fW, fH, {
      fill: C.paper, border: this.searchDigits.length ? C.accent : C.line, width: 2, seed: seedFor(fX, fY, fW),
    });
    field.x = fX; field.y = fY;
    this.container.addChild(field);
    const shown = this.searchDigits.length ? this.searchDigits.join('') : t('friends.searchPlaceholder');
    const fTxt = txt(shown, Math.round(fH * 0.45), this.searchDigits.length ? C.dark : C.mid, true);
    fTxt.anchor.set(0.5, 0.5); fTxt.x = w / 2; fTxt.y = fY + fH / 2;
    this.container.addChild(fTxt);

    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', t('friends.clear'), '0', '⌫'];
    const perRow = 3;
    const kY = fY + fH + Math.round(h * 0.03);
    const kGap = Math.round(w * 0.03);
    const kW = Math.round((w * 0.7 - (perRow - 1) * kGap) / perRow);
    const kH = Math.round(h * 0.075);
    const kX0 = (w - (perRow * kW + (perRow - 1) * kGap)) / 2;
    keys.forEach((label, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const kx = kX0 + c * (kW + kGap);
      const ky = kY + r * (kH + kGap);
      this.addButton(label, kx, ky, kW, kH, C.paper, C.line, () => {
        if (label === '⌫') this.searchDigits.pop();
        else if (label === t('friends.clear')) this.searchDigits = [];
        else if (this.searchDigits.length < 9) this.searchDigits.push(label);
        this.searchResult = null;
        this.searchMsgKey = null;
        this.render();
      }, C.dark, Math.round(kH * 0.4));
    });

    const kRows = Math.ceil(keys.length / perRow);
    const sY = kY + kRows * (kH + kGap) + Math.round(h * 0.01);
    const enabled = this.searchDigits.length > 0;
    this.addButton(t('friends.searchBtn'), (w - fW) / 2, sY, fW, Math.round(h * 0.08),
      enabled ? C.dark : C.btnOff, enabled ? C.accent : C.light,
      () => { if (enabled) void this.doSearch(); }, 0xffffff);

    const ry = sY + Math.round(h * 0.11);
    if (this.searchResult) {
      const res = this.searchResult;
      const rh = Math.round(h * 0.10);
      const rx = (w - fW) / 2;
      const bg = sketchPanel(fW, rh, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(rx, ry, fW) });
      bg.x = rx; bg.y = ry;
      sketchAccentBar(bg, rh, C.accent, seedFor(rx, ry, 3));
      this.container.addChild(bg);
      const nm = txt(res.displayName, Math.round(rh * 0.3), C.dark, true);
      nm.anchor.set(0, 0.5); nm.x = rx + Math.round(fW * 0.06); nm.y = ry + rh * 0.36;
      this.container.addChild(nm);
      const sub = txt(`#${res.publicId}${res.rank ? '  ·  ' + rankLabel(res.rank) : ''}`, Math.round(rh * 0.2), C.mid);
      sub.anchor.set(0, 0.5); sub.x = rx + Math.round(fW * 0.06); sub.y = ry + rh * 0.68;
      this.container.addChild(sub);
      const bW = Math.round(fW * 0.26);
      const bH = Math.round(rh * 0.52);
      this.addButton(t('friends.add'), rx + fW - bW - Math.round(fW * 0.04), ry + (rh - bH) / 2, bW, bH,
        C.green, C.green, () => void this.doAdd(res.publicId), 0xffffff, Math.round(bH * 0.4));
    } else if (this.searchMsgKey) {
      const msg = txt(t(this.searchMsgKey), Math.round(h * 0.024), C.mid);
      msg.anchor.set(0.5, 0); msg.x = w / 2; msg.y = ry;
      this.container.addChild(msg);
    }
  }

  // ── Toast & shared helpers ─────────────────────────────────────────────────────

  private drawToast(): void {
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

  /** 中心标签（固定位置，不在滚动层）。 */
  private centerLabelFixed(text: string): void {
    const regionH = this.regionBottom - this.regionTop;
    const lbl = txt(text, Math.round(this.h * 0.026), C.mid);
    lbl.anchor.set(0.5, 0.5); lbl.x = this.w / 2; lbl.y = this.regionTop + regionH / 2;
    this.container.addChild(lbl);
  }

  private scrollRegion(regionH: number): { layer: PIXI.Container } {
    const { w } = this;
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff); clip.drawRect(0, this.regionTop, w, regionH); clip.endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);
    return { layer };
  }

  private centerLabel(layer: PIXI.Container, key: TranslationKey, regionH: number): void {
    const l = txt(t(key), Math.round(this.h * 0.026), C.mid);
    l.anchor.set(0.5, 0.5); l.x = this.w / 2; l.y = this.regionTop + regionH / 2;
    layer.addChild(l);
  }

  private addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void,
    textColor = 0xffffff, fontSize?: number, layer?: PIXI.Container,
  ): void {
    const target = layer ?? this.container;
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x; g.y = y;
    target.addChild(g);

    const tl = txt(label, fontSize ?? Math.round(h * 0.36), textColor, true);
    tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
    target.addChild(tl);

    this.hits.push({ rect: { x, y, w, h }, scroll: !!layer, fn });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function rankLabel(rank: string): string {
  return t(('rank.' + rank.replace(/^rank\./, '')) as TranslationKey);
}

function attachmentLabel(a: MailAttachmentView): string {
  const n = a.count ?? 1;
  if (a.kind === 'coins') return t('mail.attCoins', { n });
  if (a.kind === 'skin') return t('mail.attSkin', { id: a.id ?? '' });
  if (a.kind === 'material') return t('mail.attMaterial', { id: a.id ?? '', n });
  return t('mail.attItem', { id: a.id ?? '', n });
}

function addErrorKey(e: unknown): TranslationKey {
  const code = (e as { code?: string } | null)?.code;
  switch (code) {
    case 'ALREADY_FRIEND':      return 'friends.alreadyFriend';
    case 'FRIEND_CAP_REACHED':  return 'friends.capReached';
    case 'BLOCKED':             return 'friends.blocked';
    case 'NOT_FOUND':           return 'friends.notFound';
    default:                    return 'friends.error';
  }
}
