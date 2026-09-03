/**
 * `game/net/NetInputSource.ts` — the proto codec arms and the deck field on both match-rebuild
 * messages.
 *
 * `net-input-source.test.ts` covers the watermark/buffer/stall semantics and the two-engine
 * parity integration; what it never sends is a `refresh_hand`, an `upgrade_base` decode, a
 * `play_card` without col/row, a command variant this build cannot read, or a one-sided deck
 * list — 9 branches.
 *
 * They are all on the wire path between two clients that must stay bit-identical. The codec is
 * the only place a command changes representation, and a mistranslated variant does not throw:
 * both clients keep simulating, one of them applies a card play nobody made, and the divergence
 * surfaces much later as a state-hash mismatch that arbitration then has to attribute to
 * somebody. The deck field matters for the same reason `judgeRunner`'s does — an unrestricted
 * draw pool on one side is an immediate desync.
 */
import { describe, it, expect } from 'vitest';
import { NetInputSource, type CmdSink } from '../src/game/net/NetInputSource';
import { PlayerCommands } from '../src/net/proto/game';
import type { FrameCmds, ServerMsg } from '../src/net/proto/transport';
import type { PlayerCommand } from '@nw/engine/types';

class CaptureSink implements CmdSink {
  sent: Uint8Array[] = [];
  submitCmd(commands: Uint8Array): void { this.sent.push(commands); }
  /** Decode the last submitted payload back into proto commands. */
  lastDecoded(): ReturnType<typeof PlayerCommands.decode>['commands'] {
    return PlayerCommands.decode(this.sent[this.sent.length - 1]!).commands;
  }
}

function matchStart(over: Record<string, unknown> = {}): ServerMsg {
  return {
    matchStart: {
      roomId: 'room-1', mode: 0, seed: 1, startFrame: 0, localSide: 0,
      opponentName: '', opponentPublicId: '', opponentTitle: '', opponentAvatarId: '',
      opponentSkins: [], topDeck: [], bottomDeck: [], ...over,
    },
  } as ServerMsg;
}

function connResync(over: Record<string, unknown> = {}): ServerMsg {
  return {
    connResync: {
      roomId: 'room-1', mode: 0, seed: 1, startFrame: 0, localSide: 0,
      opponentName: '', opponentPublicId: '', opponentTitle: '', opponentAvatarId: '',
      opponentSkins: [], topDeck: [], bottomDeck: [], log: [], curFrame: 0, ...over,
    },
  } as ServerMsg;
}

/** A frame carrying raw proto command objects for one side. */
function frame(f: number, side: number, cmds: unknown[]): FrameCmds {
  return {
    frame: f,
    cmds: [{ side, commands: PlayerCommands.encode({ commands: cmds as never }).finish() }],
  } as FrameCmds;
}

// ── Outbound: PlayerCommand → proto ─────────────────────────────────────────────────────────

describe('submit encodes each command variant', () => {
  it('encodes upgrade_base, refresh_hand and play_card into their own proto fields', () => {
    const sink = new CaptureSink();
    const src = new NetInputSource(sink);

    src.submit({ type: 'upgrade_base', owner: 0, tick: 5 } as PlayerCommand);
    expect(sink.lastDecoded()[0]!.upgradeBase).toBeDefined();
    expect(sink.lastDecoded()[0]!.playCard).toBeUndefined();

    src.submit({ type: 'refresh_hand', owner: 0, tick: 6 } as PlayerCommand);
    expect(sink.lastDecoded()[0]!.refreshHand).toBeDefined();
    expect(sink.lastDecoded()[0]!.upgradeBase).toBeUndefined();

    src.submit({ type: 'play_card', owner: 0, tick: 7, handIndex: 2, col: 4, row: 9 } as PlayerCommand);
    expect(sink.lastDecoded()[0]!.playCard).toMatchObject({ handIndex: 2, col: 4, row: 9 });
  });

  it('encodes a play_card with no col/row as 0/0 rather than dropping the fields', () => {
    // Spell cards carry no target cell. The proto fields are non-optional scalars, so an
    // undefined here serialises as garbage/absent and the receiving engine would read a
    // different target than the sender intended.
    const sink = new CaptureSink();
    new NetInputSource(sink).submit({ type: 'play_card', owner: 0, tick: 1, handIndex: 0 } as PlayerCommand);
    expect(sink.lastDecoded()[0]!.playCard).toMatchObject({ handIndex: 0, col: 0, row: 0 });
  });
});

// ── Inbound: proto → PlayerCommand ──────────────────────────────────────────────────────────

describe('frame decode', () => {
  function decodeOne(protoCmd: unknown): PlayerCommand {
    const src = new NetInputSource(new CaptureSink(), { bufferFrames: 0 });
    src.handleServerMsg(matchStart());
    src.handleServerMsg({ frameBatch: { toFrame: 10, frames: [frame(3, 1, [protoCmd])] } } as ServerMsg);
    const cmds = src.take(3);
    expect(cmds).toHaveLength(1);
    return cmds![0]!;
  }

  it('decodes upgrade_base and refresh_hand to their own engine types', () => {
    expect(decodeOne({ upgradeBase: {} })).toEqual({ type: 'upgrade_base', owner: 1, tick: 3 });
    expect(decodeOne({ refreshHand: {} })).toEqual({ type: 'refresh_hand', owner: 1, tick: 3 });
  });

  it('decodes play_card with the frame as the tick and the SideCmd side as the owner', () => {
    // owner/tick come from the envelope, not from the payload: the server is the only authority
    // on who played and when, which is what stops a client from claiming another side's move.
    expect(decodeOne({ playCard: { handIndex: 1, col: 7, row: 2 } })).toEqual({
      type: 'play_card', owner: 1, tick: 3, handIndex: 1, col: 7, row: 2,
    });
  });

  it('decodes a command with no recognised variant as a harmless play_card at 0/0/0', () => {
    // A newer peer's command variant this build cannot see. The `?? 0` tail keeps it from
    // decoding as undefined/NaN and either throwing inside the engine or desyncing the two
    // sides differently — both clients on this build read the same benign fallback.
    expect(decodeOne({})).toEqual({
      type: 'play_card', owner: 1, tick: 3, handIndex: 0, col: 0, row: 0,
    });
  });

  it('keeps the server-given order across sides within one frame', () => {
    const src = new NetInputSource(new CaptureSink(), { bufferFrames: 0 });
    src.handleServerMsg(matchStart());
    const both = {
      frame: 4,
      cmds: [
        { side: 0, commands: PlayerCommands.encode({ commands: [{ upgradeBase: {} }] as never }).finish() },
        { side: 1, commands: PlayerCommands.encode({ commands: [{ refreshHand: {} }] as never }).finish() },
      ],
    } as FrameCmds;
    src.handleServerMsg({ frameBatch: { toFrame: 10, frames: [both] } } as ServerMsg);
    expect(src.take(4)!.map((c) => [c.type, c.owner])).toEqual([
      ['upgrade_base', 0],
      ['refresh_hand', 1],
    ]);
  });

  it('does not record a frame whose decoded command list is empty', () => {
    // Empty frames are implicit; storing them would make `cmdsByFrame` grow with the match for
    // no benefit, and the map is what a reconnect re-merges into.
    const src = new NetInputSource(new CaptureSink(), { bufferFrames: 0 });
    src.handleServerMsg(matchStart());
    src.handleServerMsg({
      frameBatch: { toFrame: 10, frames: [{ frame: 2, cmds: [] } as FrameCmds] },
    } as ServerMsg);
    expect(src.take(2)).toEqual([]);
  });
});

// ── The deck field on both match-rebuild messages ───────────────────────────────────────────

describe('deck restriction on match_start and conn_resync', () => {
  function infoFor(msg: ServerMsg): ReturnType<NetInputSource['matchStartInfo']> {
    const src = new NetInputSource(new CaptureSink());
    src.handleServerMsg(msg);
    return src.matchStartInfo;
  }

  it('is undefined when neither side sent a deck (non-ranked / pre-P3 match)', () => {
    expect(infoFor(matchStart())?.decks).toBeUndefined();
    expect(infoFor(connResync())?.decks).toBeUndefined();
  });

  it('is present when either side sent one, on both messages', () => {
    // The `||` between the two sides, both arms: a one-sided list still has to reach the engine,
    // or that side draws from the full pool and the two clients desync on the first refill.
    const top = { topDeck: ['infantry_1'], bottomDeck: [] };
    const bottom = { topDeck: [], bottomDeck: ['archer_1'] };
    expect(infoFor(matchStart(top))?.decks).toEqual({ top: ['infantry_1'], bottom: [] });
    expect(infoFor(matchStart(bottom))?.decks).toEqual({ top: [], bottom: ['archer_1'] });
    expect(infoFor(connResync(top))?.decks).toEqual({ top: ['infantry_1'], bottom: [] });
    expect(infoFor(connResync(bottom))?.decks).toEqual({ top: [], bottom: ['archer_1'] });
  });

  it('fires onMatchStart from conn_resync only when no match_start was seen (cold resume)', () => {
    const seen: unknown[] = [];
    const src = new NetInputSource(new CaptureSink(), { onMatchStart: (i) => seen.push(i) });
    src.handleServerMsg(connResync({ curFrame: 30, topDeck: ['infantry_1'] }));
    expect(seen).toHaveLength(1);
    expect(src.matchStartInfo?.decks).toEqual({ top: ['infantry_1'], bottom: [] });

    // A warm reconnect (match_start already handled) must not rebuild the engine a second time.
    const warm = new NetInputSource(new CaptureSink(), { onMatchStart: (i) => seen.push(i) });
    warm.handleServerMsg(matchStart());
    const after = seen.length;
    warm.handleServerMsg(connResync({ curFrame: 30 }));
    expect(seen.length).toBe(after);
  });
});
