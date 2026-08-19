# SLG 承重墙系统规格 — 围攻 / 视野 / 险地 / 多 shard（§16、§18–§20）

> 从 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 拆出（2026-08-17，原文件 2011 行）。**小节编号沿用原文，不重新编号**——源码注释里的 `SLG_DESIGN_LOG.md §N` 引用照旧有效。
> 核心设计以 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 为准；分册总览见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)。
> 本册是**当前状态的系统规格**（G3 围攻、G5 视野迷雾、G8 险地、G6 多 shard 调度），不是流水账；赛季规格另见 [`SLG_LOG_SPEC_SEASON.md`](SLG_LOG_SPEC_SEASON.md)。

---

## 16. G3 围攻重构：预布兵自动战斗（SLG11 承重墙，2026-06-20 拍板）

> 用户拍板（2026-06-20）：**放弃手操**（不符 SLG 异步习惯 + 海量并发：一个玩家可同时进攻 5–6 个目标、到达错峰且常在离线时，逐场手操不可承受；且手操会用手速稀释「SLG=卖战力」定位）。关键围攻 = **双方预布兵的确定性自动战斗**；**服务器跑引擎算权威结果即时落地**，客户端凭 `seed + 双方布阵` 本地重播观战。本节是重构基准与分片计划，作废上一版「延迟落地/judge 复算/手操复盘」方案。

### 16.1 战斗模型（锁定）

- **兵力 = 单位血量（HP）**：每兵种按等级有满血容量（如 L3 盾兵 = 100）；布兵时给某单位分配 X 兵 → 它以 X 血出战（X ≤ 满血容量）；一支军队各单位分配之和 ≤ 携带兵力（行军预算）。**伤害**由兵种/等级定、**v1 不随兵力缩放**（兵力只决定耐久）。战后**残存血量折回兵力池**，阵亡兵力**永久损失** → 靠地图资源重新练兵（兑现资源 sink 闭环：资源→练兵→战损→再练）。
- **双方各有基地，破敌基地者胜**（沿用现有 `objective: destroy_base`）；**超时 / 同归于尽（双基地皆存）→ 进攻方负**（防守占优；含「两单位互射同归于尽、基地皆存」的特例）。
- **复用现有 12×18 双基地引擎**（PvP/campaign/netplay 同款）；唯一战斗改动 = 攻方从「实时出牌」改「开局预布兵」（攻方下半场预布、首 tick 起步推进，与防守方 garrison 同机制）。无 waves、无 live 指令 → 战斗由 `seed + 双方布阵` 唯一确定。

### 16.2 队伍与布阵（锁定）

- **5 支队伍**（前期上限）= 5 个可保存的**进攻布阵模板** + **并发上限**。点队伍直接进布阵编辑器；出征挂一支队，committed 兵力从池扣除，队伍占用至回师。
- **防守布阵**：点地图格 → 「布阵」选项 → 进该领地布阵编辑器；**可在任意盟军领地布阵**（互助协防，§4「代守」）。
- **布阵编辑器**：DefenseEditorScene 推广为通用半场布兵 UI（攻方半场 = 进攻队伍；守方半场 = 领地防守）；调色板取**已收集兵种**（U8）+ 每单位兵力分配滑杆（≤ 满血容量，总和 ≤ 预算）。

### 16.3 战斗接入与权威

- **Battle level** = 攻方预布军（下半场 owner0）+ 守方预布军（上半场 owner1，沿用 garrison）+ 双方基地 + `objective:destroy_base` + **时间上限**（DRAFT ~10min 游戏时间，安全网 + 算力封顶）。
- **worldsvc 跑引擎**（M12 §14.1「裁判」例外，设计允许）：import 确定性引擎 headless 跑到终局 → 权威胜负 + 真实残存血量 → `landSiege`（G3-1 已抽出）即时落地。代价 = worldsvc 绑 `engineVersion`（U9，赛季中途升级须 pin）。
- **算力**：单场约几千 tick、几十实体 ≈ 10–100ms CPU，可忽略；规模化用队列/worker 节流。
- **客户端**：收 `siege_result` + `seed + 双方布阵` → `ReplayInputSource` 本地重播观战（非权威，纯演出）。

### 16.4 分片（可独立验收）

- **G3-1 落地逻辑抽取（纯重构）✅（2026-06-20）**：`applySiege` 的写库块抽成 `landSiege(m, pw, target, defenderId, defender, res, t)`，行为零变化、e2e 全绿。judge/兜底/引擎三路共用此唯一落地点。
- **G3-2a shared + 引擎 ✅（2026-06-21）**：army layout schema（`GarrisonEntry.initialHp` 复用于攻守两军 + `LevelDefinition.attackerArmy`/`battleTimeoutTicks`，`levelSchema` 校验）；troops=HP（`Unit` 构造 `this.hp = min(initialHp ?? 满血, 满血)`，maxHp 恒为蓝图满血）；`buildSiegeBattle`（shared/slg.ts，**复用 `buildSiegeLevel` 守方规整 + 叠攻方军 + `battleTimeoutTicks`**；`buildSiegeLevel` 暂留供 worldsvc，G3-2b 再切换以守「不碰 worldsvc」）；引擎镜像 garrison 初始化到 `attackerArmy`（owner0/Bottom，首 tick spawn+move 向 `TOP_BUILDING_ROW`）+ 超时双基皆存判 owner1（防守方）胜；headless 跑通；**确定性 battle 单测**（`client/test/siege-battle.test.ts`：同布阵 + seed → 逐 tick 双基 HP 序列逐字一致；破基地 / 超时两路胜负；红线不破）。client tsc + 293 测试全绿、server tsc -b shared worldsvc 绿。
- **G3-2b-0 引擎抽包 `@nw/engine` ✅（2026-06-21）**：确定性模拟内核从 `client/src/game` 抽成独立 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式），worldsvc/gateway 直接 import；client 经 webpack alias + tsconfig paths + vitest alias 引 `../server/engine/src`，旧 `client/src/game/*` 留 27 个再导出 shim 保 client/测试逐字不变。详见 §16.7「实现记录」。**这是 G3-2b 的前半截**——做完后 worldsvc 接引擎、gateway 去 peer-judge 那跳自复算都顺理成章。
- **G3-2b worldsvc ✅（2026-06-21）**：承重墙合龙——worldsvc 直接 import `@nw/engine` headless 跑权威围攻。`applySiege` 关键战斗（攻领地/攻主城）改为「跑引擎 → 真实残存折兵力 → `landSiege`」即时落地；非关键 sweep/NPC 维持廉价 `resolveSiege`。详见 §16.8「实现记录」。
- **G3-2c 客户端 ✅（2026-06-21）**：5 队伍布阵编辑器（攻）+ 领地布阵（守，盟军可布）+ 出征挂队 + `seed` 重播观战；i18n。四阶段全落地——Phase 1 服务端+契约 / Phase 2 客户端编辑器+队伍 UI / Phase 3 重播观战改造 / Phase 4 删 judge 死路径，详见 §16.9。
- **删除 ✅（G3-2c Phase 4）**：S8-3b 的录像上传 / `getSiegeDefense` / `resolveSiegeWithJudge` / worldsvc→gateway `judge` 客户端复算路径（手操不再存在，引擎给真实残存）。
- **空闲队伍校验修复 ✅（2026-07-15）**：玩家反馈——配置 5 支队伍后，出征仍固定挂第一支队伍，即使那支队伍已在行军/占领中也照样再派，等同"抢占"而非报错。根因：`combatMarch.ts` 的 `startMarch` 只校验 `teamId` 对应的队伍存在且非空，从未检查该队伍是否已挂在一个非 `recalled` 的行军单（`marches` 集合）或占领倒计时（`occupations` 集合，ADR-037 §5.4）上——两者都是队伍"外出中"的持久化标记（前者行军途中，march 到点即 `findOneAndDelete`；后者胜后进 5 分钟占领倒计时）。修复：新增 `TEAM_BUSY` 错误码，出征前并发查询这两个集合，命中即拒（`server/worldsvc/src/combatMarch.ts`，`teams.e2e.test.ts` 两个新用例覆盖"行军中二次出征被拒→落地后恢复空闲"与"占领倒计时中二次出征被拒→倒计时结束后恢复空闲"）。客户端 `showAttackTeamPicker`（出征选队弹窗，唯一已接线的队伍挑选入口）据同一 `marches`（新增 `MarchView.teamId` 字段随行军单下行）灰显忙碌队伍并提示"行军/占领中"，避免玩家点了也白点。**范围说明**：占地弹窗（`showDeployDialog(...,'occupy')`）仍是纯兵力输入，未接队伍选择（见上文"客户端 UI 待补"一节）——本次只治好了"选中忙碌队伍会怎样"，没有新增占地选队入口。
- **队伍管理"取消指令"（强制回空闲）✅（2026-07-15）**：上一条把忙碌队伍锁死到行军落地/占领倒计时结束，但玩家没有主动解锁的手段——本次补上。行军中：沿用既有 `recallMarch`（撤军，兵力按已耗时间折返、全额退回，非即时——队伍到达原点才真正空闲），只是把入口从地图 HUD 行军列表挪到「队伍管理」（`TeamsScene`）里，与队伍卡片放在一起。占领倒计时中：新增 `cancelOccupation`（`server/worldsvc/src/combatSiege/occupation.ts`），**立即**原地释放队伍（删 `OccupationDoc`，即 `TEAM_BUSY` 门禁查询的同一张表）+ **驻守部队全部作废、不退兵**（与撤军的"全额退兵"刻意不同——没有"归途"可言，直接原地放弃）+ 目标格子的 `contestedBy/contestedUntil/contestedGarrison` 字段清空、退回无主状态（不判给取消者，也不留给任何人捡）。新路由 `POST /world/team/{teamId}/cancel-occupation` + `GET /world/occupations`（客户端此前完全不知道自己的占领倒计时列表，`WorldMapNet.ts` 的忙碌队伍灰显逻辑此前也只查过 `marches`，漏了 `occupations`——顺手一并修复）。`TeamsScene` 每张队伍卡新增状态标签（行军中/占领中剩 Xs）+ 对应按钮；占领的"放弃"按钮是二次确认（先变红瞪眼"确认放弃?"，3 秒内再点一次才真正执行——因为不退兵是不可逆操作），撤军按钮维持原单击（本就全额退兵，风险低）。`teams.e2e.test.ts` 新增用例覆盖：倒计时中途取消→队伍立即可接新单、兵力池不变（未退兵）、格子回到无主、重复取消报错。

### 16.5 数值调参记录（A7，2026-06-22）

**每单位兵力滑杆（DefenseEditorScene）**：

| 常量 | 值 | 含义 |
|---|---|---|
| `SIEGE_UNIT_HP_MIN_FRACTION` | 0.25 | 最低可出 25% 满血（= 省 75% 兵力） |
| `SIEGE_UNIT_HP_STEPS` | 4 | 四档：25% / 50% / 75% / 100% |

攻方布阵编辑器（attack 模式）点击已有同类型单位 → 兵力循环升档（100%→25%→50%→75%→100%...），底部显示 HP 分数条（比例段，占格宽）。守方布阵不暴露滑杆（防守不需要兵力配额管理）。

**Anna 侧三角色 PvP 卡牌（A6 遗留，A7 补录）**：

| 单位 | 卡 id | 费用 | 特性 |
|---|---|---|---|
| Max | max_1 / max_2 | 5 | burstOnSingle（末敌双倍） |
| Lena | lena_1 / lena_2 | 7 | armor 8（高平甲）|
| Mara | mara_1 / mara_2 | 5 | markEnemies（命中标记 +25%，持续 3s）|

六张卡加入 `CARD_DEFINITIONS`；i18n 三语全补（zh/en/de）。

**数值基准（不变约定）**：

- **生还折回**：战后各残存单位 HP 之和回兵力池（封顶 troopCap）；阵亡永久损失。
- **队伍兵力 vs 共享池**：队伍 = 布阵模板（含每单位兵力分配）；出征即从共享池扣 min(模板需求, 可用)；不足默认**拒发**（v1）。
- **伤害不随兵力缩放（v1）**；若平衡需要再议伤害/兵力联动。
- **时间上限**：围攻战斗 10 分钟（`SIEGE_BATTLE_TIMEOUT_TICKS = 10 * 60 * 30`，30 Hz），超时进攻方负。
- **满血容量表**：各兵种以 `UNIT_BLUEPRINTS[type].hp` 为满血，`SIEGE_UNIT_HP_MIN_FRACTION=0.25` 四档递增；险地/首府系统默认布阵沿用 §3.3「按等级派生」。
- **僵局兜底**：时间上限 + 超时攻方负（全盾兵 DPS≈0 等极端情形）。

**SLG DRAFT 数值拍板（§14.10 U6/U7，2026-06-22 拍板）**：

| 常量 | 值 | 说明 |
|---|---|---|
| `NATION_BONUS_PRODUCTION` | **0.10**（+10%） | 本国 Voronoi 区资源产出加成；适中，不破坏赤裸状态下的经济平衡 |
| `NATION_BONUS_DEFENSE` | **0.15**（+15%） | 本国 Voronoi 区防御 HP 加成；实战中约等于守军多出 1–2 单位，有感 |
| `SECT_FOUND_PROSPERITY_MIN` | **2000** | 建宗门繁荣度门槛；30人+30地≈1800基础，需约40活跃点（可达但有门槛） |
| `GARRISON_PER_TILE` | **500** | 每格驻军兵力（S8-1 拍板不变） |
| `SIEGE_CHEAP_RATIO` | **10** | 攻方兵力/守方有效驻军 ≥ 10 时跳过引擎走廉价 `resolveSiege`；U7「100:1 极端碾压」对应实际安全下限 |
| `SIEGE_BATTLE_TIMEOUT_TICKS` | **18000**（10 min） | 围攻硬时限；超时防守方胜（防守占优原则） |

`shared/slg.ts` 已同步（DRAFT 注释去除；`SIEGE_CHEAP_RATIO` 新增）。

### 16.6 引擎落地锚点（G3-2a 实现指引，2026-06-20 探查）

> 已摸清确定性引擎现状（`client/src/game/`，纯 TS 无 PIXI），G3-2a 据此实现，新会话不必重新探查。

- **棋盘**（`config.ts:22–39`）：12 列 × 18 行；owner0=下方（基地 row0，spawn row1）、owner1=上方（基地 row17，spawn row16）；战斗区 row2–15；攻击车道 col 0–4 / 7–11，基地列 5–6（不可攻）。
- **garrison 现成可镜像**（`GameEngine.ts:182–212` 构造预布 + `:480–498` 首 tick 发 `unit_spawned`+`unit_move_start`）：防守方（Top）单位已能中场预布 + 自动推进。**攻方预布 = 把这套镜像到 owner0/Bottom 半场**，不新建 director。`GarrisonEntry{unitType,col,row}`（`campaign/LevelDefinition.ts:159–173`）。
- **兵力=血量**：单位 HP 恒取 `blueprint.hp`（`Unit.ts:145–170`，`UNIT_BLUEPRINTS` in `config.ts:131–257`），无覆写口。→ 给布兵项加 `initialHp?`，构造改 `this.hp = initialHp ?? blueprint.hp`，其余战斗逻辑不动。
- **模式分支**（`GameEngine.ts:118–130`）：siege→`buildSiegeBlueprints(pveUpgrades)`；攻方现为 live 出牌（`:540–649`），改为预布后**无 live 指令**。
- **胜负判定**（`GameEngine.ts:750–867`）：先判 Bottom 基地 HP≤0→Top 胜；`destroy_base` 可带 `durationTicks` 超时。**改动点**：加战斗时限 → 超时（双基地皆存）判 owner1（防守方）胜。
- **headless 跑法现成**（`net/judgeRunner.ts:44–69,119–153`：`createGameEngine(config, ReplayInputSource)` + `while phase!==GameOver tick(1/30)`）：双方纯预布、喂空输入源跑到终局取 `winnerSide`。`maxTicks` 兜底防死循环。
- **不可破的确定性护栏**：`buildPvpBlueprints()` 无养成参签名（编译期硬墙，`test/hardwall.test.ts`）；PRNG 注入（`math/prng.ts`，三 seed XOR）；定点数 `Fp`（`math/fixed.ts`）；实体 ID 重置（`Unit.ts:7–17`/`Building.ts:8–17`，每局 reset）；金回放/`siege.test.ts` 确定性。

**G3-2a 改动清单**：①`LevelDefinition.ts` `GarrisonEntry.initialHp?` + `attackerArmy?: GarrisonEntry[]` + `battleTimeoutTicks?`；②`GameEngine.ts` 镜像 garrison 初始化到 `attackerArmy`（owner0，首 tick spawn+move）+ spawn 套 `initialHp` + 超时判防守胜；③`shared/slg.ts` `buildSiegeLevel`→`buildSiegeBattle`（双军+双基地+timeout）；④`levelSchema` 校验新字段；⑤`client/test` 确定性 battle 单测（同布阵+seed→同终局；破基地/超时两路；硬墙不破）。**只动引擎+shared+单测，不碰 worldsvc/客户端**（G3-2b/2c）。

### 16.7 引擎抽包 `@nw/engine`（G3-2b-0 设计，2026-06-21 拍板）

> **背景探查（2026-06-21）**：确认现状——确定性引擎只存在于 `client/src/game` 一份；服务端**无引擎副本**，worldsvc 围攻走 `@nw/shared` 的廉价公式 `resolveSiege`，gateway 的 `/gw/judge` 靠 **peer-judge**（挑在线玩家客户端跑 `judgeRunner` 回报 hash），引擎从不在服务端进程内运行。client 与 server **零代码共享**（手抄镜像 + openapi/proto codegen 对齐，client tsconfig 无 `paths`、webpack 无 `alias`）。引擎是最吃「两端逐字一致」（确定性）的逻辑，手抄镜像在此是定时炸弹 → 抽成单一来源包。

**目标**：worldsvc / gateway 能像 import `@nw/shared` 一样 import 引擎，headless 跑权威围攻 / 自复算比赛；从根上杜绝「未来出现第二份引擎」的确定性裂缝。

**方案：新 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式）**
- **服务端消费**：worldsvc / gateway 加 `"@nw/engine": "*"` 依赖，`tsc -b` 项目引用，CJS dist。零新机制。
- **客户端消费**：client 是独立 webpack 项目（无 workspace），经 **webpack alias + tsconfig `paths`** 把 `@nw/engine` 指向 `../server/engine/src`，ts-loader 直编源码进 bundle（不依赖 engine 的 CJS dist）。这是 client 的**首个跨边界桥**，net-new 但很小。

**边界划线（什么进包）**

| 进 `@nw/engine` | 留在 client |
|---|---|
| `config` / `math/*`（`fixed`/`prng`）/ `Card` | `meta/*`（SaveManager/SaveStore/ReplayStore 持久化） |
| `GameEngine` / `GameState` / `Unit`/`Building`/`Player`/`EscortUnit` | `net/NetInputSource`（联机传输，依赖 proto） |
| `systems/*` / `campaign/WaveDirector` / `LevelDefinition` + `levelSchema` | `campaign/maps/ChapterMap`（UI/i18n） |
| `balance/pveUpgrades`（三套 blueprints，**含天梯红线**）| `i18n` 本体；PIXI 渲染层全部 |
| `net/InputSource`（Local/Replay/Recording，纯逻辑）| `judgeRunner` 的 proto 解码外壳 |
| **新增 `runHeadless(seed, level, frames, source)`**（从 `judgeRunner` 抽出的引擎跑动核心）| — |

> `runHeadless` 吃**已解码输入**，proto 解码留各调用方边缘（client / gateway / worldsvc 各自把自己的 proto frames 解成统一形状再喂）——这就是让 **gateway 自复算** 与 **worldsvc 权威跑** 共用一条引擎路径的关键。

**三个已知坑**
1. **strict 不一致**：server base 开 `noUncheckedIndexedAccess` / `noImplicitOverride`，比 client 严。引擎进 server 包要清掉新报的索引/override 错（可能几十处）。**拍板：清干净**（引擎是命根子代码，不给 engine 包开宽松特例）。
2. **`TranslationKey` 外泄**：`types.ts` / `LevelDefinition.ts` type-only 引 `../i18n` 的 `TranslationKey` → engine 内降级为 `string`（显示用 key，模拟不关心），i18n 校验留 client。
3. **`engineVersion` pin（U9）**：engine 包打版本号常量，worldsvc 跑围攻 / 录像复算时校验，赛季中途升引擎须 pin。抽包时落进 `@nw/engine` 导出。

**验收**：`@nw/engine` 建包 + 迁移 + strict 清理后 → server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + 现有 293 测试（含 `siege-battle.test.ts` / 硬墙 / 金回放确定性）全绿 + `build:web` 通过——**测试逐字不变全绿 = 抽包行为零变化的证明**。完成后方启 G3-2b（worldsvc 接引擎）。

**实现记录（2026-06-21 落地）**
- **包**：`server/engine/`（`@nw/engine`，`package.json` + `tsconfig.json` composite/CJS dist，加入 `server/package.json` workspaces 第二位）。`server/engine/src/index.ts` barrel 导出公共面（`createGameEngine`/`runHeadless`/输入源/类型/枚举/定点工具/`GameState` type/`LevelDefinition` 全族 + `parseLevelDefinition` + `ENGINE_VERSION`），内部类（Unit/Building/Board/GameState 类/Player/EscortUnit）不进 barrel——深层消费（测试）走子路径 shim。
- **迁移**：`git mv` 27 个源文件进 `server/engine/src`（含 `math/` `balance/` `campaign/{LevelDefinition,levelSchema,WaveDirector}` `net/{InputSource,ReplayInputSource}` `systems/*`）。**留 client**：`meta/*`、`net/NetInputSource`、`campaign/{levels.ts+levels/*.json,maps/*,progress.ts}`、`game/index.ts` barrel、`net/judgeRunner.ts`。
- **client 接线**：webpack `resolve.alias`（`@nw/engine$`→`src/index.ts`、`@nw/engine`→`src/`，ts-loader 直编源码进 bundle）；`client/tsconfig.json` 加 `baseUrl`+`paths`（`@nw/engine`/`@nw/engine/*`）、`include` 加 `../server/engine/src/**/*`、**删 `rootDir`**（避免 TS6059 跨 root）；4 份 vitest config 各加 `resolve.alias`（rollup-alias 前缀匹配覆盖裸名 + 子路径）。旧 `client/src/game/<path>.ts` 留一行 `export * from '@nw/engine/<path>'` shim（27 个）→ client 应用代码 + 293 测试 import 逐字不变。
- **三坑**：①strict 实际只新报 5 处（Board `addBuilding`/`removeBuilding` 写格用 `!`、Card `tickTimers` 槽位判 `if(!slot)`、GameEngine `spawnEnemyUnit` laneLen 提取 const 收窄）；②`TranslationKey` 在 engine 两文件改本地 `type TranslationKey = string`，client 11 处消费点（createAppCore×3/GameRenderer/HandView/CollectionScene×2 + Set 改 `Set<string>` 收 2 处/DefenseEditorScene×2）`as TranslationKey` 再收窄；③`ENGINE_VERSION=1` 原就在 `types.ts`，barrel 显式再导出标注 U9 用途。
- **`runHeadless(config,input,maxTicks)`**：`server/engine/src/runHeadless.ts`，吃已解码 `GameConfig`+`InputSource`，建引擎跑 tick 到 GameOver/maxTicks，返回 `{ok,ticks,engine}` 供调用方读 `state.winner`/`snapshotStats()`；proto 解码留各调用方边缘。client `judgeRunner` 三路（netplay/pve/siege）改用之（去三份重复 tick-loop），由 `judge-runner`/`pve-judge` 测试覆盖证明等价。worldsvc 接入是 G3-2b。

### 16.8 worldsvc 接引擎（G3-2b 实现记录，2026-06-21 落地）

> **承重墙合龙**：worldsvc 成为史上第一个在进程内直接 import 确定性引擎、headless 跑权威围攻的服务端（M12「裁判例外」延伸）。关键围攻不再走廉价线性公式，而是双方预布兵确定性自动战斗的真实结果即时落地。

- **新模块 `server/worldsvc/src/siegeEngine.ts`**：
  - `synthesizeArmy(troops, role)`：把扁平兵力数铺成确定性 `GarrisonEntry[]` 布阵——默认步兵（满血 60 = 兵力当量），每单位 `initialHp ≤ 满血`（兵力=血量，§16.1），按 `ATTACK_LANES` 轮转铺开（attacker 从 row 1 升、defender 从 row 16 降）。这是**布阵编辑器（G3-2c）落地前的 v1 桥**：现行数据模型仍存扁平 `march.troops`/`tile.garrison`，编辑器接入后真实布阵从 `tile.defense`/`playerWorld.teams[]` 读，此合成退为「未设布阵」兜底。
  - `runSiegeBattle({attackerArmy,defenderConfig,tileLevel,seed})`：`buildSiegeBattle`（攻军+守军+双基地+时限）→ `parseLevelDefinition` 校验（P2，引擎侧 `levelSchema`）→ `runHeadless` siege 模式跑到终局/时限 → 读 `state.winner` 定胜负、累加 `board.units` 各侧存活 HP 定真实残存兵力 → 返回 `SiegeResolution`。winner=Bottom(owner0)=攻方破基地夺地。
- **`applySiege` 改造**：关键围攻调 `runSiegeBattle`（seed=`siegeSeedFromId(march._id)`，守方布阵 `buildDefenderConfig`——自定义 `tile.defense` 优先、否则按有效守军兵力合成；国民加成 v1 只作用合成路径）；坏布阵/引擎异常 try/catch 兜底回退廉价 `resolveSiege`，绝不卡死行军。`landSiege`（G3-1 唯一落地点）行为不变，新增 defender_win 时攻方残存撤退折回兵力池（§16.5；廉价兜底 survivors=0 时天然无回师）。**非关键 `applySweep`（NPC 扫荡）仍走廉价 `resolveSiege`**（§5.3）。
- **引擎侧两处小改**：①`@nw/engine` barrel 增导 `UNIT_BLUEPRINTS`/`ATTACK_LANES`/`BOARD_*`/`BOTTOM_SPAWN_ROW`/`TOP_SPAWN_ROW`/`UnitBlueprint`，让 worldsvc 合成布阵读「与引擎模拟同源」的棋盘几何 + 兵种 HP（不抄常量）；②`levelSchema.parseWaves` 放宽——siege 战斗（含 `attackerArmy`/`battleTimeoutTicks`）为纯预布无脚本波次，允许空 `waves.entries`（战役关仍要求 ≥1 波）。
- **engineVersion pin（U9）**：`runSiegeBattle` 喂 `ReplayInputSource` 空帧（纯预布无 live 指令），其构造按 `ENGINE_VERSION` 校验；worldsvc 随引擎版本重构建（D0+P2 代价）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` + 293 测试全绿（levelSchema 放宽不破金回放/硬墙/确定性）；worldsvc e2e（`siege.e2e` 6 + `nation-bonus.e2e` 4）改断言为「方向+结构效应」（易主/残存>0/减员）并按引擎真实断点重校准国民加成用例（同 march seed 下 820 兵破 500 守军、破不了加成后 575 → 反证加成来自国籍），全绿。引擎单场约几千 tick≈10–100ms CPU（§16.3）。
- **未尽（移交 G3-2c）**：①布阵编辑器写真实 `tile.defense`/`playerWorld.teams[]` 取代 `synthesizeArmy` 兜底；②自定义布阵的国民加成；③客户端 `seed+双方布阵` 重播观战（`siege_result` 带 seed/布阵）；④删 S8-3b 残留 judge/peer 复算路径（`resolveSiegeWithJudge`/`getSiegeDefense` 等，手操方案作废后无调用方时清理）。

### 16.9 G3-2c：闭合围攻闭环（分四阶段，2026-06-21 起）

> 围攻承重墙（引擎权威）已合龙，但玩家侧入口/观战仍缺。G3-2c 闭合「玩家定布阵 → 出征 → 看战斗」闭环。分四阶段，每阶段 tsc + 测试验证后提交。

**Phase 1 — 服务端数据模型 + 契约 ✅（2026-06-21）**

兑现 §16.8 未尽 ①②③的服务端半截（④留 Phase 4）。逐函数核对落地：

- **数据模型（`worldsvc/src/db.ts`）**：新增 `ArmyEntry`（GarrisonEntry 可序列化镜像：unitType/col/row/initialHp）、`TeamTemplate`（`{id,name,army}`）；`PlayerWorldDoc.teams?`（≤ `SIEGE_TEAM_CAP`=5 支进攻布阵模板）、`MarchDoc.army?`（attack 挂队时的攻方布阵快照，出征后队伍可改不影响在途军）、`SiegeDoc.{seed,attackerArmy,defenderConfig,tileLevel}?`（关键围攻持久化重播输入）。
- **队伍 CRUD（`service.ts`）**：`getTeams`/`setTeams`——保存时校验「≤5 支 + id 唯一 + 每支 army 过引擎 `levelSchema`」（`siegeEngine.validateAttackerArmy`，非法即整组拒不落库）。`GET/PUT /world/teams`。
- **围攻挂队**：`startMarch` 加 `teamId?` 参数——attack 挂队 → committed 兵力 = 队伍各单位 `initialHp` 之和（覆盖 body `troops`）、army 快照随 `MarchDoc` 落库；池不足默认拒发（`NO_TROOPS`，§16.5 v1）。`applySiege` 用 `m.army ?? synthesizeArmy`（真实布阵优先，合成退为兜底）。`POST /world/march` 加 `teamId`。
- **自定义布阵国民加成（item②）**：`buildDefenderConfig(target, effGarrison, inOwnNation)`——自定义守方布阵在己方首府 Voronoi 区时，各单位 `initialHp` ×(1+`NATION_BONUS_DEFENSE`)（`siegeEngine.scaleArmyHp`，引擎 Unit 构造封顶满血，故未满血单位受益；合成路径仍走 `effGarrison` 多铺单位）。两路各只施加一次加成。
- **重播观战（item③ 服务端）**：`landSiege`/`recordSiege` 持久化 seed + 双方布阵 + 格等级到 `SiegeDoc`（廉价兜底/NPC 扫荡 `replay=null` → 无重播）。`getSiegeReplay`——攻守双方可读（旁观者拒），用持久化输入 `buildSiegeBattle` 重建 `level`（含 `attackerArmy`），客户端凭同 seed 空 `ReplayInputSource` headless 重跑逐字复现。`GET /world/siege/{id}/replay`。
- **代守（盟军可布）**：`setDefense` 放宽——己方领地或**同家族盟军**领地（`sameFamily`，与 `computeMarchPath` 关隘通行盟友判定一致；盟友宗门待联盟系统）均可布防；并加保存期 `validateDefenseConfig` 校验。
- **契约**：`openapi-world.yml` 加 `ArmyEntry`/`TeamTemplate`/`SiegeReplayView` schema + `/world/teams`(GET/PUT) + `/world/siege/{id}/replay`(GET) + march `teamId`；`rest:gen` 重生 `client/src/net/openapi-world.ts`。**proto 无改动**（重播按 siegeId 拉取，`SiegeResult` 推送字段不变）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc e2e 88 全绿（新增 `teams.e2e.test.ts` 3 例：队伍 CRUD 校验 / 挂队 committed+快照+权威围攻+可重播 / 兵力不足拒发；既有 siege/nation/march e2e 不破）。

**Phase 2 — 客户端布阵编辑器 + 队伍管理 ✅（2026-06-21）**

兑现 §16.8 未尽 ①的客户端半截（玩家可视化编辑攻方布阵 + 出征选队）：

- **`DefenseEditorScene` 推广为通用半场 UI**：加 `target` 判别联合（`{mode:'defense',tileKey}` | `{mode:'attack',teamId,teamName}`）。攻方模式 = 下半场出兵行（`ATTACK_ROWS=[8..1]`，1=出兵行在底）、调色板只列单位（无建筑/无基地强化）、footer 显 committed 兵力。守方模式行为逐字不变（建筑行 + garrison 16..9 + 基地步进）。攻方 load 走 `getTeams` 找槽位 → `applyArmy`；save 走 `getTeams`→替换该槽→`setTeams`。
- **每单位兵力**：v1 每单位以**满血容量**出战（`initialHp = UNIT_BLUEPRINTS[type].hp` = 兵力当量，§16.1）；committed 兵力 = 单位数 × 满血。**每单位兵力分配滑杆暂缓**（§16.2 提及，列为后续打磨——当前靠「摆多少兵种」控制军队规模已闭环）。
- **`TeamsScene`（新）**：列 5 槽位（committed 兵力 / 空），点槽位进编辑器；槽位 id/名固定 `t1..t5`（v1 不做自定义命名）。`TEAM_CAP=5` UI 常量（服务端 `SIEGE_TEAM_CAP` 权威）。
- **`WorldMapScene` 出征选队**：围攻入口从「派兵数对话框」改为 `showAttackTeamPicker`——列可用队伍（含 committed 兵力）+「管理队伍」入口；选队 → `doMarchTeam`（`startMarch` 挂 `teamId`，troops=1 占位由服务端覆盖）。空队伍 → 引导去管理。主城菜单加「管理队伍」入口。
- **接线**：`WorldApiClient` 加 `getTeams`/`setTeams`/`getSiegeReplay` + `startMarch` `teamId`；`AppViews`/`app.ts` 加 `showTeams`；`createAppCore` 加 `goTeams`/`goTeamEditor`，`goDefenseEditor` 改传 `target`；i18n `world.team.*` + `world.teams` zh/en/de。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿；server 不动。

**Phase 3 — seed 重播观战改造 ✅（2026-06-21）**

兑现 §16.8 未尽③（客户端凭 seed + 双方布阵重播观战）：

- **`goSiegeReplay` 改纯演出**：从「跑 live 局 + 上传录像 judge 复算」（旧 S8-3b 模型）改为——拉 `getSiegeReplay`（seed + 双方布阵重建的 LevelDefinition）→ 构造 siege 模式空帧 `Replay`（无 live 指令）→ `views.showReplay` spectator 重跑，逐字复现 worldsvc 跑过的权威战斗。**无录像上传、无 judge**（引擎权威已在 worldsvc 落地）。攻守双方均可观战。
- **`ReplayScene` 推广**：构造加可选 `providedLevel` 参数——siege 重播的 level 含双方军（攻方 `attackerArmy` + 守方 garrison），不能由 campaign id 派生，直接传入；campaign 重播仍走 `getLevel(meta.levelId)`。endFrame = 战斗时限 + 余量（实际由 game-over 先停）。
- **接线**：`AppViews`/`app.ts` `showReplay` 加可选 `level`；createAppCore 去 `replayToUploadFrames` 死 import；`analytics.track('siege_replay')`。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

**Phase 4 — 删 S8-3b judge/peer 死路径 ✅（2026-06-21）**

兑现 §16.8 未尽④（手操方案作废后清理无调用方的录像 judge 复算路径）：

- **worldsvc service.ts**：删 `getSiegeDefense` / `siegeDefenseConfig` / `resolveSiegeWithJudge`（C2 复盘 + S8-3b 录像复算）；去 `buildSiegeLevel` / `WorldJudgeArgs` import（`buildSiegeLevel` 仍在 shared 内部供 `buildSiegeBattle`）。保留 `getSiegeReplay`（新）。
- **worldsvc gatewayClient.ts**：删 `WorldJudgeArgs` / `WorldJudgeResult` / `judge()`（interface + `HttpWorldGatewayClient` impl + `nullWorldGatewayClient` + 4 个 e2e fakeGateway 桩）——worldsvc 不再调 gateway `/gw/judge`（关键围攻已在进程内跑引擎）。gateway 服务端 `/gw/judge` 基建保留（PvP/netplay peer-judge 仍用）。
- **httpApi.ts**：删 `GET /world/siege/{id}/defense` + `POST /world/siege/{id}/resolve` 路由。
- **客户端**：`WorldApiClient` 删 `getSiegeDefense` / `resolveSiege` / `SiegeResolvePayload` + `SiegeDefenseView`/`SiegeResolveResult` 别名；`WorldMapScene.onReplaySiege` 注释更新为「纯演出观战」。
- **契约**：`openapi-world.yml` 删两路径 + `SiegeDefenseView`/`SiegeResolveResult` schema；`rest:gen` 重生。proto 无改动（`SiegeResult.replayRef` 字段保留为空，无害遗留）。
- **验收**：server `tsc -b shared engine worldsvc gateway` + worldsvc e2e 88；client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

> **G3-2c 四阶段全 ✅（2026-06-21）**：围攻闭环合龙——玩家可视化编辑攻守布阵、挂队出征、seed 重播观战，权威结果全程由 worldsvc 进程内引擎跑。承重墙 SLG11 至此完整兑现。剩 §16.5 DRAFT 数值调参（满血容量表/兵种当量/时限）+ 每单位兵力滑杆打磨。


## 18. G5 视野 / 迷雾系统（2026-06-21 拍板，§8.2 / §2.1 / §15.2 G5）

> 兑现「加家族才守得住」留存逻辑的关键拼图：服务端此前整图全可见（grep `fog/vision/scout` 零命中）。本节定基准并记录实现。**拍板（2026-06-21，用户）见下表**；G5-1 服务端读路径门控已 ✅。

### 18.1 五项拍板

| # | 决策 | 结论 |
|---|---|---|
| **V1 迷雾模型** | 永久黑雾 vs 战争迷雾 | **2a**：地形层（程序化、确定性）**全图始终可见**；动态层（归属/驻军/防守/保护罩/行军）仅当前视野内可见，视野外**退回 `proceduralTile` 底层地形**（连「已被占领」信号都不泄露——type 不返 `territory`/`base`）。不做持久化 explored-set 黑雾——地形不是秘密，机密是动态层。**资源图案（含等级细节）归地形层，全图始终可见（2026-07-07 拍板，见 §18.6 客户端渲染条）——原「视野外只显资源类型、隐等级」的收窄已作废。** **⚠️ 2a 的「动态层整层藏雾」已于 2026-07-24 让位给模型 2b（§18.10）：归属/base/占领等静态结构改为全图公开，迷雾只藏情报字段（驻军/耐久/瞭望塔）与行军。** |
| **V2 视野来源 + 共享** | 半径来源 / 共享到哪一级 | 己方领地半径 `VISION_TERRITORY_RADIUS=2` + 主城 `VISION_BASE_RADIUS=5` + 在途行军 `VISION_MARCH_RADIUS=2`（侦察行军价值）。**共享 = 家族级（≤30）**，复用 `sameFamily`/`familyMembers` 反查。**§8.2 字面「宗门级共享」降级为家族级**——宗门 900 人并集近乎整图，迷雾名存实亡；宗门/联盟只做领地颜色标记不并视野。`scout` 侦察行军 kind 已落地（§18.8，半径 `VISION_SCOUT_RADIUS=4`、不打不占自动回师）；瞭望塔建筑已落地（§18.9，`VISION_WATCHTOWER_RADIUS=8` 固定半径持久视野源）。 |
| **V3 计算/存储** | 实时算 vs 落库 | **实时算 + 短 TTL 缓存（缓存留后续），vision 零落库**（避 U11 规模爆炸）。视区半径有 `MAP_VIEW_MAX_RADIUS=40` 上限，计算量有界；源领地查询复用 `{ownerId}` 索引。 |
| **V4 推送门控** | 读路径门控 / 反向视野推送 | **v1 即做反向视野推送**（用户拍板，覆盖初版「仅读路径」建议）。工程化:反向查询**只在「行军发起 / 格易主」两个低频事件点做一次**（查路径沿途半径内有视野源的玩家 → 一次性推完整 `march_update`/`tile_update`，客户端在自己视野内的路径段渲染），**不逐 tick 反向扇出**（避 U11）。`under_attack` 仍无条件发防守方（§16 布阵预设=反应窗口）。→ G5-2。 |
| **V5 客户端表现** | 雾渲染 + 标记色 | 视野外铅笔灰雾半透明覆盖（手绘风，SketchPen 烘焙）、去动态层；标记色对齐「我蓝敌红」v0.3：自己=蓝、家族/同盟友=青/绿（第三友方色）、联盟宗门=黄描边标记（不共享视野，§8.2）、敌方=红、中立=纸面本色。→ G5-3。 |

### 18.2 视野原语（`shared/slg.ts`）

- 常量 `VISION_TERRITORY_RADIUS` / `VISION_BASE_RADIUS` / `VISION_MARCH_RADIUS`（DRAFT）。
- `VisionSource{x,y,radius}`；`isInVision(sources, x, y)`：Chebyshev（方形）距离判可见，纯函数双端可算。
- `marchInterpPos(fromX,fromY,toX,toY,departAt,arriveAt,now)`：行军当前位置线性插值（路径绕障故为近似，足够圈视野）。

### 18.3 分片

- **G5-1 shared 原语 + 服务端读路径门控 ✅（2026-06-21）**：见 §18.4。
- **G5-2 反向视野推送 ✅（2026-06-21）**：`startMarch` / 格易主（occupy/landSiege/relocate）做一次反向视野查询 → 给视野内观察者推 `march_update`/`tile_update`（敌方行军进我视野即推，V4）。见 §18.5。
- **G5-3 客户端渲染 ✅（2026-06-21）**：`WorldMapScene` 灰雾覆盖 + 友/敌标记色 + 视野内敌军渲染（含 server 侧 `ally`/`getMarches` 视野门控）。见 §18.6。
- **联盟（宗门）领地黄描边标记 ✅（2026-06-21）**：`WorldTileView.allySect` + `allySectMemberIds`（family→sect→allySectIds→成员链路），客户端金琥珀内描边；联盟不共享视野、仅标记（§8.2 V5）。见 §18.7。

### 18.4 G5-1 实现记录（2026-06-21）

- **shared**：§18.2 原语（`VISION_*` 常量 + `VisionSource` + `isInVision` + `marchInterpPos`）。
- **worldsvc `service.ts`**：
  - `computeVisionSources(worldId,accountId,x0,x1,y0,y1)`：视野源主人 = 自己 ∪ 同家族成员（`familyMembers` 反查；**注意 `occupyTile` 不写 `tile.familyId`，故不能靠 tile.familyId，必须按 `ownerId:{$in: 成员}` 取源格**）。源领地在视区按 `VISION_BASE_RADIUS` 外扩查询（半径外的领地照亮视区边缘）；`type:'base'` 给大半径、其余领地小半径；在途己方/家族 `marching` 行军按 `marchInterpPos` 插值当前位置 + `VISION_MARCH_RADIUS`。
  - `getMap`：建可见集 → 逐格门控。视野外 push `{...proceduralView, visible:false}`（隐去动态层 + 占领信号）；视野内 `{...tileDocView/proceduralView, visible:true}`。**profile 拉档仅对「可见的他人领地」**（视野外不显归属，省 meta 负载）。
  - `getTile`：同口径门控（视野外 `{...proceduralView, visible:false}`），防 getTile 绕过迷雾。
  - `WorldTileView.visible?:boolean`（仅 getMap/getTile 视区读填充；occupy 等单格响应不带）。
- **契约**：`openapi-world.yml` `WorldTileView.visible`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（G5-1 不动推送）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc **93 e2e**（新增 `fog.e2e.test.ts` 5 例：视野内动态可见 / 视野外退程序化地形隐占领 / getTile 同口径 / 家族共享远处领地 / 在途行军照亮路径 + 对照迷雾；既有 88 不破，因视野外退回 `proceduralView` 与原程序化默认逐字一致，且正向动态断言均落在请求者己方格=恒在视野）。

### 18.5 G5-2 实现记录（2026-06-21）

- **反向视野查询（`service.ts`）**：
  - `visionObservers(worldId, cells, exclude)`：找出视野半径罩住 `cells` 中任一格的「领地/主城主人」账号集（`type:'base'` 用 `VISION_BASE_RADIUS`、领地用 `VISION_TERRITORY_RADIUS`，Chebyshev）。在 cells 包围盒按 `VISION_BASE_RADIUS` 外扩查有主格，逐格判命中即收。**只在低频事件点调用一次（非逐 tick）**，避 U11 反向扇出爆炸。**v1 只取领地主人本人**（家族成员实时扇出留后续——他们经家族共享 getMap 轮询亦可见）。
  - `pushTileToObservers(tile, exclude)`：包一层，对单格变更推 `tile_update` 给观察者。
- **事件点接入**：
  - **行军发起 `startMarch`**：复用已算出的 `path`（A* 全路径，比直线包围盒更准）反向查观察者 → 推 `march_update`。守方（attack）已单独收 `under_attack`，连同行军主一起从观察者集排除（避重复）。`march_update` 载荷无 troops 字段——敌方观察者看得见行军路线/ETA/类型但**不知兵力**，合理的侦察信息粒度。
  - **格易主/新领地**：直占 `occupyTile`、行军到点占领、围攻 `landSiege` 易主、主动/被动迁城新主城——五处在原 owner/defender `pushTile` 之后加 `pushTileToObservers`（排除已单独推过的当事人）。增援不接（garrison 不在 `tile_update` 载荷，无观察者价值）。
- **关键修复（async 时序）**：观察者推送内含 DB 查询（`visionObservers` await），不能 `void` fire-and-forget——否则事件函数返回时推送尚未发出（owner 的同步 `pushTile`/`pushMarch` 不受影响，但观察者推送会丢）。五处 `pushTileToObservers` 与 startMarch 的观察者推送全部 **`await`**，确保 `processDueArrivals`/`startMarch` 返回时推送已落。
- **契约**：proto / openapi 均无改动——`march_update`/`tile_update` 推送通道既有，G5-2 纯服务端逻辑（推送给更多收件人，载荷不变）。
- **验收**：server `tsc -b` 全绿；worldsvc **96 e2e**（新增 `vision-push.e2e.test.ts` 3 例：行军进观察者视野推 march_update + 远端不推 / 直占新领地推 tile_update + 占领者不重复推 + 远端不推 / 围攻易主对第三方观察者推；既有 93 不破——awaited 观察者推送不改既有 owner/defender 推送断言）。

### 18.6 G5-3 实现记录（2026-06-21）

> 客户端把迷雾「画出来」+ 友/敌正确上色 + 让 G5-2 反向推送的敌军真正显形。为正确性需配套两处小 server 改动（家族盟友领地原本会显示为敌色；`getMarches` 原只返己方行军，敌军推送后客户端 refetch 拿不到）。

- **server（小补）**：
  - `WorldTileView.ally?:boolean`——`getMap` 用家族成员集（`familyMemberIds`，从 `computeVisionSources` 抽出复用）标记「可见、非己方、同家族」的格。解决家族共享视野后盟友领地显示为敌色的正确性 bug（`tile.familyId` 占领不写，靠成员集判定）。
  - `MarchView.mine?:boolean` + `getMarches` 扩展：己方行军（mine:true）+ **视野内的非家族敌方在途行军**（mine:false，按 `marchInterpPos` 当前位置过 `isInVision`，视野源取全图 `computeVisionSources(0,mapW-1,0,mapH-1)`）。这是 G5-2 反向 `march_update` 推送在客户端「refetch-on-push」模型下真正显形的数据源。家族友军行军不计入（友方靠家族集）。
  - 契约 `openapi-world.yml`：`WorldTileView.ally` + `MarchView.mine`；`rest:gen` 重生。proto 无改动。
- **client `WorldMapScene.ts`**：
  - **灰雾（2026-07-07 调浅）**：`tile.visible===false` 的格画底层地形后罩一层 `FOG_COLOR=0xc9c2b2 @0.3` 浅暖纸灰（原 `0x6b6458 @0.4` 铅笔灰太深、进图几乎看不见，改浅色 + 30% 不透明的薄罩；地形可见、局势看不清，对齐迷雾模型 2a）；视野外不画等级点/城池图标/瞭望塔/联盟描边等动态标记（不暴露细节）。L1(`drawTileL1`)/L2(`drawTileL2`) 两级缩放同 α0.3；L3 远景仍走 `WorldMapRenderer` 内的底色变暗（另一路，未随此次调整）。
  - **资源图案（terrain，非动态层）一直全绘 ✅（2026-07-07 拍板）**：resType 属地形层，**迷雾不改变资源美术的绘制**——`drawTileL1` 无论视野与否都以 `drawResMotif(..., fogged=false)` 画**完整**资源图案（现为单张 per-level 图，`res_{resType}_l{level}`；早期的 abundance 数量复制/防御框/危险角等叠加已于 `2a85a917`、`5794b8ea` 移除，等级信息全由分级美术自身承载），浅灰雾罩画在 `Graphics` 自身多边形上、而资源图案是 `addChild` 的 sprite 子节点恒渲染其上，故雾罩不遮资源。**这偏离原迷雾模型 2a「视野外只显资源类型、隐等级细节」——2a 那条按用户拍板作废：资源（含等级）一直可见。** 历史：此前雾中传 `fogged=true` 只显单个 @0.35 淡化类型图案；更早还有灰雾块 `return` 早于资源绘制导致雾区资源不显。**反复：`0f26b4a7`（2026-07-07 晚）曾整体注释掉 `drawResMotif` 调用改用生态染色地表；`2026-07-08` 按用户「每格都画」拍板恢复调用（两端 `tileGraphics.ts`，`resourceDensity=1.0` 故整图铺满资源图案属预期，见 map-editor DESIGN.md）。**
  - **`parseTileId` tileId 格式**：tileId 全库为 `{worldId}:{x}:{y}`（`mainBaseTile`/`march.fromTile`/`toTile`/`tile_update.tile` 皆带 worldId 前缀，worldId 不含 `:`）→ **取末两段** 为 x/y。修复：此前 `split(':')` 取前两段，把 worldId 当成 x（→0），进图后地图中心落在 x≈0 而非主城 x → 视区整片在视野外（全灰雾、无主城、无资源），是「大地图不显示主城/资源」的根因（另配合上一条雾中资源渲染）。
  - **标记色**（沿用全局阵营色铁律「敌红我蓝」ADR-003；2026-08-08 订正——此前本节曾写成「敌蓝我红」并据此实现，见 DECISIONS ADR-024 订正记录）：自己=蓝（`MINE_*`）、**家族盟友=绿（新 `ALLY_TINT/ALLY_BASE_TINT`，友方第三色）**、敌方=红（`ENEMY_*`）、中立=纸面。`tileColor` 加 `ally→绿` 分支（在 mine 之后、occupied 之前）。
  - **敌军行军**：march 箭头 `march.mine===false` → 统一敌色（红）+ 更粗描边 + 更大终点点，突出威胁；己方按 kind 上色。HUD 行军列表过滤为 `mine!==false`（敌方行军不可撤、不进列表）。
  - **行军动画（2026-07-12）**：此前箭头是全长静态直线，全程不变，占领/围攻是否真的"在路上"只能靠 HUD 倒计时文字判断。现按 `frac=(now-departAt)/(arriveAt-departAt)` 在起终点间插值出一个沿路径滑动的菱形兵力 token（朝向随行军方向），原满长直线降 alpha 保留为路线淡描，终点箭头保留但同样调淡。`WorldMapRenderer/fog.ts renderOverlay()` 计算插值；`WorldMapRenderer/lifecycle.ts update()` 在 `ctx.marches.length>0 && zoom<3` 时每帧重绘 overlay 驱动动画（无行军时不额外重绘，避免空耗）。
  - **地块操作弹窗放大 2 倍（2026-07-12）**：`showModal()`（占领/侦查/迁城/驻防/攻击等所有地块点击弹窗共用）尺寸整体 ×2——宽度上限 300→600、高度 140→280、标题字号 13→26、按钮高度 28→56、按钮字号 12→24；按钮间距用局部 `modalMargin`，不改共用 `MARGIN` 常量（避免连带影响训练面板等其他 UI）。
  - **弹窗再放大 1.5 倍 + 文字自动换行 + 迁城 3×3 前置校验（2026-07-12 二次修复）**：迁城确认弹窗（`world.relocateConfirm` 长文案）此前固定 600×280，长文案不换行导致溢出面板。`showModal()` 改为：宽度上限 600→900；文本改用 `txt(..., wordWrapWidth)` 换行；面板高度由内容动态撑开（`Math.max(CONFIRM_H*1.5, 实际文本高+按钮高+边距)`），不再固定裁切。同时补上迁城的 3×3 校验缺口——此前"迁城到此"按钮只检查被点格子本身类型，未检查完整 3×3 地基（ADR-025），导致对着实际放不下地基的格子也弹出确认框，点击后收到含糊的"该地已被占领"报错。`WorldMapInput.footprintFree()`（镜像服务端 `footprintFree`，用 `@nw/shared` 的 `baseFootprintCells`/`baseFootprintInBounds` + 本地 `tileCache` 判断地形/占用）现在前置校验整块地基，条件不满足时直接不显示按钮；万一客户端缓存过期导致仍提交到服务端被拒，`errorMsg()` 按服务端报错文案中的"3×3"关键字匹配出新 `world.err.footprintBlocked` 文案，不再复用含糊的 `world.err.occupied`。
  - **弹窗按钮多行换行（2026-07-18）**：己方地块菜单最多 6 个按钮（增援/驻防/瞭望塔/迁城/放弃/✕）挤在同一行时，单个按钮宽度过窄，文字溢出与相邻按钮的文字重叠。`showModal()` 现按最小可读宽度（150px）算出每行最多列数，超出的按钮自动换到下一行（面板高度按行数动态撑开）；每个按钮标签也改为按自身按钮宽度 `wordWrapWidth` 换行，杜绝任何按钮数下文字溢出邻格。
  - **点击选中相邻格子修复（2026-07-12）**：`render/isoGrid.ts` 的 `tileToScreen(tx,ty)` 把格子(tx,ty)的**中心**映射到投影坐标（见其注释），因此其精确反函数 `screenToTileF` 返回的连续坐标空间里，一个格子的真实范围是 `[tx-0.5, tx+0.5)`，不是 `[tx, tx+1)`。而 `screenToTile` 此前对反函数结果直接 `Math.floor`——只对"整数=左上角"的映射成立，对"整数=中心"的映射会把每次点击命中判定整体偏移半格（朝 tx/ty 增大方向），表现为点击某格却选中了它左上方（iso 屏幕坐标里 tx/ty 减小的方向）的相邻格。修复：`screenToTile` 改 `Math.floor(f.x + 0.5)`（即四舍五入），使命中范围重新对齐到以格子中心为界的 `[tx-0.5, tx+0.5)`。新增 `client/test/isoGrid-screenToTile.test.ts`（5 例：格心点击、偏心点击、菱形四顶点内侧点击、旧 bug 回归断言、相邻格无缝/无重叠边界）锁定该不变量；`visibleTileBounds` 的 floor/ceil 保持不变（那是视口覆盖范围的外接矩形计算，不需要精确到格，不受影响）。
  - 既有 `applyMarchUpdate`→`refreshMarches()` / `applyTileUpdate`→`loadMapViewport()` 的 refetch-on-push 通道不变——G5-2 推送触发 refetch，新 `getMarches`/`getMap` 门控返回视野内敌情，自动显形。
- **scout 行军**：已落地（§18.8，2026-06-21）。**瞭望塔**：已落地（§18.9，2026-06-21）——己方领地建固定半径（8）持久视野源。
- **验收**：client `tsc --noEmit` + **293 测试** + `build:web` 全绿；server `tsc -b` 全绿；worldsvc **97 e2e**（vision-push +1：`getMarches` 己方 mine:true / 视野内敌方 mine:false / 视野外不返回；fog 家族用例加 `ally:true` 断言）。

### 18.7 联盟（宗门）领地黄描边标记实现记录（2026-06-21，§8.1 V5 余项）

> §8.2「盟友不共享视野、仅地图颜色标记区分」：联盟宗门成员的领地**不并入视野**（看不见远处联盟领地），只在它**恰好落进请求者自身/家族视野**时打一个标记 → 客户端黄描边。与家族盟友（`ally`，绿色满涂、共享视野）正交且互斥。

- **server（`service.ts`）**：
  - `WorldTileView.allySect?:boolean`——可见、非己方、非家族、且归「本宗门联盟宗门」成员所有的格。
  - `allySectMemberIds(worldId, accountId)`：链路 `accountId → familyMembers → family.sectId → sect.allySectIds（≤2）→ 各联盟宗门成员家族 → 成员 accountId 集`。无宗门/无联盟 → 空集；不含自己/同家族（那些归 `familyMemberIds`）。**不参与 `computeVisionSources`**（联盟不照亮视野，仅标记）。
  - `getMap`：算 `allySect` 集一次；逐格 `allied = !ally && 可见他人格 && allySect.has(owner)` → 置 `allySect:true`（家族 `ally` 优先，二者互斥）。`getTile`/`occupy` 等单格响应不带（同 `ally`/`visible`，仅视区读填充）。
  - 每次 getMap 多 3~4 次小查询（familyMember/family/sect/成员家族+成员），V3 短 TTL 缓存仍列后续。
- **契约 `openapi-world.yml`**：`WorldTileView.allySect`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（标记走 getMap 读路径，不动推送）。
- **client `WorldMapScene.ts`**：`ALLY_SECT_BORDER=0xe6a817`（金琥珀）内描边（`px+1.5, TILE_PX-4`，1.5px）——刻意区别于首府星标/选区的亮黄 `0xffcc00`（满边+填充）。填充仍走 `tileColor`（联盟领地是他人占领格，底色保持敌色蓝，黄描边叠加区分「勿攻」）；视野外（fogged）不画描边。~~**联盟「禁止进攻/夺地」的战斗约束属联盟系统专项，非 G5 视野范围，不在本片实现**~~ **✅ 已实现（R-3，2026-07-02）**：`startMarch` attack 分支加友军拦截 `friendlyAccountIds`（自己 + 本家族 + 本宗门全家族 + 联盟宗门 `allySectIds`）→ 命中抛 `ALLY_TILE`（新错误码，403）。检查置于保护罩校验之前，故友军基地即便有保护罩也先报 `ALLY_TILE`。见 §21.2 R-3。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿；worldsvc **100 e2e**（新增 `alliance-mark.e2e.test.ts` 3 例：视野内联盟领地标 `allySect`、敌方/家族不标 / 联盟不共享视野远处仍迷雾不标 / 解盟后视野内他人领地不再标；既有 97 不破）。

### 18.8 scout 侦察行军实现记录（2026-06-21，§18.1 V2 余项）

> 把 §18.1 V2「scout 行军 kind」从「列 v2」兑现：新增**不打不占的侦察行军**——派少量兵到任意非障碍格（含敌方/中立/保护中/中心），沿途 + 抵达点照亮一片**更大**视野后**自动回师**。普通行军已是视野源（半径 2），scout 的差异价值 = 更深的视野半径 + 不触发战斗。

- **shared（`slg.ts`）**：`MarchKind` 加 `'scout'`；新常量 `VISION_SCOUT_RADIUS = 4`（DRAFT，> 普通行军 `VISION_MARCH_RADIUS=2`，「探得更深」）。
- **worldsvc（`service.ts`）**：
  - `MARCHABLE_KINDS` 加 `'scout'`；新 helper `marchVisionRadius(kind)` = scout→4 / 其余→2，`computeVisionSources` 在途行军视野源按此取半径（`getMarches` 的全图视野源同步生效，敌方 scout 进我视野亦显形）。
  - `startMarch`：新 scout 分支——无归属/中心/保护期限制（仅上方拦掉障碍地形），不设 `defenderId`（**不发 `under_attack` 预警**，侦察非进攻）。反向视野推送仍照常（敌方观察者沿路看得见斥候，载荷无兵力，合理侦察粒度）。
  - `applyArrival`：新 scout 分支 → `autoReturnScout(m,t)`：到点不打不占，自动生成一条 `kind:'return'` 返程腿（target→origin、原兵力、返程耗时 = 去程耗时对称近似），途中继续提供视野，到点 `return` 退兵回池。
- **契约**：`openapi-world.yml` 两处 enum（`MarchView.kind` + `startMarch.kind`）加 `scout`，`rest:gen` 重生 `openapi-world.ts`；`transport.proto` `MarchUpdate.kind` 注释补 `scout`（string 字段，无需重生 proto）。`WorldApiClient.startMarch` 的 `MarchKind = Exclude<MarchView['kind'],'return'>` 自动纳入 scout。
- **client（`WorldMapScene.ts`）**：`DeployKind` 加 `'scout'`；敌方格 + 中立/未知格菜单加「侦察」按钮 → `doScout(tx,ty)` **直接派 1 名斥候**（不走派兵数对话框，侦察讲究轻量、不锁大军）；行军箭头 scout=紫 `0x9b59b6`、HUD 图标 `🔭`。i18n `world.actScout` / `world.scoutSent`（en/zh/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + **293 测试** + `build:web` 全绿；worldsvc **103 e2e**（新增 `scout.e2e.test.ts` 3 例：侦察敌方格不占不发预警归属不变 / 视野深度 chebyshev≤4 可见 >4 迷雾 / 到点自动回师且全程不占地兵力归池；既有 100 不破）。

### 18.8.1 scout 暂时下线（2026-07-21）

> 玩家反馈「行军中的队伍被拉去侦察」；排查代码（见下）未能在当前实现里找到该路径的直接复现——scout 从设计上就不携带 `teamId`（`doScout` 固定从主城派 1 名斥候，不走队伍选择器；服务端 `startMarch` 只在 `kind==='attack'||'occupy'` 时才把 `teamId` 落库/纳入 `TEAM_BUSY` 校验，scout 分支完全绕开）。根因未定位前先按用户要求下线入口，避免继续造成困惑；底层结构（`MarchKind`、`MarchDoc`、契约 enum、i18n、图标映射）原样保留，方便定位后快速恢复。

- **client**：`WorldMapInput.ts` 的四处菜单（敌方格/据点/据点保持中/中立格）移除「侦察」按钮；`doScout()`（`WorldMapNet.ts`）保留但已无入口可触发。
- **worldsvc**：`combatMarch.ts` `startMarch()` 在 `MARCHABLE_KINDS` 校验后新增 `if (kind === 'scout') throw NOT_IMPLEMENTED`，即便有客户端直连 API 也会拒绝；原 scout 分支（无战斗/无占领/无 `defenderId`）随之移除（已不可达）。
- **测试**：`scout.e2e.test.ts` 由「验证 scout 正常工作」的 3 例改为「验证 scout 被拒绝」的 1 例；client 新增 `worldMapScoutDisabled.ui.ts`（5 例）断言四种菜单均不再出现侦察按钮。
- **验收**：server `tsc -b` + worldsvc 全量 e2e（33 files / 282 tests）全绿；client `tsc --noEmit` + `build:web` + 全量 UI 测试（79 files / 721 tests）全绿。
- **遗留**：真正的「行军队伍被误派侦察」根因仍未查明（怀疑是旧版本客户端，或 `showTeamPicker` 的 `busyTeamIds` 读到过期数据导致误判空闲）——待用户提供具体复现步骤后再排查；此前 §18.8 记录的 scout 功能设计/实现细节仍作为恢复参考保留不动。

#### 18.8.1a scout 彻底删除（2026-07-30）

audit-followup-fixes-0730 复查时重新核实了 §18.8.1 的"根因未定位"结论：`doScout()` 现在零调用方（四处菜单按钮早已移除，且没有其它入口能到达它），服务端也没有任何除 `startMarch` 显式参数之外的路径能把某个 march 的 `kind` 设成 `'scout'`——结构上"行军队伍被误拉去侦察"这个原始 bug 机制已经不可能复现了，但当时真正的根因仍然没有查清楚。问用户是否要重新开放，用户回复"目前不需要侦察了，当时留着只是觉得要删的代码太多"——于是这次不是恢复，而是彻底删除整个功能，不再保留"方便快速恢复"的底层结构：

- **shared**：`MarchKind` 去掉 `'scout'`；`VISION_SCOUT_RADIUS` 常量整个删除（连带从 `VISION_MAX_RADIUS` 的 `Math.max(...)` 里去掉）。
- **worldsvc**：`MARCHABLE_KINDS` 去掉 `'scout'`；`combatMarch.ts` 删掉 §18.8.1 加的 `kind==='scout'` 拒绝分支（`MARCHABLE_KINDS.has(kind)` 的通用校验已经足够）+ 到达点分发分支 + `autoReturnScout()` 整个方法；`core/helpers.ts` 的 `marchVisionRadius()` 包装函数删除（唯一调用方 `core/vision.ts` 改为直接引用 `VISION_MARCH_RADIUS`）。
- **契约**：`openapi-world.yml` 两处 `kind` enum 去掉 `scout`；`transport.proto` 的 `MarchUpdate.kind` 注释同步；`gen:api:contracts`/`gen:api:world`/`gen:api:server`/`proto:gen`（client + botsvc/gameserver/gateway/metaserver 四份各自的生成产物）全部重跑。
- **client**：`DeployKind` 去掉 `'scout'`；`WorldMapNet.ts` 的 `doScout()` 整个方法删除；`WorldMapPanels.ts`/`WorldMapRenderer/fog.ts` 里的 scout 图标/配色分支删除；i18n 三语言（zh/en/de）去掉 `world.actScout`/`world.scoutSent`；连带清理了专为 scout 画的 `scope`（望远镜）图标（`IconKind`/`icons.ts`/`icons/slg.ts` 的 `drawScope`），确认零消费者后整个删除。
- **测试**：`server/worldsvc/test/scout.e2e.test.ts`（只剩"验证被拒绝"的 1 例）+ `client/test/ui/worldMapScoutDisabled.ui.ts`（验证菜单不再出现侦察按钮的 5 例）整个删除——两者都是在守护一个现在已经从类型层面就不可能发生的状态，`tsc` 本身就是更强的保证。顺带发现并修复了 `client/test/ui/modalScaleAndBackButton.ui.ts` 里 3 个断言仍用今天已修复的landscape 弹窗缩放旧公式（`(h*0.8)/mh`）算期望值的用例——这是 2026-07-30 landscape modal overscale 修复（见本文档另一节/`modal-scale-landscape-overscale-2026-07-22` memory）暴露出的遗留断言，一并更新为新公式。
- **验收**：server 12 个 workspace `tsc -b` 全绿；worldsvc 全量 e2e 46/47 文件绿（唯一失败 `field-encounter.e2e.test.ts` 单独重跑绿，判定为并发跑测的偶发波动，与本次改动无关，文件本身零 scout 引用）；client `tsc --noEmit` 全绿 + 全量 vitest（124 files/903 tests）+ 全量 UI vitest（96 files/824 tests）全绿。

### 18.9 瞭望塔（Watchtower）实现记录（2026-06-21，§18.1 V2 最后余项）

> 把 §18.1 V2「瞭望塔建筑——固定半径持久视野源」从「列 v2」兑现：在**己方领地**花资源建塔，该格升级为**最大半径**（`VISION_WATCHTOWER_RADIUS=8` > 主城 5）持久视野源。区别于 scout（一次性照路后回师）：瞭望塔是**主动布点扩视野**的永久手段——「想看哪、就在哪建塔守着」。落库随 `TileDoc`（丢地即随格子消失，无单独退还），符合 V3「vision 零落库，但塔标记本身落库、视野仍读时实时算」。

- **shared（`slg.ts`）**：`VISION_WATCHTOWER_RADIUS=8`（DRAFT，最大视野源）；`VISION_MAX_RADIUS=max(全部视野半径)`（外扩查询 pad 统一用，须覆盖最大半径源以免漏照视区边缘）；`WATCHTOWER_COST={food:0,iron:2000,wood:3000}`（DRAFT，资源非金币——视野扩张是建造行为）。
- **worldsvc（`db.ts`/`service.ts`）**：`TileDoc.watchtower?:boolean`。新 helper `tileVisionRadius(t)` = watchtower→8 / base→5 / 其余领地→2，`computeVisionSources` 与反向 `visionObservers` 的静态源半径统一走它（两处 pad `VISION_BASE_RADIUS`→`VISION_MAX_RADIUS`，否则瞭望塔半径外的塔照不亮视区边缘 / 反向漏查塔观察者）。新 `buildWatchtower(worldId,accountId,x,y)`：校验己方领地（`TILE_NOT_OWNED`）+ 非主城（`BAD_REQUEST`，主城自带视野）+ 结算后资源充足（`INSUFFICIENT_RESOURCES`，不足不动地图）；扣 `WATCHTOWER_COST` → `$set tile.watchtower=true` → 推 `tile_update`（owner refetch 触发新视野下次 getMap 生效）+ `pushTileToObservers`（塔是可见结构，视野内观察者亦见）。幂等：已有塔直接返回视图、不重复扣费。`tileDocView` 透出 `watchtower`。
- **契约**：`openapi-world.yml` `WorldTileView.watchtower` + `POST /world/watchtower`（返 `WorldTileView`）；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（建塔走 REST，视野扩张走既有 getMap/tile_update 读推路径）。
- **client（`WorldMapScene.ts`）**：己方领地（非主城）菜单加「建瞭望塔」按钮（已有塔则隐去、改在标题显「🗼 已建瞭望塔」）→ `confirmWatchtower`（展示资源花费二确认）→ `doWatchtower`（建塔 → 刷新 me 资源 + 清 tileCache 整块重拉显形扩张视野 + toast）；地图渲染：可见格 `tile.watchtower` 画手绘小塔（米白塔身 + 深墨三角顶）。`WorldApiClient.buildWatchtower`。i18n `world.actWatchtower`/`hasWatchtower`/`watchtowerTitle`/`watchtowerConfirm`/`watchtowerBtn`/`watchtowerBuilt`（zh/en/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿 + 312 测试通过（1 例 `headless-nav` 因 S9 成就 stub 缺 `applyAchievementBadge` 预先失败，与本片无关）；worldsvc **141 e2e**（新增 `watchtower.e2e.test.ts` 6 例：建塔扣资源+置标记+视图透出 / 扩视野原迷雾远格建塔后可见且超半径仍迷雾 / 非己方拒绝 / 主城拒绝 / 资源不足拒绝不动地图 / 幂等不重复扣费；既有 135 不破）。

> **G5 视野/迷雾全 ✅（2026-06-21）**：读路径门控（G5-1）+ 反向视野推送（G5-2）+ 客户端渲染（G5-3）+ 联盟领地黄标（§18.7）+ scout 侦察行军（§18.8）+ **瞭望塔建筑（§18.9）**。「加家族才守得住」的视野维度**完整闭环**——地形全见、敌情藏雾、家族共享、侦察行军照路（含深探斥候）、瞭望塔主动布点固定视野、敌军进视野即现、联盟领地黄描边勿攻。V2 余项全部兑现。

### 18.10 迷雾模型 2a → 2b：静态层全图公开、迷雾只藏情报与行军（2026-07-24 用户拍板）

> **动机**：三档缩放曾走两条服务端读路径——L1 详情 `getMap`（做 G5 视野门控）、L2/L3 概览 `getMapSparse`（**为性能跳过视野计算**，返回全部有主格）。结果：**同一片地图在 L2/L3 满是别人的基地，切到 L1 却全消失**（视野外的 base 被 `getMap` 退回程序化地形、type 不再是 `base`，客户端 `refreshCityLayer` 画不出；且 `getMap` 逐格覆盖会把 L2 缓存的稀疏 base 覆写成迷雾地形）。这是信息泄露式的不一致：战略概览泄露了详情视图刻意隐藏的占领信息。
>
> **拍板**：迷雾**只对地图上的行军队伍生效**，对建筑/基地不生效——玩家随时可以看到其他玩家**在什么位置**（位置/归属/名字/等级/占领状态全图公开），只是看不到别人**队伍的行军**，以及**未进视野的情报**（守军兵力/耐久/瞭望塔）。这与率土之滨一致（静态政治地图恒可见、行军藏雾）。

- **server（`core/map.ts`）**：
  - 新 helper `gateIntel(view, inVision)`：视野内原样返回；视野外只**剥离情报字段** `garrison` / `hp` / `maxHp` / `watchtower`（结构照常返回）。行军已在 `getMarches`（己方 + 视野内敌方）门控，无需改。
  - `getMap`：删掉「视野外退回程序化地形 + `visible:false`」的整段——现在逐格恒返回完整 `tileDocView`（归属/base/occupied），只过 `gateIntel(view, vis(x,y))`，`visible` 恒 `true`。`ally`/`allySect` 标记也改为**不分视野**计算（派生自现已公开的归属 + 自己已知的宗盟关系，视为公开的政治色）。他人档案（名字）拉取去掉 `vis()` 过滤（归属公开→名字全图显）。
  - `getTile`：同口径——结构公开、`gateIntel` 只藏情报。
  - `WorldTileView.visible` 语义：自此**恒为 true**（静态层不再整格门控），保留字段仅为客户端兼容（客户端只在 `=== false` 时变暗，故恒 true → 不变暗，正合「静态地图无雾」）。见 `worldTypes.ts` 注释。
- **client**：**零改动**。`visible:true` 使 `pool.ts` 的 `fogged` 恒 false → 底图不再变暗；`city.ts refreshCityLayer` 本就不看 `visible`，base 精灵按 `type==='base'` 恒绘。
- **验收**：worldsvc `tsc --noEmit` 绿；`fog.e2e`（5）/`watchtower.e2e`（6）/`alliance-mark.e2e`（3）全绿。三处**视野探针从 `visible` 改为情报（`maxHp`）**：`fog` 视野外敌 base 现断言 `type:base + occupied + visible:true` 但 `garrison/hp/maxHp/watchtower` 全 undefined、march 照亮改测敌 base 的 `maxHp` 显形；`watchtower` 扩视野改测敌领地 `maxHp` 由 undefined→>0；`alliance` 远处联盟领地现 `allySect` 标记公开、仅 `maxHp` 藏雾。（`pathfinding.test.ts` 2 例失败为既有 seed-pool flake，与本改无关。）

## 19. G8 险地（Stronghold）实现记录（2026-06-21，§3.1 / §15.2 G8）

高战略价值 PvE 格补齐。险地 = 系统超强 NPC 驻守的程序化格，**不可直占/扫荡，只能围攻 attack 攻克**；攻克即占为领地（高产出 + 战略要点），并得一次性丰厚资源奖励。复用既有围攻确定性引擎（§16），无新战斗模型。

### 19.1 `@nw/shared`（`slg.ts`）

- **类型**：`TileType` 新增 `'stronghold'`。
- **生成**（`proceduralTile`）：在 `familyKeep` 之前判定（优先级更高；**2026-08-19 起散布式 `familyKeep` 判定已整段删除**，本条里所有"比 familyKeep 稀疏 N×"的对比只作历史读数——那条噪声阈值分支正是被这里警告的 blob 问题害死的，详见 [`SLG_LOG_2026-08.md` 2026-08-19 条](SLG_LOG_2026-08.md)）。**逐格哈希门** `rand2(x,y, seed^0x0555) > strongholdThreshold(0.997)` 且 `dr > strongholdMinDistRatio(0.25)` → `{ type:'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(...) }`。固定满级 + 带资源种类（攻克后产出丰厚）。**逐格 Bernoulli(p=0.003)**：全图 ~236 格中位（0.26%，CV 0.07、0% 零险地），孤立点、比 familyKeep（5.4%）稀疏 ~20×。⚠️ **不用平滑 value-noise**：300×300 图上低频噪声只 ~18 格点，`noise>阈值` 会让险地数种子间 0→6,436 剧烈波动并聚成大块 blob（详见 §19.5 + ECONOMY_NUMBERS §13-SLG-STRONGHOLD）。
- **数值**：`STRONGHOLD_GARRISON_PER_LEVEL=360`（满级 1800 兵力当量，远超 `GARRISON_PER_TILE=500`/`npcGarrison` 满级 600）；`strongholdGarrison(level)`；`STRONGHOLD_LOOT_PER_LEVEL=5000`（攻克一次性奖励，按格等级 × 资源种类）。**1800 守军经合成步兵 ≈60 单位（纵深 ~6），叠加攻方 ≤2000 兵 ≈67 单位（纵深 ~7）< 棋盘 16 行 → 正常规模权威引擎可跑**；仅鲸鱼级超大军（>5000 兵）溢出走廉价兜底。零充值玩家满兵也因防守占优（基地 + 超时判守方胜）几乎打不过，须养成强军（科技/装备布阵）方可攻克——兑现 SLG7 卖战力 / U7 碾压级 / §3.1「非常难攻占」。

### 19.2 worldsvc（`service.ts`）

- **`startMarch` 门控**：occupy 无主险地 → `TILE_OCCUPIED`（须围攻）；sweep 险地 → `TILE_OCCUPIED`（须围攻）；attack 放行**无主险地**（PvE，`defenderId` 留空 → 不推 `under_attack`，NPC 无预警）；落城（`joinWorld`/`relocateBase`）险地 → `BAD_REQUEST`；被动迁城重生候选格扫描跳过险地。
- **`applyStrongholdSiege`**（attack 到点，`applySiege` 顶部拦截「无主 + 程序化 stronghold」分支）：按格等级派生系统守军 `synthesizeArmy(strongholdGarrison(level),'defender')` + 高基地（`buildSiegeLevel` 按 tileLevel 派生），走权威 `runSiegeBattle`（坏布阵/异常 → 廉价 `resolveSiege` 兜底，replay=null）。
  - **攻克胜**：写 `territory` TileDoc（`ownerId`=攻方，`garrison`=残存折回，level/resType 沿用程序化）+ 一次性奖励并入攻方资源池（封顶 `RESOURCE_CAP`）+ `recomputeYield` + `applyNationChange`（首府格易主立国）+ `bumpFamilyActivity` + `recordSiege`（attacker_win，无 defenderId，replay 可观战重播）+ 推 `march_update`/`siege_result`/`tile_update` + 对视野观察者可见。
  - **攻克败**：攻方残存撤退回师折回兵力池（出征已扣兵，阵亡永久损失）；NPC 守军不持久（程序化层不落库，下次攻打重置满守军）；`recordSiege`（defender_win）+ 推送。防守方全程为 NPC，无掠夺玩家、无保护罩。

### 19.3 契约 + 客户端

- **契约**：`openapi-world.yml` `WorldTile.type` enum 加 `stronghold`；客户端 `openapi-world.ts` 重新生成（`npm run rest:gen`）。proto `type` 本就是 string 字段（非 enum），无需 proto 再生成。
- **客户端**（`WorldMapScene.ts`）：`TERRAIN_COLORS.stronghold=0x8a4a4a`（暗红石垒）；点击未占领险地 → 弹「险地」面板（围攻挂队 `showAttackTeamPicker` + 侦察 + 关闭，无直占/扫荡）；占领后转 territory 走既有 mine 分支。i18n `world.stronghold`/`world.strongholdHint` 三语（zh/en/de）。

### 19.4 测试

- `worldsvc/test/stronghold.e2e.test.ts`（5 例）：生成（满级 + resType + 守军 >500）/ 直占·扫荡拦截 / 落城拦截 / 攻克胜（大军 → 占领 territory + mine + 残存驻军 + 奖励到账 + sieges attacker_win 无 defenderId + siege_result/tile_update 推送 + territoryCount+1）/ 攻克败（不占领 + 残兵回师 + sieges defender_win + 无奖励）。全 worldsvc 套件 127+5 绿。

### 19.5 DRAFT / 后续

- ~~数值调参：`STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL` 待战力模拟细化~~ **✅ 战力模拟已补测 CLOSED（2026-07-16）**：见 §27。生成密度已定案（见下）。**✅ 生成密度已修复 CLOSED（2026-07-02，econ-sim 险地轨）**：原 `strongholdFreq=1/70` value-noise 在 300×300 图上只 ~18 格点，险地数种子间 **0→6,436**（CV 1.02，14% 零险地，聚成 blob 均值 862 格），占领发的持久 `binding` 在高数量种子破 A 轨 15% 稀释判据。**修复**：生成层换逐格哈希 `rand2(x,y,seed^0x0555) > 0.997`（`shared/slg.ts`，merge-first 已合 main），删 `strongholdFreq`。**修复后实测**：236 中位（197→282，CV 0.07、0% 零险地、0.26% 命中意图）、平均 blob 1.0 格（孤立点）、binding 稀释 max 世界×100% 占领仅 2.8% ≪ 15%——①②③全 PASS。守军/掠夺量本身 sane。详见 [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) §9 险地轨 + [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md) §13-SLG-STRONGHOLD。
- **攻克奖励材料 ✅（2026-06-21，随 G4 §15.6 落地）**：除单资源即时入袋，额外掉落养成材料 `binding`（`strongholdMaterialLoot(level)` 按等级线性，**DRAFT** `STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4`）——攻克胜经 `meta.grantMaterial` 发到 `SaveData.materials` 养成统一池（跨进程 best-effort，orderId=`stronghold_loot:{worldId}:{toTile}:{arriveAt}` 幂等），攻克败不掉。复用 G4 打通的材料通道，险地养成价值兑现。装备掉落仍待装备库 E2~E4。worldsvc `stronghold.e2e` 加掉落断言（胜掉/败不掉/orderId 幂等键）。
- 险地系统守军当前为合成步兵；后续可换更强兵种/自定义系统布阵 config（§16.5 满血容量表/兵种当量调参后）。
- **⚠️ 未解决 gap：核心州永远 0 险地（2026-07-22 体检发现）**：`mapgen.ts:465` 生成险地的门控是 `distToCap > SLG_GEN.strongholdMinDistRatio`（=0.25，`core.ts:277`，距最近州府的归一化距离）。但**核心州**（core province）的州府就在地图中心，核心州半径 `PROVINCE_CORE_RADIUS_RATIO=0.11`（`province.ts`）< 0.25 → 核心州内所有格子 `distToCap ≤ 0.11` 恒不满足门控 → **核心州永不生成险地**。这与「核心州是终局争夺焦点」的设计意图相悖（本该险地更密）。修复方向：门控改为「距**本州州府**的距离」或对核心州单列阈值。**尚未修复**，登记待办。

---

## 20. G6 多 shard 运行时调度实现记录（2026-06-21，§2.2/§17.8 收口）

> §17.8 只到「数据地基 + 纯算法」（`allocateSectsToShards` + `seasonResults`）。本节兑现 §17.12 单列的**运行时调度**：多 shard 实际开区编排、按宗门强弱均衡分配落库、玩家 join 自动路由（宗门>家族>单随）、人口溢出开新区、跨区隔离巡检。**契约前提（2026-06-21 拍板）**见 §20.1。

### 20.1 三项契约前提（消解 §17.8 鸡生蛋）

| # | 问题 | 结论 |
|---|---|---|
| **R1 sect 赛季作用域** | sects `_id=s:{worldId}:{TAG}` 赛季级，`resetSeason` 删 `sects` + unset `families.sectId` → 新赛季 open 时**无 sect 可分配**。 | 跨季持久社交单位 = **family**（`resetSeason` 保编制只清赛季态）。均衡分配在**上季 settle 时快照**，落 `shardAllocations.familyShard`（上季 familyId→本季 shardIndex），下季 join 时按账号上季家族查表路由。`allocateSectsToShards` 仍按 sect 强弱分配，但展开到**成员家族粒度**落库（同宗门家族同 shard）。 |
| **R2 分配输入数据源** | 上季 sect 成员家族名单 `seasonResults.ranking` 此前不记。 | `settleSeason` 扩展：sect scope 排名条目记 `memberFamilyIds`（settle 时 families 仍带 sectId，免二次查）。下季 `allocateNextSeason` 读上季 `seasonResults`（跨 shard）构造 `SectStrength[]` + 展开 familyShard。 |
| **R3 join 路由入口** | 客户端硬编码 `worldId`（`world:1:0`，格式都不对），无「按赛季选服」入口。 | 新增玩家端 `POST /world/season/join {season,x,y}` → 服务端 `resolveShardForJoin` 解析 worldId（粘性>家族查表>最空开区>溢出开新区）→ joinWorld。`PlayerWorldView` 加 `worldId` 字段回传解析结果（客户端据此进图）。`worldShardId(season,shard)=s{season}-{shard}` 统一 id 格式。 |

### 20.2 数据模型

- **新集合 `shardAllocations`**（world 库）`ShardAllocationDoc`：
  ```
  _id: `s{season}`          // 本赛季分配（下季 join 路由查表）
  season, shardCount, capacity
  familyShard: Record<familyId, shardIndex>   // 上季 familyId → 本季 shardIndex（同宗门家族同区；散家族补位）
  createdAt
  ```
  索引 `{season:1}`。`shardCount` 可因溢出**递增**（`allocateNextSeason` 写初值，`resolveShardForJoin` 溢出时 `$inc`）。
- **`SeasonResultDoc.ranking[]` 扩展**：sect scope 条目加 `memberFamilyIds?: string[]`（R2）。

### 20.3 `@nw/shared`（`slg.ts`）

- `worldShardId(season, shard) = `s${season}-${shard}``（id 格式权威，替客户端硬编码 + 与 `WorldDoc._id` 对齐）。
- `shardCountForPopulation(totalPlayers, capacity) = max(1, ceil(total / max(1,capacity)))`（§17.8 第 2 步抽函数，可单测）。
- 复用既有 `sectStrengthScore` / `allocateSectsToShards`（蛇形均衡）。

### 20.4 worldsvc（`service.ts`）

- **`settleSeason` 扩展**：sect scope 排名条目落 `memberFamilyIds`（复用已查的 `memberFams`，无新查询）。family/solo scope 不记（无需展开）。
- **`allocateNextSeason(season, capacity)`**（admin 编排开区）：
  1. 读上季 `season-1` 全 shard `seasonResults`；sect 条目 → `SectStrength[]`（`lastSeasonRank`=rank、`memberFamilyCount`=memberFamilyIds.length、`prosperity`）+ 收集每 sect 成员 familyIds。
  2. `totalPlayers` = 上季全 shard `familyMembers` 计数（首季无 → 0 → shardCount=1）。`shardCount = shardCountForPopulation(totalPlayers, capacity)`。
  3. `assignment = allocateSectsToShards(SectStrength[], shardCount)`（sect→shardIdx）。
  4. 展开 `familyShard`：sect 成员家族随 sect 进同 shard；散家族（上季有族无门）按**最少家族数 shard 补位**（确定性贪心，均摊）。
  5. upsert `shardAllocations` `s{season}`；对 `i∈[0,shardCount)` 调 `openSeason(worldShardId(season,i), season, i, capacity)`。
  6. 返回 `{ shardCount, worldIds, allocatedFamilies }`。幂等：openSeason `$setOnInsert` + alloc upsert，重调不重复建。
- **`resolveShardForJoin(season, accountId)`**（私有）：
  1. **粘性**：账号已在某 `s{season}-*` 有 `playerWorld` → 返回该 worldId（防跨 shard 双开）。
  2. **家族查表**：`shardAllocations[s{season}].familyShard[上季家族]` 命中 → `worldShardId(season, idx)`（须该 world 已 open/active 且未满；满则落溢出）。账号上季家族 = `familyMembers`（`s{season-1}-*` 内 accountId）。
  3. **最空开区**：`s{season}-*` 中 open/active 且 `population<capacity` 的最空者。
  4. **溢出开新区**：无可用 → `idx=shardAllocations.shardCount`（无 alloc 则 = 现有 world 数），`openSeason(worldShardId(season,idx),…)` + `$inc shardCount`，返回新 worldId。
- **`joinSeason(season, accountId, x, y)`**：`resolveShardForJoin` → `joinWorld(worldId,…)`；回传 `PlayerWorldView`（含 `worldId`）。`WORLD_FULL` 兜底再解析一次（并发满员重试一跳）。
- **`patrolShardIsolation()`**（admin 只读巡检）：扫描跨区泄漏 →
  - `crossWorldMarches`：`marches` 中 `fromTile`/`toTile` 前缀 ≠ `worldId` 的（行军引用他区格）。
  - `multiShardPlayers`：同 season 跨多个 `worldId` 有 `playerWorld` 的账号（双开）。
  - `orphanTiles`：`tiles._id` 前缀 ≠ `worldId` 字段。
  返回 `{ scannedWorlds, crossWorldMarches, multiShardPlayers, orphanTiles }`（各含 count + ≤20 样本）。纯读不改。
- **`getMe` / `joinWorld` 视图**：补 `worldId`（解析结果回传客户端，未进入时也带所查 shard）。
- **`openSeason` upsert 修复（顺带）**：原 `status:'open'` 同时写 `$setOnInsert` 与 `$set` → Mongo upsert 报 `Updating the path 'status' would create a conflict`（既有潜伏 bug，此前无测试跑 openSeason 真实 upsert 路径，G6 多 shard 开区首次密集触发）。修为 `status` 仅入 `$set`（首插 + 重开都置 open），`$setOnInsert` 留不可变初始字段。

### 20.5 契约 + 客户端

- **`openapi-world.yml`**：`PlayerWorldView` 加 `worldId: string`（join-season 回传解析 shard，客户端进图依据）；`npm run rest:gen` 重生成 `openapi-world.ts`。新端点路径不入 openapi（`WorldApiClient` 手写路径，仅 DTO 类型来自契约）。
- **`WorldApiClient`**：`resolveSeason(season): Promise<{worldId}>`（`POST /world/season/resolve`，**只解析不落城**，进图前拿 worldId）+ `joinSeason(season,x,y): Promise<PlayerWorldView>`（`POST /world/season/join`，解析+落城，读回 `.worldId`）。**两步分离**：客户端浏览地图须先有 worldId（`WorldMapScene` 用 `worldId` 拉图 + tile pick 时 `joinWorld` 落城），故进图走 resolve；落城仍走既有 `joinWorld(worldId,x,y)`（落城在解析出的同一 shard）。`joinSeason`=resolve+落城一体原语（自动落城/API 完整性 + e2e 覆盖）。
- **`createAppCore.ts`**：去 `worldId='world:1:0'` 硬编码 → `goWorldEntry` 先 `resolveSeason(CURRENT_SEASON)` 拿真实 `s{season}-{shard}` → `goWorldMap(worldApi, worldId)`；解析失败兜底 `s{CURRENT_SEASON}-0`。`CURRENT_SEASON` 暂客户端常量（赛季元数据下发待 S11 天梯赛季打通后接，§20.8）。

### 20.6 httpApi 端点

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /admin/world/allocate {season,capacity}` | X-Internal-Key | `allocateNextSeason`，开 N 区 + 落 familyShard（admin 新赛季操作） |
| `GET /admin/world/patrol` | X-Internal-Key | `patrolShardIsolation` 巡检报告 |
| `POST /world/season/resolve {season}` | 玩家 JWT | `resolveSeasonShard` 只解析不落城（进图前拿 worldId） |
| `POST /world/season/join {season,x,y}` | 玩家 JWT | `joinSeason` 自动路由进区（解析+落城一体） |

### 20.7 测试（`shard.e2e.test.ts`）

- `shardCountForPopulation` / `allocateSectsToShards` 已有纯函数单测（§17.11）；本节加 `worldShardId`。
- **e2e（真实 Mongo）**：
  - allocate 首季（无上季 results）→ shardCount=1 + 开 `s{season}-0`。
  - allocate 次季：造上季两 shard `seasonResults`（两 sect 强弱差），断言 `familyShard` 同宗门家族同 shard + 蛇形均衡（强弱搭配）+ 开足 shardCount 个 world。
  - join 路由：①粘性（重 join 同 shard）②家族查表（上季同族两账号 → 同 shard）③散人最空开区 ④溢出（填满 → 自动开新区 + shardCount $inc）。
  - patrol：植入跨区 march / 双开 playerWorld → 巡检命中；干净库 → 全 0。
  - admin 端点 X-Internal-Key 门控（无 key 401，JWT 玩家调 allocate 被拒）。

### 20.8 DRAFT / 后续

- **散家族补位 + 单随路由**当前为「最少家族数/最空开区」确定性贪心；大规模下家族大小方差大时可换按成员数加权（待压测 U12）。
- **赛季元数据下发**：`CURRENT_SEASON` 客户端暂常量；待 S11 天梯赛季打通后由 metaserver 下发当前赛季号（SLG 赛季与天梯赛季是否同步另议）。
- ~~**跨区迁移（赛季中）**：本节只做 join 时一次性路由；赛季中主动转区/合区（人口骤降合并低活 shard）仍待规模化运营专项。~~ ✅ **已设计+落地（2026-07-16，§28）**：个人转区 + 运营合区。
- **`resolveShardForJoin` 单点**：高并发开服瞬时大量 join 经 worldsvc 单进程，与 U12 march 调度单点同源，规模化需选主/分片。

---

