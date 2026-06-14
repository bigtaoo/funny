// 对等裁判无头复算（Phase C）。证明：给定 seed + 服务器排序后的非空帧录像，第三方
// runJudge 复算出的终局 hash 与一台独立 netplay 引擎跑同一指令流得到的权威 hash 逐字相同
// ——这正是裁判能判定「哪方诚实」的根据。另测：帧流不完整 → ok:false（有界、不崩）。
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { GamePhase, Side, type InputSource, type OwnerId, type PlayerCommand } from '../src/game';
import { matchStateHash, runJudge } from '../src/net/judgeRunner';
import { PlayerCommands } from '../src/net/proto/game';
import type { JudgeRequest } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const SEED = 0xbeef;
// 无人攻破基地 → netplay 在 FORCE_DRAW_THRESHOLD_TICKS 强制平局结束（确定的终局）。
const END_FRAME = 30700;

/** 喂预先编排好的「确认指令流」的输入源（模拟服务器逐帧下发，不停步）。 */
class ScriptedSource implements InputSource {
  constructor(private readonly byFrame: Map<number, PlayerCommand[]>) {}
  submit(): void {
    /* fixed playback */
  }
  take(frame: number): readonly PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }
}

/** 编排：双方各出几张牌（owner/frame/handIndex/col）。 */
const SCRIPT: { frame: number; owner: OwnerId; handIndex: number; col: number }[] = [
  { frame: 30, owner: 0, handIndex: 0, col: 1 },
  { frame: 60, owner: 1, handIndex: 0, col: 8 },
  { frame: 200, owner: 0, handIndex: 1, col: 3 },
  { frame: 260, owner: 1, handIndex: 1, col: 5 },
];

function authoredByFrame(): Map<number, PlayerCommand[]> {
  const m = new Map<number, PlayerCommand[]>();
  for (const s of SCRIPT) {
    const cmd: PlayerCommand = {
      type: 'play_card',
      owner: s.owner,
      tick: s.frame,
      handIndex: s.handIndex,
      col: s.col,
    };
    (m.get(s.frame) ?? m.set(s.frame, []).get(s.frame)!).push(cmd);
  }
  return m;
}

function toProto(cmd: PlayerCommand) {
  if (cmd.type === 'upgrade_base') return { upgradeBase: {}, playCard: undefined };
  return {
    playCard: { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 },
    upgradeBase: undefined,
  };
}

/** 编排 → JudgeRequest（每帧按 owner 分组成 SideCmd，commands 用 game.proto 编码）。 */
function buildJudgeRequest(byFrame: Map<number, PlayerCommand[]>): JudgeRequest {
  const frames = [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, cmds]) => {
      const bySide = new Map<number, PlayerCommand[]>();
      for (const c of cmds) (bySide.get(c.owner) ?? bySide.set(c.owner, []).get(c.owner)!).push(c);
      return {
        frame,
        cmds: [...bySide.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([side, list]) => ({
            side,
            commands: PlayerCommands.encode({ commands: list.map(toProto) }).finish(),
          })),
      };
    });
  return { requestId: 'r1', seed: SEED, mode: 1, endFrame: END_FRAME, frames } as JudgeRequest;
}

/** 独立权威引擎：跑同一指令流到终局，算权威 hash。 */
function authoritativeHash(byFrame: Map<number, PlayerCommand[]>): string {
  const engine = createGameEngine(
    { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
    new ScriptedSource(byFrame),
  );
  let guard = 0;
  while (engine.state.phase !== GamePhase.GameOver && guard < END_FRAME + 100) {
    engine.tick(TICK_DT);
    guard++;
  }
  expect(engine.state.phase).toBe(GamePhase.GameOver);
  const winner: OwnerId | null =
    engine.state.winner === null ? null : engine.state.winner === Side.Top ? 1 : 0;
  return matchStateHash(winner, engine.state.snapshotStats());
}

describe('peer judge runner', () => {
  it('复算出的终局 hash 与独立权威引擎逐字相同', () => {
    const byFrame = authoredByFrame();
    const expected = authoritativeHash(byFrame);

    const out = runJudge(buildJudgeRequest(byFrame));
    expect(out.ok).toBe(true);
    expect(out.stateHash).toBe(expected);
  }, 30_000);

  it('确定：同一 JudgeRequest 复算两次结果全等', () => {
    const req = buildJudgeRequest(authoredByFrame());
    const a = runJudge(req);
    const b = runJudge(req);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  }, 30_000);

  it('帧流不完整（endFrame 远早于终局）→ ok:false，不崩', () => {
    const req = buildJudgeRequest(authoredByFrame());
    const out = runJudge({ ...req, endFrame: 50 } as JudgeRequest);
    expect(out.ok).toBe(false);
  });
});
