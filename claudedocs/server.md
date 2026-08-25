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
- **`test/**` 也纳入类型检查（2026-08-19）**：每个 workspace 除 `tsconfig.json`（只含 `src/**`）外还有一份 `tsconfig.test.json`（`src/**` + `test/**`，只报错不产出），跑法是包内 `npm run typecheck:test` 或根目录 `npm run typecheck:test` 扇出全部 13 个包；CI 在 `server-checks` job 的 `tsc -b` **之后**跑（这些是非 build 程序，要用 `tsc -b` 产出的 `dist/*.d.ts` 解析 `@nw/*`）。`checkWorkspaceCoverage.mjs` 会检查每个包都有这份配置和脚本，**并且检查 `tsconfig.test.json#exclude` 里的每个文件都被 `client/tsconfig.fulllink.json` 接管**（2026-08-20 起；唯一一条 exclude 是 auctionsvc 的 full-link e2e，它 import 真实 client 网络层，只有 client CI job 同时装了两侧依赖能检查它）。注意 `references` 不被 `extends` 继承、必须在 test 配置里重复；`module` 各包按 vitest 的实际解析覆盖（详见 [`server-testing-typecheck.md`](server-testing-typecheck.md) 该节）。首次接入暴露 758 个错误 / 140 个文件，已全部清零。
- **codegen 自动前置（2026-08-08）**：metaserver / worldsvc / socialsvc / auctionsvc（openapi）+ gateway / gameserver（proto）六个包各自的 `build`/`typecheck`/`dev`/`test` 都挂了对应 `pre<script>`，本地跑这四个命令时 npm 会自动先跑一遍 `gen:api:*`（metaserver 是 `gen:api:contracts && gen:api:server`）/`proto:gen`，不用再记得手动生成——**这不是取代 CI 的 `:check` 步骤**，只是把「忘记生成」的窗口从「commit 前」提前到「本地敲命令那一刻」；CI 的 staleness check 仍是最后一道防线（防手改生成文件、跳过 npm 脚本直接改 `.yml`/`.proto` 又不本地跑一遍等场景）。`npm run dev:all`（`dev-up.ps1`）走的是 `node --watch` 直连、不经过 npm 脚本，因此在 `dev-up.ps1` 里单独插了一步「regen codegen」覆盖这条路径。触发事件：同一天两次因为改 `.yml` 忘记重新生成导致 CI 挂（worldsvc sect-mate 字段、socialsvc accountId 字段）。**补记**：socialsvc 那次事故暴露 `.github/workflows/ci.yml` 其实从未挂 `gen:api:social:check`（只有 contracts/server/world/auction 四步，social 被漏掉），本地 pre-hook 之外这条线之前完全没有 CI 兜底；已于当日补上第五步 `gen:api:social:check`，现在六个包（四个 openapi + 两个 proto）在 CI 侧才算真正对齐。

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
  - **`WorldCore` 再拆（2026-07-03）**：`core.ts` 那 1069 行 `WorldCore` 类按关注点拆成一条**线性继承链**，每层一文件（不改任何 `core.xxx` 调用点、组合出的对象完全等价）：`core/kernel`（clients/deps/序列/capitals/bounds/coord/marchView）→ `core/yield`（settle/yieldRecord/recomputeYield）→ `core/push`（Redis 调度 ZSET + gateway push）→ `core/nation`（建国/命名/查询）→ `core/spawn`（出生点选择 + 3×3 footprint ADR-025）→ `core/vision`（家族/门派成员、战争迷雾视野、反查观察者）→ `core/map`（地图/单格/getMe 读 + tile→view mapper）；`core.ts` 收为 `export class WorldCore extends WorldCoreMap {}` + 从 `core/helpers.ts` 转出自由函数（emptyResources/deleteInBatches/lootSummary/MARCHABLE_KINDS）。最大文件 238 行。为什么用继承链而非可复用 mixin：单类拆分下继承链天然让 `this` 跨层全可见、构造器只在 kernel 声明、无 mixin 泛型脚手架；仅 `allySectMemberIds` 因被上层 `core/map` 调用从 `private` 改 `protected`。207 e2e/单测全绿。**2026-08-02 目录订正**：这七层原先是 `src/` 根下的 `coreKernel.ts`/`coreYield.ts`/… 文件名前缀，而同一个服务里 `combatSiege.ts` 早已用真目录 `combatSiege/` —— 同一约定两种写法。现统一为 `core/{kernel,yield,push,nation,spawn,vision,map,helpers}.ts`，`core.ts` 保持薄装配壳（`from './core'` 仍解析到文件而非目录，链外调用点零改动），`src/` 根条目 40 → 33。**2026-08-11 改判为独立类+组合**（见下文"单文件 500 行收敛"章节的同日条目）：7 层继承链拆掉，`core/kernel.ts` 删除、内容并入 `core.ts` 的 `WorldCore` 类本身（它既是所有 sibling 的共享根依赖，又是外部 47 个调用点直接读写的完整对外面，唯一一个"根类=装配壳"合一的案例）；`core/{yield,push,nation,spawn,vision,map}.ts` 各自变成独立类（`YieldService`/`PushService`/`NationService`/`SpawnService`/`VisionService`/`MapService`），构造器接 `core: WorldCore`（`VisionService` 多接 `push: PushService`，`MapService` 多接 `yieldSvc`/`vision`），`WorldCore` 转发全部约 46 个非 kernel 方法。
- **combat 域二次拆分（2026-07-03）**：`combat.ts` 1335 行再拆为薄门面 `CombatService`（60 行，委托）+ `combatMarch.ts`（`MarchService`：行军 start/recall/list + 到达处理与分发）+ `combatSiege.ts`（`SiegeService`：攻城/扫荡结算 + ADR-026 延迟建筑血量模型）+ `combatDefense.ts`（`DefenseService`：防御配置 + 回放观战）+ `combatShared.ts`（`refundTroops` 唯一跨 march/siege 共享 helper，取 `core` 的自由函数）。`MarchService.applyArrival` 经构造注入的 `SiegeService` 分发 attack/sweep（唯一 peer 边）。公开 API 不变，`service.ts` 仍 `new CombatService(this)`。顺带清掉原文件遗留的死 import。207 e2e 全绿。
  - **`MarchService` 再拆（2026-08-02）**：`combatMarch.ts` 已长到 947 行，按 `combatSiege/` 同一套薄装配壳 + mixin 链拆为 `combatMarch/base.ts`（两个字段 `core`/`siege` + 构造）→ `combatMarch/command.ts`（玩家指令：startMarch/recallMarch/instantReturnMarch/getMarches）→ `combatMarch/arrival.ts`（调度器驱动的结算：processDueArrivals/advanceMarch/applyArrival/applyMove/tryParkTeam）→ `combatMarch/stationed.ts`（驻扎列表/召回）；`combatMarch.ts` 收为 22 行装配壳。**零跨 mixin 入口**，故除构造器参数属性 `private`→`protected` 外没有任何可见性变化。worldsvc 50 文件/400 测试全绿。
- **`shared/slg.ts` 拆分（2026-07-05，god-file split）**：原 1656 行单文件按域拆为 `shared/src/slg/`：`core`(错误/枚举/ID/容量/主城footprint/GEN 旋钮/通用数值)/`noise`(确定性噪声)/`auction`(护栏+反RMT检测)/`city`(主城建筑)/`province`(国家/省份几何)/`shop`(商店)/`prosperity`(繁荣度/赛季结算/分片)/`mapgen`(地形+`proceduralTile`+地图模板)/`march`(产出+A*寻路)/`siege`(结算+视野+攻城关卡+卡牌兵役)。`index.ts` 薄门面 barrel，服务端 `@nw/shared` 导出路径不变（`export * from './slg'` 自动落到目录）零改动。**但 client 侧 webpack alias / tsconfig paths 为避免拉入 `password`/`logger`（含 `node:crypto`/`node:fs`），直接硬编码指向旧 `slg.ts` 单文件而非走包导出**——拆分当时漏改，导致 `client/tsconfig.json` 与 `client/webpack.config.js` 的 `@nw/shared` 都指向已删除的文件，`tsc`/webpack 构建全炸；已改为指向 `slg/index.ts`（2026-07-05 修复）。最大子文件 349 行
  - **`core.ts` 再拆出 `tileRender.ts`（2026-08-20）**：2026-08-19 往 `core.ts` 加的两段渲染几何（`isCityGroundTile`/`tileFeatureBuilding` 城市地面判定 + `resMotifJitter`/`resMotifPlacement`/`resLevelLabelFontPx`/`resLevelLabelText` 资源图案摆放与等级标签）把 `core.ts` 顶到 687 行，触发 CI 的 500 行收敛 gate。两段都是不依赖 `core.ts` 其余 ID/枚举/经济常量的纯函数、且已有独立测试（`server/shared/test/core.test.ts`），是天然的"独立函数模块"切割点（切割优先级：独立函数模块 > 组合 > 继承链），故整段搬进新文件 `shared/src/slg/tileRender.ts`，`index.ts` 加一行 `export * from './tileRender'`——barrel 导出路径不变，client/`tools/map-editor` 两侧都走 `@nw/shared`/`@nw/shared/slg` 包名导入而非深路径，零改动。`core.ts` 回落 479 行。
- **野外城池攻占（ADR-074 P1，2026-08-25）**：城池从「一张贴图」升级为实体。新集合 **`cities`**（每世界约 64 个 `CityDoc`：世界中心 1 + 州府 9 + 分级城 54），归属主体是**宗门**（`ownerSectId`），不是账号+家族——被删除的 `applyNationChange` 正是因为按账号+家族记归属才让一个人拿走一个省。新增/改动的落点：
  - 数值真源 `shared/src/slg/citySiege.ts`（波次梯 / 耐久+回复曲线 / 保护期），全部由 `server/tools/econ-sim/src/citySiegeRun.ts` **实测标定**，不是纸面推导（演算见 `design/game/ECONOMY_VERIFICATION_LOG_CAPACITY.md` §13-SLG-CITYSIEGE）。改这些常量必须重跑 `npm run --workspace @nw/econ-sim city-siege`。
  - `core/citySiege.ts`（`CitySiegeService`：`initCities` / 惰性耐久回复 / footprint 反查 / 宗门门槛）— `core/nation.ts` 的对位物，同样是组合而非继承。
  - `combatSiege/arrival/citySiege.ts`（波次梯战斗 + 安排延迟耐久伤害）、`combatSiege/cityDamage.ts`（耐久结算 + 易主 + 公告）。后者从 `combatSiege/damage.ts` 分出来是因为几乎没有共享逻辑：城池不是格子、没有账号主人、易主写的是宗门归属和频道公告而不是主城搬迁或格子交接。`settleSiegeDamage` 靠 `SiegeDamageDoc.cityId` 分流。
  - **两个容易踩的机制点**（都是实测逼出来的，改之前先读 `citySiege.ts` 的注释）：①**波次梯是「每次行军各打一遍完整 3 波」，不是城池共享状态 + 重生计时**——共享波次一旦清空，重生窗口内到达的每次行军都会以「无守军」拿到整份耐久伤害，一个人 5 队邻格往返就能刷几十次零成本命中；②**每波必须显式传 `defenderBaseHp`**，否则回落到引擎平坦的 `BASE_HP=100`，而 ADR-069 之后一张带 300 兵的盾兵卡一击就砸掉它，波次在守军开火前就结束、整条梯子免费。
  - 契约：`openapi-world.yml` 的 `WorldCityNodeView` 加了 `ownerSectId`/`durability`/`durabilityMax`/`regenPerHour`/`protectedUntil`/`siegeLog`，`PlayerWorldView` 加了 `sectId`（客户端据此决定是否给围攻按钮）；新增 `GET /world/cities` 仅用于城池面板打开时刷新——**刻意不做推送**：一座城每小时会被打几十次，按宗门（≤900 人）扇出每一击是推送水龙头，易主才走宗门频道公告。
  - **客户端血条锚点坑**：城池血条要锚在 `getCityContentTopFracForLevel(level)` 给的**美术顶边**，不是 `-sprite.height`（精灵单元格顶边）——`citySpriteTiles` 按 footprint 定尺，每张图上方都有透明留白，7×7 的城会把血条顶到视口外、看起来像没做。紧挨着的主城血条 2026-07-22 就因矮建筑踩过同一个坑。这个只有真跑起来截图才看得出来。
  - **⚠️ 世界中心曾经打不了（补测抓出，已修）**：`validateMarchTarget` 的 `attack` 分支里，ADR-074 之前的 `if (proc.type === 'center') throw ...` 排在新加的城池分支**之前**，而 `isCityGroundTile` 覆盖 `center`+`familyKeep` 两种——于是全图最重要的那座城成了唯一打不了的城，`settleCityDamage` 的全服公告成死代码。原来 21 条 e2e 全用分级城，一条没碰到。**新加城池类分支时，先查 `proceduralTile` 的 type 有没有被更早的旧拦截抢走。**
  - **城池优先级只有一份**：`CITY_KIND_RANK`（`citySiege.ts`）。`rasterizeMapEdits` 曾自带一份 `CITY_PAINT_RANK`、`_cityGroundNodeAt` 的遍历顺序是第三份——P0 那个「Lv.8 分级城盖掉 Lv.10 州府」就是三份漂移出来的。现已收成一份，并用**行为**断言钉住（真实重叠格上生成器/`cityNodeCovering`/「发布未改动节点表零 diff」三者一致），而不是断言常量相等。
  - 回归：`worldsvc/test/city-siege.e2e.test.ts`（26 例，真 Mongo）、`shared/test/citySiege.test.ts`（20 例纯函数）、`econ-sim/src/citySiege.test.ts`（28 例含真引擎战斗的门禁）、`client/test/ui/worldMapCityClick.ui.ts`（15 例面板）、`client/test/ui/worldMapCityDurabilityBar.ui.ts`（6 例血条**几何**——原来只断言面板文案，漏掉了「血条画在屏幕外」整整一类缺陷）、`httpApiActionSiegeMapGaps.e2e.test.ts`（+2，`GET /world/cities` 的路由分派）、`season-ops.e2e.test.ts`（+2，赛季开启/重置的 city 生命周期）。
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

- **`playerWorld` 并发写一轮修复（2026-08-24）**：起因是玩家报「派闲置队伍占地时弹 `Concurrent update, please retry`」。全量审计 45 个 `cols.playerWorld` 写入点后发现，报错的那个（`combatMarch/command.ts` 的 `startMarch`）恰恰是全库保护**最严**的一处（`rev` 乐观锁 + `troops:{$gte}` 条件双保护），它只是唯一一个撞车时**诚实报错**的；另有 20 处 filter 只有 `_id`，撞车时静默覆盖。本轮修了四类：
  - **① 训练落地的兵力复制（P0，可稳定利用）**：`city/training.ts::processCompletedTraining` 原先「N 次 `$pull` + `$set:{troops: 快照+已练}`（绝对值、无守卫）」，读到写之间夹着 buff 追平写循环和每批一次 `$pull`；这期间任何 `$inc:{troops:-n}`（出兵/分兵/占格）都被绝对值 `$set` 静默回滚——兵回来了，队伍也出去了。窗口每 2s 复现一次、且完成时刻玩家可从倒计时精确预知。改为**单次聚合管道 update**：`$filter` 按同一 `completeAt<=t` 谓词出队、`$sum` 出实际出队批次的兵量、`$min` 对活文档的 `$troopCap` 夹取、`nextTrainingCompleteAt` 由出队后的数组派生（`$$REMOVE` 而非 null，否则会污染 partial index 且仍被 `{$lte:t}` 命中）。顺带修掉「并发 `trainTroops` 新入队的批次被陈旧 `remaining` 抹掉镜像而搁浅」的同源二级 bug。
  - **② `yieldRate`/settle 不变量（6 处）**：**改 `yieldRate` 必须在同一次原子写里按旧费率结算 `resources` + 推进 `lastTickAt`**。此前 3 处推进了 `lastTickAt` 却不写 `resources`（整段未结算产出直接丢弃，最狠的是 `passiveRelocate`——主城被打爆、领地全失的同一刻再吞掉一段产出），另 3 处改了 `yieldRate` 却不推进锚点（未结算窗口被按新费率追溯重算）。
  - **③ `startMarch` 的 REV_CONFLICT（用户可见症状）**：删掉那次写入，而不是给它加重试。`settle()` 是读时惰性的（`getMe` 每次重算），只有**改 `yieldRate` / 改 `buildings`（容量上限）/ 花资源**的写才必须落盘，派兵三者都不沾——纯多余记账。卡牌军/闲置再派现在对 `playerWorld` **一个字都不写**（`rev` 也不 bump：它无业务语义、不出现在 `PlayerWorldView` 和任何 httpApi 响应里，纯乐观锁，空写 bump 只会白白让别人的守卫失效）；散兵池分支只留 `$inc:{troops:-n}` + `troops:{$gte}` 条件，去掉 `rev` 守卫后连「兵不够 vs 撞车」的歧义消解读都不需要了。同时补上 `idleRedispatch` 认领 `StationedDoc` 后任何抛出路径的**回滚**（原先部队会凭空消失）。
  - **④ `relocateBase` 收尾写改为无条件**：走到那一步金币已花、9 格主城已迁，抛 REV_CONFLICT 会留下「已扣费 + 已搬家 + `mainBaseTile` 指向已删除格子」的不一致。守卫存在的唯一理由是那个快照派生的 `resources`，换成 `settleExpr` 后写入无陈旧值，可无条件落地；两个并发迁城的互斥仍由前面的 rev CAS 认领负责（输家在花钱前就失败）。
  - **新惯用法：聚合管道 update**。全库此前 **零事务、零管道 update**，45 处全是操作符对象。新增 `core/yield.ts::settleExpr(buildings, now)`——`settle()` 的管道表达式孪生体，读 `$resources`/`$yieldRate`/`$lastTickAt` 在库内算同一个 `min(cap, floor(res + rate×dtHours))`，消掉 read-modify-write 窗口，因而**不需要守卫**。它仍在本库「单文档 CAS、不用跨集合事务」的约定内（`combatSiege/transfer.ts`）。改 `settle()` 时两边必须同步改。`cap` 仍是调用方按 `buildings` 快照算的字面量（只随建筑升级变动，慢一 tick 会在下次 settle 自愈）。
- **无守卫写入扫尾（2026-08-24，接上一条）**：把上一轮"未做"的那批逐个定性完毕。全部 40 个 `cols.playerWorld` 写入点分三类，**"filter 里只有 `_id`"本身不是缺陷判据，写的形状才是**——判据是"这次写入是否发布了一个从快照派生的绝对值"：
  - **改掉的 5 处（确有害）**：`territory.ts::occupyTile`（troop 扣减本来就原子，但同行的 `resources` 是快照绝对值）、`territory.ts::abandonTile`（完全无 filter，窗口横跨 tile 删除 + stationed 认领 + 两次 removeCover + recomputeYield，本文件最宽）、`city/buildings.ts::applyDueBuilds`（2s tick 与 speedupBuild 同时可达）、`combatSiege/helpers.ts::applySectLeaderPenalty`（成员全量先读后逐个写，最后一个成员的窗口横跨前面所有成员的写入）、`city/training.ts` 的加速 catch-up（整数组盲写，会把并发 `trainTroops` 刚入队、资源已扣的批次直接写没）。前四处改走 `settleExpr`；catch-up 改为守卫 `speedupSettledAt` 水位——每个重写 `trainingQueue` 的写者都会推进这个水位，所以"水位变了"精确等价于"有人在我脚下重算了队列"，输掉这一跳不损失任何东西（水位也没推进，2s 后下一跳按新数组重算同一段 overlap）。**刻意没有**把 `applyTrainingSpeedupCatchup` 翻成聚合表达式：那会把 buff 公式分叉成两种语言，收益为零。
  - **`settleExpr` 新增可选 `scale`**：宗门惩罚要的"先结算再打折"。放在库内算而不是调用方算，否则调用方又变回发布快照绝对值——正是这个方法要消除的形状。
  - **确认安全、就地写明理由的**：`combatDefense::setDefense` 与 `teams::recoverCard`（写的是本命令自带的值、点路径限定，没有别人的增量可覆盖，last-writer-wins 即预期语义）；四处 cardState 战斗结算（`arrival/baseSiege`、`arrival/landSiege`、`encounter`、`occupationBattle`——点路径分卡写，且一张卡只属于一个队伍、受 TEAM_BUSY 串行化，两次结算不可能同时命中同一张卡）；`db/playerDocs.ts` 的启动期迁移（`runMigrations` 在服务收流量和调度器启动之前跑完，没有并发写者）。
  - **仍然开放的一处，明确不在并发扫尾范围内**：`city/teams.ts::distributeTroops` 对 `cardState.<id>.currentTroops` 做 `$inc`，但**没有"这张卡是否正在外征战"的门禁**——分兵若落在某次战斗结算的读与写之间，会被结算的 `newTroops` 覆盖，玩家白掉从池子里付出去的兵。之所以不在这轮动：①窗口是单次结算写入内部的几毫秒，不是被修那批的 2s 级窗口；②要正确关掉它，要么禁止给出征中的卡分兵（这是玩法规则，不是并发修复），要么把结算改成"扣损失"的 `$inc`——但 `newTroops` 是对出战兵力乘存活率、不是减法，改了就是改战斗数值。两者都该单独拍板。
  - **回归测试**：`worldsvc/test/playerworld-unguarded-writes.e2e.test.ts`（真 Mongo，7 例）。每例都在"读与写之间"确定性地注入一次真实的 `$inc` 增量再断言它存活；其中 4 例已验证在修复前的代码上失败（`expected 50000 to be 57777`，即增量被覆盖），catch-up 那例失败为 `length 2 but got 1`。**注意**：该文件里宗门惩罚的算术断言是从 `combatSiege-damage-helpers-gaps.test.ts` **搬过来的**——结算移进管道后，本进程内的 mock 再也观察不到那个数字，原处只保留"交给 Mongo 的 scale 是否正确 + 是否走管道"的形状断言。这是覆盖率的净增强（原断言验的是 mock 上由本进程算出的算术），但**以后凡是把算术移进聚合管道，都必须同步把数值断言迁到真 Mongo 的 e2e，否则等于静默删掉覆盖**。

- **`tiles` 扫尾 + cardState 改扣损失 + 两个新防腐设施（2026-08-24 第三轮，收口）**：前两轮只扫了 `playerWorld`；`tiles` 有同样的 `$set` 绝对值 / `$inc` 增量混用。19 个写入点逐个定性，改了 5 处：
  - `combatSiege/arrival/landSiege.ts` 两处（守方胜的 `garrison`、结构 chip 的 `structure.hp` + 驻军清空）→ 改成持久化**伤亡/削减量**并 `$max: [0, …]` 夹底。`garrison` 是 `troops` 的翻版：增援到达走 `$inc`（`combatMarch/arrival.ts`），攻城结算原先写绝对值。
  - `shop.ts` 保护罩叠加 → 管道 `$max` 后 `$add`，两次并发购买可交换（原先都扣钱、只生效一次）。
  - `combatSiege/damage.ts` 的存活 HP 写入、`city/buildings.ts` 的墙升级 durability 重设 → **rev CAS + 有界重试**，不是管道：值不是文档的纯函数（`maxHp` 来自守方墙等级、base 分支还要折进 `regenDurability`），而"重读后重算"恰恰是正确语义。
  - **cardState 改扣损失（用户拍板：允许给出征中的卡分兵）**：四处战斗结算不再写绝对存活数，改为持久化每卡**损失**（新 `cardStateSettlement.ts` 的 `cardStateDeltaPipeline`）。**无并发时 `deployed - losses` 恰等于 `newTroops`，结果逐位相同**；只有并发增兵时才有差异——那次增兵会完整存活而不是被抹掉。
  - **两个新的防腐设施**（本轮真正的长期价值）：
    - `worldsvc/test/settle-expr-parity.e2e.test.ts`（12 例）把 `settle()` 和 `settleExpr()` 同输入对跑、要求逐位相等，覆盖夹取 / dt≤0 / 缺字段 / 超上限 / cabinet 抬高上限 / `scale`。此前"必须同步"只写在注释里、**没有任何东西强制**。变异验证：移除 `settleExpr` 的上限夹取 → 4 例立刻失败。
    - `server/scripts/checkAbsoluteWrites.mjs`（`npm run check:absolutewrites`，已接入 ci.yml）把本轮判据变成 gate：`playerWorld`/`tiles` 上任何 `$set` 运行总量的写入，必须是 delta 表达式或在 `ALLOWED` 里带理由。**这个脚本自己被两次修正**——先是扫注释（记录旧 `$set` 形状的说明文字把它自己绊倒了），再是把 delta 判断做在整个 `$set` 字面量上（每条管道都带 `rev: { $add: … }`，于是整块被豁免，一个把 `troops` 改回绝对值的变异**没被拦住**）。现在逐字段判断、先剥注释，变异必被抓。
    - `worldsvc/test/siege-worker-module-graph.test.ts`（**第三件，本轮 CI 红灯逼出来的**）：`cardStateSettlement.ts` 拆出去后为了不动调用点，在 `siegeEngine.ts` 里加了一行转出口 `export { … } from './cardStateSettlement'`。本地 965 例全绿，Linux CI 上 8 例炸成 `siege worker crashed mid-battle: Cannot find module '.../src/cardStateSettlement'`。病因：`siegeEngine.ts` 会被 `siegeWorker.ts` 加载进 `worker_threads` realm（dev/test 下由 tsx 直接跑 `.ts` 源码），**该 realm 里无扩展名的相对说明符在 Linux 上解析不了**——2026-08-14 已经踩过一次（见 `siegeWorker.ts` 的长注释），当时以为只是入口那一跳。这个模块图此前的相对导入**全是 `import type`（编译期擦除，根本不解析）**，所以这行转出口是它的第一个加载期相对导入。修法：不转出口，四个调用点直接从 `cardStateSettlement` 导入，`siegeEngine.ts` 顶部写死 INVARIANT。gate 从 `siegeWorker.ts` 静态走一遍模块图，要求所有**加载期**相对导入写明扩展名（`import type` 与函数体内的动态 `import()` 豁免——后者正是 siegeWorker 自己的逃生口，"worker 真会走到的惰性 import 仍会漏"已写进注释当成已知盲区）。变异验证：把那行转出口加回去 → 立刻报 `siegeEngine.ts -> './cardStateSettlement'`。**教训：这类缺陷在 Windows 上 100% 复现不了，所以只能做成到处都跑的静态 gate，不能指望 CI 当第一道防线。**
  - **归因纠正（值得记住的教训）**：第一版注释和测试把 `damage.ts` 的病因写成"同一 tick 内多个攻击者互相覆盖"，测试在**修复前的代码上也通过**——因为 `processDueSiegeDamage` 是 `for … await` 顺序循环、每次迭代自己重读，同跳内本来就正确叠加。真实对手是 `scheduler.ts` 用 `Promise.allSettled` **并发**跑的五个 tick 任务（`processCompletedBuilds` 的墙升级重设 durability）以及多实例部署。修复本身是对的，错的是理由；测试改成在读写窗口内注入交错后才真正会咬人。**写并发回归测试时，"顺序调用两次"几乎从不等于"并发"。**
  - **U13 的最后一条已另开一轮收口**：拍卖成交的跨集合幂等与回滚不属于这套单文档手法（原子性边界跨三个进程、四个库），见本文「拍卖行成交原子性」。

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

## 拍卖行成交原子性

- **跨集合结算账本（U13 收口，2026-08-24 第四轮）**：前三轮扫的是 worldsvc 的单文档并发写；拍卖成交是**唯一一条跨集合**的多步原子性问题，前三轮那套 rev CAS / 聚合管道完全帮不上忙。
  - **为什么不上事务**：一次成交要原子的三件事落在**三个进程、四个库**——金币在 commercial（`notebook_wars_commercial`，HTTP `/internal/spend`）、挂单状态在 auctionsvc（`notebook_wars_auction`）、标的与卖家收款在 meta（`notebook_wars`，系统邮件）。Mongo 事务只覆盖单个 client/session，最多能包住 `auctions`+`auctionDaily`+`auctionPrices`——**钱和货一个都不在里面**。买来的覆盖率是零，代价是把 auctionsvc 的测试 harness 从 standalone mongod 改副本集、并破掉 `shared/src/mongo.ts` 那条「单文档 CAS、零事务」的全库约定。**故走幂等键 + 补偿**，形状照抄 commercial `orders` 早就在用的那套（insert-first 抢键 → 状态 → `isStaleClaim` + CAS 续跑，`commercial/src/service/base.ts`）。
  - **能跑通的前提**：下游本来就都幂等了——commercial 按 `orderId` 去重**且把它绑定到首个使用它的账号**，系统邮件按 `dispatchKey` 去重，meta 库存端点按 `orderId` 去重。所以账本不需要实现分布式原子性，只需要一份**能被重新驱动的持久化待办**。
  - **新集合 `auctionOrders`**（auction 库，一次跨服务流程一行）+ 四个文件：`journalPlans.ts`（**全部幂等键 + 五个流程的 plan**，纯函数）/ `journalSteps.ts`（**唯一**碰跨服务资产的地方）/ `journal.ts`（引擎：`begin`/`advance`/`decide`/`finalize`/`rollback`，请求路径与扫描器**跑同一份代码**，避免「一个公式两种语言」）/ `journalSweep.ts`（`resumePending` 续跑 + `repairUnsettled` 修复）。五个流程全部上账本：挂单托管 / 一口价成交 / 出价托管 / 结拍 / 撤单+过期退回。
  - **引擎的核心判据**：失败分两类，处置相反。**业务拒绝**（`SlgError` —— 余额不足 / 装备已装备 / 卡有配装）是下游真判过并拒了，证明什么都没动，可以立刻回滚；**传输失败**（超时 / 连接重置 / 502）什么都不证明，请求可能已完全生效，**此时回滚就是凭空造币或复制道具**——一律按下游自己的幂等键重试到拿到确定答案，再决定要撤什么。配套两个字段让回滚不靠猜：`started`（前缀步骤已发起，区分「没试过」与「试过但结果未知」——否则回滚会把前缀调用本身打出去，纯粹为了把钱再邮回来）、`requires`（补偿步骤依赖哪个正向步骤真落地了）。
  - **`decided` 是「向前」与「回滚」的分界**：之前请求还没承诺往下走（可能死在了玩家什么都不知道的时候）→ 撤；之后是一笔已经答应的交易 → 跑完（下游明确拒绝仍会经 `finalize` 的 catch 撤回）。
  - **顺序改动（用户拍板）**：一口价改**先认领、后扣款**，「已扣款却被抢走 → 退款」这条补偿路径整体消失。**竞拍出价刻意保持相反顺序**（先扣款、后写 `topBid`）——`topBid` 是日后结拍付给卖家的依据，绝不能存在「有出价、没托管款」的中间态。这个不对称是有意的，改任一侧前先读 `journalPlans.ts` 里两个 plan 的注释。
  - **顺带查出并修掉的实际缺陷**（都是这轮真正的收益）：
    - `auction_buy:{id}` **不含买家**：两个买家抢同一挂单时，第二个撞上 commercial 的跨账号归属校验、拿到莫名 `BAD_REQUEST`（玩家看到的不是「已被抢走」）；更糟的是扣款成功后崩溃会让这个 orderId 被那个没拿到货的买家**永久占用**，该挂单从此谁都买不了。
    - 同一竞拍者同一金额的**两次并发出价共用键**：commercial 只扣一次，输掉 CAS 的那一路照样发一笔全额退款邮件——凭空造币。
    - `settleAuctionWin` 的 CAS **只有 `{status:'open'}`、漏了 `rev`**：一笔新出价落在过期扫描器的批量读与结算之间时（每条中间夹着多次 HTTP 邮件，窗口很宽），按**陈旧 `topBid`** 成交——标的发给刚被退款的上一位出价者，新出价者的托管款孤立。这属于前三轮那一类，漏在了这儿。过期分支的 `open→expired` 同样补了 `rev`。
    - **系统邮件失败只记日志不抛**：生产上最可能真丢资产的一条，连崩溃都不需要——meta 抖一个 500，卖家的钱或买家的货就没了，只留一行日志，且没有任何东西会去重试。`HttpAuctionMailClient` 现在配置可用时**抛错**（未配置的 null client 仍静默 no-op，保持 AUCTION_DESIGN 声明的降级语义）。
    - `spend` 请求体没带 `reason`，commercial 侧 `str(b.reason)` 取到空串 → 所有拍卖扣款在 ledger 里 reason 为空。
  - **`settledAt` 与两个连带改动**：`AuctionDoc.settledAt` 只在交付真正完成后写，它的**缺失**是 `repairUnsettled` 的扫描条件（结拍/撤单/过期是「先认领、后写账本行」，崩在中间没有行可续，但会留下「终态挂单 + 无 `settledAt`」这份欠账凭证，plan 是文档的纯函数所以能重建）。因此 ①`purgeClosedListings` 加了「不删还欠着交付的挂单」；②`db.ts::runMigrations`（启动期、收流量前）给所有已终态挂单补 `settledAt`——旧代码关掉的那些要么已发邮件、要么已静默丢失，数据里分不出来，重驱动会按新 dispatchKey 再发一遍附件，把一次不可挽回的旧丢失变成一次**新的复制**。
  - **防腐设施**：`npm run check:auctionjournal`（`server/scripts/checkAuctionJournal.mjs`，已接 ci.yml）——五条文件作用域规则，把每种跨服务能力（`commercial.spend` / `sendSystemMail` / `meta.escrow*|grant*|deductMaterial` / `deliverItem|deliverCoins`）和**全部 `auction_…` 幂等键字面量**各锁在唯一一个文件里；先剥注释（每条规则的说明都必然引用它禁止的形状，会失败在自己文档上的门禁会被删掉），并额外检查「规则在它该管的文件里还匹配得到东西」，防止能力搬走后规则静默失效。
  - **门禁自身做了变异测试**：`auctionsvc/test/check-auction-journal.test.ts` 建临时 fixture 树——干净树必须过、五条规则各自被重新引入必须挂并报对规则、只出现在注释里必须过、能力搬出 owner 文件必须报「silently enforcing nothing」。（上一轮 `checkAbsoluteWrites` 的第一版就是因为 `rev` 的管道自增顺带豁免了同一个 `$set` 里的其它字段，成了一个不能失败的门禁。）
  - **行为侧回归** `auctionsvc/test/journal-atomicity.e2e.test.ts`（真 Mongo，22 例）。两点刻意与既有 `auction.e2e.test.ts` 不同：①**下游 fake 是忠实的**——`commercial.spend` 复刻了真实的 insert-first orderId 槽位**和**跨账号归属校验、带余额、只记真实发生的扣款；邮件 fake 按 dispatchKey 去重且可指定某个交付失败 N 次。共用键在「只往数组里 push」的 fake 上看起来就是两次正常调用，**这轮的键位 bug 对那种 fake 是不可见的**。②**并发一律在读写窗口内注入**，绝不用「顺序调两次」代替——后者在修复前的代码上照样通过。三条关键用例已实测在修复前的代码上失败：去掉购买键里的 buyerId → 报 key 归属冲突而非 `AUCTION_CLOSED`；去掉结拍的 `rev` → `expected 'sold' to be 'open'`；去掉重复提交去重 → `expected 10 to be +0`（10 金币凭空退款）。另外把 `repairUnsettled` 改成 no-op 也验证了修复用例会挂。
  - **既有测试的三处预期变更**：`mailClient.test.ts` 两例从「失败只记日志不抛」翻成「必须抛」；`auction.e2e.test.ts` 的「被抢走 → 退款邮件」整例重写为「压根没扣款」（顺序倒过来后那个结果不存在了）；`composition-wiring.test.ts` 注入的依赖从 `AuctionServiceDelivery` 换成 `AuctionOrderJournal`（`delivery.ts` 移到 `journalSteps.ts` 后面，facade 不再持有它）。auctionsvc 行覆盖率 92.0% → 95.06%（217 例全绿）。
  - **ops 欠账可见性（同日第二轮补齐）**：原先一个卡在 `attempts >= 10` 的欠账只体现在日志里——等于「没人发现，直到玩家来投诉」。整条链补完：
    - **auctionsvc**：`auctionService/journalAudit.ts`（新，只读）`listSettlementDebts(filter)` 读 `auctionOrders` 的 `pending` 行（done 已交付完、aborted 已干净撤回，都不是欠账），排序「重试最多的在前，然后最老的」——这两种形状才值得人看，失败一次的几乎都只是在退避里。内部端点 `GET /internal/audit/settlements`（X-Internal-Key，仅 GET）。`docToAdminView` 加 `settledAt`。
    - **admin**：`AuctionClient.listSettlementDebts` → `SlgAuditService.slgListSettlementDebts`（能力沿用 `slg.audit.view`，**没有新增能力**，省掉「新能力要 VPS `--build` 重建菜单」那步）→ `GET /admin/slg/audit/settlements`。
    - **ops 前端**：「SLG Audit」页新增「Unfinished settlements」区块 + 挂单查询表多一列「Settled」（`OWED` 标红）。每行给出账本行 id（= 该次结算所有下游键的前缀，直接拿去查 commercial 订单 / meta 邮件派发）、流程与方向、**还欠谁什么**、已完成到哪、重试次数（`stuck` 标记）、重开次数、欠了多久 / 下次何时重试。
    - **刻意只读，没有「立即重试」按钮**：扫描器本来就在永不放弃地重试，手动戳只会和它抢；真正有用的下一步动作都在这个服务之外。三层的注释都写了这条，免得后来人以为是漏做。
    - **两个容易做错的点**：①`accountId` 过滤必须同时匹配 `actorId` **和任何被步骤欠着的账号**（`steps.accountId` / `compensation.accountId`）——被超价的出价者不是那笔出价流程的 actor，只按 actorId 过滤会对「玩家说没收到退款」精确地回答「没有欠账」。②欠账列表必须复用引擎的 `applicableCompensation`（已从 `journalPlans.ts` 导出，rollback 和这个读模型共用）——否则「这次回滚到底会不会退这笔」会分叉成两个公式，控制台就会显示引擎压根不打算付的欠账。
    - **`AUCTION_SETTLEMENT_STUCK_ATTEMPTS` 挪进 `@nw/shared`**：journal.ts 用它决定日志升级到 error，`journalAudit.ts` 用它决定 `stuck` 标记。一个常量，免得「日志里喊得很大声」和「在 ops 里列为卡住」漂移成两回事。
    - **验证**：真实链路跑通过一次——内存 mongod + 桩 auctionsvc + **真实 admin 后端** + ops dev server，登录后驱动两张表，DOM 里逐格核对（`OWED`/`settled`/`—` 三态、`buy · delivering`/`bid · unwinding`、`seller: alice ← 1080 coins`、`14 (stuck)` 的 `pill failed`、`retry #1`、校验分支报错不发请求）。**这个环境的 browser pane 不合成帧，截不了图**，所以证据是 DOM 抽取而非截图。

## 上线收口（Track 2，2026-06-23）

- **赛季收束闭环（L2-1）**：`POST /admin/ladder/season/roll` 现在「先结算上一季全部参与者，再推进时钟」——`rollSeason(cols, commercial, now)` → `settleSeasonParticipants` 游标遍历 `pvp.seasonNo===上季` 的存档发段位奖励邮件 + 授赛季称号 + 写 `ladderSeasonSnapshots` 快照（`_id=${seasonNo}:${accountId}` 幂等账本）。与玩家回归惰性迁移（`migrateIfStale`）三重幂等并存。软重置仍惰性做。详见 `design/game/SEASON_DESIGN.md §15.1`
- **称号端点（L2-2）**：`GET /titles`（含 `parseTitleId` 派生 source/seasonNo）+ `PUT /title/equip`（仅已授予；空串卸下；回推 SaveData）。存储复用 `save.titles[]`/`save.equipped.title`。codegen 重生顺带修复了 `client/src/net/openapi.ts` 此前累积的漂移
- **IAP 凭据加固（L2-3）**：`createReceiptVerifier` 在 `NODE_ENV=production` 下强制关闭 dev 桩（缺凭据 fail closed，不发币）；`commercial/src/index.ts` 引导期对 `production+NW_IAP_DEV=true` 拒启。凭据申请/配置/上线 checklist 见 `design/game/IAP_CREDENTIALS.md`，环境变量样板见 `server/.env.example`
- **充值幂等防跨账号泄露（防御加固，2026-06-29）**：`rechargeVerify` 的 `receiptId` 幂等回放分支此前无视消费者归属——若同一 receiptId 先被 A 账号消费，B 账号再带同 receiptId 来会回读并返回 **A 的钱包余额**，metaserver `iapVerify` 据此 `mirrorCoins` 把 A 的余额写进 B（跨账号余额泄露）。真实平台票据全局唯一不可触发，但 E2E 复用常量 dev 票据时中招。修复：两条回放路径（`existing` 命中 + E11000 并发竞态回读）均加 `accountId` 归属校验，他账号占用 → `INVALID_RECEIPT` 拒绝；同账号重放仍正常返回本账号余额。新增 e2e 用例 `server/commercial/test/service.e2e.test.ts`「同 receiptId 被他账号占用 → 拒绝」

---

## 历史记录（已拆出）

本文 2026-08-17 从 913 行收敛回「快查」本分——下面这些**已完成的**审计/补测记录搬到了独立文件，按需再读：

| 内容 | 文件 |
|---|---|
| Mongo/Redis 读写审计、存储结构调整（cardInv/mapBaselines/Daily 迁 Redis）、worldsvc/metaserver 代码审查、通信协议与逻辑审计、限流迁 Redis、siegeEngine worker 池、**单文件 500 行收敛** | [`server-audits.md`](server-audits.md) |
| server 端测试**全量覆盖审计**（2026-08-05/08-10，「哪些代码路径完全没测过」）+ 下面三册的索引 | [`server-testing.md`](server-testing.md) |
| 各服务**覆盖率百分比**补齐（metaserver/admin/gameserver/gateway/botsvc/auctionsvc/socialsvc/commercial/shared/worldsvc/engine/matchsvc/analyticsvc），一个包一节 | [`server-testing-coverage.md`](server-testing-coverage.md) |
| 覆盖率百分比工具、90% 硬门禁、CI 并行拆分、CI 稳定性（flaky/retry/确定性规则） | [`server-testing-tooling.md`](server-testing-tooling.md) |
| `test/**` 接入类型检查（13 个包的 `tsconfig.test.json`、`client/tsconfig.fulllink.json`、`MatchReplayDoc.commands` 收紧） | [`server-testing-typecheck.md`](server-testing-typecheck.md) |

> **写新内容放哪**：改的是「服务端现在的约束/端口/启动方式」→ 改本文对应小节；记的是「某次审计/补测做了什么」→ 追加到上面对应的分册末尾，别再堆回本文。
