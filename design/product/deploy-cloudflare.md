# 部署方案：Cloudflare 前端 + VPS 后端 + 托管 Mongo

> 权威来源：本文件为「线上部署拓扑」的单一来源。配置实体见 `server/docker-compose.cloud.yml` + `server/Caddyfile` + `server/.env.example`。

## 1. 总拓扑

```
前端（纯静态）           Cloudflare Pages（免费、全球 CDN、带宽不计费）
后端（8 进程 + WS）      一台 VPS：Node ×8 + Redis + Caddy（docker compose）
数据库                  MongoDB Atlas M0（免费，3 节点副本集，托管在云上）
```

VPS 上**不再跑 mongo 容器**——库托管到 Atlas。本机只剩 Node 进程、Redis、Caddy 反代。

## 2. 域名 / 子域规划（gamestao.com，托管在 Cloudflare DNS）

| 子域 | 指向 | 用途 | CF 代理（云朵） |
|---|---|---|---|
| `gamestao.com` | Cloudflare Pages | 主游戏 client（web 包） | 橙（自动） |
| `animator.gamestao.com` | Cloudflare Pages | 动画编辑器（**已上线**） | 橙 |
| `editor.gamestao.com` | Cloudflare Pages | 关卡编辑器（暂缓） | 橙 |
| `ops.gamestao.com` | Cloudflare Pages | 运维后台前端（建议加 CF Access 登录保护） | 橙 |
| `api.gamestao.com` | VPS:443 | REST（metaserver，经 Caddy `/api`） | 橙 |
| `gw.gamestao.com` | VPS:443 | 控制面 WS `/gw` | 橙 或 灰（见 §5） |
| `game.gamestao.com` | VPS:443 | 数据面 WS `/ws`（锁步） | 橙 或 灰（见 §5） |

> **子域数量无需担心**：CF Free 单 zone DNS 记录上限 1000 条；单 Pages 项目可绑 100 个自定义域。
> **免费 SSL 只覆盖一级通配** `*.gamestao.com`——保持单层子域命名（`animator.gamestao.com` ✅，别用 `a.b.gamestao.com`），否则要付费 ACM。

> 注：上表把 REST/WS 拆成 `api`/`gw`/`game` 三个子域是「干净版」。当前 `Caddyfile` 是**单站点按路径分流**（`/api` `/gw` `/ws` `/world` `/analytics` 同一域名）。起步阶段最省事的做法：所有后端流量走**一个**子域 `api.gamestao.com`，路径分流交给 Caddy，前端只需把 API base 配成 `https://api.gamestao.com`、WS 配成 `wss://api.gamestao.com/gw` 和 `/ws`。等需要按区隔离再拆子域。

## 3. 后端部署（VPS）

前置：VPS 装好 Docker + docker compose，DNS 把 `api.gamestao.com`（A 记录）指向 VPS 公网 IP。

```bash
# 1. 拉代码到 VPS
cd server
cp .env.example .env

# 2. 编辑 .env，至少填这几项：
#    NW_JWT_SECRET        = openssl rand -hex 32
#    NW_INTERNAL_KEY      = openssl rand -hex 32
#    NW_ADMIN_JWT_SECRET  = openssl rand -hex 32
#    NW_MONGO_URI         = Atlas 连接串（见 §4，务必带 &maxPoolSize=10）
#    NW_DOMAIN            = api.gamestao.com   ← Caddy 自动签 Let's Encrypt
#    NW_GAME_PUBLIC_WS_URL= wss://api.gamestao.com/ws

# 3. 起全栈（外接 Mongo 版）
docker compose -f docker-compose.cloud.yml --env-file .env up -d --build
```

启动后：`https://api.gamestao.com/api/...`（REST）、`wss://api.gamestao.com/gw`（控制面）、`wss://api.gamestao.com/ws`（数据面）、`/world|/family|/auction`（SLG）。
`admin`/`analyticsvc` 不经 Caddy 暴露（玩家不可达，仅集群内/VPN 访问）。

## 4. MongoDB Atlas M0（免费）配置

1. atlas.mongodb.com 注册 → 建 **M0 Free** 集群，区域选离 VPS 近的（VPS 在欧洲就选 Frankfurt / Ireland）。
2. **Database Access**：建一个数据库用户（用户名/强密码）。
3. **Network Access**：加 VPS 公网 IP 到 IP allowlist（别图省事用 `0.0.0.0/0`）。
4. **Connect → Drivers** 取连接串，形如：
   ```
   mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. **末尾加 `&maxPoolSize=10`** 填进 `NW_MONGO_URI`（关键，见下）。

**为什么必须限连接池**：代码强制副本集（`?replicaSet=rs0`），M0 本身是 3 节点副本集天然满足，SRV 串会自动发现成员、无需手写 `replicaSet=`。但 M0 **并发连接上限 500**；驱动每进程默认 `maxPoolSize=100`，而连库进程有 5 个（meta / commercial / worldsvc / admin / analyticsvc），5×100=500 正好顶满，高峰会报连接耗尽。`&maxPoolSize=10` → 5×10=50，安全。

**库划分**：5 个进程连同一集群、不同库名（`notebook_wars` / `_commercial` / `_world` / `_admin` / `_analytics`），全部计入 M0 的 512MB。起步够用；某库涨大了，把 `docker-compose.cloud.yml` 里对应进程的 `NW_*_MONGO_URI` 单独指到新集群即可平滑迁移。

## 5. WebSocket 走橙云还是灰云

- **橙云（CF 代理）**：享 DDoS 防护 + 隐藏源站 IP + 统一证书；CF 支持 WS。代价是多一跳、长连接受 CF 100 秒空闲超时影响（有应用层心跳就没事）。
- **灰云（DNS only，直连 VPS）**：少一跳、延迟最低，适合锁步数据面 `/ws`；代价是暴露源站 IP、TLS 由 Caddy 自己签。
- **建议**：起步全橙云（省心、安全），先观察锁步延迟；嫌高再把 `game.*` 这一个 WS 子域改灰云直连。

## 6. 前端部署（Cloudflare Pages）

每个工具/客户端一个 Pages 项目，构建产物目录见各自 webpack 配置（`dist/`）。

| 项目 | 构建命令 | 产物 | 状态 |
|---|---|---|---|
| client（主游戏 web 包） | `npm run build:web`（按实际脚本） | `client/dist` | 待做 |
| animator | — | — | ✅ 已上线 |
| level-editor | — | — | 暂缓（不急） |
| ops | — | — | 待做 |

前端构建时需把 API/WS base 指到 `api.gamestao.com`（client 入口里地址烘焙，参考 animator 的部署方式）。

## 7. 备注

- 特效（client 特效）与关卡编辑器前端**暂缓**，优先级低。
- 全球多区域演进见 `DEPLOY_TOPOLOGY.md`（ADR-019）：Meta 共享 + 对战层按区隔离。本文件是单区起步版，选 VPS 商时心里装着「以后每区复制一套 matchsvc/gameserver」。
- 备份：Atlas M0 自带快照；如需导出见 `server/deploy/backup-mongo.sh`（连接串改成 Atlas 即可）。
