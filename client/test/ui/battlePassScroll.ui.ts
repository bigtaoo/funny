// Regression coverage for BattlePassScene's reward track not being scrollable.
// BattlePassScene renders a 30-level dual-track reward list inside a `scrollContainer`
// clipped by a PIXI mask — but the constructor only subscribed to `input.onDown`,
// so `scrollY` was never mutated and everything past the first screen was
// permanently clipped. Fix: wire onMove/onUp + a drag-scroll handler mirroring
// EquipmentScene/base.ts's pattern.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
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

function buildBattlePass(input: InputManager, cb: Partial<BattlePassCallbacks> = {}): BattlePassScene {
  return new BattlePassScene(createLayout(800, 1280), input, {
    onBack() {},
    getCoins: () => 1000,
    // Wired (non-undefined) so render() draws the full 30-level reward track
    // instead of the "login required" placeholder — this is what makes
    // scrollMax > 0 and the drag-scroll code path reachable.
    getBattlePass: () => ({ seasonNo: 1, xp: 0, level: 1, hasPass: false, claimedFree: [], claimedPaid: [] }),
    ...cb,
  });
}

describe('BattlePassScene — reward track drag-scroll', () => {
  it('has scrollable content on a normal screen (scrollMax > 0)', () => {
    const scene = buildBattlePass(new InputManager());
    expect((scene as unknown as { scrollMax: number }).scrollMax).toBeGreaterThan(0);
    scene.destroy();
  });

  it('draws the shared scroll indicator once content is scrollable', () => {
    const scene = buildBattlePass(new InputManager());
    const s = scene as unknown as { scrollMax: number; scrollbar: unknown };
    expect(s.scrollMax).toBeGreaterThan(0);
    expect(s.scrollbar).not.toBeNull(); // ScrollIndicator wired in render()/updateScrollPosition()
    scene.destroy();
  });

  it('dragging up moves scrollY forward, clamped to scrollMax', () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollY: number; scrollMax: number };
    expect(s.scrollY).toBe(0);

    // Start the drag well clear of any hit rect (buy button / claim cells), then
    // drag up past the >6px move threshold.
    input._emitDown(700, 50);
    input._emitMove(700, 50 - 40);
    expect(s.scrollY).toBe(40);

    // Continuing to drag well past scrollMax must clamp, not overshoot.
    input._emitMove(700, 50 - 100000);
    expect(s.scrollY).toBe(s.scrollMax);

    input._emitUp(700, 50 - 100000);
    expect((scene as unknown as { dragStart: unknown }).dragStart).toBeNull();
    scene.destroy();
  });

  it('dragging back down retreats scrollY, clamped to 0', () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollY: number };

    input._emitDown(700, 50);
    input._emitMove(700, 50 - 40);
    expect(s.scrollY).toBe(40);

    input._emitUp(700, 50 - 40);
    input._emitDown(700, 50);
    input._emitMove(700, 50 + 1000);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });

  it('a small move under the drag threshold does not change scrollY (preserves tap-vs-drag distinction)', () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollY: number };

    input._emitDown(700, 50);
    input._emitMove(700, 50 - 3);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });

  it('does not scroll without a preceding down (no dangling drag state)', () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollY: number };

    input._emitMove(700, 10);
    expect(s.scrollY).toBe(0);
    scene.destroy();
  });
});

// Perf regression: handleMove used to call the scene's full render() (tearDownChildren +
// rebuild all 30 hand-drawn reward cells) on every pointermove past the drag threshold,
// which is what made dragging feel janky. The fix repositions the already-built
// scrollContainer and recomputes hit rects from a cache instead of rebuilding graphics.
describe('BattlePassScene — drag-scroll perf fast path', () => {
  it('reuses the same scrollContainer instance across a drag move (no full rebuild)', () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollContainer: unknown };
    const before = s.scrollContainer;
    expect(before).not.toBeNull();

    input._emitDown(700, 50);
    input._emitMove(700, 50 - 40);

    expect(s.scrollContainer).toBe(before);
    scene.destroy();
  });

  it("moves the scrollContainer's y by exactly -dy on drag, without touching bodyTopY", () => {
    const input = new InputManager();
    const scene = buildBattlePass(input);
    const s = scene as unknown as { scrollContainer: { y: number }; bodyTopY: number };
    const y0 = s.scrollContainer.y;
    const bodyTopY0 = s.bodyTopY;

    input._emitDown(700, 50);
    input._emitMove(700, 50 - 40);

    expect(s.scrollContainer.y).toBe(y0 - 40);
    expect(s.bodyTopY).toBe(bodyTopY0);
    scene.destroy();
  });

  it('cached claim hit rects for cells beyond the initial viewport still fire onClaim once scrolled into view', () => {
    const input = new InputManager();
    const claimed: Array<[string, number]> = [];
    // xp = 17999 -> level 30 (maxed), hasPass true, nothing claimed yet: every one of the
    // 60 (free+paid) cells is claimable, including the ones far below the first screen.
    const scene = buildBattlePass(input, {
      getBattlePass: () => ({ seasonNo: 1, xp: 17999, level: 30, hasPass: true, claimedFree: [], claimedPaid: [] }),
      onClaim: async (track, level) => { claimed.push([track, level]); return 0; },
    });
    const s = scene as unknown as {
      scrollMax: number;
      scrollCellDefs: Array<{ x: number; cellY: number; w: number; h: number; fn: () => void }>;
      bodyTopY: number;
    };
    expect(s.scrollMax).toBeGreaterThan(0);
    // A def for the last level must be cached even though it wasn't visible at initial render.
    const lastRowDef = s.scrollCellDefs.reduce((a, b) => (b.cellY > a.cellY ? b : a));

    // Scroll all the way down (drag far past scrollMax, which clamps) so the last row is
    // now on-screen, then tap it directly via its recomputed absolute rect.
    input._emitDown(700, 50);
    input._emitMove(700, 50 - 1_000_000);
    input._emitUp(700, 50 - 1_000_000);

    const absY = s.bodyTopY - s.scrollMax + lastRowDef.cellY;
    input._emitDown(lastRowDef.x + lastRowDef.w / 2, absY + lastRowDef.h / 2);
    input._emitUp(lastRowDef.x + lastRowDef.w / 2, absY + lastRowDef.h / 2);

    expect(claimed.length).toBe(1);
    expect(claimed[0]![1]).toBe(30);
    scene.destroy();
  });
});
