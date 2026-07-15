// Regression coverage for the 2026-07-15 CityScene card-grid redesign
// (design/game/SLG_CITY_DESIGN.md §8.1).
//
// Covers two real bugs caught during visual verification of the redesign (not
// hypothetical — both reproduced in a headless render before the fix):
//
//   1. Building-grid viewport bug: `gridLayer.y` was set to only `-scrollY`,
//      forgetting the `viewY` base offset (the space taken by the header +
//      resource bar + build-queue strip above the grid). Cards rendered at the
//      top of the screen while the scroll mask started at `viewY`, clipping
//      every card out of the visible viewport.
//   2. Modal hit-leak bug: opening a building's detail modal left the
//      building-grid card hits (and the build-queue speedup hit) registered
//      underneath the dim overlay. Because they were pushed into `this.hits`
//      before the modal's full-screen "tap outside to close" catch-all, tapping
//      a dimmed card still fired that card's `fn` (switching to a different
//      building) instead of just closing the modal.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via
// vitest.ui.config.ts). Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { formatDuration } from '../../src/scenes/worldmap/formatDuration';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];

type Rect = { x: number; y: number; w: number; h: number };
type Hit = Rect & { fn: () => void };

type CitySceneInternals = {
  w: number; h: number;
  hits: Hit[];
  selectedBuilding: string | null;
  handleDown(x: number, y: number): void;
  render(): void;
};

function internals(scene: CityScene): CitySceneInternals {
  return scene as unknown as CitySceneInternals;
}

/** getMe() never resolves — enough for the grid/modal to sit in its default
 *  (all-buildings-level-0) state without a real network, which is all these
 *  structural/interaction tests need. */
function stubWorldApi(): WorldApiClient {
  return {
    getMe: () => new Promise<PlayerWorldView>(() => {}),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
  } as unknown as WorldApiClient;
}

function buildScene(w: number, h: number): { scene: CityScene; input: InputManager; calls: { back: number } } {
  const calls = { back: 0 };
  const input = new InputManager();
  const cb: CitySceneCallbacks = {
    onBack: () => { calls.back++; },
    worldApi: stubWorldApi(),
    worldId: 'world:1:0',
  };
  const scene = new CityScene(createLayout(w, h), input, cb);
  return { scene, input, calls };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
  describe(`CityScene building grid — ${label} ${w}x${h}`, () => {
    it('all 10 building cards land fully within the screen and do not overlap each other', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      // hits[0] is the header Back button; the rest (10 buildings) are the grid cards.
      const cards = inner.hits.slice(1);
      expect(cards.length).toBe(10);

      for (const c of cards) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(inner.w + 1e-6);
        // Regression for the gridLayer viewY-offset bug: a card can never sit above the
        // build-queue strip (there's no legitimate content above the grid's own viewport).
        expect(c.y).toBeGreaterThan(100);
      }
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          expect(rectsOverlap(cards[i]!, cards[j]!)).toBe(false);
        }
      }
      scene.destroy();
    });

    it('tapping a building card opens its detail modal (selectedBuilding set)', () => {
      const { scene } = buildScene(w, h);
      const inner = internals(scene);
      const card = inner.hits[1]!; // first building card ('desk')
      inner.handleDown(card.x + card.w / 2, card.y + card.h / 2);
      expect(inner.selectedBuilding).not.toBeNull();
      scene.destroy();
    });
  });
}

describe('CityScene detail modal — hit gating (2026-07-15 modal-hit-leak fix)', () => {
  it('while a modal is open, tapping where a DIFFERENT building card used to sit closes the modal instead of switching buildings', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);

    const firstCard = inner.hits[1]!; // 'desk'
    const secondCard = inner.hits[2]!; // 'inkPot' — distinct coordinates from the first
    expect(rectsOverlap(firstCard, secondCard)).toBe(false);

    inner.handleDown(firstCard.x + firstCard.w / 2, firstCard.y + firstCard.h / 2);
    const openedAs = inner.selectedBuilding;
    expect(openedAs).not.toBeNull();

    // Tap the second card's old screen coordinates. Before the fix, this hit the stale grid
    // hit (which fires first in array order) and silently reassigned selectedBuilding.
    inner.handleDown(secondCard.x + secondCard.w / 2, secondCard.y + secondCard.h / 2);

    expect(inner.selectedBuilding).not.toBe('inkPot');
    scene.destroy();
  });

  it('the header Back button stays reachable while the modal is open', () => {
    const { scene, calls } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const backHit = inner.hits[0]!;

    const card = inner.hits[1]!;
    inner.handleDown(card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    inner.handleDown(backHit.x + backHit.w / 2, backHit.y + backHit.h / 2);
    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('tapping far outside the (centered, narrower) modal panel closes it', () => {
    const { scene } = buildScene(...PORTRAIT);
    const inner = internals(scene);
    const card = inner.hits[1]!;
    inner.handleDown(card.x + card.w / 2, card.y + card.h / 2);
    expect(inner.selectedBuilding).not.toBeNull();

    inner.handleDown(inner.w - 2, inner.h - 2);
    expect(inner.selectedBuilding).toBeNull();
    scene.destroy();
  });
});

describe('CityScene build-queue countdown label (2026-07-15 formatDuration fix)', () => {
  it('formats as mm:ss, not a raw-seconds count with a stray trailing "s"', () => {
    const secsLeft = 95; // 1:35
    const label = t('city.queueEntry')
      .replace('{name}', t('city.bld.graphiteMill'))
      .replace('{to}', '2')
      .replace('{sec}', formatDuration(secsLeft));

    expect(label).toContain('1:35');
    // The old template appended a literal "s" after what used to be a raw integer
    // (e.g. "95s left"); formatDuration's "1:35" must not get an "s" glued onto it.
    expect(label).not.toMatch(/\ds\b/);
  });

  it('formats hour-scale countdowns as h:mm:ss', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
