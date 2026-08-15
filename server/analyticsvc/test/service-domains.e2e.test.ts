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
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
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

    // funnel.ts: completion_rate is undefined when a level has 0 attempts (only complete/abandon events
    // exist for it, e.g. an attempt event that fell outside the sampling/window) — and the sort
    // comparator's `?? 1` fallback must treat it as a 1.0 (not crash on `undefined - number`, and not
    // spuriously sort it first as if it were a 0% completion rate).
    it('a level with 0 attempts (only complete/abandon events) has completion_rate undefined and does not break the ascending sort', async () => {
      await mongo!.collections.events.insertMany([
        // L-ZERO / L-ZERO-2: two levels with no level_attempt at all, only a complete — attempts stays 0
        // for both, so the sort comparator's `?? 1` fallback runs on both sides of at least one
        // comparison (a-side and b-side), not just one.
        evDoc('lvl-zero', 'dev-lvl-zero', 'level_complete', { level_id: 'L-ZERO' }),
        evDoc('lvl-zero-2', 'dev-lvl-zero-2', 'level_complete', { level_id: 'L-ZERO-2' }),
        // L-LOW: a real, lower-than-1.0 completion rate to anchor the ordering check below.
        evDoc('lvl-low-1', 'dev-lvl-low-1', 'level_attempt', { level_id: 'L-LOW' }),
        evDoc('lvl-low-2', 'dev-lvl-low-2', 'level_attempt', { level_id: 'L-LOW' }),
        evDoc('lvl-low-1', 'dev-lvl-low-1', 'level_complete', { level_id: 'L-LOW' }, 10),
        // A couple more varied real rates so the sort exercises enough distinct pairwise comparisons.
        evDoc('lvl-mid-1', 'dev-lvl-mid-1', 'level_attempt', { level_id: 'L-MID' }),
        evDoc('lvl-mid-2', 'dev-lvl-mid-2', 'level_attempt', { level_id: 'L-MID' }),
        evDoc('lvl-mid-3', 'dev-lvl-mid-3', 'level_attempt', { level_id: 'L-MID' }),
        evDoc('lvl-mid-4', 'dev-lvl-mid-4', 'level_attempt', { level_id: 'L-MID' }),
        evDoc('lvl-mid-1', 'dev-lvl-mid-1', 'level_complete', { level_id: 'L-MID' }, 10),
        evDoc('lvl-mid-2', 'dev-lvl-mid-2', 'level_complete', { level_id: 'L-MID' }, 10),
        evDoc('lvl-mid-3', 'dev-lvl-mid-3', 'level_complete', { level_id: 'L-MID' }, 10),
      ]);
      const rows = await svc.queryLevelFunnel(7);
      const zero = rows.find((r) => r.level_id === 'L-ZERO');
      const low = rows.find((r) => r.level_id === 'L-LOW');
      expect(zero).toMatchObject({ attempts: 0, completes: 1 });
      expect(zero?.completion_rate).toBeUndefined();
      expect(low?.completion_rate).toBeCloseTo(0.5);
      // ?? 1 fallback: the undefined-rate row is treated as 1.0, so it must sort strictly after any row
      // with a real completion_rate below 1.0 (L-LOW at 0.5) — proves the fallback isn't silently 0.
      const iZero = rows.findIndex((r) => r.level_id === 'L-ZERO');
      const iLow = rows.findIndex((r) => r.level_id === 'L-LOW');
      expect(iZero).toBeGreaterThan(iLow);
      // The whole result stays non-decreasing under the same `?? 1` substitution the comparator uses.
      const effRate = (r: (typeof rows)[number]) => r.completion_rate ?? 1;
      for (let i = 1; i < rows.length; i++) {
        expect(effRate(rows[i])).toBeGreaterThanOrEqual(effRate(rows[i - 1]));
      }
    });
  });

  // ─── queryFeatureGuideFunnel ────────────────────────────────────────────────

  describe('queryFeatureGuideFunnel', () => {
    it('filters by platform', async () => {
      await mongo!.collections.events.insertMany([
        { ...evDoc('fg-plat-1', 'dev-fg-plat-1', 'feature_guide_shown', { feature: 'shop-plat' }), platform: 'wechat' },
        { ...evDoc('fg-plat-2', 'dev-fg-plat-2', 'feature_guide_shown', { feature: 'shop-plat' }), platform: 'web' },
      ]);
      const webRows = await svc.queryFeatureGuideFunnel(7, 'web');
      expect(webRows.find((r) => r.feature === 'shop-plat')?.shown).toBe(1);
    });

    // funnel.ts: close_rate is undefined when a feature has 0 `shown` (only a replay was ever logged for
    // it, e.g. the re-open "?" button fired with no prior guide-shown event in window) — and the entry
    // still tracks `replays` via the third (feature_guide_replay) branch of the shown/closed/replay if-chain.
    it('a feature with 0 shown (only a replay event) has close_rate undefined and its replays counted', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('fg-replay-only', 'dev-fg-replay-only', 'feature_guide_replay', { feature: 'daily-replay-only' }),
        // A second 0-shown feature so the sort comparator's `?? 1` fallback runs on both sides (a and b)
        // of at least one comparison, not just one.
        evDoc('fg-replay-only-2', 'dev-fg-replay-only-2', 'feature_guide_replay', { feature: 'social-replay-only' }),
        // A few normal (real close_rate) features alongside them for varied pairwise comparisons.
        evDoc('fg-normal-1', 'dev-fg-normal-1', 'feature_guide_shown', { feature: 'cards-normal' }),
        evDoc('fg-normal-1', 'dev-fg-normal-1', 'feature_guide_closed', { feature: 'cards-normal' }, 10),
        evDoc('fg-normal-2', 'dev-fg-normal-2', 'feature_guide_shown', { feature: 'world-normal' }),
        evDoc('fg-normal-3', 'dev-fg-normal-3', 'feature_guide_shown', { feature: 'world-normal' }),
        evDoc('fg-normal-2', 'dev-fg-normal-2', 'feature_guide_closed', { feature: 'world-normal' }, 10),
      ]);
      const rows = await svc.queryFeatureGuideFunnel(7);
      const replayOnly = rows.find((r) => r.feature === 'daily-replay-only');
      const replayOnly2 = rows.find((r) => r.feature === 'social-replay-only');
      const normal = rows.find((r) => r.feature === 'cards-normal');
      expect(replayOnly).toMatchObject({ shown: 0, closed: 0, replays: 1 });
      expect(replayOnly?.close_rate).toBeUndefined();
      expect(replayOnly2?.close_rate).toBeUndefined();
      expect(normal?.close_rate).toBeCloseTo(1);
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

  // ─── os_dist ───────────────────────────────────────────────────────────────

  describe('queryOsDist', () => {
    // dist.ts: `os: r._id || 'unknown'` — a session_start doc whose os field is empty/missing groups
    // under Mongo's `null` _id, falling back to the 'unknown' bucket (distinct from a real OS name).
    it('a session_start event with no os value falls into the unknown bucket', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('os-unknown-1', 'dev-os-unknown-1', 'session_start'), // evDoc defaults os to 'test' — override below
      ].map((d) => ({ ...d, os: '' })));
      const osDist = await svc.queryOsDist(7);
      const unknown = osDist.find((r) => r.os === 'unknown');
      expect(unknown).toBeDefined();
      expect(unknown!.devices).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── badge_dist ──────────────────────────────────────────────────────────

  describe('queryBadgeDist', () => {
    // dist.ts: mode/result/badge each independently fall back ('unknown'/'unknown'/'none') when the
    // match_badges event's props are missing that field — distinct from the fully-populated happy path
    // already covered via HTTP in analytics.e2e.test.ts.
    it('a match_badges event missing mode/result/hero props falls back to unknown/unknown/none', async () => {
      await mongo!.collections.events.insertMany([
        evDoc('badge-bare', 'dev-badge-bare', 'match_badges', {}), // no mode/result/hero at all
      ]);
      const dist = await svc.queryBadgeDist(7);
      const row = dist.find((r) => r.mode === 'unknown' && r.result === 'unknown' && r.badge === 'none');
      expect(row).toBeDefined();
      expect(row!.count).toBeGreaterThanOrEqual(1);
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

    // ingest.ts: every `batch.<field> ?? <default>` fallback in the EventDoc map (session_id/device_id/
    // platform/os/game_version/locale) — EventBatch types these as required strings, but the HTTP layer
    // casts an untyped JSON body straight to EventBatch (httpApi.ts), so a real client omitting a field
    // entirely delivers `undefined` at runtime despite the compile-time type. `as any` below simulates
    // that same wire-level gap directly against the service.
    it('a batch missing session_id/device_id/platform/os/game_version/locale entirely falls back to their defaults on the event doc', async () => {
      await svc.ingestEvents(
        {
          events: [{ event: 'bare_fields_marker', ts: Date.now() }],
        } as any,
        undefined,
      );
      const doc = await mongo!.collections.events.findOne({ event: 'bare_fields_marker' });
      expect(doc).toBeTruthy();
      expect(doc?.session_id).toBe('');
      expect(doc?.device_id).toBe('');
      expect(doc?.platform).toBe('web');
      expect(doc?.os).toBe('');
      expect(doc?.game_version).toBe('');
      expect(doc?.locale).toBe('');
    });

    // Same fallback family, but inside the sessions $setOnInsert doc (device_id/platform/os) — requires a
    // real session_id so the session-upsert branch actually runs.
    it('a NEW session whose batch omits device_id/platform/os falls back to their defaults on the sessions doc', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-bare-setoninsert',
          events: [{ event: 'session_start', ts: Date.now() }],
        } as any,
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-bare-setoninsert' });
      expect(doc).toBeTruthy();
      expect(doc?.device_id).toBe('');
      expect(doc?.platform).toBe('web');
      expect(doc?.os).toBe('');
    });

    // ingest.ts: `sessionEnd.props ?? {}` — a session_end event with no `props` key at all (not even an
    // empty object), distinct from the "malformed props" test below which does supply a props object.
    it('a session_end event with no props field at all still sets ended_at, leaving duration_sec/scenes_visited untouched', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-end-no-props', device_id: 'dev-end-no-props', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-end-no-props', device_id: 'dev-end-no-props', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_end', ts: Date.now() + 1000 }], // no `props` key
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-end-no-props' });
      expect(doc?.ended_at).toBeInstanceOf(Date);
      expect(doc?.duration_sec).toBeUndefined();
      expect(doc?.scenes_visited).toEqual([]);
    });

    // Fixed 2026-08-10 (was pinned as a documented bug): events_count used to $inc only inside the
    // `if (sessionStart && batch.session_id)` branch of ingestEvents (src/service/ingest.ts), so a
    // batch that didn't itself carry a session_start event never touched events_count even though its
    // events were durably inserted into the `events` collection. Real traffic sends session_start once
    // and several more event-only batches afterwards, so events_count was permanently undercounted.
    // The trigger is now just "batch has a session_id" — every batch's event count accumulates.
    it('events_count accumulates across batches regardless of whether each one carries a session_start event', async () => {
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

      // A second, later batch for the same session with no session_start — its 3 events must still
      // land in events_count (this is the case that used to be silently dropped).
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
      expect(doc?.events_count).toBe(5); // 2 + 3, accumulated across both batches

      // A third batch, also without session_start, must add on top rather than reset or double-count.
      await svc.ingestEvents(
        {
          session_id: 'sess-write-2', device_id: 'dev-write-2', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'ui_click', ts: Date.now() + 400 }],
        },
        undefined,
      );
      doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-2' });
      expect(doc?.events_count).toBe(6); // 5 + 1

      const totalEventsForSession = await mongo!.collections.events.countDocuments({ session_id: 'sess-write-2' });
      expect(totalEventsForSession).toBe(6); // events_count now matches the raw events collection exactly
    });

    it('a session_id with no session_start event yet still upserts a sessions doc and counts its events (defends against session_start loss/reorder)', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-no-start', device_id: 'dev-write-no-start', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'ui_click', ts: Date.now() },
            { event: 'ui_click', ts: Date.now() + 1 },
          ],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-no-start' });
      expect(doc).toBeTruthy();
      expect(doc?.events_count).toBe(2);
      expect(doc?.scenes_visited).toEqual([]); // $setOnInsert defaults still applied on first-touch upsert
    });

    it('events_count for two different sessions never cross-contaminates when their batches interleave', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-interleave-a', device_id: 'dev-write-ia', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-write-interleave-b', device_id: 'dev-write-ib', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'session_start', ts: Date.now() },
            { event: 'screen_view', ts: Date.now() + 1 },
          ],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-write-interleave-a', device_id: 'dev-write-ia', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'ui_click', ts: Date.now() + 100 },
            { event: 'ui_click', ts: Date.now() + 200 },
          ],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-write-interleave-b', device_id: 'dev-write-ib', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'ui_click', ts: Date.now() + 300 }],
        },
        undefined,
      );

      const docA = await mongo!.collections.sessions.findOne({ _id: 'sess-write-interleave-a' });
      const docB = await mongo!.collections.sessions.findOne({ _id: 'sess-write-interleave-b' });
      expect(docA?.events_count).toBe(3); // 1 (session_start) + 2 (ui_click, ui_click)
      expect(docB?.events_count).toBe(3); // 2 (session_start, screen_view) + 1 (ui_click)
    });

    it('a session_end-only batch (no session_start in it) still increments events_count for that batch', async () => {
      await svc.ingestEvents(
        {
          session_id: 'sess-write-end-count', device_id: 'dev-write-end-count', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );
      await svc.ingestEvents(
        {
          session_id: 'sess-write-end-count', device_id: 'dev-write-end-count', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_end', ts: Date.now() + 1000, props: { duration_sec: 1 } }],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-end-count' });
      expect(doc?.events_count).toBe(2); // 1 (session_start) + 1 (session_end) — session_end batches count too
      expect(doc?.ended_at).toBeInstanceOf(Date);
    });

    it('a single batch carrying both session_start and session_end (very short session) is counted and finalized in one shot', async () => {
      const startTs = Date.now();
      const endTs = startTs + 5_000;
      await svc.ingestEvents(
        {
          session_id: 'sess-write-instant', device_id: 'dev-write-instant', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'session_start', ts: startTs },
            { event: 'session_end', ts: endTs, props: { duration_sec: 5, scenes_visited: ['LobbyScene'] } },
          ],
        },
        undefined,
      );
      const doc = await mongo!.collections.sessions.findOne({ _id: 'sess-write-instant' });
      expect(doc?.events_count).toBe(2);
      expect(doc!.started_at.getTime()).toBeCloseTo(startTs, -2);
      expect(doc?.ended_at?.getTime()).toBeCloseTo(endTs, -2);
      expect(doc?.duration_sec).toBe(5);
      expect(doc?.scenes_visited).toEqual(['LobbyScene']);
    });

    // 2026-08-10 follow-up coverage (task: cover reorder/duplicate/concurrency edges of the events_count
    // fix above). Real network delivery is not ordered: retries and reordering mean the session_start
    // batch is not guaranteed to be the first one ingestEvents ever sees for a given session_id.
    it('an out-of-order session_start batch (arrives AFTER earlier event-only batches) still has its own events counted, but does not retroactively correct started_at', async () => {
      const firstSeenTs = Date.now();
      // First-arriving batch has no session_start — this is the batch that bootstraps the sessions doc
      // via $setOnInsert's `sessionStart?.ts ?? batch.events[0]?.ts` fallback.
      await svc.ingestEvents(
        {
          session_id: 'sess-reorder-1', device_id: 'dev-reorder-1', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [
            { event: 'ui_click', ts: firstSeenTs },
            { event: 'ui_click', ts: firstSeenTs + 10 },
          ],
        },
        undefined,
      );
      let doc = await mongo!.collections.sessions.findOne({ _id: 'sess-reorder-1' });
      expect(doc?.events_count).toBe(2);
      const bootstrappedStartedAt = doc!.started_at.getTime();
      expect(bootstrappedStartedAt).toBeCloseTo(firstSeenTs, -2);

      // The session_start batch shows up later, carrying a ts that is chronologically EARLIER than the
      // events that already landed (simulating a delayed/retried send of the very first batch the client
      // actually produced).
      const trueSessionStartTs = firstSeenTs - 5000;
      await svc.ingestEvents(
        {
          session_id: 'sess-reorder-1', device_id: 'dev-reorder-1', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: trueSessionStartTs }],
        },
        undefined,
      );
      doc = await mongo!.collections.sessions.findOne({ _id: 'sess-reorder-1' });
      // events_count is not order-sensitive: the late session_start batch's event still lands on top.
      expect(doc?.events_count).toBe(3);
      // Documented current semantics: $setOnInsert only ever applies on the update that performs the
      // insert. Since the doc already existed by the time the session_start batch arrived, started_at
      // stays pinned to whichever batch arrived FIRST — the actually-earliest event's timestamp (here,
      // trueSessionStartTs) is silently NOT adopted, even though it is semantically "more correct". This
      // means started_at means "first-observed-by-the-server" rather than "true earliest event ts" under
      // reordering; that is a pre-existing property of the upsert shape, not something this fix changed.
      expect(doc!.started_at.getTime()).toBeCloseTo(bootstrappedStartedAt, -2);
      expect(doc!.started_at.getTime()).not.toBeCloseTo(trueSessionStartTs, -2);
    });

    it('a duplicate session_start for the same session (client retry/reconnect) does not re-initialize started_at and still counts its own event exactly once', async () => {
      const ts1 = Date.now();
      await svc.ingestEvents(
        {
          session_id: 'sess-dup-start', device_id: 'dev-dup-start', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: ts1 }],
        },
        undefined,
      );
      let doc = await mongo!.collections.sessions.findOne({ _id: 'sess-dup-start' });
      expect(doc?.events_count).toBe(1);
      const firstStartedAt = doc!.started_at.getTime();

      // Duplicate session_start batch, e.g. the client reconnected and resent its startup payload.
      // Give it a very different ts so an accidental overwrite would be obvious.
      const ts2 = ts1 + 60_000;
      await svc.ingestEvents(
        {
          session_id: 'sess-dup-start', device_id: 'dev-dup-start', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: ts2 }],
        },
        undefined,
      );
      doc = await mongo!.collections.sessions.findOne({ _id: 'sess-dup-start' });
      // The duplicate session_start batch still carries one real event, so events_count accumulates to 2
      // — it is not deduplicated (there is no dedup logic in ingestEvents), and it is not double-counted.
      expect(doc?.events_count).toBe(2);
      // started_at is untouched by the second session_start: $setOnInsert only fires on the insert that
      // created the doc, so the duplicate cannot clobber it.
      expect(doc!.started_at.getTime()).toBeCloseTo(firstStartedAt, -2);
    });

    it('two concurrent batches for the same already-existing session both land in events_count via Mongo\'s atomic $inc (no lost update)', async () => {
      // Pre-create the session with a single batch first so both concurrent batches below are plain
      // $inc updates against an existing document, not two upserts racing to insert the same _id (that
      // race is covered separately below, for a brand-new session).
      const sid = 'sess-concurrent-existing';
      await svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-concurrent-existing', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }],
        },
        undefined,
      );

      const batchA = svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-concurrent-existing', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'ui_click', ts: Date.now() + 1 }, { event: 'ui_click', ts: Date.now() + 2 }],
        },
        undefined,
      );
      const batchB = svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-concurrent-existing', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'ui_click', ts: Date.now() + 3 }, { event: 'ui_click', ts: Date.now() + 4 }, { event: 'ui_click', ts: Date.now() + 5 }],
        },
        undefined,
      );
      await Promise.all([batchA, batchB]);

      const doc = await mongo!.collections.sessions.findOne({ _id: sid });
      // 1 (session_start) + 2 (batch A) + 3 (batch B) = 6, regardless of interleaving — $inc is atomic
      // per document, so two concurrent updateOne calls against the same _id serialize at the storage
      // layer and neither increment is lost.
      expect(doc?.events_count).toBe(6);
      const totalEvents = await mongo!.collections.events.countDocuments({ session_id: sid });
      expect(totalEvents).toBe(6);
    });

    it('two concurrent batches for a BRAND-NEW session (first ever ingest, both racing to upsert-insert the same _id) still end up with events_count matching both batches combined', async () => {
      // Unlike the previous test, there is no pre-existing sessions doc here: both batches' updateOne
      // calls race to be the one that performs the upsert's *insert*. This exercises the same code path
      // as the very first batch a real session ever sends when the client fires two batches back-to-back
      // (e.g. session_start + an immediate first UI event) without waiting for the first to land.
      const sid = 'sess-concurrent-new';
      const batchA = svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-concurrent-new', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'session_start', ts: Date.now() }, { event: 'ui_click', ts: Date.now() + 1 }],
        },
        undefined,
      );
      const batchB = svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-concurrent-new', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [{ event: 'ui_click', ts: Date.now() + 2 }, { event: 'ui_click', ts: Date.now() + 3 }, { event: 'ui_click', ts: Date.now() + 4 }],
        },
        undefined,
      );
      // Neither call should reject: if the upsert-insert race produced an uncaught duplicate-key error
      // on either side, that would surface here as a rejected promise.
      await expect(Promise.all([batchA, batchB])).resolves.toBeDefined();

      const doc = await mongo!.collections.sessions.findOne({ _id: sid });
      expect(doc).toBeTruthy();
      // 2 (batch A) + 3 (batch B) = 5, regardless of which batch's updateOne performed the insert.
      expect(doc?.events_count).toBe(5);
      const totalEvents = await mongo!.collections.events.countDocuments({ session_id: sid });
      expect(totalEvents).toBe(5);
    });

    it('a batch with an empty events array never touches the sessions collection, even with a valid session_id (early-return path, unrelated to the events_count fix)', async () => {
      const sid = 'sess-empty-events';
      await svc.ingestEvents(
        {
          session_id: sid, device_id: 'dev-empty-events', platform: 'web', os: 'Windows', game_version: '1', locale: 'en',
          events: [],
        },
        undefined,
      );
      const count = await mongo!.collections.sessions.countDocuments({ _id: sid });
      expect(count).toBe(0);
      const eventCount = await mongo!.collections.events.countDocuments({ session_id: sid });
      expect(eventCount).toBe(0);
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
