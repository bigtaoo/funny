# 服务器间通信协议审计（comm-audit-internal-2026-07-28）

> 承 2026-07-27 前后端通信审计（client↔server 请求瀑布，见 `SLG_DESIGN_LOG.md` §42/§43）。本轮切面为**服务与服务之间**的内部通信：11 个 Node 进程的内部端点、出站客户端、Redis 通道。4 个探索代理并行覆盖 meta / gateway+matchsvc+gameserver / worldsvc+auctionsvc / socialsvc+admin+analyticsvc+botsvc+commercial，全部结论均以真实调用点（文件:行）佐证。用户拍板：**全部修复**（P0→P1→P2）。

## 总体判断

拓扑架构合理（meta 存档权威 / gateway 唯一推送面 / commercial 独占钱包 / matchsvc+gameserver 不连库 / X-Internal-Key 统一内部认证），无循环依赖。问题集中四类：

1. **基础设施纪律**：`shared/internalFetch.ts` 头注释记载过「裸 fetch 不 drain body 锁死 undici 池」事故，但 `postInternal` 只覆盖 6 个文件的 `/gw/push` 推送；其余全部内部客户端（meta→commercial 29 方法、admin 15 个 client、worldsvc/auctionsvc/socialsvc 全部）为零超时、零重试、不 drain body 的裸 fetch。
2. **回环与 N+1**：A→B→A 回环、单元素批量调用、循环内逐个 HTTP。
3. **静默降级用错对象**：fire-and-forget / `available` 门控被同时用于「体验」与「钱/资产」，后者造成真实资产丢失。
4. **死代码与契约漂移**：约 20 处死端点/方法/字段；`/internal/save-fields` 契约漂移已致 E8 装备战力在部分攻城路径静默失效。

## P0（正确性 / 资金风险）

| # | 问题 | 关键证据 | 修复 |
|---|---|---|---|
| P0-1 | 排位结算超时矛盾：gameserver 上报 10s < meta judge 等待 20s → hash 不一致局**必然**超时重试；`matches.findOne→settle→insertOne` 非原子 → 二次 `settleElo`（ELO/金币双入账）；重试队列纯内存，重启即丢结算 | `metaReport.ts:85`、`Gateway.ts:29`、`matchReport.ts:89/116/197` | 结算前先原子占位 matches doc（roomId 唯一索引 upsert），重复上报直接幂等返回；ranked 上报超时提至 35s；重试首延迟拉长 |
| P0-2 | `match_found` 生产零投递保障：Redis publish 丢弃订阅者计数（gateway 重启窗口=0 仍视为成功）；唯一 retries=2 长在 prod 不可达的 HTTP 分支 | `matchsvc/gatewayClient.ts:45,59` | publish 返回 0 订阅者时回落 HTTP |
| P0-3 | 拍卖交付「付钱无货」：交付邮件只查 HTTP 200，meta 返 200+`{ok:false}` 不查；`grant*` 回滚不查 `res.ok` → 托管物凭空消失 | `auctionsvc/mailClient.ts:59`、`metaClient.ts:84,113,142`、`mailRoutes.ts:103/109` | 检查 body.ok + postInternal 重试 + 失败落 `pendingDeliveries` 集合供 ops 重放 |
| P0-4 | `claimMail` 把网络错误伪装成 NOT_FOUND，socialsvc 已标 claimed → 附件永久丢失 | `metaserver/socialsvcClient.ts:74-76` | 区分网络错误（503）与业务 NOT_FOUND |
| P0-5 | worldsvc 赛季结算 ≈2 万并发 void 裸 fetch（mail+title），internalFetch 记载事故形态的 500 倍；meta 天梯 roll 逐人串行单发（bulk 端点已存在未用） | `season.ts:243-274`、`ladderSeason.ts:144` | 有界并发 + await + postInternal；能 bulk 则 bulk |
| P0-6 | 部署漏配 6 处（详见下表） | — | 补配 + deploy-config 回归测试 |
| P0-7 | 计费隔离绕过：worldsvc/auctionsvc spend 不传 `clientPlatform` → iOS/Android 从 web 桶扣钱（违 ADR-020） | `worldsvc/commercialClient.ts:33` | 从请求头透传 platform 到 spend |
| P0-8 | meta commercialClient 29 方法零超时（commercial 卡死→GET /save 挂→全服 REST 雪崩）；`await flags.start()` 在 listen 前（admin 黑洞→meta 永不启动） | `commercialClient.ts:248`、`index.ts:71` | 批次A 统一收口；flags.start 移到 listen 后 |
| P0-9 | readJson 1MB guard 内存 bug：reject 后不 destroy、data 继续累积（gateway+matchsvc 同款）→ 可 OOM | `gateway/internalHttp.ts:44-47`、`matchsvc/internalHttp.ts:15-19` | reject 时 req.destroy() |
| P0-10 | judge：pickJudge 固定取第一个可判连接（可串谋）；ticket `ignoreExpiration` 且下游无人查 exp（TTL=30s 是死配置） | `Gateway.ts:458`、`gameserver/index.ts:64` | pickJudge 随机化；首次 join 校验 exp（重连既有槽位豁免） |

**部署漏配明细（P0-6）**：

| 文件 | 缺失 | 后果 |
|---|---|---|
| `docker-compose.prod.yml` worldsvc | `NW_META_INTERNAL_URL` | 编队保存抛 INTERNAL、整季邮件/称号丢、掠夺材料丢、攻城战力空 cardInv |
| `ecosystem.config.cjs` nw-world | 上项 + `NW_COMMERCIAL_INTERNAL_URL` | 再叠加世界发言/建宗门/迁城/商店/加速全部报错 |
| 全部部署文件 worldsvc | `NW_ADMIN_INTERNAL_URL` | SlgShopPriceCache 从不启动，admin 改价面板永久无效且无日志 |
| `docker-compose.local.yml` worldsvc | `NW_SOCIALSVC_INTERNAL_URL` | 本地宗门操作全报 NOT_IN_FAMILY |
| `ecosystem.config.cjs` nw-admin | `NW_WORLD_INTERNAL_URL`、`NW_AUCTION_INTERNAL_URL` | pm2 部署 SLG 运营面全瘫（compose 已修 pm2 漏改） |

## P1（合并 / 优化）

1. **match-identity 合并端点**：gateway 5 处 elo→profile 串行双跳（duel 3 跳）收敛为 `GET /internal/match-identity`。
2. **socialsvc 回环消除**：`profile/extra` 两跳改 `/internal/player?publicId=` 单跳；`resolveByPublicId`+`batchProfiles([1])` 串行模式收敛。
3. **月卡/年卡/starter 购买尾跳**：buy 响应带完整 WalletView，省 `getWallet`。
4. **`GET /save` 钱包 N+1**：`economy.ts:465` getWallet 移出未交付订单循环。
5. **gateway 批量 push**：新增 `/gw/push` 批量形态；socialsvc pushMany/presence 扇出、全服邮件通知改批量；presence 回旋镖（gateway→socialsvc→反问 gateway）消除。
6. **save-fields**：攻守两次拉取并行/批量；worldsvc 调用点字段裁剪；meta 补批量端点。
7. **worldsvc getProfile N+1**：视口 owner、pushTileToObservers 改 batch-profiles + 单次解析复用。
8. **世界频道发言 5 跳**：getProfile/getMember 并行；socialsvc member 端点带回 sectId 消 15 处 `getFamiliesByIds([单元素])`。
9. **bumpActivity+refreshProsperity** 合成单 socialsvc 端点。
10. **admin 双重代理**：promo/paddle/gacha 7 条 ops→admin→meta→commercial 三跳收敛 admin 直连 commercial；catalog（纯 @nw/shared 常量）admin 本地算。

## P2（死代码删除 / 治理）

**计划删除清单（实施结果见下方"实施记录"，部分项目核实/落地时有调整）**：meta `POST /admin/grant-title`、`GET /internal/leaderboard`、`POST /admin/gacha/pools`+commercial `/internal/gacha/pool`+`createLimitedPool`（双层死链）、`GatewayClient.presence/invalidateFriends`、`GET /internal/social/friends` 恒空链+gateway friendsCache 全链+socialsvc 6 次空转 invalidate、`settleSeasonForPlayer` commercial 死参数链、`orderDelivered({refundCoins})`、`/internal/elo` seasonPeakElo、meta `/analytics/*` 501 stub；matchsvc `Matchsvc.cancel`、`/mm/room/start` 三层链、heartbeat `rooms` 字段、`stats().capacity`；gateway `/gw/judge` `defenseJson` 死字段+client `runSiegeJudge` 不可达块；`shared/roomRegistry.ts` 整模块；socialsvc `GET /internal/reports`、`GET /social/player/:id/rank`；auctionsvc `grantMaterial`；admin `/admin/mismatches`、`/admin/suspicious-pve`、`GET+POST /admin/promo/codes` 三层死链。

**实施时的两处偏差**（核实后发现清单本身有误判，均已在"实施记录"和"拍板决策"表中记录）：`/mm/room/start` 三层链和 `Matchsvc.cancel` 中，前者被证实**不是**死代码（`matchsvc.test.ts`/gateway 两个测试文件直接调用验证其 no-op+拒绝语义，删除后破坏 9 个测试，已恢复）；`socialsvc GET /internal/reports` 也**不是**死代码（自身注释记载为合规最小可见性兜底，刻意保留可达但暂无调用方）。其余清单项目均按原计划确认删除。

**治理**：meta `authed()` 透传 `x-internal-caller`（当前审计归因恒 null）；botsvc capacityClient 改 `internalHeaders`（strict 模式下现状会 401）；meta 44 处手写认证改 preHandler；worldsvc 500 响应泄漏内部异常（对齐 auctionsvc 已修的 comm-audit B15）。

## 拍板决策（本轮）

| 项 | 决策 | 理由 |
|---|---|---|
| `/internal/save-fields` 缺 `gear`/`unitLevels` | **删 worldsvc 侧声明与用法**，不补字段 | 引擎侧三字段已 `@deprecated` 且 `runSiegeBattle` 实现不读（`siegeEngine.ts:367-409`）；装备战力走 `equipmentInv`+`toEngineCardInstances` 活路径 |
| worldsvc `/admin/world/patrol`、`/allocate` | **保留不删、不接 UI**（推迟） | 业务代码完整（snake-draft 分区）、测试覆盖，属未上线运营功能，接 ops 前端是 feature 非 fix |
| botsvc 4 个 `/internal/bots/*` | 保留 | compose 注释记载的手动 curl 管理面 |
| botsvc 直调 commercial 月卡（绕收据校验） | 保留 + 注释标记 | 内部端口网络隔离为第一道防线；机器人无真实收据，走 meta 路径不可行；在端点处加注释声明该旁路仅限 botsvc |
| gateway `nw:gw:online:*` presence key 单实例零收益 | 保留 | 2026-07-27 为横扩预留、经用户确认的设计，仅记录成本 |
| 内部响应信封三套并存 | 推迟 | 收敛涉及全部调用方同步改动，风险/收益比差，留独立任务 |
| presence 扇出双份实现（gateway meta 回退版 vs socialsvc 版） | **推迟**（原计划随 P2 一并删，实施时改为推迟） | 触及 gateway+meta+socialsvc 三方调用点，比本轮其它 P2 项侵入面大很多；本轮 P2 只做了单一/双文件的低风险删除，这项留独立任务 |
| socialsvc `GET /internal/reports` | **保留**（原判定死代码，核实后撤销） | 端点自身注释明确记载是"合规最小可见性兜底"（design-doc-audit-2026-07 COMPLIANCE_GLOBAL.md §7）——无调用方是刻意的（尚无运营 UI，靠手动可达性满足合规要求），不是遗留死代码，同 botsvc `/internal/bots/*` 先例 |
| `/gw/judge` `defenseJson` 死字段 + client `runSiegeJudge` 不可达块 | **推迟** | 需要 5 个服务的 proto 重新生成 + 校验，风险/收益比本轮其它项低 |

## 实施记录（2026-07-28 完成）

**已完整实施**：批次 A（内部 HTTP 客户端全量迁移到 `fetchInternalJson`）、批次 B（6 处部署配置漏配修复 + deploy-config lint 扩展 33 例）、批次 C（结算超时矛盾/match_found 投递/judge 随机化/readJson 内存 bug）、批次 D（grant 端点 orderId 去重 + claimMail 回滚）、批次 E（赛季结算有界并发）、批次 G（约 15 项死代码删除，3 项改判保留）、批次 H 的认证 caller 透传 + save-fields 契约清理、批次 F（P1 合并优化，见下）。

**验证方法**：每个批次落地后跑对应包的 `tsc -b` + 该包全量 vitest；批次 G 后额外跑过一次 11 个 server 包的完整交叉测试（因为批次 D 当时误删了 `matchsvc.roomStart()`——审计判断"业务效果是 no-op"没错，但遗漏了 `matchsvc.test.ts`/`gateway-routing.test.ts`/`matchsvcClient.test.ts` 三个测试文件直接调用该方法验证这个 no-op 行为+ 拒绝路径，删方法本身而非只让它"实际不可达"，破坏了 9 个通过中的测试。当时只验证了 metaserver/socialsvc 两个包，未做跨包扫描，隔了一轮才在全量扫描中发现——已在后续提交里逐字恢复。这次踩坑的教训：**任何触及 A 服务但被 B 服务测试直接引用的符号，删除前必须跑 B 服务的测试**，不能只验证改动落地的那个包）。批次 F 沿用同一纪律，10 项落地后跑了一次全部 11 个 server 包（gateway/matchsvc/gameserver/metaserver/commercial/admin/worldsvc/socialsvc/analyticsvc/auctionsvc/botsvc）的完整 vitest，1663 个测试全绿，零回归。

### 批次 F（P1 合并/优化，2026-07-28 完成，独立分支 feat/comm-audit-batch-f）

10 项全部落地。实现前用 3 个探索 agent 重新通读了每一项在当前代码里的真实调用点，发现原文档三处描述与实际代码有出入，经用户逐一拍板后按以下口径执行（详见批次 F 任务记录）：

| # | 项目 | 落地方式 | 备注 |
|---|---|---|---|
| 1 | match-identity 合并端点 | meta `/internal/player` 补 `equippedTitle`/`avatarId`；gateway 新增 `getMatchIdentity()`，替换 5 处 `getElo`+`resolveProfile` 调用 | `handleDuelInvite` 三跳降为两跳（`resolveByPublicId` 查目标 + `getMatchIdentity` 查发起人，两者本就是不同账号，无法再合并） |
| 2 | socialsvc profile/extra 单跳化 | 新增 `getPlayerRankByPublicId`，直接命中 meta `/internal/player?publicId=`，去掉自己的 `resolveByPublicId` 跳 | 原文档说"循环内调用"，实测是两跳链非循环，按实际情况做 |
| 3 | 月卡/年卡/starter 购买尾跳 | commercial 四个 buy/claim 方法响应体加 `wallet: WalletView`；meta 侧优先用 `r.wallet`，缺失（如测试假实现未提供）时仍回退 `getWallet()` | 保留回退分支是关键——若直接假设 wallet 一定存在，会让任何暂未升级的 CommercialClient 实现（测试假对象）静默丢失钱包镜像，已在实现过程中被 3 个 e2e 测试当场验证到 |
| 4 | `GET /save` 钱包 N+1 | `reconcileUndelivered` 循环外只取一次 wallet；`save.ts` 复用其返回值，不再重复调用 | 新增 `clientPlatform` 参数贯穿，避免和 P0-7 的 iOS/Android 计费隔离修复冲突 |
| 5 | gateway 批量 push + presence 回旋镖 | gateway 新增 `POST /gw/push/batch`（`{targets:{accountId,msg}[]}`，进程内循环投递，零新网络跳）；socialsvc `pushMany` 改走它；presence 双循环合并成一次 `pushBatch`；mail 系统通知裸 for 循环同样改批量 | 未引入 Redis（原计划的两条路线之一）——socialsvc 此前完全没有 Redis 依赖，为了省这点跳数新增一条基础设施依赖 + 部署配置的风险收益比更差，选了纯 HTTP 批量端点 |
| 6 | save-fields 裁剪/并行/去死字段 | 端点加 `?fields=cardInv,equipmentInv` 可选投影；`pveUpgrades` 整体从响应里删除（引擎从不读）；worldsvc 9 个调用点按需只请求需要的字段；`encounter.ts`/`arrival.ts` 的攻防两次串行拉取改 `Promise.all` | `arrival.ts` 的 base-siege 分支额外把 defender 快照提前到 `applySiege` 顶部并行获取，下传给 `applyBaseSiege`（原先在里面单独串行拉取） |
| 7 | worldsvc getProfile N+1 | 新增 `WorldMetaClient.batchProfiles`（复用 meta 已有的 `/internal/account/batch-profiles`）；`coreMap.ts` 视口 owner 解析改一次批量；`pushTileToObservers` 提前解析一次 owner profile，`pushTile` 加可选第三参跳过重复 fetch | 其余 16 处单目标 `pushTile` 调用点不受影响（不传第三参，行为不变） |
| 8 | 世界频道 5 跳 + sectId 镜像 | `getMember` 加 `sectId`（socialsvc + worldsvc 双侧接口）；15 处 `getFamiliesByIds([单元素])` 里 14 处消掉；`PlayerWorldDoc` 新增 `sectId` 字段，走跟 `familyId` 相同的 `joinWorld` 一次性快照（SS7 既有决策，非新引入的持续同步） | 剩 1 处（`sectService.ts` 里 `voteRemoveLeader` 查被提名人的宗门）确认无法消——跟当前 accountId 无关，是另一个家族 |
| 9 | bumpActivity+refreshProsperity 合并 | socialsvc 新增 `POST /internal/family/:id/activity-and-prosperity`（一次 `$inc`+重算+`$set`）；worldsvc `bumpFamilyActivity` 先在本地算好 `territoryCount`（独立于 socialsvc 调用），再一次调用合并端点 | 保留原有两个独立端点/方法不删——尚有其它潜在调用方，只加不减 |
| 10 | admin gacha catalog 本地化 | `gachaCatalog()` 直接调 `@nw/shared` 的纯函数 `catalogByCategory()`，删掉 `HttpGachaPoolsClient.catalog()` 整个方法 + 网络调用 | 其余 6 个 promo/paddle/gacha 端点保持 admin→meta→commercial 三跳不变——用户拍板：admin 访问量小，不值得为省这点流量捅破"commercial 只信任 meta"的隔离边界；promo 路由本身未注册（死代码）不在本次范围 |

**踩坑**：item 8 的 sectId 镜像改动波及 9 个 worldsvc 测试文件里的 `FakeSocialsvc.getMember` 假实现——它们各自手写的返回对象没有带上 `sectId` 字段，导致改用本地字段读取后这些测试从"通过"变成"读到 undefined"。逐个补齐后全部恢复通过；教训与批次 G 一致：**改一个被多处测试用假对象实现的接口字段，必须搜出所有实现点一并更新**，不能只改生产代码。

**建议下一步**：批次 F 收尾后本文档可关闭；上表里"推迟"的 3 项（presence 双实现合并、`/gw/judge` proto 清理、内部响应信封统一）如需处理，另开新任务。

## 补充：P0-7 引入的 CORS 回归（2026-07-28 发现并修复）

用户反馈"进不去 SLG"（浏览器 Network 面板 `active-season`/`resolve`/`enter` 全部标红、`Provisional headers are shown`）。排查发现 P0-7 让客户端（`client/src/net/ApiClient/base.ts:78`、`WorldApiClient.ts:183`）在**每个请求**上无条件带上 `X-NW-Platform` 头，但 worldsvc（`httpApi.ts:52`）和 auctionsvc（`httpApi.ts:42`）的 `access-control-allow-headers` 硬编码列表当时没有同步加上 `x-nw-platform`——浏览器跨域预检（OPTIONS）因请求头不在白名单里被拒，真实请求根本发不出去（curl 因不走预检未受影响，直接调用返回一切正常，一度掩盖了问题）。影响面：所有浏览器客户端对 worldsvc（SLG 全部功能）和 auctionsvc（拍卖行）的请求，非单一账号/单次抖动。已在两处 `access-control-allow-headers` 补上 `x-nw-platform`。**教训**：给某个内部请求头新增用途时，要同时检查该请求头会经过哪些走硬编码 CORS 白名单（而非 `@fastify/cors { origin: true }` 动态放行）的裸 HTTP 服务——meta 用 fastify cors 插件不受影响，worldsvc/auctionsvc/socialsvc/analyticsvc/admin 五个手写 `access-control-allow-headers` 的服务都需要人工同步。
