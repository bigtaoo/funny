// Coverage for `doUpgrade`'s server-error → toast ladder (CityScene/actions.ts), which had none.
//
// Why it matters even though the client now blocks the maxed case itself (see
// cityModalCappedNumbers.ui.ts): the ladder is the *stale-client* path. `me.buildings` is a snapshot
// — another tab, another device, or a build that completed server-side since the last poll can all
// make the server reject an upgrade the modal was still offering. The ladder decides which of five
// sentences the player then reads, from the server's error CODE plus its reason text (`SlgError`'s
// code + message, surfaced verbatim as `WorldApiError` — WorldApiClient/core.ts).
//
// Two things here are load-bearing and neither had a test. **Order**: 'desk at max level' contains
// "desk" too, so both max-level reasons must beat the 'desk' branch, or a player whose desk is
// already maxed is told their "desk level is too low" — the one thing they cannot change.
// **The resource branch**: it used to look for the word "resources", which the server never sends
// (`Insufficient ${rt}` — "Insufficient paper"), so a real shortfall read "Action failed". It is
// matched on the error code now; writing this file is what surfaced that.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { BUILDING_MAX_LEVEL, BUILDING_KEYS, buildGateReason } from '@nw/shared';
import * as log from '../../src/net/log';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../../src/net/WorldApiClient';
import { WorldApiError } from '../../src/net/WorldApiClient/core';

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

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };
type CitySceneInternals = { hits: Hit[]; selectedBuilding: BuildingKey | null; render(): void };

/** Mounts the city one level below the cap (so the upgrade button is really there) and taps it.
 *  `rejection` is what the API client would have thrown: a WorldApiError carries the server's error
 *  CODE alongside the message, and the resource branch is matched on the code. */
async function tapUpgrade(rejection: Error): Promise<{ scene: CityScene; calls: number }> {
  let calls = 0;
  const buildings = Object.fromEntries(
    BUILDING_KEYS.map((k) => [k, BUILDING_MAX_LEVEL])
  ) as Record<BuildingKey, number>;
  buildings.graphiteMill = BUILDING_MAX_LEVEL - 1;
  const me = {
    resources: { ink: 9e8, paper: 9e8, graphite: 9e8, metal: 9e8, sticker: 9e8 },
    buildings, cardState: {}, teamState: {}, buildQueue: [],
  } as unknown as PlayerWorldView;
  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => { calls++; return Promise.reject(rejection); },
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {}, worldApi, worldId: 'world:1:0', getFlag: () => true,
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  await new Promise((r) => setTimeout(r, 0));
  const inner = (scene as unknown as { core: CitySceneInternals }).core;
  inner.selectedBuilding = 'graphiteMill';
  inner.render();
  const hit = inner.hits.find((h) => h.fn.toString().includes('doUpgrade'));
  expect(hit, 'the upgrade button must exist one level below the cap').toBeTruthy();
  hit!.fn();
  await new Promise((r) => setTimeout(r, 0));
  return { scene, calls };
}

/** As the real client sees it: `WorldApiClient/core.ts` throws WorldApiError(code, message) built
 *  from the server's `{ ok:false, error:{ code, message } }` envelope. */
function serverErr(code: string, message: string): Error {
  return new WorldApiError(code, message);
}

async function toastFor(rejection: Error): Promise<string> {
  const spy = vi.spyOn(log, 'showToastMessage');
  const { scene, calls } = await tapUpgrade(rejection);
  expect(calls, 'the request must actually have been sent').toBe(1);
  // [0] is the optimistic "upgrading" toast only on success; a rejection toasts exactly once.
  const msgs = spy.mock.calls.map((c) => c[0] as string);
  scene.destroy();
  spy.mockRestore();
  expect(msgs.length).toBe(1);
  return msgs[0]!;
}

describe('CityScene doUpgrade server-error toasts', () => {
  it('maps each server reason to its own sentence', async () => {
    // The exact throw of `upgradeBuilding`'s sufficiency loop (worldsvc/src/city/buildings.ts):
    // per-RESOURCE prose, no "resources" anywhere in it — which is why the old substring test for
    // that word was dead code and a real shortfall read "Action failed".
    expect(await toastFor(serverErr('INSUFFICIENT_RESOURCES', 'Insufficient paper'))).toBe(
      t('city.err.noResources')
    );
    expect(await toastFor(serverErr('BAD_REQUEST', 'Build queue is full'))).toBe(t('city.err.queueFull'));
    expect(await toastFor(serverErr('BAD_REQUEST', 'desk level too low'))).toBe(t('city.err.deskGate'));
    expect(await toastFor(serverErr('BAD_REQUEST', 'something nobody planned for'))).toBe(
      t('city.err.generic')
    );
  });

  /** Every resource the loop can be short of — the branch must not depend on which one it is. */
  it('reads a shortfall of any single resource as "not enough resources"', async () => {
    for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
      expect(
        await toastFor(serverErr('INSUFFICIENT_RESOURCES', `Insufficient ${rt}`)),
        rt
      ).toBe(t('city.err.noResources'));
    }
  });

  /** The reordering this file exists for: 'desk at max level' contains "desk" as well, and BOTH
   *  max-level reasons must read as "max level", not as a desk shortfall. */
  it('reads a maxed-out rejection as max level, never as "desk level too low"', async () => {
    expect(await toastFor(serverErr('BAD_REQUEST', 'building at max level'))).toBe(t('city.maxLevel'));
    expect(await toastFor(serverErr('BAD_REQUEST', 'desk at max level'))).toBe(t('city.maxLevel'));
    expect(t('city.maxLevel')).not.toBe(t('city.err.deskGate'));
  });

  /** The strings above are not invented for the test — they are what buildGateReason returns.
   *  If a reason is ever reworded, this fails here rather than silently landing on err.generic. */
  it('matches the reason strings buildGateReason actually produces', async () => {
    const maxedDesk = Object.fromEntries(BUILDING_KEYS.map((k) => [k, BUILDING_MAX_LEVEL]));
    expect(buildGateReason(maxedDesk, 'graphiteMill', BUILDING_MAX_LEVEL + 1)).toBe('building at max level');
    expect(buildGateReason(maxedDesk, 'desk', BUILDING_MAX_LEVEL + 1)).toBe('desk at max level');
    expect(buildGateReason({ desk: 1 }, 'graphiteMill', 2)).toBe('desk level too low');
    for (const reason of ['building at max level', 'desk at max level']) {
      expect(await toastFor(serverErr('BAD_REQUEST', reason)), reason).toBe(t('city.maxLevel'));
    }
  });
});
