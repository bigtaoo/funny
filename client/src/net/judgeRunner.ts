// Peer-judge headless re-computation (Phase C). When a client selected by the gateway receives a judge_request,
// it uses the seed + non-empty frame replay to run the deterministic engine to end-of-game on the local machine,
// computes a final state hash + winner with the same structure as match_result, and reports back a judge_verdict.
// meta uses this to determine which side is honest and which is cheating when ranked hashes disagree.
//
// Key: the adjudication engine and the match are fully deterministic (fixed-point arithmetic + injected PRNG),
// so the same seed + same confirmed command stream reproduce results tick by tick.
// Therefore a third party feeding back the same frame stream can recompute the single hash both sides should have gotten —
// the cheating side tampers with their local state but cannot alter the server-ordered command stream,
// so the recomputed result will always match the honest side. No rendering, no interaction — pure logic.

import {
  achievementStatDelta,
  getLevel,
  runHeadless,
  ReplayInputSource,
  ENGINE_VERSION,
  Side,
  type GameMode,
  type LevelDefinition,
  type OwnerId,
  type PlayerCommand,
  type PlayerStats,
  type Replay,
  type ReplayFrame,
} from '../game';
import { computeStars, remainingHpPct } from '../game/meta/campaignRewards';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from './proto/game';
import type { JudgeRequest } from './proto/transport';

export interface JudgeOutcome {
  ok: boolean;
  stateHash: string;
  winnerSide: number;
  /** PvE spot-check recomputation (PVE_INTEGRITY §8.6 L1): star count from recomputation (0 = did not clear). Always 0 for PvP. */
  stars: number;
  /**
   * JSON of the recomputed achievement stat delta for this match (`achievementStatDelta`), in two shapes depending on mode:
   * - **PvE feed** (S9-3b, §6.2): single object for the player (owner 0) `{"kill.archer":n,…}` → accumulated after L1 when meta verifies.
   * - **PvP offline spot-check** (S9-7 L2, §4.4): per-side map for both sides `{"0":{…},"1":{…}}` → meta compares with archived reportedStats to detect over-reporting.
   * Always empty string for siege recomputation and for failed clears.
   */
  statsJson: string;
}

const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' };

/**
 * Recompute one match and return the final result. If end-of-game cannot be reached (incomplete frame stream / error) → {ok:false}.
 * Non-empty `level_id` → PvE spot-check recomputation (campaign mode, returns star count); otherwise PvP (returns final state hash + winner).
 * Step limit = endFrame + buffer, to prevent corrupted replays from causing an infinite loop.
 */
export function runJudge(req: JudgeRequest): JudgeOutcome {
  if (req.defenseJson) return runSiegeJudge(req);
  if (req.levelId) return runPveJudge(req);
  try {
    const replay = buildReplay(req, 'netplay', req.seed);
    // endFrame + buffer: leaves slack after end-of-game to prevent corrupted replays from looping; a normal game will GameOver earlier.
    const { ok, engine } = runHeadless(
      { seed: req.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      new ReplayInputSource(replay),
      req.endFrame + 600,
    );
    if (!ok) return FAIL;

    const winner = stateWinner(engine.state.winner);
    const stats = engine.state.snapshotStats();
    // S9-7 L2 offline spot-check: PvP recomputation reports **both sides'** per-side achievement stats (side index → achievementStatDelta for that side);
    // meta compares each side against the archived reportedStats to detect over-reporting. owner↔side are always equal (0=Bottom/1=Top).
    return {
      ok: true,
      stateHash: matchStateHash(winner, stats),
      winnerSide: winner ?? 0,
      stars: 0,
      statsJson: JSON.stringify({
        '0': achievementStatDelta(stats[0]),
        '1': achievementStatDelta(stats[1]),
      }),
    };
  } catch {
    return FAIL;
  }
}

/**
 * PvE spot-check recomputation (PVE_INTEGRITY §8.6 L1): uses seed (derived from the level, authoritative value fetched from the local levels JSON)
 * + server-authoritative pve_upgrades blueprint snapshot + player command frames, runs to end-of-game in campaign mode to compute star count.
 * The recomputed stars are handed to meta for comparison with what the client claimed —
 * a cheater can tamper with local state but cannot change "whether these commands can actually clear the game under this blueprint",
 * so the recomputed result matches an honest clear. Clear = player (owner 0) wins; otherwise → 0 stars.
 */
function runPveJudge(req: JudgeRequest): JudgeOutcome {
  try {
    const level = getLevel(req.levelId);
    if (!level) return FAIL; // judge does not have a local definition for this level → cannot recompute (version mismatch)
    const replay = buildReplay(req, 'campaign', level.seed, req.levelId);
    const { ok, engine } = runHeadless(
      {
        seed: level.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'campaign',
        level,
        // S12: prefer unitLevels (new progression model); fall back to pveUpgrades (old model, backward compatibility) when absent
        ...(Object.keys(req.unitLevels ?? {}).length > 0
          ? { unitLevels: req.unitLevels }
          : { pveUpgrades: req.pveUpgrades }),
      },
      new ReplayInputSource(replay),
      req.endFrame + 600,
    );
    if (!ok) return FAIL;

    const winner = stateWinner(engine.state.winner);
    if (winner !== 0) {
      return { ok: true, stateHash: '', winnerSide: winner ?? 0, stars: 0, statsJson: '' };
    }
    const stats = engine.state.snapshotStats();
    const stars = computeStars(level.rewards?.starThresholds, remainingHpPct(stats[0].damageTakenByBase));
    // PvE feed (S9-3b): cleared (player owner 0 wins) → report the player's achievement stats for this match. Judge is authoritative; meta accumulates after L1 verification.
    const statsJson = JSON.stringify(achievementStatDelta(stats[0]));
    return { ok: true, stateHash: '', winnerSide: 0, stars, statsJson };
  } catch {
    return FAIL;
  }
}

/**
 * SLG siege recomputation (S8-3, SLG_DESIGN §5.3): worldsvc constructs a defense config (JSON of LevelDefinition)
 * for the attacked tile; the judge uses seed + that config + the attacker's server-authoritative progression snapshot (pve_upgrades)
 * + attacker command frames to run to end-of-game in siege mode.
 * The siege engine mechanics are the same as campaign (defender = WaveDirector script), so winner_side=0 (Bottom)
 * = attacker broke through (attacker_win, captures the tile); otherwise the defense succeeds (defender_win).
 * The attacker cannot change "whether these troops can break through under this defense config" by tampering with local state,
 * so the recomputed result is the authoritative outcome. stateHash/stars are meaningless for siege and are always empty/0.
 */
function runSiegeJudge(req: JudgeRequest): JudgeOutcome {
  try {
    let level: LevelDefinition;
    try {
      level = JSON.parse(req.defenseJson) as LevelDefinition;
    } catch {
      return FAIL; // defense config is not valid JSON → cannot recompute
    }
    const replay = buildReplay(req, 'siege', req.seed);
    const { ok, engine } = runHeadless(
      {
        seed: req.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'siege',
        level,
        ...(Object.keys(req.unitLevels ?? {}).length > 0
          ? { unitLevels: req.unitLevels }
          : { pveUpgrades: req.pveUpgrades }),
      },
      new ReplayInputSource(replay),
      req.endFrame + 600,
    );
    if (!ok) return FAIL;

    const winner = stateWinner(engine.state.winner);
    return { ok: true, stateHash: '', winnerSide: winner ?? 1, stars: 0, statsJson: '' };
  } catch {
    return FAIL;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Convert non-empty frames from a judge_request (game.proto opaque bytes) → a replayable Replay. */
function buildReplay(req: JudgeRequest, mode: GameMode, seed: number, levelId?: string): Replay {
  const frames: ReplayFrame[] = req.frames.map((fc) => {
    const commands: PlayerCommand[] = [];
    for (const sc of fc.cmds) {
      const decoded = PlayerCommands.decode(sc.commands);
      for (const pc of decoded.commands) commands.push(fromProto(pc, sc.side as OwnerId, fc.frame));
    }
    return { tick: fc.frame, commands };
  });
  return {
    engineVersion: ENGINE_VERSION,
    mode,
    seed,
    frames,
    endFrame: req.endFrame,
    ...(levelId ? { configRef: levelId, meta: { levelId } } : {}),
  };
}

/** game.proto PlayerCommand → engine PlayerCommand (same logic as NetInputSource.fromProto). */
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

/** state.winner (Side|null) → OwnerId|null (same mapping as the game_over event winner: Top=1, Bottom=0). */
function stateWinner(winner: Side | null): OwnerId | null {
  if (winner === null) return null;
  return winner === Side.Top ? 1 : 0;
}

/**
 * Authoritative definition of the final state hash (FNV-1a 32-bit). Both sides of the match (reported via app.ts)
 * and the third-party judge (recomputed in this file) must produce the exact same string,
 * or comparison breaks — hence both paths share this single implementation.
 */
export function matchStateHash(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): string {
  const payload = JSON.stringify({ winner, stats });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
