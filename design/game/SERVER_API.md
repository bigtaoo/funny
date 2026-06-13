# Notebook Wars — 服务器协议 / API 契约

> 创建：2026-06-13。本文件是客户端 ↔ 服务器的**接口契约**：REST 端点 + WebSocket 消息 + 锁步时序。
> 双端实现以本文件为准（客户端 `NetClient`/`SaveStore`/`EconomyClient` 与 `server/` 各 service）。
> 配套：`META_DESIGN.md`（系统/架构）、`META_TASKS.md`（任务）、`ECONOMY_BALANCE.md`（数值）。
> 协议类型建议落在 `code/src/net/protocol.ts`，双端共用（见 `META_TASKS.md` C-2）。

---

## 0. 总览

| 通道 | 协议 | 服务 | 承载 |
|---|---|---|---|
| 账号 / 存档 / 经济 | **HTTPS REST**（JSON） | `api`（无状态，可横扩） | 一次性请求-响应：登录、存档同步、商店、盲盒、广告、IAP |
| 房间 / 锁步对战 | **WSS（WebSocket）** | `gateway`（有状态，房间亲和） | 长连接：建房 / 加入 / ready / 逐 tick 输入中继 / 重连 / 天梯结算 |

- 两服务可独立部署（`META_DESIGN.md §6.1`），共享 `@nw/shared`（协议类型 + JWT 校验 + Mongo client）。反代按 `/api/*`、`/ws` 分流。
- 服务器权威段（钱包 / 库存 / 盲盒 / IAP / **天梯**）只能经服务器改，**客户端永不直接写**（`META_DESIGN.md §2`）。
- 所有时间戳由服务器盖，客户端不可信。

---

## 1. 通用约定

### 1.1 鉴权
- 登录拿 `token`（JWT 或随机 token，存服务端会话），后续 REST 走 `Authorization: Bearer <token>`，WS 在握手 query 或首帧带 `token`。
- `accountId` 由服务端从 token 解出，**客户端请求体里不带 accountId**（防越权）。

### 1.2 统一响应包络
```ts
type ApiResp<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string } };
```

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

握手：`wss://host/ws?token=<token>`。连接后所有消息为 JSON：`{ t: <type>, ...payload }`。

### 3.1 客户端 → 服务器（`ClientMsg`）
| `t` | payload | 说明 |
|---|---|---|
| `room.create` | `{ mode: 'friendly'|'ranked' }` | 建房，返回房间码（friendly）；ranked 走匹配队列 |
| `room.join` | `{ code }` | 输码加入（friendly） |
| `room.ready` | `{ ready: boolean }` | 切换准备态 |
| `room.leave` | `{}` | 离开房间 |
| `room.start` | `{}` | 房主开局（双方 ready 后有效） |
| `input.submit` | `{ tick, commands: PlayerCommand[] }` | 提交某 tick 的本方指令（含空指令） |
| `match.result` | `{ stateHash }` | 对局结束上报最终状态 hash |
| `conn.resume` | `{ roomId }` | 重连，请求输入日志追帧 |
| `ping` | `{}` | 心跳 |

### 3.2 服务器 → 客户端（`ServerMsg`）
| `t` | payload | 说明 |
|---|---|---|
| `room.state` | `{ code, players: PlayerSlot[], phase }` | 房间状态变更广播 |
| `match.start` | `{ roomId, mode, seed, startTick, localSide }` | 开局：模式 + 种子 + 起始 tick + 本方阵营 |
| `input.frame` | `{ tick, inputs: { side, commands }[] }` | 某 tick 的**确认输入集**（双方齐后广播） |
| `conn.resync` | `{ seed, startTick, log: InputFrame[], curTick }` | 重连追帧：种子 + 全量输入日志 + 当前 tick |
| `peer.dc` | `{ side, graceMs: 60000 }` | 对手掉线，进入 60s 等待重连（M10） |
| `match.over` | `{ winnerSide, reason, mismatch?, elo?: { delta, after, rankAfter } }` | 结束；`reason: 'base'|'disconnect'|'mismatch'`；ranked 带 ELO 变化 |
| `room.error` | `{ code, message }` | 房间错误（不存在 / 已满） |
| `pong` | `{}` | 心跳回应 |

```ts
interface PlayerSlot { side: Side; name: string; ready: boolean; connected: boolean; }
type RoomPhase = 'waiting' | 'ready' | 'countdown' | 'in_match' | 'over';
interface InputFrame { tick: number; inputs: { side: Side; commands: PlayerCommand[] }[]; }
```

---

## 4. 锁步时序（lockstep）

```
房主 room.create → server room.state(code)
对手 room.join(code) → server room.state(双方)
双方 room.ready(true) → phase=ready
房主 room.start → server match.start{ seed, startTick }（双方一致）
                ↓
每个逻辑 tick T（TICK_RATE=30）：
  各端在 T 提交 input.submit{ tick: T + DELAY, commands }   // DELAY=2~3 tick 输入缓冲
  服务器收齐双方 tick=K 的 input → 广播 input.frame{ tick:K, inputs }
  客户端凑齐 tick=K 的全部 inputs 才推进 GameEngine 到 K     // 否则短暂等待（UI 显示"等待对手"）
对局结束：各端 match.result{ stateHash } → server 比对 → match.over{ winner, mismatch }
```

要点：
- **输入延迟缓冲**（DELAY 2~3 tick）：本地指令延后若干 tick 生效，给网络往返留窗口，避免每 tick 卡顿。
- 空 tick 也要提交（`commands: []`），否则服务器无法判定"齐了"。
- 确定性保证：同 `seed` + 同输入序列 → 双端逐 tick 一致（`META_DESIGN.md §6`）。
- **重连**：服务器留 `InputFrame[]` 日志；`conn.resume` → `conn.resync` 下发种子+日志，客户端从头重放追上 `curTick`。
- **断线规则（M10）**：in_match 一端掉线 → 向在线方发 `peer.dc{ graceMs:60000 }` → 起 **60s** 计时；期间掉线方 `conn.resume` 成功则续打；**超时则掉线方判负**，`match.over{ reason:'disconnect' }`。
- **结算**：`friendly` 仅写 `matches` 记结果；`ranked` 由 gateway 算 ELO 变化、写 `saves.pvp`（服务器权威），随 `match.over.elo` 下发。

---

## 5. 数据库集合（MongoDB，简表）

| 集合 | 文档 | 说明 |
|---|---|---|
| `saves` | `{ _id: accountId, save: SaveData, rev }` | 存档主表 |
| `accounts` | `{ _id: accountId, openid?, deviceId?, createdAt }` | 身份映射 |
| `gachaHistory` | `{ accountId, poolId, itemId, rarity, cost, rev, ts }` | 逐抽记录（M7） |
| `walletLog` | `{ accountId, delta, reason, balAfter, ts }` | 货币流水（审计 / 防刷） |
| `iapReceipts` | `{ _id: receiptId, accountId, granted, ts }` | 验单幂等 |
| `matches` | `{ roomId, mode, seed, players, winner, reason, hashOk, ts }` | 对局归档（friendly/ranked 都记） |

> 天梯积分存 `saves.pvp`（elo/rank/wins/losses/streak，服务器权威）；`gateway` 在 ranked 局末用单文档原子更新写入。

---

## 6. 已定 / 开放问题

**已定（2026-06-13）**：
- 断线：60s 等待重连，超时掉线方判负（M10）。
- match 类型：`friendly`（仅记结果）/ `ranked`（天梯 ELO，服务器权威）（M11）。
- token：无状态 **JWT**（服务端密钥签）。
- 拓扑：`api`/`gateway` 两服务可分（M9）；钱包用单文档原子更新避开多文档事务（`META_DESIGN.md §6.3`）。

**开放**：
- [ ] 锁步 DELAY 取值（2 vs 3 tick）需实测网络往返定。
- [ ] WS 是否需要二进制编码（初期 JSON 足够）。
- [ ] ranked 匹配队列算法（按 ELO 配对 + 等待放宽）与段位划分表（v1 先做 friendly，ranked 队列稍后）。
- [ ] ELO 公式参数（K 因子、初始分、段位阈值）。
