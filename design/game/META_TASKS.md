# Notebook Wars — 元系统 / 服务器 实施任务拆分

> 创建：2026-06-13。本文件把 `META_DESIGN.md` 的 S0–S4 分期拆成可执行任务清单。
> 大框架以 `META_DESIGN.md` 为准；UI 细节见 `UI_DESIGN.md`。
> 约定：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每个任务标 **依赖** / **主要文件** / **验收**。

---

## 阶段总览

| 阶段 | 主题 | 出口标准 |
|---|---|---|
| **S0** | 存档底座 + 云存档 + 匿名账号 | 多设备云存档同步跑通，迁移链就位 |
| **S1** | 好友房 + 锁步联机 + 重连 | 两台真机好友房对局逐 tick 一致，可重连 |
| **S2** | 经济：服务端钱包 / 商店 / 盲盒 / 广告校验 | 钱包服务器权威，刷不动；盲盒逐抽落库 |
| **S3** | PvE 养成（材料 + 硬墙）+ 收集 + 选关 | 养成 / 收集 / 选关闭环；硬墙单测绿 |
| **S4** | IAP 验单 + 反作弊 hash + 上线加固 | 充值安全，对局 hash 比对 |

> 先打通 S0/S1（云存档 + 好友联机，核心诉求），再铺 S2/S3。

---

## 公共底座（贯穿所有阶段）

- [ ] **C-1 仓库结构（三包 workspaces）**：`server/` 下建 **`shared/`（`@nw/shared`）+ `api/`（REST）+ `gateway/`（WS）**三包，可独立部署（`META_DESIGN.md §6.1`）。`shared` 只 import `code/src/game` 的**类型**（`PlayerCommand` 等，编译期擦除，不打进 bundle）。**主要文件**：根/`server` `package.json` workspaces、各包 `tsconfig.json`（paths→`@game`/`@nw/shared`）。**验收**：`api`/`gateway` 各自 `tsc --noEmit` 干净，bundle 内无 PIXI/引擎运行时。
- [ ] **C-2 协议 + 共享库**：`shared` 内定义 `ClientMsg`/`ServerMsg` 联合、`ApiResp<T>`、`RoomInfo`、`InputFrame`；含 JWT 校验、zod schema、Mongo client 工厂、`RoomRegistry` 接口（内存实现，§6.5 留 Redis 口子）。**依赖**：C-1。**验收**：双端 import 同一份，无重复定义。
- [ ] **C-3 部署脚手架（两进程）**：Linux VPS 上 `mongod`（**单节点副本集** `rs.initiate()`，§6.3）+ `api`/`gateway` 两进程（pm2）+ caddy/nginx 反代（`/api/*`→api、`/ws`→gateway，自动 HTTPS）。**依赖**：C-1。**验收**：一条脚本起全栈，`wss://host/ws` 可连、`https://host/api` 可访。

---

## S0 — 存档底座 + 云存档

### 客户端
- [ ] **S0-1 SaveData 模型**：`code/src/game/meta/SaveData.ts`（纯数据，字段见 `META_DESIGN.md §3.1`）+ `LevelRecord` / `Rarity` 等子类型。**依赖**：—。**验收**：类型完整，含 `version`/`rev`/`accountId`。
- [ ] **S0-2 迁移链**：`migrate(raw)→SaveData` + `MIGRATIONS[]`（v0→v1…）。**依赖**：S0-1。**验收**：喂残缺/旧版对象能补全到当前 version，单测覆盖。
- [ ] **S0-3 SaveStore 抽象 + 本地实现**：`loadLocal/saveLocal` 走 `IPlatform.storage`（key `nw_save_v1`），把现有 `nw_seen_intro`/`nw_locale` 收编进 `flags`（保留旧 key 读兼容）。**依赖**：S0-1,2。**验收**：本地存取 round-trip 一致。
- [ ] **S0-4 匿名账号**：`getAccountId()`——微信 `wx.login`→code（交服务器换 openid），Web/CrazyGames 生成并持久化设备 UUID。封进 `IPlatform`。**依赖**：—。**验收**：同设备稳定返回同 id。
- [ ] **S0-5 云同步客户端**：`pull/push`（HTTP，带 `If-Match: rev`），离线优先 + 防抖 2s 上行 + 409 冲突走 pull-merge（服务器权威段以服务器为准）。**依赖**：S0-3,4、S0-7。**验收**：断网可玩，恢复后自动同步。

### 服务器
- [ ] **S0-6 Mongo 接入**：连接 + `saves` 集合（`{_id: accountId, save, rev}`）+ 索引。**依赖**：C-1,3。**验收**：本地 mongod 读写通。
- [ ] **S0-7 save-service**：`GET /save/:id`、`PUT /save/:id`（乐观锁：rev 不匹配返回 409 + 当前云端值）；`POST /auth/wx`（code→openid→accountId）。**依赖**：S0-6、C-2。**验收**：并发 PUT 只有一个赢，另一个收 409。

### 联调出口
- [ ] **S0-8 多设备同步验收**：A 设备改存档 → B 设备启动拉到最新；离线改 → 上线合并不丢。**依赖**：S0-5,7。

---

## S1 — 好友房 + 锁步联机（gateway 服务）

> 本阶段只做 `friendly`（好友码房）。`ranked` 匹配队列 + ELO 结算见 S1-R（稍后）。

### 服务器（gateway）
- [ ] **S1-1 ws-gateway**：WebSocket 接入（`ws`），JWT 鉴权、心跳、断线检测。**依赖**：C-2,3。**验收**：连接/心跳/断开事件正确。
- [ ] **S1-2 room-service**：建房（短房间码）/ 输码加入 / ready / 满员开局；房间状态走 `RoomRegistry`（内存实现）。开局分配 `seed` + `startTick` + `mode` 下发双方。**依赖**：S1-1。**验收**：两连接进同一房、同时收到一致 seed。
- [ ] **S1-3 锁步输入中继**：收各端 `{tick, commands[]}` → 按 tick 聚合 → 凑齐双方后广播确认输入集；输入延迟缓冲（2~3 tick）。**依赖**：S1-2、C-2。**验收**：双端在相同 tick 收到相同输入集。
- [ ] **S1-4 输入日志 + 重连 + 60s 判负**：每局留输入日志；掉线发 `peer.dc{graceMs:60000}` 起 60s 计时，`conn.resume` 下发 `seed+日志+curTick` 续打，**超时掉线方判负** `match.over{reason:'disconnect'}`（M10）。**依赖**：S1-3。**验收**：重连续打一致；超时正确判负。
- [ ] **S1-5 局末结算**：双端 `match.result{hash}` → 比对 desync；写 `matches` 归档（friendly 仅记结果）。**依赖**：S1-3。**验收**：结果落库；hash 不一致标 mismatch。
- [ ] **S1-R（稍后）ranked 队列 + ELO**：匹配队列按 ELO 配对；ranked 局末算 ELO 写 `saves.pvp`（单文档原子更新，服务器权威）。**依赖**：S1-5、S2-1。**验收**：天梯分服务器权威、刷不动。
- [ ] **S1-J（可选）服务器裁判**：仅重大比赛——gateway headless 跑 `GameEngine` 复算校验。**依赖**：S1-3、C-1。**验收**：篡改输入被检出。

### 客户端
- [ ] **S1-6 NetClient**：封装 ws 连接、重连、消息编解码（用 C-2 协议）。**依赖**：C-2。**验收**：掉线自动重连。
- [ ] **S1-7 锁步驱动**：`GameEngine` 改为**按确认输入集推进 tick**（联机模式不本地自跑 AI；命令延迟 2~3 tick 提交）。保留单机/PvE 模式原样。**依赖**：S1-6、S1-3。**验收**：本地预测/确认一致，无回滚需求（锁步纯确认式）。
- [ ] **S1-8 RoomScene**：建房/房间码展示/输码加入/ready/倒计时开打（UI 见 `UI_DESIGN.md`）。**依赖**：S1-6、S1-2。**验收**：完整建房→加入→开局流程。

### 联调出口
- [ ] **S1-9 双真机对局**：两台设备好友房一整局逐 tick 一致；中途断一台能重连续打。**依赖**：S1-3,4,7,8。

---

## S2 — 经济：钱包 / 商店 / 盲盒 / 广告

### 服务器（钱包权威，全程事务）
- [ ] **S2-1 钱包模型**：`wallet.coins` 存 Mongo（`saves` 内或独立 `wallets` 集合）；所有变更走原子事务 + 流水记账。**依赖**：S0-6。**验收**：并发扣币不超支。
- [ ] **S2-2 商店直购**：`POST /shop/buy`（校验余额→扣币→发库存→回推 SaveData）。商品定义表 `shopItems`。**依赖**：S2-1。**验收**：余额不足拒绝；成功原子发货。
- [ ] **S2-3 盲盒服务**：`POST /gacha/draw`（`crypto` 真随机按 weight + 保底；扣币→发货/转化→更新 pity→**写 `gachaHistory`**→回推）。`GachaPool` 配置表。**依赖**：S2-1。**验收**：单抽/十连原子；每抽落库；保底命中可复现于日志。
- [ ] **S2-4 广告奖励校验**：`POST /ads/reward`（校验平台广告回调/凭证→记每日 `{dayKey,watchedToday}`→到 cap 拒→加币）。**依赖**：S2-1。**验收**：超日上限不发；伪造回调被拒。

### 客户端
- [ ] **S2-5 EconomyClient**：封装 shop/gacha/ads 调用；UI 余额只读自 SaveData（服务器回推）。**依赖**：S0-5、C-2。**验收**：花币动作后余额以服务器回推为准刷新。
- [ ] **S2-6 ShopScene + GachaScene**：商品格/购买确认/盲盒开箱动画/保底进度（见 `UI_DESIGN.md`）。**依赖**：S2-5。**验收**：购买与开箱闭环。
- [ ] **S2-7 防刷验收**：本地改 `wallet.coins` 后任何花币动作被服务器拒（以服务器值为准）。**依赖**：S2-1~5。

---

## S3 — PvE 养成 + 收集 + 选关

- [ ] **S3-1 材料 + 关卡掉落**：`LevelRewards` 增材料产出；ResultScene 发放写 `SaveData.materials`。**依赖**：S0-1。**验收**：通关按 reward 发材料。
- [ ] **S3-2 PveUpgradeDef 表 + applyPveUpgrades**：升级树定义（花材料，`META_DESIGN.md §5.1`）+ 修饰层函数。**依赖**：S0-1。**验收**：升级改 `pveUpgrades`，材料原子扣。
- [ ] **S3-3 引擎双路 + 硬墙单测**：`buildPvpBlueprints()`（不收 SaveData）/ `buildCampaignBlueprints(save)`；`GameEngine` 按 mode 选。**单测**：满级 SaveData 构造 PvP 引擎，断言 blueprints 与常量逐字相等。**依赖**：S3-2。**验收**：单测绿；黄金回放不破。
- [ ] **S3-4 皮肤渲染**：`UnitView`/`StickmanRuntime` 按 `equipped` 选贴图；`game/` 不 import 皮肤。**依赖**：S0-1。**验收**：换肤只改贴图，数值不变。
- [ ] **S3-5 CampaignMapScene + LevelPrepScene + CollectionScene**：选关地图/星级/解锁、关前编成、收集衣柜（见 `UI_DESIGN.md`）。**依赖**：S3-1~4。**验收**：选关→编成→打→评星→解锁→收集闭环。

---

## S4 — IAP 验单 + 反作弊 + 加固

- [ ] **S4-1 iap-service**：各平台充值服务端验单（微信虚拟支付 / Web 渠道）→ 加币。**依赖**：S2-1。**验收**：未验单不发币；重复票据幂等。
- [ ] **S4-2 对局 hash 比对**：对局结束双端上报最终状态 hash，服务器比对，分歧标记。**依赖**：S1-3。**验收**：人为分歧被检出。
- [ ] **S4-3 上线加固**：限流、输入校验、日志/告警、Mongo 备份脚本。**依赖**：全部。

---

## i18n（贯穿，随场景落地）

- [ ] **I-1** 新增命名空间键（`zh.ts` 为唯一来源，`en`/`de` 同步补全，否则编译报错）：`meta.*` / `shop.*` / `gacha.*` / `collection.*` / `room.*` / `profile.*`。随对应 UI 任务一起加。

---

## 风险与注意

- **确定性**：联机/养成逻辑在 `game/` 内严禁 `Math.random()`，走注入 `Prng`；**gacha 例外**（服务端 `crypto`，不进回放，见 `META_DESIGN.md §8`）。
- **硬墙**：PvP 引擎构造签名永不出现 `SaveData`（编译期隔离），配 S3-3 单测回归。
- **钱包零信任**：客户端永不直接写 `wallet`/`inventory`；全走服务器事务 + 回推。
- **微信合规**：联机、虚拟支付、备案需单独排期（`META_DESIGN.md §10`）。
