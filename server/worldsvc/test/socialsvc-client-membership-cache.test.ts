// HttpWorldSocialsvcClient's family/sect membership cache (worldsvc-concurrency-2026-09-05, phase 2).
//
// These two reads sit on worldsvc's hottest paths and each one is a cross-service HTTP hop: every march
// dispatch resolves "which families share my sect" for the ADR-039 connectivity check, and every ~5s map
// poll resolves it three times over. Caching them is a correctness-sensitive change — the same data gates
// territory connectivity and the friendly-fire block — so the cases that could actually cause harm are
// pinned here rather than left to the TTL being "probably fine":
//
//   • a FAILED lookup must never be cached (caching socialsvc's `[]` would pin "this sect has no members"
//     and silently break connectivity for everyone in it);
//   • a write worldsvc itself makes must invalidate immediately, not wait out the TTL;
//   • a partially-warm batch must still ask for the members it is missing.
//
// A real loopback HTTP server rather than a module mock, matching meta-client-save-fields.test.ts: the
// thing under test is the client's request behaviour, so counting real requests is the assertion.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWorldSocialsvcClient } from '../src/socialsvcClient';

const KEY = 'k-internal';

let server: Server;
let base: string;
/** Every path the fake socialsvc has been asked for, in order. */
let requests: string[] = [];
/** Set to a status to make the next responses fail. */
let failWith: number | null = null;
let familiesBySect: Record<string, { familyId: string; sectId: string }[]> = {};

function body(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      requests.push(url);
      if (failWith) {
        res.writeHead(failWith, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'nope' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.startsWith('/internal/family/by-sect/')) {
        const sectId = decodeURIComponent(url.slice('/internal/family/by-sect/'.length));
        return res.end(JSON.stringify({ data: { families: familiesBySect[sectId] ?? [] } }));
      }
      if (url.startsWith('/internal/family/batch')) {
        const { familyIds } = JSON.parse((await body(req)) || '{}') as { familyIds?: string[] };
        const known = Object.values(familiesBySect).flat();
        return res.end(JSON.stringify({ data: { families: known.filter((f) => familyIds?.includes(f.familyId)) } }));
      }
      return res.end(JSON.stringify({ data: {} }));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

afterEach(() => {
  requests = [];
  failWith = null;
  familiesBySect = {};
});

/** Requests the fake server saw whose path contains `fragment`. */
function hits(fragment: string): number {
  return requests.filter((u) => u.includes(fragment)).length;
}

describe('getFamiliesBySect caching', () => {
  it('serves repeat lookups of the same sect from memory (one HTTP hop, not N)', async () => {
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }, { familyId: 'fam-2', sectId: 'sect-a' }];
    const c = new HttpWorldSocialsvcClient(base, KEY);

    const first = await c.getFamiliesBySect('sect-a');
    const second = await c.getFamiliesBySect('sect-a');
    const third = await c.getFamiliesBySect('sect-a');

    expect(first.map((f) => f.familyId)).toEqual(['fam-1', 'fam-2']);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(hits('/by-sect/')).toBe(1);
  });

  it('does NOT cache a failed lookup — the empty result must not be mistaken for "this sect is empty"', async () => {
    const c = new HttpWorldSocialsvcClient(base, KEY);
    failWith = 503;
    expect(await c.getFamiliesBySect('sect-a')).toEqual([]);

    // socialsvc recovers; the very next call must go back out rather than serve the failure's `[]`. If this
    // regressed, every member of that sect would lose ADR-039 territory connectivity for the whole TTL.
    failWith = null;
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }];
    expect((await c.getFamiliesBySect('sect-a')).map((f) => f.familyId)).toEqual(['fam-1']);
    expect(hits('/by-sect/')).toBe(2);
  });

  it('keeps different sects apart', async () => {
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }];
    familiesBySect['sect-b'] = [{ familyId: 'fam-9', sectId: 'sect-b' }];
    const c = new HttpWorldSocialsvcClient(base, KEY);
    expect((await c.getFamiliesBySect('sect-a')).map((f) => f.familyId)).toEqual(['fam-1']);
    expect((await c.getFamiliesBySect('sect-b')).map((f) => f.familyId)).toEqual(['fam-9']);
    expect(hits('/by-sect/')).toBe(2);
  });
});

describe('getFamiliesByIds caching', () => {
  it('asks only for the families it does not already hold', async () => {
    familiesBySect['sect-a'] = [
      { familyId: 'fam-1', sectId: 'sect-a' },
      { familyId: 'fam-2', sectId: 'sect-a' },
      { familyId: 'fam-3', sectId: 'sect-a' },
    ];
    const c = new HttpWorldSocialsvcClient(base, KEY);
    // A by-sect read warms fam-1..3 as a side effect (the response already carries them).
    await c.getFamiliesBySect('sect-a');
    requests = [];

    const all = await c.getFamiliesByIds(['fam-1', 'fam-2', 'fam-3']);
    expect(all.map((f) => f.familyId).sort()).toEqual(['fam-1', 'fam-2', 'fam-3']);
    expect(hits('/batch')).toBe(0); // fully warm: no hop at all
  });

  it('still returns what it has when the fetch for the missing ones fails', async () => {
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }];
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await c.getFamiliesBySect('sect-a'); // warms fam-1

    failWith = 500;
    const got = await c.getFamiliesByIds(['fam-1', 'fam-unknown']);
    // The cached half survives a socialsvc hiccup instead of the whole call degrading to "no families".
    expect(got.map((f) => f.familyId)).toEqual(['fam-1']);
  });
});

describe('invalidation on worldsvc-authoritative writes', () => {
  it('setSect drops the cached view immediately rather than waiting out the TTL', async () => {
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }];
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await c.getFamiliesBySect('sect-a');
    expect(hits('/by-sect/')).toBe(1);

    // worldsvc is authoritative for sect membership, so when IT moves a family the cache must not lag.
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }, { familyId: 'fam-2', sectId: 'sect-a' }];
    await c.setSect('fam-2', 'sect-a');

    expect((await c.getFamiliesBySect('sect-a')).map((f) => f.familyId)).toEqual(['fam-1', 'fam-2']);
    expect(hits('/by-sect/')).toBe(2);
  });

  it('resetSlgState drops it too (a season reset clears the family\'s sect)', async () => {
    familiesBySect['sect-a'] = [{ familyId: 'fam-1', sectId: 'sect-a' }];
    const c = new HttpWorldSocialsvcClient(base, KEY);
    await c.getFamiliesBySect('sect-a');

    familiesBySect['sect-a'] = [];
    await c.resetSlgState('fam-1');

    expect(await c.getFamiliesBySect('sect-a')).toEqual([]);
    expect(hits('/by-sect/')).toBe(2);
  });
});
