# Analytics 设计文档

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
analyticsvc (第九进程, 端口 18085)
    │  无状态，玩家不可达（反代不路由，仅内网）
    │  JWT 验签复用 meta 公钥（不连 accounts 库）
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
场景切换（每次 screen_view 前）    中      天然检查点，成本低，几乎消除窗口期丢失
visibilitychange → hidden         高      浏览器切标签 / 最小化 / 锁屏
beforeunload                      最高    关 Tab，用 sendBeacon（不阻塞）
wx.onHide                         最高    微信小游戏切后台
```

**`sendBeacon` 是关闭场景的关键**：`beforeunload` 里普通 `fetch` 会被浏览器取消，
`navigator.sendBeacon` 专为页面关闭设计，浏览器保证发出：

```typescript
function flushSync(batch: EventBatch): void {
  const body = JSON.stringify(batch);
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/analytics/events', body);   // 关闭时用
  } else {
    fetch('/analytics/events', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true, body });                        // keepalive fallback
  }
}
```

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

scene 取值：`IntroScene / LobbyScene / LoginScene / CampaignMapScene / LevelPrepScene / GameScene / ResultScene / ShopScene / GachaScene / RoomScene / FriendsScene / CollectionScene / StatsScene / SettingsScene`

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
| `tutorial_skip` | `step` | 跳过引导 |
| `login_gate_hit` | `scene` | 离线功能门控弹「需要登录」 |

---

## §6 数据库

### 6.1 选型：MongoDB（与业务库隔离的独立实例）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **MongoDB**（推荐） | 运维统一，JSON 事件天然匹配，TTL 开箱即用 | 聚合查询比列式慢 3–10× |
| ClickHouse | 分析查询快 10×+，列式压缩 | 新增运维负担，Docker 镜像 ~1GB |
| PostgreSQL + TimescaleDB | 时序专项优化 | 同上 |

**结论**：当前体量（DAU < 10k）MongoDB 聚合查询在秒级响应范围内，且运维成本最低。事件量超过 1 亿行时迁移 ClickHouse。

### 6.2 Collections

```
notebook_wars_analytics
├── events         原始事件（TTL 90 天）
│       { _id, session_id, user_id?, device_id, platform, os,
│          game_version, locale, event, props{}, ts: Date }
│       索引：{ ts: -1 } / { event: 1, ts: -1 } / { user_id: 1, ts: -1 }
│       TTL: expireAfterSeconds=0 on ts（配合 expireAt 字段）或 TTL index on ts 90天
│
├── sessions       会话摘要（永久，每 session 一行）
│       { session_id, user_id?, device_id, platform, os,
│          started_at: Date, ended_at?: Date, duration_sec?,
│          scenes_visited[], events_count }
│       索引：{ started_at: -1 } / { device_id: 1, started_at: -1 }
│
└── funnels_daily  每日预聚合（永久，ETL job 每小时跑）
        { date, platform, funnel_step, count, conversion_rate? }
        索引：{ date: -1, platform: 1 }
```

### 6.3 TTL 策略

| 集合 | 保留期 | 理由 |
|---|---|---|
| `events` | 90 天 | 原始事件量大，超期分析价值低 |
| `sessions` | 永久 | 轻量，留存/DAU 计算需要 |
| `funnels_daily` | 永久 | 聚合结果，体积小 |

---

## §7 服务端 analyticsvc

### 7.1 形态

```
server/analyticsvc/   (第九 workspace @nw/analyticsvc, CJS)
├── config.ts         NW_ANALYTICS_PORT / NW_ANALYTICS_MONGO_*
├── db.ts             MongoDB 连接 + 3 个 collections + 索引
├── service.ts        ingestEvents() / getConfig() / queryFunnel()
├── httpApi.ts        node:http + 路由（/health, /analytics/config, /analytics/events, /internal/query）
└── index.ts          启动
```

### 7.1a JWT 验签

analyticsvc 直接 import `@nw/shared` 的 `verifyToken`，复用同一个 `NW_JWT_SECRET` 环境变量：

```typescript
import { verifyToken } from '@nw/shared';

// POST /analytics/events：JWT 可选
const auth = req.headers['authorization'];
const token = auth?.replace('Bearer ', '');
const claims = token ? verifyToken(token) : null;  // null = 匿名设备
const userId = claims?.accountId ?? undefined;
```

不连 accounts 库，只做签名验证取 `accountId`。

### 7.2 端点鉴权策略

| 端点 | 鉴权 | 理由 |
|---|---|---|
| `GET /analytics/config` | 无（公开） | 匿名用户 session 开始时也要拉 |
| `POST /analytics/events` | JWT 可选（Bearer） | 有 token 就附 user_id，没有就匿名设备 |
| `GET /internal/query` | `X-Internal-Key` | 仅 ops 后台调用 |
| `GET /health` | 无 | Docker healthcheck |

### 7.2a 采集配置存储

**一期（A9-2）**：配置作为服务进程内的常量对象，`GET /analytics/config` 直接返回，无 DB 读写：

```typescript
// service.ts
export const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  defaultSample: 0.1,
  events: {
    session_start:  { sample: 1.0 },
    game_end:       { sample: 1.0 },
    level_complete: { sample: 1.0 },
    level_abandon:  { sample: 1.0 },
    screen_view:    { sample: 0.05 },
    shop_buy:       { sample: 1.0 },
    card_play:      { enabled: false },
  },
};

export function getConfig(): AnalyticsConfig {
  return DEFAULT_CONFIG;
}
```

**二期（A9-2b，运维后台接入后）**：配置存入 `analyticsConfig` 集合（单文档 `{_id:'global', ...config}`），`GET /analytics/config` 从 DB 读取，ops 页面可在线修改，无需重启进程。升级时做一次 `upsert` 写入默认值即可。

### 7.3 写入性能

- `POST /analytics/events` 接受批量（最多 100 条/请求）
- 后端 `insertMany(events, { ordered: false })`，单条失败不影响批次
- 不等落盘确认，`writeConcern: {w: 0}` 即返回 200（分析数据允许极少量丢失）

### 7.4 环境变量

```
NW_ANALYTICS_PORT=18085
NW_ANALYTICS_MONGO_URI=（缺省复用 NW_MONGO_URI）
NW_ANALYTICS_MONGO_DB=notebook_wars_analytics
NW_INTERNAL_KEY=（复用共享内部密钥）
```

---

## §8 契约（OpenAPI）

```yaml
# 追加进 server/contracts/openapi.yml

paths:
  /analytics/config:
    get:
      operationId: getAnalyticsConfig
      summary: 下发采集配置（无需鉴权）
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AnalyticsConfig'

  /analytics/events:
    post:
      operationId: postAnalyticsEvents
      summary: 批量上报事件
      security: []          # JWT 可选，缺省接受匿名
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AnalyticsEventBatch'
      responses:
        '200':
          description: 接收成功（不代表落盘）

components:
  schemas:
    AnalyticsConfig:
      type: object
      properties:
        enabled:       { type: boolean }
        defaultSample: { type: number }
        events:
          type: object
          additionalProperties:
            type: object
            properties:
              enabled: { type: boolean }
              sample:  { type: number }

    AnalyticsEvent:
      type: object
      required: [event, ts]
      properties:
        event:      { type: string }
        ts:         { type: number, description: "客户端 unix ms" }
        props:
          type: object
          additionalProperties: true

    AnalyticsEventBatch:
      type: object
      required: [events]
      properties:
        session_id:   { type: string }
        device_id:    { type: string }
        platform:     { type: string, enum: [web, wechat, crazygames] }
        os:           { type: string }
        game_version: { type: string }
        locale:       { type: string }
        events:
          type: array
          maxItems: 100
          items:
            $ref: '#/components/schemas/AnalyticsEvent'
```

**注意**：公共属性（session_id / device_id / platform 等）放在 batch 根层，不在每条 event 里重复——减少传输体积约 60%。

---

## §9 漏斗与留存分析

### 9.1 核心流失漏斗

```
安装/落地
    ↓ session_start
首次打开
    ↓ screen_view(LobbyScene)
进入大厅
    ↓ game_start(mode=pvp_ai 或 campaign)
首局开始
    ↓ game_end(result=win/loss)
首局完成
    ↓ session_start（次日）
次日回访（D1 留存）
    ↓ level_complete 或 shop_buy
关键转化
```

### 9.2 关卡漏斗

```
level_attempt(ch1_lv1)
    → level_complete / level_abandon(phase=prep) / level_abandon(phase=in_game)
```
abandon 里的 `tick` 字段可以定位「在第几秒放弃」，找出游戏难度曲线卡点。

### 9.3 经济漏斗

```
session_start
    → shop_open(source=lobby)
        → shop_buy / shop_close(converted=false)
```
`shop_open` 的 `source` 字段标记入口，区分「主动找去的」vs「结算页推荐的」转化率。

### 9.4 预聚合查询示例（ops 后台用）

```javascript
// DAU by platform（过去 30 天）
db.sessions.aggregate([
  { $match: { started_at: { $gte: thirtyDaysAgo } } },
  { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$started_at' } }, platform: '$platform' },
              dau: { $addToSet: '$device_id' } } },
  { $project: { dau: { $size: '$dau' } } }
])

// 关卡 ch1_lv2 abandon rate
db.events.aggregate([
  { $match: { event: { $in: ['level_attempt','level_complete','level_abandon'] },
              'props.level_id': 'ch1_lv2' } },
  { $group: { _id: '$event', count: { $sum: 1 } } }
])
```

---

## §10 隐私合规

| 原则 | 实现 |
|---|---|
| 不收集个人可识别信息 | 事件里无姓名/邮箱/IP；user_id 是内部 accountId（不外泄） |
| 匿名设备 ID | `device_id` 是 client 本地生成的随机 UUID，不关联真实身份 |
| 用户可撤回 | 顶层 `enabled` 开关；账号注销时可批量删 `user_id=xxx` 的事件（GDPR） |
| 微信小游戏 | 不用 `wx.getUserInfo`，不要求隐私授权 |
| IP 不落库 | analyticsvc 不记录请求 IP |

---

## §11 任务拆分

| 任务 | 内容 |
|---|---|
| A9-0 契约 | `openapi.yml` 追加 analytics 两端点 + schemas；`rest:gen` 重生客户端 DTO |
| A9-1 analyticsvc 骨架 | workspace + config + db + httpApi(/health) + 部署接线（dev-up/compose/Dockerfile） |
| A9-2 采集配置端点 | `GET /analytics/config`（返回硬编码默认 config，后续改 DB 可配） |
| A9-3 事件接入端点 | `POST /analytics/events`（insertMany w:0）+ batch 校验 + 匿名/有登录两路径 |
| A9-4 客户端 SDK | `client/src/analytics/{index,config,queue}.ts`；`IPlatform` 公共属性注入；批量 flush |
| A9-5 埋点接入 | 各场景/系统加 `analytics.track()` 调用（优先级：session/game_end/level/churn） |
| A9-6 ops 查询端点 | `GET /internal/query?funnel=...`；tools/ops 加 Analytics 页（DAU / 漏斗 / 关卡通过率） |
| A9-7 funnels_daily ETL | `setInterval` 每小时跑聚合写 `funnels_daily`（ops 快速查询用） |

---

## §12 实现记录（2026-06-19）

### 12.1 A9-5 埋点接入补全

此前仅有 `session_start/end`、部分 `screen_view`、`game_start/end`、`level_attempt/complete/abandon(in_game)`、`shop_open` 落地。本次在 `client/src/app/createAppCore.ts` 补齐设计 §5 的剩余事件：

| 层 | 补入事件 | 落点 |
|---|---|---|
| 经济 | `shop_buy` / `shop_close{converted,time_sec}` / `recharge{tier}` | `goShop()` buy/onBack/recharge 回调 |
| 经济 | `gacha_draw{pool_id,count}` | `goGacha()` draw 成功 |
| 经济 | `upgrade{upgrade_id,level_after}` | `goLevelPrep()` tryUpgrade 成功 |
| 社交 | `friend_add` | `goFriends()` respond(accept) 成功 |
| 社交 | `pvp_room_create{mode}` | `goRoom()` createRoom/createRanked/queueRanked |
| 社交 | `pvp_match_start{mode}` | `goGameNet()` |
| 流失 | `tutorial_skip{step}` | `IntroScene` 跳过按钮（`onFinish(skipped)` 回传） |
| 流失 | `login_gate_hit{scene}` | `goFriends`/`goWorldEntry` 离线门控 |
| 导航 | `screen_view` 补 7 场景 | Settings/Shop/Gacha/LevelPrep/Collection/Stats/Result |
| 关卡 | `level_abandon{phase:'prep'}` | `goLevelPrep()` onBack |

### 12.2 churn_signal + session_end 生命周期接线

`endSession()` 此前**从未被调用**——`session_end` 一直没产出。本次在 `analytics/index.ts` 的 `bindSessionLifecycle()` 接 `visibilitychange(hidden)` / `beforeunload` / `wx.onHide`，在隐藏时发 `churn_signal{reason}`（background / explicit_exit）后调 `endSession()`；回前台 re-arm，避免切 Tab 往返重复上报。
> **idle_10min 暂缓**：需真实输入活跃度探针（本层拿不到），后续接 InputManager 再补，不做易误触发的近似实现。

### 12.3 修复：config 信封未解包导致采集全程失效

`/analytics/config` 走共享 `ok()` 信封返回 `{ok,data}`，但 `analytics/config.ts` 旧代码把整个 body 当 `AnalyticsConfig` 用，`cached.enabled` 恒为 `undefined` → `shouldTrack()` 恒 false。**即所有埋点此前一条都没真正上报。** 已改为解包 `.data`（兼容裸 body，对齐契约 §8）。

### 12.4 采样配置补全

`service.ts` `DEFAULT_CONFIG` 补入新事件采样率（`shop_close/gacha_draw/recharge/friend_add/pvp_room_create/pvp_match_start/tutorial_skip/login_gate_hit` 均 `1.0`），避免落入 `defaultSample:0.1` 漏采转化/流失事件。
