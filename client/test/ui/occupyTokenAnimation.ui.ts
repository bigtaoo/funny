// Regression coverage for the occupy-hold attack-loop token (see WorldMapRenderer/fog.ts::syncOccupyTokens).
//
// marchTokenAnimation.ui.ts already covers the brief "attacking" beat right after a march
// resolves into a hold (marchAttackUntil). That beat is ~0.6s and vanishes the moment the token's
// clip finishes — it does NOT cover the rest of the hold countdown (can be minutes). This file
// covers the separate, longer-lived token keyed off ctx.occupations (one entry per tile I'm
// currently holding) that keeps replaying 'attacking' for as long as the hold lasts.
//
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import type { WorldApiClient, OccupationView } from '../../src/net/WorldApiClient';

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
  }) as any;
}

function occupation(x: number, y: number, dueInSec = 215): OccupationView {
  return { tile: `world:1:0:${x}:${y}`, x, y, level: 1, garrison: 0, dueAt: Date.now() + dueInSec * 1000 };
}

/** Minimal stand-in for a resolved StickmanRuntime. */
function makeFakeRuntime() {
  return {
    syncState: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
    container: { position: { set: vi.fn() }, scale: { x: 1, y: 1 } },
  };
}

describe('occupy-hold attack-loop token', () => {
  it('pools one entry per tile I am currently holding (ctx.occupations)', () => {
    const scene = buildScene();
    scene.ctx.occupations = [occupation(37, 294), occupation(40, 300)];
    scene.update(1 / 60);

    const runtimes = scene.ctx.occupyTokenRuntimes as Map<string, { runtime: unknown }>;
    expect(runtimes.size).toBe(2);
    expect(runtimes.has('37:294')).toBe(true);
    expect(runtimes.has('40:300')).toBe(true);

    scene.destroy();
  });

  it('keeps replaying "attacking" every frame for as long as the hold is still in ctx.occupations', () => {
    const scene = buildScene();
    scene.ctx.occupations = [occupation(37, 294)];
    scene.update(1 / 60);

    const runtimes = scene.ctx.occupyTokenRuntimes as Map<string, { runtime: any }>;
    const fake = makeFakeRuntime();
    runtimes.get('37:294')!.runtime = fake;

    // Several more frames, well past the ~0.6s a one-shot flash would have covered.
    for (let i = 0; i < 5; i++) scene.update(1);

    expect(fake.syncState).toHaveBeenCalledWith('attacking');
    expect(fake.syncState.mock.calls.length).toBeGreaterThan(1); // re-asserted every frame, not fire-once
    expect(fake.destroy).not.toHaveBeenCalled();
    expect(runtimes.has('37:294')).toBe(true);

    scene.destroy();
  });

  it('tears the token down once the hold resolves and drops off ctx.occupations', () => {
    const scene = buildScene();
    scene.ctx.occupations = [occupation(37, 294)];
    scene.update(1 / 60);

    const runtimes = scene.ctx.occupyTokenRuntimes as Map<string, { runtime: any }>;
    const fake = makeFakeRuntime();
    runtimes.get('37:294')!.runtime = fake;

    scene.ctx.occupations = []; // ownership landed / hold was abandoned — poll no longer reports it
    scene.update(1 / 60);

    expect(runtimes.has('37:294')).toBe(false);
    expect(fake.destroy).toHaveBeenCalledTimes(1);

    scene.destroy();
  });

  it('drops the pooled entry once the camera zooms out to L3, even with the hold still active', () => {
    const scene = buildScene();
    scene.ctx.occupations = [occupation(37, 294)];
    scene.update(1 / 60);

    const runtimes = scene.ctx.occupyTokenRuntimes as Map<string, { runtime: unknown }>;
    expect(runtimes.has('37:294')).toBe(true);

    scene.ctx.zoom = 3;
    scene.update(1 / 60);
    expect(runtimes.has('37:294')).toBe(false);

    scene.destroy();
  });

  it('scene.destroy() tears down every pooled occupy token without throwing', () => {
    const scene = buildScene();
    scene.ctx.occupations = [occupation(37, 294), occupation(40, 300)];
    scene.update(1 / 60);

    const runtimes = scene.ctx.occupyTokenRuntimes as Map<string, { runtime: any }>;
    const fake1 = makeFakeRuntime();
    const fake2 = makeFakeRuntime();
    runtimes.get('37:294')!.runtime = fake1;
    runtimes.get('40:300')!.runtime = fake2;

    expect(() => scene.destroy()).not.toThrow();
    expect(fake1.destroy).toHaveBeenCalledTimes(1);
    expect(fake2.destroy).toHaveBeenCalledTimes(1);
    expect(runtimes.size).toBe(0);
  });
});
