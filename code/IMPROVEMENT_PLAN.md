# Notebook Wars — 改进计划

> 来源：2026-06-12 全面分析后制定。按优先级分 6 项，逐项推进。
> 完成一项后在此勾选，并按 `CLAUDE.md` 约定把改动同步进 `CLAUDE.md` 已知修复表 / `DESIGN.md`。

## 进度总览

| # | 优先级 | 事项 | 状态 |
|---|---|---|---|
| 1 | 高 | 逻辑内核单测 + 确定性黄金回放测试 | ✅ 完成（33 测试，发现并修复跨实例 ID 不可复现） |
| 2 | 高 | 增强 AI（经济意识 / 防守用陨石 / 威胁评估 / 升级规划） | ☐ 待办 |
| 3 | 中 | 同步 README（刷新时间 / 端口 / 兵种译名 / 目录结构） | ☐ 待办 |
| 4 | 中 | 完成 Guardian / Archer 骨骼动画接入，去掉占位圆 | ☐ 待办 |
| 5 | 低 | 重构 `GameEngine.processCommand` 重复分支为 helper | ☐ 待办 |
| 6 | 低 | 性能：减少 `MovementSystem` 每帧全量拷贝、线性扫描 | ☐ 待办 |

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

## 3. 同步 README
- 刷新时间 2 分钟 → 30s。
- 端口 8080 → 9090。
- 兵种译名统一（Swordsman/Guardian/Archer 与中文对应）。
- 目录结构去掉已删的 `tools/animation-editor`。

## 4. Guardian / Archer 动画
- 制作/接入对应 `.tao`，`UnitView` 去掉占位圆。
- 受击特效改用挂点 `hit` 坐标。

## 5. 重构 processCommand
- 抽 `consumeCardSlot(player, owner, handIndex)` 收敛六连重复（spend/stats/play/event/draw/resource）。

## 6. 性能
- `MovementSystem.tick` 减少 `Array.from` 双重拷贝。
- 评估单位/列扫描的数据结构优化。
