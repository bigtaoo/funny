// ConnRegistry gap-fill (previously 69.0% — gateway-routing.test.ts/rate-limit.test.ts/judge.test.ts only
// ever exercise `push` on an already-online recipient and never call `routeBroadcast` or `presenceOf`'s
// cross-instance branch at all). Covers: push-to-offline warn/drop, routeBroadcast's per-recipient online
// filter, presenceOf's local-vs-cross-instance split (via a hand-built GatewaySubscriber fake — no real
// Redis needed), a malformed binary frame being silently ignored (decodeClient throws, caught), and the WS
// handshake rejection path (missing/invalid token -> 4401). Same real-Gateway-plus-real-WS harness as
// gateway-routing.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { signToken, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';
import type { GatewaySubscriber } from '../src/redis';
import { HEARTBEAT_MS } from '../src/gateway/types';

const KEY = 'k';
const jwt: JwtConfig = { secret: 'test-secret' };

const root = protobuf.parse(
  require('fs').readFileSync(path.resolve(__dirname, '../../contracts/transport.proto'), 'utf8'),
  { keepCase: true },
).root;
const Envelope = root.lookupType('nw.transport.Envelope');

function encodeClient(body: Record<string, unknown>): Uint8Array {
  return Envelope.encode(Envelope.fromObject({ client: body })).finish();
}
function decodeServer(buf: Uint8Array): Record<string, unknown> {
  const env = Envelope.decode(buf) as protobuf.Message & Record<string, unknown>;
  return (env['server'] as Record<string, unknown>) ?? {};
}

/** Minimal in-memory GatewaySubscriber — no real Redis, just enough to drive presenceOf's cross-instance branch. */
function fakeSubscriber(online: Set<string>): GatewaySubscriber {
  return {
    quit: async () => {},
    publishKick: async () => {},
    markOnline: async () => {},
    markOffline: async () => {},
    refreshOnline: async () => {},
    onlineAccountIds: async (ids: string[]) => new Set(ids.filter((id) => online.has(id))),
    rateLimitClient: {} as never,
  };
}

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets) try { s.close(); } catch { /* ignore */ }
  sockets.length = 0;
  gateway?.close();
  gateway = null;
});

function startGateway(port: number): Gateway {
  gateway = new Gateway({ host: '127.0.0.1', port }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
  return gateway;
}
function connect(port: number, accountId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=${signToken(accountId, jwt)}`);
  sockets.push(ws);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ConnRegistry gap-fill', () => {
  it('push to an accountId with no connection at all is silently dropped, not thrown', async () => {
    const port = 19601;
    startGateway(port);
    expect(() => gateway!.push('nobody-connected', { kind: 'room_error', code: 'X', message: 'm' })).not.toThrow();
  });

  it('routeBroadcast delivers only to recipients that are actually online here, skipping offline ones', async () => {
    const port = 19602;
    startGateway(port);
    const a = await connect(port, 'acc-online');
    let received: Record<string, unknown> | null = null;
    a.on('message', (data: ArrayBuffer) => { received = decodeServer(new Uint8Array(data)); });

    // 'acc-offline' has no connection at all — routeBroadcast must skip it without throwing.
    expect(() => gateway!.routeBroadcast(['acc-online', 'acc-offline'], { kind: 'room_error', code: 'X', message: 'broadcast' }, 'room1')).not.toThrow();
    await sleep(40);
    expect((received as unknown as Record<string, unknown>)?.['room_error']).toMatchObject({ message: 'broadcast' });
  });

  describe('presenceOf', () => {
    it('a locally-connected account resolves to true without ever touching the presence store', async () => {
      const port = 19603;
      startGateway(port);
      await connect(port, 'acc-local');
      let queried: string[] | null = null;
      gateway!.setPresenceStore({
        ...fakeSubscriber(new Set()),
        onlineAccountIds: async (ids: string[]) => { queried = ids; return new Set(); },
      });
      expect(await gateway!.presenceOf(['acc-local'])).toEqual({ 'acc-local': true });
      expect(queried).toBeNull(); // resolved entirely from the local conns map, no cross-instance round trip
    });

    it('an account not connected here falls through to the presence store (cross-instance)', async () => {
      const port = 19604;
      startGateway(port);
      gateway!.setPresenceStore(fakeSubscriber(new Set(['acc-remote'])));
      expect(await gateway!.presenceOf(['acc-remote', 'acc-nowhere'])).toEqual({ 'acc-remote': true, 'acc-nowhere': false });
    });

    it('mixes local and cross-instance resolution in a single query', async () => {
      const port = 19605;
      startGateway(port);
      await connect(port, 'acc-local');
      gateway!.setPresenceStore(fakeSubscriber(new Set(['acc-remote'])));
      expect(await gateway!.presenceOf(['acc-local', 'acc-remote', 'acc-nowhere'])).toEqual({
        'acc-local': true,
        'acc-remote': true,
        'acc-nowhere': false,
      });
    });

    it('without a presence store wired, unresolved accounts default to offline (no Redis, single-instance today)', async () => {
      const port = 19606;
      startGateway(port);
      expect(await gateway!.presenceOf(['acc-nowhere'])).toEqual({ 'acc-nowhere': false });
    });
  });

  it('a malformed binary frame (not a valid protobuf Envelope) is silently ignored — the connection keeps working afterward', async () => {
    const port = 19607;
    startGateway(port);
    const a = await connect(port, 'acc-a');
    a.send(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xff])); // garbage bytes, decodeClient will throw internally
    await sleep(30);

    // Prove the connection is still alive and dispatching normally: ping -> pong.
    const pong = new Promise<void>((resolve) => {
      a.on('message', (data: ArrayBuffer) => {
        if (decodeServer(new Uint8Array(data))['pong']) resolve();
      });
    });
    a.send(encodeClient({ ping: {} }));
    await pong;
  });

  it('WS handshake with no token is rejected with 4401, never registered', async () => {
    const port = 19608;
    startGateway(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gw`); // no ?token= at all
    sockets.push(ws);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(4401);
  });

  it('WS handshake with a garbage token is rejected with 4401', async () => {
    const port = 19609;
    startGateway(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=not-a-real-jwt`);
    sockets.push(ws);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(4401);
  });

  // 2026-09-10 burst: 265 byte-identical `jwt expired` warnings in two hours from one stuck client.
  // Every rejection is still refused with 4401 — only the LOG is bounded (see connRegistry's
  // REJECT_LOG_BURST for why the connections deliberately are not).
  it('logs only the first few identical handshake rejections, and still refuses every one', async () => {
    const port = 19610;
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=not-a-real-jwt`);
        sockets.push(ws);
        codes.push(await new Promise<number>((resolve) => ws.on('close', resolve)));
      }
      // Every attempt is refused; none of them is let through because the log went quiet.
      expect(codes).toEqual(Array(8).fill(4401));
      const rejects = warn.mock.calls.filter((c) => String(c[0]).includes('WS handshake rejected'));
      expect(rejects).toHaveLength(3); // REJECT_LOG_BURST
      // The suppressed ones are not lost — they are owed a summary, which the heartbeat sweep emits
      // once the window closes. Nothing has closed it yet, so no summary has been written either.
      const summaries = warn.mock.calls.filter((c) => String(c[0]).includes('rejections suppressed'));
      expect(summaries).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('once the window has passed, the suppressed ones are accounted for in one summary line', async () => {
    const port = 19611;
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Only Date is faked: the sockets below still need real timers to connect and close.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const reject = async (): Promise<void> => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=not-a-real-jwt`);
        sockets.push(ws);
        await new Promise<void>((resolve) => ws.on('close', () => resolve()));
      };
      for (let i = 0; i < 5; i++) await reject();
      vi.setSystemTime(Date.now() + 61_000); // window closed
      await reject(); // …and this one rolls it over

      // createLogger flattens msg + data into one console line, so assert on the rendered text.
      const summaries = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('rejections suppressed'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('total=5');
      expect(summaries[0]).toContain('suppressed=2');
      // The reason survives into the summary — a count alone would not have told anyone that the
      // 2026-09-10 burst was expired JWTs rather than, say, a broken deploy signing with a stale key.
      expect(summaries[0]).toMatch(/reasons=\S/);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

// The heartbeat sweep (2026-09-14). The two cases above drive the reject-window through the path a
// CONTINUING burst takes: the next rejection from the same source finds an expired window and rolls it
// over, which is what emits the summary. `sweepRejectWindows` exists for the other half — the burst that
// simply STOPS — and until this block it had never been executed by anything (0 calls, in a package
// whose coverage gate is a package-wide 90% and so cannot see one uncalled private method).
//
// That is the shape the 2026-09-10 incident actually had: a client stuck on an expired JWT retries until
// the player closes the tab, and then there is no next rejection, ever. Without the sweep the owed
// summary is never written (the suppressed 262 of that burst would simply not be accounted anywhere) and
// the map keeps one entry per source it has ever seen, for the life of the process — an unbounded,
// source-keyed map on the one code path that is reachable by anyone who can open a socket.
//
// Only `Date` and the interval are faked: the sockets below still need real setTimeout to connect and
// close. HEARTBEAT_MS's interval is the registry's only one (created in its constructor, hence the
// useFakeTimers BEFORE startGateway), so advancing it drives the real wiring rather than a private call.
describe('ConnRegistry — handshake-rejection windows are closed by the heartbeat', () => {
  const FAKE = ['Date', 'setInterval', 'clearInterval'] as const;

  /** Reject one handshake and wait for the close, so the rejection is recorded before we return. */
  async function reject(port: number): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=not-a-real-jwt`);
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
  }
  const summaries = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('rejections suppressed'));

  it('a burst that simply stops is still accounted for, with no further rejection to roll it over', async () => {
    const port = 19612;
    vi.useFakeTimers({ toFake: [...FAKE] });
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await reject(port);
      expect(summaries(warn)).toHaveLength(0); // window still open

      // The client goes away. Nothing else ever arrives from this source; only the heartbeat runs.
      // Two heartbeats span REJECT_LOG_WINDOW_MS; a third is slack, and costs nothing.
      vi.advanceTimersByTime(HEARTBEAT_MS * 3);

      const lines = summaries(warn);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('total=5');
      expect(lines[0]).toContain('suppressed=2');
      // The reason has to survive into the summary here too — this is now the ONLY line that will ever
      // be written about the 262 suppressed rejections of a burst whose client never came back.
      expect(lines[0]).toMatch(/reasons=\S/);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('and the window is dropped, so the map cannot grow one permanent entry per source', async () => {
    const port = 19613;
    vi.useFakeTimers({ toFake: [...FAKE] });
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await reject(port);
      vi.advanceTimersByTime(HEARTBEAT_MS * 3);
      expect(summaries(warn)).toHaveLength(1);

      // More heartbeats over the same expired window must find nothing left to close. A sweep that
      // emitted but did not delete would re-report this burst on every heartbeat forever, which is the
      // same log flood the fix was written to stop — only slower.
      vi.advanceTimersByTime(HEARTBEAT_MS * 3);
      expect(summaries(warn)).toHaveLength(1);

      // ...and the entry really is gone, not merely silent: the next rejection from this source gets the
      // full burst allowance again rather than being suppressed as the 6th of a window that never ended.
      warn.mockClear();
      await reject(port);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('WS handshake rejected'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('leaves a window that is still inside its minute alone, and closes it on the beat that passes it', async () => {
    const port = 19614;
    vi.useFakeTimers({ toFake: [...FAKE] });
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await reject(port);
      // HEARTBEAT_MS is half of REJECT_LOG_WINDOW_MS, so the first beat lands inside a live window.
      // Closing there would chop an ongoing burst into one summary per heartbeat — a bounded log turned
      // back into a periodic one, which is most of what the fix was for.
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(summaries(warn)).toHaveLength(0);
      // The next beat is the first one past the window, and it is the one that must report.
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(summaries(warn)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('a window that suppressed nothing expires silently, without a summary line', async () => {
    const port = 19615;
    vi.useFakeTimers({ toFake: [...FAKE] });
    startGateway(port);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Three rejections = exactly the burst allowance, all of them already logged in full.
      for (let i = 0; i < 3; i++) await reject(port); // REJECT_LOG_BURST
      vi.advanceTimersByTime(HEARTBEAT_MS * 3);
      // A "0 suppressed" line would be pure noise — the three lines above already say everything.
      expect(summaries(warn)).toHaveLength(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('WS handshake rejected'))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

// ...and the other half of the same heartbeat (2026-09-14). `sweep()` had never been called by any test
// either — the reject-window block above is what first made it run, and executing a function for the
// first time is also what makes v8 count its branches, so covering only the half this session came for
// would have LOWERED the package's branch percentage while raising its line one.
//
// It is worth having for itself, not just for the arithmetic. This loop is the only thing that notices a
// connection has stopped answering (a laptop lid, a tunnel that dropped without a FIN — the cases where
// no 'close' event ever arrives), and the only thing that keeps a live account's cross-instance presence
// key alive: redis.ts sizes PRESENCE_TTL_MS to survive exactly ONE missed beat, so a refresh that stops
// happening does not fail loudly — every account on this instance simply starts reading as offline to
// its friends a minute later, while the sockets are all perfectly healthy.
describe('ConnRegistry — the heartbeat sweep over live connections', () => {
  const FAKE = ['Date', 'setInterval', 'clearInterval'] as const;
  /** Real timers are not faked, so this yields to actual socket I/O between beats. */
  const flush = () => new Promise((r) => setTimeout(r, 60));

  it('pings live connections and refreshes their presence key', async () => {
    const port = 19616;
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      startGateway(port);
      const refreshed: string[] = [];
      gateway!.setPresenceStore({
        ...fakeSubscriber(new Set()),
        refreshOnline: async (id: string) => { refreshed.push(id); },
      });
      const ws = await connect(port, 'acc-alive');
      const pinged = new Promise<void>((resolve) => ws.on('ping', () => resolve()));

      vi.advanceTimersByTime(HEARTBEAT_MS);
      await pinged;
      await flush();

      expect(refreshed).toEqual(['acc-alive']);
      expect(ws.readyState).toBe(WebSocket.OPEN); // a ping is not a disconnect
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a connection that stopped answering, after one full beat of silence', async () => {
    const port = 19617;
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      startGateway(port);
      // autoPong:false is the whole point — this client stays connected at the TCP level and simply never
      // answers, which is what a dead tunnel or a slept device looks like from the server's side. Nothing
      // else in the stack will ever notice it; there is no 'close' coming.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=${signToken('acc-mute', jwt)}`, { autoPong: false });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
      const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));

      // First beat: marks it not-alive and asks. Deliberately NOT a kill — one missed beat is normal
      // jitter, and terminating here would drop healthy connections on a slow network.
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await flush();
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Second beat: still no answer, so the socket goes.
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });
});
