// ConnRegistry gap-fill (previously 69.0% — gateway-routing.test.ts/rate-limit.test.ts/judge.test.ts only
// ever exercise `push` on an already-online recipient and never call `routeBroadcast` or `presenceOf`'s
// cross-instance branch at all). Covers: push-to-offline warn/drop, routeBroadcast's per-recipient online
// filter, presenceOf's local-vs-cross-instance split (via a hand-built GatewaySubscriber fake — no real
// Redis needed), a malformed binary frame being silently ignored (decodeClient throws, caught), and the WS
// handshake rejection path (missing/invalid token -> 4401). Same real-Gateway-plus-real-WS harness as
// gateway-routing.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { signToken, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';
import type { GatewaySubscriber } from '../src/redis';

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
});
