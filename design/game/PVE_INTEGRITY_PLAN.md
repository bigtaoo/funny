# PvE 数据完整性 + 离线合并 — 设计稿（✅ 已实现，见 META_TASKS S4-4 + C4）

> 2026-06-15 起草。背景：S1-RP 录像底座（`RecordingInputSource`/`ReplayInputSource`/服务端
> `matches.replay`/`replayBlobs`）+ S1-J 对等裁判（第三方无头复算）已落地。本稿讨论把这套基建
> 延伸到 **PvE（战役）防作弊** 与 **离线数据合并** 的信任模型。**方案已落地**（META_TASKS S4-4 Step 1/2/3 + C4 处置），仅剩抽检率线上调参。

## 0. 用户拍板方向（出发点）

- 单纯关卡（PvE）问题不大：在线玩也是本地跑确定性引擎，给定 `seed + level + 玩家指令` 可逐 tick 复现。
- 但要核对**战力**与**频率**；对可疑数据，用**录像偷跑复算**验证。
- **开局战力不符 → 必作弊**（最强、最廉价的判据）。

## 1. 当前信任缺口（为什么需要这层）

- PvE 通关结果（`progress.cleared`/`progress.stars`）、材料掉落（`materials`）、养成等级（`pveUpgrades`）
  全是 **客户端同步段**（`PUT /save` 接受 `progress/materials/pveUpgrades/equipped/flags`，见 META_DESIGN §2）。
  服务器目前 **不校验** 这些段，只做乐观锁存储 → 改本地存档即可伪造通关 / 刷材料 / 拉满养成。
- 材料是养成的根资源：`tryUpgrade`（`createAppCore`）在**客户端**扣材料 + 升 `pveUpgrades` 后 `PUT /save`。
  整条「PvE 通关 → 掉材料 → 升级 → 战力」链路当前 **全客户端权威**。

## 2. 分层校验（提议）

### L0 — 廉价不变量（每次上报，服务器纯算，无需复算录像）

把 PvE 结算从「客户端自报数额」改为「客户端报**事件**、服务器据权威规则**重算数额**」：

1. **奖励重算（不信客户端报的材料数）**：服务器持 `campaign/levels/*.json`（已是单一来源 + `parseLevelDefinition`）。
   客户端只报 `{levelId, stars, replayRef?}`；服务器按 `LevelRewards` + 首通规则重算应发材料，自己入账。
   → 关掉「直接报 materials += N」的口子。
2. **关卡顺序前置**：`cleared` 新增项必须满足解锁前置（顺序解锁规则，服务器持），否则拒。
3. **频率 / 速率上限**：每关通关 cooldown + 每日 PvE 材料上限（类比 `VICTORY_DAILY_WIN_CAP` / `adsDaily`
   的按 `dayKey` 原子计数），超限不发材料（仍可练，不刷资源）。
4. **开局战力一致性（用户判据）**：客户端在录像/上报里带「本局开局蓝图/养成快照」；服务器据其**存储的**
   `pveUpgrades` 重算应有蓝图，不符即标记作弊。⚠️ 见 §4 的根问题——`pveUpgrades` 自身是客户端段。

### L1 — 录像抽检复算（可疑才触发，复用 S1-RP/S1-J 基建）

- 客户端 PvE 录像由 `RecordingInputSource` 天然产出（**只含玩家指令**，敌方波次回放时由 `seed+level` 重算）。
- 触发条件：L0 命中异常 / 首通高价值关 / 按比例随机抽检。
- 复算方：①服务端无头复算（meta 或专用 worker 跑确定性引擎）；或②派给第三方在线高配客户端（完全复用 S1-J
  `judgeRunner` + gateway `/gw/judge`，把 PvE 录像当 judge_request）。复算终局 == 客户端声称的 stars/通关 才入账。
- 录像来源：客户端本地 `ReplayStore`（已存最近 12 局）按需上传，**默认不传**（省带宽），仅可疑/抽检时拉取。

## 3. 与现有基建的契合（几乎零新基建）

| 能力 | 现状 | PvE 复用 |
|---|---|---|
| 录制 | `RecordingInputSource`（S1-RP）已包 PvE 自建局 | 直接产 PvE 录像 |
| 回放/复算 | `ReplayInputSource` + `judgeRunner`（S1-J） | PvE judge = 同一套无头复算 |
| 录像持久化 | `matches.replay` / `replayBlobs` / `replayRef`（本次 S1-RP） | PvE 录像同套存取 |
| 速率计数 | `adsDaily` / `victoryDaily` 按 dayKey 原子计数 | PvE 每日材料上限同款 |
| 关卡规则权威 | `levels/*.json` + `parseLevelDefinition`（已是服务器可读单一来源） | 服务器重算奖励/前置 |

## 4. ⚠️ 根问题（最关键的待拍板项）

`pveUpgrades` / `materials` 是**客户端可写同步段**。即使 L0 重算奖励，作弊者仍可直接 `PUT /save` 把
`pveUpgrades` 拉满 / `materials` 改大 —— 「开局战力」校验也失效（服务器存的就是被改大的值）。两条出路：

- **A. 守恒不变量（保留客户端应用升级，服务器校验账本）**：服务器累计「合法发放过的材料总量」
  `grantedMaterials`（权威，仅 L0/L1 通过的 PvE 结算 + 商店产出累加）。`PUT /save` 时校验
  `spent(pveUpgrades 按升级费用表反算) + 剩余 materials ≤ grantedMaterials`，超出即拒/回滚。
  改动小（客户端体验不变），但要服务器存一个材料发放总账 + 升级费用表（已在 `pveUpgrades.ts`，可上提 shared）。
- **B. 升级权威迁服务器**：`materials`/`pveUpgrades` 从同步段降级为**只读镜像**（同钱包 S5 模式），
  升级走 `POST /pve/upgrade`（服务器扣材料 + 升级 + 回推）。最干净、最防刷，但客户端要改花费路径
  （`tryUpgrade` 改调 API），且离线不能升级（或离线暂存、上线补结算）。

> 倾向：**A 起步**（小改、体验无损、堵住直接改 save 的口子），B 作为高价值养成上线前的加固选项。

## 5. 离线合并（已拍板 2026-06-21，见 §8.4）

> **结论**：定位收窄为**弱网用户的补偿机制**（不是离线进度系统）——选 **C1（信任 + 异常补校验）**，**不设「待确认」中间态**，改为「先发后查、异常追回」。详见 §8.4。C2（离线只读养成）已否决（体验差）。

当前 `SaveManager.reconcile`：本地匿名存档登录后合并进云端，PvE 进度不丢、权威段以云为准。
问题：离线期间 PvE 进度/材料是**客户端自报、无服务器校验窗口**（离线不能跑 L0/L1）。

## 6. 待你拍板的决策点

1. **§4 根问题选 A（守恒账本）还是 B（升级迁服务器）？**（影响最大）
2. PvE 录像：默认不传 + 可疑抽检拉取（省带宽）✅ ，还是高价值关一律上传？
3. L1 复算放服务端 worker，还是复用 S1-J 第三方客户端无头复算？
4. 离线合并：C1（上线补校验）确认？离线材料是否要「待确认」中间态？
5. 优先级：这层在「上线加固（S4-3）」之前还是之后做？

## 8. 已拍板（2026-06-15）+ 实现规格

四项决策（覆盖 §4/§5/§6）：

1. **范围**：选 §4 **方案 B**——`progress.cleared` / `progress.stars` / `materials` / `pveUpgrades`
   全部 **服务器权威**。`PUT /save` 同步段收窄为仅 `equipped` / `flags`。
2. **通关 = 一次服务器事务**：客户端报「打完关卡 X 得 Y 星 (+ 录像)」，服务器校验后原子写 progress/stars
   + 发材料。`equipped`/`flags` 仍客户端同步。
3. **可重复刷**：每次通关都发材料（不止首通），受**每日上限**约束（类比 `VICTORY_DAILY_WIN_CAP`）。
   首通额外发首通奖励 + 解锁下一关 + 记星（取 max）。
4. **离线**：只能重刷**已解锁**关卡攒材料；**新解锁须联网**。离线通关记录排队本地（不本地发材料），
   上线 flush → 服务器对账发材料（受当日上限）。离线不能升级/锻造。

### 8.1 M12 约束下的数据落位（关键）

metaserver 严禁 import `client/src/game`（M12）。故 PvE **经济数据**（不是 game logic）上提到
`@nw/shared` 作权威单一来源，客户端保留**展示镜像**（同 wallet.coins 模式）：

- `shared/pveRewards.ts`（新）：`PVE_LEVELS`（有序 id + 每关 `firstClear`/`repeat` 材料表 + 解锁前置）
  + `PVE_DAILY_CLEAR_REWARD_CAP`（每日发材料的通关次数上限）+ 纯函数 `grantForClear(levelId, isFirst)`。
- `shared/pveRewards.ts` 同含 `PVE_UPGRADE_COSTS`（每个 upgradeId 的材料花费表 + maxLevel）。
- 客户端 `game/balance/pveUpgrades.ts` 保留**升级效果**（HP/伤害乘子，game logic，跑蓝图用）；
  **花费**改由服务器权威（客户端镜像仅供 LevelPrep 显示，服务器 `/pve/upgrade` 重算扣费）。
- 客户端 `campaign/levels/*.json` 的 `rewards.materials` 降级为**参考/编辑器用**，不再是发放权威
  （发放走 `shared/pveRewards.ts`）；`starThresholds` 仍客户端用于本地算星（报给服务器校验）。

### 8.2 API（openapi.yml）

- `POST /pve/clear` `{ levelId, stars, replayRef? }` → 校验（level 存在 + **已解锁**：前置关在
  `progress.cleared` 内 + stars≤3）→ 当日上限内发材料（首通额外发首通奖励 + 解锁记录）→ 原子写
  save（progress/stars/materials）→ 回推权威 `{ save }`。超限：仍写 progress/stars，材料不发（`capped`）。
- `POST /pve/upgrade` `{ upgradeId }` → 校验材料足够（服务器）→ 扣材料 + `pveUpgrades[id]+1` → 回推 `{ save }`。
  仅在线；离线客户端禁用入口。
- 两端点都返回完整权威 SaveData（客户端 adopt 镜像，同经济回执）。

### 8.4 离线补偿三档（弱网用户，2026-06-21 拍板）

离线 flush 上线对账（§8.4 项 4）的发放策略 = **先发后查、异常追回**，按上报量分三档：

1. **不过分（在合理阈值内）**：直接信客户端自报、**立即发放**补偿，不要求录像。绝大多数弱网用户走这档，体验无损。
2. **过分（超阈值：通关数/材料量/速度异常）**：**拉取上传的录像服务器复算**（L1）后再决定是否入账。
3. **复算判定作弊**：**本次离线补偿全部作废** + 发**邮件说明原因**（不静默吞，给玩家解释，与社交/补偿同一邮件面）。

- **不设「待确认」中间态**：正常档直接转正，省去待确认 UX；只有超阈值才进验证流。
- **阈值「什么叫过分」= 唯一可调参数**，留实现期定（参考每日上限 `PVE_DAILY_CLEAR_REWARD_CAP` 的倍数 + 离线时长上限）。
- 多设备离线：仍以 `reconcile` 云为准，避免双发；离线 flush 经此三档对账后才入账。

### 8.3 权威落位 + 并发

`materials`/`progress`/`pveUpgrades` 仍存 meta `saves` 文档（不像钱包迁 commercial），但**只有
`/pve/*` + ranked 结算路径**能写，`putSave` 不接受。写用乐观锁 rev 守卫（同 `applyPvp`/`putSave`），
与客户端 `PUT /save`（只改 equipped/flags）并发安全。每日上限用 `pveDaily` 计数集合（同 `adsDaily`）。

**客户端 adoptCloud 并发安全（2026-06-28 修）**：`push()` 防抖 2 s 后上行，与 `pveClear` 并发飞出时存在竞态：
若服务端先处理 `putSave`（快）、后处理 `pveClear`（慢），`putSave` 回执快到时云端快照还没有新通关，
`adoptCloud` 原本直接 `this.save = cloud` 会把 `applyLocalClear` 的乐观写冲掉，玩家回到战役地图看到
「已通关的关卡变回未通关」。修复：`adoptCloud` 改为 union 语义，保留本地已有而云端尚未确认的
`cleared` 条目（来自 in-flight `pveClear`），同时补合并 `best`（纯本地展示统计，与 `reconcile` 对齐）。

### 8.4 离线队列

- 客户端 `SaveManager`：新增 `pendingClears: {levelId, stars, ts}[]`（持久化本地，非同步段）。
- 离线通关已解锁关：入队 + 本地乐观显示「待结算」，**不**改本地 materials 权威值（材料仍待服务器结算）。
- 上线 bootstrap/reconnect：按序 flush `POST /pve/clear`，每条成功后采纳回推 save；全部 flush 后清队列。
- **乐观本地解锁（progress.cleared/stars）**：`recordClear` 一进来就先 `applyLocalClear` 把通关写进本地
  `progress`（cleared 去重 + stars 取较大，仅落本地、不上行），**在线/离线都做**。理由：在线 `recordClear`
  是 fire-and-forget，服务器回执前 CampaignMap 已重建会读到旧 `cleared` → 下一关显示仍锁（实测 bug）；
  离线则原本永远不解锁。乐观写后下一关立即解锁，UX 顺滑。
  - 不破坏服务器权威：`progress` 只是**解锁显示**，下一关的实际 `/pve/clear` 仍由服务器独立校验
    （`flushPending` 对「关卡未解锁」等业务错误丢弃，不入账），无法靠改本地骗奖励。
  - 不漂移/自愈：在线 adopt、离线 flush 后 `reconcile` 用云端 `cleared/stars` **整体覆盖**回填；即便服务器
    判负（反作弊），覆盖后该关重新锁住。`extractSyncPatch` 仅上行 equipped/flags，故本地乐观写 progress 不会误传。
  - `adoptCloud`（push 成功路径）改为 union，不整体覆盖（见 §8.3 并发修复），保留 in-flight cleared。

### 8.5 迁移

`materials`/`progress`/`pveUpgrades` 字段位置不变（仍在 SaveData），只是**写权限**变。无需 `SAVE_VERSION`
bump（字段不变）。客户端 `extractSyncPatch` 去掉这三段；服务端 `putSave` 忽略这三段（防旧客户端覆盖）。

### 8.6 实现顺序（每步可验证、非破坏式切换）

1. **服务器基础（附加，不破坏现状）** ✅：`shared/pveRewards.ts` + meta `/pve/clear`·`/pve/upgrade` +
   `pveDaily` cap + 测试。客户端暂不用 → 现状不变。
2. **客户端切换（破坏式但同提交内自洽）** ✅（2026-06-15）：
   - **同步段收窄**：`SyncPatch`（client `SaveData.ts` + server `types.ts` + `openapi.yml`）→ 仅 `equipped`/`flags`；
     `extractSyncPatch` 去 progress/materials/pveUpgrades 三段；server `applySyncPatch` 结构性丢弃三段（硬墙）。
   - **reconcile 改服务器权威**：progress(cleared/stars)/materials/pveUpgrades 取云端（不再并集/取较大）；
     `progress.best` 是本地展示统计（永不上云、无奖励含义）→ 并集取优保留；equipped/flags 仍本地覆盖。
   - **通关/升级走 API**：`SaveManager.recordClear`（在线 `POST /pve/clear`→adopt；离线/失败入队）+
     `SaveManager.upgrade`（在线 `POST /pve/upgrade`→adopt；离线返 false）+ `online()`/`getPendingClears()`；
     删客户端 `applyCampaignClear`（本地发材料/写 progress 的旧路径）+ `createAppCore.tryUpgrade` 本地扣费。
   - **离线队列**：`SaveStore.loadPending/savePending`（key `nw_pending_clears_v1`，非同步段、不上云）+
     `SaveManager.pending`；bootstrap/refresh 末尾 `flushPending`（按序结算，网络错误保留、业务错误丢弃不卡队列）。
   - **场景在线门控**：CampaignMap 离线锁住新解锁关（显「联网解锁」）+ 待结算关显「待结算」；
     LevelPrep 离线升级按钮置灰（点击提示「联网升级」）+ 防连点。i18n `campaign.lockedOffline`/`campaign.pending`/`prep.offlineUpgrade` zh/en/de 全翻。
   - **测试迁移**：client `saveData`/`save-manager`(+8 新 recordClear/upgrade/pending/flush)/`campaign-rewards`(删 applyCampaignClear)；
     server `save-patch`/`save.e2e`(materials/progress 硬墙)；UI 冒烟 stub 补字段。验证：六包 `tsc -b` + client tsc + 165 测试 + UI 32 + web 构建 + meta 57 测试全绿。
3. **L1 录像抽检复算（可疑触发）** ✅（2026-06-15，复用 S1-J 第三方客户端无头复算）：
   - **触发（服务器，meta `pveClear`）**：`shared/pveRewards.shouldSpotCheck`——①首通恒查 ②L0 蓝图异常
     恒查（客户端上报开局 `pveUpgrades` 快照 ≠ 服务器权威 → 「开局战力不符 → 必作弊」§0）③其余按
     `PVE_VERIFY_SAMPLE_RATE`(0.1) 随机抽检。仅「有材料可发 + gateway 可用」才考虑抽检（无裁判退回直发）。
   - **暂扣 + 回执**：被抽中 → 写 progress/stars（解锁照常）但**不发材料**，记 `pveVerifications`
     （`status:pending` + 服务器权威 `pveUpgrades` 快照，防漂移）→ 回 `{needsReplay:true, verifyId}`。
   - **复算（`POST /pve/verify`）**：客户端补传录像帧（`net/replayUpload.replayToUploadFrames`，与裁判管线
     同构 base64 opaque）→ meta 经 `gateway.judge({levelId, pveUpgrades, frames})` 派第三方无头复算
     （`transport.proto` `JudgeRequest.level_id`/`pve_upgrades` + `JudgeVerdict.stars` 新增）→ 客户端
     `judgeRunner.runPveJudge`：本地查 `getLevel(levelId).seed` + 权威蓝图跑战役到终局算星数。
   - **入账判定**：复算星数 ≥ 声称 → 发材料(当日上限内) + `verified`；< 声称 → 判可疑不发 + `rejected`；
     无裁判可裁(ok:false) → benefit-of-doubt 照发 + `unverified`（不因缺裁判惩罚诚实玩家）。重复上传幂等。
   - **离线**：`SaveManager` 录像随 `recordClear` 入手；离线 flush 被抽中时据 `PendingClear.replayId` 从
     `ReplayStore` 取回补传（淘汰则跳过，材料本轮不入账）。**录像默认不传**，仅被抽中才补传（省带宽）。
   - 文件：`shared/{pveRewards,mongo}`、`metaserver/{service,app,gatewayClient}`、`contracts/{transport.proto,openapi.yml}`、
     `gateway/{Gateway,proto,internalHttp}`、client `{net/{judgeRunner,replayUpload,NetClient,NetSession,ApiClient,openapi(生成),proto/transport(生成)},game/meta/{SaveManager,SaveStore,ReplayStore},app/createAppCore}`。
   - 验证：六包 `tsc -b` + client tsc（L1 文件干净）+ client 168（+3 `pve-judge`）+ meta 68（+7 `pve-verify.e2e` +4 `spot-check`）+
     gateway 10（+1 PvE judge）+ matchsvc 17 / gameserver 42 / commercial 22 测试全绿。**注**：web 构建当前被一处
     **与本任务无关的未提交 WIP**（`render/{StickmanRuntime,UnitView}` 的阵营描边特性，引用未定义 `OUTLINE_SCREEN_PX`）阻断。
   - **待办**：抽检命中可疑（rejected）后的处置策略（标记/封号/降级）仍为占位（仅记 `pveVerifications.status`）；
     抽检率 / 每日上限实测调参。
   - ✅（2026-07-18）**rejected 录像归档**：`pveVerifications.frames`/`endFrame` 此前从不落库（`/pve/verify`
     收到的帧只透传给 `gateway.judge`，判完即弃）——玩家对误判申诉时无法回放核对。现在仅当复算结果为
     `rejected` 时把提交的原始帧写回该文档（verified/unverified 路径不存，避免集合膨胀）。

## 7. 不做 / 暂缓

- 不为录像引入外部对象存储（S3）；沿用 Mongo `replay`/`replayBlobs`（够用，见 S1-RP）。
- 反作弊不追求「不可能作弊」，目标是「直接改 save 即穿帮 + 异常必复算」，把作弊成本拉到重写确定性引擎级别。
