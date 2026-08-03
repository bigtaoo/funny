// Regression test (2026-08-03 fix): app.ts now sets Fastify's trustProxy so req.ip reflects the real
// client behind the reverse proxy (nginx/Caddy), not the proxy's own socket address. Before the fix,
// service/telemetry.ts's per-IP anomaly-flood rate limiter (30 requests/IP/60s) used req.ip as its key —
// without trustProxy, every request's req.ip resolves to the same loopback socket address regardless of
// X-Forwarded-For, collapsing the limiter into one counter shared by the whole player base. No Mongo
// needed: clientAnomaly never touches cols.
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Collections } from '@nw/shared';
import type { FastifyInstance } from 'fastify';

async function makeApp(): Promise<FastifyInstance> {
  return buildApp({ cols: {} as unknown as Collections, jwt: { secret: 'test-secret' }, internalKey: 'k', lokiPushUrl: null });
}

function anomaly(app: FastifyInstance, forwardedFor: string) {
  return app.inject({
    method: 'POST',
    url: '/client/anomaly',
    headers: { 'x-forwarded-for': forwardedFor },
    payload: { publicId: '1', events: [{ type: 'anr', msg: 'stall', ts: 1 }] },
  });
}

describe('trustProxy: per-IP anomaly rate limit is scoped to the real client address', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it('two distinct X-Forwarded-For addresses get independent 30-request budgets, not a shared one', async () => {
    app = await makeApp();
    const body = (r: { payload: string }) => JSON.parse(r.payload) as { data: { accepted: number } };

    // Exhaust address A's budget (30 requests).
    for (let i = 0; i < 30; i++) {
      const r = await anomaly(app, '1.2.3.4');
      expect(body(r).data.accepted).toBe(1);
    }
    const overA = await anomaly(app, '1.2.3.4');
    expect(body(overA).data.accepted).toBe(0); // address A is now capped

    // A different address must still have its own fresh budget — proves trustProxy actually
    // differentiates callers by the forwarded address instead of a single shared socket address.
    const firstB = await anomaly(app, '5.6.7.8');
    expect(body(firstB).data.accepted).toBe(1);
  });
});
