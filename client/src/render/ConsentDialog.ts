/**
 * ConsentDialog — first-launch GDPR / privacy consent gate (C5-c, L1-1).
 *
 * A self-drawn, blocking full-screen card shown before the lobby on first launch
 * (or after login) until the player accepts. Mirrors {@link ProfilePopup}'s style
 * (dimmed backdrop + centred hand-drawn card, own PIXI `interactive` taps) but is
 * a full Scene so it can be `manager.goto`'d before any other screen — no telemetry
 * leaves the device and the lobby is unreachable until `onAccept` fires.
 *
 * The privacy-policy / terms links are i18n placeholders for now; Track 3 supplies
 * the real copy + URLs. They render as styled, display-only lines (no dead links).
 */
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from '../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from './sketchUi';
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
    // portrait off 90% of the width. No hard pixel cap — every inner element is
    // computed from cardW/cardH, so the whole card scales together.
    const landscape = w > h;
    const cardH = landscape
      ? Math.round(h * 0.8)
      : Math.round(Math.min(h * 0.72, w * 0.9 * 1.15));
    const cardW = landscape
      ? Math.round(Math.min(cardH * 0.95, w * 0.7))
      : Math.round(w * 0.9);
    const cardX = (w - cardW) / 2;
    const cardY = (h - cardH) / 2;

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 1) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    // Title.
    const title = txt(t('consent.title'), Math.round(cardH * 0.07), C.dark, true);
    title.anchor.set(0.5, 0); title.x = w / 2; title.y = cardY + cardH * 0.06;
    this.container.addChild(title);

    // Body — wrapped intro paragraph (real copy pending Track 3).
    const body = new PIXI.Text(t('consent.body'), {
      fontSize: Math.round(cardH * 0.04), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, lineHeight: Math.round(cardH * 0.06),
    });
    body.anchor.set(0.5, 0); body.x = w / 2; body.y = cardY + cardH * 0.2;
    this.container.addChild(body);

    // Policy / terms links (display-only placeholders).
    const linkY = cardY + cardH * 0.66;
    const policy = txt('· ' + t('consent.privacyPolicy'), Math.round(cardH * 0.042), C.accent, true);
    policy.anchor.set(0.5, 0); policy.x = w / 2; policy.y = linkY;
    this.container.addChild(policy);
    const terms = txt('· ' + t('consent.terms'), Math.round(cardH * 0.042), C.accent, true);
    terms.anchor.set(0.5, 0); terms.x = w / 2; terms.y = linkY + cardH * 0.07;
    this.container.addChild(terms);

    // Accept button (only affordance — backdrop tap does NOT dismiss; consent is required).
    const bW = Math.round(cardW * 0.6);
    const bH = Math.round(cardH * 0.12);
    const bX = cardX + (cardW - bW) / 2;
    const bY = cardY + cardH - bH - cardH * 0.06;
    const btn = sketchPanel(bW, bH, { fill: C.green, border: C.dark, width: 2.4, seed: seedFor(bW, bH, 2) });
    btn.x = bX; btn.y = bY;
    btn.interactive = true;
    btn.cursor = 'pointer';
    btn.on('pointertap', () => this.cb.onAccept());
    this.container.addChild(btn);

    const btnLabel = txt(t('consent.accept'), Math.round(bH * 0.4), 0xffffff, true);
    btnLabel.anchor.set(0.5, 0.5); btnLabel.x = bX + bW / 2; btnLabel.y = bY + bH / 2;
    this.container.addChild(btnLabel);
  }
}
