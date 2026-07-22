// Coverage for the home-desk "Train Troops" tile + modal (2026-07-21).
//
// Training used to live inside the drillYard building modal (2026-07-20 restore). It is now its own
// top-level Domestic-grid tile (sibling to drillYard) opening a dedicated renderTrainModal — drillYard
// the building only grants troopCap / train-speed / queue slots. The training controls feed the unified
// base troop pool (me.troops, capped at troopCapFor(buildings)), which is then distributed to team cards.
//
// Note: the modal derives the cap from troopCapFor(buildings), NOT me.troopCap — so fixtures control the
// cap via `buildings` (default {} → TROOP_CAP_BASE). The train modal has no Upgrade button, so its hit
// order is [+10, +50, Max, speedup?, close-on-tap-outside].
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';
import { TROOP_CAP_BASE } from '@nw/shared';
import * as log from '../../src/net/log';

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

type Rect = { x: number; y: number; w: number; h: number };
type Hit = Rect & { fn: () => void };
type CitySceneInternals = {
  w: number; h: number;
  hits: Hit[];
  selectedBuilding: string | null;
  selectedTrain: boolean;
  contentX: number;
  handleDown(x: number, y: number): void;
  handleUp(): void;
  render(): void;
};

function internals(scene: CityScene): CitySceneInternals {
  return scene as unknown as CitySceneInternals;
}

function tap(inner: CitySceneInternals, x: number, y: number): void {
  inner.handleDown(x, y);
  inner.handleUp();
}

function contentHits(inner: CitySceneInternals): Hit[] {
  return inner.hits.slice(1).filter((h) => h.x >= inner.contentX);
}

/** While the train modal is open, render() replaces `this.hits` with just [backHit, ...modal hits]
 *  (the modal-hit-leak fix drops the background grid hits entirely). Push order inside renderTrainModal
 *  is always: [+10, +50, Max, speedup? , close-on-tap-outside (always last)] — no Upgrade button, unlike
 *  the building detail modal. So preset +10 is index 0 (not 1) and Max is index 2 (not 3). */
function trainModalHits(inner: CitySceneInternals): Hit[] {
  return inner.hits.slice(1);
}

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

type TrainFixture = {
  troops?: number;
  troopCap?: number;
  buildings?: Partial<Record<string, number>>;
  resources?: Partial<Record<string, number>>;
  trainingQueue?: { qty: number; startAt: number; completeAt: number }[];
  /** Override trainTroops' resolved/rejected behavior — defaults to resolving with `me`. */
  trainTroopsImpl?: (worldId: string, qty: number) => Promise<PlayerWorldView>;
};

function stubWorldApiWithTrain(fx: TrainFixture): { api: WorldApiClient; me: PlayerWorldView; trainTroops: ReturnType<typeof vi.fn>; speedupTraining: ReturnType<typeof vi.fn> } {
  const me = {
    joined: true,
    troops: fx.troops ?? 0,
    troopCap: fx.troopCap ?? 2000,
    resources: fx.resources ?? { ink: 100000 },
    buildings: fx.buildings ?? {},
    buildQueue: [],
    trainingQueue: fx.trainingQueue ?? [],
    cardState: {},
    teamState: {},
  } as unknown as PlayerWorldView;
  const trainTroops = vi.fn(fx.trainTroopsImpl ?? (() => Promise.resolve(me)));
  const speedupTraining = vi.fn(() => Promise.resolve(me));
  const api = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
    trainTroops,
    speedupTraining,
  } as unknown as WorldApiClient;
  return { api, me, trainTroops, speedupTraining };
}

/** Builds the scene, waits for load(), opens the Train Troops modal by tapping its grid tile. The tile
 *  is spliced into the Domestic grid right after drillYard: DOMESTIC_BUILDING_KEYS =
 *  desk/inkPot/paperTray/graphiteMill/metalForge/stickerShop/cabinet/drillYard(7) → train tile at index 8. */
async function openTrainModal(fx: TrainFixture): Promise<{ scene: CityScene; inner: CitySceneInternals; me: PlayerWorldView; trainTroops: ReturnType<typeof vi.fn>; speedupTraining: ReturnType<typeof vi.fn> }> {
  const input = new InputManager();
  const { api, me, trainTroops, speedupTraining } = stubWorldApiWithTrain(fx);
  const cb: CitySceneCallbacks = { onBack: () => {}, worldApi: api, worldId: 'world:1:0' };
  const scene = new CityScene(createLayout(...PORTRAIT), input, cb);
  await new Promise((r) => setTimeout(r, 0));
  const inner = internals(scene);
  const trainCard = contentHits(inner)[8]!;
  tap(inner, trainCard.x + trainCard.w / 2, trainCard.y + trainCard.h / 2);
  expect(inner.selectedTrain).toBe(true);
  return { scene, inner, me, trainTroops, speedupTraining };
}

describe('CityScene home-desk Train Troops tile + modal (2026-07-21)', () => {
  it('tapping the +10 preset trains troops via worldApi.trainTroops(worldId, 10)', async () => {
    const { scene, inner, trainTroops } = await openTrainModal({ troops: 0, resources: { ink: 100000 } });
    // [+10, +50, Max, close-catch-all] — no Upgrade button; see trainModalHits() doc comment.
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).toHaveBeenCalledWith('world:1:0', 10);
    scene.destroy();
  });

  it('tapping Max trains the computed max qty: min(batch cap, troopCap headroom, ink affordable)', async () => {
    // Ink is the binding constraint here: ink 200 / TROOP_TRAIN_INK_COST(10) → 20 affordable; troopCap
    // headroom (troopCapFor({}) = TROOP_CAP_BASE) and TROOP_TRAIN_BATCH_MAX=500 are both larger.
    // min(500, TROOP_CAP_BASE, 20) = 20.
    const { scene, inner, trainTroops } = await openTrainModal({ troops: 0, resources: { ink: 200 } });
    const modalHits = trainModalHits(inner);
    const presetMax = modalHits[2]!;
    tap(inner, presetMax.x + presetMax.w / 2, presetMax.y + presetMax.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).toHaveBeenCalledWith('world:1:0', 20);
    scene.destroy();
  });

  it('does not call trainTroops and shows a toast when the training queue is already full', async () => {
    const now = Date.now();
    const spy = vi.spyOn(log, 'showToastMessage');
    const { scene, inner, trainTroops } = await openTrainModal({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainingQueue: [
        { qty: 10, startAt: now, completeAt: now + 5000 },
        { qty: 10, startAt: now, completeAt: now + 10000 },
      ], // TROOP_TRAIN_QUEUE_MAX is 2 with no drillYard level — queue is full
    });
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(t('city.err.trainQueueFull'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('does not call trainTroops and shows a toast when the troop cap is already reached', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    // Pool already at the cap: troops = troopCapFor({}) = TROOP_CAP_BASE (the modal derives cap from
    // buildings, not me.troopCap), so there's no headroom and +10 is rejected with the cap toast.
    const { scene, inner, trainTroops } = await openTrainModal({ troops: TROOP_CAP_BASE, resources: { ink: 100000 } });
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(t('city.err.troopCap'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('does not call trainTroops and shows a toast when there is not enough ink', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    // ink 5 < TROOP_TRAIN_INK_COST(10) — can't even afford +10, but there's still troopCap headroom.
    const { scene, inner, trainTroops } = await openTrainModal({ troops: 0, troopCap: 2000, resources: { ink: 5 } });
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(t('city.err.noInk'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('renders each queued training entry with its qty and countdown', async () => {
    const now = Date.now();
    const { scene } = await openTrainModal({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainingQueue: [{ qty: 37, startAt: now, completeAt: now + 12000 }],
    });
    const texts = collectTexts(scene.container);
    // Only assert the qty-bearing prefix, not the full templated string — the countdown seconds
    // are computed against Date.now() at render time and can be off by a tick from `now` above.
    const prefix = t('city.trainEntry').split('{time}')[0]!.replace('{n}', '37');
    expect(texts.some((s) => s.startsWith(prefix))).toBe(true);
    scene.destroy();
  });

  it('does not double-train when the +10 button is tapped twice before the first request resolves (busy guard)', async () => {
    let resolveFirst!: (v: PlayerWorldView) => void;
    const pending = new Promise<PlayerWorldView>((r) => { resolveFirst = r; });
    const { scene, inner, trainTroops } = await openTrainModal({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainTroopsImpl: () => pending,
    });
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).toHaveBeenCalledTimes(1);
    resolveFirst({ joined: true, resources: {}, buildings: {}, buildQueue: [], trainingQueue: [], troops: 10, troopCap: 2000 } as unknown as PlayerWorldView);
    await new Promise((r) => setTimeout(r, 0));
    scene.destroy();
  });

  it('shows the no-ink toast when the server rejects trainTroops with an ink-related error', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const { scene, inner } = await openTrainModal({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainTroopsImpl: () => Promise.reject(new Error('not enough ink')),
    });
    const modalHits = trainModalHits(inner);
    const preset10 = modalHits[0]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith(t('city.err.noInk'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('renders a speedup button that calls worldApi.speedupTraining when the queue is non-empty', async () => {
    const now = Date.now();
    const { scene, inner, speedupTraining } = await openTrainModal({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainingQueue: [{ qty: 10, startAt: now, completeAt: now + 60000 }],
    });
    // Second-to-last hit — the last one is always the full-screen close-on-tap-outside catch-all,
    // pushed after the drillYard block finishes (see trainModalHits() doc comment).
    const modalHits = trainModalHits(inner);
    const speedupHit = modalHits[modalHits.length - 2]!;
    tap(inner, speedupHit.x + speedupHit.w / 2, speedupHit.y + speedupHit.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(speedupTraining).toHaveBeenCalledTimes(1);
    expect(speedupTraining.mock.calls[0]![0]).toBe('world:1:0');
    scene.destroy();
  });
});
