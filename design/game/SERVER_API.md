# Notebook Wars — 服务器协议 / API 契约

> 创建：2026-06-13。本文件是客户端 ↔ 服务器的**接口契约**：REST 端点 + WebSocket 消息 + 锁步时序。
> 双端实现以本文件为准（客户端 `NetClient`/`SaveStore`/`EconomyClient` 与 `server/` 各 service）。
> 配套：`META_DESIGN.md`（系统/架构）、`META_TASKS.md`（任务）、`ECONOMY_BALANCE.md`（数值）；SLG 大世界（worldsvc）契约见 `SLG_DESIGN.md §14`；埋点见 `ANALYTICS_DESIGN.md §8`。
> 契约单一来源在 `server/contracts/`：`openapi.yml`（meta REST）+ `openapi-world.yml`（worldsvc REST）+ `openapi-auction.yml`（auctionsvc REST）+ `transport.proto`（WS 控制面/数据面）+ `game.proto`（PlayerCommand，对服务器 opaque）+ `replay.proto`（录像），双端 codegen（见 `META_TASKS.md` C-2）。
> **⚠️ ADR-040（2026-07-14）**：`openapi.yml` 本身已是**生成产物**（文件头 `AUTO-GENERATED … DO NOT EDIT`）——真源是 `contracts/openapi/paths/<domain>.yml`（9 fragment）+ `openapi/schemas.yml`，改契约改 fragment 后跑 `npm run gen:api:contracts` 重新合并，**勿手改 `openapi.yml`**。

---

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

### 2.2 存档（save-service，`META_TASKS.md` S0-7）
```
GET  /save                                     → { save: SaveData, displayName?, publicId?, gatewayUrl? }  // 当前账号（顺带回带展示名 + 公开 id + gateway 地址）
PUT  /save     (If-Match: <rev>)  { save }     → { save: SaveData }      // 成功回推规范化后的存档
                                                 | 409 REV_CONFLICT { save }  // 当前云端值
GET  /match/history?limit=<1..50>              → { matches: MatchHistoryEntry[] }  // 最近对战（默认 20），按 ts 倒序
```
- PUT 只接受**客户端同步段**字段（progress / materials / pveUpgrades / equipped / flags）；服务器权威段被忽略（以服务端值为准回推）。
- **对战历史（`GET /match/history`，2026-06-15）**：从归档 `matches` 取当前账号视角的精简摘要（无录像/帧日志）。`MatchHistoryEntry = { roomId, mode(friendly|ranked), result(win|loss|unknown), opponentName?, opponentPublicId?, eloDelta?, ts }`——`result` 由 `matches.winner` 对比我方 side 推导（winner<0 / 未知 → unknown）；`opponentName`/`opponentPublicId` 与 `eloDelta` 取自归档时 enrich 进 `matches.players` 的快照（昵称在归档当刻定格，事后改名不回填；`eloDelta` 仅 ranked 成功结算时有）。查询走索引 `{ 'players.accountId': 1, ts: -1 }`。客户端 `StatsScene` 仅登录在线时拉取（离线显「登录后查看」）。

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

### 2.7 PvE 养成（服务器权威，ADR-006 / `PVE_INTEGRITY_PLAN.md §8`）

> `progress.cleared` / `progress.stars` / `materials` / `pveUpgrades` 自 ADR-006 起**服务器权威**——`PUT /save` 同步段收窄为仅 `equipped`/`flags`，这四段只能经下列端点写。奖励按 `@nw/shared/pveRewards.ts` 服务器重算，不信客户端自报数额。

```
POST /pve/clear    { levelId, stars, pveSnapshot?, replayRef? }
   → { save: SaveData, capped?: boolean, needsReplay?: boolean, verifyId?: string }
POST /pve/verify   { verifyId, frames }        → { save: SaveData, status: 'verified'|'rejected'|'unverified' }
POST /pve/upgrade  { upgradeId }               → { save: SaveData } | INSUFFICIENT_MATERIALS
```

- **`/pve/clear`**：校验 level 存在 + **已解锁**（前置关在 `progress.cleared` 内）+ `stars≤3` → 按 `grantForClear(levelId,isFirst)` 在**每日上限**（`PVE_DAILY_CLEAR_REWARD_CAP`，按 `dayKey` 原子计数，类比 `victoryDaily`）内发材料；首通额外发首通奖励 + 解锁下一关 + 记星（取 max）→ 原子写 `progress/stars/materials`（rev 守卫）→ 回推权威 save。超上限：仍写 progress/stars，材料不发（`capped:true`）。
- **抽检复算（L1，复用 S1-J 对等裁判）**：`shouldSpotCheck` 命中（首通恒查 / 开局 `pveSnapshot` 与服务器权威 `pveUpgrades` 不符「开局战力不符→必作弊」/ 按 `PVE_VERIFY_SAMPLE_RATE` 随机）→ 暂扣材料、记 `pveVerifications{status:pending}`、回 `{needsReplay:true, verifyId}`；客户端补传录像帧调 `/pve/verify` → meta 经 `gateway.judge` 派第三方无头复算 → 复算星数 ≥ 声称则发材料(`verified`)，< 声称则不发(`rejected`)，无裁判可裁则 benefit-of-doubt 照发(`unverified`)。
- **`/pve/upgrade`**：服务器按 `PVE_UPGRADE_COSTS` 校验材料足够 → 扣材料 + `pveUpgrades[id]+1` → 回推 save。**仅在线**（离线客户端禁用入口，离线通关入本地 `pendingClears` 队列、上线 flush）。
- 两端点均返回完整权威 SaveData（客户端 adopt 镜像，同经济回执）。

### 2.8 装备养成（服务器权威，ADR-010 / ADR-012 / `EQUIPMENT_DESIGN.md §18`）

> 装备实例段（`equipmentInv`）移出 `PUT /save` 可写范围，全部由 `/equipment/*` 服务器权威端点写（同 §2.7）。穿戴影响 SLG 战力，亦走专用端点不并进 `PUT /save`。所有变更类端点带客户端生成的 `idempotencyKey`，服务器记 (key→结果) 账本重放首次结果（不二次扣料/二次掷骰），范式借 commercial `deliveredOrders`。

```
POST /equipment/craft    { defId, idempotencyKey }                          → { save, instance|stackDelta }
POST /equipment/enhance  { instanceId, idempotencyKey }                     → { save, success, instance, consumed }
POST /equipment/salvage  { instanceIds[], idempotencyKey }                  → { save, refunded } | NOT_SALVAGEABLE
POST /equipment/reforge  { instanceId, fuelInstanceId, lockedIndex?, idempotencyKey } → { save, instance, consumed }
POST /equipment/equip    { slot, instanceId|null, unitType? }              → { save, equipped }
```

- **`/equipment/craft`**：扣材料产 0 级基础装备（堆叠或新实例）；撞 **300 库存硬上限**（堆叠件不计）则拒/转等值材料补偿（§3.3）。
- **`/equipment/enhance`**：**服务器掷骰**（成功率表 80%…+8→9 仅 10%，绑定 `idempotencyKey` 首次结果防「重试改命」）、扣材料/金币、成功则 level+1；**失败只损耗、不掉级、不碎**（ADR-009/010）。
- **`/equipment/salvage`（ADR-012，分解回收）**：扣实例、返还 **70% 打造基础成本材料**（**强化投入不返还**）；**+5 及以上不可分解** → 返 `NOT_SALVAGEABLE`（可分解范围 +0~+4，含堆叠 0 级冗余件，可批量）。30% 损耗本身是温和 sink，主职清库存。
- **`/equipment/reforge`**：吞低一级同类装备作燃料、扣金币、重 roll 副词条（可锁一条）。
- **`/equipment/equip`**：纯穿戴状态变更（无随机）；穿戴数结构性自限 = 3 槽 × loadout 套数，不占 300 库存。
- 扣料 + 改实例 + 写账本**单事务**（Mongo 事务或乐观锁 rev 守卫），失败整体回滚。数字权威 → `ECONOMY_NUMBERS §5`。

### 2.8a 角色卡实例（服务器权威，`CHARACTER_CARDS_DESIGN.md §3` 融合改制 CC-2/CC-4）

> 卡实例段（`cardInv`）同样移出 `PUT /save` 可写范围，由 `/cards/*` 服务器权威端点写。喂卡升级=融合 5 张同阵营同级材料。

```
POST /cards/fuse    { targetId, materialIds[5], idempotencyKey }  → { card, save } | 400/404/409
POST /cards/lock    { cardInstanceId }                            → { save }   // 幂等：重复锁定成功
POST /cards/unlock  { cardInstanceId }                            → { save }
```

- **`/cards/fuse`**：恰好 5 张同阵营同级材料卡升目标卡一级；**锁定的材料被拒**；`idempotencyKey` 防重试双扣。
- **`/cards/lock` / `/cards/unlock`**：锁定卡不可作喂卡材料（防误吞）。

### 2.9 活动 / Live-ops（ADR-014 / `EVENTS_DESIGN.md`）

> 活动是叠在既有系统上的**受控时效容器**，不造第二条发奖路径：发奖走系统邮件（OPS）、任务计数复用 statKey 累加链、限定直购复用 commercial 商店、时钟服务器权威。**绝不信客户端自报进度**，加成乘子由服务器在产出结算时套用（受 `ECONOMY_NUMBERS §14` 封顶）。

```
GET  /events                                   → { events: ActiveEvent[] }   // 当前 active 活动 + 配置 + 我的进度
POST /events/claim   { eventId, milestoneId }  → { save, granted } | NOT_REACHED | ALREADY_CLAIMED | EVENT_ENDED
POST /events/redeem  { eventId, shopItemId }   → { save, granted } | INSUFFICIENT_POINTS | EVENT_ENDED
```

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

> 称号是唯一对外身份名片：`SaveData.titles[]`（服务器权威，`$addToSet` 授予，`PUT /save` 不可写）+ `equipped.title`（佩戴位）。称号随 `GET /save` 回推可展示，下列两端点为 L2-2 补的独立读/换接口（设计对齐，机制权威见 `TITLE_DESIGN.md`）。

```
GET  /titles               (JWT) → { titles: { id, source, seasonNo? }[], equipped }
PUT  /title/equip          (JWT) { titleId }  → { save: SaveData }  | 403（未授予）
```

- **`GET /titles`**：`source`/`seasonNo` 由 `parseTitleId`（`@nw/shared/titles.ts`，服务端/客户端共用）从 titleId 命名约定（`<来源>.<赛季?>.<key>`）派生。授予时间不入库，故不返回 `grantedAt`。
- **`PUT /title/equip`**：仅允许已授予称号（未授予 403）；空串 = 卸下；写 `save.equipped.title` 并回推完整 `SaveData`。
- 授予路径在 meta 内部单点 `grantTitle`（ranked 赛季结算 / SLG 赛季结算 / 成就 claim / admin 授予），非玩家可调。自动佩戴最高 `weight` 称号（`TITLE_DEFS`）。

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

### 3.2 服务器 → 客户端（`ServerMsg` oneof）
| `case` | payload | 说明 |
|---|---|---|
| `room_state` | `{ code, players: PlayerSlot[], phase }` | 房间状态变更广播 |
| `match_start` | `{ room_id, mode, seed, start_frame, local_side, opponent_name, opponent_public_id }` | 开局：模式 + 种子 + 起始帧 + 本方阵营 + 对手昵称/9 位公开 id（后两者纯展示，资料弹层用） |
| `frame_batch` | `{ to_frame, frames: FrameCmds[] }` | **服务器节拍**：每 100ms 一个批次（覆盖 3 个 sim 帧，M14）；`frames` 仅列非空帧，空窗 ⇒ 只有 `to_frame` 水位 |
| `conn_resync` | `{ seed, start_frame, log: FrameCmds[], cur_frame }` | 重连补帧：种子 + 非空帧日志 + 当前帧 |
| `peer_dc` | `{ side, grace_ms: 60000 }` | 对手掉线，进入 60s 等待重连（M10） |
| `match_over` | `{ winner_side, reason, mismatch?, elo?: { delta, after, rank_after } }` | 结束；`reason: base|disconnect|mismatch`；ranked 带 ELO 变化 |
| `room_error` | `{ code, message }` | 房间错误（不存在 / 已满） |
| `pong` | `{}` | 心跳回应 |
| `nation_msg` | `{ world_id, from_public_id, from_name, text, ts }` | 国家/世界公频新消息（B7，worldsvc 经 Redis pub/sub → gateway 扇出给同 world 在线玩家；REST 拉历史 `/nation/channel` 离线补全） |

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
- **登录级重连（2026-07-14 补文档）**：以上 `conn_resume`/`conn_resync`/60s 宽限只覆盖**同一 WS 会话内**的短暂断线；客户端进程重启/重新登录后另有一套独立机制——`GET /save` 内联返回 `activeMatch{roomId,gameUrl,ticket,mode}`（Redis 持久化，matchsvc 写入/metaserver 清除），client 登录后弹窗询问是否重连，确认则复用原始 ticket 直接重连回房间（同一 ticket 因 gameserver 握手忽略 exp 而长期有效）。详见 `MATCHSVC_DESIGN.md §9`。
- **同账号多端顶号（2026-07-18 补文档）**：新设备用同一 ticket 握手、发现该 room+side 已被一个仍存活的旧连接占用时（`RoomManager.join()`），gameserver **主动关闭旧连接**（`4409 'replaced'`，语义同 gateway §8.4 的账号级顶替），而不是像此前那样放任旧 socket 悬空、只等客户端后续显式发 `conn_resume` 才补救——修复前存在双连接并存、旧端仍可提交 `cmd_submit` 的隐患。旧连接被关闭后走的仍是标准断线流程（`onDisconnect` → 60s 宽限计时），新连接随后发来的 `conn_resume` 正常触发 `conn_resync` 补帧——即"先踢旧连接，重连补帧逻辑不变"。实现见 `gameserver/src/Room.ts` `takeover()` + `RoomManager.join()`。
- **结算（修订 M19）**：局末 game 把 `{hash×2, winner_side×2, 非空帧录像}` POST 给 **meta**（§8.3）；`friendly` meta 仅写 `matches`；`ranked` **meta** 算 ELO、写 `saves.pvp`（服务器权威）→ 把 `match_over.elo{delta,after,rank_after}` 经 game 转发给客户端。game 不连库、不判定。（订正 2026-07-07：ELO 结算已从 gameserver 迁至 meta，2026-06-14 落地，见 `MATCHSVC_DESIGN`；旧「S1 现实现为 gameserver 直算直写，待迁移」已过时。）
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
| `matches` | `{ roomId, mode, seed, players, winner, reason, hashOk, replay?, replayRef?, ts }` | 对局归档（friendly/ranked 都记）；`players[]` 归档时 enrich 每方 `{ side, accountId, displayName?, publicId?, eloDelta?, eloAfter? }`（昵称/publicId 快照定格、`eloDelta` 仅 ranked，供 `GET /match/history`）；`replay` 内嵌录像（小局，非空帧日志零成本内嵌，`cmds[].commands` 为 BSON binary opaque）；`replayRef` 指向外部存储（大局，待办）。索引 `{ 'players.accountId': 1, ts: -1 }` 支撑战绩查询 |
| `pveDaily` | `{ _id: accountId+dayKey, clears, ts }` | PvE 每日发材料的通关次数计数（`PVE_DAILY_CLEAR_REWARD_CAP`，按 dayKey 原子计数，同 `adsDaily`，§2.7） |
| `pveVerifications` | `{ _id: verifyId, accountId, levelId, stars, pveUpgrades, status, ts }` | PvE 抽检复算账本（`status: pending|verified|rejected|unverified`，存服务器权威 `pveUpgrades` 快照防漂移，§2.7） |
| `ladderSeasons` | `{ _id:'current', seasonNo, startAt, endAt, state }` | 天梯赛季时钟（**单文档**，admin roll 推进；§2.11 / SEASON §3） |

> 装备实例 v1 内嵌 `saves.equipmentInv`（小体量），膨胀后迁独立集合 `equipment`（索引 `accountId`、`accountId+instanceId`，§2.8 / EQUIPMENT §18.3）；活动 `EventDef` 配置由 admin 下发存运营库，玩家进度内嵌 save（§2.9）；`saves.pvp` 扩赛季字段 + `battlePass` 块无独立集合，加复合索引 `{ 'save.pvp.seasonNo':1, 'save.pvp.elo':-1 }`（§2.11）。
>
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
- **库迁移**：`gachaHistory`/`walletLog`/`iapReceipts` 已从 meta 库（`shared/src/mongo.ts`）移除，在 commercial 库重建为 `gachaHistory`/`ledger`/`recharges`（+ `wallets`/`orders`）。meta 库新增 `adsDaily`（广告 cap 计数）。
- **未实现**：`results[].dupeConverted` 改由 meta 据库存判重复（commercial 不持有 inventory）；重复退币 S5 暂缓（见 `COMMERCIAL_DESIGN §6`）；`recharge` 平台验签为 dev 桩。

---

## 10. worldsvc 公网接口（SLG 大世界，第四面）

> SLG 大世界为**独立公网 REST 面**（与 meta 分离、不同 base URL，反代 `/world` `/sect` `/nation` → worldsvc:18084 不剥前缀；订正 2026-07-07：`/family` 已迁 socialsvc、`/auction` 已迁 auctionsvc:18086）。**机器契约单一来源 = `server/contracts/openapi-world.yml`**（客户端 `gen-openapi.mjs` 生成 `src/net/openapi-world.ts`）；设计权威见 **`SLG_DESIGN.md §14`（接口/进程/库归属）+ §14.6（REST 端点清单）**。所有玩家端点走 `Authorization: Bearer <JWT>`（与 meta 同 token），大多带 `worldId`（所在 shard）。下表为简明清单，字段/形态以 `openapi-world.yml` 为准，不在此重复 schema。

### 10.1 World（地图 / 行军 / 养城）
```
GET  /world/map           ?worldId&cx&cy&r          → WorldMapView（视区，含视野 visible/ally）
GET  /world/map/sparse    ?worldId&cx&cy&r&lod      → WorldMapSparseView（鸟瞰只含占领格，lod=thin|mid）
GET  /world/tile/{tileId}                           → WorldTileView
GET  /world/me            ?worldId                  → PlayerWorldView（兵力/资源/产率/训练队列）
POST /world/join          { worldId }               → PlayerWorldView（自动落城）
POST /world/occupy | /world/abandon                 { worldId, x, y } → ok
POST /world/relocate      { worldId, x, y }         → PlayerWorldView（迁城，花 RELOCATE_COST）
POST /world/watchtower    { worldId, x, y }         → WorldTileView（建瞭望塔视野源，G5 V2）
GET  /world/march         ?worldId                  → MarchView[]
POST /world/march         { worldId, fromX,fromY, toX,toY, kind, troops, teamId? } → MarchView
POST /world/march/{marchId}/recall  { worldId }     → ok
POST /world/sweep         { worldId, fromX,fromY, toX,toY, troops } → MarchView
POST /world/troops/train  { worldId, qty }          → PlayerWorldView
POST /world/troops/speedup{ worldId, coins }        → PlayerWorldView
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

### 10.3 Family（家族）
```
GET  /family/list         ?worldId                  → FamilyView[]
GET  /family/{familyId}                             → FamilyView（含成员）
POST /family/create       { worldId, name, tag }    → FamilyView
POST /family/join | /family/leave | /family/dissolve { worldId, familyId? } → ok
POST /family/kick | /family/role  { worldId, targetId, role? } → ok
POST /family/message      { worldId, body, senderName? } → { id }（经 gateway 扇出家族频道）
GET  /family/channel      ?worldId&familyId&before?&limit? → FamilyMessageView[]
```

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

> 第八应用进程（端口 18085，连 `notebook_wars_analytics`，反代 `/analytics`）。无状态、不连业务库，仅复用 `NW_JWT_SECRET` 验签取 `accountId`。**写入 fire-and-forget**（`writeConcern:{w:0}`，客户端失败静默丢弃，不影响游戏）。机器契约（追加进 `openapi.yml`）见 `ANALYTICS_DESIGN.md §8`。

```
GET  /analytics/config                              → AnalyticsConfig   // 公开无鉴权；session 启动拉一次采集开关/采样率
POST /analytics/events  (JWT 可选)  AnalyticsEventBatch → 200（不代表落盘）  // 批量 ≤100 条/请求；关闭场景用 navigator.sendBeacon
GET  /internal/query    (X-Internal-Key)            → 聚合结果   // 仅 ops 后台调（漏斗/DAU/关卡通过率），玩家不可达
```

- **`AnalyticsConfig`**：`{ enabled, defaultSample, events: { [name]: { enabled?, sample? } } }`——服务端控制开关，不发版即可调粒度；客户端拉取失败回退 `enabled:false`（安全退化）。
- **`AnalyticsEventBatch`**：公共属性（`session_id/device_id/platform/os/game_version/locale`）放 batch 根层，每条 event 仅 `{ event, ts, props? }`（减传输体积）。`POST /analytics/events` JWT 可选：有 token 附 `user_id`，否则匿名设备。
- 不记请求 IP；账号注销按 `user_id` 批删事件（GDPR，§2.10）。事件分类 / 漏斗 / 数据库见 `ANALYTICS_DESIGN.md §5/§6/§9`。
