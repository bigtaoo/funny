// Token revocation list (tokenRevocation.ts, ACCOUNT_DESIGN §C5-b): iat semantics, fail-open before the
// first load, keep-last-known on failure, incremental `since` with overlap, TTL pruning, the verify
// helper, and the HTTP source against a real local server (headers + query string).
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TOKEN_REVOCATION_POLL_OVERLAP_MS,
  TOKEN_REVOCATION_RETENTION_MS,
  TOKEN_REVOCATIONS_PATH,
  TokenRevocationList,
  TokenRevokedError,
  httpTokenRevocationSource,
  verifyUnrevokedToken,
  type TokenRevocationPage,
} from '../src/tokenRevocation';
import { signToken } from '../src/jwt';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const sec = (ms: number) => Math.floor(ms / 1000);

/** Scripted source: records every `since` it was asked for and answers from a queue (default: empty page). */
function scripted(pages: (TokenRevocationPage | null | Error)[]) {
  const asked: number[] = [];
  const source = async (since: number) => {
    asked.push(since);
    const next = pages.shift();
    if (next instanceof Error) throw next;
    return next === undefined ? { asOf: NOW, revocations: [] } : next;
  };
  return { asked, source };
}

describe('TokenRevocationList', () => {
  it('revokes tokens issued at or before revokedAt, not ones minted afterwards', async () => {
    const { source } = scripted([{ asOf: NOW, revocations: [{ accountId: 'a', revokedAt: NOW - 1000 }] }]);
    const list = new TokenRevocationList(source, { now: () => NOW });
    expect(await list.refresh()).toBe(true);
    expect(list.isRevoked('a', sec(NOW - 60_000))).toBe(true);
    expect(list.isRevoked('a', sec(NOW - 1000))).toBe(true); // same second rounds towards revoked
    expect(list.isRevoked('a', undefined)).toBe(true); // no iat = issued at 0
    expect(list.isRevoked('a', sec(NOW + 5000))).toBe(false);
    expect(list.isRevoked('b', sec(NOW - 60_000))).toBe(false);
  });

  it('is fail-open until the first successful load, then keeps the last list through failures', async () => {
    const { source } = scripted([
      null,
      { asOf: NOW, revocations: [{ accountId: 'a', revokedAt: NOW }] },
      null,
      new Error('boom'),
    ]);
    const list = new TokenRevocationList(source, { now: () => NOW });
    expect(await list.refresh()).toBe(false);
    expect(list.ready).toBe(false);
    expect(list.isRevoked('a', 0)).toBe(false);
    expect(await list.refresh()).toBe(true);
    expect(list.ready).toBe(true);
    expect(await list.refresh()).toBe(false);
    expect(await list.refresh()).toBe(false); // a throwing source counts as a failed poll too
    expect(list.isRevoked('a', 0)).toBe(true);
  });

  it('polls incrementally from the previous asOf minus the overlap, and a failed poll does not move the cursor', async () => {
    const { asked, source } = scripted([
      { asOf: NOW, revocations: [] },
      null,
      { asOf: NOW + 60_000, revocations: [{ accountId: 'late', revokedAt: NOW - 1000 }] },
    ]);
    const list = new TokenRevocationList(source, { now: () => NOW + 60_000 });
    await list.refresh();
    await list.refresh();
    await list.refresh();
    await list.refresh();
    expect(asked).toEqual([
      0,
      NOW - TOKEN_REVOCATION_POLL_OVERLAP_MS,
      NOW - TOKEN_REVOCATION_POLL_OVERLAP_MS,
      NOW + 60_000 - TOKEN_REVOCATION_POLL_OVERLAP_MS,
    ]);
    // A row stamped before the previous asOf but committed after it is still picked up (the overlap).
    expect(list.isRevoked('late', 0)).toBe(true);
  });

  it('keeps the newest revokedAt per account and ignores malformed rows', async () => {
    const { source } = scripted([
      {
        asOf: NOW,
        revocations: [
          { accountId: 'a', revokedAt: NOW - 5000 },
          { accountId: 'a', revokedAt: NOW - 1000 },
          { accountId: 'a', revokedAt: NOW - 9000 },
          { accountId: 42, revokedAt: NOW } as never,
        ],
      },
    ]);
    const list = new TokenRevocationList(source, { now: () => NOW });
    await list.refresh();
    expect(list.size).toBe(1);
    expect(list.isRevoked('a', sec(NOW - 3000))).toBe(true);
  });

  it('prunes rows older than the retention window, like the server-side TTL', async () => {
    let now = NOW;
    const { source } = scripted([{ asOf: NOW, revocations: [{ accountId: 'a', revokedAt: NOW }] }]);
    const list = new TokenRevocationList(source, { now: () => now });
    await list.refresh();
    expect(list.size).toBe(1);
    now = NOW + TOKEN_REVOCATION_RETENTION_MS + 1;
    await list.refresh();
    expect(list.size).toBe(0);
  });

  it('shares one in-flight request between overlapping refresh calls', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = new TokenRevocationList(async () => {
      calls++;
      await gate;
      return { asOf: NOW, revocations: [] };
    });
    const a = list.refresh();
    const b = list.refresh();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe('verifyUnrevokedToken', () => {
  const jwt = { secret: 'test-secret' };

  it('returns the accountId for a valid unrevoked token, TokenRevokedError for a revoked one', async () => {
    const token = signToken('a', jwt);
    const list = new TokenRevocationList(async () => ({ asOf: Date.now(), revocations: [{ accountId: 'a', revokedAt: Date.now() + 1000 }] }));
    expect(verifyUnrevokedToken(token, jwt, null)).toBe('a');
    expect(verifyUnrevokedToken(token, jwt, list)).toBe('a'); // not loaded yet: fail-open
    await list.refresh();
    expect(() => verifyUnrevokedToken(token, jwt, list)).toThrow(TokenRevokedError);
    expect(verifyUnrevokedToken(signToken('b', jwt), jwt, list)).toBe('b');
  });

  it('still throws the ordinary verify error (not TokenRevokedError) for a bad signature', () => {
    const token = signToken('a', { secret: 'other' });
    expect(() => verifyUnrevokedToken(token, jwt, null)).toThrow();
    try {
      verifyUnrevokedToken(token, jwt, null);
    } catch (e) {
      expect(e).not.toBeInstanceOf(TokenRevokedError);
    }
  });
});

describe('httpTokenRevocationSource', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('GETs the internal path with since + internal-auth headers and returns the page', async () => {
    const seen: { url?: string; key?: string | string[]; caller?: string | string[] } = {};
    const base = await serve((req, res) => {
      seen.url = req.url;
      seen.key = req.headers['x-internal-key'];
      seen.caller = req.headers['x-internal-caller'];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ asOf: 5, revocations: [{ accountId: 'a', revokedAt: 4 }] }));
    });
    const page = await httpTokenRevocationSource(`${base}/`, { caller: 'worldsvc', key: 'k' })(123);
    expect(page).toEqual({ asOf: 5, revocations: [{ accountId: 'a', revokedAt: 4 }] });
    expect(seen.url).toBe(`${TOKEN_REVOCATIONS_PATH}?since=123`);
    expect(seen.key).toBe('k');
    expect(seen.caller).toBe('worldsvc');
  });

  it('answers null on a non-2xx and on an unreachable host', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    });
    expect(await httpTokenRevocationSource(base, { caller: 'worldsvc', key: 'k' })(0)).toBeNull();
    expect(await httpTokenRevocationSource('http://127.0.0.1:1', { caller: 'worldsvc', key: 'k', timeoutMs: 500 })(0)).toBeNull();
  });
});
