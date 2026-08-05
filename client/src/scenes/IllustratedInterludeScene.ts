import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { buildPaperBackground, ui } from '../render/sketchUi';
import { FS } from '../render/fontScale';
import { getArtTexture } from '../render/cardArt';

// ── Chapter-end "real layer" interlude (Tao/Anna) ──────────────────────────────
//
// Generic full-bleed illustrated beat, one per campaign chapter (world.md「章末真实层」).
// Shown after the result panel, before returning to the campaign map — see
// `chapter-interlude-art-prompts.md` for the six illustrations and their prompts.
//
// Mechanically this is IntroScene's fade/auto-advance/skip loop, generalized: instead of a
// fixed 7-key array with the art as a 0.6-alpha backdrop behind centered text, this takes a
// single illustration + a single i18n key whose value is '\n'-separated into beats. The
// illustration is shown at full opacity (it's the point, not atmosphere) and every prompt in
// chapter-interlude-art-prompts.md deliberately leaves the upper third of the frame plain —
// that's where the narration lives, one beat at a time, replacing itself rather than stacking.

const FADE_DURATION = 0.8; // seconds per beat's fade-in
const AUTO_ADVANCE_DELAY = 5; // seconds a fully-shown beat waits before advancing itself
const ILLUSTRATION_FADE_DURATION = 0.6;
/** Fraction of the frame height reserved for narration — matches the art's blank upper band. */
const TEXT_BAND_HEIGHT_FRAC = 0.3;

export interface IllustratedInterludeCallbacks {
  /** @param skipped true when the player tapped the skip button instead of reading through. */
  onFinish(skipped?: boolean): void;
}

export class IllustratedInterludeScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: IllustratedInterludeCallbacks;
  private readonly beats: string[];

  private currentIndex   = 0;
  private fadeT          = 0;       // current beat's fade progress (seconds)
  private settledT       = 0;       // seconds the current beat has been fully visible
  private illustration!: PIXI.Sprite;
  private illustrationFadeT = 0;
  private lineText!:    PIXI.Text;
  private hintText!:    PIXI.Text;
  private hintPulse     = 0;
  private skipRect:     Rect = { x: 0, y: 0, w: 0, h: 0 };
  private finished      = false;

  private readonly unsubs: Array<() => void> = [];

  constructor(
    layout: ILayout,
    input: InputManager,
    illustrationUrl: string,
    textKey: TranslationKey,
    cb: IllustratedInterludeCallbacks,
  ) {
    this.container = new PIXI.Container();
    this.w  = layout.designWidth;
    this.h  = layout.designHeight;
    this.cb = cb;
    this.beats = t(textKey).split('\n').map((s) => s.trim()).filter(Boolean);
    this.build(illustrationUrl);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
  }

  // ── Scene interface ────────────────────────────────────────────────────────

  update(dt: number): void {
    this.illustrationFadeT += dt;
    this.illustration.alpha = Math.min(1, this.illustrationFadeT / ILLUSTRATION_FADE_DURATION);

    const isLastBeat = this.currentIndex === this.beats.length - 1;
    if (this.lineText.alpha < 1) {
      this.fadeT += dt;
      this.lineText.alpha = Math.min(1, this.fadeT / FADE_DURATION);
      if (this.lineText.alpha >= 1) this.settledT = 0; // just finished fading — restart the idle countdown
    } else if (!isLastBeat) {
      this.settledT += dt;
      if (this.settledT >= AUTO_ADVANCE_DELAY) {
        this.settledT = 0;
        this.step();
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

    this.step();
  }

  /**
   * One step forward: completes the current beat's fade if still in progress, otherwise swaps in
   * the next beat (or finishes on the last one). Shared by taps (handleDown) and the automatic
   * per-beat timeout in update() — a tap just does early what the timeout would do anyway.
   */
  private step(): void {
    if (this.lineText.alpha < 1) {
      this.lineText.alpha = 1;
      this.settledT = 0;
    } else if (this.currentIndex < this.beats.length - 1) {
      this.currentIndex++;
      this.showBeat(this.currentIndex);
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

  private showBeat(index: number): void {
    this.lineText.text = this.beats[index] ?? '';
    this.lineText.alpha = 0;
    this.fadeT = 0;
    this.settledT = 0;
  }

  private build(illustrationUrl: string): void {
    const { w, h } = this;

    // Notebook-paper backstop, in case the illustration texture is still loading.
    this.container.addChild(buildPaperBackground('interludebg', w, h));

    // Full-bleed illustration — the point of this scene, so it fades to full opacity (unlike
    // IntroScene's 0.6-alpha backdrop) rather than staying a subtle backing layer.
    const illustrationTex = getArtTexture(illustrationUrl);
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

    // Narration — one beat at a time, centered in the upper band every interlude illustration
    // deliberately leaves plain (see chapter-interlude-art-prompts.md's "upper third stays
    // blank" instruction in every prompt).
    const bandH = h * TEXT_BAND_HEIGHT_FRAC;
    const fontSize = FS.heading;
    this.lineText = makeText('', {
      fontSize,
      fill: ui.dark,
      fontFamily: 'serif',
      wordWrap: true,
      wordWrapWidth: w * 0.82,
      align: 'center',
      lineHeight: Math.round(fontSize * 1.4),
    });
    this.lineText.anchor.set(0.5, 0.5);
    this.lineText.x = w / 2;
    this.lineText.y = Math.round(bandH * 0.55);
    this.lineText.alpha = 0;
    this.container.addChild(this.lineText);
    this.showBeat(0);

    // Tap-to-continue hint — kept inside the same blank band so it never has to compete for
    // legibility against whatever is drawn in the illustration itself.
    this.hintText = makeText(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: ui.mid,
      fontFamily: 'monospace',
    });
    this.hintText.anchor.set(0.5, 1);
    this.hintText.x = w / 2;
    this.hintText.y = Math.round(bandH * 0.94);
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
