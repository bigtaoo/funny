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

- [x] **C-1 仓库结构（三包 workspaces + contracts）**：`server/` 下建 **`contracts/`（`openapi.yml` + `transport.proto`/`game.proto`）+ `shared/`（`@nw/shared`）+ `metaserver/`（REST）+ `gameserver/`（WS）**，metaserver/gameserver 可独立部署（`META_DESIGN.md §6.1`）。`shared`/`gameserver` 只 codegen `transport.proto`，**不依赖 `code/src/game`**（仅可选裁判任务才引）。**主要文件**：根/`server` `package.json` workspaces、各包 `tsconfig.json`。**验收**：`metaserver`/`gameserver` 各自 `tsc --noEmit` 干净，bundle 内无 PIXI/引擎运行时/`game.proto`。✅ npm workspaces（shared/metaserver/gameserver），`npx tsc -b` 三包全绿；metaserver=ESM(NodeNext)、shared/gameserver=CJS；服务端不 import `code/src/game`。
- [~] **C-2 契约（OpenAPI + protobuf）+ 共享库**：写 **`openapi.yml`**（REST 端点 design-first，M15）→ codegen metaserver 路由+校验（`fastify-openapi-glue`）与客户端 typed fetch（`openapi-typescript`+`openapi-fetch`）；写 `transport.proto`（房间/锁步控制，`Envelope` oneof；`commands: bytes` opaque）+ `game.proto`（`PlayerCommand`，仅客户端↔客户端）→ `ts-proto` codegen 双端。`shared` 另含 JWT 校验、Mongo client 工厂、`RoomRegistry` 接口（内存实现，§6.5 留 Redis 口子）；dev 模式加二进制帧解码打印。**依赖**：C-1。**验收**：双端从同一 `openapi.yml`/`.proto` codegen；服务器转发 `commands` 字节流不解码。✅ 已写 `openapi.yml`（10 端点 + SaveData schema）、`transport.proto`、`game.proto`；`@nw/shared` 含 SaveData/ApiResp/ErrorCode、JWT、Mongo 工厂+集合、`InMemoryRoomRegistry`；metaserver 经 `fastify-openapi-glue` 从 spec 装配（冒烟：10 路由 + `$ref` 解析通过）。**待办**：客户端 `ts-proto`/`openapi-typescript` codegen + dev 二进制帧解码打印（随客户端 S0-5/S1-6 落地）。
- [x] **C-3 部署脚手架（两进程）**：Linux VPS 上 `mongod`（**单节点副本集** `rs.initiate()`，§6.3）+ `metaserver`/`gameserver` 两进程（pm2）+ caddy/nginx 反代（`/api/*`→metaserver、`/ws`→gameserver，自动 HTTPS）。**依赖**：C-1。**验收**：一条脚本起全栈，`wss://host/ws` 可连、`https://host/api` 可访。✅ **两条路线**：①Docker（推荐）——`server/Dockerfile`（多阶段，单镜像 build 全 workspace，metaserver/gameserver 用 `command` 区分进程）+ `docker-compose.prod.yml`（mongo 单节点副本集自动 `rs.initiate`（成员 host=容器名 `mongo`）+ metaserver + gameserver + caddy，全命名卷持久化）+ `Caddyfile`（`handle_path /api/*` 剥前缀转 metaserver:8080、`handle /ws*` 保路径转 gameserver:8081，`{$NW_DOMAIN}` 真域名时自动签 Let's Encrypt）+ `.env.example`（`NW_JWT_SECRET`/`NW_DOMAIN`/`NW_WX_*`）+ **一条脚本 `deploy/up.sh`**（`docker compose -f docker-compose.prod.yml --env-file .env up -d --build`）。②pm2——`ecosystem.config.cjs`（nw-meta fork、nw-game 单实例房间亲和；密钥从 shell env 继承）。metaserver 加 `/health` 存活探针（不入 openapi，反代 `/api/health` 命中）。`tsc -b` 三包全绿。
- [x] **C-4 统一输入管线（InputSource）**：引擎命令入口从「UI 直接 `processCommand`」改为「每 tick 从注入的 `InputSource` 消费确认指令集」；实现 `LocalInputSource`（单机自转发，DELAY 0）。AI/WaveDirector 作为 tick 内输入源接入。**依赖**：—（纯客户端引擎重构）。**主要文件**：`code/src/game/GameEngine.ts`、新 `game/net/InputSource.ts`。**验收**：单机 PvE/练习走新管线，38+ 测试 + 黄金回放确定性不破。`NetInputSource`（S1-7）/`ReplayInputSource`（S1-RP）是其另两个实例。✅ 新增 `game/net/InputSource.ts`（`InputSource` 接口 `submit`/`take(frame)→cmds|null` + `LocalInputSource` DELAY 0 自转发，行为等价原 `pendingCommands`）；`createGameEngine(config, input?)` 可选注入（缺省 Local）；`playCard`/`upgradeBase` 改 `input.submit`，`tick(dt)` 循环改 `input.take(currentTick)`（返回 `null` 即停步，为 S1-7 net 缓冲留口）；AI(PvP)/WaveDirector(PvE) 仍在 `step` 内按原序消费（注释标为 tick 内输入源）。barrel 导出 `LocalInputSource`/`InputSource`。tsc 干净 + 63 测试全绿（黄金回放/campaign 确定性不破）+ web 构建通过。

---

## S0 — 存档底座 + 云存档

### 客户端
- [x] **S0-1 SaveData 模型**：`code/src/game/meta/SaveData.ts`（纯数据，字段见 `META_DESIGN.md §3.1`）+ `LevelRecord` / `Rarity` 等子类型。**依赖**：—。**验收**：类型完整，含 `version`/`rev`/`accountId`。✅ 镜像 `server/shared/src/types.ts`（含 `makeNewSave`/`SyncPatch`/`extractSyncPatch`/`SYNC_KEYS`/`SAVE_STORAGE_KEY=nw_save_v1`），纯数据无 PIXI。
- [x] **S0-2 迁移链**：`migrate(raw)→SaveData` + `MIGRATIONS[]`（v0→v1…）。**依赖**：S0-1。**验收**：喂残缺/旧版对象能补全到当前 version，单测覆盖。✅ `meta/migrate.ts`：MIGRATIONS 顺序升级 + `fillDefaults` 深合并兜底（保留动态键如 best/flags 自定义项）+ 钉死 version；null/损坏对象 → 全新档；幂等。
- [x] **S0-3 SaveStore 抽象 + 本地实现**：`loadLocal/saveLocal` 走 `IPlatform.storage`（key `nw_save_v1`），把现有 `nw_seen_intro`/`nw_locale` 收编进 `flags`（保留旧 key 读兼容）。**依赖**：S0-1,2。**验收**：本地存取 round-trip 一致。✅ `meta/SaveStore.ts` `LocalSaveStore`（load 含迁移+损坏 JSON 退化全新档；`nw_seen_intro`→`flags.seen_intro` 收编不删旧 key）。**注**：`nw_locale` 是字符串、由 i18n 自管（`flags` 仅布尔），不收编。pull/push 移到 `ApiClient`+`SaveManager`（本地持久化零网络依赖，便于单测）。
- [x] **S0-4 匿名账号**：`getAccountId()`——微信 `wx.login`→code（交服务器换 openid），Web/CrazyGames 生成并持久化设备 UUID。封进 `IPlatform`。**依赖**：—。**验收**：同设备稳定返回同 id。✅ `IPlatform.getAuthCredential(): Promise<AuthCredential>`（`{kind:'device',deviceId}` | `{kind:'wx',code}`）；Web/CrazyGames 用 `platform/uuid.ts` `getOrCreateDeviceId`（crypto.randomUUID→getRandomValues→时间回退，持久化 key `nw_device_id`）；微信 `wx.login`→code。
- [x] **S0-5 云同步客户端**：`pull/push`（HTTP，带 `If-Match: rev`），离线优先 + 防抖 2s 上行 + 409 冲突走 pull-merge（服务器权威段以服务器为准）。**依赖**：S0-3,4、S0-7。**验收**：断网可玩，恢复后自动同步。✅ `net/ApiClient.ts`（fetch + ApiResp 包络；auth/device·auth/wx·GET/PUT save；putSave 带 If-Match，409 返回 `{kind:'conflict',save}` 不抛）+ `meta/SaveManager.ts`（loadLocal 立即可玩 → bootstrap auth+pull+reconcile → update() 改同步段立即落本地+防抖 2s push → 409 reconcile 后重试一次；reconcile：权威段云端为准、progress 并集、materials/pveUpgrades 取较大、equipped/flags 本地覆盖）+ `net/config.ts`（`getApiBaseUrl`：`__NW_API_BASE__`>localStorage `nw_api_base`>null；null→纯本地离线优先）。`app.ts` 接入：构建 SaveManager、`bootstrap()` 非阻塞、Intro 门控改读 `flags.seen_intro`。**单测**：`code/test/saveData.test.ts` 11 用例（migrate/round-trip/收编/extractSyncPatch），全套 63 绿。**待联调**：S0-8 多设备同步（需起服务端 + 设 `nw_api_base`）。

### 服务器
- [x] **S0-6 Mongo 接入**：连接 + `saves` 集合（`{_id: accountId, save, rev}`）+ 索引。**依赖**：C-1,3。**验收**：本地 mongod 读写通。✅ `shared/src/mongo.ts` `createMongo` 工厂 + 6 集合句柄（saves/accounts/gachaHistory/walletLog/iapReceipts/matches）+ `ensureIndexes`（accounts.openid/deviceId 唯一稀疏索引等）。
- [x] **S0-7 save-service**（metaserver）：`GET /save`、`PUT /save`（accountId 由 JWT 解出；乐观锁：rev 不匹配返回 409 + 当前云端值）；`POST /auth/wx`、`POST /auth/device`。**依赖**：S0-6、C-2。**验收**：并发 PUT 只有一个赢，另一个收 409。✅ `metaserver/src/{service,save,accounts,auth}.ts`：auth 经 openid/deviceId upsert 取稳定 accountId + 签 JWT；`putSave` 用 `findOneAndUpdate({_id, rev})` 单文档原子守卫，rev 不匹配回 409 + 当前云端值；`getSave` 缺档自动建新档；bearerAuth 安全处理器从 JWT 解出 `req.accountId`。**端到端已验收**：连真 Mongo（docker compose 单节点副本集）跑 vitest 6 用例全绿（`metaserver/test/save.e2e.test.ts`）——auth 稳定 accountId / 无 token 401 / 新档 rev0 / 乐观锁 rev+1 / 过期 rev 409+云端值 / **并发同 rev 恰一个 200 一个 409** / 硬墙(PUT 携 wallet 被忽略)。`npm test`(tsc -b + vitest，需先 `docker compose up -d`)。

### 联调出口
- [ ] **S0-8 多设备同步验收**：A 设备改存档 → B 设备启动拉到最新；离线改 → 上线合并不丢。**依赖**：S0-5,7。

---

## S1 — 好友房 + 锁步联机（gameserver 服务）

> 本阶段只做 `friendly`（好友码房）。`ranked` 匹配队列 + ELO 结算见 S1-R（稍后）。

### 服务器（gameserver）
- [x] **S1-1 gameserver**：WebSocket 接入（`ws`），JWT 鉴权、心跳、断线检测。**依赖**：C-2,3。**验收**：连接/心跳/断开事件正确。✅ `gameserver/src/index.ts` 握手 `?token=<jwt>`（`verifyToken` 失败 4401）→ `Connection` → `RoomManager`；30s 心跳巡检（两轮无 pong/消息 `terminate`）；`close` 收口路由到房间。
- [x] **S1-2 room-service**：建房（短房间码）/ 输码加入 / ready / 满员开局；房间状态走 `RoomRegistry`（内存实现）。开局分配 `seed` + `startTick` + `mode` 下发双方。**依赖**：S1-1。**验收**：两连接进同一房、同时收到一致 seed。✅ `RoomManager` 建房生成 6 位无歧义码走 `InMemoryRoomRegistry`、`ROOM_NOT_FOUND`/`ROOM_FULL`/`RANKED_UNAVAILABLE`/`ALREADY_IN_ROOM`、同账号顶替；`room_start` 房主开局下发 `match_start{seed, start_frame, mode, local_side}`。端到端实测双方同 seed + 各自 local_side。
- [x] **S1-3 节拍器中继（M14）**：gameserver 持房间时钟，模拟 30Hz、**每 100ms（10Hz）下发 `frame_batch{to_frame, frames}`（3 帧）**；收到 `cmd_submit` 塞进当前窗口帧；空窗只发 `to_frame` 水位；同帧多指令按 `side` 确定性排序。**依赖**：S1-2、C-2。**验收**：双端收到逐字相同的帧序列；空闲下 `to_frame` 每 100ms 稳定 +3。✅ `Room` `setInterval(100ms)` 每拍 `curFrame+=3`；`cmd_submit` 落本批次 `to_frame` 帧、`side` 升序稳定排序；空窗 `frames=[]`。实测空闲 `to_frame` 序列 `[3,6,9]` 全空帧、`cmd_submit` 双端同帧同 side。
- [x] **S1-4 非空帧日志 + 重连 + 60s 判负**：每局留非空帧日志；掉线则停发该房间帧 + `peer_dc{grace_ms:60000}` 起 60s，`conn_resume{last_frame}` 下发 `seed + 之后非空帧 + cur_frame` 续打，**超时掉线方判负** `match_over{reason:'disconnect'}`（M10）。**依赖**：S1-3。**验收**：重连续打一致；超时正确判负。✅ `Room.log` 仅存非空帧；断线停 metronome + `peer_dc{side, grace_ms:60000}` + 60s timer；`resume` 下发 `conn_resync{seed, start_frame, log(>last_frame), cur_frame}`、双方在线清宽限续发；超时/认输 `match_over{reason:'disconnect'}`。实测 peer_dc、停发、resync、续发全过。
- [x] **S1-5 局末结算**：双端 `match.result{hash}` → 比对 desync；写 `matches` 归档（friendly 仅记结果）。**依赖**：S1-3。**验收**：结果落库；hash 不一致标 mismatch。✅ 双方 `match_result{state_hash}` 齐 → 比对 → `match_over{reason: base|mismatch, mismatch}` + `matches.insertOne`（`seed`/`players`/`hashOk`/`reason`）；Mongo 不可用降级纯中继不归档。friendly 正常结束 `winner_side` 客户端权威（归档 `winner=-1`），disconnect/认输服务器权威。实测一致→base、不一致→mismatch。
- [ ] **S1-R（稍后）ranked 队列 + ELO**：匹配队列按 ELO 配对；ranked 局末算 ELO 写 `saves.pvp`（单文档原子更新，服务器权威）。**依赖**：S1-5、S2-1。**验收**：天梯分服务器权威、刷不动。
- [ ] **S1-J（可选）服务器裁判**：仅重大比赛——gameserver headless 跑 `GameEngine` 复算校验。**依赖**：S1-3、C-1。**验收**：篡改输入被检出。
- [ ] **S1-RP 录像录制 + 回放**：定义 `replay.proto`（复用 `FrameCmds`）；录制（PvE 客户端记玩家指令 / PvP gameserver 持久化输入日志到 `matches.replayRef`）；实现 `ReplayInputSource` + 回放播放器（同 seed 起新引擎喂输入流），回放前校验 `engineVersion`。**依赖**：C-4、S1-5。**验收**：一局 PvE + 一局 PvP 录像回放与原局逐 tick 一致；改 engineVersion 回放被拒。**注**：PvE 录制可随战役（CAMPAIGN P1）先落地，不必等联机。

### 客户端
- [x] **S1-6 NetClient**：封装 ws 连接、重连、消息编解码（用 C-2 协议）。**依赖**：C-2。**验收**：掉线自动重连。✅ `code/src/net/NetClient.ts`：退避重连 + 代次作废滞后回调 + 首/重连 open 区分（仅重连触发 `onReconnect`，上层据此发 conn_resume）+ 应用层心跳 + 未 open 丢弃发送；平台 socket 抽象 `IPlatform.connectSocket`（Web/CrazyGames=`BrowserGameSocket`，微信=`WechatGameSocket`）；C-2 ts-proto 编解码。6 单测（假 socket）+ 端到端真 NetClient↔真 gameserver 整局 friendly 跑通。**注**：C-2 客户端 proto codegen 同期落地（ts-proto via buf，`code/buf.gen.yaml`+`scripts/gen-proto.mjs`+`npm run proto:gen`，产物 `src/net/proto/`，线兼容回归 `test/proto-wire-compat.test.ts`）。
- [ ] **S1-7 节拍驱动（NetInputSource）**：实现 `NetInputSource`（C-4 的联机实例）——消费 gameserver 的 `frame_batch`、按 `to_frame` 推进引擎并把 3 帧摊到 100ms 播放，保持 ~1 批次缓冲，缓存空则暂停、超时追帧；出牌即发 `cmd_submit`（不预算帧号）。单机/PvE 走 `LocalInputSource` 不变。**依赖**：S1-6、S1-3、C-4。**验收**：缓冲吸收 <100ms 抖动无感；服务器停发即暂停；无回滚。
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
