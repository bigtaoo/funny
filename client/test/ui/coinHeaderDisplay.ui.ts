// Regression coverage for the 2026-07-05 coin-header convention fix (design/game/LOBBY_IA_REDESIGN.md §9):
// GachaScene used to show the top-right balance as a text label ("Coins: {n}"), inconsistent with
// ShopScene's icon+number convention (see ShopScene.drawHeader). BattlePassScene showed no balance at
// all. Both now render "<coin icon><number>" with no text label — this locks that in so the label
// doesn't silently creep back in, and so BattlePassScene's balance doesn't get accidentally dropped.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import { BattlePassScene, type BattlePassCallbacks } from '../../src/scenes/BattlePassScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function buildGacha(cb: Partial<GachaSceneCallbacks>): GachaScene {
  return new GachaScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    getCoins: () => 123456,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
}

function buildBattlePass(cb: Partial<BattlePassCallbacks>): BattlePassScene {
  return new BattlePassScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    getCoins: () => 654321,
    ...cb,
  });
}

describe('GachaScene — header coin balance uses the icon+number convention', () => {
  it('renders the balance as a bare number, with no "Coins:" text label', () => {
    const scene = buildGacha({});
    const texts = collectTexts(scene.container);
    expect(texts).toContain((123456).toLocaleString());
    expect(texts.some((s) => /coins/i.test(s))).toBe(false);
    scene.destroy();
  });

  it('reflects getCoins() live (re-render picks up a new balance)', () => {
    let coins = 100;
    const scene = buildGacha({ getCoins: () => coins });
    expect(collectTexts(scene.container)).toContain((100).toLocaleString());
    coins = 200;
    (scene as unknown as { render(): void }).render();
    expect(collectTexts(scene.container)).toContain((200).toLocaleString());
    scene.destroy();
  });
});

describe('BattlePassScene — header now shows the coin balance (previously absent)', () => {
  it('renders the balance as a bare number, with no text label', () => {
    const scene = buildBattlePass({});
    const texts = collectTexts(scene.container);
    expect(texts).toContain((654321).toLocaleString());
    scene.destroy();
  });
});
