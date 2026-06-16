// 对等裁判无头复算（Phase C）。被 gateway 选中的客户端收到 judge_request 后，用其中的
// seed + 非空帧录像在本机跑一遍确定性引擎到终局，算出与 match_result 同构的终局 hash +
// winner，回报 judge_verdict。meta 据此判定 ranked hash 不一致时哪方诚实、哪方作弊。
//
// 关键：判定引擎与对局完全确定（定点数 + 注入 PRNG），同 seed + 同确认指令流逐 tick 复现。
// 故第三方喂回同一帧流即可重算出双方本应得到的同一 hash——作弊方篡改的是其本地状态，
// 改不了服务器排序后的指令流，复算结果必与诚实方一致。无渲染、无交互，纯逻辑。

import {
  createGameEngine,
  getLevel,
  ReplayInputSource,
  ENGINE_VERSION,
  Side,
  GamePhase,
  TICK_RATE,
  type GameMode,
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
}

const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0, stars: 0 };

/**
 * 复算一局并返回终局结果。无法跑到终局（帧流不完整 / 异常）→ {ok:false}。
 * `level_id` 非空 → PvE 抽检复算（战役模式，回报星数）；否则 PvP（回报终局 hash + winner）。
 * 上限步数 = endFrame + 余量，防坏录像导致死循环。
 */
export function runJudge(req: JudgeRequest): JudgeOutcome {
  if (req.levelId) return runPveJudge(req);
  try {
    const replay = buildReplay(req, 'netplay', req.seed);
    const engine = createGameEngine(
      { seed: req.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      new ReplayInputSource(replay),
    );

    const tickDt = 1 / TICK_RATE;
    const maxTicks = req.endFrame + 600; // 终局后留余量；正常会更早 GameOver
    let guard = 0;
    while (engine.state.phase !== GamePhase.GameOver && guard < maxTicks) {
      engine.tick(tickDt);
      guard++;
    }
    if (engine.state.phase !== GamePhase.GameOver) return FAIL;

    const winner = stateWinner(engine.state.winner);
    const stats = engine.state.snapshotStats();
    return { ok: true, stateHash: matchStateHash(winner, stats), winnerSide: winner ?? 0, stars: 0 };
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
    const engine = createGameEngine(
      {
        seed: level.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'campaign',
        level,
        pveUpgrades: req.pveUpgrades,
      },
      new ReplayInputSource(replay),
    );

    const tickDt = 1 / TICK_RATE;
    const maxTicks = req.endFrame + 600;
    let guard = 0;
    while (engine.state.phase !== GamePhase.GameOver && guard < maxTicks) {
      engine.tick(tickDt);
      guard++;
    }
    if (engine.state.phase !== GamePhase.GameOver) return FAIL;

    const winner = stateWinner(engine.state.winner);
    if (winner !== 0) return { ok: true, stateHash: '', winnerSide: winner ?? 0, stars: 0 };
    const stats = engine.state.snapshotStats();
    const stars = computeStars(level.rewards?.starThresholds, remainingHpPct(stats[0].damageTakenByBase));
    return { ok: true, stateHash: '', winnerSide: 0, stars };
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
