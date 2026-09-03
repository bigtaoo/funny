// metaClient / commercialClient / mailClient / db.ts branch-coverage gap-fill (2026-09-03 pass).
//
// The existing client tests all answer with well-formed JSON, so every one of these clients had only
// ever seen `res.body` as an object. `fetchInternalJson` also returns `body: null` — for a non-JSON
// payload (an nginx/gateway error page, which is exactly what a 502 in front of meta looks like) and
// for an unreachable host — and each client has a message-fallback chain for precisely that case. None
// of those chains had ever been executed, so a real 502 in production would have been the first time
// this code ran. Also covered: db.ts's connect-failure handler, whose one job is to keep the Mongo
// password out of the log line.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlgError } from '@nw/shared';
import { HttpAuctionMetaClient } from '../src/metaClient';
import { HttpAuctionCommercialClient } from '../src/commercialClient';
import { HttpAuctionMailClient } from '../src/mailClient';
import { createAuctionMongo } from '../src/db';

const KEY = 'k-internal';

/** What the next request is answered with. `json: false` sends a body `res.json()` cannot parse. */
let next: { status: number; body: string; json: boolean } = { status: 200, body: '{}', json: true };
const answerJson = (status: number, body: unknown) => { next = { status, body: JSON.stringify(body), json: true }; };
const answerNonJson = (status: number, body: string) => { next = { status, body, json: false }; };

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((res) => { req.on('data', () => undefined); req.on('end', () => res()); });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      await drain(req);
      res.writeHead(next.status, { 'content-type': next.json ? 'application/json' : 'text/html' });
      res.end(next.body);
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('HttpAuctionMetaClient: failures that arrive with no parsable body', () => {
  it('deductMaterial on a 500 HTML error page reports the transport error, not "undefined"', async () => {
    answerNonJson(500, '<html><body>502 Bad Gateway</body></html>');
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(c.deductMaterial('acc-1', 'scrap', 1, 'auction_list:x')).rejects.toThrow(/non-JSON response/);
  });

  it('deductMaterial on a 400 with an empty JSON body falls back to naming the call and the status', async () => {
    answerJson(400, {});
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(c.deductMaterial('acc-1', 'scrap', 1, 'auction_list:y')).rejects.toThrow('deductMaterial failed: 400');
  });

  it.each([
    ['escrowEquipment', (c: HttpAuctionMetaClient) => c.escrowEquipment('acc-1', 'eq-1', 'k')],
    ['escrowCard', (c: HttpAuctionMetaClient) => c.escrowCard('acc-1', 'cd-1', 'k')],
    ['escrowSkin', (c: HttpAuctionMetaClient) => c.escrowSkin('acc-1', 'sk_ink', 'k')],
  ])('%s on an unparsable 502 raises a definitive BAD_REQUEST carrying the transport error', async (_label, call) => {
    // Definitive matters here: the journal rolls a flow back on an SlgError, so an escrow that could
    // not even be understood must not be left owed forever.
    answerNonJson(502, 'gateway timeout');
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(call(c)).rejects.toThrow(SlgError);
    await expect(call(c)).rejects.toThrow(/non-JSON response/);
  });

  it('escrowEquipment on a 400 with an empty JSON body names the call and the status', async () => {
    answerJson(400, {});
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(c.escrowEquipment('acc-1', 'eq-1', 'k')).rejects.toThrow('escrowEquipment failed: 400');
  });
});

describe('HttpAuctionCommercialClient.spend: the money path must never pass silently', () => {
  it('a non-JSON response throws with the transport error rather than treating the charge as done', async () => {
    answerNonJson(502, 'gateway timeout');
    const c = new HttpAuctionCommercialClient(base, KEY);
    await expect(c.spend('acc-1', 100, 'auction_buy:x:acc-1')).rejects.toThrow(/non-JSON response/);
  });

  it('a 500 whose JSON body carries no error code still throws, naming the status', async () => {
    // `!res.ok` is checked separately from `!res.body.ok` because commercial normally answers 200 for
    // business failures — a genuine 5xx is a different thing and has no error code to surface.
    answerJson(500, { ok: false });
    const c = new HttpAuctionCommercialClient(base, KEY);
    await expect(c.spend('acc-1', 100, 'auction_buy:y:acc-1')).rejects.toThrow('spend failed: 500');
  });
});

describe('HttpAuctionMailClient: a mail meta accepted but did not deliver', () => {
  it('an {ok:false} with no error field still throws, labelled "unknown"', async () => {
    // The throw is what makes the journal keep the hand-over owed; before it existed, a dropped mail
    // was a log line and a destroyed asset.
    answerJson(200, { ok: false });
    const c = new HttpAuctionMailClient(base, KEY);
    await expect(c.sendSystemMail('acc-1', 'dk-1', { subject: 's', body: 'b' })).rejects.toThrow('rejected: unknown');
  });
});

describe('createAuctionMongo: a connection that cannot even be opened', () => {
  it('rethrows, and the log line redacts the credentials out of the URI', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(createAuctionMongo('mongodb+bogus://ops:hunter2@db.internal:27017/', 'nw_auction')).rejects.toThrow();
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('://***@');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('ops:');
    error.mockRestore();
  });
});
