import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { buildPaperBackground, ui } from '../render/sketchUi';
import { FS } from '../render/fontScale';
import { getArtTexture } from '../render/cardArt';
import { dispatchHit } from '../ui/hits';

// ── Chapter-end "real layer" interlude (Tao/Anna) ──────────────────────────────
//
// Generic full-bleed illustrated beat, one per campaign chapter (world.md「章末真实层」).
// Shown after the result panel, before returning to the campaign map — see
// `chapter-interlude-art-prompts.md` for the six illustrations and their prompts.
//
// Mechanically this is IntroScene's fade/auto-advance/skip loop, generalized: instead of a
// fixed 7-key array of PIXI.Text objects, this takes a single illustration + a single i18n key
// whose value is '\n'-separated into beats, one PIXI.Text per beat built upfront. The
// illustration is shown at full opacity (it's the point, not atmosphere), and — like
// IntroScene — beats fade in one at a time and STACK rather than replace each other, so by the
// last beat the whole passage is still on screen and reads as one continuous piece, the same way
// the opening story does.

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

  private lines:          PIXI.Text[] = [];
  private shownCount     = 0;       // beats fully requested so far
  private fadeT          = 0;       // current beat's fade progress (seconds)
  private settledT       = 0;       // seconds the current beat has been fully visible
  private illustration!: PIXI.Sprite;
  private illustrationFadeT = 0;
  private hintText!:    PIXI.Text;
  private hintPulse     = 0;
  private skipRect:     Rect = { x: 0, y: 0, w: 0, h: 0 };
  private finished      = false;
  private destroyed     = false;

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
    this.shownCount = 1; // start fading in the first beat immediately
  }

  // ── Scene interface ────────────────────────────────────────────────────────

  update(dt: number): void {
    this.illustrationFadeT += dt;
    this.illustration.alpha = Math.min(1, this.illustrationFadeT / ILLUSTRATION_FADE_DURATION);

    if (this.shownCount > 0 && this.shownCount <= this.lines.length) {
      const line = this.lines[this.shownCount - 1]!;
      const isLastBeat = this.shownCount === this.lines.length;
      if (line.alpha < 1) {
        this.fadeT += dt;
        line.alpha = Math.min(1, this.fadeT / FADE_DURATION);
        if (line.alpha >= 1) this.settledT = 0; // just finished fading — restart the idle countdown
      } else if (!isLastBeat) {
        this.settledT += dt;
        if (this.settledT >= AUTO_ADVANCE_DELAY) {
          this.settledT = 0;
          this.step();
        }
      }
    }

    // Pulse the "tap to continue" hint
    this.hintPulse += dt;
    this.hintText.alpha = 0.5 + 0.4 * Math.sin(this.hintPulse * 3);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.finished) return;

    // Skip button — the only actual BUTTON on this screen, so the only thing here that sounds.
    // The bare tap below is a story advance ("tap to continue"): no chrome, whole screen, and it
    // does early exactly what the per-beat timeout would have done anyway — a cue there would read
    // as the story clicking at the player (AUDIO_DESIGN.md §2.2, and the allowlist entry in
    // test/uiTapSoundCoverage.test.ts for ResultScene's identical outro surface).
    if (dispatchHit([{ rect: this.skipRect, sound: 'sfx.ui.back', fn: () => this.finish(true) }], x, y)) return;

    this.step();
  }

  /**
   * One step forward: completes the current beat's fade if still in progress, otherwise reveals
   * the next beat (or finishes on the last one). Shared by taps (handleDown) and the automatic
   * per-beat timeout in update() — a tap just does early what the timeout would do anyway.
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
      // The texture can finish decoding after this scene was torn down (tap straight through the
      // interlude on a cold cache) — touching a destroyed Sprite throws from inside a PIXI Runner
      // on the shared ticker, which kills Ticker.shared and freezes the canvas until a page reload.
      // See 菜单场景生命周期契约 in claudedocs/client-modules.md.
      if (this.destroyed) return;
      const scale = Math.max(w / illustrationTex.width, h / illustrationTex.height);
      this.illustration.scale.set(scale);
    };
    if (illustrationTex.baseTexture.valid) fitIllustration();
    else {
      const base = illustrationTex.baseTexture;
      base.once('loaded', fitIllustration);
      this.unsubs.push(() => base.off('loaded', fitIllustration));
    }
    this.container.addChild(this.illustration);

    // Narration — one beat revealed at a time, stacking downward from the top of the blank band
    // every interlude illustration deliberately leaves plain (see chapter-interlude-art-prompts.md's
    // "upper third stays blank" instruction in every prompt). Mirrors IntroScene: all beats are
    // built upfront as separate PIXI.Text objects, so once every beat has faded in the passage
    // reads top-to-bottom as one continuous piece instead of vanishing behind the next line.
    const bandH = h * TEXT_BAND_HEIGHT_FRAC;
    const fontSize = FS.heading;
    const lineGapY = Math.round(fontSize * 1.7);
    const startY = Math.round(bandH * 0.32);

    this.beats.forEach((beat, i) => {
      const text = makeText(beat, {
        fontSize,
        fill: ui.dark,
        fontFamily: 'serif',
        wordWrap: true,
        wordWrapWidth: w * 0.82,
        align: 'center',
        lineHeight: Math.round(fontSize * 1.4),
      });
      text.anchor.set(0.5, 0.5);
      text.x = w / 2;
      text.y = startY + i * lineGapY;
      text.alpha = 0;
      this.container.addChild(text);
      this.lines.push(text);
    });

    // Tap-to-continue hint — anchored below the lowest beat so it never overlaps the stacked
    // text once every beat (e.g. the 8-beat epilogue) has revealed itself.
    const blockBottomY = startY + (this.beats.length - 1) * lineGapY + Math.round(fontSize * 1.4);
    this.hintText = makeText(t('story.tapToContinue'), {
      fontSize: FS.label,
      fill: ui.mid,
      fontFamily: 'monospace',
    });
    this.hintText.anchor.set(0.5, 1);
    this.hintText.x = w / 2;
    this.hintText.y = Math.max(Math.round(bandH * 0.94), blockBottomY + Math.round(fontSize * 0.9));
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
