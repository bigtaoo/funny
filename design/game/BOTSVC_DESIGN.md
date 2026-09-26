# Notebook Wars — botsvc 机器人玩家服务设计

> 创建：2026-07-13。本文件设计 **botsvc（独立机器人玩家进程）**：冷启动期用机器人填充匹配池/SLG世界人气，模拟真实玩家登录/下线/打关卡/匹配/玩SLG。
> 配套阅读：`META_DESIGN.md`（服务拓扑/内部密钥）、`MATCHSVC_DESIGN.md`（§8 现有 `match_bot_fallback` 排位超时兜底代打，与本文机器人是两套独立机制，见 §1 决策 B1）、`SOCIAL_SVC_DESIGN.md`（家族数据模型）、`SLG_DESIGN.md`、`GATEWAY_DESIGN.md`。
> 状态：**已实现**（2026-07-14 全量落地：§3.2 SLG 节奏 + §1-B3 真实 gateway/gameserver 排位对战 + 1000 bot 负载实测；已在 `docker-compose.prod.yml`、`ecosystem.config.cjs`、`dev-up.ps1`）· 权威：本文（botsvc 设计基准）· 更新：2026-09-03
>
> **订正 2026-09-03**：本行与 `design/README.md` 那一行**都**一直写着「设计中」，而 `server/botsvc/src/` 已是
> 21 个文件 / 约 6.9k 行、自带 protobuf codegen、在 prod compose 里以 ~300 bot 常驻在线运行。§8 的开放问题
> 清单本身早已全部打勾（含 1000 bot 实测），只有这一行没跟。

---

## 0. TL;DR

- **botsvc = 独立进程，持有 1000 个机器人账号池，目标稳态同时在线 100**，通过公网协议（跟真实客户端一样：metaserver REST 登录 / gateway WS 控制面 / gameserver WS 数据面 / socialsvc REST / worldsvc REST）驱动机器人行为，不走任何"抄近路"的内部直写数据（唯一例外：充值模拟，见 §5）。
- **不占用真实玩家的登录名额**：容量逼近上限时机器人**优先被下线**，真人排队/被踢是最后手段（分层降级，见 §4）。
- **充值分层复用 commercial 现有内部端点**（`/internal/monthly-card/buy`、`/internal/starter/buy`）模拟付费状态，**绝不触碰真实支付网关**。
- **家族任务不做语义理解**，用"任务类型 → 固定动作"的数据驱动映射表（§6）。
- 机器人系统落地后，跑一次 **3000 机器人满载压测**验证 §4 的降级链路和真实瓶颈层（本文档暂不含压测结果，留 §8 记录）。

---

## 1. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| B1 | **botsvc 是全新的独立进程，与 matchsvc 现有 `match_bot_fallback`（排位超时临时代打）是两套不同机制**，互不覆盖 | 现有机制是"真人排队太久时给一次性本地 AI 对局"，产生不了持久账号、不进家族、不刷 SLG；本设计要的是**长期存在、有身份、有养成状态**的机器人玩家 |
| B2 | **机器人是"缩水的真实客户端"，不是"直写数据库的假数据生成器"** | 机器人经 metaserver 登录拿 JWT、经 gateway/gameserver 走真实 WS 协议、经 socialsvc/worldsvc 走真实 REST——这样机器人产生的服务端负载和真人等价，压测结果才有意义；也避免机器人数据和真实业务逻辑（状态机/校验）脱钩产生脏数据 |
| B3 | **机器人对战由 `@nw/engine` 的 `AISystem` headless 驱动指令流**，复用 `MATCHSVC_DESIGN.md §8` 已有的 1-10 级难度曲线，不是新写一套 AI | 战斗决策逻辑已经存在且经过测试覆盖，机器人只需要"有个账号+真实连接把 AISystem 的输出灌进去"，避免重复实现 |
| B4 | **账号打 `isBot: true` 标记**（`accounts` 集合新增字段，metaserver） | 用于 ops/analytics 口径剔除机器人流量、排行榜/统计报表过滤；**不用于禁止匹配到真人**——机器人的价值恰恰是在真人稀少时填充匹配池，isBot 只是"事后能分清谁是谁"，不改变匹配算法本身 |
| B5 | **容量降级顺序：先下线机器人 → 再排队真人登录 → 最后才踢真人挂机**（§4） | 机器人断线重连零感知成本，真人排队/被踢是真实体验损失，牺牲顺序必须严格分层 |
| B6 | **充值模拟只调 commercial 现有内部端点，不新增支付相关代码** | `/internal/monthly-card/buy` 和 `/internal/starter/buy`（`PRODUCT_STARTER_GROWTH`）已支持内部密钥直调、跳过真实 IAP 验单，机器人复用即可；新增代码路径 = 新增给真实支付开后门的风险面，能不加就不加 |
| B7 | **家族任务用数据驱动映射表，不做任务语义解析** | 机器人"看懂任务"是过度工程；任务类型枚举有限，查表 → 固定动作（捐献/发起战斗/放弃）足够，新任务类型只需加一行映射 |
| B8 | **机器人不参与拍卖行、不发社交聊天**（默认行为） | 用户拍板：大部分时候不挂拍卖也不参与社交，降低对拍卖经济和社交内容的干扰；仅做加入/离开家族、参与家族任务、SLG 基础节奏（升级建筑、偶尔攻城） |

---

## 2. 进程与部署

```
server/botsvc/          独立 npm workspace，端口 18087（仅内部管理面，不对客户端公网暴露）
  内部管理 API（X-Internal-Key，供 admin/ops 调）：
    GET  /internal/bots/status         → { total, online, targetOnline, sheddingLevel }
    POST /internal/bots/scale          { targetOnline }        → 调整目标同时在线数（默认100）
    POST /internal/bots/pause          { }                     → 立即下线所有机器人，停止新登录
```

- **botsvc 对外表现 = 一堆客户端**：它不接收玩家请求，只作为 N 个并发"机器人会话"的宿主进程，每个会话内部是一个状态机（§3），通过公网协议主动去连 metaserver/gateway/gameserver/socialsvc/worldsvc。
- 不连任何业务数据库；机器人的账号数据本来就落在 metaserver/socialsv/worldsvc 各自的库里（跟真人账号同库同表，靠 `isBot` 字段区分）。
- 部署上与其余服务同级加入 `server/dev-up.ps1` 和 `docker-compose*.yml`（已落地，见 §8：生产 `docker-compose.cloud.yml`/`docker-compose.prod.yml` 各有一个 `botsvc` 服务，`restart: unless-stopped` 常驻 300）；要临时停掉整个进程用 `docker compose stop botsvc` 或 `POST /internal/bots/scale {targetOnline:0}`，不需要动其余服务的代码，也不需要 `NW_BOTSVC_ENABLED` 之类的代码开关（当初设想过、最终没做）。

---

## 3. 机器人生命周期与行为状态机

### 3.1 账号池与调度

- **账号池 1000，稳态同时在线目标 100**（§3.2 覆盖真人挤占时的动态降低）。
- 每个机器人账号：`deviceId = bot-{0001..1000}`，走 metaserver 现有 **匿名 device-login** 公网端点创建/复用账号（跟真实 Web/CrazyGames 玩家完全一样的入口，不新增账号创建 API）。
- botsvc 主循环维护一个"会话调度器"：
  - 未在线的机器人按泊松间隔随机挑选上线（模拟真人陆续登录，不是 1000 个同时排队）。
  - 在线机器人有一个随机会话时长（例如 10–60 分钟，具体数值留实现时按压测结果调），到期正常走登出流程下线，模拟真人玩一会儿就退。
  - 调度器目标：**同时在线数在 `targetOnline` 附近波动**，不要求分毫不差。
- **单次 tick 的纪律（2026-07-14 断线排查后加固）**：`scheduler.tick()` 由固定 `NW_BOT_TICK_MS` 定时器（默认 5s）无条件触发，而一次 pass 要遍历一个轮转分片的在线 bot 做家族/SLG 巡检——大机队下一次 pass 可能超过一个 tick 周期。因此：
  - **防重入门闩**（`ticking` 标志）：上一 pass 未跑完时，新到的 tick 直接跳过并告警一次，绝不叠加。否则多个 tick 循环并发会成倍放大 REST/撮合负载，正是把事件循环周期性打爆、导致对局漏掉 gameserver 心跳的元凶之一。
  - **巡检有界并发**（`NW_BOT_UPKEEP_CONCURRENCY`，默认 20）：把逐 bot 串行 `await tickFamily()/tickSlg()` 改成固定大小的 worker 池从共享游标取任务；单 bot 内 `tickFamily → tickSlg → tickBattle` 顺序不变，`tickBattle()` 仍 fire-and-forget。串行会让 pass 随机队线性膨胀，无界 `Promise.all` 又会一次性打出上千 REST——两者都要避免。
  - **巡检轮转分片（2026-07-15 加固，削峰）**：`runUpkeep()` 不再是"每 tick 遍历全部在线 bot"，而是把在线集合按 `NW_BOT_UPKEEP_ROTATIONS`（默认 3）等分成若干片，每次 tick 只处理其中一片，按游标轮转覆盖全部。单个 bot 的巡检节奏近似不变（约每 `tickMs × upkeepRotations` 巡检一次，默认 5s×3=15s，和旧版 `TICK_MS=15s` 全量一次等价），但把原本"每 15s 一次性打出全部在线 bot 的 REST 请求"拆成"每 5s 打出 1/3"，worldsvc/socialsvc 的 CPU 尖峰更矮更密，而不是每 15s 一次陡峰——更接近真实玩家陆续行动的分布，2 vCPU 小机上也更不容易瞬时打满。

### 3.2 单个机器人的状态机

```
offline → logging_in → lobby_idle ⇄ matchmaking → in_battle → lobby_idle → ...
                            ↓                                      ↑
                        slg_action ──────────────────────────────┘
                            ↓
                        family_task
```

- `logging_in`：metaserver device-login 拿 JWT → gateway WS 握手上线（presence 事件，跟真人一样触发好友上线通知等副作用，这是刻意的，因为机器人要看起来像真人）。
- `lobby_idle`：什么都不做，按权重随机决定下一步去 `matchmaking`（PvE 关卡 / PvP 排位）还是 `slg_action`。
- `matchmaking`：走真实 gateway→matchsvc 排队协议；配对成功后用 §1 B3 的 AISystem headless 驱动真实 gameserver WS 数据面连接完整走完一局（提交真实 cmd 流），局末走真实 `/internal/match/report` 结算路径——**跟真人打真人在服务器视角完全一样**。
- `slg_action`：调 worldsvc 公网 `/world/*` 做基础节奏（资源采集、建筑升级、偶尔发起攻城），**不挂拍卖**（B8）。
  **节奏与"发不发得出去"两件事都由 bot 自己判（2026-09-17）**：
  - **节奏**：`NW_BOT_SLG_INTERVAL_MS`（默认 45s，`bot.ts DEFAULT_SLG_INTERVAL_MS`）是同一个 bot 两次世界操作之间的墙钟下限。
    在此之前 `tickSlg()` 对调度器递给它的**每一个**巡检 pass 都动手，于是它的真实频率是 `tickMs × upkeepRotations`
    （5s × 3 = 每 bot 每 15s）的副产品——而那两个旋钮存在的理由是削 §3.1 的 CPU 尖峰，不是"一个 bot 该多活跃"。
    两者现在解耦：调度器想多久来一次都行，bot 自己最多这么频繁地动。
  - **发不发得出去**：升级请求**先在客户端算一遍付不付得起**（`affordableBuilding()`，照 worldsvc 的
    `CityBuildingsService.upgradeBuilding` 从 `@nw/shared` 的同一批常数镜像：队列槽位 → `buildGateReason` → `buildCost`），
    付不起就这一 tick 什么都不发。这跟真实客户端把买不起的那一行置灰、而不是点下去让服务端拒绝是同一个动作（B2）。
    服务端仍然是权威：镜像只可能让 bot 要得**比它有权要的更少**（快照里的 `resources` 是服务端读时结算的值，只随时间变大）。
    判据不是"省几个请求"，而是**那个请求从来就不可能成功**——见 §8 的 2026-09-17 条。
- `family_task`：见 §6。
- **登录失败卡死在 `logging_in`（2026-08-04 修复）**：`login()` 原先先置 `state='logging_in'` 再 `await meta.deviceLogin(...)`，deviceLogin 抛错时状态就再也回不去了——`scheduler.ts` 的 `spawnUpTo` 只从 `state==='offline'` 里挑候选重试，卡死的会话永远排不上重登；更糟的是它同时通过了 `spawnUpTo` 里 `state !== 'offline'` 的判断被塞进 `online` 集合，占着舰队名额却没有 token、什么都不做。修法：`deviceLogin` 包一层 try/catch，失败时把 `state` 复位为 `'offline'` 再重新抛出，让下一轮 `spawnUpTo` 能正常重试。
- **`logout()` 不取消进行中的对局（2026-08-04 修复）**：`logout()` 原先只清本地 `token`/`state`，`runBattle()`（`playRankedMatch`）留下的真实 gateway/gameserver WS 连接会继续跑到打完——`despawnDownTo`（容量降级，见 §4）调 `logout()` 本意是"立刻减负"，实际却让这条连接继续占着资源，降级完全没生效。修法：`BotSession` 持有一个 `battleAbort: AbortController`，`runBattle()` 开局时创建、结束时清空；`logout()` 调 `battleAbort?.abort()`。`battleSession.ts` 的 `playRankedMatch` 新增 `abortSignal?: AbortSignal` 选项——排队阶段 `enqueueRanked` 返回后检查一次 `aborted`（提前退出，不必再连 gameserver），已连上后则在 executor 里监听 `abort` 事件，跟其余失败路径一样统一走 `finish()`（`game.close()` + reject）。

### 3.3 家族与宗门（2026-09-26 重写）

**用户拍板**：机器人**只**申请机器人建的家族；机器人家族全满了，就由下一个找不到家族的机器人新建一个。
另有 2–3 个机器人建宗门，其余机器人家族的族长优先加入机器人宗门。

**旧实现从上线起就没成功过一次**（线上 2026-09-26 实测：`familyMembers` 里机器人 0 个，
botsvc 日志 `family` 失败累计 **123 万次**，最后一条错误显示为 `[object Object]`）。一共四处错：
① 调的 `/social/family/search?tag=` 传空串，服务端直接回 400 `tag required`；
② 就算搜到了，`join` 路径里传的是 TAG，服务端要的是 familyId（`fam:TAG`）；
③ 加入早已改成「申请 → 族长/长老审批」，旧代码不知道审批这一步，也没有任何机器人去审批；
④ 服务端错误信封是 `{code, message}` 对象，客户端直接 `new Error(对象)`，于是日志只剩 `[object Object]`。

**机器人家族怎么认**：`src/orgs.ts` 里有一张固定名册 `BOT_FAMILY_ROSTER`，共 64 个
（8 个形容词 × 8 个名词，如 `Red Quills` / `REQU`，TAG 取两个词各前两个字母，构造上唯一）。
64 × 30 = 1920 个名额，大于现有 1700 个机器人账号。名册第 k 格存在且 **name 与 TAG 都对得上**，才算机器人家族。
只比 TAG 的话，真人碰巧占了同名 TAG 就会被误认；两样都一样的概率可以忽略。
没有持久化：botsvc 仍然不带数据库，重启后照名册按 id（`GET /social/family/fam:TAG`）重新查一遍即可。

**没家族的机器人**（每 60s 一次）：
- 从第 0 格往后找第一个「存在、是机器人家族、没满」的格子，提交申请。
  计「满」时把本进程内还没被处理的申请也算进去，免得 30 个机器人同时挤一个只剩 1 个空位的家族。
- 如果先碰到一个还不存在的格子，说明前面的都满了，就由它自己用这一格的名字建家族。
  同一格同时只放一个机器人去建。
- 申请提交后 10 分钟内不再重复申请（服务端一个账号只能有一条待审申请，申请不过期也撤不回）。

**族长 / 长老**（每 60s 一次）：
- 审批全部待审申请，一律同意。家族满员后，剩下的申请全部拒绝，好让申请人尽快转去下一个家族。
- 族长每次提拔一名最早入族的成员当长老，直到有 2 名长老。这样族长不在线时也有人审批。

**普通成员**：每 10 分钟看一次，什么都不做。

**删掉的逻辑**：按繁荣度退族，也就是原来的 `FAMILY_PROSPERITY_LEAVE_THRESHOLD`。
机器人只进机器人家族，这条规则只会让它们互相拆台。

**宗门**（族长专属，只在当前赛季世界里；要等 `tickSlg` 已经进入世界、拿到 worldId）：
- 名册 `BOT_SECT_ROSTER` 有 3 个：`Ink Pact`/`INKP`、`Paper Crown`/`PAPER`、`Lead Legion`/`LEAD`。
- 家族名册第 0–2 格的族长，就是对应宗门的创始人。
  - 建宗门要 `SECT_CREATE_COST` = 5000 金币，而线上机器人金币最多 1450。
    所以创始人先调 commercial 的 `/internal/grant` 领一次 5000，orderId 为 `bot-sect-<deviceId>-<worldId>`，天然幂等，重试不会重复发。
    然后再调 `/sect/create`。
  - 做法和 §5 的充值模拟一样，都走内部接口，botsvc 自己不写任何支付代码。
- 其它机器人家族的族长，加入成员家族数最少、且没满（`SECT_FAMILY_CAP` = 30）的机器人宗门。
  一个机器人宗门都还没有时就等下一轮。
- 已知限制：如果家族的 `sectId` 挂在别的世界（上一个赛季）里，这里不处理，只跳过。
  目前机器人家族一个宗门都没有，等换赛季时再说。

**本地实测（2026-09-26）**：对本地 docker 栈跑了 40 个机器人（`NW_BOT_DEVICE_OFFSET=5000`），大约 5 分钟内：
- `Red Quills` 满员 30 人（族长 1、长老 2），多出来的 3 个申请被拒。
- 第 1 格 `Blue Inks` 由下一个机器人新建，已有 6 人和 2 名长老。
- 两个族长分别建出 `Ink Pact` 和 `Paper Crown`。
- 家族相关调用失败 **0 次**。
- 报错信封修好后，SLG 的失败第一次能读了：全是 `TERRITORY_NOT_CONNECTED`，也就是出征不守连地规则，下一步修。

**顺带发现**：两个宗门落在了**不同的世界**（`s1-4` 和 `s1-3`）。
`/world/season/join` 按账号分片，同一个家族的成员会分散在同季的几个分片里，而宗门是按世界建的。
所以在当前分片规则下，机器人宗门只能管到族长所在分片里的那部分成员。
要改就得改分片规则（让同家族进同一个分片），不在 botsvc 的范围内，先记在这里。

---

## 4. 容量分层降级

> 背景（用户拍板）：现有容量按 3000 同时在线设计。机器人和真人共享同一个容量池（同样占 gateway WS 连接名额），降级顺序必须先牺牲机器人。

| 在线人数（含机器人） | 动作 | 执行方 |
|---|---|---|
| < 2500 | 机器人正常按 `targetOnline`（默认100）运行 | botsvc |
| ≥ 2500 | **botsvc 开始批量下线机器人**（不是一次全砍，按会话逐步提前结束），直到腾出余量或机器人全部下线 | botsvc |
| ≥ 2800 | 若机器人已全部下线仍逼近上限，**真人新登录进排队**（gateway 现有能力，本设计不改） | gateway |
| ≥ 2950 | 挂机太久的真人才被踢，且需提示倒计时（此为 gateway/gameserver 既有或待建能力，**不在本文档范围**，仅记录顺序约束） | gateway |

- **botsvc 如何知道当前在线数**：直接轮询 gateway **已有**的 `GET /internal/stats → { online }`（内部端口 8090，OPS_DESIGN §4.1/§8 admin 监控同款端点），`cap`（3000）由 botsvc 自己的配置给出，两者相除得到分层阈值——**不需要 gateway 任何代码改动**。
- 阈值（2500/2800/2950）是初始值，压测（§8）后按实际瓶颈层校准，不是锚定数字。

---

## 5. 充值分层模拟

| 档位 | 占比 | 实现 |
|---|---|---|
| 不充值 | 50% | 无操作 |
| 月卡 | 30% | botsvc（持内部密钥）直调 commercial `POST /internal/monthly-card/buy { accountId, orderId }`，`orderId` 用 `bot-{id}-monthly-{ts}` 生成即可，走现有幂等逻辑 |
| 一次性 19.99（新手成长礼包） | 20% | botsvc 直调 commercial `POST /internal/starter/buy { accountId, productId: PRODUCT_STARTER_GROWTH, orderId }` |

- **档位在机器人账号创建时按权重随机分配一次，不动态变化**（现实里付费习惯也不会天天变）。
- 月卡到期后按同一档位续费（模拟持续付费用户），不充值档永远不充值。
- **红线**：这条路径全程走 commercial 已有的内部密钥端点，botsvc 不新增、不绕过任何支付/验单代码；生产环境部署 botsvc 时必须确认 `NW_INTERNAL_KEY` 与其余服务一致但**该密钥不能泄露给客户端**（本来就是内部服务间约定，风险面不变）。

---

## 6. 家族任务映射表

> 用户拍板：机器人不一定能"理解"具体任务，不做语义解析，查表执行固定动作。

```ts
// server/botsvc/src/familyTaskMap.ts（示意）
type FamilyTaskAction = 'donate_resource' | 'start_battle' | 'upgrade_building' | 'skip';

const FAMILY_TASK_ACTION_MAP: Record<string, FamilyTaskAction> = {
  donate_resource_x: 'donate_resource',
  kill_monster_x: 'start_battle',
  upgrade_building_x: 'upgrade_building',
  // 未收录的任务类型 → 'skip'（默认兜底，不强行凑动作）
};
```

- 机器人拿到家族任务后查表执行对应固定动作；查不到类型直接 `skip`，不强行完成，也不报错。
- 新增家族任务类型时，运营/开发只需要在这张表加一行映射，不需要改机器人调度逻辑——这是选它而不是"给机器人塞语义理解"的核心原因。

---

## 7. 与现有系统的边界

| 关注点 | 归属 | 备注 |
|---|---|---|
| 机器人账号/JWT | metaserver（复用现有 device-login） | 仅新增 `isBot` 字段 |
| 机器人 WS 连接（控制面/数据面） | gateway/gameserver（复用现有协议） | 无需改动，机器人是"又一个客户端" |
| 排位超时代打 `match_bot_fallback` | matchsvc（已实现，不变） | 与本系统并存，互不替代 |
| 机器人战斗 AI | `@nw/engine` `AISystem`（已实现，复用） | 本设计只负责"把它接到真实连接上"；`AISystem`/`DIFFICULTY`/`Prng`/`AIDifficulty` 因此从引擎内部符号提升为公共出口（`src/index.ts`），botsvc 是第一个外部消费者 |
| 机器人家族/家族任务 | socialsvc（复用现有 `/social/*`） | 仅 botsvc 侧加映射表，socialsvc 不改 |
| 机器人 SLG 行为 | worldsvc（复用现有 `/world/*`） | 不挂拍卖（auctionsvc 不受影响） |
| 充值模拟 | commercial（复用现有内部端点） | 不新增支付代码 |
| 容量信号 | gateway（复用现有 `GET /internal/stats`） | 无需改动 gateway |

---

## 8. 开放问题 / 后续

- [x] **SLG 基础节奏（§3.2 slg_action）已接入**（2026-07-14）：`server/botsvc/src/worldClient.ts` + `bot.ts#tickSlg`。首次 tick 调用 `/world/active-season` + `/world/season/join` 加入当季世界（服务器自动落城，不传坐标）；此后每 tick 按固定表轮转升级 P1 建筑（`/world/build/upgrade`），每 5 个 tick 尝试一次攻城（`/world/map/sparse` 扫描本城半径 40（= worldsvc `MAP_VIEW_MAX_RADIUS` 上限，2026-09-15 从 5 上调，见 §8 末条）内非己方 territory/base/stronghold 目标，`/world/march{kind:attack}` 出兵 30% 驻军）；找不到目标则退回升级建筑。不挂拍卖、不发社交聊天（B8 不变）。
- [x] **排位匹配 + 对战（AISystem over 真实 gateway+gameserver WS 连接，§1 B3）已接入**（2026-07-14）：
  - `server/botsvc` 新增自己的 protobuf codegen（`buf.gen.yaml` + `scripts/gen-proto.mjs`，完全照抄 `server/gateway`/`server/gameserver` 的模板，产出 `src/generated/{transport,game,replay}.ts`），新增 `ws`/`@bufbuild/protobuf`/`@nw/engine` 依赖。
  - `@nw/engine` 公共出口（`server/engine/src/index.ts`）新增导出 `AISystem`/`DIFFICULTY`/`Prng`/`AIDifficulty`——此前这些是内部符号，只被引擎自己的 `pvp` 模式内部调用；botsvc 是第一个从外部直接调用 `AISystem.decideTick` 的消费者，这是让本次增量成立所必需的最小公共 API 扩展。
  - `src/gatewayClient.ts`（控制面 `wss://<gateway>/gw?token=`，发 `room_create{mode:RANKED}`，等 `match_found`）+ `src/gameServerClient.ts`（数据面 `?ticket=`，等 `match_start`，之后收发 `frame_batch`/`cmd_submit`/`match_result`）+ `src/envelopeSocket.ts`（两者共用的 Node `ws` 帧编解码壳，无重连——中途断线即视为本局失败，回退 `lobby_idle`，重连会破坏 lockstep 假设）。
  - `src/engineDriver.ts`（`BattleEngine`）：以 `mode:'netplay'` 内嵌真实引擎模拟，**engine 本身严格 wire-side 一致**——`players`/`decks` 直接用 `MatchStart.topDeck/bottomDeck`，从不按"自己是谁"重新贴标签（`PlayerStats`/`matchStateHash` 是按 wire side 索引的契约，真实客户端从不做任何 relabel，botsvc 必须一致才能对上哈希）。`AISystem.decideTick` 硬编码只为引擎 Top side（owner=1，`state.topPlayer`）决策；当 bot 真实 wire side 是 Bottom（owner=0）时，不能直接把真实 state 喂给它（会读到对手的手牌、且方向几何是反的）——`buildMirroredView()` 构造一个只读镜像视图（`topPlayer`↔`bottomPlayer`互换、unit/building 的 `side` 翻转、`row` 按 `BOARD_ROWS-1-row` 翻转，列/攻击道不翻转，棋盘只在纵向对称），喂给 AISystem 后再把决策的 `row` 翻转回真实坐标、`owner` 改回真实 owner 才应用/上行。此外沿用真实客户端 `NetInputSource` 的 lockstep 语义——本地不做预测，自己刚决策的指令必须先 `cmd_submit` 上行、等服务器把它连同分配的 frame 一起用 `frame_batch` 回放回来才真正喂进 `engine.step()`。
  - `src/battleSession.ts`（`playRankedMatch`）串起全流程；`bot.ts` 新增 `matchmaking`/`in_battle` 状态，`tickBattle()` 按概率触发、**必须是 fire-and-forget**（不能被 `scheduler.tick()` await，否则一局比赛会卡住其余所有 bot 的 15s 心跳），错误一律吞掉退回 `lobby_idle`。
  - 测试：headless 双 `BattleEngine`（**故意用不同的 top/bottom 卡组**）互打（用内存 relay 模拟 gameserver 分帧广播）验证两端 `matchStateHash`/`winnerSide` 完全一致、恰好一方获胜（或都为平局）、且确定性可复现；`gatewayClient`/`gameServerClient` 针对真实 `ws` 假服务器验证编解码；`bot.ts` 状态机测试。**2026-09-03 补齐分支覆盖**（89.39% → 98.17%，177 例）：`protoCodec.ts`/`envelopeSocket.ts` 补上各自的专属测试文件（此前只被上层顺带跑过 happy path），并新增 `engineDriver.stubEngine.test.ts`——只桩掉 `createGameEngine`/`AISystem`、保留真的 `BOARD_ROWS`/`Side`/`GamePhase`，用来摆出真实对局摆不出的状态（棋盘上有建筑物时的镜像视图、AI 在 Bottom 决定 `upgrade_base`、没有 `game_over` 事件的终局）。详见 [`claudedocs/server-testing-coverage.md`](../../claudedocs/server-testing-coverage.md) 的 botsvc 一节。
  - `server/dev-up.ps1` 已加入 `botsvc` 进程 + `/health` 检查项（此前完全没有被拉起）。
  - **真实双 bot 排位对战 E2E 验证过程中揪出两个只有真实联调才会暴露的 bug**（headless 测试当时用了两个 bot 相同卡组/相同难度，恰好对称，把 bug 掩盖掉了）：
    1. `capacityClient.ts` 调 gateway `/internal/stats` 从未带 `X-Internal-Key` 头，导致 `Scheduler.tick()` 第一行就 401 抛错——bot 从来没能真正登录过。
    2. **（更关键）engineDriver 最初的实现把整个引擎按"自己永远是 Top"重新贴标签**（deck 和 owner 一起换），能让 AISystem 直接工作，但导致两个 bot 上报的 `winnerSide` 各自以为"我赢了"（哈希在两个 bot 卡组完全相同时又"碰巧"对得上，掩盖了问题，直到 `winnerSide` 不一致才在真实撮合里炸出来）；同时 deck 与引擎固定的 top/bottom 抽卡 PRNG 流（`config.seed` vs `config.seed^0xdeadbeef`）绑定方式也被这个整体重贴标签打乱，一旦两个真实账号的卡组内容不同就会真的模拟出不同的手牌。最终修复即上面的 `buildMirroredView()` 方案——engine 保持 wire-side 一致，只在喂给 AISystem 这一步做只读镜像。三场真实撮合验证 `reason=base hashOk=true`。
- [x] **1000 机器人负载测试（3000 满载压测的第一档）已跑（2026-07-14）**：`server/metaserver`+`gateway`+`matchsvc`+`gameserver`+`commercial`+`socialsvc`+`worldsvc`+`botsvc`（`NW_BOT_POOL_SIZE=1000 NW_BOT_TARGET_ONLINE=1000`）全套真实起在主目录（非 worktree）。
  - 爬坡到 1000/1000 在线后稳定运行，各服务日志零报错，全部 node 进程加起来内存约 1.8GB，CPU 轻松，机器完全扛得住这个量级。
  - 排位撮合表现很好：matchsvc 日志显示机器人入队几乎从不排队等待（`queueSize` 几乎全程 0/1 之间），入队到配对通常 1-3 秒内完成。
  - **过程中炸出一个严重 bug并修复**：`@nw/engine` 的编译产物（`dist/`）在这次操作的主目录里没有跟着 merge 重新构建（dist 被 gitignore，每个 checkout 各自需要 `tsc -b`）——第一场机器人对战触发 `new Prng(...)` 时用的是没有 `Prng`/`AISystem` 导出的旧 dist，直接 `TypeError` 崩溃，**把整个 1000-bot 进程全炸了**（不是单个 bot 会话失败）。重新构建 dist 后恢复。
  - **顺带修的健壮性缺口**：`battleSession.ts` 的 `onMatchStart`/`onFrameBatch` 是同步 WS 消息回调，之前没有 try/catch——任何一局比赛里的偶发异常都会让整个 botsvc 进程崩溃、上千个 bot 全部掉线重来。已加防护（提交 `91e03904`），现在单局出错只会让那一局失败。
  - 已知架构特点（非 bug，记录以免将来误判）：bot 只在真正打排位时才短暂连接 gateway WS，不像真人那样全程保持大厅连接——所以 gateway `/internal/stats` 的 online 数（§4 容量分层信号）不会把"已登录但空闲"的 bot 算进去，只会看到"正在打排位"的瞬时连接数。这意味着 §4 的分层降级阈值目前只对真人+正在战斗的 bot 的 WS 连接数生效，不覆盖"登录但空闲"的 bot 数量——如果这点重要，需要额外设计。
  - 3000 满载压测（原计划的完整量级）仍未跑，结果回填本节，用于校准 §4 阈值。
- [x] **1000 机器人负载测试（生产 VPS 版）已跑（2026-07-14）**：目标从"本机全栈"换成打**线上生产后端**（Hetzner CX23，2 vCPU / 4GB，`128.140.41.98`，域名 `api.gamestao.com`，库为 MongoDB Atlas M0）。前置踩坑：botsvc 代码虽已随 `main` 合上 VPS，但**从没被真正部署**——它不在 `docker-compose.cloud.yml` / `docker-compose.prod.yml` / `Dockerfile` 里，宿主机也没装 node。跑法：用 `node:20` 容器挂载 `/root/funny` 手动 `npm ci` + 按序 `tsc -b shared && tsc -b engine && tsc -b botsvc`（`tsc -b botsvc` 单独跑会报 `@nw/engine` 找不到，必须先显式编 shared/engine），再把 botsvc 作为一次性容器挂进 `server_default` 网、按服务名连内部端口（`metaserver:8080`/`gateway:8090`/`gateway:8082/gw`/`worldsvc:18084`/`socialsvc:8085`/`commercial:8092`，`NW_INTERNAL_KEY` 复用 `server/.env`），`NW_BOT_HOST=0.0.0.0` 起步 `TARGET_ONLINE=100`，用 `/internal/bots/scale` 阶梯拉 100→500→1000。
  - **结果：满员 online 1000/1000 达标，全程各服务 `ERROR=0`、无崩溃/重启。** 内存与 Atlas 全程无压力（可用内存始终 ≥1.8GB，swap 几乎为 0；担心的 M0 512MB 存储 / 500 连接上限**均未触发**，零连接错误）。**CPU 是唯一瓶颈**：集中登录+开局的爬坡瞬时 load 冲到 ~7（2 核，约 3.5×），但稳态（~940–1000 在线）load 回落到 ~3.3（1.6×），机器扛得住。各服务里 botsvc 自身最吃 CPU（~60%，半核多），其次 socialsvc/worldsvc/gameserver。充值模拟基本没触发（commercial 数分钟 0 次）。
  - **发现真实问题（待查，非容量问题）**：排位对战结算 `reason` 严重偏向 `disconnect`（base : disconnect : mismatch ≈ 1 : 8~9 : 少量），干净打完的极少——与本机那次全 `reason=base` 形成对比。差别在于生产数据面要走 `bot → wss://api.gamestao.com/ws → Cloudflare → caddy → gameserver` 这一跳（CF 100s 空闲超时/延迟），叠加 CPU 超载把 lockstep 帧节奏拖断。这是 botsvc/数据面链路问题，不影响"服务器能否扛 1000 在线"的结论，但要专门排查（考虑数据面 WS 走内部地址而非绕公网、或放宽 lockstep 超时）。
  - 测试结束已 `docker rm -f nw-botsvc` 停掉、删掉含密钥的临时 env 文件；写进 Atlas 的 ~1000 个 `isBot` 账号及对局/SLG 数据**尚未清理**（清理需另写走服务端的脚本，谨慎操作生产库）。
- [x] **单服务器容量上限测试（bot 离机版，2026-07-14）**：为把 botsvc 自身 CPU 从被测机剥离，用**本地机器**跑 700 bot（`NW_BOT_DEVICE_OFFSET=1000` → `bot-1001..1700`，避开 VPS 现有 `bot-0001..1000`），全程只走公网面（`https://api.gamestao.com/api|/social|/world`、`wss://.../gw`、数据面 `wss://.../ws`），叠加 VPS 上原有 300 bot，测线上 2 vCPU / 4GB Hetzner。为让 botsvc 能以"外部纯客户端"身份对着公网面跑，加了三个开关（capacity 信号不可达时降级为不 shed、付费 bootstrap 失败不阻塞上线、deviceId 偏移），另加 `NW_BOT_SPAWN_BATCH` 加速爬坡。
  - **容量曲线**（total online → 15min load / 纯服务端 CPU，占 2 核 200%）：300→~3.0/~50%；400→2.8/~58%；600→3.0/~62%；800→4.0/~58%；**1000→~2.5/~60-70%**。内存全程 ~1.8GB used / ~1.9GB available 纹丝不动，Atlas 换成本机 `nw-mongo` 后仍无压力；**全程各服务 `ERROR=0`、无崩溃/重启**。
  - **结论：2 核 /4GB 单机轻松扛住 1000 同时在线 + 排位对局 + SLG/家族巡检，未饱和**（稳态 load ~2.5 ≈ 1.25×/核）。纯服务端 CPU 由 **worldsvc + socialsvc（bot 每 tick 的 SLG/家族 REST 巡检）+ caddy（WS 中继）+ gameserver（帧中继）** 主导；matchsvc/gateway/meta/mongo/redis 几乎可忽略。
  - **对真人的外推**：真人客户端各自独立进程，被测机上**根本没有 botsvc**——所以真实容量比上面还高（把 botsvc 那 ~30-47% CPU 让出来）。首个瓶颈是 CPU（非 RAM/DB），若纯服务端 ~65% 对 1000 近似线性，2 核饱和大致落在 **~2000-3000 同时在线**量级（bot 巡检节奏比真人更均匀密集，真实值需专门加压确认）。
  - 观测中的次要现象：被测机变忙时 VPS 上那个 300-bot botsvc 的 CPU 从 ~47% 被挤到 ~27%（宿主争抢下 bot 进程让路），与 §8 断线排查同源（单进程事件循环争抢），不影响服务端容量结论。
  - 遗留：本地 700 个 `bot-1001..1700` 账号已写入生产库，**未清理**（同 §8 上一批 ~1000）。
- [ ] 会话时长/上线间隔的具体分布参数（当前 §3.1 只给了量级），压测后按真实 CPU/内存曲线调整。
- [x] **把 botsvc 正式纳入部署（常驻 300，2026-07-14）**：不再手动 `node:20` 现编现跑。改动：`server/Dockerfile` build 阶段加 `COPY botsvc/package.json` + `tsc -b` 列表末尾加 `botsvc`（生成的 protobuf 已提交，无需 proto codegen），runtime 加 `COPY --from=build .../botsvc/{package.json,dist}`（`ws`/`@bufbuild/protobuf` 在共享 `node_modules`、`@nw/engine`/`@nw/shared` dist 已随其他服务拷入，只缺 botsvc 自己的 dist）；`docker-compose.cloud.yml` + `docker-compose.prod.yml` 各加一个 `botsvc` 服务，`restart: unless-stopped`（跟随重部署/重启自愈）、`NW_BOT_TARGET_ONLINE=300`（`.env` 可覆盖）、`NW_BOT_POOL_SIZE=1000`（复用 Atlas 里现有 `bot-0001..1000`）、按服务名连内部端口（`metaserver:8080`/`socialsvc:8085`/`worldsvc:18084`/`gateway:8090`/控制面 WS `gateway:8082/gw`/`commercial:8092`）。**与原计划的差异**：原设想 `NW_BOTSVC_ENABLED` 开关 + 默认不常开，实际按用户要求做成**默认常驻**（restart:unless-stopped），关停用 `docker compose stop botsvc` 或 `POST /internal/bots/scale {targetOnline:0}`，不需要改代码。botsvc 只有内部管理面 18087，不进 caddy 路由。验证：本机 `docker build` 通过（含 `tsc -b botsvc`），镜像内 `node botsvc/dist/index.js` 干净启动打印 `pool=1000; targetOnline=300` 无导入错误。**注意**：300 常驻会持续产生排位对局，`reason=disconnect` 高发问题（下条）在 300 规模仍部分存在，缓解补丁需确认已在部署分支上。
- [~] **排查排位对战 `reason=disconnect` 高发**（见上条生产压测发现）——**已诊断 + 单进程内缓解（2026-07-14）**：
  - **根因不是数据面链路**：干净 `base` 局能完整走完 `CF→caddy→gameserver`（中位 78s）。决定性证据是"连接→上报耗时"：`base` 78s vs `disconnect` 188s（拖到 ~128s 才掉 + 60s 宽限），断线局被明显**拖长**——排除了 CF 固定空闲超时和收尾竞态。300 在线时机器很闲（load 2.4/2 核、botsvc 单核 41%）断线率仍 ~78%，也排除"持续 CPU 打满"。
  - **真正机制**：上千对局全塞在 botsvc **单进程/单事件循环**里，gameserver 每 `BATCH_MS=100` 向每房间广播 `frame_batch`（`Room.ts`）→ 几百局的 batch 每 100ms 聚成一波同步 CPU；某 bot 一旦落后，`confirmedTo` 冲前、单次 `advance()` 一口气 step 一大堆帧，把自己更狠饿住 → 更落后（恶性循环）→ 漏掉 `HEARTBEAT_MS=30_000` 心跳（连续两次漏判死，`gameserver/index.ts`）→ terminate → `GRACE_MS=60_000` 宽限 → 判 `disconnect`；`mismatch` 是同一失同步的状态哈希分叉。真人各自独立进程，不受此争抢影响。
  - **本次修复（单进程削峰，未做 worker/多进程）**：① `advance(maxFrames)` 单次步进封顶 + battleSession 用 `setImmediate` 分块 drain，掐断"落后→大爆发→更落后"循环，两块之间让出事件循环给 ping/pong 和其他对局；② scheduler 防重入门闩 + 巡检有界并发（见 §3.1）。改动全在 botsvc，不碰数据面契约（心跳/batch 常量）。单测覆盖：分块 drain 与不封顶 drain 字节级一致（不改变/不 desync 模拟）、防重入短路、并发封顶。
  - **仍待办**：VPS 以 300 target 重跑压测，验证 `base:disconnect` 比例是否从 ~5:1 显著下降（用 `docker logs --tail N --timestamps`，`--since` 因时钟偏差不准）；若 1000 并发仍受限于单核吞吐，再评估 worker_threads/多进程（另开任务）。
- **`battleChancePerTick` 从 0.05 调到 0.025（2026-07-15）**：VPS 巡检发现 `server-botsvc-1`（300 目标在线）稳态 CPU ~48%、机器 load 2.2-2.7（2 核偏紧）。溯源：botsvc 自身 CPU 的主要驱动不是调度器的家族/SLG REST 巡检（轻量、网络受限），而是**并发对战数**——每个"打排位"中的机器人都在本机内嵌跑一份完整的 30Hz lockstep 引擎模拟（`engineDriver.ts`，跟真实客户端在手机上跑的是同一份逻辑，只是这份计算被转嫁到了服务器上）。稳态并发对战比例 ≈ `对局时长 / (对局时长 + 15s/chancePerTick)`；旧值 0.05 对应约 1/3 机器人同时在战斗中，调到 0.025 对应约 1/5。`server/botsvc/src/config.ts` 改了默认值（`NW_BOT_BATTLE_CHANCE` 环境变量仍可覆盖），**尚未随镜像重新部署到 VPS**。
- **未采纳**：曾考虑让机器人"一次性跑完确认帧"而不是像客户端一样逐帧模拟（省CPU的直觉）。核查后否决——`gameserver` 本身是硬性 30Hz 定频（`Room.ts` `FRAMES_PER_BATCH=3`/`BATCH_MS=100`，"sim 30Hz ÷ net 10Hz"），`matchStateHash` 逐帧算出、machine 必须和真实对手客户端帧数对齐，少算帧会导致 hash 不一致被判 `mismatch`。现有的"落后时分块经 `setImmediate` 让步"（`MAX_FRAMES_PER_ADVANCE=6`）正是 §8 上条 disconnect 根因修复本身，去掉它会复现同一个事件循环饿死 bug，不会省总 CPU（该 step 的帧数不变，只是让步时机不同）。
- [x] **SLG 建筑升级是一个 100% 必然失败的循环，跑了几个月没人知道（2026-09-17 发现并修复）**：
  线上 s2-0 心跳里 `POST /world/build/upgrade` 稳定 **6.0 次/秒**，29 小时 **629,382 次**，
  占 worldsvc 全部请求量的 **64%**——**一次都没成功过**。
  - **判据（直接查库，不靠推断）**：`playerWorld` 共 1752 份文档，`resources.ink > 0` 的只有 20 份、
    `buildings.desk > 1` 的只有 **4** 份（那 4 份是真人）。每个 bot 都是 `{desk: 1}`、
    `yieldRate = {ink: 100, paper: 0, graphite: 0, metal: 0, sticker: 0}`。
  - **为什么必然失败**：bot 的基地 footprint 只压住**一格**资源地，所以它只产一种资源；而
    `BUILD_COST_BASE`（`shared/src/slg/city.ts`）里**每一个**建筑都要 paper 和/或 graphite，高位键还要 sticker/metal，
    并且按那一节的 ★ 设计规则，**`ink` 是纯粹的养兵资源，没有任何建筑吃它**。
    一个 ink 基地的 bot 攒到天荒地老也买不起任何东西。（paper 基地能买 `graphiteMill`、graphite 基地能买 `paperTray`，
    这是唯二的单资源出口——所以"bot 完全不能发育"这件事**本身也是一个待拍板的设计缺口**，不是这次顺手能修的：
    要让 bot 真的发育，得让它先去占第二种资源地，那是行为设计不是性能修复。）
  - **为什么没人发现**：`scheduler.ts` 的 `runUpkeep()` 两行都是 `.catch(() => undefined)`——
    拒绝被整条吞掉，botsvc 日志干干净净，`/internal/bots/status` 报告一支健康的舰队。
    **这与 §8 上面那条"两个 mock 把攻城半径常数藏了两个月"是同一种失明**：一个跑在无限循环上的被静默错误
    不是降噪，是一个带着请求速率的盲区。
  - **修法三件**：① §3.2 的客户端付费判定（发不出去的就不发）；② `NW_BOT_SLG_INTERVAL_MS` 把节奏从调度器旋钮里解耦；
    ③ `runUpkeep()` 不再吞错——按 `family`/`slg` 累计计数，进 `/internal/bots/status` 的 `upkeepErrors`，
    并且每 60s 最多打一条汇总 `warn`（100 bot 规模下逐条打日志本身就是事故）。
  - **为什么这算 SLG 性能修复**：七个后端服务共用同一个 Atlas 共享层集群，100 ops/sec 是整个后端共享的一个令牌桶
    （`WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md` §九）。这 6 次/秒纯废请求消耗的正是真人每一次点击要排队等的那个桶。
    完整的测量与往返次数模型见那份审计的 §十一。
  - **门禁**：`bot.test.ts` 5 例（单资源 bot 零升级请求 / 选付得起的键而不是轮转的下一个 / 队列满时不发 /
    一个 interval 只动一次 / **成本断言：10 个 tick 里 `/world/me` 只许调 2 次**——客户端判定必须是白送的，
    不能用它省下的那个请求去换）、`scheduler.test.ts` 3 例（失败计入 `status()` / 一条失败不打断整队 / 每 interval 一条汇总日志）。
    四个变异全部按预期变红（去掉资源判定、去掉队列判定、去掉 interval 门、把 `/world/me` 改成每 tick refetch、恢复 `.catch(() => undefined)`）。
- **VPS 又发现一次同款遗留容器（2026-07-15）**：`nw-botsvc`（手动 `docker run` 忘加 `--rm` 的旧压测容器，Exited 状态，已跟 `server-botsvc-1` 正式部署重复）——与本节上面 2026-07-14 那次 `nw-botsvc`/`nw-mongo` 遗留是同一类问题（手动跑的容器不受 CI `--remove-orphans` 保护，因为那只清同一 compose project 内的孤儿）。已 `docker rm nw-botsvc` 清掉；用户后续会自行定期人工检查，未加 cron 自动清理。
- **补上 disconnect 链路的可观测性日志（2026-07-15）**：玩家反馈"机器人快输了就退出"，排查发现该链路此前完全没有日志，只能靠对局时长的旁证（本节上条）推断。已加日志（不改行为，纯观测）：`server/gameserver/src/index.ts` 心跳判死 `conn.ws.terminate()` 前记 `accountId/roomId/side`；`server/gameserver/src/Room.ts` 的 `onDisconnect`（WS 断开进宽限）、宽限到期判负、`leave()`（显式认输）三处各记一条 info/warn，带 `accountId/side/curFrame`；`server/botsvc/src/bot.ts` 的 `tickBattle()` 不再静默吞掉 `runBattle()` 的 reject，改为 `console.warn` 打出具体原因（区分是 `gameserver disconnected mid-match (code …)`、`match exceeded max wall-clock duration`，还是引擎内异常）。目的是下次复现时能直接从日志确认是心跳超时（§8 上条根因）还是别的异常，而不是只能靠对局时长旁证。
- [x] **`reason=disconnect` 高发的第二根因：客户端漏处理服务器终局消息（2026-07-16）**：VPS 常驻 100 bot 连续跑 13 小时后审计日志，发现 §8 上条 2026-07-14 诊断的"事件循环饿死漏心跳"机制**已不是当前主因**——13 小时里 `heartbeat missed` 命中 0 次，但 botsvc 自己记录的 1551 次对局尝试里 1550 次（~100%）仍以 `battle aborted` 收场（1408 次 `match exceeded max wall-clock duration` + 142 次 `ranked matchmaking timed out`），gameserver 侧 13 小时打了 1509 条 `WS closed mid-match`（1435 条最终 `grace period expired` 判负），涉及账号数恰好等于 `NW_BOT_TARGET_ONLINE=100`，说明是整个 bot 池的普遍性问题而非个别连接抖动。
  - **真正机制**：①一局里先算完的一方（`engineDriver.ts` 本地引擎到达 `game_over`）会立刻上报结果并调用 `game.close()`——但 `Room.ts` 的 `onDisconnect()` 之前不区分"这一方已经上报完结果才关闭"和"真的断线"，一律当断线处理，起 60 秒宽限计时器等对手（`WS closed mid-match` 告警，绝大多数在 60 秒内对手也算完了会自愈，只留误报噪音）；②如果对手没能在 60 秒内也算完（tick 处理进度天然有先后），宽限到期后 `Room.ts` 会把还连着的这一方判"获胜"、发一条 `match_over`——但 `server/botsvc/src/gameServerClient.ts` 的消息分发**之前只认 `matchStart`/`frameBatch`，完全没有 `matchOver` 分支**，这条消息被静默丢弃，"获胜"方就傻等一批再也不会来的 `frame_batch`，直到自己 `battleSession.ts` 里的 20 分钟挂钟兜底才以 `match exceeded max wall-clock duration` 收场——这正是 91% 那部分超时的根因；③另外 9% 的 `ranked matchmaking timed out` 是同类缺口在撮合侧的版本：bot 排队超过 matchsvc 的 `botFallbackMs`（30s，见 `MATCHSVC_DESIGN.md` §8 `match_bot_fallback`）后，服务器发来的是让客户端"本地模拟一局 AI"的 `match_bot`，但 `gatewayClient.ts` 同样没处理这条消息，bot 只能傻等到自己 60 秒的 `enqueueRanked` 超时。
  - **已修复**（三处，均已 `tsc --noEmit` 验证，尚未部署到 VPS）：`server/botsvc/src/gameServerClient.ts`/`battleSession.ts` 新增 `onMatchOver` 处理，收到服务器判定的终局立即结束，不再傻等 20 分钟；`server/gameserver/src/Room.ts` 的 `onDisconnect()` 加 `this.results.has(side)` 判断，已上报结果的关闭不再触发假断线告警/宽限；`server/botsvc/src/gatewayClient.ts` 新增 `matchBot` 处理，收到本地 AI 兜底信号时干净放弃本次尝试而非傻等超时。
  - **待办**：部署到 VPS 后对比 13 小时窗口内 `match exceeded max wall-clock duration` / `WS closed mid-match` 的频率是否显著下降，验证修复效果。
- [x] **攻城扫描半径 5 → 40：机器人从上线起就没出征过（2026-09-15，Grafana 巡检挖出）**
  - **现象**：worldsvc 心跳的路由表在 24 小时 288 次采样里**一次都没出现过 `POST /world/march`**，`marches` 集合为空。`bot.test.ts` 里"攻城 tick 会出兵"的用例一直是绿的——它把 `getWorldMapSparse` 和 `pickAttackTarget` 双双 mock 掉了，扫描半径对它不可见。
  - **根因**：`SIEGE_SCAN_RADIUS = 5` 是按赛季 1 的密集分片调的（s1-0：1644 人，基地最近邻切比雪夫距离 p50 = 4）。当季 s2-0 只有 108 人摊在 1500×1500 上，p50 = 42 / p90 = 85 —— 11×11 的窗口里**只有 2/108 个机器人能扫到目标**。拿线上 `tiles`/`playerWorld` 实算的命中曲线：r=5 → 2、r=10 → 4、r=20 → 17、r=40 → 54、r=120 → 106（均 /108）。
  - **连带代价**：`trySiege()` 返回 false 后会 fall through 继续升级，所以每 5 个 tick 白跑一对 `/world/me` + `/world/map/sparse`（2.4 天 27.58 万对），并且 `build/upgrade` 实际按 **5/5** 个 tick 跑（6.7 次/秒），而不是设计意图的 4/5。
  - **修法**：钉在 worldsvc 的 `MAP_VIEW_MAX_RADIUS = 40` 上——**再大也没用**，`getMapSparse` 会静默 clamp，写更大的数只是在源码里说谎。命中率 2/108 → 54/108；剩下那一半没有可达目标是这条路径的**已知天花板**（单次 sparse 调用看不到 40 格以外），不是 bug。
  - **门禁** `server/botsvc/test/bot.scanRadius.test.ts`：三例，fake 的 sparse 视图**按请求半径裁剪**（照抄 worldsvc 的窗口 + clamp），`pickAttackTarget`/`baseCoords` 用真实原型方法。①30 格外的邻居要能打到（把常数改回 5 → 红）；②超过 cap 的邻居打不到，退回升级（钉住已知天花板）；③请求的半径不得超过 cap，**cap 从 `worldsvc/src/worldTypes.ts` 源码里读**，所以那边一改这边就红（把 cap 改成 20 → 两例红，已验）。
  - **顺带**：这条也是 Atlas 限流（`WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md` 2026-09-15 补记）的减压项之一——它把 botsvc 打向 worldsvc 的写请求砍掉约 20%。
