// Branch-coverage backfill for src/app.ts (group D, 2026-09-03).
//
// buildApp is already driven from src by access-log.test.ts / trustproxy.test.ts, so what is left is
// the wiring the existing suites never turn on (socialsvcUrl → a real HTTP client instead of the
// null one) and the log-hook halves nothing produced: the health-probe exemption, the 5xx branch of
// the error handler, and the unserializable-body guard. The log branches matter because the access log
// is the only record of a failed request that ops has; a hook that throws while formatting it would
// take the diagnosis with it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signToken, type Collections } from '@nw/shared';
import { buildApp } from '../src/app.js';

const jwt = { secret: 'grpD-app-secret' };
const ACC = 'acc-grpD-app';
const auth = { authorization: `Bearer ${signToken(ACC, jwt)}` };

class FakeCol {
  docs = new Map<string, Record<string, unknown>>();
  async findOne(q: Record<string, unknown>) {
    return typeof q._id === 'string' ? this.docs.get(q._id) ?? null : null;
  }
  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) {
    const d = typeof filter._id === 'string' ? this.docs.get(filter._id) : undefined;
    if (!d) return null;
    if (update.$set) Object.assign(d, update.$set);
    return d;
  }
}

function fakeCols(): { cols: Collections; saves: FakeCol } {
  const saves = new FakeCol();
  saves.docs.set(ACC, { _id: ACC, save: { accountId: ACC, rev: 1 }, rev: 1 });
  return { cols: { saves, cardInstances: new FakeCol() } as unknown as Collections, saves };
}

describe('app.ts access log + error handler branches', () => {
  let app: FastifyInstance | undefined;
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  afterEach(async () => {
    for (const s of spies.splice(0)) s.mockRestore();
    await app?.close();
    app = undefined;
    vi.unstubAllGlobals();
  });

  function silence(): { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    spies.push(log, warn, error);
    return { log, warn, error };
  }

  it('the liveness probe is exempt from the access log (it would otherwise dominate every log file)', async () => {
    // /health is polled by compose/the load balancer every few seconds; logging it buries every real
    // request. The exemption is also why the health route must not be renamed casually.
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    const spy = silence();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    const lines = spy.log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain('/health');
  });

  it('a handler that throws logs at error level with the stack, and answers a 500 INTERNAL envelope', async () => {
    // The 5xx half of setErrorHandler: a real fault must carry the stack into the log (a 4xx never
    // does), and must still leave the player with the standard ApiResp envelope rather than raw HTML.
    // A route registered here rather than a service made to throw: the handler under test is app.ts's
    // own error handler, and driving it through a service internal only makes the test brittle about
    // which internal happens to fault first.
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    app.get('/grpD-fault', async () => { throw new Error('simulated Mongo read failure'); });
    const spy = silence();
    const res = await app.inject({ method: 'GET', url: '/grpD-fault' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    const lines = spy.error.mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1])}`).join('\n');
    expect(lines).toContain('500 INTERNAL');
    expect(lines).toContain('simulated Mongo read failure');
    expect(lines).toContain('at '); // the stack, not just the message
  });

  it('an error carrying no stack still logs its message rather than an empty err field', async () => {
    // `error.stack ?? error.message`: some libraries strip the stack (Error.captureStackTrace off, a
    // rethrown plain object turned into an Error). The 5xx line is the only trace of the fault, so it
    // must degrade to the message rather than logging `err=undefined`.
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    app.get('/grpD-stackless', async () => {
      const e = new Error('stackless failure');
      delete (e as { stack?: string }).stack;
      throw e;
    });
    const spy = silence();
    const res = await app.inject({ method: 'GET', url: '/grpD-stackless' });
    expect(res.statusCode).toBe(500);
    const lines = spy.error.mock.calls.map((c) => `${String(c[0])} ${JSON.stringify(c[1])}`).join('\n');
    expect(lines).toContain('stackless failure');
  });

  it('a body that cannot be JSON-stringified is replaced with a placeholder, not allowed to break the log line', async () => {
    // redactedBodyForLog's guard. A plain parsed JSON body can never be circular, but the access-log
    // hook reads `req.body` AFTER every other hook has had a chance to rewrite it — so the guard is
    // what keeps a body-normalising hook from turning a logged 4xx into a thrown error inside
    // onResponse (which would lose the log line for the very request someone is trying to diagnose).
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    app.addHook('preHandler', async (req) => {
      const circular: Record<string, unknown> = { cardInstanceId: 'no-such-card' };
      circular.self = circular;
      req.body = circular;
    });
    const spy = silence();
    const res = await app.inject({
      method: 'POST', url: '/cards/lock', headers: auth, payload: { cardInstanceId: 'no-such-card' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const lines = spy.warn.mock.calls
      .concat(spy.error.mock.calls)
      .map((c) => `${String(c[0])} ${JSON.stringify(c[1])}`)
      .join('\n');
    expect(lines).toContain('[unserializable body]');
  });
});

describe('app.ts dependency wiring', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllGlobals();
  });

  it('socialsvcUrl (rather than an injected client) builds a real HTTP client and routes /friends there', async () => {
    // Without this branch the deployment silently falls back to nullMetaSocialsvcClient and every
    // friend/chat/mail endpoint answers 503 "socialsvc not configured" — a whole feature area dark,
    // from one unread config value.
    const { cols } = fakeCols();
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true, status: 200, json: async () => ({ ok: true, data: { friends: [] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    app = await buildApp({
      cols, jwt, internalKey: 'k', authRateLimit: 0, logger: false,
      socialsvcUrl: 'http://socialsvc.internal:8080',
    });
    const res = await app.inject({ method: 'GET', url: '/friends', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, data: { friends: [] } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://socialsvc.internal:8080/social/friends');
  });

  it('no socialsvcUrl and no injected client → friend endpoints report the dependency as unconfigured', async () => {
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    const res = await app.inject({ method: 'GET', url: '/friends', headers: auth });
    expect(res.statusCode).toBe(503);
  });

  it('a paddle checkout with an unverifiable bearer token is anonymous, not a 500', async () => {
    // buildApp's own getAccountId closure: a forged/expired token must degrade to "not logged in" so
    // the checkout route answers 401 login-required instead of surfacing a JWT exception as a 500.
    const { cols } = fakeCols();
    app = await buildApp({ cols, jwt, internalKey: 'k', authRateLimit: 0 });
    const res = await app.inject({
      method: 'POST', url: '/shop/paddle/checkout',
      headers: { authorization: 'Bearer forged.token.value' },
      payload: { tierId: 'tier1' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});
