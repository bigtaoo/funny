// transport 线协议往返单测（M12）。
//
// 服务器侧 decodeClient/encodeServer 是**手写**的 protobufjs snake_case 字段映射，
// 与客户端 ts-proto codegen 是两份独立代码。最阴的失败模式：字段名拼错（如把
// `state_hash` 写成 `stateHash` 喂给 protobufjs）→ 静默丢字段、不报错、运行期才炸。
// 这里用独立加载的同一份 transport.proto 与 server 的编解码对拍，专抓字段丢失。
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { decodeClient, encodeServer, type ServerMsg } from '../src/proto/transport';

// 独立加载契约（与被测模块同一份单一来源）。
const PROTO = path.resolve(__dirname, '../../contracts/transport.proto');
const root = protobuf.parse(fs.readFileSync(PROTO, 'utf8'), { keepCase: true }).root;
const Envelope = root.lookupType('nw.transport.Envelope');

/** 用 protobufjs 把 client oneof body 编码成线字节（喂给被测 decodeClient）。 */
function encodeClient(body: Record<string, unknown>): Uint8Array {
  const env = Envelope.fromObject({ client: body });
  return Envelope.encode(env).finish();
}
/** 把 encodeServer 产出的字节解回普通对象（longs→Number, bytes→数组），断言字段。 */
function decodeServerWire(bytes: Uint8Array): Record<string, any> {
  const msg = Envelope.decode(bytes);
  const obj = Envelope.toObject(msg, {
    longs: Number,
    bytes: Array,
    enums: Number,
    defaults: false,
  }) as { server?: Record<string, any> };
  return obj.server ?? {};
}

describe('transport decodeClient（client 线字节 → ClientMsg）', () => {
  it('room_create: 保留 mode 枚举', () => {
    expect(decodeClient(encodeClient({ room_create: { mode: 1 } }))).toEqual({
      case: 'room_create',
      mode: 1,
    });
  });

  it('room_join: 保留 code', () => {
    expect(decodeClient(encodeClient({ room_join: { code: 'ABC234' } }))).toEqual({
      case: 'room_join',
      code: 'ABC234',
    });
  });

  it('room_ready: 保留 ready 布尔', () => {
    expect(decodeClient(encodeClient({ room_ready: { ready: true } }))).toEqual({
      case: 'room_ready',
      ready: true,
    });
  });

  it('cmd_submit: opaque commands bytes 原样保留', () => {
    const r = decodeClient(encodeClient({ cmd_submit: { commands: new Uint8Array([5, 200, 0, 17]) } }));
    expect(r.case).toBe('cmd_submit');
    expect(Array.from((r as { commands: Uint8Array }).commands)).toEqual([5, 200, 0, 17]);
  });

  it('match_result: snake_case state_hash → stateHash', () => {
    expect(decodeClient(encodeClient({ match_result: { state_hash: 'deadbeef' } }))).toEqual({
      case: 'match_result',
      stateHash: 'deadbeef',
    });
  });

  it('conn_resume: room_id / last_frame → roomId / lastFrame', () => {
    expect(
      decodeClient(encodeClient({ conn_resume: { room_id: 'rid-9', last_frame: 42 } })),
    ).toEqual({ case: 'conn_resume', roomId: 'rid-9', lastFrame: 42 });
  });

  it('空消息 room_leave / room_start / ping 各自识别', () => {
    expect(decodeClient(encodeClient({ room_leave: {} })).case).toBe('room_leave');
    expect(decodeClient(encodeClient({ room_start: {} })).case).toBe('room_start');
    expect(decodeClient(encodeClient({ ping: {} })).case).toBe('ping');
  });

  it('坏帧 / 非 client 方向 → unknown（不抛）', () => {
    expect(decodeClient(encodeServer({ case: 'pong' })).case).toBe('unknown'); // server 方向
  });
});

describe('transport encodeServer（ServerMsg → 线字节）', () => {
  it('room_state: 嵌套 players + phase + code', () => {
    const wire = decodeServerWire(
      encodeServer({
        case: 'room_state',
        code: 'XYZ234',
        phase: 3,
        players: [
          { side: 0, name: 'a', ready: true, connected: true },
          { side: 1, name: 'b', ready: false, connected: false },
        ],
      }),
    );
    expect(wire.room_state.code).toBe('XYZ234');
    expect(wire.room_state.phase).toBe(3);
    expect(wire.room_state.players).toHaveLength(2);
    expect(wire.room_state.players[1]).toMatchObject({ side: 1, name: 'b' });
  });

  it('match_start: seed(uint64) + room_id + local_side 全保留', () => {
    const seed = 2 ** 40 + 123; // 大于 32 位，验证 uint64 不被截断
    const wire = decodeServerWire(
      encodeServer({
        case: 'match_start',
        roomId: 'rid',
        mode: 0,
        seed,
        startFrame: 0,
        localSide: 1,
      }),
    );
    expect(wire.match_start.seed).toBe(seed);
    expect(wire.match_start.room_id).toBe('rid');
    expect(wire.match_start.local_side).toBe(1);
  });

  it('frame_batch: to_frame + 嵌套 frames[].cmds[].commands bytes', () => {
    const wire = decodeServerWire(
      encodeServer({
        case: 'frame_batch',
        toFrame: 9,
        frames: [
          {
            frame: 9,
            cmds: [
              { side: 0, commands: new Uint8Array([1, 2]) },
              { side: 1, commands: new Uint8Array([9]) },
            ],
          },
        ],
      }),
    );
    expect(wire.frame_batch.to_frame).toBe(9);
    expect(wire.frame_batch.frames[0].frame).toBe(9);
    expect(wire.frame_batch.frames[0].cmds[0]).toMatchObject({ side: 0, commands: [1, 2] });
    expect(wire.frame_batch.frames[0].cmds[1].commands).toEqual([9]);
  });

  it('frame_batch 空窗: frames 省略，仅 to_frame', () => {
    const wire = decodeServerWire(encodeServer({ case: 'frame_batch', toFrame: 6, frames: [] }));
    expect(wire.frame_batch.to_frame).toBe(6);
    expect(wire.frame_batch.frames ?? []).toEqual([]);
  });

  it('conn_resync: seed + cur_frame + 嵌套 log', () => {
    const wire = decodeServerWire(
      encodeServer({
        case: 'conn_resync',
        seed: 777,
        startFrame: 0,
        curFrame: 12,
        log: [{ frame: 9, cmds: [{ side: 1, commands: new Uint8Array([3]) }] }],
      }),
    );
    expect(wire.conn_resync.seed).toBe(777);
    expect(wire.conn_resync.cur_frame).toBe(12);
    expect(wire.conn_resync.log[0].cmds[0].commands).toEqual([3]);
  });

  it('match_over: winner_side / reason / mismatch；无 elo 时不带 elo', () => {
    const wire = decodeServerWire(
      encodeServer({ case: 'match_over', winnerSide: 0, reason: 'base', mismatch: false }),
    );
    expect(wire.match_over.reason).toBe('base');
    expect(wire.match_over.elo).toBeUndefined();
  });

  it('match_over: 带 elo（ranked）时 rank_after 映射正确', () => {
    const wire = decodeServerWire(
      encodeServer({
        case: 'match_over',
        winnerSide: 1,
        reason: 'base',
        mismatch: false,
        elo: { delta: 12, after: 1212, rankAfter: 'gold' },
      }),
    );
    expect(wire.match_over.elo).toMatchObject({ delta: 12, after: 1212, rank_after: 'gold' });
  });

  it('peer_dc / room_error / pong 字段保留', () => {
    expect(decodeServerWire(encodeServer({ case: 'peer_dc', side: 1, graceMs: 60000 })).peer_dc).toMatchObject(
      { side: 1, grace_ms: 60000 },
    );
    expect(
      decodeServerWire(encodeServer({ case: 'room_error', code: 'ROOM_FULL', message: 'full' }))
        .room_error,
    ).toMatchObject({ code: 'ROOM_FULL', message: 'full' });
    expect(decodeServerWire(encodeServer({ case: 'pong' }))).toHaveProperty('pong');
  });
});

// 全 ServerMsg case 覆盖守卫：新增 case 但漏写 encodeServer 分支会在此暴露。
describe('encodeServer 覆盖所有 ServerMsg case', () => {
  const samples: ServerMsg[] = [
    { case: 'room_state', code: 'C', players: [], phase: 0 },
    { case: 'match_start', roomId: 'r', mode: 0, seed: 1, startFrame: 0, localSide: 0 },
    { case: 'frame_batch', toFrame: 3, frames: [] },
    { case: 'conn_resync', seed: 1, startFrame: 0, log: [], curFrame: 3 },
    { case: 'peer_dc', side: 0, graceMs: 1 },
    { case: 'match_over', winnerSide: 0, reason: 'base', mismatch: false },
    { case: 'room_error', code: 'X', message: 'y' },
    { case: 'pong' },
  ];
  it.each(samples.map((s) => [s.case, s] as const))('%s 可编码且非空', (_c, msg) => {
    const bytes = encodeServer(msg);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
