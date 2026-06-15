// gateway 控制面路由端到端单测：真 Gateway WS + ws 客户端。
// 覆盖此前只在 client 侧 MatchsvcClient 单测、未在 gateway 侧验证的两条主线：
//   1. account→socket 映射：连接登记、命令按 accountId 转发给 matchsvc、push 只到目标 socket、
//      同账号新连顶替旧连（4409）；
//   2. ranked 入队时 meta 不可用 → 回推 room_error{RANKED_UNAVAILABLE}（此前无直接测）。
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

/** matchsvc 录制桩：记录 gateway 转发的每个调用（不发真 HTTP）。 */
class RecordingMatchsvc extends MatchsvcClient {
  readonly calls: { m: string; args: unknown[] }[] = [];
  constructor() {
    super(null, KEY);
  }
  override roomCreate(a: string, n: string, p: string): void { this.calls.push({ m: 'roomCreate', args: [a, n, p] }); }
  override roomJoin(a: string, n: string, p: string, c: string): void { this.calls.push({ m: 'roomJoin', args: [a, n, p, c] }); }
  override roomReady(a: string, r: boolean): void { this.calls.push({ m: 'roomReady', args: [a, r] }); }
  override roomStart(a: string): void { this.calls.push({ m: 'roomStart', args: [a] }); }
  override roomLeave(a: string): void { this.calls.push({ m: 'roomLeave', args: [a] }); }
  override enqueue(a: string, n: string, p: string, e: number): void { this.calls.push({ m: 'enqueue', args: [a, n, p, e] }); }
  override connected(a: string): void { this.calls.push({ m: 'connected', args: [a] }); }
  override disconnected(a: string): void { this.calls.push({ m: 'disconnected', args: [a] }); }
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
    meta ?? new MetaClient(null, KEY), // 默认 meta 不可用
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

/** 等待某个 server 消息（按 oneof key），超时 reject。 */
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
  it('登记连接并按 accountId 把控制命令转发给 matchsvc', async () => {
    const port = 19520;
    const mm = new RecordingMatchsvc();
    startGateway(port, mm);
    const a = await connect(port, 'acc-a');

    // 连接即登记到 matchsvc。
    expect(mm.calls.some((c) => c.m === 'connected' && c.args[0] === 'acc-a')).toBe(true);

    a.send(encodeClient({ room_create: { mode: 0 } })); // friendly
    a.send(encodeClient({ room_ready: { ready: true } }));
    a.send(encodeClient({ room_start: {} }));
    a.send(encodeClient({ room_leave: {} }));
    await sleep(60); // room_create 经 resolveProfile 异步转发

    expect(mm.calls.find((c) => c.m === 'roomReady')?.args).toEqual(['acc-a', true]);
    expect(mm.calls.find((c) => c.m === 'roomStart')?.args).toEqual(['acc-a']);
    expect(mm.calls.find((c) => c.m === 'roomLeave')?.args).toEqual(['acc-a']);
    // friendly create：meta 不可用 → 名字退回 accountId 前缀、publicId 空。
    expect(mm.calls.find((c) => c.m === 'roomCreate')?.args).toEqual(['acc-a', 'acc-a', '']);
  });

  it('push 只发到拥有该 accountId 的 socket', async () => {
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
    expect(bGotIt).toBe(false); // b 不应收到发给 a 的消息
  });

  it('同账号新连顶替旧连（旧 socket 收到 4409）', async () => {
    const port = 19522;
    startGateway(port, new RecordingMatchsvc());
    const ws1 = await connect(port, 'dup');
    const closed = new Promise<number>((res) => ws1.on('close', (code: number) => res(code)));

    await connect(port, 'dup'); // 第二条同账号连接
    expect(await closed).toBe(4409);
  });

  it('ranked 入队时 meta 不可用 → 回推 RANKED_UNAVAILABLE，且不入队', async () => {
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
