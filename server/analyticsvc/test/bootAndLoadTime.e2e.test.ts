/**
 * The two queries added 2026-09-20 for the startup blind spot (ANALYTICS_DESIGN §3.6b / §5.1b):
 *
 *   • countBoot / queryBootFunnel — the launch counter written by `GET /analytics/config`, and the
 *     only denominator that includes players who leave at the age or consent gate. Every other query
 *     in this service starts at `session_start`, which those players never reach.
 *   • queryLoadTime — startup-time percentiles per platform, plus the launches that never finished
 *     loading at all.
 *
 * Own database, like service-domains.e2e.test.ts, so it shares no mutable state with the suites that
 * hardcode cross-test totals. Skipped entirely when Mongo is unreachable (same convention).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsMongo, type AnalyticsMongo, type EventDoc } from '../src/db';
import { AnalyticsService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_analytics_test_boot';

async function tryConnect(): Promise<AnalyticsMongo | null> {
  try {
    return await createAnalyticsMongo(URI, DB);
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[analyticsvc.boot.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('launch counter + load time', () => {
  let svc: AnalyticsService;

  beforeAll(async () => {
    await mongo!.ensureIndexes();
    await mongo!.db.dropDatabase();
    await mongo!.ensureIndexes();
    svc = new AnalyticsService(mongo!.collections);
  });

  afterAll(async () => {
    await mongo!.db.dropDatabase();
    await mongo!.close();
  });

  function evDoc(sid: string, event: string, props: Record<string, unknown> = {}, platform = 'web'): EventDoc {
    return {
      session_id: sid,
      device_id: `dev-${sid}`,
      platform,
      os: 'test',
      game_version: '1',
      locale: 'en',
      event,
      props,
      ts: new Date(),
    };
  }

  // ─── countBoot / queryBootFunnel ───────────────────────────────────────────

  describe('countBoot', () => {
    it('accumulates into one document per (date, platform) and stores nothing else', async () => {
      await svc.countBoot('web');
      await svc.countBoot('web');
      await svc.countBoot('wechat');

      const docs = await mongo!.collections.boots_daily.find({}).toArray();
      expect(docs).toHaveLength(2);
      const web = docs.find((d) => d.platform === 'web')!;
      expect(web.count).toBe(2);
      // The privacy contract of this collection: a date, a build target, a number. Anything else
      // here would be data collected before the player was asked anything.
      expect(Object.keys(web).sort()).toEqual(['_id', 'count', 'date', 'platform', 'updated_at']);
    });

    it('runs concurrently without losing counts (upsert on a composite _id, not read-modify-write)', async () => {
      await mongo!.collections.boots_daily.deleteMany({});
      await Promise.all(Array.from({ length: 25 }, () => svc.countBoot('crazygames')));
      const doc = await mongo!.collections.boots_daily.findOne({ platform: 'crazygames' });
      expect(doc?.count).toBe(25);
    });
  });

  describe('queryBootFunnel', () => {
    it('puts launches next to the sessions and consents that came out of them', async () => {
      await mongo!.collections.boots_daily.deleteMany({});
      await mongo!.collections.events.deleteMany({});
      for (let i = 0; i < 10; i++) await svc.countBoot('web');
      await mongo!.collections.events.insertMany([
        evDoc('s1', 'session_start'),
        evDoc('s2', 'session_start'),
        evDoc('s3', 'session_start'),
        evDoc('s3', 'gdpr_consent'),
      ]);

      const rows = await svc.queryBootFunnel(7);
      const web = rows.find((r) => r.platform === 'web')!;
      expect(web).toMatchObject({ boots: 10, sessions: 3, consents: 1 });
      expect(web.reach_rate).toBeCloseTo(0.3);
    });

    it('still reports a day whose launches produced NO sessions — the worst case is the point', async () => {
      await mongo!.collections.boots_daily.deleteMany({});
      await mongo!.collections.events.deleteMany({});
      await svc.countBoot('wechat');
      await svc.countBoot('wechat');

      const rows = await svc.queryBootFunnel(7);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ platform: 'wechat', boots: 2, sessions: 0, consents: 0, reach_rate: 0 });
    });

    it('reports sessions with no counted launch too, rather than hiding half the picture', async () => {
      // Happens legitimately: an older client build does not send `?p=`, or the counter write failed.
      await mongo!.collections.boots_daily.deleteMany({});
      await mongo!.collections.events.deleteMany({});
      await mongo!.collections.events.insertOne(evDoc('s9', 'session_start'));

      const rows = await svc.queryBootFunnel(7);
      expect(rows[0]).toMatchObject({ boots: 0, sessions: 1 });
      expect(rows[0].reach_rate).toBeUndefined(); // no denominator → no rate invented
    });

    it('is empty outside the window', async () => {
      const farFuture = Date.now() + 400 * 86400_000;
      const futureSvc = new AnalyticsService(mongo!.collections, () => farFuture);
      expect(await futureSvc.queryBootFunnel(1)).toEqual([]);
    });
  });

  // ─── queryLoadTime ─────────────────────────────────────────────────────────

  describe('queryLoadTime', () => {
    beforeAll(async () => {
      await mongo!.collections.events.deleteMany({});
      const docs: EventDoc[] = [];
      // 10 web launches at 100ms..1000ms, each with its phase breakdown.
      for (let i = 1; i <= 10; i++) {
        docs.push(evDoc(`lt-web-${i}`, 'boot'));
        docs.push(evDoc(`lt-web-${i}`, 'load_time', {
          total_ms: i * 100,
          to_script_ms: 50,
          renderer_ms: 10,
          preload_ms: i * 10,
        }));
      }
      // Two web launches that gave up while loading: boot, no load_time.
      docs.push(evDoc('lt-web-gone-1', 'boot'), evDoc('lt-web-gone-2', 'boot'));
      // One WeChat launch, which reports no network phase at all.
      docs.push(evDoc('lt-wx-1', 'boot', {}, 'wechat'));
      docs.push(evDoc('lt-wx-1', 'load_time', { total_ms: 2000, preload_ms: 900 }, 'wechat'));
      await mongo!.collections.events.insertMany(docs);
    });

    it('reports percentiles off the histogram, rounded up to the bucket the value falls in', async () => {
      const web = (await svc.queryLoadTime(7)).find((r) => r.platform === 'web')!;
      expect(web.samples).toBe(10);
      // Values 100..1000 in 100ms buckets: the 5th of ten is 500ms, the 9th is 900ms.
      expect(web.p50_ms).toBe(500);
      expect(web.p90_ms).toBe(900);
      expect(web.p95_ms).toBe(1000);
    });

    it('averages each phase over the launches that actually reported it', async () => {
      const rows = await svc.queryLoadTime(7);
      const web = rows.find((r) => r.platform === 'web')!;
      expect(web.avg.to_script_ms).toBe(50);
      expect(web.avg.preload_ms).toBe(55); // mean of 10,20,…,100

      // WeChat has no navigation timing, so the phase must be ABSENT rather than averaged in as 0 —
      // a 0 would read as "startup there costs no network time", which is a different claim.
      const wx = rows.find((r) => r.platform === 'wechat')!;
      expect(wx.avg.to_script_ms).toBeUndefined();
      expect(wx.avg.preload_ms).toBe(900);
    });

    it('counts the launches that emitted boot and never finished loading', async () => {
      const rows = await svc.queryLoadTime(7);
      expect(rows.find((r) => r.platform === 'web')!.abandoned).toBe(2);
      expect(rows.find((r) => r.platform === 'wechat')!.abandoned).toBe(0);
    });

    it('hands the ops page a histogram, not just the percentiles', async () => {
      const web = (await svc.queryLoadTime(7)).find((r) => r.platform === 'web')!;
      expect(web.buckets[0]).toEqual({ lt_ms: 100, count: 1 });
      expect(web.buckets.reduce((s, b) => s + b.count, 0)).toBe(10);
      expect(web.buckets.map((b) => b.lt_ms)).toEqual([...web.buckets.map((b) => b.lt_ms)].sort((a, b) => a - b));
    });

    it('still reports a platform where every single launch was abandoned', async () => {
      await mongo!.collections.events.insertOne(evDoc('lt-cg-1', 'boot', {}, 'crazygames'));
      const cg = (await svc.queryLoadTime(7)).find((r) => r.platform === 'crazygames')!;
      expect(cg).toMatchObject({ samples: 0, abandoned: 1, p50_ms: 0 });
    });

    it('ignores a load_time whose total is not a number', async () => {
      await mongo!.collections.events.insertOne(evDoc('lt-bad', 'load_time', { total_ms: 'soon' }));
      const web = (await svc.queryLoadTime(7)).find((r) => r.platform === 'web')!;
      expect(web.samples).toBe(10);
    });
  });
});
