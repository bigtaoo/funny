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
└── gameserver/  WS（有状态，骨架）  ws + JWT 握手；room/节拍器属 S1
```

## 实现进度

- **已完成**：C-1 仓库结构、C-2 契约 + shared、S0-6 Mongo 接入、S0-7 save-service（`/auth/wx`·`/auth/device`·`GET/PUT /save`，乐观锁单文档原子更新）。
- **占位（契约就绪，handler 返回 501）**：`/shop/*`·`/gacha/*`·`/ads/reward`·`/iap/verify`（S2/S4）。
- **骨架**：gameserver WS 握手鉴权 + RoomRegistry 口子；room-service / 节拍器中继 / 重连属 S1。
- **待办**：proto/openapi 客户端 codegen（`ts-proto` / `openapi-typescript`，C-2 客户端侧）；C-3 部署脚手架。

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
