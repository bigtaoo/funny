# Notebook Wars — 社交系统设计文档

> 创建：2026-06-16。本文件是社交系统（好友 / 私聊 / 邮件，及 SLG 上线后的帮会 / 国家频道）的设计基准。
> 配套阅读：`META_DESIGN.md`（系统/架构）、`SERVER_API.md`（接口契约）、`GATEWAY_DESIGN.md`（控制面网关 + `/gw/push`）、`COMMERCIAL_DESIGN.md`（邮件附件领奖复用其发货幂等）、`META_TASKS.md`（任务进度）。
> 拍板（2026-06-16，用户）：**持久化数据扩展 meta**（不新建 social 进程）；**第一期做好友 + 私聊 + 邮件全套**；帮会/家族/国家频道留 SLG 上线后。

---

## 0. TL;DR

- 社交系统 = **两场战斗之外的玩家间持久连接**：好友关系 / 私聊 / 邮件（一期），帮会 / 国家频道（SLG 后）。
- **零新基础设施落地一期**：持久数据进 meta 库（新集合），实时投递复用 gateway 已有的 `account→socket` 映射 + `/gw/push` 通道，客户端复用 `NetSession` 控制面连接。
- **职责切分**：**meta = 数据唯一权威**（好友边/请求/会话/消息/邮件，所有写操作经 meta）；**gateway = 在线态唯一真相 + 实时投递**（谁在线、推送消息）。两者经内部 HTTP 双向同步。
- **发送走 REST，接收走 push**：持久化动作（发消息/加好友/领邮件）= 客户端 REST 到 meta；实时事件（来消息/好友上下线/新邮件红点/好友申请）= meta→gateway `/gw/push`→client。gateway 保持「不连库」的薄连接层定位。
- **邮件附件领奖复用 commercial**：带奖励邮件领取走 commercial 扣/发 + `deliveredOrders` 幂等账本，运营补偿/活动发奖直接可用。
- **频道（SLG 后）= Redis 入场点**：群频道多对多扇出 + gateway 多实例路由，正是 `META_DESIGN §6.7 / M22` 那条「MQ 暂缓待 Redis 兼做」ADR 该兑现的里程碑。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| SOC1 | **社交持久数据扩展 meta**（好友/私聊/邮件集合加进 metaserver + `notebook_wars` 库），不新建 social 进程 | 好友/邮件与账号强耦合（meta 已拥有 accounts/saves），复用其 JWT/Mongo/乐观锁/openapi codegen，零新进程开销；与 economy 编排同模式。频道阶段再视情况拆 `social` 服务 |
| SOC2 | **gateway 是在线态唯一真相**：`account→socket` 映射即 presence，**不落库**；实时投递复用 `/gw/push`（meta 成为继 matchsvc 后第二个 push 调用方） | gateway 已为联机维护常驻 WS + 该映射，社交的好友/匹配/聊天本就是它的设计目标（M20）；presence 是易变的瞬时态，落库无意义 |
| SOC3 | **发送 = REST 到 meta（单一写者）；接收 = gateway push** | meta 是数据权威、写一处；gateway 保持薄连接层（不连库、只推）。回合制游戏聊天延迟不敏感，发送多一次 REST 往返可接受，换来边界清晰 |
| SOC4 | **私聊 1:1 用确定性会话 id**（`convId = min(a,b):max(a,b)`），会话文档持 `unread` 每人计数 + 末条摘要；消息单独集合，TTL 自动清理 | 会话 id 可由双方任一端推出、无需查表建会话；未读计数随消息原子 bump，离线红点天然落库 |
| SOC5 | **邮件 = 每收件人一份文档**（一期），附件领取经 commercial + 幂等 orderId；TTL 过期回收 | 早期玩家量小，fan-out 一份/人最简单（无模板+per-user-state 的联表）；附件领奖直接套 commercial `deliveredOrders` 不重不丢；玩家量大后再迁「系统邮件模板 + 领取状态分离」 |
| SOC6 | **拉黑是有向边**，屏蔽对方的好友申请 + 私聊；好友关系是**双向边**（accept 时建两条有向边） | 有向边让「我的好友列表」「我拉黑了谁」都是单字段索引点查，简单高效 |
| SOC7 | **频道（帮会/家族/国家）= 独立 `social` 服务 + Redis pub/sub**，SLG 上线后做 | 群频道是多对多扇出、跨 gateway 实例广播，必须 Redis；正好作为 Redis 的引入里程碑（M22）。一期不碰 |
| SOC8 | **社交数据不进 `SaveData`** | 好友/邮件/会话是按需查询的关系数据、非存档根；放 SaveData 会让每次同步背上无关负载。未读红点也走查询不走同步段 |
| SOC9 | **gateway 横扩 + Redis 路由是近期里程碑**（单 gateway 实例 ~3000 并发上限，用户 2026-06-16 拍）。`/gw/push` 与 presence 广播**从一开始就按「不假设单实例」设计**：内部 push 以 `accountId` 为目标、不依赖「目标连在本实例」；多实例时 meta→gateway 经 Redis 路由（`account→实例` 或频道 pub/sub），单实例期本地直投 | 联机玩家上规模后 gateway 必然多实例；契约层（push 消息形状）不变，仅 gateway 内部投递从「本地 map」升级为「Redis 路由」。提前定好接口不假设单实例，避免横扩时改契约。注意 §4.1 的 presence 广播在多实例下：好友可能连在别的实例，上下线广播需经 Redis fan-out |
| SOC10 | **敏感词过滤分国家/地区配置**（用户 2026-06-16 拍） | 不同地区合规要求不同；过滤器按 locale/region 加载词表（`shared` 侧可配置表，S6-2 落地），不写死单一词库 |

---

## 2. 数据归属与信任边界

延续 `META_DESIGN §2` 的信任边界，社交数据按以下归属：

| 类别 | 数据 | 谁权威 | 说明 |
|---|---|---|---|
| **meta 权威**（客户端只读，经 meta 端点改） | 好友边 / 好友申请 / 拉黑 / 会话 / 私聊消息 / 邮件 + 已读已领状态 | metaserver（`notebook_wars` 库） | 所有写操作经鉴权 REST；客户端不能伪造好友关系/已领状态 |
| **gateway 权威**（瞬时，不落库） | 在线态（`account→socket`） | gateway 内存 | 谁在线只在 gateway 进程内；任何服务查在线态经内部 HTTP `GET /internal/presence` |
| **commercial 权威** | 邮件附件实际发放（金币/物品） | commercial | 领奖经 meta 编排调 commercial，`deliveredOrders` 幂等（同 economy）|

- 反作弊取舍：私聊/好友被恶意刷 → 用限流（`RATE_LIMITED`）+ 好友数上限 + 拉黑兜底，不上重型校验。
- 敏感词治理：私聊文本一期做**发送端 meta 侧基础敏感词过滤**（替换/拒发），完整治理（举报、人工、分级）后置。
- 所有时间戳服务器盖（`META_DESIGN` 通则）。

---

## 3. 数据模型（meta `notebook_wars` 库新增集合）

> 形状写进 `server/shared/src/mongo.ts`（`Collections` 加字段 + `ensureIndexes` 加索引），风格同既有 `SaveDoc`/`AccountDoc`。

### 3.1 好友（SOC6）

```ts
// 有向好友边：双向好友 = 两条边。查「我的好友」按 owner 点查。
interface FriendEdgeDoc {
  _id: string;        // `${owner}:${friend}`（accountId）
  owner: string;
  friend: string;
  since: number;
  alias?: string;     // 备注名（owner 私有）
}
// index: { owner: 1 }

interface FriendRequestDoc {
  _id: string;        // uuid
  from: string;       // accountId
  to: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  message?: string;
  createdAt: number;
  resolvedAt?: number;
}
// index: { to: 1, status: 1 }（收件箱）, { from: 1, to: 1 }（去重/防重复申请）

interface BlockDoc {
  _id: string;        // `${owner}:${target}`
  owner: string;
  target: string;
  ts: number;
}
// index: { owner: 1 }
```

- **好友数上限** `FRIEND_CAP`（建议 100，放 `shared/social.ts` 单一来源），达上限申请/同意返回 `FRIEND_CAP_REACHED`。
- 加好友凭 `publicId`（9 位数字公开 id，已存在）搜索 → 发申请。**不暴露 accountId**（仅服务器内部）。

### 3.2 私聊（SOC4）

```ts
interface ConversationDoc {
  _id: string;                        // convId = `${min(a,b)}:${max(a,b)}`
  members: [string, string];          // accountId 对
  lastBody?: string;                  // 末条摘要（列表展示）
  lastFrom?: string;
  lastTs: number;
  unread: Record<string, number>;     // accountId → 未读数
}
// index: { members: 1, lastTs: -1 }（按参与者拉会话列表）

interface ChatMessageDoc {
  _id: string;                        // uuid
  convId: string;
  from: string;
  body: string;
  kind: 'text' | 'system';
  ts: number;
}
// index: { convId: 1, ts: -1 }（分页拉历史）
// TTL index: { ts: 1 } expireAfterSeconds = CHAT_RETENTION_SEC（建议 30 天）
```

- 发送：meta 校验「双方互为好友 且 未互相拉黑」→ 插消息 + bump 会话 `lastTs/lastBody` + 收件方 `unread+1`（单文档原子）→ push 收件方（在线时）。
- 已读：客户端打开会话 → `POST /chat/read { convId }` → `unread[me]=0`。

### 3.3 邮件（SOC5）

```ts
interface MailDoc {
  _id: string;                        // uuid
  to: string;                         // accountId（收件人；系统群发 = fan-out 多份）
  from: 'system' | string;           // 'system' 或发件人 accountId
  fromName?: string;                  // 展示名快照
  subject: string;
  body: string;
  attachments?: MailAttachment[];     // 奖励附件（可空）
  createdAt: number;
  expireAt: number;                   // TTL 自动回收
  readAt?: number;
  claimedAt?: number;
  claimOrderId?: string;              // 领取幂等（commercial orderId）
}
interface MailAttachment {
  kind: 'coins' | 'item' | 'skin';
  id?: string;                        // item/skin id
  count?: number;                     // coins/item 数量
}
// index: { to: 1, createdAt: -1 }（收件箱）
// TTL index: { expireAt: 1 } expireAfterSeconds = 0
```

- 领取附件：`POST /mail/{id}/claim` → meta 校验未领 → 经 commercial 发金币（`/internal/...`）+ 写 inventory 物品/皮肤（meta 库）→ 标 `claimedAt + claimOrderId`（幂等：重复领取靠 `deliveredOrders`/orderId 不重复发放）→ 回推权威 `SaveData`（钱包镜像/inventory）。
- 系统邮件（运营补偿、活动奖励、好友申请被接受通知等）= 后台/内部端点写一份/收件人。一期不做群发模板优化（SOC5）。

---

## 4. 实时投递机制（gateway push 扩展）

meta 成为 `/gw/push` 的第二个调用方（首个是 matchsvc）。新增 meta→gateway 内部 HTTP，与现有 `gateway internalHttp` 同鉴权（`X-Internal-Key`）。

### 4.1 在线态同步（presence）

gateway 不连库、不知好友关系；meta 不持长连接。两者经内部 HTTP 双向协作：

- **谁在线**（任意服务问 gateway）：`GET {gatewayInternalUrl}/gw/presence?accounts=a,b,c` → `{ [accountId]: boolean }`。meta 拉好友列表后用它标在线 flag。
- **上下线广播**（gateway → 通知该用户的在线好友）：玩家连上/断开时，gateway 调 meta `GET /internal/social/friends?accountId=` 取其好友列表（会话期缓存），向当前在线的好友 push `friend_presence{accountId, online}`；并给刚上线的玩家 push 一份其在线好友快照。
  - gateway 缓存好友列表，好友关系变更时 meta 调 gateway `POST /gw/social/invalidate {accountId}` 让其失效重拉。

### 4.2 新增 push 消息（`transport.proto` ServerMsg 扩展）

控制面复用 `transport.proto`（gateway 认得的层）。新增 oneof 分支（向后兼容，`npm run proto:gen` 双端重生）：

| 消息 | 触发 | payload |
|---|---|---|
| `friend_presence` | 好友上/下线 | `{ account_id, public_id, online }` |
| `friend_request` | 收到好友申请 | `{ request_id, from_public_id, from_name, message }` |
| `friend_update` | 申请被同意/好友被删 | `{ account_id, public_id, kind: ADDED\|REMOVED }` |
| `chat_message` | 收到私聊 | `{ conv_id, from_public_id, from_name, body, ts }` |
| `mail_new` | 收到新邮件 | `{ mail_id, has_attachment }` |

> push 走 gateway 据 `account→socket` 定向下发；离线则丢弃（数据已落库，下次登录拉取 + 未读红点）。

---

## 5. REST 端点（meta，`openapi.yml` 扩展）

> 以 `openapi.yml` 为机器契约单一来源；此处为人类可读摘要。统一 `ApiResp<T>` 包络 + Bearer JWT。

### 5.1 好友

```
GET    /friends                          → { friends: FriendView[] }      // 含在线态（meta 向 gateway 查 presence）
GET    /friends/requests                 → { incoming: ReqView[], outgoing: ReqView[] }
POST   /friends/search   { publicId }    → { profile: ProfileView } | NOT_FOUND
POST   /friends/request  { publicId, message? } → { requestId } | FRIEND_CAP_REACHED | ALREADY_FRIEND | BLOCKED
POST   /friends/respond  { requestId, accept } → { ok }                   // accept → 建双向边 + push 双方
DELETE /friends/{publicId}               → { ok }                         // 删好友（双向）
POST   /friends/block    { publicId }    → { ok }                         // 拉黑（删好友 + 屏蔽）
DELETE /friends/block/{publicId}         → { ok }
// FriendView = { publicId, displayName, online, rank?, alias? }
```

### 5.2 私聊

```
GET    /chat/conversations               → { conversations: ConvView[] }  // 列表 + 各自 unread
GET    /chat/{convId}/messages?before=<ts>&limit=  → { messages: MsgView[] }  // 分页历史
POST   /chat/send   { toPublicId, body } → { messageId, ts } | NOT_FRIEND | BLOCKED | RATE_LIMITED
POST   /chat/read   { convId }           → { ok }
```

### 5.3 邮件

```
GET    /mail                             → { mail: MailView[], unread: number }
POST   /mail/{id}/read                   → { ok }
POST   /mail/{id}/claim                  → { save: SaveData } | ALREADY_CLAIMED | NO_ATTACHMENT
DELETE /mail/{id}                        → { ok }
POST   /mail/send   { toPublicId, subject, body } → { mailId } | NOT_FRIEND   // 玩家间邮件（可选门控为好友）
```

### 5.4 内部端点（`X-Internal-Key`，不经 openapi glue）

```
# meta 提供给 gateway：
GET  /internal/social/friends?accountId=  → { friends: string[] }   // gateway 算 presence 广播范围
# gateway 提供给 meta（及任意服务）：
GET  /gw/presence?accounts=a,b,c          → { [accountId]: boolean }
POST /gw/push        { accountId, msg }    → { ok }                  // 已存在（matchsvc 用），meta 复用
POST /gw/social/invalidate { accountId }   → { ok }                  // 好友关系变更，让 gateway 缓存失效
```

新增错误码：`FRIEND_CAP_REACHED` / `ALREADY_FRIEND` / `NOT_FRIEND` / `BLOCKED` / `ALREADY_CLAIMED` / `NO_ATTACHMENT`。

---

## 6. 客户端

- **数据通道**：好友/聊天/邮件的发送与拉取走 `ApiClient`（新增方法，DTO 由 `openapi-typescript` 生成，同既有经济方法）；实时事件经 `NetSession` 的 gateway 控制面连接路由（`routeControl` 加 social 分支 → 抛 UI）。
- **UI（待 `UI_DESIGN.md` 细化，sketchUi 手绘风）**：
  - 大厅「社交」入口扩为多 Tab：好友 / 聊天 / 邮件（现有社交格进 RoomScene 的房间功能保留或并入）。
  - 好友列表（在线态点 + 段位 + 复用 `ProfilePopup` 看资料）、申请红点；搜索框输 publicId 加好友。
  - 会话列表 + 聊天窗（未读红点、历史上拉加载）。
  - 邮件箱（未读/附件标记、一键领取、领取动画复用奖励揭示）。
  - 顶部/底栏未读总红点：登录后拉一次 + push 增量更新。
- **离线**：未登录/纯本地无社交（社交本质需账号 + 服务器）；入口置灰提示登录，同 economy 门控。

---

## 7. SLG 后：帮会 / 家族 / 国家频道（SOC7，一期不做）

> 待 SLG 模式上线后展开，此处仅锚定方向，避免一期设计走偏。

- **新 `social` 服务**（独立进程，CJS，专属或共享库）：拥有帮会/家族成员关系、职位、申请、频道历史。玩家不可达，gateway 当门面（同 matchsvc 模式）或玩家经 meta REST。
- **群频道 = Redis pub/sub**：每个频道一个 Redis channel；玩家发言 → `social` 持久化 + `PUBLISH` → **每个 gateway 实例订阅** → 据本实例 `account→socket` 投递给在线成员。这解决 gateway 多实例下「成员分散在不同 gateway 进程」的扇出问题。
- **这是 Redis 的引入里程碑**（`META_DESIGN §6.7 / M22`）：Redis 同时兼做 gateway 横扩的 `account→gateway 实例` 路由（`/gw/push` 改 pub/sub）。一期单 gateway 实例 + 内存映射够用，不预先引入。
- 国家频道 = 超大频道，需考虑限流/分片/只读历史窗口；家族/帮会频道成员有限，直接 fan-out 即可。

---

## 8. 任务拆分（S6）

> 进度勾选随实现同步进 `META_TASKS.md`。一期 = S6-1~3（好友/私聊/邮件全套）。

| 任务 | 内容 | 依赖 |
|---|---|---|
| **S6-0 契约 + shared** | `shared/social.ts`（`FRIEND_CAP`/`CHAT_RETENTION_SEC` 等常量 + 视图类型）；`mongo.ts` 加 4 集合 + 索引 + TTL；`transport.proto` 加 5 个 social ServerMsg（双端重生）；`openapi.yml` 加好友/聊天/邮件端点 + 错误码 | — |
| **S6-1 好友** | meta：好友/申请/拉黑 service + REST + 内部端点；gateway：presence 广播（连/断时拉好友列表 + push `friend_presence`）+ `/gw/presence` + 缓存失效；客户端 `ApiClient` + `NetSession` 路由 + 好友 UI | S6-0 |
| **S6-2 私聊** | meta：会话/消息 service（好友校验 + 拉黑 + 敏感词 + 限流）+ REST + push；客户端聊天 UI（会话列表 + 窗口 + 历史分页 + 未读红点） | S6-1 |
| **S6-3 邮件** | meta：邮件 service + 附件领奖（编排 commercial + inventory + 幂等）+ REST + `mail_new` push；系统邮件内部写入端点；客户端邮件箱 UI + 领取 | S6-0（领奖依赖 commercial 已就绪 ✅） |
| **S6-4（SLG 后）频道** | `social` 服务 + Redis pub/sub + gateway 订阅投递 + 帮会/家族/国家频道数据模型与 UI | SLG 模式 + Redis |

### 验证方式（沿本仓约定）

- 服务端：`tsc -b` 六包 + meta/gateway 端到端测试（好友申请-同意建双向边、私聊好友校验/拉黑/未读、邮件领奖幂等、presence 上下线广播）。
- 客户端：`tsc --noEmit` + vitest + web 构建；UI 冒烟（`test/ui`）加好友/聊天/邮件场景。
- 不截图（用户自行浏览器验证）。
