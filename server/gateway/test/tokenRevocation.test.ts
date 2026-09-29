// C5-b token revocation at the WS handshake (connRegistry.onConnection): a validly signed token of a
// revoked (purged) account is refused with the same 4401 as an expired one, before it is registered;
// other accounts' tokens are unaffected. Real Gateway + real WS, same harness as connRegistry-unit.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { TokenRevocationList, signToken, type JwtConfig } from '@nw/shared';
import { Gateway } from '../src/Gateway';
import { MatchsvcClient } from '../src/matchsvcClient';
import { MetaClient } from '../src/metaClient';

const KEY = 'k';
const jwt: JwtConfig = { secret: 'test-secret' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets) try { s.close(); } catch { /* ignore */ }
  sockets.length = 0;
  gateway?.close();
  gateway = null;
});

async function startGateway(port: number, revokedAccountId: string): Promise<void> {
  const list = new TokenRevocationList(async () => ({
    asOf: Date.now(),
    revocations: [{ accountId: revokedAccountId, revokedAt: Date.now() + 1000 }],
  }));
  await list.refresh();
  gateway = new Gateway({ host: '127.0.0.1', port }, jwt, new MatchsvcClient(null, KEY), new MetaClient(null, KEY), undefined, list);
  await sleep(20);
}

function open(port: number, accountId: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gw?token=${signToken(accountId, jwt)}`);
  sockets.push(ws);
  return ws;
}

describe('gateway handshake: token revocation list', () => {
  it('refuses a revoked account with 4401 and never registers it', async () => {
    const port = 19640;
    await startGateway(port, 'acc-gone');
    const ws = open(port, 'acc-gone');
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(4401);
    expect(await gateway!.presenceOf(['acc-gone'])).toEqual({ 'acc-gone': false });
  });

  it('lets every other account through', async () => {
    const port = 19641;
    await startGateway(port, 'acc-gone');
    const ws = open(port, 'acc-live');
    let closed: number | null = null;
    ws.on('close', (c) => (closed = c));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await sleep(50);
    expect(closed).toBeNull();
    expect(await gateway!.presenceOf(['acc-live'])).toEqual({ 'acc-live': true });
  });
});
