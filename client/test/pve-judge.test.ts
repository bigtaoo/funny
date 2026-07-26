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
import { toEngineCardInstances } from '../src/game/meta/cardDefs';
import type { CardInstance, EquipmentInstance } from '../src/game/meta/SaveData';
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
    unitsKilled: stats[0].unitsKilled,
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
      cardInstancesJson: '', // no cards (consistent with the recording)
      equipmentInvJson: '',
      defenseJson: '',
      topDeck: [],
      bottomDeck: [],
    };

    const out = runJudge(req);
    expect(out.ok).toBe(true);
    expect(out.stars).toBe(expectedStars);
    expect(ran).toBeGreaterThan(0);
  });

  it('recompute uses the real Hero Roster card level + equipment, not a level-1/gearless baseline (regression, 2026-07-26 fix)', () => {
    // Root cause: judgeRunner used to build the recompute GameConfig from the dead pveUpgrades/unitLevels
    // fields (removed by the CC-1 migration; GameConfig only reads cardInstances/equipmentInv), so every L1
    // spot-check silently recomputed with unleveled, gear-less units — regardless of the player's real Hero
    // Roster investment — causing false `rejected` verdicts for legitimately progressed, actively-played clears.
    const level = CAMPAIGN_LEVELS[CAMPAIGN_LEVEL_ORDER[0]!]!;
    const script: PlayScript = { plays: { 30: [0, 1], 120: [0, 8], 260: [1, 4] }, upgrades: [60] };

    const equipmentInv: Record<string, EquipmentInstance> = {
      eq_test_weapon: { id: 'eq_test_weapon', defId: 'test_weapon', rarity: 'epic', level: 9, affixes: [{ id: 'm_atk', value: 80 }] },
    };
    const cardInv: Record<string, CardInstance> = {
      card_test_infantry: { id: 'card_test_infantry', defId: 'lichuang', level: 9, gear: { weapon: 'eq_test_weapon' }, locked: false },
    };

    // Record the "true" match exactly as the live client would (app/nav/game.ts: cardInstances + equipmentInv
    // from the player's real save), using the same script as the closed-loop test above.
    const cfg: GameConfig = {
      seed: level.seed,
      players: [{ id: 0 }, { id: 1 }],
      mode: 'campaign',
      level,
      cardInstances: toEngineCardInstances(cardInv),
      equipmentInv,
    };
    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    const ran = driveToEnd(original, 6000, script);
    expect(original.state.phase).toBe(GameOver);
    const expectedStars = trueStars(original, level);
    const replay = rec.snapshot({ seed: level.seed, mode: 'campaign', configRef: level.id });
    const frames = toJudgeFrames(replayToUploadFrames(replay));

    // Judge recompute WITH the server-authoritative snapshot (the fix): must reproduce the true star count exactly.
    const reqWithSnapshot: JudgeRequest = {
      requestId: 'pve-cardinv-fixed',
      seed: 0,
      mode: 0,
      endFrame: replay.endFrame,
      frames,
      levelId: level.id,
      cardInstancesJson: JSON.stringify(cardInv),
      equipmentInvJson: JSON.stringify(equipmentInv),
      defenseJson: '',
      topDeck: [],
      bottomDeck: [],
    };
    const withSnapshot = runJudge(reqWithSnapshot);
    expect(withSnapshot.ok).toBe(true);
    expect(withSnapshot.stars).toBe(expectedStars);

    // Judge recompute WITHOUT the snapshot (the old, buggy behavior: an empty/dead blueprint) must NOT silently
    // reproduce the same claimed result — it either scores strictly lower (weaker units under the same script)
    // or fails to resolve within the tick budget. Either way this is exactly the false-`rejected` failure mode
    // this fix closes; asserting it still misbehaves without the snapshot proves the assertion above is non-vacuous.
    const reqBare: JudgeRequest = { ...reqWithSnapshot, requestId: 'pve-cardinv-bare', cardInstancesJson: '', equipmentInvJson: '' };
    const bare = runJudge(reqBare);
    // Empirically: the same script that scores 2★ with the real card/gear drops the player's base entirely
    // (winnerSide flips, stars:0) once the card/gear snapshot is stripped — i.e. exactly the false-`rejected`
    // verdict an honest, actively-played clear would have suffered under the pre-fix judge.
    expect(bare.ok === false || bare.stars < expectedStars).toBe(true);
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
      cardInstancesJson: '',
      equipmentInvJson: '',
      defenseJson: '',
      topDeck: [],
      bottomDeck: [],
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
      cardInstancesJson: '',
      equipmentInvJson: '',
      defenseJson: '',
      topDeck: [],
      bottomDeck: [],
    };
    const out = runJudge(req);
    expect(out.stars).toBe(0);
  });
});
