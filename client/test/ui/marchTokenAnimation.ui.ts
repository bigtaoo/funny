// Regression coverage for the 2026-07-15 march-token walk-cycle animation (see
// design/game/WORLD_MAP_ART_SPEC.md and WorldMapRenderer/fog.ts::syncMarchTokens).
//
// The plain-diamond march token was replaced with a pooled StickmanRuntime per in-flight
// march. Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts), where the
// .tao binary asset is stubbed to a 1x1 PNG (vitest.ui.config.ts's stubBinaryAssets) — so
// StickmanRuntime.loadAsset() always rejects and syncMarchTokens' entry.runtime stays null
// (the .catch() swallows it, same convention as UnitView). These tests therefore assert:
//   - the pooling/kind-mapping/cleanup logic around the (possibly still-loading) entry
//   - the position/facing math, by injecting a stub runtime once an entry exists (simulating
//     a resolved asset) rather than needing a real .tao bundle to load in headless.
//
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
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

/** Never-resolving WorldApiClient stub — enough for WorldMapScene to sit in its loading
 *  state without a real network; marches are injected directly into ctx.marches instead. */
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
    onOpenCity() {}, onOpenDefense() {}, onOpenTeams() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'Tester', accountId: 'acc_test',
  }) as any;
}

/** A march moving in +x tile direction (from < to on the x axis, same y) — screen dx > 0. */
function marchRight(marchId: string, kind: MarchView['kind']): MarchView {
  const now = Date.now();
  return {
    marchId, kind, fromTile: 'world:1:0:15:20', toTile: 'world:1:0:25:20',
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
  };
}

/** A march moving in -x tile direction — screen dx < 0 (opposite facing from marchRight). */
function marchLeft(marchId: string, kind: MarchView['kind']): MarchView {
  const now = Date.now();
  return {
    marchId, kind, fromTile: 'world:1:0:25:20', toTile: 'world:1:0:15:20',
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
  };
}

/** Minimal stand-in for a resolved StickmanRuntime — just enough surface for
 *  syncMarchTokens to call syncState/update and reposition the container. */
function makeFakeRuntime() {
  return {
    syncState: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
    container: { position: { set: vi.fn() }, scale: { x: 1, y: 1 } },
  };
}

describe('march-token walk animation (2026-07-15)', () => {
  it('pools one entry per in-flight march, kind-mapped from march.kind', () => {
    const scene = buildScene();
    scene.ctx.marches = [marchRight('m1', 'occupy'), marchRight('m2', 'attack')];
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: unknown; kind: string }>;
    expect(runtimes.size).toBe(2);
    expect(runtimes.get('m1')?.kind).toBe('normal');
    expect(runtimes.get('m2')?.kind).toBe('siege'); // attack → shield-bearer ("siege") per design doc

    scene.destroy();
  });

  it('drops the pooled entry once its march disappears from ctx.marches', () => {
    const scene = buildScene();
    scene.ctx.marches = [marchRight('m1', 'occupy')];
    scene.update(1 / 60);
    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: unknown; kind: string }>;
    expect(runtimes.has('m1')).toBe(true);

    scene.ctx.marches = []; // march arrived / was recalled
    scene.update(1 / 60);
    expect(runtimes.has('m1')).toBe(false);

    scene.destroy();
  });

  it('drops the pooled entry once the camera zooms out to L3, even with the march still active', () => {
    const scene = buildScene();
    scene.ctx.marches = [marchRight('m1', 'occupy')];
    scene.update(1 / 60);
    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: unknown; kind: string }>;
    expect(runtimes.has('m1')).toBe(true);

    scene.ctx.zoom = 3; // march is still in ctx.marches, but L3 doesn't render tokens
    scene.update(1 / 60);
    expect(runtimes.has('m1')).toBe(false);

    scene.destroy();
  });

  it('destroys the old runtime and swaps kind when the same march changes kind', () => {
    const scene = buildScene();
    const march = marchRight('m1', 'occupy');
    scene.ctx.marches = [march];
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: any; kind: string }>;
    const fake = makeFakeRuntime();
    runtimes.get('m1')!.runtime = fake; // simulate the asset having resolved

    march.kind = 'attack'; // e.g. an occupy march escalates to an attack
    scene.update(1 / 60);

    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(runtimes.get('m1')?.kind).toBe('siege');
    // A fresh placeholder replaces the destroyed runtime (re-loading the siege asset).
    expect(runtimes.get('m1')?.runtime).not.toBe(fake);

    scene.destroy();
  });

  it('rides a resolved token along the route and mirrors facing by travel direction', () => {
    const scene = buildScene();
    scene.ctx.marches = [marchRight('right', 'occupy'), marchLeft('left', 'occupy')];
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: any; kind: string }>;
    const fakeRight = makeFakeRuntime();
    const fakeLeft = makeFakeRuntime();
    runtimes.get('right')!.runtime = fakeRight;
    runtimes.get('left')!.runtime = fakeLeft;

    scene.update(1 / 60);

    expect(fakeRight.syncState).toHaveBeenCalledWith('moving');
    expect(fakeRight.update).toHaveBeenCalled();
    expect(fakeRight.container.position.set).toHaveBeenCalled();
    // ~20% through a 10s march (departed 2s ago) — strictly mid-route, not snapped to an endpoint.
    const calls = fakeRight.container.position.set.mock.calls;
    const [rightX] = calls[calls.length - 1];
    expect(rightX).toBeGreaterThan(0);

    // Facing: moving toward +x tiles must not mirror; moving toward -x tiles must.
    expect(fakeRight.container.scale.x).toBeGreaterThan(0);
    expect(fakeLeft.container.scale.x).toBeLessThan(0);

    scene.destroy();
  });

  it('scene.destroy() tears down every pooled runtime without throwing', () => {
    const scene = buildScene();
    scene.ctx.marches = [marchRight('m1', 'occupy'), marchRight('m2', 'attack')];
    scene.update(1 / 60);

    const runtimes = scene.ctx.marchTokenRuntimes as Map<string, { runtime: any; kind: string }>;
    const fake1 = makeFakeRuntime();
    const fake2 = makeFakeRuntime();
    runtimes.get('m1')!.runtime = fake1;
    runtimes.get('m2')!.runtime = fake2;

    expect(() => scene.destroy()).not.toThrow();
    expect(fake1.destroy).toHaveBeenCalledTimes(1);
    expect(fake2.destroy).toHaveBeenCalledTimes(1);
    expect(runtimes.size).toBe(0);
  });
});
