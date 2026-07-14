// Headless simulation test (no network): two BattleEngine instances play the same match against
// each other, connected only by an in-memory relay that mimics gameserver's Room.ts batching
// (assign submitted commands to a frame, broadcast an identical FrameBatch to both sides). This
// exercises the exact netplay contract botsvc depends on: AISystem.decideTick driving one side each,
// lockstep (no local prediction), and both ends landing on the same matchStateHash.
import { describe, it, expect } from 'vitest';
import { BattleEngine } from '../src/engineDriver';
import type { FrameBatch, MatchStart } from '../src/generated/transport';

// Deliberately DIFFERENT top/bottom decks — a same-deck test would pass even with the
// engine-owner/wire-side stats mismatch bug caught 2026-07-14 (both sides play out identically,
// so the mis-indexed stats happen to be symmetric and the hash "matches" by coincidence). Asymmetric
// decks make the two real accounts' stats genuinely different, which is what actually exposes it.
const TOP_DECK = ['infantry_1', 'shieldbearer_1', 'archer_1', 'max_1', 'lena_1', 'mara_1'];
const BOTTOM_DECK = ['runner', 'ironclad', 'berserker', 'infantry_2', 'archer_2', 'shieldbearer_2'];

function matchStart(seed: number, localSide: 0 | 1): MatchStart {
  return {
    roomId: 'test-room',
    mode: 1,
    seed,
    startFrame: 0,
    localSide,
    opponentName: 'opponent',
    opponentPublicId: '000000001',
    opponentTitle: '',
    topDeck: TOP_DECK,
    bottomDeck: BOTTOM_DECK,
  };
}

/** Bounded relay loop: batches each round's submissions onto one frame, advances the watermark by
 * BATCH_FRAMES regardless (mirrors gameserver dispatching a batch every 100ms even when empty), and
 * feeds the identical FrameBatch to both engines until both report game over or the round cap trips. */
function runMatch(seed: number, maxRounds = 20_000): { a: BattleEngine; b: BattleEngine } {
  const a = new BattleEngine(matchStart(seed, 1), 10); // wire side 1 = "A"
  const b = new BattleEngine(matchStart(seed, 0), 10); // wire side 0 = "B"
  const BATCH_FRAMES = 3;

  let confirmedTo = -1;
  let pendingA: Uint8Array[] = [];
  let pendingB: Uint8Array[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const assignFrame = confirmedTo + 1;
    confirmedTo = assignFrame + (BATCH_FRAMES - 1);
    const cmds = [
      ...pendingA.map((commands) => ({ side: 1, commands })),
      ...pendingB.map((commands) => ({ side: 0, commands })),
    ];
    pendingA = [];
    pendingB = [];
    const fb: FrameBatch = { toFrame: confirmedTo, frames: cmds.length > 0 ? [{ frame: assignFrame, cmds }] : [] };

    a.ingestFrameBatch(fb);
    b.ingestFrameBatch(fb);
    const subA = a.advance();
    const subB = b.advance();
    pendingA = subA.toSubmit;
    pendingB = subB.toSubmit;

    if (a.isGameOver() && b.isGameOver()) break;
  }
  return { a, b };
}

describe('BattleEngine netplay contract', () => {
  it('reaches game over with a deterministic, agreeing matchStateHash on both sides', () => {
    const { a, b } = runMatch(1234);
    expect(a.isGameOver()).toBe(true);
    expect(b.isGameOver()).toBe(true);

    const resultA = a.getResult();
    const resultB = b.getResult();
    // Both sides hash the same absolute-owner-indexed {winner, stats} — must match byte-for-byte.
    expect(resultA.stateHash).toBe(resultB.stateHash);

    // Wire-side winner must be consistent from both perspectives (or both agree on a draw).
    expect(resultA.winnerSide).toBe(resultB.winnerSide);

    // Exactly one side can have won (or neither, on a draw) — catches the 2026-07-14 bug where both
    // bots independently concluded "I won" because winnerSide was reported in engine-owner order
    // instead of wire-side order.
    const aWon = a.didIWin();
    const bWon = b.didIWin();
    if (aWon === null) {
      expect(bWon).toBeNull();
    } else {
      expect(aWon).toBe(!bWon);
    }
  });

  it('is deterministic given a fixed seed (same seed -> same hash across runs)', () => {
    const run1 = runMatch(4242);
    const run2 = runMatch(4242);
    expect(run1.a.getResult().stateHash).toBe(run2.a.getResult().stateHash);
  });

  it('produces a different hash for a different seed (sanity: not a constant)', () => {
    const run1 = runMatch(1);
    const run2 = runMatch(2);
    expect(run1.a.getResult().stateHash).not.toBe(run2.a.getResult().stateHash);
  });
});
