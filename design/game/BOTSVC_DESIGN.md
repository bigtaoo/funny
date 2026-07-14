# Notebook Wars — botsvc 机器人玩家服务设计

> 创建：2026-07-13。本文件设计 **botsvc（独立机器人玩家进程）**：冷启动期用机器人填充匹配池/SLG世界人气，模拟真实玩家登录/下线/打关卡/匹配/玩SLG。
> 配套阅读：`META_DESIGN.md`（服务拓扑/内部密钥）、`MATCHSVC_DESIGN.md`（§8 现有 `match_bot_fallback` 排位超时兜底代打，与本文机器人是两套独立机制，见 §1 决策 B1）、`SOCIAL_SVC_DESIGN.md`（家族数据模型）、`SLG_DESIGN.md`、`GATEWAY_DESIGN.md`。
> 状态：设计中。

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
- 部署上与其余 9 个服务同级加入 `server/dev-up.ps1` 和 `docker-compose*.yml`；生产环境可选择性关闭（`NW_BOTSVC_ENABLED=false`），冷启动结束、真实 DAU 稳定后直接停掉整个进程，不需要动其余服务的代码。

---

## 3. 机器人生命周期与行为状态机

### 3.1 账号池与调度

- **账号池 1000，稳态同时在线目标 100**（§3.2 覆盖真人挤占时的动态降低）。
- 每个机器人账号：`deviceId = bot-{0001..1000}`，走 metaserver 现有 **匿名 device-login** 公网端点创建/复用账号（跟真实 Web/CrazyGames 玩家完全一样的入口，不新增账号创建 API）。
- botsvc 主循环维护一个"会话调度器"：
  - 未在线的机器人按泊松间隔随机挑选上线（模拟真人陆续登录，不是 1000 个同时排队）。
  - 在线机器人有一个随机会话时长（例如 10–60 分钟，具体数值留实现时按压测结果调），到期正常走登出流程下线，模拟真人玩一会儿就退。
  - 调度器目标：**同时在线数在 `targetOnline` 附近波动**，不要求分毫不差。

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
- `family_task`：见 §6。

### 3.3 家族加入/离开

- 空闲机器人有概率申请加入一个开放家族（socialsvc `/social/family/*`）。
- **离开逻辑挂在家族活跃度上**：botsvc 定期（如每小时）轮询已加入家族的活跃指标（成员在线率/任务完成率，具体字段取 socialsvc 现有家族统计），低于阈值则退出重新找一个更活跃的家族——这是模拟真人"进了个死家族就跑"的行为，不是机器人自己发起破坏。

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
| 机器人战斗 AI | `@nw/engine` `AISystem`（已实现，复用） | 本设计只负责"把它接到真实连接上" |
| 机器人家族/家族任务 | socialsvc（复用现有 `/social/*`） | 仅 botsvc 侧加映射表，socialsvc 不改 |
| 机器人 SLG 行为 | worldsvc（复用现有 `/world/*`） | 不挂拍卖（auctionsvc 不受影响） |
| 充值模拟 | commercial（复用现有内部端点） | 不新增支付代码 |
| 容量信号 | gateway（复用现有 `GET /internal/stats`） | 无需改动 gateway |

---

## 8. 开放问题 / 后续

- [ ] 3000 机器人满载压测（用户拍板：botsvc 做完后跑一次）——结果回填本节，用于校准 §4 阈值。
- [ ] 会话时长/上线间隔的具体分布参数（当前 §3.1 只给了量级），压测后按真实 CPU/内存曲线调整。
