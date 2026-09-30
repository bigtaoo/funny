// HttpAccountPurgeClient (C5-b account purge): wire contract against a throwaway local HTTP server —
// URL/method/headers/body, the ok()/err() envelope mapping, fail-closed on a missing URL, and a
// malformed reply being treated as a failure rather than as "done".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAccountPurgeClient } from '../src/accountPurgeClient.js';

interface Seen { method?: string; url?: string; key?: string; caller?: string; body: unknown }

let server: Server;
let base = '';
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        method: req.method,
        url: req.url,
        key: req.headers['x-internal-key'] as string | undefined,
        caller: req.headers['x-internal-caller'] as string | undefined,
        body,
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function client(): HttpAccountPurgeClient {
  return new HttpAccountPurgeClient(
    { social: base, world: base, auction: base, commercial: base, analytics: null },
    'k-legacy',
  );
}

describe('HttpAccountPurgeClient', () => {
  it('POSTs the body to /internal/accounts/:id/purge as meta and maps done:true', async () => {
    seen.length = 0;
    reply = { status: 200, body: { ok: true, data: { done: true, removed: { x: 1 } } } };
    const r = await client().purge('social', 'acc/1', { publicId: '123' });
    expect(r).toEqual({ ok: true, done: true, data: { done: true, removed: { x: 1 } } });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/internal/accounts/acc%2F1/purge',
      key: 'k-legacy',
      caller: 'meta',
      body: { publicId: '123' },
    });
  });

  it('passes done:false (pending) through as a successful call', async () => {
    reply = { status: 200, body: { ok: true, data: { done: false, pending: { leadingBids: 1 } } } };
    const r = await client().purge('auction', 'acc-1', {});
    expect(r).toMatchObject({ ok: true, done: false });
  });

  it('fails closed when the service URL is not configured, without any request', async () => {
    seen.length = 0;
    const r = await client().purge('analytics', 'acc-1', { deviceIds: [] });
    expect(r).toEqual({ ok: false, error: 'analytics: internal URL not configured' });
    expect(seen).toHaveLength(0);
  });

  it('maps an err() envelope to a failure carrying its code and message', async () => {
    reply = { status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED', message: 'nope' } } };
    const r = await client().purge('world', 'acc-1', {});
    expect(r).toEqual({ ok: false, error: 'world: 401 UNAUTHENTICATED: nope' });
  });

  it('treats a reply without a boolean done as a failure, never as done', async () => {
    reply = { status: 200, body: { ok: true, data: { removed: {} } } };
    const r = await client().purge('commercial', 'acc-1', {});
    expect(r.ok).toBe(false);
  });

  it('reports a string error body as-is', async () => {
    reply = { status: 400, body: { ok: false, error: 'bad body' } };
    const r = await client().purge('social', 'acc-1', {});
    expect(r).toEqual({ ok: false, error: 'social: 400 bad body' });
  });
});
