# 服务端（server/）

设计基准：`design/game/`（`META_DESIGN.md` / `SERVER_API.md` / `META_TASKS.md` / `ECONOMY_BALANCE.md`）

## 架构关键约束

- **M12**：metaserver/gateway/gameserver 严禁 import `client/src/game`；`PlayerCommand` 作 `bytes` opaque 转发不解码
- **M16**：gameserver 永不连库，身份来自 ticket
- **乐观锁**：存档/钱包 `findOneAndUpdate({_id, rev})` 守卫；rev 不匹配返回 409
- **三通道**：玩家只触达 `meta`(REST) + `gateway`(WS `/gw?token=`) + `game`(WS `?ticket=`)
- **钱包权威**：`SaveData.wallet.coins` 是只读镜像；商业操作经 commercial → meta 编排 → 回推
- **PvE 服务器权威**：通关/升级走 `/pve/clear`、`/pve/upgrade` API；`SyncPatch` 只同步 `equipped`/`flags`

## 九进程 + 端口

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

**前端地址**（宿主机端口）：

| 地址 | 说明 |
|---|---|
| http://localhost:8088 | 主游戏（nginx 同源 SPA + 反代） |
| http://localhost:9091 | animator 动画编辑器 |
| http://localhost:9092 | level-editor 关卡编辑器 |
| http://localhost:9093 | ops 运维后台（跨源调 admin :18083；种子账号 `admin`/`admin123`） |
| http://localhost:18083 | admin 运维后端（仅 ops 前端访问） |

nginx 同源反代（`client/nginx.conf`）：`/` SPA · `/api/`→metaserver:8080 · `/gw`→gateway WS · `/ws`→gameserver WS · `/world`,`/family`,`/auction`→worldsvc:18084（不剥前缀）· `/analytics`→analyticsvc:18085。worldsvc 内部需 redis + gateway/commercial/meta 内网基址；analyticsvc/worldsvc 不暴露宿主，仅经 nginx。

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
- `auctions.expireAt` **故意非 TTL**——过期需结算退还托管物，用普通索引+扫描器
- Redis（`NW_WORLD_REDIS_URL`）：行军 ZSET 仅精确唤醒提示，处理不依赖；缺 Redis 静默降级
- **宗门频道横扩推送（S8-4c）**：worldsvc `gatewayClient.broadcast` publish `{recipients,msg}` 到 Redis channel `nw:gw:push`（`GW_PUSH_REDIS_CHANNEL`），各 gateway 实例订阅后 `routeBroadcast` 只推本机在线收件人；无 Redis 降级逐个 HTTP push。gateway 须配 `NW_GW_REDIS_URL`（与 worldsvc 同一 Redis）。push 分支新增 `sect_msg`/`family_msg`（proto `SectBroadcast`→`SectMsg`）
- **主城迁城（S8-4c，所有玩家通用）**：主动 `service.relocateBase`（花 `RELOCATE_COST=500` coin 迁主城到合法空格，**保留领地**，沿用旧保护罩；`POST /world/relocate`）；被动 `passiveRelocate`（`applySiege` 主城被破 → `deleteMany({ownerId})` **失全部领地** + 随机落新址上保护罩，门主叠加全宗门 -50%）。客户端 `WorldMapScene` 中立格菜单「迁城到此」+ `NetSession.onSectMsg`/`SectScene.applySectMsg` 实时频道
- **S8-3b（待办）**：围攻经 `/gw/judge` 引擎复算替代廉价线性结算

## social/admin/analytics 要点

- **好友/私聊/邮件（S6）**：meta 存数据，gateway 投递实时 push；发送走 REST，接收走 push
- **运维后台（S7）**：两层鉴权（admin JWT ≠ 玩家 JWT）；补偿一律走邮件（不直接写钱包）；审批人 ≠ 发起人
- **埋点（A9）**：`/analytics/events` fire-and-forget（`writeConcern:{w:0}`）；`analyticsvc/src/scheduler.ts` 每小时 ETL 漏斗
