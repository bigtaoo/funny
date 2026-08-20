// src/logic/slgSeason.ts — the SLG world lifecycle state machine and its confirm prompts.
//
// `worldActions` is the load-bearing part: it decides which irreversible buttons a world offers.
// Getting it wrong in either direction is bad — offering Reset on a running world invites data loss,
// hiding Close on a settling one leaves shards stuck — so both directions are pinned per status.
import { describe, expect, it } from 'vitest';
import {
  allocateConfirm, allocateOkText, mergeConfirm, mergeOkText, mergePrompt, openConfirm,
  populationText, seasonShardText, worldActions, worldStatusCls,
} from '../src/logic/slgSeason';
import type { SlgWorldSummary } from '../src/types';

const world = (over: Partial<SlgWorldSummary> = {}): SlgWorldSummary => ({
  worldId: 's1-0', season: 1, shard: 0, status: 'open', population: 1234, capacity: 10000, openAt: 0, ...over,
});

const ids = (w: SlgWorldSummary, canManage = true): string[] => worldActions(w, canManage).map((a) => a.id);

describe('worldStatusCls', () => {
  it('colours the four known statuses', () => {
    expect(worldStatusCls('open')).toBe('ok');
    expect(worldStatusCls('settling')).toBe('warn');
    expect(worldStatusCls('resetting')).toBe('warn');
    expect(worldStatusCls('closed')).toBe('');
  });

  it('falls back to the neutral pill for an unrecognised status rather than rendering unstyled', () => {
    expect(worldStatusCls('draining')).toBe('info');
  });
});

describe('worldActions', () => {
  it('offers nothing without slg.season.manage, whatever the status', () => {
    for (const status of ['open', 'active', 'settling', 'resetting', 'closed']) {
      expect(ids(world({ status }), false)).toEqual([]);
    }
  });

  it('offers settle / close / merge on a running world', () => {
    expect(ids(world({ status: 'open' }))).toEqual(['settle', 'close', 'merge']);
  });

  it('treats "active" as running too — worldsvc has used both spellings', () => {
    expect(ids(world({ status: 'active' }))).toEqual(['settle', 'close', 'merge']);
  });

  it('offers reset / close once settling or resetting, and NOT settle again', () => {
    for (const status of ['settling', 'resetting']) {
      expect(ids(world({ status }))).toEqual(['reset', 'close']);
    }
  });

  it('never offers reset on a running world — that is the data-loss direction', () => {
    expect(ids(world({ status: 'open' }))).not.toContain('reset');
  });

  it('offers nothing on a closed or unknown-status world — there is no transition out of closed', () => {
    expect(ids(world({ status: 'closed' }))).toEqual([]);
    expect(ids(world({ status: 'draining' }))).toEqual([]);
  });

  it('gives every action except merge a confirm prompt naming the world', () => {
    for (const status of ['open', 'settling']) {
      for (const a of worldActions(world({ status, worldId: 's2-3' }), true)) {
        if (a.id === 'merge') expect(a.confirmText).toBeNull();
        else expect(a.confirmText).toContain('s2-3');
      }
    }
  });

  it('marks the irreversible actions as such in their prompt', () => {
    const reset = worldActions(world({ status: 'settling' }), true).find((a) => a.id === 'reset')!;
    expect(reset.cls).toBe('danger');
    expect(reset.confirmText).toContain('Irreversible');
    const close = worldActions(world({ status: 'open' }), true).find((a) => a.id === 'close')!;
    expect(close.confirmText).toContain('permanently closes it');
  });

  it('uses one definition of the Close prompt in both branches', () => {
    const fromOpen = worldActions(world({ status: 'open' }), true).find((a) => a.id === 'close')!;
    const fromSettling = worldActions(world({ status: 'settling' }), true).find((a) => a.id === 'close')!;
    expect(fromOpen).toEqual(fromSettling);
  });
});

describe('row text', () => {
  it('reads season and shard together', () => {
    expect(seasonShardText({ season: 3, shard: 2 })).toBe('S3 · shard 2');
  });

  it('groups the population digits against the capacity', () => {
    expect(populationText({ population: 1234, capacity: 10000 })).toBe(
      `${(1234).toLocaleString()} / ${(10000).toLocaleString()}`,
    );
  });
});

describe('allocate next season', () => {
  it('warns that every account gets routed to a new map', () => {
    const text = allocateConfirm(2, '10000');
    expect(text).toContain('Allocate season 2');
    expect(text).toContain('capacity 10000 per shard');
    expect(text).toContain('every account will be routed to the new map');
  });

  it('reports the shards it opened and how many families were placed', () => {
    expect(allocateOkText(2, { shardCount: 2, worldIds: ['s2-0', 's2-1'], allocatedFamilies: 37 }))
      .toBe('Season 2 allocated: 2 shard(s) — s2-0, s2-1 (37 families placed)');
  });
});

describe('open a single world', () => {
  it('repeats every parameter back before opening', () => {
    expect(openConfirm('s1-4', '1', '4', '5000')).toBe('Open world "s1-4" season 1 shard 4 cap 5000?');
  });
});

describe('shard merge', () => {
  it('suggests a plausible target shard for the world’s own season', () => {
    expect(mergePrompt({ worldId: 's3-2', season: 3 })).toBe('Merge "s3-2" into which shard? (worldId, e.g. s3-0)');
  });

  it('spells out both the move and the permanent close', () => {
    const text = mergeConfirm('s3-2', 's3-0');
    expect(text).toContain('out of "s3-2" into "s3-0"');
    expect(text).toContain('permanently close "s3-2"');
    expect(text).toContain('Irreversible');
  });

  it('reports the moved count, and the failures when there are any', () => {
    expect(mergeOkText({ moved: 12, failed: [] })).toBe('Moved 12 player(s)');
    expect(mergeOkText({ moved: 12, failed: ['acc-1', 'acc-2'] }))
      .toBe('Moved 12 player(s), 2 failed (see server logs)');
  });
});
