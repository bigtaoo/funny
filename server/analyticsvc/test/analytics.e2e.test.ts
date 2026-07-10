// analyticsvc end-to-end (A9-6/A9-7): real Mongo + real node:http.
//   • POST /analytics/events batch ingestion
//   • GET  /internal/query?type=event_counts/dau/funnel (X-Internal-Key)
//   • runFunnelEtl + queryFunnel funnel ETL closed loop
//   • /health no auth; missing key → 401; unknown type → 400
// Entire suite is skipped when Mongo is unreachable (CI must run docker compose up -d first).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createAnalyticsMongo, type AnalyticsMongo } from '../src/db';
import { AnalyticsService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import { createInternalAuth } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_analytics_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';

async function tryConnect(): Promise<AnalyticsMongo | null> {
  try {
    return await createAnalyticsMongo(URI, DB);
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[analyticsvc.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('analyticsvc e2e', () => {
  let server: Server;
  let base: string;
  let svc: AnalyticsService;

  const TODAY = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await mongo!.ensureIndexes();
    // Clear test DB
    await mongo!.db.dropDatabase();
    await mongo!.ensureIndexes();

    svc = new AnalyticsService(mongo!.collections);
    server = startHttpApi(
      {
        host: '127.0.0.1',
        port: 0,
        jwtSecret: SECRET,
        internalAuth: createInternalAuth({ legacyKey: INTERNAL_KEY }),
      },
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

  // ─── Health probe ────────────────────────────────────────────────────────────

  it('GET /health no auth required → 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('analyticsvc');
  });

  // ─── Config endpoint ────────────────────────────────────────────────────────────

  it('GET /analytics/config returns sampling configuration', async () => {
    const res = await fetch(`${base}/analytics/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { enabled: boolean; defaultSample: number } };
    expect(body.ok).toBe(true);
    expect(body.data.enabled).toBe(true);
    expect(typeof body.data.defaultSample).toBe('number');
  });

  // ─── Event ingestion ────────────────────────────────────────────────────────────

  it('POST /analytics/events ingests event batch → 200', async () => {
    const now = Date.now();
    const batch = {
      session_id: 'sess-001',
      device_id: 'dev-001',
      platform: 'web',
      os: 'Windows',
      game_version: '0.1.0',
      locale: 'zh',
      events: [
        { event: 'session_start', ts: now },
        { event: 'game_start',    ts: now + 1000 },
        { event: 'level_attempt', ts: now + 2000 },
        { event: 'level_complete', ts: now + 5000 },
      ],
    };
    const res = await fetch(`${base}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(200);
    // fire-and-forget: give the background write a moment to complete
    await new Promise((r) => setTimeout(r, 200));
  });

  it('POST /analytics/events second device + screen_view (partial funnel)', async () => {
    const now = Date.now();
    const batch = {
      session_id: 'sess-002',
      device_id: 'dev-002',
      platform: 'web',
      os: 'macOS',
      game_version: '0.1.0',
      locale: 'en',
      events: [
        { event: 'session_start', ts: now },
        { event: 'screen_view',   ts: now + 500, props: { screen: 'lobby' } },
        { event: 'game_start',    ts: now + 1000 },
      ],
    };
    const res = await fetch(`${base}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
  });

  it('POST /analytics/events empty events array → 400', async () => {
    const res = await fetch(`${base}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'x', device_id: 'x', platform: 'web', os: '', game_version: '', locale: '', events: [] }),
    });
    expect(res.status).toBe(400);
  });

  // ─── /internal/query auth ────────────────────────────────────────────────

  it('GET /internal/query missing key → 401', async () => {
    const res = await fetch(`${base}/internal/query?type=event_counts&days=7`);
    expect(res.status).toBe(401);
  });

  it('GET /internal/query unknown type → 400', async () => {
    const res = await fetch(`${base}/internal/query?type=unknown`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(400);
  });

  // ─── event_counts ────────────────────────────────────────────────────────

  it('GET /internal/query?type=event_counts returns counts by date and event', async () => {
    const res = await fetch(`${base}/internal/query?type=event_counts&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; counts: { date: string; event: string; count: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('event_counts');
    // Confirm there is data for today
    const today = body.data.counts.filter((r) => r.date === TODAY);
    expect(today.length).toBeGreaterThan(0);
    // session_start should have 2 entries (dev-001 + dev-002)
    const ssRow = today.find((r) => r.event === 'session_start');
    expect(ssRow?.count).toBe(2);
  });

  // ─── dau ─────────────────────────────────────────────────────────────────

  it('GET /internal/query?type=dau returns daily unique device count', async () => {
    const res = await fetch(`${base}/internal/query?type=dau&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; dau: { date: string; dau: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('dau');
    const todayRow = body.data.dau.find((r) => r.date === TODAY);
    // Two different device_ids reported → DAU = 2
    expect(todayRow?.dau).toBe(2);
  });

  // ─── ETL + funnel ────────────────────────────────────────────────────────

  it('runFunnelEtl computes today\'s funnel and writes to funnels_daily', async () => {
    await svc.runFunnelEtl(TODAY);
    const rows = await svc.queryFunnel(1);
    // web platform should have four steps: session_start / game_start / level_attempt / level_complete
    const webRows = rows.filter((r) => r.platform === 'web');
    const steps = webRows.map((r) => r.funnel_step);
    expect(steps).toContain('session_start');
    expect(steps).toContain('game_start');
    expect(steps).toContain('level_attempt');
    expect(steps).toContain('level_complete');
    // session_start: 2 devices; level_complete: 1 device (only dev-001 completed)
    const ssRow = webRows.find((r) => r.funnel_step === 'session_start');
    expect(ssRow?.count).toBe(2);
    const lcRow = webRows.find((r) => r.funnel_step === 'level_complete');
    expect(lcRow?.count).toBe(1);
    // conversion rate = 1/2 = 0.5 (game_start → level_attempt → level_complete)
    expect(lcRow?.conversion_rate).toBeCloseTo(1 / 1); // level_attempt→level_complete: 1/1
  });

  it('GET /internal/query?type=funnel reads pre-aggregated funnel data', async () => {
    const res = await fetch(`${base}/internal/query?type=funnel&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { type: string; funnel: { date: string; platform: string; funnel_step: string; count: number }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('funnel');
    expect(body.data.funnel.length).toBeGreaterThan(0);
  });

  it('GET /internal/query?type=funnel&platform=web filters by platform', async () => {
    const res = await fetch(`${base}/internal/query?type=funnel&days=7&platform=web`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { funnel: { platform: string }[] };
    };
    expect(body.data.funnel.every((r) => r.platform === 'web')).toBe(true);
  });

  it('runFunnelEtl idempotent: rerun same day does not change results', async () => {
    await svc.runFunnelEtl(TODAY);
    const rows = await svc.queryFunnel(1);
    const ssRow = rows.find((r) => r.funnel_step === 'session_start' && r.platform === 'web');
    // counts unchanged after rerun
    expect(ssRow?.count).toBe(2);
  });

  // ─── region_dist ─────────────────────────────────────────────────────────

  it('GET /internal/query?type=region_dist returns region distribution', async () => {
    const res = await fetch(`${base}/internal/query?type=region_dist&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; regions: { locale: string; devices: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('region_dist');
    // dev-001=zh, dev-002=en → two locales
    const locales = body.data.regions.map((r) => r.locale).sort();
    expect(locales).toContain('zh');
    expect(locales).toContain('en');
    // sorted by device count descending
    expect(body.data.regions[0].devices).toBeGreaterThanOrEqual(body.data.regions[body.data.regions.length - 1].devices);
  });

  // ─── os_dist ─────────────────────────────────────────────────────────────

  it('GET /internal/query?type=os_dist returns OS distribution', async () => {
    const res = await fetch(`${base}/internal/query?type=os_dist&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; os_dist: { os: string; devices: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('os_dist');
    // dev-001=Windows, dev-002=macOS
    const oses = body.data.os_dist.map((r) => r.os).sort();
    expect(oses).toContain('Windows');
    expect(oses).toContain('macOS');
  });

  // ─── login_hour ──────────────────────────────────────────────────────────

  it('GET /internal/query?type=login_hour returns 24 hour buckets', async () => {
    const res = await fetch(`${base}/internal/query?type=login_hour&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; login_hour: { hour: number; count: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('login_hour');
    // Always returns 24 hour buckets (0-23); hours with data have count > 0
    expect(body.data.login_hour).toHaveLength(24);
    const total = body.data.login_hour.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(2); // two session_start events
    // hour buckets in ascending order
    for (let i = 1; i < 24; i++) {
      expect(body.data.login_hour[i].hour).toBe(i);
    }
  });

  // ─── retention ───────────────────────────────────────────────────────────

  it('GET /internal/query?type=retention returns retention array', async () => {
    const res = await fetch(`${base}/internal/query?type=retention&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        type: string;
        retention: {
          date: string;
          cohort_size: number;
          d: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
          d_rate: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
        }[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('retention');
    // Returns 7 rows (one per day)
    expect(body.data.retention).toHaveLength(7);
    // Today's cohort has 2 devices
    const todayRow = body.data.retention.find((r) => r.date === TODAY);
    expect(todayRow?.cohort_size).toBe(2);
    // Future offsets (D1–D7) are all undefined for today — that data does not exist yet
    for (const n of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(todayRow?.d[n]).toBeUndefined();
      expect(todayRow?.d_rate[n]).toBeUndefined();
    }
  });

  it('queryRetention computes each D1–D7 offset from a backdated cohort', async () => {
    // Anchor far in the past so these events fall outside every other test's real-now window.
    const ANCHOR = Date.UTC(2020, 0, 10); // cohort day-start (UTC midnight)
    const DAY = 86400_000;
    // Insert session_start events directly (acknowledged write concern, unlike ingestEvents' w:0)
    // so they are durable before we query.
    const seeds: { dayOffset: number; device: string }[] = [
      { dayOffset: 0, device: 'ret-A' }, { dayOffset: 0, device: 'ret-B' }, { dayOffset: 0, device: 'ret-C' }, // cohort {A,B,C}
      { dayOffset: 1, device: 'ret-A' }, { dayOffset: 1, device: 'ret-Z1' }, // D1: only A in cohort → 1
      { dayOffset: 2, device: 'ret-A' }, { dayOffset: 2, device: 'ret-B' },  // D2: A + B → 2
      { dayOffset: 3, device: 'ret-Z2' },                                    // D3: activity exists but no cohort member → 0
      { dayOffset: 7, device: 'ret-C' },                                     // D7: C → 1
      // Days +4/+5/+6 have no activity at all → those offsets stay undefined (insufficient data).
    ];
    await mongo!.collections.events.insertMany(
      seeds.map((s) => ({
        session_id: `ret-${s.device}-${s.dayOffset}`,
        device_id: s.device,
        platform: 'web',
        os: 'test',
        game_version: '1',
        locale: 'en',
        event: 'session_start',
        props: {},
        ts: new Date(ANCHOR + s.dayOffset * DAY + 3600_000),
      })),
    );

    // Query with a clock pinned to the anchor day so the cohort day is the sole row.
    const retSvc = new AnalyticsService(mongo!.collections, () => ANCHOR + 12 * 3600_000);
    const rows = await retSvc.queryRetention(1);
    const cohort = rows.find((r) => r.date === '2020-01-10');
    expect(cohort?.cohort_size).toBe(3);
    expect(cohort?.d[1]).toBe(1);
    expect(cohort?.d[2]).toBe(2);
    expect(cohort?.d[3]).toBe(0);
    expect(cohort?.d[4]).toBeUndefined();
    expect(cohort?.d[5]).toBeUndefined();
    expect(cohort?.d[6]).toBeUndefined();
    expect(cohort?.d[7]).toBe(1);
    expect(cohort?.d_rate[1]).toBeCloseTo(1 / 3);
    expect(cohort?.d_rate[2]).toBeCloseTo(2 / 3);
    expect(cohort?.d_rate[3]).toBe(0);
    expect(cohort?.d_rate[7]).toBeCloseTo(1 / 3);
  });

  // ─── first-session / onboarding ────────────────────────────────────────────

  it('queryFirstSession builds the onboarding funnel + action breakdown for new users only', async () => {
    // Anchored in 2021 → isolated from the 2020 retention seed and the 2026 real-now DAU seed.
    const ANCHOR = Date.UTC(2021, 5, 10); // cohort day-start
    const DAY = 86400_000;
    const ev = (sid: string, device: string, event: string, offsetMs: number, scene?: string) => ({
      session_id: sid,
      device_id: device,
      platform: 'web',
      os: 'test',
      game_version: '1',
      locale: 'en',
      event,
      props: scene ? { scene } : {},
      ts: new Date(ANCHOR + offsetMs),
    });

    await mongo!.collections.events.insertMany([
      // N1 — full graduation: reaches every funnel step, plus a shop_open action.
      ev('fs-n1', 'fs-N1', 'session_start', 3600_000),
      ev('fs-n1', 'fs-N1', 'screen_view', 3600_100, 'IntroScene'),
      ev('fs-n1', 'fs-N1', 'tutorial_start', 3600_200),
      ev('fs-n1', 'fs-N1', 'tutorial_complete', 3600_300),
      ev('fs-n1', 'fs-N1', 'screen_view', 3600_400, 'LobbyScene'),
      ev('fs-n1', 'fs-N1', 'game_start', 3600_500),
      ev('fs-n1', 'fs-N1', 'level_complete', 3600_600),
      ev('fs-n1', 'fs-N1', 'shop_open', 3600_700),
      // N2 — drops out mid-tutorial: session_start → intro → tutorial_start, nothing more.
      ev('fs-n2', 'fs-N2', 'session_start', 7200_000),
      ev('fs-n2', 'fs-N2', 'screen_view', 7200_100, 'IntroScene'),
      ev('fs-n2', 'fs-N2', 'tutorial_start', 7200_200),
      // V1 — veteran: first session predates the window (5 days earlier) so must be excluded,
      // even though it is also active in-window.
      ev('fs-v1a', 'fs-V1', 'session_start', -5 * DAY),
      ev('fs-v1b', 'fs-V1', 'session_start', 7200_000),
      ev('fs-v1b', 'fs-V1', 'tutorial_complete', 7200_500),
    ]);

    const fsSvc = new AnalyticsService(mongo!.collections, () => ANCHOR + 12 * 3600_000);
    const res = await fsSvc.queryFirstSession(1);

    // Only N1 + N2 are new in-window; V1 is a returning veteran.
    expect(res.cohort_size).toBe(2);

    // Funnel is built from 100%-sampled events only (no screen_view-derived steps).
    const step = (k: string) => res.funnel.find((f) => f.step === k);
    expect(res.funnel.map((f) => f.step)).toEqual([
      'session_start', 'tutorial_start', 'tutorial_complete', 'first_battle', 'first_clear',
    ]);
    expect(step('session_start')?.count).toBe(2);
    expect(step('tutorial_start')?.count).toBe(2);
    expect(step('tutorial_complete')?.count).toBe(1); // only N1 finished
    expect(step('first_battle')?.count).toBe(1);
    expect(step('first_clear')?.count).toBe(1);
    // Tutorial completion rate = tutorial_complete / tutorial_start = 1/2.
    expect(step('tutorial_complete')?.conversion_rate).toBeCloseTo(0.5);
    expect(step('session_start')?.conversion_rate).toBeUndefined();

    // Action/scene breakdown (distinct new-user devices).
    const act = (k: string) => res.actions.find((a) => a.key === k);
    expect(act('IntroScene')).toMatchObject({ kind: 'scene', devices: 2 });
    expect(act('LobbyScene')).toMatchObject({ kind: 'scene', devices: 1 });
    expect(act('tutorial_start')).toMatchObject({ kind: 'action', devices: 2 });
    expect(act('shop_open')).toMatchObject({ kind: 'action', devices: 1 });
    // Lifecycle noise is never reported as an action.
    expect(act('session_start')).toBeUndefined();
    // Sorted by reach descending.
    expect(res.actions[0].devices).toBeGreaterThanOrEqual(res.actions[res.actions.length - 1].devices);
  });
});
