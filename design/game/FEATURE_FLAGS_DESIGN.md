# Feature Flags — 功能开关系统设计基准

> 状态：已上线（F1/F2/F4 + 首条 flag `match_bot_fallback` 端到端，见 §8）· F3（公开 `GET /bootstrap` + 客户端 `FeatureFlags.isOn`）**有意延后**，待出现客户端侧 flag（如 maintenance_mode kill switch / UI 灰度）时再做 · 权威：本文（feature flag 机制）· 接口契约 → [SERVER_API.md](SERVER_API.md) + `server/contracts/openapi.yml` · 更新：2026-06-24

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
- `Matchmaking` 加入队等待超时扫描（`botFallbackMs`，对单人独自在队亦生效，fire-once）。
- `Matchsvc.onQueueTimeout`：求值 `match_bot_fallback`（ctx=accountId/platform/region）→ 开启则出队并推 `match_bot`（seed/opponentName/elo/difficulty），关闭则继续等真人。env `NW_MM_BOT_FALLBACK_MS`（默认 30000）。
- 单测：`matchmaking.test.ts`（超时 fire-once / 关闭 / platform 透传）+ `matchsvc.test.ts`（flag 开→推 match_bot 出队；关→留队）。

**客户端本地 AI 局（决策层 + 客户端本地 AI，按拍板）**：
- 契约：`transport.proto` 新增 `MatchBot{seed,opponent_name,elo,difficulty}`（ServerMsg oneof #24）；gateway `matchsvcClient`/`Gateway.toServerMsg`/`proto.encodeServer` 透传；客户端 `proto:gen` 重生成。
- 客户端：`NetSession.onMatchBot` 路由 → `createAppCore` ranked 处理器收到即退排队、`goGame({seed,fromBotFallback})` 开本地 PvP-vs-AI 局（`matchEngine`/`GameScene` 透传 `seed` 保持确定性）。analytics 标记 `pvp_bot_fallback`。

> 状态：F1/F2/F4 + 首条 flag 端到端已落地并通过 tsc + 单测（server 全 workspace typecheck 通过；shared/matchsvc/gateway 单测 58 例通过；client/ops tsc 通过）。**F3（公开 `GET /bootstrap` + 客户端 `FeatureFlags.isOn`）尚未实现** —— 客户端侧 flag 下发（如 maintenance_mode kill switch、新 UI 灰度）留后续；首条 flag 仅服务端读取，无需 bootstrap。
