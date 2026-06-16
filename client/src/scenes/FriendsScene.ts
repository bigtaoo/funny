import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ProfilePopup } from '../render/ProfilePopup';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import type { FriendView, FriendRequestView, ProfileView } from '../net/ApiClient';
import type { FriendPresence, FriendRequestPush, FriendUpdate } from '../net/proto/transport';

// ── FriendsScene (S6-1) — the lobby "social" hub: friends list + requests ─────
//
// A canvas-drawn social screen wired to ApiClient (REST) for data and to
// NetSession's control-plane push (forwarded by app via apply*). Mirrors
// RoomScene's view-only pattern: local taps fire the action callbacks; inbound
// server pushes arrive via apply*, which reloads + re-renders.
//
// Views: list (friends + incoming requests + search/room buttons) → search
// (numeric keypad to find a player by 9-digit publicId → add).
//
// The list region scrolls by drag (tap-vs-drag distinguished by an 8px
// threshold, same as the in-battle card drag). Copy lives under i18n `friends.*`.
//
// Chat / mail tabs (S6-2 / S6-3) will join this scene later; for now it is the
// friends-only first cut.

export interface FriendsSceneCallbacks {
  onBack(): void;
  /** Open the online room (friendly room / ranked) flow. */
  onOpenRoom(): void;
  loadFriends(): Promise<FriendView[]>;
  loadRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>;
  /** Look up a player by 9-digit public id. Rejects ApiError('NOT_FOUND'). */
  search(publicId: string): Promise<ProfileView>;
  /** Send a friend request. Rejects with ALREADY_FRIEND / FRIEND_CAP_REACHED / BLOCKED / NOT_FOUND. */
  addFriend(publicId: string): Promise<void>;
  respond(requestId: string, accept: boolean): Promise<void>;
  removeFriend(publicId: string): Promise<void>;
}

type View = 'list' | 'search';

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

const DRAG_THRESHOLD = 8;

export class FriendsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: FriendsSceneCallbacks;

  private view: View = 'list';
  private loading = true;
  private friends: FriendView[] = [];
  private incoming: FriendRequestView[] = [];

  // Search sub-view state.
  private searchDigits: string[] = [];
  private searchResult: ProfileView | null = null;
  private searchMsgKey: TranslationKey | null = null;

  private toastKey: TranslationKey | null = null;
  private toastT = 0;

  // Scroll (drag) state for the list region.
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
  /** Set on destroy so a late-resolving async refresh/search skips rendering. */
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
    this.unsubs.forEach((u) => u());
    this.popup.destroy();
  }

  // ── Inbound (app forwards NetSession control-plane push here) ─────────────────

  applyFriendPresence(p: FriendPresence): void {
    const f = this.friends.find((x) => x.publicId === p.publicId);
    if (f) { f.online = p.online; this.render(); }
  }

  applyFriendRequest(_r: FriendRequestPush): void {
    void this.refresh();
  }

  applyFriendUpdate(_u: FriendUpdate): void {
    void this.refresh();
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    try {
      const [friends, requests] = await Promise.all([
        this.cb.loadFriends(),
        this.cb.loadRequests(),
      ]);
      this.friends = friends;
      this.incoming = requests.incoming;
    } catch {
      // Leave whatever we have; surface a soft toast on first failure.
      if (this.loading) this.toast('friends.error');
    } finally {
      this.loading = false;
      this.render();
    }
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
    // A clean tap → run the first matching hit (scroll hits already carry their
    // current on-screen rect; clip them to the visible scroll region).
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
    try {
      await this.cb.respond(requestId, accept);
    } catch {
      this.toast('friends.error');
    }
    void this.refresh();
  }

  private async doRemove(publicId: string): Promise<void> {
    this.popup.hide();
    try {
      await this.cb.removeFriend(publicId);
      this.toast('friends.removed');
    } catch {
      this.toast('friends.error');
    }
    void this.refresh();
  }

  private onBack(): void {
    if (this.view === 'search') { this.view = 'list'; this.render(); return; }
    this.cb.onBack();
  }

  private toast(key: TranslationKey): void {
    this.toastKey = key;
    this.toastT = 2.5;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.dead) return;
    this.container.removeChildren();
    this.hits = [];

    this.container.addChild(buildPaperBackground('friendsbg', this.w, this.h));
    this.drawHeader();

    if (this.view === 'search') this.drawSearch();
    else this.drawList();

    this.drawToast();
    this.container.addChild(this.popup.container);
  }

  private drawHeader(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('friends.title'), Math.round(h * 0.04), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('friends.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    const pad = Math.round(h * 0.02);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + pad, h: tbH }, fn: () => this.onBack() });
  }

  private drawList(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);

    // Action row: search (add) + online play (room).
    const aY = tbH + Math.round(h * 0.025);
    const aH = Math.round(h * 0.075);
    const aGap = Math.round(w * 0.04);
    const aW = Math.round((w * 0.92 - aGap) / 2);
    const aX0 = (w - (2 * aW + aGap)) / 2;
    this.addButton(t('friends.search'), aX0, aY, aW, aH, C.dark, C.accent, () => this.openSearch());
    this.addButton(t('friends.room'), aX0 + aW + aGap, aY, aW, aH, C.dark, C.gold, () => this.cb.onOpenRoom());

    // Scrollable content region below the action row.
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

    // Content is laid out in content-space (y from 0); the layer is shifted up by
    // scrollY and the hit rects are recorded in on-screen space.
    let cy = 0;
    const rowGap = Math.round(h * 0.014);
    const screenY = (contentY: number) => this.regionTop + contentY - this.scrollY;

    const sectionLabel = (key: TranslationKey, count?: number): void => {
      const label = txt(count !== undefined ? `${t(key)} (${count})` : t(key), Math.round(h * 0.024), C.mid, true);
      label.anchor.set(0, 0.5); label.x = Math.round(w * 0.05); label.y = screenY(cy + Math.round(h * 0.018));
      layer.addChild(label);
      cy += Math.round(h * 0.045);
    };

    // Incoming requests first (red-dot priority).
    if (this.incoming.length > 0) {
      sectionLabel('friends.requests', this.incoming.length);
      for (const r of this.incoming) {
        this.drawRequestRow(layer, r, cy, screenY(cy));
        cy += Math.round(h * 0.09) + rowGap;
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
      // Online first, then by name for a stable order.
      const sorted = [...this.friends].sort(
        (a, b) => (a.online === b.online ? a.displayName.localeCompare(b.displayName) : a.online ? -1 : 1),
      );
      for (const f of sorted) {
        this.drawFriendRow(layer, f, cy, screenY(cy));
        cy += Math.round(h * 0.10) + rowGap;
      }
    }

    this.maxScroll = Math.max(0, cy - regionH);
    if (this.scrollY > this.maxScroll) { this.scrollY = this.maxScroll; }
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

    // Accept / reject buttons on the right.
    const bW = Math.round(rw * 0.18);
    const bH = Math.round(rh * 0.5);
    const bY = y + (rh - bH) / 2;
    const rejX = rx + rw - bW - Math.round(rw * 0.03);
    const accX = rejX - bW - Math.round(rw * 0.02);
    this.addButton(t('friends.accept'), accX, bY, bW, bH, C.green, C.green, () => void this.doRespond(r.requestId, true),
      0xffffff, Math.round(bH * 0.4), layer);
    this.addButton(t('friends.reject'), rejX, bY, bW, bH, C.paper, C.red, () => void this.doRespond(r.requestId, false),
      C.red, Math.round(bH * 0.4), layer);
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

    // Online status dot.
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

    // Trailing "✕" remove button (pushed BEFORE the row hit so it wins its sub-rect).
    const xW = Math.round(rh * 0.62);
    const xX = rx + rw - xW - Math.round(rw * 0.03);
    const xY = y + (rh - xW) / 2;
    this.addButton('✕', xX, xY, xW, xW, C.paper, C.red, () => void this.doRemove(f.publicId),
      C.red, Math.round(xW * 0.5), layer);

    // Tapping the rest of the row opens its profile card.
    this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openFriendProfile(f) });
  }

  private openFriendProfile(f: FriendView): void {
    this.popup.show({
      name: f.alias || f.displayName,
      publicId: f.publicId,
      ...(f.rank ? { rankKey: 'rank.' + f.rank } : {}),
    });
  }

  private drawSearch(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);

    const prompt = txt(t('friends.searchTitle'), Math.round(h * 0.028), C.dark, true);
    prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = tbH + Math.round(h * 0.05);
    this.container.addChild(prompt);

    // Entered-id field.
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

    // Numeric keypad (0-9) + backspace + clear, 3 per row.
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

    // Result / status line.
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

  /**
   * Draw a hand-drawn button + register its hit rect. When `layer` is given the
   * button is drawn into that (masked, scrolling) container and its hit is marked
   * `scroll` so the tap test clips it to the visible region; otherwise it is a
   * fixed button on the scene container.
   */
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
