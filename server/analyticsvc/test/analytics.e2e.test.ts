// analyticsvc 端到端（A9-6/A9-7）：真实 Mongo + 真实 node:http。
//   • POST /analytics/events 批量摄入
//   • GET  /internal/query?type=event_counts/dau/funnel（X-Internal-Key）
//   • runFunnelEtl + queryFunnel 漏斗 ETL 闭环
//   • /health 无鉴权；缺密钥 → 401；未知 type → 400
// Mongo 不可达时整套 skip（CI 须先 docker compose up -d）。
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
if (!mongo) console.warn(`[analyticsvc.e2e] Mongo 不可达（${URI}）— 跳过。`);

describe.skipIf(!mongo)('analyticsvc e2e', () => {
  let server: Server;
  let base: string;
  let svc: AnalyticsService;

  const TODAY = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await mongo!.ensureIndexes();
    // 清空测试 DB
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

  // ─── 健康探针 ────────────────────────────────────────────────────────────

  it('GET /health 无鉴权 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('analyticsvc');
  });

  // ─── 配置端点 ────────────────────────────────────────────────────────────

  it('GET /analytics/config 返回采样配置', async () => {
    const res = await fetch(`${base}/analytics/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { enabled: boolean; defaultSample: number } };
    expect(body.ok).toBe(true);
    expect(body.data.enabled).toBe(true);
    expect(typeof body.data.defaultSample).toBe('number');
  });

  // ─── 事件摄入 ────────────────────────────────────────────────────────────

  it('POST /analytics/events 摄入事件批次 → 200', async () => {
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
    // fire-and-forget：给后台写入一点时间
    await new Promise((r) => setTimeout(r, 200));
  });

  it('POST /analytics/events 第二个设备 + screen_view（部分漏斗）', async () => {
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

  it('POST /analytics/events 空 events 数组 → 400', async () => {
    const res = await fetch(`${base}/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'x', device_id: 'x', platform: 'web', os: '', game_version: '', locale: '', events: [] }),
    });
    expect(res.status).toBe(400);
  });

  // ─── /internal/query 鉴权 ────────────────────────────────────────────────

  it('GET /internal/query 缺密钥 → 401', async () => {
    const res = await fetch(`${base}/internal/query?type=event_counts&days=7`);
    expect(res.status).toBe(401);
  });

  it('GET /internal/query 未知 type → 400', async () => {
    const res = await fetch(`${base}/internal/query?type=unknown`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(400);
  });

  // ─── event_counts ────────────────────────────────────────────────────────

  it('GET /internal/query?type=event_counts 返回按日按事件计数', async () => {
    const res = await fetch(`${base}/internal/query?type=event_counts&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; counts: { date: string; event: string; count: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('event_counts');
    // 确认今天有数据
    const today = body.data.counts.filter((r) => r.date === TODAY);
    expect(today.length).toBeGreaterThan(0);
    // session_start 应有 2 条（dev-001 + dev-002）
    const ssRow = today.find((r) => r.event === 'session_start');
    expect(ssRow?.count).toBe(2);
  });

  // ─── dau ─────────────────────────────────────────────────────────────────

  it('GET /internal/query?type=dau 返回每日独立设备数', async () => {
    const res = await fetch(`${base}/internal/query?type=dau&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; dau: { date: string; dau: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('dau');
    const todayRow = body.data.dau.find((r) => r.date === TODAY);
    // 两个不同 device_id 上报 → DAU = 2
    expect(todayRow?.dau).toBe(2);
  });

  // ─── ETL + funnel ────────────────────────────────────────────────────────

  it('runFunnelEtl 计算今日漏斗并写入 funnels_daily', async () => {
    await svc.runFunnelEtl(TODAY);
    const rows = await svc.queryFunnel(1);
    // web 平台应有 session_start / game_start / level_attempt / level_complete 四步
    const webRows = rows.filter((r) => r.platform === 'web');
    const steps = webRows.map((r) => r.funnel_step);
    expect(steps).toContain('session_start');
    expect(steps).toContain('game_start');
    expect(steps).toContain('level_attempt');
    expect(steps).toContain('level_complete');
    // session_start: 2 设备；level_complete: 1 设备（只有 dev-001 完成）
    const ssRow = webRows.find((r) => r.funnel_step === 'session_start');
    expect(ssRow?.count).toBe(2);
    const lcRow = webRows.find((r) => r.funnel_step === 'level_complete');
    expect(lcRow?.count).toBe(1);
    // 转化率 = 1/2 = 0.5（game_start → level_attempt → level_complete）
    expect(lcRow?.conversion_rate).toBeCloseTo(1 / 1); // level_attempt→level_complete: 1/1
  });

  it('GET /internal/query?type=funnel 读取漏斗预聚合数据', async () => {
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

  it('GET /internal/query?type=funnel&platform=web 按平台过滤', async () => {
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

  it('runFunnelEtl 幂等：重跑同日不改结果', async () => {
    await svc.runFunnelEtl(TODAY);
    const rows = await svc.queryFunnel(1);
    const ssRow = rows.find((r) => r.funnel_step === 'session_start' && r.platform === 'web');
    // 重跑后计数不变
    expect(ssRow?.count).toBe(2);
  });

  // ─── region_dist ─────────────────────────────────────────────────────────

  it('GET /internal/query?type=region_dist 返回地区分布', async () => {
    const res = await fetch(`${base}/internal/query?type=region_dist&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; regions: { locale: string; devices: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('region_dist');
    // dev-001=zh, dev-002=en → 两个地区
    const locales = body.data.regions.map((r) => r.locale).sort();
    expect(locales).toContain('zh');
    expect(locales).toContain('en');
    // 按设备数降序
    expect(body.data.regions[0].devices).toBeGreaterThanOrEqual(body.data.regions[body.data.regions.length - 1].devices);
  });

  // ─── os_dist ─────────────────────────────────────────────────────────────

  it('GET /internal/query?type=os_dist 返回 OS 分布', async () => {
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

  it('GET /internal/query?type=login_hour 返回 24 个小时槽', async () => {
    const res = await fetch(`${base}/internal/query?type=login_hour&days=7`, {
      headers: { 'x-internal-key': INTERNAL_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { type: string; login_hour: { hour: number; count: number }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe('login_hour');
    // 始终返回 24 个小时槽（0-23），有数据的小时 count > 0
    expect(body.data.login_hour).toHaveLength(24);
    const total = body.data.login_hour.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(2); // 两次 session_start
    // 小时槽按升序
    for (let i = 1; i < 24; i++) {
      expect(body.data.login_hour[i].hour).toBe(i);
    }
  });

  // ─── retention ───────────────────────────────────────────────────────────

  it('GET /internal/query?type=retention 返回留存数组', async () => {
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
    // 返回 7 行（每天一行）
    expect(body.data.retention).toHaveLength(7);
    // 今天队列有 2 个设备
    const todayRow = body.data.retention.find((r) => r.date === TODAY);
    expect(todayRow?.cohort_size).toBe(2);
    // 当天 D7 = undefined（未来数据不存在）
    expect(todayRow?.d7).toBeUndefined();
  });
});
