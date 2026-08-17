# 逻辑层架构 — 事件 / 指令 / 录像 / AI（七 起）

> 从 [`logic-architecture.md`](logic-architecture.md) 拆出（2026-08-17，原文件 575 行）。**小节编号沿用原文**，`logic-architecture.md §N` 引用照旧有效。
> 本册内容：七 事件系统、八 指令系统、九 录像格式、十–十四 AI/联机/计时器/抽牌/结算。总览与在先小节见 [`logic-architecture.md`](logic-architecture.md)。

---

## 七、事件系统

### 7.1 设计原则

- `step()` 返回本帧所有产生的事件，**不使用 callback/EventEmitter**。
- 事件仅描述"发生了什么"，客户端根据事件驱动视觉表现，不持有任何逻辑状态。
- 所有坐标字段为定点数（`_fp`），客户端除以 1000 转 float 后使用。

### 7.2 事件类型定义

```typescript
export type GameEvent =
  // ── 单位生命周期 ──────────────────────────────────
  | { type: 'unit_spawned';
      unitId: number; owner: 0 | 1;
      unitType: UnitType;
      col: number; y_fp: number; radius_fp: number }

  | { type: 'unit_died';
      unitId: number; pos: Vec2_fp }

  // ── 单位移动 ──────────────────────────────────────
  | { type: 'unit_move_start';
      unitId: number;
      from: Vec2_fp;
      to: Vec2_fp;        // 当前预计停止点（敌方单位/建筑/横移行入口）
      speed_fp: number }

  | { type: 'unit_move_stop';
      unitId: number;
      pos: Vec2_fp }      // 精确停止位置，客户端用于纠偏

  // ── 战斗 ──────────────────────────────────────────
  | { type: 'unit_attack_start';
      unitId: number; targetId: number }

  | { type: 'unit_attack_hit';
      unitId: number; targetId: number;
      damage: number; targetHpRemaining: number }

  // ── 建筑 ──────────────────────────────────────────
  | { type: 'building_placed';
      buildingId: number; owner: 0 | 1;
      buildingType: BuildingType;
      col: number; row: number }

  | { type: 'building_hp_changed';
      buildingId: number;
      hp: number; maxHp: number }

  | { type: 'building_destroyed';
      buildingId: number; col: number; row: number }

  | { type: 'building_spawned_unit';
      buildingId: number; unitId: number }  // 兵营产兵

  // ── 法术 ──────────────────────────────────────────
  | { type: 'spell_cast';
      spellType: SpellType; owner: 0 | 1;
      center: Vec2_fp }

  // ── 基地 ──────────────────────────────────────────
  | { type: 'base_hp_changed';
      owner: 0 | 1;
      hp: number; maxHp: number }

  | { type: 'game_over';
      winner: 0 | 1 }

  /** 15 分钟时触发一次，提示 2 分钟倒计时开始。 */
  | { type: 'game_countdown_start' }

  /** 17 分钟强制结束，双方平局。 */
  | { type: 'game_draw' }

  // ── 资源 ──────────────────────────────────────────
  | { type: 'resource_changed';
      owner: 0 | 1;
      coins: number }

  // ── 手牌 ──────────────────────────────────────────
  | { type: 'card_drawn';
      owner: 0 | 1; cardType: CardType; handIndex: number;
      /** 本张牌的自动刷新倒计时总长（ticks），客户端据此驱动橡皮擦动效 */
      refreshDurationTicks: number }

  | { type: 'card_played';
      owner: 0 | 1; handIndex: number }

  | { type: 'card_expired';
      /** 30 秒未使用，逻辑层自动刷新，紧接着会发出新的 card_drawn */
      owner: 0 | 1; handIndex: number }

  // ── 结算统计 ──────────────────────────────────────
  | { type: 'game_stats';
      /** game_over / game_draw 同帧发出 */
      stats: [PlayerStats, PlayerStats];
      /** 比赛级摘要，供复合星级评分（STAR_SCORING.md）。不进 PlayerStats/matchStateHash */
      summary: MatchSummary /* { elapsedTicks, enemyLeaks, escortMinHpPct } */ }
```

### 7.3 移动事件与客户端 tween 的协作

```
逻辑层                          客户端
──────────────────────────────────────────────────────
unit_move_start { from, to, speed_fp }
                               ──▶ 开始从 from tween 到 to
                                   速度 = speed_fp / 1000 格/s

（前方友军突然停下）
unit_move_stop { pos }
                               ──▶ 停止 tween，snap 到 pos

（前方友军恢复移动）
unit_move_start { from, to, speed_fp }
                               ──▶ 从 pos 重新 tween 到新 to

（敌方进入射程）
unit_move_stop { pos }
unit_attack_start { targetId }
                               ──▶ 停止移动，播放攻击动画
```

`to` 是当前时刻预计停止点，不保证单位一定能走到——若中途状态变化，会先发 `unit_move_stop`，再发新的 `unit_move_start` 或其他事件。客户端以最后收到的 `unit_move_stop.pos` 作为可信位置基准。

---

## 八、指令系统

### 8.1 绑定规则

每条指令绑定到具体 tick 编号，`step(tick, commands)` 在本帧逻辑开始前先消费该 tick 的所有指令。

```typescript
export type PlayerCommand =
  | { type: 'play_card';
      owner: 0 | 1;
      tick: number;
      handIndex: number;
      // 兵种卡
      col?: number;
      // 建筑卡
      row?: number;
      // 法术卡
      targetCol?: number; targetRow?: number }

  | { type: 'upgrade_base';
      owner: 0 | 1;
      tick: number }
```

### 8.2 step() 执行顺序

```
step(tick, commands):
  1. 初始事件（首帧：card_drawn × 手牌数、resource_changed × 2）
  2. AI 决策 + 外部指令过滤（仅消费 tick 匹配的指令）
  3. processCommand（出牌、升级基地）
  4. ResourceSystem（金币产出，检测上限）
     · 0–3 min   ×1.0（33 fp/(coin/s)/tick）
     · 3–6 min   ×1.5（50 fp/(coin/s)/tick）
     · 6–10 min  ×2.0（66 fp/(coin/s)/tick）
     · 10 min+   ×4.0（133 fp/(coin/s)/tick）
  5. BuildingProductionSystem（兵营产兵、箭塔攻击计时）
  6. CombatSystem（攻击结算，读 elapsedTicks 决定是否应用 ×2 攻击倍率）
     · ≥ 13 min（23400 ticks）：所有伤害 ×2
  7. MovementSystem（前进、碰撞检测、横移）
  8. SpellSystem（持续效果倒计时、到期移除）
  9. checkWinCondition
     · 任一基地 HP=0 → game_over
     · ≥ 17 min（30600 ticks）→ game_draw
     · ≥ 15 min（27000 ticks）且尚未触发 → game_countdown_start（仅一次）
  10. 返回本帧产生的 events[]
```

---

## 九、录像格式

只记录有指令的 tick，回放时将空帧视为空指令列表：

```typescript
interface ReplayFrame {
  tick: number;
  commands: PlayerCommand[];
}

interface Replay {
  seed: number;
  frames: ReplayFrame[];  // 只含非空帧
}
```

回放验证：用相同 seed 和指令序列重新执行所有 `step()`，对比每帧产生的 events，可检测确定性是否成立。

---

## 十、AI 对手

AI 模块位于 `game-logic/src/ai/`，对客户端不可见。接口为：

```typescript
// 内部接口，不导出
interface IAIPlayer {
  decideTick(tick: number, gameState: InternalGameState): PlayerCommand[];
}
```

AI 读取内部游戏状态（`InternalGameState`，逻辑层内部类型），生成 `PlayerCommand[]` 注入到下一帧的 `commands` 参数中。客户端无需感知对手是 AI 还是真人。

---

## 十一、联机扩展路径

MVP 阶段（单机 AI 对战）：

```
Client ──step(tick, [playerCmd, aiCmd])──▶ GameEngine
```

联机阶段（帧同步）：

```
Client A ──playerCmd──▶ Server ──broadcast (tick, [cmdA, cmdB])──▶ Client A & B
                                                                  各自调 step()
```

逻辑层代码不需要修改。服务端可运行同一份 `game-logic` 包进行权威校验。断线重连通过"关键帧快照 + 后续指令重放"实现。

---

---

## 十二、手牌刷新计时器

手牌计时器在逻辑层维护，保证录像可完整重放。

```typescript
// 内部，每个手牌槽一个计时器
interface HandSlot {
  cardType: CardType;
  remainingTicks: number;   // 倒计时，归零时自动刷新
}
```

- 开局抽牌时，每个槽的 `remainingTicks` = `CARD_REFRESH_TICKS`（= 30 × 30 = 900，即 30 秒）加上初始随机偏移（`CARD_REFRESH_INITIAL_OFFSET_MAX = 15 × 30 = 450` ticks，即 0～15 秒）。
- 每 tick 递减。归零时发出 `card_expired`，随即抽新牌发出 `card_drawn`（含新的 `refreshDurationTicks`）。
- 出牌后新抽的牌倒计时从 `CARD_REFRESH_TICKS` 重新开始（无随机偏移）。

---

## 十三、加权抽牌接口（占位）

```typescript
// 内部接口，规则待细化
interface ICardDrawPolicy {
  /** 根据当前游戏阶段和玩家状态，返回下一张牌的类型 */
  draw(tick: number, playerState: InternalPlayerState): CardType;
}
```

MVP 阶段暂用均匀随机实现。后期替换为加权策略（按阶段调整各等级权重、法术独立概率池、基地等级影响）时，只需替换此接口的实现，不改调用方。

---

## 十四、结算统计数据

`game_stats` 与 `game_over` / `game_draw` 同帧发出，包含双方本局统计：

```typescript
interface PlayerStats {
  owner: 0 | 1;
  damageDealtToBase: number;    // 对敌方基地造成的总伤害 → 最佳输出
  damageTakenByBase: number;    // 己方基地承受的总伤害   → 铁壁防线
  unitsSent: number;            // 派出单位总数           → 兵海战术
  unitsKilled: number;          // 消灭敌方单位数         → 以少胜多参考
  spellHits: number;            // 法术命中单位总数        → 精准打击
  buildingSurvivalTicks: number;// 建筑存活 tick 总和     → 建筑大师
  goldSpent: number;            // 消耗金币总量           → 以少胜多参考
}
```

客户端收到 `game_stats` 后根据各字段评定徽章，无需自行从事件流累加。

---

*关联文档：core-gameplay-loop.md、art-direction.md、ui-design.md*
