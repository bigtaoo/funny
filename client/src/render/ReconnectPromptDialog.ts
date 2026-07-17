/**
 * ReconnectPromptDialog — "resume your unfinished match?" prompt (login-reconnect-prompt).
 *
 * Shown right after login/save-refresh when the server reports an activeMatch (GET /save,
 * `SaveManager.consumeActiveMatch()`). A self-drawn, blocking full-screen card, structurally
 * identical to {@link ConsentDialog} (dimmed backdrop + centred hand-drawn card, own PIXI
 * `interactive` taps) but with two affordances instead of one — unlike GDPR consent, declining
 * is a normal, expected choice (the player just goes to the lobby).
 */
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from '../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from './sketchUi';
import { snapFont } from './fontScale';
import { t } from '../i18n';

export interface ReconnectPromptCallbacks {
  /** Player chose to resume — caller reconnects into the cached match. */
  onReconnect(): void;
  /** Player declined — caller proceeds to the lobby as usual. */
  onDecline(): void;
}

export class ReconnectPromptDialog implements Scene {
  readonly container: PIXI.Container;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly cb: ReconnectPromptCallbacks,
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
    this.container.addChild(buildPaperBackground('reconnectbg', w, h));

    // Dim the page so the card reads as a modal.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    this.container.addChild(dim);

    // Same orientation-aware minimum-size + grow-to-fit approach as ConsentDialog, scaled 1.5x
    // (all fonts/buttons derive from `unit` below, so bumping cardHmin/cardW scales everything
    // together) — clamped so the card never exceeds the viewport on small screens.
    const SCALE = 1.5;
    const landscape = w > h;
    const cardHmin = landscape
      ? Math.round(Math.min(h * 0.6 * SCALE, h * 0.94))
      : Math.round(Math.min(h * 0.5 * SCALE, w * 0.9 * 0.8 * SCALE, h * 0.94));
    const cardW = landscape
      ? Math.round(Math.min(cardHmin * 1.1, w * 0.7 * SCALE, w * 0.96))
      : Math.round(Math.min(w * 0.9 * SCALE, w * 0.98));
    const cardX = (w - cardW) / 2;
    const unit = cardHmin;

    const title = txt(t('reconnect.title'), snapFont(Math.round(unit * 0.09)), C.dark, true);
    title.anchor.set(0.5, 0);

    const body = new PIXI.Text(t('reconnect.body'), {
      fontSize: snapFont(Math.round(unit * 0.05)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, lineHeight: Math.round(unit * 0.07),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.1;
    const gapTitleBody = unit * 0.08;
    const gapBodyBtn = unit * 0.1;
    const bH = Math.round(unit * 0.16);
    const padBottom = unit * 0.08;

    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;
    const dyBtn = dyBody + body.height + gapBodyBtn;
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

    // Two side-by-side buttons — resume (primary/green) + decline (neutral).
    const bGap = Math.round(cardW * 0.04);
    const bW = Math.round((cardW * 0.72 - bGap) / 2);
    const bY = cardY + dyBtn;
    const bx1 = cardX + cardW / 2 - bGap / 2 - bW;
    const bx2 = cardX + cardW / 2 + bGap / 2;

    const resumeBtn = sketchPanel(bW, bH, { fill: C.green, border: C.dark, width: 2.4, seed: seedFor(bW, bH, 2) });
    resumeBtn.x = bx1; resumeBtn.y = bY;
    resumeBtn.eventMode = 'static';
    resumeBtn.cursor = 'pointer';
    resumeBtn.on('pointertap', () => this.cb.onReconnect());
    this.container.addChild(resumeBtn);
    const resumeLabel = txt(t('reconnect.accept'), snapFont(Math.round(bH * 0.36)), 0xffffff, true);
    resumeLabel.anchor.set(0.5, 0.5); resumeLabel.x = bx1 + bW / 2; resumeLabel.y = bY + bH / 2;
    this.container.addChild(resumeLabel);

    const declineBtn = sketchPanel(bW, bH, { fill: 0xeeeeee, border: C.mid, width: 2.4, seed: seedFor(bW, bH, 3) });
    declineBtn.x = bx2; declineBtn.y = bY;
    declineBtn.eventMode = 'static';
    declineBtn.cursor = 'pointer';
    declineBtn.on('pointertap', () => this.cb.onDecline());
    this.container.addChild(declineBtn);
    const declineLabel = txt(t('reconnect.decline'), snapFont(Math.round(bH * 0.36)), C.dark, true);
    declineLabel.anchor.set(0.5, 0.5); declineLabel.x = bx2 + bW / 2; declineLabel.y = bY + bH / 2;
    this.container.addChild(declineLabel);
  }
}
