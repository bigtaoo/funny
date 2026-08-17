# SLG 实现记录 §50–§63（2026-08-02 ~ 2026-08-04）

> 从 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 拆出（2026-08-17，原文件 2011 行）。**小节编号沿用原文，不重新编号**——源码注释里的 `SLG_DESIGN_LOG.md §N` 引用照旧有效。
> 核心设计以 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 为准；分册总览见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)。
> 相邻分册：[`SLG_LOG_S34-S49.md`](SLG_LOG_S34-S49.md)（在先）、[`SLG_LOG_2026-08.md`](SLG_LOG_2026-08.md)（后续）。

---

## 50. 围攻战斗：进攻方全灭后提前结束，不再耗到超时（2026-08-02，用户提出）

用户提出：SLG 攻城验证时，如果场上进攻方已经没有存活单位了，战斗应该直接结束判负，不需要等 `SIEGE_BATTLE_TIMEOUT_TICKS`（10 分钟/18000 tick，§16.5）跑完。核对 `checkWinCondition`（`server/engine/src/engine/winCondition.ts`）发现 `destroy_base` 目标此前只有两条硬性超时兜底——`battleTimeoutTicks` 与目标自带的 `durationTicks`——进攻方（Bottom）全灭后既打不掉基地也没有任何提前判负分支，只能干等到超时才由防守方（Top）胜出；`survive` 目标已有对称机制（`hasLivingEnemyUnits()`，`campaign.ts`），但那是查 Top 侧、服务 PvE 波次防守场景，跟围攻的攻防方向相反，没有覆盖到 `destroy_base`。

**修复**：`campaign.ts` 新增 `hasLivingAttackerUnits()`（对称于既有 `hasLivingEnemyUnits()`，查 Side.Bottom 是否还有存活单位）；`winCondition.ts` 在 `destroy_base` 分支的超时判定之前插入早退检查——`!hasLivingAttackerUnits()` 时立即 `GameOver`，`winner=Side.Top`（防守方胜，判负事件与超时分支完全一致，只是不用等满 tick）。攻方军队在引擎构造时（`base.ts` 读 `level.attackerArmy`）就已一次性同步入场，无逐 tick 补兵的活指令输入，因此该检查不会误杀"部队还没上场"的中间态。围攻仅用于 worldsvc 无实时输入的 headless 结算（`siegeEngine.ts`）与 econ-sim 模拟工具，不涉及客户端实时对战，不影响其它模式。

**验证**：`server/engine` `tsc --noEmit` 绿 + 全量 `npm test`（76 例，含围攻相关用例）全过，其中含一例攻方军队为空（`attackerArmy` 未设置）走 `destroy_base` 的既有用例，验证提前判负不影响该用例原有断言；`server/worldsvc` `tsc --noEmit` 绿，`siege-cheap-fallback.test.ts`（10 例）+ `siegeWorkerPool.test.ts`（11 例）全过。

**追加测试（同日，用户要求"加测试"）**：`gameEngine.test.ts` 新增「destroy_base ends immediately once the attacker army is wiped, without waiting for battleTimeoutTicks」——`attackerArmy` 放一个 `initialHp:1` 的濒死步兵，紧挨着（隔 1 行、同列）一个满血 `garrison` 步兵，`battleTimeoutTicks` 照抄真实值 18000，`runHeadless(maxTicks:100)`；断言 `winner===Side.Top`、`topPlayer.isDead===false`（排除"打穿基地获胜"这条已有分支）、`elapsedTicks<100`（远早于 18000 的超时线）。先 `git show <fix前一提交>` 把 `winCondition.ts`/`campaign.ts` 换回本次改动前的版本单独跑这一例，确认必现失败（不会在 100 tick 内结束，而是要跑到超时才会 GameOver）；换回修复后的版本复跑，转绿——坐实测试确实在验证本次新加的早退分支，而非误报。`server/engine` 全量 `npm test` 77 例全过，`tsc --noEmit` 复核仍绿。

## 51. §33 修复留了个尾巴——占领结算仍会误报「领地失守」，改成服务端下发身份而非客户端瞎猜（2026-08-02，用户截图报告）

**背景（用户报告）**：SLG 里刚战斗完、进入占领阶段时，会闪一次「领地失守」（`world.defendLost`）提示——玩家自己刚打赢的占领被读成了被人抢地。

**根因**：§33 的修复（`myOccupyTiles`）是纯客户端方案——`WorldMapNet.doMarch`/`doMarchTeam` 派出占领军时把目标格记进 `WorldMapContext` 上一个**仅存在于内存里**的 `Set`，`applySiegeResult` 收到推送时查这个 `Set` 判断"这是不是我自己干的"。问题是 `WorldMapScene`（连带它的 `WorldMapContext`）只在**每次进入 SLG 时**重新创建一次（`app.ts showWorldMap`）——City/拍卖行/社交面板都是叠加在它上面的 overlay，不会重建它，但只要玩家**退出 SLG 再回来**（或刷新页面），一次全新的 `WorldMapContext` 就带着一个空 `Set` 出现。占领行军往往要走几十秒到几分钟，只要这段时间内场景被重建过，占领打赢的 `siege_result` 推送一到，`myOccupyTiles` 里早就没有这块地了，直接落进 `else` 分支的「防守方」文案——和 §33 描述的现象一模一样，只是触发路径从"从没记过"变成了"记过又被清空"。

**修复（服务端下发身份，彻底去掉客户端猜测）**：`SiegeResult`（`transport.proto`）新增两个字段——`attacker_id`（派出这次进攻/占领行军的账号，直接来自 `SiegeDoc.attackerId`）与 `march_kind`（那次行军的 `MarchKind`，新增到 `SiegeDoc`，`recordSiege` 写入 `m.kind`）。`core/push.pushSiege` 把两个字段一并推给客户端；`WorldMapNet.applySiegeResult` 改用 `s.attackerId === ctx.cb.accountId` 判断"这是不是我的行动"，`s.marchKind` 判断"攻城"（复盘弹窗）还是"占领"（轻量 toast）——不再依赖任何客户端记忆，`myAttackTiles`/`myOccupyTiles` 两个 Set 连同它们的写入点一并删除。字段全程走 `buf generate`（`server/contracts/transport.proto` → gateway/metaserver/gameserver/botsvc/client 五处 `npm run proto:gen`），gateway 内部还有一份手写的 `ServerMsg`/`PushMsg` 镜像类型（`matchsvcClient.ts`/`proto.ts`/`Gateway.ts`）需要同步补字段。`move`（战场遭遇战）行军目前仍会落进"防守方"分支——这是一个独立于本次报告的既有问题（遭遇战里获胜方的提示也读反了），本次刻意不顺手扩大范围，留了行内注释标注。

**验证**：`server/worldsvc`、`server/gateway`、`client` 三处 `tsc --noEmit` 全绿；`server/worldsvc` 攻城/占领/遭遇战相关 e2e（`siege`/`occupy-march`/`stronghold`/`field-encounter*`，共 28 例）全过，确认新字段不破坏既有推送断言；`worldMapSiegeResultToast.ui.ts` 按新字段重写（6 例：占领胜/败分类、**同一结果重复投递仍分类正确**——直接命中本次修复的场景、attack/防守两条原路径回归），`worldMapOccupyTeamPicker.ui.ts` 去掉不再需要的 `myAttackTiles`/`myOccupyTiles` mock 字段复跑仍全过（19 例）。preview 无法稳定复现（需要完整 worldsvc + 连地相邻 + NPC 战斗 + 场景重建时序），改动靠单测覆盖。

**追加测试（同日，用户要求"加测试"）**：① 客户端新增「surviving a WorldMapScene rebuild」一例——用两个完全独立、互不共享状态的 `WorldMapContext`/`WorldMapNet` 实例模拟"派兵时的场景已经不在了"，直接对应根因描述的触发路径；先把 `applySiegeResult` 里的 `amInitiator` 临时改死为 `false`（模拟"服务端字段被忽略，退回瞎猜"的回归）复跑这批用例，**5/7 例转红**（含这个新场景 + 原本 4 例），换回真实实现后复跑 **7/7 转绿**——坐实新用例确实在验证本次分类逻辑，不是形同虚设。② 服务端三个 e2e 文件（`siege`/`occupy-march`/`field-encounter`）在既有场景里追加 `attackerId`/`marchKind` 断言而非新增用例：`occupy-march.e2e.test.ts` 三处占领胜/败推送改用 `pushes.find(...)` 精确断言 `{attackerId:'a', marchKind:'occupy'}`（占领场景是本次报告的重灾区）；expulsion 用例额外验证 b 用 `attack` 行军抢地成功时自己收到的推送是 `marchKind:'attack'`（不是 `'occupy'`）——锁定"攻城行军打赢占领中的地"这条跨路径交互不受影响；`siege.e2e.test.ts` 攻城/扫荡用例补 `marchKind:'attack'`/`'sweep'` 断言；`field-encounter.e2e.test.ts` 两个 `scenario 1`（胜/负）补 `attackerId:'a'`、`marchKind:'move'` 断言——为 §51 遗留的 `move` 遭遇战分类跟进任务预先钉住服务端数据契约。`server/worldsvc` 全量 `tsc --noEmit` 复核仍绿，三个 e2e 文件共 20 例全过。

## 52. 行军请求稳定超时（`AbortError`）——`computeMarchPath` 的敌方主城扫描在老世界上退化成近乎全表扫描（2026-08-02，用户报告）

**背景（用户报告）**：SLG 里每次占领领地都弹 `TypeError: world api POST /world/march failed: AbortError: signal is aborted without reason`。追问确认：报错之后地块**其实占领成功了**（`Marches`/领地都有记录）——服务端调用没有失败，只是客户端等不到响应先弃权了。

**排查**：worldsvc/socialsvc/caddy/cloudflared 全部健康、CPU/内存正常、日志无报错，直接 curl 生产接口也是毫秒级——初步怀疑是用户本地网络抖动。但用户反馈"每次占领都必现"，于是拿到账号信息（`publicId 233784986`，世界 `s1-0`）在生产库上直接复现：`computeMarchPath`（[`combatShared.ts`](../../server/worldsvc/src/combatShared.ts)）里为 A* 寻路收集"敌方主城会挡路"用的查询——

```js
cols.tiles.find({ worldId, type: 'base', ownerId: { $nin: excludeOwners } })
```

——实测耗时 **12.4 秒**。根因：`s1-0` 是个老世界，注册过的玩家主城（`type:'base'`，每个 3×3=9 格，且从不删除）已经攒到约 2584 个，`tiles` 集合总共 23325 条记录里 **23257 条**（99.7%）都是 `type:'base'`。2026-07-29 那次审计（[`db.ts`](../../server/worldsvc/src/db.ts) §索引注释）给这条查询配了 `{worldId,type}` 索引，但当时的假设——"`type:'base'` 命中的数量远小于整个集合"——在世界玩得越久、注册主城越多之后逐渐失效，最终这条"应该很窄"的查询变成了近乎全表扫描。同函数里另外两条查询（crossing 通道、玩家建的 blocker）结构相同，存在同样的潜在风险。这条查询单独就超过了客户端 [`WorldApiClient.ts`](../../client/src/net/WorldApiClient.ts) 的 10 秒超时——不是代码在这天变了，是这个世界的主城数量自然增长跨过了当年那个假设成立的临界点，跟"服务器今天没更新"完全对得上。

**修复**：给 `computeMarchPath` 的 3 条障碍物查询（gate/敌方主城/blocker）都加上按行军起止点算出的坐标包围盒过滤（`legBox()` + 60 格 padding，复用已有的 `{worldId,x,y}` 索引），把"扫全图"收窄成"只看行军路线附近"。Padding 选取 60（远大于 3×3 主城/普通障碍物聚簇的尺寸）而非精确到 A* 实际探索边界——短途行军（占领要求目标与自己领地相邻、士气机制也软性限制了远途行军的实际收益，见 §22/§27）绝大多数场景下包围盒会大幅收窄；只有起止点本身相距很远的行军，包围盒才会接近全图，此时退化为跟修复前一样的开销，不引入正确性风险（不会漏查真正卡在路线附近的障碍物）。

**验证**：`server/worldsvc` `tsc --noEmit` 全绿。定向重跑占领/围攻/寻路相关测试（`occupy-march`/`passage`/`field-tower`/`field-blocker`/`base-siege`/`stronghold`/`field-encounter*`/`field-redispatch`/`field-occupancy`/`field-structure-attack`/`base-integrity`/`march-return-travel-time`/`teams`/`enter-world`，共 12 文件/88 例，含「blocker 绕路」「crossing 通行」「长途占领士气衰减」等直接触碰寻路的用例）全过；随后跑了 `server/worldsvc` 全量 50 文件/399 例，同样全绿。生产库上直接验证：本地起了一个带 `rs0` 的 standalone mongod 复现原查询耗时（12.4s），但此次改动未部署到生产（未触碰线上代码），仅在本地代码 + 测试环境验证；建议下次常规发布时带上。

**追加测试（同日，用户要求"加测试"）**：`territory-connectivity.e2e.test.ts` 新增一例，直接命中本次修复本身而非仅靠既有用例侧面兜底——种下 50 条远离本次行军路线（地图另一角）的模拟"历史累积主城"`type:'base'` 噪声数据，临时给 `m.collections.tiles.find` 打一层 spy 拦截调用参数，断言敌方主城扫描那次调用的 filter 里带有 `x`/`y` 坐标区间（`$gte`/`$lte`），且区间紧贴行军起止点、离噪声所在的地图角落很远；再用捕获到的 filter 原样重新查一遍，断言噪声数据一条都不会被查出来。为确认这条断言不是形同虚设：先用 `git show HEAD~1:combatShared.ts` 把该文件换回修复前版本单独跑这一例，**必现失败**（`expected undefined to be defined`——旧查询压根没有 x/y 键）；`git checkout HEAD --` 换回修复后版本复跑转绿。`territory-connectivity.e2e.test.ts` 全 12 例过，`server/worldsvc` 全量重跑 50 文件/400 例全绿。

## 53. §51 遗留的 `move` 遭遇战分类跟进——胜负 toast 补齐（2026-08-02）

**背景**：§51 把 `SiegeResult` 分类改成服务端权威的 `attackerId`/`marchKind`，但明确留了一句"`move`（战场遭遇战）行军目前仍会落进防守方分支"——`field-encounter.e2e.test.ts` 当时就已经预先钉住了 `siege.attackerId`/`siege.marchKind==='move'` 这两个服务端数据契约（连带注释直接写"field-encounter classification is not yet wired client-side"），专等这次跟进。

**现象**：野战遭遇（ADR-051 §2.2，[`encounter.ts`](../../server/worldsvc/src/combatSiege/encounter.ts) 的 `resolveFieldEncounter`——一支 `move` 行军中途撞上敌方停留队伍/另一支行军/驻扎守军，就地开打）没有专属分支，`amInitiator && marchKind==='move'` 落进 `applySiegeResult` 的 `else`（防守方/旁观者）兜底：打赢一场遭遇战显示"领地失守"，打输了反而显示"守土成功"——两边都反了，而且遭遇战本身不涉及任何 tile 归属变化（那是 occupy 的事）。

**修复**：`WorldMapNet.applySiegeResult`（[`WorldMapNet.ts`](../../client/src/scenes/worldmap/WorldMapNet.ts)）在 `attack`/`occupy` 两个分支之后新增 `amInitiator && marchKind==='move'` 分支——胜负与 `outcome` 直接对应的轻量 toast（不弹复盘弹窗，遭遇战跟 occupy 一样是高频事件）。新增三语 i18n key `world.encounterWin`/`world.encounterLoss`（zh/en/de），英文措辞刻意避开"Territory secured"这类字眼——遭遇战不改变任何地块归属，纯粹是一场遭遇战的胜负。服务端字段（`attackerId`/`marchKind`）§51 已经全部就绪并测过，本次是纯客户端改动，不涉及 proto/`SiegeDoc`/推送链路。

**验证**：`server`（12 workspace）+ `client` 的 `tsc --noEmit` 全绿；`worldMapSiegeResultToast.ui.ts` 补 3 例（遭遇战赢/输的正确 toast + 他人遭遇战不受影响的回归），全 10 例过；`client` UI 全量 112 文件/961 例、非 UI 全量 129 文件/944 例两套全绿；`server/worldsvc` 定向重跑 `field-encounter*`/`siege`/`occupy-march`/`stronghold` 共 5 文件/28 例全绿（复用 §51 已经钉住的 `attackerId`/`marchKind` 断言，无需新增服务端用例）。

**追加测试（同日，用户要求"加测试"）**：① 补 2 例——「输的遭遇战同样不弹复盘弹窗」（跟赢的分支对称，之前只在赢分支断言过 `showModal` 未调用）；「自己发起的行军但 `marchKind` 是识别不到的种类（如 `sweep`）」不会被误判成遭遇战——钉死这个分支专门 keyed on `marchKind==='move'`，不是"任何自己发起、非 attack/occupy 的动作"的宽松判断（跟已有的"别人发起的 move"用例互补，一个测"kind 对但不是我方"，一个测"是我方但 kind 不对"）。② 证伪测试不是形同虚设：把 `applySiegeResult` 里 `s.marchKind === 'move'` 临时改成一个不可能匹配的字符串，复跑本文件——**2/12 例转红**（恰好是"自己赢/输一场遭遇战"这两例，读回旧的"领地失守"/"守土成功"反向文案；"别人发起的 move"与"自己发起但 kind 不对"两例保持绿，因为它们本就该走兜底分支，没被这次改动影响，符合预期），换回真实实现后复跑 **12/12 转绿**。`worldMapSiegeResultToast.ui.ts` 全 12 例过，`client` UI 全量 112 文件/963 例仍全绿。

**顺带发现（超出本次范围，已 spawn_task 转出）**：全量非 UI `vitest run` 有 7 例失败（`campaign-knobs`/`garrison`/`siege-battle.test.ts`），主检出（`02.08.2026` 分支当前 tip）同样复现，与本次改动无关——疑似近期 `destroy_base` 提前结束修复（`ad01a623`/`5de02ba9`）在这几个既有场景里判定过宽，已转出独立任务跟进，不在本次范围内处理。

## 54. §53 遗留的 `destroy_base` 提前结束误判——收窄到仅 `attackerArmy` 剧本场景（2026-08-02）

**背景**：§53 末尾记录的 7 例失败（`campaign-knobs.test.ts`×4、`garrison.test.ts`×2、`siege-battle.test.ts`×1）跟进排查。

**根因**：`ad01a623`（§50）加的早退检查——`objective.kind==='destroy_base' && !hasLivingAttackerUnits()` 立即判防守方胜——隐含前提是"进攻方军队在引擎构造时一次性同步入场，没有逐 tick 补兵的活指令输入"（§50 原文），只对 `level.attackerArmy` 剧本化铺兵场景成立。但 `destroy_base` 目标同时也用于普通 PvE 战役/玩家出牌驱动的围攻（`campaign-knobs`/`garrison`/`siege-battle` 三个测试文件覆盖的就是这类场景）——这类场景里 Bottom 方是靠手牌/灵墨经济逐 tick 出卡，`attackerArmy` 从未设置，`board.units` 里查不到 Side.Bottom 单位只是"这一刻还没打出牌"的正常瞬时状态，不是"全灭"。`hasLivingAttackerUnits()` 对这两类场景一视同仁地查 board 上的 Bottom 单位，导致普通出牌流程在第 0/1 tick（尚未打出第一张牌）就被误判成"进攻方已全灭"，立即 `GameOver`。

**修复**：`winCondition.ts` 的早退条件追加 `this.level!.attackerArmy && this.level!.attackerArmy.length > 0` 前置守卫——只有关卡确实配置了剧本化 `attackerArmy` 时才允许 `hasLivingAttackerUnits()` 生效判负；普通出牌驱动的 `destroy_base` 关卡（无 `attackerArmy`）不再受这条早退影响，跟修复前一样只由 `battleTimeoutTicks`/`durationTicks`/破基地三条既有分支收尾。`hasLivingAttackerUnits()`/`hasLivingEnemyUnits()` 本身不改。

**验证**：`server/engine` `npm test`（`tsc -b` + `node --test`）77 例全过，含 §50 新增的 `attackerArmy` 剧本化早退用例（确认加了守卫之后该用例仍然早退，未被误伤）；`client` 非 UI 全量 129 文件/944 例、UI 全量 112 文件/963 例两套全绿，此前失败的 `campaign-knobs.test.ts`/`garrison.test.ts`/`siege-battle.test.ts` 三文件单独重跑（64 例）全绿。

**追加测试（同日，用户要求"加测试"）**：`gameEngine.test.ts` 新增「destroy_base does NOT early-exit on a card/ink-driven level with no attackerArmy, even with zero Bottom units on board」——专门钉死本次守卫本身：`destroy_base` 关卡不设 `attackerArmy`，全程不喂任何 `play_card` 指令（因此 board 上永远查不到 Side.Bottom 单位），跑 50 tick 后断言 `phase` 仍是 `Playing`。证伪测试不是形同虚设：临时把守卫条件改回 §50 原始版本（`objective.kind==='destroy_base' && !hasLivingAttackerUnits()`，去掉 `attackerArmy` 前置判断）单独跑这一例——**必现失败**（`AssertionError`：断言信息原样命中"no attackerArmy configured → the wipeout early exit must not fire"，证明确实是本次守卫在拦这个误判）；换回修复后的版本复跑，转绿，且与 §50 已有的「`attackerArmy` 剧本化早退」用例互补（一个测"该早退时早退"，一个测"不该早退时不早退"）。`server/engine` 全量 `npm test` 78 例全过，`client` 非 UI 129 文件/944 例、UI 112 文件/963 例两套复跑仍全绿。

## 55. 编辑队伍网格：基地列加基地图标，去掉没人注意到的「出兵」文字（2026-08-02，用户看截图提出）

**背景**：用户看着"编辑队伍"（`DefenseEditorScene` 攻击模式，玩家给出征队伍布阵的界面）截图提出——网格里基地所在的两列（`BASE_COLS=[5,6]`，只有底色区分）方向感弱，建议在地图上把自己基地画出来，让玩家更直观理解哪些格子在前面、哪些在后面。追问范围后用户明确：只改这一个界面（不涉及防守布阵编辑器、也不涉及大地图 worldmap 主图）；图标直接复用 PvP 对战里的基地图标（`BoardView.ts` 用的 `game_base.png`），不用新画；顺带把那句"出兵"文字去掉——用户说自己从来没注意到过这行字。

**实现**：`DefenseEditorScene/render.ts` 的 `renderGrid()`——攻击模式（`!hasBuildingRow`）专属分支：base 列（`isBaseCol`）在最靠近出征边缘的那一行（`dr === rows-1`，往下一格就是玩家自己的主城，只是不在这 8 行显示范围内）画一次 `game_base.png`（沿用 `drawArtFit` 的按比例居中缩放，跟画英雄/建筑同一套逻辑），宽度铺满两个基地列（`cellW*2`）。原本"defense → 建造行 / attack → 出兵"那句左侧文字标签，attack 分支直接整体去掉（defense 模式的"建造行"标签不受影响，照常保留）；`i18n` 里的 `world.team.frontRow` 键（zh/en/de 三份）一并删除，因为已经没有代码引用。

**验证**：`client` `tsc --noEmit`（含 `test/**`）全绿。可视化验证走了标准的"启动整个客户端"路径，但主检出当前有其它会话的未提交 WIP（`WorldMapPanels.ts`/`WorldMapInput.ts` 缺了 `infoTab`/`openShopPanel`），导致 webpack 编译直接失败，且这次会话里 Browser pane 一直 "not displayed, so the page is not compositing frames"（`client-run-and-visual-verify` 备忘录里记过的已知环境限制，不是本次改动引入的）——两条路都走不通，遂改用备忘录推荐的 headless `test:ui` 场景构造验证：`test/ui/defenseEditorAttackCards.ui.ts` 新增一例，直接构造 `DefenseEditorScene`（攻击模式，无需登录/后端），`spy` 住 `drawArtFit`，断言基地图标那次调用的坐标/尺寸精确落在"基地列×最后一行"，且 `bodyLayer` 里不再有文字节点显示旧的 `'Deploy'` 标签。全量 `npm run test:ui`（112 文件/961 例）跑过，除本次新增这例外只有 1 例失败（`worldMapInfoScroll.ui.ts`，指向前述 WorldMapPanels 的 WIP 缺口，`document is not defined`，与本次改动无关，未去动那份 WIP）。

**追加测试（同日，用户要求"加测试"）**：补了一条防守模式的回归用例——`DefenseEditorScene defense mode — buildRow label + base icon untouched by the attack-mode change`：新搭一个 `mode:'defense'` harness（`getDefense` mock 返回 `null`，`applyConfig` 走"离线/未设置"分支，够用来验证纯渲染），断言"建造行"文字标签仍然渲染、且从没触发过基地图标那次 `drawArtFit` 调用（同样按"调用宽度 ≈ 2 格"的形状去找，跟 attack 模式那条测试用同一种识别方式）——这条锁的是本次改动把行标签渲染从无条件三元改成 `if(this.hasBuildingRow)`、基地图标又额外挂了 `!this.hasBuildingRow` 守卫，两处改动对防守模式互不误伤。证伪测试确认不是形同虚设：把 `git show <本次改动前>:render.ts` 换回改动前的版本单独跑这两条新用例——attack 模式那条**必现失败**（`expected undefined to be truthy`，因为改动前代码压根没有基地图标这条分支）；defense 模式回归那条按预期保持通过（防守模式渲染逻辑改动前后本来就没变，这条测的是"以后别改坏"，不是"这次改动修了什么"）。换回改动后的版本复跑，两条都转绿。`npx vitest run --config vitest.ui.config.ts test/ui/defenseEditorAttackCards.ui.ts` 18 例全过，`npm run typecheck` 复核仍绿。

## 56. Shop 面板独立化 + 物品卡样式 + World 下 Nation/Season 合并（2026-08-02，用户看截图提出）

**背景**：用户看着 Territory Overview 面板截图提出三点：①Shop 单独拎出来做一个独立界面，入口按钮放到拍卖行（Auction）左边；②Shop 里的商品用"物品卡"样式展示（参考装备卡 `EquipmentScene/inventory.ts` 的 `renderInstanceCell`：图标框在左、名称/成本在右、操作按钮占满卡片底部一条），而不是当时的纯文字行；③World 标签下的 Nation 和 Season 两个子 tab 合并，一起展示，不再来回切换。

**实现**（均在 [`WorldMapPanels.ts`](../../client/src/scenes/worldmap/WorldMapPanels.ts)/[`WorldMapContext.ts`](../../client/src/scenes/worldmap/WorldMapContext.ts)/[`WorldMapInput.ts`](../../client/src/scenes/worldmap/WorldMapInput.ts)）：
- **入口按钮**：`renderHeaderHud()` 里在 Auction 按钮左侧新增一个同高度/同风格的 Shop 按钮（图标 `coinSack`），资源产量 cluster 的 `rightBound` 从 `aucBtn.x-8` 改成 `shopBtn.x-8` 让出位置；新增 `ctx.shopBtnRect`，`WorldMapInput.handleDown` 里点击它调用新的 `panels.openShopPanel()`。
- **独立 Shop 面板**：新增 `openShopPanel()`/`renderShopPanel()`（结构照抄 `renderReplayPanel` 的独立弹窗模式：dim 背景 + `sketchPanel` + 标题 + Close，走同一套 `modalDimRect`/`modalBtnRects` 通用点击路由）+ 新的 `renderShopItemCard()`：每个商品一张卡（`sketchPanel` 边框 + 左侧图标框 `buildIcon` 按 `kind` 选图标：`troop_speedup→spd`/`resource_pack→coinChest`/`protection→armor`/`battle_pass→trophy` + 右侧名称/成本 + 底部整宽 Buy/Active 按钮带），2 列网格、`beginScrollList` 支持滚动。原来 World 标签下的 Shop 子 tab 连同它的纯文字行渲染整段删除；`ctx.shopItems`/`shopLabel()`/battle-pass 已购买灰化逻辑原样保留，只是搬进了新面板。
- **Nation+Season 合并**：`renderWorldTabBody()` 去掉三个子 tab 按钮（原来是 `nations`/`season`/`shop` 横排三个 `panelButton`），改成固定顺序：Season 摘要（静态文案，不参与滚动）在上，Nations 列表（可滚动，行渲染逻辑不变：★ + 名称 + 坐标 + 我的国家显示 Rename、别人的显示 Held/Free）在下，一次性全部展示。`ctx.infoTab` 字段整个删除（不再需要子 tab 状态）。
- `world.shopTitle`（en/zh/de 三份，独立面板标题，复用 `world.tabShop` 的文案）新增；`world.tabNations`/`world.tabSeason`/`world.tabShop` 三个既有 key 复用为按钮/小节标题，未新增冗余文案。

**测试改动**：`worldMapInfoScroll.ui.ts` 整体重写——去掉 `infoTab`/shop 相关的全部用例，nations 的滚动/拖拽/滚轮覆盖保留但去掉了 `infoTab` 选项，"in-list 按钮 tap-vs-drag" 那组回归（防止在滚动列表里按钮被 pointer-down 直接触发而不是等 pointer-up）改用 Nation 的 Rename 按钮验证（`openRenameInput` 走 `document.createElement`，测试环境没有全局 `document`，改成 `vi.spyOn` 到 `panels.openRenameInput` 而不是断言真实 DOM 副作用）；另加一组季节摘要内容断言（`modalTexts()` 直读 `modalLayer` 的直属 `PIXI.Text` 子节点）——季号/状态/人口文案、有/无 `resetAt` 时的倒计时文案、无数据时的占位横线、以及"国家列表为空但季节摘要仍显示"的组合态。新增 `worldMapShopPanel.ui.ts`（15 例）覆盖独立面板：`openShopPanel` 的 joined 门槛/首次拉取缓存、卡片 Buy 按钮点击触发 `doBuyShopItem`、长列表滚动、Close 按钮、battle-pass 已购买灰化、原来挂在 shop 子 tab 上的 tap-vs-drag 回归，以及卡片内容本身（`allModalTexts()` 递归进滚动列表的遮罩子容器读文本）——每张卡的本地化名称+成本文案、面板顶部的实时余额文案。`worldMapHeaderProduction.ui.ts` 补两条断言：Shop 按钮紧贴在 Auction 左边、资源 cluster 右边界让给 Shop 按钮而不是 Auction 按钮。`worldMapTerritoryPanel.ui.ts` 新增一组"header Shop 按钮"路由回归（命中 `shopBtnRect` 调 `openShopPanel`、命中区域外不调、Shop 按钮不会吞掉紧邻的 Auction 按钮点击），`worldMapHeaderInset.ui.ts` 的手搭 ctx 补上 `shopBtnRect`（否则 `WorldMapInput.handleDown` 新增的 Shop 按钮命中判断会读到 `undefined.w` 直接抛错）。

**验证**：`client` `tsc --noEmit` 全绿；`npx vitest run --config vitest.ui.config.ts`（113 文件/984 例）全绿。可视化验证：本机 Browser pane 对这个 WebGL 应用一贯需要走 `client-run-and-visual-verify` 备忘录里"TEMP `globalThis.__NW_DEBUG` 钩子 + 手搭 ctx + `renderer.render()` 两次 + `toDataURL()` + POST 到本地 collector"的标准路径（`showModal()` 那条记录）——本轮成功复现：起 `game`（9090）dev server，在 `app.ts` 里临时挂 `{app, PIXI, WorldMapPanels}`，一次 `javascript_exec` 里手搭最小 `WorldMapContext` 分别调 `openShopPanel()`（6 个商品，2×3 卡片网格，Shop/Auction 按钮并排）和 `renderTerritoryPanel()`（`territoryTab:'world'`，Season 摘要 + 3 条 Nation 混合 mine/held/free 状态）两张截图，确认排版符合预期后把临时钩子从 `app.ts` 里完整移除（`git diff` 确认该文件恢复干净）。

**协作备注**：本次改动期间 `git status` 显示同一份主检出里还有另一个会话在并行改 `DefenseEditorScene`/`sketchUi.ts`/`CityScene` 等文件（见上一条 §55 记录），以及本文件本身也带着他们尚未提交的 §55 条目——两边改动的文件集合没有重叠，属于预期内的共享检出场景（`claudedocs/worktrees.md`），提交时务必只 `git add` 本次任务改动的具体文件路径。

---

## 57. 玩家自己的基地贴图盖住后方一大片格子——打包脚本拆出独立的高度预算（2026-08-02，用户看截图提出）

**背景**：用户截图圈出世界地图上自己的基地和旁边一个 NPC 营地对比——NPC 营地严丝合缝落在自己的 3×3 地块里，自己的基地却明显"高出一截"，把后方约两排格子压在下面，同时也看不出它到底占哪几格。用户问"图片是不是要重新生成，并且做一些限制"。

**根因**：不是画风问题，是构图和一条隐含的长宽比假设。世界地图是 2:1 等轴测（`ISO_RATIO = 0.5`），3×3 地块屏幕上**宽 3 tile、高只有 1.5 tile**；而 [`WorldMapRenderer/city.ts`](../../client/src/scenes/worldmap/WorldMapRenderer/city.ts) 把图集 cell 画成 `BASE_SPRITE_TILES = 3.2` tile 的**正方形**（`sprite.width = sprite.height = baseSpriteTiles * tp`）。`city_atlas` 的美术自带一块等于地块的等轴测地台、建筑矮宽，`contentTop` 大（lv1 营地 0.50）→ 实绘高度约 1.6 tile ≈ 地块高度，正好贴合；`playerbase_atlas` 这套"文具堡垒"没有地台、物体铺满方形画幅（prompt 还把等级递进写成"越来越高"），`contentTop` 只有约 0.20 → 实绘高度约 2.5 tile，比地块高出整整 1 tile。`cityPlotMaskPoints` 只裁**横向**溢出（上方是 `tallPx` 故意放行，免得切掉塔尖），所以纵向没有任何约束。原来 `pack_playerbase_atlas.js` 里那个正方形 `CONTENT_SCALE = 0.8` 宽高同缩，改不了导致问题的长宽比，只能整体变小。

**实现**（[`art/slg/slg-playerbase/pack_playerbase_atlas.js`](../../art/slg/slg-playerbase/pack_playerbase_atlas.js)）：`CONTENT_SCALE` 拆成两个独立预算，`fit: 'inside'` 取先触底的那个——`CONTENT_W_FRAC = 0.8`（宽度照旧，从没溢出过）+ `CONTENT_H_FRAC = BASE_FOOTPRINT × ISO_RATIO × HEIGHT_BUDGET_K / BASE_SPRITE_TILES`，由地块真实屏幕高推出，`HEIGHT_BUDGET_K = 1.2` 是留给旗杆塔尖的余量。对现有这批近正方形的图触底的永远是高度：10 帧的 `contentTop` 全部从 0.20~0.35 变成 0.44，绘制高度 2.5 → 1.8 tile。刻意保持等比、不做非等比拉伸（那会把手绘等轴测透视压变形），代价是宽度跟着缩到约 1.75 tile，在 3 tile 宽的地块上略显瘦——明确记录为权宜之计，彻底解决要靠按新构图硬规重出的美术。

**打包链路的坑**（顺带修掉）：2026-07-27 的资源重组（`072131d8`）把源 atlas 合并进 `world_atlas` 后**把源文件从仓库删了**，`art/scripts/mergeAssetAtlases.js` 因此已经跑不起来（`Input file is missing`），重跑 `pack_playerbase_atlas.js` 的产物根本进不了客户端真正读的合并页。新增 [`art/scripts/patchMergedAtlas.js`](../../art/scripts/patchMergedAtlas.js)：把某个子图集的帧**原位重新盖印**回合并页（帧尺寸不变 → 坐标一个不动，只换像素 + `contentTop` 等自定义字段；尺寸变了直接报错要求整页重打）。合并页是 blend 合成，盖印前必须先把目标矩形清零，否则旧图会从新帧的透明区透出来。

**美术侧**：[`design/product/player-base-image-prompts.md`](../product/player-base-image-prompts.md) 新增"构图硬规"一节并按它重写了 10 条 prompt——必须画等轴测地台、内容外接框宽高比约 10:7、建筑高度不超过地台菱形高度的 1.2 倍、等级递进从"越来越高"改成"占地/圈层/密度越来越满"。旧版 prompt 移除（git 历史里可查）。

**测试**：`cityAtlasContentTop.ui.ts` 新增两条断言，从 `contentTop` 反推绘制高度（美术底对齐，故绘制高度 = `(1 - contentTop) × BASE_SPRITE_TILES` tile）——既不许超过 `BASE_FOOTPRINT × ISO_RATIO × 1.2` 的预算（防止将来重打包又回到正方形缩放），也不许小于地块自身高度（防止缩没了）。

**验证**：`client` `tsc --noEmit` 全绿；`cityAtlasContentTop` / `cityAtlasContentTopFallback` / `worldMapBaseHpBar` 三个 UI 测试文件 17 例全绿。可视化：本机 Browser pane 这次连 `computer{action:"screenshot"}` 都直接报"pane is not displayed, so the page is not compositing frames"（见 `worldmap-standalone-debug-render` 备忘录记的同一限制），改用离线几何核对——用 `city.ts` 原样的摆放公式（底部中心锚点落在地块前顶点、`cityGroundFwdPx` 前移量、`BASE_SPRITE_TILES` 正方形）把真实图集帧合成到等轴测网格上，逐个比对 `HEIGHT_BUDGET_K` 取 1.2/1.35/1.5/1.67 的效果并与 `city_lv1` 营地并排作参照，据此定下 1.2。**像素级的真机核对没有做**，需要用户在自己开着的客户端里刷新确认。

---

## 58. 驻扎（驻守）目标收紧为「己方 + 盟友」，中立/敌方一律不可驻扎；不支持的菜单选项直接隐藏而非置灰（2026-08-02，用户截图报告）

**背景**：用户截图一块中立资源地（Ink Lv.1）的占领弹窗，红圈圈出「移动并驻扎」按钮，指出：①驻守（驻扎，§38/ADR-051 P3a 的「busy 且主动防守 3×3」态）只应该能驻守自己和盟友的领地，敌人的和中立的地都不该能驻守；②弹窗里不支持的选项（截图里灰掉的「占领」）应该直接不显示，而不是置灰。逐代码核对后发现现状比截图更宽：`combatMarch/command.ts` 的 `move` 校验对 `停留 idle` 和 `驻扎 garrison` 两种意图一视同仁（§38 落地时的既有测试 `field-garrison.e2e`/`field-redispatch.e2e` 明确把 garrison 派到中立地并断言成功），而**盟友领地**在 `WorldMapInput.onTileClick` 里完全没有专属分支——落入 `tile?.occupied` 的通用"敌方"分支，只提供一个必定被服务端 `ALLY_TILE` 拒绝的"进攻"按钮。判定这不是照抄既有设计的误报，而是用户在收紧一条已实现但从未明确拍板过边界的规则，遂据此改服务端校验 + 补client 盟友分支，而非仅做客户端隐藏。

**规则（新拍板）**：`停留 idle`（无防御声明）保持原样——只能停自己的地或空地（中立），从不落到别人（含盟友）的地上。`驻扎 garrison`（主动防守 3×3、算 busy）收紧为**只能落在自己的地，或一个"友方"账号（家族 / 本宗门 / 结盟宗门——即 `WorldCoreVision.friendlyAccountIds` 用来拦截"进攻友方"的同一个集合）的地上**——不再接受中立地，也从未接受非友方的地。

**实现**：
- **服务端**（[`combatMarch/command.ts`](../../server/worldsvc/src/combatMarch/command.ts) 的 `move` 分支 + [`combatMarch/arrival.ts`](../../server/worldsvc/src/combatMarch/arrival.ts) 的 `tryParkTeam`，两处各自独立校验：前者是派发时的快速失败，后者是到达时因途中地块归属变化而必须的二次核验，同一条规则改两遍）：`toTile.ownerId !== accountId` 时，只有 `stationMode==='garrison'` 且 `friendlyAccountIds(worldId, accountId).has(ownerId)` 才放行（否则维持原有 `TILE_OCCUPIED`「用进攻」报错）；`!toTile.ownerId`（中立）分支新增 `if (isGarrison) throw TILE_OCCUPIED` 前置检查，`停留 idle` 不受影响。
- **客户端**（[`WorldMapInput.ts`](../../client/src/scenes/worldmap/WorldMapInput.ts)）：`onTileClick` 在 `tile?.mine` 分支之后、`tile?.occupied`（敌方）分支之前插入新的 `tile?.ally || tile?.allySect` 分支——盟友领地（家族同盟或结盟宗门成员）显示业主名 + 结构/耐久信息，按钮只给「移动并驻扎」（已驻扎则显示「召回驻军」），不给进攻，不给"停留"（idle 在盟友地上没有意义，规则也没要求）；中立地分支的 `else` 只保留「移动到此（停留）」，去掉「移动并驻扎」。同一批顺手把三处"不支持就置灰"（占领连通性 `occupyConnected`、就地占领、迁城 `canRelocate`）改成不满足条件时**整个按钮不 push**，而不是 `disabled:true` 灰显——用户在同一张截图里提的第二点，`WorldMapPanels/base.ts` 的 `disabled` 灰显渲染代码本身没删（其它场景仍可能用），只是这三处调用点不再传它。
- **i18n**：新增 `world.allyTile`（"盟友领地"/"Ally Territory"/"Verbündetes Gebiet"，zh/en/de 三份），复用既有 `world.actGarrison`/`world.actRecallStation`。

**测试改动**：`field-garrison.e2e.test.ts` 三个既有用例（garrison 到中立地的 3×3 覆盖注册/召回、中途目的地被抢占后回退原地）改为先把目标格预置为 `ownerId:'a'`（己方地），验证的覆盖/occ 机制本身与地块归属无关；新增 3 例：garrison 派中立地必拒（`/own or allied territory/`，同一目标改 `停留 idle` 仍成功）、garrison 派同家族盟友的地必成功（覆盖注册在目标格、地块 `ownerId` 保持盟友不变，驻扎队伍仍是 `mine`）、garrison 派非盟友对手的地仍必拒（`/use attack/`，等同任意敌方地）。`field-redispatch.e2e.test.ts` 的"驻扎锁死需先召回"用例同样预置目标格为己方地。客户端新增 [`worldMapGarrisonAllyRules.ui.ts`](../../client/test/ui/worldMapGarrisonAllyRules.ui.ts)（6 例：中立地只给 Move 不给 Garrison、敌方地只给 Attack、家族盟友地/结盟宗门盟友地都只给 Garrison 不给 Attack、点 Garrison 派发 `move+garrison`、已驻扎盟友地显示 Recall）；`worldMapOccupyConnectivity.ui.ts`/`worldMapRelocateGate.ui.ts` 的"灰显"断言改「按钮整体不存在」，删掉两处"点击灰按钮弹 toast"的用例（按钮已经不存在，点不到）；`worldMapBaseClick.ui.ts` 的"落单 mine 格子仍走通用菜单"用例补齐周围 8 格同为 mine（否则新的 `footprintAllMine` 门槛会让 Relocate 按钮从预期的标签列表里消失）。
- **验证**：worldsvc `tsc --noEmit` 全绿，`npx vitest run`（50 文件/403 例，含以上改动）全绿；client `tsc --noEmit` 全绿，`npx vitest run --config vitest.ui.config.ts`（114 文件/988 例）+ `test/i18n.test.ts`（三语 key 齐全）全绿。可视化验证：中立地弹窗截图确认「移动并驻扎」按钮已消失、仅剩「移动到此（停留）」（本机单账号 dev world 可直接复现）；盟友领地分支需要第二个同家族/同宗门账号才能在真实地图上点出来，本轮未做实机截图，逻辑由上述 e2e / UI 单测覆盖。

**追加测试（同日，用户要求"加测试"）**：合入后发现 `field-garrison.e2e.test.ts` 的「盟友」覆盖只测了同家族一种，`friendlyAccountIds` 其实还认「结盟宗门」（不同家族、宗门互相结盟）这条更宽的路径，且到达时的二次核验（`tryParkTeam` 的 friendly 重判）此前只覆盖了"全程没变化"的happy path，没有"派发时是友方、途中变敌方"的对抗性场景。补两例：①仿 `alliance-mark.e2e.test.ts` 的 `FakeSocialsvc`（精简版，只实现 `friendlyAccountIds` 实际读的 `getFamiliesBySect`，其余接口方法留空实现满足类型）+ 两个不同家族但互相结盟的宗门（`sects` 集合直插 `allySectIds` 双向），验证跨宗门结盟（非同家族）同样能成功 garrison 到对方地块；②派发时目标是友方地块（校验通过），行军途中该地块被真正的敌对玩家攻占（直接 `$set ownerId:'rival'`），到达时 `tryParkTeam` 必须重新判定为非友方并拒绝落地——回退到出发地，而不是信任派发时的判定就地落到已经易主的敌方地块上。`npx vitest run test/field-garrison.e2e.test.ts`（9 例，含原 7 例）+ 全量 `npx vitest run`（52 文件/419 例，另一并行会话新增的用例也一并跑过）全绿。

---

## 59. Territory Overview 面板从纯文字堆叠改成资源表格 + 统计卡片（2026-08-02，用户看截图提出）

**背景**：用户截图圈出 Territory Overview 面板的 Overview 分页，指出五种资源、Troops/Territory、Season/Pop 全部是同样字号左对齐堆叠的文字行，"看起来就是一堆信息堆在一起"，要求整理成表格或更清晰的呈现形式。

**实现**（[`WorldMapPanels/territory.ts`](../../client/src/scenes/worldmap/WorldMapPanels/territory.ts) 的 `renderTerritoryPanel()` overview 分支）：
- **资源表格化**：Ink/Paper/Graphite/Metal/Sticker 五行改成图标（复用 HUD 顶部产量条同一套 `getResTexture`）+ 名称左对齐、数量右对齐（列位 `pw*0.62`）、产量右对齐三栏，行下加一条 `C.light` 细分隔线（`PIXI.Graphics.lineStyle`），读起来是表格而不是五条独立文字。
- **Troops / Territory 改成统计卡**：两张等宽 `sketchPanel`（红边框），左侧图标（`swords`/`castle`）+ 小号灰字标签 + 大号红字数值，替换原来两行加大字号的纯红字——给这两个"标题级"数字单独的视觉容器，不再只是字号更大的同一堆栈。
- **Season/Pop 收成一行**：合并成单行灰色小字放最下面，跟上面的表格/卡片留出额外间距，作为次要信息收尾，不再单独占两行跟 Troops/Territory 抢视觉权重。
- 以上改动都是纯渲染重排——没有新增按钮/交互，`modalBtnRects` 数量（3 个 tab + Close）不变。

**测试改动**：[`worldMapTerritoryPanel.ui.ts`](../../client/test/ui/worldMapTerritoryPanel.ui.ts) 的 Overview 分组新增 6 例：资源表格每行的 label/amount/yield 文本断言、Troops/Territory 两张卡各自的 label/value 文本断言、确认表格+卡片不引入额外按钮（仍是 4 个）、Season 数据存在时的合并行文案、Season 数据缺失时该行完全不渲染。

**验证**：`client` `tsc --noEmit` 全绿；`npx vitest run --config vitest.ui.config.ts test/ui/worldMapTerritoryPanel.ui.ts`（20 例）全绿。可视化验证：本机 Browser pane 对这个 WebGL 应用一贯的"pane 未显示，无法合成帧"限制（`client-run-and-visual-verify` 备忘录）这次同样命中，改走该备忘录记录的标准替代方案——临时在 `app.ts` 挂 `globalThis.__NW_DEBUG = {app, PIXI, WorldMapPanels}`，一次 `javascript_exec` 里手搭最小 `WorldMapContext`（数值照抄用户截图）直接调 `renderTerritoryPanel()`、`renderer.render()` 两次、`toDataURL()`、POST 到本地 collector 落盘截图，确认排版符合预期后把临时钩子从 `app.ts` 完整移除（`git diff` 确认该文件恢复干净）。资源图标格在这条离线渲染路径下是空的（未走正常图集预加载），属于验证路径本身的限制，不是代码问题——真实游戏流程里图标会正常显示。

**2026-08-03 续**：用户按 §57 的构图硬规重出了 10 张图（`art/slg/slg-playerbase/`，AI 出图 UUID 命名 + 一张备用）。全部带等轴测地台、矮宽、按密度递进，外接框宽高比 1.19~1.89（旧图约 1.0，脚本目标 1.43）——10 张里 7 张宽于目标，改由**宽度**预算触底，高度自动落在预算内，`HEIGHT_BUDGET_K` 只对 Lv.8/Lv.10 轻微生效。等级 ↔ 源图的对应关系（按能对上哪条 prompt 的特征物判定）和已知小瑕疵列在 [`player-base-image-prompts.md`](../product/player-base-image-prompts.md) 的"接入现状"表里。源图 `playerbase_l1..l10` 统一改成 `.png`（原 l6~l9 的 `.webp` 删除，避免打包脚本的 `.png` 优先解析留下同名死文件）。测试改动：§57 加的下界断言（"绘制高度不低于地块自身高度"）在新图上必然失败——它默认了每帧都由高度预算触底，而够宽的稀疏营地（Lv.1，宽高比 1.89）是宽度触底、本来就该比地块矮；下界放宽到地块高度的一半，注释说明为什么不能收紧。验证：`tsc --noEmit` 全绿，UI 测试 114 文件 / 1009 例全绿，10 个等级逐个真机截图核对（`?worldmap&desk=N` 临时调试分支 + Playwright，截完已清理）。

---

## 60. `openapi-social.yml` 补 Error schema + ErrorResp（comm-audit-p2-remaining §43 遗留的第 4 项，2026-08-03，AI 主动推进）

**背景**：comm-audit-2026-07-27 fix arc 的 P2 尾巴里，`world`/`auction` 两份契约已经在 2026-08-02 补上了 `Error` schema + `ErrorResp` 响应（逐 operationId 核对真实 handler 抛出的 `ErrorCode`），`social` 当时明确排除在外。本次按同一套方法补齐 `server/contracts/openapi-social.yml`。

**实现**：`components.schemas.Error`（`{code, message}`）+ `components.responses.ErrorResp`（envelope，`ok:false` + `error`），与 world/auction 完全一致的写法。逐个 operationId 追踪 `server/socialsvc/src/httpApi.ts`（705 行，唯一的请求分发入口，所有 `/social/*` 路由共享同一个 try/catch，未捕获的 `SlgError` 由 catch 块统一转成对应状态码）+ `familyService.ts`（`SlgError` 直接 throw）+ `friendService.ts`/`mailService.ts`（返回 `{kind:'error', error}`/布尔值，由 `httpApi.ts` 里的 `sendSocialErr`/内联判断转换）三个 service 文件，给 35 个 operation 各自标注准确的状态码（不是无脑给所有路径贴同一组 400/401/500）——例如 `getMyFamily`/`getFamily`/`browseFamilies` 这类纯查询、内部从不 throw 的接口只有 401/500 兜底；`createFamily` 有 400（tag 格式/宽度/敏感词）+ 409（重复入会）；`sendChatMessage` 除 400/403/404 外还有 429（`allowChat` 速率限制）。

**副发现**（追踪过程中顺手发现的两处契约缺口，随手一并修掉）：
1. **`/social/friends/report` 完全没进契约**——`httpApi.ts` 里举报接口本身在 2026-07-27 那轮就已实现（design-doc-audit-2026-07 记过），但没人把它加进 `openapi-social.yml`，contract-first 的口径一直是假的。本次一并补上 `operationId: reportFriend`（`POST /social/friends/report`，400/401/404/500）。
2. **`/social/player/{accountId}/rank`（`getPlayerRank`）声明了但从未实现**——契约里一直有这条路径，`routes.gen.ts` 也照常生成了类型，但 `httpApi.ts` 里根本没有匹配这条 path 的分支，实际调用会落到兜底的 `endpoint not found`（404），永远不会走到契约里描述的 200 成功响应。客户端也从未调用过它（`getProfileExtra` 是实际在用的等价接口）。这不是本次任务能单方面拍板修的东西（是该补实现，还是该把这条路径从契约里删掉，是产品/契约治理层面的决定），只在 yml 里加了行内 `summary` 注释记录现状，留给用户决定。

**验证**：`server/socialsvc && npm run gen:api:social`（regen `routes.gen.ts`）+ `gen:api:social:check`（drift check，35 operations / 18 schemas，通过）；`server` 全量 `npm run typecheck`（11 个 workspace 全绿，其中 `@nw/shared`/`@nw/engine` 在这个新 worktree 里之前没 build 过，顺手 build 了一次，跟本次改动无关）；`client && npm run rest:gen` + `npx tsc --noEmit` 全绿；`socialsvc` `npx vitest run`（7 文件 / 89 例）全绿。未做可视化验证——纯契约/类型层改动，不影响任何渲染路径。

---

## 61. §60 遗留的 `getPlayerRank` 死路由——拍板删除，而非补实现（2026-08-03，用户要求拍板）

**背景**：§60 记录时把 `/social/player/{accountId}/rank`（`getPlayerRank`）标成"留给用户决定"；用户随后明确要求"拍板一下"，把决定权交回来。

**调查**：追了 `getPlayerRank` 这条链路的完整历史，而不是只看当前状态——`SOCIAL_DESIGN.md`"资料卡统一改造（2026-07-23）"那段记录着：ProfilePopup 曾经在好友列表/家族成员/世界频道三处各自手动拼 rank/elo/family/sect 字段，其中家族场景是"手动异步 `getPlayerRank`"；2026-07-23 那次改造把三处全部收敛进统一的 `GET /social/profile/:publicId/extra`（`getProfileExtra`），三处手动调用（含家族场景的 `getPlayerRank`）当时就都删掉了。`server/socialsvc/src/metaClient.ts` 里的 `getPlayerRank(accountId)`（供 socialsvc 内部调用 meta `/internal/player?accountId=` 的封装方法）在这轮统一改造之后就已经没有任何调用点——`grep '\.getPlayerRank('` 全仓库零命中，是个从 2026-07-23 起就孤立的方法；契约里的 `/social/player/{accountId}/rank` 路由则是更早遗留、从未真正对接到 `httpApi.ts` 的路由声明。也就是说 `getPlayerRank` 提供的能力（按 accountId 查 rank/elo）不是"还没做"，而是"做过、后来被 `getProfileExtra` 整体取代、旧路径没人回来清理"。

**拍板：删除，不补实现**。理由：①功能已被 `getProfileExtra` 完整覆盖（后者是 rank/elo 的超集 schema，外加 familyName/sectName）；②补实现等于把一条已经被验证多余的旧接口复活，纯增加维护面、零消费方；③其内部依赖的 `metaClient.getPlayerRank(accountId)` 本身已是孤儿代码，实现它还得先把这段孤儿代码找回意义——不划算。

**实现**：从 `openapi-social.yml` 删除 `/social/player/{accountId}/rank` 路径 + 未再被引用的 `PlayerRankView` schema（确认 `ProfileExtraView` 是独立 schema，不 `$ref` 它，删除安全）；`server/socialsvc/src/metaClient.ts` 删除 `SocialMetaClient.getPlayerRank` 接口方法 + `HttpSocialMetaClient`/`nullSocialMetaClient` 两处实现（保留 `getPlayerRankByPublicId`，这条仍是 `getProfileExtra` 的唯一数据来源）；`server/socialsvc/test/harness.ts` 的 `FakeSocialMetaClient` 同步删除假实现。`metaserver` 的 `/internal/player?accountId=|publicId=` 端点本身不动——`grep 'internal/player'` 确认 `gateway/src/metaClient.ts`（自己的 ELO 查询用途）和 `admin/src/clients/player.ts` 仍在用 accountId 变体，只是 socialsvc 自己的封装方法是孤儿，不影响这条端点对其它服务的价值。

**验证**：`gen:api:social`（34 operations / 17 schemas，比 §60 的 35/18 各少 1）+ `gen:api:social:check` 通过；`server` 全量 `npm run typecheck`（11 workspace 全绿，含 gateway/admin 未受影响）；`client` `npm run rest:gen` + `npx tsc --noEmit` 全绿；`socialsvc` `npx vitest run`（7 文件 / 89 例，用例数不变——`getPlayerRank` 本来就没有专属测试，删的是从未被测过的死代码）全绿。未做可视化验证——纯契约/死代码清理，不涉及任何渲染路径。

---

## 62. §60 ErrorResp 追踪的状态码补测试（2026-08-03，用户要求"全部改动加测试"）

**背景**：§60 给 35 个 operation 标的状态码是靠**读代码逐条追踪**出来的，不是跑出来的——用户要求给本次会话的改动统一补测试，借这个机会把追踪结果和真实运行结果对一遍账。

**盘点**：对照现有 `server/socialsvc/test/*.test.ts`（`family.e2e`/`friend.e2e`/`mail.e2e` 是 service 层直调，`familyHttp`/`mailHttp`/`chatRegionHttp` 是真实 `startHttpApi` + 真实 Mongo 的 wire-level 测试），逐个 operation 核对后发现 **15 条错误路径此前在任何层级都没有测试覆盖**：`searchFamilyByTag` 400、`respondFamilyJoinRequest` 404、`leaveFamily` 400/403、`kickFamilyMember` 400/403/404、`setFamilyMemberRole` 400/403/404、`disbandFamily` 403、`setFamilyAnnouncement` 400/403、`getFamilyChannel` 403、`searchFriend` 400/404、`blockFriend` 400/404、`reportFriend` 400/404（§60 新加进契约的那个端点，此前压根没测过）、`getChatMessages` 404、`sendChatMessage` 429、`markConversationRead` 400、`readMail` 404。其余 20 个 operation 的错误码已经被 `family.e2e`/`friend.e2e`/`mail.e2e`/`familyHttp.e2e` 等既有测试直接或间接覆盖，不重复补。

**实现**：新增 `server/socialsvc/test/socialErrorsHttp.e2e.test.ts`（照抄 `familyHttp.e2e.test.ts` 的 real-server-real-Mongo 写法），31 个用例逐一对上面 15 条路径发真实 HTTP 请求，断言 wire-level 状态码 + `error.code`。其中 `sendChatMessage` 429 那条实测验证了 `allowChat()` 的滑动窗口限速——`CHAT_SEND_RATE_PER_MIN=30` 用的是真实 `Date.now()`，不是可注入的假时钟，所以测试直接连发 31 条消息（都落在同一个 60s 窗口内）而不需要伪造时间。`reportFriend` 补了三种场景（缺参/目标不存在/举报自己）+ 一次成功举报并断言 Mongo 里落地的 `reports` 文档字段。

**结果**：31 个新用例**首次运行全部一次通过**——说明 §60 逐行追踪 `httpApi.ts`/`familyService.ts`/`friendService.ts`/`mailService.ts` 得出的状态码全部准确，没有因为静态追踪漏看分支而记错。`getPlayerRank`（§61 已删）没有补回归测试——它从来没工作过，删除不存在"防止行为倒退"的需求，跳过。

**验证**：`socialsvc` `npx tsc --noEmit` 全绿；`npx vitest run`（8 文件 / 120 例，89 旧 + 31 新）全绿。未做可视化验证——纯 server 测试改动。

## 63. §56 Shop 面板图标细节不足——`troop_speedup` 拆出专属沙漏图标 + `armor` 补铆钉细节（2026-08-04，用户看截图提出）

**背景**：用户看 §56 做的 Shop 面板截图反馈"所有物品看起来一样，但是功能上却差别很大"。复核 `SHOP_KIND_ICON`（[`worldmap/WorldMapPanels/shop.ts`](../../client/src/scenes/worldmap/WorldMapPanels/shop.ts)）四个图标：`coinChest`/`trophy` 本身笔画较多（箱体+锁扣+溢出金币；奖杯+双耳+底座），但 `troop_speedup→spd`（仅两道 `>>` 折线）和 `protection→armor`（素框+一道中线）明显单薄，且 `spd` 是复用 `EquipmentScene` 的「移速」词条图标——训练加速与移动速度本是两个不相干的概念，共用箭头符号纯属望文生义的巧合。

**实现**：
- `render/icons/slg.ts` 新增 `drawHourglass` + `IconKind.hourglass`：沙漏木框（顶/底横杠）+ 顶部/底部沙堆填充 + 颈部两粒下落沙砾 + 右侧三道渐隐"加速刻度"短线，专门表达"时间被压缩"，不再借用移速箭头。`worldmap/WorldMapPanels/shop.ts` 的 `troop_speedup` 改指向 `'hourglass'`；`EquipmentScene` 的移速词条继续用原 `'spd'`，两者不再共用一套语义。
- `render/icons/equipment.ts` 的 `drawArmor` 补细节：肩部十字横带 + 左上内嵌棱线（emboss）+ 两颗顶角铆钉圆点，外轮廓/尺寸不变——`armor` 复用面很广（装备槛位 tab、驻防行军图标、City HQ 建筑图标等），只加细节不改剪影，全部复用点视觉一致收益、零语义风险。

**追加（同日）**：用户接着问同一 `kind` 内的分档（`troop_speedup` 1h/8h/24h、`protection` 8h/24h）图标怎么区分——三档沙漏 / 两档盾牌本来就共用同一张 `buildIcon` 输出，图标层面完全一样，靠卡片里的名称文字分档。用户明确偏好"直接看图"而非读数字文案，因此没有走金币档位那套"图案随档位递增复杂度"的老路（沙漏/盾牌的细节量递增不如金币数量递增直观，且卡片图标框只有 ~74px，细微差异难辨认），改为在 `renderShopItemCard`（`worldmap/WorldMapPanels/shop.ts`）新增 `shopBadgeLabel()`：仅对有 `duration_sec` 的两个 kind（`troop_speedup`/`protection`）在图标框右上角贴一个 `1H`/`8H`/`24H` 角标（`txtOutlined`，白描边保证压在图标线稿上依然可读，风格照抄 `EquipmentScene/inventory.ts` 现有的库存数量角标惯例）；`resource_pack`（按数量分档，无 `duration_sec`）和 `battle_pass`（无分档）不加角标，维持原样。

**验证**：`client` `npx tsc --noEmit` 全绿。可视化验证：`app.ts` 临时挂 `globalThis.__NW_DEBUG={app,PIXI,buildIcon}` / `{app,PIXI,WorldMapPanels}`（完成后均已还原，diff 归零），起 `game-verify2`（9290）dev server；第一轮直接 `buildIcon()` 四个图标渲染到 160px 网格核对细节；第二轮用 `new WorldMapPanels(fakeCtx).renderShopPanel()`（fakeCtx 只填 `renderShopPanel`/`renderShopItemCard` 读到的字段）灌入 1h/8h/24h speedup + 8h/24h shield + resource_pack + battle_pass 的假数据，渲染整个 Shop 面板——沙漏（时间+加速刻度）、宝箱（资源）、铆钉盾（防御）、奖杯（通行证）四者剪影与细节量级明显区分开；`1H`/`8H`/`24H` 角标在实际卡片尺寸下清晰可读，不再需要读文字才能分档。均通过本机 collector（`fetch POST` → 落盘 PNG）拿到真实像素核对，而非手抄 dataURL。

**追加2（同日，用户明确要求角标之外也要做图标级区分）**：用户反馈角标不够——即使只看图标本身（不看角标/文字），也不想让同 `kind` 内的档位共用一张完全相同的图。等于是把上一条追加里刚放弃的"金币档位式递增复杂度"路子捡回来，但两者不冲突：角标继续保留，图标本身再叠加一层区分。
- `render/icons/slg.ts` 把 `drawHourglass` 拆成 `hourglassCore(g,s,color,pile,ticks)` + 三个导出档位 `drawHourglassSm`/`Md`/`Lg`（`pile` 0.65/1.0/1.35 控制沙堆填充比例，`ticks` 1/2/3 同时控制颈部下落沙砾数和右侧加速刻度线数）——沙子多少、刻度多少都随档位递增，不再是同一张图。
- `render/icons/equipment.ts` 加 `drawArmorHeavy`：内部先调 `drawArmor` 铺基础层，再叠一道第二横带 + 两颗侧边铆钉，作为 `protection` 24h 档的"更厚重"版本；8h 档继续用原 `armor`（本来就复用最广，不动它的默认视觉）。
- `render/icons.ts` 新增 `IconKind`：`hourglassSm`/`hourglassMd`/`hourglassLg`（取代原来单一的 `hourglass`，该 kind 除本处外无其它引用，直接改名不留兼容层）、`armorHeavy`。
- `worldmap/WorldMapPanels/shop.ts`：`SHOP_KIND_ICON` 精简为只保留无分档的两个 kind（`resource_pack`/`battle_pass`）；新增 `SPEEDUP_ICON_TIERS`/`PROTECTION_ICON_TIERS` 两个档位数组 + `shopIcon(it)`——对 `troop_speedup`/`protection`，按 `duration_sec` 把同 kind 的 `ctx.shopItems` 排序，取 `it` 的名次索引进对应档位数组；其它 kind 走原来的扁平映射。

**验证（追加2）**：`client` `npx tsc --noEmit` 全绿。可视化验证按同一套"临时挂 `__NW_DEBUG` + collector 落盘"流程做了两轮：①整版 Shop 面板截图（假数据同上）确认卡片实际尺寸下也能看出差异；②160px 单独渲染 `hourglassSm/Md/Lg` + `armor`/`armorHeavy` 五张图核对细节——沙漏三档的刻度数（1/2/3）和沙堆大小肉眼可数清楚，`armorHeavy` 的第二道横带清晰可辨，侧边铆钉在小尺寸下偏不明显（贴着盾牌边线，容易和描边混在一起）但不影响整体可读性，双横带已经是足够的区分信号。全程复用 [[client-run-and-visual-verify]] 记录的"图为纯 buildIcon 输出，不牵扯登录/后端"路径；本轮额外遇到共享主目录里另一个会话正在写 `client/src/i18n/locales/zh.ts`（`CAMPAIGN_STORY.md` 相关文案，一度处于语法未完成的中间态导致整个 webpack bundle 编译失败），用 `git stash push --keep-index -- <单个文件>` 把这一个文件临时隔离出来验证、验证完立刻 `git stash pop` 还原，全程没有碰这个文件的实际内容，也没有影响另一会话的工作。

**追加3（同日，用户要求"全部加测试"）**：
- `worldMapShopPanel.ui.ts` 新增两组 `describe`：`shopIcon` 用手写的 `(panels as unknown as {...})` cast（项目里测私有方法的既有惯例，见 `claudedocs/client-testing.md`）直接调私有方法，断言：三档 speedup 不管 catalog 数组顺序如何都按 `duration_sec` 排出正确档位、同 kind items 数超过档位数组长度时最高档 clamp 不越界、单条目 catalog 不会算出越界索引、`resource_pack`/`battle_pass` 完全不受名次影响、未知 kind 兜底 `tag`；`shopBadgeLabel` 覆盖 1H/8H/24H 格式化 + 无分档 kind 返回 `null`。
- `icons.test.ts`（`test:render`，`environment:'node'`，无 canvas）本来就没真的构造过 `PIXI.Graphics`——想加"画图不报错"的烟雾测试时踩了一次坑：`new PIXI.Graphics()` 走到 `FillStyle→Texture.WHITE→createCanvas` 会因为没有 `document` 直接抛错，`test:render` 这层环境撑不住真实构造。改成新增 `test/ui/icons.ui.ts`（`test:ui`，走 `pixiHeadless.ts` 装的 headless ADAPTER，能安全构造真实 PIXI 对象）：对全部 `IconKind` 在 16px/64px 各画一遍断言不抛；再加两条几何断言——`hourglassSm/Md/Lg` 的 `graphicsData.length` 严格递增、`armorHeavy` 严格多于 `armor`——这两条是本次真正要守住的行为（"确实画了更多东西"，不是"角标贴上去看起来不一样"）。`icons.test.ts` 本身只加了 `ALL_KINDS` 里补齐 4 个新 `IconKind`（否则 `Record<IconKind,true>` 编译不过）。
- 全部改动跑通：`npx tsc --noEmit -p tsconfig.test.json` 全绿；`npx vitest run test/render/icons.test.ts --config vitest.render.config.ts`（2 例）+ `npx vitest run test/ui/icons.ui.ts test/ui/worldMapShopPanel.ui.ts --config vitest.ui.config.ts`（26 例）全绿。
- **共享检出事故记录**：为了在隔离 `zh.ts` 语法未完成态时跑测试，对 `zh.ts`/`en.ts`/`de.ts` 三个文件反复 `git stash push --keep-index -- <这三个文件>` 又 `pop`；有一轮 pop 时另一会话已经在 stash 期间（文件被临时还原到 HEAD 的窗口内）往 `de.ts` 写入了一行新改动（`campaign.epilogue` 文案重写），导致 `git stash pop` 因为"working tree 有未暂存改动会被覆盖"直接拒绝执行，没有静默丢内容。处理方式：确认 `git diff` 显示的是 EOL 差异导致原始 `diff`/`git merge-file` 误判整份文件冲突（`core.autocrlf=true`，working tree CRLF vs `git show` 输出 LF），把 `git show HEAD:` 和 `git show stash@{0}:` 取出的两份内容转成 CRLF 后再 `git merge-file` 三方合并，干净合并出"两次改动都保留"的结果（`campaign.epilogue` 新文案 + stash 里的 ch1–ch6 早期改动都在），`zh.ts`/`en.ts`（当时working tree等于HEAD，没有新改动）直接 `git checkout stash@{0} -- <path>` 取回，再 `git stash drop`。全程没有执行任何 `--force`/`git checkout --` 丢弃操作，最终提交只 `git commit -- <本任务自己的文件>`，`zh.ts`/`en.ts`/`de.ts`/`CAMPAIGN_STORY.md`/`world.md` 原样留在 working tree 未提交，交还给另一会话。

