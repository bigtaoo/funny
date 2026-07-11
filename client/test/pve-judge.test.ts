// PvE L1 replay spot-check re-verification (PVE_INTEGRITY §8.6 step 3) — campaign branch of judgeRunner.
//
// Records a real campaign run (RecordingInputSource + LocalInputSource, player script commands
// + WaveDirector enemy side), runs to completion to obtain the "true star count", then encodes
// the replay via replayToUploadFrames → decodes back into a JudgeRequest and feeds it to
// runJudge for re-verification. Asserts the re-verified star count matches the original
// verbatim (the judge deterministically re-runs from seed+level+authoritative blueprints+
// player frames, so cheaters cannot alter the outcome).
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { RecordingInputSource } from '../src/game/net/ReplayInputSource';
import { LocalInputSource } from '../src/game/net/InputSource';
import { Side, GamePhase } from '../src/game/types';
import type { GameConfig, IGameEngine, OwnerId } from '../src/game/types';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { computeStars, buildStarContext } from '../src/game/meta/campaignRewards';
import type { LevelDefinition } from '@nw/engine';
import { runJudge } from '../src/net/judgeRunner';
import { replayToUploadFrames } from '../src/net/replayUpload';
import type { JudgeRequest } from '../src/net/proto/transport';
import type { FrameCmds } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const GameOver = GamePhase.GameOver;

type PlayScript = { plays: Record<number, [number, number]>; upgrades?: number[] };

/** Drive the engine until game over (or the tick limit), injecting player commands at exact frames per script. Returns the actual tick count run. */
function driveToEnd(engine: IGameEngine, maxTicks: number, script: PlayScript): number {
  const upgrades = new Set(script.upgrades ?? []);
  let i = 0;
  for (; i < maxTicks && engine.state.phase !== GameOver; i++) {
    const play = script.plays[i];
    if (play) engine.playCard(play[0], play[1]);
    if (upgrades.has(i)) engine.upgradeBase();
    engine.tick(TICK_DT);
  }
  return i;
}

/** Star count from the original run (same ctx as runPveJudge): stars are awarded only if the player (owner 0) wins, otherwise 0. */
function trueStars(engine: IGameEngine, level: LevelDefinition): number {
  const w = engine.state.winner;
  const winner: OwnerId | null = w === Side.Top ? 1 : w === Side.Bottom ? 0 : null;
  if (winner !== 0) return 0;
  const stats = engine.state.snapshotStats();
  const summary = engine.state.snapshotSummary();
  return computeStars(level.rewards?.starThresholds, buildStarContext(level, {
    damageTakenByBase: stats[0].damageTakenByBase,
    elapsedTicks: summary.elapsedTicks,
    enemyLeaks: summary.enemyLeaks,
    escortMinHpPct: summary.escortMinHpPct,
  }));
}

/** Upload frames (base64) → JudgeRequest frames (bytes), simulating gateway's decodeFrames. */
function toJudgeFrames(upload: ReturnType<typeof replayToUploadFrames>): FrameCmds[] {
  return upload.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({ side: c.side, commands: new Uint8Array(Buffer.from(c.commands, 'base64')) })),
  }));
}

describe('judgeRunner — PvE spot-check re-verification', () => {
  it('re-verified star count matches the original verbatim (encode→decode→campaign re-run closed loop)', () => {
    const SEED = 0xbeef;
    const level = CAMPAIGN_LEVELS[CAMPAIGN_LEVEL_ORDER[0]!]!;
    const cfg: GameConfig = { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
    const script: PlayScript = { plays: { 30: [0, 1], 120: [0, 8], 260: [1, 4] }, upgrades: [60] };

    // Record a run to completion.
    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    const ran = driveToEnd(original, 6000, script);
    expect(original.state.phase).toBe(GameOver); // level is deterministic and always produces a winner
    const expectedStars = trueStars(original, level);
    const replay = rec.snapshot({ seed: level.seed, mode: 'campaign', configRef: level.id });

    // Encode upload frames → decode back into a JudgeRequest (owner 0 only).
    const frames = toJudgeFrames(replayToUploadFrames(replay));
    for (const f of frames) for (const c of f.cmds) expect(c.side).toBe(0);

    const req: JudgeRequest = {
      requestId: 'pve-test',
      seed: 0, // PvE judge ignores this: level.seed is looked up locally
      mode: 0,
      endFrame: replay.endFrame,
      frames,
      levelId: level.id,
      pveUpgrades: {}, // no upgrades (consistent with the recording)
      unitLevels: {},
      defenseJson: '',
    };

    const out = runJudge(req);
    expect(out.ok).toBe(true);
    expect(out.stars).toBe(expectedStars);
    expect(ran).toBeGreaterThan(0);
  });

  it('unknown level id → re-verification fails (version/data mismatch)', () => {
    const req: JudgeRequest = {
      requestId: 'x',
      seed: 0,
      mode: 0,
      endFrame: 10,
      frames: [],
      levelId: 'no_such_level',
      pveUpgrades: {},
      unitLevels: {},
      defenseJson: '',
    };
    expect(runJudge(req)).toEqual({ ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' });
  });

  it('empty levelId → takes the PvP branch (not PvE)', () => {
    // A JudgeRequest with an empty level_id skips the PvE branch; PvP re-verification with no frames returns ok:false because the engine never reaches game over.
    const req: JudgeRequest = {
      requestId: 'pvp',
      seed: 1,
      mode: 1,
      endFrame: 2,
      frames: [],
      levelId: '',
      pveUpgrades: {},
      unitLevels: {},
      defenseJson: '',
    };
    const out = runJudge(req);
    expect(out.stars).toBe(0);
  });
});
