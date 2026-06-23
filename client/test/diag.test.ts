import { describe, it } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { CAMPAIGN_LEVELS } from '../src/game/campaign/levels';
import type { GameConfig } from '../src/game/types';
import { Side, GamePhase } from '../src/game/types';
import { BaselinePlayer, DEFAULT_AI, progressionUnitLevels } from './difficultySim';

const TICK_DT = 1 / 30;

// 单关逐秒时间线检视器——调难度时盯着看：墨够不够花、敌人滚不滚雪球、
// 基地什么时候开始掉血、AI 各种操作的次数分布。改 LEVEL_ID/PRESET 即可换关。
const LEVEL_ID = 'ch1_lv1';
const PRESET = 'fresh' as const;

describe(`时间线检视 ${LEVEL_ID} (${PRESET})`, () => {
  it('逐秒时间线 + 动作统计', () => {
    const level = CAMPAIGN_LEVELS[LEVEL_ID]!;
    const config: GameConfig = {
      seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level,
      unitLevels: progressionUnitLevels(PRESET),
    };
    const engine = createGameEngine(config);

    const tally: Record<string, number> = {};
    const origPlay = engine.playCard.bind(engine);
    const origUp = engine.upgradeBase.bind(engine);
    (engine as unknown as { playCard: typeof engine.playCard }).playCard = (handIndex, col, row) => {
      const slot = engine.state.bottomPlayer.hand.slots[handIndex];
      const sub = slot ? (slot.card.unitType ?? slot.card.buildingType ?? slot.card.spellType ?? '?') : 'empty';
      tally[String(sub)] = (tally[String(sub)] ?? 0) + 1;
      origPlay(handIndex, col, row);
    };
    (engine as unknown as { upgradeBase: typeof engine.upgradeBase }).upgradeBase = () => {
      tally['upgrade'] = (tally['upgrade'] ?? 0) + 1; origUp();
    };

    const ai = new BaselinePlayer(DEFAULT_AI);
    console.log('\n t(s) | ink | base | 我兵 | 我塔 | 敌兵');
    for (let tick = 0; tick < 3600 && engine.state.phase !== GamePhase.GameOver; tick++) {
      ai.act(engine, tick);
      engine.tick(TICK_DT);
      if (tick % 30 === 0) {
        const p = engine.state.bottomPlayer;
        let myU = 0, enU = 0, myT = 0;
        for (const u of engine.state.board.units.values()) {
          if (u.isDead) continue;
          if (u.side === Side.Bottom) myU++; else enU++;
        }
        for (const b of engine.state.board.buildings.values())
          if (b.side === Side.Bottom && b.buildingType === 'arrow_tower') myT++;
        console.log(` ${String(tick / 30).padStart(4)} | ${String(p.ink).padStart(3)} | ${String(p.baseHp).padStart(4)} | ${String(myU).padStart(4)} | ${String(myT).padStart(4)} | ${String(enU).padStart(4)}`);
      }
    }
    console.log('\n动作统计:', JSON.stringify(tally));
    console.log(`结束 winner=${engine.state.winner} baseHp=${engine.state.bottomPlayer.baseHp}\n`);
  });
});
