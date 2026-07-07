import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { caretDisplay } from '../render/inputDisplay';
import type { ChatMessageView } from '../net/ApiClient';
import type { ChatMessagePush } from '../net/proto/transport';

// ── ChatScene (S6-2) — a 1:1 conversation window ──────────────────────────────
//
// Canvas-drawn message thread (mine right / peer left) + a compose bar backed by
// a hidden DOM <input> (same trick as LoginScene — works with desktop + mobile
// soft keyboards). Sending goes through REST (cb.send); inbound messages arrive
// via the gateway control-plane push, forwarded by the app as applyIncoming().
//
// The conversation id is derived server-side from both accountIds; the client
// only knows the peer's publicId, so on open we resolve the convId (null until
// the first message exists) and load the latest history page. Older pages load
// on demand via a "load earlier" tap at the top (paginated history).

export interface ChatSceneCallbacks {
  onBack(): void;
  peerName: string;
  peerPublicId: string;
  /** This player's own 9-digit public id (to right-align own messages). */
  myPublicId: string;
  /** Resolve the existing conversation id for this peer (null = no messages yet). */
  resolveConvId(peerPublicId: string): Promise<string | null>;
  /** Load a history page (messages older than `before` epoch-ms when given). */
  loadMessages(convId: string, before?: number): Promise<ChatMessageView[]>;
  /** Send a message; resolves with the server timestamp. Rejects ApiError. */
  send(body: string): Promise<{ messageId: string; ts: number }>;
  /** Mark the conversation read (clears unread). */
  markRead(convId: string): Promise<void>;
}

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

const PAGE = 30;
const DRAG_THRESHOLD = 8;

export class ChatScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: ChatSceneCallbacks;

  private convId: string | null = null;
  /** Ascending by ts (oldest first) for natural top→bottom rendering. */
  private messages: ChatMessageView[] = [];
  private loading = true;
  /** True while there may be older pages to fetch. */
  private hasMore = false;
  private draft = '';
  private composeFocused = false;
  private caretOn = true;
  private caretTimer = 0;
  private toastKey: TranslationKey | null = null;
  private toastT = 0;

  // Scroll (drag) state.
  private scrollY = 0;
  private maxScroll = 0;
  private regionTop = 0;
  private regionBottom = 0;
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;
  /** Pin to bottom (latest) unless the user scrolled up. */
  private stickBottom = true;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private hiddenInput: HTMLInputElement | null = null;
  private dead = false;

  constructor(layout: ILayout, input: InputManager, cb: ChatSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.setupHiddenInput();
    this.unsubs.push(input.onDown((x, y) => this.onPointerDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.onPointerMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.onPointerUp(x, y)));
    this.render();
    void this.load();
  }

  update(dt: number): void {
    if (this.toastKey) {
      this.toastT -= dt;
      if (this.toastT <= 0) { this.toastKey = null; this.render(); }
    }
    if (this.composeFocused) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
  }

  destroy(): void {
    this.dead = true;
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.container.destroy({ children: true });
  }

  // ── Inbound (app forwards control-plane chat_message push) ────────────────────
  applyIncoming(m: ChatMessagePush): void {
    // Only messages from this peer (or this conv) belong here.
    if (this.convId && m.convId !== this.convId) return;
    if (!this.convId && m.fromPublicId !== this.cb.peerPublicId) return;
    if (!this.convId) this.convId = m.convId;
    this.messages.push({
      messageId: `push-${m.ts}-${this.messages.length}`,
      convId: m.convId,
      fromPublicId: m.fromPublicId,
      body: m.body,
      kind: 'text',
      ts: m.ts,
    });
    this.stickBottom = true;
    if (this.convId) void this.cb.markRead(this.convId);
    this.render();
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  private async load(): Promise<void> {
    try {
      this.convId = await this.cb.resolveConvId(this.cb.peerPublicId);
      if (this.convId) {
        const page = await this.cb.loadMessages(this.convId);
        this.messages = page.slice().reverse(); // server returns newest-first
        this.hasMore = page.length >= PAGE;
        void this.cb.markRead(this.convId);
      }
    } catch {
      this.toast('chat.error');
    } finally {
      this.loading = false;
      this.stickBottom = true;
      if (!this.dead) this.render();
    }
  }

  private async loadEarlier(): Promise<void> {
    if (!this.convId || this.messages.length === 0) return;
    const oldest = this.messages[0].ts;
    try {
      const page = await this.cb.loadMessages(this.convId, oldest);
      if (page.length === 0) { this.hasMore = false; }
      else {
        this.messages = [...page.slice().reverse(), ...this.messages];
        this.hasMore = page.length >= PAGE;
      }
      this.stickBottom = false;
    } catch {
      this.toast('chat.error');
    }
    this.render();
  }

  private async doSend(): Promise<void> {
    const body = this.draft.trim();
    if (!body) return;
    this.draft = '';
    if (this.hiddenInput) this.hiddenInput.value = '';
    // Optimistic append (echoed as mine).
    const ts = Date.now();
    this.messages.push({ messageId: `local-${ts}`, convId: this.convId ?? '', fromPublicId: this.cb.myPublicId, body, kind: 'text', ts });
    this.stickBottom = true;
    this.render();
    try {
      await this.cb.send(body);
      // First message creates the conversation server-side → capture its id.
      if (!this.convId) this.convId = await this.cb.resolveConvId(this.cb.peerPublicId);
    } catch (e) {
      this.toast(sendErrKey(e));
    }
  }

  // ── Hidden input (compose) ────────────────────────────────────────────────
  private setupHiddenInput(): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('input');
    el.type = 'text';
    el.autocomplete = 'off';
    el.setAttribute('autocapitalize', 'sentences');
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;border:0;padding:0;margin:0;font-size:16px;z-index:-1;';
    el.addEventListener('focus', () => { this.composeFocused = true; this.caretOn = true; this.caretTimer = 0; this.render(); });
    el.addEventListener('blur', () => { this.composeFocused = false; this.render(); });
    el.addEventListener('input', () => { this.draft = el.value; this.render(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.doSend(); }
    });
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  private focusCompose(): void {
    this.hiddenInput?.focus();
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  private onPointerDown(x: number, y: number): void {
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x; this.downY = y;
    this.dragStartScroll = this.scrollY;
  }
  private onPointerMove(x: number, y: number): void {
    if (!this.pointerActive) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > DRAG_THRESHOLD) this.dragging = true;
    if (this.dragging && this.maxScroll > 0) {
      const next = clamp(this.dragStartScroll + (this.downY - y), 0, this.maxScroll);
      if (next !== this.scrollY) { this.scrollY = next; this.stickBottom = next >= this.maxScroll - 1; this.render(); }
    }
  }
  private onPointerUp(x: number, y: number): void {
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

  private toast(key: TranslationKey): void { this.toastKey = key; this.toastT = 2.5; }

  // ── Render ───────────────────────────────────────────────────────────────────
  private render(): void {
    if (this.dead) return;
    tearDownChildren(this.container); // caret blink (~2×/s) + per-keystroke compose → free Text textures
    this.hits = [];
    this.container.addChild(buildPaperBackground('chatbg', this.w, this.h));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
    this.drawHeader();
    this.drawThread();
    this.drawComposer();
    this.drawToast();
  }

  private drawHeader(): void {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, this.cb.peerName || `#${this.cb.peerPublicId}`, { headerH: Math.round(h * 0.11) });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
  }

  private drawThread(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.11);
    const composeH = Math.round(h * 0.10);
    this.regionTop = tbH + Math.round(h * 0.01);
    this.regionBottom = h - composeH - Math.round(h * 0.01);
    const regionH = this.regionBottom - this.regionTop;

    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff); clip.drawRect(0, this.regionTop, w, regionH); clip.endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);

    if (this.loading) {
      const l = txt(t('chat.loading'), Math.round(h * 0.028), C.mid);
      l.anchor.set(0.5, 0.5); l.x = w / 2; l.y = this.regionTop + regionH / 2;
      layer.addChild(l);
      this.maxScroll = 0;
      return;
    }

    // Measure pass: build each row's display object + content-space y, so the total
    // content height is known before settling scrollY (stickBottom pins to latest).
    const built: { node: PIXI.DisplayObject; cy: number; hitFn?: () => void; hitH?: number }[] = [];
    let cy = Math.round(h * 0.012);

    if (this.hasMore) {
      const lbl = txt(t('chat.loadEarlier'), Math.round(h * 0.024), C.accent, true);
      lbl.anchor.set(0.5, 0);
      built.push({ node: lbl, cy, hitFn: () => void this.loadEarlier(), hitH: Math.round(h * 0.04) });
      cy += Math.round(h * 0.05);
    }

    if (this.messages.length === 0) {
      const e = txt(t('chat.empty'), Math.round(h * 0.026), C.mid);
      e.anchor.set(0.5, 0);
      built.push({ node: e, cy: cy + Math.round(h * 0.04) });
      cy += Math.round(h * 0.1);
    } else {
      for (const m of this.messages) {
        const { node, height } = this.buildBubble(m);
        built.push({ node, cy });
        cy += height + Math.round(h * 0.012);
      }
    }

    this.maxScroll = Math.max(0, cy - regionH);
    if (this.stickBottom) this.scrollY = this.maxScroll;
    else if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;

    // Place pass: position each row at the settled scroll.
    for (const b of built) {
      const sy = this.regionTop + b.cy - this.scrollY;
      // Centered single nodes (txt with anchor 0.5,0) want x = w/2; bubbles carry own x.
      if (b.node instanceof PIXI.Text && (b.node.anchor.x === 0.5)) b.node.x = w / 2;
      b.node.y = sy;
      layer.addChild(b.node);
      if (b.hitFn) {
        this.hits.push({ rect: { x: w * 0.2, y: sy - 4, w: w * 0.6, h: b.hitH ?? Math.round(h * 0.04) }, scroll: true, fn: b.hitFn });
      }
    }
  }

  /** Build a message bubble container; returns it + its height (positioned later). */
  private buildBubble(m: ChatMessageView): { node: PIXI.Container; height: number } {
    const { w } = this;
    const mine = m.fromPublicId === this.cb.myPublicId;
    const maxW = Math.round(w * 0.68);
    const padX = Math.round(w * 0.03);
    const padY = Math.round(this.h * 0.012);
    const body = new PIXI.Text(m.body, {
      fontSize: Math.round(this.h * 0.026), fill: mine ? 0xffffff : C.dark,
      fontFamily: 'monospace', wordWrap: true, wordWrapWidth: maxW - padX * 2, breakWords: true,
    });
    const bw = Math.min(maxW, Math.ceil(body.width) + padX * 2);
    const bh = Math.ceil(body.height) + padY * 2;
    const bx = mine ? w - Math.round(w * 0.04) - bw : Math.round(w * 0.04);
    const node = new PIXI.Container();
    node.x = bx;
    const bg = sketchPanel(bw, bh, {
      fill: mine ? C.accent : C.paper, border: mine ? C.accent : C.line, width: 2,
      seed: seedFor(bx, Math.round(m.ts % 9973), bw),
    });
    node.addChild(bg);
    body.x = padX; body.y = padY;
    node.addChild(body);
    return { node, height: bh };
  }

  private drawComposer(): void {
    const { w, h } = this;
    const composeH = Math.round(h * 0.10);
    const cy = h - composeH;
    const bg = new PIXI.Graphics();
    bg.beginFill(C.dark, 0.08); bg.drawRect(0, cy, w, composeH); bg.endFill();
    this.container.addChild(bg);

    const sendW = Math.round(w * 0.2);
    const gap = Math.round(w * 0.03);
    const fieldX = Math.round(w * 0.04);
    const fieldW = w - fieldX * 2 - sendW - gap;
    const fieldH = Math.round(composeH * 0.66);
    const fieldY = cy + (composeH - fieldH) / 2;
    const field = sketchPanel(fieldW, fieldH, { fill: C.paper, border: (this.draft || this.composeFocused) ? C.accent : C.line, width: 2, seed: seedFor(fieldX, 0, fieldW) });
    field.x = fieldX; field.y = fieldY;
    this.container.addChild(field);
    const display = caretDisplay(this.draft, this.composeFocused ? this.caretOn : false, t('chat.placeholder'));
    const ft = txt(display, Math.round(fieldH * 0.4), (this.draft || this.composeFocused) ? C.dark : C.mid);
    ft.anchor.set(0, 0.5); ft.x = fieldX + Math.round(w * 0.025); ft.y = fieldY + fieldH / 2;
    this.container.addChild(ft);
    this.hits.push({ rect: { x: fieldX, y: fieldY, w: fieldW, h: fieldH }, fn: () => this.focusCompose() });

    const enabled = this.draft.trim().length > 0;
    const sx = fieldX + fieldW + gap;
    const sb = sketchPanel(sendW, fieldH, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.light, width: 2, seed: seedFor(sx, 1, sendW) });
    sb.x = sx; sb.y = fieldY;
    this.container.addChild(sb);
    const sl = txt(t('chat.send'), Math.round(fieldH * 0.4), 0xffffff, true);
    sl.anchor.set(0.5, 0.5); sl.x = sx + sendW / 2; sl.y = fieldY + fieldH / 2;
    this.container.addChild(sl);
    this.hits.push({ rect: { x: sx, y: fieldY, w: sendW, h: fieldH }, fn: () => { if (enabled) void this.doSend(); } });
  }

  private drawToast(): void {
    if (!this.toastKey) return;
    const { w, h } = this;
    const label = txt(t(this.toastKey), Math.round(h * 0.026), 0xffffff, true);
    const bw = label.width + Math.round(w * 0.08);
    const bh = label.height + Math.round(h * 0.036);
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.13);
    const bg = sketchPanel(bw, bh, { fill: C.dark, fillAlpha: 0.92, border: C.gold, width: 2, seed: seedFor(bw, bh, 1) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = by + bh / 2;
    this.container.addChild(label);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function sendErrKey(e: unknown): TranslationKey {
  const code = (e as { code?: string } | null)?.code;
  switch (code) {
    case 'NOT_FRIEND': return 'chat.notFriend';
    case 'BLOCKED':    return 'chat.blocked';
    case 'RATE_LIMITED': return 'chat.rateLimited';
    default:           return 'chat.error';
  }
}
