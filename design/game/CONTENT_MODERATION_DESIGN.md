# Notebook Wars — 内容治理设计（敏感词 / 举报 / 处罚 / 申诉）

> 状态：P1-P5 全部完成（见 §9）· 权威：本文（用户名/家族名/宗门名/聊天治理的单一入口，取代 `SOCIAL_DESIGN.md` SOC10 与 `COMPLIANCE_GLOBAL.md` §7 的临时描述）· 更新：2026-07-30
>
> 拍板（2026-07-29，用户）：①"全部加"——把此前讨论的四层防御（预防/检测/后果/审核+申诉）一次性设计完整，先文档后编码；② 检测层第一期**不接第三方语义审核 API**，纯自建（正常化预处理 + 词库 + 举报 + 信誉分处罚），后续视需要再加；③ 后台审核/申诉面板这次一起做（`tools/ops`）；④ 信誉分**自动衰减**（每 30 天 +10，CM8）；⑤ 分级阈值/举报扣分单一档位均按 §4.2 默认值实现（O-CM1/O-CM2/O-CM3 已拍板）。
>
> 配套阅读：`SOCIAL_SVC_DESIGN.md`（socialsvc 边界/ReportDoc 现状）、`OPS_DESIGN.md`（admin RBAC/审计/唯一封号执行路径 OPS 系列决策）、`ACCOUNT_DESIGN.md`（AccountDoc）、`COMPLIANCE_GLOBAL.md` §7/`COMPLIANCE_CN.md`（UGC 治理的合规动因）。

---

## 0. TL;DR

- **现状盘点**（2026-07-29 调研结论，详见 §1）：已有纯关键词黑名单过滤引擎（`shared/chatFilter.ts`），但只接入了"私聊发送"和"displayName 改名"两个点；账号注册首次昵称、家族名、宗门名、家族聊天、世界频道聊天**均未过滤**；举报（`ReportDoc`）只有"落库"没有"处理闭环"；封禁只有永久二值状态，没有禁言/限时封禁/信誉分；admin/ops 对 socialsvc 的举报数据完全不知情。
- **不做的事（本期明确排除）**：不接第三方语义审核 API（OpenAI moderation / Google Perspective 一类）——纯自建方案，避免把玩家聊天内容发给第三方带来的隐私/GDPR 处理者协议问题；不做实时语义理解，只做关键词 + 归一化预处理。
- **四层防御**：
  1. **Prevention（预防）**：`censorChat` 前置归一化（去符号/全半角/大小写/常见 leetspeak），降低绕过成功率；词库外部化为 ops 可配置项（DB 覆盖代码默认值，热更新不重启）。
  2. **Coverage（覆盖面补齐）**：把 `censorChat` 接入现在完全没接的五个点——注册首次昵称、家族名创建、宗门名创建、家族频道聊天、世界/国家频道聊天。
  3. **Consequence（后果机制）**：举报处理闭环（`ReportDoc` 加 resolve API）+ 信誉分（`AccountDoc.flags.reputationScore`）+ 分级处罚（警告/禁言/限时封禁/永久封禁），处罚执行收敛到 metaserver **唯一一条处罚执行路径**（沿用 OPS 系列"唯一封号路径"原则，扩展为"唯一处罚路径"）。
  4. **Review + Appeal（审核 + 申诉）**：admin 新增 `reports.*`/`appeals.*` 能力，桥接 socialsvc 举报数据；`tools/ops` 新增审核面板（模板复用 `pages/suspicions.ts`）；玩家侧新增申诉入口（提交申诉 → 人工复核 → 撤销处罚）。
- **明确排除、留作后续的一个已知缺口**：gateway/WS 层目前完全不检查封禁状态（登录后已连接的 WS 会话不受新封禁影响），这是**独立于本设计已存在的老问题**，不在本次范围内一并修——已记录为 §8 开放问题，建议另开任务跟进（见文末）。

---

## 1. 现状盘点（2026-07-29 调研）

| 场景 | 现状 | 文件 |
|---|---|---|
| 用户名（注册首次） | ❌ 未过滤，仅 `validateDisplayName` 校验长度 1-24 | `server/shared/src/password.ts`、`server/metaserver/src/accounts.ts` |
| 用户名（改名） | ✅ 命中即拒绝 | `server/metaserver/src/service/auth.ts` `profileRename()` |
| 家族名（创建） | ❌ 未过滤，仅 tag 正则 + 显示宽度校验 | `server/socialsvc/src/familyService.ts` `createFamily()` |
| 宗门名（创建） | ❌ 未过滤，同上 | `server/worldsvc/src/sectService.ts` `createSect()` |
| 好友私聊 DM | ✅ 命中替换为 `*`，照常发出 | `server/socialsvc/src/friendService.ts` `sendMessage()` |
| 家族频道聊天 | ❌ 未过滤，仅长度校验 | `server/socialsvc/src/familyService.ts` `sendMessage()` |
| 世界/国家频道聊天 | ❌ 未过滤，仅长度校验 | `server/worldsvc/src/nationChannelService.ts` `sendMessage()` |
| 举报 | 只落库（`status` 恒为 `'open'`），无 resolve API，无后续动作 | `server/socialsvc/src/friendService.ts` `reportUser`/`listOpenReports`、`ReportDoc` |
| 封禁 | 只有 `AccountDoc.flags.banned: boolean` 永久二值；无禁言/限时封禁/信誉分；生效点仅登录 + `/pve/enter`/`/pve/clear`，**gateway WS 连接期间不检查**（已存在的老缺口，非本设计引入） | `server/shared/src/mongo.ts`、`server/metaserver/src/accountCache.ts`、`server/metaserver/src/service/base.ts` `rejectIfBanned()` |
| admin ↔ socialsvc | admin 对 `GET /internal/reports` 完全无客户端，两侧数据链路断开 | `server/admin/src/clients/*` |
| 词库 | 硬编码常量 `REGION_WORDLISTS`（`shared/chatFilter.ts`），注释明确写"占位小词表，真实词库应由 ops 从外部配置注入" | `server/shared/src/chatFilter.ts` |

可复用的既有基础设施（不必重建）：
- `ReportDoc` 集合 + `POST /social/friends/report` + `GET /internal/reports`——举报"收集端"已有，扩展 `status` 枚举即可。
- metaserver `/internal/accounts/:id/ban`/`unban` + `AccountCache`——全库唯一封号执行路径，处罚新增档位可以挂在同一条路径上扩展，不新起一套。
- `AntiCheatReviewDoc`（`open→resolve(dismissed/banned)`）+ `tools/ops/src/pages/suspicions.ts`——结构与"举报审核队列"同构，直接复制改造。
- `server/admin` 的 RBAC（`AdminCapability`/`ROLE_CAPABILITIES`）+ 审计（`AuditAction`）+ `clients/*.ts` 打下游 `/internal/*` 的模式。

---

## 2. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| CM1 | 归一化预处理前置于 `censorChat` 匹配：去除符号插入（`f.u.c.k`→`fuck`）、全半角统一、大小写统一、常见 leetspeak 替换表（`0→o 1→i 3→e 4→a 5→s 7→t $→s @→a`，仅用于 `en`/`global` 匹配，避免误伤 CJK） | 纯子串匹配对海外玩家的绕过几乎没有抵抗力；归一化是成本最低、收益最大的加固手段 |
| CM2 | 归一化命中但原始文本子串匹配未命中时，**整条消息**打码/拒绝，而不是尝试把归一化后的命中位置映射回原始文本做逐词打码 | 归一化会改变字符串长度（如去掉插入符号），精确位置回填是一个复杂且容易出 bug 的对齐问题；对于聊天场景"整条打码"体验上可接受，避免过度工程 |
| CM3 | 词库外部化：`REGION_WORDLISTS` 保留作为**代码默认值**（fail-safe 下限），新增 `server/admin` 侧可管理的 DB 覆盖词表，`GET /internal/moderation/wordlists` 供各消费方拉取；**DB 词表是叠加（additive），不是替换**——即使 admin 服务不可达，代码默认词表依旧生效 | 复用既有"ops 可调、DB 覆盖代码默认"惯例（`slg.shop.manage`同款模式）；叠加而非替换是防止"admin 挂了导致过滤器整体失效"的下限保证 |
| CM4 | 消费方（metaserver/socialsvc/worldsvc）用与 `AccountCache` 同款的进程内 TTL 缓存轮询 admin 的词表端点（默认 60s），从不同步阻塞请求路径 | 与现有 `accountCache.ts` 缓存哲学一致；避免每次过滤都网络往返 admin |
| CM5 | 五个覆盖缺口全部接入 `censorChat`，策略沿用各自场景既有先例：**长期展示类内容**（注册首次昵称、家族名、宗门名）命中即**拒绝**创建/请求（与改名一致）；**聊天类内容**（家族频道、世界/国家频道）命中**打码**照常发出（与私聊一致） | 沿用项目已确立的"展示内容拒绝、聊天内容打码"两套策略，不引入第三种新策略 |
| CM6 | 新增 `AccountDoc.flags.reputationScore`（默认 100，下限 0）+ `flags.mutedUntil`（epoch ms，聊天禁用窗口）+ `flags.bannedUntil`（epoch ms，限时封禁，登录侧按现有 `rejectIfBanned` 同一入口检查）。既有 `flags.banned: boolean` 语义不变，专指**永久封禁** | 复用现有字段命名习惯（`flags.*`），限时封禁与禁言都是"到期自动失效"的时间戳字段，不需要额外的定时任务解除 |
| CM7 | 处罚执行收敛到 metaserver 新增 `POST /internal/accounts/:id/penalty`（唯一处罚执行路径，扩展 OPS 系列"唯一封号路径"原则）：扣减 `reputationScore`，按阈值表（§4.2）决定是否叠加 mute/temp-ban/ban，写回 + 失效 `AccountCache` | 与"全库只有一条封号执行路径"（2026-07-18，`452ea23b`）同一纪律：所有处罚来源（举报确认、未来的反作弊/其它治理）都走这一条端点，不各自维护封禁逻辑 |
| CM7.1 | 家族/世界频道禁言检查**不新增网络往返**：`socialsvc`/`worldsvc` 都没有 `accounts` 集合的直接连接，但两边的 `sendMessage()` 本来就已经在每次发送时调用 `meta.getProfile()`/`meta.batchProfiles()` 解析 displayName/title——把 `mutedUntil` 塞进这个既有响应即可，复用同一次调用，不必为禁言检查单独打一次 metaserver 内部 API | 检查点已经存在（每条消息都会问 meta 要 profile），加字段比加调用便宜；私聊（DM）走同样机制，因为 `friendService.sendMessage` 同样已经调用 `meta.batchProfiles` |
| CM8 | 信誉分**自动衰减**（用户 2026-07-29 拍板，取代原"本期不设"草案）：每 30 天未被扣分的账号 `+10`（封顶 100），靠每日定时任务（`reputationDecayAt` 时间戳到期即触发）扫描，不需要玩家主动触发任何请求 | 纯人工调整会让长期不活跃/未再犯的玩家永远卡在低分档位，自动回血给"确实改了"的玩家一个恢复路径；30 天/+10 是用户确认的起步值，后续可调 |
| CM8.1 | 衰减实现：`flags.reputationDecayAt`（epoch ms，下次可衰减时间）随每次处罚写入 `now()+30d`；metaserver 新增每日 `setInterval` 扫描 `reputationScore<100 且 reputationDecayAt<=now` 的账号，`+10` 封顶 100，仍 <100 则把 `reputationDecayAt` 续到 `now()+30d`，否则清掉该字段（已回满不用再扫）。`accounts` 集合按 `flags.reputationDecayAt` 加**部分索引**（只覆盖该字段存在的文档），避免全表扫描——与 worldsvc `nextBuildCompleteAt`/`nextTrainingCompleteAt` 的部分索引惯例一致 | 每日扫描 + 部分索引是本仓库现成的惯例（`worldsvc` 建/练队列到期扫描同款手法），不是新发明的机制；批量步进而非逐账号定时器，避免海量 setTimeout |
| CM9 | `ReportDoc.status` 从恒定 `'open'` 扩展为 `'open' \| 'dismissed' \| 'upheld'`；新增 `POST /internal/reports/:id/resolve`（socialsvc，仅改 `status`，不碰信誉分）。举报确认后的信誉分扣减由 **admin** 在同一次操作里额外调用 metaserver 的 CM7 端点 | 沿用"admin 是唯一跨服务副作用协调者"的既有架构（对照 `TradeAuditTicketView` 的 `actioned` 自动封号也是由 admin 触发，不是 worldsvc/socialsvc 互相直连） |
| CM10 | 新增申诉：`AppealDoc` 集合落在 **metaserver**（因为申诉针对的是账号级处罚状态，metaserver 是 `AccountDoc` 权威）；玩家侧 `POST /account/appeal`（仅当账号当前有生效处罚时可提交）；admin 侧 `GET /internal/appeals` + `POST /internal/appeals/:id/resolve`，批准时清除对应的 `mutedUntil`/`bannedUntil`/`banned`，**不自动恢复信誉分**（如需恢复由 admin 另行走人工调整，审计留痕） | 申诉"撤销限制"和"恢复信誉分"是两件事，强行耦合会让恢复逻辑变复杂（可能还有其它未撤销的确认举报压着分数）；拆开处理更简单也更诚实 |
| CM11 | `tools/ops` 新增 `pages/reports.ts`（举报审核队列，模板抄 `pages/suspicions.ts`）+ `pages/appeals.ts`（申诉队列）；新增能力 `reports.view`/`reports.action`/`appeals.view`/`appeals.action`，`super`/`ops` 角色持有，`support`/`viewer` 只给 `.view` | 与现有 `anticheat.view`/`anticheat.action` 的角色分配惯例一致 |
| CM12 | Gateway/WS 层实时封禁强制生效（已连接会话在被封禁后应被强制断开）**明确排除在本设计范围外**，作为独立的既有缺口记录在 §8，不因本次治理特性顺带修 | 这是一个跟"内容治理"正交的、更大范围的连接层安全加固（gateway 需要主动检查/推送断开），混进本特性会让本已很大的改动范围进一步失控；禁言的实际生效点是"发消息时检查 `mutedUntil`"，不依赖 gateway 改动就能生效，不受此排除项影响 |

---

## 3. Prevention 层：归一化 + 词库外部化

### 3.1 归一化管线（`server/shared/src/chatFilter.ts` 新增 `normalizeForFilter`）

```ts
function normalizeForFilter(text: string): string {
  // 1. 全角→半角（ASCII 可打印字符 + 常见全角标点）
  // 2. 统一大小写（沿用现有 toLowerCase）
  // 3. 去除零宽字符 / 常见分隔符插入（. _ - * · 空格 等相邻插入到词中间的符号）
  // 4. leetspeak 替换表（仅当检测目标词典判定为拉丁字符词时应用，避免误伤中文）
}
```

- 匹配顺序：先用**原始文本**做现有子串匹配（未命中不影响任何现有行为、现有测试不受影响）；未命中再用**归一化文本**匹配一次；两次都未命中才算不命中。
- 归一化命中时按 CM2：整条消息打码（聊天场景）或整体拒绝（展示内容场景，本来就是拒绝语义，不受影响）。

### 3.2 词库外部化

- `server/admin` 新增集合 `moderationWordlists`（库 `notebook_wars_admin`，延续 OPS1 的"admin 自己的库"惯例）：

```ts
interface ModerationWordlistDoc {
  _id: ChatRegion; // 'global' | 'cn' | 'de' | 'en'
  words: string[];
  updatedBy: string; // adminId
  updatedAt: number;
}
```

- 新增内部端点 `GET /internal/moderation/wordlists`（`X-Internal-Key`，返回全部 region 的 DB 覆盖词表）+ 管理端点 `POST /admin/moderation/wordlists/:region/words`（加词）/`DELETE .../words/:word`（删词），走既有 admin RBAC，新增能力 `moderation.wordlist.manage`（`super`/`ops` 持有）。
- 各消费方（metaserver/socialsvc/worldsvc）新增一个和 `AccountCache` 同款的小缓存类（如 `WordlistCache`），60s TTL 轮询 admin 端点，**叠加**到 `REGION_WORDLISTS` 代码默认值之上；admin 不可达时静默回退到纯代码默认值（不抛错、不阻断业务）。

---

## 4. Coverage + Consequence 层

### 4.1 覆盖面接入点

| 场景 | 文件/函数 | 策略 |
|---|---|---|
| 注册首次昵称 | `metaserver/src/accounts.ts` `registerWithPassword()`、`service/auth.ts` `authRegister()` | 命中拒绝（400），复用 `profileRename` 同款逻辑 |
| 家族名创建 | `socialsvc/src/familyService.ts` `createFamily()` | 命中拒绝 |
| 宗门名创建 | `worldsvc/src/sectService.ts` `createSect()` | 命中拒绝 |
| 家族频道聊天 | `socialsvc/src/familyService.ts` `sendMessage()` | 命中打码，照常发出 |
| 世界/国家频道聊天 | `worldsvc/src/nationChannelService.ts` `sendMessage()` | 命中打码，照常发出 |

region 来源：家族/宗门名创建用创建者账号的 `AccountDoc.region`；家族/世界聊天用发送者账号的 `region`（与私聊现有取值方式一致）。

### 4.2 信誉分 + 分级处罚

```ts
// server/shared/src/mongo.ts AccountDoc.flags 新增字段
flags?: {
  ...
  reputationScore?: number;  // 缺省视为 100，下限 0
  reputationDecayAt?: number; // epoch ms；下次 +10 自动衰减的时间，CM8.1
  mutedUntil?: number;      // epoch ms；聊天发送前检查，与 rejectIfBanned 平级但独立的新检查点
  bannedUntil?: number;     // epoch ms；限时封禁，登录侧复用 rejectIfBanned 逻辑一并检查
};
```

分级阈值（**用户 2026-07-29 确认，按此实现**）：

| reputationScore 区间 | 动作 |
|---|---|
| ≤ 80 | 警告（系统邮件通知，不加限制） |
| ≤ 60 | 禁言 24h（`mutedUntil = now + 24h`） |
| ≤ 40 | 限时封禁 7d（`bannedUntil = now + 7d`） |
| ≤ 20 | 永久封禁（`flags.banned = true`，复用既有封号路径） |

每次确认举报（`upheld`）扣 20 分（**用户 2026-07-29 确认：单一档位，不分举报严重度**，后续如需要再加分级）。到达的**最严档位**生效，不会因为后续小分数波动被"降级"回退。

`POST /internal/accounts/:id/penalty`（metaserver，`X-Internal-Key`，唯一处罚执行路径）：
```
body: { delta: number, reason: string, resolvedBy: string }
→ 读当前 reputationScore（缺省 100）→ + delta（确认举报传负数）→ clamp [0,100]
→ 按上表判定动作，写 flags.{mutedUntil|bannedUntil|banned} 中对应字段（只加严不减轻）
→ AccountCache.invalidateBanStatus(accountId)（复用现有失效方法，命名可能需要泛化为 invalidateEnforcementStatus）
→ 返回 { reputationScore, action: 'none'|'warn'|'mute'|'tempban'|'ban' }
```

聊天发送路径（家族/世界/私聊 `sendMessage`）新增检查：若 `flags.mutedUntil` 尚未到期，拒绝发送（4xx，提示禁言剩余时间），检查点复用 `AccountCache` 的同一缓存实例扩展（避免每条消息都查库）。

---

## 5. Review + Appeal 层

### 5.1 举报处理闭环

- `ReportDoc.status`: `'open' | 'dismissed' | 'upheld'`；新增可选字段 `contentRef?: { kind: 'message'; conversationId: string; messageId: string } | { kind: 'name'; snapshot: string }`（供审核时回看原文——聊天消息本身已持久化在 `ChatMessageDoc`，用引用即可；名称类内容会被改名覆盖，需要落一份创建时快照）。
- `POST /internal/reports/:id/resolve`（socialsvc，`X-Internal-Key`）：body `{ resolution: 'dismissed'|'upheld', resolvedBy }`，只改 `ReportDoc` 自身状态。
- admin 在"确认举报"这一次操作里，先调 socialsvc 的 resolve 端点，再调 metaserver 的 CM7 处罚端点（两次调用都失败时整体回滚提示重试，不做分布式事务——参考现有 `TradeAuditTicketView` "best-effort" 的务实处理方式）。

### 5.2 admin/ops 桥接

- `server/admin/src/clients/reports.ts`（新增，`fetchInternalJson` 打 socialsvc `/internal/reports`，模式抄现有 `clients/*.ts`）。
- 新增能力：`reports.view`/`reports.action`/`appeals.view`/`appeals.action`（`super`/`ops` 持有 `.action`，`support`/`viewer` 只有 `.view`）。
- 新增审计动作：`report.review`、`account.penalty`、`appeal.review`。
- `tools/ops/src/pages/reports.ts`：列表（状态筛选）+ 行内 `Dismiss`/`Uphold` 按钮（抄 `pages/suspicions.ts` 结构），确认举报时二次弹窗展示"将扣 20 分，当前信誉分 X，本次动作：无/警告/禁言/限时封禁/永久封禁"预览。
- `tools/ops/src/pages/appeals.ts`：列表 + 详情（含 `enforcementSnapshot`）+ `Approve`/`Deny` 按钮。

### 5.3 玩家侧申诉

```ts
// metaserver 新增集合 AppealDoc
interface AppealDoc {
  _id: string;
  accountId: string;
  reason: string; // 玩家自由文本申诉理由
  enforcementSnapshot: { banned?: boolean; bannedUntil?: number; mutedUntil?: number; reputationScore?: number };
  status: 'open' | 'approved' | 'denied';
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  resolutionNote?: string;
}
```

- `POST /account/appeal`（玩家 JWT 鉴权；仅当账号当前存在生效处罚——`banned`/`bannedUntil` 未过期/`mutedUntil` 未过期——之一才允许提交；同一账号同时只能有一条 `open` 申诉，防刷）。
- `GET /internal/appeals`、`POST /internal/appeals/:id/resolve`（`X-Internal-Key`，approved 时清除对应字段并使 `AccountCache` 失效）。
- 客户端：登录返回 `ACCOUNT_BANNED`/发消息返回禁言错误时，弹出一个最简申诉入口（文本框 + 提交），复用现有错误提示弹窗组件，不新建复杂界面。

---

## 6. 分期实施路线

| 阶段 | 内容 | 涉及 |
|---|---|---|
| P1 | Prevention：归一化 + 词库外部化基础设施 | `shared/chatFilter.ts`、`server/admin`（wordlist 集合+端点+能力）、消费方缓存轮询 |
| P2 | Coverage：五个缺口接入 `censorChat` | metaserver/socialsvc/worldsvc |
| P3 | Consequence：`AccountDoc.flags` 扩展 + `penalty` 端点 + 聊天发送禁言检查 | `shared/mongo.ts`、metaserver、消费方 `sendMessage` |
| P4 ✅ | Review：`ReportDoc` resolve API + admin 桥接（client/能力/审计/ops 页面） | socialsvc、`server/admin`、`tools/ops` |
| P5 ✅ | Appeal：`AppealDoc` + 端点 + admin 桥接 + ops 页面 + 客户端最简申诉入口 | metaserver、`server/admin`、`tools/ops`、client |
| （不在本次范围）| Gateway 实时强制断开已封禁连接 | 见 §8，另开任务 |

每阶段完成后跑 `tsc --noEmit` + 对应服务测试；P5 涉及可见客户端改动，走 dev server + 截图核对。

---

## 7. 与既有文档的关系

- 取代 `SOCIAL_DESIGN.md` SOC10（敏感词过滤分地区）与 `COMPLIANCE_GLOBAL.md` §7（UGC 治理）的现状描述——两处改为指针，指向本文。
- `OPS_DESIGN.md` §2.2 能力矩阵表新增 `reports.*`/`appeals.*`/`moderation.wordlist.manage` 行，指向本文 §5/§3.2。
- `COMPLIANCE_CN.md` §2 法规矩阵"内容审查"行的 🟡 状态不因本文变化——微信小游戏 `security.msgSecCheck` 接入仍按用户 2026-07-29 拍板延后处理（见 `MEMORY` 记忆，非本文范围）。

---

## 8. 开放问题

- ~~O-CM1~~ **已拍板（2026-07-29）**：信誉分自动衰减，每 30 天 +10，见 CM8/CM8.1。
- ~~O-CM2~~ **已拍板（2026-07-29）**：阈值表按 §4.2 默认值实现，不调整。
- ~~O-CM3~~ **已拍板（2026-07-29）**：不分举报严重度，统一每次 -20 分。
- **O-CM4**（已知缺口，非本设计引入，仍未拍板）：gateway/WS 层不检查封禁状态，已连接会话在被封禁/限时封禁后不会被强制断开——建议另开任务修复，不在本次范围内。
- ~~O-CM5~~ **已修复（2026-07-29）**：客户端从未实际发送 `X-Chat-Region` 请求头，导致地区专属词表（cn/de/en）在真实请求里从未生效，只有 global 词表起作用。修复：新增 `client/src/net/chatRegion.ts`（`currentChatRegion()`，镜像服务端 `regionFromLocale` 的 zh→cn/de→de/en→en 映射，取自玩家当前 i18n locale），接入 `WorldApiClient.createFamily`/`sendFamilyMessage` 与 `ApiClient.sendChat` 三个调用点。修复过程中额外发现并修复了一个会阻断此修复本身的伴生 bug：`server/socialsvc/src/httpApi.ts` 的手写 CORS `access-control-allow-headers` 清单没有 `x-chat-region`，会导致真实浏览器在预检（preflight OPTIONS）阶段整体拦截请求（与 2026-07-28 `X-NW-Platform` CORS 停机同一类问题，见 `claudedocs/server.md`/`COMM_AUDIT_INTERNAL_2026-07-28.md`）——已一并加入该清单。worldsvc 的 `/sect/create`、`/nation/message` 走的是 `regionFromAcceptLanguage(Accept-Language)`，是浏览器原生自动发送的标准头，不受本 gap 影响，未改动。验证：`server/socialsvc/test/chatRegionHttp.e2e.test.ts`（真实 HTTP + 真实 Mongo，四个用例覆盖三个端点的“带头/不带头”对照）、`server/socialsvc/test/cors-headers.test.ts`（新增一条 X-Chat-Region 预检回归）、`client/test/net-x-chat-region.test.ts`（三个客户端调用点按 locale 发送正确 header），以及一次真实浏览器（web-e2e 入口 + `window.__nwE2E`）dev-server 走查：locale=en 时创建含 `私服` 的家族名成功（201，region 落到 en/global 词表未命中），切到 locale=zh 后同样的名字被拒（400 BAD_REQUEST，命中 cn 词表），且能看到真实的 CORS 预检 OPTIONS 往返。

---

## 9. 实现记录

- **2026-07-29，O-CM5 修复**：客户端 `X-Chat-Region` 请求头补齐 + 伴生 CORS gap 修复，详见 §8 O-CM5。

### 9.1 P1+P2：归一化 + 词库外部化 + 五处覆盖缺口（2026-07-29）

- `shared/chatFilter.ts`：`normalizeForFilter`（全半角/零宽字符/绕过符号/leetspeak）+ `WordlistCache`（镜像 `FeatureFlagCache`/`SlgShopPriceCache` 的轮询缓存模式）+ `censorChat` 两遍匹配（原文子串 → 归一化兜底，归一化命中时整条打码）。
- `server/admin`：新增 `moderationWordlists` 集合 + `GET /admin/internal/moderation-wordlists`（内部轮询源）+ `POST/DELETE /admin/moderation/wordlists/:region/words`（RBAC，`moderation.wordlist.manage`）。
- 覆盖缺口按设计接入：metaserver `authRegister`（拒绝）、socialsvc `createFamily`（拒绝）/`familyService.sendMessage`（打码）、worldsvc `sectService.createSect`（拒绝）/`nationChannelService.sendMessage`（打码）。`friendService.sendMessage`（既有私聊）顺带接入 DB 覆盖词表（此前只有内置词表）。
- 与设计的差异：无实质偏离；家族/宗门/私聊/世界频道 region 来源统一为发送者账号 `region`（家族/私聊走 `X-Chat-Region` 请求头——但 2026-07-29 实现时发现**客户端从未真正发送这个头**，见 O-CM5，已 spawn 独立任务）。
- 回归测试：`shared/test/chatFilter.test.ts`（+16 例：归一化/两遍匹配/`WordlistCache`/`sanitizeWordlistOverrideDoc`）、`metaserver/test/account-free-rename.e2e.test.ts`（+2 例）、`socialsvc/test/family.e2e.test.ts`（+2 例）、`worldsvc/test/sect.e2e.test.ts`/`nation-channel.e2e.test.ts`（各 +1 例）、`admin/test/moderation.e2e.test.ts`（新增，8 例）。

### 9.2 P3：信誉分 + 分级处罚（2026-07-29）

- `shared/mongo.ts`：`AccountDoc.flags` 新增 `reputationScore`/`reputationDecayAt`/`mutedUntil`/`bannedUntil`；`accounts` 集合新增 `flags.reputationDecayAt` 部分索引（衰减扫描用）。
- `shared/api.ts`：新增 `ErrorCode.ACCOUNT_MUTED`（403）。
- `metaserver/src/moderation.ts`（新文件）：`actionForScore`（§4.2 阈值表纯函数）+ `applyPenalty`（唯一处罚执行路径：读-改-写 + "只加严不减轻" + 到期即续 30 天衰减时钟）。新增 `POST /internal/accounts/:id/penalty`；`accountCache.ts`/`rejectIfBanned` 扩展支持 `bannedUntil`（限时封禁，登录侧与永久封禁同一入口检查）。
- `metaserver/src/reputationDecay.ts`（新文件）：`decayReputationOnce`（每日 `setInterval`，镜像 `coinAnomalyAudit.ts` 编排风格，`batchLimit` 有界批处理）。
- CM7.1 落地：`ProfileView`/worldsvc 本地 `PlayerProfile` 新增 `mutedUntil`；metaserver 的 `getProfile`（`accounts.ts`，worldsvc 用）与 `profileOf`/`profilesOf`（`social.ts`，socialsvc/私聊用）都在既有查询里顺带带出 `mutedUntil`，三个 `sendMessage` 调用点在**扣费/落库之前**检查并拒绝（`ACCOUNT_MUTED` / `SocialError:'MUTED'`），零额外跨服务往返。
- 与设计的差异：`§4.2` 中 mermaid 式描述"读当前 reputationScore→+delta→clamp"与实际 `applyPenalty` 实现一致；`mutedUntil`/`bannedUntil` 的"只加严不减轻"用 `Math.max(既有, 新计算)` 实现，而不是简单覆盖——设计文档原文未明确这一细节，属于实现时补的具体化，不算偏离。
- 回归测试：`metaserver/test/moderation-penalty.e2e.test.ts`（新增，11 例：阈值表/升级不降级/永封不可撤/内部端点/`rejectIfBanned` 限时封禁）、`reputation-decay.e2e.test.ts`（新增，5 例）、`socialsvc/test/family.e2e.test.ts`+`friend.e2e.test.ts`（各 +1 例禁言拒绝）、`worldsvc/test/nation-channel.e2e.test.ts`（+1 例，含"禁言时不扣费"断言）。

### 9.3 P4：举报处理闭环 + admin/ops 桥接（2026-07-30）

- `socialsvc/src/db.ts`：`ReportDoc.status` 从恒定 `'open'` 扩展为 `'open' | 'dismissed' | 'upheld'`，新增可选 `contentRef`（`message`/`name` 两种引用）+ `resolvedBy`/`resolvedAt`。`contentRef` 目前未被任何调用点写入——现有 `reportUser()` 只是玩家级举报（无消息/名称引用入口），这是刻意的最小实现：字段先留好形状，等未来出现"举报某条消息/某个名字"的具体入口再接上，不为一个尚不存在的功能预先造轮子。
- `socialsvc/src/friendService.ts`：`listOpenReports` 泛化为 `listReports(status='open', limit)`；新增 `resolveReport(id, resolution, resolvedBy)`——CAS 式 `updateOne({_id, status:'open'}, ...)`，对已解决的举报返回 `false` 而非静默幂等，让 admin 能准确提示"已被解决"而不是误判成功。`httpApi.ts` 新增 `POST /internal/reports/:id/resolve`；`GET /internal/reports` 加 `status` 查询参数。
- `server/admin`：新增 `clients/reports.ts`（`HttpReportsClient`，代理 socialsvc）+ `clients/enforcement.ts`（`HttpEnforcementClient`，代理 metaserver `POST /internal/accounts/:id/penalty`，P3 已有端点，P4 首次接上调用方）+ `service/reports.ts`（`ReportsMixin`：`resolveReport` 在同一次操作里先调 socialsvc resolve、`upheld` 时再调 enforcement 施加 -20 分，两次调用是 best-effort，不做分布式事务——与 `TradeAuditTicketView` 的既有务实原则一致）。新增能力 `reports.view`/`reports.action`（`super`/`ops` 有 `.action`，`support`/`viewer` 只有 `.view`）+ 审计动作 `report.review`/`account.penalty`。
- `server/admin` 部署配置：新增 `NW_SOCIALSVC_INTERNAL_URL`（此前 admin 对 socialsvc 完全没有客户端/环境变量，见 §1 现状盘点），已同步 `config.ts`/`index.ts`/`dev-up.ps1`/`ecosystem.config.cjs`/`docker-compose.cloud.yml`/`docker-compose.prod.yml` 六处。
- `tools/ops`：新增 `pages/reports.ts`（模板抄 `pages/suspicions.ts`：状态筛选 + Dismiss/Uphold 行内按钮，Uphold 前二次确认弹窗）+ nav 项 `UGC Reports`。
- 与设计的差异：无实质偏离；`contentRef` 的"暂不接入"是唯一需要说明的简化（见上）。
- 回归测试：`socialsvc/test/friend.e2e.test.ts`（+2 例 `resolveReport`，重命名后的 `listReports` 沿用既有 3 个断言）、`admin/test/contentModerationBridge.e2e.test.ts`（新增，9 例：list/resolve 的 dismissed/upheld 分支、penalty 调用参数、404/502 错误路径、角色能力矩阵）、`admin/test/clients-barrel.test.ts`（+3 个新客户端）。

### 9.4 P5：申诉流程 + 客户端最简 UI（2026-07-30）

- `shared/mongo.ts`：新增 `AppealDoc`（落在 metaserver 的 `accounts` 集合旁，CM10）+ `appeals` 集合（索引：`{status,createdAt}` 审核队列、`{accountId,status}` 单开申诉判重）。`shared/social.ts` 新增 `APPEAL_REASON_MAX=500`。
- metaserver 公开端点 `POST /account/appeal`：**走 openapi 分域片段 + codegen**（`contracts/openapi/paths/auth.yml` 新增 `submitAppeal` operationId → `npm run gen:api:contracts && npm run gen:api:server` 重新生成 `openapi.yml`/`routes.gen.ts`，ADR-023 build-time-fail 纪律），实现在 `service/auth.ts`（`AuthMixin`，与 `profileRename` 同一文件）：仅当账号存在生效处罚（`banned`/`bannedUntil` 未过期/`mutedUntil` 未过期）之一才允许提交，同一账号同时只能有一条 `open` 申诉（409）。**不经过 `rejectIfBanned`**——一个被封禁的账号必须仍能触达这个端点，否则申诉入口对最需要它的人反而不可用。
- metaserver 内部端点（`internal/accountRoutes.ts`，与 `/internal/accounts/:id/ban` 同款手写 fastify 路由，不走 openapi codegen）：`GET /internal/appeals`（状态筛选）+ `POST /internal/appeals/:id/resolve`（approved 清 `mutedUntil`/`bannedUntil`/`banned` 三个字段并 `accountCache.invalidateBanStatus`，复用 P3 同一失效方法；**不碰 `reputationScore`**，CM10 明确拍板——分数是否恢复留给 admin 另行人工调整）。
- `server/admin`：新增 `clients/appeals.ts`（`HttpAppealsClient`，代理 metaserver，与 anti-cheat review 队列同款"业务服务持有数据、admin 只代理"结构）+ `service/appeals.ts`（`AppealsMixin`）。新增能力 `appeals.view`/`appeals.action` + 审计动作 `appeal.review`。
- `tools/ops`：新增 `pages/appeals.ts`（列表 + `enforcementSnapshot` 详情列 + Approve/Deny，Approve 前二次确认弹窗）+ nav 项 `Player Appeals`。
- 客户端（`client/src/net/log.ts`/`render/AppealDialog.ts`/`app.ts`）：**未按 §5.3 原文字面实现**——原文设想的挂载点是"登录返回 ACCOUNT_BANNED / 发消息返回禁言错误时"逐个调用点弹窗，但项目里"发消息"分散在 DM/家族/世界三个不同 scene、各自手写 catch。改为在传输层单点拦截：`ApiClientBase.request`（metaserver）与 `WorldApiClient` 的请求辅助函数在识别到 `ACCOUNT_BANNED`/`ACCOUNT_MUTED` 错误码时统一调用 `maybePromptAppeal()`（`net/log.ts` 新增的 sink，与既有 `showToastMessage`/`setToastSink` 同一模式），`app.ts` 注册的 sink 把 `AppealDialog`（结构同 `ConsentDialog`/`ReconnectPromptDialog` 的自绘全屏卡片，复用同一 hidden-`<input>`文字输入技巧）直接挂到 `app.stage`（同 `GlobalToast` 的理由：不受 `SceneManager` 场景切换影响，玩家在任何场景触发禁言/封禁都不会被强制打断当前操作）。好处：任何现有或未来的调用点自动获得这个能力，不需要逐个 scene 接线；代价是没有走 `AppViews` 抽象（`GlobalToast` 本身也是同样的例外，非新先例）。
- `client/src/net/ApiClient/auth.ts` 新增 `submitAppeal(reason)`；`createAppCore.ts` 的 `AppCore.submitAppeal`（可选字段，离线/无 baseUrl 时为 `undefined`，sink 据此静默跳过）桥接到 `app.ts` 的渲染层。
- 三语言（zh/en/de）新增 `appeal.*` i18n key（title.banned/title.muted/body/placeholder/submit/cancel/submitted/err.empty/err.failed）。
- 与设计的差异：除上述客户端挂载点的调整外，无实质偏离。
- 验证：`metaserver/test/appeal.e2e.test.ts`（新增，8 例：无生效处罚拒绝/空理由拒绝/成功提交+快照/重复申诉 409/内部列表+鉴权/approve 清封禁并复测登录成功/deny 不改字段/404）；客户端 `npm run typecheck` + `vitest run`（842 个既有用例全绿，1 个无关 flaky 用例`net-client.test.ts`在完整套件下偶发超时，单独运行稳定通过）；dev server 冒烟：构建产物加载无报错（真实封禁/禁言账号触发申诉弹窗的交互走查因需起完整后端+人工封禁测试账号，超出本次收尾范围未做，记录为已知验证缺口）。
