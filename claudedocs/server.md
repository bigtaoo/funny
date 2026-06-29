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

## 启动（dev）

```powershell
cd server
docker compose up -d        # MongoDB 副本集（⚠ 须 Linux containers 模式：docker context use desktop-linux）
npm install
npm run dev:all             # 起全部进程（dev-up.ps1）
```

### 本地全栈模拟（完整：9 进程 + 主客户端 + 3 工具 + mongo + redis）

`docker-compose.local.yml` 拉起**全部 9 个服务端进程 + redis + 主客户端(nginx) + animator/level-editor/ops 三个工具前端**，每次 up 都 `--build`（从当前代码重建镜像）。

```powershell
./local-up.ps1              # 构建最新代码 + docker compose，浏览器开 http://localhost:8088
./local-up.ps1 -Fresh       # 先清空 mongo 数据卷
./local-up.ps1 -Port 9000   # 换主游戏入口端口（客户端地址构建期烘焙，须重建 nginx 镜像）
./local-down.ps1            # 停（保留 DB）；-Fresh 连数据清
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

- `shared/slg.ts`：`proceduralTile(world,x,y)` 确定性程序化地图（单一来源，client/server 共用）
- `auctions.expireAt` **故意非 TTL**——过期需结算退还托管物/竞拍结拍，用普通索引+扫描器
- **拍卖行反 RMT（S8-5，2026-06-21）**：每日限额（`auctionDaily` 集合 TTL 计数 lists/buys）+ 价格护栏（`auctionPrices` 滑窗中位数 refPrice + 静态回退，越界 `PRICE_OUT_OF_RANGE`）+ 绑定禁挂机制（`AUCTION_BANNED_MATERIALS` 空集）+ 季末冻结（settling 拒挂）/ 清算（`clearWorldOnReset` 退还，挂在 `/admin/world/reset`）+ 竞拍（`saleMode=auction`：`placeBid` 托管/防狙击/买断，`/auction/{id}/bid`）。机制权威 `design/game/AUCTION_DESIGN.md`
- **异常交易审计（D/G7 反 RMT，2026-06-21，SLG_DESIGN §17.13）**：下单硬闸（限额/护栏/禁挂）管不到「合谋账号价格带内反复定向倒货」→ 加离线检测：`AuctionDoc.soldAt`（sold 时写）+ `AuctionService.scanAnomalies` 拉近期 sold 投影 → shared 纯函数 `detectAuctionAnomalies` 按「卖家→买家」有向配对聚合（repeated/designated/high_value 信号，severity high/medium）；内部端点 `GET /admin/world/audit/anomalies`（X-Internal-Key，并入 `/admin/world/*` 分支）。admin 侧立审计工单见 admin 要点
- Redis（`NW_WORLD_REDIS_URL`）：行军 ZSET 仅精确唤醒提示，处理不依赖；缺 Redis 静默降级
- **宗门频道横扩推送（S8-4c）**：worldsvc `gatewayClient.broadcast` publish `{recipients,msg}` 到 Redis channel `nw:gw:push`（`GW_PUSH_REDIS_CHANNEL`），各 gateway 实例订阅后 `routeBroadcast` 只推本机在线收件人；无 Redis 降级逐个 HTTP push。gateway 须配 `NW_GW_REDIS_URL`（与 worldsvc 同一 Redis）。push 分支新增 `sect_msg`/`family_msg`（proto `SectBroadcast`→`SectMsg`）
- **主城迁城（S8-4c，所有玩家通用）**：主动 `service.relocateBase`（花 `RELOCATE_COST=500` coin 迁主城到合法空格，**保留领地**，沿用旧保护罩；`POST /world/relocate`）；被动 `passiveRelocate`（`applySiege` 主城被破 → `deleteMany({ownerId})` **失全部领地** + 随机落新址上保护罩，门主叠加全宗门 -50%）。客户端 `WorldMapScene` 中立格菜单「迁城到此」+ `NetSession.onSectMsg`/`SectScene.applySectMsg` 实时频道
- **国民加成（S8-6.5 / G1）**：`NATION_BONUS_PRODUCTION=0.10` 在 `recomputeYield`（己方占领首府的 Voronoi 区内格产率 ×1.1）、`NATION_BONUS_DEFENSE=0.15` 在 `applySiege`（守军处己方首府区经 `shared.nationDefenseStrength` ×1.15 再喂 `resolveSiege`）。归属判定 v1 = 首府占领者即国民代表（无逐玩家国籍字段）；NPC 扫荡不享
- **S8-3b（待办）**：围攻经 `/gw/judge` 引擎复算替代廉价线性结算（判负翻转 = G3，仍 log mismatch 未启用）

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
