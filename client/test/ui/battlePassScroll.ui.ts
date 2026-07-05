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
