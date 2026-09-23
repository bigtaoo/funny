# Analytics — 数据库 / 服务端 / 契约 / 漏斗（§6 起）

> 从 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md) 拆出（2026-08-17，原文件 685 行）。**小节编号沿用原文**，`ANALYTICS_DESIGN.md §N` 引用照旧有效。
> 本册内容：§6 数据库、§7 analyticsvc、§8 OpenAPI 契约、§9 漏斗与留存、§10–§12。总览与在先小节见 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md)。

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
│          game_version, locale, event, props{}, ts: Date,
│          ua?, screen_w?, screen_h?, dpr?,             ← 客户端上报（A9-9，web only）
│          browser?, device_type?, webview?,             ← 服务端由 ua 解析（A9-9；webview 2026-08-24 加）
│          ip?, geo_country?, geo_region?, geo_city? }    ← ip 为请求 IP（A9-9 起落库，账号防护用途）；geo_* 由 ip 解析
│       索引：{ ts: -1 } / { event: 1, ts: -1 } / { user_id: 1, ts: -1 } /
│              { event: 1, 'props.level_id': 1, ts: -1 } / { session_id: 1 } /
│              { browser: 1, ts: -1 } / { device_type: 1, ts: -1 } / { webview: 1, ts: -1 } / { geo_country: 1, ts: -1 } / { ip: 1, ts: -1 }
│       TTL: expireAfterSeconds=0 on ts（配合 expireAt 字段）或 TTL index on ts 90天
│
├── sessions       会话摘要（永久，每 session 一行）
│       { session_id, user_id?, device_id, platform, os,
│          started_at: Date, ended_at?: Date, duration_sec?,
│          scenes_visited[], events_count,
│          ua?, screen_w?, screen_h?, dpr?, browser?, device_type?, webview?,
│          ip?, geo_country?, geo_region?, geo_city? }
│       索引：{ started_at: -1 } / { device_id: 1, started_at: -1 } / { ip: 1, started_at: -1 }
│
├── funnels_daily  每日预聚合（永久，ETL job 每小时跑）
│       { date, platform, funnel_step, count, conversion_rate? }
│       索引：{ date: -1, platform: 1 }
│
└── boots_daily    启动计数（永久，2026-09-20；见 ANALYTICS_DESIGN §3.6b / §3.6c）
        { _id: `${date}|${platform}`, date, platform, count, declined?, updated_at }
        索引：{ date: -1 }（_id 本身就是 (date, platform)，upsert 不需要额外索引）
        **只有这六列**：这是同意墙之前唯一能记的东西，没有 device_id、没有 IP、没有账号。
        写入者是 `GET /analytics/config`（每次启动必发、在年龄门/同意墙之前、无需同意）。
        `declined` 是 `count` 的**子集**（拒绝埋点那拨人的启动次数，2026-09-21 加，
        `?d=1` 那次请求写它、且**不**再写 `count`）；老文档里没有这一列，读成 0。
```

关卡/教程/场景细粒度漏斗（§9.7）、设备/地理分布（§9.8）、启动漏斗（§9.9）与加载时长（§9.10）都是**实时聚合查询**（不经 ETL 预聚合），直接查 `events`（`boots_daily` 只在 §9.9 里被读一次）。

### 6.3 TTL 策略

| 集合 | 保留期 | 理由 |
|---|---|---|
| `events` | 90 天 | 原始事件量大，超期分析价值低 |
| `sessions` | 永久 | 轻量，留存/DAU 计算需要 |
| `funnels_daily` | 永久 | 聚合结果，体积小 |
| `boots_daily` | 永久 | 一天几行数字，要的就是长期趋势 |

---

## §7 服务端 analyticsvc

### 7.1 形态

```
server/analyticsvc/   (第九 workspace @nw/analyticsvc, CJS)
├── config.ts         NW_ANALYTICS_PORT / NW_ANALYTICS_MONGO_*
├── db.ts             MongoDB 连接 + 4 个 collections + 索引
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

### 9.5 滚动留存 D1–D7（`GET /internal/query?type=retention`）

`AnalyticsService.queryRetention(days)` 计算过去 `days` 天每个「同期群（cohort）」的**次日到第 7 日回访率**——即某天的活跃设备中，在第 +1…+7 天仍有 `session_start` 的比例（设备口径，按 `(date, device_id)` 去重）。为让近期 cohort 也能算出后段偏移，多取 7 天数据窗口。

- 偏移量集中定义在 `RETENTION_OFFSETS = [1,2,3,4,5,6,7]`（`service.ts`），改这一处即可增删跟踪的天数。
- 返回行 `RetentionRow`：`{ date, cohort_size, d, d_rate }`，其中 `d`/`d_rate` 是以偏移量（1…7）为键的稀疏映射——回访设备数 / 回访率。
- 某偏移日**尚无任何活跃数据**（未来日期或数据缺口）→ 该键**缺省**（`d[n]===undefined`）；该日有活动但 cohort 无人回访 → `d[n]===0`。ops 前端据此渲染 `—` vs `0%`。
- ops 「Analytics」页 `pageAnalytics`（`tools/ops/src/pages/analytics.ts`）渲染 `D1%…D7%` 七列留存曲线，单元格 hover 显示回访设备数。

```
cohort（某日活跃设备）
    ↓ session_start（+1 日）→ D1  次日留存
    ↓ session_start（+2 日）→ D2
    ↓ …
    ↓ session_start（+7 日）→ D7  七日留存
```

### 9.6 首次会话 / 新手引导分析（A9-8，`GET /internal/query?type=first_session`）

回答「玩家**第一次进游戏**都做了什么、在哪一步流失、多少人过了新手引导」。`AnalyticsService.queryFirstSession(days)` 先取每个设备**最早的 `session_start`**，只保留其首次会话落在窗口 `[今起前 days 天, 今日结束]` 内的设备（= 新用户 cohort），随后所有统计**只看这一次首次会话**（按 `session_id` 关联，与老用户彻底隔离）。

- **新手引导漏斗** `funnel`（有序、逐步转化）：`ONBOARDING_STEPS`（`service.ts`）= 打开 → **看完/跳过 intro** → 开始引导 → **完成引导** → 首战 → 首通。相邻步转化率定位首日流失点；`tutorial_complete ÷ tutorial_start` 即引导完成率。步骤判定基于首次会话的事件集合，改 `ONBOARDING_STEPS` 一处即可增删步骤。
  - **采样一致性（关键）**：漏斗每步都取自 **100% 采样事件**（`session_start / intro_complete|intro_skip / tutorial_start / tutorial_complete / game_start / level_complete`，见 `DEFAULT_CONFIG`），各步计数才可直接相比。**故意不含**进大厅这类 `screen_view` 派生里程碑——`screen_view` 只 5% 采样，混进来会把采样损耗误显示成流失悬崖。`intro_seen` 步骤是例外：它读的是专属 `intro_complete`/`intro_skip` 事件而非 `screen_view`，design-doc-audit-2026-07 补入（此前这一步完全没数据，见 §5.6 事件表、`ONBOARDING_DESIGN.md` §7 的核实记录）。
  - ⚠️ **补入之后它仍然恒为 0，直到 2026-09-20**：那两个事件发生在同意墙之前，被 `track()` 的同意门原地丢弃（详见 §3.6）。**「事件已接线」不等于「事件到得了服务器」**——核一条埋点要核到它穿过所有门为止，别停在有 `analytics.track` 调用这一步。`tutorial_start/complete` 本来漏配、回落到 `defaultSample=0.1`，此前已一并提到 1.0（否则引导完成率失真）。
- **首会话行为分布** `actions`：首次会话里命中的场景（`screen_view` 的 scene，`kind:'scene'`）与语义动作（除 `session_start/session_end/screen_view/churn_signal` 外的全部事件名，含 `ui_click`，`kind:'action'`）各自的去重设备数 + 占 cohort 比例，按覆盖降序。回答「首日玩家都点了哪些功能」。
  - action 行多为 100% 采样事件（`game_start/shop_buy/gacha_draw/tutorial_*/ui_click…`），可信；**scene 行来自 5% 采样的 `screen_view`，系统性欠采**（ops 卡片已标注）。因此「首日点了哪个按钮」主要看 `ui_click`（如 `lobby.shop`）与语义动作，而非 scene 行。
- **口径注意**：「最早」仅在事件保留窗口内判定（events TTL=90 天）。真正首次会话早于保留期、却在窗口内回流的设备，不会被误判为新用户。
- ops 「Analytics」页渲染两张卡：Onboarding funnel（步骤/人数/步转化/占 cohort/条形）+ First-session activity（场景与动作覆盖）。

```
新用户 cohort（首次 session_start 在窗口内的设备）
    ↓ intro_complete | intro_skip  看完/跳过首启故事
    ↓ tutorial_start               开始引导
    ↓ tutorial_complete            完成引导  ← 引导完成率
    ↓ game_start                   首战（非引导局）
    ↓ level_complete               首通（首个真实关卡）
```

### 9.7 细粒度流失漏斗（A9-9）

在 9.1/9.6 的粗粒度漏斗之外，回答「具体卡在哪一关」「教程哪一小步流失」「哪个页面流失」。

**关卡级漏斗** `GET /internal/query?type=level_funnel`：`AnalyticsService.queryLevelFunnel(days, platform?)` 直接对 `level_attempt/level_complete/level_abandon` 按 `props.level_id` 分组统计去重设备数（`attempts/completes/abandons`），按完成率**升序**返回（最容易流失的关卡排最前）。这三个事件早已带 `level_id`，无需新增客户端埋点。ops 页面只展示完成率最低的前 20 关（避免整表刷屏），标题注明截断。

**教程步骤漏斗** `GET /internal/query?type=tutorial_funnel`：新增 100% 采样事件 `tutorial_step`（`props.step_key` ∈ `TUTORIAL_ORDERED_KEYS` = `tutorial_start → orientation_1..7 → beat_unit → beat_building → beat_spell → freeplay → tutorial_complete`），由 `client/src/render/TutorialDirector.ts` 在状态机推进的每一步调用 `TutorialHost.onStepChange`，经 `GameRenderer` → `GameScene` → `game.ts#goTutorial()` 转发为 `analytics.track('tutorial_step', {...})`。cohort = 窗口内出现过 `tutorial_start` 的 session；按 `TUTORIAL_STEPS` 顺序逐步判定 reached，与 9.6 的 cohort 方式一致（而非 9.4 的「各步独立计数」方式）。

**场景/页面级漏斗** `GET /internal/query?type=scene_funnel`：`screen_view` 只 5% 采样（见 9.6 的采样告诫），不足以支撑可靠的按场景漏斗。因此新增 100% 采样事件 `nav_checkpoint`，由 `client/src/analytics/index.ts` 的 `track()` 在 `screen_view` 命中场景白名单 `NAV_CHECKPOINT_SCENES`（`LoginScene/IntroScene/LobbyScene/CampaignMapScene/LevelPrepScene/GameScene`，对应 analyticsvc 的 `SCENE_FUNNEL_SCENES`）时自动补发，覆盖「登录→引导→大厅→选关→备战→开战」核心新客路径。cohort = 窗口内所有 `session_start` 的 session（不限于首次会话）。

三者共用同一套 cohort-funnel 引擎（`AnalyticsService.computeStepFunnel`），ops 页面共用 `renderStepFunnel()` 渲染函数。

**功能引导漏斗** `GET /internal/query?type=feature_guide_funnel`（design-doc-audit-2026-07）：`AnalyticsService.queryFeatureGuideFunnel(days, platform?)`，与关卡级漏斗同一套写法——对 `feature_guide_shown/feature_guide_closed/feature_guide_replay` 按 `props.feature` 分组统计去重设备数，按关闭率**升序**返回。字段定义见 §5.9。与 `level_funnel` 一样是「按 key 独立计数」，不是 cohort-funnel（不复用 `computeStepFunnel`）。

### 9.8 设备 / 地理分布（A9-9）

**真实设备信息**：此前 `os` 字段只是 `navigator.platform`（如 "Win32"），无法区分浏览器或移动端/桌面端。客户端新增上报 `ua`（完整 `navigator.userAgent`，微信小游戏侧不发，因为没有 UA 概念）、`screen_w/screen_h/dpr`（屏幕尺寸 + 像素比，微信侧用 `wx.getSystemInfoSync()` 取值）。服务端 `parseUserAgent()`（`analyticsvc/src/service.ts`）在入库时**由服务端解析** `browser`（chrome/safari/firefox/edge/wechat/qqbrowser/opera/…）与 `device_type`（mobile/tablet/desktop）——不信任客户端可能自报的浏览器名。`GET /internal/query?type=browser_dist|device_type_dist` 对应查询，ops 页面新增两张分布卡。

**内嵌 WebView 归因（`webview`，2026-08-24 加）**：`browser` 之外**另开一个维度**，取值为宿主 App（`gsa`/`facebook`/`instagram`/`line`/`tiktok`/`snapchat`/`twitter`/`wechat`/`android-wv`），普通浏览器流量该字段**缺席**（`webview_dist` 里归为 `none`）。

- **为什么不并进 `browser`**：① `browser` 的取值已经在喂 ops 分布图的时间序列，改名等于悄悄改写历史；② 答案本来就不是浏览器名——GSA 的 WebView **确实**是 WebKit，`browser=safari` 是**不完整**而非错误。它藏起来的是宿主 App，而宿主 App 才是关键：内嵌 WebView 的内存上限远比独立浏览器紧，超限时被系统直接杀进程而非报错。在这个字段之前，这类会话和普通 Safari/Chrome 流量完全无法区分——2026-08-22 那次 Google App WebView 里的崩溃循环（见 [`FEATURE_FLAGS_DESIGN_LOG.md`](FEATURE_FLAGS_DESIGN_LOG.md) 2026-08-24 条目）因此根本没法归因到环境类别。
- 查询 `GET /internal/query?type=webview_dist`，ops「In-app WebView」分布卡。

**同批修掉的 `device_type` 误判**：安卓平板不带手机才有的 `Mobile` token，也不带 `Tablet` token，而原规则把 `Mobi|Android` 写成同一个或分支——于是**每一台安卓平板都被记成手机**。现改为 `Android` 命中后再看有无 `Mobi`。这条与客户端 `net/anomaly/deviceContext.ts` 的 `classify()` 刻意保持一致：两者对同一次会话回答同一个问题，互相矛盾比各自粗一点更糟，测试里有一条用例把两边钉在一起。

**IP 地理定位 + 账号防护**：`server/analyticsvc/src/httpApi.ts` 的 `POST /analytics/events` 从 `X-Forwarded-For`（Caddy 反代自动注入）取客户端 IP，存入 `EventDoc.ip`/`SessionDoc.ip`（`{ ip: 1, ts: -1 }` / `{ ip: 1, started_at: -1 }` 索引，供后续查「同一 IP 下有几个账号/设备」这类风控场景使用），并用 `geoip-lite`（离线库，无外部网络调用）解析出 `geo_country/geo_region/geo_city`。`GET /internal/query?type=geo_dist` 按国家分组，ops 新增「Geo (country) distribution」卡；原有的「Region distribution」卡实际统计的是 `locale`（语言码）而非地理位置，已改名为「Locale distribution」以免混淆。

### 9.9 启动漏斗（`type=boot_funnel`，2026-09-20）

本服务里**唯一分母不是埋点事件**的查询，因为它要数的那拨人不发埋点事件。详见
[`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md) §3.6b。

按 (日期, 平台) 出行：`boots`（`boots_daily` 计数）/ `sessions`（`session_start` **条数**）/
`declined`（`boots_daily.declined`，**`boots` 的子集**）/ `consents`（`gdpr_consent` 条数）/
`reach_rate = sessions/boots`。

`reach_rate` **故意不改口径**（仍是 `sessions/boots`）：它已经在趋势图里躺了一段时间，
换分母等于把历史悄悄改写。要看"能报的人里有多少真报了"，自己拿 `sessions/(boots − declined)` 算。
ops 那边扣的是 `Lost = boots − sessions − declined`（§3.6c）。

实现上是**外连接**（`analyticsvc/service/traffic.ts`）：两侧任意一边出现过的 (日期, 平台) 都出一行。
内连接会正好丢掉这张表最有价值的那一行——**有启动、零会话的那天**。反过来「有会话、没计数」
也出行（老客户端不发 `?p=`、或者计数写失败），这时 `reach_rate` 留空而不是编一个出来。

### 9.10 加载时长（`type=load_time`，2026-09-20）

按平台给 `samples / p50 / p75 / p90 / p95` + 各阶段均值 + 直方图 + `abandoned`。
事件定义见 [`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md) §5.1b。

三个实现决定，都在 `analyticsvc/service/dist.ts`：

- **百分位读直方图，不用 `$percentile`**：聚合里把 `props.total_ms` 按 100ms 分桶（`$ceil`，
  桶标签是**闭上界**——用 `$floor` 的话每个整百值都会高一桶，所有百分位一起漂移），
  百分位在 JS 里按累计计数读出来。代价是 100ms 精度，换来内存**按桶数封顶**（`$push` 每条一个
  子文档，忙一周就能顶到 16MB 文档上限）、不吃 MongoDB 版本，而且顺手就有了 ops 要的那张直方图。
- **每个阶段各自记 sum 和 n**，不是 `$avg` 也不是 `$push`：某平台没有的阶段（微信没有网络阶段）
  必须**不参与自己的均值**，而不是按 0 平进去。
- **`abandoned` 用事件对算，不用超时**：同一会话有 `boot` 无 `load_time` = 加载界面还开着就关了页面。

### 9.11 分组留存 + 配套查询（`type=retention_by/session_duration_dist/churn_scene_dist`，2026-09-23）

`RETENTION_LAUNCH_PLAN.md` §2 的"为什么"工具——9.5 的滚动/新客留存只回答"留存多少"，这里回答"哪一类新客留得更好"。三个查询都在新文件 `analyticsvc/service/retentionBy.ts`（`RetentionByService`，独立 sibling class）+ `dist.ts` 追加两个方法。

**`queryRetentionBy(days, dimension, {platform?})`**：新客 cohort（首次 `session_start` 落在窗口内的设备，判定方式与 9.5 的 `newCohort` 一致）按 `dimension` 在**各自首次会话**上的取值分组，每组独立算一条 D1–D7 曲线。九个维度分两种取法（`RETENTION_BY_DIMENSIONS`，`defs.ts`）：

- **读 SessionDoc**（入库时已算好，见 9.8）：`browser`/`device_type`/`webview`/`geo_country`——按设备首次会话的 `session_id` 查 `sessions` 表；SessionDoc 缺失（已过 90 天 TTL，或该场景理论上不该发生）时落到 `'unknown'`。
- **读事件**：`load_time_bucket`（首次会话 `load_time.props.total_ms`，粗分 4 档：`<2s/2-4s/4-8s/8s+`，比 9.10 直方图的 100ms 分辨率粗得多——这里是分组标签，不是画百分位）、`tutorial_complete`（首次会话是否出现该事件，`'true'/'false'`）、`first_battle_result`（首次会话第一条 `game_end.props.result`，未打过记 `'none'`）、`matched_bot`（首次会话是否出现 `pvp_match_bot`）、`login_mode`（首次会话第一条 `login_ok.props.mode`，**没有该事件**——静默设备/静默门户 SSO 自动登录，见 ANALYTICS_DESIGN.md §5.6——落到 `'device'`，这正是决策②的判据："登录墙要不要后移"看的就是 `login_mode='device'` 那组和显式登录的那几组曲线差多少）。

**跨日期分组的"每设备自己的 D+n"语义（`RetentionByRow` 的核心，也是与 9.5 `RetentionRow` 唯一的语义分歧点）**：9.5 一条 cohort 行只对应一个日历日，D+n 对整个 cohort 是同一天；这里一个 dimension 分组会横跨窗口内多个首次会话日期，于是 D+n 必须按**每个设备自己的**"首次会话日 + n"来判——同组内一台"今天才首次进来"的设备，它的 D1 目标日还没发生，这一次偏移**整台设备都不计入**（既不算分子也不算分母），不是当作"未回访"计进分母。因此 `d_rate[n]` 的真实分母（该偏移已发生的设备数）可以小于 `cohort_size`（整组设备数），偏移越靠后、组内日期跨度越大，这个缺口越明显——读数时别拿 `d[n]/cohort_size` 去反推，`d_rate[n]` 已经是正确分母算出来的。

**`querySessionDurationDist(days)`**（`dist.ts`）：`sessions.duration_sec` 早就入库（`session_end.props.duration_sec`）但此前没有查询读过。写法与 9.10 `queryLoadTime` 同一套直方图百分位手法（`percentileFromBuckets` 已泛化成按字段名取上界，`lt_ms`/`lt_sec` 共用一份实现），30 秒一档（`SESSION_DURATION_BUCKET_SEC`）。没有 `duration_sec`（未正常收到 `session_end`）的会话**不计入样本**，不是当 0 秒处理。

**`queryChurnLastScene(days)`**（`dist.ts`）：`churn_signal.props.scene` 分组计数（§5.6 事件表）。数的是**事件条数不是去重设备数**——同一场景在一次会话里可以多次触发闲置信号，这里要看的是"流失最终停在哪一屏"这个分布本身，不是覆盖率。

**ops 页面**（`tools/ops/src/pages/analytics.ts`）：「Retention by first-session property」卡复用 9.5 留存卡的表格/单元格渲染（`retentionCell`/`retentionRows` 对 `RetentionByRow` 结构性兼容，无需为分组留存另写一套），下拉切维度做独立 scoped 重拉（同 9.5 platform/newCohort 下拉的写法）；「Session length」卡结构照抄 9.10 加载时长卡；「Where sessions end」复用 `shareCard`。

**admin 代理链路**：`dimension` 作为 `analyticsQuery`/`AnalyticsClient.query` 的第 5 个可选参数，转发规则与 9.5 的 `newCohort` 同一套——只在设了值时才传（显式传 `undefined` 和不传是两种不同的调用形状，`analyticsService.test.ts` 的调用录制断言会拆穿这个区别，9.5 那轮已经踩过一次）。

---

## §10 隐私合规

| 原则 | 实现 |
|---|---|
| 不收集姓名/邮箱等强身份信息 | 事件里无姓名/邮箱；user_id 是内部 accountId（不外泄） |
| 匿名设备 ID | `device_id` 是 client 本地生成的随机 UUID，不关联真实身份 |
| 用户可撤回 | 顶层 `enabled` 开关；账号注销时可批量删 `user_id=xxx` 的事件（GDPR） |
| 微信小游戏 | 不用 `wx.getUserInfo`，不要求隐私授权 |
| 请求 IP 落库（A9-9 更新，产品拍板） | 出于账号安全目的（同 IP 多账号/共享设备检测、封禁规避排查）保留请求 IP，作为「合法利益」（legitimate interest）用途，不同于需要用户同意的营销类追踪；未额外做设备定位授权，只是记录连接方 IP 这一常规服务器日志信息 |

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
| 社交 | `pvp_room_create{mode}` | `goRoom()` createRoom/queueRanked（2026-09-21：视图级 `createRanked` 回调已随 `RoomScene` idle 的排位按钮一并删除，`mode:'ranked'` 现在只从 `queueRanked()` 这一条路发出） |
| 社交 | `pvp_match_start{mode}` | `goGameNet()` |
| 流失 | `tutorial_skip{step}` | `IntroScene` 跳过按钮（`onFinish(skipped)` 回传）——`step:'intro'` 一支已被 §12.5 的专属 `intro_skip` 取代 |
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

### 12.5 补齐 intro + 首次功能引导埋点（design-doc-audit-2026-07）

设计文档审计（`ONBOARDING_DESIGN.md` §7）逐节点核实漏斗埋点覆盖度时发现两处此前完全没有 `analytics.track` 调用的功能性缺口，本次一并补齐：

| 节点 | 补入事件 | 落点 |
|---|---|---|
| intro 完成/跳过 | `intro_complete` / `intro_skip`（100% 采样，取代 `tutorial_skip{step:'intro'}`） | `client/src/app/nav/auth.ts` `goIntro()` 的 `onFinish(skipped)` |
| 首次功能引导 弹出/关闭 | `feature_guide_shown` / `feature_guide_closed{feature}`（100% 采样） | `client/src/app/nav/lobby.ts` `withGuide()` |
| 首次功能引导 再看（预留） | `feature_guide_replay{feature}`（配置已加，尚无客户端调用点） | 待 `ONBOARDING_DESIGN.md` §8/§10 的页面内「?」按钮接入后补 |

同时：
- `ONBOARDING_STEPS`（§9.6）新增 `intro_seen` 步骤（`intro_complete` 或 `intro_skip` 命中即算），首次纳入 intro 到「首次会话新手引导漏斗」。
- 新增查询类型 `GET /internal/query?type=feature_guide_funnel`（`AnalyticsService.queryFeatureGuideFunnel`，写法同 `queryLevelFunnel`），ops「Analytics」页新增对应卡片。字段定义见 §5.9，查询说明见 §9.7。
- 登录方式（试玩/匿名/正式）节点仍未接专属事件——优先级较低，本次不强制，留给后续迭代（`ONBOARDING_DESIGN.md` §7 已记录）。

### 12.6 上架前埋点体检：三处让漏斗读数失真的硬伤 + 登录/匹配两个盲区（2026-09-20）

上架前按「流失点数据齐不齐」逐条核对代码（不是核文档），发现的不是缺口而是**三处会让现有报表给出错误
数字**的问题，都已修：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | 同意墙之前 `track()` 直接丢弃 | §9.6 `intro_seen` 对**每个新用户**恒 0，下一步转化率变 `undefined` | 同意前缓冲，接受时补发（§3.6） |
| 2 | 22 个事件不在 `DEFAULT_CONFIG` 里 | 全部付费 + 全部日常留存事件只留 10%，而漏斗按设备去重 → 随机化而非等比缩小 | 补齐并全部 1.0（§5.4） |
| 3 | `shop_open` 0.5 vs `shop_buy` 1.0 | §9.3 经济漏斗转化率虚高约 2×；`source` 从未填过 | 两端同率；`source` 串通（§5.4） |

同批补的两个盲区：**登录/注册结果**（`login_submit`/`login_ok`/`login_fail`/`login_skip`，§5.6）与
**排位队列放弃**（`pvp_queue_cancel`/`pvp_match_bot`/`pvp_room_join`/`pvp_room_error`，§5.5）。

**装了门禁**：`client/test/analyticsEventConfig.test.ts` 双向比对「客户端发的事件名」与
`DEFAULT_CONFIG` 的键，并钉死漏斗关键事件必须 `sample: 1.0`。问题 2、3 和两个死条目
（`upgrade`/`recharge`，§12.1 曾写作已接线）都是它一跑就红的东西——**这类漂移靠读文档发现不了，
因为文档描述的正是本该成立的状态**。

**当时仍然开着的**（四条，全部在 §12.7 做掉了）：
- 年龄门/同意弹窗上直接走掉的人没有分母（§3.6 末尾），要服务端加无个人数据的启动计数。
- 启动/加载阶段零观测：没有 boot / first_frame / load_time 事件，"打开了页面但没撑到进游戏"只能翻反代日志。
- 崩溃管道（`/client/anomaly`）与埋点管道没有共同 id，答不了「闪退的人是不是当场流失」。
- `churn_signal` 的 `idle_10min` 仍未实现（§12.2 起就延后）。

### 12.7 补齐 §12.6 留下的四个盲区（2026-09-20，同日第二轮）

四条一起做，因为它们是同一件事的四个面：**玩家开始玩之前和停止玩之后，我们什么都不知道**。

| # | 盲区 | 做法 | 正文 |
|---|---|---|---|
| 1 | 同意墙之前走掉的人没有分母 | `GET /analytics/config` 上加 `?p=`，服务端在 `boots_daily` 按 (日期,平台) `$inc`；查询 `type=boot_funnel` | §3.6b / §9.9 |
| 2 | 启动/加载零观测 | `boot` / `first_frame` / `load_time` 三条事件 + 分阶段耗时；查询 `type=load_time`（p50/75/90/95 + 阶段均值 + 直方图 + 放弃数） | §5.1b / §9.10 |
| 3 | 崩溃与埋点无共同 id | 会话 id 提到 `analytics/session.ts`，两条管道同盖一个 sid（Loki 侧 `sid=`）；外加 `prev_session_crash` 事件 | §5.6c |
| 4 | `idle_10min` 一直没做 | `render/renderPolicy.ts` 的 `msSinceActivity` 由 `app.ts` 注入给 `analytics/idleWatch.ts` | §5.6a |

**沿途修掉的一个结构性 bug**：`track()` 在 `init()` 之前是**直接扔**的。老玩家尤其致命——
`createAppCore` 在 `init()` **上一行**就 `setConsent(true)`，于是同意分支被跳过，紧接着的
`if (!queue || !sessionId) return` 把事件丢了，连缓冲都没进。而本轮新增的事件里，
`boot` 和 `prev_session_crash` **按定义就发生在 `init()` 之前**——不修的话这两条对老玩家恒为零，
而且和 §12.6 那三个问题是同一个品种：**报表照常出数，只是那一格永远是 0**。
现在 `track()` 在「没同意」或「还没 init」两种状态下一律缓冲，`init()` 也改成**先补发再发
`session_start`**，让队列保持时间顺序。

**已经在客户端做掉的**：`showConsent` 的「仅必要」分支（2026-09-21，ANALYTICS §3.6c）——拒绝埋点照样进游戏，服务端这边没有新端点，只是 `POST /account/gdpr-consent` 现在也会收到 `false`。**同日补完**：拒绝的人已经从 §3.6b 的 `Lost` 里拆出来了——`GET /analytics/config?d=1` 在同一行上 `$inc { declined }`（仍然只有「日期/平台/计数」，仍然无鉴权、无 device_id、无 IP），`boot_funnel` 多一列 `declined`，ops 的 `Lost` 改成 `boots − sessions − declined`。

新增覆盖：`client/test/analyticsBootTimeline.test.ts`（8）、`analyticsIdleWatch.test.ts`（7）、
`analyticsConsentBuffer.test.ts` 加两条 pre-init 用例、`anomaly-chain.test.ts` 加三条 sid 用例、
`server/analyticsvc/test/bootAndLoadTime.e2e.test.ts`（12）、`analytics.e2e.test.ts` 加 `?p=` 白名单、
`metaserver/test/clientLog.test.ts` 加两条 sid 用例、`tools/ops/test/analytics.test.ts` 加 11 条。

