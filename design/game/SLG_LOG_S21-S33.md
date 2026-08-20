# SLG 实现记录 §21–§33（2026-06-30 ~ 2026-07-22）

> 从 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 拆出（2026-08-17，原文件 2011 行）。**小节编号沿用原文，不重新编号**——源码注释里的 `SLG_DESIGN_LOG.md §N` 引用照旧有效。
> 核心设计以 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 为准；分册总览见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)。
> 相邻分册：[`SLG_LOG_S34-S49.md`](SLG_LOG_S34-S49.md)（后续）。

---

## 21. 剩余工作总览（2026-06-30 盘点）

> 核心循环已闭合：落城 → 看图(迷雾/视野) → 占资源点(惰性产出) → 练兵 → 编布阵 → 行军(A*绕障) → 围攻(worldsvc 进程内引擎权威即时落地) → 易主/掠夺/残兵折回 → 加家族连地共守 → 宗门/联盟/立国 → 拍卖行 → 赛季结算大比 → 多大区分配 → 重置。承重墙（SLG11）+ 留存发动机（守不住→加家族）+ 视野/迷雾（G5）+ 险地（G8）+ 国民加成（G1）+ 繁荣度（G2）+ 材料统一（G4）+ 多 shard 运行时（G6）+ 赛季运维（G7 大部）全 ✅。
>
> 本节盘点**循环跑通后仍欠的部分**，按优先级。逐函数核对 `worldsvc`/`shared` 实现 + §15 缺口表 + §17.12 后续清单得出。

### 21.1 第一档——功能洞（影响经济循环完整性）

> **✅ 本档已清零（2026-07-02）**：R-1（主城内政/建筑）+ R-2（资源格渲染）两个功能洞均已实现并合 main。经济循环完整性不再有代码缺口，剩余全是规则补漏（§21.2）/ 运营规模化（§21.3）/ 数值调参（§21.4）。

| # | 缺口 | 现状 | 计划 |
|---|---|---|---|
| ~~**R-1**~~ | ~~建筑 / 主城内政系统整块缺失~~ **✅ CLOSED（2026-06-30~07-02）** | ~~worldsvc 唯一「建筑」是瞭望塔；无资源/军事/城防建筑；`troopCap` 死值；graphite/sticker 空转。~~ **已实现并验证**：[`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md) **P1（server 刀 `7da7e891` + client 刀 `9febdba0`）+ P2（`bcb48a9c` wall/cabinet/academy）全合 main**。`biomeAt` 三分→四分给 graphite 地图 faucet；stickerShop 自产 sticker faucet；4 资源建筑产率乘数 + cabinet 仓储 + drillYard troopCap 成长 + desk 门控 + buildQueue 调度 + coin 加速。CityScene 端到端接通（`createAppCore`/`WorldMapScene` Enter Desk）。 | **✅ 完成**。`city-buildings.e2e.test.ts` **8/8 real-Mongo 全绿（2026-07-02）**——faucet+sink 闭环经实测证实。数值仍 DRAFT（终态=上线后实测对账，§21.4）。 |
| ~~**R-2**~~ | ~~资源格地图渲染未接入~~ **✅ CLOSED（2026-06-30，commit `b8b726c0`）** | ~~地图资源点仍是程序色块。~~ **已实现**：`resAtlasLoader.ts`（懒加载图集，色块兜底）+ `WorldMapScene.drawResMotif`（L1）= 母题加载 + 丰度轴（lv1→4 精灵成簇）+ 守备轴（lv4+ 栅栏 / lv7+ 桩 / lv8–10 红角）+ 10 级合成；5 母题全就位（2026-07-01）。 | **✅ 完成**（client `tsc --noEmit` 全绿 2026-07-02）。L2/L3 仍走色块占用层（按设计，非缺口）。 |

### 21.2 第二档——规则 / 体验补漏

| # | 缺口 | 现状 | 计划 |
|---|---|---|---|
| ~~**R-3**~~ | ~~联盟「禁止进攻/夺地」战斗约束未实现~~ **✅ CLOSED（2026-07-02）** | ~~§18.7 只做了黄描边标记；理论上能打盟友地。~~ **已实现**：`startMarch` attack 分支新增 `friendlyAccountIds`（自己 + 本家族 + 本宗门全家族 + 联盟宗门 `allySectIds`）拦截 → 命中抛新错误码 `ALLY_TILE`（403）。范围比原计划宽：不止联盟宗门，连本家族/本宗门也纳入（只挡联盟而放任同宗门互殴会自相矛盾）。检查置于保护罩校验之前。 | **✅ 完成**。`shared`+`worldsvc` `tsc -b` 全绿；新增 `alliance-attack.e2e.test.ts` **6/6 real-Mongo 全绿**（联盟/家族/同宗门基地 → ALLY_TILE；非联盟敌方过友军闸→PROTECTED；保护罩过期后进攻真启动；解盟后前盟友可打）。既有 e2e 无回归。 |
| **R-4** | **国民加成数值未调参** | G1 已落地（`NATION_BONUS_PRODUCTION=0.10`/`DEFENSE=0.15` 生效），但数值未过经济/战力模拟实测平衡。 | 随 §16.5 数值批次 + 经济模拟。 |

### 21.3 第三档——运营 / 规模化专项（赛季正交，可延后）

| # | 缺口 | 现状 |
|---|---|---|
| ~~**R-5**~~ | ~~赛季中主动转区 / 合区（人口骤降合并低活 shard）~~ | ✅ **已设计+落地（2026-07-16）**：§28，个人转区（`POST /world/season/transfer`）+ 运营合区（`POST /admin/world/merge`）。 |
| **R-6** | 赛季元数据下发 | §20.8：`CURRENT_SEASON` 暂客户端常量；待 S11 天梯赛季打通后由 metaserver 下发（SLG 赛季是否与天梯同步另议）。 |
| ~~**R-7**~~ | ~~异常交易审计 ops 前端 + 自动处置~~ | ✅ **已落地（2026-07-16）**：§17.13，ops 前端审计页 + 确认违规后自动封禁（不含追缴）。 |
| ~~**R-8**~~ | ~~商品价格可调后台~~ | ✅ **已落地（2026-07-13）**：G7，admin `slg.shop.manage` + ops `pageSlgShop`，见 G7 行 / OPS_DESIGN §4.2/§8。 |
| **R-9** | `resolveShardForJoin` / march 调度单点 | §20.8：高并发开服经 worldsvc 单进程，规模化需选主/分片（U12 压测后）。 |

### 21.4 第四档——DRAFT 数值（待经济模拟统一过一遍）

> **核验方法权威 = [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)**：定义这批数怎么核（6 条轨道：持久经济聚合 / 赛季资源 / 围攻 difficultySim / 分区方差 / 节奏可达性 / 运维容量）、判据、签字人、登记到 §13-SLG 的流程。下面只是清单。

- 繁荣度权重 `PROSPERITY_W_*`/`PROSPERITY_DECAY_PER_DAY`、建宗门门槛 `SECT_FOUND_PROSPERITY_MIN`；`SETTLE_REWARDS` 各档材料/皮肤量 + `CENTER_CAPITAL_MULT`；`sectStrengthScore` 权重；`WORLD_CAPACITY`/`RESET_DELETE_BATCH`；险地 `STRONGHOLD_*` 密度/守军/奖励；碾压级廉价结算阈值（U7）；围攻满血容量表/兵种当量/时限（§16.5）。
- **进度（2026-07-02）**：A/B/C/D/E/F 六轨均已过 econ-sim 核验（`server/tools/econ-sim/`，SLG_ECONOMY_CHECK §9，常量未动、终态待上线实测）。**险地轨已补建并跑出唯一实质缺陷**：`SLG_GEN.stronghold*` 生成参数使险地数种子间 0→6,436、聚成 blob、持久 `binding` 掠夺破 15% 稀释——建议生成层换逐格哈希（[§13-SLG-STRONGHOLD](ECONOMY_VERIFICATION_LOG.md)）。**这是 R-4 剩的唯一 actionable 项**：一个独立的 `@nw/shared` 生成修复（merge-first），非纯调参。
- settle 若发 coin（>0）须经经济总预算批准（SEASON_OVERVIEW §3.3）。
- 全部 → [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) §13-SLG 登记后统一模拟调参。

### 21.5 优先级建议

1. ~~**R-1 建筑系统** / **R-2 资源格美术接入** / **R-3 联盟攻击约束**~~ **✅ 三者均 CLOSED（2026-07-02）**——功能洞档 + 唯一功能性规则缺口均已清（R-1: P1+P2 合 main + e2e 8/8；R-2: `b8b726c0` 母题渲染 + client tsc；R-3: `friendlyAccountIds` 友军拦截 + e2e 6/6）。**已无功能/规则代码缺口。**
2. **R-4 数值调参**：现在是最高优先剩项——city / 国民加成数值仍 DRAFT（§21.4），须经济模拟批处理，非代码洞。
3. **R-5~R-9**：运营/规模化，赛季正交可延后。

---

## 22. 宗门功能修复：worldsvc 家族镜像死集合清理（2026-07-01）

**背景**：P4 家族→socialsvc 迁移（2026-06-29）删除了 worldsvc 本地 `familyService.ts`（写入方），但 `sectService.ts`/`service.ts`（约 40 处调用点）仍在读写 worldsvc 自己的 `families`/`familyMembers` 集合（`db.ts` 旧定义）。由于没有任何生产代码路径再向这两个集合写入数据，**宗门创建/加入/退出/发言/联盟/罢免全部在生产环境静默失效**（族长权限检查恒 `NOT_IN_FAMILY`），同族视野共享、出生点找同族、A* 同族通行门、宗门长阵亡惩罚扇出、赛季结算按宗门聚合、G6 跨赛季分片分配也同样静默降级为「视同无家族」。详细排查过程见 `SOCIAL_SVC_DESIGN.md` §6「宗门功能修复」。

**修复方案**：删除 worldsvc 本地 `families`/`familyMembers` 集合（`FamilyDoc`/`FamilyMemberDoc` 类型一并删除），改为：

1. 家族身份/名册/族长权限查询 → worldsvc 通过 `WorldSocialsvcClient` 实时调 socialsvc 新增内部接口（`getMember`/`getFamiliesByIds`/`getFamiliesBySect`）。
2. 同世界内成员定位（视野共享/出生点/A*同族门/罢免惩罚扇出）→ 改用 `PlayerWorldDoc.familyId`（SS7 镜像）按 `worldId+familyId` 查询，不需要新集合。
3. `sectId` 归属 → worldsvc 仍是权威写者（宗门保留在 worldsvc，赛季级概念不变），但写回 socialsvc 的 `FamilyDoc.sectId` 镜像字段（新增 `POST /internal/family/:familyId/sect`），供客户端 `fam.sectId` 读到。
4. 繁荣度/活跃度 → 委托 socialsvc 新增的 `/internal/family/:familyId/prosperity/refresh`（worldsvc 只算 `territoryCount`）与既有的 `/internal/family/activity`（此前从未被调用）；赛季重置新增 `/internal/family/:familyId/slg-reset` 一次性清零。

**影响文件**：`server/socialsvc/src/{db,familyService,httpApi}.ts`、`server/worldsvc/src/{db,socialsvcClient,prosperity,sectService,service}.ts`、`server/worldsvc/test/sect.e2e.test.ts`（fixture 改用内存假 socialsvc client）、`client/src/scenes/SectScene.ts` + `client/src/app/createAppCore.ts`（恢复 `fam.sectId` 读取路径）、`client/src/net/WorldApiClient.ts`（`FamilyView` 补 `sectId?`/`territoryCount?`）。

**未变**：宗门本身（`SectDoc`/`sects`/`sectMessages` 集合）仍留在 worldsvc（SS6 不变）；家族身份/成员关系（谁在哪个家族）跨赛季保留在 socialsvc，不受 SLG 赛季重置影响。

---

## 23. 客户端「创建家族后未切换成员态」修复（2026-07-04）

**背景**：§22 迁移后，`PlayerWorldDoc.familyId` 被明确定义为「入世界时一次性写入的只读镜像」（`territory.ts` `joinWorld()` 注释：subsequent family changes are not written back，客户端应改读 `/social/family/mine`）。但客户端三处仍直接读 `WorldApiClient.getMe(worldId)` 返回的 `familyId` 来判断「是否已加入家族」：`app/nav/social.ts` 的 `loadSLGStatus()`（好友页「家族」tab）、`FamilyScene.ts`（家族主界面）、`SectScene.ts`（宗门界面）。凡是「先进过 SLG 地图（已产生 `playerWorld` 文档）、后创建/加入家族」的玩家，镜像永不刷新，三处 UI 全部卡在「未加入任何家族」，即使 socialsvc 一侧家族已建成。

**修复**：`WorldApiClient` 新增 `getMyFamily()`，直连 socialsvc `GET /social/family/mine`（权威实时数据，不经 worldsvc 镜像）；`listFamilies()` 改为委托它。上述三处调用点全部改用 `getMyFamily()` 判断家族状态，不再读 `getMe().familyId`。

**测试**：`client/test/world-family-status.test.ts` 钉住该契约——`getMyFamily()`/`listFamilies()` 的请求/返回行为，以及一条回归用例：模拟「`/world/me` 镜像未更新但 `/social/family/mine` 已知晓」的场景，断言 `getMyFamily()` 全程不会调用 `/world/me`。

**影响文件**：`client/src/net/WorldApiClient.ts`、`client/src/app/nav/social.ts`、`client/src/scenes/FamilyScene.ts`、`client/src/scenes/SectScene.ts`、`client/test/world-family-status.test.ts`（新增）。

---

---

## 24. 地图模板与编辑器（2026-07-05 拍板；ADR-034 代码重写已完成 2026-07-05）

**背景**：`server/shared/src/slg.ts` 已按 ADR-034「角度扇区+地形+城池」模型整体重写（`provinceIdxAt()`/`provinceCapitalPositions()`/环形地形带+墨河弦+支脉/州府+世界中心+关隘城池+分级城池节点/按环等级分布表，替换旧的 `CAPITAL_FRACTIONS`/`NATION_KIND_BY_IDX`(hegemony→core)/`proceduralTile()`/`nearestCapitalIdx()`），worldsvc 受影响的消费方（`core/kernel`/`core/nation`/`core/yield`/`combatSiege`）与 e2e 测试已同步修完，`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+test 全绿。城池驻军/耐久数值、资源州/核心州分级城池梯度、`tools/map-editor` 编辑器工程本身仍是开放项，留后续任务（见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §5/§6）。本节继续记录地图存储/编辑器架构，供编辑器工程落地时遵循。

**两层分离**：
- **Layer A「地图模板」（设计期产物，低频改动）**：程序生成的原始地形/城池布局只是初稿，不一定符合要求，允许人工在编辑器里精修定稿——这是权威数据源，不是运行时状态。
- **Layer B「世界实例状态」（运行时，高频改动）**：占领/建筑/驻军等玩家行为，沿用现有的稀疏 `TileDoc` 覆盖机制（S8-0 起就有），只是覆盖对象要从「程序生成结果」改成「引用某个 `templateId` 的模板基线」。

**Layer A 落地方案**：
- 模板做成**按格子可寻址的集合**（类似 TileDoc 但用于模板而非运行时）。
- **首包生成走服务器端**：admin 加一个「生成模板」endpoint，内部按 size 跑 `proceduralTile()` 批量写入模板集合种子数据；`proceduralTile()` 之后只用于这个一次性种子生成，不再作为运行时合并路径。
- **编辑器工作流**：每次打开从数据库取最新地形（不是每次重新生成，也不是本地文件）；保存时**只上发本次改动的格子（diff）**，做 upsert，不整图重传。
- **多尺寸模板并存**（现 1500×1500，ADR-049 起从 500×500 放大）：模板集合按 `templateId`（含 size/版本）区分；一个 world 实例创建时引用某个 `templateId` 作为地图基线。
- **删除接口**：需要，但要挡一个安全检查——不能删除当前被设为「创建新世界用」配置的 `templateId`；已创建的历史世界实例不受影响（见下一条克隆语义），删除顾虑只针对「未来创建会引用」这一种。
- **关键：世界创建时对模板是"克隆"而非"实时引用"**：worldsvc 创建世界实例时把模板整份**拷贝**成该实例自己的基线数据，之后编辑器再改模板**不会回溯影响已经在跑的世界**（不会出现玩家脚下地形突然变化），只影响此后新建的世界实例。
- **编辑器需要「模板列表」接口**：按 size/templateId 选择打开哪一份模板，不能假设只有一份。
- **Endpoint 归属**：放 **admin** 后端（员工态工具面，非玩家态 meta REST），职责与 ops 后台一致。
- **并发编辑冲突不做锁**：内部工具、使用人少，接受"后保存者覆盖"的风险，暂不上锁机制。

**落地状态（2026-07-05，本节 endpoint 已实现）**：

- **数据**：模板归属 worldsvc 自己的库（`mapTemplates` 元数据 + `mapTemplateTiles` 逐格），不归 admin 库——admin 只做代理+审计，与现有 season ops（`WorldMixin` 代理 `/admin/world/*`）同一套路。`mapBaselines`（按 `worldId` 克隆出的世界基线）也建在 worldsvc。
- **worldsvc 内部 endpoint**（`X-Internal-Key`，`server/worldsvc/src/httpApi.ts` `/admin/world/map-templates/*` 分支，独立于 `worldId` 必填门禁）：`GET /admin/world/map-templates` 列表、`POST .../generate` 生成种子、`GET/PUT .../{id}/tiles` 读viewport/diff存、`POST .../{id}/activate` 设为创建新世界用、`DELETE .../{id}` 删除（激活中的拒绝）。业务逻辑在新增的 `server/worldsvc/src/mapTemplateService.ts`。
- **克隆时机**：`/admin/world/open` 处理完 `svc.openSeason()` 后，立即调用 `mapTemplateSvc.cloneActiveTemplateInto(worldId)`——没有激活模板时是空操作，不改变现有行为。
- **admin 代理**：`server/admin/src/service/mapTemplates.ts`（新 mixin，接入 `service.ts` 装配链）+ `httpApi.ts` 新增 `/admin/slg/map-templates/*` 路由（JWT + `slg.map.view`/`slg.map.manage` 两个新权限点，写操作全部走 `audit()`）。
- **已知限制，非本次范围**：
  1. `proceduralTile()` 目前仍硬编码 `SLG_MAP_W`×`SLG_MAP_H`（模块级 Voronoi 首府预计算），`generateTemplate()` 因此实际上只能正确生成当前固定尺寸；"多尺寸模板并存"在 schema/CRUD 层已经就位（`templateId`+`width`/`height`已入库），但要等 ADR-034 重写把 `proceduralTile` 参数化到任意尺寸后才能真正生成第二种尺寸。
  2. ~~`mapBaselines` 只是被写入，读取路径尚未接入~~——已接线（2026-07-06）：`WorldCoreMap.getMap`/`getTile`（`server/worldsvc/src/core/map.ts`）在 TileDoc 未命中时先查该世界的 `mapBaselines`（键 `worldId:x:y`）作为地形基线，只有无基线行时才回退 `proceduralTile()`。`getMap` 沿用 viewport bbox 批量拉基线（与 tiles 拉取同形状，不走逐格查询）；`getTile` 单格 `findOne` 与 override 并行取。视野/迷雾门控不变（地形层从不被雾隐藏）。这样编辑器发布并激活的模板改动（画的河/山、移动的城池），经世界开局克隆后即在运行时地图可见。e2e 见 `server/worldsvc/test/map-template.e2e.test.ts`（已被克隆世界的改动可读回；无基线世界回退 `proceduralTile`）。art-parity 的 `obstacleKind`（river/mountain 美术区分）已随本次一并打通端到端：`MapTemplateTileDoc`/`MapBaselineTileDoc` 加字段，`mapTemplateService` 四处 doc 映射（generate/getTiles/saveTilesDiff/clone）+ `core/map.terrainView` + `WorldTileView` + `openapi-world.yml`（含 worldsvc/client 两侧 codegen）全部带上；客户端 `WorldMapRenderer` 改为**优先用服务端 tile.obstacleKind**，只有服务端没给（无基线行）才回退本地 `proceduralTile`——修正了原先"障碍恒为程序化、无需过网"的假设（基线编辑后该假设不成立）。日后若再给 `MapTemplateTile` 增地形字段，按同一条链补齐即可。
  3. ~~编辑器前端（真正的地图编辑 UI 工具）尚未开工~~——已接线（2026-07-05，见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"栅格化 + 发布到服务端模板"/"模板列表 + Activate/Delete"）：`tools/map-editor` 新增 `src/api.ts`（Bearer token 登录）调用本节列出的全部 6 个 endpoint（list/generate/get-tiles 未用/save-tiles-diff/activate/delete）。编辑器侧的地形格子（2026-07-06 起河流/山脉是直接格子笔刷，不再是矢量路径——见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8"矢量路径笔刷改为直接格子笔刷"）/城池图层通过 `server/shared/src/slg/mapEdit.ts::rasterizeMapEdits()` 一次性栅格化成 tile diff 再发布——单向烘焙，不做"从模板读回图层"的反向同步（模板存储不区分"原始生成值"和"编辑覆盖值"，物理上无法可靠反推）；模板列表面板目前只展示元数据（`getMapTemplateTiles` 的 viewport 读取暂未接线，非当前需要）。**2026-08-19 修正**：城池不再只烘焙成 tile——Publish 现在**另外**上传整份城池点节点表（`PUT .../{id}/cities` → `MapTemplateDoc.cities` → 开服克隆进 `WorldDoc.cities` → 随 `POST /world/enter` 下发给客户端精灵层）。tile 只是城下面的地，节点表才是「城堡画在哪」的依据；原先精灵层本地重算 `allCityNodes(worldId)`，拖过的城地面挪了城堡没挪。同时新增 `rasterizeMapEdits(..., { citiesAreComplete: true })`，把腾空的程序化城池锚点还给地形。详见 [`SLG_LOG_2026-08.md` 2026-08-19 城池节点条](SLG_LOG_2026-08.md)。
  4. **✅ 2026-07-27 存储重设计（行程编码，2026-07-27 Mongo/Redis 审计中期项第 2 项）**：本节 992 行原设计"逐格可寻址集合"在 1500×1500（ADR-049）尺度下意味着 `generateTemplate()` 一次性物化 225 万文档（`mapTemplateTiles`），`cloneActiveTemplateInto` 每次开服/重置又把这份稠密数据原样搬一遍到 `mapBaselines`（再 225 万条）——真正的病根是"首包生成即物化"这条 992 行当初拍板的设计，不是克隆本身。地形有大量连续同值的横向条带（河/山是连续带，资源/中立地块之间只稀疏散落特殊格），于是改行程编码（RLE）：`server/shared/src/slg/mapRle.ts` 新增 `encodeRow`/`decodeRow`/`tileAtX`/`sliceRuns`/`applyEditsToRow` 纯函数；存储从"每格一个文档"改成"每**行**一个文档、行内一组 `{x0,x1,type,level,resType?,obstacleKind?}` 压缩区间"——集合改名 `mapTemplateTiles`→`mapTemplateRows`、`mapBaselines`→`mapBaselineRows`（**改名而非原地换 shape**：旧文档 `_id` 是 `id:x:y`、新文档是 `id:y`，同名同 collection 里新旧格式共存会让新代码的 `{worldId,y:范围}` 查询意外命中旧的稠密文档而在解 `.runs` 时崩——用新集合名彻底避免这个陷阱）。外部契约（`MapTemplateTile` 单格 `{x,y,type,level,...}`、`getTiles`/`saveTilesDiff` 的 API 形状、`tileCount` 统计口径）完全不变，压缩/解压全部封装在 `mapTemplateService.ts`/`core/map.ts` 内部——读路径本来就是 viewport 批量查询（不是逐格 N+1），只是查询维度从"按 x+y 范围"简化成"按 y 范围"，行内 x 范围在内存里切片。迁移脚本 `server/worldsvc/scripts/migrateMapBaselinesToRle.ts`（幂等、可重跑，**不删旧集合**，留給 ops 确认新集合读取正常后手动清理）——若从未真正激活过自定义模板（`mapBaselines`/`mapTemplateTiles` 本来就是空的），无需迁移，新代码在"无激活模板"分支下行为不变。验证：`server/shared/test/mapRle.test.ts`（14 例，纯函数覆盖）+ `server/worldsvc/test/map-template.e2e.test.ts`（9 例，重写了直接查裸集合形状的断言，新增一条"10×10 模板只落地 10 行文档而非 100 个格子文档"的回归锁定）；shared 647/647、worldsvc 341/341 全绿。

---

## 25. WorldMapScene HUD 重排（2026-07-05 拍板+落地）

**背景**：现状底部 `HUD_H` 横栏把返回/缩放/状态文字/行军列表/Train/Family/Auction/World-info 全部平铺成一整条，纯文字堆砌、按钮风格不统一，且早期孤立据点视野内几乎全是空地，底栏又占满全部横向空间——判定为整体重排而非局部修补。

**新布局**（四区，取代原单一横栏）：

| 区域 | 内容（自上而下/自外而内） | 取代的旧元素 |
|---|---|---|
| 左上（浮层） | Back（`SceneHeader.drawFloatingBackButton`，`§3.1` 统一返回按钮迁移，2026-07-05 与本节并行落地）→ Zoom → Auction 竖排，后两者紧贴在 Back 下方 | 原 backRect（原底栏自绘）+ zoomBtnRect（原左上）+ aucBtnRect（原右下） |
| 右上竖排 | 状态卡（部队/领地/资源，卡片化分组）→ 行军角标（默认收起，点开展开列表）→ World/info | 原资源行文字平铺 + 常驻 Marches 表头/列表 + infoBtnRect |
| 底部 | 常驻聊天条（点击展开 FriendsScene 世界频道），也是家族管理入口 | 无（新增，原底栏无聊天入口） |
| 点击主城弹窗 | 进城 / **训练**（新增）/ 防御 / 编队 | 原 HUD 常驻 `trainBtn`（`openTrainPanel()` 改由此处触发） |

**拍板要点**：
- 左右分区心智模型：**左=离开当前视图去做别的事**（返回、缩放档位、拍卖行），**右=留在原地看状态**（部队/领地/资源/行军/世界信息）。
- **Family 按钮整体删除**——查证 `FriendsScene`（`orgForm.ts` `drawFamilyTab`）已有该逻辑：玩家已加入家族时自动 `cb.openFamilyHub?.()` 跳转到独立的 `FamilyScene`（成员/宗门内政管理）；未加入时展示创建/加入表单。即家族聊天 tab 本身就是家族管理的唯一入口，无需在世界地图额外开一个入口。
- **Train 从常驻 HUD 移除**，改挂到点击自家主城时已有的弹窗（`WorldMapInput.ts` 的 `isBase` 分支，进城/训练/防御/编队四项）——训练本就是主城行为，不该占永久屏幕面积。
- 地图空地问题（孤立据点四周大片空白）判定为**地图内容/装饰密度问题，非 HUD 布局问题**，本次不处理；若要改善需从中立地块程序化装饰密度或初始镶机位偏移入手，留后续任务。

**落地状态（2026-07-05，已实现）**：
- `client/src/scenes/worldmap/constants.ts`：`HUD_H` 100→56（底栏只剩聊天条，地图可视区相应变大）。
- `client/src/scenes/worldmap/WorldMapPanels.ts`：`renderHud()` 重写为四区绘制；`aucBtn`/`zoomBtn` 挪到左上、紧贴 `ctx.backRect`（读取其 y+h 做垂直接续，不硬编码坐标）；状态卡/行军角标改为卡片化子面板（`marchBadgeRect` 命中后走 `ctx.marchesExpanded` 布尔开关展开/收起列表）；底部聊天条渲染（当前只有静态文案，**末条消息/未读数预览仍是占位，未接数据**，留后续任务）。
- `client/src/scenes/worldmap/WorldMapInput.ts`：删 Train/Family 命中分支；新增 `marchBadgeRect` 切换 + `chatBarRect` 命中 → `cb.onOpenChat()`；`isBase` 分支弹窗加「训练」项直接调 `panels.openTrainPanel()`。
- `client/src/scenes/worldmap/WorldMapContext.ts`：`onOpenFamily` → `onOpenChat`；删 `famBtnRect`/`trainBtnRect`，加 `marchBadgeRect`/`chatBarRect`/`marchesExpanded`。
- `client/src/app/nav/world.ts`：`onOpenChat()` 调 `nav.goFriends({ defaultTab: 'world', onBack: () => goWorldMap(...) })`——返回时回到世界地图而非大厅。
- `client/src/app/nav/social.ts` + `client/src/app/appCtx.ts` + `client/src/scenes/FriendsScene/base.ts`：`goFriends`/`FriendsSceneCallbacks.defaultTab` 从 `'friends' | 'mail'` 放宽到完整 `Tab`（`'friends' | 'family' | 'sect' | 'world' | 'mail'`）+ `goFriends` 新增可选 `onBack` 覆盖（默认仍是 `nav.goLobby()`），使世界地图能指定"返回世界地图"而非硬编码回大厅。
- i18n 新增 `world.chat`（zh/en/de 三语）；`world.family` key 保留未删（其他场景仍可能引用，只是世界地图不再用它做按钮文案）。**2026-08-16 更正**：审计逐一核过，其他场景并没有引用它，已连同另外 138 个死 key 一并删除（见 `UI_DESIGN.md` §33）。
- **跟 §3.1 撞车**：本节开发期间，另一次改动（commit `f3e237ce`）恰好也在同步把 WorldMapScene 的返回按钮从底栏自绘迁移到 `SceneHeader.drawFloatingBackButton`（统一 22 个场景的返回按钮规格），两者改的是同一批文件（`WorldMapContext.ts`/`WorldMapPanels.ts`）。两次改动语义不冲突（各改各的字段），已核对合并后 `tsc --noEmit` + `webpack --mode production` 全绿，未丢内容。
- **两个已知缺口已收尾（2026-07-05）**：
  - 聊天条接数据：`WorldMapNet.refreshWorldChat()`（新增，随 5s march 轮询一并调用，`worldApi.getWorldChannel(worldId, {limit: 20})`）把最新一条消息存到 `ctx.worldChatLatest`；未读数用客户端本地"已读水位"计算——`WorldMapContext.markWorldChatSeen()` 把 `worldChatLatest.ts` 写入 `localStorage`（key 按 `worldId+accountId` 隔离，避免多号共享已读位），点击聊天条（`WorldMapInput.ts`）时调用；`renderHud()` 显示 `发送者: 正文前28字` + 超过已读水位的条数角标（封顶 `9+`）。未走服务端已读接口，因为 worldsvc 目前没有为世界频道维护已读状态（对比 `mail.unread` 是服务端字段）——纯本地近似,足够 HUD 预览用途。
  - 行军列表数量上限：`renderHud()` 里加 `MAX_VISIBLE_MARCHES = 5`，超出部分显示 `+N more`（新 i18n key `world.marchMore`，zh/en/de 三语），面板高度按可见行数算，不再随行军数无上限增高。

**World-info 弹层（国家/商城 Tab）列表滚动（2026-07-13）**：

**背景**：`WorldMapPanels.renderInfoPanel()` 的国家 Tab（`ctx.nations`）和商城 Tab（`ctx.shopItems`）此前平铺渲染、面板高度写死，超出可视区的条目直接跳过渲染（`if (ly > bodyBottom) break`）——列表一长就看不到、也点不到后面的条目。

**方案**：PIXI mask + 拖拽/滚轮双输入，未引入独立的可复用 `ScrollList` 组件（沿用本项目"每个场景各自实现"的惯例，参考 `FriendsSceneBase.scrollRegion()`/`AuctionScene` 的 `scrollY`+拖拽模式，但额外加了 mask 做像素级裁切，前两者都没有）：
- `WorldMapPanels.beginScrollList(x, y, w, h, contentH)`：新增辅助方法，建一个 `PIXI.Graphics` 遮罩 + 一个 `mask` 过的 `PIXI.Container`，同时把可视区矩形写入 `ctx.infoScrollRect`、算出 `ctx.infoMaxScroll = max(0, contentH - h)` 并 clamp 当前 `ctx.infoScrollY`。国家/商城两个分支各自在这个 container 里画行（含 icon/文字/按钮），只渲染与可视区有重叠的行。
- `WorldMapPanels.panelButtonIn(layer, ...)`：`panelButton()` 的变体，按钮画进传入的 scroll layer 而非直接进 `modalLayer`，命中矩形仍推入全局 `ctx.modalBtnRects`（与遮罩范围无关——如果一行按钮恰好卡在可视区上下边界被半裁切，其命中区域理论上仍可能有几像素落在裁切掉的空白处被点到；这跟 `AuctionScene`/`FriendsSceneBase` 现有列表的行为一致，未特殊处理，可接受）。
- 切 Tab（`nations`/`season`/`shop`）、每次 `openInfoPanel()` 时都把 `ctx.infoScrollY` 重置为 0；`closeModal()` 里把 `ctx.infoScrollRect` 清空，避免关闭弹层后残留的命中矩形误吞下一次点击。
- **拖拽输入**：`WorldMapContext` 新增 `infoScrollRect`/`infoScrollY`/`infoMaxScroll`/`infoScrollDragging`/`infoScrollDragMoved`/`infoScrollDragStartY`/`infoScrollDragStartScroll`。`WorldMapInput.handleDown()` 在 `modalDimRect` 分支里，命中 `modalBtnRects` 之后、`closeModal()` 之前，新增"落点在 `infoScrollRect` 内则开始拖拽"的判断（否则原逻辑——点弹层空白处关闭——保留）；`handleMove`/`handleUp` 顶部各加一段 `infoScrollDragging` 分支，按住上下拖动换算并 clamp 新的 `infoScrollY`，触发 `renderInfoPanel()` 重绘。
- **滚轮输入**：项目里此前完全没有滚轮支持（`InputManager` 只有 down/move/up）。新增 `InputManager.onWheel`/`_emitWheel`，`WebAdapter` 监听 canvas 的原生 `wheel` 事件转发（微信小游戏没有鼠标滚轮，这条只在浏览器生效，触屏走上面的拖拽路径，两端都能用）。`WorldMapScene` 订阅 `input.onWheel` 转发到新增的 `WorldMapInput.handleWheel(x, y, deltaY)`，同样只在落点位于 `infoScrollRect` 内时生效。
- 验证：`tsc --noEmit` + `webpack --mode production` 全绿；用临时调试钩子（`app.ts` 挂 `globalThis.__NW_WorldMapPanels`/`__NW_WorldMapInput`，验证后已移除）直接构造假 `ctx`（20 条国家 / 15 件商品）单测 `renderInfoPanel()`，截图确认顶部/底部裁切干净、无溢出面板；再直接调用真实的 `WorldMapInput.handleWheel()`/`handleDown+handleMove+handleUp` 驱动滚动，截图确认滚轮和拖拽都能正确改变 `infoScrollY` 并触发重绘。
- 回归测试：`client/test/ui/worldMapInfoScroll.ui.ts`（`npm run test:ui`，PIXI headless）——手搭一个只含 `renderInfoPanel`/`handleDown/Move/Up/Wheel` 实际读取字段的假 `WorldMapContext`（不构造完整 `WorldMapScene`，省去 tile cache/net/zoom 依赖），覆盖：滚动区域随内容量的建立/不建立（国家 20 条 vs 2 条、商城 15 件、Season Tab 无滚动区）、内容变短后 `infoScrollY` 重新 clamp、滚轮在区域内/外的移动与双向 clamp、拖拽滚动 + 阈值内不触发、区域内点按不误关闭弹层 vs 区域外点按仍正常关闭（回归此前"点列表任意空白处关闭弹层"的旧行为）、`closeModal()` 清空 `infoScrollRect`、切 Tab 重置 `infoScrollY`。共 15 例，随 `npm run test:ui` 全绿一并跑通。**副带修复**：`test/ui/scenes.ui.ts` 此前在本机因 `@nw/shared` 桶文件（`index.ts`）连带引入 `jsonwebtoken`/`mongodb` 等仅服务端依赖而在 Vite 转换时报 "Failed to load url" 直接挂掉（[[client-run-and-visual-verify]] 已记录的已知环境缺口）；本次把 `server/node_modules` 第三方包（非 `@nw/*`）整体 junction 进 worktree、`@nw/shared`+`@nw/engine` 单独 junction 回 worktree 自身源码目录后一并修好，`scenes.ui.ts` 77 例、`test:ui` 全套 18 文件 241 例、默认 `npm test` 76 文件 594 例均转绿。

**顶部改为完整 SceneHeader 标题栏（2026-07-13）**：

**背景**：关卡（`CampaignMapScene`/`LevelPrepScene`）已用 `SceneHeader.drawSceneHeader()` 的完整标题栏（含默认 `sceneHeaderHeight(h)` 高度），SLG 世界地图之前只用最轻量的 `drawFloatingBackButton()`（裸返回按钮胶囊，无栏体/无标题），三个"也需要通用功能"的场景（对战/关卡/SLG）里关卡已经统一、SLG 还没有。战斗场景（`GameScene`/`HUDView`）交互模型是暂停/退出而非返回、顶部内容是实时倒计时/敌方血条而非静态货币快照，判定为继续保持自绘（不套 SceneHeader）。

**改动**：
- `WorldMapRenderer/build.ts`：`drawFloatingBackButton` 换成 `drawSceneHeader(topLayer, w, h, t('world.title'), { accent: HEADER_ACCENT.slg })`——标题栏高度用与关卡完全相同的 `sceneHeaderHeight(h)`（12% 屏高），accent 用已预留的 `HEADER_ACCENT.slg`（红色，SLG/竞技类目）。`WorldMapContext` 新增 `topInset` 字段记录这个高度。
- 地图可视区、相机居中/夹取（`viewport.ts` 的 `viewportCenter`/`setZoom`/`centerAt`/`clampPan`）、地图裁切遮罩（`build.ts` 的 `mapClip.mask`）、Loading 遮罩转圈中心点全部从"从 y=0 到 h-HUD_H"改成"从 topInset 到 h-HUD_H"，否则相机会把地图内容居中/停靠到实际被标题栏遮住的那条带里。
- `WorldMapInput.ts`：开始拖拽 / 松手判定点击瓦片的两处 `y < h - HUD_H` 判断加上 `y > topInset` 下界，避免点在标题栏范围内的点按穿透到地图瓦片（原浮层返回按钮不挡地图交互，现在整条标题栏是不透明纸面，得同步收紧命中区）。
- `WorldMapPanels.renderHud()`：右上角状态卡/行军角标/World-info 竖排原来固定从 `y=8` 起画，现在改成 `topInset + 8`——否则会被新标题栏整个盖住。左上 Zoom/Auction 竖排本来就用 `ctx.backRect.y + backRect.h` 接续，`drawSceneHeader` 返回的 `backRect.h` 现在是整条标题栏高度而非胶囊高度，天然接在标题栏下方，未改代码。
- 验证：`tsc --noEmit -p tsconfig.test.json` + `webpack --mode production` 全绿；用临时调试钩子（`app.ts` 挂 `globalThis.__NW_APP`/`__NW_SceneHeader`/`__NW_WorldMapPanels`，验证后已移除）单独构造假 `ctx` 调 `drawSceneHeader`+`WorldMapPanels.renderHud()`，截图确认标题栏高度与关卡一致、右上状态卡/左上 Zoom-Auction 都清晰落在标题栏下方、无重叠。
- 回归测试：`client/test/worldMapCameraTopInset.test.ts`（纯逻辑，走默认 `npm test`，`ViewportMixin` 混进一个不依赖 `@nw/shared` 的假 base 类以避开默认 vitest 配置的 game-logic-only 别名范围）5 例，覆盖 `clampPan`（小地图居中到 `[topInset, bottom]` 中点、大地图夹到 `[topInset, bottom]` 而非 `[0, bottom]`）、`centerAt`、`viewportCenter`、`setZoom` 四处相机数学在 `topInset` 变化时确实跟着变（而非被悄悄忽略）。`client/test/ui/worldMapHeaderInset.ui.ts`（PIXI headless，走 `test:ui`）7 例，覆盖 `WorldMapInput` 的拖拽起始/点击判定在标题栏范围内（`y<topInset`）不再穿透到地图、`WorldMapPanels.renderHud()` 右列状态卡随 `topInset` 等量下移。随 `npm test`（78 文件 603 例）+ `npm run test:ui`（20 文件 261 例）全绿一并跑通。

**标题栏改为资源产量 + 拍卖行移至右上角（2026-07-14）**：

**背景**：标题栏此前只显示静态的 `world.title`（"大世界"文案），信息密度低；拍卖行入口则挤在左上角 Zoom 下方的竖排里，跟"离开当前视图"心智模型（返回/缩放）语义不完全贴合——拍卖行是频繁访问的经济入口，更适合放在寸土寸金的标题栏本身。

**改动**：
- `WorldMapRenderer/build.ts`：`drawSceneHeader(topLayer, w, h, t('world.title'), …)` 的标题参数改传 `null`（不画标题文字，但保留栏体/纸纹/accent 底线/返回按钮胶囊）。新增 `ctx.headerHudLayer`——加在 `topLayer` 之后（渲染顺序在其上方，否则会被标题栏的不透明纸面遮住），专门承载"随数据刷新"的标题栏内容，区别于只画一次的 `topLayer` 静态栏体。
- `WorldMapPanels.ts` 新增私有方法 `renderHeaderHud()`，随 `renderHud()`（原有的 ~5s 行军轮询节奏）一并 `tearDownChildren` + 重绘到 `ctx.headerHudLayer`：
  - 拍卖行按钮：从原左上 Zoom 下方的竖排移除，改画在标题栏最右侧（`x = w - aucW - 10`，垂直居中于 `topInset` 高度内），复用同一个 `ctx.aucBtnRect` 命中矩形（`WorldMapInput.ts` 命中逻辑不用改，矩形坐标改了但读取方式没变）。左上竖排只剩 Zoom 一项。
  - 资源产量：读 `ctx.me.yieldRate`（原本只在训练弹窗里显示过的"存量 (+产量/回合)"数据源，本次复用同一字段），五种资源 `ink/paper/graphite/metal/sticker` 各画一个 `res_atlas` 图标 + `+产量` 文字，水平居中在"返回按钮胶囊右侧"到"拍卖行按钮左侧"之间的空当，替代原来的标题文字。
- 验证：`tsc --noEmit` + `webpack --mode development` 全绿；用临时调试分支（`entries/web.ts` 加 `?worldmap` 查询参数分支，直接 `new WorldMapScene(...)` + reject-fast 的 `WorldApiClient` Proxy 桩，跳过登录/后端，参考 [[worldmap-standalone-debug-render]] 的既有 recipe；额外踩坑：debug 分支里手搭的 `PIXI.Application` 没有走 `ScalingManager` 的 `gameLayer` 缩放变换，场景容器的 design-space 坐标会 1:1 落到物理画布上——标题栏最右侧的拍卖行按钮因此一度被误判"渲染缺失"，实际是设计坐标超出画布物理宽度；修复为手动 `scene.container.scale.set(w/layout.designWidth, h/layout.designHeight)` 复现真实 App 的缩放后，拍卖行按钮回到画布内可见），截图确认标题栏不再显示"大世界"文字、五个资源产量图标+数值居中显示、拍卖行按钮清晰落在标题栏右上角、返回按钮与左上 Zoom 不受影响；验证后临时分支已移除。
- 回归测试：`client/test/ui/worldMapHeaderProduction.ui.ts`（PIXI headless，走 `test:ui`）7 例，手搭假 `WorldMapContext`（含新增的 `headerHudLayer`）单独驱动 `WorldMapPanels.renderHud()`：拍卖行按钮落在屏幕右半区、贴右边缘、垂直居中于 `topInset` 高度内（含 `topInset` 变化时按钮高度跟着变）；`ctx.me.yieldRate` 五个资源各生成一条 `+<rate>` 文本（含缺省值回退 `+0`）；产量读数水平居中在返回按钮和拍卖行按钮之间、不重叠任一方；`renderHud()` 反复调用（模拟 5s 轮询）不泄漏子节点。同时修了 `worldMapHeaderInset.ui.ts` 已有测试的假 ctx 缺 `headerHudLayer` 字段的问题（`renderHud()` 新调用 `renderHeaderHud()` 后会读到 `undefined.removeChildren`，两个测试文件现在都手搭这个字段）。随 `npm run test:ui`（29 文件 305 例）全绿一并跑通。

**标题栏/右上信息栏可读性微调（2026-07-15）**：

**背景**：用户截图标注反馈五处问题——资源产量条无背景直接浮在标题栏纸面上，不易辨认；`res_atlas` 图标在头部/状态卡里显示得发糊；拍卖行按钮贴右边缘太紧、在窄屏上容易被裁掉；左上 Zoom 按钮和右上部队/领地/行军竖排整体偏小。

**改动**：
- `WorldMapPanels.renderHeaderHud()`：资源产量簇新增独立背景 `sketchPanel`（`C.paper`/`C.mid`，按簇实际宽度 + 10px 内边距动态量），插在簇本身下方，与标题栏共享的纸面区分开。
- `resAtlasLoader.ts`：`res_atlas` 的 `BaseTexture` 构造显式传 `scaleMode: LINEAR` + `mipmap: ON`——图集 128px 长边在头部/状态卡里被缩到 15-34px 显示（约 4-8 倍降采样），没有显式 trilinear 采样时线稿发糊；这是最可能的成因，受限于本机后端服务当次会话未起，没能截图肉眼复核，后续实机确认。
- `renderHeaderHud()`：拍卖行按钮右边距从 10 增到 30，避免窄屏/贴边裁切；`tag` 图标本来就有，一并确认可见。
- `renderHud()`：左上 Zoom 按钮 88×34 → 176×68（图标/文字同比放大）；右上部队/领地状态卡 + 行军角标/列表 + World-info 按钮整个右列宽度 160 → 320，所有子元素（字号、图标、召回按钮、行高）同步 2 倍缩放。
- 验证：`tsc --noEmit` + `webpack --mode production` 全绿；未能起本机后端跑通完整登录→世界地图流程做截图核对（`/bootstrap` 网络失败，是已知未解决的本机开发环境问题，非本次改动引入），代码改动本身逻辑清晰、走查过一遍无遗漏，但视觉效果待后续实机确认。

## 26. 领地总览面板（点击标题栏资源条打开，设计阶段，2026-07-16）

**背景**：`renderHeaderHud()`（§25 2026-07-14）画出的标题栏资源产量条目前只是静态展示，不可点击；右上状态卡的 `territoryCount` 也只是一个聚合数字，玩家看不到自己占的具体是哪些格、也无法从 HUD 直接跳转/放弃某块领地。占地规模到中后期可达 200~300 格，需要一个专门面板承载"总览 + 逐格管理"。

**拍板要点**：
- **点击入口**：标题栏资源产量簇（`renderHeaderHud()` 已有的命中矩形范围）新增点击 → 打开新面板，复用 `WorldMapPanels` 现有的弹层机制（`openInfoPanel()`/`modalLayer`/`modalDimRect` 关闭逻辑），而非另起一个 Scene。
- **一屏两 Tab**，不做成两次跳转的独立页面：
  1. **总览 Tab**：资源产量/仓库（当前标题栏资源条的完整版，含存量+上限）、Troops、Territory 计数、World 摘要（原右上 World-info 弹层内容收纳一份精简摘要，保留原入口跳转完整页）。纯展示，无分页。
  2. **领地列表 Tab**：逐格一行——坐标 `(x,y)`、等级、驻军，行内两个按钮「跳转」「放弃」。
- **不做成两屏/两个独立页面的理由**：总览部分内容量小且强相关（同一决策上下文：家底够不够、要不要扩张），拆开需要来回切换对比，增加认知负担；领地列表因为可能有 200~300 行、且是"列表+逐行操作"这一功能形态，与总览的纯展示不同，值得单开一个 Tab，但仍在同一弹层内即可，不需要跳转到独立 Scene。
- **等级过滤**：领地列表 Tab 顶部加两排 checkbox（按等级分两行，例如 1-5 一排、6-10 一排，取决于实际等级上限），勾选决定显示哪些等级的领地行；默认全选。纯客户端过滤，不需要服务端参数化。
- **规模应对（200~300 行）**：不能一次性铺开全部行，沿用 §25 2026-07-13 `beginScrollList()`/`panelButtonIn()` 的 PIXI mask 滚动列表模式（而非新增分页组件），按等级过滤后的行数决定 `contentH`；每行按钮沿用 `ctx.modalBtnRects` 命中登记方式。
- **复用清单（已在代码里现成、直接调用即可）**：
  - 跳转：`viewport.ts` 的 `centerAt(tx, ty)`（marches 列表点击跳转已是同一模式，见 `WorldMapInput.ts:314`）。
  - 放弃：`WorldMapNet.doAbandon(tx, ty)` → `WorldApiClient.abandonTile()` → 服务端 `httpApi.ts` `/world/abandon`（已end-to-end 实现，直接对列表行调用）。
- **新增缺口（需要实现）**：
  - **服务端**：worldsvc 目前没有"枚举玩家全部占地"的接口——`getOccupations()`/`/world/occupations` 只返回行军中的临时捕获态,不是全部持有的领地集合。需要在 `server/worldsvc/src/territory.ts`（或等价位置）新增聚合查询 + `httpApi.ts` 新路由（如 `GET /world/territories`），返回 `{x, y, level, garrison}[]`。
  - **契约**：`openapi-world.yml` 补新端点 + 类型；`client/src/net/WorldApiClient.ts` 补对应方法。
  - **客户端 UI**：`WorldMapPanels.ts` 新增总览/领地列表两个 Tab 渲染分支 + 等级过滤 checkbox 渲染与状态；`WorldMapContext.ts` 补面板开关状态、等级过滤勾选集合、Tab 切换状态；`WorldMapInput.ts` 补标题栏资源条点击入口 + 过滤 checkbox/跳转/放弃按钮命中分支。
- **未决**：等级上限具体是多少（决定 checkbox 两排怎么分）、领地列表默认排序（等级降序 or 离主城距离）——待实现前确认或按现有惯例（等级降序）先定一版，暂不阻塞开工。

**落地状态（2026-07-16，已实现）**：
- 服务端：`TerritoryService.listTerritories()`（`territory.ts`）复用 `core/yield.ts` 已有的 `cols.tiles.find({worldId, ownerId, type:{$ne:'base'}})` 查询模式，经 `service.ts` 委托、`httpApi.ts` `GET /world/territories` 暴露；`openapi-world.yml` 新增端点定义（复用既有 `WorldTileView` schema，未新建 schema），`gen:api:world` + `gen:api:contracts` + 客户端 `rest:gen` 三步codegen 全部重跑同步。
- 客户端：`WorldMapContext` 新增 `territoryPanelOpen`/`territoryTab`/`territories`/`territoryHiddenLevels`/`resClusterRect`；`beginScrollList()` 顺带泛化出 `ctx.infoScrollRerender` 回调（原先滚动拖拽/滚轮硬编码调 `renderInfoPanel()`，现在按打开的是哪个面板调用对应的渲染函数，World-info 和 Territory Overview 两个弹层共用同一套滚动输入代码不用分叉）；等级过滤 checkbox 直接注册为普通 `modalBtnRects` 项（勾选即 toggle + 重渲染），不需要新的命中判定分支；跳转复用 `centerAt` 并额外 `closeModal()`（列表在弹层里，跳转后应看地图）；放弃改走新增的 `WorldMapNet.doAbandonFromList()`（区别于原 `doAbandon()`：不 `closeModal()`，放弃后原地刷新列表，不打断玩家继续处理其他行）。
- 测试：`server/worldsvc/test/territories.e2e.test.ts`（5 例，真实 Mongo）——未入世界拒绝、已加入无领地返回空、领地行字段正确且排除 3×3 主城 footprint、跨玩家隔离、放弃后从列表消失。`client/test/ui/worldMapTerritoryPanel.ui.ts`（12 例，PIXI headless）——开面板守卫（未入世界→toast 不开面板）、总览页无滚动区、切到列表 Tab 触发一次性拉取、等级 checkbox 勾选/取消的行数变化（按 `modalBtnRects` 长度断言，不深入渲染内容）、跳转关闭弹层+居中地图、放弃调用 `net.doAbandonFromList` 且不关弹层。另修了 `worldMapHeaderInset.ui.ts` 手搭假 ctx 缺 `resClusterRect` 字段导致的 3 例失败（`zeroRect()` 补齐）。`tsc --noEmit` + `webpack --mode production` + worldsvc 全套（31 文件 235 例）+ client `test:ui` 全套（52 文件 490 例）均绿；浏览器截图人工核对总览/列表/过滤/跳转/放弃交互，细节见会话记录。

**World-info 合并进第三 Tab + 面板加高（2026-07-16）**：用户截图标注反馈两点——右上角单独的 World 按钮/弹层和领地总览面板功能重叠，应合并；面板偏矮，内容常需要滚动。改动：`renderHud()` 删除原独立的 World 按钮渲染块与 `ctx.infoBtnRect` 命中矩形，`WorldMapInput.ts` 对应的点击分支一并移除；`renderTerritoryPanel()` 的 Tab 数组新增第三项 `world`（`territoryTab` 类型相应扩为 `'overview' | 'list' | 'world'`），点击后渲染原 `renderInfoPanel()` 的 nations/season/shop 三个二级 Tab——抽成新的私有方法 `renderWorldTabBody()`，直接画进总览面板已有的弹层区域（不再单独起 dim/panel/title/关闭按钮）；`openInfoPanel()` 整个方法删除，原先「首次打开时懒加载 shop 目录 + nations」的逻辑搬进新增的 `loadWorldTabData()`，由 `switchTerritoryTab('world')` 触发；`doBuyShopItem`/`doRename`（`WorldMapNet.ts`）刷新面板的判断条件相应改成 `territoryPanelOpen && territoryTab === 'world'`。面板高度从固定 `min(460, …)` 改为页面高度的 80%（`h * 0.8`，仍 cap 到不遮挡底部 HUD）。验证：`tsc --noEmit` + `webpack --mode development` 全绿；用临时 `__NW_WorldMapPanels` 调试钩子（挂在 `app.ts`，验证后已移除）在真实 dev server 里手搭最小 ctx 直接调 `renderTerritoryPanel()`，截图确认三个 Tab（总览/领地/World）+ World Tab 下 nations/season/shop 二级 Tab 正常显示、面板高度明显变高。

**总览可读性放大（2026-07-16）**：用户反馈资源界面偏窄偏小。`renderTerritoryPanel()` 面板宽度上限从 `min(420, w-20)` 提到 `min(840, w-20)`（窄屏仍钳到 `w-20`，真机不溢出）；总览页文字约 2×——资源行/赛季·人口行用 `FS.label`（24）、强调的兵力/领地行用 `FS.heading`（28），行距同步加倍（20→40、22→44、26→52、18→36）以免重叠。仅影响总览 Tab；列表/World 两个 Tab 共用同一 `pw` 会一起变宽，内部字号未动。验证：`tsc --noEmit` 绿；临时 `?terrpanel` 调试入口（构造真实 `WorldMapScene` + 假数据，`forceCanvas` 抓图，验证后已移除）截图确认字号翻倍、面板加宽、无重叠裁切。

**领地列表排序/驻军可读性/放弃二次确认（2026-07-18）**：用户截图指出列表 Tab 的等级过滤按钮与实际行序对不上——过滤按钮是勾选开关，行序却是原始拉取顺序，Lv.1/Lv.2 交替出现，读起来像分组渲染 bug。同时解决 §26 遗留的「未决」排序问题。改动（均在 `renderTerritoryPanel()`）：
1. 列表改为按 `level` 升序、同级按坐标排序，与过滤按钮的等级分组语义对齐。
2. 等级过滤按钮标签加计数，如 `Lv.1 (12)`，勾选前就能看到该等级有多少格，不用逐个数。
3. 驻军数值低于当前过滤结果集中位数一半时文字变红——阈值取当次列表的中位数而非写死绝对值，避免不同账号规模下失真。
4. 「放弃」不再直接调用 `doAbandonFromList`，先弹二次确认（复用 `panelButton` 在 `ctx.territoryAbandonConfirm` 非空时整体替换面板内容，避免遮挡态下误触底层按钮）；确认态复用面板已有的 dim+panel 外框，只替换正文为提示语 + 确定/取消。`WorldMapContext` 新增 `territoryAbandonConfirm: {x,y} | null` 字段；`world.abandonConfirm` i18n key（zh/en/de）。验证：`tsc --noEmit` 绿；临时 `?territorydbg` 调试入口（`territoryDebug.ts`，直接构造 `WorldMapScene` + reject-fast `WorldApiClient` stub + 18 行假数据，验证后已移除）在真实 dev server 里截图确认排序分组正确、过滤按钮计数、驻军红字、确认弹窗文案与按钮布局，以及 Cancel 能正确清空确认态回到列表。

**过滤按钮换行策略 + 红字驻军提示语（2026-07-20）**：用户截图反馈两点——① 等级过滤按钮固定拆两行（`perRow = ceil(levels/2)`），账号等级种类少（如只有 Lv.1/Lv.2）时每个按钮被拉伸到几乎占满一整行；② 领地行坐标标红（低驻军预警，见上条 #3）在面板上没有任何文字说明，用户看不出红色代表什么。改动（`renderTerritoryPanel()`）：
1. 过滤按钮改为每行最多 5 个（`perRow = min(5, levels.length)`），超过 5 个等级才换到下一行，行数按实际等级数动态算（`rows = ceil(levels.length / perRow)`），不再写死 2 行。
2. 列表区顶部加一行灰色提示文字（`world.weakGarrisonHint`，`FS.tiny`/`C.mid`）："红色坐标：驻军低于列表中位数一半，建议增兵"，zh/en/de 三语。验证：`tsc --noEmit` 对改动文件绿；`SceneManager.ts` 当时有另一会话在建的 overlay 重构导致编译错误，未能启动 dev server 截图核实，用户确认按已知在建 WIP 处理、跳过截图。

---

## 27. 险地/关隘战力模拟补测（2026-07-16，DRAFT 数值收尾）

> 背景：项目体检发现 `STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL`/`CROSSING_GARRISON_PER_LEVEL` 四个常量仍带 DRAFT 标记（§15.3/§19.5）。前三者中，`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL` 的经济面早已被 `strongholdRun.ts`（§13-SLG-STRONGHOLD.2-4）核验过，只是源码注释没跟着更新；真正从未验证过的是「这些守军数值到底能不能打下来」——原注释只是一段手估 HP 对比，没有真跑过引擎。

**新增战力模拟脚本**（`server/tools/econ-sim/src/strongholdCombat.ts` + `strongholdCombatRun.ts`，`npx tsx src/strongholdCombatRun.ts`）：复用真实 `@nw/engine` 攻城引擎（自成一体，标准同 `client/test/pvpSim.ts`——独立于 worldsvc 直接调用 `@nw/engine` 原语，而非 import worldsvc 内部模块，因为后者会把 `tsc --noEmit` 的 rootDir 拉出包边界）。

**关键发现**：
1. **险地/关隘实际等级是固定值，不是文档暗示的 1..5 区间**：险地恒生成于 `SLG_MAP_MAX_LEVEL`（现 10，ADR-032 起从 5 涨上来的）→ 守军恒 3,600 兵；自动关隘恒生成于 `max(2, SLG_MAP_MAX_LEVEL-1)`（现 9）→ 守军恒 1,800 兵。`siege.ts` 旧注释仍写"满级 5→1800"，是地图上限上调后没跟着改的过时描述，本轮已订正。
2. **战力校验通过**：险地——新手（troopCap=2000）0% 胜率，小额投入（troopCap≈4500，练兵场约 3 级）100% 胜率；关隘——新手 0%，练兵场仅 1 级（troopCap=3000）即 100%（比险地更早开放，符合"较轻关卡"设计意图）。两个常量**均保持不变**，DRAFT 标记已从 `shared/src/slg/siege.ts` 源码注释移除，换成本次核验依据（详见 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5）。
3. **⚠️ 新发现的独立 gap（非本轮数值范围）**：单次出征兵力超过约 9,600（= 10 攻击车道 × 16 可生成行 × 60 血/兵，棋盘纵深耗尽）时，`synthesizeArmy` 轮转铺兵会让胜负变得非单调（例如 9,000 兵败、9,600 兵胜、10,000 兵又败），根源是兵力在车道内拥堵导致战斗超时，与守军强度无关。`SIEGE_CHEAP_RATIO`（`shared/slg/siege.ts`）本该把这种悬殊对局挡在真实引擎之外，但 `combatSiege/arrival.ts` 的险地/关隘围攻从未做这个比率检查，无条件跑 `runSiegeBattle`——满练兵场+满行囊（satchel，均可堆到 12,000）玩家单次出征在生产环境就可能撞上这个问题。这是路由/工程缺口，不是「调大调小某个常量」能解决的，已登记为独立后续任务（不在本轮范围内处理）。

**结论**：`STRONGHOLD_GARRISON_PER_LEVEL=360`、`CROSSING_GARRISON_PER_LEVEL=200`、`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4` 三处 DRAFT 标记均已清除（前者战力实测通过，后者经济稀释早已通过只是注释未同步）；`STRONGHOLD_LOOT_PER_LEVEL=5000` 本就非 DRAFT（季内一次性、已有 sanity check）。四项收尾完成，SLG 待调参数值清单清空。

> **⚠️→✅ 已按新基线重跑（2026-07-27）**：上文第 2 点「新手（troopCap=2000）0% 胜率」的前提确认已失效——`strongholdCombatRun.ts` 的 `SCENARIO_BASE.troops` 直接 import `TROOP_CAP_BASE`，无需改代码即反映新基线，重跑结果：新手（troops=10,000）对险地（守军 3,600）和关隘（守军 1,800）**均 100% 胜率**，"几乎打不过，小额投入即可攻克"的设计意图（§3.1）在当前常量组合下完全不成立——`STRONGHOLD_GARRISON_PER_LEVEL=360`/`CROSSING_GARRISON_PER_LEVEL=200` 需要重新拍板（数量级参考：若要恢复原设计手感，两者大致都需要与 `TROOP_CAP_BASE` 同倍数放大）。第 3 点/Follow-up 中「satchel 可堆到 12,000」现为 **20,000**（`SATCHEL_CARRY_BASE=10000 + 10×1000`）、`SIEGE_SYNTH_ARMY_MAX_TROOPS=9,600` 的 cheap-siege 兜底相应更常触发（未变）。详细数据见 [`ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5](ECONOMY_VERIFICATION_LOG.md) 重跑记录；已 `spawn_task` 登记为独立后续项。旧版 troopCap=2000 战力结论按历史记录保留，不要再引用为当前结论。

**Follow-up（2026-07-16，独立 gap 已修复）**：第 3 点记录的路由缺口已在同日修复。`server/worldsvc/src/siegeEngine.ts` 新增 `SIEGE_SYNTH_ARMY_MAX_TROOPS`（=10 车道×16 行×60 血=9,600，`synthesizeArmy` 不发生车道碰撞的兵力上限）与 `shouldUseCheapSiege(...)`：当任一方是 `synthesizeArmy` 铺兵且兵力超过该上限（无论比率是否达到 `SIEGE_CHEAP_RATIO`），或攻守比率达到 `SIEGE_CHEAP_RATIO` 时，一律跳过真实引擎改走 `resolveSiege` 线性结算。已接入 `combatSiege/arrival.ts` 的全部三条路径——`applySiege` 普通地块围攻、`applyStrongholdSiege`、`applyCrossingSiege`——以及 `applyBaseSiege` 主城逐波围攻的每一波（防守方队伍恒为真实编队，从不铺兵，故只需查攻方）。真实卡牌编队（位置由关卡校验器约束、不会车道碰撞）不受影响，只有"无编队、纯兵力数"的旧式出征会命中该守卫。新增单测 `worldsvc/test/siege-cheap-fallback.test.ts`（纯函数，覆盖上限/比率/双向判定）+ `stronghold.e2e.test.ts`、`passage.e2e.test.ts` 各一条回归用例（12,000 兵出征验证 `attacker_win` 且 `siege.seed`/`attackerArmy` 缺失，证明走的是 cheap 路径而非拥堵的真实引擎）。

---

## 28. G6 赛季中转区/合区（设计 + 实现，2026-07-16）

> 收尾 §17.12/§21.4 遗留的最后一项：G6 运行时调度（§20）只做了赛季开局的一次性路由分配；赛季中途「玩家主动转区」「运营合并低活 shard」此前完全没有设计（§17.8/§17.12 只写了"运营专项，待定"）。本节补齐设计并实现。

### 28.1 架构前提（决定了方案为什么这么简单）

调研确认两个关键事实，把原本设想的"复杂跨区数据迁移"问题大幅简化：

1. **所有 shard 共享同一套 Mongo 集合**（`playerWorld`/`tiles`/`marches`/`families` 等），按 `worldId` 字段区分,不是一区一库。转区因此是**同集合内**的操作,不是跨库迁移。
2. **`joinWorld`（首次加入）与 `purgePlayerWorld`（清空某玩家在某 shard 的全部数据,含主城）两个函数早已存在**（分别用于正常加入、corrupt 存档修复重建）,且都是"对单一 (worldId, accountId) 操作,与其在其他 shard 的状态无关"——直接复用,零新建迁移逻辑。

### 28.2 转区（个人转移）—— "刻意的退出+重新加入"

**模型**：转区 = 放弃源 shard 全部 shard 内数据(城市/领地/兵力,经 `purgePlayerWorld`)+ 在目标 shard 全新加入(经 `joinWorld`)。**不做属性迁移**——account 级进度(卡牌/装备/金币,存在 meta SaveData)本来就不是 shard 数据,天然不受影响。

**家族/宗门不受影响**：调研确认「家族」（family）是 socialsvc 的账号级概念，不按 shard 存储；「宗门」（sect）虽是 worldId 域概念，但挂在**家族**（不是账号）上，一个成员单独转区不涉及宗门变更。因此转区**不触碰**家族/宗门成员关系——这是刻意的设计简化，不是遗漏。

**守卫**：
- 目标 shard 必须存在、同赛季、`open`/`active`、未满员，否则 `TRANSFER_TARGET_INVALID`。
- 源 shard 内有在途行军(非 `recalled`)或占领倒计时 → `TRANSFER_BUSY`（先撤军/等结算）——避免刚离开的 shard 里留下悬空的跨区引用（正是 `patrolShardIsolation` 的 `crossWorldMarches` 巡检要抓的那类东西）。
- 每账号冷却 `SHARD_TRANSFER_COOLDOWN_DAYS=7`（防止反复横跳/侦察对手 shard），冷却计时存在独立的新集合 `shardTransfers`（`_id=accountId`,不挂靠任何一个 shard,故不会被 `purgePlayerWorld` 清掉）。

**已知残余风险(接受)**:目标容量在"转区前检查"和"joinWorld 内原子检查"之间的极窄窗口耗尽,会让玩家短暂"两边都不在"——本项目全程无跨集合事务(`shared/mongo.ts` 明确写单节点副本集只解锁事务能力,但代码里从未真正用过,全靠单文档 CAS),与既有惯例一致,不引入 the-first transaction。恢复路径:玩家可直接调用普通 `joinWorld` 进任意其他 open shard(无历史依赖,不是卡死状态)。

### 28.3 合区（运营触发）—— 复用转区,不做地图合并

**关键简化**：不做"两张活地图的瓦片所有权对账"——那是原调研认定的真正难题。合区改为：把源 shard 剩余的**每一个玩家**都用同一套转区核心操作搬到目标 shard,搬完后关闭源 shard。因为源 shard 上没有玩家了,自然不存在"两边地图重叠"的问题——从头到尾没有发生"地图合并"这件事。

- **与个人转区的区别**：合区是运营强制操作，不检查冷却/繁忙——先强制清空该玩家的在途行军/占领(`marches.deleteMany`/`occupations.deleteMany`),再走同一个"退出+加入"核心,逐账号 best-effort(单个账号失败只记日志跳过,不中断整个合区)。
- **前置容量检查**：合区前一次性校验目标 shard 剩余容量 ≥ 源 shard 全部玩家数,不足直接拒绝——避免在循环中途撞见 28.2 提到的"两边都不在"窗口。
- **收尾**：全部搬完后源 shard 置 `status:'closed'`——`resolveShardForJoin`/`joinWorld` 本来就按 `status in [open,active]` 过滤(§17.3),`closed` 天然被未来加入路由排除,无需额外清理路由表。

### 28.4 实现落地

- **`@nw/shared`**：`slg/transfer.ts`（新文件）——`SHARD_TRANSFER_COOLDOWN_DAYS=7` + `parseWorldId`；`api.ts` 新增错误码 `TRANSFER_COOLDOWN`/`TRANSFER_TARGET_INVALID`/`TRANSFER_SAME_SHARD`/`TRANSFER_BUSY`。
- **`worldsvc`**：新模块 `transfer.ts`（`TransferService`，同 `TerritoryService`/`SeasonService` 的领域服务范式）——`listTransferTargets`/`transferShard`/`mergeShard`；`db.ts` 新增 `ShardTransferDoc` + `shardTransfers` 集合（`_id=accountId`）；`service.ts` 接线委托方法。
- **契约**：`openapi-world.yml` 新增 `GET /world/season/transfer/targets` + `POST /world/season/transfer`（玩家侧，JWT）+ `ShardTransferTargetView` schema；`POST /admin/world/merge`（X-Internal-Key，运维侧，未入 openapi-world.yml——与其余 `/admin/world/*` 端点一致，属内部分支不进公开契约）。client `rest:gen` 重生 `openapi-world.ts`。
- **客户端**：`WorldApiClient.getTransferTargets`/`transferShard` 已接入（数据层）。**UI 场景本轮暂缓**——给时间预算判断，玩家侧转区选择/确认界面留作后续任务，不阻塞服务端能力落地。
- **admin 后端**：`WorldClient.mergeWorld` 代理 + `AdminService.slgMergeShard`（复用既有 `slg.season.manage` 能力，新增审计动作 `slg.season.merge`）+ httpApi 路由 `POST /admin/slg/season/merge`。
- **ops 前端**：`tools/ops/src/pages/slgSeason.ts` 季世界列表新增「Merge into…」按钮（危险操作二次确认 + 目标 worldId 输入）。**顺带修复一处相邻小 bug**：原按钮判断只覆盖 `status==='open'`，遗漏了 `'active'`（世界一旦有玩家加入就从 open 变成 active，§17.3）——导致进行中的世界在 ops 页面上其实**没有** Settle/Close 按钮可点。改为 `open || active` 都显示操作按钮，这是本次改动顺带修的，不是范围外改动。
- **验收**：`server/worldsvc/test/transfer.e2e.test.ts`（11 例，真实 Mongo）——转区成功（源清空含主城+人口计数扣减、目标全新加入+人口计数+3×3 主城 footprint）/ 同 shard 拒绝 / 跨赛季目标拒绝 / 不存在目标拒绝 / 满员目标拒绝 / 在途行军阻挡（recalled 后放行）/ 占领倒计时阻挡 / 同赛季冷却生效+跨赛季不冷却 / 合区搬空全部玩家+强制清行军占领+关闭源 shard+未来加入路由自动跳过 / 合区目标容量不足拒绝 / 合区同 shard 与跨赛季目标拒绝。worldsvc 全量 246 测试无回归；`tsc -b`（shared/engine/worldsvc/admin/metaserver/gateway/commercial）+ client `tsc --noEmit` + ops `tsc --noEmit` 全绿。

### 28.5 明确排除的范围（不是遗漏，是拍板）

- **不做真正的地图/瓦片合并**：两个 shard 各自独立地图从未需要对账，因为合区前置为"先搬空玩家再关闭"，任何时刻只有一张地图有活跃玩家在上面。
- **不做家族/宗门整体转移**：转区是纯个人操作；一个家族想集体换 shard，需要每个成员各自转区（家族本身跟着任一成员走，不会"卡住"，因为家族不是 shard 数据）。
- **不做玩家侧 UI**：服务端能力+契约+admin 运维入口已完整；玩家自助转区的选择/确认场景留作后续任务（数据层 `WorldApiClient` 方法已就绪，UI 是纯前端工作，不依赖任何未决的服务端设计）。

### 28.6 修复：转区/合区未清理 `stationed` 集合 + Redis occ/cover 索引（2026-07-27，design-doc-audit-2026-07）

> §28.4 的 TRANSFER_BUSY 阻挡只查了 `marches`/`occupations` 两个集合，`vacatShard`（经 `purgePlayerWorld`）也只删 `tiles`/`playerWorld` 两个集合——`stationed`（2026-07-23 新增的"停留在外"字段部队，`combatMarch.ts`）从一开始就不在两条路径的视野内，本次审计逐代码核实后确认是真实 bug，非误报：

- **玩家主动转区（`transferShard`）此前完全不受 stationed 阻挡**：一名有队伍停留在外（`StationedDoc`）的玩家可以直接转区离开，走后留下的 `StationedDoc` 变成**永久幽灵**——没有 `playerWorld` 文档认领它，玩家自己也再摸不到这个已离开的 shard 去调用 `recallStationed`；该队伍站的格子按"一格一队"规则被永久占用（`combatMarch.ts` 的 `TILE_OCCUPIED` 检查），其他任何人都不能再在那格停留部队；若该队伍是 `garrison` 模式，Redis `cover` 9 格反向索引里的驻防区也一并变成永久幽灵，理论上会一直"拦截"路过的行军。
- **合区（`mergeShard`）同理**：强制清场时只 `deleteMany` 了 `marches`/`occupations`，`stationed` 文档连同它们的 Redis `occ`/`cover` 条目完全没清——虽然源 shard 随后 `closed`（不再路由新加入，游戏性影响较小），但幽灵文档会一直堆在数据库里，且如果同一 worldId 字符串未来被复用（当前代码未见复用保护），幽灵索引可能对新 shard 产生数据污染。
- **修复**：`server/worldsvc/src/transfer.ts`——① `transferShard` 的忙碌检查从"march+occupation"扩到"march+occupation+stationed"（`Promise.all` 并发查询，三者任一存在即 `TRANSFER_BUSY`，与既有 march/occupation 阻挡语义一致：玩家必须先 `recallStationed` 再转区）；② `mergeShard` 的强制清场块新增：先查出该玩家在源 shard 的全部 `StationedDoc`，`deleteMany` 前逐条调用 `core.clearOccupancy`（清 Redis occ 条目）+ `mode==='garrison'` 时额外调用 `core.removeCover`（清 9 格反向索引），再删 Mongo 文档——顺序与 `recallStationed`（正常玩家自己触发的清理路径）保持一致，只是这里是批量强制版本。
- **回归测试**：`server/worldsvc/test/transfer.e2e.test.ts` 新增两例——「stationed 队伍阻挡转区，recall（删除文档）后放行」+「合区强制清理 stationed，源 shard 里不留幽灵文档」；两例改动前跑会失败（转区不受阻挡 / 合区后文档仍在），改动后随全量 20 例（含原 18 例）绿。`@nw/shared` 633 例 + worldsvc 339 例全量无回归。
- **未覆盖**：本次测试环境 `redis: null`（沿用既有 e2e 约定，`clearOccupancy`/`removeCover` 对 `redis: null` 静默降级不报错），故只在 Mongo 层面断言了 `StationedDoc` 确实被清空；Redis occ/cover 条目的清理调用路径与 `recallStationed`（已在生产验证过的正常清理路径）完全一致，逻辑上可信，但没有专门起一个真实 Redis 的 e2e 去断言 hash 条目消失——如果未来要做，需要一个带 `ioredis-mock` 或真实 Redis 容器的测试环境。

## 29. NPC 地块基地血量随等级缩放（2026-07-17，方案 2，用户拍板）

**背景/病灶**：用户实测「打一级地，打败了敌方所有的兵，但自己的兵不足以摧毁基地」。根因：**NPC 地块**（占地 `applyOccupy` / 驱逐 `applyOccupationExpulsion` / 领地 `buildDefenderConfig` / 据点 `applyStrongholdSiege` / 关口）走**单场** `runSiegeBattle`（objective=`destroy_base`），其引擎内象征基地血量此前恒为 `BASE_HP=100`，**与地块等级无关**。而基地不是"慢慢磨"——每个走到基地格的单位一次性造成自己的 `siegeValue`（合成步兵=11）后当场消失（`MovementSystem`）。于是一级地驻军仅 `npcGarrison(1)=120`（=2 步兵）微不足道，但要凑够 ~10 个幸存步兵抵达基地才推得平 100 血；`OCCUPY_MIN_TROOPS=500` 的最小占地兵力清完守军后幸存不足 → 超时 → 守方胜（防守方偏置）。**玩家主城/领地侧本无此问题**：走 ADR-026 分波，象征基地钉死 `defenderBaseLevel:0` 只当终结器，真实血量是 `TileDoc.hp = baseDurabilityMax(墙等级)`——已随基地等级缩放。缺口只在 NPC 单场路径。

**方案（用户在三选项中选"缓坡 40×等级"）**：新增 `npcBaseHp(level) = SLG_NPC_BASE_HP_PER_LEVEL × max(1,level)`，`SLG_NPC_BASE_HP_PER_LEVEL = 40`（L1=40、L10=400）。低级更软、高级更硬，与玩家城侧 `baseDurabilityMax` 形成对称。

**实现（跨 4 包，显式传参、无隐式推导）**：
- **`@nw/shared`**（`slg/siege.ts`）：`SLG_NPC_BASE_HP_PER_LEVEL` + `npcBaseHp()`；`buildSiegeLevel`/`buildSiegeBattle` 的 config 加 `defenderBaseHp` 透传（>0 才写；**不**从 tileLevel 隐式推导，分波路径不传即保持默认）。
- **`@nw/engine`**：`Player.maxBaseHp`（默认 `BASE_HP`）；`LevelDefinition.defenderBaseHp` + `levelSchema` 校验（1..100000 脏数据兜底）；`base.ts` 开局把 `topPlayer.baseHp=maxBaseHp=defenderBaseHp`；`MovementSystem` 的 `base_hp_changed.maxHp` 改发 `opponent.maxBaseHp`（原写死 `BASE_HP`）。
- **`worldsvc`**：占地/驱逐/据点/关口/领地单场五处 `defenderConfig` 显式加 `defenderBaseHp: npcBaseHp(tileLevel)`；分波路径（`defenderBaseLevel:0`）**不加**；config 类型（`siegeEngine.ts`/`worldTypes.ts`/`combatSiege/base.ts`）补字段。回放走持久化 `defenderConfig`，确定性保持。
- **client**：`GameRenderer/base.ts` 的 critical 阈值从 `BASE_HP×ratio` 改为各玩家 `maxBaseHp×ratio`（血条 max 本就走事件 `maxHp`，replay `baseMaxHp` 从首帧 `baseHp` 锚定，均自动正确）。

**econ-sim 复核**（`tools/econ-sim/src/occupyBaseHpRun.ts` + `npm run --workspace @nw/econ-sim occupy-base-hp`，真实 `@nw/engine` 单场，合成步兵，每级 5 seed 全胜的最小兵力）：

| 地块 | 驻军 | 旧(基地=100) 最小取胜 | 新(=40×L) 最小取胜 | 新基地血量 |
|---|---|---|---|---|
| 1 | 120 | 660 (11 步兵) | **300 (5 步兵)** | 40 |
| 2 | 240 | 660 | 660 | 80 |
| 3 | 360 | 720 | 720 | 120 |
| 4 | 480 | 780 | 960 | 160 |
| 5 | 600 | 900 | 1140 | 200 |
| 6 | 720 | 960 | 1500 | 240 |
| 7 | 840 | 1140 | 2160 | 280 |
| 8 | 960 | 1260 | 2340 | 320 |
| 9 | 1080 | 1320 | 2640 | 360 |
| 10 | 1200 | 1560 | **2940** | 400 |

L1 从需 660 兵降到 300（最小占地 500 现稳赢，直击病灶）；L2/L3 基本不变；L4+ 显著变硬，高级地成为真正的战力门槛。

**验收**：shared/engine/worldsvc/client `tsc` 全绿；shared siege 单测 39/39（+npcBaseHp/defenderBaseHp 用例）；engine 66/66（+siege defenderBaseHp 初始化用例）；worldsvc occupy/base-siege/siege/stronghold/passage/cheap-fallback e2e 全绿（无结果翻盘）；econ-sim `tsc --noEmit` 通过。

**2026-07-22 更正**：上面"数值仍 DRAFT"已过期——`occupyBaseHpRun.ts` 补测了装备/学院攻城 hp 加成（0%/10%/20% 三档）叠加后曲线依然逐级单调、不溢出棋盘容量，且敏感度复测证实这个力量比区间下 hp 加成对胜负确无可测量影响（不是步进粒度掩盖）。`40×level` 系数**转正，DRAFT 标记已从 `siege.ts` 源码注释移除**，详见 `ECONOMY_VERIFICATION_LOG.md §13-SLG-NPC-BASEHP`。

## 30. 出征队伍编辑器：左右分栏布局（2026-07-18，用户拍板）

**背景**：`DefenseEditorScene`（attack 模式，`client/src/scenes/DefenseEditorScene.ts`）此前把卡牌调色板做成顶部一条可翻页的横向卡片带（`cardPage` 分页 + 左右箭头），棋盘格铺满整个屏幕宽度。用户反馈配队应该"左半屏布阵、右半屏选卡"，两者同屏可见，不必来回翻页。

**实现**：仅改 attack 模式（defense 模式的兵种/建筑调色板不变，仍是顶部横条）：
- `renderAttackBody()`：屏幕对半分——左半宽度内画棋盘格（`renderGrid()` 加了 `areaX`/`areaW` 参数，defense 模式沿用默认值=全宽不受影响），右半宽度内画卡牌名册。
- `renderAttackToolbar()`：原顶部横条只剩提示文案 + 删除工具切换按钮，收窄到左半宽度上方一条。
- `renderCardRosterPanel()` / `renderRosterCell()`：卡牌名册改为**竖直可滚动的肖像卡片网格**（列数按右半宽度自适应），复用 `TeamsScene.ts` 的花名册卡片视觉语言（肖像+等级+兵力+"已在队伍中"标签）与 `ScrollTapGesture` 拖拽/点击消歧（防止在名册上拖动滚动时误触发选卡）。
- 移除了原分页横条 `renderCardPalette()`/`cardPage` 字段（不再需要翻页）。
- 选卡→点格子放置的既有交互（含跨队伍互斥、`CARD_TEAM_MAX_SIZE` 上限、卡牌只能占一格）逻辑未改动。

**验证**：`client/test/ui/defenseEditorAttackCards.ui.ts`（6 例，纯逻辑，不测布局像素）+ `teamsScene.ui.ts`（11 例）全绿，`tsc --noEmit` 全绿；另用临时 `?teamEditor` 调试入口（构造假 `WorldApiClient` + 假 `SaveData`，跳过登录/后端，验证后已删除，未随功能保留）在 Browser 截图核对了实际渲染效果——左侧棋盘 + 右侧卡牌网格、已部署卡牌高亮 + "已在队伍中"标签、选卡后点格子放置生效。

### 30.1 棋盘格已布置单位改用卡牌肖像（2026-07-18）

**背景**：左侧棋盘上已放置的单位此前只画一个纯色圆点（按 unitType 分 4 色）+ 兵力数字，与右侧名册的肖像卡片视觉不一致，用户反馈应显示卡牌图片。

**实现**：`drawUnit()`（`DefenseEditorScene.ts`）改为复用 `renderRosterCell()` 同款素材管线——`UNIT_ART_URLS[type]` 取到肖像 URL 时画一个 `sketchPanel` 方框 + `drawArtFit()`（与名册肖像同一 `getArtTexture`/`artHooked` 缓存与异步加载回调），取不到时保留原纯色圆点兜底（理论上不会触发，因为可布置单位均来自 `CARD_DEFINITIONS` 已收集兵种，均有肖像）。兵力数字标签位置从"圆心+半径"改为"方框底部"。

**验证**：`tsc --noEmit` 全绿；用临时 `__NW_APP`/`__NW_DefenseEditorScene` 调试钩子（`Object.create(DefenseEditorScene.prototype)` 假实例直调 `drawUnit`，跳过登录/WorldApiClient，验证后已删除）截图确认 Max/Lena/Archer 三种兵种均正确显示肖像图（非圆点）。

## 31. 出征队伍保存必现校验失败修复 + 旧格式兼容代码删除（2026-07-18）

**背景（用户报告的错误）**：`DefenseEditorScene`（attack 模式）保存队伍时必现 `Team formation is invalid: level.attackerArmy[0].unitType: expected a string, got undefined`。

**根因**：卡牌迁移（commit `a91bb018`）之后 `DefenseEditorScene.buildArmy()` 只发送 `{cardInstanceId, col, row}`（无 `unitType`），但 `server/worldsvc/src/city.ts` 的 `setTeams` 从未跟着改——`validateAttackerArmy(team.army)` 把这个原始数组直接打包进 `level.attackerArmy` 走引擎 `parseLevelDefinition` 校验，而该校验要求每条 entry 必须有字符串 `unitType`。也就是说**卡牌迁移之后，任何带卡牌的出征队伍保存都必现此错误**，且校验发生在 `pw`（含 `cardInv` 所需的 `cardState`）取出**之前**，根本没机会解析 `cardInstanceId → unitType`。

**修复**（用户拍板：错误数据直接丢弃+把卡牌还给玩家空闲状态，不保留旧格式兼容代码）：
- `server/worldsvc/src/siegeEngine.ts`：新增 `sanitizeCardArmy(army, cardInv)`——过滤掉任何无法解析出真实卡牌的 entry（无 `cardInstanceId`，或引用了玩家已不再拥有的卡牌），返回净化后的 `ArmyEntry[]` + 已解析的 `{unitType,col,row}[]`；`validateAttackerArmy` 改为只接收已解析好的 `{unitType,col,row}`（不再检查 `initialHp`——0 兵力的新分配卡牌是合法状态，不该在保存时被当成格式错误拒绝）。`resolveCardArmy` 里"无 `cardInstanceId` 走 legacy unitType"的兼容分支整个删除。
- `server/worldsvc/src/city.ts`：`setTeams` 改为先取 `pw` + `meta.getSaveFields()`（拿不到 `cardInv` 就报 `INTERNAL` 重试，而不是把队伍当空处理——防止 metaserver 抖动时误删真实数据）→ 净化每个队伍的 `army` → 校验净化后的数据 → 保存。被丢弃的卡牌复用已有的"移出队伍"逻辑（`buildCardRemovalPatch`）自动清空 `teamId`、扣空 `currentTroops`、退 80% 训练资源——即"空闲状态"。`getTeams` 同步做一次自愈：读取时净化数据库里已存在的脏数据（如迁移前遗留的旧队伍）并回写一次，之后不再重复触发；`meta` 不可用时原样返回，不做破坏性清空。
- 客户端 `client/src/game/meta/teamTroops.ts` 的 `isLegacyTeam`（已是死代码，生产 UI 早已无引用——`TeamsScene.ts` 在更早的重构里被删掉了）连同测试一并删除。

**测试**：`server/worldsvc/test/teams.e2e.test.ts` + `card-slg.e2e.test.ts` 里引用旧原始 `{unitType,initialHp}` 格式的用例（迁移后从未更新过）改成卡牌格式；新增 3 例覆盖本次修复的实际行为——`setTeams` 丢弃失效 `cardInstanceId`（卡牌已被消耗/喂卡）并释放退款、`getTeams` 自愈直接写入数据库的脏数据并释放退款（幂等，不重复退款）、`meta` 不可用时 `setTeams`/`getTeams` 均不破坏已存数据。worldsvc 全量 e2e 串行跑通（33 文件 / 284 例）；client/server `tsc --noEmit` 全绿。

## 32. 空闲队伍门禁的并发竞态加固（同一队伍被派出两次）（2026-07-22）

**背景（用户报告）**：只有两支队伍，`Marches (3)` 却出现三条行军单，队伍 2 被派出了两次。§16.9「空闲队伍校验」（2026-07-15，见 §上）本应保证「一支队伍同时只能有一个状态、不能重复出征」，但仍被绕过。

**根因**：`combatMarch.ts` 的 `startMarch` 是**先查后插**——先 `findOne(marches)`+`findOne(occupations)` 判队伍是否忙碌（无命中才继续），最后才 `insertOne` 落行军单。两步之间隔着多个 `await`，Node 事件循环会把两个几乎同时到达的同队伍出征请求交错处理：两者的 `findOne` 都在对方 `insertOne` 之前返回"空闲"，于是双双插入 → 同一队伍两条行军单。触发路径是客户端的在途窗口：玩家给格子 A 选了队伍 2 出征，服务端还没返回、`ctx.marches` 未刷新前，又给格子 B 选同一支队伍 2——`showTeamPicker` 的忙碌灰显只看 `ctx.marches`/`ctx.occupations`，此刻两者都还不含这笔在途单。

**修复（双层）**：
- **客户端**（`client/src/scenes/worldmap/WorldMapNet.ts`）：新增 `pendingTeamIds` 集合，`doMarchTeam` 在发请求前把 `teamId` 记为 in-flight、`finally` 里移除；`showTeamPicker` 的 `busyTeamIds` 并入 `pendingTeamIds`，`doMarchTeam` 开头也再挡一道（命中直接提示 `team.busy`）。堵住"响应回来前二次派同一队伍"的人类快速点击窗口。
- **服务端**（权威兜底，`server/worldsvc/src/db.ts` + `combatMarch.ts`）：`marches` 集合加 `{worldId,ownerId,teamId}` **partial-unique 索引**（`partialFilterExpression: {teamId:{$exists:true}}`）。带队行军单是集合里**唯一**带 `teamId` 的文档——散兵行军无 `teamId`、撤军是改写同一 `_id` 成 return 腿、到点行军单 `findOneAndDelete`——所以该索引原子地禁止「同队伍第二条在途行军单」，正好补上先查后插关不掉的竞态。`startMarch` 的 `insertOne` 捕获 E11000 → 抛 `TEAM_BUSY`（此时尚未扣兵力池，玩家状态无副作用）。索引构建 best-effort try/catch 包裹：万一线上已存在本 bug 造成的重复在途单导致建索引失败，只告警不 crash 启动（行军单几分钟内到点消解，下次重启即可建成；期间靠 `findOne` 预检 + E11000 兜底）。

**验证**：client + worldsvc `tsc --noEmit` 全绿。竞态本身依赖并发时序、preview 无法稳定复现，改动为逻辑门禁层。

## 33. 占领无主地误报「领地失守」修复（2026-07-22）

**背景（用户报告）**：每次占领（occupy）一块**本就不属于自己**的地块时，屏幕都会闪一次「领地失守」（`world.defendLost`）的提示。

**根因**：自 ADR-037 起，occupy 到达会先与目标格的 NPC 守军打一场权威 PvE 战斗（`combatSiege/occupation.ts` `applyOccupy`），打赢即进入占领驻守倒计时（`startOccupationHold`），并向**占领者本人**推送一条 `SiegeResult`（`outcome:'attacker_win'`，`pushSiege(m.ownerId,…)`）。但客户端 `WorldMapNet.applySiegeResult` 只凭 `myAttackTiles.has(tile)` 区分「这仗是我打的还是我在被打」，而 `myAttackTiles` 只在 `kind==='attack'` 时记录目标格（`doMarch`/`doMarchTeam`）——**occupy 从未登记**。于是玩家自己的占领结果落进「我是防守方」分支，看到 `attacker_win` 就弹「领地失守」；占领失败时同样错判成「守土成功」（`world.defendHeld`）。

**修复（纯客户端）**：
- `WorldMapContext` 新增 `myOccupyTiles` 集合，与 `myAttackTiles` 并列但语义分开（占领是「我主动去打」而非「敌人打我」）。
- `doMarch`/`doMarchTeam` 在 `kind==='occupy'` 时把目标格记入 `myOccupyTiles`。
- `applySiegeResult` 增加 occupy 分支：命中 `myOccupyTiles` → 轻量 toast（打赢 `world.occupyWin`「占领得手，驻守中」/ 未赢 `world.occupyLoss`「占领失败」），收到即从集合移除；**不弹**围攻复盘弹窗（占领是高频扩张动作，不像 PvP 围攻值得每次弹窗+复盘）。三语文案齐备。

**验证**：client `tsc --noEmit` 全绿；新增 `worldMapSiegeResultToast.ui.ts`（6 例：占领胜/败分类、消费后不复触发，及 attack/防守两条原路径回归），占领选队测试补 `myOccupyTiles` mock。preview 无法稳定复现（需完整 worldsvc + 连地相邻 + NPC 战斗），改动为纯分类/展示层，靠单测覆盖。

