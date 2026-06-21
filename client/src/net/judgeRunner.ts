// 对等裁判无头复算（Phase C）。被 gateway 选中的客户端收到 judge_request 后，用其中的
// seed + 非空帧录像在本机跑一遍确定性引擎到终局，算出与 match_result 同构的终局 hash +
// winner，回报 judge_verdict。meta 据此判定 ranked hash 不一致时哪方诚实、哪方作弊。
//
// 关键：判定引擎与对局完全确定（定点数 + 注入 PRNG），同 seed + 同确认指令流逐 tick 复现。
// 故第三方喂回同一帧流即可重算出双方本应得到的同一 hash——作弊方篡改的是其本地状态，
// 改不了服务器排序后的指令流，复算结果必与诚实方一致。无渲染、无交互，纯逻辑。

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
  /** PvE 抽检复算（PVE_INTEGRITY §8.6 L1）：复算得到的星数（0 = 未通关）。PvP 恒 0。 */
  stars: number;
  /**
   * PvE 喂入（S9-3b，ACHIEVEMENT_DESIGN §6.2）：复算出的玩家(owner 0)本局成就计数 JSON
   * （`achievementStatDelta`，`{"kill.archer":n,…}`）。裁判权威 → meta verified 时 L1 校验后累加。
   * PvP/siege 复算与未通关恒空串。
   */
  statsJson: string;
}

const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' };

/**
 * 复算一局并返回终局结果。无法跑到终局（帧流不完整 / 异常）→ {ok:false}。
 * `level_id` 非空 → PvE 抽检复算（战役模式，回报星数）；否则 PvP（回报终局 hash + winner）。
 * 上限步数 = endFrame + 余量，防坏录像导致死循环。
 */
export function runJudge(req: JudgeRequest): JudgeOutcome {
  if (req.defenseJson) return runSiegeJudge(req);
  if (req.levelId) return runPveJudge(req);
  try {
    const replay = buildReplay(req, 'netplay', req.seed);
    // endFrame + 余量：终局后留缓冲，防坏录像死循环；正常会更早 GameOver。
    const { ok, engine } = runHeadless(
      { seed: req.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      new ReplayInputSource(replay),
      req.endFrame + 600,
    );
    if (!ok) return FAIL;

    const winner = stateWinner(engine.state.winner);
    const stats = engine.state.snapshotStats();
    return {
      ok: true,
      stateHash: matchStateHash(winner, stats),
      winnerSide: winner ?? 0,
      stars: 0,
      statsJson: '',
    };
  } catch {
    return FAIL;
  }
}

/**
 * PvE 抽检复算（PVE_INTEGRITY §8.6 L1）：用 seed（由 level 派生，本地查 levels JSON 取权威值）
 * + 服务器权威 pve_upgrades 蓝图快照 + 玩家指令帧，按战役模式跑到终局算星数。复算的星数交
 * meta 与客户端声称的对比——作弊者篡改的是本地状态，改不了「这套指令是否真能在这套蓝图下通关」，
 * 故复算结果与诚实通关一致。通关 = 玩家(owner 0)胜；非玩家胜 → 0 星。
 */
function runPveJudge(req: JudgeRequest): JudgeOutcome {
  try {
    const level = getLevel(req.levelId);
    if (!level) return FAIL; // 裁判本地无此关定义 → 无法复算（版本不符）
    const replay = buildReplay(req, 'campaign', level.seed, req.levelId);
    const { ok, engine } = runHeadless(
      {
        seed: level.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'campaign',
        level,
        pveUpgrades: req.pveUpgrades,
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
    // PvE 喂入（S9-3b）：通关（玩家 owner 0 胜）→ 回报玩家本局成就计数。裁判权威，meta L1 校验后累加。
    const statsJson = JSON.stringify(achievementStatDelta(stats[0]));
    return { ok: true, stateHash: '', winnerSide: 0, stars, statsJson };
  } catch {
    return FAIL;
  }
}

/**
 * SLG 围攻复算（S8-3，SLG_DESIGN §5.3）：worldsvc 为被攻击格构造一份防守 config（LevelDefinition
 * 的 JSON），裁判用 seed + 该 config + 攻方服务器权威养成快照（pve_upgrades）+ 攻方指令帧按 siege
 * 模式跑到终局。siege 引擎机制同 campaign（防守方=WaveDirector 脚本），故 winner_side=0(Bottom)
 * = 攻方破城（attacker_win 夺地），否则防守成功（defender_win）。攻方篡改本地状态改不了「这套兵能否
 * 在这套防守 config 下破城」，复算结果即权威 outcome。stateHash/stars 对 siege 无意义恒空/0。
 */
function runSiegeJudge(req: JudgeRequest): JudgeOutcome {
  try {
    let level: LevelDefinition;
    try {
      level = JSON.parse(req.defenseJson) as LevelDefinition;
    } catch {
      return FAIL; // 防守 config 不是合法 JSON → 无法复算
    }
    const replay = buildReplay(req, 'siege', req.seed);
    const { ok, engine } = runHeadless(
      {
        seed: req.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'siege',
        level,
        pveUpgrades: req.pveUpgrades,
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

/** judge_request 的非空帧（game.proto opaque bytes）→ 可回放的 Replay。 */
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

/** game.proto PlayerCommand → 引擎 PlayerCommand（与 NetInputSource.fromProto 同逻辑）。 */
function fromProto(pc: ProtoPlayerCommand, owner: OwnerId, frame: number): PlayerCommand {
  if (pc.upgradeBase) return { type: 'upgrade_base', owner, tick: frame };
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

/** state.winner (Side|null) → OwnerId|null（与 game_over 事件 winner 同映射：Top=1, Bottom=0）。 */
function stateWinner(winner: Side | null): OwnerId | null {
  if (winner === null) return null;
  return winner === Side.Top ? 1 : 0;
}

/**
 * 终局 hash（FNV-1a 32 位）的唯一定义。对局双方（app.ts 上报）与第三方裁判（本文件复算）
 * 必须算出逐字相同的字符串，否则比对失效——故两处共用此一处实现。
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
