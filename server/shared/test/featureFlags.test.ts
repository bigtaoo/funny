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

describe('evaluateFlag — 求值顺序', () => {
  it('1. doc 不存在 → default', () => {
    expect(evaluateFlag(KEY, null, {})).toBe(flagDefault(KEY));
    expect(evaluateFlag(KEY, undefined, { accountId: 'a' })).toBe(false);
  });

  it('2. 总闸 enabled=false → false（无视定向 + allowAccounts）', () => {
    const d = doc({ enabled: false, rollout: { allowAccounts: ['a'], pct: 100 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false);
  });

  it('总闸开、无 rollout → 全开', () => {
    expect(evaluateFlag(KEY, doc({}), { accountId: 'a' })).toBe(true);
  });

  it('3. denyAccounts 命中 → false（盖过 allow）', () => {
    const d = doc({ rollout: { denyAccounts: ['a'], allowAccounts: ['a'], pct: 100 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false);
  });

  it('4. allowAccounts 命中 → true（盖过 region/platform/pct）', () => {
    const d = doc({ rollout: { allowAccounts: ['a'], regions: ['eu'], platforms: ['web'], pct: 0 } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'cn', platform: 'wechat' })).toBe(true);
  });

  it('4b. allowPublicIds 命中 → true（§9.1，盖过 region/platform/pct；与 accountId 解耦）', () => {
    const d = doc({ rollout: { allowPublicIds: ['123456789'], regions: ['eu'], platforms: ['web'], pct: 0 } });
    // Matched purely by publicId (accountId not required; region/platform/pct restrictions are bypassed).
    expect(evaluateFlag(KEY, d, { publicId: '123456789', region: 'cn', platform: 'wechat' })).toBe(true);
    // publicId not in allowlist → not matched (other restrictions also fail → false).
    expect(evaluateFlag(KEY, d, { publicId: '999999999', region: 'cn' })).toBe(false);
    // allowAccounts and allowPublicIds are independent: an allowPublicIds list does not grant access via accountId with the same value (pct:0 fallback verifies it is not admitted).
    expect(evaluateFlag(KEY, doc({ rollout: { allowPublicIds: ['123456789'], pct: 0 } }), { accountId: '123456789' })).toBe(false);
  });

  it('总闸 enabled=false / denyAccounts 仍盖过 allowPublicIds', () => {
    expect(evaluateFlag(KEY, doc({ enabled: false, rollout: { allowPublicIds: ['1'] } }), { publicId: '1' })).toBe(false);
    expect(evaluateFlag(KEY, doc({ rollout: { denyAccounts: ['a'], allowPublicIds: ['1'] } }), { accountId: 'a', publicId: '1' })).toBe(false);
  });

  it('5a. regions 限定且当前不在内 → false', () => {
    const d = doc({ rollout: { regions: ['eu', 'us'] } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'cn' })).toBe(false);
    expect(evaluateFlag(KEY, d, { accountId: 'a', region: 'eu' })).toBe(true);
    expect(evaluateFlag(KEY, d, { accountId: 'a' })).toBe(false); // 无 region 也不命中
  });

  it('5b. platforms 限定且当前不在内 → false', () => {
    const d = doc({ rollout: { platforms: ['web'] } });
    expect(evaluateFlag(KEY, d, { accountId: 'a', platform: 'wechat' })).toBe(false);
    expect(evaluateFlag(KEY, d, { accountId: 'a', platform: 'web' })).toBe(true);
  });

  it('6. pct 灰度：bucket<pct 命中；边界 0/100；未登录仅 pct>=100', () => {
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 100 } }), {})).toBe(true); // 未登录 + 全量
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 0 } }), { accountId: 'a' })).toBe(false);
    expect(evaluateFlag(KEY, doc({ rollout: { pct: 50 } }), {})).toBe(false); // 未登录 + 非全量 → 保守关
    // pct=50: hit rate across 200 random accounts should be approximately 50% (FNV distribution).
    let hit = 0;
    for (let i = 0; i < 200; i++) {
      if (evaluateFlag(KEY, doc({ rollout: { pct: 50 } }), { accountId: `acc-${i}` })) hit++;
    }
    expect(hit).toBeGreaterThan(70);
    expect(hit).toBeLessThan(130);
  });
});

describe('hash 稳定性', () => {
  it('fnv1a 确定 + 无符号 32 位', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
  it('同玩家同 flag bucket 不抖动', () => {
    const b = rolloutBucket(KEY, 'acc-42');
    expect(rolloutBucket(KEY, 'acc-42')).toBe(b);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });
});

describe('sanitizeFlagDoc', () => {
  it('丢弃非白名单 key / 非对象', () => {
    expect(sanitizeFlagDoc(null)).toBeNull();
    expect(sanitizeFlagDoc({ _id: 'nope' })).toBeNull();
  });
  it('规整 rollout：pct 钳制、平台过滤、缺省 enabled 视为开', () => {
    const d = sanitizeFlagDoc({ _id: KEY, rollout: { pct: 999, platforms: ['web', 'bogus'] } });
    expect(d).not.toBeNull();
    expect(d!.enabled).toBe(true);
    expect(d!.rollout!.pct).toBe(100);
    expect(d!.rollout!.platforms).toEqual(['web']);
  });
  it('显式 enabled=false 保留', () => {
    expect(sanitizeFlagDoc({ _id: KEY, enabled: false })!.enabled).toBe(false);
  });
  it('解析 allowPublicIds（容错过滤非字符串，§9.1）', () => {
    const d = sanitizeFlagDoc({ _id: 'client_log_debug', rollout: { allowPublicIds: ['123456789', 42, null] } });
    expect(d).not.toBeNull();
    expect(d!.rollout!.allowPublicIds).toEqual(['123456789']);
  });
});

describe('isFlagKey', () => {
  it('白名单内才 true', () => {
    expect(isFlagKey('match_bot_fallback')).toBe(true);
    expect(isFlagKey('made_up')).toBe(false);
  });
});

describe('FeatureFlagCache', () => {
  it('refresh 后 isOn 按规则求值；fetch 失败吃旧缓存 + 冷启动 default 兜底', async () => {
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

  it('注入 region 进 ctx', async () => {
    const cache = new FeatureFlagCache({
      fetchAll: async () => [{ _id: KEY, enabled: true, rollout: { regions: ['eu'] } }],
      region: 'eu',
    });
    await cache.refresh();
    expect(cache.isOn(KEY, { accountId: 'a' })).toBe(true); // region defaults to cache.region
    expect(cache.isOn(KEY, { accountId: 'a', region: 'cn' })).toBe(false); // explicit override
  });
});
