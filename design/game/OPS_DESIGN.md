# Notebook Wars — 运维后台（Ops / Admin）设计文档

> 创建：2026-06-16。本文件是运维后台（在线监控 / 匹配池 / 数据分析 / 玩家补偿）的设计基准。
> 配套阅读：`META_DESIGN.md`（系统/架构、信任边界）、`GATEWAY_DESIGN.md`（控制面 + presence）、`MATCHSVC_DESIGN.md`（匹配队列/房间）、`COMMERCIAL_DESIGN.md`（补偿附件领奖复用其发货幂等）、`SOCIAL_DESIGN.md §3.3/§5.3`（邮件模型 + 系统邮件端点，补偿的投递载体）、`META_TASKS.md`（任务进度）。
> 拍板（2026-06-16，用户）：① 明确角色管理，角色只能执行本角色权限；② 数据由工具整合，服务端开端口但需权限校验；③ 工具自存日志 + 做数据分析；④ **所有奖励（单人/全服）一律走邮件**；⑤ **独立进程**；⑥ 需查看页面；⑦ 后端进 `server/admin`、前端页面进 `tools/`；⑧ 补偿走**审批工单流**（见 §3）；⑨ admin **独立账号库 + 预设角色**；⑩ 数据分析 = **自采快照 + 只读 API**（不直连业务库）。

---

## 0. TL;DR

- 运维后台 = **面向运营/客服/超管的内部管理端**，与玩家世界严格隔离。不暴露公网。
- **形态**：后端 `server/admin`（第六个 workspace，CJS，复用 `@nw/shared`，**独立 Mongo 库** `notebook_wars_admin`）+ 前端页面 `tools/ops`（纯前端，fetch 调 admin 后端）。
- **两层鉴权**（不可混）：① 运维**用户** → admin 后端：独立账号 + 登录会话 + RBAC（预设角色）。② admin 后端 → 业务服务（meta/commercial/gateway/matchsvc）：持 `X-Internal-Key` 作内部特权调用方。
- **三类能力分级**：只读监控（低危）/ 数据分析（中）/ 补偿发奖（高危，走审批工单流）。
- **补偿一律走邮件**：admin **从不直接写钱包**；它创建系统邮件（调 meta 的系统邮件端点），钱在**玩家领取邮件**时才经 commercial/inventory 入账（幂等）。补偿的真实投递子系统 = `SOCIAL_DESIGN.md` 的邮件（并行开发，admin 侧先留口子）。
- **审批工单流**：补偿不是"点了就发"，而是 `发起 → 审批 → 执行` 三态工单，**发起人 ≠ 审批人**；额度/范围决定审批级别（见 §3.2）。
- **数据来源**：实时态（在线/匹配池）从 gateway/matchsvc 新增的 `GET /internal/stats` 拉取；趋势分析靠 admin **自采快照**存自己的时序集合。不直连业务库。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| OPS1 | 后端独立进程 `server/admin`（CJS，`@nw/shared`），**独立库** `notebook_wars_admin`（admin 账号/角色/审计/工单/快照），玩家不可达 | 与 commercial/matchsvc 一致的"按信任边界拆进程"；运维数据与玩家数据物理隔离，事故面收敛 |
| OPS2 | 前端页面进 `tools/ops`（纯前端，与 animator/level-editor 同目录），通过 admin 后端 API 取数 | 用户拍板放 `tools/`；页面是纯前端、不持密钥不连库，与现有 tools 形态一致；后端单独在 server/ 才符合其有状态本质 |
| OPS3 | **两层鉴权分离**：运维用户登录（RBAC）≠ 服务间 `X-Internal-Key` | 前者管"谁能在后台做什么"，后者管"admin 进程能调哪些内部端点"。混用会让一个泄露的内部密钥等于全后台权限 |
| OPS4 | **独立 admin 账号库 + 预设角色**（超管/运营/客服/只读），角色→能力矩阵写死在代码（枚举） | 运维身份绝不复用玩家账号；预设角色实现轻、够用，运行时自定义角色后置 |
| OPS5 | **所有奖励走邮件**，admin 只创建系统邮件、不碰钱包 | 离线玩家可领、每人领取幂等、有审计痕迹、复用 commercial 发货幂等；与 `SOCIAL_DESIGN` 邮件统一，不造第二条发奖路径 |
| OPS6 | **补偿 = 审批工单流**（pending→approved→executed/rejected），发起人≠审批人 | 高危写操作必须有复核与留痕；单人/全服、额度内/超额走不同审批级别（§3.2） |
| OPS7 | 数据分析 = **自采快照 + 只读 API**，不直连 meta/commercial 的 Mongo | 守住"经服务、不重复 schema"纪律；admin 定期采样存自己的时序集合做趋势 |
| OPS8 | 实时态（在线人数/匹配池）= gateway/matchsvc **新增 `GET /internal/stats`** 拉取聚合 | 在线/队列是内存瞬时态，只有 gateway（presence）和 matchsvc（队列/房间）知道；meta 无状态不知情 |
| OPS9 | admin 后端**只对内**：不接收业务服务的回调（它是调用方）；唯一对外是给运维前端的 API 端口（带 admin 会话鉴权） | 缩小暴露面；admin 不进 `/gw/push` 等内部回推链路 |
| OPS10 | 每一次写操作（建工单/审批/执行/账号变更/登录）落 **审计日志**；超管看全部、其他人看自己 | 合规与追责；审计可见性按角色拆（§2.3） |

---

## 2. 账号、角色与权限（RBAC）

### 2.1 admin 账号（独立库 `notebook_wars_admin`）

```ts
interface AdminAccountDoc {
  _id: string;            // uuid
  username: string;       // 登录名（唯一）
  passwordHash: string;   // 复用 shared/password（bcrypt/scrypt，同玩家口令策略或更强）
  role: AdminRole;        // 'super' | 'ops' | 'support' | 'viewer'
  displayName: string;
  disabled: boolean;
  createdAt: number;
  createdBy?: string;     // 创建者 adminId（超管）
  lastLoginAt?: number;
}
// index: { username: 1 } unique
```

- 登录签发 **admin 专用 JWT**（独立 secret `NW_ADMIN_JWT_SECRET`，与玩家 `NW_JWT_SECRET` 隔离），短时效 + 前端会话续期。
- 首个超管由**部署期种子脚本/环境变量**注入（`NW_ADMIN_SEED_USER` / `NW_ADMIN_SEED_PASS`），之后超管在后台增删账号。

### 2.2 预设角色 → 能力矩阵

能力点（atomic capability，写死枚举）：

| 能力 | 超管 super | 运营 ops | 客服 support | 只读 viewer |
|---|:--:|:--:|:--:|:--:|
| `monitor.view` 在线/匹配池/趋势 | ✓ | ✓ | ✓ | ✓ |
| `analytics.view` 数据分析 | ✓ | ✓ | – | ✓ |
| `player.lookup` 查玩家档案 | ✓ | ✓ | ✓ | – |
| `comp.initiate.single` 发起个人补偿 | ✓ | ✓ | ✓ | – |
| `comp.initiate.global` 发起全服补偿 | ✓ | ✓ | – | – |
| `comp.approve.single` 审批个人补偿（额度内） | ✓ | ✓ | – | – |
| `comp.approve.single.overquota` 审批超额个人补偿 | ✓ | – | – | – |
| `comp.approve.global` 审批全服补偿 | ✓ | – | – | – |
| `comp.view` 查看工单/已发邮件 | ✓ | ✓ | ✓ | ✓ |
| `audit.view.all` 看全部审计 | ✓ | – | – | – |
| `audit.view.self` 看自己操作（登录即有） | ✓ | ✓ | ✓ | ✓ |
| `admin.manage` 账号/角色管理 | ✓ | – | – | – |

> 角色→能力映射是后端**单一真相**（`shared/admin.ts` 或 admin 内 `roles.ts`）；前端按返回的能力集渲染可见按钮，但**真正的权限校验在后端每个端点**（前端隐藏只是体验，不是安全边界）。

### 2.3 审计可见性

- 超管：`audit.view.all` → 查全部人的操作。
- 运营/客服/只读：`audit.view.self` → 只查自己的操作记录。

---

## 3. 补偿审批工单流（核心）

### 3.1 工单实体

```ts
interface CompensationTicketDoc {
  _id: string;                 // uuid
  scope: 'single' | 'global';
  // 目标：single → 一个 publicId；global → 目标过滤器
  target: { publicId: string } | { filter: GlobalFilter };
  mail: {                      // 要发的邮件内容（领取时才入账）
    subject: string;
    body: string;
    attachments: MailAttachment[];   // 复用 SOCIAL_DESIGN 的 MailAttachment（coins/item/skin）
    expireDays: number;
  };
  reason: string;              // 补偿事由（审计用，必填）
  status: 'pending' | 'approved' | 'executed' | 'rejected' | 'cancelled' | 'failed';
  amountTier: 'normal' | 'overquota';   // 个人补偿据额度判定（§3.3）；global 恒走超管审批
  initiatedBy: string;         // adminId
  initiatedAt: number;
  approvedBy?: string;         // adminId（必须 ≠ initiatedBy）
  approvedAt?: number;
  executedAt?: number;
  // 执行结果：admin 调 meta 系统邮件端点的幂等键 + 命中人数
  dispatchKey: string;         // 幂等键（防重复执行）
  recipientCount?: number;     // global 执行后回填
  error?: string;
}
// index: { status: 1, initiatedAt: -1 }, { initiatedBy: 1 }, { dispatchKey: 1 } unique
```

### 3.2 审批路由（发起 → 审批授权）

> 原则：**发起人 ≠ 审批人**（同一人不能审批自己发起的工单）。

| 工单类型 | 谁可发起 | 谁可审批 |
|---|---|---|
| 个人补偿（额度内） | 客服 / 运营 / 超管 | 运营 / 超管 |
| 个人补偿（**超额**） | 客服 / 运营 / 超管 | **超管** |
| 全服补偿 | 运营 / 超管 | **超管** |

- **额度阈值** `SINGLE_COMP_QUOTA`（放 `shared/admin.ts` 单一真相）：单张工单附件总价值（金币当量）≤ 阈值 = `normal`，超过 = `overquota`。阈值与"金币当量"换算表后续在 `ECONOMY_BALANCE.md` 定。
- 工单创建时后端据附件计算 `amountTier`，决定所需审批能力（`comp.approve.single` vs `comp.approve.single.overquota`）。
- 全服补偿 `amountTier` 无论金额恒等于需 `comp.approve.global`（超管）。

### 3.3 生命周期

```
发起人（有 comp.initiate.*）            创建工单 → status=pending（落审计）
审批人（有对应 comp.approve.*，≠发起人） approve → status=approved（落审计）
                                       reject  → status=rejected
admin 执行器（approved 后，可自动或手动触发）
  → 调 meta 系统邮件端点（带 dispatchKey 幂等）
  → 成功 status=executed（回填 recipientCount）/ 失败 status=failed（可重试）
发起人/超管 可在 pending 阶段 cancel
```

- **执行 ≠ 入账**：执行只是把邮件投到玩家邮箱；玩家点"领取"时邮件附件才经 commercial（金币）/ meta inventory（物品/皮肤）真正发放，`deliveredOrders`/`claimOrderId` 幂等（见 `SOCIAL_DESIGN §3.3`）。
- **全服补偿安全阀**：
  - 发起时 **dry-run 预览命中人数**（admin 调 meta `/internal/mail/system/preview` 估算）。
  - `dispatchKey` 唯一索引防手抖重复执行。
  - 大范围发送写一条广播工单，meta 侧按"广播 + 每人领取记录"模型 fan-out（一期 SOCIAL_DESIGN 是每人一份文档，量大后迁模板，见 SOC5）。

---

## 4. 数据来源与端点契约

### 4.1 admin 调用的业务侧端点（需新增/约定，`X-Internal-Key`）

| 端点 | 提供方 | 用途 | 状态 |
|---|---|---|---|
| `GET /internal/stats` | **gateway**（新增） | 在线连接数、presence 概览（按区/版本可选） | 待加 |
| `GET /internal/stats` | **matchsvc**（新增） | 匹配队列长度/等待分布、房间数按 phase、game 实例负载 | 待加 |
| `GET /internal/profile` | meta（已存在） | 查玩家昵称/publicId（player.lookup） | ✅ |
| `GET /save`（内部查档变体，按需） | meta | 玩家档案/进度/钱包镜像（只读，player.lookup） | 待定（可加 `GET /internal/player/{publicId}`） |
| `POST /internal/mail/system/send` | **meta**（SOCIAL_DESIGN S6-3 留口） | 执行补偿 = 创建系统邮件（单人/批量，幂等键） | **邮件后端并行做，先留口子** |
| `POST /internal/mail/system/preview` | meta | 全服补偿 dry-run 估算命中人数 | 同上 |

> 邮件相关端点由 `SOCIAL_DESIGN` 的 S6-3 落地；admin 侧先按上述契约形状对接，邮件后端完成后联调（用户：「邮件系统已经在做，做完告诉你」）。

### 4.2 admin 自有端点（给运维前端，admin 会话鉴权）

```
# 认证
POST /admin/login        { username, password }     → { token, role, capabilities[] }
POST /admin/logout
GET  /admin/me                                       → { admin, capabilities[] }

# 监控（monitor.view）
GET  /admin/monitor/live                             → { online, queue, rooms, gameInstances }
GET  /admin/monitor/trend?metric=&from=&to=          → { points: [{ ts, value }] }   // 自采快照

# 数据分析（analytics.view）
GET  /admin/analytics/summary                        → { ... }                       // 自采指标聚合

# 玩家查询（player.lookup）
GET  /admin/player/{publicId}                        → { profile, ... }

# 补偿工单
POST /admin/comp/tickets       { scope, target, mail, reason }  → { ticketId }        // comp.initiate.*
GET  /admin/comp/tickets?status=                     → { tickets: [...] }             // comp.view
POST /admin/comp/tickets/{id}/approve                → { ok }                          // comp.approve.*（≠发起人）
POST /admin/comp/tickets/{id}/reject  { note }       → { ok }
POST /admin/comp/tickets/{id}/cancel                 → { ok }
POST /admin/comp/preview       { scope, target }     → { recipientCount }              // dry-run

# 审计
GET  /admin/audit?actor=&from=&to=                   → { entries: [...] }              // all=超管 / self=本人

# 账号管理（admin.manage，超管）
GET    /admin/accounts                               → { accounts: [...] }
POST   /admin/accounts         { username, password, role, displayName }
PATCH  /admin/accounts/{id}    { role?, disabled?, displayName? }
POST   /admin/accounts/{id}/reset-password { password }
```

### 4.3 admin 自有集合（`notebook_wars_admin`）

| 集合 | 内容 |
|---|---|
| `adminAccounts` | 运维账号（§2.1） |
| `compTickets` | 补偿工单（§3.1） |
| `auditLog` | 操作审计（actor/action/target/payload 摘要/ts/ip） |
| `metricSnapshots` | 自采时序（`{ metric, ts, value, dims? }`，TTL 保留窗口可配） |

---

## 5. 数据分析（自采快照）

- admin 起一个**采样定时器**（如每 30–60s），调 gateway/matchsvc `GET /internal/stats` + 可选 meta 概览，写 `metricSnapshots`。
- 趋势查询（`GET /admin/monitor/trend`）直接读 `metricSnapshots` 聚合，前端画折线。
- 指标示例：在线人数、匹配队列长度、平均匹配等待、活跃房间数、game 实例负载、（接入后）当日注册/补偿发送量。
- **不与 Grafana 冲突**：结构化日志（`NW_LOG_DIR` + Loki/Grafana）仍是后期全链路可观测的主力；admin 的自采快照是"运营自助看板"，轻量、随手即用、与权限体系绑定。

---

## 6. 安全

- **不暴露公网**：admin API 端口只在内网/VPN/IP allowlist 可达；反代不路由到它。
- **两层鉴权**：admin JWT（用户层）+ `X-Internal-Key`（服务层），secret 互相隔离。
- **每个端点后端强校验能力**：前端隐藏按钮不算数。
- **审计全覆盖**：登录、工单建/审/执/撤、账号变更全落 `auditLog`。
- **高价值目标加固**：admin 同时持内部密钥 + 对运维开端口，是攻击高地——口令策略从严、登录失败限流、会话短时效、敏感操作（全服补偿/账号管理）可选二次确认。
- **职责分离**：补偿发起人 ≠ 审批人；超管账号最小化。

---

## 7. 客户端/前端（`tools/ops`）

- 纯前端（TS + 轻量 DOM，参考 level-editor 的"纯 Canvas/DOM 不依赖 Pixi"路线；表单密集，无需 Pixi），webpack dev server 独立端口（如 9093）。
- 登录页 → 主框架按 `capabilities` 渲染导航：监控看板 / 数据分析 / 玩家查询 / 补偿工单 / 审计 / 账号管理。
- 调 admin 后端 REST（fetch + Bearer admin token）。
- 不持任何密钥、不连库、不直连业务服务——一切经 admin 后端。

---

## 8. 任务拆分（S7）

> 进度勾选随实现进 `META_TASKS.md`。补偿执行依赖 meta 系统邮件端点（S6-3，并行）。

| 任务 | 内容 | 依赖 |
|---|---|---|
| **S7-0 shared + 契约** | `shared/admin.ts`（`AdminRole`/能力枚举/角色→能力矩阵/`SINGLE_COMP_QUOTA`/工单与审计类型）；admin 库集合形状 | — |
| **S7-1 admin 后端骨架** | `server/admin` workspace：登录/JWT/RBAC 中间件 + 账号管理 + 审计写入 + 种子超管；`/health` | S7-0 |
| **S7-2 监控 + stats 端点** | gateway/matchsvc 加 `GET /internal/stats`；admin 采样定时器 + `metricSnapshots` + monitor/trend 端点 | S7-1 |
| **S7-3 补偿工单流** | 工单 CRUD + 审批路由（发起≠审批、额度分级）+ dry-run；执行器**先对接 meta 系统邮件端点的契约形状**（邮件后端就绪后联调） | S7-1、S6-3 |
| **S7-4 前端页面** | `tools/ops` 全部页面（登录/监控/分析/查询/工单/审计/账号） | S7-1~3 |
| **S7-5 数据分析** | 自采指标扩充 + 看板聚合（注册/补偿量/经济概览，按需经只读 API） | S7-2 |

### 新增环境变量（基线）

`NW_ADMIN_PORT`（前端 API 端口）/ `NW_ADMIN_JWT_SECRET` / `NW_ADMIN_MONGO_URI`（缺省复用 `NW_MONGO_URI`）/ `NW_ADMIN_MONGO_DB`（默认 `notebook_wars_admin`）/ `NW_ADMIN_SEED_USER` / `NW_ADMIN_SEED_PASS` / `NW_INTERNAL_KEY`（调业务内部端点）/ 各业务内部基址（`NW_META_BASE_URL` / `NW_GATEWAY_INTERNAL_URL` / `NW_MATCHSVC_INTERNAL_URL`）。

### 验证方式（沿本仓约定）

- 服务端：`tsc -b` 七包（含 admin）+ admin 端到端测试（登录/RBAC 拒绝、工单审批路由「发起≠审批」、超额走超管、dry-run、幂等执行、审计可见性）。
- 前端：`tsc --noEmit` + webpack 构建。
- 不截图（用户自行浏览器验证）。

---

## 9. 开放问题 / 待定

- 「金币当量」换算表（个人补偿额度判定用）——待 `ECONOMY_BALANCE.md` 补。
- 全服补偿目标过滤器 `GlobalFilter` 的维度（全员 / 版本 / 末次登录时间 / 账号列表）——执行时与邮件后端的 fan-out 能力对齐。
- 玩家档案查询深度（只昵称/段位，还是含进度/钱包/对战史）——按客服实际需要再定 `GET /internal/player`。
- 是否要"敏感操作二次确认/二次审批"的 TOTP——一期先口令+RBAC，后置。
