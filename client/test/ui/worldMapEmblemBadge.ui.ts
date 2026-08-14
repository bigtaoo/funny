// Coverage for the world-map march/occupy/stationed token's family-emblem corner badge
// (family-emblem-art-prompts.md, 2026-08-14 — WorldMapRenderer/tokens.ts::syncEmblemBadge). This is
// an overlay, NOT a token replace (would regress the 2026-07-26 "show the real leader unit-type"
// decision) — the risk this file specifically guards is the badge accidentally becoming a CHILD of
// the stickman's own container, which flips scale.x for facing direction (mirrorX): a nested badge
// would silently mirror the emblem art too.
//
// Mocks render/emblemIcon.ts the same way emblemBadgeDisplay.ui.ts does — a real atlas never
// finishes decoding under the headless PIXI adapter, so without the mock buildEmblemIcon is always
// null and none of this is observable at all.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';

const EMBLEM_MARK = Symbol('emblemBadgeMock');

vi.mock('../../src/render/emblemIcon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/emblemIcon')>();
  return {
    ...actual,
    isEmblemAtlasReady: () => true,
    loadEmblemAtlas: async () => {},
    buildEmblemIcon: (key: string) => {
      const node = new PIXI.Container() as PIXI.Container & { [EMBLEM_MARK]: string };
      node[EMBLEM_MARK] = key;
      return node;
    },
  };
});

import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { EMBLEM_KEYS, EMBLEM_COLORS } from '../../src/render/emblemIcon';
import type { WorldApiClient, MarchView, OccupationView, StationedView } from '../../src/net/WorldApiClient';

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
    joinWorld: never, occupyTile: never, abandonTile: never, startMarch: never, recallMarch: never,
  } as unknown as WorldApiClient;
}

function buildScene(): any {
  return new WorldMapScene(createLayout(W, H), new InputManager(), {
    onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {},
    onOpenCity() {}, onOpenDefense() {},
    worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'Tester', accountId: 'acc_test',
    storage: memStore,
  }) as any;
}

function march(marchId: string, extra: Partial<MarchView> = {}): MarchView {
  const now = Date.now();
  return {
    marchId, kind: 'occupy', fromTile: 'world:1:0:15:20', toTile: 'world:1:0:25:20',
    troops: 100, departAt: now - 2000, arriveAt: now + 8000, status: 'marching', mine: true,
    ...extra,
  };
}

/** Every node the mocked buildEmblemIcon produced, found anywhere in `layer`'s children (badges are
 *  added as DIRECT children of ctx.marchTokenLayer, never nested under a token's own container). */
function findBadges(layer: PIXI.Container): Array<{ node: PIXI.DisplayObject; key: string }> {
  return layer.children
    .map((c) => ({ node: c, key: (c as unknown as Record<symbol, string>)[EMBLEM_MARK] }))
    .filter((x): x is { node: PIXI.DisplayObject; key: string } => x.key !== undefined);
}

describe('WorldMapRenderer/tokens.ts — march-token emblem corner badge', () => {
  it('a march whose owner has a family emblem gets a badge as a DIRECT child of marchTokenLayer (not nested under the mirrored stickman container)', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1', { emblemKey: EMBLEM_KEYS[3], emblemColor: EMBLEM_COLORS[2] })];
    scene.update(1 / 60);

    const badges = findBadges(scene.ctx.marchTokenLayer);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.key).toBe(EMBLEM_KEYS[3]);
    expect(badges[0]!.node.parent).toBe(scene.ctx.marchTokenLayer);

    scene.destroy();
  });

  it('a march whose owner has no family emblem gets no badge at all', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1')]; // no emblemKey
    scene.update(1 / 60);

    expect(findBadges(scene.ctx.marchTokenLayer)).toHaveLength(0);

    scene.destroy();
  });

  it('the SAME badge node persists across frames when the emblem key is unchanged (repositioned in place, not rebuilt)', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1', { emblemKey: EMBLEM_KEYS[0], emblemColor: EMBLEM_COLORS[0] })];
    scene.update(1 / 60);
    const first = findBadges(scene.ctx.marchTokenLayer)[0]!.node;

    scene.update(1 / 60);
    scene.update(1 / 60);
    const second = findBadges(scene.ctx.marchTokenLayer)[0]!.node;

    expect(second).toBe(first);
    expect(scene.ctx.marchTokenLayer.children).toHaveLength(1); // no duplicate/leaked badge

    scene.destroy();
  });

  it('changing the emblem key between frames destroys the old badge and creates a new one', () => {
    const scene = buildScene();
    const m = march('m1', { emblemKey: EMBLEM_KEYS[0], emblemColor: EMBLEM_COLORS[0] });
    scene.ctx.marches = [m];
    scene.update(1 / 60);
    const first = findBadges(scene.ctx.marchTokenLayer)[0]!.node;

    scene.ctx.marches = [{ ...m, emblemKey: EMBLEM_KEYS[1] }];
    scene.update(1 / 60);
    const badges = findBadges(scene.ctx.marchTokenLayer);

    expect(badges).toHaveLength(1); // old one torn down, exactly one survives
    expect(badges[0]!.key).toBe(EMBLEM_KEYS[1]);
    expect(badges[0]!.node).not.toBe(first);
    expect((first as PIXI.Container).destroyed).toBe(true);

    scene.destroy();
  });

  it('when the march ends (arrives/is recalled and drops off ctx.marches), its badge is torn down along with the token', () => {
    const scene = buildScene();
    scene.ctx.marches = [march('m1', { emblemKey: EMBLEM_KEYS[4], emblemColor: EMBLEM_COLORS[1] })];
    scene.update(1 / 60);
    const badge = findBadges(scene.ctx.marchTokenLayer)[0]!.node;
    expect((badge as PIXI.Container).destroyed).toBe(false);

    scene.ctx.marches = []; // march resolved — no longer in the live list
    scene.update(1 / 60);

    expect((badge as PIXI.Container).destroyed).toBe(true);
    expect(findBadges(scene.ctx.marchTokenLayer)).toHaveLength(0);

    scene.destroy();
  });

  it('an occupy-hold whose owner has a family emblem also gets a badge (getOccupations is own-holds-only, so this is always the requester\'s own badge)', () => {
    const scene = buildScene();
    const occ: OccupationView = { tile: 'world:1:0:10:10', x: 10, y: 10, level: 1, garrison: 500, dueAt: Date.now() + 60_000, emblemKey: EMBLEM_KEYS[7], emblemColor: EMBLEM_COLORS[3] };
    scene.ctx.occupations = [occ];
    scene.update(1 / 60);

    const badges = findBadges(scene.ctx.marchTokenLayer);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.key).toBe(EMBLEM_KEYS[7]);

    scene.destroy();
  });

  it('a stationed team whose owner has a family emblem also gets a badge', () => {
    const scene = buildScene();
    const st: StationedView = { tile: 'world:1:0:12:12', x: 12, y: 12, teamId: 't1', troops: 300, sinceAt: Date.now(), mine: true, emblemKey: EMBLEM_KEYS[9], emblemColor: EMBLEM_COLORS[5] };
    scene.ctx.stationed = [st];
    scene.update(1 / 60);

    const badges = findBadges(scene.ctx.marchTokenLayer);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.key).toBe(EMBLEM_KEYS[9]);

    scene.destroy();
  });
});
