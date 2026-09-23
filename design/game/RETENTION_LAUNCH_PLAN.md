# CrazyGames 上线留存计划

> 状态：**进行中**（2026-09-23 立项）· 权威：本文（CrazyGames 上线前后的留存修复排期与决策记录）· 相关：[`ANALYTICS_DESIGN.md`](ANALYTICS_DESIGN.md) / [`ANALYTICS_DESIGN_BACKEND.md`](ANALYTICS_DESIGN_BACKEND.md)（埋点权威）、[`ONBOARDING_DESIGN.md`](ONBOARDING_DESIGN.md)（FTUE 流程权威）、[`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)（签到/任务权威）、[`COMPLIANCE_GLOBAL.md`](COMPLIANCE_GLOBAL.md)（年龄门/同意墙权威）

## 0. 背景与目标

预计上线后 2–3k/日测试玩家。目标 **D7 ≥ 8%**（CrazyGames 门户导量典型值 2–5%，8% 接近前 10% 水平）。按 D7/D1 ≈ 0.3 的常见比例倒推，D1 需要做到 **25–30%**，是「10% 就算及格」这个直觉的三倍。

**两个前提性判断**（不是本文拍板，是本文存在的理由）：
1. 埋点本身修复**不会带来一分留存**——只是让方向盘可见。真正拉留存的是 Phase 3 的产品改动。
2. Phase 3 的每一刀改动必须能用 Phase 2 的分组留存验证，不能盲改——盲改的风险是把已经不多的测试流量浪费在错误方向上。

## 已拍板的两个决策（2026-09-23，用户确认）

1. **接 CrazyGames SDK 的 `user` 模块（SSO）**。登录墙可拆、身份跨设备稳、留存口径和门户对齐。
2. **登录墙是否后移到第一局之后 —— 视 Phase 2 分组留存数据而定**。用户原话「如果对于提升留存有帮助，可以」，理解为：**先测（登录 vs 离线 cohort 的留存切片），数据支持再动**，不是无条件先改。若后续判断改为「直接做」，回来改这一条。

## 决策树（上线后第一周诊断顺序）

```
reach_rate（boot→session）低？      → 加载/兼容性问题，查 3.1
  否 ↓
onboarding funnel 哪步断崖？        → 那一屏是问题，查 3.1/3.2
  否 ↓
D1 尚可(>20%) 但 D7 <3%？           → 第 2-7 天没事做，查 3.3/3.4
  否 ↓
D1 也低(<15%)？                     → 首会话体验，查 3.2
```

---

## Phase 0 · 基线与门禁

| # | 内容 | 产出 | 状态 |
|---|---|---|---|
| 0.1 | VPS Mongo 现网基线：boot funnel reach_rate、load_time p50/p90、onboarding funnel、现有 D1–D7 | 「我们今天在哪」表 | ⬜ |
| 0.2 | CrazyGames 门户冒烟（`acceptance-smoke.md` 9 行，从未在门户环境跑过） | 门户这条路本身是通的 | ⬜（需门户测试入口，见 §6 阻塞项） |
| 0.3 | 容量核算：2–3k DAU × 全采样估 15–30 万事件/天 × TTL 90 天 → VPS 磁盘/索引 | 不会上线一周写满盘 | ⬜ |

**判据**：0.1 拿不到数就先修 0.1，不下探。

---

## Phase 1 · 让留存读数可信

| # | 内容 | 落点 |
|---|---|---|
| 1.1 | `device_id` 持久化加固：localStorage + IndexedDB 双写；接 CrazyGames SDK `user` 模块拿门户级稳定身份 | `client/src/platform/uuid.ts`、`CrazyGamesPlatform.ts` |
| 1.2 | `queryRetention` 加 `platform` 过滤 + 新客 cohort 模式（首次 session_start 在当天） | `server/analyticsvc/src/service/traffic.ts` |
| 1.3 | ops 页面留存卡接 platform 下拉 | `tools/ops/src/pages/analytics.ts` |
| 1.4 | 采样自查：`analyticsEventConfig.test.ts` 门禁复跑，确认新事件没漏配 | — |

---

## Phase 2 · 分组留存（定位「为什么」的唯一工具）

通用 `type=retention_by` endpoint，按首会话属性切 D1/D7：

- 加载时长分桶
- 是否完成教程
- 首战胜负 / 是否被匹配给 bot
- **登录 vs 离线模式**（§0 决策 2 的判据）
- 浏览器 / 设备类型 / WebView / 地区

配套：会话时长分布（`sessions.duration_sec` 已入库未被查询）、流失会话最后一屏（`churn_signal{scene}` 聚合）。

---

## Phase 3 · 产品侧杠杆

### 3.1 进场摩擦（影响 D1，预期最大）
- CrazyGames SSO 接入（决策 1）
- 登录墙位置——**待 Phase 2 数据**（决策 2）
- 年龄门 + 同意墙合屏
- 加载时长优化（用 `load_time` 阶段拆分找大头）

### 3.2 首局体验（影响 D1→D2）
- 教学完成率、教学时长、首场真实对局结果分布（Phase 2 验证）
- 必要时新客匹配保护期

### 3.3 回访钩子（影响 D2→D7，8% 的主战场）
- 首胜结算页显式展示「明天回来能领什么」
- 未领奖励红点门户可见
- 门户无推送通道，回访靠 loss-aversion + 短周期目标

### 3.4 第 2–7 天有事做（影响 D7 尾部）
- 核对章节解锁节奏、排位开放门槛、世界地图软门禁——新客第 2 天撞墙 D7 就没了

---

## Phase 4 · 迭代机制
- 所有 3.x 改动走 feature flag，可单独开关、可分流量
- 每周 cohort 复盘：新客 D1/D7 + Phase 2 分组切片
- 门户导量按留存/时长滚动调整——前两周迭代速度决定天花板

---

## 排期

| Phase | 依赖 | 可并行 |
|---|---|---|
| 0 | — | 先做 |
| 1 | 0.1 | 1.1 可与 3.1 合并做 |
| 2 | 1.2 | — |
| 3 | 2（3.1 的非登录墙部分可提前） | — |

最短可上线路径：Phase 0 + 1.1 + 1.2 + 3.1（非登录墙部分），约一周；其余在导量期间滚动。

---

## §5 已完成记录

（按完成顺序追加，含日期、分支、要点）

### 2026-09-23 Phase 0 基线

直连 VPS analyticsvc 生产库（`/internal/query`，14 天窗口）拉的现网数字：

- **流量现状**：DAU 1–4/天（`dau` 查询），几乎全是内部测试设备——`boot_funnel` 里 `boots` 大多为 0（说明 §3.6b 的启动计数在 09-20 才随代码一起上线，之前的日期没有这一列数据，只有 `sessions` 有数）、`first_session.cohort_size = 0`（14 天窗口内没有真正的新客首会话，测试设备早就不是「新」了）。
- **结论：当前生产库里的 D1/D7 数字（`retention` 查询里 cohort_size 2–4 的那些行）不能当真实留存读——样本是同一批返场测试的开发者设备，不是自然流量。** 上线前任何"我们现在 D7 是 X%"的说法都不成立，基线要等真实门户流量进来才立得住。
- **容量核算（0.3，结论：不是瓶颈）**：现有 `notebook_wars_analytics` 库 dataSize 12.72MB / storageSize（压缩后）1.86MB / indexSize 4.20MB，`events` 20,030 条（90 天窗口内，几乎全部来自内部测试）。按 2–3k DAU、假设每会话 30–60 条事件（session 生命周期 + nav_checkpoint 100% 采样 + 首会话教程步骤等）估算，稳态（90 天 TTL 打满）约 800 万–2700 万条事件；用现网 dataSize/doc 比例（~635 B/doc）外推，dataSize 约 5–17 GB，考虑到实测 6.8:1 的压缩比，storageSize 落在 1–2.5 GB 量级。VPS 磁盘 `df -h /`：38G 总量，**19G 可用**——analytics 单独看没有风险，但要留意和其它服务（replay/日志）共享同一块盘，上线后一周复查一次实际增长速度而非只信这个估算。
- **0.2 门户冒烟——仍是阻塞项，未变化**：`acceptance-smoke.md` 的 CrazyGames 9 行需要游戏真的跑在 `crazygames.com` 的门户 iframe 里（广告 SDK 加载、`isOffOrigin` 生效与否、外链策略），本地 `npm run build:crazygames` 只能确认构建产物本身不报错，**验证不了门户宿主行为**。需要用户提供 CrazyGames 开发者后台的测试/预览链接才能往下走，见 §6。

**下一步（Phase 1）**：VPS 现网数据已确认可查询、可信度已标注清楚，转入 1.1–1.4 的代码改动。

### 2026-09-23 Phase 1.1 + 3.1（部分）：身份持久化 + CrazyGames SSO

分支 `feat/retention-phase1`。

**1.1 device_id 持久化加固**（`client/src/platform/uuid.ts`）：`getOrCreateDeviceId` 改异步，localStorage 仍是主路径，IndexedDB 作为独立存储做镜像写入 + localStorage 为空时的恢复源。**明确不解决** Safari ITP 对 script-writable storage 的 7 天清除（两者会被一起清），那个问题的真正解法是下面这条。

**3.1（CrazyGames SSO 部分，用户已拍板接受）**：
- 新 `AuthCredential` 变体 `{kind:'crazygames', token}`；`CrazyGamesPlatform` 接入 SDK v3 `user` 模块（`isUserAccountAvailable/getUser/getUserToken/showAuthPrompt`，按 [官方文档](https://docs.crazygames.com/sdk/html5-v2/user/) 实现，**门户环境未联调过**，见 §6）。
- **静默路径**（零摩擦）：`resolveEntry()` 现在对 `crazygames`/`wx` credential 一视同仁——玩家已登门户账号时静默换 token 进大厅，不碰登录墙。玩家未登门户账号时行为与改动前完全一致（回退到 device credential，仍见登录页）。**没有动登录墙本身**，符合决策 2「先测数据再决定」。
- **主动路径**：LoginScene 新增「Sign in with CrazyGames」按钮（仅 `platform.signInWithCrazyGames` 存在时渲染，其它平台像素级不变），复用 `doAuth()` 的 token 持久化 + 埋点（`login_submit/ok/fail{mode:'crazygames'}`，三选一新增值）。
- **服务端**：新端点 `POST /auth/crazygames { token }`（`server/metaserver/src/service/auth/crazygames.ts` + `crazygamesAuth.ts` 的 RS256 校验，公钥 `https://sdk.crazygames.com/publicKey.json`，**不**复用 `NW_JWT_SECRET`）。复用既有 `resolveByOAuth('crazygames', userId, ...)`——与 Google/Apple 同等耐久性（`isAnonymous:false`），未新增账号解析逻辑。`NW_CRAZYGAMES_GAME_ID` 未配置（游戏尚未在 CrazyGames 后台登记）时端点返回 `OAUTH_FAILED`，不影响其它登录方式；已接入两份部署 compose + `ecosystem.config.cjs` + `.env.example`，过 `deploy-config.test.ts` 门禁。
- 测试：`uuid.test.ts`（11，含 IndexedDB 恢复/失败路径的手写 fake）、`crazyGamesSignIn.test.ts`（7）、`auth-reconnect-prompt.test.ts`（+3，静默/主动/取消三态）、`crazygamesAuth-unit.test.ts`（8，真 RSA 密钥对，无网络）、`auth-crazygames-unit.test.ts`（8，镜 `auth-oauthbind-unit.test.ts` 写法）——client/server 两端 tsc + webpack build（web/crazygames 两个 target）+ 全量 vitest 均过。
- **仍未做**：登录墙位置本身（3.1 剩余部分）——留给 Phase 2 数据决定。

覆盖：见上；文档：本节 + `ANALYTICS_DESIGN.md §5.6`（`login_submit` mode 新增 `crazygames`）+ `ACCOUNT_DESIGN.md §3`（新端点契约）。

---

## §6 已知阻塞项

- **CrazyGames 门户测试环境**：`acceptance-smoke.md` CrazyGames 那 9 行从未在真实门户 iframe 里跑过；SSO（`user` 模块）代码会按公开 SDK v3 文档实现，但登录成功与否只能等有门户测试入口时联调，现在只能本地 mock 验证。
