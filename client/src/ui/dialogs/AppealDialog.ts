/**
 * AppealDialog — minimal appeal entry (CONTENT_MODERATION_DESIGN.md §5.3): shown when the server rejects
 * a request with ACCOUNT_BANNED or ACCOUNT_MUTED (see AppealPrompt.ts, wired at the ApiClient/WorldApiClient
 * transport layer so every current and future call site gets this for free without per-scene wiring).
 *
 * Structurally the same self-drawn blocking full-screen card as {@link ConsentDialog}/{@link
 * ReconnectPromptDialog}, with a single-line reason field via `cb.openTextInput` (IPlatform.openTextInput,
 * ASSET_PACKAGING §4.3/§4.4 item 1 — a real off-screen `<input>` on web/CrazyGames, `wx.showKeyboard` on
 * WeChat; its value is mirrored into a PIXI text label). Deliberately minimal — no caret blink, no
 * multi-line textarea.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { tapHandler } from '../hits';
import type { IPlatform, ITextInput } from '../../platform/IPlatform';

// Mirrors server/shared/src/social.ts APPEAL_REASON_MAX (500) — not imported: '@nw/shared' resolves to a
// curated browser-safe subset (see client/webpack.config.js) that does not re-export server/shared/src/social.ts,
// same reason FamilyScene/SectScene's send-box inputs hardcode their own maxLength instead of importing one.
const APPEAL_REASON_MAX = 500;

export type AppealCode = 'ACCOUNT_BANNED' | 'ACCOUNT_MUTED';

export interface AppealDialogCallbacks {
  openTextInput: IPlatform['openTextInput'];
  onSubmit(reason: string): Promise<void>;
  onClose(): void;
}

export class AppealDialog implements Scene {
  readonly container: PIXI.Container;
  private textInput: ITextInput | null = null;
  private reasonText = '';
  private reasonLabel!: PIXI.Text;
  private errorLabel!: PIXI.Text;
  private submitBtn!: PIXI.Container;
  private submitting = false;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly code: AppealCode,
    private readonly cb: AppealDialogCallbacks,
  ) {
    this.container = new PIXI.Container();
    this.build();
  }

  update(): void { /* static */ }

  destroy(): void {
    this.closeInput();
    this.container.removeAllListeners();
    this.container.destroy({ children: true });
  }

  private closeInput(): void {
    if (this.textInput) {
      this.textInput.close();
      this.textInput = null;
    }
  }

  private openInput(): void {
    if (this.textInput) return; // already focused — nothing to steal focus from itself
    this.textInput = this.cb.openTextInput({
      value: this.reasonText,
      maxLength: APPEAL_REASON_MAX,
      onInput: (value) => {
        this.reasonText = value;
        this.reasonLabel.text = this.reasonText || t('appeal.placeholder');
      },
      onComplete: () => { this.textInput = null; },
    });
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const reason = this.reasonText.trim();
    if (!reason) {
      this.errorLabel.text = t('appeal.err.empty');
      return;
    }
    this.submitting = true;
    this.errorLabel.text = '';
    try {
      await this.cb.onSubmit(reason);
      this.closeInput();
      this.cb.onClose();
    } catch {
      this.submitting = false;
      this.errorLabel.text = t('appeal.err.failed');
    }
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('appealbg', w, h));

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    // Swallow taps (see FeedbackDialog's 2026-08-09 fix, same reasoning) — AppealDialog is mounted
    // directly on app.stage alongside whatever scene is still live underneath (it can fire from any
    // scene on a network error, not just the lobby), so without this every tap on the backdrop fell
    // through to that scene's own still-active controls.
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);

    const landscape = w > h;
    const cardHmin = landscape ? Math.round(h * 0.7) : Math.round(Math.min(h * 0.62, w * 0.9 * 1.05));
    const cardW = landscape ? Math.round(Math.min(cardHmin * 1.1, w * 0.7)) : Math.round(w * 0.92);
    const cardX = (w - cardW) / 2;
    const unit = cardHmin;

    const title = txt(this.code === 'ACCOUNT_BANNED' ? t('appeal.title.banned') : t('appeal.title.muted'), snapFont(Math.round(unit * 0.07)), C.dark, true);
    title.anchor.set(0.5, 0);

    const body = makeText(t('appeal.body'), {
      fontSize: snapFont(Math.round(unit * 0.04)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, lineHeight: Math.round(unit * 0.055),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.06;
    const gapTitleBody = unit * 0.06;
    const gapBodyInput = unit * 0.07;
    const inputH = Math.round(unit * 0.13);
    const gapInputErr = unit * 0.03;
    const errH = Math.round(unit * 0.05);
    const gapErrBtn = unit * 0.05;
    const bH = Math.round(unit * 0.13);
    const padBottom = unit * 0.06;

    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;
    const dyInput = dyBody + body.height + gapBodyInput;
    const dyErr = dyInput + inputH + gapInputErr;
    const dyBtn = dyErr + errH + gapErrBtn;
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

    // Reason input field (tap → focuses the hidden HTML input; typed text mirrors into reasonLabel).
    const inputW = Math.round(cardW * 0.84);
    const inputX = cardX + (cardW - inputW) / 2;
    const inputY = cardY + dyInput;
    const inputBox = sketchPanel(inputW, inputH, { fill: 0xffffff, border: C.mid, width: 2, seed: seedFor(inputW, inputH, 4) });
    inputBox.x = inputX; inputBox.y = inputY;
    inputBox.eventMode = 'static';
    inputBox.cursor = 'text';
    inputBox.on('pointertap', tapHandler(() => this.openInput()));
    this.container.addChild(inputBox);

    this.reasonLabel = txt(t('appeal.placeholder'), snapFont(Math.round(unit * 0.038)), C.mid);
    this.reasonLabel.anchor.set(0, 0.5);
    this.reasonLabel.x = inputX + Math.round(inputW * 0.03);
    this.reasonLabel.y = inputY + inputH / 2;
    this.reasonLabel.style.wordWrap = true;
    this.reasonLabel.style.wordWrapWidth = inputW * 0.94;
    this.container.addChild(this.reasonLabel);

    this.errorLabel = txt('', snapFont(Math.round(unit * 0.034)), C.red);
    this.errorLabel.anchor.set(0.5, 0);
    this.errorLabel.x = w / 2; this.errorLabel.y = cardY + dyErr;
    this.container.addChild(this.errorLabel);

    // Submit / cancel buttons.
    const bGap = Math.round(cardW * 0.04);
    const bW = Math.round((cardW * 0.72 - bGap) / 2);
    const bY = cardY + dyBtn;
    const bx1 = cardX + cardW / 2 - bGap / 2 - bW;
    const bx2 = cardX + cardW / 2 + bGap / 2;

    this.submitBtn = sketchPanel(bW, bH, { fill: C.green, border: C.dark, width: 2.4, seed: seedFor(bW, bH, 2) });
    this.submitBtn.x = bx1; this.submitBtn.y = bY;
    this.submitBtn.eventMode = 'static';
    this.submitBtn.cursor = 'pointer';
    this.submitBtn.on('pointertap', tapHandler(() => void this.submit()));
    this.container.addChild(this.submitBtn);
    const submitLabel = txt(t('appeal.submit'), snapFont(Math.round(bH * 0.36)), 0xffffff, true);
    submitLabel.anchor.set(0.5, 0.5); submitLabel.x = bx1 + bW / 2; submitLabel.y = bY + bH / 2;
    this.container.addChild(submitLabel);

    const cancelBtn = sketchPanel(bW, bH, { fill: 0xeeeeee, border: C.mid, width: 2.4, seed: seedFor(bW, bH, 3) });
    cancelBtn.x = bx2; cancelBtn.y = bY;
    cancelBtn.eventMode = 'static';
    cancelBtn.cursor = 'pointer';
    cancelBtn.on('pointertap', tapHandler(() => { this.closeInput(); this.cb.onClose(); }, 'sfx.ui.back'));
    this.container.addChild(cancelBtn);
    const cancelLabel = txt(t('appeal.cancel'), snapFont(Math.round(bH * 0.36)), C.dark, true);
    cancelLabel.anchor.set(0.5, 0.5); cancelLabel.x = bx2 + bW / 2; cancelLabel.y = bY + bH / 2;
    this.container.addChild(cancelLabel);
  }
}
