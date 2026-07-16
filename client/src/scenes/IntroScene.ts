import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { buildPaperBackground, ui } from '../render/sketchUi';
import { FS } from '../render/fontScale';

// ── First-launch intro (background story) ─────────────────────────────────────
//
// Skeleton for the onboarding story sequence, shown once on first launch
// (driven by the `nw_seen_intro` storage flag in app.ts).
//
// Current behavior: story lines fade in one by one; a tap reveals the next
// line (or instantly completes the current fade); after the last line, any
// tap finishes. A skip button is always available in the top-right corner.
//
// To extend with full animation later: add per-line PIXI containers /
// stickman runtimes here, keep the line-advance + skip flow, and keep all
// copy in the i18n `story.*` namespace.

const STORY_LINE_KEYS: TranslationKey[] = [
  'story.line.1',
  'story.line.2',
  'story.line.3',
  'story.line.4',
];

const FADE_DURATION = 0.8; // seconds per line fade-in

export interface IntroSceneCallbacks {
  /** @param skipped true when the player tapped the skip button instead of reading through. */
  onFinish(skipped?: boolean): void;
}

export class IntroScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: IntroSceneCallbacks;

  private lines:      PIXI.Text[] = [];
  private shownCount  = 0;       // lines fully requested so far
  private fadeT       = 0;       // current line fade progress (seconds)
  private hintText!:  PIXI.Text;
  private hintPulse   = 0;
  private skipRect:   Rect = { x: 0, y: 0, w: 0, h: 0 };
  private finished    = false;

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
    // Advance current line fade
    if (this.shownCount > 0 && this.shownCount <= this.lines.length) {
      const line = this.lines[this.shownCount - 1]!;
      if (line.alpha < 1) {
        this.fadeT += dt;
        line.alpha = Math.min(1, this.fadeT / FADE_DURATION);
      }
    }

    // Pulse the "tap to continue" hint
    this.hintPulse += dt;
    this.hintText.alpha = 0.5 + 0.4 * Math.sin(this.hintPulse * 3);
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

    const current = this.lines[this.shownCount - 1];
    if (current && current.alpha < 1) {
      // Complete the in-progress fade instantly
      current.alpha = 1;
    } else if (this.shownCount < this.lines.length) {
      // Reveal next line
      this.shownCount++;
      this.fadeT = 0;
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

    // Story lines, vertically centered as a block
    const fontSize  = FS.heading;
    const lineGapY  = Math.round(h * 0.085);
    const blockH    = (STORY_LINE_KEYS.length - 1) * lineGapY;
    const startY    = (h - blockH) / 2 - h * 0.05;

    STORY_LINE_KEYS.forEach((key, i) => {
      const text = new PIXI.Text(t(key), {
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
    this.hintText = new PIXI.Text(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: ui.mid,
      fontFamily: 'monospace',
    });
    this.hintText.anchor.set(0.5, 1);
    this.hintText.x = w / 2;
    this.hintText.y = h * 0.92;
    this.container.addChild(this.hintText);

    // Skip button (top-right)
    const skipText = new PIXI.Text(t('story.skip'), {
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
