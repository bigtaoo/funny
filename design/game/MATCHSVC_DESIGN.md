# Notebook Wars — matchsvc 匹配服务设计

> 创建：2026-06-14。本文件设计 **matchsvc（私有匹配大脑）** + 配套的 **gameserver 瘦身** 与 **game→meta 局末结算**，并锚定整个 S1-M 拆分的迁移顺序。
> 配套：`META_DESIGN.md`（§1.1/§6.1 决策 M16–M21 拓扑）、`GATEWAY_DESIGN.md`（控制面网关，matchsvc 的公开门面）、`SERVER_API.md`（§8 内部契约 / §3 数据面 WS）、`META_TASKS.md`（S1-M1~M4）。
> 状态：**设计稿，未实现**。现状是 gameserver 中心式（自管匹配/房间/ELO/归档且连 Mongo），本文是迁移目标。

---

## 0. TL;DR

- **matchsvc = 玩家不可达的私有大脑，永远单点**：匹配队列 + 房间状态 + game 注册表/分配 + 签 ticket。
- **不连 Mongo**：匹配要的 `elo` 由 gateway 入队时向 meta 取一次带入（matchsvc 只认这个数）。
- 所有玩家操作经 **gateway** 转发进来；game 向它注册上报负载；配对/房间事件异步**回调 gateway** 推给玩家。
- 配套两件事一并在本文设计（同属「私有大脑 + 数据面 + 结算」闭环）：
  - **gameserver 瘦身**（M16）：去库、改 ticket 握手、向 matchsvc 注册、瘦成纯帧中继。
  - **game→meta 局末上报**（M19）：ELO 结算 / 归档 / 录像存储从 gameserver 移到 meta。

> gateway 自身设计（控制面 WS 协议、`account→socket`、取 ELO、客户端三通道）见 **`GATEWAY_DESIGN.md`**。

---

## 1. 迁移前后职责对照（S1-M 全景）

| 能力 | 迁移前（现状 gameserver） | 迁移后 | 归属文档 |
|---|---|---|---|
| WS 鉴权握手 | gameserver `?token=jwt` | 房间/匹配 → gateway `?token=jwt`；锁步 → gameserver `?ticket=` | gateway / 本文 |
| 房间建/加入/ready/start | `RoomManager`（gameserver） | **matchsvc** 内存房间（gateway 转发） | 本文 §2 |
| ranked 匹配队列 | `Matchmaking.ts`（gameserver） | **matchsvc**（搬过去） | 本文 §2 |
| 房间码 / RoomRegistry | gameserver | **matchsvc** | 本文 §2 |
| 签 ticket | 无 | **matchsvc**（M18） | 本文 §4 |
| 锁步节拍器/中继/帧日志/重连 | gameserver `Room` | **gameserver**（保留，瘦成纯中继） | 本文 §5 |
| ELO 结算 / 写 saves.pvp | gameserver `settleRanked/applyPvp` | **meta**（收 game 上报后算） | 本文 §6 |
| 对局归档 matches / 录像 | gameserver `archive` | **meta** | 本文 §6 |
| 读 saves.pvp.elo（入队） | gameserver 连 Mongo 读 | **gateway → meta `/internal/elo`** | gateway |
| 房间/匹配消息通道 | gameserver WS | **gateway 控制面 WS** | gateway |

---

## 2. matchsvc 设计

### 2.1 职责

- 匹配队列（ranked，全区单实例，搬 `Matchmaking.ts`：ELO 升序贪心 + 等待放宽窗口 `base100+50/s`）。
- 房间状态机（friendly + ranked **共用一套内存房间**：code / players / phase）。
- game 注册表：哪些 gameserver 在线、各自负载/容量。
- 配对/分配后**签 ticket**（每玩家一张，含 `game_url`，§4）。
- **不连任何库**：匹配需要的 `elo` 由 gateway 在 `enqueue` 时带入。

### 2.2 内部端点（仅 gateway 调 / game 注册，内部密钥 `X-Internal-Key`）

> 同 `SERVER_API.md §8.1`。matchsvc 不暴露公网。

```
# gateway → matchsvc（玩家操作转发）
POST /mm/enqueue      { accountId, name, elo }       → { ok }
POST /mm/cancel       { accountId }                  → { ok }
POST /mm/room/create  { accountId, name }            → { roomCode, state }
POST /mm/room/join    { accountId, name, roomCode }  → { state } | ROOM_NOT_FOUND|ROOM_FULL
POST /mm/room/ready   { accountId, ready }           → { state }
POST /mm/room/start   { accountId }                  → { tickets: Ticket[] }
POST /mm/room/leave   { accountId }                  → { ok }

# game → matchsvc（启动注册 + 心跳）
POST /mm/game/register  { gameId, wsUrl, capacity }  → { ok }
POST /mm/game/heartbeat { gameId, load, rooms }      → { ok }
```

### 2.3 异步事件回调 gateway

配对成功 / 房间态变更是**异步**的（不在某个同步请求里）。matchsvc 不直接连玩家 → **回调 gateway**：

```
matchsvc → gateway: POST /gw/push { accountId, msg }   # gateway 据 account→socket 推给玩家
  msg ∈ room_state | match_found{game_url,ticket} | mm_status | room_error
```

> 前期 gateway+matchsvc 合一进程时，这步是**进程内函数调用**，不走 HTTP。拆进程后才变 RPC（接口抽象不变）。

### 2.4 ticket（M18）

```ts
interface Ticket {
  room_id: string;
  seed: number;            // 双方同 seed
  side: 0 | 1;
  opponent: string;
  game_url: string;        // 分配到的 gameserver WS 地址
  mode: 'friendly' | 'ranked';
  exp: number;             // 过期时间戳（默认开局后 30s 内须连上 game）
  sig: string;             // HMAC(内部密钥, 上述字段)
}
```

matchsvc 配对/分配后给每玩家签一张，经 gateway 推给客户端。game 收两张 ticket → **验签 + 交叉核对 room_id/seed 一致** → 开局，不查任何库。

---

## 3. 房间分配逻辑（friendly 与 ranked 共用）

- friendly：`room/create` 生成 6 位无歧义房间码（去 `0O1IL`）存内存房间；`room/join` 输码入房；双方 ready → `room/start`（房主）→ 从 game 注册表挑一台空闲 game → 签两张 ticket。
- ranked：`enqueue` 进队，matchsvc `tick` 邻近配对成功 → 直接挑 game 签 ticket（无 ready/房主，等价现 `beginRanked`）。
- game 分配：按注册表 `load/capacity` 挑负载最低且健康的实例，把其 `wsUrl` 写进 ticket 的 `game_url`——**两条 WS（gateway 控制面 + game 数据面）凭同一 ticket 落同一 game 实例**，天然房间亲和，无需一致性哈希。

---

## 4. gameserver 瘦身（M16，S1-M2）

**删除**：
- `Matchmaking.ts`、`settleRanked`/`applyPvp`、`archive`/matches 归档、读 `saves.pvp`、房间阶段消息（create/join/ready/start/state）。
- Mongo client 依赖（**bundle 内无 mongodb**）。

**握手改 `?ticket=<签名票据>`**：验签 + 交叉核对两张 ticket → 起房间帧中继。

**保留**：
- `Room` 节拍器（30Hz sim / 10Hz 批 3 帧）、`cmd_submit` 装配、非空帧日志、重连 `conn_resume→conn_resync`、60s 宽限（M14/M10）。
- 局末打包上报 meta（§5）。

**验收**：gameserver bundle 无 Mongo client；断网 Mongo 仍能跑完整局中继（上报排队等 meta 恢复）。

---

## 5. game→meta 局末上报（M19，S1-M3）

gameserver 局末把 `{room_id, seed, mode, 双方 hash, 双方 winner_side, 非空帧录像}` **POST meta `/internal/match/report`**（内部密钥、`room_id` 幂等、失败重试/排队）。

meta 收后：**比对 hash + winner_side**（一致才认；不一致 `mismatch` 作废）→ `ranked` 算 ELO 写 `saves.pvp`（乐观锁）→ 写 `matches` 归档 → 存录像。即把现 gameserver `endMatch/settleRanked/archive` 逻辑搬到 meta。

```
POST /internal/match/report
  { room_id, seed, mode, results:[{side, state_hash, winner_side}×2], replay: bytes }
  → { ok }                       # 幂等键 room_id，重发不重复结算
```

> `GET /internal/elo`（供 gateway 入队取分）属 gateway 链路，契约见 `SERVER_API.md §8.5` + `GATEWAY_DESIGN.md`。

---

## 6. 迁移顺序与风险（S1-M 全景，gateway 同此表）

> **有损改动**（动联机链路），建议在 commercial/account 之后、独立分阶段做，每阶段保持端到端可跑。

| 阶段 | 内容 | 主文档 | 风险 |
|---|---|---|---|
| S1-M1 | 起 gateway+matchsvc 合一进程：搬 Matchmaking + 房间 + game 注册 + 签 ticket + 控制面 WS | 本文 + gateway | 房间逻辑搬家，需端到端回归 friendly+ranked |
| S1-M2 | gameserver 瘦身去库 + 改 ticket 握手 | 本文 §4 | 握手协议变，新旧不兼容，需同步改客户端 |
| S1-M3 | game→meta 上报 + meta 写 ELO/归档；移走 gameserver 结算 | 本文 §5 | ELO 权威方变更，需验证 ranked 结算等价 |
| S1-M4 | 客户端拆 gateway/game 双连接 + RoomScene 适配 + proto 重生 | gateway | 客户端联机入口大改 |

**回滚位**：每阶段 `tsc -b` + 双客户端端到端实测（建房/加入/ready/开局/出牌同帧/hash/断线重连/ranked ELO），任一不过停在该阶段。

---

## 7. 开放问题（matchsvc 侧）

- [ ] **内部密钥体系**：gateway↔matchsvc↔game↔meta↔commercial 共用一把 `NW_INTERNAL_KEY`，还是按服务对分别签？（默认：前期共用一把）
- [ ] **gateway+matchsvc 合一**时内部 RPC 走进程内调用还是 localhost HTTP（便于将来拆）？（默认：进程内函数调用 + 接口抽象，拆时换实现）
- [ ] **ticket 过期**窗口多长（match_found 到连 game 的容忍时间）？（默认：30s）
- [ ] 这部分要不要等 commercial/account 完成后再做？（建议最后做，动联机链路最大）
