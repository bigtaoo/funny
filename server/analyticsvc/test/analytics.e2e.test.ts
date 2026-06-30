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
      data: { type: string; retention: { date: string; cohort_size: number; d1?: number; d7?: number }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('retention');
    // Returns 7 rows (one per day)
    expect(body.data.retention).toHaveLength(7);
    // Today's cohort has 2 devices
    const todayRow = body.data.retention.find((r) => r.date === TODAY);
    expect(todayRow?.cohort_size).toBe(2);
    // D7 for today = undefined (future data does not exist yet)
    expect(todayRow?.d7).toBeUndefined();
  });
});
