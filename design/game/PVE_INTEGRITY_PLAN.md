# PvE 数据完整性 + 离线合并 — 设计讨论稿（待拍板）

> 2026-06-15 起草。背景：S1-RP 录像底座（`RecordingInputSource`/`ReplayInputSource`/服务端
> `matches.replay`/`replayBlobs`）+ S1-J 对等裁判（第三方无头复算）已落地。本稿讨论把这套基建
> 延伸到 **PvE（战役）防作弊** 与 **离线数据合并** 的信任模型。**尚未实现**，先确认方向。

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

## 5. 离线合并（独立待讨论项）

当前 `SaveManager.reconcile`：本地匿名存档登录后合并进云端，PvE 进度不丢、权威段以云为准。
问题：离线期间 PvE 进度/材料是**客户端自报、无服务器校验窗口**（离线不能跑 L0/L1）。

- 选项 **C1（信任 + 上线补校验）**：离线 PvE 进度上线后走同一套 L0（重算奖励/顺序/限速），可疑要求补交录像 L1 才入账。
- 选项 **C2（离线只读养成）**：离线可玩、不产养成材料，联网才结算奖励 —— 体验差，倾向否决。
- 开放问题：①离线材料是否设「待确认」中间态，上线校验通过才转正？②多设备离线各自推进，`reconcile`
  以云为准是否会**丢**某设备的离线进度（需核对 `extractSyncPatch` 合并语义是覆盖还是并集）？

## 6. 待你拍板的决策点

1. **§4 根问题选 A（守恒账本）还是 B（升级迁服务器）？**（影响最大）
2. PvE 录像：默认不传 + 可疑抽检拉取（省带宽）✅ ，还是高价值关一律上传？
3. L1 复算放服务端 worker，还是复用 S1-J 第三方客户端无头复算？
4. 离线合并：C1（上线补校验）确认？离线材料是否要「待确认」中间态？
5. 优先级：这层在「上线加固（S4-3）」之前还是之后做？

## 7. 不做 / 暂缓

- 不为录像引入外部对象存储（S3）；沿用 Mongo `replay`/`replayBlobs`（够用，见 S1-RP）。
- 反作弊不追求「不可能作弊」，目标是「直接改 save 即穿帮 + 异常必复算」，把作弊成本拉到重写确定性引擎级别。
