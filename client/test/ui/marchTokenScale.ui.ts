// Coverage for the 2026-08-01 map-token shrink (WorldMapRenderer/fog.ts's MAP_TOKEN_SCALE): march,
// occupy, and stationed stickman tokens must render at half their previous on-screen height
// (tp * 0.55, was tp * 1.1) so units read less crowded on the world map.
//
// Mocks StickmanRuntime entirely (loadAsset resolves immediately; the fake constructor just
// records the options it was given) so the actual `targetHeight` passed to `new StickmanRuntime(...)`
// can be asserted without needing a real .tao bundle to decode — mirrors marchTokenAnimation.ui.ts's
// "inject a stub once an entry exists" approach, but mocks the module up front instead, since here
// we specifically need to observe the constructor call itself, not just the instance afterward.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import type { WorldApiClient, MarchView, OccupationView, StationedView } from '../../src/net/WorldApiClient';

interface FakeRuntimeInstance { targetHeight?: number; }
const instances: FakeRuntimeInstance[] = [];

vi.mock('../../src/render/stickman/StickmanRuntime', () => {
  class FakeStickmanRuntime {
    static loadAsset = vi.fn(async () => ({ naturalHeight: 100 }));
    targetHeight?: number;
    // A real PIXI.Container (not a plain stub) so marchTokenLayer.addChild(runtime.container)
    // succeeds cleanly instead of throwing on internal display-list bookkeeping.
    container = new PIXI.Container();
    constructor(_asset: unknown, options: { targetHeight?: number }) {
      this.targetHeight = options.targetHeight;
      instances.push(this);
    }
    setSilhouette = vi.fn();
    syncState = vi.fn();
    update = vi.fn();
    destroy = vi.fn();
  }
  return { StickmanRuntime: FakeStickmanRuntime };
});

// Imported AFTER vi.mock (vitest hoists the mock registration above all imports regardless of
// physical order, but keeping it textually first matches this file's own read order).
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { createFakeTextInput } from '../harness/fakeTextInput';

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
    storage: memStore, openTextInput: createFakeTextInput().openTextInput,
  }) as any;
}

function march(marchId: string): MarchView {
  const now = Date.now();
  return {
    marchId, kind: 'occupy', fromTile: 'world:1:0:15:20', toTile: 'world:1:0:25:20',
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
  };
}

/** Flush the microtask queue a few times so the (mock-resolved) `loadAsset().then(...)` callback runs. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('map-token size halved (2026-08-01)', () => {
  it('a march token renders at tp * 0.55 (half the old tp * 1.1)', async () => {
    instances.length = 0;
    const scene = buildScene();
    scene.ctx.marches = [march('m1')];
    scene.update(1 / 60);
    await flush();

    expect(instances).toHaveLength(1);
    expect(instances[0].targetHeight).toBeCloseTo(scene.ctx.tp * 0.55, 5);

    scene.destroy();
  });

  it('an occupy-hold token renders at the same tp * 0.55 scale', async () => {
    instances.length = 0;
    const scene = buildScene();
    scene.ctx.occupations = [
      { tile: 'world:1:0:15:20', x: 15, y: 20, level: 1, garrison: 100, dueAt: Date.now() + 5000 } as OccupationView,
    ];
    scene.update(1 / 60);
    await flush();

    expect(instances).toHaveLength(1);
    expect(instances[0].targetHeight).toBeCloseTo(scene.ctx.tp * 0.55, 5);

    scene.destroy();
  });

  it('a stationed token renders at the same tp * 0.55 scale', async () => {
    instances.length = 0;
    const scene = buildScene();
    scene.ctx.stationed = [
      { tile: 'world:1:0:15:20', x: 15, y: 20, teamId: 't1', troops: 100, sinceAt: Date.now(), mine: true } as StationedView,
    ];
    scene.update(1 / 60);
    await flush();

    expect(instances).toHaveLength(1);
    expect(instances[0].targetHeight).toBeCloseTo(scene.ctx.tp * 0.55, 5);

    scene.destroy();
  });
});
