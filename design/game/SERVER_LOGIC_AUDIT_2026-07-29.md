# 服务器逻辑全面审计（server-logic-audit-2026-07-29）

> 与前两轮的区别：2026-07-27 审计的是 Mongo/Redis 存储方式，2026-07-28 审计的是**服务与服务之间**的通信协议；本轮审计**单进程内部的业务逻辑本身**——算法复杂度/内存管理/数据结构设计/输入校验健壮性/单进程容错。4 个分组并行覆盖 11 个进程 + shared/engine，结论均以真实代码位置（文件:行）佐证，高危项额外人工核实。用户拍板：**按严重程度顺序全部修复**。

## 总体判断

存储/一致性维度问题最集中，尤其"先落权威状态、再执行副作用"的两步写模式在 commercial/worldsvc/socialsvc 反复出现——这跟前两轮不同：那两轮解决的是索引/超时/部署配置这类"接得上但没接对"的问题，这轮暴露的更多是**业务逻辑本身缺乏原子性保护**。已修复项均补了对应回归测试（新增 e2e/单测），13 个 server 包 `tsc -b` 全绿，各包 vitest 全绿。

## 已修复

| # | 问题 | 位置 | 修复 | 严重度 |
|---|---|---|---|---|
| 1 | 装备可同时装到两张卡上等价复制战力：`equipEquipment` 从不调用项目自己写好的 `isEquipped()` 占用检查 | `metaserver/src/equipment.ts:814` | 装备前校验 instanceId 是否已被另一张卡占用 | 高 |
| 2 | commercial 多处"先落地已发放记录、再执行 credit 副作用"：崩溃发生在两步之间会让玩家钱永久丢失且无法重放补发（rechargeVerify/paddleComplete/promoRedeem/orderDelivered/subscriptionCardBuy/starterBuy growth 共 6 处） | `commercial/src/service/{recharge,promo,orders,base,starter}.ts` | 引入 `isStaleClaim` 宽限窗口（15s）：窗口内维持原样（避免与真正的并发赢家抢跑），窗口外按 ledger/order 状态验证并补发（verify-and-heal，与 equipment.ts 既有风格一致） | 高 |
| 3 | commercial 数值校验缺口：`num()` 只查 typeof 不查 finite（JSON `1e400` 会静默 overflow 成 Infinity）；`paddleComplete` 完全没做非负校验；`rewards.ts`/`shop.ts` 的 `Math.max(0,Math.floor(x))` 对 Infinity 失效 | `commercial/src/{internalHttp,service/recharge,service/rewards,service/shop}.ts` | 补 `Number.isFinite` 校验；internalHttp 顶层 catch 不再把第三方支付渠道原始错误回显给调用方 | 高 |
| 4 | worldsvc 行军出兵/占领扣兵是 check-then-act：并发双发可把 troops 打成负数 | `worldsvc/src/{combatMarch,territory}.ts` | 参照 `city.ts` 训练花费已用的 `findOneAndUpdate({troops:{$gte:cost}})` 原子写法改造 startMarch/occupyTile | 高 |
| 5 | gateway/gameserver 的 `WebSocketServer` 均未设置 `maxPayload`，认证后连接可发近 100MB 帧 | `gateway/src/Gateway.ts`、`gameserver/src/index.ts` | 补 1MB `maxPayload` | 高 |
| 6 | socialsvc CORS 头漏了 `x-nw-platform`（worldsvc/auctionsvc 已在 07-28 补过，socialsvc 被漏），client 全请求带这个头会被浏览器预检拒绝 | `socialsvc/src/httpApi.ts` | 补头 + 回归测试 | 高 |
| 7 | analyticsvc 埋点 `ts` 字段无边界校验：客户端可设未来值永久绕开 90 天 TTL，或设过去/负值污染按天聚合 | `analyticsvc/src/service.ts` | `clampEventTs`：超出 [-24h,+5min] 窗口回退服务器时间 | 高 |
| 8 | admin `loginAttempts` 以攻击者可控的 username 为 key，只在登录成功时删除 | `admin/src/service/{base,auth}.ts` | `maybeSweepLoginAttempts`（piggyback 在正常登录流量上，同 metaserver `SlidingRateLimiter.maybeSweep` 套路） | 高 |
| 9 | `getSave`（最高频端点）多处可并行的独立读写成顺序 await；admin `analyticsSummary` 对每个 metric 各跑一次不限量 `find().toArray()` 再手动 reduce | `metaserver/src/service/save.ts`、`admin/src/service/analytics.ts` | Promise.all 并行化四个独立读；`analyticsSummary` 改单次 `$group` 聚合 | 中 |
| 10 | 4 处无界内存增长：gateway `friendsCache`/`publicIdCache`（socialsvc 降级路径专用，从不清理）、socialsvc `chatRate`、metaserver `accountCache.TtlMap`、gameserver `Room.pending`（单 tick 内无上限，洪水攻击可撑大 replay） | `gateway/src/Gateway.ts`、`socialsvc/src/friendService.ts`、`metaserver/src/accountCache.ts`、`gameserver/src/Room.ts` | 前三者补 sweep-on-traffic（同 `SlidingRateLimiter.maybeSweep` 套路）/断线清理；Room 补 `MAX_PENDING_PER_TICK=200` | 中 |
| 11 | socialsvc `leaveFamily`/`kickMember` 并发双发会重复 `$inc memberCount:-1`（同一成员被删两次判定，实际只删一次）；worldsvc `resetSeason` 未清理 ADR-051 的 `occ`/`cover` Redis 索引；auctionsvc `scanAnomalies` 的 5000 条上限无排序无告警，可静默漏检最近成交 | `socialsvc/src/familyService.ts`、`worldsvc/src/{corePush,season}.ts`、`auctionsvc/src/auctionService.ts` | deleteOne 的 `deletedCount` 门控 decrement；`WorldCorePush.clearSpatialIndexes`；`scanAnomalies` 按 soldAt desc 排序（新索引）+ 命中上限时告警 | 中 |
| 12 | socialsvc/analyticsvc/botsvc/commercial 内部端口的 `readJson` 超 1MB 只 reject 不 `destroy()`（同一 bug 07-28 只修了 gateway/matchsvc）；auctionsvc `createAuction` 的 qty 未强制整数；admin `retryTicket` 无原子 claim，并发点击可重复触发 `mail.send` | 各文件 `httpApi.ts`/`internalHttp.ts`、`auctionsvc/src/{httpApi,auctionService}.ts`、`admin/src/service/tickets.ts` | 补 `req.destroy()`；qty 校验改 `Number.isInteger`；`retryTicket` 补 `retryLockedAt` CAS（mirrors approveTicket 既有的状态 CAS） | 中 |

## 尝试后回退

**`decompressReplayDoc` 异步化**：`matchReport.ts` 的 `accruePvpCardStats` 是唯一在**每场**非争议排位赛都跑的同步 gunzip 调用点（另两处——peer-judge/anti-cheat 采样——均已注释说明"rare/periodic path, fine"，保留不动）。改成异步 `zlib.gunzip` 后 `test/pvp-card-stats.e2e.test.ts` 立即失败：该测试隐含假设这条 fire-and-forget 链路在 `/internal/match/report` 返回后"足够快"完成（同步 decompress 恰好没有真正的调度间隙，异步版本引入了 libuv 线程池的真实调度间隙，导致断言在链路完成前就跑了）。已回退到同步版本；这暴露了一个更深的问题——该数据管道本身依赖"近乎同步"完成的隐含时序假设，而不是真正的最终一致性容忍——留作独立任务（连带修测试改成 poll，或引入其它非阻塞机制）。

## 已知但本轮未处理（严重度较低或需要更大改动，非本轮范围）

- **matchsvc 赛前状态**（好友房间/排位队列/切磋邀请）纯内存态，进程重启即丢，且无主动通知客户端的机制——只有配对成功后才有 Redis 兜底。修复需要引入持久化或至少一个"进程重启后主动踢出等待中连接"的机制，属于设计改动而非局部修复。
- **worldsvc `getMarches`/`getStationed`** 每个在线玩家 5s 轮询都拉全服在途行军/驻防；`computeMarchPath` 每次行军做 3 次缺索引支撑的近全表扫描。结构性开销，需要重新设计查询模式（如按视野裁剪 + 补索引），非局部修复。
- **worldsvc `siegeEngine`** 势均力敌的攻城战同步跑满额引擎 tick，阻塞事件循环；`shouldUseCheapSiege` 已覆盖大部分悬殊战斗，剩余部分需要 worker 线程或分片计算才能根治。
- **admin 四眼审批例外**：具 `admin.manage` 权限者可临时 disable 其他审批人后自批——策略决策，非 bug。
- **`shared/dailyCounter.ts` 的 `LocalBackend.expire()`**：注释假设 Redis 只是"短暂降级"，若长期不可用会无界增长；概率低（生产 Redis 未观察到长期故障历史），留观察。

> **第 4 条（gateway 控制消息无 per-connection 限流）已于 2026-07-29 同日追加任务补齐**：`RateLimiter`/`SlidingRateLimiter`/`RedisSlidingRateLimiter`/`createRateLimiter` 从 metaserver 搬到 `@nw/shared`；gateway `handle()` 按消息类型分两档限流（TIGHT 10/min 管 room_create/room_join/duel_invite，STANDARD 20/min 管 duel_respond/room_ready/room_leave/room_start，均以 accountId 为 key，ping/client_caps/judge_verdict 不限）；无 Redis 时退化为内存限流器，配了 `NW_GW_REDIS_URL` 则升级为跨实例精确的 Redis 版；命中限流复用 `duel_cancelled`/`room_error` 显式反馈客户端，不静默丢弃。详见 [`claudedocs/server.md`](../../claudedocs/server.md) "gateway 控制消息 per-connection 限流补齐" 一节。

## 验证

13 个 server 包 `tsc -b` 全绿；改动涉及的 10 个包（metaserver/commercial/worldsvc/gateway/gameserver/socialsvc/analyticsvc/admin/auctionsvc/botsvc）vitest 全绿（新增回归测试均已计入下方计数，未改动的 matchsvc/contracts 未重跑）：

| 包 | 测试数（含新增） |
|---|---|
| metaserver | 731（+2 跳过，与本轮无关） |
| commercial | 144 |
| worldsvc | 350 |
| gateway | 27（+6 跳过，需真实 Redis） |
| gameserver | 58 |
| socialsvc | 78 |
| analyticsvc | 25 |
| admin | 45 |
| auctionsvc | 77 |
| botsvc | 40 |
