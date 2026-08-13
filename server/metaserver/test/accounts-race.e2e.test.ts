// Regression test (2026-08-03 fix): concurrent first-time account resolution/binding must resolve
// idempotently, not throw. resolveByDevice/resolveByOpenid/resolveByOAuth/registerWithPassword/bindOAuth
// all follow the same shape — read-then-upsert (or read-then-conditional-write) on a uniquely-indexed
// field — and MongoDB can throw a duplicate-key error from the "loser" of such a race even with
// upsert:true (both sides see "no match" before either write lands); before the fix none of these call
// sites caught that error, so a client retrying a dropped request could get an unhandled 500 instead of
// the same accountId/token every other caller gets.
//
// Verified against pre-fix code (git-stash the source, rerun, confirm red — see
// feedback-verify-regression-test-catches-bug-before-fix memory): only the bindOAuth case below
// reliably reproduces the race in this environment (its race is a cross-DOCUMENT multikey-index
// collision — two different accounts' oauth arrays colliding — which this MongoDB/driver combination
// does not appear to auto-retry). The other four cases are same-document upserts on a not-yet-existing
// key; up to 60 concurrent callers here never reproduced the underlying duplicate-key error against the
// pre-fix code, so those four are a best-effort correctness canary (they'd catch a regression on a setup
// where the race *does* reproduce) rather than a proven repro of the exact failure mode — the fix itself
// (catching code 11000 and falling through to a re-read) is still correct and harmless when no race occurs.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle } from '@nw/shared';
import { resolveByDevice, resolveByOpenid, resolveByOAuth, bindOAuth, registerWithPassword } from '../dist/accounts.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_accounts_race_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[accounts-race.e2e] Mongo unreachable (${URI}) — skipping.`);

const NOW = 1_000_000;
const CONCURRENCY = 12;

describe.skipIf(!mongo)('accounts.ts concurrent first-resolution races', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('N concurrent resolveByDevice calls for the same brand-new deviceId all resolve to one accountId, none throw', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => resolveByDevice(m.collections, 'race-device-1', NOW)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set((results as PromiseFulfilledResult<{ accountId: string }>[]).map((r) => r.value.accountId));
    expect(ids.size).toBe(1);
    expect(await m.collections.accounts.countDocuments({ deviceId: 'race-device-1' })).toBe(1);
  });

  it('N concurrent resolveByOpenid calls for the same brand-new openid all resolve to one accountId, none throw', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => resolveByOpenid(m.collections, 'race-openid-1', NOW)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set((results as PromiseFulfilledResult<{ accountId: string }>[]).map((r) => r.value.accountId));
    expect(ids.size).toBe(1);
  });

  it('N concurrent resolveByOAuth calls for the same brand-new provider+sub all resolve to one accountId, none throw', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => resolveByOAuth(m.collections, 'wechat', 'race-sub-1', NOW)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set((results as PromiseFulfilledResult<{ accountId: string }>[]).map((r) => r.value.accountId));
    expect(ids.size).toBe(1);
  });

  it('N concurrent registerWithPassword calls for the same brand-new loginId: exactly one "ok", the rest "taken", none throw', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        registerWithPassword(m.collections, 'race-login-1', 'pw123456', undefined, NOW + i)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const kinds = (results as PromiseFulfilledResult<{ kind: string }>[]).map((r) => r.value.kind);
    expect(kinds.filter((k) => k === 'ok').length).toBe(1);
    expect(kinds.filter((k) => k === 'taken').length).toBe(CONCURRENCY - 1);
    expect(await m.collections.accounts.countDocuments({ 'password.loginId': 'race-login-1' })).toBe(1);
  });

  it('N concurrent bindOAuth calls for the same never-bound provider+sub from DIFFERENT accounts: exactly one wins, the rest see already_bound, none throw', async () => {
    const accountIds = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => resolveByDevice(m.collections, `race-bind-dev-${i}`, NOW)),
    );
    const results = await Promise.allSettled(
      accountIds.map((a) => bindOAuth(m.collections, a.accountId, 'wechat', 'race-bind-sub-1')),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const kinds = (results as PromiseFulfilledResult<{ kind: string }>[]).map((r) => r.value.kind);
    expect(kinds.filter((k) => k === 'ok').length).toBe(1);
    expect(kinds.filter((k) => k === 'already_bound').length).toBe(CONCURRENCY - 1);
    expect(await m.collections.accounts.countDocuments({ 'oauth.provider': 'wechat', 'oauth.sub': 'race-bind-sub-1' })).toBe(1);
  });
});
