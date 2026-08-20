# 服务端 — 测试覆盖补齐记录（2026-08-05 起）

> 从 [`server.md`](server.md) 拆出（2026-08-17，原文件 913 行——其中 85%% 是历史记录，把「查端口/查约束」的快查用途淹了）。
> 快查内容（架构约束 / 进程与端口 / 构建 / 启动 / 部署 / 各服务要点）仍在 [`server.md`](server.md)。
> 各服务从 0~25% 拉到 90%+ 的逐个补测记录、覆盖率工具、CI 稳定性。**已完成的历史；当前测试约定见 [`client-testing.md`](client-testing.md) 和各服务 `vitest.config.ts`。**
>
> **2026-08-20 二次拆分（ADR-067，原文件 501 行）**：本页保留两轮「哪些代码路径完全没测过」的人工审计，其余三个主题各成分册。小节标题与正文一字未改。

| 分册 | 内容 |
|---|---|
| [`server-testing-coverage.md`](server-testing-coverage.md) | 13 个包逐个把行覆盖率从 0~25% 拉到 90%+ 的补测记录（metaserver / admin / gameserver / gateway / botsvc / auctionsvc / socialsvc / commercial / shared / worldsvc / engine / matchsvc / analyticsvc），一个包一节 |
| [`server-testing-tooling.md`](server-testing-tooling.md) | 覆盖率百分比工具接入、90% 硬门禁、CI 并行拆分、CI 稳定性（flaky / retry / 确定性规则） |
| [`server-testing-typecheck.md`](server-testing-typecheck.md) | `test/**` 首次接入类型检查：13 个包各补 `tsconfig.test.json`、`client/tsconfig.fulllink.json` 接管跨包 full-link 测试、`MatchReplayDoc.commands` 收紧成 `string` |

本页保留的两节是**人工审计**（「哪些代码路径完全没测过」），与上表第二行的**百分比**不是一回事——两者的区别见 [`server-testing-tooling.md`](server-testing-tooling.md) 开头。

---

## server 端测试全量覆盖审计（2026-08-05）

对 `server/` 全部 11 个服务进程 + `shared`/`engine` 两个基础包的测试目录（~230 个测试文件）做了一轮遗漏/冗余审计，按包分 8 组并行审计（metaserver 拆 core 与 progression 两组；worldsvc 拆 territory/city/map 与 combat/siege/march 两组；shared+engine 一组；commercial+auctionsvc+admin 一组；socialsvc+analyticsvc+botsvc 一组；gateway+matchsvc+gameserver 一组），随后按同一分组并行落地最高置信度/最高价值的发现（8 个实现子任务各自在独立 worktree 里改动互不重叠的文件，完成后逐一合并进本任务分支，全程零冲突）。

**发现并修复一处真实产品 bug**：`worldsvc/src/sectService.ts` 的 `sendMessage` 从未调用 `censorChat`，`/sect/message` 路由也没算 `ChatRegion`——宗门频道是全服唯一跳过敏感词过滤的持久聊天频道（对比 `nationChannelService.ts`/[国名审核](#worldsvc-代码审查--修复2026-08-03) 早已用同款 `censorChat`+`regionFromAcceptLanguage` 套路）。按既有套路补齐（`httpApi.ts` 解析 `regionFromAcceptLanguage` 传入 `sendMessage`），`sect.e2e.test.ts` 新增回归测试。

**删除 / 折叠（冗余或测的是假实现而非真代码）**：
- `metaserver/test/compliance.test.ts` 整文件——三段测试全部对着文件内手写的 `computeProbabilities`/`shouldIngest`/`authCheck` 断言，从未 import 真实 `src/` 代码，真实行为坏了这些断言也照样通过。三段各自已有更强的真实覆盖（`commercial/test/gacha.test.ts` 的真 `fixedOddsTable`、`analyticsvc/test/analytics.e2e.test.ts` 的真同意闸+真 Mongo、`account-deletion.test.ts`+`auth-password.e2e.test.ts` 的单独 banned/deleted 场景），唯一缺的"两个标志同时置位时 deleted 优先"组合场景补成真代码集成测试后再删文件。
- `metaserver/test/cards.e2e.test.ts` 里与 `equipment.e2e.test.ts` 重复的"两卡抢同一装备"测试（顺带该测试自身有个恒真断言 `[200,400,409]).toContain(200)`）。
- `metaserver/test/events.test.ts` 两处对 `isEventActive` 窗口判定的重复测试。
- `worldsvc/test/slg-season.test.ts` 整文件——测的全是 `@nw/shared` 纯函数（`familyProsperity`/`decayProsperity`/`settleTier`/`sectStrengthScore`/`allocateSectsToShards`），跟 `shared/test/prosperity.test.ts` 边界值重复，无 worldsvc 接线覆盖；`shard.e2e.test.ts` 里同款"G6 shard 纯函数"重复块同理。各自唯一有价值的 case（12 宗门均衡分布、负数人口聚类的下界钳制）已搬进 `shared/test/prosperity.test.ts`。
- `shared/test/equipment.test.ts` 里"epic 在 +0 时不可分解"是紧邻的"epic 在任意等级（含 +0）都不可分解"循环测试的严格子集。
- `matchsvc/test/ladder.test.ts` 整文件——测的 `eloToRank`/`computeEloDelta`/`nextStreak`/`RANK_TIERS` 全部只是 `@nw/shared` 再导出，matchsvc 自身只消费同模块的 `pickBotDifficulty`（该函数已在 `matchsvc.test.ts`+`shared/test/ladder.test.ts` 双重覆盖），`shared/test/ladder.test.ts` 本身已用更全的边界值覆盖同一份源码。

**改写一处过期断言**：`auctionsvc/test/auction-audit.e2e.test.ts` 的"方向不同=不同的异常对"测试断言的是 2026-08-04 修复前的有向配对语义——修复后 `detectAuctionAnomalies` 已改成无向合并，这条测试只是碰巧（单方向 5 笔已够单独触发阈值）还测得过，并不实际验证合并行为。改写成真正验证 A→B/B→A 各 3 笔（单方向都不够阈值）合并成一条 `trades===6` 的异常。

**弱断言修紧**（均为"实现坏了也照样通过"类问题，逐一改成精确值/长度校验）：`access-log.test.ts`/`state-replay-share.e2e.test.ts`（松区间→精确值）、`internal-economy.test.ts`（幂等测试原来只 POST 一次，从未真正触发去重分支）、`leaderboard-cache.test.ts`（补齐字段映射断言）、`internal-mail.test.ts`（`toMatchObject` 补 `hasAttachment`）、`moderation-penalty.e2e.test.ts`（`typeof===number`→精确时间窗）、`sparse.e2e.test.ts`（"只返回占领格"断言原本对任意缺三个标记的格子都成立）、`city-buildings.e2e.test.ts`/`city-training.e2e.test.ts`（松区间→精确值）、`siegeWorkerPool.test.ts`（补上测试名承诺过却没写的上界断言）、`redis-presence.e2e.test.ts`（`toMatchObject({})`→精确 `false`）、`friend.e2e.test.ts`/`analytics.e2e.test.ts`（`.every()` 前补非空校验，防止"推送/漏斗结果为空"这类回归被空数组的真值短路吞掉）、`contentModerationBridge.e2e.test.ts`（`toBeDefined()`→精确对象）。以及两处过期注释订正（`teams.e2e.test.ts` 的驮兵上限数值、`base-integrity.e2e.test.ts` 的文件头描述与测试体不一致）。

**补齐此前零覆盖的高价值模块**（均为多个独立审计一致标记的真实缺口）：`shared/src/dailyCounter.ts`（[adsDaily/pveDaily/victoryDaily 迁 Redis](#adsdailypvedailyvictorydaily-迁-redis2026-07-27中期项第-3-项) 的底层原子计数器，此前只被业务层 e2e 间接覆盖，从无边界值测试——新增 `shared/test/dailyCounter.test.ts`）、`botsvc/src/internalHttp.ts`（内部管理面 `/status`/`/scale`/`/pause`/`/resume`/鉴权闸整个文件此前无测试——新增 `botsvc/test/internalHttp.test.ts`）、`socialsvc` 的 `bumpActivityAndProsperity`/`unclaimMailAtomic`（两个都是有文档记录的历史 bug 修复函数，此前零测试）、`commercial` 的 `verifyNonCoinReceipt`（月卡/年卡/首充礻据校验闸，此前零测试）、`auctionsvc` 的价格护栏边界值/反狙击负例/`AUCTION_BANNED_MATERIALS`、`metaserver` 的 `/fate/redeem`+`/year-card/buy`+`/promo/redeem`（`economy.e2e.test.ts` 的 `FakeCommercial` 此前根本没实现这三个方法）与 paddle 退款 webhook、`worldsvc` 的 `TROOP_CAP_REACHED`/建造队列已满拒绝、以及**平铺（非卡牌）军队的野战遭遇/箭塔伤害路径**（`combatSiege/encounter.ts` 的 `!aHasCard`/`!dHasCard` 分支此前全部测试只用卡牌军队构造，平铺分支从未被覆盖；箭塔全灭分支在真实数值下数学上不可达，专开 `field-tower-flat-destroy.e2e.test.ts` 用 mock 伤害比率强制触发，文件头详细记录了为什么需要单开文件）。

**规模**：metaserver 67 文件/830 测试、worldsvc 53/442、shared 36/712（原 35/680）、commercial 11/159、auctionsvc 9/97、admin 8/74、socialsvc 8/130、analyticsvc 1/25、botsvc 10/51（原 9）、gateway 5/41、matchsvc 6/108（原 7，删了 1 个冗余文件）——全部 `tsc --noEmit`/`tsc -b` + `npm test` 绿。gameserver/engine 两包审计后确认现状良好（engine 的 `TraitSystem`/`EscortSystem` per-tick 副作用有覆盖缺口，见下）未改动。

**本次审计发现的缺口远多于落地的修补量**，按价值排序未处理的主要项留作后续任务输入：`metaserver/src/ads.ts` 的 AdMob/微信广告回调路由（ECDSA/HMAC 签名校验、防重放）零覆盖；`server/engine/src/systems/{TraitSystem,EscortSystem}.ts` 的 per-tick 被动效果（aura_heal/护送到达/死亡事件）零覆盖；`analyticsvc` 的漏斗/分布查询函数（`queryTutorialFunnel`/`querySceneFunnel`/`queryLevelFunnel`/`queryBrowserDist`/`queryDeviceTypeDist`/`queryGeoDist`）、`parseUserAgent`、`sessions` 集合写路径均零覆盖（2026-08-02 拆分后测试未跟上）；`gateway`/`matchsvc` 的 `internalHttp.ts`（真正的进程间通信边界）零覆盖，实际测试全走内存直调绕过了协议层；`matchsvc/src/GameRegistry.ts` 的真实负载均衡算法（`register`/`heartbeat`/`pick`）零覆盖，所有测试构造的都是零实例兜底场景；`botsvc/src/battleSession.ts`（真正的对局编排状态机）全程只在别的测试里被 mock 掉，从未真跑过。完整分组审计发现清单（含每项置信度/工作量估计）见本次会话记录，未在此文档逐条展开。

## server 测试覆盖缺口补齐（2026-08-10）

补齐上条 2026-08-05 全量审计留下的 6 项高优先级 backlog，外加 4 项"时间允许再做"的低优先级项，全部完成（6 个高优先级独立 worktree 内并行分包落地，逐包互不重叠文件，完成后合并进本任务分支）。

**六项高优先级**：
1. **`metaserver/src/ads.ts`**：`ads.test.ts` 文件头此前声称覆盖了 WeChat/AdMob SSV 回调签名，实际只测了客户端 `verifyAdPlatformToken` 和 `economy.ts` 辅助函数——文件头注释与实际内容不符，已订正。新增 18 例真正打 `registerAdCallbackRoutes` 注册的 `/ads/callback/admob`（`fetch` mock 一对现场生成的 ECDSA-P256 测试密钥）/`/ads/callback/wechat` 两条路由：合法签名/篡改 payload/缺字段/未知 key_id/`fetch` 网络失败保守拒绝/transaction_id 重放幂等，均断言到 `commercial.adsCredit` 的真实调用与否（不只测状态码）。
2. **`engine/src/systems/{TraitSystem,EscortSystem}.ts`**：新增 `trait-system.test.ts`（7 例：aura_heal 范围内外/regen 累积转 HP 取模/slow 到期 resetSpeed/markedTicks 到期不为负/summonOnTimer 到期真 spawn+事件+cooldown 重置）+ `escort-system.test.ts`（4 例：推进/waypoint 吸附/arrival clamp/death），均驱动真实系统跑 tick 断言状态变化而非只查字符串。`package.json` 的 `test` 脚本（`node --test` 显式文件列表）补上这两个新文件名，否则不会被执行。**engine 完整套件有 1 例既有失败**（`equip_crit.test.js` 的强化倍率断言）——用 `git stash` 验证过与本次改动无关，是修改前就存在的失败，未处理。
3. **`analyticsvc`**：六个查询函数里 `queryTutorialFunnel`/`querySceneFunnel`/`queryLevelFunnel`/`queryBrowserDist`/`queryDeviceTypeDist`/`queryGeoDist` 确认此前零覆盖（另外 `queryEventCounts`/`queryDau`/`queryFunnel`/`queryRegionDist`/`queryOsDist`/`queryBadgeDist` 等已有覆盖）；`parseUserAgent` 零覆盖；`sessions` 集合写入路径（`ingestEvents` 里 `session_start`/`session_end` 的 upsert/update 分支）零覆盖。新增 `parseUserAgent.test.ts`（14 例纯函数单测）+ `service-domains.e2e.test.ts`（15 例，真实 `mongodb-memory-server` 聚合断言）。**顺带发现一处真实 bug**（当时未修，纯测试任务不改业务代码）：`service/ingest.ts` 的 `ingestEvents` 只在批次**同时携带** `session_start` 事件时才 `$inc events_count`，后续同一会话的纯事件批次不会再累加——真实流量里一个会话只发一次 `session_start`、之后全是纯事件批次，导致 `sessions.events_count` 字段永远停留在第一批的计数、低估真实活跃度。当时已用测试钉住这个行为，测试名里注明"documents current, likely-unintended behavior"，留给后续任务判断是否需要修复。
   - **2026-08-10 后续任务已修复**：触发条件从"批次是否携带 `session_start`"改成"批次是否有 `session_id`"（`batch.events.length` 在此处恒 > 0，见函数开头的早退），即每个批次都会用自己的事件数 `$inc events_count`，不再依赖 `session_start`。`$inc` 仍然只有这一处调用点，同一批次不会被算两次。`$setOnInsert.started_at` 相应改为 `sessionStart?.ts ?? batch.events[0]?.ts` 兜底（`session_start` 丢失/乱序时仍能拿到一个合理的会话起始时间）。原先钉住 bug 行为的测试已替换为验证正确累加行为的用例（含无 `session_start` 的批次仍会创建/累加 `sessions` 文档的回归测试），见 `service-domains.e2e.test.ts`「sessions collection write path」分组。
   - **同日再补 3 例**（同一会话内的后续任务）：两个 session 的批次交替到达时 `events_count` 互不污染、仅含 `session_end` 的批次同样计数、`session_start`+`session_end` 同批（一次性极短会话）一次性计对且 `started_at`/`ended_at` 均正确。
   - **补充边界测试（同日、另一并发会话独立执行）**：同分组下追加 6 例——乱序批次（`session_start` 晚到时 `events_count` 仍正确累加，但 `started_at` 保持"先到批次"的时间戳、不会被晚到的更早时间戳回溯纠正，这是 `$setOnInsert` 只在插入时生效的既有语义，非本次修复引入）、重复 `session_start`（不重复初始化 `started_at`，事件仍计数一次）、并发批次两例（已存在的 session 上并发 `$inc` 不丢计数；全新 session 上两个批次并发争抢 upsert-insert 同一 `_id` 也未观察到 duplicate-key 报错或丢计数，多次重跑未见 flaky）、空事件数组批次（早退路径不触碰 `sessions` 集合）。均通过，未发现新的真实 bug。两次并发的补充测试内容互不重叠，合并时按顺序拼接（`claudedocs/server.md`/`service-domains.e2e.test.ts` 两个文件都在合并时出现真实文本冲突，手工拼接解决），`service-domains.e2e.test.ts` 该分组最终 24 例，analyticsvc 总测试数 63。
4. **`gateway`/`matchsvc` 的 `internalHttp.ts`**：此前测试全部进程内直调方法绕过 HTTP 层（同类问题参考 T1 `NW_REDIS_URL` 事故）。两包各自新增测试真正用 `startInternalHttp()` 起一个监听随机端口的 server，用真实 `fetch` 打过去：gateway 26 例（`/health`/`/gw/push`(`/batch`)/`/internal/stats`/`/gw/presence`/`/gw/social/invalidate`/`/gw/judge`，覆盖合法/缺失/错误 `X-Internal-Key`、per-caller 严格模式、超限body 连接重置等），matchsvc 24 例（`/mm/room/*`/`/mm/queue/enqueue`/`/mm/conn/*`/`/mm/duel/*`/`/mm/game/register`+`/heartbeat`，同款鉴权+边界覆盖，并验证每条命令路由真的打到了 `Matchsvc` 实例而非只回 `{ok:true}`）。
5. **`matchsvc/src/GameRegistry.ts`**：此前测试全部构造零实例场景只测到 fallback-URL 分支。新增 19 例覆盖真实按比例选最空闲实例的算法：多实例负载比较、heartbeat 更新后选择结果变化、30s（`STALE_MS`）过期剔除含边界、容量耗尽跳过、`Math.max(1,capacity)` 下限、相同比率下的 tie-break 规则（先注册者优先，且 `pick()` 的乐观负载自增会让下一次 pick 翻转到另一实例）。
6. **`botsvc/src/battleSession.ts`**：此前 `bot.test.ts` 把整个文件 `vi.mock` 掉，状态机从未真实执行过。新增 `battleSession.test.ts`（19 例，mock `GatewayClient`/`GameServerClient`/`BattleEngine` 但真正跑 `playRankedMatch` 本身：正常胜负平/多 chunk 回填/三种 abort 时机/超时/`onMatchOver` 提前结束/`onDisconnect`/`advance()`/`ingestFrameBatch`/构造函数抛错时只 reject 这一局而不是让异常逃逸——即源码注释里点名的 2026-07-14 1000-bot 真实事故场景）+ `battleSession.realEngine.test.ts`（2 例，只 mock 网络层，`BattleEngine` 用真实 `@nw/engine`，镜像 `engineDriver.test.ts` 的双引擎 relay 模式跑一整局到 `game_over`，两种 side 分配都验证 `stateHash`/`winner` 与权威引擎一致）。

**四项低优先级（本次全部做完）**：
- `shared/src/gachaCatalog.ts` `validateCustomPool`：补齐约一半此前未覆盖的错误/校验分支，16 例。
- `shared/src/internalFetch.ts` `postInternal`：对齐姐妹函数 `fetchInternalJson` 的覆盖水平，10 例（成功/4xx 不重试/5xx 重试到预算/超时/连接拒绝/非 JSON body）。
- `commercial` 的 `wxPayVerify`/`stripeVerify`：**任务描述里"回调验签"的表述有误**，调查后确认这两个函数其实是主动查询微信支付/Stripe 官方 REST API 核对交易状态（出站请求，非入站 webhook 验签），包内没有 webhook 接收/验签代码路径。已按实际分支补测 14 例（trade_state/status 匹配、金额匹配到 tier/其它商品、金额不匹配、404、非 2xx/网络错误抛错），测试文件头注释里记录了这个表述偏差。
- `admin/src/service/shop.ts` `upsertShopItem`（怀疑"整体替换丢字段"数据丢失 bug）：**调查结论——确认是有意的整体替换语义，不是 bug**。证据：①同代码库 `flags.ts` 的 `FlagsMixin.upsertFlag` 独立出现同款"读 before 只拼审计摘要、`replaceOne` 整个文档"写法，非孤例；②唯一生产调用方 `tools/ops/src/pages/slgShop.ts` 的 Save 按钮总是把 `cost` 和（若该 item kind 有）`effect` 一起提交，不存在"只传部分字段"的真实调用路径。未改动行为，加了一条钉住当前语义的回归测试 + `upsertShopItem` docstring 补充说明依据，防止今后被当 bug 顺手改掉。

**规模**：metaserver 68 文件/899 测试（原 67/830，本次 +18，另因构建 `socialsvc`/`shared` dist 顺带修好 2 个此前因缺 dist 而失败的既有套件文件）、engine 15/104（原 13/93，+11，1 例既有失败与本次无关）、analyticsvc 3/54（原 1/25，+29）、gateway 6/69（原 5/41，+26+2 skip 既有）、matchsvc 8/157（原 6/108，+43=24+19，另新增 24 例见上）、botsvc 12/72（原 10/51，+21）、shared 36/742（原 36/712，+26，5 skip 因本机无 Redis，走既有降级模式）、commercial 12/181（原 11/159，+14）、admin 10/93（原 8/74，+含 shop.ts 回归测试等）——全部 `npm test`/`npm run typecheck`（`tsc --noEmit`）绿。

**已知遗留**：`tsc -b --noEmit` 组合对 `gateway`/`matchsvc` 等含 project references 的包会报 `TS6310: Referenced project '...' may not disable emit`——用 `git stash` 验证过这是仓库预置问题（本次改动前就存在，与本任务无关），本质是 TypeScript `--build` 模式与顶层 `--noEmit` 标志组合的已知限制；本次统一改用 `tsc --noEmit -p tsconfig.json`（或 `npm run typecheck`）验证，效果等价。`analyticsvc` 的 `events_count` 低估 bug（见上第 3 条）已于 2026-08-10 后续任务修复，不再是遗留项。

