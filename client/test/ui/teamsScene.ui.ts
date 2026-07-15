// Regression coverage for the 2026-07-15 TeamsScene (Attack Teams) redesign: the 5 formation
// slots became a 2-column card grid (mini portrait strip / "+ Tap to build" empty state) and the
// Hero Roster palette became a scrollable portrait-card grid instead of a flat list that silently
// dropped any card past the bottom of the screen (`if (y + CARD_ROW_H > h - 8) break`, no scroll).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Tabs/cards are located by their rendered label text (not by hit-array index), same convention
// as cardSceneSkins.ui.ts / worldMapBaseClick.ui.ts. Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { TeamsScene, teamSlotName, type TeamsCallbacks } from '../../src/scenes/TeamsScene';
import type { WorldApiClient, TeamTemplate, PlayerWorldView } from '../../src/net/WorldApiClient';
import type { SaveData, CardInstance } from '../../src/game/meta/SaveData';

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

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: node.x, y: node.y }; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function hasLabel(container: PIXI.Container, label: string): boolean {
  return findLabelPos(container, label) !== null;
}

/** Taps the hit rect that contains the given label's rendered position (same convention as cardSceneSkins.ui.ts). */
function tap(scene: { container: PIXI.Container }, label: string): void {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hits: Hit[] }).hits;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under label "${label}"`).toBeDefined();
  hit!.action();
}

function makeCard(id: string, defId: string, level: number): CardInstance {
  return { id, defId, level, xp: 0, gear: {}, locked: false };
}

/** Minimal WorldApiClient stub — only the methods TeamsScene actually calls are real. */
function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return {
    getTeams: async () => [],
    getMe: async () => ({ joined: true } as PlayerWorldView),
    distributeTroops: async () => ({ ok: true }),
    getMarches: async () => [],
    getOccupations: async () => [],
    ...overrides,
  } as unknown as WorldApiClient;
}

function makeCb(overrides: Partial<TeamsCallbacks> = {}): TeamsCallbacks {
  return {
    onBack: () => {},
    onEditTeam: () => {},
    getSave: () => ({ cardInv: {} } as unknown as SaveData),
    worldApi: stubWorldApi(),
    worldId: 'world:1:0',
    ...overrides,
  };
}

describe('TeamsScene — formation slot card grid', () => {
  it('empty slots show the "Tap to build" hint and tapping one opens the editor with the right slot id/name', async () => {
    const onEditTeam = vi.fn();
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), makeCb({ onEditTeam })) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    expect(hasLabel(scene.container, t('world.team.tapToBuild'))).toBe(true);

    tap(scene, teamSlotName(1)); // "Team 2" — empty slot
    expect(onEditTeam).toHaveBeenCalledWith('t2', teamSlotName(1));
  });

  it('a filled slot shows garrison/committed troops and tapping it opens the editor', async () => {
    const cardInv = { c1: makeCard('c1', 'max', 1), c2: makeCard('c2', 'lena', 1) };
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Team 1', army: [
        { cardInstanceId: 'c1', col: 1, row: 1 },
        { cardInstanceId: 'c2', col: 2, row: 1 },
      ] },
    ];
    const cardState = { c1: { currentTroops: 100 }, c2: { currentTroops: 150 } };
    const onEditTeam = vi.fn();
    const cb = makeCb({
      onEditTeam,
      getSave: () => ({ cardInv } as unknown as SaveData),
      worldApi: stubWorldApi({
        getTeams: async () => teams,
        getMe: async () => ({ joined: true, cardState } as unknown as PlayerWorldView),
      }),
    });
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const sub = `${t('world.defense.garrison').replace('{n}', '2')}   ${t('world.team.committed').replace('{n}', '250')}`;
    expect(hasLabel(scene.container, sub)).toBe(true);

    tap(scene, 'Team 1');
    expect(onEditTeam).toHaveBeenCalledWith('t1', 'Team 1');
  });

  it('an injury-locked team (ADR-026 §5) shows the injured countdown tag', async () => {
    const teams: TeamTemplate[] = [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c1', col: 1, row: 1 }] }];
    const cb = makeCb({
      getSave: () => ({ cardInv: { c1: makeCard('c1', 'max', 1) } } as unknown as SaveData),
      worldApi: stubWorldApi({
        getTeams: async () => teams,
        getMe: async () => ({
          joined: true,
          cardState: { c1: { currentTroops: 100 } },
          teamState: { t1: { injuredUntil: Date.now() + 45_000 } },
        } as unknown as PlayerWorldView),
      }),
    });
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    // secsLeft rounds up via Math.ceil — accept the label without pinning the exact second count.
    expect(hasLabel(scene.container, `[${t('roster.injured').replace('{time}', '45s')}]`)
      || hasLabel(scene.container, `[${t('roster.injured').replace('{time}', '46s')}]`)).toBe(true);
  });
});

describe('TeamsScene — Hero Roster card grid (replaces the old cut-off list)', () => {
  function manyCardsCb(count: number): { cb: TeamsCallbacks; lastId: string } {
    const cardInv: Record<string, CardInstance> = {};
    const defs = ['lichuang', 'chenshou', 'suyuan', 'max', 'lena', 'mara'];
    for (let i = 0; i < count; i++) {
      cardInv[`c${i}`] = makeCard(`c${i}`, defs[i % defs.length], 1);
    }
    const lastId = `c${count - 1}`;
    const cb = makeCb({ getSave: () => ({ cardInv } as unknown as SaveData) });
    return { cb, lastId };
  }

  it('regression: a roster that overflows the screen is reachable via scroll, not silently dropped', async () => {
    const { cb } = manyCardsCb(40);
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    // The old implementation had no scroll at all (`break` past the screen bottom) — this asserts
    // the grid now reports genuine overflow instead of quietly truncating the list.
    expect(scene.scrollMax).toBeGreaterThan(0);

    // First card is visible at rest.
    expect(hasLabel(scene.container, 'Li Chuang Lv.1')).toBe(true);

    // Drive a real drag gesture (down + moves) all the way to the bottom of the grid, then confirm
    // a card that was off-screen at scrollY=0 is now rendered.
    scene.handleDown(W / 2, H - 40);
    scene.handleMove(H - 40 - (scene.scrollMax + 999)); // clamps internally to scrollMax
    scene.update(1 / 60);

    expect(scene.scrollY).toBe(scene.scrollMax);
    expect(hasLabel(scene.container, 'Mara Lv.1')).toBe(true); // c39 → defs[39%6]='mara'
  });

  it('scroll-drag renders once per frame, not once per pointermove (2026-07-15 throttle pattern)', async () => {
    const { cb } = manyCardsCb(40);
    const input = new InputManager();
    const scene = new TeamsScene(createLayout(W, H), input, cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(W / 2, H - 40);
    input._emitMove(W / 2, H - 60);
    input._emitMove(W / 2, H - 80);
    input._emitMove(W / 2, H - 100);
    expect(renderSpy).not.toHaveBeenCalled();

    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    scene.destroy();
  });

  it('a small roster that fits on screen reports no overflow', async () => {
    const { cb } = manyCardsCb(2);
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    expect(scene.scrollMax).toBe(0);
  });
});

describe('TeamsScene — Fill All Troops', () => {
  it('distributes baseTroopStock to the highest-deficit cards first', async () => {
    const cardInv = {
      c1: makeCard('c1', 'lichuang', 1), // cap 200
      c2: makeCard('c2', 'max', 1),      // cap 100
    };
    const cardState = { c1: { currentTroops: 0 }, c2: { currentTroops: 90 } };
    let distributed: Record<string, number> | null = null;
    const cb = makeCb({
      getSave: () => ({ cardInv } as unknown as SaveData),
      worldApi: stubWorldApi({
        getMe: async () => ({ joined: true, baseTroopStock: 150, cardState } as unknown as PlayerWorldView),
        distributeTroops: async (_worldId: string, allocations: Record<string, number>) => {
          distributed = allocations;
          return { ok: true };
        },
      }),
    });
    const scene = new TeamsScene(createLayout(W, H), new InputManager(), cb) as any;
    await Promise.resolve();
    await Promise.resolve();
    scene.render();

    tap(scene, `${t('world.team.fillTroops')}  (150 ${t('world.troops')})`);
    await Promise.resolve();
    await Promise.resolve();

    // c1's deficit (200) is filled first (highest gap), consuming all 150 stock; c2 gets nothing.
    expect(distributed).toEqual({ c1: 150 });
  });
});
