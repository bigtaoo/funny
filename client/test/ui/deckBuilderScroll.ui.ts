// Regression coverage for DeckBuilderScene's tap-vs-drag on the scrollable card grid (2026-07-17).
//
// The pre-fix handleDown returned early for ANY press inside the list area (to start a drag-scroll)
// and onUp only cleared the drag state — so a card's toggle hit was never dispatched: you could
// scroll the grid but could NOT tap a card to add/remove it from the deck. The ScrollTapGesture
// conversion defers the toggle to pointer-up and drops it only if the pointer dragged, restoring
// tap-to-toggle while keeping drag-to-scroll.
//
// Drives the scene through its real InputManager subscription path (input._emit*), same as
// battlePassScroll.ui.ts. Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DeckBuilderScene, type DeckBuilderCallbacks } from '../../src/scenes/DeckBuilderScene';

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

type Rect = { x: number; y: number; w: number; h: number };
type Internals = {
  hits: Array<{ rect: Rect; fn: () => void }>;
  selected: Set<string>;
  scrollY: number;
  scrollMax: number;
  listStartY: number;
  listH: number;
};

function build(): { scene: DeckBuilderScene; input: InputManager; s: Internals } {
  const input = new InputManager();
  const cb: DeckBuilderCallbacks = {
    onSave: () => {},
    onBack: () => {},
    getCurrentDeck: () => undefined, // default deck (a real preselected loadout)
    getCurrentElo: () => 999_999, // unlock every tier so all cards are tappable
  };
  const scene = new DeckBuilderScene(createLayout(W, H), input, cb);
  return { scene, input, s: scene as unknown as Internals };
}

/** Centre of the first card hit that sits inside the scrollable list viewport (hits[0]/[1] are the
 *  header Back + footer Confirm buttons, which live outside the list band). */
function firstCardCenter(s: Internals): { x: number; y: number } {
  const card = s.hits.find((hit) => {
    const cy = hit.rect.y + hit.rect.h / 2;
    return cy >= s.listStartY && cy <= s.listStartY + s.listH;
  });
  expect(card, 'no card hit inside the list viewport').toBeTruthy();
  return { x: card!.rect.x + card!.rect.w / 2, y: card!.rect.y + card!.rect.h / 2 };
}

describe('DeckBuilderScene — card grid tap-vs-drag', () => {
  it('the grid is scrollable (many cards overflow the viewport)', () => {
    const { scene, s } = build();
    expect(s.scrollMax).toBeGreaterThan(0);
    scene.destroy();
  });

  it('a tap (down+up, no drag) on a card toggles its deck membership', () => {
    const { scene, input, s } = build();
    const { x, y } = firstCardCenter(s);
    const before = new Set(s.selected);

    input._emitDown(x, y);
    input._emitUp(x, y);

    // Exactly one card's membership flipped (added if it was out, removed if it was in) — the
    // whole point of the fix: before it, this tap did nothing at all.
    expect(Math.abs(s.selected.size - before.size)).toBe(1);
    scene.destroy();
  });

  it('a drag that STARTS on a card scrolls the grid and does NOT toggle it', () => {
    const { scene, input, s } = build();
    const { x, y } = firstCardCenter(s);
    const before = new Set(s.selected);

    input._emitDown(x, y);
    input._emitMove(x, y - 40); // past the 6px drag threshold
    input._emitUp(x, y - 40);

    expect(s.scrollY).toBe(Math.min(40, s.scrollMax)); // scrolled instead of toggling
    expect(s.selected.size).toBe(before.size); // membership unchanged
    expect([...s.selected].sort()).toEqual([...before].sort());
    scene.destroy();
  });

  it('a jitter under the drag threshold still counts as a tap and toggles the card', () => {
    const { scene, input, s } = build();
    const { x, y } = firstCardCenter(s);
    const before = new Set(s.selected);

    input._emitDown(x, y);
    input._emitMove(x, y - 3); // within the 6px threshold → still a tap
    input._emitUp(x, y - 3);

    expect(s.scrollY).toBe(0);
    expect(Math.abs(s.selected.size - before.size)).toBe(1);
    scene.destroy();
  });
});
