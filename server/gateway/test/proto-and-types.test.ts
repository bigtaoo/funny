// src/proto.ts (decodeClient/encodeServer) + src/gateway/types.ts (toServerMsg/displayName) unit tests.
// Both were previously only exercised incidentally through gateway-routing.test.ts/judge.test.ts's handful
// of end-to-end scenarios (room_create/join/ready, match_found, room_error, judge_verdict) — the social/SLG
// push kinds (friend_*/chat_message/mail_new/march_update/tile_update/under_attack/siege_result/family_msg/
// sect_msg/nation_msg/duel_invited/duel_cancelled/queue_state/pre_match_lost) and several ClientMsg cases
// (duel_respond/client_caps) had never been decoded/encoded/mapped by any test (proto.ts 65.1%, types.ts 27.1%).
//
// This file drives both layers directly + round-trips every wire case through the real generated
// Envelope/ClientMsg/ServerMsg (ts-proto), same encode/decode pair proto.ts itself uses — no protobufjs
// duplicate parsing needed (unlike gateway-routing.test.ts, which parses transport.proto with protobufjs
// because it needs to build ClientMsg oneofs the same way a *real client* would, from scratch).
import { describe, it, expect } from 'vitest';
import { decodeClient, encodeServer, MatchMode, RoomPhase, type ServerMsg } from '../src/proto';
import { Envelope, FriendUpdateKind } from '../src/generated/transport';
import { toServerMsg, displayName } from '../src/gateway/types';
import type { PushMsg } from '../src/matchsvcClient';

function encodeClientRaw(client: Record<string, unknown>): Uint8Array {
  return Envelope.encode(Envelope.fromPartial({ client })).finish();
}
function decodeServerRaw(buf: Uint8Array): Record<string, unknown> {
  return (Envelope.decode(buf).server ?? {}) as Record<string, unknown>;
}

describe('decodeClient', () => {
  it('room_create: carries mode + deck', () => {
    const msg = decodeClient(encodeClientRaw({ roomCreate: { mode: MatchMode.RANKED, deck: ['c1', 'c2'] } }));
    expect(msg).toEqual({ case: 'room_create', mode: MatchMode.RANKED, deck: ['c1', 'c2'] });
  });
  it('room_join: carries code + deck', () => {
    const msg = decodeClient(encodeClientRaw({ roomJoin: { code: 'ABC123', deck: ['c3'] } }));
    expect(msg).toEqual({ case: 'room_join', code: 'ABC123', deck: ['c3'] });
  });
  it('room_ready: carries ready flag', () => {
    expect(decodeClient(encodeClientRaw({ roomReady: { ready: true } }))).toEqual({ case: 'room_ready', ready: true });
  });
  it('room_leave: no fields, presence alone selects the case', () => {
    expect(decodeClient(encodeClientRaw({ roomLeave: {} }))).toEqual({ case: 'room_leave' });
  });
  it('room_start: no fields, presence alone selects the case', () => {
    expect(decodeClient(encodeClientRaw({ roomStart: {} }))).toEqual({ case: 'room_start' });
  });
  it('ping: no fields, presence alone selects the case', () => {
    expect(decodeClient(encodeClientRaw({ ping: {} }))).toEqual({ case: 'ping' });
  });
  it('duel_invite: carries toPublicId + deck', () => {
    const msg = decodeClient(encodeClientRaw({ duelInvite: { toPublicId: '100000001', deck: ['c4'] } }));
    expect(msg).toEqual({ case: 'duel_invite', toPublicId: '100000001', deck: ['c4'] });
  });
  it('duel_respond: carries inviteId/accept/deck', () => {
    const msg = decodeClient(encodeClientRaw({ duelRespond: { inviteId: 'inv1', accept: true, deck: ['c5'] } }));
    expect(msg).toEqual({ case: 'duel_respond', inviteId: 'inv1', accept: true, deck: ['c5'] });
  });
  it('client_caps: carries canJudge', () => {
    expect(decodeClient(encodeClientRaw({ clientCaps: { canJudge: true } }))).toEqual({ case: 'client_caps', canJudge: true });
  });
  it('judge_verdict: carries the full re-simulation report', () => {
    const msg = decodeClient(
      encodeClientRaw({ judgeVerdict: { requestId: 'req1', stateHash: 'hash1', winnerSide: 1, ok: true, stars: 3, statsJson: '{"kill.archer":2}' } }),
    );
    expect(msg).toEqual({ case: 'judge_verdict', requestId: 'req1', stateHash: 'hash1', winnerSide: 1, ok: true, stars: 3, statsJson: '{"kill.archer":2}' });
  });
  it('empty envelope (no client field at all) -> unknown', () => {
    expect(decodeClient(Envelope.encode(Envelope.fromPartial({})).finish())).toEqual({ case: 'unknown' });
  });
  it('data-plane-only cases (cmd_submit/match_result/conn_resume) decode as unknown here — gateway only understands the control-plane subset', () => {
    expect(decodeClient(encodeClientRaw({ cmdSubmit: { commands: new Uint8Array([1, 2]) } }))).toEqual({ case: 'unknown' });
  });
});

describe('encodeServer', () => {
  it('room_state: full player slot list + phase round-trip', () => {
    const msg: ServerMsg = { case: 'room_state', code: 'ABC123', phase: RoomPhase.READY, players: [{ side: 0, name: 'Alice', ready: true, connected: true, publicId: '100000001' }] };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.roomState).toMatchObject({ code: 'ABC123', phase: RoomPhase.READY, players: [{ side: 0, name: 'Alice', ready: true, connected: true, publicId: '100000001' }] });
  });
  it('match_found', () => {
    const server = decodeServerRaw(encodeServer({ case: 'match_found', gameUrl: 'wss://g1', ticket: 't1' }));
    expect(server.matchFound).toMatchObject({ gameUrl: 'wss://g1', ticket: 't1' });
  });
  it('match_bot', () => {
    const server = decodeServerRaw(encodeServer({ case: 'match_bot', seed: 42, opponentName: 'AI', elo: 1200, difficulty: '7' }));
    expect(server.matchBot).toMatchObject({ seed: 42, opponentName: 'AI', elo: 1200, difficulty: '7' });
  });
  it('room_error', () => {
    const server = decodeServerRaw(encodeServer({ case: 'room_error', code: 'RATE_LIMITED', message: 'slow down' }));
    expect(server.roomError).toMatchObject({ code: 'RATE_LIMITED', message: 'slow down' });
  });
  it('judge_request: full frames + decks payload', () => {
    const msg: ServerMsg = {
      case: 'judge_request', requestId: 'req1', seed: 7, mode: MatchMode.RANKED, endFrame: 100,
      frames: [{ frame: 1, cmds: [{ side: 0, commands: new Uint8Array([9]) }] }],
      levelId: '', cardInstancesJson: '{}', equipmentInvJson: '{}', topDeck: ['c1'], bottomDeck: ['c2'],
    };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.judgeRequest).toMatchObject({ requestId: 'req1', seed: 7, mode: MatchMode.RANKED, endFrame: 100, topDeck: ['c1'], bottomDeck: ['c2'] });
  });
  it('friend_presence', () => {
    const server = decodeServerRaw(encodeServer({ case: 'friend_presence', publicId: '100000002', online: true }));
    expect(server.friendPresence).toMatchObject({ publicId: '100000002', online: true });
  });
  it('friend_request', () => {
    const server = decodeServerRaw(encodeServer({ case: 'friend_request', requestId: 'fr1', fromPublicId: '100000003', fromName: 'Bob', message: 'hi' }));
    expect(server.friendRequest).toMatchObject({ requestId: 'fr1', fromPublicId: '100000003', fromName: 'Bob', message: 'hi' });
  });
  it('friend_update: added -> ADDED, removed -> REMOVED', () => {
    expect((decodeServerRaw(encodeServer({ case: 'friend_update', publicId: '1', added: true })).friendUpdate as { kind: number }).kind).toBe(FriendUpdateKind.ADDED);
    expect((decodeServerRaw(encodeServer({ case: 'friend_update', publicId: '1', added: false })).friendUpdate as { kind: number }).kind).toBe(FriendUpdateKind.REMOVED);
  });
  it('chat_message', () => {
    const server = decodeServerRaw(encodeServer({ case: 'chat_message', convId: 'c1', fromPublicId: '1', fromName: 'A', body: 'hey', ts: 123 }));
    expect(server.chatMessage).toMatchObject({ convId: 'c1', fromPublicId: '1', fromName: 'A', body: 'hey' });
  });
  it('mail_new', () => {
    const server = decodeServerRaw(encodeServer({ case: 'mail_new', mailId: 'm1', hasAttachment: true }));
    expect(server.mailNew).toMatchObject({ mailId: 'm1', hasAttachment: true });
  });
  it('march_update', () => {
    const msg: ServerMsg = { case: 'march_update', marchId: 'mr1', marchKind: 'attack', fromTile: 't1', toTile: 't2', arriveAt: 999, status: 'moving' };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.marchUpdate).toMatchObject({ marchId: 'mr1', kind: 'attack', fromTile: 't1', toTile: 't2', status: 'moving' });
  });
  it('tile_update', () => {
    const msg: ServerMsg = { case: 'tile_update', tileId: 'w1:1:1', type: 'plain', level: 2, ownerPublicId: '1', ownerName: 'Alice', familyId: 'f1', protectedUntil: 0 };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.tileUpdate).toMatchObject({ tileId: 'w1:1:1', type: 'plain', level: 2, ownerPublicId: '1', ownerName: 'Alice', familyId: 'f1' });
  });
  it('under_attack', () => {
    const msg: ServerMsg = { case: 'under_attack', tile: 'w1:2:2', attackerName: 'Bob', attackerPublicId: '2', arriveAt: 555, troopsHint: 10 };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.underAttack).toMatchObject({ tile: 'w1:2:2', attackerName: 'Bob', attackerPublicId: '2', troopsHint: 10 });
  });
  it('siege_result', () => {
    const msg: ServerMsg = { case: 'siege_result', siegeId: 's1', marchId: 'mr2', tile: 'w1:3:3', outcome: 'attacker_win', lootSummary: 'coins=100', replayRef: 'r1', attackerId: 'acc-a', marchKind: 'attack' };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.siegeResult).toMatchObject({ siegeId: 's1', tile: 'w1:3:3', outcome: 'attacker_win', attackerId: 'acc-a', marchKind: 'attack' });
  });
  it('family_msg', () => {
    const msg: ServerMsg = { case: 'family_msg', familyId: 'fam1', fromPublicId: '1', fromName: 'A', body: 'hi fam', ts: 1 };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.familyMsg).toMatchObject({ familyId: 'fam1', fromPublicId: '1', fromName: 'A', text: 'hi fam' });
  });
  it('sect_msg', () => {
    const msg: ServerMsg = { case: 'sect_msg', sectId: 'sect1', fromPublicId: '1', fromName: 'A', body: 'hi sect', ts: 1 };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.sectMsg).toMatchObject({ sectId: 'sect1', fromPublicId: '1', fromName: 'A', text: 'hi sect' });
  });
  it('nation_msg', () => {
    const msg: ServerMsg = { case: 'nation_msg', worldId: 'w1', fromPublicId: '1', fromName: 'A', body: 'hi world', ts: 1 };
    const server = decodeServerRaw(encodeServer(msg));
    expect(server.nationMsg).toMatchObject({ worldId: 'w1', fromPublicId: '1', fromName: 'A', text: 'hi world' });
  });
  it('duel_invited', () => {
    const server = decodeServerRaw(encodeServer({ case: 'duel_invited', inviteId: 'inv1', fromPublicId: '1', fromName: 'A' }));
    expect(server.duelInvited).toMatchObject({ inviteId: 'inv1', fromPublicId: '1', fromName: 'A' });
  });
  it('duel_cancelled', () => {
    const server = decodeServerRaw(encodeServer({ case: 'duel_cancelled', inviteId: 'inv1', reason: 'declined' }));
    expect(server.duelCancelled).toMatchObject({ inviteId: 'inv1', reason: 'declined' });
  });
  it('queue_state: no fields, presence alone selects the case', () => {
    const server = decodeServerRaw(encodeServer({ case: 'queue_state' }));
    expect(server.queueState).toBeTruthy();
  });
  it('pre_match_lost', () => {
    const server = decodeServerRaw(encodeServer({ case: 'pre_match_lost', context: 'room' }));
    expect(server.preMatchLost).toMatchObject({ context: 'room' });
  });
  it('pong: no fields, presence alone selects the case', () => {
    const server = decodeServerRaw(encodeServer({ case: 'pong' }));
    expect(server.pong).toBeTruthy();
  });
});

describe('toServerMsg (matchsvc/social/SLG PushMsg -> control-plane ServerMsg)', () => {
  // One case per PushMsg.kind, each fed straight through encodeServer afterwards to prove the full
  // routeBroadcast/push pipeline (connRegistry.push does exactly this: encodeServer(toServerMsg(msg))).
  const cases: Array<{ push: PushMsg; expected: ServerMsg }> = [
    { push: { kind: 'room_state', code: 'ABC', players: [], phase: 1 }, expected: { case: 'room_state', code: 'ABC', players: [], phase: 1 } },
    { push: { kind: 'match_found', gameUrl: 'wss://g', ticket: 't' }, expected: { case: 'match_found', gameUrl: 'wss://g', ticket: 't' } },
    { push: { kind: 'match_bot', seed: 1, opponentName: 'AI', elo: 1000, difficulty: '5' }, expected: { case: 'match_bot', seed: 1, opponentName: 'AI', elo: 1000, difficulty: '5' } },
    { push: { kind: 'room_error', code: 'X', message: 'm' }, expected: { case: 'room_error', code: 'X', message: 'm' } },
    { push: { kind: 'friend_presence', publicId: '1', online: true }, expected: { case: 'friend_presence', publicId: '1', online: true } },
    { push: { kind: 'friend_request', requestId: 'r', fromPublicId: '1', fromName: 'A', message: 'hi' }, expected: { case: 'friend_request', requestId: 'r', fromPublicId: '1', fromName: 'A', message: 'hi' } },
    { push: { kind: 'friend_update', publicId: '1', added: true }, expected: { case: 'friend_update', publicId: '1', added: true } },
    { push: { kind: 'chat_message', convId: 'c', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 }, expected: { case: 'chat_message', convId: 'c', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 } },
    { push: { kind: 'mail_new', mailId: 'm', hasAttachment: false }, expected: { case: 'mail_new', mailId: 'm', hasAttachment: false } },
    { push: { kind: 'march_update', marchId: 'mr', marchKind: 'attack', fromTile: 't1', toTile: 't2', arriveAt: 1, status: 's' }, expected: { case: 'march_update', marchId: 'mr', marchKind: 'attack', fromTile: 't1', toTile: 't2', arriveAt: 1, status: 's' } },
    { push: { kind: 'tile_update', tileId: 'w:1:1', type: 'plain', level: 1, ownerPublicId: '1', ownerName: 'A', familyId: 'f', protectedUntil: 0 }, expected: { case: 'tile_update', tileId: 'w:1:1', type: 'plain', level: 1, ownerPublicId: '1', ownerName: 'A', familyId: 'f', protectedUntil: 0 } },
    { push: { kind: 'under_attack', tile: 'w:1:1', attackerName: 'B', attackerPublicId: '2', arriveAt: 1, troopsHint: 5 }, expected: { case: 'under_attack', tile: 'w:1:1', attackerName: 'B', attackerPublicId: '2', arriveAt: 1, troopsHint: 5 } },
    { push: { kind: 'siege_result', siegeId: 's', marchId: 'mr', tile: 'w:1:1', outcome: 'attacker_win', lootSummary: 'l', replayRef: 'r', attackerId: 'a', marchKind: 'attack' }, expected: { case: 'siege_result', siegeId: 's', marchId: 'mr', tile: 'w:1:1', outcome: 'attacker_win', lootSummary: 'l', replayRef: 'r', attackerId: 'a', marchKind: 'attack' } },
    { push: { kind: 'family_msg', familyId: 'f', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 }, expected: { case: 'family_msg', familyId: 'f', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 } },
    { push: { kind: 'sect_msg', sectId: 's', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 }, expected: { case: 'sect_msg', sectId: 's', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 } },
    { push: { kind: 'nation_msg', worldId: 'w', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 }, expected: { case: 'nation_msg', worldId: 'w', fromPublicId: '1', fromName: 'A', body: 'b', ts: 1 } },
    { push: { kind: 'duel_invited', inviteId: 'i', fromPublicId: '1', fromName: 'A' }, expected: { case: 'duel_invited', inviteId: 'i', fromPublicId: '1', fromName: 'A' } },
    { push: { kind: 'duel_cancelled', inviteId: 'i', reason: 'declined' }, expected: { case: 'duel_cancelled', inviteId: 'i', reason: 'declined' } },
    { push: { kind: 'queue_state' }, expected: { case: 'queue_state' } },
    { push: { kind: 'prematch_lost', context: 'room' }, expected: { case: 'pre_match_lost', context: 'room' } },
  ];

  for (const { push, expected } of cases) {
    it(`${push.kind} -> ${expected.case}`, () => {
      const server = toServerMsg(push);
      expect(server).toEqual(expected);
      // Full pipeline sanity: whatever toServerMsg produced must itself be encodable (connRegistry.push
      // calls encodeServer(toServerMsg(msg)) verbatim) — a case mapped to a field encodeServer doesn't
      // handle would throw here.
      expect(() => encodeServer(server as ServerMsg)).not.toThrow();
    });
  }
});

describe('displayName', () => {
  it('truncates an accountId to its first 12 characters', () => {
    expect(displayName('0123456789abcdefghij')).toBe('0123456789ab');
  });
  it('shorter accountIds pass through unchanged', () => {
    expect(displayName('short')).toBe('short');
  });
});
