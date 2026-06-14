# Notebook Wars — 服务端

控制面/数据面分离（S1-M，2026-06-14）：`metaserver`(REST 云存档/经济编排/内部结算) + `gateway`(控制面 WS：房间/匹配门面) + `matchsvc`(私有匹配大脑，独立进程 S1-M5) + `gameserver`(数据面 WS：瘦锁步中继) + `commercial`(钱包/交易，独立进程 S5，玩家不可达)，共享 `@nw/shared`。服务间通信走内部 HTTP（`META_DESIGN §6.7` ADR）。
契约单一来源在 `contracts/`。设计基准：`../design/game/META_DESIGN.md`、`SERVER_API.md`、`META_TASKS.md`、`GATEWAY_DESIGN.md`、`MATCHSVC_DESIGN.md`。

## 结构（npm workspaces）

```
server/
├── contracts/      openapi.yml（REST 契约，design-first M15）
│                   transport.proto（WS 控制面+数据面，含 match_found；服务器认得）
│                   game.proto（PlayerCommand，仅客户端↔客户端，服务器 opaque）
├── shared/   @nw/shared   类型(SaveData) + JWT + ticket(HMAC) + Mongo 工厂 + RoomRegistry + ladder + api + config
├── metaserver/  REST（无状态，ESM）  fastify + openapi-glue + internal.ts（/internal/elo·/match/report，M19）
├── gateway/     控制面 WS（CJS）  /gw?token= 门面 + MatchsvcClient(转命令) + 内部 HTTP(/gw/push 收 matchsvc 事件)
├── matchsvc/    私有匹配大脑（CJS，独立进程 S1-M5）  内部 HTTP(gateway 命令 + game 注册/心跳) + 房间/ELO 配对/签 ticket + GatewayClient(/gw/push)
├── gameserver/  数据面 WS（CJS）  /ws?ticket= 验签 + 节拍器中继/帧日志/重连 + 局末上报 meta（永不连库 M16）
└── commercial/  钱包/交易（CJS，独立进程 S5，玩家不可达）  node:http /internal/*（钱包/扣币/盲盒/充值/广告）+ 专属库 notebook_wars_commercial（wallets/ledger/orders/recharges/gachaHistory）
```

> **本地五进程**：`docker compose up -d`（Mongo）→ `npm run dev:meta` + `npm run dev:gateway` + `npm run dev:matchsvc` + `npm run dev:game` + `npm run dev:commercial`。
> dev 默认端口：meta 18080、gateway 8082（内部 HTTP 8090，收 matchsvc 推送）、matchsvc 内部 HTTP 8091、game 8081、commercial 内部 18082。内部链路：gateway `NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091`、matchsvc `NW_GATEWAY_INTERNAL_URL=http://127.0.0.1:8090`、game `NW_MATCHSVC_INTERNAL_URL=http://127.0.0.1:8091`；meta `NW_COMMERCIAL_INTERNAL_URL=http://127.0.0.1:18082`（缺省 null → 经济端点 503）；matchsvc/game 配 `NW_GAME_PUBLIC_WS_URL` 兜底分配；`NW_INTERNAL_KEY` 五进程一致。commercial 连专属库（`NW_COMM_MONGO_DB=notebook_wars_commercial`，URI 默认复用 `NW_MONGO_URI`）。

## 实现进度

- **已完成**：C-1 仓库结构、C-2 契约 + shared、**C-3 部署脚手架（Docker + pm2，见下「部署」）**、S0-6 Mongo 接入、S0-7 save-service（`/auth/wx`·`/auth/device`·`GET/PUT /save`，乐观锁单文档原子更新）、**S1-1~5 gameserver 锁步联机（friendly 好友房，见下）**。客户端 S0-1~5（SaveData/迁移链/SaveStore/匿名账号/云同步）见 `client/src/game/meta/` + `client/src/net/`。
- **S5 commercial 商业服务（2026-06-14 已落地）**：钱包/充值/消费/盲盒迁独立进程 `commercial` + 专属库；meta 编排 `/shop/buy`·`/gacha/draw`·`/ads/reward`·`/iap/verify`（调 commercial 扣币/随机 → 发 inventory → 钱包镜像回推 → `GET /save` 对账补发）；钱包权威迁出 meta saves（`SaveData.wallet/gacha` 降只读镜像，加 `deliveredOrders`）。dev 充值桩；重复退币暂缓。commercial 20 + meta 37 测试绿（含 internalHttp 鉴权/路由 + HttpCommercialClient fetch 解析）。详见 `../CLAUDE.md`「commercial 商业服务」节。
- **占位（契约就绪，handler 返回 501）**：无（economy 端点已由 S5 实现；commercial 未配 `NW_COMMERCIAL_INTERNAL_URL` 时返回 503）。
- **gameserver S1-1~5（friendly 好友房）已完成**：WS+JWT 握手+心跳；建房（6 位房间码）/ 输码加入 / ready / 房主开局；服务器权威节拍器（模拟 30Hz、网络 10Hz 每 100ms 批次 3 帧，`cmd_submit` 落当前窗口帧、同帧多指令按 `side` 确定性排序）；非空帧日志 + `conn_resume`→`conn_resync` 重连补帧 + 60s 宽限判负；局末 `match_result` hash 比对 + `matches` 归档。`transport.proto` 运行期 protobufjs 编解码（`commands` opaque 透传）。详见 `src/{Connection,Room,RoomManager,proto/transport}.ts`。
- **待办**：S1-R（ranked 队列 + ELO）、S1-J（服务器裁判复算）、S1-RP（录像）；proto/openapi 客户端 codegen（`ts-proto` / `openapi-typescript`，C-2 客户端侧 + S1-6~9）。
- **S1-M1~M4（控制面/数据面拆分，2026-06-14 已落地）**：新增 `gateway` 包（控制面 WS + matchsvc，签 ticket + 取 ELO + game 注册）；gameserver 瘦成 `?ticket=` 验签的纯帧中继（删匹配/ELO/Mongo，局末 `POST meta /internal/match/report`）；meta 加内部路由 `internal.ts`（ELO 结算 + 归档，自 gameserver 迁来）；客户端 `NetSession` 拆 gateway/game 双连接、`transport.proto` 加 `match_found`。
- **S1-M5（matchsvc 拆独立进程，2026-06-14 已落地）**：matchsvc 从 gateway 内迁出为独立 workspace `server/matchsvc`；gateway↔matchsvc / game→matchsvc 全改内部 HTTP（`META_DESIGN §6.7` 选型 ADR：内部走 REST，不上 gRPC，MQ 暂缓）。gateway = 薄门面（`MatchsvcClient` 转命令 + `/gw/push` 收事件），matchsvc 自持内部 HTTP（gateway 命令 + game 注册/心跳）+ `GatewayClient` 回推。gameserver 注册改指 `NW_MATCHSVC_INTERNAL_URL`。验证：`tsc -b shared metaserver gateway matchsvc gameserver` 全绿 + matchsvc 17/gateway 2/gameserver 42 测试 + web 构建。详见 `../CLAUDE.md`「gateway 控制面 + matchsvc」节。**双真机联调待办**。

## 部署（C-3，全栈一条命令）

```bash
cp .env.example .env        # 填 NW_JWT_SECRET（强随机，如 openssl rand -hex 32）/ NW_DOMAIN
./deploy/up.sh              # docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

起 `mongo`（单节点副本集，命名卷持久化，首启自动 `rs.initiate`，成员 host=容器名）+ `metaserver` + `gameserver` + `caddy` 反代。

- **出口**：`https://{NW_DOMAIN}/api/...`（REST）、`wss://{NW_DOMAIN}/ws?token=<jwt>`（锁步）、`/api/health`（存活探针）。
- **NW_DOMAIN**：填真域名 → Caddy 自动签 Let's Encrypt（HTTPS/WSS）；留 `:80` → HTTP/WS（本机联调）。
- **路由（Caddyfile）**：`handle_path /api/*` 剥前缀转 metaserver:8080（fastify 路由不含 /api 前缀）；`handle /ws*` 保路径转 gameserver:8081（WS server 绑 path=/ws）。
- **单镜像两进程**：`Dockerfile` 多阶段 build 全 workspace，两服务共用镜像、compose 用 `command` 区分（`node metaserver/dist/index.js` | `gameserver/dist/index.js`）；运行镜像保留 `contracts/`（metaserver 运行期读 `openapi.yml`）。
- **非 Docker 路线（pm2）**：`npm ci && npx tsc -b shared metaserver gameserver`，然后 `NW_JWT_SECRET=... pm2 start ecosystem.config.cjs`（nw-meta 可 cluster 横扩 / nw-game 单实例房间亲和）；caddy/mongod 自行装。上游需把 Caddyfile 的 `metaserver:8080`/`gameserver:8081` 改成 `127.0.0.1:8080/8081`。

## 本地开发

**前置：MongoDB（用 Docker，无需本地安装）**。文档要求**单节点副本集**（非单机 mongod），以解锁跨集合事务 + change streams（META_DESIGN §6.3）；`docker-compose.yml` 已配好「副本集 + 首启自动 `rs.initiate()`」。

```bash
cd server

# 1) 起依赖（MongoDB 单节点副本集）
docker compose up -d
docker compose ps          # 等 mongo 变 healthy（首启自动 rs.initiate）

# 2) 装依赖 + 构建
npm install
npx tsc -b shared metaserver gameserver   # 类型检查 + 构建

# 3) 跑服务
npm run dev:meta    # metaserver（tsx watch）
npm run dev:game    # gameserver 骨架

# 端到端测试（需 mongo 在跑；tsc -b + vitest 6 用例）
npm test --workspace @nw/metaserver

# 关依赖：docker compose down（保留数据）/ down -v（清空数据）
```

> **一键起全套（Windows）**：`npm run dev:all`（`dev-up.ps1`）起 shared watch + meta/gateway/matchsvc/game/commercial 五进程，各自独立窗口 + `node --watch` 热重载，预设内部 URL 与 `NW_INTERNAL_KEY`。`-SkipMongo` 跳过 docker、`-Only meta,commercial` 只起部分。**每个窗口标题为 `nw:<服务名>`**（`nw:meta`/`nw:gateway`/…）：脚本直接 `node --watch …` 启动而非嵌套 `npm run`，避免 npm 在设标题后又把控制台标题改回命令名，故标题稳定可辨。

> **Docker 引擎**：mongo:7 是 Linux 镜像，需 Docker Desktop 处于 **Linux containers** 模式（`docker version` 显示 `Server: linux/amd64`）。Windows 容器模式会报 `hcs::System::CreateProcess` / 命名卷 `invalid volume specification`。切换：`docker context use desktop-linux`，或 Docker Desktop 托盘「Switch to Linux containers」。

环境变量（均有 dev 默认值，生产必须覆盖 `NW_JWT_SECRET`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NW_JWT_SECRET` | `dev-insecure-...` | JWT 签名密钥（生产必改） |
| `NW_MONGO_URI` | `mongodb://127.0.0.1:27017/?replicaSet=rs0` | 与 compose 一致 |
| `NW_MONGO_DB` | `notebook_wars` | 数据库名 |
| `NW_META_PORT` / `NW_GAME_PORT` | 8080 / 8081 | 监听端口 |
| `NW_WX_APPID` / `NW_WX_SECRET` | — | 微信 `jscode2session`；缺省走 dev openid 回退 |

反代（caddy/nginx）：`/api/*` → metaserver、`/ws` → gameserver，自动 HTTPS（C-3）。

## 设计要点

- **信任边界**：钱包/库存/盲盒/天梯服务器权威；客户端永不直接写。`PUT /save` 只接受同步段（progress/materials/pveUpgrades/equipped/flags），权威段以服务端为准回推。
- **乐观锁**：`PUT /save` 带 `If-Match: <rev>`，`findOneAndUpdate({_id, rev})` 守卫，并发只有一个赢，另一个 409 + 当前云端值。
- **服务器与游戏逻辑零依赖**：服务端不 import `client/src/game`；`PlayerCommand` 作 `bytes` opaque 转发。
