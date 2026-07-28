// Cross-instance presence tests (2026-07-27 mid-term audit item 5/5): gateway.presenceOf() used to answer
// purely from its own in-process `conns` map — correct for today's single-instance deployment, but would
// under-report an account connected to a sibling instance if gateway is ever scaled out. Requires a real
// local Redis (docker compose's nw-redis, see claudedocs/worktrees.md); the whole suite is skipped if
// unreachable, same convention as the Mongo-backed e2e suites elsewhere in this repo.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { signToken, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';
import { connectGatewaySubscriber, type GatewaySubscriber } from '../src/redis';

const REDIS_URL = process.env.NW_REDIS_URL ?? 'redis://127.0.0.1:6379';
const KEY = 'k';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<GatewaySubscriber | null> {
  try {
    return await connectGatewaySubscriber(REDIS_URL, () => {}, () => {});
  } catch {
    return null;
  }
}

const probe = await tryConnect();
if (!probe) console.warn(`[redis-presence.e2e] Redis unreachable (${REDIS_URL}) — skipping.`);
if (probe) await probe.quit();

function connectWs(port: number, accountId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=${signToken(accountId, jwt)}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe.skipIf(!probe)('GatewaySubscriber presence primitives (direct, real Redis)', () => {
  let sub: GatewaySubscriber;

  beforeAll(async () => {
    sub = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
  });
  afterAll(async () => {
    await sub.quit();
  });

  it('markOnline -> onlineAccountIds sees it; markOffline -> gone', async () => {
    const acc = `probe-${Math.random()}`;
    expect(await sub.onlineAccountIds([acc])).toEqual(new Set());
    await sub.markOnline(acc);
    expect(await sub.onlineAccountIds([acc])).toEqual(new Set([acc]));
    await sub.markOffline(acc);
    expect(await sub.onlineAccountIds([acc])).toEqual(new Set());
  });

  it('onlineAccountIds only reports the ids actually marked online, out of a mixed batch', async () => {
    const online = `probe-on-${Math.random()}`;
    const offline = `probe-off-${Math.random()}`;
    await sub.markOnline(online);
    expect(await sub.onlineAccountIds([online, offline])).toEqual(new Set([online]));
    await sub.markOffline(online);
  });

  it('empty input never touches Redis and returns an empty set', async () => {
    expect(await sub.onlineAccountIds([])).toEqual(new Set());
  });
});

describe.skipIf(!probe)('Gateway.presenceOf cross-instance (two real Gateway instances, shared Redis)', () => {
  let gwA: Gateway | null = null;
  let gwB: Gateway | null = null;
  let subA: GatewaySubscriber | null = null;
  let subB: GatewaySubscriber | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets) try { s.close(); } catch { /* ignore */ }
    sockets.length = 0;
    // Give each closed socket's server-side 'close' handler (which fires markOffline on the presence
    // store) a moment to run before quitting the very Redis connections it uses — otherwise it logs a
    // harmless but noisy "Connection is closed" warning.
    await new Promise((r) => setTimeout(r, 20));
    gwA?.close();
    gwB?.close();
    if (subA) await subA.quit();
    if (subB) await subB.quit();
    gwA = gwB = subA = subB = null;
  });

  it('an account connected to instance A is reported online by instance B.presenceOf (not locally connected)', async () => {
    const portA = 19301;
    const portB = 19302;
    gwA = new Gateway({ host: '127.0.0.1', port: portA }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
    gwB = new Gateway({ host: '127.0.0.1', port: portB }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
    subA = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    subB = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    gwA.setPresenceStore(subA);
    gwB.setPresenceStore(subB);

    const accountId = `cross-${Math.random()}`;
    sockets.push(await connectWs(portA, accountId));
    // markOnline is fire-and-forget from onConnection; give the Redis round trip a moment to land.
    await new Promise((r) => setTimeout(r, 100));

    const seenByB = await gwB.presenceOf([accountId]);
    expect(seenByB).toEqual({ [accountId]: true });

    // B never had a local connection for this account — its answer came entirely from Redis.
    const seenByBUnknown = await gwB.presenceOf([`nobody-${Math.random()}`]);
    expect(seenByBUnknown[Object.keys(seenByBUnknown)[0]!]).toBe(false);
  });

  it('disconnecting from instance A is reflected in instance B.presenceOf shortly after', async () => {
    const portA = 19303;
    const portB = 19304;
    gwA = new Gateway({ host: '127.0.0.1', port: portA }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
    gwB = new Gateway({ host: '127.0.0.1', port: portB }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
    subA = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    subB = (await connectGatewaySubscriber(REDIS_URL, () => {}, () => {}))!;
    gwA.setPresenceStore(subA);
    gwB.setPresenceStore(subB);

    const accountId = `cross-disc-${Math.random()}`;
    const ws = await connectWs(portA, accountId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await gwB.presenceOf([accountId])).toEqual({ [accountId]: true });

    ws.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(await gwB.presenceOf([accountId])).toEqual({ [accountId]: false });
  });

  it('without a presenceStore wired (single-instance/no-Redis), presenceOf falls back to local-only (unchanged behavior)', async () => {
    const port = 19305;
    gwA = new Gateway({ host: '127.0.0.1', port }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY));
    // Deliberately no setPresenceStore call.
    const accountId = `local-only-${Math.random()}`;
    sockets.push(await connectWs(port, accountId));
    expect(await gwA.presenceOf([accountId])).toEqual({ [accountId]: true });
    expect(await gwA.presenceOf([`ghost-${Math.random()}`])).toMatchObject({});
  });
});
