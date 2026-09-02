// Regression coverage for the build-detail modal's CLAMPED numbers — every figure the modal quotes
// that the rest of the code caps (user bug report 2026-09-02 + the sweep it prompted).
//
// Why: `atMax` was `lvl >= DESK_MAX_LEVEL && key === 'desk'`, so ONLY the desk ever reported
// "已满级". Every other building — which stops at the same ceiling, because a non-desk target above
// the desk's own cap can never clear the desk gate — fell through to the upgrade rows at L10 and
// advertised "→ Lv.11", a cost, a duration, and "需书桌 Lv.11": a desk level that cannot exist.
// These tests pin that every building reads as maxed at BUILDING_MAX_LEVEL, offers no upgrade
// button and no unreachable desk requirement, and that the rows below the cap are untouched.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import {
  BUILDING_MAX_LEVEL, BUILDING_KEYS,
  DRILL_TRAIN_SPEED_STEP, DRILL_TRAIN_SPEED_FLOOR, drillTrainMult,
} from '@nw/shared';
import type { WorldApiClient, PlayerWorldView, BuildingKey } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('zh', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];

type CitySceneInternals = {
  hits: Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
  selectedBuilding: BuildingKey | null;
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

/** Resources far above any cost, so a missing max-level check can only be seen as an *offer*, not
 *  as an unaffordable one — the modal renders the upgrade rows either way. */
const RICH = { ink: 9e8, paper: 9e8, graphite: 9e8, metal: 9e8, sticker: 9e8 };

async function openModal(
  levels: Partial<Record<BuildingKey, number>>,
  key: BuildingKey
): Promise<{ scene: CityScene; inner: CitySceneInternals; texts: string[] }> {
  const me = {
    resources: RICH, buildings: levels, cardState: {}, teamState: {}, buildQueue: [],
  } as unknown as PlayerWorldView;
  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
  } as unknown as WorldApiClient;
  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi,
    worldId: 'world:1:0',
    getFlag: () => true, // keeps the SLG guide chain's skip glyph out of the hit set
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  await new Promise((r) => setTimeout(r, 0));
  const inner = internals(scene);
  inner.selectedBuilding = key;
  inner.render();
  return { scene, inner, texts: collectTexts(scene.container) };
}

/** Hits that would start an upgrade — the button the maxed state must not register. */
function upgradeHits(inner: CitySceneInternals): number {
  return inner.hits.filter((h) => h.fn.toString().includes('doUpgrade')).length;
}

const ALL_MAXED = Object.fromEntries(
  BUILDING_KEYS.map((k) => [k, BUILDING_MAX_LEVEL])
) as Partial<Record<BuildingKey, number>>;

describe('CityScene build-detail modal at max level', () => {
  // graphiteMill is the one in the screenshot; the loop below covers the rest.
  it('reads "已满级" for a maxed stationery building instead of offering Lv.11', async () => {
    const { scene, inner, texts } = await openModal(ALL_MAXED, 'graphiteMill');
    expect(texts).toContain(t('city.maxLevel'));
    expect(texts).not.toContain(`→ Lv.${BUILDING_MAX_LEVEL + 1}`);
    expect(texts).not.toContain(t('city.upgrade'));
    expect(upgradeHits(inner)).toBe(0);
    scene.destroy();
  });

  it('holds for every building key — none advertises a level past the cap', async () => {
    for (const key of BUILDING_KEYS) {
      const { scene, inner, texts } = await openModal(ALL_MAXED, key);
      // No unreachable desk requirement, no over-cap target, and no way to send the upgrade at all
      // (the server would reject it as 'building at max level' — see city.ts buildGateReason).
      expect(texts, key).not.toContain(t('city.deskGate').replace('{lvl}', String(BUILDING_MAX_LEVEL + 1)));
      expect(texts, key).not.toContain(`→ Lv.${BUILDING_MAX_LEVEL + 1}`);
      expect(texts, key).not.toContain(t('city.upgrade'));
      expect(upgradeHits(inner), key).toBe(0);
      expect(texts, key).toContain(t('city.maxLevel'));
      scene.destroy();
    }
  });

  it('still offers the upgrade one level below the cap (the fix does not eat the last level)', async () => {
    const levels = { ...ALL_MAXED, graphiteMill: BUILDING_MAX_LEVEL - 1 };
    const { scene, inner, texts } = await openModal(levels, 'graphiteMill');
    expect(texts).toContain(`→ Lv.${BUILDING_MAX_LEVEL}`);
    expect(texts).toContain(t('city.upgrade'));
    expect(texts).not.toContain(t('city.maxLevel'));
    expect(upgradeHits(inner)).toBe(1);
    scene.destroy();
  });

  it('keeps the real desk gate for a building held back by a small desk', async () => {
    const { scene, texts } = await openModal({ desk: 3, graphiteMill: 3 }, 'graphiteMill');
    expect(texts).toContain(t('city.deskGate').replace('{lvl}', '4'));
    expect(texts).not.toContain(t('city.maxLevel'));
    scene.destroy();
  });
});

// Same class of bug, found sweeping for it: a bonus line quoting a number the rest of the code
// clamps away. drillTrainMult() floors the training-time multiplier at DRILL_TRAIN_SPEED_FLOOR, but
// the card printed the raw `level x DRILL_TRAIN_SPEED_STEP`, so from L7 up it promised a speed-up
// the training queue never applies — "+80%" at L10 against a real +50%.
describe('CityScene drillYard training-speed line respects the speed floor', () => {
  const pct = (lvl: number): string =>
    t('city.bonusTrainSpeed').replace('{pct}', String(Math.round((1 - drillTrainMult({ drillYard: lvl })) * 100)));
  /** First level at which the floor bites (econ-sim/src/city.ts computes it the same way). */
  const floorLevel = Math.ceil((1 - DRILL_TRAIN_SPEED_FLOOR) / DRILL_TRAIN_SPEED_STEP);

  it('quotes the floored value at max level, not level x step', async () => {
    const { scene, texts } = await openModal(ALL_MAXED, 'drillYard');
    expect(texts).toContain(pct(BUILDING_MAX_LEVEL));
    expect(pct(BUILDING_MAX_LEVEL)).toBe(t('city.bonusTrainSpeed').replace('{pct}', '50'));
    // The raw product — what it used to print.
    expect(texts).not.toContain(
      t('city.bonusTrainSpeed').replace('{pct}', String(Math.round(BUILDING_MAX_LEVEL * DRILL_TRAIN_SPEED_STEP * 100)))
    );
    scene.destroy();
  });

  it('is unchanged below the floor and pinned to it from the floor level up', async () => {
    const below = await openModal({ ...ALL_MAXED, drillYard: floorLevel - 1 }, 'drillYard');
    expect(below.texts).toContain(pct(floorLevel - 1));
    // Below the floor the raw product IS the truth — the fix must not shift these levels.
    expect(pct(floorLevel - 1)).toBe(
      t('city.bonusTrainSpeed').replace('{pct}', String(Math.round((floorLevel - 1) * DRILL_TRAIN_SPEED_STEP * 100)))
    );
    below.scene.destroy();

    for (const lvl of [floorLevel, BUILDING_MAX_LEVEL]) {
      const { scene, texts } = await openModal({ ...ALL_MAXED, drillYard: lvl }, 'drillYard');
      expect(texts, String(lvl)).toContain(t('city.bonusTrainSpeed').replace('{pct}', '50'));
      scene.destroy();
    }
  });
});
