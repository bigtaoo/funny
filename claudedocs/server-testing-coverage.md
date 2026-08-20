# 服务端 — 各服务测试覆盖率补齐（2026-08-13 ~ 08-15）

> 从 [`server-testing.md`](server-testing.md) 拆出（2026-08-20，原文件 501 行，ADR-067）。姊妹分册：[`server-testing-tooling.md`](server-testing-tooling.md)（覆盖率工具 / CI）、[`server-testing-typecheck.md`](server-testing-typecheck.md)（`test/**` 类型检查）。
> 本册是 13 个包逐个把**行覆盖率百分比**拉到 90%+ 的记录，一个包一节。工具怎么接上的、90% 门禁在哪，见上面第一个链接；「哪些代码路径完全没测过」的人工审计在 [`server-testing.md`](server-testing.md)。

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
