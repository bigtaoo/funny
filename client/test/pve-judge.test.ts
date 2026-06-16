// PvE L1 录像抽检复算（PVE_INTEGRITY §8.6 第 3 步）—— judgeRunner 的战役分支。
//
// 录一局真实战役（RecordingInputSource + LocalInputSource，玩家脚本指令 + WaveDirector 敌方），
// 跑到终局拿到「真实星数」，再把录像经 replayToUploadFrames 编码 → 解回 JudgeRequest 喂 runJudge
// 复算，断言复算星数与原局逐字一致（裁判用 seed+level+权威蓝图+玩家帧确定性重算，作弊者改不了）。
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { RecordingInputSource } from '../src/game/net/ReplayInputSource';
import { LocalInputSource } from '../src/game/net/InputSource';
import { Side, GamePhase } from '../src/game/types';
import type { GameConfig, IGameEngine, OwnerId } from '../src/game/types';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';
import { computeStars, remainingHpPct } from '../src/game/meta/campaignRewards';
import { runJudge } from '../src/net/judgeRunner';
import { replayToUploadFrames } from '../src/net/replayUpload';
import type { JudgeRequest } from '../src/net/proto/transport';
import type { FrameCmds } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const GameOver = GamePhase.GameOver;

type PlayScript = { plays: Record<number, [number, number]>; upgrades?: number[] };

/** 驱动引擎直到终局（或步数上限），按脚本在精确帧注入玩家指令。返回实跑帧数。 */
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

/** 原局终局星数（与 runPveJudge 同公式）：玩家(owner 0)胜才算星，否则 0。 */
function trueStars(engine: IGameEngine, thresholds: [number, number, number] | undefined): number {
  const w = engine.state.winner;
  const winner: OwnerId | null = w === Side.Top ? 1 : w === Side.Bottom ? 0 : null;
  if (winner !== 0) return 0;
  return computeStars(thresholds, remainingHpPct(engine.state.snapshotStats()[0].damageTakenByBase));
}

/** 上传帧（base64）→ JudgeRequest 帧（bytes），模拟 gateway 的 decodeFrames。 */
function toJudgeFrames(upload: ReturnType<typeof replayToUploadFrames>): FrameCmds[] {
  return upload.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({ side: c.side, commands: new Uint8Array(Buffer.from(c.commands, 'base64')) })),
  }));
}

describe('judgeRunner — PvE 抽检复算', () => {
  it('复算星数与原局终局逐字一致（编码→解码→战役重算闭环）', () => {
    const SEED = 0xbeef;
    const level = CAMPAIGN_LEVELS[CAMPAIGN_LEVEL_ORDER[0]!]!;
    const cfg: GameConfig = { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
    const script: PlayScript = { plays: { 30: [0, 1], 120: [0, 8], 260: [1, 4] }, upgrades: [60] };

    // 录一局到终局。
    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    const ran = driveToEnd(original, 6000, script);
    expect(original.state.phase).toBe(GameOver); // 关卡确定性必然分出胜负
    const expectedStars = trueStars(original, level.rewards?.starThresholds);
    const replay = rec.snapshot({ seed: level.seed, mode: 'campaign', configRef: level.id });

    // 编码上传帧 → 解回 JudgeRequest（owner 0 only）。
    const frames = toJudgeFrames(replayToUploadFrames(replay));
    for (const f of frames) for (const c of f.cmds) expect(c.side).toBe(0);

    const req: JudgeRequest = {
      requestId: 'pve-test',
      seed: 0, // PvE 裁判忽略：本地查 level.seed
      mode: 0,
      endFrame: replay.endFrame,
      frames,
      levelId: level.id,
      pveUpgrades: {}, // 无升级（与录制时一致）
    };

    const out = runJudge(req);
    expect(out.ok).toBe(true);
    expect(out.stars).toBe(expectedStars);
    expect(ran).toBeGreaterThan(0);
  });

  it('未知关卡 id → 复算失败（版本/数据不符）', () => {
    const req: JudgeRequest = {
      requestId: 'x',
      seed: 0,
      mode: 0,
      endFrame: 10,
      frames: [],
      levelId: 'no_such_level',
      pveUpgrades: {},
    };
    expect(runJudge(req)).toEqual({ ok: false, stateHash: '', winnerSide: 0, stars: 0 });
  });

  it('levelId 为空 → 走 PvP 分支（非 PvE）', () => {
    // 空 level_id 的 JudgeRequest 不进 PvE 分支；无帧的 PvP 复算因引擎不终局返回 ok:false。
    const req: JudgeRequest = {
      requestId: 'pvp',
      seed: 1,
      mode: 1,
      endFrame: 2,
      frames: [],
      levelId: '',
      pveUpgrades: {},
    };
    const out = runJudge(req);
    expect(out.stars).toBe(0);
  });
});
