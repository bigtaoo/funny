# SLG 大世界 — 咬合表 / 分期 / 契约设计（§10 起）

> 从 [`SLG_DESIGN.md`](SLG_DESIGN.md) 拆出（2026-08-17，原文件 736 行）。**小节编号沿用原文**，`SLG_DESIGN.md §N` 引用照旧有效。
> 本册内容：§10 与现有系统咬合、§11 反作弊、§12 分期任务、§13 风险、§14 契约设计。总览与在先小节见 [`SLG_DESIGN.md`](SLG_DESIGN.md)。

---

## 10. 与现有系统咬合表

| 现有系统 | 咬合方式 | 改动量 |
|---|---|---|
| 确定性引擎 / `GameMode` | 新增 `'siege'` 模式，防守 config 当关卡 | 小（加模式分支） |
| `ReplayInputSource` / `RecordingInputSource` | 围攻 = seed+输入流+防守 config，原样复用 | 零 |
| `AISystem` | 当防守方 AI / 自动进攻方 | 小（复用 + 调参） |
| `buildXxxBlueprints` | 加第三套 `buildSiegeBlueprints(养成)`；天梯不动 | 小 |
| `runSiegeBattle`（`@nw/engine`）/ PVE_INTEGRITY 养成权威 | 关键战斗权威结算（**非** `judgeRunner` 复算，见 §16/ADR-007）+ 养成数值权威 | 中（扩展到 SLG） |
| level-editor / `levelSchema` | 防守 config 复用校验 | 小 |
| social（好友/邮件/presence） | 家族升级版 + 群频道（Redis） | 中（群频道新模型） |
| commercial | SLG 全部变现 | 小（加商品） |
| admin / OPS | SLG 运维/审计/赛季运营 | 中 |
| 天梯 PvP / 硬墙单测 | 完全隔离，零改动（红线） | 零 |

---

## 11. 反作弊与信任边界

- **服务器权威段**（不可信客户端）：地图态/领地归属/资源/兵力/养成/钱包/拍卖成交 —— 全在服务器，客户端只读。
- **关键战斗权威**（SLG11，**已按 §16/ADR-007 改**）：关键围攻 = 双方预布兵的确定性自动战斗，**服务器跑引擎算权威结果即时落地**，伪造战报无效。~~（旧：judgeRunner 复算后才落地——已废）~~
- **拍卖行反 RMT**（SLG9）：高税 + 限额 + 禁挂 + 价格护栏（下单硬闸）+ **异常模式离线检测 + admin 审计队列**（§17.13，事后核查合谋倒货）。
- **天梯隔离**（SLG7）：养成/SLG 战力对天梯零影响，电竞公平不被付费污染。

---

## 12. 分期与任务拆分（S8）

> SLG 是 month 级大工程，按可独立验收的切片推进。详细勾选见 `META_TASKS.md` S8 节。

- **S8-0 契约 + shared + worldsvc 骨架 ✅（2026-06-16）**：地图/格子/行军/家族 schema；`worldsvc` 第七 workspace；Redis 接入（gateway 横扩 + 调度）。**部署接线收尾 ✅**：`dev-up.ps1`(八进程 `world`)/`Dockerfile`(八包 build+runtime)/`docker-compose.{prod,ci}.yml`(worldsvc 服务 + `18084:18084` + healthcheck)/`Caddyfile`(`/world,/family,/auction → worldsvc:18084`)/`.env.example`(`NW_WORLD_MONGO_DB`/`NW_WORLD_REDIS_URL`)/`ecosystem.config.cjs`(`nw-world`)/CI(typecheck 八包 + e2e `up --wait` + `curl /health`)。`npm run dev:all` 起八进程，实跑 curl `/health`·`/world/map`·`POST /world/join`·无 token 401 全通。
- **S8-1 地图与领地 ✅（2026-06-16）**：格子状态机、占领、资源惰性产出、驻军、保护罩。worldsvc `service`/`httpApi` 做实 `joinWorld`(主城 base TileDoc + 新手保护罩 + 满兵 + 起步产率 + 容量守卫，幂等)/`occupyTile`(直占 territory：先结算资源→扣 `GARRISON_PER_TILE`→写 TileDoc→重算 `yieldRate`；校验越界 `OUT_OF_RANGE`/中心/兵力 `NO_TROOPS`/他人主城 `PROTECTED`/他人领地 `TILE_OCCUPIED`，自占幂等)/`abandonTile`(退兵+删格回归程序化+重算)；`shared/slg.ts` 加纯函数 `tileYield()` + `SlgError`；`POST /world/{join,occupy,abandon}`；视图含 `occupied`/`mine`、`getMe` 含 `territoryCount`。e2e 15 例（service 8 + httpApi 7，真 Mongo）。**直占即生效（无行军旅行/围攻）**——夺他人地走 S8-2 march occupy + S8-3 siege；owner publicId 解析待 meta `/internal/profile` 接入。
- **S8-2 兵力与行军 [~]（2026-06-16，行军/调度/到点/推送 ✅；训练队列待）**：worldsvc `startMarch`(occupy/reinforce；**出征即从兵力池扣兵**，`arriveAt=departAt+marchDurationSec`[欧氏距离 ceil × `MARCH_SPEED_SEC_PER_TILE`，双端可算；S8-6.6 改为 A* 路径长度 × `MARCH_SPEED_SEC_PER_TILE`])/`recallMarch`(去程翻**返程腿**，返程耗时=已走时长，到点退兵回池)/`processDueArrivals`(**Mongo `arriveAt` 索引扫描为权威**，跨世界、无 Redis 也正确；`findOneAndDelete({status:marching})` 原子认领+删瞬态文档 → occupy 写 territory TileDoc[garrison=带兵]+重算 yieldRate[到达时已被占/中心→**退兵回池**不夺地]、reinforce `$inc tile.garrison`[兵不回池；目标已非己方→退兵]、return 退兵回池[封顶 troopCap])；`scheduler.ts` `setInterval`(2s)+`unref`+重入守卫；**Redis ZSET `world:{w}:march`(score=arriveAt) 由 `scheduleMarch/unscheduleMarch` best-effort 维护，仅作未来精确唤醒提示，处理逻辑不依赖**（缺 `NW_WORLD_REDIS_URL` 静默降级）；实时推送 `march_update`/`tile_update`（§14.5）经 worldsvc `gatewayClient`(`SlgPushMsg`+`HttpWorldGatewayClient.push` best-effort) → gateway `matchsvcClient.PushMsg`+`Gateway.toServerMsg`+`proto.ts` 编码，owner 定向下发（与 social 共用 `/gw/push`）；`POST /world/march`+`/world/march/{id}/recall` 做实。e2e 22 例（worldsvc，+7 march）+ gateway 10 全绿。**待办**：兵力上限/**训练队列**(`/world/troops/train|speedup` 仍 stub)、attack/sweep 围攻→S8-3、`under_attack` 预警推送、行军列表 GET、client REST codegen + UI。
  - **数值（U6 DRAFT）**：`MARCH_SPEED_SEC_PER_TILE=6`、`OCCUPY_MIN_TROOPS=GARRISON_PER_TILE=500`、`MARCH_MIN_TROOPS=1`。
- **S8-3 围攻战**（⛔ **本条 + S8-3b 描述的「廉价结算 + judge 复算 + 手操复盘」方案已被 §16 / ADR-007 整体作废**；judge siege 路径/录像上传/peer 复算/`siegeLandingFromVerdict` 均已删。现行围攻 = 双方预布兵确定性自动战斗，服务器引擎权威即时落地，见 §16。以下保留作历史）：
  - **引擎 `'siege'` 模式 ✅**（`@nw/engine/types.ts`）：机制同 campaign（防守方 = `WaveDirector` 脚本，防守 config = `LevelDefinition`，本地玩家 = 攻方），**仅蓝图源不同** = `buildSiegeBlueprints(pveUpgrades)`（`balance/pveUpgrades.ts`，与 `buildCampaignBlueprints` 同养成树/注入点，独立命名守天梯红线 §6.1）；`GameEngine` 把原 `campaign` 分支广义化为「有 `waveDirector` 即 PvE 形态」覆盖 campaign+siege（蓝图选择/level 设置/出怪/胜负判定），破城 winner=0 → 攻方夺地。
  - **judgeRunner siege 复算 ✅**（`net/judgeRunner.ts`，§5.3）：`JudgeRequest.defense_json`（`transport.proto` +field 8，`npm run proto:gen` 重生）非空 → `runSiegeJudge`：seed + 防守 config(JSON LevelDefinition) + 攻方权威养成快照 + 攻方帧按 siege 跑到终局，winner_side=0=attacker_win（攻方篡改本地状态改不了「这套兵能否在这套防守 config 下破城」）。
  - **worldsvc 围攻编排 ✅（廉价结算）**：`shared/slg.ts` 加 `siegeId`/`resolveSiege`(线性 Lanchester-lite)/`npcGarrison`/`SIEGE_LOOT_RATE`/`SWEEP_LOOT_PER_LEVEL`；`startMarch` 开 `attack`(校验目标他人领地/未保护 + 出征即推 `under_attack` 预警给防守方)/`sweep`(目标无主)；`applyArrival` 到点 `applySiege`（attacker_win+territory→易主+survivors 成驻军+掠夺败方资源+双方产率重算；+base→**不可夺**：守军清零+上保护罩+掠夺+攻方生还回师；defender_win→攻方 committed 全灭+守军减员）/`applySweep`（NPC：胜=缴获+回师退兵，败=兵损耗），写 `sieges` + 推 `siege_result`；`/world/sweep` 别名。
  - **gateway ✅**：`under_attack`/`siege_result` 两 ServerMsg 分支编码（`proto.ts`/`Gateway.ts`/`matchsvcClient.ts`；proto 早有消息 §14.5）。
  - **承重墙取舍**：worldsvc 不引确定性引擎（M12），到点用**廉价线性数值结算**即时落地（§5.3 许可的「非关键/廉价数值结算」路径）；引擎 + judgeRunner 复算（「关键战斗」承重墙）已落地并单测，**S8-3b** 经 worldsvc→gateway `/gw/judge` 接入替代廉价结算 + 录像 `replayRef` + **客户端围攻 UI**（本刀无 PIXI 场景，SLG client UI 无基线）。
  - **S8-3b 客户端落地（C2，2026-06-19，叠加层 B）**：拍板 **B = 廉价结算仍为权威，复盘=反作弊对账层**（非「替代廉价结算」的全权威重构）。新增 `GET /world/siege/{id}/defense`（仅进攻方）返回可玩 `LevelDefinition`；`shared.buildSiegeLevel(config,tileLevel,seed)` 把防守 config 子集（garrison/defenderBuildings/defenderBaseLevel）规整为完整围攻关卡（objective=destroy_base、空波次；无自定义→按格等级派生象征基地防守），`siegeSeedFromId` 为 seed 单一来源——**两端逐字一致**才能确定性复算。客户端攻方在 `siege_result` 弹层点「复盘」→ `GameScene` siege 模式实打 → `resolveSiege` 上传录像。**同时修复** `resolveSiegeWithJudge`：原先把存储的防守子集直接当完整 `LevelDefinition` 传 judge（缺 objective/waves/seed → 复算必崩），现改用 `buildSiegeLevel` 同源构造 `defenseJson` + canonical seed。判负翻转仍未启用（B：仅 log mismatch）。
  - 验证：client tsc + **176 测试**（+7 `test/siege.test.ts`：养成单调性/红线/引擎确定性/judge 复算闭环）+ web 构建；八包 `tsc -b` + **worldsvc 29 e2e**（+6 siege +1 sweep httpApi）+ gateway 10 全绿。
- **S8-4 家族 ✅（2026-06-19）**：家族 CRUD（创建/加入/退出/踢出/角色/解散）、家族频道（落库 + gateway 定向推 `family_msg`）、互助/盟友关隘通行、防守 config。拍板不做家族战（围攻复用 attack/siege）。
- **S8-4b 宗门 ✅（2026-06-20）**：补齐「大区→宗门→家族」三级里此前缺失的宗门层。宗门以**家族**为成员单位，操作须族长代表；`sects`/`sectMessages` 集合 + `families.sectId`。功能：建宗门（5000 coin via commercial，TAG worldId 内唯一）/家族加入退出（≤30 家族）/解散/联盟（双向，各 ≤2 = 3 宗门联盟）/罢免换届（族长投票 ≥⌈家族数×2/3⌉ → 门主转移）/宗门频道（落库，TTL 7 天）。**门主被打惩罚**：门主主城被破 → 全宗门成员资源 -50%（§8.2；主城迁移暂缓）。**大比按宗门**：`settleSeason` 按「宗门→散家族→个人」聚合占国数排名（兑现 §2.1）。`/sect/*` REST + worldsvc 12 e2e。**待办**：~~繁荣度建宗门门槛数值~~（✅ 已拍板 2026-06-22 §14.10 U6 + 已核验 ECONOMY_NUMBERS §13-SLG-E 2026-06-30 CLOSED）；盟友视野标记 + 客户端 UI（S8-9 C6）。
- **S8-4c 宗门频道实时推送横扩 + 主城迁城 ✅（2026-06-20，服务端 + 客户端）**：
  - **宗门频道实时推送（横扩，SOC9 / §8.2 / §8.4）**：worldsvc `gatewayClient.broadcast(recipients, msg)`——Redis 可用 → publish 一条 `{recipients, msg}` 到 `GW_PUSH_REDIS_CHANNEL='nw:gw:push'`（`shared/slg.ts`），各 gateway 实例订阅（`gateway/redis.ts` `connectGatewaySubscriber`）后经 `Gateway.routeBroadcast` **只推本机在线收件人**；无 Redis → 降级逐个 HTTP push 兜底（≤900 人，避免 worldsvc O(n) 直推）。`sectService.sendMessage` 落库后扇出 `sect_msg`（排除发送者，本地回显靠 REST 回包），`sectMemberAccountIds` 跨成员家族汇总收件人去重。proto `SectBroadcast`→`SectMsg`（对齐 FamilyMsg：`sectId/fromPublicId/fromName/text/ts`）；新增 `family_msg`/`sect_msg` 两个 push 分支（gateway `proto.ts`/`matchsvcClient.PushMsg`/`toServerMsg` + worldsvc `SlgPushMsg`）。gateway 读 `NW_GW_REDIS_URL` 订阅（缺省降级，与 worldsvc 共用同一 Redis）。
  - **主城迁城（§3.4 / §8.2，所有玩家通用）**：
    - **主动迁城**：`service.relocateBase(worldId, accountId, x, y)`——花 `RELOCATE_COST=500` coin via commercial，把主城迁到**已被自己完全占领的 3×3 地块中心**（见下方 2026-07-14 规则改动），**保留全部领地**，沿用旧城剩余保护罩（自愿迁城不续）；原地迁城 = no-op 不扣费。`POST /world/relocate`。
    - **被动迁城**：`applySiege` 主城被破分支改为 `passiveRelocate(worldId, defenderId, t)`——`deleteMany({ownerId})` 删玩家全部己方格（旧主城 + **所有领地**，失地强惩罚，不退驻军）→ `pickRandomEmptyTile` 随机选合法空格写新主城（守军 0 + 上保护罩）→ 改 `mainBaseTile` + 重算产率。门主额外仍触发全宗门 -50%（`applySectLeaderPenalty`，叠加）。极端找不到空格 → 仅失地 + 清 `mainBaseTile`。
  - **契约/客户端 ✅**：`openapi-world.yml`（`/world/relocate`）+ `transport.proto`（`SectBroadcast`→`SectMsg`）已改并 codegen（`openapi-world.ts`/`proto/transport.ts`）；`WorldApiClient.relocateBase`；`NetSession.onSectMsg` 路由 `msg.sectMsg`；`WorldMapScene` 中立格菜单加「迁城到此」（确认弹层显花费）+ `doRelocate`；`SectScene.applySectMsg` 实时插入频道（去重）+ `createAppCore.goSectHub` 转发 `onSectMsg`；i18n `world.actRelocate/relocateTitle/relocateConfirm/relocateBtn/relocated` zh/en/de。
  - **部署接线**：gateway 加 `NW_GW_REDIS_URL`（与 worldsvc 同 Redis）+ `ioredis` 依赖；写入 `.env.example`/`dev-up.ps1`/`ecosystem.config.cjs`/`docker-compose.{prod,local}.yml`。
  - 验证：服务端 `tsc -b shared worldsvc gateway` 全绿 + worldsvc **81 e2e**（+主动迁城/迁城校验/宗门频道扇出 3 例，含被动迁城断言改写）；client `tsc --noEmit` 0 错 + **273 测试** + `build:web` 通过。
- **主动迁城规则收紧：只能迁到「已完全占领的 3×3」中心 ✅（2026-07-14，用户拍板）**：
  - **旧规则**（§3.4 初版）：迁到任意合法**空格**（界内/非障碍/未被他人占领），点中立格触发。
  - **新规则**：迁城目标 3×3 九格必须**当前已被自己全部占领**，且**必须点击最中间那块己方地**触发。九格未全占 → 提示「请先占领该地块周围地块」（`world.err.relocateNeedSurround`）。旧主城 9 格按「删除 → 变回中立」处理（用户拍板：不保留、不转普通领地），即迁城会净损失旧主城那 9 格。
  - **服务端**：`core/spawn.footprintOwnedBy(worldId,ax,ay,mapW,mapH,ownerId)`（`footprintFree` 的反面：要求九格全部属 `ownerId`）；`territory.relocateBase` 去掉「空格/未占领」校验，改为 `footprintOwnedBy` 全占校验，失败抛 `TILE_NOT_OWNED`。旧城 `deleteMany({ownerId,type:'base'})` 删除逻辑不变。
  - **客户端**：`WorldMapInput`——迁城入口从中立格菜单移到**己方地块菜单**（`tile.mine` 且非主城分支）；新增 `footprintAllMine(ax,ay)`（九格 cache 全 `mine`）；不满足则「迁城到此」按钮置灰，点按 toast 提示。`footprintFree` client 辅助 + `proceduralTile` 导入随之移除。
  - **验证**：worldsvc e2e `service.e2e.test.ts` 两条迁城用例改写（成功例改为「直接写入九格己方 TileDoc 后迁城」，因 `TROOP_CAP_BASE/GARRISON_PER_TILE=4` 格 occupy 不够；校验例：空格 / 他人格均 `TILE_NOT_OWNED`）。
- **首次进入系统自动落城 ✅（2026-06-24，用户拍板）**：落城三态归一——**首次进入=系统自动落城**（玩家不再自选坐标）/ 被破=被动随机迁城 / **仅付费迁城可自选位置**。
  - **落点策略（用户拍板：优先靠近家族）**：`service.pickSpawnTile(worldId, accountId)`——① 有家族 → 在同家族成员主城周围逐环（切比雪夫 1..`SPAWN_NEAR_FAMILY_RADIUS=6`）找第一个合法空格（成员顺序 + 同环候选均随机打散，防新人扎堆同一位成员旁，SLG 抱团核心）② 退回外环新手区随机（`pickRandomEmptyTile` 加 `minDr` 参，只取 `dr > SPAWN_OUTER_MIN_DR=0.6` 的外圈，远离中心争夺区）③ 全图随机兜底。新增 `spiralFindEmpty`/`shuffled` 私有辅助；`pickRandomEmptyTile(worldId, minDr=0)` 被动迁城调用不传 minDr → 行为不变。
  - **`joinWorld(worldId, accountId, x?, y?)`**：坐标改为**可选**——公网入口不传 → 走 `pickSpawnTile` 自动选点；仅保留显式坐标供内部/测试手动落点（原校验口径不变）。`joinSeason(season, accountId)` 去掉坐标。
  - **契约/客户端 ✅**：`openapi-world.yml` `/world/join` 去掉必填 `x,y`（重生 `openapi-world.ts`）；`httpApi` `/world/join`、`/world/season/join` 不再收坐标；`WorldApiClient.joinWorld(worldId)`/`joinSeason(season)` 去坐标；`WorldMapScene.loadData` 进图若未落城 → 自动落城 + 居中镜头，`doJoin()` 去坐标（点击空地不再按坐标落城，保留作满员兜底手动重试入口）；i18n `world.joinDesc/confirmJoin/confirmJoinBtn` zh/en/de 改为「系统自动安排落点」。
  - 验证：`tsc -b shared engine worldsvc gateway` 全绿 + client `tsc --noEmit` 0 错 + **366 测试** + `build:web` 通过；`httpApi.e2e.test.ts` 已同步改写（join 不传坐标、捕获服务端落点供后续行军），但本机 Docker 为 Windows 容器模式跑不起 Linux Mongo，worldsvc e2e 未实跑（其余用例传显式坐标走手动路径不受影响）。
  - 备注：全新玩家首次进入通常尚未入家族 → 落「外环新手区随机」；「靠近家族」在玩家已属本区某家族时生效（落点逻辑已就位，为后续家族预分配/重进留接口）。
- **客户端 SLG 社交标签修复 ✅（2026-06-28）**：修复家族/宗门/世界标签「加载中」永不结束 + 生产环境 SLG 标签静默禁用两个 bug。
  - **`WorldApiClient.req` 超时**：原无 `AbortController`——worldsvc 接受 TCP 连接但内部卡住（如 MongoDB 慢查询）时 `fetch()` 永久挂起，`slgLoading=true` 永不清，标签永远转圈。现加 10s `AbortController`；超时后 abort 转 `TypeError`，被 `FriendsScene.loadSLGStatus` catch 捕获，`slgStatus=null`/`slgLoaded=true`，正常显示「暂不可用」。
  - **`worldApi` 空串判断**：`createAppCore.ts` 原写 `worldBaseUrl ? new WorldApiClient() : null`——生产/Docker 环境 `getWorldBaseUrl()` 返回 `''`（同源 nginx 反代，是合法基址但 falsy），导致 `worldApi=null`、`loadSLGStatus` 回调缺失、家族/宗门/世界三标签全部静默显示「无 SLG」。现改为无条件 `new WorldApiClient()`，`''` 基址走同源路由。
- **S8-5 拍卖行**：材料挂单（赛季资源禁挂）/一口价 + 竞拍/指定受拍人/10% 手续费（coin）/每日限额/价格护栏滑窗/绑定禁挂机制（拍卖行与赛季解耦，无季末冻结/清算——原策略已废弃 2026-07-06，见 AUCTION_DESIGN §4.F）+ **装备交易（A）** + **异常交易审计（D，反 RMT，§17.13）** 全 ✅（2026-06-21）。**机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md)**。
- **S8-6 养成统一**：`buildSiegeBlueprints` + PvE/SLG 材料统一 + 服务器权威扩展 + 战力单调性单测。
- **S8-6.5 国家系统**：10 首府固定坐标写入 `shared/slg.ts`、Voronoi 分区计算、立国/灭国状态机、国民加成注入围攻蓝图。
- **S8-6.6 关隘/桥 + A\* 寻路 ✅（2026-06-18）**：
  - **阻挡地形程序化生成**：`TileType` 扩 `'obstacle'`/`'gate'`；`SLG_GEN` 加 `obstacleFreq/obstacleThreshold/obstacleMaxDr/gateFreq/gateThreshold`；`proceduralTile()` 在 `dr ≤ obstacleMaxDr=0.87` 区域用 `valueNoise` 生成 ~12% 障碍 + 极稀疏关隘（`gateThreshold=0.99`）；**角落区（dr > 0.87，玩家落城起始区）永无障碍**。
  - **A\* 寻路**：`shared/slg.ts` 加 `PathCell` 类型 + `findMarchPath()`（4方向 A*，曼哈顿距离启发，`Map`-based g-score 稀疏大地图友好，500k 节点上限）+ `marchDurationFromPath()`（`(path.length-1) × MARCH_SPEED_SEC_PER_TILE`）；`api.ts` 加 `PATH_BLOCKED`(400) 错误码。
  - **关隘通行规则**：`findMarchPath` 中关隘格逻辑——目标格始终可达（用于占领）；中途经过须在 `passableGateKeys` 中（己方已占领的关隘；盟友通行 S8-4 pending）；障碍格永远阻挡（含作为目标格）。
  - **worldsvc 接入**：`service.ts` 去掉 `marchDurationSec`，改用 `computeMarchPath()`（预取所有 `type:'gate'` TileDoc → 组装 `passableGateKeys` → 调 `findMarchPath`，无路 → `PATH_BLOCKED` 400）；`startMarch` 用 `marchDurationFromPath(path)*1000` 计算 `arriveAt`；`joinWorld`/`occupyTile`/`startMarch` 加障碍格/关隘格校验（`BAD_REQUEST`）。
  - **测试**：`worldsvc/test/pathfinding.test.ts`（纯单测：同格/越界/无障碍路径/4方向邻接/角落无障碍/marchDurationFromPath）；`march.e2e.test.ts` 全部 `marchDurationSec` 替换为 `mv.arriveAt` / `findMarchPath` 期望值，兼容 A* 曼哈顿距离。`siege.e2e.test.ts` 无需修改（横向路径 Manhattan=Euclidean）。
  - **⚠️ 已被 gate→bridge/plankway 迁移取代（2026-07-08）**：`'gate'` 地形类型删除，拆为 `'bridge'`（跨河桥）/`'plankway'`（跨山栈道）两个**可攻占通行建筑**类型。要点：① `proceduralTile` 障碍带整条 obstacle，仅每带保留 1 处 1 格宽穿越（`RING_CROSSING_COUNT_PER_RING`/`RIVER_CROSSING_COUNT_PER_CHORD`=1、`CROSSING_WIDTH_TILES`=1）映射为 bridge/plankway；支脉也各开 1 处；旧 `_worldCityNodes` 的 `gateCity` 自动节点删除。② 通行规则不变（`findMarchPath` 未占领视障碍、目标格豁免；`passableGateKeys` 查询改 `type∈{bridge,plankway}`）。③ 新增守军 `passageGarrison(level)`（`siege.ts`）+ `arrival.ts` PvE 攻城分支：攻占**保留** bridge/plankway 类型并写 `ownerId+familyId`（修复旧 gate「占领后 `type:'gate'` 查不到」的隐藏 bug）。④ 手动放置：地图编辑器加 Carve/Bridge/Plankway 画笔（`mapEdit.ts` 支持 neutral/bridge/plankway 覆盖）。⑤ 资源：删 `terrain_gate.webp`，新增 `building_bridge`/`building_plankway`——**已出图**（2026-08-17 复核时发现本行早已过期：两张各自独立的手绘钢笔线稿已上线，256×168 / 216×256，经 `pack_buildings.cjs` 打包进 `building_atlas`/`world_atlas`，不再复用 keep/stronghold 占位，见 [`slg-building-art.md`](../product/slg-building-art.md)）。渲染 client/map-editor 双份镜像。测试 `worldsvc/test/passage.e2e.test.ts`。
  - 验证：`shared` + `worldsvc` 两包 `tsc --noEmit` 全绿（无 `marchDurationSec` 遗留引用）。
- **S8-7 赛季**：大区分配（宗门强弱平衡匹配）/赛季开启/赛季重置（清领地/兵力/繁荣度/国家归属）/结算（按宗门占国数排名/奖励材料皮肤称号）。**→ 可编码实现规格见 §17**（赛季四段式现状盘点 + 7 处代码冲突修正 + settle 发奖/排名落库/reset 原子化/admin 鉴权/繁荣度评分/G6 分配算法）。
- **S8-8 变现 + 运营**：加速/资源包/科技直购/战令（commercial）+ admin 赛季运维。
  - **训练加速语义修正 + 护盾/加速 UI（2026-08-08 fix）**：`slg_speedup_1h/8h/24h` 原实现在购买瞬间把整段 `duration_sec` 一次性吞进当前训练队列（等价于「立即完成」道具），与商品描述「加速训练 N 小时」不符，且对购买后才排队的批次毫无增益。改为持久 buff：`playerWorld.speedupUntil`（ms 到期时间，叠加规则同 `tile.protectedUntil`——`max(现有, now) + 新购时长`）+ `speedupSettledAt`（增量结算高水位线）；`TRAIN_SPEEDUP_BUFF_MULT=2`（`@nw/shared`，三档道具倍率一致，只差价格/时长）。生效期内训练队列（含购买前已排队、购买后新排队的批次）整体按 2 倍速推进，通过 `applyTrainingSpeedupCatchup`（`worldsvc/db.ts`）把「buff 覆盖的真实流逝时间 ×(倍率-1)」折算成额外提前量，均匀前移队列里每个批次的 `startAt`/`completeAt`（保持批次自身时长与链式排队不变，无需级联重算）；接入点：`ShopService.buySlgShopItem`（troop_speedup 分支）/`CityService.trainTroops`/`speedupTraining`/`processCompletedTraining`（2s 调度 tick，新增 `speedupUntil` 存在性扫描，让没有其它操作触发的玩家也能持续折算）。`PlayerWorldView` 新增 `speedupUntil`（训练加速剩余）+ `baseProtectedUntil`（主城护盾剩余，镜像 `TileDoc.protectedUntil`，与 `hp`/`maxHp` 同款镜像理由——HUD 不依赖主城格子是否在当前视口缓存里）。**客户端 UI**（此前两个 buff 生效了但完全没地方看）：世界地图主城 tile 上叠一层半透明呼吸光泡（`WorldMapRenderer/city.ts`，任意一方主城处于保护期都会显示，不只自己的）；`WorldMapPanels/hud.ts` 状态卡下方新增 buff 行，护盾/加速各一条图标+倒计时（复用商店已有的 `armorHeavy`/`hourglassMd` 图标 + 新增 i18n key `world.speedup`，`world.protected` 早已存在但从未被调用过）；CityScene 训练面板（`modals.ts`）header 下方加「训练加速 x2（剩 Ns）」一行。worldsvc 测试补 `city-training.e2e.test.ts`（6 条：即时不吞队列/已排队批次 2x 完成/购买后新排队批次同享 2x/多次购买叠加时长/到期恢复 1x/`speedupTraining` 先折算再花币）+ `shop.e2e.test.ts`（`getMe` 镜像 `baseProtectedUntil`/`speedupUntil` 1 条）。
- **B7 国家/世界公频 ✅（2026-06-22，§6.4）**：同 world 内所有玩家均可发言的公开频道（选项对称家族/宗门/公频三级）。
  - **服务端**：`NationMessageDoc`（`nationMessages` 集合，TTL 7 天，`worldId + ts` 复合索引）；`NationChannelService.sendMessage`（校验 `playerWorld` 入驻 → 落库 → `gateway.broadcast(worldMemberAccountIds, nation_msg)`）+ `getChannel`（分页历史）。`worldsvc/httpApi.ts` 加 `POST /nation/message` + `GET /nation/channel`；`worldsvc/index.ts` 实例化 `NationChannelService` 传入 `startHttpApi`。
  - **广播**：复用 `HttpWorldGatewayClient.broadcast`——Redis 可用 → 一条到 `GW_PUSH_REDIS_CHANNEL`，各 gateway 扇出在线成员；无 Redis → O(n) HTTP push 兜底。`SlgPushMsg` 新增 `nation_msg` 分支（`worldId/fromPublicId/fromName/body/ts`）。
  - **proto / gateway**：`transport.proto` 加 `NationMsg`（field 23）；`matchsvcClient.PushMsg` 加 `nation_msg`；`Gateway.toServerMsg` 加 `case 'nation_msg'`。
  - **错误码**：`api.ts` 加 `NOT_IN_WORLD`(403)——玩家未入驻该 world 时拒绝收发。
  - **发言者昵称权威修正（2026-07-05）**：`sendMessage` 原先直接信任客户端传入的 `senderName`（本地缓存，改名后若本地未及时刷新会残留旧值/登录ID），现改为优先用 `meta.getProfile(accountId).displayName`（服务端 `ensureDisplayName` 权威值，随改名实时同步），仅在 meta 不可用时退回客户端值兜底。客户端 `FriendsScene` 世界频道 Tab 头部新增右上角金币余额显示（`getCoins` 回调 + `drawHeaderCurrency`），每条发言扣 50 金币，方便玩家发言前确认余额。同一 patch 顺带修了宗门频道（`worldsvc/sectService.ts`）+ 家族频道（`socialsvc/familyService.ts`）的同款 senderName 信任问题，统一改走各自的 meta client（`getProfile` / `batchProfiles`）解析权威昵称。三处均补了回归测试（`worldsvc/test/nation-channel.e2e.test.ts` + `sect.e2e.test.ts`、`socialsvc/test/family.e2e.test.ts`）：meta 命中时权威昵称覆盖客户端旧值，meta 未命中/未配置时兜底回退。
  - **gateway 掉线重连自动补订阅**：`gateway/redis.ts` 显式设 `autoResubscribe: true`（ioredis 默认已是，显式便于审计）+ 加 `ready` 事件 log；Redis 重连后自动重订 `GW_PUSH_REDIS_CHANNEL`，期间漏的 push 客户端 REST 拉 `/nation/channel` 历史补全。
  - **发言扣费两处修正（2026-07-06）**：反馈「发言不扣金币」，实为两层各自独立的缺陷：①**服务端曾静默放行**——`sendMessage` 把扣费包在 `if (this.deps.commercial.available)` 里，worldsvc 若没配 `NW_COMMERCIAL_INTERNAL_URL` 则发言免费通过；改为**无条件** `commercial.spend`（与 `city.ts` 速建/恢复等所有金币消耗点一致），commercial 未配置时 `spend()` 抛错 → 发言被拒、绝不落库免费消息（先扣费后落库，扣费失败不产生任何状态）。②**客户端发完不刷新钱包**——世界频道金币在 commercial 服务扣，worldsvc 不碰 metaserver 的 save 镜像，而 HUD 金币读的是本地 `saveManager.get().wallet.coins`，即便真扣了 50 屏上数字也不动 → 看着像没扣。`doSendWorldChat` 成功后新增 `refreshWallet` 回调（`nav/social.ts` 里 `client.getSave()` → `saveManager.adoptServer()`；`GET /save` 会重新把 commercial 权威余额镜像进 save），发言后 HUD 立即反映扣款。回归测试：`worldsvc/test/nation-channel.e2e.test.ts` 补 2 例（有 commercial 恰好扣 50；无 commercial 抛错且不落库）+ `client/test/social-world-chat-wallet-refresh.test.ts`（世界 Tab 的 `refreshWallet` 走 getSave→adoptServer）。
  - **历史脏数据说明**：修复前用公开 ID 当昵称落库的旧消息存在 worldsvc `nationMessages` 集合（服务端），`getChannel` 原样回放，客户端不缓存；这些旧消息 TTL 7 天自动过期，新消息已显示权威昵称。
  - **fix（2026-07-04）**：世界频道发言人昵称曾显示成公开 ID——`nav/social.ts` 的 `playerName` 回调误读了 `PLAYER_PUBLIC_ID_KEY` 而非真实昵称，已改用 `ctx.playerName()`。同时给 `NationMessageDoc`/`NationMessageView`/`WorldChatMessage` 加 `senderPublicId`（`meta.getProfile` 落库快照），`worldChat.ts` 消息行现在可点击打开 `ProfilePopup`；`ProfilePopup` 的公开 ID 行加了点击复制到剪贴板。回归测试：`client/test/social-world-chat-playername.test.ts`（`playerName` 回调不再回退成公开 ID）+ `worldsvc/test/nation-channel.e2e.test.ts` 补 3 例（`sendMessage`/`getChannel` 携带 `senderPublicId` + 旧文档缺字段兜底空串）。
  - 验证：`shared` + `worldsvc` + `gateway` `tsc --noEmit` 全绿。

**MVP 切片建议**：S8-0~3（地图+领地+兵力+围攻战，单服、无家族、无拍卖、无赛季重置）先验证「战斗接大地图」这条承重墙跑通，再叠加家族/拍卖/赛季。

---

## 13. 风险与开放问题

- **R1 工程量与风险最大的是 worldsvc + Redis**：第七进程 + 新有状态基建 + 空间/调度，是 month 级且不确定性最高。MVP 切片先验证承重墙。
- **R2 平衡复杂度**：三套蓝图 + 统一养成 + SLG 专属数值，平衡面变大；硬墙单测 + 战力单调性单测兜底。
- **R3 拍卖行 RMT**：自由市场永远是搬砖温床，税/限额/审计需持续对抗。
- **R4 单服容量与分服规则**：健康容量、并行多服、跨服大比形态仍待定（DRAFT）。**分服选人/归属链已拍板（2026-06-21）= 宗门 > 家族 > 单随**：开服分配大区时，①有宗门 → 整宗门进同一大区；②无宗门有家族 → 跟家族走；③都没有 → 单人随机分配到有空位的大区。保证社交单位（宗门/家族）成员同服可协作。**毕业软过渡（ADR-030，2026-07-03）**：外环新手区（G6 已实现，§20）玩家在赛季末/达阈值迁入正式区时，**整个新手区打包迁入同一新开正式区**（一起毕业、起跑线齐），不散插成熟老区——补掉「保护期一过即被老玩家碾压」的断崖。
- **R5 赛季节奏与重置粒度**：周期长短、重置/留存边界影响留存与变现，需上线后调参。
- **R6 真人手操围攻的在线性**：防守方离线由确定性引擎跑，但「进攻方手操 + 防守方实时反应」不成立（防守恒为脚本）——这是设计取舍（防守=自定义关卡，非实时对抗），需在玩法说明里明确。
- **开放问题**：地图/行军/家族 REST 的 meta vs worldsvc 分工；拍卖计价币种；宗门间大比形态；家族容量。~~资源主题（功能命名 vs 文具皮）~~ ✅ 已定（2026-06-30，见 §3.4）：五种文具主题资源 `ink/paper/graphite/metal/sticker`（墨水/纸张/石墨/金属/贴纸），代码 enum 直接重命名，无独立铜币货币（贴纸=赛季资源）。

---

## 14. 契约设计（S8-0）

> 本节是 S8-0 的契约层设计：进程/库归属、坐标与分服、Mongo 集合、Redis key、proto 推送、REST 端点、shared 常量/枚举/ID/错误码。**`⚠️` = 需拍板或有结构性争议的点，集中列在 §14.9。** DRAFT 值仅占位。

### 14.1 进程与库归属

- 新进程 **`worldsvc`**（第七 workspace，CJS，有状态），专属库 **`notebook_wars_world`**（与 meta/commercial/admin 同模式，独立库隔离）。
- **⚠️ P1 — 玩家面 REST 谁来服务**：现有拓扑是「玩家只触达 meta(REST) + gateway(WS) + game(WS)」。SLG 玩家操作（看地图/行军/挂单/家族）放哪：
  - **(A) meta 代理 worldsvc**（保拓扑：客户端只打 meta，meta 经内部 HTTP 转 worldsvc）——一致但 meta 多一跳、地图轮询压 meta。
  - **(B) worldsvc 自暴露公网 REST**（反代加 `/world/*`、`/family/*`、`/auction/*`）——破"只触达三面"，但地图高频读直连、meta 不背锅。
  - **倾向 (B)**：SLG 地图读频率高，硬塞 meta 不划算；worldsvc 成第四个公网面（REST），鉴权复用 meta JWT（worldsvc 验签即可，不需连 accounts）。**待你拍。**
- **M12 边界**：worldsvc 为「关键战斗权威结算」（`runSiegeBattle`，非 `judgeRunner` 复算，见 §16/ADR-007）import 确定性引擎 = 既有「裁判」例外的延伸（允许）。**⚠️ P2** 见 §14.9（防守 config 校验是否也走引擎侧 `levelSchema`）。

### 14.2 坐标与分服

- 世界 = 一个赛季服（宗门）= 一张 2D 网格地图。坐标 `(worldId, x, y)`，`x/y` int32。
- 确定性 id：`worldId`（如 `s{season}-{shard}`）、`tileId = "{worldId}:{x}:{y}"`。
- **稀疏存储 + 程序化默认**：DB **只存被占领/被改动的格子**；未触碰的中立格由 `worldId` 派生的程序化函数即时算出（类型/资源/等级/默认防守），不落库。这是 scale 的关键。
- **P3 — 地图尺寸 + 程序化分布函数 ✅ 已定案且已实现（2026-07-04，ADR-032）**：见 §3.2。

### 14.3 Mongo 集合（worldsvc 库，权威）

> 写型沿用单文档原子 + `rev` 乐观锁（META_DESIGN §6.3）。
>
> **`playerWorld` 两条硬不变量（2026-08-24 并发审计后补录，违反过 6 处）**：
> 1. **改 `yieldRate` ⇒ 同一次原子写里按旧费率结算 `resources` 并推进 `lastTickAt`。** 惰性结算算的是 `resources + yieldRate × (now − lastTickAt)`，只改其中一个就会丢产出（推进锚点不结算）或按新费率追溯重算整段未结算窗口（改费率不推进锚点）。
> 2. **反之，不改上述三者之一的写不该顺手落盘 settle。** `settle()` 是读时惰性的（`getMe` 每次重算），落盘只有在「改 `yieldRate` / 改 `buildings`（容量上限）/ 花资源」时才必要；多余的落盘既要靠 `rev` 守卫护着陈旧快照（进而在 2s 调度 tick 的 rev bump 下频繁抛 `REV_CONFLICT` 给玩家），又因为多夹一次上限而略微亏玩家。
>
> 需要在库内结算时用 `core/yield.ts::settleExpr()`（`settle()` 的聚合管道孪生体）而不是"读快照→算→`$set` 绝对值"——后者是本集合全部已知 lost-update 的共同形状。

| 集合 | `_id` | 关键字段 | 索引 |
|---|---|---|---|
| `worlds` | `worldId` | `season, shard, status(open/active/settling/closed), mapW, mapH, openAt, resetAt, capacity` | `{status:1}` |
| `tiles` | `tileId` | `worldId, x, y, type, level, ownerId?, familyId?, defenseRef?, resType?, garrison?, protectedUntil?, rev` | `{worldId,x,y}`、`{ownerId}`、`{familyId}` |
| `playerWorld` | `worldId:accountId` | `troops, troopCap, resources{ink,paper,graphite,metal,sticker}, yieldRate{...}, lastTickAt, mainBaseTile, defenseRef, materials镜像?, familyId?, rev` | `{worldId,accountId}`、`{familyId}` |
| `marches` | `marchId` | `worldId, ownerId, fromTile, toTile, kind(attack/reinforce/occupy/sweep/return/move), troops, departAt, arriveAt, status, rev` | `{worldId,ownerId}`、`{arriveAt}` |
| `stationed` | `tileId` | `worldId, ownerId, tile, x, y, teamId, army, troops, sinceAt`（队伍就地驻留 idle，§38） | `{worldId,ownerId}`、`{worldId,ownerId,teamId}`(unique) |
| ~~`families`/`familyMembers`~~ | — | **已删除（ADR-021，2026-07-01 起）**：家族数据不再存于 worldsvc 库，家族是 socialsvc 管理的全局持久实体（无 worldId）。worldsvc 仅在 `playerWorld.familyId` 保留只读镜像 + 权威写 `sectId`（经 `POST /internal/family/:familyId/sect` 回写 socialsvc），见 §8.4 / [`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md) §14/O2。 | — |
| `auctions`（在独立 `auctionsvc` 库，非 world 库） | `auctionId` | `sellerId, itemType, item, qty, price, currency, designatedBuyerId?, expireAt, status(open/sold/expired/cancelled), buyerId?, rev`（**不含 `worldId`**——拍卖与 SLG shard 无关） | `{itemType,status}`、`{sellerId}`、`{designatedBuyerId}`；过期由扫描器处理（**非 TTL**）。机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md) |
| `sieges` | `siegeId` | `worldId, attackerId, defenderId?, tile, outcome, replayRef?, recomputed, ts` | `{worldId,ts}`、`{attackerId}` |

- **资源惰性结算**：`playerWorld` 存聚合 `yieldRate`（占领/丢地时更新）+ `lastTickAt`；读时 `resources += yieldRate × dt`，封顶 `RESOURCE_CAP`。**不逐格 tick**。
- **P4（已定 §14.9）**：新 `sieges`（world 库）+ 复用 `replayBlobs` 模式，不跨库依赖 meta `matches`。
- **P5（已定 §14.9）**：防守 config **内嵌** `playerWorld.defense`（主城）/ `tiles.defense`（领地），v1 不建独立集合，多套模板留后。

### 14.4 Redis key schema（首次引入）

| 用途 | key | 类型 | 说明 |
|---|---|---|---|
| ~~行军调度~~ | ~~`world:{worldId}:march`~~ | ~~ZSET（score=arriveAt ms）~~ | **已删除（2026-07-27 审计）**：`zrangebyscore`（唯一读法）从未被调用，纯写放大；到点判定实际全靠 Mongo `arriveAt`/`nextStepAt` 索引扫描，见 `claudedocs/server.md` |
| gateway 路由 | `gw:acct:{accountId}` | STRING（实例 id） | 横扩后跨实例定向 push |
| ~~家族频道~~ | ~~`chan:family:{familyId}`~~ | pub/sub | **已迁出（ADR-021）**：宿主已迁入 socialsvc，键不变但不再由 worldsvc 持有，见 [`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md) §5 |
| 宗门/国家频道 | `chan:sect:{sectId}`（**注：键是 `sectId` 不是 `worldId`**，与家族频道同宿主迁入 socialsvc，由 worldsvc 传入 sectId） | pub/sub | 全服广播 |
| 热格缓存 | `world:{worldId}:tile:{x}:{y}` | HASH（可选） | 热点格读缓存，Mongo 为权威 |
| 视区订阅 | `world:{worldId}:sub:{accountId}` | STRING/HASH | 玩家当前订阅的区域，worldsvc 据此定向推 tile/march 事件（P9） |

> **P6（已定 §14.9）**：空间查询 v1 走 Mongo `{worldId,x,y}` 范围查；Redis 网格分桶缓存（`world:{worldId}:bucket:{bx}:{by}`）仅在出现热点后加，列为后置优化。

### 14.5 proto 新增（`transport.proto`，仅 server→client 推送）

> 与 social 同原则（SOC3）：**SLG 玩家动作走 REST**（行军/挂单/家族/设防），**实时事件走 WS push**；围攻战本体不经 gameserver、不用 `game.proto`（服务器进程内直接算权威结果，见 §16/ADR-007，无手操）。故只加 server→client。

新增 `ServerMsg` 分支（字段 DRAFT）：
- `march_update`（`marchId, kind, fromTile, toTile, arriveAt, status`）— 自己/可见行军状态
- `tile_update`（`tileId, type, level, ownerId, familyId, protectedUntil`）— 可视区格变更
- `under_attack`（`tile, attackerName, attackerPublicId, arriveAt, troopsHint`）— 被攻击预警
- `siege_result`（`siegeId, tile, outcome, lootSummary, replayRef`）— 围攻结算
- `family_msg`（`familyId, fromPublicId, fromName, text, ts`）— 家族频道
- `sect_broadcast`（`worldId, kind, text, ts`）— 宗门/国家广播
- `world_event`（`kind, payload`）— 赛季事件（开服/结算/大比）

> **⚠️ P7 — 家族频道复用 chat 还是独立**：`family_msg` 与 social `chat_message` 形态相似；复用 chat 模型（把 familyId 当 conversation）省事但群语义（成员动态/历史/已读）不同。倾向独立家族频道模型（Redis pub/sub + 可选落库历史），见 SOC6-4。

### 14.6 REST 端点清单（`openapi.yml`，服务方按 §14.1 P1 定）

```
# 地图与领地
GET  /world/me                      自己在当前世界的状态（playerWorld + 已结算资源）
GET  /world/map?cx&cy&r             视区格子（中心+半径，稀疏+程序化默认合并）
GET  /world/tile/{tileId}           单格详情（含防守摘要）
PUT  /world/defense                 设/改主城或领地防守 config
POST /world/march                   发起行军（attack/reinforce/occupy/sweep/move）
GET  /world/stationed               我方就地驻留队伍列表（§38）
POST /world/team/{teamId}/recall-stationed  召回驻留队伍回城（§38）
POST /world/march/{id}/recall       撤军
POST /world/sweep                   扫荡（自己领地/中立 NPC，廉价结算）
# 兵力
POST /world/troops/train            训练（入队，消耗粮+时间）
POST /world/troops/speedup          加速（变现，走 commercial）
# 家族（⚠️ 已整体迁出 worldsvc，2026-06-29 P4 完成，ADR-021）：
# 客户端直调 socialsvc /social/family/*（建/查/申请/审批/退出/踢人/改角色/解散/频道），
# worldsvc 不再暴露 /family/* 代理路由，下列列表仅作历史存档，见 SOCIAL_SVC_DESIGN.md §6
# 拍卖行（已迁至独立服务 auctionsvc，端口 18086，与 worldId/shard 无关；反代 /auction→auctionsvc，见 §14.1 P1 / AUCTION_DESIGN）
GET  /auction?itemType&...          浏览挂单
POST /auction                       挂单（可带 designatedBuyerId）
POST /auction/{id}/buy              一口价/竞拍
POST /auction/{id}/cancel           撤单
GET  /auction/me                    我的挂单/成交
# 赛季
GET  /world/season                  当前赛季/重置时间/大比状态
```

### 14.7 shared 常量/枚举/ID/错误码（`shared/slg.ts`）

- **ID**：`worldId(season,shard)`、`tileId(worldId,x,y)`、`marchId`、`familyId`、`auctionId`、`defenseRef`、`familyMemberId(worldId,accountId)`、`playerWorldId(worldId,accountId)`。
- **枚举**：`TileType`(neutral/resource/territory/familyKeep/center/base/obstacle/bridge/plankway/stronghold；`gate` 已于 2026-07-08 拆为 bridge/plankway)、`MarchKind`、`SiegeOutcome`、`FamilyRole`、`WorldStatus`、`AuctionStatus`、`ResourceType`(ink/paper/graphite/metal/sticker，命名定版 2026-06-30，见 §3.4)。
- **常量（DRAFT）**：`TROOP_CAP_BASE`、`MARCH_SPEED_PER_TILE`、`RESOURCE_CAP`、`RESOURCE_YIELD_BASE`、`PROTECTION_SEC`、`FAMILY_CAP`、`AUCTION_TAX_RATE`、`AUCTION_MAX_LISTINGS`、`AUCTION_DURATIONS`、`GARRISON_PER_TILE`、`SEASON_LENGTH_DAYS`。
- **错误码**（接 `api.ts` + HTTP 映射）：`WORLD_FULL`、`WORLD_CLOSED`、`TILE_NOT_OWNED`、`TILE_OCCUPIED`、`OUT_OF_RANGE`、`NO_TROOPS`、`TROOP_CAP_REACHED`、`PROTECTED`、`MARCH_NOT_FOUND`、`FAMILY_FULL`、`NOT_IN_FAMILY`、`ALREADY_IN_FAMILY`、`AUCTION_NOT_FOUND`、`AUCTION_CLOSED`、`NOT_DESIGNATED_BUYER`、`INSUFFICIENT_RESOURCES`、`AUCTION_LIMIT_REACHED`。

### 14.8 与既有 codegen 管线对齐

- proto：改 `transport.proto` → `npm run proto:gen`（客户端 `net/proto/transport.ts` 重生 + 服务端 protobufjs/手写编码同步，见既有 S1-7/S1-M4 流程）。
- REST：改 `openapi.yml` → 客户端 `npm run rest:gen`（`net/openapi.ts` 重生）。
- shared：`slg.ts` 加进 `shared/index.ts`；mongo 集合工厂 + `ensureIndexes` 扩到 world 库（或 worldsvc 自带 db.ts，参考 commercial/admin）。

### 14.9 已定方案（D0~P9）

> 2026-06-16 定。以下作为 S8 实现基准；只有 §14.10 列的项仍需后续拍板/调参。

| # | 决策 | 落地约束 |
|---|---|---|
| **D0** | **围攻不经 gameserver**：worldsvc 进程内直接跑 `runSiegeBattle`（seed+双方预布阵）headless 算出权威结果即时落地（**已按 §16/ADR-007 改**，取代本行原「本地 PvE 跑法+录像上传+judge 复算」旧描述） | gameserver 不背 SLG 依赖；siege 流程 = 引擎 headless 跑一次到终局，无客户端录像上传、无 judge 复算 |
| **P1** | **worldsvc 自暴露公网 REST**（第四公网面：`/world/*` `/family/*`），复用 meta JWT（仅 `verifyToken` 验签，不连 accounts 库）。**拍卖 `/auction/*` 已迁出至独立 `auctionsvc`（端口 18086，全服单实例，与 worldId 无关），2026-07-06** | 反代加各组路由；拓扑原则更新为「客户端触达 meta + worldsvc(REST) + auctionsvc(REST) + gateway + game(WS)」 |
| **P2** | **worldsvc import 确定性引擎 + `levelSchema`**（M12「裁判例外」延伸）：复算 + 防守 config 校验都走引擎侧 | 绑 `engineVersion`；worldsvc 随引擎版本重构建；防守 config 是引擎 `LevelDefinition` 的受限子集 |
| **P4** | **新 `sieges` 集合（world 库）** + 自带录像存储（复用 `replayBlobs` 模式），客户端经 worldsvc 取回回放 | 不跨库依赖 meta `matches`；录像 opaque bytes，engineVersion 自校验 |
| **P5** | **防守 config 内嵌**（`playerWorld.defense` 主城 / `tiles.defense` 领地），v1 不建独立 `defenseConfigs` 集合；多套模板留后 | §14.3 删 `defenseConfigs` 表，`defenseRef` 改内嵌结构 |
| **P6** | **空间查询 v1 走 Mongo `{worldId,x,y}` 范围查**；Redis 网格分桶缓存仅在出现热点后加 | §14.4 P6 行降级为「后置优化」 |
| **P7** | **家族频道独立群模型**（Redis pub/sub + 可选落库历史），不复用 1:1 chat | 兑现 SOC6-4；与 social chat 共存不混用 |
| **P9** | **动作走 REST / 事件走 push**（沿用 SOC3）；地图读 = REST 视区拉取 + `tile_update` push 增量；客户端按当前视区向 worldsvc **订阅区域**（`POST /world/subscribe?cx&cy&r`） | 视区订阅表存 Redis（`world:{worldId}:sub:{accountId}`→区域），worldsvc 据此定向推 tile/march 事件 |

---

### 14.10 剩余不确定（需后续拍板 / 调参 / 实现期处理）

> §14.9 已把契约结构定死；下面是**真正还没定**的，按性质分三类。

**A. 产品/经济拍板（2026-06-18 第三轮，全部已定）**

- **U4 大区容量 ✅（2026-07-04 复核，ADR-032 废止 2026-06-18 版本）**：**上限 500 活跃玩家/单大区**（`SLG_WORLD_CAPACITY_MAX=500`；`MIN/TARGET/MAX` 三档以 500 为封顶，与代码现状一致）。2026-06-18 曾拍板"~1 万玩家替代 300-500"，但从未落地实现（代码常量、e2e 测试、econ-sim 全部仍按 300-500 人假设跑），本次复核后正式废止该版本，改回并确认 300–500 为真实目标——不是"退回旧值"，是承认那次"升级"从未发生过。
- **U2 地图尺寸 ✅ 已实现**：ADR-032（2026-07-04）落地 500×500（25 万格）；**ADR-049（2026-07-22）放大到 1500×1500（225 万格）**——对齐主流 SLG 量级、给 10 州 + PvE 关卡留余地（这次是 1500 的真正落地，非 2026-06-18 那次从未实现的拍板）。容量目标仍 500 玩家 × 人均上限 200 块 5 级+地，图更大 = 密度/局促感缓解、行军距离拉长。稀疏存储只落被占格不影响存储。详见 ADR-049 与 §3.2。
- **U6 程序化分布 ✅（原方案 + 扩展）**：在原 `proceduralTile()` 基础上扩展：增加阻挡地形（山脉/河流约 10–15% 格子，连续地形带）；险地（稀疏强 NPC 战略点）；桥/栈道通行建筑嵌于阻挡带（gate→bridge/plankway 迁移后：每带 1 处自动兜底穿越，其余靠地图编辑器手动放置）；10 首府固定坐标（`CAPITAL_POSITIONS`）。
- **U1 拍卖行计价币种 ✅（2026-06-18 定）**：充值 **coin**；**赛季资源（粮/铁/木）禁挂**，仅材料/装备可交易；系统抽 **10% 手续费**；免费玩家通过任务/活动/关卡赚 coin 参与（最低生活保障原则）。
- **U3 赛季周期 + 大比形态 ✅（2026-06-18 定）**：赛季 **2 个月**；大比 = **大区内宗门占领首府数排名**（非跨服）；中原首府额外加权奖励；奖励材料/皮肤/称号（含连续赛季成就称号如「十冠王」）；运营活动叠加。
- **U5 家族/宗门容量 + 权限 ✅（2026-06-18 定）**：家族 ≤30 人（建立 500 coin）；宗门 ≤30 家族（建立 5000 coin + 繁荣度中等门槛）；联盟 ≤3 宗门；门主换届需 2/3 族长投票 + 提名；门主主城被破 → 全宗门成员资源 -50% + 主城自动迁移。
- **U7 碾压级阈值 ✅（2026-06-18 定）**：满装备玩家 ≈ 碾压 100 个零充值玩家（Lanchester 比值约 100:1）；非关键战斗廉价结算阈值据此设置（DRAFT 具体数值待调参）。
- **U8 防守 config 可编辑范围 ✅（2026-06-18 定）**：可编辑内容 = 玩家已收集的单位和已有的建筑/机关（复用现有兵营/箭塔等），未收集的无法使用；不引入新元素，引擎现有组件即可。

**B. 数值 DRAFT（先占位，上线后调参）**
- **U6** §14.7 全部常量（兵力上限 / 行军速度 / 资源上限与产率 / 保护时长 / 驻军数）；国民加成具体数值（防御加成 % / 产出加成 %）；碾压级廉价结算具体比值。（繁荣度建宗门具体阈值已移出本清单——已拍板+核验，见 §14.10 U6 表 / ECONOMY_NUMBERS §13-SLG-E）

**C. 实现期风险 / 细节（实现时处理，先记着）**
- **U9 engineVersion 耦合**：引擎更新 → worldsvc 须重构建；赛季中途引擎升级如何 pin 版本，保录像/复算一致性（D0+P2 的代价）。
- **U10 防守 config 旋钮接引擎 ✅（2026-06-18）**：三组新旋钮已完整落地——①**garrison（驻军单位）**：`LevelDefinition.garrison[]`（unitType/col/row），siege 模式下构造期在 Top 侧指定行列预置兵，首 tick `emitInitialEvents` 发 `unit_spawned`+`unit_move_start` 事件，单位随即按正常移动系统向 Bottom 行进；②**defenderBuildings（防守建筑）**：`LevelDefinition.defenderBuildings[]`（buildingType/col），放在 `TOP_BUILDING_ROW=17`，首 tick 发 `building_placed(owner=1)` 事件，ArrowTower/Barracks 即刻生效（射程攻击/生产单位）；③**defenderBaseLevel（基地强化）**：`LevelDefinition.defenderBaseLevel`（`0..BASE_UPGRADE_COSTS.length`，2026-07-11 天梯改动后为 0–2），直接设 `topPlayer.upgradeLevel`（跳过 ink 消耗），影响 ink 回复加成。`levelSchema` 三字段全部验证（unitType/buildingType/lane 合法性 + baseLevel 范围随 `BASE_UPGRADE_COSTS.length` 联动）；**天梯红线不动**（仅在 siege 路径生效，pvp/netplay 无 level）；31 新单测全绿；265 全量回归全绿。**遗留一致性修复（2026-07-15）**：`shared/src/slg/siege.ts` 的 `clampBaseLevel()` 在 2026-07-11 那次改动（4级砍3级）后仍硬编码 `Math.min(3,…)`，未跟随 `BASE_UPGRADE_COSTS.length`（=2）同步，导致 tileLevel≥4 的高等级据点攻城会派生非法 `defenderBaseLevel=3` 被 `levelSchema` 拒绝；已改为硬编码 `2` 并加注释标注需与 `engine/campaign/levelSchema.ts` 的 `MAX_BASE_LEVEL` 保持同步（两包无跨包依赖，无法直接 import 常量）。
- **U11 视区订阅推送扇出**：300-500 人地图 `tile_update`/`march_update` 风暴，需节流/聚合（P9 订阅模型的规模化）；密集首府区域尤需注意。（原文按 1 万人量级写，已随 U4 复核降级，风险等级相应降低但机制仍需做）
- **U12 worldsvc 单点 march 调度**：ZSET 到点消费是单点；300-500 人规模下压力显著小于原 1 万人估算，前期单进程可接受，暂不需要选主/分片。
- **U13 多步原子性 ✅ 已全部收口（2026-08-24，四轮）**：
  - **"占地/丢地改 `yieldRate` 与读时惰性结算的并发（rev 守卫够不够）"→ 答案是：守卫不是重点，写的形状才是。** 全量审计 45 个 `playerWorld` 写入点后定案两条硬不变量（见 §14.3），并修了 4 类问题：训练落地的兵力复制（`$set` 绝对值 + 无守卫 + 中间有 await，可被玩家稳定利用）、6 处 `yieldRate`/settle 不变量破绽、`startMarch` 那次**多余**的 settle 落盘（删除而非加重试——它是玩家可见 `REV_CONFLICT` 的主要来源）、`relocateBase` 收尾写改无条件（避免"已扣费 + 已搬家 + `mainBaseTile` 悬空"）。同时引入库内结算表达式 `settleExpr`，本库首次使用聚合管道 update。细节见 [`claudedocs/server.md`](../../claudedocs/server.md) "SLG worldsvc 要点"。
  - **`playerWorld` 部分已全部收口（2026-08-24 第二轮）**：40 个写入点逐个定性完毕——5 处确有害的已改（`occupyTile`/`abandonTile`/`applyDueBuilds`/`applySectLeaderPenalty` 走 `settleExpr`，训练加速 catch-up 加 `speedupSettledAt` 水位守卫），其余就地写明"为什么安全"。**判据不是"filter 里有没有 `rev`"，而是"这次写入有没有发布一个从快照派生的绝对值"**——`$inc` 增量、条件式 `$gte` 过滤、本命令自带的值、点路径限定的字段写入都不需要守卫。门主 -50% 的原子性即属已修的 5 处之一。
  - **`tiles` 同样收口（2026-08-24 第三轮）**：19 个写入点定性完毕，5 处改掉（守方胜的 `garrison` 与结构 chip 改扣伤亡、保护罩叠加改管道、攻城 HP 与墙升级 durability 改 rev CAS+重试）。`garrison` 之于 `tiles` 就是 `troops` 之于 `playerWorld`：增援 `$inc`、结算原先写绝对值。
  - **分兵规则已拍板（2026-08-24，用户决定）**：**允许**给出征中的卡分兵；相应地四处战斗结算改为持久化每卡**损失**而非绝对存活数。无并发时结果与原先逐位相同，只有并发增兵时那次增兵才会完整存活。
  - **判据固化为 CI gate**：`npm run check:absolutewrites`（`server/scripts/checkAbsoluteWrites.mjs`）。另有 `settle()`/`settleExpr()` 逐位等价性测试（`worldsvc/test/settle-expr-parity.e2e.test.ts`）守住那条"两种语言一个公式"的同步要求。
  - **拍卖成交的跨集合幂等与回滚 ✅ 已收口（2026-08-24 第四轮）**，U13 至此关闭。这一条性质与前三轮不同，**先做了方案选择**：一次成交要原子的三件事落在**三个进程、四个库**（金币在 commercial、挂单在 auctionsvc、标的与卖家收款在 meta，两条都是 HTTP），Mongo 事务只覆盖单个 session，最多能包住 auction 库那三个集合——钱和货一个都不在里面，买来的覆盖率是零，代价却是把 auctionsvc 的测试 harness 从 standalone mongod 改副本集、并破掉全库「单文档 CAS、零事务」约定。**故走幂等键 + 补偿**，形状直接沿用 commercial `orders` 早就在用的那套（insert-first 抢键 → 状态 → stale-claim CAS 续跑）。
    - **关键洞察**：下游本来就都幂等了（commercial 按 `orderId` 去重且绑定首个使用它的账号，系统邮件按 `dispatchKey` 去重，meta 库存端点按 `orderId` 去重），所以不需要造分布式事务，只需要一份**能被重新驱动的持久化待办**——新集合 `auctionOrders`，五个流程（挂单托管 / 一口价成交 / 出价托管 / 结拍 / 撤单+过期退回）全部上账本。
    - **顺带查出并修掉的实际缺陷**：①`auction_buy:{id}` **不含买家**——两个买家抢同一挂单时，第二个撞上 commercial 的跨账号归属校验、拿到莫名 `BAD_REQUEST`；更糟的是扣款后崩溃会让这个 orderId 被那个没拿到货的买家永久占用，**该挂单从此谁都买不了**。②同一竞拍者同一金额的两次并发出价共用键 → commercial 只扣一次，输掉 CAS 的那一路照样发全额退款邮件，**凭空造币**。③`settleAuctionWin` 的 CAS 只有 `{status:'open'}`、**漏了 `rev`** → 一笔新出价落在扫描器批量读与结算之间时，按陈旧 `topBid` 成交，标的发给刚被退款的上一位、新出价者的托管款孤立（这属于前三轮那一类，漏在了这儿）。④系统邮件失败只记日志不抛——生产上最可能真丢资产的一条，meta 抖一个 500 卖家的钱就没了，且没有任何东西会重试。⑤`spend` 请求体没带 `reason`，所有拍卖扣款在 ledger 里 reason 为空串。
    - **一口价改「先认领、后扣款」（用户拍板）**：倒过来之后「已扣款却被抢走 → 退款」这条补偿路径整体消失。竞拍出价刻意保持相反顺序（先扣款后写 `topBid`），因为 `topBid` 是日后付给卖家的依据，绝不能存在「有出价、没托管款」的中间态。
    - **引擎的核心是一条判据**：失败分「**业务拒绝**」（`SlgError`，下游真判过并拒了 → 证明什么都没动 → 立刻回滚）与「**传输失败**」（超时/502 → 什么都不证明，请求可能已生效 → 回滚就是造币或复制道具 → 按下游幂等键重试到拿到确定答案再决定撤什么）。配套的 `started`（前缀步骤已发起）与 `requires`（补偿依赖哪个正向步骤真落地）让回滚不必靠猜。
    - **防腐设施**：`npm run check:auctionjournal`（`server/scripts/checkAuctionJournal.mjs`，已接 ci.yml）把五种跨服务能力和全部 `auction_…` 幂等键各锁在唯一一个文件里，并对**门禁自身做了变异测试**（`auctionsvc/test/check-auction-journal.test.ts`：干净树必须过 + 五条规则各自被重新引入必须挂 + 能力搬走导致规则失效必须挂）。行为侧回归 `auctionsvc/test/journal-atomicity.e2e.test.ts`（真 Mongo，22 例，下游 fake 复刻了 commercial 的 insert-first 键位与归属校验）。三条并发用例均已验证在修复前的代码上失败。
    - **ops 欠账可见性同日补齐**：欠账原先只在日志里。现在 `AuctionListingAdminView` 带 `settledAt`（已结束却没有它 = 还欠着交付），并新增只读链路 auctionsvc `/internal/audit/settlements` → admin `/admin/slg/audit/settlements`（沿用 `slg.audit.view`，无新能力）→ ops「SLG Audit」页的「Unfinished settlements」表。不给「立即重试」按钮：扫描器本来就在永不放弃地重试。
    - 细节见 [`AUCTION_DESIGN.md` §2.3/§2.4](AUCTION_DESIGN.md) 与 [`claudedocs/server.md`](../../claudedocs/server.md) 「拍卖行成交原子性」。
- **U14 A\* 寻路性能（ADR-049 后重新提起）✅ 已确认+已修复（2026-07-27）**：地图已放大到 1500×1500，`findMarchPath` 最坏情况计算量随之上升——本条原为"监控项"，design-doc-audit-2026-07 的 econ-sim 行军疲劳核验中实测复现：**根因不是长河阻隔，而是 4 方向移动 + 精确 Manhattan 启发式在无障碍网格上对任意 (dx,dy) 都"平局"**（起止点间所有单调格路径代价相同），朴素 A* 在无平局打破策略时可能要展开接近整个 dx×dy 包围盒才能确认最优解——旧 500×500 地图最坏对角距离（~350×350≈122,500 格）安全落在 `MAX_NODES=500,000` 内从未暴露；新图上常规对角距离（如 dx=dy=600，包围盒 360,000 格）就能顶穿这个上限，导致明明可达的目标被误判 `PATH_BLOCKED`。**修复**：`server/shared/src/slg/march.ts` 的启发式加了一个极小的"叉积"平局打破偏置（偏向起止点连线，系数 `1/(2·mapW·mapH+1)`，数学上保证不会选到比最优解更长的路径），把探索量从 O(dx·dy) 降到接近 O(dx+dy)。回归测试见 `worldsvc/test/pathfinding.test.ts`「长距离对角行军」用例；详见 [`ECONOMY_VERIFICATION_LOG.md` §13-SLG-MARCH.4](ECONOMY_VERIFICATION_LOG.md)。**注**：跨 crossing（桥/栈道）未占领时仍会被正确判定为不可达（`PATH_BLOCKED`）——这是 ADR-034 的既定省份隔离设计（见 §13-SLG-MARCH.1），不受本次修复影响。
- **U15 Voronoi 分区计算**：首府坐标固定后，Voronoi 分区可预计算并缓存（或实时算），每格 tileId 的国家归属查询路径确定（worldsvc 内存缓存 + Mongo 按需）。

---

*本文档为 SLG 设计基准，DRAFT 标注处随实现/调参细化；锁定决策（SLG1~13）非经重新拍板不改。*

> §15 起的收尾清单/功能落地/实现记录/bug 修复已拆分至 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)（章节号延续本文档编号，未重新编号）。
