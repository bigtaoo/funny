// 回归守护：结算「双发」bug（埋点 level_complete / recordClear 每帧重复触发）。
//
// 根因有两层：
//   1. 引擎侧：GameOver 后 step() 提前返回且**不清** state.events，故 game_over 事件
//      会一直滞留在事件队列里——GameRenderer.update 每帧 `for (event of state.events)`
//      就会每帧重读到它。本测试证明这一滞留是真实存在的（→ 渲染层必须自带闸门）。
//   2. 渲染侧（真正的修复）：GameRenderer 用一次性 `gameEnded` 闸门，保证 game_over/
//      game_draw 只触发一次 onGameEnd（→ 只结算一次）。渲染层依赖 PIXI，归 UI 烟囱测，
//      此处用纯引擎契约守住「引擎只产生一次 game_over」+ 记录滞留行为。

import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import type { GameConfig } from '../src/game/types';
import { GamePhase, UnitType } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';

// 一个必然速败的关卡：maxLeaks=1 + 3 个 Runner 冲底 → 短时间内分出胜负（Top 赢）。
const losingLevel: LevelDefinition = {
  id: 'test_over', chapter: 0, seed: 1,
  objective: { kind: 'leak_limit', maxLeaks: 1 },
  waves: { entries: [{ atTick: 5, unitType: UnitType.Runner, col: 0, count: 3, spacingTicks: 60 }] },
};
const cfg: GameConfig = { seed: losingLevel.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level: losingLevel };

describe('game_over 只产生一次（结算双发回归）', () => {
  it('整局 step() 返回值里 game_over 恰好出现一次；结束后 step() 返回空', () => {
    const engine = createGameEngine(cfg);
    let gameOverEmissions = 0;
    let postOverSteps = 0;
    for (let i = 0; i < 800; i++) {
      const wasOver = engine.state.phase === GamePhase.GameOver;
      const events = engine.step(i, []);
      gameOverEmissions += events.filter((e) => e.type === 'game_over').length;
      if (wasOver) {
        postOverSteps++;
        expect(events).toEqual([]); // 结束后不再产出任何事件
      }
    }
    expect(gameOverEmissions).toBe(1); // 引擎只发一次
    expect(postOverSteps).toBeGreaterThan(0); // 确实跑过了结束后的若干 step
  });

  it('结束后 game_over 滞留在 state.events 队列（→ 渲染层必须用一次性闸门兜住）', () => {
    const engine = createGameEngine(cfg);
    let i = 0;
    for (; i < 800 && engine.state.phase !== GamePhase.GameOver; i++) engine.step(i, []);
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    expect(engine.state.events.some((e) => e.type === 'game_over')).toBe(true);
    // 再跑一帧（不经过会清队列的正常 step 分支）——事件仍在，证明每帧重读的隐患成立。
    engine.step(i, []);
    expect(engine.state.events.some((e) => e.type === 'game_over')).toBe(true);
  });
});
