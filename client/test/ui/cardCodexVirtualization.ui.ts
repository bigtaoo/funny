// Regression coverage (2026-08-12, same fix as BattlePassScene/LeaderboardScene/ChatScene/
// DeckBuilderScene/CityScene): CardCodexScene.renderCards() used to build every codex tile
// (frame Graphics + face Sprite/Text + info-panel Graphics + up to 3 Text) unconditionally on
// every render(), regardless of scroll position. CARD_DEFINITIONS dedups to a small fixed set
// today so this was never a crash risk in practice, but it's the same missing-viewport-cull
// shape as the bug that reloaded the Battle Pass page on mobile. Fix: measureCodex() (cheap,
// geometry only) + updateVisibleTiles() (Map-based incremental build/destroy, mirrors
// BattlePassScene's RewardRowVirtualizer) — only tile rows within one viewport of the visible
// band actually exist as PIXI DisplayObjects; drag/wheel re-run just the build/destroy step
// (this scene has no full-render drag fast path, unlike DeckBuilderScene/CityScene).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardCodexScene, type CardCodexCallbacks } from '../../src/scenes/CardCodexScene';
import { CARD_DEFINITIONS } from '@nw/engine/config';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function baseCb(owned: string[] = []): CardCodexCallbacks {
  return { onBack() {}, getOwnedUnitTypes: () => new Set(owned) };
}

const TOTAL_ENTRIES = new Set(CARD_DEFINITIONS.map((c) => c.nameKey)).size;

type SceneInternals = {
  tileRows: Map<number, unknown>;
  codexEntries: unknown[];
  scrollMax: number;
  scrollY: number;
  maxScroll: number;
  handleMove(x: number, y: number): void;
};

describe('CardCodexScene — tile-row virtualization', () => {
  it('caches every codex entry (measure pass) but does not necessarily build every row eagerly', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb());
    const s = scene as unknown as SceneInternals;
    expect(s.codexEntries.length).toBe(TOTAL_ENTRIES);
    // Every built row must correspond to a real, in-range row index — never more rows built than
    // exist, regardless of how generous the viewport+buffer margin is.
    const maxRows = Math.ceil(TOTAL_ENTRIES / 2);
    expect(s.tileRows.size).toBeGreaterThan(0);
    expect(s.tileRows.size).toBeLessThanOrEqual(maxRows);
    scene.destroy();
  });

  it('never builds more tile rows than fall within one viewport+buffer of the current scroll position', () => {
    // CARD_DEFINITIONS is small enough today that a real screen's buffer margin can cover every
    // row at rest (both this scene's and BattlePassScene's row-count/screen-size ratios are
    // resolution-independent — every dimension involved scales off the same `h`/`w`). To exercise
    // the actual cull boundary (not just "it happens to fit today"), force a synthetic tiny
    // viewport onto the already-constructed scene and re-run updateVisibleTiles() directly —
    // this is the same private method render() calls, just with `scrollView.h` clamped down so
    // the ~150-200px buffer margin can't blanket the whole grid.
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb());
    const s = scene as unknown as SceneInternals & { scrollView: { h: number }; updateVisibleTiles(): void };
    const maxRows = Math.ceil(TOTAL_ENTRIES / 2);
    s.scrollView = { ...s.scrollView, h: 60 }; // one row's worth of viewport + a thin buffer
    s.updateVisibleTiles();
    expect(s.tileRows.size).toBeGreaterThan(0);
    expect(s.tileRows.size).toBeLessThan(maxRows);
    scene.destroy();
  });

  it('drag-scrolling builds newly-visible rows and destroys ones scrolled far out of view', () => {
    const input = new InputManager();
    const scene = new CardCodexScene(createLayout(1920, 1080), input, baseCb());
    const s = scene as unknown as SceneInternals;
    if (s.maxScroll === 0) { scene.destroy(); return; } // nothing to scroll at this AR — see test above

    const beforeRows = new Set(s.tileRows.keys());

    // Drag far enough (called repeatedly since handleMove clamps per-call) to reach the bottom.
    for (let i = 0; i < 5; i++) {
      (scene as unknown as { handleDown(x: number, y: number): void }).handleDown(500, 100);
      s.handleMove(500, 100 - 100_000);
    }
    expect(s.scrollY).toBe(s.maxScroll);

    const afterRows = new Set(s.tileRows.keys());
    // The bottom-most row must now be built...
    const lastRow = Math.ceil(TOTAL_ENTRIES / 2) - 1;
    expect(afterRows.has(lastRow)).toBe(true);
    // ...and at least one row that was built at the top is no longer tracked (destroyed, not
    // just hidden by the mask) once scrolled far enough away.
    const stillAllPresent = [...beforeRows].every((r) => afterRows.has(r));
    expect(stillAllPresent).toBe(false);
    scene.destroy();
  });

  it('destroy() clears the built-row cache without double-destroying already-torn-down containers', () => {
    const scene = new CardCodexScene(createLayout(1920, 1080), new InputManager(), baseCb());
    expect(() => scene.destroy()).not.toThrow();
    expect((scene as unknown as SceneInternals).tileRows.size).toBe(0);
  });
});
