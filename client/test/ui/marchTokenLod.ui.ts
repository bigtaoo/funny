// Regression coverage for the 2026-07-26 march-token LOD downgrade (see
// design/game/WORLD_MAP_ART_SPEC.md and WorldMapRenderer/fog.ts::STICKMAN_TOKEN_BUDGET).
//
// A siege can have far more in-flight marches than are worth animating as full skeletons —
// tokens beyond the shared STICKMAN_TOKEN_BUDGET render as a single lightweight static portrait
// disc ('dot' mode) instead. Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts).
//
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { STICKMAN_TOKEN_BUDGET } from '../../src/scenes/worldmap/WorldMapRenderer/fog';
import type { WorldApiClient, MarchView } from '../../src/net/WorldApiClient';

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

function stubWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getMarches: never, getOccupations: never,
    joinWorld: never, occupyTile: never, abandonTile: never,
    startMarch: never, recallMarch: never,
  } as unknown as WorldApiClient;
}

function buildScene() {
  return new WorldMapScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {},
    onOpenCity() {}, onOpenDefense() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'Tester', accountId: 'acc_test',
    storage: memStore,
  }) as any;
}

function march(marchId: string): MarchView {
  const now = Date.now();
  return {
    marchId, kind: 'occupy', fromTile: 'world:1:0:15:20', toTile: 'world:1:0:25:20',
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
  };
}

describe('march-token LOD downgrade (2026-07-26)', () => {
  it('caps live "stickman" tokens at STICKMAN_TOKEN_BUDGET, degrading the rest to "dot"', () => {
    const scene = buildScene();
    const total = STICKMAN_TOKEN_BUDGET + 15;
    scene.ctx.marches = Array.from({ length: total }, (_, i) => march(`m${i}`));
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { mode: 'stickman' | 'dot' }>;
    expect(runtimes.size).toBe(total);
    const stickmanCount = [...runtimes.values()].filter((e) => e.mode === 'stickman').length;
    const dotCount = [...runtimes.values()].filter((e) => e.mode === 'dot').length;
    expect(stickmanCount).toBe(STICKMAN_TOKEN_BUDGET);
    expect(dotCount).toBe(15);

    scene.destroy();
  });

  it('keeps an existing token\'s mode stable across frames (no mid-life demotion/promotion)', () => {
    const scene = buildScene();
    const total = STICKMAN_TOKEN_BUDGET + 5;
    scene.ctx.marches = Array.from({ length: total }, (_, i) => march(`m${i}`));
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { mode: 'stickman' | 'dot' }>;
    const modesBefore = new Map([...runtimes.entries()].map(([id, e]) => [id, e.mode]));

    // Several more frames — the same marches are still present; nothing should flip mode.
    for (let i = 0; i < 5; i++) scene.update(1 / 60);
    for (const [id, mode] of modesBefore) {
      expect(runtimes.get(id)?.mode).toBe(mode);
    }

    scene.destroy();
  });

  it('scene.destroy() tears down both "stickman" and "dot" tokens without throwing', () => {
    const scene = buildScene();
    scene.ctx.marches = Array.from({ length: STICKMAN_TOKEN_BUDGET + 3 }, (_, i) => march(`m${i}`));
    scene.update(1 / 60);

    expect(() => scene.destroy()).not.toThrow();
    expect((scene.ctx.marchTokenRuntimes as Map<string, unknown>).size).toBe(0);
  });
});
