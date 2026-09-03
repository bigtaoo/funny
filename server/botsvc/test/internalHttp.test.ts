// botsvc internal admin API (BOTSVC_DESIGN §2): real node:http server + global fetch calls.
//   • X-Internal-Key gate: missing/wrong key → 401; correct key → passes through (same pattern as
//     every other internal-only port in this codebase, see commercial/test/internalHttp.e2e.test.ts).
//   • GET /internal/bots/status, POST /scale, /pause, /resume — driven against a REAL Scheduler
//     wired to a fake pool + fake capacity client (same fakeSession/fakeCapacity shape as scheduler.test.ts),
//     so this exercises the actual Scheduler methods the HTTP layer calls, not a hand-rolled stub.
//   • GET /health: no auth required, 200 smoke check.
// No Mongo/DB dependency (botsvc's internal HTTP layer doesn't connect to a store), so this suite
// always runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createInternalAuth } from '@nw/shared';
import { startInternalHttp } from '../src/internalHttp';
import { Scheduler, type SchedulerOptions } from '../src/scheduler';
import type { BotSession } from '../src/bot';
import type { CapacityClient } from '../src/capacityClient';

const KEY = 'test-internal-key';

const OPTS: SchedulerOptions = {
  targetOnline: 5,
  shedStartAt: 2500,
  shedFullAt: 2800,
  batchSize: 10,
  upkeepConcurrency: 3,
  upkeepRotations: 1,
};

/** Minimal stand-in exposing only the surface Scheduler drives (same shape as scheduler.test.ts's fakeSession). */
function fakeSession(id: number): BotSession {
  const obj = {
    id,
    state: 'offline' as string,
    login: async () => { obj.state = 'lobby_idle'; },
    logout: () => { obj.state = 'offline'; },
    tickFamily: async () => undefined,
    tickSlg: async () => undefined,
    tickBattle: () => undefined,
  };
  return obj as unknown as BotSession;
}

function fakeCapacity(onlineCount: () => Promise<number> = async () => 0): CapacityClient {
  return { onlineCount } as unknown as CapacityClient;
}

describe('botsvc internalHttp', () => {
  let server: Server;
  let base: string;
  let scheduler: Scheduler;

  beforeEach(async () => {
    const pool = Array.from({ length: 3 }, (_, i) => fakeSession(i));
    scheduler = new Scheduler(pool, fakeCapacity(), OPTS);
    server = startInternalHttp(
      { host: '127.0.0.1', port: 0, internalAuth: createInternalAuth({ legacyKey: KEY }) },
      scheduler,
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

  // ── Auth gate ──────────────────────────────────────────────────────────────

  it('missing X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/bots/status`, { headers: hdr() });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  it('wrong X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/bots/status`, { headers: hdr('wrong-key') });
    expect(r.status).toBe(401);
  });

  it('correct X-Internal-Key → passes the auth gate', async () => {
    const r = await fetch(`${base}/internal/bots/status`, { headers: hdr(KEY) });
    expect(r.status).toBe(200);
  });

  // ── /health ──────────────────────────────────────────────────────────────

  it('GET /health: 200 smoke check, no auth required', async () => {
    const r = await fetch(`${base}/health`, { headers: hdr() }); // deliberately no key
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: 'botsvc' });
  });

  // ── /internal/bots/status ──────────────────────────────────────────────────

  it('GET /internal/bots/status: returns the expected shape', async () => {
    const r = await fetch(`${base}/internal/bots/status`, { headers: hdr(KEY) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      total: 3,
      online: 0,
      targetOnline: OPTS.targetOnline,
      effectiveTarget: OPTS.targetOnline,
      paused: false,
    });
  });

  // ── POST /internal/bots/scale ────────────────────────────────────────────

  it('POST /scale: changes the scheduler\'s target online count', async () => {
    const r = await fetch(`${base}/internal/bots/scale`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({ targetOnline: 42 }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(scheduler.status().targetOnline).toBe(42);
  });

  it('POST /scale: missing targetOnline → 400, target left unchanged', async () => {
    const r = await fetch(`${base}/internal/bots/scale`, {
      method: 'POST',
      headers: hdr(KEY),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(scheduler.status().targetOnline).toBe(OPTS.targetOnline);
  });

  // ── POST /internal/bots/pause + /resume ──────────────────────────────────

  it('POST /pause then /resume: toggles the scheduler\'s paused state', async () => {
    expect(scheduler.status().paused).toBe(false);

    const pauseRes = await fetch(`${base}/internal/bots/pause`, { method: 'POST', headers: hdr(KEY) });
    expect(pauseRes.status).toBe(200);
    expect(scheduler.status().paused).toBe(true);

    const statusRes = await fetch(`${base}/internal/bots/status`, { headers: hdr(KEY) });
    expect((await statusRes.json())).toMatchObject({ paused: true });

    const resumeRes = await fetch(`${base}/internal/bots/resume`, { method: 'POST', headers: hdr(KEY) });
    expect(resumeRes.status).toBe(200);
    expect(scheduler.status().paused).toBe(false);
  });

  // ── Unknown route ─────────────────────────────────────────────────────────

  it('unknown route (with valid key) → 404', async () => {
    const r = await fetch(`${base}/internal/bots/nope`, { headers: hdr(KEY) });
    expect(r.status).toBe(404);
  });

  // ── Request-body edge cases (readJson) ───────────────────────────────────

  it('POST /scale with a malformed JSON body → 400 carrying the parse error', async () => {
    // The route handler never sees this: readJson rejects and the outer catch turns it into a 400.
    // Worth pinning because the alternative (an unhandled rejection inside the request callback) is a
    // process-level crash on a port ops can reach with curl.
    const r = await fetch(`${base}/internal/bots/scale`, { method: 'POST', headers: hdr(KEY), body: '{ not json' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ ok: false });
    expect(scheduler.status().targetOnline).toBe(OPTS.targetOnline);
  });

  it('POST /scale with an oversized body is destroyed at the 1MB cap instead of buffering it', async () => {
    // P0-9: this port had no cap at all, so `body` grew unbounded. The cap has to fire while the
    // upload is still streaming — the assertion is that the connection dies mid-request rather than
    // that a tidy response comes back, because "we answered politely after accepting 900MB" is
    // exactly the failure being prevented.
    const oversized = JSON.stringify({ targetOnline: 1, pad: 'x'.repeat((1 << 20) + 1024) });
    await expect(
      fetch(`${base}/internal/bots/scale`, { method: 'POST', headers: hdr(KEY), body: oversized }),
    ).rejects.toThrow();
    expect(scheduler.status().targetOnline).toBe(OPTS.targetOnline);
  });

  it('POST /pause with an empty body still works (readJson is only reached by /scale)', async () => {
    const r = await fetch(`${base}/internal/bots/pause`, { method: 'POST', headers: hdr(KEY), body: '' });
    expect(r.status).toBe(200);
    expect(scheduler.status().paused).toBe(true);
  });

  it('POST /scale with an empty body → 400 (empty string parses to {}, not a parse error)', async () => {
    const r = await fetch(`${base}/internal/bots/scale`, { method: 'POST', headers: hdr(KEY), body: '' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ ok: false, error: 'targetOnline required' });
  });
});
