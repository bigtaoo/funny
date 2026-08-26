import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { NetState } from '../net/NetClient';
import type { PeerDc, RoomError, RoomState, PlayerSlot } from '../net/proto/transport';
import { ProfilePopup } from '../ui/dialogs/ProfilePopup';
import { buildPaperBackground, tearDownChildren } from '../render/sketchUi';
import { showToastMessage, type ToastKind } from '../net/log';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { CODE_LEN, type RoomSceneCallbacks, type View, type Hit } from './RoomScene/types';
import { drawIdle, drawSearching, drawConnecting, drawCodeEntry, drawInRoom, type RoomViewHost } from './RoomScene/views';

export { CODE_ALPHABET } from './RoomScene/types';
export type { RoomSceneCallbacks } from './RoomScene/types';

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
//
// 2026-08-13: the five per-view draw functions (idle/searching/connecting/codeEntry/inRoom) +
// drawSlot/addButton were pulled out into RoomScene/views.ts as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — this file kept scene lifecycle, the
// server-push apply* handlers, input routing, and the action methods those views call back into.

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

  private dotCount = 0;
  private dotsTimer = 0;
  private spinnerText: PIXI.Text | null = null;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late inbound net push (applyRoomState/…) can't paint into a torn-down container. */
  private destroyed = false;

  /** Tap-a-slot → view-profile overlay (persists across re-renders, drawn on top). */
  private readonly popup: ProfilePopup;

  constructor(layout: ILayout, input: InputManager, cb: RoomSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.popup = new ProfilePopup(this.w, this.h, cb.getProfileExtra);
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
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.popup.destroy();
    this.container.destroy({ children: true });
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
    } else if (s === 'disconnected') {
      // Permanent rejection (control-plane WS gave up retrying) — unlike 'reconnecting', this
      // will never resolve on its own. Drop back to idle instead of leaving the player parked
      // on a room/queue view that can no longer receive any server messages (2026-08-03 fix,
      // mirrors GameScene's new setDisconnected handling for the in-match connection).
      this.toast('reconnect.gone');
      this.view = 'idle';
      this.mySide = -1;
      this.peerDcActive = false;
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

  private toast(key: TranslationKey, kind: ToastKind = 'error'): void {
    showToastMessage(t(key), kind);
  }

  private mySlot() {
    return this.roomState?.players.find((p) => p.side === this.mySide) ?? null;
  }

  private copyCode(code: string): void {
    try {
      void (navigator as Navigator | undefined)?.clipboard?.writeText(code);
      this.toast('room.copied', 'success');
    } catch { /* clipboard unavailable — ignore */ }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    this.container.removeChild(this.popup.container);
    tearDownChildren(this.container);
    this.hits = [];
    this.spinnerText = null;

    this.drawBackground();
    this.drawHeader();

    const host = this.viewHost();
    switch (this.view) {
      case 'idle':       drawIdle(host);                          break;
      case 'codeEntry':  drawCodeEntry(host);                     break;
      case 'connecting': drawConnecting(host, this.connectingKey); break;
      case 'searching':  drawSearching(host);                     break;
      case 'inRoom':     drawInRoom(host);                        break;
    }

    // Profile overlay stays on top of every re-render (server room_state pushes
    // re-run render()); the popup keeps its own visibility state.
    this.container.addChild(this.popup.container);
  }

  /** Bundles what views.ts's draw functions need instead of them closing over `this`. */
  private viewHost(): RoomViewHost {
    const scene = this;
    return {
      container: this.container, w: this.w, h: this.h, cb: this.cb,
      roomState: this.roomState, mySide: this.mySide, peerDcActive: this.peerDcActive,
      get hits() { return scene.hits; },
      set hits(v) { scene.hits = v; },
      get codeChars() { return scene.codeChars; },
      set codeChars(v) { scene.codeChars = v; },
      get spinnerText() { return scene.spinnerText; },
      set spinnerText(v) { scene.spinnerText = v; },
      render: () => this.render(),
      onCreate: () => this.onCreate(),
      onRanked: () => this.onRanked(),
      onCancelSearch: () => this.onCancelSearch(),
      onJoinPressed: () => this.onJoinPressed(),
      onConfirmCode: () => this.onConfirmCode(),
      onToggleReady: () => this.onToggleReady(),
      copyCode: (code: string) => this.copyCode(code),
      openProfile: (slot: PlayerSlot) => this.openProfile(slot),
    };
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
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): void {
    const { w, h } = this;
    // Ranked matchmaking reuses the achievement wall's PvP glyph (crossed swords). The friend-room
    // view has no matching AI icon yet — it's on the batch-5 list, so it stays icon-less for now
    // rather than borrowing a picture that means something else.
    const ranked = this.view === 'searching';
    const hdr = drawSceneHeader(this.container, w, h, t(ranked ? 'room.rankedTitle' : 'room.title'), { icon: ranked ? 'pvpTabIcon' : 'roomTabIcon' });
    this.hits.push({ rect: hdr.backRect, fn: () => this.onBack() });
  }
}

// ── Server RoomError.code → i18n key ───────────────────────────────────────────

function roomErrorKey(code: string): TranslationKey {
  switch (code) {
    case 'ROOM_NOT_FOUND':     return 'room.error.notFound';
    case 'ROOM_FULL':          return 'room.error.full';
    case 'ALREADY_IN_ROOM':    return 'room.error.alreadyIn';
    case 'RANKED_UNAVAILABLE': return 'room.error.ranked';
    // matchsvc restart-safety (matchsvc-prematch-persist, 2026-07-29): synthesized locally by
    // NetSession from a prematch_lost push, not a real server RoomError.code.
    case 'PREMATCH_LOST':      return 'room.error.prematchLost';
    default:                   return 'room.error.generic';
  }
}
