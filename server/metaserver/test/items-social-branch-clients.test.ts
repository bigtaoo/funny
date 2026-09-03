// Branch-coverage backfill for src/commercialClient.ts and src/socialsvcClient.ts (group G, 2026-09-03).
// commercial-client-unit.test.ts / socialsvc-client-unit.test.ts already drive both classes against a
// real node:http fixture (kept here — no fetch mocking), but only ever see a healthy or an
// `{ok:false, error:"..."}` upstream. What is missing is the *degraded* side of each read wrapper (a
// business-error envelope on a GET must degrade to an empty list, not crash the admin page) and the
// error-message chains — which link of `detail ?? error ?? status` wins is literally the sentence an
// operator reads in the log when commercial or socialsvc misbehaves.
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes lines to source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpCommercialClient } from '../src/commercialClient.js';
import { HttpMetaSocialsvcClient } from '../src/socialsvcClient.js';

const KEY = 'k-grpG';
let lastUrl = '';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      lastUrl = req.url ?? '';
      const path = new URL(lastUrl, 'http://x').pathname;
      const sendJson = (o: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        /* not JSON */
      }

      // A 200 whose body parses to the JSON literal `null` — the one shape that leaves
      // fetchInternalJson with body===null AND no `error` string (a bad gateway/proxy rewrite).
      if (parsed._nullJson) return sendJson(null);

      // socialsvc: 204 No Content, so `res.body` is null and there is nothing to drain.
      if (path === '/social/nocontent') {
        res.writeHead(204);
        res.end();
        return;
      }
      // socialsvc system-mail failures with no usable error string of their own.
      if (path === '/internal/mail/system' || path === '/internal/mail/system/bulk') {
        const marker = String(parsed.to ?? (parsed.accountIds as string[] | undefined)?.[0] ?? '');
        if (marker === 'nonjson') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('<html>gateway error</html>');
          return;
        }
        return sendJson({ ok: false }); // ok:false with no `error` field at all
      }

      // Everything else (all the commercial GET readers): a business-error envelope.
      return sendJson({ ok: false, error: 'DEGRADED' });
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpCommercialClient — degraded upstream', () => {
  it('post(): a body that parses to JSON `null` throws with the HTTP status, since there is no error string', async () => {
    // r.error is only set for a network error / non-JSON parse failure. A literal `null` JSON body
    // leaves it undefined, and the thrown message has to fall back to the status so the log still
    // says something actionable instead of "failed: undefined".
    const client = new HttpCommercialClient(base, KEY);
    await expect(
      client.spend({ accountId: 'a', amount: 1, reason: 'r', orderId: 'o', ...({ _nullJson: true } as object) }),
    ).rejects.toThrow('commercial /internal/spend failed: status 200');
  });

  it('every GET-based reader degrades to an empty list on an ok:false envelope (admin pages render empty, not 500)', async () => {
    const client = new HttpCommercialClient(base, KEY);
    expect(await client.listLimitedPools()).toEqual([]);
    expect(await client.undeliveredOrders('a')).toEqual([]);
    expect(await client.listPromoCodes()).toEqual([]);
    expect(await client.listPaddleEvents({ accountId: 'a' })).toEqual([]);
    expect(await client.auditCoinGains('2026-09-03', 100)).toEqual([]);
  });

  it('listActiveLimitedPools with an absent `now` sends now=0 rather than the string "undefined"', async () => {
    // `now` is forwarded straight into the query string; without the `?? 0` an undefined clock would
    // reach commercial as `now=undefined` and be parsed there as NaN (every pool would look expired).
    const client = new HttpCommercialClient(base, KEY);
    expect(await client.listActiveLimitedPools(undefined as unknown as number)).toEqual([]);
    expect(lastUrl).toBe('/internal/gacha/pools?active=1&now=0');
  });
});

describe('HttpMetaSocialsvcClient — degraded upstream', () => {
  it('proxy() over a 204 No Content response: nothing to parse and no body to drain -> data={}', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    const r = await client.proxy('DELETE', '/social/nocontent', null, 'Bearer jwt');
    expect(r).toEqual({ status: 204, data: {} });
  });

  it('insertSystemMail failing with an ok:false envelope carrying no error string -> message is just the status', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    await expect(
      client.insertSystemMail('dk', 'noerror', { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/^socialsvc insertSystemMail failed: 200$/);
  });

  it('insertSystemMail over a non-JSON response reports the parse failure (the only error string available)', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    await expect(
      client.insertSystemMail('dk', 'nonjson', { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/socialsvc insertSystemMail failed: 200 non-JSON response/);
  });

  it('bulkInsertSystemMail: same two message chains (ok:false with no error, then a non-JSON body)', async () => {
    const client = new HttpMetaSocialsvcClient(base, KEY);
    await expect(
      client.bulkInsertSystemMail('dk', ['noerror'], { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/^socialsvc bulkInsertSystemMail failed: 200$/);
    await expect(
      client.bulkInsertSystemMail('dk', ['nonjson'], { subject: 's', body: 'b', expireDays: 30 }),
    ).rejects.toThrow(/socialsvc bulkInsertSystemMail failed: 200 non-JSON response/);
  });
});
