// Dedicated behavior coverage for IntroScene — the first-launch background story (shown once,
// gated by the `nw_seen_intro` flag in app.ts). Until now this scene only had the startup smoke in
// scenes.ui.ts plus the destroy-safety test in storySceneLateTextureLoad.ui.ts, and
// illustratedInterludeScene.ui.ts explicitly scoped itself to "what's NEW relative to IntroScene"
// on the assumption IntroScene was covered elsewhere. It wasn't — this file closes that gap.
//
// What is actually IntroScene-specific (i.e. not already covered by the interlude tests):
//  1. The LAST line does not auto-advance. Every other line does. This one is load-bearing: the
//     scene feeds into the consent/privacy gate (gateConsent in auth.ts), and auto-finishing into
//     that would fly the ending past the reader.
//  2. The illustration's alpha is slaved to story.line.3's own fade and then holds at 0.6 — the
//     interlude instead fades its illustration independently to full opacity.
//  3. onFinish's `skipped` flag distinguishes the skip button from reading through to the end.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { IntroScene } from '../../src/scenes/IntroScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE: [number, number] = [1920, 1080];

// Mirrors the scene's own module constants — deliberately duplicated rather than exported, so a
// change to the real pacing shows up here as a decision to re-confirm rather than silently passing.
const FADE_DURATION = 0.8;
const AUTO_ADVANCE_DELAY = 5;
const ILLUSTRATION_LINE_INDEX = 2; // story.line.3
const ILLUSTRATION_TARGET_ALPHA = 0.6;

type Rect = { x: number; y: number; w: number; h: number };
type SceneInternals = {
  shownCount: number;
  lines: PIXI.Text[];
  illustration: PIXI.Sprite;
  hintText: PIXI.Text;
  skipRect: Rect;
  finished: boolean;
};

function build(onFinish: (skipped?: boolean) => void = () => {}): {
  scene: IntroScene; input: InputManager; internals: SceneInternals;
} {
  const [w, h] = LANDSCAPE;
  const input = new InputManager();
  const scene = new IntroScene(createLayout(w, h), input, { onFinish });
  return { scene, input, internals: scene as unknown as SceneInternals };
}

/** Advances the scene by `seconds`, in 100ms steps (matches how a real frame loop would drive it). */
function advance(scene: IntroScene, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.1) scene.update(0.1);
}

/** Fully reveals the current line, then waits out its auto-advance — i.e. one whole line's cycle. */
function advanceOneLine(scene: IntroScene): void {
  advance(scene, FADE_DURATION + AUTO_ADVANCE_DELAY + 0.2);
}

describe('IntroScene — line reveal', () => {
  it('builds one PIXI.Text per story line and starts on the first, invisible', () => {
    const { scene, internals } = build();
    expect(internals.lines.length).toBe(7); // story.line.1 … story.line.7
    expect(internals.shownCount).toBe(1);
    expect(internals.lines[0]!.alpha).toBe(0);
    internals.lines.forEach((l) => expect(l.text.length).toBeGreaterThan(0));
    scene.destroy();
  });

  it('fades the current line in over FADE_DURATION and leaves later lines untouched', () => {
    const { scene, internals } = build();
    advance(scene, FADE_DURATION / 2);
    const partial = internals.lines[0]!.alpha;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(internals.lines[1]!.alpha).toBe(0);

    advance(scene, FADE_DURATION);
    expect(internals.lines[0]!.alpha).toBe(1);
    scene.destroy();
  });

  it('auto-advances a settled line after AUTO_ADVANCE_DELAY, and earlier lines stay on screen (stacking)', () => {
    const { scene, internals } = build();
    advance(scene, FADE_DURATION + 0.1);
    expect(internals.shownCount).toBe(1); // faded in, countdown not elapsed yet

    advance(scene, AUTO_ADVANCE_DELAY + 0.1);
    expect(internals.shownCount).toBe(2);
    expect(internals.lines[0]!.alpha).toBe(1); // the previous line stays fully visible
    scene.destroy();
  });

  it('a tap completes the in-progress fade instead of skipping to the next line', () => {
    const { scene, input, internals } = build();
    advance(scene, FADE_DURATION / 2);
    expect(internals.lines[0]!.alpha).toBeLessThan(1);

    input._emitDown(5, 5);
    expect(internals.lines[0]!.alpha).toBe(1);
    expect(internals.shownCount).toBe(1); // same line, just finished — not advanced

    input._emitDown(5, 5);
    expect(internals.shownCount).toBe(2); // now it advances
    scene.destroy();
  });
});

describe('IntroScene — the last line waits for an explicit tap (consent gate feeds off it)', () => {
  it('does not auto-finish once the final line has settled, however long it is left alone', () => {
    let finished = 0;
    const { scene, internals } = build(() => { finished++; });

    for (let i = 0; i < internals.lines.length - 1; i++) advanceOneLine(scene);
    expect(internals.shownCount).toBe(internals.lines.length); // on the last line now

    advance(scene, FADE_DURATION + AUTO_ADVANCE_DELAY * 4); // sit on it far past the auto-advance
    expect(internals.lines[internals.lines.length - 1]!.alpha).toBe(1);
    expect(finished).toBe(0);
    scene.destroy();
  });

  it('finishes on a tap once the last line is fully shown, reporting skipped=false', () => {
    const skips: (boolean | undefined)[] = [];
    const { scene, input, internals } = build((skipped) => { skips.push(skipped); });

    for (let i = 0; i < internals.lines.length - 1; i++) advanceOneLine(scene);
    advance(scene, FADE_DURATION + 0.1);

    input._emitDown(5, 5);
    expect(skips).toEqual([false]);
    scene.destroy();
  });

  it('reports onFinish exactly once even if tapped repeatedly after finishing', () => {
    let finished = 0;
    const { scene, input, internals } = build(() => { finished++; });

    for (let i = 0; i < internals.lines.length - 1; i++) advanceOneLine(scene);
    advance(scene, FADE_DURATION + 0.1);

    input._emitDown(5, 5);
    input._emitDown(5, 5);
    input._emitDown(5, 5);
    expect(finished).toBe(1);
    scene.destroy();
  });
});

describe('IntroScene — skip button', () => {
  it('finishes immediately with skipped=true when the top-right skip rect is tapped', () => {
    const skips: (boolean | undefined)[] = [];
    const { scene, input, internals } = build((skipped) => { skips.push(skipped); });

    const r = internals.skipRect;
    expect(r.w).toBeGreaterThan(0); // sanity: the rect was actually laid out
    input._emitDown(r.x + r.w / 2, r.y + r.h / 2);

    expect(skips).toEqual([true]);
    expect(internals.shownCount).toBe(1); // finished from the very first line, nothing advanced
    scene.destroy();
  });

  it('a tap just outside the skip rect advances the story instead of skipping', () => {
    const skips: (boolean | undefined)[] = [];
    const { scene, input, internals } = build((skipped) => { skips.push(skipped); });

    const r = internals.skipRect;
    advance(scene, FADE_DURATION + 0.1); // settle line 1 so the tap advances rather than snapping the fade
    input._emitDown(r.x - 20, r.y + r.h / 2);

    expect(skips).toEqual([]);
    expect(internals.shownCount).toBe(2);
    scene.destroy();
  });
});

describe('IntroScene — illustration alpha is slaved to story.line.3', () => {
  it('stays invisible before story.line.3, tracks its fade, then holds at 0.6', () => {
    const { scene, internals } = build();

    // Lines 1..2 — illustration not yet in play.
    expect(internals.illustration.alpha).toBe(0);
    advanceOneLine(scene);
    expect(internals.shownCount).toBe(2);
    expect(internals.illustration.alpha).toBe(0);

    // story.line.3 (index 2) starts fading: the illustration tracks it proportionally.
    advanceOneLine(scene);
    expect(internals.shownCount).toBe(ILLUSTRATION_LINE_INDEX + 1);
    advance(scene, FADE_DURATION / 2);
    const line3 = internals.lines[ILLUSTRATION_LINE_INDEX]!;
    expect(line3.alpha).toBeGreaterThan(0);
    expect(line3.alpha).toBeLessThan(1);
    expect(internals.illustration.alpha).toBeCloseTo(line3.alpha * ILLUSTRATION_TARGET_ALPHA, 5);

    // Fully faded in, and it holds at the target alpha for every later line.
    advance(scene, FADE_DURATION);
    expect(internals.illustration.alpha).toBeCloseTo(ILLUSTRATION_TARGET_ALPHA, 5);
    advanceOneLine(scene);
    expect(internals.illustration.alpha).toBeCloseTo(ILLUSTRATION_TARGET_ALPHA, 5);

    scene.destroy();
  });

  it('never reaches full opacity — it is a backdrop, unlike the interlude illustration', () => {
    const { scene, internals } = build();
    for (let i = 0; i < internals.lines.length - 1; i++) advanceOneLine(scene);
    advance(scene, FADE_DURATION + 0.1);
    expect(internals.illustration.alpha).toBeLessThan(1);
    expect(internals.illustration.alpha).toBeCloseTo(ILLUSTRATION_TARGET_ALPHA, 5);
    scene.destroy();
  });
});

describe('IntroScene — tap hint', () => {
  it('pulses the hint without ever going fully transparent or opaque', () => {
    const { scene, internals } = build();
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) { scene.update(0.05); seen.push(internals.hintText.alpha); }

    expect(Math.min(...seen)).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(new Set(seen).size).toBeGreaterThan(1); // it actually animates
    scene.destroy();
  });
});
