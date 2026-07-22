// Coverage for "一键补满" (fill troops), added 2026-07-18 after account tao reported two configured
// teams still showing "No teams yet" on occupy. Root cause: placing cards into a formation
// (DefenseEditorScene) never gave them troops — CHARACTER_CARDS_DESIGN §6.5's "分配兵力" step
// (POST /world/troops/distribute, WorldApiClient.distributeTroops) had no UI entry point anywhere in
// the client, so cardState[id].currentTroops stayed 0 and carriedTroops() (teamTroops.ts) always
// filtered the team out of WorldMapNet's occupy/attack team picker. See
// slg-occupy-team-fill-troops-2026-07-18 memory.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import type { WorldApiClient, TeamTemplate, CardSLGState, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';

function buildSave(cardDefs: { id: string; level?: number }[]): SaveData {
  const save = makeNewSave('acc_test');
  for (const { id, level } of cardDefs) {
    save.cardInv![id] = { id, defId: 'lichuang', level: level ?? 1, gear: {}, locked: false };
  }
  return save;
}

function buildHarness(opts: {
  cards: { id: string; level?: number }[];
  cardState?: Record<string, CardSLGState>;
  teams?: TeamTemplate[];
  troops?: number;
}) {
  const save = buildSave(opts.cards);
  const setTeams = vi.fn().mockResolvedValue(undefined);
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? [{ id: 't1', name: 'Team 1', army: [] }]);
  const distributeTroops = vi.fn().mockResolvedValue({ ok: true });
  const getMe = vi.fn().mockResolvedValue({
    cardState: opts.cardState ?? {},
    troops: opts.troops ?? 0,
  } as PlayerWorldView);
  const worldApi = { getTeams, setTeams, getMe, distributeTroops } as unknown as WorldApiClient;

  const cb: DefenseEditorCallbacks = {
    onBack: vi.fn(),
    getSave: () => save,
    worldApi,
    worldId: WORLD_ID,
    target: { mode: 'attack', teamId: 't1', teamName: 'Team 1' },
  };
  const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), cb);
  return { scene, cb, save, distributeTroops, getMe };
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('DefenseEditorScene attack mode — fill troops (§6.5, 2026-07-18)', () => {
  it('a team saved with cards placed but never given troops carries 0 (the reported bug)', async () => {
    const { scene } = buildHarness({
      cards: [{ id: 'c0' }],
      cardState: { c0: { currentTroops: 0 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    const committed = (scene as unknown as { committedTroops(): number }).committedTroops();
    expect(committed).toBe(0); // reproduces the "No teams yet" symptom upstream in WorldMapNet
  });

  it('fill troops distributes the base pool to placed cards, highest power first, up to troopCap', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }, { id: 'c1', level: 9 }], // c1 has higher power (higher level)
      cardState: { c0: { currentTroops: 0 }, c1: { currentTroops: 0 } },
      teams: [{
        id: 't1', name: 'Team 1',
        army: [{ cardInstanceId: 'c0', col: 0, row: 8 }, { cardInstanceId: 'c1', col: 1, row: 8 }],
      }],
      troops: 100,
    });
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();

    expect(distributeTroops).toHaveBeenCalledTimes(1);
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    // Pool (100) is smaller than either card's troopCap, so it all goes to the higher-power card first.
    expect(allocations.c1).toBe(100);
    expect(allocations.c0).toBeUndefined();

    const committed = (scene as unknown as { committedTroops(): number }).committedTroops();
    expect(committed).toBe(100);
    expect((scene as unknown as { troops: number }).troops).toBe(0);
  });

  it('does nothing and does not call the API when the pool is empty', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0' }],
      cardState: { c0: { currentTroops: 0 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 0,
    });
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();
    expect(distributeTroops).not.toHaveBeenCalled();
  });

  it('skips cards already at troopCap and leaves the remaining pool untouched', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }],
      cardState: { c0: { currentTroops: 10_000 } }, // already far above any level-1 card's troopCap
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 500,
    });
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();
    expect(distributeTroops).not.toHaveBeenCalled();
    expect((scene as unknown as { troops: number }).troops).toBe(500);
  });

  it('spills the remainder onto the next card once the highest-power card is topped off', async () => {
    // lichuang troopCapBase=200/+50 per level: level5 cap=400 (power 144.4), level1 cap=200 (power 100).
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }, { id: 'c1', level: 5 }],
      cardState: { c0: { currentTroops: 0 }, c1: { currentTroops: 0 } },
      teams: [{
        id: 't1', name: 'Team 1',
        army: [{ cardInstanceId: 'c0', col: 0, row: 8 }, { cardInstanceId: 'c1', col: 1, row: 8 }],
      }],
      troops: 450,
    });
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.c1).toBe(400); // higher power, filled to its cap first
    expect(allocations.c0).toBe(50);  // remaining pool spills onto the next card
    expect((scene as unknown as { committedTroops(): number }).committedTroops()).toBe(450);
    expect((scene as unknown as { troops: number }).troops).toBe(0);
  });

  it('only tops up the gap for a card that already carries some troops, not the full cap', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }], // troopCap 200
      cardState: { c0: { currentTroops: 150 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 500,
    });
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.c0).toBe(50); // 200 cap - 150 already carried, not the full 200
    expect((scene as unknown as { committedTroops(): number }).committedTroops()).toBe(200);
    expect((scene as unknown as { troops: number }).troops).toBe(450);
  });

  it('a rejected distributeTroops call leaves cardState/troops untouched and can be retried', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }],
      cardState: { c0: { currentTroops: 0 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 500,
    });
    distributeTroops.mockRejectedValueOnce(new Error('network error'));
    await flush();

    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();
    expect(distributeTroops).toHaveBeenCalledTimes(1);
    expect((scene as unknown as { committedTroops(): number }).committedTroops()).toBe(0);
    expect((scene as unknown as { troops: number }).troops).toBe(500);

    // Retry succeeds once the transient error clears.
    await (scene as unknown as { doFillTroops(): Promise<void> }).doFillTroops();
    expect(distributeTroops).toHaveBeenCalledTimes(2);
    expect((scene as unknown as { committedTroops(): number }).committedTroops()).toBe(200);
  });
});

describe('DefenseEditorScene attack mode — per-card allocate (分兵 stepper, 2026-07-21)', () => {
  type Alloc = { allocateToCard(id: string, n: number): Promise<void> };

  it('adds the requested amount to one card, drawing from the pool, and persists team-then-distribute', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }, { id: 'c1', level: 1 }],
      cardState: { c0: { currentTroops: 0 }, c1: { currentTroops: 0 } },
      teams: [{
        id: 't1', name: 'Team 1',
        army: [{ cardInstanceId: 'c0', col: 0, row: 8 }, { cardInstanceId: 'c1', col: 1, row: 8 }],
      }],
      troops: 500,
    });
    await flush();

    await (scene as unknown as Alloc).allocateToCard('c0', 100);

    expect(distributeTroops).toHaveBeenCalledTimes(1);
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations).toEqual({ c0: 100 }); // only the tapped card, not a fill-all
    expect((scene as unknown as { troops: number }).troops).toBe(400);
    expect((scene as unknown as { committedTroops(): number }).committedTroops()).toBe(100);
  });

  it('clamps the added amount to the card troopCap gap', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }], // troopCap 200
      cardState: { c0: { currentTroops: 150 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 500,
    });
    await flush();

    await (scene as unknown as Alloc).allocateToCard('c0', 500); // asks for 500, only 50 fits under the cap
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.c0).toBe(50);
    expect((scene as unknown as { troops: number }).troops).toBe(450);
  });

  it('clamps the added amount to the available pool', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }],
      cardState: { c0: { currentTroops: 0 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 30,
    });
    await flush();

    await (scene as unknown as Alloc).allocateToCard('c0', 100); // pool only has 30
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.c0).toBe(30);
    expect((scene as unknown as { troops: number }).troops).toBe(0);
  });

  it('does nothing (no distribute call) when the card is already at its troopCap', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [{ id: 'c0', level: 1 }], // troopCap 200
      cardState: { c0: { currentTroops: 200 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
      troops: 500,
    });
    await flush();

    await (scene as unknown as Alloc).allocateToCard('c0', 100);
    expect(distributeTroops).not.toHaveBeenCalled();
    expect((scene as unknown as { troops: number }).troops).toBe(500);
  });
});
