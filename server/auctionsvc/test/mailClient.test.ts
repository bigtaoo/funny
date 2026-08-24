// HttpAuctionMailClient unit tests (previously 0% coverage — no dedicated test file existed at all).
// Best-effort system-mail dispatch: never throws (delivery/return failures are logged, not propagated,
// so a mail outage never blocks settlement) — covers the not-configured no-op, the real-request body
// shape, the HTTP-level failure log, and the "HTTP 200 but {ok:false}" rejected-mail log (meta answers
// 200 even when the recipient is unknown or socialsvc persistence failed, so status alone can't detect
// a dropped mail).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAuctionMailClient, nullAuctionMailClient } from '../src/mailClient';

const KEY = 'k-internal';
let nextStatus = 200;
let nextBody: unknown = { ok: true };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;
let lastRequestBody: Record<string, unknown> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      lastRequestBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

describe('HttpAuctionMailClient', () => {
  it('available reflects whether baseUrl is configured', () => {
    expect(new HttpAuctionMailClient(base, KEY).available).toBe(true);
    expect(new HttpAuctionMailClient(null, KEY).available).toBe(false);
  });

  it('baseUrl absent -> no-op, no request sent at all', async () => {
    lastRequestBody = undefined;
    await new HttpAuctionMailClient(null, KEY).sendSystemMail('acc-a', 'dk-1', { subject: 's', body: 'b' });
    expect(lastRequestBody).toBeUndefined();
  });

  it('sends the full envelope to /internal/mail/system/send, defaulting attachments/expireDays when absent', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-1', { subject: 'Sold!', body: 'Your item sold.' });
    expect(lastRequestBody).toEqual({
      dispatchKey: 'dk-1', accountId: 'acc-a', subject: 'Sold!', body: 'Your item sold.', attachments: [], expireDays: 0,
    });
  });

  it('forwards attachments + expireDays verbatim when provided', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-2', {
      subject: 'Refund', body: 'Listing cancelled.', attachments: [{ kind: 'coins', count: 500 }], expireDays: 14,
    });
    expect(lastRequestBody).toMatchObject({ attachments: [{ kind: 'coins', count: 500 }], expireDays: 14 });
  });

  // 2026-08-24 (U13 close-out): these two used to assert the opposite — "logged, not thrown, mail is
  // best-effort". That was the single likeliest way to lose a real asset in production: one meta 500 and a
  // seller's proceeds or a buyer's item were gone, with a log line as the only trace and no driver
  // anywhere that would ever retry. A configured client now raises, and the settlement journal records the
  // hand-over as still owed so the scheduler sweep keeps retrying it.
  it('an HTTP-level failure (non-2xx) throws, so the journal can record the hand-over as still owed', async () => {
    nextStatus = 500;
    nextBody = {};
    await expect(new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-3', { subject: 's', body: 'b' }))
      .rejects.toThrow(/mail\.sendSystemMail failed: status 500/);
  });

  it('HTTP 200 but {ok:false} in the body (dropped mail) throws too — the status alone cannot detect it', async () => {
    nextStatus = 200;
    nextBody = { ok: false, error: 'unknown recipient' };
    await expect(new HttpAuctionMailClient(base, KEY).sendSystemMail('acc-a', 'dk-4', { subject: 's', body: 'b' }))
      .rejects.toThrow(/rejected: unknown recipient/);
  });
});

describe('nullAuctionMailClient', () => {
  // Stays a silent no-op even though the configured client now throws: with meta unconfigured there is
  // nothing to retry, and AUCTION_DESIGN's stated degradation is that mail delivery does not block
  // settlement. Raising here would instead park every flow as permanently owed in a dev environment.
  it('reports unavailable and no-ops sendSystemMail', async () => {
    expect(nullAuctionMailClient.available).toBe(false);
    await expect(nullAuctionMailClient.sendSystemMail('acc-a', 'dk', { subject: 's', body: 'b' })).resolves.toBeUndefined();
  });
});
