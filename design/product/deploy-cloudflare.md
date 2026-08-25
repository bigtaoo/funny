# 部署方案：Cloudflare 前端 + VPS 后端 + 托管 Mongo

> 权威来源：本文件为「线上部署拓扑」的单一来源。配置实体见 `server/docker-compose.cloud.yml` + `server/Caddyfile` + `server/.env.example`。


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `deploy-cloudflare.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ 部署方案：Cloudflare 前端 + VPS 后端 + 托管 Mongo | **本文** |
| 6b Loki/Grafana、7 平台隔离边界、8 测试环境快速部署、9 备注 | [`deploy-cloudflare-staging.md`](deploy-cloudflare-staging.md) |

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
  NW_AUCTION_BASE=https://api.gamestao.com \
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
| `NW_AUCTION_BASE` | 拍卖行 REST 基址（`WorldApiClient` 直连独立的 auctionsvc） | `https://api.gamestao.com` | —（无覆盖） |

> ⚠ **`NW_SOCIAL_BASE`/`NW_AUCTION_BASE` 生产必填**：留空时 `getSocialBaseUrl()`/`getAuctionBaseUrl()` 会从 `NW_WORLD_BASE` 派生并强改端口（`:8085`/`:18086`，均为 dev 直连端口，公网未开放），分别导致家族/宗门/世界社交请求、拍卖行全部请求 `网络连接失败`（浏览器侧表现为 `ERR_CONNECTION_REFUSED`）。`NW_AUCTION_BASE` 曾漏配（2026-08-02 线上报告拍卖行发布物品报 `Failed to fetch` 才发现，CI workflow 已同步补上）。friends/mail 走 `NW_API_BASE`→metaserver 代理，不受影响。

- **数据面 WS（`/ws`）不烘焙**：由 metaserver 鉴权回包的 `match_found.game_url` 下发；缺省时 `client/src/net/config.ts` 从 API base 自动推导（`/api`→`/ws`）。`NW_GAME_PUBLIC_WS_URL`（后端 .env）就是这个下发地址的来源。
- 构建命令：`cd client && NW_API_BASE=... NW_GATEWAY_WS=... NW_WORLD_BASE=... npm run build:web` → 产物 `client/dist`。
- **localStorage 覆盖（内测神器）**：用一份默认构建即可，朋友在浏览器 DevTools console 跑 `localStorage.setItem('nw_api_base','http://<VPS_IP>/api'); localStorage.setItem('nw_gateway_ws','ws://<VPS_IP>/gw'); location.reload()` 就能连你的后端，无需为每个环境重新构建。

#### 缓存策略（防 iPad / Safari 服务旧版本）

生产构建会输出三类文件，各有不同缓存策略：

| 文件 | 命名规则 | Cache-Control | 原理 |
|---|---|---|---|
| `static/<hash>.js` + `static/<hash>.{png,tao,…}` | contenthash | `public, max-age=31536000, immutable` | 内容变 → 文件名变 → 新 URL，永久缓存安全 |
| `index.html` | 固定名 | `no-cache, must-revalidate` | 每次加载都验证，拿到最新 JS 文件名 |
| `version.json` | 固定名 | `no-cache, must-revalidate` | 客户端轮询用，必须实时 |
| 其余根目录固定名文件（favicon/图标/法务页） | 固定名 | CF 默认（`max-age=0, must-revalidate`） | 极少变、体积小，回源校验成本可忽略；换图标要能立刻生效 |

**实现**：`webpack.config.js` 生产构建时自动输出 `_headers` 文件（CF Workers static assets 支持此格式），并把**所有 contenthash 产物（JS + 每个 `asset/resource` 文件）输出到 `static/` 子目录**；`client/nginx.conf` 同步配置（Docker 环境用）。

> ### ⚠ 这张表曾经有一年多是**纯粹的错觉**（2026-08-25 修复）
>
> 上面第一行从写下那天起就没在生产上成立过。`_headers` 的生成代码里**只有 `index.html` 和 `version.json` 两条**，contenthash 文件那条从来没写进去；`client/nginx.conf` 里倒是配对了，但那只是本地 Docker 模拟，**生产走 CF Workers、根本不经过 nginx**。于是线上一直落在 Workers 的默认策略上：
>
> ```
> curl -sSI https://a.gamestao.com/<hash>.js
> → Cache-Control: public, max-age=0, must-revalidate
> ```
>
> 后果：**回访玩家每次会话都要为每个资源付一次回源校验**（304、body 为 0，但 RTT 照付），其中 2 MB bundle 的那一次卡在关键路径最前面——校验完才能开始 parse。ASSET_PACKAGING §11 靠 `<link rel=preload>` 分层争来的收益因此被吐掉一部分。
>
> **为什么没人发现**：本地 nginx 那份配置是对的，文档这张表也是对的，**唯独真正被部署的那份不对**——三处里有两处给了正确的印象。只有直接 `curl` 生产域名才看得出来。
>
> **同类风险的通用规避**：一份只在本地生效的配置（`nginx.conf`）和一份只在生产生效的配置（`_headers`），语义必须一致却没有任何东西保证它们一致。改任一处之后，**用 `curl -sSI` 对生产域名验一次**，别只信文档和本地。
>
> **为什么 `_headers` 必须靠 `static/` 前缀分开、而不能写 `/*` 再拿更窄的规则覆盖**：CF 的 `_headers` 没有优先级模型（多条匹配则**全部继承**，同名 header **逗号拼接**而非覆盖），`/*.js` 这种带字面后缀的 splat 也不在文档保证内。详见 ASSET_PACKAGING §13.1。

**客户端主动刷新**：`client/src/entries/web.ts` 在 `visibilitychange`（玩家切回前台）时拉 `/version.json`，与运行中的 `__NW_BUILD_VERSION__` 对比，版本不同则 `location.reload()`。确保已开着页面的玩家（尤其 iPad 后台切回）能立即获取新版本，无需手动刷新。

#### 自动发布（GitHub Action，免手敲命令）

`.github/workflows/client-deploy.yml`：CI（`ci.yml` 的 build-test + e2e）在 `main` 上跑绿、且 `client/**` / `server/engine/src/**` / `server/shared/src/slg/**` / `wrangler/client.jsonc` / 该 workflow / `.github/actions/paths-changed-since/` 这些路径**相对「上次真正部署成功的那个 commit」有差异**时自动 `npm ci → build:web（地址烘焙到 api.gamestao.com）→ wrangler deploy`；也可在 Actions 页手动 Run（`workflow_dispatch`，跳过 CI 门禁与路径判断）。**2026-08-12 起改为 `workflow_run` 触发**（原先是 `push: branches:[main]` 直触发，与 CI 完全并行、不等结果——CI 的 e2e job 最长 25 分钟，deploy 几分钟就跑完，红码可能先于 CI 报错就已上线；详见 `.github/actions/paths-changed-since`，该改动同时把 8 个 `*-deploy.yml` 的路径过滤从 `push.paths`（`workflow_run` 不支持）挪进了 job 内的 `git diff` 判断）。与 ops-deploy 同套路：

1. **复用 ops 那套 secrets**：`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 已配（同一 CF 账号 `e64b61f1...`，"Edit Cloudflare Workers" token 是账号级 Workers 写权限，覆盖 `nivara-client`，**无需新建 token**）。
2. **开关**：设 repo variable `CLIENT_DEPLOY_ENABLED = true`（未设则 job 跳过）。
3. 地址烘焙的三个构建期环境变量写死在 workflow 里（与手动命令同值），改地址改 workflow 即可。

> 手动两条命令的老路仍可用（上面命令块），适合本机临时发布或 CI 不可用时兜底。

#### ⚠ 部署基线为什么是「上次部署成功的 commit」而不是「上一个 commit」（2026-08-15 线上事故）

**现象**：头像改版（20 张预设立绘 + 删掉 装备/材料 分类）已经在 `main` 上躺了一天多，`a.gamestao.com/version.json` 却还是 `220cf45`，玩家看到的仍是旧的 8 图标 / 6 页签选择器。期间 Actions 页面上 client-deploy 一路显示 **success**，没有任何红码。

**成因（两次连环漏掉）**：

1. 头像改动走 PR #101（`f99177a3`）进 main，**那次 CI 是红的**（`server test (metaserver)` 挂了，与客户端无关）。client-deploy 的门禁是 `github.event.workflow_run.conclusion == 'success'`，于是整个 workflow 被 skip，`client/**` 的这次改动从未进过 deploy job。
2. 下一次合并 PR #102（`ac5cae8e`）CI 绿了，client-deploy 也触发了——但当时的路径过滤是 `git diff <sha>^ <sha>`，**只看这一个 commit 碰了什么**。#102 里只有 metaserver 的测试修复，一行 `client/**` 都没有 → `deploy` job 被 skip。而 `check` job 是成功的，所以整个 run 的结论仍是 success，看上去像"部署过了"。

**根因**：`sha^..sha` 这个基线假设「每个 commit 都有机会被部署」。只要有任何一次机会被吃掉（CI 红、`cancel-in-progress` 取消、deploy job 失败、开关当时没开），那次改动就**永久**错过部署——后续 commit 只审视自己，不会替它补上。而且失败是静默的。

**修法（2026-08-15）**：`paths-changed-since` 的基线改为**「本 workflow 最近一次 `deploy` job 真正 `success` 的那个 run 的 head_sha」**（通过 Actions API 反查，`status=completed` 天然排除当前 in-flight 的 run），再做 `git diff <baseline> <head>` 的**树对比**。由此得到三条性质：

- **自愈**：无论上次是怎么被跳过的，只要东西还没上线，下一次 run 就会把它带上去——基线只在真正发布成功时才前进。
- **幂等**：`baseline == head` 时直接 `changed=false`，不会重复发。
- **失败开放（fail-open）**：查不到基线（首次运行、超出 `scan-limit`、Actions run 90 天保留期过期）或基线 commit 已不可 fetch（历史被改写）时一律 `changed=true`。多发一次几分钟，不发才是事故。

树对比（而非历史遍历）只需要两个 commit 对象，所以 `check` job 保持 `fetch-depth: 1`，基线由 action 自己 `git fetch --depth=1` 拉；force-push / revert / 非线性历史下语义都还是「线上那棵树和这棵树在这些路径上是否不同」。8 个 `*-deploy.yml` 全部同步改造，并各自把 `.github/actions/paths-changed-since/` 加进 include（判定逻辑本身变了就该重新发一次）；`check` job 需要 `actions: read` 读自己的 run 历史，已在 workflow 级 `permissions` 显式声明。

> **排查手法留存**：怀疑线上是旧版时，`curl -s https://a.gamestao.com/version.json` 拿到的短 sha 就是权威答案；再 `gh run view <run-id> --json jobs` 看 **deploy job 本身**的 conclusion——**run 级别的 success 不代表部署发生了**（`check` 成功 + `deploy` skipped 也是 success）。

#### ⚠ 「PR 绿了、合进 main 却红、于是不部署」——CI 稳定性治理（2026-08-15 同日第二轮）

上一节把「漏掉的部署会不会自愈」修好了，但**触发条件本身**还在反复出现：同一天 main 上的 CI 红了两次（PR #101 `31887181835`、PR #103 `31902034760`），两次都发生在对应 PR 的 CI 已经绿了之后，8 个 `*-deploy.yml` 因 `workflow_run.conclusion == 'success'` 门禁全部 skip。

**排查结论：不是「PR 查得少、main 查得多」，是测试套件本身不确定，外加流水线把不确定性集中砸在 main 上。**

- 三次 main 红的原因两两不同：#101 是 metaserver `pvp-card-stats` 读在 fire-and-forget 写之前；#103 是 worldsvc `httpApiActionSiegeMapGaps` 的 `PATH_BLOCKED`（`POST /world/join` 自动选点掷 `Math.random()`，首都落点每次不同 → 行军路径能不能走通是每次一掷）；更早 7-29 的 #76 是 full-link E2E。
- **PR 也一样在 flake**，只是被"重跑到绿"掩盖了：最近 100 次 CI 里 PR 失败 20 次，`31898655236`（PR）就挂在 worldsvc shop TOCTOU 上，重跑后才绿。main 每次合并只跑一次、没有筛选，所以同样的 flake 率在 main 上显形。这是观感上"PR 过 CD 挂"的第一位成因（选择偏差），不是两条流水线检查内容不同。
- 三个系统性放大器：①`ci.yml` 的 `TEST_SCRIPT` 让 PR 跑 `test`、main 跑 `test:coverage`，两条命令不同——v8 插桩把每个 await 窗口都拉长（同 commit 实测 worldsvc 184.5s→226.3s，collect 20s→41s），时序敏感用例在 main 侧更容易挂；②90% 覆盖率门禁只在 main 存在，覆盖率回归在 PR 上structurally 测不出来；③shard 一挂就没有 coverage 产物，门禁再报一次 "no coverage/ output found"，这条更响的假红把真因盖住了。

**修法（本轮，`feat/ci-stability`）**：

1. **消灭不确定性**：`httpApiActionSiegeMapGaps.e2e.test.ts` 改为显式坐标建都（`joinWorld(worldId, accountId, x, y)`），不再吃自动选点的随机；`WorldServiceDeps` 新增可注入的 `rng`（默认 `Math.random`），让必须走自动选点的用例也能钉死。
2. **PR 与 main 跑同一条命令**：两端一律 `test:coverage`，覆盖率门禁同时在 PR 生效，换来「main 能挂的，PR 一定先挂」。client 那笔 3.6 倍插桩税（188s→668s，也是当初"PR 不跑 coverage"的唯一理由）实测几乎全来自 `test/difficulty/**` + `pvpSim`，而它们只值 0.05 个百分点的覆盖率——拆进 `vitest.sim.config.ts` 照跑但不插桩后，带 coverage 的那半从 668s 掉到 ~13s。净代价只剩 server shard 的 ~+25%。
3. **单点 flake 不再拖垮部署**：DB/网络相关的 vitest 配置加 `retry: 1`，并用 `scripts/flakyReporter.mjs` 把"重试后才过"的用例变成 `::warning::` 注解 + `flaky-report.json` 产物——重试不是用来和 flaky 共存的，是用来把它从"阻断部署"降级成"可见的待办"。
4. **级联假红**：`checkCoverageThreshold.mjs` 读 `TESTS_OK`，测试 job 已经挂了时只报表不 `exit 1`（run 反正已经红了、也不会部署）；测试全绿时缺产物仍然 fail-closed。
5. **主动发现**：`flake-hunt.yml` 每晚把各 shard 连跑 3 次（带 coverage，复现同样的时序），任何一次挂就是不确定性——树没变。
6. **兜底**：`ci-rerun-once.yml` 对 main 上失败的 CI run 自动 `gh run rerun --failed` 一次（`run_attempt == 1` 卡死上限，PR 不自动重跑）。重跑成功会重新发一次 `workflow_run: completed`，deploy 照常触发。
7. **结构性（确认本仓库暂时用不了）**：`ci.yml` 已挂上 `merge_group:` 触发器，但 **GitHub merge queue 只对组织名下的仓库开放**，`bigtaoo/funny` 在个人账号下（公开也不行）——建 `merge_queue` 规则一律 422，同一次请求里其它规则能改成功，排除权限问题。要用得把仓库转到组织下；触发器留着，届时无需改 workflow。**替代措施已启用**：ruleset `Only PR` 的必需检查补上 `test coverage report`（此前覆盖率门禁挡不住 PR），加上它本来就开着的 `strict_required_status_checks_policy`（分支必须先与 main 同步才能合并），已经覆盖了 merge queue 在本仓库节奏下的绝大部分收益。

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

`.github/workflows/ops-deploy.yml`：CI 在 `main` 上跑绿、且该 commit 改动落在 `tools/ops/**` / `wrangler/ops.jsonc` / `wrangler/worker.ops.js` 时自动 `npm ci → build → wrangler deploy`；也可在 GitHub **Actions 页手动 Run**（`workflow_dispatch`，跳过 CI 门禁）。触发方式见 client-deploy 小节的 2026-08-12 改动说明。一次性配置：

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


---

**接下页** → [`deploy-cloudflare-staging.md`](deploy-cloudflare-staging.md)：6b Loki/Grafana、7 平台隔离边界、8 测试环境快速部署、9 备注。
