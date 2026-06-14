# Notebook Wars — gateway 控制面网关设计

> 创建：2026-06-14。本文件设计 **gateway（WS 控制面网关，玩家公开门面）** + 配套的 **客户端三通道适配**。
> 配套：`META_DESIGN.md`（§1.1/§6.1 决策 M16–M21 拓扑）、`MATCHSVC_DESIGN.md`（私有匹配大脑，gateway 是其门面）、`SERVER_API.md`（§8.4 控制面 WS / §8.5 取 ELO）、`META_TASKS.md`（S1-M1、S1-M4）。
> 状态：**设计稿，未实现**。现状是 gameserver 中心式（房间/匹配消息走 game WS），本文是迁移目标。

---

## 0. TL;DR

- **gateway = 薄连接层，玩家公开门面**：鉴权长连接 + `account→socket` 映射 + 房间/匹配消息转发 matchsvc + 事件回推（含 match_found+ticket）+ 在线状态。
- **不连库**：入队前向 meta 取一次 ELO（`GET /internal/elo`）带进 matchsvc；自身无持久数据。
- 是 **matchsvc 的公开门面**——matchsvc 因此对玩家不可达。
- **部署粒度**：前期 gateway+matchsvc 合一进程（对外只暴露 gateway 公开 WS），连接数撑不住再拆两进程 + Redis 路由。

> matchsvc 自身（匹配队列/房间/ticket/game 注册）、gameserver 瘦身、meta 局末结算见 **`MATCHSVC_DESIGN.md`**。

---

## 1. 职责（薄连接层）

- WS 握手 `?token=<jwt>`（复用 meta 的 JWT，解出 accountId 绑定连接）。
- 维护 `account → socket` 映射（同账号新连顶替旧连，沿用现有顶替逻辑）。
- 把客户端控制面消息转发 matchsvc；把 matchsvc 回调事件（`/gw/push`）推回对应 socket。
- 入队前向 meta 取 ELO（`GET /internal/elo`，M17），带进 `/mm/enqueue`——让 matchsvc 保持 DB-free。
- 在线状态 / （将来）好友 / 通知 / 聊天的承载连接。
- **它不做匹配、不存房间、不签 ticket**——这些都在 matchsvc，gateway 只转发与推送。

---

## 2. 控制面 WS 协议（M20，玩家公开，`SERVER_API.md §8.4`）

```
握手：wss://host/gw?token=<jwt>

客户端 → gateway：
  mm_enqueue {} | mm_cancel {} | room_create {} | room_join {code}
  | room_ready {ready} | room_start {} | room_leave {}

gateway → 客户端：
  room_state {code, players, phase}
  | match_found {game_url, ticket}        # 收到即去连 game 数据面 WS
  | mm_status {state:'searching'|'idle', waited_ms?}
  | room_error {code, message}
  | presence {...}                        # 在线状态（后期）
```

> 这套消息现在跑在 gameserver 的 `transport.proto` WS 上（RoomCreate/RoomJoin/RoomReady/RoomStart/RoomLeave/RoomState/RoomError + match_start）。迁移 = 把它们从 game WS **挪到 gateway WS**；锁步消息（CmdSubmit/FrameBatch/ConnResume/ConnResync/PeerDc/MatchOver/Ping）留 game WS（`SERVER_API.md §3`）。`match_start` → `match_found`（带 ticket）。

---

## 3. 取 ELO（M17，让 matchsvc 保持 DB-free）

```
GET /internal/elo?accountId=<id>  (内部密钥)   → { elo }
```

- gateway 在 `mm_enqueue` 时调用，把 `elo` 带进 `/mm/enqueue`；matchsvc 因此无需连 Mongo。
- 也可在握手后预取并缓存（elo 变化频率低）；ranked 局末 meta 写新 elo 后可经控制面推 `presence`/刷新。

---

## 4. 部署粒度（M20）

- **前期**：gateway + matchsvc = 一个进程两模块；对外只暴露 gateway 公开 WS（`/gw`），matchsvc 内部 RPC 不绑公网。内部调用为进程内函数（接口抽象，便于将来拆）。
- **后期**：gateway 连接数撑不住 → 拆两进程 + Redis 做 `account→gateway 实例` 路由；matchsvc 仍单点。
- 反代：`/gw`→gateway(WS)；`/ws`→gameserver(WS)；`/api/*`→meta(REST)；matchsvc/commercial 不暴露公网。

---

## 5. 客户端三通道适配（M20，S1-M4）

现状 `NetSession` 把房间 + 锁步绑在**一条** game WS（`NetClient`）上。拆成两条：

```
NetSession
  ├── gatewayConn（控制面 WS /gw?token）  ── 房间/匹配 mm_*/room_*，收 match_found
  └── gameConn（数据面 WS /ws?ticket）    ── 锁步 cmd_submit/frame_batch（收到 match_found 后才连）
```

- `RoomScene` 的 create/join/ready/start/ranked 改走 gatewayConn。
- 收 `match_found{game_url, ticket}` → 用 ticket 连 gameConn → 收 `match_start`/`frame_batch` → 进 GameScene。
- 重连：控制面与数据面**各自独立重连**（gateway 重连续房间会话；game 重连走 `conn_resume`）。
- auth/save/economy 仍走 meta REST，不变。
- proto 调整：`transport.proto` 拆为「gateway 控制面消息」与「game 数据面消息」两组（或两个 `.proto`）；`MatchStart` → `match_found`（带 ticket）。`npm run proto:gen` 双端重生。

**验收**：玩家全程只连 meta(REST)+gateway(WS)+game(WS)，触达不到 matchsvc；大厅房间事件实时刷新无需轮询。

---

## 6. 迁移阶段（gateway 相关，全景见 `MATCHSVC_DESIGN.md §6`）

| 阶段 | gateway 侧内容 | 风险 |
|---|---|---|
| S1-M1 | gateway 控制面 WS（`?token=` 握手 + `account→socket` + `mm_*`/`room_*` 转发 + `room_state`/`match_found` 回推）+ 取 ELO | 房间消息通道搬家 |
| S1-M4 | 客户端 `NetSession` 拆 gateway/game 双连接 + RoomScene 适配 + proto 重生 | 客户端联机入口大改 |

---

## 7. 开放问题（gateway 侧）

- [ ] gateway 重连续房间会话的协议（控制面是否需要类似 game 的 `conn_resume`，把玩家拉回原房间态）？（默认：重连后 gateway 据 accountId 重发当前 `room_state`）
- [ ] `presence`/好友/聊天首期是否上，还是只留协议位？（默认：只留位，先做房间/匹配）
- [ ] 内部 RPC（gateway↔matchsvc）合一进程时进程内调用 vs localhost HTTP？（与 matchsvc 开放问题同条，默认进程内）
