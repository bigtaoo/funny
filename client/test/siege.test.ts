// SLG 围攻战引擎 + judgeRunner 复算（S8-3，SLG_DESIGN §5）。
//
// siege 模式 = campaign 机制（防守方 WaveDirector 脚本）+ buildSiegeBlueprints 养成蓝图，
// 攻方=本地玩家(owner 0)，破防守基地=attacker_win 夺地。本测覆盖三块：
//   ①养成单调性 + 天梯红线（§6）：siege 蓝图随升级增强、{} 等于常量、PvP 蓝图永不受影响；
//   ②引擎确定性：同 seed + 同防守 config + 同攻方指令流 → 逐字同终局；
//   ③judge 复算闭环：录一局围攻 → 上传帧编码 → JudgeRequest(defenseJson) → runJudge 重算 winner 一致。
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { RecordingInputSource } from '../src/game/net/ReplayInputSource';
import { LocalInputSource } from '../src/game/net/InputSource';
import { Side, GamePhase, UnitType } from '../src/game/types';
import type { GameConfig, IGameEngine, OwnerId } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import {
  PVE_UPGRADE_DEFS,
  buildPvpBlueprints,
  buildSiegeBlueprints,
} from '../src/game/balance/pveUpgrades';
import { runJudge } from '../src/net/judgeRunner';
import { replayToUploadFrames } from '../src/net/replayUpload';
import type { JudgeRequest, FrameCmds } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const GameOver = GamePhase.GameOver;

/** 一份可被围攻的防守 config（worldsvc S8-3 为被攻击格即时构造的同形态）。 */
function defenseConfig(seed: number): LevelDefinition {
  return {
    id: 'siege_test',
    chapter: 0,
    seed,
    objective: { kind: 'timed_defense', durationTicks: 300 },
    waves: {
      entries: [
        { atTick: 30, unitType: UnitType.Infantry, col: 4, count: 3, spacingTicks: 20 },
        { atTick: 90, unitType: UnitType.Archer, col: 7, count: 2, spacingTicks: 15 },
      ],
    },
  };
}

type PlayScript = { plays: Record<number, [number, number]>; upgrades?: number[] };

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

function winnerOf(engine: IGameEngine): OwnerId | null {
  const w = engine.state.winner;
  return w === Side.Top ? 1 : w === Side.Bottom ? 0 : null;
}

/** 上传帧（base64）→ JudgeRequest 帧（bytes），模拟 gateway 的 decodeFrames。 */
function toJudgeFrames(upload: ReturnType<typeof replayToUploadFrames>): FrameCmds[] {
  return upload.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({
      side: c.side,
      commands: new Uint8Array(Buffer.from(c.commands, 'base64')),
    })),
  }));
}

function maxedUpgrades(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of PVE_UPGRADE_DEFS) out[def.id] = def.maxLevel;
  return out;
}

describe('siege 养成蓝图 — 单调性 + 天梯红线 (SLG7 §6)', () => {
  it('buildSiegeBlueprints({}) 等于常量', () => {
    expect(buildSiegeBlueprints({})).toEqual(UNIT_BLUEPRINTS);
  });

  it('养成↑ → siege 蓝图战力↑（HP / 攻击）', () => {
    const sg = buildSiegeBlueprints(maxedUpgrades());
    expect(sg[UnitType.Infantry].hp).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].hp);
    expect(sg[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('满级 siege 蓝图后，PvP 蓝图仍逐字等于常量（红线不破）', () => {
    void buildSiegeBlueprints(maxedUpgrades());
    expect(buildPvpBlueprints()).toEqual(UNIT_BLUEPRINTS);
  });

  it('siege 引擎走 buildSiegeBlueprints；同 mode 下养成生效', () => {
    const lvl = defenseConfig(1);
    const eng = createGameEngine(
      { seed: 1, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl, pveUpgrades: maxedUpgrades() },
    ) as unknown as { state: { unitBlueprints: typeof UNIT_BLUEPRINTS } };
    expect(eng.state.unitBlueprints[UnitType.Infantry].hp).toBeGreaterThan(
      UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    );
  });
});

describe('siege 引擎确定性', () => {
  it('同 seed + 同防守 config + 同攻方指令 → 同终局 winner', () => {
    const SEED = 0x51e6e;
    const lvl = defenseConfig(SEED);
    const cfg: GameConfig = { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl };
    const script: PlayScript = { plays: { 20: [0, 4], 80: [0, 7], 150: [1, 4] }, upgrades: [40] };

    const a = createGameEngine(cfg);
    driveToEnd(a, 6000, script);
    const b = createGameEngine(cfg);
    driveToEnd(b, 6000, script);

    expect(a.state.phase).toBe(GameOver);
    expect(b.state.phase).toBe(GameOver);
    expect(winnerOf(a)).toBe(winnerOf(b));
    expect(a.state.snapshotStats()).toEqual(b.state.snapshotStats());
  });
});

describe('judgeRunner — 围攻复算闭环', () => {
  it('复算 winner 与原局终局一致（录制→编码→解码→siege 重算）', () => {
    const SEED = 0xc0ffee;
    const lvl = defenseConfig(SEED);
    const cfg: GameConfig = { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl };
    const script: PlayScript = { plays: { 25: [0, 4], 70: [0, 7], 140: [1, 4], 200: [2, 8] }, upgrades: [50] };

    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    const ran = driveToEnd(original, 6000, script);
    expect(original.state.phase).toBe(GameOver);
    const expectedWinner = winnerOf(original);
    const replay = rec.snapshot({ seed: SEED, mode: 'siege', configRef: lvl.id });

    const frames = toJudgeFrames(replayToUploadFrames(replay));
    // PvE/SLG 录像只含攻方(owner 0)指令（防守 WaveDirector 由 seed+config 重算）。
    for (const f of frames) for (const c of f.cmds) expect(c.side).toBe(0);

    const req: JudgeRequest = {
      requestId: 'siege-test',
      seed: SEED,
      mode: 0,
      endFrame: replay.endFrame,
      frames,
      levelId: '',
      pveUpgrades: {},
      defenseJson: JSON.stringify(lvl),
    };

    const out = runJudge(req);
    expect(out.ok).toBe(true);
    expect(out.winnerSide).toBe(expectedWinner ?? 1);
    expect(ran).toBeGreaterThan(0);
  });

  it('defenseJson 非法 JSON → 复算失败', () => {
    const req: JudgeRequest = {
      requestId: 'bad',
      seed: 1,
      mode: 0,
      endFrame: 10,
      frames: [],
      levelId: '',
      pveUpgrades: {},
      defenseJson: '{not json',
    };
    expect(runJudge(req)).toEqual({ ok: false, stateHash: '', winnerSide: 0, stars: 0 });
  });
});
