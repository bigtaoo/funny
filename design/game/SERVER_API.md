# Notebook Wars — 服务器协议 / API 契约

> 创建：2026-06-13。本文件是客户端 ↔ 服务器的**接口契约**：REST 端点 + WebSocket 消息 + 锁步时序。
> 双端实现以本文件为准（客户端 `NetClient`/`SaveStore`/`EconomyClient` 与 `server/` 各 service）。
> 配套：`META_DESIGN.md`（系统/架构）、`META_TASKS.md`（任务）、`ECONOMY_BALANCE.md`（数值）。
> 协议类型建议落在 `code/src/net/protocol.ts`，双端共用（见 `META_TASKS.md` C-2）。

---

## 0. 总览

| 通道 | 协议 | 服务 | 承载 |
|---|---|---|---|
| 账号 / 存档 / 经济 | **HTTPS REST（JSON）** | `api`（无状态，可横扩） | 一次性请求-响应：登录、存档同步、商店、盲盒、广告、IAP |
| 房间 / 锁步对战 | **WSS（protobuf 二进制）** | `gateway`（有状态，房间亲和） | 长连接：建房 / 加入 / ready / 逐 tick 输入中继 / 重连 / 天梯结算 |

> **线协议分层（M12）**：WS 用 protobuf（`transport.proto` = 控制层，服务器认得；`game.proto` = `PlayerCommand` 结构，仅客户端↔客户端）。服务器把 `PlayerCommand` 当 **`bytes` opaque 转发不解码** → 与游戏逻辑零依赖。REST 保持 JSON（低频、利于浏览器/支付回调/调试）。

- 两服务可独立部署（`META_DESIGN.md §6.1`），共享 `@nw/shared`（协议类型 + JWT 校验 + Mongo client）。反代按 `/api/*`、`/ws` 分流。
- 服务器权威段（钱包 / 库存 / 盲盒 / IAP / **天梯**）只能经服务器改，**客户端永不直接写**（`META_DESIGN.md §2`）。
- 所有时间戳由服务器盖，客户端不可信。

---

## 1. 通用约定

### 1.1 鉴权
- 登录拿**无状态 JWT**（服务端密钥签），后续 REST 走 `Authorization: Bearer <token>`，WS 在握手 query 或首帧带 `token`。
- `accountId` 由服务端从 token 解出，**客户端请求体里不带 accountId**（防越权）。

### 1.2 编码
- **REST = JSON**，统一响应包络：
  ```ts
  type ApiResp<T> =
    | { ok: true;  data: T }
    | { ok: false; error: { code: string; message: string } };
  ```
- **WS = protobuf**：每帧一个 `Envelope`（`oneof` 区分消息）。`.proto` 在 `proto/`，双端 codegen（`ts-proto`，无运行时依赖）。dev 模式加二进制帧解码打印便于调试。

### 1.3 错误码（节选）
| code | 含义 |
|---|---|
| `UNAUTHENTICATED` | token 缺失 / 失效 |
| `REV_CONFLICT` | 存档乐观锁冲突（带当前云端值） |
| `INSUFFICIENT_FUNDS` | 余额不足 |
| `DAILY_CAP_REACHED` | 当日广告上限 |
| `INVALID_RECEIPT` | IAP 验单失败 |
| `ROOM_NOT_FOUND` / `ROOM_FULL` | 房间不存在 / 已满 |
| `RATE_LIMITED` | 限流 |

### 1.4 乐观锁
- 存档与钱包变更携带 `rev`（单调递增）。服务器比对：不匹配返回 `REV_CONFLICT` + 当前权威值，客户端 pull-merge 后重试。

---

## 2. REST 端点

### 2.1 账号
```
POST /auth/wx        { code }                  → { token, accountId, isNew }
POST /auth/device    { deviceId }              → { token, accountId, isNew }
```
- 微信：`code` 由 `wx.login` 得，服务端换 openid → 映射 accountId。
- Web/CrazyGames：`deviceId` 为客户端持久化 UUID。

### 2.2 存档（save-service，`META_TASKS.md` S0-7）
```
GET  /save                                     → { save: SaveData }      // 当前账号
PUT  /save     (If-Match: <rev>)  { save }     → { save: SaveData }      // 成功回推规范化后的存档
                                                 | 409 REV_CONFLICT { save }  // 当前云端值
```
- PUT 只接受**客户端同步段**字段（progress / materials / pveUpgrades / equipped / flags）；服务器权威段被忽略（以服务端值为准回推）。

### 2.3 商店（economy-service，S2-2）
```
GET  /shop/items                               → { items: ShopItem[] }
POST /shop/buy        { itemId }               → { save: SaveData, granted: ItemId }
                                                 | INSUFFICIENT_FUNDS
```

### 2.4 盲盒（economy-service，S2-3）
```
GET  /gacha/pools                              → { pools: GachaPool[] }
POST /gacha/draw      { poolId, count: 1|10 }  → { save: SaveData, results: GachaResult[] }
                                                 | INSUFFICIENT_FUNDS
```
```ts
interface GachaResult {
  itemId: string; rarity: Rarity;
  duplicate: boolean; converted?: { kind: 'shards'|'coins'; amount: number };
}
```
- 服务端：校验余额 → `crypto` 真随机按 weight（+保底）→ 扣币 → 发货/转化 → 更新 pity → **写 `gachaHistory`** → 回推 save。
- gacha 随机**不进确定性回放**（`META_DESIGN.md §8`）。

### 2.5 广告奖励（economy-service，S2-4）
```
POST /ads/reward      { adToken }              → { save: SaveData, granted: number }
                                                 | DAILY_CAP_REACHED
```
- `adToken` 为平台激励广告回调凭证，服务端校验后加币；当日计数到 cap 拒发。

### 2.6 IAP 验单（iap-service，S4-1）
```
POST /iap/verify      { platform, receipt }    → { save: SaveData, granted: number }
                                                 | INVALID_RECEIPT
```
- 服务端向平台验单；票据幂等（重复提交不重复发币）。

---

## 3. WebSocket 协议（房间 + 锁步）

握手：`wss://host/ws?token=<token>`。连接后每帧一个 protobuf `Envelope`（`transport.proto`，`oneof case` 区分消息）。下表 `case` 列即 oneof 分支名。

> `commands` 字段类型是 **`bytes`**：客户端用 `game.proto` 编码 `PlayerCommand[]`，服务器**透传不解码**（M12）。

### 3.1 客户端 → 服务器（`ClientMsg` oneof）
| `case` | payload | 说明 |
|---|---|---|
| `room_create` | `{ mode: friendly|ranked }` | 建房，返回房间码（friendly）；ranked 走匹配队列 |
| `room_join` | `{ code }` | 输码加入（friendly） |
| `room_ready` | `{ ready: bool }` | 切换准备态 |
| `room_leave` | `{}` | 离开房间 |
| `room_start` | `{}` | 房主开局（双方 ready 后有效） |
| `cmd_submit` | `{ commands: bytes }` | **仅在出牌时发**（空闲零上行）；服务器塞进当前帧（M14） |
| `match_result` | `{ state_hash }` | 对局结束上报最终状态 hash |
| `conn_resume` | `{ room_id, last_frame }` | 重连，从 `last_frame` 之后补帧 |
| `ping` | `{}` | 心跳 |

### 3.2 服务器 → 客户端（`ServerMsg` oneof）
| `case` | payload | 说明 |
|---|---|---|
| `room_state` | `{ code, players: PlayerSlot[], phase }` | 房间状态变更广播 |
| `match_start` | `{ room_id, mode, seed, start_frame, local_side }` | 开局：模式 + 种子 + 起始帧 + 本方阵营 |
| `frame_tick` | `{ frame, cmds: SideCmd[] }` | **服务器节拍**：每 tick 一帧（M14）；`cmds` 空 ⇒ 帧里只有 `frame` 号 |
| `conn_resync` | `{ seed, start_frame, log: FrameTick[], cur_frame }` | 重连补帧：种子 + 非空帧日志 + 当前帧 |
| `peer_dc` | `{ side, grace_ms: 60000 }` | 对手掉线，进入 60s 等待重连（M10） |
| `match_over` | `{ winner_side, reason, mismatch?, elo?: { delta, after, rank_after } }` | 结束；`reason: base|disconnect|mismatch`；ranked 带 ELO 变化 |
| `room_error` | `{ code, message }` | 房间错误（不存在 / 已满） |
| `pong` | `{}` | 心跳回应 |

```proto
// transport.proto（节选；服务器认得这一层）
message PlayerSlot { uint32 side = 1; string name = 2; bool ready = 3; bool connected = 4; }
message SideCmd    { uint32 side = 1; bytes commands = 2; }   // commands 对服务器 opaque
message FrameTick  { uint32 frame = 1; repeated SideCmd cmds = 2; }  // cmds 空 ⇒ 仅 frame 号
enum RoomPhase { WAITING = 0; READY = 1; COUNTDOWN = 2; IN_MATCH = 3; OVER = 4; }
```

---

## 4. 服务器权威节拍器（M14）

**服务器持时钟、不等输入、按 tick 发帧；客户端是纯跟随者。** 帧号 = sim tick 号（30Hz，1 帧 = 33ms）。

```
房主 cmd → room_state(code) → 对手 room_join → 双方 room_ready → room_start
  → match_start{ seed, start_frame }（双方一致）
  ↓
服务器每 tick（30Hz）：递增 frame，广播 frame_tick{ frame, cmds }
  · 期间收到某端 cmd_submit → 塞进「当前正在发的帧」的 cmds（两端拿到同一帧同一指令）
  · 无指令 → cmds 为空，帧里只有 frame 号
  · 服务器永远领先客户端约 3 帧（≈100ms 缓冲）
客户端：缓存里有比当前更靠前的帧 → 推进 GameEngine；没有 → 暂停（可见）
对局结束：match_result{ stateHash } → 比对 → match_over{ winner, reason, elo? }
```

要点：
- **延时 = 物理 RTT + ~100ms**（3 帧客户端缓冲）。指令不预盖 LEAD，收到即塞当前帧；缓冲在客户端回放侧。
- **缓冲深度可配置**（默认 3 帧）：容忍 ~100ms 单程下行延迟/抖动。小抖动透明吸收；超出 → 该端短暂卡住再快进追帧（**对手不受影响**）；彻底掉线才触发暂停 + 60s。高 ping 玩家可自适应调大缓冲（延时随之增加）。
- **同帧多指令**：服务器是唯一排序者，需**确定性 tiebreak**（按 `side` 升序、再按到达序），否则两端应用顺序分歧 → 发散。
- **空闲零上行**：客户端只在出牌时发 `cmd_submit`；服务器的 `frame_tick` 流是唯一"可前进"信号（服务器停发 ⇒ 客户端暂停）。
- 确定性保证：同 `seed` + 同帧序列 → 双端逐 tick 一致（`META_DESIGN.md §6`）。
- **重连**：服务器留**非空帧**日志；`conn_resume{ last_frame }` → `conn_resync` 下发种子 + `last_frame` 之后的非空帧 + `cur_frame`，客户端快进追上。
- **断线规则（M10）**：in_match 一端掉线 → 服务器**停发该房间帧** + 向在线方 `peer_dc{ grace_ms:60000 }` → 起 **60s**；掉线方 `conn_resume` 成功则续发续打；**超时则掉线方判负** `match_over{ reason:'disconnect' }`。
- **结算**：`friendly` 仅写 `matches` 记结果；`ranked` 由 gateway 算 ELO、写 `saves.pvp`（服务器权威），随 `match_over.elo` 下发。

---

## 5. 数据库集合（MongoDB，简表）

| 集合 | 文档 | 说明 |
|---|---|---|
| `saves` | `{ _id: accountId, save: SaveData, rev }` | 存档主表 |
| `accounts` | `{ _id: accountId, openid?, deviceId?, createdAt }` | 身份映射 |
| `gachaHistory` | `{ accountId, poolId, itemId, rarity, cost, rev, ts }` | 逐抽记录（M7） |
| `walletLog` | `{ accountId, delta, reason, balAfter, ts }` | 货币流水（审计 / 防刷） |
| `iapReceipts` | `{ _id: receiptId, accountId, granted, ts }` | 验单幂等 |
| `matches` | `{ roomId, mode, seed, players, winner, reason, hashOk, replayRef, ts }` | 对局归档（friendly/ranked 都记）；`replayRef` 指向录像 |

> 天梯积分存 `saves.pvp`（elo/rank/wins/losses/streak，服务器权威）；`gateway` 在 ranked 局末用单文档原子更新写入。

---

## 6. 录像（replay，M13 / `META_DESIGN.md §6.6`）

统一输入管线让对局/关卡都可回放：**录像 = `seed` + 配置 + 输入流**，从不存状态。

```proto
// replay.proto —— 复用 transport.proto 的 FrameTick
message Replay {
  uint32 engine_version = 1;  // 回放前校验；跨引擎版本可能发散
  string mode = 2;            // campaign | pvp
  uint64 seed = 3;
  string config_ref = 4;      // PvE=levelId+version；PvP=rosterVer
  repeated FrameTick frames = 5;   // 只存非空帧；commands 仍是 protobuf bytes
  uint32 end_frame = 6;       // 总帧数（空帧不存，靠它界定终点）
  ReplayMeta meta = 7;
}
```

> **稀疏存储**：空帧（仅帧号）不写录像；回放时逐 tick 推进，遇到有对应 `frame` 的内容帧就应用、否则空推进，到 `end_frame` 结束。

- **PvP**：`gateway` 为重连保留的输入日志**即录像**，局末持久化到 `matches.replayRef`（小局直接内嵌，大局存对象存储），零额外采集成本。
- **PvE**：客户端本地录制（只记玩家指令；敌方 `WaveDirector` 回放时由 seed+level 重算），可选上传分享。
- 回放走 `ReplayInputSource`：同 seed 起新引擎，按 tick 喂 `frames` → 逐 tick 还原。

---

## 7. 已定 / 开放问题

**已定（2026-06-13）**：
- 断线：60s 等待重连，超时掉线方判负（M10）。
- match 类型：`friendly`（仅记结果）/ `ranked`（天梯 ELO，服务器权威）（M11）。
- token：无状态 **JWT**（服务端密钥签）。
- 拓扑：`api`/`gateway` 两服务可分（M9）；钱包用单文档原子更新避开多文档事务（`META_DESIGN.md §6.3`）。
- 线协议：**WS = protobuf**（`transport.proto`/`game.proto` 分层，`PlayerCommand` 对服务器 opaque），**REST = JSON**（M12）。
- 联机模型：**服务器权威节拍器**（M14）——30Hz 发帧、3 帧客户端缓冲（~100ms）、空闲零上行、服务器停发即暂停。

**开放**：
- [ ] 客户端缓冲深度（默认 3 帧 ~100ms）是否做成按 RTT 自适应。
- [ ] ranked 匹配队列算法（按 ELO 配对 + 等待放宽）与段位划分表（v1 先做 friendly，ranked 队列稍后）。
- [ ] ELO 公式参数（K 因子、初始分、段位阈值）。
- [ ] 录像分享/存储：PvE 本地录制先行，云端分享 + PvP 录像对象存储排期（v1 录制即可，分享后置）。
