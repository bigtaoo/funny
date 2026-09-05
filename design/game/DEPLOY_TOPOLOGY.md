# 多区域部署拓扑（Deploy Topology）

> 状态：设计中 · 权威：本文（全球部署的区域划分 / 匹配域 / 数据驻留拍板）· 更新：2026-06-23
> 进程拓扑/端口的权威仍是 [`claudedocs/server.md`](../../claudedocs/server.md)；本文只管「同一套代码如何切成多个区域部署」。

---

## 0. 一句话

**Meta 层（账号/天梯/经济/SLG/MongoDB）一份共享，匹配 + 对战层按地理区切开；中国区为完全独立的整套栈。** 同一份代码，靠环境隔离 + 客户端选区实现，匹配核心几乎不动。

---

## 1. 三个 Realm

| Realm | 范围 | 互通 | 备注 |
|---|---|---|---|
| **西方大区** | 欧洲 + 美洲，**单一 realm（账号/天梯/经济/SLG 共享）** | 内部互通 | meta 托管欧洲；对战层按区隔离 |
| **中国区** | 中国大陆境内 | **与西方大区不互通** | 阿里云/腾讯云，ICP 备案，PIPL 数据驻留，独立天梯/经济/SLG 地图 |

> 中国区必须切开的原因：① 跨 GFW 延迟/丢包，实时锁步竞技不可行；② 监管 + 数据出境合规（见 [COMPLIANCE_CN.md](COMPLIANCE_CN.md)）；③ 支付渠道完全不同。结论：同一份代码、独立部署、独立天梯赛季，与西方大区零互通。

---

## 2. 西方大区内部分层

### 2.1 共享 Meta 层（单实例，托管欧洲）
- 进程：`metaserver` · `MongoDB` · `worldsvc` · `commercial` · `admin` · `analyticsvc` · `socialsvc` · `auctionsvc`（自带专属库 `notebook_wars_auction`） · `botsvc`。
- 这些**非帧实时**：美洲玩家跨洋 REST ~150ms 可接受。
- **MongoDB 单主在欧洲，禁止跨大西洋副本集写**（跨洋写延迟会拖垮 meta）。游戏帧永不触库（gameserver 不连库），故对战不受 DB 位置影响。

### 2.2 匹配 + 对战层（按地理区各一套）
- 每区一套 `gateway` + `matchsvc` + `gameserver` 机群（欧洲一套、美洲一套）。
- 两区的 gateway/matchsvc **都指向同一个共享 metaserver**（账号、ELO、match-report 都写共享库）。
- `gateway` 和 `matchsvc` 都是**无状态轻进程、不连库**，多跑一份成本极低。
- `gameserver` 是**纯帧中继、永不连库**，可自由就近部署。

### 2.3 玩家动线
- 客户端按区域（ping 测速选最近 / 或手动选区）连接**该区的 gateway**。
- 进该区 `matchsvc` 的匹配池 → 只和**同区玩家**配对 → 分配**同区 gameserver**（锁步帧 <40ms）。

---

## 3. 匹配规则（拍板）

- **天梯/随机匹配：同区优先。** 每区独立匹配池天然把对战锁在本区内，杜绝跨洋锁步。
- **天梯统一：** ELO 存共享 Meta，故全大区**一个天梯**；对战在本区内进行、ELO 全局累计（业界标准：区域匹配 + 全局天梯）。
- **好友房不受限，允许跨区。** 好友房是邀请制、非天梯对局，延迟由玩家自行接受，不影响竞技公平——因此好友房**不做同区限制**。
- 排行榜展示是「全大区榜」还是「分区榜」留作运营期决定，不影响本架构。

---

## 4. 现有代码与本方案的契合度

调查结论（2026-06-23）：

- ✅ **gameserver 动态注册**：每台启动时把自己的 `NW_GAME_PUBLIC_WS_URL` 报给 matchsvc，匹配成功时 matchsvc 从池里挑一台、把 `gameUrl` 写进 ticket 回传客户端。**加机器即插即用**。
- ✅ **gameserver 永不连库** + ticket 携带 `roomId/gameUrl/seed/side/mode`，任意 gameserver 凭 ticket 一致性校验开房。
- ⚠️ **matchsvc 选服只看负载（load/capacity），无区域感知；ELO 配对也无 region 字段。**
  - 推论：**不能**把欧洲 + 美洲的 gameserver 注册到**同一个** matchsvc，否则会无视地理乱发、跨洋锁步。
  - 解决：**每区一套独立 matchsvc**（即 §2.2 方案）——这样区域隔离来自部署结构，匹配核心代码**无需改动**。

### 4.1 落地需参数化/确认的点（实现期清单）
- gateway → metaserver 地址、match-report → metaserver 地址：确认均为环境变量可配（指向共享 meta）。
- 每台 gameserver 的 `NW_GAME_PUBLIC_WS_URL` 设为自己的区域公网域名（如 `wss://eu.<域名>/ws`、`wss://us.<域名>/ws`）。
- 客户端：增加「区域选择 / 测速选最近 gateway」逻辑 + 各区 gateway URL 配置。
- 好友房跨区：确认好友房创建路径不经过同区匹配池约束（邀请制直连房，本就不入匹配队列）。

> 备选方案（**未采用**）：单一 matchsvc 服务两区。需给 gameserver 注册加 `region` 标签、`QueueEntry` 加 region、改 `pick()` 与配对做区域分桶。省一套运维但动匹配核心代码、且要自己防跨区兜底，**收益不及成本，放弃**。

---

## 5. 机房与渐进上线

- **机房**：Hetzner 同时有欧洲（法兰克福/纽伦堡/赫尔辛基）和美国（Ashburn/Hillsboro）机房，gameserver 为纯中继小机器，**一个厂商覆盖欧美两区**，成本极低。
- **SLG 大世界**：西方一个 SLG realm（欧洲托管），内部按人口分多张地图 shard（单 shard 上限 500 玩家，超出开新 shard），美洲 ~150ms REST——SLG 是确定性围攻/行军调度、**非帧实时**，可接受；中国区另一个独立 realm。
- **渐进顺序**：
  1. 单机起步：现成 compose 在欧洲一台机器跑全栈，验证上线。
  2. 加美洲：Hetzner 美国开 gameserver（+ 一套 gateway/matchsvc），指向欧洲共享 meta。
  3. 进中国：复制整套栈到境内云 + 备案，独立工程。

---

## 5.5 环境变量下发：读到的必须发下去，不发的必须写明理由（2026-09-05）

**规则**：一个服务 `src/` 里出现的每个 `process.env.NW_*`，要么出现在 `docker-compose.cloud.yml` +
`docker-compose.prod.yml` 对应服务的 `environment:` 块和 `ecosystem.config.cjs` 对应 app 的 `env` 里，
要么在 `server/matchsvc/test/deploy-config.test.ts` 的 `NOT_DEPLOYED` 表里带一句理由。没有第三种状态。

由来：`NW_APPLE_PASSWORD` 在 `.env` 里躺了几个月、Apple 验单一直 fail closed（见
[IAP_CREDENTIALS.md §1](IAP_CREDENTIALS.md)）。**compose 只插值它自己写了 `${...}` 的变量，
`server/.env` 里填了什么它一概不看**——这是本条规则唯一要记住的机制。2026-09-05 把当时只覆盖
`commercial` 的那条 lint 推广到全部十个服务，扫出 25 个「代码读了、没人发」的变量。

### 补下发的（6 个，都是真坏了的功能）

| 服务 | 变量 | 缺失时的表现 |
|---|---|---|
| metaserver | `NW_SOCIALSVC_INTERNAL_URL` | **本轮最严重**。P2 起 socialsvc 是好友/私聊/邮件的唯一权威，meta 全部转发给它；缺失 → `nullMetaSocialsvcClient` → `/social/*` 全线 503、系统邮件直接抛 `socialsvc not configured`。**只有 prod 和 pm2 缺**（cloud 一直有），所以从没在 cloud 上暴露过 |
| socialsvc | `NW_ADMIN_INTERNAL_URL` | `WordlistCache` 不启动（`index.ts` 按它 gate），只用内置 `REGION_WORDLISTS`，运营改的敏感词覆盖表永远不生效。安静降级，无日志 |
| admin | `NW_ANALYTICS_BASE_URL` | analyticsvc 明明在同一个 stack 里跑着，admin 却不知道它在哪；`HttpAnalyticsClient.query()` 返回 `{}` 而不是报错 → 数据分析页（事件/DAU/漏斗/留存）**全空白但不报错**。pm2 侧本来就有，两份 compose 都没有 |
| metaserver | `NW_WECHAT_ADS_KEY` | **fail closed**：`POST /ads/callback/wechat` 在它没配时直接返 503，微信激励视频的服务端回调**根本没通**，不是「没验签」而是「没工作」 |
| metaserver | `NW_ADMOB_CLIENT_KEY`·`NW_WECHAT_ADS_CLIENT_KEY` | fail open（不配就放行，只靠 token 唯一性 + 每日上限兜底）。所以缺口的后果是**客户端 adToken 验签永远开不起来**，运营在 `.env` 里怎么填都没用 |
| metaserver | `NW_ALERT_WEBHOOK_URL` | `uncaughtException`/`unhandledRejection` 的告警 POST 静默发不出去 |

后四条和 `NW_APPLE_PASSWORD` 是**一模一样的形状**：`.env.example` 里明明白白列着一行、运营照着填了、
没有任何一条部署路径转发它。

pm2 侧另有一批只差在 `ecosystem.config.cjs` 的（两份 compose 都有）：`nw-meta` 的 `NW_PADDLE_*`
五个（Web 充值凭据，即 §1.1 那张表——**IAP 那半边 09-04/09-05 修了，Paddle 这半边没人管**）、
`NW_REGION`、`NW_LOKI_PUSH_URL`、`NW_REPLAY_ARCHIVE_DIR`；`nw-matchsvc` 的
`NW_MM_BOT_FALLBACK_MS`、`NW_REGION`。本轮一并补齐。

### 故意不下发的（19 个）

理由逐条写死在测试的 `NOT_DEPLOYED` 表里，这里只记分类和几条**不是「调参默认值正确」**的：

- **`NW_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`** — 客户端那头压根没实现。`ACCOUNT_DESIGN.md` SA-2 把它
  挂起等一个能联调的回调域名，`LoginScene` 至今没有 `oauthWait` 视图，没有任何东西会走到 `/auth/oauth`。
  **那个视图上线的那天，这两条要一起删掉。**
- **`NW_GATEWAY_PUBLIC_WS_URL`** — Caddy 把 `/api` 和 `/gw` 放在同一个 origin 下，客户端
  `net/config.ts` 自己推导（`http→ws`、`/api→/gw`）得到的地址本来就是对的；显式下发只会多一个能配错的地方。
  这个变量是给**跨 origin** 部署用的（比如 CI：meta `:18080`、gateway `:8086/gw`）。
- **`NW_GAME_ID`** — **必须不下发**。默认值 `randomUUID()` 正是「重启后按新 id 注册」的机制，
  matchsvc `GameRegistry` 靠 `STALE_MS=30s` 把旧条目淘汰掉；写死反而会让两个实例抢同一个注册条目。
- **`NW_SLG_AUTO_SETTLE`** — 代码读的是 `!== '0'`，即「不显式关就是开」，而开正是 cloud/prod 想要的。
- **`NW_COMPUTE_BACKEND` / `NW_COMPUTE_URL`** — 指向那个还没开始建的独立算力服务（`compute/index.ts`），
  非 `remote` 的一切取值（含未设置）都走进程内 worker 池，也就是 cloud/prod 实际在跑的东西。
- 其余 13 条是纯调参旋钮（限流阈值、采样间隔、TTL、扫描上限、bot 出手概率……），代码默认值就是生产值。

> ⚠️ **留了一个待观察项**：`NW_COMPUTE_POOL_SIZE` 的默认值是 `cpus-1`（`compute/pool.ts`），
> 而 **`os.cpus()` 在容器里报的是宿主机核数**，本仓库又没有任何服务设 cpu limit。目前 worldsvc 是唯一
> 的重算力消费者，先按默认跑；**哪天围攻把机器压垮了，这是第一个该提成真 compose 行的旋钮。**

### 机械门禁

`server/matchsvc/test/deploy-config.test.ts` 的
`deploy config — every service passes through what its source reads` 块。**从 `src/` 推导，不是手写清单**
——新变量从第一次被代码读到那天起自动进入覆盖，不需要有人记得同步测试。表里还有一条反向断言：
`NOT_DEPLOYED` 里的每个变量必须仍然被源码读到，防止例外表攒下一堆早就没人用的名字。

改部署文件后跑一次（`server/` 下）：

```
npx vitest run matchsvc/test/deploy-config.test.ts
docker compose -f docker-compose.cloud.yml config -q
docker compose -f docker-compose.prod.yml config -q
```

（`config -q` 需要 `.env` 里有那几个 `${X:?}` 必填项；临时验证可以 `--env-file` 指一份填了假值的文件。）
---

## 6. 关联文档
- 进程拓扑/端口：[`claudedocs/server.md`](../../claudedocs/server.md)
- meta 架构基准：[META_DESIGN.md](META_DESIGN.md)
- matchsvc 机制：[MATCHSVC_DESIGN.md](MATCHSVC_DESIGN.md) · gateway：[GATEWAY_DESIGN.md](GATEWAY_DESIGN.md)
- 中国合规：[COMPLIANCE_CN.md](COMPLIANCE_CN.md)
- 部署环境变量门禁：`server/matchsvc/test/deploy-config.test.ts`（见 §5.5）
- 决策记录：[DECISIONS.md](../DECISIONS.md) ADR-019
