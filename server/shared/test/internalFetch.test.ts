// fetchInternalJson (comm-audit-internal-2026-07-28 batch A): the JSON-returning sibling of
// postInternal. These tests run against a real local http server because the guarantees under
// test are transport-level: timeouts fire, bodies drain, non-2xx JSON still parses, network
// errors surface as {ok:false,status:0} instead of throwing.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchInternalJson } from '../src/internalFetch';

const KEY = 'test-internal-key';
const OPTS = { caller: 'metaserver' as const, key: KEY };

let server: Server;
let base = '';
let hits: { path: string; caller: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', caller: req.headers['x-internal-caller'] as string | undefined });
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: 42 }));
    } else if (req.url === '/business-error') {
      // Internal APIs signal business errors as JSON on 4xx (INSUFFICIENT_FUNDS 402 etc.);
      // callers depend on reading that body.
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'INSUFFICIENT_FUNDS' }));
    } else if (req.url === '/html') {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html>boom</html>');
    } else if (req.url === '/slow') {
      // Never responds within the test timeout — exercises AbortSignal.timeout.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 5_000).unref();
    } else if (req.url === '/echo-method') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('fetchInternalJson', () => {
  it('returns parsed body and ok=true on 2xx', async () => {
    const r = await fetchInternalJson<{ ok: boolean; value: number }>(`${base}/ok`, OPTS);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body?.value).toBe(42);
  });

  it('sends x-internal-caller for audit attribution', async () => {
    hits = [];
    await fetchInternalJson(`${base}/ok`, OPTS);
    expect(hits[0]?.caller).toBe('metaserver');
  });

  it('parses and returns the JSON body of a 4xx (business error) with ok=false', async () => {
    const r = await fetchInternalJson<{ ok: boolean; error: string }>(`${base}/business-error`, OPTS);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(402);
    expect(r.body?.error).toBe('INSUFFICIENT_FUNDS');
  });

  it('never retries a 4xx', async () => {
    hits = [];
    await fetchInternalJson(`${base}/business-error`, { ...OPTS, retries: 3 });
    expect(hits.length).toBe(1);
  });

  it('handles non-JSON responses without throwing', async () => {
    const r = await fetchInternalJson(`${base}/html`, OPTS);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.body).toBeNull();
    expect(r.error).toContain('non-JSON');
  });

  it('times out instead of hanging and reports status 0', async () => {
    const started = Date.now();
    const r = await fetchInternalJson(`${base}/slow`, { ...OPTS, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.body).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('surfaces connection refusal as {ok:false,status:0} instead of throwing', async () => {
    const r = await fetchInternalJson('http://127.0.0.1:1/nope', { ...OPTS, timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });

  it('POSTs a JSON body when method/body are given', async () => {
    const r = await fetchInternalJson<{ method: string }>(`${base}/echo-method`, {
      ...OPTS,
      method: 'POST',
      body: { a: 1 },
    });
    expect(r.body?.method).toBe('POST');
  });

  it('retries 5xx up to the retry budget', async () => {
    hits = [];
    const r = await fetchInternalJson(`${base}/html`, { ...OPTS, retries: 2, backoffMs: 1 });
    expect(r.ok).toBe(false);
    expect(hits.length).toBe(3); // 1 initial + 2 retries
  });
});
