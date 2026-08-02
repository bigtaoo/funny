// HttpWorldMetaClient.getSaveFields — the query string worldsvc puts on the wire.
//
// `cardIds` (2026-08-02) narrows meta's cardInv projection so getTeams' self-heal stops pulling the
// player's whole roster to validate a handful of ids. The contract is asymmetric in a way that is
// easy to break silently: an EMPTY array must NOT be sent, because meta reads a missing `cardIds`
// as "full roster" and would happily widen the query back out — callers with nothing to look up are
// expected to skip the call entirely (CityService.getTeams does).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWorldMetaClient } from '../src/metaClient';

const KEY = 'k-internal';

let server: Server;
let base: string;
let lastUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cardInv: {} }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

/** Query params of the last request the fake meta server received. */
function lastQuery(): URLSearchParams {
  return new URL(lastUrl, 'http://x').searchParams;
}

describe('HttpWorldMetaClient.getSaveFields query string', () => {
  it('sends cardIds as a comma-separated list alongside fields', async () => {
    const c = new HttpWorldMetaClient(base, KEY);
    await c.getSaveFields('acc-1', ['cardInv'], ['c1', 'c2', 'c3']);
    const q = lastQuery();
    expect(q.get('accountId')).toBe('acc-1');
    expect(q.get('fields')).toBe('cardInv');
    expect(q.get('cardIds')).toBe('c1,c2,c3');
  });

  it('omits cardIds entirely when the caller passes none — meta then returns the full roster', async () => {
    const c = new HttpWorldMetaClient(base, KEY);
    await c.getSaveFields('acc-1', ['cardInv', 'equipmentInv']);
    expect(lastQuery().has('cardIds')).toBe(false);
  });

  it('omits cardIds for an EMPTY array too, rather than sending a param meta would read as "full roster"', async () => {
    const c = new HttpWorldMetaClient(base, KEY);
    await c.getSaveFields('acc-1', ['cardInv'], []);
    expect(lastQuery().has('cardIds')).toBe(false);
  });

  it('percent-encodes each id, so a separator inside an id cannot forge extra entries', async () => {
    const c = new HttpWorldMetaClient(base, KEY);
    await c.getSaveFields('acc-1', ['cardInv'], ['a,b', 'c&d=e']);
    // Assert on the RAW url: URLSearchParams.get() decodes, so reading the param back would show
    // 'a,b,c&d=e' either way and prove nothing. The two things that matter are that the separators
    // are escaped on the wire, and that the '&' did not split off a parameter of its own.
    expect(lastUrl).toContain('cardIds=a%2Cb,c%26d%3De');
    expect(lastQuery().has('d')).toBe(false);
  });

  it('no baseUrl configured (meta not wired) → null, no request attempted', async () => {
    const c = new HttpWorldMetaClient('', KEY);
    await expect(c.getSaveFields('acc-1', ['cardInv'], ['c1'])).resolves.toBeNull();
  });
});
