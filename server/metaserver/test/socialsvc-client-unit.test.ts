// src-attributed unit coverage for src/socialsvcClient.ts (HttpMetaSocialsvcClient + nullMetaSocialsvcClient).
// No existing test imports this from '../src/...' directly — mail-claim.e2e.test.ts exercises the same
// class but via '../dist/socialsvcClient.js' (compiled output), which vitest's v8 coverage provider
// cannot attribute to src/*.ts (same rationale as commercial-client-unit.test.ts's header). This file
// drives the real class from '../src/socialsvcClient.js' against a real node:http fixture server.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpMetaSocialsvcClient, nullMetaSocialsvcClient } from '../src/socialsvcClient.js';

const KEY = 'k-social';
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
let sharedClient: HttpMetaSocialsvcClient;

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

      // proxy() passthrough sandbox paths
      if (path === '/social/echo') return send(200, { echoedBody: parsed, method: req.method, hasAuth: !!req.headers.authorization });
      if (path === '/social/nonjson') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not-json-response');
        return;
      }

      // claim
      const claimMatch = /^\/internal\/mail\/([^/]+)\/claim$/.exec(path);
      if (claimMatch) {
        const id = decodeURIComponent(claimMatch[1]!);
        if (id === 'notfound') return send(200, { ok: false, error: 'NOT_FOUND' });
        if (id === 'noattach') return send(200, { ok: false, error: 'NO_ATTACHMENT' });
        if (id === 'claimed') return send(200, { ok: false, error: 'ALREADY_CLAIMED' });
        if (id === 'unknownerr') return send(200, { ok: false, error: 'SOME_WEIRD_ERROR' });
        if (id === 'servererror') return send(500, { ok: false, error: 'BOOM' });
        return send(200, { ok: true, data: { doc: { _id: id, to: parsed.accountId, subject: 's', body: 'b', expireAt: 0 } } });
      }
      // unclaim
      const unclaimMatch = /^\/internal\/mail\/([^/]+)\/unclaim$/.exec(path);
      if (unclaimMatch) {
        const id = decodeURIComponent(unclaimMatch[1]!);
        if (id === 'fail-unclaim') return send(500, { ok: false, error: 'BOOM' });
        return send(200, { ok: true });
      }
      if (path === '/internal/mail/system') {
        if (parsed.to === 'fail-insert') return send(500, { ok: false, error: 'BOOM' });
        return send(200, {
          ok: true,
          data: { mailId: `${parsed.dispatchKey}:${parsed.to}`, inserted: true, hasAttachment: !!(parsed.content as { attachments?: unknown[] })?.attachments?.length },
        });
      }
      if (path === '/internal/mail/system/bulk') {
        const accountIds = (parsed.accountIds as string[]) ?? [];
        if (accountIds.includes('fail-bulk')) return send(500, { ok: false, error: 'BOOM' });
        return send(200, {
          ok: true,
          data: { insertedAccountIds: accountIds, hasAttachment: !!(parsed.content as { attachments?: unknown[] })?.attachments?.length },
        });
      }
      send(404, { ok: false, error: 'not found' });
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sharedClient = new HttpMetaSocialsvcClient(base, KEY);
});

afterAll(() => server.close());

describe('HttpMetaSocialsvcClient — available', () => {
  it('is always true', () => {
    expect(new HttpMetaSocialsvcClient(base, KEY).available).toBe(true);
  });
});

describe('HttpMetaSocialsvcClient — proxy', () => {
  it('POST with a body: forwards method/body/authorization, parses JSON response', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    const r = await client.proxy('POST', '/social/echo', { hello: 'world' }, 'Bearer jwt-1');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ echoedBody: { hello: 'world' }, method: 'POST', hasAuth: true });
    expect(lastReq?.headers.authorization).toBe('Bearer jwt-1');
    expect(lastReq?.headers['x-internal-key']).toBeUndefined(); // proxy passes the player JWT, never the internal key
  });

  it('GET: body is never sent even if a non-null body is passed (method===GET short-circuits)', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    const r = await client.proxy('GET', '/social/echo', { should: 'not-send' }, 'Bearer jwt-2');
    expect((r.data as { echoedBody: unknown }).echoedBody).toEqual({});
    expect(lastReq?.body).toBe('');
  });

  it('DELETE: body is never sent even if a non-null body is passed (method===DELETE short-circuits)', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    const r = await client.proxy('DELETE', '/social/echo', { should: 'not-send' }, 'Bearer jwt-3');
    expect((r.data as { echoedBody: unknown }).echoedBody).toEqual({});
    expect(lastReq?.body).toBe('');
  });

  it('non-JSON response body → data={} (drains the body instead of throwing)', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    const r = await client.proxy('GET', '/social/nonjson', null, 'Bearer jwt-4');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({});
  });

  it('network error (unreachable host) → {status:503, data:{ok:false, error:"socialsvc unavailable"}}', async () => {
    const refused = createServer(() => {});
    refused.listen(0, '127.0.0.1');
    await new Promise<void>((r) => refused.on('listening', r));
    const deadPort = (refused.address() as AddressInfo).port;
    await new Promise<void>((r) => refused.close(() => r())); // now guaranteed ECONNREFUSED on this port

    const client = new HttpMetaSocialsvcClient(`http://127.0.0.1:${deadPort}`, KEY);
    const r = await client.proxy('GET', '/social/whatever', null, 'Bearer jwt-5');
    expect(r).toEqual({ status: 503, data: { ok: false, error: 'socialsvc unavailable' } });
  });
});

describe('HttpMetaSocialsvcClient — claimMail', () => {
  it('success → { doc }', async () => {
    const r = await sharedClient.claimMail('mail-ok-1', 'acct-1', 'order-1');
    expect(r).toEqual({ doc: { _id: 'mail-ok-1', to: 'acct-1', subject: 's', body: 'b', expireAt: 0 } });
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/internal/mail/mail-ok-1/claim');
    expect(lastReq?.headers['x-internal-key']).toBe(KEY);
  });

  it('NOT_FOUND / NO_ATTACHMENT / ALREADY_CLAIMED are passed through as their specific error codes', async () => {
    expect(await sharedClient.claimMail('notfound', 'a', 'o')).toEqual({ error: 'NOT_FOUND' });
    expect(await sharedClient.claimMail('noattach', 'a', 'o')).toEqual({ error: 'NO_ATTACHMENT' });
    expect(await sharedClient.claimMail('claimed', 'a', 'o')).toEqual({ error: 'ALREADY_CLAIMED' });
  });

  it('unrecognized business error code → SOCIAL_UNAVAILABLE (never told "not found" for an ambiguous state)', async () => {
    expect(await sharedClient.claimMail('unknownerr', 'a', 'o')).toEqual({ error: 'SOCIAL_UNAVAILABLE' });
  });

  it('HTTP-level failure (5xx) → SOCIAL_UNAVAILABLE', async () => {
    expect(await sharedClient.claimMail('servererror', 'a', 'o')).toEqual({ error: 'SOCIAL_UNAVAILABLE' });
  });

  it('mailId is URL-encoded in the request path', async () => {
    await sharedClient.claimMail('weird/id with space', 'a', 'o').catch(() => {});
    expect(lastReq?.url).toBe(`/internal/mail/${encodeURIComponent('weird/id with space')}/claim`);
  });
});

describe('HttpMetaSocialsvcClient — unclaimMail', () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  it('success (r.ok) → resolves silently, no console.error', async () => {
    errSpy.mockClear();
    await sharedClient.unclaimMail('mail-ok-2', 'acct-1', 'order-1');
    expect(errSpy).not.toHaveBeenCalled();
    expect(lastReq?.url).toBe('/internal/mail/mail-ok-2/unclaim');
  });

  it('failure (!r.ok) → resolves (best-effort) but logs via console.error', async () => {
    errSpy.mockClear();
    await sharedClient.unclaimMail('fail-unclaim', 'acct-1', 'order-1');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain('unclaimMail failed');
  });
});

describe('HttpMetaSocialsvcClient — insertSystemMail', () => {
  it('success → returns { mailId, inserted, hasAttachment }', async () => {
    const r = await sharedClient.insertSystemMail('dispatch-1', 'acct-1', { subject: 's', body: 'b', expireDays: 30 });
    expect(r).toEqual({ mailId: 'dispatch-1:acct-1', inserted: true, hasAttachment: false });
    expect(lastReq?.url).toBe('/internal/mail/system');
  });

  it('hasAttachment=true when attachments are present', async () => {
    const r = await sharedClient.insertSystemMail('dispatch-2', 'acct-1', {
      subject: 's',
      body: 'b',
      expireDays: 30,
      attachments: [{ kind: 'coins', count: 1 }],
    });
    expect(r.hasAttachment).toBe(true);
  });

  it('failure → throws with status + error message', async () => {
    await expect(
      sharedClient.insertSystemMail('dispatch-fail', 'fail-insert', { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/socialsvc insertSystemMail failed: 500 BOOM/);
  });
});

describe('HttpMetaSocialsvcClient — bulkInsertSystemMail', () => {
  it('success → returns { insertedAccountIds, hasAttachment }', async () => {
    const r = await sharedClient.bulkInsertSystemMail('dispatch-bulk-1', ['a1', 'a2'], { subject: 's', body: 'b', expireDays: 30 });
    expect(r).toEqual({ insertedAccountIds: ['a1', 'a2'], hasAttachment: false });
  });

  it('failure → throws with status + error message', async () => {
    await expect(
      sharedClient.bulkInsertSystemMail('dispatch-bulk-fail', ['fail-bulk'], { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/socialsvc bulkInsertSystemMail failed: 500 BOOM/);
  });
});

describe('nullMetaSocialsvcClient', () => {
  it('available=false; every method reflects "not configured" without a network call', async () => {
    expect(nullMetaSocialsvcClient.available).toBe(false);
    expect(await nullMetaSocialsvcClient.proxy('GET', '/x', null, 'Bearer y')).toEqual({
      status: 503,
      data: { ok: false, error: 'socialsvc unavailable' },
    });
    expect(await nullMetaSocialsvcClient.claimMail('m', 'a', 'o')).toEqual({ error: 'SOCIAL_UNAVAILABLE' });
    await expect(nullMetaSocialsvcClient.unclaimMail('m', 'a', 'o')).resolves.toBeUndefined();
    await expect(nullMetaSocialsvcClient.insertSystemMail('d', 't', { subject: 's', body: 'b', expireDays: 1 })).rejects.toThrow(
      'socialsvc not configured',
    );
    await expect(
      nullMetaSocialsvcClient.bulkInsertSystemMail('d', ['a'], { subject: 's', body: 'b', expireDays: 1 }),
    ).rejects.toThrow('socialsvc not configured');
  });
});
