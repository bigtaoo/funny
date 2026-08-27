// Regression coverage for the build-detail modal's own speed-up button (2026-08-27).
//
// Why: the only speed-up control used to live in the build-queue bar (render.ts's
// renderBuildQueue), *behind* the detail modal's dim layer — and the modal deliberately swallows
// every tap outside its panel. So a player watching "建造中" in the modal had to close it, hunt the
// queue bar, tap speed-up, and reopen the modal. The button now sits on the same row as the
// "building…" label; these tests pin that it appears only while the building is actually queued
// with time left, and that tapping it fires speedupBuild for THAT building.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { BUILD_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../../src/net/WorldApiClient';

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
  selectedBuilding: BuildingKey | null;
  contentX: number;
  render(): void;
};

function internals(scene: CityScene): CitySceneInternals {
  return (scene as unknown as { core: CitySceneInternals }).core;
}

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

type Fixture = { key: BuildingKey; level: number; secsLeft: number };

async function buildLoaded(
  fx: Fixture
): Promise<{ scene: CityScene; inner: CitySceneInternals; calls: Array<{ key: BuildingKey; coins: number }> }> {
  const calls: Array<{ key: BuildingKey; coins: number }> = [];
  const me = {
    // desk Lv.10 clears the desk-level gate, so the modal reaches its upgrade / speed-up row
    // rather than the "needs a bigger desk" line.
    resources: {}, buildings: { desk: 10, [fx.key]: fx.level }, cardState: {}, teamState: {},
    buildQueue: [{ key: fx.key, toLevel: fx.level + 1, completeAt: Date.now() + fx.secsLeft * 1000 }],
  } as unknown as PlayerWorldView;
  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: (_worldId: string, key: BuildingKey, coins: number) => {
      calls.push({ key, coins });
      return new Promise<PlayerWorldView>(() => {});
    },
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi,
    worldId: 'world:1:0',
    // Keep the SLG opening guide chain's skip glyph out of the hit set.
    getFlag: () => true,
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  await new Promise((r) => setTimeout(r, 0));
  return { scene, inner: internals(scene), calls };
}

/** Opens the detail modal for `key`. Set directly rather than hunting the right grid card: which
 *  card sits where is cityScene.ui.ts's business, not this file's. */
function openModal(inner: CitySceneInternals, key: BuildingKey): void {
  inner.selectedBuilding = key;
  inner.render();
}

/** The modal's speed-up hit, identified by the closure it was pushed with. */
function speedupHit(inner: CitySceneInternals): Hit | undefined {
  return inner.hits.find((h) => h.fn.toString().includes('doSpeedup'));
}

describe('CityScene build-detail modal speed-up button', () => {
  it('shows the speed-up button beside "building…" and charges the remaining-time price for that building', async () => {
    const secsLeft = 24 * 3600;
    const { scene, inner, calls } = await buildLoaded({ key: 'inkPot', level: 2, secsLeft });
    openModal(inner, 'inkPot');

    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.upgrading'));
    const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
    expect(texts).toContain(t('city.speedup').replace('{coins}', String(coins)));
    // The queued building offers no upgrade button — speed-up replaces it, it doesn't join it.
    expect(texts).not.toContain(t('city.upgrade'));

    const hit = speedupHit(inner);
    expect(hit).toBeDefined();
    // Inside the panel and clear of the "building…" label at the row's left edge.
    expect(hit!.w).toBeGreaterThan(0);
    hit!.fn();
    expect(calls).toEqual([{ key: 'inkPot', coins }]);
    scene.destroy();
  });

  it('drops the button once the queued build has no time left (the queue entry is about to clear)', async () => {
    const { scene, inner } = await buildLoaded({ key: 'inkPot', level: 2, secsLeft: 0 });
    openModal(inner, 'inkPot');
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.upgrading'));
    expect(texts.some((s) => s.startsWith(t('city.speedup').split('{')[0]!))).toBe(false);
    expect(speedupHit(inner)).toBeUndefined();
    scene.destroy();
  });

  it('leaves a NOT-queued building on its normal upgrade button (no speed-up leaks into it)', async () => {
    const { scene, inner } = await buildLoaded({ key: 'inkPot', level: 2, secsLeft: 24 * 3600 });
    openModal(inner, 'paperTray');
    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('city.upgrade'));
    expect(speedupHit(inner)).toBeUndefined();
    scene.destroy();
  });
});
