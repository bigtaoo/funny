// Regression coverage for the portrait-art loading spinner (drawArtFit / drawLoadingSpinner,
// CardScene/base.ts): a not-yet-loaded portrait texture used to leave its box blank (just the
// sketchPanel frame behind it) until the texture streamed in. It now draws a hand-drawn spinning
// ink ring in place, rotated every frame via update() — same visual language as the WorldMap
// first-paint loading cover (WorldMapRenderer/build.ts buildLoadingOverlay).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';
import { CARD_DEFS } from '../../src/game/meta/cardDefs';
import { getArtTexture, unitPortraitUrl } from '../../src/render/cardArt';
import type { UnitType } from '@nw/engine/types';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type SceneInternals = {
  activeSpinners: PIXI.Graphics[];
  update(dt: number): void;
  render(): void;
  destroy(): void;
};

function baseCb(): CardCallbacks {
  return {
    onBack() {},
    getSave: () => makeNewSave(),
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
}

function buildSkinsScene(): SceneInternals {
  const cb: CardCallbacks = { ...baseCb(), initialTab: 'skins' };
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb) as unknown as SceneInternals;
}

describe('CardScene — portrait art loading spinner', () => {
  it('draws a spinner in place of a not-yet-loaded portrait, and spins it every frame', () => {
    // pixiHeadless's stubbed Image never fires 'loaded' (client/test/harness/pixiHeadless.ts), so
    // every portrait's baseTexture stays invalid for the life of the test — exactly the "still
    // streaming in" state drawArtFit now covers, for every card in the (skins-tab) grid.
    const scene = buildSkinsScene();
    expect(scene.activeSpinners.length).toBeGreaterThan(0);

    const spinner = scene.activeSpinners[0];
    const before = spinner.rotation;
    scene.update(1 / 60);
    expect(spinner.rotation).not.toBe(before);

    scene.destroy();
  });

  it('drops destroyed spinners instead of touching them on the next update', () => {
    const scene = buildSkinsScene();
    const spinner = scene.activeSpinners[0];
    spinner.destroy();
    // Must not throw when a spinner was torn down (e.g. by a modal teardown) between renders.
    expect(() => scene.update(1 / 60)).not.toThrow();
    expect(scene.activeSpinners).not.toContain(spinner);
    scene.destroy();
  });

  it('draws a spinner for the roster-list tab too (list.ts shares the same drawArtFit helper)', () => {
    const owned: CardInstance = { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false };
    const cb: CardCallbacks = {
      ...baseCb(),
      getSave: () => ({ ...makeNewSave(), cardInv: { [owned.id]: owned } }),
      // initialTab omitted — defaults to 'list' (base.ts: this.tab = cb.initialTab ?? 'list').
    };
    const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb) as unknown as SceneInternals;
    expect(scene.activeSpinners.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('does not accumulate spinners across repeated renders while still loading', () => {
    const scene = buildSkinsScene();
    const n1 = scene.activeSpinners.length;
    expect(n1).toBeGreaterThan(0);

    // A re-render (e.g. triggered by a scroll or a save-changed callback) must tear down and
    // redraw the current frame's spinners, not pile new ones on top of stale destroyed ones.
    scene.render();
    expect(scene.activeSpinners.length).toBe(n1);
    scene.render();
    expect(scene.activeSpinners.length).toBe(n1);

    scene.destroy();
  });

  it('replaces the spinner with the real sprite once the texture finishes loading', () => {
    const scene = buildSkinsScene();
    const before = scene.activeSpinners.length;
    expect(before).toBeGreaterThan(0);

    // lichuang (CARD_DEFS declaration order) → unit_infantry portrait — same url skins.ts resolved
    // via unitPortraitUrl/getArtTexture, so this is the exact cached PIXI.Texture the scene drew.
    // (vitest.ui.config.ts's stubBinaryAssets resolves every *.png import to the SAME 1x1 data: URI,
    // so every character's portrait shares this one cached texture in this headless harness — real
    // production art has distinct urls, but the load→re-render wiring under test is identical.)
    const lichuang = CARD_DEFS['lichuang'];
    const url = unitPortraitUrl(lichuang.unitType as UnitType, null);
    expect(url).not.toBeNull();
    const tex = getArtTexture(url!);

    // Simulate the (real, async, network-bound) texture finishing its load — drawArtFit hooked a
    // one-shot 'loaded' listener on first draw, which triggers a re-render.
    tex.baseTexture.valid = true;
    tex.baseTexture.emit('loaded', tex.baseTexture);

    // Every spinner is gone now that the (shared) texture is valid — none left "loading".
    expect(scene.activeSpinners.length).toBe(0);

    scene.destroy();
  });
});
