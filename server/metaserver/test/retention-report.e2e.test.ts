// Consent-free server retention report e2e (real Mongo): activityDays.ts's write filter + pipeline, the
// bearerAuth → recorder wiring in buildApp, and GET /internal/retention's aggregation (cohort grouping,
// tutorial / cleared counts, dK = K in activeDays, null for windows still open, and the exclusions:
// objected (gdprConsent false), soft-deleted, purged, bot accounts).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeNewSave, signToken, type AccountDoc, type MongoHandle } from '@nw/shared';
import { buildApp } from '../src/app.js';
import { ActivityRecorder, DAY_MS } from '../src/activityDays.js';
import { clampRetentionDays, retentionReport, retentionWindowClosed } from '../src/retentionReport.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_retention_report_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[retention-report.e2e] Mongo unreachable (${URI}) — skipping.`);

// "Now" is mid-day UTC on 2026-10-07; day index helpers keep the fixtures readable.
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const TODAY0 = Math.floor(NOW / DAY_MS) * DAY_MS; // 2026-10-07T00:00Z
const dayStart = (daysAgo: number) => TODAY0 - daysAgo * DAY_MS;

describe('clampRetentionDays / retentionWindowClosed', () => {
  it('days: default 30, floor 1, cap 90', () => {
    expect(clampRetentionDays(undefined)).toBe(30);
    expect(clampRetentionDays('abc')).toBe(30);
    expect(clampRetentionDays('0')).toBe(30);
    expect(clampRetentionDays('7')).toBe(7);
    expect(clampRetentionDays('500')).toBe(90);
  });

  it('dK is final only once dayStart + (K+2) days has passed', () => {
    const day = Math.floor(dayStart(2) / DAY_MS);
    expect(retentionWindowClosed(day, 1, dayStart(2) + 3 * DAY_MS - 1)).toBe(false);
    expect(retentionWindowClosed(day, 1, dayStart(2) + 3 * DAY_MS)).toBe(true);
  });
});

describe.skipIf(!mongo)('consent-free retention e2e', () => {
  const m = mongo!;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  async function seed(id: string, createdAt: number, extra: Partial<AccountDoc> = {}, save?: { tutorial?: boolean; cleared?: string[] }) {
    await m.collections.accounts.insertOne({ _id: id, createdAt, deviceId: `uuid-${id}`, ...extra });
    if (save) {
      const s = makeNewSave(id, createdAt);
      if (save.tutorial) s.flags.tutorial_done = true;
      s.progress.cleared = save.cleared ?? [];
      await m.collections.saves.insertOne({ _id: id, save: s, rev: s.rev });
    }
  }
  const activeDaysOf = async (id: string) => (await m.collections.accounts.findOne({ _id: id }))?.activeDays;

  describe('ActivityRecorder against Mongo', () => {
    it('unions the current 24h-window offset into activeDays, once per window', async () => {
      const created = NOW - 3 * DAY_MS - 3600_000; // offset 3 at NOW
      await seed('a', created, { activeDays: [0] });
      let t = NOW;
      const rec = new ActivityRecorder(m.collections, () => t);
      await rec.record('a');
      expect([...(await activeDaysOf('a'))!].sort()).toEqual([0, 3]);
      await rec.record('a'); // deduped, still the same
      t = NOW + DAY_MS;
      await rec.record('a');
      expect([...(await activeDaysOf('a'))!].sort((x, y) => x - y)).toEqual([0, 3, 4]);
      // A second process recording the same window must not duplicate the entry ($setUnion).
      await new ActivityRecorder(m.collections, () => t).record('a');
      expect([...(await activeDaysOf('a'))!].sort((x, y) => x - y)).toEqual([0, 3, 4]);
    });

    it('creates activeDays on first activity (offset 0)', async () => {
      await seed('fresh', NOW - 60_000);
      await new ActivityRecorder(m.collections, () => NOW).record('fresh');
      expect(await activeDaysOf('fresh')).toEqual([0]);
    });

    it('records nothing for objected, too-old (>30 days), deleted, purged and bot accounts', async () => {
      await seed('objected', NOW - DAY_MS, { flags: { gdprConsent: false } });
      await seed('old', NOW - 31 * DAY_MS - 1);
      await seed('deleted', NOW - DAY_MS, { deletedAt: NOW - 1000 });
      await seed('purged', NOW - DAY_MS, { deletedAt: NOW - 9 * DAY_MS, purgedAt: NOW - 1000 });
      await seed('bot', NOW - DAY_MS, { deviceId: 'bot-0001' });
      const rec = new ActivityRecorder(m.collections, () => NOW);
      for (const id of ['objected', 'old', 'deleted', 'purged', 'bot']) {
        await rec.record(id);
        expect(await activeDaysOf(id), id).toBeUndefined();
      }
    });

    it('offset 30 is still recorded (D30)', async () => {
      await seed('d30', NOW - 30 * DAY_MS - 1000);
      await new ActivityRecorder(m.collections, () => NOW).record('d30');
      expect(await activeDaysOf('d30')).toEqual([30]);
    });
  });

  it('buildApp records activity on authenticated requests by default', async () => {
    await seed('acc', NOW - DAY_MS - 1000, {}, {});
    const app = await buildApp({ cols: m.collections, jwt: { secret: 's' }, internalKey: 'k', commercialUrl: null, gatewayUrl: null, now: () => NOW });
    try {
      const res = await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${signToken('acc', { secret: 's' })}` } });
      expect(res.statusCode).toBe(200);
      // Fire-and-forget: poll briefly for the background write.
      for (let i = 0; i < 50 && !(await activeDaysOf('acc')); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await activeDaysOf('acc')).toEqual([1]);
    } finally {
      await app.close();
    }
  });

  describe('GET /internal/retention', () => {
    it('401 without the internal key', async () => {
      const app = await buildApp({ cols: m.collections, jwt: { secret: 's' }, internalKey: 'k', commercialUrl: null, gatewayUrl: null, now: () => NOW, activity: null });
      try {
        expect((await app.inject({ method: 'GET', url: '/internal/retention' })).statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('groups by UTC signup day, counts saves + activeDays, nulls open windows, honours exclusions', async () => {
      // Cohort 40 days ago: every column is final.
      const c40 = dayStart(40);
      await seed('o1', c40 + 1000, { activeDays: [0, 1, 3, 7, 14, 30] }, { tutorial: true, cleared: ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'] });
      await seed('o2', c40 + 23 * 3600_000, { activeDays: [0, 1] }, { tutorial: true, cleared: ['ch1_lv1'] });
      await seed('o3', c40 + 5000, {}, { tutorial: false }); // pre-feature account: no activeDays at all
      await seed('o4', c40 + 6000); // no save row
      // Excluded from every count, including signups.
      await seed('x-objected', c40 + 7000, { flags: { gdprConsent: false }, activeDays: [1] }, { tutorial: true });
      await seed('x-deleted', c40 + 8000, { deletedAt: NOW - DAY_MS, activeDays: [1] });
      await seed('x-purged', c40 + 9000, { deletedAt: NOW - 9 * DAY_MS, purgedAt: NOW - DAY_MS });
      await seed('x-bot', c40 + 9500, { deviceId: 'bot-0042', activeDays: [1] }, { tutorial: true });
      // Cohort 2 days ago: D1 final (dayStart + 3d <= NOW is false → 2 days ago + 3 = tomorrow) → still null.
      // Cohort 3 days ago: D1 final, D3 not yet.
      await seed('y1', dayStart(3) + 1000, { activeDays: [0, 1] }, { tutorial: true, cleared: ['ch1_lv1'] });
      await seed('y2', dayStart(2) + 1000, { activeDays: [0, 1] });
      // Today.
      await seed('t1', NOW - 1000, { activeDays: [0] });
      // Outside the 45-day window.
      await seed('ancient', dayStart(60), { activeDays: [1] });

      const app = await buildApp({ cols: m.collections, jwt: { secret: 's' }, internalKey: 'k', commercialUrl: null, gatewayUrl: null, now: () => NOW, activity: null });
      try {
        const res = await app.inject({ method: 'GET', url: '/internal/retention?days=45', headers: { 'x-internal-key': 'k' } });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.days).toBe(45);
        const cohorts = body.cohorts as { date: string; signups: number; tutorialDone: number; cleared: Record<string, number>; retained: Record<string, number | null> }[];
        expect(cohorts).toHaveLength(45);
        expect(cohorts[0]!.date).toBe('2026-10-07'); // newest first
        expect(cohorts[44]!.date).toBe(new Date(dayStart(44)).toISOString().slice(0, 10));
        const byDate = new Map(cohorts.map((c) => [c.date, c]));
        const at = (daysAgo: number) => byDate.get(new Date(dayStart(daysAgo)).toISOString().slice(0, 10))!;

        expect(at(40)).toEqual({
          date: '2026-08-28',
          signups: 4,
          tutorialDone: 2,
          cleared: { ch1_lv1: 2, ch1_lv2: 1, ch1_lv3: 1 },
          retained: { d1: 2, d3: 1, d7: 1, d14: 1, d30: 1 },
        });
        expect(at(3)).toEqual({
          date: new Date(dayStart(3)).toISOString().slice(0, 10),
          signups: 1,
          tutorialDone: 1,
          cleared: { ch1_lv1: 1, ch1_lv2: 0, ch1_lv3: 0 },
          retained: { d1: 1, d3: null, d7: null, d14: null, d30: null },
        });
        // Two days ago: some member's window 1 may still be open until tomorrow 00:00 → null.
        expect(at(2).signups).toBe(1);
        expect(at(2).retained.d1).toBeNull();
        expect(at(0)).toMatchObject({ signups: 1, retained: { d1: null, d3: null, d7: null, d14: null, d30: null } });
        // A day without signups is present with zeros (final windows) / nulls (open ones).
        expect(at(20)).toEqual({
          date: new Date(dayStart(20)).toISOString().slice(0, 10),
          signups: 0,
          tutorialDone: 0,
          cleared: { ch1_lv1: 0, ch1_lv2: 0, ch1_lv3: 0 },
          retained: { d1: 0, d3: 0, d7: 0, d14: 0, d30: null },
        });
        expect(cohorts.reduce((n, c) => n + c.signups, 0)).toBe(7);
      } finally {
        await app.close();
      }
    });

    it('defaults to 30 days', async () => {
      const cohorts = await retentionReport(m.collections, NOW, clampRetentionDays(undefined));
      expect(cohorts).toHaveLength(30);
    });
  });
});
