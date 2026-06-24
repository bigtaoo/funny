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
| client（主游戏 web 包） | `npm run build:web` | `client/dist` | ✅ **已上线** `https://a.gamestao.com`（Worker `nivara-client`，2026-06-24 验证：HTTP 200 + 证书有效 + 可登录开局） |
| animator | — | — | ✅ 已上线 |
| level-editor | — | — | 暂缓（不急） |
| ops | `npm run build` | `tools/ops/dist` | ✅ **已上线** `https://ops.gamestao.com`（Worker `nivara-ops`，2026-06-24 验证：HTTP 200 + 标题正确 + 证书有效；首部署后本机系统 DNS 短暂未刷新，CF 1.1.1.1 已解析） |

前端构建时需把 API/WS base 指到 `api.gamestao.com`（client 入口里地址烘焙，参考 animator 的部署方式）。

### client 部署（Cloudflare Workers static assets，对外 `a.gamestao.com`）

与 animator 同模式，但**各一份 wrangler 配置、各一个 Worker**，互不影响：

- animator → 仓库根 `wrangler.jsonc`（Worker `animator`）
- client → 仓库根 `wrangler.client.jsonc`（Worker `nivara-client`，`routes.custom_domain=true` 自动建 DNS+边缘证书，橙云）

**首次上线记录（2026-06-24，✅ 已验证）**：CF 账号 `tao.wang.go@gmail.com`（Account ID `e64b61f1...`）；`wrangler login`（OAuth，凭证存本机）→ `wrangler deploy -c wrangler.client.jsonc` 一次成功，上传 14 个静态资源，`custom_domain` 自动建好 `a.gamestao.com`；外网 `https://a.gamestao.com` HTTP 200、证书有效、可登录开局并连到 `api.gamestao.com`。以后更新只需「重构建 → deploy」两条命令，无需再登录。

```bash
# 1. 构建（地址烘焙到 api.gamestao.com）
cd client && NW_API_BASE=https://api.gamestao.com/api \
  NW_GATEWAY_WS=wss://api.gamestao.com/gw \
  NW_WORLD_BASE=https://api.gamestao.com npm run build:web
# 2. 部署（从仓库根，-c 指定 client 的配置）
cd .. && npx wrangler deploy -c wrangler.client.jsonc
```

> **首次需登录 CF**：`npx wrangler login`（浏览器 OAuth，写本机凭证）后再 deploy；或设 `CLOUDFLARE_API_TOKEN` 环境变量走非交互。
> `a.gamestao.com` 是**单层子域**，被免费 `*.gamestao.com` 通配证书覆盖（别用多层 `a.b.gamestao.com`）。
> 数据面 WS（`/ws`）走 `match_found.game_url` 下发，缺省由 API base 自动推导 `/api`→`/ws`，前端无需单独配。

**client web 包的地址烘焙（确切变量）**：`client/webpack.config.js` 用 DefinePlugin 注入，读三个构建期环境变量（生产默认空串 = 同源相对路径）：

| 环境变量 | 用途 | 形如 | 运行时 localStorage 覆盖键 |
|---|---|---|---|
| `NW_API_BASE` | REST 基址 | `https://api.gamestao.com/api`（无尾斜杠） | `nw_api_base` |
| `NW_GATEWAY_WS` | 控制面 WS | `wss://api.gamestao.com/gw` | `nw_gateway_ws` |
| `NW_WORLD_BASE` | SLG 世界 REST 基址 | `https://api.gamestao.com` | —（无覆盖） |

- **数据面 WS（`/ws`）不烘焙**：由 metaserver 鉴权回包的 `match_found.game_url` 下发；缺省时 `client/src/net/config.ts` 从 API base 自动推导（`/api`→`/ws`）。`NW_GAME_PUBLIC_WS_URL`（后端 .env）就是这个下发地址的来源。
- 构建命令：`cd client && NW_API_BASE=... NW_GATEWAY_WS=... NW_WORLD_BASE=... npm run build:web` → 产物 `client/dist`。
- **localStorage 覆盖（内测神器）**：用一份默认构建即可，朋友在浏览器 DevTools console 跑 `localStorage.setItem('nw_api_base','http://<VPS_IP>/api'); localStorage.setItem('nw_gateway_ws','ws://<VPS_IP>/gw'); location.reload()` 就能连你的后端，无需为每个环境重新构建。

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
- 配置实体：`wrangler.ops.jsonc`（Worker `nivara-ops` + `run_worker_first:["/admin/*"]` + var `ADMIN_ORIGIN`）、`worker.ops.js`（反代逻辑）、`server/Caddyfile` 的 `/ops/*` 路由、`docker-compose.cloud.yml` caddy 的 `NW_OPS_PROXY_SECRET`。

**静态页已上线（2026-06-24 ✅）**：Worker `nivara-ops` + `custom_domain` 自动建 `ops.gamestao.com`，HTTP 200、证书有效；`/admin/*` 已确认走 Worker 反代（非 SPA 回退）。**完整闭环（连到线上 admin）尚待**：admin 后端公网入口上线 + CF Access 配好（下面手册）。

#### 部署命令（ops 前端 / Worker）

```bash
cd tools/ops && npm run build                      # 产物 tools/ops/dist
cd ../.. && npx wrangler deploy -c wrangler.ops.jsonc
# 共享密钥（与 VPS 端 NW_OPS_PROXY_SECRET 同值；首次 + 轮换时执行；交互粘贴，不进 git）：
npx wrangler secret put ADMIN_PROXY_SECRET -c wrangler.ops.jsonc
```

> admin 后端入口若不在 `api.gamestao.com/ops`（如改用 cloudflared tunnel 或独立子域），改 `wrangler.ops.jsonc` 的 `ADMIN_ORIGIN` 后重 deploy。

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
npx wrangler secret put ADMIN_PROXY_SECRET -c wrangler.ops.jsonc   # 粘贴 Step0 的值
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

#### SSH 密钥（已生成，2026-06-24）

专用 ed25519 密钥，**仅用于连 Hetzner VPS**：

| 项 | 值 |
|---|---|
| 私钥（**保密，绝不进 git/聊天/截图**） | `C:\Users\TaoWang\.ssh\nivara_hetzner` |
| 公钥（可公开，贴 Hetzner SSH keys 框） | `C:\Users\TaoWang\.ssh\nivara_hetzner.pub` |
| 指纹 | `SHA256:I7/fC9iaEo7J5JaG3g3EdIachUGkFGc9JNDS/TF+aIc` |
| 密码短语 | 无（方便自动化；如需加：`ssh-keygen -p -f ~/.ssh/nivara_hetzner`） |

公钥串（开机前贴进 Hetzner）：
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOFe/cne++J7QxMMJWxtJbn+dhnesYbIcvPIYlRSyCZP nivara-hetzner-20260624
```

登录命令（`-i` 指定私钥）：
```bash
ssh -i ~/.ssh/nivara_hetzner root@<VPS_IP>
```
> 私钥丢失 = 重新生成并在 Hetzner 换公钥即可；私钥泄露 = 立即在 Console 删旧 key、换新 key。

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

## 9. 备注

- 特效（client 特效）与关卡编辑器前端**暂缓**，优先级低。
- 全球多区域演进见 `DEPLOY_TOPOLOGY.md`（ADR-019）：Meta 共享 + 对战层按区隔离。本文件是单区起步版，选 VPS 商时心里装着「以后每区复制一套 matchsvc/gameserver」。
- 备份：Atlas M0 自带快照；如需导出见 `server/deploy/backup-mongo.sh`（连接串改成 Atlas 即可）。
