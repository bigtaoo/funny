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
    │       collections: events(TTL 90d) / sessions / funnels_daily / boots_daily
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
  platform:      'web' | 'wechat' | 'crazygames';   // ⚠️ 2026-09-04 前这一维恒为 'web'，见下
  os:            string;   // navigator.platform 或 wx.getSystemInfo
  game_version:  string;   // __NW_BUILD_VERSION__（webpack 注入）
  locale:        string;   // 当前语言
  ts:            number;   // 客户端 unix ms
}
```

> ⚠️ **`platform` 这一维在 2026-09-04 之前恒为 `'web'`，历史数据不可用于分平台切分。** 三处读它的地方（`analytics/index.ts`、`app/appConstants.ts` 的 `clientPlatformName`、`net/anomaly/reporter.ts`）写的都是 `globalThis.TARGET`，而 `webpack.config.js` 的 DefinePlugin 那一行 key 是裸的 `TARGET`——**裸 key 只替换自由变量，不替换成员表达式**（`__NW_*__` 那几行一直写成 `'globalThis.__NW_API_BASE__'` 正是这个原因）。于是替换从来没发生过，微信包和 CrazyGames 包都把自己上报成 `web`：埋点这一维、异常日志的 `platform` 字段、以及 `X-NW-Platform` 请求头（ADR-020 用它挑充值池桶）三处同时受影响。**没有任何测试能看见它**——配置读起来是对的，而单元测试自己往 `globalThis.TARGET` 上写值，恰好是唯一能读到的场景。修法是补一行 `'globalThis.TARGET'` key；守卫是 `client/test/targetGlobalCompile.test.ts`（真编译 + 在 Node 里 require 产物问它到底看见什么，配置断言在这个 bug 上是无效的）。

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

**实现落点（2026-09-01）**：上面三行的 web-vs-微信分支本来在 `analytics/index.ts`（churn_signal/
session_end 那半）和 `analytics/queue.ts`（flushSync 那半）里各写了一份一模一样的代码，且两份
都零测试覆盖——`wx.onHide`/`onShow` 分支从最初那版就是对的，但没有任何用例会在它被误删时报红。
现已抽成 `client/src/platform/appLifecycle.ts` 的 `onAppLifecycleChange(cb)`：web/CrazyGames 用
`visibilitychange`（→ `'hidden'`/`'visible'`）+ `beforeunload`（→ `'exit'`，仅这一路径区分「切走可能
回来」与「关掉不会再回来」），微信用 `wx.onHide`/`wx.onShow`（微信没有「确定不会再回来」这个信号，
一律报 `'hidden'`）。两个消费者现在只订阅这一个信号，分支只写一遍；覆盖见
`client/test/appLifecycle.test.ts`（信号本身）+ `analyticsQueue.test.ts`/`analyticsSessionLifecycle.test.ts`
（两个消费者的接线）。

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

### 3.6 同意墙与「同意前缓冲」（2026-09-20）

GDPR 同意门（C5-c/L1-1）默认关闭，**同意之前没有任何数据离开设备**。这一条不变；变的是同意之前的事件
不再被直接扔掉，而是**存在内存里**（`analytics/index.ts` 的 `pending`，上限 100 条，满了丢新的、留最早的），
玩家点「接受」时按各自采样率补发，**一直没点就随进程一起消失**。

**为什么必须这么做**：新玩家的启动顺序是 `start() → goIntro() → 年龄门 → 同意弹窗`
（`app/createAppCore.ts`），也就是说 `session_start`、IntroScene 的 `screen_view`/`nav_checkpoint`、
`intro_complete`/`intro_skip` **全部发生在门还关着的时候**。旧实现里 `track()` 在这个状态下直接 `return`，
只有 `session_start` 会在同意时补发一次。后果不是统计噪声而是**结构性归零**：§9.6 新手漏斗的 `intro_seen`
一步对**每一个新用户**都计 0，而那正是这张漏斗唯一要量的人群；又因为 `computeStepFunnel` 的转化率是
`count/prev`，prev=0 让它**后面一步的转化率也变成 `undefined`。仪表盘上不显示为坏掉，显示为「所有人都在
看片头时退了」。

覆盖：`client/test/analyticsConsentBuffer.test.ts`（补发、不补发、采样在补发时才算、溢出留最早、
「先 setConsent 后 init」的老玩家顺序）。

**曾经看不到的**：在年龄门或同意弹窗上直接走掉的人——这两屏之前连 `session_start` 都还没有，分母只能来自客户端之外。见下节，**已补上**。

### 3.6b 启动计数：同意墙之外的那个分母（2026-09-20）

`GET /analytics/config` 是**每次启动必发、且在两道门之前、且不需要同意**的唯一一个请求，所以
它就是唯一可能的分母落点。客户端在这个请求上带一个 `?p=<web|wechat|crazygames>`（`analytics/config.ts`），
服务端在 `boots_daily` 上按 `(日期, 平台)` 做一次 `$inc`（`analyticsvc/service/traffic.ts` `countBoot`）。

**只有日期、平台、计数**，没有 device id、没有 IP、没有账号——这个集合的隐私立场就是这三列，
任何再多一列的东西都是「在问玩家之前就采集的数据」。因此它数的是**启动次数**，不是人；
能跟它比的也只有同样按次计的 `session_start`**事件条数**（不是去重设备数）。

读法（ops「Analytics」页顶部 Launch funnel 卡，查询 `type=boot_funnel`，§9.8）：

| 列 | 含义 |
|---|---|
| `Launches` | `boots_daily.count` = 加载到 JS 并发出 config 请求的启动次数 |
| `Sessions` | 当天 `session_start` 事件条数 = 拿到同意、真的上报了东西的启动 |
| `Declined` | `boots_daily.declined` = 选「仅必要」的人的启动次数（**`Launches` 的子集**，2026-09-21，§3.6c） |
| `Lost` | `Launches − Sessions − Declined`，**这一条就是本节存在的理由**：在年龄门/同意墙上走掉的人 |
| `Consents` | `gdpr_consent` 条数（弹窗只弹一次，所以约等于新客同意数） |

`Declined` 为什么必须单列：拒绝埋点的人**照样在玩**，只是一条都不报——从这张表看过去，他们
和"打开就关"长得一模一样。不拆的话 `Lost` 会随着拒绝率一起涨，而那正好是**看上去像门槛变差、
实际上是拒绝的人变多**的那种假信号。

**当趋势看，别当精确率看**：① config 请求无需鉴权，谁都能打；② 卸载时那次 flush 失败的会话
也会算进 `Lost`；③ 跨 UTC 零点的启动，两侧可能落在不同天（ops 侧因此把 `Lost` 夹在 ≥0——
`Declined` 那次 tick 是**第二个请求**，同样可能落到零点另一侧）；④ `reach_rate`（ops 的
`Reached` 列）分母仍是 `Launches`、没跟着改口径，见 BACKEND §9.9。

覆盖：`analyticsvc/test/bootAndLoadTime.e2e.test.ts`（并发不丢计数、只有那几列、有启动零会话的
那天照样出行、反过来也出行）+ `analytics.e2e.test.ts`（`?p=` 白名单外记成 `unknown`）。

---

### 3.6c 「仅必要」：拒绝之后照样能玩（2026-09-21）

§3.6b 末尾留的那个问题（拒绝了还能不能进游戏）拍完了，答案是**分开看两件事**：

| 同意什么 | 法律依据 | 拒绝的后果 |
|---|---|---|
| 用户协议 + 隐私政策 | 缔约必要（GDPR Art 6(1)(b)） | 进不去。不签合同就没有服务，这是硬门 |
| 匿名埋点 | 只能靠 consent | **照样进游戏**，只是一条都不报 |

把两者绑在一个按钮上正是 Art 7(4) / Recital 43 说的「同意不自由」，所以弹窗拆成两种形态，由
`platform/consentRegion.ts` 的 `needsConsentChoice()` 决定看到哪一种：

- **`choice`**（欧盟/EEA/英国/瑞士 + 美国）：「全部接受」/「仅必要」两个按钮，**两个都进游戏**。
- **`accept-only`**（其余地区、微信）：今天这个单按钮，埋点随协议一起接受。

**地区判定用 IANA 时区，不用 IP**：启动链上没有任何东西能及时把服务端的判断送到门口——
`analytics.init()` 是 `void` 调的，两道门紧接着就跑，而 analyticsvc 在 Caddy 后面没有 `CF-IPCountry`，
上 GeoIP 库只为了一个布尔值不值当。时区是免费、同步、离线的，代价是出差和 VPN 会判错——这正是
§3.3 说的「粗判」的精度。所有判断都**偏向多问**：`Europe/*` 整段算（莫斯科、伊斯坦布尔也一起问，
无害），`America/*` 反过来**不是**前缀规则（否则加拿大和整个拉美的数据白丢），读不到时区也算要问。
真要精确，升级路径是 config 响应带上国家码 + 门口短暂 await，不是换个信号。

**`flags.gdprConsent` 从此有三态**（gate 直接读 `save.flags`，不走 `getFlag`——后者答的是
`=== true`，分不出「拒过」和「没问过」，问了也白问）：

| 值 | 含义 | 埋点 |
|---|---|---|
| `true` | 全部接受 | 开 |
| `false` | 仅必要 | 关 |
| 不存在 | 没问过 | （弹窗） |

**拒绝这条路上一个事件都不发**，连 `gdpr_consent { granted: false }` 都不发：它是唯一一个没法用
它自己拒绝的东西去上报的答案。它只作为账号状态经 `POST /account/gdpr-consent` 落到服务端，属
Art 7(1) 的举证留痕，不是遥测。

**唯一的例外是一次计数（2026-09-21 补完）**：拒绝之后客户端会再打一次
`GET /analytics/config?p=<平台>&d=1`，服务端在**同一行** `boots_daily` 上 `$inc { declined }`、
且**不**再 `$inc { count }`（那次启动在 init 那个 config 请求里已经数过了）。这不是遥测：
落地的还是「日期 / 平台 / 一个数」，没有 device id、没有 IP、没有账号，跟 §3.6b 的启动计数
是同一套隐私立场、同一个无鉴权端点。不这么做的话，这些人计进了 `Launches` 却永远不出现在
`Sessions`，`Lost` 就是「走掉的人 + 拒绝埋点的人」混在一起——而后者只会越攒越多。

两条路都要 tick，因为要对齐的是**启动次数**：
- 弹窗上点「仅必要」的那次启动（`record(false)`）；
- 之后每一次启动——gate 读到 `flags.gdprConsent === false` 直接放行的那条分支。
  设置页里关掉开关**不 tick**：那次启动早就发过 `session_start`、已经算在 `Sessions` 里了，
  再记一次等于从漏斗里扣两遍；他们的**下一次**启动会由 gate 补上。

客户端实现：`analytics.countDeclinedLaunch()`（`analytics/index.ts`，每次启动至多一次，
离线/没配 API base 时静默跳过）→ `analytics/config.ts` 的 `pingDeclinedLaunch()`，走
`netTransport` 所以微信 `wx.request` 那条路也通，发完不看响应。

**撤回同样要能**（Art 7(3)：撤回要和给出一样容易）：设置页和数据节省开关并排放了一个
「匿名数据」开关，两个方向都能改，接的是 gate 那三次写里的同两次（本地 flag + 账号），
不发 `gdpr_consent`——设置页里重新打开不是首启转化，算进漏斗会把同意数冲歪。

覆盖：`client/test/consentGate.test.ts`（两种形态各出一次、拒绝后进得去、拒绝记得住、拒绝零上报、
拒绝仍落账号、拒绝那次与之后每次启动各 tick 一次、接受时不 tick、**设置页撤回也不 tick**、时区表逐条）
+ `client/test/analyticsDeclinedLaunch.test.ts`（计数规则本身：一次启动只 tick 一次、
下一次 `init()` 重新武装、离线不发、base 剥掉 `/api`、微信构建报 `wechat`）
+ `analyticsvc/test/bootAndLoadTime.e2e.test.ts` / `analytics.e2e.test.ts`（`?d=1` 只动 `declined`
不动 `count`、tick 先到时 `count` 补 0 且字段仍只有那六列、并发不丢、漏斗把 `declined` 单列出来、
`reach_rate` 分母不变、`?d=1` 上平台白名单照样生效）+ `client/test/ui/consentDialogWrap.ui.ts`（`choice` 的长文案在三种
视口都不溢出——横屏矮屏原本 de 溢出 56px，靠 `ConsentDialog.build` 的二次量算回来）+
`client/test/ui/settingsDataSaverRow.ui.ts`（两个开关并排那一行，三语言四视口互不相撞）。

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
    "churn_signal":   { "sample": 1.0 },
    "render_profile": { "sample": 1.0 }
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

### 5.1b 启动与加载（Boot / Load，2026-09-20）

在这之前**启动阶段零事件**：一个会话的第一条事件是 `session_start`，而它来自 `analytics.init()`，
也就是说包已经下完、渲染器已经建好、L0 资源门已经放行之后才有第一条数据。于是
「打开了页面但没撑到进游戏」只能翻反代日志，「手机流量下加载好久」连个数字都给不出。

三条事件，**故意不合成一条**——它们条数之间的差就是测量本身（`client/src/analytics/bootTimeline.ts`）：

| 事件 | 时机 | 回答什么 |
|---|---|---|
| `boot` | 我们的第一行 JS 执行（`startApp` 首句） | 我们还不存在的那段时间花了多少：DNS/TLS/HTML/包体 |
| `first_frame` | 第一次 `renderer.render()` 完成 | 白屏到第一帧 |
| `load_time` | `core.start()` 返回，第一个真实场景建好 | 总时长，**按阶段拆开** |

`boot` 与 `load_time` 的条数比 = **加载中途放弃的比例**，这拨人不进任何场景、不点任何按钮、
在别的任何报表里都不存在。

**时间原点分两种，`origin` 字段写明是哪一种**：web 上 `performance.now()` 从导航开始计，
所以 `to_script_ms` 天然含网络与解析（`origin:'nav'`）；微信没有 document，时间线从模块加载算起
（`origin:'script'`，`to_script_ms≈0`，包已在本地）。**两者不可直接比较**，所以不做成一个字段。

| 事件 | 属性 |
|---|---|
| `boot` | `origin, to_script_ms`；web 另附 `nav_type`（navigate/reload/back_forward——**冷启与热重载的缓存命中差几倍，混在一起的 p50 谁也不描述**）、`dns_ms, tcp_ms, tls_ms, ttfb_ms, html_ms, js_ms, js_files, js_kb` |
| `first_frame` | `origin, total_ms, renderer_ms, since_renderer_ms` |
| `load_time` | `origin, total_ms` + 阶段拆分 `to_script_ms / renderer_ms / first_frame_ms / preload_ms / scene_ms` + `preload_assets` |

**缺的阶段留空，不写 0**：一个 0 在 ops 的均值里读作「这步是瞬间完成的」，而真相是
「这个平台没有这一步」（微信没有网络阶段）。`js_kb` 同理——缓存命中或跨域没有
`Timing-Allow-Origin` 时 `transferSize` 为 0，那是「量不到」，不是「零字节」。

服务端查询 `type=load_time`（按平台 p50/p75/p90/p95 + 阶段均值 + 直方图 + 放弃数）见 §9.10。

覆盖：`client/test/analyticsBootTimeline.test.ts`、`analyticsConsentBuffer.test.ts`（这三条事件
全都发生在 `init()` 之前，唯一的活路是 `track()` 的缓冲）、`analyticsvc/test/bootAndLoadTime.e2e.test.ts`。

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
| `shop_open` | `source, tab` | — | `source` ∈ `lobby_recharge`/`prep`/`shop_group`/`unknown`（`ShopSource`，`app/appCtx.ts`）。**2026-09-20 起才真的填**，此前恒为空 props；同批把采样率从 0.5 提到 1.0，见下方注 |
| `shop_buy` | `item_id, cost` | `currency` | 购买商品 |
| `shop_close` | `converted` | `time_sec` | converted=是否有购买 |
| `gacha_draw` | `pool_id, count` | `results[]` | count: 1 or 10 |
| `iap_purchase` | `tier, platform` | — | 真金充值成功（`app/nav/shop/iap.ts`），platform ∈ apple/google/paddle |
| `starter_buy` | `product_id, platform` | — | 新手礼包购买成功 |
| `battlepass_buy` / `battlepass_claim` | — | — | 战令购买 / 领取 |
| `recharge_milestone_claim` / `promo_redeem` / `fate_redeem` | — | — | 充值里程碑 / 兑换码 / 命运点兑换 |
| `ads_reward` | `coins, platform` | — | 激励视频发奖成功 |
| `daily_checkin` / `daily_reward_claim` / `weekly_chest_claim` / `event_claim` | — | — | 留存四件套的领取（RETENTION_DESIGN） |
| `equip_craft` / `equip_enhance` / `equip_reforge` / `equip_salvage` / `equip_equip` / `card_fuse` / `card_lock` | — | — | 养成动作（"这系统有没有人用"） |

> ⚠️ **2026-09-20 修**：上表 `iap_purchase` 往下的十九个事件**从落地起就不在 `DEFAULT_CONFIG` 里**，于是全部回落到 `defaultSample: 0.1`。
> 由于所有漏斗查询都按 `device_id` 去重，10% 采样**不是把柱子等比缩短**，而是随机决定某台设备"看起来有没有签到"——付费与留存两条线的读数在此之前不可用。
> 同批修的还有 `shop_open` 0.5 vs `shop_buy` 1.0：分母半采样、分子全采样，§9.3 的经济漏斗转化率系统性虚高约 2×。
> 门禁：`client/test/analyticsEventConfig.test.ts`（客户端发的每个事件名必须在 `DEFAULT_CONFIG` 里有显式条目，反向也查——配了却没有调用点的条目同样红）。
> 被这条门禁扫出来的两个死条目 `upgrade`/`recharge` 已删：§12.1 曾记它们接在 `goLevelPrep`/`goShop` 上，但那两处在后来的 `nav/` 拆分中没了，配置留了下来。

### 5.5 社交层（Social）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `friend_add` | — | 加好友成功 |
| `pvp_room_create` | `mode` | mode: friendly/ranked |
| `pvp_match_start` | `mode` | 成功匹配开局 |
| `pvp_queue_cancel` | `wait_sec` | 排位队列里主动退出（2026-09-20 补）。`wait_sec` = 从进队到退出的墙钟秒数——**"等多久就放弃"是定匹配超时的那个数**，此前没有任何测量 |
| `pvp_match_bot` | `wait_sec, difficulty` | 排不到真人、服务端下发 `match_bot` 兜底成机器人局（feature flag `match_bot_fallback`）。对玩家静默，此前在数据里也静默 |
| `pvp_room_join` | — | 用好友房邀请码发起加入 |
| `pvp_room_error` | `error` | 房间侧错误码（邀请码失效、`PREMATCH_LOST` 等）——加入失败是玩家分不清"码错了"还是"游戏坏了"的死胡同 |

### 5.6 流失信号（Churn Signals）

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `churn_signal` | `reason, scene` | reason: background/explicit_exit/idle_10min（后者 2026-09-20 接线，见下） |
| `tutorial_start` / `tutorial_complete` | `level_id` | 开始/完成新手引导（§9.6 引导漏斗用） |
| `tutorial_skip` | `step` | 跳过引导（`step:'tutorial'`，来自 `game.ts`；`step:'intro'` 已改用专属 `intro_skip`，见下） |
| `tutorial_step` | `level_id, phase, step_key, step_index` | 教程内部小步骤（§9.7 教程步骤漏斗用），`step_key` 见 `TUTORIAL_ORDERED_KEYS` |
| `nav_checkpoint` | `scene` | 场景级漏斗用（§9.7），100% 采样，仅在 `screen_view` 命中场景白名单时自动补发 |
| `login_gate_hit` | `scene` | 离线功能门控弹「需要登录」 |
| `login_submit` | `mode` | 提交登录/注册表单（mode: login/register）。2026-09-20 补——此前 `LoginScene` 除 `screen_view` 外零埋点，**新客第一道硬墙有多少人过去了、剩下的被哪个错误挡住，全不可知** |
| `login_ok` | `mode` | 登录/注册成功 |
| `login_fail` | `mode, error` | 失败。`error` 取**服务端错误码**（`ApiError.code`）或 `network`/`no_api_base`，不是翻译后的文案——要分的是"密码错了"（会重试）和"邮箱被占用"/网络失败（会走人） |
| `login_skip` | — | 在登录页选「先玩离线」。即"拒绝注册"这条分支 |

> **成功/失败为什么是两个事件名而不是一个带 `ok` 的事件**：§9.6 的首会话 `actions` 分布按**事件名**统计去重设备数、不看 props。合成一个名字，在唯一已经把新客 cohort 隔离出来的那张报表里两者就分不开了。
| `intro_complete` / `intro_skip` | — | 首启故事 `IntroScene` 看完/跳过（`app/nav/auth.ts` `goIntro` 的 `onFinish(skipped)`），design-doc-audit-2026-07 补齐——此前这一步完全没有埋点。100% 采样，纳入 §9.6 `ONBOARDING_STEPS` 的 `intro_seen` 步骤 |

### 5.6a `idle_10min`：人还在屏幕前，手已经停了（2026-09-20）

§5.6 从一开始就写着这个 reason，§12.2 和 §12.6 两次押后，理由每次一样：
**埋点层看不见输入**。它没有 `InputManager`，也不能去拿——`analytics/index.ts` 被
`app/createAppCore.ts` import，而后者是**刻意无渲染**的（headless E2E 要驱动同一个 core），
从输入到时间戳的每一条路（`InputManager` → `render/renderPolicy`）都会把 PIXI 拖进那张图。

所以**探针是注入的**：`app.ts`（唯一有资格同时碰两边的文件）把 `render/renderPolicy.ts` 的
`msSinceActivity` 传给 `analytics/idleWatch.ts`。那个时间戳本来就存在——每个平台适配器的指针
事件都要经过 `holdRenderActive()` 去解帧率节流。没有新测量，没有新钩子。

三条不许误报的规矩（`client/test/analyticsIdleWatch.test.ts` 逐条钉住）：

1. **一次离开只报一次**，有输入才重新上膛；否则一个 AFK 玩家每分钟给你一条。
2. **不认领「没在看的那段时间」**：读数被夹在「watch 启动以来」和「最近一次回到前台以来」之内。
   `lastActivityMs` 是 renderPolicy 的模块级变量，`RenderPolicy.install()` 之前它的含义是
   「还没人说过话」——不夹的话，开了二十秒的游戏第一次检查就能报出十分钟空闲。
3. **后台不查**：那次离开已经由 `churn_signal{reason:'background'}` 报过了，
   而且后台标签页「没有输入」是白捡的——再报一次等于用一个「玩家正看着屏幕」的 reason 重复计数。

**不调 `endSession()`**（`background`/`explicit_exit` 会调）：会话没结束，人可能回来。

### 5.6b 渲染画像（Render Profile，ADR-084）

真机上的帧数与重绘率。ADR-083 的三个渲染节流（dpr 上限 2 / `maxFPS` 60 / 菜单场景按需重绘）只在一台 Windows 桌面量过；iOS 和微信是耗电报告的来源，却恰好是**读不到数字**的两个宿主（微信打不开控制台，iOS 要接 Safari Web Inspector）。所以让设备自己报。

上报方 `cache/PerfMonitor`（它本来就在为卡顿告警按 2 秒窗口采样 fps）。**每会话最多 6 条**：首条约 30 秒，之后每约 5 分钟。**只统计全程可见的窗口**——被浏览器节流的后台标签页会报出假的 4 fps。采样率 **1.0**（这条事件的意义就是跨宿主/跨设备对比，采样掉即失去意义；量与 `session_start` 同级）。

| 事件 | 必填属性 | 说明 |
|---|---|---|
| `render_profile` | `scene, spanS, windows, fpsP50, fpsMin, fpsMax, maxFps` | `scene` 取自 anomaly 的 `getActiveScene()`，于是可按场景切（世界地图 vs 大厅 vs 战斗）；`spanS`/`windows` 是本条覆盖的可见时长与窗口数 |
| （同上，装了 RenderPolicy 时附加） | `tickPerSec, paintPerSec, skipPct` | **`paintPerSec` vs `tickPerSec` = 按需重绘有没有在工作**。取自 `render/renderStats.ts` 计数器的**差值**，不是累计值 |
| （同上，app.ts 传入 renderer 事实时附加） | `res, dpr, dprCapped, canvasW, canvasH` | **`dprCapped`（`dpr > res`）= dpr 上限在这台设备上到底有没有生效**。微信永远为 `false`：`WechatPlatform.devicePixelRatio` 硬编码 1，那条旋钮在微信是空操作 |
| （同上，帧成本）2026-09-13 起 | `updP50, rndP50, updMax, rndMax` | **一帧的钱花在哪**。均为每 **tick** 的毫秒数（`rnd` 因此已含 `skipPct` 的折扣，可直接与帧周期 `1000/fpsP50` 相比）；两者之和接近帧周期 = 主线程是瓶颈，远小于帧周期 = 时间不在我们的 JS 里（显示刷新上限 / GPU 填充率 / 合成器）。见 `claudedocs/client-render-budget.md` §9.6 |

Grafana 上值得先看的两张：按 `platform` 切的 `fpsP50` 分布（iOS/微信/web），以及按 `scene` 切的 `skipPct`（reactive 的菜单应该显著大于 0，`live` 的战斗应该等于 0）。

### 5.6c 崩溃与埋点的共同 id（2026-09-20）

客户端有两条各自独立的自述通道，此前**没有任何共同键**：

| | 崩溃/异常通道 | 埋点通道 |
|---|---|---|
| 落地 | Loki（`/client/anomaly` → `metaserver/clientLog.ts`） | Mongo（`/analytics/events`） |
| 标识 | `publicId` | `session_id` |

`publicId` 登录前根本不存在，而且它标识的是**一个人**、不是**一次运行**，所以
「闪退的那些人是不是当场就流失了」只能靠对两边的时钟和一个 platform 字符串肉眼凑——
几百并发以下基本靠猜。

**做法一：同一个 sid。** 会话 id 挪进 `client/src/analytics/session.ts`，第一次被读时生成，
两条通道都盖：埋点作为 `session_id`，异常通道作为信封里的 `sid`。于是
`{source="client",kind="anomaly"} | logfmt | sid="…"` 和 Mongo 上按 `session_id` 查的是**同一次运行**。
它单独成模块是因为**次序**：崩溃哨兵在 `startApp()` 里就跑了，远早于 `analytics.init()` 建队列，
读 id 不能依赖埋点已经初始化（甚至不能依赖埋点是开着的——离线包不调 `init`，它的崩溃报告一样该有 id）。

**每条事件可以覆盖信封的 sid**：崩溃哨兵是在**下一次**启动时报告**上一次**死掉的那次运行的，
所以它那条线必须写死掉的那个 sid，而不是正在读取遗骸的这个（和 `orient`/`vp` 走的是同一个
`ctx` 机制，理由也一样）。哨兵因此把自己的 sid 一起持久化。
服务端对 `sid` 只认 `^[A-Za-z0-9_-]{1,64}$`，不合就整个丢掉——这是个客户端给的值、会内联进每一行、
而且读的人要拿它当 join key 精确匹配，放行自由文本等于让人往里注 logfmt。

**做法二：`prev_session_crash`。** 哨兵检测到上次非正常退出时，除了 Loki 的 crash 报告，
再往埋点发一条 `prev_session_crash{prev_sid, alive_ms}`。因为「闪退的设备第二天还回来吗」
是个**留存问题**，只能在存留存数据的那边问；`prev_sid` 保证需要时还能跟 Loki 那半拼回去。
和 crash 报告同一道闸：dev 构建（`buildVersion '0.0.0'`）不报，热重载不是闪退。

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
