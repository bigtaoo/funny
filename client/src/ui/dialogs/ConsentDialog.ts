/**
 * ConsentDialog — first-launch GDPR / privacy consent gate (C5-c, L1-1).
 *
 * A self-drawn, blocking full-screen card shown before the lobby on first launch
 * (or after login) until the player answers. Mirrors {@link ProfilePopup}'s style
 * (dimmed backdrop + centred hand-drawn card, own PIXI `interactive` taps) but is
 * a full Scene so it can be `manager.goto`'d before any other screen — no telemetry
 * leaves the device and the lobby is unreachable until a callback fires.
 *
 * ## Two shapes, one screen
 *
 * `mode` is decided by {@link needsConsentChoice} and decides how many buttons the card has:
 *
 *  * `'accept-only'` — one button. Accepting the terms is what lets the player in (contract
 *    necessity), and analytics rides along with it.
 *  * `'choice'` — "accept all" and "essentials only", **both of which enter the game**. Where
 *    analytics consent has to be freely given it cannot be the price of admission, so the second
 *    button is a real answer and not a way out of the dialog.
 *
 * The mode changes which buttons exist, never whether a press counts: there is deliberately no
 * build in which "essentials only" is drawn and then ignored. The full reasoning, and why the
 * region test is a timezone, lives in `platform/consentRegion.ts`.
 *
 * The privacy-policy / terms links open the hosted legal pages in a new browser
 * tab (`/privacy.html`, `/terms.html`), matching the marketing site's footer —
 * except where the game is not served from our own origin, which needs absolute
 * https URLs (see {@link legalUrl}).
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../../render/sketchUi';
import { drawButtonLabel } from '../widgets/buttonLabel';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { tapHandler } from '../hits';
import { isNativeShell } from '../../platform/nativeShell';
import { clientPlatformName } from '../../app/appConstants';

/** Hosted marketing/legal site (Cloudflare Worker `nivara-client`, deploy-cloudflare.md §domains). */
const LEGAL_SITE = 'https://nivara.gamestao.com';

/**
 * Where a legal link should point for this build.
 *
 * A relative path is only right when the game is served from our own origin, i.e. the plain web
 * build sitting next to `/privacy.html` on nivara.gamestao.com. Two targets are not:
 *
 *  * **The native shell.** The pages are deliberately not bundled (they are the web payment
 *    channel's surface — see webpack.config.js), and even when they were, the link did nothing at
 *    all: `window.open(..., '_blank')` in a WKWebView reaches Capacitor's `createWebViewWith`,
 *    which calls `UIApplication.open` on `capacitor://localhost/privacy.html` — a scheme no app is
 *    registered for, so iOS silently drops it. A working privacy link is something App Review checks.
 *  * **CrazyGames.** The portal hosts the uploaded bundle on its own domain, so a root-relative
 *    `/privacy.html` resolves against *crazygames.com* and 404s. The pages are not shipped in that
 *    bundle either (same webpack.config.js copy rule as the native build), and would be unreachable
 *    at that path if they were. A reachable privacy policy is both a portal requirement and a GDPR one.
 *
 * `path` is the extensionless canonical form: the site 307s `/privacy.html` → `/privacy`, and a
 * store build should not spend a redirect to reach its own privacy policy.
 *
 * Exported for its own tests (nativePaymentIsolation.test.ts, crazyGamesPortalIsolation.test.ts) —
 * a link that silently does nothing is precisely the failure this exists to prevent, so it is worth
 * asserting on the value rather than on the shape of the source.
 */
export function legalUrl(path: '/privacy' | '/terms'): string {
  const ownOrigin = !isNativeShell() && clientPlatformName() !== 'crazygames';
  return ownOrigin ? `${path}.html` : `${LEGAL_SITE}${path}`;
}

/** Which button set the card is built with — see the class doc. */
export type ConsentMode = 'accept-only' | 'choice';

export interface ConsentCallbacks {
  /** Player accepted everything — the core records consent (local flag + server) and proceeds. */
  onAccept(): void;
  /**
   * Player accepted the terms but refused analytics. The core records the refusal and proceeds
   * into the game exactly as `onAccept` does. Never fired in `'accept-only'` mode.
   */
  onDecline(): void;
}

export class ConsentDialog implements Scene {
  readonly container: PIXI.Container;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly cb: ConsentCallbacks,
    private readonly mode: ConsentMode = 'accept-only',
  ) {
    this.container = new PIXI.Container();
    this.build();
  }

  update(): void { /* static */ }

  destroy(): void {
    this.container.removeAllListeners();
    this.container.destroy({ children: true });
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('consentbg', w, h));

    // Dim the page so the card reads as a modal.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    // Swallow taps (see FeedbackDialog's 2026-08-09 fix). Today `manager.goto()` never leaves another
    // scene mounted underneath this one, so there's nothing live to click through to yet — this is
    // defense-in-depth matching the sibling stage-level dialogs (Feedback/Appeal) in case that ever
    // changes, and keeps "backdrop tap does NOT dismiss" (see class doc) true at the hit-test level,
    // not just by omission of a handler.
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);

    // Orientation-aware sizing: landscape drives off 80% of the screen height,
    // portrait off 90% of the width. This is only a MINIMUM height — the card
    // grows to fit its content (below) so nothing collides on narrow viewports.
    // Font sizes derive from `unit` (the minimum height) so the visual scale
    // stays stable regardless of any growth.
    const landscape = w > h;
    const cardHmin = landscape
      ? Math.round(h * 0.8)
      : Math.round(Math.min(h * 0.72, w * 0.9 * 1.15));
    const cardW = landscape
      ? Math.round(Math.min(cardHmin * 0.95, w * 0.7))
      : Math.round(w * 0.9);
    const cardX = (w - cardW) / 2;
    const choice = this.mode === 'choice';

    // Stacked buttons, not side by side. Two across a card this narrow leaves each ~0.44 of the
    // width, which "Nur Nötiges" and "Essentials only" only reach by scaling the label down past
    // the point where the secondary option stops competing with the primary one — and an option
    // nobody can read is the failure this mode exists to avoid.
    const nBtns = choice ? 2 : 1;

    // The card grows to fit its content, but the SCREEN does not. In short landscape (a phone on
    // its side: 812x375) the card is only ~0.95 of its own height wide, so the longer 'choice'
    // body wraps to eight or nine lines and the second button then pushes the whole block past
    // both edges — measured at +56px in de, +19 in en, and this is centred content, so it spills
    // at the TOP as well and the title is what goes first. So: lay out once at the natural scale,
    // and if the result does not fit, lay it out again at the scale that does. One correction is
    // enough and always undershoots, because a smaller font also wraps into fewer lines.
    const maxH = h * 0.96;
    let L = this.measure(cardHmin, cardHmin, cardW, choice, nBtns);
    if (L.contentH > maxH) {
      L.title.destroy(); L.body.destroy();
      L = this.measure(Math.floor(cardHmin * (maxH / L.contentH)), cardHmin, cardW, choice, nBtns);
    }
    const { unit, title, body, dyTitle, dyBody, dyLink1, dyLink2, dyBtn, bH, gapBtnBtn, contentH } = L;

    const cardH = Math.min(Math.round(maxH), Math.max(cardHmin, Math.round(contentH)));
    const cardY = (h - cardH) / 2;

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 1) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    title.x = w / 2; title.y = cardY + dyTitle;
    this.container.addChild(title);
    body.x = w / 2; body.y = cardY + dyBody;
    this.container.addChild(body);

    // Policy / terms links — clickable, open the hosted legal pages in a new tab.
    this.addLink(t('consent.privacyPolicy'), w / 2, cardY + dyLink1, unit, legalUrl('/privacy'));
    this.addLink(t('consent.terms'), w / 2, cardY + dyLink2, unit, legalUrl('/terms'));

    // Buttons (the only affordances — backdrop tap does NOT dismiss; the gate needs an answer).
    const bW = Math.round(cardW * 0.6);
    const bX = cardX + (cardW - bW) / 2;
    const bY = cardY + dyBtn;
    const fs = snapFont(Math.round(bH * 0.4));

    this.addButton(bX, bY, bW, bH, t(choice ? 'consent.acceptAll' : 'consent.accept'), 'check',
      C.green, 0xffffff, fs, 2, () => this.cb.onAccept());

    if (choice) {
      // Paper fill + ink label, i.e. the same weight as the links above rather than a second
      // coloured call to action: both answers are valid, but only one of them is the one the
      // sentence above just recommended, and a matched pair of green buttons would say neither.
      this.addButton(bX, bY + bH + gapBtnBtn, bW, bH, t('consent.essentialOnly'), null,
        C.paper, C.dark, fs, 3, () => this.cb.onDecline());
    }
  }

  /** One hand-drawn button box plus its centred `[icon][label]` group, wired to `onTap`. */
  private addButton(
    x: number, y: number, w: number, h: number,
    label: string, icon: 'check' | null, fill: number, ink: number, fontSize: number,
    seedIdx: number, onTap: () => void,
  ): void {
    // `seedIdx` distinguishes the two buttons: they share w/h, so one seed would hand them the
    // identical hand-drawn wobble and the pair would read as a printed duplicate.
    const box = sketchPanel(w, h, { fill, border: C.dark, width: 2.4, seed: seedFor(w, h, seedIdx) });
    box.x = x; box.y = y;
    box.eventMode = 'static';
    box.cursor = 'pointer';
    box.on('pointertap', tapHandler(onTap));
    this.container.addChild(box);
    drawButtonLabel(this.container, x, y, w, h, label, icon, ink, fontSize);
  }

  /**
   * Build the two text nodes at `unit` and return them with every vertical offset they imply.
   *
   * Split out of {@link build} so the layout can be measured, rejected and measured again at a
   * smaller scale (see the caller). `unit` is the type scale; `cardHmin` stays fixed so a rescale
   * shrinks the CONTENT rather than the card's minimum size, and `cardW` is passed in because the
   * wrap width must not move between the two passes — that would change the line count the second
   * pass is trying to predict.
   */
  private measure(unit: number, cardHmin: number, cardW: number, choice: boolean, nBtns: number) {
    const title = txt(t('consent.title'), snapFont(Math.round(unit * 0.07)), C.dark, true);
    title.anchor.set(0.5, 0);

    // The two modes make different promises, so they cannot share a sentence: accept-only says
    // analytics follows from accepting, choice has to say what the second button actually does.
    const body = makeText(t(choice ? 'consent.bodyChoice' : 'consent.body'), {
      fontSize: snapFont(Math.round(unit * 0.04)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, breakWords: true, lineHeight: Math.round(unit * 0.06),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.06;       // above the title
    const gapTitleBody = unit * 0.07;
    const blankLine = unit * 0.06;    // the requested blank line before the links
    const linkStep = unit * 0.07;     // baseline-to-baseline of the two links
    const linkH = unit * 0.042 * 1.4; // single monospace line height
    const gapLinkBtn = unit * 0.07;
    const bH = Math.round(unit * 0.12);
    const gapBtnBtn = unit * 0.035;   // between the two buttons in 'choice' mode
    const padBottom = unit * 0.06;

    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;
    const dyLink1 = dyBody + body.height + blankLine;
    const dyLink2 = dyLink1 + linkStep;
    const dyBtn = dyLink2 + linkH + gapLinkBtn;
    const contentH = dyBtn + bH * nBtns + gapBtnBtn * (nBtns - 1) + padBottom;

    return { unit, cardHmin, title, body, dyTitle, dyBody, dyLink1, dyLink2, dyBtn, bH, gapBtnBtn, contentH };
  }

  /** Add a centred, tappable "· <label>" link that opens `url` in a new browser tab. */
  private addLink(label: string, cx: number, y: number, cardH: number, url: string): void {
    const link = txt('· ' + label, snapFont(Math.round(cardH * 0.042)), C.accent, true);
    link.anchor.set(0.5, 0); link.x = cx; link.y = y;
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointertap', tapHandler(() => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    }));
    this.container.addChild(link);
  }
}
