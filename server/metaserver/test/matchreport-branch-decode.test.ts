// Branch-coverage backfill for src/internal/replayDecode.ts (2026-09-03).
// test/pvp-replay-decode.test.ts covers exactly one shape: a restricted-deck-pool replay that runs to
// the forced-draw timeout. That leaves the decoder's whole winner mapping (only `null` → -1 was ever
// taken), the deck-less replay (the common case — only loadout-gated matches carry decks), and two of
// the three proto command kinds unexercised. Everything the balance pipeline (BALANCE.md §11.2) reads
// off a real archived match therefore went through untested code.
import { describe, expect, it } from 'vitest';
import { decodeReplay } from '../src/internal/replayDecode.js';
import { PlayerCommands, type PlayerCommand } from '../src/generated/game.js';

const SEED = '777';
// Engine's forced-draw timeout (server/engine/src/config.ts FORCE_DRAW_THRESHOLD_TICKS; not re-exported
// from @nw/engine's public surface, so mirrored as a literal — same as pvp-replay-decode.test.ts).
const FORCE_DRAW_THRESHOLD_TICKS = 30600;
const DECKS = {
  top: ['infantry_1', 'infantry_2', 'archer_1', 'archer_2', 'max_1', 'max_2', 'barracks_1', 'barracks_2', 'haste_1', 'meteor_1'],
  bottom: ['infantry_1', 'infantry_2', 'archer_1', 'archer_2', 'max_1', 'max_2', 'barracks_1', 'barracks_2', 'haste_1', 'meteor_1'],
};

function frame(frame: number, side: number, commands: PlayerCommand[]) {
  const bytes = PlayerCommands.encode({ commands }).finish();
  return { frame, cmds: [{ side, commands: Buffer.from(bytes).toString('base64') }] };
}

/**
 * One side deploys from its own half every 3s while the other never acts — the unanswered push
 * destroys the idle base, which is the only way to reach a *decisive* GameOver deterministically
 * (no surrender command exists in the engine's PlayerCommand set).
 */
function oneSidedPush(side: number, row: number) {
  const frames = [];
  for (let i = 0; i < 300; i++) {
    frames.push(frame(120 + i * 90, side, [{ playCard: { handIndex: i % 4, col: 3 + (i % 6), row } }]));
  }
  return frames;
}

describe('replayDecode branch backfill', () => {
  // Side → OwnerId mapping, Bottom half: engine winner Side.Bottom must decode to side 0, which is what
  // the balance pipeline joins against matches.winner / players[].side. A wrong mapping here would
  // silently invert every deck win-rate in the P1/P2 datasets.
  it('maps a decisive Bottom win to side 0', () => {
    const result = decodeReplay({
      engineVersion: 0, mode: 'netplay', seed: SEED,
      endFrame: FORCE_DRAW_THRESHOLD_TICKS, frames: oneSidedPush(0, 10), decks: DECKS,
    });
    expect(result).not.toBeNull();
    expect(result!.winnerSide).toBe(0);
    expect(result!.plays.length).toBeGreaterThan(0);
    expect(result!.plays.every((p) => p.side === 0)).toBe(true);
  });

  // The mirrored case (Side.Top → 1). Asserted separately because the two arms are a nested ternary:
  // covering only one of them still leaves the inversion bug above possible.
  it('maps a decisive Top win to side 1', () => {
    const result = decodeReplay({
      engineVersion: 0, mode: 'netplay', seed: SEED,
      endFrame: FORCE_DRAW_THRESHOLD_TICKS, frames: oneSidedPush(1, 7), decks: DECKS,
    });
    expect(result).not.toBeNull();
    expect(result!.winnerSide).toBe(1);
    expect(result!.plays.every((p) => p.side === 1)).toBe(true);
  });

  // Deck-less replay: only restricted-loadout matches archive `decks`, so *most* real archived matches
  // hit this path — the engine falls back to its default card pool and the decode must still recover a
  // play sequence rather than mis-seeding the simulation (which would desync and yield 0 plays).
  it('decodes a replay with no archived decks (default card pool)', () => {
    const result = decodeReplay({
      engineVersion: 0, mode: 'netplay', seed: SEED,
      endFrame: FORCE_DRAW_THRESHOLD_TICKS, frames: oneSidedPush(0, 10),
    });
    expect(result).not.toBeNull();
    expect(result!.winnerSide).toBe(0);
    expect(result!.plays.length).toBeGreaterThan(0);
    for (const p of result!.plays) {
      expect(p.cardType.length).toBeGreaterThan(0);
      expect(p.frame).toBeGreaterThan(0);
    }
  });

  // The other two proto command kinds plus a field-less PlayerCommand (a command from a newer/older
  // client, or a partially-written record). fromProto must map each without throwing, and neither
  // upgrade_base nor refresh_hand may be counted as a card play — they carry no cardType, so leaking
  // them into `plays` would pollute the per-card balance counters with phantom entries.
  it('handles upgrade_base, refresh_hand and field-less commands without counting them as plays', () => {
    const frames = [
      frame(60, 0, [{ upgradeBase: {} }]),
      frame(90, 0, [{ refreshHand: {} }]),
      // No oneof branch set at all → decoded as play_card with handIndex/col/row defaulted to 0.
      frame(105, 0, [{}]),
      ...oneSidedPush(0, 10),
    ].sort((a, b) => a.frame - b.frame);
    const result = decodeReplay({
      engineVersion: 0, mode: 'netplay', seed: SEED,
      endFrame: FORCE_DRAW_THRESHOLD_TICKS, frames, decks: DECKS,
    });
    expect(result).not.toBeNull();
    expect(result!.winnerSide).toBe(0);
    // Every recorded entry still carries a real engine card type — no phantom/empty-type rows.
    expect(result!.plays.every((p) => typeof p.cardType === 'string' && p.cardType.length > 0)).toBe(true);
  });
});
