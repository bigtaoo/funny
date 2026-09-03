// Wire codec unit tests (protoCodec.ts). This module is the one place where botsvc has to be
// byte-identical with the client (client/src/game/net/NetInputSource.ts + client/src/net/
// judgeRunner.ts): a bot's match is judged against a real opponent's client, so a disagreement here
// is not a bot bug, it's an anti-cheat hash mismatch on a real player's ranked game.
//
// Until now every path through this file was reached only incidentally, through engineDriver's
// full-match tests — which always feed it well-formed input produced by the engine itself, and only
// ever the `play_card` command AISystem happens to decide. That left the whole defensive half
// untested: the malformed-frame drop, both non-play_card discriminants in each direction, and every
// `?? 0` field default. Those defaults exist because the wire type has no optionality (proto3 scalars
// are always present) while the engine type does, so a command that crosses the boundary with a field
// absent must land on 0 rather than `undefined` — an `undefined` col desyncs the two simulations
// silently instead of failing loudly.
import { describe, it, expect } from 'vitest';
import {
  decodeServerMsg,
  decodeSideCommands,
  encodeEnvelope,
  encodeOutboundCommand,
  fromProtoCommand,
  matchStateHash,
  toProtoCommand,
} from '../src/protoCodec';
import { Envelope } from '../src/generated/transport';
import { PlayerCommands } from '../src/generated/game';
import type { PlayerStats } from '@nw/engine';

const stats = (over: Partial<PlayerStats> = {}): PlayerStats => ({
  owner: 0,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
  ...over,
});

describe('decodeServerMsg', () => {
  it('decodes the server half of a well-formed Envelope', () => {
    const bytes = encodeEnvelope(undefined, { matchOver: { winnerSide: 1, mismatch: false, reason: '' } });
    expect(decodeServerMsg(bytes)?.matchOver).toEqual({ winnerSide: 1, mismatch: false, reason: '' });
  });

  it('returns undefined for a well-formed Envelope carrying only a client message', () => {
    const bytes = encodeEnvelope({ cmdSubmit: { commands: new Uint8Array([1]) } });
    expect(decodeServerMsg(bytes)).toBeUndefined();
  });

  it('returns undefined instead of throwing on a malformed frame', () => {
    // A throw here would escape the ws 'message' handler (envelopeSocket.ts) as an
    // uncaughtException and take the whole fleet's process down, not just this one bot's match.
    expect(decodeServerMsg(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeUndefined();
  });
});

describe('toProtoCommand', () => {
  it('maps upgrade_base to the upgradeBase oneof, clearing the other two', () => {
    expect(toProtoCommand({ type: 'upgrade_base', owner: 1, tick: 5 })).toEqual({
      upgradeBase: {},
      playCard: undefined,
      refreshHand: undefined,
    });
  });

  it('maps refresh_hand to the refreshHand oneof, clearing the other two', () => {
    expect(toProtoCommand({ type: 'refresh_hand', owner: 0, tick: 9 })).toEqual({
      refreshHand: {},
      playCard: undefined,
      upgradeBase: undefined,
    });
  });

  it('maps play_card with explicit col/row through unchanged', () => {
    expect(toProtoCommand({ type: 'play_card', owner: 1, tick: 3, handIndex: 2, col: 4, row: 7 }).playCard).toEqual({
      handIndex: 2,
      col: 4,
      row: 7,
    });
  });

  it('defaults an absent col/row to 0 (proto3 has no optional scalars — undefined would desync, not fail)', () => {
    // AISystem omits `row` for everything but meteor spells, so this is the common case, not an edge.
    expect(toProtoCommand({ type: 'play_card', owner: 1, tick: 3, handIndex: 2 }).playCard).toEqual({
      handIndex: 2,
      col: 0,
      row: 0,
    });
  });
});

describe('fromProtoCommand', () => {
  it('maps the upgradeBase oneof back, stamping the caller-supplied owner/tick', () => {
    expect(fromProtoCommand({ upgradeBase: {} }, 0, 11)).toEqual({ type: 'upgrade_base', owner: 0, tick: 11 });
  });

  it('maps the refreshHand oneof back, stamping the caller-supplied owner/tick', () => {
    expect(fromProtoCommand({ refreshHand: {} }, 1, 12)).toEqual({ type: 'refresh_hand', owner: 1, tick: 12 });
  });

  it('maps a playCard back with its fields', () => {
    expect(fromProtoCommand({ playCard: { handIndex: 3, col: 6, row: 8 } }, 1, 13)).toEqual({
      type: 'play_card',
      owner: 1,
      tick: 13,
      handIndex: 3,
      col: 6,
      row: 8,
    });
  });

  it('falls back to a zeroed play_card when no oneof arm is set at all', () => {
    // An empty PlayerCommand is what an unset/unknown oneof arm decodes to here. Producing a benign
    // hand-0/0/0 play_card keeps this side stepping the same tick count as the peer; emitting
    // `undefined` fields instead would feed the engine a half-formed command mid-lockstep.
    expect(fromProtoCommand({}, 0, 14)).toEqual({
      type: 'play_card',
      owner: 0,
      tick: 14,
      handIndex: 0,
      col: 0,
      row: 0,
    });
  });
});

describe('encodeOutboundCommand / decodeSideCommands round-trip', () => {
  it('round-trips each command type, re-stamping owner and tick from the frame envelope', () => {
    // owner/tick are NOT on the wire (SideCmd.side + FrameCmds.frame carry them once for the whole
    // batch), so the decode side has to re-stamp them — that re-stamping is what this asserts.
    const cases = [
      { type: 'upgrade_base' as const, owner: 1 as const, tick: 0 },
      { type: 'refresh_hand' as const, owner: 1 as const, tick: 0 },
      { type: 'play_card' as const, owner: 1 as const, tick: 0, handIndex: 1, col: 2, row: 3 },
    ];
    for (const cmd of cases) {
      expect(decodeSideCommands(encodeOutboundCommand(cmd), 0, 42)).toEqual([{ ...cmd, owner: 0, tick: 42 }]);
    }
  });

  it('decodes every command in a multi-command batch, not just the first', () => {
    const bytes = PlayerCommands.encode(
      PlayerCommands.fromPartial({ commands: [{ upgradeBase: {} }, { playCard: { handIndex: 4, col: 5, row: 6 } }] }),
    ).finish();
    expect(decodeSideCommands(bytes, 1, 7)).toEqual([
      { type: 'upgrade_base', owner: 1, tick: 7 },
      { type: 'play_card', owner: 1, tick: 7, handIndex: 4, col: 5, row: 6 },
    ]);
  });

  it('decodes an empty batch to no commands', () => {
    expect(decodeSideCommands(PlayerCommands.encode(PlayerCommands.fromPartial({})).finish(), 0, 1)).toEqual([]);
  });
});

describe('encodeEnvelope', () => {
  it('frames a ClientMsg so the server half stays unset', () => {
    const decoded = Envelope.decode(encodeEnvelope({ matchResult: { stateHash: 'abc', winnerSide: 1, statsJson: '' } }));
    expect(decoded.client?.matchResult?.stateHash).toBe('abc');
    expect(decoded.server).toBeUndefined();
  });
});

describe('matchStateHash', () => {
  it('is 8 lowercase hex chars, zero-padded', () => {
    expect(matchStateHash(1, [stats(), stats()])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable for identical input and differs when the winner differs', () => {
    const pair: [PlayerStats, PlayerStats] = [stats({ damageDealtToBase: 10 }), stats({ damageDealtToBase: 20 })];
    expect(matchStateHash(0, pair)).toBe(matchStateHash(0, pair));
    expect(matchStateHash(0, pair)).not.toBe(matchStateHash(1, pair));
  });

  it('distinguishes a draw (null) from either side winning', () => {
    const pair: [PlayerStats, PlayerStats] = [stats(), stats()];
    expect(matchStateHash(null, pair)).not.toBe(matchStateHash(0, pair));
    expect(matchStateHash(null, pair)).not.toBe(matchStateHash(1, pair));
  });

  it('is order-sensitive across the two stats slots (wire-side indexed, not a set)', () => {
    // The 2026-07-14 mirrored-stats bug was exactly this: same two stat objects, swapped slots.
    const a = stats({ damageDealtToBase: 10 });
    const b = stats({ damageDealtToBase: 20 });
    expect(matchStateHash(1, [a, b])).not.toBe(matchStateHash(1, [b, a]));
  });
});
