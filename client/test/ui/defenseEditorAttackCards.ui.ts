// Coverage for the attack-team formation editor's migration from raw unit types to hero cards
// (2026-07-17). Before this, DefenseEditorScene's attack mode built ArmyEntry as {unitType, initialHp}
// with no cardInstanceId — so combatMarch.ts's card-army exemption from the flat troop pool never
// applied to teams built through the only editor players actually use, and occupying with a team that
// visibly "had troops" still failed with NO_TROOPS ("insufficient troops"). See
// slg-occupy-team-only-troops memory + DefenseEditorScene.ts's header comment for the full story.
//
// These test the actual placement/save behavior headlessly (PIXI headless adapter, no screenshot):
// palette availability rules, tap-to-place, move-on-replace, the CARD_TEAM_MAX_SIZE cap, and the
// ArmyEntry shape sent to setTeams.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
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

function buildSave(cardCount: number): SaveData {
  const save = makeNewSave('acc_test');
  for (let i = 0; i < cardCount; i++) {
    save.cardInv![`c${i}`] = { id: `c${i}`, defId: 'lichuang', level: 1, gear: {}, locked: false };
  }
  return save;
}

function buildHarness(opts: {
  cardCount?: number;
  cardState?: Record<string, CardSLGState>;
  teams?: TeamTemplate[];
  teamName?: string;
} = {}) {
  const save = buildSave(opts.cardCount ?? 3);
  const setTeams = vi.fn().mockResolvedValue(undefined);
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? [{ id: 't1', name: 'Team 1', army: [] }]);
  const getMe = vi.fn().mockResolvedValue({ cardState: opts.cardState ?? {} } as PlayerWorldView);
  const worldApi = { getTeams, setTeams, getMe } as unknown as WorldApiClient;

  const cb: DefenseEditorCallbacks = {
    onBack: vi.fn(),
    getSave: () => save,
    worldApi,
    worldId: WORLD_ID,
    target: { mode: 'attack', teamId: 't1', teamName: opts.teamName ?? 'Team 1' },
  };
  const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), cb);
  return { scene, cb, save, setTeams, getTeams, getMe };
}

/** Grid geometry is private; read it back post-render (TS privacy is compile-time only). */
function cellCenter(scene: DefenseEditorScene, col: number, dr: number): [number, number] {
  const s = scene as unknown as { gridX: number; gridY: number; cellW: number; cellH: number };
  return [s.gridX + col * s.cellW + s.cellW / 2, s.gridY + dr * s.cellH + s.cellH / 2];
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('DefenseEditorScene attack mode — card-based formation (2026-07-17 migration)', () => {
  it('selecting a roster card then tapping a grid cell places it; save sends {cardInstanceId, col, row} only', async () => {
    const { scene, setTeams } = buildHarness({ cardCount: 1, cardState: { c0: { currentTroops: 200 } } });
    await flush();

    const available = (scene as unknown as { availableCards(): { card: { id: string }; unitType: string }[] }).availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
    (scene as unknown as { tool: unknown }).tool = { kind: 'card', cardInstanceId: available[0]!.card.id, unitType: available[0]!.unitType };

    const [sx, sy] = cellCenter(scene, 0, 0);
    (scene as unknown as { onGridTap(x: number, y: number): void }).onGridTap(sx, sy);

    await (scene as unknown as { doSave(): Promise<void> }).doSave();
    expect(setTeams).toHaveBeenCalledTimes(1);
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    const saved = teams.find((tm) => tm.id === 't1')!;
    expect(saved.army).toHaveLength(1);
    expect(saved.army[0]).toMatchObject({ cardInstanceId: 'c0' });
    expect(saved.army[0]).not.toHaveProperty('initialHp');
    expect(saved.army[0]).not.toHaveProperty('unitType');
  });

  it('save does not freeze the editor-header teamName into TeamTemplate.name (2026-08-01 locale-freeze fix)', async () => {
    // cb.target.teamName is only ever a locale snapshot of teamSlotName(i) taken when the editor
    // opened (CityScene/render.ts) — persisting it verbatim is what caused slots saved under
    // different UI languages to permanently disagree ("Team 1" vs "队伍 3" in the same save).
    const { scene, setTeams } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 200 } },
      teamName: '队伍 1',
    });
    await flush();

    const available = (scene as unknown as { availableCards(): { card: { id: string }; unitType: string }[] }).availableCards();
    (scene as unknown as { tool: unknown }).tool = { kind: 'card', cardInstanceId: available[0]!.card.id, unitType: available[0]!.unitType };
    const [sx, sy] = cellCenter(scene, 0, 0);
    (scene as unknown as { onGridTap(x: number, y: number): void }).onGridTap(sx, sy);

    await (scene as unknown as { doSave(): Promise<void> }).doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    const saved = teams.find((tm) => tm.id === 't1')!;
    expect(saved.name).toBe('');
  });

  it('loading an existing card team populates the grid from cardState.currentTroops', async () => {
    const { scene } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 350 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    const garrison = (scene as unknown as { garrison: Map<string, { cardInstanceId?: string; hp: number }> }).garrison;
    expect(garrison.size).toBe(1);
    const entry = garrison.get('0:8')!;
    expect(entry.cardInstanceId).toBe('c0');
    expect(entry.hp).toBe(350);
  });

  it('a card already committed to a different team is excluded from the palette', async () => {
    const { scene } = buildHarness({
      cardCount: 2,
      cardState: { c0: {}, c1: { teamId: 't2' } } as unknown as Record<string, CardSLGState>,
    });
    await flush();
    const available = (scene as unknown as { availableCards(): { card: { id: string } }[] }).availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
  });

  it('an injured card is excluded from the palette', async () => {
    const { scene } = buildHarness({
      cardCount: 2,
      cardState: { c0: {}, c1: { injuredUntil: Date.now() + 60_000 } } as unknown as Record<string, CardSLGState>,
    });
    await flush();
    const available = (scene as unknown as { availableCards(): { card: { id: string } }[] }).availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
  });

  it('placing a card that is already on the grid moves it (old cell clears)', async () => {
    const { scene } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 100 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    (scene as unknown as { tool: unknown }).tool = { kind: 'card', cardInstanceId: 'c0', unitType: 'infantry' };
    const [sx, sy] = cellCenter(scene, 1, 0); // move to a different lane, same row
    (scene as unknown as { onGridTap(x: number, y: number): void }).onGridTap(sx, sy);
    const garrison = (scene as unknown as { garrison: Map<string, unknown> }).garrison;
    expect(garrison.size).toBe(1);
    expect(garrison.has('0:8')).toBe(false);
    expect(garrison.has('1:8')).toBe(true);
  });

  it('placing more than CARD_TEAM_MAX_SIZE cards is rejected with a toast', async () => {
    const { scene } = buildHarness({ cardCount: 13, cardState: {} });
    await flush();
    const s = scene as unknown as {
      tool: unknown;
      onGridTap(x: number, y: number): void;
      garrison: Map<string, unknown>;
    };
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    let i = 0;
    for (const row of [0, 1]) {
      for (const col of lanes) {
        if (i >= 12) break;
        s.tool = { kind: 'card', cardInstanceId: `c${i}`, unitType: 'infantry' };
        const [sx, sy] = cellCenter(scene, col, row);
        s.onGridTap(sx, sy);
        i++;
      }
    }
    expect(s.garrison.size).toBe(12);
    s.tool = { kind: 'card', cardInstanceId: 'c12', unitType: 'infantry' };
    const [sx, sy] = cellCenter(scene, lanes[0]!, 2);
    s.onGridTap(sx, sy);
    expect(s.garrison.size).toBe(12); // rejected — cap held
  });
});

// The team leader (2026-07-25) picks which card's portrait represents the team in the city / world-map
// team lists. It is an identity marker on the TeamTemplate, deliberately NOT a fixed "leader cell" on
// the grid — the player can rearrange the formation freely without changing who leads.
describe('DefenseEditorScene attack mode — team leader', () => {
  const teamWithTwo = [{
    id: 't1', name: 'Team 1',
    army: [{ cardInstanceId: 'c0', col: 0, row: 8 }, { cardInstanceId: 'c1', col: 1, row: 8 }],
  }];

  it('tapping a placed card with the leader tool marks it, and save persists leaderCardId', async () => {
    const { scene, setTeams } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    await flush();
    const s = scene as unknown as { tool: unknown; onGridTap(x: number, y: number): void; leaderCardId: string | null };
    s.tool = { kind: 'leader' };
    const [sx, sy] = cellCenter(scene, 1, 0); // the cell holding c1
    s.onGridTap(sx, sy);
    expect(s.leaderCardId).toBe('c1');

    await (scene as unknown as { doSave(): Promise<void> }).doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBe('c1');
  });

  it('the leader tool does nothing on an empty cell', async () => {
    const { scene } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    await flush();
    const s = scene as unknown as { tool: unknown; onGridTap(x: number, y: number): void; leaderCardId: string | null };
    s.tool = { kind: 'leader' };
    const [sx, sy] = cellCenter(scene, 4, 3); // empty lane/row
    s.onGridTap(sx, sy);
    expect(s.leaderCardId).toBeNull();
  });

  it('an existing leaderCardId is loaded from the team and round-trips through save', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 2, cardState: {},
      teams: [{ ...teamWithTwo[0]!, leaderCardId: 'c0' }],
    });
    await flush();
    expect((scene as unknown as { leaderCardId: string | null }).leaderCardId).toBe('c0');
    await (scene as unknown as { doSave(): Promise<void> }).doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBe('c0');
  });

  it('a leader erased from the formation is dropped on save (server would clear it anyway)', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 2, cardState: {},
      teams: [{ ...teamWithTwo[0]!, leaderCardId: 'c0' }],
    });
    await flush();
    const s = scene as unknown as { tool: unknown; onGridTap(x: number, y: number): void };
    s.tool = { kind: 'erase' };
    const [sx, sy] = cellCenter(scene, 0, 0); // the cell holding the leader c0
    s.onGridTap(sx, sy);

    await (scene as unknown as { doSave(): Promise<void> }).doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBeUndefined();
  });

  it('with no explicit pick, the grid stars the strongest card so the automatic icon is visible', async () => {
    const { scene, save } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    save.cardInv!['c1']!.level = 5; // c1 outranks c0 → it becomes the fallback leader
    await flush();
    expect((scene as unknown as { effectiveLeaderId(): string | undefined }).effectiveLeaderId()).toBe('c1');
  });
});
