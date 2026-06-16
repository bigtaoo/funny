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
| **S5** ✅ | commercial 商业服务（钱包/充值/消费/盲盒，独立库） | 钱包权威迁 commercial，扣币+发货 saga 收敛（已实现） |
| **S3** | PvE 养成（材料 + 硬墙）+ 收集 + 选关 | 养成 / 收集 / 选关闭环；硬墙单测绿 |
| **S4** | IAP 验单 + 反作弊 hash + 上线加固 | 充值安全，对局 hash 比对 |

> 先打通 S0/S1（云存档 + 好友联机，核心诉求），再铺 SA/S5/S2/S3。
> **2026-06-14 新增三块**（细分设计见各专文）：**SA 账号系统**（`ACCOUNT_DESIGN.md`）、**S5 commercial 商业服务**（`COMMERCIAL_DESIGN.md`，钱包权威迁出 meta saves）、**S1-M1~M4 gateway/matchsvc 拆分**（`MATCHSVC_DESIGN.md` + `GATEWAY_DESIGN.md`，已在 §S1 架构修订迁移登记）。建议顺序：SA（登录门槛，门面）→ S5（经济权威底座）→ S1-M（联机拓扑拆分，动链路最大放最后）。

---

## 公共底座（贯穿所有阶段）

- [x] **C-1 仓库结构（三包 workspaces + contracts）**：`server/` 下建 **`contracts/`（`openapi.yml` + `transport.proto`/`game.proto`）+ `shared/`（`@nw/shared`）+ `metaserver/`（REST）+ `gameserver/`（WS）**，metaserver/gameserver 可独立部署（`META_DESIGN.md §6.1`）。`shared`/`gameserver` 只 codegen `transport.proto`，**不依赖 `client/src/game`**（仅可选裁判任务才引）。**主要文件**：根/`server` `package.json` workspaces、各包 `tsconfig.json`。**验收**：`metaserver`/`gameserver` 各自 `tsc --noEmit` 干净，bundle 内无 PIXI/引擎运行时/`game.proto`。✅ npm workspaces（shared/metaserver/gameserver），`npx tsc -b` 三包全绿；metaserver=ESM(NodeNext)、shared/gameserver=CJS；服务端不 import `client/src/game`。
- [~] **C-2 契约（OpenAPI + protobuf）+ 共享库**：写 **`openapi.yml`**（REST 端点 design-first，M15）→ codegen metaserver 路由+校验（`fastify-openapi-glue`）与客户端 typed fetch（`openapi-typescript`+`openapi-fetch`）；写 `transport.proto`（房间/锁步控制，`Envelope` oneof；`commands: bytes` opaque）+ `game.proto`（`PlayerCommand`，仅客户端↔客户端）→ `ts-proto` codegen 双端。`shared` 另含 JWT 校验、Mongo client 工厂、`RoomRegistry` 接口（内存实现，§6.5 留 Redis 口子）；dev 模式加二进制帧解码打印。**依赖**：C-1。**验收**：双端从同一 `openapi.yml`/`.proto` codegen；服务器转发 `commands` 字节流不解码。✅ 已写 `openapi.yml`（10 端点 + SaveData schema）、`transport.proto`、`game.proto`；`@nw/shared` 含 SaveData/ApiResp/ErrorCode、JWT、Mongo 工厂+集合、`InMemoryRoomRegistry`；metaserver 经 `fastify-openapi-glue` 从 spec 装配（冒烟：10 路由 + `$ref` 解析通过）。**待办**：dev 二进制帧解码打印（随客户端 S0-5/S1-6 落地）。✅ **proto codegen 已落地**（ts-proto via buf）；✅ **openapi-typescript REST codegen 已落地（2026-06-15）**：`client/scripts/gen-openapi.mjs` + `npm run rest:gen` 从 `openapi.yml` 生成 `client/src/net/openapi.ts`（产物提交），`ApiClient` 纯线协议 DTO（ShopItem/GachaPool/GachaResultEntry/MatchHistoryEntry/AuthResult/ServerReplay）改为 alias 生成 schema，契约漂移 tsc 暴露（SaveData/SyncPatch/Rarity 仍用客户端自有 meta 镜像）。
- [x] **C-3 部署脚手架（两进程）**：Linux VPS 上 `mongod`（**单节点副本集** `rs.initiate()`，§6.3）+ `metaserver`/`gameserver` 两进程（pm2）+ caddy/nginx 反代（`/api/*`→metaserver、`/ws`→gameserver，自动 HTTPS）。**依赖**：C-1。**验收**：一条脚本起全栈，`wss://host/ws` 可连、`https://host/api` 可访。✅ **两条路线**：①Docker（推荐）——`server/Dockerfile`（多阶段，单镜像 build 全 workspace，metaserver/gameserver 用 `command` 区分进程）+ `docker-compose.prod.yml`（mongo 单节点副本集自动 `rs.initiate`（成员 host=容器名 `mongo`）+ metaserver + gameserver + caddy，全命名卷持久化）+ `Caddyfile`（`handle_path /api/*` 剥前缀转 metaserver:8080、`handle /ws*` 保路径转 gameserver:8081，`{$NW_DOMAIN}` 真域名时自动签 Let's Encrypt）+ `.env.example`（`NW_JWT_SECRET`/`NW_DOMAIN`/`NW_WX_*`）+ **一条脚本 `deploy/up.sh`**（`docker compose -f docker-compose.prod.yml --env-file .env up -d --build`）。②pm2——`ecosystem.config.cjs`（nw-meta fork、nw-game 单实例房间亲和；密钥从 shell env 继承）。metaserver 加 `/health` 存活探针（不入 openapi，反代 `/api/health` 命中）。`tsc -b` 三包全绿。
- [x] **C-4 统一输入管线（InputSource）**：引擎命令入口从「UI 直接 `processCommand`」改为「每 tick 从注入的 `InputSource` 消费确认指令集」；实现 `LocalInputSource`（单机自转发，DELAY 0）。AI/WaveDirector 作为 tick 内输入源接入。**依赖**：—（纯客户端引擎重构）。**主要文件**：`client/src/game/GameEngine.ts`、新 `game/net/InputSource.ts`。**验收**：单机 PvE/练习走新管线，38+ 测试 + 黄金回放确定性不破。`NetInputSource`（S1-7）/`ReplayInputSource`（S1-RP）是其另两个实例。✅ 新增 `game/net/InputSource.ts`（`InputSource` 接口 `submit`/`take(frame)→cmds|null` + `LocalInputSource` DELAY 0 自转发，行为等价原 `pendingCommands`）；`createGameEngine(config, input?)` 可选注入（缺省 Local）；`playCard`/`upgradeBase` 改 `input.submit`，`tick(dt)` 循环改 `input.take(currentTick)`（返回 `null` 即停步，为 S1-7 net 缓冲留口）；AI(PvP)/WaveDirector(PvE) 仍在 `step` 内按原序消费（注释标为 tick 内输入源）。barrel 导出 `LocalInputSource`/`InputSource`。tsc 干净 + 63 测试全绿（黄金回放/campaign 确定性不破）+ web 构建通过。

---

## S0 — 存档底座 + 云存档

### 客户端
- [x] **S0-1 SaveData 模型**：`client/src/game/meta/SaveData.ts`（纯数据，字段见 `META_DESIGN.md §3.1`）+ `LevelRecord` / `Rarity` 等子类型。**依赖**：—。**验收**：类型完整，含 `version`/`rev`/`accountId`。✅ 镜像 `server/shared/src/types.ts`（含 `makeNewSave`/`SyncPatch`/`extractSyncPatch`/`SYNC_KEYS`/`SAVE_STORAGE_KEY=nw_save_v1`），纯数据无 PIXI。
- [x] **S0-2 迁移链**：`migrate(raw)→SaveData` + `MIGRATIONS[]`（v0→v1…）。**依赖**：S0-1。**验收**：喂残缺/旧版对象能补全到当前 version，单测覆盖。✅ `meta/migrate.ts`：MIGRATIONS 顺序升级 + `fillDefaults` 深合并兜底（保留动态键如 best/flags 自定义项）+ 钉死 version；null/损坏对象 → 全新档；幂等。
- [x] **S0-3 SaveStore 抽象 + 本地实现**：`loadLocal/saveLocal` 走 `IPlatform.storage`（key `nw_save_v1`），把现有 `nw_seen_intro`/`nw_locale` 收编进 `flags`（保留旧 key 读兼容）。**依赖**：S0-1,2。**验收**：本地存取 round-trip 一致。✅ `meta/SaveStore.ts` `LocalSaveStore`（load 含迁移+损坏 JSON 退化全新档；`nw_seen_intro`→`flags.seen_intro` 收编不删旧 key）。**注**：`nw_locale` 是字符串、由 i18n 自管（`flags` 仅布尔），不收编。pull/push 移到 `ApiClient`+`SaveManager`（本地持久化零网络依赖，便于单测）。
- [x] **S0-4 匿名账号**：`getAccountId()`——微信 `wx.login`→code（交服务器换 openid），Web/CrazyGames 生成并持久化设备 UUID。封进 `IPlatform`。**依赖**：—。**验收**：同设备稳定返回同 id。✅ `IPlatform.getAuthCredential(): Promise<AuthCredential>`（`{kind:'device',deviceId}` | `{kind:'wx',code}`）；Web/CrazyGames 用 `platform/uuid.ts` `getOrCreateDeviceId`（crypto.randomUUID→getRandomValues→时间回退，持久化 key `nw_device_id`）；微信 `wx.login`→code。
- [x] **S0-5 云同步客户端**：`pull/push`（HTTP，带 `If-Match: rev`），离线优先 + 防抖 2s 上行 + 409 冲突走 pull-merge（服务器权威段以服务器为准）。**依赖**：S0-3,4、S0-7。**验收**：断网可玩，恢复后自动同步。✅ `net/ApiClient.ts`（fetch + ApiResp 包络；auth/device·auth/wx·GET/PUT save；putSave 带 If-Match，409 返回 `{kind:'conflict',save}` 不抛）+ `meta/SaveManager.ts`（loadLocal 立即可玩 → bootstrap auth+pull+reconcile → update() 改同步段立即落本地+防抖 2s push → 409 reconcile 后重试一次；reconcile：权威段云端为准、progress 并集、materials/pveUpgrades 取较大、equipped/flags 本地覆盖）+ `net/config.ts`（`getApiBaseUrl`：`__NW_API_BASE__`>localStorage `nw_api_base`>null；null→纯本地离线优先）。`app.ts` 接入：构建 SaveManager、`bootstrap()` 非阻塞、Intro 门控改读 `flags.seen_intro`。**单测**：`client/test/saveData.test.ts` 11 用例（migrate/round-trip/收编/extractSyncPatch），全套 63 绿。**待联调**：S0-8 多设备同步（需起服务端 + 设 `nw_api_base`）。

### 服务器
- [x] **S0-6 Mongo 接入**：连接 + `saves` 集合（`{_id: accountId, save, rev}`）+ 索引。**依赖**：C-1,3。**验收**：本地 mongod 读写通。✅ `shared/src/mongo.ts` `createMongo` 工厂 + 6 集合句柄（saves/accounts/gachaHistory/walletLog/iapReceipts/matches）+ `ensureIndexes`（accounts.openid/deviceId 唯一稀疏索引等）。
- [x] **S0-7 save-service**（metaserver）：`GET /save`、`PUT /save`（accountId 由 JWT 解出；乐观锁：rev 不匹配返回 409 + 当前云端值）；`POST /auth/wx`、`POST /auth/device`。**依赖**：S0-6、C-2。**验收**：并发 PUT 只有一个赢，另一个收 409。✅ `metaserver/src/{service,save,accounts,auth}.ts`：auth 经 openid/deviceId upsert 取稳定 accountId + 签 JWT；`putSave` 用 `findOneAndUpdate({_id, rev})` 单文档原子守卫，rev 不匹配回 409 + 当前云端值；`getSave` 缺档自动建新档；bearerAuth 安全处理器从 JWT 解出 `req.accountId`。**端到端已验收**：连真 Mongo（docker compose 单节点副本集）跑 vitest 6 用例全绿（`metaserver/test/save.e2e.test.ts`）——auth 稳定 accountId / 无 token 401 / 新档 rev0 / 乐观锁 rev+1 / 过期 rev 409+云端值 / **并发同 rev 恰一个 200 一个 409** / 硬墙(PUT 携 wallet 被忽略)。`npm test`(tsc -b + vitest，需先 `docker compose up -d`)。

### 联调出口
- [ ] **S0-8 多设备同步验收**：A 设备改存档 → B 设备启动拉到最新；离线改 → 上线合并不丢。**依赖**：S0-5,7。

---

## SA — 账号系统（登录 + 单机门槛）

> 细分设计见 `ACCOUNT_DESIGN.md`。决策：默认要求登录 + 登录界面带「单机试玩」入口；四种登录并存（邮箱密码 / OAuth / 微信 / 匿名升级）；一账号多凭证，匿名可转正不丢档。

### 服务器（meta）
- [x] **SA-1 accounts 模型扩展 + 密码登录**：`accounts` 加 `password{loginId,hash}`/`oauth[]`/`displayName` + 索引（`password.loginId` 稀疏唯一、`oauth.provider+sub` 唯一，预建）；`POST /auth/register` + `POST /auth/login` + `POST /auth/password/change`；AuthResult 加 `isAnonymous`。**依赖**：S0-6,7。**已落地**：密码哈希用 Node 内置 `crypto.scrypt`（`shared/password.ts`，零依赖、跨平台，**非 argon2/bcrypt** 以免 Windows 原生编译）；`isAnonymous` **计算得出不落库**（`isAnonymousAccount(doc)`：仅 device 无 password/oauth/wx → true），避免漂移；loginId 大小写/空格不敏感（`normalizeLoginId`），邮箱与用户名都允许；`WEAK_PASSWORD` 由 handler 校验（openapi 不设 password minLength 以免被通用校验抢先 BAD_REQUEST）；新错误码 `LOGIN_ID_TAKEN/INVALID_CREDENTIALS/WEAK_PASSWORD/ALREADY_BOUND/OAUTH_FAILED`。`tsc -b` + 7 新 e2e（共 19 绿）。
- [ ] **SA-2 OAuth + 绑定/升级**：`POST /auth/oauth`（授权码流，先接 Google，`state` 防 CSRF，服务端换 token 取 sub）；`POST /auth/bind`（持现有 JWT 把新凭证挂当前 accountId，未占用则升级 `isAnonymous=false`、存档/钱包保留；已占用返 `ALREADY_BOUND`）。**依赖**：SA-1。**验收**：OAuth 登录通；匿名 device 账号 bind 邮箱后同 accountId、PvE 进度不丢。

### 客户端
- [x] **SA-3 LoginScene + 登录门控**：新增 `LoginScene`（canvas，视图机 `landing/password/register/submitting`，i18n `auth.*` zh/en/de 全翻）；`app.ts` 启动门控 `resolveEntry`（intro 后）：微信静默 wx.login（A6）/ 无 API 配置纯本地 / 有持久 token 复用会话（pull+reconcile）/ 否则 goLogin；正式登录后持久化 token（`nw_token`）免重输。**已落地**：文本输入用**隐藏 `<input>` 捕获键击**（桌面键盘 + 移动软键盘），canvas 渲染字段框、密码掩码为圆点、聚焦字段闪烁光标（**未用 RoomScene 的字符键盘**——邮箱/密码自由文本不适合定制键盘）；`ApiClient.register/login/changePassword`/`getToken`；`SaveManager.adoptSession(accountId)`（token 已持有，跳过 auth，pull+reconcile）。**注**：OAuth(`oauthWait`)首期不做（SA-2，仅留接口）；token 过期检测从简（乐观进大厅，pull 失败静默退化只读本地）。client tsc + 120 测试 + web 构建绿。
- [x] **SA-4 单机门槛 + 转正**：登录界面「单机试玩」→ `goLobby({offline:true})`；大厅 offline 模式社交/联机入口改路由到登录、顶部右上「登录/注册」chip（登录态显段位徽章 + 登出 chip）；PvE/PvP-vs-AI/本地录像可玩；登录/注册成功经 `SaveManager.adoptSession`→`reconcile` 合并本地匿名存档（PvE 进度不丢，权威段以云端为准）；`doLogout` 清 token 回登录、本地存档保留。**依赖**：SA-3。**注**：商店/充值入口尚未实现（占位），当前只拦联机/排位（社交格）。

---

## S1 — 好友房 + 锁步联机（gameserver 服务）

> 本阶段只做 `friendly`（好友码房）。`ranked` 匹配队列 + ELO 结算见 S1-R（稍后）。

### 服务器（gameserver）
- [x] **S1-1 gameserver**：WebSocket 接入（`ws`），JWT 鉴权、心跳、断线检测。**依赖**：C-2,3。**验收**：连接/心跳/断开事件正确。✅ `gameserver/src/index.ts` 握手 `?token=<jwt>`（`verifyToken` 失败 4401）→ `Connection` → `RoomManager`；30s 心跳巡检（两轮无 pong/消息 `terminate`）；`close` 收口路由到房间。
- [x] **S1-2 room-service**：建房（短房间码）/ 输码加入 / ready / 满员开局；房间状态走 `RoomRegistry`（内存实现）。开局分配 `seed` + `startTick` + `mode` 下发双方。**依赖**：S1-1。**验收**：两连接进同一房、同时收到一致 seed。✅ `RoomManager` 建房生成 6 位无歧义码走 `InMemoryRoomRegistry`、`ROOM_NOT_FOUND`/`ROOM_FULL`/`RANKED_UNAVAILABLE`/`ALREADY_IN_ROOM`、同账号顶替；`room_start` 房主开局下发 `match_start{seed, start_frame, mode, local_side}`。端到端实测双方同 seed + 各自 local_side。
- [x] **S1-3 节拍器中继（M14）**：gameserver 持房间时钟，模拟 30Hz、**每 100ms（10Hz）下发 `frame_batch{to_frame, frames}`（3 帧）**；收到 `cmd_submit` 塞进当前窗口帧；空窗只发 `to_frame` 水位；同帧多指令按 `side` 确定性排序。**依赖**：S1-2、C-2。**验收**：双端收到逐字相同的帧序列；空闲下 `to_frame` 每 100ms 稳定 +3。✅ `Room` `setInterval(100ms)` 每拍 `curFrame+=3`；`cmd_submit` 落本批次 `to_frame` 帧、`side` 升序稳定排序；空窗 `frames=[]`。实测空闲 `to_frame` 序列 `[3,6,9]` 全空帧、`cmd_submit` 双端同帧同 side。
- [x] **S1-4 非空帧日志 + 重连 + 60s 判负**：每局留非空帧日志；掉线则停发该房间帧 + `peer_dc{grace_ms:60000}` 起 60s，`conn_resume{last_frame}` 下发 `seed + 之后非空帧 + cur_frame` 续打，**超时掉线方判负** `match_over{reason:'disconnect'}`（M10）。**依赖**：S1-3。**验收**：重连续打一致；超时正确判负。✅ `Room.log` 仅存非空帧；断线停 metronome + `peer_dc{side, grace_ms:60000}` + 60s timer；`resume` 下发 `conn_resync{seed, start_frame, log(>last_frame), cur_frame}`、双方在线清宽限续发；超时/认输 `match_over{reason:'disconnect'}`。实测 peer_dc、停发、resync、续发全过。
- [x] **S1-5 局末结算**：双端 `match.result{hash}` → 比对 desync；写 `matches` 归档（friendly 仅记结果）。**依赖**：S1-3。**验收**：结果落库；hash 不一致标 mismatch。✅ 双方 `match_result{state_hash}` 齐 → 比对 → `match_over{reason: base|mismatch, mismatch}` + `matches.insertOne`（`seed`/`players`/`hashOk`/`reason`）；Mongo 不可用降级纯中继不归档。friendly 正常结束 `winner_side` 客户端权威（归档 `winner=-1`），disconnect/认输服务器权威。实测一致→base、不一致→mismatch。
- [~] **S1-R ranked 队列 + ELO**：匹配队列按 ELO 配对；ranked 局末算 ELO 写 `saves.pvp`（单文档原子更新，服务器权威）。**依赖**：S1-5、S2-1。**验收**：天梯分服务器权威、刷不动。✅ **服务端已落地**：`shared/src/ladder.ts`（9 段段位 `RANK_TIERS` + `eloToRank` + `computeEloDelta`(K=32 零和) + `nextStreak`，纯函数双端同源）；`gameserver/src/Matchmaking.ts`（ELO 邻近配对，等待越久窗口越宽 `base100+50/s`，注入 now+autoTick 可测）；`RoomManager`：RANKED→读 `saves.pvp.elo` 入队（无 Mongo 返 `RANKED_UNAVAILABLE`）、配对回调建 ranked 房 `room.beginRanked()`（无 ready/房主）、`settleRanked`/`applyPvp` 乐观锁 rev 守卫整体替换 save（同 `putSave` 约定，避免与客户端 PUT /save 互覆盖）；`Room` 加 `beginRanked()`、`reportResult(+winnerSide)`、`endMatch` 改 async 按 mode 结算——**ranked 胜负 = 双方上报 hash+winner 一致才认（无服务器裁判 S1-J）**，不一致作废不动 ELO；掉线/认输服务器权威判对手胜 + 结算；`match_over.elo{delta,after,rankAfter}` 按 side 下发。`transport.proto` `MatchResult` 加 `winner_side`。**验收**：`tsc -b shared metaserver gameserver` 全绿 + 67 测试（+4 ladder / +5 matchmaking / +4 ranked 端到端：匹配→开局→一致结果±16 写 saves、hash 不一致作废、认输判胜+ELO、无 Mongo 拒）。✅ **客户端切片已落地**：`npm run proto:gen` 重生 `net/proto/transport.ts`（`MatchResult.winnerSide`）；`NetClient.reportResult(stateHash, winnerSide)` + `NetSession.createRanked()`（入队）/`cancelQueue()`（`room_leave` 退队）；`RoomScene` idle 加「排位赛」入口 + `searching` 视图（spinner + 取消）；`app.goGameNet` 局末上报真实 winner，**ranked 等服务器 `match_over.elo` 再进结算**（6s 兜底），`ResultScene` 显 ELO 变化 + 段位（i18n `room.ranked`/`searching`/`cancelSearch`、`result.eloDelta`、`rank.*` 9 段 zh/en/de 全翻）。tsc + 116 测试 + web 构建全绿。✅ **收尾两项已落地**：①大厅段位徽章——`LobbyScene` 头部右上常驻显「段位 · ELO」（`pvp` 经 callbacks 传入，每次 `goLobby` 取最新；`rank.unranked` 等 i18n 全翻）；②ranked 局末 `SaveManager.refresh()`（pull + reconcile，复用 token 不重 auth）刷新本地权威 `pvp`，`app.finishNet` 在 ranked 结束时触发，无需等下次 bootstrap。client tsc + 120 测试（+4 `save-manager`）+ web 构建全绿。✅ **段位/战绩页已落地（2026-06-15 复核）**：无需独立 ProfileScene——`StatsScene`（段位/ELO/胜负/胜率/连胜 + 对战历史，stats nav）+ `SettingsScene`（头像/名字/段位/改名，大厅左上 chip）+ `ProfilePopup`（他人资料）已完整覆盖。✅ **分段差异化胜利金币已落地（2026-06-15，ECONOMY §2.3b）**：`shared/economy` `VICTORY_COINS_BY_RANK`（青铜-黄金5/铂金-钻石8/星耀-大师12/宗师-王者18）+ `VICTORY_DAILY_WIN_CAP=10`；commercial `victoryDaily` 集合 + `victoryCredit`（原子 enforce 每日上限）；meta `settleElo` 胜者按结算后段位发币（best-effort，base/disconnect/judge 三路径覆盖）。commercial 11 + meta 52 测试。**待办**：双真机联调（用户自行）。
- [~] **S1-J 对等裁判反作弊**（2026-06-14 实现落地）：ranked 双方 hash 不一致时，gateway 挑一个**在线 `canJudge` 非参赛玩家**把 replay 发过去**无头复算**，按其结果裁决（不在 gameserver 自己复算）。**已拍板**：①单裁判（与裁判 hash 一致方可信）；②作弊方判负 + `matches.cheat` 标记，正常结算 ELO。**已落地**：
  - **proto** `transport.proto`：`ClientCaps`(10)/`JudgeVerdict`(11)→ClientMsg、`JudgeRequest`(10)→ServerMsg；客户端 `proto:gen` 重生。
  - **gateway** [Gateway.ts](../../server/gateway/src/Gateway.ts)：`GwConn.canJudge`（client_caps 上报）、`judge(args)` 挑候选 push `judge_request` 挂 `pendingJudges`（20s 超时 / 候选掉线即作废）、解析 `judge_verdict`（仅认被指派者）；[internalHttp.ts](../../server/gateway/src/internalHttp.ts) `/gw/judge`（frames base64 解 bytes）；[proto.ts](../../server/gateway/src/proto.ts) 加解/编码。
  - **meta** [gatewayClient.ts](../../server/metaserver/src/gatewayClient.ts)（HttpGatewayClient）+ [internal.ts](../../server/metaserver/src/internal.ts) `judgeMismatch()`：`mode==='ranked' && reason==='mismatch' && gateway.available` → 裁判 hash 命中哪方哪方诚实、另一方判负 + `settleElo` + 写 `MatchDoc.cheat{side,accountId,judgeAccountId}`；裁判不可用/超时/对不上任一方 → 退回作废。`NW_GATEWAY_INTERNAL_URL`（compose/ecosystem 接 `http://gateway:8090`，无 depends_on 避环）。
  - **客户端** [judgeRunner.ts](../../client/src/net/judgeRunner.ts)（`runJudge`：proto 帧→Replay→netplay 引擎跑到 GameOver→FNV-1a hash；`matchStateHash` 收此处单一来源，[app.ts](../../client/src/app.ts) 改 import）；[NetClient.ts](../../client/src/net/NetClient.ts) `sendClientCaps`/`sendJudgeVerdict`；[NetSession.ts](../../client/src/net/NetSession.ts) 连上报 caps（`hardwareConcurrency≥4`）+ 路由 `judge_request` 跑 runner 回 verdict。
  - **验收**：tsc 六包 + 客户端 tsc/web 构建 + gateway 5(+3 真 WS：挑候选/解 verdict、无候选、自裁排除) / meta 40(+3：命中定罪、不可用作废、对不上作废) / 客户端 131(+3 judge-runner：复算 hash 与独立权威引擎逐字相同、确定性、坏帧流 ok:false) 全绿。
  - **简化偏离**：gameserver **未改**——mismatch 的 `match_over` 仍报 reason='mismatch' winnerSide=0，但 meta 回的 `eloBySide` 已反映裁决（诚实方 +、作弊方 −，玩家分数正确；`matches.winner` 记诚实方）；让 match_over 显示胜方跟裁决（report 回传 resolved winner 给 gameserver）+ 双真机联调（4 进程 + 3 标签页）**待办**。**依赖**：S1-3、C-1。**验收（端到端）**：篡改输入被裁判检出判负 — 待双真机跑。
- [~] **S1-RP 录像录制 + 回放**：定义 `replay.proto`（复用 `FrameCmds`）；录制（PvE 客户端记玩家指令 / PvP gameserver 持久化输入日志到 `matches.replayRef`）；实现 `ReplayInputSource` + 回放播放器（同 seed 起新引擎喂输入流），回放前校验 `engineVersion`。**依赖**：C-4、S1-5。**验收**：一局 PvE + 一局 PvP 录像回放与原局逐 tick 一致；改 engineVersion 回放被拒。**注**：PvE 录制可随战役（CAMPAIGN P1）先落地，不必等联机。✅ **客户端录制/回放已落地**：`client/src/game/net/ReplayInputSource.ts` 新增 `RecordingInputSource`（透明包装任一 `InputSource`，捕获引擎每 tick 确认的指令集，稀疏只存非空帧、单调、深拷贝防污染；`snapshot()` 产出 `Replay`）+ `ReplayInputSource`（喂录像 `Replay`，`take` 永不停步、`submit` 忽略、构造校验 `engineVersion` 不符抛 `ReplayVersionError`）；`Replay` 类型扩展为镜像 `replay.proto` 字段（`engineVersion`/`mode`/`seed`/`configRef`/`frames`/`endFrame`/`meta`，命令保留为 TS 对象、JSON 可序列化）+ `ENGINE_VERSION=1`。barrel 导出全部。**验收测试**（`test/replay-input-source.test.ts`，10 例）：PvP-vs-AI + campaign(PvE) 录制→回放终局指纹全等（PvE 录像只含 owner 0 玩家指令、敌方波次由 seed+level 重算）、JSON round-trip 不破、engineVersion 不符被拒、take/submit/sparse 语义。tsc 干净 + 110 测试全绿 + web 构建通过。✅ **接录制 + 回放 UI + 服务端持久化已落地（A+B）**：(A) `GameScene` 自建局（campaign / PvP-vs-AI）用 `RecordingInputSource` 包 `LocalInputSource`，局末 `onGameEnd(winner, stats, replay?)` 透出录像；`app.ts` 建 `ReplayStore`（`game/meta/ReplayStore.ts`，key `nw_replays_v1`，最近 12 局 ring，损坏退化、JSON round-trip）落盘并把录像传 `ResultScene`；`ResultScene` 有录像时显「观看回放」按钮 → `app.goReplay` → 新增 `ReplayScene`（`scenes/ReplayScene.ts`：`ReplayInputSource` 驱动 + `GameRenderer` spectator 模式[新增构造参数，跳过 input 接线、纯观看] + 自绘 transport 覆盖层：播放/暂停、1×/2×/4× 变速、进度条、退出、结束/版本错误提示）。i18n `replay.*` + `result.watchReplay` zh/en/de 全翻。(B) `server/contracts/replay.proto`（复用 transport `FrameCmds`，`Replay{engineVersion/mode/seed/configRef/frames/endFrame/meta}`）；gameserver 局末把已保留的非空帧日志零成本内嵌进 `matches.replay`（`Room.buildReplay`→`MatchArchive.replay`→`RoomManager.archive` 写 BSON，`cmds[].commands` 为 opaque binary 不解码；服务器逻辑无关 M12 → `engineVersion=0`，客户端回放自校验）；`shared/mongo.ts` `MatchDoc.replay?: MatchReplayDoc`。**验收**：client tsc + 116 测试全绿（+6 `test/replay-store.test.ts`）+ web 构建；server `tsc -b shared metaserver gameserver` 全绿。✅ **服务端录像取回 + opaque→Replay 解码 + 大局 replayRef 已落地（2026-06-15）**：`openapi.yml` 加 `MatchReplay` schema + `GET /match/{roomId}/replay`（仅本人参与，越权 404）；meta `getMatchReplay`（内嵌 `replay` 优先，回退 `replayBlobs`）；`internal.ts` 归档按帧字节阈值（256KB）拆分——小局内嵌、大局落 `shared` 新 `replayBlobs` 集合 + `MatchDoc.replayRef`；客户端 `ApiClient.getMatchReplay` + `net/serverReplay.serverReplayToReplay`（base64→`PlayerCommands.decode`→引擎 `PlayerCommand`，与 `judgeRunner` 同套解码）；`StatsScene` 对战历史行可点 ▶ 看回放（fetch→解码→`goReplay`）。meta `match-replay.e2e`（内嵌/replayRef/非参与者 404/缺失 404）4 例 + 全链路 e2e 延伸（getMatchHistory→getMatchReplay→解码→回放到 endFrame）。**待办**：大局录像转**外部对象存储**（S3/GCS，当前是 Mongo `replayBlobs`，infra 决策）+ 录像**分享**（分享码/链接，产品功能）。

### 架构修订迁移（2026-06-13，`META_DESIGN.md §1.1/§6.1`、`SERVER_API.md §8`）

> 把 S1 的 gameserver 中心式（自管匹配/分配/结算 + 连 Mongo）迁为「**5 组件 + 控制面/数据面分离**」（M16–M20）：meta(REST 请求面) + gateway(WS 控制面) + game(WS 数据面) + matchsvc(私有大脑)。目标：**gameserver 永不连库、meta 纯无状态 REST、控制面推送顺畅**。这些任务在现有 S1 实现之上做搬迁，非推倒重来。

- [x] **S1-M1 matchsvc + gateway（合一进程）**（2026-06-14）：`server/gateway` 新增第四包（`Gateway` 控制面 WS + `matchsvc/{Matchsvc,Matchmaking,GameRegistry}` 进程内模块 + `metaClient` 取 ELO + `internalHttp` game 注册/心跳）。从 gameserver 搬 `Matchmaking`；房间分配 + 签 ticket（`shared/ticket.ts`）。**验收达成**：tsc 干净 + gateway 17 测试（matchmaking/matchsvc/ladder）；不连 Mongo；玩家经 `/gw` 跑通建房→加入→ready→start→收 match_found+ticket，触达不到 matchsvc。
- [x] **S1-M2 gameserver 瘦身（去库）**（2026-06-14）：删 `Matchmaking`/`settleRanked`/`archive`/Mongo 依赖；握手改 `?ticket=` 验签 + roomId/seed/mode 交叉核对；`Room` 双方凑齐自动开局，保留节拍器/帧日志/重连。**验收达成**：bundle 无 Mongo client；gameserver 42 测试（room/roomManager/transport）。
- [x] **S1-M3 game→meta 局末上报 + gateway→meta 取 ELO**（2026-06-14）：`metaReport.ts` POST `/internal/match/report`（幂等 room_id + 排队重试）；meta `internal.ts` 结算 ELO（乐观锁）+ 归档 matches（唯一 roomId）+ `GET /internal/elo`。ranked 回每方 elo→`match_over.elo`。**验收达成**：ELO/归档全在 meta；matchsvc 不连 Mongo；meta internal 5 测试。
- [x] **S1-M4 客户端三通道适配**（2026-06-14）：`NetSession` 拆 gateway(控制)+game(数据，懒建于 match_found) 双连接；`NetClient` 加 `queryParam`；`transport.proto` 加 `MatchFound`（重生）；`net/config` 加 `getGatewayWsUrl`。`RoomScene`/`app` 经 session 间接驱动无需大改。**验收达成**：玩家只连 meta+gateway+game；client 128 测试 + web 构建绿。**待办**：双真机联调（双标签页跑通 friendly/ranked 整局 + conn_resync）。

### 客户端
- [x] **S1-6 NetClient**：封装 ws 连接、重连、消息编解码（用 C-2 协议）。**依赖**：C-2。**验收**：掉线自动重连。✅ `client/src/net/NetClient.ts`：退避重连 + 代次作废滞后回调 + 首/重连 open 区分（仅重连触发 `onReconnect`，上层据此发 conn_resume）+ 应用层心跳 + 未 open 丢弃发送；平台 socket 抽象 `IPlatform.connectSocket`（Web/CrazyGames=`BrowserGameSocket`，微信=`WechatGameSocket`）；C-2 ts-proto 编解码。6 单测（假 socket）+ 端到端真 NetClient↔真 gameserver 整局 friendly 跑通。**注**：C-2 客户端 proto codegen 同期落地（ts-proto via buf，`client/buf.gen.yaml`+`scripts/gen-proto.mjs`+`npm run proto:gen`，产物 `src/net/proto/`，线兼容回归 `test/proto-wire-compat.test.ts`）。
- [x] **S1-7 节拍驱动（NetInputSource）**：实现 `NetInputSource`（C-4 的联机实例）——消费 gameserver 的 `frame_batch`、按 `to_frame` 推进引擎并把 3 帧摊到 100ms 播放，保持 ~1 批次缓冲，缓存空则暂停、超时追帧；出牌即发 `cmd_submit`（不预算帧号）。单机/PvE 走 `LocalInputSource` 不变。**依赖**：S1-6、S1-3、C-4。**验收**：缓冲吸收 <100ms 抖动无感；服务器停发即暂停；无回滚。✅ `client/src/game/net/NetInputSource.ts`：`submit`→`game.proto` `PlayerCommands` opaque bytes `cmd_submit`（不预算帧号，owner/tick 占位由服务器派 side+帧）；`handleServerMsg` 消费 `match_start`/`frame_batch`/`conn_resync`，`FrameCmds` 解码回 `PlayerCommand[]`（owner=`SideCmd.side`、tick=`FrameCmds.frame`，保服务器排序）；`take(frame)` 释放已确认帧、未确认 `null` 停步（锁步、无预测/回滚）；播放头落最新水位后 `bufferFrames`(默认 1 批=3) 吸收 <100ms 抖动；水位单调（陈旧批次不回退）；`conn_resync` 跳水位快进追帧。新增 `GameMode 'netplay'`（双方真人、不跑本地 AI/波次，`step` 只处理确认指令集）；`game.proto` `PlayCard` 加 `row`（陨石目标行）+ `npm run proto:gen`。验证：tsc 干净 + 19 新测试（take/缓冲/水位/解码/no-rollback/resync + 双客户端同 seed 同流逐 horizon fingerprint 全等 + 停发暂停/重连追帧/抖动吸收）+ web 构建通过（共 106 绿）。**注**：双引擎单进程因模块级 id 计数器交错，测试改为录制合流帧流后顺序回放对拍。
- [x] **S1-8 RoomScene**：建房/房间码展示/输码加入/ready/倒计时开打（UI 见 `UI_DESIGN.md`）。**依赖**：S1-6、S1-2。**验收**：完整建房→加入→开局流程。✅ `client/src/scenes/RoomScene.ts`（canvas 绘制，视图机 `idle → codeEntry → connecting → inRoom`；i18n `room.*`，zh/en/de 全翻）+ `client/src/net/NetSession.ts`（绑 `NetClient`+`NetInputSource`：路由 ServerMsg → input & UI、重连 `onReconnect`→`conn_resume{roomId, resumeFrame()}`、room 动作转发、`onMatchStart` 建引擎）。`app.ts`：大厅底栏「社交」格 → `goRoom()`；`match_start` → `createGameEngine({seed, mode:'netplay'}, session.input)` → `GameScene`（新增 `engine?` 选项接预建引擎）；局末 `reportResult(FNV-1a(winner+stats))`（S1-5 握手）。无服务端配置时房间 UI 仍可开（`available:false`，create/join 弹「联机服务不可用」）。`LobbyScene` 加 `onOpenRoom`+社交格命中。验证：tsc 干净 + 100 测试全绿 + web 构建通过 + 浏览器实测 idle/codeEntry 两视图（社交入口 → 创建/加入按钮 → 输码键盘逐字填充）。**注**：①`inRoom`（双槽/ready/start/房间码）需活 gameserver 推 `room_state` 才显示，留 S1-9 双机联调验收；②`GameRenderer` 仍以 owner-0（下方）视角渲染，joiner（localSide 1）暂不翻转棋盘，正确换边视角属 S1-9。

### 联调出口
- [ ] **S1-9 双真机对局**：两台设备好友房一整局逐 tick 一致；中途断一台能重连续打。**依赖**：S1-3,4,7,8。
- [~] **S1-E2E 全链路 headless 客户端测试**（2026-06-15）：把散落各处的「双真机手动验收」自动化掉一大半。用**真实客户端编排核心**（`client/src/app/createAppCore.ts`，从 `startApp` 抽出的 PIXI-free 层，经 `AppViews` 依赖倒置接缝；`PixiAppViews`=真游戏、`HeadlessAppViews`=测试）在 Node 里 headless 跑全链路，无渲染。`test/harness/HeadlessPlatform` 的 `connectSocket` 记录每个打开的 WS URL 作断言接缝。`client/test/e2e/full-link.e2e.ts`（`npm run test:e2e`，连真栈 meta+gateway+matchsvc+game+commercial+mongo）覆盖：注册→充值/商店购买/盲盒抽卡（服务器权威回推）→双客户端排位匹配。**断言**：gateway 用服务器下发的 `:8086/gw`（非 meta `:18080` / 非错误 fallback）、`match_found` 下发 game_url、数据面带 `?ticket=`、锁步帧推进。**实跑验证通过**（2 用例全绿）。**单进程跑两 netplay 引擎因模块级 unit/building id 计数器交错无法对拍确定性胜负**，故 e2e 只断言端口/握手/帧推进、不断言一致 winner；**完整对局到结算 + 逐 tick 一致 + conn_resync 续打仍需各自进程**（留 S1-9 / 各自进程 CI）。

  **✅ S1-E2E-CI GitHub Actions（2026-06-15）**：`.github/workflows/ci.yml` 两 job——**build-test**（无 Docker，快路：server 六包 `tsc -b` + client 单测 + web 构建）+ **e2e**（慢路：`docker compose -f docker-compose.prod.yml -f docker-compose.ci.yml up -d --build --wait` 起 mongo+meta+commercial+gateway+matchsvc+game 全栈，runner 宿主机以 Node 跑 `npm run test:e2e`，失败倒 compose 日志，`always` `down -v`）。①**轻量 `/health` 探针**：gateway/matchsvc/commercial 在各自 `internalHttp` 的 X-Internal-Key 鉴权门**之前**加 `GET /health`（无需密钥，docker healthcheck/CI 等待用）；gameserver 原是纯 WS server，重构为显式 `http.createServer`（serve `/health` + 承载 `/ws` 升级、非升级 426），`http.listen(port)` 取代 `wss` 直接 listen。②**`docker-compose.ci.yml` 叠加层**：不起 caddy；把 meta/gateway 公开 WS/game 数据面映射到宿主端口且端口号与 e2e 默认期望一致（meta 18080 / gateway 8086 / game 8081）；meta `NW_GATEWAY_PUBLIC_WS_URL=ws://localhost:8086/gw` + matchsvc/game `NW_GAME_PUBLIC_WS_URL=ws://localhost:8081/ws`（服务器下发地址 runner 可达）；五服务加 node 版 healthcheck（镜像内有 node 无 curl）配合 `--wait`。**本机实跑验证通过**：`up --wait` 六服务全 healthy + `test:e2e` 2 用例全绿（连真 prod 镜像）。**Phase 4 完成**。

  **✅ S1-E2E-RP 录像全链路（2026-06-15）**：matchmaking 用例延伸覆盖「真实对战 → 录像 → 回放」。两 headless 客户端排位匹配后 `driveFor` 跑真实锁步帧（经 live WS），随后双方各调 GameScene 的 `onGameEnd`（=引擎到达 game-over 的真实回调）上报结果 → 服务器（ranked）双方齐报即结算并下发 `match_over` → app 把包裹 live 确认帧流的 `RecordingInputSource` 快照成 `Replay`、`keepReplay` 落 `ReplayStore` → 结算页。**断言**：结算页 `onWatchReplay` 存在（录像产出）+ `nw_replays_v1` 已落盘（持久化）+ 点「观看回放」进 replay 屏 → `HeadlessAppViews.showReplay` 镜像真 ReplayScene 用 `ReplayInputSource`+`createGameEngine` 重建引擎（无 PIXI）→ 新增 `driveReplayToEnd()` 把录制的 netplay 帧回放到 `endFrame`（record→snapshot→store→playback 闭环 round-trip）。harness 加 `replayEndFrame`/`driveReplayToEnd`。实跑 2 用例全绿 + 159 单测不破。

  **✅ S1-E2E-补全 登录/好友房/存档/改名/负向（2026-06-15）**：从 2 用例扩到 **5 用例**，补齐 headless 能驱动真实服务栈的主路径。①**账号生命周期**（登录 + 续登 + 云存档 round-trip + 改名）：注册 A → 充值 → 改名（扣 500）→ 新客户端 `onLogin` 同账号 → **displayName + 金币从云端恢复**（证 login + push→cloud→pull + rename 持久化）→ 同设备「重启」（新 core 喂 A 的 storage 快照）经持久化 token `bootstrap` 自动续登进在线大厅、名字恢复。②**好友房**（房间码）：A `createRoom`→拿 `room_state.code`→B `joinRoom(code)`→双方 `setReady(true)`→matchsvc 双就绪自动开局→双 gameNet（数据面带 `?ticket=`、锁步帧推进）。③**负向**：重复 loginId 注册被拒（停在 login）、0 金币账号买不起最便宜商品（INSUFFICIENT_FUNDS）。harness 加 `HeadlessPlatform.snapshotStorage()`（模拟同设备重启）+ `HeadlessAppViews` 捕获 `lastRoomState`（房间码）/`lastRoomNetState`（等 gateway open 再发命令）。实跑 5 用例全绿 + 159 单测不破。**仍不放 headless 的**：重连/`conn_resync`、`peer_dc` 宽限、中途掉线判负（需 socket 级时序操控，留服务端单测）；确定性 winner（单进程双引擎既有限制）。

---

## S2 — 经济：钱包 / 商店 / 盲盒 / 广告

### 服务器（钱包权威，全程事务）
- [ ] **S2-1 钱包模型**：`wallet.coins` 存 Mongo（`saves` 内或独立 `wallets` 集合）；所有变更走原子事务 + 流水记账。**依赖**：S0-6。**验收**：并发扣币不超支。
- [ ] **S2-2 商店直购**：`POST /shop/buy`（校验余额→扣币→发库存→回推 SaveData）。商品定义表 `shopItems`。**依赖**：S2-1。**验收**：余额不足拒绝；成功原子发货。
- [ ] **S2-3 盲盒服务**：`POST /gacha/draw`（`crypto` 真随机按 weight + 保底；扣币→发货/转化→更新 pity→**写 `gachaHistory`**→回推）。`GachaPool` 配置表。**依赖**：S2-1。**验收**：单抽/十连原子；每抽落库；保底命中可复现于日志。
- [ ] **S2-4 广告奖励校验**：`POST /ads/reward`（校验平台广告回调/凭证→记每日 `{dayKey,watchedToday}`→到 cap 拒→加币）。**依赖**：S2-1。**验收**：超日上限不发；伪造回调被拒。

### 客户端
- [x] **S2-5 EconomyClient**：封装 shop/gacha/ads/iap 调用；UI 余额只读自 SaveData（服务器回推）。**依赖**：S0-5、C-2。✅ 经济方法并入 `client/src/net/ApiClient.ts`（`getShopItems`/`shopBuy`/`getGachaPools`/`gachaDraw`/`adsReward`/`iapVerify` + `ShopItem`/`GachaPool`/`GachaResultEntry` DTO，回推权威 SaveData）；`SaveManager.adoptServer(save)` 吃回执（权威段服务器为准，复用 reconcile）。花币动作后余额以服务器回推刷新。
- [x] **S2-6 ShopScene + GachaScene**：商品格/购买确认/盲盒开箱/保底进度。**依赖**：S2-5。✅ `client/src/scenes/{ShopScene,GachaScene}.ts`（canvas render+hit-list）：商店已拥有标记/余额校验/购买 toast + 底部盲盒/充值入口；盲盒单抽/十连/保底进度条/稀有度图例 + 结果揭示层（稀有度卡 + NEW/重复徽章）。大厅底栏「商店」格接入（离线路由登录）。**虚拟充值**：`taowang`(/`-s`/`-l`) → `iapVerify('dev-<ts>','tier:xxx')` 命中 dev 桩，零服务端改动，上线换平台 SDK。i18n `shop.*`/`gacha.*`/`rarity.*` 全翻。tsc + web 构建 + 128 测试绿。**注**：占位皮肤暂用 itemId 展示，真实皮肤名/图待美术。
- [ ] **S2-7 防刷验收**：本地改 `wallet.coins` 后任何花币动作被服务器拒（以服务器值为准）。**依赖**：S2-1~5。**注**：客户端 `wallet.coins` 本就只读镜像、花币全走服务器扣币（commercial $gte 守卫），机制就位；待双进程实跑端到端验收。

> ⚠️ **S2 与 S5 的关系**：原 S2 把钱包/商店/盲盒放在 meta 内。2026-06-14 决策把这些迁到独立 **commercial 服务**（见 S5 + `COMMERCIAL_DESIGN.md`）。落地顺序上 **S5 取代 S2-1~4 的服务端钱包实现**（meta 改为编排者调 commercial），S2-5~7 客户端/防刷验收仍有效（客户端只认 meta，不感知 commercial）。若先做 S5 则 S2 服务端任务并入 S5。

---

## S5 — commercial 商业服务（钱包 / 充值 / 消费 / 盲盒，独立库）

> 细分设计见 `COMMERCIAL_DESIGN.md`。决策（M21）：钱包权威从 meta `saves.wallet` 迁到 **commercial 独立库** `notebook_wars_commercial`；commercial 玩家不可达，**meta 唯一调用方**（编排者）；抽卡「扣币+随机+记账」同库原子，物品由 meta 据结果发货；跨服务用 orderId 幂等 + 待发货对账（saga）。

> ✅ **S5-1~6 已实现并测试通过（2026-06-14）**。`server/commercial` 独立进程 + 专属库；meta 编排经济端点；钱包权威迁出 meta saves（降级只读镜像）。验证：`tsc -b` 六包全绿 + commercial 20 测试（gacha RNG 纯函数 5 + service e2e 9：默认钱包/加扣币守卫/orderId·receiptId 幂等/**并发不超支**/发货退币闭环 + internalHttp e2e 6：**无内部密钥被拒 401**/路由/404）+ meta 37 测试（+7 economy e2e：扣币→发物品→镜像/广告 cap 429/**对账补发不丢不重**/commercial 未配 503 +5 HttpCommercialClient fetch 解析 +catalog 端点）+ client tsc + 128 测试 + web 构建。实现细节见 `COMMERCIAL_DESIGN.md` 与 `CLAUDE.md` 服务端节。**注**：重复转化（退币/碎片）S5 暂缓（§4.3 退币额待定 + materials 客户端同步段权威冲突 + 补发重算非幂等），先只幂等发新皮肤，退币通道在 commercial `orderDelivered(refundCoins)` 已备。

### 服务器
- [x] **S5-1 commercial 包 + 独立库** ✅：`server/commercial`（CJS，node:http 内部端点）；`createCommercialMongo`（库 `notebook_wars_commercial`，集合 `wallets`/`ledger`/`orders`/`recharges`/`gachaHistory` + 索引）；`NW_COMM_PORT`(默认 18082)/`NW_COMM_MONGO_*`/`NW_INTERNAL_KEY`（`/internal/*` 鉴权，不暴露公网）。
- [x] **S5-2 钱包 + 流水** ✅：`GET /internal/wallet`（余额+pity）；`wallets` 单文档原子扣/加币（`coins>=cost` 守卫）+ 每笔写 `ledger`。并发 10 单抽余额仅够 4 抽 → 恰 4 成功（e2e 验）。
- [x] **S5-3 盲盒 RNG + 商店扣币** ✅：`POST /internal/gacha/draw`（crypto 真随机按 weight + 大保底 90/十连 epic 保底，扣币+RNG+pity+gachaHistory/orders 同操作，`orderId` 幂等）；`POST /internal/shop/charge`（扣币+orders+目录价交叉核对）；`POST /internal/order/delivered`（闭环 + 可选 refundCoins）。保底命中注入随机源可复现。
- [x] **S5-4 充值 + 广告加币** ✅：`POST /internal/recharge/verify`（dev 桩验票据→加币→recharges receiptId 幂等；真实渠道验签留 TODO）；`POST /internal/ads/credit`（加币记账）。空 receipt → INVALID_RECEIPT。
- [x] **S5-5 meta 编排 + 钱包镜像 + 对账** ✅：`/shop/buy`/`/gacha/draw`/`/ads/reward`/`/iap/verify` 改为「校验 JWT → 调 commercial → 发 inventory（`deliveredOrders` $addToSet 幂等）→ 标 delivered → 写 `SaveData.wallet/gacha` 镜像 → 回推」；`GET /save` 顺带对账（拉 commercial 未发货订单补发）+ 拉余额/pity 填镜像；广告 cap 用 meta `adsDaily` 集合按 `dayKey` 原子计数。`shared/mongo.ts` 从 meta 库移除 gachaHistory/walletLog/iapReceipts。**兜底定时扫待办**（当前仅 GET /save 顺带对账）。

### 客户端
- [x] **S5-6 客户端零感知验收** ✅：客户端 `SaveData` 加只读 `deliveredOrders`，`wallet.coins`/`gacha.pity` 注释改为「commercial 权威只读镜像」；继续只读 `save.wallet.coins`、只调 meta 端点，钱包读取逻辑零改动。**进 ShopScene 前 `GET /save` 刷新待 S2 ShopScene 落地时接**（场景尚未实现）。

---

## S3 — PvE 养成 + 收集 + 选关

- [x] **S3-1 材料 + 关卡掉落** ✅（2026-06-15）：`LevelRewards.materials`（material→amount，客户端同步段）+ `levelSchema.parseRewards` 校验 + ch1_lv1~3 JSON 加材料；`game/meta/campaignRewards.ts`（`computeStars`/`remainingHpPct`/`applyCampaignClear` 纯函数）；`app.goCampaign` onGameEnd 胜利时算星（基地剩余 HP% 对 `starThresholds`）→ `saveManager.update` 写 `progress.cleared/stars` + 首次通关发材料（避免刷）。+7 测试（`test/campaign-rewards.test.ts`）。**注**：coins/皮肤解锁属服务器权威段，需端点，未在此发（留 S2）。
- [x] **S3-2 PveUpgradeDef 表 + applyPveUpgrades** ✅（2026-06-15）：`game/balance/pveUpgrades.ts`——`PVE_UPGRADE_DEFS`（3 玩家单位 × HP/Damage 各一条，maxLevel 5，乘算 `1+effectPerLevel×lvl`，DRAFT 数值）+ `MATERIALS`(scrap/lead/binding) + `upgradeCost(def,lvl)`（线性 `baseCost×(lvl+1)`，满级 null）+ `applyPveUpgrades`（钳制未知 id/0 级/超 max）。`app.tryUpgrade` 扣材料 + 升级，走 `SaveManager.update`（客户端同步段，防抖上行）。
- [x] **S3-3 引擎双路 + 硬墙单测** ✅（2026-06-15）：`buildPvpBlueprints()`（无 SaveData 参数）/ `buildCampaignBlueprints(pveUpgrades)`；蓝图从全局常量改为 `GameState.unitBlueprints`（引擎构造按 mode 选），`Unit` 构造加可选 `blueprint` 参（默认常量，旧测试不动）、3 处出兵点 + `BuildingProductionSystem` 传 `state.unitBlueprints[type]`；`GameConfig.pveUpgrades` 仅 campaign 路径读。**硬墙单测** `test/hardwall.test.ts`（9 例）：满级升级下 `buildPvpBlueprints()` 与 `UNIT_BLUEPRINTS` 逐字相等、campaign 引擎建后 PvP 引擎仍纯、克隆不污染常量、钳制/费用。157 测试全绿，黄金回放不破。
- [x] **S3-4 皮肤渲染（机制就位）** ✅（2026-06-15）：`UnitView` 加 `equippedSkin` 参 + `SKIN_ASSETS` 注册表 + `resolveAssets`（皮肤覆盖 ∪ 默认，未映射回退默认）；`GameRenderer`/`GameScene.options.equippedSkin` 透传，`app` 在 campaign / PvP-vs-AI 传 `equipped[COLLECTION_EQUIP_SLOT]`。只换贴图、不碰数值（§5.2）。**注**：`SKIN_ASSETS` 暂空（无皮肤 .tao 资源），当前视觉为 no-op，资源到位后填表即生效。
- [x] **S3-5 CampaignMapScene + LevelPrepScene + CollectionScene** ✅（2026-06-15）：三个 canvas 场景（ShopScene 同款 render+hit-list + sketchUi 手绘）。**CampaignMapScene**：关卡列表 + 星级（★/☆）+ 顺序解锁（前一关通关才解锁）+ 收集入口。**LevelPrepScene**：材料条 + 升级树（每条显示 Lv/费用，点击花材料强化，toast）+ 开打。**CollectionScene**：皮肤衣柜（默认 + 已拥有，点击装备写 `equipped`）。`app` 加 `goCampaignMap`/`goLevelPrep`/`goCollection`/`tryUpgrade`，大厅「战役」入口改路由到 map（`onStartCampaign`→`goCampaignMap`，零 LobbyScene 渲染改动）。i18n `campaign.*`/`prep.*`/`material.*`/`collection.*` zh/en/de 全翻。tsc + 157 测试 + web 构建绿。

---

## S4 — IAP 验单 + 反作弊 + 加固

- [ ] **S4-1 iap-service**：各平台充值服务端验单（微信虚拟支付 / Web 渠道）→ 加币。**依赖**：S2-1。**验收**：未验单不发币；重复票据幂等。
- [ ] **S4-2 对局 hash 比对**：对局结束双端上报最终状态 hash，服务器比对，分歧标记。**依赖**：S1-3。**验收**：人为分歧被检出。
- [ ] **S4-3 上线加固**：限流、输入校验、日志/告警、Mongo 备份脚本。**依赖**：全部。
- [~] **S4-4 PvE 数据完整性（升级权威迁服务器，方案 B）**：拍板（2026-06-15）——`progress`/`stars`/`materials`/`pveUpgrades` 全服务器权威；通关=一次服务器事务；可重复刷（每日上限）；离线只重刷已解锁关攒材料、新解锁/升级须联网。详见 **`PVE_INTEGRITY_PLAN.md` §8**。✅ **Step 1 服务器基础已落地**：`shared/pveRewards`（发放/花费权威，M12 安全）+ `pveDaily` cap 集合 + meta `POST /pve/clear`（校验解锁→每日上限内发材料→写 progress/stars/materials→回推）+ `POST /pve/upgrade`（校验材料→扣费→pveUpgrades+1→回推）+ `mutateSave` 乐观锁；附加非破坏（客户端暂不调用）。meta pve.e2e 5 例 + 57 测试绿。✅ **Step 2 客户端切换已落地**（2026-06-15）：`SyncPatch` 收窄为 equipped/flags（client `extractSyncPatch` + server `applySyncPatch` 硬墙）；`createAppCore` 通关/升级改走 API（在线）/ 离线 `pendingClears` 队列；`SaveManager` flush + reconcile 改 progress/materials/pveUpgrades 服务器为准；CampaignMap/LevelPrep 在线门控。165 测试绿。✅ **Step 3 L1 录像抽检复算已落地**（2026-06-15，复用 S1-J 第三方客户端无头复算）：meta `pveClear` 按 `shouldSpotCheck`（首通/蓝图异常/随机抽检 0.1）暂扣材料 + 回 `needsReplay/verifyId`；`POST /pve/verify` 客户端补传录像帧 → `gateway.judge({levelId,pveUpgrades,frames})` 派第三方 → `judgeRunner.runPveJudge` 战役复算星数；复算 ≥ 声称发材料 / < 声称判可疑 / 无裁判 benefit-of-doubt。`transport.proto` `JudgeRequest.level_id`/`pve_upgrades` + `JudgeVerdict.stars`；`pveVerifications` 集合。client 168 + meta 68（+11）+ gateway 10（+1）测试绿。**待办**：rejected 命中后处置策略（标记/封号）；抽检率实测调参。**依赖**：S1-RP、S1-J。

---

## S6 — 社交系统（好友 / 私聊 / 邮件；帮会/国家频道留 SLG 后）

> 拍板 2026-06-16：持久数据扩展 meta（不新建进程）；一期做好友+私聊+邮件全套。详见 **`SOCIAL_DESIGN.md`**。
> 架构复用：meta=数据权威，gateway=在线态+实时投递（复用 `account→socket` + `/gw/push`，meta 成第二个 push 调用方）；发送走 REST、接收走 push；邮件附件领奖复用 commercial 发货幂等。gateway 横扩（单实例 ~3000）+ Redis 路由是近期里程碑（SOC9）。

- [x] **S6-0 契约 + shared** ✅（2026-06-16）：`shared/social.ts`（`FRIEND_CAP=100`/`CHAT_RETENTION_SEC`/`MAIL_DEFAULT_TTL_SEC` 等常量 + `conversationId`/`friendEdgeId`/`blockId` 确定性 id + 视图类型 `FriendView`/`ConversationView`/`MailView`…）；`mongo.ts` 加 6 集合（friendEdges/friendRequests/blocks/conversations/chatMessages/mail）+ 索引 + 两条 **TTL**（chatMessages.ts / mail.expireAt，**字段须 BSON Date** Mongo 才过期，已在 Doc 类型标注）；`api.ts` 加 6 错误码（FRIEND_CAP_REACHED/ALREADY_FRIEND/NOT_FRIEND/BLOCKED/ALREADY_CLAIMED/NO_ATTACHMENT + HTTP 映射）；`transport.proto` 加 5 个 social ServerMsg（friend_presence/friend_request/friend_update/chat_message/mail_new，仅 server→client 推送，发送走 REST）；`openapi.yml` 加 17 端点（friends 8 / chat 4 / mail 5）+ 7 schema。客户端 `npm run proto:gen` + `rest:gen` 重生。验证：shared `tsc -b` + 六包 `tsc -b` + client tsc 全绿，生成 proto 含 social 消息。
- [~] **S6-1 好友**（服务端 + 客户端 net 层 ✅，2026-06-16；**好友 UI 待做**）：**meta**（`metaserver/src/social.ts`）好友/申请/拉黑 service（resolveByPublicId / getFriends / listRequests / requestFriend / respondFriend / removeFriend / blockUser / unblockUser，校验 FRIEND_CAP + 双向边 + 任一方向拉黑屏蔽 + 同向申请幂等 + accept 原子建双向边）+ `MetaService` 8 个 openapi handler（push friend_request 给目标 / accept 推 friend_update 双方 / remove·block 推 REMOVED + `invalidateFriends` 双方）+ 内部端点 `GET /internal/social/friends`；`GatewayClient` 扩 `push`/`presence`/`invalidateFriends`（meta→gateway `/gw/push`·`/gw/presence`·`/gw/social/invalidate`）。**gateway** presence 广播（连/断 `broadcastPresence`：拉好友列表[缓存] + 向在线好友 push `friend_presence`，上线另回送在线好友快照）+ `presenceOf`/`invalidateFriends` + internalHttp `GET /gw/presence`·`POST /gw/social/invalidate` + proto.ts/Gateway.ts 5 个 social ServerMsg 编码（`friend_update` ADDED=0/REMOVED=1）+ `MetaClient.getFriends`。**客户端** `ApiClient` 8 个好友方法（DTO 用生成 `ProfileView`/`FriendView`/`FriendRequestView`）+ `NetSession` 路由 5 个 social push → handler 回调（onFriendPresence/Request/Update/ChatMessage/MailNew）。验证：六包 `tsc -b` + client tsc + meta 74 测试（+6 `social-friends.e2e`：搜索/申请推送/同意建双向边+推双方/presence 在线态/重复 ALREADY_FRIEND/拉黑屏蔽+删边/删好友推 REMOVED）+ gateway 10 + client 168 + web 构建全绿。**待办**：好友 UI（大厅社交 Tab：列表+在线态点+申请红点+搜索框，复用 ProfilePopup + sketchUi）。**依赖**：S6-0。
- [ ] **S6-2 私聊**：meta 会话/消息 service（好友校验 + 拉黑 + **敏感词分地区配置 SOC10** + 限流 `CHAT_SEND_RATE_PER_MIN`）+ REST + push；客户端聊天 UI（会话列表 + 窗口 + 历史分页 + 未读红点）。**依赖**：S6-1。
- [ ] **S6-3 邮件**：meta 邮件 service + 附件领奖（编排 commercial + inventory + `claimOrderId` 幂等）+ REST + `mail_new` push；系统邮件内部写入端点；客户端邮件箱 UI + 领取。**依赖**：S6-0（领奖依赖 commercial ✅）。
- [ ] **S6-4（SLG 后）频道**：独立 `social` 服务 + **Redis pub/sub** + gateway 订阅投递 + 帮会/家族/国家频道。**依赖**：SLG 模式 + Redis（兑现 M22）。

---

## i18n（贯穿，随场景落地）

- [~] **I-1** 新增命名空间键（`zh.ts` 为唯一来源，`en`/`de` 同步补全，否则编译报错）：`auth.*`（登录界面，SA）/ `meta.*` / `shop.*` / `gacha.*` / `collection.*` / `room.*` / `profile.*`。随对应 UI 任务一起加。`room.*` 已随 S1-8 落地（zh/en/de 全翻）；`auth.*` **已随 SA-3 落地**（zh/en/de 全翻）；其余随后续场景。

---

## 风险与注意

- **确定性**：联机/养成逻辑在 `game/` 内严禁 `Math.random()`，走注入 `Prng`；**gacha 例外**（服务端 `crypto`，不进回放，见 `META_DESIGN.md §8`）。
- **硬墙**：PvP 引擎构造签名永不出现 `SaveData`（编译期隔离），配 S3-3 单测回归。
- **钱包零信任**：客户端永不直接写 `wallet`/`inventory`；全走服务器事务 + 回推。
- **微信合规**：联机、虚拟支付、备案需单独排期（`META_DESIGN.md §10`）。
