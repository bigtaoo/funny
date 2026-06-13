# Notebook Wars — 改进计划

> 来源：2026-06-12 全面分析后制定。按优先级分 6 项，逐项推进。
> 完成一项后在此勾选，并按 `../../CLAUDE.md` 约定把改动同步进 `../../CLAUDE.md` 已知修复表 / `DESIGN.md`。

## 进度总览

| # | 优先级 | 事项 | 状态 |
|---|---|---|---|
| 1 | 高 | 逻辑内核单测 + 确定性黄金回放测试 | ✅ 完成（33 测试，发现并修复跨实例 ID 不可复现） |
| 2 | 高 | 增强 AI（经济意识 / 防守用陨石 / 威胁评估 / 升级规划） | ✅ 完成（威胁评估 + 三段式决策 + 难度分级 + 5 测试） |
| 3 | 中 | 同步 README（刷新时间 / 端口 / 兵种译名 / 目录结构） | ✅ 完成 |
| 4 | 中 | 完成 Guardian / Archer 骨骼动画接入，去掉占位圆 | ☐ 待办 |
| 5 | 低 | 重构 `GameEngine.processCommand` 重复分支为 helper | ✅ 完成（抽 `consumeCardSlot` + 闭包 effect，事件顺序不变） |
| 6 | 低 | 性能：减少 `MovementSystem` 每帧全量拷贝、线性扫描 | ✅ 完成（去掉每帧 Array.from 快照 + 扫描过滤排序） |

---

## 1. 逻辑内核单测 + 确定性黄金回放测试（进行中）

**目标**：守护项目最大资产——确定性内核。给定 seed，整局可复现。

**方案**：
- 引入 Vitest（TS 原生、零配置、不污染 webpack 构建）。
- 单元测试：
  - `math/fixed.ts`：定点运算、各档回速整数公式。
  - `math/prng.ts`：同 seed 序列可复现、跨实例独立。
  - `ResourceSystem`：各加速档金币回速、上限 `COIN_CAP`、升级 bonus。
  - `MovementSystem`：纵向推进、友军半径碰撞回退、Crossing 横穿、`crossingBlocked` 滞回。
  - `CombatSystem`：箭塔 Chebyshev 全向寻敌、单位攻击间隔、死亡移除。
- **黄金回放测试**：固定 seed 跑 N tick，断言终局状态快照（基地 HP / 单位数 / 胜负），锁死确定性，防回归。

**约束**：测试只依赖 `src/game/`（纯 TS，无 PIXI），不引入渲染层。

### ✅ 完成记录（2026-06-12）

- 引入 **Vitest 2.1.9**；`vitest.config.ts` 限定 `test/**/*.test.ts`，不污染 webpack 构建。
- `npm test` / `npm run test:watch` 脚本。
- 5 个测试文件，**33 个用例全绿**：
  - `test/math.test.ts`：fixed-point 截断语义 + Prng 复现/独立/置换。
  - `test/ResourceSystem.test.ts`：各档回速、`COIN_CAP`、升级 bonus、事件去抖。
  - `test/MovementSystem.test.ts`：纵向推进步长、Crossing、抵达基地伤害+despawn、友军碰撞不重叠/Waiting 滞回。
  - `test/CombatSystem.test.ts`：近战命中、冷却、击杀移除+计分、晚期攻击翻倍、箭塔 Chebyshev 横向命中、超出射程不打。
  - `test/replay-determinism.test.ts`：同 seed 两次运行**结构全等**（黄金回放），异 seed 发散，长局活跃度 sanity。
- **测试发现的真缺陷并已修复**：`Unit`/`Building` 的模块级全局 `nextId` 计数器导致**跨 engine 实例 ID 不可复现**，破坏 replay。新增 `resetUnitIds()`/`resetBuildingIds()`，在 `GameState` 构造时调用 → 每局 ID 从固定基址开始，回放可复现。
- **ID 命名空间隐患已彻底解决**：原 unit 从 0 / building 从 1000，超长局单位 ID 会涨进建筑区间。已**调换为 building 从 0、unit 从 1000**——建筑数受棋盘格（216）封顶永远 <1000，单位取上段无论多长都不撞车。已确认渲染层按事件类型分池、不依赖 ID 区间。

---

## 2. 增强 AI

**目标**：让单机对局耐打，支撑"策略性"。

**计划**：在 `AISystem` 引入：
- 经济意识：不无脑出第一张，按性价比/局势选牌，攒钱升级基地。
- 防守：己方某列被压制时优先放箭塔 / 用陨石清团。
- 威胁评估：评估各 lane 敌军推进度，优先增援/拦截。
- 难度分级（可选）：easy / medium / hard。

### ✅ 完成记录（2026-06-12）

`AISystem` 由"无脑出第一张可用牌"重写为**威胁驱动的三段式决策**（详见 `DESIGN.md` §13）：

- **威胁评估**：`computeThreatByCol` 按敌军 row 接近 AI 基地（row 17）的程度加权出每列威胁；`countNearBaseEnemies` 统计进入危险区的敌军。
- **紧急防守**：基地受压时优先陨石清近基地敌群 → 在威胁最高车道放箭塔 → Guardian 肉盾拦截。
- **经济意识**：不再盲出手牌首张，按偏好顺序（Swordsman→Archer→Guardian）挑性价比牌、推防守最弱车道；早期在安全车道补兵营维持出兵流。
- **升级规划**：安全且 `nextUpgradeCost ≤ COIN_CAP` 时升级 / 攒钱。配套把 `COIN_CAP` 从 30 调到 **300**（≥ 首档升级费 50），让升级对人机双方都**可达**；`upgradeReachable` 守卫保留为防御性代码（费用若再超过上限会自动跳过）。
- **难度分级**：`'easy' | 'medium' | 'hard'`（默认 medium，`GameEngine` 暂用默认值），分别调 think 间隔 / 反应距离 / 是否用陨石箭塔兵营。
- **测试**：新增 `test/AISystem.test.ts`（5 用例），全套 38 测试通过；黄金回放确定性不变（AI 仅依赖 state + 注入 Prng）。

---

## 3. 同步 README
- 刷新时间 2 分钟 → 30s。
- 端口 8080 → 9090。
- 兵种译名统一（Swordsman/Guardian/Archer 与中文对应）。
- 目录结构去掉已删的 `tools/animation-editor`。

### ✅ 完成记录（2026-06-12）

核对真实代码后改 `../../README.md`（根目录，仓库唯一非 node_modules README）：

- **刷新时间**：2 分钟 → **30 秒**（`config.ts` `CARD_REFRESH_TICKS=900`）。
- **端口**：8080 → **9090**（`package.json` 的 `start` 脚本用 `--port 9090` 覆盖了 `webpack.config.js` 的 8080；以脚本为准）。
- **兵种译名**：补英文名映射——普通兵 Swordsman / 盾兵 Guardian / 弓箭兵 Archer（与 `i18n/locales/zh.ts` 的 `card.*` 一致）。
- **目录结构**：删掉早已不存在的 `tools/animation-editor`（`tools/` 实际只有 `animator`）。
- **顺手修的过期信息**：导出格式 JSON → `.tao`（ZIP）且 `StickmanRuntime` 普通兵已接入（非"待接入"）；`AISystem` 一行描述更新为威胁驱动决策。

## 4. Guardian / Archer 动画
- 制作/接入对应 `.tao`，`UnitView` 去掉占位圆。
- 受击特效改用挂点 `hit` 坐标。

## 5. 重构 processCommand
- 抽 `consumeCardSlot(player, owner, handIndex)` 收敛六连重复（spend/stats/play/event/draw/resource）。

### ✅ 完成记录（2026-06-12）

- 抽 `GameEngine.consumeCardSlot(player, owner, handIndex, card, effect)`：统一做「扣金币 → 记 goldSpent → 清手牌槽 → 发 `card_played` → 跑卡牌专属 `effect()` → 补牌 → 发 `resource_changed`」。
- Unit / Building / Haste / Meteor 四个分支只保留各自的**校验**（车道 / 建筑占位 / 陨石坐标）和**专属效果闭包**，重复样板消除（约 -50 行）。
- **事件顺序逐字不变**（spend → card_played → effect 事件 → card_drawn → resource_changed），黄金回放确定性测试通过；闭包内用 `const unitType/buildingType/col/row` 捕获已收窄的值避免 TS 重新放宽类型。
- 全套 38 测试通过，`tsc --noEmit` 干净。

## 6. 性能
- `MovementSystem.tick` 减少 `Array.from` 双重拷贝。
- 评估单位/列扫描的数据结构优化。

### ✅ 完成记录（2026-06-12）

- **去掉每帧快照分配**：`tick()` 原先 `Array.from(board.units.values())` 每帧拷贝整张单位表（仅为在迭代中安全删除）。改为**直接迭代 `board.units` Map**——迭代中唯一的删除是 `moveCrossing` 删**当前**单位（抵达基地），删当前项对 Map 迭代器是良定义的（下一项仍会访问），且本系统从不新增单位。清理 pass 同样直接迭代 Map、删 `isDead`，省掉原来的 `has()` 去重守卫。行为逐字不变（迭代顺序仍是插入序，删除集合一致）。
- **扫描过滤排序**：`getFriendlyUnitAheadInCrossing` 把最具区分度（最便宜）的 `state !== Crossing` 判断提到最前，绝大多数车道单位一步跳过；纯短路顺序优化，结果不变。
- **数据结构评估结论**：前向碰撞热路径已走 Board 的每列有序表 `columnUnits`（O(n_col)），无需改。`predictStopY` / 横穿寻敌仍是全量扫描，但只作用于建筑行少量单位、且 `predictStopY` 仅在 Moving 起始帧触发；为它们建专用索引收益小、却要承担确定性维护风险，故**保留全量扫描**，不引入新索引。
- 全套 38 测试通过（含 `MovementSystem.test.ts` 与黄金回放），`tsc --noEmit` 干净。

---

## 进度小结（2026-06-12）

第 1、2、3、5、6 项已完成。**仅剩第 4 项**（Guardian / Archer 骨骼动画接入）——它依赖美术先用 `tools/animator` 导出对应 `.tao` 资源，代码侧接入点（`UnitView` 去占位圆 + 挂点 `hit` 受击特效）属待办，资源到位后再做。
