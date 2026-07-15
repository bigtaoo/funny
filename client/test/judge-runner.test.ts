// Peer judge headless recompute (Phase C). Proof: given a seed + a non-empty
// frame log sorted by the server, the final-state hash produced by a third-party
// runJudge recompute matches — byte-for-byte — the authoritative hash from an
// independent netplay engine running the same command stream. This is the basis
// on which the judge can determine which side is honest. Also tested: incomplete
// frame stream → ok:false (bounded, no crash).
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { GamePhase, Side, type InputSource, type OwnerId, type PlayerCommand } from '../src/game';
import { matchStateHash, runJudge } from '../src/net/judgeRunner';
import { PlayerCommands } from '../src/net/proto/game';
import type { JudgeRequest } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const SEED = 0xbeef;
// No base is destroyed → netplay ends in a forced draw at FORCE_DRAW_THRESHOLD_TICKS (deterministic terminal state).
const END_FRAME = 30700;

/** Input source that feeds a pre-scripted confirmed command stream (simulates per-frame server delivery, never pausing). */
class ScriptedSource implements InputSource {
  constructor(private readonly byFrame: Map<number, PlayerCommand[]>) {}
  submit(): void {
    /* fixed playback */
  }
  take(frame: number): readonly PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }
}

/** Script: each side plays a few cards (owner/frame/handIndex/col). */
const SCRIPT: { frame: number; owner: OwnerId; handIndex: number; col: number }[] = [
  { frame: 30, owner: 0, handIndex: 0, col: 1 },
  { frame: 60, owner: 1, handIndex: 0, col: 8 },
  { frame: 200, owner: 0, handIndex: 1, col: 3 },
  { frame: 260, owner: 1, handIndex: 1, col: 5 },
];

function authoredByFrame(): Map<number, PlayerCommand[]> {
  const m = new Map<number, PlayerCommand[]>();
  for (const s of SCRIPT) {
    const cmd: PlayerCommand = {
      type: 'play_card',
      owner: s.owner,
      tick: s.frame,
      handIndex: s.handIndex,
      col: s.col,
    };
    (m.get(s.frame) ?? m.set(s.frame, []).get(s.frame)!).push(cmd);
  }
  return m;
}

function toProto(cmd: PlayerCommand) {
  if (cmd.type === 'play_card') {
    return { playCard: { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 }, upgradeBase: undefined, refreshHand: undefined };
  }
  if (cmd.type === 'refresh_hand') return { refreshHand: {}, playCard: undefined, upgradeBase: undefined };
  return { upgradeBase: {}, playCard: undefined, refreshHand: undefined };
}

/** Script → JudgeRequest (each frame grouped by owner into SideCmd; commands encoded with game.proto). */
function buildJudgeRequest(
  byFrame: Map<number, PlayerCommand[]>,
  decks?: { top: string[]; bottom: string[] },
): JudgeRequest {
  const frames = [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, cmds]) => {
      const bySide = new Map<number, PlayerCommand[]>();
      for (const c of cmds) (bySide.get(c.owner) ?? bySide.set(c.owner, []).get(c.owner)!).push(c);
      return {
        frame,
        cmds: [...bySide.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([side, list]) => ({
            side,
            commands: PlayerCommands.encode({ commands: list.map(toProto) }).finish(),
          })),
      };
    });
  return {
    requestId: 'r1',
    seed: SEED,
    mode: 1,
    endFrame: END_FRAME,
    frames,
    topDeck: decks?.top ?? [],
    bottomDeck: decks?.bottom ?? [],
  } as JudgeRequest;
}

/** Independent authoritative engine: runs the same command stream to the terminal state and computes the authoritative hash. */
function authoritativeHash(
  byFrame: Map<number, PlayerCommand[]>,
  decks?: { top: string[]; bottom: string[] },
): string {
  const engine = createGameEngine(
    { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'netplay', ...(decks ? { decks } : {}) },
    new ScriptedSource(byFrame),
  );
  let guard = 0;
  while (engine.state.phase !== GamePhase.GameOver && guard < END_FRAME + 100) {
    engine.tick(TICK_DT);
    guard++;
  }
  expect(engine.state.phase).toBe(GamePhase.GameOver);
  const winner: OwnerId | null =
    engine.state.winner === null ? null : engine.state.winner === Side.Top ? 1 : 0;
  return matchStateHash(winner, engine.state.snapshotStats());
}

describe('peer judge runner', () => {
  it('recomputed terminal hash matches the independent authoritative engine byte-for-byte', () => {
    const byFrame = authoredByFrame();
    const expected = authoritativeHash(byFrame);

    const out = runJudge(buildJudgeRequest(byFrame));
    expect(out.ok).toBe(true);
    expect(out.stateHash).toBe(expected);
  }, 30_000);

  it('deterministic: recomputing the same JudgeRequest twice yields identical results', () => {
    const req = buildJudgeRequest(authoredByFrame());
    const a = runJudge(req);
    const b = runJudge(req);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  }, 30_000);

  it('incomplete frame stream (endFrame well before terminal state) → ok:false, no crash', () => {
    const req = buildJudgeRequest(authoredByFrame());
    const out = runJudge({ ...req, endFrame: 50 } as JudgeRequest);
    expect(out.ok).toBe(false);
  });

  // PVP_LOADOUT §6.2: ranked matches restrict each side's draw pool to the match's actual deck
  // (match_start.top_deck/bottom_deck). The judge must rebuild the engine with that same restriction —
  // otherwise it draws from the full pool and recomputes a hash that can never match either honest
  // side's real hash, permanently breaking arbitration (or worse, convicting the honest player).
  describe('deck-restricted ranked matches (PVP_LOADOUT §6.2)', () => {
    // 'runner' is an ELO-locked PvP-unlock unit (PVP_LOADOUT_DESIGN §3) — exactly the kind of card
    // that must never appear in a full-pool recompute of a deck-restricted match.
    const decks = { top: ['runner'], bottom: ['runner'] };

    it('recomputed hash matches the authoritative engine when the judge is given the real match decks', () => {
      const byFrame = authoredByFrame();
      const expected = authoritativeHash(byFrame, decks);

      const out = runJudge(buildJudgeRequest(byFrame, decks));
      expect(out.ok).toBe(true);
      expect(out.stateHash).toBe(expected);
    }, 30_000);

    it('regression guard: recomputing without the match decks (the pre-fix bug) diverges from the real hash', () => {
      const byFrame = authoredByFrame();
      const expectedRestricted = authoritativeHash(byFrame, decks);

      // Simulates the old judgeRunner.ts behaviour: same seed + same frame stream, but the judge
      // rebuilds the engine off the full card pool instead of the match's restricted decks.
      const outFullPool = runJudge(buildJudgeRequest(byFrame));
      expect(outFullPool.ok).toBe(true);
      expect(outFullPool.stateHash).not.toBe(expectedRestricted);
    }, 30_000);
  });
});
