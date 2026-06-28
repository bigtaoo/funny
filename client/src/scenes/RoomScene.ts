import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { NetState } from '../net/NetClient';
import type { PeerDc, RoomError, RoomState, PlayerSlot } from '../net/proto/transport';
import { ProfilePopup } from '../render/ProfilePopup';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';

// ── RoomScene (S1-8) — friendly online room ──────────────────────────────────
//
// A canvas-drawn room flow (create / show code / enter code to join / ready /
// start) wired to NetSession by app.ts. The scene is a thin view: local taps
// fire the action callbacks; inbound server messages arrive via the apply*
// methods (app forwards them from NetSession), which re-render the scene.
//
// View states: idle → (create | codeEntry → join) → connecting → inRoom.
// match_start is handled by app.ts (it swaps to GameScene); the room phase
// COUNTDOWN/IN_MATCH just shows a "starting…" hint until that swap lands.
//
// Copy in the i18n `room.*` namespace. Layout follows LobbyScene (notebook bg).

/**
 * Server room-code charset — MUST stay identical to matchsvc Matchsvc.ts, or the
 * server can hand out a code containing a character the keypad can't type.
 * 10 digits + 11 letters = 21 chars → exactly 3 rows of 7 on the keypad (fits one
 * screen). Letters skip I/O/L so they don't read as 0/1.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
const CODE_LEN = 6;

export interface RoomSceneCallbacks {
  onBack(): void;
  createRoom(): void;
  joinRoom(code: string): void;
  setReady(ready: boolean): void;
  startMatch(): void;
  /** Enter ranked matchmaking queue (S1-R). */
  createRanked(): void;
  /** Cancel ranked search. */
  cancelQueue(): void;
  /** False when no online server is configured → actions surface "unavailable". */
  available: boolean;
  /**
   * Open directly in the ranked searching view (the lobby match button jumped
   * here for real PvP). The actual queue join is driven by app once the gateway
   * connects; this only sets the initial view.
   */
  autoRanked?: boolean;
}

type View = 'idle' | 'codeEntry' | 'connecting' | 'searching' | 'inRoom';

interface Hit { rect: Rect; fn: () => void; }

export class RoomScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: RoomSceneCallbacks;

  private view: View = 'idle';
  /** Sub-label for the connecting spinner. */
  private connectingKey: TranslationKey = 'room.connecting';
  /** 0 = we created (host), 1 = we joined (guest), -1 = not in a room yet. */
  private mySide = -1;
  private roomState: RoomState | null = null;
  private peerDcActive = false;
  private codeChars: string[] = [];

  private toastKey: TranslationKey | null = null;
  private toastT = 0;

  private dotCount = 0;
  private dotsTimer = 0;
  private spinnerText: PIXI.Text | null = null;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  /** Tap-a-slot → view-profile overlay (persists across re-renders, drawn on top). */
  private readonly popup: ProfilePopup;

  constructor(layout: ILayout, input: InputManager, cb: RoomSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.popup = new ProfilePopup(this.w, this.h);
    // Lobby match button → land straight in the ranked searching view (app fires
    // the queue join once the gateway opens). Unavailable → fall through to idle
    // so guardAvailable can surface the "no server" toast on user action.
    if (cb.autoRanked && cb.available) {
      this.view = 'searching';
      this.connectingKey = 'room.searching';
    }
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    // Animate the connecting/searching spinner dots in place (no full re-render).
    if ((this.view === 'connecting' || this.view === 'searching') && this.spinnerText) {
      this.dotsTimer += dt;
      if (this.dotsTimer >= 0.4) {
        this.dotsTimer = 0;
        this.dotCount = (this.dotCount + 1) % 4;
        this.spinnerText.text = t(this.connectingKey) + '.'.repeat(this.dotCount);
      }
    }
    // Auto-dismiss the toast.
    if (this.toastKey) {
      this.toastT -= dt;
      if (this.toastT <= 0) { this.toastKey = null; this.render(); }
    }
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    this.popup.destroy();
  }

  // ── Inbound (app forwards NetSession events here) ─────────────────────────────

  applyRoomState(s: RoomState): void {
    this.roomState = s;
    this.peerDcActive = false;
    this.view = 'inRoom';
    this.render();
  }

  applyRoomError(e: RoomError): void {
    this.toast(roomErrorKey(e.code));
    // A failed create/join/queue drops us back to the idle picker.
    if (this.view === 'connecting' || this.view === 'codeEntry' || this.view === 'searching') {
      this.view = 'idle';
      this.mySide = -1;
    }
    this.render();
  }

  applyPeerDc(_p: PeerDc): void {
    this.peerDcActive = true;
    this.render();
  }

  applyNetState(s: NetState): void {
    if (s === 'reconnecting' && this.view === 'inRoom') {
      this.connectingKey = 'room.reconnecting';
      // Keep inRoom layout but surface a reconnecting banner via peerDc-style line.
      this.peerDcActive = true;
      this.render();
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    // Profile overlay open → its own dim backdrop (PIXI interactive) handles the
    // close tap; ignore the scene hit-list so nothing behind it fires.
    if (this.popup.isOpen) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        hit.fn();
        return;
      }
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private onCreate(): void {
    if (!this.guardAvailable()) return;
    this.mySide = 0;
    this.connectingKey = 'room.creating';
    this.view = 'connecting';
    this.cb.createRoom();
    this.render();
  }

  private onRanked(): void {
    if (!this.guardAvailable()) return;
    this.connectingKey = 'room.searching';
    this.view = 'searching';
    this.cb.createRanked();
    this.render();
  }

  private onCancelSearch(): void {
    this.cb.cancelQueue();
    this.view = 'idle';
    this.mySide = -1;
    this.render();
  }

  private onJoinPressed(): void {
    if (!this.guardAvailable()) return;
    this.codeChars = [];
    this.view = 'codeEntry';
    this.render();
  }

  private onConfirmCode(): void {
    if (this.codeChars.length !== CODE_LEN) return;
    this.mySide = 1;
    this.connectingKey = 'room.joining';
    this.view = 'connecting';
    this.cb.joinRoom(this.codeChars.join(''));
    this.render();
  }

  private onToggleReady(): void {
    const me = this.mySlot();
    this.cb.setReady(!(me?.ready ?? false));
  }

  private onBack(): void {
    if (this.view === 'codeEntry') { this.view = 'idle'; this.render(); return; }
    if (this.view === 'searching') { this.onCancelSearch(); return; }
    this.cb.onBack();
  }

  private guardAvailable(): boolean {
    if (this.cb.available) return true;
    this.toast('room.error.noServer');
    this.render();
    return false;
  }

  private toast(key: TranslationKey): void {
    this.toastKey = key;
    this.toastT = 2.5;
  }

  private mySlot() {
    return this.roomState?.players.find((p) => p.side === this.mySide) ?? null;
  }

  private copyCode(code: string): void {
    try {
      void (navigator as Navigator | undefined)?.clipboard?.writeText(code);
      this.toast('room.copied');
      this.render();
    } catch { /* clipboard unavailable — ignore */ }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    this.container.removeChild(this.popup.container);
    tearDownChildren(this.container);
    this.hits = [];
    this.spinnerText = null;

    this.drawBackground();
    this.drawHeader();

    switch (this.view) {
      case 'idle':       this.drawIdle();       break;
      case 'codeEntry':  this.drawCodeEntry();  break;
      case 'connecting': this.drawConnecting(); break;
      case 'searching':  this.drawSearching();  break;
      case 'inRoom':     this.drawInRoom();     break;
    }

    this.drawToast();

    // Profile overlay stays on top of every re-render (server room_state pushes
    // re-run render()); the popup keeps its own visibility state.
    this.container.addChild(this.popup.container);
  }

  /** Open the view-profile card for a room slot (nickname + public id). */
  private openProfile(slot: PlayerSlot): void {
    this.popup.show({
      name: slot.name || t(slot.side === 0 ? 'room.host' : 'room.guest'),
      publicId: slot.publicId,
      isSelf: slot.side === this.mySide,
    });
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('roombg', this.w, this.h));
  }

  private drawHeader(): void {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('room.title'), { titleSize: Math.round(h * 0.04) });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.onBack() });
  }

  private drawIdle(): void {
    const { w, h } = this;
    const btnW = Math.round(w * 0.62);
    const btnH = Math.round(h * 0.10);
    const btnX = (w - btnW) / 2;
    const gap = Math.round(h * 0.035);
    const y0 = Math.round(h * 0.24);

    // Ranked (primary) → matchmaking queue.
    this.addButton(t('room.ranked'), btnX, y0, btnW, btnH, C.dark, C.green, () => this.onRanked());
    const rankedHint = txt(t('room.rankedDesc'), Math.round(h * 0.02), C.mid);
    rankedHint.anchor.set(0.5, 0); rankedHint.x = w / 2; rankedHint.y = y0 + btnH + Math.round(h * 0.008);
    this.container.addChild(rankedHint);

    const y1 = y0 + btnH + gap + Math.round(h * 0.03);
    this.addButton(t('room.create'), btnX, y1, btnW, btnH, C.dark, C.accent, () => this.onCreate());
    this.addButton(t('room.join'), btnX, y1 + btnH + gap, btnW, btnH, C.dark, C.gold, () => this.onJoinPressed());

    const hint = txt(t('room.share'), Math.round(h * 0.022), C.mid);
    hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = y1 + 2 * btnH + gap + Math.round(h * 0.035);
    this.container.addChild(hint);
  }

  private drawSearching(): void {
    const { w, h } = this;
    const label = txt(t('room.searching'), Math.round(h * 0.034), C.dark, true);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.40;
    this.container.addChild(label);
    this.spinnerText = label;

    const sub = txt(t('room.searchingHint'), Math.round(h * 0.022), C.mid);
    sub.anchor.set(0.5, 0.5); sub.x = w / 2; sub.y = h * 0.40 + Math.round(h * 0.06);
    this.container.addChild(sub);

    const btnW = Math.round(w * 0.5);
    const btnH = Math.round(h * 0.09);
    this.addButton(t('room.cancelSearch'), (w - btnW) / 2, Math.round(h * 0.62), btnW, btnH,
      C.paper, C.red, () => this.onCancelSearch(), C.red);
  }

  private drawConnecting(): void {
    const { w, h } = this;
    const label = txt(t(this.connectingKey), Math.round(h * 0.032), C.dark, true);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.45;
    this.container.addChild(label);
    this.spinnerText = label;
  }

  private drawCodeEntry(): void {
    const { w, h } = this;

    const prompt = txt(t('room.enterCode'), Math.round(h * 0.028), C.dark, true);
    prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = Math.round(h * 0.18);
    this.container.addChild(prompt);

    // Entered-code boxes.
    const boxW = Math.round(w * 0.10);
    const boxH = Math.round(boxW * 1.25);
    const boxGap = Math.round(w * 0.02);
    const rowW = CODE_LEN * boxW + (CODE_LEN - 1) * boxGap;
    const rowX = (w - rowW) / 2;
    const rowY = Math.round(h * 0.23);
    for (let i = 0; i < CODE_LEN; i++) {
      const bx = rowX + i * (boxW + boxGap);
      const g = sketchPanel(boxW, boxH, {
        fill: C.paper, border: this.codeChars[i] ? C.accent : C.line, width: 2, seed: seedFor(i, boxW, boxH),
      });
      g.x = bx; g.y = rowY;
      this.container.addChild(g);
      const ch = this.codeChars[i] ?? '';
      const cl = txt(ch, Math.round(boxH * 0.55), C.dark, true);
      cl.anchor.set(0.5, 0.5); cl.x = bx + boxW / 2; cl.y = rowY + boxH / 2;
      this.container.addChild(cl);
    }

    // Character keypad (7 per row). Cells are square and sized to fit the
    // vertical budget between the code boxes and the bottom action row, so the
    // grid never overflows / pushes the actions off-screen in landscape.
    const perRow = 7;
    const rows = Math.ceil(CODE_ALPHABET.length / perRow);
    const kY = Math.round(h * 0.40);
    const kGap = Math.round(w * 0.015);
    const aH = Math.round(h * 0.08);            // bottom action row height (mirrors below)
    const gapBeforeAction = Math.round(h * 0.02);
    const bottomMargin = Math.round(h * 0.04);
    const vBudget = h - kY - gapBeforeAction - aH - bottomMargin;
    const cellByW = (w * 0.84 - (perRow - 1) * kGap) / perRow;
    const cellByH = vBudget / rows - kGap;
    const kW = Math.floor(Math.min(cellByW, cellByH));
    const kH = kW;
    const kX0 = (w - (perRow * kW + (perRow - 1) * kGap)) / 2;
    for (let i = 0; i < CODE_ALPHABET.length; i++) {
      const ch = CODE_ALPHABET[i]!;
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const kx = kX0 + c * (kW + kGap);
      const ky = kY + r * (kH + kGap);
      this.addButton(ch, kx, ky, kW, kH, C.paper, C.line, () => {
        if (this.codeChars.length < CODE_LEN) { this.codeChars.push(ch); this.render(); }
      }, C.dark, Math.round(kH * 0.42));
    }

    // Bottom action row: clear / backspace / confirm.
    const aY = kY + rows * (kH + kGap) + gapBeforeAction;
    const aGap = Math.round(w * 0.03);
    const aW = Math.round((w * 0.84 - 2 * aGap) / 3);
    const aX0 = (w - (3 * aW + 2 * aGap)) / 2;

    this.addButton(t('room.clear'), aX0, aY, aW, aH, C.paper, C.mid, () => {
      this.codeChars = []; this.render();
    }, C.dark, Math.round(aH * 0.32));
    this.addButton('⌫', aX0 + aW + aGap, aY, aW, aH, C.paper, C.mid, () => {
      this.codeChars.pop(); this.render();
    }, C.dark, Math.round(aH * 0.40));
    const ready = this.codeChars.length === CODE_LEN;
    this.addButton(t('room.confirm'), aX0 + 2 * (aW + aGap), aY, aW, aH,
      ready ? C.dark : C.btnOff, ready ? C.gold : C.light,
      () => this.onConfirmCode(), 0xffffff, Math.round(aH * 0.32));
  }

  private drawInRoom(): void {
    const { w, h } = this;
    const code = this.roomState?.code ?? '';

    // Room code + copy.
    const codeLabel = txt(t('room.roomCode'), Math.round(h * 0.024), C.mid);
    codeLabel.anchor.set(0.5, 0); codeLabel.x = w / 2; codeLabel.y = Math.round(h * 0.17);
    this.container.addChild(codeLabel);

    const codeText = txt(code.split('').join(' '), Math.round(h * 0.06), C.dark, true);
    codeText.anchor.set(0.5, 0); codeText.x = w / 2; codeText.y = Math.round(h * 0.205);
    this.container.addChild(codeText);

    const copyW = Math.round(w * 0.34);
    const copyH = Math.round(h * 0.06);
    this.addButton(t('room.copy'), (w - copyW) / 2, Math.round(h * 0.30), copyW, copyH,
      C.paper, C.accent, () => this.copyCode(code), C.accent, Math.round(copyH * 0.40));

    // Player slots (side 0 then side 1).
    const slotW = Math.round(w * 0.78);
    const slotH = Math.round(h * 0.10);
    const slotX = (w - slotW) / 2;
    const slotY0 = Math.round(h * 0.42);
    const slotGap = Math.round(h * 0.03);
    this.drawSlot(0, slotX, slotY0, slotW, slotH);
    this.drawSlot(1, slotX, slotY0 + slotH + slotGap, slotW, slotH);

    // Peer-disconnected / reconnecting banner.
    if (this.peerDcActive) {
      const banner = txt(t('room.peerDc'), Math.round(h * 0.024), C.red, true);
      banner.anchor.set(0.5, 0.5); banner.x = w / 2; banner.y = slotY0 + 2 * slotH + slotGap + Math.round(h * 0.05);
      this.container.addChild(banner);
    }

    // Bottom action: ready toggle (+ host start).
    const me = this.mySlot();
    const myReady = me?.ready ?? false;
    const btnW = Math.round(w * 0.62);
    const btnH = Math.round(h * 0.09);
    const btnX = (w - btnW) / 2;
    const btnY = Math.round(h * 0.74);

    this.addButton(myReady ? t('room.cancelReady') : t('room.ready'), btnX, btnY, btnW, btnH,
      myReady ? C.paper : C.green, myReady ? C.mid : C.green,
      () => this.onToggleReady(), myReady ? C.dark : 0xffffff);

    const players = this.roomState?.players ?? [];
    const bothReady = players.length === 2 && players.every((p) => p.ready && p.connected);
    if (this.mySide === 0) {
      const sY = btnY + btnH + Math.round(h * 0.025);
      this.addButton(t('room.start'), btnX, sY, btnW, btnH,
        bothReady ? C.dark : C.btnOff, bothReady ? C.gold : C.light,
        () => { if (bothReady) this.cb.startMatch(); }, 0xffffff);
    } else {
      const wait = txt(t('room.waitingHost'), Math.round(h * 0.022), C.mid);
      wait.anchor.set(0.5, 0); wait.x = w / 2; wait.y = btnY + btnH + Math.round(h * 0.03);
      this.container.addChild(wait);
    }
  }

  private drawSlot(side: number, x: number, y: number, w: number, h: number): void {
    const slot = this.roomState?.players.find((p) => p.side === side) ?? null;
    const isMe = side === this.mySide;
    const accent = side === 0 ? C.accent : C.red;

    const bg = sketchPanel(w, h, {
      fill: C.paper, fillAlpha: slot ? 1 : 0.6, border: slot ? accent : C.light, width: 2, seed: seedFor(side, w, h),
    });
    bg.x = x; bg.y = y;
    sketchAccentBar(bg, h, accent, seedFor(side, h, accent));
    this.container.addChild(bg);

    // Occupied slot → tappable to open its profile card.
    if (slot) {
      this.hits.push({ rect: { x, y, w, h }, fn: () => this.openProfile(slot) });
    }

    // Always show the nickname (displayName); accountId is never player-facing.
    // The 9-digit public id sits beneath it for player-to-player reference / 投诉.
    const roleKey: TranslationKey = side === 0 ? 'room.host' : 'room.guest';
    const name = slot ? (slot.name || t(roleKey)) : t('room.empty');
    const hasId = !!slot?.publicId;
    const nameY = hasId ? y + h * 0.38 : y + h / 2;
    const nameTxt = txt(name, Math.round(h * 0.32), slot ? C.dark : C.mid, true);
    nameTxt.anchor.set(0, 0.5); nameTxt.x = x + Math.round(w * 0.06); nameTxt.y = nameY;
    this.container.addChild(nameTxt);

    if (slot && hasId) {
      const idLabel = `#${slot.publicId}${isMe ? ' · ' + t('room.you') : ''}`;
      const idTxt = txt(idLabel, Math.round(h * 0.2), C.mid, false);
      idTxt.anchor.set(0, 0.5); idTxt.x = x + Math.round(w * 0.06); idTxt.y = y + h * 0.68;
      this.container.addChild(idTxt);
    } else if (slot && isMe) {
      // No id yet (server didn't supply one) — still mark which slot is me.
      const meTxt = txt(t('room.you'), Math.round(h * 0.2), C.mid, false);
      meTxt.anchor.set(0, 0.5); meTxt.x = x + Math.round(w * 0.06); meTxt.y = y + h * 0.68;
      this.container.addChild(meTxt);
    }

    if (slot) {
      const statusKey: TranslationKey = slot.ready ? 'room.statusReady' : 'room.statusNotReady';
      const status = txt(t(statusKey), Math.round(h * 0.28), slot.ready ? C.green : C.mid, true);
      status.anchor.set(1, 0.5); status.x = x + w - Math.round(w * 0.05); status.y = y + h / 2;
      this.container.addChild(status);
    }
  }

  private drawToast(): void {
    if (!this.toastKey) return;
    const { w, h } = this;
    const msg = t(this.toastKey);
    const label = txt(msg, Math.round(h * 0.026), 0xffffff, true);
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.018);
    const bw = label.width + padX * 2;
    const bh = label.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.135);
    const bg = sketchPanel(bw, bh, { fill: C.red, fillAlpha: 0.92, border: C.red, width: 2, seed: seedFor(bw, bh, 1) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = by + bh / 2;
    this.container.addChild(label);
  }

  /** Draw a rounded button and register its hit rect. */
  private addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void,
    textColor = 0xffffff, fontSize?: number,
  ): void {
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x; g.y = y;
    this.container.addChild(g);

    const tl = txt(label, fontSize ?? Math.round(h * 0.36), textColor, true);
    tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
    this.container.addChild(tl);

    this.hits.push({ rect: { x, y, w, h }, fn });
  }
}

// ── Server RoomError.code → i18n key ───────────────────────────────────────────

function roomErrorKey(code: string): TranslationKey {
  switch (code) {
    case 'ROOM_NOT_FOUND':     return 'room.error.notFound';
    case 'ROOM_FULL':          return 'room.error.full';
    case 'ALREADY_IN_ROOM':    return 'room.error.alreadyIn';
    case 'RANKED_UNAVAILABLE': return 'room.error.ranked';
    default:                   return 'room.error.generic';
  }
}
