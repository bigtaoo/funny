// Regression coverage (2026-08-12, same fix as BattlePassScene/LeaderboardScene/ChatScene/
// CardCodexScene/CityScene): the card-grid build loop in render() used to create every
// ALL_PVP_CARDS entry's panel+name Text(+lock/check icon) unconditionally, regardless of scroll
// position — only the *hit rects* (a separate loop right after) were viewport-filtered. Bounded
// to ~16-20 cards today, never a crash risk in practice, but the same missing-cull shape as the
// bug that reloaded the Battle Pass page on mobile. Fix: the build loop now skips any card whose
// row falls outside the scroll viewport ± a half-viewport buffer — this scene already does a
// full render() on every scroll-drag frame (`scrollDirty`, see update()), so no cross-render
// object cache is needed, same reasoning as ChatScene.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t, type TranslationKey } from '../../src/i18n';
import { DeckBuilderScene, type DeckBuilderCallbacks } from '../../src/scenes/DeckBuilderScene';
import { CARD_DEFINITIONS } from '@nw/engine/config';
import { PVP_BASE_CARDS, PVP_UNLOCK_TIERS } from '../../src/game/meta/pvpLoadout';

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

// Mirrors DeckBuilderScene's own module-private ALL_PVP_CARDS/cardDisplayName (not exported).
const ALL_PVP_CARDS: string[] = [...PVP_BASE_CARDS, ...PVP_UNLOCK_TIERS.flatMap((tier) => [...tier.cards])];
function cardDisplayName(id: string): string {
  const def = CARD_DEFINITIONS.find((c) => c.id === id);
  return def ? t(def.nameKey as TranslationKey) : id;
}

function countTexts(container: PIXI.Container): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

function hasText(container: PIXI.Container, text: string): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === text) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function build(): { scene: DeckBuilderScene; input: InputManager } {
  const input = new InputManager();
  const cb: DeckBuilderCallbacks = {
    onSave: () => {},
    onBack: () => {},
    getCurrentDeck: () => undefined,
    getCurrentElo: () => 999_999,
  };
  return { scene: new DeckBuilderScene(createLayout(W, H), input, cb), input };
}

describe('DeckBuilderScene — card-grid viewport culling', () => {
  it('the grid overflows a real screen (scrollMax > 0) — the context the cull exists for', () => {
    const { scene } = build();
    expect((scene as unknown as { scrollMax: number }).scrollMax).toBeGreaterThan(0);
    scene.destroy();
  });

  it('scrolling to the bottom still shows the last card', () => {
    const { scene, input } = build();
    const s = scene as unknown as { scrollMax: number; render(): void };
    const lastName = cardDisplayName(ALL_PVP_CARDS[ALL_PVP_CARDS.length - 1]!);

    input._emitDown(400, 640);
    input._emitMove(400, 640 - 1_000_000); // clamped to scrollMax
    s.render(); // scrollDirty is drained by update() in the real app; call directly here

    expect(hasText(scene.container, lastName)).toBe(true);
    scene.destroy();
  });

  it('the build loop actually reads scroll position — cards scrolled far out of the buffered band stop being built', () => {
    // ALL_PVP_CARDS is small enough today that a real screen's half-viewport buffer covers the
    // whole grid at rest (PortraitLayout's design canvas ratio is fixed regardless of the input
    // screen size — see ScalingManager/PortraitLayout — so this can't be forced via createLayout
    // args). Force `scrollY` far past any real scrollMax instead, directly exercising the same
    // cull check (`screenY = cy - this.scrollY`) render() always runs, to prove it isn't a no-op
    // that happens to never trigger for this dataset.
    const { scene } = build();
    const s = scene as unknown as { scrollY: number; render(): void };
    const restCount = countTexts(scene.container);

    s.scrollY = 1_000_000;
    s.render();
    const farCount = countTexts(scene.container);

    // Far fewer Texts survive once every card's screenY is pushed deep outside the buffered
    // band — the footer/header/counter/error labels are the only ones left standing.
    expect(farCount).toBeLessThan(restCount);
    expect(farCount).toBeLessThan(ALL_PVP_CARDS.length);
    scene.destroy();
  });
});
