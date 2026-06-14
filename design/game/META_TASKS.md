# Notebook Wars — 元系统 / 服务器 实施任务拆分

> 创建：2026-06-13。本文件把 `META_DESIGN.md` 的 S0–S4 分期拆成可执行任务清单。
> 大框架以 `META_DESIGN.md` 为准；UI 细节见 `UI_DESIGN.md`。
> 约定：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每个任务标 **依赖** / **主要文件** / **验收**。

---

## 阶段总览

| 阶段 | 主题 | 出口标准 |
|---|---|---|
| **S0** | 存档底座 + 云存档 + 匿名账号 | 多设备云存档同步跑通，迁移链就位 |
| **SA** | 账号系统（登录 + 单机门槛） | 默认登录可进、单机试玩可玩、匿名可转正 |
| **S1** | 好友房 + 锁步联机 + 重连 | 两台真机好友房对局逐 tick 一致，可重连 |
| **S2** | 经济：服务端钱包 / 商店 / 盲盒 / 广告校验 | 钱包服务器权威，刷不动；盲盒逐抽落库 |
| **S5** | commercial 商业服务（钱包/充值/消费/盲盒，独立库） | 钱包权威迁 commercial，扣币+发货 saga 收敛 |
| **S3** | PvE 养成（材料 + 硬墙）+ 收集 + 选关 | 养成 / 收集 / 选关闭环；硬墙单测绿 |
| **S4** | IAP 验单 + 反作弊 hash + 上线加固 | 充值安全，对局 hash 比对 |

> 先打通 S0/S1（云存档 + 好友联机，核心诉求），再铺 SA/S5/S2/S3。
> **2026-06-14 新增三块**（细分设计见各专文）：**SA 账号系统**（`ACCOUNT_DESIGN.md`）、**S5 commercial 商业服务**（`COMMERCIAL_DESIGN.md`，钱包权威迁出 meta saves）、**S1-M1~M4 gateway/matchsvc 拆分**（`MATCHSVC_DESIGN.md` + `GATEWAY_DESIGN.md`，已在 §S1 架构修订迁移登记）。建议顺序：SA（登录门槛，门面）→ S5（经济权威底座）→ S1-M（联机拓扑拆分，动链路最大放最后）。

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

## SA — 账号系统（登录 + 单机门槛）

> 细分设计见 `ACCOUNT_DESIGN.md`。决策：默认要求登录 + 登录界面带「单机试玩」入口；四种登录并存（邮箱密码 / OAuth / 微信 / 匿名升级）；一账号多凭证，匿名可转正不丢档。

### 服务器（meta）
- [ ] **SA-1 accounts 模型扩展 + 密码登录**：`accounts` 加 `password{loginId,hash}`/`oauth[]`/`displayName`/`isAnonymous` + 索引（`password.loginId` 稀疏唯一、`oauth.provider+sub` 唯一）；`POST /auth/register`（argon2/bcrypt 哈希）+ `POST /auth/login`（比对哈希）+ `POST /auth/password/change`；AuthResult 加 `isAnonymous`。**依赖**：S0-6,7。**验收**：注册→登录→改密闭环；重复 loginId 拒；密码哈希存储。
- [ ] **SA-2 OAuth + 绑定/升级**：`POST /auth/oauth`（授权码流，先接 Google，`state` 防 CSRF，服务端换 token 取 sub）；`POST /auth/bind`（持现有 JWT 把新凭证挂当前 accountId，未占用则升级 `isAnonymous=false`、存档/钱包保留；已占用返 `ALREADY_BOUND`）。**依赖**：SA-1。**验收**：OAuth 登录通；匿名 device 账号 bind 邮箱后同 accountId、PvE 进度不丢。

### 客户端
- [ ] **SA-3 LoginScene + 登录门控**：新增 `LoginScene`（canvas，视图机 `landing/password/register/oauthWait`，复用 RoomScene 输入键盘模式，i18n `auth.*` zh/en/de 全翻）；`app.ts` 启动门控改为「非微信 + 无有效会话 → goLogin」（微信静默 wx.login 跳过，A6）；正式登录后持久化 token（`nw_token` + 过期）免重输。**依赖**：SA-1、S0-5。**验收**：默认进登录界面；登录后直达大厅；重启免重输密码。
- [ ] **SA-4 单机门槛 + 转正**：登录界面「单机试玩」→ `goLobby({offline:true})`；大厅屏蔽联机/排位/商店/充值入口并引导登录，PvE/PvP-vs-AI/本地录像可玩；登录/注册成功走 `SaveManager.reconcile` 合并本地匿名存档（PvE 进度不丢）；新增登出（清 token 回登录，本地存档保留）。**依赖**：SA-3。**验收**：单机可玩且联机/付费被拦；试玩转正后进度合并不丢。

---

## S1 — 好友房 + 锁步联机（gameserver 服务）

> 本阶段只做 `friendly`（好友码房）。`ranked` 匹配队列 + ELO 结算见 S1-R（稍后）。

### 服务器（gameserver）
- [x] **S1-1 gameserver**：WebSocket 接入（`ws`），JWT 鉴权、心跳、断线检测。**依赖**：C-2,3。**验收**：连接/心跳/断开事件正确。✅ `gameserver/src/index.ts` 握手 `?token=<jwt>`（`verifyToken` 失败 4401）→ `Connection` → `RoomManager`；30s 心跳巡检（两轮无 pong/消息 `terminate`）；`close` 收口路由到房间。
- [x] **S1-2 room-service**：建房（短房间码）/ 输码加入 / ready / 满员开局；房间状态走 `RoomRegistry`（内存实现）。开局分配 `seed` + `startTick` + `mode` 下发双方。**依赖**：S1-1。**验收**：两连接进同一房、同时收到一致 seed。✅ `RoomManager` 建房生成 6 位无歧义码走 `InMemoryRoomRegistry`、`ROOM_NOT_FOUND`/`ROOM_FULL`/`RANKED_UNAVAILABLE`/`ALREADY_IN_ROOM`、同账号顶替；`room_start` 房主开局下发 `match_start{seed, start_frame, mode, local_side}`。端到端实测双方同 seed + 各自 local_side。
- [x] **S1-3 节拍器中继（M14）**：gameserver 持房间时钟，模拟 30Hz、**每 100ms（10Hz）下发 `frame_batch{to_frame, frames}`（3 帧）**；收到 `cmd_submit` 塞进当前窗口帧；空窗只发 `to_frame` 水位；同帧多指令按 `side` 确定性排序。**依赖**：S1-2、C-2。**验收**：双端收到逐字相同的帧序列；空闲下 `to_frame` 每 100ms 稳定 +3。✅ `Room` `setInterval(100ms)` 每拍 `curFrame+=3`；`cmd_submit` 落本批次 `to_frame` 帧、`side` 升序稳定排序；空窗 `frames=[]`。实测空闲 `to_frame` 序列 `[3,6,9]` 全空帧、`cmd_submit` 双端同帧同 side。
- [x] **S1-4 非空帧日志 + 重连 + 60s 判负**：每局留非空帧日志；掉线则停发该房间帧 + `peer_dc{grace_ms:60000}` 起 60s，`conn_resume{last_frame}` 下发 `seed + 之后非空帧 + cur_frame` 续打，**超时掉线方判负** `match_over{reason:'disconnect'}`（M10）。**依赖**：S1-3。**验收**：重连续打一致；超时正确判负。✅ `Room.log` 仅存非空帧；断线停 metronome + `peer_dc{side, grace_ms:60000}` + 60s timer；`resume` 下发 `conn_resync{seed, start_frame, log(>last_frame), cur_frame}`、双方在线清宽限续发；超时/认输 `match_over{reason:'disconnect'}`。实测 peer_dc、停发、resync、续发全过。
- [x] **S1-5 局末结算**：双端 `match.result{hash}` → 比对 desync；写 `matches` 归档（friendly 仅记结果）。**依赖**：S1-3。**验收**：结果落库；hash 不一致标 mismatch。✅ 双方 `match_result{state_hash}` 齐 → 比对 → `match_over{reason: base|mismatch, mismatch}` + `matches.insertOne`（`seed`/`players`/`hashOk`/`reason`）；Mongo 不可用降级纯中继不归档。friendly 正常结束 `winner_side` 客户端权威（归档 `winner=-1`），disconnect/认输服务器权威。实测一致→base、不一致→mismatch。
- [~] **S1-R ranked 队列 + ELO**：匹配队列按 ELO 配对；ranked 局末算 ELO 写 `saves.pvp`（单文档原子更新，服务器权威）。**依赖**：S1-5、S2-1。**验收**：天梯分服务器权威、刷不动。✅ **服务端已落地**：`shared/src/ladder.ts`（9 段段位 `RANK_TIERS` + `eloToRank` + `computeEloDelta`(K=32 零和) + `nextStreak`，纯函数双端同源）；`gameserver/src/Matchmaking.ts`（ELO 邻近配对，等待越久窗口越宽 `base100+50/s`，注入 now+autoTick 可测）；`RoomManager`：RANKED→读 `saves.pvp.elo` 入队（无 Mongo 返 `RANKED_UNAVAILABLE`）、配对回调建 ranked 房 `room.beginRanked()`（无 ready/房主）、`settleRanked`/`applyPvp` 乐观锁 rev 守卫整体替换 save（同 `putSave` 约定，避免与客户端 PUT /save 互覆盖）；`Room` 加 `beginRanked()`、`reportResult(+winnerSide)`、`endMatch` 改 async 按 mode 结算——**ranked 胜负 = 双方上报 hash+winner 一致才认（无服务器裁判 S1-J）**，不一致作废不动 ELO；掉线/认输服务器权威判对手胜 + 结算；`match_over.elo{delta,after,rankAfter}` 按 side 下发。`transport.proto` `MatchResult` 加 `winner_side`。**验收**：`tsc -b shared metaserver gameserver` 全绿 + 67 测试（+4 ladder / +5 matchmaking / +4 ranked 端到端：匹配→开局→一致结果±16 写 saves、hash 不一致作废、认输判胜+ELO、无 Mongo 拒）。✅ **客户端切片已落地**：`npm run proto:gen` 重生 `net/proto/transport.ts`（`MatchResult.winnerSide`）；`NetClient.reportResult(stateHash, winnerSide)` + `NetSession.createRanked()`（入队）/`cancelQueue()`（`room_leave` 退队）；`RoomScene` idle 加「排位赛」入口 + `searching` 视图（spinner + 取消）；`app.goGameNet` 局末上报真实 winner，**ranked 等服务器 `match_over.elo` 再进结算**（6s 兜底），`ResultScene` 显 ELO 变化 + 段位（i18n `room.ranked`/`searching`/`cancelSearch`、`result.eloDelta`、`rank.*` 9 段 zh/en/de 全翻）。tsc + 116 测试 + web 构建全绿。✅ **收尾两项已落地**：①大厅段位徽章——`LobbyScene` 头部右上常驻显「段位 · ELO」（`pvp` 经 callbacks 传入，每次 `goLobby` 取最新；`rank.unranked` 等 i18n 全翻）；②ranked 局末 `SaveManager.refresh()`（pull + reconcile，复用 token 不重 auth）刷新本地权威 `pvp`，`app.finishNet` 在 ranked 结束时触发，无需等下次 bootstrap。client tsc + 120 测试（+4 `save-manager`）+ web 构建全绿。**待办**：档案场景（ProfileScene 尚未实现）的段位/战绩页 + 双真机联调（用户自行）；分段差异化胜利金币（ECONOMY §2.3b）依赖经济服务 S2，暂未接。
- [ ] **S1-J（可选）服务器裁判**：仅重大比赛——gameserver headless 跑 `GameEngine` 复算校验。**依赖**：S1-3、C-1。**验收**：篡改输入被检出。
- [~] **S1-RP 录像录制 + 回放**：定义 `replay.proto`（复用 `FrameCmds`）；录制（PvE 客户端记玩家指令 / PvP gameserver 持久化输入日志到 `matches.replayRef`）；实现 `ReplayInputSource` + 回放播放器（同 seed 起新引擎喂输入流），回放前校验 `engineVersion`。**依赖**：C-4、S1-5。**验收**：一局 PvE + 一局 PvP 录像回放与原局逐 tick 一致；改 engineVersion 回放被拒。**注**：PvE 录制可随战役（CAMPAIGN P1）先落地，不必等联机。✅ **客户端录制/回放已落地**：`code/src/game/net/ReplayInputSource.ts` 新增 `RecordingInputSource`（透明包装任一 `InputSource`，捕获引擎每 tick 确认的指令集，稀疏只存非空帧、单调、深拷贝防污染；`snapshot()` 产出 `Replay`）+ `ReplayInputSource`（喂录像 `Replay`，`take` 永不停步、`submit` 忽略、构造校验 `engineVersion` 不符抛 `ReplayVersionError`）；`Replay` 类型扩展为镜像 `replay.proto` 字段（`engineVersion`/`mode`/`seed`/`configRef`/`frames`/`endFrame`/`meta`，命令保留为 TS 对象、JSON 可序列化）+ `ENGINE_VERSION=1`。barrel 导出全部。**验收测试**（`test/replay-input-source.test.ts`，10 例）：PvP-vs-AI + campaign(PvE) 录制→回放终局指纹全等（PvE 录像只含 owner 0 玩家指令、敌方波次由 seed+level 重算）、JSON round-trip 不破、engineVersion 不符被拒、take/submit/sparse 语义。tsc 干净 + 110 测试全绿 + web 构建通过。✅ **接录制 + 回放 UI + 服务端持久化已落地（A+B）**：(A) `GameScene` 自建局（campaign / PvP-vs-AI）用 `RecordingInputSource` 包 `LocalInputSource`，局末 `onGameEnd(winner, stats, replay?)` 透出录像；`app.ts` 建 `ReplayStore`（`game/meta/ReplayStore.ts`，key `nw_replays_v1`，最近 12 局 ring，损坏退化、JSON round-trip）落盘并把录像传 `ResultScene`；`ResultScene` 有录像时显「观看回放」按钮 → `app.goReplay` → 新增 `ReplayScene`（`scenes/ReplayScene.ts`：`ReplayInputSource` 驱动 + `GameRenderer` spectator 模式[新增构造参数，跳过 input 接线、纯观看] + 自绘 transport 覆盖层：播放/暂停、1×/2×/4× 变速、进度条、退出、结束/版本错误提示）。i18n `replay.*` + `result.watchReplay` zh/en/de 全翻。(B) `server/contracts/replay.proto`（复用 transport `FrameCmds`，`Replay{engineVersion/mode/seed/configRef/frames/endFrame/meta}`）；gameserver 局末把已保留的非空帧日志零成本内嵌进 `matches.replay`（`Room.buildReplay`→`MatchArchive.replay`→`RoomManager.archive` 写 BSON，`cmds[].commands` 为 opaque binary 不解码；服务器逻辑无关 M12 → `engineVersion=0`，客户端回放自校验）；`shared/mongo.ts` `MatchDoc.replay?: MatchReplayDoc`。**验收**：client tsc + 116 测试全绿（+6 `test/replay-store.test.ts`）+ web 构建；server `tsc -b shared metaserver gameserver` 全绿。**待办**：大局录像转对象存储（`replayRef`）+ 录像分享；服务端 PvP 录像（opaque bytes）→ 客户端 `Replay` 的解码回放适配（复用 `NetInputSource.ingestFrame` 思路）。

### 架构修订迁移（2026-06-13，`META_DESIGN.md §1.1/§6.1`、`SERVER_API.md §8`）

> 把 S1 的 gameserver 中心式（自管匹配/分配/结算 + 连 Mongo）迁为「**5 组件 + 控制面/数据面分离**」（M16–M20）：meta(REST 请求面) + gateway(WS 控制面) + game(WS 数据面) + matchsvc(私有大脑)。目标：**gameserver 永不连库、meta 纯无状态 REST、控制面推送顺畅**。这些任务在现有 S1 实现之上做搬迁，非推倒重来。

- [ ] **S1-M1 matchsvc + gateway（合一进程）**：`server/` 新增第四包（gateway+matchsvc 两模块、对外只暴露 gateway 公开 WS，matchsvc 内部 RPC 不绑公网，M20）。从 gameserver 搬 `Matchmaking.ts`（匹配队列）+ 房间分配 + `RoomRegistry`；新增 game 注册表（`/mm/game/register`+`heartbeat`）+ 签 ticket（M18）；gateway 实现控制面 WS（`?token=` 握手 + `account→socket` 映射 + `mm_*`/`room_*` 转发 matchsvc + `room_state`/`match_found` 回推，`SERVER_API.md §8.4`）。内部 RPC 见 §8.1。Redis 仅崩溃副本（前期可省）。**依赖**：M17/M20 决策。**验收**：`tsc` 干净；不连 Mongo；玩家经 gateway WS 跑通建房→加入→ready→start→收到 ticket，触达不到 matchsvc。
- [ ] **S1-M2 gameserver 瘦身（去库）**：删 gameserver 内 `Matchmaking`/`settleRanked`/`applyPvp`/`matches` 归档/读 `saves.pvp` 及房间阶段消息（room_*/match_start 移到 gateway）；握手改 `?ticket=<jwt>` 验签 + 交叉核对（`SERVER_API.md §8.2`）；向 matchsvc 注册 + 心跳；`RoomManager` 瘦成纯内存帧中继。**依赖**：S1-M1。**验收**：gameserver bundle 无 Mongo client；断网 Mongo 仍能跑完整局中继。
- [ ] **S1-M3 game→meta 局末上报 + gateway→meta 取 ELO**：gameserver 局末改 POST `/internal/match/report`（hash×2 + winner×2 + 录像 opaque，幂等 `room_id`，失败重试/排队）；meta 新增内部端点接收 → 判定胜负 + 写 ELO（乐观锁）+ 归档 + 存录像（§8.3），及 `GET /internal/elo`（§8.5）供 gateway 入队取分。从 gameserver 移走的 ELO/归档逻辑落到 meta。**依赖**：S1-M2、S1-R。**验收**：ranked 结算与归档全在 meta；matchsvc 不连 Mongo；meta 短暂 down 时 game 端排队重试不丢结果。
- [ ] **S1-M4 客户端三通道适配**：房间/匹配（`mm_*`/`room_*`）从 game WS 迁到 **gateway 控制面 WS**（双向实时，§8.4）；收 `match_found{game_url,ticket}` 再连 game 数据面 WS。`NetSession` 拆出 gateway 连接（控制面）与 game 连接（锁步），`RoomScene` 适配；auth/save/economy 仍走 meta REST。**依赖**：S1-M1。**验收**：玩家全程只连 meta(REST)+gateway(WS)+game(WS)，触达不到 matchsvc；大厅房间事件实时刷新无需轮询。

### 客户端
- [x] **S1-6 NetClient**：封装 ws 连接、重连、消息编解码（用 C-2 协议）。**依赖**：C-2。**验收**：掉线自动重连。✅ `code/src/net/NetClient.ts`：退避重连 + 代次作废滞后回调 + 首/重连 open 区分（仅重连触发 `onReconnect`，上层据此发 conn_resume）+ 应用层心跳 + 未 open 丢弃发送；平台 socket 抽象 `IPlatform.connectSocket`（Web/CrazyGames=`BrowserGameSocket`，微信=`WechatGameSocket`）；C-2 ts-proto 编解码。6 单测（假 socket）+ 端到端真 NetClient↔真 gameserver 整局 friendly 跑通。**注**：C-2 客户端 proto codegen 同期落地（ts-proto via buf，`code/buf.gen.yaml`+`scripts/gen-proto.mjs`+`npm run proto:gen`，产物 `src/net/proto/`，线兼容回归 `test/proto-wire-compat.test.ts`）。
- [x] **S1-7 节拍驱动（NetInputSource）**：实现 `NetInputSource`（C-4 的联机实例）——消费 gameserver 的 `frame_batch`、按 `to_frame` 推进引擎并把 3 帧摊到 100ms 播放，保持 ~1 批次缓冲，缓存空则暂停、超时追帧；出牌即发 `cmd_submit`（不预算帧号）。单机/PvE 走 `LocalInputSource` 不变。**依赖**：S1-6、S1-3、C-4。**验收**：缓冲吸收 <100ms 抖动无感；服务器停发即暂停；无回滚。✅ `code/src/game/net/NetInputSource.ts`：`submit`→`game.proto` `PlayerCommands` opaque bytes `cmd_submit`（不预算帧号，owner/tick 占位由服务器派 side+帧）；`handleServerMsg` 消费 `match_start`/`frame_batch`/`conn_resync`，`FrameCmds` 解码回 `PlayerCommand[]`（owner=`SideCmd.side`、tick=`FrameCmds.frame`，保服务器排序）；`take(frame)` 释放已确认帧、未确认 `null` 停步（锁步、无预测/回滚）；播放头落最新水位后 `bufferFrames`(默认 1 批=3) 吸收 <100ms 抖动；水位单调（陈旧批次不回退）；`conn_resync` 跳水位快进追帧。新增 `GameMode 'netplay'`（双方真人、不跑本地 AI/波次，`step` 只处理确认指令集）；`game.proto` `PlayCard` 加 `row`（陨石目标行）+ `npm run proto:gen`。验证：tsc 干净 + 19 新测试（take/缓冲/水位/解码/no-rollback/resync + 双客户端同 seed 同流逐 horizon fingerprint 全等 + 停发暂停/重连追帧/抖动吸收）+ web 构建通过（共 106 绿）。**注**：双引擎单进程因模块级 id 计数器交错，测试改为录制合流帧流后顺序回放对拍。
- [x] **S1-8 RoomScene**：建房/房间码展示/输码加入/ready/倒计时开打（UI 见 `UI_DESIGN.md`）。**依赖**：S1-6、S1-2。**验收**：完整建房→加入→开局流程。✅ `code/src/scenes/RoomScene.ts`（canvas 绘制，视图机 `idle → codeEntry → connecting → inRoom`；i18n `room.*`，zh/en/de 全翻）+ `code/src/net/NetSession.ts`（绑 `NetClient`+`NetInputSource`：路由 ServerMsg → input & UI、重连 `onReconnect`→`conn_resume{roomId, resumeFrame()}`、room 动作转发、`onMatchStart` 建引擎）。`app.ts`：大厅底栏「社交」格 → `goRoom()`；`match_start` → `createGameEngine({seed, mode:'netplay'}, session.input)` → `GameScene`（新增 `engine?` 选项接预建引擎）；局末 `reportResult(FNV-1a(winner+stats))`（S1-5 握手）。无服务端配置时房间 UI 仍可开（`available:false`，create/join 弹「联机服务不可用」）。`LobbyScene` 加 `onOpenRoom`+社交格命中。验证：tsc 干净 + 100 测试全绿 + web 构建通过 + 浏览器实测 idle/codeEntry 两视图（社交入口 → 创建/加入按钮 → 输码键盘逐字填充）。**注**：①`inRoom`（双槽/ready/start/房间码）需活 gameserver 推 `room_state` 才显示，留 S1-9 双机联调验收；②`GameRenderer` 仍以 owner-0（下方）视角渲染，joiner（localSide 1）暂不翻转棋盘，正确换边视角属 S1-9。

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

> ⚠️ **S2 与 S5 的关系**：原 S2 把钱包/商店/盲盒放在 meta 内。2026-06-14 决策把这些迁到独立 **commercial 服务**（见 S5 + `COMMERCIAL_DESIGN.md`）。落地顺序上 **S5 取代 S2-1~4 的服务端钱包实现**（meta 改为编排者调 commercial），S2-5~7 客户端/防刷验收仍有效（客户端只认 meta，不感知 commercial）。若先做 S5 则 S2 服务端任务并入 S5。

---

## S5 — commercial 商业服务（钱包 / 充值 / 消费 / 盲盒，独立库）

> 细分设计见 `COMMERCIAL_DESIGN.md`。决策（M21）：钱包权威从 meta `saves.wallet` 迁到 **commercial 独立库** `notebook_wars_commercial`；commercial 玩家不可达，**meta 唯一调用方**（编排者）；抽卡「扣币+随机+记账」同库原子，物品由 meta 据结果发货；跨服务用 orderId 幂等 + 待发货对账（saga）。

### 服务器
- [ ] **S5-1 commercial 包 + 独立库**：`server/` 新增 workspace `commercial`（CJS，对齐 gameserver 结构）；`createCommercialMongo`（库名 `notebook_wars_commercial`，集合 `wallets`/`ledger`/`orders`/`recharges`/`gachaHistory` + 索引）；`NW_COMM_PORT`(默认 18082)/`NW_COMM_MONGO_*`/`NW_INTERNAL_KEY`（内部密钥鉴权 `/internal/*`，不暴露公网）。**依赖**：S0-6。**验收**：`tsc -b` 全绿；commercial 起得来、连独立库；无内部密钥的请求被拒。
- [ ] **S5-2 钱包 + 流水**：`GET /internal/wallet`（余额+pity）；`wallets` 单文档原子扣/加币（`coins>=cost` 守卫）+ 每笔写 `ledger`。**依赖**：S5-1。**验收**：并发扣币不超支；每次余额变更有流水。
- [ ] **S5-3 盲盒 RNG + 商店扣币**：`POST /internal/gacha/draw`（crypto 真随机按 weight + 保底，扣币+RNG+写 gachaHistory/orders 同操作，`orderId` 幂等）；`POST /internal/shop/charge`（扣币+orders）；`POST /internal/order/delivered`（闭环）。**依赖**：S5-2。**验收**：单抽/十连原子；保底命中可复现；orderId 重放返回原结果不重扣。
- [ ] **S5-4 充值 + 广告加币**：`POST /internal/recharge/verify`（验平台票据→加币→recharges 幂等）；`POST /internal/ads/credit`（meta 已校验后加币记账）。**依赖**：S5-2。**验收**：未验单不发币；重复票据/重复 receiptId 幂等。
- [ ] **S5-5 meta 编排 + 钱包镜像 + 对账**：meta 的 `/shop/buy`/`/gacha/draw`/`/ads/reward`/`/iap/verify` 从 501 改为「校验 JWT → 调 commercial → 据结果写 inventory（meta 库，orderId 幂等）→ 标 delivered → 写 `SaveData.wallet/gacha` 镜像 → 回推」；`GET /save` 顺带拉 commercial 余额填镜像；未发货订单对账（GET /save 顺带 + 兜底定时扫 `orders status:charged`）。`shared/mongo.ts` 从 meta 库移除 gachaHistory/walletLog/iapReceipts。**依赖**：S5-3,4。**验收**：抽卡端到端（扣币→发物品→镜像刷新）；meta 在发货前崩 → 下次 GET /save 补发不丢不重。

### 客户端
- [ ] **S5-6 客户端零感知验收**：客户端继续只读 `save.wallet.coins`、只调 meta economy 端点（不感知 commercial）；进 ShopScene 前 `GET /save` 刷新余额镜像。**依赖**：S5-5、S2-5。**验收**：客户端无需改动钱包读取逻辑；余额展示与 commercial 权威一致。

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

- [~] **I-1** 新增命名空间键（`zh.ts` 为唯一来源，`en`/`de` 同步补全，否则编译报错）：`auth.*`（登录界面，SA）/ `meta.*` / `shop.*` / `gacha.*` / `collection.*` / `room.*` / `profile.*`。随对应 UI 任务一起加。`room.*` 已随 S1-8 落地（zh/en/de 全翻）；`auth.*` 随 SA-3；其余随后续场景。

---

## 风险与注意

- **确定性**：联机/养成逻辑在 `game/` 内严禁 `Math.random()`，走注入 `Prng`；**gacha 例外**（服务端 `crypto`，不进回放，见 `META_DESIGN.md §8`）。
- **硬墙**：PvP 引擎构造签名永不出现 `SaveData`（编译期隔离），配 S3-3 单测回归。
- **钱包零信任**：客户端永不直接写 `wallet`/`inventory`；全走服务器事务 + 回推。
- **微信合规**：联机、虚拟支付、备案需单独排期（`META_DESIGN.md §10`）。
