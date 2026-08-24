# Analytics 设计文档


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `ANALYTICS_DESIGN.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Analytics 设计文档 | **本文** |
| §6 数据库、§7 analyticsvc、§8 OpenAPI 契约、§9 漏斗与留存、§10–§12 | [`ANALYTICS_DESIGN_BACKEND.md`](ANALYTICS_DESIGN_BACKEND.md) |

## 目录

- [§1 目标](#1-目标)
- [§2 架构](#2-架构)
- [§3 客户端 SDK](#3-客户端-sdk)
- [§4 采集配置（服务端控制开关）](#4-采集配置服务端控制开关)
- [§5 事件分类](#5-事件分类)
- [§6 数据库](#6-数据库)
- [§7 服务端 analyticsvc](#7-服务端-analyticsvc)
- [§8 契约（OpenAPI）](#8-契约openapi)
- [§9 漏斗与留存分析](#9-漏斗与留存分析)
- [§10 隐私合规](#10-隐私合规)
- [§11 任务拆分](#11-任务拆分)

---

## §1 目标

| 目标 | 说明 |
|---|---|
| 流失点定位 | 找到玩家在哪个场景/关卡/步骤放弃 |
| 转化漏斗 | 从落地 → 首局 → 留存 → 付费的每段转化率 |
| 功能使用率 | 哪些功能玩家根本不用（好友/盲盒/排位） |
| 数值调优 | 关卡通过率、升级节奏、经济曲线是否如设计 |
| 平台差异 | Web / 微信 / CrazyGames 各平台行为是否一致 |

**不做**：个人级行为监控（不追踪个人习惯）；实时大屏（离线聚合够用）；A/B 测试框架（当前体量不需要）。

---

## §2 架构

```
客户端 (Web / 微信 / CrazyGames)
    │
    │  GET /analytics/config   ← session 启动时拉一次采集配置
    │  POST /analytics/events  ← 批量上报（30s 定时 + 生命周期触发）
    ▼
analyticsvc (第八应用进程, 端口 18085)
    │  无状态；ingest 两端点（/analytics/config、/analytics/events）经反代**公开**给客户端，
    │  /internal/query 仅内网（X-Internal-Key）；不连业务库，仅连 notebook_wars_analytics
    │  JWT 验签复用 meta 公钥（可选，不连 accounts 库）
    │
    ├── MongoDB notebook_wars_analytics（独立数据库）
    │       collections: events(TTL 90d) / sessions / funnels_daily
    │
    └── GET /internal/query  ← tools/ops 管理后台调用（聚合查询）
```

**设计原则：**
- analyticsvc 不连业务库（M12），只读 JWT 公钥
- 写入 fire-and-forget：客户端上报失败静默丢弃，不影响游戏体验
- 采集配置从服务端下发，**不发版即可调整粒度**

---

## §3 客户端 SDK

### 3.1 职责边界

SDK 做三件事，调用方只管写业务事件：

| 职责 | 说明 |
|---|---|
| **自动注入公共属性** | `session_id / user_id / platform / os / game_version / locale / ts` |
| **批量缓冲 + flush** | 定时 30s + 多个生命周期触发点，见 §3.4 |
| **遵守采集配置** | 按服务端下发的 `sample` 率随机丢弃；`enabled:false` 的事件直接吞掉 |

### 3.2 调用方式

```typescript
// 初始化（session 启动时一次）
await analytics.init(platform, saveManager);

// 埋点（任意位置，同步、不阻塞）
analytics.track('game_end', { mode: 'campaign', result: 'win', level_id: 'ch1_lv2', duration_ticks: 3600 });
analytics.track('screen_view', { scene: 'LobbyScene' });
analytics.track('level_abandon', { level_id: 'ch1_lv3', phase: 'in_game', tick: 420 });
```

### 3.3 公共属性（自动附加，调用方不写）

```typescript
interface CommonProps {
  session_id:    string;   // 每次 app 启动新生成的 UUID
  user_id?:      string;   // accountId（已登录），缺省匿名
  device_id:     string;   // IPlatform 的 getOrCreateDeviceId()
  platform:      'web' | 'wechat' | 'crazygames';
  os:            string;   // navigator.platform 或 wx.getSystemInfo
  game_version:  string;   // __NW_BUILD_VERSION__（webpack 注入）
  locale:        string;   // 当前语言
  ts:            number;   // 客户端 unix ms
}
```

### 3.4 flush 触发策略

数据丢失的主要来源不是「间隔太长」，而是**玩家突然关闭**（关 Tab / 杀 App / 微信切后台）。
定时间隔只能覆盖正常游戏中的采样窗口，关键是补充生命周期触发。

```
触发条件                          优先级   说明
──────────────────────────────────────────────────────────────────
定时器到期（30s）                  低      兜底，正常游戏中的定期上报
队列超 50 条                      中      防止内存积压
场景切换（每次 screen_view 前）    中      天然检查点，**仅在已登录时**触发（见下）
visibilitychange → hidden         高      浏览器切标签 / 最小化 / 锁屏
beforeunload                      最高    关 Tab，用 keepalive fetch（不阻塞）
wx.onHide                         最高    微信小游戏切后台
```

**⚠ 离场用 keepalive fetch，不用 `sendBeacon`（2026-08-24 修正，此前本节写反了）**：
`beforeunload` 里普通 `fetch` 确实会被取消——但**带 `keepalive: true` 的不会**，那正是
规范给页面卸载准备的机制。而 `sendBeacon` 有一个致命限制：**它完全无法设置请求头**，
于是永远带不上 `Authorization`。服务端的 `user_id` 只从这个头解析（§7），
结果是**只走离场路径的事件 100% 匿名**——2026-08-24 生产库实测：
`session_end` 2848 条、`churn_signal` 2848 条，**无一条**能归属到玩家；
而搭上定时 flush 的事件（`gacha_draw` 具名 3297 / 匿名 247）完全正常。
流失漏斗恰恰建立在前两个事件上，等于整个漏斗没有身份维度。

```typescript
function flushSync(batch: EventBatch): void {
  const body = JSON.stringify(batch);
  // headers() 带上 Authorization；credentials:'omit' 是必须的——analyticsvc 回
  // access-control-allow-origin: *，而通配符 origin 对「带凭据请求」非法。
  if (typeof fetch === 'function') {
    void fetch(URL, { method: 'POST', headers: headers(), keepalive: true,
                      credentials: 'omit', body }).catch(() => {});
    return;
  }
  navigator.sendBeacon?.(URL, body);   // 无 fetch 的环境兜底：匿名数据也好过没有
}
```

代价：`Authorization` 头会让这个 POST 变成**预检请求**，而卸载时再跑一次 OPTIONS 往返
是不可靠的。所以 analyticsvc 同步补了 `Access-Control-Max-Age`（§7）——定时 flush 的
预检结果还是热的，离场这次就是单次请求。

**`screen_view` 检查点改为「已登录才 flush」**：`user_id` 是**按批**在入库时从
`Authorization` 解析的，所以提前 flush 会把此前排队的所有事件**永久**盖成匿名。
而首个 `screen_view` 就发生在开局几秒内、登录尚未完成——这个检查点一直在和它同批排队的
登录赛跑，`session_start` 因此匿名 355 次、具名仅 128 次。等待不丢数据：定时器、
50 条阈值、离场 flush 都照常触发，队列上限也仍是 200。真的全程未登录的玩家，
事件照样发出、照样匿名，那对他们本就是正确结果。

微信没有 `sendBeacon`，但 `wx.onHide` 回调里有足够时间完成一次 `wx.request`。

**加了生命周期 hook 之后，30s 间隔实际上几乎不会丢数据**：
玩家主动离开必然触发 `visibilitychange` 或 `beforeunload`；
场景切换覆盖了游戏内大多数「刚刚发生的关键事件」。

### 3.5 离线处理

微信小游戏网络不稳定时：
- flush 失败 → 事件留在内存队列，下次 flush 重试（最多 3 次，含生命周期触发）
- 超出重试或队列超 200 条 → 静默丢弃（分析用途，丢一点不影响结论）

---

## §4 采集配置（服务端控制开关）

### 4.1 配置结构

```json
{
  "enabled": true,
  "defaultSample": 0.1,
  "events": {
    "session_start":  { "sample": 1.0 },
    "session_end":    { "sample": 1.0 },
    "screen_view":    { "sample": 0.05 },
    "game_start":     { "sample": 1.0 },
    "game_end":       { "sample": 1.0 },
    "level_attempt":  { "sample": 1.0 },
    "level_complete": { "sample": 1.0 },
    "level_abandon":  { "sample": 1.0 },
    "card_play":      { "enabled": false },
    "shop_open":      { "sample": 0.5 },
    "shop_buy":       { "sample": 1.0 },
    "upgrade":        { "sample": 1.0 },
    "churn_signal":   { "sample": 1.0 }
  }
}
```

### 4.2 控制语义

| 字段 | 含义 |
|---|---|
| `enabled: false` | 完全关闭该事件，客户端直接吞掉（不采样、不发送） |
| `sample: 0.1` | 该事件 10% 概率上报，剩余 90% 丢弃（随机，per-event） |
| `defaultSample` | 未单独配置的事件使用此默认采样率 |
| 顶层 `enabled: false` | 关闭全部采集（紧急开关，如隐私合规问题） |

### 4.3 客户端缓存策略

- 启动时 `GET /analytics/config`，缓存到内存
- 拉取失败 → 用内置 fallback（`enabled:false`，即默认不采集，安全退化）
- 不做本地持久化，每次启动重拉（配置轻量，几百字节）

---

## §5 事件分类

### 5.1 会话层（Session）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `session_start` | `platform, os, locale` | app 启动 / 前台恢复 |
| `session_end` | `duration_sec, scenes_visited[]` | app 后台 / 关闭 |

### 5.2 场景层（Navigation）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `screen_view` | `scene` | 每次切换场景 |
| `ui_click` | `id, scene` | 控件点击（A9-8）；`id` 为稳定可读控件 id（如 `lobby.shop`），`scene` 自动附当前场景 |

scene 取值：`IntroScene / LobbyScene / LoginScene / CampaignMapScene / LevelPrepScene / GameScene / ResultScene / ShopScene / GachaScene / RoomScene / FriendsScene / CollectionScene / StatsScene / SettingsScene`

`ui_click.id` 是 `screen_view` 的细粒度补充：捕获**不切换场景**的点击、区分指向同一场景的多个按钮、以及被门控挡下的点击。经 `analytics.click(id)` 上报（`analytics/index.ts`）。首批接入首日关键的大厅主导航（`lobby.practice/ranked/campaign/room/social/shop/cards/stats/world/daily/events/profile`，见 `app/nav/lobby.ts`）；其余按钮按需在各自 handler 追加 `analytics.click('<scene>.<control>')` 即可扩展。

### 5.3 游戏层（Gameplay）

| 事件 | 必填属性 | 可选属性 | 说明 |
|---|---|---|---|
| `game_start` | `mode` | `level_id, opponent_type` | mode: campaign/pvp_ai/pvp_net/siege |
| `game_end` | `mode, result, duration_ticks` | `level_id, winner_side, elo_delta` | result: win/loss/draw/abandon |
| `level_attempt` | `level_id` | `stars_before` | 点击进入关卡 |
| `level_complete` | `level_id, stars` | `duration_ticks, materials_gained{}` | 通关 |
| `level_abandon` | `level_id, phase` | `tick` | phase: prep/in_game |

### 5.4 经济层（Economy）

| 事件 | 必填属性 | 可选属性 | 说明 |
|---|---|---|---|
| `shop_open` | — | `source` | source: lobby/result/prep 等入口 |
| `shop_buy` | `item_id, cost` | `currency` | 购买商品 |
| `shop_close` | `converted` | `time_sec` | converted=是否有购买 |
| `gacha_draw` | `pool_id, count` | `results[]` | count: 1 or 10 |
| `upgrade` | `unit_type, stat, level_after` | `cost{}` | PvE 养成升级 |
| `recharge` | `tier` | — | 充值（tier: small/mid/large） |

### 5.5 社交层（Social）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `friend_add` | — | 加好友成功 |
| `pvp_room_create` | `mode` | mode: friendly/ranked |
| `pvp_match_start` | `mode` | 成功匹配开局 |

### 5.6 流失信号（Churn Signals）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `churn_signal` | `reason, scene` | reason: background/explicit_exit/idle_10min |
| `tutorial_start` / `tutorial_complete` | `level_id` | 开始/完成新手引导（§9.6 引导漏斗用） |
| `tutorial_skip` | `step` | 跳过引导（`step:'tutorial'`，来自 `game.ts`；`step:'intro'` 已改用专属 `intro_skip`，见下） |
| `tutorial_step` | `level_id, phase, step_key, step_index` | 教程内部小步骤（§9.7 教程步骤漏斗用），`step_key` 见 `TUTORIAL_ORDERED_KEYS` |
| `nav_checkpoint` | `scene` | 场景级漏斗用（§9.7），100% 采样，仅在 `screen_view` 命中场景白名单时自动补发 |
| `login_gate_hit` | `scene` | 离线功能门控弹「需要登录」 |
| `intro_complete` / `intro_skip` | — | 首启故事 `IntroScene` 看完/跳过（`app/nav/auth.ts` `goIntro` 的 `onFinish(skipped)`），design-doc-audit-2026-07 补齐——此前这一步完全没有埋点。100% 采样，纳入 §9.6 `ONBOARDING_STEPS` 的 `intro_seen` 步骤 |

### 5.7 成就漏斗（Achievement，S9-8）

成就系统留存漏斗 = `session_start → achievement_unlock_toast → achievement_view_wall → achievement_claim`：达阈解锁（红点）→ 进成就墙 → 领金币。三事件均 `sample:1.0`（低频高价值，全采）。

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `achievement_unlock_toast` | `count` | 回大厅比对 stats 新解锁阶汇总弹一次（count=本次新解锁阶数）|
| `achievement_view_wall` | `online` | 打开成就墙（漏斗中段；online=登录在线才是有效领取入口）|
| `achievement_claim` | `ach_id, tier, coins` | 领取某阶成功、发金币 |

> 漏斗分析关注：解锁→看墙转化（红点是否驱动点进）、看墙→领取转化（领取摩擦）。**「无人达成条目」**（某成就长期零 `unlock_toast`）= 查询侧聚合分析（阈值过高/路径稀有），非独立事件——据此调阈值或下线冷门条目。

### 5.8 结算称号分布（Result badge，2026-07-22）

结算页给玩家的「称号/勋章」（`ResultScene` 的 `hero` 徽章，如 `[Efficient]`/`[Iron Defense]`）此前完全是客户端渲染、**无任何埋点**，导致「是不是每局都发同一个称号」只能靠玩家主观反馈、无法从后台核实。新增 `match_badges` 事件（`sample:1.0`，一局一条，低频高价值），在每处 game-over 钩子随 `game_end`/`level_complete` 一起发（PvP 网战、练习/bot、战役），用**与展示同一个** `matchBadgeTelemetry()`（复用 `computeBadges`）计算，保证「记录的 = 玩家看到的」。

| 事件 | 必填属性 | 可选属性 | 说明 |
|---|---|---|---|
| `match_badges` | `mode, result, hero, shown[]` | `level_id`, `kills, gold_spent, units_sent, dmg_dealt, dmg_taken, spell_hits, build_ticks` | `hero`=头徽章 key（玩家看到的称号，全 ≤0 时为 `none`）；`shown[]`=最多 3 个展示徽章；原始数值供后台**重新校准** `REF_*` 常量（见 §4.26 UI_DESIGN，那些常量目前是估算值）|

- **聚合查询**：analyticsvc `/internal/query?type=badge_dist&days=N` → `queryBadgeDist`，按 `(mode, result, hero)` 分组计数（计**局数**非设备数），返回 `{ mode, result, badge, count }[]`。经 admin `/admin/analytics/events` 透传，ops「Analytics」页按 mode 各出一张透视表（徽章行 × win/loss/draw 列 + 合计 + 占比条）。
- **健康判据**：某个 badge 在某 mode 下占比逼近 100% = 校准退化（人人同称号）；理想是多个徽章都有可观占比、且随打法变化。这正是 §4.26 把 `REF_EFFICIENT` 5→12 之后要盯的指标。

### 5.9 首次功能引导（Feature guide，design-doc-audit-2026-07）

`showFeatureGuide`/`withGuide`（`client/src/scenes/LobbyScene/overlays.ts` + `client/src/app/nav/lobby.ts`，机制见 `ONBOARDING_DESIGN.md` §4.1）此前**无任何埋点**——ONBOARDING_DESIGN §7 的漏斗节点「各功能首次引导 弹出/关闭/再看」完全没有数据。新增三个事件，均 `sample:1.0`：

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `feature_guide_shown` | `feature` | 首次打开某功能页时弹出引导卡（`feature` ∈ `match/shop/social/cards/daily/world/auction`，即 `withGuide` 的 `featureId`） |
| `feature_guide_closed` | `feature` | 玩家点「知道了」关闭引导卡（`clearGuide`），紧随其后才导航进入该功能 |
| `feature_guide_replay` | `feature` | 通过页面内「?」按钮重新打开已看过的引导。**尚未产出数据**——`ONBOARDING_DESIGN.md` §8/§10 记录「各子页内「?」按钮未逐页接」是独立待办；本次只预留事件名 + 采样配置，避免该 UI 落地时又漏配采样 |

- **口径**：`shown`/`closed` 是配对的——`withGuide` 只在 `saveManager.featSeen(featureId)` 为 false 时才弹卡（并立即 `markFeatSeen`），所以同一账号同一 feature 理论上只会有一条 `shown` + 一条 `closed`（除非中途被销毁场景打断，见 `overlays.ts` 的 `destroyed` 早退分支，那种情况下两者都不会发）。
- **聚合查询**：`GET /internal/query?type=feature_guide_funnel` → `AnalyticsService.queryFeatureGuideFunnel(days, platform?)`，按 `props.feature` 分组统计去重设备的 shown/closed/replays，按关闭率（`closed/shown`）**升序**返回——关闭率低的（=玩家没关就走/引导没读完）排最前，与 `level_funnel` 的排序哲学一致（越可能有问题的排越前）。ops「Analytics」页新增一张卡，`replays` 列在「?」按钮接入前恒为 0。

---


---

**接下页** → [`ANALYTICS_DESIGN_BACKEND.md`](ANALYTICS_DESIGN_BACKEND.md)：§6 数据库、§7 analyticsvc、§8 OpenAPI 契约、§9 漏斗与留存、§10–§12。
