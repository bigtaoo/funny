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
| SOC9 | **gateway 横扩 + Redis 路由是近期里程碑**（单 gateway 实例 ~3000 并发上限，用户 2026-06-16 拍）。`/gw/push` 与 presence 广播**从一开始就按「不假设单实例」设计**：内部 push 以 `accountId` 为目标、不依赖「目标连在本实例」；多实例时 meta→gateway 经 Redis 路由（`account→实例` 或频道 pub/sub），单实例期本地直投 | 联机玩家上规模后 gateway 必然多实例；契约层（push 消息形状）不变，仅 gateway 内部投递从「本地 map」升级为「Redis 路由」。提前定好接口不假设单实例，避免横扩时改契约。注意 §4.1 的 presence 广播在多实例下：好友可能连在别的实例，上下线广播需经 Redis fan-out。**2026-07-27 补完**：`gateway.presenceOf`（meta 拉好友列表在线标记用的批量查询，非 §4.1 的实时广播）此前一直只读本实例 `conns`，多实例下会漏报连在别的实例上的账号——现改为本地未命中时才查 Redis（每账号一个 TTL key，`markOnline`/`markOffline`/`refreshOnline` 挂在 onConnection/close/心跳 sweep 上，复用既有 `NW_GW_REDIS_URL` 连接，不新开一路）。`broadcastPresence`（好友上下线实时推送）本身仍是纯本地投递，未在本轮改动范围内 |
| SOC10 | **敏感词过滤分国家/地区配置**（用户 2026-06-16 拍） | 不同地区合规要求不同；过滤器按 locale/region 加载词表（`shared` 侧可配置表，S6-2 落地），不写死单一词库。✅ 已接通（2026-06-16）：`AccountDoc.region` 在 auth 时由 `Accept-Language` 头惰性推断并持久化（`regionFromAcceptLanguage`），私聊按**发送方账号 region** 选词表（`getRegion`→`censorChat`），零客户端/契约改动。⚠️ 2026-07-29 起，敏感词/举报/处罚/审核治理的后续演进权威已迁移至 [`CONTENT_MODERATION_DESIGN.md`](CONTENT_MODERATION_DESIGN.md)（ADR-057），本行保留历史记录不再更新 |

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
  - **软溢出竞态修复（2026-08-04）**：`respondFriend` 原先的 cap 校验是「读一次 `friendEdges` 的 `countDocuments`，再单独一次好友边 insert」，两步之间没有任何原子性——同一账号如果有两条不同的待处理入群请求（分别来自不同好友）几乎同时被接受，两次调用都可能在对方写入落地前读到同一个未过上限的旧计数，双双通过检查、双双插入，导致真实好友数突破上限。**修复**：新增专属维护型计数器集合 `friendCounts`（`_id`=accountId, `count`），镜像家族系统的 `FamilyDoc.memberCount` 思路——`tryClaimFriendSlot()` 把「判断未满 + 计数 +1」折进同一次 `updateOne({_id, count:{$lt:FRIEND_CAP}}, {$inc:{count:1}})` 原子操作，两个并发调用中只有一个能真正匹配过滤器成功递增。计数器**首次接触时懒惰启动**（`ensureFriendCounter`，从真实 `friendEdges` 现算一次 `countDocuments` 作为种子值），不需要迁移脚本——早于本次修复就已存在真实好友边的老账号，第一次被这条代码路径命中时会自动补上准确的历史计数，做法与 `equipmentInvCount`/`cardInvCount` 的「读时自愈」同一思路。`respondFriend` 的接受分支现按序原子认领双方槽位（先认领接受者自己的，再认领对方的）；若对方槽位认领失败，回滚接受者自己刚认领的槽位（`releaseFriendSlot`），不留下"计数已加但友谊从未成立"的孤儿递增。`removeFriend` 对称释放双方槽位（仅当边确实存在时才释放，避免对已经不是好友的重复调用误减到负数）。**顺带修的相邻 bug**：接受请求时，"请求状态翻转为 accepted"这个原子认领（用于防止同一请求被并发重复处理）原先发生在 cap 校验**之前**——即使没有并发竞态，单纯"账号已在 100 好友上限时接受一条请求"这种确定性场景下，请求也会被永久标记为 accepted 却从未真正成为好友，请求本身悄悄消失。修复后 cap 校验失败时把请求状态**还原为 pending**，接受者可以在腾出名额后重新处理。回归测试见 `server/socialsvc/test/friend.e2e.test.ts`（并发双接受不突破上限、对方满员时己方槽位正确回滚、请求还原为 pending 不丢失、`removeFriend` 正确释放槽位且幂等不减到负数）。
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
  - 家族成员列表（FamilyScene）点击成员名同样弹出 `ProfilePopup`，非本人行带「加为好友」action（2026-07-19）；已是好友则不再显示该 action（先拉一次好友 publicId 集合缓存在场景内）。卡片放大一倍（420×360 → 840×720 上限），新增家族/帮会两行（家族场景固定为「我的家族/帮会」）与段位行（弹出即显示已知信息，段位异步补：新增 `GET /social/player/:accountId/rank` 转发 metaserver 既有 `/internal/player`）。世界频道点头像同理补上称号/家族/帮会（此前只传了昵称+ID）。另修复了 Close/加好友按钮点击无效——`ProfilePopup` 本身用真实 PIXI 事件响应点击，但宿主场景（Family/Friends/GameRenderer/Room）走自研 `InputManager` 手动命中测试并在弹层打开时整体吞掉输入，两者能否可靠共存未经验证；`ProfilePopup.handleTap(x,y)` 提供手动命中测试兜底，FamilyScene/FriendsScene 的 `handleUp` 在弹层打开时改为调用它（与原生事件谁先触发都安全——先动的一方把 `open`/`visible` 置为 false，另一方读到的已是新状态而变成空操作）（2026-07-20）。
  - **资料卡统一改造（2026-07-23）**：用户反馈同一张 `ProfilePopup` 在好友列表/家族成员/世界频道三处打开显示的字段不一致（有的有 ELO 无家族，有的有家族无发消息），且家族/帮会行漏更新 `yBottom` 导致按钮文字与该行重叠。修复：①`ProfilePopup.show()` 内部自带一次 `fetchExtra(publicId)`（新 `GET /social/profile/:publicId/extra`，socialsvc 用 `resolveByPublicId`+`getPlayerRank`+`familySvc.getMember` 拼出 `{rank?,elo?,familyName?,sectName?}`），秒开已知字段、异步补齐剩余字段并重绘（`showToken` 守卫过期请求）——调用方不再各自穿一份 rank/elo/family/sect 字段（好友列表/家族成员/世界频道三处都删掉了手动传参，家族场景原有的手动异步 `getPlayerRank` 也删了，改用同一条路径）。②操作行统一为「已是好友→发消息，否则→加好友」（家族/世界频道原来漏了已是好友时的发消息分支）；世界频道加了 `FriendsSceneCallbacks.myPublicId`（判断是否点了自己）。③补上家族/帮会行漏的 `yBottom` 更新。④战斗相关入口（房间等待/对战中头像/结算页对手）过去完全没传家族/ELO——因为走 matchsvc/gameserver 都不连库——现在改为直接从客户端打 socialsvc（新建一个轻量 `WorldApiClient` 实例，构造只包 `platform.storage`，不连库也不需要），不再需要额外数据链路，同样接上了 `fetchExtra`。
  - 会话列表 + 聊天窗（未读红点、历史上拉加载）。聊天窗（`ChatScene`）内所有内容须落在红色装订线右侧：对方气泡左对齐边缘、底部输入框左边缘都从 `marginLineX(w)+w*0.02` 起（此前用 `w*0.04`，压在装订线左侧页边距里），自己的气泡与 Send 按钮仍右对齐（2026-07-22）。
  - 邮件箱（未读/附件标记、一键领取、领取动画复用奖励揭示）。附件详情除名称文字列表外，另在下方横排一行图片（每件附件一张），复用 Equipment/Auction/Gacha 同一套图标解析（`buildEquipIcon`/卡图/`buildMaterialIcon`/`buildIcon`），未知种类落到通用图标兜底（2026-07-20）。
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
| **S6 收尾：family/sect hub 补社交导航栏 + 返回来源修复** | ✅ 完成（2026-07-09，纯客户端）。**问题**：`FriendsScene` 家族/宗门 tab 一旦已加入（`familyId`/`sectId` 存在）就同步调用 `openFamilyHub`/`openSectHub` 整场景跳转到 `FamilyScene`/`SectScene`（07-05 收窄二次确认的副作用，见 `orgForm.ts`），但这两个场景没有装订线左侧的 5 个 tab 竖排导航栏，视觉上「其他标签卡消失了」；`goFamilyHub`/`goSectHub`（`app/nav/world.ts`）的 `onBack` 也硬编码回 `goWorldMap`，不管 social 原本是从大厅还是世界地图打开的，返回都统一落回 SLG 世界地图。**修复**：新增共享绘制函数 `ui/widgets/socialTabRail.ts`（`drawSocialTabRail`，`SocialTab` 类型），`FriendsScene`/`FamilyScene`（`renderMyFamily`）/`SectScene`（`renderMySect`）三处共用同一份 5-tab 竖排导航栏渲染，`SectScene` 主体内容同步让出左侧装订线余量（`marginLineX`）以免与导航栏重叠；`FamilySceneCallbacks`/`SectSceneCallbacks` 加 `onNavTab(tab)` 处理跨场景切 tab（沿用 `nav.goFriends({ defaultTab, onBack })` 或互相跳转 family↔sect）。**来源修复**：`goFamilyHub`/`goSectHub` 加可选 `onExit` 参数（默认回世界地图，向后兼容），`nav/social.ts` 的 `goFriends` 把内部 `onBack` 闭包（`backTo`，含 `restore()` 复位 gateway handler）一路透传给 `openFamilyHub`/`openSectHub`，使 family/sect hub 的返回目标始终对齐 social 最初的打开来源（大厅/世界地图/未来的其它入口），不再固定倒回 SLG。client tsc + web 构建绿；未跑截图（沿仓库约定不启动游戏截图，逻辑走读 + 类型检查验证）。 | S6-1（好友页 tab 栏）/ 家族宗门 S8-4/S8-4b |
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
| **S6 收尾：世界频道加载失败后永久卡死 loading（2026-07-18）** | ✅ 完成（纯客户端）。**问题**：账号 tao1 线上环境反馈打开「世界」页签转圈半分钟不出内容。**排查**：SSH 上生产 VPS 核对 `worldsvc`/`socialsvc`/`gateway`/`metaserver` 四个容器均健康在线、CPU<2%、日志无报错，排除服务端过载/崩溃。**根因**：`FriendsScene/service.ts` 的 `loadWorldMessages()` 请求失败（`loadWorldChat()` 内部串联 `getActiveSeason`→`resolveSeason`→`getWorldChannel`，最坏情况累计可达约 24s 超时）时只有一句 `catch { /* keep existing */ }`，`worldLoaded` 永远停在 `false`，且没有重试也没有错误提示——`worldChat.ts` 的 `drawWorldTab()` 只要 `!worldLoaded` 就无条件显示"Loading…"，于是一次性网络抖动就会让这个 tab 永久转圈，除非玩家整页刷新。**修复**：`base.ts` 新增 `worldLoading`/`worldLoadError` 两个状态位；`service.ts` `loadWorldMessages()` 失败时置 `worldLoadError=true`（并发生 loading 期间不再重入）；`worldChat.ts` `drawWorldTab()` 新增错误分支——`worldLoadError` 时显示 `social.world.loadFail` 文案 + 「重试」按钮（`friends.retry`），点击重新调用 `loadWorldMessages()`。i18n 三语新增 `friends.retry`/`social.world.loadFail`。**验证**：`tsc --noEmit` + webpack 构建绿；新增 `test/ui/worldChatLoadError.ui.ts`（失败后 `worldLoadError=true`/`worldLoaded=false`，`loadWorldMessages()` 重试后恢复正常）；`test:ui` 全量 67 文件 632 例绿（未改动其余 631 例判定，无回归）。 | 07-14 世界聊天 loading 延迟修复系列的后续 |
| **S6 收尾：SectScene 布局分屏改版（对齐 FamilyScene 两屏）（2026-07-17）** | ✅ 完成（纯客户端）。**问题**：用户截图反馈宗门页 `mySect` 仍用 Families/Sect Channel 两个 tab 切换，家族少、没聊天记录时选中那半屏大片空白，另一半只是个惰性 tab——与家族页 07-13 已改的常驻分屏不一致。**方案**：完全照搬 `FamilyScene` 的 split/tabbed 分流。`render.ts` `renderMySect()` 按 `landscape` 分流到新增的 `renderSplitView()`（横屏，成员家族名册 50% 宽 + 宗门频道常驻分栏同时可见，中间分隔线、顶部一行宗门信息 `[TAG] 名字 · N families · 繁荣度` + 可选除名投票横幅、底部全宽操作栏 dissolve/ally/manageAllies 或 leave）或 `renderTabbedView()`（竖屏保留原 tab）；把家族列表体抽成可传 `x0/colW/scrollKey` 的 `renderFamiliesList()`，`renderChannel()` 同样参数化——两者都能作整宽（竖屏 tab）或半栏（横屏分屏）渲染。`base.ts` 新增独立的 `scrollYChannel` + `chatColX`，`handleDown/handleMove` 按拖拽落点在分隔线哪一侧路由到对应列滚动（与 Family 同法）。`data.ts` `applySectMsg()` 实时新消息在横屏下不论当前 tab 都刷新（分屏频道常驻可见）。**验证**：`tsc --noEmit` 绿；新增 `test/ui/sectSceneSplitView.ui.ts`（4 例：分屏双栏同显 + `chatColX` 落在 rail 与右边界之间、空频道提示、两列独立滚动、竖屏仍 tab 切换）；家族/宗门相关既有测试（familySceneSplitView 18 例 + social-sect-leader-gate/world-family-sect-nav-tabs 13 例）无回归；无头渲染实测 1200×950 几何（左列 x190–695 投票钮不越界、分隔线 chatColX=701、右列 x701–1192 含输入行、底部操作栏 y≈904 清空两列，无重叠），到宗门实景需登录+族长+已建门后端态成本高故沿用无头渲染+几何实测而非驱动线上 app。 | 07-13 FamilyScene 分屏改版的宗门对齐 |
| **家族/宗门名字长度改按显示宽度限制（2026-07-17）** | ✅ 完成。**问题**：用户反馈家族名太长。原校验各处用 `.length`（UTF-16 码元，一个汉字算 1），家族服务端上限 20（实际允许 20 个汉字）、客户端 `maxLength` 甚至给到 24 且与服务端不一致。**方案**：改按**显示宽度**限制——全角（CJK/全角）字符算 2、其余算 1，上限 12（= 最多 6 个汉字 或 12 个字母），下限 2。`@nw/shared`（`slg/core.ts`）新增 `ORG_NAME_WIDTH_MIN=2`/`ORG_NAME_WIDTH_MAX=12` + `orgNameWidth()`/`truncateOrgName()`（按码点遍历，星形字符按全角算 2、不切半个字）。服务端 `familyService.createFamily` 与 `worldsvc/sectService.createSect` 的名字校验从 `length 2–20` 改为 `orgNameWidth ∈ [2,12]`；tag 仍是 `[A-Z0-9]{2,5}`。客户端三处名字输入路径（`FamilyScene/input.ts`、`SectScene/input.ts`、`FriendsScene/orgForm.ts` 家族/宗门两个 create 表单）统一用 `truncateOrgName` 在 input 回调里按宽度截断并回写 DOM（`openHiddenInput` 加可选 `clamp` 形参）。**验证**：`tsc --noEmit`（client+socialsvc+worldsvc）+ 客户端 webpack 全绿；新增 `server/shared/test/orgName.test.ts`（8 例：宽度计数/半全角混排/边界 6汉字=12/截断不切字）；`family.e2e`（+2 拒绝 case + 1 边界 6汉字通过）、`sect.e2e`（+1 宽度校验用例）全绿。 | 承接称号标签显示修复同一批社交 UI 反馈 |
| **世界频道刷新 403（NOT_IN_WORLD）：读/发消息不应要求已在 SLG 落户（2026-07-18）** | ✅ 完成。**问题**：用户刷新「世界」聊天一直失败，Network 面板显示 `GET /nation/channel?worldId=s1-0` 返回 403；用户指出「参数还挂着 slg」——此前（07-14/07-18 两轮）已把**客户端**的世界聊天从家族/宗门状态门槛里解耦，但**服务端**`worldsvc/nationChannelService.ts` 的 `sendMessage`/`getChannel` 仍各自查一次 `cols.playerWorld.findOne({_id: worldId:accountId})`，没有该记录（即玩家从未在这个 world 的 SLG 地图上落户建过基地）就抛 `NOT_IN_WORLD`（映射 403）——世界聊天本质是按分片（shard）划分的社交频道，落户与否是纯 SLG 概念，两者被这条守卫耦合在一起，跟 07-14 SOCIAL_DESIGN 里写的「聊天本身压根不依赖 SLG 世界/赛季概念」自相矛盾。对照 `sectService.getChannel` 本来就没有类似的 `playerWorld` 门槛，`nationChannelService` 是唯一一处误加的。**修复**：删掉 `sendMessage`/`getChannel` 里的 `playerWorld` 查询与 `NOT_IN_WORLD` 抛错，两者都不再要求调用方在该 world 落户。**验证**：`tsc -b worldsvc` 绿；`nation-channel.e2e.test.ts` 新增 2 例（`sendMessage`/`getChannel` 对没有 `playerWorld` 记录的账号也成功），16 例全绿。 | 07-14/07-18 世界聊天 SLG 解耦系列的服务端收尾 |
| **加入家族改「按 ID 加入」为「按名称搜索」（2026-07-18）** | ✅ 完成。**问题**：用户反馈 `FriendsScene` 的「加入家族」表单要求玩家手打家族 ID，找不到、体验差。**方案**：socialsvc `familyService.ts` 新增 `browseFamilies(query?, limit=10)`——按繁荣度降序返回有空位（`memberCount < FAMILY_CAP`）的家族，`query` 非空时对家族名做大小写不敏感的正则模糊匹配（先转义特殊字符防注入）；新路由 `GET /social/family/browse?q=&limit=`。客户端 `WorldApiClient.browseFamilies()` 包一层；`FriendsScene` 的 `familyActiveInput` 从 `'id'` 改为 `'search'`，新增 `familyBrowseQuery`/`familyBrowseResults`/`familyBrowseLoading`/`familyBrowseLoaded` 状态；`orgForm.ts` 的 `drawFamilyJoinForm` 换成搜索框（回车/「搜索」按钮触发查询）+ 结果列表（`drawFamilyBrowseList`，每行 `[TAG] 名称` + 成员数/繁荣度，点击直接 `doJoinFamily(familyId)` 加入，无需再输入 ID）；点「加入家族」按钮首次进入时自动加载默认榜单（`query=''`），已加载过不重复拉取。`FamilyScene/actions.ts` 里另一条独立的 `listFamilies()`（家族 hub 内的加入弹窗，实际只返回自己的家族，是较早的死代码路径）未改动，超出本次范围。**验证**：client/socialsvc `tsc --noEmit` 绿；新增 socialsvc `browseFamilies` 单测（排序/排满/模糊匹配）+ `familyHttp.e2e.test.ts`（4 例，真实 HTTP+Mongo 验证鉴权/默认排序/`q`/`limit`）；client 新增 `test/ui/familyJoinSearch.ui.ts`（7 例：默认榜单只加载一次、重进不重复拉取、点击行直接加入、加入失败保留可重试、回车/搜索按钮带 query 重查、空结果不崩、行 hit-rect 不越界），并修了 `caretRegression.ui.ts` 里过时的 id-输入光标用例；`test:ui` 全量 66 文件 631 例绿、socialsvc 5 文件 53 例绿。未截图验证（本机 dev server 只起了 `game`，`meta`/`social` 等未起，bootstrap 请求失败——已知的 Browser-pane 卡死/未启动问题，与本次改动无关）。 | 家族/宗门名字宽度限制的后续 |
| **家族浏览列表：点击行改为查看信息，加入按钮独立出来（2026-07-18）** | ✅ 完成。**问题**：用户反馈上一版「点击行直接加入」体验太冲——想先看看这个家族什么样再决定要不要加，误触风险也大。**方案**：每行右侧新增独立的「加入」按钮（`addButton`，直接 `doJoinFamily`），行的其余可点区域改为 `openFamilyDetail(familyId)`——调用新增回调 `viewFamily?(familyId)`（`WorldApiClient.getFamily()` 包一层，socialsvc 早已有 `GET /social/family/:familyId` 路由，只是客户端此前没接）拉取 `FamilyDetailView`（含成员名册），弹出一个信息页（`drawFamilyDetail`：`[TAG] 名字`、族长名、成员数、繁荣度、公告，底部 Cancel/Join 两个按钮）。`base.ts` 新增 `familyDetailView`/`familyDetailLoading` 状态，`onBack()` 优先关闭该信息页（同 `openMailItem` 的既有模式）。`doJoinFamily` 成功后一并清空 `familyDetailView`。**验证**：`tsc --noEmit` 绿；用临时 debug hook（`app.ts` 挂 `__NW_DEBUG` 暴露 `FriendsScene`+假 `cb`，起 `game` dev server 直接 `new FriendsScene(...)` 绕过登录）实测两条路径截图核对——行内「加入」按钮独立可点、点行体（非按钮区）弹出信息页且字段（族长/人数/繁荣度/公告）正确、Cancel/Join 均可用；hook 验证后已移除，`git diff` 确认 `app.ts` 无残留改动。补充新增 `test/ui/familyBrowseDetail.ui.ts`（8 例：Join 按钮直接加入且不触发 `viewFamily`、点行体只预览不加入、预览面板 Cancel 关闭不加入、预览面板 Join 加入成功后自动清空、拉取失败清 loading 且不崩溃、Back 键优先关闭预览而非退出社交页、未提供 `viewFamily` 回调时点行不崩溃且不弹窗、每行按钮+信息区 hit-rect 互不重叠且不越界）；`test:ui` 全量 69 文件 648 例绿（含既有 `familyJoinSearch.ui.ts` 7 例，无回归）。 | 「按 ID 加入」改「按名称搜索」的后续 |
| **家族频道消息顺序反了 + 向上滚动盖住标题（2026-07-20）** | ✅ 完成（纯客户端）。**问题**：用户反馈家族频道消息新旧顺序反了（新消息在最上、旧消息在下）；且列表滚动到顶时会盖住上方「Family Channel」标题/tab 区域。**根因**：`FamilyScene/render.ts` 的 `renderChannel()` 是唯一一处仍按服务端返回顺序（newest-first）原样绘制、且从未加遮罩裁剪的频道渲染——同款的 `SectScene.renderChannel()`（07-17 分屏改版时）与 `FriendsScene` 世界频道早就各自做了「倒序为 oldest-at-top」+「`PIXI.Graphics` mask 裁剪滚动区」两处修复，FamilyScene 建立时间更早、一直没跟进。**修复**：`renderChannel()` 补上与 Sect 频道同款的 `PIXI.Container` + `Graphics` 遮罩（裁剪到 `(x0, y0, colW, viewH2)`），消息迭代前 `[...this.messages].reverse()` 倒序为 oldest-at-top；`actions.ts` `submitMessage()` 乐观回显发送后原先把 `scrollYChannel` 归零（旧顺序下新消息本就在顶部），倒序后新消息落到底部，故改为滚到底（赋 `Number.MAX_SAFE_INTEGER`，靠 render 里既有的 clamp 收敛成合法最大值）。**验证**：`tsc --noEmit` 绿；debug-hook 截图法核对（`app.ts` 临时挂 `__NW_FamilyScene`/`__NW_APP`/`__NW_PIXI`，假 `worldApi` + 20 条编号消息直接渲染真实场景，1920×1080 横屏分屏）——oldest 在最上、newest 贴底部输入框上方；滚动到半行时顶部消息被遮罩整齐裁在「Family Channel」标题下方、不再溢出盖住头部；调用 `submitMessage()` 后自动滚到底部，新消息可见。hook 验证期间 `app.ts` 两次被同仓另一并发会话实时改动冲掉了调试用的 `__NW_APP`/`__NW_PIXI`/`__NW_FriendsScene`，收尾时确认最终 `git diff` `app.ts` 干净、无残留。 | 07-13/07-17 FamilyScene/SectScene 分屏改版系列的收尾 |
| **宗门同盟操作从底栏移到顶部信息栏 + 查看盟友对全体成员开放（2026-07-22）** | ✅ 完成（纯客户端）。**问题**：用户截图反馈横屏分屏底部操作栏的「结盟 / 管理盟友」两个按钮想挪到顶部；且普通成员也需要看到本宗门有哪些盟友，只有「管理同盟」（增/删盟）才该门主专属。**方案**：`render.ts` `renderBottomBar()` 删掉 `sect.ally`/`sect.manageAllies` 两个底栏按钮（底栏只留门主 `dissolve` / 家族长 `leave`）；新增 `drawAllianceControls(rightEdge, bandY, bandH)`——把同盟控件右对齐（右→左排布）画在顶部宗门信息栏（`renderSplitView` 与竖屏 `renderFamilies` 的 summary band）上：**门主**画「结盟」（`openAllyList` 发起）+「管理盟友」（`openManageAllies` 解盟）两钮；**非门主成员**画只读「盟友 (n)」一钮（`n=allySectIds.length`）。`actions.ts` 新增 `openAlliesView()`——按 `allySectIds` 经 `listSects` 解析出盟友名单，只读展示（无解盟 action）；`modals.ts` `showSectPickModal` 加可选 `readOnly` 形参（只读时行不注册 `modalHits`，纯展示）。可见性：查看盟友对全体成员开放，发起/解盟仍 `isSectLeader` 门控（与服务端 `allySect`/`unallySect` 门主专属一致）。**验证**：`tsc --noEmit` 绿；新增 `test/ui/sectAllianceControls.ui.ts`（2 例：门主在顶部信息栏见「结盟」+「管理盟友」且 y<h/2 已上移、无「盟友(n)」；普通成员见只读「盟友(2)」、无「管理盟友」/「结盟」）；既有 `sectSceneSplitView.ui.ts` 4 例无回归。宗门实景需登录+族长+已建门+盟友后端态，成本高故沿用无头渲染真实场景 + 位置断言。 | 07-17 SectScene 分屏改版的后续 |
| **横屏顶部信息栏改版：宗门身份 + 同盟按钮挪进顶栏，去掉手绘描边背板（2026-07-25）** | ✅ 完成（纯客户端）。**问题**：用户截图圈出横屏宗门页左上角「乱」——`renderSplitView` 在共享标题栏（"Sect"）正下方又手绘了一条独立描边面板（`drawHeaderBand`）承载宗门摘要（`[TAG] 名字 · N families · 繁荣度`）+ 同盟按钮，紧接着栏目标题（Families / Sect Channel）又是同款描边面板；两块手绘抖动边框贴着社交 rail（顶边与标题栏齐平、无间隙）挤在一起，边框互相打架，且标题栏满宽的纸纹底色下方立刻续接另一块视觉分量相近的描边条，显得突兀。对照 `FamilyScene` 07-14 那次改版（本表同日条目「顶栏承载身份」）早就把同类识别信息挪进了顶栏本身、不再另起描边面板，`SectScene` 07-17 分屏改版时没跟进这个模式。**方案**：`SectSceneBase`（`base.ts`）新增 `drawHeaderTitle()`（仿 `FamilySceneBase.drawHeaderTitle`）——横屏且已有宗门时，顶栏内居中显示「Sect + [TAG]名字 + N families + ⭐繁荣度」，同盟按钮（结盟/管理盟友，或只读「盟友(n)」）改由新增的 `drawHeaderAllianceButtons()` 固定在顶栏右侧（`headerExtras` 数组，每次渲染销毁重建，避免叠加泄漏）；竖屏窄栏放不下，摘要仍留在正文（见下）。`render.ts` 删掉整个 `drawHeaderBand` 方法：横屏 `renderSplitView` 不再重复画摘要行，除名投票横幅直接从 `headerH+12` 起画；栏目标题条改成与 `FamilyScene.renderSplitView` 同款的纯色 6% 透明度色带（`C.dark` 填充 + 1px 底边线，无手绘抖动边框），不再和顶栏抢视觉。竖屏 `renderFamilies` 的摘要行同样去掉外层描边面板改纯文字，同盟按钮改名 `drawAllianceControlsRow`（行为/位置不变，按钮本身仍保留手绘边框——它们是真实可点按钮，边框合理，与「去掉纯装饰性描边背板」不矛盾）。**未动**：`sect.families`/`sect.territory` 等「永远复数」的 i18n 写法是全项目统一习惯（非本处独有），未单独修正以免与其余几十处不一致。**验证**：`tsc --noEmit` 绿；`test/ui/sectAllianceControls.ui.ts` 更新为同时扫描 `scene.container`（顶栏，同盟按钮新位置）与 `scene.bodyLayer`；既有 `sectSceneSplitView.ui.ts`（4）/`sectCreateCost.ui.ts`（5）/`familySceneSplitView.ui.ts`（18）无回归；全量 `test:ui`（88 文件）仅 7 例失败，均在 `worldMap*`/`marchTokenAnimation`/`modalScaleAndBackButton` 等与本次改动无关的文件里（同仓另一并发会话的 field-battle 相关 WIP），确认与本次改动无关。**未截图**：本次会话 Browser 面板报"未显示，无法截图"（环境问题，非本次改动引入），沿用无头渲染 UI 测试的精确文本/坐标/hitRect 断言核对新布局。 | 07-22 同盟操作顶栏化的后续，对齐 `FamilyScene` 07-14 顶栏承载身份模式 |
| **宗门顶栏同盟按钮文字被自己的按钮底板盖住（2026-08-09）** | ✅ 完成（纯客户端）。**问题**：用户截图反馈横屏宗门页顶栏右上角的同盟按钮（普通成员是只读「盟友(n)」，门主是「结盟」/「管理盟友」）只剩一个空描边框，按钮内没有任何文字，但点击仍能正常打开对应弹窗。**根因**：07-25 顶栏化那次改动里，`SectSceneBase.drawHeaderAllianceButtons()` 的 `addBtn` 闭包先把文字 `lbl` `add()` 进 `headerExtras`/`container`，紧接着才把按钮底板 `sketchPanel`（不透明纸色填充）`add()` 进去——PixiJS 后加入的子节点画在上层，于是不透明底板整个盖住了先画的文字，只留手绘描边可见；点击热区（`hitRects`）不看渲染层级所以还能点开，纯视觉 bug。竖屏正文里同款按钮（`render.ts` 的 `drawAllianceControlsRow`）当初顺序是对的（先加底板、后加文字），两处实现在 07-22/07-25 两次改动中分叉，横屏顶栏版本一直没被发现。**修复**：调整 `addBtn` 内的加入顺序——先量出文字宽度（不挂树）、算完按钮几何后先 `add()` 底板、再 `add()` 文字，文字回到最上层。**验证**：`tsc --noEmit` 绿；既有 `test/ui/sectAllianceControls.ui.ts` 2 例仍绿（该测试只断言文字存在，不断言层级，未能覆盖这个 bug）——补充 2 例永久回归测试，按钮逐个断言「label 在 `container.children` 里的直接前一个兄弟节点不是 Text」（即其自身 `sketchPanel` 底板，而非另一个按钮的 label 或文字本身），比"最后一个节点是不是 Text"更准确（门主两个按钮 `[面板1,label1,面板2,label2]` 交错排列，后者对多按钮场景会误判）；手动改回旧顺序复测确认这 2 例会失败、改回修复后转绿，确认测试真的覆盖了这个 bug 而非空过。`test:ui` 全量 135 文件 1275 例绿，无回归。 | 07-25 顶栏同盟按钮改版的回归修复 |
| **家族服务两处并发/隐私 bug（2026-08-04 全量 code review）** | ✅ 完成（纯服务端）。**问题一（`memberCount` 漂移竞态）**：`joinFamily`（接受入族申请）先 `$inc:{memberCount:1}` 再 `familyMembers.insertOne`（`_id`=accountId，全局唯一）——同一账号如果同时有两条待处理的入族申请（分别申请了两个不同家族）都被接受，两次调用都能先各自成功 `$inc` 自家的 `memberCount`，但第二个 `insertOne` 必然撞 `_id` 唯一键抛 E11000（该账号全局只能属于一个家族）；修复前这次失败没有任何补偿，落败的那个家族 `memberCount` 就永久多算了一个不存在的成员。`requestJoin`（发起入族申请）本身也不是原子的——`findOne` 判断"是否已有待处理申请"和随后的 `insertOne` 之间有窗口，同一账号并发发起对不同家族的两次申请可以都通过检查、都插入成功，这正是上面 `memberCount` 竞态实际会被触发的根源。**修复**：① `joinFamily` 捕获 `insertOne` 的 E11000，命中时把已经加过的 `memberCount` 用 `$inc:-1` 补偿回滚，再抛 `ALREADY_IN_FAMILY`（镜像 `createFamily` 已有的同类 E11000 处理）；② `familyJoinRequests` 新增一个 partial 唯一索引 `{accountId:1}`（`partialFilterExpression:{status:'pending'}`），`requestJoin` 的 `insertOne` 改捕获 E11000 抛 `ALREADY_REQUESTED`——从根上保证同一账号任意时刻全局只有一条待处理申请，问题一的触发前提不再成立。**问题二（`getFamily` 向非成员泄漏 accountId）**：`GET /social/family/:id` 是公开路由（任意已登录玩家都能查任意 familyId，配合 07-18 上线的按名称搜索/浏览功能，familyId 天然可枚举发现），但返回的成员列表此前无条件带着裸 `accountId`——本文件 §3.1 早就写明好友系统"不暴露 accountId（仅服务器内部）"，`getFamily` 一直是个例外，任何玩家都能查到任意家族全体成员的 accountId（内部标识，非好友系统对外只暴露 `publicId` 的既有原则）。**修复**：`getFamily(familyId, callerId?)` 新增可选 `callerId` 形参——传入且调用者不是该家族成员时，返回的 `FamilyMemberView[]` 每项剥掉 `accountId` 字段；`httpApi.ts` 的公开路由改为传入当前请求者的 accountId，内部调用方（`/internal/push` 的家族频道广播，需要真实 accountId 做在线推送）不传，保留完整视图。契约 `openapi-social.yml` 的 `FamilyMemberView.accountId` 改为可选，客户端 `openapi-social.ts` 类型同步。**回归**：`server/socialsvc/test/family.e2e.test.ts` 新增用例——并发 `joinFamily`/`requestJoin` 竞态断言 `memberCount` 不漂移；非成员查询 `getFamily` 断言成员列表不含 `accountId`，成员/内部调用（不传 `callerId`）断言仍完整可见。 | — |
| **世界频道竖屏两处溢出：输入框长文字盖住发送按钮 + 按钮文字自己溢出（2026-08-11）** | ✅ 完成（纯客户端）。**问题**：用户截图反馈竖屏世界频道两处溢出——①打得长一点的发言会从输入框右边溢出，压到发送按钮上；②发送按钮本身的文案「发言 · 50 金币」也比按钮还宽，字冒到框外。**根因**：`FriendsScene/worldChat.ts` 的 `drawWorldTab()` 把输入框内容画成一个既不裁剪也不限宽的普通 `PIXI.Text`，左对齐后爱多长画多长；`FriendsScene/chrome.ts` 的 `addButton()` 只按按钮**高度**（`h*0.36`）算字号，从没检查过按钮**宽度**——竖屏发送按钮宽度是设备宽度的固定比例（`sendBtnW = w*0.24`），而按钮字号却随高度走（`inputH` 在竖屏窄而高的机型上偏大），两者一旦不匹配（细高比屏幕上尤其明显），字号越大、越容易比按钮本身还宽。**修复**：①`worldChat.ts` 给输入框文字加 `PIXI.Graphics` 裁剪遮罩（同 `scrollRegion()` 现成手法），并在文字实际宽度超出可用区时把 `anchor` 从左对齐切到右对齐——效果是溢出时自动"卷"到显示行尾（光标所在处），跟原生输入框打字溢出时的滚动观感一致，不会再压过发送按钮。②`addButton()` 加一个收缩到位的字号自适应循环——按钮标签量出来的宽度超过按钮宽度的 88% 时，字号每次 −1 重新量，直到不超或跌到 10px 地板，不影响原本就没溢出的按钮（含调用方显式传入 `fontSize` 的情形）。**验证**：`tsc --noEmit` + webpack 生产构建绿；新增 `client/test/ui/worldChatInputBoxOverflow.ui.ts`（10 例，2026-08-11 补充横屏对照组后）——长/短输入行的裁剪与左右锚点切换、`addButton()` 本身的收缩循环（窄按钮收到 10px 地板 / 宽按钮或显式 `fontSize` 已经合身时不收缩）；`npm run test:ui` 全量 159 文件绿，无回归。**横屏不受影响的显式覆盖**（用户追加要求）：横屏内容列更宽（`designWidth` 至少 1920，且不像竖屏那样随设备宽度反向挤压 `sendBtnW`/`inputW`），补了 4 个针对性用例——正常长度输入行左对齐位置与修复前逐像素一致（`inputTxt.x === px+padX`，遮罩加了但不裁切时不挪动任何东西）、真送出按钮标签在横屏几何下维持默认（未收缩）字号且断言按钮本身确实够宽（防止"假通过"）、连同一条竖屏用的超长测试串在横屏几何下也能正确触发遮罩+右对齐（证明这不是竖屏专属分支，只是横屏本身不容易撞到）、`addButton()` 直接单测横屏送出按钮的真实数值（461×81）不收缩。**已知局限**：headless PIXI 冒烟层（`test/harness/pixiHeadless.ts`）的 canvas 测量桩按字符数估算宽度、**不随字号变化**，无法在无渲染器环境里复现"大字号在真实 canvas 下更宽"这一真实溢出路径本身——按钮收缩循环的机制（能收缩、能落地板、不误伤已合身的按钮，含横屏几何）已覆盖，像素级是否贴合仍待真机截图核对（本次会话仅起了 `game-e2e` 前端、未拉起 metaserver/socialsvc/worldsvc 等后端，无法登录进真实世界频道页截图）。 | 07-18/07-14 世界聊天系列修复的又一处纯 UI 收尾 |
| **社交五页签切换卡顿：页签被绑上了「重新拉数据」和「跨场景跳转」两件事（2026-08-20）** | ✅ 完成（纯客户端）。**问题**：用户反馈社交里几个页签「切换总是伴随卡顿」，感觉实现方式和其他多页签页面不一样。**根因（三层，按影响排序）**：①**家族/宗门页签其实不是页内页签，而是跨场景销毁重建**——`orgForm.ts` 的 `drawFamilyTab`/`drawSectTab` 在**render() 调用栈里同步**调 `cb.openFamilyHub?.()`，所以已有家族时点该页签会先完整画一帧 `FriendsScene`、再把它整个销毁、new 一个 `FamilyScene`；而且 `FamilyScene.loadData()` 又重新发一次 `GET /social/family/mine`，跟几百毫秒前 `loadSLGStatus` 刚拉过的是同一份响应（第二次 loading 屏）。②**`switchTab()` 无条件 `net.refresh()`**——切到任何页签都并发打 4 个接口（好友/申请/邮件/会话），包括根本不读这些数据的页签；回包后 `finally` 里再无条件 `core.render()`，等于「点击瞬间整树重建一次 + 网络延迟后又一次」，而多数 refresh 的数据其实没变，第二次纯粹是在用户眼前闪一下（正在输入时尤其明显）。③**整树重建被三个高频源驱动**：拖拽滚动逐帧、光标闪烁 0.5s、切磋倒计时 1s——每次都 `tearDownChildren` + 重建全部 `Text`/`Graphics`/`Sprite`，而这三者各自只改一样东西。**方案**：①跳转从 draw 路径移到 `core.autoJumpOrgHub()`，只在 `switchTab`（状态已知）和 `loadSLGStatus` 完成（状态刚到）这两个时机调，**绝不在 render 里**（`drawFamilyTab`/`drawSectTab` 改为兜底显示 loading）；`openFamilyHub`/`openSectHub` 回调改为返回 `boolean`（是否真的跳了），分片未解析时返回 `false`，页签继续自己画而不是留白；`FriendsSceneCallbacks` 新增一次性 `preloadedFamily` 交接（`social.ts` 存下 `loadSLGStatus` 拉到的 `FamilyDetailView` → `goFamilyHub` → `FamilyScene.loadData()` 直接用，消费后置 null，后续再进仍重新拉）。②`switchTab` 只在目标页签真读这份数据（friends/mail）**且**已过 `REFRESH_STALE_MS`(30s) 时才 refresh——推送本来就保证实时，切页签重拉纯属冗余；`refresh()` 的 `finally` 加载荷签名比对，数据没变就不重绘。③新增 `FriendsScene/repaint.ts`（`RepaintState`，form②）承接三条增量重绘路径：滚动照抄 `CardCodexScene` 的先例——行按 `builtScrollY` 一次布好、上下各多建一屏（`overscan`），拖拽只 `layer.y = -delta` + 重画滚动条，**只有拖出 overscan 带才回落整树重建**（命中率高时一次手势 0 次重建）；光标闪烁与倒计时各自只改一个 `Text` 的字符串（`caretField`/`duelBannerLabel`），对象没了才回落 render。滚动层 hit rect 记在 build 空间，`onPointerUp` 按 `scrollDelta` 换算。**顺带**：`chrome.ts` 新增 `caretText()` 收敛 6 处重复的「带光标输入框文字」构造；`friendsList` 内联的 clip+layer 改走 `scrollRegion()`；三处 render 后置 scrollY clamp 改为置 `scrollDirty`（原本会静默失同步到下次滚动）。**500 行门禁连带拆分**：`core.ts` 505→499（挖出 `repaint.ts` + `input.ts` 指针分发，**baseline 例外条目已摘除**）；`orgForm.ts` 500→335（家族浏览/加入流程整体挖成 `orgBrowse.ts`）。**验证**：`tsc --noEmit` 绿、`check:filelength` 绿、web 生产构建绿、1488 单测 + 1840 UI 测试全绿。新增 `test/ui/socialTabSwitchCost.ui.ts`（7 例：切世界频道不重拉那 4 个接口；friends↔mail 来回 8 次仍只 1 次拉取；过期后确实重拉；载荷未变不重绘 / 变了要重绘；光标闪烁和倒计时各自只动一个 Text）；`scrollDragThrottle.ui.ts` 的 FriendsScene 用例改为断言更强的新契约（拖拽 0 次重建 + 拖出 overscan 才重建）**并新增几何等价性用例**（拖 137px 后逐行屏幕 y 必须与同位置整树重建完全一致——注入 1px 偏差可让两例同时失败，确认不是空转）；`familyHubNavRace.ui.ts` 重写为钉「render 绝不跳转、switchTab/loadSLGStatus 才跳转」；`familyLoadDecouple.test.ts`/`social-family-hub-return.test.ts` 补 `preloadedFamily` 交接与 `false` 返回值；`composition-wiring.ui.ts` 补 `orgBrowse`/`repaint` 两个新成员。**未截图**：本机 Browser 面板未显示、无法合成帧（`screenshot` 超时），且社交需要后端账号——改用 headless PIXI 下的几何等价性断言替代肉眼比对（比截图更强：它在 CI 里长期生效，且已用 mutation 验证过会失败）。 | 用户反馈 |
| **补测试时抓到自己上一轮埋的 bug：滚轮滚动后立刻点击会点错行（2026-08-20，同日续）** | ✅ 完成（纯客户端）。**起因**：同日那条页签卡顿修复合并后，被问「有测试可以加吗」，回头审自己钉住的东西 —— 发现**「平移之后点行，点到的是哪一行」完全没测**（既有用例只断言了「拖拽不触发点击」，没有任何用例断言「点对了行」）。写这条用例的过程中就发现了真 bug。**bug**：`onPointerUp` 用 `repaint.scrollDelta`（= `scrollY - builtScrollY`）把点击换算回 build 空间，但这是**待应用**的差值 —— `onWheel`/`onPointerMove` 是**同步**改 `scrollY` 的，图层却要等到下一帧 `update()` 排掉 `scrollDirty` 时才平移。于是滚轮滚一下、在下一帧到来之前点击的那一帧窗口里，`scrollY` 已经变了而屏幕还没动，点击却按「已经平移过」来换算 —— **整整错一行**（点第 3 行打开第 7 行的资料卡）。改动前没有任何偏移，所以这**是我上一轮引入的回归**，不是既有问题。**修法**：把两个概念拆开 —— `pendingScrollDelta`（逻辑差值，只给 `applyScroll` 判断「平移还是重建」用）与 `appliedScrollDelta`（`-layer.y`，即**屏幕上实际的位移**），命中判定一律用后者：点击必须按玩家真正看到的画面来判，而不是按尚未生效的意图。顺带把 `-0` 归一化（`-0 === 0` 为真，但 `Object.is` 为假，会让断言读起来像真的偏移 bug）。**本轮补的测试**（新增 `test/ui/socialScrollTranslate.ui.ts` 10 例 + 既有文件 17 例）：①**点击落在正确的行**——拖一行高之后同一屏幕位置必须命中下一行（`friendIndex` 精确断言，抓符号/偏移错）；②**滚轮未排空时点击不偏移**（就是上面这个回归，已 mutation 验证：改回 `pendingScrollDelta` 只有这一条红）；③滚动条每帧重画**不累积**（`container.children.length` 拖 8 帧不变——否则每次手势泄漏一个滑块）；④**世界频道**的几何等价性（它是唯一在 `scrollRegion` 之后才定 `scrollY` 的面板，缺 `markScrollBuilt()` 会整列表错位）；⑤家族页签 `overscan` 必须为 0（该页无遮罩，非 0 会让行画到区域外）；⑥三条增量路径在目标对象被 destroy 后**回落整树重建而不抛**；⑦`refreshSignature` **逐字段**覆盖（12 例，每个会渲染的字段各一条：在线态/改名/别名/段位/头像/删好友/新申请/邮件已读/已领取/未读数/删邮件/未读私聊）——已 mutation 验证：从签名里删掉 `avatarId`/`mailUnread`/会话未读，恰好对应三条变红；⑧空账号首次加载仍必须绘制（走 `wasLoading` 分支，否则新号开局空白页）；⑨刷新失败**不打时间戳**、下次切页签会重试；⑩`switchTab('sect')` 的跳转/不跳转分支（有家族无宗门→画页面，有宗门→跳；无家族→不跳）；⑪世界频道输入框的 `reflow`（唯一带宽度相关布局的光标字段，长文右对齐必须在闪烁后仍然保持——已 mutation 验证）。顺带把上一轮那条几何等价性用例**收紧**：原先比较整个图层的行集合，而 overscan 窗口是围绕当时 `scrollY` 建的，平移树和重建树在边缘本就持有不同的行集，靠 137px 位移刚好没跨行才通过；改为**只比较区域内可见的行**（也是玩家真正看到的部分），并加 `length > 3` 防空转。**验证**：`tsc --noEmit` 绿、`check:filelength` 绿、1488 单测 + **1867** UI 测试（+26）全绿。 | 用户追问「有测试可以加吗」 |

| **宗门页签仍然「全量刷新」：进页面重复拉两个接口，页面里三条高频源逐帧重建整树（2026-08-25）** | ✅ 完成（纯客户端）。**问题**：用户反馈「社交页面，感觉宗门页签依然全量刷新了，应该是只刷新需要刷新的内容」——2026-08-20 那轮只把 `FriendsScene` 和家族交接改了，`SectScene` 自己还是老形状。**根因（两层）**：①**进入即重来一遍**：`loadSLGStatus` 为了页签上的宗门名，本来就已经拉过 `GET /social/family/mine` + `GET /sect/:id` 两份响应，但 `openSectHub` 什么都不交接，`SectScene.loadData()` 又把两个接口重新打一遍，而且 `loadMySect()` 会 `await loadChannel()` 之后才第一次 render——于是「点页签 → loading 屏 → 两个接口 → 再等频道接口 → 才出内容」。②**页面里三条高频源各自重建整树**：拖拽/滚轮滚动逐帧、光标闪烁 0.5s、`bt.tick()` 的 busy 动画 0.4s（而本场景根本不画 dots 遮罩，纯白烧），外加创建表单/发消息输入框**每次按键**一次——`tearDownChildren(bodyLayer)` 后重建家族行（每行一个手绘 `sketchPanel` 边框）+ 频道消息列 + 表头 + 左侧 rail。**方案**：①交接照抄家族那条：`SectSceneCallbacks` 新增一次性 `preloadedFamily`/`preloadedSect`（`social.ts` 存下 `loadSLGStatus` 的两份响应 → `goSectHub(..., preload)` → `DataPanel.loadData()` 直接用，消费后置 null；`preloadedSect` 只在 `sectId` 与家族当前的一致时才认，否则视为过期重新拉），并把 `loadMySect()` 拆成 `applySect()`——**家族名册先画出来，频道当第二段 round-trip**（同 `FamilyScene.applyFamily`）。②新增 `SectScene/repaint.ts`（`SectRepaint`，form②）承接三条增量路径：滚动按**列**（band）平移（家族列/频道列各自 `builtScrollY`+上下各一屏 overscan，拖出带外才回落 render），光标闪烁与按键都只改一个 `Text`（`caretText()`/`setFieldValue()`，频道输入框的空态灰色靠 `colorFor` 一起改），`bt.tick()` 的重绘**直接删掉**。滚动层 hit rect 打 `scroll: 'families'` 标记，`handleDown` 用 `appliedDelta`（不是 pending）换算并裁掉视口外的 overscan 行。**顺带发现的一处意外兜底**：`buildRasterTabIcon` 纹理未解码时画的是**空容器**，没有任何 loaded 回调，本页以前是靠那些多余重绘把 rail/表头图标「意外补上」的——装配壳补上 `preloadTabIconTextures().then(() => this.render())`（同 CardScene/EquipmentScene 的既有写法）。**验证**：`tsc --noEmit` 绿、`check:filelength` 绿、web 生产构建绿、1595 单测 + 1946 UI 测试全绿；新增 `test/ui/sectIncrementalRepaint.ui.ts`（12 例：竖屏名册拖拽 0 次重建 / 拖出 overscan 才重建、几何等价性（拖 137px 后逐行屏幕 y 必须与同位置重建一致，已 mutation 验证 `-delta + 1` 会红 5 条）、平移后点行命中与重建后一致、overscan 行点击必须落空、竖屏频道页签平移、横屏两栏互不牵连、滚轮同理、光标闪烁/按键/创建表单只动一个 Text、对象被 destroy 后回落 render、`bt` 跑两秒 0 次重建）+ `test/sectLoadDecouple.test.ts`（5 例：交接不再拉两个接口、过期 preload 要重拉、无交接仍拉、名册先于频道出、无家族只画一次）+ `social-family-hub-return.test.ts` 补 `openSectHub` 的一次性交接。**这次截到图了**（上一轮记的「面板不合成帧」仍然成立，但绕过去了）：`TARGET=web-e2e` 的 `window.__nwE2E.views.showSect(cb)` 可以拿桩数据直接挂载本场景、不需要后端账号，于是同一个 Playwright 脚本分别打**改前（主检出 9096）/改后（worktree 9296）**两个 dev server，再用 `sharp` 逐像素比对：竖屏/横屏首帧与频道页签**逐像素完全一致**，滚动后那一帧只差 0.36%——差异全部落在「投票罢免」按钮的手绘边框上，因为它的 `seedFor(cy, ...)` 种子取自行的 build 空间 y：平移时行保留原种子（边框不再每帧重新抖动，比原来更稳），重建时才换一份抖动。 | 用户反馈 |

| **家族页同款「全量刷新」（2026-08-25 同日续）** | ✅ 完成（纯客户端）。宗门那条修完后主动问了一句「家族页还是老形状，要不要一起改」，用户答「改」。**根因与宗门同构**（拖拽/滚轮逐帧、光标 0.5s、按键、`bt.tick()` 0.4s 各自整树重建），但有一处**更严重的差异**：家族名册的行是**直接画在 `bodyLayer` 上、完全没有遮罩**（宗门至少频道列有），所以既没法平移，滚到底那一行还会**溢出视口、盖到底部导航条上**（改前截图可见 Player9 整行压在 nav 上）。**方案**：①把名册包进自己的遮罩层（顺带修掉上面那个溢出，`peekViewportH` 本来的意图就是「露一截被裁开的行」）；②新增 `FamilyScene/repaint.ts`（`FamilyRepaint`，与 `SectScene/repaint.ts` 同构，列为 `'members' | 'channel'`；本场景两个朝向都是名册→`scrollY`、频道→`scrollYChannel`，所以 `scrollKeyFor` 比宗门那条更简单）；③行内 4 处 hit rect 打 `scroll: 'members'` 标记，`handleDown` 用 `appliedDelta` 换算 + 视口裁剪；④光标/按键只改一个 `Text`（`caretText`/`setFieldValue`，发送框空态灰色靠 `colorFor`）；⑤删掉 `bt.tick()` 的重绘；⑥补 `preloadTabIconTextures().then(render)`（同宗门，理由一致）。**500 行门禁连带拆分**：`core.ts` 480→525 超限，挖出 `types.ts`（纯声明，`core.ts` 里 `export type {...} from './types'` 保持既有 import 路径不变，同 `FriendsScene/types.ts` 的接缝）后回落 494。**测试接线破坏**（`client-modules.md` 第 19 条那类）：`familySceneSplitView.ui.ts` 有 4 例直接扫 `bodyLayer.children` 找名册行的 `PIXI.Text`，行进了子容器后全部失效——改成递归 walk（同文件早先为频道遮罩加过的 `textsOf` 手法），其中「每行都有卡片背景」那例顺手收紧成**在名册自己的图层里数**（原写法数 `bodyLayer` 直接子节点，行一个不画也能凑够数）；`familySendButton.test.ts`/`familyChannelInput.test.ts` 的 fake core 补上真的 `FamilyRepaint`（没注册 Text 时它回落 `core.render()`，正是生产的兜底路径，断言语义不变）。**验证**：`tsc --noEmit` 绿、`check:filelength` 绿、web 生产构建绿、1600 单测 + 1963 UI 测试全绿；新增 `test/ui/familyIncrementalRepaint.ui.ts`（12 例，与宗门那份一一对应，已 mutation 验证 `-delta + 1` 会红 5 条）。**逐像素 A/B**（同宗门手法，`views.showFamily(cb)` 桩数据挂载）：竖屏频道页签**完全一致**；其余帧的差异全部落在三处且都是预期的——(a) rail/表头/底栏图标现在画出来了（`preloadTabIconTextures`），(b) 名册底部那行现在被裁在视口边缘、不再压住底部导航条（改前/改后截图对比可见），(c) 滚动后每行手绘边框与头像的抖动种子取自 build 空间 y，平移保留原种子（改前是**每帧重抖**，现在稳定）。| 用户「改」 |

| **补测试时又抓到自己上一轮埋的 bug：拖过列表末端会滚进空白（2026-08-25 同日续）** | ✅ 完成（纯客户端）。**起因**：宗门+家族两条改完后被问「还有测试可以加吗」，照 2026-08-20 那次总结的清单（`memory/test-what-still-can-be-wrong-after-doing-less`）逐条自查，第一条就撞出真 bug。**bug**：`ScrollTapGesture.move()` 返回的是**未截顶**的手指位移（只保证 ≥0），改动前 `handleMove` 把它直接写进 `scrollY`，然后**每帧那次整树 render 里 lists.ts 会把它 clamp 回 `max`**——所以拖过末端只是「拉不动」。增量重绘把那次 render 去掉之后，clamp 也一起没了：平移路径照着超界的 `scrollY` 把图层挪出内容末端，列表底下露出**一条永远不会自己回弹的空白**（只有等下一次真正的重建才复位）。停在末端再往下拖 100px 就能复现，两个场景都有。**修法**：在 `handleMove` 里就 clamp 到该列的 `max`（`Math.min(raw, channelMax/familiesMax/membersMax)`），与 `FriendsScene.onPointerMove` 一直以来的写法一致；`handleWheel` 无此问题（`wheelScrollY` 本来就 clamp）。反向拖动仍然立刻跟手（没有需要先「解开」的死区）——这一条也写成断言了。**本轮补的测试**（`sectIncrementalRepaint.ui.ts` 12→20 例、`familyIncrementalRepaint.ui.ts` 12→21 例、新增 `tabIconWarmupCallSites.test.ts` 5 例）：①**拖过末端停在末端**（上面这个回归，已 mutation 验证：去掉 clamp 只有这两条红）；②**滚轮之后、帧还没排空就点击**——必须命中屏幕上当前那一行（已 mutation 验证：把 `appliedDelta` 换成 pending 只有这两条红，正是 2026-08-20 那次的同款窗口）；③**平移正好一行后，同一屏幕点命中「下一行」**（按 `fam_i`/成员顺序精确断言，抓符号/off-by-one）；④滚动条每帧重画**不累积**（拖 8 帧 `bodyLayer.children.length` 不变——漏一次 `destroy()` 就是每帧泄漏一个 Graphics）；⑤图层被 destroy 后回落整树重建；⑥**根本没建图层的模式**（创建表单）拖动也要回落重建（钉 `reset()` 的正确性）；⑦竖屏**只建当前页签那一列**（宗门两个页签共用 `scrollY`，隐藏列没有 band 才是「拖一列不会动另一列」的真正依据）；⑧**频道列的几何等价性**（消息 Text 的屏幕 y，平移 vs 重建必须逐条相等——`markScrollBuilt` 那类「渲染中途改 scrollY」的坑就出在这一列）；⑨家族名册的**遮罩边界**必须正好等于视口（钉住上一轮修掉的「最后一行压住底部导航条」，已 mutation 验证：去掉 `list.mask` 这条红）；⑩新增静态守卫：4 个「可以不经 LobbyScene 直接进」的页面（Card/Equipment/Sect/Family）必须各自 `preloadTabIconTextures().then(() => this.render())`，并把「谁画了社交 rail」这份名单也钉住，避免以后新增页面又忘（写成静态扫描而不是行为测试，因为 `preloadTextureList` 等的是 BaseTexture 的 `loaded` 事件，headless 下永远不触发，行为版会挂而不是红）。**验证**：`tsc --noEmit` 绿、`check:filelength` 绿、1889 单测 + 2020 UI 测试全绿。 | 用户「还有测试可以加吗」 |

| **弹窗列表统一成真正的滚动区，顺带修掉「只能看到前 6 个家族」（2026-08-25 同日续）** | ✅ 完成（纯客户端）。**起因**：上一轮收尾时我说「宗门/家族的弹窗列表仍是无遮罩、整树重绘，数据量小，判断不值得动」，用户答「顺手统一」。**一动才发现不是「重绘方式不统一」，是三处功能缺陷**：①家族浏览/加入弹窗 `families.slice(0, 6)`——整个分片只给看 6 个家族，没有滚动、也没有「还有更多」的任何提示；②宗门选择器 `sects.slice(0, maxRows)`——同款静默截断，上限由弹窗高度决定；③入帮申请审批表**不截断但也不裁剪**，申请多了就把行画到面板外面（画到屏幕外）。**方案**：三处都改成与页面列同一套滚动 band（第三个列名 `'modal'`），遮罩 + 一屏 overscan + 共用滚动条；因为 `modalLayer` 不在 `render()` 的树里，重建走弹窗自己注册的 `core.modalRedraw`（`applyScroll` 对 `'modal'` 列改调它；非列表弹窗——确认框、徽章选择器——没注册，于是拖动是无害 no-op 而不是白重绘整页）。**弹窗点击语义随之统一**：原来在 pointer-down 立刻触发，现在与页面一致走 tap-vs-drag（pointer-up 触发、拖动则丢弃），行 hit 打 `scroll: 'modal'` 标记并按 `appliedDelta` 换算——否则「拖列表」会误触行。`keepScroll` 参数保证「审批中途置灰按钮」那次重绘不跳回顶部。**顺带的结构统一**：新增共享 `ui/widgets/scrollRegionLayer.ts`（遮罩+图层这对显示对象，7 个调用点）；家族的两个弹窗从 `actions.ts` 挖进新的 `FamilyScene/modals.ts`（form① 自由函数，显式接回调——做成类会与 `ActionsPanel` 真双向依赖）；两个 `core.ts` 都因这轮改动压线/超限，各挖出 `pointer.ts`（指针/滚轮分发，Core 保留 4 个一行转发，因为 20 多处测试按名字调 `core.handleXxx`）。**测试**：两个场景各 +7/+6 例（可达性：滚到底后最后一项**可见**——注意断言必须按屏幕位置判定，overscan 会把行「建出来但裁掉」，我第一版就写成了「建出来」因此假红；拖动只平移不重建；拖过末端停在末端；滚轮滚弹窗而不是底下的页面；滚动后点行命中屏幕上那一行、且与重建后一致；从行上开始拖动不误触；关闭后重置、重绘保位；非列表弹窗拖动 no-op）。已 mutation 验证：恢复 `.slice(0, 6)` 只红「可达性」，去掉 `scroll: 'modal'` 只红「滚动后点行」。另补 `FriendsScene` 的「拖过末端」守卫（它的 clamp 一直在 handler 里、没这个 bug，但此前无用例钉住）。**逐像素/数值 A/B**：改前弹窗 16 个 hit（dim+15 行）、无滚动状态；改后 31 个（dim+30 行）、`modalMax=580`，滚轮 400 后显示 S10–S25 且在折线处正确裁开。1889 单测 + 2034 UI 全绿。 | 用户「顺手统一」 |

| **弹窗滚动条被画到了页面图层上（2026-08-25 同日续，又是补测试抓到的）** | ✅ 完成（纯客户端）。**起因**：弹窗统一那条合并后又被问「有测试可以加吗」，照清单第 3 项（「快速路径会不会泄漏」——它每帧 `destroy()` 再重画滚动条）写用例，一写就红。**bug**：`repaint.ts` 的 `drawBar()` 里父容器**硬编码成 `core.bodyLayer`**。页面两列本来就画在 bodyLayer，所以一直没事；弹窗那一列的内容在 `modalLayer`，于是**弹窗第一次平移时**：旧滑块（在 modalLayer 里）被 destroy、新滑块画进了**页面图层**——弹窗自己的滚动条消失，同时页面上（半透明遮罩下面、弹窗右缘的位置）多出一条每帧重画的滑块。**修法**：父容器改成读 `band.layer.parent`（内容在哪，滑块就画回哪），与「内容实际所在」不可能再失同步。**本轮补的测试**（宗门 +9、家族 +5、新增 `test/ui/scrollRegionLayer.ui.ts` 2 例）：①滑块「在**弹窗**图层里被替换、既不堆叠也不跑到页面上」（就是这个 bug，改回硬编码即红）；②滚轮未排空就点行（弹窗版的 applied-vs-pending 窗口，页面那条早有、弹窗此前没有）；③拖过 overscan 带外要经 `modalRedraw` 重建（200 条的长列表才够长）；④图层被 destroy 后回落 `modalRedraw` 且**不重绘页面**；⑤只读盟友列表仍可滚动、行不可点（顺带钉住「点行会穿到遮罩、于是关闭」这个既有行为——只读信息表这样是合理的，写成决定而不是意外）；⑥点遮罩关闭 / 在遮罩上拖动不关闭；⑦确认框与徽章选择器在「点击改到 pointer-up」之后仍然响应（它们本来只有直接调 `hit.action()` 的测试，覆盖不到 down/up）；⑧徽章选择器不注册 band、里面拖动什么都不动；⑨空列表不注册 band、拖动无害；⑩审批表滚到底后驳回一条（列表变短）必须重新 clamp，而不是停在内容末端之外；⑪`scrollRegionLayer` 的核心不变量：clip 是 layer 的**兄弟**而非子节点（做成子节点就跟着内容一起动、等于没裁，而且静默无报错——家族名册那个「压住底部导航条」的老 bug 就是这个形状）。1889 单测 + 2049 UI 全绿。 | 用户「有测试可以加吗」 |

### 验证方式（沿本仓约定）

- 服务端：`tsc -b` 六包 + meta/gateway 端到端测试（好友申请-同意建双向边、私聊好友校验/拉黑/未读、邮件领奖幂等、presence 上下线广播）。
- 客户端：`tsc --noEmit` + vitest + web 构建；UI 冒烟（`test/ui`）加好友/聊天/邮件场景。
- 不截图（用户自行浏览器验证）。
