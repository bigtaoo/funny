/**
 * Phase 2 of RETENTION_LAUNCH_PLAN.md (§2) — the "why" queries added on top of Phase 1's plain D1–D7:
 *
 *   • queryRetentionBy — D1–D7 of the new-user cohort, sliced by one property of each device's first
 *     session. Covers both derivation paths (an event-derived dimension and a SessionDoc-derived one)
 *     and the per-device date-aligned offset semantics RetentionByRow's own doc describes.
 *   • querySessionDurationDist / queryChurnLastScene — the two supplementary queries, same shape as
 *     queryLoadTime / queryBadgeDist respectively.
 *   • GET /internal/query?type=retention_by/session_duration_dist/churn_scene_dist — HTTP dispatch.
 *
 * Own database, like bootAndLoadTime.e2e.test.ts, so it shares no mutable state with the suites that
 * hardcode cross-test totals. Skipped entirely when Mongo is unreachable (same convention).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createAnalyticsMongo, type AnalyticsMongo, type EventDoc, type SessionDoc } from '../src/db';
import { AnalyticsService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import { createInternalAuth } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_analytics_test_retentionby';
const INTERNAL_KEY = 'test-internal-key';
const DAY = 86400_000;

async function tryConnect(): Promise<AnalyticsMongo | null> {
  try {
    return await createAnalyticsMongo(URI, DB);
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[analyticsvc.retentionby.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('grouped retention + supplementary queries', () => {
  let svc: AnalyticsService;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await mongo!.ensureIndexes();
    await mongo!.db.dropDatabase();
    await mongo!.ensureIndexes();
    svc = new AnalyticsService(mongo!.collections);
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'test-jwt-secret', internalAuth: createInternalAuth({ legacyKey: INTERNAL_KEY }) },
      svc,
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await mongo!.db.dropDatabase();
    await mongo!.close();
  });

  function sessionStart(device: string, sid: string, dayOffset: number, anchor: number, props: Record<string, unknown> = {}, platform = 'web'): EventDoc {
    return {
      session_id: sid,
      device_id: device,
      platform,
      os: 'test',
      game_version: '1',
      locale: 'en',
      event: 'session_start',
      props,
      ts: new Date(anchor + dayOffset * DAY + 3600_000),
    };
  }
  function ev(device: string, sid: string, event: string, dayOffset: number, anchor: number, props: Record<string, unknown> = {}): EventDoc {
    return {
      session_id: sid,
      device_id: device,
      platform: 'web',
      os: 'test',
      game_version: '1',
      locale: 'en',
      event,
      props,
      ts: new Date(anchor + dayOffset * DAY + 3600_000 + 60_000), // one minute after session_start
    };
  }
  function sessionDoc(sid: string, device: string, fields: Partial<SessionDoc>): SessionDoc {
    return {
      _id: sid,
      device_id: device,
      platform: 'web',
      os: 'test',
      started_at: new Date(),
      scenes_visited: [],
      events_count: 1,
      ...fields,
    };
  }

  // ─── queryRetentionBy: event-derived dimension (login_mode) ────────────────

  it('groups the new-user cohort by login_mode (event-derived) and computes each group\'s own D1', async () => {
    const ANCHOR = Date.UTC(2021, 0, 10);
    await mongo!.collections.events.insertMany([
      // Day 0: three devices' first-ever session. A explicitly logs in, B uses CrazyGames SSO, C
      // never logs in at all (silent device-only play) — login_mode must fall back to 'device'.
      sessionStart('rb-A', 'rb-A-0', 0, ANCHOR),
      ev('rb-A', 'rb-A-0', 'login_ok', 0, ANCHOR, { mode: 'login' }),
      sessionStart('rb-B', 'rb-B-0', 0, ANCHOR),
      ev('rb-B', 'rb-B-0', 'login_ok', 0, ANCHOR, { mode: 'crazygames' }),
      sessionStart('rb-C', 'rb-C-0', 0, ANCHOR),
      // Day 1: A and C return; B does not.
      sessionStart('rb-A', 'rb-A-1', 1, ANCHOR),
      sessionStart('rb-C', 'rb-C-1', 1, ANCHOR),
    ]);

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'login_mode');
    const byValue = new Map(rows.map((r) => [r.value, r]));

    expect(byValue.get('login')).toMatchObject({ cohort_size: 1, d: { 1: 1 }, d_rate: { 1: 1 } });
    expect(byValue.get('crazygames')).toMatchObject({ cohort_size: 1, d: { 1: 0 }, d_rate: { 1: 0 } });
    expect(byValue.get('device')).toMatchObject({ cohort_size: 1, d: { 1: 1 }, d_rate: { 1: 1 } });
  });

  // ─── queryRetentionBy: SessionDoc-derived dimension (browser) ───────────────

  it('groups by browser (SessionDoc field, not an event) via the device\'s first session_id', async () => {
    const ANCHOR = Date.UTC(2021, 1, 1); // separate month, isolated from the login_mode seed above
    await mongo!.collections.events.insertMany([
      sessionStart('rb-chrome-A', 'rb-chrome-A-0', 0, ANCHOR),
      sessionStart('rb-safari-B', 'rb-safari-B-0', 0, ANCHOR),
      sessionStart('rb-chrome-A', 'rb-chrome-A-1', 1, ANCHOR), // returns
    ]);
    await mongo!.collections.sessions.insertMany([
      sessionDoc('rb-chrome-A-0', 'rb-chrome-A', { browser: 'chrome' }),
      sessionDoc('rb-safari-B-0', 'rb-safari-B', { browser: 'safari' }),
    ]);

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'browser');
    const byValue = new Map(rows.map((r) => [r.value, r]));

    expect(byValue.get('chrome')).toMatchObject({ cohort_size: 1, d: { 1: 1 } });
    expect(byValue.get('safari')).toMatchObject({ cohort_size: 1, d: { 1: 0 } });
  });

  it('falls back to unknown when a device\'s first SessionDoc is missing (e.g. already TTL-expired)', async () => {
    const ANCHOR = Date.UTC(2021, 1, 15);
    await mongo!.collections.events.insertOne(sessionStart('rb-nodoc', 'rb-nodoc-0', 0, ANCHOR));
    // Deliberately no matching sessions.insertOne — SessionDoc absent.

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(1, 'device_type');
    expect(rows).toEqual([{ value: 'unknown', cohort_size: 1, d: {}, d_rate: {} }]);
  });

  // ─── Per-device date-aligned offsets (RetentionByRow's own doc) ─────────────

  it('evaluates D1 against each device\'s OWN first-session date, not one shared calendar day', async () => {
    const ANCHOR = Date.UTC(2021, 2, 1);
    await mongo!.collections.events.insertMany([
      // rb-early's first session is day 0 → its D1 target is day 1, which HAS happened by the pinned clock.
      sessionStart('rb-early', 'rb-early-0', 0, ANCHOR),
      ev('rb-early', 'rb-early-0', 'tutorial_complete', 0, ANCHOR),
      sessionStart('rb-early', 'rb-early-1', 1, ANCHOR), // returns on its own D1
      // rb-late's first session is day 1 → its D1 target is day 2, which has NOT happened yet.
      sessionStart('rb-late', 'rb-late-1', 1, ANCHOR),
      ev('rb-late', 'rb-late-1', 'tutorial_complete', 1, ANCHOR),
    ]);

    // Clock pinned to day 1 noon: day 2 has not started, so rb-late is not yet eligible for D1.
    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'tutorial_complete');
    const group = rows.find((r) => r.value === 'true')!;
    // cohort_size counts BOTH devices (same group — both finished the tutorial in their first session)...
    expect(group.cohort_size).toBe(2);
    // ...but D1's own denominator is 1 (only rb-early's D1 has elapsed) and its numerator is 1 (it returned).
    expect(group.d[1]).toBe(1);
    expect(group.d_rate[1]).toBe(1); // NOT 1/2 — rb-late is excluded from this offset entirely, not counted as a miss
  });

  // ─── queryRetentionBy: the other three event-derived dimensions ────────────
  // login_mode and tutorial_complete have their own tests above; load_time_bucket, first_battle_result
  // and matched_bot share the same resolveEventDimension() but read a different event/prop each — a
  // typo'd event name or prop key would silently misgroup rather than throw, so each gets its own case.

  it('groups by load_time_bucket (props.total_ms on the load_time event, bucketed)', async () => {
    const ANCHOR = Date.UTC(2021, 3, 1);
    await mongo!.collections.events.insertMany([
      sessionStart('rb-fast', 'rb-fast-0', 0, ANCHOR),
      ev('rb-fast', 'rb-fast-0', 'load_time', 0, ANCHOR, { total_ms: 1500 }), // < 2s
      sessionStart('rb-slow', 'rb-slow-0', 0, ANCHOR),
      ev('rb-slow', 'rb-slow-0', 'load_time', 0, ANCHOR, { total_ms: 9000 }), // 8s+
      // No load_time event at all (e.g. crashed before it fired) — falls back to 'unknown'.
      sessionStart('rb-noload', 'rb-noload-0', 0, ANCHOR),
      sessionStart('rb-fast', 'rb-fast-1', 1, ANCHOR), // returns
    ]);

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'load_time_bucket');
    const byValue = new Map(rows.map((r) => [r.value, r]));

    expect(byValue.get('<2s')).toMatchObject({ cohort_size: 1, d: { 1: 1 } });
    expect(byValue.get('8s+')).toMatchObject({ cohort_size: 1, d: { 1: 0 } });
    expect(byValue.get('unknown')).toMatchObject({ cohort_size: 1, d: { 1: 0 } });
  });

  it("groups by first_battle_result (props.result on the game_end event); no battle → 'none'", async () => {
    const ANCHOR = Date.UTC(2021, 3, 15);
    await mongo!.collections.events.insertMany([
      sessionStart('rb-win', 'rb-win-0', 0, ANCHOR),
      ev('rb-win', 'rb-win-0', 'game_end', 0, ANCHOR, { result: 'win' }),
      sessionStart('rb-nobattle', 'rb-nobattle-0', 0, ANCHOR),
      sessionStart('rb-win', 'rb-win-1', 1, ANCHOR), // returns
    ]);

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'first_battle_result');
    const byValue = new Map(rows.map((r) => [r.value, r]));

    expect(byValue.get('win')).toMatchObject({ cohort_size: 1, d: { 1: 1 } });
    expect(byValue.get('none')).toMatchObject({ cohort_size: 1, d: { 1: 0 } });
  });

  it("groups by matched_bot (pvp_match_bot event presence, 'true'/'false')", async () => {
    const ANCHOR = Date.UTC(2021, 4, 1);
    await mongo!.collections.events.insertMany([
      sessionStart('rb-bot', 'rb-bot-0', 0, ANCHOR),
      ev('rb-bot', 'rb-bot-0', 'pvp_match_bot', 0, ANCHOR),
      sessionStart('rb-human', 'rb-human-0', 0, ANCHOR),
      sessionStart('rb-bot', 'rb-bot-1', 1, ANCHOR), // returns
    ]);

    const pinned = new AnalyticsService(mongo!.collections, () => ANCHOR + DAY + 12 * 3600_000);
    const rows = await pinned.queryRetentionBy(2, 'matched_bot');
    const byValue = new Map(rows.map((r) => [r.value, r]));

    expect(byValue.get('true')).toMatchObject({ cohort_size: 1, d: { 1: 1 } });
    expect(byValue.get('false')).toMatchObject({ cohort_size: 1, d: { 1: 0 } });
  });

  // ─── querySessionDurationDist ────────────────────────────────────────────────

  describe('querySessionDurationDist', () => {
    beforeAll(async () => {
      await mongo!.collections.sessions.deleteMany({});
      const docs: SessionDoc[] = [];
      // 10 web sessions at 30s..300s (30s buckets).
      for (let i = 1; i <= 10; i++) {
        docs.push(sessionDoc(`sd-web-${i}`, `dev-sd-web-${i}`, { platform: 'web', duration_sec: i * 30, started_at: new Date() }));
      }
      // One session with no duration_sec at all (never got a session_end) — must not count as a sample.
      docs.push(sessionDoc('sd-web-nodur', 'dev-sd-nodur', { platform: 'web', started_at: new Date() }));
      docs.push(sessionDoc('sd-wx-1', 'dev-sd-wx', { platform: 'wechat', duration_sec: 45, started_at: new Date() }));
      await mongo!.collections.sessions.insertMany(docs);
    });

    it('reports percentiles off the histogram, same bucket-rounding rule as load time', async () => {
      const web = (await svc.querySessionDurationDist(7)).find((r) => r.platform === 'web')!;
      expect(web.samples).toBe(10);
      expect(web.p50_sec).toBe(150); // 5th of ten values 30..300 is 150
      expect(web.p90_sec).toBe(270);
    });

    it('ignores sessions with no duration_sec (never ended) rather than treating them as zero', async () => {
      const web = (await svc.querySessionDurationDist(7)).find((r) => r.platform === 'web')!;
      expect(web.samples).toBe(10); // not 11
    });

    it('keeps platforms separate', async () => {
      const wx = (await svc.querySessionDurationDist(7)).find((r) => r.platform === 'wechat')!;
      expect(wx).toMatchObject({ samples: 1, p50_sec: 60 }); // 45s rounds up into the 30-60s bucket
    });
  });

  // ─── queryChurnLastScene ──────────────────────────────────────────────────────

  describe('queryChurnLastScene', () => {
    it('counts churn_signal EVENTS by scene, not distinct devices', async () => {
      await mongo!.collections.events.deleteMany({ event: 'churn_signal' });
      const ANCHOR = Date.now();
      const doc = (device: string, scene: string): EventDoc => ({
        session_id: `churn-${device}-${scene}-${Math.random()}`,
        device_id: device,
        platform: 'web',
        os: 'test',
        game_version: '1',
        locale: 'en',
        event: 'churn_signal',
        props: { scene, reason: 'idle_10min' },
        ts: new Date(ANCHOR),
      });
      await mongo!.collections.events.insertMany([
        doc('cs-1', 'LobbyScene'), doc('cs-1', 'LobbyScene'), // same device, twice — both count
        doc('cs-2', 'LobbyScene'),
        doc('cs-3', 'GameScene'),
      ]);

      const rows = await svc.queryChurnLastScene(7);
      expect(rows.find((r) => r.scene === 'LobbyScene')?.count).toBe(3);
      expect(rows.find((r) => r.scene === 'GameScene')?.count).toBe(1);
      // Most-frequent-first.
      expect(rows[0]!.scene).toBe('LobbyScene');
    });
  });

  // ─── HTTP dispatch ────────────────────────────────────────────────────────────

  async function query(qs: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/internal/query?${qs}`, { headers: { 'X-Internal-Key': INTERNAL_KEY } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  it('GET /internal/query?type=retention_by requires a known dimension', async () => {
    const missing = await query('type=retention_by&days=7');
    expect(missing.status).toBe(400);
    const bad = await query('type=retention_by&days=7&dimension=not_a_real_dimension');
    expect(bad.status).toBe(400);
  });

  it('GET /internal/query?type=retention_by dispatches to queryRetentionBy', async () => {
    const r = await query('type=retention_by&days=7&dimension=login_mode');
    expect(r.status).toBe(200);
    const data = r.body.data as { type: string; retention_by: unknown[] };
    expect(data.type).toBe('retention_by');
    expect(Array.isArray(data.retention_by)).toBe(true);
  });

  it('GET /internal/query?type=session_duration_dist dispatches to querySessionDurationDist', async () => {
    const r = await query('type=session_duration_dist&days=7');
    expect(r.status).toBe(200);
    const data = r.body.data as { type: string; session_duration_dist: unknown[] };
    expect(data.type).toBe('session_duration_dist');
    expect(Array.isArray(data.session_duration_dist)).toBe(true);
  });

  it('GET /internal/query?type=churn_scene_dist dispatches to queryChurnLastScene', async () => {
    const r = await query('type=churn_scene_dist&days=7');
    expect(r.status).toBe(200);
    const data = r.body.data as { type: string; churn_scene_dist: unknown[] };
    expect(data.type).toBe('churn_scene_dist');
    expect(Array.isArray(data.churn_scene_dist)).toBe(true);
  });
});
