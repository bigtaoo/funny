// BALANCE data pipeline (P2): decode a stored replay into a per-side play sequence (card type + frame + position).
// Mirrors client/src/net/judgeRunner.ts's proto→Replay conversion, but drives its own tick loop (rather than
// runHeadless) so it can capture GameEvent history — GameState.clearEvents() runs at the top of every tick, so a
// plain run-to-completion loop (as runHeadless does) would only ever see the last tick's events.
//
// Card *type* (not card id, and not board position) is the finest granularity available without touching engine
// internals: card_played only carries {owner, handIndex}, so we track each side's handIndex → cardType via the
// card_drawn events that necessarily precede it (see engine/src/types.ts GameEvent 'card_drawn' | 'card_played').
// This can't distinguish infantry_1 from infantry_2 (two copies of the same card, no balance signal either way),
// and deliberately doesn't try to recover col/row — cross-referencing card_played back to the originating PlayCard
// command by position-in-stream breaks silently whenever an earlier command was rejected by validation (occupied
// cell, insufficient ink, etc.) and produced no event, since that shifts the alignment for everything after it.
// Frame number is captured directly from the tick loop below, which is exact.
import {
  createGameEngine,
  ReplayInputSource,
  ENGINE_VERSION,
  GamePhase,
  Side,
  type GameConfig,
  type GameEvent,
  type OwnerId,
  type PlayerCommand,
  type Replay,
  type ReplayFrame,
} from '@nw/engine';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from '../generated/game.js';

export interface PlaySeqEntry {
  side: number;
  frame: number;
  cardType: string;
}

export interface DecodedMatch {
  winnerSide: number;
  plays: PlaySeqEntry[];
}

/** Step limit past the archived endFrame — matches judgeRunner's `req.endFrame + 600` slack against corrupt replays. */
const END_FRAME_SLACK = 600;

/**
 * Re-simulate an archived replay and return its per-side play sequence. Returns null if the match never reaches
 * GameOver within the step budget (corrupt/incomplete frame log) — same fail-soft contract as judgeRunner.runJudge.
 */
export function decodeReplay(
  replay: { engineVersion: number; mode: string; seed: string; endFrame: number; frames: { frame: number; cmds: { side: number; commands: string }[] }[]; decks?: { top: string[]; bottom: string[] } },
): DecodedMatch | null {
  const engineFrames: ReplayFrame[] = replay.frames.map((fc) => {
    const commands: PlayerCommand[] = [];
    for (const sc of fc.cmds) {
      const decoded = PlayerCommands.decode(Buffer.from(sc.commands, 'base64'));
      for (const pc of decoded.commands) commands.push(fromProto(pc, sc.side as OwnerId, fc.frame));
    }
    return { tick: fc.frame, commands };
  });
  const engineReplay: Replay = {
    engineVersion: ENGINE_VERSION,
    mode: 'netplay',
    seed: Number(replay.seed),
    frames: engineFrames,
    endFrame: replay.endFrame,
    ...(replay.decks ? { decks: replay.decks } : {}),
  };
  const config: GameConfig = {
    seed: Number(replay.seed),
    players: [{ id: 0 }, { id: 1 }],
    mode: 'netplay',
    ...(replay.decks ? { decks: replay.decks } : {}),
  };

  const engine = createGameEngine(config, new ReplayInputSource(engineReplay));
  const tickDt = 1 / 30; // TICK_RATE — kept as a literal to avoid importing the whole math/fixed surface for one constant
  const maxTicks = replay.endFrame + END_FRAME_SLACK;
  // handIndex → cardType per side, updated by card_drawn, consumed by card_played (see file header comment).
  const handCardType: Record<number, Map<number, string>> = { 0: new Map(), 1: new Map() };
  const plays: PlaySeqEntry[] = [];
  let ticks = 0;
  while (engine.state.phase !== GamePhase.GameOver && ticks < maxTicks) {
    engine.tick(tickDt);
    ticks++;
    for (const ev of engine.state.events as readonly GameEvent[]) {
      if (ev.type === 'card_drawn') {
        handCardType[ev.owner]!.set(ev.handIndex, ev.cardType);
      } else if (ev.type === 'card_played') {
        const cardType = handCardType[ev.owner]!.get(ev.handIndex);
        if (cardType) plays.push({ side: ev.owner, frame: ticks, cardType });
      }
    }
  }
  if (engine.state.phase !== GamePhase.GameOver) return null;

  // Side (Top/Bottom) → OwnerId (0/1): same mapping as judgeRunner.stateWinner / the game_over event winner.
  const winner = engine.state.winner;
  const winnerSide = winner === null ? -1 : winner === Side.Top ? 1 : 0;
  return { winnerSide, plays };
}

/** game.proto PlayerCommand → engine PlayerCommand (same logic as NetInputSource.fromProto / judgeRunner.fromProto). */
function fromProto(pc: ProtoPlayerCommand, owner: OwnerId, frame: number): PlayerCommand {
  if (pc.upgradeBase) return { type: 'upgrade_base', owner, tick: frame };
  if (pc.refreshHand) return { type: 'refresh_hand', owner, tick: frame };
  const card = pc.playCard;
  return {
    type: 'play_card',
    owner,
    tick: frame,
    handIndex: card?.handIndex ?? 0,
    col: card?.col ?? 0,
    row: card?.row ?? 0,
  };
}
