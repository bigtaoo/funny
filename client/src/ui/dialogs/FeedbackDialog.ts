/**
 * FeedbackDialog — in-game player feedback entry (UI_DESIGN.md §4.1.1): opened from the lobby's right-side
 * strip (replacing the low-usage achievement shortcut there). Structurally the same self-drawn blocking
 * full-screen card as {@link AppealDialog}, reusing its hidden-`<input>`-overlay text capture technique.
 * Unlike AppealDialog it uses the caret-blink unified field treatment (see `ui/inputDisplay.ts`,
 * SettingsScene's rename field) since feedback is a longer, multi-line note, not a one-shot reason string.
 *
 * Unlike AppealDialog, a successful submit does NOT close the dialog — it clears the input and shows an
 * inline "received, thanks" confirmation, so the player can send another note without reopening the panel
 * (feedback has no "one open ticket" model, unlike an appeal).
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { caretDisplay } from '../inputDisplay';

// Mirrors server/shared/src/social.ts FEEDBACK_TEXT_MAX (1000) — not imported: '@nw/shared' resolves to a
// curated browser-safe subset (see client/webpack.config.js), same reason AppealDialog hardcodes its own max.
const FEEDBACK_TEXT_MAX = 1000;

export interface FeedbackDialogCallbacks {
  onSubmit(text: string): Promise<void>;
  onClose(): void;
}

export class FeedbackDialog implements Scene {
  readonly container: PIXI.Container;
  private hiddenInput: HTMLInputElement | null = null;
  private feedbackText = '';
  private feedbackLabel!: PIXI.Text;
  private statusLabel!: PIXI.Text;
  private submitBtn!: PIXI.Container;
  private submitting = false;
  private inputActive = false;
  private caretOn = true;
  private caretTimer = 0;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly cb: FeedbackDialogCallbacks,
  ) {
    this.container = new PIXI.Container();
    this.build();
  }

  update(dt: number): void {
    if (!this.inputActive) return;
    this.caretTimer += dt;
    if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.refreshLabel(); }
  }

  destroy(): void {
    this.removeHiddenInput();
    this.container.removeAllListeners();
    this.container.destroy({ children: true });
  }

  private removeHiddenInput(): void {
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
  }

  /** Mirrors the caretDisplay() convention (ui/inputDisplay.ts, SettingsScene rename field): show a
   *  blinking '|' while focused, dark text once something's typed, mid-grey placeholder otherwise. */
  private refreshLabel(): void {
    this.feedbackLabel.text = caretDisplay(this.feedbackText, this.inputActive && this.caretOn, t('feedback.placeholder'));
    this.feedbackLabel.style.fill = (this.feedbackText || (this.inputActive && this.caretOn)) ? C.dark : C.mid;
  }

  private openInput(): void {
    this.inputActive = true;
    this.caretOn = true; this.caretTimer = 0;
    this.refreshLabel();
    if (this.hiddenInput) { this.hiddenInput.focus(); return; }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = FEEDBACK_TEXT_MAX;
    inp.value = this.feedbackText;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.addEventListener('input', () => {
      this.feedbackText = inp.value;
      this.refreshLabel();
      if (this.statusLabel.text) this.statusLabel.text = ''; // typing again clears any prior status message
    });
    inp.addEventListener('blur', () => {
      this.inputActive = false;
      this.refreshLabel();
      this.removeHiddenInput();
    });
    document.body.appendChild(inp);
    inp.focus();
    this.hiddenInput = inp;
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const text = this.feedbackText.trim();
    if (!text) {
      this.statusLabel.style.fill = C.red;
      this.statusLabel.text = t('feedback.err.empty');
      return;
    }
    this.submitting = true;
    this.statusLabel.text = '';
    try {
      await this.cb.onSubmit(text);
      // Stays open (unlike AppealDialog's onClose) — feedback allows repeated submissions.
      this.feedbackText = '';
      this.refreshLabel();
      this.statusLabel.style.fill = C.green;
      this.statusLabel.text = t('feedback.sent');
    } catch {
      this.statusLabel.style.fill = C.red;
      this.statusLabel.text = t('feedback.err.failed');
    } finally {
      this.submitting = false;
    }
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('feedbackbg', w, h));

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    // Swallow taps so they don't fall through to the Lobby underneath (same pattern as
    // SceneManager's fade overlay) — this dim layer never blocked hit-testing before, so every
    // tap on it passed straight through to whatever Lobby control sits at that screen position.
    // Bug is orientation-agnostic, but only showed up in portrait because that's where the Lobby's
    // bottom nav happens to sit directly behind the card; landscape had nothing clickable there.
    // NOTE this only covers PixiJS hit-testing, which is the *minority* path: the Lobby routes taps
    // through the InputManager, fed straight from DOM listeners (WebAdapter), which no display
    // object can block. App.ts raises `input.holdForModal(true)` for the dialog's whole lifetime for
    // that half — see InputManager.modals. Both are needed; neither subsumes the other.
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);

    const landscape = w > h;
    const cardHmin = landscape ? Math.round(h * 0.7) : Math.round(Math.min(h * 0.62, w * 0.9 * 1.05));
    const cardW = landscape ? Math.round(Math.min(cardHmin * 1.1, w * 0.7)) : Math.round(w * 0.92);
    const cardX = (w - cardW) / 2;
    const unit = cardHmin;

    const title = txt(t('feedback.title'), snapFont(Math.round(unit * 0.07)), C.dark, true);
    title.anchor.set(0.5, 0);

    const body = makeText(t('feedback.body'), {
      fontSize: snapFont(Math.round(unit * 0.04)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: cardW * 0.84, breakWords: true, lineHeight: Math.round(unit * 0.055),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.06;
    const gapTitleBody = unit * 0.06;
    const gapBodyInput = unit * 0.07;
    // At least 3 visible lines (user ask 2026-08-08): pad top/bottom + 3× line height, vs. the
    // single-line 0.13×unit every other sketchPanel field in this dialog family uses.
    const feedbackLineH = Math.round(unit * 0.052);
    const inputPadY = Math.round(unit * 0.025);
    const inputH = Math.round(inputPadY * 2 + feedbackLineH * 3);
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

    // Feedback input field (tap → focuses the hidden HTML input; typed text mirrors into feedbackLabel).
    const inputW = Math.round(cardW * 0.84);
    const inputX = cardX + (cardW - inputW) / 2;
    const inputY = cardY + dyInput;
    const inputBox = sketchPanel(inputW, inputH, { fill: 0xffffff, border: C.mid, width: 2, seed: seedFor(inputW, inputH, 4) });
    inputBox.x = inputX; inputBox.y = inputY;
    inputBox.eventMode = 'static';
    inputBox.cursor = 'text';
    inputBox.on('pointertap', () => this.openInput());
    this.container.addChild(inputBox);

    // Top-anchored (not vertically centered) so a growing multi-line note fills the box downward,
    // same as the paragraph fields elsewhere; caretDisplay() appends the blinking '|' (ui/inputDisplay.ts).
    this.feedbackLabel = txt(caretDisplay('', false, t('feedback.placeholder')), snapFont(Math.round(unit * 0.038)), C.mid);
    this.feedbackLabel.anchor.set(0, 0);
    this.feedbackLabel.x = inputX + Math.round(inputW * 0.03);
    this.feedbackLabel.y = inputY + inputPadY;
    this.feedbackLabel.style.wordWrap = true;
    this.feedbackLabel.style.wordWrapWidth = inputW * 0.94;
    this.feedbackLabel.style.breakWords = true;
    this.feedbackLabel.style.lineHeight = feedbackLineH;
    this.container.addChild(this.feedbackLabel);

    this.statusLabel = txt('', snapFont(Math.round(unit * 0.034)), C.red);
    this.statusLabel.anchor.set(0.5, 0);
    this.statusLabel.x = w / 2; this.statusLabel.y = cardY + dyErr;
    this.container.addChild(this.statusLabel);

    // Submit / close buttons.
    const bGap = Math.round(cardW * 0.04);
    const bW = Math.round((cardW * 0.72 - bGap) / 2);
    const bY = cardY + dyBtn;
    const bx1 = cardX + cardW / 2 - bGap / 2 - bW;
    const bx2 = cardX + cardW / 2 + bGap / 2;

    this.submitBtn = sketchPanel(bW, bH, { fill: C.green, border: C.dark, width: 2.4, seed: seedFor(bW, bH, 2) });
    this.submitBtn.x = bx1; this.submitBtn.y = bY;
    this.submitBtn.eventMode = 'static';
    this.submitBtn.cursor = 'pointer';
    this.submitBtn.on('pointertap', () => void this.submit());
    this.container.addChild(this.submitBtn);
    const submitLabel = txt(t('feedback.submit'), snapFont(Math.round(bH * 0.36)), 0xffffff, true);
    submitLabel.anchor.set(0.5, 0.5); submitLabel.x = bx1 + bW / 2; submitLabel.y = bY + bH / 2;
    this.container.addChild(submitLabel);

    const closeBtn = sketchPanel(bW, bH, { fill: 0xeeeeee, border: C.mid, width: 2.4, seed: seedFor(bW, bH, 3) });
    closeBtn.x = bx2; closeBtn.y = bY;
    closeBtn.eventMode = 'static';
    closeBtn.cursor = 'pointer';
    closeBtn.on('pointertap', () => { this.removeHiddenInput(); this.cb.onClose(); });
    this.container.addChild(closeBtn);
    const closeLabel = txt(t('feedback.close'), snapFont(Math.round(bH * 0.36)), C.dark, true);
    closeLabel.anchor.set(0.5, 0.5); closeLabel.x = bx2 + bW / 2; closeLabel.y = bY + bH / 2;
    this.container.addChild(closeLabel);
  }
}
