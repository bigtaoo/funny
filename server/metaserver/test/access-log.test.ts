// Access-log level/body coverage (2026-07-28): before this, every response (2xx through 5xx) logged a
// single uniform `info` line via app.ts's onResponse hook, with no request body at all — diagnosing a
// specific failed request (e.g. "which card id did this 404 CARD_NOT_FOUND actually send?") required
// the reporter's own DevTools Network tab, since the access log alone never carried it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signToken, type Collections } from '@nw/shared';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const jwt = { secret: 'test-secret' };
const ACC = 'acc-log-1';
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

function fakeCols(): Collections {
  const saves = new FakeCol();
  const s = { _id: ACC, save: { accountId: ACC, rev: 1 } as unknown, rev: 1 };
  saves.docs.set(ACC, s);
  return { saves, cardInstances: new FakeCol() } as unknown as Collections;
}

async function makeApp(): Promise<FastifyInstance> {
  return buildApp({ cols: fakeCols(), jwt, internalKey: 'k', commercialUrl: null, gatewayUrl: null, authRateLimit: 0 });
}

describe('access log: level escalation + redacted body on error/warn (2026-07-28)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let app: FastifyInstance;

  afterEach(async () => {
    warnSpy?.mockRestore();
    errorSpy?.mockRestore();
    logSpy?.mockRestore();
    await app?.close();
  });

  it('a normal (non-thrown) 404 logs at warn level with the request body attached', async () => {
    app = await makeApp();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app.inject({
      method: 'POST', url: '/cards/lock', headers: auth,
      payload: { cardInstanceId: 'no-such-card' },
    });
    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalled();
    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('POST /cards/lock -> 404');
    expect(line).toContain('no-such-card'); // request body's cardInstanceId made it into the log
    // The plain onResponse hook never fires at info level once the status is >= 400.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('/cards/lock'))).toBe(false);
  });

  it('a thrown 401 (missing bearer token) logs at warn level with the (empty) body, via setErrorHandler', async () => {
    app = await makeApp();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await app.inject({ method: 'POST', url: '/cards/lock', payload: { cardInstanceId: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(warnSpy).toHaveBeenCalled();
    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('401');
  });

  it('a successful (200) response never logs the body, even though it carries one', async () => {
    app = await makeApp();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app.inject({ method: 'GET', url: '/titles', headers: auth });
    expect(res.statusCode).toBe(200);
    const line = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('GET /titles -> 200');
    expect(line).not.toContain('body=');
  });

  it('sensitive fields (password) are redacted, never logged in plaintext', async () => {
    app = await makeApp();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Any endpoint accepting a `password` field and failing validation is enough — /auth/register with
    // a too-short/missing loginId triggers Fastify's own request-schema validation (thrown path).
    const res = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { password: 'super-secret-plaintext' },
    });
    expect(res.statusCode).toBe(400);
    const all = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0])).join('\n');
    expect(all).not.toContain('super-secret-plaintext');
    expect(all).toContain('[redacted]');
  });
});
