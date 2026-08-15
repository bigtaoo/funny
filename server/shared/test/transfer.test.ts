// Unit tests for slg/transfer.ts (G6 mid-season shard transfer/merge, SLG_DESIGN_LOG.md §27).
import { describe, expect, it } from 'vitest';
import {
  SHARD_TRANSFER_COOLDOWN_DAYS,
  SHARD_TRANSFER_COOLDOWN_MS,
  parseWorldId,
} from '../src/slg/transfer';
import { worldId } from '../src/slg/core';

describe('SHARD_TRANSFER_COOLDOWN_MS', () => {
  it('is SHARD_TRANSFER_COOLDOWN_DAYS days expressed in milliseconds', () => {
    expect(SHARD_TRANSFER_COOLDOWN_MS).toBe(SHARD_TRANSFER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('parseWorldId', () => {
  it('parses a well-formed worldId back into season + shard', () => {
    expect(parseWorldId('s8-2')).toEqual({ season: 8, shard: 2 });
    expect(parseWorldId('s12-0')).toEqual({ season: 12, shard: 0 });
  });

  it('round-trips with core.ts worldId()', () => {
    expect(parseWorldId(worldId(3, 7))).toEqual({ season: 3, shard: 7 });
  });

  it('returns null for a malformed id', () => {
    expect(parseWorldId('not-a-world-id')).toBeNull();
    expect(parseWorldId('s8')).toBeNull(); // missing shard
    expect(parseWorldId('8-2')).toBeNull(); // missing leading s
    expect(parseWorldId('')).toBeNull();
    expect(parseWorldId('s8-2-extra')).toBeNull();
  });
});
