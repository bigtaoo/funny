# Feature Flags — 功能开关系统设计基准

> 状态：已上线（F1/F2/F4 + 首条 flag `match_bot_fallback` 端到端，见 §8）· **F3（公开 `GET /bootstrap` + 客户端 `FeatureFlags`）+「客户端日志定向采集」(§9) 核心闭环（步骤 1–6）已实现**（见 §8「2026-06-24 · 客户端日志定向采集」）· 权威：本文（feature flag 机制）· 接口契约 → [SERVER_API.md](SERVER_API.md) + `server/contracts/openapi.yml` · 更新：2026-06-24

运营侧的**全局功能开关**：一处翻开关，线上（部分或全部用户）即时生效。用于 kill switch（关闭出故障的玩法）、灰度发布（新功能先放一部分人）、维护模式、按区域/平台分发。

---

## 0. 一句话边界（先划清，避免混淆）

| 概念 | 是什么 | 存哪 | 谁不同 |
|---|---|---|---|
| **Feature Flag（本文）** | 运营控制的**全局**开关，带定向规则 | admin 库 `featureFlags` 集合 | 运营改一次，按规则影响一批人 |
| `SaveData.flags`（已存在，**不是本系统**） | 每个**玩家自己**的客户端状态位（如「新手引导看过没」） | 业务库 `saves`，随存档 | 每个玩家各不相同，玩家行为驱动 |
| `AccountDoc.flags`（已存在，**不是本系统**） | 账号级标记（banned / gdprConsent / 反作弊警告数） | 业务库 `accounts` | 账号生命周期驱动 |

**铁律**：feature flag 走独立通道，绝不复用 `SaveData.flags`。两者语义、所有权、生命周期完全不同。

---

## 1. 设计目标与决策

第一版即支持**全局 + 定向（比例 / 区域 / 平台 / 白名单）**，**客户端与服务端双侧拦截**（拍板 2026-06-24）。

| 决策 | 选择 | 理由 |
|---|---|---|
| flag key 形态 | **类型安全白名单**（代码里登记，非任意字符串） | 前后端用 `FlagKey` 类型，拼错编译期报错；默认值兜底 |
| 定向能力 | 比例灰度 + 区域 + 平台 + 账号白/黑名单 | 覆盖灰度发布、按区上线、定向内测全部场景 |
| 定向规则求值在哪 | **统一服务端求值**（`@nw/shared` 纯函数） | 单一真源；不把规则/白名单下发客户端（防泄露未上线功能 + 防作弊） |
| 客户端下发通道 | **新增公开 `GET /bootstrap`**（匿名可调） | kill switch / 维护模式必须**登录前**就能拿到，不能搭 `GET /save` |
| 处理中心 | **复用 admin 进程**（唯一碰库/唯一写/对内出原始规则），不新建 service | admin 已握 flag 库+RBAC+audit+编辑 UI；新进程在多区域要处处部署，逻辑却极薄，不值（详见 §4.2） |
| 服务端分发 | 不连库的后端轮询 admin 内部端点 + 短 TTL（30s）缓存 + 本地求值 | 先不上 Redis pub-sub，够用且简单；后续可平滑升级 |
| 存储库 | admin 库新增 `featureFlags` 集合 | 配置数据天然属 admin 库（与 compTickets/auditLog 同列）；与玩家数据/权限隔离一致 |
| 后台入口 | tools/ops 新增独立菜单 + admin 能力点 `config.manage` | 复用现有 RBAC + auditLog 模式 |

---

## 2. 数据模型

### 2.1 Flag 注册表（代码侧白名单，`@nw/shared`）

新建 `server/shared/src/featureFlags.ts`：

```ts
export const FEATURE_FLAGS = {
  new_shop_ui:      { default: false, desc: '新商店界面', side: 'client' },
  siege_v2:         { default: false, desc: '围攻 v2 引擎', side: 'both'   },
  maintenance_mode: { default: false, desc: '全局维护(拒登录)', side: 'server' },
  // …新增 flag 在此登记
} as const;

export type FlagKey = keyof typeof FEATURE_FLAGS;
```

- `default`：库里查不到 / 库挂了时的兜底值，**必须存在**。
- `side`：`client | server | both`，仅作文档/校验提示，标明这个 flag 在哪侧被读。
- Mongo 只存「被运营覆盖过的 flag 的规则」；没覆盖的用 `default`。

### 2.2 Flag 规则文档（admin 库 `featureFlags` 集合）

```ts
export interface FeatureFlagDoc {
  _id: FlagKey;            // flag key 即主键
  enabled: boolean;        // 总闸：false → 任何人都关（无视定向）
  rollout?: {
    pct?: number;          // 0-100，按 hash(flagKey+accountId) 稳定分桶
    regions?: string[];    // 命中的部署区域（见 DEPLOY_TOPOLOGY）
    platforms?: string[];  // 'web' | 'wechat' | 'crazygames'
    allowAccounts?: string[]; // 白名单：命中即开（盖过 pct/region/platform）
    denyAccounts?: string[];  // 黑名单：命中即关（盖过 allow 之外的一切）
  };
  desc?: string;
  updatedAt: number;
  updatedBy: string;       // admin 账号 ID
}
```

索引：`featureFlags.createIndex({ updatedAt: -1 })`。

---

## 3. 求值逻辑（`@nw/shared` 纯函数，前后端唯一真源）

```ts
export interface FlagContext {
  accountId?: string;   // 未登录时 undefined
  region?: string;
  platform?: 'web' | 'wechat' | 'crazygames';
}

export function evaluateFlag(key: FlagKey, doc: FeatureFlagDoc | null, ctx: FlagContext): boolean
```

**求值顺序（短路）**：

1. `doc` 不存在 → 返回 `FEATURE_FLAGS[key].default`。
2. `doc.enabled === false` → `false`（总闸优先于一切）。
3. `denyAccounts` 命中 → `false`。
4. `allowAccounts` 命中 → `true`（盖过 region/platform/pct）。
5. `regions` 有限定且当前 region 不在内 → `false`；`platforms` 同理。
6. `pct` 有限定：`hash(key + accountId) % 100 < pct` → 否则 `false`。未登录无 accountId 时按 `pct>=100` 才算命中（保守）。
7. 全部通过 → `true`。

hash 用稳定算法（如 FNV-1a），保证同一玩家在同一 flag 上结果不抖动（灰度名单稳定）。

---

## 4. 分发与读取

> **拓扑拍板（2026-06-24）**：**不新建 service**。`admin` 进程即「处理中心」——唯一碰 flag 库、唯一写、对内暴露原始规则。其余所有进程（含 metaserver）都是「轮询 admin + 本地求值」的消费者，零新进程。
> 大量后端（gameserver / matchsvc / gateway 等）**不连库**，统一轮询 admin 的内部端点拿**原始规则**，用 `@nw/shared` 的 `evaluateFlag` 在本进程内按当前 user 上下文现场求值。
> 关键区分：**「服务器实时求值成 true/false」只对客户端成立**（metaserver 在 `/bootstrap` 请求时算）；内部后端拿的是规则、自己现场算——因为一个进程要处理海量 accountId，中心无法预先替它逐个算好，但它手上就有当前这个 user 的 accountId。求值函数前后端同一个，单一真源。

```
tools/ops ──PUT /admin/config/flags──▶ admin ──▶ admin库 featureFlags (系统记录 + audit)
                                          ▲  GET /admin/internal/flags (X-Internal-Key, 原始规则, 缓存30s)
            ┌─────────────────────────────┼──────────────────────────────┐
       metaserver                  gameserver/matchsvc/gateway/worldsvc…   （都是消费者）
   (轮询→缓存规则)                      (轮询→缓存规则→本地 evaluateFlag)
            │
   公开 GET /bootstrap ──▶ 客户端 (resolved 布尔)
```

### 4.1 客户端：公开 bootstrap 接口

```
GET /bootstrap?platform=web        （匿名可调；登录后带 token 则注入 accountId 求值）
→ { flags: Record<string, boolean>, minClientVersion?: string, ... }
```

- metaserver 实现：从缓存取全部 flag docs → 对每个白名单 key 跑 `evaluateFlag(ctx)` → 只返回**求值后的布尔 map**（不返回规则、不返回白名单）。
- region 由部署侧注入（metaserver 知道自己在哪区），platform 由 query 参数带入，accountId 从可选 token 解析。
- 客户端在 `createAppCore` 启动早期、auth 之前先拉一次 `/bootstrap`（拿 maintenance_mode 等 kill switch）；登录后可再拉一次拿到带 accountId 的精确结果。
- 客户端封装 `FeatureFlags.isOn(key: FlagKey): boolean`，UI/入口据此显隐。openapi codegen 自动镜像类型。

### 4.2 处理中心：admin 内部端点

- admin 新增内部端点 `GET /admin/internal/flags`（`X-Internal-Key` 鉴权，**只返回原始规则全量**，不求值）。这是所有不连库后端的唯一数据来源。
- 为什么是 admin 而不是新 service / metaserver：
  - admin 本就唯一读写 flag 库（`featureFlags` 与 `auditLog` 同库，数据/审计同源）；
  - admin 玩家不可达，内部服务轮询它方向天然正确；
  - 新建 flagsvc 在多区域拓扑下每区都要多部署/监控/扩容一个进程，而逻辑仅「读规则+求值」，不值；
  - metaserver 是公开面，让内部服务依赖公开面不如依赖内部 admin 干净。

### 4.3 服务端消费者：缓存 + 本地求值

- `@nw/shared` 提供 `FeatureFlagCache`：启动拉一次全量（轮询 `admin /admin/internal/flags`）→ 每 30s 刷新 → 暴露 `isOn(key, ctx)`（内部即调 `evaluateFlag`）。
- 需要读 flag 的进程（metaserver / gateway / gameserver / matchsvc / worldsvc …）各自注入该缓存。
- admin 不可达时：吃上次缓存；冷启动且从未拉到时 → `default` 兜底。优雅降级，不阻塞主流程。
- 典型用法：`maintenance_mode` 在 gateway/metaserver 登录入口拦截；`siege_v2` 在 worldsvc 围攻入口按 user 分流。

---

## 5. 运营后台（admin + tools/ops）

- admin 新增能力点 `config.manage`（见 `server/shared/src/admin.ts` AdminCapability）。
- 端点（openapi.yml，operationId）：
  - `GET /admin/config/flags` → `getConfigFlags`：列出全部白名单 flag + 当前规则 + 默认值。
  - `PUT /admin/config/flags/{key}` → `upsertConfigFlag`：写入/更新规则，**每次写 auditLog**（actor / 前后值 / 时间），与补偿审批一致。
- service：`AdminService.upsertFlag(actor, key, rule)`，校验 key 在白名单内、pct 范围、region/platform 合法值。
- tools/ops 前端：独立「Feature Flags」菜单，与 monitor / comp 同级；开关列表 + 总闸 toggle + 定向规则编辑 + 最近修改人/时间。

---

## 6. 实现阶段（建议）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **F1 核心** | `featureFlags.ts`（白名单+default+evaluateFlag+hash）+ admin 库集合 + service.upsertFlag + audit | 单测覆盖求值顺序 6 条；tsc 通过 |
| **F2 后台** | admin 能力点 + GET/PUT 端点（openapi）+ tools/ops 菜单 | 后台能翻开关、改定向、看审计 |
| **F3 客户端下发** | `GET /bootstrap` + 客户端 `FeatureFlags.isOn` + createAppCore 早拉 | 翻 maintenance_mode → 客户端登录前即拦截 |
| **F4 服务端读取** | `FeatureFlagCache` + 各进程接入（先 gateway 维护模式、worldsvc 围攻分流各一个示范） | 翻开关 ≤30s 服务端生效 |

---

## 7. 待定 / 后续

- **实时性**：30s 轮询满足绝大多数运营需求；若要秒级（如紧急 kill switch），后续可加 Redis pub-sub 推送失效（infra 决策，非首版）。
- **审计可视化**：flag 变更历史可复用 auditLog 现有查询，暂不单独做时间线 UI。
- **环境隔离**：dev/staging/prod 各自一套 admin 库，flag 天然隔离，无需额外设计。
- **客户端缓存**：bootstrap 结果客户端是否本地短缓存（防抖）——首版每次启动实拉，简单优先。

---

## 9. 客户端日志定向采集（2026-06-24 拍板 · 核心闭环已实现，见 §8）

**目标**：运营在后台填某个玩家的 **9 位 publicId** + 指定日志级别，被定向的客户端**每 2 分钟**拉一次实时配置，命中后把对应级别及以上的日志**持续批量上报**到 Loki，运营在 Grafana 按 publicId 查这个玩家的客户端日志。用于线上单个玩家「卡住/报错但本地无人在场」的远程排障。

> 关键前提：当前 Grafana 里**只有服务端容器 stdout**（Alloy 抓 docker socket）；客户端日志只打到浏览器 console（`client/src/net/log.ts`），**无任何上报通道**。本特性同时把 F3（公开 `GET /bootstrap` + 客户端轮询）建起来——这是客户端首个 flag 消费场景。

### 9.1 定向键 = publicId（不是 accountId）

- 「9 位数 id」= `AccountDoc.publicId`（全局唯一、稀疏唯一索引，首次鉴权惰性生成），与内部 `accountId`(UUID/openid) 是两回事。flag 现有 `allowAccounts` 匹配 `accountId`，**不能**直接填 publicId。
- 拍板：**新增定向维度 `allowPublicIds`**（而非 publicId→accountId 查库映射）。运营在 ops 直接填 9 位 id 最直观；客户端自己知道自己的 publicId，轮询时带上，metaserver 注入 `ctx.publicId` 求值，**无需查库**、不污染 accountId 语义。
- `FlagRollout` 加 `allowPublicIds?: string[]`；`FlagContext` 加 `publicId?: string`；`evaluateFlag` 在「allowAccounts 命中即开」同一优先级（§3 第 4 步）加「allowPublicIds 命中即开」；`sanitizeFlagDoc` 解析该字段（同 strArr 容错）。
- **⚠ 排他定向必坑（实现时确认）**：`allowPublicIds` 与 `allowAccounts` 一样是**附加 override（命中即开）**，**不是排他过滤器**。若只填 `allowPublicIds` 而不设其它限定，`evaluateFlag` 走到末尾 `return true` → 该 flag **对所有人开**（=全量客户端上报日志，灾难）。**正确配法 = 灰度比例 `pct` 设 0（对其他人关）+ 仅把目标 publicId 填进 `allowPublicIds`**（命中者 override 放行）。ops『功能开关』页对 `client_log_*` flag 已显式提示此配法。

### 9.2 级别用「多 flag」编码（flag 只有 true/false）

登记 4 个分级 flag（`FEATURE_FLAGS`，default 全 `false`，side `client`）：

```ts
client_log_error: { default: false, desc: '客户端日志上报-error', side: 'client' },
client_log_warn:  { default: false, desc: '客户端日志上报-warn',  side: 'client' },
client_log_info:  { default: false, desc: '客户端日志上报-info',  side: 'client' },
client_log_debug: { default: false, desc: '客户端日志上报-debug', side: 'client' },
```

- 运营把目标玩家的 publicId 填进**想要级别**那个 flag 的 `allowPublicIds`（如要全量调试就填 `client_log_debug`）。
- 客户端拿到 resolved 布尔 map 后，取**最 verbose 的已开 flag** 作上传阈值（debug>info>warn>error），上传该级别及以上；**无任何命中 = 不上报**。

### 9.3 下发：F3 公开 bootstrap + 2 分钟轮询 + 只回 diff

- metaserver 接 `FeatureFlagCache`（轮询 admin 内部端点，复用 F4 同款），实现公开 `GET /bootstrap?platform=&publicId=`（匿名可调；publicId 由 query 带入注入 ctx，登录态带 token 时同时解析 accountId）。
- **只返回与 default 不同的 flag**（用户要求「只发和默认配置不同的」）：对全量白名单逐个 `evaluateFlag`，仅把 `resolved !== flagDefault(key)` 的塞进 `flags` map。绝大多数玩家拿到空 map → 零负担。
- 客户端 `FeatureFlags`：启动拉一次 + 每 **120s** 轮询一次；解析 `client_log_*` 推出当前上传阈值（含「关」）。仍遵守「服务端求值、不下发规则/白名单」原则——客户端只拿布尔结果。

### 9.4 上报：环形缓冲 + 持续批量（→ Loki）

- 客户端：扩 `client/src/net/log.ts` 加**内存环形缓冲**（始终保留最近 N 条，带 level/msg/ts/tag），命中级别前的上下文也能捞到。
- 命中定向后：每隔一段（如 30s）或缓冲达阈值，把 ≥阈值的日志批量 `POST /client/log`（body `{ publicId, platform, logs: [{level,msg,ts,tag,...}] }`）。
- metaserver `POST /client/log`：转发到 Loki push API（`NW_LOKI_PUSH_URL`，缺省指向 obs 栈 `http://loki:3100/loki/api/v1/push`），**label 仅 `{source="client", level=...}`**（低基数），`publicId` 放**行内**（高基数不进 label，查询用 `| logfmt | publicId="..."`）。Loki 不可达 → 静默丢弃，绝不影响玩家。**网络坑**：obs 栈当前是独立 compose/独立网络，metaserver 容器需能解析到 `loki` —— 部署时把 metaserver 接入 obs 网络或用 host 可达地址（实现时确认，见 `server/observability/README.md`）。
- 限频/防滥用：只有 publicId 命中定向的客户端才会上报（非定向客户端 bootstrap 空 map → 永不调 `/client/log`），天然限流；服务端可再对 body 大小/频率兜底。

### 9.5 后台与查询

- ops 前端 flag 编辑页加 `allowPublicIds` 输入框（与 allow/denyAccounts 并列）。
- Grafana 加「客户端日志」面板：`{source="client"} | logfmt | publicId="123456789"`。

### 9.6 实现顺序（建议）

1. ✅ `@nw/shared`：allowPublicIds + ctx.publicId + evaluateFlag + sanitize + 4 个 flag 登记 + 单测。
2. ✅ metaserver：FeatureFlagCache 接入 + `GET /bootstrap`(只回 diff) + `POST /client/log`→Loki。
3. ✅ 客户端：FeatureFlags 轮询(120s) + 环形缓冲 + 批量上报。
4. ✅ contracts/openapi：补 `/bootstrap` + `/client/log`。
5. ✅ ops 前端：allowPublicIds 编辑框（+ client_log_* 配法提示）。
6. ✅ Grafana：客户端日志面板（`grafana/dashboards/client-logs.json`）。

核心闭环 = 1–4（可端到端验证）；5/6 锦上添花可紧跟。验证只做 `tsc --noEmit` + webpack 构建。**全部已落地**（见 §8）。

### 9.7 客户端异常事件「全量」上报通道（2026-06-24 · 已实现，见 §8）

与 §9 的「日志定向采集」**并列、互补、反向**：定向采集只在被 `allowPublicIds` 点名的 publicId 上回捞日志；本通道相反——**任何**客户端遇到异常都**主动直报**，无需事先点名，专为「在全网定位野外异常」而设。

- **上报的 6 类异常**（客户端 `net/anomaly.ts` 的 `AnomalyType`）：
  - `mem` — JS 堆超阈值（`MemoryMonitor` 旁路喂入；与原有 `netLog('mem').warn` 入环形缓冲并行）。detail 除 `heap`/`poolTotal` 外带 `gpu:{tex,baseTex,nodes,tickers}`（2026-06-27 加，见 §8）——池空（`poolTotal.estMB≈0`）却堆涨时，这三个数把纯 JS 保留型泄漏定性到具体一类：`tex/baseTex` 增=纹理缓存无界、`nodes` 增=退场不 destroy 的场景图残留、`tickers` 增=`ticker.add` 漏配对 `remove` 的闭包钉死。
  - `cpu` — 主线程持续饱和（`PerfMonitor`，新增）：① `PerformanceObserver('longtask')` 长任务忙碌比 ≥ 0.5；② 持续低 FPS（连续 ≈10s < 30，用 `ticker.deltaMS` 估，微信亦可）。浏览器无直接 CPU API，主线程饱和是其可观测等价。
  - `webgl_lost` — `webglcontextlost`（黑屏类故障关键信号）。
  - `anr` — 主循环卡死：独立 wall-clock 看门狗，主线程冻结 >4s（恢复后据时间漂移反推；`document.hidden` 时不计，避免后台节流误报）。
  - `jserror` — 未捕获异常 / Promise 拒绝（`log.ts` 经 `setErrorSink` 旁路）/ 微信 `wx.onError`。
  - `crash` — **上次会话**异常退出（崩溃哨兵下次启动补报，见下）。
- **崩溃捕获两路**（直答「客户端崩溃有机会上报吗」）：
  - ① **离场急发**：`pagehide` 用**无凭据 keepalive fetch**（`credentials:'omit'`，存活于页面卸载）抢发待发队列 + 最近 12 条面包屑——逮住「软崩溃 / 卡死后被关 / 报错后刷新」这类**有清理机会**的崩溃。`visibilitychange→hidden`（切后台/弹键盘/切 App）也抢发队列，但**不**标 `cleanExit`（见下②的修正）。**不用 `navigator.sendBeacon`**：见下「传输」的 CORS 说明。
  - ② **localStorage 会话哨兵**：真·硬崩溃（OOM / 渲染进程被杀 / 标签页被杀）当场无机会上报；改为启动写 `nw_session_sentinel` + 15s 心跳更新存活时刻、离场标记 `cleanExit`；**下次启动**若发现上次哨兵有标记却无 `cleanExit`，即判定崩溃，带「大约崩溃时刻 aliveMs + 最后一条错误」补报一条 `crash`。补报后**立即 `flushBeacon`**（不等 1.5s 合批 fetch），以防本次会话在 debounce 触发前又崩。

> **2026-06-27 两处健壮性修正**（修「iPad 注册崩溃 Grafana 无记录」时发现）：
> - **`cleanExit` 误判**：原 `visibilitychange→hidden` 也调 `markCleanExit()`，但 hidden（切后台/弹软键盘/切 App）≠ 退出——iOS 恰在转后台时最易被内存压力杀标签页，于是「后台被杀」会被下次启动误判成正常退出、永不补报。已拆开：只有 `pagehide`（确凿卸载）标 `cleanExit`；`hidden` 只抢发不标。
> - **补报卡 1.5s 合批**：崩溃常成串（重载后又崩），原补报走普通队列 1.5s 后才 fetch，若本次也在 1.5s 内崩则永远发不出。已改为补报后立即 beacon。
- **传输**：客户端 `POST /client/anomaly`（body `{ publicId?, platform, events:[{type,msg,ts,detail?}] }`）；合批与离场急发一律走**无凭据 `fetch`（`keepalive:true, credentials:'omit'`）**。无 baseUrl / Loki 不可达 → 静默丢弃，绝不影响玩家。
  - **为何弃用 `navigator.sendBeacon`**（2026-07-01 修）：sendBeacon 强制带凭据（cookie），浏览器遂要求跨域响应含 `Access-Control-Allow-Credentials: true`。本 API 用 Bearer token 认证、不下发任何 cookie，metaserver CORS 是 `origin:true` 反射来源但**不**带 ACAC——于是跨域（`api.gamestao.com` ≠ 游戏来源）的信标被浏览器直接拦截，崩溃/离场补报永远发不出（现象即 `/client/anomaly` 报 CORS 错）。改用无凭据 keepalive fetch：同样存活于页面卸载（fetch 规范），跨域默认不带 cookie，`credentials:'omit'` 明示意图。埋点本就无需认证（`publicId` 在 body 里）。服务端 CORS 一字未改，不引入任何新增攻击面。
- **入 Loki 约定**：单 stream，**label 仅 `{source="client", kind="anomaly"}`**（低基数），`type/publicId/platform/detail/msg` 一律放**行内**（logfmt）。Grafana：`{source="client",kind="anomaly"} | logfmt | type="webgl_lost"`。
- **Grafana 面板**：`observability/grafana/dashboards/client-anomaly.json`（uid `nw-client-anomaly`）——按 type 堆叠的事件速率 + crash 计数 + 事件总数 + 受影响玩家数 + 明细日志；模板变量 type/platform（custom 枚举，因 type 在行内非 label）/publicId/关键字。
- **防滥用四闸**：① 客户端每类冷却（mem/cpu 60s、anr 30s、jserror 10s 合一）② 单会话总量上限 50 ③ 单条 detail 截断 800 字符 ④ 服务端**按 IP 60s/30 次限流**（`SlidingRateLimiter`，超限静默丢弃）+ 最多取前 200 条 + 各字段截断。`POST /client/anomaly` **永远回 200**。
- **与定向采集的关系**：`mem` 同时仍走 §9.4（被定向玩家可在 Loki 看到带完整池占用上下文的 warn 行）；本通道是「全网粗粒度异常计数 + 崩溃发现」，两者不冲突。
- **测试覆盖（全链路）**：服务端那半条（handler 校验/IP 限流/anon 兜底/转发）在 `server/metaserver/test/clientLog.test.ts`；客户端那半条 + 全链路接缝在 `client/test/anomaly-chain.test.ts`——驱动 `AnomalyReporter`/崩溃哨兵/离场 beacon 发出真实 POST body，再把该 body 喂进服务端真实的 `buildAnomalyLokiPayload` 断言最终 Loki 行；含两处 bug 的回归用例（hidden 不标 cleanExit、补报立即 beacon）。
- **⚠ 部署前置（2026-06-27 踩坑根因）**：本通道（及 §9.4 定向采集）入 Loki 全靠 metaserver 的 `NW_LOKI_PUSH_URL`。**生产此前为空** → 所有 anomaly 静默丢弃 → Grafana 永远空（与客户端是否上报无关）。已修：obs 栈的 loki 经 `observability/docker-compose.obs.yml` 接入主栈网络 `server_default`（别名 `nw-loki`），`docker-compose.prod/cloud.yml` 的 `NW_LOKI_PUSH_URL` 默认值改为 `http://nw-loki:3100/loki/api/v1/push`（详见 `observability/README.md` 网络坑）。**排查链路第一步永远是先确认这个 env 非空**：`docker exec server-metaserver-1 printenv NW_LOKI_PUSH_URL`。

---

## 8. 实现记录

### 2026-06-24 · F1 核心 + 首条 flag `match_bot_fallback` 端到端

**F1 核心（@nw/shared）** — `server/shared/src/featureFlags.ts`：
- `FEATURE_FLAGS` 白名单（首条 `match_bot_fallback`）+ `FlagKey` 类型 + `flagDefault`/`isFlagKey`/`FLAG_KEYS`。
- `evaluateFlag(key, doc, ctx)` 严格按 §3 六条短路；FNV-1a 32-bit (`fnv1a`/`rolloutBucket`) 稳定分桶。
- `sanitizeFlagDoc`（容错规整脏规则）+ `FeatureFlagCache`（轮询取数 + 30s 刷新 + 本地求值 + admin 不可达吃旧缓存/冷启动 default 兜底 + 可注入 region）。
- 单测 `server/shared/test/featureFlags.test.ts`（16 例，覆盖六条顺序 + hash 稳定 + 缓存降级）。

**F2 后台（admin + tools/ops）**：
- 能力点 `config.manage`（`shared/admin.ts`，授予 super/ops）+ 审计动作 `config.update`。
- admin 库 `featureFlags` 集合（`admin/db.ts`，`_id`=key，索引 `updatedAt:-1`）。
- `AdminService.getConfigFlags`/`getInternalFlags`/`upsertFlag`（校验 + before/after 审计）。
- httpApi：`GET/PUT /admin/config/flags`（admin JWT + config.manage）+ **内部端点 `GET /admin/internal/flags`**（X-Internal-Key，出原始规则，不求值）。
- tools/ops 新增「功能开关」菜单页（总闸 toggle + pct/regions/platforms/白黑名单编辑 + 最近修改人/时间）。

**F4 服务端读取 + 首条 flag 闭环（matchsvc）**：
- matchsvc 轮询 admin 内部端点构建 `FeatureFlagCache`（env `NW_ADMIN_INTERNAL_URL`/`NW_REGION`）。
- `Matchmaking` 加入队等待超时扫描（`botFallbackMs`，对单人独自在队亦生效）。**非 fire-once**：开关关「继续等」时条目仍在队，每隔 `botFallbackMs` 重评一次（`lastTimeoutAt` 节流），保证运营把开关「后开」也能覆盖已在排队的老条目（旧 fire-once 会把首判时关着的条目永久钉死成「等真人」→ 后开开关漏判）。
- `Matchsvc.onQueueTimeout`：求值 `match_bot_fallback`（ctx=accountId/platform/region）→ 开启则出队并推 `match_bot`（seed/opponentName/elo/difficulty），关闭则继续等真人。env `NW_MM_BOT_FALLBACK_MS`（默认 30000）。
- 单测：`matchmaking.test.ts`（超时触发 / 仍在队周期性重评 / 关闭 / platform 透传）+ `matchsvc.test.ts`（flag 开→推 match_bot 出队；关→留队；**后开→下一次重评即降级**）。
- ⚠ **部署必坑（2026-06-24 修）**：matchsvc 容器**必须**注入 `NW_ADMIN_INTERNAL_URL`（指向 `http://admin:8083`），否则 `flags.start()` 不启动 → 开关轮询禁用 → `match_bot_fallback` 恒为默认 false → **后台无论怎么开都永不降级打 AI**。`docker-compose.cloud.yml` / `docker-compose.prod.yml` 的 matchsvc 段此前漏配，已补（连同 `NW_REGION` / `NW_MM_BOT_FALLBACK_MS`）。判定是否生效看 matchsvc 启动日志：`feature flags: poll http://admin:8083 ...` 为正常，`disabled (all default)` 即漏配。

**客户端本地 AI 局（决策层 + 客户端本地 AI，按拍板）**：
- 契约：`transport.proto` 新增 `MatchBot{seed,opponent_name,elo,difficulty}`（ServerMsg oneof #24）；gateway `matchsvcClient`/`Gateway.toServerMsg`/`proto.encodeServer` 透传；客户端 `proto:gen` 重生成。
- 客户端：`NetSession.onMatchBot` 路由 → `createAppCore` ranked 处理器收到即退排队、`goGame({seed,fromBotFallback})` 开本地 PvP-vs-AI 局（`matchEngine`/`GameScene` 透传 `seed` 保持确定性）。analytics 标记 `pvp_bot_fallback`。

> 状态：F1/F2/F4 + 首条 flag 端到端已落地并通过 tsc + 单测（server 全 workspace typecheck 通过；shared/matchsvc/gateway 单测 58 例通过；client/ops tsc 通过）。

### 2026-06-24 · 客户端日志定向采集（§9）+ F3 公开 bootstrap 闭环

按 §9.6 步骤 1–6 全部落地（核心闭环 1–4 端到端可验证，5/6 收尾）：

**① `@nw/shared`（`featureFlags.ts`）**：
- `FlagRollout` 加 `allowPublicIds?`；`FlagContext` 加 `publicId?`；`evaluateFlag` 在 allowAccounts 同优先级加「allowPublicIds 命中即开」；`sanitizeFlagDoc` 解析该字段。
- 登记 4 个分级 flag `client_log_error/warn/info/debug`（default 全 false，side client）。
- 单测扩到 19 例（新增 allowPublicIds 命中/解耦/总闸·deny 盖过 + sanitize 容错）。
- **排他定向必坑见 §9.1**：单玩家定向 = `pct:0` + `allowPublicIds:[目标]`（只填 allowPublicIds 会对全员开）。

**② metaserver**：
- 接 `FeatureFlagCache`（轮询 admin 内部端点，env `NW_ADMIN_INTERNAL_URL`/`NW_REGION`，同 matchsvc）。
- 公开 `GET /bootstrap?platform=&publicId=`（`operationId: bootstrap`，匿名可调；带 token 则解析 accountId）：对全量白名单逐个求值，**只回 `resolved !== default` 的 flag**（多数玩家空 map）。规则/白名单绝不下发。
- `POST /client/log`（`operationId: clientLog`）：**永远回 200**。防滥用 = 仅当 publicId 当前被某 `client_log_*` 的 `allowPublicIds` 点名才转发，否则静默丢弃（`accepted:0`）。转发用 `clientLog.ts` 组装 Loki push payload（按 level 分流，label 仅 `{source=client, level}`，publicId/tag/msg 入行内 logfmt，ts→ns）。env `NW_LOKI_PUSH_URL`，不可达静默丢弃。
- 单测 `test/clientLog.test.ts`（7 例：payload 组装 + bootstrap 只回 diff + clientLog 定向守卫/转发/400）。

**③ 客户端**：
- `net/log.ts`：加内存环形缓冲（容量 200，单调 seq）。`netLog` 每条 emit 同时入缓冲（与 console 开关无关——console 关着也能远程捞）；全局未捕获错误/Promise 拒绝亦入缓冲。`snapshotClientLogs(thresholdRank, afterSeq)` 取 ≥阈值且新于 afterSeq 的条目。
- `net/featureFlags.ts`：`FeatureFlags` 启动拉一次 + 每 120s 轮询 `/bootstrap`；解析 `client_log_*` 推上传阈值（debug>info>warn>error 取最 verbose 的已开）；命中后每 30s 把缓冲 ≥阈值新条目批量 `POST /client/log`（无 publicId 不上报）。
- `createAppCore`：构造并 `start()`（有 API 基址时）；登录/存档回包拿到 publicId 后 `refresh()` 即时生效。
- `ApiClient` 加 `getBootstrap` / `postClientLog`。单测 `test/feature-flags.test.ts`（5 例：缓冲过滤 + 未命中不报 + 命中周期上报带 publicId + 无 publicId 不报）。

**④ contracts/openapi.yml**：补 `/bootstrap`（GET，公开）+ `/client/log`（POST，公开）+ `config` tag；客户端 `rest:gen` 重生成类型。

**⑤ tools/ops**：「功能开关」编辑卡加 `allowPublicIds` 输入框（与 allow/deny 并列）；对 `client_log_*` flag 显式提示「pct=0 + 仅填 allowPublicIds」配法 + Grafana 查询串。admin `validateRollout`/`describeFlag` 同步认 `allowPublicIds`。

**⑥ Grafana**：新增仪表盘 `observability/grafana/dashboards/client-logs.json`（publicId 文本框 + level 过滤 + 速率/错误数/上报玩家数 + 日志面板，查询 `{source="client"} | logfmt | publicId=~"$publicId.*"`）。

- ⚠ **部署必坑（同 matchsvc）**：metaserver 容器**必须**注入 `NW_ADMIN_INTERNAL_URL`（→`http://admin:8083`），否则 flag 轮询禁用 → `/bootstrap` 恒空 map → 定向采集永不生效。另需 `NW_LOKI_PUSH_URL` 指向 metaserver 可达的 Loki（obs 栈独立网络，见 `observability/README.md` 网络坑）——留空则接受但静默丢弃。两 compose（cloud/prod）的 metaserver 段已补这三个 env。
- 验证：server 全 workspace typecheck 通过；metaserver 158 例 + shared 19 例 + matchsvc/gateway 单测通过；client tsc + webpack + 5 例 flag 单测通过；ops/admin tsc + ops build 通过。

> F3 通道既已建起，后续客户端侧 flag（maintenance_mode kill switch / 新 UI 灰度）可直接复用 `FeatureFlags.isOn(key)`。

### 2026-06-24 · 客户端异常事件「全量」上报通道（§9.7）

「内存超标自动上报」之上扩出**全网异常监测**：新增 CPU/主线程饱和、WebGL 丢失、卡死、未捕获异常、上次崩溃五类信号，全量直报 Loki（不受定向白名单约束），用于定位野外客户端异常。

**客户端**：
- `net/anomaly.ts`（新）：`AnomalyReporter` 单例（冷却 + 会话上限 + detail 截断 + 合批 fetch + 离场无凭据 keepalive fetch）；`reportAnomaly()` 统一入口；崩溃哨兵 `initCrashSentinel()`（启动检测上次异常退出并补报 + 心跳）+ `installAnomalyWatchers()`（错误旁路 / 离场急发 / `webglcontextlost` / ANR 看门狗 / `wx.onError`）。
- `cache/PerfMonitor.ts`（新）：挂 `app.ticker`，长任务忙碌比（`PerformanceObserver('longtask')`，Chromium）+ 持续低 FPS（处处可用）两路，越线报 `cpu`。阈值 localStorage 可调（`nw_fps_warn`/`nw_cpu_busy_warn`）。
- `cache/MemoryMonitor.ts`：`dump()` 在原 `netLog('mem').warn` 之外**并行** `reportAnomaly('mem', ...)`（全网内存超标计数）。
- `net/log.ts`：加 `recentClientLogs(n)`（崩溃面包屑 / 哨兵记最后错误）+ `setErrorSink`（未捕获异常旁路 → `jserror`，反向注入避免与 anomaly 成环）。
- `app.ts`：`new PerfMonitor().install(app.ticker)` + `initCrashSentinel()` + `installAnomalyWatchers({ canvas: app.view })`。

**metaserver**：
- `clientLog.ts`：加 `ClientAnomalyEvent` + `buildAnomalyLokiPayload`（单 stream，label `{source=client, kind=anomaly}`，type/publicId/platform/detail/msg 入行内 logfmt）。
- `service.ts`：`clientAnomaly`（`operationId`，**不受 allowPublicIds 约束**；按 IP 60s/30 次 `SlidingRateLimiter` 限流，超限静默 `accepted:0`；缺 publicId 记 `anon`；最多 200 条 + 各字段截断）。**永远回 200**。
- `contracts/openapi.yml`：补 `POST /client/anomaly`（公开，`config` tag）。
- 单测 `test/clientLog.test.ts` +6 例（payload 组装 + 未知 type→other + 全量转发不受定向约束 + anon + 400 + IP 限流）；route 装配经 `app.inject` 冒烟通过。

**验证**：metaserver `tsc --noEmit` + client `tsc` + webpack web build 全通过；clientLog 13 例通过。

**Grafana**：已加「客户端异常（全量上报）」面板 `observability/grafana/dashboards/client-anomaly.json`（uid `nw-client-anomaly`，folder-provisioned 自动加载）——按 type 堆叠速率 + crash 计数 + 事件总数 + 受影响玩家数 + 明细日志，模板变量 type/platform/publicId/关键字。

### 2026-06-27 · `mem` 上报补 PIXI 级泄漏定性计数（§9.7 mem）

**动机**：野外一台 web（publicId 233784986）堆从 ~1GB 4 分钟涨到 4012MB（贴 4192 上限）+ 伴 43/46/52s 真·可见卡死（ANR 看门狗 `!hidden` 才报，排除后台节流）。但 `poolTotal.estMB=0` → 不是战斗对象池，是纯 JS 保留型泄漏；原 `dump()` 只有「堆大 + 池空」，无法定位是哪一类。

**改动**（`client/src/cache/MemoryMonitor.ts` + `app.ts`）：
- `install(ticker, stage?)` 多收一个 `stage`（`app.ts` 传 `app.stage`——场景 `gameLayer` 在其下，计数是超集）。
- `dump()` 新增 `gpu:{tex,baseTex,nodes,tickers}`：`PIXI.utils.TextureCache`/`BaseTextureCache` 条目数、`app.stage` 下显示对象总数（栈式遍历，封顶 `200000`，到顶记 `"200000+"`）、`ticker.count` 监听器数。同时进 `log.warn` 与 `reportAnomaly('mem',...)` 的 detail（detail 仍 ≤800 截断内）。
- 仅告警时（mem 60s 冷却）跑一次，遍历封顶——不会让正在发生的卡死更重。
- 下次复现据三数定性：`tex/baseTex` 增=纹理缓存无界、`nodes` 增=退场不 destroy 的场景图残留、`tickers` 增=`ticker.add` 漏 `remove` 的闭包钉死，定位后再做退场审计。

**验证**：client `tsc --noEmit` 通过。
