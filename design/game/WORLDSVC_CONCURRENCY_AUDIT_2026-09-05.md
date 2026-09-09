# worldsvc SLG 并发瓶颈审计与整改（worldsvc-concurrency-2026-09-05）

> 触发：玩家实测「一个人连发 5 个队伍去打地块，第 5 条指令有肉眼可见的延迟」。担心 100 人同时在 SLG 里发指令会彻底爆炸。
>
> **目标**：至少支撑 **200 名同时在线的活跃玩家**，每人激战时约每 2~3 秒发一条指令 → **约 80 条指令/秒**，外加约 40 次/秒的地图轮询。
>
> 前三轮审计的分工：2026-07-27 存储方式、2026-07-28 服务间通信、2026-07-29 单进程业务逻辑。本轮只看一件事——**worldsvc 在真实并发下的吞吐与尾延迟**。

## 总体判断

**worldsvc 没有锁竞争问题**（全仓 `grep` 无 mutex / semaphore / 显式串行化）。真正的病因是 Node 单线程事件循环被**同步 CPU 计算**长时间占死（head-of-line blocking）：一次不可达寻路能让整个进程冻结 **2~6 秒**，期间所有玩家的 HTTP、所有 Mongo/Redis 回调、scheduler tick 全部排队。

这解释了用户的观察——**它跟并发量无关，一个人就能触发**；连发 5 条指令时，第 5 条的延迟 = 前 4 条 A\* 耗时之和 + 自己的。

## 一、实测：A\* 寻路是首要元凶

`findMarchPath`（`shared/src/slg/march.ts:67`）是纯同步 A\*，`MAX_NODES = 500_000`（`march.ts:96`）。在真实 1500×1500 地图 + `s1-0` seed 上随机取点各跑 40 次：

| 直线距离 | 平均 | p50 | p90 | 最坏 | 不可达比例 |
|---|---|---|---|---|---|
| 3 | 0.2ms | 0.1ms | 0.4ms | 1.2ms | 1/40 |
| 10 | 0.2ms | 0.2ms | 0.3ms | 0.6ms | 2/40 |
| **30** | **312ms** | 0.4ms | 1295ms | **5885ms** | 7/40 |
| **60** | **255ms** | 1.0ms | 133ms | **5124ms** | 3/40 |
| **120** | **553ms** | 2.0ms | 2303ms | 3076ms | 18/40 |
| 250 | 673ms | 589ms | 1623ms | 2242ms | 26/40 |

（另测：`proceduralTile` 单次 1.14µs；`getMap` r=40 的 JSON 序列化 1.0ms / 528KB。）

**最坏情况全部来自「目标不可达」**：河流/山脉环把地图切开，bridge/plankway 只有己方占领后才可通行，所以「看着不远但过不去」极其常见（d≥120 时超过一半）。这时 A\* 必须烧满 50 万节点才能返回 `PATH_BLOCKED`。

**预算对比**：80 条/秒 意味着单核 100% 也只有 **12.5ms/条** 的 CPU 预算。光 A\* 平均就要 300ms+，**差 25~500 倍**。

更糟的是 `startReturnMarch`（`worldsvc/src/combatShared.ts:177`）同样调 `computeMarchPath`，而它被 10 处攻城结算调用 —— 即 **scheduler tick 里也会跑 A\***，一批攻城同时结算能让进程冻结数秒。

## 二、其余瓶颈（按严重度）

### P0-2 单条指令约 20 次串行往返，其中 3 次跨服务 HTTP

`startMarch`（`worldsvc/src/combatMarch/command.ts:27`）几乎全程串行 `await`：

- `meta.getSaveFields`（`command.ts:127`）→ metaserver HTTP，在热路径上
- `validateMarchTarget` → `isConnectedToSectTerritory`（`core/vision.ts:258`）→ `ownSectFamilyIds` → **socialsvc HTTP** + 全宗门 playerWorld 扫描
- `computeMarchPath` 内部再读一次 playerWorld（同一份文档一条指令里被读 3 次）
- `visionObservers`（`core/vision.ts:166`）：按整条路径的包围盒 + `VISION_MAX_RADIUS` 拉 tiles，**无 projection、无 `ownerId` 过滤**，再做 O(tiles × path) 的 JS 双层循环
- `meta.getProfile` 又一次 HTTP（under_attack 推送）

### P0-3 scheduler 是严格串行循环，每步 6~7 次往返

`processDueArrivals`（`worldsvc/src/combatMarch/arrival.ts:27`）→ `advanceMarch`（`arrival.ts:71`）：对每条到期行军串行做 `findOne(march)` + `findOne(playerWorld)`，每走一格再 `clearOccupancy` + `getOccupancy` + `getCover` + `setOccupancy` + `updateOne`。

`MARCH_SPEED_SEC_PER_TILE = 6`，200 人 × 约 3 支在途队伍 ≈ 600 条行军 → **约 100 步/秒 → 约 700 次 Redis/Mongo 往返/秒，全部严格串行在一个 for 循环里**。2s 的 tick 吃不下。`.limit(500)`（`arrival.ts:43`）会在追不上时**静默截断**，行军晚点到达且无任何告警。

5 个 scheduler 任务还共用一个 `running` 守卫（`worldsvc/src/scheduler.ts`），任一慢任务顶掉整个下一 tick。

### P0-4 单进程，无水平扩展

`docker/docker-compose.local.yml` 只有 1 个 worldsvc；代码注释明确写着 "worldsvc single-consumer (U12)"。

### P1 地图轮询开销

客户端约 5s 拉一次地图，200 人 = 40 次/秒。`getMap`（`worldsvc/src/core/map.ts:33`）`r` 上限 40 → 81×81 = 6561 格/次；`familyMemberIds` / `sectMateMemberIds` / `allySectMemberIds` **各自重读同一份 playerWorld 并各自打一次 socialsvc**；payload 实测 528KB → 约 21MB/s 出口。

### P1 无可观测性、无背压

没有事件循环延迟指标、没有单路由耗时、没有单账号限流。出问题只能靠「感觉延迟」。

## 三、整改方案（按顺序实施）

### 阶段 0：先能看见

- `perf_hooks.monitorEventLoopDelay` 暴露事件循环延迟；单次同步阻塞超阈值打日志。
- 每个路由的耗时直方图（p50/p90/p99/max），挂进 heartbeat 输出。
- 用现成的 `botsvc`（`botsvc/src/worldClient.ts` 已能打 `/world/march`）造负载复现，作为后续每一步的回归基准。

**没有这一步，后面每条改动都是盲调。**

### 阶段 1：把 CPU 挪出事件循环

1. **A\* 进通用计算池**：`siegeWorkerPool.ts` 已经为一模一样的理由把战斗引擎挪出去（SERVER_LOGIC_AUDIT_2026-07-29 第 15 条）。泛化成通用计算池，`findMarchPath` 是纯函数，直接提交。
2. **连通分量预过滤（根治最坏情况）**：地形程序化生成、每世界固定。对全图做一次 flood-fill 得到连通分量（bridge/plankway 视作分量之间的「闸门」，按请求者拥有的渡口开合）。于是「能不能到」变成 O(1) 判断——**不同分量且无开放闸门相连 → 直接 `PATH_BLOCKED`，根本不跑 A\***。
   这是**保守的必要条件**：分量说「不可达」一定不可达（可安全短路）；说「可能可达」再跑 A\*（敌方主城/阻挡建筑只会让可达性更差，不影响判定的安全性）。
3. **地形分类查表**：同一份预计算顺带把 `walkable()` 里的 `proceduralTile()` 调用换成 `Uint8Array` 下标读——A\* 每展开一格最多调 4 次，这是它剩下的主要成本。
4. **`MAX_NODES` 改为可配置，但默认值不动**（见下方「实施记录」——原计划要下调，实测后否决）。

### 阶段 2：削掉单指令的往返次数

- playerWorld 读一次往下传。
- 家族/宗门成员集合做进程内短 TTL 缓存，按 join/leave 失效。代码本来就接受 `familyId` 是 joinWorld 时的镜像快照，缓存不引入新语义问题。同时救 `startMarch` 和 `getMap`。
- `visionObservers` 加 `ownerId: {$exists:true}` + projection。
- 相互独立的读用 `Promise.all` 并起来。

### 阶段 3：scheduler 批处理

- 5 个任务拆成各自的 interval + 各自的 running 守卫。
- 一个 tick 内：一次 query 拉全部到期行军 → **一次** query 批量拉 playerWorld → Redis pipeline 批量做 occupancy/cover → Mongo `bulkWrite` 批量更新。从 `7 × N` 次往返压到每 tick 常数次。
- 行军处理改成分块并发（复用 `@nw/shared` 的 `runBounded`）。
- 批处理后放开 `limit`，触顶时告警。

### 阶段 4：水平扩展（本轮只留口子，不实施）

每条查询都已按 `worldId` 分区，nginx 按 worldId 路由到 N 个 worldsvc 实例是可行的；唯一的设计工作是 **scheduler 必须每 world 单一 owner**（Redis 租约锁）。

**用户拍板（2026-09-05）：本轮只留接口口子，等玩家多了之后单独做一个「计算服务」来集中处理 CPU 密集计算。** 因此阶段 1 的计算池必须做成**可替换的后端接口**：

```
ComputeBackend        ← 接口：runSiege / findPath / warmup
├── WorkerPoolBackend ← 本轮实现（进程内 worker_threads）
└── RemoteBackend     ← 后期实现（HTTP/gRPC 打到独立计算服务）
```

调用方只认接口，将来把 `NW_COMPUTE_BACKEND=remote` 一开就切过去，业务代码零改动。

### 做完阶段 1~3 之后的预算核算

| 项目 | 主线程 CPU |
|---|---|
| 80 指令/秒 × 约 1.5ms | 约 12% 单核 |
| 40 地图轮询/秒 × 约 10ms | 约 40% 单核 |
| scheduler 批处理后 | 每 2s tick 约 5~10ms |

**一个进程装得下 200 人。** 阶段 4 面向 1000+。

---

## 四、实施记录（2026-09-05）

分支 `feat/worldsvc-concurrency`。**方案与实现有三处出入，都是实测后主动改的，记在这里而不是悄悄照做**：

### 出入 1：`MAX_NODES` 默认值没有下调

原计划「从 500k 降到与行军半径匹配的量级」。实测后否决：下调**会改变哪些行军被判 `PATH_BLOCKED`**，是玩法改动而不是性能改动。真正吃掉最坏情况的是连通分量预过滤（它把「不可达」变成 O(1)，A\* 根本不跑），所以节点上界只需要留作正确性兜底。改成 `DEFAULT_PATH_MAX_NODES` 常量 + `FindMarchPathOptions.maxNodes` 可覆盖，默认值原样保留。

### 出入 2：scheduler 只做了拆分与告警，没做深度批处理

原计划里的「Redis pipeline + `bulkWrite` + 分块并发」**没做**，理由：

- `advanceMarch` 的野战遭遇会同时改**防守方**的 `cardState`/兵力池与其驻防文档。跨玩家并发处理会引入现在不存在的竞态，而这段代码的注释史表明它已经被并发 bug 咬过好几次。没有把握就不该动。
- 实测下这不是当前瓶颈：约 100 步/秒 × 7 次本地 Redis 往返 ≈ 每秒 140ms 串行时间，约 14% 占空比。真正的危机是事件循环被同步 CPU 堵死，那个已经由阶段 1 解决。

已做的是：**5 个任务拆成各自的 interval + 各自的 running 守卫**（原来共用一个，最慢的任务决定所有任务的节奏）、每个任务单独计时并在超出自身 interval 时告警、到期扫描上限改为 `NW_SLG_ARRIVAL_SCAN_LIMIT` 可配置并在触顶时告警（此前是静默截断）。深度批处理留作下一个杠杆，**前提是阶段 0 的指标真的指向它**。

> **后续（同日第三轮）**：指标确实指向了它（第五节 5.4 ①），深度批处理已经做了——但**没有**按原计划做「分块并发」。见第六节：并发那一半仍然被否决，理由和这里写的一模一样；真正拿到收益的是把「这一 tick 打不起来的行军」批量处理掉。

### 出入 3：路径缓存没做

预过滤 + 查表把典型指令的寻路降到约 2ms，缓存的收益不再显著，而缓存键必须包含「闸门集合指纹」才正确——复杂度换不到对应的收益。留作后续可选项。

### 实测结果（1500×1500，`s1-0` seed）

- 索引构建：约 2.3s/世界，得到 **20 个连通分量、75 个渡口格**；内存约 6.75MB/世界/worker（LRU 上限 4 个世界）。
- **预过滤命中率 100%**：随机取点各 40 次，`blocked` 与 `prefiltered` 在 d=30/60/120/250 四档上完全相等——**每一次原本要烧 2~6 秒的「不可达」判定，现在是 0.0ms**。且从未误判（`mapTerrainIndex.test.ts` 用真实地图把「A\* 能到的目标绝不被判不可达」这条安全性质钉死）。
- 可达情况下 A\* 本身快约 4~5 倍（查表 + 无分配二叉堆）。
- 这些工作现在跑在 worker 线程上，主线程完全不参与。

### 阶段 4 的口子（本轮只留接口）

```
worldsvc/src/compute/
  types.ts       ComputeBackend 接口（runSiege / findPath / warmWorld / close）+ 网络形状的 PathRequest
  pool.ts        ComputeWorkerPool —— 进程内 worker_threads 实现（由 siegeWorkerPool.ts 泛化而来）
  worker.ts      worker 入口，按 job.kind 分发
  pathRunner.ts  寻路计算本体（无 worker/DB 依赖，将来独立服务原样复用）
  remote.ts      独立计算服务的实现位 + 端点契约；未实现，选中即报错
  index.ts       getComputeBackend()：NW_COMPUTE_BACKEND=worker(默认)|remote
```

业务代码只认 `ComputeBackend`。`remote.ts` 里已经写好了那个服务要满足的端点契约和三条注意事项（引擎版本必须与 worldsvc 对齐、地形索引需要 warm + 按 world 粘性路由、计算服务挂掉要能退回本地池）。

### 验证

`tsc -b` 全 13 个 workspace 绿 + 两个 `typecheck:test`；server 全量 eslint；file-length / bundle-size / workspace-coverage / absolute-writes 四道门禁；客户端 `tsc --noEmit` + webpack `build:web`。测试：**worldsvc 107 文件 / 1345 用例全绿**（真 Mongo，走 worldsvc 自己的 vitest config + `mongodb-memory-server` rs0）、**shared 58 文件 / 1187 用例全绿**。新增测试：`shared/test/mapTerrainIndex.test.ts`（等价性 + 安全性质）、`shared/test/perfMetrics.test.ts`、`worldsvc/test/compute-path-runner.test.ts`、`worldsvc/test/compute-backend-selection.test.ts`、`worldsvc/test/socialsvc-client-membership-cache.test.ts`；改写 `worldsvc/test/scheduler.test.ts`（每任务独立守卫）、`computePool.test.ts`、`compute-worker-module-graph.test.ts`。

### 还没做的（下一个杠杆，按顺序）

1. ~~用 botsvc 造 200 bot 的真实负载测试~~ → **已做，见下面第五节。**
2. ~~**`sched:arrivals` 深度批处理**~~ → **已做，见第六节。**
3. `getMap` 的 **payload 本身**（40 次/秒 × 6561 格 × 528KB ≈ 21MB/s 出口）。往返侧已经削过了：成员集合的 3 次 socialsvc 往返进了缓存，`familyMemberIds`/`sectMateMemberIds`/`allySectMemberIds`/`computeVisionSources` 原本**各自重读同一份 playerWorld** 且串行执行，现在读一次、四个并发。剩下的是 payload 大小本身（缩小默认半径 / 更多走 sparse / 增量 diff），没动。
4. A\* 的 `g`/`par`/`closed` 从 `Map`/`Set` 换成带代际标记的 typed array scratch buffer——只在长距离行军真的占主导时才值得。

---

## 五、真实负载测试与 CI 门禁（2026-09-05 当日追加）

用户要求：「写一个并发测试放进 CI，这样以后不会被改坏；本地用 docker 开服务器，造 200 bot 测试。」两件事分别落地，**因为它们要回答的不是同一个问题**。

### 5.1 CI 门禁：`worldsvc/test/march-dispatch-concurrency.e2e.test.ts`

普通 e2e，落在 CI 已有的 worldsvc 分片里（`test/**/*.test.ts`），**不需要改 `ci.yml`**。它守的是**性质**而不是吞吐数字：

| 用例 | 守什么 |
|---|---|
| 源码门禁 | 派发路径必须经 `getComputeBackend()`，`combatShared.ts` 里不得再出现 `findMarchPath(` 调用 |
| 后端契约 | 选中的 backend 必须有 `findPath`/`warmWorld`——阶段 4 换远程服务时调用点不会静默丢失 |
| **不可达目标** | 事件循环停顿 < 400ms（旧代码这里是 2~6 秒） |
| **并发长距离寻路** | 同上，12 条 40~150 格的腿并发 |
| 并发派发 | 12 个玩家同时下令全部成功、不串行化 |

**变异验证做了两轮**，两轮都改出了真问题：

1. 第一轮把同步调用改回去，**只有源码门禁红了**，两个行为门禁全绿——原因是 `LoopProbe` 用 `setInterval` 计时，而同步块结束后 Node **先排空微任务（也就是 await 的续体）再跑定时器**，于是 `stop()` 先执行、清掉了那个本该记录多秒间隔的 tick。**探针恰好在循环被冻住的时候报告「循环很空闲」。** 修法：`stop()` 里补记一次「距上次 tick 的时间」。
2. 修完再变异一次：不可达用例报 **2895ms / 2691ms**，长距离批量用例报 **9816ms / 11488ms**，全部对着 400ms 的预算炸开。

**教训：并发/时序门禁必须做变异验证。** 一个测不出回归的时序断言看起来和一个通过的断言一模一样。

另外「12 个玩家并发占领」这条在变异下**仍然是绿的**（腿只有 2 格，同步跑也便宜）——这条已写进用例注释，免得后人以为三条都在守停顿。

### 5.2 本地负载测试：`worldsvc/test/load/slgOrders.load.ts`

独立 config（`vitest.load.config.ts`）+ `npm run test:load -w @nw/worldsvc`，**不进 CI**（需要活的集群）。200 个真实 REST 客户端：设备登录 → 加入赛季 → 按每 2.5s 一条的节奏猛发 `POST /world/march`。

关键设计：它会读 worldsvc **自己的** `/admin/world/metrics`（本轮新增的内部端点）。从客户端看，「事件循环被堵死」和「服务器只是忙」长得一模一样——`loopLagMs.max` 是唯一能分开这两者的数字。

### 5.3 实测结果（200 bot，47s 窗口，本机 docker 全栈）

```
window 47494ms | orders 3589 (75.6/s) | accepted 2000 | out-of-troops 1586
客户端派发延迟   p50  33ms  p90  55ms  p99  94ms  max 124ms
worldsvc 侧 POST /world/march   p50 5.9ms  p90 11.3ms  p99 15.2ms  max 17.7ms
worldsvc loopLagMs.max          28.9ms      ← 事件循环全程没有停顿
```

**目标达成**：200 人 × 每 2.5s 一条 = 约 80 条/秒，实测消化 75.6 条/秒（差额是客户端自身的节奏，不是服务器拒绝），服务端 p99 15.2ms，**事件循环最大停顿 28.9ms**。

阶段 3 的告警也在真实负载下验证过了：`[world-scheduler] sched:arrivals took 6705ms, longer than its 2000ms interval` 共触发 30 次。

### 5.4 负载测试暴露的三个新问题

**① `sched:arrivals` 是新的第一瓶颈（p50 1761ms / p90 6705ms）。** 出入 2 里推迟的深度批处理，现在有实测依据了：3589 条占领令产生的行军把到期扫描压成每 tick 数秒，远超它 2s 的 interval。请求面已经健康，**下一刀应该切在这里**。注意它**不阻塞事件循环**（全是 await 的 I/O），后果是行军晚点结算，不是全服卡顿。

**② 本地 nginx 才是客户端看到的秒级延迟来源，不是 worldsvc。** 同一批 bot、同一个窗口，只换路由：

```
经 nginx (:8088)       p50 398ms  p90 4407ms  p99 7870ms  max 8945ms
直连 worldsvc (:18084)  p50  33ms  p90   53ms  p99   94ms  max  124ms
```

而两轮里 worldsvc 自己的 `POST /world/march` 都是 p50 约 6ms / p99 约 16ms。原因：`client/nginx.conf` 写了 `proxy_http_version 1.1` 但**没有 `upstream { keepalive }`**，于是每个代理请求都新开一条到上游的 TCP 连接。**这是本地栈的问题，生产用的是 Caddy**（`server/Caddyfile`，默认复用上游连接），所以没有改 nginx，只把负载测试默认直连 worldsvc 并把这段测量写进用例头注释。谁要动本地栈，这里有现成的数字。

**③ 计算池默认大小按核数开太大了，内存代价现在是真的。** `cpus - 1` 是 worker **无状态**（只跑攻城战）时定的；寻路让每个 worker 各自缓存一份地形索引（1500×1500 下每世界约 6.75MB，且 worker 之间不共享堆）。本机 22 核实测，warm 一个世界：

```
21 workers → RSS 586MB      4 workers → RSS 239MB
```

约 20MB/worker，而预算测算说整个稳态寻路负载只占一个核的零头。已把默认值加上上限 `min(cpus - 1, 8)`（`NW_COMPUTE_POOL_SIZE` 可覆盖），本机复测 **RSS 450MB**。

### 5.5 顺带新增

- **`GET /admin/world/metrics`**（内部端口，X-Internal-Key）：事件循环延迟 + 每路由/每 scheduler 任务的 p50/p90/p99 + 计算后端名 + RSS。**非破坏性读取**（`peek`），所以运维随便轮询都不会把 heartbeat 的窗口偷空——这条不对称是 `worldsvc/src/metrics.ts` 单独存在的全部理由。
- `docker/docker-compose.local.yml` 把 worldsvc 的 18084 发布到宿主（**仅本地**；nginx 故意不代理 `/admin/world/*`，prod/cloud compose 未动）。

---

## 六、`sched:arrivals` 深度批处理（2026-09-05 当日第三轮）

分支 `feat/arrivals-batching`。这是第五节 5.4 ① 点名的那一刀：负载测试把 `sched:arrivals` 从「推测的下一个杠杆」变成了**实测第一瓶颈**（p50 1761ms / p90 6705ms，对着它自己 2s 的 interval，30 次超时告警）。

### 6.1 先说没做什么：仍然不并发

出入 2 里推迟它的理由**一个字都没有改**：`advanceMarch` 里的野战遭遇（`resolveFieldEncounter`）会写**防守方**的账本——对方的 `cardState`、对方的 `StationedDoc`/`MarchDoc`。两条行军并发结算就是两个写者同时改一个陌生玩家的文档，而 `arrival.ts` 的注释史表明这段代码已经被更窄版本的同类竞态咬过好几次。

所以本轮**没有引入任何并发**，`runBounded` 分块并发那条原计划继续搁置。真正的观察是另一条：

> 瓶颈不是「结算太慢」，是「**为一件根本不会发生的事付了全套代价**」。

`MARCH_SPEED_SEC_PER_TILE = 6`，tick 是 2s。绝大多数到期行军这一 tick 只是在空地上往前挪一格：没有到达结算、没有遭遇、没有拦截。旧代码却给每一条都付了：重读自己的 march 文档、读整份 playerWorld、每格 `clearOccupancy` + `getOccupancy` + `getCover` + `setOccupancy`、再写一次游标——约 7 次严格串行往返。

### 6.2 做法：按「这一 tick 能不能打起来」切两半

`combatMarch/arrivalBatch.ts`（新文件）先做一次**纯函数的行程规划**（`planMarchSteps`：不做任何 I/O，只从游标和时钟推出这一 tick 会进入/离开哪些格子），然后一次批量读（一次投影过的 playerWorld 查询 + 每个世界各一次 occ/cover 的 `HMGET`），再按四条规则分流：

一条行军进 **fast**（批处理），当且仅当：

1. 这一 tick **不到终点**——到达结算要打仗、要停驻、要写地块，全部留给原路径；
2. 进入的每一格 **occ 为空**（有人就可能遭遇；**友军也算**——原路径遇到友军会 `skipOwnOcc` 保留对方的条目，批处理会盖掉，语义不同就不批）；
3. 进入的每一格 **cover 为空**（箭塔穿透伤害 / 驻防 3×3 拦截）；
4. 这一 tick 里**没有第二条行军碰到它的任何一格**（进入的和离开的都算，包括 legacy/return 行军的落点）。

其余全部进 **serial**，走**一行没改**的 `advanceMarch`/`applyArrival`。

第 4 条故意做得很粗：只要同一 tick 内两条行军的格子集合有交集，两条都降级。「谁踩到谁」正是遭遇的形状，而 fast 路径存在的前提就是不必回答这个问题；更聪明的规则得推理 tick 内的先后顺序，那正是这段代码历史上被咬的方式。1500×1500 的图上几百条行军，撞格子是罕见事件，粗规则几乎不花钱。

### 6.3 批处理这一半的成本

occ 和 cover 各是**每个世界一个 Redis hash、field = tileId**——这个结构本身就是能批的全部原因：

| | 旧（每条行军） | 新（整个 tick） |
|---|---|---|
| march 重读 | 1 次 `findOne` | 0（批量 `bulkWrite` 的过滤器自带守卫） |
| playerWorld | 1 次整份 `findOne` | **1 次** `find({_id:{$in}})`，投影只取 `familyId` |
| occ 读 | 每格 1 次 `HGET` | **1 次** `HMGET` |
| cover 读 | 每格 1 次 `HGET` | **1 次** `HMGET` |
| occ 清 | 每格 1 次 `HGET`+`HDEL` | **1 次** `EVAL`（服务端逐 field 校验 `.id` 再删） |
| occ 写 | 每格 1 次 `HSET` | **1 次** `HSET`（多 field） |
| 游标写 | 每条 1 次 `updateOne` | **1 次** `bulkWrite` |

几个刻意的取舍：

- **playerWorld 只投影 `familyId`。** fast 路径只需要它（写 occ 条目时的敌我标记），而整份 playerWorld 带着整个 `cardState` 账本——几百份拉下来是把往返问题换成 payload 问题。serial 路径照旧各自读整份，它要打仗，打仗要读写 `cardState`。
- **中间格子的 occ 写被折叠掉。** 一条 fast 行军一 tick 跨 3 格，原路径会在 3 个格子上依次写了又清；批处理只写它最后停的那一格。合法性来自第 4 条规则：那些格子这一 tick 里没有第二个读者，而 occ 索引的读者**只有** `advanceMarch` 的进格检查。
- **批量清 occ 必须服务端校验。** `clearOccupancy` 原本是「读出来看看还是不是自己的，是才删」；批处理把「决定删」和「删」之间的窗口拉大了，所以配了一段 Lua（`hdelJsonIdMatch`），逐 field 比对 `.id` 再删。裸的批量 `HDEL` 会把这中间接手该格的单位一起清掉。
- **Mongo 先写、Redis 后写。** 游标 `bulkWrite` 带着和原路径一样的守卫（`status:'marching'` 且 `kind ≠ 'return'`），所以扫描之后才落地的召回会匹配失败；只有**真的匹配上**的行军才会拿到 occ 条目。召回自己会清掉它那一格的 occ（`recallMarch`），事后再给它写一条就是**永久泄漏**（没有任何东西会去清一个文档已经不存在的 occ id）——这正是原路径那次重读要防的事，这里用一次 `matchedCount` 比对 + 极少发生的一次确认查询，给整批一次性关掉。

### 6.4 可观测性：`arrivals.batched` / `arrivals.serial`

`metrics.ts` 新增累计计数器（`bumpCounter`，随 `GET /admin/world/metrics` 一起 peek 出来）。理由很实际：**一个把 600 条行军全部悄悄降级回逐条路径的回归，从外面看就只是「有点慢」**，而这个系统里所有东西出问题时看起来都是「有点慢」。有了这两个数，批处理有没有真的生效是一个可读的数字。

### 6.5 测试与变异验证

- `worldsvc/test/arrival-batch-split.test.ts`（16 用例，纯函数、不需要 DB）：规划与分流规则本身——到达 tick 不批、occ/cover 非空不批、**友军占位也不批**、两条行军撞格子两条都降级、legacy 行军的落点也算占用、没有 playerWorld 的不批，以及 fast 行军最终写的那条 occ 条目（只写最后一格、`leaveAt` 与原路径同式）。
- `worldsvc/test/arrival-batch-roundtrips.e2e.test.ts`（8 用例，真 Mongo）：**断言的是成本而不是行为**。用一个统计每次调用的 Mongo 集合 Proxy + 一个实现了批量命令并计数的假 Redis，钉死「12 条无事发生的行军 = `marches.find` 1 次、`playerWorld.find` 1 次、`bulkWrite` 1 次、`updateOne`/`findOne` 各 0 次、`HMGET` 2 次、批量清 1 次、批量写 1 次」，外加落后 3 格时预算不变、旧版 Redis（只有单 field 命令）回退路径产出一致、以及被降级的那三类（有敌人/无 playerWorld/正在到达）确实还走逐条路径。
- **变异验证 4 轮，全部被抓**：① 让 `splitArrivalBatch` 永不批处理 → 6 条红；② 去掉「到达 tick 不批」 → 2 条红；③ 去掉撞格子规则 → 2 条红；④ 去掉 `bulkWrite` 的召回守卫 → 召回那条红。（5.1 的教训照做：时序/成本类断言，测不出回归的和通过的长得一模一样。）

### 6.6 端到端复测：p50 掉了三个数量级，尾巴没跟着掉——而尾巴不是这一刀的

重建 worldsvc 容器后按 5.2 的配方原样重跑 200 bot（同机 docker 全栈，32s 窗口）：

```
                     批处理前          批处理后（两轮）
sched:arrivals p50   1761ms      →     2.3ms / 6.6ms
sched:arrivals p90   6705ms      →     61ms  / 4091ms
超 interval 告警      30 次        →     3 次  / 6 次
吞吐                              →     73.8 指令/秒（目标 80，差额是 bot 自己的节奏）
POST /world/march                 →     p50 7.5ms  p99 70ms
loopLagMs.max                     →     101.6ms / 48.7ms
```

**p50 是这一刀真正拥有的数字，它掉了三个数量级。p90 两轮差 67 倍，说明它量的根本不是同一件事。**

新加的分因计数器（`arrivals.arriving`/`blocked`/`legacy`）当场把它说清楚了——第二轮 32s 里：

```
batched 794 | serial 1797（arriving 1071，blocked 726，legacy 0）
```

**尾巴是「到达结算」，不是「走格子」。** 一条 arriving 的 occupy 行军要跑一场真实的攻占战（走计算池）外加一次 metaserver 往返；1071 次这样的结算挤进约 20 个 tick，那几个 tick 就是几秒。**批处理再聪明也压不下去它**——那正是本节 6.1 说「不并发」时保护的那段代码。

这也顺带修正了 5.4 ① 的归因：当时把 p50 1761 / p90 6705 笼统记成「到期扫描被压成每 tick 数秒」。现在可以说准确了：**p50 是走格子（已解决），p90/max 是到达结算（仍开放）**。

因此负载测试的断言改成打 **p50 < 200ms**（批处理前是 1761ms，把逐条循环放回来会立刻炸），外加「至少有一条走了批处理路径」；p90/max/分因只**打印不断言**——它们现在由结算突发主导，对它们设预算等于对这个测试无法归因的工作设预算。**这是刻意不把门槛挪到能通过的位置。**

### 6.6b ⚠️ 负载测试对同一个世界**不可重复**——连跑三轮的数字不能横向比

三轮之后才发现的：`slgOrders.load.ts` 每轮用新的 fleet id，但**加入的是同一个赛季世界，状态一轮轮累积**。三轮跑完查库：

```
playerWorld 1601 份 | 已占领地块 17488 | 待结算占领 1117
```

于是同一份代码、同一场风暴，三轮的数字是这样漂的：

| | 第 1 轮 | 第 2 轮 | 第 3 轮 |
|---|---|---|---|
| `sched:arrivals` p50 | 2.3ms | 6.6ms | 2.9ms |
| `sched:arrivals` p90 | 61ms | 4091ms | 719ms |
| `POST /world/march` p50 | **7.5ms** | 7.9ms | **122.8ms** |
| 客户端派发 p99 | 99ms | — | **7471ms** |
| `sched:occupations` p99 | 82ms | 30ms | **4381ms** |

**世界越挤，派发本身越贵**（视野/连地判定要扫的地块变多），上一轮留下的上千条待结算占领还在跟这一轮抢同一个线程。第 3 轮那个 7471ms 的派发 p99 是**世界脏了**，不是这一刀的回归——同一个二进制在第 1 轮是 99ms。

**所以本节能站住的只有一个数：`sched:arrivals` p50 三轮都在 2~7ms，而批处理前是 1761ms。** 其余对比都带着这个混杂因素，写在这里而不是挑一轮好看的报。

**跟进项**：负载测试应该每轮开一个**专用的新世界**（或跑前重置），否则它测的是「一个被前几轮跑脏的世界」而不是「200 人在线」。重置是破坏性操作，需要用户拍板。

### 6.7 还没做的

1. ~~**到达结算突发**（新的第一瓶颈，上面刚量出来）：一个 tick 内几十场攻占战串行。它跟走格子不是一类问题——**不能批，只能摊**（把同一 tick 到期的结算分散到若干 tick / 给结算单独一个更快的 interval / 或者最终还是要面对「跨玩家并发」那道墙）。~~ → **2026-09-09 已做前两条（第七节）**；第三条「跨玩家并发」仍未做，而且现在有了一个说得清什么时候该做它的数字（`arrivals.deferred`）。
2. **`blocked` 的粗规则可以细化，但收益不大**：726 条被降级里，很大一部分是「两条行军共享一个**离开**的格子」（同一玩家从主城连发几支队伍，它们的 `path[0]` 都是主城）。互相离开同一格其实不会冲突——清 occ 是按自己 id 匹配守卫的，最多一条命中。规则可以细化成「只有**进入**的格子算冲突」。但估算收益只有约 50ms/tick（726 条 × 7 次本地 Redis 往返 / 20 个 tick），**远不是尾巴**，所以先记在这里而不是顺手改掉。
3. ~~`getMap` 的 **payload 本身**（40 次/秒 × 6561 格 × 528KB ≈ 21MB/s 出口；往返侧已经削过，剩下的是缩小默认半径 / 更多走 sparse / 增量 diff）。~~ → **2026-09-09 已做（第八节）**，但**不是按这三条路线里的任何一条**：量完之后发现「40 次/秒」的轮询早已删除、`r=40` 客户端从不请求（zoom 1 真实 r=14~30，zoom 2/3 走 sparse），前两条路线其实没有剩余空间；真正的病因是**没有任何一层压缩**，反代加一行 `encode zstd gzip` 就是 **17.6×**。「增量 diff」在 gzip 之上仍有约 20×，但降级为**以后可选**，且先要量「一个真实 active template 改了多少格」。
4. A\* 的 scratch buffer。

### 6.8 复测时踩到的本地栈坑

`docker compose up -d --build worldsvc` 会**顺带重建并重启共享同一个 `nw-server:local` 镜像的其它服务**（metaserver/gateway/socialsvc/commercial），而 **nginx 只在自己启动时解析一次上游 DNS**，于是所有 `/api/*` 立刻 502、负载测试在 ramp 阶段就 200/200 全挂（报的是「HTML 不是合法 JSON」，看不出是 DNS）。**修法：`docker restart nw-local-nginx`。** 这跟 5.4 ② 的 keepalive 是同一个本地栈的两张不同的脸。

## 七、到达结算：拆成自己的任务 + 时间片（2026-09-09，§6.7 第 1 条）

> 一句话：**这一刀不让结算变快，也没有让它变快的办法**——它只是不再让一阵结算独占那唯一的线程。

### 7.1 为什么摊而不是批

§6.6 的分因计数器已经把问题定死了：32s 里 `serial 1797`，其中 `arriving 1071`。一条 arriving 的结算 =
一场真攻占战（走计算池）+ 一次 metaserver 往返。它**不能批**（写的是防守方的账本），**也正因为同一个理由
不能并发**。于是「同一 tick 到期几十条」就是「这个 tick 跑几秒」，而那几秒里 **走格子、其它五个 scheduler
任务、以及每一个 HTTP 请求全都在排队**——单线程。

**吞吐量这一刀一点也没改善。** 结算总量不变、单条成本不变；在结算跟不上到期速度的风暴里，积压照样增长
（这正是 `arrivals.deferred` 存在的理由）。变的是**积压的形状**：服务照常应答、别的任务保持自己的节奏、
到达只是变晚，而不是把整个进程一起拖下水。

### 7.2 怎么切：按 `arriveAt` 一刀两断

到达 tick 拆成两个 **查询互不相交** 的任务：

| | 查询 | 内容 | 成本 |
|---|---|---|---|
| `sched:arrivals`（2s） | `nextStepAt ≤ t` **且** `arriveAt > t` | 只走格子，永远不结算 | 已批处理，p50 ~2ms |
| `sched:arrivalSettle`（500ms） | `arriveAt ≤ t` | 结算（打仗 / 驻防 / 占地），含把落后的几格走完 | 每条一场仗，摊在时间片里 |

- 相交只可能发生在「步进扫描之后、结算扫描之前那条 march 恰好到点」这一瞬。两侧的既有守卫本来就管这个：
  `applyFastSteps` 的 `bulkWrite` 带 `status:'marching'` 过滤 + `matchedCount` 不符时的确认查询（文档没了
  就不给它写 occ，正是 §6.3 那条防永久泄漏的守卫），`advanceMarch` 每次都重读 `live`。**没有为这次拆分
  新增任何锁。**
- **`arrivals.arriving` 在走格子那半现在结构上恒为 0**，仍然照常上报——它变成了「两个查询有没有开始重叠」
  的探针。

### 7.3 时间片，而不是条数预算

`NW_SLG_ARRIVAL_SETTLE_SLICE_MS`（默认 **150ms**，0 = 关闭 = 拆分前的行为），在**两条结算之间**检查，
永远不打断进行中的一条；一次至少放行一条，所以片再小也不会卡死队列。

**为什么是墙钟而不是条数**：单条结算的成本随它撞上什么而差一个数量级（空地 vs 一场满编攻占战），
条数预算在两种世界里意味着完全不同的两件事。150ms 片 / 500ms 间隔 ≈ 风暴下结算最多占 30% 的线程，
平时一次都碰不到片。

**被推迟的那些不带任何状态**：不写标记、不占租约、不改时间——它们只是「仍然到期」，下一趟同一个查询照样
找得到。所以两趟之间崩了也不丢，也没有「谁负责重排」这个问题。顺序按 `arriveAt` 升序（已有索引），
**扫描上限和时间片都会截断队列，没有顺序就是抽签，一条 march 可以反复输**。

### 7.4 测试与变异验证

- `worldsvc/test/arrival-settle-slice.e2e.test.ts`（7 例，真 Mongo）：片小于一条结算 → 每趟恰好放行一条
  且**其余文档逐字段未被碰过**、多趟把队列排干且不丢、按到达时间从老到新、`arrivals.settled`/`deferred`
  两个计数器、**两半互不相交**（走格子那趟不结算、结算那趟不动半路的 march）、以及
  `processDueArrivals`（测试/admin 用的合并入口，自己掌握时钟）**仍然一次调用就把世界结算干净**。
  片是靠**传 `sliceMs` 参数**驱动的，不是靠假时钟——结算是真异步 I/O，微小的片就确定性地只放行一条，
  于是不必在真 Mongo 旁边动 fake timers。
- **四轮变异全部验红**：① 去掉时间片检查 → 4 例红；② 去掉 `arriveAt > t`（两半重叠）→ 2 例红
  （含 §6.4 那份计数器测试）；③ 合并入口不再跑结算 → 3 例红；④ 去掉 `.sort({arriveAt:1})` → 1 例红。
- **④ 值得单记**：第一次写这条时它**不肯变红**。原因是结算查询就是按 `arriveAt` 过滤的，Mongo 自然走
  `{arriveAt:1}` 索引、本来就有序——**删掉 sort 所有行为断言照样绿**。这不代表 sort 是装饰：它是「保证」
  和「计划器巧合」的差别，哪天计划器改挑别的索引，公平性就无声消失。所以那条用例改成两段：顺序仍按行为
  断言，**「顺序是被请求的」用一个记录 `.sort()` 参数的游标 Proxy 断言**。
  （呼应 [`server.md`](../../claudedocs/server.md) 那条：拒绝变红的测试通常说明断言的是别的东西。）

### 7.5 还没有量到的

**本机测不出这一刀的真实收益**：§6.6b 的负载测试对同一个世界不可重复（三轮跑完 1601 份 playerWorld、
17488 格已占领），要横向比就得每轮开一个干净世界或者重置——重置是破坏性操作，需要用户拍板。所以这一节
**没有任何端到端数字**，只有单元/成本级别的保证。真上量的时候该看的是：`loopLagMs.max` 与
`POST /world/march` p99（这一刀真正针对的东西）、`sched:arrivalSettle` 的超 interval 告警频率、
以及 **`arrivals.deferred` 是否持续增长**——它一旦长期非零，说明结算吞吐才是天花板，
§6.7 第 1 条里那道「跨玩家并发」的墙就到了非撞不可的时候。

### 7.6 后续：`arrival.ts` 592 行，把这一刀切出来的两半也切成两个文件（2026-09-09 当日追加）

§7.2/§7.3 那一轮只加了时间片，**没有动 `npm run check:filelength`**——`worldsvc/src/combatMarch/arrival.ts`
被撑到 **592 行**，超了 500 门禁又不在基线里，于是当日分支一开 PR 就会红在 `ci.yml` 的 `server-checks`。
（教训本身很老：门禁失手一次的成本是「下一个人替你发现」，见 [`server.md`](../../claudedocs/server.md)。）

**没有走基线豁免，走了真拆**，按 [`server-audits.md`](../../claudedocs/server-audits.md)「拆分形态的优先级」
的**形态①（独立函数模块）**——§7.2 已经论证过这两半「查询互不相交、不共享状态」，那就是它们能各自成文件的
现成理由，不用再重新判断一遍边界：

| 文件 | 行数 | 内容 |
|---|---|---|
| `combatMarch/arrival.ts` | 214 | **队列那一端**：两个扫描 + 三个旋钮（`ARRIVAL_SCAN_LIMIT` / `SETTLE_SLICE_MS` / `warnIfCapped`）+ `arrivals.*` 计数器。`ArrivalService` 只剩这三个对外方法。 |
| `combatMarch/arrivalWalk.ts` | 210 | **走格子那半**：`advanceMarch`——ADR-051 的逐格前进、occ 索引维护、P2b/P5/P3b 三种拦截、以及行军自己的账本与删除。 |
| `combatMarch/arrivalSettle.ts` | 214 | **落地那半**：`applyArrival` 按 `kind` 分派（return 退兵 / attack·sweep·occupy 交给攻城域 / move 走 `applyMove`+`tryParkTeam` / 兜底 reinforce）。后两个是文件私有，只有 `applyArrival` 会调。 |
| `combatMarch/arrivalCtx.ts` | 25 | `ArrivalSiegeCtx`：这两半真正用到的 5 个 `SiegeService` 方法，照 `combatSiege/ctx.ts` 的窄接口惯例。 |

- **两半之间只有一条边**：`advanceMarch` 走到路径末格时调 `applyArrival`。所以 `ArrivalSiegeCtx` 是 5 个方法
  的并集而不是两个接口——走格子那半会传递性地用到落地那半的三个。
- **零行为改动，而且是可机械核对的零**：把新文件反向变换（还原缩进、`core.`→`this.core.`、
  `siege.`→`this.siege.`、函数签名换回方法签名）后跟 `git show HEAD:...arrival.ts` 的对应行段 `diff`，
  两个文件**逐字节相同**；`arrival.ts` 自己那 194 行里只有 3 处调用点改成了传 `(this.core, this.siege, …)`。
  §7.4 那四条变异验证过的性质因此一条都没碰到，三个到达测试文件**一行没改就是绿的**。
- **顺带清掉一处反射**：`test/review-fixes-2026-08-03.e2e.test.ts` 原来靠
  `(svc as any).combat.march.arrival.advanceMarch` 戳私有方法（2026-08-11 那次拆分留下的写法）——现在
  `advanceMarch` 是个真正导出的函数，直接 `import` 调用，`as any` 只剩下读那两个私有依赖字段。
- **补了一条结构门禁**：`worldsvc/test/arrival-split-edges.test.ts`（3 例，纯静态、读源码、4ms）钉住那条边
  **单向**——`arrivalSettle.ts` 不许 import 走格子那半，两半都不许 import 回 `arrival.ts`。**为什么值得一条**：
  反向 import 不会编译失败，它只是把这一对变成加载期 ESM 环，症状是某个 scheduler tick 里
  `applyArrival is not a function`——读起来像到达逻辑的运行时 bug，而不是一次 import 失误（跟
  `compute-worker-module-graph.test.ts` 同一个理由：把模块图的规矩钉在便宜的地方，别等崩了再从一句
  指错方向的报错往回找）。**三轮变异全部验红**：① 在 `arrivalSettle.ts` 里 import `advanceMarch`；
  ② 删掉 `arrivalWalk.ts` 那条真实的 `./arrivalSettle` import；③ 让 `arrivalWalk.ts` import 回 `arrival.ts`。

## 八、`getMap` 的 payload（2026-09-09，§6.7 第 3 条）

> 一句话：**先量，结果三条候选路线全都不该走** —— 真正的病因是「几千个近乎相同的瓦片对象**没有被压缩**」，
> 而这一条根本不在 §6.7 给出的三条路线里。改法在反代那一层，一行配置，**Node 的那根线程一毫秒都不花**。

### 8.1 §6.7 第 3 条的前提有两处已经过期

那一条写的是「40 次/秒 × 6561 格 × 528KB ≈ 21MB/s 出口」。逐项核过之后：

1. **「40 次/秒」的那个 5 秒轮询早就删了。** `client/src/scenes/worldmap/WorldMapNet.ts:85-102` 的
   `start()`/`destroy()` 现在是显式空实现（P1-2，comm-audit-2026-07-27）。地图拉取现在是**事件驱动**：
   进场（`POST /world/enter`）、拖动结束（`WorldMapInput.ts:458`）、变焦（`viewport.ts:54`）、
   一次改动型操作的自身响应、以及 `tile_update` / `siege_result` 推送（`net/push.ts:39,82`）。
   200 人在线的稳态出口不再是一个能乘出来的常数。**顺带**：`loaders.ts:156,161`、`lifecycle.ts:127`、
   `core/map.ts:76` 的注释里还写着「~5s 轮询」，都是过期的。
2. **`r=40` 这个形状客户端从来不请求。** 半径来自视口尺寸而不是变焦档位常量
   （`WorldMapRenderer/viewport.ts:31`：`ceil(max(spanTx, spanTy)/2) + 4`），而 `getMap`（满格）
   **只在 zoom 1 走**，zoom 2/3 走 `getMapSparse`（`net/loaders.ts:90`）。把真实布局代进那个公式：

   | 布局 | zoom 1 实际请求的 r | zoom 2 | zoom 3 |
   |---|---|---|---|
   | 横屏 1920×1080 | **15~16** | 35 → sparse | 40（截断）→ sparse |
   | 横屏 2592×1080 | **14** | 31 → sparse | 40（截断）→ sparse |
   | 竖屏 1080×1920 | **26** | 40（截断）→ sparse | 40（截断）→ sparse |
   | 竖屏 1080×2400 | **30** | 40（截断）→ sparse | 40（截断）→ sparse |

   所以满格读的真实范围是 **r=14~30**，`MAP_VIEW_MAX_RADIUS = 40` 的那 6561 格只是当初微基准挑的
   上界。（`r` 缺省时服务端取 10；botsvc 只打 sparse 且 `r=5`。）

**这直接判掉了三条路线里的两条**：「缩小默认半径」已经由客户端自己的视口数学做完了，没有剩余空间；
「更多走 sparse」——zoom 2/3 已经全在 sparse 上，实测同一个视口 **7.1KB / 194 格**，也没有剩余空间。

### 8.2 量出来的分解（`worldsvc/test/load/getMapPayload.load.ts`，确定性、不需要 docker）

新加的这份 harness 自带内存副本集、固定 seed、固定瓦片配比，**两次跑出同样的字节数** —— 跟隔壁那份
订单吞吐负载测试（§6.6b：对同一个世界不可重复）刚好相反，这也是它值得留下来的全部理由：
payload 这个问题可以在本机上关掉。

真实世界（本机 docker 全栈、`s1-4`、`cx=cy=750`）逐档：

| r | 格数 | 线上字节 | gzip 后 | 比例 |
|---|---|---|---|---|
| 16 | 1089 | 85,856 | 4,972 | 5.8%（17.3×） |
| 30 | 3721 | 296,971 | 16,803 | 5.7%（17.7×） |
| 40 | 6561 | **523,124** | **29,708** | 5.7%（**17.6×**） |

r=40 那个 523KB 复现了审计原文的 528KB（harness 里 529.7KB），所以这三行跟第一节是同一把尺子。

**按字段分解**（r=40，一个有 185 格外人领地的繁忙视口）：

| 字段 | 字节 | 占比 | 出现在 |
|---|---|---|---|
| `type` | 115.5KB | 21.8% | 6561 格 |
| `resType` | 101.0KB | 19.1% | 5627 格 |
| **`visible`** | **96.1KB** | **18.1%** | 6561 格（**恒为 `true`**） |
| `level` | 64.1KB | 12.1% | 6561 格 |
| `x` + `y` | 102.6KB | 19.4% | 6561 格 |
| `obstacleKind` | 21.2KB | 4.0% | 926 格 |
| 归属 + 情报（`ownerName`/`ownerPublicId`/`familyId`/`occupied`/`garrison`/`hp`…） | 合计 < 4% | | ≤194 格 |

**结论很干脆：payload 里几乎没有「玩家状态」，全是地形。** 玩家真正想知道的那部分（谁占了、多少兵、
多少耐久）不到 4%；剩下 96% 是每一格都要重复一遍的地形描述。而 **94% 的格子（498KB）与客户端自己
`proceduralTile()` 就能算出来的结果逐字节相同** —— zoom 2/3 的 sparse 契约本来就是这么干的。

### 8.3 为什么最后没走「增量 diff」，也没有去掉那个恒为 true 的 `visible`

两条看起来都对，都被同一个测量否掉了：**它们和压缩不是可加的**。

- **去掉 `visible`**：未压缩 −18.7%（513KB → 417KB），**压缩后只剩 −0.1% ~ −1.5%**。
  它是一个每格都一样的常量串，压缩器吃它不要钱。换来的是一次协议改动（openapi + 客户端 + 测试），
  收益是零。**不做。**
- **procedural diff**（只发客户端自己算不出来的格子）：未压缩 −94%（529.7KB → 31.5KB），
  在此之上再 gzip 是 1.4KB。跟「只 gzip」的 29.7KB 比确实还有 20× —— 所以这条**没有被证明无价值**，
  只是被证明**不该先做**：它是一次协议 + 客户端渲染路径改动，而 gzip 是一行配置就拿到 17.6×。
  **并且它有一个本机测不出来的天花板**：`isClientDerivable` 是拿 `proceduralTile` 比的，而
  §24 Layer A 的 `mapBaselineRows` 承载的是**管理后台地图编辑器的手改**（画的河/山、挪动的城），
  客户端推不出来。本机这个世界没有 active template，所以基线行缺失、`getMap` 回落到
  `proceduralTile`，94% 是**上界**；一个从手改模板开的世界要按被改过的格数往下打折。
  真要做这条，得先量「一个真实的 active template 改了多少格」。

### 8.4 做了什么：压缩放在反代，不放在 Node 里

改动一共两处配置 + 一处响应头：

- `server/Caddyfile`（生产）：`encode zstd gzip`。
- `client/nginx.conf`（本地「真实发布」模拟）：`gzip on` + **`gzip_proxied any`**。
  ⚠️ `gzip_proxied` 默认 `off`，**上游来的响应一律不压缩** —— 只写 `gzip on` 对
  `/api` `/world` `/social` 这些反代路径**完全没有效果**，而这里几乎所有字节都在那儿。
- `worldsvc/src/httpApi/helpers.ts` 的 `send()`：声明 `content-length`（见 §8.5）。

**为什么在边缘而不是在 `send()` 里**：本审计第一节整篇讲的就是别把 CPU 放到那唯一的事件循环上。
实测（`monitorEventLoopDelay` + 一个 1ms ticker，20 个 513KB 响应）：

| 做法 | 墙钟 | 事件循环延迟 max | 那段时间里 1ms ticker 被服务的次数 |
|---|---|---|---|
| 空闲基线 | 161ms | 16.33ms | 22 |
| `gzipSync` L6 ×20 | 81ms | **0.00ms** | **0** |
| `zlib.gzip` L6 ×20（并发） | 24ms | 3.24ms | 14 |
| `zlib.gzip` L1 ×20（并发） | 7ms | 1.62ms | 6 |

**`gzipSync` 那行的 `0.00ms` 不是「零延迟」，是「直方图一个样本都没采到」** —— 循环在那 81ms 里
根本没跑起来，所以 `monitorEventLoopDelay` 读不到任何东西。这是个陷阱：**这块指标读到 0 要先怀疑
「没机会采样」，而不是「没有延迟」**；真正说明问题的是同一行的「ticker 被服务 0 次」。
（`zlib.gzip` 异步版墙钟反而更短，是因为它落在 libuv 线程池上、四个线程并行。）

即便走异步版，也仍然是 Node 进程在花 CPU，而 Caddy 是**另一个进程**、有真正的并行度，并且顺手
覆盖了 metaserver / socialsvc / auctionsvc / analyticsvc 的所有 JSON 面 —— 一行配置换全局收益。
所以：**边缘压缩，`send()` 里不压。** 万一哪天有平台绕过边缘直连服务，那时再在 Node 里补，
用异步版、并且带上上面这张表。

压缩等级取 gzip L5/L6 一档：实测 513KB 上 **L1 = 7.4%，L6 = 5.0%，L9 = 4.5%**，
收益早已压平而 L9 的 CPU 是 L6 的六倍（sync 25.5ms vs 4.4ms）。

### 8.5 顺手修掉的一个真 bug：`gzip_min_length` 在 chunked 响应上是空文

第一次接上 nginx 之后复测，发现 **31 字节的 `/world/active-season` 出口变成了 51 字节** ——
gzip 自己的头就约 20 字节，小响应被压缩只会变大。根因：`send()` 只写了 `content-type` 就
`res.end(...)`，node 于是回落到 **chunked 分帧**；而**反代无法对一个自己都不知道大小的响应执行
尺寸阈值**，于是 `gzip_min_length 1024` 形同不存在，nginx 把**所有东西**都压了。

修法是在 `send()` 里声明 `content-length`（204/304 除外——那两个状态不能带 body，给它们声明长度
是协议违规，有些反代直接拒）。修完实测：

| | 修前 | 修后 |
|---|---|---|
| `/world/active-season`（31B） | 51B、`content-encoding: gzip` | **31B、不压缩** |
| `/world/me`（370B） | 242B、gzip | 370B、不压缩（低于 1024 阈值） |
| `/world/map` r=40 | 29,708B、gzip | 29,708B、gzip（不变） |

门禁：`worldsvc/test/response-framing.test.ts`（真 HTTP 往返，不是断言 header 对象——node 会为
某些状态自己改写/丢弃 `content-length`）。**三轮变异全部验红**：① 去掉 `content-length` → 2 例红；
② 204 也带上 `content-length` → 1 例红；③ 用字符数代替字节数 → 1 例红。

**同一个坑在另外两个服务里**：压缩是在反代上开的，也就是**一次给所有公网面开的**，所以顺手核了一遍
谁会被小响应膨胀波及。`metaserver` / `auctionsvc` / `admin` / `commercial` 走 fastify，fastify 自己
就写 `content-length`，不受影响；**`socialsvc`（`/social/*`：邮件/聊天/好友，小响应极多）和
`analyticsvc`（`/analytics/events` 的 ack）是同一份手写 `node:http` 的 `send()` 形状**，同样会被压。
两处都按同一个改法修了（analyticsvc 不需要 204 分支——它的 preflight 走独立的 `sendPreflight()`）。
两边测试全绿（socialsvc 332 例、analyticsvc 109 例）。

**③ 值得单记**：第一版这条用例是拿未授权的 401 信封当载荷写的，**它不肯变红** —— 那个信封是纯
ASCII，`String.length` 和 `Buffer.byteLength` 在它上面永远相等，用例一直在为错误的理由通过。
改成让假 service 返回一份带 CJK `ownerName` 的 `getMap` 响应（这正是生产里的真实形状：显示名
直接来自 meta profile）之后，变异立刻红成 `Unterminated string in JSON` —— 也就是真实故障现象
本身：body 被按字符数截断。（同 §7.4 ④ 与 [`server.md`](../../claudedocs/server.md) 那条：
拒绝变红的测试通常说明断言的是别的东西。）

### 8.6 生产路径（Caddy）单独验过一遍

nginx 是本地模拟，生产是 Caddy，两者不能互相顶。用真 Caddy 容器挂上改后的 `Caddyfile`、
接进同一个 compose 网络，直连同一个 worldsvc 复测：

| | identity | gzip | zstd |
|---|---|---|---|
| Caddy r=40 | 523,124 | **31,794（16.5×）** | **28,338（18.5×）** |
| Caddy r=16 | 85,856 | 5,343 | 4,800 |
| nginx r=40 | 523,124 | 29,708（17.6×） | 不支持 → 523,124 |

两边都带 `Vary: Accept-Encoding`，小响应两边都不动。**注意 `caddy validate` 需要
`NW_OPS_PROXY_SECRET` 有值**：那个变量为空时 `/ops/*` 的 header matcher 变成「有字段没有值」，
validate 直接报 `malformed header matcher` —— 这是**改动前就存在**的现象，不是这次引入的，
别把它当成自己的锅（用 `-e NW_OPS_PROXY_SECRET=dummy` 跑）。

### 8.7 还没有量到的

- **微信小游戏那一侧没有真机验过。** `wx.request` 会不会自己带 `Accept-Encoding: gzip`、
  会不会透明解压，本环境判定不了（「declare 两个方向都不是证据」）。**但这不构成风险**：
  两边的压缩都是按请求头协商的，一个不声明 gzip 的客户端拿到的就是今天这份未压缩字节，
  **启用它不可能弄坏任何客户端**。真机测的时候顺手看一眼 `/world/map` 的响应头就有结论。
- **本地 nginx 的改动要重建镜像才会固化**：`client/nginx.conf` 是烤进 `nw-client:local` 镜像的
  （`client/Dockerfile`），本轮验证走的是 `docker cp` + `nginx -s reload`。
  **`docker restart nw-local-nginx` 会把它还原成镜像里的旧版**（本轮就踩到一次，因为 §6.8 那条
  「重建 worldsvc 后必须重启 nginx」正好会覆盖掉 cp 进去的配置）。顺序：先重启 nginx，再 cp + reload。
- **`getMapSparse` 的 `lod` 现在没有区分度**：实测 `mid` 与 `thin` 在同一视口上都是 7.1KB / 194 格、
  逐字节相同。`mid` 多算的家族/宗门/同盟 tag 只在那些关系真的存在时才会加字段，本机世界里没有，
  所以这不是 bug；但它意味着 **sparse 的 `lod` 分档从来没有被真实数据量过**。
- **出口总量仍然量不出来**：§8.1 第 1 点把可乘的常数拿掉了，真实稳态取决于玩家怎么拖地图。
  真上量的时候该看的是 Caddy 侧的出口字节，而不是再乘一个假设的轮询频率。

### 8.8 门禁（2026-09-09 同日追加）：三个属性全都不在类型系统里

第八节的 17.6× 完整地活在**两个配置文件 + 一个响应头**里。没有任何一处代码会因为它们消失而变红，
而它们各有一种消失方式：

1. **`encode` 从 Caddyfile 里没了** → 生产不再压缩，仓库里没有任何东西会注意到。
2. **`gzip_proxied` 从 nginx.conf 里没了而 `gzip on` 还在** → 这是最恶的一种：配置**读起来就是
   「压缩已开启」**，而 nginx 的默认 `gzip_proxied off` 意思是「上游来的一律不压」，
   `/api` `/world` `/social` `/auction` 全是上游。审计的人扫到 `gzip on` 就过了。
3. **某个 JSON writer 退回 chunked** → §8.5 那个 31B→51B 又回来。

所以加了 `server/scripts/checkEdgeCompression.mjs`（`npm run check:edgecompression`，已进 `ci.yml`
的 server-checks，紧跟 `check:auctionjournal`），四条规则：`caddy-encode` / `nginx-gzip-proxied` /
`nginx-gzip-json` / `declared-length`。变异测试 `worldsvc/test/check-edge-compression.test.ts`
**11 例全部按规则 id 验红**（含「gate 不能因为自己的文档变红」和「`src/generated/**` 要跳过」两例正向用例）。

**`declared-length` 故意是一条「`server/*/src` 下不许出现 `res.end(JSON.stringify(...))`」的平坦规则，
没有按服务的白名单** —— 因为写这一节的那次扫描**把服务名单搞错了**：它对每个服务 grep 了单词
`fastify`，在 auctionsvc 和 admin 里搜到了，就判定这两个「fastify 会自己写 content-length，不受影响」。
事实是这两个服务**另外还各有一份手写的 `node:http` `send()`**，分别服务 `/auction*` 和 `/ops/*`，
**都在压缩后的边缘后面**。白名单会把这个错误固化下来，一条没有例外的规则不会。

**这是同一类错误的第二次**（第一次记在 `index/open.md`：核 ADR-071 4b 时核了一个代理指标而不是它自己的
验收条件）。**教训同上：不要用一个「看着像」的信号代替直接检查那件事本身** —— 这里直接检查是
`grep -rn "res.end(JSON.stringify" server/*/src`，一条命令，当场就能看出七个服务全中。

顺带把剩下六处也一起改了（`botsvc` / `commercial` / `gateway` / `matchsvc` 的 internalHttp、
`gameserver/httpHealth.ts`）。这几处是**内网面、不经过边缘**，改它们纯粹是为了「一条规则没有例外」
比「一份要人维护的白名单」更可靠；`gameserver/test/httpHealth.test.ts` 因此从「断言 writeHead 的
header 对象字面量」改成「断言声明的长度与它伴随的 body 一致」——后者才是真正想守的东西
（长度写错会截断响应，用字符数算的长度对任何非 ASCII body 都是错的）。

### 8.9 门禁二：`getMap` 每格字段预算

`worldsvc/test/map-payload-budget.e2e.test.ts`（普通 suite，每次 push 都跑）。523KB 这个形状
**不是谁决定的，它是一格一格攒出来的** —— 给 `WorldTileView` 加一个字段在调用点看不见任何代价，
在线上是 6561 倍。所以这份门禁守的是**每格的字段集合**而不是总量：

- 一个**没有 DB override** 的格子只允许携带 `x y type level resType obstacleKind visible`
  （`visible` 明确列在里面，附上 §8.3「压缩后只值 0.1~1.5%，不值一次协议改动」的结论，
  免得下一个人再重新发现一遍）。
- 每格字节上限 95（当前 82.7），松到能扛坐标多一位数，紧到一个新字段就顶破。
- 情报字段（`garrison`/`hp`/`occupied`）只能挂在真有它们的格子上，**不能带着 falsy 默认值铺满全图** ——
  这是「加一个字段」变成「加 6561 份」的最常见写法，而它在任何单格用例里都看不出来。

**两轮变异验红**：① 给每格加一个 `zoneTag` → 2 例红（字段集合那条报出「`zoneTag` on 6561/6561」+
字节上限那条从 82.7 涨到 98.3）；② 把 `garrison` 改成无条件带默认值 → 1 例红。

**写这份门禁时它自己抓到了我一个错**：第三条最初用「别人的领地」当载荷，结果 `garrison` 断言失败 ——
**这是对的**：garrison/hp 是被战争迷雾门控的情报（`gateIntel`），一个附近没有领地的请求者本来就看不到；
而 `occupied` 确实到了，因为归属在 2026-07-24 那次迷雾模型改动里变成了全图公开。改成用请求者自己的
格子（自己的领地天然在视野里）。迷雾规则本身是 `fog.e2e.test.ts` 的活，这里只管字段位置。

### 8.10 顺手更正一处文档漂移：`api.gamestao.com` 现在不在 Cloudflare 后面

`deploy-cloudflare.md` §3 的表把 `api.gamestao.com` 标成**橙云**（CF 代理）。**2026-09-09 实测不是**：

```
GET https://api.gamestao.com/world/active-season
  via: 1.1 Caddy
  alt-svc: h3=":443"; ma=2592000
  transfer-encoding: chunked
  （没有 cf-ray，没有 server: cloudflare）
```

这件事对第八节是**决定性的**：如果它真在橙云后面，Cloudflare 自己就会压缩，那这一节的改动对网页端
基本是冗余的。实测没有 CF，所以 **Caddy 的 `encode` 是生产唯一的压缩层**，17.6× 是生产数字而不是
只在本机成立。（`transfer-encoding: chunked` 同时说明线上跑的还是改动前的 worldsvc。）

**教训**：`checkCachePolicy.mjs` 的文件头写过一遍同样的事（「三个地方里有两个给了正确的印象，
只有对着线上域名 curl 的那个不同意」）。这一节差点重犯：本机 docker + 本机 Caddy 容器都验了，
**唯独没验线上到底有几层反代**。**收尾前对着真域名打一次，那是唯一能证明「生产的那一层是哪一层」的做法。**
