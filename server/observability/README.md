# 服务端日志与可观测性

## 当前策略（Phase 1，已落地）

所有五个进程（meta / gateway / matchsvc / game / commercial）经 `@nw/shared` 的
`createLogger(service)` 输出，**双 sink**：

- **控制台**：可读单行 `12:03:45.678 INFO [gateway] msg key=val`，开发时直接看进程窗口。
- **文件**：每条一行 JSON，**仅当 `NW_LOG_DIR` 环境变量设置时启用**，按根服务名分文件
  `${NW_LOG_DIR}/<service>.log`（`gateway` / `gateway:internal` / `gateway:matchsvc` 同写 `gateway.log`）。

```jsonc
{"t":"2026-06-14T15:57:10.555Z","level":"info","svc":"gateway","msg":"WS connected","accountId":"abc","online":1}
```

字段：`t`（ISO8601）、`level`、`svc`（含子标签）、`msg`，其余为该条的结构化 data。

### 启用

- **dev（`npm run dev:all` / `dev-up.ps1`）**：脚本已自动把 `NW_LOG_DIR` 设为 `server/logs`，
  每个进程写 `server/logs/<service>.log`（`*.log` 已被 .gitignore，不入库）。
- **pm2 / Docker**：进程 stdout 本就被各自的 runner 持久化（`~/.pm2/logs/*`、Docker `json-file`）；
  如需额外 JSON 文件，给容器/进程注入 `NW_LOG_DIR` 即可。
- **级别**：`NW_LOG_LEVEL=debug|info|warn|error`（缺省 `debug`）。

### 排查口诀（匹配链路一条龙）

一局 ranked 跨 gateway → matchsvc → game → meta。按时间线 grep：

```bash
# 谁连上了 gateway / 是否被「同账号顶替」（两标签页共用 device id 的典型坑）
grep -E "WS connected|replacing existing" server/logs/gateway.log
# 入队 / 配对 / 开局 / GAME_UNAVAILABLE
grep -E "enqueue|pair matched|match starting|GAME_UNAVAILABLE" server/logs/matchsvc.log
# 跨服务 HTTP 失败（之前被静默吞掉）
grep -i "failed\|non-OK" server/logs/*.log
```

## Phase 2（已落地）：Loki + Alloy + Grafana + cloudflared

Grafana 本身不存日志——标准栈是 **Loki**（存储）+ **采集器**（Alloy）+ **Grafana**（查询）。
本栈已建在本目录，与主栈（`docker-compose.cloud.yml`）**解耦、独立起停**：

| 文件 | 作用 |
|---|---|
| `docker-compose.obs.yml` | 4 个容器：loki / alloy / grafana / cloudflared |
| `loki/config.yml` | Loki 单进程 + 本地存储，保留 14 天 |
| `alloy/config.alloy` | Alloy 经 docker socket 抓所有容器 stdout，解析 svc/level 标签 |
| `grafana/provisioning/` | 自动注册 Loki 数据源 + 加载仪表盘（开箱即用） |
| `grafana/dashboards/server-logs.json` | 起手仪表盘「服务端日志」（按 svc/level/关键字过滤 + 错误数 + 速率） |
| `.env.example` | Grafana 密码 / CF 隧道令牌（复制为 `.env`） |

### 采集方式：抓 docker stdout（不用文件卷）

**没有走 Phase 1 的 JSON 文件路线**，而是让 Alloy 直接经 docker socket 抓**所有容器的 stdout**
（`loki.source.docker`）。理由：

- **零侵入**：无需给 9 个业务进程设 `NW_LOG_DIR`、无需挂日志卷、无需改主栈 compose。
- **`docker logs` 照旧可读**：SSH 上 `docker compose logs -f metaserver` 仍是人类可读单行。
- **轮转交给 docker**：配 `/etc/docker/daemon.json` 的 `log-opts max-size` 即可（见下），
  不像文件路线那样无限增长、要额外上 logrotate。

代价：标签来自正则解析可读单行（`15:57 INFO [gateway] msg …`），而非整精度 JSON。
Alloy 用正则提 `svc`（根服务名，冒号前）/ `level` 作标签；行内 `key=val`（含 `roomId`）
**不进标签**（高基数会撑爆 Loki），查询时用 `| logfmt` 现解。时间戳用 docker 的整精度时间。

### Phase 2 部署（VPS，一次性）

**Step 0 — 限制 docker 日志体积**（防 stdout 撑爆 40G 盘；所有容器生效）：
```bash
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
EOF
systemctl restart docker
# 重启 docker 会重建容器，主栈随之重起；确认全栈 Up：
cd /root/funny/server && docker compose -f docker-compose.cloud.yml --env-file .env up -d
```

**Step 1 — 配 obs `.env`**：
```bash
cd /root/funny/server/observability
cp .env.example .env
# 填 GF_ADMIN_PASSWORD=$(openssl rand -hex 16)；CF_TUNNEL_TOKEN 在 Step 3 拿到后回填
```

**Step 2 — 起观测栈**（在 `server/` 目录下；默认不含 cloudflared，零停机即可看日志）：
```bash
cd /root/funny/server
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d
# 此时 loki/alloy/grafana 已起。先 SSH 隧道看：ssh -L 3000:localhost:3000 → http://localhost:3000
```

**Step 3 — Cloudflare Tunnel + Access**（控制台，约 5 分钟，同 ops 的「走 Cloudflare」选择）：
1. dash.cloudflare.com → **Zero Trust → Networks → Tunnels → Create a tunnel**（Cloudflared 类型）。
   命名如 `nivara-grafana` → **复制 Tunnel token**（`eyJ...` 长串）填进 `observability/.env` 的
   `CF_TUNNEL_TOKEN`，然后带起隧道（`--profile tunnel` 才启用 cloudflared）：
   ```bash
   docker compose -f observability/docker-compose.obs.yml --env-file observability/.env --profile tunnel up -d
   ```
2. 同隧道页 **Public Hostnames → Add**：subdomain `grafana`、domain `gamestao.com`、
   Service `HTTP` → `grafana:3000`（cloudflared 与 grafana 同 compose 网络，按服务名解析）。
   保存后 CF 自动建好 `grafana.gamestao.com` 的 DNS（橙云）+ 边缘证书。
3. **Zero Trust → Access → Applications → Add → Self-hosted**：
   - Name `grafana`，Public hostname `grafana.gamestao.com`（path 留空 = 罩整站）。
   - Add policy：Action **Allow** → Include → **Emails** 列授权邮箱（如 `tao.wang@elk.de`）。
   登录方式复用 ops 已配的 One-time PIN 即可。

**Step 4 — 验证**：浏览器开 `https://grafana.gamestao.com` → CF Access 邮箱验证码 →
Grafana 登录页（admin / `.env` 里的密码）→ 左栏「Dashboards → Notebook Wars → 服务端日志」即见实时日志。

> **SSH 兜底（不配 CF 也能看）**：Grafana 绑了 `127.0.0.1:3000`。本机跑
> `ssh -i ~/.ssh/nivara_hetzner -L 3000:localhost:3000 root@128.140.41.98`，浏览器开
> `http://localhost:3000`。此时可把 `cloudflared` 服务注释掉、`CF_TUNNEL_TOKEN` 留空。

### Grafana 里查日志（LogQL 速查）

```logql
{svc="matchsvc"}                         # 某服务全部日志
{svc=~"gateway|matchsvc", level="error"} # 多服务 + 仅错误
{svc="matchsvc"} |= "GAME_UNAVAILABLE"   # 子串过滤
{} | logfmt | roomId="<id>"              # 一局对战横跨多进程拉成时间线（见下「跨进程关联」）
{service="nw-caddy"}                      # 非业务容器按 compose 服务名/容器名过滤
```

仪表盘「服务端日志」顶部有 `服务 / 级别 / 关键字` 三个下拉/输入框，免手敲 LogQL。

### 存活心跳（heartbeat，已落地）

8 个业务进程启动即调 `@nw/shared` 的 `startHeartbeat(log)`（`shared/src/heartbeat.ts`）：**空闲时也每
5 分钟打一条 `info` 级 `heartbeat` 日志**（带 `uptimeSec` / `rssMb`），作为「进程还活着 + 采集链路还通」
的正向信号。即便没有玩家、没有业务日志，Grafana 里也能看到每个 svc 在按节奏跳。

```logql
{svc="meta"} |= "heartbeat"                                  # 看某服务的心跳
sum by (svc) (count_over_time({svc=~".+"} |= "heartbeat" [5m]))  # 各服务心跳数(应≥1,断=可能挂了)
```

仪表盘顶部「**服务存活**」面板就是上面这条：每个 svc 一条线，掉到 0 或断开即该进程没在打心跳。
心跳是 `info` 级，故生产即便 `NW_LOG_LEVEL=info` 也不会被过滤掉。间隔/字段可在 `startHeartbeat` 调。

### 跨进程关联（correlation id，已落地）

一局对战横跨多个进程。用 **`roomId`** 作 correlation id 贯穿 gateway→matchsvc→game→meta：

- matchsvc：建房/加入/开局/match starting 等日志均带 `roomId`；
- matchsvc→gateway 的 `/gw/push` 内部请求体携带 `roomId`（仅用于日志，不进客户端可见的 PushMsg），
  gateway 的 `push -> room_state|match_found` 行据此打印 `roomId`；
- game：握手/join 日志带 `roomId`（取自 ticket）；
- meta：`POST /internal/match/report` 带 `room_id`。

Grafana 接上 Loki 后即可 `{} | logfmt | roomId="<id>"` 把整局拉成一条时间线
（`logfmt` 现解可读单行尾部的 `key=val`；若日后切回 JSON 文件路线则用 `| json`）。

> 注：gateway 的**入站**命令（room_create / enqueue）在房间创建前没有 `roomId`，按 `accountId`
> 关联——同一 accountId 的 `recv room_create` → matchsvc `recv /mm/room/create` → `room created roomId=…`
> 即可桥接到 roomId。

### 运维速查

```bash
cd /root/funny/server
# 起 / 停 / 看观测栈自身日志
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d
docker compose -f observability/docker-compose.obs.yml down
docker compose -f observability/docker-compose.obs.yml logs -f alloy   # 采集器没在抓时先看这里
# 改了 alloy/loki 配置后重载
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d --force-recreate alloy loki
```

> **若日后想要整精度 JSON 标签**（而非正则解析可读单行）：给主栈各业务进程设
> `NW_LOG_DIR=/var/log/nw` + 挂共享卷，logger 会写 JSON 文件（见 Phase 1），再把
> `alloy/config.alloy` 换成 `loki.source.file` + `stage.json` 路线。当前 docker-socket
> 路线已够用，且无文件增长问题，非必要不切。
