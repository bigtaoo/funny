// 社交私聊端到端（S6-2）：真实 Mongo + 注入假 gateway（记录 chat_message push）。
//   非好友拒发 → 加好友 → 发消息（push + 会话 + 未读 +1 + 敏感词打码）→ 拉历史 → 已读清未读
//   → 拉黑后拒发 → 限流。需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, CHAT_SEND_RATE_PER_MIN } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../dist/gatewayClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_chat_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[social-chat.e2e] Mongo 不可达（${URI}）— 跳过。`);

class FakeGateway implements GatewayClient {
  available = true;
  pushes: { accountId: string; msg: SocialPushMsg }[] = [];
  async judge(): Promise<JudgeRes> {
    return { ok: false };
  }
  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    this.pushes.push({ accountId, msg });
  }
  async presence(ids: string[]): Promise<Record<string, boolean>> {
    return Object.fromEntries(ids.map((id) => [id, false]));
  }
  async invalidateFriends(): Promise<void> {}
}

describe.skipIf(!mongo)('social chat e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  const b = (r: { payload: string }) => JSON.parse(r.payload);

  async function newAccount(
    deviceId: string,
    acceptLanguage?: string,
  ): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = b(await app.inject({
      method: 'POST',
      url: '/auth/device',
      payload: { deviceId },
      ...(acceptLanguage ? { headers: { 'accept-language': acceptLanguage } } : {}),
    }));
    return { token: r.data.token, accountId: r.data.accountId, publicId: r.data.publicId };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(token), payload });
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });

  async function befriend(a: { token: string }, c: { token: string; publicId: string; accountId: string }) {
    const req = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: req.data.requestId, accept: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (mongo) await mongo.close();
  });

  it('rejects chat to a non-friend', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    const r = await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'hi' });
    expect(r.statusCode).toBe(403);
    expect(b(r).error.code).toBe('NOT_FRIEND');
  });

  it('sends to a friend: pushes recipient, bumps conversation + unread, censors body', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    gateway.pushes = [];

    const send = b(await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'hello fuck you' }));
    expect(send.ok).toBe(true);
    // push chat_message → recipient c, body censored
    const push = gateway.pushes.find((p) => p.accountId === c.accountId && p.msg.kind === 'chat_message');
    expect(push).toBeTruthy();
    const msg = push!.msg as { fromPublicId: string; body: string; convId: string };
    expect(msg.fromPublicId).toBe(a.publicId);
    expect(msg.body).toBe('hello **** you'); // "fuck" → "****"

    // c's conversation list: 1 unread, peer = a, lastBody censored
    const cConvs = b(await get(c.token, '/chat/conversations'));
    expect(cConvs.data.conversations).toHaveLength(1);
    const conv = cConvs.data.conversations[0];
    expect(conv.peer.publicId).toBe(a.publicId);
    expect(conv.unread).toBe(1);
    expect(conv.lastBody).toBe('hello **** you');

    // a's own conversation: 0 unread (a is the sender)
    const aConvs = b(await get(a.token, '/chat/conversations'));
    expect(aConvs.data.conversations[0].unread).toBe(0);

    // history fetch for c
    const hist = b(await get(c.token, `/chat/${encodeURIComponent(conv.convId)}/messages`));
    expect(hist.data.messages).toHaveLength(1);
    expect(hist.data.messages[0].fromPublicId).toBe(a.publicId);
    expect(hist.data.messages[0].body).toBe('hello **** you');
  });

  it('censors per sender region: de account masks a German-only word', async () => {
    // sender authed with Accept-Language: de → account.region='de' → de wordlist active.
    const a = await newAccount('chat-aaaa', 'de-DE,de;q=0.9,en;q=0.8');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    const send = b(await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'du bist scheisse' }));
    expect(send.ok).toBe(true);
    const conv = b(await get(c.token, '/chat/conversations')).data.conversations[0];
    expect(conv.lastBody).toBe('du bist ********'); // "scheisse" (8) → 8 stars
  });

  it('censors per sender region: cn account masks a Chinese word', async () => {
    const a = await newAccount('chat-aaaa', 'zh-CN');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    await post(a.token, '/chat/send', { toPublicId: c.publicId, body: '卖外挂吗' });
    const conv = b(await get(c.token, '/chat/conversations')).data.conversations[0];
    expect(conv.lastBody).toBe('卖**吗'); // "外挂" (2) → 2 stars
  });

  it('region-scopes wordlists: an en-region account does not mask a de-only word', async () => {
    const a = await newAccount('chat-aaaa', 'en-US');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    // "scheisse" is in the de list only — en account sees global+en, so it stays unmasked.
    await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'das ist scheisse' });
    const conv = b(await get(c.token, '/chat/conversations')).data.conversations[0];
    expect(conv.lastBody).toBe('das ist scheisse');
  });

  it('read clears the unread counter', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'one' });
    await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'two' });
    let cConvs = b(await get(c.token, '/chat/conversations'));
    expect(cConvs.data.conversations[0].unread).toBe(2);
    await post(c.token, '/chat/read', { convId: cConvs.data.conversations[0].convId });
    cConvs = b(await get(c.token, '/chat/conversations'));
    expect(cConvs.data.conversations[0].unread).toBe(0);
  });

  it('blocked sender cannot chat', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    await post(a.token, '/friends/block', { publicId: c.publicId }); // a blocks c
    const r = await post(c.token, '/chat/send', { toPublicId: a.publicId, body: 'hey' });
    expect(r.statusCode).toBe(403);
    expect(b(r).error.code).toBe('BLOCKED');
  });

  it('non-member cannot read a conversation history', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    const stranger = await newAccount('chat-xxxx');
    await befriend(a, c);
    await post(a.token, '/chat/send', { toPublicId: c.publicId, body: 'private' });
    const conv = b(await get(a.token, '/chat/conversations')).data.conversations[0];
    const r = await get(stranger.token, `/chat/${encodeURIComponent(conv.convId)}/messages`);
    expect(r.statusCode).toBe(404);
  });

  it('rate-limits beyond the per-minute cap', async () => {
    const a = await newAccount('chat-aaaa');
    const c = await newAccount('chat-bbbb');
    await befriend(a, c);
    let limited = false;
    for (let i = 0; i <= CHAT_SEND_RATE_PER_MIN; i++) {
      const r = await post(a.token, '/chat/send', { toPublicId: c.publicId, body: `m${i}` });
      if (r.statusCode === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});
