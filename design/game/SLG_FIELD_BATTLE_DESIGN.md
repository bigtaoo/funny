# SLG 实时野战遭遇系统设计（Field Battle）

> 状态：**Accepted** — 2026-07-24 起草并拍板（worktree `feat/field-battle`）；§8 待审点全部采用提议默认。
> 关联：[`SLG_DESIGN.md`](SLG_DESIGN.md) §4（行军/占领）、§5.4（占领行军=PvE 战斗）、[`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 野外驻扎 v1（2026-07-23）。本文档是该 v1 的 **v2 升级**，并新增建筑层。
> ADR：**[ADR-051](../DECISIONS_ADR-041-069.md#adr-051-slg-实时野战遭遇系统停留驻扎拆分--redis-逐格行军--玩家建筑层--accepted--2026-07-24)** 已写入（Accepted，2026-07-24）——本行此前一直写「拟记 ADR-051（审定后写入）」，订正 2026-09-03。

---

## 1. 背景与动机

### 1.1 触发问题
玩家用队伍走到一块中立地上「停留」后，想「就地占领」这块地，但占领选择器**根本不列出这支队伍**——因为当前实现把所有停在野外的队伍一律当成「忙碌」，排除出可选列表（[`WorldMapNet.ts:163`](../../client/src/scenes/worldmap/WorldMapNet.ts) 把 `stationed` 队伍塞进 `busyTeamIds`）。

### 1.2 现状是个「四不像」
2026-07-23 引入的野外驻扎 v1 只有**一个** `stationed` 状态，经「移动到此」（`kind='move'`）抵达即进入。它：
- **忙碌得像驻扎**：锁住队伍槽，不能接新指令。
- **却连本格都不防守**：march/siege 结算链路（`combatSiege/arrival.ts` 等）**从不读取 `stationed` 集合**——敌军打到它脚下那格，它都不作为防守方参战。纯粹是「占位 + 渲染 idle 小人 + 锁队伍」。

`SLG_DESIGN_LOG.md` 野外驻扎 v1「已知限制①」已记录：驻留在未占领中立地上的队伍不参与该格防御。本设计即消除该限制。

### 1.3 用户拍板的目标模型（2026-07-24 澄清）
把单一态**拆成两态**，并首次把野外队伍接入**实时**战斗；同时新增**玩家建造的地图建筑层**（箭塔 / 必拆除阻挡）。

---

## 2. 概念模型

### 2.1 停留 idle vs 驻扎 garrison

| | 能否接新指令 | 战斗行为 | 队伍槽 |
|---|---|---|---|
| **停留 idle** | ✅ 空闲：可就地占领、再移动 | 仅**本格**被动应战（敌军踏入本格才打） | 占用（但不算 busy） |
| **驻扎 garrison** | ❌ 忙碌 | 主动防守**本格 + 周围 8 格 = 9 格**，拦截路过敌军 | 占用且 busy |

- **升级方式（拍板）**：**发兵时选定意图**。移动弹窗提供两个动作——「移动到此（停留）」与「移动并驻扎」——抵达即进入对应态。（不做「抵达后再手动转驻扎」的二次操作。）
- 停留队伍**放出** `busyTeamIds`（前端）与服务端 `TEAM_BUSY` 门禁；驻扎队伍保持忙碌。
- 两态都跨重载存活，持久化于 `stationed` 集合（沿用 v1），新增 `mode` 字段区分。

### 2.2 遭遇结果（拍板）
交战后**胜方带残兵继续原行动**（行军的继续走完剩余路径、驻扎的留在原格），**不因交战停下**。败方生还部队按现有「折返/永损」规则处理。

### 2.3 建筑层（玩家建造）
- 一格 = **地形（程序化/基线层）+ 可选建筑（玩家建造的叠加层）**。当前 schema 只有 `watchtower?: boolean` 一个叠加位，本设计泛化成通用 `structure`。
- **箭塔 arrowTower**：玩家建造；敌军踏入其**周围 9 格**射程即**掉血、不拦停**（多次路过多次掉血，像个自动削弱塔）；有耐久、可被攻毁。
- **必拆除阻挡 blocker**：玩家建造的硬阻挡，敌军须**攻毁**方可通行（参照敌方主城「挡路但可作终点攻打」范式）；对建造者及其家族放行、只挡敌方。
- 可绕开的阻挡沿用现有 `obstacle`（山/河，硬阻挡绕路）/ 未占领桥栈道（软阻挡）范式，**本设计不改**。

---

## 3. 核心架构：实时野战遭遇引擎

### 3.1 与现状的根本差异
现状行军模型**非实时**：`startMarch` 一次性算好完整 A* 路径（[`combatMarch.ts:40`](../../server/worldsvc/src/combatMarch.ts) `computeMarchPath`），**丢弃路径**，只调度**一个**到点抵达事件（`arriveAt`），抵达即 `findOneAndDelete` 整条删除。途中无「当前位置」，客户端全靠线性插值（[`siege.ts:163`](../../server/shared/src/slg/march.ts) `marchInterpPos`）假装在动。

实时拦截要求服务端**任意时刻知道每支野外队伍在哪一格**。

### 3.2 位置权威搬进 Redis（拍板方向）
> 用户拍板：把地图上所有不在基地内的队伍放进 Redis，行军队伍更新位置时判断是否与敌军相遇。**不扫 Mongo。**

新增两个 Redis 结构（per world）：

1. **占格索引 `occ:{worldId}`** — 记录每支野外队伍**当前占据的格**及占据区间。
   - 建议：Hash，field=`tileId`，value=`{kind, teamId, ownerId, familyId, leaveAt}`（JSON）。
   - 停留/驻扎队伍：`leaveAt = ∞`（直到移动/召回）。行军队伍：`leaveAt = 该格的踏出时刻`。
   - 一格可能被多支队伍先后占据；相遇判定用「占据区间重叠」（见 §3.4）。

2. **防区/射程反向索引 `cover:{worldId}`** — 把驻扎队伍与箭塔的 **9 格覆盖**预先摊平成「格 → 覆盖源集合」。
   - 建议：Set per tile，`cover:{worldId}:{tileId}` = `{garrison:teamId | tower:structureId, ownerId, familyId}` 集合。
   - 驻扎/建塔时写入其 `baseFootprintCells` 9 格（[`core.ts:142`](../../server/shared/src/slg/core.ts)）；召回/拆除时删除。

如此，「谁覆盖某格」是 **O(1) 查表**，无全图扫描。

### 3.3 行军改为逐格步进
- **MarchDoc 持久化路径**：新增 `path: {x,y}[]`（A* 结果不再丢弃）、`departAt`。每格踏入时刻 `enterTime_i = departAt + Σ(前 i 格时长)`（本期按 `MARCH_SPEED_SEC_PER_TILE` 均匀；疲劳不影响时长，仅影响战力，见 ADR-047）。
- **步进事件**：不再是「一个到点事件」，而是行军沿途每格一个「步进事件」。为控制调度量，**每次只调度下一步**（步进时更新 Redis 占格 + 做踏格检查 + 调度下一步），到终点执行原 `applyArrival` 逻辑。
- ~~调度基础设施沿用 Redis ZSET（`scheduleMarch`），score 改为下一步的 `enterTime`~~ **订正（2026-07-27 审计）**：实际落地并非这套 Redis ZSET 方案——`scheduleMarch`/`zrangebyscore` 从未真正接上（写了没人读），已整段删除。步进调度实际靠 `MarchDoc.nextStepAt` + [`scheduler.ts:22`](../../server/worldsvc/src/scheduler.ts) 同一个 2s tick 的 Mongo 索引扫描（`{worldId,status}`/`{nextStepAt}`），与到点判定同一套机制，并非「不扫 Mongo 全表」的 O(1) 弹出。

> **性能注记**：长途行军事件数 = 路径格数（1500×1500 图下横断约数百格）。事件驱动、每步 O(1)，但总事件量比现状（1 事件/行军）显著上升，登记为**监控项**；如压力过大，退化方案为「粗粒度步进」（每 N 格一检查 + 到达前精算拦截点）。

### 3.4 统一「踏格检查」（三场景合一）
用户把交战归纳为三场景，本质是**同一个检查**：**一支队伍踏上新格 C 时，查 C 上/覆盖 C 的敌方存在**。

队伍步进到格 C 时，依次查：
1. **`occ:{worldId}[C]`**：C 上有无**尚未移出**（`leaveAt > now`）的**敌方**队伍 → 开战。
   - 覆盖**场景 1**（撞上敌方停留队伍）与**场景 2**（两支行军在同格相遇：先到者 `leaveAt` 未到，后到者踏入即撞上）。
2. **`cover:{worldId}:{C}`**：C 被敌方**驻扎队伍**防区或**箭塔**射程覆盖 →
   - 驻扎 → **场景 3**：驻扎队伍拦截，走 `runSiegeBattle`。
   - 箭塔 → **掉血不拦停**（见 §5.2）。
3. **（开放项，见 §8-O1）** C 是否为带 `garrison` 的敌方领地——是否触发 pass-through 战斗，待定。

**相遇时序（拍板）**：用**占据区间**判定（踏入→踏出），不要求同一毫秒同格。仅**踏入方**做检查即可（先到方 `leaveAt` 未到就一定被后到方查到），故每步 O(1)、无全局扫描。
> 已知边缘：两队在相邻格**对穿**（A: X→Y 同时 B: Y→X）不共格、不触发——SLG 类型常态，接受。

### 3.5 战斗结算复用
所有遭遇战全走现成确定性引擎 **`runSiegeBattle`**（[`siegeEngine.ts:367`](../../server/worldsvc/src/siegeEngine.ts)），输入双方 army、`seed`（由遭遇实例 id 派生，可回放），输出 `{outcome, attackerSurvivors, defenderSurvivors}`。士气缩放、生还/永损沿用现有 siege 规则（ADR-047）。廉价线性回退 `resolveSiege` 亦沿用。

---

## 4. 停留 / 驻扎 状态（数据 + 流程）

### 4.1 数据改动
- **`StationedDoc`**（[`db.ts:364`](../../server/worldsvc/src/db.ts)）+ `StationedView`（openapi-world）新增 `mode: 'idle' | 'garrison'`。
- `move` 抵达（[`combatMarch.ts:536`](../../server/worldsvc/src/combatMarch.ts) `applyMove`）按发兵意图写入 `mode`。
- 占领打赢后留守（[`occupation.ts:399`](../../server/worldsvc/src/combatSiege/occupation.ts) `settleOccupation`）默认写 `mode='idle'`（占完地就地待命，可再动）。

### 4.2 忙碌门禁
- **前端**（[`WorldMapNet.ts:160`](../../client/src/scenes/worldmap/WorldMapNet.ts) `busyTeamIds`）：只把 `mode==='garrison'` 的 stationed 队伍计入 busy；`idle` 放出。
- **服务端**（`combatMarch.ts` `TEAM_BUSY` 校验）：同理，`idle` 队伍可再派发 `move`/`occupy`。

### 4.3 就地占领（解决 §1.1）
- 停留（idle）队伍站在中立格上时，该格菜单出现「就地占领」。
- 服务端 `occupy` 现从主城 `mainBaseTile` 发兵（[`WorldMapNet.ts:197`](../../client/src/scenes/worldmap/WorldMapNet.ts)）。新增**从驻留点原地发起 occupy** 路径：`fromTile = toTile = 队伍当前格`，路径长度 0、无行军，直接进 §5.4 占领 PvE 流程（用该 stationed 队伍的 army）。
- 连地规则（ADR-039）照旧校验（就地格通常已与自身领地相邻或就是自身停留点，具体校验点复用现有 `startMarch` 逻辑）。

### 4.4 客户端（近实时野战视图）
- 按视野把**敌方**野外队伍（行军/停留/驻扎）近实时画出——玩家据此「算好路径去拦截」。
- 现状仅渲染我方 stationed idle 小人（[`fog.ts:389`](../../client/src/scenes/worldmap/WorldMapRenderer/fog.ts) `syncStationedTokens`）+ march 插值。需扩展：敌方野外队伍视图（受雾/视野约束）+ 拉取频率提升。
- 停留/驻扎两态渲染区分（如驻扎显示 9 格防区光圈）。

---

## 5. 建筑层（玩家建造）

### 5.1 数据模型
- `TileDoc` 新增通用叠加位 `structure?: { kind: 'arrowTower' | 'blocker', level, hp, hpMax, ownerId, familyId, ... }`（泛化现有 `watchtower?: boolean`；`watchtower` 可后续并入或并存）。
- 程序化 `ProceduralTile` **不含** structure（建筑纯运行时落库）。
- 建造入口参照现有瞭望塔（[`WorldMapInput.ts:117`](../../client/src/scenes/worldmap/WorldMapInput.ts) / [`WorldMapNet.ts:332`](../../client/src/scenes/worldmap/WorldMapNet.ts) `WATCHTOWER_COST`）。

### 5.2 箭塔 arrowTower
- **射程**：周围 **9 格**（`baseFootprintCells`），写入 `cover` 反向索引。
- **攻击**：敌军踏入射程 → **掉血、不拦停、不改路径**；同一支行军每踏入一格覆盖区就结算一次。
- **伤害**（DRAFT，进 `config.ts` / `shared/src/slg`）：`min(passThroughTroops × ARROW_TOWER_DMG_RATIO, ARROW_TOWER_DMG_CAP)` 或按塔等级的固定值；具体待经济核验。掉血直接扣行军 army（复用 `scaleArmyByRatio` / 直接减兵）。
- **耐久 & 摧毁**：`hp/hpMax`；可被 `attack` 攻毁（攻毁后从 `cover` 移除）。
- **建造限制（提议默认，§8-O2）**：只能建在**己方/家族领地**格。

### 5.3 必拆除阻挡 blocker
- 玩家建造的硬阻挡：敌军须攻毁方可通行；对建造者+家族放行。
- **寻路接入**：`walkable`（[`march.ts:79`](../../server/shared/src/slg/march.ts)）现只看程序化地形层。需像 `blockedBaseKeys` 那样，把敌方 blocker 格作为**路径阻挡（可作终点攻打）**预取传入 `findMarchPath`。
- **建造限制（提议默认，§8-O2）**：只能建在己方/家族领地格，避免满图恶意卡点。

---

## 6. 契约 / API 改动清单（预估）

**服务端**
- `db.ts`：`StationedDoc.mode`；`MarchDoc.path`/`departAt`（若未有）；`TileDoc.structure`。
- `combatMarch.ts`：`move` 记录意图 mode；逐格步进（路径持久化 + 步进事件 + 踏格检查）；就地 occupy 路径；`TEAM_BUSY` 按 mode 放行。
- 新增遭遇结算模块（`combatSiege/encounter.ts` 之类）：踏格检查 + `runSiegeBattle`。
- Redis：`occ` / `cover` 结构 + 读写工具（`core/push.ts` 扩展或新文件）。
- `territory.ts`：弃地/易主时清 `stationed` + `occ` + `cover`（消除 v1「已知限制②」）。
- 建筑：建造/拆除/攻毁 API + `cover` 维护 + `walkable` 接入。
- `httpApi.ts` / `service.ts` / `combat.ts`：转发新端点；`openapi-world.yml` 加 `StationedView.mode`、敌方野外队伍视图、建筑 schema/端点。

**客户端**
- `rest:gen` 重生成契约；`WorldApiClient` 加新端点。
- `WorldMapContext`/`WorldMapNet`：拉取敌方野外队伍、建筑；busy 门禁按 mode。
- `WorldMapInput`：移动弹窗两意图、就地占领、建塔/建阻挡、解除驻扎（若做）。
- `WorldMapRenderer`：敌方野外队伍渲染、驻扎防区、箭塔/阻挡贴图（参照 `building_*` 图集）。
- 三语言词条（zh/en/de）。

---

## 7. 分阶段实现计划

> 建筑层**架构现在设计进去**，实现放核心引擎之后（都插在同一「踏格检查」里，先验证引擎再堆建筑，风险最低）。

- **P1 — 实时行军基础** ✅（2026-07-24 完成）：MarchDoc 持久化 `path`/`stepIndex`/`nextStepAt`（+ shared `marchStepArriveAt`）；`processDueArrivals` 扫 `nextStepAt`（legacy/return 腿回退 `arriveAt`），`advanceMarch` 逐格步进、仅在终格 settle（到达时刻不变 = path[last]）；每跳更新 Redis `occ` 占格索引（`world:{w}:occ`，field=tileId，vacate 旧格只留当前格），到达/召回清除；召回 `$unset` 步进游标 → 返程走 legacy 单一到达（途中不遭遇，按约定）。验证：全量 worldsvc 287 passed（2 个既有 pathfinding 种子失败无关），新增 field-occupancy e2e 覆盖 occ set/clear 生命周期。行为对齐现状。
- **P2 — 遭遇引擎**：
  - **P2a ✅（2026-07-24）**：把停留/驻扎队伍也注册进 `occ` 索引（`OccEntry` 泛化 `kind: march|stationed`；`applyMove`/`settleOccupation` 写入 leaveAt=∞，`recallStationed`/`abandonTile` 清除）——场景1检测的前提。含 field-occupancy e2e 覆盖停留注册/召回清除。
  - **P2b ✅（2026-07-24）**：`advanceMarch` 踏格时先 `getOccupancy(cell)`（新增于 core/push），命中 `leaveAt>now` 的**敌方**（非同 owner/同 familyId）占格 → 新 `combatSiege/encounter.ts` 的 `resolveFieldEncounter` 用 `runSiegeBattle`（`defenderBaseLevel:0` 纯军队对撞，参照 base-wave 模型）结算。双方军队构建复用 `resolveCardArmy/synthesizeArmy/scaleArmyByRatio + toDefenderFormation`；进攻方（踏入的行军）带**士气缩放 + 卡牌蓝图注入**，防守方用基础蓝图（v1，与 `applyBaseSiege` 同简化）；卡牌军两边各自 `meta.getSaveFields`。生还双向传播：卡牌走 `computeCardStateUpdates` 写 cardState、flat 走 `refundTroops`（进攻方败）/ 直接改 `StationedDoc.troops`/`MarchDoc.troops`（防守方胜）；**胜方带残兵继续原行动**（`advanceMarch` 把进攻方残兵持久化回 MarchDoc 后继续步进，或在终格 settle），败方 doc + occ 移除。场景1（撞停留）+ 场景2（两行军同格，先到者 occ `leaveAt` 未到）。友军（同 owner/同 familyId）过格不战、且**不覆盖**其 occ（避免把驻留友军挤出索引）。回放种子由 `${marchId}:${defenderId}:${tile}` 派生；SiegeDoc 记在**遭遇格**。含 field-encounter e2e 4 例（场景1 胜/负、场景2 胜、友军过格）。全量 worldsvc 294 passed（2 个既有 pathfinding 失败无关）。
- **P3 — 停留/驻扎拆分**：
  - **P3a ✅（2026-07-24）**：`StationedDoc.mode`(idle/garrison) + `StationedView.mode` + `MarchDoc.stationMode`（发兵意图，`POST /world/march` body `stationMode:'garrison'`，穿 service/combat/httpApi + openapi-world）；`applyMove` 按意图写 mode，garrison 额外注册 `cover` 反向索引（`world:{w}:cover`，field=被覆盖格 → `{sourceTile→CoverEntry}` map，摊平 `baseFootprintCells` 9 格，见 core/push `addCover/removeCover/getCover`）；idle（含 `settleOccupation` 占领后留守、默认）**不**注册 cover；`recallStationed`/`abandonTile` 清 garrison 的 cover。含 field-garrison e2e（garrison 注册 9 格/召回清除、idle 不注册）。
  - **P3b ✅（2026-07-24）**：`advanceMarch` 踏格在 occ 检查（场景1/2）之后加 `cover` 检查（场景3）——命中敌方 garrison 覆盖格 → 以该 garrison 的驻扎点（sourceTile）为防守方走 `resolveFieldEncounter` 拦截；胜方带残兵继续，garrison 败则删 doc + 清 occ + 清 cover（9 格）。一格一战（occ 优先）。友军覆盖不拦。含 field-encounter e2e 场景3 胜/负 2 例。
  - **P3c ✅（2026-07-24，范围 2026-08-08 扩至 attack）**：idle 队伍再指挥 + 就地占领——**复用 `startMarch`，不新增端点/契约**。门禁放宽：`busyStationed` 只在 `mode==='garrison'` 时锁队伍，idle 队伍对 `move`/`occupy`/**`attack`**（2026-08-08 新增，见下）放行（`combatMarch/command.ts` 派生 `idleRedispatch`）；客户端 `busyTeamIds`（`WorldMapNet.ts`）同步只认 garrison（**顺带补回 P3a 漏做的 client 契约重生成**——`StationedView.mode` 早已在 openapi-world 但 `client/src/net/openapi-world.ts` 未重生成）。再指挥路径：idle 队伍的发兵**原点强制回落到驻留格**（`fromX/fromY` 覆盖为 `StationedDoc.x/y`，忽略客户端传入的原点——故即便沿用「从主城发兵」的旧 UI 也能正确从野外出发，消除 §1.1 触发的耦合风险），军队/兵力**取驻留快照**（反映 P2b/P3b 野战减员，同 `recallStationed`），跳过己方领地校验与兵池扣减，插 MarchDoc **前**原子 `findOneAndDelete` 驻留 doc + 清 occ（兼作队伍锁，防并发重复派发）。就地占领（§4.3，解决 §1.1）= `toTile===fromTile` 的零距离 `occupy`：长度 1 路径即时到达，走原 `applyOccupy` 管线打本格 NPC 驻军 → 占领 hold → settle 后该格易主且队伍**留守 idle**。连地（ADR-039）照旧校验。含 field-redispatch e2e 3 例（再指挥 move + 就地占领 + garrison 仍锁死）；`teams.e2e` 中「停留=锁死」的旧断言按新语义更新（idle 不再锁，仅「原地移动到本格」因一格一泊被拒）。全量 worldsvc 绿。
    - **范围扩展（2026-08-08，用户明确要求，账号 tao）**：P3c 原设计只放行 `move`/`occupy`——`attack` 故意留在锁死名单里（idleRedispatch 的 kind 判断没列 `'attack'`）。这天用户报告"进攻一个看着空闲的队伍却报 TEAM_BUSY"，排查后发现队伍其实是停留在外的野战格（占领刚打完），这正是原设计"attack 不放行"的预期表现——但用户要的结果是**进攻应该跟占地待遇一致**：停留在外的队伍也该能就地发起进攻，不必先召回。于是 `idleRedispatch` 判断加入 `kind==='attack'`，客户端 `busyTeamIds` 相应保持"idle 停留永不算忙"（对三种 kind 一视同仁，不再按 kind 区分）。`teams.e2e.test.ts` 里一条依赖旧行为的断言（"占领 hold 结算后停留的队伍不能直接进攻，须先召回"）按新语义整段重写；`field-redispatch.e2e.test.ts` 新增一例专测"停留队伍直接从野战格发起进攻"（含 `fromTile` 校验、原地释放、兵池不动）。详见 `SLG_DESIGN_LOG.md` 同日条目 + `slg-attack-picker-idle-stationed-busy-mismatch-2026-08-08` memory。
- **P4 — 客户端实时野战视图 ✅（2026-07-25 完成）**：
  - **服务端（一处只读视图）**：`getStationed`（`combatMarch.ts`）现除本方外，再返回**视野内的敌方**停留/驻扎队伍（镜像 `getMarches` 的敌方行军逻辑——family 排除、`computeVisionSources`+`isInVision` 网格判定），敌方条目 `mine:false` 且 **teamId 置空**（避免与本方槽位在客户端 busy 门禁里撞号）；本方 `mine:true`。`StationedView.mine` 加进 openapi-world + `worldTypes.ts`（手维护）+ 客户端重生成契约。含 field-garrison e2e 新例（敌方视野内可见/视野外不泄漏/本方 mine:true）。全量 worldsvc **304 passed**。
  - **客户端渲染**（`WorldMapRenderer/fog.ts`）：`ctx.stationed` 现含敌方 → `syncStationedTokens` 按 `mine` 给敌方队伍上红色剪影（`setSilhouette(ENEMY_BASE_TINT)`），本方保持原图；敌方**行军**token 同样上红（`syncMarchTokens`）。新增 `renderGarrisonZones()`（在 `renderOverlay` 里、`renderOccupyFrontier` 之后画）——对每支 `mode==='garrison'` 的停驻队伍画其 `baseFootprintCells` 9 格半透明防区光圈（本方蓝 `MINE_BASE_TINT` / 敌方红 `ENEMY_BASE_TINT`，与领地/行军色约定一致，ADR-003 铁律）；停留 idle 无光圈。L1/L2 only。本方 busy 门禁 / recall / 就地占领 查询均加 `mine !== false` 过滤（`WorldMapNet`/`WorldMapInput`）。
  - **客户端 UI**（`WorldMapInput.ts` + `WorldMapNet.ts`）：移动弹窗拆成两意图——「移动到此（停留）」`showTeamPicker(...,'move','idle')` 与「移动并驻扎」`(...,'move','garrison')`；客户端 `startMarch` 加 `stationMode` 参数穿到 body（仅 garrison 时发送，服务端只在 kind='move' 认）。中立格上若有**本方 idle 停留**队伍 → 菜单出「就地占领」（`doInPlaceOccupy` = 复用 `doMarchTeam(...,'occupy')`，靠 P3c 的 idle-redispatch 把原点回落到驻留格 → 零距离 occupy），按 ADR-039 连地预判灰置。三语词条：`actGarrison`/`actOccupyInPlace`/`team.pickTitleGarrison` + `actMove` 改「移动到此（停留）」。
  - **验证**：client `tsc --noEmit` + webpack 均绿；worldsvc `tsc` + 全量 304 绿。**未做实机截图**——雾/驻扎光圈需要真实多人世界状态（敌方 garrison 在我方视野内），本机 Browser pane 未显示且不宜在生产世界（api.gamestao.com）发真兵制造该状态；渲染逻辑为确定性绘制、已过类型+构建。留待本地起后端后实机核。
- **P5 — 建筑层**（分 P5a/P5b/P5c）：
  - **P5a — 箭塔服务端核心 ✅（2026-07-25 完成）**：`TileDoc.structure`（`{kind:'arrowTower'|'blocker', level, hp, hpMax, ownerId, familyId?, builtAt}`，泛化 `watchtower` 布尔位、二者并存）。常量 `ARROW_TOWER_COST/BLOCKER_COST/ARROW_TOWER_HP/BLOCKER_HP/ARROW_TOWER_DMG_RATIO(0.1)/ARROW_TOWER_DMG_CAP(300)` 进 `shared/src/slg/core.ts`（DRAFT，§8-O3）。建造/拆除 API：`territory.buildStructure/demolishStructure`（settle→校验→扣费，参照 `buildWatchtower`）——只能建**己方/家族领地**（§8-O2）、非基地、一格一建；箭塔额外把 `kind:'tower'` 的 9 格覆盖写进 `cover` 反向索引，拆除清除。踏格结算（`advanceMarch` 的 cover 分支重写）：敌方 tower 覆盖格 → `encounter.applyTowerDamage` 掉血不拦停（`min(troops·ratio, cap)`；卡牌军按 `writeFieldCardState` 比例缩 currentTroops、有 `CARD_BASE_SURVIVAL` 下限故只削不灭/不伤；散兵军减 troops+缩 army，减到 0 则删行军）；然后 P3b 的 garrison 拦截（一格：先 tower 群削、后首个 garrison 开战）。塔本身 hp 只被 attack 削（P5b）。视图：`TileStructureView`（hp/hpMax intel-gated）+ `WorldTileView.structure` 进 openapi-world + `worldTypes.ts` + `core/map.tileDocView`/`gateIntel` + 客户端重生成。含 `field-tower.e2e.test.ts` 3 例（建/拆+9格覆盖、建造校验、敌方 tower 削过路卡牌军不拦停不记 siege）。
  - **P5b — 阻挡 + 结构清理 ✅（2026-07-25 完成）**：blocker 接入寻路——`computeMarchPath` 查 `structure.kind:'blocker'` 的敌方格并入 `blockedBaseKeys`（己方/家族 `structure.ownerId`/`familyId` 放行；目标格靠 `findMarchPath` 的 isDest 豁免，故 attack 行军仍能走到 blocker 格上攻打它）。**结构清理（易主/弃地即毁，参照 watchtower「随 TileDoc 丢失」）**：`landSiege` 领地易主分支 `$unset: {structure}` + 若原是箭塔则 `removeCover`（清 9 格覆盖）；`abandonTile` 同样清箭塔覆盖。含 `field-blocker.e2e.test.ts` 2 例（敌方 blocker 绕路 / 己方 blocker 放行 / blocker 无 cover；弃地清塔+覆盖）。**攻毁取舍（v1）**：结构靠**攻占其地块**摧毁（现有 attack→capture 流程已 raze 之，满足 §5.2「可被 attack 攻毁、攻毁后从 cover 移除」）；独立的 `structure.hp` 逐次削减耗损机制暂缓（v2 已于 P5d 补齐）。`passiveRelocate`（主城被破→全领地清空）时若领地上有塔，其 cover 会残留——已知小缺口（P5d 补齐）。
  - **P5c — 客户端 ✅（2026-07-25 完成）**：`WorldApiClient.buildStructure/demolishStructure` + `POST /world/structure[/demolish]`。己方地块菜单（`WorldMapInput`）：无结构 → 「建箭塔」/「建阻挡」（`WorldMapNet.confirmBuildStructure`→费用确认弹窗→`doBuildStructure`，费用取 `@nw/shared` 的 `ARROW_TOWER_COST/BLOCKER_COST`）；有本方结构 → 「拆除建筑」（`doDemolishStructure`）；己方/敌方地块 head 加结构提示行（敌方地块提示「攻打即毁」）。渲染（`tileGraphics.ts`，随瞭望塔同 LOD/位置）：`tile.structure` 画几何标记——箭塔=尖顶塔+箭孔、阻挡=X 撑木栅栏，屋顶/栅栏按 `mine` 上色（本方蓝/敌方红，ADR-003 铁律，v1 无专用图集）。三语 `actArrowTower/actBlocker/actDemolish/arrowTowerTitle/blockerTitle/structureConfirm/buildBtn/structureBuilt/structureDemolished/hasArrowTower/hasBlocker`。验证：client `tsc --noEmit` + webpack 绿。**未实机截图**（同 P4：canvas + 需真实世界状态，本机 Browser pane 未显示、不宜在生产世界建真结构）。
  - **P5d — 结构耐久 v2 + passiveRelocate 补漏 ✅（2026-07-25 完成）**：补齐 P5b 遗留的两点。
    ① **`structure.hp` 逐次耗损（§5.2）**：`landSiege` 的 `attacker_win` 非基地分支新增中间态——目标格带**残 hp>0** 的结构时，清完守军的进攻按**存活突入兵力 `res.attackerSurvivors`**（兵量级，与结构 2000/3000 hp 同量纲；非 base 的 siege-value 量纲）削 `structure.hp`，**不易主**：结构仍立着则该格保持敌方所有、`garrison` 归 0（守军已被清）、进攻方带残兵折返（散兵 `refundTroops` / 卡牌走既有 cardState），`structure.hp` 落库；仅当此击使 `hp≤0` 才落入原易主分支——`$unset:{structure}` raze + 箭塔 `removeCover`（9 格）+ 该格易主并以残兵为新守军。于是「多次攻打把血条磨到 0 才倒」。塔的过路群削（P5a `applyTowerDamage`）仍不碰塔自身 hp，只有 attack 削——量纲一致。
    ② **`passiveRelocate` 扫塔 cover**：`helpers.passiveRelocate` 在 `deleteMany({ownerId})` 清全领地**前**，先 `find({ownerId, 'structure.kind':'arrowTower'})` 并逐格 `removeCover`（tile 随后删除、结构随之消失，仅 Redis `cover` 反向索引需显式扫除；blocker 无 cover 故只扫塔），与 `abandonTile`/`landSiege` 的清理范式一致。
    含 `field-structure-attack.e2e.test.ts` 3 例（箭塔 hold→raze+capture+清 cover、阻挡 hold→capture、passiveRelocate 扫塔 cover）。全量 worldsvc **312 passed**。
    **实机 live-HTTP 核验（2026-07-25，本地全栈 docker mongo/redis + meta/gateway/social/world + client 9090）**：设备登录→开服 s1→A 入世→建塔(`hp2000/2000`)/建阻挡(`hp3000/3000`,`mine:true`)→`/world/map` 正确回结构、Redis `cover` 恰 9 格、拆除清 0；A 攻打敌方塔(seed enemyZ,`hp2000`)——600 兵 → 不易主、`hp→1402`（hold 分支 live），1600 兵 → 塔毁+该格易主+残兵 1595 为新守军（hp≤0 capture 分支 live）。**唯一仍未核**：驻扎光圈/结构贴图/敌方 token 的**像素渲染**——本机 Browser pane 不 compositing 无法截图（环境限制，非代码问题；客户端所读 map 数据已 live 核正确）。

每阶段独立可验证、可分别提交合入当日分支。

---

## 8. 待审要点（2026-07-24 全部拍板：采用提议默认）

- **O1 — 拍板：否**。行军**路过敌方领地**（带 `garrison` 数值的已占格，非驻扎队伍）**不触发** pass-through 战斗。tile `garrison` 是「该格被攻打时」的静态防守；若路过即战会让敌方领地不可穿行。拦截交给**驻扎队伍**（玩家主动布防）与**箭塔**。
- **O2 — 拍板：是**。箭塔/必拆除阻挡**只能建在己方/家族领地**格，防恶意卡点。
- **O3 — 拍板：DRAFT 进 config**。箭塔伤害公式/耐久/成本、驻扎维护成本、步进时长与疲劳关系——进 `config.ts` 标 DRAFT，待经济核验。
- **O4 — 拍板：监控 + 降级预案**。逐格步进事件量（§3.3 注记）上线前压测，必要时降级为粗粒度步进。
- **O5 — 拍板：接受**。两队相邻格对穿（§3.4 边缘）不触发遭遇，接受为 SLG 常态。

---

## 9. 验收

- 服务端 `worldsvc` + `@nw/shared` 全量测试绿；新增遭遇/步进/建筑 e2e。
- 客户端 `tsc --noEmit` + webpack；启动 dev（9090）实机验证：就地占领可选、敌方野外队伍可见、驻扎拦截触发、箭塔掉血、阻挡需攻毁。
- 文档：本文件定稿 + `SLG_DESIGN.md` 加引用小节 + `DECISIONS.md` 记 ADR-051 + `SLG_DESIGN_LOG.md` 记实现。
