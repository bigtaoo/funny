# 大厅信息架构重规划（讨论稿）

> 状态：**IA 方向已拍板**（2026-06-27），细节待定；先文档后实现。
> 日期：2026-06-27。
>
> **已拍板**（见 §6）：① 装备并入「养成」tab；② 「战绩」改名升级为「生涯」中心（收成就+天梯+称号+战绩+录像）；③ 付费主轴只靠「商城」tab + 红点曝光，**主页不放战令 banner**（克制路线）。
> 范围：大厅（`LobbyScene`）一级入口的重新分组、底部 tab 的重新定义、被埋功能的上浮、以及各入口内部功能的归并。
> 权威来源：本文为入口/IA 规划，具体场景实现以各模块设计文档为准（`EQUIPMENT_DESIGN` / `SEASON_DESIGN` / `RETENTION_DESIGN` / `SOCIAL_DESIGN` / `SLG_DESIGN` …）。

---

## 1. 为什么要重规划

盘点了 31 个场景后，结论：**问题不在视觉布局，在信息架构错位**——大厅一级位暴露的不是玩家最高频该点的，而核心循环全埋在二三级页。

### 1.1 被埋得太深的核心功能

| 功能 | 现入口（深度） | 性质 | 问题 |
|---|---|---|---|
| 装备 / 强化 / 锻造 / 分解 | 战役地图 → EquipmentScene（2 级，且仅 PvE 路径） | 核心养成循环 | 大厅够不着，必须先进战役 |
| 战令 Battle Pass | 战绩 → BattlePassScene（2 级） | 核心付费 + 留存 | 付费主轴埋两层，曝光极低 |
| 盲盒 / 抽卡 Gacha | 商店内 🎁 按钮 | 核心付费 | 入口藏在按钮里 |
| 赛季天梯榜 Leaderboard | 战绩 → LeaderboardScene（2 级） | 竞技目标 | 竞技玩家找不到排名 |
| 成就 Achievements | 战绩 / 大厅 toast（2 级） | 目标系统 | 散落 |
| 称号 Titles | 设置 → TitlesScene（2 级） | 目标系统 / 炫耀 | 散落 |

### 1.2 「战绩」tab 是杂物抽屉

现「战绩」内塞了：战绩 + 排行榜 + 战令 + 成就 + 录像。
混淆了两类完全不同的意图：
- **被动查看**（我的战绩、对战历史、录像）——低频；
- **主动养成/领奖**（战令、成就、天梯目标）——高频、有红点驱动。

把高频领奖塞进低频查看页 = 玩家不会主动去点。

### 1.3 一级位的性价比错配

- 一级大卡给了「**限时活动**」（常态灰着、活动期才亮）这种低频功能；
- 中部存在**大片视觉空白**（截图可见）；
- 「**大世界**」误判离线（健康探针比功能路由脆，见 §6 附录 bug 清单）。

---

## 2. 重规划原则

1. **按玩家动机分组，不按系统分组**。玩家想的是「我要变强 / 我要花钱 / 我要打 / 我要找人 / 我要看目标」，不是「这是成就系统、那是战令系统」。
2. **核心循环一级可达**：每天要点的（养成、领奖、付费钩子）≤1 次点击触达。
3. **低频功能折叠**：录像、设置、称号详情等收进二级，不占一级位。
4. **红点驱动归位**：所有「可领取」红点集中在玩家会主动巡视的入口上（养成 / 商城 / 每日）。
5. **SLG 生态保持隔离**：WorldMap 及其下（家族/宗门/拍卖/队伍/布兵）自成闭环，不拆进大厅，仅保留大世界这一个入口。
6. **离线优雅降级**：离线可玩的（战役/收藏/战绩）正常，在线专属的灰显或引导登录，而非误判。

---

## 3. 提案：新的底部 5 tab（按动机分组）

> 保持 5 个底部 tab（移动端惯例上限），但重新定义每个 tab 的职责。

| 位 | 新 tab | 收纳功能 | 替代现在的 |
|---|---|---|---|
| 1 | **养成**（卡组/收藏 + 装备） | 卡牌图鉴、皮肤衣柜、单位升级、**装备/强化/锻造/分解** | 「卡组」扩容 |
| 2 | **商城** | 直购、充值、**盲盒/抽卡**、**战令 Battle Pass** | 「商店」扩容 |
| 3 | **主页**（中心，最大） | 开始匹配 + 战役 + 大世界 + 侧栏高频图标（见 §4） | 「主页」 |
| 4 | **生涯**（拍板命名） | **成就** + **赛季天梯榜** + **称号** + 战绩 + 对战历史 + 录像 | 「战绩」升级为目标中心 |
| 5 | **社交** | 好友、私聊、邮件 | 「社交」 |

### 关键变化

- **装备上浮到「养成」tab**：和卡牌/皮肤/升级归到一处，因为它们都是「把我的东西变强」。同时**保留**战役准备页（LevelPrep）里的装备快捷入口，方便闯关前临时调整。
- **战令 + 盲盒上浮到「商城」**：付费主轴进商城首屏，商城首页做成「直购 / 盲盒 / 战令」三入口或顶部 banner。
- **「战绩」升级为「生涯/目标」中心**：把成就、天梯榜、称号、战绩、录像统一收纳——这才是「我的目标与荣誉」页，红点（成就可领）也归位在这。
- **「限时活动」从一级大卡降级**：进主页侧栏图标（活动期才亮），不再占一级大卡位。

> 备选：若觉得「养成」与「商城」职责偏重，可考虑把装备单独拆为第 6 个动机但**不建议**——5 tab 是移动端体感上限，第 6 个会挤。

---

## 4. 主页（中心 tab）的重排

目标：消除中部空白，把高频「领奖/钩子」用**侧栏小图标**收纳，主区聚焦「我要打什么」。

```
┌─────────────────────────────────────────────┐
│ [头像/名/段位]          [金币]  [钻石/付费货币] │  顶栏（点头像→资料弹层，已实现）
├─────────────────────────────────────────────┤
│                                          ┌──┐ │
│         ┌───────────────────────┐        │每│ │  侧栏高频图标（带红点）：
│         │     开 始 匹 配         │        │日│ │   · 每日签到/任务
│         │  排位 · 5-10 分钟       │        ├──┤ │   · 邮件
│         └───────────────────────┘        │邮│ │   · 活动（活动期才亮）
│                                          │件│ │   · 成就（可领时亮）
│   ┌──────────┐  ┌──────────┐            ├──┤ │
│   │  战 役   │  │ 大世界    │            │活│ │
│   │ PvE 闯关 │  │ SLG 远征  │            │动│ │
│   └──────────┘  └──────────┘            └──┘ │
│                                               │
│            （主区留白可放赛季/段位信息          │
│             或当前活动 highlight，不放付费）    │
├─────────────────────────────────────────────┤
│  养成   │  商城   │  ★主页   │ 生涯  │ 社交  │  底部 5 tab
└─────────────────────────────────────────────┘
```

要点：
- 三大玩法（匹配/战役/大世界）仍在主区，但**收紧不留大空白**；
- **侧栏图标条**承载每日/邮件/活动/成就这类「有就亮、可领就红点」的高频低占位功能；
- **付费主轴（战令/盲盒）不侵入主页**（拍板克制路线）——曝光集中在「商城」tab，靠商城红点提醒；
- 「限时活动」从大卡降为侧栏图标。

---

## 5. 各入口内部功能归并（二级页规划）

| 一级 tab | 内部结构（tab/分区） |
|---|---|
| **养成** | ① 卡牌图鉴 ② 皮肤衣柜 ③ 单位升级 ④ **装备**（背包/强化/锻造/分解/重铸） |
| **商城** | ① 直购/充值 ② **盲盒抽卡** ③ **战令 Battle Pass** |
| **主页** | 匹配 / 战役 / 大世界 + 侧栏（每日/邮件/活动/成就）+ 战令 banner |
| **生涯/目标** | ① 战绩总览 ② **成就** ③ **天梯榜** ④ **称号** ⑤ 对战历史/录像 |
| **社交** | ① 好友 ② 邮件 ③（私聊从好友进） |
| **大世界**（主页内入口，自成闭环） | 地图 + 家族/宗门 + 拍卖行 + 队伍/布兵（维持现状不拆） |

> 注：邮件目前在社交内（FriendsScene 第三 tab）。主页侧栏的「邮件」图标是快捷入口，点击直达社交的邮件 tab；不重复实现。

---

## 6. 拍板记录与剩余开放问题

### 已拍板（2026-06-27）

1. ✅ **装备归属** → 并入「养成」tab（保留战役准备页快捷入口）。
2. ✅ **第 4 tab 成立并命名** → 「**生涯**」，收 成就 + 天梯榜 + 称号 + 战绩 + 录像。
3. ✅ **付费曝光** → 只靠「商城」tab + 红点，**主页不放战令 banner**（克制路线）。

### 已拍板（续，2026-06-27）

4. ✅ **底部 tab 数量** → 维持 5 个（养成 / 商城 / 主页 / 生涯 / 社交）。
5. ✅ **高频领奖图标** → 主页**右侧竖栏**（每日 / 邮件 / 活动 / 成就）。
6. ✅ **离线 tab 策略** → 商城 / 社交 / 生涯 在离线时**整 tab 灰显**（不进入再引导）。
7. ✅ **「生涯」默认落地分区** → 进 tab 先看**天梯**。

至此 IA 方向全部拍板，进入实现分期（§8）。

---

## 7. 配套 bug（与本次重排一并处理，附录）

1. **大世界误判离线**：`WorldApiClient.checkHealth()`（`client/src/net/WorldApiClient.ts:84`）dev 下 ping `/health`，3 秒超时/CORS 即判离线，但实际功能路由 `/world /family /auction` 是通的 → 误报。修法：探针失败不直接判离线（放宽为「未知」不标红），或改探功能路由；生产同源已返回 true。
2. **限时活动灰态**：无活动时直接隐藏或显示倒计时，不常态灰一块。
3. ✅ **底部 tab 图标**：纯色圆点辨识度低，改文具/简笔图标贴合手绘笔记本风（`design/product/art-direction.md`）。已于 2026-06-28 实现（见 P3 实现记录）。

---

## 8. 实现分期

- **P0**（部分完成 2026-06-27）：
  - ✅ 大世界误判离线 —— `WorldApiClient.checkHealth()` 探针失败（CORS/超时/拒连）不再判离线。**2026-07-01 追加（红错根因 + 服务端修法）**：生产 `NW_WORLD_BASE=https://api.gamestao.com`，探针打 `api.gamestao.com/health`，但 `Caddyfile` **从未路由 `/health`**——请求落到兜底 `respond "Notebook Wars server" 200`（无 CORS 头、也不是真 worldsvc），浏览器**在 promise 结算前**打红「Cross-Origin Request Blocked」错误，try/catch 无法降级。**修法**：`Caddyfile` 新增 `handle /health { reverse_proxy worldsvc:18084 }`——worldsvc 的 `/health` 本就发 `access-control-allow-origin: *`（httpApi.ts `send` 助手），跨域读取被放行、红错消失，且探针能真正读到 worldsvc 的 5xx（保留 503→离线徽标）。客户端保持普通 `fetch` 读 `res.ok`，仅超时/拒连时 `console.warn`（不再判离线，也不打错误）。**部署**：需重启/重载 Caddy（server 重新部署）。
  - ✅ 限时活动灰态 —— 无 live 活动时**隐藏**该 chip，「每日」占满整行（不再常态灰一块）。
  - ⏭ 装备大厅入口 —— **不单独做**，归入 P1 的「养成」tab（避免临时入口被推翻）。
- ✅ **P1**（完成 2026-06-27）：底部 5 tab 重定义（养成/商城/主页/生涯/社交）+ 三个 tab 的功能归并：
  - 养成 = 收藏(CollectionScene) 扩容纳入 EquipmentScene（装备从战役上浮，保留战役准备页快捷入口）；
  - 商城 = ShopScene 扩容纳入 Gacha + BattlePass（红点提醒，不侵入主页）；
  - 生涯 = StatsScene 升级，纳入成就/天梯/称号/录像，**默认落地天梯**；
  - 离线时 商城/社交/生涯 整 tab **灰显**。

  **实现记录**（落代码细节，验收以此为准）：
  - **底部 5 tab** 改为固定顺序 **养成·商城·★主页·生涯·社交**（`LobbyScene.build()` 的 `slots[]`）。
    i18n 复用原 nav key，仅改文案：`lobby.nav.cards→养成` / `lobby.nav.shop→商城` / `lobby.nav.stats→生涯`；
    `stats.title→生涯`（en: Develop/Store/Career；de: Ausbau/Laden/Laufbahn）。
  - **离线灰显**：5 tab 始终全绘；离线时 商城/生涯/社交 三 slot 降透明度（dot 0.35 / label 0.4）且
    **不分配命中区**（点击纯 no-op，不再引导，§6 决策 6）。养成（收藏读本地档）与主页照常可用。
    `handleDown` 给 养成/生涯 命中加 `w>0` 兜底，防灰显态零矩形误命中。
  - **架构取舍**：「扩容纳入」按本仓「一场景一功能 + 导航核心」架构落在**导航层**——hub 场景新增入口，
    点击启动被并入的独立场景，其 `onBack` 路由回 hub（而非旧父级）。不把 875 行的
    EquipmentScene 等重写为内嵌 tab；视觉打磨留 P2/P3。
  - **养成**：`CollectionScene` 在原三 tab（卡牌/皮肤/单位）后加第 4 个「装备」launcher tab；
    新增回调 `onOpenEquipment?`，仅 `api && 登录` 时点亮（金边），否则灰显无命中。点击→
    `goEquipment(back=回收藏页)`。`goEquipment(back=goCampaignMap)` 参数化 back，
    **战役地图入口与战役准备页快捷入口保持不动**。
  - **商城**：`ShopScene` 页脚由 2 键（盲盒/充值）扩为 3 键（盲盒/**战令**/充值）；新增回调
    `openBattlePass?`，仅登录在线时出现，复用 `battlepass.openBattlePass` 文案。
    `goBattlePass(back)` 参数化，商城进入时 back=回商城。
  - **生涯**：`StatsScene` **移除战令入口行**（已移至商城），**新增「我的称号」入口行**
    （`onOpenTitles?`→`goTitles(goStats)`；`goTitles(back)` 参数化，设置页入口仍默认回设置）。
    成就（顶栏右上）/ 天梯榜（排位段「排行榜→」行，**首屏即天梯分区**，兑现「默认落地天梯」）/
    对战历史·录像 维持。
  - **生涯顶栏升级**（2026-06-27）：称号从 PvP 段文字链 **移至顶栏**，与成就并排展示（称号在左，成就在右）；成就按钮支持红点（有可领阶时亮）；**设置页移除称号入口**（`SettingsScene` 不再持有 `onOpenTitles`）；`goTitles` 默认 back 改为 `goStats`（原 `goSettings`，设置路径已废）。
  - **生涯页布局收敛 + 对战历史改版**（2026-07-03，`StatsScene`）：修「布局太散乱」——横屏改为**左侧资料栏（排位/战役/收集三块紧凑面板竖叠）+ 右侧对战历史专栏**，消除旧「战役面板下大片留白」。① 排位段新增「**我的排名**」行（`getMyRank?()` 拉天梯按 `publicId` 匹配位次，`#N`／未上榜；异步 resolve 后重绘），置于「排行榜→」行上方。② **对战历史不再用 label:value 列表**：每场画「**我 vs 对手**」行（交叉剑字形按胜负着色 + 右侧 胜/负 结果 chip 含带符 ELO 差），发丝分隔线，整行仍可点看录像；上限固定**最近 10 场**（`HISTORY_LIMIT`）；对手/自己名超长截断防撞。`playerName` 由 `createAppCore` 注入（缺则回退 `stats.you`=我）。新增 i18n `stats.myRank`/`stats.rankUnranked`/`stats.you`（zh/en/de）。
- ✅ **P1.5**（完成 2026-06-27）：被并入二级页的「分组 tab 重排」——把 P1 的「导航层挂入口、点了跳独立场景再 back」升级为**持久顶部分组 tab 条**，让同组场景互相直达、读起来像同一个 hub 的并列 tab。**仍不内嵌内容**（维持「一场景一功能」），只在导航层加共享 tab 条 + 跨页直达。

  **实现记录**（落代码细节，验收以此为准）：
  - **共享组件** `client/src/ui/widgets/HubTabs.ts`：`drawHubTabs(container,w,y,stripH,tabs,onSelect)` 画一行等宽分组 tab 条（视觉沿用 Collection 现有 tab：选中 dark/accent，未选 paper/line），返回未选中格命中 rect；`hubTabsHeight(h)=round(h*0.05)`。
  - **商城组** `[商城|盲盒|战令]`（战令格仅登录在线即 `openBattlePass` 可用时出现），三场景 header 下共绘同一条 strip：
    - `ShopScene`：footer 去掉盲盒/战令两键、只留充值（充值是商城自身动作）；新增 `drawGroupTabs`（商城 active）。
    - `GachaScene` / `BattlePassScene`：新增 `drawGroupTabs`（盲盒 / 战令 active），body 起点改 `tbH+stripH`。
    - 跨页 callback **全部可选**，仅分组语境注入：Gacha 加 `openShop?`/`openBattlePass?`；BattlePass 加 `openShop?`/`openGacha?`；strip 仅在 `openShop`（Gacha/BP）存在时绘制，独立入口退化纯 back。
  - **养成组** `[收藏|装备]`，两场景共用：
    - `CollectionScene`：把原 `drawTabs` 第 4 格「装备 launcher」拆出，上移为分组 strip（收藏 active，装备点 `onOpenEquipment`），内容 tab 行回归 3 格 `[卡牌|皮肤|单位]` 并整体下移一条 strip；仅 `onOpenEquipment` 存在（登录在线）时出现 strip，离线退化原 3-tab 布局。
    - `EquipmentScene`：新增可选 `openCollection?`；`groupH = openCollection ? hubTabsHeight(h) : 0`，header(`HUD_H`) 下画 strip（装备 active，点收藏回养成），body 基线 `HUD_H` → `HUD_H+groupH`（renderTabs/资源条/inventory loadout/craft listY）。
  - **导航编排** `createAppCore.ts`：商城组 `goShop/goGacha/goBattlePass` 改用 `group?:{shopBack?}` 串联——三页互相直达且返回同一来源（lobby / level-prep）；养成组 `goEquipment(back, inCollectionGroup)` 仅从收藏进入（`goCollection` 传 `true`）时注入 `openCollection`，战役入口不注入。大厅「商城」入口默认落地盲盒（`onOpenShop` 改为 `goGacha({})`），用户点商城 tab 再进 ShopScene。
  - **架构延续**：与 P1 一致——「扩容/重排」落在导航层，不重写 875 行 EquipmentScene 等为内嵌内容；视觉资产打磨仍留 P3。
  - **tab 图标化**（2026-07-03，去 emoji 图标化批③）：`HubTab` 增可选 `icon?: IconKind`，`drawHubTabs` 在标签左侧绘同色手绘字形（选中白 / 未选 mid），`[图标][gap][标签]` 整体居中；无 `icon` 时退化纯文字居中（向后兼容）。作为分组 tab 的标准约定推下所有场景：商城组 商城→`tag`／盲盒→`capsule`／战令→`trophy`／充值→`coin`；养成组 卡牌花名册→`cards`／收藏→`book`／装备→`armor`。`EquipmentScene.peerTab` 增 `icon?`，由 `createAppCore` 按来源注入（collection→`book` / roster→`cards`）。新增字形 `tag`/`capsule`/`cards` 于 `render/icons.ts`，其余复用既有。
- ✅ **P2**（完成 2026-06-28）：主页**右侧竖栏**图标条（每日/邮件/活动/成就）。
- ✅ **顶栏金币/排位直达**（2026-07-04）：大厅顶栏金币数字点击直达商城**充值**tab（`ShopScene` 新增可选 `initialTab?:'shop'|'coins'`，仅 `rechargeCoins` 可用时才真正落 coins tab，否则退化 shop tab；`goShop(onBack?, initialTab?)` 参数化）；排位徽章（如「青铜·988」）点击直达 `LeaderboardScene`（`goLeaderboard(onBack?)` 参数化，默认回生涯页不变，大厅入口回大厅）。两个热区仅登录在线时命中（`LobbySceneCallbacks.onOpenRecharge?`/`onOpenLeaderboard?`），离线态两项本就是纯文字无回调，无需额外判断。

  **实现记录**（落代码细节，验收以此为准）：
  - **删除水平 engagement chip 行**：P3 右对齐每日/活动两个横向 chip 整行移除。
  - **右侧竖栏** `sideItemSz = h*0.082`（方形）竖排：
    每日（`dailyBtnRect`）/ 邮件（`mailStripRect`，`onOpenMail`→`goMail()`）/
    活动（`eventsBtnRect`，仅 `eventsAvailable` 时出现）/ 成就（`achieveStripRect`，仅 `onOpenAchievements` wired 时出现）。
  - **contentW 收窄**：`fullContentW(w*0.82) - sideItemSz - sideGap(w*0.018)`，左 margin 不变；竖栏 X = 收窄后内容右边 + sideGap，竖向居中于 hero+pillars 区。
  - **`sideStripBadgeLayer`**：廉价重绘红点（retentionBadge→每日，socialBadge→邮件，achievementBadge→成就）；`applyRetentionBadge` 不再 `rebuild()`，改调 `drawSideStripBadges()`。
  - **邮件直达**：`FriendsSceneCallbacks.defaultTab?: 'friends'|'mail'`；`goMail()` → `goFriends({defaultTab:'mail'})`；大厅 `onOpenMail` 仅 online 注入。
  - **i18n**：新增 `lobby.strip.events/achieve/mail`（zh/en/de）。
- ✅ **P3**（完成 2026-06-28）：视觉打磨三项：
  1. **底部 tab 图标化 + 加高**：高度 `h*0.08` → `h*0.105`，彩色圆点换手绘图标
     （养成=book / 商城=coin / 主页=home / 生涯=trophy / 社交=globe，复用 `icons.ts` 已有字形）；
     图标居上、文字居下标准排布。
  2. **每日按钮右对齐**：从全宽居中改为右对齐 44% 宽度，主页左侧留白更舒适；
     限时活动有效时依然各占约一半（`dailyX = contentX + contentW - cw`）。
  3. **头像选择器**：详见 `design/game/UI_DESIGN.md §头像系统`。

---

## 8. 养成组（卡背包/装备）改左侧竖排导航（2026-07-05）

> 状态：**已实现**。范围只覆盖 `CardScene`/`EquipmentScene` 这一组；商城组 `[商城|盲盒|战令]` 等其余分组仍用 §7/P1.5 的水平 `drawHubTabs` 条，不受影响。

### 8.1 起因

真人用红笔在两屏截图上批注「布局完全错误」，来回三轮拖拽定稿 + 代码走查后，定位到两类问题：

1. **真 bug**：`EquipmentScene.renderGroupTabs()` 把 `drawHubTabs` 的宽度参数传成了 `leftW`（`marginLineX(w)`，约等于屏宽 9%），而不是 `CardScene` 那样传 `this.w`（全屏宽）。组合 tab 因此被塞进红色装订线以左那条 9% 宽的窄缝里，挤成一小块——纯粹传错变量，不是"设计成这样"。
2. **设计问题**：即便修好 bug 让组合 tab 恢复满宽，`EquipmentScene` 头部同时还有「背包/锻造」二级切换（`equip.tabInv`/`equip.tabCraft`）挤在同一条窄左列里，两条窄 tab 条叠在一起，读起来仍然乱。

### 8.2 拍板方案

把 `[卡背包|装备]` 分组 tab（原水平满宽条）和 `[背包|锻造]` 二级 tab（原头部左列横条）都改成**贴在红色装订线以内、竖直堆叠的侧栏**：

```
┌──┬──────────────────────────────┐
│卡 │                              │
│背 │        （容量条 + 卡片网格）   │  CardScene
│包 │                              │
├──┤                              │
│装 │                              │
│备 │                              │
└──┴──────────────────────────────┘

┌──┬──────────────────────────────┐
│卡 │           货币/材料+计数 →    │
│背 ├──────────────────────────────┤
│包 │  全部/武器/护具/饰品(占满宽)   │
├──┤ ─ 已装备 ──────────────────── │  EquipmentScene
│装 │  [格][格][格]                │
│备 │ ─ 背包 ──────────────────────│
├──┤  [格][格][格][格]             │
│背 │                              │
│包 │                              │
├──┤                              │
│锻 │                              │
│造 │                              │
└──┴──────────────────────────────┘
```

- 侧栏宽度 = `marginLineX(w)`（既有的红色笔记本装订线位置），**不新增留白**——内容区左边界完全没变，卡片网格/装备网格/货币栏/过滤条一律照旧从 `marginLineX(w)+CELL_GAP` 或 `marginLineX(w)` 起算。
- `[卡背包|装备]` 一级项目在上（仅分组语境注入，即 `openEquipmentBag`/`peerTab` 存在时才画）；`EquipmentScene` 独有的 `[背包|锻造]` 二级项目紧跟其后堆叠在同一侧栏里（不论是否分组语境都画，因为这是场景自身的 tab，不是跨场景导航）。
- 顶部标题栏（`SceneHeader`：返回 + 「卡背包」/「装备」标题）维持不动，侧栏只占标题栏以下的左侧区域。标题文字和侧栏一级项目文字重复（都叫「卡背包」/「装备」）这件事本轮**没有处理**，留作后续小项。
- 货币栏本轮定稿仍在右上角（不挪到左侧），过滤条撑满内容区全宽（侧栏右边界到屏幕右边）。
- 「已装备/背包」维持原样，是**列表内滚动的分区标题**，不进侧栏——曾在拖拽稿里试过挪进侧栏，用户确认不改。

### 8.3 实现记录

- **`client/src/ui/widgets/HubTabs.ts`** 新增 `sidebarItemHeight(h) = round(h*0.09)` 和 `drawSidebarTabs(container, sidebarW, y, h, tabs, onSelect)`：在给定 x=0 起、宽 `sidebarW` 的竖直列里，从 `y` 起把 `tabs` 逐个堆叠（每格 `sidebarItemHeight(h)` 高，格间距 `h*0.015`），图标居上/文字居下（沿用底部大厅 tab 的排布习惯）。返回未选中格的命中矩形 + 最后一格底部 y（供调用方在同一列继续往下堆内容）。原有 `drawHubTabs`/`hubTabsHeight`（水平满宽条）不变，继续给商城组等用。
- **`CardScene.ts`**：`groupH: number` 改名 `showSidebar: boolean`；`renderGroupTabs()` 改名 `renderSidebar()`，改调 `drawSidebarTabs`；`renderCapacityBar()`/`renderList()` 的纵向偏移去掉 `groupH` 加项（侧栏不再占垂直空间），`renderCapacityBar()` 的背景条改从 `sidebarW` 画到 `w`（避免盖住侧栏）。
- **`EquipmentScene.ts`**：`groupH: number` 改名 `showGroup: boolean`；原 `renderGroupTabs(leftW)`（那个传错宽度的 bug 现场）删除，改为 `renderSidebar()`——先画分组一级项（仅 `showGroup` 时），再紧接着画 `[背包|锻造]` 二级项（恒画）；`renderHeaderRow()` 不再画头部左列的二级 tab，只保留右列货币块+过滤条，纵向偏移同样去掉 `groupH` 加项；`renderAssign()`/`renderAssignRow()`（装备指派卡片选择器）原先按 `HUD_H+groupH` 起算、且横向占满整个 `w`，现改为横向也让出 `marginLineX(w)` 侧栏列（否则会被侧栏盖住）。
- 已用 `tsc --noEmit -p tsconfig.test.json` + `webpack --mode production --env TARGET=web` 验证通过；未跑游戏截图（按仓库约定，视觉验收留给人工）。
