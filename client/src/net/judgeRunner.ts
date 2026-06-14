// 对等裁判无头复算（Phase C）。被 gateway 选中的客户端收到 judge_request 后，用其中的
// seed + 非空帧录像在本机跑一遍确定性引擎到终局，算出与 match_result 同构的终局 hash +
// winner，回报 judge_verdict。meta 据此判定 ranked hash 不一致时哪方诚实、哪方作弊。
//
// 关键：判定引擎与对局完全确定（定点数 + 注入 PRNG），同 seed + 同确认指令流逐 tick 复现。
// 故第三方喂回同一帧流即可重算出双方本应得到的同一 hash——作弊方篡改的是其本地状态，
// 改不了服务器排序后的指令流，复算结果必与诚实方一致。无渲染、无交互，纯逻辑。

import {
  createGameEngine,
  ReplayInputSource,
  ENGINE_VERSION,
  Side,
  GamePhase,
  TICK_RATE,
  type OwnerId,
  type PlayerCommand,
  type PlayerStats,
  type Replay,
  type ReplayFrame,
} from '../game';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from './proto/game';
import type { JudgeRequest } from './proto/transport';

export interface JudgeOutcome {
  ok: boolean;
  stateHash: string;
  winnerSide: number;
}

const FAIL: JudgeOutcome = { ok: false, stateHash: '', winnerSide: 0 };

/**
 * 复算一局并返回终局 hash。无法跑到终局（帧流不完整 / 异常）→ {ok:false}。
 * 上限步数 = endFrame + 余量，防坏录像导致死循环。
 */
export function runJudge(req: JudgeRequest): JudgeOutcome {
  try {
    const replay = buildReplay(req);
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
    return { ok: true, stateHash: matchStateHash(winner, stats), winnerSide: winner ?? 0 };
  } catch {
    return FAIL;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** judge_request 的非空帧（game.proto opaque bytes）→ 可回放的 Replay。 */
function buildReplay(req: JudgeRequest): Replay {
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
    mode: 'netplay',
    seed: req.seed,
    frames,
    endFrame: req.endFrame,
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
