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

## 11 个应用进程（+ mongo/redis 基础设施）+ 端口

| 进程 | 端口 | 说明 |
|---|---|---|
| metaserver | 18080 | REST，无状态，可横扩 |
| gateway | 8086 | 控制面 WS，account→socket |
| matchsvc | 8091 (internal) | 私有匹配大脑，不连库 |
| gameserver | 8081 | 数据面 WS，哑中继 |
| commercial | 18082 | 钱包/交易，玩家不可达 |
| admin | 18083 dev / **8083** 容器 | 运维后台后端，玩家不可达（订正 2026-07-07：容器/部署端口=8083，见 compose `NW_ADMIN_PORT`/ecosystem/Caddy；dev 裸跑默认 18083，因 8083 曾被 Windows 保留） |
| worldsvc | 18084 | SLG 大世界，公网第四面 |
| analyticsvc | 18085 | 埋点分析，fire-and-forget |
| socialsvc | 8085 | 社交第五面（家族/好友/邮件/频道/push路由） |
| auctionsvc | 18086 | 拍卖行第六面（订正 2026-07-07：从 worldsvc 解耦为独立进程，连 `notebook_wars_auction`；已进 prod compose + ecosystem） |
| botsvc | 18087 | 机器人玩家服务，内部管理面（仅 prod compose，本地全栈默认不拉） |
| mongo | 27017 | 副本集（单节点） |

**Windows TCP 排除端口注意**：`netsh interface ipv4 show excludedportrange` 查被 WinNAT/Hyper-V 保留的端口段，撞上换端口（8082/8083 曾被保留，现用 8086）。

## 构建链

- **metaserver 契约按域拆分（ADR-040，2026-07-14）**：`contracts/openapi.yml` 本身已是生成产物（文件头 `AUTO-GENERATED ... DO NOT EDIT`），**改契约不要手改这个文件**——改 `contracts/openapi/paths/<domain>.yml`（9 个 fragment，一一对应 `metaserver/src/service/*.ts` 的 mixin：auth/save/pve/economy/inventory/progression/liveops/social/telemetry）或 `contracts/openapi/schemas.yml`（共享 schema/responses），然后在 `server/metaserver/` 跑 `npm run gen:api:contracts` 重新合并出 `openapi.yml`。
- **metaserver REST 路由（ADR-023，2026-06-30）**：`contracts/openapi.yml` → `server/contracts/scripts/gen-openapi-server.mjs` → `metaserver/src/generated/routes.gen.ts`（已入库）。改完 fragment 后先 `npm run gen:api:contracts` 再 `npm run gen:api:server` 重生成，一并提交。CI 依次验证 `npm run gen:api:contracts:check`、`npm run gen:api:server:check`（文件过期则失败）。坏 spec（如未加引号的逗号）在 codegen 阶段直接报错，不进运行时。

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

### 本地全栈模拟（完整：10 进程 + 主客户端 + 3 工具 + mongo + redis）

`docker/docker-compose.local.yml` 拉起**10 个服务端进程（除 botsvc，本地不拉）+ redis + 主客户端(nginx) + animator/level-editor/ops 三个工具前端**，每次 up 都 `--build`（从当前代码重建镜像）。编排文件在 `docker/`，所有 build context 相对它写（`../` = 仓库根），并 pin 了 `name: funny` 保持项目名/数据卷不变。

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

nginx 同源反代（`client/nginx.conf`）：`/` SPA · `/api/`→metaserver:8080 · `/gw`→gateway WS · `/ws`→gameserver WS · `/world`→worldsvc:18084（不剥前缀）· `/auction`→auctionsvc:18086 · `/social`→socialsvc:8085（含已迁入的 `/family`）· `/analytics`→analyticsvc:18085（订正 2026-07-07：`/family` 已迁 socialsvc、`/auction` 已迁独立进程 auctionsvc）。worldsvc 内部需 redis + gateway/commercial/meta 内网基址；socialsvc 内部需 gateway 内网基址；analyticsvc/worldsvc/socialsvc 不暴露宿主，仅经 nginx。

**容器内端口与 dev 不同**：镜像里各进程固定监听 metaserver:8080 / gateway:8082(内部 8090) / gameserver:8081 / commercial:8092 / matchsvc:8091 / worldsvc:18084 / socialsvc:8085 / admin:8083 / analyticsvc:18085 / auctionsvc:18086 / botsvc:18087（订正 2026-07-07：admin 容器端口=8083，非 18083；auctionsvc 补入。botsvc 仅 prod compose。dev 裸跑的 18080/8086 等仅 webpack 注入默认值用）。

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
  - **`WorldCore` 再拆（2026-07-03）**：`core.ts` 那 1069 行 `WorldCore` 类按关注点拆成一条**线性继承链**，每层一文件（不改任何 `core.xxx` 调用点、组合出的对象完全等价）：`core/kernel`（clients/deps/序列/capitals/bounds/coord/marchView）→ `core/yield`（settle/yieldRecord/recomputeYield）→ `core/push`（Redis 调度 ZSET + gateway push）→ `core/nation`（建国/命名/查询）→ `core/spawn`（出生点选择 + 3×3 footprint ADR-025）→ `core/vision`（家族/门派成员、战争迷雾视野、反查观察者）→ `core/map`（地图/单格/getMe 读 + tile→view mapper）；`core.ts` 收为 `export class WorldCore extends WorldCoreMap {}` + 从 `core/helpers.ts` 转出自由函数（emptyResources/deleteInBatches/lootSummary/MARCHABLE_KINDS）。最大文件 238 行。为什么用继承链而非可复用 mixin：单类拆分下继承链天然让 `this` 跨层全可见、构造器只在 kernel 声明、无 mixin 泛型脚手架；仅 `allySectMemberIds` 因被上层 `core/map` 调用从 `private` 改 `protected`。207 e2e/单测全绿。**2026-08-02 目录订正**：这七层原先是 `src/` 根下的 `coreKernel.ts`/`coreYield.ts`/… 文件名前缀，而同一个服务里 `combatSiege.ts` 早已用真目录 `combatSiege/` —— 同一约定两种写法。现统一为 `core/{kernel,yield,push,nation,spawn,vision,map,helpers}.ts`，`core.ts` 保持薄装配壳（`from './core'` 仍解析到文件而非目录，链外调用点零改动），`src/` 根条目 40 → 33。
- **combat 域二次拆分（2026-07-03）**：`combat.ts` 1335 行再拆为薄门面 `CombatService`（60 行，委托）+ `combatMarch.ts`（`MarchService`：行军 start/recall/list + 到达处理与分发）+ `combatSiege.ts`（`SiegeService`：攻城/扫荡结算 + ADR-026 延迟建筑血量模型）+ `combatDefense.ts`（`DefenseService`：防御配置 + 回放观战）+ `combatShared.ts`（`refundTroops` 唯一跨 march/siege 共享 helper，取 `core` 的自由函数）。`MarchService.applyArrival` 经构造注入的 `SiegeService` 分发 attack/sweep（唯一 peer 边）。公开 API 不变，`service.ts` 仍 `new CombatService(this)`。顺带清掉原文件遗留的死 import。207 e2e 全绿。
  - **`MarchService` 再拆（2026-08-02）**：`combatMarch.ts` 已长到 947 行，按 `combatSiege/` 同一套薄装配壳 + mixin 链拆为 `combatMarch/base.ts`（两个字段 `core`/`siege` + 构造）→ `combatMarch/command.ts`（玩家指令：startMarch/recallMarch/instantReturnMarch/getMarches）→ `combatMarch/arrival.ts`（调度器驱动的结算：processDueArrivals/advanceMarch/applyArrival/applyMove/tryParkTeam）→ `combatMarch/stationed.ts`（驻扎列表/召回）；`combatMarch.ts` 收为 22 行装配壳。**零跨 mixin 入口**，故除构造器参数属性 `private`→`protected` 外没有任何可见性变化。worldsvc 50 文件/400 测试全绿。
- **`shared/slg.ts` 拆分（2026-07-05，god-file split）**：原 1656 行单文件按域拆为 `shared/src/slg/`：`core`(错误/枚举/ID/容量/主城footprint/GEN 旋钮/通用数值)/`noise`(确定性噪声)/`auction`(护栏+反RMT检测)/`city`(主城建筑)/`province`(国家/省份几何)/`shop`(商店)/`prosperity`(繁荣度/赛季结算/分片)/`mapgen`(地形+`proceduralTile`+地图模板)/`march`(产出+A*寻路)/`siege`(结算+视野+攻城关卡+卡牌兵役)。`index.ts` 薄门面 barrel，服务端 `@nw/shared` 导出路径不变（`export * from './slg'` 自动落到目录）零改动。**但 client 侧 webpack alias / tsconfig paths 为避免拉入 `password`/`logger`（含 `node:crypto`/`node:fs`），直接硬编码指向旧 `slg.ts` 单文件而非走包导出**——拆分当时漏改，导致 `client/tsconfig.json` 与 `client/webpack.config.js` 的 `@nw/shared` 都指向已删除的文件，`tsc`/webpack 构建全炸；已改为指向 `slg/index.ts`（2026-07-05 修复）。最大子文件 349 行
- `shared/slg/mapgen.ts`：`proceduralTile(world,x,y)` 确定性程序化地图（单一来源，client/server 共用）
- `auctions.expireAt` **故意非 TTL**——过期需结算退还托管物/竞拍结拍，用普通索引+扫描器
- **拍卖行反 RMT（S8-5，2026-06-21）**：每日限额（`auctionDaily` 集合 TTL 计数 lists/buys）+ 价格护栏（`auctionPrices` 滑窗中位数 refPrice + 静态回退，越界 `PRICE_OUT_OF_RANGE`）+ 绑定禁挂机制（`AUCTION_BANNED_MATERIALS` 空集）+ 季末冻结（settling 拒挂）/ 清算（`clearWorldOnReset` 退还，挂在 `/admin/world/reset`）+ 竞拍（`saleMode=auction`：`placeBid` 托管/防狙击/买断，`/auction/{id}/bid`）。机制权威 `design/game/AUCTION_DESIGN.md`
- **异常交易审计（D/G7 反 RMT，2026-06-21，SLG_DESIGN §17.13）**：下单硬闸（限额/护栏/禁挂）管不到「合谋账号价格带内反复定向倒货」→ 加离线检测：`AuctionDoc.soldAt`（sold 时写）+ `AuctionService.scanAnomalies` 拉近期 sold 投影 → shared 纯函数 `detectAuctionAnomalies` 按「卖家→买家」有向配对聚合（repeated/designated/high_value 信号，severity high/medium）；内部端点 `GET /admin/world/audit/anomalies`（X-Internal-Key，并入 `/admin/world/*` 分支）。admin 侧立审计工单见 admin 要点
- Redis（`NW_WORLD_REDIS_URL`）：仅用于 ADR-051 占用/覆盖空间索引（`occ`/`cover` 哈希，遭遇战/拦截判定用）+ 宗门频道横扩 pub/sub；缺 Redis 静默降级。行军/攻城伤害/占领的调度 ZSET 已于 2026-07-27 整体删除（只写不读，见下方审计条目）——到达处理**只靠** Mongo `arriveAt`/`dueAt`/`nextStepAt` 扫描
- **世界频道扣费漏配（2026-07-04）**：`prod`/`cloud` 两份 compose 的 `worldsvc` 环境块漏配 `NW_COMMERCIAL_INTERNAL_URL`（`local` 早已配对）→ `commercial.available=false` → `nationChannelService.sendMessage` 的 `WORLD_CHAT_COST=50` 扣款分支被静默跳过（`if (commercial.available)` 降级设计本为拍卖行不可用兜底，误伤了世界发言扣费）——不报错、不提示玩家，纯粹「该扣的没扣」。修复：`docker-compose.prod.yml`/`docker-compose.cloud.yml` 补上该变量 + `depends_on: commercial`。VPS 生效只需 `docker compose -f server/docker-compose.prod.yml up -d worldsvc`（改的是环境变量，不用重新 build）。这类「某进程 `xxx.available` 门控的付费/扣费分支」在新增 compose 环境时要对照 `local` 逐项核对，不能只抄 depends_on 图省事漏抄对应 env。
- **宗门频道横扩推送（S8-4c）**：worldsvc `gatewayClient.broadcast` publish `{recipients,msg}` 到 Redis channel `nw:gw:push`（`GW_PUSH_REDIS_CHANNEL`），各 gateway 实例订阅后 `routeBroadcast` 只推本机在线收件人；无 Redis 降级逐个 HTTP push。gateway 须配 `NW_GW_REDIS_URL`（与 worldsvc 同一 Redis）。push 分支新增 `sect_msg`/`family_msg`（proto `SectBroadcast`→`SectMsg`）
- **主城迁城（S8-4c，所有玩家通用）**：主动 `service.relocateBase`（花 `RELOCATE_COST=500` coin 迁主城到合法空格，**保留领地**，沿用旧保护罩；`POST /world/relocate`）；被动 `passiveRelocate`（`applySiege` 主城被破 → `deleteMany({ownerId})` **失全部领地** + 随机落新址上保护罩，门主叠加全宗门 -50%）。客户端 `WorldMapScene` 中立格菜单「迁城到此」+ `NetSession.onSectMsg`/`SectScene.applySectMsg` 实时频道
- **国民加成（S8-6.5 / G1）**：`NATION_BONUS_PRODUCTION=0.10` 在 `recomputeYield`（己方占领首府的 Voronoi 区内格产率 ×1.1）、`NATION_BONUS_DEFENSE=0.15` 在 `applySiege`（守军处己方首府区经 `shared.nationDefenseStrength` ×1.15 再喂 `resolveSiege`）。归属判定 v1 = 首府占领者即国民代表（无逐玩家国籍字段）；NPC 扫荡不享
- **S8-3b（待办）**：围攻经 `/gw/judge` 引擎复算替代廉价线性结算（判负翻转 = G3，仍 log mismatch 未启用）
- **`getMarches`/`getStationed`/`computeMarchPath` 查询优化（2026-07-29，接续 07-27 审计"已知但本轮未处理"第二条）**：两步。①`computeMarchPath`（`combatMarch.ts`）三次缺索引 `tiles` 扫描（关口 bridge/plankway、被占主城、阻挡建筑）补 `{worldId,type}` + 稀疏 `{worldId,'structure.kind'}` 两个索引（`db.ts`），纯加索引无行为改动。②结构性下推：`MarchDoc` 新增 `minX/maxX/minY/maxY`（`db.ts`）——leg 两端点（fromTile/toTile）的 bbox，一次性写入（`core/helpers.ts::legBox`），**不是**逐 tick 更新的"当前坐标"——因为 `getMarches` 的视野判定（`marchInterpPos`）从来就是 fromTile→toTile 的直线插值，从不看 ADR-051 那条会拐弯的 A* `path`，所以整段行程的插值位置必然落在这个 bbox 内，端点互换（recall 时 from/to 对调）不改变 bbox，故 `recallMarch` 不需要重算（但仍顺手重算一遍，见下）。`getMarches`/`getStationed` 敌方分支改用调用方"领地/视野包围盒"（`core/helpers.ts::sourcesBoundingBox`，直接从已经算好的 `computeVisionSources` 返回值推导，不是另发一次查询）下推进 Mongo `find` 条件，敌方精确 `isInVision` 过滤只在 bbox 缩小后的结果集上跑；`getStationed` 顺带去掉了落不到 `{worldId,ownerId}` 索引前缀的低效 `$ne:accountId`，改成 bbox 范围 + 内存排除自身。历史 march 文档缺 bbox 字段**未做离线迁移**：字段可从 `fromTile`/`toTile` 100% 推导，`marches` 本身是瞬时集合（到达/召回即删除），且 `recallMarch` 会在触碰到的任何 legacy 文档上无条件重算 bbox（自愈）——影响面仅限"该行军在剩余行程内对其他玩家的视野观测暂时不可见"，不影响到达结算/兵力等权威状态；仍提供了 `scripts/migrateMarchBbox.ts`（幂等、`--dry-run`）供想立即补齐的场景使用，脚本头部注释记录了"为什么不是发布前置条件"的完整推理。回归测试 `test/march-query-opt.e2e.test.ts`（9 例：4 个索引走向断言 + bbox 写入正确性 + 视野内/外过滤 + legacy 文档自愈）。

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
  - **`AnalyticsService` 拆分（2026-08-02）**：`service.ts` 947 行（其中前 357 行是模块级声明）按 metaserver `service.ts`+`service/*` 同款 mixin 链拆为 `service/defs.ts`（采样配置 / 上报与查询结果类型 / 手写 UA 解析 / 五套漏斗的有序步骤定义——纯声明，无状态无 I/O）+ `service/base.ts`（collections 句柄 + 构造 + getConfig）+ `service/traffic.ts`（事件数/DAU/登录小时/留存/首次会话）+ `service/funnel.ts`（漏斗 ETL + tutorial/scene/level/feature-guide 漏斗）+ `service/dist.ts`（地区/OS/浏览器/设备/国家/徽章分布）+ `service/ingest.ts`（A9-3 写入路径）。`service.ts` 收为 27 行装配壳并 `export * from './service/defs'`，故 `httpApi.ts`/`index.ts`/`scheduler.ts`/e2e 仍从 `'./service'` 取 `AnalyticsService`/`EventBatch`/`ResolvedGeo`，零改动。**副作用**：`dayStart`/`toDateStr`/`clampEventTs`/`ACTION_NOISE`/`EMPTY_STEP_KEYS`/`MAX_EVENT_TS_*` 原是模块私有，因 mixin 分在别的文件里要用而改为从 `defs.ts` 导出，经 `export *` 进入了 `service.ts` 的对外面。

## 上线收口（Track 2，2026-06-23）

- **赛季收束闭环（L2-1）**：`POST /admin/ladder/season/roll` 现在「先结算上一季全部参与者，再推进时钟」——`rollSeason(cols, commercial, now)` → `settleSeasonParticipants` 游标遍历 `pvp.seasonNo===上季` 的存档发段位奖励邮件 + 授赛季称号 + 写 `ladderSeasonSnapshots` 快照（`_id=${seasonNo}:${accountId}` 幂等账本）。与玩家回归惰性迁移（`migrateIfStale`）三重幂等并存。软重置仍惰性做。详见 `design/game/SEASON_DESIGN.md §15.1`
- **称号端点（L2-2）**：`GET /titles`（含 `parseTitleId` 派生 source/seasonNo）+ `PUT /title/equip`（仅已授予；空串卸下；回推 SaveData）。存储复用 `save.titles[]`/`save.equipped.title`。codegen 重生顺带修复了 `client/src/net/openapi.ts` 此前累积的漂移
- **IAP 凭据加固（L2-3）**：`createReceiptVerifier` 在 `NODE_ENV=production` 下强制关闭 dev 桩（缺凭据 fail closed，不发币）；`commercial/src/index.ts` 引导期对 `production+NW_IAP_DEV=true` 拒启。凭据申请/配置/上线 checklist 见 `design/game/IAP_CREDENTIALS.md`，环境变量样板见 `server/.env.example`
- **充值幂等防跨账号泄露（防御加固，2026-06-29）**：`rechargeVerify` 的 `receiptId` 幂等回放分支此前无视消费者归属——若同一 receiptId 先被 A 账号消费，B 账号再带同 receiptId 来会回读并返回 **A 的钱包余额**，metaserver `iapVerify` 据此 `mirrorCoins` 把 A 的余额写进 B（跨账号余额泄露）。真实平台票据全局唯一不可触发，但 E2E 复用常量 dev 票据时中招。修复：两条回放路径（`existing` 命中 + E11000 并发竞态回读）均加 `accountId` 归属校验，他账号占用 → `INVALID_RECEIPT` 拒绝；同账号重放仍正常返回本账号余额。新增 e2e 用例 `server/commercial/test/service.e2e.test.ts`「同 receiptId 被他账号占用 → 拒绝」

## Mongo/Redis 全面读写审计 + 修复（2026-07-27）

针对 Atlas M0（跨公网、连接数上限 500）这套生产部署，做了一轮全服务 Mongo 存储方式 + Redis 缓存方式 + 读写路径的审计（65 个集合、4 个探索代理并行覆盖 meta/commercial/social/world/auction/analytics），按优先级修复。完整原始审计发现见本次会话记录；这里只记落地的改动，供以后核对代码时用。

- **T1 metaserver 从未收到 `NW_REDIS_URL`**：prod/cloud compose、`ecosystem.config.cjs`、`dev-up.ps1`、`.env.example` 全部漏配——matchsvc 每场对局写 `nw:activeMatch:{accountId}`（断线重连提示），meta 却一直读不到也清不掉，功能在生产环境**完整实现却从未生效**。已在上述 5 处补上 `NW_REDIS_URL`，并仿照既有 `matchsvc/test/deploy-config.test.ts` 的套路加了 metaserver 侧同款回归测试。顺带发现 `ioredis` 对 metaserver/matchsvc 是**未声明依赖**（靠 workspace hoisting 侥幸工作），已在两处 `package.json` 显式声明。
- **T2 Redis 无 `maxmemory`/淘汰策略**：prod/cloud/local 三份 compose 补 `--maxmemory 256mb --maxmemory-policy allkeys-lru`——这里存的东西（occ/cover 空间索引、activeMatch）全是「丢了会降级但不会错」的缓存态，宁可被 LRU 淘汰也不要把 VPS 内存撑爆。
- **T3 补 5 个缺失索引**：`auctionsvc.auctions` 加 `{status,itemType,price}` + `{status,price}`（浏览拍卖行原本是 COLLSCAN + 内存排序）+ `{closedAt}`（小时级清理任务）；`worldsvc.occupations` 加 `{worldId,ownerId,teamId}`（每次行军出兵的 TEAM_BUSY 门禁原本裸扫）；`worldsvc.playerWorld` 加 `hasBattlePass` 部分索引（赛季结算扫描）；`worldsvc.tiles` 加 `{contestedBy}` 稀疏索引（见 T4）；`socialsvc.families` 加 `{prosperity,memberCount}`（家族浏览，`memberCount<CAP` 命中率极高，排序字段放前更优）+ `{sectId}` 稀疏索引。
- **T4 worldsvc「全图视野扫描」的真实病根其实是缺索引，不是缺视口限界**：最初怀疑 `getMarches`/`getStationed`（客户端每 5s 轮询）需要把视野计算限制到摄像机视口才能避免全图扫描，深入后发现这个思路是错的——玩家的视野天然跟随其领地分布而非摄像机位置，若按视口裁剪会破坏「离开自己基地也能收到偷袭警报」这个设计意图。真正的病根是 `computeVisionSources` 的 `tiles.find` 里 `$or:[{ownerId:$in},{contestedBy:$in}]` 两个分支只有一个有索引——MongoDB 对 `$or` 要求每个分支都能用上索引才会走索引方案，否则整体退化为 COLLSCAN。T3 补的 `contestedBy` 稀疏索引直接解决了这个全图扫描；另外给 `marches` 补了 `{worldId,status}` 索引（`getMarches` 的「他人行军」分支原本无支撑索引）。**没有做**、也不建议做客户端视口阈值改造。
- **T5 `GET /save` 曾经是一次写**：`mirrorWalletFrom`（`GET /save` 每次都调）无条件 `$inc save.rev`，导致纯读路径持续 bump 乐观锁计数器，跟任何并发的客户端 `PUT /save` 抢 409。现在先读一遍当前镜像状态比对（`stableStringify` 做 key 顺序无关比较），值没变就直接返回、不写。
- **T6 删除只写不读的 Redis 调度 ZSET**：`world:{w}:march`/`:siegeDamage`/`:occupation` 三个 ZSET 只有 `zadd`/`zrem` 调用点，`zrangebyscore`（唯一读法）在 `src/` 里零调用——到达处理从一开始就完全靠 Mongo `arriveAt`/`dueAt`/`nextStepAt` 扫描。整段删除（`core/push.ts` + `combatMarch.ts`/`combatSiege/*` 共 14 处调用点），顺带清了 `WorldRedis` 接口里同样零调用的 `get`/`set`。
- **T7 `resetSeason` 漏删 4 个集合**：`siegeDamage`/`occupations`/`stationed`/`mapBaselines` 原本不在批量删除列表里；残留的 `stationed` 行会撞 `{worldId,ownerId,teamId}` 唯一索引，坑到回流玩家。前三个直接加进 `season.ts` 的 `deleteInBatches` 循环；`mapBaselines` 不一样——它是"开服时克隆当前激活地图模板"的产物（`cloneActiveTemplateInto`），删了不重新克隆会让世界悄悄退化成纯 `proceduralTile` 生成、丢失人工地图模板布局。仿照 `/admin/world/open` 的做法，在 `/admin/world/reset` 里也调一次 `cloneActiveTemplateInto`（无激活模板时仍是安全空操作）。
- **T8 补 3 处缺失 TTL**：`analyticsvc.sessions`（`events` 早有 90 天 TTL，`sessions` 却"永久"）补同款 90 天；`worldsvc.sieges`（`resetSeason` 已经按 worldId 清，这里只是防季节没及时重置的兜底）加 `SIEGE_RETENTION_SEC=30d` + `expireAt` 字段；`metaserver.pveVerifications`（`rejected` 判定的记录会带完整 replay frames）加 30 天 `expireAt`，但仿照 `MatchDoc` 对 disputed 局的处理——`rejected` 判定会把 `expireAt` 撤销（永久留痕供人工复核），`verified`/`unverified` 才真正过期。
- **T9 `mutateSave` 去掉保底多余读**：原来无条件 `getOrCreateSave`（1-2 次读）+ 重试循环第一次迭代立刻 `findOne` 重读同一份文档——每次 mutateSave 调用都白白多读一次。改成先直接 `findOne`，只有真的没查到（账号第一次触碰存档，事实上几乎不会发生，因为 `GET /save` 自己的 `getOrCreateSave` 早就建好了）才走 `getOrCreateSave` 兜底。
- **T10 `batch-profiles` 从 2N 次查询改成 2 次 `$in`**：`internal/account/batch-profiles` 原本对每个 accountId 调一次 `profileOf`（每次 2 个 findOne，且 accounts 侧完全没投影，连密码哈希都拉回来），100 个好友 = 200 次查询。抽出 `toProfileView` 纯函数做单一事实来源，新增 `profilesOf` 批量版：`accounts`/`saves` 各一次 `$in` + 投影 + 内存 join。
- **T11 `pveClear`/`pveVerify` 写放大合并**（本轮改动量最大）：正常通关此前最多做 4 次独立的整存档读改写（`writeClearProgress`/`grantClearReward` 的材料写/`accrueJudgedPveStats`/`bumpRetentionTask`），彼此的 SaveData 改动互不依赖结果（只有每日奖励封顶判定 + 装备掉落骰子必须在进 `mutateSave` 事务前决定——事务函数可能因 rev 冲突被重试多次，不能塞不确定性逻辑），于是合并进一次 `mutateSave`（新 `settleNormalClear`，进度/星级/篇章成就 + 材料/装备槽位 + 判定后统计 + 每日任务全在一次写里）；章节卡/掉落卡的发放仍走独立的共享 `grantCards`（gacha/邮件/拍卖行共用，不能重复）。`pveVerify` 的判定后发放（`grantClearReward`+`accrueJudgedPveStats` 两次写）套用同一模式合并成 `deliverVerifiedClearReward`。抽出两个纯函数 `applyClearProgress`/`applyMaterialAndEquipmentGrant` 供两条路径共享。正常通关：4 次整存档写 → 1 次；判定后发放：2 次 → 1 次。

**中期项列表（5 项，全部已于 2026-07-27 完成，见下）**：`cardInv`（最多 500 张卡）拆成独立集合（复刻 `equipmentInstances` 2026-07-26 的拆法）；`mapBaselines` 改行程编码存储（当前一次开服克隆一张 1500×1500 地图模板会物化 225 万文档，仅在 ops 激活自定义模板时触发）；`adsDaily`/`pveDaily`/`victoryDaily` 这类日计数器迁到 Redis TTL key；`rejectIfBanned`/`publicId` 查询加缓存层；进程内限流器（认证/异常上报/分享额度）迁 Redis + gateway presence 查询支持跨实例。

## cardInv 存储拆分（2026-07-27，中期项第 1 项）

照抄 `equipmentInstances`（2026-07-26）的拆法，把 `SaveData.cardInv`（最多 500 张卡）从内嵌 map 拆到独立集合 `cardInstances`（`_id`=instanceId，`{accountId:1}` 索引）+ `SaveData.cardInvCount` 镜像字段。线格式不变（`GET /save`/`/internal/save-fields` 现拼 `assembleCardInv`），`app.ts` 的 `preSerialization` 钩子同一处扩展。只做「阶段一」（存储拆分），不做装备那样的「阶段二」（响应精简 leanSave/null）。

完整设计记录（含交叉依赖踩坑点、并发安全设计取舍）见 [`design/game/CHARACTER_CARDS_DESIGN.md`](../design/game/CHARACTER_CARDS_DESIGN.md) §17 CC-15；[`design/game/EQUIPMENT_DESIGN.md`](../design/game/EQUIPMENT_DESIGN.md) §3.3 补了一条交叉更新说明（`isEquipped`/`equipEquipment` 改查 `cardInstances`）。迁移脚本 `server/metaserver/scripts/migrateCardInv.ts`（幂等、断点续跑，**必须先在生产跑到 100% 完成再部署新代码**）。

验证：metaserver 54 文件/678 测试、worldsvc 44/341、auctionsvc 5/71 全绿（后两者只读拼好的 map，零源码改动）。

**2026-08-02 后续 — `/internal/save-fields` 新增可选 `cardIds=a,b,c`**：拼回整册 `cardInv` 的代价落在了 `GET /world/teams` 的读路径上（`worldsvc` `getTeams` 的 self-heal 每次都拉全部 500 张，只为验证编队引用的那几十个 id 还在不在，而这条路径是主城界面的关键路径）。新增 `assembleCardInvSubset`（`cards.ts`，`_id:{$in}` + 仍按 `accountId` 作用域）供带 `cardIds` 的调用；**故意不做** `assembleCardInv` 那条 `cardInvCount` 漂移自愈——过滤过的 `find` 看不到真实册数。不传 `cardIds` 时行为完全不变（攻城引擎等既有调用方零影响）；`getTeams` 一张卡都没引用时连跨服务跳转都跳过。见 [`design/game/SLG_CITY_DESIGN.md`](../design/game/SLG_CITY_DESIGN.md) §8.8。

## mapBaselines 行程编码重设计（2026-07-27，中期项第 2 项）

真正的病根不是 `cloneActiveTemplateInto`（每次开服/重置的克隆），而是 `generateTemplate`（模板首包生成）——1500×1500 地图逐格调用 `proceduralTile()` 后原样物化成 225 万份 `mapTemplateTiles` 文档，克隆只是把这份稠密数据原样搬到 `mapBaselines` 再来一遍。地形有大量连续同值横向条带（河/山连续带，资源/中立地块间稀疏散落特殊格），改行程编码（RLE）：`server/shared/src/slg/mapRle.ts` 新增 `encodeRow`/`decodeRow`/`tileAtX`/`sliceRuns`/`applyEditsToRow` 纯函数；存储从「每格一文档」改成「每**行**一文档、行内一组压缩区间」——集合改名 `mapTemplateTiles`→`mapTemplateRows`、`mapBaselines`→`mapBaselineRows`（新旧 `_id` 格式不同，用改名而非原地换 shape 避免新代码的范围查询意外命中旧稠密文档解 `.runs` 崩溃）。外部契约（`MapTemplateTile` 单格形状、`getTiles`/`saveTilesDiff` API、`tileCount` 统计口径）完全不变，压缩/解压全封装在 `mapTemplateService.ts`/`core/map.ts` 内部。

完整设计记录见 [`design/game/SLG_DESIGN_LOG.md`](../design/game/SLG_DESIGN_LOG.md) §24 第 4 条（2026-07-27）。迁移脚本 `server/worldsvc/scripts/migrateMapBaselinesToRle.ts`（幂等、不删旧集合，留给 ops 确认后手动清理；若从未真正激活过自定义模板则无需迁移）。

验证：`shared/test/mapRle.test.ts`（14 例新增纯函数测试）+ `worldsvc/test/map-template.e2e.test.ts`（9 例，重写裸集合断言 + 新增「10×10 模板只落地 10 行文档」回归锁定）；shared 647/647、worldsvc 341/341 全绿。

## adsDaily/pveDaily/victoryDaily 迁 Redis（2026-07-27，中期项第 3 项）

三张日计数器集合（`adsDaily`/`pveDaily`/`victoryDaily`）从未建过索引/TTL，无界增长；每次写都是「upsert 建文档 + 再一次 guarded `findOneAndUpdate`」两次跨公网 Atlas 往返。改用 `server/shared/src/dailyCounter.ts`：键 `nw:{ns}:{accountId}:{dayKey}`，cap 型计数器（`count`/`rewardedClears`/`wins`）用 `HINCRBY` 原子自增后判断是否超顶、超了就自己回滚一次（不需要 Lua——`HINCRBY` 本身在 Redis 端原子，谁的自增结果超顶谁回滚，纯并发安全）；ad 冷却闸（`lastAdAt` 时间戳，非计数器）需要「不存在或早于 minInterval 前才写」的判断，靠一个小 Lua 脚本原子完成。TTL 48 小时滑动，仅作存储兜底，从不参与判定——判定永远是纯算术比较调用方传入的 `now`，不看 Redis 自己的时钟/TTL 倒计时，否则测试里推进假时钟会跟真实经过时间脱节。

**redis=null 时不是「功能禁用」，是进程内 Map 兜底**：这三个计数器是反作弊硬顶，跟 `activeMatch`/`worldsvc` 那种「丢了只是体验降级」的 Redis 用法性质不同，所以刻意没有复用「优雅降级」的写法。`metaserver`/`commercial` 目前都是单实例部署（`ecosystem.config.cjs` `instances:1`），进程内计数在这个拓扑下就是正确的全局计数——只是不扛进程重启，不像真 Redis。`server/shared/src/dailyCounter.ts` 顶部注释记了完整推理；`docker-compose.{cloud,prod}.yml` 的 Redis 淘汰策略注释也补了一句：这类计数器即使被 LRU 淘汰也只是某账号当天的上限提前重置，影响有界、自愈，不影响"淘汰整体安全"的结论。

commercial 此前完全没有 Redis 依赖，本次新增：`config.ts` 补 `NW_REDIS_URL`（复用 metaserver/matchsvc 同名变量，同一个 Redis 实例）、`index.ts` 用新增的 `connectDailyCounterRedis` 连接（metaserver 则直接复用已有的 `connectActiveMatchRedis` 连接，不开第二个连接）。四份部署文件（`docker-compose.{local,cloud,prod}.yml`、`ecosystem.config.cjs`、`dev-up.ps1`、`.env.example`）同步补上；仿照 T1 的做法在 `matchsvc/test/deploy-config.test.ts` 加了 commercial 侧的同款回归测试。

`shared/src/mongo.ts` 删 `AdsDailyDoc`/`PveDailyDoc`（+ `Collections` 字段/`createMongo` 实例化）；`commercial/src/db.ts` 删 `VictoryDailyDoc`（+ 同上）。`metaserver/test/ads.test.ts` 原先用手搓假 Mongo collection 模拟 `checkAdInterval`/`bumpAdsCap` 的行为，改成 `redis=null` 走真实进程内兜底逻辑（实际验证生产代码路径，而非模拟出的行为）。

验证：另外手写脚本连本机真实 Redis（`redis://127.0.0.1:6379`）跑了一遍 `bumpCappedCounter`/`bumpGuardedTimestamp`/`readCounterField`，确认 Lua 脚本 + HINCRBY 回滚在真 ioredis 上行为正确（cap 顶住第 4 次、TTL 落地 172800s）——测试套件本身全程 `redis=null`，不会覆盖这条路径。metaserver 54 文件/678 测试、commercial 11 文件/136 测试、matchsvc `deploy-config.test.ts` 全绿；`tsc -b shared engine metaserver gateway matchsvc gameserver commercial worldsvc auctionsvc admin analyticsvc botsvc socialsvc` 全绿。

## worldsvc 代码审查 + 修复（2026-08-03）

对 `server/worldsvc/` 全量代码审查（4 个探索代理并行覆盖 core/状态管理、combat/攻城、经济与社交、对外 API/客户端），修出 17 处问题，按严重度记要点（完整审查结论见本次会话记录，这里只记落地改动）：

- **进程崩溃（Critical）**：`httpApi.ts` 的 `GET /world/active-season`（零鉴权、客户端高频轮询）此前不在任何 `try/catch` 内；`svc.getActiveSeasonNo()` 一旦抛错，Node 15+ 未捕获 rejection 默认终止进程——相当于一次数据库瞬时抖动就能带崩全服。同样漏洞在 `/admin/world/list`/`/patrol` 及 `/admin/world/allocate` 前的 `readJson` 调用。全部补 try/catch。
- **经济 dupe（High）**：`city.ts` `getTeams`/`setTeams` 共用的 `buildCardRemovalPatch` 退款写入无 rev 守卫，并发调用可重复领取卡牌解绑的 80% 退款——补 `{_id, rev: pw.rev}` 乐观锁守卫。
- **免费产兵（High）**：卡牌编队的 march troops 字段实际是"卡数"而非真实兵力（真实强度只存在 `cardState.currentTroops`），但 `combatMarch/arrival.ts` 的 `return` 到达分支和 `instantReturnMarch` 的 `refundTroops` 调用此前没做 `hasCardArmy` 判断（对比本模块其余 5 处退款点都判断了）——补齐判断。
- **调度器并发丢失更新（High）**：`combatShared.ts::refundTroops` / `combatSiege/helpers.ts::transferLoot` 原本是「快照读 + 整体 `$set`」，同一玩家同一 tick 内多个调度任务（行军到达/攻城结算/占领结算）并发写会互相覆盖——两处均改为 rev 守卫 + 有界重试（读改写失败自动重读重算，5 次退避后放弃并记日志，不抛错影响调用链）。
- **`speedupTraining`/`speedupBuild` 漏乐观锁（High）**：收尾写库只带 `{_id}`，同文件 `trainTroops`/`upgradeBuilding` 都带 rev 守卫。因为币已经在守卫写之前扣了，冲突时不能直接抛 `REV_CONFLICT`（会把钱扣了却不给效果）——改成有界重试重读重算，而非直接失败。
- **DoS（High）**：`httpApi.ts::readJson` 的 1MB 上限只 `reject` promise，不 `req.destroy()`，后续数据块照样被拼进内存——补上超限即销毁连接。
- **占领类攻城漏引擎过载门槛（Medium）**：`combatSiege/occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion` 此前直接调 `runSiegeBattle`，未过 `shouldUseCheapSiege`（其余所有攻城入口都过滤超量兵力，避免引擎因棋盘拥堵误判防守方胜）——补齐同款门槛。
- **世界/宗门频道 msgSeq 跨实例撞车（Medium）**：`nationChannelService.ts`/`sectService.ts` 用进程内内存计数器拼 `_id`，多实例横扩下可能撞 key；世界频道撞车时已扣的 50 金币无退款路径——`_id` 补随机后缀（`randomBytes`）+ 插入失败自动退款。
- **商店每日限购 TOCTOU（Medium）**：`shop.ts::buySlgShopItem` 扣费与写库之间隔着一次外部 await 且无守卫，并发请求可叠穿限购——改为花费后重读校验（限购/battle_pass 均重查）+ rev 守卫写 + 冲突自动退款重试。
- **国家改朝换代 familyId 残留（Medium）**：`core/nation.ts::applyNationChange` 胜者无家族时只是不写 `familyId`，没有 `$unset`，导致挂着上一任家族的 stale 归属——补 `$unset`。
- **国名无内容审核（Medium）**：`setNationName` 是全库唯一跳过 `censorChat` 审核的持久公开玩家自定义名（对比宗门/家族名都过滤），且用 UTF-16 `.length` 而非 CJK 宽度计算——补 `censorChat` 拒绝 + 改用 `orgNameWidth`/`ORG_NAME_WIDTH_{MIN,MAX}`（跟宗门名同一套边界）。为此 `WorldServiceDeps`/`WorldCoreKernel` 新增 `wordlists` 依赖注入（`index.ts` 已有 `wordlists` 实例，此前只接到 sectSvc/nationChannelSvc，没接到 `WorldService`），`setNationName` 新增 `region` 参数，`httpApi.ts` 用 `regionFromAcceptLanguage` 解析。
- **Redis 覆盖索引读改写竞态（Medium）**：`core/push.ts::addCover`/`removeCover` 是 hget→改→hset，两个据点几乎同时注册重叠 3×3 覆盖时会丢失一个的条目（持久数据丢失，不是瞬时误判）——新增 `WorldRedis.hmergeJsonField`（可选接口，真实客户端用一段 Lua 脚本在 Redis 端原子完成合并/删除，`redis.ts` 里用 `client.eval` 实现），调用点优先用它、缺失时（如测试假实现）退回旧的非原子路径（测试环境无真并发，安全）。
- **罢免投票丢失更新（Low/Medium）**：`sectService.ts::voteRemoveLeader` 并发投票会互相覆盖对方的票——补 rev 守卫 + 有界重试。
- **出生点查询效率（Low）**：`core/spawn.ts::pickSpawnTile` 的 `type:'base'` 查询同时匹配主城锚点和 8 个外圈占位格，导致每个家族成员多算 9 倍——补 `baseRing:{$ne:true}`。
- **Redis 健康信号误报（Low）**：`redis.ts::connectRedis` 构造后立即返回，不等连接结果，Redis 真挂了启动日志仍显示 `redis=on`——改为有界等待（5s）`ready`/`error` 信号，超时则登出错误日志并返回 null（代价：极端「连接慢但很快能成功」场景会被误判为不可用直到重启，判断为可接受，因为本服务所有 Redis 降级路径本就设计为可无限期运行）。
- **管理接口数字字段未校验（Low）**：`/admin/world/allocate`/`/admin/world/open` 的 `capacity`/`season`/`shard` 缺 `Number.isFinite` 校验，脏 payload 会把 `NaN` 落库——补校验。
- **降级期 senderName 可伪造（Low）**：`/sect/message`/`/nation/message` 在 meta 不可用降级期直接信任客户端 `senderName`——补 `sanitizeSenderNameFallback`（去控制字符、trim、按 `MAX_DISPLAY_NAME_LEN` 截断）。
- **同批次行军占用索引泄漏（Low/Medium）**：`combatMarch/arrival.ts::advanceMarch` 用 `processDueArrivals` 批量扫描时的旧快照推进——若同批次内某行军的遭遇战删除了另一个也到期的行军，后者仍会用过期快照继续写入占用索引，形成永不清理的幽灵占用条目——`advanceMarch` 入口改为重新读取最新文档，doc 已不存在或已被召回改道 `return` 腿时直接判定"本批次已处理，跳过"。

验证：`tsc --noEmit` 全绿；`npm test -w @nw/worldsvc` 52 文件/419 测试全绿（含新建测试用的 mongodb-memory-server，无需改动任何既有用例）。纯 bug 修复，无对外行为/契约变化（`setNationName` 新增的 `region` 参数为可选，默认 `'global'`，不破坏现有调用方）。

**补测（同日）**：为上述 17 处修复逐一补齐回归测试，23 例新增（52→53 文件，419→442 测试）：新建 `test/review-fixes-2026-08-03.e2e.test.ts`（16 例，覆盖除 httpApi 级三处外的全部 14 项——card-removal 退款并发去重、speedupTraining 并发重试、combatMarch 卡牌军返程免兵、advanceMarch 陈旧快照护栏、refundTroops/transferLoot 并发不丢单、shop 每日限购 TOCTOU、nation familyId $unset + 改名审核、push.ts cover 索引原子合并、sect 罢免投票并发计票、spawn.ts 出生点查询过滤）+ `test/httpApi.e2e.test.ts` 补 3 例（active-season 崩溃防护、readJson 上限断连、senderName 降级期净化）+ `test/season-ops.e2e.test.ts` admin 分支补 4 例（allocate/open 数字字段校验）。**每一例都用「暂时切回修复前的 commit（`4aaed19b`）跑一遍确认真的会挂红，再切回修复后确认转绿」的方式验证过**，不是只跑通了事——过程中揪出并重写了两个"自证通过"的假阳性用例（push.ts 原用例的同步 fake 无法重现真实网络延迟竞态，改为断言调用路径改用 `hmergeJsonField` 而非 `hset`；spawn.ts 原用例直接手写了跟修复后代码一致的查询条件而不是真的检验 `pickSpawnTile`，改为 `vi.spyOn` 捕获其实际发出的查询)，以及一个因误解 troopCap 初始值（新账号一开局兵力即满编，非 0）导致的错误断言。

## metaserver 代码审查 + 修复（2026-08-03）

对 `server/metaserver/src/` 全量代码审查（6 个探索代理并行覆盖 auth/accounts、economy/wallet、cards/equipment/inventory、pve/progression/save/ladder、social/liveops/events/mail、app/infra 六块），修出 15 处问题，按严重度记要点（完整审查结论见本次会话记录，这里只记落地改动）：

- **经济 dupe（High）**：`events.ts::accrueEventTask` 是 `findOne` 读进度再 `updateOne` 写绝对值，无版本守卫——并发触发（同一 tick 内多个 pve/pvp/ad 回调）既可能丢增量，也可能在达标那一刻被两次并发调用同时判定"未发过奖"而重复 `$inc` 积分。改成三段式原子写：`push-if-absent`（首次触发）→`$inc`-guarded-by-`{$lt:target}`（推进且天然封顶不超发）→`$set pointsGranted`-guarded-by-`{$ne:true}`（只发一次奖），全靠 Mongo 单文档写天然序列化，不再需要显式加锁。
- **经济 dupe（High）**：`service/pve.ts::pveVerify` 的幂等守卫在（可能耗时 ~20s 的）`gateway.judge()` 调用**之前**读一次 `status`，判定结算的 `updateOne({status:'pending'})` 之后却不检查是否真的命中——两个并发提交都可能在对方写入前读到 `pending`、都跑完 judge、都进入发奖分支，同一次 PvE 通关被结算两次。补：结算写入检查 `matchedCount`，未命中（被别的并发请求抢先结算）直接走既有的幂等已结算分支，不再发奖。
- **经济 dupe（High）**：`economy.ts::reconcileUndelivered`（`GET /save` 副作用）会对 commercial 仍标记 `'charged'` 的订单重新走一遍 `deliverOrder`；而 `gachaDraw` 标记订单已发货的 `commercial.orderDelivered` 调用是 fire-and-forget（不 await），这两者之间存在天然竞态窗口——皮肤类奖励靠 `$addToSet` 天然幂等，但材料/道具类奖励是 `$inc`，窗口内的一次 `GET /save` 就会重复发放。补：`deliverGrant`/`deliverMailGrant` 整个写入门控在 `'save.deliveredOrders': {$ne: orderId}` 上，让 `$inc` 的材料/道具也变得像皮肤一样天然幂等（`deliveredOrders` 数组仍按 `$push+$slice` 保留最近 N 条历史，去重窗口=该账号最近 N 次发货，接受这个已有的既定折衷）。
- **丢失更新（High）**：`titles.ts::grantTitleToPlayer` 是裸 `updateOne`，唯一没走 `mutateSave` 同款 rev 守卫的存档写入点——称号发放常与玩家自己的存档写并发（成就/活动达成瞬间玩家往往也在操作），并发的 `mutateSave` 会读到发放前的快照、之后整份覆盖回去，刚发的称号无声消失、无任何报错。改成跟 `mutateSaveForAudit`（`anticheatAudit.ts`）同款的 rev 守卫 + 4 次重试自读自写循环。
- **道具丢失（High）**：`cards.ts::escrowCard` 没有幂等台账（对比 `equipment.ts::escrowEquipment` 早有），删除卡牌实例发生在任何幂等记录写入之前——超时后的重试请求会发现实例已删，返回 `CARD_NOT_FOUND`，拍卖行挂单从未真正建立，卡牌永久消失。仿照 `escrowEquipment` 补上 `cardIdem` 幂等台账（`CardIdemDoc.op` 新增 `'escrow'`）。
- **经济 dupe（Medium-High）**：`equipment.ts` 的 `craftEquipment`/`enhanceEquipment` 幂等声明（`equipmentIdem` 插入）发生在成本侧 rev 守卫写入**之前**（为了让掉落物 id/词条在重试间保持确定性），但重复键冲突分支此前无条件重放发货——若原请求随后耗尽重试真的没能扣费成功，并发的重复请求已经白嫖了一件道具。补 `EquipmentIdemDoc.committed` 布尔字段：只在成本真正落地后置 `true`；并发重复请求命中未提交的声明时返回「进行中，重试」而非直接放行。
- **正确性（Medium）**：`equipment.ts::reforgeEquipment` 的目标升级+材料消耗在幂等声明之后**无条件立即执行**（不像 craft/enhance 那样被 rev 循环挡在后面），只有 `equipmentInvCount` 计数递减在 rev 循环里——循环耗尽重试后旧代码删掉幂等声明并返回 `REV_CONFLICT`：客户端看到"失败"，但材料已经被销毁、目标已经升级、金币还没扣，而且幂等声明一删，客户端重试会在函数入口发现材料已经不存在而卡死在 `EQUIP_NOT_FOUND`。改为耗尽重试后不再报错，照常结算金币费用（幂等）并返回成功；`equipmentInvCount` 允许漂移 1（`assembleEquipmentInv` 已有的自愈机制会在下次读取时修正）。
- **经济损失（Medium）**：`service/economy.ts::claimRechargeMilestone` 先把档位标记为已领（不可逆——重复请求直接被 `ALREADY_CLAIMED` 挡掉），之后才调用 `commercial.grant` 发金币；发放失败/抛错时金币永久丢失且无法重试。因为 `RECHARGE_TIERS` 是静态奖励表、`orderId` 又是确定性的（`recharge.claim.${accountId}.${tierId}`），补了一条 `ALREADY_CLAIMED` 路径上的补发：命中已领时仍尝试用同一 orderId 重新结算金币奖励（成功过是无操作，没成功过则真正补发）。
- **经济 dupe（Medium）**：`service/social.ts::claimMail` 每次调用都用 `randomUUID()` 现铸 orderId；金币发放成功但后续道具/卡牌发放失败会触发回滚重试，重试铸出的是**新** orderId，commercial 自己按 orderId 去重的机制因此认不出这是重放，金币被二次发放。改成按 `mailId+accountId` 派生的确定性 orderId。
- **经济 dupe（Medium）**：`service/progression.ts::buyBattlePass` 对着同一份陈旧快照判断 `hasPass`，且每次调用都现铸 orderId——双击/客户端重试触发的两个并发请求都读到 `hasPass=false`、都各自成功扣费，只有一个能把 `hasPass` 真正翻成 `true`，输的那个拿到 `ALREADY_PURCHASED` 但已扣的金币无处退。改成按 `accountId+seasonNo` 派生的确定性 orderId，让 `commercial.spend` 自己的去重挡住并发重复扣费。
- **经济 dupe（Medium）**：`internal/economyRoutes.ts::/internal/materials/deduct` 文档声明接受 `orderId` 用于去重，但处理函数从未真正读取/使用它（对比同文件的 `/grant` 分支早就接了 `reserveGrantOrder`/`releaseGrantOrder`）——调用方（worldsvc 拍卖/材料消耗）超时重试会重复扣除材料。补齐同款 `orderId` 去重（`InternalGrantOrderDoc.kind` 新增 `'material_deduct'`）。
- **跨账号道具丢失（Low-Medium）**：`equipment.ts` 的 salvage 批量删除/reforge 燃料删除、`cards.ts::fuseCards` 的材料批量删除，都是先用 `accountId` 过滤的读做一次性所有权校验，随后的删除却只按 `_id` 匹配——校验和删除之间若该实例被拍卖行经手转移给另一账号（`_id` 不变），删除会误删买家的道具。三处删除全部补回 `accountId` 过滤。
- **未处理异常（Low）**：`accounts.ts` 里 `resolveByDevice`/`resolveByOpenid`/`resolveByOAuth`/`bindOAuth`/`bindPassword` 的 upsert/条件更新在并发首次创建/绑定时可能抛 MongoDB 文档化的 upsert 竞态重复键错误（即使用了 `upsert:true`，这是 MongoDB 已知行为，不是查询写错）——此前均未捕获，客户端重试掉线请求会看到裸 500 而非跟其他调用者一样拿到同一个 accountId/绑定结果。五处均补 `code===11000` 捕获 + 回退到重读/返回既有语义结果。
- **配置缺口（Low-Medium）**：`app.ts` 的 Fastify 实例从未配置 `trustProxy`，而 metaserver 一直跑在反代（nginx/Caddy）之后——`service/telemetry.ts` 按 `req.ip` 做的异常上报限流器因此把全体玩家共享成一个计数器（`req.ip` 恒等于反代自身地址），任何一段并发流量都可能耗尽全服共享的限流额度，静默丢弃其他玩家的真实崩溃上报。补 `trustProxy: 1`（只信任一跳反代，不盲信客户端可伪造的整条 `X-Forwarded-For` 链）。
- **资源放大（Low）**：`service/telemetry.ts::clientAnomaly` 给 `msg`/`type`/`buildVersion` 都做了长度封顶，唯独 `publicId`/`platform` 没有——且此接口是唯一显式豁免 `allowPublicIds` 白名单校验的异常上报口子（登录前也要能报），超大 `publicId` 会被 `buildAnomalyLine` 原样嵌进最多 200 条 Loki 日志行里，单次请求即可放大约 200 倍。补长度封顶（各 64/32）。
- **时序侧信道（Low）**：`accounts.ts::loginWithPassword` 在 loginId 不存在时直接返回，存在但密码错时则多等一次 scrypt 校验——尽管两种情况客户端看到的错误体完全一致，响应时间差仍能让攻击者用字典探测哪些 loginId 已注册。补 `DUMMY_PASSWORD_HASH`（固定哑值哈希）：loginId 未命中时也照样跑一次 `verifyPassword`（用攻击者的密码衍生+比对，只是比对目标是哑值），把两条路径的耗时拉平。

验证：`tsc --noEmit` 全绿；`npm test -w @nw/metaserver` 全绿（64→67 文件、771→796 测试，新增 24 例回归测试，覆盖全部 15 处修复）。**每一例并发/竞态类回归测试都按 `feedback-verify-regression-test-catches-bug-before-fix` memory 的方法论逐一验证过**——`git stash` 掉对应的修复源文件、重跑该测试确认真的转红，再 `git stash pop` 恢复：`accrueEventTask`/`pveVerify` 并发竞态用 `Promise.all` 直接对真实 Mongo 触发竞态复现均转红；`equipment.ts` craft 用手动预置未提交声明复现"并发重复请求先于原请求提交"窗口、reforge 用包一层强制 `findOneAndUpdate` 恒返回 null 的 `cols` 复现重试耗尽，均转红；`escrowCard`/`materials deduct`/`claimMail`/`claimRechargeMilestone`/`buyBattlePass` 用「先成功一次同 orderId 再来一次」「金币发放成功但下一步失败」「金币发放失败但档位已领」「并发双击」等手法逼出各自的补偿/去重路径，均转红。**过程中揪出一个假阳性**：`titles.ts` 最初写的 `Promise.all` 并发测试在修复前的代码上也能通过（MongoDB 对两个近乎同时的单文档写入的真实落地顺序凑巧让称号覆盖以外的顺序发生，测试并未真正触发竞态）——改为确定性复现（先读旧快照、等称号发放落地、再用旧快照发出"竞争写"，而不是让两者用 `Promise.all` 各自竞速）后，修复前代码稳定转红、修复后稳定转绿。`accounts.ts` 五处并发测试中，只有 `bindOAuth`（跨文档 multikey 唯一索引碰撞）在修复前代码上稳定转红；其余四处（同文档 upsert 竞态）即使打到 60 并发，在当前 MongoDB/驱动组合下也未能复现原始的重复键异常——判断是这套环境对"同过滤条件的单文档 upsert"竞态有更强的内部保护，不代表该竞态在其它 MongoDB 版本/部署下不会发生，这四处测试降级为"正确性哨兵"而非竞态复现证明，代码修复本身（捕获 code 11000 并回退重读）在无竞态时也是无害的。

**同日追加（应用户要求补齐剩余 3 处）**：`trustProxy`（新建 `test/trustproxy.test.ts`，纯 `buildApp` + `.inject()`，无需 Mongo）——两个不同 `X-Forwarded-For` 地址各自打满 30 次异常上报，验证各有独立限流额度而非共享一个桶；`clientAnomaly` 的 `publicId`/`platform` 长度封顶（`clientLog.test.ts` 新增一例，直接断言推给 Loki 的 logfmt 行里两个字段的实际长度）；`loginWithPassword` 登录时序侧信道（`auth-password.e2e.test.ts` 新增一例，用 `vi.mock('@nw/shared', importOriginal)` 包一层 `verifyPassword` 的 `vi.fn`——`vi.spyOn` 直接作用于 `@nw/shared` 的 dist ESM 具名导出会报 "Cannot redefine property"，因为这些导出是不可配置属性，必须走模块级 mock 才能拦截——断言 loginId 未命中时也调用了一次 `verifyPassword(password, DUMMY_PASSWORD_HASH)`，命中但密码错时调用参数是真实哈希）。三例均按 stash-and-confirm-red 验证过。至此 15 处修复全部有回归测试覆盖（64→67 文件、771→796 测试）。纯 bug 修复，无对外行为/契约变化（`EquipmentIdemDoc.committed`/`CardIdemDoc.op`/`InternalGrantOrderDoc.kind` 均为新增可选字段/联合分支，向后兼容）。

## rejectIfBanned/publicId 查询加缓存层（2026-07-27，中期项第 4 项）

`rejectIfBanned`（每次 auth + 每次 `/pve/enter`/`/pve/clear` 都查一次 `accounts.flags`/`deletedAt`）和 `resolveByPublicId`（socialsvc 好友/邮件按 publicId 操作时的反查，`/internal/account/by-public-id`）都是已建索引的单文档查询，本身不贵——贵的是跨公网到 Atlas M0 的那一次网络往返，缓存命中直接省掉整趟往返，而不是优化查询计划。新增 `metaserver/src/accountCache.ts` 的 `AccountCache` 类，两个方法各自一张 `TtlMap`：`getBanStatus`（60s TTL，安全网性质——`/ban`/`/unban`/`deleteAccount` 三处写入点已显式调用 `invalidateBanStatus` 立即失效，60s 只是兜底未来某个忘记失效的新写入点）、`getAccountIdByPublicId`（1h TTL，`publicId` 一旦分配永不改变，长 TTL 纯粹是内存卫生，不是过期正确性的考量；未命中永不缓存，避免拼写错误把"查无此人"焊死）。

**刻意不做成模块级单例**（对比 `dailyCounter.ts` 的 `LocalBackend` 单例）：`internal-accounts.test.ts` 等好几个测试文件在同一进程内反复复用同一批字面量 fixture（如 publicId `'123456789'`），且每个用例给它接的 `flags.banned`/`displayName` 不同——模块级单例会让前一个用例缓存的结果泄漏进下一个用例。`AccountCache` 改成每次 `buildApp` 构造一个实例，`MetaService`（走 `rejectIfBanned` 的公开路由）和 `registerInternalRoutes`（走 ban/unban/by-public-id 的内部路由）共享同一个实例——这样管理员 ban 才能立刻反映到下一次公开路由的检查，而不是各查各的、互不通气。

`resolveByPublicId` 签名从 `(cols, publicId)` 改成 `(cache, cols, publicId)`（4 处调用点：`accountRoutes.ts` ×2、`mailRoutes.ts` ×2，均已改——`mailRoutes.ts` 的两处最初被漏检，靠改完签名后 `tsc -b` 报「Expected 3 arguments, but got 2」才发现，而不是靠人工 grep）。

**验证**：新增 `metaserver/test/accountCache.test.ts`（8 例单测：命中不二次查询、不同 key 独立缓存、`invalidateBanStatus` 后立即重查、miss 不缓存）；`auth-password.e2e.test.ts` 新增一条端到端回归——真实 Mongo，注册→管理员 ban→**立即**下一次登录 403、再 unban→**立即**下一次登录 200，专门验证"失效是显式的，不是等 60s TTL 过期"这个正确性关键点，而不只是验证"有缓存"。metaserver 55 文件/689 测试、socialsvc 5 文件/76 测试全绿；`tsc -b` 全 13 个 server 包全绿。

## 进程内限流器迁 Redis + gateway presence 跨实例查询（2026-07-27，中期项第 5 项，也是本轮 5 项中最后一项）

原审计条目把这两个子项打包成一条，但调查后发现它们性质不同，先跟用户确认了处理方式（用户选择两个都做）：

- **限流器（认证/异常上报/分享额度）**：三处 `SlidingRateLimiter`/手搓 `Map`（`auth.ts` 按 IP、`telemetry.ts` 按 IP、`save.ts` 按 accountId）都有一个**现在就存在、与是否横向扩容无关的真 bug**——原实现只在读取时过滤数组内的旧时间戳，从不删除数组已变空的 key，`windows`/`stateShareRate` 这两张 Map 随进程存活时间无界增长（每个见过的 IP/accountId 永久占一个条目）。这个泄漏是本轮审计顺带发现的，不是当初把这条目列进"迁 Redis 待办"的原因（原因是"精确的全局限流需要 Redis"，见 `SlidingRateLimiter` 原注释）。
- **修复**：`service/base.ts` 新增 `RateLimiter` 接口 + `createRateLimiter(redis, ns, limit, windowMs)` 工厂——配置了 Redis 就用 `RedisSlidingRateLimiter`（`ZADD`/`ZREMRANGEBYSCORE`/`ZCARD` 的 sorted set，靠一个小 Lua 脚本原子完成"剪掉过期成员→计数→未超顶才写入"，避免两个并发请求都在写入前通过计数检查而双重放行），没配置就退回修好泄漏的 `SlidingRateLimiter`（新增 `maybeSweep`：每次 `allow()` 调用时最多每 `windowMs` 触发一次全表清扫，删掉全部过期的 key——不用后台 timer，因为 timer 会在测试套件反复 `buildApp()` 构造的大量短生命周期 `MetaService` 实例间泄漏）。`save.ts` 的 `stateShareRate` 原本是独立手搓实现（同款泄漏），本次直接改用共享的 `createRateLimiter`，顺便去重。TTL 只作存储兜底，判定仍是纯算术比较调用方 `now`，同 `dailyCounter.ts` 的约定。
- **gateway presence 跨实例查询**：`Gateway.presenceOf`（meta 拉好友列表在线标记用的批量查询）此前纯读本实例内存 `conns`，单实例部署下完全正确——**没有当前 bug**，唯一价值是"以后如果真的多开 gateway 实例"，但项目当前无横向扩容计划。用户确认后仍按原计划做：复用 gateway 已有的 `NW_GW_REDIS_URL` 连接（`connectGatewaySubscriber` 已经为宗门频道 fan-out 开了一路 pub/sub + 一路 publish 连接，presence 直接复用后者，不开第三路），扩展 `GatewaySubscriber` 接口加 `markOnline`/`markOffline`/`refreshOnline`/`onlineAccountIds`（每账号一个 TTL key，非单一 SET——单一 SET 无法给成员单独设置过期，进程崩溃不清连接会导致该账号永久"在线"）。`onConnection`/WS `close`/心跳 `sweep()`（30s 一次）分别挂 `markOnline`/`markOffline`/`refreshOnline`；`presenceOf` 先查本地 `conns`，只有本地未命中的 accountId 才查 Redis——单实例部署因此永远不会碰 Redis，本地命中的账号也永远不需要那趟（更慢的、尽力而为的）跨实例往返。
- **验证**：`metaserver/test/rateLimiter.test.ts`（8 例：`SlidingRateLimiter` 限流行为 + 内存泄漏修复的直接验证——反射读私有 `windows` 字段确认清扫后表大小有界 + `RedisSlidingRateLimiter` 连本机真实 Redis 的 Lua 脚本冒烟）；`state-replay-share.e2e.test.ts` 新增分享额度打满的端到端回归（此前零覆盖）；另写脚本经真实 `buildApp` + 真实 Redis 验证 `/auth/register` 限流端到端生效。`gateway/test/redis-presence.e2e.test.ts`（6 例：直接测 `GatewaySubscriber` 的 presence 原语 + 两个真实 `Gateway` 实例共享同一个 Redis，验证 A 的连接对 B 的 `presenceOf` 可见、断线后 B 很快看不到、没接 Redis 时退化回纯本地行为不变）。metaserver 56 文件/697 测试、gateway 4 文件/30 测试全绿；`tsc -b` 全 13 个 server 包全绿。

## 服务器间通信协议全面审计 + 修复（2026-07-28，comm-audit-internal-2026-07-28）

承 2026-07-27 前后端请求瀑布审计之后，这轮切到**服务与服务之间**：4 个探索代理并行覆盖 11 个进程的全部内部端点/出站客户端/Redis 通道（meta、gateway+matchsvc+gameserver、worldsvc+auctionsvc、social+admin+analytics+botsvc+commercial），产出 P0/P1/P2 分级发现，用户拍板"全部修复"。完整发现清单、决策表、逐批实施记录见 [`design/game/COMM_AUDIT_INTERNAL_2026-07-28.md`](../design/game/COMM_AUDIT_INTERNAL_2026-07-28.md)；这里只记落地要点。

- **P0-1 结算超时矛盾**：gameserver 上报超时曾是 10s，短于 meta 处理 hash 不一致时 `/gw/judge` 最长 20s 的等待——每一场 mismatch 局的首次上报必然超时，重试时机与仍在跑的首次结算竞态，可能双发 ELO/金币。修复：上报超时提到 35s；meta `/internal/match/report` 改为原子预留（`matches` 集合 upsert 唯一 roomId，2 分钟陈旧接管窗口）再结算再 `replaceOne` 落地，重复请求天然去重。
- **P0-2 `match_found` 投递**：matchsvc 经 Redis publish 推送 `match_found` 时不看订阅者数量，gateway 重启窗口内 publish 成功也判定"已送达"，玩家永久卡在"搜索中"。修复：0 订阅者时回落 HTTP。
- **P0-4 `claimMail` 跨库完整性**：领取附件邮件时，网络错误此前被伪装成 `NOT_FOUND`（玩家看到"邮件不存在"，实际可能已标记 claimed）；发货任一步骤失败会让邮件永久卡在"已领取但未发货"状态（再领报 `ALREADY_CLAIMED`）。新增 socialsvc `POST /internal/mail/:id/unclaim`（幂等，仅回滚本 orderId 的领取）；meta 侧发货全程包在 try/catch，失败即回滚领取状态，503 提示可重试。
- **P0-5 赛季结算调用风暴**：worldsvc 赛季结算对每个获奖账号发一次不限并发的邮件+称号授予（大区赢家宗门可达数千账号），meta 天梯赛季结算则是完全串行逐人处理。新增 `shared/src/boundedConcurrency.ts`（`runBounded`），四处收口到并发上限 8；meta 侧额外按 200 条一批处理 Mongo 游标，避免一次性把整赛季参与者读进内存。
- **P0-6 部署配置漏配**：prod compose 的 worldsvc 块缺 `NW_META_INTERNAL_URL`（赛季奖励/称号静默丢失、编队保存直接抛错）和 `NW_ADMIN_INTERNAL_URL`（商店改价面板永久无效且无日志）；`ecosystem.config.cjs`（pm2 部署路径）**全部 app 块**都没有 `NW_ADMIN_INTERNAL_URL`（flag 轮询死掉），`nw-world`/`nw-admin` 块还各缺另外几个内部 URL。全部补齐 + `matchsvc/test/deploy-config.test.ts` 扩到 33 例覆盖每个漏配组合。
- **P0-7 计费渠道隔离**：worldsvc/auctionsvc 调 commercial `/internal/spend` 从不传 `clientPlatform`（ADR-020），iOS/Android 玩家的 SLG/拍卖消费全部从 web 充值桶扣钱。client 补 `X-NW-Platform` 头（`WorldApiClient` 统一请求路径），worldsvc 7 处 spend 调用点 + auctionsvc 2 处全部穿线。
- **基础设施纪律**：`shared/src/internalFetch.ts` 新增 `fetchInternalJson<T>`（JSON 版的 `postInternal`：超时+drain+4xx JSON 业务错误保留+永不抛）；此前全仓只有 `/gw/push` 这一条路径走过封装，其余（meta→commercial 29 方法、admin 15 个 client、worldsvc/auctionsvc/socialsvc 全部出站）都是裸 fetch。本轮全部迁移。
- **死代码清理**（约 15 项，详见设计文档"确认删除"清单）：meta 的 `/admin/grant-title`（`/internal/title/grant` 的重复实现）、`/internal/leaderboard`、`/admin/gacha/pools`(POST)+commercial `/internal/gacha/pool`+`createLimitedPool`；`GatewayClient.presence/invalidateFriends`；socialsvc `/social/player/:id/rank`+client `getPlayerRank`（被 `/social/profile/:publicId/extra` 取代）；auctionsvc `grantMaterial`（材料走邮件附件交付）；admin 的 `/admin/mismatches`、`/admin/suspicious-pve`、`/admin/promo/codes`(GET+POST)（ops 前端零消费）；`shared/roomRegistry.ts` 整模块（从未接入 matchsvc 自己的内存房间表）。**踩坑记录**：`matchsvc.roomStart()`/`/mm/room/start` 最初也判定为死代码删除，但 `matchsvc.test.ts`/`gateway-routing.test.ts`/`matchsvcClient.test.ts` 直接调用它验证 no-op+拒绝语义，删方法本身破坏了 9 个通过中的测试——只验证了改动落地的 metaserver/socialsvc 两个包，隔一轮全量 11 包扫描才发现，已逐字恢复。教训：改一个被其它包测试直接引用的符号，必须连带跑那个包的测试，不能只测自己改的包。
- **认证一致性**：meta 内部路由的 `authed()` 原来只收 `x-internal-key` 值，丢弃 `x-internal-caller`——非 strict 模式下所有 40+ 内部路由的审计 caller 恒为 null。签名改收整个 `req.headers`，41 处调用点批量替换。
- **save-fields 契约拍板**：`/internal/save-fields` 契约漂移（worldsvc 侧 `SaveFields` 声明 `unitLevels`/`gear` 为必填，meta 实际从不返回）核实后确认引擎侧 `runSiegeBattle` 从不读这两个已标 `@deprecated` 的参数（CC-3 后改用 `cardInstances`+`equipmentInv`）——删声明和对应调用点，而非补字段。

**未完成，留独立任务**：P1 合并优化（match-identity 合并端点、`GET /save` wallet N+1、socialsvc profile/extra 单跳化、save-fields 批量+缓存等一长串已诊断待实现项）——诊断已写入设计文档，本轮聚焦 P0 正确性缺口 + 已完成的 P2 清理，性能优化留下一轮。

**验证**：11 个 server 包全量 `tsc -b` + vitest 交叉扫描（除 matchsvc 2 个与本轮无关的既有失败——已 spawn 独立任务跟踪），client `tsc --noEmit` 全绿。

## 服务器逻辑全面审计 + 修复（2026-07-29，server-logic-audit-2026-07-29）

承前两轮（07-27 存储方式、07-28 服务间通信）之后，这轮切到**单进程内部业务逻辑本身**：算法复杂度/内存管理/数据结构设计/输入校验健壮性/单进程容错。完整发现清单、决策表、逐项修复记录见 [`design/game/SERVER_LOGIC_AUDIT_2026-07-29.md`](../design/game/SERVER_LOGIC_AUDIT_2026-07-29.md)；这里只记落地要点。

- **装备复制漏权**：`equipEquipment`（metaserver）从不调用项目自己写好的 `isEquipped()` 占用检查，同一装备实例可同时装到两张卡上复制战力。补检查。
- **commercial 资金丢失风险（6 处）**：rechargeVerify/paddleComplete/promoRedeem/orderDelivered/subscriptionCardBuy/starterBuy growth 均是"先落地已发放记录、再执行 credit 副作用"，崩溃在两步之间会让钱永久丢失且无法重放补发。引入 `isStaleClaim` 宽限窗口（15s，`CommercialServiceBase`）：窗口内维持原状（不与真正的并发赢家抢跑），窗口外验证 ledger/order 状态并补发（verify-and-heal）。
- **worldsvc troops 并发扣负**：`startMarch`/`occupyTile` 是 check-then-act，并发双发可把 troops 打成负数；改用 `city.ts` 训练花费已用的 `findOneAndUpdate({troops:{$gte:cost}})` 原子写法。
- **gateway/gameserver `maxPayload` 缺失**：WebSocketServer 未设置，补 1MB。
- **socialsvc CORS 头漏 `x-nw-platform`**：07-28 修了 worldsvc/auctionsvc，socialsvc 被漏，补上。
- **analyticsvc 埋点 `ts` 无边界校验**：可永久绕开 90 天 TTL 或污染按天聚合；`clampEventTs` 限制在 [-24h,+5min]。
- **4 处无界内存增长**：admin `loginAttempts`（攻击者可控 key）、gateway `friendsCache`/`publicIdCache`、socialsvc `chatRate`、metaserver `accountCache.TtlMap` 均补 sweep-on-traffic（同既有 `SlidingRateLimiter.maybeSweep` 套路）；gameserver `Room.pending` 补 `MAX_PENDING_PER_TICK=200` 防洪水攻击撑大 replay。
- **socialsvc family memberCount 双重递减**：`leaveFamily`/`kickMember` 并发双发会重复 `$inc -1`；`deleteOne` 的 `deletedCount` 门控 decrement。
- **worldsvc `resetSeason` 未清理 Redis 幽灵索引**：ADR-051 的 `occ`/`cover` 哈希未随季重置清理；新增 `WorldCorePush.clearSpatialIndexes`。
- **auctionsvc `scanAnomalies` 静默截断**：5000 条上限无排序无告警可能漏检最近成交；改按 `soldAt desc` 排序（新索引）+ 命中上限时告警。
- **readJson 内存泄漏遗漏面**：07-28 只修了 gateway/matchsvc 的 `destroy()` 缺失，这轮补齐 socialsvc/analyticsvc/commercial/botsvc 四个内部端口。
- **admin `retryTicket` 无原子 claim**：并发点击可重复触发 `mail.send`；补 `retryLockedAt` CAS（mirrors `approveTicket` 既有状态 CAS）。
- **尝试后回退**：`decompressReplayDoc` 异步化在 `matchReport.ts` 的每场排位赛热路径上暴露了 `pvp-card-stats.e2e.test.ts` 对该 fire-and-forget 链路"近乎同步完成"的隐含时序假设——改成真异步后测试断言跑在链路完成前。已回退保持同步；根治需要连带把测试改成 poll 或引入更强的一致性保证，留独立任务。

**未处理（更大改动或更低优先级，非本轮范围）**：~~matchsvc 赛前状态纯内存无持久化~~（同日以独立分支解决，见下文"matchsvc 赛前状态持久化"节）；~~worldsvc `getMarches`/`getStationed` 全服拉取 + `computeMarchPath` 缺索引扫描~~（同日以独立分支解决，见"SLG worldsvc 要点"对应条目）；~~`siegeEngine` 势均力敌攻城同步阻塞事件循环~~（同日以独立分支解决，见下方"siegeEngine 移入 worker_threads 池"节）；~~gateway 控制消息无 per-connection 限流~~（同日以独立分支解决，见下条）；admin 四眼审批例外（策略决策）；`dailyCounter.LocalBackend` 长期 Redis 故障下无界增长（概率低）。

## gateway 控制消息 per-connection 限流补齐（2026-07-29 追加，known-gap #4）

补上 07-29 审计"已知但本轮未处理"清单第 4 条：`Gateway.handle()`（`server/gateway/src/Gateway.ts`）此前对 room_create/room_join/room_ready/room_start/room_leave/duel_invite/duel_respond 完全没有限流，脚本客户端可无限速刷 matchsvc，`duel_invite` 还能直接刷屏骚扰其他玩家。

- **限流器搬家**：`RateLimiter`/`SlidingRateLimiter`/`RedisSlidingRateLimiter`/`createRateLimiter`（连同 07-27 补的 `maybeSweep` 内存泄漏修复）从 `metaserver/src/service/base.ts` 整体搬到 `server/shared/src/rateLimiter.ts`（纯提取，逻辑字节不变），`@nw/shared` 桶导出。`metaserver/src/service/base.ts` 改成 `export { ... } from '@nw/shared'` 的薄再导出——auth.ts/save.ts/telemetry.ts 三处既有调用点（分别是登录 IP、异常上报 IP、存档分享 accountId 限流）全部 `import ... from './base.js'` 不变，零改动。
- **分级限额**：两档，都以 accountId 为 key，60s 滑动窗口：**TIGHT**（`NW_GW_RATE_LIMIT_TIGHT`，默认 10/min）管 `room_create`/`room_join`/`duel_invite`——会创建状态或通知其他玩家，比 metaserver telemetry 的 30/min 更紧；**STANDARD**（`NW_GW_RATE_LIMIT_STANDARD`，默认 20/min）管 `duel_respond`/`room_ready`/`room_leave`/`room_start`——只作用于玩家自己已持有的状态。`ping`/`client_caps`/`judge_verdict` 不限（ping 是最热路径，judge_verdict 是可信的战斗结果上报）。`Gateway.handle()` 拆成「限流门禁」+ `dispatch()`（原 switch 逻辑原样保留），未命中限流表的 case 直接同步进 `dispatch`，不额外走一次 Promise。
- **降级路径**：`Gateway` 构造时先用 `createRateLimiter(null, ...)`（内存版）；`index.ts` 里 `connectGatewaySubscriber` 连上 Redis 后调用既有的 `setPresenceStore`，同一处顺带把两个限流器重建成 Redis 版——单实例/无 Redis 部署（今天的现实）自动留在内存版，跟 `dailyCounter`/`accountCache` 同款降级哲学一致。Redis 连接本身：`redis.ts` 的 `GatewaySubscriber` 新增 `rateLimitClient`（`subClient.duplicate()` 单开一路，不复用 presence 的 `pubClient`，避免限流的 `EVAL` 突发和 presence 的 `SET`/`PEXPIRE` 互相排队）。
- **限流反馈**：命中限流不再静默丢弃。`duel_invite` 复用已有的 `duel_cancelled` 通道（`reason:'rate_limited'`，跟 `not_found`/`offline` 同一个字段是纯字符串，零协议改动）；其余 gated case 复用 `room_error{code:'RATE_LIMITED', message}` 通用错误通道。均未改 `transport.proto`。

**验证**：`npx tsc -b` 全 13 个 server 包（含新增的 shared/gateway 改动）全绿。`shared/test/rateLimiter.test.ts`（8 例，从 metaserver 原样搬来，含 Redis 冒烟 skipIf）+ `metaserver/test/rateLimiter.test.ts`（收窄为 2 例薄再导出冒烟，验证 `./service/base.js` 仍可用）+ metaserver 全量 724 测试（1 个此前因 worktree 未 `npm install`/未 build `socialsvc` 导致的环境性失败，build 后即绿，与本次改动无关）。gateway 新增 `test/rate-limit.test.ts`（6 例：TIGHT 超限拒绝+反馈、duel_invite 超限→`duel_cancelled{rate_limited}`、TIGHT/STANDARD 互不干扰、无限流 case 不受影响、无 Redis 时内存降级仍生效、Redis 共享两实例场景 skipIf——本机无本地 Redis 故跳过，同 `redis-presence.e2e.test.ts` 既有约定）；gateway 全量 32 测试 + 7 跳过全绿。

**验证**：13 个 server 包 `tsc -b` 全绿；改动涉及的 10 个包 vitest 全绿（metaserver 731、commercial 144、worldsvc 350、gateway 27、gameserver 58、socialsvc 78、analyticsvc 25、admin 45、auctionsvc 77、botsvc 40，均含新增回归测试）。

## matchsvc 赛前状态持久化（2026-07-29，matchsvc-prematch-persist）

承上一节"已知但本轮未处理"的第一条：好友房间/排位队列/切磋邀请此前纯内存，matchsvc 重启即全丢，且客户端只能靠自己的（远长于服务端故障恢复时间的）超时才会发觉。用户拍板两个方案都做——重启后主动通知 + Redis 全量持久化。

- **新增 keyspace**（`server/matchsvc/src/persist.ts`，仿 `shared/src/activeMatch.ts` 的 backend 写法：`connect*Redis()` 复用 matchsvc 已有的单一 Redis 连接、`saveX/deleteX/loadAllX` 全 null-safe、失败只 warn 不抛）：
  - `nw:room:{roomId}` + `nw:roomByAccount:{accountId}`（滑动 TTL 3600s，量级参照 `activeMatch.ts` 的 `ACTIVE_MATCH_TTL_SEC`，而非 `REAP_MS`——好友房间可能长时间等待对方输入房间码）；
  - `nw:queue`（ZSET，member=accountId、score=enqueuedAt，天然维持等待顺序）+ `nw:queueEntry:{accountId}`（无 TTL——内存态本身也没有自然过期，只在出队时清）；
  - `nw:duel:{inviteId}` + `nw:duelByAccount:{fromAccountId}`（固定 TTL 75s，略大于 `DUEL_TIMEOUT_MS=60s`）。
  - 每个 keyspace 都有一个"影子指针"设计：`nw:room:*`/`nw:duel:*` 存正文，`nw:roomByAccount:*`/`nw:duelByAccount:*`/`nw:queue` ZSET 存反查——两者理论上应同生共死（同一次 `multi().exec()` 写入），但 Redis `allkeys-lru` 淘汰策略下可能因访问频率差异被不对称淘汰（正文更大更容易被挑中）；rehydrate 时检测到"反查指针在、正文没了"就判定为该 accountId 的状态**丢失**，这是 `prematch_lost` 推送的判定依据（而不是尝试猜测"从没写成功过"这种没有任何 Redis 痕迹的边缘情况——那种情况本质上无法检测，只能靠这条影子指针机制覆盖能覆盖的那部分）。
- **写透传**：`Matchsvc.ts` 现有的每个 mutation 点（`roomCreate`/`roomJoin`/`roomReady`/`removeFromRoom`/`destroyRoom`/`onConnected`/`onDisconnected`/`duelInvite`/`duelRespond`/`expireDuel`/`cancelDuel`）各配一次对应读写；`Matchmaking.ts` 新增 `onEnqueued`/`onDequeued` 回调钩子（`enqueue()`/`remove()`/`tick()` 内部配对分支各触发一次），由 `Matchsvc` 构造时注入 `saveQueueEntry`/`deleteQueueEntry`。没配 `NW_REDIS_URL` 时这些调用全部 no-op，行为与改动前完全一致（不要求生产必须有 Redis）。
- **启动 rehydrate**（`Matchsvc.rehydrate()`，`index.ts` 在 `startInternalHttp` 之前 `await` 它）：从 Redis 载回 room/queue/duel 到内存 Map/数组后，主动推送刷新——房间成员重新收到 `room_state`；排位队列条目收到新增的 `queue_state`（纯 rehydrate 确认消息，proto 里无字段）；排位重建后先跑一次配对（`Matchmaking.rehydrateDone()`），已经凑对的直接收到 `match_found` 而不是 `queue_state`；切磋邀请按剩余窗口重新 `setTimeout`（窗口已过的按正常超时处理，推 `duel_cancelled{reason:'timeout'}`）。任何一类"反查指针在、正文丢了"的账号收到新增的 `prematch_lost{context:'room'|'queue'|'duel'}`。
- **新增 proto 消息类型**（`contracts/transport.proto` `ServerMsg` oneof 新增字段 27/28）：`QueueState{}`（无字段，纯确认）、`PreMatchLost{context: string}`。gateway 侧 `matchsvcClient.ts`/`proto.ts`/`Gateway.ts` 的 `toServerMsg` 分支同步增加两个 `PushMsg` kind（`queue_state`/`prematch_lost`）。四个受影响的 server 包（gateway/gameserver/metaserver + client）各自的 `npm run proto:gen`（buf codegen）已重新生成并提交。
- **客户端**（`client/src/net/NetSession.ts`）：收到 `queue_state` 时纯日志（UI 已经乐观展示"搜索中"，无需动作）；收到 `prematch_lost` 时按 context 分流——`queue` 且本会话记得上次排位的 deck（`lastRankedDeck`）→ 静默重新调用 `createRanked()`（`room.error.prematchLost` 提示语一次都不会出现，玩家无感知）；`duel` → 合成一次 `onDuelCancelled({reason:'lost'})` 复用现有"切磋邀请已失效"横幅逻辑（`FriendsScene`，新增 i18n `friends.duel.lost`）；`room`（或 `queue` 但没记住 deck 的兜底分支）→ 合成一次 `onRoomError({code:'PREMATCH_LOST'})` 复用现有"退回房间选择+toast"逻辑（`RoomScene`，新增 i18n `room.error.prematchLost`）。三语言（zh/en/de）文案已补。

**验证**：新增 `matchsvc/test/persist.test.ts`（18 例，纯 Redis 读写原语，假 Redis client）+ `matchsvc/test/rehydrate.test.ts`（14 例，覆盖写透传实际发生、rehydrate 正确重建内存态且仍可继续操作、配对/超时的边界情况、`prematch_lost` 触发条件）；matchsvc 既有 75 例回归全绿（合计 107 例）。13 个 server 包 `tsc -b` 全绿；client `tsc --noEmit` 全绿、843 例 vitest 全绿。gateway（27 例）/gameserver/metaserver/shared 既有测试套件全绿（proto 重生成无回归）。

## siegeEngine 移入 worker_threads 池（2026-07-29，独立 worktree `feat/siegeengine-worker-threads`）

承上一条 07-29 审计"已知但本轮未处理"第 3 条：`runSiegeBattle`（`worldsvc/src/siegeEngine.ts`）内部经 `runHeadless`（`@nw/engine`）跑一个完全同步的 tick while 循环，势均力敌的攻城战（`shouldUseCheapSiege` 筛不掉的那部分）最长可同步跑 `SIEGE_BATTLE_TIMEOUT_TICKS(18000)+TICK_MARGIN(600)` tick，期间独占 worldsvc 事件循环（调用来自 `scheduler.ts` 的后台 `setInterval` tick，不是同步 HTTP handler，但一样卡住进程上所有其它请求/结算）。

- **方案**：新增常驻 `worker_threads` 池，而非"每场战斗现起 worker"（起 worker 有 tens-of-ms 级开销）也不是"每 N tick 让出一次"的过渡方案（用户已拍板结构性方案）。
- **`worldsvc/src/siegeWorkerPool.ts`**：`SiegeWorkerPool` 类，构造时起 `size`（默认 `os.cpus().length-1`，`NW_SIEGE_WORKER_POOL_SIZE` 覆盖）个 worker；简单的"空闲 worker 或排队"调度（无需引第三方库）。崩溃自愈：worker `'error'`/`'exit'`（非 0）触发替换——reject 该 worker 在飞的任务、`splice` 出列表、`terminate()`、`spawnWorker()` 补位；`retiring` 标志防止同一次崩溃的 `'error'`+`'exit'` 双重处理。任务级超时（默认 30s，`NW_SIEGE_WORKER_TASK_TIMEOUT_MS` 覆盖）：卡死 worker 会被强制 `terminate()` 并替换，而不是让某个任务永久悬空吃掉一个槽位。排队不设上限、不拒绝（S8-3b 场景是后台调度 tick，允许排队等待）。进程内单例 `getSiegeWorkerPool()`（首次调用时才 construct，避免 worker 内部 `import` `siegeEngine.ts` 时递归起 worker-within-worker）+ `shutdownSiegeWorkerPool()`（挂 `index.ts` 的 `shutdown()`）。
- **`worldsvc/src/siegeWorker.ts`**：worker 入口，`parentPort.on('message', ...)` 收 `SiegeBattleInput` → 调 `runSiegeBattleSync`（原 `runSiegeBattle`，纯计算逻辑本身零改动）→ postMessage 回 `SiegeResolution` 或错误字符串。全程无 Mongo 访问，所有落库仍在主线程。
- **`siegeEngine.ts`**：原来唯一导出的同步 `runSiegeBattle` 改名 `runSiegeBattleSync`（worker 内直接调）；新增 async `runSiegeBattle(input)` 作为主线程入口，内部 `getSiegeWorkerPool().submit(input)`。6 个调用点（`combatSiege/{arrival.ts×4, occupation.ts×2, encounter.ts×1}`，均已在 `try{ res = runSiegeBattle(...) }catch` 内且外层函数已是 `async`）改 `await runSiegeBattle(...)`——纯改调用位置，无需重构调用方。
- **dev/prod 双模路径**：`__filename.endsWith('.ts')` 判断当前是 tsx 直跑源码（dev `node --import tsx`、vitest）还是 `tsc -b` 编译产物；前者时 worker 也指向 `.ts` 并传 `execArgv:['--import','tsx']`（worker 是独立 V8 isolate，不继承父进程 CLI 标志），后者指向编译好的 `dist/siegeWorker.js`，无需额外 execArgv，`tsx` 保持纯 devDependency。
- **踩坑（`worker.unref()`）**：最初图"短生命周期脚本忘记 `close()` 不至于挂起"给 worker 加了 `.unref()`，结果编译产物冒烟测试时静默无输出——`.unref()` 让"等待 worker 消息"不再计入事件循环活跃度，若调用方脚本自己没有其它 ref'd 句柄（无 HTTP server/DB 连接），Node 会在 worker 结果送达前就判定循环已空自行退出，任务结果被无声丢弃。worldsvc 真实进程永远有 HTTP server/Mongo/scheduler 定时器等其它 ref'd 句柄所以从未观察到，但对未来任何独立脚本消费这个池都是地雷——已去掉 `.unref()`，改为完全依赖显式 `close()`（已接入 `index.ts` 的 `shutdown()`；测试文件 `afterEach` 里各自 close）。
- **确定性**：同 seed+同双方阵容+同引擎代码，只是换了执行线程——`siegeWorkerPool.test.ts` 直接断言 `pool.submit(input)` 的结果与主线程 `runSiegeBattleSync(input)` 逐字段相等；原有 `siege`/`base-siege`/`stronghold`/`passage`/`nation-bonus`/`field-encounter` 等 e2e 断言值全部不变（执行位置改动，非数值改动）。
- **新增测试** `worldsvc/test/siegeWorkerPool.test.ts`（10 例）+ 两个测试 fixture worker（`test/fixtures/{crashWorker,hangWorker}.ts`，仅测试用，让崩溃/挂起可确定性复现）：基本调度（提交→结果、单 worker 排队多任务、坏输入 reject 不拖垮 worker）、崩溃自愈（单/双 worker 各自崩溃后 `pool.size` 不变、坏 worker 只影响自己在飞的任务）、任务超时强制替换、`close()` 语义、以及"白拿的好处"验证——6 个满板大规模战斗（`SIEGE_SYNTH_ARMY_MAX_TROOPS` 双方）在 6-worker 池上 warm-up 后并发耗时 vs 同款输入主线程串行 `runSiegeBattleSync` 循环耗时，断言并行版本快过串行版本 30% 以上（真实跨核，而非池内排队假并行）——这也印证了 `scheduler.ts` 的 `Promise.allSettled` 现在能真正跨核并行多场攻城，不再是同线程抢时间片。
- **验证**：`worldsvc` 47 文件/360 测试全绿（含新增 10 例）；`tsc -b` 全 13 个 server 包全绿。

## 三日重构复核 + 追加修复（2026-07-29，audit-followup-fixes-0729）

对本轮（server-logic-audit）+ 同日三个跟进分支（matchsvc 持久化、worldsvc 查询优化、siegeEngine worker 池）+ gateway 限流做了一次跨客户端/服务器、服务器/服务器协作一致性的复核。完整发现清单见 [`SERVER_LOGIC_AUDIT_2026-07-29.md`](../design/game/SERVER_LOGIC_AUDIT_2026-07-29.md) "二次复核" 节；这里只记落地要点：

- **装备复制竞态**（本轮表格 #1 的修复本身不完整）：`equipEquipment` 补的占用检查是读后写，并发装到两张卡的竞态没堵上。`CardInstanceDoc` 新增 `gearInstanceIds`（`gear` 非空值镜像）+ 唯一多键索引，Mongo 层保证同一 instanceId 不会同时出现在两个文档里；写入捕获 E11000 转译为 `EQUIP_IN_USE`。稀疏索引 + 空数组不占索引项，历史文档自愈无需迁移。
- **commercial 资金双发竞态**（本轮表格 #2 的修复本身不完整）：`isStaleClaim` 宽限窗口只防"仍在飞的正常请求"，过了窗口的两个并发治愈请求仍能都读到"未入账"再都 credit。`RechargeDoc`/`OrderDoc`/`PromoRedemptionDoc` 各补 CAS 标记字段（`healedAt`/`healClaimedAt`），治愈前先原子声明，只有赢家才继续 credit/续做；`subscriptionCardBuy`/`starterBuy` growth 共享新增的 `CommercialServiceBase.claimOrderResume()`。
- **siegeWorkerPool 任务超时计时器原来在 `submit()` 入队时就武装**，而非任务真正派发给 worker 时——高负载下排队超过 `taskTimeoutMs` 的任务一旦真正开始跑就永久失去挂死检测（一次性 `setTimeout` 早已在排队期间空耗掉，且从不重新武装），卡死的 worker 再也不会被替换。改为在 `dispatch()`（任务真正分配给空闲 worker 那一刻）才武装计时器；`PendingTask.timer` 相应改为可空。新增回归测试 + fixture `test/fixtures/slowThenHangWorker.ts`（对修复前代码回退验证过确实会失败，不是空转通过的假回归）。
- **gateway `rate_limited` 缺 i18n 分支**：`FriendsScene` 落进默认档位显示"找不到该玩家"（比通用兜底更误导）；补分支 + 三语言文案。

验证同上（13 包 tsc -b 全绿；commercial/metaserver/worldsvc/client 全量 vitest 全绿）。四处 CAS 修复均补了并发复现回归测试（`Promise.all` 并发调用足以触发"读后写"竞态，无需额外调度器 hack），且逐条对修复前代码回退验证过确实会失败，详见 [`SERVER_LOGIC_AUDIT_2026-07-29.md`](../design/game/SERVER_LOGIC_AUDIT_2026-07-29.md) 末尾"并发回归测试补齐"节。

## O-CM5 修复：客户端补发 `X-Chat-Region` + 伴生 CORS gap（2026-07-29）

`CONTENT_MODERATION_DESIGN.md` §1 现状盘点发现的独立缺口：`openapi-social.yml` 给 `/social/chat/send`、`/social/family`、`/social/family/{familyId}/messages` 都声明了可选头 `X-Chat-Region`，socialsvc 也确实按头值选敏感词区域词表，但客户端从未实际发送过这个头——三处调用点全部静默落到 `?? 'global'` 兜底，cn/de/en 区域词表在真实请求里从未生效。

- **修复**：新增 `client/src/net/chatRegion.ts`（`currentChatRegion()`，取当前 i18n locale 映射到 `ChatRegion`，zh→cn/de→de/en→en，镜像 `server/shared/src/chatFilter.ts` 的 `regionFromLocale`——账号级 `AccountDoc.region` 是服务端私有字段，客户端没有对应信息源，i18n locale 是现成的最佳代理信号）。接入 `WorldApiClient.createFamily`/`sendFamilyMessage`（`req()` 新增可选 `extraHeaders` 形参）与 `ApiClient.sendChat`（`ApiClientBase.request`/`post` 补齐 `extraHeaders` 透传到已有的 `fetchRaw`）三个调用点。
- **伴生 CORS gap**（会阻断此修复本身，真实浏览器会在预检 OPTIONS 阶段整体拦截请求，curl/Node fetch 测试不触发预检所以看不出来）：`server/socialsvc/src/httpApi.ts` 手写的 `access-control-allow-headers` 清单没有 `x-chat-region`——与 07-28 `X-NW-Platform` CORS 停机同一类问题（见本文档"服务器间通信协议全面审计"节 P0-7 关联段落），这次是在功能落地前、真实浏览器走查时主动发现并修复，未造成生产事故。
- **worldsvc 未改动**：`/sect/create`、`/nation/message` 走的是 `regionFromAcceptLanguage(Accept-Language)`，浏览器 fetch 会自动带上这个标准头，不受此 gap 影响。
- **验证**：`server/socialsvc/test/chatRegionHttp.e2e.test.ts`（新增，真实 HTTP + 真实 Mongo，四例覆盖三个端点的带头/不带头对照）、`cors-headers.test.ts` 新增一条 `x-chat-region` 预检回归、`client/test/net-x-chat-region.test.ts`（新增，三个客户端调用点按 locale 断言实际发出的头）；另在无 Docker 环境下用 `mongodb-memory-server` 缓存的 `mongod` 二进制单开真实 Mongo + metaserver + socialsvc + client `web-e2e` 入口跑了一次真实浏览器走查——locale=en 时创建含 cn 词表专属词"私服"的家族名成功创建（201，落到 en/global 词表未命中），切到 locale=zh 后同样名字被拒（400，命中 cn 词表），且能看到真实的 CORS 预检 OPTIONS 往返。client 846 例 + socialsvc 84 例 vitest 全绿，两包 `tsc --noEmit`/`tsc -b` 全绿。
