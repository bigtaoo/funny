// Headless battle engine (BOTSVC_DESIGN §1 B3 / §8): embeds @nw/engine's full simulation in
// 'netplay' mode (gameserver never runs simulation server-side, see server/gameserver/src/Room.ts —
// it only relays opaque command bytes) and drives it with AISystem.decideTick, exactly as a lockstep
// client would. No client-side prediction: a decided command is only applied once it round-trips
// back through a confirmed frame_batch (mirrors client/src/game/net/NetInputSource.ts), so two real
// clients (or a bot and a real client) on the same seed + confirmed stream stay byte-identical.
//
// The engine itself is constructed WIRE-CONSISTENT — `decks`/`players` use MatchStart's topDeck/
// bottomDeck exactly as given, never relabeled — because that's what a real opponent's own client
// computes too (it has no concept of "always be Top"), and PlayerStats/matchStateHash are a
// wire-side-indexed contract (stats[0] = wire side 0's real actions). An earlier version of this
// file relabeled the WHOLE engine (decks + owner numbering) so the bot could always present itself
// to AISystem as owner 1 (Top); a live two-bot ranked match on 2026-07-14 caught two bugs from that:
// (a) each bot's own winnerSide/stats came out mirrored instead of wire-indexed (both bots concluded
// "I won"), and (b) swapping which deck feeds the engine's fixed top-stream/bottom-stream PRNGs
// (config.seed vs config.seed^0xdeadbeef, see engine/base.ts) meant the two bots literally simulated
// different hands whenever the two decks differed in content — undetectable with same-content test
// decks, but a real divergence. Both are structural consequences of relabeling the engine itself, not
// fixable by patching the output.
//
// AISystem.decideTick is hardcoded to always decide for the engine's Top side (owner 1,
// state.topPlayer — see server/engine/src/systems/AISystem.ts's fair-play invariant: it only reads
// state.topPlayer + public board state, using absolute Side.Top/Bottom tags and row numbers relative
// to the Top base at row 17). When the bot's real wire side is Bottom (myOwner === 0), it cannot call
// AISystem against the real state directly — AISystem would read the OPPONENT's hand and reason about
// the wrong home row entirely. Instead `decideMirrored()` builds a lightweight, read-only mirrored
// VIEW of the real state (topPlayer <-> bottomPlayer, unit/building side flipped, row flipped via
// BOARD_ROWS-1-row — the board is vertically symmetric, columns/lanes are shared and never flip) and
// feeds that to AISystem, then `remapMirroredCommand` flips the decided command's `row` back and
// overwrites `owner` to the bot's real owner before it's ever applied or submitted. The real engine
// state is never touched by the mirroring — only a transient view constructed per decision.
import {
  AISystem,
  BOARD_ROWS,
  DIFFICULTY,
  Prng,
  Side,
  createGameEngine,
  GamePhase,
  type AIDifficulty,
  type GameEvent,
  type GameState,
  type IGameEngine,
  type PlayerCommand,
  type PlayerStats,
} from '@nw/engine';
import { decodeSideCommands, encodeOutboundCommand, matchStateHash } from './protoCodec';
import type { FrameBatch, MatchStart } from './generated/transport';

export interface BattleResult {
  stateHash: string;
  /** Wire-side numbering (matches MatchStart.localSide / SideCmd.side) — same as engine OwnerId. */
  winnerSide: number | null;
}

/** How far behind the newest confirmed watermark to hold playback (jitter cushion), mirrors NetInputSource's default. */
const BUFFER_FRAMES = 3;

function flipSide(side: Side): Side {
  return side === Side.Top ? Side.Bottom : Side.Top;
}

function flipRow(row: number): number {
  return BOARD_ROWS - 1 - row;
}

/**
 * Builds a read-only view of `state` with Top/Bottom swapped (player, unit/building side, row) so
 * AISystem — which only ever decides "for Top" — reasons about the REAL Bottom player's own hand and
 * home row instead of the opponent's. Only the handful of fields AISystem actually reads (see the
 * file-header note) are covered; this is not a general GameState mirror.
 */
function buildMirroredView(state: GameState): GameState {
  const units = new Map<number, unknown>();
  for (const [id, u] of state.board.units) {
    units.set(id, { side: flipSide(u.side), isDead: u.isDead, col: u.col, row: flipRow(u.row), unitType: u.unitType });
  }
  const buildings = new Map<number, unknown>();
  for (const [id, b] of state.board.buildings) {
    buildings.set(id, { side: flipSide(b.side), isDead: b.isDead, buildingType: b.buildingType });
  }
  const board = {
    units,
    buildings,
    hasBuildingAt: (col: number, row: number) => state.board.hasBuildingAt(col, flipRow(row)),
  };
  return { topPlayer: state.bottomPlayer, board, unitBlueprints: state.unitBlueprints } as unknown as GameState;
}

/** Undoes `buildMirroredView`'s row flip on a decided command and stamps the bot's real owner. */
function remapMirroredCommand(cmd: PlayerCommand, realOwner: 0 | 1): PlayerCommand {
  if (cmd.type === 'play_card' && cmd.row !== undefined) {
    return { ...cmd, owner: realOwner, row: flipRow(cmd.row) };
  }
  return { ...cmd, owner: realOwner };
}

export class BattleEngine {
  private readonly engine: IGameEngine;
  private readonly ai: AISystem;
  /** This bot's real owner/wire side (0 = Bottom, 1 = Top) — MatchStart.localSide, unmodified. */
  private readonly myOwner: 0 | 1;
  private readonly cmdsByFrame = new Map<number, PlayerCommand[]>();
  private readonly startFrame: number;
  private confirmedTo: number;
  private nextTickToStep: number;
  private gameOver = false;
  private result: BattleResult | null = null;

  constructor(matchStart: MatchStart, difficulty: AIDifficulty = 5) {
    this.myOwner = matchStart.localSide as 0 | 1;
    this.engine = createGameEngine({
      seed: matchStart.seed,
      players: [{ id: 0 }, { id: 1 }],
      mode: 'netplay',
      decks: { top: matchStart.topDeck, bottom: matchStart.bottomDeck },
    });
    this.ai = new AISystem(new Prng(matchStart.seed ^ 0xb0b5), difficulty);
    this.startFrame = matchStart.startFrame;
    this.confirmedTo = matchStart.startFrame;
    this.nextTickToStep = matchStart.startFrame;
  }

  ingestFrameBatch(fb: FrameBatch): void {
    for (const fc of fb.frames) {
      const cmds: PlayerCommand[] = [];
      for (const sc of fc.cmds) {
        cmds.push(...decodeSideCommands(sc.commands, sc.side as 0 | 1, fc.frame));
      }
      if (cmds.length > 0) this.cmdsByFrame.set(fc.frame, cmds);
    }
    if (fb.toFrame > this.confirmedTo) this.confirmedTo = fb.toFrame;
  }

  /**
   * Steps the engine through every newly-confirmed frame, deciding (and returning, for the caller to
   * submit) a new bot command whenever AISystem.decideTick fires. Call after every ingestFrameBatch.
   */
  advance(): { toSubmit: Uint8Array[]; events: GameEvent[] } {
    const toSubmit: Uint8Array[] = [];
    const events: GameEvent[] = [];
    // Hold playback one batch behind the watermark (absorbs sub-batch jitter, same as NetInputSource).
    const playTo = Math.max(this.startFrame, this.confirmedTo - BUFFER_FRAMES);
    while (!this.gameOver && this.nextTickToStep <= playTo) {
      const tick = this.nextTickToStep;
      const cmds = this.cmdsByFrame.get(tick) ?? [];
      const tickEvents = this.engine.step(tick, cmds);
      events.push(...tickEvents);
      for (const ev of tickEvents) {
        if (ev.type === 'game_over') this.captureResult(ev.winner);
      }
      if (this.engine.state.phase === GamePhase.GameOver && !this.result) {
        // game_draw or any other terminal path without a game_over event: still finalize with no winner.
        this.captureResult(null);
      }
      if (!this.gameOver) {
        const decided =
          this.myOwner === 1
            ? this.ai.decideTick(tick, this.engine.state)
            : this.ai.decideTick(tick, buildMirroredView(this.engine.state));
        for (const cmd of decided) {
          const realCmd = this.myOwner === 1 ? cmd : remapMirroredCommand(cmd, 0);
          toSubmit.push(encodeOutboundCommand(realCmd));
        }
      }
      this.nextTickToStep++;
    }
    return { toSubmit, events };
  }

  private captureResult(winnerOwner: 0 | 1 | null): void {
    if (this.gameOver) return;
    this.gameOver = true;
    // Wire-consistent by construction (owner === wire side throughout) — no re-indexing needed.
    const stats = this.engine.state.snapshotStats() as [PlayerStats, PlayerStats];
    const stateHash = matchStateHash(winnerOwner, stats);
    this.result = { stateHash, winnerSide: winnerOwner };
  }

  isGameOver(): boolean {
    return this.gameOver;
  }

  getResult(): BattleResult {
    if (!this.result) throw new Error('getResult() called before game over');
    return this.result;
  }

  /** True/false once decided, null on a draw. */
  didIWin(): boolean | null {
    const r = this.getResult();
    return r.winnerSide === null ? null : r.winnerSide === this.myOwner;
  }
}

export { DIFFICULTY };
