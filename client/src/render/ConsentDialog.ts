/**
 * ConsentDialog — first-launch GDPR / privacy consent gate (C5-c, L1-1).
 *
 * A self-drawn, blocking full-screen card shown before the lobby on first launch
 * (or after login) until the player accepts. Mirrors {@link ProfilePopup}'s style
 * (dimmed backdrop + centred hand-drawn card, own PIXI `interactive` taps) but is
 * a full Scene so it can be `manager.goto`'d before any other screen — no telemetry
 * leaves the device and the lobby is unreachable until `onAccept` fires.
 *
 * The privacy-policy / terms links open the hosted legal pages in a new browser
 * tab (`/privacy.html`, `/terms.html`), matching the marketing site's footer.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import type { Scene } from '../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from './sketchUi';
import { snapFont } from './fontScale';
import { t } from '../i18n';

export interface ConsentCallbacks {
  /** Player accepted — the core records consent (local flag + server) and proceeds. */
  onAccept(): void;
}

export class ConsentDialog implements Scene {
  readonly container: PIXI.Container;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly cb: ConsentCallbacks,
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
    const unit = cardHmin;

    // Build the text nodes first so we can measure their real (wrapped) heights,
    // then lay the card out top-down with explicit gaps and grow it to fit.
    const title = txt(t('consent.title'), snapFont(Math.round(unit * 0.07)), C.dark, true);
    title.anchor.set(0.5, 0);

    const body = makeText(t('consent.body'), {
      fontSize: snapFont(Math.round(unit * 0.04)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, lineHeight: Math.round(unit * 0.06),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.06;      // above the title
    const gapTitleBody = unit * 0.07;
    const blankLine = unit * 0.06;   // the requested blank line before the links
    const linkStep = unit * 0.07;    // baseline-to-baseline of the two links
    const linkH = unit * 0.042 * 1.4; // single monospace line height
    const gapLinkBtn = unit * 0.07;
    const bH = Math.round(unit * 0.12);
    const padBottom = unit * 0.06;

    // Vertical offsets from the card's top edge.
    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;
    const dyLink1 = dyBody + body.height + blankLine;
    const dyLink2 = dyLink1 + linkStep;
    const dyBtn = dyLink2 + linkH + gapLinkBtn;
    const contentH = dyBtn + bH + padBottom;

    const cardH = Math.max(cardHmin, Math.round(contentH));
    const cardY = (h - cardH) / 2;

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 1) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    title.x = w / 2; title.y = cardY + dyTitle;
    this.container.addChild(title);
    body.x = w / 2; body.y = cardY + dyBody;
    this.container.addChild(body);

    // Policy / terms links — clickable, open the hosted legal pages in a new tab.
    this.addLink(t('consent.privacyPolicy'), w / 2, cardY + dyLink1, unit, '/privacy.html');
    this.addLink(t('consent.terms'), w / 2, cardY + dyLink2, unit, '/terms.html');

    // Accept button (only affordance — backdrop tap does NOT dismiss; consent is required).
    const bW = Math.round(cardW * 0.6);
    const bX = cardX + (cardW - bW) / 2;
    const bY = cardY + dyBtn;
    const btn = sketchPanel(bW, bH, { fill: C.green, border: C.dark, width: 2.4, seed: seedFor(bW, bH, 2) });
    btn.x = bX; btn.y = bY;
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointertap', () => this.cb.onAccept());
    this.container.addChild(btn);

    const btnLabel = txt(t('consent.accept'), snapFont(Math.round(bH * 0.4)), 0xffffff, true);
    btnLabel.anchor.set(0.5, 0.5); btnLabel.x = bX + bW / 2; btnLabel.y = bY + bH / 2;
    this.container.addChild(btnLabel);
  }

  /** Add a centred, tappable "· <label>" link that opens `url` in a new browser tab. */
  private addLink(label: string, cx: number, y: number, cardH: number, url: string): void {
    const link = txt('· ' + label, snapFont(Math.round(cardH * 0.042)), C.accent, true);
    link.anchor.set(0.5, 0); link.x = cx; link.y = y;
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointertap', () => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    });
    this.container.addChild(link);
  }
}
