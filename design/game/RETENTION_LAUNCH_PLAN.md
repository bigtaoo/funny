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

---

## §6 已知阻塞项

- **CrazyGames 门户测试环境**：`acceptance-smoke.md` CrazyGames 那 9 行从未在真实门户 iframe 里跑过；SSO（`user` 模块）代码会按公开 SDK v3 文档实现，但登录成功与否只能等有门户测试入口时联调，现在只能本地 mock 验证。
