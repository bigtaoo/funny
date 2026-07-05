# 服务端（server/）

设计基准：`design/game/`（`META_DESIGN.md` / `SERVER_API.md` / `META_TASKS.md` / `ECONOMY_BALANCE.md`）

## 架构关键约束

- **M12**：metaserver/gateway/gameserver 严禁 import `client/src/game`；`PlayerCommand` 作 `bytes` opaque 转发不解码
  - **`@nw/engine`（G3-2b-0，2026-06-21）**：确定性模拟内核已抽成独立 library workspace `server/engine/`（不是进程；与 `@nw/shared` 同范式）。worldsvc/gateway `import '@nw/engine'` headless 跑权威围攻 / 自复算是 **M12 的设计许可例外**（SLG_DESIGN §16.3「裁判」），且引擎已是单一来源包、非 `client/src/game`——M12「严禁 import client 引擎」约束不破。client 反过来经 webpack/tsconfig/vitest alias 引 `../server/engine/src`（旧 `client/src/game/*` 留再导出 shim）。详见 SLG_DESIGN §16.7。
- **M16**：gameserver 永不连库，身份来自 ticket
- **乐观锁**：存档/钱包 `findOneAndUpdate({_id, rev})` 守卫；rev 不匹配返回 409
- **三通道**：玩家只触达 `meta`(REST) + `gateway`(WS `/gw?token=`) + `game`(WS `?ticket=`)
- **内部认证模型（S12-1，`@nw/shared/internalAuth.ts`，SERVER_API §8.0）**：内部端口三道纵深——①网络隔离(端口不绑公网/不经反代，第一道)；②玩家/服务密钥命名空间分离(内部路由**从不校验玩家 JWT**，只认 `X-Internal-Key`→玩家 JWT 结构性 401)；③集中校验器 `createInternalAuth`（timing-safe + caller 识别 + 可选 per-caller 密钥）。默认 `NW_INTERNAL_KEY` 单一共享(零变更)；配 `NW_INTERNAL_KEYS=caller=key,...` 启用 per-caller 严格(泄露局部化/可轮换/可识别)。调用方统一 `internalHeaders(caller, key)` 出站。**ticket HMAC 仍只用 `NW_INTERNAL_KEY`**(双方须同一把)，不走 per-caller 注册表。被调方=meta/commercial/matchsvc/gateway/analyticsvc
- **钱包权威**：`SaveData.wallet.coins` 是只读镜像；商业操作经 commercial → meta 编排 → 回推
- **PvE 服务器权威**：通关/升级走 `/pve/clear`、`/pve/upgrade` API；`SyncPatch` 只同步 `equipped`/`flags`

## 9 个应用进程（+ mongo/redis 基础设施）+ 端口

| 进程 | 端口 | 说明 |
|---|---|---|
| metaserver | 18080 | REST，无状态，可横扩 |
| gateway | 8086 | 控制面 WS，account→socket |
| matchsvc | 8091 (internal) | 私有匹配大脑，不连库 |
| gameserver | 8081 | 数据面 WS，哑中继 |
| commercial | 18082 | 钱包/交易，玩家不可达 |
| admin | 18083 | 运维后台后端，玩家不可达 |
| worldsvc | 18084 | SLG 大世界，公网第四面 |
| analyticsvc | 18085 | 埋点分析，fire-and-forget |
| socialsvc | 8085 | 社交第五面（家族/好友/邮件/频道/push路由） |
| mongo | 27017 | 副本集（单节点） |

**Windows TCP 排除端口注意**：`netsh interface ipv4 show excludedportrange` 查被 WinNAT/Hyper-V 保留的端口段，撞上换端口（8082/8083 曾被保留，现用 8086）。

## 构建链

- **metaserver REST 路由（ADR-023，2026-06-30）**：`contracts/openapi.yml` → `server/contracts/scripts/gen-openapi-server.mjs` → `metaserver/src/generated/routes.gen.ts`（已入库）。改动 openapi.yml 后在 `server/metaserver/` 跑 `npm run gen:api:server` 重生成，再提交。CI 验证用 `npm run gen:api:server:check`（文件过期则失败）。坏 spec（如未加引号的逗号）在 codegen 阶段直接报错，不进运行时。

## 启动（dev）

```powershell
cd server
docker compose up -d        # MongoDB 副本集（⚠ 须 Linux containers 模式：docker context use desktop-linux）
npm install
npm run dev:all             # 起全部进程（dev-up.ps1）
```

> **worldsvc e2e 无需 Docker**：`npm test -w @nw/worldsvc` 会经 vitest `globalSetup`（`test/globalSetup.ts`）用 `mongodb-memory-server` 自动起单节点 rs0（首次下载 mongod `7.0.14` 到全局缓存 `~/.cache/mongodb-binaries`，之后离线复用）。设了 `NW_MONGO_URI` 则完全让路给外部 Mongo。适用于 Docker 锁 Windows 模式时跑 SLG e2e。当前 **203 例全绿**。
>
> **socialsvc e2e 无需 Docker（2026-07-02 补齐）**：`npm test -w @nw/socialsvc` 同款骨架，但因 socialsvc 只用单文档原子操作、无事务，起**单机 mongod**（`MongoMemoryServer`，非副本集），mongod 版本同锁 `7.0.14` 共用缓存。覆盖 Family/Friend/Mail 三服务层共 **38 例**（`test/{family,friend,mail}.e2e.test.ts`，内存假 meta/gateway 见 `test/harness.ts`）。详见 `design/game/SOCIAL_SVC_DESIGN.md §6`。
>
> **nation-bonus / base-siege e2e 数值漂移修复（2026-07-02）**：ADR-026 攻城值改制 + PvP 锚点重平衡后，`worldsvc/test/{nation-bonus,base-siege}.e2e.test.ts` 里两处硬编码的攻方兵力断言失效（旧「760 破 500」「12 卡碾两波」在新引擎下已不成立）。用探针脚本在真引擎里扫出新阈值后重定：nation-bonus 攻方 760→**815**（破 500、破不了国战加成的 575），base-siege 攻方 12→**20 卡**（清两波单卡波，新临界 16）。纯测试对齐，非引擎改动。
>
> **commercial / admin / analyticsvc e2e 无需 Docker（2026-07-02 补齐）**：三包同款 `mongodb-memory-server` 骨架（单机 mongod，非副本集，均无事务）接上后，之前因本地无 Docker Mongo 而**从未真正跑过**的 e2e 首次全部执行，commercial 71 例、analyticsvc 17 例、admin 27 例（含 15 例 `service.e2e.test.ts` + 6 例 `comp-mail.e2e.test.ts` + 6 例 `season-audit.e2e.test.ts`）全绿。跑起来后揪出两处真问题（见下一条 + `service.e2e.test.ts`「initiator cannot approve own ticket」用例补了第二个 ops 账号，避免撞上「无其他合格审批人时允许自批」的单超管例外）。
>
> **系统邮件写入权威修复（2026-07-02，见 `SOCIAL_DESIGN.md` S6-3 / `META_TASKS.md` S6-3、S7-3）**：P2 把 `GET /mail` 读路径迁到 socialsvc 代理后，`insertSystemMail`/`bulkInsertSystemMail` 的**写路径**一直漏改，还在写 meta 自己那个没人再读的 `mail` 集合——运营补偿工单/赛季结算奖励/活动奖励/PvE 警告邮件全部"发出去"但玩家永远收不到。commercial/admin 接上内存 Mongo 让 `admin/test/comp-mail.e2e.test.ts` 首次真正跑起来，才暴露这个「契约接好但从没跑过」的缺口（该测试文件头部注释原话）。修复：`metaserver/src/mail.ts` 的两个函数改为委托 `MetaSocialsvcClient.insertSystemMail/bulkInsertSystemMail`（真调 socialsvc 早已实现但从未被接上的 `/internal/mail/system{,/bulk}`），4 个调用点（`internal.ts` 补偿工单单发/全服群发 + ranked ELO 懒迁移、`ladderSeason.ts` 赛季结算、`events.ts` 活动奖励、`service.ts` PvE 警告）全部改线；全服群发场景信任 socialsvc 自己 push，meta 不再重复推。`comp-mail.e2e.test.ts` 同步升级为真起一个 socialsvc 子进程（复用同一内存 Mongo）做完整三进程联调，6 例全绿。

### 本地全栈模拟（完整：9 进程 + 主客户端 + 3 工具 + mongo + redis）

`docker/docker-compose.local.yml` 拉起**全部 9 个服务端进程 + redis + 主客户端(nginx) + animator/level-editor/ops 三个工具前端**，每次 up 都 `--build`（从当前代码重建镜像）。编排文件在 `docker/`，所有 build context 相对它写（`../` = 仓库根），并 pin 了 `name: funny` 保持项目名/数据卷不变。

```powershell
./docker/local-up.ps1              # 构建最新代码 + docker compose，浏览器开 http://localhost:8088
./docker/local-up.ps1 -Fresh       # 先清空 mongo 数据卷
./docker/local-up.ps1 -Port 9000   # 换主游戏入口端口（客户端地址构建期烘焙，须重建 nginx 镜像）
./docker/local-down.ps1            # 停（保留 DB）；-Fresh 连数据清
```

> **脚本编码**：`local-up.ps1`/`local-down.ps1` 含中文，**必须存为 UTF-8 with BOM**——否则 Windows PowerShell 5.1 按系统 ANSI 码页解析多字节字符，会把含中文的字符串引号读错而整脚本解析失败（`Missing closing ')'`）。改这两个脚本后务必保留 BOM。

**前端地址**（宿主机端口）：

| 地址 | 说明 |
|---|---|
| http://localhost:8088 | 主游戏（nginx 同源 SPA + 反代） |
| http://localhost:9091 | animator 动画编辑器 |
| http://localhost:9092 | level-editor 关卡编辑器 |
| http://localhost:9093 | ops 运维后台（跨源调 admin :18083；种子账号 `admin`/`admin123`） |
| http://localhost:18083 | admin 运维后端（仅 ops 前端访问） |

nginx 同源反代（`client/nginx.conf`）：`/` SPA · `/api/`→metaserver:8080 · `/gw`→gateway WS · `/ws`→gameserver WS · `/world`,`/family`,`/auction`→worldsvc:18084（不剥前缀）· `/social`→socialsvc:8085 · `/analytics`→analyticsvc:18085。worldsvc 内部需 redis + gateway/commercial/meta 内网基址；socialsvc 内部需 gateway 内网基址；analyticsvc/worldsvc/socialsvc 不暴露宿主，仅经 nginx。

**容器内端口与 dev 不同**：镜像里各进程固定监听 metaserver:8080 / gateway:8082(内部 8090) / gameserver:8081 / commercial:8092 / matchsvc:8091 / worldsvc:18084 / admin:18083 / analyticsvc:18085（dev 裸跑的 18080/8086 等仅 webpack 注入默认值用）。

**工具镜像**：animator/ops 自带上下文构建；level-editor 的 Dockerfile 用**仓库根**作上下文（webpack `@game` alias 引用 `client/src/game`，需把 client/src 拷进镜像）。

**构建期网络坑**：并行构建 5 个镜像会让多个 `npm ci`/sharp 下载同时抢慢速外网，触发 EIDLETIMEOUT/ECONNRESET/aborted。`local-up.ps1` 已改为**逐镜像串行构建**（`metaserver→nginx→animator→level-editor→ops`，server 镜像 7 进程共用只构建一次）后再 `up --wait`；工具镜像另加了 npm fetch 超时/重试。某镜像若仍因网络中断，直接重跑——已构建层有缓存只补失败项。

## 部署（production）

```bash
cd server
cp .env.example .env        # 填 NW_JWT_SECRET / NW_DOMAIN
./deploy/up.sh              # docker compose -f docker-compose.prod.yml up -d --build
```

## SLG worldsvc 要点

- **业务层已按领域拆分（2026-07-03）**：原 `service.ts` 3817 行 god-class 拆为 `worldTypes.ts`（视图/Deps 类型）+ `core.ts`（`WorldCore`：共享状态/地图读/视野/spawn/push&schedule 基建/settle&yield/国家）+ 领域子服务 `territory.ts`/`city.ts`/`combat.ts`（行军+攻城+防御+回放）/`season.ts`/`shop.ts`。`service.ts` 收为薄门面 `WorldService extends WorldCore`，逐一委托子服务，公开 API 与导出类型不变（httpApi/index/scheduler/测试零改动）。子服务经 `this.core.*` 调共享 helper（hub 模式破循环）；唯一 peer 边=season 注入 territory 走 `joinWorld`。
  - **`WorldCore` 再拆（2026-07-03）**：`core.ts` 那 1069 行 `WorldCore` 类按关注点拆成一条**线性继承链**，每层一文件（不改任何 `core.xxx` 调用点、组合出的对象完全等价）：`coreKernel`（clients/deps/序列/capitals/bounds/coord/marchView）→ `coreYield`（settle/yieldRecord/recomputeYield）→ `corePush`（Redis 调度 ZSET + gateway push）→ `coreNation`（建国/命名/查询）→ `coreSpawn`（出生点选择 + 3×3 footprint ADR-025）→ `coreVision`（家族/门派成员、战争迷雾视野、反查观察者）→ `coreMap`（地图/单格/getMe 读 + tile→view mapper）；`core.ts` 收为 `export class WorldCore extends WorldCoreMap {}` + 从 `coreHelpers.ts` 转出自由函数（emptyResources/deleteInBatches/lootSummary/MARCHABLE_KINDS）。最大文件 238 行。为什么用继承链而非可复用 mixin：单类拆分下继承链天然让 `this` 跨层全可见、构造器只在 kernel 声明、无 mixin 泛型脚手架；仅 `allySectMemberIds` 因被上层 `coreMap` 调用从 `private` 改 `protected`。207 e2e/单测全绿。
- **combat 域二次拆分（2026-07-03）**：`combat.ts` 1335 行再拆为薄门面 `CombatService`（60 行，委托）+ `combatMarch.ts`（`MarchService`：行军 start/recall/list + 到达处理与分发）+ `combatSiege.ts`（`SiegeService`：攻城/扫荡结算 + ADR-026 延迟建筑血量模型）+ `combatDefense.ts`（`DefenseService`：防御配置 + 回放观战）+ `combatShared.ts`（`refundTroops` 唯一跨 march/siege 共享 helper，取 `core` 的自由函数）。`MarchService.applyArrival` 经构造注入的 `SiegeService` 分发 attack/sweep（唯一 peer 边）。公开 API 不变，`service.ts` 仍 `new CombatService(this)`。顺带清掉原文件遗留的死 import。207 e2e 全绿。
- **`shared/slg.ts` 拆分（2026-07-05，god-file split）**：原 1656 行单文件按域拆为 `shared/src/slg/`：`core`(错误/枚举/ID/容量/主城footprint/GEN 旋钮/通用数值)/`noise`(确定性噪声)/`auction`(护栏+反RMT检测)/`city`(主城建筑)/`province`(国家/省份几何)/`shop`(商店)/`prosperity`(繁荣度/赛季结算/分片)/`mapgen`(地形+`proceduralTile`+地图模板)/`march`(产出+A*寻路)/`siege`(结算+视野+攻城关卡+卡牌兵役)。`index.ts` 薄门面 barrel，服务端 `@nw/shared` 导出路径不变（`export * from './slg'` 自动落到目录）零改动。**但 client 侧 webpack alias / tsconfig paths 为避免拉入 `password`/`logger`（含 `node:crypto`/`node:fs`），直接硬编码指向旧 `slg.ts` 单文件而非走包导出**——拆分当时漏改，导致 `client/tsconfig.json` 与 `client/webpack.config.js` 的 `@nw/shared` 都指向已删除的文件，`tsc`/webpack 构建全炸；已改为指向 `slg/index.ts`（2026-07-05 修复）。最大子文件 349 行
- `shared/slg/mapgen.ts`：`proceduralTile(world,x,y)` 确定性程序化地图（单一来源，client/server 共用）
- `auctions.expireAt` **故意非 TTL**——过期需结算退还托管物/竞拍结拍，用普通索引+扫描器
- **拍卖行反 RMT（S8-5，2026-06-21）**：每日限额（`auctionDaily` 集合 TTL 计数 lists/buys）+ 价格护栏（`auctionPrices` 滑窗中位数 refPrice + 静态回退，越界 `PRICE_OUT_OF_RANGE`）+ 绑定禁挂机制（`AUCTION_BANNED_MATERIALS` 空集）+ 季末冻结（settling 拒挂）/ 清算（`clearWorldOnReset` 退还，挂在 `/admin/world/reset`）+ 竞拍（`saleMode=auction`：`placeBid` 托管/防狙击/买断，`/auction/{id}/bid`）。机制权威 `design/game/AUCTION_DESIGN.md`
- **异常交易审计（D/G7 反 RMT，2026-06-21，SLG_DESIGN §17.13）**：下单硬闸（限额/护栏/禁挂）管不到「合谋账号价格带内反复定向倒货」→ 加离线检测：`AuctionDoc.soldAt`（sold 时写）+ `AuctionService.scanAnomalies` 拉近期 sold 投影 → shared 纯函数 `detectAuctionAnomalies` 按「卖家→买家」有向配对聚合（repeated/designated/high_value 信号，severity high/medium）；内部端点 `GET /admin/world/audit/anomalies`（X-Internal-Key，并入 `/admin/world/*` 分支）。admin 侧立审计工单见 admin 要点
- Redis（`NW_WORLD_REDIS_URL`）：行军 ZSET 仅精确唤醒提示，处理不依赖；缺 Redis 静默降级
- **世界频道扣费漏配（2026-07-04）**：`prod`/`cloud` 两份 compose 的 `worldsvc` 环境块漏配 `NW_COMMERCIAL_INTERNAL_URL`（`local` 早已配对）→ `commercial.available=false` → `nationChannelService.sendMessage` 的 `WORLD_CHAT_COST=50` 扣款分支被静默跳过（`if (commercial.available)` 降级设计本为拍卖行不可用兜底，误伤了世界发言扣费）——不报错、不提示玩家，纯粹「该扣的没扣」。修复：`docker-compose.prod.yml`/`docker-compose.cloud.yml` 补上该变量 + `depends_on: commercial`。VPS 生效只需 `docker compose -f server/docker-compose.prod.yml up -d worldsvc`（改的是环境变量，不用重新 build）。这类「某进程 `xxx.available` 门控的付费/扣费分支」在新增 compose 环境时要对照 `local` 逐项核对，不能只抄 depends_on 图省事漏抄对应 env。
- **宗门频道横扩推送（S8-4c）**：worldsvc `gatewayClient.broadcast` publish `{recipients,msg}` 到 Redis channel `nw:gw:push`（`GW_PUSH_REDIS_CHANNEL`），各 gateway 实例订阅后 `routeBroadcast` 只推本机在线收件人；无 Redis 降级逐个 HTTP push。gateway 须配 `NW_GW_REDIS_URL`（与 worldsvc 同一 Redis）。push 分支新增 `sect_msg`/`family_msg`（proto `SectBroadcast`→`SectMsg`）
- **主城迁城（S8-4c，所有玩家通用）**：主动 `service.relocateBase`（花 `RELOCATE_COST=500` coin 迁主城到合法空格，**保留领地**，沿用旧保护罩；`POST /world/relocate`）；被动 `passiveRelocate`（`applySiege` 主城被破 → `deleteMany({ownerId})` **失全部领地** + 随机落新址上保护罩，门主叠加全宗门 -50%）。客户端 `WorldMapScene` 中立格菜单「迁城到此」+ `NetSession.onSectMsg`/`SectScene.applySectMsg` 实时频道
- **国民加成（S8-6.5 / G1）**：`NATION_BONUS_PRODUCTION=0.10` 在 `recomputeYield`（己方占领首府的 Voronoi 区内格产率 ×1.1）、`NATION_BONUS_DEFENSE=0.15` 在 `applySiege`（守军处己方首府区经 `shared.nationDefenseStrength` ×1.15 再喂 `resolveSiege`）。归属判定 v1 = 首府占领者即国民代表（无逐玩家国籍字段）；NPC 扫荡不享
- **S8-3b（待办）**：围攻经 `/gw/judge` 引擎复算替代廉价线性结算（判负翻转 = G3，仍 log mismatch 未启用）

## 经济核验工具（econ-sim，A 轨）

- `server/tools/econ-sim/`（纯 TS，`import @nw/shared`，**不连库**，经济侧的 difficultySim 对应物）。跑法 `cd server/tools/econ-sim && npx tsx src/index.ts`（或带场景文件参数）；`npx tsc --noEmit` 自检。
- 实现 SLG_ECONOMY_CHECK **A 轨**（persistent-economy 聚合）：按 per-head 口径聚合一个 SLG 赛季全服 settle 发放量，跑 §2.3 判据 PASS/FAIL。conservative/baseline/aggressive 三场景（`scenarios/*.json`）。
- **材料→金币估值**（`src/valuation.ts`）：从 `DUPE_REFUND_COINS÷GACHA_MATERIAL_GRANTS` 自洽反推保守上界（scrap 1 / lead 16.67 / binding 400），永不与代码脱节。**binding=400 与 participant 人头数是结论最大杠杆**。
- 门控判据 = 人均稀释 / 全服通胀（**比材料龙头不比金币龙头**）/ coins=0；头部倾斜与「vs 金币龙头」是 `Judgment.informational` 非门控行。首跑三场景 CORE 全 PASS（2026-06-30）。结论登记 `ECONOMY_NUMBERS §13-SLG`。
- B 轨（赛季资源季内产消）尚未实现，待 SLG_CITY 数值核验时补。

## social/admin/analytics 要点

- **好友/私聊/邮件（S6）**：meta 存数据，gateway 投递实时 push；发送走 REST，接收走 push
- **运维后台（S7）**：两层鉴权（admin JWT ≠ 玩家 JWT）；补偿一律走邮件（不直接写钱包）；审批人 ≠ 发起人
- **SLG 赛季运维 + 异常交易审计（G7，2026-06-21）**：admin `worldClient` 经 X-Internal-Key 代理 worldsvc `/admin/world/*`（season open/settle/reset/close + 拍卖异常扫描）。异常交易审计工单 = 独立集合 `tradeAuditTickets`（与 compTickets 平行：补偿发奖+双人审批 vs 审计核查违规+单人裁定）：`slgScanAnomalies`/`slgFileAuditTicket`（pairKey 去重）/`slgListAuditTickets`/`slgResolveAuditTicket`（open→dismissed|actioned），能力 `slg.audit.view|manage`，REST `/admin/slg/audit/*`。处置（封禁/扣回）走外联，本轮只到立单+裁定+留痕
- **限时活动管理（B6，2026-06-24）**：补齐「创建活动」运营层（此前 `cols.events` 只读无写，线上永远空）。能力 `events.manage`（super/ops）。admin `eventsClient` 经 X-Internal-Key 代理 meta `/admin/events`（`GET` 列全部含未开始/已结束 + `POST` 创建 + `PATCH/DELETE /:id`）；写库前过 `validateEventInput`（@nw/shared，kind 白名单/时间窗/正整数/coins需count·material·skin需id/id去重），删除保留 `eventParticipants` 历史。ops 前端「限时活动」菜单 `pageEvents`（列表+状态+JSON 表单+删除确认）。⚠ 新能力需 VPS admin 后端 `--build` 重建菜单才出现。仍未建：生命周期自动调度器（settled 结算/清积分），见 `design/game/EVENTS_DESIGN.md §10`
- **埋点（A9）**：`/analytics/events` fire-and-forget（`writeConcern:{w:0}`）；`analyticsvc/src/scheduler.ts` 每小时 ETL 漏斗

## 上线收口（Track 2，2026-06-23）

- **赛季收束闭环（L2-1）**：`POST /admin/ladder/season/roll` 现在「先结算上一季全部参与者，再推进时钟」——`rollSeason(cols, commercial, now)` → `settleSeasonParticipants` 游标遍历 `pvp.seasonNo===上季` 的存档发段位奖励邮件 + 授赛季称号 + 写 `ladderSeasonSnapshots` 快照（`_id=${seasonNo}:${accountId}` 幂等账本）。与玩家回归惰性迁移（`migrateIfStale`）三重幂等并存。软重置仍惰性做。详见 `design/game/SEASON_DESIGN.md §15.1`
- **称号端点（L2-2）**：`GET /titles`（含 `parseTitleId` 派生 source/seasonNo）+ `PUT /title/equip`（仅已授予；空串卸下；回推 SaveData）。存储复用 `save.titles[]`/`save.equipped.title`。codegen 重生顺带修复了 `client/src/net/openapi.ts` 此前累积的漂移
- **IAP 凭据加固（L2-3）**：`createReceiptVerifier` 在 `NODE_ENV=production` 下强制关闭 dev 桩（缺凭据 fail closed，不发币）；`commercial/src/index.ts` 引导期对 `production+NW_IAP_DEV=true` 拒启。凭据申请/配置/上线 checklist 见 `design/game/IAP_CREDENTIALS.md`，环境变量样板见 `server/.env.example`
- **充值幂等防跨账号泄露（防御加固，2026-06-29）**：`rechargeVerify` 的 `receiptId` 幂等回放分支此前无视消费者归属——若同一 receiptId 先被 A 账号消费，B 账号再带同 receiptId 来会回读并返回 **A 的钱包余额**，metaserver `iapVerify` 据此 `mirrorCoins` 把 A 的余额写进 B（跨账号余额泄露）。真实平台票据全局唯一不可触发，但 E2E 复用常量 dev 票据时中招。修复：两条回放路径（`existing` 命中 + E11000 并发竞态回读）均加 `accountId` 归属校验，他账号占用 → `INVALID_RECEIPT` 拒绝；同账号重放仍正常返回本账号余额。新增 e2e 用例 `server/commercial/test/service.e2e.test.ts`「同 receiptId 被他账号占用 → 拒绝」
