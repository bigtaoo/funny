# Notebook Wars — 社交系统设计文档

> 创建：2026-06-16。本文件是社交系统（好友 / 私聊 / 邮件）的原始设计，**数据模型细节仍有效**，P2 迁移时参考。
> ⚠️ **架构已更新（2026-06-28）**：SOC1（"持久数据扩展 meta，不新建 social 进程"）已被推翻。新架构见 [`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md)（独立 socialsvc 第五公网面）；家族已从 worldsvc 迁出，好友/邮件将在 P2 期从 metaserver 迁出。
> 配套阅读：`META_DESIGN.md`（系统/架构）、`SERVER_API.md`（接口契约）、`GATEWAY_DESIGN.md`（控制面网关 + `/gw/push`）、`COMMERCIAL_DESIGN.md`（邮件附件领奖复用其发货幂等）、`META_TASKS.md`（任务进度）。

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
| SOC10 | **敏感词过滤分国家/地区配置**（用户 2026-06-16 拍） | 不同地区合规要求不同；过滤器按 locale/region 加载词表（`shared` 侧可配置表，S6-2 落地），不写死单一词库。✅ 已接通（2026-06-16）：`AccountDoc.region` 在 auth 时由 `Accept-Language` 头惰性推断并持久化（`regionFromAcceptLanguage`），私聊按**发送方账号 region** 选词表（`getRegion`→`censorChat`），零客户端/契约改动 |

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
- **删除守卫（2026-07-16）**：有附件且未领取（`attachments` 非空且 `claimedAt` 未设置）的邮件禁止删除，防止误删导致奖励永久丢失（删除直接 `deleteOne` 整份文档，含 `attachments`，无退回逻辑）。`DELETE /mail/{id}` 命中时返回 409 `MAIL_HAS_UNCLAIMED_ATTACHMENT`；已领取或本就无附件的邮件删除不受影响。客户端邮件详情页「删除」按钮在此状态下置灰，点击提示先领取附件。

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
DELETE /mail/{id}                        → { ok } | MAIL_HAS_UNCLAIMED_ATTACHMENT（有未领取附件，需先领取）
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
| **S6-1 好友** | ✅ 全部完成（2026-06-16）。**服务端 + 客户端 net 层**：meta `social.ts` service + 8 REST handler + `GET /internal/social/friends` + `GatewayClient.push/presence/invalidateFriends`；gateway presence 广播（连/断 `broadcastPresence` + 好友/publicId 缓存）+ `/gw/presence`·`/gw/social/invalidate` + 5 social ServerMsg 编码；客户端 `ApiClient` 8 方法 + `NetSession` 路由 5 push。meta 74 测试（+6 social-friends.e2e）。**好友 UI**：`scenes/FriendsScene.ts`（sketchUi 手绘风）——大厅社交格 → `onOpenSocial`/`goFriends`；好友列表（在线点 + 昵称 + #publicId + 段位，点行开 ProfilePopup）+ 收到的申请（接受/拒绝）+ 9 位数字键盘搜 publicId 加好友；列表拖拽滚动；`NetSession` 三个 social push 实时刷新（presence/request/update）。i18n `friends.*` 26 键全翻。client 168 单测 + UI 冒烟 34 + web 构建绿 | S6-0 |
| **S6-2 私聊** | ✅ 全部完成（2026-06-16）。**服务端**：`shared/chatFilter.ts`（分地区敏感词表 + `censorChat` 打码，SOC10）；meta `social.ts` 加 `sendMessage`（好友校验 + 拉黑优先 + 敏感词打码 + 会话 upsert/未读 +1）/`getConversations`/`getMessages`（成员校验 + 分页）/`markConversationRead`；`service.ts` 4 个 handler（getConversations/getMessages/sendChat/readChat）+ 进程内滑窗限流（`CHAT_SEND_RATE_PER_MIN`，429）+ chat_message push。meta +6 `social-chat.e2e`。**客户端**：`ApiClient` 4 方法；`FriendsScene` 扩为 **3 Tab（好友/聊天/邮件）**——聊天 Tab 会话列表（未读红点/角标）；新增 `ChatScene`（消息气泡 mine 右/peer 左 + 隐藏 `<input>` 撰写 + 历史分页「加载更早」+ 乐观发送 + 实时 push 追加）；**拉黑入口**进 `ProfilePopup`（好友卡加 发消息/拉黑 动作）。`NetSession` chat_message push → 路由到打开的 ChatScene 或 FriendsScene 刷新。i18n `chat.*`/`friends.tab.*`/`friends.message`/`friends.block` 全翻。**收尾（2026-06-16）**：敏感词由写死 `'global'` 改为按账号 region 选词表——`AccountDoc.region` + `regionFromAcceptLanguage`（auth 时 Accept-Language 推断持久化）+ `getRegion`（发送方），meta +3 social-chat.e2e（de/cn 打码、en 对 de-only 词不打码）。 | S6-1 |
| **S6-3 邮件** | ✅ 全部完成（2026-06-16）。**服务端**：commercial 加 `grant`（纯金币幂等发放 kind:'grant'）+ `/internal/grant` + meta `CommercialClient.grant`；meta `mail.ts`（getMail/readMail/deleteMail/claimMailAtomic/splitAttachments/sendPlayerMail/insertSystemMail）+ `economy.deliverMailGrant`（皮肤 set/物品 $inc/钱包镜像 + deliveredOrders 幂等）；`service.ts` 5 handler（getMail/readMail/claimMail/deleteMail/sendMail，claim 经 commercial 发币 + inventory，claimOrderId 幂等）+ mail_new push；`internal.ts` 系统邮件端点 `POST /internal/mail/system/{send,preview}`（dispatchKey 幂等，single/global fan-out，接 admin OPS 补偿工单）。meta +5 `social-mail.e2e`、commercial +1 grant。**客户端**：`ApiClient` 6 方法；`FriendsScene` 邮件 Tab（列表 + 未读点 + 附件标记）+ 邮件详情（已读/领取/删除，领取回推权威存档）。i18n `mail.*` 全翻。**收尾（2026-06-16）全服 fan-out 分批**：`mail.ts` 抽 `buildSystemMail` 共用 + 新增 `bulkInsertSystemMail`（每批 `MAIL_FANOUT_BATCH=500` 个 accountId 单次 unordered upsert `bulkWrite`，据 `upsertedIds` 仅对本批新插入者推 `mail_new`，dispatchKey 幂等不变）；`internal.ts` global 分支改游标累批 flush + push fire-and-forget。把逐账号 O(N) 次往返压成 O(N/批)。meta +1 social-mail.e2e（5 人 fan-out + 重发并新增 1 账号仅推新账号）。**收尾（2026-06-16）离线红点聚合**：`shared/social.ts` 加 `SocialBadges` 视图（`friendRequests`/`chat`/`mail`/`total`，点数语义：待处理收到的申请数 / 有未读的会话数 / 未读未过期邮件数）；meta `social.ts` 加 `socialBadges()`（三项 `countDocuments` 并行，不拉全量列表）+ `service.ts` `getSocialBadges` handler + `openapi.yml` `GET /social/badges`；客户端 `ApiClient.getSocialBadges`（`rest:gen` 重生 openapi.ts）。登录后一次性拉总红点，之后凭 social push 增量更新（SOC8）。meta +4 `social-badges.e2e`（初始全 0 / 三源各自加分 + total / 读会话邮件清零 / 401）。**待办**：百万级转「模板 + 领取状态分离」（SOC5）。**修复（2026-07-02）**：P2 迁移只切了读路径（`GET /mail`→代理 socialsvc），写路径 `insertSystemMail`/`bulkInsertSystemMail` 漏改，一直在写 meta 自己的死集合——补偿工单/赛季奖励/活动奖励/PvE 警告邮件全部有去无回。改为委托 `MetaSocialsvcClient` 真调 socialsvc 早已实现的 `/internal/mail/system{,/bulk}`；`admin/test/comp-mail.e2e.test.ts` 升级为真起 socialsvc 子进程联调，6 例全绿。详见 `claudedocs/server.md`。 | S6-0（领奖依赖 commercial 已就绪 ✅） |
| **S6 收尾：大厅总红点消费端 + 好友列表视口裁剪** | ✅ 完成（2026-06-16，纯客户端）。**①大厅总红点（SOC8 消费端，§6「顶部/底栏未读总红点」）**：`AppViews` 加 `LobbyView` 句柄（`applySocialBadge(total)`），`showLobby` 返回它；`LobbyScene` 社交 nav 格叠独立 `socialBadgeLayer`（红圈+白字，`>99` 显 `99+`），`applySocialBadge` 只重画该层 + `destroyed` 守卫；`createAppCore.goLobby` 捕获句柄 → 闭包缓存 `socialBadgeTotal` 即时上色（resize 不闪）→ `GET /social/badges`（best-effort）→ 在线时保持 gateway 连接并把 `friend_request`/`chat_message`/`mail_new`/`friend_update` push 接「重拉徽章」回调；resize 重显跳过重拉（`fromResize`）。**注**：登录用户在大厅常驻一条 gateway WS（presence + push 红点所需，符合 §6 设计）。**②好友列表视口裁剪**：`FriendsScene.rowVisible()` —— `drawList`/`drawChatList`/`drawMailList` 只构建可见区行（`cy`/`maxScroll` 仍逐行累加），把每次 render（drag-move ~60Hz 触发）的对象数从「全表 ~600–800」降到「可见窗口」，与列表长度无关；上限 100 无需完整对象池虚拟化。client tsc + 169 单测（+1 headless-nav）+ UI 冒烟 36 + web 构建绿 | S6-1/2/3 |
| **S6 收尾：family/sect hub 补社交导航栏 + 返回来源修复** | ✅ 完成（2026-07-09，纯客户端）。**问题**：`FriendsScene` 家族/宗门 tab 一旦已加入（`familyId`/`sectId` 存在）就同步调用 `openFamilyHub`/`openSectHub` 整场景跳转到 `FamilyScene`/`SectScene`（07-05 收窄二次确认的副作用，见 `orgForm.ts`），但这两个场景没有装订线左侧的 5 个 tab 竖排导航栏，视觉上「其他标签卡消失了」；`goFamilyHub`/`goSectHub`（`app/nav/world.ts`）的 `onBack` 也硬编码回 `goWorldMap`，不管 social 原本是从大厅还是世界地图打开的，返回都统一落回 SLG 世界地图。**修复**：新增共享绘制函数 `render/socialTabRail.ts`（`drawSocialTabRail`，`SocialTab` 类型），`FriendsScene`/`FamilyScene`（`renderMyFamily`）/`SectScene`（`renderMySect`）三处共用同一份 5-tab 竖排导航栏渲染，`SectScene` 主体内容同步让出左侧装订线余量（`marginLineX`）以免与导航栏重叠；`FamilySceneCallbacks`/`SectSceneCallbacks` 加 `onNavTab(tab)` 处理跨场景切 tab（沿用 `nav.goFriends({ defaultTab, onBack })` 或互相跳转 family↔sect）。**来源修复**：`goFamilyHub`/`goSectHub` 加可选 `onExit` 参数（默认回世界地图，向后兼容），`nav/social.ts` 的 `goFriends` 把内部 `onBack` 闭包（`backTo`，含 `restore()` 复位 gateway handler）一路透传给 `openFamilyHub`/`openSectHub`，使 family/sect hub 的返回目标始终对齐 social 最初的打开来源（大厅/世界地图/未来的其它入口），不再固定倒回 SLG。client tsc + web 构建绿；未跑截图（沿仓库约定不启动游戏截图，逻辑走读 + 类型检查验证）。 | S6-1（好友页 tab 栏）/ 家族宗门 S8-4/S8-4b |
| **S6 收尾：family/sect hub 页签仍会消失（07-09 那次只补了半个分支）** | ✅ 完成（2026-07-12，纯客户端）。**问题**：用户反馈「social 页面点击 sect 页签时，其他页签消失了」——07-09 那次修复把 `drawSocialTabRail()` 分别塞进了 `FamilyScene.renderMyFamily()`/`SectScene.renderMySect()`，但两个场景各自还有 `loading`/`noFamily`（或 `noSect`）/`create` 三种模式，只有真正已加入家族/宗门（`myFamily`/`mySect`）才会命中那个分支——账号还没建家族/宗门、或 `loadData()` 网络请求较慢时，页面停在 `noFamily`/`noSect`/`loading`，rail 完全不画，看起来其它 4 个页签又消失了。**修复**：把 `drawSocialTabRail()` 挪到 `FamilySceneBase`/`SectSceneBase`（`base.ts`）的公共 `render()` 分发方法里，在 switch 到具体 mode 之前无条件绘制一次，`renderMyFamily`/`renderMySect` 里原来那次重复调用删掉。**验证**：`tsc --noEmit` 绿；`test/ui/socialTabRail.ui.ts` 新增两个用例（`noFamily`/`noSect` 模式下其余 4 个页签仍可点击），用 `git stash` 临时撤掉修复确认这两个用例会失败，恢复后 7 个用例全绿；另外直接在真实运行的客户端里构造 `SectScene`（`noSect` 模式）截图核对，rail 确实显示。 | 07-09 那次的 S6 收尾 |
| **S6 收尾：社交返回目标疑似再次跑偏（07-12，排查中）** | 🔍 排查中（2026-07-12）。**问题**：用户反馈「大厅点社交图标进 FriendsScene，点返回，落到了『生涯』（StatsScene）而不是大厅」，且自述偶发、账号已加入家族。**已排除**：走读 `nav/social.ts`/`nav/world.ts`/`nav/lobby.ts` 全部 `goFriends`/`goChat`/`goFamilyHub`/`goSectHub` 调用点，`backTo`/`onExit` 解析链条中没有任何分支会落到 `nav.goStats()`；在真实运行的客户端里挂临时 debug hook（`__NW_NAV`/`__NW_MGR`）+ 真实指针事件模拟「大厅点社交格 → FriendsScene → 点返回」全链路，实测正确落回 `LobbyScene`，未能复现。**当前动作**：未改行为，只在 `nav/social.ts`（`goFriends`/`backTo`/`openFamilyHub`/`openSectHub`）、`nav/world.ts`（`goFamilyHub`/`goSectHub`/`onNavTab`）、`FriendsScene/base.ts`（`onBack`）打上 `netLog('nav-social'|'nav-world'|'nav-friendsscene')` 诊断日志（console 可见 + 落 client log ring buffer），标注 TEMP 待确认根因后删除；等用户下次实际复现时用浏览器控制台日志定位具体分支。 | S6 收尾（07-09/07-12 两次返回来源修复的后续） |
| **S6 收尾：FamilyScene 布局改版（成员/频道分屏 + 信息条）** | ✅ 完成（2026-07-13，纯客户端）。**问题**：用户反馈家族页 Members/Channel 用 tab 切换，家族刚建、人少或没聊天记录时，选中的那个 tab 大片空白；且顶部完全没有家族名/TAG/繁荣度/成员数，只有通用「Family」标题。**参考同类手游**（万国觉醒/Lords Mobile 等 SLG 联盟界面）确认横屏下常见做法是成员名册+聊天频道常驻分栏，不用 tab 切换。**方案**：①新增信息条（`renderInfoBand`）——`[TAG] 名字`/成员数`x/FAMILY_CAP`一行，繁荣度另起一行，公告再一行（长名超宽会截断加省略号，避免与右侧成员数碰撞，`truncateToWidth`）；成员列表末尾追加"还有 N 个空位"提示，把空余名额变成信息而非纯留白（不隐含尚不存在的"邀请"功能）。②横屏：`renderSplitView` 让成员名册（42% 宽）与家族频道常驻分栏同时可见，各自独立滚动（`scrollY`/`scrollYChannel`，`base.ts` 按 `x` 落点或 `activeTab` 路由拖拽）；竖屏保留原 tab 切换（`renderTabbedView`，无宽度可分）。频道列表新增空状态提示（"暂无消息"），因为分屏后频道默认可见，不再是"切进去才看到"。**顺带修复的真实 bug**：`data.ts` 的 `applyFamily()` 是 `async`（内部 await 拉频道消息），但 `loadData()`/`loadMyFamily()` 调用时都没加 `await`，导致 `render()` 可能在频道消息到达前就执行——竖屏 tab 模式下不易察觉（用户切到 Channel tab 时数据往往已经到了），分屏后两栏同时首绘，问题当场暴露（频道栏永远显示"暂无消息"）；补上 `await` 修复。**验证**：`tsc --noEmit` 绿；debug-hook 截图法（`__NW_DEBUG` 临时挂 `{app,PIXI,FamilyScene}`，构造假 `worldApi` 直接渲染真实场景）核对空/满成员、有/无聊天、竖屏 tab、超长名截断均正确；新增 `test/ui/familySceneSplitView.ui.ts`（8 例：数据加载时序回归、分屏双栏同显、独立滚动、竖屏 tab 切换、长名截断/不截断）；`test:ui` 全量 20 文件 255 例、`test` 全量 77 文件 598 例均绿。 | S6-1（好友页 tab 栏）/ 家族宗门 S8-4/S8-4b |
| **S6-4（SLG 后）频道** | `social` 服务 + Redis pub/sub + gateway 订阅投递 + 帮会/家族/国家频道数据模型与 UI | SLG 模式 + Redis |
| **S6 收尾：sect 页签可见性收紧 + 建门繁荣度门槛移除（2026-07-13）** | ✅ 完成（客户端+服务端）。**页签**：`FriendsScene`/`FamilyScene`/`SectScene` 共用的 `drawSocialTabRail()` 新增 `hidden` 形参——非家族族长且家族未加入任何帮会时不再显示 sect 页签（此前点进去只会看到「非族长/无家族」提示或一个必然 `NO_PERMISSION` 的失效「加入」按钮，属死路 UX）。**建门门槛**：`sectService.createSect` 移除繁荣度前置校验（`SECT_FOUND_PROSPERITY_MIN`/`PROSPERITY_TOO_LOW`），任何家族族长任何时候都可自行创建帮会，仅保留 `SECT_CREATE_COST` 扣费 + 族长身份 + tag 唯一性校验；详见 `SLG_DESIGN_LOG.md` §17.4。 | S6 收尾（07-09/07-12 rail 系列修复的后续） |
| **S6 收尾：世界频道打开后 loading 卡十几秒（2026-07-14）** | ✅ 完成（纯客户端）。**问题**：用户反馈打开「世界聊天」总要转圈十几秒才出内容。**根因**：`FriendsScene` 世界 tab 把消息列表的展示门槛错误地挂在 `slgLoaded`（家族/宗门状态）上——聊天记录本身早就拉回来了，也会被这个跟聊天毫无关系的门槛卡住不显示；而 `loadSLGStatus()` 内部又是「先等 `ensureWorldId()`（季节查询 + 分片解析，worldsvc）、再等 `getMyFamily()`（socialsvc）」的串行链，其中季节查询失败会被静默 `.catch()` 吞掉降级、白吃满 10s 默认超时。三处一起把「世界聊天」的可见延迟拖到十几秒，尽管聊天本身（`/nation/channel`）、家族（`/social/family/mine`，socialsvc）压根不依赖 SLG 世界/赛季概念。**修复**：①`FriendsScene/worldChat.ts` 的 `drawWorldTab()` 不再检查 `slgLoaded`/`slgStatus`，只看自己的 `worldLoaded`；`base.ts` 的 `switchTab()` 切到 world tab 时也不再顺带触发 `loadSLGStatus()`（聊天自身的 worldId 解析已在 `loadWorldChat`/`sendWorldChat` 内部透明完成）。②`nav/social.ts` 的 `loadSLGStatus()` 把 `ensureWorldId()` 与 `getMyFamily()` 从串行改 `Promise.all` 并发（`getMyFamily()` 走 socialsvc、从不依赖 worldId）。③`getActiveSeason()` 加超时形参、`ensureWorldId()` 调用时传 4s（该调用有安全兜底 `FALLBACK_SEASON`，不该占满默认 10s）且失败改 `console.warn` 而非静默吞掉。**验证**：`tsc --noEmit` + `test`/`test:ui` 全量绿；新增 `test/social-world-status-parallel-fetch.test.ts`（用 stash 临时撤掉并发修复验证过会死锁超时，证明测试真的会抓到回归）+ `test/ui/worldChatSlgDecoupling.ui.ts`（3 例：world tab 在 `loadSLGStatus` 永不 resolve 时仍正常出消息 / 切 world tab 不再触发 `loadSLGStatus` / 切 family tab 仍会触发）。**顺带发现未修的另一个 bug**：经 `defaultTab: 'world'`（世界地图聊天按钮走的入口，`nav/world.ts` `onOpenChat`）进入时，构造函数只是直接赋值 `this.tab`，从未调用过 `loadWorldMessages()`（只有手动点 tab 走 `switchTab()` 才会触发）——这条入口的世界聊天会一直卡在 loading。已作为独立任务拆出，未在本次改动。 | S6-4 |
| **S6 收尾：FamilyScene 布局二次改版（顶栏承载身份 + 成员卡 + 离队入行）（2026-07-14）** | ✅ 完成（纯客户端）。**用户 9 项诉求**：①成员列表每个成员加背景；②`Leader`/`Elder`/`Member` 角色标签放到成员名字右侧（原来叠在名字上方）；③家族名 `[TAG] 名字` 放到顶栏「Family」标题之后；④繁荣度放到顶栏、家族名之后；⑤成员数放到顶栏最右；⑥聊天输入框无法输入；⑦去掉底栏 Sect 按钮；⑧Leave/Dissolve 放到（我自己那行）成员名字最右；⑨族长在家族还有其他成员时不能离队，只有当只剩自己时才出现「解散家族」。**实现**：`base.ts` `renderHeader()` 改为只画共享头部的 bar 底 + 返回按钮（`drawSceneHeader(..., null)`），标题与家族身份由新方法 `drawHeaderTitle()` 现画——横屏时「Family + [TAG] 名字 + ⭐繁荣度」左簇、「成员数 x/CAP」右锚（`headerExtras` 每次销毁重建，避免滚动重绘时 Text 叠加泄漏）；竖屏太窄放不下，身份仍留在头下信息条（`infoBandH` 横屏仅在有公告时给一小条，否则 0；`renderInfoBand` 横屏只画公告）。`render.ts` `renderMembers()`：每行加 `sketchPanel` 卡片背景（本人行 tint 更暖），角色标签移到名字右侧同基线，名字截断预留角色标签宽度；`renderBottomBar()` 整个删除（Sect 入口移除；Sect hub 仍可经左侧 rail 的 sect 页签 `onNavTab` 到达），Leave/Dissolve 改画在「我自己」那行最右——族长仅在独自一人时出现红色「Dissolve Family」，其余人出现「Leave Family」，族长有其他成员时两者都不画。`input.ts`/`actions.ts`：聊天输入框修复——新增 `sendText` 镜像隐藏 input 的值，`openSendInput()` 监听 `input` 事件回写 `sendText` 并 `render()`，输入框用 `caretDisplay()` 显示已输入文本 + 闪烁光标（聚焦时描边高亮），此前一直停在占位符、打字像没反应。**验证**：`tsc --noEmit`（含 test config）绿；`test/ui/familySceneSplitView.ui.ts` 更新（身份挪到 header 容器、成员卡/角色/离队按钮、`Members x/CAP` 右锚不与左簇碰撞的数值断言）12 例全绿 + caretRegression/socialTabRail/familyHubNavRace/familySendButton 全绿；debug-hook 截图法（`__NW_DEBUG` 临时挂 `{app,PIXI,FamilyScene,createLayout,InputManager}`，注意 landscape 下 `createLayout` 把设计空间拉到 1920×1080、渲染器需按设计尺寸 resize 否则右侧被裁）核对：3 人族（顶栏身份齐全、族长有成员时无离队钮）、独身族长（本人行最右「Dissolve Family」）、输入框显示「hello family|」草稿三种情形均正确。 | 07-13 那次分屏改版的后续 |
| **S6 收尾：世界地图聊天快捷入口卡死 loading（2026-07-14）** | ✅ 完成（纯客户端）。**问题**：07-14 那次「世界聊天 loading 10+s」修复时发现但未处理的遗留 bug——世界地图右上角聊天快捷按钮（`nav/world.ts` `onOpenChat` → `nav.goFriends({ defaultTab: 'world' })`）走的是 `FriendsSceneBase` 构造函数直接赋值 `this.tab = cb.defaultTab`，从不经过 `switchTab()`，因此从未调用 `loadWorldMessages()`，聊天 tab 永远卡在 loading；只有手动点击世界聊天页签（走 `switchTab()`）才会加载。**修复**：把 `switchTab()` 里触发 `loadSLGStatus()`/`loadWorldMessages()` 的逻辑抽成 `triggerTabLoads(tab)`（`base.ts`），构造函数和 `switchTab()` 共用同一份，避免两条入口路径再次分叉。**验证**：`tsc --noEmit` 绿；新增 `test/ui/worldChatDefaultTabLoad.ui.ts`（以 `defaultTab: 'world'` 直接构造场景，断言 `loadWorldChat` 被调用且 `worldLoaded` 变 true，不显式调用 `switchTab()`）；`test:ui` 全量 25 文件 278 例绿。 | 世界聊天 loading 延迟修复（07-14）的遗留任务 |
| **S6 收尾：创建帮会表单改版（居中卡片）（2026-07-15）** | ✅ 完成（纯客户端）。**问题**：用户截图反馈 `SectScene` 的创建帮会（`create` 模式）表单排版错乱——`renderCreate()` 用绝对坐标 `x=20/x=100` 起排，完全没像其他模式那样从 `railW` 之后偏移，导致「Sect Name/Tag 输入框」与左侧社交 rail（Friends/Family/Sect/World/Mail）及头部标题层叠重合；字段全是 13px 挤在头部顶边；Tag 的长标签「Tag (2-5 uppercase...)」溢出盖住输入框；OK/Cancel 两个小按钮孤零零飘在屏幕正中、取消还是个 `×` 图标。**方案**：整个表单收进一张 `sketchPanel` 居中卡片，水平/垂直居中于 rail 右侧区间（`left = railW`），卡片高度按内容累加、横竖屏均自适应；字号对齐 `noSect` 放大风格（标题 24px、label 18px、输入内容 20px）；输入框高 32→48；Tag 约束拆成短 label「Tag」+ 下方 12px 灰字提示（新增 i18n `sect.tagLabel`/`sect.tagHint`/`sect.createTitle` 三键 zh/en/de）；「创建」（深底）+「取消」两按钮 150×48 居中并排在字段正下方（× 图标改回文字 `social.sect.cancel`）；名称框空时显示灰色 placeholder。**验证**：`tsc --noEmit` 绿；数值几何校验（landscape 1920/拉伸 2400、portrait 1080：卡片在 rail 右侧、不越界、字段与两按钮均在卡片内边距内）；debug-hook 离屏渲染截图法（`__NW_app` 临时挂 `PixiAppViews`，`Proxy` 桩 `worldApi` 直接 `new SectScene` 强制 `mode='create'` 渲染 `container` 到 RenderTexture，POST 本地 collector 落盘）核对居中卡片布局正确，钩子已从 `app.ts` 完全移除。 | 07-13 sect 页签/建门门槛系列的后续 |
| **S6 收尾：noSect 页显示建门花费 + 余额不足禁用（2026-07-16）** | ✅ 完成（纯客户端）。**问题**：用户反馈 `SectScene` 的 `noSect` 页只写「Costs coins; must be a family leader」这种不带数字的提示，「创建帮会」按钮永远可点——余额不够点了才靠服务端 `INSUFFICIENT_FUNDS` 报错兜底，体验差。**方案**：`sect.createHint` 改为 `Costs {n} coins; must be a family leader`（zh/en/de 三语），`n` 直接读 `SECT_CREATE_COST`（`@nw/shared`，与服务端 `sectService.createSect` 扣费同一常量，不会读出两个数）；`SectSceneCallbacks` 新增 `getCoins(): number`（world.ts `goSectHub` 接 `saveManager.get().wallet.coins`），`renderNoSect()` 据此算 `canAffordCreate` 传给 `addCenterButton` 新增的 `enabled` 形参——不够钱时按钮变灰（`C.btnOff`/`C.mid`）且不注册 `hitRects`，杜绝误触发请求。**扣费联动**：`createSect` 的 `SECT_CREATE_COST` 扣费发生在服务端 commercial（响应体只有 `SectDetailView`，不带钱包），客户端本地 `wallet.coins` 缓存不会自动更新——新增 `SectSceneCallbacks.refreshWallet()`（`world.ts` 接 `saveManager.refresh()`），`doCreate()` 建门成功后调用一次，把服务端扣费同步回本地余额缓存（HUD 显示才准）。**验证**：`tsc --noEmit` 绿；新增 `test/ui/sectCreateCost.ui.ts`（5 例：`noSect` 页渲染带数字的花费提示；够钱时按钮有 hitRect / 不够钱时没有；`doCreate()` 走完 `createSect` 后必调 `refreshWallet()`；表单字段无效时两者都不应被调用，验证「扣费」这一步确实被测到）；受影响的既有 UI 测试（`scenes.ui.ts`/`scrollDragThrottle.ui.ts`/`socialTabRail.ui.ts`/`caretRegression.ui.ts`）补上新增的 `getCoins`/`refreshWallet` 回调后全绿；未截图（本机浏览器 Preview 面板此次撞上 canvas 渲染卡死的已知问题 + `app.ts` 被同仓另一并发会话实时改动，未能安全挂临时 debug hook，仅靠 headless PIXI 单测核对渲染/点击逻辑）。 | 07-15 创建帮会表单改版的后续 |
| **S6 收尾：创建帮会表单整体放大 1.3×（2026-07-17）** | ✅ 完成（纯客户端）。用户反馈创建帮会卡片偏小。`renderCreate()` 引入缩放系数 `S = 1.3`，把卡片宽/内边距、各字段高、tag 框宽、按钮尺寸、全部文字字号（`FS.label/body/bodyLg/tiny`）与文字偏移统一乘以 `S`；hitRects 复用同一批计算值故点击判定同步放大不错位；卡片上限宽 `availW*0.82`→`0.9` 防放大后越界。顺带向用户说明 tag 用途——宗门短标识码（クラン tag），列表/频道/结盟弹窗等处以 `[TAG] 名字` 前缀显示。`tsc --noEmit` 绿。 | 07-16 建门花费提示的后续 |

### 验证方式（沿本仓约定）

- 服务端：`tsc -b` 六包 + meta/gateway 端到端测试（好友申请-同意建双向边、私聊好友校验/拉黑/未读、邮件领奖幂等、presence 上下线广播）。
- 客户端：`tsc --noEmit` + vitest + web 构建；UI 冒烟（`test/ui`）加好友/聊天/邮件场景。
- 不截图（用户自行浏览器验证）。
