// Feature flag core unit tests (FEATURE_FLAGS_DESIGN §3: 6-step evaluation order + hash stability + cache degradation).
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateFlag,
  fnv1a,
  rolloutBucket,
  sanitizeFlagDoc,
  FeatureFlagCache,
  flagDefault,
  isFlagKey,
  type FeatureFlagDoc,
  type FlagKey,
} from '../src/featureFlags';

const KEY: FlagKey = 'match_bot_fallback';

function doc(partial: Partial<FeatureFlagDoc>): FeatureFlagDoc {
  return { _id: KEY, enabled: true, updatedAt: 1, updatedBy: 'admin', ...partial };
}

describe('evaluateFlag — evaluation order', () => {
  it('1. doc does not exist → default', () => {
    expect(evaluateFlag(KEY, null, {})).toBe(flagDefault(KEY));
    expect(evaluateFlag(KEY, undefined, { accountId: 'a' })).toBe(false);
  });

  it('2. master switch enabled=false → false (ignores targeting + allowAccounts)', () => {
    const d = doc({ enabled: false, rollout: { allowAccounts: ['a'], pct: 100 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false);
  });

  it('master switch on, no rollout → fully enabled', () => {
    expect(evaluateFlag(KEY, doc({}), { accountId: 'a' })).toBe(true);
  });

  it('3. denyAccounts matched → false (overrides allowAccounts)', () => {
    const d = doc({ rollout: { denyAccounts: ['a'], allowAccounts: ['a'], pct: 100 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false);
  });

  it('4. allowAccounts matched → true (overrides region/platform/pct)', () => {
    const d = doc({ rollout: { allowAccounts: ['a'], regions: ['eu'], platforms: ['web'], pct: 0 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'cn', platform: 'wechat' })).toBe(true);
  });

  it('4b. allowPublicIds matched → true (§9.1, overrides region/platform/pct; decoupled from accountId)', () => {
    const d = doc({ rollout: { allowPublicIds: ['123456789'], regions: ['eu'], platforms: ['web'], pct: 0 } });
    // Matched purely by publicId (accountId not required; region/platform/pct restrictions are bypassed).
    expect(evaluateFlag(KEY, d, { publicId: '123456789', region: 'cn', platform: 'wechat' })).toBe(true);
    // publicId not in allowlist → not matched (other restrictions also fail → false).
    expect(evaluateFlag(KEY, d, { publicId: '999999999', region: 'cn' })).toBe(false);
    // allowAccounts and allowPublicIds are independent: an allowPublicIds list does not grant access via accountId with the same value (pct:0 fallback verifies it is not admitted).
    expect(evaluateFlag(KEY, doc({ rollout: { allowPublicIds: ['123456789'], pct: 0 } }), { accountId: '123456789' })).toBe(false);
  });

  it('master switch enabled=false / denyAccounts still overrides allowPublicIds', () => {
    expect(evaluateFlag(KEY, doc({ enabled: false, rollout: { allowPublicIds: ['1'] } }), { publicId: '1' })).toBe(false);
    expect(evaluateFlag(KEY, doc({ rollout: { denyAccounts: ['a'], allowPublicIds: ['1'] } }), { accountId: 'a', publicId: '1' })).toBe(false);
  });

  it('5a. regions restricted and current region not included → false', () => {
    const d = doc({ rollout: { regions: ['eu', 'us'] } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'cn' })).toBe(false);
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'eu' })).toBe(true);
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false); // no region provided → also not matched
  });

  it('5b. platforms restricted and current platform not included → false', () => {
    const d = doc({ rollout: { platforms: ['web'] } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', platform: 'wechat' })).toBe(false);
    expect(evaluateFlag(KEY, d, { accountId: 'a', platform: 'web' })).toBe(true);
  });

  it('6. pct rollout: bucket<pct hits; boundary 0/100; not logged in only matches pct>=100', () => {
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 100 } }), {})).toBe(true); // not logged in + 100% rollout
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 0 } }), { accountId: 'a' })).toBe(false);
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 50 } }), {})).toBe(false); // not logged in + partial rollout → conservatively off
    // pct=50: hit rate across 200 random accounts should be approximately 50% (FNV distribution).
    let hit = 0;
    for (let i = 0; i < 200; i++) {
      if (evaluateFlag(KEY, doc({ rollout: { pct: 50 } }), { accountId: `acc-${i}` })) hit++;
    }
    expect(hit).toBeGreaterThan(70);
    expect(hit).toBeLessThan(130);
  });
});

describe('hash stability', () => {
  it('fnv1a is deterministic + unsigned 32-bit', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
  it('same player same flag bucket does not jitter', () => {
    const b = rolloutBucket(KEY, 'acc-42');
    expect(rolloutBucket(KEY, 'acc-42')).toBe(b);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });
});

describe('sanitizeFlagDoc', () => {
  it('drops non-allowlisted keys / non-objects', () => {
    expect(sanitizeFlagDoc(null)).toBeNull();
    expect(sanitizeFlagDoc({ _id: 'nope' })).toBeNull();
  });
  it('normalizes rollout: clamps pct, filters platforms, defaults missing enabled to true', () => {
    const d = sanitizeFlagDoc({ _id: KEY, rollout: { pct: 999, platforms: ['web', 'bogus'] } });
    expect(d).not.toBeNull();
    expect(d!.enabled).toBe(true);
    expect(d!.rollout!.pct).toBe(100);
    expect(d!.rollout!.platforms).toEqual(['web']);
  });
  it('explicit enabled=false is preserved', () => {
    expect(sanitizeFlagDoc({ _id: KEY, enabled: false })!.enabled).toBe(false);
  });
  it('parses allowPublicIds (tolerantly filters non-strings, §9.1)', () => {
    const d = sanitizeFlagDoc({ _id: 'client_log_debug', rollout: { allowPublicIds: ['123456789', 42, null] } });
    expect(d).not.toBeNull();
    expect(d!.rollout!.allowPublicIds).toEqual(['123456789']);
  });
});

describe('isFlagKey', () => {
  it('returns true only for allowlisted keys', () => {
    expect(isFlagKey('match_bot_fallback')).toBe(true);
    expect(isFlagKey('made_up')).toBe(false);
  });
});

describe('FeatureFlagCache', () => {
  it('isOn evaluates by rules after refresh; fetch failure retains stale cache + cold-start default fallback', async () => {
    let payload: unknown[] = [{ _id: KEY, enabled: true, rollout: { pct: 100 } }];
    let fail = false;
    const cache = new FeatureFlagCache({
      fetchAll: async () => {
        if (fail) throw new Error('admin down');
        return payload;
      },
      now: () => 0,
    });
    // Cold start — never fetched yet → default
    expect(cache.isOn(KEY, { accountId: 'a' })).toBe(false);
    expect(cache.hasLoaded).toBe(false);

    await cache.refresh();
    expect(cache.hasLoaded).toBe(true);
    expect(cache.isOn(KEY, { accountId: 'a' })).toBe(true);

    // admin is down: stale cache is retained
    fail = true;
    await cache.refresh();
    expect(cache.isOn(KEY, { accountId: 'a' })).toBe(true);
  });

  it('injects region into ctx', async () => {
    const cache = new FeatureFlagCache({
      fetchAll: async () => [{ _id: KEY, enabled: true, rollout: { regions: ['eu'] } }],
      region: 'eu',
    });
    await cache.refresh();
    expect(cache.isOn(KEY, { accountId: 'a' })).toBe(true); // region defaults to cache.region
    expect(cache.isOn(KEY, { accountId: 'a', region: 'cn' })).toBe(false); // explicit override
  });
});
