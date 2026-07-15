# 部署方案：Cloudflare 前端 + VPS 后端 + 托管 Mongo

> 权威来源：本文件为「线上部署拓扑」的单一来源。配置实体见 `server/docker-compose.cloud.yml` + `server/Caddyfile` + `server/.env.example`。

## 1. 总拓扑

```
前端（纯静态）           Cloudflare Workers 静态资源（免费、全球 CDN、带宽不计费）
后端（8 进程 + WS）      一台 VPS：Node ×8 + Redis + Caddy（docker compose）
数据库                  MongoDB Atlas M0（免费，3 节点副本集，托管在云上）
```

VPS 上**不再跑 mongo 容器**——库托管到 Atlas。本机只剩 Node 进程、Redis、Caddy 反代。

> ⚠ **VPS 上永远只用 `docker-compose.cloud.yml`**：`docker-compose.prod.yml` 是自带本地 mongo 副本集的变体（本地/集成测试用），如果在 VPS 上手动跑过它，会起一个 `nw-mongo` 容器长期占着 CPU/内存却完全没被任何服务连接（所有服务的 `NW_*_MONGO_URI` 只认 `.env` 里的 Atlas 串）——2026-07-15 就在生产上发现过这个漂移，排查见 `botsvc-loadtest` 相关记录。`server-deploy.yml` 已加 `--remove-orphans`，正常走 CI 自动部署不会再有孤儿容器；但如果手动在 VPS 上 `docker compose up`，务必显式带 `-f docker-compose.cloud.yml`。

## 2. 域名 / 子域规划（gamestao.com，托管在 Cloudflare DNS）

| 子域 | 指向 | 用途 | CF 代理（云朵） |
|---|---|---|---|
| `nivara.gamestao.com` | Cloudflare Workers（静态资源） | 主游戏 client（web 包，品牌域名，2026-07-03 加） | 橙（自动） |
| `a.gamestao.com` | Cloudflare Workers（静态资源） | 主游戏 client（web 包，旧入口，与上同一 Worker `nivara-client`） | 橙（自动） |
| `animator.gamestao.com` | Cloudflare Workers（静态资源） | 动画编辑器（**已上线**） | 橙 |
| `vfx.gamestao.com` | Cloudflare Workers（静态资源） | 战斗特效编辑器（**发布配置已就绪**，Worker `nivara-vfx`，见 §6） | 橙 |
| `level.gamestao.com` | Cloudflare Workers（静态资源） | 关卡编辑器（**发布配置已就绪**，Worker `nivara-level-editor`，见 §6） | 橙 |
| `slg.gamestao.com` | Cloudflare Workers（静态资源） | SLG 地图编辑器（**发布配置已就绪**，Worker `nivara-map-editor`，见 §6） | 橙 |
| `ops.gamestao.com` | Cloudflare Workers（静态资源） | 运维后台前端（建议加 CF Access 登录保护） | 橙 |
| `grafana.gamestao.com` | VPS（经 cloudflared 隧道） | 日志查询（Loki+Grafana，CF Access 保护） | 橙（隧道自动） |
| `api.gamestao.com` | VPS:443 | REST（metaserver，经 Caddy `/api`） | 橙 |
| `gw.gamestao.com` | VPS:443 | 控制面 WS `/gw` | 橙 或 灰（见 §5） |
| `game.gamestao.com` | VPS:443 | 数据面 WS `/ws`（锁步） | 橙 或 灰（见 §5） |

> **子域数量无需担心**：CF Free 单 zone DNS 记录上限 1000 条；每个前端各一个 Worker，用 `routes[].custom_domain=true` 各自绑定子域（`wrangler deploy` 自动建 DNS + 边缘证书）。
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

启动后：`https://api.gamestao.com/api/...`（REST）、`wss://api.gamestao.com/gw`（控制面）、`wss://api.gamestao.com/ws`（数据面）、`/world|/auction|/sect|/nation`（SLG：地图/拍卖 + 门派/世界频道聊天，均 worldsvc）、`/social`（社交第五公网面，含家族 /social/family/*）。
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

## 6. 前端部署（Cloudflare Workers 静态资源）

每个工具/客户端一个 Worker（静态资源），各一份 `wrangler/*.jsonc`，构建产物目录见各自 webpack 配置（`dist/`）。

| 项目 | 构建命令 | 产物 | 状态 |
|---|---|---|---|
| client（主游戏 web 包） | `npm run build:web` | `client/dist` | ✅ **已上线** `https://a.gamestao.com`（Worker `nivara-client`，2026-06-24 验证：HTTP 200 + 证书有效 + 可登录开局） |
| animator | — | — | ✅ 已上线 |
| vfx-editor | `npm run build` | `tools/vfx-editor/dist` | 🟡 **发布配置已就绪**（Worker `nivara-vfx`，`wrangler/vfx.jsonc` + `.github/workflows/vfx-deploy.yml`，开关 `VFX_DEPLOY_ENABLED=true`）；纯静态无后端。`custom_domain=true` 首次 deploy 自动建 `vfx.gamestao.com` |
| level-editor | `npm run build` | `tools/level-editor/dist` | 🟡 **发布配置已就绪**（Worker `nivara-level-editor`，`wrangler/level-editor.jsonc` + `.github/workflows/level-editor-deploy.yml`，开关 `LEVEL_EDITOR_DEPLOY_ENABLED=true`）；纯静态无后端。`custom_domain=true` 首次 deploy 自动建 `level.gamestao.com` |
| map-editor | `npm run build` | `tools/map-editor/dist` | 🟡 **发布配置已就绪**（Worker `nivara-map-editor`，`wrangler/map-editor.jsonc` + `.github/workflows/map-editor-deploy.yml`，开关 `MAP_EDITOR_DEPLOY_ENABLED=true`）；纯静态无后端。`custom_domain=true` 首次 deploy 自动建 `slg.gamestao.com` |
| ops | `npm run build` | `tools/ops/dist` | ✅ **已上线** `https://ops.gamestao.com`（Worker `nivara-ops`，2026-06-24 验证：HTTP 200 + 标题正确 + 证书有效；首部署后本机系统 DNS 短暂未刷新，CF 1.1.1.1 已解析） |

前端构建时需把 API/WS base 指到 `api.gamestao.com`（client 入口里地址烘焙，参考 animator 的部署方式）。

### client 部署（Cloudflare Workers static assets，对外 `nivara.gamestao.com` + `a.gamestao.com`）

与 animator 同模式，但**各一份 wrangler 配置、各一个 Worker**，互不影响：

- animator → `wrangler/animator.jsonc`（Worker `animator`）
- client → `wrangler/client.jsonc`（Worker `nivara-client`，`routes.custom_domain=true` 自动建 DNS+边缘证书，橙云）

**首次上线记录（2026-06-24，✅ 已验证）**：CF 账号 `tao.wang.go@gmail.com`（Account ID `e64b61f1...`）；`wrangler login`（OAuth，凭证存本机）→ `wrangler deploy -c wrangler/client.jsonc` 一次成功，上传 14 个静态资源，`custom_domain` 自动建好 `a.gamestao.com`；外网 `https://a.gamestao.com` HTTP 200、证书有效、可登录开局并连到 `api.gamestao.com`。以后更新只需「重构建 → deploy」两条命令，无需再登录。

**加品牌域名（2026-07-03）**：`wrangler/client.jsonc` 的 `routes` 追加 `{ "pattern": "nivara.gamestao.com", "custom_domain": true }` → 重 deploy，同一 Worker 同时挂 `a.gamestao.com`（保留旧入口）+ `nivara.gamestao.com`（对外统一用这个）；两域名内容完全一致（同一份 `client/dist`）。触发原因：Paddle 商户域名审核期间希望用更规范的品牌域名对外，`a.gamestao.com` 那轮审核先用旧域名过，等确认无误再逐步把外部链接（ToS/Privacy/定价页等）切到 `nivara.gamestao.com`。

```bash
# 1. 构建（地址烘焙到 api.gamestao.com；NW_BUILD_VERSION 烘焙进 version.json + __NW_BUILD_VERSION__，
#    手动部署时必须显式带上，否则回落 '0.0.0'，线上无法区分到底部署的是哪个 commit）
cd client && NW_API_BASE=https://api.gamestao.com/api \
  NW_GATEWAY_WS=wss://api.gamestao.com/gw \
  NW_WORLD_BASE=https://api.gamestao.com \
  NW_SOCIAL_BASE=https://api.gamestao.com \
  NW_BUILD_VERSION=$(git rev-parse --short HEAD) npm run build:web
# 2. 部署（从仓库根，-c 指定 client 的配置）
cd .. && npx wrangler deploy -c wrangler/client.jsonc
```

> **首次需登录 CF**：`npx wrangler login`（浏览器 OAuth，写本机凭证）后再 deploy；或设 `CLOUDFLARE_API_TOKEN` 环境变量走非交互。
> **版本追踪（2026-07-15 补）**：`client-deploy.yml` 的 CI 流水线此前只烘焙了 API/WS 地址，漏了 `NW_BUILD_VERSION`——线上 `version.json` 一直是兜底值 `0.0.0`，没法确认到底部署的是哪次 commit，`web.ts` 的"版本变化自动刷新"逻辑（判断 `!== '0.0.0'`）也因此在 web 端一直是 no-op。已在 CI 里补上（`git rev-parse --short HEAD` 作为版本号）；手动部署也要照上面命令带上 `NW_BUILD_VERSION`，否则又会退回 `0.0.0`。核对是否生效：访问 `https://a.gamestao.com/version.json`，应该看到 7 位 commit SHA 而不是 `0.0.0`。
> `a.gamestao.com` 是**单层子域**，被免费 `*.gamestao.com` 通配证书覆盖（别用多层 `a.b.gamestao.com`）。
> 数据面 WS（`/ws`）走 `match_found.game_url` 下发，缺省由 API base 自动推导 `/api`→`/ws`，前端无需单独配。

**client web 包的地址烘焙（确切变量）**：`client/webpack.config.js` 用 DefinePlugin 注入，读三个构建期环境变量（生产默认空串 = 同源相对路径）：

| 环境变量 | 用途 | 形如 | 运行时 localStorage 覆盖键 |
|---|---|---|---|
| `NW_API_BASE` | REST 基址 | `https://api.gamestao.com/api`（无尾斜杠） | `nw_api_base` |
| `NW_GATEWAY_WS` | 控制面 WS | `wss://api.gamestao.com/gw` | `nw_gateway_ws` |
| `NW_WORLD_BASE` | SLG 世界 REST 基址 | `https://api.gamestao.com` | —（无覆盖） |
| `NW_SOCIAL_BASE` | 社交 REST 基址（家族/宗门/世界频道，`WorldApiClient` 直连） | `https://api.gamestao.com` | —（无覆盖） |

> ⚠ **`NW_SOCIAL_BASE` 生产必填**：留空时 `getSocialBaseUrl()` 会从 `NW_WORLD_BASE` 派生并强改端口 `:8085`（dev 直连端口，公网未开放），导致家族/宗门/世界社交请求全部 `网络连接失败`。friends/mail 走 `NW_API_BASE`→metaserver 代理，不受影响。

- **数据面 WS（`/ws`）不烘焙**：由 metaserver 鉴权回包的 `match_found.game_url` 下发；缺省时 `client/src/net/config.ts` 从 API base 自动推导（`/api`→`/ws`）。`NW_GAME_PUBLIC_WS_URL`（后端 .env）就是这个下发地址的来源。
- 构建命令：`cd client && NW_API_BASE=... NW_GATEWAY_WS=... NW_WORLD_BASE=... npm run build:web` → 产物 `client/dist`。
- **localStorage 覆盖（内测神器）**：用一份默认构建即可，朋友在浏览器 DevTools console 跑 `localStorage.setItem('nw_api_base','http://<VPS_IP>/api'); localStorage.setItem('nw_gateway_ws','ws://<VPS_IP>/gw'); location.reload()` 就能连你的后端，无需为每个环境重新构建。

#### 缓存策略（防 iPad / Safari 服务旧版本）

生产构建会输出三类文件，各有不同缓存策略：

| 文件 | 命名规则 | Cache-Control | 原理 |
|---|---|---|---|
| `<hash>.js` | contenthash | `public, max-age=31536000, immutable` | 内容变 → 文件名变 → 新 URL，永久缓存安全 |
| `index.html` | 固定名 | `no-cache, must-revalidate` | 每次加载都验证，拿到最新 JS 文件名 |
| `version.json` | 固定名 | `no-cache, must-revalidate` | 客户端轮询用，必须实时 |

**实现**：`webpack.config.js` 生产构建时自动输出 `_headers` 文件（CF Workers static assets 支持此格式），并将 JS 输出改为 `[contenthash].js`；`client/nginx.conf` 同步配置（Docker 环境用）。

**客户端主动刷新**：`client/src/entries/web.ts` 在 `visibilitychange`（玩家切回前台）时拉 `/version.json`，与运行中的 `__NW_BUILD_VERSION__` 对比，版本不同则 `location.reload()`。确保已开着页面的玩家（尤其 iPad 后台切回）能立即获取新版本，无需手动刷新。

#### 自动发布（GitHub Action，免手敲命令）

`.github/workflows/client-deploy.yml`：push 到 `main` 且改动落在 `client/**` / `wrangler/client.jsonc` / 该 workflow 时自动 `npm ci → build:web（地址烘焙到 api.gamestao.com）→ wrangler deploy`；也可在 Actions 页手动 Run（`workflow_dispatch`）。与 ops-deploy 同套路：

1. **复用 ops 那套 secrets**：`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 已配（同一 CF 账号 `e64b61f1...`，"Edit Cloudflare Workers" token 是账号级 Workers 写权限，覆盖 `nivara-client`，**无需新建 token**）。
2. **开关**：设 repo variable `CLIENT_DEPLOY_ENABLED = true`（未设则 job 跳过）。
3. 地址烘焙的三个构建期环境变量写死在 workflow 里（与手动命令同值），改地址改 workflow 即可。

> 手动两条命令的老路仍可用（上面命令块），适合本机临时发布或 CI 不可用时兜底。

### ops 部署（Cloudflare Worker + static assets，对外 `ops.gamestao.com`）

**架构（同源反代 + CF Access）**：ops 不是纯静态，而是「静态资源 + Worker 反代」。整个 `ops.gamestao.com` 由**一个 CF Access 应用**保护（网络级登录墙），ops 自己的 admin 账号密码是**第二层**。

```
浏览器 ──①CF Access登录墙──▶ ops.gamestao.com (Worker nivara-ops)
                                  ├─ 其余路径 → 静态资源(ASSETS, SPA)
                                  └─ /admin/*  → ②反代 + 注入 X-Ops-Proxy-Secret
                                                   │
                          api.gamestao.com/ops/* ◀─┘ (Caddy 校验密钥头, 无→403)
                                  └─ strip /ops → ③ admin:8083 (容器内, 玩家不可达)
```

三道闸：① CF Access 身份门（边缘）→ ② Worker↔Caddy 共享密钥头（玩家直连 `/ops/*` 无密钥 → 403）→ ③ admin 自身账号密码。**要害是 admin 后端被保护，而非静态页**（页面只是公开 JS，无秘密）。

- 前端 API 基址：`tools/ops/src/api.ts` 默认 = 本地 `localhost:18083` / 线上**同源空串**（→ 相对 `/admin/*`，由 Worker 反代）。运行时仍可在登录页输入框覆盖（localStorage `nw_admin_api`）。
- 配置实体：`wrangler/ops.jsonc`（Worker `nivara-ops` + `run_worker_first:["/admin/*"]` + var `ADMIN_ORIGIN`）、`wrangler/worker.ops.js`（反代逻辑）、`server/Caddyfile` 的 `/ops/*` 路由、`docker-compose.cloud.yml` caddy 的 `NW_OPS_PROXY_SECRET`。

**完整闭环已上线（2026-06-24 ✅ 已验证）**：Worker `nivara-ops` + `custom_domain` 建好 `ops.gamestao.com`（HTTP 200、证书有效）；CF Access 应用 `ops`（team `gamestao.cloudflareaccess.com`，policy Allow + Emails 白名单，登录方式 One-time PIN 默认即用）罩整站；`/admin/*` 经 Worker 注入密钥头反代到 `api.gamestao.com/ops/*`（Caddy 校验：无密钥→403），strip `/ops` 转 `admin:8083`。VPS 端验证：无密钥直连 `/ops/admin/me`→403、带密钥 `admin` 登录→200+完整超管权限；admin 容器日志确认已种子超管 `username=admin`。共享密钥两端：VPS `server/.env` 的 `NW_OPS_PROXY_SECRET` ＝ ops Worker 的 `ADMIN_PROXY_SECRET`（wrangler secret）。

> 仅重建了 `caddy`+`admin` 两个容器（`up -d --no-deps --force-recreate caddy admin`，用现有镜像、未 rebuild）；其余服务镜像未动。`.env` 旧备份在 VPS `server/.env.bak.ops`。种子超管密码属一次性凭证，建议登录后在「账号管理」改密/新建常用超管并停用种子号。

#### 部署命令（ops 前端 / Worker）

```bash
git rev-parse --short HEAD                          # 记下目标提交号，发布后比对
cd tools/ops && npm run build                      # 产物 tools/ops/dist（构建期烘入 git hash）
cd ../.. && npx wrangler deploy -c wrangler/ops.jsonc
# 共享密钥（与 VPS 端 NW_OPS_PROXY_SECRET 同值；首次 + 轮换时执行；交互粘贴，不进 git）：
npx wrangler secret put ADMIN_PROXY_SECRET -c wrangler/ops.jsonc
```

> **构建版本号（确认线上是否旧 bundle）**：ops header 右侧显示 `v <git short hash>`（hover 出构建时间 UTC），由 webpack `DefinePlugin` 构建期注入 `git rev-parse --short HEAD`。发布后**硬刷新**（Ctrl+Shift+R，避开缓存的 `index.html`）并比对该号与上面记下的目标提交：一致＝发对了，仍是旧号＝旧 bundle 没覆盖需重发。号带 `-dirty` 后缀＝构建时工作区有未提交改动（非干净提交，不建议作为正式发布）。

> admin 后端入口若不在 `api.gamestao.com/ops`（如改用 cloudflared tunnel 或独立子域），改 `wrangler/ops.jsonc` 的 `ADMIN_ORIGIN` 后重 deploy。

#### 自动发布（GitHub Action，免手敲命令）

`.github/workflows/ops-deploy.yml`：push 到 `main` 且改动落在 `tools/ops/**` / `wrangler/ops.jsonc` / `wrangler/worker.ops.js` 时自动 `npm ci → build → wrangler deploy`；也可在 GitHub **Actions 页手动 Run**（`workflow_dispatch`）。一次性配置：

1. **CF API Token**：Cloudflare「My Profile → API Tokens」用 *Edit Cloudflare Workers* 模板建一个 → 存为 repo secret `CLOUDFLARE_API_TOKEN`；账号 ID 存 `CLOUDFLARE_ACCOUNT_ID`（CF 控制台右栏，即 `e64b61f1...`）。
2. **开关**：设 repo variable `OPS_DEPLOY_ENABLED = true`（未设则 job 跳过，避免配好前每次 push 报红，与 `anim-sync` 同套路）。
3. wrangler secret（`ADMIN_PROXY_SECRET`）在 Worker 上持久保存，自动 deploy **不会清除**，无需在 CI 重设。

> 手动两条命令的老路仍可用（上面命令块），适合本机临时发布或 CI 不可用时兜底。

> **排错：CI 报 `Authentication error [code: 10000]` 但本地能部署**（2026-06-24 踩过）。
> 这不是 token 权限不足，而是 **`CLOUDFLARE_ACCOUNT_ID` secret 指向了 token 够不着的账号**。
> 本地不传 account id 时 wrangler 自动选中 token 唯一关联的账号（即 `e64b61f1...`）故成功；CI 显式传了一个**不匹配**的 account id 就打到别的账号上报 10000。
> wrangler 失败时会自报 token 所属账号（`👋 You are logged in ... │ ... │ <account id> │`），对照修正 secret 即可。`nivara-ops` 所在账号 = `e64b61f1629ebcc49ee9b6eea2a95b82`。

#### 上线闭环操作手册（admin 后端上线时一次性做）

**Step 0 — 生成共享密钥**（一个值，两端同填）：
```bash
openssl rand -hex 32        # 记下输出，下面 A/B 用同一个值
```

**Step A — 服务端（VPS）开 admin 入口**：
1. VPS 上 `server/.env` 填 `NW_OPS_PROXY_SECRET=<Step0 的值>`。
2. 拉新代码（已含 Caddyfile `/ops/*` 路由 + compose caddy 注入密钥 + caddy depends_on admin）后重部署：
   ```bash
   cd /root/funny && git pull && cd server
   docker compose -f docker-compose.cloud.yml --env-file .env up -d --build
   ```
3. 自检（无密钥应 403）：`curl -i https://api.gamestao.com/ops/admin/me` → 期望 `403`。

**Step B — ops Worker 填同一密钥**（本机）：
```bash
npx wrangler secret put ADMIN_PROXY_SECRET -c wrangler/ops.jsonc   # 粘贴 Step0 的值
```

**Step C — Cloudflare Zero Trust 配 CF Access**（控制台，约 5 分钟，Free 含 50 用户）：
1. dash.cloudflare.com → 左栏 **Zero Trust**（首次会让你起一个 team name + 选 **Free** 方案，填完即可）。
2. **Settings → Authentication → Login methods**：起步加 **One-time PIN**（邮箱验证码，零配置，自带）即可；想用 Google/GitHub 也可加。
3. **Access → Applications → Add an application → Self-hosted**：
   - Application name：`ops`
   - Session Duration：`24h`（按需）
   - **Public hostname**：subdomain `ops`、domain `gamestao.com`、path 留空（= 保护整个 `ops.gamestao.com`，含 `/admin/*` 反代）。
4. 下一步 **Add policy**：
   - Policy name：`ops-admins`，Action：**Allow**
   - **Include → Emails**：列出授权邮箱（如 `tao.wang@elk.de`）。后续加人就来这里加邮箱。
5. Save。完成后访问 `ops.gamestao.com` 会先弹 CF Access 登录（邮箱收验证码），通过才进 ops 自己的登录页；因同源，`/admin/*` 的 fetch 自动带第一方 `CF_Authorization` cookie，无跨域问题。

**Step D — 验证闭环**：浏览器开 `https://ops.gamestao.com` → CF Access 邮箱验证码 → ops 登录页（API 基址留空=同源）→ 用 admin 账号登录 → 监控/账号页能拉到数据即通。

> **为何不在 `api.gamestao.com` 上加 CF Access**：那是面向玩家的游戏 API，不能套登录墙。admin 通道 `/ops/*` 靠**共享密钥头**保护（只有持密钥的 ops Worker 能过），与玩家 API 同域共存、互不影响。
> **密钥轮换**：重跑 Step0 生成新值 → 改 VPS `.env` 重部署（Step A）+ `wrangler secret put`（Step B），两端必须同步换。

## 6b. 可观测性 / 日志（Loki + Grafana，经 cloudflared 隧道 + CF Access）

云端日志查询栈，与主栈解耦、独立起停。**配置实体 + 完整部署手册见 `server/observability/`**（该目录 `README.md` 为单一来源）。要点：

- **采集**：Alloy 经 docker socket 抓**所有容器 stdout**（`loki.source.docker`），正则解出 `svc`/`level` 标签。零侵入——不改主栈、不设 `NW_LOG_DIR`、`docker logs` 仍人类可读。
- **存储/查询**：Loki（本地存储，留 14 天）+ Grafana（自动注册数据源 + 起手仪表盘「服务端日志」）。
- **对外**：`cloudflared` 出站隧道 → `grafana.gamestao.com`，**CF Access** 当登录墙（同 ops 的「走 Cloudflare」选择，但整站 Web 应用用 Tunnel 而非 Worker 反代）。无公网端口、隐藏源站 IP。Grafana 自带账号是第二层。
- **轮转**：靠 `/etc/docker/daemon.json` 的 `log-opts max-size`（一次性 host 配置），不撑爆盘。
- **SSH 兜底**：Grafana 绑 `127.0.0.1:3000`，不配 CF 也能 `ssh -L 3000:localhost:3000` 直连。

```bash
# 在 VPS server/ 目录下起栈（前置 daemon.json 限日志 + obs/.env 见 observability/README.md）
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d
```

**自动发布**：`.github/workflows/obs-deploy.yml`——push 改动落在 `server/observability/**` 时自动 SSH 进 VPS `reset --hard + up -d --force-recreate`（预构建镜像，无 build；与 server-deploy 解耦，互不触发）。复用同套 `VPS_SSH_KEY`/`VPS_HOST`；开关 `OBS_DEPLOY_ENABLED=true`（首次需先在 VPS 手动建 `observability/.env`），可选 `OBS_TUNNEL_ENABLED=true` 才带 cloudflared。`server-deploy.yml` 已 `!server/observability/**` 排除该子树，避免为日志配置白白 rebuild 后端。

### 上线记录（2026-06-24 ✅ 已验证）

完整闭环已上线，`https://grafana.gamestao.com` 外网可达。

- **VPS（`128.140.41.98`，`/root/funny`）**：`daemon.json` 写 `log-opts max-size=50m,max-file=5` + 重启 docker + `up -d --force-recreate` 主栈（metaserver 已验证 `LogConfig.Config=map[max-file:5 max-size:50m]`，游戏容器日志已封顶）；obs 栈自身也在 compose 里自限同款（不依赖 daemon.json）。
- **obs 栈**：`loki`(grafana/loki:3.4.2) + `alloy`(v1.7.5) + `grafana`(11.5.2) 三容器 Up；Loki `/ready` ok、Grafana `/api/health` db ok；Alloy 经 docker socket 抓日志、无 error。Loki labels 已含 `svc`(meta/gateway/matchsvc/admin…) + `level`(debug/info/warn)，可读单行正则解析生效（`[matchsvc:internal]` 正确归根 `svc=matchsvc`）。
- **Grafana**：admin 密码在 VPS `server/observability/.env`（`GF_ADMIN_PASSWORD`，随机生成，建议登录后改）；起手仪表盘「服务端日志」(uid `nw-server-logs`) provision 成功，已扩为 7 面板（日志速率/各服务错误数/错误总数/主过滤日志/仅错误/匹配链路速查/对战时间线 roomId），变量 svc·level·search·roomId。
- **Cloudflare（账号 `tao.wang.go@gmail.com`，account `e64b61f1…`）**：令牌式 Tunnel `nivara-grafana`，cloudflared 容器 4 条 QUIC 连边缘 ok；ingress `grafana.gamestao.com → http://grafana:3000`（远程托管配置已下发）；CF Access self-hosted 应用 `grafana` 罩 `grafana.gamestao.com`（policy `grafana`，邮箱白名单）。外网 `curl https://grafana.gamestao.com` → `302` 跳 `gamestao.cloudflareaccess.com/.../access/login`，证明边缘→隧道→Access 三段全通。
- **访问**：浏览器开 `https://grafana.gamestao.com` → CF Access 邮箱验证码 → Grafana 账号登录。SSH 兜底 `ssh -i ~/.ssh/nivara_hetzner -L 3000:localhost:3000 root@128.140.41.98` → `http://localhost:3000` 仍可用。

> 共享密钥/令牌两端：VPS `server/observability/.env` 的 `CF_TUNNEL_TOKEN` ＝ CF Tunnel `nivara-grafana` 令牌（`.env` 是 gitignore，不入库）。`OBS_DEPLOY_ENABLED`/`OBS_TUNNEL_ENABLED` 两个 repo variable 暂未开（手动部署已完成），需要 git push 自动发布时再开。

## 7. 平台隔离边界（ADR-020）

「某些平台是否不让共享用户」的结论：**身份层默认就隔离**——微信(openid)、web/CrazyGames(deviceId)、网站(oauth/密码)各映射独立账号，跨端合并是用户主动绑定。真正逼你隔离的是**数据合规**和**支付渠道**，不是身份。

| 维度 | web / CrazyGames | 微信（中国） |
|---|---|---|
| 部署 | 共享一套（本文方案） | **独立一套**（境内云 + 境内库，延后） |
| 身份 / 存档 / 天梯 | 可共享、可绑定合并 | 隔离（PIPL 数据驻留境内） |
| 钱包 / IAP | Stripe | 微信支付，隔离 |

两条硬约束：

1. **中国玩家数据须境内存储**（PIPL/网络安全法）→ 微信线 = 完全独立部署，不与本套全球部署互通。承接 ADR-019/ADR-013，**延后实现**。
2. **充值币按支付渠道隔离**：站外渠道（Stripe）购买的虚拟货币不得在微信/苹果内消费（违反平台条款）。当前 `wallet.coins` 是全局单钱包，上线微信/苹果前必须改造（充值币标记来源渠道）——这条要现在就进数据结构设计，别等迁移。

CrazyGames 限制只在前端（禁站外支付/外链），账号层与 web 共享即可。

## 8. 测试环境快速部署（self + 朋友内测，€5/月）

> 目标：最低配置先跑起来，自测 + 几个朋友联机。上平台后再 rescale 升配，数据盘不动。

**机器选型**：Hetzner Cloud **CX22**（2vCPU/4G/40G，~€4.5/月）+ 勾 Primary IPv4（~€0.6/月）；Location 选 Nuremberg/Falkenstein；Image 选 Ubuntu 24.04。库用 Atlas **M0 免费**集群（区域 AWS Frankfurt `eu-central-1`，与 VPS 同城）。

8 个进程**共用一个镜像** `nw-server:latest`（只构建一次），2 核机扛得住；构建偶尔吃内存，挂 2G swap 保险。

### Hetzner 计费速读（别被「两个价格」吓到，不会无故烧钱）

控制台服务器卡片上的 **USAGE** 和 **PRICE** 不是两个价格，是两件事：

| 字段 | 含义 |
|---|---|
| **USAGE**（如 €0.00） | 本计费周期(本月)**已实际产生**的费用；悬浮拆为 Traffic + Backup + Server 三项。新机刚开所以是 0，月底会涨到接近 PRICE。 |
| **PRICE**（如 €6.53/mo） | 这台机型的**月租封顶价**。按小时计，跑满整月最多收这么多。 |

一句话:左=已花,右=满月最多花,二者月底趋于一致。

**为什么基本不会突然烧很多钱**：
- **服务器费固定封顶**：不管 CPU/内存跑多满，CX23 服务器项就是固定 €6.53/月，**不存在按算力浮动暴涨**。
- **流量额度极大**：每月含 **20 TB 出站**（卡片 `TRAFFIC OUT: 0/20 TB`），超出才 €1/TB（欧洲区）；回合制小游戏后端正常一辈子用不到。**入站流量全免费**。
- **备份默认关闭**：Backup 是付费可选项（约 +20% 月租），不主动在 Backups 标签开就永远 €0。
- **无按请求/调用的隐藏计费**：模型只有「固定月租 + 超额流量」，很简单。

**唯一会加钱的动作都要你主动点**（不会自动发生）：开 Backups / 加 Volumes / 加 Floating IP / Rescale 升配。
**重要**：仅关机(Power off)**仍按机器存在收费**，要彻底停止计费必须 **Delete**。
顶栏 "Important status messages / Outage: N" 是 Hetzner 全网状态公告，**与你的账单无关**。
> 心智模型：只要不开备份、不加卷、不加 IP、不升配，这台机器每月就是固定 ~€6.53 封顶，无意外。

### Hetzner 账号注册（首次，德国境内最顺）

1. **注册**：https://console.hetzner.cloud → Register → 填邮箱+密码 → 收验证邮件激活。
2. **完善账户资料**（决定能否过风控、能否开机，新号务必填真实）：
   - 真实姓名 + 德国账单地址（要能对上）；个人选 *Privat*，公司选 *Geschäftskunde*（需填 USt-IdNr.）。
   - **身份验证**：新号常被要求验证。德国境内用**信用卡**或 **PayPal** 最快；偶尔要求上传证件/自拍，按提示走。
3. **绑定支付**：Settings → Payment 加 信用卡 / PayPal / SEPA 直接借记（SEPA 需先验证德国银行账户）。
4. **上传 SSH 公钥**：把公钥内容贴到 Console → Security → SSH Keys（开机时勾选，避免密码登录）。本项目已生成专用密钥，见下「SSH 密钥」。
5. **建项目**：Console → + New Project（如 `nivara-backend`），后续服务器都开在此项目下。

#### 已开服务器（2026-06-24，✅ 已上线验证）

| 项 | 值 |
|---|---|
| 名称 | `funny-backend`（Hetzner #144565403） |
| 规格 | CX23（2 vCPU / 4 GB / 40 GB），Nuremberg，Ubuntu 26.04 |
| 公网 IPv4（`<VPS_IP>`） | `128.140.41.98` |
| IPv6 | `2a01:4f8:1c1a:73ad::/64` |
| 部署目录 | `/root/funny`（git clone，public repo `bigtaoo/funny`） |
| 运行模式 | `NW_DOMAIN=api.gamestao.com`（HTTPS，Caddy 自动签 LE）；10 容器全 Up；连 Atlas `cluster0.rpr2tnw` 成功 |
| 对外入口 | REST `https://api.gamestao.com/api/...`、控制面 `wss://api.gamestao.com/gw`、数据面 `wss://api.gamestao.com/ws`（`NW_GAME_PUBLIC_WS_URL` 下发） |
| DNS | Cloudflare A 记录 `api.gamestao.com`→`128.140.41.98`，**灰云（DNS only）**——Caddy 才能签/续 LE；橙云会卡续签 |
| 证书 | Let's Encrypt（`CN=api.gamestao.com`），灰云下自动续签 |
| 验证 | `POST https://api.gamestao.com/api/auth/device` → 200 建号发 token（外网 HTTPS 可达） |

> **转橙云时**（隐藏 IP + DDoS）：CF 代理后 Caddy 的 HTTP-01/TLS-ALPN 验证到不了源站、LE 90 天续签会失败 → 换 **Cloudflare Origin Certificate**（15 年，装进 Caddy `tls` 指令）+ SSL 模式 Full(strict)，或给 Caddy 配 Cloudflare DNS-01 验证（CF API token）。详见下「上线转橙云」。

#### 上线转橙云（待办，公开上线前做）

**现状**：内测期保持**灰云（DNS only）**，Caddy 自动签/续 LE，零维护、够用。**公开上线前**再转橙云拿隐藏源站 IP + DDoS 防护。

**为什么不能直接开橙云**：橙云后 TLS 被切两段——玩家↔CF（CF 边缘证书，自动免费）、CF↔源站（需源站自己有证书）。LE 验证（HTTP-01/TLS-ALPN）请求被 CF 在边缘终止、到不了 Caddy → **90 天后 LE 续签失败、证书过期**（坑埋在 3 个月后，易忘）。

**解法 = Cloudflare Origin Certificate**（**全程免费**，Free 套餐即有；橙云代理/DDoS/边缘证书/Origin Cert 全免费）：

| 项 | 说明 |
|---|---|
| 有效期 | 最长 15 年，基本免续签 |
| 信任范围 | 仅 Cloudflare 信任即可（只有 CF 连源站；玩家侧走 CF 边缘证书） |

**操作（约 10 分钟）**：
1. CF 控制台 SSL/TLS → Origin Server → Create Certificate → 拿 `cert.pem` + `key.pem`，传到 VPS（如 `/root/funny/server/certs/`）。
2. 改 `Caddyfile`：站点块内加显式证书，Caddy 即停用 LE 自动签：
   ```
   {$NW_DOMAIN::80} {
       tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
       ...
   }
   ```
   并在 `docker-compose.cloud.yml` 把 certs 目录挂进 caddy 容器。
3. CF DNS 把 `api` 这条记录**灰云切回橙云（Proxied）**。
4. CF SSL/TLS → Overview 设 **Full (strict)**。

> 替代方案：不装 Origin Cert，给 Caddy 配 Cloudflare DNS-01 验证（需 CF API token），LE 改走 DNS 验证即可在橙云下续签——多一个 token 要管，一般首选 Origin Cert。

> **踩坑记录**：Atlas 报 `tlsv1 alert internal error: SSL alert number 80` = **来源 IP 不在 Atlas Network Access 白名单**（不是 TLS/证书问题）。新机 IP 须加进 Atlas 白名单（测试期 `0.0.0.0/0`，上线收紧到 `<VPS_IP>/32`）。
> **注意**：连接串含 `&`，写 `.env` 时**别用 `sed` 替换**（`&` 是 sed 特殊字符会被展开）；用 `grep -v` 删行后 `printf` 追加。

#### SSH 密钥

专用 ed25519 密钥，**仅用于连 Hetzner VPS**。

> ⚠️ **2026-07-14 换钥**：原密钥（`nivara-hetzner-20260624`，指纹 `SHA256:I7/fC9ia…`，Hetzner 里名为 `funny-ssh`）在一次系统重装后**私钥丢失**，各备份（`D:\cloud`、`C:\backup\ssh`、`C:\backup\wnet-ssh`、`D:\Backup\TaoWang-rescue`）均只找到 wnet 项目的 key，无 nivara。已重新生成下表的新钥。Hetzner 里那条 `funny-ssh` 已成死条目（对应私钥没了），可留可删。

**当前有效密钥（2026-07-14 生成）：**

| 项 | 值 |
|---|---|
| 私钥（**保密，绝不进 git/聊天/截图**） | `D:\cloud\nivara_hetzner`（本机 `taowa` 用户；注意不是文档旧写的 `C:\Users\TaoWang\.ssh\`） |
| 公钥 | `D:\cloud\nivara_hetzner.pub` |
| 指纹 | `SHA256:pfV1ral7KA57wkUh3MvZxXjTgUC/quqYwfM0Wp1Ocwc`（MD5 `9e:9d:ee:79:cc:74:db:8b:0b:0e:8c:e7:fe:4d:4f:ed`，Hetzner 里名为 `nivara`） |
| 密码短语 | 无 |

公钥串：
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbskPHtk91w34e7Qp2CnYlBcUQ1hdKJHb4zxltvQAjY nivara-hetzner-20260714
```

登录命令：
```bash
ssh -i /d/cloud/nivara_hetzner root@128.140.41.98
```

> **私钥又丢了怎么办（本次实操验证的恢复流程）**：Hetzner Cloud 现版 UI **没有**"运行中改 authorized_keys"的按钮，项目级 SSH keys 只对新建机器生效、加了对已跑的机器无效；用 **Rescue 模式**恢复——① 新公钥先加进 Security → SSH keys；② 服务器 Rescue 标签页 `Enable rescue & power cycle` 并在弹窗勾选该 key（会重启进救援系统，后端离线 1–2 分钟）；③ `ssh -i <新私钥> root@IP` 进救援系统，`mount /dev/sda1 /mnt` 挂真实根分区，把公钥 append 进 `/mnt/root/.ssh/authorized_keys`；④ Disable rescue 后在救援系统里 `reboot` 回本地磁盘。（Reset Root Password + Console 那条路在德语物理键盘上不可行——noVNC 键盘布局串码，`~`/`'`/`>>` 全打错。）

> 新账号第一次开机偶尔卡「审核中」（几分钟到几小时，有时需回邮件补资料）——这是 Hetzner 防滥用的正常流程，不是出错。

### 步骤

1. **Atlas M0**（先做，拿连接串）：建 M0 集群 → 建库用户（密码避开 `@:/?`）→ Network Access 测试期先 `0.0.0.0/0` → Connect/Drivers 取串，末尾加 `&maxPoolSize=10`：
   ```
   mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&maxPoolSize=10
   ```

2. **开 VPS**：Hetzner Console → New Server（CX22 / Ubuntu 24.04 / ✅ Public IPv4 / 加 SSH key）→ 记下公网 IP `<VPS_IP>`。

3. **装 Docker**（SSH 进 VPS 后）：
   ```bash
   apt update && apt upgrade -y
   curl -fsSL https://get.docker.com | sh
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

4. **弄代码上 VPS**：`git clone <repo> /root/funny`（推荐）或本地 `scp -r` 整个仓库到 `/root/funny`，然后 `cd /root/funny/server`。

5. **配置 .env**（`cp .env.example .env` 后填）——测试阶段至少这 4 项：
   ```bash
   NW_JWT_SECRET=$(openssl rand -hex 32)        # 三把密钥各跑一次 openssl 生成不同串
   NW_INTERNAL_KEY=$(openssl rand -hex 32)
   NW_ADMIN_JWT_SECRET=$(openssl rand -hex 32)
   NW_MONGO_URI=<步骤1的Atlas串，带 &maxPoolSize=10>
   ```
   域名二选一：
   - **无域名（最快）**：`NW_DOMAIN=:80`、`NW_GAME_PUBLIC_WS_URL=ws://<VPS_IP>/ws`（走 HTTP/WS）
   - **有域名**：Cloudflare DNS 加 `api.gamestao.com` A 记录→`<VPS_IP>`（**先关橙云**让 Caddy 签证书），`NW_DOMAIN=api.gamestao.com`、`NW_GAME_PUBLIC_WS_URL=wss://api.gamestao.com/ws`，证书稳定后再开橙云。

6. **启动**（首次构建 5-10 分钟）：
   ```bash
   docker compose -f docker-compose.cloud.yml --env-file .env up -d --build
   docker compose -f docker-compose.cloud.yml ps
   docker compose -f docker-compose.cloud.yml logs -f metaserver   # 确认连上 Atlas、无报错
   ```

7. **验证**：`curl http://<VPS_IP>/`（或 `https://api.gamestao.com/`）返回 `Notebook Wars server` 即通。Hetzner 默认不开防火墙，80/443 直达；若开了 Firewall 记得放行。

8. **前端连后端**：见 §6「client web 包的地址烘焙」。内测最省事用 localStorage 覆盖，不必为测试环境单独构建。

### 运维速查

```bash
# 更新代码重部署
cd /root/funny && git pull && cd server
docker compose -f docker-compose.cloud.yml --env-file .env up -d --build
# 停/启
docker compose -f docker-compose.cloud.yml down
docker compose -f docker-compose.cloud.yml --env-file .env up -d
# 升配（玩家上来后）：Hetzner Console → 关机 → Rescale → CPX21/CPX31 → 开机，数据盘不动
```

#### 自动发布（GitHub Action，免手敲命令）

`.github/workflows/server-deploy.yml`：push 到 `main` 且改动落在 `server/**` / 该 workflow 时，自动 SSH 进 VPS 跑 `git fetch + reset --hard origin/main → docker compose -f docker-compose.cloud.yml --env-file .env up -d --build → docker compose restart caddy`；也可在 Actions 页手动 Run（`workflow_dispatch`）。与 client-deploy / ops-deploy 同理念（裸 ssh，不用第三方 action，报错原样可见）。

> `restart caddy` 是必需的、不是可选优化：Caddyfile 走 bind mount，`up` 只在 compose 服务定义本身变化时才重建/重启容器，文件**内容**变了但挂载路径没变，compose 侦测不到，caddy 就会照旧跑着旧配置——2026-07-03 两次 Caddyfile 修复（`/health`、`/sect` `/nation` 反代）都是重启前的修复：合入 main、CI 部署跑完、但 caddy 容器仍在跑 10 天前的旧配置，直到手动 `docker compose restart caddy` 才生效。

**镜像在 VPS 本机构建**（与手动运维命令一致，2 核机 + 2G swap 扛得住）；`.env` 是 gitignore，`reset --hard` 不动它。同步用 `reset --hard origin/main`（非 `git pull`）以消除 VPS 工作区漂移（如之前 ops 改容器留下的本地变动）。

> ⚠️ **新增/拆分后端服务必须同步 `server/Dockerfile`**（不止改三个 compose + Caddyfile）：共享镜像 `nw-server:latest` 里必须有该服务的 dist，否则容器 `MODULE_NOT_FOUND` 崩溃重启、Caddy 转发返回 502（浏览器表现为 CORS 头缺失，是副作用非根因）。三处都要加：build 阶段 `COPY <svc>/package.json`（`npm ci` 前）、`tsc -b` 列表加 `<svc>`、runtime 阶段 `COPY --from=build /app/<svc>/{package.json,dist}`。2026-07-06 auctionsvc 拆分即因漏改 Dockerfile 上线 502（PR #17 修复）。

一次性配置：

1. **专用 CI deploy SSH key**（与本机日常 `nivara_hetzner` 隔离，2026-06-24 生成）：

   | 项 | 值 |
   |---|---|
   | 私钥（**保密，绝不进 git/聊天/截图**） | `C:\Users\TaoWang\.ssh\nivara_ci_deploy` |
   | 公钥（贴 VPS `~/.ssh/authorized_keys`） | `C:\Users\TaoWang\.ssh\nivara_ci_deploy.pub` |
   | 指纹 | `SHA256:abvzWEnBgcHyyRcoTPszMbX9sweQ8OseuXOGr4/YlYA` |
   | 密码短语 | 无（CI 非交互） |

   公钥串：
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAooPPL64xUT3zopA6wugAAtQKi4YKjNPIgKqRV/czvA nivara-github-ci-deploy
   ```

   **装到 VPS**（本机一条命令，追加到 root 的 authorized_keys，不覆盖现有 key）：
   ```bash
   ssh -i ~/.ssh/nivara_hetzner root@128.140.41.98 \
     "mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAooPPL64xUT3zopA6wugAAtQKi4YKjNPIgKqRV/czvA nivara-github-ci-deploy' >> ~/.ssh/authorized_keys"
   ```

2. **repo secret** `VPS_SSH_KEY` = `nivara_ci_deploy` 私钥整段内容（含 `-----BEGIN/END OPENSSH PRIVATE KEY-----` 行）。
3. **repo variables**：`VPS_HOST` = `128.140.41.98`（灰云时也可填 `api.gamestao.com`）；可选 `VPS_USER`（缺省 `root`）、`VPS_DEPLOY_PATH`（缺省 `/root/funny`）。
4. **开关**：repo variable `SERVER_DEPLOY_ENABLED = true`（未设则 job 跳过，与 client/ops 同套路）。

> 主机公钥由 workflow 内 `ssh-keyscan` 钉进 known_hosts（防 MITM）。VPS 重装/换 IP 后首跑会因 known_hosts 不符失败，属预期——换 IP 后改 `VPS_HOST` 即可。
> 手动运维老路（上面「运维速查」两条命令）仍可用，适合本机临时发布或 CI 不可用时兜底。

## 9. 备注

- 特效编辑器（vfx-editor）与关卡编辑器（level-editor）**发布配置均已就绪**（各一份 `wrangler/*.jsonc` + GitHub Action，见 §6），设开关 repo variable 并 push/手动 Run 即上线。
- 全球多区域演进见 `DEPLOY_TOPOLOGY.md`（ADR-019）：Meta 共享 + 对战层按区隔离。本文件是单区起步版，选 VPS 商时心里装着「以后每区复制一套 matchsvc/gameserver」。
- 备份：Atlas M0 自带快照；如需导出见 `server/deploy/backup-mongo.sh`（连接串改成 Atlas 即可）。
