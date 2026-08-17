# SLG 实现记录 §34–§49（2026-07-22 ~ 2026-08-01）

> 从 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) 拆出（2026-08-17，原文件 2011 行）。**小节编号沿用原文，不重新编号**——源码注释里的 `SLG_DESIGN_LOG.md §N` 引用照旧有效。
> 核心设计以 [`SLG_DESIGN.md`](SLG_DESIGN.md) §0–14 为准；分册总览见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)。
> 相邻分册：[`SLG_LOG_S21-S33.md`](SLG_LOG_S21-S33.md)（在先）、[`SLG_LOG_S50-S63.md`](SLG_LOG_S50-S63.md)（后续）。

---

## 34. 地图尺寸放大 500×500 → 1500×1500（ADR-049，2026-07-22）

**背景（用户报告）**：最远缩放档（L3，一屏约 96×50 格）下整张 500×500 地图约只有三屏大小，10 个州（ADR-034 环形布局：6 外围+3 资源+1 霸业）+ 险地/州府/城池等 PvE 关卡内容"展示不开"，视觉上过于局促。用户拍板对齐主流 SLG 常见量级 **1500×1500**。

**改动本体**：`server/shared/src/slg/core.ts` 的 `SLG_MAP_W`/`SLG_MAP_H` 由 500 → **1500**（225 万格）。这是唯一的"内容"改动——全部下游几何均为比率制（州环半径 `PROVINCE_*_RADIUS_RATIO`、州府 `provinceCapitalPositions` 用 `halfDiag`、地块等级 `_normRadius`、险地/资源密度逐格 Bernoulli），随尺寸**等比缩放**：密度不变，只是画布变大。险地数（p≈0.003）~750 → ~6750，州府/城池节点仍固定 10/54 个（角度环形，与面积无关）。

**为什么无性能回归（改前已核实）**：① 地块**稀疏落库**（只存被占/改动格），`proceduralTile` 按视口即时算，DB 不会凭空多出 225 万文档；② 视野/渲染均为**视口 bbox 限定的 Mongo 查询 + clamp 循环**，无 O(mapW·mapH) 全图遍历——`core/vision.computeVisionSources`（含 getMarches 传全图范围时也只按 `ownerId` 索引返回自己/家族格）、客户端 `occupyFrontier`/`fog` 循环均 clamp 到视口；③ `_worldCityNodes` 固定 54 节点带缓存；④ A\* 行军 `findMarchPath` 有 `MAX_NODES=500_000` 安全帽（1500² 下=全图 22%，合法长途行军够用；触顶 → `null` → `combatMarch` 干净抛 `PATH_BLOCKED`，不挂起）。U14 A\* 关注点在更大图上略升但受帽约束，登记为监控项（SLG_DESIGN §U14）。

**运维生效路径（关键陷阱）**：`mapW/mapH` 在 `openSeason` 经 `$setOnInsert` **写死进 world 文档**，`getSeason` 返回存库值——故仅改常量**不会自动改变现有世界**（旧世界 `w.mapW` 仍冻结在 500，而生成/出生点/边界用常量 1500，会不一致）。本轮顺带让 `resetSeason` 的 `$set` **re-stamp `mapW/mapH`**（`server/worldsvc/src/season.ts`，与它早已 re-pin 的 `engineVersion` 同理：reset 清空全部 tiles/nations 并按 `deps` 重建州府，回收世界必须采用当前尺寸）。因此现有大区经正常「结算→重置」即可采用新尺寸；全新 worldId 天然拿到 1500；dev 直接起新库（`local-up.ps1 -Fresh`）。

**客户端零改动**：`WorldMapScene` 全程用 `getSeason` 返回的 `mapW/mapH`、渲染视口化；`constants.ts` 的 `DEFAULT_MAP_SIZE` 早已是 1500 且仅为加载前占位（注释此前写"server default 1500"是历史错位，现与实际一致）。

**验证**：`server/shared`+`worldsvc` `tsc --noEmit` 全绿；worldsvc **285 e2e**（在新 1500 尺寸下真实生成地图）全绿；`season-ops.e2e.test.ts` 新增 1 例（seed 一个 `mapW=500` 的旧世界 → settle → reset → 断言 `mapW/mapH` 被 re-stamp 成 `SLG_MAP_W`），共 10 例全绿。可见效果需完整 worldsvc + 新开世界 + 登录入图，本会话未起全栈截图核对。

**未处理/留待**：① 更大图放大了"孤立据点四周空白"观感（§1008 既知），如需改善从中立地装饰密度/初始镶机位入手；② 横断行军实时时长约 ×3，属 SLG 类型常态，用户已认可；③ "一屏俯瞰全图的最远战略档（L4）"本轮**不做**（用户拍板暂缓），但地图越大越需要，登记为后续候选。

## 35. 出征队伍编辑器：兵力读数 + Fill/Clear/Save 移入标题栏（2026-07-22，用户请求）

**背景（用户请求）**：`DefenseEditorScene`（attack 模式，即出征队伍编辑器「Edit Team N」）此前把两组信息放在**底部页脚**——左下角兵力读数（`Garrison / Troops(committed) / Troop pool`）+ 右下角 `Fill troops / Clear / Save` 三键。用户在截图上画箭头，要求这两组"放到上面去"。

**实现（仅改 attack 模式）**：
- 页脚整条取消（`renderFooter` 收窄为 defense 专用：建筑/驻军计数 + 提示 + Clear/Save）。attack 模式改为把两组控件画进**标题栏空白区**（叠在已 bake 的 header chrome 上，与 defense 的 base-level stepper / 通用货币读数同一套路）：兵力读数居左（back pill 右侧，按需缩放避让居中标题）、`Fill/Clear/Save` 三键居右，均在 header 内垂直居中。
- 抽出 `renderActionButtons(rightEdge, top, rowH)` 共享右对齐按钮簇（Fill 仅 attack；defense 页脚与 attack 标题栏共用），并抽 `titleText()` 供标题与读数避让测量复用。
- 页脚消失后棋盘/名册 `gridBottom` 由 `h - FOOTER_H - 4` 放宽到 `h - 4`；按卡分兵 stepper（`renderAllocateStepper`）锚点由 `h - FOOTER_H` 改为 `h`（贴屏底）。defense 模式布局完全不变（其 header 右上角已被 base-level stepper 占用）。

**验证**：client `tsc --noEmit` 全绿；`defenseEditorFillTroops`/`defenseEditorAttackCards` 共 17 例 UI 测试全绿（均直调方法/读私有几何，不依赖按钮坐标）。另用临时 headless 用例读回 `this.hits`：attack 三键落在 header 带内（headerH=230 下 y=100，左→右 Fill/Clear/Save），defense 两键仍贴底（y≈1876），验证后删除。真实入图需完整 worldsvc + 登录 + 进城，未起全栈截图。

## 36. 地图基地血条悬空过高修复（2026-07-22，用户截图报告）

**背景（用户截图报告）**：地图上敌方基地受损时头顶的 HP 血条，离建筑本体（帐篷营地）明显偏高，飘在半空、靠近路过的行军单位，看不出是这座基地的血条。

**根因**：`WorldMapRenderer/city.ts` 的城市图层血条（ADR-026 §1，专为遮住地块层血条的 3×3 建筑精灵补画一份）把纵向偏移写死为 `-sprite.height * 0.9`——即"整格画布高度的 90% 处"。但 `city_atlas`/`playerbase_atlas` 每格固定 256px 正方画布，各档位建筑素材实际占高差异极大（`pack_city_atlas.js` 底对齐合成，素材上方留白不等）：一级营地（帐篷+旗）实测只填满画布底部约 50%（`contentTop≈0.50`），十级大城几乎填满整格（`contentTop≈0.02`）。血条按固定 90% 高度定位，对矮建筑就飘在素材实际顶部之上一大截空白里；等级越低越明显——恰是截图里的一级营地。

**修复**：
- `art/slg/slg-building/pack_city_atlas.js` + `art/slg/slg-playerbase/pack_playerbase_atlas.js`：合成时已经算出内容在格内的实际高度（`fm.height`），顺手算出 `contentTop = (CELL - fm.height) / CELL` 写进各自 `*_atlas.json` 每帧的自定义字段（PIXI Spritesheet 解析器会忽略未知字段，不影响正常纹理加载）。跑了两个脚本重新生成两份 atlas（图像字节不变，只多了 JSON 字段）。
- `cityAtlasLoader.ts`/`playerBaseAtlasLoader.ts` 新增 `getCityContentTopFracForLevel`/`getPlayerBaseContentTopFracForLevel`，直接读原始 JSON（不经过 `sheet.textures`，因为 Texture 对象不带这个自定义字段）解析出对应帧的 `contentTop`；旧 atlas（无该字段）回退 0。
- `WorldMapRenderer/city.ts`：血条纵向偏移由 `-sprite.height*0.9` 改成 `-sprite.height*(1-contentTopFrac) - barH - gap`——即素材实际顶边再加一点小间隙，取代整格画布的固定比例；同时按 `tile.mine ? playerbase 纹理来源 : city 纹理` 的既有 fallback 逻辑镜像选取对应的 `contentTopFrac` 来源。

**验证**：client `tsc --noEmit` 全绿。真实入图需完整登录+一个正被围攻的敌方基地，未起全栈；改用离线渲染核对——直接截取重新生成的 `city_atlas.png` 对应帧，套用代码里的公式画出 OLD/NEW 两条血条位置对比：一级营地（`city_lv1`）新位置紧贴帐篷/旗帜顶部，旧位置飘在空白画布上方一大截，与截图里的 bug 完全吻合；三级/四级（`city_lv3`/`city_lv4`）新位置也更贴合尖塔顶端，无回归。

**测试**：新增 `cityAtlasContentTop.ui.ts`（7 例，用真实打包好的 atlas JSON，不 mock）——逐级/逐帧核对 `getCityContentTopFracForLevel`/`getPlayerBaseContentTopFracForLevel` 与 JSON 里的 `contentTop` 完全一致、无级图退回三级图的 fallback 分支、越界等级 clamp 到 [1,10]，以及直接断言"一级营地 `contentTop` 明显大于十级大城"（即 bug 的形状本身）；`cityAtlasContentTopFallback.ui.ts`（2 例，mock 一份不含 `contentTop` 字段的旧版 atlas JSON）验证回退到 0 而非 `undefined`/`NaN`（血条公式会直接乘这个值）。`worldMapBaseHpBar.ui.ts` 补 1 例：mock `getCityContentTopFracForLevel` 返回值分别代表"矮建筑"和"高建筑"，断言矮建筑的血条落点更靠近地面而非固定处——即 city.ts 确实用上了这个值，而不只是数据层算对了。两个 getter 顺手去掉了不必要的 `!sheet` 门（该值来自 bundle 内 JSON，不依赖 PNG 解码完成，门控只是抄了纹理 getter 的套路，且挡住了脱离场景直接单测）。UI 测试套件全量跑一遍：764/766 通过，另 2 例失败（`modalScaleAndBackButton.ui.ts` 的 EquipmentScene 弹窗缩放）与本次改动无关——同一共享检出里另一会话正在合并的 in-flight WIP（`server/metaserver/src/equipment.ts` 等仍处于 `MERGE_HEAD` 未提交状态）。

## 37. 占领面板补充资源类型/等级 + 建议兵力（2026-07-22，用户截图请求）

**背景（用户截图请求）**：中立地块的 Occupy 确认弹窗（`WorldMapInput.onTileClick` 中立地块分支）只有标题+坐标，玩家看不到这块地的资源类型、等级，也不知道该派多少兵才够打赢系统驻军，只能凭感觉出兵。

**实现**：`WorldMapInput.ts` 该分支的弹窗行新增两行——① 资源类型 + 等级（`world.resLevel` = `'{res} · Lv.{lv}'`，资源名复用既有 `world.ink/paper/graphite/metal/sticker` 词条；`SLG_GEN.resourceDensity=1.0` 下几乎所有中立地都带 `resType`，无该字段则跳过这行）；② 建议兵力（`world.recommendTroops` = `'建议兵力 {n}'`，取 `@nw/shared` 的 `npcGarrison(level)` = `NPC_GARRISON_PER_LEVEL(120) × level`——占领结算走 `combatSiege/occupation.ts` 时，未被占过的中立地系统驻军就是现算的这个值，同一份口径，不是另起一套估算）。三语言词条（zh/en/de）同步补齐。真实战斗走完整引擎模拟（卡牌/装备加成），这个数字是无卡牌情况下的参考线，不是精确胜负保证。

**验证**：client `tsc --noEmit` + webpack build 全绿；`worldMapOccupyConnectivity.ui.ts` 新增 1 例断言两行文案的具体内容（含 `npcGarrison(3)=360` 的数值）。真实入图同样需要完整 worldsvc + 登录 + 找到一块未占中立地，本会话未起全栈截图核对。

## 38. 部队「移动/驻留」+ 占领后就地驻守（新 `move` 行军种别 + `autoReturn` 开关，2026-07-23，用户拍板）

**背景（用户需求）**：三国志战略版式的「队伍出去后留在原地」体感。此前 SLG 的行军全是「解决即消失」——`MarchKind = attack|reinforce|occupy|sweep|scout|return`，到达即结算（战斗/占领/侦察），地图上的行走 stickman 到点即销毁；占领成功后生存兵化为该地块的 `garrison` 统计、`OccupationDoc` 结算删除 → 队伍被释放（等于「回家空闲」）。用户澄清心智模型：**队伍站在格子上时本来就是空闲，只是「在家空闲」还是「在外空闲」的区别**；三战里是留在原地，且留在原地更合理。

**拍板（两个决定）**：
1. **占领后默认就地驻守**：占领结算后，夺地的队伍默认**留在该格子站立待机（idle）**，持续「占用」该队伍，直到玩家移动或召回；只有队伍勾选了 `autoReturn` 才恢复旧行为（队伍释放=回家空闲，"和现在那样"）。
2. **新 `move` 行军**：点格子 → 弹窗「移动到此」→ 选队伍（team picker，与占领同流程，从主城出发）→ 队伍走过去、**无战斗**、到达后就地驻守。目标允许：**自己的领地/城**，或**空的中立地**（不占领、不宣示归属，只是站在那）。

**新概念「驻留（stationed）」**：一支队伍停在某格子站立 idle，跨重载存活，移动/召回前一直「使用中」。持久化于新 `stationed` 集合（键=tileId，与 `occupations` 同型），部分唯一索引 `{worldId,ownerId,teamId}` 与 marches 的同名索引一起保证「一支队伍同时只处于一种活动态：在途行军 / 占领 hold / 驻留」。

**实现（服务端）**：
- `@nw/shared` `MarchKind += 'move'`；worldsvc `MARCHABLE_KINDS += 'move'`。
- `db.ts`：`TeamTemplate.autoReturn?: boolean`（默认 false）；新增 `StationedDoc` + `stationed` 集合 + 索引。
- `combatMarch.ts`：`startMarch` 加 `move` 分支（要求 teamId；目标必须自有地块或空中立地，非 center/stronghold/bridge/plankway/mid-hold，且该格无他人驻留）；team-based army 抽取 & 空闲门禁 & MarchDoc.teamId 记录三处均纳入 `move`；空闲门禁 `Promise.all` 增查 `stationed`。到达 `applyArrival → applyMove` 写 `StationedDoc`（无战斗）。新增 `recallStationed`（删 stationed → 发 `return` 腿回城，flat army 到达退兵力池、card army 携 0 不重复入账 → 队伍解放）+ `getStationed`。
- `combatSiege/occupation.ts` `settleOccupation`：领有写入后，若有 `teamId` 且队伍 `autoReturn` 非真 → 写 `StationedDoc`（队伍就地驻守）；`autoReturn=true` → 不做额外动作（OccupationDoc 已在 `processDueOccupations` claim-delete，队伍即释放=旧行为）。
- `territory.ts` `abandonTile`：放弃地块顺带 `stationed.deleteOne` 释放该格驻留队伍。
- 门禁 `TEAM_BUSY` 文案更新为「marching, occupying, or stationed」（两处 throw 点 + E11000 catch）。
- `service.ts`/`combat.ts` 转发 `getStationed`/`recallStationed`；`httpApi.ts` 加 `GET /world/stationed` + `POST /world/team/{teamId}/recall-stationed`；`openapi-world.yml` 加 `move` 到两处 kind enum、`Team.autoReturn`、`StationedView` schema + 两个端点。

**实现（客户端）**：`rest:gen` 重生成 `openapi-world.ts`；`WorldApiClient` 加 `getStationed`/`recallStationed`（`startMarch` 的 `MarchKind` 自动含 `move`）；`WorldMapContext` 加 `stationed` 状态 + `stationedTokenRuntimes`；`WorldMapNet` 轮询增拉 stationed、team picker/busy 门禁纳入 stationed、`doRecallStationed`；`WorldMapInput` 自有地块与中立地块弹窗新增「移动到此」（有驻留时改显「召回驻军」）；`WorldMapRenderer/fog.ts` 新增 `syncStationedTokens`——在每个我方驻留格子上放一个 idle StickmanRuntime（播 idle clip，**到达后不销毁**，直到移动/召回），lifecycle 的持续重绘条件与销毁清理同步纳入；`DefenseEditorScene` 攻击队伍编辑加「占领后回城」toggle（存于 `TeamTemplate.autoReturn`）。三语言词条补齐（`world.actMove`/`world.actRecallStation`/`world.stationRecalled`/`world.team.pickTitleMove`/`world.team.noTeamsMove`/`world.team.autoReturn`）。

**已知限制（v1，留作后续）**：① 驻留在**未占领中立地**上的队伍不参与该格防御——他人占领/攻打该地仍只打系统 NPC 驻军，我方驻留队伍不自动应战（玩家可随时召回；召回始终可用，不会永久卡住）；② 他人夺取我方驻留所在地块时不自动清理 stationed（sprite 会留到玩家召回）；③ `autoReturn=true` 采「队伍即释放」旧语义，不额外播放一段回城行军（对齐用户「和现在那样」的参照）。

**验证**：`server/shared` build + worldsvc `tsc --noEmit` 全绿；worldsvc vitest **全绿**，`teams.e2e.test.ts` 新增 2 例（`move`→驻留→召回→再可用；`occupy autoReturn=true`→领有但队伍不驻留）并修正 1 例旧断言（占领结算后队伍现在默认**仍占用**而非释放）；client `tsc --noEmit` + webpack build 全绿。真实入图需完整 worldsvc + gateway + meta + 登录入世 + 派队，本会话未起全栈截图核对（服务端权威逻辑以 e2e 覆盖）。

## 39. 队伍领队图标 + 兵力 carried/cap 显示（2026-07-25，用户截图请求）

**背景（用户截图请求）**：城内 Teams 面板五张队伍卡只靠「Team 1..5」文字区分，用户截图圈出 `Troops 150` 问一句「兵力显示为 当前/最大」，同时问能不能给每支队伍配一张图便于识别，并提了个候选方案——在编队地图上标一个特殊格子，放进去的角色就是该队图标。

**方案取舍（AskUserQuestion 拍板）**：特殊格子方案被否——它把「战术站位」和「身份标识」绑死，换头像要动阵型（阵型是要打仗的），格子空着还得设计回退，且防守编辑器共用同一份场景代码，会平白多出一个没意义的格子。拍板为**显式「设为领队」+ 自动兜底**：`TeamTemplate` 新增 `leaderCardId?: string`（放队伍上而非某个格子，天然唯一）；编队编辑器里选中已上阵的卡即可设为领队（★ 角标 + 金框），不设也没关系——客户端自动回退到全队战力最高的卡，五支现有队伍无需任何操作立刻就有图标。`Garrison N`（其实是卡牌张数，与旁边 `Troops N` 挤在一起容易读成两份兵力）一并改名 `Heroes N` / `武将 N`。

**实现（契约 + 服务端）**：
- `openapi-world.yml` `TeamTemplate` 加 `leaderCardId`（string，可选）；`server/worldsvc/src/db.ts` 镜像该字段，注释写明"必须在 army 中出现，否则被清空"。
- `city.ts` 新增 `withValidLeader(team, army)`：`getTeams`（自愈）与 `setTeams`（保存）都过一遍——`leaderCardId` 若不在当前 `army` 里（卡被卖掉/挪去别队/从阵型里删掉）就整字段删除（不是置 null，避免存量文档里躺一个 null），不因领队失效而拒绝整次保存。
- `rest:gen`/`gen:api:world` 重生成 `openapi-world.ts`/`routes.gen.ts`。

**实现（客户端共享逻辑）**：`teamTroops.ts` 新增两个函数：`teamTroopCap(army, cardInv)` = 各卡 `troopCap()` 求和（把 `DefenseEditorScene.teamCapacity()` 的私有实现提出来共用，避免城内/编辑器/后续新增页面各自重算再次踩"两套账本"的历史坑）；`teamLeaderCard(team, cardInv, equipmentInv)` = 显式 `leaderCardId`（仍在本队 army 里才生效）优先，否则按 `cardPower` 取本队最强卡，同战力按 `cardInstanceId` 排序兜底（避免并列时图标在渲染间跳动）。`cardArt.ts` 新增 `cardInstanceArtUrl(card)`：`defId → CARD_DEFS.unitType → UNIT_ART_URLS` 一步到位，城内团队卡/编辑器统一走它取头像，不会各画各的。

**实现（编队编辑器）**：`DefenseEditorScene` 新增 `Tool.kind:'leader'`——工具栏新增「★ 领队」按钮（与既有「擦除」同一排、同一套 armed/hint 机制），激活后点击已上阵的格子即把该卡设为 `this.leaderCardId`（点空格子提示"请点击有武将的格子"）；`doSave`/`persistTeam` 落盘时校验领队仍在本次保存的 army 里，否则该字段整个不发；`Clear` 顺带清空领队。渲染：`effectiveLeaderId()`（复用 `teamLeaderCard` 的同一套优先级逻辑）算出的领队格子画金色描边 + 右上角 ★，包括从未手动选过、纯靠战力兜底选中的那张——玩家能在编辑器里直接看到"如果现在保存，谁会是图标"。

**实现（团队卡列表）**：`CitySceneCallbacks` 新增 `getSave` 回调（`app/nav/world.ts` 接入 `saveManager.get()`），团队卡右侧新画一个金框头像（`teamLeaderCard` 选出的卡 → `cardInstanceArtUrl` → 复用 `DefenseEditorScene` 的懒加载纹理重绘套路），有头像时名字/状态/子标签文字列宽度收窄让位；兵力子标签从裸数字改成 `carried/cap`（`teamTroopCap` 撑不出上限时——没有 `getSave` 回调——退化回裸数字，向后兼容）；`Garrison N` 文案改用新词条 `world.team.cards`（"Heroes N"/"武将 N"）。`WorldMapNet`/`WorldMapPanels` 的选队弹窗暂未加头像（超出本次截图请求范围，留作后续，弹窗本身的 committed 文案不变）。

**i18n 新增**：`world.team.cards`（复用位替代旧 `world.defense.garrison` 在攻击模式下的调用点）、`world.team.leader`、`world.team.leaderHint`、`world.team.leaderNeedsCard`，三语言（zh/en/de）齐备；`world.defense.garrison` 词条本身保留给防守编辑器（防守模式的建筑/驻军统计与本次改动无关）。

**验证**：`server/worldsvc tsc --noEmit` 全绿；worldsvc `teams.e2e.test.ts` 新增 2 例（`leaderCardId` 随保存/领队离队清空往返；`getTeams` 自愈直接写入文档、army 里不存在的幽灵领队）+ 修正 1 处集合访问器笔误，15 例全绿（需 `docker compose up -d` 起 Mongo）；client `tsc --noEmit -p tsconfig.test.json` 全绿；`teamTroops.test.ts` 新增 `teamTroopCap`/`teamLeaderCard` 8 例；`defenseEditorAttackCards.ui.ts` 新增领队工具 5 例；`cityScene.ui.ts` 更新兩例文案改名断言 + 新增 1 例 carried/cap 断言；全量 `vitest.ui.config.ts`（88 文件）除 5 个与本次改动无关的既有失败（`worldMapBaseClick`/`worldMapScoutDisabled`/`marchTokenAnimation`/`modalScaleAndBackButton`/`worldMapOccupyTeamPicker` 各自的既有断言，主分支同样失败，已核实非本次改动引入）外全部通过。真实入图截图未做——本次纯代码改动，无可交互 dev server 场景需要截图核对（团队卡布局改动细小，头像资源已在编辑器验证过渲染管线）。

## 40. 「我的基地」进图后一闪即消失修复（2026-07-27，用户截图报告）

**背景（用户截图报告）**：进入 SLG 世界地图后地图区域整体空白，右侧 Troops/Territory 状态卡（HUD，不依赖地块缓存）数据正常，唯独玩家自己的基地建筑精灵短暂显示一下就消失，此后不再出现。

**根因**：`WorldMapRenderer/pool.ts` 的 `isBaseAnchor(tx,ty)`——用来判定一格是否是 3×3 基地的中心锚点，从而只画一次城市精灵——要求该格及其 4 个正交邻格**当次调用时**都能在 `tileCache` 里读到 `type:'base'` 且同一 owner。`refreshCityLayer()`（`city.ts`）每次重绘（5s 行军轮询、地块推送、切换缩放级别……）都会重新跑一遍这个判定；判定失败的格子不会被加进当次 `seen` 集合，紧随其后的清理逻辑就会把它已经画出来的城市精灵整个销毁。问题在于：`loadMapViewport()`/`getMap()` 对同一 3×3 的多次刷新之间没有互斥（不像 `WorldMapNet` 别处用 `pendingTeamIds` 挡重复派单那样），一旦两次视口取图请求乱序落地，或某次推送只重取了部分格子，中心格明明还稳稳缓存着「这是我的基地」，某个邻格却可能读到瞬时缺失/陈旧的数据——邻格判定一失手，整座已经画出来的基地精灵就被拆掉，直到某次刷新凑巧四邻格又同时一致才会重新出现。这与截图里「一闪就没」的现象完全吻合。

**修复**：`isBaseAnchor` 新增一条快速通道——命中的地块若 `tile.mine` 为真，直接用 `ctx.me.mainBaseTile`（服务端权威、随 `getMe`/`joinWorld` 一起下发，不依赖邻格缓存是否刚好新鲜）核对坐标是否吻合；吻合就直接判定为锚点，不再逐邻格重新验证。只对「我自己的基地」生效——其他玩家/NPC 的基地没有这份权威坐标可用，仍走原来的四邻格一致性检查，故意保留的"数据不一致就不画"语义没有被放宽。

**验证**：`client tsc --noEmit -p tsconfig.test.json` 全绿。真实入图需要完整登录 + worldsvc 全栈，本会话起 `dev-up.ps1` 时撞上本机另一个遗留问题（各服务 `node --watch` 进程卡在启动阶段、既不监听端口也不写日志，与本次改动无关，已清理掉卡住的进程）——转而用项目里现成的"离线直构 `WorldMapScene`"调试手法（临时在 `entries/web.ts` 加 `?wmdebug` 分支，套一个立即 resolve 的假 `WorldApiClient`，绕开后端）复现了根因并验证了修复：① 正常渲染出「我的基地」后，手动从 `tileCache` 里删掉锚点的一个邻格（模拟乱序/部分刷新留下的瞬时缺口），修复前的逻辑会让 `isBaseAnchor` 返回 false 从而拆除精灵，修复后精灵原样保留（`citySprites` 仍含 `50:50`，`isBaseAnchor` 仍为 true）；② 用同样手法在假地块里放一个敌方基地，人为弄脏它的一个邻格，确认 `isBaseAnchor` 依旧正确判定为 false、精灵不画——快速通道没有波及非本人基地的既有校验语义。调试分支验证完已从 `entries/web.ts` 撤回，代码库里只留下 `pool.ts` 的正式改动。

## 41. 险地/关隘 NPC 守军常量按 TROOP_CAP_BASE=10000 新基线重新拍板（2026-07-27，修复 §27 因 ADR-048 产生的门槛失效）

**背景**：§27（2026-07-16）用真实引擎核验通过的 `STRONGHOLD_GARRISON_PER_LEVEL=360`/`CROSSING_GARRISON_PER_LEVEL=200` 是围绕"新手 `troopCap=2000`"校准的。2026-07-22 ADR-048（兵力池统一）把 `TROOP_CAP_BASE` 从 2000 一次性提到 10000，但这两个守军常量没有同步调整。2026-07-27 重跑 `strongholdCombatRun.ts`（该脚本 import 常量，无需改代码即反映新基线）确认：新手（troops=10000）对险地（守军仍是旧值 3600）和关隘（守军仍是旧值 1800）都已 100% 胜率——"几乎打不过，小额投入即可攻克"的设计意图完全失效，详见 `ECONOMY_VERIFICATION_LOG.md` §13-SLG-STRONGHOLD.5。

**一次绕远路（记录下来避免重复踩）**：第一轮重新拍板直接用真实 `@nw/engine` 攻城引擎（`strongholdCombat.ts` 的 `simulateCapture`）扫描阈值，试图找一个能在"新手必败、投入 2-3 级必胜"之间稳定的守军值。扫描发现这个安全窗口极窄（仅约 100-175 兵），因为 `synthesizeArmy` 的棋盘容量上限（10 车道 × 16 行 × 60 血 ≈ 9,600 兵，见 `strongholdCombat.ts`/`siegeEngine.ts` 注释）现在几乎正好卡在新的 `TROOP_CAP_BASE=10000` 上——任何在这附近的攻防双方都会撞上引擎"棋盘拥堵导致非单调胜负"的老毛病。

排查后发现这条弯路本可以完全避免：2026-07-16 当天**晚些时候**的另一个提交（`13a7af86`，同一天下午）其实已经把 `SIEGE_CHEAP_RATIO`/`shouldUseCheapSiege` 的棋盘溢出保护接入了 `combatSiege/arrival.ts`——只要防守方（或攻击方）的合成兵力超过棋盘容量上限，生产环境就会**直接跳过真实引擎**，改用便宜的线性公式 `resolveSiege`（纯粹比较 `攻方兵力 > 守方兵力`）。但独立于 worldsvc 之外的 `server/tools/econ-sim/src/strongholdCombat.ts`（用于校准这两个常量的核验脚本）从未同步这个分流逻辑，所以第一轮拍板用的模拟工具其实测的是生产环境**根本不会走到**的一条路径，得出的"极窄安全窗口"结论对生产无意义。

**修复**：①在 `strongholdCombat.ts` 里镜像 `shouldUseCheapSiege`/`SIEGE_SYNTH_ARMY_MAX_TROOPS`（与 `siegeEngine.ts` 保持同步，不能 import，因为 econ-sim 不能依赖 worldsvc 服务包），用真实分流逻辑重新扫描；②确认只要守军值本身就超过棋盘容量（~9,600），生产环境**永远**走线性公式，校准退化为一个舒适、以千为单位留有余量的线性不等式问题，不再需要围绕引擎棋盘拥堵调参；③重新拍板：`STRONGHOLD_GARRISON_PER_LEVEL: 360→1180`（守军 11,800 @ level 10，新手必败，练兵场 +2 级必胜）、`CROSSING_GARRISON_PER_LEVEL: 200→1150`（守军 10,350 @ level 9，新手必败，练兵场 +1 级必胜，如设计意图"比险地更早开放"），且保持"关隘常量 < 险地常量"（避免同等级比较时反直觉地反转，`worldsvc/test/passage.e2e.test.ts` 对此有断言）。

**验证**：`strongholdCombatRun.ts` 重跑两个常量均 PASS；`server/shared/test/siege.test.ts`（39）、`server/tools/econ-sim` 的 `strongholdCombat.test.ts`（11，已改写为验证线性分流不变量而非真实引擎胜率）、`server/worldsvc` 全量 e2e（44 文件/338 用例，含 `stronghold.e2e.test.ts`/`passage.e2e.test.ts`/`siege-cheap-fallback.test.ts`）全绿；`tsc --noEmit` 在 `@nw/shared`/`@nw/econ-sim`/`@nw/worldsvc` 三包均通过。`worldsvc` 两组 e2e 测试里假设"6,000 兵吊打旧守军"的用例已按新守军（11,800/10,350）提到 15,000 兵，"12,000 兵满行囊撞棋盘上限"用例的过时注释（"12,000 是满级练兵场+行囊上限"）一并订正为当前真实上限 20,000（ADR-048 同一次改动带来的）。

**遗留跟进（非本轮范围）**：①`STRONGHOLD_GARRISON_PER_LEVEL`/`CROSSING_GARRISON_PER_LEVEL` 现在的"安全余量"是几百到上千兵的线性比较，不再是引擎棋盘拥堵那种脆弱窗口，但尚未针对装备/学院加成（文档记载最高 +20%）做过鲁棒性复核——如果有人把这个门槛当作"精确卡点"而非"大致正确、后续可微调"来依赖，建议先补测；②`shouldUseCheapSiege` 本身已经解决了"棋盘容量 vs 引擎"的根因问题，但这次踩坑说明**校准工具（`strongholdCombat.ts`）和生产分流逻辑（`siegeEngine.ts`）存在重复实现、容易脱节**——两处未来任何一处改动都需要人工同步另一处，值得考虑做成共享模块或加一个"两者行为一致"的跨包契约测试。

## 42. 进 SLG 世界地图的 9 跳请求瀑布合并为单次 `POST /world/enter`（2026-07-27/28，comm-audit-2026-07-27 P1-5）

> 状态：**已实现**。承 2026-07-27 前后端通信全审计（4 个子代理并行扫 meta/world/auction/social 的 REST/WS/契约，产出 15 P0 + P1/P2 backlog，用户拍板"按顺序全部修复"）。本条是 P1 优先级的第 5 项；同批 P1 的 P1-1（`serverClock.ts` 时钟纠偏）、P1-2（世界地图删除 5s 轮询定时器）、P1-3（`startMarch`/`buildWatchtower`/`buildStructure` 响应挂 `me`，顺带修正 `abandonTile`/`buySlgShopItem` 契约错报）已在 `ea8f569c` 提交；本条完成收尾。

**背景**：`WorldMapNet.loadData()`（进 SLG 地图时唯一入口，`WorldMapScene` 构造函数里 `void ctx.net.loadData()`）原本依次/半并行发 9 个请求：`getSeason`→`getNations`→`getMe`→`joinWorld`→（据 `me.mainBaseTile` 定位相机后）`getMap`/`getMapSparse`→`Promise.all([getMarches, getOccupations, getStationed])`→`getWorldChannel`。前 6 跳里 `getMap` 真正依赖 `joinWorld` 的结果（相机需先按 `mainBaseTile` 居中才能算出视口窗口 `cx/cy`），其余请求彼此独立、只是凑巧写成了顺序代码。

**方案**：把「先解出 base tile 再决定地图窗口」这一步整体挪到服务端——worldsvc 新增 `WorldService.enterWorld(worldId, accountId, r, zoom)`（`server/worldsvc/src/service.ts`）：内部先 `getMe`→`joinWorld`（复用既有 ADR-025 heal-on-entry 语义不变），从解出的 `mainBaseTile` 直接算 `cx/cy`（无基地/世界满员兜底为地图几何中心），再用 `Promise.all` 并发拉 `season`/`nations`/`map`或`mapSparse`（按 `zoom` 二选一）/`marches`/`occupations`/`stationed`。`r`（视口半径）由客户端自己算好传入——它只取决于画布尺寸，不依赖尚未知道的相机中心，`WorldMapRenderer/viewport.ts` 的 `viewportCenter()` 本来就把这两者分开算。`nation/channel`（世界频道，本就没有 openapi-world.yml 契约声明，遗留缺口记为 P2）由 `httpApi.ts` 的 `/world/enter` 路由处理器并行拉取后拼进最终响应——保持 `WorldService` 的组合逻辑不依赖兄弟服务 `NationChannelService`，方便独立单测。`justJoined`（是否本次首次落户，用于"这是你的新家"欢迎 toast）改由服务端算好回传——原客户端逻辑靠"先读一次 getMe 存 wasJoined，再读一次 joinWorld 结果比较"，一旦两次读并成一次就再也看不到中间态，故服务端在 `joinWorld` 调用前后各取一次快照算出该布尔值直接下发。

**未改动**：`WorldMapNet` 的 `loadMapViewport()`/`refreshMarches()`/`refreshWorldChat()`/`refreshMe()` 四个方法本身保留不动——它们在平移换视口、点击后局部刷新、5s 行军轮询（P1-2 已删的是*进图时*那次，其余轮询点未受影响）等场景下仍被独立调用；只有 `loadData()`（进图那一次性入口）改为调用新的 `enterWorld()` 单次聚合请求。

**契约**：`server/contracts/openapi-world.yml` 新增 `POST /world/enter`（`worldId` + `r` + `zoom` 请求体；响应聚合 `season`/`nations`/`me`(含 `justJoined`)/`map`或`mapSparse`/`marches`/`occupations`/`stationed`/`worldChannel`）。`season` 字段声明为 `nullable`（世界文档未建时 `getSeason` 本就返回 `null`，客户端相应地保留旧代码"season 拉取失败则维持默认 mapW/mapH"的降级路径，没有像 P0 那批 bug 一样对 null 解引用）。worldsvc 路由仍是手写 `if (method/path)` 分派（无 fastify-openapi-glue），故契约变更需分别跑 `gen:api:world`（重生成 `routes.gen.ts`，CI diff 用，httpApi.ts 路由本身仍手写）与 client 的 `rest:gen`（`openapi-world.ts`）。

**测试**：`server/worldsvc/test/enter-world.e2e.test.ts`（新增，4 例，真实 Mongo）——首次进入即 join 且 `justJoined:true`、地图窗口覆盖新基地锚点；二次进入 `justJoined:false`；`zoom` 2/3 出 `mapSparse` 不出 `map`；未建世界文档时 `season` 为 `null`（契约可空分支的回归覆盖）。

**验证**：`server/worldsvc`、`server/metaserver`、`client`（`tsc --noEmit`）三包全绿；`server/worldsvc` 全量 vitest 45 文件/345 例全绿；`client` 单元 112/794 + UI 92/807 全绿；contract codegen（`bundle-openapi.mjs --check` / `gen-openapi-server.mjs --check` / `gen-openapi-world.mjs --check`）三者均 check-passed，无漂移；`client` 生产 webpack 构建（`build:web`）成功。未做真人截图走查——本机 Docker Desktop 的 Linux engine 未起（`docker ps` 报 npipe 不可达），也没有原生 Mongo/Redis，无法拉起完整后端栈；改以贴近生产路径的真实 e2e/单元测试作为验证证据（同 §40 一次遇到 dev-up.ps1 卡住时的既有先例）。

## 43. comm-audit-2026-07-27 P2 契约治理清理项——分拣结果（2026-07-28）

> P1 全部收尾（§42）后，按原审计留下的 8 项 P2 backlog（契约治理/死代码清理，优先级低于 P0/P1，原计划"有时间再做"）逐项核实现状再决定取舍，而非照单全收地全改——8 项里有 2 项审计当时的判断本身已经不成立，动手前先核实省下了返工。

**已修复（2 项，风险小、范围明确）**：
- **协议字段 `world_event`（`transport.proto`）确认死代码**：字段设计于 `SLG_DESIGN.md`§一个"赛季事件推送"草案，但 `Gateway.ts` 的推送分派 `switch`（`toServerMsg`）从未加过对应 `case`，client 也没有任何地方读 `message.worldEvent`——从 `nation_msg` 上线后就被后者取代，纯遗留占位。按本仓既有先例（`JudgeRequest reserved 7,9`，2026-07-26 移除 `pve_upgrades`/`unit_levels` 时立的规矩）在 `ServerMsg` 内加 `reserved 22;` + 说明注释，删除 `world_event` 字段本体与整个 `WorldEvent` message 定义，`metaserver`/`gateway`/`gameserver`/`botsvc`/`client` 五处各自 `npm run proto:gen` 重新生成。
- **`progression.ts` 错误码/HTTP 状态错配**：`claimBattlePass` 的 `PASS_REQUIRED`（付费轨未购买）分支原写成 `reply.code(403).send(err(ErrorCode.NOT_FOUND, ...))`——HTTP 403 配了语义为"未找到"的 `ErrorCode.NOT_FOUND`，与本仓共享的 `ERROR_HTTP_STATUS[NOT_FOUND]=404` 映射表不一致（worldsvc/auctionsvc/socialsvc 都统一走这张表，metaserver 因为手写 `reply.code(N)` 才会在个别点位跟表脱节）。改用语义相符、同样映射到 403 的 `ErrorCode.NO_PERMISSION`（`economy.ts:446` 的"growth pack window closed"已是同一用法的先例）。

**核实后判定无需修复（2 项，原审计误判）**：
- **`defense_json`"死字段"判定不成立**：该字段其实是 SLG 攻城 headless 判定重放的活跃载荷（`judgeRunner.ts` 的 `runSiegeJudge` 分支），2026-07-26 的提交还专门把新字段类比它的"opacity contract"——原审计这条结论有误，予以撤销，不做任何改动。
- **"meta/socialsvc 社交端点重复实现"判定不成立**：`server/metaserver/src/service/social.ts` 除 `claimMail`（文件头注释已说明：socialsvc 原子标记领取态，meta 负责实际发货，职责分工非重复）外，其余全部是纯代理转发，未发现重复业务逻辑。

**明确推迟（4 项，需要独立会话，本轮不动）**：
- **`world`/`auction`/`social` 三份 openapi 契约缺 4xx/5xx 错误响应声明**：核实属实（三份契约 100% 路径都只声明了 `'200'`，且均无 `ErrorResp` 组件），添加本身对代码生成零风险（生成脚本对无 `content` 的 `$ref` 响应本就静默跳过），但体量不小（约 90 个 path，需逐个补两三行），留作下一轮契约治理任务单独做，不跟这次的 P1 收尾混在一起。
- ~~`/pve/upgrade` 死代码清理~~ **已于 2026-07-30 完成**：契约片段（`openapi/paths/pve.yml`）删除该 path → 重跑 `gen:api:contracts`/`gen:api:server` 更新两处生成产物 → 服务端 `pve.ts` 删 handler + `PveHandlers`/`MetaHandlers` 类型收窄 → 顺手清掉 `@nw/shared/pveRewards.ts` 里同样孤儿的 `PVE_UPGRADE_COSTS`/`findPveUpgrade`/`pveUpgradeCost`（唯一调用方就是这个 handler）→ client `ApiClient`/`SaveManager` 删对应方法 → 两侧既有 e2e/单测改写。`SaveData.pveUpgrades` 字段本身保留（L0 反作弊比对只读用途），只是再也没有写入路径。`tsc -b`/`tsc --noEmit` 两端全绿，metaserver 相关 e2e（pve/achievements/internal-economy/pve-verify 共 60 例）+ client `save-manager.test.ts`（43 例）+ shared `pveRewards.test.ts`（24 例）全部转绿。
- ~~`SERVER_API.md` §3/§8.4 与实现严重漂移~~ **已于 2026-07-30 完成**：逐条核对 `transport.proto`（而非 `Gateway.ts`，proto 本身就是文档头部声明的单一真源）重写 §3.1（补 4 个遗漏的 `ClientMsg` case）、§3.2（9→24 个 `ServerMsg` case 全量）、§8.4（protobuf-only 订正 + 用真实消息集替换掉从未实现过的 `mm_enqueue`/`mm_cancel`/`mm_status`/`presence`）。纯文档改动，无代码变更。
- **`GET /save` 响应瘦身**：`EQUIPMENT_DESIGN.md`§已有明确记录——"阶段二"瘦身已在 2026-07-26 为五个装备操作端点做过，`GET /save` 当时就被**有意排除**在外（该响应本来就要带材料/金币/进度等大量必需字段，瘦身收益不如那五个纯装备接口），本轮若要重新动它等于推翻两天前才做的、有理有据的决定，需要重新论证再改，不在本轮范围内。

**验证**：`server/metaserver`/`server/gateway`/`server/gameserver`/`server/botsvc`/`client` 五包 `tsc --noEmit` 全绿；对应 vitest 全量分别为 metaserver 56/697、gateway 3/27、gameserver 3/46、botsvc 9/39、client 单元 112/794，均绿（worldsvc 未受本轮 P2 改动影响，沿用 §42 的 45/345）。`grep WorldEvent` 确认五处生成产物均已清除。

## 44. 队伍槽默认名被冻结成保存当时的语言——`Team N`/`队伍 N` 混排（2026-08-01）

> 用户截图反馈 Home City 的 5 个队伍槽里，Team 1/2/4/5 显示英文、队伍 3 显示中文，同一存档混排两种语言。

**根因**：`teamSlotName(i)`（[`teamTroops.ts`](../../client/src/game/meta/teamTroops.ts)，§227 提到的"v1 不做自定义命名"槽位默认名）本是纯展示层的实时兜底——`CityScene/render.ts` 一直用 `team?.name || teamSlotName(i)`，理应随语言切换即时变化。但 `DefenseEditorScene/data.ts` 的 `persistTeam()`（编队编辑器"保存"路径）此前把打开编辑器那一刻算出的 `teamName`（即当时语言下的 `teamSlotName(i)` 快照）当成字面字符串写进 `TeamTemplate.name` 并持久化。这个字面字符串此后再也不会重新翻译——玩家在中文界面下保存过某个槽，该槽就永久定格成"队伍 N"，即使后来把语言切回英文；不同槽第一次保存时界面语言不同，就会出现同一存档里几个槽中文、几个槽英文的混排。

**修复**：`persistTeam()` 不再把 `teamName` 写入 `name` 字段，固定写 `''`（[`data.ts:136`](../../client/src/scenes/DefenseEditorScene/data.ts)）。`TeamTemplate.name` 契约上仍是必填 `string`（`openapi-world.yml` `TeamTemplate.required` 含 `name`），空串是合法值；`render.ts` 的 `team?.name || teamSlotName(i)` 把空串当"无自定义名"处理，因此永远走 live 翻译。`teamName`（`cb.target.teamName`）继续保留，仅用于编辑器头部标题（`base.ts:229` `world.team.editTitle`），不再被写回存档。产品决策（AskUserQuestion 拍板）：暂不做自定义命名 UI——队伍槽本身只是编队容器，领队头像（§`leaderCardId`，见上文"设为领队"条目）已经解决辨识度问题，自定义命名的收益不足以覆盖输入框+敏感词过滤的成本；固定格式+ 永远随语言实时渲染即可。

**遗留**：已经写坏的旧存档（字面存了 `Team N`/`队伍 N`）不会自动愈合，要等玩家下次打开该槽的编队编辑器并保存才会清空为 `''` 转回实时渲染；未做批量数据迁移（本轮判定收益不足以覆盖风险，属于"自愈式"轻量修复）。

**验证**：`client` `tsc --noEmit` 全绿；新增 2 例回归——`defenseEditorAttackCards.ui.ts`「save 不把 teamName 冻结进 `TeamTemplate.name`」（存入自定义 `teamName='队伍 1'` 断言存档 `name` 仍为 `''`）+ `cityScene.ui.ts`「`name:''` 的队伍回退到实时槽位名而非空白」；连同既有 `teamTroops.test.ts`（14）/`defenseEditorAttackCards.ui.ts`（12）/`defenseEditorFillTroops.ui.ts`（10）/`cityScene.ui.ts`（32）共 68 例全绿。

## 45. 战报列表坐标可点跳转（2026-08-01）

> 用户截图反馈「Battle replays (last 100)」列表两个问题：①部分占领/攻城失败的行没有录像按钮；②行首坐标 `(x,y)` 不可点，无法快速跳到该地块。

**① 为什么有的战斗没有录像**：`hasReplay`（[`combatDefense.ts:147`](../../server/worldsvc/src/combatDefense.ts)）只在 `recordSiege` 落库时 `seed`+`attackerArmy` 都存在才为真。这两个字段何时缺失有两种设计内因果，均非 bug：
  - **引擎真的崩溃**（`try { runSiegeBattle(...) } catch`，六处调用点各自 `console.error('[worldsvc] ... siege engine failed — fallback to cheap resolve', ...)` 后把 `replay` 置 `null`）——查了 VPS `server-worldsvc-1` 近 48h 日志（覆盖截图里"0m/10m 前"的时间窗）无一条匹配，排除。
  - **`shouldUseCheapSiege`（[`siegeEngine.ts:107`](../../server/worldsvc/src/siegeEngine.ts)）主动短路**：领地/据点/渡口三类攻城（`arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege`）在进引擎前先判断「攻守比过于悬殊（≥`SIEGE_CHEAP_RATIO`=10 倍）」或「合成兵拼版超出 `synthesizeArmy` 的板面摆放上限（`SIEGE_SYNTH_ARMY_MAX_TROOPS`，与实际强弱无关，纯粹是拼版占用车道数溢出）」，命中则直接走线性公式 `resolveSiege`，`replay` 恒为 `null`——这条路径**不打日志**，是刻意的静默设计（省一次~18600 tick 的引擎运算，见 `siegeWorkerPool.ts` 顶部性能注释）。占领类 `applyOccupy`/`applyOccupationExpulsion`（[`occupation.ts`](../../server/worldsvc/src/combatSiege/occupation.ts)）**不走这条短路**，只有引擎异常时才会没录像。由于崩溃已被日志排除，截图里的无录像行大概率是攻城/据点/渡口类走了 `shouldUseCheapSiege`；具体是哪一类需要该玩家的实际行军数据才能坐实（`sieges` 落库时未存 army 明细，事后无法反推），暂未做代码改动——按设计运作，非缺陷。

**② 坐标可点跳转**：[`WorldMapPanels.renderReplayPanel`](../../client/src/scenes/worldmap/WorldMapPanels.ts) 原来整行 `(sx,sy) Lv.N 角色·结果 时间` 是一个不可交互的 `txt()`。拆成两段：坐标 `(sx,sy)` 单独一个 `C.accent` 加粗文本 + 注册进 `ctx.modalBtnRects` 的命中矩形（同 Territory Overview 列表 `territoryJump` / 行军列表已有的 `centerAt(tx,ty)+renderMap()+closeModal()` 跳转模式），其余文字保持原有胜负配色（`C.dark`/`C.red`），紧跟在坐标文本右侧。

**验证**：`client` `tsc --noEmit` 全绿；新增 `worldMapReplayPanel.ui.ts`（2 例：点击第一行/第二行坐标分别精确带各自的 `(x,y)` 调用 `centerAt` 并关闭弹窗）；`test/ui/worldMap*` 全量 15 文件/112 例全绿；`client` 生产 `webpack --mode production` 构建成功（仅预存的资源体积告警，与本次改动无关）。

**追加（用户拍板，同日）**：用户反馈"为了省一点算力却导致无法排查问题本身就得不偿失，希望这类问题永远可以追溯"——把 ①里 `shouldUseCheapSiege` 短路分支的 `replay = null` 全部改为**保留**已经算好的 `{ seed, attackerArmy, defenderConfig, tileLevel }`，四处调用点全改（`arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege` + `encounter.ts` 的字段遭遇战）；`recordSiege` 落库时这些字段本来就已经在 if/else 分支之前算好，只是原来在 cheap 分支里被覆盖成 `null`，改动本身零性能成本。

**再追加（用户进一步拍板，同日）**：用户接着要求"崩溃也全部存，这样才便于查找和复现问题"——原计划里唯一保留 `replay = null` 的引擎真崩溃分支（`catch`）也改成不再置空，六处 `catch` 全改（上面四处 + `occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion`，后两者没有 `shouldUseCheapSiege` 短路，唯一的 `replay=null` 来源就是这个 `catch`）。改动前担心"崩溃输入拿去重放，客户端大概率原样崩溃"，核实后发现风险比想的小：`getSiegeReplay` 的调用链两端都有兜底——服务端 `httpApi.ts` 顶层 `try/catch`（767 行）把任何未捕获异常转成干净的 `500 INTERNAL`，不会打垮 worldsvc 进程；客户端 `world.ts` 的 `goSiegeReplay`（141 行）同样整段包 `try/catch`，拉取/重建失败直接 `goWorldMap` 退回地图，不会崩客户端场景。也就是说存下崩溃现场的输入去复现问题，最坏情况只是"点开录像悄悄退回地图"，换来的是这批输入可以离线喂给引擎单测复现服务端崩溃——对调试价值明显更高，遂采纳。

副作用（已知且接受）：`db.ts` `SiegeDoc.seed`、`combatDefense.ts` `listSieges` 的 `hasReplay`、`combatSiege/helpers.ts` `recordSiege` 三处注释均已更新——现在只有两种情况仍是 `replay=null`：①`applySweep`（无 owner 中立地块清剿，从不构造 army 编队，纯兵力数字过线性公式，没有可存的东西）；②`occupation.ts` 里 `npcGarrison<=0` 的纯"无战斗即时占领"分支（同样没有 army 可存）。除此之外的战报（cheap 路径、真实引擎崩溃 fallback）现在都会存 replay 输入；重放出来的胜负/表现可能跟当时落地结算的 `outcome` 不一致，甚至可能重建失败——都已判定为可接受的既有风险类别（`db.ts:409` 早就写明客户端重放"pure presentation, not authoritative"），不是新引入的 bug。另确认 `applyBaseSiege`（主基地按波次结算，[`arrival.ts`](../../server/worldsvc/src/combatSiege/arrival.ts) 229 行起）本来就无条件存最后一波 replay，跟这轮"全存"策略天然一致，未改动。

**验证（追加两轮）**：`server/worldsvc` `tsc --noEmit` 全绿；更新 4 处受影响的既有 e2e 断言（`siege.e2e.test.ts` ×2、`stronghold.e2e.test.ts`、`passage.e2e.test.ts`——原先断言 cheap 路径"不存 seed/attackerArmy"，现改为断言"存"）；受影响的 6 个测试文件（`siege`/`stronghold`/`passage`/`base-siege`/`field-encounter`/`siege-cheap-fallback`）44 例、`server/worldsvc` 全量 47 文件/373 例两轮均全绿。

**新增专项测试（同日）**：崩溃分支此前没有任何自动化覆盖——真实触发 `runSiegeBattle` 抛异常需要伪造引擎内部状态，现有 e2e 套件没有这类 harness，之前只是读代码+类型检查确认。补了 `test/siege-crash-replay.e2e.test.ts`：文件级 `vi.mock('../src/siegeEngine', ...)` 只把 `runSiegeBattle` 换成永远 `throw` 的假实现，其余导出原样透传（`importOriginal()` 保留 `shouldUseCheapSiege`/`synthesizeArmy` 等真实逻辑）——`vi.mock` 按文件生效，不影响其它测试文件里跑真实引擎的用例。3 个用例：①领地攻城胜（引擎崩溃→线性公式仍判出 `attacker_win`，`sieges` 落库有 `seed`/`attackerArmy`/`defenderConfig`/`tileLevel`，`listSieges` 端到端返回 `hasReplay:true`，`getSiegeReplay` 真的能拉到可重建的 `level`）；②占领进军 PvE（`occupation.ts` 本来就没有 `shouldUseCheapSiege` 短路，触发 cheap resolve 的唯一途径就是这次 mock 的引擎崩溃——验证占领流程本身仍正常进入占领倒计时）；③领地攻城败（崩溃分支下的败仗战报同样可追溯）。三例均全绿，且跑过全量 `server/worldsvc` 48 文件/376 例确认 `vi.mock` 没有泄漏影响其它文件（真实引擎胜负测试都还是走真实引擎，非本文件的 mock）。

## 46. §44 遗漏了世界地图选队弹窗——`占领/移动/驻扎`选队时队伍名整体消失（2026-08-01）

> 用户截图反馈"选择占领队伍"弹窗里 5 个队伍按钮只有一个显示名字（`Team 5`），其余 4 个都只剩 `· Troops NNNN`，名字整段空白。

**根因**：§44 把 `persistTeam()`（[`DefenseEditorScene/data.ts:140`](../../client/src/scenes/DefenseEditorScene/data.ts)）改成永远持久化 `name: ''`，并让 `CityScene/render.ts` 的两处读取点补上 `team?.name || teamSlotName(i)` 兜底，但漏改了另一个直接读 `TeamTemplate.name` 的地方——世界地图行军选队弹窗 [`WorldMapNet.showTeamPicker`](../../client/src/scenes/worldmap/WorldMapNet.ts)（`占领`/`移动`/`驻扎`/`攻击` 共用同一个弹窗）之前直接拼 `` `${tm.name} · ...` ``，从不兜底。§44 落地当天起，任何重新在编队编辑器里保存过的队伍槽 `name` 都变成 `''`，这个弹窗里就直接显示空白；用户截图里唯一显示名字的"Team 5"是尚未在 §44 之后重新保存过、还留着旧的字面 `"Team 5"` 字符串的槽位——同一存档里几个槽有名几个槽空白，是 §44 遗留问题的延续，不是新 bug。

**修复**：把"`name` 为空时按 `t{n}` id 换算实时槽位名"这段逻辑从 `CityScene/render.ts` 提炼成 [`teamTroops.ts`](../../client/src/game/meta/teamTroops.ts) 的共享 helper `teamDisplayName(team)`（`team.name || teamSlotName(parseInt(id 中的 n) - 1)`），`WorldMapNet.showTeamPicker` 改用它而不是裸 `tm.name`。`CityScene/render.ts` 的两处 `team?.name || teamSlotName(i)` 逻辑等价（`i` 本来就是正确的槽位序号），未改动，避免无谓改动已工作的代码。

**验证**：`client` `tsc --noEmit` 全绿；新增回归 `worldMapOccupyTeamPicker.ui.ts`「`name:''` 的队伍（id `t3`）在占领选队弹窗里回退显示实时槽位名 `Team 3`」；`--config vitest.ui.config.ts` 全量 102 文件/862 例全绿。

## 47. 行军「回城需要时间」统一改造 + 卡牌部队磨零漏洞修复（2026-08-01）

> 承 §45：用户又发现一条 "(33,293) Atk·Loss 0m 无回放"。查 VPS 生产库 `sieges` 集合，`seed`/`defenderConfig` 齐全但 `attackerArmy` 长度为 0——不是 §45 修的两条已知空路径，是新根因。

**根因**：卡牌部队真实战力活在 `cardState.currentTroops`，行军途中每赢一次 ADR-051 野战遭遇，`combatMarch.ts` 的 `advanceMarch` 只判断"这一次遭遇本身赢没赢"就放行部队继续前进，从不回头核对卡牌被磨损后的真实战力。反复磨损后如果全队归零，部队带着空壳阵容走到终点再打一场必输的仗，而不是在磨零那一刻就判定"全灭"。

**修复**（`combatMarch.ts` `advanceMarch`）：赢了野战遭遇、`m.troops`/`m.army` 落盘之后，对卡牌军用 `pw.cardState` 重新核算——`cardArmy.every(e => (pw.cardState?.[e.cardInstanceId]?.currentTroops ?? 0) <= 0)`——归零则视同 `!enc.marcherContinues`，走现成的"全灭删除"分支（不新建返程，已确认全灭恒为 0 幸存者）。

**借机的更大设计诉求**：用户确认必须修，同时指出"全灭"（野战遭遇/箭塔打空）和"占领格子后 autoReturn"都是瞬间处理，与玩家主动"召回"（已经是走时间的返程行军）不一致，要求统一成**任何"回城"默认都走返程行军时间（地图上有行走动画），玩家可以额外花金币瞬间完成**。用户进一步明确两个边界：①行军半路目标失效（连通性断/已被占/己方抢占中）——**原地停留，不算回城**，不套返程也不再瞬间退回；②瞬间回城的计费——**服务端按剩余路程时间全额算成金币**，不接受客户端指定部分抵扣（区别于 `speedupTraining` 的"可部分抵扣"）。

**三种行为模型分工**：

| 场景 | 改造后 |
|---|---|
| 主动召回（`recallMarch`/`recallStationed`） | 不变——本来就是返程行军，作为参照模板 |
| 行军到达终点才发现目标失效（8 处 miss/blocked） | 原地停留成 `StationedDoc`（复用 `settleOccupation` 已有的"占领后默认原地驻留"逻辑），push `status:'arrived'` |
| 占领格子后 `autoReturn=true` / 战败退回幸存者（~15 处） | 新建一条 `kind:'return'` 返程行军 |
| 返程行军抵达家门（`applyArrival` 的 `kind==='return'`） | 不变——这本来就是终点，理应瞬间入账 |
| 野战遭遇中途全灭（箭塔打空/`marcherContinues:false` 恒 0 幸存者） | 不变——没有可送回的部队 |

**新增共享原语**（`server/worldsvc/src/combatShared.ts`，与既有的 `refundTroops` 同伴——这三个都是自由函数而非某个 Service 的方法，因为 `combatSiege/*.ts` 的 mixin 只有 `this.core`，没有 `MarchService` 实例可用，而 `MarchService` 反过来已经依赖 `SiegeService`，不能反向注入）：
- **`computeMarchPath`**：从 `combatMarch.ts` 原私有方法原样搬出（函数体只用 `core.deps`/`core.coordX/Y`，零行为变化），`startMarch`/`recallStationed` 改为调用这个自由函数。
- **`startReturnMarch(core, {worldId,ownerId,fromTile,x,y,troops,army?,teamId?,leaderUnitType?}, t)`**：照抄 `recallStationed` 构造返程 `MarchDoc` 的写法——查 `pw.mainBaseTile` 当家（查不到就退化成原地 `refundTroops`）、`computeMarchPath` 算路径、插入 `kind:'return'` 文档、`pushMarch`。**内部整段包 `try/catch`，任何失败（最常见是 `computeMarchPath` 找不到路径）都退化成 `refundTroops` 即时入账**——这个原语被安插在很多更大的结算流程中段（主基地夺取→宗主惩罚→passiveRelocate→系统邮件、延迟建筑伤害结算等），寻路失败绝不能打断这些后续步骤（`field-structure-attack.e2e.test.ts` 的 `passiveRelocate` 测试在开发阶段实测踩过这个坑——不包 try/catch 时一次 `PATH_BLOCKED` 会让邮件和强制搬迁全部消失，因为 `processDueSiegeDamage` 外层只是 catch-and-log，不会重试或告警）。
- **`parkMarchInPlace(core, m, survivors, t)`**：照抄 `settleOccupation` 里"队伍默认原地驻留"那段写 `StationedDoc`+`setOccupancy`。只在 `m.teamId` 存在时可用（`StationedDoc` 按 teamId 建档，散兵没有队伍身份可停）；调用方在 `m.teamId` 缺失时保留旧的瞬间 `refundTroops`。

**改造调用点**（机械式替换，把 `refundTroops(...)` 换成上面两个原语之一，逐一文件不单独设计）：
- **改 `parkMarchInPlace`**（8 处到达终点发现目标失效）：`arrival.ts` 的 `applySiege`×2、`applyStrongholdSiege`、`applyCrossingSiege`、`applySweep`；`occupation.ts` 的 `applyOccupy`×2（第三处"己方抢占中"race **没有**转，见下）；`combatMarch.ts` 的 `applyArrival` reinforce-miss 分支（原先遗漏的第 9 处，人工审计时补上）。
  - **例外未转**：`applyOccupy` 里"己方已有一条待结算的占领 hold，第二条 occupy march 撞上"这条 race——不能原地驻留，因为 `StationedDoc` 按 tileId 一档一份，这个 tile 马上要被第一条 hold 结算（`settleOccupation`）写入它自己的 StationedDoc/所有权，两者会互相覆盖导致第二支部队静默消失。保留原有瞬间退回。
- **改 `startReturnMarch`**（~15 处战败/被击退幸存者 + autoReturn）：`arrival.ts` 的 `applyBaseSiege`/`applyStrongholdSiege`/`applyCrossingSiege`/`landSiege`(3 分支)/`applySweep`战后；`occupation.ts` 的 `applyOccupy` PvE 战败、`applyOccupationExpulsion` 战败、`settleOccupation` 的 `autoReturn` 分支（`troops:0` 恒定——`d.garrison` 已经变成新占地块自身的永久驻防，再送回去会重复计数）；`damage.ts` 的 `settleSiegeDamage`(3 分支，用 `this.core.coordX/Y(d.tile)` 求坐标，因为 `SiegeDamageDoc` 不带 x/y 且 `tile` 文档在 stale 分支可能已经不存在)；`encounter.ts` 的 `resolveFieldEncounter` 平民/卡牌军战败。
  - **踩过的坑（已修复）**：`resolveFieldEncounter` 内部原本直接调用 `startReturnMarch`（用同一个 `teamId`），但此时旧的 outbound `MarchDoc`（同一 teamId，仍是 `status:'marching'`）还没被删——撞上 `{worldId,ownerId,teamId}` 唯一索引，`E11000` 报错（`field-encounter.e2e.test.ts` 两例实测复现）。改法：`FieldEncounterResult` 新增 `returnTroops?: number` 字段（卡牌军恒 0，平民军为真实幸存数，`undefined`=全灭无需送回），`resolveFieldEncounter` 只返回这个字段，实际调用 `startReturnMarch` 挪到 `advanceMarch` 的 `!enc.marcherContinues` 分支里、**紧跟在 `findOneAndDelete` 之后**（先删旧的，再建新的）。
- **新增根因修复**：`advanceMarch` 卡牌军磨零检测（见上）。

**「花金币瞬间回城」**：`server/shared/src/slg/core.ts` 新增 `MARCH_RETURN_SPEEDUP_SECS_PER_COIN=60`（与 `TROOP_SPEEDUP_SECS_PER_COIN` 同档位，独立常量便于日后单独调）；`MarchService.instantReturnMarch(worldId,accountId,marchId,clientPlatform?)` 服务端自算 `coins=ceil(剩余秒数/60)`（不接受客户端传的金额），`this.core.commercial.spend(...)`（照抄 `speedupTraining` 的调用方式），再原样执行 `applyArrival` 的 `kind==='return'` 分支同款逻辑（`findOneAndDelete`+`refundTroops`+push）。`POST /world/march/{marchId}/instant-return`（`openapi-world.yml` 新增声明，`gen:api:world`/客户端 `rest:gen` 两端重生成）。

**客户端**：`WorldMapPanels.ts` 的行军列表原本 `kind==='return'` 的行只显示文字、无按钮——新增"花{coins}金币立即回城"按钮（`world.instantReturn` i18n key，三语言），`WorldMapContext.ts` `marchRowRects` 加 `instantReturnRect` 字段，`WorldMapInput.ts` 点击接入 `WorldMapNet.doInstantReturn`（新增，照抄 `doRecall` 的写法，成功后刷新 `ctx.me`+marches+toast `world.instantReturnDone`）。march 行走动画（`WorldMapRenderer/fog.ts`）本来就通用（不区分 kind，`'return'` 已有专属绿箭头），`parkMarchInPlace` 产生的 `StationedDoc` 复用既有驻留渲染——两处均无需新代码。

**已知不在本轮范围**：`combatMarch.ts` `applyMove` 的 `blocked` 分支（目的地被抢占/驻扎/contested）目前既不退回也不驻留——只是把行军删掉、什么都不写，队伍凭空消失，无处可查。这是独立于本轮"回城模型"之外的另一个缺口（`move` 是重新部署已就位的队伍，不是从家出发，语义上不完全等同于本轮改的"回城"），已 `spawn_task` 记录留待单独会话处理，未在本轮改动（后续已在 §48 修复：目的地被抢占时改为原地驻留在出发点，无法驻留才回退瞬间退款）。

**验证**：`tsc --noEmit`（`@nw/shared`/`@nw/worldsvc`/`client` 三包）全绿。`server/worldsvc` 全量 vitest 48 文件/376 例全绿（含更新 3 处受行为改动直接影响的既有断言——`siege.e2e.test.ts` 的 sweep-win 用例改为断言"幸存者以返程行军形式在途，非瞬间入账"；`teams.e2e.test.ts` 的 idle-team-gate 与 autoReturn 用例改为断言"结算后队伍仍 busy，直到返程行军抵达才可接新单"；均为预期的行为变化，非回归）。`server/shared` 全量 35 文件/666 例全绿（2 例因本机无 Redis 跳过，与本次改动无关）。`client` 全量 126 文件/918 例全绿。

**追加专项测试（同日，用户要求"加测试"）**：上面这轮验证只跑了既有套件+按需更新了受影响的断言，没有为新行为单独立新用例——补了两个新文件：
- `test/field-encounter-card-zero.e2e.test.ts`：专测根因修复本身。`resolveSiege` 的线性公式在防守方赢时恒为 0 幸存者（`atk<def` 意味着差值天然为负截断到 0），无法用来构造"赢了但磨零"场景；真引擎又难以靠兵力配比精确调出"attackerSurvivors 恰好 0 的惨胜"，遂 `vi.mock('../src/siegeEngine', ...)` 强制 `runSiegeBattle` 返回确定的 `{outcome:'attacker_win', attackerSurvivors:0}`（其余导出走 `importOriginal()` 保持真实，`computeCardStateUpdates`/`CARD_BASE_SURVIVAL` 等逻辑照跑）——2 例：①每张卡 2 兵、`CARD_BASE_SURVIVAL=0.2` 精算出 `round(2*0.2)=0` 全员归零，断言行军在遭遇战当场被删、目的地从未记录战报、也没有生成返程行军（全灭恒无幸存者可送）；②对照组每张卡 10 兵（`round(10*0.2)=2`，未归零），断言这次全灭检测不误伤，行军照常继续前进。
- `test/march-return-travel-time.e2e.test.ts`：专测本轮新行为本身（此前只是间接被既有测试的断言覆盖到，没有专门断言过新行为的具体形状）——同样 `vi.mock` 强制 `defender_win` + 固定非零幸存者（cheap 线性公式的 defender_win 分支恒为 0 幸存者，同样没法用来测"输了但有幸存者送回家"）。7 例：①目标行军途中被他人抢占（race）、带队伍的占领行军 → 落地为 `StationedDoc`，不退回、无返程行军；②同场景不带队伍 → 退回旧行为的瞬间退款，无 `StationedDoc`（对照组，确认 teamless 分支未被误改）；③PvE 战败 → 不是瞬间入账，而是生成一条 `kind:'return'` 返程行军，`toTile` 指向玩家主基地而非战场，兵力只在返程行军自己抵达时才真正入账；④`instantReturnMarch` 按服务端算出的 `ceil(剩余秒数/60)` 金币扣费，成功后立即结算（无需再等一次 `processDueArrivals`）；⑤扣费失败（`commercial.spend` 拒绝）时返程行军原封不动，没有半途扣了钱却没到账的情况；⑥⑦`instantReturnMarch` 对不存在的行军 id、以及对一条仍在途的非 `return` 类行军，均正确拒绝（`MARCH_NOT_FOUND`），不产生任何扣费。

两个新文件 9 例 + 原有全量 50 文件/385 例，全部一轮跑绿；`tsc --noEmit` 复核仍绿。
## 48. `move` 行军到达时目的地被抢占——队伍连人带兵直接消失，无驻扎、无退款（2026-08-01，代码审计发现）

> 审计 `combatMarch.ts` `MarchService.applyMove` 时发现：目的地在派出到抵达之间被别人占领/驻扎/进入争夺态（`blocked` 分支命中）时，代码只 `pushMarch(..., {status:'recalled'})` 就 `return`——不写 `StationedDoc`，不 `refundTroops`，而调用方 `advanceMarch`/`processDueArrivals` 在调用 `applyMove` 之前早已把 `MarchDoc` `findOneAndDelete` 掉了。结果是这支队伍连人带兵凭空消失：地图上没有行军、没有驻扎，兵力池也没有拿回一分——纯粹的资产丢失 bug，而不是"仅退款没实现"这种小疏漏。

**根因**：`move`（2026-07-23 新增，§38）语义上和 `attack`/`occupy`/`reinforce` 不同——它从不进入战斗结算，成功只是把队伍原样"放"在目的地（`StationedDoc`），没有"战损幸存兵力"这个概念可退。`applyMove` 最初只处理了"到达时目的地仍然合法"这一条路径，`blocked` 分支被当成跟 `reinforce`/`occupy` 的战败/目标失效一样的"退款+recalled"来写，但漏写了退款调用；而且退款语义本身也不贴切——`move` 的兵力/编队并没有战损，直接摔回抽象兵力池，跟"这支队伍应该出现在地图某处"的既有设计（ADR-051 P3a 停留/驻扎、idle-team 重新派遣）不一致。

**排查澄清**：`move` 在正常（非卡牌、非 P3c 就地重派）派出时确实会从兵力池扣兵（`startMarch` 里 `troops = team.army.reduce(...)` 之后走跟 `attack`/`occupy` 相同的 `$inc: {troops: -troops}` 原子扣减，见 `combatMarch.ts:411-424`），所以"是否曾扣兵池"不是本 bug 成立与否的前提——即使某些分支（卡牌编队 / idle 重派）不扣兵池，"目的地被抢占后队伍应该落在某处"这条不变量对所有分支都成立，只是没有兵力池要还的场景不需要额外退款。

**修复**（[`combatMarch.ts`](../../server/worldsvc/src/combatMarch.ts)）：`applyMove` 到达时优先尝试把队伍停驻在**目的地**（原有逻辑，抽成 `tryParkTeam` 私有方法，返回 `boolean` 表示是否成功写入）；目的地被抢占则退而求其次，用同一套 `tryParkTeam` 尝试停驻在**出发地**（`m.fromTile`）——等效于"这次移动没发生，队伍原地不动"，符合 `move` 本身"无战斗，纯粹是位置变更"的语义，且完全复用既有的 StationedDoc/occupancy/cover 写入与合法性校验（世界中心/已被占用/别家地块/争夺中）。只有当出发地也在此期间失效（例如队伍在外时出发地被第三方攻占）才真的无处可去，此时才回落到 `refundTroops`（卡牌编队照旧跳过，强度活在 `cardState` 里）。`!m.teamId` 分支保留（`startMarch` 保证 `move` 必有队伍，理论不可达，只为类型安全兜底）。

**验证**：`server/worldsvc` `npm install`（本 worktree 未预装 `node_modules`）+ `npm run build --workspace @nw/shared` / `@nw/engine`（首次无 `dist/`）后 `tsc --noEmit` 全绿。新增回归 `teams.e2e.test.ts`「move: destination becomes blocked between dispatch and arrival — the team parks back at its origin instead of vanishing」：派出后用 `setupDefender` 抢占目的地模拟竞态，断言到达后队伍以原兵力数出现在**出发地**的 `getStationed` 里、目的地地块归属未被误改，且停驻后仍可正常 `recallStationed`；先 `git stash` 掉修复代码单独跑这个新用例，确认它在修复前必现失败（`expected [] to have length 1 but got 0`，即队伍彻底消失）；`git stash pop` 恢复后转绿，坐实这确实是本次要修的 bug 而非误报。全量 `server/worldsvc` 跑了 48 文件/377 例，唯一 1 例失败（`siege-crash-replay.e2e.test.ts` 的崩溃回放用例）单独重跑该文件（无论是否带本次改动）均通过——只在全量并发跑所有文件时才偶发失败，跟本次改动的文件（`combatMarch.ts`/`teams.e2e.test.ts`）没有引用关系，判定为已有的全量并发/共享库竞态导致的既有 flaky，非本次改动引入。

**追加测试（同日，用户要求"加测试"）**：上面那一例只覆盖了`tryParkTeam`的"目的地被别家地块占领"这一种 `blocked` 成因，且没有触碰 `stationMode:'garrison'`、双端皆废的兜底、以及 idle-重派（ADR-051 P3c）这几条独立分支。补了 4 例，分布在三个文件（各自复用该文件既有的 harness，不新开文件）：
- `teams.e2e.test.ts` 「move: destination is blocked by ANOTHER team already stationed there (not tile ownership)」——用直接写入 `StationedDoc` 的方式构造"目的地无主但已被别家队伍驻扎"，专测 `blocked` 判定里 `stationedHere` 那一半（跟已验证的 `ownerId` 不匹配那一半是独立分支）；断言 `getStationed` 需按 `mine` 过滤（enemy-in-vision 也会被一并返回，踩了一次坑：断言写成 `length(1)` 首次跑出 2 条失败，修成 `.filter(s=>s.mine)` 后才对）。
- `teams.e2e.test.ts` 「move: BOTH destination and origin become unavailable」——专测三级兜底的最后一级（真退款）。CC-3 之后 `setTeams` 只接受卡牌编队（强度活在 `cardState`，从不扣兵池），没法用正常 API 构造一支会真正扣兵池的 `move` 队伍；改用直接写 `pw.teams`（绕过 `setTeams` 的校验，`startMarch` 读队伍走的是原始 `pw.teams`，不经过 `getTeams` 的自愈清洗）种一支**非卡牌**（`unitType`+`initialHp`）编队，这样 `hasCardArmy=false`，`move` 按 `attack`/`occupy` 同款 `$inc:{troops:-troops}` 真扣兵池；派出后同时用 `setupDefender` 占目的地、直接改写出发地（玩家自己基地那格）`TileDoc.ownerId` 模拟"队伍在外时老家也被端了"，断言到达后 `getStationed` 空、兵池金额精确退回原值。
- `field-garrison.e2e.test.ts` 「a garrison move whose destination is blocked mid-flight parks back at the origin STILL as a garrison」——专测 `stationMode:'garrison'` 分支：目的地被抢占后，落回出发地要求① `mode` 仍是 `'garrison'`（不能悄悄降级成 `'idle'`）、②`this.core.addCover` 的 3×3 覆盖区跟着落到**出发地**的九宫格（而不是目的地，或两头都不写），复用该文件已有的 `FakeRedis`（`teams.e2e.test.ts` 用的 `redis:null`，addCover/getCover 是 no-op，测不出覆盖区）逐格核对 `coverAt`。
- `field-redispatch.e2e.test.ts` 「re-dispatch move whose new destination becomes blocked mid-flight parks the team back at its ORIGINAL station cell」——专测 idle 重派（ADR-051 P3c）路径：一支已经"停留"在字段格 A 的队伍被重新派往 B（不经过recall），B 中途被抢占，落回**A**（不是玩家基地），且全程（原始停留、重派、失败落回）兵池分毫未动——idle 重派从设计上就不摸兵池，这是它跟"从基地新出发"分支唯一的、值得单独断言的差异点。

四例 + 原有 1 例，`teams.e2e.test.ts`/`field-garrison.e2e.test.ts`/`field-redispatch.e2e.test.ts` 三个文件单独跑通；`tsc --noEmit` 复核仍绿；`server/worldsvc` 全量重跑 50 文件/390 例全绿（先前那例 `siege-crash-replay.e2e.test.ts` flaky 这次也没有复现）。

## 49. 战令（Battle Pass）重复购买无限扣币、UI 无「已生效」提示（2026-08-01，用户截图报告）

用户截图报告：SLG 商城「Battle pass 9800 coins」无购买次数限制，点了很多次 Buy。追查确认这是真实缺口——`buySlgShopItem`（[`shop.ts`](../../server/worldsvc/src/shop.ts)）对 `kind:'battle_pass'` 只是把 `hasBattlePass` 字段重新设成 `true`，已经是 `true` 再设一次没有任何叠加效果；`SLG_SHOP_ITEMS`（[`shop.ts`](../../server/shared/src/slg/shop.ts)）里这一档商品也没配 `dailyLimit`（其余训练加速/资源包都有每日限购），代码注释原先写的假设是"战令本来就该一季只买一次"，但没有任何强制限制去兑现这条假设——纯粹的钱包漏洞，跟 §46/§48 那类"审计发现的资产/体验缺口"同构。

**战令当前效果**（确认无误，用户问"买了有什么效果"）：`trainTroops`/`speedupTraining`/`speedupBuild` 训练+建造均 ×0.8 时长、加速货币折扣 15%（[`city.ts`](../../server/worldsvc/src/city.ts)）；`recomputeYield` 资源产出 +10%（`BP_YIELD_MULT`，[`core/yield.ts`](../../server/worldsvc/src/core/yield.ts)）；赛季结算时持有战令的玩家额外收一封材料奖励邮件，与持有期间买了几次无关（[`season.ts`](../../server/worldsvc/src/season.ts)）——这几条增益本身在 S8-8（见 §15.1 G4/C6）已经落地生效，本次缺口只是"重复购买"这一层没有防护。

**修复**（单档商品的"单槽位"防重复购买，复刻月卡/年卡既有的 `ALREADY_ACTIVE` 单槽位门禁模式，见 `commercial/src/service/base.ts`）：
- 服务端 [`shop.ts`](../../server/worldsvc/src/shop.ts)：`buySlgShopItem` 在扣币前新增守卫——`item.kind==='battle_pass' && pw.hasBattlePass` 时直接 `throw new SlgError('ALREADY_ACTIVE', ...)`，币不会被扣（守卫先于 `commercial.spend` 调用）。
- 契约 [`openapi-world.yml`](../../server/contracts/openapi-world.yml)：`PlayerWorldView` 补 `hasBattlePass?: boolean` 字段（此前这个服务端早就在写、但从未在任何契约里暴露给客户端——`getMe` 也补了这一行，[`core/map.ts`](../../server/worldsvc/src/core/map.ts)），`npm run rest:gen` 重生成 `client/src/net/openapi-world.ts`。
- 客户端 [`WorldMapPanels.ts`](../../client/src/scenes/worldmap/WorldMapPanels.ts)：商城战令行读 `ctx.me?.hasBattlePass`，已生效时按钮走既有的"禁用态"配色（`panelButtonIn` 新增 `disabled` 参数，复刻本文件顶部 tile-action 弹窗禁用按钮"点了也弹 toast 解释原因、而不是读起来像个死点击"的既有约定），文案从「购买」换成「已生效」，点击弹 toast 而不是发起购买请求。服务端如果仍因竞态（客户端 `me` 未刷新）拒绝，`WorldMapNet.errorMsg` 也把 `ALREADY_ACTIVE` 映射到同一句 toast 文案，三语 i18n key `world.shopActive`/`world.shopAlreadyActive` 补全 zh/en/de。

**验证**：`tsc --noEmit`（server `worldsvc`/`shared`，client `tsconfig.test.json`）全绿；`npm run build:web` 生产构建通过。`server/worldsvc` 新增 e2e「battle pass: repeat purchase while already active → ALREADY_ACTIVE, coins never deducted twice」，`shop.e2e.test.ts` 全 7 例过、`worldsvc` 全量 50 文件/391 例过。`client` 新增 UI 用例覆盖「未持有时点击行仍正常触发购买」「已持有时点击行不再调用 `doBuyShopItem`、改为弹 toast」，`worldMapInfoScroll.ui.ts` 全 20 例过，`worldMap*` 全套 17 文件/124 例过。未启动完整后端栈（metaserver/worldsvc/gateway 等 11 服务）做真实登录后截图验证——UI 交互路径已通过驱动真实 `WorldMapPanels`/`WorldMapInput` 类的无头 PIXI 测试覆盖，视为等效验证。

**追加测试（同日，用户要求"加测试"）**：`shop.e2e.test.ts` 补 3 例——① 持有战令不影响购买其它商品（守卫只针对 `kind:'battle_pass'`，不误伤 `slg_res_s`/`slg_shield_8h`）；② 守卫按账号隔离——A 持有战令不阻挡 B 首次购买（读的是各自 `playerWorld` 文档，不是全局标记）；③ `hasBattlePass` 被清空后（模拟 `resetSeason` 的 playerWorld 清档路径）可以再次购买，门禁不会永久卡死。`worldMapErrorMsg.ui.ts`（专门收录 `WorldMapNet.errorMsg` 码→文案映射回归的文件）补 1 例，断言 `ALREADY_ACTIVE` 映射到 `world.shopAlreadyActive`。`shop.e2e.test.ts` 全 10 例过、`worldMapErrorMsg.ui.ts` 全 7 例过、`worldMap*` 全套 19 文件/139 例过；`tsc --noEmit` 复核仍绿（`worldMapDrawPrimitives.ui.ts`/`worldMapOwnerBorder.ui.ts` 各有 1/2 处 PIXI `lineStyle`/`beginFill` 重载类型报错，经核对在主目录未改动前就已存在，跟本次改动无关，不在此修）。

