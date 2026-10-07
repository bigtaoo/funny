/**
 * EntryNoticeStrip — the NON-blocking Terms / Privacy notice and analytics prompt for builds that
 * may not put a wall in front of gameplay (IPlatform.entryNoticeOnly — CrazyGames, COMPLIANCE_GLOBAL
 * §3.3). A small card along the bottom of the host screen, above its bottom bar:
 *
 *   By playing, you agree to our Terms of Use (EULA) and Privacy Policy.   ← `terms`
 *   Help improve the game with anonymous gameplay data? …                  ← `consent`
 *   · Privacy Policy  · Terms of Use (EULA)          [ Allow ] [ No thanks ]   (or [ OK ])
 *
 * Nothing behind it is dimmed or blocked: only taps inside the strip's own rectangle belong to it
 * (the host routes them through {@link EntryNoticeStripBuilt.hits} before its own hit table), every
 * other tap reaches the screen underneath as if the strip were not there. That is the point — the
 * portal's own guidance is "a simple notice rather than a pop-up blocking the user".
 *
 * Render-only: what an answer *means* (flags, analytics, the server record) is decided by the app
 * core's `offerEntryNotice`, which hands the spec in. The host owns the layer's lifetime; the strip
 * goes away with the host screen.
 */
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n/index';
import { ui as C, txt, txtFit, sketchPanel, seedFor } from '../../render/sketchUi';
import { makeText } from '../../render/pixiText';
import { snapFont } from '../../render/fontScale';
import type { Hit } from '../hits';
import type { Rect } from '../../layout/ILayout';
import { legalUrl } from './ConsentDialog';
import { openExternalUrl } from '../../platform/externalLink';

/** What the strip says and asks. Built by the app core (`offerEntryNotice`). */
export interface EntryNoticeSpec {
  /** Show the "by playing you agree to our Terms and Privacy Policy" line. */
  terms: boolean;
  /** Ask the analytics question — Allow / No thanks. Without it the strip has a single OK. */
  consent: boolean;
  /** `consent` only: the answer. Never called when the strip simply goes away with its screen. */
  onAnswer?(granted: boolean): void;
  /** No `consent`: the player tapped OK. */
  onClose?(): void;
}

/** A screen that can carry the strip (the lobby today; any screen with a free bottom edge later). */
export interface EntryNoticeHost {
  showEntryNotice?(spec: EntryNoticeSpec): void;
}

export interface EntryNoticeStripBuilt {
  container: PIXI.Container;
  /** The strip's whole rectangle — taps inside it never fall through to the host. */
  rect: Rect;
  /** Its own buttons and links, in design space. */
  hits: Hit[];
}

/**
 * Build the strip for a `w`×`h` design-space host whose bottom `bottomInset` px are taken by a bar
 * the strip must stay above. `close` is called (before the answer callback) whenever one of the
 * strip's own buttons was tapped; the links leave it up.
 */
export function buildEntryNoticeStrip(
  w: number, h: number, bottomInset: number, spec: EntryNoticeSpec, close: () => void,
): EntryNoticeStripBuilt {
  const container = new PIXI.Container();
  container.name = 'overlay:entryNotice';
  const unit = Math.min(w, h);
  const stripW = Math.round(Math.min(w * 0.94, unit * 1.6));
  const x0 = Math.round((w - stripW) / 2);
  const pad = Math.round(unit * 0.022);
  const innerW = stripW - 2 * pad;
  // Never under 14 px in design space: on a contain-scaled small canvas a smaller design size reads
  // as unreadable fine print, which a notice of terms must not be (ONBOARDING_DESIGN §11.5).
  const fs = Math.max(14, snapFont(Math.round(unit * 0.03)));
  const lineGap = Math.round(fs * 0.5);

  const sentences: string[] = [];
  if (spec.terms) sentences.push(t('entryNotice.terms'));
  if (spec.consent) sentences.push(t('entryNotice.consent'));
  const body = makeText(sentences.join(' '), {
    fontSize: fs, fill: C.dark, fontFamily: 'monospace',
    wordWrap: true, wordWrapWidth: innerW, breakWords: true, lineHeight: Math.round(fs * 1.35),
  });

  // Links: the same two pages, same URLs and the same opener as the entry gate's links (legalUrl
  // already resolves to the absolute site URL on the portal build, where a root-relative path 404s).
  const linkFs = Math.max(14, snapFont(Math.round(fs * 0.92)));
  const links = [
    { label: '· ' + t('consent.privacyPolicy'), url: legalUrl('/privacy') },
    { label: '· ' + t('consent.terms'), url: legalUrl('/terms') },
  ].map((l) => ({ ...l, node: txt(l.label, linkFs, C.accent, true) }));
  const linkGap = Math.round(fs * 0.9);
  const linksW = links.reduce((s, l) => s + l.node.width, 0) + linkGap * (links.length - 1);

  // Buttons: Allow / No thanks, or a lone OK.
  const btnH = Math.round(fs * 2.1);
  const btnGap = Math.round(fs * 0.6);
  const buttons: Array<{ label: string; fill: number; ink: number; sound?: Hit['sound']; fn: () => void }> = spec.consent
    ? [
        { label: t('entryNotice.allow'), fill: C.accent, ink: 0xffffff, fn: () => { close(); spec.onAnswer?.(true); } },
        { label: t('entryNotice.decline'), fill: C.light, ink: C.dark, sound: 'sfx.ui.back', fn: () => { close(); spec.onAnswer?.(false); } },
      ]
    : [{ label: t('entryNotice.ok'), fill: C.dark, ink: 0xffffff, sound: 'sfx.ui.back', fn: () => { close(); spec.onClose?.(); } }];
  const btnW = Math.round(Math.min(innerW / (buttons.length + 0.5), Math.max(fs * 6, unit * 0.2)));
  const buttonsW = btnW * buttons.length + btnGap * (buttons.length - 1);

  // One row for links + buttons when they fit side by side, else links above buttons.
  const oneRow = linksW + buttonsW + linkGap <= innerW;
  const linksRowH = Math.round(linkFs * 1.4);
  const bodyH = Math.ceil(body.height);
  const actionsH = oneRow ? Math.max(btnH, linksRowH) : linksRowH + lineGap + btnH;
  const stripH = pad + bodyH + lineGap + actionsH + pad;
  const y0 = Math.round(h - bottomInset - stripH - unit * 0.015);

  const panel = sketchPanel(stripW, stripH, { fill: C.paper, border: C.accent, width: 2.4, seed: seedFor(stripW, stripH, 7) });
  panel.x = x0; panel.y = y0;
  container.addChild(panel);

  body.x = x0 + pad; body.y = y0 + pad;
  container.addChild(body);

  const hits: Hit[] = [];
  const actionsY = y0 + pad + bodyH + lineGap;
  const linksY = oneRow ? actionsY + Math.round((actionsH - linksRowH) / 2) : actionsY;
  let lx = x0 + pad;
  for (const l of links) {
    l.node.x = lx; l.node.y = linksY;
    container.addChild(l.node);
    // Hit rect a little taller than the glyphs: the label is small and the strip is tapped by thumbs.
    const rect = { x: lx, y: linksY - Math.round(linkFs * 0.3), w: l.node.width, h: Math.round(linkFs * 1.6) };
    const url = l.url;
    hits.push({ rect, fn: () => openExternalUrl(url) });
    lx += l.node.width + linkGap;
  }

  const btnY = oneRow ? actionsY + Math.round((actionsH - btnH) / 2) : actionsY + linksRowH + lineGap;
  let bx = x0 + stripW - pad - buttonsW;
  buttons.forEach((b, i) => {
    const box = sketchPanel(btnW, btnH, { fill: b.fill, border: C.dark, width: 2, seed: seedFor(btnW, btnH, 11 + i) });
    box.x = bx; box.y = btnY;
    container.addChild(box);
    const lbl = txtFit(b.label, snapFont(Math.round(btnH * 0.42)), b.ink, true, btnW - Math.round(btnW * 0.12));
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = btnY + btnH / 2;
    container.addChild(lbl);
    hits.push({ rect: { x: bx, y: btnY, w: btnW, h: btnH }, fn: b.fn, ...(b.sound ? { sound: b.sound } : {}) });
    bx += btnW + btnGap;
  });

  return { container, rect: { x: x0, y: y0, w: stripW, h: stripH }, hits };
}
