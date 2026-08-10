// matchsvc internal HTTP boundary (S12-1 real-HTTP gap): every existing matchsvc test drives
// Matchsvc's methods directly in-process, so nothing ever actually sent an HTTP request at
// internalHttp.ts's listener. This suite starts a real node:http server (startInternalHttp) and hits
// it with real `fetch()` calls, covering:
//   • GET /health — no auth required;
//   • the X-Internal-Key gate (missing / wrong / correct) shared by every other route;
//   • GET /internal/stats (admin monitoring aggregate);
//   • POST command routing (/mm/room/*, /mm/queue/*, /mm/conn/*, /mm/duel/*, /mm/game/*) actually
//     reaching the underlying Matchsvc instance, not just returning {ok:true};
//   • /mm/game/register + /mm/game/heartbeat's own 400 body-validation branches;
//   • malformed JSON body / oversized body / unknown route / non-POST-non-GET method branches.
// Same pattern as botsvc/test/internalHttp.test.ts (real server + global fetch, no DB dependency).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createInternalAuth } from '@nw/shared';
import { startInternalHttp } from '../src/internalHttp';
import { Matchsvc, type PushMsg } from '../src/Matchsvc';
import { GameRegistry } from '../src/GameRegistry';

const KEY = 'test-internal-key';
const GAME_URL = 'ws://game:8081/ws';

describe('matchsvc internalHttp', () => {
  let server: Server;
  let base: string;
  let svc: Matchsvc;
  let pushed: { acc: string; msg: PushMsg }[];

  beforeEach(async () => {
    pushed = [];
    const games = new GameRegistry(() => 0, GAME_URL);
    svc = new Matchsvc((acc, msg) => pushed.push({ acc, msg }), games, KEY, { autoTick: false });
    server = startInternalHttp(
      { host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) },
      svc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const hdr = (key?: string) => ({
    'content-type': 'application/json',
    ...(key ? { 'X-Internal-Key': key } : {}),
  });
  const post = (path: string, body: unknown, key: string | undefined = KEY) =>
    fetch(`${base}${path}`, { method: 'POST', headers: hdr(key), body: JSON.stringify(body) });

  // ── /health ──────────────────────────────────────────────────────────────

  it('GET /health: 200, no auth required', async () => {
    const r = await fetch(`${base}/health`, { headers: hdr() }); // deliberately no key
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: 'matchsvc' });
  });

  // ── Auth gate (shared by every other route) ─────────────────────────────

  it('missing X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/stats`, { headers: hdr() });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('wrong X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/stats`, { headers: hdr('wrong-key') });
    expect(r.status).toBe(401);
  });

  it('correct X-Internal-Key → passes the auth gate', async () => {
    const r = await fetch(`${base}/internal/stats`, { headers: hdr(KEY) });
    expect(r.status).toBe(200);
  });

  it('auth gate rejects a POST command route too (not just GET /internal/stats)', async () => {
    const r = await fetch(`${base}/mm/room/create`, {
      method: 'POST',
      headers: hdr(), // deliberately no key
      body: JSON.stringify({ accountId: 'a', name: 'A', publicId: '1' }),
    });
    expect(r.status).toBe(401);
  });

  // ── GET /internal/stats ──────────────────────────────────────────────────

  it('GET /internal/stats: reflects live Matchsvc state', async () => {
    svc.roomCreate('a', 'Alice', '100000001');
    const r = await fetch(`${base}/internal/stats`, { headers: hdr(KEY) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ rooms: 1, queue: 0 });
  });

  // ── Method / routing edge cases ──────────────────────────────────────────

  it('GET on an unrecognized path (with valid key, not /internal/stats) → 404 (falls through the non-POST branch)', async () => {
    const r = await fetch(`${base}/mm/room/create`, { headers: hdr(KEY) }); // GET, not POST
    expect(r.status).toBe(404);
  });

  it('POST to an unknown route → 404', async () => {
    const r = await post('/mm/nope', {});
    expect(r.status).toBe(404);
  });

  it('malformed JSON body → 400 with the parse error surfaced', async () => {
    const r = await fetch(`${base}/mm/room/create`, {
      method: 'POST',
      headers: hdr(KEY),
      body: 'not-json{{{',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it('empty body on a route that reads b.* → treated as {} (no crash, all str()/num() defaults apply)', async () => {
    const r = await fetch(`${base}/mm/conn/connected`, {
      method: 'POST',
      headers: hdr(KEY),
      body: '',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('oversized body (> 1MB) → connection aborted, fetch rejects (P0-9 unbounded-buffer guard)', async () => {
    const huge = 'x'.repeat((1 << 20) + 10);
    await expect(
      fetch(`${base}/mm/room/create`, {
        method: 'POST',
        headers: hdr(KEY),
        body: JSON.stringify({ accountId: 'a', name: 'A', publicId: '1', deck: [huge] }),
      }),
    ).rejects.toThrow();
  });

  // ── Command routing reaches the real Matchsvc instance ───────────────────

  it('POST /mm/room/create routes through to Matchsvc.roomCreate (room actually created, room_state pushed)', async () => {
    const r = await post('/mm/room/create', { accountId: 'a', name: 'Alice', publicId: '100000001' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(svc.stats().rooms).toBe(1);
    expect(pushed.some((p) => p.acc === 'a' && p.msg.kind === 'room_state')).toBe(true);
  });

  it('POST /mm/room/join routes through to Matchsvc.roomJoin', async () => {
    await post('/mm/room/create', { accountId: 'a', name: 'Alice', publicId: '100000001' });
    const rs = pushed.find((p) => p.acc === 'a' && p.msg.kind === 'room_state')!.msg;
    if (rs.kind !== 'room_state') throw new Error();

    const r = await post('/mm/room/join', { accountId: 'b', name: 'Bob', publicId: '100000002', code: rs.code });
    expect(r.status).toBe(200);
    expect(pushed.some((p) => p.acc === 'b' && p.msg.kind === 'room_state')).toBe(true);
  });

  it('POST /mm/room/ready + /mm/room/start route through and actually start a match', async () => {
    await post('/mm/room/create', { accountId: 'a', name: 'Alice', publicId: '100000001' });
    const rs = pushed.find((p) => p.acc === 'a' && p.msg.kind === 'room_state')!.msg;
    if (rs.kind !== 'room_state') throw new Error();
    await post('/mm/room/join', { accountId: 'b', name: 'Bob', publicId: '100000002', code: rs.code });

    expect((await post('/mm/room/ready', { accountId: 'a', ready: true })).status).toBe(200);
    expect((await post('/mm/room/ready', { accountId: 'b', ready: true })).status).toBe(200);
    expect((await post('/mm/room/start', { accountId: 'a' })).status).toBe(200);

    expect(pushed.some((p) => p.acc === 'a' && p.msg.kind === 'match_found')).toBe(true);
    expect(pushed.some((p) => p.acc === 'b' && p.msg.kind === 'match_found')).toBe(true);
  });

  it('POST /mm/room/leave routes through to Matchsvc.roomLeave', async () => {
    await post('/mm/room/create', { accountId: 'a', name: 'Alice', publicId: '100000001' });
    expect(svc.stats().rooms).toBe(1);
    const r = await post('/mm/room/leave', { accountId: 'a' });
    expect(r.status).toBe(200);
    expect(svc.stats().rooms).toBe(0);
  });

  it('POST /mm/queue/enqueue routes through to Matchsvc.enqueue', async () => {
    const r = await post('/mm/queue/enqueue', { accountId: 'a', name: 'Alice', publicId: '100000001', elo: 1000 });
    expect(r.status).toBe(200);
    expect(svc.stats().queue).toBe(1);
  });

  it('POST /mm/conn/connected + /mm/conn/disconnected route through without error', async () => {
    await post('/mm/room/create', { accountId: 'a', name: 'Alice', publicId: '100000001' });
    expect((await post('/mm/conn/connected', { accountId: 'a' })).status).toBe(200);
    expect((await post('/mm/conn/disconnected', { accountId: 'a' })).status).toBe(200);
  });

  it('POST /mm/duel/invite + /mm/duel/respond route through to DuelService', async () => {
    const inviteRes = await post('/mm/duel/invite', {
      accountId: 'a', name: 'Alice', publicId: '100000001', toAccountId: 'b',
    });
    expect(inviteRes.status).toBe(200);
    const inv = pushed.find((p) => p.acc === 'b' && p.msg.kind === 'duel_invited')!.msg;
    if (inv.kind !== 'duel_invited') throw new Error();

    const respondRes = await post('/mm/duel/respond', {
      accountId: 'b', inviteId: inv.inviteId, accept: true, name: 'Bob', publicId: '100000002',
    });
    expect(respondRes.status).toBe(200);
    expect(pushed.some((p) => p.acc === 'a' && p.msg.kind === 'match_found')).toBe(true);
  });

  // ── /mm/game/register + /mm/game/heartbeat body validation ───────────────

  it('POST /mm/game/register missing gameId → 400, no instance registered', async () => {
    const r = await post('/mm/game/register', { wsUrl: 'ws://g:1/ws' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'gameId and wsUrl required' });
    expect(svc.stats().gameInstances).toBe(0);
  });

  it('POST /mm/game/register missing wsUrl → 400, no instance registered', async () => {
    const r = await post('/mm/game/register', { gameId: 'g1' });
    expect(r.status).toBe(400);
    expect(svc.stats().gameInstances).toBe(0);
  });

  it('POST /mm/game/register with both fields → 200, instance is registered and counted in stats', async () => {
    const r = await post('/mm/game/register', { gameId: 'g1', wsUrl: 'ws://g1:1/ws', capacity: 50 });
    expect(r.status).toBe(200);
    expect(svc.stats().gameInstances).toBe(1);
  });

  it('POST /mm/game/heartbeat missing gameId → 400', async () => {
    const r = await post('/mm/game/heartbeat', { load: 5, rooms: 2 });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'gameId required' });
  });

  it('POST /mm/game/heartbeat for a registered instance → 200, updates load reflected in stats', async () => {
    await post('/mm/game/register', { gameId: 'g1', wsUrl: 'ws://g1:1/ws', capacity: 50 });
    const r = await post('/mm/game/heartbeat', { gameId: 'g1', load: 7, rooms: 3 });
    expect(r.status).toBe(200);
    expect(svc.stats().gameLoad).toBe(7);
  });

  it('POST /mm/game/heartbeat for an unknown gameId → 200 no-op (heartbeat() silently ignores unregistered ids)', async () => {
    const r = await post('/mm/game/heartbeat', { gameId: 'ghost', load: 7, rooms: 1 });
    expect(r.status).toBe(200);
    expect(svc.stats().gameInstances).toBe(0);
  });
});
