// A bot's PvE run (BOTSVC_DESIGN §3.5): play one campaign level on this box, the way a player's own
// device does, and hand back what the client would report — stars for /pve/clear and the command
// frames for /pve/verify.
//
// Campaign is single-player: the enemy is the level's WaveDirector script, nothing is relayed, and
// the result is whatever this simulation says. The server never re-runs it itself; on a spot check
// it sends the frames to a peer judge, which rebuilds the engine from the level's seed and the
// server's own copy of the bot's cards (client/src/net/judgeRunner.ts runPveJudge). So the only
// requirement for an honest bot is the same as for an honest player: step the engine exactly the
// way the judge will replay it — commands applied at the frame they are recorded under, the same
// level JSON, the same card snapshot.
//
// The player is Bottom (owner 0). AISystem only ever decides for Top, so the bot plays through the
// same mirrored view it uses as Bottom in ranked (engineDriver.ts).
import {
  AISystem,
  CAMPAIGN_LEVEL_ORDER,
  Side,
  GamePhase,
  Prng,
  achievementStatDelta,
  buildStarContext,
  computeStars,
  createGameEngine,
  type AIDifficulty,
  type EngineCardInstance,
  type EngineEquipInv,
  type LevelDefinition,
  type PlayerCommand,
  type UnitType,
} from '@nw/engine';
import { CARD_DEFS, PVE_LEVELS, type CardInstance } from '@nw/shared';
import { buildMirroredView, remapMirroredCommand } from './engineDriver';
import { toProtoCommand } from './protoCodec';
import { PlayerCommands } from './generated/game';

/** One recorded frame in /pve/verify's wire shape (client/src/net/replayUpload.ts replayToUploadFrames). */
export interface UploadFrame {
  frame: number;
  cmds: { side: number; commands: string }[];
}

export interface PveRunResult {
  levelId: string;
  won: boolean;
  /** 0 on a loss; 1..3 on a win (a win is always at least 1, STAR_SCORING.md). */
  stars: number;
  /** Frames stepped (last executed tick + 1): the judge's replay bound. */
  endFrame: number;
  frames: UploadFrame[];
  /** Achievement stat delta for owner 0, what the client sends as /pve/clear `stats`. */
  stats: Record<string, number>;
}

export interface PveRunOptions {
  difficulty?: AIDifficulty;
  /** Seeds the bot's own decision PRNG (not the level's): different bots, different plays. */
  aiSeed: number;
  /** Stop and count as a loss past this many frames (a stalemate guard; real levels end far earlier). */
  maxFrames?: number;
  /** Frames stepped per macrotask, so a level never blocks the event loop other bots' matches share. */
  chunkFrames?: number;
}

/** 20 minutes at 30 Hz. The longest campaign level runs a few minutes. */
export const PVE_MAX_FRAMES = 20 * 60 * 30;
const DEFAULT_CHUNK_FRAMES = 300;

/** SaveData.cardInv → engine card instances (client/src/game/meta/cardDefs.ts toEngineCardInstances). */
export function toEngineCards(cardInv: Record<string, CardInstance> | null | undefined): EngineCardInstance[] {
  const out: EngineCardInstance[] = [];
  for (const card of Object.values(cardInv ?? {})) {
    const def = CARD_DEFS[card.defId];
    if (!def) continue; // same forward-compat skip as the client and the judge
    out.push({ id: card.id, defId: card.defId, unitType: def.unitType as UnitType, level: card.level, gear: card.gear });
  }
  return out;
}

function encodeFrame(frame: number, cmds: PlayerCommand[]): UploadFrame {
  const bytes = PlayerCommands.encode(PlayerCommands.fromPartial({ commands: cmds.map(toProtoCommand) })).finish();
  return { frame, cmds: [{ side: 0, commands: Buffer.from(bytes).toString('base64') }] };
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Plays `level` to its end. A command decided after frame t is applied at frame t+1 and recorded
 * under t+1 — the judge's ReplayInputSource hands each recorded set to exactly that frame.
 */
export async function playLevel(
  level: LevelDefinition,
  cards: { cardInstances: EngineCardInstance[]; equipmentInv: EngineEquipInv },
  opts: PveRunOptions,
): Promise<PveRunResult> {
  const engine = createGameEngine({
    seed: level.seed,
    players: [{ id: 0 }, { id: 1 }],
    mode: 'campaign',
    level,
    cardInstances: cards.cardInstances,
    equipmentInv: cards.equipmentInv,
  });
  const ai = new AISystem(new Prng(opts.aiSeed), opts.difficulty ?? 5);
  const maxFrames = opts.maxFrames ?? PVE_MAX_FRAMES;
  const chunk = opts.chunkFrames ?? DEFAULT_CHUNK_FRAMES;
  const frames: UploadFrame[] = [];
  let pending: PlayerCommand[] = [];
  // A function, not an inline compare: TS would narrow `phase` across engine.step() otherwise.
  const over = (): boolean => engine.state.phase === GamePhase.GameOver;
  let frame = 0;
  while (!over() && frame < maxFrames) {
    const cmds = pending.map((c) => ({ ...c, tick: frame }));
    if (cmds.length > 0) frames.push(encodeFrame(frame, cmds));
    engine.step(frame, cmds);
    pending =
      over()
        ? []
        : ai.decideTick(frame, buildMirroredView(engine.state)).map((c) => remapMirroredCommand(c, 0));
    frame++;
    if (frame % chunk === 0) await yieldToLoop();
  }
  const won = over() && engine.state.winner === Side.Bottom;
  const stats = engine.state.snapshotStats();
  let stars = 0;
  if (won) {
    const summary = engine.state.snapshotSummary();
    stars = computeStars(
      level.rewards?.starThresholds,
      buildStarContext(level, {
        damageTakenByBase: stats[0].damageTakenByBase,
        elapsedTicks: summary.elapsedTicks,
        enemyLeaks: summary.enemyLeaks,
        escortMinHpPct: summary.escortMinHpPct,
        unitsKilled: stats[0].unitsKilled,
      }),
    );
  }
  return {
    levelId: level.id,
    won,
    stars,
    endFrame: frame,
    frames,
    stats: won ? (achievementStatDelta(stats[0]) as Record<string, number>) : {},
  };
}

/** Only the levels metaserver will settle: registered in the engine AND in the server's reward/unlock table. */
const PLAYABLE = CAMPAIGN_LEVEL_ORDER.filter((id) => PVE_LEVELS.some((l) => l.id === id));

/** Chance a bot with cleared levels replays one of them for stars instead of pushing the frontier. */
export const PVE_REPLAY_CHANCE = 0.3;

/**
 * Which level a bot enters: usually the frontier (the first level it has not cleared whose
 * prerequisite it has), sometimes a cleared one it has not 3-starred yet — the two things a player
 * on the campaign map actually does. Null when there is nothing it may enter.
 *
 * "First uncleared" is also the first unlocked one: every level's `requires` is the level before it
 * in CAMPAIGN_LEVEL_ORDER (pve.test.ts pins that), so the level after a cleared run is always open.
 */
export function pickLevel(
  progress: { cleared: string[]; stars: Record<string, number> },
  random: () => number,
): string | null {
  const cleared = new Set(progress.cleared);
  const frontier = PLAYABLE.find((id) => !cleared.has(id));
  const improvable = PLAYABLE.filter((id) => cleared.has(id) && (progress.stars[id] ?? 0) < 3);
  if (improvable.length > 0 && (frontier === undefined || random() < PVE_REPLAY_CHANCE)) {
    return improvable[Math.floor(random() * improvable.length)]!;
  }
  return frontier ?? null;
}
