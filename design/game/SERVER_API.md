# Notebook Wars — 服务器协议 / API 契约

> 创建：2026-06-13。本文件是客户端 ↔ 服务器的**接口契约**：REST 端点 + WebSocket 消息 + 锁步时序。
> 双端实现以本文件为准（客户端 `NetClient`/`SaveStore`/`EconomyClient` 与 `server/` 各 service）。
> 配套：`META_DESIGN.md`（系统/架构）、`META_TASKS.md`（任务）、`ECONOMY_BALANCE.md`（数值）；SLG 大世界（worldsvc）契约见 `SLG_DESIGN.md §14`；埋点见 `ANALYTICS_DESIGN.md §8`。
> 契约单一来源在 `server/contracts/`：`openapi.yml`（meta REST）+ `openapi-world.yml`（worldsvc REST）+ `openapi-social.yml`（socialsvc REST，补记 2026-09-03）+ `openapi-auction.yml`（auctionsvc REST）+ `transport.proto`（WS 控制面/数据面）+ `game.proto`（PlayerCommand，对服务器 opaque）+ `replay.proto`（录像），双端 codegen（见 `META_TASKS.md` C-2）。
> **⚠️ ADR-040（2026-07-14）**：`openapi.yml` 本身已是**生成产物**（文件头 `AUTO-GENERATED … DO NOT EDIT`）——真源是 `contracts/openapi/paths/<domain>.yml`（9 fragment）+ `openapi/schemas.yml`，改契约改 fragment 后跑 `npm run gen:api:contracts` 重新合并，**勿手改 `openapi.yml`**。

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `SERVER_API.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Notebook Wars — 服务器协议 / API 契约 | **本文** |
| §7 已定/开放问题、§8 内部服务契约、§9 commercial、§10 worldsvc、§11 analyticsvc、**§12 socialsvc、§13 auctionsvc**（后两节 2026-09-03 补齐） | [`SERVER_API_INTERNAL.md`](SERVER_API_INTERNAL.md) |

## 0. 总览

> **架构现状（11 应用进程 + 6 公网面）**（订正 2026-07-07：进程 8→10，补 `socialsvc`/`auctionsvc`；2026-07-22：补 `botsvc` → 11）：服务端现为 **11 个应用进程**（外加包 `contracts`、`@nw/shared`、`@nw/engine`；`botsvc` 是机器人玩家服务，玩家不可达、内部管理面 18087）。**公网面 = 6**：`meta`(REST 请求面) + `gateway`(WS 控制面) + `game`(WS 数据面) + `worldsvc`(SLG 大世界 REST 第四面，`/world` `/sect` `/nation`) + `socialsvc`(社交第五面，`/social/*`) + `auctionsvc`(拍卖行第六面，`/auction`)；`/family` 已迁 `socialsvc`、`/auction` 已迁独立进程 `auctionsvc`(端口 18086)；**玩家不可达 = `matchsvc`/`commercial`/`admin`**（仅内网，反代不路由）；`analyticsvc` 的 ingest 两端点（`/analytics/config` `/analytics/events`）经反代公开、`/internal/query` 内网。早期「5 组件 + 三面分离」（`META_DESIGN.md §1.1/§6.1`）三面仍是 PvP 对战层骨架：玩家触达 meta + gateway + game，**matchsvc** 是玩家不可达的私有匹配大脑（gateway 当门面 / game 注册），开局走 matchsvc 签名 ticket、结算 game→meta 上报（M16–M20）。内部契约见 §8/§9。

| 通道（面） | 协议 | 服务 | 暴露 | 承载 |
|---|---|---|---|---|
| 账号 / 存档 / 经济（请求面） | **HTTPS REST（JSON）** | `metaserver`（无状态，可横扩） | 公网 `/api` | 登录、存档同步、商店、盲盒、广告、IAP、PvE/装备/活动养成、天梯/战令、称号（§2） |
| 房间 / 匹配 / 在线 / 通知（控制面） | **WSS（双向实时）** | `gateway`（有状态连接层，M20） | 公网 `/gw` | 常驻连接：开始/取消匹配、friendly 建房/加入/ready/start、match-found+ticket 下发、在线状态、家族/宗门/国家频道扇出 |
| 锁步对战（数据面） | **WSS（protobuf 二进制）** | `gameserver`（无状态哑中继，永不连库 M16） | 公网 `/ws` | 每局新建：ticket 握手 → 逐 tick 输入中继 / 重连 / 局末上报 meta |
| **SLG 大世界（第四面）** | **HTTPS REST（JSON）** | `worldsvc`（连 `notebook_wars_world`，按赛季分服/shard） | 公网 `/world` `/sect` `/nation` | 地图/行军/占领、宗门、国家、赛季、围攻（§10；权威契约 `openapi-world.yml`）（订正 2026-07-07：`/family` 已迁 socialsvc、`/auction` 已迁 auctionsvc） |
| **社交（第五面）** | **HTTPS REST（JSON）** | `socialsvc`（连专属库 `nw_social`） | 公网 `/social/*` | 家族/好友/邮件/频道（家族已从 worldsvc 迁入，去 worldId 全局持久；SOCIAL_SVC_DESIGN） |
| **拍卖行（第六面）** | **HTTPS REST（JSON）** | `auctionsvc`（连 `notebook_wars_auction`，端口 18086） | 公网 `/auction` | 挂单/竞拍/买断/托管结算（从 worldsvc 解耦为独立进程，AUCTION_DESIGN §9） |
| 埋点 ingest | HTTPS REST（JSON，fire-and-forget） | `analyticsvc`（连 `notebook_wars_analytics`，端口 18085） | 公网 `/analytics` | `GET /analytics/config`（拉采集配置）+ `POST /analytics/events`（批量上报，`w:0`）（§11） |
| **内部：匹配 + 分配** | 内部 HTTP（gateway↔matchsvc）+ game 注册 | `matchsvc`（单点，玩家不可达 M17） | 仅内网 | 匹配队列、房间状态、game 注册表/分配、签 ticket（§8.1） |
| **内部：钱包 / 交易** | 内部 HTTP（meta→commercial） | `commercial`（连 `notebook_wars_commercial`，玩家不可达 S5） | 仅内网 | 钱包/扣币/盲盒 RNG/充值/广告记账（§9） |
| **内部：结算上报** | 内部 HTTP（game→meta，幂等） | game→`metaserver` | 仅内网 | 局末录像 + hash + winner 上报，meta 判定/写库（§8.3） |
| **内部：运维后台** | 内部 HTTP（ops 前端→admin，admin JWT） | `admin`（玩家不可达 S7） | 仅内网 | 监控/匹配池/分析/补偿（走邮件）；与玩家 JWT 严格隔离 |

> **线协议分层（M12）**：WS 用 protobuf（`transport.proto` = 控制层，服务器认得；`game.proto` = `PlayerCommand` 结构，仅客户端↔客户端）。服务器把 `PlayerCommand` 当 **`bytes` opaque 转发不解码** → 与游戏逻辑零依赖。REST 保持 JSON（低频、利于浏览器/支付回调/调试）。

- 各服务可独立部署（`META_DESIGN.md §6.1`），共享 `@nw/shared`（协议类型 + JWT 校验 + Mongo client + ladder/economy）；确定性战斗内核抽为 library 包 `@nw/engine`（PvP netplay / PvE / SLG 围攻共用）。反代按 `/api/*`(meta)、`/gw`(gateway)、`/ws`(game)、`/world` `/sect` `/nation`(worldsvc)、`/social/*`(socialsvc，含已迁入的 `/family`)、`/auction`(auctionsvc)、`/analytics`(analyticsvc) 分流；matchsvc / commercial / admin / botsvc 不暴露公网。gateway 与 matchsvc 各为独立进程，经内部 HTTP 互通（M22/M23，S1-M5）。
- 服务器权威段（钱包 / 库存 / 盲盒 / IAP / **天梯**）只能经服务器改，**客户端永不直接写**（`META_DESIGN.md §2`）。
- 所有时间戳由服务器盖，客户端不可信。

---

## 1. 通用约定

### 1.1 鉴权
- 登录拿**无状态 JWT**（服务端密钥签），后续 REST 走 `Authorization: Bearer <token>`，WS 在握手 query 或首帧带 `token`。
- `accountId` 由服务端从 token 解出，**客户端请求体里不带 accountId**（防越权）。

### 1.2 编码（契约单一来源 + 双端 codegen）
- **REST = JSON / `openapi.yml`（design-first，M15）**：`contracts/openapi.yml` 是机器契约的合并产物（真源 = `openapi/` 分域 fragment，见 §0 ADR-040 提示，勿手改）；客户端 typed fetch（`openapi-typescript` + `openapi-fetch`，`client/scripts/gen-openapi.mjs` 生成入库）。服务端 metaserver 路由+校验经**构建期代码生成**装配（ADR-023，已落地 2026-06-30）：`server/contracts/scripts/gen-openapi-server.mjs` 解析 openapi.yml，生成 `server/metaserver/src/generated/routes.gen.ts` 并入库——坏 spec 在 codegen/tsc 阶段即失败，契约变更有服务端 diff 可供 CD 卡版本；运行时不再依赖 `fastify-openapi-glue`。CI 检查：`npm run gen:api:server:check`（在 metaserver 目录）。统一响应包络：
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
POST /profile/rename (JWT) { displayName }  → { save: SaveData, displayName } | INSUFFICIENT_FUNDS | BAD_REQUEST
# AuthResult = { token, accountId, isNew, isAnonymous, displayName?, publicId?, gatewayUrl? }
```
- 微信：`code` 由 `wx.login` 得，服务端换 openid → 映射 accountId。
- Web/CrazyGames：`deviceId` 为客户端持久化 UUID（匿名 `isAnonymous=true`）。
- 密码哈希存储（**实现用 Node 内置 `crypto.scrypt`**，零依赖跨平台，串 `scrypt$N$r$p$salt$hash`）；OAuth 走授权码流（`state` 防 CSRF）；`bind` 把新凭证挂当前 accountId（升级转正，不丢档/钱包）。详见 `ACCOUNT_DESIGN.md`。
- **实现状态（2026-06-14）**：`/auth/register`·`/auth/login`·`/auth/password/change` + `AuthResult.isAnonymous` **已落地**（SA-1，`isAnonymous` 计算得出不落库）；`/auth/oauth`·`/auth/bind` **待做**（SA-2，错误码已预留）。`/auth/password/reset`（找回密码，需邮件服务）后置。
- **展示名（displayName，2026-06-14）**：注册时填的 `displayName` 存账号文档；`/auth/register`·`/auth/login`·`/auth/device`·`/auth/wx` 的 `AuthResult` 与 `GET /save` 均回带 `displayName`（有才带），客户端持久化用于个人资料显示（token 续登经 `GET /save` 自动恢复）。
- **改名（`/profile/rename`，2026-06-14）**：消耗 `RENAME_COST=500` 金币改展示名。meta 先经 commercial `/internal/spend` 扣币（余额不足 402 名不变），扣成功后写新名 + 钱包镜像回推权威存档。名字长度 1–24（`validateDisplayName`），空名 400。
- **公开数字 id + 房间昵称（publicId，2026-06-15）**：账号文档加 `publicId`（9 位数字、稀疏唯一索引），首次鉴权 `ensurePublicId` 惰性生成（碰撞换号重试，旧账号下次 auth 补）。`AuthResult` + `GET /save` 回带 `publicId`（accountId 仅服务器内部标识，绝不面向玩家）。新增内部端口 `GET /internal/profile?accountId=`（X-Internal-Key）→ `{ displayName?, publicId }`，gateway 据此把 `room_state` 里的玩家显示为**昵称（#publicId）**而非 accountId 前缀（meta 不可用则回退 id 前缀）。`PlayerSlot` 加 `public_id`（field 5，proto 双端重生）。**身份修正**：客户端 `NetSession` 连 gateway 时优先用 REST 已登录 token，不再用设备凭证重鉴权——否则登录用户在房间里会是设备匿名账号。openapi 的 `AuthResult` / save 响应 schema 须声明 `publicId`（同 `gatewayUrl`，防 `fast-json-stringify` 剥字段）。
- **gateway 地址下发（`gatewayUrl`，2026-06-14）**：客户端**只硬编码 meta 的 HTTP 地址**——gateway 控制面 WS 地址由 auth/save 回包下发（`AuthResult.gatewayUrl` + `GET /save` 的 `gatewayUrl`），game 数据面地址由 `match_found.game_url` 下发，都实时获取不静态配置。meta 经环境变量 `NW_GATEWAY_PUBLIC_WS_URL`（如 `ws://host:8082/gw` / `wss://host/gw`）得知公开地址；未配置则不下发（客户端退回构建期 fallback `getGatewayWsUrl`：生产同源由 `/api`→`/gw` 推导）。四个 auth 端点 + `GET /save`（token 续登无 auth 回包，故 save 也带）均回带。**注**：openapi 响应 schema 必须声明 `gatewayUrl`，否则 fastify `fast-json-stringify` 静默剥掉 schema 外字段。

### 2.2 存档（save-service，`META_TASKS.md` S0-7；**ADR-056 起 `PUT /save` 已整个下线**）
```
GET  /save                                     → { save: SaveData, displayName?, publicId?, gatewayUrl? }  // 当前账号（顺带回带展示名 + 公开 id + gateway 地址）
GET  /match/history?limit=<1..50>              → { matches: MatchHistoryEntry[] }  // 最近对战（默认 20），按 ts 倒序
```
- **不存在通用的 `PUT /save`**：`SaveData` 已无任何字段走"客户端攒批写、服务器整段接收"的模式——`progress`/`materials`/`pveUpgrades`/`equipmentInv`/`cardInv` 早在 ADR-006/ADR-010/CC-2 就已移到 `/pve/*`/`/equipment/*`/`/cards/*`；`equipped`/`flags`（曾是最后仅剩的两段）自 **ADR-056**（2026-07-28）起也改走各自专属端点：`PUT /title/equip`·`PUT /avatar/equip`·`PUT /skin/equip`（各自所有权校验）+ `PUT /flags`（`{key,value}`，无所有权语义）。原因：旧模型下 `reconcile()` 对 `equipped`/`flags` 永远"本地覆盖云端"，本地一旦被写脏就再也无法被任何刷新纠正；改成每字段专属端点后，客户端只做"先写本地镜像即时反馈、后台请求确认"，`reconcile()` 对所有字段一律云端为准——任何脏本地状态最迟下次同步必被纠正。
- **对战历史（`GET /match/history`，2026-06-15）**：从归档 `matches` 取当前账号视角的精简摘要（无录像/帧日志）。`MatchHistoryEntry = { roomId, mode(friendly|ranked), result(win|loss|unknown), opponentName?, opponentPublicId?, eloDelta?, ts }`——`result` 由 `matches.winner` 对比我方 side 推导（winner<0 / 未知 → unknown）；`opponentName`/`opponentPublicId` 与 `eloDelta` 取自归档时 enrich 进 `matches.players` 的快照（昵称在归档当刻定格，事后改名不回填；`eloDelta` 仅 ranked 成功结算时有）。查询走索引 `{ 'players.accountId': 1, ts: -1 }`。客户端 `StatsScene` 仅登录在线时拉取（离线显「登录后查看」）。

> **修订（2026-06-14，M21）**：§2.3~2.6 的经济端点**对客户端不变**（仍是 meta 的公开 REST），但服务端实现改为 **meta 编排 → 内部调 commercial 服务**（钱包/扣币/RNG/充值在 commercial 独立库，物品由 meta 发货）。`save.wallet/gacha` 降级为只读镜像。内部契约见 **§9**；流程见 `COMMERCIAL_DESIGN.md §6`。

### 2.3 商店（meta 编排 → commercial，S2-2 / S5-3）
```
GET  /shop/items                               → { items: ShopItem[] }
POST /shop/buy        { itemId, qty? }         → { save: SaveData, granted: ItemId }
                                                 | INSUFFICIENT_FUNDS
```
`qty`（2026-08-10，可选，默认 1，1–20）：一次请求内买 `qty` 份，服务端原子完成"校验每日上限（若有）→ 扣费 `cost×qty`→发货 `qty` 份"，全有或全无（详见 `ECONOMY_NUMBERS.md` §6.6）——不是客户端循环调用 `qty` 次。

### 2.3a 累充里程碑 / 限时直购（`GACHA_DESIGN.md §6/§13`）

> **补记 2026-09-03**：下列端点在 `openapi.yml` 里已存在多时，但 `design/` 全库从未提到过端点名。

```
POST /recharge/claim    { milestoneId }   → { save, granted }   // 累充里程碑领奖（GACHA_DESIGN §13）
POST /starter/buy       { receipt }       → { save, granted }   // 新手包一次性直购（须验单，INVALID_RECEIPT）
POST /monthly-card/buy | /monthly-card/claim              // 月卡购买 / 每日领取
POST /year-card/buy                                       // 年卡购买
POST /fate/redeem       { }               → { save, granted }   // 命运点兑换
POST /promo/redeem      { code }          → { save, granted }   // 兑换码
```

- **`/recharge/claim`**：进度 `totalRechargeCents` 由服务器从 `save.monetization` 读取，本端点**只记领取 + 发货**，不自行累加充值额（充值额只能由 IAP 验单链路写，§2.6/§9）。幂等键 = `accountId + milestoneId`。

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

### 2.7 PvE 养成（服务器权威，ADR-006 / `PVE_INTEGRITY_PLAN.md §8`）

> `progress.cleared` / `progress.stars` / `materials` 自 ADR-006 起**服务器权威**——这几段只能经下列端点写（当时的表述是"`PUT /save` 同步段收窄为仅 `equipped`/`flags`"；`PUT /save` 本身已于 ADR-056 整个下线，见 §2.2）。奖励按 `@nw/shared/pveRewards.ts` 服务器重算，不信客户端自报数额。`pveUpgrades` 曾经也是这一批（第三个端点 `/pve/upgrade`），**该端点已于 2026-07-30 删除**（见下方说明）；字段本身仍在 `SaveData` 上只读留存（L0 反作弊比对用），不再有任何写入路径。

```
POST /pve/enter    { levelId }                 → { save: SaveData }   // 进入关卡时扣体力（ADR 2026-07-06）
POST /pve/clear    { levelId, stars, pveSnapshot?, replayRef? }
   → { save: SaveData, capped?: boolean, needsReplay?: boolean, verifyId?: string }
POST /pve/verify   { verifyId, frames }        → { save: SaveData, status: 'verified'|'rejected'|'unverified' }
POST /pve/stamina/purchase                     → { save: SaveData }   // A4 付费补体力：30 金币 → +60 体力
```

- **`/pve/clear`**：校验 level 存在 + **已解锁**（前置关在 `progress.cleared` 内）+ `stars≤3` → 按 `grantForClear(levelId,isFirst)` 在**每日上限**（`PVE_DAILY_CLEAR_REWARD_CAP`，按 `dayKey` 原子计数，Redis 存储，类比 `victoryDaily`，均见 §5 的 `dailyCounter.ts` 说明）内发材料；首通额外发首通奖励 + 解锁下一关 + 记星（取 max）→ 原子写 `progress/stars/materials`（rev 守卫）→ 回推权威 save。超上限：仍写 progress/stars，材料不发（`capped:true`）。
- **抽检复算（L1，复用 S1-J 对等裁判）**：`shouldSpotCheck` 命中（首通恒查 / 开局 `pveSnapshot` 与服务器权威 `pveUpgrades` 不符「开局战力不符→必作弊」/ 按 `PVE_VERIFY_SAMPLE_RATE` 随机）→ 暂扣材料、记 `pveVerifications{status:pending}`、回 `{needsReplay:true, verifyId}`；客户端补传录像帧调 `/pve/verify` → meta 经 `gateway.judge` 派第三方无头复算 → 复算星数 ≥ 声称则发材料(`verified`)，< 声称则不发(`rejected`)，无裁判可裁则 benefit-of-doubt 照发(`unverified`)。
- **`/pve/stamina/purchase`**（补记 2026-09-03，此前 spec 里有、`design/` 里全库无一处提及）：走 `commercial.spend` 扣 30 金币后给 +60 体力，数值见 [`BALANCE.md`](BALANCE.md) §10 / [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §3；余额不足 `INSUFFICIENT_FUNDS`，体力已满仍按满值封顶。客户端入口 `LevelPrepScene` 的「补充体力」按钮（失败则路由到商店）。
- **`/pve/enter`**（补记 2026-09-03，此前只在 `ECONOMY_NUMBERS.md` §3 出现过，本「契约单一来源」漏列）：体力**在进入关卡时**扣、不在结算时扣（2026-07-06 拍板）；中途撤退/打输不退还。离线时客户端本地镜像先扣，联网后用本端点与 `pveStamina` 集合对账。也是 `rejectIfBanned()` 的两个生效点之一（另一个是 `/pve/clear`）。
- 四端点均返回完整权威 SaveData（客户端 adopt 镜像，同经济回执）。
- ~~`/pve/upgrade`~~ **已删除（2026-07-30）**：曾经"服务器按 `PVE_UPGRADE_COSTS` 校验材料足够 → 扣材料 + `pveUpgrades[id]+1` → 回推 save"，CC-1 起单位养成改走 Hero Roster（`cardInv`）后彻底死代码——客户端唯一调用点 `SaveManager.upgrade()` 早已零调用方且标 `@deprecated`。删除范围：契约片段（`openapi/paths/pve.yml`）+ 两处生成产物（`openapi.yml`/`routes.gen.ts`，重跑 `gen:api:contracts`/`gen:api:server`）+ `MetaHandlers`/`PveHandlers` 类型 + 服务端 handler（`pve.ts`）+ `@nw/shared` 里同样孤儿的 `PVE_UPGRADE_COSTS`/`findPveUpgrade`/`pveUpgradeCost` + client `ApiClient`/`SaveManager` + 两侧既有测试。详见 `SLG_DESIGN_LOG.md` §43 / comm-audit-p2-remaining。

### 2.8 装备养成（服务器权威，ADR-010 / ADR-012 / `EQUIPMENT_DESIGN.md §18`）

> 装备实例段（`equipmentInv`）全部由 `/equipment/*` 服务器权威端点写（同 §2.7；`PUT /save` 已下线，见 §2.2）。穿戴影响 SLG 战力，亦走专用端点。所有变更类端点带客户端生成的 `idempotencyKey`，服务器记 (key→结果) 账本重放首次结果（不二次扣料/二次掷骰），范式借 commercial `deliveredOrders`。

```
POST /equipment/craft    { defId, idempotencyKey }                          → { save, instance|stackDelta }
POST /equipment/enhance  { instanceId, idempotencyKey }                     → { save, success, instance, consumed }
POST /equipment/salvage  { instanceIds[], idempotencyKey }                  → { save, refunded } | NOT_SALVAGEABLE
POST /equipment/reforge  { instanceId, fuelInstanceId, lockedIndex?, idempotencyKey } → { save, instance, consumed }
POST /equipment/equip    { slot, instanceId|null, unitType? }              → { save, equipped }
```

- **`/equipment/craft`**：扣材料产 0 级基础装备（堆叠或新实例）；撞 **1000 库存硬上限**（堆叠件不计，[ADR-064](../DECISIONS.md) 2026-08-10 由 300 扩容）则拒/转等值材料补偿（§3.3）。
- **`/equipment/enhance`**：**服务器掷骰**（成功率表 80%…+8→9 仅 10%，绑定 `idempotencyKey` 首次结果防「重试改命」）、扣材料/金币、成功则 level+1；**失败只损耗、不掉级、不碎**（ADR-009/010）。
- **`/equipment/salvage`（ADR-012，分解回收）**：扣实例、返还 **70% 打造基础成本材料**（**强化投入不返还**）；**+5 及以上不可分解** → 返 `NOT_SALVAGEABLE`（可分解范围 +0~+4，含堆叠 0 级冗余件，可批量）。30% 损耗本身是温和 sink，主职清库存。
- **`/equipment/reforge`**：吞低一级同类装备作燃料、扣金币、重 roll 副词条（可锁一条）。
- **`/equipment/equip`**：纯穿戴状态变更（无随机）；穿戴数结构性自限 = 3 槽 × loadout 套数，不占 300 库存。
- 扣料 + 改实例 + 写账本**单事务**（Mongo 事务或乐观锁 rev 守卫），失败整体回滚。数字权威 → `ECONOMY_NUMBERS §5`。

### 2.8a 角色卡实例（服务器权威，`CHARACTER_CARDS_DESIGN.md §3` 融合改制 CC-2/CC-4）

> 卡实例段（`cardInv`）同样由 `/cards/*` 服务器权威端点写（`PUT /save` 已下线，见 §2.2）。喂卡升级=融合 5 张同阵营同级材料。

```
POST /cards/fuse        { targetId, materialIds[5], idempotencyKey }      → { card, save } | 400/404/409
POST /cards/fuse-batch  { rounds[{targetId,materialIds[5]}], idempotencyKey } → { completed, failed?, save } | 400/404/409
POST /cards/lock        { cardInstanceId }                                → { save }   // 幂等：重复锁定成功
POST /cards/unlock      { cardInstanceId }                                → { save }
```

- **`/cards/fuse`**：恰好 5 张同阵营同级材料卡升目标卡一级；**锁定的材料被拒**；`idempotencyKey` 防重试双扣。
- **`/cards/fuse-batch`**（2026-08-20）：一次请求跑完整轮备料（最多 20 轮）。轮次**按序**执行，每轮针对"上一轮执行完之后"的名册校验，所以后一轮可以吃掉前一轮刚升级出来的卡。**首轮就非法** → 报错（400/404/409，不改任何数据）；**跑到一半失败** → 仍是 200，`completed` 报实际落地轮数、`failed.index/code` 报第一个失败轮。整批共用一个 `idempotencyKey`（重试回放已落地轮数，不会重复吞卡），只读一次名册、只回一次 `cardInv`、只扣一次 `cardInvCount` —— 这正是它存在的理由：改造前客户端的"合成所需材料"按钮是每轮一个 `POST /cards/fuse`，每个响应都带一份重组好的完整 `cardInv`，几百张卡的名册上肉眼可见地卡。
- **`/cards/lock` / `/cards/unlock`**：锁定卡不可作喂卡材料（防误吞）。

### 2.9 活动 / Live-ops（ADR-014 / `EVENTS_DESIGN.md`）

> 活动是叠在既有系统上的**受控时效容器**，不造第二条发奖路径：发奖走系统邮件（OPS）、任务计数复用 statKey 累加链、限定直购复用 commercial 商店、时钟服务器权威。**绝不信客户端自报进度**，加成乘子由服务器在产出结算时套用（受 `ECONOMY_NUMBERS §14` 封顶）。

```
GET  /events                                   → { events: ActiveEvent[] }   // 当前 active 活动 + 配置 + 我的进度
POST /events/claim   { eventId, milestoneId }  → { save, granted } | NOT_REACHED | ALREADY_CLAIMED | EVENT_ENDED
POST /events/redeem  { eventId, shopItemId }   → { save, granted } | INSUFFICIENT_POINTS | EVENT_ENDED   # ⚠️ 未实现
```

> **实现状态（补记 2026-09-03）**：`GET /events` 与 `POST /events/claim` 已在 `openapi.yml` + `routes.gen.ts` 落地；
> **`POST /events/redeem` 至今只有本节这份契约草案**——spec 里没有它，代码里没有它，`eventPoints` 这个字段在
> `@nw/shared` 里也还不存在。活动积分兑换整条线随 `EVENTS_DESIGN.md`（状态：设计中）一起待实现。
> 本节其余描述照旧有效。

- **`GET /events`**：返回 active 活动的 `EventDef`（窗口/i18n key/任务/里程碑/乘子/限定 SKU，文案走 i18n 不内嵌明文）+ 该玩家服务器权威进度（任务计数/已领里程碑/活动积分 `eventPoints`）。
- **`/events/claim`**：服务器按 `window + 幂等键(eventId+milestoneId+accountId)` 二次校验，达成则发系统邮件（领取时经 commercial/inventory 入账，幂等）；过窗 `EVENT_ENDED`（已获奖励进领取宽限，如结束后 7 天可领）。
- **`/events/redeem`**：活动积分兑限定物（积分活动期清零、不入持久经济、不兑金币、不破皮肤稀有度铁律）。
- **限定直购**走 commercial 正常购买流（§2.3/§9），活动只控上下架窗口（带同一 `window`）；活动加成**只注入 PvE/SLG**，PvP 硬墙恒不读（ADR-009/014）。

### 2.10 账号删除与合规（ADR-013 / `COMPLIANCE_GLOBAL.md §3.5`）

> Apple 5.1.1(v)：凡支持账号注册的 App **必须提供应用内删除账号入口**（不能只让发邮件）。

```
DELETE /account   (JWT)   → { ok, data:{ confirmToken } }
```

> 订正 2026-07-07：以代码为准，实现为 `DELETE /account`（openapi `deleteAccount` + auth.ts），**软删**——置 `accounts.deletedAt`，数据经 7 天宽限后异步清除（C5-b Apple 5.1.1(v)），与 `ACCOUNT_DESIGN §C5-b` 一致。旧文「`POST /account/delete { confirm } → { scheduledPurgeAt }`」为设计稿措辞，未落地。

> 订正 2026-08-10：宽限期内「重新登录恢复」曾经只是文案/隐私政策的承诺，代码里从未实现——`authWx`/`authDevice`/`authLogin`/`authOAuth` 在签 token 前就用 `rejectIfBanned` 拒绝了已删除账号，真正能恢复的 `POST /account/cancel-deletion` 又要求已登录的 token，形成死锁，删除即永久锁死。已修复：四个 auth 入口新增 `restoreIfWithinGrace`，宽限期内重新登录会自动清除 `deletedAt`/`deletionConfirmToken` 后正常签发 token；过期则维持 410。详见 `ACCOUNT_DESIGN §C5-b 订正`。

- meta 编排：删/匿名化 `saves` + `accounts`（移除 `openid`/`deviceId`/`loginId`/`displayName` 等 PII）+ 通知 commercial 处理钱包/交易留存（交易记录依税务/审计义务可保留必要最小集，但与身份解绑）+ analyticsvc 按 `user_id` 批删事件 + social 解好友关系/清私聊。
- **二次确认**在客户端（`SettingsScene`），服务端要求 `confirm:true`；删除不可逆（或给短宽限 `scheduledPurgeAt` 后清除，按法务定）。
- GDPR 数据导出（DSAR）测试期走人工，正式期再做自助导出端点（占位，未建）。

### 2.11 天梯赛季 / 排行榜 / 战令（`SEASON_DESIGN.md §10`）

> 赛季状态服务器权威（赛季号/ELO/峰值/战令经验全在服务端）；客户端只读、领取走 API、二次校验。**无 increment 端点**——经验/峰值/首达只在服务器结算链累加。详细可编码规格见 SEASON §13A/§13B。

```
GET  /leaderboard                          (JWT) → { season:{seasonNo,endAt}, top:[≤100], me|null }
POST /battlepass/claim   { track, level }  (JWT) → { save, granted } | NOT_REACHED|ALREADY_CLAIMED|PASS_REQUIRED|BAD_REQUEST
POST /battlepass/buy                       (JWT) → 下单（commercial 发货置 hasPass）
POST /internal/ladder/season/roll          (X-Internal-Key) → { season }   # admin 手动开新季，CAS 幂等
```

- **赛季时钟**随 `GET /save` / `GET /leaderboard` 带回 `{seasonNo,endAt}`；推进 = 运维在 ops 后台手动触发 `season/roll`（meta 不自带定时器），逐玩家结算走**惰性迁移**（下次访问按 `pvp.seasonNo` 落后即软重置 + 发上季峰值金币邮件）。
- `pvp` 扩字段（`seasonNo/seasonPeakElo/seasonPeakRank/reachedRanks`）+ `battlePass` 块随 save 下发（客户端只读）。段位首达金币 / 赛季峰值金币 / 战令经验数值 → `ECONOMY_NUMBERS §13`。

### 2.12 称号（服务器权威，`TITLE_DESIGN.md §9 L2-2`）

> 称号是唯一对外身份名片：`SaveData.titles[]`（服务器权威，`$addToSet` 授予，无客户端可写接口）+ `equipped.title`（佩戴位，服务器权威，客户端只能经 `PUT /title/equip` 写，ADR-056）。称号随 `GET /save` 回推可展示，下列两端点为 L2-2 补的独立读/换接口（设计对齐，机制权威见 `TITLE_DESIGN.md`）。

```
GET  /titles               (JWT) → { titles: { id, source, seasonNo? }[], equipped }
PUT  /title/equip          (JWT) { titleId }  → { save: SaveData }  | 403（未授予）
```

- **`GET /titles`**：`source`/`seasonNo` 由 `parseTitleId`（`@nw/shared/titles.ts`，服务端/客户端共用）从 titleId 命名约定（`<来源>.<赛季?>.<key>`）派生。授予时间不入库，故不返回 `grantedAt`。
- **`PUT /title/equip`**：仅允许已授予称号（未授予 403）；空串 = 卸下；写 `save.equipped.title` 并回推完整 `SaveData`。**客户端实际调用点**：`SaveManager.equipTitle()`（先本地镜像即时反馈，再后台调用此端点确认；ADR-056 起——此前有一段时期该端点已实现但客户端并未接入，实际写路径是通用 `PUT /save`，2026-07-27 comm-audit finding B12 曾为此专门加过防御性校验）。
- 授予路径在 meta 内部单点 `grantTitle`（ranked 赛季结算 / SLG 赛季结算 / 成就 claim / admin 授予），非玩家可调。自动佩戴最高 `weight` 称号（`TITLE_DEFS`）。
- **头像/皮肤同一模式**：`PUT /avatar/equip`（`equipped.avatar`）、`PUT /skin/equip`（`equipped["skin:<unitType>"]`，新增）机制与 `PUT /title/equip` 一致，各自校验对应的所有权记录（`titles[]`/`everOwned.*`/`inventory.skins`）；`PUT /flags`（`{key,value}`）覆盖剩余无所有权语义的 `flags.*` 布尔标记（`tutorial_done`/`gdprConsent`/`featSeen.<id>` 等）。四者是 `SaveData` 上仅剩两段"客户端可写字段"（`equipped`/`flags`）现在的完整写入面——`PUT /save` 已下线，见 §2.2。

### 2.13 玩家反馈（游戏内反馈入口，`UI_DESIGN.md §4.1.1`）

```
POST /feedback   (JWT) { text }  → { ok: true }  | 400（空文本）| 429（超出限流）
```

- 不是补偿/审批工单流的一部分——单纯的玩家心声收集，**无裁定/无 dismiss-uphold 结论**（区别于举报/申诉队列）。但有一层轻量**已读/备注痕迹**，见下方 §2.13.1。
- `text`：1..`FEEDBACK_TEXT_MAX`（1000）字符，服务端 `trim()` 后校验非空；不经 `censorChat` 敏感词处理（同 `AppealDoc.reason` 的先例——面向 ops 的心声原文，不面向其他玩家展示）。
- **限流**：`createRateLimiter`（`@nw/shared`），按 accountId 维度，`FEEDBACK_RATE_LIMIT`＝5 次 / 24h（超出返回 429，不静默丢弃——玩家提交是主动行为，需要明确反馈，不同于 telemetry 类"静默丢弃超限请求"的处理）。
- 落 metaserver 集合 `feedback`（`{_id, accountId, text, clientPlatform?, createdAt}` + §2.13.1 的三个 triage 字段），随 JWT 身份写入，不需要玩家提供联系方式。

#### 2.13.1 已读/备注痕迹（2026-08-20 补，`feedback.action`）

原设计只有"ops 只读列表"，反馈累积后无法追踪"哪几条看过了"。补一层最轻的 triage 状态——**仍然不是状态机**，没有"处理中/已处理"，只回答"看没看过 + ops 留了什么话"：

```
POST /internal/feedback/{id}/review   (X-Internal-Key) { readBy, note? }  → { ok: true } | 400（缺 readBy）| 404
```

- `FeedbackDoc` 增三字段：`readAt?`（**首次** review 时打戳，之后**永不覆盖**——它回答"我们第一次看到这条是什么时候"，不是"最后一次动过"）、`readBy?`（最后一次操作者 adminId，last-write-wins）、`note?`（ops 备注，1..`FEEDBACK_NOTE_MAX`＝500，last-write-wins）。
- **未读 ⟺ `!readAt`**。`readAt` 是唯一的已读判据，写备注同时也会打上 `readAt`（一次动作，不需要先标已读再写备注），所以不存在"有备注但未读"的行。
- `note` **省略** = 只标已读，保留原有备注不动；`note: ''`（或纯空白）= **显式清空**备注。这个区分是为了让"标已读"按钮不会误删已写好的备注。
- 权限：查看仍是全角色的 `feedback.view`；写入需 `feedback.action`（仅 super/ops——客服 support 与 viewer 只读）。每次写入落一条 `feedback.review` 审计，summary 区分 `noted` / `marked read`。

---

## 3. WebSocket 协议（房间 + 锁步）

> **修订（2026-06-13）**：本节是 **game 数据面 WS**。握手改为 `?ticket=<jwt>`（matchsvc 签，§8.2），game 验签即开局。下表 `room_create/room_join/room_ready/room_leave/room_start` 等**开局前操作迁到 gateway 控制面 WS**（§8.4），game WS 只保留 `cmd_submit`/`frame_batch`/`conn_resume`/`conn_resync`/`peer_dc`/`match_over`/`ping` 这些锁步+重连消息。`match_result` 改为 game→meta 内部上报（§8.3），不再走 WS。以下为 S1 现实现，按修订迁移。

握手：`wss://host/ws?token=<token>`。连接后每帧一个 protobuf `Envelope`（`transport.proto`，`oneof case` 区分消息）。下表 `case` 列即 oneof 分支名。

> `commands` 字段类型是 **`bytes`**：客户端用 `game.proto` 编码 `PlayerCommand[]`，服务器**透传不解码**（M12）。

### 3.1 客户端 → 服务器（`ClientMsg` oneof）

> ⚠️ 下表 `room_*` 房间消息**已迁 gateway 控制面 WS（§8.4）**，game 数据面仅保留 `cmd_submit`/`conn_resume`/`ping`。房间行保留作历史/实现参考。

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

> ⚠️ 以下 4 类**只走 gateway 控制面 WS**（§8.4），从不出现在 game 数据面：

| `case` | payload | 说明 |
|---|---|---|
| `duel_invite` | `{ to_public_id, deck[] }` | 好友挑战（"切磋"）邀请；`deck` 同 `room_create.deck`（`PVP_LOADOUT_DESIGN.md §4`），空则服务器指派默认卡组 |
| `duel_respond` | `{ invite_id, accept, deck[] }` | 接受/拒绝挑战邀请；`deck` 仅 `accept=true` 时有意义 |
| `client_caps` | `{ can_judge }` | 连接后上报本机是否可作对等裁判（Phase C，§8.1 对等裁判反作弊） |
| `judge_verdict` | `{ request_id, state_hash, winner_side, ok, stars, stats_json }` | 裁判复算结果回报（Phase C）；`stars`/`stats_json` 是 PvE L1 抽检复算专用字段，PvP/围攻恒为空 |

### 3.2 服务器 → 客户端（`ServerMsg` oneof）

> 下表是 `transport.proto` `ServerMsg` 的完整 24 个分支（不区分走 game 数据面还是 gateway 控制面——两条连接共用同一个 `Envelope`/`ServerMsg` 定义，NetSession 按连接来源路由到 `routeData`/`routeControl`，见 `client/src/net/NetSession.ts`）。

| `case` | payload | 说明 |
|---|---|---|
| `room_state` | `{ code, players: PlayerSlot[], phase }` | 房间状态变更广播 |
| `match_start` | `{ room_id, mode, seed, start_frame, local_side, opponent_name, opponent_public_id, opponent_title, top_deck[], bottom_deck[], opponent_avatar_id, opponent_skins[] }` | 开局：模式 + 种子 + 起始帧 + 本方阵营 + 对手展示信息（昵称/9 位公开 id/称号/头像/已装备角色皮肤 id 列表，纯展示用）+ 双方卡组（`PVP_LOADOUT_DESIGN.md §6.2`，双方都收全量卡组以保证确定性建局）。`opponent_skins`（2026-08-01 新增，S3-4 皮肤污染对手修复的一部分）沿用 `opponent_title`/`opponent_avatar_id` 同一条链路——matchsvc 签发 ticket 时 self↔opponent 互换写入；机器人对手（PvP-vs-AI/match_bot_fallback）不连库、永远不带这个字段，客户端 `UnitView` 因而天然只对真人对手回显皮肤 |
| `frame_batch` | `{ to_frame, frames: FrameCmds[] }` | **服务器节拍**：每 100ms 一个批次（覆盖 3 个 sim 帧，M14）；`frames` 仅列非空帧，空窗 ⇒ 只有 `to_frame` 水位 |
| `conn_resync` | `{ seed, start_frame, log: FrameCmds[], cur_frame, room_id, mode, local_side, opponent_name, opponent_public_id, opponent_title, opponent_avatar_id, opponent_skins[], top_deck[], bottom_deck[] }` | 重连补帧：种子 + 非空帧日志 + 当前帧。`room_id`起的字段（2026-08-08 补，冷启动重连修复，见 `MATCHSVC_DESIGN.md §9.2`）镜像 `match_start` 全量——同一进程内的热重连（`matchInfo` 已存在）忽略这些冗余字段；App 重启后的冷重连（`NetSession.rejoinMatch`）靠这些字段独立重建对局，不依赖曾经收到过 `match_start` |
| `peer_dc` | `{ side, grace_ms: 60000 }` | 对手掉线，进入 60s 等待重连（M10） |
| `match_over` | `{ winner_side, reason, mismatch?, elo?: { delta, after, rank_after } }` | 结束；`reason: base|disconnect|mismatch`；ranked 带 ELO 变化 |
| `room_error` | `{ code, message }` | 房间错误（不存在 / 已满 / `PREMATCH_LOST` 等） |
| `pong` | `{}` | 心跳回应 |
| `match_found` | `{ game_url, ticket }` | 配对/开局成功，客户端据此连数据面 WS（M18，§8.4） |
| `judge_request` | `{ request_id, seed, mode, end_frame, frames[], level_id?, defense_json?, top_deck[], bottom_deck[], card_instances_json?, equipment_inv_json? }` | 挑中本机作对等裁判，无头复算一局/一关（Phase C §8.1；`level_id`=PvE 抽检、`defense_json`=SLG 围攻抽检，二选一或都空=PvP） |
| `match_bot` | `{ seed, opponent_name, elo, difficulty }` | 排位匹配超时降级为 AI 对手（feature flag `match_bot_fallback`）；无 game_url/ticket，客户端本地起一局 PvE-vs-AI |
| `friend_presence` | `{ public_id, online }` | 好友上下线（S6） |
| `friend_request` | `{ request_id, from_public_id, from_name, message }` | 收到好友申请 |
| `friend_update` | `{ public_id, kind: ADDED|REMOVED }` | 好友关系变更（新增/解除） |
| `chat_message` | `{ conv_id, from_public_id, from_name, body, ts }` | 私聊新消息 |
| `mail_new` | `{ mail_id, has_attachment }` | 新邮件到达 |
| `march_update` | `{ march_id, kind, from_tile, to_tile, arrive_at, status }` | SLG 行军状态变更（S8）；`kind: attack|reinforce|occupy|sweep|return|move`（scout 已于 2026-07-30 整体删除，非本表新漂移） |
| `tile_update` | `{ tile_id, type, level, owner_public_id, family_id, protected_until, owner_name }` | SLG 地块状态变更 |
| `under_attack` | `{ tile, attacker_name, attacker_public_id, arrive_at, troops_hint }` | 己方地块被进攻预警 |
| `siege_result` | `{ siege_id, tile, outcome, loot_summary, replay_ref, march_id }` | 围攻结果（`outcome: attacker_win|defender_win|draw`） |
| `family_msg` | `{ family_id, from_public_id, from_name, text, ts }` | 家族频道新消息 |
| `sect_msg` | `{ sect_id, from_public_id, from_name, text, ts }` | 宗门频道新消息（S8-4b） |
| `nation_msg` | `{ world_id, from_public_id, from_name, text, ts }` | 国家/世界公频新消息（B7，worldsvc 经 Redis pub/sub → gateway 扇出给同 world 在线玩家；REST 拉历史 `/nation/channel` 离线补全） |
| `duel_invited` | `{ invite_id, from_public_id, from_name }` | 收到好友挑战（"切磋"）邀请；接受直接走 `match_found`，没有单独的"已接受"推送 |
| `duel_cancelled` | `{ invite_id, reason }` | 挑战邀请的 unhappy path（`reason: declined\|timeout\|offline\|not_found\|lost`）；`accept` 走的是 `match_found`，从不到这里 |
| `queue_state` | `{}` | matchsvc 重启自愈（matchsvc-prematch-persist, 2026-07-29）：确认排位队列条目在重启后仍存活，纯 rehydrate 刷新，无字段 |
| `pre_match_lost` | `{ context: 'room'\|'queue'\|'duel' }` | matchsvc 重启自愈：该账号赛前状态（房间/排位队列/切磋邀请）没能恢复；客户端据 `context` 分别处理（room→弹房间错误，queue→静默重新排队，duel→清邀请横幅），见 `client/src/net/NetSession.ts` `routeControl` |

```proto
// transport.proto（节选；服务器认得这一层）
message PlayerSlot { uint32 side = 1; string name = 2; bool ready = 3; bool connected = 4; string public_id = 5; }  // name=昵称, public_id=9 位数字公开 id
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
- **登录级重连（2026-07-14 补文档）**：以上 `conn_resume`/`conn_resync`/60s 宽限最初只覆盖**同一 WS 会话内**的短暂断线；客户端进程重启/重新登录后另有一套独立机制——`GET /save` 内联返回 `activeMatch{roomId,gameUrl,ticket,mode}`（Redis 持久化，matchsvc 写入/metaserver 清除），client 登录后弹窗询问是否重连，确认则复用原始 ticket 直接重连回房间（同一 ticket 因 gameserver 握手忽略 exp 而长期有效）。详见 `MATCHSVC_DESIGN.md §9`；这条冷启动重连实际复用的正是本节 `conn_resume`/`conn_resync` 这套消息（2026-08-08 起 `conn_resync` 扩了字段专门支撑这条路径，见 §9.2 和上表）。
- **同账号多端顶号（2026-07-18 补文档）**：新设备用同一 ticket 握手、发现该 room+side 已被一个仍存活的旧连接占用时（`RoomManager.join()`），gameserver **主动关闭旧连接**（`4409 'replaced'`，语义同 gateway §8.4 的账号级顶替），而不是像此前那样放任旧 socket 悬空、只等客户端后续显式发 `conn_resume` 才补救——修复前存在双连接并存、旧端仍可提交 `cmd_submit` 的隐患。旧连接被关闭后走的仍是标准断线流程（`onDisconnect` → 60s 宽限计时），新连接随后发来的 `conn_resume` 正常触发 `conn_resync` 补帧——即"先踢旧连接，重连补帧逻辑不变"。实现见 `gameserver/src/Room.ts` `takeover()` + `RoomManager.join()`。
- **结算（修订 M19）**：局末 game 把 `{hash×2, winner_side×2, 非空帧录像}` POST 给 **meta**（§8.3）；`friendly` meta 仅写 `matches`；`ranked` **meta** 算 ELO、写 `saves.pvp`（服务器权威）→ 把 `match_over.elo{delta,after,rank_after}` 经 game 转发给客户端。game 不连库、不判定。（订正 2026-07-07：ELO 结算已从 gameserver 迁至 meta，2026-06-14 落地，见 `MATCHSVC_DESIGN`；旧「S1 现实现为 gameserver 直算直写，待迁移」已过时。）
- **ranked 匹配 / ELO（S1-R 已落地）**：
  - 入队：`room_create{mode:ranked}` → 服务器读 `saves.pvp.elo` 入匹配队列（需 Mongo，否则 `RANKED_UNAVAILABLE`）；按 ELO 邻近配对，等待越久可接受分差越宽（初值 `base 100 + 50/s`）；配对即建房直接开局（无 ready/房主环节）。`room_leave`（不在房内）= 取消匹配。
  - 胜负判定（**无服务器裁判**，S1-J 未做）：`match_result{ state_hash, winner_side }` 双方齐 → **hash 与 winner_side 均一致才认**该胜方、结算 ELO；任一不一致 → 作废（`mismatch`，不动 ELO）。掉线/认输 → 服务器权威判对手胜并结算。防一端谎报刷分。
  - ELO：K=32 标准公式、零和、分不为负；段位 9 段（`shared/ladder.ts` 与客户端展示同源，阈值见 `ECONOMY_BALANCE.md §2.3`）；`saves.pvp` 经单文档原子更新（rev 守卫 + 重试，整体替换 save，避免与其它并发写者互覆盖）写 `elo/rank/wins/losses/streak`。

---

## 5. 数据库集合（MongoDB，简表）

| 集合 | 文档 | 说明 |
|---|---|---|
| `saves` | `{ _id: accountId, save: SaveData, rev }` | 存档主表 |
| `accounts` | `{ _id: accountId, openid?, deviceId?, createdAt }` | 身份映射 |
| `gachaHistory` | `{ accountId, poolId, itemId, rarity, cost, rev, ts }` | 逐抽记录（M7） |
| `walletLog` | `{ accountId, delta, reason, balAfter, ts }` | 货币流水（审计 / 防刷） |
| `iapReceipts` | `{ _id: receiptId, accountId, granted, ts }` | 验单幂等 |
| `matches` | `{ roomId, mode, seed, players, winner, reason, hashOk, replay?, replayRef?, ts }` | 对局归档（friendly/ranked 都记）；`players[]` 归档时 enrich 每方 `{ side, accountId, displayName?, publicId?, eloDelta?, eloAfter? }`（昵称/publicId 快照定格、`eloDelta` 仅 ranked，供 `GET /match/history`）；`replay` 内嵌录像（小局，非空帧日志零成本内嵌，`cmds[].commands` 为 BSON binary opaque）；`replayRef` 指向外部存储（大局，待办）。索引 `{ 'players.accountId': 1, ts: -1 }` 支撑战绩查询 |
| `pveVerifications` | `{ _id: verifyId, accountId, levelId, stars, pveUpgrades, status, ts }` | PvE 抽检复算账本（`status: pending|verified|rejected|unverified`，存服务器权威 `pveUpgrades` 快照防漂移，§2.7） |
| `ladderSeasons` | `{ _id:'current', seasonNo, startAt, endAt, state }` | 天梯赛季时钟（**单文档**，admin roll 推进；§2.11 / SEASON §3） |

> `adsDaily`/`pveDaily`/`victoryDaily`（广告观看 cap、PvE 每日发材料通关次数、天梯胜场金币 cap）2026-07-27 起已从 Mongo 迁到 Redis（`shared/src/dailyCounter.ts`，键 `nw:{ns}:{accountId}:{dayKey}`），不再是 Mongo 集合——原三张表此前从未建索引/TTL，无界增长；Redis 版本原子 `HINCRBY`+cap 校验一次往返，48h 滑动 TTL 自动清理。Redis 未配置/不可用时退化为进程内计数（当前 meta/commercial 均单实例部署，退化态计数仍然正确，只是不扛进程重启）。
>
> 装备实例 v1 内嵌 `saves.equipmentInv`（小体量），膨胀后迁独立集合 `equipment`（索引 `accountId`、`accountId+instanceId`，§2.8 / EQUIPMENT §18.3）；活动 `EventDef` 配置由 admin 下发存运营库，玩家进度内嵌 save（§2.9）；`saves.pvp` 扩赛季字段 + `battlePass` 块无独立集合，加复合索引 `{ 'save.pvp.seasonNo':1, 'save.pvp.elo':-1 }`（§2.11）。
>
> 天梯积分存 `saves.pvp`（elo/rank/wins/losses/streak，服务器权威）；`gameserver` 在 ranked 局末用单文档原子更新写入。

---

## 6. 录像（replay，M13 / `META_DESIGN.md §6.6`）

> **分享端点（补记 2026-09-03）**：`openapi.yml` 里另有一组输入流录像的分享端点，`design/` 此前全库未提：
>
> ```
> POST /match/{roomId}/replay/share   (JWT)   → { shareCode }   // 仅能分享本账号参与过的对局；7 天 TTL
> GET  /r/{shareCode}                 (公开)  → Replay          // 免登录；过期返 404
> ```
>
> 与 [`REPLAY_SHARE_DESIGN.md`](REPLAY_SHARE_DESIGN.md) 的**状态流**分享（`POST /replay/share` + 公开 `GET /r/{shareCode}`）
> 是两套东西：这一组分享的是**服务端归档的输入流录像**（S1-RP，要重放引擎才能看），那一组是客户端自产的状态流
> （哑播放器直接放）。两者共用 `/r/{shareCode}` 这个公开读路径。

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
  repeated string top_deck = 8;    // PvP/netplay 卡组过滤（PVP_LOADOUT_DESIGN §6.2），无过滤则不设
  repeated string bottom_deck = 9;
}
```

> **稀疏存储**：空帧（仅帧号）不写录像；回放时逐 tick 推进，遇到有对应 `frame` 的内容帧就应用、否则空推进，到 `end_frame` 结束。

> **修订（2026-07-15）**：新增 `decks`（=top_deck/bottom_deck）——此前录像只存 seed+指令流，回放重建引擎时没有卡组过滤，会退化成"全卡池抽卡"，导致 ELO 锁定的高级卡（runner/splitter 等）凭空出现在回放里。现在录制（`matchEngine.ts`/`ReplayInputSource.snapshot`/`Room.buildReplay`）与回放重建（`ReplayScene.ts`/`serverReplayToReplay`）都携带 `decks`；对应 `MatchReplay`（`openapi/schemas.yml`）同步加了可选 `decks{top,bottom}` 字段。

- **PvP**：`gameserver` 为重连保留的非空帧日志**即录像**，局末零成本持久化——小局直接内嵌 `matches.replayGz`（`engineVersion=0`，服务器逻辑无关、客户端回放自校验；`cmds[].commands` 为 BSON binary opaque），大局转对象存储 `matches.replayRef` → `replayBlobs.replayGz`。
- **PvE**：客户端本地录制（只记玩家指令；敌方 `WaveDirector` 回放时由 seed+level 重算），可选上传分享。
- 回放走 `ReplayInputSource`：同 seed 起新引擎，按 tick 喂 `frames` → 逐 tick 还原。

> **修订（2026-07-20，S1-RP 存储成本修复）**：Pipeline A（本节，seed+指令流录像，用于反作弊/结算/观战）此前是纯 JSON（`frames[].cmds[].commands` 已 base64，但外层从未压缩），是 MongoDB Atlas 存储告警的主因（见 `mongo-matches-ttl-storage-fix-2026-07-20.md`）。现在改为端到端 gzip：
> - `gameserver`（`metaReport.ts`）拼好 replayDoc 后整体 `JSON.stringify` + `zlib.gzipSync` 一次，base64 编码为单个字符串，以 `replay_gz` 字段随 `/internal/match/report` 上报（原 `replay` 字段废弃）。
> - `metaserver`（`matchReport.ts`）**始终不解压**存进 Mongo：`replay_gz` 的 base64 解出的 gzip 字节直接作为 `Buffer` 存入 `matches.replayGz` / `replayBlobs.replayGz`（Mongo 驱动自动映射为 BSON Binary）。`REPLAY_INLINE_MAX_BYTES`（256KB）现在衡量**压缩后**字节数，而非原始 JSON 长度。
> - 只有两处稀疏/周期性路径会解压：Phase C 争议裁决（`judgeMismatch`）和反作弊离线抽样（`anticheatAudit.ts`），二者都要把 `frames` 转发给 gateway 的第三方无头重算，用 `@nw/shared` 的 `decompressReplayDoc`。**每局落库这条热路径永远不解压**。
> - `GET /match/{roomId}/replay`、`GET /share/replay/{shareId}`：服务器直接把仍压缩的 `replayGz`（base64）传给客户端（响应字段从 `replay` 改为 `replayGz`），解压下放到客户端（`client/src/net/gzip.ts` + `net/serverReplay.ts` 的 `decodeReplayGz`），省流量、也省服务器 CPU。
> - **冷存储层**：Mongo 7 天 TTL（`MATCH_RETENTION_MS`）到期后数据即永久丢失；现追加落盘归档 `server/metaserver/src/replayArchive.ts`——结算成功后 fire-and-forget 把 `replayGz` 字节 + 小型元数据 sidecar 写到同一 VPS 本地磁盘（`NW_REPLAY_ARCHIVE_DIR`，Docker 具名卷 `replay-archive`，见 `docker-compose.{prod,cloud}.yml`），保留 365 天（每日 sweep 清理），有争议的（`hashMismatch`/`cheat`）跳过（Mongo 里已永久保留）。`getMatchReplay`/`getReplayByShare` 在 Mongo 未命中时会回退读取该归档。**特意不用云对象存储**（Hetzner Object Storage 有固定月租，按当前回放数据量——峰值也到不了 10GB——划不来），留到有真实收入后再评估。

---


---

**接下页** → [`SERVER_API_INTERNAL.md`](SERVER_API_INTERNAL.md)：§7 已定/开放问题、§8 内部服务契约、§9 commercial、§10 worldsvc、§11 analyticsvc。
