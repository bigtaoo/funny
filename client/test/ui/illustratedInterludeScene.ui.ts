// Dedicated behavior coverage for IllustratedInterludeScene — the chapter-end "real layer"
// interlude (world.md「章末真实层」). Generalizes IntroScene's fade/auto-advance/skip loop, so
// this focuses on what's actually NEW relative to IntroScene (which has no dedicated behavior
// test beyond the startup smoke in scenes.ui.ts): splitting a single i18n key on '\n' into
// beats that replace each other one at a time (instead of IntroScene's fixed multi-key array
// that stacks all lines at once), and the illustration fading to FULL opacity (not IntroScene's
// 0.6-alpha backdrop). Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { IllustratedInterludeScene } from '../../src/scenes/IllustratedInterludeScene';

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

type Rect = { x: number; y: number; w: number; h: number };
type SceneInternals = {
  currentIndex: number;
  beats: string[];
  lineText: PIXI.Text;
  illustration: PIXI.Sprite;
  skipRect: Rect;
};

function build(onFinish: (skipped?: boolean) => void): { scene: IllustratedInterludeScene; input: InputManager; internals: SceneInternals } {
  const [w, h] = LANDSCAPE;
  const input = new InputManager();
  // campaign.realLayer.ch1 is a real 4-beat key (see i18n/locales/en.ts) — using the production
  // key (rather than a fabricated one) means this test breaks if someone ever collapses it back
  // to a single line, which would be a real content regression, not just a test fixture change.
  // Must be a data: URL — a literal string isn't intercepted by any asset-stubbing transform
  // (unlike a real webpack asset import), and PIXI's determineCrossOrigin() only short-circuits
  // before touching `document` (absent in this headless environment) for `data:` URLs.
  const scene = new IllustratedInterludeScene(createLayout(w, h), input, 'data:image/png;base64,', 'campaign.realLayer.ch1', { onFinish });
  return { scene, input, internals: scene as unknown as SceneInternals };
}

/** Advances the scene by `seconds`, in 100ms steps (matches how a real frame loop would drive it). */
function advance(scene: IllustratedInterludeScene, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.1) scene.update(0.1);
}

describe('IllustratedInterludeScene', () => {
  it('splits the i18n key on \\n into multiple beats and starts on the first, invisible', () => {
    const { scene, internals } = build(() => {});
    expect(internals.beats.length).toBeGreaterThan(1);
    expect(internals.currentIndex).toBe(0);
    expect(internals.lineText.text).toBe(internals.beats[0]);
    expect(internals.lineText.alpha).toBe(0);
    scene.destroy();
  });

  it('fades the current beat in over time, then holds at full alpha without advancing on its own yet', () => {
    const { scene, internals } = build(() => {});
    advance(scene, 2); // comfortably past the fade, nowhere near the auto-advance idle delay
    expect(internals.lineText.alpha).toBe(1);
    expect(internals.currentIndex).toBe(0);
    scene.destroy();
  });

  it('a tap mid-fade completes the fade instantly instead of advancing', () => {
    const { scene, input, internals } = build(() => {});
    scene.update(0.05); // still fading in
    expect(internals.lineText.alpha).toBeLessThan(1);
    input._emitDown(10, 10); // anywhere away from the skip button
    expect(internals.lineText.alpha).toBe(1);
    expect(internals.currentIndex).toBe(0);
    scene.destroy();
  });

  it('a tap once fully shown swaps in the next beat (replacing it, not stacking it)', () => {
    const { scene, input, internals } = build(() => {});
    advance(scene, 2);
    const firstBeatText = internals.beats[0]!;
    input._emitDown(10, 10);
    expect(internals.currentIndex).toBe(1);
    expect(internals.lineText.text).toBe(internals.beats[1]);
    expect(internals.lineText.text).not.toBe(firstBeatText);
    expect(internals.lineText.alpha).toBe(0); // the new beat starts invisible again
    scene.destroy();
  });

  it('auto-advances once idle after a beat is fully shown, but never past the last beat on its own', () => {
    let calls = 0;
    const { scene, internals } = build(() => { calls++; });
    const total = internals.beats.length;
    // 7s per beat comfortably covers fade-in (0.8s) + the 5s idle auto-advance delay, without
    // enough slack left over to also complete a second beat's fade+idle in the same window.
    for (let i = 0; i < total - 1; i++) advance(scene, 7);
    expect(internals.currentIndex).toBe(total - 1);
    expect(calls).toBe(0); // reaching the last beat does not itself finish the scene

    // Sitting on the fully-shown last beat must NOT auto-finish, unlike every earlier beat.
    advance(scene, 10);
    expect(internals.currentIndex).toBe(total - 1);
    expect(calls).toBe(0);
    scene.destroy();
  });

  it('an explicit tap on the fully-shown last beat finishes normally (skipped is falsy)', () => {
    let calls = 0;
    let skippedArg: boolean | undefined;
    const { scene, input, internals } = build((skipped) => { calls++; skippedArg = skipped; });
    const total = internals.beats.length;
    for (let i = 0; i < total - 1; i++) advance(scene, 7);
    advance(scene, 2); // fully shown
    input._emitDown(10, 10);
    expect(calls).toBe(1);
    expect(skippedArg).toBeFalsy();
    scene.destroy();
  });

  it('tapping the skip button finishes immediately with skipped=true, from the very first beat', () => {
    let calls = 0;
    let skippedArg: boolean | undefined;
    const { scene, input, internals } = build((skipped) => { calls++; skippedArg = skipped; });
    const r = internals.skipRect;
    input._emitDown(r.x + r.w / 2, r.y + r.h / 2);
    expect(calls).toBe(1);
    expect(skippedArg).toBe(true);
    scene.destroy();
  });

  it('does not fire onFinish twice — a tap after finishing is a no-op', () => {
    let calls = 0;
    const { scene, input, internals } = build(() => { calls++; });
    const r = internals.skipRect;
    input._emitDown(r.x + r.w / 2, r.y + r.h / 2);
    input._emitDown(r.x + r.w / 2, r.y + r.h / 2);
    input._emitDown(500, 500);
    expect(calls).toBe(1);
    scene.destroy();
  });

  it('the illustration fades independently to FULL opacity (unlike IntroScene\'s 0.6-alpha backdrop)', () => {
    const { scene, internals } = build(() => {});
    expect(internals.illustration.alpha).toBe(0);
    advance(scene, 2);
    expect(internals.illustration.alpha).toBe(1);
    scene.destroy();
  });
});
