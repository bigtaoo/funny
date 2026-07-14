// Regression coverage for the CardCodexScene tile redesign (14.07.2026): each tile now shows a
// full-height illustration on the left plus a separate info panel on the right, and tapping an
// unlocked card's illustration plays a squash-flip that swaps the art for the card's story text in
// place — tapping again flips back. Locked tiles don't register a flip hit at all.
//
// Like cardDetailFlipAndSkin.ui.ts, the flip is driven by the REAL PIXI.Ticker.shared (not the
// scene's own render loop), so this pumps it with PIXI.Ticker.shared.update(time); the flip hit has
// no label of its own, so it's located by matching the square image-box hit on the target card's row.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CardCodexScene, type CardCodexCallbacks } from '../../src/scenes/CardCodexScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void; scroll?: boolean };

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

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container, wx: number, wy: number): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: wx, y: wy }; return; }
    for (const c of node.children) {
      const child = c as PIXI.Container;
      walk(child, wx + child.x, wy + child.y);
    }
  };
  walk(container, 0, 0);
  return found;
}

/** Advance the real PIXI.Ticker.shared by `ms`, firing the flip's registered tick listener. */
function tick(ms: number): void {
  const shared = (PIXI as unknown as { Ticker: { shared: { update(t: number): void; lastTime: number } } }).Ticker.shared;
  shared.update(shared.lastTime + ms);
}

function scene(owned: string[]): CardCodexScene {
  const cb: CardCodexCallbacks = { onBack() {}, getOwnedUnitTypes: () => new Set(owned) };
  return new CardCodexScene(createLayout(1920, 1080), new InputManager(), cb);
}

/** The square illustration-flip hit on the row of the named card (info-panel labels sit to its right). */
function flipHitForRow(sc: CardCodexScene, cardName: string): Hit | undefined {
  const pos = findLabelPos(sc.container, cardName);
  expect(pos, `card "${cardName}" not found`).not.toBeNull();
  const hits = (sc as unknown as { hits: Hit[] }).hits;
  return hits.find((hit) =>
    Math.abs(hit.rect.w - hit.rect.h) < 1 &&              // square = the image box
    pos!.y >= hit.rect.y && pos!.y <= hit.rect.y + hit.rect.h);
}

const LENA_LORE = t('card.lena.lore' as never);

describe('CardCodexScene — illustration flip (art ⇄ story)', () => {
  it('flips an unlocked card to its story text and back on tap', () => {
    const sc = scene(['lena']);
    expect(hasText(sc.container, LENA_LORE)).toBe(false);

    const hit = flipHitForRow(sc, t('card.lena.name' as never));
    expect(hit, 'no square flip hit on the Lena row').toBeDefined();

    hit!.fn();
    tick(100);                                            // before the 260ms midpoint: not yet swapped
    expect(hasText(sc.container, LENA_LORE)).toBe(false);
    tick(100);                                            // past midpoint: story face is drawn
    expect(hasText(sc.container, LENA_LORE)).toBe(true);
    tick(100);                                            // settles
    expect(hasText(sc.container, LENA_LORE)).toBe(true);

    hit!.fn();                                            // tap the story to flip back to art
    tick(150); tick(150);
    expect(hasText(sc.container, LENA_LORE)).toBe(false);
  });

  it('does not register a flip hit for a locked card', () => {
    const sc = scene([]); // Lena locked
    expect(flipHitForRow(sc, t('card.lena.name' as never))).toBeUndefined();
  });
});
