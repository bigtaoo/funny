// Gateway control-plane routing end-to-end tests: real Gateway WS + ws client.
// Covers two main paths that were previously only tested in the MatchsvcClient unit tests on the client side
// and had never been verified on the gateway side:
//   1. account→socket mapping: connection registration, forwarding commands to matchsvc by accountId,
//      push delivered only to the target socket, new connection for the same account displaces the old one (4409);
//   2. ranked enqueue when meta is unavailable → push back room_error{RANKED_UNAVAILABLE} (no direct test existed before).
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { signToken, defaultPvpDeck, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';

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

/** matchsvc recording stub: records every call forwarded by the gateway (no real HTTP sent). */
class RecordingMatchsvc extends MatchsvcClient {
  readonly calls: { m: string; args: unknown[] }[] = [];
  constructor() {
    super(null, KEY);
  }
  override roomCreate(a: string, n: string, p: string, e = '', deck: string[] = []): void { this.calls.push({ m: 'roomCreate', args: [a, n, p, e, deck] }); }
  override roomJoin(a: string, n: string, p: string, c: string, e = '', deck: string[] = []): void { this.calls.push({ m: 'roomJoin', args: [a, n, p, c, e, deck] }); }
  override roomReady(a: string, r: boolean): void { this.calls.push({ m: 'roomReady', args: [a, r] }); }
  override roomStart(a: string): void { this.calls.push({ m: 'roomStart', args: [a] }); }
  override roomLeave(a: string): void { this.calls.push({ m: 'roomLeave', args: [a] }); }
  override enqueue(a: string, n: string, p: string, e: number): void { this.calls.push({ m: 'enqueue', args: [a, n, p, e] }); }
  override connected(a: string): void { this.calls.push({ m: 'connected', args: [a] }); }
  override disconnected(a: string): void { this.calls.push({ m: 'disconnected', args: [a] }); }
}

/** MetaClient stub reporting a fixed ELO (available), so deck-unlock gating can be exercised. */
class FakeMeta extends MetaClient {
  constructor(private readonly elo: number) { super('http://meta.invalid', KEY); }
  override get available(): boolean { return true; }
  override async getElo(): Promise<{ elo: number }> { return { elo: this.elo }; }
  override async getProfile(): Promise<{ displayName?: string; publicId?: string; equippedTitle?: string }> {
    return { displayName: 'Player', publicId: '100000001', equippedTitle: '' };
  }
}

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets) try { s.close(); } catch { /* ignore */ }
  sockets.length = 0;
  gateway?.close();
  gateway = null;
});

function startGateway(port: number, matchsvc: MatchsvcClient, meta?: MetaClient): Gateway {
  gateway = new Gateway(
    { host: '127.0.0.1', port },
    jwt,
    matchsvc,
    meta ?? new MetaClient(null, KEY), // default: meta unavailable
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

/** Wait for a specific server message (by oneof key); reject on timeout. */
function waitForServer(ws: WebSocket, key: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${key}`)), timeoutMs);
    ws.on('message', (data: ArrayBuffer) => {
      const srv = decodeServer(new Uint8Array(data));
      if (srv[key]) {
        clearTimeout(t);
        resolve(srv[key] as Record<string, unknown>);
      }
    });
  });
}

describe('Gateway control-plane routing', () => {
  it('registers connection and forwards control commands to matchsvc by accountId', async () => {
    const port = 19520;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm);
    const a = await connect(port, 'acc-a');

    // Connection is registered with matchsvc immediately.
    expect(mm.calls.some((c) => c.m === 'connected' && c.args[0] === 'acc-a')).toBe(true);

    a.send(encodeClient({ room_create: { mode: 0 } })); // friendly
    a.send(encodeClient({ room_ready: { ready: true } }));
    a.send(encodeClient({ room_start: {} }));
    a.send(encodeClient({ room_leave: {} }));
    await sleep(60); // room_create is forwarded asynchronously via resolveProfile

    expect(mm.calls.find((c) => c.m === 'roomReady')?.args).toEqual(['acc-a', true]);
    expect(mm.calls.find((c) => c.m === 'roomStart')?.args).toEqual(['acc-a']);
    expect(mm.calls.find((c) => c.m === 'roomLeave')?.args).toEqual(['acc-a']);
    // friendly create: meta unavailable → name falls back to accountId prefix, publicId empty.
    // No deck submitted → gateway resolves to defaultPvpDeck (never the full pool; PVP_LOADOUT §6.3).
    const create = mm.calls.find((c) => c.m === 'roomCreate');
    expect(create?.args.slice(0, 3)).toEqual(['acc-a', 'acc-a', '']);
    expect(create?.args[4]).toEqual(defaultPvpDeck());
  });

  it('push is delivered only to the socket that owns the given accountId', async () => {
    const port = 19521;
    startGateway(port, new RecordingMatchsvc());
    const a = await connect(port, 'acc-a');
    const b = await connect(port, 'acc-b');

    let bGotIt = false;
    b.on('message', (data: ArrayBuffer) => {
      if (decodeServer(new Uint8Array(data))['room_error']) bGotIt = true;
    });
    const aGot = waitForServer(a, 'room_error');

    gateway!.push('acc-a', { kind: 'room_error', code: 'X', message: 'hello-a' });

    const err = await aGot;
    expect(err['message']).toBe('hello-a');
    await sleep(40);
    expect(bGotIt).toBe(false); // b must not receive a message addressed to a
  });

  it('new connection for the same account displaces the old connection (old socket receives 4409)', async () => {
    const port = 19522;
    startGateway(port, new RecordingMatchsvc());
    const ws1 = await connect(port, 'dup');
    const closed = new Promise<number>((res) => ws1.on('close', (code: number) => res(code)));

    await connect(port, 'dup'); // second connection for the same account
    expect(await closed).toBe(4409);
  });

  it('cross-instance kick (routeKick from a sibling instance) evicts a locally-held connection', async () => {
    const port = 19526;
    startGateway(port, new RecordingMatchsvc());
    const ws1 = await connect(port, 'acc-remote');
    const closed = new Promise<number>((res) => ws1.on('close', (code: number) => res(code)));

    // Simulates a Redis-delivered kick broadcast originating from a different gateway instance.
    gateway!.routeKick('acc-remote', 'some-other-instance-id');
    expect(await closed).toBe(4409);
  });

  it('cross-instance kick ignores its own echo (originInstanceId === this instance)', async () => {
    const port = 19527;
    startGateway(port, new RecordingMatchsvc());
    let ownInstanceId = '';
    gateway!.setKickPublisher((_accountId, originInstanceId) => { ownInstanceId = originInstanceId; });
    const ws1 = await connect(port, 'acc-self'); // onConnection() calls the publisher, capturing our own instanceId
    let closed = false;
    ws1.on('close', () => { closed = true; });

    expect(ownInstanceId).not.toBe('');
    gateway!.routeKick('acc-self', ownInstanceId); // echo of our own broadcast — must be a no-op
    await sleep(40);
    expect(closed).toBe(false);
  });

  it('routeKick is a no-op when this instance holds no connection for the account', () => {
    const port = 19528;
    startGateway(port, new RecordingMatchsvc());
    expect(() => gateway!.routeKick('nobody-here', 'other-instance')).not.toThrow();
  });

  it('friendly room_create with a locked card → gateway strips it (falls back to defaultPvpDeck)', async () => {
    // The reported-bug class: a sub-1500 player must not field ELO-locked units even in a
    // friendly/custom room — server-side gating is universal (PVP_LOADOUT §6.3).
    const port = 19524;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, new FakeMeta(998)); // below the 1500 diamond gate
    const a = await connect(port, 'acc-a');

    a.send(encodeClient({ room_create: { mode: 0, deck: [...defaultPvpDeck().slice(0, 9), 'runner'] } }));
    await sleep(80);

    const deck = mm.calls.find((c) => c.m === 'roomCreate')?.args[4] as string[] | undefined;
    expect(deck).toBeDefined();
    expect(deck).not.toContain('runner');       // locked at 998 → rejected
    expect(deck).toEqual(defaultPvpDeck());      // invalid deck → default fallback
  });

  it('friendly room_join forwards the joiner’s current-elo-validated deck', async () => {
    const port = 19525;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, new FakeMeta(998));
    const a = await connect(port, 'acc-a');

    // A fully-legal base deck is preserved as-is (join now carries a deck, previously it did not).
    a.send(encodeClient({ room_join: { code: 'ABC123', deck: defaultPvpDeck() } }));
    await sleep(80);

    const join = mm.calls.find((c) => c.m === 'roomJoin');
    expect(join?.args[3]).toBe('ABC123');
    expect(join?.args[5]).toEqual(defaultPvpDeck());
  });

  it('ranked enqueue when meta unavailable → push back RANKED_UNAVAILABLE, and do not enqueue', async () => {
    const port = 19523;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm, new MetaClient(null, KEY)); // meta.available=false
    const a = await connect(port, 'acc-a');

    const errP = waitForServer(a, 'room_error');
    a.send(encodeClient({ room_create: { mode: 1 } })); // RANKED

    const err = await errP;
    expect(err['code']).toBe('RANKED_UNAVAILABLE');
    await sleep(40);
    expect(mm.calls.some((c) => c.m === 'enqueue')).toBe(false);
  });
});
