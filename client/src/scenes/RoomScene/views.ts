// RoomScene's per-view draw functions (idle/searching/connecting/codeEntry/inRoom + the shared
// addButton/drawSlot helpers), extracted as form① free functions (claudedocs/client-modules.md
// "单文件 500 行收敛"). Each takes a narrow `RoomViewHost` — the scene fields/methods these views
// actually touch — instead of closing over `this`; `codeChars`/`spinnerText` are exposed as
// getter/setter pairs (not plain properties) because the keypad's Clear button and the
// searching/connecting spinner both reassign them wholesale, and a plain copied property would
// only rebind this throwaway host object, never reaching back to the scene's own field (same
// reasoning as SettingsScene/avatarPicker.ts's PickerHost).
import * as PIXI from 'pixi.js-legacy';
import { Rect } from '../../layout/ILayout';
import { t, TranslationKey } from '../../i18n';
import type { RoomState, PlayerSlot } from '../../net/proto/transport';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { CODE_ALPHABET, CODE_LEN, type RoomSceneCallbacks, type Hit } from './types';

export interface RoomViewHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: RoomSceneCallbacks;
  readonly roomState: RoomState | null;
  readonly mySide: number;
  readonly peerDcActive: boolean;
  hits: Hit[];
  codeChars: string[];
  spinnerText: PIXI.Text | null;
  render(): void;
  onCreate(): void;
  onRanked(): void;
  onCancelSearch(): void;
  onJoinPressed(): void;
  onConfirmCode(): void;
  onToggleReady(): void;
  copyCode(code: string): void;
  openProfile(slot: PlayerSlot): void;
}

/** Draw a rounded button and register its hit rect. */
export function addButton(
  host: RoomViewHost,
  label: string, x: number, y: number, w: number, h: number,
  fill: number, stroke: number, fn: () => void,
  textColor = 0xffffff, fontSize?: number,
): void {
  const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
  g.x = x; g.y = y;
  host.container.addChild(g);

  const tl = txt(label, snapFont(fontSize ?? Math.round(h * 0.36)), textColor, true);
  tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
  host.container.addChild(tl);

  host.hits.push({ rect: { x, y, w, h }, fn });
}

export function drawIdle(host: RoomViewHost): void {
  const { w, h } = host;
  const btnW = Math.round(w * 0.62);
  const btnH = Math.round(h * 0.10);
  const btnX = (w - btnW) / 2;
  const gap = Math.round(h * 0.035);
  const y0 = Math.round(h * 0.24);

  // Ranked (primary) → matchmaking queue.
  addButton(host, t('room.ranked'), btnX, y0, btnW, btnH, C.dark, C.green, () => host.onRanked());
  const rankedHint = txt(t('room.rankedDesc'), FS.label, C.mid);
  rankedHint.anchor.set(0.5, 0); rankedHint.x = w / 2; rankedHint.y = y0 + btnH + Math.round(h * 0.008);
  host.container.addChild(rankedHint);

  const y1 = y0 + btnH + gap + Math.round(h * 0.03);
  addButton(host, t('room.create'), btnX, y1, btnW, btnH, C.dark, C.accent, () => host.onCreate());
  addButton(host, t('room.join'), btnX, y1 + btnH + gap, btnW, btnH, C.dark, C.gold, () => host.onJoinPressed());

  const hint = txt(t('room.share'), FS.label, C.mid);
  hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = y1 + 2 * btnH + gap + Math.round(h * 0.035);
  host.container.addChild(hint);
}

export function drawSearching(host: RoomViewHost): void {
  const { w, h } = host;
  const label = txt(t('room.searching'), FS.headline, C.dark, true);
  label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.40;
  host.container.addChild(label);
  host.spinnerText = label;

  const sub = txt(t('room.searchingHint'), FS.label, C.mid);
  sub.anchor.set(0.5, 0.5); sub.x = w / 2; sub.y = h * 0.40 + Math.round(h * 0.06);
  host.container.addChild(sub);

  const btnW = Math.round(w * 0.5);
  const btnH = Math.round(h * 0.09);
  addButton(host, t('room.cancelSearch'), (w - btnW) / 2, Math.round(h * 0.62), btnW, btnH,
    C.paper, C.red, () => host.onCancelSearch(), C.red);
}

export function drawConnecting(host: RoomViewHost, connectingKey: TranslationKey): void {
  const { w, h } = host;
  const label = txt(t(connectingKey), FS.title, C.dark, true);
  label.anchor.set(0.5, 0.5); label.x = w / 2; label.y = h * 0.45;
  host.container.addChild(label);
  host.spinnerText = label;
}

export function drawCodeEntry(host: RoomViewHost): void {
  const { w, h } = host;

  const prompt = txt(t('room.enterCode'), FS.title, C.dark, true);
  prompt.anchor.set(0.5, 0.5); prompt.x = w / 2; prompt.y = Math.round(h * 0.18);
  host.container.addChild(prompt);

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
      fill: C.paper, border: host.codeChars[i] ? C.accent : C.line, width: 2, seed: seedFor(i, boxW, boxH),
    });
    g.x = bx; g.y = rowY;
    host.container.addChild(g);
    const ch = host.codeChars[i] ?? '';
    const cl = txt(ch, snapFont(Math.round(boxH * 0.55)), C.dark, true);
    cl.anchor.set(0.5, 0.5); cl.x = bx + boxW / 2; cl.y = rowY + boxH / 2;
    host.container.addChild(cl);
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
    addButton(host, ch, kx, ky, kW, kH, C.paper, C.line, () => {
      if (host.codeChars.length < CODE_LEN) { host.codeChars.push(ch); host.render(); }
    }, C.dark, Math.round(kH * 0.42));
  }

  // Bottom action row: clear / backspace / confirm.
  const aY = kY + rows * (kH + kGap) + gapBeforeAction;
  const aGap = Math.round(w * 0.03);
  const aW = Math.round((w * 0.84 - 2 * aGap) / 3);
  const aX0 = (w - (3 * aW + 2 * aGap)) / 2;

  addButton(host, t('room.clear'), aX0, aY, aW, aH, C.paper, C.mid, () => {
    host.codeChars = []; host.render();
  }, C.dark, Math.round(aH * 0.32));
  addButton(host, '⌫', aX0 + aW + aGap, aY, aW, aH, C.paper, C.mid, () => {
    host.codeChars.pop(); host.render();
  }, C.dark, Math.round(aH * 0.40));
  const ready = host.codeChars.length === CODE_LEN;
  addButton(host, t('room.confirm'), aX0 + 2 * (aW + aGap), aY, aW, aH,
    ready ? C.dark : C.btnOff, ready ? C.gold : C.light,
    () => host.onConfirmCode(), 0xffffff, Math.round(aH * 0.32));
}

export function drawInRoom(host: RoomViewHost): void {
  const { w, h } = host;
  const code = host.roomState?.code ?? '';

  // Room code + copy.
  const codeLabel = txt(t('room.roomCode'), FS.heading, C.mid);
  codeLabel.anchor.set(0.5, 0); codeLabel.x = w / 2; codeLabel.y = Math.round(h * 0.17);
  host.container.addChild(codeLabel);

  const codeText = txt(code.split('').join(' '), FS.display, C.dark, true);
  codeText.anchor.set(0.5, 0); codeText.x = w / 2; codeText.y = Math.round(h * 0.205);
  host.container.addChild(codeText);

  const copyW = Math.round(w * 0.34);
  const copyH = Math.round(h * 0.06);
  addButton(host, t('room.copy'), (w - copyW) / 2, Math.round(h * 0.30), copyW, copyH,
    C.paper, C.accent, () => host.copyCode(code), C.accent, Math.round(copyH * 0.40));

  // Player slots (side 0 then side 1).
  const slotW = Math.round(w * 0.78);
  const slotH = Math.round(h * 0.10);
  const slotX = (w - slotW) / 2;
  const slotY0 = Math.round(h * 0.42);
  const slotGap = Math.round(h * 0.03);
  drawSlot(host, 0, slotX, slotY0, slotW, slotH);
  drawSlot(host, 1, slotX, slotY0 + slotH + slotGap, slotW, slotH);

  // Peer-disconnected / reconnecting banner.
  if (host.peerDcActive) {
    const banner = txt(t('room.peerDc'), FS.heading, C.red, true);
    banner.anchor.set(0.5, 0.5); banner.x = w / 2; banner.y = slotY0 + 2 * slotH + slotGap + Math.round(h * 0.05);
    host.container.addChild(banner);
  }

  // Bottom action: ready toggle (+ host start).
  const me = host.roomState?.players.find((p) => p.side === host.mySide) ?? null;
  const myReady = me?.ready ?? false;
  const btnW = Math.round(w * 0.62);
  const btnH = Math.round(h * 0.09);
  const btnX = (w - btnW) / 2;
  const btnY = Math.round(h * 0.74);

  addButton(host, myReady ? t('room.cancelReady') : t('room.ready'), btnX, btnY, btnW, btnH,
    myReady ? C.paper : C.green, myReady ? C.mid : C.green,
    () => host.onToggleReady(), myReady ? C.dark : 0xffffff);

  const players = host.roomState?.players ?? [];
  const bothReady = players.length === 2 && players.every((p) => p.ready && p.connected);
  if (host.mySide === 0) {
    const sY = btnY + btnH + Math.round(h * 0.025);
    addButton(host, t('room.start'), btnX, sY, btnW, btnH,
      bothReady ? C.dark : C.btnOff, bothReady ? C.gold : C.light,
      () => { if (bothReady) host.cb.startMatch(); }, 0xffffff);
  } else {
    const wait = txt(t('room.waitingHost'), FS.label, C.mid);
    wait.anchor.set(0.5, 0); wait.x = w / 2; wait.y = btnY + btnH + Math.round(h * 0.03);
    host.container.addChild(wait);
  }
}

function drawSlot(host: RoomViewHost, side: number, x: number, y: number, w: number, h: number): void {
  const slot = host.roomState?.players.find((p) => p.side === side) ?? null;
  const isMe = side === host.mySide;
  const accent = side === 0 ? C.accent : C.red;

  const bg = sketchPanel(w, h, {
    fill: C.paper, fillAlpha: slot ? 1 : 0.6, border: slot ? accent : C.light, width: 2, seed: seedFor(side, w, h),
  });
  bg.x = x; bg.y = y;
  sketchAccentBar(bg, h, accent, seedFor(side, h, accent));
  host.container.addChild(bg);

  // Occupied slot → tappable to open its profile card.
  if (slot) {
    host.hits.push({ rect: { x, y, w, h }, fn: () => host.openProfile(slot) });
  }

  // Always show the nickname (displayName); accountId is never player-facing.
  // The 9-digit public id sits beneath it for player-to-player reference / reporting.
  const roleKey: TranslationKey = side === 0 ? 'room.host' : 'room.guest';
  const name = slot ? (slot.name || t(roleKey)) : t('room.empty');
  const hasId = !!slot?.publicId;
  const nameY = hasId ? y + h * 0.38 : y + h / 2;
  const nameTxt = txt(name, snapFont(Math.round(h * 0.32)), slot ? C.dark : C.mid, true);
  nameTxt.anchor.set(0, 0.5); nameTxt.x = x + Math.round(w * 0.06); nameTxt.y = nameY;
  host.container.addChild(nameTxt);

  if (slot && hasId) {
    const idLabel = `#${slot.publicId}${isMe ? ' · ' + t('room.you') : ''}`;
    const idTxt = txt(idLabel, snapFont(Math.round(h * 0.2)), C.mid, false);
    idTxt.anchor.set(0, 0.5); idTxt.x = x + Math.round(w * 0.06); idTxt.y = y + h * 0.68;
    host.container.addChild(idTxt);
  } else if (slot && isMe) {
    // No id yet (server didn't supply one) — still mark which slot is me.
    const meTxt = txt(t('room.you'), snapFont(Math.round(h * 0.2)), C.mid, false);
    meTxt.anchor.set(0, 0.5); meTxt.x = x + Math.round(w * 0.06); meTxt.y = y + h * 0.68;
    host.container.addChild(meTxt);
  }

  if (slot) {
    const statusKey: TranslationKey = slot.ready ? 'room.statusReady' : 'room.statusNotReady';
    const status = txt(t(statusKey), snapFont(Math.round(h * 0.28)), slot.ready ? C.green : C.mid, true);
    status.anchor.set(1, 0.5); status.x = x + w - Math.round(w * 0.05); status.y = y + h / 2;
    host.container.addChild(status);
  }
}
