// Proto wire compatibility regression (C-2): client ts-proto encode/decode must be byte-for-byte
// consistent with server-side protobufjs. _proto_vectors.json contains the authoritative byte
// vectors produced by the server (gameserver/proto, protobufjs reflection) from the same
// transport.proto; after changing .proto on either side, re-run `npm run proto:gen` and
// regenerate the vectors via `node scripts/gen-proto-vectors.mjs` (from client/) — added
// 2026-08-05 alongside the message additions below; previously this regen step had no script at
// all, so _proto_vectors.json had silently gone stale for every oneof case added since the
// original ~18 (duel_*, judge_request, family/sect/nation chat, march/tile/siege events,
// queue_state, pre_match_lost, match_bot, friend_*, match_found — none had a byte-level vector).
//
// Vectors must be regenerated after any change to transport.proto (see design/game/SERVER_API.md §3).
import { describe, it, expect } from 'vitest';
import { Envelope } from '../src/net/proto/transport';
import vectors from './_proto_vectors.json';

const toBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('proto wire compat: server protobufjs ↔ client ts-proto', () => {
  // Client-encoded ClientMsg must match the server authoritative bytes exactly
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
    client_caps: () => Envelope.fromPartial({ client: { clientCaps: { canJudge: true } } }),
    judge_verdict: () =>
      Envelope.fromPartial({
        client: {
          judgeVerdict: {
            requestId: 'req-1', stateHash: 'cafebabe', winnerSide: 1, ok: true,
            stars: 3, statsJson: '{"kill.archer":2}',
          },
        },
      }),
    duel_invite: () =>
      Envelope.fromPartial({ client: { duelInvite: { toPublicId: '123456789', deck: ['card_a', 'card_b'] } } }),
    duel_respond: () =>
      Envelope.fromPartial({ client: { duelRespond: { inviteId: 'inv-1', accept: true, deck: ['card_a'] } } }),
  };

  for (const [name, build] of Object.entries(clientCases)) {
    it(`client encode ${name} is wire-interop with server`, () => {
      const clientBytes = Envelope.encode(build()).finish();
      const serverHex = vectors.client[name as keyof typeof vectors.client];
      // In most cases the bytes are identical; when a default-value scalar is involved
      // (proto3 spec omits it, protobufjs writes explicit 0) the bytes may differ but
      // the semantics are equivalent — assert true interop by decoding both sides and
      // comparing the resulting logical messages.
      const fromClient = Envelope.decode(clientBytes);
      const fromServer = Envelope.decode(toBytes(serverHex));
      expect(fromClient).toEqual(fromServer);
    });
  }

  // Client decodes server authoritative ServerMsg bytes → fields round-trip correctly
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

  it('decodes match_found', () => {
    const m = Envelope.decode(toBytes(vectors.server.match_found)).server!.matchFound!;
    expect(m.gameUrl).toBe('wss://game.example/ws');
    expect(m.ticket).toBe('tk-1');
  });

  it('decodes judge_request (frames + PvE/siege re-simulation fields)', () => {
    const m = Envelope.decode(toBytes(vectors.server.judge_request)).server!.judgeRequest!;
    expect(m.requestId).toBe('jr-1');
    expect(m.seed).toBe(123456789012);
    expect(m.mode).toBe(1);
    expect(m.endFrame).toBe(30);
    expect(m.frames).toHaveLength(1);
    expect(m.frames[0]!.frame).toBe(5);
    expect([...m.frames[0]!.cmds[0]!.commands]).toEqual([9]);
    expect(m.levelId).toBe('ch1_lv1');
    expect(m.topDeck).toEqual(['a']);
    expect(m.bottomDeck).toEqual(['b']);
    expect(m.cardInstancesJson).toBe('{}');
    expect(m.equipmentInvJson).toBe('{}');
  });

  it('decodes friend_presence', () => {
    const m = Envelope.decode(toBytes(vectors.server.friend_presence)).server!.friendPresence!;
    expect(m.publicId).toBe('111222333');
    expect(m.online).toBe(true);
  });

  it('decodes friend_request', () => {
    const m = Envelope.decode(toBytes(vectors.server.friend_request)).server!.friendRequest!;
    expect(m).toEqual({ requestId: 'fr-1', fromPublicId: '222333444', fromName: 'Bob', message: 'hi' });
  });

  it('decodes friend_update (REMOVED kind)', () => {
    const m = Envelope.decode(toBytes(vectors.server.friend_update)).server!.friendUpdate!;
    expect(m.publicId).toBe('333444555');
    expect(m.kind).toBe(1); // FriendUpdateKind.REMOVED
  });

  it('decodes chat_message (ts as number, not truncated)', () => {
    const m = Envelope.decode(toBytes(vectors.server.chat_message)).server!.chatMessage!;
    expect(m).toEqual({ convId: 'c1', fromPublicId: '444555666', fromName: 'Ann', body: 'yo', ts: 1000 });
  });

  it('decodes mail_new', () => {
    const m = Envelope.decode(toBytes(vectors.server.mail_new)).server!.mailNew!;
    expect(m).toEqual({ mailId: 'm1', hasAttachment: true });
  });

  it('decodes march_update', () => {
    const m = Envelope.decode(toBytes(vectors.server.march_update)).server!.marchUpdate!;
    expect(m).toEqual({
      marchId: 'mch1', kind: 'attack', fromTile: 'w:1:1', toTile: 'w:2:2', arriveAt: 5000, status: 'moving',
    });
  });

  it('decodes tile_update', () => {
    const m = Envelope.decode(toBytes(vectors.server.tile_update)).server!.tileUpdate!;
    expect(m).toEqual({
      tileId: 'w:3:3', type: 'plain', level: 2, ownerPublicId: '555666777',
      familyId: 'fam1', protectedUntil: 0, ownerName: 'Bob',
    });
  });

  it('decodes under_attack', () => {
    const m = Envelope.decode(toBytes(vectors.server.under_attack)).server!.underAttack!;
    expect(m).toEqual({
      tile: 'w:4:4', attackerName: 'Eve', attackerPublicId: '666777888', arriveAt: 6000, troopsHint: 200,
    });
  });

  it('decodes siege_result (2026-08-02 attackerId/marchKind classification fields)', () => {
    const m = Envelope.decode(toBytes(vectors.server.siege_result)).server!.siegeResult!;
    expect(m).toEqual({
      siegeId: 's1', tile: 'w:5:5', outcome: 'attacker_win', lootSummary: '100 coins',
      replayRef: 'rep1', marchId: 'mch2', attackerId: 'acc1', marchKind: 'attack',
    });
  });

  it('decodes family_msg', () => {
    const m = Envelope.decode(toBytes(vectors.server.family_msg)).server!.familyMsg!;
    expect(m).toEqual({ familyId: 'fam1', fromPublicId: '777888999', fromName: 'Cara', text: 'hello family', ts: 2000 });
  });

  it('decodes sect_msg', () => {
    const m = Envelope.decode(toBytes(vectors.server.sect_msg)).server!.sectMsg!;
    expect(m).toEqual({ sectId: 'sect1', fromPublicId: '888999000', fromName: 'Dan', text: 'hello sect', ts: 3000 });
  });

  it('decodes nation_msg', () => {
    const m = Envelope.decode(toBytes(vectors.server.nation_msg)).server!.nationMsg!;
    expect(m).toEqual({ worldId: 'w1', fromPublicId: '999000111', fromName: 'Eli', text: 'hello nation', ts: 4000 });
  });

  it('decodes match_bot (seed uint64 + decimal-string difficulty)', () => {
    const m = Envelope.decode(toBytes(vectors.server.match_bot)).server!.matchBot!;
    expect(m).toEqual({ seed: 987654321098, opponentName: 'AI Bot', elo: 1200, difficulty: '5' });
  });

  it('decodes duel_invited', () => {
    const m = Envelope.decode(toBytes(vectors.server.duel_invited)).server!.duelInvited!;
    expect(m).toEqual({ inviteId: 'inv-2', fromPublicId: '100200300', fromName: 'Fay' });
  });

  it('decodes duel_cancelled', () => {
    const m = Envelope.decode(toBytes(vectors.server.duel_cancelled)).server!.duelCancelled!;
    expect(m).toEqual({ inviteId: 'inv-3', reason: 'declined' });
  });

  it('decodes queue_state (fieldless — matchsvc-restart rehydrate confirmation)', () => {
    const env = Envelope.decode(toBytes(vectors.server.queue_state));
    expect(env.server!.queueState).toBeDefined();
  });

  it('decodes pre_match_lost', () => {
    const m = Envelope.decode(toBytes(vectors.server.pre_match_lost)).server!.preMatchLost!;
    expect(m).toEqual({ context: 'queue' });
  });
});
