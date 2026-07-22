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

## 6. 关联文档
- 进程拓扑/端口：[`claudedocs/server.md`](../../claudedocs/server.md)
- meta 架构基准：[META_DESIGN.md](META_DESIGN.md)
- matchsvc 机制：[MATCHSVC_DESIGN.md](MATCHSVC_DESIGN.md) · gateway：[GATEWAY_DESIGN.md](GATEWAY_DESIGN.md)
- 中国合规：[COMPLIANCE_CN.md](COMPLIANCE_CN.md)
- 决策记录：[DECISIONS.md](../DECISIONS.md) ADR-019
