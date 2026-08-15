// SeasonShardService branch-coverage gaps (2026-08-15): joinSeason itself (never exercised anywhere —
// only its resolveShardForJoin/resolveSeasonShard sibling has e2e coverage in shard.e2e.test.ts) and the
// WORLD_FULL retry-once-then-succeed path, plus resolveShardForJoin's overflow branch reached through the
// public joinSeason entry point instead. No Mongo: SeasonShardService only touches core.deps.cols and its
// two peer services (TerritoryService/SeasonManagementService), both easily faked here.
import { describe, expect, it, vi } from 'vitest';
import { SlgError, worldShardId } from '@nw/shared';
import { SeasonShardService } from '../src/season/shard';
import type { WorldCore } from '../src/core';
import type { TerritoryService } from '../src/territory';
import type { SeasonManagementService } from '../src/season/management';
import type { PlayerWorldView } from '../src/worldTypes';

const SEASON = 42;
const ACC = 'acc-1';

function build(opts: {
  stickyWorldId?: string | null;
  joinWorldImpl?: (worldId: string) => Promise<PlayerWorldView>;
}) {
  const stickyWorldId = opts.stickyWorldId === undefined ? `s${SEASON}-0` : opts.stickyWorldId;
  const core = {
    deps: {
      cols: {
        playerWorld: {
          findOne: async () => (stickyWorldId ? { worldId: stickyWorldId } : null),
        },
        shardAllocations: {
          findOne: async () => null,
          updateOne: vi.fn(async () => ({})),
        },
        worlds: {
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
          countDocuments: async () => 0,
        },
      },
      now: () => 1_000_000,
    },
  } as unknown as WorldCore;
  const joinWorld = vi.fn(opts.joinWorldImpl ?? (async () => ({ worldId: stickyWorldId }) as unknown as PlayerWorldView));
  const territory = { joinWorld } as unknown as TerritoryService;
  const openSeason = vi.fn(async () => {});
  const management = { openSeason } as unknown as SeasonManagementService;
  const svc = new SeasonShardService(core, territory, management);
  return { svc, joinWorld, openSeason, shardAllocUpdate: core.deps.cols.shardAllocations.updateOne as ReturnType<typeof vi.fn> };
}

describe('SeasonShardService.joinSeason', () => {
  it('happy path: resolves the sticky shard and joins it in one call', async () => {
    const { svc, joinWorld } = build({});
    const result = await svc.joinSeason(SEASON, ACC);
    expect(joinWorld).toHaveBeenCalledTimes(1);
    expect(joinWorld).toHaveBeenCalledWith(`s${SEASON}-0`, ACC);
    expect(result).toEqual({ worldId: `s${SEASON}-0` });
  });

  it('WORLD_FULL on the first attempt → re-resolves the shard and retries once, returning the second result', async () => {
    let call = 0;
    const { svc, joinWorld } = build({
      joinWorldImpl: async (worldId: string) => {
        call++;
        if (call === 1) throw new SlgError('WORLD_FULL', 'race lost');
        return { worldId, retried: true } as unknown as PlayerWorldView;
      },
    });
    const result = await svc.joinSeason(SEASON, ACC);
    expect(joinWorld).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ retried: true });
  });

  it('a non-WORLD_FULL SlgError from joinWorld propagates without retrying', async () => {
    const { svc, joinWorld } = build({
      joinWorldImpl: async () => { throw new SlgError('TILE_OCCUPIED', 'nope'); },
    });
    await expect(svc.joinSeason(SEASON, ACC)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    expect(joinWorld).toHaveBeenCalledTimes(1);
  });

  it('a non-SlgError from joinWorld also propagates without retrying', async () => {
    const { svc, joinWorld } = build({
      joinWorldImpl: async () => { throw new Error('boom'); },
    });
    await expect(svc.joinSeason(SEASON, ACC)).rejects.toThrow('boom');
    expect(joinWorld).toHaveBeenCalledTimes(1);
  });
});

describe('SeasonShardService overflow (via the public joinSeason/resolveSeasonShard entry points)', () => {
  it('no sticky/family/open shard → opens a brand-new overflow shard and increments shardCount', async () => {
    const { svc, openSeason, shardAllocUpdate } = build({ stickyWorldId: null });
    const { worldId } = await svc.resolveSeasonShard(SEASON, ACC);
    expect(worldId).toBe(worldShardId(SEASON, 0));
    expect(openSeason).toHaveBeenCalledWith(worldId, SEASON, 0, expect.any(Number));
    expect(shardAllocUpdate).toHaveBeenCalledWith({ _id: `s${SEASON}` }, { $inc: { shardCount: 1 } });
  });
});
