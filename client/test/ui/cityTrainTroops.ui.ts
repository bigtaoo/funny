// Regression coverage for the drillYard train-troops controls (2026-07-20).
//
// The 2026-07-18 refactor (7c286b3b, "remove unreachable TeamsScene + train panel") deleted the
// old world-map train panel on the assumption that CityScene's drillYard modal already covered
// trainTroops()/speedupTraining(). It never did — the modal only ever rendered a static
// "Troops {cur}/{cap}" line, leaving no reachable client entry point to actually train troops
// even though the server API, i18n strings (city.trainPanel), and shared constants for it all
// still existed. This left a real account (3 idle teams, all empty of troops) unable to occupy
// tiles with no way to fix it in the UI.
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

/** While the drillYard modal is open, render() replaces `this.hits` with just [backHit, ...modal
 *  hits] (CityScene.ts's modal-hit-leak fix drops the background grid hits entirely — it does not
 *  merely reposition them past some x threshold, so filtering by `contentX` is wrong here: modal
 *  buttons are centered near screen x~80-500 and can sit on either side of the sidebar rail).
 *  Push order inside renderDetailModal for drillYard (never gated: desk defaults to level 1, and
 *  drillYard is never "at max level" since that check only applies to the desk building itself) is
 *  always: [Upgrade button, +10, +50, Max, speedup? , close-on-tap-outside (always last)]. */
function drillYardModalHits(inner: CitySceneInternals): Hit[] {
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

/** Builds the scene, waits for load(), opens the drillYard detail modal (grid index 7 in
 *  DOMESTIC_BUILDING_KEYS: desk/inkPot/paperTray/graphiteMill/metalForge/stickerShop/cabinet/drillYard/...). */
async function openDrillYard(fx: TrainFixture): Promise<{ scene: CityScene; inner: CitySceneInternals; me: PlayerWorldView; trainTroops: ReturnType<typeof vi.fn>; speedupTraining: ReturnType<typeof vi.fn> }> {
  const input = new InputManager();
  const { api, me, trainTroops, speedupTraining } = stubWorldApiWithTrain(fx);
  const cb: CitySceneCallbacks = { onBack: () => {}, worldApi: api, worldId: 'world:1:0' };
  const scene = new CityScene(createLayout(...PORTRAIT), input, cb);
  await new Promise((r) => setTimeout(r, 0));
  const inner = internals(scene);
  const drillYardCard = contentHits(inner)[7]!;
  tap(inner, drillYardCard.x + drillYardCard.w / 2, drillYardCard.y + drillYardCard.h / 2);
  expect(inner.selectedBuilding).toBe('drillYard');
  return { scene, inner, me, trainTroops, speedupTraining };
}

describe('CityScene drillYard train-troops controls (2026-07-20 restore)', () => {
  it('tapping the +10 preset trains troops via worldApi.trainTroops(worldId, 10)', async () => {
    const { scene, inner, trainTroops } = await openDrillYard({ troops: 0, troopCap: 2000, resources: { ink: 100000 } });
    // [Upgrade, +10, +50, Max, close-catch-all] — see drillYardModalHits() doc comment.
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).toHaveBeenCalledWith('world:1:0', 10);
    scene.destroy();
  });

  it('tapping Max trains the computed max qty: min(batch cap, troopCap headroom, ink affordable)', async () => {
    // troopCap 100, troops 0 → headroom 100; ink 200 / TROOP_TRAIN_INK_COST(10) → 20 affordable.
    // min(TROOP_TRAIN_BATCH_MAX=500, 100, 20) = 20.
    const { scene, inner, trainTroops } = await openDrillYard({ troops: 0, troopCap: 100, resources: { ink: 200 } });
    const modalHits = drillYardModalHits(inner);
    const presetMax = modalHits[3]!;
    tap(inner, presetMax.x + presetMax.w / 2, presetMax.y + presetMax.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).toHaveBeenCalledWith('world:1:0', 20);
    scene.destroy();
  });

  it('does not call trainTroops and shows a toast when the training queue is already full', async () => {
    const now = Date.now();
    const spy = vi.spyOn(log, 'showToastMessage');
    const { scene, inner, trainTroops } = await openDrillYard({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainingQueue: [
        { qty: 10, startAt: now, completeAt: now + 5000 },
        { qty: 10, startAt: now, completeAt: now + 10000 },
      ], // TROOP_TRAIN_QUEUE_MAX is 2 with no drillYard level — queue is full
    });
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(t('city.err.trainQueueFull'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('does not call trainTroops and shows a toast when the troop cap is already reached', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const { scene, inner, trainTroops } = await openDrillYard({ troops: 2000, troopCap: 2000, resources: { ink: 100000 } });
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
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
    const { scene, inner, trainTroops } = await openDrillYard({ troops: 0, troopCap: 2000, resources: { ink: 5 } });
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(trainTroops).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(t('city.err.noInk'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('renders each queued training entry with its qty and countdown', async () => {
    const now = Date.now();
    const { scene } = await openDrillYard({
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
    const { scene, inner, trainTroops } = await openDrillYard({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainTroopsImpl: () => pending,
    });
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
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
    const { scene, inner } = await openDrillYard({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainTroopsImpl: () => Promise.reject(new Error('not enough ink')),
    });
    const modalHits = drillYardModalHits(inner);
    const preset10 = modalHits[1]!;
    tap(inner, preset10.x + preset10.w / 2, preset10.y + preset10.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith(t('city.err.noInk'), 'error');
    scene.destroy();
    spy.mockRestore();
  });

  it('renders a speedup button that calls worldApi.speedupTraining when the queue is non-empty', async () => {
    const now = Date.now();
    const { scene, inner, speedupTraining } = await openDrillYard({
      troops: 0, troopCap: 2000, resources: { ink: 100000 },
      trainingQueue: [{ qty: 10, startAt: now, completeAt: now + 60000 }],
    });
    // Second-to-last hit — the last one is always the full-screen close-on-tap-outside catch-all,
    // pushed after the drillYard block finishes (see drillYardModalHits() doc comment).
    const modalHits = drillYardModalHits(inner);
    const speedupHit = modalHits[modalHits.length - 2]!;
    tap(inner, speedupHit.x + speedupHit.w / 2, speedupHit.y + speedupHit.h / 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(speedupTraining).toHaveBeenCalledTimes(1);
    expect(speedupTraining.mock.calls[0]![0]).toBe('world:1:0');
    scene.destroy();
  });
});
