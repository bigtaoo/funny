# Notebook Wars — 野外城池攻城 P0–P3 分期落地记录（机制权威见 [`SLG_CITY_SIEGE_DESIGN.md`](SLG_CITY_SIEGE_DESIGN.md)）

> 从 `SLG_CITY_SIEGE_DESIGN.md` §10 拆出（2026-08-29，ADR-067 单册形态：hub 原位留同号 stub + 箭头，不建索引表）。四个阶段全部已完成（P0 2026-08-25 ~ P3 2026-08-27），小节编号与正文一字未改。

### P0 止血 ✅ 已落地（2026-08-25）

目标：让「一个人吃掉城池」当天不可能，不等完整实体落地。

1. ✅ **`proceduralTile` 按 footprint 判定城池地面**（§4.1）——新增 `_cityGroundNodeAt()`/`_inCityFootprint()`（`mapgen/cities.ts`），替掉旧的 `capitalIdxAt` + `node.x===x && node.y===y` 精确锚点匹配；`proceduralCityGroundTiles()` 同步改为枚举整块 footprint，§1.2 的两路径漂移消除。**城池地面不再带 `resType`**（`mapEdit.ts` 一并对齐，否则每座城的 footprint 会永久变成对基线的 diff）。
2. ✅ **`validateMarchTarget` 给 `familyKeep` 加拦截**：`occupy`/`sweep`/`move` 全禁；`attack` 抛显式的 `City siege is not implemented yet`（不落到 ownerless 分支那句已经错了的「use occupy/sweep」）。直接占领路径 `territory.ts occupyTile` 同样补上。
3. ✅ **`applyNationChange` 整个删除**（不只是从 occupy 路径摘掉）——两个调用点（`settleOccupation`、`settleSiegeDamage`）连 `core`/`service` 两层门面一起清掉。`initNations` 改为**同时清空既有文档的归属字段**（`ownerId`/`familyId`/`nationName`/`foundedAt`），赛季开启与世界重置都会生效。
4. ✅ 客户端点城弹「城池 · Lv.N · 需加入宗门后合力围攻」信息框（只有关闭按钮，不给出征入口），替掉普通占领框；i18n zh/en/de 三份。
5. ✅ **P0 顺带修掉两处此前没察觉的漏洞**：①落主城/自动出生**从来没有排除城池地面**（`spawn.ts` 四处内联的 `center/obstacle/bridge/plankway/stronghold` 列表都漏了 `familyKeep`）——footprint 化后这个洞会从「每城 1 格」放大到「每城最多 81 格」，现收敛为单一谓词 `isReservedBaseTerrain()`；②手动落主城（`territory.ts` 内部/测试路径）同样没有拦截。
6. ✅ 回归测试：新建 `server/worldsvc/test/city-ground.e2e.test.ts`（11 例）+ `client/test/ui/worldMapCityClick.ui.ts`（6 例），改写 `server/shared/test/{cities,slg}.test.ts` 的锚点断言为 footprint 断言、`review-fixes-2026-08-03.e2e.test.ts` 的 `applyNationChange` 用例换成 `initNations` 清空用例。

7. ✅ **补测一轮（同日第二刀）**：`_inCityFootprint`/`_cityGroundNodeAt` 的边界直测（四种 footprint 的「边上 vs 边外一格」、核心省州府不得被当作 `familyKeep` 认领）、**整块 81 格 footprint 逐格不出图**（配对反证：同样 81 格换成资源地必须出 81 个精灵）、**被拖走的城要交还整块旧 footprint**（原用例只查锚点一格）、**发布未改动的节点表必须是零 diff**、以及**到达时二次校验**（在途 occupy/move 落到城池地面）。

> **⚠️ 补测过程中发现并修掉一个真 bug（不在 P0 原计划内）**：`rasterizeMapEdits` 画城是**后写覆盖**、顺序取决于调用方数组（分级城在最后），而 `_cityGroundNodeAt` 是**州府优先、首个命中即返回**。两座城 footprint 重叠时（贴边城的锚点被夹回图内，plot 就会伸进邻城）二者结论不同——一个 Lv.8 分级城会盖掉 Lv.10 州府的格子，于是**发布出来的模板和生成器对同一格的 level 不一致**，而这个 level 从 P1 起就是城池的耐久/守军规模。现已改为按 `worldCenter > capital > garrison` 优先级绘制、先占者胜，与生成器对齐。是「发布未改动节点表 = 零 diff」这条断言在 (1499, 328) 抓出来的。
>
> **变异验红（5 处，逐一实测）**：M1 把分级城改回锚点匹配、M2 摘掉 occupy 的 `familyKeep` 拦截、M3 摘掉 `initNations` 的清空、M4 关掉客户端城池分支、M5 把两处到达时校验改回只认 `center`——各自都让对应用例转红。**其中三次暴露了测试自身的问题**：
> - **M1 第一轮没红**：`city-ground.e2e.test.ts` 的取城辅助函数原本「取第一座能用的城」，实际总是取到**州府**（另一条生成分支），于是把分级城分支改坏了整个套件仍然全绿。现在按 `kind` 取城、且要求格子 level 等于该城自身 level（否则会拿到邻近州府 9×9 footprint 吞掉的格子，实测踩到过）。
> - **M5 第一轮没红**：两条「到达时」用例其实**从没走到被测的那道校验**——occupy 在 ADR-039 连地检查处就退了、move 在缺队伍处就退了。补上「先占下城墙外一格」和「带真队伍」的前置后，M5 才现出真形：旧校验下 occupy **会占下城池地面**、move **会把队伍驻扎进城墙里**。两条各配一个「同样的行军打城墙外的地就该成功」的反证，避免「什么都没发生」被读成通过。
> - **重叠用例原本是空跑**：`city-ground-test`/`s99-0`/`w1` 三个种子实测**零重叠**，用例等于什么都没验。现钉在 `s1-cityground`（实测 15 格重叠）并断言命中数，种子一变就会失败而不是静默变空。
>
> **另一处坑记一笔**：worldsvc 的测试吃的是 `@nw/shared` 的 **`dist/`**，不是 `src/`。改完 shared 源码不 `npm run build` 就跑 worldsvc 测试，验的是上一次的编译产物——M1 的第一轮结论就是这么被污染的。

**P0 明确留下的临时状态**：`nations` 没有任何写入方了，所以 `NATION_BONUS_PRODUCTION`(+10%) 与 `NATION_BONUS_DEFENSE`(+15%) 双双**空转**，直到 P1 把州府归属改成宗门后重新接线（§9）。读取路径刻意保留未删——先删机制再建替代品没有意义。另外 `initNations` 只在**赛季开启 / 世界重置**时跑，所以**已经开着的世界会保留旧的建国归属**（含通过该漏洞建的国），需要跑一次 `/admin/world/reset` 或手动清一次 `nations` 集合。

### P1 城池实体 ✅ 已落地（2026-08-25）

P2 的标定先于 P1 跑完，所以 P1 实现的是**已实测定案**的机制，不是本文最初写下的那版（三条机制原案被否，见 §5）。

1. ✅ **`CityDoc` + 新集合 `cities`**（`worldsvc/src/db/cityDocs.ts`）：每世界约 64 个文档，归属主体 `ownerSectId`（宗门），索引 `{worldId}` / `{worldId, ownerSectId}` / `{worldId, x, y}`。**不是**挂在锚点格子的 `TileDoc` 上——footprint 有 9~81 格且不可分割，耐久/归属/围攻日志是**城池**的属性；挂在格子上还会跟主城与建筑路径已经在用的 `hp`/`durability` 撞名。
2. ✅ **`CitySiegeService`**（`worldsvc/src/core/citySiege.ts`，`core/nation.ts` 的对位物，组合而非继承）：`initCities`（幂等，赛季开启/世界重置各跑一次）、`getCityStates`/`getCity`/`cityAt`（footprint 反查）、`requireSect`（攻打门槛）、`getCityViews`（带惰性回复的视图）。
   - **节点表来源是 `core.getCities(worldId)`**（世界文档上从地图模板克隆下来的那份），不是 `allCityNodes(worldId)`：后者会把城池的血量放在贴图**不在**的位置（模板地形按 templateId 的种子生成，且设计师可能拖过城）。
   - `initCities` **每次都重刷**几何与耐久上限（`$set`），但**不重置已受的伤**（`durability` 只在 `$setOnInsert`）。所以地图编辑器改了城池等级、或常量重调过，下次开季会重新缩放城墙，而正在被围攻的城不会被治好。归属/保护期/围攻日志则每次 `$unset`——赛季级状态不能被「同 worldId 重开」继承（`initNations` 关的是同一个洞）。
3. ✅ **attack 分支 + 宗门门槛**（`combatMarch/startMarchValidation.ts`）：顺序刻意是**先宗门、后连地**——两者都不满足时，玩家能行动的是前者，报连地错误会让人跑去打一片他还是用不上的地。复用既有 `NOT_IN_SECT`(403) 而不是新造 `NO_SECT`。另外拦「本宗门已持有」（`ALLY_TILE`）与「保护期内」（`PROTECTED`）。连地判定按**整块 footprint**（`targetFootprintCells` 只认主城 3×3，城池自带一份）。
4. ✅ **波次梯 + 耐久**（`combatSiege/arrival/citySiege.ts`）：每次行军各打完整 3 波，残兵按每波真实存活率（ADR-069 的分母）在波间衰减；清完全梯 → 走既有 `siegeDamage` 管道挂 5 分钟延迟，伤害 = `teamSiegeValue`；被击退 → 零伤害、残兵走真实返程。
   - **到达时也重新判一遍连地**，而且必须用城池 footprint：`applySiege` 原本用 `targetFootprintCells`，城池地面没有 `TileDoc`，那个 helper 会退化成「只有落地那一格」——一座 5×5 城的锚点离攻方真正持有的边界地有 3 格，于是**每一次城池围攻都会在到达时被判成「补给线被切断」而原地驻扎**。实测抓到的（e2e 一开始 8 例红）。
5. ✅ **耐久结算 + 易主**（`combatSiege/cityDamage.ts`，由 `settleSiegeDamage` 按 `SiegeDamageDoc.cityId` 分流）：惰性回复 → 扣伤害 → 累加 `siegeLog[sectId]`；归零则**最后一击那名玩家所属宗门**得城（ADR-074 决策 2），写 `capturedAt`/`protectedUntil`，耐久**重置为满**（否则刚付了整场代价的宗门拿到一座任何人下一击就能翻走的空城），清 `siegeLog`。
   - 并发用 rev CAS + 有界重试（与格子路径同款），而 CAS 顺带充当「谁先到」的裁决者：同一 `rev` 只有一次更新能匹配，所以**易主与公告都只可能发生一次**。
   - 公告三路 + 一封邮件：新主宗门频道、原主宗门频道（城池归宗门所有，没有单个 defender 可推 `under_attack`，原主频道那条**就是**通知）、世界中心易主发全服频道；邮件只发给**落下最后一击的那名玩家**。刻意不按宗门（≤900 人）扇出邮件——64 座城每次易主群发一遍是邮件水龙头，频道公告已经覆盖在线成员且有 7 天 TTL。
   - **⚠️ 这四条公告一开始整套都是以原始 key 发出去的（2026-08-26 补）**：`slg.city.captured{,.subject,.mail}` / `slg.city.lost` / `slg.city.worldCenterCaptured` 五个 key 在三份词典里**一个都没有**，玩家收到的邮件标题就是字面的 `slg.city.captured.subject`。只有那一条字面写成 `subject: 'slg.city.captured.subject'` 的被 `client/test/i18n-server-mail-keys.test.ts` 抓红；另外三条写成 `body: body('…')` / `postSect(id, '…')`，那个扫描器只认「`subject:`/`body:` 紧跟引号」，**看不见**它们（扫描器已补第二块，见 §9）。
   - **公告的参数必须逐个具名（`name=value`）**：客户端 `i18n/systemText.ts` 按 `=` 取参，**没有 `=` 的管道段会被静默丢弃**。`body()` 原本发的是位置参数 `key|kind|nodeId|level|x|y|sect=名`，于是等级和坐标全部消失在路上——一条说不出「打下了哪座城」的易主公告。现已改成 `kind=…|node=…|level=…|x=…|y=…|sect=…`（e2e 用的是 `toContain`，格式没被钉住，改动不破测试）。`node=` 目前不进文案，留着给以后「点公告跳到该城」用。
   - **⚠️ 频道那几条的长度上限不是 `maxBodyChars`，是列宽（截图才看出来的）**：`drawChatLine` 单行不换行，`maxBodyChars=60` 只是**字数**上限，真正先裁掉文字的是所在列的宽度。第一版德文写到 55 字，60 字断言照样绿，但在宗门频道里是**半个词被切掉**的样子。
     - **✅ 已根治（2026-08-26 当天晚些时候）**：`drawChatLine` 不再收字数，改收 `maxW`（调用方传入本行可用宽度），名字牌与正文两半都经 `ui/widgets/truncateText.ts` 的 `fitToWidth` 按**真实宽度**截断并补 `…`。三个调用点（`SectScene/lists.ts` / `FamilyScene/lists.ts` 传 `colW - 12*2`，`FriendsScene/worldChat.ts` 传 `rw - inset*2`）随之改掉。**顺带修掉的两件事**：①玩家自己打的长消息此前同样被硬切且**没有省略号**，现在一律有；②名字牌（`[称号][宗门][家族]名字`，两个 org 名各可占 `ORG_NAME_WIDTH_MAX`）此前能把正文挤到没有空间，现在按行宽 50% 上限截断，正文拿名字牌**实际**占用后的剩余（短名字仍拿满）。
     - **那对 34/41 的字数上限是错的，两个数不可能同时描述同一列**：同一字号下 monospace 汉字步进约为拉丁的 1.82 倍（实测 24px：13.2px / 24.0px），34 个汉字 ≈ 62 个拉丁位宽，跟 41 差得远。现在的上限写在 `client/test/i18n-system-text.test.ts` 里，单位换成 `orgNameWidth` 的**显示宽度**（全角计 2、其余计 1），一个数管三种语言。
     - **上限的来源（Playwright 实测，`npm run start:e2e` + `window.__nwE2E`，视口 1600x900 → 落到 landscape **最窄**的设计宽 1920，即最坏情况）**：`system` 发送者的行，正文可用宽度 —— **宗门频道 700px = 53.0 位宽**、**世界频道 1386px = 105.0 位宽**（都含 `drawChatLine` 那个 `": "` 前缀的 2 位宽，词典串本身不含，故词典串预算为 51 / 103）。留一点余量后取 `SECT_BUDGET = 48`、`WORLD_BUDGET = 96`。当前文案最宽的是德文 `slg.city.lost`（40 位宽）和德文 `worldCenterCaptured`（55 位宽），**都还有余量——上一版把文案压到 41 字是压过头了**，以后要加字可以按这个预算来。`test:ui` 的 headless harness 量不了这个（它的 `measureText` 是每个 UTF-16 码元固定 7px，不看字号也不看字种），所以宽度预算只能靠真浏览器实测，见 `claudedocs/client-testing.md`。
     - **✅ 文案已按新预算改回完整表述（同日）**：上一版为了塞进 41 字把主语和动词都砍了（`攻占 (x, y) 的 Lv.N 城池` / `(x, y) Lv.N lost to X`），48 位宽下不必如此。现在：
       - `slg.city.captured` —— zh `本宗门攻占了 ({x}, {y}) 的 Lv.{level} 城池`（480/700px）、en `Our sect captured the Lv.{level} city at ({x}, {y})`（621/700px）、de `Unsere Sekte hat Stadt Lv.{level} ({x}, {y}) erobert`（634/700px）。zh/en **就是压缩前的原文**，原样还原；de 原文（含 `bei`）是 50 位宽，去掉 `bei` 后 46 位宽。
       - `slg.city.lost` —— zh `({x}, {y}) 的 Lv.{level} 城池被 {sect} 攻占`（580/700px）、en `Our sect lost Lv.{level} ({x}, {y}) to {sect}`（621/700px）、de `Stadt Lv.{level} ({x}, {y}) an {sect} verloren`（634/700px）。**这三条的原文还不回去**：带 `{sect}`（12 位宽）+ 坐标（10）+ `Lv.N`（4）已占 26，原文都在 50-58 位宽，超出 48。所以是「在 48 内尽量还原完整句」而不是还原原文——主语/动词/「被谁打下」三样都在。
       - 括号里的 px 是真浏览器实测（最窄 landscape 设计宽 1920 的宗门列，正文可用 700px），三种语言都不截断，最紧的德文还剩 66px ≈ 5 个拉丁字符。**顺带验证了 `orgNameWidth` 这个代理是准的**：德文 46 位宽 × 13.2px + `": "` 26px = 633px，实测 634px，差 1px。
   - **系统公告的翻译发生在 `drawChatLine` 里**：此前**没有任何**聊天面板会翻译 i18n key（`SectScene/lists.ts` 与 `FriendsScene/worldChat.ts` 都是直接渲染 `msg.body`），所以光加词典条目对这三条公告是无效的。现在把 mail 那份解析逻辑提成公用的 `i18n/systemText.ts`，在 `drawChatLine` 这一个收口处翻译——玩家自己打的字照原样透传（key 查不到就回退原串），所以不必按发送者是否为 `system` 分流。
6. ✅ **契约面**（直接编辑 `openapi-world.yml`；ADR-040 的 `openapi/` 分域片段只管 `openapi.yml`）：`WorldCityNodeView` 加 `ownerSectId`/`ownerSectName`/`durability`/`durabilityMax`/`regenPerHour`/`protectedUntil`/`siegeLog`；`PlayerWorldView` 加 `sectId`（客户端据此决定是否给围攻按钮）；新增 `GET /world/cities`。
   - **刻意不做推送**：一座城每小时会被命中几十次，按宗门扇出每一击是推送水龙头。城池面板打开时刷一次（`WorldMapNet.refreshCities`），地图上的血条只需大致正确；易主才走频道公告。
7. ✅ **客户端**（`WorldMapInput.showCityPanel` + `WorldMapRenderer/city.ts`）：城池精灵上方的耐久条（只在受损时画，跟主城血条同一套克制）；面板显示**绝对值**耐久 + 每小时回复量 + 归属宗门 + 保护期倒计时 + 本轮各宗门贡献；围攻按钮仅在服务端所有前置条件都已满足时出现（无宗门/保护期内/本宗门已持有 → 隐藏并说明原因，与占领按钮 2026-08-02 的约定一致）。
   - **耐久必须显示绝对值**：曲线是「大基数 + 小步长」（§6.5），Lv.3 与 Lv.10 只差约 22%，只给百分比会被当成 bug。
   - **⚠️ 血条锚点踩过一次（截图核对抓到的，代码审读抓不到）**：血条第一版锚在 `-sprite.height`（精灵单元格的顶边）。但 `citySpriteTiles` 是按 footprint 定精灵尺寸的，而每张城池图上方都有透明留白——一座 7×7 的 Lv.6 城，单元格顶边比屋顶高出几百像素，血条直接飘到视口外，看起来像「没做」。改用 `getCityContentTopFracForLevel(level)`（该函数的文档注释里点名的调用方就是 `WorldMapRenderer/city.ts`，而紧挨着的主城血条早在 2026-07-22 就因为矮建筑的同一症状修过一次）。**教训：这类缺陷只有真跑起来看一眼才会现形。**
8. ✅ 赛季生命周期：`openSeason`/`resetWorld` 各调一次 `initCities`；`cities` 进重置清空集合列表（与 `siegeDamage`/`occupations`/`stationed` 同批）。
9. ✅ 回归测试：`worldsvc/test/city-siege.e2e.test.ts`（**26** 例，真 Mongo）+ `shared/test/citySiege.test.ts`（**20** 例纯函数）+ `client/test/ui/worldMapCityClick.ui.ts`（15 例面板，P0 的 5 条保留 + P1 的 10 条）+ `client/test/ui/worldMapCityDurabilityBar.ui.ts`（**6** 例血条几何）+ `httpApiActionSiegeMapGaps.e2e.test.ts` / `season-ops.e2e.test.ts` 各 +2。P0 的 `city-ground.e2e.test.ts` 里那条 attack 用例从「未实现」改成断言宗门门槛。补测过程见下方第三刀。
   - **公告文案（2026-08-26 补）**：`client/test/i18n-server-mail-keys.test.ts` 加第二块扫描——不再去认「承载 key 的语法」，而是直接扫**非 admin 服务端源码里所有玩家命名空间下的 key 字面量**，因此 `body: body('…')` / `postSect(id, '…')` 这两种形态也进网。排除 admin 是必须的：后台的 RBAC 权限位和审计动作 id 拼写跟 i18n key 一模一样（`slg.season.open` 等 21 个）却永不示人，而且**要按 admin 模块排除、不能只排 `admin/` 目录**——那 21 个的权威定义在 `shared/src/admin.ts`。新增 `client/test/i18n-system-text.test.ts`（14 例）钉住 `systemText` 的参数契约（具名存活 / 位置参数被丢弃）、玩家原话透传、缺 key 回退，以及上面那条 60 字上限。


> **补测一轮（同日第三刀，用户问「有没有可以加的测试」后按 `sectService` 那次的规矩复查）**：`claudedocs/server-audits.md` 记着上一次同样一句话查出了 `/sect/*` 全部 10 条路由零 wire-level 覆盖。这次按同一套「不看方法名、看路由字符串 / 看机制的每条分支」复查，找出 4 个缺口并补齐，**其中一个缺口背后是真 bug**。
>
> **⚠️ 补测抓出一个真 bug（P1 原计划外，且严重）：世界中心根本没法围攻。** `validateMarchTarget` 的 `attack` 分支里有一条 ADR-074 之前就存在的拦截——`if (proc.type === 'center') throw 'World center is contested by sects and cannot be sieged'`——它排在我新加的城池分支**之前**。而 `isCityGroundTile` 覆盖 `center` 和 `familyKeep` 两种，世界中心的地面是 `center`，于是**全图最重要的那一座城（§8.3：攻城值 +5%、行军 −10%、全服公告）是 P1 唯一一座打不了的城**，`settleCityDamage` 里那段世界中心的全服频道公告成了死代码。原来的 21 条 e2e 全部用分级城，一条都没碰到。修法是把城池分支移到该拦截之前（那条拦截在「城池只是贴图」的年代是对的，ADR-074 恰好把它变成了错的）。
>
> **新增覆盖（4 处缺口）**：
> - **`GET /world/cities` 的路由分派零覆盖**（`httpApiActionSiegeMapGaps.e2e.test.ts` +2 例）。那个文件的唯一职责就是把 `mapRoutes.ts` 里每一条 `if (method===X && path===Y)` 走一遍真 HTTP，我加路由时没加进去——正是「方法名出现在测试里 ≠ 路由被覆盖」那个坑。断言不止 `Array.isArray`：逐条检查 `durability`/`durabilityMax`/`regenPerHour`，否则一个返回裸节点表的路由也能过（血条就画不出来了）。
> - **赛季生命周期零覆盖**（`season-ops.e2e.test.ts` +2 例）：`cities` 进了 resetSeason 的清空列表、`initCities` 挂进了 openSeason/resetWorld，两件都没有任何东西看着。**验红时发现断言写得不准**：去掉清空后「归属被清」的断言仍然绿，因为 `initCities` 每次都会 `$unset` 归属——清空真正独有的作用是删掉**节点表里已不存在的孤儿文档**（地图模板改过之后的残留）。已按这个改断言并记在用例注释里。
> - **`initCities` 是否跟随「发布的」节点表**（`city-siege.e2e.test.ts`）：这是 ADR-074 自己的核心 bug 类型（种子 vs 发布），却只测了种子回退路径。新用例把城拖走 11/7 格并改等级，断言文档跟着走、`durabilityMax` 按新等级重算、footprint 反查认新锚点。
> - **到达时的三条重新校验 + 一条陈旧分支**（`city-siege.e2e.test.ts`）：在途中退出宗门、在途中城池进入保护期、结算时城池文档已被世界重置删掉。这三条都是「出发侧对、到达侧错」的形状——P1 已经踩过一次（连地判定），所以值得逐条钉。
> - **客户端血条的几何**（新建 `client/test/ui/worldMapCityDurabilityBar.ui.ts`，6 例）：见下条。
>
> **⚠️ 另一处：血条那个 bug 是截图发现的，15 条 UI 测试全绿——因为它们断言的是面板的**文案和按钮**，不是**位置**。** 新用例把 `getCityContentTopFracForLevel` mock 成 0.5（真图有留白时才能区分两种写法），断言「血条与美术顶边的间距是个小常数、且不随 footprint 增长」。验红：把代码回滚成 `-sprite.height`，两条几何用例立刻红（间距 437px vs 允许的 16px）。**这条教训比这个 bug 本身值钱：渲染层的回归测试要断言几何，只断言内容会漏掉整类「画在屏幕外」的缺陷。**
>
> **顺手消掉一处重复**：`rasterizeMapEdits` 里的 `CITY_PAINT_RANK` 是城池优先级的**第三份拷贝**（另两份是 `_cityGroundNodeAt` 的遍历顺序和 P1 新增的 `cityNodeCovering`）。P0 那个「Lv.8 分级城盖掉 Lv.10 州府」的 bug 就是这三份漂移出来的。改成 import 共享的 `CITY_KIND_RANK`，并加一条**行为**断言（不是常量相等断言——那条抓不到当年那个 bug）：真实重叠格上，生成器、`cityNodeCovering`、以及「发布未改动节点表必须零 diff」三者必须一致。
>
> **变异验红 6 处，逐一实测**：M-A 反转 rasterizer 的城池优先级、M-B 让 `/world/cities` 返回裸节点表、M-C 从 resetSeason 删掉 `cities`、M-D 从 openSeason 删掉 `initCities`、M-E 把那条 `center` 拦截加回城池分支之前、M-F 把血条锚点回滚成 `-sprite.height`——各自都让对应用例转红。
>
> **登记一条没测的**（不是漏，是刻意）：`settleCityDamage` 的 rev-CAS 重试循环与 `MAX_ATTEMPTS` 耗尽分支。要确定性地制造 5 次连续 rev 冲突需要往结算里插测试钩子，成本高于收益；并发正确性目前靠「同一 `rev` 只有一次更新能匹配」这个结构性质 + 「本宗门已持有则作废」那条用例间接覆盖。

**P1 明确留下的临时状态**：
- ~~`CityDoc.defenderLock` 已建字段但 P1 无写入方~~ → P3（2026-08-27）**未使用即退役**：守队锁定的机制早就是 `teamState[id].injuredUntil`，且 `CITY_WAVE_RESPAWN_MS === SLG_TEAM_INJURY_MS` 本来就有断言。详见 P3-3。
- `nations` 的两条加成仍然空转：`NATION_BONUS_PRODUCTION`/`NATION_BONUS_DEFENSE` 的读取路径还在，但 P1 只把**城池**归属改成了宗门，没有把州府的省级加成重新接到 `CityDoc.ownerSectId` 上（§9 与 §8 的收益接线都在 P3）。
- §8 的三条收益（产量 / 全域 buff / 出兵锚点）一条都没接：P1 只做「打得下来、守得住、看得见」。

### P2 数值核验（上线门禁）✅ 已落地（2026-08-25，先于 P1 跑完）

新建 `server/tools/econ-sim/src/citySiege.ts`（模型）+ `citySiegeRun.ts`（报告/门禁，`npm run --workspace @nw/econ-sim city-siege`）+ `citySiege.test.ts`（28 例 CI 回归）。**刻意排在 P1 前面**：这一轮定的不只是数字，还否掉了 §5 的三条机制原案（守军共享重生、波数随等级、每波守军 1180/等级），P1 若先写代码会照着错的机制实现一遍。

五道门禁，全部 PASS：

| 门禁 | 内容 | 结果 |
|---|---|---|
| ① 档位表 | 各档位单次投送量/兵池/训练吞吐/单次伤害 | 实测发现单次投送受 `cardTroopCap` 钉死在 ≤4,800，`satchel`/`drillYard` 的 20,000 永不生效 |
| ② 单次兵耗 | 6 档位 × 7 城池等级的清梯成功率与兵耗 | 631~2,870，随等级单调上升 |
| ③ **单人封死** | 满配单人（含装备 +60%、宗门 +32% 两条通道，**均已实装**）对最弱野城 | ✅ 持续输出 1.56× 余量、倾池爆发 1.43× 余量 |
| ④ 结构不变式 | 每波守军 ≤ `SIEGE_SYNTH_ARMY_MAX_TROOPS`（不掉进廉价线性分流）+ 兵耗单调 + 基准档能清完所有等级 | ✅ |
| ⑤ **人数表** | §6.3 每一档「1 小时攻陷所需人数」实测 vs 本文表值 | ✅ 全部落在 ±25%（+5% ~ +21%） |

两条原始必过断言的落地形态：

1. **「单人进度恒为负」拆成了两条判据**，而不是一条。原文只写了「持续输出 < 回复」；实测发现更紧的是「**倾池爆发 < 耐久**」——满配账号站着的兵池能在几分钟内换出 30+ 次攻城，回复来不及作用。两条都进了 `citySiege.test.ts`，并各留 ≥1.3× 余量断言，防止别处一次小重调静默把门禁翻红。
2. **「与文档表值偏差 ≤±25%」成了双向的钉子**：`citySiegeRun.ts` 和 `citySiege.test.ts` 各存一份 §6.3 的人数表。改常量不改文档 → 红；改文档不重跑脚本 → 红。

**曾经登记的两条代码事实，现均已解决**（见 §6 与 ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE.6）：`teamSiegeValue()` 原先只读卡的 `defId`+`level`，装备攻城值 +60% 不进耐久伤害——已于 §12.7（2026-08-29）接线；§8.3 的宗门加成已于 ADR-074 P3（2026-08-27）接线。门禁 ③ 当初是带着这两条假想倍率测的，所以两条各自落地时都还在余量内，未破门禁。

### P3 守方与收益接线 ✅ 已落地（2026-08-27）

P1 只做「打得下来、守得住、看得见」，一座打下来的城**除了战略遏制没有任何收益**。P3 把 §8 三条收益、§9 的另一半、以及守方接了进去。三次提交，分三段读。

#### P3-1 产量（§8.1/§8.5）+ 退役国家产量加成（§9）

- **一切用「等级度」表达**（`level × cityKindMult`，世界中心 ×2）。§8.1 的表、§8.2 的普查（270+90+20=380）和 120 度上限全部从 `CITY_YIELD_FLAT_PER_LEVEL`/`CITY_STICKER_FLAT_PER_LEVEL` 两个常量派生，`shared/test/citySiege.test.ts` **逐行重算**表格而不是把单元格抄成期望值——抄表只能证明「有人会抄」。两个资源上限也从等级上限派生，所以调上限不会悄悄改掉平衡论证依赖的「陆资:铜币」比例。
- **`SectDoc.cityPayoff` 一个字段装三个派生值**（产量 / 攻城值加成 / 行军倍率）。半更新会让读者看到一个「从没存在过的状态」（新持有的产量 + 旧持有的攻城加成）。**易主时两个宗门都重算**——一次占领同时是一次失守，而漏掉失守方的症状是「它继续按已经丢掉的城拿产量」，系统里没有任何别的东西会跟它矛盾。`initCities` 直接清空全世界的缓存（它清空了全部归属）。
- **加法，且必须是 `recomputeYield` 的最后一步**（§8.6）。提前一步就会被资源建筑（+10%/级）和战令（+10%）二次放大，§8.1 的上限就不再是上限。测试断言的是**两个乘数不同的玩家之间的差值相等**，而不是某个绝对值——绝对值断言在「加错位置」时照样通过。变异验证：把它挪到战令之前，用例以恰好 +10% 的偏差变红（650 → 715）。
- **§8.5 需要一个时钟**，于是 `PlayerWorldDoc` 新增 `sectSince`，并且 `sectId` 镜像**改为在 worldsvc 自己拥有的四个宗门转换点回写**（create/join/leave/dissolve），不再只在 joinWorld 写一次。这个陈旧度对视野半径可以忍，对一条产量水龙头不行（「我入宗门了产量怎么没变」）。**残留的洞**：加入一个**已经在宗门里的家族**发生在 socialsvc，那边不知道世界的存在——方向是「少给」而不是「多给」，写在 `sectMembershipQualifies` 的注释里。
- **`NATION_BONUS_PRODUCTION` 从产量路径删除**，连带删掉那次 `nations` 读。州府的经济价值已经并进 §8.1 的表，留着就是同一次占领付两次；而且 P0 删掉 `applyNationChange` 之后它在生产环境本来就不可达，唯一还在跑它的是那条 e2e。**那条用例被反转而不是删掉**——一次善意的「加回来」正是双计回来的方式。

#### P3-2 攻城值 / 行军 / 出兵锚点（§8.3/§8.4）

- **攻城值**：进攻方宗门每座州府 +3%、世界中心 +5%，作用在耐久那一下上，**独立乘数**，绝不汇进装备的 `EFFECT_CAPS.siegePct_fp`——那个累加器有上限，共用会让装备好的玩家从宗门的战果里一分钱拿不到。满图 ×1.32 正是 P2 门禁③已经带着测过的数（它把这条和装备的 +60% 都当假想通道叠进去，仍余 1.43×~1.56×），所以接线不改变那个结论。
- **行军 −10%（持有世界中心）**：倍率**快照在行军文档上**（`MarchDoc.speedMult`），两个独立理由——步进扫描必须用算 `arriveAt` 时的同一个值，且中途丢掉世界中心不该给一支已经在天上的队伍重新计时。只打折 `arriveAt` 会让行军在 ADR-051 的遭遇扫描还没走完格子时就「到达」，所以 `marchStepArriveAt` 也吃这个倍率；这个配对做了变异验证（只打一边，用例变红）。返程与召回同样吃打折——不吃的话折扣就取决于队伍朝哪个方向走。
- **锚点**：`move` 到城池地面不再一律拒绝。宗门可以驻进**自己的**城——`garrison` 意图任意城池（那是驻防队，`idleRedispatch` 本来就锁死 garrison），`idle` 意图只允许州府/世界中心。这个不对称**就是 §8.4**：idle 队伍可以原地再出征，所以 idle 驻扎等于锚点，64 座城都能锚等于「前线不存在」。**不是传送**，只是 ADR-051 P3c 的再出征从一个更近的格子起步。
- 规则只写一处（`stationableCityAt`），因为有两处要判：出发校验和到达守卫。这两处漂移是本子系统**已经犯过一次**的错（P0 那个 bug 就是 footprint 排序有三份拷贝），而到达侧**必须**重判而不是信任出发——中途易主的城必须把队伍弹回去，不能让它停进别人的要塞。
- ⚠️ **顺序又一次是关键**：`move` 分支里城池判断排在 `center` 拒绝**之前**，理由和 P1 在 `attack` 分支挪它时一样——`isCityGroundTile` 覆盖 `center`，排在后面会让世界中心成为唯一不能驻扎的城，而它是全图最值钱的锚点。

#### P3-3 宗门驻防队 + §9 的另一半

- **加在 NPC 波次前面，不是替代**（2026-08-27 用户拍板）。文档原来写的是「替代」，但同一份文档的 §5/P2 又把「每次攻城必须真打完 3 波」当成单人每小时输出的**唯一**闸门。纯替代意味着**弱驻防队守的城比无人守的城更好打**——既是对一个实测门禁的平衡回退，也是对那个花了兵去驻防的玩家的陷阱。所以驻防队跑在**未改动**的 NPC 梯前面：驻防是纯上收益，P2 的兵耗下限一个单位不动。
  - 这条决定由**种子序列**钉住：所有梯级共用一条 `waveSeed(marchId, index)` 序列，所以记录下来的最后一个种子就说明打了几级——1 支驻防队 + `CITY_WAVE_COUNT` 波 NPC 意味着最后的 index 是 `CITY_WAVE_COUNT`；如果驻防队**替代**了一波，那会是 `CITY_WAVE_COUNT - 1`。
- **`CityDoc.defenderLock` 未使用即退役**。P1 为这个功能预留了它，但机制早就存在：`applyBaseSiege` 用 `PlayerWorldDoc.teamState[id].injuredUntil` 锁被打败的守队，而 `CITY_WAVE_RESPAWN_MS === SLG_TEAM_INJURY_MS` 在 `shared/test/citySiege.test.ts` 里本来就有断言——两个常量一直是同一个窗口。**按城加锁还会是错的**：一支在 X 城打空的队伍可以立刻去守 Y 城，因为「这支队伍打过了」这件事没有被记在队伍身上。一支队伍，一个受伤时钟。
- **资格每次重新判**（不信任已停放的文档）：城池可能已易主、驻防者可能已退出宗门。宗门不再持有该城的队伍就不再守它。
- **`defenderBaseHp` 在守方梯级不是可选项**——这是 citySiege.ts「差异①」写过并实测过的坑：引擎的象征性基地默认 `BASE_HP=100`，一个 ADR-069 单位一下打掉，战斗在守军参战前就结束，那一级**免费**。第一版漏了它，「强驻防队挡下进攻」那条用例当场以 468 HP 打穿 4,800 HP 变红。
- **v1 的已知不对称（不是本轮引入的）**：守方卡走**基础蓝图**（没有等级/装备加成，`applyBaseSiege` 的注释早就写了这条 v1 限制），进攻方卡有等级/装备注入。所以一支练度高的 12 卡队伍能打穿兵数高出两个数量级的驻防队——测试里的数字看着很怪，原因在这里。要改是另一件事。
- **§9 的另一半：`NATION_BONUS_DEFENSE` 改按 `CityDoc.ownerSectId` 判定**（用户拍板）。文档说保留它作为州府的军事身份，但它读的是 `nations.ownerId`——P0 删掉 `applyNationChange`、`initNations` 又 `$unset` 归属之后，那个字段**没有任何写入方**，于是这条加成对谁都不生效。现在挂在 §7 占领写的同一个把手上，并且从「账号」放宽到「宗门」（州府是被宗门打下来的，已经不存在「拥有这座州府的账号」）。`nations` 集合只剩它仍然权威的东西：首府坐标与名字。

#### 验收

- `shared/test/citySiege.test.ts` +13 例（§8 全部纯函数）；`worldsvc/test/city-payoff.e2e.test.ts` 新增 13 例；`worldsvc/test/city-siege.e2e.test.ts` 22 → 38 例。`nation-bonus.e2e.test.ts` 的产量用例反转。
- 变异验证：城市加成挪到战令前 / 拿掉宗门攻城倍率 / 拿掉锚点种类门 / 只给 `arriveAt` 打折不给步进打折 —— 四条各自打红它自己那一条用例。
- `tsc -b` 全绿、`worldsvc typecheck:test` 全绿、worldsvc 全量套件全绿。
