// Unit coverage for activityDays.ts's ActivityRecorder (in-memory dedupe, offset math, LRU cap, no-match
// back-off, error swallowing) and the bearerAuth hook that feeds it (auth.ts `onAuthenticated`).
// The Mongo-side filter/pipeline semantics (consent / age / bot / deleted exclusions, $setUnion) are
// exercised against a real database in activity-days.e2e.test.ts.
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { signToken, type Collections } from '@nw/shared';
import { ACTIVITY_WINDOW_DAYS, ActivityRecorder, DAY_MS, offsetOf } from '../src/activityDays.js';
import { makeSecurityHandlers } from '../src/auth.js';

const CREATED = Date.parse('2026-10-01T10:00:00.000Z');

interface Call {
  filter: Record<string, unknown>;
  pipeline: unknown;
}

/** accounts stub: records every findOneAndUpdate and answers with `reply(accountId)`. */
function stubCols(reply: (id: string) => unknown = () => ({ _id: 'x', createdAt: CREATED })) {
  const calls: Call[] = [];
  const cols = {
    accounts: {
      findOneAndUpdate: async (filter: Record<string, unknown>, pipeline: unknown) => {
        calls.push({ filter, pipeline });
        const r = reply(filter._id as string);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  } as unknown as Pick<Collections, 'accounts'>;
  return { cols, calls };
}

function clock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; } };
}

describe('offsetOf', () => {
  it('counts whole 24h windows since createdAt, never negative', () => {
    expect(offsetOf(CREATED, CREATED)).toBe(0);
    expect(offsetOf(CREATED + DAY_MS - 1, CREATED)).toBe(0);
    expect(offsetOf(CREATED + DAY_MS, CREATED)).toBe(1);
    expect(offsetOf(CREATED + 30 * DAY_MS + 5, CREATED)).toBe(30);
    expect(offsetOf(CREATED - 1000, CREATED)).toBe(0); // clock skew
  });
});

describe('ActivityRecorder', () => {
  it('writes once per account per 24h window, then again in the next window', async () => {
    const { cols, calls } = stubCols();
    const c = clock(CREATED + 3600_000);
    const rec = new ActivityRecorder(cols, c.now);

    await rec.record('a');
    expect(calls).toHaveLength(1);
    // Same window: deduped in memory, no write.
    c.set(CREATED + 20 * 3600_000);
    expect(rec.record('a')).toBeUndefined();
    expect(rec.record('a')).toBeUndefined();
    expect(calls).toHaveLength(1);
    // Next window (offset 1): one more write.
    c.set(CREATED + DAY_MS + 60_000);
    await rec.record('a');
    expect(calls).toHaveLength(2);
    expect(rec.record('a')).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('write filter carries every eligibility rule and the age bound; pipeline unions the offset', async () => {
    const { cols, calls } = stubCols();
    const t = CREATED + 2 * DAY_MS;
    const rec = new ActivityRecorder(cols, () => t);
    await rec.record('a');
    const f = calls[0]!.filter;
    expect(f._id).toBe('a');
    expect(f.createdAt).toEqual({ $gt: t - ACTIVITY_WINDOW_DAYS * DAY_MS });
    expect(f['flags.gdprConsent']).toEqual({ $ne: false });
    expect(f.deletedAt).toEqual({ $exists: false });
    expect(f.purgedAt).toEqual({ $exists: false });
    expect(f.deviceId).toEqual({ $not: /^bot-/ });
    expect(JSON.stringify(calls[0]!.pipeline)).toContain('$setUnion');
  });

  it('concurrent requests before the first write resolves cause a single write', async () => {
    const { cols, calls } = stubCols();
    const rec = new ActivityRecorder(cols, () => CREATED);
    const p = rec.record('a');
    rec.record('a');
    rec.record('a');
    await p;
    expect(calls).toHaveLength(1);
  });

  it('stops writing once the account is past the D30 window (offset >= 31)', async () => {
    const { cols, calls } = stubCols();
    const c = clock(CREATED + 29 * DAY_MS);
    const rec = new ActivityRecorder(cols, c.now);
    await rec.record('a');
    c.set(CREATED + 30 * DAY_MS + 1);
    await rec.record('a'); // offset 30 is still recorded
    expect(calls).toHaveLength(2);
    c.set(CREATED + 31 * DAY_MS + 1);
    expect(rec.record('a')).toBeUndefined();
    c.set(CREATED + 40 * DAY_MS);
    expect(rec.record('a')).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('no match (objected / too old / bot / unknown) backs off for a day instead of retrying per request', async () => {
    const { cols, calls } = stubCols(() => null);
    const c = clock(CREATED);
    const rec = new ActivityRecorder(cols, c.now);
    await rec.record('a');
    c.set(CREATED + DAY_MS - 1);
    expect(rec.record('a')).toBeUndefined();
    expect(calls).toHaveLength(1);
    c.set(CREATED + DAY_MS);
    await rec.record('a');
    expect(calls).toHaveLength(2);
  });

  it('a failing write is swallowed (never rejects) and backs off too', async () => {
    const { cols, calls } = stubCols(() => new Error('mongo down'));
    const rec = new ActivityRecorder(cols, () => CREATED);
    await expect(rec.record('a')).resolves.toBeUndefined();
    expect(rec.record('a')).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('a collection without findOneAndUpdate (minimal test fakes) does not throw', async () => {
    const rec = new ActivityRecorder({ accounts: {} } as unknown as Pick<Collections, 'accounts'>, () => CREATED);
    await expect(rec.record('a')).resolves.toBeUndefined();
  });

  it('memory is bounded: least-recently-used accounts are evicted past the cap', async () => {
    const { cols, calls } = stubCols();
    const rec = new ActivityRecorder(cols, () => CREATED, 3);
    for (const id of ['a', 'b', 'c', 'd']) await rec.record(id);
    expect(rec.size).toBe(3);
    // 'a' was evicted → written again; 'd' is still known → deduped.
    await rec.record('a');
    expect(rec.record('d')).toBeUndefined();
    expect(calls.map((x) => x.filter._id)).toEqual(['a', 'b', 'c', 'd', 'a']);
    expect(rec.size).toBe(3);
  });
});

describe('bearerAuth onAuthenticated hook', () => {
  const jwt = { secret: 'test-secret' };
  const req = (token?: string) =>
    ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as unknown as FastifyRequest;

  it('fires with the accountId for an accepted token, and not for a rejected one', async () => {
    const seen: string[] = [];
    const h = makeSecurityHandlers(jwt, () => Date.now(), undefined, (id) => seen.push(id));
    h.bearerAuth(req(signToken('acc-1', jwt)));
    expect(seen).toEqual(['acc-1']);
    expect(() => h.bearerAuth(req('garbage'))).toThrow();
    expect(() => h.bearerAuth(req())).toThrow();
    expect(seen).toEqual(['acc-1']);
  });

  it('does not fire for a revoked token', async () => {
    const seen: string[] = [];
    const h = makeSecurityHandlers(jwt, () => Date.now(), async () => true, (id) => seen.push(id));
    await expect(h.bearerAuth(req(signToken('acc-2', jwt)))).rejects.toThrow();
    const ok = makeSecurityHandlers(jwt, () => Date.now(), async () => false, (id) => seen.push(id));
    await ok.bearerAuth(req(signToken('acc-3', jwt)));
    expect(seen).toEqual(['acc-3']);
  });
});
