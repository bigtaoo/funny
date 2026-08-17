# 部署 — 可观测性 + 测试环境 + 平台隔离（6b 起）

> 从 [`deploy-cloudflare.md`](deploy-cloudflare.md) 拆出（2026-08-17，原文件 557 行）。**小节编号沿用原文**，`deploy-cloudflare.md §N` 引用照旧有效。
> 本册内容：6b Loki/Grafana、7 平台隔离边界、8 测试环境快速部署、9 备注。总览与在先小节见 [`deploy-cloudflare.md`](deploy-cloudflare.md)。

---

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

**自动发布**：`.github/workflows/grafana-deploy.yml`——push 改动落在 `server/observability/**` 时自动 SSH 进 VPS `reset --hard + up -d --force-recreate`（预构建镜像，无 build；与 server-deploy 解耦，互不触发）。复用同套 `VPS_SSH_KEY`/`VPS_HOST`；开关 `OBS_DEPLOY_ENABLED=true`（首次需先在 VPS 手动建 `observability/.env`），可选 `OBS_TUNNEL_ENABLED=true` 才带 cloudflared。`server-deploy.yml` 已 `!server/observability/**` 排除该子树，避免为日志配置白白 rebuild 后端。

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
2. **充值币按支付渠道隔离**：站外渠道（Paddle/Stripe）购买的虚拟货币不得在微信/苹果内消费（违反平台条款）。微信线本就完全独立部署（独立库，见上表），跨渠道混用无从发生；真正的暴露窗口是 **iOS/Android 原生 IAP 与 web(Paddle) 共享同一套全局部署 + 同一个 `wallets` 集合**（DEPLOY_TOPOLOGY「西方大区」Meta 层单实例托管）。**已实现（2026-07-27）**：`wallets.coins` 保留为免费池（广告/胜场/兑换码/退款等非充值来源，处处可花），新增按渠道标记的充值池 `wallets.recharged:{web,apple,google}`（渠道来自 `RechargeDoc.platform` 映射），花费侧新增按「请求平台」（客户端 `X-NW-Platform` 头）门控——任一花费请求只能动用「免费池 + 请求平台对应的渠道桶」，先扣免费池、免费池不够再扣渠道桶。否决了"原生渠道也照搬微信独立部署"的方案：会牺牲已支持的跨端同账号游玩能力，且改造范围本身比预想小（花费侧只有两处原子扣款，充值侧只有三处真实付费入口）。机制细节 + 取舍记录见 [`game/COMMERCIAL_DESIGN.md §11`](../game/COMMERCIAL_DESIGN_IAP.md#11-钱包按支付渠道隔离adr-0202026-07-27)。当前 `recharged.apple`/`.google` 在生产恒为 0（ASC 的 7 个 IAP 商品尚未建，见 IOS_RELEASE.md）——机制已就绪，等真实原生 IAP 上线即自动生效，无需再改。

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

`.github/workflows/server-deploy.yml`：CI 在 `main` 上跑绿、且该 commit 改动落在 `server/**`（`server/observability/**` 除外，那部分走 grafana-deploy）/ 该 workflow 时，自动 SSH 进 VPS 跑 `git fetch + reset --hard origin/main → docker compose -f docker-compose.cloud.yml --env-file .env up -d --build → docker compose restart caddy`；也可在 Actions 页手动 Run（`workflow_dispatch`，跳过 CI 门禁）。触发方式见 client-deploy 小节的 2026-08-12 改动说明。与 client-deploy / ops-deploy 同理念（裸 ssh，不用第三方 action，报错原样可见）。

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
