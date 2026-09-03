# 服务器契约 — 开放问题 + 内部服务契约（§7 起）

> 从 [`SERVER_API.md`](SERVER_API.md) 拆出（2026-08-17，原文件 693 行）。**小节编号沿用原文**，`SERVER_API.md §N` 引用照旧有效。
> 本册内容：§7 已定/开放问题、§8 内部服务契约、§9 commercial、§10 worldsvc、§11 analyticsvc。总览与在先小节见 [`SERVER_API.md`](SERVER_API.md)。

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

> 服务间内部边界。全部走**内部密钥**鉴权（gateway/matchsvc/game/meta 共用一把 `NW_INTERNAL_KEY`，签 ticket + 服务间 HTTP `X-Internal-Key`）。这些端点**永不暴露公网**。
>
> **实现状态（2026-06-14，S1-M1~M5 已落地）**：matchsvc(§8.1/8.2) 自 **S1-M5 起为独立进程** `server/matchsvc`（不再在 gateway 内）；gateway↔matchsvc 走内部 HTTP（gateway `MatchsvcClient` → matchsvc `src/internalHttp.ts`；matchsvc `GatewayClient` → gateway `src/internalHttp.ts` 的 `/gw/push`），game 注册/心跳直指 matchsvc。game→meta 上报(§8.3) = `server/gameserver/src/metaReport.ts` → `server/metaserver/src/internal.ts`；gateway 控制面 WS(§8.4) = `server/gateway/src/Gateway.ts`（复用 `transport.proto` 子集，`match_found` 新增）；取 ELO(§8.5) = `MetaClient`。**差异**：§8.3 `match/report` 响应在 ranked 下额外回 `{ elo: {side:{delta,after,rankAfter}} }`，game 转进 `match_over.elo`；ranked 入队复用 `room_create{mode:RANKED}`（未单设 `mm_enqueue` 线消息），取消用 `room_leave`；**实现端点路径与形态**：enqueue=`/mm/queue/enqueue`、连接生命周期=`/mm/conn/{connected,disconnected}`，且所有控制命令为 **fire-and-forget**（返回 `{ok}`，房间态/ticket 经 `/gw/push` 异步推回，不在 HTTP 响应里），下方 §8.1 列出的 `{state}`/`{tickets}` 同步返回为早期设计，以实现为准。服务间通信选型见 `META_DESIGN §6.7`。

### 8.0 内部认证模型（S12-1，2026-06-21，`@nw/shared/internalAuth.ts`）

内部端口（commercial / matchsvc / gateway 内部面 / meta `/internal/*` / analyticsvc `/internal/query`）**玩家不可达**，三道纵深防御：

1. **网络隔离（第一道，最重要）**：内部 HTTP 端口**不绑公网、不经反代暴露**——`docker-compose.local/prod` 内仅 docker 内网可达，`client/nginx.conf` 只反代 `/api /gw /ws /world /sect /nation /social /auction /analytics` 公网面（订正 2026-07-07：`/family` 已并入 `/social`(socialsvc)、`/auction` 走 auctionsvc）。生产部署须保证内部端口（matchsvc 8091 / commercial 18082 / admin 8083 / analyticsvc 18085 / gateway 内部面）防火墙隔离，**玩家根本到不了**。`X-Internal-Key` 是第二道，不是唯一一道。

2. **玩家 / 服务密钥命名空间分离（不变量）**：内部路由**从不校验玩家 JWT**——只认 `X-Internal-Key`。玩家 JWT（`NW_JWT_SECRET` 签）与内部密钥（`NW_INTERNAL_KEY`/`NW_INTERNAL_KEYS`）天然不同命名空间，玩家把 JWT 放 `Authorization` 头也命不中 `X-Internal-Key` → **结构性 401**。admin 后台另用第三套 `NW_ADMIN_JWT_SECRET`，与玩家 JWT 严格隔离（§2.10 / OPS_DESIGN）。回归测试见 `metaserver/test/internal.test.ts`。

3. **集中校验器（`createInternalAuth`）**：所有被调方收口为一个校验器，提供 timing-safe 比对 + 命中调用方识别（审计日志带 `caller`）+ **可选 per-caller 密钥**：
   - **默认（单一共享密钥回退）**：只配 `NW_INTERNAL_KEY` → 所有调用方共用一把（行为同旧版，零变更）。
   - **进阶（per-caller 严格）**：配 `NW_INTERNAL_KEYS=gateway=k1,meta=k2,...`（`caller=key` 列表）→ 每个调用方一把独立密钥；身份由密钥本身证明（`x-internal-caller` 头仅审计提示，不可信），泄露**局部化**、可**按服务轮换**、可识别。严格模式下旧的单一共享密钥**不再被接受**，迁移须同时给所有进程配 `NW_INTERNAL_KEYS`。
   - 调用方统一经 `internalHeaders(caller, NW_INTERNAL_KEY)` 出站：自动按 `caller` 从注册表取专属密钥（无注册表则回退共享密钥）+ 附 `x-internal-caller`。

> **与 ticket HMAC 解耦**：match ticket（§8.2，matchsvc 签 / gameserver 验）**永远只用 `NW_INTERNAL_KEY`**（双方须同一把），不走 per-caller 注册表。`NW_INTERNAL_KEYS` 仅作用于内部 HTTP 鉴权。
>
> **登记的调用方**（`InternalCaller`）：gateway / gameserver / matchsvc / meta / commercial / worldsvc / admin / analyticsvc / socialsvc / auctionsvc（订正 2026-07-07：补 socialsvc + auctionsvc，以 `internalAuth.ts` 为准）。新增进程在 `internalAuth.ts` 登记并在 `NW_INTERNAL_KEYS` 给一把密钥。

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
- 异步事件（配对成功 / 房间态变更 / 对手 ready / match-found+ticket）由 matchsvc **POST `/gw/push` 回 gateway**（内部 HTTP，M22；多 gateway 时改 Redis pub/sub）→ gateway 据 `account→socket` 推给玩家。
- matchsvc 配对/分配后才接触 game 池；**Redis 仅崩溃副本**（队列 + 房间快照），前期可不接，内存即够。

**game → matchsvc**（启动注册 + 心跳）：
```
POST /mm/game/register  { gameId, wsUrl, capacity } → { ok }    // game 启动时注册可达地址
POST /mm/game/heartbeat { gameId, load, rooms }     → { ok }    // 周期上报负载，matchsvc 据此分配
```
> matchsvc 是「谁有空闲 game」唯一知情者；meta/玩家都不需要知道 game 拓扑。

#### 对等裁判反作弊（Phase C / S1-J，2026-06-14 落地）

ranked 局双方 hash 不一致时，meta 不直接作废，而是挑一名第三方在线玩家无头复算定罪：

```
meta → gateway:  POST /gw/judge { seed, mode, endFrame, frames[], exclude[], decks? }  → { ok, stateHash?, winnerSide?, judgeAccountId? }
                 // frames[].cmds[].commands 为 base64（game.proto opaque bytes）；exclude = 参赛双方 accountId；decks = 原局卡组限制（PVP_LOADOUT §6.2），来自 body.replay.decks
gateway → judge: ServerMsg.judge_request { request_id, seed, mode, end_frame, frames[], top_deck[], bottom_deck[] }   // 推给挑中的 canJudge 在线 socket
judge → gateway: ClientMsg.judge_verdict { request_id, state_hash, winner_side, ok }        // 客户端复算回报
client → gateway: ClientMsg.client_caps { can_judge }                                        // 连上即上报本机是否可做裁判
```

- gateway 挑非参赛、`can_judge` 的在线 socket，push `judge_request`、挂 pending 等 `judge_verdict`（20s 超时 / 候选掉线即作废）；阻塞返回 `/gw/judge`。
- meta `judgeMismatch()`：裁判 `state_hash` 命中哪方上报哪方诚实、另一方判负 + `settleElo` + 写 `matches.cheat{side,accountId,judgeAccountId}`；裁判不可用/超时/对不上任一方 → 退回作废（不结算、不标记）。
- 客户端 `runJudge`（`client/src/net/judgeRunner.ts`）：proto 帧 → `Replay` → netplay 引擎跑到 GameOver → 同 `matchStateHash`（FNV-1a）算终局 hash，与对局上报逐字同源。
- meta 加 `NW_GATEWAY_INTERNAL_URL`（→ gateway 内部 HTTP `:8090`，无 depends_on 避环）。**简化**：gameserver 未改，mismatch 的 `match_over` 文案仍标 mismatch，但 ELO 已按裁决下发。
- **补漏（2026-07-15）**：ranked 局若启用了卡组限制（`PVP_LOADOUT_DESIGN.md §6.2`），裁判复算必须用原局的 `decks`，否则全卡池复算的哈希永远对不上双方真实哈希——仲裁永久失效。`decks` 从 `matchReport.ts` 的 `body.replay.decks` 一路透传到 `judge_request.top_deck`/`bottom_deck`，`judgeRunner.buildReplay()` 写回 `Replay.decks` 并喂给 `runHeadless` 的引擎配置。详见 `PVP_LOADOUT_DESIGN.md §6.5`。

### 8.2 match ticket（M18，matchsvc 签，game 验）

```ts
interface Ticket {            // matchsvc 用内部密钥签为 JWT；客户端不可篡改，game 只验签
  room_id: string;
  seed: number;               // 双方 ticket 同 seed（确定性内核的唯一种子）
  side: 0 | 1;                // 本方阵营（→ match_start.local_side）
  opponent: string;           // 对手展示名
  opponentPublicId: string;   // 对手 9 位数字公开 id（纯展示，资料弹层用）
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
- **`players` 身份名单必须来自不可变 roster，不能读 `Room.slots`**（2026-07-18 修复的回归）：一方提交完 `reportResult` 后立刻断开 socket 是常态（机器人几乎总是这样，真人客户端也可能抢跑），`onDisconnect` 的"已上报→摘除 slot"分支会把它从 `slots` 里删掉；若 `endMatch` 上报时直接读 `slots.map(...)`，断线的一方就从 `players` 里彻底消失。meta 那边 `if (winner && loser)` 找不到缺的一方就**静默跳过**结算，不报错——ranked 局大多数（凡对手断线快于己方）都拿不到 ELO。修复：`Room` 维护一份 `addPlayer` 时写入、永不删除的 `roster`，`endMatch` 的 `players` 字段读这份 roster。

### 8.4 gateway 控制面 WS（M20，玩家公开门面）

握手：`wss://host/gw?token=<jwt>`（同 REST 的 JWT；gateway 解出 accountId 绑定连接）。常驻整局会话期。**protobuf 二进制专用**（`Gateway.ts`：`ws.on('message', (data, isBinary) => { if (!isBinary) return; ... })` 直接丢弃非二进制帧）——早期"JSON 或 protobuf 均可"的设计在实现里已收紧为 protobuf-only，本节曾经写的"建议沿用 JSON 便于调试"已过时，未跟着改。

**客户端 → gateway**（`ClientMsg` oneof 里，除 `cmd_submit`/`match_result`/`conn_resume` 三个数据面专属之外的全部分支；`room_*`/`duel_*` 转发 matchsvc §8.1，`client_caps`/`judge_verdict` 就地处理，见 Phase C）：
| msg | payload | 说明 |
|---|---|---|
| `room_create` | `{ mode: friendly\|ranked, deck[] }` | friendly 建房，或 ranked 入队——**没有单独的 `mm_enqueue` 消息**，ranked 排位复用同一个 `room_create{mode:RANKED}`（见 §8 顶部"实现状态"一节的订正） |
| `room_join` | `{ code, deck[] }` | 输码加入（friendly） |
| `room_ready` | `{ ready }` | 切换准备 |
| `room_start` | `{}` | 房主开局 |
| `room_leave` | `{}` | 离开房间 / 退队 / **取消排位匹配**（同样没有单独的 `mm_cancel`） |
| `duel_invite` | `{ to_public_id, deck[] }` | 好友挑战（"切磋"）邀请 |
| `duel_respond` | `{ invite_id, accept, deck[] }` | 接受/拒绝挑战邀请 |
| `client_caps` | `{ can_judge }` | 上报本机是否可作对等裁判 |
| `judge_verdict` | `{ request_id, state_hash, winner_side, ok, stars, stats_json }` | 裁判复算结果回报 |
| `ping` | `{}` | 心跳 |

**gateway → 客户端**（matchsvc 事件回推 + 社交/SLG 实时推送，`ServerMsg` oneof 里除 `frame_batch`/`conn_resync`/`peer_dc`/`match_over` 四个数据面专属之外的全部分支——完整 payload 定义见 §3.2）：
| msg | 说明 |
|---|---|
| `room_state` | 房间态变更广播（好友加入/ready 等都走这条） |
| `match_found` | 配对/开局成功，下发连 game 的连接信息（M18）；客户端据此连数据面 WS |
| `match_bot` | 排位匹配超时降级 AI 对手（feature flag） |
| `room_error` | `ROOM_NOT_FOUND`/`ROOM_FULL`/`RANKED_UNAVAILABLE`/`PREMATCH_LOST` 等——**没有单独的 `mm_status`**，排位"搜索中"状态由客户端本地维护（发出 `room_create{mode:RANKED}` 后即显示 spinner），服务器只在结果落定（`match_found`/`room_error`）或重启自愈（`queue_state`/`pre_match_lost`）时推送 |
| `judge_request` | 挑中本机作对等裁判 |
| `queue_state` / `pre_match_lost` | matchsvc 重启自愈（2026-07-29），见 §3.2 |
| `duel_invited` / `duel_cancelled` | 切磋邀请到达 / unhappy-path 取消 |
| `friend_presence` / `friend_request` / `friend_update` / `chat_message` / `mail_new` | 好友/私聊/邮件实时推送（S6）——**没有单独的通用 `presence` 消息**，各自有专属 case |
| `march_update` / `tile_update` / `under_attack` / `siege_result` / `family_msg` / `sect_msg` / `nation_msg` | SLG 大世界实时推送（S8） |
| `pong` | 心跳回应 |

> `room_state`/`match_found` 的语义与 S1 现实现里 gameserver WS 的 `room_state`/`match_start` 等价，只是**搬到 gateway 控制面**；game 数据面 WS（§3）不再承载房间阶段消息。

### 8.5 gateway → meta 取 ELO（M17，matchsvc 保持 DB-free）

```
GET /internal/elo?accountId=<id>      (内部密钥)   → { elo }
GET /internal/profile?accountId=<id>  (内部密钥)   → { displayName?, publicId }   // gateway 取昵称 + 9 位公开 id 显示房间
```
- gateway 在 `mm_enqueue` 时调用，把 `elo` 带进 `/mm/enqueue`；matchsvc 因此无需连 Mongo。
- 也可在 gateway WS 握手后预取并缓存（elo 变化频率低）；ranked 局末 meta 写新 elo 后可经控制面推 `presence`/刷新。

---

## 9. commercial 内部契约（M21 / S5，meta → commercial）

> ✅ **已实现（2026-06-14，S5-1~6）**。钱包/充值/消费/盲盒迁到独立 **commercial 服务**（连专属库 `notebook_wars_commercial`，玩家不可达）。**meta 是唯一调用方**——§2.3~2.6 的公开端点收到请求后，经下列内部 RPC（JSON + `X-Internal-Key: <NW_INTERNAL_KEY>`）调 commercial 完成扣币/随机/记账，再据结果写 inventory（meta 库）+ 钱包镜像回推。设计与流程见 `COMMERCIAL_DESIGN.md`。业务结果（含 INSUFFICIENT_FUNDS 等）以 HTTP 200 + `{ok:false,error}` 返回，meta 映射成公开错误码；协议错误（鉴权/解析）才 4xx。

```
GET  /internal/wallet?accountId=<id>             → { ok, coins, pity:{poolId:count} }
GET  /internal/orders/undelivered?accountId=<id> → { ok, orders:[{_id,accountId,kind,result}] }   # 对账：未发货订单
POST /internal/shop/charge
     { accountId, itemId, cost, orderId }       → { ok, orderId, coinsAfter, status } | {ok:false,error:INSUFFICIENT_FUNDS|BAD_REQUEST}
POST /internal/gacha/draw
     { accountId, poolId, count:1|10, orderId } → { ok, orderId, coinsAfter, pityAfter, results:[{itemId,rarity}] } | {ok:false,error:INSUFFICIENT_FUNDS|BAD_REQUEST}
POST /internal/spend  { accountId, amount, reason, orderId } → { ok, coinsAfter } | INSUFFICIENT_FUNDS   # 纯金币 sink（改名等），无发货物品，落库即 delivered（对账不拾取），orderId 幂等
POST /internal/order/delivered  { orderId, refundCoins? } → { ok }   # refundCoins>0：dupe 退币随发货闭环入账（幂等）
POST /internal/recharge/verify
     { accountId, platform, receipt, receiptId }→ { ok, coinsAfter, coinsGranted } | {ok:false,error:INVALID_RECEIPT}
POST /internal/ads/credit  { accountId, amount, dayKey } → { ok, coinsAfter }
```

- **幂等**：消费用 meta 生成的 `orderId`，充值用平台 `receiptId`；重放返回原结果不重扣/不重发（commercial 端 orders/recharges 唯一 `_id` 守卫）。
- **一致性**：扣币（commercial）+ 发货（meta）是 saga——meta 据回执发货后调 `/internal/order/delivered` 闭环；崩溃则下次 `GET /save` 拉 `orders/undelivered` 补发（皮肤 `SaveData.deliveredOrders` $addToSet 幂等）。详见 `COMMERCIAL_DESIGN.md §6`。
- **库迁移**：`gachaHistory`/`walletLog`/`iapReceipts` 已从 meta 库（`shared/src/mongo.ts`）移除，在 commercial 库重建为 `gachaHistory`/`ledger`/`recharges`（+ `wallets`/`orders`）。`adsDaily`（广告 cap 计数）/`victoryDaily`（胜场金币 cap）2026-07-27 起改存 Redis，不再是 meta/commercial 库的 Mongo 集合（见 §5）。
- **未实现**：`results[].dupeConverted` 改由 meta 据库存判重复（commercial 不持有 inventory）；重复退币 S5 暂缓（见 `COMMERCIAL_DESIGN §6`）；`recharge` 平台验签为 dev 桩。

---

## 10. worldsvc 公网接口（SLG 大世界，第四面）

> SLG 大世界为**独立公网 REST 面**（与 meta 分离、不同 base URL，反代 `/world` `/sect` `/nation` → worldsvc:18084 不剥前缀；订正 2026-07-07：`/family` 已迁 socialsvc、`/auction` 已迁 auctionsvc:18086）。**机器契约单一来源 = `server/contracts/openapi-world.yml`**（客户端 `gen-openapi.mjs` 生成 `src/net/openapi-world.ts`）；设计权威见 **`SLG_DESIGN.md §14`（接口/进程/库归属）+ §14.6（REST 端点清单）**。所有玩家端点走 `Authorization: Bearer <JWT>`（与 meta 同 token），大多带 `worldId`（所在 shard）。下表为简明清单，字段/形态以 `openapi-world.yml` 为准，不在此重复 schema。

### 10.1 World（地图 / 行军 / 养城）
```
GET  /world/map           ?worldId&cx&cy&r          → WorldMapView（视区；静态层全图公开，迷雾只藏情报 garrison/hp/watchtower，§18.10）
GET  /world/map/sparse    ?worldId&cx&cy&r&lod      → WorldMapSparseView（鸟瞰只含占领格，lod=thin|mid）
GET  /world/tile/{tileId}                           → WorldTileView
GET  /world/me            ?worldId                  → PlayerWorldView（兵力/资源/产率/训练队列）
POST /world/join          { worldId }               → PlayerWorldView（自动落城）
POST /world/abandon                                 { worldId, x, y } → ok
  ⚠️ `POST /world/occupy` **不是公网端点**（订正 2026-09-03）：S8-1 的瞬间占领只保留给 e2e 直接调
     `svc.occupyTile()` 铺场景，公网路由已摘除（见 `SLG_DESIGN.md` §5.4，回归断言
     `worldsvc/test/httpApi.e2e.test.ts` 期望 404）。真实占领走 §5.4 的「行军→PvE 战斗→胜后占领倒计时」。
POST /world/relocate      { worldId, x, y }         → PlayerWorldView（迁城，花 RELOCATE_COST）
POST /world/watchtower    { worldId, x, y }         → WorldTileView（建瞭望塔视野源，G5 V2）
GET  /world/march         ?worldId                  → MarchView[]
POST /world/march         { worldId, fromX,fromY, toX,toY, kind, troops, teamId? } → MarchView
POST /world/march/{marchId}/recall  { worldId }     → ok
POST /world/sweep         { worldId, fromX,fromY, toX,toY, troops } → MarchView
POST /world/troops/train  { worldId, qty }          → PlayerWorldView
POST /world/troops/speedup{ worldId, coins }        → PlayerWorldView
POST /world/troops/recover{ worldId, cardId }       → PlayerWorldView（CC-3 花金币治疗受伤角色卡；补记 2026-09-03）
POST /world/structure/demolish { worldId, x, y }    → ok（ADR-051 P5 拆除自己的建筑；补记 2026-09-03）
GET/PUT /world/defense    ?worldId&tileKey / { worldId, tileKey?, defenseConfig } → DefenseConfig（攻守两用布阵）
GET/PUT /world/teams      ?worldId / { worldId, teams[] } → TeamTemplate[]（进攻布阵模板，≤5 支）
GET  /world/siege/{siegeId}/replay  ?worldId        → SiegeReplayView（观战重播，客户端同 seed headless 重跑；含 attackerName/defenderName 供回放基地铭牌+视角标签）
```

### 10.2 Nation / Season / SLG Shop
```
GET  /world/nations       ?worldId                  → NationView[]（10 首都）
POST /world/nations/{capitalIdx}/name  { worldId, name } → ok
GET  /world/season        ?worldId                  → SeasonView（赛季状态/容量/人口/地图尺寸）
GET  /world/shop/items                              → SlgShopItemView[]
POST /world/shop/buy      { worldId, itemId }       → ok
```

### 10.3 Family（家族）—— **已迁出 worldsvc，见 §12**

> **订正 2026-09-03**：本节原先列的是 worldsvc 上那套带 `worldId` 的 `/family/*`（ADR-021 前的形态）。
> 家族已随 ADR-021 整体迁入 **socialsvc**，改为**去 worldId 的全局持久**实体，路径前缀 `/social/family/*`，
> 端点集合与请求形态都变了（不是简单换前缀）。本节旧表在代码里**一条都不存在**，已删除以免误导——
> 真实清单见下面 §12，机器契约 `server/contracts/openapi-social.yml`，设计权威 `SOCIAL_SVC_DESIGN.md`。

### 10.4 Sect（宗门，S8-4b）
```
GET  /sect/list  ?worldId  / GET /sect/{sectId}     → SectView[] / SectDetailView
POST /sect/create { worldId, name, tag }            → SectDetailView
POST /sect/join | /sect/leave | /sect/dissolve      { worldId, sectId? } → ok
POST /sect/ally | /sect/unally  { worldId, targetSectId } → ok
POST /sect/vote-remove-leader { worldId, nomineeFamilyId } → SectVoteResult
POST /sect/message  { worldId, body, senderName? }  → SectMessageView（经 gateway 扇出宗门频道）
GET  /sect/channel  ?worldId&before?&limit?         → SectMessageView[]
```

> **国家/世界公频**（`nation_msg`，§3.2）经 worldsvc Redis pub/sub → gateway 扇出给同 world 在线玩家；REST 拉历史端点（如 `/nation/channel`）随 SLG 频道收尾落地，以 `openapi-world.yml` 实际为准。
> **内部/admin 端点**（`/admin/world/{open,settle,reset,close}`、`/admin/world/audit/anomalies`，X-Internal-Key 门控）玩家不可达，不入 openapi-world，见 `SLG_DESIGN_LOG.md §17.7 / §20.6`。

---

## 11. analyticsvc 公网接口（埋点 ingest，`ANALYTICS_DESIGN.md §8`）

> 埋点进程（端口 18085，连 `notebook_wars_analytics`，反代 `/analytics`）。无状态、不连业务库，仅复用 `NW_JWT_SECRET` 验签取 `accountId`。**写入 fire-and-forget**（`writeConcern:{w:0}`，客户端失败静默丢弃，不影响游戏）。机器契约（追加进 `openapi.yml`）见 `ANALYTICS_DESIGN.md §8`。

```
GET  /analytics/config                              → AnalyticsConfig   // 公开无鉴权；session 启动拉一次采集开关/采样率
POST /analytics/events  (JWT 可选)  AnalyticsEventBatch → 200（不代表落盘）  // 批量 ≤100 条/请求；关闭场景用 navigator.sendBeacon
GET  /internal/query    (X-Internal-Key)            → 聚合结果   // 仅 ops 后台调（漏斗/DAU/关卡通过率），玩家不可达
```

- **`AnalyticsConfig`**：`{ enabled, defaultSample, events: { [name]: { enabled?, sample? } } }`——服务端控制开关，不发版即可调粒度；客户端拉取失败回退 `enabled:false`（安全退化）。
- **`AnalyticsEventBatch`**：公共属性（`session_id/device_id/platform/os/game_version/locale`）放 batch 根层，每条 event 仅 `{ event, ts, props? }`（减传输体积）。`POST /analytics/events` JWT 可选：有 token 附 `user_id`，否则匿名设备。
- 不记请求 IP；账号注销按 `user_id` 批删事件（GDPR，§2.10）。事件分类 / 漏斗 / 数据库见 `ANALYTICS_DESIGN.md §5/§6/§9`。

---

## 12. socialsvc 公网接口（社交，第五面；`SOCIAL_SVC_DESIGN.md`）

> **补齐 2026-09-03**：§0 早就把 socialsvc 记为第五公网面，但本文一直只有 worldsvc(§10)/analyticsvc(§11) 两节，
> 社交面的端点清单从未落到「接口契约单一来源」里（家族那套还留着 §10.3 的 worldsvc 旧形态）。
> **机器契约 = `server/contracts/openapi-social.yml`**（第四份 openapi spec，§0/§1.2 原先只列了三份）；
> 设计权威 = `SOCIAL_SVC_DESIGN.md`。下表只作导航，字段/形态以 spec 为准，本文不重复 schema。

反代 `/social/*` → socialsvc（端口 8085，连专属库 `nw_social`）。**家族随 ADR-021 迁入本服务后去掉 `worldId`，全局持久。**

```
# 家族（Family）
GET  /social/family/mine | /social/family/search | /social/family/browse
GET  /social/family/{familyId} | /social/family/requests | /social/family/{familyId}/messages
POST /social/family                                  # 创建
POST /social/family/{familyId}/join | /social/family/leave | /social/family/disband
POST /social/family/kick | /social/family/role | /social/family/announcement | /social/family/emblem
POST /social/family/requests/{requestId}/respond
POST /social/family/{familyId}/messages              # 发家族频道消息（经 gateway 扇出）

# 好友（Friend）
GET    /social/friends | /social/friends/requests
POST   /social/friends/search | /social/friends/request | /social/friends/respond
POST   /social/friends/block | /social/friends/report
DELETE /social/friends/{publicId} | /social/friends/block/{publicId}

# 私聊（Chat）/ 邮件（Mail）/ 其它
GET  /social/chat/conversations | /social/chat/{convId}/messages
POST /social/chat/send | /social/chat/read
GET  /social/mail        POST /social/mail/send
GET  /social/mail/{mailId}/read   DELETE /social/mail/{mailId}
GET  /social/badges      GET /social/profile/{publicId}/extra
```

- **内部面**（`X-Internal-Key`，玩家不可达）：`/internal/mail/system{,/bulk}`（系统邮件写入的**唯一**权威路径，
  metaserver `insertSystemMail`/`bulkInsertSystemMail` 委托到这里，见 `claudedocs/server.md`）、`/internal/family/{activity,batch}`、
  `/internal/presence/{online,offline}`、`/internal/push`、`/internal/reports`、`/admin/internal/moderation-wordlists`。
- **gateway 回调面**：`/gw/presence`、`/gw/push/batch`、`/gw/social/invalidate`。

---

## 13. auctionsvc 公网接口（拍卖行，第六面；`AUCTION_DESIGN.md`）

> **补齐 2026-09-03**：同上——§0 记了第六面，本文却没有对应小节。
> **机器契约 = `server/contracts/openapi-auction.yml`**；机制权威 = `AUCTION_DESIGN.md`；数值 = `server/shared/src/slg/auction.ts`（`AUCTION_*`）。

反代 `/auction` → auctionsvc（端口 18086，**独立库** `notebook_wars_auction`；2026-07-07 从 worldsvc 解耦成独立进程）。

```
GET  /auction/list | /auction/mine | /auction/myBids | /auction/refprice
POST /auction/create
POST /auction/{auctionId}/buy | /auction/{auctionId}/bid | /auction/{auctionId}/cancel
```

- 仅 coin 计价，赛季资源禁挂（`AUCTION_DESIGN` 反 RMT 闸门）；托管结算 + 异常审计走 admin。
