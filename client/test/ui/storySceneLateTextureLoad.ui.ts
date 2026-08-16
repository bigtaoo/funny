// Regression: the story scenes' illustration must survive its texture finishing decode AFTER the
// scene was destroyed (2026-08-15, reproduced via Playwright against the web-e2e build: click
// through the intro on a cold cache). The `baseTexture.once('loaded')` fit callback then ran
// against a destroyed Sprite and threw `Cannot read properties of null (reading 'scale')` — and
// because it fires from a PIXI Runner inside the ticker, PIXI7's `Ticker._tick` aborts the update
// loop and stops re-requesting frames, i.e. the canvas freezes permanently and only a page reload
// recovers. See 菜单场景生命周期契约 in claudedocs/client-modules.md: every async redraw needs a
// `destroyed` backstop. Runs under the headless PIXI adapter. Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { IntroScene } from '../../src/scenes/IntroScene';
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

/** The illustration's still-loading BaseTexture, grabbed before destroy() nulls the Sprite out. */
function baseTextureOf(scene: unknown): PIXI.BaseTexture {
  return (scene as { illustration: PIXI.Sprite }).illustration.texture.baseTexture;
}

describe('story scenes: illustration texture that finishes loading after destroy', () => {
  it('IntroScene absorbs a late "loaded" instead of throwing into Ticker.shared', () => {
    const [w, h] = LANDSCAPE;
    const scene = new IntroScene(createLayout(w, h), new InputManager(), { onFinish() {} });
    const base = baseTextureOf(scene);
    // Premise of this whole test: the texture is NOT decoded yet, so the fit ran as a deferred
    // 'loaded' callback rather than inline. If a future asset stub made it valid up front, this
    // test would silently stop covering anything.
    expect(base.valid).toBe(false);

    scene.destroy();

    expect(() => base.emit('loaded', base)).not.toThrow();
    // Belt as well as braces: destroy() also unhooks the listener, so nothing is left subscribed.
    expect(base.listenerCount('loaded')).toBe(0);
  });

  it('IllustratedInterludeScene absorbs a late "loaded" instead of throwing into Ticker.shared', () => {
    const [w, h] = LANDSCAPE;
    const scene = new IllustratedInterludeScene(
      // Must already be a data: URL — see illustratedInterludeScene.ui.ts's build() for why.
      createLayout(w, h), new InputManager(), 'data:image/png;base64,', 'campaign.realLayer.ch1',
      { onFinish() {} },
    );
    const base = baseTextureOf(scene);
    expect(base.valid).toBe(false);

    scene.destroy();

    expect(() => base.emit('loaded', base)).not.toThrow();
    expect(base.listenerCount('loaded')).toBe(0);
  });
});
