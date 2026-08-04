// Regression coverage (2026-08-03 fix): a card that becomes ELO-relocked AFTER being saved in a deck
// must still be deselectable. Before the fix, the hit-rect loop only registered a toggle handler for
// currently-unlocked cards (`if (!unlocked.has(id)) return;`) — so if the player's ELO dropped below
// a tier's minElo (re-locking a high-tier card already in `selected`), that card's cell became
// permanently un-tappable. confirm() always failed with "not unlocked", and there was no clear/reset
// action, so the player could never save any new deck again.
//
// Card cell position is computed the same way DeckBuilderScene.render() lays out the grid (cols=2,
// pad/cardW/cardH/gapY all derived purely from w/h) plus the scene's own exposed `listStartY` field
// (used by handleWheel) — this sidesteps needing to replicate drawSceneHeader's header-height math.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DeckBuilderScene, type DeckBuilderCallbacks } from '../../src/scenes/DeckBuilderScene';
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

const ALL_PVP_CARDS: string[] = [...PVP_BASE_CARDS, ...PVP_UNLOCK_TIERS.flatMap((t) => [...t.cards])];
const RUNNER_IDX = ALL_PVP_CARDS.indexOf('runner');

type Rect = { x: number; y: number; w: number; h: number };
type Internals = {
  hits: Array<{ rect: Rect; fn: () => void }>;
  selected: Set<string>;
  scrollY: number;
  listStartY: number;
  w: number; h: number;
  render(): void;
};

/** Mirrors DeckBuilderScene.render()'s grid math exactly (cols=2; pad/cardW/cardH/gapY from w/h only). */
function runnerCellCenter(s: Internals): { x: number; y: number } {
  const { w, h } = s;
  const pad = Math.round(w * 0.05);
  const cardW = Math.round((w - pad * 3) / 2);
  const cardH = Math.round(h * 0.13);
  const gapY = Math.round(h * 0.015);
  const col = RUNNER_IDX % 2;
  const row = Math.floor(RUNNER_IDX / 2);
  const cx = pad + col * (cardW + pad);
  const cy = row * (cardH + gapY);
  const absY = s.listStartY - s.scrollY + cy;
  return { x: cx + cardW / 2, y: absY + cardH / 2 };
}

function hitUnder(hits: Internals['hits'], pos: { x: number; y: number }): { fn: () => void } | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

describe('DeckBuilderScene — a card that becomes ELO-relocked after being saved can still be deselected (2026-08-03 fix)', () => {
  it('the previously-selected, now-relocked card can be tapped to deselect it', () => {
    let elo = 1500; // 'runner' (PVP_UNLOCK_TIERS[0], minElo 1500) starts unlocked
    const savedDeck = [...PVP_BASE_CARDS.slice(0, 9), 'runner']; // 10 cards, 'runner' pre-selected
    const cb: DeckBuilderCallbacks = {
      onSave: () => {},
      onBack: () => {},
      getCurrentDeck: () => savedDeck,
      getCurrentElo: () => elo,
    };
    const scene = new DeckBuilderScene(createLayout(W, H), new InputManager(), cb);
    const s = scene as unknown as Internals;

    expect(s.selected.has('runner')).toBe(true);

    // Scroll runner into view (grid overflows the viewport; render()'s hit loop excludes off-screen
    // rows) — computed at the still-zero scrollY, then applied and re-rendered in one step below,
    // together with the ELO drop, since render() must run once AFTER both changes for `hits` to
    // reflect the new scroll position (mutating scrollY alone doesn't recompute hits).
    const unscrolledPos = runnerCellCenter(s);
    s.scrollY = Math.max(0, unscrolledPos.y - s.listStartY - 100);

    // ELO drops below 1500 — 'runner' becomes locked while still selected (re-render to reflect it,
    // mirroring how the real scene re-renders whenever getCurrentElo's backing value changes).
    elo = 0;
    s.render();

    const posScrolled = runnerCellCenter(s);
    const hit = hitUnder(s.hits, posScrolled);
    expect(hit, 'runner cell has no registered hit — the exact regression this test guards').toBeDefined();

    hit!.fn(); // tap to deselect
    expect(s.selected.has('runner')).toBe(false); // successfully removed despite being locked
    scene.destroy();
  });

  it('a locked, never-selected card still cannot be newly selected (the fix only widens deselection, not selection)', () => {
    const cb: DeckBuilderCallbacks = {
      onSave: () => {},
      onBack: () => {},
      getCurrentDeck: () => [...PVP_BASE_CARDS], // 'runner' not in the saved deck
      getCurrentElo: () => 0, // 'runner' locked
    };
    const scene = new DeckBuilderScene(createLayout(W, H), new InputManager(), cb);
    const s = scene as unknown as Internals;
    expect(s.selected.has('runner')).toBe(false);

    const unscrolledPos = runnerCellCenter(s);
    s.scrollY = Math.max(0, unscrolledPos.y - s.listStartY - 100);
    s.render();

    const posScrolled = runnerCellCenter(s);
    const hit = hitUnder(s.hits, posScrolled);
    expect(hit).toBeUndefined(); // still not tappable — never-selected + locked stays inert
    scene.destroy();
  });
});
