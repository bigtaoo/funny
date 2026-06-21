// 对等裁判端到端单测（Phase C）：真 Gateway WS + 三个 ws 客户端（两参赛 + 一裁判）。
// 验证 gateway.judge 挑出上报了 canJudge 且不在 exclude 中的玩家、推 judge_request、
// 收到 judge_verdict 后解出裁决；无候选 → {ok:false}。
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
  it('挑出 canJudge 的第三方、推 request、解出 verdict', async () => {
    const port = 19510;
    const gw = startGateway(port);
    const [a, b, c] = await Promise.all([
      connect(port, 'a'),
      connect(port, 'b'),
      connect(port, 'c'),
    ]);

    // 裁判 c 上报 canJudge；参赛 a/b 不上报（默认 false，且被 exclude）。
    c.send(encodeClient({ client_caps: { can_judge: true } }));

    // c 收到 judge_request → 回 verdict。
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

    await sleep(50); // 让 client_caps 先到达 gateway
    const verdict = await gw.judge({ seed: 7, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: true, stateHash: 'HONEST', winnerSide: 0, stars: 0, statsJson: '', judgeAccountId: 'c' });
    void a; void b;
  });

  it('PvE 抽检：transport level_id/pve_upgrades 透传给裁判，verdict.stars 解出', async () => {
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
          // S9-3b：PvE 抽检复算回报本局成就计数 stats_json，gateway 透传回 meta。
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
    // 裁判收到 PvE 复算参数（level_id + 权威蓝图快照）。
    expect(seenReq?.['level_id']).toBe('ch1_lv2');
    expect(seenReq?.['pve_upgrades']).toEqual({ inf_hp: 3 });
    void p;
  });

  it('无合格候选（无人上报 canJudge）→ {ok:false}', async () => {
    const port = 19511;
    const gw = startGateway(port);
    await connect(port, 'a');
    await connect(port, 'b');
    await sleep(30);
    const verdict = await gw.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: false });
  });

  it('唯一 canJudge 者在 exclude 内（自己裁自己）→ {ok:false}', async () => {
    const port = 19512;
    const gw = startGateway(port);
    const a = await connect(port, 'a');
    a.send(encodeClient({ client_caps: { can_judge: true } }));
    await sleep(30);
    const verdict = await gw.judge({ seed: 1, mode: 1, endFrame: 0, frames: [], exclude: ['a', 'b'] });
    expect(verdict).toEqual({ ok: false });
  });
});
