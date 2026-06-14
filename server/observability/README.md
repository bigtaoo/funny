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

## Phase 2（后期）：Loki + Grafana

Grafana 本身不存日志——标准栈是 **Loki**（存储）+ **采集器**（tail 文件）+ **Grafana**（查询）。
因为日志已是 JSON 行，Loki 可零成本按 `svc` / `level` 建标签。

推荐 **Grafana Alloy**（新一代采集器，取代 Promtail）tail `server/logs/*.log`。最小本地栈：

```yaml
# server/observability/docker-compose.obs.yml（待建，示意）
services:
  loki:
    image: grafana/loki:3.x
    command: -config.file=/etc/loki/local-config.yaml
    ports: ["3100:3100"]
  alloy:
    image: grafana/alloy:latest
    volumes:
      - ../logs:/var/log/nw:ro          # tail 上面的 JSON 文件
      - ./alloy-config.alloy:/etc/alloy/config.alloy:ro
    command: run /etc/alloy/config.alloy
  grafana:
    image: grafana/grafana:11.x
    ports: ["3000:3000"]                # 加 Loki 数据源后在此查询
```

Alloy 抓取片段（`loki.source.file` → `loki.process` 解 JSON → `loki.write`）：

```alloy
loki.source.file "nw" {
  targets    = [{ __path__ = "/var/log/nw/*.log" }]
  forward_to = [loki.process.nw.receiver]
}
loki.process "nw" {
  stage.json { expressions = { level = "level", svc = "svc", t = "t" } }
  stage.labels { values = { level = "", svc = "" } }
  stage.timestamp { source = "t"  format = "RFC3339" }
  forward_to = [loki.write.default.receiver]
}
loki.write "default" { endpoint { url = "http://loki:3100/loki/api/v1/push" } }
```

Grafana 里典型 LogQL：`{svc="matchsvc"} | json | level="error"`。

### 跨进程关联（correlation id，已落地）

一局对战横跨多个进程。用 **`roomId`** 作 correlation id 贯穿 gateway→matchsvc→game→meta：

- matchsvc：建房/加入/开局/match starting 等日志均带 `roomId`；
- matchsvc→gateway 的 `/gw/push` 内部请求体携带 `roomId`（仅用于日志，不进客户端可见的 PushMsg），
  gateway 的 `push -> room_state|match_found` 行据此打印 `roomId`；
- game：握手/join 日志带 `roomId`（取自 ticket）；
- meta：`POST /internal/match/report` 带 `room_id`。

Grafana 接上 Loki 后即可 `{} | json | roomId="<id>"` 把整局拉成一条时间线。

> 注：gateway 的**入站**命令（room_create / enqueue）在房间创建前没有 `roomId`，按 `accountId`
> 关联——同一 accountId 的 `recv room_create` → matchsvc `recv /mm/room/create` → `room created roomId=…`
> 即可桥接到 roomId。

### 生产（Docker）路径

容器日志走 stdout（控制台 sink），无需文件；Alloy 用 `loki.source.docker` 直接抓 Docker 日志，
或保留 `NW_LOG_DIR` 挂卷走文件。两条都行——文件路线与 dev 完全一致，最省心。

> 待办：本目录补 `docker-compose.obs.yml` + `alloy-config.alloy` + Loki/Grafana 配置，
> 一条命令起观测栈。本期只保证日志「文件就绪、JSON 可解析」。
