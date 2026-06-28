# Notebook Wars — socialsvc 社交服务设计文档

> 创建：2026-06-28。本文件是 socialsvc（独立社交服务）的设计基准。
> 背景：原 SOC1 拍板"持久数据扩展 meta，不新建 social 进程"；**本文件推翻 SOC1**，改为独立 socialsvc。
> 触发原因：家族本是常规游戏功能（非 SLG 专属），但被绑定在 worldsvc 的 worldId 下，每赛季重置；好友/邮件在 metaserver 也使其持续臃肿；所有频道 Redis pub/sub 无统一宿主。
> 配套阅读：`SOCIAL_DESIGN.md`（原社交设计，数据模型细节仍有效）、`SLG_DESIGN.md`（家族→大区同步）、`GATEWAY_DESIGN.md`（/gw/push 通道）、`META_TASKS.md`（任务进度）。

---

## 0. TL;DR

- **socialsvc = 社交图谱权威 + 频道 Redis 宿主 + push 路由中枢**
- 家族升级为**全局持久实体**（去掉 worldId，跨赛季长存），从 worldsvc 迁入 socialsvc
- 好友关系 + 邮件从 metaserver 迁入 socialsvc
- 所有频道（家族/宗门/世界公频）的 Redis pub/sub 和消息历史统一在 socialsvc
- socialsvc 是**第五公网面**（`/social/*`），鉴权复用 meta JWT（仅 verifyToken）
- gateway 仍是 WebSocket 物理连接层；socialsvc 是逻辑推送的调度层（调 `/gw/push`）
- worldsvc 通过内部 API 查家族归属，宗门数据留在 worldsvc（赛季级）

---

## 1. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| SS1 | **推翻 SOC1，独立 socialsvc 进程** | 家族是跨赛季通用功能，绑 worldsvc 导致赛季重置；metaserver 职责过重；Redis pub/sub 无单一宿主 |
| SS2 | **家族 = 全局持久实体**（无 worldId） | 玩家的"公会"是长期社交资产，不应因大区赛季重置而消失；进入 SLG 时整体以家族为单位参战 |
| SS3 | **家族 TAG 全局唯一**（`families` 集合全库唯一索引） | 避免同名家族在不同大区造成身份混淆；TAG 是玩家识别家族的简短标识 |
| SS4 | **socialsvc = 第五公网面**，路径前缀 `/social/*` | worldsvc 已是第四面，先例存在；proxy 到 metaserver 引入不必要耦合（metaserver 故障→社交挂）；延迟多一跳 |
| SS5 | **所有频道 Redis 宿主在 socialsvc** | 家族/宗门/世界公频都需要 pub/sub 扇出；socialsvc 是唯一自然宿主；worldsvc 通过内部 push API 委托发送 |
| SS6 | **宗门留在 worldsvc**（赛季级，有 worldId） | 宗门本质是大区内势力组织，生命周期与赛季绑定，是 SLG 特有概念；但宗门频道的推送委托 socialsvc |
| SS7 | **worldsvc 存家族 ID 镜像**（只读快照，非权威） | worldsvc 高频地图操作（连地加成/领地渲染）需要 familyId，但不应实时调 socialsvc；玩家分配大区时同步一次 |
| SS8 | **presence 推送链**：gateway 上线事件 → socialsvc → 扇出好友 | gateway 是在线态权威（account→socket 映射在内存）；上线/下线通知是社交语义，由 socialsvc 处理好友过滤后再批量 push |
| SS9 | **批量邮件 fan-out 迁入 socialsvc** | 运营/系统群发邮件属于社交数据写入，统一由 socialsvc 分批处理（与 metaserver 的原分批逻辑等价，但宿主换了） |
| SS10 | **迁移分三期**，存量数据按期搬（详见 §6） | 好友/邮件一期留 metaserver 透传，家族直接在 socialsvc 新建，频道随 socialsvc 上线切换 |

---

## 2. 服务边界

```
┌─────────────────────────────────────────────────────────────┐
│  socialsvc（第五公网面，port 8085）                           │
│                                                             │
│  数据权威：好友关系 / 邮件 / 家族 CRUD / 频道消息历史         │
│  Redis 宿主：家族频道 / 宗门频道 / 世界公频 pub/sub           │
│  push 中枢：所有推送经 socialsvc → gateway /gw/push          │
└─────────────────────────────────────────────────────────────┘

调用关系：
  client         → socialsvc     （/social/* 公网 REST）
  metaserver     → socialsvc     （内部：发奖邮件、好友查询代理）
  worldsvc       → socialsvc     （内部：查 familyId / 委托频道推送）
  gateway        → socialsvc     （内部：上线/下线 presence 事件）
  socialsvc      → gateway       （/gw/push 推送指令）
```

### 各服务保留/迁入对照

| 功能 | 现在 | 迁移后 |
|---|---|---|
| 好友关系 / 申请 / 拉黑 | metaserver | **socialsvc**（P2 期） |
| 私聊消息 / 会话 | metaserver | **socialsvc**（P2 期） |
| 邮件（含 fan-out） | metaserver | **socialsvc**（P2 期） |
| 家族 CRUD / 成员 / 频道 | worldsvc（绑 worldId） | **socialsvc**（P1 期，去掉 worldId） |
| 宗门 CRUD / 成员 | worldsvc | worldsvc 不变（赛季级） |
| 宗门/世界公频推送 | worldsvc 直接调 gateway | worldsvc → socialsvc 内部 push API（P1 期） |
| Redis pub/sub 宿主 | worldsvc | **socialsvc**（P1 期） |
| gateway WS 连接 | gateway | gateway 不变 |
| 账号 / 经济 / 存档 | metaserver | metaserver 不变 |

---

## 3. 数据模型（socialsvc 独立库 `nw_social`）

> 独立 Mongo 数据库（与 `notebook_wars` 主库隔离），便于独立备份和后续拆分。

### 3.1 家族（SS2/SS3）

```ts
interface FamilyDoc {
  _id: string;          // familyId = uuid（如 fam_xxxxxxxx）
  name: string;         // 显示名
  tag: string;          // 全大写缩写 2–5 字符，全局唯一
  leaderId: string;     // accountId
  memberCount: number;
  prosperity: number;   // 繁荣度（达门槛可在 worldsvc 建宗门）
  createdAt: number;
  announcement?: string; // 公告（最近一条）
  rev: number;
}
// index: { tag: 1 } 唯一
// index: { leaderId: 1 }

interface FamilyMemberDoc {
  _id: string;          // `${familyId}:${accountId}`
  familyId: string;
  accountId: string;
  role: 'leader' | 'elder' | 'member';
  joinedAt: number;
}
// index: { familyId: 1 }
// index: { accountId: 1 }（查我在哪个家族）

interface FamilyMessageDoc {
  _id: string;          // `${ts}_${seq}`
  familyId: string;
  senderId: string;
  senderName: string;   // 发送时快照，防改名乱
  body: string;
  ts: number;
}
// index: { familyId: 1, ts: -1 }
// TTL index: { ts: 1 } expireAfterSeconds = 7 * 86400
```

注意：**无 worldId 字段**。家族进入 SLG 大区时，worldsvc 把 `familyId` 写入 `playerWorld.familyId`（只读镜像，socialsvc 不拥有 `playerWorld`）。

### 3.2 好友（从 metaserver 迁入，P2 期）

与 `SOCIAL_DESIGN.md §3.1` 结构完全一致，集合搬到 `nw_social` 库：

- `friendEdges`：有向好友边，`_id = ${owner}:${friend}`
- `friendRequests`：申请状态机
- `blockList`：拉黑有向边

### 3.3 私聊 / 邮件（从 metaserver 迁入，P2 期）

与 `SOCIAL_DESIGN.md §3.2 / §3.3` 结构完全一致，集合搬到 `nw_social` 库：

- `conversations` / `chatMessages`（含 TTL）
- `mails`（含 TTL + 附件领取幂等）

---

## 4. API 接口

### 4.1 公网 REST（`/social/*`，玩家鉴权 = meta JWT）

#### 家族

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/social/family` | 创建家族（扣 500 coin，调 commercial） |
| `GET` | `/social/family/mine` | 查我所在的家族（含成员列表） |
| `GET` | `/social/family/:familyId` | 查指定家族信息 |
| `GET` | `/social/family/search?tag=` | 按 TAG 搜索家族 |
| `POST` | `/social/family/:familyId/join` | 申请加入 |
| `POST` | `/social/family/:familyId/leave` | 退出家族 |
| `POST` | `/social/family/:familyId/kick` | 踢出成员（leader/elder） |
| `POST` | `/social/family/:familyId/role` | 更改成员角色（leader 降/升 elder） |
| `POST` | `/social/family/:familyId/disband` | 解散（leader，需无成员或强制）|
| `GET` | `/social/family/:familyId/messages` | 拉频道历史（分页） |
| `POST` | `/social/family/:familyId/messages` | 发频道消息（实时推给所有在线成员）|

#### 好友 / 私聊 / 邮件（P2 期上线，路径与原 metaserver 路径对齐或加 `/social` 前缀）

好友/私聊/邮件接口形状与 `SOCIAL_DESIGN.md §4` 完全一致，此处不重复；客户端切换 base URL 即可，接口语义不变。

### 4.2 内部 API（`X-Internal-Key` 鉴权，其他服务调用）

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| `GET` | `/internal/family/by-account/:accountId` | worldsvc | 查某玩家当前所在的 familyId（无则返回 null） |
| `POST` | `/internal/push` | worldsvc / metaserver | 委托推送（宗门消息/世界公频/系统通知） |
| `POST` | `/internal/mail/send` | metaserver / commercial | 发邮件（含批量 fan-out，单条或数组） |
| `POST` | `/internal/presence/online` | gateway | 玩家上线事件，触发好友在线通知扇出 |
| `POST` | `/internal/presence/offline` | gateway | 玩家下线事件，触发好友下线通知扇出 |

#### `/internal/push` 请求体

```ts
interface InternalPushReq {
  channel:
    | { kind: 'sect';   sectId: string }
    | { kind: 'world';  worldId: string }
    | { kind: 'family'; familyId: string }
    | { kind: 'account'; accountId: string };  // 单人定向
  event: string;    // 事件类型，如 'world_msg' / 'sect_msg'
  payload: unknown;
}
```

socialsvc 收到后：从 Redis 查对应频道的在线成员列表，批量调 gateway `/gw/push`。

---

## 5. 推送架构

```
[worldsvc / metaserver]
        │ POST /internal/push
        ▼
   socialsvc
        │ 查 Redis：chan:{kind}:{id} → 在线 accountId 集合
        │ 批量 POST /gw/push { targets: accountId[], event, payload }
        ▼
    gateway
        │ account → socket 本地映射（单实例直投 / 多实例经 Redis 路由）
        ▼
    client WebSocket
```

### Redis 频道键

| 频道 | Redis 键 | 说明 |
|---|---|---|
| 家族频道 | `chan:family:{familyId}` | pub/sub，成员上线订阅，下线退订 |
| 宗门频道 | `chan:sect:{sectId}` | 同上（sectId 由 worldsvc 传入） |
| 世界公频 | `chan:world:{worldId}` | 同上 |
| presence | `online:{accountId}` | 简单 SET 键，gateway 上线写/下线删（TTL 60s 心跳续期） |

### Presence 推送链

1. 玩家连接 gateway → gateway `POST /internal/presence/online { accountId }`
2. socialsvc 查 `friendEdges[owner=accountId]` 拿好友列表
3. socialsvc 批量 `POST /gw/push { targets: [好友ids], event: 'friend_online', payload: { accountId } }`
4. 下线同理（`friend_offline`）

---

## 6. 迁移路径

### P1（socialsvc 上线，家族迁移）— 第一优先级

目标：家族从 worldsvc 脱离，成为全局持久实体，socialsvc 建立基础。

1. ✅ 建 `server/socialsvc/` 服务（node:http，参照 worldsvc 骨架；`@nw/shared InternalCaller` 加 `socialsvc`）
2. ✅ 建 `nw_social` 库 + families / familyMembers / familyMessages 集合（无 worldId，`FamilyMemberDoc._id = accountId`）
3. ✅ 从 worldsvc 的 `familyService.ts` 搬移代码到 socialsvc，**去掉 worldId**，TAG 唯一索引改为全库唯一
4. ✅ worldsvc `/family/*` 路由改为内部转发到 socialsvc（过渡期兼容，最终删除）
5. ✅ worldsvc `playerWorld` 保留 `familyId` 字段（由"玩家分配大区"时调 `/internal/family/by-account` 填入）
6. ✅ 频道 Redis 宿主切换到 socialsvc；worldsvc 宗门/世界公频改调 `/internal/push`
7. ✅ 反代加 `/social/*` → socialsvc:8085 规则
8. ✅ 存量家族数据迁移脚本：worldsvc families 集合 → nw_social families（去 worldId，TAG 冲突时加后缀）

### P2（好友 / 私聊 / 邮件迁移）— 第二优先级

目标：metaserver 完全卸下社交数据。

1. ✅ socialsvc 建 friendEdges / friendRequests / blockList / conversations / chatMessages / mails 集合
2. ✅ metaserver 好友/私聊/邮件路由改为反向代理到 socialsvc（客户端 URL 不变，内部透传）
3. ✅ 存量数据迁移脚本：`notebook_wars` → `nw_social`（好友边/会话/消息/邮件，in-place 不删原集合，双写过渡）
4. 验证无数据丢失后，metaserver 删除社交路由和集合索引

### P3（gateway presence 事件对接）— 随 P1/P2 完成后

1. gateway 上线/下线时调 socialsvc `/internal/presence/online|offline`
2. socialsvc 实现好友在线通知扇出

---

## 7. 部署拓扑（更新后）

```
公网入口（Cloudflare / Nginx 反代）
  /api/*        → metaserver:8080     账号 / 存档 / 经济 / PvE / 匹配上报
  /world/*      → worldsvc:8084       SLG 地图 / 行军 / 拍卖
  /family/*     → worldsvc:8084       过渡期，P1 完成后切 /social/family/*
  /social/*     → socialsvc:8085      好友 / 家族 / 邮件 / 频道（P1 起）
  /admin/*      → admin:8086          运维后台
  /gw           → gateway:8082        控制面 WS
  /ws           → gameserver:8083     数据面 WS

新增进程：socialsvc（pm2 / docker compose 加一个 service）
新增依赖：Redis（P1 随 socialsvc 一起引入，替代原计划随 worldsvc 引入）
```

---

## 8. 开放问题

| # | 问题 | 当前倾向 |
|---|---|---|
| O1 | 家族加入方式：开放加入 vs 需族长审批？ | 两种模式都支持（`FamilyDoc.joinPolicy: 'open' \| 'approval'`），P1 先做开放 |
| O2 | 存量 worldsvc 家族（有 worldId）的迁移优先级？ | SLG 功能还在开发，现存数据量极少，迁移脚本写好直接跑 |
| O3 | socialsvc 是否需要独立 JWT secret，还是复用 meta 的？ | 复用 meta JWT secret，verifyToken 同一套；避免双密钥管理 |
| O4 | 家族繁荣度（进 SLG 建宗门的门槛）由谁维护？ | socialsvc 记 `prosperity`（家族活跃/捐献累积），worldsvc 读镜像判断门槛 |
