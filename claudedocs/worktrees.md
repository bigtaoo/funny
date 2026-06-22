# 并行开发：git worktree 约定 + 索引

> 解决「多会话并行开发」的两难：都在 main 会互踩提交；共用一个目录建分支会因 `git checkout` 全局切换打架。
> worktree = 一个仓库挂多个工作目录，各自钉死在不同分支，互不切换。**每条并行线一个 worktree，一个会话进一个目录。**

## 心智模型（先读这个）

**一条线 = 一个文件夹 = 一个分支，三位一体。**

```
.claude\worktrees\auction-house\   ← 文件夹(worktree)：工作目录的壳，是你打开的「门」
        ↓ 检出在
feat/auction-house                 ← 分支：你的提交真正存放处，是「门后的房间和东西」
```

- **开会话靠「选文件夹」，不靠「切分支」。** 打开对应 worktree 文件夹，git 自动知道它在哪条分支，提交就落到那条分支。桌面 app 的分支切换器用不上、无视即可。
- **「Couldn't switch branches」不是 bug**：同一分支不能被两个工作目录同时检出；它已被某 worktree 占用，所以别处切不过去。解法是开那个 worktree 的文件夹，而不是切分支。
- **分支不能随便删。** 删 `feat/xxx` = 删那条线还没合进 main 的提交，且被 worktree 占用时 git 直接拒绝。只有「没绑 worktree 且内容已在别处」的游离/重复分支才能删。
- **生命周期**：开文件夹干活 → 提交到自己分支 → 干完把**分支合进 main** → 然后才 `git worktree remove` 拆文件夹 + `git branch -d` 删分支。**合并之前，文件夹和分支都得留着。**

| 新会话要做 | 打开这个文件夹 |
|---|---|
| 集成 / 合并 / review | `funny\`（主目录，钉 main）|

> 拍卖行/装备 + 成就系统 worktree 均已于 2026-06-21 合并 main 后删除；**成就系统 S9 全部落地**（S9-7/S9-8 在 `nice-wu-5c3478` 收口，见索引表）；**装备 E2 faucet + E6 洗练已于 2026-06-22 在 `gifted-feistel-42c356` 合并 main**；**装备 E7 抽卡/保护道具已于 2026-06-22 在 `kind-williams-181b80` 合并 main（164093ee）**；后续装备 E8 SLG/byUnit loadout 续做时重新 `git worktree add`。

## 两种工作模式（怎么开会话）

桌面 app 新建会话时有个 **`worktree` 复选框**，行为是「**勾选 = 给本会话新建一个全新 worktree+分支**」：会切一条 `claude/<随机名>` 分支，**默认从 `main` 的 tip 切**（受 `worktree.baseRef` 影响，默认 `fresh`=origin/HEAD）。分支下拉里选 `feat/xxx` 只是选「从哪切」，**叠加勾选 worktree 仍会另造新分支**，不会进已有的那条 feat 线——这点最容易踩坑。

由此分两种模式，按任务大小二选一：

### A. 用完即弃（一次性 worktree）— 一轮对话能做完并合 main 的活
改 bug、加小功能、调数值、写文档这类。

1. 新建会话 → 项目 `funny` → **勾 `worktree`**（分支留 `main`即可）→ app 自动造 `claude/<随机名>`。
2. 干活、提交到这条临时分支。
3. **收尾(可让 Claude 代做)**：到主目录 `funny\` 把临时分支合进 main → `git worktree remove` 删目录 → `git branch -D` 删分支。

> 好处：**零维护**，不用记目录↔分支对应。代价：跨多轮对话会丢半成品（见下）。

### B. 长期 feature worktree — 跨多轮才能做完的大功能
成就、拍卖行、SLG/G5 这类。**不能**用 A：会话被上下文上限打断后开新会话，「从 main 全新开始」拿不到上一轮那条 `claude/xxx` 临时分支上的半成品。

→ 用带名字的 `feat/<slug>` worktree（见索引表），**打开对应文件夹**（**别勾 worktree 新建**），多轮提交攒在同一条 feat 线上，整块做完再合 main。打不开子目录就命令行 `cd .claude/worktrees/<slug> && claude`。

## 约定（规则）

1. **位置**：所有 worktree 放在 `C:\Users\TaoWang\Documents\funny\.claude\worktrees\<task-slug>\`，已在 `.gitignore` 忽略，不会污染 main。
2. **命名**：目录名 `<task-slug>` 用短横线短名；对应分支统一 `feat/<task-slug>`（目录名与分支后缀一致，避免错配）。
3. **主目录 `funny\` = 集成区**：理想状态钉在 `main`，用于 review / 合并 / 跑全量。各 feature 一律在自己的 worktree 里做。
4. **一线一会话**：开新会话时进入对应 worktree 目录即可，无需每次说明工作目录——查下方索引表对号入座。
5. **公共依赖先合**：改 `server/contracts` / `@nw/shared` / `@nw/engine` 的分支**最先合 main**，其余分支立刻 `git fetch && git rebase origin/main` 跟上，降冲突。
6. **共享索引文件**（`design/META_TASKS.md` 等多分支都动的）尽量只追加、单独小提交，冲突好解。
7. **干完即删**：`git worktree remove <path>`，分支合并后 `git branch -d feat/<slug>`。

## 实时索引

| 任务 | task-slug | 分支 | worktree 目录 | 状态 |
|---|---|---|---|---|
| 集成 / review | — | `main` | `funny\`（主目录）| ✅ 钉 main，集成区 |
| S9 成就系统 | achievement | ~~`feat/achievement-system`~~（已删） | ~~`.claude\worktrees\achievement`~~（已删） | ✅ **已合 main 并清理**（merge 605437dd，2026-06-21）：S9-1/2/4 服务端基座 + S9-3 PvE 章节计数 + S9-5 客户端成就墙（AchievementScene + StatsScene 入口 + 大厅红点 + i18n 三语）。SaveData 合并冲突解为装备+成就字段并存；openapi.ts 从权威 yml 重生。后续会话续做 S9-5b（达成 toast）/S9-6（PvP 计数/L1）/S9-3b（引擎分类型埋点 + PvE 喂入，见下行）均已完成；**仅剩 S9-7（反作弊 L2/L3）/ S9-8（埋点+校准）**，续做重新 `git worktree add` |
| S9-3b PvE 喂入 | reverent-golick-747a15 | ~~`claude/reverent-golick-747a15`~~（已删） | ~~`.claude\worktrees\reverent-golick-747a15`~~（已删） | ✅ **已合 main 并清理**（2026-06-21）：裁判 PvE 复算 kill/cast 经 `JudgeVerdict.stats_json`（proto + 两套 codec）→ gateway 透传 → meta `pveVerify` 仅 verified 时过 L1 caps 入账。meta 159 + gateway judge 4 + gameserver 42 + 引擎 combat 10 绿。详见 `design/game/ACHIEVEMENT_DESIGN.md §11` |
| S9-7/S9-8 成就收口 | nice-wu-5c3478 | ~~`claude/nice-wu-5c3478`~~（已删） | ~~`.claude\worktrees\nice-wu-5c3478`~~（已删） | ✅ **已合 main 并清理**（2026-06-21）：S9-7 反作弊 L2/L3（meta `anticheatAudit.auditOnce` 定时抽查批经 peer 裁判复算 per-side 成就计数 → 比对超报 → 回滚+升 `statSuspicion`+`antiCheatReviews` 审查队列；裁判 `judgeRunner` PvP 分支扩 per-side `statsJson`；`MatchDoc.reportedStats`/`audited`；OPS 链 meta→admin(`anticheat.view`)→ops `pageSuspicions`）+ S9-8（`achievement_view_wall` 漏斗 + 红线 e2e + `coin-pool` 校准）。`@nw/shared antiCheatAudit.ts` 18 单测 + meta 9 e2e；**meta 191 全绿**、admin 18 绿、`tsc -b` 全包 + client tsc/webpack + ops webpack 成功。**成就系统全部落地**。详见 `ACHIEVEMENT_DESIGN.md §11` |
| SLG 拍卖行/装备 | auction-house | ~~`feat/auction-house`~~（已删） | ~~`.claude\worktrees\auction-house`~~（已删） | ✅ **已合 main 并清理**（merge 92348b8b，2026-06-21）：装备 E0 数据模型（shared/SaveData/openapi 契约 + 存档 v1→v2）+ E1 引擎注入（applyEquipment/clampEffectCaps + 三套蓝图 + 硬墙/单调/封顶单测）。拍卖主干 S8-5 早在 main；缺口 A（装备交易）待装备 E2~E4 续做。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上 |
| 装备库存后端 E2 + 拍卖 A | peaceful-ardinghelli-1f07cc | ~~`claude/peaceful-ardinghelli-1f07cc`~~（已删） | ~~`.claude\worktrees\peaceful-ardinghelli-1f07cc`~~（已删） | ✅ **已合 main 并清理**（merge 627092d9，2026-06-21）：装备库存后端 E2（meta `equipment.ts` 合成 `craftEquipment` + 托管转移 `escrow/grantEquipment` + `/equipment/craft` + `/internal/equipment/{escrow,grant}` + shared roll/幂等集合/错误码）+ worldsvc 拍卖行 A 装备交易全链路。解锁拍卖行缺口 A；仅剩 D 异常审计待 admin G7。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。装备 E3 强化/分解·E4 穿戴·E5 UI·关卡掉落 faucet 续做重新 `git worktree add` |
| 拍卖行客户端竞拍 UI | mystifying-kalam-d5745a | ~~`claude/mystifying-kalam-d5745a`~~（已删） | ~~`.claude\worktrees\mystifying-kalam-d5745a`~~（已删，仅遗留物理目录待外部清） | ✅ **已合 main 并清理**（merge bffec7e3，2026-06-21）：客户端 `AuctionScene` 接入竞拍全链路兑现 B 端到端——挂单方式切换（一口价/竞拍：startPrice+可选 buyoutPrice）+ 市场竞拍行 `[竞拍]`/当前价/出价按钮 + `openBidForm` 出价弹层（最低加价默认 + 二次确认 → placeBid）+ errorMsg 补竞拍/护栏/装备错误码 + i18n 三语 ~20 键。纯客户端，仅改 client；后端/契约早在 main。client tsc + webpack 全绿。拍卖行**仅剩 D 异常审计待 admin G7**；装备 E3/E4/E5·关卡掉落 faucet 续做重新 `git worktree add` |
| SLG G6 多 shard 运行时 | recursing-kowalevski-84ae04 | ~~`claude/recursing-kowalevski-84ae04`~~（已删） | ~~`.claude\worktrees\recursing-kowalevski-84ae04`~~（已删） | ✅ **已合 main 并清理**（merge 5b3a03c4，2026-06-21）：G6 运行时调度（§20）——`allocateNextSeason` 蛇形均衡开 N 区 + 落 `shardAllocations.familyShard`；`resolveShardForJoin`/`joinSeason`/`resolveSeasonShard` join 自动路由（粘性>家族查表>最空开区>溢出开新区）；`patrolShardIsolation` 跨区隔离巡检；新集合 `shardAllocations` + `seasonResults.memberFamilyIds` + shared `worldShardId`/`shardCountForPopulation`；`PlayerWorldView.worldId` + 客户端去硬编码 `world:1:0`。顺带修 `openSeason` upsert status 冲突潜伏 bug。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。server tsc -b（7 包）+ client tsc + worldsvc 161 e2e（+13 shard）全绿。SLG 剩 G4 战令/G6 赛季中转区合区/G7 审计/§16.5 调参 |
| 单位养成（集卡合成） | musing-engelbart-a8311c | ~~`claude/musing-engelbart-a8311c`~~（已删） | ~~`.claude\worktrees\musing-engelbart-a8311c`~~（已删） | ✅ **已合 main 并清理**（2026-06-21，META_TASKS S12）：**S12-A 引擎脊柱**——`@nw/engine/balance/progression.ts`（单位等级 1–9 模型 `applyUnitLevels` + STAT_GROWTH §4.2 + TRAIT_BREAKPOINTS §4.4）+ **暴击机制**（`UnitBlueprint.critPct/critMult` + `GameState.combatPrng` 仅 critPct>0 才前进保 PvP 金回放 + `CombatSystem` 减护甲前 ×倍率 roll）+ 接入 buildCampaign/Siege（buildPvp 硬墙不动）。**S12-B 集卡合成**——shared `unitCards.ts`（`applyCardMerge` 5→1 + `deriveUnitLevels`）+ SaveData `unitLevels`/`cardInventory`（SAVE_VERSION 2→3）+ meta `POST /pve/merge`（真 Mongo e2e）+ 引擎 `GameConfig.unitLevels` + client 镜像/migrate v2→v3/ApiClient.pveMerge。改了 @nw/shared/openapi/@nw/engine 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。client tsc + server tsc -b + web 构建 + meta pve.e2e 14 + client 引擎 43 全绿。**剩 S12-C 盲盒/关卡产卡、S12-D UI+play接线+judge对齐 unitLevels、S12-E armor 战斗重算**，续做重新 `git worktree add` |
| 单位养成卡片来源（S12-C） | mystifying-darwin-adb8e0 | ~~`claude/mystifying-darwin-adb8e0`~~（已删） | ~~`.claude\worktrees\mystifying-darwin-adb8e0`~~（已删） | ✅ **已合 main 并清理**（2026-06-21，META_TASKS S12-C）：卡片两条来源接通，养成闭环跑通。**① 独立单位卡盲盒池**（用户拍板独立池，养成≠外观）——shared `unitCards.ts` `UNIT_CARD_POOL_ID='units'` + `GACHA_RARITY_TO_CARD_LEVEL`（common→T1…legendary→T4）+ `unitCardPoolItems()`；`economy.ts GACHA_POOLS` 加 units 池。**② 关卡掉卡**——`levelCardReward(levelId)` 确定性整数派生（ch1-2→T1/ch3-4→T2/ch5-6→T3，单位按章轮换，终关双倍，纯函数无 RNG 保抽检幂等）。**③ meta 发货分流**——`economy.deliverCardGrant`（乐观锁 read-modify-write + rev CAS + deliveredOrders 守卫保 $inc 幂等，grantCards 入库 + deriveUnitLevels 重算 + 钱包/pity 同笔写）；`gachaDraw`/对账 `deliverOrder` 按 `poolId===units` 分流（不走皮肤 dupe 退币）；`grantClearReward` 扩展材料+卡同闸门同事务；L1 抽检门覆盖仅掉卡关。openapi `/pve/clear`+`/pve/verify` 加 `grantedCards` + client `rest:gen` 重生。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。验证：server tsc -b（9 包）+ client tsc + web 构建干净；meta 230 + commercial 26 全绿（含 S12-C +5 e2e），client 322 绿（3 个 main 预存失败 headless-nav/pve-judge/siege 与本切片无关、与 main 逐字一致），零回归。**剩 S12-D UI+play接线+judge对齐 unitLevels、S12-E armor 战斗重算**，续做重新 `git worktree add` |
| 装备 E3 强化/分解 + E4 穿戴 | cool-knuth-8ca7b7 | ~~`claude/cool-knuth-8ca7b7`~~（已删） | ~~`.claude\worktrees\cool-knuth-8ca7b7`~~（已删） | ✅ **已合 main 并清理**（2026-06-21）：meta `equipment.ts` 加 `enhanceEquipment`（服务器掷骰+成功率表+材料/金币损耗，commercial.spend 走币，幂等）/`salvageEquipment`（+0~4 返 70% 材料、批量、+5/穿戴/锁定拒）/`equipEquipment`（global/byUnit 穿戴，槽位校验，纯状态）+ `/equipment/{enhance,salvage,equip}` 契约 + shared 数值/错误码 + client ApiClient 四方法。e2e 30 绿、E1 引擎 17 绿、server build + client tsc/webpack 全绿。改了 @nw/shared/openapi 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。**E5 UI·关卡掉落 faucet·E6 洗练·E7 抽卡/保护道具·E8 SLG 接入续做重新 `git worktree add`** |
| SLG G7 异常交易审计 | festive-germain-7f9d90 | ~~`claude/festive-germain-7f9d90`~~（已删） | ~~`.claude\worktrees\festive-germain-7f9d90`~~（已删） | ✅ **已合 main 并清理**（merge b56db4b4，2026-06-22）：拍卖反 RMT 离线检测 + admin 审计队列（SLG_DESIGN §17.13）——shared `detectAuctionAnomalies`（卖家→买家配对聚合 repeated/designated/high_value）+ 阈值常量；worldsvc `AuctionDoc.soldAt` + `AuctionService.scanAnomalies` + 内部端点 `GET /admin/world/audit/anomalies`；admin 新集合 `tradeAuditTickets` + `slgScanAnomalies`/`slgFileAuditTicket`(pairKey 去重)/`slgListAuditTickets`/`slgResolveAuditTicket`(open→dismissed\|actioned) + REST `/admin/slg/audit/*` + 能力 `slg.audit.view\|manage`。改了 @nw/shared 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。server tsc -b（10 包）+ worldsvc 167 e2e（+6 auction-audit）+ admin 24 e2e（+6 season-audit）全绿。**剩 ops 前端审计页 + 确认违规自动处置外联**，后置；SLG 剩 G4 战令/G6 赛季中转区合区/§16.5 调参 |

| 特效编辑器 P1 | condescending-driscoll-8c6214 | ~~`claude/condescending-driscoll-8c6214`~~（已删） | ~~`.claude\worktrees\condescending-driscoll-8c6214`~~（已删注册项，仅遗留物理目录待外部清——会话 cwd 锁定） | ✅ **已合 main 并清理**（merge，2026-06-21）：特效编辑器 P1——把 `client/src/render/VFXSystem.ts` 从硬编码 `draw` 函数迁为**数据驱动**（方案 A 墨线矢量程序特效）。新增 `client/src/render/vfx/`（types/sampleParam/primitives/interpret/registry + `effects/{hit,death_unit,death_building,spawn}.json` 1:1 复刻原数值），图元 ring/arc/spokes/burst/dots/polyline（text 占位、emitter 保留位）；VFXSystem 接 registry+interpret，加 loop 往复/play 返句柄+stop/follow 跟随，对象池·层级·公开调用点不变；解释器每层种子化 Prng（无闪烁+回放确定）。设计文档 `design/tools/vfx-editor/DESIGN.md`（独立工具端口 9094），登记进 `design/README.md §1.4`。仅改 client + design，无公共依赖改动。client tsc --noEmit + webpack dev 构建全绿。**剩 P2 编辑器脚手架（9094 + PIXI 预览 + 图层/参数面板 + 多关键帧 UI + JSON 往返 + 自动保存）、P3 法术/Trait 新特效 + boil 烘焙 + text 图元**，续做重新 `git worktree add` |
| 装备 E5 客户端 UI | elegant-northcutt-f8615a | ~~`claude/elegant-northcutt-f8615a`~~（已删） | ~~`.claude\worktrees\elegant-northcutt-f8615a`~~（已注销注册项，仅遗留物理目录待外部清——会话 cwd 锁定） | ✅ **已合 main 并清理**（merge 147c9c3f，2026-06-22）：`EquipmentScene`（单场景双 Tab：背包 loadout 三槽+实例详情 强化/穿戴/分解 / 锻造 合成）+ 客户端目录镜像 `equipmentDefs.ts`（不 import @nw/shared，纯数据+数值函数镜像 server/shared/equipment.ts）+ 视图接线（AppViews/app.ts/createAppCore goEquipment/HeadlessAppViews）+ 战役地图顶栏入口（仅在线）+ i18n 三语 + `genUuid` 导出做 idemKey。服务器权威贯穿（只发意图读回执、错误码全映射、埋点对齐 §19）。**纯客户端**，仅改 client，无公共依赖改动。client tsc --noEmit + webpack 生产构建全绿。详见 `EQUIPMENT_DESIGN.md §14 E5 实现记录`。剩 关卡掉落 faucet·E6 洗练·E7 抽卡·E8 SLG·byUnit loadout·bone-slot 立绘续做 |
| 装备 E2 掉落 faucet + E6 洗练 | gifted-feistel-42c356 | ~~`claude/gifted-feistel-42c356`~~（已删） | ~~`.claude\worktrees\gifted-feistel-42c356`~~（已删） | ✅ **已合 main 并清理**（merge b1dfa131，2026-06-22）：**E2 关卡掉落 faucet**——`pveRewards.ts` `EquipmentDropConfig` + 12 个 Boss/精英关配置（Ch1-Ch6 lv5/lv10）；shared `makeDropInstance`（seededRng 确定性，三槽等概率）；`grantClearReward` 外部 roll + 满仓静默跳过 + `grantedEquipment` 回推；openapi `/pve/clear`+`/pve/verify` 增 `grantedEquipment?`。**E6 洗练 Reforge**——shared `REFORGE_MATERIAL_RARITY`+`rollReforgedAffixes`（保留主词条全量重 roll 副词条）；meta `reforgeEquipment`（三层校验+幂等抢占+rev 守卫原子写）+handler；openapi `POST /equipment/reforge`；client `ApiClient.reforgeEquipment`+`EquipmentScene` 选材 modal（开详情→检测素材→openReforgeSelect→confirmReforge→doReforge）+`createAppCore` 回调+埋点；i18n zh/en/de `equip.reforge*`+`equip.err.notReforgeEligible/invalidRarity`。client tsc --noEmit 全绿。详见 `EQUIPMENT_DESIGN.md §14 E2/E6 实现记录`。改了 @nw/shared/openapi/metaserver 公共依赖→其余 worktree 应 `rebase origin/main` 跟上。**剩 E7 抽卡/保护道具·E8 SLG 接入·byUnit loadout，续做重新 `git worktree add`** |
| S12-D 养成/合成 UI + judge 对齐 | jovial-noyce-4fc322 | ~~`claude/jovial-noyce-4fc322`~~（已删） | ~~`.claude\worktrees\jovial-noyce-4fc322`~~（已删） | ✅ **已合 main 并清理**（merge 5b5f0033，2026-06-22）：transport.proto `JudgeRequest.unit_levels` + gateway/meta/judgeRunner unitLevels 全链路透传；createAppCore goCampaign 传 unitLevels（S12 play 接线）；LevelPrepScene 重做（接口换 getUnitLevels/getCardInventory/tryMerge，渲染 T3/T6/T9 trait 徽章 + 合成按钮）；CollectionScene 加 `units` 三标签；client/src/game/balance/unitCards.ts 新增；i18n zh/en/de 各加 progression.*（11键）+ collection.tab.units。详见 META_TASKS S12-D |
| 远程投射物系统 | sharp-mccarthy-866e8f | ~~`claude/sharp-mccarthy-866e8f`~~（已删） | ~~`.claude\worktrees\sharp-mccarthy-866e8f`~~（已注销注册项，仅遗留物理目录待外部清——会话 cwd 锁定） | ✅ **已合 main 并清理**（merge cf418e77，2026-06-22）：弓箭手/箭塔从瞬时伤害改为**引擎级投射物**（落点结算·跟踪制导必中·蓝图显式 `projectile` 标记）。新增 `Projectile` 实体 + `ProjectilePayload` + `GameState.projectiles[]`；`CombatSystem` 抽出 `resolveAttackHit`（近战/落点共用，事件顺序不变→旧近战回放字节一致）+ `tickProjectiles`（定点 `isqrt` 追踪飞行）；伤害+暴击+溅射/穿刺/吸血/减速开火瞬间冻结进载荷；4 个新事件 `projectile_fired/moved/hit/expired` + 渲染 arrow 图层（沿用 `escort_moved` 范式）；config 弓兵/箭塔 14 格/s。真实玩法变化：射手开火后死亡箭仍飞、目标先死则箭 fizzle、双射手可 overkill。**`ENGINE_VERSION` 1→2**（远程时序变化使旧回放发散）。围攻经 `runHeadless` 跑同一引擎自动覆盖。顺带修预存失败：`runJudge` 失败路径 `statsJson:''` 是有意 shape，对齐 pve-judge/siege 两测试期望。仅改 client+server/engine+design，无 @nw/shared/openapi 公共依赖改动。引擎+client tsc 全绿、156 引擎相关测试绿。详见 `design/game/DESIGN.md §6b 投射物系统` + `BALANCE.md`。**可调：箭速 14 格/s；PvE 远程兵种加 projectile 即用（载荷已支持溅射/穿刺落点结算）** |

> 改并行线时同步更新本表（增删 worktree、状态变化）。

## 命令速查

```bash
# 新建一条并行线（基于 main，分支不存在时一并创建）
git worktree add -b feat/<slug> .claude/worktrees/<slug> main
# 已有分支，只挂目录
git worktree add .claude/worktrees/<slug> feat/<slug>

git worktree list                         # 看所有 worktree
git worktree remove .claude/worktrees/<slug>   # 删目录（工作树需干净）
git worktree prune                        # 清理失效记录

# 每条线日常保持跟 main 同步
git fetch origin && git rebase origin/main
```

## 注意

- worktree 共用同一个 `.git`，分支/历史/对象库全共享；磁盘只多一份工作文件。
- **同一分支不能被两个 worktree 同时检出**（git 会拒绝）。
- worktree 内 `npm install` 的 `node_modules` 各自独立（已 gitignore），首次进新 worktree 需各自装依赖。
