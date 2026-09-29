// SettingsScene's sections, as form① free functions over a narrow `PanelHost` (claudedocs/
// client-modules.md "单文件 500 行收敛"), laid out by the flow layout in layout.ts
// (UI_DESIGN_LOG_2026-09 §65).
//
// `drawPage` is the only place that decides WHICH section goes WHERE; each `drawXxx` only says what
// rows it has. Landscape: left column = profile, volume, account; right column = general, help.
// Portrait: one column in the order profile, volume, general, help, account.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt } from '../../render/sketchUi';
import { t, getLocale, setLocale, getSupportedLocales, Locale, TranslationKey } from '../../i18n';
import { FS } from '../../render/fontScale';
import { buildAvatar } from '../../render/avatar';
import type { SettingsSceneCallbacks } from './types';
import { isDataSaverEnabled, setDataSaverEnabled } from '../../assets/prefetchPolicy';
import { legalUrl } from '../../ui/dialogs/ConsentDialog';
import { moderationAvailable, openBlockedPlayers } from '../../ui/moderation';
import { clientPlatformName } from '../../app/appConstants';
import { formatViewportGeometry } from '../../layout/viewportGeometry';
import {
  columns, section, toggleControl, segmentedControl, buttonControl, textW, TYPE,
  type Column, type Page,
} from './layout';
import { drawAudio, type AudioPanelHost } from './audioPanel';

const LOCALE_LABEL: Record<Locale, string> = { zh: '中文', en: 'English', de: 'Deutsch' };

/** What the sections below need out of SettingsScene — a narrow, mostly-read-only slice. */
export interface PanelHost extends AudioPanelHost {
  readonly cb: SettingsSceneCallbacks;
  readonly playerName: string;
  readonly currentAvatarId: string | undefined;
  readonly busy: boolean;
  openAvatarPicker(): void;
  openRename(): void;
  openDelete(): void;
}

/** Lay the whole page out from `top` down. Returns the content's bottom edge (content space). */
export function drawPage(host: PanelHost, page: Page, top: number): number {
  const cols = columns(page, top);
  const [left, right = left] = cols as [Column, Column?];
  drawProfile(host, page, left);
  drawAudio(page, left, host);
  if (cols.length === 1) {
    drawGeneral(host, page, left);
    drawHelp(host, page, left);
    drawAccount(host, page, left);
  } else {
    drawAccount(host, page, left);
    drawGeneral(host, page, right);
    drawHelp(host, page, right);
  }
  // Every column's cursor ends one sectionGap past its last card.
  const bottom = Math.max(...cols.map((c) => c.y)) - page.m.sectionGap;
  return drawViewportDiagnostics(host, page, bottom + page.m.sectionGap);
}

/**
 * The card with no heading: avatar, name, public id, rank — and, when renaming is possible, a row
 * with the balance on the left and the rename button on the right. The button is the outlined
 * secondary form; nothing on this screen is a solid dark slab any more.
 */
export function drawProfile(host: PanelHost, page: Page, col: Column): void {
  const { cb, playerName, currentAvatarId } = host;
  section(page, col, null, (sec) => {
    const av = Math.round(page.m.rowMinH * 1.5);
    const top = sec.custom(av + page.m.rowPadY * 2);
    const ay = top + page.m.rowPadY;

    const avatar = buildAvatar(av, playerName, 21, currentAvatarId);
    avatar.x = sec.x0; avatar.y = ay;
    page.add(avatar);
    // Tapping the avatar opens the picker; the pencil badge says it is editable. Only when picking
    // is enabled (onSetAvatar present).
    if (cb.onSetAvatar) {
      const badgeR = Math.round(av * 0.16);
      const bcx = sec.x0 + av - badgeR, bcy = ay + av - badgeR;
      const badge = new PIXI.Graphics();
      badge.beginFill(C.accent); badge.drawCircle(bcx, bcy, badgeR); badge.endFill();
      page.add(badge);
      const pencil = txt('✎', Math.round(badgeR * 1.4), 0xffffff, true);
      pencil.anchor.set(0.5, 0.5); pencil.x = bcx; pencil.y = bcy;
      page.add(pencil);
      page.hit({ x: sec.x0, y: ay, w: av, h: av }, () => host.openAvatarPicker());
    }

    // Name / #id / rank stacked beside the avatar, centred on it as a block.
    const nameX = sec.x0 + av + page.m.gap;
    const maxW = sec.x1 - nameX;
    const lines: PIXI.Text[] = [txt(playerName, FS.headline, C.dark, true)];
    // Display-only public id (#123456789); the uuid stays server-internal.
    if (cb.publicId) lines.push(txt(t('settings.playerId', { id: cb.publicId }), TYPE.hint, C.mid));
    if (!cb.offline && cb.pvp) {
      const rankName = t(('rank.' + cb.pvp.rank) as TranslationKey);
      lines.push(txt(cb.pvp.rank === 'unranked' ? rankName : `${rankName} · ${cb.pvp.elo}`, TYPE.hint, C.gold, true));
    }
    const lineGap = Math.round(page.m.rowPadY * 0.4);
    const blockH = lines.reduce((s, l) => s + l.height, 0) + lineGap * (lines.length - 1);
    let y = ay + Math.round((av - blockH) / 2);
    for (const l of lines) {
      const w = textW(l, Number(l.style.fontSize));
      if (w > maxW) l.scale.set(maxW / w); // a 24-char name at headline size must not leave the card
      l.anchor.set(0, 0); l.x = nameX; l.y = y;
      page.add(l);
      y += l.height + lineGap;
    }

    // Rename (online only). Free first rename for players who never chose a name; otherwise shows
    // the coin cost and is disabled when the balance is short.
    if (cb.onRename && cb.renameCost != null) {
      const cost = cb.renameCost;
      const free = cb.freeRename === true;
      const coins = cb.getCoins?.() ?? 0;
      const enabled = (free || coins >= cost) && !host.busy;
      sec.row({
        label: free ? t('settings.renameFreeHint') : t('settings.coins', { coins }),
        labelColor: C.mid, labelSize: TYPE.hint,
        control: buttonControl(page, free ? t('settings.renameFree') : t('settings.rename', { cost }), 'penWrite',
          enabled ? () => host.openRename() : null),
      });
    }
  });
}

/** Language, data saver, analytics consent — the three things that are "how the app behaves". */
export function drawGeneral(host: PanelHost, page: Page, col: Column): void {
  const { cb } = host;
  section(page, col, t('settings.general'), (sec) => {
    const active = getLocale();
    sec.row({
      label: t('settings.language'),
      control: segmentedControl(page, getSupportedLocales().map((loc) => ({
        label: LOCALE_LABEL[loc], on: loc === active,
        onTap: () => { setLocale(loc); host.render(); },
      }))),
    });

    // Data saver (ASSET_PACKAGING §14): the player-owned half of "don't spend my bandwidth
    // speculatively". The automatic half can only read `navigator.connection`, which iOS Safari,
    // Firefox and every iOS in-app browser lack — so the player gets to say so. Takes effect from the
    // next launch: this session's prefetch chain has already been decided.
    const saver = isDataSaverEnabled();
    sec.row({
      label: t('settings.dataSaver'), hint: t('settings.dataSaverHint'),
      control: toggleControl(page, saver, t(saver ? 'settings.dataSaverOn' : 'settings.dataSaverOff'), 83,
        () => { setDataSaverEnabled(!saver); host.render(); }),
    });

    // Analytics consent (COMPLIANCE_GLOBAL §3.3, GDPR Art 7(3)): the withdrawal half of the
    // first-launch consent gate. Absent callbacks → not drawn (only the headless harnesses lack them).
    // Takes effect immediately: the queue reads consent per event.
    if (cb.getAnalyticsConsent && cb.onSetAnalyticsConsent) {
      const on = cb.getAnalyticsConsent();
      sec.row({
        label: t('settings.analytics'), hint: t('settings.analyticsHint'),
        control: toggleControl(page, on, t(on ? 'settings.analyticsOn' : 'settings.analyticsOff'), 89,
          () => { cb.onSetAnalyticsConsent!(!on); host.render(); }),
      });
    }
  });
}

/**
 * Whether this build can open the legal pages at all. They open through `window.open`, which the
 * WeChat runtime does not have — a link there would do nothing when tapped, so it is not drawn.
 * WeChat's own privacy agreement goes through the platform's `wx` flow, not this screen.
 */
function canOpenLegalLinks(): boolean {
  return clientPlatformName() !== 'wechat';
}

/**
 * Tutorial replay, then the Privacy policy / Terms links (Apple 5.1.1(i), store-assets-checklist
 * §1.5: App Review checks the policy is reachable from INSIDE the app — the ConsentDialog pair is
 * shown once and unreachable afterwards). URLs come from {@link legalUrl}: relative on the web,
 * absolute https in the native shell and on CrazyGames (IOS_RELEASE.md §10.3).
 */
export function drawHelp(host: PanelHost, page: Page, col: Column): void {
  const { cb } = host;
  const legal = canOpenLegalLinks();
  // Blocked players (App Review 1.2): where a block made anywhere in the social hub is undone.
  const blocked = !cb.offline && moderationAvailable();
  if (!cb.onReplayTutorial && !legal && !blocked) return;
  section(page, col, t('settings.help'), (sec) => {
    if (cb.onReplayTutorial) sec.linkRow({ label: t('settings.replayTutorial'), icon: 'replay', onTap: () => cb.onReplayTutorial!() });
    if (blocked) sec.linkRow({ label: t('moderation.blockedTitle'), icon: 'close', onTap: () => openBlockedPlayers() });
    if (!legal) return;
    const links: ReadonlyArray<readonly [TranslationKey, '/privacy' | '/terms']> = [
      ['consent.privacyPolicy', '/privacy'],
      ['consent.terms', '/terms'],
    ];
    for (const [key, path] of links) {
      sec.linkRow({
        label: t(key),
        onTap: () => { if (typeof window !== 'undefined') window.open(legalUrl(path), '_blank', 'noopener'); },
      });
    }
  });
}

/**
 * Logged in: a "Log out" row, then — outside the card, as plain red text — account deletion (C5-b,
 * Apple 5.1.1(v)). It must be reachable, not prominent: it used to be a button the size of "Log
 * out" directly under it. The confirmation modal is unchanged.
 * Offline (SA-4): the explanation plus the one filled button on the page, "Log in".
 */
export function drawAccount(host: PanelHost, page: Page, col: Column): void {
  const { cb } = host;
  if (!cb.offline && !cb.onLogout && !cb.onLinkPortalAccount) return;
  section(page, col, t('settings.account'), (sec) => {
    if (cb.offline) {
      sec.row({
        hint: t('settings.offlineHint'),
        control: cb.onLogin ? buttonControl(page, t('auth.loginEntry'), 'key', () => cb.onLogin!(), true) : undefined,
      });
    } else if (cb.onLinkPortalAccount) {
      // CrazyGames guest (CRAZYGAMES_LAUNCH.md §4.1): the portal's own sign-in keeps this progress.
      sec.row({
        hint: t('settings.portalSaveHint'),
        control: buttonControl(page, t('auth.signInCrazyGames'), 'key', () => cb.onLinkPortalAccount!(), true),
      });
    } else {
      sec.linkRow({ label: t('auth.logout'), icon: 'power', onTap: () => cb.onLogout!() });
    }
  });
  if (cb.offline || !cb.onDeleteAccount) return;

  const label = txt(t('settings.deleteAccount'), TYPE.hint, C.red, true);
  const h = Math.round(page.m.rowMinH * 0.7);
  const top = col.y - Math.round(page.m.sectionGap / 2);
  label.anchor.set(0, 0.5); label.x = col.x + Math.round(page.m.pad / 2); label.y = top + h / 2;
  page.add(label);
  page.hit({ x: col.x, y: top, w: Math.round(textW(label, TYPE.hint) + page.m.pad), h }, () => host.openDelete());
  col.y = top + h + page.m.sectionGap;
}

/**
 * On-device viewport readout (`layout/viewportGeometry.ts`) — the raw numbers the layout is built
 * from, drawn where a player can photograph them. **Native shell only**: in a browser the verdict is
 * the literal word `browser` and says nothing, while in the Capacitor shell ADR-088 is still waiting
 * on exactly this row off a TestFlight build. Absent on WeChat (no DOM to read).
 *
 * Deliberately unlocalised and unstyled. The last thing on the page, below both columns; one line
 * in landscape, two in portrait. Returns the new content bottom.
 */
export function drawViewportDiagnostics(host: PanelHost, page: Page, y: number): number {
  const geom = host.cb.getViewportGeometry?.();
  if (!geom || !geom.nativeShell) return y - page.m.sectionGap;

  const [top, bottom] = formatViewportGeometry(geom);
  const rows = page.w > page.h ? [`${top} | ${bottom}`] : [top, bottom];
  // FS.label: at 24 design px this is ~8.7 CSS px on a 390pt phone, the floor for a photograph.
  const size = FS.label;
  const x = Math.round(page.w * 0.12);
  const maxW = Math.round(page.w * 0.94) - x;
  for (const text of rows) {
    const line = txt(text, size, C.mid);
    line.anchor.set(0, 0); line.x = x; line.y = y;
    // A verdict word can lengthen the line; shrink rather than run off the page edge.
    if (line.width > maxW) line.scale.set(maxW / line.width);
    page.add(line);
    y += Math.round(line.height + size * 0.3);
  }
  return y;
}
