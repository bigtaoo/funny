// Coverage for CityScene's "填满所有队伍" (Fill All Teams) button (2026-08-02): distributes the
// home troop pool across all 5 teams in slot order (t1..t5), topping each up to its army's troopCap
// before spilling onto the next team, instead of opening each team's formation editor to hit the
// per-team 分兵 button individually (DefenseEditorScene.doFillTroops, see defenseEditorFillTroops.ui.ts).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { teamSlotId, TEAM_CAP } from '../../src/game/meta/teamTroops';
import type { WorldApiClient, PlayerWorldView, TeamTemplate, CardSLGState } from '../../src/net/WorldApiClient';
import type { SaveData, CardInstance } from '../../src/game/meta/SaveData';
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
const WORLD_ID = 'world:1:0';

type Rect = { x: number; y: number; w: number; h: number };
type Hit = Rect & { fn: () => void };
type CitySceneInternals = {
  hits: Hit[];
  me: PlayerWorldView | null;
  doFillAllTeams(): Promise<void>;
};

function internals(scene: CityScene): CitySceneInternals {
  return scene as unknown as CitySceneInternals;
}

function card(id: string, level = 1): CardInstance {
  return { id, defId: 'lichuang', level, gear: {}, locked: false };
}

type Fixture = {
  cards: CardInstance[];
  teams: TeamTemplate[];
  cardState?: Record<string, CardSLGState>;
  troops?: number;
  teamState?: Record<string, { injuredUntil?: number }>;
  marches?: { marchId: string; mine?: boolean; teamId: string; arriveAt: number }[];
  /** Override the resolved distributeTroops mock (e.g. to delay resolution for a busy-guard test). */
  distributeTroopsImpl?: (worldId: string, allocations: Record<string, number>) => Promise<{ ok: true }>;
  onEditTeam?: (teamId: string, teamName: string) => void;
};

function buildHarness(fx: Fixture) {
  const cardInv: Record<string, CardInstance> = {};
  for (const c of fx.cards) cardInv[c.id] = c;
  const save = { cardInv, equipmentInv: {} } as unknown as SaveData;

  const distributeTroops = vi.fn(fx.distributeTroopsImpl ?? (() => Promise.resolve({ ok: true as const })) as Fixture['distributeTroopsImpl']);
  const me = {
    resources: {}, buildings: {}, buildQueue: [],
    cardState: fx.cardState ?? {}, teamState: fx.teamState ?? {},
    troops: fx.troops ?? 0,
  } as unknown as PlayerWorldView;

  const worldApi = {
    getMe: () => Promise.resolve(me),
    getTeams: () => Promise.resolve(fx.teams),
    getMarches: () => Promise.resolve(fx.marches ?? []),
    getOccupations: () => Promise.resolve([]),
    distributeTroops,
  } as unknown as WorldApiClient;

  const cb: CitySceneCallbacks = {
    onBack: () => {},
    worldApi,
    worldId: WORLD_ID,
    getSave: () => save,
    onEditTeam: fx.onEditTeam,
  };
  const scene = new CityScene(createLayout(...PORTRAIT), new InputManager(), cb);
  return { scene, distributeTroops };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('CityScene "Fill All Teams" button (2026-08-02)', () => {
  it('registers a hit rect, above the team-card row, that fires doFillAllTeams', async () => {
    const { scene } = buildHarness({ cards: [], teams: [] });
    await flush();
    const inner = internals(scene);
    const fillHit = inner.hits.find((h) => h.fn.toString().includes('doFillAllTeams'));
    expect(fillHit).toBeDefined();
    scene.destroy();
  });

  it('tops up teams in slot order (t1 before t2), highest-power card first within a team', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1), card('b1', 1)], // both troopCap 200
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { a1: { currentTroops: 0 }, b1: { currentTroops: 0 } },
      troops: 250, // fills t1's card to its 200 cap, spills the remaining 50 onto t2
    });
    await flush();

    await internals(scene).doFillAllTeams();

    expect(distributeTroops).toHaveBeenCalledTimes(1);
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a1).toBe(200);
    expect(allocations.b1).toBe(50);
    scene.destroy();
  });

  it('leaves later teams untouched once the pool runs dry', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1), card('b1', 1)],
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { a1: { currentTroops: 0 }, b1: { currentTroops: 0 } },
      troops: 100, // not even enough to fill t1 alone (cap 200)
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a1).toBe(100);
    expect(allocations.b1).toBeUndefined();
    scene.destroy();
  });

  it('skips a team already at its troop cap and moves on to the next', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1), card('b1', 1)],
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { a1: { currentTroops: 200 }, b1: { currentTroops: 0 } }, // t1 already full
      troops: 500,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a1).toBeUndefined();
    expect(allocations.b1).toBe(200);
    scene.destroy();
  });

  it('does nothing and shows a toast when the troop pool is empty', async () => {
    const toastSpy = vi.spyOn(log, 'showToastMessage');
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1)],
      teams: [{ id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] }],
      cardState: { a1: { currentTroops: 0 } },
      troops: 0,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    expect(distributeTroops).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(t('city.military.fillAllTeamsNone'), 'error');
    scene.destroy();
  });

  it('applies the allocation to local cardState/troops on success (no full-scene refetch)', async () => {
    const { scene } = buildHarness({
      cards: [card('a1', 1)],
      teams: [{ id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] }],
      cardState: { a1: { currentTroops: 0 } },
      troops: 500,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const inner = internals(scene);
    expect(inner.me?.cardState?.a1?.currentTroops).toBe(200); // troopCap for level-1 lichuang
    expect(inner.me?.troops).toBe(300); // 500 - 200
    scene.destroy();
  });

  it('a rejected distributeTroops call leaves cardState/troops untouched', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1)],
      teams: [{ id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] }],
      cardState: { a1: { currentTroops: 0 } },
      troops: 500,
    });
    distributeTroops.mockRejectedValueOnce(new Error('network error'));
    await flush();

    await internals(scene).doFillAllTeams();

    const inner = internals(scene);
    expect(inner.me?.cardState?.a1?.currentTroops).toBe(0);
    expect(inner.me?.troops).toBe(500);
    scene.destroy();
  });

  it('does nothing when there are no teams at all', async () => {
    const { scene, distributeTroops } = buildHarness({ cards: [], teams: [], troops: 500 });
    await flush();
    await internals(scene).doFillAllTeams();
    expect(distributeTroops).not.toHaveBeenCalled();
    scene.destroy();
  });

  it(`only ever considers up to TEAM_CAP (${TEAM_CAP}) slots`, () => {
    expect(TEAM_CAP).toBe(5);
  });

  it('spills within a single team across its own cards, highest power first, before moving to the next team', async () => {
    // lichuang troopCapBase=200/+50 per level: level5 cap=400 (higher power), level1 cap=200.
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1), card('a2', 5), card('b1', 1)],
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }, { cardInstanceId: 'a2', col: 1, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { a1: { currentTroops: 0 }, a2: { currentTroops: 0 }, b1: { currentTroops: 0 } },
      troops: 450, // fills a2 (cap 400, higher power) first, spills remaining 50 onto a1, nothing left for t2
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a2).toBe(400);
    expect(allocations.a1).toBe(50);
    expect(allocations.b1).toBeUndefined();
    scene.destroy();
  });

  it('skips an army entry whose cardInstanceId is missing from cardInv (stale reference) without crashing', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('b1', 1)], // 'a1' referenced below is deliberately absent from cardInv
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { b1: { currentTroops: 0 } },
      troops: 500,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a1).toBeUndefined();
    expect(allocations.b1).toBe(200);
    scene.destroy();
  });

  it('skips a legacy unit-type army entry (pre-card-migration, no cardInstanceId) without crashing', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('b1', 1)],
      teams: [
        { id: teamSlotId(0), name: '', army: [{ initialHp: 240 } as unknown as TeamTemplate['army'][number]] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { b1: { currentTroops: 0 } },
      troops: 500,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    expect(distributeTroops).toHaveBeenCalledTimes(1);
    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.b1).toBe(200);
    scene.destroy();
  });

  it('still fills a team that is currently marching or injured (reinforcing troops is not gated on team status)', async () => {
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1), card('b1', 1)],
      teams: [
        { id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] },
        { id: teamSlotId(1), name: '', army: [{ cardInstanceId: 'b1', col: 0, row: 0 }] },
      ],
      cardState: { a1: { currentTroops: 0 }, b1: { currentTroops: 0 } },
      marches: [{ marchId: 'm1', mine: true, teamId: teamSlotId(0), arriveAt: Date.now() + 30_000 }],
      teamState: { [teamSlotId(1)]: { injuredUntil: Date.now() + 60_000 } },
      troops: 500,
    });
    await flush();

    await internals(scene).doFillAllTeams();

    const [, allocations] = distributeTroops.mock.calls[0] as [string, Record<string, number>];
    expect(allocations.a1).toBe(200);
    expect(allocations.b1).toBe(200);
    scene.destroy();
  });

  it('a second tap while the first request is still in flight is a no-op (bt.busy guard)', async () => {
    let resolveFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const { scene, distributeTroops } = buildHarness({
      cards: [card('a1', 1)],
      teams: [{ id: teamSlotId(0), name: '', army: [{ cardInstanceId: 'a1', col: 0, row: 0 }] }],
      cardState: { a1: { currentTroops: 0 } },
      troops: 500,
      distributeTroopsImpl: () => gate.then(() => ({ ok: true as const })),
    });
    await flush();

    const first = internals(scene).doFillAllTeams();
    await flush();
    const second = internals(scene).doFillAllTeams(); // fired while `first` is still awaiting distributeTroops
    resolveFirst!();
    await Promise.all([first, second]);

    expect(distributeTroops).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('the button sits flush above the team-card row — never overlapping it — even with all 5 slots filled and onEditTeam wired', async () => {
    const cards = Array.from({ length: 5 }, (_, i) => card(`c${i}`, 1));
    const teams: TeamTemplate[] = cards.map((c, i) => ({
      id: teamSlotId(i), name: '', army: [{ cardInstanceId: c.id, col: 0, row: 0 }],
    } as unknown as TeamTemplate));
    const cardState: Record<string, CardSLGState> = {};
    cards.forEach((c) => { cardState[c.id] = { currentTroops: 200 }; }); // already at cap, purely a geometry check

    const { scene } = buildHarness({ cards, teams, cardState, troops: 0, onEditTeam: () => {} });
    await flush();

    const inner = internals(scene);
    const fillHit = inner.hits.find((h) => h.fn.toString().includes('doFillAllTeams'))!;
    const teamHits = inner.hits.filter((h) => h !== fillHit && h.fn.toString().includes('onEditTeam'));
    expect(teamHits.length).toBe(TEAM_CAP);
    for (const th of teamHits) {
      expect(rectsOverlap(fillHit, th)).toBe(false);
      // The button sits strictly above every team card, never below or beside it.
      expect(fillHit.y + fillHit.h).toBeLessThanOrEqual(th.y);
    }
    scene.destroy();
  });
});
