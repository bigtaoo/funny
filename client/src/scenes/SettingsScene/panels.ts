// SettingsScene's profile/language/help/account panels, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — each takes a narrow `PanelHost` (the
// handful of SettingsScene fields/methods actually used, made public for this) instead of closing
// over `this`. Mirrors StatsScene/panels.ts / ResultScene/builders.ts's precedent.
import * as PIXI from 'pixi.js-legacy';
import { makeText, monospaceWidth } from '../../render/pixiText';
import { ui as C, sketchPanel } from '../../render/sketchUi';
import { t, getLocale, setLocale, getSupportedLocales, Locale, TranslationKey } from '../../i18n';
import { FS, snapFont } from '../../render/fontScale';
import { buildAvatar } from '../../render/avatar';
import type { SettingsSceneCallbacks } from './types';
import type { Hit } from '../../ui/hits';
import { isDataSaverEnabled, setDataSaverEnabled } from '../../assets/prefetchPolicy';
import { legalUrl } from '../../ui/dialogs/ConsentDialog';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
import type { IconKind } from '../../render/icons';
import { formatViewportGeometry } from '../../layout/viewportGeometry';

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
export function addButton(host: PanelHost, label: string, y: number, border: number, fn: (() => void) | null, width?: number, x?: number, icon?: IconKind): void {
  const { w, h } = host;
  const btnW = width ?? Math.round(w * 0.5);
  const btnH = Math.round(h * 0.07);
  const bx = x ?? Math.round(w * 0.12);
  const enabled = fn !== null;
  const box = sketchPanel(btnW, btnH, { fill: enabled ? C.dark : 0xbbbbbb, border, width: 2.6, seed: 91 });
  box.alpha = enabled ? 1 : 0.6;
  box.x = bx; box.y = y;
  host.container.addChild(box);

  // [icon][gap][label], drawn into its own container so the disabled state can dim the glyph
  // and the text together (the label used to carry the alpha alone).
  const content = new PIXI.Container();
  drawButtonLabel(content, bx, y, btnW, btnH, label, icon ?? null, 0xffffff, snapFont(Math.round(btnH * 0.34)));
  content.alpha = enabled ? 1 : 0.6;
  host.container.addChild(content);

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
    addButton(host, label, btnY, enabled ? C.accent : C.light, enabled ? () => host.openRename() : null, Math.round(w * 0.46), undefined, 'penWrite');

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
    const box = sketchPanel(btnW, btnH, {
      fill: on ? C.accent : C.paper, border: on ? C.gold : C.dark, width: on ? 2.8 : 2, seed: 71 + i,
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
 * One `label … [toggle]` row with a wrapped hint underneath, in one HALF of the content width.
 *
 * Two settings share this shape and, as of 2026-09-21, share a row: data saver on the left, the
 * analytics consent on the right. They are paired rather than stacked because this screen has no
 * vertical room left — the band between the language buttons (which run to 0.84w, so there is no
 * "right column" at that height) and Help/Account at 0.73h fits exactly one row, and everything
 * below it is booked down to the viewport readout at the bottom edge.
 *
 * `x0`/`x1` are the half's left edge and the right edge its toggle is flush with.
 */
function toggleRow(host: PanelHost, o: {
  x0: number; x1: number; rowY: number; label: string; hint: string;
  on: boolean; onLabel: string; seed: number; onTap: () => void;
}): void {
  const { h, container } = host;
  const label = txt(o.label, FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.x = o.x0; label.y = o.rowY;
  container.addChild(label);

  // Narrower than the language buttons (0.22w) because two of these share the row now, and the
  // labels inside are one short word in every locale ("On"/"Aus"/"已关闭").
  const btnW = Math.round((o.x1 - o.x0) * 0.42);
  const btnH = Math.round(h * 0.062);
  const bx = o.x1 - btnW;
  const by = o.rowY - Math.round(btnH / 2);

  const box = sketchPanel(btnW, btnH, {
    fill: o.on ? C.accent : C.paper, border: o.on ? C.gold : C.dark, width: o.on ? 2.8 : 2, seed: o.seed,
  });
  box.x = bx; box.y = by;
  container.addChild(box);

  const lbl = txt(o.onLabel, snapFont(Math.round(btnH * 0.36)), o.on ? 0xffffff : C.dark, o.on);
  lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = by + btnH / 2;
  container.addChild(lbl);

  // Wrapped, not shrunk. Fitting a whole sentence onto ONE line of this width scaled it to ~0.2 —
  // 5 design px of type, below anything the font scale offers and simply unreadable (measured on
  // all three portrait viewports, 2026-09-11). It sits BELOW the row, so it is free to use the
  // half's full width and spend the vertical gap before Help/Account instead.
  const hint = makeText(o.hint, {
    fontSize: FS.tiny, fill: C.mid, fontFamily: 'monospace',
    wordWrap: true, wordWrapWidth: o.x1 - o.x0, breakWords: true,
  });
  hint.anchor.set(0, 0); hint.x = o.x0; hint.y = o.rowY + Math.round(h * 0.028);
  container.addChild(hint);

  host.hits.push({ rect: { x: bx, y: by, w: btnW, h: btnH }, fn: o.onTap });
}

/** The row both toggles sit on, and the split between their halves. */
function toggleRowGeometry(w: number, h: number) {
  return { rowY: Math.round(h * 0.635), leftX0: Math.round(w * 0.12), leftX1: Math.round(w * 0.46),
           rightX0: Math.round(w * 0.56), rightX1: Math.round(w * 0.94) };
}

/**
 * Data saver (ASSET_PACKAGING §14). The player-owned half of "don't spend my bandwidth
 * speculatively" — the automatic half (`prefetchPolicy.shouldSkipPrefetch`) can only read
 * `navigator.connection`, which is Chromium-only and therefore absent on iOS Safari, Firefox and
 * inside every iOS in-app browser. Rather than guess the link there (throughput would answer the
 * wrong question — a fast LTE link is fast AND metered), this just lets the player say so. Works
 * on every platform, needs no API, and cannot be wrong.
 */
export function drawDataSaver(host: PanelHost): void {
  const g = toggleRowGeometry(host.w, host.h);
  const on = isDataSaverEnabled();
  toggleRow(host, {
    x0: g.leftX0, x1: g.leftX1, rowY: g.rowY, seed: 83, on,
    label: t('settings.dataSaver'),
    onLabel: t(on ? 'settings.dataSaverOn' : 'settings.dataSaverOff'),
    hint: t('settings.dataSaverHint'),
    // Takes effect from the next launch: this session's prefetch chain has already been decided
    // (and, on the lobby the player came from, very likely already finished). Not worth cancelling
    // mid-flight — the bytes are spent, and the setting is about the sessions after this one.
    onTap: () => { setDataSaverEnabled(!on); host.render(); },
  });
}

/**
 * Analytics consent (COMPLIANCE_GLOBAL §3.3, GDPR Art 7(3)). The withdrawal half of the
 * first-launch consent gate: whatever the player answered there — including "essentials only",
 * which is the whole point of offering it — has to be changeable afterwards, and as easily.
 *
 * Absent callbacks → not drawn at all, rather than drawn disabled: the pair is missing only in the
 * headless harnesses, never in a build a player runs.
 */
export function drawAnalyticsConsent(host: PanelHost): void {
  const { cb } = host;
  if (!cb.getAnalyticsConsent || !cb.onSetAnalyticsConsent) return;

  const g = toggleRowGeometry(host.w, host.h);
  const on = cb.getAnalyticsConsent();
  toggleRow(host, {
    x0: g.rightX0, x1: g.rightX1, rowY: g.rowY, seed: 89, on,
    label: t('settings.analytics'),
    onLabel: t(on ? 'settings.analyticsOn' : 'settings.analyticsOff'),
    hint: t('settings.analyticsHint'),
    // Takes effect immediately, unlike the data saver beside it: the queue reads consent per
    // event, so switching off stops the very next one and switching on resumes without a relaunch.
    onTap: () => { cb.onSetAnalyticsConsent!(!on); host.render(); },
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
  addButton(host, t('settings.replayTutorial'), secY + Math.round(h * 0.045), C.accent, () => cb.onReplayTutorial!(), Math.round(w * 0.4), x, 'replay');
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
      addButton(host, t('auth.loginEntry'), secY + Math.round(h * 0.09), C.gold, () => cb.onLogin!(), btnW, x, 'key');
    }
  } else if (cb.onLogout) {
    addButton(host, t('auth.logout'), secY + Math.round(h * 0.045), C.dark, () => cb.onLogout!(), btnW, x, 'power');
    // Account deletion (C5-b, Apple 5.1.1(v)) — danger entry below logout, online only.
    if (cb.onDeleteAccount) {
      addButton(host, t('settings.deleteAccount'), secY + Math.round(h * 0.125), C.red, () => host.openDelete(), btnW, x, 'trash');
    }
  }
}

/**
 * Privacy policy / Terms links (Apple 5.1.1(i), `store-assets-checklist §1.5`).
 *
 * App Review checks that the privacy policy is reachable **from inside the app**, not only from the
 * store listing. Until now the only in-app link pair lived in {@link ConsentDialog}, which is shown
 * once on first launch and is unreachable afterwards — a reviewer signing in on a device that has
 * already consented would find no policy anywhere in the UI.
 *
 * Sits in the right column under Help so it shares the existing Help/Account band instead of needing
 * a new one — this scene has no flow layout, every section is a hand-tuned fraction of `h`, and a
 * new band would silently draw on top of its neighbours (see settingsDataSaverRow.ui.ts).
 *
 * URLs come from {@link legalUrl}: relative pages on the web, absolute https in the native shell,
 * where the pages are deliberately not bundled and a `capacitor://` URL is silently dropped by iOS
 * (IOS_RELEASE.md §10.3).
 */
export function drawLegal(host: PanelHost): void {
  const { w, h, container } = host;
  const secY = Math.round(h * 0.73);
  const x = Math.round(w * 0.56);

  const rowH = Math.round(h * 0.04);
  const links: ReadonlyArray<readonly [TranslationKey, '/privacy' | '/terms']> = [
    ['consent.privacyPolicy', '/privacy'],
    ['consent.terms', '/terms'],
  ];
  const rows = links.map(([key, path]) => {
    const text = txt('· ' + t(key), FS.label, C.accent, true);
    // `Math.max` with a width derived from the string: the UI harness's `measureText` is
    // `length * 7` px at every font size, which would pin the branch below to "one row" in every
    // test (monospaceWidth's header has the full story).
    return { path, text, w: Math.max(text.width, monospaceWidth(text.text, FS.label)) };
  });

  // One row when the pair fits, two when it does not — measured, not assumed from orientation. The
  // column runs `x`…0.94w: ~730 design px in landscape, where both links fit in all three locales,
  // but only ~410 in portrait, where "· Datenschutzerklärung · Nutzungsbedingungen" is half again
  // too long. Every locale has its own width (CJK is full-width monospace), so this is decided per
  // render, not per platform.
  const gap = Math.round(w * 0.025);
  const maxW = w - x - Math.round(w * 0.06);
  const oneRow = rows.reduce((sum, r) => sum + r.w, 0) + gap * (rows.length - 1) <= maxW;

  // Collapsing to one row frees a row's worth of height, and it is spent on the two gaps that read
  // as crowding: under the Replay-tutorial BUTTON above (it ends at 0.845h, and at the stacked
  // 0.142h the label's caps sit ~7px off its border) and between the label and its links. The
  // numbers are the landscape band measured end to end — 913…1041 design px between that button
  // and the viewport readout below, 67 of which is text — split into ~24/16/22 of air.
  // Stacked, the fractions stay exactly as they were: that layout is the tall-and-narrow one, where
  // the same band has two link rows AND the readout's two lines to fit.
  const labelY = secY + Math.round(h * (oneRow ? 0.155 : 0.142));
  const label = txt(t('settings.legal'), FS.title, C.dark, true);
  label.anchor.set(0, 0.5); label.y = labelY; label.x = x;
  container.addChild(label);

  let rowX = x;
  rows.forEach(({ text: link, path, w: linkW }, i) => {
    const y = secY + Math.round(h * (oneRow ? 0.2 : 0.175)) + (oneRow ? 0 : i * rowH);
    link.anchor.set(0, 0.5); link.x = oneRow ? rowX : x; link.y = y;
    container.addChild(link);
    host.hits.push({
      // Stacked, the rect is wider than the glyphs: a tap target the exact width of "Terms" in
      // English is a miss on a phone (and a different width in every locale). Side by side it can
      // only claim its own text plus half the gap, or the two targets would overlap.
      rect: {
        x: link.x, y: y - rowH / 2, h: rowH,
        w: oneRow ? Math.round(linkW + gap / 2) : Math.max(Math.round(linkW), Math.round(w * 0.3)),
      },
      fn: () => { if (typeof window !== 'undefined') window.open(legalUrl(path), '_blank', 'noopener'); },
    });
    rowX += Math.round(linkW) + gap;
  });
}

/**
 * On-device viewport readout (`layout/viewportGeometry.ts`) — the raw numbers the layout is built
 * from, drawn where a player can photograph them.
 *
 * Why this is in the shipped UI rather than behind a debug flag: the iPhone-13 portrait safe-area
 * bug (top HUD over the status bar, dead band at the bottom) has now been diagnosed twice from
 * arithmetic alone, and shipped once as a fix that could not possibly work, because the one
 * environment that can be inspected here — desktop Chrome — reports zero insets in a full-height
 * viewport and reproduces none of it. A console log alone does not help either: the affected build
 * is a TestFlight shell on someone else's phone, with no DevTools attached. Two small lines on the
 * settings screen turn "please describe what it looks like" into one screenshot.
 *
 * Deliberately unlocalised and unstyled: it is five numbers and a one-word verdict, and a
 * translated diagnostic is a diagnostic someone has to translate before they can read it back.
 * Absent when the platform cannot answer (WeChat — no DOM to read; see IPlatform).
 *
 * **Native shell only.** In a browser the readout is debug text in front of every player, and it
 * cannot even answer the question it exists for: `viewportVerdict` returns the literal word
 * `browser` there and makes no claim, because tabs and a URL bar eat viewport legitimately. The one
 * environment where these numbers decide something is the Capacitor shell — ADR-088
 * (`ios.contentInset: 'never'`) is still waiting on exactly this row off a TestFlight build,
 * reading `inset-eaten` → `env-reported`.
 */
export function drawViewportDiagnostics(host: PanelHost): void {
  const { w, h, container, cb } = host;
  const geom = cb.getViewportGeometry?.();
  if (!geom || !geom.nativeShell) return;

  const [top, bottom] = formatViewportGeometry(geom);
  // Portrait leaves ~100px of clear band under the Legal links (0.945h); landscape's design rect is
  // only 1080 tall and leaves about half that, so the same content goes on ONE line there — which
  // its 1920-wide design rect has ample room for. Nothing else on this screen is anchored to the
  // bottom edge, so this is the one row that can be laid out from the bottom up.
  const rows = w > h ? [`${top} | ${bottom}`] : [top, bottom];

  // FS.label, not a fraction of `h`: at 24 design px this renders at ~8.7 CSS px on a 390pt-wide
  // phone (design space is contained at ~0.36x there), which is the floor for something whose only
  // channel is a photograph. Bigger would not fit two lines into the band above.
  const size = FS.label;
  const gap = Math.round(size * 0.3);
  // Bottom-anchored and measured, rather than two more hand-tuned fractions of `h`: the fractions
  // are what made the first attempt at this row draw both lines at the same y (0.945h + 0.033h is
  // 0.978h, which was also line two's own fraction).
  let baseline = h - Math.round(h * 0.008);
  for (const text of [...rows].reverse()) {
    const line = txt(text, size, C.mid);
    line.anchor.set(0, 1); // bottom-left: `y` IS the baseline box bottom, so stacking cannot overlap
    line.x = Math.round(w * 0.12);
    line.y = baseline;
    // A verdict word can lengthen the line; shrink rather than run off the page edge.
    const maxW = w - line.x - Math.round(w * 0.06);
    if (line.width > maxW) line.scale.set(maxW / line.width);
    container.addChild(line);
    baseline -= Math.round(line.height + gap);
  }
}
