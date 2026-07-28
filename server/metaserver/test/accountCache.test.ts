// Unit tests for accountCache.ts (2026-07-27 mid-term audit item 4/5): ban-status + publicId reverse-lookup
// caching. Focuses on the two properties that matter for correctness (not just "it caches"): a cache hit must
// skip the Mongo call entirely, and invalidateBanStatus must make the very next read re-query rather than
// serve a stale value — see auth-password.e2e.test.ts for the full end-to-end ban/unban regression.
import { describe, it, expect, vi } from 'vitest';
import type { Collections } from '@nw/shared';
import { AccountCache } from '../src/accountCache.js';
import { FakeCollection } from './helpers/fakeCollection.js';

interface AccountDoc {
  _id: string;
  publicId?: string;
  flags?: { banned?: boolean };
  deletedAt?: number;
}

function colsWith(seed: AccountDoc[]): { cols: Collections; accounts: FakeCollection<AccountDoc> } {
  const accounts = new FakeCollection<AccountDoc>().seed(...seed);
  return { cols: { accounts } as unknown as Collections, accounts };
}

describe('AccountCache.getBanStatus', () => {
  it('first call queries Mongo; second call for the same accountId is served from cache (no second query)', async () => {
    const { cols, accounts } = colsWith([{ _id: 'a', flags: { banned: false } }]);
    const spy = vi.spyOn(accounts, 'findOne');
    const cache = new AccountCache();

    expect(await cache.getBanStatus(cols, 'a')).toEqual({ banned: false, deletedAt: undefined });
    expect(await cache.getBanStatus(cols, 'a')).toEqual({ banned: false, deletedAt: undefined });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('different accountIds are cached independently', async () => {
    const { cols, accounts } = colsWith([{ _id: 'a' }, { _id: 'b', flags: { banned: true } }]);
    const spy = vi.spyOn(accounts, 'findOne');
    const cache = new AccountCache();

    expect((await cache.getBanStatus(cols, 'a')).banned).toBe(false);
    expect((await cache.getBanStatus(cols, 'b')).banned).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidateBanStatus forces the next read to re-query (ban/unban/deleteAccount call this on write)', async () => {
    const { cols, accounts } = colsWith([{ _id: 'a', flags: { banned: false } }]);
    const spy = vi.spyOn(accounts, 'findOne');
    const cache = new AccountCache();

    expect((await cache.getBanStatus(cols, 'a')).banned).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // Simulate the admin /ban route's write happening behind the cache's back, then invalidating.
    accounts.docs.get('a')!.flags = { banned: true };
    cache.invalidateBanStatus('a');

    expect((await cache.getBanStatus(cols, 'a')).banned).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('surfaces deletedAt (soft-delete) alongside banned', async () => {
    const { cols } = colsWith([{ _id: 'a', deletedAt: 12345 }]);
    const cache = new AccountCache();
    expect(await cache.getBanStatus(cols, 'a')).toEqual({ banned: false, deletedAt: 12345 });
  });

  it('missing account row → banned:false, deletedAt:undefined (never throws)', async () => {
    const { cols } = colsWith([]);
    const cache = new AccountCache();
    expect(await cache.getBanStatus(cols, 'ghost')).toEqual({ banned: false, deletedAt: undefined });
  });
});

describe('AccountCache.getAccountIdByPublicId', () => {
  it('first call queries Mongo; second call for the same publicId is served from cache', async () => {
    const { cols, accounts } = colsWith([{ _id: 'a', publicId: '123456789' }]);
    const spy = vi.spyOn(accounts, 'findOne');
    const cache = new AccountCache();

    expect(await cache.getAccountIdByPublicId(cols, '123456789')).toBe('a');
    expect(await cache.getAccountIdByPublicId(cols, '123456789')).toBe('a');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a miss is never cached — a later call after the id becomes valid resolves correctly', async () => {
    const { cols, accounts } = colsWith([]);
    const spy = vi.spyOn(accounts, 'findOne');
    const cache = new AccountCache();

    expect(await cache.getAccountIdByPublicId(cols, '000000000')).toBeNull();
    expect(await cache.getAccountIdByPublicId(cols, '000000000')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2); // misses always re-query, unlike hits

    accounts.docs.set('a', { _id: 'a', publicId: '000000000' });
    expect(await cache.getAccountIdByPublicId(cols, '000000000')).toBe('a');
  });

  it('the mapping never changes once cached: a later mutation of the same publicId->accountId row does not affect the cached id (matches ensurePublicId, which never reassigns)', async () => {
    const { cols, accounts } = colsWith([{ _id: 'a', publicId: '123456789' }]);
    const cache = new AccountCache();
    expect(await cache.getAccountIdByPublicId(cols, '123456789')).toBe('a');

    accounts.docs.delete('a');
    // Still resolves 'a' from cache — this is intentional: nothing in this codebase reassigns or clears an
    // existing publicId, so there is no invalidation path to wire up (contrast getBanStatus above).
    expect(await cache.getAccountIdByPublicId(cols, '123456789')).toBe('a');
  });
});
