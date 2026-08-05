/**
 * defenseEditorDataActions.test.ts — direct coverage of DefenseEditorScene/data.ts's `applyConfig`
 * decode/sanitization and `doSave`'s validation+network body. The 2026-08-05 client-test-audit
 * flagged both as untested: the only existing defense-mode harness (defenseEditorAttackCards.ui.ts)
 * always mocks `getDefense` to resolve `null`, so `applyConfig` is never even invoked by any test,
 * and no test calls `doSave()` in defense mode to inspect `setDefense`'s payload shape or the
 * `saving` busy-lock's re-entrancy.
 *
 * `DataMixin`'s body touches no PixiJS at all (only `this.cb.worldApi.*`, `this.showToast()`,
 * `this.render()`, plain field mutation) — same isolatable-mixin pattern as
 * `client/test/familyLoadDecouple.test.ts` / `client/test/sectActions.test.ts`: mount `DataMixin`
 * on a bare fake base, no PIXI, no headless adapter needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../src/i18n';
import { DataMixin } from '../src/scenes/DefenseEditorScene/data';
import {
  type DefenseEditorSceneBaseCtor, type DefenseEditorTarget, type GarrisonEntry,
  COLLECTED_UNITS, COLLECTED_BUILDINGS, DEFENSE_ROWS, MAX_BASE_LEVEL,
} from '../src/scenes/DefenseEditorScene/base';
import { UNIT_BLUEPRINTS } from '@nw/engine/config';
import { WorldApiError } from '../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const UNIT = COLLECTED_UNITS[0]!;
const BUILDING = COLLECTED_BUILDINGS[0]!;
const LANE = 0; // a real ATTACK_LANES member (see server/engine/src/config.ts)
const ROW = DEFENSE_ROWS[0]!;

function defenseTarget(tileKey = 'tile:5:5'): DefenseEditorTarget {
  return { mode: 'defense', tileKey };
}

function attackTarget(teamId = 'team1'): DefenseEditorTarget {
  return { mode: 'attack', teamId, teamName: 'Squad A' };
}

/** Bare-bones stand-in for DefenseEditorSceneBase — only the fields data.ts's mixin body touches. */
class FakeDefenseEditorSceneBase {
  destroyed = false;
  loading = true;
  saving = false;
  filling = false;
  mode: 'defense' | 'attack' = 'defense';
  gRows: readonly number[] = DEFENSE_ROWS;
  garrison = new Map<string, GarrisonEntry>();
  buildings = new Map<number, string>();
  baseLevel = 0;
  teams: { id: string; name: string; army: unknown[]; autoReturn?: boolean; leaderCardId?: string }[] = [];
  autoReturn = false;
  leaderCardId: string | null = null;
  cardState: Record<string, { currentTroops: number; teamId?: string }> = {};
  troops = 0;
  cb = {
    onBack: vi.fn(),
    worldApi: {
      getTeams: vi.fn(async () => []),
      getMe: vi.fn(async () => ({ cardState: {}, troops: 0 })),
      getDefense: vi.fn(async () => null),
      setDefense: vi.fn(async () => ({ ok: true as const })),
      setTeams: vi.fn(async () => ({ ok: true as const })),
      distributeTroops: vi.fn(async () => ({ ok: true as const })),
    },
    worldId: 'w1',
    target: defenseTarget(),
    getSave: vi.fn(() => ({ cardInv: {}, equipmentInv: {} }) as never),
  };
  showToast = vi.fn();
  render = vi.fn();
  cellForCard = vi.fn((_id: string): string | undefined => undefined);
}

const DefenseEditorWithData = DataMixin(FakeDefenseEditorSceneBase as unknown as DefenseEditorSceneBaseCtor);

function buildScene(overrides: Partial<FakeDefenseEditorSceneBase> = {}): any {
  const scene = new DefenseEditorWithData() as unknown as FakeDefenseEditorSceneBase & Record<string, any>;
  Object.assign(scene, overrides);
  return scene;
}

// ── applyConfig ───────────────────────────────────────────────────────────────

describe('DefenseEditorScene — applyConfig() decode/sanitization', () => {
  it('decodes a valid garrison entry with the unit blueprint HP', () => {
    const scene = buildScene();
    scene.applyConfig({ garrison: [{ unitType: UNIT, col: LANE, row: ROW }] });

    expect(scene.garrison.get(`${LANE}:${ROW}`)).toEqual({ unitType: UNIT, hp: UNIT_BLUEPRINTS[UNIT].hp });
  });

  it('drops a garrison entry with an unknown unitType', () => {
    const scene = buildScene();
    scene.applyConfig({ garrison: [{ unitType: 'totally_bogus_unit', col: LANE, row: ROW }] });
    expect(scene.garrison.size).toBe(0);
  });

  it('drops a garrison entry whose col is not an attack lane', () => {
    const scene = buildScene();
    scene.applyConfig({ garrison: [{ unitType: UNIT, col: 5, row: ROW }] }); // 5 is not in ATTACK_LANES
    expect(scene.garrison.size).toBe(0);
  });

  it('drops a garrison entry whose row is out of range for the current gRows', () => {
    const scene = buildScene();
    scene.applyConfig({ garrison: [{ unitType: UNIT, col: LANE, row: 999 }] });
    expect(scene.garrison.size).toBe(0);
  });

  it('drops a non-object / malformed entry instead of throwing', () => {
    const scene = buildScene();
    expect(() => scene.applyConfig({ garrison: [null, 'junk', 42] })).not.toThrow();
    expect(scene.garrison.size).toBe(0);
  });

  it('decodes a valid building entry', () => {
    const scene = buildScene();
    scene.applyConfig({ defenderBuildings: [{ buildingType: BUILDING, col: LANE }] });
    expect(scene.buildings.get(LANE)).toBe(BUILDING);
  });

  it('drops a building entry with an unknown buildingType or non-lane col', () => {
    const scene = buildScene();
    scene.applyConfig({ defenderBuildings: [{ buildingType: 'not_a_building', col: LANE }, { buildingType: BUILDING, col: 5 }] });
    expect(scene.buildings.size).toBe(0);
  });

  it('clamps defenderBaseLevel into [0, MAX_BASE_LEVEL] and floors fractional values', () => {
    const scene = buildScene();
    scene.applyConfig({ defenderBaseLevel: -3 });
    expect(scene.baseLevel).toBe(0);

    scene.applyConfig({ defenderBaseLevel: MAX_BASE_LEVEL + 50 });
    expect(scene.baseLevel).toBe(MAX_BASE_LEVEL);

    scene.applyConfig({ defenderBaseLevel: 2.9 });
    expect(scene.baseLevel).toBe(2);
  });

  it('defaults defenderBaseLevel to 0 when missing or not a number', () => {
    const scene = buildScene({ baseLevel: 5 });
    scene.applyConfig({ defenderBaseLevel: 'three' });
    expect(scene.baseLevel).toBe(0);
  });

  it('clears any previously-decoded garrison/buildings before applying the new config', () => {
    const scene = buildScene();
    scene.applyConfig({ garrison: [{ unitType: UNIT, col: LANE, row: ROW }], defenderBuildings: [{ buildingType: BUILDING, col: LANE }] });
    expect(scene.garrison.size).toBe(1);
    expect(scene.buildings.size).toBe(1);

    scene.applyConfig({}); // empty config
    expect(scene.garrison.size).toBe(0);
    expect(scene.buildings.size).toBe(0);
  });
});

// ── doSave — defense mode ─────────────────────────────────────────────────────

describe('DefenseEditorScene — doSave() defense mode', () => {
  it('builds the config payload from garrison+buildings+baseLevel and PUTs setDefense', async () => {
    const scene = buildScene({ baseLevel: 3 });
    scene.garrison.set(`${LANE}:${ROW}`, { unitType: UNIT, hp: 60 });
    scene.buildings.set(LANE, BUILDING);

    await scene.doSave();

    expect(scene.cb.worldApi.setDefense).toHaveBeenCalledWith('w1', 'tile:5:5', {
      garrison: [{ unitType: UNIT, col: LANE, row: ROW }],
      defenderBuildings: [{ buildingType: BUILDING, col: LANE }],
      defenderBaseLevel: 3,
    });
  });

  it('on success: toasts saved, navigates back, and does NOT render (onBack tears the scene down)', async () => {
    const scene = buildScene();

    await scene.doSave();

    expect(scene.showToast).toHaveBeenCalledWith(t('world.defense.saved'));
    expect(scene.cb.onBack).toHaveBeenCalledTimes(1);
    expect(scene.saving).toBe(false);
    expect(scene.render).not.toHaveBeenCalled();
  });

  it('a save happily persists an empty formation — doSave performs no minimum-troop/budget validation of its own', async () => {
    const scene = buildScene(); // garrison/buildings both empty

    await scene.doSave();

    expect(scene.cb.worldApi.setDefense).toHaveBeenCalledWith('w1', 'tile:5:5', {
      garrison: [], defenderBuildings: [], defenderBaseLevel: 0,
    });
    expect(scene.cb.onBack).toHaveBeenCalledTimes(1); // still succeeds — confirms the audit's premise
  });

  it('busy-lock: a second call while the first is in flight does not re-issue the save', async () => {
    const scene = buildScene();
    scene.cb.worldApi.setDefense.mockReturnValueOnce(new Promise(() => {})); // never resolves

    void scene.doSave();
    void scene.doSave();
    await Promise.resolve();

    expect(scene.cb.worldApi.setDefense).toHaveBeenCalledTimes(1);
    expect(scene.saving).toBe(true);
  });

  it('on TILE_NOT_OWNED failure: toasts the mapped message, unlocks, renders, and does not navigate back', async () => {
    const scene = buildScene();
    scene.cb.worldApi.setDefense.mockRejectedValueOnce(new WorldApiError('TILE_NOT_OWNED', 'raw'));

    await scene.doSave();

    expect(scene.saving).toBe(false);
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.cb.onBack).not.toHaveBeenCalled();
    // errorMsg() maps TILE_NOT_OWNED to a real i18n string, not the raw server message.
    const msg = scene.showToast.mock.calls[0]![0];
    expect(msg).not.toBe('raw');
  });

  it('on CARD_INJURED failure: drops the offending card from the garrison via cellForCard', async () => {
    const scene = buildScene();
    const untilMs = Date.now() + 60_000;
    scene.cellForCard.mockReturnValueOnce(`${LANE}:${ROW}`);
    scene.garrison.set(`${LANE}:${ROW}`, { unitType: UNIT, hp: 60, cardInstanceId: 'card_x' });
    scene.cb.worldApi.setDefense.mockRejectedValueOnce(
      new WorldApiError('CARD_INJURED', `Card card_x is injured and cannot be assigned until ${untilMs}`),
    );

    await scene.doSave();

    expect(scene.garrison.has(`${LANE}:${ROW}`)).toBe(false);
    expect(scene.render).toHaveBeenCalledTimes(1);
  });

  it('a plain thrown error falls back to the generic save-failed toast', async () => {
    const scene = buildScene();
    scene.cb.worldApi.setDefense.mockRejectedValueOnce(new Error('boom'));

    await scene.doSave();

    expect(scene.showToast).toHaveBeenCalledWith(t('world.defense.saveFail'), expect.anything());
  });
});

// ── doSave — attack mode (delegates to persistTeam) ──────────────────────────

describe('DefenseEditorScene — doSave() attack mode delegates to persistTeam/setTeams', () => {
  it('persists the team slot via setTeams and navigates back on success', async () => {
    const scene = buildScene({ mode: 'attack', cb: { ...new FakeDefenseEditorSceneBase().cb, target: attackTarget('team1') } });
    scene.garrison.set(`${LANE}:1`, { unitType: UNIT, hp: 60, cardInstanceId: 'card_x' });

    await scene.doSave();

    expect(scene.cb.worldApi.setTeams).toHaveBeenCalledWith('w1', [
      { id: 'team1', name: '', army: [{ cardInstanceId: 'card_x', col: LANE, row: 1 }], autoReturn: false, leaderCardId: undefined },
    ]);
    expect(scene.cb.onBack).toHaveBeenCalledTimes(1);
  });
});
