# Notebook Wars — 服务端

`metaserver`（REST 云存档/经济）+ `gameserver`（WS 锁步联机）两进程，共享 `@nw/shared`。
契约单一来源在 `contracts/`。设计基准：`../design/game/META_DESIGN.md`、`SERVER_API.md`、`META_TASKS.md`。

## 结构（npm workspaces）

```
server/
├── contracts/      openapi.yml（REST 契约，design-first M15）
│                   transport.proto（WS 房间/锁步，服务器认得）
│                   game.proto（PlayerCommand，仅客户端↔客户端，服务器 opaque）
├── shared/   @nw/shared   类型(SaveData) + JWT + Mongo 工厂 + RoomRegistry + api 包络
├── metaserver/  REST（无状态）  fastify + fastify-openapi-glue 按 openapi.yml 装配
└── gameserver/  WS（有状态）  ws + JWT 握手 + 心跳 + 房间/锁步节拍器中继/重连（S1-1~5）
```

## 实现进度

- **已完成**：C-1 仓库结构、C-2 契约 + shared、**C-3 部署脚手架（Docker + pm2，见下「部署」）**、S0-6 Mongo 接入、S0-7 save-service（`/auth/wx`·`/auth/device`·`GET/PUT /save`，乐观锁单文档原子更新）、**S1-1~5 gameserver 锁步联机（friendly 好友房，见下）**。客户端 S0-1~5（SaveData/迁移链/SaveStore/匿名账号/云同步）见 `code/src/game/meta/` + `code/src/net/`。
- **占位（契约就绪，handler 返回 501）**：`/shop/*`·`/gacha/*`·`/ads/reward`·`/iap/verify`（S2/S4）。
- **gameserver S1-1~5（friendly 好友房）已完成**：WS+JWT 握手+心跳；建房（6 位房间码）/ 输码加入 / ready / 房主开局；服务器权威节拍器（模拟 30Hz、网络 10Hz 每 100ms 批次 3 帧，`cmd_submit` 落当前窗口帧、同帧多指令按 `side` 确定性排序）；非空帧日志 + `conn_resume`→`conn_resync` 重连补帧 + 60s 宽限判负；局末 `match_result` hash 比对 + `matches` 归档。`transport.proto` 运行期 protobufjs 编解码（`commands` opaque 透传）。详见 `src/{Connection,Room,RoomManager,proto/transport}.ts`。
- **待办**：S1-R（ranked 队列 + ELO）、S1-J（服务器裁判复算）、S1-RP（录像）；proto/openapi 客户端 codegen（`ts-proto` / `openapi-typescript`，C-2 客户端侧 + S1-6~9）。

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
- **服务器与游戏逻辑零依赖**：服务端不 import `code/src/game`；`PlayerCommand` 作 `bytes` opaque 转发。
