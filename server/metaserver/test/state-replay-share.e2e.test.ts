// 状态流录像游戏外分享端到端（REPLAY_SHARE_DESIGN §3）：
//   POST /replay/share（鉴权上传 blob → shareCode）→ 公开 GET /r/{shareCode}（匿名取回 + viewCount++）。
//   覆盖：round-trip、匿名取、不存在 404、体量超限 400。
//   需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_state_share_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[state-replay-share.e2e] Mongo 不可达（${URI}）— 跳过。`);

// blob 是客户端 gzip+base64 后的 opaque 压缩串（服务端不解压/不解释，只存取 + 体量闸 + 限流）。
// 测试只需任意非空串 round-trip 一致即可。
const sampleBlob = 'H4sIAAAAAAAA_compressed-state-replay-blob-base64==';

describe.skipIf(!mongo)('state replay share e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    // authRateLimit=0 关闭 auth 限流（测试默认）。
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
    const ra = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'sr-aaaa-1' } }));
    token = ra.data.token;
  });

  afterAll(async () => { if (app) await app.close(); });

  it('铸码 → 匿名取回 blob 一致 + viewCount++', async () => {
    const post = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: sampleBlob },
    });
    expect(post.statusCode).toBe(200);
    const shareCode = body(post).data.shareCode as string;
    expect(shareCode).toBeTruthy();

    // 公开取（无 token）。
    const get1 = await app.inject({ method: 'GET', url: `/r/${shareCode}` });
    expect(get1.statusCode).toBe(200);
    expect(body(get1).data.blob).toEqual(sampleBlob);

    // 再取一次 → viewCount 累加（异步 $inc，给个 round-trip 让它落库）。
    await app.inject({ method: 'GET', url: `/r/${shareCode}` });
    const doc = await m.collections.stateReplayShares.findOne({ _id: shareCode });
    expect(doc!.createdBy).toBeTruthy();
    expect(doc!.viewCount).toBeGreaterThanOrEqual(1);
  });

  it('未登录铸码 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/replay/share', payload: { blob: sampleBlob } });
    expect(res.statusCode).toBe(401);
  });

  it('不存在的 shareCode → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/r/nope-nope-nope' });
    expect(res.statusCode).toBe(404);
  });

  it('体量超限 → 优雅 400（而非 Fastify 413）', async () => {
    // > 2MB 压缩串（仍 < 4MB Fastify bodyLimit），应命中应用层优雅 400「replay too large」，
    // 不被 Fastify 抢先 413。
    const big = 'A'.repeat(2 * 1024 * 1024 + 16);
    const res = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: big },
    });
    expect(res.statusCode).toBe(400);
  });

  it('缺 blob → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/replay/share',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
