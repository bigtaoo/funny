# Notebook Wars — 服务器协议 / API 契约

> 创建：2026-06-13。本文件是客户端 ↔ 服务器的**接口契约**：REST 端点 + WebSocket 消息 + 锁步时序。
> 双端实现以本文件为准（客户端 `NetClient`/`SaveStore`/`EconomyClient` 与 `server/` 各 service）。
> 配套：`META_DESIGN.md`（系统/架构）、`META_TASKS.md`（任务）、`ECONOMY_BALANCE.md`（数值）。
> 契约单一来源在 `server/contracts/`（`openapi.yml` + `transport.proto`/`game.proto`），双端 codegen（见 `META_TASKS.md` C-2）。

---

## 0. 总览

> **架构修订（2026-06-13，`META_DESIGN.md §1.1/§6.1`）**：**5 组件 + 三面分离**。玩家只触达 **meta(REST，请求面)** + **gateway(WS，控制面)** + **game(WS，数据面)**；**matchsvc** 是玩家不可达的私有大脑（gateway 当其门面 / game 注册）。**房间/匹配/在线/通知等开局前操作走 gateway WS（双向实时）**，不再走 REST；**开局走 matchsvc 签名 ticket（经 gateway 推）**、**结算 game→meta 上报**（M16–M20）。S1 现实现是 gameserver 中心式（开局操作走 game WS、gameserver 自管匹配/结算），按本修订迁移。内部契约见 §8。

| 通道（面） | 协议 | 服务 | 承载 |
|---|---|---|---|
| 账号 / 存档 / 经济（请求面） | **HTTPS REST（JSON）** | `metaserver`（无状态，可横扩） | 登录、存档同步、商店、盲盒、广告、IAP（纯请求-响应） |
| 房间 / 匹配 / 在线 / 通知（控制面） | **WSS（双向实时）** | `gateway`（有状态连接层，M20） | 常驻连接：开始/取消匹配、friendly 建房/加入/ready/start、match-found+ticket 下发、在线状态、（将来）聊天 |
| 锁步对战（数据面） | **WSS（protobuf 二进制）** | `gameserver`（无状态哑中继，永不连库 M16） | 每局新建：ticket 握手 → 逐 tick 输入中继 / 重连 / 局末上报 meta |
| **内部：匹配 + 分配** | 内部 RPC（gateway↔matchsvc）+ game 注册 | `matchsvc`（单点，玩家不可达 M17） | 匹配队列、房间状态、game 注册表/分配、签 ticket（§8.1） |
| **内部：结算上报** | 内部 HTTP（game→meta，幂等） | game→`metaserver` | 局末录像 + hash + winner 上报，meta 判定/写库（§8.3） |

> **线协议分层（M12）**：WS 用 protobuf（`transport.proto` = 控制层，服务器认得；`game.proto` = `PlayerCommand` 结构，仅客户端↔客户端）。服务器把 `PlayerCommand` 当 **`bytes` opaque 转发不解码** → 与游戏逻辑零依赖。REST 保持 JSON（低频、利于浏览器/支付回调/调试）。

- 各服务可独立部署（`META_DESIGN.md §6.1`），共享 `@nw/shared`（协议类型 + JWT 校验 + Mongo client）。反代按 `/api/*`(meta)、`/gw`(gateway)、`/ws`(game) 分流；matchsvc 不暴露公网。gateway+matchsvc 前期合一进程（M20）。
- 服务器权威段（钱包 / 库存 / 盲盒 / IAP / **天梯**）只能经服务器改，**客户端永不直接写**（`META_DESIGN.md §2`）。
- 所有时间戳由服务器盖，客户端不可信。

---

## 1. 通用约定

### 1.1 鉴权
- 登录拿**无状态 JWT**（服务端密钥签），后续 REST 走 `Authorization: Bearer <token>`，WS 在握手 query 或首帧带 `token`。
- `accountId` 由服务端从 token 解出，**客户端请求体里不带 accountId**（防越权）。

### 1.2 编码（契约单一来源 + 双端 codegen）
- **REST = JSON / `openapi.yml`（design-first，M15）**：`contracts/openapi.yml` 是机器契约单一来源；codegen metaserver 路由+校验（如 `fastify-openapi-glue`）与客户端 typed fetch（`openapi-typescript` + `openapi-fetch`）。统一响应包络：
  ```ts
  type ApiResp<T> =
    | { ok: true;  data: T }
    | { ok: false; error: { code: string; message: string } };
  ```
  > 本文 §2 的端点表是 `openapi.yml` 的人类可读摘要；以 `openapi.yml` 为准。
- **WS = protobuf**：每帧一个 `Envelope`（`oneof` 区分消息）。`.proto` 在 `contracts/`，双端 codegen（`ts-proto`，无运行时依赖）。dev 模式加二进制帧解码打印便于调试。

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
POST /auth/wx        { code }                  → AuthResult
POST /auth/device    { deviceId }              → AuthResult
# 账号系统扩展（SA，见 ACCOUNT_DESIGN.md §3）
POST /auth/register  { loginId, password, displayName? }  → AuthResult | LOGIN_ID_TAKEN
POST /auth/login     { loginId, password }                → AuthResult | INVALID_CREDENTIALS
POST /auth/oauth     { provider, code, redirectUri }      → AuthResult | OAUTH_FAILED
POST /auth/bind      (JWT) { method, ...credential }      → { ok, isAnonymous } | ALREADY_BOUND | LOGIN_ID_TAKEN
POST /auth/password/change (JWT) { oldPassword, newPassword } → { ok }
# AuthResult = { token, accountId, isNew, isAnonymous }
```
- 微信：`code` 由 `wx.login` 得，服务端换 openid → 映射 accountId。
- Web/CrazyGames：`deviceId` 为客户端持久化 UUID（匿名 `isAnonymous=true`）。
- 密码哈希存储（**实现用 Node 内置 `crypto.scrypt`**，零依赖跨平台，串 `scrypt$N$r$p$salt$hash`）；OAuth 走授权码流（`state` 防 CSRF）；`bind` 把新凭证挂当前 accountId（升级转正，不丢档/钱包）。详见 `ACCOUNT_DESIGN.md`。
- **实现状态（2026-06-14）**：`/auth/register`·`/auth/login`·`/auth/password/change` + `AuthResult.isAnonymous` **已落地**（SA-1，`isAnonymous` 计算得出不落库）；`/auth/oauth`·`/auth/bind` **待做**（SA-2，错误码已预留）。`/auth/password/reset`（找回密码，需邮件服务）后置。

### 2.2 存档（save-service，`META_TASKS.md` S0-7）
```
GET  /save                                     → { save: SaveData }      // 当前账号
PUT  /save     (If-Match: <rev>)  { save }     → { save: SaveData }      // 成功回推规范化后的存档
                                                 | 409 REV_CONFLICT { save }  // 当前云端值
```
- PUT 只接受**客户端同步段**字段（progress / materials / pveUpgrades / equipped / flags）；服务器权威段被忽略（以服务端值为准回推）。

> **修订（2026-06-14，M21）**：§2.3~2.6 的经济端点**对客户端不变**（仍是 meta 的公开 REST），但服务端实现改为 **meta 编排 → 内部调 commercial 服务**（钱包/扣币/RNG/充值在 commercial 独立库，物品由 meta 发货）。`save.wallet/gacha` 降级为只读镜像。内部契约见 **§9**；流程见 `COMMERCIAL_DESIGN.md §6`。

### 2.3 商店（meta 编排 → commercial，S2-2 / S5-3）
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

> **修订（2026-06-13）**：本节是 **game 数据面 WS**。握手改为 `?ticket=<jwt>`（matchsvc 签，§8.2），game 验签即开局。下表 `room_create/room_join/room_ready/room_leave/room_start` 等**开局前操作迁到 gateway 控制面 WS**（§8.4），game WS 只保留 `cmd_submit`/`frame_batch`/`conn_resume`/`conn_resync`/`peer_dc`/`match_over`/`ping` 这些锁步+重连消息。`match_result` 改为 game→meta 内部上报（§8.3），不再走 WS。以下为 S1 现实现，按修订迁移。

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
| `frame_batch` | `{ to_frame, frames: FrameCmds[] }` | **服务器节拍**：每 100ms 一个批次（覆盖 3 个 sim 帧，M14）；`frames` 仅列非空帧，空窗 ⇒ 只有 `to_frame` 水位 |
| `conn_resync` | `{ seed, start_frame, log: FrameCmds[], cur_frame }` | 重连补帧：种子 + 非空帧日志 + 当前帧 |
| `peer_dc` | `{ side, grace_ms: 60000 }` | 对手掉线，进入 60s 等待重连（M10） |
| `match_over` | `{ winner_side, reason, mismatch?, elo?: { delta, after, rank_after } }` | 结束；`reason: base|disconnect|mismatch`；ranked 带 ELO 变化 |
| `room_error` | `{ code, message }` | 房间错误（不存在 / 已满） |
| `pong` | `{}` | 心跳回应 |

```proto
// transport.proto（节选；服务器认得这一层）
message PlayerSlot { uint32 side = 1; string name = 2; bool ready = 3; bool connected = 4; }
message SideCmd    { uint32 side = 1; bytes commands = 2; }   // commands 对服务器 opaque
message FrameCmds  { uint32 frame = 1; repeated SideCmd cmds = 2; }   // 单个 sim 帧的指令
message FrameBatch { uint32 to_frame = 1; repeated FrameCmds frames = 2; } // 10Hz；frames 仅非空帧
enum RoomPhase { WAITING = 0; READY = 1; COUNTDOWN = 2; IN_MATCH = 3; OVER = 4; }
```

---

## 4. 服务器权威节拍器（M14）

**模拟 30Hz；服务器持时钟、不等输入、每 100ms 打包 3 帧下发；客户端是纯跟随者。** 模拟帧 = sim tick（33ms）；网络包 = 10Hz 批次（3 帧）。

```
房主 cmd → room_state(code) → 对手 room_join → 双方 room_ready → room_start
  → match_start{ seed, start_frame }（双方一致）
  ↓
服务器每 100ms（10Hz）：下发 frame_batch{ to_frame, frames }（覆盖 3 个 sim 帧）
  · 期间收到某端 cmd_submit → 塞进「当前 100ms 窗口对应的帧」（两端拿到同帧同指令）
  · 无指令 → frames 为空，批次里只有 to_frame 水位
  · 客户端缓存 ~1 批次（3 帧 ≈100ms）
客户端：to_frame 比当前靠前 → 按 30Hz 播完这 3 帧；没有下一批次 → 暂停（可见）
对局结束：match_result{ stateHash } → 比对 → match_over{ winner, reason, elo? }
```

要点：
- **延时 = 物理 RTT + ~100ms**（1 批次缓冲）。指令不预盖 LEAD，收到即塞当前帧；缓冲在客户端回放侧。
- **缓冲深度可配置**（默认 1 批次 = 3 帧）：容忍 ~100ms 单程下行延迟/抖动。小抖动透明吸收；超出 → 该端短暂卡住再快进追帧（**对手不受影响**）；彻底掉线才触发暂停 + 60s。高 ping 玩家可自适应调大缓冲（延时随之增加）。
- **同帧多指令**：服务器是唯一排序者，需**确定性 tiebreak**（按 `side` 升序、再按到达序），否则两端应用顺序分歧 → 发散。
- **空闲零上行**：客户端只在出牌时发 `cmd_submit`；服务器的 `frame_batch` 流是唯一"可前进"信号（服务器停发 ⇒ 客户端暂停）。
- 渲染平滑：每批 3 帧，客户端按真实时间把它们摊到 100ms 消费 + 渲染插值 → 连续 30fps。
- 确定性保证：同 `seed` + 同帧序列 → 双端逐 tick 一致（`META_DESIGN.md §6`）。
- **重连**：服务器留**非空帧**日志；`conn_resume{ last_frame }` → `conn_resync` 下发种子 + `last_frame` 之后的非空帧 + `cur_frame`，客户端快进追上。
- **断线规则（M10）**：in_match 一端掉线 → 服务器**停发该房间帧** + 向在线方 `peer_dc{ grace_ms:60000 }` → 起 **60s**；掉线方 `conn_resume` 成功则续发续打；**超时则掉线方判负** `match_over{ reason:'disconnect' }`。
- **结算（修订 M19）**：局末 game 把 `{hash×2, winner_side×2, 非空帧录像}` POST 给 **meta**（§8.3）；`friendly` meta 仅写 `matches`；`ranked` **meta** 算 ELO、写 `saves.pvp`（服务器权威）→ 把 `match_over.elo{delta,after,rank_after}` 经 game 转发给客户端。game 不连库、不判定。S1 现实现为 gameserver 直算直写，待迁移。
- **ranked 匹配 / ELO（S1-R 已落地）**：
  - 入队：`room_create{mode:ranked}` → 服务器读 `saves.pvp.elo` 入匹配队列（需 Mongo，否则 `RANKED_UNAVAILABLE`）；按 ELO 邻近配对，等待越久可接受分差越宽（初值 `base 100 + 50/s`）；配对即建房直接开局（无 ready/房主环节）。`room_leave`（不在房内）= 取消匹配。
  - 胜负判定（**无服务器裁判**，S1-J 未做）：`match_result{ state_hash, winner_side }` 双方齐 → **hash 与 winner_side 均一致才认**该胜方、结算 ELO；任一不一致 → 作废（`mismatch`，不动 ELO）。掉线/认输 → 服务器权威判对手胜并结算。防一端谎报刷分。
  - ELO：K=32 标准公式、零和、分不为负；段位 9 段（`shared/ladder.ts` 与客户端展示同源，阈值见 `ECONOMY_BALANCE.md §2.3`）；`saves.pvp` 经单文档原子更新（rev 守卫 + 重试，整体替换 save，避免与 `PUT /save` 互覆盖）写 `elo/rank/wins/losses/streak`。

---

## 5. 数据库集合（MongoDB，简表）

| 集合 | 文档 | 说明 |
|---|---|---|
| `saves` | `{ _id: accountId, save: SaveData, rev }` | 存档主表 |
| `accounts` | `{ _id: accountId, openid?, deviceId?, createdAt }` | 身份映射 |
| `gachaHistory` | `{ accountId, poolId, itemId, rarity, cost, rev, ts }` | 逐抽记录（M7） |
| `walletLog` | `{ accountId, delta, reason, balAfter, ts }` | 货币流水（审计 / 防刷） |
| `iapReceipts` | `{ _id: receiptId, accountId, granted, ts }` | 验单幂等 |
| `matches` | `{ roomId, mode, seed, players, winner, reason, hashOk, replay?, replayRef?, ts }` | 对局归档（friendly/ranked 都记）；`replay` 内嵌录像（小局，非空帧日志零成本内嵌，`cmds[].commands` 为 BSON binary opaque）；`replayRef` 指向外部存储（大局，待办） |

> 天梯积分存 `saves.pvp`（elo/rank/wins/losses/streak，服务器权威）；`gameserver` 在 ranked 局末用单文档原子更新写入。

---

## 6. 录像（replay，M13 / `META_DESIGN.md §6.6`）

统一输入管线让对局/关卡都可回放：**录像 = `seed` + 配置 + 输入流**，从不存状态。

```proto
// replay.proto —— 复用 transport.proto 的 FrameCmds
message Replay {
  uint32 engine_version = 1;  // 回放前校验；跨引擎版本可能发散
  string mode = 2;            // campaign | pvp
  uint64 seed = 3;
  string config_ref = 4;      // PvE=levelId+version；PvP=rosterVer
  repeated FrameCmds frames = 5;   // 只存非空帧；commands 仍是 protobuf bytes
  uint32 end_frame = 6;       // 总帧数（空帧不存，靠它界定终点）
  ReplayMeta meta = 7;
}
```

> **稀疏存储**：空帧（仅帧号）不写录像；回放时逐 tick 推进，遇到有对应 `frame` 的内容帧就应用、否则空推进，到 `end_frame` 结束。

- **PvP**：`gameserver` 为重连保留的非空帧日志**即录像**，局末零成本持久化——小局直接内嵌 `matches.replay`（`engineVersion=0`，服务器逻辑无关、客户端回放自校验；`cmds[].commands` 为 BSON binary opaque），大局转对象存储 `matches.replayRef`（待办）。
- **PvE**：客户端本地录制（只记玩家指令；敌方 `WaveDirector` 回放时由 seed+level 重算），可选上传分享。
- 回放走 `ReplayInputSource`：同 seed 起新引擎，按 tick 喂 `frames` → 逐 tick 还原。

---

## 7. 已定 / 开放问题

**已定（2026-06-13）**：
- 断线：60s 等待重连，超时掉线方判负（M10）。
- match 类型：`friendly`（仅记结果）/ `ranked`（天梯 ELO，服务器权威）（M11）。
- token：无状态 **JWT**（服务端密钥签）。
- 拓扑：`metaserver`/`gameserver` 两服务可分（M9）；钱包用单文档原子更新避开多文档事务（`META_DESIGN.md §6.3`）。
- 线协议：**WS = protobuf**（`transport.proto`/`game.proto` 分层，`PlayerCommand` 对服务器 opaque），**REST = JSON**（M12）。
- 联机模型：**服务器权威节拍器**（M14）——模拟 30Hz，**网络 10Hz 批次（每 100ms 打包 3 帧）**、1 批次客户端缓冲（~100ms）、空闲零上行、服务器停发即暂停。

**开放**：
- [ ] 客户端缓冲深度（默认 1 批次 ~100ms）是否做成按 RTT 自适应。
- [x] ranked 匹配队列算法（按 ELO 配对 + 等待放宽）与段位划分表 → S1-R 已落地（`Matchmaking.ts` + `ladder.ts` 9 段）。
- [x] ELO 公式参数（K=32 / 初始 1000 / 9 段阈值见 `ladder.ts`）→ DRAFT 初值已定，上线前可热调。
- [ ] ranked 匹配队列**多实例**共享（当前内存单实例；横扩需 Redis 队列 + 跨实例房间路由）。
- [ ] ranked 分段差异化胜利金币（`ECONOMY_BALANCE.md §2.3b`）：依赖经济服务 S2，gameserver 局末加 wallet 增量（带每日上限）。
- [ ] 录像分享/存储：PvE 本地录制先行，云端分享 + PvP 录像对象存储排期（v1 录制即可，分享后置）。
- [x] **开局前房间事件的推送通道** → 定为**独立 WS 控制面网关 gateway**（M20，§8.4）：房间/匹配/在线/通知走 gateway 双向实时 WS，meta 保持纯 REST 无状态。

---

## 8. 内部服务契约（修订 2026-06-13，玩家不可见；`META_DESIGN.md §1.1/§6.1`）

> 服务间内部边界。全部走**内部密钥**鉴权（gateway/matchsvc/game 共用一把签名密钥；服务间 HTTP 另带内部 bearer）。这些端点**永不暴露公网**。

### 8.1 matchsvc（单点，M17）— 仅 gateway 调它 / game 注册它

**gateway → matchsvc**（玩家操作由 gateway 转发，玩家永不直连 matchsvc）：
```
POST /mm/enqueue   { accountId, name, elo }      → { ok }                 // 开始 ranked 匹配（elo 由 gateway 向 meta 取后带入）
POST /mm/cancel    { accountId }                 → { ok }                 // 取消匹配 / 离队
POST /mm/room/create { accountId, name }         → { roomCode, state }    // friendly 建房（matchsvc 内存建房）
POST /mm/room/join   { accountId, name, roomCode }→ { state } | ROOM_NOT_FOUND|ROOM_FULL
POST /mm/room/ready  { accountId, ready }        → { state }
POST /mm/room/start  { accountId }               → { tickets: Ticket[] }  // 房主开局：分配 game + 签双方 ticket
POST /mm/room/leave  { accountId }               → { ok }                 // 离开房间 / 取消匹配
```
- **房间分配统一在 matchsvc**：friendly 与 ranked 共用同一套内存房间 + game 分配逻辑（开局前房间「只是一份内存数据」）。
- **matchsvc 不连 Mongo**：匹配要的 `elo` 由 gateway 在 enqueue 前向 meta 取一次（§8.5）带入；matchsvc 只认这个数。
- 异步事件（配对成功 / 房间态变更 / 对手 ready / match-found+ticket）由 matchsvc **回调 gateway**（同进程内直接调，拆进程后走内部 RPC/Redis）→ gateway 推给玩家。
- matchsvc 配对/分配后才接触 game 池；**Redis 仅崩溃副本**（队列 + 房间快照），前期可不接，内存即够。

**game → matchsvc**（启动注册 + 心跳）：
```
POST /mm/game/register  { gameId, wsUrl, capacity } → { ok }    // game 启动时注册可达地址
POST /mm/game/heartbeat { gameId, load, rooms }     → { ok }    // 周期上报负载，matchsvc 据此分配
```
> matchsvc 是「谁有空闲 game」唯一知情者；meta/玩家都不需要知道 game 拓扑。

### 8.2 match ticket（M18，matchsvc 签，game 验）

```ts
interface Ticket {            // matchsvc 用内部密钥签为 JWT；客户端不可篡改，game 只验签
  room_id: string;
  seed: number;               // 双方 ticket 同 seed（确定性内核的唯一种子）
  side: 0 | 1;                // 本方阵营（→ match_start.local_side）
  opponent: string;           // 对手展示名
  game_url: string;           // 分配到的 gameserver WS 地址（天然房间亲和，§6.5）
  mode: 'friendly' | 'ranked';
  exp: number;                // 过期时间戳
}
```
- 客户端拿 `{ game_url, ticket }` → 连 `wss://<game_url>/ws?ticket=<jwt>`。
- game **只验签 + 交叉核对两张 ticket 的 `room_id`/`seed` 一致**即开局，不查任何库、不存房间密码表。开局阶段 game 不依赖 meta/matchsvc 在线。
- `match_start` 的 `seed`/`local_side`/`mode` 直接取自 ticket。

### 8.3 game → meta 局末上报（M19，幂等）

```
POST /internal/match/report  (内部密钥)
  {
    room_id, seed, mode,
    results: [ { side, state_hash, winner_side }, { side, state_hash, winner_side } ],
    replay: bytes               // 非空帧日志（replay.proto，opaque；engineVersion=0）
  }
  → { ok }                      // 幂等键 = room_id；重发不重复结算
```
- meta 收后：**比对 hash + winner_side**（一致才认；不一致 `mismatch` 作废，ranked 不动 ELO）→ `ranked` 算 ELO 写 `saves.pvp`（单文档原子更新）→ 写 `matches`（内嵌 `replay` / 大局转 `replayRef`）。
- **friendly 正常结束** `winner_side` 由客户端模拟权威决定（meta 不复算，归档 `winner` 可记 -1 或采信一致上报）；**掉线/认输**由 game 直接判对手胜并在上报里标明，meta 据此结算。
- meta 暂不可用 → game 端**排队重试**（M16 的隔离收益：进行中的对局与结果上报都不依赖 meta 实时在线）。

### 8.4 gateway 控制面 WS（M20，玩家公开门面）

握手：`wss://host/gw?token=<jwt>`（同 REST 的 JWT；gateway 解出 accountId 绑定连接）。常驻整局会话期。JSON 或 protobuf 均可（控制面低频，建议沿用 JSON 便于调试）。

**客户端 → gateway**（gateway 转发 matchsvc，§8.1）：
| msg | payload | 说明 |
|---|---|---|
| `mm_enqueue` | `{}` | 开始 ranked 匹配（gateway 取 elo 后投 matchsvc） |
| `mm_cancel` | `{}` | 取消匹配 |
| `room_create` | `{}` | friendly 建房 |
| `room_join` | `{ code }` | 输码加入 |
| `room_ready` | `{ ready }` | 切换准备 |
| `room_start` | `{}` | 房主开局 |
| `room_leave` | `{}` | 离开房间 / 退队 |

**gateway → 客户端**（matchsvc 事件回推）：
| msg | payload | 说明 |
|---|---|---|
| `room_state` | `{ code, players:[{side,name,ready,connected}], phase }` | 房间态变更广播（好友加入/ready 等都走这条） |
| `match_found` | `{ game_url, ticket }` | 配对/开局成功，下发连 game 的连接信息（M18）；客户端据此连数据面 WS |
| `mm_status` | `{ state:'searching'|'idle', waited_ms? }` | 匹配队列状态 |
| `room_error` | `{ code, message }` | `ROOM_NOT_FOUND`/`ROOM_FULL`/`RANKED_UNAVAILABLE` 等 |
| `presence` | `{ ... }` | 在线状态/通知（预留，好友系统用） |

> `room_state`/`match_found` 的语义与 S1 现实现里 gameserver WS 的 `room_state`/`match_start` 等价，只是**搬到 gateway 控制面**；game 数据面 WS（§3）不再承载房间阶段消息。

### 8.5 gateway → meta 取 ELO（M17，matchsvc 保持 DB-free）

```
GET /internal/elo?accountId=<id>  (内部密钥)   → { elo }
```
- gateway 在 `mm_enqueue` 时调用，把 `elo` 带进 `/mm/enqueue`；matchsvc 因此无需连 Mongo。
- 也可在 gateway WS 握手后预取并缓存（elo 变化频率低）；ranked 局末 meta 写新 elo 后可经控制面推 `presence`/刷新。

---

## 9. commercial 内部契约（M21，meta → commercial）

> 修订（2026-06-14）：钱包/充值/消费/盲盒迁到独立 **commercial 服务**（连专属库 `notebook_wars_commercial`，玩家不可达）。**meta 是唯一调用方**——§2.3~2.6 的公开端点收到请求后，经下列内部 RPC（JSON + `X-Internal-Key: <NW_INTERNAL_KEY>`）调 commercial 完成扣币/随机/记账，再据结果写 inventory（meta 库）+ 钱包镜像回推。设计与流程见 `COMMERCIAL_DESIGN.md`。

```
GET  /internal/wallet?accountId=<id>           → { coins, pity:{poolId:count} }
POST /internal/shop/charge
     { accountId, itemId, cost, orderId }       → { ok, orderId, coinsAfter, status } | INSUFFICIENT_FUNDS | ALREADY_PROCESSED
POST /internal/gacha/draw
     { accountId, poolId, count:1|10, orderId } → { ok, orderId, coinsAfter, pityAfter, results:[{itemId,rarity,dupeConverted?}] } | INSUFFICIENT_FUNDS | ALREADY_PROCESSED
POST /internal/order/delivered  { orderId }     → { ok }
POST /internal/recharge/verify
     { accountId, platform, receipt, receiptId }→ { ok, coinsAfter, coinsGranted } | INVALID_RECEIPT | ALREADY_PROCESSED
POST /internal/ads/credit  { accountId, amount, dayKey } → { ok, coinsAfter }
```

- **幂等**：消费用 meta 生成的 `orderId`，充值用平台 `receiptId`；重放返回原结果不重扣/不重发。
- **一致性**：扣币（commercial）+ 发货（meta）是 saga——meta 据回执发货后调 `/internal/order/delivered` 闭环；崩溃则下次 `GET /save` 拉未发货订单补发（幂等）。详见 `COMMERCIAL_DESIGN.md §6`。
- **库迁移**：`gachaHistory`/`walletLog`/`iapReceipts` 从 meta 库（`shared/src/mongo.ts`）移除，在 commercial 库重建为 `gachaHistory`/`ledger`/`recharges`（+ `wallets`/`orders`）。
