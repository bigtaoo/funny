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
3. `getMap` 的 **payload 本身**（40 次/秒 × 6561 格 × 528KB ≈ 21MB/s 出口；往返侧已经削过，剩下的是缩小默认半径 / 更多走 sparse / 增量 diff）。
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
