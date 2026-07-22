# Notebook Wars — 元系统与服务器设计文档

> 创建：2026-06-13。本文件是元系统（存档 / 经济 / 养成 / 收集 / 商业化）+ 服务器（云存档 / 好友房联机）的设计基准，随实现推进同步更新。
> 配套阅读：`CAMPAIGN_DESIGN.md`（PvE 战役）、`DESIGN.md`（引擎/系统）、根 `../../CLAUDE.md`。
> 子文档：`META_TASKS.md`（任务拆分）、`UI_DESIGN.md`（客户端 UI）、`SERVER_API.md`（接口契约）、`ECONOMY_BALANCE.md`（经济数值）。
> 细分设计（2026-06-14）：`ACCOUNT_DESIGN.md`（账号/登录/单机门槛）、`COMMERCIAL_DESIGN.md`（commercial 商业服务：钱包/充值/消费/盲盒）、`MATCHSVC_DESIGN.md`（matchsvc 匹配大脑 + gameserver 瘦身 + 局末结算）、`GATEWAY_DESIGN.md`（gateway 控制面网关 + 客户端三通道）。
> 社交（2026-06-16）：`SOCIAL_DESIGN.md`（好友 / 私聊 / 邮件，扩展 meta + 复用 gateway `/gw/push`；帮会/国家频道留 SLG 后 + Redis）。
> SLG（2026-06-16）：`SLG_DESIGN.md`（共享大地图领土争霸 = 赚钱区；宗门=赛季服 / 家族=联盟；围攻战复用确定性引擎 + 录像；养成 PvE+SLG 统一、天梯隔离；拍卖行；第七进程 `worldsvc` + Redis 入场）。

---

## 0. TL;DR

- 元系统 = **两场战斗之间的所有持久层**：存档 / 进度 / 货币 / 养成 / 收集 / 商店 / 盲盒 / UI。
- **一开始就上真服务器**（自购低配 Linux VPS），承载 ①云存档 ②好友房真实时对战。
- 技术栈：**Node.js（TS）+ MongoDB**；服务器与客户端同语言、**共享契约 codegen**（REST=`openapi.yml`、WS=protobuf），只在重大比赛裁判时才 import 确定性引擎复算。
- 联机模型：**服务器权威节拍器**——`gameserver` 每 100ms 下发一批 3 帧（确定性内核保证双端逐 tick 一致）、不模拟只装配命令帧；客户端纯跟随，服务器停发即暂停。
- 货币：**单一货币，服务器权威，绝不可刷**；只能看广告 / 充值获得。
- 养成：**花关卡掉落材料**（非货币），只注入 campaign 引擎；**竞技公平硬墙不破**（见 `CAMPAIGN_DESIGN.md §3`）。
- 物品三来源：关卡奖励 / 商店直购（花货币）/ **盲盒**（稀有物品唯一来源，服务端跑、真随机、逐抽落库）。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| M1 | 一开始就做云存档 + 好友房联机，自购低配 Linux VPS | 朋友一起玩是核心诉求；初期玩家少，单机够用 |
| M2 | 服务器语言 = **Node.js（TS）** | 与客户端同语言、工具链统一；重大比赛要裁判时可直接 import `client/src/game/` 跑同一份确定性引擎，无跨语言发散风险 |
| M12 | **线协议：WS 热路径用 protobuf，REST 保持 JSON**；`PlayerCommand` 对服务器 **opaque（`bytes` 不解码）** | `.proto` 作唯一契约、双端 codegen，服务器**与游戏逻辑零依赖**（改命令结构服务器不用重编）；REST 低频，JSON 利于浏览器/支付回调/调试 |
| M13 | **统一输入管线**：引擎按 tick 从抽象 `InputSource` 消费确认指令集；单机=`LocalInputSource`（客户端自转发，DELAY 0）/ 联机=`NetInputSource` / 回放=`ReplayInputSource`。**录像 = seed + 配置 + 输入流**（不存状态） | SP/MP 同一条管线；确定性内核让"录像=重放输入"，**关卡 + 对局都免费支持回放**；命令已是 protobuf bytes，录像直接复用 |
| M14 | **联机 = 服务器权威节拍器**：模拟 30Hz，但 gameserver **每 100ms（10Hz）下发一个批次 = 3 帧**（`to_frame` 水位 + 仅非空帧指令，空窗就只有 `to_frame`）；不等输入；客户端缓存 ~1 批次（3 帧/100ms）、`to_frame` 比当前靠前才推进、否则暂停 | 单一时钟零漂移；下行 10 msg/s；慢端只拖累自己；服务器是帧序列唯一装配者 → **录像天然落服务端**。延时 = 物理 RTT + ~100ms（非竞技手游可接受） |
| M15 | **REST 契约 = `openapi.yml`（design-first）**，codegen metaserver 路由校验 + 客户端 typed fetch | 与 WS 的 protobuf 对称：契约单一来源、双端 codegen；REST schema 改一处双端同步、且自带文档 |
| M3 | DB = **MongoDB**（存档 + 对局 + 抽卡记录）；Redis 后置 | `SaveData` 是嵌套文档，文档模型天生契合；房间状态初期放内存 |
| M4 | 联机 = **锁步输入中继**，服务器**纯中继不跑引擎**（1v1 无需服务端验证；重大比赛再开裁判） | 确定性内核（定点数 + 注入 Prng + 黄金回放）已铺好路；服务器只转发输入 + 局末 hash 比对查 desync |
| M9 | **拓扑：REST(`metaserver`) 与 WS(`gameserver`) 为两个可独立部署的服务**，共享 `shared` 包；v1 同机两进程 | 两者扩容画像不同：metaserver 无状态可横扩、gameserver 有房间状态需房间亲和（M10） |
| M10 | 断线：in_match 掉线 → 服务器 **60s** 等待 `conn.resume`，超时**掉线方判负** | 好友局只记结果；匹配局结算天梯积分 |
| M11 | match 分 **`friendly`（好友房，仅记结果）/ `ranked`（匹配局，天梯 ELO）**；天梯积分**服务器权威** | 段位不可由客户端伪造，与钱包同级隔离 |
| M5 | **单一货币**，只能广告 / 充值获得，**服务器权威绝不可刷** | 涉及真钱；钱包余额只存服务器，花币动作走服务器事务 |
| M6 | PvE 养成**花关卡掉落材料**，不花货币 | 付费 = 外观 / 盲盒，肝 = 养成，边界最干净 |
| M7 | 盲盒**服务端跑**：`crypto` 真随机 + 逐抽落库 + 保底 | 花币 + 要记录 → 必须服务器扣币、随机、记账 |
| M8 | gacha 随机**不进确定性回放体系** | 它不是战斗逻辑，无需回放；§8 的 Prng 约束只管 `game/` 战斗内核 |

### 1.1 服务边界修订（2026-06-13；2026-06-14 扩为 6 组件，见 §6.1）

> S1 把匹配/房间分配/天梯结算都放在 gameserver 且让它连 Mongo。修订为 **6 组件 + 控制面/数据面分离**：玩家只触达 **meta(REST，请求面)** + **gateway(WS，控制面)** + **game(WS，数据面)**；**matchsvc**（匹配大脑）与 **commercial**（钱包/商业）是玩家不可达的私有服务。目标：**gameserver 永不连库、meta 保持纯编排 REST、钱与交易物理隔离、控制面推送顺畅**。下列决策超越 §1 中 M4/M11 关于 gameserver 结算的描述。

> **三面划分**（理解全局的钥匙）：**数据面**=锁步帧（client↔game 直连，高频低延迟，按 room 分片，绝不经网关中转）；**控制面**=房间/匹配/在线/通知/聊天（client↔gateway，双向实时，按 account 分片，整局会话期常驻）；**请求面**=auth/save/economy/iap（client↔meta REST，纯请求-响应，无状态）。一局里客户端同时持 gateway + game 两条 WS，正常。

| # | 决策 | 理由 |
|---|---|---|
| M16 | **gameserver 永不连库**：退化为 WS 接入 + ticket 验签 + 锁步帧节拍器/中继 + 重连帧日志 + 局末打包上报。无 Mongo、无 Redis、无玩家数据 | 安全隔离边界：game 被攻破也读不到/写不了任何持久数据；无状态（仅内存房间帧缓冲）→ 随意横扩；meta 挂了进行中的对局仍能跑完 |
| M17 | **matchsvc（永远单点，玩家不可达的私有大脑）= 匹配队列 + game 注册表 + 房间分配 + 签 ticket**。Redis 仅作崩溃后数据副本（前期可不加，内存即够）。**不连 Mongo**——匹配要的 ELO 由 gateway 入队时向 meta 取一次带入。所有玩家操作经 **gateway** 转发；game 向 matchsvc 注册上报负载 | 全区单点匹配最简单且无需多实例竞争；game 注册在 matchsvc → 它天然是「谁有空闲 game」唯一知情者，**ranked 与 friendly 共用同一套分配逻辑**（friendly 开局前也只是它内存里的一份房间数据）；签票据信息最全 |
| M20 | **gateway（WS 控制面网关，玩家公开门面）= 薄连接层**：鉴权 WS（`?token=<jwt>`）+ 维护 `account→socket` 映射 + 把房间/匹配消息转发给 matchsvc + 把 matchsvc/meta 事件推回对的 socket；承载房间/大厅/匹配入队取消/match-found+ticket 下发/在线状态/（将来）通知聊天。**它是 matchsvc 的公开门面**——matchsvc 因此保持玩家不可达。**部署粒度**：gateway 与 matchsvc 已拆为**两个独立进程**（M23，S1-M5），经内部 HTTP 互通（gateway→matchsvc 转命令、matchsvc→gateway `/gw/push` 回事件、game→matchsvc 注册心跳）；对外只暴露 gateway 公开 WS，matchsvc 不绑公网。gateway 横扩（多实例）已支持（2026-07-18）：`/gw/push` 走 pub/sub（`GW_PUSH_REDIS_CHANNEL`）+ 跨实例顶号广播，见 `GATEWAY_DESIGN.md §1/§4`、§6.7 | meta 是无状态 REST，推不动 server→client；把长连接放 meta 会破坏其无状态。独立控制面网关让 meta 卸掉转发、回到纯 REST；连接层（按 account）与锁步层（按 room）分片轴不同，必须分开；社交游戏的好友/匹配/聊天迟早要这条常驻连接 |
| M18 | **开局走 matchsvc 签名 ticket**：matchsvc 配对/分配后给每个玩家签一张 ticket（`{room_id, seed, side, opponent, game_url, mode, exp, sig}`，gateway/matchsvc/game 共用一把内部密钥）→ 经 **gateway 推**给客户端 → 客户端连 game 带 ticket，game **只验签 + 交叉核对两张 ticket 的 room_id/seed 一致**即开局 | 开局阶段 game 无需 meta/matchsvc 在线，也不存房间密码表；gateway 只推不签 |
| M19 | **结算上报 game→meta**：局末 game 把 `{room_id, seed, 双方 hash, 双方 winner_side, 非空帧录像}` POST 给 meta（内部密钥鉴权、`room_id` 幂等、失败重试/排队）；**meta 判定胜负 + 写 ELO（乐观锁）+ 归档 + 存录像**。matchmaking/ELO/归档逻辑全部从 gameserver 移出 | game 一行 DB 不碰（M16 落地）；meta 暂时 down 不丢结果（game 端排队重试） |
| M21 | **commercial（钱包/商业服务，玩家不可达，连自己专属库）= coins 余额 + 流水 + 订单 + 充值票据 + 盲盒 RNG + 保底**。独立 Mongo 数据库 `notebook_wars_commercial`（与 meta 库物理隔离）。**meta 是其唯一调用方**（编排者）：客户端经济请求仍只发 meta，meta 经内部 RPC 调 commercial 扣币/随机/记账，据结果写 inventory（meta 库）并回推。钱包权威从 `saves.wallet` 迁出，`SaveData.wallet/gacha` 降级为只读镜像 | 真钱数据物理隔离（meta 出 bug 也碰不到余额/充值流水），审计/对账/合规边界清晰；抽卡「扣币+随机+记账」同库原子（M7）；客户端只认 meta，零改动。详见 `COMMERCIAL_DESIGN.md` |
| M22 | **服务间通信 = 内部 HTTP/REST（`X-Internal-Key`，JSON）；不引 gRPC；MQ 暂缓、将来用 Redis 兼做** | 详见 §6.7 ADR。本项目内部调用极低频且多为同步请求-响应，HTTP 零新基建、与外部 API 同栈；gRPC 的 polyglot/高频流式优势本项目不占且有 Node-on-Windows 原生依赖坑；MQ 待「异步+持久化」场景出现再用 Redis（gateway 横扩本就需要它），不背独立 MQ |
| M23 | **gateway 与 matchsvc 拆为独立进程**（S1-M5，2026-06-14）；不再「前期合一进程」 | 连接层（按 account 分片，gateway）与匹配大脑（全区单点内存态，matchsvc）扩容轴不同，提前拆清边界；两者经内部 HTTP 互通（M22）。matchsvc 仍玩家不可达，gateway 是其唯一公开门面 |

---

## 2. 信任边界（M5 的物理落地，写代码前必读）

货币涉及真钱 → 服务器权威；PvE 进度对 PvP 零影响（硬墙）→ 可客户端同步 + 轻校验。**两类数据物理分开存、分开校验：**

| 类别 | 字段 | 谁权威 | 写入方式 |
|---|---|---|---|
| **commercial 权威**（客户端只读，`saves` 里仅镜像） | `wallet.coins`、`gacha.pity` + 抽卡历史、充值票据、消费订单/流水 | **commercial**（独立库，M21） | 钱包**单文档原子更新**（`wallets`，§6.3）；meta 经内部 RPC 调用、据回执写 inventory + 镜像。详见 `COMMERCIAL_DESIGN.md` |
| **meta 权威**（客户端只读） | `inventory`（皮肤/物品）、`pvp` 天梯（elo/rank/战绩） | metaserver | inventory 由 meta 收 commercial 发货回执后写；天梯由 meta 在收到 game 局末上报后结算写入（M19；订正 2026-07-07：已从 gameserver 迁至 meta，2026-06-14 落地，见 `MATCHSVC_DESIGN`） |
| **客户端同步**（轻校验） | `progress`（通关/星级/记录）、PvE 材料 + `pveUpgrades`、设置 `flags`、`equipped`（皮肤选择） | 客户端 | 本地写 + 防抖上行；服务器做 sanity 校验（单调性 / 上界），但不强反作弊 |

> 取舍：PvE 材料/升级被改 → 只是自己 PvE 变简单，**对 PvP 无影响**（硬墙），不值得上重型反作弊。真钱相关零容忍。

---

## 3. A — 存档模型 + 云存档

### 3.1 数据模型（单一权威根）

```ts
// game/meta/SaveData.ts  （纯数据，无 PIXI / 无平台依赖）
interface SaveData {
  version: number;            // schema 版本，迁移用
  accountId: string;          // 云存档身份（§3.3）
  rev: number;                // 单调递增修订号，乐观锁 / 冲突解决
  updatedAt: number;          // 服务器时间戳（仅展示，客户端不可信）

  // —— 服务器权威段（客户端只读，§2）——
  wallet: { coins: number };
  inventory: {
    skins: string[];                    // 拥有皮肤 id
    items: Record<string, number>;      // 其他可堆叠物品 / 碎片
  };
  gacha: { pity: Record<string, number> }; // 各盲盒保底计数；抽卡历史另存集合
  pvp: {                                   // 天梯（仅 ranked 局更新，gameserver 结算）
    elo: number; rank: string;
    wins: number; losses: number; streak: number;
  };

  // —— 客户端同步段（轻校验，§2）——
  progress: {
    cleared: string[];                  // 已通关 levelId
    stars: Record<string, 1|2|3>;       // 每关最高星
    best: Record<string, LevelRecord>;  // 用时 / 漏怪等，排行榜 & 挑战用
  };
  materials: Record<string, number>;    // 关卡掉落材料（PvE 升级货币，M6）
  pveUpgrades: Record<string, number>;  // 升级 key → 等级（硬墙隔离）
  equipped: Record<string, string>;     // unitType → 装备皮肤 id（纯外观）
  flags: Record<string, boolean>;       // nw_seen_intro 等通用标记
}
```

> 所有元系统状态挂在 `SaveData` 这一根上。`pveUpgrades` 单独成段，物理上与 PvP 隔开（硬墙第一道边界）。

### 3.2 持久化抽象 + 版本迁移

```ts
interface SaveStore {
  loadLocal(): SaveData | null;          // 复用 IPlatform.storage（key: nw_save_v1）
  saveLocal(d: SaveData): void;
  pull(accountId: string): Promise<SaveData | null>;
  push(d: SaveData): Promise<PushResult>; // 带 If-Match: rev 乐观锁
}

const MIGRATIONS: ((d: any) => any)[] = [ /* v0→v1, v1→v2 ... */ ];
function migrate(raw: any): SaveData { /* 按 version 顺序套用 */ }
```

> **最易后期返工点**：开局即埋 `version` + 迁移链，否则改字段废老存档。

> **不变量（2026-07-03 修）**：`migrate()` 的入参含 **cloud** 存档，不止 localStorage。任何采纳云存档的路径（`SaveManager.reconcile` / `adoptCloud`，即 bootstrap/refresh/adoptServer/putSave 409）都必须先过 `migrate()` 归一化，否则旧账号云端缺失的「客户端专属新字段」（如 v4 `cardInv`/`equipmentInv`）会以 `undefined` 落入 `this.save` → 开战 `Object.values(cardInv)` 抛 `TypeError: can't convert undefined to object`（线上返场玩家点战役必崩）。`MIGRATIONS` 链长须与 `SAVE_VERSION` 对齐（v0→…→v4 齐全）。

### 3.3 云存档（自托管 Node + Mongo）

| 层 | v1 做法 | 说明 |
|---|---|---|
| **身份** | 匿名账号：微信 `wx.login`→code 换 openid；Web/CrazyGames 用设备 UUID（本地持久化）作 key | 零摩擦，无注册登录；`accountId` 预留后期绑手机 / 第三方 |
| **同步协议** | 离线优先 + 服务器权威：启动 `pull` → 比 `rev` → 本地高则 `push`、云高则覆盖本地；写操作先写本地、防抖 2s 后 `push` | LWW + 单调 `rev` |
| **冲突** | `push` 带 `If-Match: rev`，服务器 rev 更高返回 409 → 客户端 `pull` 后合并：`progress` 取并集、**服务器权威段一律以服务器为准** | 钱永远服务器说了算 |
| **服务器权威段写入** | **不经过 save push**：买东西 / 开盲盒 / 充值是**独立服务器 API**，直接改 Mongo 钱包 + 库存，再回推最新 `SaveData` | 客户端永不直接写 `wallet` |

---

## 4. C — 经济系统

### 4.1 货币流向（单币，服务器权威）

```
货币「coins」
┌── 产出 (Sources) ────────────────────────┐
│ • 看激励广告   +N / 次，每日上限 cap       │  ← 服务端验证广告回调
│ • IAP 充值     礼包档位                     │  ← 服务端验单
└────────────────────────────────────────────┘
┌── 消耗 (Sinks) ──────────────────────────┐
│ • 商店直购物品 / 皮肤   定价表             │
│ • 开盲盒                单抽 / 十连         │
│ （PvE 升级不花货币，花关卡材料 → §5）     │
└────────────────────────────────────────────┘
每日广告：SaveData 服务端记 { dayKey, watchedToday }，到 cap 拒发
```

### 4.2 盲盒 / Gacha（服务端跑）

```ts
interface GachaPool {
  id: string;
  costSingle: number;
  costTen?: number;                 // 十连，常给折扣
  entries: { itemId: string; weight: number; rarity: Rarity }[];
  pityThreshold?: number;           // N 抽必出最高稀有
  dupePolicy: 'shards' | 'coins';   // 重复转碎片 / 退币
}
type Rarity = 'common'|'rare'|'epic'|'legendary';
```

**服务端单次抽卡事务**（原子）：
1. 校验 `wallet.coins ≥ cost` → 否则拒。
2. `crypto` 真随机按 `weight` 抽（**非 Prng**，M8）；命中保底则强制最高稀有。
3. 扣币 → 发货（已有则按 `dupePolicy` 转化）→ 更新 `pity`。
4. **逐抽写 `gachaHistory` 集合**：`{ accountId, poolId, itemId, rarity, cost, rev, ts }`（M7 要求的记录）。
5. 回推最新 `SaveData`。

> 稀有物品（legendary 皮肤）**只在盲盒池**。保底 `pity[poolId]` 防黑脸。

### 4.3 平衡曲线
- 货币产出/消耗、定价、盲盒权重与保底、材料掉落、养成成本、F2P 推演的**数值单一来源在 `ECONOMY_BALANCE.md`**（DRAFT 初值，待实测调参）。

---

## 5. D — 养成 + 公平性硬墙

### 5.1 升级树（花材料，M6）

```ts
interface PveUpgradeDef {
  id: string;                 // 'inf_hp', 'archer_dmg'
  unitType: UnitType;
  stat: 'hp'|'damage'|'speed'|'range';
  maxLevel: number;
  costCurve: { material: string; amount: number }[]; // 每级花关卡掉落材料
  effectPerLevel: number;     // 每级 +x%（乘算）
}
```

### 5.2 硬墙物理实现（最关键，见 `CAMPAIGN_DESIGN.md §3`）

```ts
// PvP 路径：只读常量，签名里根本不出现 SaveData → 编译期不可能串味
function buildPvpBlueprints(): UnitBlueprints {
  return cloneDeep(UNIT_BLUEPRINTS);
}
// PvE 路径：常量 + 修饰层（唯一注入点）
function buildCampaignBlueprints(save: SaveData): UnitBlueprints {
  const bp = cloneDeep(UNIT_BLUEPRINTS);
  applyPveUpgrades(bp, save.pveUpgrades);
  return bp;
}
```

**硬墙单测（必写）**：满级 `SaveData` 构造 PvP 引擎，断言 `blueprints` 与 `UNIT_BLUEPRINTS` **逐字相等**。

**皮肤**：逻辑层 `game/` 完全不 import 皮肤；渲染层 `UnitView`/`StickmanRuntime` 按 `equipped` 选贴图。带进 PvP 只换图、不碰数值。

---

## 6. 服务器架构（Node + TS + MongoDB）

> 接口契约（REST 端点 + WebSocket 消息 + 锁步时序 + DB 集合）的单一来源在 **`SERVER_API.md`**。

### 6.1 拓扑：6 组件 + 控制面/数据面分离（M9 / M16–M21）

> **范畴说明**：本节「6 组件」是 **meta 范畴**（S0–S5）。全系统后来加了 admin / worldsvc / analyticsvc / socialsvc / auctionsvc / botsvc，
> 共 **11 个应用进程**——全量清单见 `design/README.md` §4 与 `claudedocs/server.md`。

> **架构修订（2026-06-13；2026-06-14 加 commercial）**：玩家只触达 **meta(REST)** + **gateway(WS 控制面)** + **game(WS 数据面)**；**matchsvc**（匹配大脑）+ **commercial**（钱包/商业，连自己专属库）对玩家不可见。S1 现实现是 gameserver 中心式（自管匹配/分配/结算且连 Mongo），按此修订迁移。

```
                  请求面 REST(无状态)              内部 RPC(内部密钥)
客户端 ───────────────→ metaserver ──────────────→ MongoDB(notebook_wars)
  │  auth/save/economy/iap   │  ↑ game 局末上报(幂等 room_id)  (仅 meta 连)
  │                          │  charge/draw/recharge/balance
  │  控制面 WS(?token)        └────────────→ commercial ──→ MongoDB(notebook_wars_commercial)
  ├───────────────→ gateway ┐                (钱包/流水/订单/充值/盲盒，玩家不可达)
  │  房间/匹配/在线/通知/聊天   │ 内部 RPC
  │  (双向实时)               │  enqueue/cancel·房间分配
  │              ←(game_url,  ↓  ←签好的 ticket
  │                ticket 推)  ┌────────────────────────┐
  │                           │ matchsvc（单点·私有大脑） │
  │                           │ 匹配队列(全区)·房间状态    │
  │  数据面 WS(?ticket 直连)    │ ·game 注册表/分配·签 ticket│
  └───────────────→ gameserver(N 台) ──── register/心跳 ──┘

  gateway 与 matchsvc 各为独立进程（M23，经内部 HTTP 互通 M22）；commercial 独立进程+独立库（M21）；Redis 仅 matchsvc 崩溃副本(可省)
反代：/api/*→meta(JSON) · /gw→gateway(WS) · /ws→gameserver(WS protobuf)；matchsvc/commercial 不暴露公网
```

各服务职责与连库边界：

| 服务 | 面 | 职责 | 连库 | 扩容画像 |
|---|---|---|---|---|
| **metaserver** | 请求面 | auth · save · 经济编排（调 commercial）· 接收 game 局末上报→判定/写 ELO/归档/存录像 · 给 gateway 供 ELO | Mongo `notebook_wars` | 无状态可横扩（LB 轮询） |
| **commercial** | 私有(商业) | 钱包余额 + 流水 + 订单 + 充值票据 + 盲盒 RNG/保底；meta 唯一调用方（M21） | Mongo `notebook_wars_commercial`（独立库） | 与钱强相关，谨慎扩；前期单实例 |
| **gateway** | 控制面 | 薄连接层：鉴权 WS + `account→socket` 映射 + 房间/匹配命令经内部 HTTP 转发 matchsvc + 推回事件（含 ticket）+ 在线状态 | ❌（独立进程，M23；横扩后连 Redis） | 有状态（连接亲和）；横扩需 `account→实例` 路由（Redis），属后期 |
| **matchsvc** | 控制面(私有) | 匹配队列（全区）· 房间状态 · game 注册表/负载/分配 · 签 ticket；独立进程（M23），经内部 HTTP 接 gateway 命令 + game 注册 | Redis only（可选） | 永远单点（M17） |
| **gameserver** | 数据面 | WS 接入 · ticket 验签 · 帧节拍器/中继 · 重连日志 · 局末打包上报 meta | ❌ 永不（M16） | 无状态（仅内存房间帧缓冲）→ 随意横扩；房间亲和靠 ticket 里的 `game_url` 天然绑定 |

> **服务器与游戏逻辑零依赖**（M12）：三服务都只 codegen `transport.proto`/`replay.proto`，`PlayerCommand` 作 `bytes` **opaque 转发/存储不解码**；`game.proto` 永不进服务器。改命令结构服务器不用重编。仅"重大比赛裁判"才让 meta 额外 import 真 `GameEngine` + `game.proto` 跑复算。
> **「其他先放 meta、以后好拆」**：经济/好友等暂在 meta 内，但 meta↔matchsvc 已是清晰的内部 RPC 边界，将来把任一模块切成独立服务，复用同一套内部密钥 + 服务注册即可。

### 6.2 联机模型：服务器权威节拍器（gameserver，M14）

确定性内核（定点数 `fixed.ts` + 注入 `Prng` + 黄金回放）让两客户端喂相同帧序列 + 同 seed → 逐 tick 完全一致。**模拟 30Hz；gameserver 不模拟、只装配命令 + 持时钟、每 100ms 打包 3 帧下发：**

```
建房 → 房间码 → 输码加入 → 双方 ready → match_start{ seed, start_frame }
  → gameserver 每 100ms（10Hz）下发 frame_batch{ to_frame, frames }（覆盖 3 个 sim 帧）
    · 收到 cmd_submit → 塞进「当前 100ms 窗口对应的帧」（两端拿到同帧同指令）
    · 无指令 → 批次里只有 to_frame 水位，frames 为空
    · 客户端缓存 ~1 批次（3 帧 ≈100ms）
  → 客户端 to_frame 比当前靠前才推进（按 30Hz 播完这 3 帧），否则暂停（可见）
```

- 模拟帧 = sim tick（33ms）；网络包 = 10Hz 批次（3 帧）。**延时 = 物理 RTT + ~100ms**（1 批次缓冲，可配置）。指令不预盖 LEAD，收到即塞当前帧。
- gameserver 转发 `commands` **字节流不拆包**（不认识 PlayerCommand，M12）；**同帧多指令需确定性 tiebreak**（按 `side`），否则两端应用顺序分歧。
- **空闲零上行**：客户端只在出牌时发 `cmd_submit`；`frame_batch` 流是唯一"可前进"信号 → 服务器停发 ⇒ 客户端暂停。
- **抖动分三档**：<100ms（1 批次）缓冲透明吸收 / 超出该端短暂卡住再快进追帧（对手不受影响）/ 彻底掉线才暂停。
  - **追帧倍速**：`GameEngine.tick()` 按 `NetInputSource.confirmedLead`（播放头之后的已确认积压帧）选倍速——落后 >3s→10× / >1s→5× / >0.1s（`CATCHUP_MIN_LEAD`=一个批次）→3× / 否则 1×；缩短每步 `stepDt` 让暂停或最小化（rAF 停摆）后落后的客户端加速排帧追上水位线，追上自动落回 1×。只重定时 step、不改帧序，锁步确定性不受影响。**关键**：`confirmedLead` 已减去 100ms 抖动缓冲，故只要 >0 就是缓冲外的真积压；档位一路排空到 ≈ 缓冲本身（稳态延迟 ~0.1–0.2s），而非旧版停在 1s（旧 `else 1×` 死区会让任何卡顿后的 <1s 落后永久保持——节拍器同速，1× 追不动，落卡要等 ~1.1s 才上屏）。追帧下限不低于一个批次，否则会去追每个正常批次、与节拍器打架引发微抖。
    - **包装器必须透传 `confirmedLead`（2026-07-16 修复）**：在线对局在 `nav/result.ts` 里用 `RecordingInputSource` 包裹活的 `NetInputSource`（为录像捕获），引擎实际持有的是这个包装器。`confirmedLead` 是 `InputSource` 上的**可选**方法，而 `RecordingInputSource` 之前只转发了 `submit/take`，漏了 `confirmedLead` → `catchUpSpeed()` 的 `this.input.confirmedLead?.() ?? 0` 恒取 0 → **在线追帧被完全关掉、永久停在 1×**（上面的死区阶梯虽在但收不到非零 lead）。现象：最小化再切回后不快进、出牌要等十几秒才上屏、帧照常到达故无"等待对手"转圈。修复：`RecordingInputSource.confirmedLead()` 委托内层（内层无则返回 0，保持单机录制的 1× 语义）。回归测试见 `client/test/replay-input-source.test.ts`。
- **断线（M10）**：in_match 掉线 → gameserver 停发该房间批次 + `peer_dc{grace_ms:60000}` 起 **60s**；`conn_resume` 续发续打；**超时掉线方判负**。
- **局末（修订 M19）**：game 把 `{双方 hash, 双方 winner_side, 非空帧录像}` 打包 POST 给 **meta**；meta 比对查 desync（纯字符串比；非反作弊，是确定性回归探针）、判定胜负、归档、存录像。game 不连库、不判定。
- **match 类型（M11）**：`friendly`（meta 仅写 `matches` 记结果）/ `ranked`（**meta** 收到 game 上报后结算 ELO 写 `pvp` 段，服务器权威；订正 2026-07-07：已从 gameserver 迁至 meta，2026-06-14 落地，见 `MATCHSVC_DESIGN`）。
- **录像**：game 是帧序列唯一装配者 → 非空帧日志即录像，局末随结算上报交给 meta 落库（§6.6）。

### 6.3 数据库写型（避开多文档事务）

> ⚠️ MongoDB 多文档事务**仅副本集可用**。两条对策：

- **钱包/发货 = 单文档原子更新**：`findOneAndUpdate({_id, "wallet.coins":{$gte:cost}}, {$inc, $push})`——买/抽/广告都是单账号操作，落在一个 `saves` 文档里，**无需事务**，且 `$gte` 守卫防超扣。
- **部署仍配单节点副本集**：资源占用几乎相同（`rs.initiate()` 一次），解锁跨集合写（如 IAP `iapReceipts`+`wallet`）的事务，顺带可用 change streams。

### 6.4 部署与成本（Linux VPS）

最低配 **2C2G**（MongoDB WiredTiger 缓存让 2GB 成舒适地板；1GB 易 OOM）。Redis 初期不上。

| 路线 | 配置 | 月成本 | 备注 |
|---|---|---|---|
| 国内·腾讯云 / 阿里云轻量 | 2C2G 4M | 首年促销 ≈¥99/年（¥8/月）；续费 ¥50–70/月 | 国内快，需 **ICP 备案**（免费，约 1–2 周） |
| 海外·Hetzner CX22 | 2vCPU/4G/40G | ≈€4.5/月（¥35） | 性价比最高，无备案；国内延迟较高 |
| 海外·Vultr/DO | 2G | $12/月（¥85） | 可选近区节点 |
| DB 省钱 | MongoDB Atlas **M0 免费层** 512MB | ¥0 | DB 卸到云、VPS 只跑 Node；数据涨了再迁 |

**最省现实组合**：国内轻量首年 ¥99 + 域名 ¥30–60/年 + Let's Encrypt 免费 → **首年 ≈ ¥130–160（¥11–13/月）**；续费 ≈ ¥55–75/月。

### 6.5 扩展路径（日活上千→上万）

按 M9 的两服务画像分别扩，不一刀切：

| 触发 | metaserver（无状态） | gameserver（有状态） |
|---|---|---|
| 日活上千、单机吃紧 | LB 后加副本，DB 拆出独立实例 | 仍单实例够；房间状态内存 |
| 日活上万 | 多副本横扩（轻量、便宜） | 加实例天然房间亲和：**matchsvc 分配时把目标实例写进 ticket 的 `game_url`**，两条 WS 凭同一 ticket 落同一实例，无需一致性哈希或跨实例目录 |

> 修订后 game 实例池由 **matchsvc 注册表**持有（M17）；扩 game 只是多注册几台，matchsvc 按负载分配。Redis 仅 matchsvc 的崩溃副本（M17），非 game 的房间目录——这是新设计相对 S1 的简化。

### 6.6 统一输入管线 + 录像（M13）

确定性内核让 SP / MP / 回放可以共用一条输入管线。引擎每 tick 从抽象 `InputSource` **拉取该 tick 确认指令集**，不关心来源：

| 实现 | 用于 | DELAY | 指令来源 |
|---|---|---|---|
| `LocalInputSource` | 单机 PvE / 练习 | 0（即时） | 客户端**自转发**：本地出牌即入队当前 tick |
| `NetInputSource` | 联机对战 | ~1 批次(3 帧)缓冲 | gameserver 节拍器下发的 `frame_batch`（M14） |
| `ReplayInputSource` | 回放 | — | 录像文件的 `FrameCmds[]` |

三者都产出 `FrameCmds{frame, cmds}`，引擎逻辑逐字相同。**命令入口从「UI 直接 `processCommand`」改为「提交进 `InputSource`、引擎每 tick 消费确认集」**，AI（练习）/ WaveDirector（PvE）作为另一种 tick 内输入源接入。

**录像 = `seed` + 配置 + 输入流，从不存状态**（字段以 `SERVER_API.md §6` 的 `replay.proto` 为准）：

```proto
// replay.proto —— 复用 transport.proto 的 FrameCmds
message Replay {
  uint32 engine_version = 1;  // 绑引擎版本（回放前校验，见下）
  string mode = 2;            // campaign | pvp
  uint64 seed = 3;
  string config_ref = 4;      // PvE=levelId+version；PvP=rosterVer
  repeated FrameCmds frames = 5;   // 只存非空帧；commands 仍是 protobuf bytes
  uint32 end_frame = 6;       // 总帧数（空帧不存，靠它界定终点）
  ReplayMeta meta = 7;
}
```

- 回放 = 同 `seed` 起新引擎 + 按 tick 喂录像输入流 → 逐 tick 完全还原。
- **PvE 只记玩家指令**（敌方由 `WaveDirector` 从 seed+level 确定性生成，不记，回放时重算）；**PvP 记双方**——gameserver 为重连保留的输入日志**即录像**，服务端录制零额外成本。
- 落地：PvE 客户端本地存（可选上传分享）；PvP gameserver 持久化到 `matches`/对象存储 → 服务端回放 / 分享 / 纠纷复核 / 裁判复算。
- ⚠️ **脆弱点**：录像绑 `engineVersion`，引擎逻辑改动后老录像可能回放发散，回放前必须校验版本（确定性回放方案的通用代价）。已有的黄金回放确定性测试天然延伸为整局录像的回归守卫。
- **存储清理（2026-07-20）**：`matches` 曾经无 TTL，3 真人 + 100 bot 上线仅一周就跑出 39K 局 / 296MB，是 Atlas 存储告警的唯一来源（其余 collection 均为 KB 级）。现改为：非争议对局（`hashMismatch`/`cheat` 均不存在）写入时打 `expireAt`（**7 天** TTL 索引——bot 刚上线一周，30 天窗口起不到清理作用，故收紧到 7 天），争议对局永久保留供 ops 复核/反作弊审计追溯；`replayBlobs`（外部大录像，实测一直是空表）镜像同一 `expireAt`。存量数据由一次性脚本 `server/metaserver/scripts/backfillMatchExpiry.ts` 回填（dry-run 确认 34,040/39,000 条非争议对局会被标记）。

### 6.7 服务间通信选型（ADR，2026-06-14 定）

> 背景：服务端是单 VPS 上的 4 个 Node(TS) 进程（meta / gateway / matchsvc / game），服务间调用量极小且多为同步请求-响应（gateway→meta 取 ELO、game→meta 局末上报、gateway↔matchsvc 房间命令/事件、game→matchsvc 注册心跳）。在 gRPC / HTTP(REST) / 消息队列(MQ) 三者间定调。

**决策（M22）：内部调用一律走内部 HTTP/REST（`X-Internal-Key` 鉴权，JSON body）；不引 gRPC；MQ 等到出现「必须异步 + 必须持久化」的场景再上，且优先用迟早要装的 Redis 兼做 pub/sub + 轻量队列，而非单独部署 Kafka/RabbitMQ。**

| 方案 | 结论 | 理由 |
|---|---|---|
| **HTTP/REST**（采用） | 内部同步调用的主干 | 已在用（meta 内部路由 + gateway↔matchsvc 命令/推送）；零新基建、与对外 API 同栈、curl 可调；契约漂移由 openapi/proto 单一来源 + JSON 镜像类型压住；本项目一局才一次 ELO/上报的量级，文本开销无感 |
| **gRPC**（不采用） | 解决的是本项目还没有的问题 | 赢在 polyglot / 高频内部 RPC / 双向流——三者本项目都不占（全 TS、流式已被数据面 WS 吃掉、内部 RPC 极低频）；且 Node gRPC 在 Windows 有原生依赖坑（本仓已记 grpc-tools `protoc.exe` 0xC0000135，故弃 grpc-tools 改 buf），再引 HTTP/2 反代复杂度不偿失 |
| **消息队列**（暂缓，方向已定） | 有真实价值但现在错时机 | 将来撞上：①局末结算可靠投递（现 game→meta 是内存重试队列，进程挂则丢）②经济/盲盒/IAP webhook 事件驱动记账 ③天梯/成就异步 fan-out。届时引 **Redis**（gateway 多实例化的 `account→实例` 路由本就需要它，是刚需）兼 pub/sub + Stream 轻量队列，一个组件解决路由 + 异步两件事，不背独立 MQ 运维 |

**升级触发条件**（满足任一再重新评估）：①局末结算/经济写账需要跨进程崩溃不丢 → 引 Redis Stream；②gateway 单实例连接数撑不住要横扩 → ~~引 Redis 做 `account→gateway` 路由~~ **已于 2026-07-18 落地**（见下）；③出现 Kafka 级吞吐（本品类大概率到不了）→ 再议专用 MQ。在此之前，新服务间调用一律复用内部 HTTP + `NW_INTERNAL_KEY`。

> matchsvc↔gateway 拆进程后即按此落地：gateway→matchsvc 命令、matchsvc→gateway 事件推送（`/gw/push`）、game→matchsvc 注册心跳全是内部 HTTP（§8 / `MATCHSVC_DESIGN.md`）。**②已落地**：matchsvc 配置 `NW_REDIS_URL` 后，`/gw/push` 改为发布到 `GW_PUSH_REDIS_CHANNEL`（pub/sub，与 worldsvc 共用同一通道），每个 gateway 实例只投递本地在线的账号；未配置 Redis 仍退化为固定地址直连 HTTP（单实例）。同一通道也承载跨实例顶号广播（`{kick:{accountId, originInstanceId}}`，`GATEWAY_DESIGN.md §1`）。没有引入单独的 `account→gateway 实例` 注册表——路由与顶号都靠"广播 + 各实例自己过滤本地在线状态"解决，比维护一张实时准确的实例映射表更简单也更抗抖动。

### 6.8 日志与可观测性（S1 联调起，详见 `server/observability/README.md`）

**Phase 1（已落地）**：五进程共用 `@nw/shared` 的 `createLogger(service)`，双 sink——控制台可读单行 +（`NW_LOG_DIR` 设置时）`<service>.log` 每条一行 JSON（`{t,level,svc,msg,...data}`，append、按根服务名分文件、Loki-ready）。级别 `NW_LOG_LEVEL`。`dev-up.ps1` 自动注入 `NW_LOG_DIR=server/logs`。埋点覆盖匹配全链路（WS 连/断、控制命令收发、ranked 入队/配对/开局、`GAME_UNAVAILABLE`、push 下发/丢弃、跨服务 HTTP 失败）。**correlation id = `roomId`** 贯穿 matchsvc→gateway push（`/gw/push` 体携带，仅日志）+ game/meta，可按整局聚合。客户端 `net/log.ts` 同期落地（控制台 + 全局异常钩子，不上送服务端）。

**Phase 2（后期做）**：Loki（存储）+ Grafana Alloy（tail `server/logs/*.log` 或 Docker stdout）+ Grafana（查询 `{svc=…} | json | roomId=…`）。docker-compose 观测栈 + Alloy 配置待建，方案与示意配置已记入 `server/observability/README.md`。

---

## 7. G — 元系统 UI / 场景

### 7.1 场景流

```
启动 → (首次)IntroScene → LobbyScene(大厅·中枢)
                                ├─→ CampaignMapScene  选关(章节地图·星级·解锁)
                                │       └─→ LevelPrepScene 关前编成 → 战斗 → ResultScene(评星·奖励·解锁)
                                ├─→ ShopScene         商店(直购) + GachaScene(盲盒开箱)
                                ├─→ CollectionScene   收集册/衣柜(皮肤预览·装备)
                                ├─→ RoomScene         好友房(建房/输码加入/ready/开打)
                                ├─→ ProfileScene      档案(账号·云同步状态·成就)
                                ├─→ SettingsScene     语言/音量(复用现有 i18n)
                                └─→ PvP 入口(现有对战 / 联机)
```

### 7.2 各场景职责（复用 `LobbyScene` 模式）

| 场景 | 核心元素 | 依赖 |
|---|---|---|
| `CampaignMapScene` | 章节→关卡节点图、星数、锁态、进关 | 进度 |
| `LevelPrepScene` | 关前编成 / 养成预览 / 开打 | 养成 |
| `ResultScene`（已有，扩展） | 评星动画、奖励发放、解锁弹窗 | 进度+经济+养成 |
| `ShopScene` | 余额、商品格、IAP 礼包、购买确认 | 经济（服务端） |
| `GachaScene` | 盲盒选择、单抽/十连、开箱动画、保底进度 | 经济（服务端） |
| `CollectionScene` | 皮肤网格、预览、装备/卸下 | 库存 |
| `RoomScene` | 建房/房间码/加入/ready/进对局 | room-service |
| `ProfileScene` | 账号/云同步状态/手动同步/成就墙 | 云存档 |

> 文案全走 i18n，新增命名空间：`meta.*` / `shop.*` / `gacha.*` / `collection.*` / `room.*`（`zh.ts` 为键唯一来源，`en`/`de` 编译强制全翻）。

---

## 8. 横切约束

1. **公平性硬墙**：钱 / 升级只写 `SaveData`，PvP 引擎构造时不接受该来源（§5.2 + `CAMPAIGN_DESIGN.md §3`）。
2. **确定性**：战斗内核（`game/`）严禁 `Math.random()`，走注入 `Prng`；锁步联机依赖此。**gacha 例外**（§4.2，服务端 `crypto` 真随机，不进回放）。
3. **i18n**：零硬编码文案。
4. **多平台存储**：web / 微信差异封在 `IPlatform`。

---

## 9. 分期实施路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| S0 | `server/` 骨架 + Mongo + save-service + 匿名账号 + 客户端 SaveStore + 迁移链 | 多设备云存档同步跑通 |
| S1 | room-service + gameserver 锁步中继 + RoomScene | 两台真机好友房对局一致、可重连 |
| S2 | economy-service：钱包 + 商店 + 盲盒（落库）+ 广告校验 + ShopScene/GachaScene | 服务器权威钱包，刷不动 |
| S3 | PvE 养成（材料 + 硬墙单测）+ CampaignMapScene + 收集册 | 完整养成 / 收集闭环 |
| S4 | iap-service 验单 + 礼包（上线前必做）+ 反作弊 hash 比对 | 充值安全 |

> 先 S0/S1 把"云存档 + 好友联机"立起来（核心诉求），再 S2/S3 铺经济与养成。

---

## 10. 开放问题（待定）

- [ ] 经济平衡曲线：每日广告 cap、商品 / 盲盒定价、材料掉落速率（§4.3）。
- [ ] 盲盒稀有度权重与保底阈值。
- [ ] PvE 材料种类（按单位分 / 通用材料）与升级成本曲线（§5.1）。
- [ ] 反作弊力度：S4 hash 比对是否够，要不要服务器全程当裁判。
- [ ] 微信小游戏侧：联机合规、IAP（虚拟支付）合规、备案。
- [ ] 随机匹配（非好友房）排期与 ELO / 段位。

> 下列原「循环缺口」已定方向，详见 §11；本节仅保留尚未定的数值/合规项。

---

## 11. 元循环系统补全（日常 / 赛季 / 天梯 / 装备）

> 2026-06-13 定。审计「循环是否自洽」时发现 5 个结构性缺口，逐个定了方向。
> **总定位**：PvP 公平（获客钩子，永不卖战力）/ PvE 免费玩家出路 / **SLG 才是赚钱区，不要求公平**（养成战力＝付费战力）。装备等养成现阶段只 PvE（受 §5.2 硬墙），SLG 上线后即 PvP 战力来源——届时 SLG PvP 必须与天梯 PvP **分开匹配、分开榜**，不污染公平电竞定位。

### 11.1 日常层（留存发动机，常规套路，前期就上）

- **每日任务**：每日刷新若干条（如「打 N 局」「击杀 N 单位」「通关 1 关」），完成给金币 + 材料。
- **登录奖励**：按日循环 / 连续登录递增。
- **每日首胜**：当日第一场 PvP 胜利额外金币。
- 数值初值见 `ECONOMY_BALANCE.md`（日常层 sources）。所有发放服务器权威，按 `dayKey` 计数（同广告 cap 机制）。

### 11.2 赛季 + 战令（Battle Pass）

- **通用赛季规则**：固定周期（如 4–6 周）一赛季，期间累积赛季经验（来自日常/对局）解锁战令等级。
- **战令双轨**：免费轨人人可领；**付费 Pass 解锁额外奖励轨**（金币/材料/限定皮肤）。
- 作用：①金币持续 sink（鲸鱼买空 90% 物品后金币的去处）②每日/每周目标 ③早期变现脊梁。
- 赛季末天梯重置（与 §11.3 联动）。

### 11.3 天梯（Ranked）— 依赖 S1-R

> ⚠️ **硬依赖**：称号系统建立在天梯之上，但 ranked 队列 + ELO（`S1-R`）尚未实现，当前只有好友房。**做称号前必须先落 S1-R**。

- **9 个称号 / 段位**（DRAFT）：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 星耀 → 大师 → 宗师 → 王者。首达某段位发一次性金币（§2.3，本次从 8 段扩为 9 段）。
- **分段差异化胜利收益**：不同积分段单局胜利的金币收益不同（高段更高，给爬梯动力）；**须设每日胜利金币上限**防 PvP 通胀金币（per-win 是持续 faucet，与一次性称号不同）。
- **战绩记录**：连胜 / 连败 / 胜率等数据持久化（落 `SaveData` 或独立 ladder 记录），供匹配调节 + 连胜奖励 + 展示。

### 11.4 装备：合成升级 + 洗练（材料的深坑 sink）

> ⚠️ **已被取代（ADR-010，2026-06-21）**：装备机制权威 = [`EQUIPMENT_DESIGN.md`](EQUIPMENT_DESIGN.md)。下列"5 件确定性合成升级"作废，升级改走**概率强化 +1→9**（ADR-009）；合成只负责**获得基础装备**。

- ~~**9 级合成升级**：装备分 9 级，**每升 1 级消耗 5 个同种装备**（Lv N 需 5×Lv N-1）。~~ → 概率强化，见 EQUIPMENT_DESIGN §6。指数深坑改由「强化失败损耗」承担长线材料消耗。
- **洗练（面向大 R）**：可重洗装备**属性**与**特技**；**每次洗练消耗一件低一级的同类装备**。给鲸鱼一个持续吞装备的 sink，同时不影响免费玩家基础体验。
- 装备由材料锻造产出（§5 已改向）；这条同时补上了「装备是终端货币、无 sink」的洞——合成 + 洗练即装备自身的消耗口。
- 数值（各级属性、锻造成本、洗练词条池）见 `ECONOMY_BALANCE.md` 装备节（待铺）。
