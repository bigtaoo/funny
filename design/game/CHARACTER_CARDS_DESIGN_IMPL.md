# 角色卡系统 — 对接 / UI / 迁移 / 进度（§9 起）

> 从 [`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md) 拆出（2026-08-17，原文件 556 行）。**小节编号沿用原文**，`CHARACTER_CARDS_DESIGN.md §N` 引用照旧有效。
> 本册内容：§9 PvE 对接、§10 卡背包 UI、§11–§13 拍卖/抽卡/端点、§14–§17 影响面/迁移/开放问题/进度。总览与在先小节见 [`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)。

---

## 9. PvE 战役对接

- PvE 关卡要求特定兵种出场（叙事固定）
- 引擎自动从 `cardInv` 中选取**同兵种战力最高**的卡实例（`selectBestCard(unitType, cardInv)`）
- 卡外观/名字：渲染固定具名角色（李川/陈守/苏远/Max/Lena/Mara），不跟着实例变
- PvE 中兵力消耗：**不计入全局兵力池**（PvE 不是 SLG 资源竞争场景），战斗结算后兵力无变化

---

## 10. 卡背包 UI

### 10.1 展示

- 独立于装备背包（EquipmentScene），入口并列
- 默认排序（`sortCards`，2026-08-01 改）：**先按是否出战中分组**——出战中的卡在前，未出战的在后（此前出战卡按等级/英雄分组散落在网格各处，找不成一队，反馈见 Hero Roster 截图）；组内**按战力降序**，同战力再按等级降序（2026-07-18 的诉求：等级是最重要的信息）→ 英雄分组（`CARD_DEFS` 声明顺序，保留 2026-07-16 的诉求：同名英雄的多张卡聚在一起、不散乱）→ id 稳定。出战分组只影响 `renderList()` 首次排序；`applyCardState()`（见下）晚到的 SLG 数据**不会**触发重排，见该函数注释
- **图标卡网格**（2026-07-03 起，不再用整行列表）：横屏网格左起点为 `sidebarNavW(w,h,true) + ROSTER_GAP`（图标卡起点右移到侧栏右侧）；**竖屏改为整列居中占屏宽 90%**（`avail = round(w*0.9)`，`left = round((w-avail)/2)`，2026-08-09 修——此前竖屏也复用 `marginLineX(w) + ROSTER_GAP` 当左起点，读出来是页边线右侧起排、右边只留一个 `ROSTER_GAP`，形成左宽右窄的不对称留白而非居中收窄的内容列，同 `LOBBY_IA_REDESIGN.md` §21 的 `fullContentW` 竖屏 90% 约定）。**列数固定为一行 5 张**（`ROSTER_COLS=5`，2026-07-16：此前按可用宽自动算列数，横屏 1920 下会排到 6 张、卡片偏窄且间隙偏挤；改为固定 5 列后格子更宽、留白更均匀，窄屏时才会自动降到更少列），格间距用 roster 专属的 `ROSTER_GAP=24`（比共享 `CELL_GAP=12` 更宽松，只影响花名册网格，不动装备/衣柜网格），每格约 266px 高（2026-07-06：与 `EquipmentScene` 的装备/材料图标卡统一尺寸，并整体放大 1.5x，此前为 360px/118px）。卡片布局＝**顶部名字**（+阵营点，过长自动缩放）／**左侧兵种立绘**（`UNIT_ART_URLS[unitType]`，贴图异步加载后自动重绘）／**右侧竖排属性**（**等级＝一排金色星星**，一星一级、最高 9 星，塞不下信息栏宽度时整排缩放到一行内；2026-07-18：此前是 `Lv.N` 小字号数字，太容易被忽略，改用星星更醒目、更易一眼对比、战力分、**攻击、血量**（2026-07-26 新增，见下）、兵力 `cur/cap`、出战·负伤状态）／右下角三**装备槽图标**（2026-07-26 起，见下），右上角锁定图标。边框色编码：负伤=红、出战=蓝
  - **卡高再放大 1.5x（2026-07-14）**：`CARD_CELL_H` 177 → 266（=177×1.5），让全高兵种立绘有更多纵向空间、更耐看。此处**不再**与 `EquipmentScene` 的 `EQUIP_CELL_H`（仍 177）统一——角色卡带立绘、装备格只有小图标，故意分开。宽度不变（仍窄，保持花名册密度）
  - **网格加真 mask（2026-08-09 修）**：此前网格只有行级 draw-cull（一行要么整行画、要么整行跳过，从不裁切），竖屏下滚动到中间态时，顶部仍在可视区内但底部已超出 `availH` 的一行会被整行画出来，盖住下方紧跟着画的底部导航栏（`HubTabs.drawBottomNavTabs`）。改为卡片画进一个裁剪到 `[listY, listY+availH]` 的 `gridLayer`/mask 子层，与 `EquipmentScene` InventoryMixin 的 `gridLayer`/`clip` 写法一致；`peekViewportH` 式的可视区收缩依旧不用（见 `ListMixin.renderList` 内联注释，2026-07-23 花名册 bug 的教训）。详见 `LOBBY_IA_REDESIGN.md` §22。
- 背包容量计数：`已有 / 500`（2026-07-19 由 150 扩容），剩余槽位 ≤ `CARD_INV_OVERFLOW_BUFFER`（=10）时高亮提示（原阈值是独立的 `CARD_INV_WARN`=140 常量，现与满仓溢出邮寄上限合并成一个常量复用）
- **兵力/出战队伍状态接线（2026-07-24）**：`CardCallbacks.getCardState`（+新增 `getTeamName`）此前只有渲染逻辑，`goCardRoster`（`app/nav/game.ts`）从未注入任何实现——玩家进花名册永远看不到兵力 `cur/cap` 与出战状态，见 CC-14。出战 tag 现改为显示实际队伍名（`[出战中：xxx]`），无法解析队名时退回旧文案 `[出战中]`。
- **网格卡新增攻击/血量（2026-07-26）**：此前网格卡只有战力分一个综合数字，看不出兵种是"高攻"还是"高血"的哪种强。新增 `cardAttack()`（`cardDefs.ts`，镜像已有的 `cardHp`/`cardSiegeValue`，同样按兵种查 `UNIT_BLUEPRINTS[unitType].attack`，非按卡实例/等级），网格卡战力行下方新增「攻击」「血量」两行（`roster.atk`/`roster.hp`），卡详情 modal 已有 HP（§10.2）、本次未加攻击行——如需对齐后续可补。
- **网格卡装备槽由圆点改为实际图标（2026-07-26）**：此前右下角三个圆点仅编码"是否已装备"（填充=有/灰=无），看不出装备了什么。改为直接调用 `buildEquipIcon()`（与卡详情 modal §10.2 同一函数）：已装备显示该装备的实际图标（AI 图集或程序化 glyph，按 rarity 着色），未装备显示对应槽位的程序化 glyph 灰色默认图标（30%→35% 透明度，同 modal 的空槽处理）。
- **装备槽图标放大 2x + 出战 tag 加间距（2026-07-28+1）**：`gearIconSize` 22→44px（`list.ts` `renderCardCell`），信息栏（人物立绘右侧）本就窄，3 个 44px 图标一排可能放不下——加了 `gearScale` 防御性缩放，只有列宽实在不够时才等比缩小（下限仍是原来的 22px），避免整排糊到人物立绘上。**实测更正**：常规 1920×1080 横屏布局下这个缩放本来就已经生效（约 0.74x），图标实际约为原来的 1.5 倍而非满 2 倍——`LandscapeLayout` 把 `designWidth` 下限锁在 1920，而人物立绘已经吃掉约 300px 格宽里的大半，留给 3 个图标的空间（约 90–130px）本就小于未缩放所需的 140px；只有明显宽于 1920 的横屏窗口才会跑满 44px。出战 tag（`[出战中：xxx]`）之前紧跟在兵力行下面、没有额外间距，读起来像"又一行属性"；现在多留 6px 让它与上面的属性块视觉上分开一组。见 `test/ui/cardRosterApplyCardState.ui.ts`。
- **兵力/出战数据的加载超时曾比自己的上游超时还紧，导致这批数据经常整体读不到（2026-07-28+1）**：`goCardRoster` 的 SLG 数据（`worldApi.getMe`+`getTeams`）原本卡一个**扁平 1.5s** 超时——但它依赖的 `resolveWorldShard` 自己就留了 3s 的 worldsvc-不可达兜底，1.5s 明显比这个上游步骤自身的最坏情况还短，意味着只要 worldsvc/Atlas 稍慢（不是真的挂了），roster 超时经常在分片解析都没跑完时就已经触发——玩家配好的队伍/兵力在网格里整批"消失"（不是某几张卡漏读，是 `cardState`/`teams` 整个没读到，见 2026-07-28 账号排查：服务端 `playerWorld` 数据其实完好）。修复两步：①超时放宽到 `CARD_ROSTER_SLG_BUDGET_MS=2500`；②`CardScene` 新增 `applyCardState()`（`AppViews.showCardRoster` 现在返回 `CardRosterView` handle），超时先打开空数据的花名册后，若 `getMe`/`getTeams` 之后才 resolve，不再被丢弃——直接对已渲染的每个卡片格调用 `refreshCardCell()`（每格各自的 `PIXI.Container`，位置/尺寸与 SLG 状态无关，无需整表重排）原地刷新边框色/兵力行/出战 tag，详情 modal 若开着也一并刷新，全程不碰侧栏/表头/滚动位置，不做整屏 `render()`。针对性回归测试：`client/test/cardRoster-slg-fetch-timing.test.ts`（伪造 `fetch`+`vi.useFakeTimers()` 钉住 give-up 与 fetch 的三种时序结果）+ `client/test/ui/cardRosterApplyCardState.ui.ts`（真实构造 `CardScene`，验证 `applyCardState()` 原地刷新——同一 `PIXI.Container` 引用、`hitRects` 不重复、`bodyLayer` 顶层子节点整表未变）。
- **装备槽图标"看不出用意"：空槽"+"挪角落 + 图标可单独点（2026-08-01）**：玩家反馈网格卡右下角三个装备槽图标分不清用意——根因两点。①空槽占位（`equipmentGlyph.ts` `drawEmptySlotGlyph`）原来在整个槽位轮廓正中央画一个"+"，饰品槽本体是"矩形+打孔圆"，叠上正中十字后连轮廓一起看像个小人形（圆=头、矩形+十字=张开的身体），而不是"空的饰品槽"。改为把"+"挪到图标右下角做一个独立小圆形徽标（浅色底+十字），三个槽各自的轮廓（武器＝斜向描边、护甲＝素矩形、饰品＝矩形+打孔圆）留在图形中央不受干扰，一眼能分清是哪个部位。②网格里这三个图标此前完全不可单独点——整卡只有一个热区，点哪里都是打开详情 modal，图标看着像按钮却点不动。现在每个图标各自加独立热区（`list.ts` `renderCardCell`），点击直接 `cb.openEquipment(cardId, slot)` 跳转到该槽位的装备场景，与详情 modal 里同一操作（`renderDetailGearSlots`，§10.2）行为一致；离线（`cb.openEquipment` 未注入）时退化为原来的整卡点击，不新增热区。回归测试：`client/test/ui/equipmentEmptySlotBadge.ui.ts`（三种槽位空槽"+"徽标位置一致且偏离图形中心）+ `client/test/ui/cardRosterGearIconClick.ui.ts`（三个图标各自热区先于整卡热区命中、离线时不生成图标热区）。
- **出战 tag 从未真正显示队名，一直退回"[出战中]"（2026-08-02 修复）**：§10.1 2026-07-24 那条记录说出战 tag 会显示实际队伍名，但 `goCardRoster`（`app/nav/game.ts`）构建 `liveTeamNames` 时直接用了 `TeamTemplate.name` 字段——而 v1 没有队伍改名 UI，`setTeams` 存下来的 `name` 永远是空字符串（见 `teamTroops.ts` `teamDisplayName()` 注释），导致 `getTeamName()` 永远返回假值，花名册/卡详情的出战 tag 因此从上线起就一直退回旧文案 `[出战中]`，从未显示过"Team 1"这类队名（`CityScene` 早就用 `team?.name || teamSlotName(i)` 这个 fallback 避开了同一个坑，唯独 roster 这条线没接上）。改为复用 `teamTroops.ts` 已有的 `teamDisplayName()`（空 `name` 时从 `t{n}` 的 id 派生本地化槽位名，如"Team 1"/"队伍 1"）。回归测试：`client/test/cardRoster-slg-fetch-timing.test.ts` 只 mock 了非空 `name`，未覆盖这个空字符串场景。

### 10.2 卡详情 Modal

- 基础属性（按等级展示）、技能描述（含当前等级效果值）、带兵上限
- **等级星星 + HP/攻城值（2026-07-24）**：等级展示由 `Lv.N` 文字统一改为与网格一致的金色星星行；新增 HP、攻城值（siege value）两行静态属性，取自引擎 `UNIT_BLUEPRINTS[unitType].hp/.siegeValue`（`cardDefs.ts` 新增 `cardHp`/`cardSiegeValue`，按兵种查表，非按卡实例/等级，因引擎目前没有per-instance/per-level 的 HP/攻城成长）。
- 装备 3 槽（点击进装备选择流）——**点某一槽直接跳到该槽对应的筛选页签**（武器/护具/饰品），而非停在「全部」（2026-07-14）：被点的 `slot` 经 `openEquipment(cardId, slot)` → `goEquipment(...,initialFilterSlot)` → `EquipmentScene` 构造时播种 `filterSlot`。不带 slot（如从大厅装备背包入口）仍默认「全部」
- 融合入口（2026-07-19 重设计，取代原"携手成长"喂卡流程）：中心卡+5 材料槽环绕布局，见 §3.2；未满级时详情页显示"材料 n/5"进度条（已拥有的同阵营同等级材料数，不是旧版的 XP 进度）
- 锁定/解锁切换
- 挂拍卖行（需先卸下所有装备）
- **视觉化改版（2026-07-05）**：原纯文字布局改为「左侧兵种立绘（96×96，与网格同一张图）＋右侧属性列」；装备 3 槽从纯文字 `+N` 改为实际图标（`equipmentAtlas` 的 AI 位图，未加载时回退 `equipmentGlyph` 程序化图形，按 rarity 着色；空槽以 30% 透明度提示槽位类型）；modal 高度改为按内容动态计算，不再固定尺寸留白
- **阵营改用图腾（2026-07-18）**：角色名旁不再显示阵营**文字**（`涛方`/`Anna方`）——阵营以主角命名，文字紧挨角色名会被误读成"第二个名字"。改为**图腾图标**：涛方＝东方盘龙、Anna 方＝西方纹章鹰（呼应两方中/西名字的花名册）。图腾原打包进独立的 `assets/factions/` 双帧图集（白线透明，运行时按 `FACTION_COLOR` tint；打包脚本 `art/ui/camps/pack_faction_atlas.js`），2026-07-27 资源合并（`ASSET_PACKAGING.md` §8）后并入共享 L0 图集 `assets/icons/icons_atlas.{png,json}`，`factionIcon.ts` 现从 `iconsAtlas` 里按 `tao`/`anna` 帧名取图；开机 L0 预载，程序化 glyph 为解码前兜底。因是精细线稿（≥48px 清晰、≤20px 发糊），**只有卡详情 modal 展示完整图腾**（`buildFactionIcon`，28px）；花名册网格 / 衣柜 / 喂卡等密集小行仍保留纯色**阵营点**（`FACTION_COLOR`，小尺寸靠颜色区分即可）。色值只在 `FACTION_COLOR` 一处定义，任何调用点不会漂移。
- **喂卡选材料改为拖动条（2026-07-18，已被 2026-07-19 融合重设计取代）**：材料行原为 `[−] n/total [+]` 点按步进器——若玩家拥有几十张重复卡，逐张点加号太慢。改为水平拖动条：`n / total` 数字显示在条前，拖动手柄或直接点条上任意位置跳转到对应数量；行左侧点按仍保留原「循环 +1，超上限归 0」的快捷方式。实现上新增 `CardSceneBase.modalSliders`（独立于 `modalHits` 的实时拖拽轨迹，按下即生效，不像普通 modal 命中要等松手）。**2026-07-19 起该"数量拖动条"整套 UI 被 §3.2 的环形融合槽位取代**——融合固定消耗 5 张，不再需要"选几张"这个维度，只剩"选哪几张"，故不再需要拖动条这类数量输入控件；`modalSliders` 基础设施仍保留供其他弹层复用。

### 10.3 受伤状态

- 卡面显示红色受伤遮罩 + 倒计时
- 花 coin 立即恢复按钮（价格见 `ECONOMY_NUMBERS §15`）
- 受伤期间不可被拖入布阵编辑器

### 10.4 皮肤 + 背景故事 + 全卡图鉴（2026-07-13，LOBBY_IA_REDESIGN §15 / ADR-038）

废弃 `CollectionScene`（纯图鉴+衣柜页，功能与养成/生涯页重复度低但布局/风格自成一套），拆解并入既有页面：

- **卡详情 Modal 新增翻转**：点击卡面立绘播放翻转动画（scaleX 1→0→1 的挤压翻转，中点切换正反面内容，`CardScene/detail.ts` 的 `flipDetailPortrait`/`drawDetailFace`），背面展示背景故事文案（新 i18n 字段 `card.<defId>.lore`，与既有 `card.<defId>.desc`——**技能效果说明**——是两个不同槏位，不能共用）。再次点击翻回卡图。
- **换皮肤入口在卡详情**：卡面右下角出现"更换皮肤"角标（仅当该角色有 ≥1 张已拥有的皮肤，`skinsForUnitType()` 非空时才显示），点击弹出可穿戴皮肤选择弹层；确认后该卡的立绘换成皮肤形象展示（皮肤实际美术资源仍未产出——见 `render/UnitView.ts` "Art-blocked"——本次只接好数据/UI 管线）。
- **养成页新增「皮肤」侧栏页签**：`[卡背包|装备|皮肤]`（`CardScene/skins.ts`），按角色分区展示默认外观 + 已拥有皮肤，点击直接装备（客户端同步字段写入，不需要联网，见 §2.3 SAVE_VERSION 5）。
- **衣柜卡片网格改版（2026-07-15）**：原先每个角色一整行纵向堆叠、色卡固定 96px，整屏可用宽度基本没用上（右侧大片空白，且无滚动裁剪，皮肤多时会直接溢出屏幕）。改为每个角色一张卡片——左侧全高立绘（沿用 roster 网格的 0.72 立绘比例）、右侧姓名+阵营点 + 横向铺开的皮肤色卡（超出卡片宽度自动换行）；卡片本身按自适应列数（`CARD_W_TARGET` 决定列宽目标）masonry 网格排列，每列独立追踪当前高度，卡片自身高度随皮肤数量变化。同时补上 `drawScrollIndicator`（此前完全没有滚动裁剪）。**1.5x 收窄跟进（同日）**：卡片整体放大 1.5x 的同时，把 `CARD_W_TARGET` 从 620 降到 440（贴合"立绘+2 张色卡"这一常见内容宽度，而不是撑满列宽留大片空白），副作用是横屏 1920px 宽下从 2 列变为 3 列——空间利用更充分，视为预期行为而非回归。
- **衣柜卡片高度 1.5 倍 + 收紧留白（2026-07-15 二次调整）**：卡片整体尺寸（立绘、色卡、间距）等比放大到约 1.5 倍（`PORTRAIT_MAX_H` 150→225、`TILE_W/H` 84→108 等）；`CARD_W_TARGET` 从 620 收紧到 440（按最常见的 2 张色卡一行的实际所需宽度定），并将 `cellW` 按 `CARD_W_TARGET*1.15` 封顶而非把整行可用宽度平均拉伸，消除了色卡右侧大片留白。
- **全卡图鉴移入生涯组**：新场景 `CardCodexScene`，作为生涯（Career）hub 第 4 个侧栏页签 `[生涯统计|称号|成就|图鉴]`（`CareerTabs.ts`），展示 `CARD_DEFINITIONS` 全池，未拥有角色（`getOwnedUnitTypes()` 判定，无对应 Hero Roster 实例）灰显+锁图标；建筑/法术类卡没有"拥有"概念，恒不锁。
- **离线兜底改为读本地缓存**：原 `CollectionScene` 承担的"养成页离线兜底"角色不再需要——`CardScene` 本身已支持离线只读（喂卡/锁定/挂拍卖等服务器权威操作离线时优雅失败，读 `roster.err.offline`；换皮肤本就是本地操作，离线一样可用）。首次登录、本地无缓存的新玩家展示空态视为正常。

---

## 11. 拍卖行扩展

- 新增 `listingType: 'card'`，`itemId = CardInstance.id`
- 挂单前校验：`card.gear` 全空（含 weapon/armor/trinket 均为 null）
- 买家看到：卡种名称、等级、战力分（空装备状态的战力）
- 税率：10%（与装备/材料一致）
- 卡在拍卖行期间：从 `cardInv` 移入 escrow，不计入 `CARD_INV_CAP`（=500）上限；撤单归还

---

## 12. 抽卡池扩展

- 现有 `standard` 池新增角色卡条目（各等级各兵种权重见 `GACHA_DESIGN`）
- 后期限时活动池：可配置只出某阵营、某兵种、或只出材料
- 抽到的卡直接入 `cardInv`（1 级实例，XP=0）
- 背包满时：卡转等值补偿（coin/材料），不阻塞本次抽卡流程

---

## 13. 服务端端点变更

| 端点 | 变更 |
|---|---|
| `POST /equipment/equip` | 参数 `unitType?` → `cardInstanceId?`（必填之一） |
| `POST /cards/fuse`（2026-07-19 取代 `/cards/feed`） | `{ targetId, materialIds[]（恰好 5 个）, idempotencyKey }` → 校验同阵营同等级+未锁定+未满级，扣除 5 张材料，目标 `level+1`，返回新 SaveData |
| `POST /cards/lock` / `POST /cards/unlock` | 新增（2026-07-14 补齐，CC4 锁定/解锁）：`{ cardInstanceId }` → 翻转 `locked` 标志，返回新 SaveData。幂等（已是目标状态则不 bump rev）。此前客户端 `setCardLock` 已调用但服务端从未注册路由 → 线上一直 404「Action failed」 |
| `GET /cards` | 新增（可选）：返回 `cardInv`（SaveData 推送已覆盖，作补充拉取） |
| `PUT /world/teams` | `ArmyEntry` 字段变：`unitType` → `cardInstanceId` |
| auction 挂单 | 新增 `listingType: 'card'` 分支，校验装备全空 |

---

## 14. 重构影响范围

### 服务端

| 文件 | 变更 |
|---|---|
| `server/shared/src/types.ts` | 删 `unitLevels`/`gear`，加 `cardInv`；`SAVE_VERSION→4` |
| `server/shared/src/cards.ts` | 新文件：`CARD_DEFS`、`cardPower()`、`selectBestCard()`（2026-07-19：`feedXp()`/`LEVEL_CUMULATIVE_XP` 移除，改 `applyFusion()`/`FUSION_MATERIAL_COUNT`/`MAX_CARD_LEVEL`/`CARD_INV_OVERFLOW_BUFFER`） |
| `server/engine/src/balance/equipment.ts` | `applyEquipment` 签名改：接 `CardInstance` 而非 `GearLoadout` |
| `server/engine/src/balance/pveUpgrades.ts` | `buildSiegeBlueprints` / `buildCampaignBlueprints` 签名改 |
| `server/metaserver/src/equipment.ts` | `equipEquipment` 改 `cardInstanceId` 参数 |
| `server/metaserver/src/cards.ts` | `fuseCards()` handler（2026-07-19 取代 `feedCards()`） |
| `server/metaserver/src/service.ts` | 路由 `/cards/fuse`（2026-07-19 取代 `/cards/feed`）；装备穿戴路由参数更新 |
| `server/worldsvc/src/db.ts` | `ArmyEntry` 改 `cardInstanceId`；`CardInjuryDoc` 结算写入 |
| `server/worldsvc/src/siegeEngine.ts` | `buildSiegeBattle` 读 `cardInv` 推导兵种+装备 |
| `server/contracts/openapi.yml` | 新增 Card schema；更新 equip/team 路由 |

### 客户端

| 文件 | 变更 |
|---|---|
| `client/src/game/meta/SaveData.ts` | 同步类型变更 |
| `client/src/game/meta/cardDefs.ts` | 客户端镜像 CARD_DEFS（同 equipmentDefs 纪律）；2026-07-19：容量/等级上限常量改为通过 webpack/vitest/tsconfig 的 `@nw/shared/cards` 别名直接导入 `server/shared/src/cards.ts`（该文件零运行时依赖，浏览器安全），不再镜像 |
| `client/src/scenes/CardScene.ts` | 卡背包 UI（列表+详情+融合）；2026-07-19：`feed.ts` 改为环形融合槽位 UI（见 §3.2），取代原喂经验流程 |
| `client/src/scenes/EquipmentScene.ts` | 穿卸装备改接 `cardInstanceId` |
| `client/src/scenes/TeamsScene.ts` | 布阵调色板从兵种列表改为卡花名册 |
| `client/src/net/ApiClient.ts` | `fuseCards()`（2026-07-19 取代 `feedCards()`）；更新 `equip()` 签名 |
| `client/src/net/openapi-world.ts` | 重生（rest:gen） |

---

## 15. 迁移（存量 SaveData）

v3 → v4 **直接丢弃冲突字段**，不做数据转换：

- 删除 `unitLevels`（按兵种等级，与新模型不兼容）
- 删除 `gear`（全局/按兵种 loadout，已迁入 CardInstance）
- 新增 `cardInv: {}`（空背包）
- `SAVE_VERSION = 4`

玩家首次进入新版本时，触发**新手引导**（送初始 3 张卡 + SLG 赠送 10000 兵力），体验与全新玩家一致。旧养成数据不保留——此次是系统性重构，不是渐进升级。

---

## 16. 开放问题

> 数值权威已全部登记进 [`ECONOMY_NUMBERS §15`](ECONOMY_NUMBERS.md)（角色卡数字单一源）。以下 DRAFT 占位值已随 CC-1~5 落地代码；终态判据 = 上线后 analyticsvc 实测对账、惰性下版本生效。

- [x] 各兵种 `troopCapBase` / `troopCapGrowth` 数值 —— DRAFT 已定（`ECONOMY_NUMBERS §15.1`，真源 `cards.ts`）
- [x] `baseSurvival` 存活率基准值 —— DRAFT 0.2（`ECONOMY_NUMBERS §15.4`，真源 `slg.ts` `CARD_BASE_SURVIVAL`）
- [x] 技能成长表各卡具体数值 —— DRAFT 已定（`ECONOMY_NUMBERS §15.1`，真源 `cards.ts` `skillGrowth`）
- [x] 受伤立即恢复的 coin 价格 —— DRAFT 50（`ECONOMY_NUMBERS §15.4`，真源 `slg.ts` `CARD_RECOVER_COIN_COST`）
- [x] 卡进抽卡池的各稀有度/兵种权重 —— DRAFT 已定（`ECONOMY_NUMBERS §15.5`，真源 `economy.ts` standard 池）
- [x] 背包满时卡的补偿价值表 —— DRAFT 10 coins/张（`ECONOMY_NUMBERS §15.3`，真源 `cards.ts` `CARD_FULL_COMPENSATION_COINS`）
- [ ] 第三阵营设计（→ 未来独立文档，本期不做）
- [ ] 羁绊系统（→ `CHARACTER_DESIGN §3.7`，本期不做）

> 上述 DRAFT 数值均为工程占位、未经数值核验（econ-sim / 实测）；正式调平衡时改 `ECONOMY_NUMBERS §15` 引用的真源常量。

---

## 17. 实现进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| **CC-1 共享类型层** | ✅ 2026-07-01 | `cards.ts`（CARD_DEFS/feedXp/cardPower/selectBestCard）+ `types.ts`（CardInstance/SaveData v4）+ engine 签名更新 |
| **CC-2 metaserver CRUD** | ✅ 2026-07-01 | `cards.ts`（grantCards/feedCards）+ `equipment.ts`（cardInstanceId）+ `service.ts`（cardsFeed/maybeGrantStarterCards/grantClearReward）+ `internal.ts` + `openapi.yml`（CardInstance schema/cards/feed/equip） |
| **CC-3 客户端 UI** | ✅ 2026-07-01 | `CardScene.ts`（卡列表/详情/喂卡流程/锁定/倒计时）+ `cardDefs.ts`（客户端镜像 CARD_DEFS）+ `SaveData.ts`（v4 CardInstance/cardInv）+ `TeamsScene.ts`（卡花名册调色板/补满兵力）+ `EquipmentScene.ts`（activeCardInstanceId）+ `ApiClient.ts`（feedCards/setCardLock/equipEquipment(slot,id,cardId)）+ `WorldApiClient.ts`（distributeTroops/recoverCard/CardSLGState）+ `openapi-world.ts`（PlayerWorldView.cardState/baseTroopStock）+ i18n（roster.*/card.*）|
| **CC-4 SLG 兵力** | ✅ 2026-07-01 | worldsvc cardState + 受伤锁队 + 兵力分配；`db.ts`（CardSLGState/ArmyEntry CC-3/baseTroopStock）+ `siegeEngine.ts`（resolveCardArmy/toEngineCardInstances/computeCardStateUpdates）+ `service.ts`（setTeams CC-3 validation/distributeTroops/recoverCard/landSiege cardState write）+ `httpApi.ts`（distribute/recover routes）+ `openapi-world.yml`（CardSLGState schema/distribute/recover endpoints）|
| **CC-5 拍卖行 & 抽卡扩展** | ✅ 2026-07-01 | `auctionService.ts`（itemType:'card' escrow/grant/cancel/expire/reset）+ `metaClient.ts`（escrowCard/grantCard）+ `internal.ts`（/internal/cards/escrow·grant）+ `economy.ts`（标准池 epic+Tao 卡/legendary+Anna 卡）+ `economy.ts`-metaserver（deliverOrder CARD_DEFS 分支→grantHeroCards+背包满补偿）+ `api.ts`（CARD_NOT_FOUND/CARD_HAS_GEAR 错误码）+ `openapi-world.yml`（AuctionView/createAuction itemType enum） |
| **CC-6 客户端战斗接线** | ✅ 2026-07-02 | CC-1~CC-5 迁移了引擎 + 存档 + UI + 测试，但**真实客户端战斗入口未收尾**：`goCampaign` 仍传旧模型 `unitLevels:{} / equipment:{gear:{},inv}`，从不传 `cardInstances` → 引擎实跑 `buildCampaignBlueprints([], undefined)` = 裸蓝图，**卡等级/装备对战斗零作用、gear 也画不出**（旧字段经对象展开绕过多余属性检查被静默丢弃）。本切片把 `save.cardInv` → `EngineCardInstance[]` 接进战斗:`cardDefs.ts`（`toEngineCardInstances`，defId→unitType）+ `matchEngine.ts`/`GameScene.ts`（opts 去 `pveUpgrades/unitLevels/equipment`，改 `cardInstances`+`equipmentInv`）+ `createAppCore.goCampaign`（传新字段）→ 数值生效；同时 `GameRenderer`/`UnitView` 由 `EngineEquipmentInput` 迁到 `cardInstances`+`equipmentInv`，`gearSpecsFor` 镜像引擎「同兵种取最高等级卡」选卡后读 per-card gear 画立绘叠加（§20.4 数据源接通）。旧 `byUnit/global` loadout 概念作废（per-card 取代，UI 已在 CC-3）。验证：client `tsc --noEmit`(含 test) + webpack 生产构建全绿。 |
| **CC-7 花名册入口 + 旧 UI 清理** | ✅ 2026-07-02 | CC-1~6 建好了 `CardScene`（Hero Roster）却**从未接入任何导航**——玩家进不去。本切片：① 大厅「卡」槽 `onOpenCards` → 新 `goCardRoster`（在线进花名册；离线/未登录回退到离线可用的 Collection＝图鉴+皮肤，Collection 仍可从战役地图达）。链路 `AppViews.showCardRoster` + `app.ts`(`CardScene`) + `HeadlessAppViews`(`cardRoster` 屏) + `createAppCore.goCardRoster`（`feedCards`/`setCardLock`/`openEquipment`→`goEquipment(cardInstanceId)`，server-authoritative 经 `adoptServer`）。② 清掉旧 S12「按兵种等级 + 5合1 merge」死 UI：`LevelPrepScene`（去兵种行/traits/merge，只剩 brief/objective/stamina/start）、`CollectionScene`（删 Units tab，只剩 Cards 图鉴 + Skins）、`createAppCore` 去 `goLevelPrep`/`goCollection` 的 `getUnitLevels/getCardInventory/isOnline/tryMerge` 空 stub、`scenes.ui.ts` 测试同步。验证：client `tsc --noEmit`(src) + `npm run typecheck`(test) + webpack `build:web` 全绿。**遗留**（CC-8 已清）：`saveManager.merge` + `ApiClient.pveMerge` + 生成物 `openapi.ts` 的 `/pve/merge` 曾是孤儿 plumbing，已于 CC-8 连同服务端契约一并退役。 |
| **CC-8 `/pve/merge` 契约退役** | ✅ 2026-07-02 | 清掉 S12 collect-and-merge 遗留链路（超出 CC-7「客户端」范围的服务端活）：`openapi.yml` 删 `/pve/merge` 端点 → `gen:api:server` + `rest:gen` 重生成 `routes.gen.ts`/`openapi.ts`（生成物不手改）；`metaserver/service.ts` 删 `pveMerge` handler + `applyCardMerge` import；`@nw/shared unitCards.ts` 删 `applyCardMerge`/`MERGE_COPIES`/`MergeError`（仅 merge 端点使用；`deriveUnitLevels`/`cardInventory`/`unitLevels` 系 Hero Roster 现役字段，保留）；`pve.e2e.test.ts` 删已 skip 的 S12 merge describe；客户端删 `ApiClient.pveMerge` + `SaveManager.merge` 孤儿方法（`@deprecated` 交叉引用改指向 Hero Roster）。验证：`gen:api:server:check` 零差异 + metaserver/client/shared `tsc --noEmit` + webpack 构建全绿。 |
| **CC-9 关卡掉卡回归修复 + `unitLevels` 退役** | ✅ 2026-07-03 | metaserver e2e 首次真跑（内存 mongo harness）暴露 CC-2 `grantClearReward` 的**关卡掉卡从未真正入 `cardInv`**：`levelCardReward` 返回的是 cardKey（`infantry:1`），而 grantClearReward 拿整条 key 去 `CARD_DEFS.find(d=>d.unitType===key)` 匹配 → 永不命中 → 只返 `grantedCards` 却零卡入花名册（掉卡对玩家彻底失效）。修复：先 `parseCardKey(key).unitId` 再按 `unitType` 匹配 CARD_DEFS（key 里的 tier 仅信息性，实例按 **level 1** 发放——**指的是「每关掉落」**，与新手卡/拍卖/抽卡等所有其它发卡口径一致，§12；玩家靠喂卡升级而非掉落 tier。原 CC-2 代码误传 level=2，因掉卡从未真正执行故从未被观测/校验，随此修复一并归一为 1）。

> **⚠️ 与 §4 的区别（2026-07-07 澄清）**：上述 level 1 只针对**每关掉落**。§4「章节通关（专属奖励）」= 首通某章送对应锚点角色的 **2 级卡**，是一条**独立奖励路径**（已于 CC-11 实装，见下）。同时纠正 CC-8 的误判——`unitLevels` 在 SaveData v4 已删、openapi response schema 会剥离、`/internal/save-fields` 也已改返 `cardInv`，故 `deliverCardGrant`（gacha units 池，仍写 deprecated `cardInventory`）里 `save.unitLevels` 写入是死代码，连同 `economy.ts` 的 `deriveUnitLevels` import 一并退役（`cardInventory` 保留：gacha units 池尚未迁 Hero Roster，`economy.e2e` reconciliation 用例现役）。守卫：`pve.e2e`（掉卡→`cardInv` lichuang/chenshou 实例计数）+ `economy.e2e`（gacha units→`cardInventory`，去 `unitLevels` 断言）。 |
| **CC-10 喂卡请求体字段错配修复 + 契约测试补全** | ✅ 2026-07-04 | 客户端 `ApiClient.feedCards()` 一直发 `{ targetCardId, materialCardIds }`（且不带 `idempotencyKey`），但 `openapi.yml`/`routes.gen.ts` 早已要求 `{ targetId, materialIds, idempotencyKey }`（本文档 §13 也曾误记旧字段名，一并订正）——花名册喂卡升级在生产环境每次都 400。修复：`ApiClient.feedCards()` 补 `idempotencyKey` 参数并映射为契约字段名；`app/nav/game.ts` 调用点补 `genUuid()`。新增测试防止此类客户端-服务端字段名漂移再次发生：① `client/test/api-client.test.ts` 新增卡/装备类接口的请求体断言（feedCards/reforgeEquipment/craftEquipment/enhanceEquipment/salvageEquipment/equipEquipment/setCardLock，逐字段核对 wire body）；② 新增 `server/metaserver/test/openapi-request-schema.test.ts`，遍历 `openapi.yml` 全部 76 个操作的 requestBody schema，用真实 ajv 校验「仅含 required 字段的最小 payload 能通过」+「去掉任一 required 字段必失败且报错指名该字段」，防 spec/codegen 的 `required` 与 `properties` 脱节（已用故意注入 stale required 字段验证会失败，随后复原）。**已知局限**：后者只守服务端契约自洽性，不能替代①对客户端实际发送字段名的断言——两者互补，缺一不可。 |
| **CC-11 章节通关专属奖励（§4 送 2 级锚点卡）** | ✅ 2026-07-07 | 补上 §4「章节通关（专属奖励）」缺失实现——首通某章送对应锚点角色的 **2 级卡**（独立于每关掉落的 level 1）。`@nw/shared pveRewards.ts` 新增权威映射 `CHAPTER_ANCHOR_CARD`（ch1→lichuang / ch2→max / ch3→chenshou / ch4→lena / ch5→suyuan / ch6→mara，涛奇 Anna 偶，按兵种位配对，见 CHARACTER_DESIGN §5.1）+ `chapterOf`/`chapterAnchorCard`/`CHAPTER_ANCHOR_CARD_LEVEL=2`。`pve.ts`：`writeClearProgress` 在同一 rev 事务内检测「章节 finale 首通」（比较前后 `chaptersClearedCount`，与 `campaign.chaptersCleared` 同触发点、天然幂等：重放不变、并发重复失 rev 竞争后重读已含 finale），回报 `newlyClearedChapter`；新增 `grantChapterClearCard` 用 `grantCards(...,level=2)` 发卡，背包满走 `commercial.grant`（`reason:'chapter_card_inv_full'`，确定性 orderId，与 gacha CC-5 同路径补偿）。发放点：常规路径在 `grantClearReward` **之前**（使返回 save 反映新卡）；spot-check 路径与进度一并发放（一次性、不可farm，不随物资奖励延到 /pve/verify）。守卫：`pve.e2e`（首通 finale→level-2 锚点卡实例、重放不重复、偶数章→Anna 锚点、spot-check 路径亦发）+ `pveRewards` 单测（映射覆盖全章 + 解析 + 每章有锚点）。 |
| **CC-13 融合升级重设计 + 背包 500 扩容** | ✅ 2026-07-19 | 玩家反馈旧版连续 XP 曲线下"喂到 6 级要几千张卡"直接吓退新玩家。改为离散五合一融合（§3）：`server/shared/src/cards.ts` 删 `feedXp`/`LEVEL_CUMULATIVE_XP`/`CardInstance.xp` 字段，新增 `applyFusion()`/`FUSION_MATERIAL_COUNT`(=5)/`MAX_CARD_LEVEL`(=9，原散落各处字面量 9 收拢成命名常量)；`server/metaserver/src/cards.ts` `feedCards()`→`fuseCards()`，校验材料数量恰好 5、同阵营同等级、未锁定、目标未满级；契约 `POST /cards/feed`→`POST /cards/fuse`（`server/contracts/openapi/paths/inventory.yml`+`schemas.yml`，重跑 `gen:api:contracts`/`gen:api:server`/client `rest:gen`）。背包容量 `CARD_INV_CAP` 150→500，且 client `cardDefs.ts` 不再镜像该常量与 `MAX_CARD_LEVEL`/`FUSION_MATERIAL_COUNT`，改由新增的 `@nw/shared/cards` webpack/vitest/tsconfig 别名直接指向 `server/shared/src/cards.ts`（零运行时依赖，浏览器安全）导入，是本仓库首次为 client 打破"镜像纪律"、走真正去重。满仓预警阈值 `CARD_INV_WARN`(140) 与溢出邮寄上限 `INV_FULL_MAIL_COUNT`(10) 合并成一个复用常量 `CARD_INV_OVERFLOW_BUFFER`(10)。客户端 `CardScene/feed.ts` 重写为环形融合槽位 UI（中心卡+5 材料槽，§3.2），融合动画为程序内占位特效（`playFusionAnim`），后续接入 `vfx-editor` 专门制作的资源即可替换，改动局部在 `feed.ts` 内。新增 `test/ui/cardFusePanel.ui.ts`（取代 `cardFeedPaging.ui.ts`，覆盖候选分组过滤/填槽/撤槽/Confirm 门控/滚动状态 8 用例）+ `fuseBtnWidth.ui.ts`（取代 `feedBtnWidth.ui.ts`，三语言按钮宽度自适应）；`vitest.ui.config.ts` 补 `@nw/shared/cards` 别名（`cardDefs.ts` 现在从这里导入常量）。验证：server `shared`(30 文件/595 测试)+`metaserver`(47 文件/632 测试) 全绿；client `tsc --noEmit`+`typecheck`(test 层)+`vitest run`(105 文件/737 测试)+`test:ui`(72 文件/658 测试) 全绿；webpack 生产构建成功。 |
| **CC-12 标准池抽卡未真正发到花名册 + shopBuy 同类 bug 修复** | ✅ 2026-07-15 | 玩家反馈抽到的角色卡（如 `suyuan`）在 Hero Roster 里完全不显示。根因：`gachaDraw`（`service/economy.ts`）从未调用 CC-5 建立的按类型分发逻辑（materials/equipmentInv/cardInv/skins），而是把所有抽奖结果无差别塞进 `inventory.skins`——CC-5 落地时只接进了 `deliverOrder`（shop/mail/reconcile 复用），gachaDraw 走的是一条独立的、更早的「纯皮肤」代码路径，两条路径此后没有同步。修复：把 `deliverOrder` 的战利品分类逻辑抽成共享函数 `deliverLootBox`（`economy.ts`），`gachaDraw` 改为调用它（保留原有的 `orderDelivered` fire-and-forget 延迟优化）。审计同类问题时又发现 `shopBuy`（商城直购 handler）同样从未按 `SHOP_ITEMS.kind` 路由——`protect_enhance`（kind='item'，装备强化保护道具）被当皮肤存进 `inventory.skins`，从未真正写入其消费点读取的 `inventory.items`；连带发现**reconciliation 路径本身也有同一缺陷**（`deliverOrder` 的 shop 分支按 itemId 正则/装备表猜测类型而非查目录 `kind`，`protect_enhance` 同样被猜成皮肤，是死代码从未生效）——一并改为 `findShopItem(itemId)?.kind` 查目录。审计过程顺带发现并修复一个 schema 截断类 bug（与历史 `subscriptionLastClaimDay` 同类）：`claimBattlePass` 响应 openapi schema 漏了 `reward.id` 字段，服务端算对了但被 ajv 响应校验静默丢弃（客户端目前不读该字段，未造成可见问题，仍按同类修复补上）。**生产数据修复**：脚本化扫描 `inventory.skins` 里误存的角色卡 id / `protect_enhance`，dry-run 确认后对 3 个真实账号执行了一次性补发迁移（角色卡→`cardInv`、`protect_enhance`→`inventory.items`，从 `skins` 移除；因原 bug 用 Set 去重、无法还原真实抽卡/购买次数，卡/道具补发按「每种 id 补 1 份」保守处理）。新增/补全测试：`economy.e2e.test.ts`（gacha 卡/shop item 两个回归用例）、`retention.e2e.test.ts`（签到 day-4 材料/day-14 卡/day-30 装备三个里程碑首次覆盖真实 claim 端点，此前只测过 schema）、`battlepass.e2e.test.ts`（全新文件，`/battlepass/buy`+`/claim` 此前零测试覆盖）、`mail-claim.e2e.test.ts`（补 coins/item/material/skin 四种附件类型混合场景）。全量回归：metaserver 45 个测试文件/566 个测试、shared 29/574 个测试全绿。 |
| **CC-14 花名册兵力/出战/HP·攻城值补全** | ✅ 2026-07-24 | 玩家反馈花名册卡面看不到兵力数量、当前所属队伍、装备信息。排查发现 `CardScene`（`list.ts`/`detail.ts`）**渲染逻辑早就写好**（兵力 `cur/cap`、出战 tag、装备槽圆点），但唯一的调用点 `goCardRoster`（`app/nav/game.ts`）从未提供 `CardCallbacks.getCardState`——SLG 卡状态（`worldsvc PlayerWorldView.cardState`）与账号态 SaveData 分属两条数据流，前者从未被接进花名册这个死代码路径。修复：`goCardRoster` 联网时 `resolveWorldShard` + `worldApi.getMe`/`getTeams` 拉一次 `cardState` + 队伍名，缓存后注入 `getCardState`/新增的 `getTeamName`（`CardScene` 无 live-refresh 钩子，只能开屏前拉一次；离线/未登录/拉取失败或超过 1.5s 自定超时静默回退无 SLG 数据，不复用 `resolveWorldShard` 自身 3s 兜底，避免拖慢这个高频大厅入口）。出战 tag 从固定文案改为显示解析到的实际队伍名。同时补上详情 modal 的等级星星（原 `Lv.N` 文字，统一到网格的星星约定）+ 新增 HP/攻城值两行（`cardDefs.ts` 新增 `cardHp`/`cardSiegeValue`，查引擎 `UNIT_BLUEPRINTS[unitType]`）。验证：client `tsc --noEmit`(含 test) + webpack `build:web` 全绿；构造假 `CardCallbacks`（含 `cardState`/`teamNames`）直接渲染 `CardScene` 截图核对网格卡（兵力/出战队名/装备圆点/受伤倒计时）与详情 modal（星级/HP/攻城值/队名/无重叠）。 |
| **CC-15 `cardInv` 存储拆分（2026-07-27 全服 Mongo/Redis 审计后续）** | ✅ 2026-07-27 | 装备 `equipmentInv`（2026-07-26，见 `EQUIPMENT_DESIGN §3.3`）拆分独立集合后，`cardInv`（最多 500 张卡）是存档文档体积的第二大不确定贡献者——照抄同一套拆法：新建独立集合 `cardInstances`（`_id`=instanceId，`{accountId:1}` 索引），`SaveData` 新增 `cardInvCount` 镜像字段做 cap 快速校验（会漂移，`GET /save` 的 join 顺手纠正）。**线格式不变**（客户端/worldsvc 零改动）——`GET /save`/`/internal/save-fields` 读完之后现拼回完整 map（`assembleCardInv`）；`app.ts` 的全局 `preSerialization` 钩子同一处扩展，兜底所有返回 `save` 的响应。只做拆分本身（等价装备拆分「阶段一」），不做响应精简（装备「阶段二」，本次不跟进）。**交叉依赖**（最容易漏改的两处）：`equipment.ts` 的 `isEquipped`/`equipEquipment` 原本直接读写 `save.cardInv`（判断装备是否被某张卡穿戴/写入穿戴槽位），改成查询 `cardInstances`（`isEquipped` 用 `$or` 覆盖 `EQUIP_SLOTS` 各槽位字段做定向查询，而非全量扫描）；`pve.ts` L1 判定快照（`pveVerifications.cardInv`，PVE_INTEGRITY §9）原本 `{...cur.cardInv}`，改成 `assembleCardInv(cols, accountId, cur)`。`fuseCards`（融合）改写为「校验一次→提交一次」（不是装备 craft/enhance/salvage 那种「读-改-重试循环」）——目标卡用 `level` 字段做细粒度乐观锁（同 `enhanceEquipment` 手法）成功后才删 5 张材料，避免destructive 批量操作在 rev 冲突重试时把已提交的分类结果重新分类导致重复受益；`grantCards`（批量发卡）保留原有「读-改-重试」结构，但把「count/mail 配额决策」与「实际写卡」拆成两步——save 侧计数先提交（决定这一次重试胜出）成功后才落地卡实例，避免同一批待发卡在跨重试改判时被计两次。新增 `escrowCard`（拍卖行挂拍，原逻辑内联在 `economyRoutes.ts` 里，此次顺手提炼成 `cards.ts` 函数，镜像 `escrowEquipment`）。迁移脚本 `metaserver/scripts/migrateCardInv.ts`（幂等、按 `save.cardInv` 是否还存在做断点续跑，**必须先在生产跑到 100% 完成再部署新代码**）。落地 = `server/shared/src/{mongo,types}.ts`（`CardInstanceDoc`/`cardInstances` 集合/`cardInvCount`/`SAVE_VERSION` 6）+ `server/metaserver/src/cards.ts`（全部改写）+ `equipment.ts`（`isEquipped`/`equipEquipment`）+ `app.ts`/`economyRoutes.ts`/`service/{auth,economy,pve}.ts` 各交叉点 + 迁移脚本 + 测试（新增 `test/helpers/cards.ts`，改 `cards.e2e`/`economy.e2e`/`internal-economy`/`pve-verify.e2e`）。验证：metaserver 54 文件/678 测试、worldsvc 44/341、auctionsvc 5/71 全绿（worldsvc/auctionsvc 只读拼好的 map，零改动，仅回归验证）。 |
| **CC-16 `migrateCardInv.ts` 部署顺序违反：迁移脚本从未在生产跑过（2026-07-29 事故复盘）** | ✅ 2026-07-29 | 玩家反馈「任何角色都无法穿戴装备」，`POST /equipment/equip` 返回 `NOT_FOUND card instance not found`。排查发现 CC-15 上线时**违反了自己文档里写的部署顺序**：`equipEquipment`（改读 `cardInstances`）等新代码已上线，但 `migrateCardInv.ts` 从未在生产执行过——查生产 Mongo（只读）确认全库 **1706 个存档、1706 个都还带着 `save.cardInv`**（0 完成）。因为 CC-15 之后新建的卡（gacha/融合等）已经直接写 `cardInstances`（`cards.ts` 现行代码路径），只有**切换前就存在的老卡**卡在旧的内嵌字段里、对 `cardInstances`-only 的功能（穿装备/融合/拍卖行 escrow/worldsvc 攻城拉军队）全部不可见——受影响账号的具体症状取决于该账号还剩多少张"切换前的老卡"仍在用（复现账号 43 张老卡全部带满装，是长期主力卡组，故 100% 复现"随便选哪张卡都失败"）。修复：无需改代码——`migrateCardInv.ts` 本身按设计幂等/可断点续跑，直接对生产执行（先 `--dry-run` 确认范围，再正式跑）：1706 账号全部处理，5333 张老卡实例迁移，0 失败，迁移后 `save.cardInv` 全部清零。**后续待办**：这类"迁移脚本代码已合并但未来得及在生产实际执行"就被后续代码依赖的部署顺序违规，目前无自动化守卫（脚本头部注释是唯一防线，容易在多任务并行时被忽略）——建议后续考虑加一个启动期健康检查（`save.cardInv` 存在的账号数 > 0 时输出告警日志），而不是仅靠人工遵守文档约定。 |
| **CC-17 CC-16 事故的补测试回合，顺带揪出并修复一个真实（当前无实际影响但会复发）的 bug（2026-07-29）** | ✅ 2026-07-29 | CC-16 修完之后用户主动要求"还能加什么针对性测试"，补了四类：① 客户端 `game-nav-equip-cardInv-sync.test.ts` 补两例（穿一个槽位不动其它已穿槽位；替换已穿槽位的旧实例不留残留）。② `migrateCardInv.ts` 此前**零测试覆盖**——`migrateOneAccount` 导出 + `dryRun` 改成显式参数（不再读模块级 `process.argv` 常量）+ 底部加 `isMain` 守卫（镜像 `samplePvpReplays.ts` 的已有写法）使其可被安全 import，不触发真连库；新增 `migrateCardInv.e2e.test.ts`（6 例：dry-run 不写/真实迁移/重跑幂等/**tao 那种"部分已迁移"形状**/并发 rev 冲突下重试成功不丢卡/重试耗尽后优雅放弃且不丢数据）。③④ 在补"partial 迁移形状"这一类测试时，直接用真实 HTTP `GET /save` 复现该形状（`cards.e2e.test.ts` 新增 describe 块），**红了**——发现 `app.ts` 的全局 `preSerialization` 钩子（CC-15 引入的兜底拼装逻辑）判断条件是 `save.cardInv === undefined` 才回填，账号处于"部分迁移"（`cardInv` 是非空但不完整的旧对象，不是 `undefined`）时该条件为假，直接**跳过回填**，只返回残留的旧内嵌卡，`cardInstances`-only 的新卡整批从响应里消失。因为 CC-16 事故期间全库 1706 个账号有 2 天都处在这个"非空但不完整"的状态，这个此前从未被测试覆盖的分支理论上会让所有玩家的花名册在这 2 天里只显示"切换前的老卡"、漏掉期间新抽到的卡——**当前无实际影响**（今天已经把全库迁移彻底跑完，`cardInv` 现在对所有账号都是真正的 `undefined`，触发正常回填分支），但如果这类"部分完成"的中间状态未来再次出现（另一次类似拆分、或误跑了旧备份），会同样的方式再炸一次。修复：`app.ts` 判断条件从"仅 `undefined` 时回填"改为"非 `null`（`null` 仍是 EQUIPMENT_DESIGN §3.3 的显式精简 opt-out，原样放过）时都跑 `assemble*Inv` 并与已有内容合并（`cardInstances`/`equipmentInstances` 的结果优先覆盖同 id 项，因为它是权威源）"，`equipmentInv` 同步做了同样处理（对称，虽然它自己的迁移已跑完、当前没有已知的"部分状态"风险，但同一模式将来复发时这里也不会漏）。metaserver 全量回归 61 文件/735 测试全绿（含新增两个测试文件）；client `tsc --noEmit` + 相关测试全绿。 |
| **CC-18 融合动画播放时面板被关闭（2026-08-01）** | ✅ 2026-08-01 | 玩家反馈：点 Fuse 后，融合环形选材面板被关掉了，动画飘在背景板上。根因：`CardSceneBase`（`base.ts`）订阅 `cb.onSaveChanged` 时直接 `() => this.render()`，没有像 `update()` 里的 busy-dots 重绘那样接 `fuseInProgress` 守卫（见 CC-13 之后补的同类修复）。`fuseCards` 的真实实现（`app/nav/game.ts`）经 `saveManager.adoptServer(save)` **同步**触发所有 `onSaveChanged` 监听者（`SaveManager.subscribe` 注释原话："fires synchronously and with no payload"）——这发生在 `doFuse`（`actions.ts`）await 到 `fuseCards()` resolve 的那一刻，即 `playFusionAnim()` 真正运行**之前**。未加守卫的 `render()` 因 `detailId` 全程未清空，会走 `openDetail()` → `tearDownChildren(modalLayer)`，把融合环形面板整体拆掉重建成一个普通详情面板，随后 `playFusionAnim` 把动画图形加到这个新面板对应的 `modalLayer` 上——视觉上就是"面板被关了，动画飘在背景上"。修复：`base.ts` 的 `onSaveChanged` 回调同样接 `fuseInProgress` 守卫，跳过的重绘由 `doFuse` finally 块里既有的 `render()`/`onSettled` 收尾补上，不丢数据。新增回归用例 `test/ui/cardFusePanel.ui.ts`「a save-changed listener firing synchronously mid-fuse」，用一个在 `fuseCards` 桩函数内部同步调用 `onSaveChanged` 监听者的写法真实复现 `adoptServer` 的时序（而非只测 `update()` 的 busy-dots 路径），修复前失败/修复后通过。另补两例守住守卫本身不矫枉过正：①「onSaveChanged still triggers a normal re-render when nothing is mid-fuse」——接一个真实 `SaveManager`，非融合期间的存档变更（如别处花钱）必须仍能自动刷新花名册（此订阅本为此而设，早于融合功能存在，见 `saveManagerAutoRerender.ui.ts` 对 Gacha/BattlePass 的同款覆盖）；②「after a fuse settles, a later onSaveChanged fire renders again」——融合结束、`fuseInProgress` 归位后，后续存档变更仍能正常触发重绘（守卫是临时的，不会卡死）。验证：client `tsc --noEmit` 全绿；`test:ui` 100 文件/856 测试全绿（含新增 3 例，`cardFusePanel.ui.ts` 23→25）。 |
| **CC-19 `escrowCard`/`fuseCards` 先做破坏性删除、rev 重试耗尽后台账丢失（2026-08-04 全量 code review）** | ✅ 2026-08-04 | 与 `EQUIPMENT_DESIGN.md §10` 同一批修复中影响 `cards.ts` 的两处：`escrowCard`（拍卖行挂拍托管）原先"先无条件删除卡实例，再进 rev 循环写 `cardIdem` 幂等记录 + 扣 `cardInvCount`"——循环耗尽直接 `REV_CONFLICT`，卡已经真被删了却没留下任何托管记录，客户端重试会发现卡凭空消失、拍卖单也建不起来。改为幂等记录的 `$setOnInsert` 挪到删除之后、计数重试循环之前——重试耗尽时直接报成功（`cardInvCount` 只是自愈的展示镜像，真正的托管记录已经落地），镜像 `equipment.ts` 的 `escrowEquipment` 同款修复。`fuseCards`（五合一融合）是相反方向：目标卡升级 + 消耗 5 张材料这个"提交"本身用 `level` 字段乐观锁一次性完成（§3 设计如此，不是读改写重试循环），重试的只是`cardInvCount` 递减这个纯展示镜像；原先重试耗尽会 `deleteOne` 幂等记录再报 `REV_CONFLICT`——融合本身早已生效，删记录会让客户端重试时重新进入这个函数、找不到已经被消耗掉的材料卡（`CARD_NOT_FOUND`），把一次已经成功的融合报告成失败。改为耗尽时直接报成功（读一次最新 save 附带返回），不删幂等记录（保留它使同 key 重放会命中上面已有的 replay 分支，而该分支本就会重新读真实的融合后卡状态，不会返回过期缓存值）。回归见 `server/metaserver/test/cards.e2e.test.ts` 新增用例。 |

> **收尾**（2026-07-01）：任务期间遗留的 `gateway`/`gameserver` 两条 `tsc --noEmit` 报错（`Cannot find module '@bufbuild/protobuf/wire'`）经排查与角色卡任务无关——`server/node_modules` 缺失 `@bufbuild/protobuf`（package-lock.json 已声明但磁盘未装，node_modules 陈旧），`server/` 下 `npm install` 重装后两包 `tsc --noEmit` 转绿，无源码改动。

> **CI 修复**（2026-07-01）：CC-4/CC-5 改了 `openapi-world.yml`（新增 `distributeTroops`/`recoverCard` 路由、`cardState`/`baseTroopStock` 响应字段、`cardInstanceId`/`itemType: card` 枚举）但未重新生成 `worldsvc/src/generated/routes.gen.ts`，导致 `gen:api:world:check` 失败。跑 `npm run gen:api:world`（47 operations）重生成即修复。生成物勿手改，改契约后必跑一次生成。

> **测试类型漂移清理 + CI 类型检查**（2026-07-01）：CC-1 把 `GameConfig.unitLevels`→`cardInstances`、`JudgeRequest` 加必填 `unitLevels`，但 `client/test` 从不被类型检查（`tsconfig.json` include 只有 `src/**`，vitest 走 esbuild），旧形状运行期侥幸通过。迁移的 test：`diag.test.ts`/`difficultySim.ts`（`progressionUnitLevels`→`progressionCards`，走 `cardHelpers.card()`）、`siege.test.ts`+`pve-judge.test.ts`（`JudgeRequest` 补 `unitLevels`/`defenseJson`）、`hardwall.test.ts`（`players` tuple 类型）。顺带清了同层历史漂移（`HeadlessAppViews` 补 `showTitles/showDaily/showEvents/showCity`、`stateReplay`/`judge-runner`/`scenes.ui`/`net-input-source`/`saveData`）。**根治**：新增 `client/tsconfig.test.json` + `npm run typecheck`，CI `build-test` job 单测前跑，test 层漂移从此编译期红。详见 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md) 静态类型检查节。
