# 服务端 — 测试覆盖补齐记录（2026-08-05 起）

> 从 [`server.md`](server.md) 拆出（2026-08-17，原文件 913 行——其中 85%% 是历史记录，把「查端口/查约束」的快查用途淹了）。
> 快查内容（架构约束 / 进程与端口 / 构建 / 启动 / 部署 / 各服务要点）仍在 [`server.md`](server.md)。
> 各服务从 0~25% 拉到 90%+ 的逐个补测记录、覆盖率工具、CI 稳定性。**已完成的历史；当前测试约定见 [`client-testing.md`](client-testing.md) 和各服务 `vitest.config.ts`。**

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


## 测试覆盖率百分比工具（2026-08-13）

不要与前两节"server 端测试**覆盖审计**（2026-08-05/08-10）"混淆——那两节是人工审计"哪些代码路径完全没测过"，这里是 CI 里自动量出**行/分支/函数覆盖率百分比**的工具接入，client 同一批改动见 `claudedocs/client-testing.md` 对应章节。

- **12 个 vitest workspace**（`shared`/`admin`/`analyticsvc`/`auctionsvc`/`botsvc`/`commercial`/`gameserver`/`gateway`/`matchsvc`/`metaserver`/`socialsvc`/`worldsvc`）：`vitest.config.ts` 加 `coverage: { provider: 'v8', reporter: ['text','lcov','html','json-summary'], exclude: [...coverageConfigDefaults.exclude, 'src/generated/**'] }`（proto/openapi 生成代码排除在外，不占分母）；`package.json` 加 `"test:coverage": "npm run pretest --if-present && vitest run --coverage"`（保留各自原有的 `pretest` codegen/proto:gen 步骤）。`@vitest/coverage-v8` 只在 `server/package.json` 根加一次 devDependency，靠 npm workspaces 的 node_modules 提升让 12 个子包都能解析到，不逐包重复声明。
- **`engine`**（唯一非 vitest workspace，走 `tsc -b` 编译到 `dist/` 后用 `node --test` 跑）：没有额外引入 c8/istanbul 依赖，直接用 Node 自带的 `--experimental-test-coverage`——`scripts/runTests.mjs` 新增 `--coverage` 参数，命中时给 `node --test` 追加 `--experimental-test-coverage --test-coverage-exclude=**/__tests__/** --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`（spec reporter 保留原有终端输出+文本覆盖率表，lcov reporter 额外落一份文件供 CI 汇总脚本读）。`package.json` 的 `test:coverage` 在既有 `test` 脚本末尾加 `--coverage` 转发给 runTests.mjs。
- **CI**（`.github/workflows/ci.yml`，`build-test` job）：`server unit + e2e tests` / `client unit tests` 两步从 `npm test` 换成 `npm run test:coverage`（`npm run test:coverage --workspaces --if-present` 在 server 根一次触发 12 个子包）；job 最后新增 `test coverage report` 步（`if: always()`），跑仓库根 `scripts/coverageSummary.mjs` 读每个包的 `coverage/coverage-summary.json`（vitest json-summary）或 `coverage/lcov.info`（engine），拼成一张 Markdown 表写进 `$GITHUB_STEP_SUMMARY`（GitHub Actions 跑完后运行摘要页可见），外加一行整体加权百分比。这一步本身**纯报告，不设硬性阈值门槛**——某个包这次没跑测试（文件缺失）显示 `—` 而不是让整个 job 变红，脚本本身永不 throw。
- **⚠️ 90% 硬性门槛（2026-08-15，14 个包全部拉到 ≥90% 之后加的）**：`coverageSummary.mjs` 原本读的 package 列表 + 两种解析器（`coverage-summary.json`/`lcov.info`）抽成 `scripts/coverageLib.mjs` 共享，新增 `scripts/checkCoverageThreshold.mjs`（同样从仓库根跑，读同一批 `coverage/` 产物）——只看**行覆盖率**（跟本仓库所有"补测"记录/记忆笔记一直沿用的口径一致，分支/函数只是参考不设门槛），任何一个包 <90%（或 `coverage/` 完全没产出，按"数据缺失=不达标"处理，不静默放过）就把这一步标红退出 1；阈值可用 `COVERAGE_THRESHOLD` 环境变量覆盖（默认 90）。`coverage-report` job 里紧跟 `test coverage report` 之后加了一步 `enforce >=90% line coverage per package`（同一个 `if: always() && github.event_name != 'pull_request'` job，PR 上不跑，只在 push-to-main / `workflow_dispatch` 那次跑），刻意拆成独立脚本/步骤而不是改 `coverageSummary.mjs` 本体——报告步骤按设计"永不失败"，门槛步骤按设计"低于阈值必须失败"，两者语义相反不能合并。**副作用（预期之内、正是要的效果）**：8 个 `*-deploy.yml` 都靠 `workflow_run.conclusion == 'success'` 门控，`coverage-report` job 一旦因这步变红，整个 `ci.yml` 的 workflow conclusion 变成 failure，所有部署自动被挡下——把"覆盖率是发布质量信号"从只读提示升级成了真正的发布闸门。**（2026-08-15 同日修订：`if: always() && github.event_name != 'pull_request'` 里的 PR 排除条件已删除，门禁在 PR 上同样生效；另加 `TESTS_OK` 判据——测试 job 已经挂了时不再把"缺 coverage 产物"报成第二条红。见下方"CI 稳定性"节。）**
- **`.gitignore`**：仓库根加了不带 `/` 前缀的 `coverage/`，一次性盖住 `client/coverage/`、每个 `server/*/coverage/` 和 `server/engine/coverage/`。
- **本地用法**：任意 workspace 目录下 `npm run test:coverage`；产物在该目录的 `coverage/`（`index.html` 可直接浏览器打开看逐行高亮，同 C#/coverlet 的体验）。

**2026-08-14 CI 并行拆分**（单 job 累计 10+ 分钟后的响应）：原单一 `build-test` job 里 server→client→tools 三段 `npm run test:coverage`/typecheck/build 全部挤在同一个 runner 上顺序跑；用实测数据定位瓶颈——`server unit + e2e tests` 这一步单独就要 ~11-12 分钟，其中 `metaserver`（~6.3 分钟）+ `worldsvc`（~3.3 分钟）两个包占了 ~85%（两者 `vitest.config.ts` 都设了 `fileParallelism: false`，注释写明是为了防止同进程内多个 e2e 文件抢同一个 mongodb-memory-server 实例产生数据竞争——**不是**意外遗留的慢速开关，不要不经排查直接打开）。拆分方案：
  - `build-test` 拆成 5 个独立 job：`server-checks`（codegen/filelength/typecheck，快，~40s，不含测试）、`server-test`（**matrix 三分片**：`metaserver` / `worldsvc` / 剩余 11 个包合成一组 `rest`，各自独立 runner + 各自的 mongodb-memory-server 实例，互不共享——分片跑在不同 runner 上，`fileParallelism:false` 那条"同进程内不许并发"的约束天然不适用，不用碰 vitest 配置）、`client-test`（typecheck/unit/UI smoke/build）、`tools-test`（5 个工具的 typecheck/test + 4 个的 build）、`coverage-report`（`needs: [server-test, client-test]`，聚合前四者上传的 coverage artifact 后跑同一份 `scripts/coverageSummary.mjs`）。GitHub Actions 里没有 `needs` 依赖的 job 默认并发跑在各自 runner 上，四个测试类 job 从"顺序执行"变成"并发执行"，服务端总耗时从 ~11-12 分钟降到受最慢分片（`metaserver`，~6.3 分钟）限制。
  - **coverage artifact 拼接细节**（容易踩坑的地方）：`actions/upload-artifact` 会把 artifact 内部路径"归一化"到所给 `path` 的最小公共祖先——单个目录当 `path` 时，产物会被拍平成该目录的**内容**（丢失目录本身这层前缀）；多个显式路径共享同一祖先时，则保留各自相对该祖先的子路径。`metaserver`/`worldsvc`/`client` 三个分片各自只上传一个包的 `coverage/` 目录（触发"拍平"），下载时对应地各自 `path:` 指到目标包自己的 `coverage/` 目录；`rest` 分片一次上传 11 个包的 `coverage/`（共同祖先是 `server/`），下载时整体 `path: server` 才能还原出 `server/<pkg>/coverage/...` 结构给 `coverageSummary.mjs` 读。四个下载步骤各自 `continue-on-error: true`——某个分片这次没跑起来（比如提前失败）就让对应包在报告里显示 `—`，不拖累整个聚合 job。
  - **⚠️ 同日续：拆分本身只是"摊平"，没消掉工作量——真正的退化源是 coverage，已把它挪出 PR 路径**。拆完之后 owner 拿出历史数据打脸：`main` 上 PR #93~#98 那批运行**一直是 ~7 分钟**（如 PR #98 的 `build-test` job 397s，`e2e` job 425s，wall clock = 425s），而 PR #99 未拆分时是 **27m50s**、拆分后仍有 **~16 分钟**。复盘发现最初的瓶颈定位起点就选错了——拿 PR #99 那次失败运行（13 分钟）当"现状基线"，从没去查 `main` 的历史运行，于是优化目标从一开始就偏了。逐步骤对照 PR #98 vs PR #99 才看清多出来的 ~20 分钟全部来自 `13.08.2026` 分支自己引入的两项（都不是拆分引入的）：①**`f8515745` 把 client 的 CI 命令从 `npm test` 换成 `npm run test:coverage`**——同一批测试文件（`test/difficulty/ch1-6` + `pvpSim` 那些 commit 早就在 `main` 里），**188s → 668s，v8 埋点让它慢了 3.6 倍（+480s）**；v8 instrumentation 的税恰好砸在最慢的那几个测试上（`difficulty/*` 和 `pvpSim` 跑的是完整无头战斗模拟，`ch6` 单个 331s，几千 tick 的引擎循环每一 tick 都在交这个税）。②`NW_REQUIRE_DB` 让 server 那 ~110 个 e2e 第一次真跑（+688s）——这条是真实质量提升，保留。**处理**：coverage 只在 **CD 前那次 CI** 跑（push 到 `main`——即 `workflow_run` 门控全部 8 个 `*-deploy.yml` 的那次——外加手动 `workflow_dispatch`），PR 上一律跑无 coverage 的 `npm test`。实现是 `server-test`/`client-test` 两个 job 各挂一个 job 级 `env: TEST_SCRIPT: ${{ github.event_name == 'pull_request' && 'test' || 'test:coverage' }}`，`run:` 里统一 `npm run "$TEST_SCRIPT"`；`upload coverage artifact` 两步和整个 `coverage-report` job 同步加 `github.event_name != 'pull_request'` 条件（PR 上没有 coverage 产物，否则报告整张表全是 `—`）。**为什么这么换是安全的**：14 个包（13 个 server workspace + client）**每一个**的 `test` 与 `test:coverage` 都验证过是同一条命令、只差一个 `--coverage` 标志（`engine` 是 `runTests.mjs --coverage`），且 14 个包两条 script **全都存在**——这点必须核对，否则 `--if-present` 会让缺 script 的包被静默跳过，正是本文档上面记过的那类"假绿"事故。`test:coverage` 里多出的 `npm run pretest --if-present` 只是补 npm 仅对 `test` 这一个名字自动触发 `pretest` hook 的差异，两者等价。所以 **PR 门禁强度零变化，只是不再产出报告**。**⚠️ 这条论证 2026-08-15 被推翻并回滚了**：`test` 与 `test:coverage` 确实是同一批文件、同一批断言，但**不是同一批失败**——v8 插桩把每个 await 窗口都拉长（同 commit 实测 worldsvc 184.53s→226.27s），时序敏感的 e2e 在 main 侧更容易挂，而 90% 门禁又只在 main 存在；结果是 main 上一天红两次、8 个 deploy 全被挡。现已改回两端一律 `test:coverage`，详见下方"CI 稳定性"节。理由本身也站得住：这份 coverage 按本节自己的定义就是"纯报告，不设硬性阈值门槛"、永远不会让 run 变红——在 PR 上它是拿三倍关键路径换一张 Markdown 表；而在 CD 前那次，这个数字确实被当作发布质量信号读，且没人卡在那儿等。预期 wall clock：client-test ≈ 916s−480s ≈ 436s、server 最慢分片 465s、e2e 408s 三者并行 ≈ **8.5 分钟**，比 7 分钟基线多出的 ~1.5 分钟就是"server e2e 从假绿变真跑"的必要成本。
  - **有意不做的事**：没有进一步把 `metaserver`/`worldsvc` 各自内部再用 vitest 原生 `--shard` 切成更小分片——那样能把两者都压到 ~3 分钟左右，但每个分片各自产出的 `coverage-summary.json` 只反映它跑到的那部分测试文件，`coverageSummary.mjs` 现有的 `readLcov`/`readJsonSummary` 都是整包读一份文件、不做跨分片按文件去重合并，会导致覆盖率数字失真（尤其 lcov 按 SF: 块求和的写法，同一源文件被两个分片各自命中一部分会重复计入分母）——如果以后真需要再压这两个分片的时间，要先给 `coverageSummary.mjs` 补上按文件路径去重合并的逻辑，而不是简单再加一层 matrix。

**首次实测基线（2026-08-13，行覆盖 %，本地跑出，用于对照未来回归）**：

| 包 | 行覆盖 | 分支 | 函数 |
|---|---|---|---|
| client（`src/game/**`） | 91.2% | 87.8% | 84.4% |
| engine | ~~86.5%~~ **92.98%**（2026-08-15 补测，见下） | 92.21% | 91.72% |
| shared | ~~82.3%~~ **98.96%**（2026-08-15 补测，见下） | 94.8% | 97.67% |
| worldsvc | ~~82.9%~~ **95.82%**（2026-08-15 补测，见下） | 87.57% | 97.93% |
| analyticsvc | ~~87.6%~~ **95.61%**（2026-08-15 补测，见下） | 97.56% | 98.64% |
| matchsvc | ~~88.3%~~ **93.99%**（2026-08-15 补测，见下） | 97.53% | 99.05% |
| commercial | ~~81.4%~~ **93.64%**（2026-08-14 补测，见下） | 76.9% | 91.8% |
| socialsvc | ~~78.4%~~ **94.71%**（2026-08-14 补测，见下） | 84.9% | 84.8% |
| botsvc | ~~70.0%~~ **92.74%**（2026-08-14 补测，见下） | 83.6% | 83.2% |
| auctionsvc | ~~72.3%~~ **92.0%**（2026-08-14 补测，见下） | 76.9% | 68.2% |
| gateway | ~~65.9%~~ **93.07%**（2026-08-14 补测，见下） | 70.3% | 76.8% |
| gameserver | ~~62.5%~~ **91.9%**（2026-08-14 补测，见下） | 91.4% | 95.9% |
| admin | ~~47.1%~~ **93.39%**（2026-08-14 两轮补测，见下） | 74.6% | 44.3% |
| metaserver | ~~35.1%~~ **90.84%**（2026-08-14 两轮补测，见下） | 78.4% | 32.3% |
| **加权总计** | **~70%** | **~82%** | **~71%** |

> 上表是 2026-08-13 的一次性基线快照，未逐行回填每次补测后的新值（metaserver→61.17%、admin→64.92% 均见下方各自小节）；gameserver 这行例外标了删除线，因为下一节紧接着就是它。

**metaserver 明显偏低**：`src/equipment/{craft,enhance,equip,reforge,salvage,trade}.ts`、`src/paddle/*`、`src/service/auth/{credential,helpers,oauthBind,profile,support}.ts`、`src/service/economy/*` 大片 0~10%——不是这轮改动引入的缺口，是这个包本身路由面最大（9 个 mixin/69 测试文件）但装备/Paddle/OAuth 这几块此前的 e2e 覆盖没跟上。**admin 47%**次低，同理。两者列为下一轮"server 端测试覆盖审计"（见上文 2026-08-05/08-10 两节）的优先输入，本轮不展开修——这次的目标只是把量出百分比的工具接上，不是把百分比刷高。

## metaserver 补测：equipment/auth/economy/paddle 从 0~10% 拉到 90%+（2026-08-13，同日追加）

上一节标的四块「大片 0~10%」查下来**不是没测**——`equipment.e2e.test.ts`/`economy.e2e.test.ts`/`paddle-routes.e2e.test.ts`/`auth-oauth-wx.e2e.test.ts` 等既有 e2e 早就把这些模块的成功/幂等/边界/拒绝分支测得很彻底，只是这批 e2e 全部 `import { buildApp } from '../dist/app.js'`（从 tsc 编译产物导入，配真实 Mongo）。vitest 的 v8 coverage provider 只对它自己用 Vite 转换加载的模块做 source-map 归因——`dist/*.js` 走 Node 原生 ESM 加载执行，覆盖率不会被记回 `src/*.ts`，于是"测得很彻底"和"报出来 0~10%"两个事实同时为真，互不矛盾。

**修法**：不重新发明这些场景，而是新增一批**直接 `import ... from '../src/...'`（不是 `../dist/...`）** 的单测，复用已有 e2e 想清楚的业务语义、但让同样的分支被 vitest 直接执行从而被 v8 正确记到 src 头上；顺带补了 e2e 没试到的错误码/边界分支。四组并行做（各自新增文件，互不touch）：

- `test/equipment-{craft,enhance,equip,reforge,salvage,trade,helpers}-unit.test.ts`（112 例）+ 新增共享 helper `test/helpers/fakeEquipCols.ts`（给 `FakeCollection` 补了 `deleteMany`/`$ne` 支持）、`test/helpers/fakeEquipCommercial.ts`（带 `getWallet`/`spend` 的假 commercial）→ `src/equipment` 0~10% → **98.53% 行 / 90.33% 分支**。
- `test/auth-credential-unit.test.ts` + `test/auth-oauthbind-unit.test.ts`（75 例）→ `src/service/auth/*`（含顺手覆盖的 `accountLifecycle.ts`）0~10% → **100% 语句/分支/函数/行**。
- `test/economy-service-unit.test.ts`（70 例）→ `src/service/economy/*` 0~10% → **90.54% 行 / 76.02% 分支**（少数 fire-and-forget 的 `.catch(log.warn)` 日志分支需要人为注入网络异常才能触发，未继续追，收益递减）。
- `test/paddle-unit.test.ts`（73 例）→ `src/paddle/{checkoutRoute,priceIds,signature,webhookRoute}.ts` 0~10% → **100% 行**（`webhookRoute.ts` 分支 95%，剩 2 处 `?? ''` 防御性兜底未覆盖）。

metaserver 整体行覆盖率 **35.1% → 61.17%**（`npx vitest run --coverage`，81 test files / 1256 tests 全绿，`tsc -b` 干净）。这批测试全部走 `FakeCollection`/注入的假 commercial+gateway 客户端（无需真实 Mongo），只有 paddle 的 checkout/webhook 路由测试沿用了 e2e 同款的真实 Mongo + 真实 fastify app（因为要验证真实的幂等/并发写路径）。

**过程中发现的测试基建缺陷，已于 2026-08-14 通用修复**：`test/helpers/fakeCollection.ts` 的 `updateOne` 在 upsert 时若 `filter` 不含 `_id`（`accounts.ts` 的 `resolveByDevice`/`resolveByOpenid`/`resolveByOAuth`/`registerWithPassword` 全是这种按 `deviceId`/`openid`/`oauth.provider+sub`/`password.loginId` 匹配的写法）会把新文档存进 Map 的 `undefined` 键、且返回值从不带真实 driver 会带的 `upsertedId`（`accounts/password.ts:52` 靠 `!res.upsertedId` 判断注册成功与否，用这个 fake 直测会把首次注册误判成"已占用"）；`docMatches` 也不支持 Mongo 对数组字段的隐式元素级匹配（`oauth: [{provider,sub}]` 这种）。之前所有用到 `fakeCollection.ts` 的测试都只按 `_id` 单键查询，没触发过这几点。当时两个 auth 测试文件各自用一个只作用于本文件 `accounts` 集合的子类包装绕过，未改动共享的 `fakeCollection.ts` 本体——**2026-08-14 把三处都折回了共享实现**：`updateOne` 的 upsert 新增 `buildDocFromFilter`（按真实 Mongo 语义从 filter 的实际字段构造新文档，而不是只用 `{_id: filter._id}`）、返回值补上 `upsertedId`；`docMatches` 新增数组分组匹配（点路径键共享同一个数组类型前缀时，要求同一个数组元素同时满足）。两个 auth 测试文件里原来的 `AccountsFakeCollection` 包装类已删除，直接用通用的 `FakeCollection`。新增 `test/helpers/fakeCollection.test.ts`（12 例）直接对 `fakeCollection.ts` 本体做单测——之前这个共享 helper 零专属测试，三处修复只能靠 auth 测试间接验证；新文件覆盖：无 `_id` filter 的 upsert 正确落到真实 `_id`（而非 `undefined` 键）、`upsertedId` 有/无的两种返回形状、`docMatches` 数组分组匹配（同元素 vs 跨元素不匹配）、以及 `_id`/非数组点路径的既有行为回归防护。`npx tsc --noEmit` 干净，`npx vitest run` 82 test files / 1268 tests 全绿。

**仍然明显偏低、本轮未覆盖**（下一轮候选，已于 2026-08-14 第二轮补完，见下方"metaserver 补测第二轮"一节）：`src/service/{liveops,pve}/*`（大片 0~10%，retention/achievements/pve 系列，同类"e2e 走 dist 导入"问题，`test/pve-anticheat.test.ts` 等已有 e2e 但同样没记到 src）、`src/{moderation,reputationDecay,anticheatAudit,oauth,gatewayClient,socialsvcClient}.ts`、`src/cards/fuse.ts`。

## admin 补测：src/clients/* 从 15~25% 拉到 90%+（2026-08-14，worktree `feat/admin-coverage`）

metaserver 补到 61.17% 后，14 包基线里最低的变成了 **admin（47.1%）**——本节按"根据覆盖率结果修复最低"处理这个包，同一 worktree 里做（`server/` 下 `@nw/shared`/`@nw/engine`/`@nw/metaserver`/`@nw/socialsvc` 各自真实 `npm install` + `npm run build`，见 `claudedocs/worktrees.md` 的 workspace 陷阱条目——`admin` 的 e2e 之一 `comp-mail.e2e.test.ts` 直接 `import` metaserver/socialsvc 的 `dist/`，不 build 这两个跑不起来）。

**根因跟 metaserver 那次不同，是真缺口，不是"测量方式导致的假 0%"**：admin 的 e2e（`shop.e2e.test.ts`/`moderation.e2e.test.ts`/`feedback.e2e.test.ts` 等）都是直接 `import { AdminService } from '../src/service'`，走真源码，`src/service/*` 覆盖率因此本来就有 70~100%。但这些测试全部把 `AdminService` 构造成各 client 字段传 `null`（`metaBaseUrl=null` 等），于是每个 `HttpXxxClient` 的 `available` getter 恒为 `false`，方法体第一行 `if (!this.xxxUrl) return ...` 就短路返回——**19 个 `src/clients/*.ts` 文件（约 1300 行）里真正发起请求 / 映射响应 / 降级失败分支的代码从未被执行过一次**，这也是 `src/httpApi/*Routes.ts`（fastify 路由处理器，0~2%）之外唯一大片真实缺口。

**修法**：19 个 client 文件全部走同一种形状——`fetchInternalJson`（`@nw/shared`）发请求，`available` 由 baseUrl 是否为 `null` 决定，失败要么降级成安全默认值（`[]`/`null`/`{ok:false}`）要么抛 `Error`/`EventsClientError`（操作类写请求，前端必须看到错误）。按这个形状 `vi.mock('@nw/shared', …)`（`importOriginal` 保留 `createLogger` 等其余导出，只替换 `fetchInternalJson`）就能让每个 client 方法体的每一行都可达，不用真起 HTTP server / mock `fetch`。新增 4 个测试文件，按"降级 vs 抛错"两种形状 + 规模分组（互不改动既有测试）：

- `test/clients-lookupAndQueue.test.ts`（18 例）：anticheat/mismatch/pvpCardStats/suspiciousPve/feedback/appeals/reports/enforcement——"GET 列表 + POST 动作，失败一律降级成安全默认值"这一形状。
- `test/clients-metaWrite.test.ts`（11 例）：stats（gateway+matchsvc 两路 `Promise.all` 合并，各自独立降级）、player（lookup/search/resetPassword，含 404→null 专用分支）、mail（send/preview，含 404/501→"功能尚未上线"专用分支）。
- `test/clients-adminManage.test.ts`（14 例）：events（+ 被 gachaPools/promo/paddleEvents 复用的 `EventsClientError`）、gachaPools、promo、paddleEvents、ladder——"失败直接抛错，前端必须看见"这一形状。
- `test/clients-worldAuctionAnalytics.test.ts`（11 例）：world（最大的一个，季节生命周期 + 地图模板，统一走内部 `request()` 抛错）、auction（异常扫描 + 挂牌查询，抛错）、analytics（~15 种报表类型的判别式响应映射，降级成 `{}`）。

`src/clients` 整体行覆盖率 **26.14% → 97.7%**；admin 包整体行覆盖率 **47.11% → 64.92%**（`npx vitest run --coverage`，15 test files / 148 tests 全绿——新增 54 例，原有 94 例零改动；`npx tsc --noEmit` 干净）。

**仍然明显偏低、本轮未覆盖（下一轮候选，此时应已不是全仓库最低）**：`src/httpApi/*Routes.ts`（fastify 路由处理器本体，仍 0~2%——测试要么需要真起 fastify app 用 `.inject()`，要么把路由处理函数单独导出直接调用，两者都比 client 层这次的"mock 一个函数"重得多）、`src/httpApi/session.ts`（44.31%）、`src/config.ts`/`src/index.ts`（0%，纯 env 读取 + 启动装配，价值存疑）、`src/service/{events,flags,gacha,ladder,mapTemplates,promo,paddleEvents}.ts`（21~50%，同"e2e 传 null 跳过真实分支"模式，但在 service 层而非 client 层）。

## gameserver 补测：index.ts 拆分 + 从 62.5% 拉到 91.9%（2026-08-14）

admin 补到 64.92% 后重新量了一次全量基线，发现 **metaserver 实际是 61.17%**（上一节的数字），仍然低于 admin，但当时 metaserver 那次的 e2e-import-dist 根因已经处理完，一时没有更便宜的下一刀；同批数据里 **gameserver（62.5%）** 是唯一一个"根因不是测量假象、真的几乎没测"的包，且体量小（7 个 src 文件，几百行），性价比最高，本节先处理它。

**根因和 admin/metaserver 都不同**：gameserver 的 `Room`/`RoomManager`/`transport.ts` 等纯逻辑早就测得不错（85~100%），拖后腿的是 `src/index.ts`（171 行，0%）——整个 WS 服务端的进程 bootstrap（ticket 握手鉴权、消息路由、心跳 sweep、优雅关闭）全部写成 `main()` 函数体里的一次性闭包，`main();` 在模块顶层无条件调用，导致**任何**测试文件只要 import 它（哪怕只是想复用其中一个 helper）就会带着真实 `http.listen()`/`WebSocketServer`/`SIGINT` 副作用跑起来——这也是它和同样"index.ts 0%"的 gateway（74 行，`Gateway` 类早已抽出、index.ts 只剩瘦身份 wiring）本质的区别：gateway 的 0% 无所谓（体量小），gameserver 的 0% 是因为该抽的核心逻辑压根没抽出来。

**修法**：照搬 gateway 的形态（类/纯函数 + 真实对象注入 wiring），把 `main()` 闭包体按职责拆成 4 个新文件，全部是接受最小接口的纯函数/类，不需要真 socket 就能单测（同 `RoomManager`/`Room` 测试早就用的"假 Connection 对象"技巧）：

- `src/connectionHandler.ts`：`resolveConnection`（ticket 验签 + exp 校验 + `manager.join`，失败即 `ws.close()` 返回 null）、`routeMessage`（二进制帧解码路由 / 非二进制丢弃 / 解码失败静默丢弃）、`wireConnection`（握手成功后挂 message/pong/close/error 四个监听）、`getConnections`（从 `wss.clients` 反查已标记的 Connection）、`sweepHeartbeat`（两次未应答 pong 则 terminate，否则 ping）。
- `src/httpHealth.ts`：`GET /health` 存活探针 + 其余请求 426 的纯 handler。
- `src/matchsvcRegistration.ts`：`registerWithMatchsvc`（启动注册，指数退避重试，4xx 不重试）+ `reportLoadHeartbeat`（周期性上报负载，best-effort）——独立成文件而非留在 index.ts 里 `export`，是因为 `index.ts` 底部 `main();` 无条件执行，`export` 出来的函数一旦被测试文件 import 就会触发真实启动。
- `src/lifecycle.ts`：`createShutdownHandler`（SIGINT/SIGTERM 去重 + 清定时器 + 快照在线 accountId + `destroyAll` + 关 wss/http + bounded flush/abandon + exit，全部注入依赖，可用假 manager/reporter/wss/http 断言调用顺序和"调用两次只执行一次"）。

`index.ts` 收缩到 **69 行**纯 wiring（env 读取 + 真实 `http`/`WebSocketServer` 构造 + 调用上面四个模块 + `main();`），保留 0% 覆盖但体量已经小到不影响包整体百分比——和 gateway 的 74 行 index.ts 处境一致，是这条代码路径唯一被认为"不值得为覆盖率专门起真实 socket 集成测试"的部分。`scripts/gen-proto.mjs`（buf 生成脚手架，33 行，非应用代码）比照既有 `src/generated/**` 的排除逻辑一并从覆盖率分母移除（`vitest.config.ts` 加 `'scripts/**'`）。

同时顺手补了几个既有文件的残余分支缺口（`RoomManager.handle` 的 `match_result`/`conn_resume`/`room_leave`/`ping`/default 分支、`MetaReporter` 的 `flush`/`drain` 重试队列路径、`room/base.ts` 的 `playerSlotsOut`/`broadcast`——后者标注"死代码"但仍是纯导出函数，直接单测无害）。

gameserver 整体行覆盖率 **62.52% → 91.88%**（`npx vitest run --coverage`，11 test files / 127 tests 全绿，`npx tsc --noEmit` 干净；`Connection.ts`/`RoomManager.ts`/`config.ts`/`connectionHandler.ts`/`lifecycle.ts`/`matchsvcRegistration.ts`/`httpHealth.ts`/`room/base.ts` 均 100%，`metaReport.ts` 94.8%）。

**发现**：这次量出来 metaserver 实际是 **61.27%**（上一节文档写 61.17%，两次独立跑测的正常误差），一直是全仓库真正最低，只是排查顺序上先被 gameserver 抢跑——留档提醒：以"最低覆盖率"为目标排查时，先把 `npm run test:coverage --workspaces --if-present` 完整跑一轮出全量数字，再挑最低的动手，不要在某个包的跑批因为个别 flaky e2e 失败、没吐出 `coverage-summary.json` 时就跳过它、凭旧数据估算。metaserver 的 liveops/pve 模块（见上一节"下一轮候选"）仍待处理。

**`engine/src/config.ts`（522→204 行，2026-08-12，独立函数模块范式）**：0 超限收尾后的第二例新增超限（第一例是上面的 `metaserver/src/service/auth.ts`）——ADR-065 引擎定点化迁移给 `config.ts` 加了 102 行（unit/building blueprint 从"人类可读表直接导出"改成"人类可读原始表 + `bakeXxxBlueprint()` 转换函数"两段式），从合入时未被察觉地推过 500 行界，直到下一次 PR 的 CI 才被 `checkFileLength.mjs`（新文件不在基线里）拦下。判断跟 `paddle.ts`/`economy.ts` 同款——unit/building blueprint 的原始表+bake 函数+类型定义（约 320 行）零共享状态、只被 `config.ts` 内部消费，没有交叉调用需要判断优先级，直接搬进新文件 `blueprintDefs.ts`；`config.ts` 里只留 `export { UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from './blueprintDefs'` 一行 re-export，全部约 11 个外部消费者（`balance/pveUpgrades.ts`/`Building.ts`/`GameState.ts`/`Unit.ts`/`systems/BuildingProductionSystem.ts` + 6 个测试文件）导入路径零改动。**验证**：`npx tsc -b` 干净；`npm test` 139/139（含新增的 `fixed.test.ts`）全绿；`node scripts/checkFileLength.mjs` 0 超限（566 源文件，比改动前多 1——新增 `blueprintDefs.ts`）；额外核对了下游消费方 `worldsvc`/`client` 的 `tsc --noEmit` 均干净（`UNIT_BLUEPRINTS`/`BUILDING_BLUEPRINTS` 的 re-export 对它们透明）。第⑤步：纯移动，两个导出符号的值/类型零变化，不适用，未新增测试。

## metaserver 补测第二轮：liveops/pve/安全社交/卡牌皮肤/客户端封装/杂项 从 61.27% 拉到 90.84%（2026-08-14，worktree `feat/metaserver-coverage`）

gameserver 补到 91.9% 后重新跑一次全量基线，确认 **metaserver（61.27%，8937 行里 5476 行覆盖）仍是全仓库真正最低**——上一节末尾早就标好了"下一轮候选"清单（`src/service/{liveops,pve}/*`、`src/{moderation,reputationDecay,anticheatAudit,oauth,gatewayClient,socialsvcClient}.ts`、`src/cards/fuse.ts`），本节把它连同顺手发现的几个同类小文件一起清完。根因和上一轮 metaserver 那次相同（**不是没测，是 e2e 走 `../dist/app.js` 编译产物导入，vitest v8 coverage provider 记不回 `src/*.ts`**）——继续复用同一套修法：新增 `test/*-unit.test.ts` 直接 `import ... from '../src/...'`。

**先排除一次性脚本**：仿照 gameserver 的先例，`vitest.config.ts` 的 `coverage.exclude` 加 `'scripts/**'`（`gen-proto.mjs`/`backfillMatchExpiry.ts`/`migrateEquipmentInv.ts`/`samplePvpReplays.ts`，约 259 行一次性代码生成/迁移/抽样脚本，非应用代码，不占分母）。

**技术方案上一个新点**：这轮 6 组任务全部并行派发（各自新增互不重叠的文件），而不是像上一轮四组那样顺序做完。6 个并发 `vitest run` 进程各自走 `globalSetup.ts` 会各自起一个 `MongoMemoryReplSet`（慢，且都会去写同一个 tmpdir 里固定文件名的握手文件 `nw-metaserver-mongo-uri`，互相覆盖导致 worker 连到错的/已停的 mongod）——**规避**：先用一个独立脚本单独起**一个共享的** `MongoMemoryReplSet`，把它的 URI 直接通过 `NW_MONGO_URI` 环境变量传给每个并行 agent（而不是让它们各自触发 `globalSetup.ts` 的自动起停逻辑——`globalSetup.ts` 本身设计成"检测到 `NW_MONGO_URI` 已设置就直接跳过"，天然支持这种复用），每个 agent 的新测试文件各自用不同的 Mongo DB 名（`nw_meta_<module>_unit_test` 前缀）避免同一个 mongod 实例上的跨文件数据污染。6 个 agent 全部在同一个 worktree 里工作，写各自独立的新文件，无冲突。

按 6 组并行完成，均新增文件、不改动既有文件：

- **Group A liveops**（`test/liveops-retention-unit.test.ts` 24 例 + `test/liveops-achievements-unit.test.ts` 14 例 + `test/liveops-events-lobbybadges-unit.test.ts` 16 例，54 例）：`retention.ts` 0.3%→**94.98%**、`achievements.ts` 1.8%→**96.36%**、`events.ts`/`lobbyBadges.ts`/liveops `helpers.ts` →**100%**。前两个用 `FakeCollection`（无需真实 Mongo），events/lobbyBadges 因 `claimEventReward` 用了 `$elemMatch`/`$expr`（`FakeCollection` 不支持）改用共享 Mongo。
- **Group B pve**（`test/pve-service-unit.test.ts` 单文件 53 例）：`clear.ts`/`verify.ts`→**100%**、`helpers.ts`→**99.35%**、`stamina.ts`→**96.07%**，真实 Mongo（`claimIfNotClaimed` 等原子守卫需要）。
- **Group C 安全/社交**（`test/anticheat-audit-unit.test.ts` 21 例 + `test/moderation-unit.test.ts` 14 例 + `test/reputation-decay-unit.test.ts` 12 例 + `test/social-service-unit.test.ts` 40 例，87 例）：`anticheatAudit.ts` 0%→**97.95%**、`moderation.ts`/`reputationDecay.ts`→**100%**（`FakeCollection`）、`social.ts`→**100%**（真实 Mongo，`claimMail`→`deliverMailGrant` 的 `{$ne: orderId}` 幂等守卫 + `$addToSet`-with-`$each` 需要）。发现并绕开一处 `FakeCollection` 语义缺陷：真实 Mongo 的 `null` 等值查询会匹配"字段确实缺失"，`FakeCollection` 走严格 `===`不会——两个测试文件改为显式在 fixture 里补 `flags.moderationRev: 0` 绕过，未改动共享 helper。
- **Group D 卡牌/皮肤**（`test/cards-fuse-unit.test.ts` 19 例 + `test/cards-lock-unit.test.ts` 7 例 + `test/skin-unit.test.ts` 41 例，67 例）：`fuse.ts`/`lock.ts`/`skin.ts` 三个文件均达到或接近 **100%**（真实 Mongo；沿用 `economy-service-unit.test.ts`/`cards.e2e.test.ts` regression 测试里"包一层真实 collection 方法、其余原样透传"的手法，确定性复现并发幂等竞态/唯一键冲突分支，不依赖真并发）。
- **Group E 客户端封装**（`test/commercial-client-unit.test.ts` 14 例 + `test/socialsvc-client-unit.test.ts` 19 例 + `test/gateway-client-unit.test.ts` 8 例 + `test/oauth-unit.test.ts` 14 例，55 例）：`commercialClient.ts`/`socialsvcClient.ts`/`gatewayClient.ts`/`oauth.ts` 四个纯 HTTP 客户端封装全部拉到 **100% 行覆盖**（起真实 `node:http` fixture server 而非 mock `fetch`，不碰 Mongo）。
- **Group F 杂项**（`test/save-service-unit.test.ts` 29 例 + `test/inventory-service-unit.test.ts` 18 例 + `test/replayArchive-unit.test.ts` 16 例 + `test/cardStats-unit.test.ts` 6 例 + `test/wxAuth-unit.test.ts` 4 例 + `test/paddleEventRoutes-unit.test.ts` 5 例，78 例）：`replayArchive.ts`/`cardStats.ts`/`wxAuth.ts`/`paddleEventRoutes.ts` →95~100%，`save.ts`→**97.75%**，`inventory.ts`→**100%**（分支 65.5%，剩余是等价路径的 `??`/`||` 备用操作数）。

metaserver 整体行覆盖率 **61.27% → 90.84%**（`npx vitest run --coverage`，103 test files / 1662 tests 全绿，`npx tsc --noEmit` 干净；总行数因排除 `scripts/**` 从 8937 降到 8586，覆盖行数 5476 → 7800）。分支覆盖 85.35%、函数覆盖 96.67%。

**留意但未继续追的残余缺口**（性价比递减，均为不可达的防御性分支或需要真实并发/精确时序才能触发，逐一记录避免下轮重复排查）：
- `retention.ts` 的 `settleCheckinReward`/`claimCheckinHandler` 里 `reward.kind==='coins'`/`'stamina'` 分支——死代码，`CHECKIN_REWARDS` 从未定义过这两种 kind，只是给旧存档快照留的向后兼容判断。
- `stamina.ts` 的 `purchaseStaminaHandler` 里 `amount!==60` 分支——openapi schema 把 `amount` 约束成 `enum:[60]`，Fastify 请求校验层先于 handler 拦截，HTTP 路径不可达。
- pve `helpers.ts` 的 `deductStamina` 里 `newRegenAt=...:0` 的 else 分支——只有 `cost<=0` 才会走到，但当前所有 `PveLevelConfig`（`server/shared/src/pveRewards.ts`）都省略 `staminaCost`（默认 10）或非零，实际关卡表打不到。
- `save.ts` 的 `getMatchHistory` 的 `Math.min/max`/`Number.isFinite` clamp 分支 + `createStateReplayShare` 的 `typeof blob!=='string'` 检查——openapi schema 已经把 `limit`/`blob` 的类型/范围约束死，ajv 校验层先于 handler 拦截，HTTP 路径不可达。
- `save.ts` 里 `currentSeasonPromise`/`migrateIfStale` 外层 catch——人为造错会触发 Node 的 `PromiseRejectionHandledWarning`（源码里这个 promise 是"先建后跨多个 await 才用"的既有写法，不是测试的锅），改用同类的 reconcile/getWallet 抛错分支验证同一种"best-effort 记日志继续"模式，规避这个时序坑。
- `anticheatAudit.ts` 剩 4 行未覆盖：`parsePerSideStats` 兜底 catch 里的防御性单行 + 两处可选字段展开分支，与已覆盖分支功能等价，再测等于同一分支换个名字测两遍。

**仍待处理（下一轮候选，此时应已不是全仓库最低）**：`src/index.ts`（149 行）/`src/config.ts`（19 行）——纯 env 读取 + 启动装配，参照 gateway/gameserver 的先例，价值存疑，暂不建议为它专门起真实 server 集成测试。

## admin 补测第二轮：src/httpApi/*Routes.ts 从 0~2% 拉到 90%+（2026-08-14，worktree `feat/admin-coverage2`）

上一轮（"admin 补测：src/clients/* 从 15~25% 拉到 90%+"一节）把 admin 从 47.1% 拉到 64.92% 后，14 包基线里最低的又变回了 **admin**（其余包均已 ≥70%）。本轮按"根据覆盖率结果修复最低"处理这个包的第二大缺口。

**根因**：`src/httpApi.ts`（2026-08-10 已从单文件拆成 `httpApi/` 下 8 个按业务域分文件的路由处理器 + `session.ts`/`helpers.ts`，见"单文件 500 行收敛"一节）本身是一层 `node:http` 请求分发——但**所有既有 e2e 测试（`service.e2e`/`season-ops.e2e`/`season-audit.e2e`/`comp-mail.e2e`/`moderation.e2e`/`shop.e2e`/`feedback.e2e`）全部直接 `new AdminService(...)` 调用其方法，完全绕开了这层 `node:http` 分发链**；唯一起真实 server 的 `internalHttp.e2e.test.ts` 也只覆盖 `handlePreAuth` 里三条 X-Internal-Key 内部端点（不需要 admin JWT）。结果：`monitorRoutes.ts`/`playerRoutes.ts`/`trustSafetyRoutes.ts`/`compRoutes.ts`/`opsConfigRoutes.ts`/`accountRoutes.ts`/`slgRoutes.ts`/`commerceRoutes.ts`（合计 877 行，对 ops 前端暴露的全部业务路由）连同 `handleLogin`/`handleSession` 和 `httpApi.ts` 自身的分发/错误映射，此前只有 8 行被踩到。

**修法**：新增 `test/httpRoutes.e2e.test.ts`（46 例）——真实 `startHttpApi()` server（真实 Mongo，`AdminServiceDeps` 的全部 18 个业务 client 依赖各配一个最小但形状真实的 fake）+ 真实 `POST /admin/login` 拿到的 Bearer token，对每条路由发一次真实 HTTP 请求：
- **成功路径**用持有全部能力的 `super` 角色（root）驱动一遍全部 40+ 条路由（session 的 login/me/logout；monitor 的 live/trend/summary/events/pvp-card-stats；player 的 search/detail/reset-password/ban-unban；trustSafety 的 anticheat/report/appeal/feedback 四条审核队列——各自预置一条 open 状态记录，list+resolve 都真跑；comp 的 initiate→approve/reject/cancel/retry 全状态机（含"失败→重试"需要 FakeMail 一次性拒绝）+ preview；opsConfig 的 audit/flags/slg-shop/wordlists；account 的 create/patch/reset-password；slg 的 ladder season + season 全 6 个操作 + audit 三件套（anomalies/listings/tickets，`resolve disposition:'actioned'` 触发自动封禁双方）+ map-template 五件套；commerce 的 paddle events / events CRUD / gacha pools）。
- **capability 拒绝路径**：额外建一个 `support` 角色账号（此角色缺 `admin.manage`/`slg.season.manage`/`anticheat.view`/`reports.action` 等），驱动 4 条 403。
- **`httpApi.ts` 自身的分发/错误映射分支**：无 Bearer→401、伪造 token→401、未知路由→404、`EventsClientError`（在 FakeEvents 里对特定输入主动抛出）→透传其自身状态码 422、未预期的普通 `Error`（FakeAnalytics 对特定 query type 主动抛出）→兜底 500。
- **四眼原则的真实分支**：种了两个有审批能力的账号（root=super、ops2=ops）——用真实的"另一个有资格审批人存在"分支验证 root 不能自我审批（403），再用 ops2 完成审批/驳回，而不是像其他 e2e 那样靠"全仓库只有一个 super"的单例例外走自我审批捷径。

顺带补了两个 0% 的纯函数模块（同一 worktree，性价比高，一并做）：
- **`test/config.test.ts`**（2 例）：`loadAdminEnv()` 默认值 + 全量 env 覆盖两条路径，同 `gameserver/test/config.test.ts` 先例。
- **`test/seed.test.ts`**（7 例）：`seedSuperAdmin()` 此前只被各 e2e 文件的 `beforeEach` 在"全新空库 + user/pass 已配置"这一条路径上间接跑过；新增未配置 user/pass（0 账号告警 / 已有账号静默跳过）、已存在账号的两条幂等分支（补种 `seed` 标记 / 已标记直接跳过）、并发插入唯一索引冲突（`code:11000` 吞掉 vs 其它错误照常抛出）——纯内存 fake collection（只实现 seed.ts 真正调用的 4 个方法），不需要真实 Mongo。

`src/httpApi` 整体行覆盖率 **~5% → 96.47%**；admin 包整体行覆盖率 **64.92% → 93.39%**（`npx vitest run --coverage`，18 test files / 203 tests 全绿——新增 55 例，原有 148 例零改动；`npx tsc --noEmit` 干净）。`src/index.ts`（66 行，进程 bootstrap：`main()` 里连库/起 20 个 HTTP client/装配 `AdminService`/起 server/起采样定时器，写死在顶层立即执行）继续沿用 gateway/gameserver 的先例不单独起集成测试——它是全包里唯一仍是 0% 的文件，但只占 66/3150 行（2.1%），即便完全不测,其余文件即使不到 100% 也早已把整包拉过 90% 门槛，专门为它搭 mock 装配意义不大。


## gateway 补测：redis.ts/proto.ts/types.ts/metaClient.ts 等从 65.9% 拉到 93.07%（2026-08-14，worktree `feat/gateway-coverage`）

admin 补到 93.39% 后，14 包基线里最低的变成了 **gateway（65.9%）**——本节按"根据覆盖率结果修复最低"处理这个包。

**根因分布，跟 admin/metaserver 都不同——没有单一大缺口，是七八个中等文件各自零星缺**：`redis.ts`（30.1%，Redis 订阅/发布/presence 原语——`redis-presence.e2e.test.ts` 覆盖了真实 Redis 的 happy path，但整套件 `describe.skipIf(!probe)` 在没有本地 Redis 时（本次会话环境正是如此）完全跳过，消息分发/发布失败吞掉/连接失败三类分支从未被任何测试真正跑过一次）、`src/gateway/types.ts`（27.1%，`toServerMsg` 这个 20+ 分支的纯映射函数，此前只被 `gateway-routing.test.ts`/`judge.test.ts` 的少数几条端到端场景顺带跑过 room_error/match_found/judge_verdict 几种）、`proto.ts`（65.1%，`decodeClient`/`encodeServer` 同理，社交/SLG 推送的十几个 case 从未被编解码过）、`metaClient.ts`（69.6%，`gateway-routing.test.ts` 的 `FakeMeta`/`FakeMetaWithDirectory` 全是子类重写方法，从未调用过真实 HTTP 实现）、`socialsvcClient.ts`（0%）、`config.ts`（0%）、`connRegistry.ts`（69.0%，`routeBroadcast` 从未被任何测试调用过一次；`presenceOf` 的 cross-instance 分支同样只能被真实 Redis 的 e2e 覆盖，同样被跳过）、`gateway/presenceBroadcaster.ts`（70.2%，P3 socialsvc 委托路径 + 缓存复用/失效分支从未测过）。

**修法**：8 个新测试文件，按文件规模从小到大：

- **`test/config.test.ts`**（3 例）：`loadGatewayEnv()` 默认值/全量 env 覆盖/`""` 落空转 `undefined`，同 admin/gameserver 先例。100%。
- **`test/socialsvcClient.test.ts`**（4 例）：`notifyOnline`/`notifyOffline` 的真实 POST 请求体 + `baseUrl=null` 时零请求，mock `globalThis.fetch`（同 `matchsvcClient.test.ts` 既有先例，没有引入新的 mock 风格）。100%。
- **`test/metaClient.test.ts`**（20 例）：6 个方法（`getElo`/`getProfile`/`getMatchIdentity`/`resolveByPublicId`/`getFriends` + `available`）各自的 not-configured/success/degraded-on-failure 三分支，同样 mock `fetch`。100%。
- **`test/presenceBroadcaster.test.ts`**（11 例）：P3 socialsvc 委托路径（配置且可用 → 直接转发，不碰 meta）；fallback 路径（socialsvc 未配置 或 配置了但 `available:false` 都会落到这里）；`meta` 不可用整体 no-op；我自己的 `publicId` 为空整体不广播；好友 socket 不在线/不存在时跳过；好友在线时收到 `friend_presence` 且我自己收到"回放快照"（仅 connect 路径，disconnect 路径不回放）；`friendsCache`/`publicIdCache` 复用（重复调用不重新查 meta）；`notifyOffline` 收尾清缓存（下次重新查）；`invalidateFriends` 只清好友缓存。全部纯逻辑（手搓 `ConnLookup`/`Push`/`MetaClient`/`SocialsvcClient` 假对象），不需要真实 WS/HTTP。100%。
- **`test/proto-and-types.test.ts`**（56 例）：`decodeClient` 全部 9 个 `ClientMsg` oneof 分支（room_create/join/ready/leave/start/ping/duel_invite/duel_respond/client_caps/judge_verdict + 空 envelope→unknown + data-plane-only case→unknown）+ `encodeServer` 全部 19 个 `ServerMsg` oneof 分支，直接用 proto.ts 自己引用的同一份 ts-proto `Envelope`（而不是像 `gateway-routing.test.ts` 那样另起一份 protobufjs 解析——那是因为那边要模拟"真实客户端从零构造"，这边只需要构造/校验 wire 数据，两者用途不同）；`toServerMsg` 全部 20 个 `PushMsg.kind` 分支，每条额外 `encodeServer(toServerMsg(msg))` 验证真实推送链路（`connRegistry.push` 就是这么调的）不会在运行期报错；`displayName` 两条截断分支。`proto.ts`/`types.ts` 均 100%。
- **`test/redis-unit.test.ts`**（16 例）：mock `ioredis`（`redis.ts` 动态 `import('ioredis')`，`vi.mock('ioredis', …)` 对静态/动态 import 一视同仁，都能拦截到），手写一个内存 `FakeRedis`（自制极简 `SimpleEmitter`，不依赖 `node:events`，用 `vi.hoisted()` 承载共享状态规避 mock factory 的变量提升限制）支持 `subscribe`/`duplicate`/`publish`/`set`/`del`/`pexpire`/`pipeline`/`quit`，`duplicate()` 出的三个连接共享同一个内存 `store`（对应真实 Redis 的同一个 keyspace）。覆盖：无 URL→null；`subscribe` 失败→外层 catch 返回 null；消息分发的 push/kick 两种 envelope + 非法 JSON + 无法识别的合法 JSON 三类静默分支；`publishKick`/`markOnline`/`markOffline`/`refreshOnline` 的成功路径 + 失败吞掉路径；`onlineAccountIds` 的空输入短路/混合批量/pipeline 失败 fail-closed；`quit()` 关闭全部三个连接。这一份彻底不依赖真实 Redis，本地/CI 任何环境都能跑，不再被 `describe.skipIf` 挡住。`redis.ts` 100%。
- **`test/connRegistry-unit.test.ts`**（9 例）：`push` 到完全没连接过的 accountId→静默丢弃不抛错；`routeBroadcast`（此前零覆盖）只投给真正在线的收件人，离线的跳过不抛错；`presenceOf` 三态（本地命中不查 presence store / 本地未命中查 store 的 cross-instance 分支 / 混合批量）+ 未挂 store 时未命中默认全部离线；一帧非法二进制帧（`decodeClient` 内部抛错）被静默吞掉且连接后续仍正常（ping→pong 验证）；WS 握手缺 token / token 非法均 4401。复用 `gateway-routing.test.ts` 的真实 Gateway + 真实 `ws` 客户端 + protobufjs 编解码 harness，未引入新 harness。`connRegistry.ts` 69.0% → 87.5%（`sweep()` 心跳扫描——`alive`/`ping`/`terminate`/`refreshOnline`——仍未覆盖，见下）。

**`vitest.config.ts` 新增 `scripts/**` 排除**（同 gameserver/metaserver 先例）：`scripts/gen-proto.mjs` 是 `npm run proto:gen` 触发的一次性生成脚本，从不被 app 代码或测试导入，计入分母只会拉低数字、不反映真实测试缺口。

**留意但未继续追的残余缺口**：
- `connRegistry.ts` 的 `sweep()`（心跳扫描，30s 一次，`HEARTBEAT_MS` 硬编码常量非构造参数）——要测就得等 30 秒或者上 `vi.useFakeTimers()`，而后者和真实 `ws`/`WebSocketServer` 的内部计时器（ping/pong 超时、底层 socket）混在一起风险不小，性价比判断后放弃，留给下一轮如果专门做 timer 相关改动时再一并处理。
- `connRegistry.ts` 里 `push` 的 `ws.send` 失败 catch（83-84 行）——需要在真实 socket "刚检查完 `readyState===OPEN`、`send()` 调用本身却同步抛错"这个窄窗口里造错，没有干净的钩子能从测试侧触发。
- `matchCommands.ts`/`peerJudge.ts`/`dispatcher.ts` 各剩几行防御性分支（未知 duel 邀请 id、判定超时边界等），均为已在 `judge.test.ts`/`gateway-routing.test.ts` 里被其它分支间接覆盖的等价路径变体，性价比递减。
- `src/index.ts`（74 行，进程 bootstrap，同 admin/gameserver 先例）继续不单独起集成测试。

gateway 整体行覆盖率 **65.9% → 93.07%**（`npx vitest run --coverage`，13 test files / 188 tests，181 passed + 7 skipped——7 个 skip 全部是既有的"无本地 Redis 则跳过"用例，跳过状态未变；新增 128 例，原有 60 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 91.03%、函数覆盖 97.05%。

## botsvc 补测：commercialClient/metaClient/socialClient/config 从 0% + worldClient/scheduler 等分支缺口，从 70.0% 拉到 92.74%（2026-08-14，worktree `feat/botsvc-coverage`）

gateway 补到 93.07% 后，14 包基线里最低的变成了 **botsvc（70.0%）**——本节按"根据覆盖率结果修复最低"处理这个包。

**根因跟 gateway 类似——七八个中小文件各自零星缺，外加四个"从没写过测试文件"的纯 0%**：`commercialClient.ts`/`metaClient.ts`/`socialClient.ts`/`config.ts` 四个文件（`test/` 目录下压根没有对应的 `*.test.ts`）——`bot.test.ts` 里 `fakeMeta()`/`fakeSocial()`/`fakeCommercial()` 全是手搓的 plain-object stub，从未调用过这三个真实 HTTP client 的实现；`worldClient.ts`（36.6%，既有 `worldClient.test.ts` 只测了 `baseCoords`/`pickAttackTarget` 两个纯函数，6 个真正发 HTTP 请求的方法从未被直接调用过，只在 `bot.test.ts` 里被同样手搓的假 `world` 对象绕过）；`scheduler.ts`（80.2%，`pause`/`resume`/`drainAll`、capacity 信号失败的一次性告警 + 降级到不限流、`despawnDownTo` 缩容路径均未测）；`gatewayClient.ts`/`gameServerClient.ts`（各 80%/82%，超时分支、`match_bot` 兜底、连接本身失败的分支均未测——已有测试只覆盖"连上之后"的几条 happy/error path）；`bot.ts`（89.6%，`tickFamily` 整个方法 + 三档 `paymentTier` 购买分支 + 购买失败静默重试均未测）。

**修法**：4 个新文件 + 5 个既有文件追加用例：

- **`test/commercialClient.test.ts`**（3 例）+ **`test/metaClient.test.ts`**（3 例）+ **`test/socialClient.test.ts`**（7 例）+ **`test/config.test.ts`**（2 例）：mock `globalThis.fetch`（同 gateway 各 client 测试的既有约定），覆盖每个方法的成功/`ok:false`/无错误信息兜底三态；`config.test.ts` 同 admin/gateway/gameserver 先例，纯 env 默认值 + 全量覆盖两条路径。均 100%。
- **`test/worldClient.test.ts`**（追加 8 例）：6 个 HTTP 方法（`getActiveSeason`/`joinSeason`/`getWorldMe`/`upgradeBuilding`/`getWorldMapSparse`/`startMarchAttack`）各自的请求路径/方法/body/token 头 + 失败分支（`ok:false` 带错误信息 / 不带）。100%。
- **`test/gatewayClient.test.ts`** + **`test/gameServerClient.test.ts`**（各追加 4 例）：`match_bot` 兜底拒绝、`match_start`/`match_found` 超时拒绝（真实关闭底层 socket，非 mock 计时器）、连接本身失败（连到一个没人监听的端口）、`close()` 的幂等/抑制 `onDisconnect` 分支。均达到或接近 100%。
- **`test/scheduler.test.ts`**（追加 5 例）：`pause()`→`drainAll()`（全员登出，capacity/spawn/upkeep 整段跳过）→`resume()`恢复正常；`capacity.onlineCount()` 抛错→降级到不限流的满目标 + `capacityWarned` 一次性告警标记（重复失败只警告一次）；`despawnDownTo` 缩容到新目标 + 其自身也受 `batchSize` 限速（用连续几次小批量 tick 先把全员喂上线，规避"生成也受同一个 batchSize 限制"这个容易踩的坑）。100%。
- **`test/bot.test.ts`**（追加 10 例）：`tickFamily` 全部分支（无 token 不动 / 无家族→搜索并加入第一个候选 / 搜索为空则不加入 / 高繁荣度家族不动 / 低繁荣度家族离开且同一 tick 不重新搜索）；`bootstrapPaymentTier` 三档（`free`不购买 / `monthly_card`/`starter_growth` 各自的 orderId 格式 `bot-{deviceId}-{tier}`）+ 购买失败不影响登录成功 + 下次登录重试（未标记 bootstrapped）+ 购买成功后不重复购买（幂等）。达到 100%。

**`vitest.config.ts` 新增 `scripts/**` 排除**（同 gameserver/metaserver/gateway 先例）：`scripts/gen-proto.mjs` 一次性生成脚本不计入分母。

**留意但未继续追的残余缺口**：`index.ts`（60 行，进程 bootstrap，同 admin/gameserver/gateway 先例不单独起集成测试）；`engineDriver.ts`/`protoCodec.ts`/`internalHttp.ts`/`envelopeSocket.ts`/`pool.ts`/`gameServerClient.ts` 各剩几行防御性分支或等价路径变体，性价比递减未继续追。

botsvc 整体行覆盖率 **70.0% → 92.74%**（`npx vitest run --coverage`，16 test files / 119 tests 全绿——新增 47 例，原有 72 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 89.39%、函数覆盖 98.07%。

## auctionsvc 补测：mailClient/scheduler/config 从 0% + metaClient/httpApi 路由/queryListings 等分支缺口，从 72.3% 拉到 92.0%（2026-08-14，worktree `feat/auctionsvc-coverage`）

botsvc 补到 92.74% 后，14 包基线里最低的变成了 **auctionsvc（72.3%）**——本节按"根据覆盖率结果修复最低"处理这个包。

**根因跟前几个包同一种模式——三个"从没写过测试"的 0% 文件，外加 httpApi.ts 路由验证层/`queryListings` 内部审计端点这两处此前只被 `AuctionService` 直调 e2e（`auction.e2e.test.ts`）或"真实客户端只会走的 happy path" e2e（`auction-fulllink.e2e.test.ts`）绕过的缺口**：

- **`mailClient.ts`（27%）/`scheduler.ts`（0%）/`config.ts`（0%）**：`mailClient.ts` 没有专属测试文件（`auction.e2e.test.ts` 里用的是手搓 stub，从未调用真实 `HttpAuctionMailClient` 实现）；`scheduler.ts`（两个独立 `setInterval` 循环 + 各自的重入guard/错误吞掉分支）和 `config.ts`（纯 env 解析）此前压根没有测试文件。
- **`metaClient.ts`（36.4%）**：既有 `meta-client.test.ts` 只测了 `deductMaterial` 一个方法（该文件本身是为 [[business-errors-surface-as-500-2026-08-02]] 这条回归写的），escrow*/grant*（equipment/card/skin 三组×2）、`available` getter、`nullAuctionMetaClient` 均未测。
- **`httpApi.ts`（77.8%）**：`/internal/audit/listings`（ops 审计拉取路由，admin 的 `slgAudit.slgQueryAuctionListings` 在 auctionsvc 这一侧的对应端点）、`GET /auction/refprice`、`POST /auction/create` 的输入校验分支（itemType/item/qty/durationSec 必填、fixed 模式缺 price、auction 模式缺 startPrice）、未知路由 404——`auction.e2e.test.ts` 直调 `AuctionService`（绕开 httpApi 这层 HTTP 解析/校验），`auction-fulllink.e2e.test.ts` 虽起了真实 HTTP server，但只驱动真实客户端会走的合法请求，从不发送校验会拒绝的畸形请求。
- **`auctionService/listing.ts`/`base.ts` 的 `queryListings`/`docToAdminView`（listing.ts 74.6%，base.ts 64.6%）**：`/internal/audit/listings` 路由本身没被真实调过（见上），连带它唯一调用的业务方法 `queryListings`（DB 级 sellerId/itemType/status 过滤 + itemName 的内存子串过滤 + limit 钳制）和其映射函数 `docToAdminView`（按 itemType 派生 itemName：material/equipment/card/skin 四种）也完全零覆盖。

**修法**：

- **`test/config.test.ts`**（3 例）+ **`test/scheduler.test.ts`**（9 例，`vi.useFakeTimers()` 驱动两个独立循环——过期拍卖处理每 `tickMs`、已关闭记录清理每固定 1 小时——各自的重入 guard + 失败吞掉分支）+ **`test/mailClient.test.ts`**（7 例，真实 `node:http` fixture server，覆盖 `available`/not-configured no-op/请求体形状/HTTP 失败吞掉/HTTP 200 但 `{ok:false}` 吞掉/`nullAuctionMailClient`）。均 100%。
- **`test/meta-client.test.ts`** 追加 33 例：escrow*/grant*（equipment/card/skin 三组，每组的成功/已知错误码→`SlgError`/未知错误→`SlgError(BAD_REQUEST)`/`baseUrl` 未配置/`grant*` 失败吞掉分支）+ `nullAuctionMetaClient` 的抛错 vs no-op 两类方法。
- **`test/commercial-client.test.ts`** 追加 4 例：`available` getter、`baseUrl` 未配置直接抛错、网络层失败（连到无人监听的端口）不静默放行、`clientPlatform` 透传。
- **`test/readjson-size-guard.test.ts`** 追加 4 例：空 body→`{}`、畸形 JSON→拒绝、流 `error` 事件→拒绝、size-cap 触发后到达的 `error` 事件不覆盖已有的拒绝（同一个 `rejected` 标志位的另一个分支）。
- **`test/httpApi-routes.test.ts`**（新文件，17 例，复用 `httpApi-error-sanitization.test.ts` 的 `Partial<AuctionService>` mock 免 Mongo 套路）：`/internal/audit/listings` 的查询过滤转发 + 无 key/错 key→401 + 非 GET→404；`GET /auction/refprice` 的 category 转发；`POST /auction/create` 六条校验 400（itemType/item/qty/durationSec 缺失、fixed 缺 price、auction 缺 startPrice）+ 一条校验通过样例；未知路由 404；畸形 JSON body→500（`readJson` 自身的 `JSON.parse` 失败经统一 catch-all 脱敏）。这一份只验证 httpApi.ts 自己的路由分发/校验逻辑，不重新验证业务语义。
- **`test/auction-query-listings.e2e.test.ts`**（新文件，7 例，真实 Mongo，同 `auction-audit.e2e.test.ts` 直接 seed `AuctionDoc` 的套路）：`queryListings` 的 sellerId/itemType/status DB 级过滤、itemName 内存子串过滤（大小写不敏感，material/equipment/card/skin 四种派生名各测一次）、limit 钳制到 `[1,200]`、`docToAdminView` 可选字段（`designatedBuyerId`/`buyerId`/`soldAt`/`closedAt`/`startPrice`/`buyoutPrice`/`topBid`）仅在存在时展开 vs 普通 fixed listing 全部省略、`getMyListings` 按卖家过滤+按 `expireAt` 降序。这一份补的是上面 httpApi 路由测试特意没碰的"真实业务实现"半边。

**留意但未继续追的残余缺口**：`index.ts`（66 行，进程 bootstrap，同 admin/gameserver/gateway/botsvc 先例不单独起集成测试——66/1125 行仅占 5.9%，即便完全不测也早已把整包拉过 90% 门槛）；`create.ts`/`trade.ts`/`pricing.ts`/`audit.ts` 各剩几行防御性分支或需要精确并发时序才能触发的路径，性价比递减未继续追。

auctionsvc 整体行覆盖率 **72.3% → 92.0%**（`npx vitest run --coverage`，15 test files / 181 tests 全绿——新增 81 例，原有 100 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 86.02%、函数覆盖 97.75%。

## socialsvc 补测：config/metaClient/gatewayClient 从 0~25% + family/mail 路由分支缺口，从 78.4% 拉到 94.71%（2026-08-14，worktree `feat/socialsvc-coverage`）

auctionsvc 补到 92.0% 后，核对完整基线发现比 auctionsvc 更早、从未被这一批任务处理过的几个包（client/engine/shared/worldsvc/analyticsvc/matchsvc/commercial/socialsvc）里，**socialsvc（78.4%）才是真正最低**——本节按"根据覆盖率结果修复最低"处理这个包。

**根因同一种模式**：`config.ts`（0%，没有专属测试文件）；`metaClient.ts`（25%）/`gatewayClient.ts`（31%）——所有 e2e 套件清一色用 `test/harness.ts` 的内存 `FakeMeta`/`FakeGateway`（这两个 fake 本身测得很扎实，被十个 e2e 文件反复复用），真实的 `HttpSocialMetaClient`/`HttpSocialGatewayClient` fetch 实现从未被调用过一次；`httpApi/internalMailRoutes.ts`（39.7%）/`mailRoutes.ts`（51.1%）——`mailHttp.e2e.test.ts` 原本只测了 `DELETE /mail/:id` 一条路由（专门为 16.07.2026 的未领取附件回归写的），`GET /social/mail`、`POST /mail/:id/read`、`POST /mail/send`、`/internal/mail/:id/claim` 的三种错误分支、`/internal/mail/:id/unclaim`、`/internal/mail/system`、`/internal/mail/system/bulk` 全部零覆盖；`httpApi/familyRoutes.ts`（81.5%）——`familyHttp.e2e.test.ts` 只覆盖 browse/emblem/get-by-id/join/requests 几条，`mine`/`search`/创建家族/`leave`/`kick`/`role`/`disband`/`announcement`/家族频道消息收发全部只在**直调 `FamilyService`**（绕开 httpApi 路由层）的 `family.e2e.test.ts` 里测过，从未通过真实 HTTP 请求走过一次。

**修法**：

- **`test/config.test.ts`**（3 例）：`loadSocialsvcEnv()` 默认值/全量覆盖/falsy 空串兜底，同前几个包先例。100%。
- **`test/metaClient.test.ts`**（11 例）+ **`test/gatewayClient.test.ts`**（15 例）：真实 `node:http` fixture server（metaClient）/mock `globalThis.fetch`（gatewayClient，同 gateway 包自己 `matchsvcClient.test.ts` 的约定），覆盖 `resolveByPublicId`/`batchProfiles`/`getPlayerRankByPublicId` 三方法 + `push`/`pushMany`/`pushBatch`/`presence`/`invalidateFriends` 五方法的成功/失败/`baseUrl` 未配置/空输入短路分支，外加两个 `nullXxxClient` 兜底对象。均 100%（或仅剩 1 行防御性分支）。
- **`test/mailHttp.e2e.test.ts`** 追加两个 describe 块、17 例（复用既有文件的 `FamilyService`/`FriendService`/`MailService`/`startHttpApi` + `FakeMeta`/`FakeGateway` 组装方式，注意第二个新增的 describe 块与原有块共享同一个 `mongo` 连接——原 `afterAll` 里的 `m.close()` 挪到最后一个块，否则第二块的 `beforeAll` 会撞上"连接已关闭"）：`GET /social/mail`（列表）、`POST /mail/:id/read`（成功 + 未知 id→404）、`POST /mail/send`（缺字段 400、目标 publicId 未找到 404、非好友 403、真实好友边成功发信）、`/internal/mail/:id/claim` 三种失败分支（NOT_FOUND/NO_ATTACHMENT/ALREADY_CLAIMED，靠一次性 seed 一封无附件的信 + 对同一封信 claim 两次触发）、`/internal/mail/:id/unclaim`（缺字段 400 + 回滚后可重新 claim）、`/internal/mail/system`（缺字段 400 + 成功送达收件箱）、`/internal/mail/system/bulk`（缺字段 400 + 成功批量送达 + 通过 `FakeGateway.ofKind('mail_new')` 验证 fire-and-forget 的 `pushBatch` 确实被调用）。`internalMailRoutes.ts` 100%，`mailRoutes.ts` 51.1%→89.4%。
- **`test/familyHttpRoutesGaps.e2e.test.ts`**（新文件，12 例，独立 DB + 独立账号，避免打乱既有 `familyHttp.e2e.test.ts` 的家族生命周期叙事）：一条流畅场景走完 `POST /social/family` 创建（缺 name/tag→400 + 成功 201）→ `GET /mine` → `GET /search`（缺 tag→400 + 命中）→ `announcement`（缺字段→400 + 成功）→ 真实 join+leader-accept 流程拉入 member1 → `role`（缺字段→400 + 提升为 elder）→ 家族频道 `GET/POST /:id/messages`（空历史 → 缺 body→400 + 成功发送并通过 `FakeGateway.ofKind('family_msg')` 验证真实推送）→ member2 加入后 `kick`（缺 targetId→400 + 成功踢出）→ member3 加入后 `leave`（成功退出）→ 最后 `disband`（会长解散）。`familyRoutes.ts` 81.5%→100%。

**`vitest.config.ts` 新增 `scripts/**` 排除**（同前几个包先例）：`scripts/migrateFamily.ts`/`migrateSocial.ts` 是一次性迁移脚本，不计入分母。

**留意但未继续追的残余缺口**：`index.ts`（98 行，进程 bootstrap，同前几个包先例不单独起集成测试）；`friend/relations.ts`/`friend/chat.ts`/`family/membership.ts`/`family/internal.ts` 各剩几行防御性分支或需要精确并发时序才能触发的路径（同类形态在 `family.e2e.test.ts`/`friend.e2e.test.ts` 里已有等价覆盖），性价比递减未继续追；`family/types.ts`/`friend/types.ts` 两个纯类型文件（0 可执行行，覆盖率工具报 0/0 属正常，非真实缺口）。

socialsvc 整体行覆盖率 **78.4% → 94.71%**（`npx vitest run --coverage`，14 test files / 216 tests 全绿——新增 58 例，原有 158 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 89.22%、函数覆盖 99.39%。

## commercial 补测：internalHttp.ts 路由层从 33.1% + config/devStub 从 0~57%，从 81.4% 拉到 93.64%（2026-08-14，worktree `feat/commercial-coverage`）

socialsvc 补到 94.71% 后，剩余未处理的几个包（client/engine/shared/worldsvc/analyticsvc/matchsvc/commercial）里 **commercial（81.4%）最低**——本节按"根据覆盖率结果修复最低"处理这个包。

**根因跟 admin/gateway/botsvc/auctionsvc/socialsvc 同一种模式，但这次几乎全部集中在一个文件**：`internalHttp.ts`（33.1%，378 行的 node:http 路由分发层，meta 是唯一调用方）——既有 `internalHttp.e2e.test.ts`（8 例）只驱动了 `GET /internal/wallet`/`POST /internal/recharge/verify`/`POST /internal/shop/charge`/`GET /internal/orders/undelivered` 四条 + 401/404 边界，`CommercialService` 自身另外 26 个方法（spend/grant/gacha draw/order delivered/非金币收据校验/广告激励/胜场奖励/promo 码增删查兑换/paddle 完成+退款+事件记录+事件查询/自定义卡池创建+关闭/命定点数兑换/月卡年卡购买+领取/新手礼包购买/卡池列表/审计异常币异动）全部只被 `service.e2e.test.ts`/`service-idempotency.e2e.test.ts`/`promo.test.ts`/`audit.e2e.test.ts` 这些**直调 `CommercialService`**（绕开 `internalHttp.ts` 的 HTTP 解析/路由匹配层）的文件测过，从未通过真实 HTTP 请求走过一次；`config.ts`（0%，没有专属测试文件）；`iap/devStub.ts`（57.1%）——`product:` 前缀分支（非金币收据的 dev-stub 校验，月卡/年卡/新手礼包走这条）虽然被 `verifyNonCoinReceipt` 的 e2e 间接跑过，但从未被直接单测过。

**修法**：

- **`test/internalHttpRoutesGaps.e2e.test.ts`**（新文件，23 例，真实 `node:http` server + 真实 Mongo，同 `internalHttp.e2e.test.ts` 既有约定）：`GET /health`（无需鉴权）+ 剩余 22 条业务路由各来一遍成功路径（`spend`/`grant`/`gacha/draw`/`order/delivered`/`nonCoinReceipt/verify`（含坏 `expectedProduct` → 400）/`ads/credit`/`victory/credit`/`promo/codes`（GET+POST）+`promo/redeem`（含未知码）/`paddle/complete`+`paddle/event`+`paddle/events`（GET，按 accountId/transactionId 过滤）+`paddle/refund`/`gacha/pools`（GET，含 `?active=1`）+`gacha/pool/custom`（含"不能顶替静态卡池 id"400）+`gacha/pool/close`/`fate/redeem`（零命定点数的兜底拒绝，深层命定点数累积逻辑留给 `service.e2e.test.ts`）/`monthly-card/buy`+`monthly-card/claim`（同日二次领取 `ok:true` 但 `claimed:0`，不是错误——踩了一次把这个当 `ok:false` 断言错的坑）/`year-card/buy`/`starter/buy`（starter_draw + starter_growth）/`audit/coin-gains`（缺 `dayKey`→400）。这一批只验证每条路由能不能走通 + 请求体解析对不对，不重新验证业务规则深度（四眼/幂等/并发去重等已在直调 service 的 e2e 里覆盖）。`internalHttp.ts` 33.1%→97.16%。
- **`test/config.test.ts`**（2 例）：`loadCommercialEnv()` 默认值 + 全量覆盖，同前几个包先例。100%。
- **`test/devStub.test.ts`**（6 例）：`devVerify()` 纯函数单测——空收据/`product:`前缀（4 种已知 kind + 1 种未知）/`tier:`前缀（已知 tier + 未知 tier 兜底默认档位）/无前缀兜底。100%。

**留意但未继续追的残余缺口**：`index.ts`（60 行，进程 bootstrap，同前几个包先例不单独起集成测试）；`iap/apple.ts`/`iap/google.ts`/`iap/productResolve.ts`/`service/promo.ts`/`service/recharge.ts`/`service/starter.ts` 各剩几行第三方支付网关的防御性错误分支或需要精确并发时序才能触发的路径，性价比递减未继续追。

commercial 整体行覆盖率 **81.4% → 93.64%**（`npx vitest run --coverage`，16 test files / 213 tests 全绿——新增 31 例，原有 182 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 81.25%、函数覆盖 99.25%。

## shared 补测：boundedConcurrency/config/heartbeat/jwt/password/ticket/internalAuth/logger/mongo/slg 全面拉高，从 82.3% 拉到 98.96%（2026-08-15，worktree `feat/shared-coverage`）

commercial 补到 93.64% 后，剩余未处理的几个包（client/engine/worldsvc/analyticsvc/matchsvc）里 **shared（82.3%）最低**——本节按"根据覆盖率结果修复最低"处理这个包。跟其它包不同，`@nw/shared` 是纯 library（无路由层、无进程 bootstrap），缺口分散在一堆此前完全没有对应测试文件的小模块 + 两个大文件（`slg/march.ts`/`slg/core.ts`）函数覆盖率极低（10.86%/14.28%），外加整个 `src/mongo/*`（索引创建，~0%——此前没有真实 Mongo 可跑）。四路并行做（各自新增/追加文件，互不touch；mongo 一路涉及配置改动，单独串行做）：

- **纯工具函数**（`test/{boundedConcurrency,config,heartbeat,jwt,password,ticket,internalAuth,social,saveData}.test.ts`，9 个新文件 96 例）：`runBounded` 有限并发语义、`loadServerEnv`/`required()`（发现 `required` 的 throw 分支实际可达——`process.env[name] ?? fallback` 的 `??` 只在 `undefined`/`null` 时才用 fallback，显式设成 `''` 仍会命中 throw，之前的任务描述猜错了）、`startHeartbeat`（fake timers + `extra()` 抛错不影响心跳）、`signToken`/`verifyToken`/`extractBearer`、`password.ts` 全部纯函数 + `hashPassword`/`verifyPassword`（含格式错误 stored 串的三种防御分支 + `DUMMY_PASSWORD_HASH` 侧信道用法）、`signTicket`/`verifyTicket`（含 `ignoreExpiration` 分支 + 类型错误 payload）、`internalAuth.ts` 全部导出（`parseInternalKeys`/`outboundInternalKey`/`createInternalAuth` 的 strict/fallback 两种模式，用 `vi.resetModules()` 隔离 `envKeysCache` 模块级缓存）、`social.ts` 的 id 派生函数、`types.ts` 唯一的运行时函数 `makeNewSave`。
- **`test/logger.test.ts`**（新文件，23 例）：console 双 sink（`debug`/`info`/`warn`/`error` 四级 + 级别阈值 + `child()`）+ 文件 sink（`NW_LOG_DIR` 未设时禁用、真实 ENOTDIR 触发 `ensureDir` 失败、`vi.mock('node:fs')` 稳定触发 `createWriteStream`/`stream.write()` 抛错分支、root 分组复用、`fmtData`/`normData` 的 Error/循环引用/换行折叠分支）。`threshold`/`LOG_DIR` 是模块加载时求值的模块级常量，改 env 后必须 `vi.resetModules()` + 动态 `import()` 才能生效。logger.ts 25.24%→100%。
- **`test/mongo.test.ts`**（新文件，8 例）+ 配置改动：`src/mongo/*`（`client.ts`/`accountDocs.ts`/`matchDocs.ts`/`integrityDocs.ts`/`commsDocs.ts`/`inventoryDocs.ts`/`balanceDocs.ts`/`miscDocs.ts`，此前全部接近 0%）只有 `createIndex` 调用，此前没有真实 Mongo 可跑。仿照 commercial/socialsvc 的 `mongodb-memory-server` 套路，新增 `test/globalSetup.ts`（standalone mongod，`NW_MONGO_URI` 已设时跳过）+ `test/setupEnv.ts`（跨 worker 桥接 URI 的握手文件）+ `vitest.config.ts` 加 `globalSetup`/`setupFiles`/`testTimeout`/`hookTimeout`（`mongodb-memory-server` 加进 `devDependencies`，实测此前已经靠 npm workspaces 提升能从 `server/shared` 解析到，但显式声明更稳妥）；`test/mongo.test.ts` 验证 `createMongo()` 接好全部 26 个 collection + `ensureIndexes()` 跑遍 8 个 domain 文件真实建出索引（逐个 spot-check key/name/unique/TTL）、`ensureIndexes()` 两次调用不重复建索引、连接失败时 `console.error` 输出脱敏后的 URI（不含 user:pass）、`isAnonymousAccount` 四个分支。`src/mongo` 整体 ~1%→100%（`collections.ts` 例外，纯 interface 声明、无可执行行，0% 属预期）。
- **slg 游戏逻辑缺口**（`test/march.test.ts` 9→33 例、新建 `test/core.test.ts` 24 例、新建 `test/transfer.test.ts` 4 例，另追加 `activeMatch`/`dailyCounter`/`rateLimiter`/`cards`/`chatFilter`/`featureFlags`/`mapEdit`/`economy` 既有测试文件 + 新建 `test/cities.test.ts`/`test/tileGen.test.ts`）：`march.ts`（10.86%→100%，`vi.mock('../src/slg/mapgen')` 手工构造障碍/围困/桥梁/城门/`blockedBaseKeys`(ADR-025) 各种地形组合，不用在真实 1500×1500 程序化地图上找坐标）、`core.ts`（74.13%→100%，函数覆盖 14.28%→100%，补了 `SlgError`、一串确定性 id 派生函数、地基/城市精灵几何 helper、徽记校验器）、`transfer.ts`（42.85%→100%）。

**留意但未继续追的残余缺口**（性价比递减，均为等价路径变体或需要真实并发/精确时序才能触发）：`src/economy/gacha.ts`（89.32%，181-191 行）、`src/slg/shop.ts`（88.42%，145-157 行）、`src/slg/mapgen/biome.ts`/`levelDist.ts`（92.6%/88.9%，各剩 2 行）、`achievements.ts`/`battlepass.ts`/`events.ts`/`retention.ts`/`equipment.ts`/`unitCards.ts` 等此前已有测试的文件各剩 1~6 行防御性分支；`src/mongo/collections.ts`（0%，纯 `interface` 声明，无可执行行，不是真实缺口）。

shared 整体行覆盖率 **82.41% → 98.96%**（`npx vitest run --coverage`，51 test files / 952 tests 全绿 + 5 skipped（既有的"无本地 Redis 则跳过"用例，跳过状态未变）——新增 15 个测试文件、210 例，原有 36 文件 / 742 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 94.8%、函数覆盖 97.67%。

## worldsvc 补测：httpApi 路由层 + 客户端封装 + config/redis/scheduler + siege/misc 分支缺口，从 82.9% 拉到 95.82%（2026-08-15，worktree `feat/worldsvc-coverage`）

shared 补到 98.96% 后，剩余未处理的几个包（client/engine/analyticsvc/matchsvc）里 **worldsvc（82.9%）最低**——本节按"根据覆盖率结果修复最低"处理这个包。worldsvc 是目前处理过的包里规模最大的一个（`fileParallelism:false` + 真实 rs0 副本集，全量套件单跑约 200s），缺口分布也最散：`src/httpApi/*Routes.ts` 路由分发层 29.8%~66.7%（和 commercial 的 `internalHttp.ts`/其它包的路由层同一种模式）、四个内部 HTTP 客户端封装 23.6%~39.5%、`config.ts`/`redis.ts`/`scheduler.ts` 完全 0%（此前没有专属测试文件）、以及分散在 siege 战斗计算 + 一长串杂项文件里的分支缺口。五路并行做（各自新增/追加文件，互不touch）：

- **共享 mongod 副本集**（本次新技巧，见 [[parallel-vitest-agents-shared-mongo-2026-08-14]] 的做法）：worldsvc 需要真实 Mongo 的 agent 不算少，为避免 N 个并行 agent 各自触发 `test/globalSetup.ts` 重复起 rs0（慢 + 握手文件竞态），主会话自己先用一个独立脚本（`node _shared-mongo-scratch.mjs`，跑在 worktree 内、后台、任务完成后删除+不提交）起一个共享的 `MongoMemoryReplSet`，把打印出来的 URI 喂给每个需要 Mongo 的 agent，让它们各自 `NW_MONGO_URI=<uri> npx vitest run test/<file>.test.ts` 时命中 `globalSetup.ts` 的 `if (process.env.NW_MONGO_URI) return` 短路，全部连到同一个物理 mongod（各自建独一无二的 db 名隔离数据）。跑 `.mjs` 脚本本身有个坑：脚本文件必须放在有 `node_modules` 可解析到 `mongodb-memory-server` 的目录下（即 `server/worldsvc/` 内部），放到仓库外的 scratchpad 目录会因为 ESM 相对路径解析规则直接 `ERR_MODULE_NOT_FOUND`。
- **`src/httpApi/*Routes.ts`**（3 个新 e2e 文件，46 例）：`economyRoutes.ts`/`seasonRoutes.ts`/`siegeRoutes.ts`/`actionRoutes.ts`/`mapRoutes.ts`/`nationRoutes.ts` 全部拉到 100% 行覆盖，`admin.ts` 74.64%→90.84%（剩 `/admin/world/*` 几条 ops 路由的"真实非 SlgError 异常"catch 分支，需要往 service 层注入故障才能触发，未继续追）。技术路线同 `test/httpApi.e2e.test.ts`：真实 `node:http` server + 真实 Mongo，复用已有专门 e2e 文件（`teams.e2e.test.ts`/`siege-replay-cardinstances.e2e.test.ts` 等）已经想清楚的业务场景，只是让请求走一遍 HTTP 分发层本身。
- **内部 HTTP 客户端封装**（4 个新文件，79 例）：`socialsvcClient.ts`/`gatewayClient.ts`/`mailClient.ts`/`metaClient.ts` 全部拉到 **100%**（含 `nullWorldXxxClient` 的每个 no-op）。沿用本包既有的 `test/commercial-client.test.ts`/`test/meta-client-save-fields.test.ts` 范本——起一个真实 `node:http` fixture server（`.listen(0)`）断言客户端实际发出的请求，而不是 `vi.mock('@nw/shared', ...)`（admin 包当初用过 mock 的方式，但 worldsvc 已有的两个客户端测试文件都是 fixture-server 风格，延续现有风格）。
- **`config.ts`/`redis.ts`/`scheduler.ts`/`prosperity.ts`**（4 个新文件，24 例）：全部拉到 ~100%。`redis.ts` 用 `vi.mock('ioredis', ...)` 拦截函数内部的动态 `import('ioredis')`（确认可行，同 `gateway/test/redis-unit.test.ts` 先例）——真正的坑不是拦截失败，而是"轮询判断 mock 实例是否已构造好"这种写法在 Vitest 模块运行时下时机不确定、间歇性 flaky，改成让 `FakeRedis` 自己在构造函数里 `process.nextTick` 触发 `ready`/`error` 事件、测试直接 `await connectRedis(...)` 就不用赛跑；`scheduler.ts` 用 `vi.useFakeTimers()` 验证了 5~6 个任务的定时调度 + 重入保护（用手动可控的 deferred promise 卡住一个 tick，验证下一个 tick 被跳过）+ `Promise.allSettled` 逐任务失败隔离。
- **siege 战斗计算分支缺口**（5 个新文件，158 例，全部走假 ctx/fake-core 单测，不连 Mongo，仅一处真跑一次引擎）：`combatSiege/damage.ts`（分支 34.78%→100%）、`helpers.ts`（64.15%→94.87%）、`arrival/{crossingSiege,strongholdSiege,sweep,landSiege,baseSiege}.ts` 五个到达变体、`combatSiege.ts` 门面类的 17 个转发方法（函数覆盖 63.15%→100%，逐个 spy 断言参数/返回值原样转发）、`occupation.ts`/`encounter.ts`/`occupationBattle.ts`、`siegeEngine.ts` 的 `runSiegeBattleSync` 两种胜负分支。技术路线延续 [[worldsvc-domain-service-unit-testable-no-mongo]]：siege 计算大多是纯函数或只依赖注入的 ctx，不需要真实持久化就能测分支；只有"防御方战败但仍有真实幸存者"这类分支明确记录为"只有真实无头引擎才会走到，作弊算法（`resolveSiege`）恒定判负方 0 幸存"，未强求覆盖。
- **杂项分支缺口**（16 个新建/追加文件，约 100+ 例）：`combatDefense.ts`（60.52%→100%）、`combatShared.ts`、`territory.ts`（72.89%→86.95%，新建 e2e）、`season/shard.ts`、`sect/query.ts`、`core/helpers.ts`、`core/nation.ts`、`db/client.ts`+`db/combatDocs.ts`（33.33%→100%），另在既有文件里追加：`city-buildings.e2e.test.ts`（55.55%→75%）、`city-training.e2e.test.ts`、`sect.e2e.test.ts`（65.85%→87.12%）、`season-ops.e2e.test.ts`、`field-garrison.e2e.test.ts`、`transfer.e2e.test.ts`、`nation-channel.e2e.test.ts`、`card-slg.e2e.test.ts`。因时间/优先级预算，`combatMarch/command.ts`/`combatMarch/stationed.ts`/`core/push.ts`/`core/spawn.ts`/`core/vision.ts`/`core/yield.ts`/`db/playerDocs.ts`（仅迁移函数部分）/`siegeWorkerPool.ts`/`mapTemplateService.ts` 未继续追，如实记录未做。

**config 追加**：`vitest.config.ts` 的 `coverage.exclude` 补了 `scripts/**`（`migrateMapBaselinesToRle.ts`/`migrateMarchBbox.ts` 是一次性迁移脚本，不是应用代码，同 gameserver/metaserver 排除 `scripts/**` 的先例）。

**留意但未继续追的残余缺口**（性价比递减，均为等价路径变体、真实并发/精确时序、或需要往 service 层注入故障才能触发）：`index.ts`（0%，进程 bootstrap，同前几个包先例不单独起集成测试）、`siegeWorker.ts`（0%，worker_thread 入口，顶部有 `if (!parentPort) throw` 守卫，脱离真实 worker_thread 语境几乎无法直接 import 测试，同 index.ts 归为 bootstrap 类不追）、`combatSiege/ctx.ts`/`db/collections.ts`/`sect/types.ts`（均 0%，纯 `interface` 声明，无可执行行，不是真实缺口，同 shared 的 `mongo/collections.ts` 先例）、`mapTemplateService.ts`（73.91%→74.46%，小幅改善但仍是本包分支覆盖率最低的文件之一，多为地图模板导入的边界分支，留给下一轮）、`siegeWorkerPool.ts`（83.33%，worker 池管理，多为 worker 崩溃恢复的时序分支）。

**⚠️ 一次性发现的 flaky 测试**：`httpApiActionSiegeMapGaps.e2e.test.ts` 在全量 `--coverage` 跑法（重活 CPU 负载下）里出现过一次 `SlgError: No viable path found`（`combatMarch/command.ts` 的 `startMarch`），单独跑该文件、以及随后 3 次全量重跑（含 2 次 `--coverage`）均全绿——判断是重负载下的瞬时环境抖动，不是确定性 bug，未继续深挖根因；如果未来这个文件在 CI 上复现类似失败，从这里开始排查。

worldsvc 整体行覆盖率 **83.03% → 95.82%**（`npx vitest run --coverage`，85 test files / 916 tests 全绿——新增 24 个测试文件、415 例，原有 61 文件 / 501 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 87.57%、函数覆盖 97.93%。

## engine 补测：combat/ai/hazard+spell+movement/setup+math/sim 五路缺口，从 86.49% 拉到 92.98%（2026-08-15，worktree `feat/engine-coverage`）

worldsvc 补到 95.82% 后重新核实一遍全部 14 包，**engine（86.49%）** 是唯一仍低于 90% 的一个（analyticsvc 87.59%、matchsvc 88.32% 次之，其余全部 ≥90%）——本节按"根据覆盖率结果修复最低"处理这个包。

engine 是目前处理过的包里**唯一非 vitest** 的一个（`tsc -b && tsc -p tsconfig.test.json` 编译到共享 `dist/` 再用 `node --test` 跑，见本文档"测试覆盖率百分比工具"一节），这意味着 metaserver/worldsvc 那套"N 个 agent 各自 `npx vitest run test/<file>.test.ts`、按需接一个共享 mongod"的并行方案不适用——vitest 按文件即时转译、互不冲突，但 engine 的多个 agent 若在同一个工作目录里各自并发跑 `npm run test:coverage`，会在同一个 `dist/` 输出目录上产生编译竞态（同 [[parallel-vitest-agents-shared-mongo-2026-08-14]] 讲的共享 mongod 握手文件竞态是同一类问题，只是这次撞的是 tsc 的输出目录而不是 mongod 的 URI 文件）。engine 本身是纯计算库，无 Mongo/HTTP/其它 `@nw/*` 运行时依赖，`npm install` 只装 `typescript`+`@types/node`，代价很小——于是这次改用**每个 agent 各自独立 git worktree**（`feat/engine-coverage-{a..e}`，各自 `New-Item -ItemType Junction` 指到主检出 `server/node_modules`），从根源上避免 `dist/` 竞态，而不是像 vitest 系那样共享一个工作目录。5 路并行，按缺口分组（各自新增文件，互不touch，完工后 `git merge --no-ff` 五个分支回 `feat/engine-coverage`，无冲突）：

- **combat**（`hitResolution.ts` 66.51%、`projectiles.ts` 79.35%、`targeting.ts` 87.80%、`CombatSystem.ts` 函数覆盖仅 12.5%）→ 全部 **100/100/100**。3 个新文件、42 例。`CombatSystem.ts` 的函数覆盖缺口根因：既有测试只调过它的 `tick()`，从未直接调用它转发的 `findTarget`/`performBuildingAttack`/`fireProjectile`/`tickProjectiles` 等具名导出——新测试改成从 `CombatSystem`（barrel re-export）而非各 `combat/*` 子模块导入，一并把这条函数覆盖缺口堵上。
- **ai**（`ai/defense.ts` 67.12%、`ai/threatAssessment.ts` 74.63%、`ai/meteorTargeting.ts` 81.94%（函数仅 40%）、`AISystem.ts` 96.18%）→ 全部 **100% 行**（分支 88.89%~96.97%，剩余是 `findMeteorTarget`/`freeBuildingLane` 内层扫描的越界防御分支，锚点扫描循环自身的边界条件保证其不可达，未继续追）。4 个新文件、20 例。
- **hazard+spell+movement+resource+building**（本轮缺口最大的一组：`HazardSystem.ts` 仅 43.10%、`SpellSystem.ts` 仅 57.60%（函数 42.86%）、`MovementSystem.ts` 80.33%、`ResourceSystem.ts`/`BuildingProductionSystem.ts` 分支覆盖分别只有 63.64%/80%）→ 全部 **100% 行/函数**（`MovementSystem.ts` 分支 96.38%，剩余是 `predictStopY` 多敌方同车道扫描的边缘排列组合，行/函数已全覆盖，性价比递减未追）。5 个新文件、39 例。过程中发现一处测试本身的坑（非源码 bug）：`MovementSystem.tick()` 按 `Map` 插入顺序逐个访问单位，"前车"在同一 tick 内先完成自身推进、"后车"的碰撞检测才跟着跑——最初的"友军碰撞"测试用前车 tick 前的位置算期望间距，间歇性失败，改成用前车 tick 后的位置算期望值即修复。
- **setup+math**（`setup/board.ts` 87.50%（分支 42.86%）、`setup/drawPolicy.ts` 83.70%、`setup/buildCtx.ts` 分支仅 87.5%、`math/prng.ts` 80.95%）→ 全部 **100/100/100**。4 个新文件、40 例，含 `prng.ts` 此前完全零覆盖的 `shuffle()`（含同种子确定性、跨种子发散断言）。
- **sim+misc**（`sim/campaign.ts`/`sim/commands.ts`（函数仅 62.5%）/`sim/hand.ts`/`sim/step.ts`/`sim/winCondition.ts`（本组最大缺口）/`Player.ts`/`Unit.ts`（函数仅 83.33%）/`runHeadless.ts`/`GameState.ts` 分支缺口/`types.ts`）→ 除 `types.ts` 外全部 **100/100/100**。8 个新文件、约 35 例。`types.ts` 10-11 行留白：追到编译产物 `dist/types.js`，落在 TS 给每个 `export * from './types/xxx'` 桶文件自动生成的 `__createBinding` ES5 兼容兜底分支（`Object.create ? ... : (else 分支)`）——Node 下 `Object.create` 恒真，else 分支是所有 TS 桶文件都有的死代码，不是真实缺口，不追（同 shared 的 `mongo/collections.ts`、worldsvc 的 `combatSiege/ctx.ts` 等"纯声明/工具链死分支不算真实缺口"的先例）。

engine 整体行覆盖率 **86.49% → 92.98%**（`node --test --experimental-test-coverage`，205 test files 全绿——新增 24 个测试文件、约 165 例，原有约 165 例零改动；`tsc -b`/`tsc --noEmit` 均干净）。分支覆盖 83.01%→92.21%、函数覆盖 81.17%→91.72%。

**留意但未继续追的残余缺口**：`src/campaign/levelSchema.ts` 及其 `levelSchema/{board,escorts,garrison,hazards,helpers,objective,rewards,waves}.ts` 子模块（18%~85% 不等）——这是本轮任务清单（基于上一次跑分时被 `tail -N` 截断的输出）里遗漏的一块，核实后确认是本轮开工前就存在的既有缺口，不是这次改动引入的。这些文件是"JSON 加载的关卡定义"运行时校验器（`design/tools/level-editor/DESIGN.md`），当前覆盖集中在 happy-path，各字段的拒绝/报错分支大多未测——真实缺口，留给下一轮。另外 `Card.js`（94.44%）、`Building.js`（96.33%）、`campaign/levelSchema.js` 门面（60.45%）、`engine/driver/realtimeDriver.ts`（91.67%）、`engine/setup/blueprints.ts`（73.47%）也顺带浮现出来，同一批留待下一轮核实是否需要优先处理。**⚠️ 一次性观察到的 coverage 报告抖动**：某个 agent 反馈同一份测试代码、零源码改动，`AISystem.js` 有时报 100% 行、有时报 96.82%（缺 109-113 行）；本次收尾时又跑了 2 次全量 `test:coverage` 均稳定 100%，判断是 Node `--experimental-test-coverage` 在重负载/`tsc -b` 增量编译交互下的瞬时抖动，同 worldsvc 那次 `SlgError: No viable path found` 一次性 flaky 一样未继续深挖根因，如果后续在 CI 上复现从这里开始排查。

## matchsvc 补测：persist.ts Redis 失败分支 + config.ts + rooms/Matchmaking/matchStarter/queue/duel/gatewayClient 分支缺口，从 88.32% 拉到 93.99%（2026-08-15，worktree `feat/matchsvc-coverage`）

engine 补到 92.98% 后重新核实一遍全部 14 包，**matchsvc（88.32%）** 与 **analyticsvc（87.59%）** 是仅剩的两个低于 90% 的包（其余全部 ≥90%）——本节 + 下一节各自处理一个。matchsvc 是"私有匹配大脑，不连库"（M17，架构表见本文档开头），全套测试走 vitest + 依赖注入的假对象（假 Redis/假 push 回调/假 matchStarter），没有 globalSetup/真实 Mongo，因此两个并行 agent 可以直接共享同一个 worktree、同一个工作目录并发跑 `vitest run`，不需要 engine 那次的"每 agent 一个 worktree"或 worldsvc/analyticsvc 那次的"共享 mongod"任何一种隔离手段——按缺口分两组：

- **persist.ts + config.ts**：`persist.ts`（317 行，Redis 写穿透/rehydrate 原语，此前 84.9%，本包最大缺口）→ **100/100/100**——根因是文件本体每个函数都是`if(!redis) return` 空跑保护 + `try{...}catch(e){warn(...)}` best-effort 包一层，未覆盖的行几乎全是 `catch` 分支；修法是给既有 `test/persist.test.ts` 里的 `fakeRedis()` 假客户端加一个 `fail` 标志位（每个方法可按需抛错），对每个 catch 点补一例"Redis 抛错时函数吞掉异常、只是 warn 日志、不影响调用方"的断言。`config.ts`（0%，`loadMatchsvcEnv()` 纯 env 读取）→ **100/100/100**。1 个新文件（`test/config.test.ts`）+ `test/persist.test.ts` 追加 18 例。
- **rooms/Matchmaking/matchStarter/queue/duel/gatewayClient**（同一 worktree、同一目录并发跑的第二个 agent，与上一组互不touch）：`rooms.ts`（`RoomRegistry` 类，289→290 行，89.7%）→ 96.56%（分支 92.59%，剩 132-138 行——追查后确认是死代码：两个 slot 都 ready 时 `roomReady` 的自动开局早已在唯一一次 `await` 之前同步销毁了房间，`roomStart` 走到"两人都 ready 且房间还活着"这个分支在公开 API 下不可达，方法保留原样但成功路径已证明打不到）；`Matchmaking.ts`（97.22%，funcs 91.66%，`clear()` 此前从未被任何测试调用）→ **100/100/100**；`matchStarter.ts`（96.49%）→ **100/100/100**；`queue.ts`（分支 96.42%）→ **100/100/100**；`duel.ts`（分支 93.33%）→ 100% 行，96.96% 分支（剩 `cancelDuel` 的"invite 找不到"守卫，追查后确认 `duelInvites`/`pendingDuelByAccount` 两个 Map 永远成对写入/删除，不存在只有后者没有前者的状态，是另一处不可达死代码——注意它的姊妹守卫在 `expireDuel` 里*是*可达的，靠两条 `hydrateAll()` 记录共享同一个 inviteId 这种"真实 Redis 数据不会出现、但作为防御性代码值得测"的场景触发）；`gatewayClient.ts`（分支 86.66%）→ **100/100/100**。6 个新/追加文件，约 32 例。

matchsvc 整体行覆盖率 **88.32% → 93.99%**（`npx vitest run --coverage`，14 test files / 197 tests 全绿——原有 165 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 91.08%→97.53%、函数覆盖 97.16%→99.05%。**未继续追**（均为验证过的死代码，非真实缺口）：`rooms.ts` 132-138 行、`duel.ts` 114 行（见上）；`internalHttp.ts`（99.23%，剩 1 行）、`index.ts`（0%，进程 bootstrap，同前几个包先例不单独起集成测试）本轮未处理（原本就不在任务清单内，本来就 ≥99%/属于 bootstrap 类，非本轮重点）。

## analyticsvc 补测：config/scheduler 从 0% + httpApi 路由分发/service 四文件分支缺口，从 87.59% 拉到 95.61%（2026-08-15，worktree `feat/analyticsvc-coverage`）

matchsvc 那一节的姊妹任务，同一次重新核实里 **analyticsvc（87.59%）** 是当时唯一还没处理的低于 90% 的包。analyticsvc 用 vitest + 单机 `mongodb-memory-server`（非副本集，无事务）当 `globalSetup`，两个并行 agent 若各自独立跑 `vitest run` 会在共享的 URI 握手文件上竞态（同 [[parallel-vitest-agents-shared-mongo-2026-08-14]] 描述的那类问题）——按该技巧，主会话自己在 `server/analyticsvc/_scratch_mongo.mjs`（未提交，收尾前删除）起了一个共享 `MongoMemoryServer`，把 URI 喂给两个 agent，都设 `NW_MONGO_URI=<uri>` 跳过 `globalSetup.ts` 自己的 mongod 握手。按缺口分两组：

- **config.ts + scheduler.ts**（其实这组的两个文件都不需要真 Mongo——`config.ts` 是纯 env 读取，`scheduler.ts` 的 `startEtlScheduler()` 只需要一个带 `runFunnelEtl(dateStr)` 方法的桩对象——但仍统一设了共享 URI，纯粹是为了让这个 agent 自己的 `vitest run` 调用不触发 `globalSetup.ts` 自己的 mongod 握手、跟另一个真正需要 Mongo 的 agent 抢跑）：`config.ts`（0%）→ **100/100/100**；`scheduler.ts`（0% 行，分支反而 100%——意味着 `startEtlScheduler()` 本体从未被任何测试真正调用过）→ **100/100/100**（`vi.useFakeTimers()` 验证立即执行+每小时重跑+重入保护+错误吞掉+清理函数停表，5 个场景）。2 个新文件，8 例。
- **httpApi.ts + service/{dist,funnel,ingest,traffic}.ts**（需要真实 Mongo）：`httpApi.ts`（219 行，此前 80.23%，`GET /internal/query?type=...` 分发链尾部几个查询类型分支 + 边界处理未测）→ 100% 行（分支 92.47%，剩 7 行——逐条验证均为"真实 HTTP 语境下结构性不可达"：`clientIp` 的 `Array.isArray(xff)` 分支（Node 会把重复的 `X-Forwarded-For` header 自动拼成一个逗号分隔字符串，永远不会以数组形式出现在 `req.headers`）、`remoteAddress`/`resolveGeo` 的空 IP 兜底（真实已建立的 TCP 连接恒有 `remoteAddress`）、`ERROR_HTTP_STATUS[code] ?? 400`（该文件用到的三个错误码在 `@nw/shared/src/api.ts` 里全部有映射）、`req.method`/`req.url` 的空值兜底（Node 恒会填充这两个字段）——均逐条验证过确实不可达，不是偷懒跳过）；`service/dist.ts`（分支 80.95%）→ **100/100/100**；`service/funnel.ts`（分支 86.56%）→ **100/100/100**；`service/ingest.ts`（分支 80.39%）→ **100/100/100**；`service/traffic.ts`（funcs 85.71%）→ **100/100/100**。扩展了既有的 `test/analytics.e2e.test.ts`（25→43 例）+ `test/service-domains.e2e.test.ts`（24→32 例），未新建文件。

analyticsvc 整体行覆盖率 **87.59% → 95.61%**（`npx vitest run --coverage`，6 test files / 98 tests 全绿——原有 49 例零改动；`npx tsc --noEmit` 干净）。分支覆盖 84.16%→97.56%、函数覆盖 95.83%→98.64%。**未继续追**：`db.ts`（90%，本轮未列入任务清单，非新增缺口）、`index.ts`（0%，bootstrap，同前几个包先例不追）。

---

**里程碑（2026-08-15）**：至此 **14 个包（client + 13 个 server workspace）全部 ≥90% 行覆盖率**——本节工具接入以来跑的"修最低覆盖率"轮次到此告一段落，此后除非有改动引入回归，不必再按"哪个包最低"排队处理；各包仍标注的"未继续追"残余缺口（`levelSchema/*`、`mapTemplateService.ts`、`httpApi/*Routes.ts` 等）留作按需处理，不再是"最低优先级"驱动。

## CI 稳定性：让"PR 绿了、合进 main 却红、于是不部署"不再发生（2026-08-15，worktree `feat/ci-stability`）

**触发**：同一天 main 上 CI 红了两次（PR #101 run `31887181835`、PR #103 run `31902034760`），两次都在对应 PR 的 CI 已经绿了之后；8 个 `*-deploy.yml` 都靠 `workflow_run.conclusion == 'success'` 门控，于是"合并了但没上线"。事故面的记录见 `design/product/deploy-cloudflare.md` §6 同名小节（那里侧重部署侧），这里记测试/CI 侧。

**结论：根因是测试套件本身不确定，不是两条流水线检查内容不同。** 证据三条：

1. 三次 main 红各不相同——#101 metaserver `pvp-card-stats`（读抢在 fire-and-forget 写前面）、#103 worldsvc `httpApiActionSiegeMapGaps`（`PATH_BLOCKED`）、7-29 #76 full-link E2E。
2. **PR 也一样在 flake**：最近 100 次 CI 中 PR 失败 20 次，`31898655236`（PR，worldsvc shop TOCTOU）重跑后才绿。PR 是"重跑到绿"的**有筛选样本**，main 每次合并只跑一次——同样的 flake 率，只有 main 侧会被看见。这是观感的第一位成因。
3. #103 那次的直接原因可以证明与 coverage 无关：`POST /world/join` 自动选点走 `Math.random()`（`core/spawn.ts` `pickRandomEmptyTile`），首都落点每次不同，而该文件每个用例都以首都为原点取目标（`findCoord(…, baseX + 30, …)`）再行军过去——两点之间有没有路可走是**每次一掷**。

**放大器（真实存在的 PR/main 不对称，已全部消除）**：

- `TEST_SCRIPT` 让 PR 跑 `test`、main 跑 `test:coverage`。上一节 2026-08-14 那条改动的论证写的是"same test files, same assertions, same failures"——前两句成立，第三句不成立：v8 插桩把每个 await 窗口都拉长（同 commit 实测 worldsvc `184.53s → 226.27s`，collect `20.26s → 41.23s`；client 按当时自己的测量是 188s→668s），时序敏感用例在 main 侧概率更高。
- 90% 覆盖率门禁只在 main 跑 → 覆盖率回归在 PR 上原理上测不出来。
- shard 挂 → 无 coverage 产物 → 门禁再报一次 `no coverage/ output found`（#101 就是这样两条红），更响的假红盖住真因。

**本轮改动**：

- **确定性（治本）**：`httpApiActionSiegeMapGaps.e2e.test.ts` 的 `beforeAll` 改成显式坐标建都（`svc.joinWorld(W, 'acct-1', x, y)`，坐标由 `findCoord` 在固定锚点附近确定性地选出），整份文件从"每次一掷"变成"要么次次过、要么次次挂"；本地连跑 5 次全绿。`WorldServiceDeps` 新增可注入的 `rng?: () => number`（默认 `Math.random`，`SpawnService` 的选点与洗牌都走它），供必须验证自动选点路径的用例钉死随机源。
- **PR/main 同命令**：`ci.yml` 删掉 `TEST_SCRIPT`，两个 job 一律 `npm run test:coverage`；两处 `upload coverage artifact` 和 `coverage-report` job 去掉 `github.event_name != 'pull_request'` 条件，覆盖率门禁因此同时在 PR 生效。
- **client 那笔 3.6 倍的税直接买断，不是硬扛**：原先"PR 不跑 coverage"的唯一实质理由是 client 的 188s→668s。实测发现这笔税几乎全部来自 `test/difficulty/**` + `test/pvpSim.test.ts`（整场无头战斗模拟，几千 tick 每 tick 都在交插桩税），而**它们对覆盖率的贡献是 0.05 个百分点**（把它们排除后 client 行覆盖 91.20% → 91.15%——它们碰到的 `src/game/**` 早被单元测试覆盖了，它们本质是"第 6 章还打得过吗 / PvP 模拟还在区间内吗"的行为回归，不是覆盖率来源）。于是拆出 `client/vitest.sim.config.ts`：这批文件照跑（`test` 和 `test:coverage` 都在末尾链一条 `npm run test:sim`），只是**不插桩**。带 coverage 的那半从 668s 掉到 ~13s，两端全量 coverage 的总时长反而和过去 PR 上不带 coverage 的 188s 基本持平。**代价**只剩 server shard 的 ~+25%——等在 PR 上是便宜的，红在已合并的 commit 上是不能接受的。
- **retry + 可见性**：12 个 server workspace 的 `vitest.config.ts` 加 `retry: 1`（client 的 e2e/load 两个 config 同样加），并挂 `scripts/flakyReporter.mjs`——把"失败后重试才过"的用例输出成 GitHub `::warning::` 注解 + step summary 表 + `flaky-report.json`（CI 作为 artifact 上传，保留 7 天）。**retry 不是用来和 flaky 共存的**：它把 flaky 从"阻断部署"降级为"可见的待办"，全靠这个 reporter 保证它没被藏起来；一个需要 retry 才过的用例仍然是要修的 bug。client 的**单元测试没有加 retry**——那是纯逻辑套件，没有 DB/网络这类正当的重试理由，加了只会掩盖真实的不确定性。
- **级联假红**：`checkCoverageThreshold.mjs` 读 `TESTS_OK`（ci.yml 用 `needs.*.result` 传入）。测试 job 已挂时缺产物记为"跳过"、退出 0（run 反正已经红、也不会部署）；测试全绿时缺产物仍 fail-closed（那才是真的"覆盖率悄悄不产出了"）。
- **主动发现**：`.github/workflows/flake-hunt.yml`，每晚 02:00 UTC 把 metaserver/worldsvc/rest/client 各连跑 3 次（带 coverage，复现同样的时序），失败即报——树没变，所以任何一次挂都是不确定性；同时收集各 shard 的 `flaky-report.json`（保留 30 天）。可 `workflow_dispatch` 指定 `runs`/`shard` 手动追查。
- **兜底**：`.github/workflows/ci-rerun-once.yml`，main 上失败的 CI run 自动 `gh run rerun --failed` 一次（`run_attempt == 1` 卡住上限，只对 `push` 事件，PR 不自动重跑）。覆盖的是 vitest retry 够不到的那层——runner 抽风、docker pull 超时、mongod 下载中断。重跑成功会重新发一次 `workflow_run: completed`，deploy 照常触发，不需要在 8 个 deploy workflow 那边做任何改动。
- **结构性（本仓库暂时用不了，已确认）**：`ci.yml` 加了 `merge_group:` 触发器，但**GitHub merge queue 只对「组织（organization）名下的仓库」开放，个人账号名下的仓库无论公开与否都用不了**——`bigtaoo/funny` 属于个人账号，API 建 `merge_queue` 规则一律 422 `Invalid rule 'merge_queue'`（同一次调用里其它规则改动能成功，排除了权限问题；GraphQL `repository.mergeQueue` 恒为 null）。想要就得把仓库转到一个组织下（公开仓库转组织后免费可用）。触发器留着，转组织当天即生效，不用改 workflow。
- **替代品（已启用）**：ruleset `Only PR` 的必需检查里补上了 `test coverage report`（此前不在列表里，覆盖率门禁挡不住 PR），且该 ruleset 本来就开着 `strict_required_status_checks_policy: true`——**分支必须先与 main 同步才能合并**，等于强制 PR 的 CI 跑在「已经包含最新 main」的树上。在本仓库这种单人、日均 1~2 个 PR 的节奏下，这条已经覆盖了 merge queue 的绝大部分收益（差别只剩「CI 跑在真正的 merge commit 上」+ 串行排队）。

**写测试时的确定性规则（本轮沉淀，评审按这个看）**：

1. **不许依赖没注入的随机源**。业务代码里的 `Math.random()` 要么走注入（如本轮的 `WorldServiceDeps.rng`），要么测试绕开它（显式坐标/显式 id）。
2. **不许"写完立刻读" fire-and-forget**。正确姿势是 `vi.waitFor` 轮询（先例：`metaserver/test/pvp-card-stats.e2e.test.ts`、`gameserver/test/lifecycle.test.ts`）。
3. **并发用例不许断言具体的交错**。断言要对所有合法交错都成立（先例：`worldsvc/test/review-fixes-2026-08-03.e2e.test.ts` 的 coin conservation 写法）；确实要覆盖某条竞态分支时，注入钩子把那个交错**制造出来**（同文件的 `onSpend`），别指望调度器碰巧给你。

## `test/**` 首次接入类型检查：13 个包各补 `tsconfig.test.json`（2026-08-19，worktree `feat/server-test-typecheck`）

**背景**：每个 workspace 的 `tsconfig.json` 只 include `src/**`，而 vitest 走 esbuild（只擦类型、从不检查），所以 **13 个包、约 380 个测试文件从来没有被类型检查过**。客户端早就用 `client/tsconfig.test.json` + `npm run typecheck` 关掉了这个口子（CI 在跑测试前先跑它），服务端一直没有。首次接上后一次性暴露 **758 个错误 / 140 个文件**。

**做法**

- 每个包新增 `tsconfig.test.json`：`extends ./tsconfig.json` + `include: ["src/**/*", "test/**/*"]` + `rootDir: "."` + `composite/declaration:false` + `noEmit`。engine 早就有一份（它的 `test` 脚本本来就 `tsc -p tsconfig.test.json` 编译后再跑），只补脚本。
- 每包 `typecheck:test` 脚本；根 `npm run typecheck:test` 用 `--workspaces --if-present` 扇出；CI `server-checks` job 在现有 `tsc -b` **之后**加一步跑它。
- `scripts/checkWorkspaceCoverage.mjs` 加两条断言：每个 workspace 必须有 `tsconfig.test.json` 和 `typecheck:test` 脚本（根扇出用的是 `--if-present`，少了脚本会被**静默跳过**，正是这个脚本存在的意义）。

**三个必须知道的配置坑**

1. **`references` 不会被 `extends` 继承**，必须在 `tsconfig.test.json` 里原样重复一遍。否则 `@nw/shared` 会退回 node_modules → `shared/dist/*.d.ts`，在没 build 过的检出里直接 240 个假 TS2307（光 metaserver 就这么多）。即便重复了，这些程序仍是**非 build 模式**，依赖 `tsc -b` 产出的 `dist/*.d.ts` 存在——所以 CI 里这一步必须排在 `tsc -b` 之后。
2. **`module` 要跟着 vitest 的现实走**：继承下来的 CommonJS 会让若干 e2e 里的顶层 `await` 报 TS1378（vitest 按 ESM 转译，运行时完全合法），所以除 metaserver 外都覆盖成 `ES2022`。metaserver 自己是 `NodeNext`，强行改成 ES2022 会 TS5110；但它在 NodeNext 下又会要求 `../src/x` 写成 `../src/x.js`（TS2835），所以单独覆盖成 `ESNext` + `moduleResolution: Bundler`——这才是 vitest 实际的解析方式。
3. **auctionsvc 排除了 `test/auction-fulllink.e2e.test.ts`**（配置里有注释）：它故意 import 真实的 client `WorldApiClient`，会把 DOM 全局 / pixi / @bufbuild 拖进一个 Node-only 程序，要检查它就得在 server-checks job 里装 client 依赖并加 `lib:DOM`。当时是全仓库唯一一个不检查的测试文件；**次日（2026-08-20）由 `client/tsconfig.fulllink.json` 接管**，见下一节——`exclude` 保留（它确实不该进 Node-only 程序），但文件本身不再是豁免。

**758 个错误的分布与修法**（多数是机械的，但每一类都藏着"测试其实没在验证它自称验证的东西"）

| 类别 | 量级 | 修法 |
|---|---|---|
| `Response.json()` 返回 `unknown` | ~230 | 每包一个 `test/jsonBody.ts`（带注释的单点 cast，支持传具体类型），不是满地 `as any` |
| 假实现落后于接口（少方法/少字段） | ~120 | 补上的成员一律 **throw `not stubbed`**，不返回假成功——这些成员本来就不存在，任何调到的路径早就崩了，抛错只是把崩溃变得有名字 |
| 假实现留着接口已删的成员 | ~30 | 直接删（类型上读不到，删了不改变行为） |
| `noUncheckedIndexedAccess` 下的下标/属性链 | ~150 | 加 `!`（纯类型层，运行时零影响） |
| `vi.fn(async () => x)` 声明了零参数，测试却断言 `mock.calls[0][1]` | ~80 | 给 mock 声明 `...unknown[]` 参数 |
| 测试双写的 Mongo/响应体 cast 不重叠 | ~45 | `as unknown as T` |

**顺带挖出来的真问题**（都不是格式问题）

- `metaserver/test/internal.test.ts` 40 处 `makeNewSave('a')` 少传 `now`——所有种子存档的时间戳是 `undefined`。
- `shared/test/internalFetch.test.ts` 用 `caller: 'metaserver'` 并断言出站 `x-internal-caller` 等于它，但合法值是 `'meta'`（`InternalCaller` 里没有 `metaserver`）——线上永远不会发出那个值。
- `admin/test/comp-mail.e2e.test.ts` 调 socialsvc `startHttpApi` 只给了 6 个参数中的 5 个（`meta` client 整个缺失），且 `FamilyService` 没给 `now`。
- `admin/test/clients-worldAuctionAnalytics.test.ts` 用 `status: 'active'` 查拍卖，而 `AuctionStatus` 是 open/sold/cancelled/expired。
- `worldsvc/test/sect-query-gaps.test.ts` 断言 `emblemKey: 'lion'`，而 `EMBLEM_KEYS` 全是 `emblem_*`。
- `CardInstance.xp` 在换成融合升级时就删了（`2d6b08a3`），31 处夹具还在写。
- **`metaserver` 的钱包镜像路径其实一直没被测到**：`FakeCommercial.getWallet` 只返回 `{coins, pity}`，而 `mirrorWalletFrom` 第一件事就是 `wallet.starterUsed.includes(...)` → 每次 `GET /save` 的镜像都在 `try/catch` 里静默 TypeError。补全 `WalletView` 后 `retention.e2e` 的 day-30 用例立刻挂了——因为它读的是"镜像失败才保住"的旧值；那个用例自己的注释早就写明"failingApp 必须复用同一个钱包账本"，但代码给的是 `new FakeCommercial()`。改成共用同一个实例后通过。
- 两处**生产类型**确实写错，测试是对的：`worldsvc/src/nationChannelService.ts` 的 Deps 要具体类 `HttpWorldGatewayClient` 却只用 `broadcast`（收窄成接口）；`PlayerWorldView` 从未声明 `hasBattlePass`，可 `getMe()` 一直在返回、openapi 里也有（补上）。
- 两个一次性迁移脚本（`metaserver/scripts/migrateCardInv.ts`、`samplePvpReplays.ts`）用 `Collection<Document>` 表示 string-keyed 集合，`{_id: accountId}` 过滤全是类型漏洞——它们被测试 import，这次一并类型化。

**验证**：13 个包 `typecheck:test` 全 0 错、根 `tsc -b` 全绿；各包测试套件全跑一遍确认没有行为回归（metaserver 1639 / worldsvc 917 / shared 956 / socialsvc 216 / commercial 213 / gateway 181 / botsvc 119 / gameserver 127 …）。

---

## 唯一的类型检查豁免归零：`client/tsconfig.fulllink.json` 接管跨包 full-link 测试（2026-08-20，worktree `feat/auction-fulllink-typecheck`）

**背景**：上一节把 13 个包的 `test/**` 都接进了类型检查，只留下一个洞——`auctionsvc/test/auction-fulllink.e2e.test.ts` 写在 `tsconfig.test.json` 的 `exclude` 里。它是唯一一个**跨包**测试：一头驱动真实的 `client/src/net/WorldApiClient`（浏览器构建实际发的那份代码），另一头打真实的 auctionsvc `startHttpApi` + `mongodb-memory-server`。它的类型错误此前对任何 CI 步骤都不可见。

**为什么不能塞进任何已有程序**（这三条决定了解法的形状）

- 它同时要 **DOM lib + `client/node_modules`**（`WorldApiClient` → `platform/IPlatform` → `import type * as PIXI from 'pixi.js-legacy'`，类型层真的要 pixi）**和 `server/node_modules` + node 类型**（`mongodb`、`import('http').Server`、`import('net').AddressInfo`）。没有任何现成程序是这个并集。
- 塞进 `auctionsvc/tsconfig.test.json` 等于把一个 Node-only 配置弯成第二份 client 配置，还要让 `server-checks` job 去装 client 依赖。
- 塞进 `client/tsconfig.test.json` 会撞 `paths`：client 故意把 `@nw/shared` 窄化成 `../server/shared/src/slg/index.ts`（只给客户端看 slg 子集），而这个测试要 `signToken`/`SlgError`/`EquipmentInstance`——全在完整 barrel 里、不在 slg barrel 里。

**做法**：新增第三个程序 `client/tsconfig.fulllink.json`，专门装「import 了 client 源码的 server 测试」。

- `extends ./tsconfig.json`（拿到 DOM lib、strict、`@nw/engine` 映射），**只覆盖三处**：
  - `paths` 里 `@nw/shared` 重新指向 `../server/shared/src/index.ts`（完整 barrel）。它是 slg barrel 的**超集**，所以 client 源码在这个程序里不会解析到不同的东西；而"客户端只能看 slg 子集"这条边界仍然由 `tsconfig.test.json` 把关——那才是真正 gate 客户端代码的程序。
  - `types: ["node"]` + `typeRoots` 指到 `../server/node_modules/@types`。**没有**把 `@types/node` 装进 client devDependencies：那会让浏览器代码引用 `process`/`Buffer` 也能通过主程序的类型检查，是一条有用的边界，不能为了一个测试文件拆掉。
  - `include` 只有一行（那个测试文件本身），其余全靠 import 追踪进来；以后有第二个跨包测试就再加一行。
- **宿主放 client 侧而不是 server 侧**，唯一理由是 CI：`client-test` job 本来就 `npm ci` 装了 **server/ 和 client/ 两份**依赖（步骤名"server install (client's @nw/engine + @nw/shared aliases resolve to server/ TS source)"），而 `server-checks` 只装 server/。这是全仓库唯一同时具备两侧依赖的 job。
- `client/package.json`：新增 `typecheck:fulllink`，并把它**链进** `typecheck`（`tsc -p tsconfig.test.json && npm run typecheck:fulllink`）。于是 CI 现有的 client typecheck 步骤零改动就覆盖到了，不用新增 job（只改了步骤名和注释）。
- **`exclude` 保留不动**：这个文件确实不该进 auctionsvc 那个 Node-only 程序。变的不是"要不要排除"，而是"排除之后有没有人接"。

**把「零豁免」变成可执行约束**：`scripts/checkWorkspaceCoverage.mjs` 加第三条检查——遍历每个 workspace 的 `tsconfig.test.json#exclude`，每一条都必须出现在 `client/tsconfig.fulllink.json#include` 里（两边路径都归一成 repo 相对的 POSIX 形式再比），否则失败并指名道姓告诉你加到哪。顺带**禁掉 glob 形式的 exclude**（`*`/`?`）：一旦允许通配，"这个文件到底有没有被某个程序检查"就变成不可判定的，守卫本身就失去意义。这条正是上一节留下的教训的推广——`exclude` 是个能悄悄把文件从检查里摘出去的旋钮，跟当年 `--if-present` 悄悄跳过缺失脚本是同一类问题。

**验证**：`client npm run typecheck`（两个程序）+ server `npm run typecheck` / `typecheck:test` / `check:workspacecoverage` 全绿；`auctionsvc` 那 8 个 full-link 用例照旧全过。三次反向验证：①往测试文件里注入两处类型错误（`price: 'ten'`、`const bogus: number = view.auctionId`），确认新程序**报了这两条**而不是静默通过；②把 `tsconfig.fulllink.json#include` 清空，确认守卫报"excluded ... without another program owning it"并退 1；③把 exclude 换成 `test/*.e2e.test.ts`，确认守卫报 glob 不允许并退 1。另外用 `tsc --listFiles` 确认程序里确实同时含 `client/src/net/WorldApiClient.ts`、`client/src/platform/IPlatform.ts`、`pixi.js-legacy`、`server/shared/src/index.ts`、`server/auctionsvc/src/httpApi`、`mongodb/mongodb.d.ts`（934 个文件），排除"程序其实是空的、所以当然全绿"这种假绿。
---

## `MatchReplayDoc.frames[].cmds[].commands`：`unknown` → `string`（2026-08-20，worktree `feat/replay-commands-string`）

上一节接入 `test/**` 类型检查时留下的第二笔类型债（第一笔是 full-link 那个豁免）。`@nw/shared` 的 `MatchReplayDoc` 把命令字节声明成 `unknown`，注释写的是「BSON binary（opaque game.proto bytes）」——**两个都是 2026-07-20 gzip 改动之前的遗留**。

**为什么 `string` 才是唯一正确的形状**（这条是本次改动的全部依据）

- `MatchReplayDoc` 从来不以 BSON 形式落库。自 2026-07-20 存储成本修复起，它只以 **JSON 形式存在于 gzip blob 里**（`compressReplayDoc` → `MatchDoc.replayGz` / `ReplayBlobDoc.replayGz`），而 `MatchDoc.replay` 这个内嵌字段早就不存在了（只剩 `replayGz` / `replayRef`）。全仓库 grep 确认没有任何代码还在读旧字段。
- JSON 没有字节类型。所以 Buffer 根本活不过这条管线：`JSON.stringify(Buffer)` 出来的是 `{"type":"Buffer","data":[…]}`，`JSON.parse` 回来就是那个对象，往下游裁判/复算一喂就是垃圾。
- 真正的字节→base64 转换只有**一处**：gameserver 的 `metaReport.ts`，把 `MatchReplay`（内部类型，`commands: Uint8Array`）转成 `MatchReplayDoc`（存储类型，`commands: string`）。两个类型之所以不同，就是这一步。

**改动**：`commands: unknown` → `commands: string`，并把注释改成说明「proto 里是 `bytes`，但这份 doc 只以 JSON 存在，所以是 base64」。随之删掉两处 `String(c.commands)` 强转（`metaserver/src/anticheatAudit.ts` 的 `toJudgeFrames`、`internal/matchReport/peerJudge.ts` 的 judge 调用）——它们对已经是字符串的值是空操作，只是把形状藏起来了；真要是 Buffer 走到那儿，`String()` 给出的也是垃圾而不是补救。顺手订正两句已经指向不存在字段的注释（`ReplayBlobDoc` 的 `MatchDoc.replay`、`balanceDocs.ts` 的 `MatchDoc.replay.decks`）。

`server` 全量 `tsc -b` + `typecheck:test` **零错误**——上一轮把 380 个测试文件接进类型检查时，已经把所有夹具规范成了字符串，所以这次收紧没有暴露任何调用方。

**补了两个此前不存在的用例，把契约的两端都钉住**（光收紧类型是编译期的事，运行时行为一个字没变，所以真正的价值在这两条）

- `shared/test/replayCodec.test.ts`：**为什么不能是字节**。故意越过类型塞一个 Buffer 进去，断言 round-trip 回来的是 `{type:'Buffer',data:[0,1,2]}` 而不是 Buffer；同一批字节的 base64 则原样回来且能解回原字节。等于把上面「JSON 没有字节类型」这句话变成可执行的。
- `gameserver/test/metaReport.test.ts`：**生产端确实做了 base64**。这个文件原有的 16 个用例**全部**用 `frames: []`，也就是说 `metaReport.ts` 里那行 base64 编码——两个类型差异的唯一理由——从来没有被任何测试执行过。新用例塞一帧真命令字节，从 POST 出去的 `replay_gz` 解回来，断言等于 `Buffer.from(bytes).toString('base64')` 且能解回原字节。反向验过：把那行的 `.toString('base64')` 去掉，用例立刻红在 `expected { type: 'Buffer', …(1) } to be 'BwD/Kg=='`——正是上面描述的失效形态。

**验证**：`server` `tsc -b` / `typecheck:test` / `check:workspacecoverage` 全绿；`shared` 51 文件 997 例、`gameserver` 11 文件 128 例（+1）、`metaserver` 全量套件全绿。两条新用例都做了 red-then-green 实测（破坏点见上），`MatchReplayDoc` 的收紧本身也反向验过（往夹具里塞 Buffer 确实报 TS2322）。
