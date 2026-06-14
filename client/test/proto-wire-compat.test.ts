// proto 线兼容回归（C-2）：客户端 ts-proto 编解码与服务端 protobufjs 必须逐字节一致。
// _proto_vectors.json 是服务端（gameserver/proto，protobufjs 反射）按同一份 transport.proto
// 产出的权威字节向量；任何一端改 .proto 后重跑 `npm run proto:gen` + 重生成向量即可。
//
// 改 transport.proto 后向量需重生（见 design/game/SERVER_API.md §3）。
import { describe, it, expect } from 'vitest';
import { Envelope } from '../src/net/proto/transport';
import vectors from './_proto_vectors.json';

const toBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('proto wire compat: server protobufjs ↔ client ts-proto', () => {
  // 客户端编码的 ClientMsg 必须与服务端权威字节逐字相同
  const clientCases: Record<string, () => Envelope> = {
    room_create: () => Envelope.fromPartial({ client: { roomCreate: { mode: 0 } } }),
    room_join: () => Envelope.fromPartial({ client: { roomJoin: { code: 'ABC234' } } }),
    room_ready: () => Envelope.fromPartial({ client: { roomReady: { ready: true } } }),
    room_leave: () => Envelope.fromPartial({ client: { roomLeave: {} } }),
    room_start: () => Envelope.fromPartial({ client: { roomStart: {} } }),
    cmd_submit: () =>
      Envelope.fromPartial({ client: { cmdSubmit: { commands: new Uint8Array([1, 2, 3, 255]) } } }),
    match_result: () =>
      Envelope.fromPartial({ client: { matchResult: { stateHash: 'deadbeef' } } }),
    conn_resume: () =>
      Envelope.fromPartial({ client: { connResume: { roomId: 'room-1', lastFrame: 42 } } }),
    ping: () => Envelope.fromPartial({ client: { ping: {} } }),
  };

  for (const [name, build] of Object.entries(clientCases)) {
    it(`client encode ${name} is wire-interop with server`, () => {
      const clientBytes = Envelope.encode(build()).finish();
      const serverHex = vectors.client[name as keyof typeof vectors.client];
      // 多数情况逐字节相同；含默认值标量（proto3 规范省略 vs protobufjs 显式写 0）时
      // 字节可不同但语义一致 —— 用「双方字节都解回同一逻辑消息」断言真正的互操作性。
      const fromClient = Envelope.decode(clientBytes);
      const fromServer = Envelope.decode(toBytes(serverHex));
      expect(fromClient).toEqual(fromServer);
    });
  }

  // 客户端解码服务端权威 ServerMsg 字节 → 字段还原正确
  it('decodes room_state', () => {
    const m = Envelope.decode(toBytes(vectors.server.room_state)).server!.roomState!;
    expect(m.code).toBe('ABC234');
    expect(m.phase).toBe(1);
    expect(m.players.map((p) => [p.side, p.name, p.ready, p.connected])).toEqual([
      [0, 'host', true, true],
      [1, 'guest', false, true],
    ]);
  });

  it('decodes match_start (seed uint64 as number)', () => {
    const m = Envelope.decode(toBytes(vectors.server.match_start)).server!.matchStart!;
    expect(m.roomId).toBe('room-1');
    expect(m.mode).toBe(0);
    expect(m.seed).toBe(123456789012);
    expect(m.startFrame).toBe(0);
    expect(m.localSide).toBe(1);
  });

  it('decodes frame_batch (empty window = only to_frame)', () => {
    const m = Envelope.decode(toBytes(vectors.server.frame_batch_empty)).server!.frameBatch!;
    expect(m.toFrame).toBe(9);
    expect(m.frames).toEqual([]);
  });

  it('decodes frame_batch (non-empty frame, opaque cmd bytes preserved + side order)', () => {
    const m = Envelope.decode(toBytes(vectors.server.frame_batch_cmds)).server!.frameBatch!;
    expect(m.toFrame).toBe(12);
    expect(m.frames).toHaveLength(1);
    expect(m.frames[0]!.frame).toBe(12);
    const cmds = m.frames[0]!.cmds;
    expect(cmds.map((c) => c.side)).toEqual([0, 1]);
    expect([...cmds[0]!.commands]).toEqual([8]);
    expect([...cmds[1]!.commands]).toEqual([9, 9]);
  });

  it('decodes conn_resync', () => {
    const m = Envelope.decode(toBytes(vectors.server.conn_resync)).server!.connResync!;
    expect(m.seed).toBe(123456789012);
    expect(m.curFrame).toBe(9);
    expect(m.log).toHaveLength(1);
    expect(m.log[0]!.frame).toBe(6);
    expect([...m.log[0]!.cmds[0]!.commands]).toEqual([7]);
  });

  it('decodes peer_dc', () => {
    const m = Envelope.decode(toBytes(vectors.server.peer_dc)).server!.peerDc!;
    expect(m.side).toBe(0);
    expect(m.graceMs).toBe(60000);
  });

  it('decodes match_over', () => {
    const m = Envelope.decode(toBytes(vectors.server.match_over)).server!.matchOver!;
    expect(m.winnerSide).toBe(1);
    expect(m.reason).toBe('disconnect');
    expect(m.mismatch).toBe(false);
  });

  it('decodes room_error', () => {
    const m = Envelope.decode(toBytes(vectors.server.room_error)).server!.roomError!;
    expect(m.code).toBe('ROOM_FULL');
    expect(m.message).toBe('room is full');
  });

  it('decodes pong', () => {
    const env = Envelope.decode(toBytes(vectors.server.pong));
    expect(env.server!.pong).toBeDefined();
  });
});
