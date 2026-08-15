// src-attributed unit coverage for src/gatewayClient.ts (HttpGatewayClient).
// No existing test imports this from '../src/...' — same vitest-v8-coverage-attribution rationale as
// commercial-client-unit.test.ts / socialsvc-client-unit.test.ts's headers. Drives the real class from
// '../src/gatewayClient.js' against a real node:http fixture server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpGatewayClient } from '../src/gatewayClient.js';
import type { JudgeReq } from '../src/gatewayClient.js';

const KEY = 'k-gw';
let lastReq: { url: string; method: string; headers: IncomingMessage['headers']; body: string } | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

const judgeReq: JudgeReq = { seed: 1, mode: 1, endFrame: 10, frames: [], exclude: ['a1', 'a2'] };

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      lastReq = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body };
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const url = new URL(req.url ?? '', 'http://x');
      const path = url.pathname;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        /* not JSON */
      }

      if (path === '/gw/judge') {
        if (parsed.seed === -1) return send(500, { ok: false }); // HTTP-level failure
        if (parsed.seed === -2) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not-json'); // 200 but unparseable → r.body null
          return;
        }
        return send(200, { ok: true, stateHash: 'hash1', winnerSide: 1, judgeAccountId: 'judge-1' });
      }
      if (path === '/gw/push') return send(200, { ok: true });
      send(404, { ok: false });
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpGatewayClient — available', () => {
  it('baseUrl set → true; baseUrl=null → false', () => {
    expect(new HttpGatewayClient(base, KEY).available).toBe(true);
    expect(new HttpGatewayClient(null, KEY).available).toBe(false);
  });
});

describe('HttpGatewayClient — judge', () => {
  it('baseUrl=null → {ok:false} without making a request', async () => {
    const client = new HttpGatewayClient(null, KEY);
    lastReq = null;
    expect(await client.judge(judgeReq)).toEqual({ ok: false });
    expect(lastReq).toBeNull();
  });

  it('success → forwards the full JudgeRes body, POSTs to /gw/judge with X-Internal-Key', async () => {
    const client = new HttpGatewayClient(base, KEY);
    const r = await client.judge(judgeReq);
    expect(r).toEqual({ ok: true, stateHash: 'hash1', winnerSide: 1, judgeAccountId: 'judge-1' });
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/gw/judge');
    expect(lastReq?.headers['x-internal-key']).toBe(KEY);
  });

  it('HTTP-level failure (5xx) → {ok:false}', async () => {
    const client = new HttpGatewayClient(base, KEY);
    const r = await client.judge({ ...judgeReq, seed: -1 });
    expect(r).toEqual({ ok: false });
  });

  it('200 but non-JSON body (r.body null) → {ok:false}', async () => {
    const client = new HttpGatewayClient(base, KEY);
    const r = await client.judge({ ...judgeReq, seed: -2 });
    expect(r).toEqual({ ok: false });
  });
});

describe('HttpGatewayClient — push', () => {
  it('baseUrl=null → resolves without making a request', async () => {
    const client = new HttpGatewayClient(null, KEY);
    lastReq = null;
    await expect(client.push('acct-1', { kind: 'friend_update', publicId: 'p1', added: true })).resolves.toBeUndefined();
    expect(lastReq).toBeNull();
  });

  it('baseUrl set → POSTs to /gw/push with the accountId + msg payload', async () => {
    const client = new HttpGatewayClient(base, KEY);
    await client.push('acct-1', { kind: 'mail_new', mailId: 'm1', hasAttachment: true });
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/gw/push');
    expect(JSON.parse(lastReq!.body)).toEqual({
      accountId: 'acct-1',
      msg: { kind: 'mail_new', mailId: 'm1', hasAttachment: true },
    });
  });

  it('does not throw even when the peer responds with an error status (best-effort, fire-and-forget)', async () => {
    const client = new HttpGatewayClient(`${base}/unknown-base`, KEY); // -> /gw/push under this base 404s
    await expect(client.push('acct-1', { kind: 'friend_update', publicId: 'p1', added: false })).resolves.toBeUndefined();
  });
});
