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
| `player.password_reset` 重置玩家密码（无联系方式时的支持工具，仅超管） | ✓ | – | – | – |
| `anticheat.view` 查反作弊审核队列（S9-7）+ C3 hash 不一致对局表 + C4 可疑 PvE 账号表 | ✓ | ✓ | – | – |
| `anticheat.action` 手动封禁/解封账号（S4-4，玩家查询详情页内联按钮） | ✓ | ✓ | – | – |
| `comp.initiate.single` 发起个人补偿 | ✓ | ✓ | ✓ | – |
| `comp.initiate.global` 发起全服补偿 | ✓ | ✓ | – | – |
| `comp.approve.single` 审批个人补偿（额度内） | ✓ | ✓ | – | – |
| `comp.approve.single.overquota` 审批超额个人补偿 | ✓ | – | – | – |
| `comp.approve.global` 审批全服补偿 | ✓ | – | – | – |
| `comp.view` 查看工单/已发邮件 | ✓ | ✓ | ✓ | ✓ |
| `slg.audit.view` 看拍卖异常扫描+审计队列（G7 反 RMT） | ✓ | ✓ | – | ✓ |
| `slg.audit.manage` 立/裁定异常交易审计工单（G7 反 RMT） | ✓ | ✓ | – | – |
| `slg.shop.manage` SLG 商城商品价格/效果覆盖（G7，§8/S8-8） | ✓ | ✓ | – | – |
| `reports.view` 查举报审核队列（`CONTENT_MODERATION_DESIGN.md` §5） | ✓ | ✓ | ✓ | ✓ |
| `reports.action` 裁定举报（dismiss/uphold，联动信誉分处罚） | ✓ | ✓ | – | – |
| `appeals.view` 查申诉队列 | ✓ | ✓ | ✓ | ✓ |
| `appeals.action` 裁定申诉（approve/deny，撤销 mute/ban） | ✓ | ✓ | – | – |
| `feedback.view` 查玩家反馈（无裁定；`SERVER_API.md §2.13`） | ✓ | ✓ | ✓ | ✓ |
| `feedback.action` 标已读 / 写 ops 备注（`SERVER_API.md §2.13.1`，仍非裁定） | ✓ | ✓ | – | – |
| `promo.manage` 兑换码发码 / 查码（B-PROMO，见 `META_TASKS.md`） | ✓ | ✓ | – | – |
| `moderation.wordlist.manage` 管理敏感词库外部覆盖表 | ✓ | ✓ | – | – |
| `audit.view.all` 看全部审计 | ✓ | – | – | – |
| `audit.view.self` 看自己操作（登录即有） | ✓ | ✓ | ✓ | ✓ |
| `events.manage` 限时活动创建/编辑/下线（B6，EVENTS_DESIGN §10） | ✓ | ✓ | – | – |
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
- **⚠ 单超管自批例外（临时）**：硬性「发起≠审批」在只有一个超管时会让全服/个人超额工单永久死锁（这两类只有 super 能批，而 super 不能批自己发起的单）。故 `approveTicket` 改为**条件四眼**：仅当存在「**除发起人外、未禁用、且具备该单所需 `comp.approve.*` 能力**的其他账号」时才强制他人审批；若无第二合格审批人，允许发起人自批，并在审计 `comp.approve` 的 `summary` 打 `[SELF-APPROVED:no-other-approver]` 专门留痕。**这是前期单超管的过渡方案**——招到第二名具备对应审批能力的运维后，删除 `service.ts` 中标记 `TODO(single-super-exception)` 的分支，恢复硬性「发起≠审批」即可（届时该例外自然失效，因为已存在第二合格审批人）。reject 不开此例外（发起人想撤回自己的单走 cancel）。
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
| `GET /internal/player?publicId=` \| `?accountId=` | meta | 玩家档案摘要（昵称/段位/ELO/胜负），player.lookup 详情 | ✅ |
| `GET /internal/players/search?q=&limit=` | meta | 玩家模糊搜：单关键词命中 publicId/accountId（精确）+ loginId（前缀）+ displayName（子串，不分大小写）；q<2 字符返空、limit 1..50、正则元字符转义防注入/ReDoS | ✅ |
| `POST /internal/accounts/{id}/reset-password` | meta | 管理员重置玩家密码（player.password_reset）：只改写已有 `password.hash`，账号没有密码凭证（匿名/微信登录）则 409；不创建新凭证 | ✅ |
| `POST /internal/anticheat/reviews/{id}/resolve` | meta | 人工裁定一条审核记录（`anticheat.action`）：只改 `status`/`resolution`/`resolvedBy`，本身不封号——`resolution:'banned'` 时 admin 侧另调 `/internal/accounts/{id}/ban`，全库只有一条封号执行路径（2026-07-18，取代 PvE reject 三振自动封号） | ✅ |
| `POST /internal/mail/system/send` | **meta**（SOCIAL_DESIGN S6-3） | 执行补偿 = 创建系统邮件（单人/批量，幂等键） | ✅ 已联调 |
| `POST /internal/mail/system/preview` | meta | 全服补偿 dry-run 估算命中人数 | ✅ 已联调 |
| `GET /internal/feedback?limit=` | meta（`SERVER_API.md §2.13`） | 玩家反馈列表（`feedback.view`），按 `createdAt` 倒序 | ✅ |
| `POST /internal/feedback/{id}/review` | meta（`SERVER_API.md §2.13.1`） | 标已读 / 写 ops 备注（`feedback.action`）：`readAt` 首次打戳后不再覆盖，`readBy`/`note` last-write-wins；仍无裁定语义 | ✅ |

> 邮件相关端点由 `SOCIAL_DESIGN` 的 S6-3 落地；admin 侧先按契约形状对接，**2026-06-16 跨进程实跑联调通过**（`server/admin/test/comp-mail.e2e.test.ts`：真实 `HttpMailDispatcher`/`HttpPlayerClient` 经 `fetch` 打真实 `app.listen` 的 meta 进程，跑通 单人补偿全链/`dispatchKey` 幂等/全服 fan-out+preview/player.lookup/错 key→401→工单 failed/收件人不存在→failed）。

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

# 玩家查询（player.lookup）——两段式：先模糊搜列表 → 点行拉详情
GET  /admin/players/search?q=                        → { players: [{accountId, publicId?, displayName?, loginId?}] }  // player.search 审计
GET  /admin/player/{publicId}                        → { player, ... }                 // 详情（按 9 位公开 id），player.banned 字段随详情返回
GET  /admin/player/account/{accountId}               → { player, ... }                 // 详情（按 accountId，模糊搜结果点击），同上
POST /admin/players/{accountId}/reset-password  { password }  → { ok }            // player.password_reset（仅超管，无联系方式支持工具）
POST /admin/accounts/{accountId}/ban                 → { ok }                          // anticheat.action（S4-4 手动封禁，详情页内联按钮，幂等）
POST /admin/accounts/{accountId}/unban               → { ok }                          // anticheat.action（S4-4 手动解封，同上；此前只有拍卖异常审计的自动封禁会调用这两个已有端点，玩家查询页从未接入，导致封禁状态不可见、无法手动解封）

# 反作弊审核队列（S9-7 PvP 超报 + 2026-07-18 PvE reject + 2026-07-26 金币异常 复用同一队列，详见 ACHIEVEMENT_DESIGN §S9-7 / COMMERCIAL_DESIGN §6.6）
GET  /admin/anticheat/reviews?accountId=&status=&limit=  → { reviews: [...] }          // anticheat.view，kind='pvp_overclaim'|'pve_reject'|'coin_anomaly'
POST /admin/anticheat/reviews/{id}/resolve  { accountId, resolution }  → { ok }        // anticheat.action：resolution='dismissed'|'banned'；banned 内部走上面同一条 ban 端点，全库仅此一条封号执行路径
> **金币异常（2026-07-26）**：`kind='coin_anomaly'` 由 metaserver 每 24h 一次的离线扫描产生（`coinAnomalyAudit.ts`），向 commercial 查询「昨天」这个 UTC 自然日里，哪些账号从非充值来源（`ledger.reason !== 'recharge'`）净入账超过 `COIN_ANOMALY_DAILY_THRESHOLD`（3000）金币，逐个写入本队列（`_id=coin:{accountId}:{dayKey}`，天然幂等，重复扫描不会重复入队）。不自动封号，`详情`列展示 `dayKey`/`nonRechargeGain`/`threshold`，人工判定后走上面同一条 dismiss/ban 流程。

# 反作弊两张只读信号表（C3/C4，anticheat.view）——无裁定半边，处置一律走上面那条手动 ban
GET  /admin/mismatches                               → { mismatches: [...] }           // 24h 内 `matches.hashMismatch=true`（双端 hash 分歧且裁判未能裁决）的对局，meta 侧封顶 200 行；`players` 原样带归档时的 displayName/publicId 快照
GET  /admin/suspicious-pve                           → { accounts: [...] }             // `accounts.flags.pveWarnings > 0` 的账号，按次数倒序封顶 200 行；该计数自 2026-07-18 起纯属审核信号（不再触发封号）

# 补偿工单
POST /admin/comp/tickets       { scope, target, mail, reason }  → { ticketId }        // comp.initiate.*
GET  /admin/comp/tickets?status=                     → { tickets: [...] }             // comp.view
POST /admin/comp/tickets/{id}/approve                → { ok }                          // comp.approve.*（≠发起人）
POST /admin/comp/tickets/{id}/reject  { note }       → { ok }
POST /admin/comp/tickets/{id}/cancel                 → { ok }
POST /admin/comp/preview       { scope, target }     → { recipientCount }              // comp.initiate.*（2026-08-04 修复：此前 dry-run 完全没有能力校验，任意已登录 admin 不论角色都能探测全服补偿覆盖人数；现在与 /admin/comp/tickets 发起同一 scope 要求相同能力）

# SLG 赛季运维（G7/§17.7；slg.season.view / slg.season.manage）
GET  /admin/slg/worlds                               → { worlds: [...] }               // slg.season.view
POST /admin/slg/season/open    { worldId, season, shard, capacity }  → { ok }          // slg.season.manage（高危，须确认）
POST /admin/slg/season/settle  { worldId }           → { ok, ranking }                 // slg.season.manage（发奖 + 结算）
POST /admin/slg/season/reset   { worldId }           → { ok }                          // slg.season.manage（高危，须先 settle）
POST /admin/slg/season/close   { worldId }           → { ok }                          // slg.season.manage（归档）

# SLG 拍卖异常交易审计（G7 反 RMT，SLG_DESIGN §17.13）
GET  /admin/slg/audit/anomalies?worldId=&windowSec=  → { anomalies: [...] }            // slg.audit.view（代理 worldsvc 扫描）
GET  /admin/slg/audit/tickets?status=                → { tickets: [...] }              // slg.audit.view
POST /admin/slg/audit/tickets   { snapshot }         → { ticket }                      // slg.audit.manage（立单，pairKey 去重）
POST /admin/slg/audit/tickets/{id}/resolve { disposition, note }  → { ticket }         // slg.audit.manage（dismissed|actioned）

# SLG 商城价格覆盖（G7/§8/S8-8；slg.shop.manage）——DB 覆盖优先，无记录时 fallback 到代码默认（SLG_SHOP_ITEMS）
GET  /admin/config/slg-shop                          → { items: [{ id, default, effective, doc }] }  // 9 件商品：3 加速/3 资源包/2 护盾/1 战令
PUT  /admin/config/slg-shop/{id}  { cost?, effect? } → { item }                        // 只传要改的字段；写 auditLog（slg.shop.price.update）
# 内部端点（X-Internal-Key，非 admin JWT）：worldsvc 不连 admin 库，轮询此端点拉原始覆盖记录，本地与 SLG_SHOP_ITEMS 合并
GET  /admin/internal/slg-shop-prices                 → { items: [...] }                // 原样返回，worldsvc 30s 轮询 + 本地 resolveSlgShopItem 合并

# 敏感词覆盖表（moderation.wordlist.manage；CONTENT_MODERATION_DESIGN.md §3.2）——DB 覆盖**叠加**在代码内置词表（REGION_WORDLISTS）之上，只增不减
GET    /admin/moderation/wordlists                   → { regions: [{ region, builtin, overlay, updatedAt?, updatedBy? }] }  // 四个 region 各自的内置底线 + DB 覆盖
POST   /admin/moderation/wordlists/{region}/words  { word }  → { doc }                 // 加词（幂等，落 auditLog moderation.wordlist.update）
DELETE /admin/moderation/wordlists/{region}/words/{word}     → { doc }                 // 删词（只删覆盖表条目，内置词表删不掉）
# 内部端点（X-Internal-Key，非 admin JWT）：meta/social/worldsvc 不连 admin 库，轮询此端点拉原始覆盖记录，本地与 REGION_WORDLISTS 合并
GET    /admin/internal/moderation-wordlists          → { items: [...] }                // 原样返回，WordlistCache 60s 轮询 + 本地 effectiveWordlist 叠加

# 兑换码（B-PROMO；promo.manage）——发码入口，玩家侧兑换走 metaserver `POST /promo/redeem`
GET  /admin/promo/codes                              → { codes: [...] }                // 列全部码；`_id`→`code` 在 admin client 侧改名（commercial 原样返回文档）
POST /admin/promo/codes  { code, coins, expiresAt?, totalLimit?, note? }
                                                     → { code }                        // 码 + coins 必填（否则 400），转发 meta→commercial；重复码 409；落审计 promo.create

# 玩家反馈（无裁定/无状态机，只有已读+备注痕迹；SERVER_API.md §2.13）
GET  /admin/feedback?limit=                          → { feedback: [...] }             // feedback.view，代理 meta GET /internal/feedback
POST /admin/feedback/{id}/review     { note? }       → { ok: true }                    // feedback.action，标已读 / 写备注；note 省略=只标已读（保留原备注），note:''=清空

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
| `tradeAuditTickets` | SLG 拍卖异常交易审计工单（G7 反 RMT，SLG_DESIGN §17.13）：冻结异常快照 + pairKey 去重 + open→dismissed/actioned 单人裁定 |
| `slgShopPrices` | SLG 商城商品价格/效果覆盖（G7/§8/S8-8）：`_id`=商品 id，仅存被 ops 覆盖过的商品；无记录 = 用代码默认 |
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
- **SLG 商城价格面板（`pageSlgShop`，slg.shop.manage，2026-07-13）**：9 件商品各一张卡片（3 加速/3 资源包/2 护盾/1 战令），可编辑 cost + 单个关键 effect 字段（duration_sec / each，战令仅 cost），保存即 `PUT /admin/config/slg-shop/{id}`；未覆盖显示"Not overridden, using default (cost N)"，已覆盖显示覆盖人+时间。
- **构建版本标识（2026-06-24）**：header 右侧显示 `v <git short hash>`（hover 出构建时间 UTC），webpack `DefinePlugin` 在构建期注入 `__BUILD_VERSION__`/`__BUILD_TIME__`（取 `git rev-parse --short HEAD`）。用于排查"线上是否旧 bundle"——发布后比对该号与目标提交即可确认。

---

## 8. 任务拆分（S7）

> 进度勾选随实现进 `META_TASKS.md`。补偿执行依赖 meta 系统邮件端点（S6-3，并行）。

| 任务 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **S7-0 shared + 契约** | `shared/admin.ts`（`AdminRole`/能力枚举/角色→能力矩阵/`SINGLE_COMP_QUOTA`/工单与审计类型）；admin 库集合形状 | — | ✅ |
| **S7-1 admin 后端骨架** | `server/admin` workspace：登录/JWT/RBAC 中间件 + 账号管理 + 审计写入 + 种子超管；`/health` | S7-0 | ✅ |
| **S7-2 监控 + stats 端点** | gateway/matchsvc 加 `GET /internal/stats`；admin 采样定时器 + `metricSnapshots` + monitor/trend 端点 | S7-1 | ✅ |
| **S7-3 补偿工单流** | 工单 CRUD + 审批路由（发起≠审批、额度分级）+ dry-run；执行器对接 meta 系统邮件端点，**2026-06-16 跨进程联调通过** | S7-1、S6-3 | ✅ |
| **S7-4 前端页面** | `tools/ops` 全部页面（登录/监控/分析/查询/工单/审计/账号/SLG赛季/SLG拍卖审计） | S7-1~3 | ✅ |
| **S7-5 数据分析** | 自采指标扩充 + 看板聚合（注册/补偿量/经济概览，按需经只读 API） | S7-2 | ✅（核心；扩充按需） |

### 实现记录（2026-06-16）

- **后端 `server/admin`（第七 workspace，CJS）**：`config.ts`（env）/ `db.ts`（独立库 `notebook_wars_admin`：adminAccounts/compTickets/auditLog/metricSnapshots，snapshot TTL 锚 BSON `at:Date`）/ `service.ts`（`AdminService` + `AdminError`，业务不变量：发起≠审批、`requiredApproveCapability(scope,tier)`、工单状态机、审计落库）/ `httpApi.ts`（node:http + admin JWT 鉴权 + 每端点 RBAC 静态能力门 + CORS）/ `clients.ts`（`HttpStatsClient` 合并 gateway+matchsvc、`HttpPlayerClient` 调 meta `/internal/player`、`HttpMailDispatcher` 按系统邮件端点契约形状对接）/ `seed.ts`（种子超管幂等）/ `index.ts`（引导 + 采样定时器）。
- **业务侧新增端点**：gateway `GET /internal/stats`（`Gateway.stats()` 在线数）；matchsvc `GET /internal/stats`（`Matchsvc.stats()` + `GameRegistry.stats()` 队列/房间/game）；meta `GET /internal/player?publicId=`（`resolveByPublicId` 反查档案摘要，player.lookup）。
- **前端 `tools/ops`（纯 TS + DOM，无框架，webpack 9093）**：`api.ts`（端点面；传输层 base URL/token/`req` 与 `ApiError` 拆入 `api/transport.ts`，`ApiError` 原路 re-export）/ `app.ts`（登录 + 按 capabilities 渲染导航）/ `types.ts`（**barrel 再导出**：拍卖审计/反 RMT 那组类型在 `types/auction.ts`）/ `pages.ts`（**barrel 再导出**，各页渲染器拆入 `pages/`：`shared.ts` 公共件 Ctx/showErr/showOk/sparkline/ms↔datetime + `monitor` / `analytics` / `player` / `suspicions` 反作弊 / `tickets` 工单发起+审批 / `audit` / `accounts` / `ladder` / `flags` / `events` / `slgSeason` 赛季运维 / `auctionAudit` 拍卖审计 / `gachaPools` 自定义卡池 / `promo` 兑换码 / `feedback` 玩家反馈 / `moderationWordlist` 敏感词覆盖表）。不持密钥、不连库、不直连业务服务。
- **部署接线**：`server/package.json` workspaces + `dev:admin`；`Dockerfile` 七包；`docker-compose.prod.yml` admin 服务（caddy 不路由）；`ecosystem.config.cjs` `nw-admin`；`.env.example` + `dev-up.ps1`（dev 种子 root/rootpass）。
- **验证**：七包 `tsc -b` 全绿 + admin 15 e2e（登录/RBAC/发起≠审批/超额+全服走超管/**单超管自批例外+留痕**/**有第二 super 时恢复四眼**/**禁用的第二审批人不算数**/dry-run/幂等执行+重试/审计可见性/player.lookup/采样 trend/账号管理）+ gateway 10 / matchsvc 17 / meta 74 不破 + `tools/ops` tsc + webpack 构建。
- **补偿 ↔ 邮件跨进程联调（2026-06-16）**：S6-3 邮件后端就绪，补全 `server/admin/test/comp-mail.e2e.test.ts`——admin 真实 `HttpMailDispatcher`/`HttpPlayerClient` 经 `fetch` 打真实 `app.listen({port:0})` 的 meta 进程（非 fastify inject），6 用例跑通：①单人补偿全链（发起→审批→真 HTTP 投递→玩家收件箱→领取附件→commercial 入账+钱包镜像）②`dispatchKey` 幂等（同 key 重发仅一封，meta `$setOnInsert`）③全服 fan-out + `preview` 命中人数 ④`player.lookup` 经真 `/internal/player` ⑤鉴权边界（错 `X-Internal-Key`→401→工单 failed、玩家无信）⑥收件人不存在→工单 failed。admin e2e 12→18，七包 `tsc -b` 全绿（meta dist 须先 `tsc -b`）。
- **待办**：§9 开放问题（金币当量换算表、GlobalFilter 维度、TOTP 二次审批）。

### SLG 商城价格可调配置（2026-07-13）

原 `SLG_SHOP_ITEMS`（`server/shared/src/slg/shop.ts`）9 件商品价格/效果全硬编码常量，改价须改代码重新部署（SLG_DESIGN G7 已知缺口）。改造为「DB 覆盖优先，DB 无记录时 fallback 到代码默认」，照搬 feature-flags 的成熟模式（admin 是唯一写者 + 唯一内部原始数据源，DB-less 后端轮询合并）：

- **`@nw/shared` 新增**（`slg/shop.ts`）：`SlgShopItemOverrideDoc`（`_id`=商品 id，`cost?`/`effect?`/`updatedAt`/`updatedBy`）、`resolveSlgShopItem`（默认值 + 覆盖合并）、`sanitizeSlgShopItemOverrideDoc`（容错清洗，脏数据静默降级不抛错）、`SlgShopPriceCache`（镜像 `FeatureFlagCache`：轮询 + TTL 30s + 断线保留旧缓存 + 冷启动 fallback 代码默认）。
- **`server/admin`**：`service/shop.ts`（`ShopMixin`：`getShopConfig`/`getInternalShopPrices`/`upsertShopItem`，写入即审计 `slg.shop.price.update`）；`db.ts` 新增 `slgShopPrices` 集合（`_id`=商品 id，索引 `updatedAt`）；`httpApi.ts` 三个端点（`GET/PUT /admin/config/slg-shop*` 会话鉴权 + `GET /admin/internal/slg-shop-prices` 内部鉴权，见 §4.2）；新增能力 `slg.shop.manage`（super/ops，见 §2.2）。
- **`server/worldsvc`**：`ShopService.buySlgShopItem`/`getSlgShopItems` 改为优先查 `WorldCore.shopPrices`（`SlgShopPriceCache`，未注入则用代码默认，不炸）；`index.ts` 起进程时构造该缓存，轮询 admin 内部端点（`NW_ADMIN_INTERNAL_URL` 未配置则永远走代码默认）。
- **`tools/ops`**：`pageSlgShop` 面板（见上）+ `api.ts`/`types.ts` 对应方法与类型。
- **验证**：`@nw/shared` 单测 12 例（合并语义/清洗容错/缓存降级）；`server/admin` e2e 6 例（真实 Mongo：列表/写入/校验/审计/角色能力）；`server/worldsvc` e2e 3 例（真实 Mongo：默认价扣费、覆盖后按新价扣费且 effect 一并生效、未知商品 id 拒绝）；七包 `tsc -b` + `tools/ops` tsc/webpack 全绿；ops 面板手动登录改价 → 直接查询 admin API 确认持久化 → 起 worldsvc 真实进程轮询该 admin 实例，`GET /world/shop/items` 确认新价即时生效（30s 内）。

### SLG 赛季运维 + 拍卖审计前端（2026-07-01）

admin 后端（G7）已全部就绪；补完 `tools/ops` 对应的两个前端页面：

- **`pageSLGSeason`（slg.season.view / slg.season.manage）**：世界列表表格（worldId / season-shard / status / population / 开服时间），manage 角色可见 Settle / Reset / Close 操作按钮 + Open new world 表单（worldId + season + shard + capacity）；危险操作均须浏览器 `confirm()`；后端 guard（settle-before-reset）在 409 时以错误行内展示。
- **`pageAuctionAudit`（slg.audit.view / slg.audit.manage）**：① 扫描区（worldId + 可选 windowSec → 列出 AuctionAnomaly，manage 角色每行可点"File ticket"立单）② 审计工单队列（状态过滤，manage 角色开放 Dismiss / Action 裁定按钮，裁定时 `prompt()` 收注释）；工单行展示冻结快照摘要（世界/买卖双方/总币/严重度/信号）。
- **对应 `api.ts` 方法**：`slgListWorlds` / `slgOpenSeason` / `slgSettleSeason` / `slgResetSeason` / `slgCloseSeason` / `slgScanAnomalies` / `slgListAuditTickets` / `slgFileAuditTicket` / `slgResolveAuditTicket`。
- **`types.ts` 新增**：`SlgWorldSummary` / `AuctionAnomaly` / `TradeAuditSnapshot` / `TradeAuditTicketView` / `TradeAuditTicketStatus`（镜像 shared + clients.ts）。
- **验证**：`tools/ops` tsc --noEmit 零错误。

**补记（2026-08-10，生产事故修复，见 `SLG_DESIGN_LOG.md §17.15`）**：`pageSLGSeason` 加「Allocate next season」卡片（Season + Capacity 两个输入框），放在「Open a new world」表单**上方**，调用新增的 `api.slgAllocateNextSeason(season, capacity?)` → `POST /admin/slg/season/allocate`。这是唯一会真正推进赛季号的操作（内部走 `allocateNextSeason` 雪花分片分配 + 逐 shard 克隆地图模板）；「Open a new world」表单保留作低级 escape hatch（重开已关闭世界 / 单独补一个分片），UI 文案标注优先用前者——此前运营只有后者可用，在已存在的 `worldId` 上重填新 `season` 会被 `$setOnInsert` 静默丢弃，返回成功但赛季号从未真正推进。`types.ts` 新增 `SlgAllocateResult`。

### 玩家反馈页 + 已读/备注痕迹（2026-08-20）

玩家反馈链路（`SERVER_API.md §2.13`）此前**只有后端**：`POST /feedback` 提交、metaserver `feedback` 集合、`GET /internal/feedback`、admin `GET /admin/feedback`、能力点 `feedback.view` 与全套 e2e 都已就绪，唯独**没人写过消费它的 ops 页面**——契约齐全但运营在后台看不到任何反馈。本次补完前端，并顺带补上原设计缺失的追踪能力（原设计明确"无状态机"，代价是反馈累积后无法区分哪几条看过了）。

- **`pageFeedback`（`tools/ops/src/pages/feedback.ts`，导航排在 Player Appeals 之后）**：Unread / All / Read 过滤 + `N unread / M total` 计数；表格列 Time / Player / Platform / Feedback / Status / Ops note。后端只有一条扁平的 `createdAt` 倒序列表、没有 read 过滤，所以拉一页（limit 200）后在**前端切分**，计数始终按整页算而不是按当前视图算——切分逻辑提取为纯函数 `partitionFeedback` 单测覆盖（`tools/ops/test/feedback.test.ts` 7 例），`pageFeedback` 本身建 DOM 不测，与 `appeals.test.ts` 同一分工。
- **triage 语义（有意最轻）**：仍**不是**状态机，没有"处理中/已处理"、没有裁定。`readAt` 首次 review 打戳后永不覆盖，**未读 ⟺ `!readAt`**；写备注同时打 `readAt`（一次动作），故不存在"有备注但未读"的行。「Save note」提交文本框内容，「Mark read」不带 note 提交、**保留已有备注**（避免误删）；备注清空须显式提交空串。已读行不再显示「Mark read」按钮，改显示 `readAt` + `readBy`。
- **新能力点 `feedback.action`（super/ops）**：查看仍是全角色的 `feedback.view`，写入收窄到 super/ops——support/viewer 保持只读。每次写入落 `feedback.review` 审计，summary 区分 `noted` / `marked read`。
- **落点**：`@nw/shared` `FeedbackDoc` 增 `readAt?`/`readBy?`/`note?` + `FEEDBACK_NOTE_MAX=500` + `AdminCapability` 增 `feedback.action`；meta `POST /internal/feedback/{id}/review`；admin `FeedbackClient.reviewFeedback` / `FeedbackService.reviewFeedback` / `POST /admin/feedback/{id}/review`；ops `api.feedback()` / `api.reviewFeedback()` + `FeedbackView`。
- **验证**：meta feedback e2e 10→18 例（鉴权/缺 readBy/404/首次打戳/写备注即已读/`readAt` 不被覆盖而 `readBy`·`note` last-write-wins/省略 note 不清备注·空串清备注/超长截断）、admin feedback e2e 5→10 例、admin httpRoutes e2e 补 review 路由 + support 403、ops 前端 7 例；admin 全量 212 例、`@nw/shared` 1033 例、`tools/ops` 58 例全绿；起 meta+admin+ops 真实进程，经真 `POST /feedback` 灌入中英文反馈，在页面上完成"写备注→计数 3→2、行移出 Unread"与"标已读→计数 2→1"，回查 Mongo 确认 `readAt`/`readBy`/`note` 与两条审计 summary 均正确、中文原文无乱码。

### 敏感词覆盖表页（2026-08-20）

与同日的「玩家反馈页」是同一类缺口的第二例：敏感词库外部化（`CONTENT_MODERATION_DESIGN.md` §3.2，2026-07-29 落地）后端**全套齐全**——`moderationWordlists` 集合、`GET /admin/moderation/wordlists`、`POST/DELETE .../words`、内部轮询源 `GET /admin/internal/moderation-wordlists`、能力点 `moderation.wordlist.manage`、`WordlistCache` 消费侧——唯独 `tools/ops` 里**没有任何代码引用过它们**（`api.ts` 无方法、`types.ts` 无类型、无页面、无导航项）。也就是说 §3.2 承诺的"词库外部化为 ops 可配置项"实际只能靠手写 curl 或直接改库完成，设计里写的"热更新不重启"这一半是真的，"ops 可配置"这一半从来没有入口。本次补完前端。

- **`pageModerationWordlist`（`tools/ops/src/pages/moderationWordlist.ts`，导航项 `Word Lists`，排在 Feature Flags 之后——同属"运营可热改的配置面"那一组）**：四个 region 各一张卡片（`global` 排最前并挂 `inherited by all regions` 标签），每张卡片显示内置底线（只读，一眼看清删不掉的部分）、覆盖表条目（每条一个 `×` 删除按钮）、加词输入框，以及该 region 当前**实际生效**的词数拆分（内置 N + 覆盖 M）。加词/删词后整页重取，保证"继承/冗余"提示始终反映最新状态。
- **本页真正的业务价值：把"这个词到底加了什么"算出来给运营看**。匹配是**大小写无关的子串匹配**、且生效词表是**并集**（`effectiveWordlist` = global 内置 + region 内置 + global 覆盖 + region 覆盖），因此有三类看着合理、实际什么都没拦住的加词：①词已在内置底线里；②词已由 `global` 覆盖表继承下来（加到 `cn` 上纯属重复）；③词只是**延长**了一个已生效的词（已拦 `scam` 时再加 `scammer`——任何含 `scammer` 的文本本来就含 `scam`）。这三类统一由纯函数 `coveredBy` 判定并在输入时**即时**提示（"Blocks nothing new: ..."），已入库的冗余条目也挂 `no-op` 徽标 + 说明。**只提示不拦截**：归一化第二遍匹配（CM2）的行为与原文子串匹配不完全一致，是否保留某条明确条目是运营的判断，不是本页的。真正拦下来的只有服务端也会 400 的两种（空词、超 `WORD_MAX`=64）和"本 region 覆盖表里已有该词"（按钮直接置灰）。
- **纯逻辑抽出单测**：`activeWords`（并集 + 小写化 + 去重，去重保留**最靠前**的来源，使"同时躺在内置和覆盖里的词"归属内置而非覆盖）/ `coveredBy`（跳过被审计条目自身，否则永远命中自己）/ `checkWord`（`empty` / `too_long` / `duplicate` / `redundant` / `ok` 五态）/ `checkMessage`（哪几态**拦**、哪态只**提示**——这条策略本身被钉住）/ `describeCover`（内置 vs 覆盖 × 精确命中 vs 子串命中 四种措辞）五个函数覆盖 `tools/ops/test/moderationWordlist.test.ts` 28 例，含两类容易写反的方向性用例："更宽的前缀（`sca` vs 已生效的 `scam`）不算冗余"、以及"包含关系的措辞方向（覆盖方是**更短**那个）"；同 region 覆盖表内部的兄弟条目互相覆盖（`代练` 盖住 `代练群`，即行内 `no-op` 徽标指向的那种）也单独覆盖——跳过逻辑只能跳过被审计条目**自身**，跳过整个本 region 覆盖表就会漏报。上述用例做过变异验证（把跳过条件放宽成"跳过整张本 region 覆盖表"、把包含措辞方向写反，各自只让对应的那一条用例转红）；`pageModerationWordlist` 本身建 DOM 不测，与 `feedback.ts`/`flags.ts` 同一分工。
- **落点**：`types.ts` 增 `ChatRegion`/`ModerationWordlistView`/`WordlistOverrideDoc` 三个前端本地镜像类型 + `AdminCapability` 补上此前遗漏的 `moderation.wordlist.manage`（后端 `server/shared/src/admin.ts` 里一直有，前端联合类型里没有）；`api.ts` 增 `moderationWordlists()`/`addModerationWord()`/`removeModerationWord()`。**服务端零改动**——后端本来就是完整的。
- **验证**：`tools/ops` `tsc --noEmit`（src+test）全绿 + 前端单测 58→77 例全绿；起 worktree 自己的 ops dev server 打真实 admin 进程（Docker 栈 `funny-admin-1` + `nw-local-mongo`）走查：加中文词 `刷钻代充` 到 `cn`（生效数 10→11）、加 `phish` 到 `global` 后 cn/de/en 三个 region 的生效数**同时** +1 而各自覆盖数仍为 0（继承正确）、`Scammer` 对 `en` 与 `phishing-site` 对 `de` 均正确报"blocks nothing new"并指出覆盖来源（大小写归一化生效）、重复词按钮置灰报红、删词后计数回落且 `de` 仍保留继承来的那 1 个；回查 Mongo 确认 `moderationWordlists` 文档与 6 条 `moderation.wordlist.update` 审计 summary 均正确、中文无乱码，走查数据事后清理干净。

### 兑换码发码页（B-PROMO 补顶层，2026-08-20）

与同日另两节（玩家反馈页、敏感词覆盖表页）**同一类缺口、但成因相反**——那两例都是"后端齐全、没人写前端"；兑换码这条链**当初是完整的**（`META_TASKS.md` B-PROMO，2026-06-29 落地，admin 的 `GET/POST /admin/promo/codes` 就在其中），却在 2026-07-28 的死内部端点清理（`COMM_AUDIT_INTERNAL_2026-07-28` batch G，commit `6942481a`）里被删掉了——理由写得很明白：「no ops-frontend page calls any of them」，同时保留了下面的 service/client 层「in case they're wired up later」。于是形成一个自锁的环：路由因为没有前端而被删，前端因为没有路由而没人写。

后果不是"功能缺失"而是**半条链活着**：玩家侧 `POST /promo/redeem` 和商店充值 tab 的兑换码行一直在线（`LOBBY_IA_REDESIGN_LOG.md`），meta 的 `/admin/promo/codes` 与 commercial 的 `/internal/promo/codes` 也从没删过——**只有发码那一端不可达**，运营想发一个码只能拿 internal key 手工 curl meta。本次把顶层两段补回来并配上页面，让这条环闭合。

- **admin 路由**：`GET`/`POST /admin/promo/codes` 按原样恢复（`requireCap(actor, 'promo.manage')`、码+coins 缺失或非正数→400、`svc.createPromoCode` 落 `promo.create` 审计），落在 `httpApi/commerceRoutes.ts` 顶部——正是 2026-08-10 拆分前它在 `httpApi.ts` 里的物理位置（紧邻 Paddle 事件日志之前）。
- **`pagePromo`（`tools/ops/src/pages/promo.ts`，导航排在 Gacha Pools 之后）**：上方发码表单（Code / Coins / Total redemptions / Expiry 开关 + 时间 / Ops note），下方列表（Code / Coins / Redeemed / Status / Expires / Created / Ops note）。**只发不改不删**：码以自身大写文本为 `_id`、且可能已被玩家兑换过，提前退役只能靠 expiry 或总量上限，所以没有 edit/delete 按钮，代价是表单是唯一会出错的地方——校验因此放在前端而不是每个笔误换一次往返。
- **三条规则与 commercial 的 `PromoService` 逐条对齐**（页面读到的状态必须等于玩家兑换时真实发生的事）：①码存储前 `trim().toUpperCase()`，表单实时回显「stored as XXX」，免得运营输了小写、看到大写、再怀疑玩家该输哪个；②`promoRedeem` 的校验顺序是**先过期、后超量**，所以既过期又超量的码标 `Expired` 而不是 `Exhausted`（标错会让运营查错方向）；③`$inc redeemed` 是 best-effort（并发下允许超 1 个），故 `redeemed > totalLimit` 也必须读作 Exhausted。纯函数 `normalizePromoCode` / `validatePromoDraft` / `promoStatus` / `redemptionText` 单测覆盖（`tools/ops/test/promo.test.ts` 22 例），`pagePromo` 本身建 DOM 不测。
- **顺手修掉一个被假 mock 掩盖的真 bug**：admin 的 `PromoCodeView` 声明 `code`，但 commercial 的 `listPromoCodes` 是把 `promoCodes` 文档**原样**返回的（`_id` 就是码），meta 只做转发——真实响应里根本没有 `code` 字段。`clients-adminManage.test.ts` 里那条 list 用例喂的 mock 恰好是接口**声明**的形状（`{ code }`），于是它跟被测代码的类型互相印证、什么都没证明。现在改名落在 `HttpPromoClient.list()`（`_id → code`；commercial 的线上形状被它自己的路由用例钉住，不动），mock 换成真实文档形状并补一条"绝不把 `_id` 漏给下游"的回归用例。若非跑真实进程验证，页面的 Code 一列会是空的而测试全绿。
- **验证**：admin httpRoutes e2e 50→56 例（create→list 往返/大写归一化/`promo.create` 审计 actor+summary/重复码 409/三种 400/support 403 且未落库/ops 角色可发码），其中促成把静态 `stubPromo` 换成有状态的 `FakePromo`；admin `clients-adminManage` 13→15 例；ops 前端 86→108 例（同日两节各自 +22/+19 的基础上）。admin 全量 219 例、`tools/ops` 108 例全绿，`tsc -b admin` + ops `tsc --noEmit` 干净。起**真实** commercial+meta+admin+ops 四进程（独立库 `nw_promo_verify`），在页面上完成：小写 `autumnfest` 发码 → 列表出现 `AUTUMNFEST`（带 expiry/上限/备注）→ 重复提交得到译好的「already exists (codes are unique, case-insensitive)」而非裸 `BAD_REQUEST` → 四种状态（Active / Exhausted 1⁄1 / Expired / 无限 ∞）同屏可见 → 用页面发的 `WINTERGIFT` 真跑一次玩家兑换（+100 coins，同玩家二次 `PROMO_ALREADY_USED`），回到页面 Redeemed 变 `1 / ∞`；support 账号 `/admin/me` 无 `promo.manage`、两条路由均 403；`GET /admin/audit` 六条 `promo.create` 齐全。（本机 Browser pane 不合成画面、截图接口超时，故以 `read_page`/`get_page_text` 逐项核对文本与结构。）
- **补测（2026-08-20 同日）**：上面那轮验证只证明了「配置正确时能用」，覆盖率一查发现 `service/promo.ts` 与 `clients/promo.ts` 都是**行 100% 但分支 66%**——两个 `!promo.available` 分支（`NW_META_BASE_URL` 没配时运营看到什么）从未执行过，因为 httpRoutes e2e 的 promo fake 永远 `available: true`；meta 侧同类路由是有「commercial unavailable → 503」用例的，admin 侧偏偏没有。补 `server/admin/test/promo.test.ts`（7 例，不需要 Mongo：unavailable 路径在碰集合之前就返回/抛出，`audit()` 只用到 `auditLog.insertOne` + `now()`，沿用 `core-identity.test.ts` 的 stub cast 先例），钉住这里真正的**读写不对称**设计：list 静默降级成 `[]`（后台其余部分照样渲染），create 则用自己的 `503 promo_unavailable` 大声失败（而不是客户端那个笼统的 502）；以及**顺序**——被拒的 create 必须既不落审计也不碰客户端，因为「码从未生成却留了一条 `promo.create`」比失败本身更糟（那条审计是这个码存在过的唯一记录）；还有审计的 target 必须是 commercial 返回的规范化码而非运营输入的原文，否则审计里写着一个库里不存在的码。三处变异各只让对应的一例转红（删掉 list 守卫 / 审计 `args.code` / 把 503 守卫挪到客户端调用之后）。`clients-adminManage` 15→20 例，补上 `?? []`（`_id→code` map 跑在它上面）、无 status 的网络失败、200 但没带 code、以及 `available` getter 本身（正是 service 降级分支读的那个标志）。两个 promo 文件现在行/分支/函数全 100%，admin 全量 219→235 例、包行覆盖 93.53%→93.74%。（`tools/ops` 不在覆盖率闸门的包列表里——只有 `client` + 13 个 server workspace + engine——所以 `pagePromo` 那段建 DOM 的代码不测不会碰闸门，与所有同级页面同一约定。）

### 反作弊两张信号表（C3/C4 补顶层，2026-08-20）

同日兑换码那节（上一节）修的是 batch G 的**第一个**误判，这节修剩下的两个——同一次提交（`6942481a`）里被同一条理由（「no ops-frontend page calls any of them」）删掉的 `GET /admin/mismatches` 与 `GET /admin/suspicious-pve`，同样保留了 service/client 层「in case they're wired up later」。三个误判成因完全一致，故不再重复推演自锁环的部分，只记双向核查的结论和这次的实现取舍。

**双向核查（batch G 当初跳过的那一步）**——判死一个端点必须同时问「数据还在产吗」和「这个特性还算交付了吗」，只看 admin 层的调用方是不够的：

| | 数据生产端 | 文档口径 | 有无替代面 |
|---|---|---|---|
| C3 `/admin/mismatches` | **在产**。`metaserver/src/internal/matchReport/reportRoute.ts` 每局都算 `hashMismatch = !hash_ok && !cheat`，命中就写 `matches.hashMismatch=true`；这类争议局**刻意不打 `expireAt`**（其余对局 7 天 TTL），注释写明是「for ops review + anti-cheat audit trail」 | `META_TASKS.md` S4-2 已 `[x]`，验收写「mismatch 落 `matches.hashMismatch` + admin 告警」；归档 PARALLEL_DEV_PLAN C3 点名 `GET /admin/mismatches` 就是那个「告警」面 | **无**。反作弊审核队列的 `kind` 只有 `pvp_overclaim`/`pve_reject`/`coin_anomaly`，从来不含 mismatch；全库没有第二个地方列争议对局 |
| C4 `/admin/suspicious-pve` | **在产**。`metaserver/src/service/pve/verify.ts` 每次 rejected 都 `$inc flags.pveWarnings` | `ACCOUNT_DESIGN.md` §C4+S4-4「2026-06-29 完整落地」清单里就列着 `GET /admin/suspicious-pve`（前端入口） | **部分重叠但不等价**，见下 |

C4 这条值得单独说清楚，因为它是三个误判里唯一有理由犹豫的：`pve_reject` 审核队列确实可见，且每条记录都带 `rejectCountAfter`。但队列是**逐事件**的、默认只筛 `status='open'`，一条记录被裁定后就从视图里消失——**跨已裁定记录的累犯**在全库任何地方都看不到了，而这正是 `flags.pveWarnings` 这个累计计数存在的意义：自 2026-07-18 取消三振自动封号后它「纯属展示/审核信号」（`accountDocs.ts` 注释原话），也就是说**这张表是它唯一的读者**——路由一删，meta 每次递增的这个数字全库无人可读。反过来看，走 (b) 删净的收益也很薄：`SuspiciousPveClient` 本身必须留（`banAccount`/`unbanAccount` 是全库唯一一条封号执行路径，玩家查询页、`resolveAntiCheatReview`、SLG 交易审计工单三处都在用），`anticheat.view` 能力点也必须留（审核队列在用），真正能删的只有 `listSuspiciousPve` 一个方法。

- **admin 路由**：两条按原样恢复（`requireCap(actor, 'anticheat.view')`、响应体分别是 `{ mismatches }` / `{ accounts }`），落在 `httpApi/trustSafetyRoutes.ts` 而**不是**拆分前的物理位置（`monitorRoutes` 对应的那段 if-chain）——同一个能力门、同一个运营人一次看三张表，按 2026-08-10 拆分时定的「按域分组，物理顺序无意义（路径集合不重叠）」口径归到这里。
- **`MismatchRow.players` 补 `displayName?`/`publicId?`**：meta 是把整个 `players` 数组投影出来的，`MatchDoc.players` 里本来就有归档时的身份快照——原类型只声明 `{side, accountId}`，属于「类型比线上响应窄」，页面照此渲染就只能显示裸 accountId，而可读的姓名/公开 id 就在响应里躺着没人用。这是兑换码那节 `PromoCodeView.code` 同一类的类型-线上不符，只是方向相反（那边是声明了线上没有的字段），修法一致：以线上真实形状为准，并补一条「身份快照必须原样穿透」的客户端回归用例。
- **前端落在现有 `pageSuspicions`（`tools/ops/src/pages/suspicions.ts`，115→275 行）而非两个新页**：两条路由和审核队列共用 `anticheat.view`，导航里再加两个近乎同名的 anticheat 项只会变噪声。页面结构改成 `h2 Anti-cheat` + 三节 `h3`（Review queue / Hash mismatches (last 24 h) / Suspicious PvE accounts），导航标签相应从「Anti-Cheat Review」改为「Anti-Cheat」。三节各自加载、各自报错——meta 某一条不可达不能把另两节一起清空。
- **mismatch 一节不只是把 200 行摊平**：`BOTSVC_DESIGN.md` §8 记着 bot 压测时 `mismatch` 大量来自单事件循环饿死导致的失同步，也就是说这张表的行数天然掺着「一次基础设施故障」而非「一批作弊者」。因此表上方加一行 `mismatchRepeats()` 汇总——只列在窗口内出现于**多于一局**的账号（按局计重，同一局里出现两次仍算一次），运营先看这行就能分清「一次 desync 风暴」和「某个账号反复出现」；时序表本身反而答不了这个问题。
- **PvE 一节的 `pveWarningLevel()` 对齐服务端阈值**：`>= 3`（`PVE_REJECT_BAN_THRESHOLD`，前端按 ops 惯例本地镜像常量并注明出处）标红，与 meta 给同一账号的审核记录打 `severity:'high'` 用的是同一条线——两节要是各标一套，运营会得到两份互相矛盾的「谁是累犯」。行内动作只有 `anticheat.action` 可见的 Ban/Unban，复用玩家查询页那条既有端点（不新增封号路径）。
- **验证**：admin `httpRoutes.e2e` 56→59 例（C3 整行原样返回含身份快照 / C4 列表 + 经 ban 端点封禁后 `banned` 翻转 / support 两条均 403），过程中把返回空数组的 `stubMismatches`、`FakeSuspiciousPve.listSuspiciousPve` 换成真实形状（空数组无论路由怎么写都能过，等于没测）；`clients-lookupAndQueue` +1 例（身份快照穿透）；ops 前端 119 例（108→119，新增 `mismatchPlayerLabel`/`mismatchRepeats`/`pveWarningLevel` 单测）。admin 全量 223 例、`tools/ops` 119 例全绿，`tsc -b shared admin` 干净，ops 生产 webpack 构建干净。起**真实** metaserver+admin+ops 三进程（独立库 `nw_c3c4_verify`）走查：累犯行显示 `Alice ×3, Bob ×2` 而只出现一局的 Carol 正确缺席、`room-4` 无身份快照回落裸 accountId、超 24h 与 hash 正常的对局均被排除；名册按 5/2/1 排序且零警告的账号不出现；点 Ban 真写进 `flags.banned` + 一条 `account.ban` 审计，该行回来变 `banned`/Unban，再点 Unban 两者同时清掉；support 账号两条路由 403、super 200、无 token 401。（本机 Browser pane 不合成画面、截图超时，故以 `read_page`/`get_page_text` 核对。）
- **补测一轮（同日稍后）**：上面那句「ops `tsc --noEmit` 干净」当时是**错的**——`npm run typecheck` 是在写测试文件**之前**跑的，而 `vitest` 不做类型检查、`webpack` 生产构建只编译 `src/` 不碰 `test/`，于是 `mismatchPlayerLabel` 的四个用例多传了它并不接收的 `side` 字段（对象字面量 excess-property 报错）一路混过验证进了提交。教训：**加完测试文件必须重跑该包覆盖 test 的那个脚本**（ops 是 `npm run typecheck`，metaserver 是 `typecheck:test`——`npm test` 里的 `tsc -b` 只管 src）。同时补了两类真正缺的用例：
  - **C4 的 meta 路由用例此前是自证自洽的**（`pve-anticheat.test.ts`）：`accounts.find()` 的 fake **完全忽略传进来的 query**，在 `toArray` 里自己重新实现了一遍 `pveWarnings > 0` + 倒序 + `slice(0,200)`。实测把路由改成 `$gt: 5`、把 sort 翻成升序、把 cap 改成 20、从 projection 里删掉 `publicId`——**四种改法旧用例全部 9/9 通过**，也就是说它验证的是 fake 而不是路由；而本节的名册页恰恰把「按次数倒序」当作产品前提在读。现在 fake 改为按**路由真正传入**的 query/sort/limit 求值并记录下来（`asked`），用例断言 `{'flags.pveWarnings':{$gt:0}}` / `{-1}` / `200` / 六个投影字段，且断言返回顺序为 `acc-4, acc-1, acc-2`；同四种变异现在全部被抓。属 [[mock-must-not-echo-the-interface-shape]] 同一类陷阱。
  - **`mismatchRepeats` 两个边界**：`players` 真的可能是空数组（meta 原样投影 `MatchDoc.players`，其自身用例的 fixture 就用 `players: []`），空行必须跳过而不是抛；以及同一账号在两局之间**改过名**时（`displayName` 是每局快照）标签取**最新**那行——meta 返回是 newest-first，取错会让汇总行用一个玩家已经不再使用的名字。两条都做了变异验证（改成覆盖标签 / 改成不设防的 `players[0]`，各自精确失败一条）。**未加**的：`LadderService` 的 `available===false → []` 守卫（真实 `HttpMismatchClient` 在 `metaBaseUrl` 为 null 时本来也返回 `[]`，测它等于测重言式）、`tools/ops/src/api.ts` 的响应解包（该包目前没有任何 api 层测试，为一行 `r.mismatches` 引入 fetch mock 模式不划算，属既有的包级空档）、`pageSuspicions` 建 DOM 部分（全包页面渲染器一律不测，同 `promo.ts`）。metaserver 全量 103 文件/1648 例 + `typecheck:test`、ops 121 例 + `typecheck` 全绿。
  - **同一提交还漏了另一道门**：`75bd1957` 把 `tools/ops/src/types.ts` 从 496 推到 524 行，越过 `tools/` 自己那道 `checkFileLength.mjs`（`cd tools && node scripts/checkFileLength.mjs`，与 server/client 的是**各自独立的调用**，跑仓库根那个查不到 `tools/`）。同类原因：包级全量验证（`tsc` + vitest + 生产构建）会从这道门旁边直接走过去。已由并行会话的 `f22c3df2` 拆 `types/auction.ts` 修掉（同时修了 `47eaa423` 留下的 `api.ts` 508 行）。**教训与上一条同源**：改动只要给 `tools/*` 加行，收尾前要单独跑那道门；文件本来就在 450–500 区间时更要当成警告——端点/类型 barrel 每加一个页面都会被追加，早晚在某次普通功能提交上越线。

### 加固 / 优化（2026-06-16，第二轮）

落实 §6 安全要求 + 前端体验补完，四项：

- **登录失败限流（§6）**：`AdminService.authenticate` 按登录名（归一化大小写/空白）滑动窗口计数——`LOGIN_WINDOW_MS=15min` 内连错 `LOGIN_MAX_FAILURES=5` 次 → 锁定 `LOGIN_LOCKOUT_MS=15min`；锁定期间**连口令都不校验**直接返回 **429**（防爆破 + 防计时旁路），成功登录即 `loginAttempts.delete` 清零。内存态（admin 单实例够用，多实例横扩迁 Redis）。审计 `login.failed` 记 `rate limited (Ns left)`。
- **会话中途 401 回登录页（前端）**：`Api.req` 遇**非登录端点**的 401 → `setToken(null)` + 触发 `Api.onUnauthorized` 回调；`App` 构造时挂该回调 → 清理当前页 teardown + `renderLogin('会话已过期')`。修掉 token 过期（8h TTL）后全页面渲染 `unauthorized` 红字的 UX（看似"全后台坏了"）。
- **页面 teardown 钩子（前端框架）**：`App` 维护 `teardowns[]`，导航 `select()` / 登出 / 会话失效前统一执行并清空；render ctx 注入 `onTeardown(fn)`。供监控页自动刷新的定时器在离开页面时 `clearInterval`，杜绝向已离开页面追加渲染的泄漏。
- **监控指标下拉 + 自动刷新（前端）**：趋势图加 5 指标下拉（online/queue/rooms/gameInstances/gameLoad，之前硬编码只看 online）+ 可开关的 10s 轮询（经 `onTeardown` 停表）。
- **审计时间范围过滤（前端）**：审计页加 从/至 `type=date` 输入，接后端已支持的 `from/to`（至 = 含当日全天 +24h）；`ApiClient.audit` 补 `to` 参数。
- **验证**：七包 `tsc -b` + `tools/ops` tsc/webpack 构建 + admin **12 e2e**（+1 限流用例：连错 5 次锁定 429、成功登录清零、大小写归一化同键）全绿。

### 新增环境变量（基线）

`NW_ADMIN_PORT`（前端 API 端口）/ `NW_ADMIN_JWT_SECRET` / `NW_ADMIN_MONGO_URI`（缺省复用 `NW_MONGO_URI`）/ `NW_ADMIN_MONGO_DB`（默认 `notebook_wars_admin`）/ `NW_ADMIN_SEED_USER` / `NW_ADMIN_SEED_PASS` / `NW_INTERNAL_KEY`（调业务内部端点）/ 各业务内部基址（`NW_META_BASE_URL` / `NW_GATEWAY_INTERNAL_URL` / `NW_MATCHSVC_INTERNAL_URL` / `NW_WORLD_INTERNAL_URL`）。

### 修复记录：admin 缺 `NW_WORLD_INTERNAL_URL`（补跑）

三个 compose 文件（`docker/docker-compose.local.yml` / `server/docker-compose.prod.yml` / `server/docker-compose.cloud.yml`）的 `admin` 服务此前从未配置 `NW_WORLD_INTERNAL_URL`，导致 `WorldClient`（`server/admin/src/config.ts` 读取该变量）在所有环境下 `baseUrl=null` → `available=false`，SLG 赛季运维端点（`/admin/slg/season/*`）与地图模板管理端点静默失效（报「worldsvc not configured」或返回空列表）。已在三处 `admin.environment` 补 `NW_WORLD_INTERNAL_URL: http://worldsvc:18084`（与相邻 gateway/matchsvc 内部基址同模式）。`docker compose config -q` 三文件均验证通过。

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
