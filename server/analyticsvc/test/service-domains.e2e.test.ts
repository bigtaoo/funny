// analyticsvc end-to-end (server-test-audit-2026-08-05 backlog): covers the query/write paths that
// analytics.e2e.test.ts left untouched after the 2026-08-02 service.ts → service/*.ts split:
//   • funnel.ts:  queryTutorialFunnel / querySceneFunnel / queryLevelFunnel
//   • dist.ts:    queryBrowserDist / queryDeviceTypeDist / queryGeoDist
//   • ingest.ts:  the sessions-collection write path (session_start upsert / session_end update)
// Uses its own dedicated database so it never races or shares mutable state with analytics.e2e.test.ts
// (which reuses one DB and hardcodes cross-test totals against `dev-001`/`dev-002`).
// Entire suite is skipped when Mongo is unreachable (same convention as analytics.e2e.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsMongo, type AnalyticsMongo, type EventDoc } from '../src/db';
import { AnalyticsService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_analytics_test_domains';

async function tryConnect(): Promise<AnalyticsMongo | null> {
  try {
    return await createAnalyticsMongo(URI, DB);
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[analyticsvc.service-domains.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('analyticsvc service domains (funnel / dist / sessions write path)', () => {
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

  /** Minimal raw event doc builder — every event timestamped "now" (or now+offsetMs) so it lands
   * inside a `days=7` (or `days=1`) real-clock query window without needing a pinned `now()`. */
  function evDoc(sid: string, device: string, event: string, props: Record<string, unknown> = {}, offsetMs = 0): EventDoc {
    return {
      session_id: sid,
      device_id: device,
      platform: 'web',
      os: 'test',
      game_version: '1',
      locale: 'en',
      event,
      props,
      ts: new Date(Date.now() + offsetMs),
    };
  }

  // ─── queryTutorialFunnel ───────────────────────────────────────────────────

  describe('queryTutorialFunnel', () => {
    it('computes per-step cohort counts and conversion rates from tutorial_step events', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('tut-a', 'dev-tut-a', 'tutorial_start'),
        evDoc('tut-a', 'dev-tut-a', 'tutorial_step', { step_key: 'orientation_1' }, 100),
        evDoc('tut-a', 'dev-tut-a', 'tutorial_step', { step_key: 'orientation_2' }, 200),
        evDoc('tut-a', 'dev-tut-a', 'tutorial_complete', {}, 300),
        // B only starts the tutorial — everything downstream of tutorial_start stays at 0 for B.
        evDoc('tut-b', 'dev-tut-b', 'tutorial_start'),
      ]);

      const res = await svc.queryTutorialFunnel(7);
      const step = (k: string) => res.funnel.find((f) => f.step === k);

      expect(res.cohort_size).toBe(2);
      expect(step('tutorial_start')?.count).toBe(2);
      expect(step('orientation_1')?.count).toBe(1);
      expect(step('orientation_2')?.count).toBe(1);
      expect(step('orientation_3')?.count).toBe(0);
      expect(step('beat_unit')?.count).toBe(0);
      expect(step('freeplay')?.count).toBe(0);
      expect(step('tutorial_complete')?.count).toBe(1);

      // conversion_rate = count / immediately-preceding step's count.
      expect(step('tutorial_start')?.conversion_rate).toBeUndefined(); // first step, no predecessor
      expect(step('orientation_1')?.conversion_rate).toBeCloseTo(1 / 2);
      expect(step('orientation_2')?.conversion_rate).toBeCloseTo(1 / 1);
      expect(step('orientation_3')?.conversion_rate).toBeCloseTo(0); // 0/1, still defined (predecessor > 0)
      // freeplay's predecessor count is 0, so every step chained after another 0-count step reports
      // conversion_rate undefined (division only defined when the previous step's count > 0) — this
      // includes tutorial_complete itself, even though 1 session did complete the tutorial.
      expect(step('tutorial_complete')?.conversion_rate).toBeUndefined();
    });

    it('returns a zero-filled funnel with cohort_size 0 when no tutorial_start falls in the window', async () => {
      // Anchor the query clock far in the future so `since` excludes every event inserted "now" above.
      const farFuture = Date.now() + 400 * 86400_000;
      const futureSvc = new AnalyticsService(mongo!.collections, () => farFuture);
      const res = await futureSvc.queryTutorialFunnel(1);
      expect(res.cohort_size).toBe(0);
      expect(res.funnel.length).toBeGreaterThan(0);
      expect(res.funnel.every((f) => f.count === 0)).toBe(true);
      expect(res.funnel.every((f) => f.conversion_rate === undefined)).toBe(true);
    });
  });

  // ─── querySceneFunnel ──────────────────────────────────────────────────────

  describe('querySceneFunnel', () => {
    it('computes per-scene cohort counts from nav_checkpoint events, cohort = all session_start sessions', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('scn-a', 'dev-scn-a', 'session_start'),
        evDoc('scn-a', 'dev-scn-a', 'nav_checkpoint', { scene: 'LoginScene' }, 50),
        evDoc('scn-a', 'dev-scn-a', 'nav_checkpoint', { scene: 'IntroScene' }, 100),
        evDoc('scn-a', 'dev-scn-a', 'nav_checkpoint', { scene: 'LobbyScene' }, 150),
        evDoc('scn-b', 'dev-scn-b', 'session_start'),
        evDoc('scn-b', 'dev-scn-b', 'nav_checkpoint', { scene: 'LoginScene' }, 50),
      ]);

      const res = await svc.querySceneFunnel(7);
      const step = (k: string) => res.funnel.find((f) => f.step === k);

      expect(res.cohort_size).toBe(2); // both sessions had a session_start in-window
      expect(step('LoginScene')?.count).toBe(2);
      expect(step('LoginScene')?.conversion_rate).toBeUndefined(); // first scene step, no predecessor
      expect(step('IntroScene')?.count).toBe(1);
      expect(step('IntroScene')?.conversion_rate).toBeCloseTo(1 / 2);
      expect(step('LobbyScene')?.count).toBe(1);
      expect(step('CampaignMapScene')?.count).toBe(0);
      expect(step('GameScene')?.count).toBe(0);
    });

    it('screen_view events with a matching scene also count (both event types feed the scene set)', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('scn-c', 'dev-scn-c', 'session_start'),
        evDoc('scn-c', 'dev-scn-c', 'screen_view', { scene: 'CampaignMapScene' }, 50),
      ]);
      const res = await svc.querySceneFunnel(7);
      const step = (k: string) => res.funnel.find((f) => f.step === k);
      expect(step('CampaignMapScene')!.count).toBeGreaterThanOrEqual(1);
    });

    it('returns a zero-filled funnel with cohort_size 0 when no session_start falls in the window', async () => {
      const farFuture = Date.now() + 400 * 86400_000;
      const futureSvc = new AnalyticsService(mongo!.collections, () => farFuture);
      const res = await futureSvc.querySceneFunnel(1);
      expect(res.cohort_size).toBe(0);
      expect(res.funnel.every((f) => f.count === 0)).toBe(true);
    });
  });

  // ─── queryLevelFunnel ──────────────────────────────────────────────────────

  describe('queryLevelFunnel', () => {
    it('aggregates distinct-device attempts/completes/abandons per level_id, sorted by completion rate ascending', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('lvl-1', 'dev-lvl-1', 'level_attempt', { level_id: 'L1' }),
        evDoc('lvl-2', 'dev-lvl-2', 'level_attempt', { level_id: 'L1' }),
        evDoc('lvl-3', 'dev-lvl-3', 'level_attempt', { level_id: 'L1' }),
        evDoc('lvl-1', 'dev-lvl-1', 'level_complete', { level_id: 'L1' }, 10),
        evDoc('lvl-2', 'dev-lvl-2', 'level_complete', { level_id: 'L1' }, 10),
        evDoc('lvl-3', 'dev-lvl-3', 'level_abandon', { level_id: 'L1' }, 10),
        evDoc('lvl-1', 'dev-lvl-1', 'level_attempt', { level_id: 'L2' }, 20),
        evDoc('lvl-1', 'dev-lvl-1', 'level_complete', { level_id: 'L2' }, 30),
      ]);

      const rows = await svc.queryLevelFunnel(7);
      const l1 = rows.find((r) => r.level_id === 'L1');
      const l2 = rows.find((r) => r.level_id === 'L2');

      expect(l1).toMatchObject({ attempts: 3, completes: 2, abandons: 1 });
      expect(l1?.completion_rate).toBeCloseTo(2 / 3);
      expect(l2).toMatchObject({ attempts: 1, completes: 1, abandons: 0 });
      expect(l2?.completion_rate).toBeCloseTo(1);

      // Sorted ascending by completion_rate: L1 (0.667) must appear before L2 (1.0).
      const i1 = rows.findIndex((r) => r.level_id === 'L1');
      const i2 = rows.findIndex((r) => r.level_id === 'L2');
      expect(i1).toBeLessThan(i2);
    });

    it('filters by platform', async () => {
      await mongo!.collections.events.insertMany([
        { ...evDoc('lvl-p1', 'dev-lvl-p1', 'level_attempt', { level_id: 'LP' }), platform: 'wechat' },
        { ...evDoc('lvl-p2', 'dev-lvl-p2', 'level_attempt', { level_id: 'LP' }), platform: 'web' },
      ]);
      const webRows = await svc.queryLevelFunnel(7, 'web');
      expect(webRows.find((r) => r.level_id === 'LP')?.attempts).toBe(1);
    });
  });

  // ─── browser / device-type / geo distributions ────────────────────────────

  describe('browser / device-type / geo distributions', () => {
    it('buckets session_start events by server-derived browser, device type, and IP-derived geo country', async () => {
      const CHROME_DESKTOP_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const FIREFOX_MOBILE_UA = 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/115.0';
      const SAFARI_TABLET_UA =
        'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';

      await svc.ingestEvents(
        {
          session_id: 'sess-dist-1', device_id: 'dev-dist-1', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          ua: CHROME_DESKTOP_UA,
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
        { country: 'US' },
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-dist-2', device_id: 'dev-dist-2', platform: 'web', os: 'Android', game_version: '1', locale: 'en',
          ua: FIREFOX_MOBILE_UA,
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
        { country: 'DE' },
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-dist-3', device_id: 'dev-dist-3', platform: 'web', os: 'iOS', game_version: '1', locale: 'en',
          ua: SAFARI_TABLET_UA,
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
        { country: 'US' },
      );

      const [browserDist, deviceDist, geoDist] = await Promise.all([
        svc.queryBrowserDist(7),
        svc.queryDeviceTypeDist(7),
        svc.queryGeoDist(7),
      ]);

      expect(browserDist.find((r) => r.browser === 'chrome')?.devices).toBe(1);
      expect(browserDist.find((r) => r.browser === 'firefox')?.devices).toBe(1);
      expect(browserDist.find((r) => r.browser === 'safari')?.devices).toBe(1);

      expect(deviceDist.find((r) => r.device_type === 'desktop')?.devices).toBe(1);
      expect(deviceDist.find((r) => r.device_type === 'mobile')?.devices).toBe(1);
      expect(deviceDist.find((r) => r.device_type === 'tablet')?.devices).toBe(1);

      expect(geoDist.find((r) => r.country === 'US')?.devices).toBe(2);
      expect(geoDist.find((r) => r.country === 'DE')?.devices).toBe(1);
      // sorted descending by device count
      expect(geoDist[0].devices).toBeGreaterThanOrEqual(geoDist[geoDist.length - 1].devices);
    });

    it('a device without a session_start event (or without a ua) is not double counted / falls into the unknown bucket', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-dist-4', device_id: 'dev-dist-4', platform: 'web', os: 'Linux', game_version: '1', locale: 'en',
          // no `ua` supplied — browser/device_type fields are omitted entirely at ingest (see ingest.ts).
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      const browserDist = await svc.queryBrowserDist(7);
      const unknown = browserDist.find((r) => r.browser === 'unknown');
      expect(unknown).toBeDefined();
      expect(unknown!.devices).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── sessions collection write path (ingestEvents) ────────────────────────

  describe('sessions collection write path', () => {
    it('a session_start event upserts a sessions doc with derived browser/device_type/geo fields', async () => {
      const startTs = Date.now();
      const ua =
        'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36';
      await svc.ingestEvents(
        {
          session_id: 'sess-write-1', device_id: 'dev-write-1', platform: 'web', os: 'Android', game_version: '1', locale: 'zh',
          ua, screen_w: 412, screen_h: 915, dpr: 2.6,
          events: [{ event: 'session_start', ts: startTs }],
        },
        'acc-write-1',
        { ip: '1.2.3.4', country: 'CN', region: 'GD', city: 'Shenzhen' },
      );

      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-1' });
      expect(doc).toBeTruthy();
      expect(doc?.user_id).toBe('acc-write-1');
      expect(doc?.device_id).toBe('dev-write-1');
      expect(doc?.platform).toBe('web');
      expect(doc?.os).toBe('Android');
      expect(doc!.started_at.getTime()).toBeCloseTo(startTs, -2);
      expect(doc?.scenes_visited).toEqual([]);
      expect(doc?.events_count).toBe(1);
      expect(doc?.ua).toBe(ua);
      expect(doc?.screen_w).toBe(412);
      expect(doc?.screen_h).toBe(915);
      expect(doc?.dpr).toBeCloseTo(2.6);
      expect(doc?.browser).toBe('chrome');
      expect(doc?.device_type).toBe('mobile');
      expect(doc?.ip).toBe('1.2.3.4');
      expect(doc?.geo_country).toBe('CN');
      expect(doc?.geo_region).toBe('GD');
      expect(doc?.geo_city).toBe('Shenzhen');
    });

    it('fields absent from the batch (no ua/geo) are omitted from the sessions doc entirely, not stored as undefined', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-bare', device_id: 'dev-write-bare', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-bare' });
      expect(doc).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(doc, 'ua')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(doc, 'browser')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(doc, 'device_type')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(doc, 'geo_country')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(doc, 'ip')).toBe(false);
    });

    // Real-bug documentation (see final report): events_count is only $inc'd inside the
    // `if (sessionStart && batch.session_id)` branch of ingestEvents (src/service/ingest.ts). A batch
    // that doesn't itself carry a session_start event never touches events_count, even though its
    // events were durably inserted into the `events` collection. In real traffic a session normally
    // sends its session_start once and several more event-only batches afterwards, so events_count
    // ends up permanently stuck at whatever the first (session_start) batch's event count was.
    it('events_count only accumulates on batches that carry a session_start event (documents current, likely-unintended behavior)', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-2', device_id: 'dev-write-2', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'session_start', ts: Date.now() },
            { event: 'screen_view', ts: Date.now() + 1 },
          ], // 2 events in the session_start batch
        },
        undefined,
      );
      let doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-2' });
      expect(doc?.events_count).toBe(2);

      // A second, later batch for the same session with no session_start — 3 more real events land in
      // the `events` collection, but events_count on the sessions doc is not touched.
      await svc.ingestEvents(
        {
          session_id: 'sess-write-2', device_id: 'dev-write-2', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'ui_click', ts: Date.now() + 100 },
            { event: 'ui_click', ts: Date.now() + 200 },
            { event: 'screen_view', ts: Date.now() + 300 },
          ],
        },
        undefined,
      );
      doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-2' });
      expect(doc?.events_count).toBe(2); // unchanged — the follow-up batch had no session_start

      const totalEventsForSession = await mongo!.collections.events.countDocuments({ session_id: 'sess-write-2' });
      expect(totalEventsForSession).toBe(5); // all 5 raw events were inserted, just not reflected in events_count
    });

    it('a session_end event sets ended_at/duration_sec/scenes_visited on the existing sessions doc', async () => {
      const startTs = Date.now();
      await svc.ingestEvents(
        {
          session_id: 'sess-write-3', device_id: 'dev-write-3', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: startTs }],
        },
        undefined,
      );
      const endTs = startTs + 60_000;
      await svc.ingestEvents(
        {
          session_id: 'sess-write-3', device_id: 'dev-write-3', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_end', ts: endTs, props: { duration_sec: 60, scenes_visited: ['LobbyScene', 'GameScene'] } }],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-3' });
      expect(doc?.ended_at?.getTime()).toBeCloseTo(endTs, -2);
      expect(doc?.duration_sec).toBe(60);
      expect(doc?.scenes_visited).toEqual(['LobbyScene', 'GameScene']);
    });

    it('a session_end with malformed props (non-number duration, non-array scenes_visited) is ignored, not stored as garbage', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-4', device_id: 'dev-write-4', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-write-4', device_id: 'dev-write-4', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_end', ts: Date.now() + 1000, props: { duration_sec: 'not-a-number', scenes_visited: 'not-an-array' } }],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-4' });
      expect(doc?.ended_at).toBeInstanceOf(Date); // ended_at is always set
      expect(doc?.duration_sec).toBeUndefined();
      expect(doc?.scenes_visited).toEqual([]); // left at its $setOnInsert default, never overwritten with garbage
    });

    it('an empty session_id never creates a sessions document, even with a session_start event', async () => {
      await svc.ingestEvents(
        {
          session_id: '', device_id: 'dev-write-5', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      const count = await mongo!.collections.sessions.countDocuments({ device_id: 'dev-write-5' });
      expect(count).toBe(0);
    });
  });
});
