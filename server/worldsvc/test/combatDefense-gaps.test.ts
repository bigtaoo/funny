// DefenseService branch-coverage gaps: setDefense/getDefense's tile-key path (only the 'base' path is
// exercised via httpApi.e2e.test.ts) and getSiegeReplay's not-replayable / no-defender / meta-unavailable
// branches. No Mongo: DefenseService only touches core.deps.cols.{playerWorld,tiles,sieges}, core.meta,
// and core.sameFamily, so a hand-built WorldCore over fakes covers it (mirrors get-teams-card-lookup.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { SlgError } from '@nw/shared';
import { DefenseService } from '../src/combatDefense';
import type { WorldCore } from '../src/core';

const W = 's1';
const ACC = 'acc-1';

function build(opts: {
  pw?: { _id: string; defense?: unknown } | null;
  tile?: { ownerId?: string; defense?: unknown } | null;
  siege?: Record<string, unknown> | null;
  sameFamily?: boolean;
  metaAvailable?: boolean;
  getProfile?: (id: string) => Promise<{ displayName?: string } | null>;
}) {
  const pwUpdateOne = vi.fn(async () => ({}));
  const tileUpdateOne = vi.fn(async () => ({}));
  const sameFamily = vi.fn(async () => opts.sameFamily ?? false);
  const getProfile = opts.getProfile ?? (async (id: string) => ({ displayName: `name-${id}` }));
  const core = {
    deps: {
      cols: {
        playerWorld: {
          findOne: async () => opts.pw ?? null,
          updateOne: pwUpdateOne,
        },
        tiles: {
          findOne: async () => opts.tile ?? null,
          updateOne: tileUpdateOne,
        },
        sieges: {
          findOne: async () => opts.siege ?? null,
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [],
              }),
            }),
          }),
        },
      },
    },
    sameFamily,
    meta: { available: opts.metaAvailable ?? true, getProfile },
  } as unknown as WorldCore;
  return { svc: new DefenseService(core), pwUpdateOne, tileUpdateOne, sameFamily, getProfile };
}

describe('DefenseService.setDefense — tile-key path', () => {
  it('rejects an invalid defense formation (validateDefenseConfig throws) before touching Mongo', async () => {
    const { svc, pwUpdateOne, tileUpdateOne } = build({});
    await expect(svc.setDefense(W, ACC, 'base', [] as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect(tileUpdateOne).not.toHaveBeenCalled();
  });

  it("'base': throws TILE_NOT_OWNED when the player hasn't joined the world", async () => {
    const { svc } = build({ pw: null });
    await expect(svc.setDefense(W, ACC, 'base', {})).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('non-base tileKey: throws TILE_NOT_OWNED when the tile does not exist', async () => {
    const { svc, tileUpdateOne } = build({ tile: null });
    await expect(svc.setDefense(W, ACC, 't:1:1', {})).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    expect(tileUpdateOne).not.toHaveBeenCalled();
  });

  it('non-base tileKey: throws TILE_NOT_OWNED when the tile has no owner', async () => {
    const { svc } = build({ tile: { ownerId: undefined } });
    await expect(svc.setDefense(W, ACC, 't:1:1', {})).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('non-base tileKey: throws when the tile belongs to someone else and is not same-family', async () => {
    const { svc, sameFamily, tileUpdateOne } = build({ tile: { ownerId: 'other' }, sameFamily: false });
    await expect(svc.setDefense(W, ACC, 't:1:1', {})).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
    expect(sameFamily).toHaveBeenCalledWith(W, ACC, 'other');
    expect(tileUpdateOne).not.toHaveBeenCalled();
  });

  it('non-base tileKey: allows a same-family ally to set proxy defense on the tile', async () => {
    const { svc, tileUpdateOne } = build({ tile: { ownerId: 'other' }, sameFamily: true });
    await svc.setDefense(W, ACC, 't:1:1', { formation: 'x' });
    expect(tileUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("non-base tileKey: the tile's own owner can set its defense directly (no family lookup needed)", async () => {
    const { svc, tileUpdateOne, sameFamily } = build({ tile: { ownerId: ACC } });
    await svc.setDefense(W, ACC, 't:1:1', { formation: 'x' });
    expect(tileUpdateOne).toHaveBeenCalledTimes(1);
    // ownerId === accountId short-circuits before the sameFamily lookup.
    expect(sameFamily).not.toHaveBeenCalled();
  });
});

describe('DefenseService.getDefense', () => {
  it("'base': throws TILE_NOT_OWNED when the player hasn't joined the world", async () => {
    const { svc } = build({ pw: null });
    await expect(svc.getDefense(W, ACC, 'base')).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it("'base': returns null when no defense has been configured yet", async () => {
    const { svc } = build({ pw: { _id: 'x' } });
    await expect(svc.getDefense(W, ACC, 'base')).resolves.toBeNull();
  });

  it("'base': returns the stored defense config", async () => {
    const { svc } = build({ pw: { _id: 'x', defense: { formation: 'y' } } });
    await expect(svc.getDefense(W, ACC, 'base')).resolves.toEqual({ formation: 'y' });
  });

  it('non-base tileKey: throws TILE_NOT_OWNED when the tile does not exist', async () => {
    const { svc } = build({ tile: null });
    await expect(svc.getDefense(W, ACC, 't:1:1')).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('non-base tileKey: throws TILE_NOT_OWNED when the tile belongs to someone else', async () => {
    const { svc } = build({ tile: { ownerId: 'other' } });
    await expect(svc.getDefense(W, ACC, 't:1:1')).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('non-base tileKey: returns null when the owned tile has no defense configured', async () => {
    const { svc } = build({ tile: { ownerId: ACC } });
    await expect(svc.getDefense(W, ACC, 't:1:1')).resolves.toBeNull();
  });

  it('non-base tileKey: returns the stored defense config for the owned tile', async () => {
    const { svc } = build({ tile: { ownerId: ACC, defense: { formation: 'z' } } });
    await expect(svc.getDefense(W, ACC, 't:1:1')).resolves.toEqual({ formation: 'z' });
  });
});

describe('DefenseService.getSiegeReplay', () => {
  it('throws NOT_FOUND when the siege report does not exist', async () => {
    const { svc } = build({ siege: null });
    await expect(svc.getSiegeReplay(W, ACC, 'sid1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NO_PERMISSION when the requester is neither attacker nor defender', async () => {
    const { svc } = build({ siege: { attackerId: 'x', defenderId: 'y', seed: 1, attackerArmy: [] } });
    await expect(svc.getSiegeReplay(W, ACC, 'sid1')).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('throws NOT_FOUND ("no replayable record") when seed is missing', async () => {
    const { svc } = build({ siege: { attackerId: ACC, defenderId: 'y', attackerArmy: [] } });
    await expect(svc.getSiegeReplay(W, ACC, 'sid1')).rejects.toThrow(/no replayable record/);
  });

  it('throws NOT_FOUND ("no replayable record") when attackerArmy is not an array', async () => {
    const { svc } = build({ siege: { attackerId: ACC, defenderId: 'y', seed: 1, attackerArmy: null } });
    await expect(svc.getSiegeReplay(W, ACC, 'sid1')).rejects.toThrow(/no replayable record/);
  });

  it('resolves both display names, and includes cardInstances/equipmentInv/siegeAcademy when present', async () => {
    const { svc } = build({
      siege: {
        attackerId: ACC,
        defenderId: 'def-1',
        seed: 7,
        outcome: 'attacker_win',
        attackerArmy: [],
        defenderConfig: null,
        tileLevel: 1,
        cardInstances: [{ id: 'c1' }],
        equipmentInv: { c1: {} },
        siegeAcademy: { hp: 1, damage: 2, siege: 3 },
      },
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.attackerName).toBe('name-acc-1');
    expect(r.defenderName).toBe('name-def-1');
    expect(r.cardInstances).toEqual([{ id: 'c1' }]);
    expect(r.equipmentInv).toEqual({ c1: {} });
    expect(r.siegeAcademy).toEqual({ hp: 1, damage: 2, siege: 3 });
  });

  it('omits cardInstances/equipmentInv/siegeAcademy when absent from the stored report', async () => {
    const { svc } = build({
      siege: { attackerId: ACC, defenderId: 'def-1', seed: 7, outcome: 'attacker_win', attackerArmy: [] },
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.cardInstances).toBeUndefined();
    expect(r.equipmentInv).toBeUndefined();
    expect(r.siegeAcademy).toBeUndefined();
  });

  it('defenderName is empty when the report has no defenderId (PvE target)', async () => {
    const { svc } = build({
      siege: { attackerId: ACC, defenderId: undefined, seed: 7, outcome: 'attacker_win', attackerArmy: [] },
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.defenderName).toBe('');
  });

  it('resolveDisplayName returns "" when meta is unavailable', async () => {
    const { svc } = build({
      siege: { attackerId: ACC, defenderId: 'def-1', seed: 7, outcome: 'attacker_win', attackerArmy: [] },
      metaAvailable: false,
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.attackerName).toBe('');
    expect(r.defenderName).toBe('');
  });

  it('resolveDisplayName returns "" when the meta lookup rejects', async () => {
    const { svc } = build({
      siege: { attackerId: ACC, defenderId: 'def-1', seed: 7, outcome: 'attacker_win', attackerArmy: [] },
      getProfile: async () => { throw new Error('meta down'); },
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.attackerName).toBe('');
    expect(r.defenderName).toBe('');
  });

  it('resolveDisplayName returns "" when the profile has no displayName', async () => {
    const { svc } = build({
      siege: { attackerId: ACC, defenderId: 'def-1', seed: 7, outcome: 'attacker_win', attackerArmy: [] },
      getProfile: async () => ({}),
    });
    const r = await svc.getSiegeReplay(W, ACC, 'sid1');
    expect(r.attackerName).toBe('');
  });
});

describe('DefenseService.listSieges', () => {
  it('clamps limit to [1, SIEGE_LIST_MAX] and passes it to the query', async () => {
    const limitSpy = vi.fn(() => ({ toArray: async () => [] }));
    const core = {
      deps: {
        cols: {
          sieges: {
            find: () => ({ sort: () => ({ limit: limitSpy }) }),
          },
        },
      },
    } as unknown as WorldCore;
    const svc = new DefenseService(core);
    await svc.listSieges(W, ACC, 99999);
    expect(limitSpy).toHaveBeenCalledWith(100);
    await svc.listSieges(W, ACC, -5);
    expect(limitSpy).toHaveBeenCalledWith(1);
    await svc.listSieges(W, ACC, 0);
    expect(limitSpy).toHaveBeenCalledWith(100); // Math.floor(0)||SIEGE_LIST_MAX falls back
  });

  it('maps rows: role attacker/defender, tileLevel presence, and hasReplay true/false', async () => {
    const rows = [
      { _id: 's1', tile: 't1', tileLevel: 3, outcome: 'attacker_win', attackerId: ACC, defenderId: 'd1', ts: 10, seed: 1, attackerArmy: [{}] },
      { _id: 's2', tile: 't2', outcome: 'defender_win', attackerId: 'a2', defenderId: ACC, ts: 20 },
      { _id: 's3', tile: 't3', outcome: 'attacker_win', attackerId: ACC, defenderId: 'd3', ts: 30, seed: 2, attackerArmy: [] },
    ];
    const core = {
      deps: {
        cols: {
          sieges: {
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => rows }) }) }),
          },
        },
      },
    } as unknown as WorldCore;
    const svc = new DefenseService(core);
    const out = await svc.listSieges(W, ACC);
    expect(out[0]).toMatchObject({ siegeId: 's1', role: 'attacker', tileLevel: 3, hasReplay: true });
    expect(out[1]).toMatchObject({ siegeId: 's2', role: 'defender', hasReplay: false });
    expect((out[1] as unknown as Record<string, unknown>).tileLevel).toBeUndefined();
    // seed+array present but empty attackerArmy → hasReplay false (no instant-occupy replay).
    expect(out[2]).toMatchObject({ siegeId: 's3', hasReplay: false });
  });
});
