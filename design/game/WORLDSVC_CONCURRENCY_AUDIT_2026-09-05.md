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

1. **用 botsvc 造 200 bot 的真实负载测试**——阶段 0 的指标已经就位（事件循环延迟 + 每路由/每 scheduler 任务的 p50/p90/p99 进 heartbeat），但还没有在真实并发下跑过。**这是下一步最该做的事**：后面每一条优化都应该由这份数据决定，而不是由推断决定。
2. `getMap` 的 **payload 本身**（40 次/秒 × 6561 格 × 528KB ≈ 21MB/s 出口）。往返侧已经削过了：成员集合的 3 次 socialsvc 往返进了缓存，`familyMemberIds`/`sectMateMemberIds`/`allySectMemberIds`/`computeVisionSources` 原本**各自重读同一份 playerWorld** 且串行执行，现在读一次、四个并发。剩下的是 payload 大小本身（缩小默认半径 / 更多走 sparse / 增量 diff），没动。
3. scheduler 深度批处理（见出入 2）。
4. A\* 的 `g`/`par`/`closed` 从 `Map`/`Set` 换成带代际标记的 typed array scratch buffer——只在长距离行军真的占主导时才值得。
