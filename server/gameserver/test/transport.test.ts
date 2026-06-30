// Transport wire-protocol round-trip unit tests (M12).
//
// The server-side decodeClient/encodeServer is **hand-written** protobufjs snake_case field mapping,
// independent from the client ts-proto codegen. The nastiest failure mode: a misspelled field name (e.g.
// writing `stateHash` instead of `state_hash` when feeding protobufjs) → silently drops the field, no error, only blows up at runtime.
// This suite cross-checks against the same transport.proto loaded independently to catch field-loss bugs.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { decodeClient, encodeServer, type ServerMsg } from '../src/proto/transport';

// Load the contract independently (same single source as the module under test).
const PROTO = path.resolve(__dirname, '../../contracts/transport.proto');
const root = protobuf.parse(fs.readFileSync(PROTO, 'utf8'), { keepCase: true }).root;
const Envelope = root.lookupType('nw.transport.Envelope');

/** Encode a client oneof body into wire bytes using protobufjs (fed into the decodeClient under test). */
function encodeClient(body: Record<string, unknown>): Uint8Array {
  const env = Envelope.fromObject({ client: body });
  return Envelope.encode(env).finish();
}
/** Decode bytes produced by encodeServer back to a plain object (longs→Number, bytes→Array) for field assertions. */
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

describe('transport decodeClient (client wire bytes → ClientMsg)', () => {
  it('room_create: preserves mode enum', () => {
    expect(decodeClient(encodeClient({ room_create: { mode: 1 } }))).toEqual({
      case: 'room_create',
      mode: 1,
    });
  });

  it('room_join: preserves code', () => {
    expect(decodeClient(encodeClient({ room_join: { code: 'ABC234' } }))).toEqual({
      case: 'room_join',
      code: 'ABC234',
    });
  });

  it('room_ready: preserves ready boolean', () => {
    expect(decodeClient(encodeClient({ room_ready: { ready: true } }))).toEqual({
      case: 'room_ready',
      ready: true,
    });
  });

  it('cmd_submit: opaque commands bytes preserved as-is', () => {
    const r = decodeClient(encodeClient({ cmd_submit: { commands: new Uint8Array([5, 200, 0, 17]) } }));
    expect(r.case).toBe('cmd_submit');
    expect(Array.from((r as { commands: Uint8Array }).commands)).toEqual([5, 200, 0, 17]);
  });

  it('match_result: snake_case state_hash / winner_side mapped to stateHash / winnerSide', () => {
    expect(
      decodeClient(encodeClient({ match_result: { state_hash: 'deadbeef', winner_side: 1 } })),
    ).toEqual({
      case: 'match_result',
      stateHash: 'deadbeef',
      winnerSide: 1,
    });
  });

  it('conn_resume: room_id / last_frame mapped to roomId / lastFrame', () => {
    expect(
      decodeClient(encodeClient({ conn_resume: { room_id: 'rid-9', last_frame: 42 } })),
    ).toEqual({ case: 'conn_resume', roomId: 'rid-9', lastFrame: 42 });
  });

  it('empty messages room_leave / room_start / ping each recognized correctly', () => {
    expect(decodeClient(encodeClient({ room_leave: {} })).case).toBe('room_leave');
    expect(decodeClient(encodeClient({ room_start: {} })).case).toBe('room_start');
    expect(decodeClient(encodeClient({ ping: {} })).case).toBe('ping');
  });

  it('bad frame / non-client direction → unknown (no throw)', () => {
    expect(decodeClient(encodeServer({ case: 'pong' })).case).toBe('unknown'); // server direction
  });
});

describe('transport encodeServer (ServerMsg → wire bytes)', () => {
  it('room_state: nested players + phase + code', () => {
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

  it('match_start: seed(uint64) + room_id + local_side all preserved', () => {
    const seed = 2 ** 40 + 123; // larger than 32 bits — verifies uint64 is not truncated
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

  it('frame_batch: to_frame + nested frames[].cmds[].commands bytes', () => {
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

  it('frame_batch empty window: frames omitted, only to_frame', () => {
    const wire = decodeServerWire(encodeServer({ case: 'frame_batch', toFrame: 6, frames: [] }));
    expect(wire.frame_batch.to_frame).toBe(6);
    expect(wire.frame_batch.frames ?? []).toEqual([]);
  });

  it('conn_resync: seed + cur_frame + nested log', () => {
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

  it('match_over: winner_side / reason / mismatch; no elo field when unranked', () => {
    const wire = decodeServerWire(
      encodeServer({ case: 'match_over', winnerSide: 0, reason: 'base', mismatch: false }),
    );
    expect(wire.match_over.reason).toBe('base');
    expect(wire.match_over.elo).toBeUndefined();
  });

  it('match_over: with elo (ranked) rank_after is mapped correctly', () => {
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

  it('peer_dc / room_error / pong fields preserved', () => {
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

// Coverage guard for all ServerMsg cases: adding a new case but forgetting the encodeServer branch will be caught here.
describe('encodeServer covers all ServerMsg cases', () => {
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
  it.each(samples.map((s) => [s.case, s] as const))('%s can be encoded and produces non-empty bytes', (_c, msg) => {
    const bytes = encodeServer(msg);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
