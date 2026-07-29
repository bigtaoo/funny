// Per-connection control-message rate limiting (SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4): before this,
// Gateway.handle() dispatched every room_create/room_join/duel_invite/... unconditionally, with no cap at
// all — a scripted client could hammer matchsvc, or spam another player with duel invites, as fast as the
// socket allowed. Covers: (1) the TIGHT tier limiting room_create and pushing back an explicit room_error
// instead of silently dropping the request; (2) duel_invite reusing the duel_cancelled channel with
// reason:'rate_limited'; (3) TIGHT and STANDARD tiers tracked independently per accountId; (4) the in-process
// fallback (no Redis configured — today's default) still enforces the cap correctly; (5) the Redis-backed
// path (skipIf no local Redis, same convention as redis-presence.e2e.test.ts) shares the limit across two
// separate Gateway instances for the same accountId, proving the whole point of the Redis upgrade.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { signToken, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';
import { connectGatewaySubscriber, type GatewaySubscriber } from '../src/redis';

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

/** matchsvc recording stub: records every call forwarded by the gateway (no real HTTP sent), always "succeeds" — same shape as gateway-routing.test.ts's RecordingMatchsvc (not exported from there, so duplicated here). */
class RecordingMatchsvc extends MatchsvcClient {
  readonly calls: { m: string; args: unknown[] }[] = [];
  constructor() { super(null, KEY); }
  override async roomCreate(a: string, n: string, p: string, e = '', av = '', deck: string[] = []): Promise<boolean> { this.calls.push({ m: 'roomCreate', args: [a, n, p, e, av, deck] }); return true; }
  override async roomJoin(a: string, n: string, p: string, c: string, e = '', av = '', deck: string[] = []): Promise<boolean> { this.calls.push({ m: 'roomJoin', args: [a, n, p, c, e, av, deck] }); return true; }
  override roomReady(a: string, r: boolean): void { this.calls.push({ m: 'roomReady', args: [a, r] }); }
  override roomStart(a: string): void { this.calls.push({ m: 'roomStart', args: [a] }); }
  override roomLeave(a: string): void { this.calls.push({ m: 'roomLeave', args: [a] }); }
  override connected(a: string): void { this.calls.push({ m: 'connected', args: [a] }); }
  override disconnected(a: string): void { this.calls.push({ m: 'disconnected', args: [a] }); }
  override duelInvite(a: string, n: string, p: string, e: string, av: string, to: string, deck: string[] = []): void {
    this.calls.push({ m: 'duelInvite', args: [a, n, p, e, av, to, deck] });
  }
}

/** MetaClient stub for duel-invite tests: fixed elo + a configurable publicId → accountId directory (mirrors gateway-routing.test.ts's FakeMetaWithDirectory). */
class FakeMetaWithDirectory extends MetaClient {
  constructor(private readonly directory: Record<string, string>) { super('http://meta.invalid', KEY); }
  override get available(): boolean { return true; }
  override async getMatchIdentity(accountId: string): Promise<{ elo: number; displayName?: string; publicId?: string; equippedTitle?: string; avatarId?: string }> {
    const publicId = Object.entries(this.directory).find(([, acc]) => acc === accountId)?.[0] ?? '';
    return { elo: 1000, displayName: `name-${accountId}`, publicId, equippedTitle: '', avatarId: '' };
  }
  override async resolveByPublicId(publicId: string): Promise<{ accountId: string } | null> {
    const accountId = this.directory[publicId];
    return accountId ? { accountId } : null;
  }
}

let gateway: Gateway | null = null;
let gatewayB: Gateway | null = null;
const sockets: WebSocket[] = [];
let subA: GatewaySubscriber | null = null;
let subB: GatewaySubscriber | null = null;

afterEach(async () => {
  for (const s of sockets) try { s.close(); } catch { /* ignore */ }
  sockets.length = 0;
  gateway?.close();
  gateway = null;
  gatewayB?.close();
  gatewayB = null;
  if (subA) await subA.quit();
  if (subB) await subB.quit();
  subA = subB = null;
});

function startGateway(
  port: number,
  matchsvc: MatchsvcClient,
  opts: { rateLimitTight?: number; rateLimitStandard?: number },
  meta?: MetaClient,
): Gateway {
  gateway = new Gateway(
    { host: '127.0.0.1', port, ...opts },
    jwt,
    matchsvc,
    meta ?? new MetaClient(null, KEY),
  );
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

/** Collects every server message received on a socket (by oneof key) into an array, for counting/ordering-insensitive assertions. */
function collectServer(ws: WebSocket): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  ws.on('message', (data: ArrayBuffer) => out.push(decodeServer(new Uint8Array(data))));
  return out;
}

describe('Gateway per-connection rate limiting (SERVER_LOGIC_AUDIT_2026-07-29 known-gap #4)', () => {
  it('room_create (TIGHT tier): allows up to the cap, rejects the next one with an explicit room_error instead of a silent drop', async () => {
    const port = 19600;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, { rateLimitTight: 3 });
    const a = await connect(port, 'acc-a');
    const received = collectServer(a);

    for (let i = 0; i < 4; i++) a.send(encodeClient({ room_create: { mode: 0 } })); // friendly, no ranked/meta dependency
    await sleep(100);

    expect(mm.calls.filter((c) => c.m === 'roomCreate').length).toBe(3); // 4th never reached matchsvc
    const errs = received.filter((m) => m['room_error']);
    expect(errs.length).toBe(1);
    expect((errs[0]!['room_error'] as Record<string, unknown>)['code']).toBe('RATE_LIMITED');
  });

  it('duel_invite (TIGHT tier): over-cap request gets duel_cancelled{reason:rate_limited}, matchsvc never called for it', async () => {
    const port = 19601;
    const mm = new RecordingMatchsvc();
    const meta = new FakeMetaWithDirectory({ '100000002': 'acc-b' });
    startGateway(port, mm, { rateLimitTight: 2 }, meta);
    const a = await connect(port, 'acc-a');
    await connect(port, 'acc-b'); // target must be online for the invite to resolve past the rate check
    const received = collectServer(a);

    for (let i = 0; i < 3; i++) a.send(encodeClient({ duel_invite: { to_public_id: '100000002', deck: [] } }));
    await sleep(100);

    expect(mm.calls.filter((c) => c.m === 'duelInvite').length).toBe(2);
    const cancels = received.filter((m) => m['duel_cancelled']);
    expect(cancels.length).toBe(1);
    expect((cancels[0]!['duel_cancelled'] as Record<string, unknown>)['reason']).toBe('rate_limited');
  });

  it('TIGHT and STANDARD tiers are tracked independently per accountId: exhausting room_create does not block room_ready', async () => {
    const port = 19602;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, { rateLimitTight: 2, rateLimitStandard: 2 });
    const a = await connect(port, 'acc-a');
    const received = collectServer(a);

    a.send(encodeClient({ room_create: { mode: 0 } }));
    a.send(encodeClient({ room_create: { mode: 0 } })); // exhausts the TIGHT budget (2)
    a.send(encodeClient({ room_ready: { ready: true } }));
    a.send(encodeClient({ room_ready: { ready: true } })); // STANDARD budget (2) is untouched by TIGHT usage
    await sleep(100);

    expect(mm.calls.filter((c) => c.m === 'roomCreate').length).toBe(2);
    expect(mm.calls.filter((c) => c.m === 'roomReady').length).toBe(2); // not blocked by the exhausted TIGHT bucket
    expect(received.filter((m) => m['room_error']).length).toBe(0);

    // A 3rd room_ready now exceeds the STANDARD cap independently.
    a.send(encodeClient({ room_ready: { ready: true } }));
    await sleep(60);
    expect(mm.calls.filter((c) => c.m === 'roomReady').length).toBe(2); // still 2 — the 3rd was rejected
    const errs = received.filter((m) => m['room_error']);
    expect(errs.length).toBe(1);
    expect((errs[0]!['room_error'] as Record<string, unknown>)['code']).toBe('RATE_LIMITED');
  });

  it('unlimited cases (ping/client_caps/judge_verdict) are never gated, even far beyond any tier cap', async () => {
    const port = 19603;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, { rateLimitTight: 1, rateLimitStandard: 1 });
    const a = await connect(port, 'acc-a');
    const received = collectServer(a);

    for (let i = 0; i < 20; i++) a.send(encodeClient({ ping: {} }));
    await sleep(150);

    const pongs = received.filter((m) => m['pong']);
    expect(pongs.length).toBe(20); // every ping answered, none rate-limited
    expect(received.filter((m) => m['room_error']).length).toBe(0);
  });

  it('no Redis configured (default deployment today): the in-process fallback alone still enforces the cap correctly', async () => {
    // Deliberately never calls setPresenceStore — exercises the exact code path a single-instance,
    // no-Redis production deployment runs today.
    const port = 19604;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, { rateLimitTight: 2 });
    const a = await connect(port, 'acc-a');
    const received = collectServer(a);

    a.send(encodeClient({ room_join: { code: 'ABC123' } }));
    a.send(encodeClient({ room_join: { code: 'ABC123' } }));
    a.send(encodeClient({ room_join: { code: 'ABC123' } }));
    await sleep(100);

    expect(mm.calls.filter((c) => c.m === 'roomJoin').length).toBe(2);
    expect(received.filter((m) => m['room_error'] && (m['room_error'] as Record<string, unknown>)['code'] === 'RATE_LIMITED').length).toBe(1);
  });
});

// ── Redis-backed path (2026-07-29): requires a real local Redis (docker compose's nw-redis, see
// claudedocs/worktrees.md); the whole suite is skipped if unreachable, same convention as
// redis-presence.e2e.test.ts. ──────────────────────────────────────────────────────────────────
const REDIS_URL = process.env.NW_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function tryConnect(): Promise<GatewaySubscriber | null> {
  try {
    return await connectGatewaySubscriber(REDIS_URL, () => {}, () => {});
  } catch {
    return null;
  }
}

let probe: GatewaySubscriber | null = null;
beforeAll(async () => {
  probe = await tryConnect();
  if (!probe) console.warn(`[rate-limit.test] Redis unreachable (${REDIS_URL}) — skipping Redis-backed suite.`);
  if (probe) await probe.quit();
});

describe('Gateway per-connection rate limiting: Redis-backed path (real Redis, precise across instances)', () => {
  it('two Gateway instances sharing the same Redis enforce ONE shared cap for the same accountId (the whole point of the Redis upgrade)', async (ctx) => {
    if (!probe) { ctx.skip(); return; }
    const portA = 19610;
    const portB = 19611;
    const mmA = new RecordingMatchsvc();
    const mmB = new RecordingMatchsvc();
    gateway = new Gateway({ host: '127.0.0.1', port: portA, rateLimitTight: 3 }, jwt, mmA, new MetaClient(null, KEY));
    gatewayB = new Gateway({ host: '127.0.0.1', port: portB, rateLimitTight: 3 }, jwt, mmB, new MetaClient(null, KEY));
    subA = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    subB = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    gateway.setPresenceStore(subA);
    gatewayB.setPresenceStore(subB);

    // Same accountId connects to BOTH instances (no kick publisher wired, so no cross-instance eviction
    // races complicate this — the point here is purely the shared rate-limit bucket, keyed by accountId
    // + a namespace shared by both instances' RedisSlidingRateLimiter).
    const accountId = `shared-${Math.random()}`;
    const a = await connect(portA, accountId);
    const b = await connect(portB, accountId);
    const receivedA = collectServer(a);
    const receivedB = collectServer(b);

    a.send(encodeClient({ room_create: { mode: 0 } }));
    a.send(encodeClient({ room_create: { mode: 0 } }));
    await sleep(80); // let A's two requests land in Redis before B sends (avoids racing the same limit window)
    b.send(encodeClient({ room_create: { mode: 0 } }));
    b.send(encodeClient({ room_create: { mode: 0 } }));
    await sleep(150);

    // Cap is 3, shared across both instances: exactly 3 of the 4 total requests should have gone through.
    const totalAccepted = mmA.calls.filter((c) => c.m === 'roomCreate').length + mmB.calls.filter((c) => c.m === 'roomCreate').length;
    expect(totalAccepted).toBe(3);
    const totalRateLimited =
      receivedA.filter((m) => m['room_error'] && (m['room_error'] as Record<string, unknown>)['code'] === 'RATE_LIMITED').length +
      receivedB.filter((m) => m['room_error'] && (m['room_error'] as Record<string, unknown>)['code'] === 'RATE_LIMITED').length;
    expect(totalRateLimited).toBe(1);
  });
});
