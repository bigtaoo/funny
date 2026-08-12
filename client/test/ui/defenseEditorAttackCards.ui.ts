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
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import { msCountdown } from '../../src/scenes/DefenseEditorScene/core';
import * as gridModule from '../../src/scenes/DefenseEditorScene/grid';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import { WorldApiError, type WorldApiClient, type TeamTemplate, type CardSLGState, type PlayerWorldView } from '../../src/net/WorldApiClient';
import * as log from '../../src/net/log';
import { BASE_COLS } from '@nw/engine/config';

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
  cardCount?: number; cardState?: Record<string, CardSLGState>; teams?: TeamTemplate[]; teamName?: string;
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

/**
 * Reaches through the outer scene's private `core`/`renderPanel`/`input`/`data` fields (TS privacy
 * is compile-time only) — 2026-08-11: DefenseEditorScene converted from a mixin-chain `extends` to
 * composition (see claudedocs/client-modules.md's split-form priority note), so what used to be
 * flattened directly onto the scene instance now lives on one of these four composed fields.
 * `gridX`/`gridY`/`cellW`/`cellH`/`gRows`/`bodyLayer`/`scrollY`/`tool`/`garrison`/`leaderCardId`/
 * `render`/`availableCards`/`effectiveLeaderId` -> core; `drawArtFit` -> renderPanel; `onGridTap` ->
 * input; `doSave` -> data.
 */
function internals(scene: DefenseEditorScene): {
  core: {
    gridX: number; gridY: number; cellW: number; cellH: number; gRows: readonly number[];
    bodyLayer: PIXI.Container; scrollY: number; tool: unknown;
    garrison: Map<string, { cardInstanceId?: string; hp: number }>;
    leaderCardId: string | null;
    render(): void;
    availableCards(): { card: { id: string }; unitType: string }[];
    effectiveLeaderId(): string | undefined;
  };
  renderPanel: { drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void };
  input: { onGridTap(x: number, y: number): void };
  data: { doSave(): Promise<void> };
} {
  return scene as unknown as ReturnType<typeof internals>;
}

/** Grid geometry is private; read it back post-render (TS privacy is compile-time only). */
function cellCenter(scene: DefenseEditorScene, col: number, dr: number): [number, number] {
  const { core } = internals(scene);
  return [core.gridX + col * core.cellW + core.cellW / 2, core.gridY + dr * core.cellH + core.cellH / 2];
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('DefenseEditorScene attack mode — card-based formation (2026-07-17 migration)', () => {
  it('selecting a roster card then tapping a grid cell places it; save sends {cardInstanceId, col, row} only', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 200 } },
    });
    await flush();

    const { core, input, data } = internals(scene);
    const available = core.availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
    core.tool = { kind: 'card', cardInstanceId: available[0]!.card.id, unitType: available[0]!.unitType };

    const [sx, sy] = cellCenter(scene, 0, 0);
    input.onGridTap(sx, sy);

    await data.doSave();
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

    const { core, input, data } = internals(scene);
    const available = core.availableCards();
    core.tool = { kind: 'card', cardInstanceId: available[0]!.card.id, unitType: available[0]!.unitType };
    const [sx, sy] = cellCenter(scene, 0, 0);
    input.onGridTap(sx, sy);

    await data.doSave();
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
    const garrison = internals(scene).core.garrison;
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
    const available = internals(scene).core.availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
  });

  it('an injured card is excluded from the palette', async () => {
    const { scene } = buildHarness({
      cardCount: 2,
      cardState: { c0: {}, c1: { injuredUntil: Date.now() + 60_000 } } as unknown as Record<string, CardSLGState>,
    });
    await flush();
    const available = internals(scene).core.availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c0']);
  });

  it('the palette is sorted by combat power, strongest first (2026-08-01)', async () => {
    const { scene, save } = buildHarness({ cardCount: 3, cardState: {} });
    // buildSave gives every card the same defId at level 1 — bump levels out of insertion order
    // so a passing test can't be explained by "it just kept cardInv's order".
    save.cardInv!['c0']!.level = 1;
    save.cardInv!['c1']!.level = 9;
    save.cardInv!['c2']!.level = 4;
    await flush();
    const available = internals(scene).core.availableCards();
    expect(available.map((c) => c.card.id)).toEqual(['c1', 'c2', 'c0']);
  });

  it('placing a card that is already on the grid moves it (old cell clears)', async () => {
    const { scene } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 100 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    const { core, input } = internals(scene);
    core.tool = { kind: 'card', cardInstanceId: 'c0', unitType: 'infantry' };
    const [sx, sy] = cellCenter(scene, 1, 0); // move to a different lane, same row
    input.onGridTap(sx, sy);
    const garrison = core.garrison;
    expect(garrison.size).toBe(1);
    expect(garrison.has('0:8')).toBe(false);
    expect(garrison.has('1:8')).toBe(true);
  });

  it('placing more than CARD_TEAM_MAX_SIZE cards is rejected with a toast', async () => {
    const { scene } = buildHarness({ cardCount: 13, cardState: {} });
    await flush();
    const { core, input } = internals(scene);
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    let i = 0;
    for (const row of [0, 1]) {
      for (const col of lanes) {
        if (i >= 12) break;
        core.tool = { kind: 'card', cardInstanceId: `c${i}`, unitType: 'infantry' };
        const [sx, sy] = cellCenter(scene, col, row);
        input.onGridTap(sx, sy);
        i++;
      }
    }
    expect(core.garrison.size).toBe(12);
    core.tool = { kind: 'card', cardInstanceId: 'c12', unitType: 'infantry' };
    const [sx, sy] = cellCenter(scene, lanes[0]!, 2);
    input.onGridTap(sx, sy);
    expect(core.garrison.size).toBe(12); // rejected — cap held
  });
});

// The team leader (2026-07-25) picks which card's portrait represents the team in the city / world-map
// team lists. It is an identity marker on the TeamTemplate, deliberately NOT a fixed "leader cell" on
// the grid — the player can rearrange the formation freely without changing who leads.
describe('DefenseEditorScene attack mode — team leader', () => {
  const teamWithTwo = [
    {
      id: 't1',
      name: 'Team 1',
      army: [
        { cardInstanceId: 'c0', col: 0, row: 8 },
        { cardInstanceId: 'c1', col: 1, row: 8 },
      ],
    },
  ];

  it('tapping a placed card with the leader tool marks it, and save persists leaderCardId', async () => {
    const { scene, setTeams } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    await flush();
    const { core, input, data } = internals(scene);
    core.tool = { kind: 'leader' };
    const [sx, sy] = cellCenter(scene, 1, 0); // the cell holding c1
    input.onGridTap(sx, sy);
    expect(core.leaderCardId).toBe('c1');

    await data.doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBe('c1');
  });

  it('the leader tool does nothing on an empty cell', async () => {
    const { scene } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    await flush();
    const { core, input } = internals(scene);
    core.tool = { kind: 'leader' };
    const [sx, sy] = cellCenter(scene, 4, 3); // empty lane/row
    input.onGridTap(sx, sy);
    expect(core.leaderCardId).toBeNull();
  });

  it('an existing leaderCardId is loaded from the team and round-trips through save', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 2,
      cardState: {},
      teams: [{ ...teamWithTwo[0]!, leaderCardId: 'c0' }],
    });
    await flush();
    const { core, data } = internals(scene);
    expect(core.leaderCardId).toBe('c0');
    await data.doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBe('c0');
  });

  it('a leader erased from the formation is dropped on save (server would clear it anyway)', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 2,
      cardState: {},
      teams: [{ ...teamWithTwo[0]!, leaderCardId: 'c0' }],
    });
    await flush();
    const { core, input, data } = internals(scene);
    core.tool = { kind: 'erase' };
    const [sx, sy] = cellCenter(scene, 0, 0); // the cell holding the leader c0
    input.onGridTap(sx, sy);

    await data.doSave();
    const [, teams] = setTeams.mock.calls[0] as [string, TeamTemplate[]];
    expect(teams.find((tm) => tm.id === 't1')!.leaderCardId).toBeUndefined();
  });

  it('with no explicit pick, the grid stars the strongest card so the automatic icon is visible', async () => {
    const { scene, save } = buildHarness({ cardCount: 2, cardState: {}, teams: teamWithTwo });
    save.cardInv!['c1']!.level = 5; // c1 outranks c0 → it becomes the fallback leader
    await flush();
    expect(internals(scene).core.effectiveLeaderId()).toBe('c1');
  });
});

// The server's setTeams used to injury-check every card across the *full* teams payload (every save
// resends all teams), so saving a brand-new/unrelated team could fail with CARD_INJURED for a card
// that only ever lived on a different, already-fighting team (2026-08-01 fix, worldsvc/city.ts). These
// pin the client's side of that story: a genuinely-injured card on THIS team is named and dropped, and
// — defensively, in case the error ever names a card outside this team's grid — this team's own
// placements are left untouched rather than silently mis-cleared.
describe('DefenseEditorScene attack mode — CARD_INJURED save error (2026-08-01 cross-team fix)', () => {
  it('a genuinely-injured card placed on this team is named with a countdown and dropped from the formation', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 1,
      cardState: { c0: { currentTroops: 100 } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    const untilMs = Date.now() + 4 * 60_000;
    setTeams.mockRejectedValueOnce(new WorldApiError('CARD_INJURED', `Card c0 is injured and cannot be assigned until ${untilMs}`));
    const spy = vi.spyOn(log, 'showToastMessage');

    const { core, data } = internals(scene);
    await data.doSave();

    const garrison = core.garrison;
    expect(garrison.has('0:8')).toBe(false); // this team's own card, genuinely injured — removed

    const expected = t('world.team.cardInjuredRemoved').replace('{name}', t('card.lichuang.name')).replace('{time}', msCountdown(untilMs, Date.now()));
    expect(spy).toHaveBeenCalledWith(expected, 'error');
  });

  it('a CARD_INJURED error naming a card NOT on this team leaves this formation untouched', async () => {
    const { scene, setTeams } = buildHarness({
      cardCount: 2,
      cardState: { c0: { currentTroops: 100 }, c1: { currentTroops: 50, teamId: 't2' } },
      teams: [{ id: 't1', name: 'Team 1', army: [{ cardInstanceId: 'c0', col: 0, row: 8 }] }],
    });
    await flush();
    const untilMs = Date.now() + 60_000;
    // c1 is not part of this team's grid at all (it's on unrelated team t2) — simulates the exact
    // shape of error the pre-fix server could return while editing team t1.
    setTeams.mockRejectedValueOnce(new WorldApiError('CARD_INJURED', `Card c1 is injured and cannot be assigned until ${untilMs}`));
    const spy = vi.spyOn(log, 'showToastMessage');

    const { core, data } = internals(scene);
    await data.doSave();

    const garrison = core.garrison;
    expect(garrison.has('0:8')).toBe(true); // this team's own placement is untouched
    expect(garrison.size).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1); // still surfaces something rather than failing silently
  });
});

// The card roster (right half, attack mode) used to draw straight into bodyLayer with cull-only
// scrolling — a row straddling the top of the list would render in full and paint over the toolbar/
// title above it. Fixed by drawing the roster into a masked sub-layer (2026-08-01, same pattern as
// EquipmentScene/inventory.ts's gridLayer).
describe('DefenseEditorScene attack mode — roster panel scroll clipping (2026-08-01)', () => {
  it('renders the card roster behind a mask so an overscrolled row cannot bleed above the list', async () => {
    const { scene } = buildHarness({ cardCount: 30, cardState: {} });
    await flush();
    const { core } = internals(scene);
    core.scrollY = 40; // partway into the overflowing list — the exact scroll offset the old bug hit
    core.render();
    const masked = core.bodyLayer.children.some((c) => (c as PIXI.Container).mask != null);
    expect(masked).toBe(true);
  });
});

// The base-column band (cols BASE_COLS, never a placeable lane) used to carry only a background tint
// plus a "出兵"/Deploy text label pointing at the home-edge row — players never noticed the label
// (2026-08-02 user report). Replaced with the same castle art PvP battles use (BoardView's
// game_base.png), drawn once at the home-edge row so "near = home, far = front" reads at a glance;
// the text label is gone entirely (defense mode keeps its own "buildRow" label — unaffected).
describe('DefenseEditorScene attack mode — base icon replaces the frontRow label (2026-08-02)', () => {
  it('draws the base icon spanning the base columns at the home-edge row, and drops the old text label', async () => {
    const { scene } = buildHarness({ cardCount: 0, cardState: {} });
    await flush();
    const { core } = internals(scene);
    // drawArtFit is a free function in grid.ts (2026-08-11 composition conversion — see
    // claudedocs/client-modules.md's split-form priority note): renderGrid calls it directly, not
    // through RenderPanel.drawArtFit, so the spy has to sit on the module export itself — grid.ts
    // routes that one call through a self-import (`gridSelf.drawArtFit`) specifically so this
    // module-level spy can see it (a bare in-module call isn't patchable this way). Its signature
    // also gained a leading `core` param vs. the old method, so the destructures below shift by
    // one position.
    const spy = vi.spyOn(gridModule, 'drawArtFit');
    core.render();

    // The base icon is the only drawArtFit call sized to 2 grid columns wide (unit/roster art is
    // always drawn into a single square-ish cell) — find it by that shape rather than by url, since
    // the test harness's binary-asset stub collapses every png import to one identical data: URI.
    const rows = core.gRows.length; // attack mode: no building row, so this is the full row count
    const baseCall = spy.mock.calls.find(([, , , , boxW]) => Math.abs(boxW - core.cellW * 2) < 0.01);
    expect(baseCall).toBeTruthy();
    const [, , px, py, boxW, boxH] = baseCall!;
    expect(px).toBeCloseTo(core.gridX + BASE_COLS[0] * core.cellW);
    expect(py).toBeCloseTo(core.gridY + (rows - 1) * core.cellH);
    expect(boxW).toBeCloseTo(core.cellW * 2);
    expect(boxH).toBeCloseTo(core.cellH);

    const hasOldLabel = core.bodyLayer.children.some((c) => (c as PIXI.Text).text === 'Deploy');
    expect(hasOldLabel).toBe(false);
  });
});

// Regression guard for the same change: the row-label block now only fires for defense mode
// (`if (this.hasBuildingRow)` instead of an unconditional ternary), and the base icon is gated on
// `!this.hasBuildingRow` — both need to hold for defense mode specifically, not just "attack mode
// looks right in isolation."
describe('DefenseEditorScene defense mode — buildRow label + base icon untouched by the attack-mode change (2026-08-02)', () => {
  function buildDefenseHarness() {
    const save = buildSave(0);
    const getDefense = vi.fn().mockResolvedValue(null);
    const setDefense = vi.fn().mockResolvedValue(undefined);
    const worldApi = { getDefense, setDefense } as unknown as WorldApiClient;
    const cb: DefenseEditorCallbacks = {
      onBack: vi.fn(),
      getSave: () => save,
      worldApi,
      worldId: WORLD_ID,
      target: { mode: 'defense', tileKey: 'world:1:0:5:5' },
    };
    const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), cb);
    return { scene };
  }

  it('still renders the "Build" row label at the building row, and never draws the base icon', async () => {
    const { scene } = buildDefenseHarness();
    await flush();
    const { core } = internals(scene);
    // drawArtFit is a free function in grid.ts (2026-08-11 composition conversion — see
    // claudedocs/client-modules.md's split-form priority note) — spy on the module export, not
    // RenderPanel.drawArtFit (see the attack-mode test above for the full reasoning).
    const spy = vi.spyOn(gridModule, 'drawArtFit');
    core.render();

    const hasBuildLabel = core.bodyLayer.children.some((c) => (c as PIXI.Text).text === t('world.defense.buildRow'));
    expect(hasBuildLabel).toBe(true);

    // Same "2 grid columns wide" shape check the attack-mode test uses to spot the base icon —
    // it must never appear here, since hasBuildingRow guards it off in defense mode. `boxW` is at
    // index 4, not 3, since drawArtFit's free-function signature has a leading `core` param.
    const baseCall = spy.mock.calls.find(([, , , , boxW]) => Math.abs(boxW - core.cellW * 2) < 0.01);
    expect(baseCall).toBeUndefined();
  });
});
