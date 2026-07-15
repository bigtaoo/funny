// Peer-judge end-to-end unit tests (Phase C): real Gateway WS + three ws clients (two contestants + one judge).
// Verifies that gateway.judge selects a player who reported canJudge and is not in the exclude list, pushes judge_request,
// and resolves the verdict after receiving judge_verdict; no eligible candidate → {ok:false}.
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { signToken, type JwtConfig } from '@nw/shared';
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

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets) try { s.close(); } catch { /* ignore */ }
  sockets.length = 0;
  gateway?.close();
  gateway = null;
});

function startGateway(port: number): Gateway {
  gateway = new Gateway(
    { host: '127.0.0.1', port },
    jwt,
    new MatchsvcClient(null, KEY), // available=false → connected/disconnected no-op
    new MetaClient(null, KEY),
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

describe('Gateway peer judge', () => {
  it('selects a canJudge third party, pushes judge_request, resolves verdict', async () => {
    const port = 19510;
    const gw = startGateway(port);
    const [a, b, c] = await Promise.all([
      connect(port, 'a'),
      connect(port, 'b'),
      connect(port, 'c'),
    ]);

    // Judge c reports canJudge; contestants a/b do not report it (default false, and are in exclude).
    c.send(encodeClient({ client_caps: { can_judge: true } }));

    // c receives judge_request → responds with verdict.
    c.on('message', (data: ArrayBuffer) => {
      const srv = decodeServer(new Uint8Array(data));
      const req = srv['judge_request'] as Record<string, unknown> | undefined;
      if (!req) return;
      c.send(
        encodeClient({
          judge_verdict: { request_id: req['request_id'], state_hash: 'HONEST', winner_side: 0, ok: true },
        }),
      );
    });

    await sleep(50); // allow client_caps to reach gateway before judge call
    const verdict = await gw.judge({ seed: 7, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: true, stateHash: 'HONEST', winnerSide: 0, stars: 0, statsJson: '', judgeAccountId: 'c' });
    void a; void b;
  });

  it('PvE spot-check: transport level_id/pve_upgrades forwarded to judge, verdict.stars resolved', async () => {
    const port = 19513;
    const gw = startGateway(port);
    const [p, j] = await Promise.all([connect(port, 'p'), connect(port, 'j')]);
    j.send(encodeClient({ client_caps: { can_judge: true } }));

    let seenReq: Record<string, unknown> | undefined;
    j.on('message', (data: ArrayBuffer) => {
      const srv = decodeServer(new Uint8Array(data));
      const req = srv['judge_request'] as Record<string, unknown> | undefined;
      if (!req) return;
      seenReq = req;
      j.send(
        encodeClient({
          // S9-3b: PvE spot-check recomputation reports per-match achievement counters in stats_json; gateway forwards it back to meta.
          judge_verdict: {
            request_id: req['request_id'], state_hash: '', winner_side: 0, ok: true, stars: 2,
            stats_json: '{"kill.archer":3}',
          },
        }),
      );
    });

    await sleep(50);
    const verdict = await gw.judge({
      seed: 0, mode: 0, endFrame: 99, frames: [], exclude: ['p'],
      levelId: 'ch1_lv2', pveUpgrades: { inf_hp: 3 },
    });
    expect(verdict).toEqual({
      ok: true, stateHash: '', winnerSide: 0, stars: 2, statsJson: '{"kill.archer":3}', judgeAccountId: 'j',
    });
    // Judge received PvE recomputation parameters (level_id + authoritative blueprint snapshot).
    expect(seenReq?.['level_id']).toBe('ch1_lv2');
    expect(seenReq?.['pve_upgrades']).toEqual({ inf_hp: 3 });
    void p;
  });

  it('ranked PvP: transport top_deck/bottom_deck forwarded to judge (PVP_LOADOUT §6.2)', async () => {
    const port = 19514;
    const gw = startGateway(port);
    const [a, b, c] = await Promise.all([
      connect(port, 'a'),
      connect(port, 'b'),
      connect(port, 'c'),
    ]);
    c.send(encodeClient({ client_caps: { can_judge: true } }));

    let seenReq: Record<string, unknown> | undefined;
    c.on('message', (data: ArrayBuffer) => {
      const srv = decodeServer(new Uint8Array(data));
      const req = srv['judge_request'] as Record<string, unknown> | undefined;
      if (!req) return;
      seenReq = req;
      c.send(
        encodeClient({
          judge_verdict: { request_id: req['request_id'], state_hash: 'HONEST', winner_side: 0, ok: true },
        }),
      );
    });

    await sleep(50);
    const verdict = await gw.judge({
      seed: 7, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'],
      decks: { top: ['runner'], bottom: ['infantry_1'] },
    });
    expect(verdict.ok).toBe(true);
    // Judge received the real match's deck restriction, not an empty/omitted field.
    expect(seenReq?.['top_deck']).toEqual(['runner']);
    expect(seenReq?.['bottom_deck']).toEqual(['infantry_1']);
    void a; void b;
  });

  it('no decks on the request (PvE/siege or a friendly match) → judge sees empty top_deck/bottom_deck, not undefined', async () => {
    const port = 19515;
    const gw = startGateway(port);
    const [a, c] = await Promise.all([connect(port, 'a'), connect(port, 'c')]);
    c.send(encodeClient({ client_caps: { can_judge: true } }));

    let seenReq: Record<string, unknown> | undefined;
    c.on('message', (data: ArrayBuffer) => {
      const srv = decodeServer(new Uint8Array(data));
      const req = srv['judge_request'] as Record<string, unknown> | undefined;
      if (!req) return;
      seenReq = req;
      c.send(
        encodeClient({
          judge_verdict: { request_id: req['request_id'], state_hash: 'H', winner_side: 0, ok: true },
        }),
      );
    });

    await sleep(50);
    const verdict = await gw.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['a'] });
    expect(verdict.ok).toBe(true);
    expect(seenReq?.['top_deck'] ?? []).toEqual([]);
    expect(seenReq?.['bottom_deck'] ?? []).toEqual([]);
  });

  it('no eligible candidate (nobody reported canJudge) → {ok:false}', async () => {
    const port = 19511;
    const gw = startGateway(port);
    await connect(port, 'a');
    await connect(port, 'b');
    await sleep(30);
    const verdict = await gw.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: false });
  });

  it('sole canJudge candidate is in exclude list (judging oneself) → {ok:false}', async () => {
    const port = 19512;
    const gw = startGateway(port);
    const a = await connect(port, 'a');
    a.send(encodeClient({ client_caps: { can_judge: true } }));
    await sleep(30);
    const verdict = await gw.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: false });
  });
});
