// SettingsScene's profile/language/help/account panels, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — each takes a narrow `PanelHost` (the
// handful of SettingsScene fields/methods actually used, made public for this) instead of closing
// over `this`. Mirrors StatsScene/panels.ts / ResultScene/builders.ts's precedent.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { SketchPen } from '../../render/sketch';
import { ui as C } from '../../render/sketchUi';
import { t, getLocale, setLocale, getSupportedLocales, Locale, TranslationKey } from '../../i18n';
import { FS, snapFont } from '../../render/fontScale';
import { buildAvatar } from '../../render/avatar';
import type { SettingsSceneCallbacks, Hit } from './types';
import { isDataSaverEnabled, setDataSaverEnabled } from '../../assets/prefetchPolicy';

const LOCALE_LABEL: Record<Locale, string> = { zh: '中文', en: 'English', de: 'Deutsch' };

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return makeText(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/** What the panels below need out of SettingsScene — a narrow, mostly-read-only slice. */
export interface PanelHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: SettingsSceneCallbacks;
  readonly playerName: string;
  readonly currentAvatarId: string | undefined;
  readonly busy: boolean;
  hits: Hit[];
  render(): void;
  openAvatarPicker(): void;
  openRename(): void;
  openDelete(): void;
}

/** A dark button with a hand-drawn border. `fn = null` → disabled (greyed, inert). */
export function addButton(host: PanelHost, label: string, y: number, border: number, fn: (() => void) | null, width?: number, x?: number): void {
  const { w, h } = host;
  const btnW = width ?? Math.round(w * 0.5);
  const btnH = Math.round(h * 0.07);
  const bx = x ?? Math.round(w * 0.12);
  const enabled = fn !== null;
  const box = new PIXI.Graphics();
  box.beginFill(enabled ? C.dark : 0xbbbbbb);
  box.drawRect(0, 0, btnW, btnH);
  box.endFill();
  box.alpha = enabled ? 1 : 0.6;
  new SketchPen(box, 91).rect(2, 2, btnW - 4, btnH - 4, { color: border, width: 2.6, jitter: 1.0 });
  box.x = bx; box.y = y;
  host.container.addChild(box);

  const lbl = txt(label, snapFont(Math.round(btnH * 0.34)), 0xffffff, true);
  lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = y + btnH / 2;
  lbl.alpha = enabled ? 1 : 0.6;
  host.container.addChild(lbl);

  if (enabled) host.hits.push({ rect: { x: bx, y, w: btnW, h: btnH }, fn });
}

export function drawProfile(host: PanelHost, tbH: number): void {
  const { w, h, container, cb, playerName, currentAvatarId } = host;
  const cardX = Math.round(w * 0.12);
  const cardY = tbH + Math.round(h * 0.05);
  const av = Math.round(h * 0.12);

  const avatar = buildAvatar(av, playerName, 21, currentAvatarId);
  avatar.x = cardX; avatar.y = cardY;
  container.addChild(avatar);

  // Tapping the avatar opens the picker. A small pencil badge hints it's editable;
  // only shown when picking is enabled (onSetAvatar present).
  if (cb.onSetAvatar) {
    const badgeR = Math.round(av * 0.16);
    const bcx = cardX + av - badgeR, bcy = cardY + av - badgeR;
    const badge = new PIXI.Graphics();
    badge.beginFill(C.accent); badge.drawCircle(bcx, bcy, badgeR); badge.endFill();
    container.addChild(badge);
    const pencil = txt('✎', snapFont(Math.round(badgeR * 1.4)), 0xffffff, true);
    pencil.anchor.set(0.5, 0.5); pencil.x = bcx; pencil.y = bcy;
    container.addChild(pencil);
    host.hits.push({ rect: { x: cardX, y: cardY, w: av, h: av }, fn: () => host.openAvatarPicker() });
  }

  const nameX = cardX + av + Math.round(w * 0.04);
  const hasId = !!cb.publicId;
  const hasRank = !cb.offline && !!cb.pvp;
  // Stack name / #id / rank vertically next to the avatar; top line rises when
  // there are more lines so the block stays vertically centred on the avatar.
  const nameY = cardY + av * (hasId || hasRank ? 0.28 : 0.34);
  const name = txt(playerName, FS.headline, C.dark, true);
  name.anchor.set(0, 0.5); name.x = nameX; name.y = nameY;
  container.addChild(name);

  if (hasId) {
    // Display-only public id (#123456789); the uuid stays server-internal.
    const idLine = txt(t('settings.playerId', { id: cb.publicId! }), FS.heading, C.mid);
    idLine.anchor.set(0, 0.5); idLine.x = nameX; idLine.y = cardY + av * 0.56;
    container.addChild(idLine);
  }

  if (hasRank) {
    const pvp = cb.pvp!;
    const rankName = t(('rank.' + pvp.rank) as TranslationKey);
    const sub = pvp.rank === 'unranked' ? rankName : `${rankName} · ${pvp.elo}`;
    const rank = txt(sub, FS.heading, C.gold, true);
    rank.anchor.set(0, 0.5); rank.x = nameX; rank.y = cardY + av * (hasId ? 0.82 : 0.68);
    container.addChild(rank);
  }

  // Rename button (online only). Free first rename for players who never chose a name; otherwise
  // shows the coin cost and is disabled if the balance is short.
  if (cb.onRename && cb.renameCost != null) {
    const cost = cb.renameCost;
    const free = cb.freeRename === true;
    const coins = cb.getCoins?.() ?? 0;
    const enabled = (free || coins >= cost) && !host.busy;
    const btnY = cardY + av + Math.round(h * 0.02);
    const label = free ? t('settings.renameFree') : t('settings.rename', { cost });
    addButton(host, label, btnY, enabled ? C.accent : C.light, enabled ? () => host.openRename() : null, Math.round(w * 0.46));

    // Free rename: show a hint instead of the balance line.
    const sub = free ? t('settings.renameFreeHint') : t('settings.coins', { coins });
    const bal = txt(sub, FS.label, C.mid);
    bal.anchor.set(0, 0.5); bal.x = cardX; bal.y = btnY + Math.round(h * 0.07) + Math.round(h * 0.022);
    container.addChild(bal);
  }
}

export function drawLanguage(host: PanelHost): void {
  const { w, h, container } = host;
  const secY = Math.round(h * 0.48);
  const label = txt(t('settings.language'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = Math.round(w * 0.12); label.y = secY;
  container.addChild(label);

  const locales = getSupportedLocales();
  const btnH = Math.round(h * 0.062);
  const gap  = Math.round(w * 0.03);
  const btnW = Math.round(w * 0.22);
  const startX = Math.round(w * 0.12);
  const btnY = secY + Math.round(h * 0.045);
  const active = getLocale();

  locales.forEach((loc, i) => {
    const bx = startX + i * (btnW + gap);
    const on = loc === active;
    const box = new PIXI.Graphics();
    box.beginFill(on ? C.accent : C.paper);
    box.drawRect(0, 0, btnW, btnH);
    box.endFill();
    new SketchPen(box, 71 + i).rect(2, 2, btnW - 4, btnH - 4, {
      color: on ? C.gold : C.dark, width: on ? 2.8 : 2, jitter: 1.0,
    });
    box.x = bx; box.y = btnY;
    container.addChild(box);

    const lbl = txt(LOCALE_LABEL[loc], snapFont(Math.round(btnH * 0.36)), on ? 0xffffff : C.dark, on);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = btnY + btnH / 2;
    container.addChild(lbl);

    if (!on) {
      host.hits.push({
        rect: { x: bx, y: btnY, w: btnW, h: btnH },
        fn: () => { setLocale(loc); host.render(); },
      });
    }
  });
}

/**
 * Data saver (ASSET_PACKAGING §14). The player-owned half of "don't spend my bandwidth
 * speculatively" — the automatic half (`prefetchPolicy.shouldSkipPrefetch`) can only read
 * `navigator.connection`, which is Chromium-only and therefore absent on iOS Safari, Firefox and
 * inside every iOS in-app browser. Rather than guess the link there (throughput would answer the
 * wrong question — a fast LTE link is fast AND metered), this just lets the player say so. Works
 * on every platform, needs no API, and cannot be wrong.
 *
 * Laid out as label + toggle on ONE row, unlike the sections around it: it sits in the gap between
 * the language buttons (bottom ≈ 0.587h) and the Help/Account labels (0.73h), and a stacked
 * label-over-button block does not fit there without pushing the rest of the screen around.
 */
export function drawDataSaver(host: PanelHost): void {
  const { w, h, container } = host;
  const rowY = Math.round(h * 0.635);
  const label = txt(t('settings.dataSaver'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = Math.round(w * 0.12); label.y = rowY;
  container.addChild(label);

  const on = isDataSaverEnabled();
  // Matches the language row's button metrics so the two read as the same kind of control.
  const btnW = Math.round(w * 0.22);
  const btnH = Math.round(h * 0.062);
  const bx = Math.round(w * 0.62);
  const by = rowY - Math.round(btnH / 2);

  const box = new PIXI.Graphics();
  box.beginFill(on ? C.accent : C.paper);
  box.drawRect(0, 0, btnW, btnH);
  box.endFill();
  new SketchPen(box, 83).rect(2, 2, btnW - 4, btnH - 4, {
    color: on ? C.gold : C.dark, width: on ? 2.8 : 2, jitter: 1.0,
  });
  box.x = bx; box.y = by;
  container.addChild(box);

  const lbl = txt(t(on ? 'settings.dataSaverOn' : 'settings.dataSaverOff'), snapFont(Math.round(btnH * 0.36)), on ? 0xffffff : C.dark, on);
  lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = by + btnH / 2;
  container.addChild(lbl);

  const hint = txt(t('settings.dataSaverHint'), FS.label, C.mid);
  hint.anchor.set(0, 0.5); hint.x = Math.round(w * 0.12); hint.y = rowY + Math.round(h * 0.038);
  // The sentence is long in every locale and this row is width-constrained by the toggle beside it.
  if (hint.width > w * 0.46) hint.scale.set((w * 0.46) / hint.width);
  container.addChild(hint);

  host.hits.push({
    rect: { x: bx, y: by, w: btnW, h: btnH },
    // Takes effect from the next launch: this session's prefetch chain has already been decided
    // (and, on the lobby the player came from, very likely already finished). Not worth cancelling
    // mid-flight — the bytes are spent, and the setting is about the sessions after this one.
    fn: () => { setDataSaverEnabled(!on); host.render(); },
  });
}

// Help (left) and Account (right) sit side by side on the same row so the
// help block no longer pushes account down when the tutorial replay is shown.
export function drawHelp(host: PanelHost): void {
  const { w, h, container, cb } = host;
  const secY = Math.round(h * 0.73);
  const x = Math.round(w * 0.56);
  const label = txt(t('settings.help'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = x; label.y = secY;
  container.addChild(label);
  addButton(host, t('settings.replayTutorial'), secY + Math.round(h * 0.045), C.accent, () => cb.onReplayTutorial!(), Math.round(w * 0.4), x);
}

export function drawAccount(host: PanelHost): void {
  const { w, h, container, cb } = host;
  const secY = Math.round(h * 0.73);
  const x = Math.round(w * 0.12);
  const btnW = Math.round(w * 0.4);
  const label = txt(t('settings.account'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = x; label.y = secY;
  container.addChild(label);

  if (cb.offline) {
    const hint = txt(t('settings.offlineHint'), FS.label, C.mid);
    hint.anchor.set(0, 0.5); hint.x = x; hint.y = secY + Math.round(h * 0.045);
    container.addChild(hint);
    if (cb.onLogin) {
      addButton(host, t('auth.loginEntry'), secY + Math.round(h * 0.09), C.gold, () => cb.onLogin!(), btnW, x);
    }
  } else if (cb.onLogout) {
    addButton(host, t('auth.logout'), secY + Math.round(h * 0.045), C.dark, () => cb.onLogout!(), btnW, x);
    // Account deletion (C5-b, Apple 5.1.1(v)) — danger entry below logout, online only.
    if (cb.onDeleteAccount) {
      addButton(host, t('settings.deleteAccount'), secY + Math.round(h * 0.125), C.red, () => host.openDelete(), btnW, x);
    }
  }
}
