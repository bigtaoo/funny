# 逻辑层架构文档

版本：v0.1  
状态：草稿  
适用范围：game-logic 包的实现规范，以及与 game-client 的交互约定

---

## 一、设计目标

1. **确定性**：相同的初始状态 + 相同的指令序列，在任意客户端/服务端上运行结果完全一致。
2. **平台无关**：逻辑层无任何浏览器 API 依赖，可在 Node.js 环境独立运行，用于测试、AI、服务端校验。
3. **封装边界**：客户端只能通过导出的 `.d.ts` 文件与逻辑层交互，内部实现类（`Unit`、`Grid` 等）对客户端不可见。
4. **联机预留**：`step()` 驱动模型天然兼容帧同步，MVP 阶段替换 AI 指令为网络指令即可接入联机。

---

## 二、包结构

```
packages/
  game-logic/              # 纯 TypeScript，零浏览器依赖
    src/
      engine/              # GameEngine 实现
      units/               # Unit、Building 等内部类
      commands/            # PlayerCommand 定义
      events/              # GameEvent 定义
      math/                # Fixed-point 工具
      ai/                  # AI 对手（生成 PlayerCommand[]）
    index.ts               # 唯一公开出口
    tsconfig.json

  game-client/             # React / Canvas 渲染层
    src/
      ...
    tsconfig.json          # paths 指向 game-logic/dist/index.d.ts
                           # 排除 game-logic/src，TypeScript 层物理隔离
```

`game-client` 的 `tsconfig.json` 中通过 `paths` 将 `game-logic` 映射到其编译产物的 `.d.ts`，而非源码，确保客户端代码无法访问未导出的内部类。

---

## 三、公开 API（index.ts 导出内容）

```typescript
// 工厂函数，唯一创建入口
export function createGameEngine(config: GameConfig): IGameEngine;

// 主接口
export interface IGameEngine {
  /** 推进一帧，返回本帧产生的所有事件 */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[];
}

// 配置
export interface GameConfig {
  seed: number;           // PRNG 种子，用于洗牌
  players: [PlayerConfig, PlayerConfig];
}

export interface PlayerConfig {
  id: 0 | 1;
}

// 指令与事件（见后续章节）
export type PlayerCommand = /* ... */;
export type GameEvent = /* ... */;

// 坐标（定点数，客户端除以 1000 转 float）
export interface Vec2_fp {
  x: number;  // 列内固定，= 列中心 * 1000
  y: number;  // 连续位置，单位 = 格 * 1000
}
```

内部实现类（`GameEngineImpl`、`Unit`、`ColumnList` 等）不出现在 `index.ts`，编译产物的 `.d.ts` 中自然不含这些符号。

---

## 四、定点数规范

### 4.1 基本约定

| 规则 | 说明 |
|---|---|
| Scale | × 1000，即 1 格 = 1000_fp |
| 存储类型 | `number`（JS 整数，避免浮点） |
| 命名后缀 | 所有逻辑层定点变量加 `_fp` 后缀 |
| 禁止使用 | `Math.random()`、`Date.now()`、任何浮点运算 |

### 4.2 常见数值对照

| 游戏量 | 浮点值 | 定点值 |
|---|---|---|
| 普通兵移速 | 1.0 格/s | 1000_fp / s |
| 盾兵移速 | 0.6 格/s | 600_fp / s |
| 弓箭兵射程 | 3 格 | 3000_fp |
| tick 步长 | 1/30 s | dt = 33_fp（≈ 1000/30，整数截断） |

> **注**：1000/30 = 33.33…，截断为 33_fp，每秒误差 1_fp（0.001 格）。所有客户端截断方式相同，误差一致，不影响确定性。

### 4.3 乘法防溢出

定点乘法需先除以 scale，避免数值爆炸：

```typescript
// 正确：位移 = 速度 × dt
const dy_fp = (speed_fp * dt_fp) / 1000;

// 错误：直接相乘，数值会爆炸
const dy_fp = speed_fp * dt_fp;
```

### 4.4 PRNG（确定性随机）

使用 xoshiro128++ 或简单 LCG，seed 由 `GameConfig.seed` 传入。禁止调用 `Math.random()`。用途：洗牌（生成牌池顺序）。

---

## 五、坐标系

```
y 增大方向 = 向上（向敌方基地）

行 0  ──── 玩家 0 基地行（己方底部）
行 1  ────── 玩家 0 建筑行
行 2..16 ── 战斗区
行 16 ──── 玩家 1 建筑行
行 17 ──── 玩家 1 基地行

列 0..7（共 8 列）
列 0,1,2   左侧进攻路线
列 3,4     基地列（不作为进攻路线）
列 5,6,7   右侧进攻路线
```

- 玩家 0 的单位 y 从 0 增大，向行 17 推进。
- 玩家 1 的单位 y 从 17000_fp 减小，向行 0 推进。
- 横移区为行 0（玩家 1 单位抵达后横移）和行 17（玩家 0 单位抵达后横移），单位在横移区切换为 x 轴移动。

---

## 六、单位运动模型

### 6.1 连续位置

单位位置为**列内连续坐标**，不强制居中于格子。每个单位持有：

```typescript
// 内部
class Unit {
  col: number;          // 所在列，整数，固定
  y_fp: number;         // 列内连续 y 坐标（定点）
  radius_fp: number;    // 碰撞半径（定点）
  speed_fp: number;     // 当前移速（定点）
  state: UnitState;     // 移动状态机
  // ...
}
```

### 6.2 碰撞半径

单位半径决定两单位的最小间距：

| 单位 | radius_fp | 一格容量 |
|---|---|---|
| 普通兵（Swordsman） | 400 | 1 个/格（400×2=800，接近 1000） |
| 盾兵（Guardian） | 450 | 1 个/格 |
| 弓箭兵（Archer） | 350 | 1 个/格 |
| 兵营产出的自动普通兵 | 300 | 约 1.6 个/格，即最多 1 个排队时可很近 |

两单位不发生重叠的条件（同列，A 在 B 前方）：

```
B.y_fp - B.radius_fp - (A.y_fp + A.radius_fp) >= 0
```

### 6.3 每列数据结构

每列维护一个按 `y_fp` 升序排列的单位列表。增删单位时保持有序。碰撞检测只需比较列表中相邻单位，时间复杂度 O(1)。

### 6.4 单位移动状态机

```
         spawn
           │
           ▼
        [InLane]  ──── 到达横移行 ────▶  [Crossing]
           │                                  │
    遇到敌方单位/建筑                   到达基地列
           │                                  │
           ▼                                  ▼
       [Fighting]                        [AtBase]
           │
        目标消灭
           │
           ▼
        [InLane]
```

- **InLane**：沿列垂直移动，检测前方碰撞（友方排队）和攻击范围（敌方）。
- **Crossing**：已进入横移行，沿 x 轴向基地列（列 3/4）移动。
- **Fighting**：停止移动，执行攻击循环。目标消灭后回到 InLane。
- **AtBase**：到达基地列，对基地造成伤害，单位随即消失。

### 6.5 每 tick 移动更新流程

```
for each column:
  sort units by y_fp (ascending for player 0)
  for each unit (front to back):
    if state == InLane:
      new_y = y_fp + direction * (speed_fp * dt_fp / 1000)
      check enemy in attack range → enter Fighting, emit events
      check front unit collision  → clamp y, stop if blocked
      if y crosses crossing threshold → enter Crossing
    if state == Crossing:
      move along x axis toward base column
      if reached base column → AtBase, deal damage, despawn
```

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

  | { type: 'building_destroyed';
      buildingId: number; pos: Vec2_fp }

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
      owner: 0 | 1; cardType: CardType; handIndex: number }

  | { type: 'card_played';
      owner: 0 | 1; handIndex: number }
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

*关联文档：core-gameplay-loop.md、art-direction.md*
