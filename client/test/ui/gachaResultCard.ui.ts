// Regression coverage for the gacha result-reveal cards (2026-07-16): the plate under
// each drawn item showed the raw itemId string (e.g. "mat_scrap") instead of a
// translated name, and every duplicate carried a "Dup" badge that read as noise —
// only NEW pulls should get a badge at all.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); we set
// GachaScene's private `reveal` state directly and re-render rather than driving a
// real draw() round-trip, since drawResultCard only depends on that field.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import type { GachaResultEntry } from '../../src/net/ApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildGacha(cb: Partial<GachaSceneCallbacks> = {}): GachaScene {
  return new GachaScene(createLayout(1920, 1080), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
}

/** Collect every rendered PIXI.Text string in the scene's tree. */
function allTexts(container: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) out.push(node.text);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** Force the reveal overlay onto a built scene without a real draw() round-trip. */
function reveal(scene: GachaScene, results: GachaResultEntry[]): void {
  (scene as unknown as { reveal: GachaResultEntry[] | null }).reveal = results;
  (scene as unknown as { render(): void }).render();
}

describe('GachaScene — result card names + duplicate badge', () => {
  it('shows the translated display name, not the raw itemId', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'mat_scrap', rarity: 'common', duplicate: true }]);
    const texts = allTexts(scene.container);
    expect(texts).toContain(t('material.scrap'));
    expect(texts).not.toContain('mat_scrap');
    scene.destroy();
  });

  it('does not show a "Dup" badge on duplicate pulls', () => {
    const scene = buildGacha();
    reveal(scene, [
      { itemId: 'mat_scrap', rarity: 'common', duplicate: true },
      { itemId: 'lichuang', rarity: 'rare', duplicate: true },
    ]);
    const texts = allTexts(scene.container);
    expect(texts).not.toContain(t('gacha.duplicate'));
    expect(texts).not.toContain(t('gacha.new'));
    scene.destroy();
  });

  it('still shows the NEW badge for a non-duplicate pull', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }]);
    const texts = allTexts(scene.container);
    expect(texts).toContain(t('gacha.new'));
    expect(texts).not.toContain(t('gacha.duplicate'));
    scene.destroy();
  });
});

describe('GachaScene — legendary card border trail', () => {
  const fxOf = (s: GachaScene): Array<{ phase: number }> =>
    (s as unknown as { revealFx: Array<{ phase: number }> }).revealFx;
  const tick = (s: GachaScene, dt: number): void =>
    (s as unknown as { update(dt: number): void }).update(dt);

  it('spawns a clockwise-looping border trail for a legendary (orange) card only', () => {
    const scene = buildGacha();
    reveal(scene, [
      { itemId: 'lichuang', rarity: 'rare', duplicate: false },
      { itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false },
    ]);
    const fx = fxOf(scene);
    expect(fx.length).toBe(1); // only the legendary card, not the rare one

    const before = fx[0].phase;
    tick(scene, 0.5);
    // Positive phase delta = clockwise (screen y-down); it must advance while revealing.
    expect(fx[0].phase).toBeGreaterThan(before);
    scene.destroy();
  });

  it('clears the trail when the reveal is dismissed', () => {
    const scene = buildGacha();
    reveal(scene, [{ itemId: 'skin_placeholder', rarity: 'legendary', duplicate: false }]);
    expect(fxOf(scene).length).toBe(1);
    (scene as unknown as { dismissReveal(): void }).dismissReveal();
    expect(fxOf(scene).length).toBe(0);
    tick(scene, 0.5); // no-op, must not throw with an empty fx list
    scene.destroy();
  });
});

// Regression coverage for the 2026-08-01 fix: a pulled hero card's reveal picture used to always
// show the base UNIT_ART_URLS portrait, ignoring whatever skin the player already has equipped for
// that character (cardArt.ts unitPortraitUrl/cardInstanceArtUrl — same fix as the Hero Roster Skins
// tab). getEquippedSkins is a new optional callback; this checks the reveal wiring calls through to
// it for hero-card pulls (and is silent for non-card pulls, e.g. materials).
describe('GachaScene — reveal picture consults the equipped-skin callback', () => {
  it('calls getEquippedSkins when revealing a hero card pull', () => {
    const getEquippedSkins = vi.fn(() => ({} as Record<string, string>));
    const scene = buildGacha({ getEquippedSkins });
    reveal(scene, [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }]);
    expect(getEquippedSkins).toHaveBeenCalled();
    scene.destroy();
  });

  it('does not call getEquippedSkins for a non-card (material) pull', () => {
    const getEquippedSkins = vi.fn(() => ({} as Record<string, string>));
    const scene = buildGacha({ getEquippedSkins });
    reveal(scene, [{ itemId: 'mat_scrap', rarity: 'common', duplicate: true }]);
    expect(getEquippedSkins).not.toHaveBeenCalled();
    scene.destroy();
  });

  it('does not throw when getEquippedSkins is absent (optional callback)', () => {
    const scene = buildGacha();
    expect(() => reveal(scene, [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }])).not.toThrow();
    scene.destroy();
  });
});
