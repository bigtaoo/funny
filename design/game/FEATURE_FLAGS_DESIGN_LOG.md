# Feature Flags / 客户端日志采集 — 实现记录（§8）

> 从 [`FEATURE_FLAGS_DESIGN.md`](FEATURE_FLAGS_DESIGN.md) 拆出（2026-08-24，原文件 510 行）。**小节编号沿用原文**，文档/源码里的 `FEATURE_FLAGS_DESIGN.md §8` 引用照旧有效。
> 规格仍在 [`FEATURE_FLAGS_DESIGN.md`](FEATURE_FLAGS_DESIGN.md)（§0–§7 机制 + §9「客户端日志定向采集」+ §9.7「客户端异常事件『全量』上报通道」）；本文里的 `§3`/`§9`/`§9.x` 均指该文的对应小节。
> 本文是**按日期追加的实现流水**（2026-06-24 起）。**新条目一律追加到本文末尾，不要堆回 hub**（ADR-067「写新内容放哪」）。

---

## 8. 实现记录

### 2026-06-24 · F1 核心 + 首条 flag `match_bot_fallback` 端到端

**F1 核心（@nw/shared）** — `server/shared/src/featureFlags.ts`：
- `FEATURE_FLAGS` 白名单（首条 `match_bot_fallback`）+ `FlagKey` 类型 + `flagDefault`/`isFlagKey`/`FLAG_KEYS`。
- `evaluateFlag(key, doc, ctx)` 严格按 §3 六条短路；FNV-1a 32-bit (`fnv1a`/`rolloutBucket`) 稳定分桶。
- `sanitizeFlagDoc`（容错规整脏规则）+ `FeatureFlagCache`（轮询取数 + 30s 刷新 + 本地求值 + admin 不可达吃旧缓存/冷启动 default 兜底 + 可注入 region）。
- 单测 `server/shared/test/featureFlags.test.ts`（16 例，覆盖六条顺序 + hash 稳定 + 缓存降级）。

**F2 后台（admin + tools/ops）**：
- 能力点 `config.manage`（`shared/admin.ts`，授予 super/ops）+ 审计动作 `config.update`。
- admin 库 `featureFlags` 集合（`admin/db.ts`，`_id`=key，索引 `updatedAt:-1`）。
- `AdminService.getConfigFlags`/`getInternalFlags`/`upsertFlag`（校验 + before/after 审计）。
- httpApi：`GET/PUT /admin/config/flags`（admin JWT + config.manage）+ **内部端点 `GET /admin/internal/flags`**（X-Internal-Key，出原始规则，不求值）。
- tools/ops 新增「功能开关」菜单页（总闸 toggle + pct/regions/platforms/白黑名单编辑 + 最近修改人/时间）。

**F4 服务端读取 + 首条 flag 闭环（matchsvc）**：
- matchsvc 轮询 admin 内部端点构建 `FeatureFlagCache`（env `NW_ADMIN_INTERNAL_URL`/`NW_REGION`）。
- `Matchmaking` 加入队等待超时扫描（`botFallbackMs`，对单人独自在队亦生效）。**非 fire-once**：开关关「继续等」时条目仍在队，每隔 `botFallbackMs` 重评一次（`lastTimeoutAt` 节流），保证运营把开关「后开」也能覆盖已在排队的老条目（旧 fire-once 会把首判时关着的条目永久钉死成「等真人」→ 后开开关漏判）。
- `Matchsvc.onQueueTimeout`：求值 `match_bot_fallback`（ctx=accountId/platform/region）→ 开启则出队并推 `match_bot`（seed/opponentName/elo/difficulty），关闭则继续等真人。env `NW_MM_BOT_FALLBACK_MS`（默认 30000）。
- 单测：`matchmaking.test.ts`（超时触发 / 仍在队周期性重评 / 关闭 / platform 透传）+ `matchsvc.test.ts`（flag 开→推 match_bot 出队；关→留队；**后开→下一次重评即降级**）。
- ⚠ **部署必坑（2026-06-24 修）**：matchsvc 容器**必须**注入 `NW_ADMIN_INTERNAL_URL`（指向 `http://admin:8083`），否则 `flags.start()` 不启动 → 开关轮询禁用 → `match_bot_fallback` 恒为默认 false → **后台无论怎么开都永不降级打 AI**。`docker-compose.cloud.yml` / `docker-compose.prod.yml` 的 matchsvc 段此前漏配，已补（连同 `NW_REGION` / `NW_MM_BOT_FALLBACK_MS`）。判定是否生效看 matchsvc 启动日志：`feature flags: poll http://admin:8083 ...` 为正常，`disabled (all default)` 即漏配。

**客户端本地 AI 局（决策层 + 客户端本地 AI，按拍板）**：
- 契约：`transport.proto` 新增 `MatchBot{seed,opponent_name,elo,difficulty}`（ServerMsg oneof #24）；gateway `matchsvcClient`/`Gateway.toServerMsg`/`proto.encodeServer` 透传；客户端 `proto:gen` 重生成。
- 客户端：`NetSession.onMatchBot` 路由 → `createAppCore` ranked 处理器收到即退排队、`goGame({seed,fromBotFallback})` 开本地 PvP-vs-AI 局（`matchEngine`/`GameScene` 透传 `seed` 保持确定性）。analytics 标记 `pvp_bot_fallback`。

> 状态：F1/F2/F4 + 首条 flag 端到端已落地并通过 tsc + 单测（server 全 workspace typecheck 通过；shared/matchsvc/gateway 单测 58 例通过；client/ops tsc 通过）。

### 2026-06-24 · 客户端日志定向采集（§9）+ F3 公开 bootstrap 闭环

按 §9.6 步骤 1–6 全部落地（核心闭环 1–4 端到端可验证，5/6 收尾）：

**① `@nw/shared`（`featureFlags.ts`）**：
- `FlagRollout` 加 `allowPublicIds?`；`FlagContext` 加 `publicId?`；`evaluateFlag` 在 allowAccounts 同优先级加「allowPublicIds 命中即开」；`sanitizeFlagDoc` 解析该字段。
- 登记 4 个分级 flag `client_log_error/warn/info/debug`（default 全 false，side client）。
- 单测扩到 19 例（新增 allowPublicIds 命中/解耦/总闸·deny 盖过 + sanitize 容错）。
- **排他定向必坑见 §9.1**：单玩家定向 = `pct:0` + `allowPublicIds:[目标]`（只填 allowPublicIds 会对全员开）。

**② metaserver**：
- 接 `FeatureFlagCache`（轮询 admin 内部端点，env `NW_ADMIN_INTERNAL_URL`/`NW_REGION`，同 matchsvc）。
- 公开 `GET /bootstrap?platform=&publicId=`（`operationId: bootstrap`，匿名可调；带 token 则解析 accountId）：对全量白名单逐个求值，**只回 `resolved !== default` 的 flag**（多数玩家空 map）。规则/白名单绝不下发。
- `POST /client/log`（`operationId: clientLog`）：**永远回 200**。防滥用 = 仅当 publicId 当前被某 `client_log_*` 的 `allowPublicIds` 点名才转发，否则静默丢弃（`accepted:0`）。转发用 `clientLog.ts` 组装 Loki push payload（按 level 分流，label 仅 `{source=client, level}`，publicId/tag/msg 入行内 logfmt，ts→ns）。env `NW_LOKI_PUSH_URL`，不可达静默丢弃。
- 单测 `test/clientLog.test.ts`（7 例：payload 组装 + bootstrap 只回 diff + clientLog 定向守卫/转发/400）。

**③ 客户端**：
- `net/log.ts`：加内存环形缓冲（容量 200，单调 seq）。`netLog` 每条 emit 同时入缓冲（与 console 开关无关——console 关着也能远程捞）；全局未捕获错误/Promise 拒绝亦入缓冲。`snapshotClientLogs(thresholdRank, afterSeq)` 取 ≥阈值且新于 afterSeq 的条目。
- `net/featureFlags.ts`：`FeatureFlags` 启动拉一次 + 每 120s 轮询 `/bootstrap`；解析 `client_log_*` 推上传阈值（debug>info>warn>error 取最 verbose 的已开）；命中后每 30s 把缓冲 ≥阈值新条目批量 `POST /client/log`（无 publicId 不上报）。
- `createAppCore`：构造并 `start()`（有 API 基址时）；登录/存档回包拿到 publicId 后 `refresh()` 即时生效。
- `ApiClient` 加 `getBootstrap` / `postClientLog`。单测 `test/feature-flags.test.ts`（5 例：缓冲过滤 + 未命中不报 + 命中周期上报带 publicId + 无 publicId 不报）。

**④ contracts/openapi.yml**：补 `/bootstrap`（GET，公开）+ `/client/log`（POST，公开）+ `config` tag；客户端 `rest:gen` 重生成类型。

**⑤ tools/ops**：「功能开关」编辑卡加 `allowPublicIds` 输入框（与 allow/deny 并列）；对 `client_log_*` flag 显式提示「pct=0 + 仅填 allowPublicIds」配法 + Grafana 查询串。admin `validateRollout`/`describeFlag` 同步认 `allowPublicIds`。

**⑥ Grafana**：新增仪表盘 `observability/grafana/dashboards/client-logs.json`（publicId 文本框 + level 过滤 + 速率/错误数/上报玩家数 + 日志面板，查询 `{source="client"} | logfmt | publicId=~"$publicId.*"`）。

- ⚠ **部署必坑（同 matchsvc）**：metaserver 容器**必须**注入 `NW_ADMIN_INTERNAL_URL`（→`http://admin:8083`），否则 flag 轮询禁用 → `/bootstrap` 恒空 map → 定向采集永不生效。另需 `NW_LOKI_PUSH_URL` 指向 metaserver 可达的 Loki（obs 栈独立网络，见 `observability/README.md` 网络坑）——留空则接受但静默丢弃。两 compose（cloud/prod）的 metaserver 段已补这三个 env。
- 验证：server 全 workspace typecheck 通过；metaserver 158 例 + shared 19 例 + matchsvc/gateway 单测通过；client tsc + webpack + 5 例 flag 单测通过；ops/admin tsc + ops build 通过。

> F3 通道既已建起，后续客户端侧 flag（maintenance_mode kill switch / 新 UI 灰度）可直接复用 `FeatureFlags.isOn(key)`。

### 2026-06-24 · 客户端异常事件「全量」上报通道（§9.7）

「内存超标自动上报」之上扩出**全网异常监测**：新增 CPU/主线程饱和、WebGL 丢失、卡死、未捕获异常、上次崩溃五类信号，全量直报 Loki（不受定向白名单约束），用于定位野外客户端异常。

**客户端**：
- `net/anomaly.ts`（新）：`AnomalyReporter` 单例（冷却 + 会话上限 + detail 截断 + 合批 fetch + 离场无凭据 keepalive fetch）；`reportAnomaly()` 统一入口；崩溃哨兵 `initCrashSentinel()`（启动检测上次异常退出并补报 + 心跳）+ `installAnomalyWatchers()`（错误旁路 / 离场急发 / `webglcontextlost` / ANR 看门狗 / `wx.onError`）。
- `cache/PerfMonitor.ts`（新）：挂 `app.ticker`，长任务忙碌比（`PerformanceObserver('longtask')`，Chromium）+ 持续低 FPS（处处可用）两路，越线报 `cpu`。阈值 localStorage 可调（`nw_fps_warn`/`nw_cpu_busy_warn`）。
- `cache/MemoryMonitor.ts`：`dump()` 在原 `netLog('mem').warn` 之外**并行** `reportAnomaly('mem', ...)`（全网内存超标计数）。
- `net/log.ts`：加 `recentClientLogs(n)`（崩溃面包屑 / 哨兵记最后错误）+ `setErrorSink`（未捕获异常旁路 → `jserror`，反向注入避免与 anomaly 成环）。
- `app.ts`：`new PerfMonitor().install(app.ticker)` + `initCrashSentinel()` + `installAnomalyWatchers({ canvas: app.view })`。

**metaserver**：
- `clientLog.ts`：加 `ClientAnomalyEvent` + `buildAnomalyLokiPayload`（单 stream，label `{source=client, kind=anomaly}`，type/publicId/platform/detail/msg 入行内 logfmt）。
- `service.ts`：`clientAnomaly`（`operationId`，**不受 allowPublicIds 约束**；按 IP 60s/30 次 `SlidingRateLimiter` 限流，超限静默 `accepted:0`；缺 publicId 记 `anon`；最多 200 条 + 各字段截断）。**永远回 200**。
- `contracts/openapi.yml`：补 `POST /client/anomaly`（公开，`config` tag）。
- 单测 `test/clientLog.test.ts` +6 例（payload 组装 + 未知 type→other + 全量转发不受定向约束 + anon + 400 + IP 限流）；route 装配经 `app.inject` 冒烟通过。

**验证**：metaserver `tsc --noEmit` + client `tsc` + webpack web build 全通过；clientLog 13 例通过。

**Grafana**：已加「客户端异常（全量上报）」面板 `observability/grafana/dashboards/client-anomaly.json`（uid `nw-client-anomaly`，folder-provisioned 自动加载）——按 type 堆叠速率 + crash 计数 + 事件总数 + 受影响玩家数 + 明细日志，模板变量 type/platform/publicId/关键字。

### 2026-06-27 · `mem` 上报补 PIXI 级泄漏定性计数（§9.7 mem）

**动机**：野外一台 web（publicId 233784986）堆从 ~1GB 4 分钟涨到 4012MB（贴 4192 上限）+ 伴 43/46/52s 真·可见卡死（ANR 看门狗 `!hidden` 才报，排除后台节流）。但 `poolTotal.estMB=0` → 不是战斗对象池，是纯 JS 保留型泄漏；原 `dump()` 只有「堆大 + 池空」，无法定位是哪一类。

**改动**（`client/src/cache/MemoryMonitor.ts` + `app.ts`）：
- `install(ticker, stage?)` 多收一个 `stage`（`app.ts` 传 `app.stage`——场景 `gameLayer` 在其下，计数是超集）。
- `dump()` 新增 `gpu:{tex,baseTex,nodes,tickers}`：`PIXI.utils.TextureCache`/`BaseTextureCache` 条目数、`app.stage` 下显示对象总数（栈式遍历，封顶 `200000`，到顶记 `"200000+"`）、`ticker.count` 监听器数。同时进 `log.warn` 与 `reportAnomaly('mem',...)` 的 detail（detail 仍 ≤800 截断内）。
- 仅告警时（mem 60s 冷却）跑一次，遍历封顶——不会让正在发生的卡死更重。
- 下次复现据三数定性：`tex/baseTex` 增=纹理缓存无界、`nodes` 增=退场不 destroy 的场景图残留、`tickers` 增=`ticker.add` 漏 `remove` 的闭包钉死，定位后再做退场审计。

**验证**：client `tsc --noEmit` 通过。

### 2026-07-15 · ANR 看门狗「后台节流误报」修复（§9.7 anr）

**动机**：同一台机器（publicId 233784986）当日贴出一整天的 `anr` 日志，`stallMs` 5000–57000 反复出现十几次，散布在 bootstrap/gateway 各种时刻，且早前 §9.7（2026-06-27）曾写下"ANR 看门狗 `!hidden` 才报，排除后台节流"——这个结论其实站不住：`installAnrWatchdog()` 只在 `setInterval` **回调触发的那一刻**采样一次 `document.hidden`，而不是"这段漂移窗口内是否曾经隐藏过"。真实场景：玩家切到后台（切 App / 锁屏），浏览器/系统把这个标签页的定时器整个挂起；玩家切回前台时，`visibilitychange` 先于被挂起的 `setInterval` 回调恢复执行——所以回调真正跑起来时 `document.hidden` 已经翻回 `false`，看门狗量出一个几十秒的"漂移"却误判成真卡死上报。

**改动**（`client/src/net/anomaly.ts` `installAnrWatchdog()`）：把"读一次 `hidden`"换成"锁存"——挂一个 `visibilitychange` 监听器，只要期间出现过 `hidden===true` 就把 `hiddenSinceLastTick` 锁存为 `true`，每次 tick 判断完就清零。这样"整段窗口内曾经隐藏过"和"当前仍隐藏"都会正确抑制误报，而全程可见的真实卡死不受影响。

**验证**：`client/test/anomaly-chain.test.ts` 新增 2 例（"隐藏整段时间但在挂起的 tick 执行前已切回前台→不报 ANR" + "全程可见的真实卡死仍然上报"，用 `vi.setSystemTime` 模拟时钟跳跃）；`tsc --noEmit` + 全量 vitest 通过。

**遗留**：本次只修了"看门狗误报"这一层，不能排除同一玩家 2026-06-27 那次"1GB→4012MB/4 分钟"的量级更夸张的堆增长是另一个真实的纯 JS 保留型泄漏——本次顺带排查了 `GameRenderer/events.ts`（escort/projectile 事件回收 + `destroy()`）和 `StickmanRuntime`（`.tao` 资源按 url 缓存 + 对象池 `reset()`），均未发现明显泄漏，但未覆盖全部场景退场路径。若同一 publicId 再次出现快速堆增长（而非本次这种"整天散布的中等 stall"），需要继续查 `nodes`/`tex`/`baseTex` 哪个先涨来定位类别（`MemoryMonitor.dump()` 的 `gpu` 字段已经能区分）。

### 2026-07-15（续）· anomaly 事件补 `buildVersion` 字段（§9.7 传输）

**动机**：同一 publicId 233784986 在上面的修复部署（`0861367`，18:59:44）之后仍贴出一批 `anr`（20-56s）+ 逐字重复的 pre-fix `blur`/`removeChild` 报错文本。搜了当前代码库确认所有 blur 处理器早已改成幂等 `.remove()`，不可能再抛这个错——唯一站得住的解释是这个玩家的标签页在部署**之前**就已经打开、之后一直没刷新，跑的是内存里的旧 JS（含未锁存的旧看门狗 + 旧 blur 竞态）。但当时的 anomaly 事件完全不带客户端版本号，只能靠"部署时间线 vs 日志时间戳"去推断，无法在 Grafana 里直接确认。

**改动**：`client/src/net/anomaly.ts` 新增 `readBuildVersion()`（复用 `client/src/analytics/index.ts` 已有的 `__NW_BUILD_VERSION__` 读取模式），`buildVersion` 随 `publicId`/`platform` 一起放进 `POST /client/anomaly` body 顶层（非逐条 event，同一会话共享一个值，省字节）。契约 `server/contracts/openapi/paths/telemetry.yml` 加了这个可选字段（`gen:api:contracts` + `gen:api:server` 重新生成）；`server/metaserver/src/clientLog.ts` `buildAnomalyLine`/`buildAnomalyLokiPayload` 新增 `buildVersion` 形参，写入 Loki 行内字段；`service/telemetry.ts` 的 `clientAnomaly` handler 从 body 读取、截断 32 字符后透传。

**验证**：`client/test/anomaly-chain.test.ts` 全链路接缝测试断言 body 里的 `buildVersion` 能一路传到 Loki 行（`buildVersion=0.0.0`，测试环境未烘焙）；`server/metaserver/test/clientLog.test.ts` 断言非空值写入行内（`buildVersion=0861367`）；client + metaserver `tsc --noEmit` 均通过，两处 vitest 全绿。

**用法**：以后同一 publicId 反复出现同一异常时，先用 Grafana `{source="client",kind="anomaly"} | logfmt | publicId="..."` 拉出 `buildVersion`，跟部署时间线对一下——版本落后于最近一次相关修复的部署时间，就是"旧 tab 没刷新"，不必再当新 bug 查。

### 2026-07-17 · `anr` 补场景/GPU 归因 + `mem` 补 `texTop` 纹理来源分类（§9.7 anr/mem）

**动机**：同一 publicId 233784986 又贴出一整天日志——`anr` `stallMs` 5–56s 反复、`mem` 堆 400–668MB，`gpu.baseTex` 反复冲到 1000+ 而 `nodes` 常常只有 43–52。两个盲点卡住定位：① `anr` 事件只有 `stallMs`，不知道冻结时在哪个场景、也没有栈；② `mem` 的 `baseTex` 只有一个总数，不知道这 1000+ 张纹理是哪来的。代码审计已确认：全部美术走 `PIXI.Texture.from(url)`/`BaseTexture.from`（cardArt/gachaArt/titleArt/CardScene.drawArtFit/建筑图），是**按 URL 键的全局永久缓存、无任何回收**；而 `PIXI.Text` 生成的纹理**不进** `BaseTextureCache`（无 cacheId），所以 `baseTex` 这个计数几乎全是"浏览过的美术资源"——强烈指向无上限的资源缓存，需要按目录分类来坐实是哪个美术文件夹在涨。

**改动**：
- `client/src/net/anomaly.ts`：新增 `setActiveScene(name)`（`SceneManager.swap` 每次挂载场景时用 `scene.constructor.name` 打点）+ `setAnrContextProvider(fn)`（供上层注入 GPU 计数，避免 net 层反向依赖 PIXI）。ANR 上报的 detail 现在带 `{ stallMs, scene, gpu:{tex,baseTex,tickers} }`。provider 抛错被吞，绝不影响上报。
- `client/src/cache/MemoryMonitor.ts`：`install()` 里注册 ANR provider（只读廉价计数，不在卡死当下走场景图遍历）；`dump()` 的 `mem` 上报新增 `texTop`——把 `BaseTextureCache` 的 key 按目录（`data:`/`blob:` 按 scheme）分组，取占比最高的 6 类，直接告诉我们是哪个美术目录在把缓存撑大。
- 服务端**无需改**：`detail` 早已是自由序列化字符串透传，新字段落在 detail 内。

**验证**：`client/test/anomaly-chain.test.ts` 新增 2 例（"anr detail 带 scene + provider 注入的 GPU 计数" + "provider 抛错不破坏上报"）；`tsc --noEmit -p tsconfig.test.json` 通过，anomaly 套件 12 例全绿。

**用法**：下次 `mem` 报警看 `texTop` 第一名的目录 + 计数 → 若单目录条目数随会话单调上涨，即为该类美术缓存无上限（下一步做 LRU/离场回收）。`anr` 看 `scene` 字段 → 反复冲同一场景即可锁定那段同步长任务（56s 冻结与纹理数无关，是独立的 compute stall）。

### 2026-07-17（续）· `anr.scene` 生产可读性修复（keep_classnames）+ 首批归因数据解读（§9.7 anr）

**背景**：上面的 `scene` 打点在生产**不可读**——web 生产构建 `devtool:false`（无 source map，仅 wechat 有），且 terser 默认 mangle `constructor.name`，`SceneManager` 打的场景名在线上被压成两字母别名。build `5b7f5c2` 首批日志即出现 `anr.scene` 为 `$t`/`Md`/`hf`。通过下载线上 bundle（`https://a.gamestao.com/<hash>.js`，hash 取自站点 `<script src>`，版本见 `/version.json`）+ grep nav 层实例化点（`showLobby→new $t` / `showShop→new Md` / `showWorldMap→new hf`）反解出：**`$t`=LobbyScene（当批卡死 3 次）、`Md`=ShopScene、`hf`=WorldMapScene**。卡死全在浏览类场景、无一在战斗——与内存/纹理压力一致。

**改动**：`client/webpack.config.js` `optimization.minimizer = [new TerserPlugin({ terserOptions: { keep_classnames: /Scene$/ } })]`——只对以 `Scene` 结尾的类（所有场景类）保名，其余照常压缩。生产构建已验证 `class WorldMapScene`/`LobbyScene`/`ShopScene`/`GameScene` 等在产物中原名存在；bundle 仅增 ~2.8KB（+0.15%）。此后 `anr.scene` 在 Loki 直接是真名，无需再反解。

**顺带修正上一条的结论**：`src/assets` 只有 48 个打包 PNG，stickman `.tao` 资产由 `StickmanRuntime._cache` 按 URL 缓存（每兵种一份，有界），两者都撑不起 `baseTex=716`——所以上一条"`baseTex` 几乎全是浏览过的美术"不准确，实际大头是**动态纹理**（远程/CDN 头像 URL、`blob:` spritesheet、或 `PIXI.Text` canvas）。具体归属仍等 `texTop`（该字段只在新构建 5b7f5c2 起才有，首批 `mem` 来自旧构建 5bca554 故缺失）。

**已知未修缺口**：`cpu` 事件不带 `scene`（PerfMonitor 只发 fps/threshold/sustained），持续低帧无法归因到界面；若复发，把 `anrContext()` 的 scene 折进 cpu detail 即可。

### 2026-07-26 · `PerfMonitor` 补「后台/遮挡节流误报」修复（§9.7 cpu）

**动机**：某 web 客户端（publicId 160491111）45 分钟内贴出 9 条 `cpu` "sustained low fps ~10"，间隔异常规律（≈101s 一次），且全程从未触发过"main-thread busy"（Long Tasks 观察器零命中）——说明主线程根本没被 JS 占满，问题不在计算量。这正是 2026-07-15 已经在 `installAnrWatchdog()` 修过的同一类根因：`PerfMonitor.onTick` 从建立起就没有任何 `document.hidden` 判断，标签页被切到后台或被其他窗口整体遮挡时，浏览器为省电会把该页 `requestAnimationFrame` 限流（这正是 `ticker.deltaMS` 唯一可用于估算 fps 的信号源），fps 因此合法地跌到个位数，与真实卡顿无关。

**改动**（`client/src/cache/PerfMonitor.ts`）：给 `PerfMonitor` 补上和 `installAnrWatchdog()` 一致的"锁存"逻辑——`install()` 时挂 `visibilitychange` + Page Lifecycle `freeze` 监听器，只要窗口累积期间出现过 `hidden===true` 就把 `hiddenSinceLastWindow` 锁存为 `true`；`onTick` 在每个采样窗口收尾时先检查这个锁存位，命中就整窗丢弃（不计入 busyRatio/fps 判定，也不累加 `lowFpsStreak`），避免一次背景节流污染的窗口拖慢或误触发后续的连续低帧判定。`uninstall()` 对称移除监听器。

**验证**：新增 `client/test/PerfMonitor.test.ts`（2 例：全程可见的真实持续低帧仍然上报 `cpu` + 采样期间出现过隐藏则不上报），仿照 `anomaly-chain.test.ts` 的 ANR 回归测试结构；`tsc --noEmit` clean，`vitest run test/anomaly-chain.test.ts test/PerfMonitor.test.ts` 17/17 green（未改动既有行为，纯加法）。

### 2026-07-18 · `texTop` 首次读数确认根因：裸 `removeChildren()` 泄漏 Text/Graphics 纹理（§9.7 mem）

**新一批日志**（build `e2b159f`，`texTop` 首次真正生效）：`https://a.gamestao.com`（CDN 美术）只占 `n=23`，`baseTex` 却有 3200+，其余全是 `pixiid_N`（每条 `n=1`）——说明泄漏源不是 CDN 美术，而是大量**各自独立、无共享 cache key** 的纹理。同批 `anr` 里 `scene` 已可读（`EquipmentScene`/`CardScene`/`LobbyScene`，验证了 §9.7 上一条 keep_classnames 修复已生效上线），卡顿 25–54s。

**根因**：`容器.removeChildren()` 只是从显示树摘除子节点，不会 `destroy()` 底层 GPU 纹理；`sketchUi.ts` 里 `txt()` 生成的 `PIXI.Text` 自己持有一份专属纹理，不摘除+销毁就一直挂着，直到 PIXI 内置 ~60s 纹理 GC 才回收——期间反复触发（每次点卡/装备格、每次开关弹窗、每帧滚动重绘）只会越攒越多，正好对应"停留在 Equipment/Card 越久堆越涨"的现象。项目早就有正确写法 `tearDownChildren()`（`sketchUi.ts:85`，Text 走 `destroy({texture:true, baseTexture:true})`，其余走 `destroy({children:true})`），只是没铺到这批模态层/徽标层代码。

**修复**：把 18 个文件里裸 `removeChildren()` 全部换成 `tearDownChildren()`——`EquipmentScene`(base/detail/reforge)、`CardScene`(base/detail/feed/list)、`LobbyScene/badges.ts`、`SectScene`(base/modals)、`AuctionScene`(base/bid/createForm)、`FamilyScene`(base/actions)、`worldmap/WorldMapPanels.ts` + `WorldMapRenderer/lifecycle.ts`（toast 层）、`CardCodexScene.ts`。最大头是 `CardScene/feed.ts` 的携手成长弹窗——拖动滚动时**每帧**都重建一次列表标签，一次滚动手势能泄漏几十次。`worldmap/WorldMapRenderer/pool.ts` 的 `removeChildren()` 不用改（调用前已手动 `s.g.destroy()`）。`tsc --noEmit` clean，`test:ui` 638/638 通过。真机复测需等下一批 `mem`/`anr` 日志：`baseTex` 应显著回落，`pixiid_N` 单例条目应基本消失。

**顺带假设**：25–54s 的 `anr` 卡顿本身还是独立未解问题，但不排除其中一部分其实是这个泄漏间接造成的——heap 涨到 GB 级后，JS 引擎的 major GC 本身就是同步阻塞主线程的，heap 越大单次 GC 停顿越久，理论上足以造成数十秒级的"卡死"而不需要真的有一行慢代码。泄漏修复后，如果这类超长 ANR 频率/时长明显下降，就基本坐实是 GC 停顿而非另一个独立 bug；如果还在，说明是真正的同步阻塞代码，需要靠下面的新埋点定位。

### 2026-07-18（续）· 新增 `longFrame` + `crumbs` 归因埋点，为剩余 ANR 卡顿收集更细数据（§9.7 anr）

**背景**：即使已知发生在哪个场景（`anr.scene`），watchdog 本身只是"墙钟时间漂移超过阈值"，无法区分卡顿是（a）该场景自己的 `update()`/`render()` 里跑了一段很慢的同步代码，还是（b）根本不在我们的 ticker 里——浏览器合成器停顿、GC 停顿、后台节流的边界情况。这个区分正是继续查 25–54s 卡顿的下一步所缺的信息，用户明确同意"日志里收集的信息你可以随便加"。

**新增两类归因数据，都折进 `anr` 事件的 `detail`**：
- **`longFrameMs` / `longFrameScene`**：`SceneManager.onTick`（`client/src/scenes/SceneManager.ts`）现在用 `performance.now()` 精确计时每一次 `scene.update()` 调用，只要单次调用 ≥200ms 就记录到 `net/anomaly.ts` 的 `recordFrameSample()`（新增导出）。`anr` 上报时如果 60s 内有过这样的慢帧，就带上其时长+场景名。**如果 `longFrameMs` 数值接近 `stallMs`，说明卡顿真的是某个场景一次 `update()` 调用卡住了（同步阻塞，可复现、可优化）；如果 `longFrameMs` 缺席或远小于 `stallMs`，说明阻塞发生在我们自己的渲染代码之外**（大概率是 GC 停顿或系统级）。
- **`crumbs`**：`anr` 上报现在也带上最近 12 条 `recentClientLogs()` 环形缓冲（此前只有 crash/exit-flush 才带），格式同 `[level:tag] msg`——多数是 `crumb:info:api`/`crumb:info:gateway` 这类网络层事件，卡顿前最后一次网络活动是什么，有时候本身就是线索（例如卡顿前一刻正在等一个从未返回的请求）。

`tsc --noEmit` clean；`test/anomaly-chain.test.ts` 12/12、`client/test/ui/scenes.ui.ts` 83/83 不受影响（未改动其结构，纯加法）。**下一步**：等下一批线上 `anr` 日志，看 `longFrameMs` 是否出现、是否接近 `stallMs`——这会直接决定卡顿是"某个场景的慢同步代码"还是"GC/系统级停顿"，两条路径的修法完全不同。

### 2026-07-18（三续）· 补 `longConstruct` 归因，覆盖 `scene.update()` 之外的另一段同步路径（§9.7 anr）

**验证结果**：上一条埋点上线后拿到的下一批线上 `anr`（build `7d16ec4`/`8175930`，均已包含 `tearDownChildren` 泄漏修复的祖先提交，`baseTex` 已从 1000-3200+ 降到 100-450，确认泄漏修复生效）里，`stallMs` 8982-53151 的多条 `LobbyScene`/`FriendsScene`/`LeaderboardScene` 冻结**全部没有 `longFrameMs`**——排除了"某场景 `update()` 卡住"。但泄漏修复后 baseTex 大降，卡顿时长却没有变短（甚至出现比修复前更长的 53s），也削弱了"堆越大 GC 停顿越久"这个假设。

**盲区定位**：`recordFrameSample` 只计时 `SceneManager.onTick` 里的 `scene.update()` 调用，但 `goto()` 导航还有另一段完全同步、且完全没被计时的路径——`new XxxScene(...)` 构造函数本身（`client/src/app.ts` `PixiAppViews` 的每个 `showXxx()` 方法都是 `new XxxScene(...)` 后立即 `manager.goto()`）。场景构造函数在挂载/被 tick 之前就跑完了列表建行、布局、文本纹理等全部同步 UI 搭建工作，这条路径此前完全是黑的。

**新增 `longConstructMs`/`longConstructScene`**：`net/anomaly.ts` 新增 `recordConstructSample(scene, ms)`（同 `recordFrameSample` 的模式，≥200ms 才记，60s 内附到下一次 `anr` 上报）；`PixiAppViews` 新增私有 `timedBuild(name, build)` helper，包住全部 ~30 处 `new XxxScene(...)` 调用计时（当时在 `app.ts` 里；2026-08-17 起 `PixiAppViews` 整体搬到 `client/src/app/PixiAppViews.ts`，行为不变，覆盖见 `test/ui/pixiAppViews.ui.ts`）。**若 `longConstructMs` 接近 `stallMs`，说明卡顿其实发生在场景构造阶段（可复现、可优化，大概率是某个场景进入时同步建了太多 UI/纹理）；若仍然缺席，才真正指向 GC/系统级停顿或渲染代码之外的阻塞**。

`tsc --noEmit` clean。**下一步**：等下一批线上 `anr` 日志读 `longConstructMs`——这应该能把 LobbyScene/FriendsScene/LeaderboardScene 反复出现的卡顿最终定位到"哪个场景的构造函数"或彻底排除掉这条路径。

### 2026-07-18（四续）· 补 `longRender` 归因，覆盖 PIXI 渲染调用本身（§9.7 anr）

**验证结果**：`longConstructMs` 上线后拿到的下一批线上 `anr`（build `85c3448`，`merge 85c34488` 之后，确认已包含该字段）——`stallMs` 4227-29672 的多条 LobbyScene/LeaderboardScene/GachaScene 冻结，`longFrameMs` 和 `longConstructMs` **同时缺席**。两条已知的同步路径（`scene.update()`、场景构造函数）都被排除了。

**新盲区定位**：`PIXI.Application` 把它自己的渲染调用挂在共享 ticker 的 `UPDATE_PRIORITY.LOW`，而 `SceneManager.onTick` 用的是默认（`NORMAL`）优先级——两者顺序固定是 `onTick` 先跑，PIXI 的 `renderer.render(stage)` 后跑。也就是说真正的 GPU draw-call 提交、以及它同步触发的 `PIXI.Text` canvas 光栅化，完全落在 `recordFrameSample` 的计时窗口之外,是第三条、此前完全没被计时的同步路径。

**新增 `longRenderMs`/`longRenderScene`**：`net/anomaly.ts` 新增 `recordRenderSample(ms)`（同前两个埋点的模式，≥200ms 才记，60s 内附到下一次 `anr` 上报，场景名复用已有的 `activeScene`）；`app.ts` 在创建 `PIXI.Application` 后直接包一层 `app.renderer.render`（`origRender = app.renderer.render.bind(...)`，替换为计时后转发的版本),不依赖 ticker 优先级顺序,直接量渲染调用本身的耗时。**若 `longRenderMs` 接近 `stallMs`,说明卡顿发生在渲染阶段(大概率是某场景当帧同步创建/更新了大量 `PIXI.Text`,触发密集 canvas 光栅化);若三条路径都缺席,才真正确认是渲染代码之外的 GC/系统级停顿,此时应该把方向从"继续加归因埋点"转向"降低整体堆内存压力/分配速率"。**

`tsc --noEmit` clean,`anomaly-chain.test.ts` 12/12 green(纯新增,未改动既有行为)。未提交(当日分支 `18.07.2026`)。**下一步**：等下一批线上 `anr` 日志读 `longRenderMs`——这是当前归因链条里最后一段未覆盖的同步路径,读到结果后三选一都有明确后续动作。

### 2026-07-18(五续)· Long Tasks + Page Lifecycle + 堆增量,补三条"应用代码之外"的信号(§9.7 anr)

**动机**：问题已经持续一周,`longFrameMs`/`longConstructMs`/`longRenderMs` 三条同步路径埋点陆续上线后,用户明确要求"更深入探查/加更多日志"。这三个埋点的共同局限是——它们都只能看见**我们自己代码**跑了多久;如果卡顿根本不是应用代码造成的(真·GC 停顿、或标签页被系统挂起而 `visibilitychange` 没能及时反映),三个字段会全部缺席,却给不出"那到底是什么"的下一步线索。这次加的三个信号专门补这个盲区：

1. **`longTaskMs`/`longTaskCount`**(Long Tasks API,仅 Chromium)：`PerformanceObserver({type:'longtask'})` 独立于我们自己的计时,能看到主线程上**任何** ≥50ms 的任务,不管是不是我们的代码触发的(第三方脚本、浏览器内部 layout/style、或嵌在当前任务里跑的同步 GC)。价值在于反向验证：如果卡了几十秒但这段窗口里**完全没有** long task 记录,说明主线程根本没在跑 JS——真正指向"线程被系统挂起"这类边界情况,而不是慢代码或 GC。`net/anomaly.ts` 新增 `installLongTaskObserver()` + `longTasksSince(since)`,窗口起点用 watchdog 的 `expected - WATCH_MS`(即上一次已知正常 tick 的时间)。
2. **Page Lifecycle `freeze`/`resume` 事件**(仅 Chromium)：比 `visibilitychange` 更强的挂起信号——部分系统级挂起路径(后台 CPU 预算耗尽等)只触发 `freeze`/`resume`,不一定翻转 `document.hidden`,这正是 07-18 第三批记录里提到但没修的那个盲区("`visibilitychange` 锁存是否有遗漏的挂起模式")。`installAnrWatchdog()` 里新增 `document.addEventListener('freeze'/'resume', ...)`,`freeze` 和 `hidden` 一样锁存(抑制误报),两者都记一条 `[info:anomaly]` crumb,即使没有抑制到报告,也能在 `crumbs` 里看到冻结/恢复配对。
3. **`heapMB`/`heapDeltaMB`**(仅 Chromium `performance.memory`)：每次 `anr` 上报时采样一次已用堆,和上一次采样做差。如果一次长卡顿伴随堆大幅下降,是"这段时间跑了一次大 GC"最接近的同批证据;如果长卡顿堆没怎么变,削弱 GC 停顿假说。

`anrContext()` 签名改为 `anrContext(stallSince?: number)`,`installAnrWatchdog` 调用时传入 `expected - WATCH_MS`。三个信号全部 feature-detect,不支持的浏览器(WeChat/Safari/Firefox)直接不生效,不影响现有上报。`tsc --noEmit` clean,`anomaly-chain.test.ts` 12/12 green,`client/test/` 全量 735/735 green(纯新增,未改动既有行为)。未提交(当日分支 `18.07.2026`)。

**下一步**：等下一批线上 `anr` 日志,同时读六个字段(`longFrameMs`/`longConstructMs`/`longRenderMs`/`longTaskMs`/`longTaskCount`/`heapDeltaMB`)。三条"自己代码"路径 + longTask 都缺席 → 强烈指向真正的线程挂起(边界情况,考虑加更激进的挂起检测或直接接受为不可控);`heapDeltaMB` 大幅下降 → GC 停顿证据变实;`freeze`/`resume` crumb 配对出现在卡顿前后 → 是挂起检测的盲区被证实,需要扩大抑制逻辑或干脆把这类样本从"ANR"里过滤掉(它其实是正常的系统级挂起,不是 bug)。

### 2026-07-20 · 确认「真挂起」后不再上报,而非继续加埋点(§9.7 anr)

**动机**：2026-07-20 拿到 build `dc57b610`/`e530218d` 的第一批「六字段全部部署」线上日志——11 条 `anr`(4-54s)**全部**同时缺席 `longFrameMs`/`longConstructMs`/`longRenderMs`/`longTaskMs`/`longTaskCount`,而 `heapMB` 每条都有值(说明这些浏览器确实是 Chromium,Long Tasks API 的"零任务"读数不是"不支持"的假阴性,是真的零)。按 §9.7 一路铺垫的判定链:三条自己代码路径 + Long Tasks API 全暗 = 主线程这段时间根本没在跑 JS = 系统/浏览器级线程挂起,不是能修的应用 bug。此时用户明确要求:"目前只有三个人,每天都上报几百条日志,上线后没法辨别真假问题;如果认为是系统问题、我们修不了,就不要上报"。

**实现**:`installAnrWatchdog()` 里,当 `longTaskObserverActive`(Long Tasks observer 已确认在跑)且这次 stall 窗口内 `longTasksSince(...)` 返回空(即 `anrContext()` 的结果里没有 `longTaskMs`)时,判定为"确认的系统级线程挂起",**不再调用 `reportAnomaly('anr', ...)`**,只留一条本地 `log.info` 方便本机调试。其余情况(observer 不支持/未激活的浏览器,或确实观测到 long task 说明主线程真的在跑东西)照常上报——保证在证据不足以下结论时,宁可多报不误杀。

**为什么只查 `longTaskMs` 一个字段就够**:Long Tasks API 捕获主线程上**任何**来源、≥50ms 的任务,包括我们自己的 `scene.update()`/构造函数/`renderer.render()`——所以只要 `longFrameMs`/`longConstructMs`/`longRenderMs` 里有一个会触发,对应的时间窗口也必然会被记成一次 long task。反过来,`longTaskMs` 缺席时,这三个字段也必然同时缺席,单独查它是这四个信号里最强、最简洁的充分条件。

`net/anomaly.ts` 新增 `longTaskObserverActive` 标志(在 `installLongTaskObserver()` 里,`observe()` 调用成功后置位,和"是否支持"绑在一起,不依赖是否观测到过任何具体的 task)。`anomaly-chain.test.ts` 新增 2 条回归测试(用 fake `PerformanceObserver` 模拟"激活但零 task" vs "激活且有重叠 task"两种场景),14/14 green,`tsc --noEmit` clean。范围**只限于 `anr`**——`mem`/`cpu`/`jserror`/`crash` 没有等价的"已确认不可修"证据链,继续照常上报。

### 2026-08-02 · `mem` 上报补 `scene` 归因字段(§9.7 mem)

**动机**：Loki 排查 publicId `233784986` 一批日志时,`601c1b5` 构建下 `nodes` 从常见的 350-390 短暂飙到 1487-1507(约 30 分钟后自愈回落),但当时的 `mem` 上报没有场景信息,无法确认是哪个界面撑起了这些节点——只能靠猜。`anr` 早在 2026-07-17 就已经带 `scene`(`setActiveScene`/`activeScene`),`mem` 一直没接上。

**实现**:`net/anomaly.ts` 新增 `getActiveScene()` 导出(读 `anr` 路径已有的 `activeScene` 变量,不改变其写入方式);`cache/MemoryMonitor.ts` 的 `dump()` 在 `reportAnomaly('mem', ...)` 的 detail 里补一个顶层 `scene` 字段(与 `anr` detail 里的 `scene` 同名同形状)。`tsc --noEmit` clean,`anomaly-chain.test.ts` 15/15 green(未改动既有断言,新增字段不影响已有用例)。同一会话顺带确认:那批 `type=crash` 日志并非真实崩溃,只是 `flushBeacon()` 在标签页切后台时顺带发出的面包屑(Loki 全量 30 条里没有任何一条带 `aliveMs`/`lastError` 的真实崩溃摘要行)。

### 2026-08-24 · anomaly 通道补设备/朝向归因，并修转屏路径上的两处开销（§9.7 传输/入 Loki）

**动机**：用户报「手机上页面极易崩溃，尤其横屏切竖屏时」，并要求「目前的追踪没有按平台区分也要修复，不然以后很难定位问题」。查 Grafana 近 7 天 `type=crash`：绝大多数是已知的「后台挂起误报」类（`aliveMs` 几十万到上千万毫秒，会话其实跑了很久，只是没走到 `pagehide`）；但有一组是真的——publicId `678315307` 在 2026-08-22 16:10:43–16:11:10 UTC **27 秒内启动 3 次、每次都在 15s 心跳之前被杀**（`aliveMs:0`），且前后**没有任何** `mem`/`anr`/`webgl_lost`/`jserror`，说明死得太快，连 JS 层的异常通道都没机会触发。

**排查中撞上的真正问题**：想确认「这是不是手机」时发现——**做不到**。anomaly 通道唯一的上报方属性 `platform` 是构建目标，手机和桌面同为 `web`；朝向从未采集。最后是靠 analyticsvc 侧的 `ua`/`screen_w` 与 metaserver access log 做时间线对齐才确认设备（iPhone 12/13 类，390×844@dpr3，**且是 Google App 的 WKWebView 内嵌浏览器**，不是独立 Safari——内嵌 WebView 的内存上限远比 Safari 紧，被系统直接杀掉进程而非报错，与 `aliveMs:0` + 无任何前置信号的现象吻合）。这条链路太绕且不可复用，正是用户要求修的那个缺口。

**改动**：
1. **`net/anomaly/deviceContext.ts`（新）** — 会话级 `device`/`dpr`/`mem` + 事件级 `orient`/`vp`/`sinceRot` + 转屏监听。`device` 只上报 4 值粗分桶而非 UA 原文（行内字段既怕高基数也怕隐私）；分类刻意处理两个坑，两者都朝**隐藏移动端**的方向出错：Android 平板不带 `Mobile` token（「含 Android 即手机」是错的）、iPadOS 13+ 以 MacIntel + Macintosh UA 伪装桌面（只能靠触点数区分）。转屏监听同时挂 `screen.orientation change`/`orientationchange`/`resize` 三路，但**只在派生朝向真的翻转时**才记一次——一次物理转屏触发的多个事件因此收敛成一条记录，而键盘/浏览器工具栏那些「不是转屏的 resize」被忽略。
2. **`sinceRot` + 哨兵持久化** — 见 §9.7 的两条子说明（crash 必须描述死掉的那次会话；哨兵改为转屏即写盘）。
3. **`PixiAppViews.onResize` 拆成「立刻重贴画布 / 延后重建大厅」** — 原先两半都同步跑在**每一个** resize 事件上。一次物理转屏 iOS 会在动画过程中逐步上报视口、连发多个 resize，于是一次转屏 = N 次大厅整场景拆建 = N 轮纹理翻搅，而此刻 WebView 已经在为帧缓冲重分配付账；在内存受限的内嵌 WebView 上，这是渲染进程被直接杀掉的一条合理路径。现在：重贴画布仍然同步（否则画布可见地跟不上视口），重建走 180ms 合并窗口。**外加一道等价重要的空转闸**——原来连「尺寸根本没变」的 resize 都会重建大厅一次，而移动浏览器为工具栏滑动/软键盘/滚动收起工具栏等**根本不是 resize 的事情**频繁发这个事件。`leaveLobby()` 同步取消待执行的重建：转屏后立刻点进别的界面，否则那次排队的 `showLobby()` 会在 180ms 后把玩家从刚进的界面拽回大厅。
4. **`idlePrefetch` 转屏期间让路** — `requestIdleCallback` 单独不够：转屏的开销大部分**不在主线程**（帧缓冲重分配、纹理重传），所以 GPU 与内存压力峰值时主线程反而看起来空闲。往这个窗口里塞一张几 MB 的纹理解码是最差时机，而内存受限 WebView 的失败模式不是变慢、是进程被杀。等待对预取零成本：每一波本就是投机的，场景闸会重新 await 同样的 loader。有 `MAX_QUIET_WAITS` 上限，来回翻手机不会把预取永久停住。

**证据强度（如实记）**：真实崩溃样本 **n=1**，且遥测本身当时缺设备/朝向字段，无法在统计层面确认。时间线对得上（该构建含 2026-08-17 的加载优化 `132a83e9`），代码里也确实存在「resize 同步重建大厅」与「idle prefetch 大图解码」撞车的路径——这是目前唯一站得住脚的机制假设，但仍是**假设**。3 和 4 两项独立于该假设也都是实打实的浪费，值得修；1 和 2 的价值恰恰在于：下一次再发生，就不必再走一遍 analyticsvc 对时间线的迂回路。

**验证**：client `npm run typecheck` clean、`server npm run typecheck` clean；新增 `client/test/deviceContext.test.ts` 20 例（含一条把 `orientation()` 与 layout 层 `detectOrientation()` 钉在一起的用例——deviceContext 刻意不 import 后者以免把 PIXI/engine 拖进崩溃上报路径，那份重复只在两者一致时才安全）；`anomaly-chain.test.ts` 15→18 例（新增 crash 携带死亡会话朝向、未转屏不带 `sinceRot`、转屏即写盘）；`pixiAppViews.ui.ts` 13→16 例（一次转屏只重建一次、空转 resize 直接忽略、离开大厅取消待执行重建）；`idlePrefetch.ui.ts` 7→10 例（转屏期间延后、未转屏不延后、连续转屏有上限）；`clientLog.test.ts` 16→19 例（会话字段每行都盖、朝向按事件、白名单外的值直接丢弃、`sinceRot` 取整）。

---

## 2026-08-25 — 手机崩溃定案：不是转屏，是整页 bake 按渲染器分辨率烘出的百 MB 纹理

**新证据**：同一个 publicId `678315307` 又崩了一串，这次带上了 2026-08-24 那批遥测。8 条 `type=crash`，51 秒内 6 次启动、每次 `aliveMs:0`，全部 `device=phone dpr=3 orient=landscape vp=750x270`，且——关键——**一条 `sinceRot` 都没有**。

**这直接否掉了 08-24 的假设**。`sinceRot` 缺席意味着那些会话从出生到死**从没翻过朝向**：它们是横屏启动、横屏死的，转屏路径根本没进。08-24 那条「一次转屏 = N 次大厅重建」的机制假设到此结案为**不是本次崩溃的原因**（那两项修复本身仍然是实打实的浪费，不回退）。上一条记录里写的「下一次再发生，就不必再走一遍 analyticsvc 的迂回」兑现了：这一轮没有查任何服务端日志，靠三个新字段就把范围缩到了「横屏、这个视口、启动即死」。

**`vp=750x270` 是怎么来的**：iPhone 13 横屏 844×390，刘海左右安全区各 47 → 宽 844−94=750；宿主 App 的上下 chrome 约 120 → 高 390−120=270。即 08-24 已确认的那个内嵌 WKWebView，宽高比 **2.78:1**。

**根因（代码层，可算出精确数字）**：
- `LandscapeLayout` 的 `designWidth = max(1920, 1080 × availW/availH)`，**当时无上限** → 2.78 的宽高比撑出 **3000×1080** 的设计矩形。
- `render/bake.ts` 用 `resolution: renderer.resolution`，而它等于未加限的 `window.devicePixelRatio` = 3。
- 于是每张整页 bake 是 **9000×3240 = 111 MB**。`gameLayer.scale` 是 0.25，也就是这张纹理最终只映射到 750×3 = 2250 设备像素上——**每轴过采样 4 倍，像素数浪费 16 倍**。
- 大厅一次画**三张**（`lobbybg` / `decorc` / `wear`），首屏一次性向内存受限的 WKWebView 要 **334 MB**。系统直接杀渲染进程：`aliveMs:0`、无 `jserror`（不是 JS 异常）、无 `webgl_lost`、无 `mem`。

**为什么四个通道全瞎**：`MemoryMonitor` 盯的是 JS 堆（GPU 侧看不见）+ **generated 纹理的个数**——三张 111 MB 的纹理在计数口径里就是 **3**，对着 600 的预算毫无反应。「少而巨大」这件事，计数这个量纲根本表达不出来。

**改动（见 ADR-073）**：整页 bake 改按 `renderer.resolution × gameLayer.scale` 烘（设备像素 1:1，画质零损失）；`LandscapeLayout` 加 2.4:1 上限；`MemoryMonitor` 新增**字节**口径（`texMB`/`genMB`/`largest`/`bake.top`）并给字节单独设预算，`mem` 与 `anr` 两种报告都带上。

**顺带发现并修掉的隐患**：视口在启动瞬间读到 0（隐藏标签页/未布局的内嵌页，与 `resettledLayout` 同源的 WebKit 未定型问题）时，`createLayout(0,0)` 会算出 1/2000 级别的 scale，新逻辑会把整页 bake 烘成 1/16 分辨率的糊图。已加 `MIN_PAGE_RES = 0.25` 下限兜底；真视口到达后靠「分辨率进 cache key」自动重烘。这个隐患是在本机 Browser 面板（`visibilityState: hidden`）里实测撞到的，不是推演。
