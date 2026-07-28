import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { buildPaperBackground, ui } from '../render/sketchUi';
import { FS } from '../render/fontScale';
import { getArtTexture } from '../render/cardArt';
import introIllustrationUrl from '../assets/story/intro_notebook.png';

// ── First-launch intro (background story) ─────────────────────────────────────
//
// Skeleton for the onboarding story sequence, shown once on first launch
// (driven by the `nw_seen_intro` storage flag in app.ts).
//
// Current behavior: story lines fade in one by one; a tap reveals the next
// line instantly (or completes the current fade). A line left untouched
// still advances on its own after AUTO_ADVANCE_DELAY seconds, so the reader
// doesn't have to keep tapping — EXCEPT the last line, which stays on screen
// until an explicit tap: this scene feeds into the consent/privacy gate
// (gateConsent in auth.ts), and auto-finishing into that would fly by before
// anyone could actually read the ending. A skip button is always available
// in the top-right corner. A background illustration (father handing Tao the
// notebook) fades in alongside story.line.3 and then stays at
// ILLUSTRATION_TARGET_ALPHA behind the rest of the text.
//
// To extend with full animation later: add per-line PIXI containers /
// stickman runtimes here, keep the line-advance + skip flow, and keep all
// copy in the i18n `story.*` namespace.

const STORY_LINE_KEYS: TranslationKey[] = [
  'story.line.1',
  'story.line.2',
  'story.line.3',
  'story.line.4',
  'story.line.5',
  'story.line.6',
  'story.line.7',
];

const FADE_DURATION = 0.8; // seconds per line fade-in
const AUTO_ADVANCE_DELAY = 5; // seconds a fully-shown line waits before advancing itself
/** 0-indexed — story.line.3, "生日那天，父亲递给他一个笔记本". */
const ILLUSTRATION_LINE_INDEX = 2;
const ILLUSTRATION_TARGET_ALPHA = 0.6;

export interface IntroSceneCallbacks {
  /** @param skipped true when the player tapped the skip button instead of reading through. */
  onFinish(skipped?: boolean): void;
}

export class IntroScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: IntroSceneCallbacks;

  private lines:        PIXI.Text[] = [];
  private shownCount    = 0;       // lines fully requested so far
  private fadeT         = 0;       // current line fade progress (seconds)
  private settledT      = 0;       // seconds the current line has been fully visible (drives auto-advance)
  private illustration!: PIXI.Sprite;
  private hintText!:    PIXI.Text;
  private hintPulse     = 0;
  private skipRect:     Rect = { x: 0, y: 0, w: 0, h: 0 };
  private finished      = false;

  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: IntroSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.cb = cb;
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.shownCount = 1; // start fading in the first line immediately
  }

  // ── Scene interface ────────────────────────────────────────────────────────

  update(dt: number): void {
    // Advance current line fade; once fully shown, count down to an automatic step() so the
    // reader doesn't have to keep tapping. The last line is the one exception — it waits for an
    // explicit tap instead of auto-finishing into the consent/privacy gate that follows this scene.
    if (this.shownCount > 0 && this.shownCount <= this.lines.length) {
      const line = this.lines[this.shownCount - 1]!;
      const isLastLine = this.shownCount === this.lines.length;
      if (line.alpha < 1) {
        this.fadeT += dt;
        line.alpha = Math.min(1, this.fadeT / FADE_DURATION);
        if (line.alpha >= 1) this.settledT = 0; // just finished fading — start the idle countdown fresh
      } else if (!isLastLine) {
        this.settledT += dt;
        if (this.settledT >= AUTO_ADVANCE_DELAY) {
          this.settledT = 0;
          this.step();
        }
      }
    }

    this.syncIllustrationAlpha();

    // Pulse the "tap to continue" hint
    this.hintPulse += dt;
    this.hintText.alpha = 0.5 + 0.4 * Math.sin(this.hintPulse * 3);
  }

  /** Keeps the background illustration's alpha tied to story.line.3's fade, then holds it. */
  private syncIllustrationAlpha(): void {
    const idx = this.shownCount - 1;
    if (idx < ILLUSTRATION_LINE_INDEX) {
      this.illustration.alpha = 0;
    } else if (idx === ILLUSTRATION_LINE_INDEX) {
      this.illustration.alpha = this.lines[idx]!.alpha * ILLUSTRATION_TARGET_ALPHA;
    } else {
      this.illustration.alpha = ILLUSTRATION_TARGET_ALPHA;
    }
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.finished) return;

    // Skip button
    if (x >= this.skipRect.x && x <= this.skipRect.x + this.skipRect.w &&
        y >= this.skipRect.y && y <= this.skipRect.y + this.skipRect.h) {
      this.finish(true);
      return;
    }

    this.step();
  }

  /**
   * One step forward: completes the current line's fade if still in progress, otherwise reveals
   * the next line (or finishes on the last one). Shared by taps (handleDown) and the automatic
   * per-line timeout in update() — a tap just does early what the timeout would do anyway.
   */
  private step(): void {
    const current = this.lines[this.shownCount - 1];
    if (current && current.alpha < 1) {
      current.alpha = 1;
      this.settledT = 0;
    } else if (this.shownCount < this.lines.length) {
      this.shownCount++;
      this.fadeT = 0;
      this.settledT = 0;
    } else {
      this.finish();
    }
  }

  private finish(skipped = false): void {
    if (this.finished) return;
    this.finished = true;
    this.cb.onFinish(skipped);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private build(): void {
    const { w, h } = this;

    // Notebook-paper background (shared hand-drawn page, baked per size).
    this.container.addChild(buildPaperBackground('introbg', w, h));

    // Real-layer illustration (father hands Tao the notebook) — sits above the paper background
    // and below the text, alpha synced to story.line.3's fade-in by syncIllustrationAlpha().
    const illustrationTex = getArtTexture(introIllustrationUrl);
    this.illustration = new PIXI.Sprite(illustrationTex);
    this.illustration.alpha = 0;
    this.illustration.anchor.set(0.5, 0.5);
    this.illustration.x = w / 2;
    this.illustration.y = h / 2;
    const fitIllustration = (): void => {
      const scale = Math.max(w / illustrationTex.width, h / illustrationTex.height);
      this.illustration.scale.set(scale);
    };
    if (illustrationTex.baseTexture.valid) fitIllustration();
    else illustrationTex.baseTexture.once('loaded', fitIllustration);
    this.container.addChild(this.illustration);

    // Story lines, vertically centered as a block
    const fontSize  = FS.heading;
    const lineGapY  = Math.round(h * 0.085);
    const blockH    = (STORY_LINE_KEYS.length - 1) * lineGapY;
    const startY    = (h - blockH) / 2 - h * 0.05;

    STORY_LINE_KEYS.forEach((key, i) => {
      const text = makeText(t(key), {
        fontSize,
        fill: ui.dark,
        fontFamily: 'serif',
        wordWrap: true,
        wordWrapWidth: w * 0.78,
        align: 'center',
        lineHeight: Math.round(fontSize * 1.5),
      });
      text.anchor.set(0.5, 0.5);
      text.x = w / 2;
      text.y = startY + i * lineGapY;
      text.alpha = 0;
      this.container.addChild(text);
      this.lines.push(text);
    });

    // Tap-to-continue hint
    this.hintText = makeText(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: ui.mid,
      fontFamily: 'monospace',
    });
    this.hintText.anchor.set(0.5, 1);
    this.hintText.x = w / 2;
    this.hintText.y = h * 0.92;
    this.container.addChild(this.hintText);

    // Skip button (top-right)
    const skipText = makeText(t('story.skip'), {
      fontSize: FS.label,
      fill: ui.mid,
      fontFamily: 'monospace',
    });
    skipText.anchor.set(1, 0);
    skipText.x = w - Math.round(w * 0.04);
    skipText.y = Math.round(h * 0.03);
    this.container.addChild(skipText);

    // Generous hit area around the skip label
    const pad = Math.round(h * 0.015);
    this.skipRect = {
      x: skipText.x - skipText.width - pad,
      y: skipText.y - pad,
      w: skipText.width + pad * 2,
      h: skipText.height + pad * 2,
    };
  }
}
