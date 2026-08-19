// internalHttp.ts wire-level tests (S12-1 backlog item, server-test-audit-2026-08-05):
// every existing test for this file only ever imported Gateway/PeerJudge methods and called them
// in-process — the actual `startInternalHttp` HTTP server (createServer + route table + X-Internal-Key
// auth) registered in src/internalHttp.ts had NEVER been exercised by a real HTTP request. This mirrors
// the T1 NW_REDIS_URL incident (wired up but never actually run) at the transport layer: a route table
// bug, an auth bypass, or a body-parsing regression here would have shipped with a fully green suite.
//
// Approach: start a REAL `http.Server` via startInternalHttp() on an OS-assigned port (0), hit it with
// real `fetch()` from outside the process, and only mock the layer BELOW the HTTP boundary — the
// `Gateway` instance itself (push/stats/presenceOf/invalidateFriends/judge) — so the transport (listen,
// accept, parse headers/body, route, write response) is exercised for real end to end.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { createInternalAuth, INTERNAL_KEY_HEADER, INTERNAL_CALLER_HEADER, type InternalAuthVerifier } from '@nw/shared';
import { startInternalHttp } from '../src/internalHttp';
import type { Gateway, JudgeArgs, JudgeResult } from '../src/Gateway';
import type { PushMsg } from '../src/matchsvcClient';

const LEGACY_KEY = 'legacy-shared-key';

/** Records every call made through the Gateway surface that internalHttp.ts touches; everything below
 *  this boundary (real sockets, matchsvc, meta) is intentionally not involved — only the HTTP layer is real. */
class FakeGateway {
  readonly pushCalls: { accountId: string; msg: PushMsg; roomId?: string }[] = [];
  readonly presenceCalls: string[][] = [];
  readonly invalidateCalls: string[] = [];
  statsResult: { online: number } = { online: 7 };
  presenceResult: Record<string, boolean> = {};
  judgeResult: JudgeResult = { ok: false };
  judgeCalls: JudgeArgs[] = [];

  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => {
    this.pushCalls.push({ accountId, msg, roomId });
  };
  readonly stats = (): { online: number } => this.statsResult;
  readonly presenceOf = async (accountIds: string[]): Promise<Record<string, boolean>> => {
    this.presenceCalls.push(accountIds);
    return this.presenceResult;
  };
  readonly invalidateFriends = (accountId: string): void => {
    this.invalidateCalls.push(accountId);
  };
  readonly judge = async (args: JudgeArgs): Promise<JudgeResult> => {
    this.judgeCalls.push(args);
    return this.judgeResult;
  };
}

let server: ReturnType<typeof startInternalHttp> | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

/** Starts the real internalHttp server on an OS-assigned port and returns its base URL + the fake gateway.
 *  `server.listen()` inside startInternalHttp() is asynchronous — the socket isn't bound yet by the time
 *  startInternalHttp() returns, so `.address()` would race the actual bind without waiting for 'listening'. */
function start(auth: InternalAuthVerifier): Promise<{ base: string; gw: FakeGateway }> {
  const gw = new FakeGateway();
  const s = startInternalHttp({ host: '127.0.0.1', port: 0, internalAuth: auth }, gw as unknown as Gateway);
  server = s;
  return new Promise((resolve) => {
    s.on('listening', () => {
      const { port } = s.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, gw });
    });
  });
}

function legacyAuth(): InternalAuthVerifier {
  return createInternalAuth({ legacyKey: LEGACY_KEY });
}

function authedHeaders(extra?: Record<string, string>): Record<string, string> {
  return { [INTERNAL_KEY_HEADER]: LEGACY_KEY, 'content-type': 'application/json', ...extra };
}

describe('gateway internalHttp — real HTTP transport', () => {
  describe('auth gate (X-Internal-Key)', () => {
    it('GET /health requires no auth', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service: 'gateway' });
    });

    it('missing X-Internal-Key on a protected route → 401', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/internal/stats`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('wrong X-Internal-Key → 401, and the route handler is never reached', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/internal/stats`, { headers: { [INTERNAL_KEY_HEADER]: 'not-the-key' } });
      expect(res.status).toBe(401);
      expect(gw.statsResult).toEqual({ online: 7 }); // stats() was never called to prove it, but nothing crashed either
    });

    it('correct legacy key → request proceeds past the gate', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/internal/stats`, { headers: authedHeaders() });
      expect(res.status).toBe(200);
    });

    it('per-caller strict mode (NW_INTERNAL_KEYS style registry): each registered caller’s own key is accepted', async () => {
      const auth = createInternalAuth({ keys: { worldsvc: 'ws-key', gateway: 'gw-key' }, legacyKey: LEGACY_KEY });
      const { base } = await start(auth);

      const asWorldsvc = await fetch(`${base}/internal/stats`, { headers: { [INTERNAL_KEY_HEADER]: 'ws-key' } });
      expect(asWorldsvc.status).toBe(200);

      const asGateway = await fetch(`${base}/internal/stats`, { headers: { [INTERNAL_KEY_HEADER]: 'gw-key' } });
      expect(asGateway.status).toBe(200);
    });

    it('per-caller strict mode rejects the legacy shared key (migration requires every caller to carry its own registry key)', async () => {
      const auth = createInternalAuth({ keys: { worldsvc: 'ws-key' }, legacyKey: LEGACY_KEY });
      const { base } = await start(auth);
      const res = await fetch(`${base}/internal/stats`, { headers: { [INTERNAL_KEY_HEADER]: LEGACY_KEY } });
      expect(res.status).toBe(401);
    });

    it('per-caller strict mode rejects an unregistered key', async () => {
      const auth = createInternalAuth({ keys: { worldsvc: 'ws-key' }, legacyKey: LEGACY_KEY });
      const { base } = await start(auth);
      const res = await fetch(`${base}/internal/stats`, { headers: { [INTERNAL_KEY_HEADER]: 'someone-elses-key' } });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /gw/push', () => {
    it('valid body + valid key → 200, gateway.push called with accountId/msg/roomId', async () => {
      const { base, gw } = await start(legacyAuth());
      const msg: PushMsg = { kind: 'room_error', code: 'X', message: 'hello' };
      const res = await fetch(`${base}/gw/push`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ accountId: 'acc-1', msg, roomId: 'room-9' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(gw.pushCalls).toEqual([{ accountId: 'acc-1', msg, roomId: 'room-9' }]);
    });

    it('missing accountId → 400, gateway.push never called', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ msg: { kind: 'room_error', code: 'X', message: 'm' } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'accountId and msg required' });
      expect(gw.pushCalls).toEqual([]);
    });

    it('missing msg → 400', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ accountId: 'acc-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('malformed JSON body → 400 with the parse error surfaced', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push`, {
        method: 'POST',
        headers: authedHeaders(),
        body: '{not-json',
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(typeof json.error).toBe('string');
    });

    it('valid key but wrong HTTP method → falls through to 404, not treated as an auth or body error', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push`, { method: 'GET', headers: authedHeaders() });
      expect(res.status).toBe(404);
    });

    it('oversized body (>1MB) → connection is reset by the server instead of buffering unbounded (P0-9 OOM guard), and the server keeps serving other requests afterwards', async () => {
      const { base } = await start(legacyAuth());
      const big = 'x'.repeat(2 * 1024 * 1024);
      await expect(
        fetch(`${base}/gw/push`, { method: 'POST', headers: authedHeaders(), body: big }),
      ).rejects.toThrow();

      // Server process itself must have survived the oversized request untouched.
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
    });
  });

  describe('POST /gw/push/batch', () => {
    it('fans out to gateway.push once per target', async () => {
      const { base, gw } = await start(legacyAuth());
      const targets = [
        { accountId: 'a', msg: { kind: 'room_error', code: 'X', message: '1' } as PushMsg },
        { accountId: 'b', msg: { kind: 'room_error', code: 'Y', message: '2' }, roomId: 'r1' },
      ];
      const res = await fetch(`${base}/gw/push/batch`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ targets }),
      });
      expect(res.status).toBe(200);
      expect(gw.pushCalls).toHaveLength(2);
      expect(gw.pushCalls[0]).toEqual({ accountId: 'a', msg: targets[0]!.msg, roomId: undefined });
      expect(gw.pushCalls[1]).toEqual({ accountId: 'b', msg: targets[1]!.msg, roomId: 'r1' });
    });

    it('empty targets array → 400', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push/batch`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ targets: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('missing targets field entirely → 400', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push/batch`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('a malformed entry inside targets (missing accountId/msg) is silently skipped, valid entries still delivered', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/push/batch`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({
          targets: [{ accountId: 'only-id' }, { accountId: 'ok', msg: { kind: 'room_error', code: 'X', message: 'm' } }],
        }),
      });
      expect(res.status).toBe(200);
      expect(gw.pushCalls).toHaveLength(1);
      expect(gw.pushCalls[0]!.accountId).toBe('ok');
    });
  });

  describe('GET /internal/stats', () => {
    it('returns gateway.stats() verbatim', async () => {
      const { base, gw } = await start(legacyAuth());
      gw.statsResult = { online: 42 };
      const res = await fetch(`${base}/internal/stats`, { headers: authedHeaders() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ online: 42 });
    });
  });

  describe('GET /gw/presence', () => {
    it('parses the comma-separated accounts query param and returns gateway.presenceOf()', async () => {
      const { base, gw } = await start(legacyAuth());
      gw.presenceResult = { a: true, b: false, c: true };
      const res = await fetch(`${base}/gw/presence?accounts=a,b,c`, { headers: authedHeaders() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ a: true, b: false, c: true });
      expect(gw.presenceCalls).toEqual([['a', 'b', 'c']]);
    });

    it('missing accounts param → presenceOf called with an empty array, not undefined/crash', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/presence`, { headers: authedHeaders() });
      expect(res.status).toBe(200);
      expect(gw.presenceCalls).toEqual([[]]);
    });
  });

  describe('POST /gw/social/invalidate', () => {
    it('valid accountId → gateway.invalidateFriends called, 200', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/social/invalidate`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ accountId: 'acc-1' }),
      });
      expect(res.status).toBe(200);
      expect(gw.invalidateCalls).toEqual(['acc-1']);
    });

    it('missing accountId → still 200 (route has no required-field check) but invalidateFriends is never invoked', async () => {
      const { base, gw } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/social/invalidate`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(gw.invalidateCalls).toEqual([]);
    });
  });

  describe('POST /gw/judge', () => {
    it('decodes base64 frame commands and forwards a fully-populated JudgeArgs to gateway.judge, returns its verdict verbatim', async () => {
      const { base, gw } = await start(legacyAuth());
      gw.judgeResult = { ok: true, stateHash: 'H', winnerSide: 1, stars: 3, statsJson: '{}', judgeAccountId: 'j1' };

      const commandsB64 = Buffer.from('abc').toString('base64');
      const res = await fetch(`${base}/gw/judge`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({
          seed: 7,
          mode: 1,
          endFrame: 99,
          frames: [{ frame: 0, cmds: [{ side: 0, commands: commandsB64 }] }],
          exclude: ['a', 'b'],
          levelId: 'ch1_lv2',
          cardInstancesJson: '{"card_1":{}}',
          equipmentInvJson: '{"eq_1":{}}',
          defenseJson: '{"hp":100}',
          decks: { top: ['t1'], bottom: ['b1'] },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(gw.judgeResult);
      expect(gw.judgeCalls).toHaveLength(1);
      const args = gw.judgeCalls[0]!;
      expect(args.seed).toBe(7);
      expect(args.mode).toBe(1);
      expect(args.endFrame).toBe(99);
      expect(args.exclude).toEqual(['a', 'b']);
      expect(args.levelId).toBe('ch1_lv2');
      expect(args.cardInstancesJson).toBe('{"card_1":{}}');
      expect(args.equipmentInvJson).toBe('{"eq_1":{}}');
      expect(args.defenseJson).toBe('{"hp":100}');
      expect(args.decks).toEqual({ top: ['t1'], bottom: ['b1'] });
      expect(args.frames).toHaveLength(1);
      expect(args.frames[0]!.frame).toBe(0);
      expect(args.frames[0]!.cmds[0]!.side).toBe(0);
      expect(Buffer.from(args.frames[0]!.cmds[0]!.commands).toString()).toBe('abc');
    });

    it('minimal body (no optional fields) → defaults applied, no optional keys leak through as present-but-undefined', async () => {
      const { base, gw } = await start(legacyAuth());
      gw.judgeResult = { ok: false };
      const res = await fetch(`${base}/gw/judge`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false });
      const args = gw.judgeCalls[0]!;
      expect(args).toEqual({ seed: 0, mode: 0, endFrame: 0, frames: [], exclude: [] });
    });
  });

  describe('unknown routes', () => {
    it('unregistered path with valid auth → 404', async () => {
      const { base } = await start(legacyAuth());
      const res = await fetch(`${base}/gw/nope`, { headers: authedHeaders() });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'not found' });
    });
  });

  // Sanity: the x-internal-caller header is advisory-only in fallback (non-strict) mode — it does not
  // gate anything, it's just an audit hint. Confirms the HTTP layer forwards it through unmodified.
  it('fallback mode: caller hint header does not affect authorization outcome either way', async () => {
    const { base } = await start(legacyAuth());
    const withHint = await fetch(`${base}/internal/stats`, {
      headers: { [INTERNAL_KEY_HEADER]: LEGACY_KEY, [INTERNAL_CALLER_HEADER]: 'worldsvc' },
    });
    expect(withHint.status).toBe(200);
    const withBogusHint = await fetch(`${base}/internal/stats`, {
      headers: { [INTERNAL_KEY_HEADER]: LEGACY_KEY, [INTERNAL_CALLER_HEADER]: 'not-a-real-caller' },
    });
    expect(withBogusHint.status).toBe(200);
  });
});
