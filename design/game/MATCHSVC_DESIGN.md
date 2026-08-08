# Notebook Wars — matchsvc 匹配服务设计

> 创建：2026-06-14。本文件设计 **matchsvc（私有匹配大脑）** + 配套的 **gameserver 瘦身** 与 **game→meta 局末结算**，并锚定整个 S1-M 拆分的迁移顺序。
> 配套：`META_DESIGN.md`（§1.1/§6.1 决策 M16–M21 拓扑）、`GATEWAY_DESIGN.md`（控制面网关，matchsvc 的公开门面）、`SERVER_API.md`（§8 内部契约 / §3 数据面 WS）、`META_TASKS.md`（S1-M1~M4）。
> 状态：**已实现（2026-06-14，S1-M1~M4）**。matchsvc 现为独立进程 `server/matchsvc`（订正 2026-07-07：早期曾寄于 `server/gateway/src/matchsvc`，现已独立），gameserver 瘦身于 `server/gameserver`，game→meta 结算于 `server/metaserver/src/internal.ts`。下文为设计依据，实现细节见 `CLAUDE.md`「gateway 控制面 + matchsvc」节。

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
# 实装：除 room/create 外均 fire-and-forget 返 { ok }；房间态/ticket/配对结果一律经 /gw/push 异步推回（见 §2.3）。
POST /mm/enqueue      { accountId, name, elo }       → { ok }
POST /mm/cancel       { accountId }                  → { ok }
POST /mm/room/create  { accountId, name }            → { roomCode, state }   # 唯一同步返回房间态者
POST /mm/room/join    { accountId, name, roomCode }  → { ok } | ROOM_NOT_FOUND|ROOM_FULL   # state 经 /gw/push
POST /mm/room/ready   { accountId, ready }           → { ok }   # state 经 /gw/push
POST /mm/room/start   { accountId }                  → { ok }   # tickets 经 /gw/push（match_found）
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

> **已落地（S1-M5/M23，2026-06-14）**：matchsvc 拆为独立进程后，gateway→matchsvc 命令与 matchsvc→gateway `/gw/push` 均走**内部 HTTP**（`X-Internal-Key`，M22）。控制命令一律 **fire-and-forget** 返 `{ok}`（仅 `room/create` 同步返回 `{roomCode, state}`），房间态/ticket/配对结果经 `/gw/push` 异步推回（§2.3）。§2.2 契约块已按此实装形态更正。
>
> **多实例路由（2026-07-18 补文档）**：上面的 `/gw/push` HTTP 调用只是**没配 Redis 时的兜底**——`NW_REDIS_URL` 配置了的话，`GatewayClient.push()`（`server/matchsvc/src/gatewayClient.ts`）改为发布 `{recipients:[accountId], msg}` 到 `GW_PUSH_REDIS_CHANNEL`，复用 worldsvc 已有的 S8-4b 广播通道；每个 gateway 实例订阅同一通道、只投递给本地在线的账号。这样 gateway 横扩到多实例时 `match_found`/`room_state`/`room_error` 依然能送到正确的实例，不需要额外的「account→哪个实例」注册表。`redis` 复用的是 matchsvc 已有的 activeMatch 连接（`connectActiveMatchRedis`），同一个 `NW_REDIS_URL`。

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

- friendly：`room/create` 生成 6 位房间码存内存房间；`room/join` 输码入房；双方 ready → `room/start`（房主）→ 从 game 注册表挑一台空闲 game → 签两张 ticket。
  - **房间码字符集**：`CODE_ALPHABET = '0123456789ABCDEFGHJKM'`（10 数字 + 11 字母，跳过 `I/O/L` 以免与 `0/1` 混淆），共 21 字符。**服务端生成器（`matchsvc/src/Matchsvc.ts`）与客户端输码键盘（`client/src/scenes/RoomScene.ts`）必须一字不差**，否则服务器会发出键盘打不出来的码；两侧各有单测断言同一字面量。选 21 字符是为了客户端验证码键盘（canvas 自绘，7 列）刚好排成 3 行一屏显示完，键盘格子按竖直预算取正方形以防横屏溢出。
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

- **对局前（WAITING）重连误销毁房间（2026-08-04 修复）**：`Room.takeover()` 原本无论房间处于哪个阶段，都只关闭旧 socket、故意不重绑 `slot.conn`——这个"故意"是为 **IN_MATCH** 阶段设计的（等客户端后续的 `conn_resume` 带着 `lastFrame` 来补帧，重绑早了可能让节拍器先跑到新连接上）。但 **WAITING**（尚未开局，对手还没连上）阶段根本没有 `conn_resume` 这回事——client 不会在开局前发它。于是旧 socket 的 close 事件一旦晚到，`onDisconnect()` 看到的还是"空槽"，直接 `removeSlot`→`destroy()`，把刚顶替上来、原本活着的新连接一并做没了，房间从 `RoomManager.rooms` 消失，重连方拿到一条永远等不到 `match_start` 的孤儿 socket。修法：`takeover()` 现在按阶段分支——`phase !== IN_MATCH` 时立即把 `slot.conn` 重绑到新连接（不必等谁来 resume）。回归见 `roomManager.test.ts`「WAITING-phase reconnect ... does not destroy the room」。
- **同账号占两个座位（自我对局）防御性拦截（2026-08-04 修复）**：`Room.hasAccount()` 定义了但从未被调用——理论上 matchsvc 配对 / gateway 好友切磋邀请（自邀直接拒 `not_found`）都不会撮合自己打自己，但 ticket 握手这一层此前完全没有兜底。`RoomManager.join()` 现在在"新座位"分支（非同侧重连/顶号）额外检查 `room.hasAccount(conn.accountId)`——同一账号已经占了本房间任一侧时直接拒绝（`join()` 返回 `false`，调用方关闭连接），不再放行。回归见 `roomManager.test.ts`「the same account cannot occupy both sides of a room」。

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
| S1-M5 | matchsvc 拆为独立进程 `server/matchsvc`：gateway↔matchsvc / game→matchsvc 全改内部 HTTP（M22/M23）；新增 `NW_MM_INTERNAL_PORT`、gameserver 注册改指 `NW_MATCHSVC_INTERNAL_URL` | 本文 + gateway + matchsvc | 内部传输从函数调用换 HTTP；矩阵：tsc -b 五包 + matchsvc 17/gateway 2/gameserver 42 测试全绿 |

**回滚位**：每阶段 `tsc -b` + 双客户端端到端实测（建房/加入/ready/开局/出牌同帧/hash/断线重连/ranked ELO），任一不过停在该阶段。

---

## 7. 开放问题（matchsvc 侧）— 已拍板落地（2026-06-14）

- [x] **内部密钥体系**：共用一把 `NW_INTERNAL_KEY`（`shared/config.ts`），用于签 ticket（HMAC）+ 服务间内部 HTTP 的 `X-Internal-Key`。
- [x] **gateway+matchsvc 拆进程（S1-M5）**：原合一进程的函数调用换为内部 HTTP——gateway `MatchsvcClient` POST 命令、matchsvc `GatewayClient` POST `/gw/push` 回事件、gameserver 注册心跳直指 matchsvc。`Matchsvc` 类逻辑不变（`push` 回调改由 `GatewayClient.push` 注入）。
- [x] **ticket 过期**：默认 30s（`NW_TICKET_TTL_SEC`），仅约束 match_found→首次连 game；重连复用同票据，game `verifyTicket(ignoreExpiration:true)` 放过已活房间的过期票据。
- [x] 实现顺序：本次直接做了 S1-M（用户拍板「Full S1-M1~M4」）。

---

## 8. 排位超时兜底 AI 代打（`match_bot_fallback`，2026-07-04 补文档）

> 实现早于本节文档化；此前设计文档从未记录该特性，仅存在于代码。

- **触发**：ranked 队列等待超过 `botFallbackMs`（默认 30000ms，`NW_MM_BOT_FALLBACK_MS`）且 feature flag `match_bot_fallback` 打开 → matchsvc dequeue 该玩家，推 `{ kind: 'match_bot', seed, opponentName, elo, difficulty }`（`Matchsvc.ts onQueueTimeout`）。关闭则继续排队等真人，行为不变。
- **无 ticket / 无 game_url**：这场"AI 代打"对局**完全在客户端本地跑**（复用与手动练习赛相同的本地引擎路径，仅用服务器给的 `seed` 保证确定性），不建 gameserver session，因此天生绕开 `/internal/match/report` 这条 ELO/归档结算唯一入口。
- **结算**（2026-07-04 补齐，见 `SEASON_DESIGN.md §15.2`）：客户端本地对局结束后调用玩家态端点 `POST /pvp/bot-result { won }`（区别于内部密钥端点），始终记每日任务 `pvp.match`；仅当当前 ELO < 1200（黄金下限）时按 `BOT_ELO_K`=8 小幅加减分，节流 15s/次。不影响 `pvp.streak`、不发战令经验/首达段位金币/胜场金币——这些副作用只在真实 `/internal/match/report` 结算里发生，AI 代打只做"够不到真人时的保底体验 + 低分段引导"，不是真实天梯的替代品。
- **AI 难度 1-10 级**（2026-07-06 补文档）：`difficulty` 字段此前硬编码 `'normal'`，引擎侧 `AISystem`（`server/engine/src/systems/AISystem.ts`）永远吃默认档且 easy/medium/hard 三档从无调用点选用，是「PvP 打 AI 太弱」的根因。现改为 `server/shared/src/ladder.ts` 的 `pickBotDifficulty(elo)`：ELO < `BOT_ELO_THRESHOLD`(1200) 随机落在 1-6 级，≥1200 随机落在 5-10 级（5-6 重叠是刻意的过渡带，不是硬边界）。`difficulty` 字段类型仍是 proto `string`（未改 schema，避免动 codegen），承载的是十进制数字字符串（如 `"7"`），客户端 `Number(difficulty)` 解析。引擎侧难度曲线覆盖 10 档：思考间隔从 2.5s（L1）连续降到 0.4s（L10，专业选手反应节奏地板，绝不逐帧决策）；L6 起引入基于 `UNIT_BLUEPRINTS` 公开数值现算的克制矩阵选牌（取代固定兵种优先级列表，覆盖此前从未被 AI 使用过的 Max/Lena/Mara/Runner/Ironclad/Berserker/Splitter/Harpy/Medic）；L7 起流星等 AOE 按敌方卡牌造价做墨水价值判定，L7 起会用 Haste 打节奏；L8 起维护逐列威胁滑动窗口，抢在车道压力真正爆发前补强。**不作弊硬约束**：AI 全程只读自己的手牌/墨水/基地血量和棋盘公开单位/建筑（`state.bottomPlayer.hand` 绝不触碰），并有测试断言把对方手牌换成任意排列不影响 AI 决策；思考间隔硬下限 12 tick（0.4s），任何难度都不允许比这更快，因为对局录像玩家可以回看复盘。手动练习赛（lobby "开始对局"入口）没有走匹配超时路径，client 侧按玩家自己存档的 `pvp.elo` 用同一套 1-6/5-10 分档公式独立算一次（`client/src/app/nav/lobby.ts`），因 webpack 的 `@nw/shared` 别名刻意只暴露 SLG 子集而没有直接复用 `ladder.ts`，公式已注释标注需与之保持同步。
  - **测试补齐**（2026-07-06）：`server/engine/src/__tests__/ai_difficulty.test.ts` 覆盖 `DIFFICULTY` 表结构（1-10 档齐全）、`thinkIntervalTicks` 单调递减且 L10 命中 12-tick 地板、`dangerRow`/`lowBaseHp` 单调方向、能力解锁边界（L6 克制矩阵/L7 Haste+价值判定/L8 威胁滑动窗口）、构造函数对非法难度（0/11）的拒绝、以及对方手牌任意排列不影响 AI 决策的公平性回归；`server/shared/test/ladder.test.ts` 已单独覆盖 `pickBotDifficulty` 的 ELO 分档。为便于测试直接断言，`AISystem.ts` 的 `DIFFICULTY` 表与 `DifficultyParams` 类型改为 `export`，并给构造函数加了非法难度守卫（此前 `DIFFICULTY[difficulty]` 取到 `undefined` 会在决策时崩溃，现改为构造时直接抛出明确错误）。

## 9. 登录级重连提示（accountId → 活跃对局，2026-07-14 补文档）

> 与 `SERVER_API.md §3.2` 的 `conn_resume`/`conn_resync`（同一 WS 会话内 60 秒断线宽限）是两套互不重叠的机制：那套解决"网络抖了一下"，这套解决"客户端进程整个重启/重新登录后，服务器还记不记得你有一局没打完"——此前完全没有，一旦对局开局 matchsvc 内存态的 `accountRoom` Map 就不再追踪它（对局结束时房间即销毁清 Map），gameserver 侧也是纯内存态，两边都没有持久化。

- **触发/数据流**：`startMatch()`（`Matchsvc.ts`）双方 ticket 签好后，各写一条 `nw:activeMatch:<accountId>` → `{ roomId, gameUrl, ticket, mode }` 到 Redis（`@nw/shared` 的 `setActiveMatch`，TTL 3600s 兜底防泄漏）；`ticket` 就是原始 match_found 签发的那份，**不需要重签**——gameserver 初次握手固定 `ignoreExpiration:true`（`server/gameserver/src/index.ts`），签名对即可无限期复用。
- **清除**：gameserver 唯一的"这局结束了"上报点 `POST /internal/match/report`（`server/metaserver/src/internal/matchReport.ts`）幂等检查通过后，立即对 `body.players` 双方 `clearActiveMatch`；覆盖 base/disconnect/mismatch 全部结束原因，不区分 ranked/friendly。
- **读取/下发**：metaserver `GET /save`（`service/save.ts` `getSave()`）响应内联一个可选字段 `activeMatch`（`base.ts` 新增异步 helper `activeMatchFieldFor`，仿 `gatewayField` 写法），Redis 未配置或查无记录时字段整体省略。选它而不是塞进 `AuthResult`（`/auth/*`），是因为 `getSave()` 是 client `SaveManager.bootstrap()/refresh()/adoptSession()` 三条登录路径（微信自动登录、token 免密续期、账号密码登录）的唯一共同调用点，一次改动天然覆盖全部入口。
- **Redis 可选**：matchsvc/metaserver 均新增 `NW_REDIS_URL`（`redisUrl: string | null`），未配置时整条链路静默禁用（写入/清除 no-op，`getSave()` 不带该字段）——本地/测试环境没有 Redis 不影响正常开局和登录。
- **client 侧**：`SaveManager` 用"读后清空"语义（`consumeActiveMatch()`）而非直接暴露字段，避免对局结算后常见的 `refresh()`（如 `pvp` 段刷新）误触发弹窗；只有 `auth.ts` 的三条登录入口显式调用一次。弹窗是仿 `ConsentDialog` 的独立全屏 Scene `ReconnectPromptDialog`（两个按钮，非强制单选），确认后走 `NetSession.rejoinMatch(gameUrl, ticket)`——内部复用既有的私有 `connectGame()`，重连成功后既有的 `onMatchStart` 流程自动接管场景跳转，未新增连接逻辑。

### 9.1 陈旧 activeMatch 卡死重连提示（2026-07-28 修复）

**症状**：gameserver 部署重启（对局还没打完）后，玩家下次登录被弹出"未完成的对局"提示，点 Reconnect 后对话框**永久卡住不消失**——不是缓存 vs 实时的问题（本来就是缓存，见 §9），是两处真 bug 叠加：

1. **清除只挂在"正常结束"上**：Redis `nw:activeMatch:<accountId>` 唯一的清除点是 `/internal/match/report`（§9「清除」），而 gameserver 重启时房间还在内存里，从未走到这个上报——记录只能干等 1 小时 TTL 兜底过期，这期间每次登录都会重新弹出。
2. **`NetClient` 对陈旧 ticket 无限重试**：`rejoinMatch` 复用缓存的原始 ticket 连 gameserver；房间已不存在时，gameserver 握手按 `ticket.exp` 判过期直接 `ws.close(4401/4403, ...)`（`server/gameserver/src/index.ts` 的 `!manager.roomExists(roomId)` 分支）。但 `NetClient.onClose` 此前只把 `4409`('replaced') 当永久拒绝，`4401`/`4403` 被当成普通掉线走 backoff 无限重连——同一个必然失败的握手每 8s 重试一次，`ReconnectPromptDialog` 永远等不到 `onMatchStart` 或任何失败信号，停在原地。

**修复**（两处独立、可叠加生效，前者让后者几乎不会触发，后者兜底前者失效/崩溃场景）：

- **gameserver 优雅关闭时主动清**：`RoomManager.activeAccountIds()`（新增，读 `Room.rosterAccountIds`，`destroyAll()` 之前调用）收集所有还在进行中的房间的 accountId，`MetaReporter.abandon(accountIds)`（新增，复用现有 `/internal/match/report` 的内部鉴权/超时约定，无settlement/归档，纯清除）POST 到新端点 `POST /internal/match/abandon`（`metaserver/src/internal/matchReport.ts`，鉴权/`clearActiveMatch` 复用与 `/internal/match/report` 完全相同的写法）。硬崩溃（无 SIGTERM 时间窗）不覆盖，仍靠 TTL 兜底——与既有安全网哲学一致，不过度设计。
- **client 侧对陈旧 ticket 快速失败**：`NetClient` 新增按连接实例可选的 `extraFatalCloseCodes`（默认仅 `4409`）——网关（control-plane）连接的 `tokenProvider`（`freshToken()`）每次重连能拿到全新 token，`4401` 在那条连接上仍是真的"稍后重试可能成功"，不能一刀切；只有 `NetSession.connectGame` 在 `rejoinMatch` 路径（传了 `onFailed` 时）才把 `4401`/`4403` 一并标记为永久拒绝——这条连接的 ticket 是固定重放的缓存值，重试不会变。`onFailed` 一次性回调（首次 `open` 之前就 `closed`）让 `auth.ts` 的 `offerResume` 能在真失败时弹 toast（`reconnect.gone`）+ 退回大厅，而不是让对话框悬空等待一个已经放弃重连的连接。

**验证**：`gameserver/test/roomManager.test.ts`/`metaserver/test/internal.test.ts`/`client/test/auth-reconnect-prompt.test.ts` 补充对应用例（见各自 test 文件）；`tsc -b` 全量 server 包 + client `tsc --noEmit` 通过。

### 9.2 房间仍存活时点 Reconnect 卡死（2026-08-08 修复）

**症状**：线上实测反馈——房间**并没有**消失（对手还在、gameserver 没重启），点「Reconnect」后对话框还是**永久卡在原地**，没有 toast 也没有报错。跟 §9.1 长得像但根因完全不同：§9.1 修的是"房间真没了"这条路径（`onFailed` 走 toast+回大厅），这次是"房间明明还活着，但两边永远等对方先动手"。

**根因**：§9 末尾那句"重连成功后既有的 `onMatchStart` 流程自动接管场景跳转"是错的——从来没有验证过对局仍存活时的冷启动重连：

1. **client 从不发 `conn_resume`**：`rejoinMatch()` 走 `connectGame()` 建一个全新的 `NetClient`；`NetClient.onOpen` 只在 `everOpened`（上次已经开过一次）为真时才触发 `onReconnect`（发 `conn_resume` 的地方），而这是这个 `NetClient` 实例的第一次 `open`——`everOpened` 起始就是 `false`。`NetSession` 里 `onReconnect` 回调本身还额外拿 `if (this.roomId)` 兜底，而 `this.roomId` 只在收到过一次 `match_start` 之后才会被填（`NetInputSource` 的 `onMatchStart` 包装里赋值）——冷启动这两个条件全部不成立，`conn_resume` 永远发不出去。
2. **即使发了，服务端 `Room.takeover()` 也不会回应 `match_start`**：`RoomManager.join()` 发现 side 已被占用（`hasSide`）→ 调 `takeover()`；`IN_MATCH` 阶段的 `takeover()` **故意**不重绑 `slot.conn`（见 §「对局前重连误销毁房间」旁边那条 2026-08-04 修复的注释），只等客户端主动发 `conn_resume` 触发 `Room.resume()`。
3. **即使 `conn_resume` 真发出去了，client 也无法靠 `conn_resync` 重建对局**：`ConnResync` 消息原本只有 `seed/start_frame/log/cur_frame`——没有 `room_id/mode/local_side/opponent_*/decks`，`NetInputSource.onConnResync()` 只合并帧、从不重建 `matchInfo`、也从不触发 `onMatchStart`。而冷启动的这个 App 进程从未收到过 `match_start`，`matchInfo` 是 `null`——没有 `onMatchStart` 就没有 `nav.goGameNet()`，引擎永远造不出来，对话框自然停在原地。

三层问题叠加，等价于该功能从 2026-07-15 上线以来，"对局仍存活"这条最常见的重连路径其实从未真正跑通过——`client/test/auth-reconnect-prompt.test.ts` 里 `netSession.rejoinMatch` 全程是手写 mock，没有一个测试真正走过 `NetClient`→`Room` 的完整链路。

**修复**（三处对应上面三层，缺一不可）：

- **`NetClient` 新增 `treatFirstOpenAsReconnect` 选项**：置位后 `connect()` 把 `everOpened` 初始值设为 `true`，使这个实例的**第一次** `open` 也按 `onReconnect` 语义处理。`NetSession.connectGame()` 复用既有的 `onFailed` 是否传入来判定（`onFailed` 只在 `rejoinMatch` 路径才会传）——不需要新增额外参数。`onReconnect` 回调里去掉 `if (this.roomId)` 判断，直接发 `resume(this.roomId, ...)`：`roomId` 空字符串对服务端无害，因为 `RoomManager.handle()` 从连接自身的 ticket 解析房间，从不读 `conn_resume` 消息体里的 `room_id` 字段。
- **`ConnResync` 消息扩到与 `MatchStart`同构**：新增 `room_id/mode/local_side/opponent_name/opponent_public_id/opponent_title/opponent_avatar_id/opponent_skins/top_deck/bottom_deck`（proto 字段 5-14）。`Room.resume()` 现在镜像 `launch()` 的取值逻辑一并下发；对热重连（本会话内已有 `match_start`）这些字段是冗余但无害的重复信息。
- **`NetInputSource.onConnResync()` 补上冷启动重建分支**：`if (!this.matchInfo)` 时从 `conn_resync` 的新字段重建完整 `MatchStartInfo` 并触发 `onMatchStart`（走跟真实 `match_start` 完全一样的下游路径：`NetSession` 记录 `roomId`/`localSide` → `nav.goGameNet()` 建引擎）；随后照常合并帧日志、把水位推到 `cur_frame`——引擎一起步就直接吃到完整历史帧「快进」追上当前进度，复用的正是 `NetInputSource` 类文档里本来就有的"conn_resync 后快进"机制，热重连分支保持完全不变（`matchInfo` 已存在时跳过重建）。

**验证**：`server/gameserver/test/room.test.ts` 新增 `conn_resync` 完整回放 `match_start` 全字段的用例；`client/test/net-client.test.ts` 覆盖 `treatFirstOpenAsReconnect`；`client/test/net-input-source.test.ts` 覆盖冷/热两种 `conn_resync` 分支（热重连不应二次触发 `onMatchStart`）；新增 `client/test/net-session-cold-resume.test.ts` 端到端验证 `rejoinMatch()` 首次 `open` 即发出 `conn_resume`。`tsc -b` 全量 server 包 + client `tsc --noEmit` 通过，proto 改动后各服务 `npm run proto:gen` 重新生成并提交产物。

## 10. 好友切磋邀请（friend duel invite，2026-07-25 补文档）

好友列表页新增"切磋"按钮：A 邀请在线好友 B → B 60 秒内接受/拒绝/超时 → 接受则两人直接进同一局，**不走 `RoomScene` 的手动房间码流程**，而是直接复用 §3 的 `startMatch('friendly', a, b)`——省掉了创建房间/交换码/双方 ready 的整套 UI 交互，两个 accountId 一早就都知道。

- **状态机落在 matchsvc**：新增 `duelInvites: Map<inviteId, DuelInvite>` + `pendingDuelByAccount: Map<fromAccountId, inviteId>`（后者保证**每个发起方同一时刻只有一条在途邀请**，镜像 `accountRoom` 的"一人一房"约束）。60 秒 `setTimeout` 到期未响应 → 从发起方视角等价于对方拒绝，推 `duel_cancelled{reason:'timeout'}`；被邀请方无需任何推送（本地倒计时到 0 直接自行隐藏横幅，权威结果始终以服务端为准）。
- **`duelRespond(accept=true)` 直接调用同一个类里的私有 `startMatch()`**——这是这个功能唯一"新增"的撮合逻辑，其余（拿 gameserver 分配、签 ticket、写 activeMatch、推 `match_found`）与 §3/§9 完全一致，未新建任何撮合路径。
- **两条新内部端点**（`internalHttp.ts`，同 §2.2 的 fire-and-forget 约定）：`POST /mm/duel/invite { accountId, name, publicId, equippedTitle, avatarId, deck, toAccountId }`、`POST /mm/duel/respond { accountId, inviteId, accept, [name/publicId/equippedTitle/avatarId/deck] }`（后四个字段仅 `accept=true` 时有意义）。
- **publicId → accountId 解析在 gateway，不在 matchsvc**：好友列表页只知道对方的 publicId（matchsvc 从来不认识 publicId 之外的身份，符合"不连库"的既有约束）。gateway 新增 `MetaClient.resolveByPublicId()`，直接复用 metaserver 已有的 `GET /internal/account/by-public-id/:publicId`（socialsvc 的 `SocialMetaClient.resolveByPublicId` 早就在用同一个端点）——**没有新建 metaserver 接口**。目标好友不在线 / 查无此人 → gateway 直接短路回 `duel_cancelled{reason:'offline'|'not_found'}`，不会在 matchsvc 里创建一条永远等不到回应的邀请。
- **新协议消息**（`transport.proto`，紧邻 `RoomCreate/RoomJoin` 与 `FriendRequestPush` 之后）：`DuelInvite`/`DuelRespond`（client→server）、`DuelInvited`/`DuelCancelled`（server→client）。**接受邀请没有单独的"已接受"推送**——直接沿用 `MatchFound`，客户端既有的 `onMatchStart` 处理链路不用改一行。
- **好友关系不做服务端二次校验**（v1 有意为之）：好友列表页面本身已经限定了只有好友才能点到这个按钮，与现有 friend-request 流程同一信任边界（客户端侧把关，控制面命令不重复鉴权）。若后续要收紧，需要 gateway → socialsvc 新增一条跨服务调用核实好友关系，是独立的后续项，不在本次范围内。
