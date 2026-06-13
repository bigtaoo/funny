# Notebook Wars — 元系统与服务器设计文档

> 创建：2026-06-13。本文件是元系统（存档 / 经济 / 养成 / 收集 / 商业化）+ 服务器（云存档 / 好友房联机）的设计基准，随实现推进同步更新。
> 配套阅读：`CAMPAIGN_DESIGN.md`（PvE 战役）、`DESIGN.md`（引擎/系统）、`IMPROVEMENT_PLAN.md`（迭代进度）、根 `../../CLAUDE.md`。
> 子文档：`META_TASKS.md`（任务拆分）、`UI_DESIGN.md`（客户端 UI）、`SERVER_API.md`（接口契约）、`ECONOMY_BALANCE.md`（经济数值）。

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
| M2 | 服务器语言 = **Node.js（TS）** | 与客户端同语言、工具链统一；重大比赛要裁判时可直接 import `code/src/game/` 跑同一份确定性引擎，无跨语言发散风险 |
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

---

## 2. 信任边界（M5 的物理落地，写代码前必读）

货币涉及真钱 → 服务器权威；PvE 进度对 PvP 零影响（硬墙）→ 可客户端同步 + 轻校验。**两类数据物理分开存、分开校验：**

| 类别 | 字段 | 谁权威 | 写入方式 |
|---|---|---|---|
| **服务器权威**（客户端只读） | `wallet.coins`、`inventory`（皮肤/物品）、`gacha.pity` + 抽卡历史、IAP 票据、`pvp` 天梯（elo/rank/战绩） | 服务器 | 钱包/发货走**单文档原子更新**（见 §6.3）；天梯由 `gameserver` 在 ranked 局结束时结算写入 |
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

### 6.1 拓扑：REST 与 WS 两个可独立部署的服务（M9）

REST 与 WS 扩容画像不同（metaserver 无状态可横扩、gameserver 有房间状态需房间亲和），故**代码与部署都分两个服务**，共享 `shared` 包。v1 同机两进程，日后各自扩。

```
server/                      （npm/pnpm workspaces 单仓多包）
├── contracts/ openapi.yml      REST 契约（design-first，codegen metaserver + 客户端）
│             transport.proto  WS 房间/锁步控制（服务器认得这一层）
│             game.proto       PlayerCommand 真实结构（仅客户端↔客户端）
├── shared/   @nw/shared     openapi + transport.proto codegen + JWT 校验 + zod + Mongo client 工厂
├── metaserver/ REST 服务（无状态）  auth · save · economy(shop/gacha/ads/wallet) · iap（openapi.yml/JSON）
│                            → 可横向加副本，LB 轮询；不持有内存会话
└── gameserver/  WS 服务（有状态）   room · 锁步中继 · 重连 · ranked 局末 ELO 结算（protobuf）
                             → 持有内存房间状态；扩展需房间亲和（§6.5）

db: MongoDB（saves / accounts / gachaHistory / walletLog / iapReceipts / matches）
反代 caddy/nginx：/api/* → metaserver 进程（JSON）；/ws → gameserver 进程（protobuf）
```

> **服务器与游戏逻辑零依赖**（M12）：gameserver 只 codegen `transport.proto`，`PlayerCommand` 作 `bytes` **opaque 转发不解码**；`game.proto` 永不进服务器。改命令结构服务器不用重编。仅"重大比赛裁判"才让 gameserver 额外 import 真 `GameEngine` + `game.proto` 跑复算。

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
- **断线（M10）**：in_match 掉线 → gameserver 停发该房间批次 + `peer_dc{grace_ms:60000}` 起 **60s**；`conn_resume` 续发续打；**超时掉线方判负**。
- **局末**：双方上报最终状态 hash，gameserver 比对查 **desync**（无需引擎，纯字符串比；非反作弊，是确定性回归探针）。
- **match 类型（M11）**：`friendly`（仅写 `matches` 记结果）/ `ranked`（gameserver 结算 ELO 写 `pvp` 段，服务器权威）。
- **录像**：gameserver 是帧序列唯一装配者 → 非空帧日志即录像，天然落服务端（§6.6）。

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
| 日活上万 | 多副本横扩（轻量、便宜） | 加实例需**房间亲和**：一个房两条 WS 落同一实例（一致性哈希 by roomId）；跨实例房间目录 / 在线状态用 **Redis** pub-sub |

> v1 不写 Redis，但 gameserver 的房间查找走一层 `RoomRegistry` 接口（内存实现），扩展时换 Redis 实现即可，不动业务。这是现在唯一要留的口子。

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

- **9 级合成升级**：装备分 9 级，**每升 1 级消耗 5 个同种装备**（Lv N 需 5×Lv N-1）。指数深坑：一件满级 = 5⁸ ≈ 39 万件基础装备，足够长线消耗材料/装备。
- **洗练（面向大 R）**：可重洗装备**属性**与**特技**；**每次洗练消耗一件低一级的同类装备**。给鲸鱼一个持续吞装备的 sink，同时不影响免费玩家基础体验。
- 装备由材料锻造产出（§5 已改向）；这条同时补上了「装备是终端货币、无 sink」的洞——合成 + 洗练即装备自身的消耗口。
- 数值（各级属性、锻造成本、洗练词条池）见 `ECONOMY_BALANCE.md` 装备节（待铺）。
