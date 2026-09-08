# 应用商店素材 + 分级 + 健康忠告清单（四渠道）

> 创建：2026-06-23。Track 3 L3-3 产出。
> **本文是上架素材的单一清单**：逐项列出每个发布渠道所需的图标、截图、描述、分级问卷答案、隐私标签、健康忠告文案。
> ⚠️ 隐私标签/数据安全表的答案必须与 [`privacy-policy.zh.md §2`](../legal/privacy-policy.zh.md) 及 [`COMPLIANCE_GLOBAL.md §3.2`](../../game/COMPLIANCE_GLOBAL.md) 的数据清单**逐项一致**（三处口径不得打架）。
> 美术素材未就位的标 **「待美术」**；文案三语随附。
> 对外产品名：**Nivara**（开发代号 Notebook Wars）。⚠️ **商店标题**统一用 `Nivara: Notebook Wars`——纯 `Nivara` 已被他人在 App Store Connect 占用（名称全局唯一），iOS 起冲突；为跨渠道一致，四渠道商店标题都带副标题，游戏内 logo/品牌仍为 Nivara。

---

## 0. 通用素材池（各渠道复用）

### 0.1 产品文案（三语）

| 字段 | 中文 | English | Deutsch |
|---|---|---|---|
| 名称 | Nivara: Notebook Wars | Nivara: Notebook Wars | Nivara: Notebook Wars |
| 副标题/一句话 | 笔记本里的实时塔防对战 | Real-time tower defense | Tower Defense im Notizbuch |
| 简短描述 | 在手绘笔记本世界里实时排兵布阵，东西两本笔记的策略对决。战役 PvE + 实时联机 PvP + 大世界 SLG。 | Command armies in real time in a hand-drawn notebook world — an East-meets-West strategy duel. Campaign PvE + real-time PvP + open-world SLG. | Befehlige Armeen in Echtzeit in einer handgezeichneten Notizbuchwelt — ein Strategieduell zwischen Ost und West. Kampagne-PvE + Echtzeit-PvP + Open-World-SLG. |

> ⚠️ **类型口径（2026-09-08 修正，四渠道通用）：本作是实时车道推进（塔防式）对战，不是回合制。**
> 2026-06 起本节到 §0.1b 的三语文案通篇写着「回合制策略 / turn-based strategy / rundenbasiert」，
> 与代码和画面都不符：`server/engine/src/math/fixed.ts` 的 `TICK_RATE = 30`（30 Hz 定点 lockstep 模拟）、
> `CAMPAIGN_DESIGN.md §开头`「在现有**车道推进引擎**之上」、`i18n` 三语的 `lobby.subtitle` 都是「实时塔防」，
> 而 `art/store/en/battle__*.png` 每一张上都有 `0:30` 倒计时、自动回复的金币读数和 6 张带费用的手牌。
> 描述与截图互相打架正是 App Store 2.3.1（metadata 与实际不符）的正面撞法，而四个渠道共用同一份文案，
> 所以这是一处改一次、四处受益的修正。已改：本表副标题/简短描述、§0.1b 三语长描述、§0.2 关键词，
> 以及仓库内同源的错误说法（`client/public/web/home.html` 的 title/description/hero/PvP 卡片、`README.md` 首行）。
> **PvP 那一句尤其别写成「实时回合制」**——旧稿的 `real-time turn-based PvP` 是两个类型硬拼在一起，
> 它真正想说的是「同步的是操作而非结果」（lockstep），照那样写反而把矛盾搬进了同一个短语里。

> 长描述（每渠道字数上限不同）以简短描述为基底扩写，强调：手绘笔记本美术、实时车道对战的决策密度、战役剧情（涛 vs Anna 东西碰撞）、联机对战、养成（不破坏 PvP 公平）。**避免**「赌博/博彩」类措辞（盲盒措辞统一为「付费随机道具」并指向概率公示）。

### 0.1b 长描述（三语，2026-09-04 拟；App Store / Play 直接复制）

> 写作口径：**功能陈述，不吹**。Apple 审核对"最好/第一/免费"一类措辞和与实际功能不符的描述会退回；
> 抽卡一律写作「付费随机道具」并点明概率公示，绝不出现赌博/博彩类词汇（各渠道口径统一，见 §5）。
> 长度控制在 ~800 字符以内：Play 上限 4000、App Store 4000，但商店只展示前三行，长了没人读。

**中文**

```
一本笔记本，两种画法，一场持续到最后一页的战争。

Nivara 是一款画在方格纸上的实时策略对战游戏。金币自己回、手牌不断轮换、两座城堡始终在射程之内——
你决定这一枚金币花在哪条车道、什么时候推、什么时候守。

· 战役：跟随涛与 Anna 的东西方笔记之争，逐章推进，剧情与关卡交替
· 联机对战：实时 PvP，同步的是操作而非结果，双方看到的是同一场仗
· 大世界：占地、行军、结盟，与其他玩家共享一张会变化的地图
· 养成：卡牌、皮肤、装备可收集；战力成长不改变 PvP 的对局规则

内含付费随机道具，抽取概率在游戏内「概率」页公示。可完全免费游玩。
```

**English**

```
One notebook, two ways of drawing, and a war that runs to the last page.

Nivara is a real-time strategy game drawn on graph paper. Gold refills on its own, your hand
cycles, and both castles are always in reach — you decide what to spend, which lane to push, and
when to hold.

· Campaign — follow Tao and Anna's duel of East and West notebooks, chapter by chapter
· Multiplayer — real-time PvP that syncs inputs, not outcomes: both sides see one battle
· Open world — claim ground, march, form alliances on a shared map that keeps changing
· Collection — cards, skins and gear to collect; progression never changes the rules of a PvP match

Contains paid random items; the draw rates are published in-game on the odds page. Free to play.
```

**Deutsch**

```
Ein Notizbuch, zwei Zeichenstile, ein Krieg bis zur letzten Seite.

Nivara ist ein Echtzeit-Strategiespiel auf kariertem Papier. Gold füllt sich von selbst nach,
deine Handkarten rotieren, und beide Burgen sind immer in Reichweite — du entscheidest, wofür du
ausgibst, welche Bahn du drückst und wann du hältst.

· Kampagne — das Duell zwischen Taos und Annas Notizbüchern, Kapitel für Kapitel
· Mehrspieler — Echtzeit-PvP: synchronisiert werden Eingaben, nicht Ergebnisse
· Open World — Gebiete einnehmen, marschieren, Bündnisse schließen auf einer gemeinsamen Karte
· Sammeln — Karten, Skins und Ausrüstung; Fortschritt ändert nie die Regeln eines PvP-Matches

Enthält kostenpflichtige Zufallsgegenstände; die Wahrscheinlichkeiten stehen im Spiel auf der
Quoten-Seite. Kostenlos spielbar.
```

### 0.2 关键词 / 标签（待各渠道适配）
策略, 塔防, 实时对战, 联机对战, 笔记本, 手绘 / strategy, tower defense, real-time, multiplayer, notebook, hand-drawn, tactics / Strategie, Tower Defense, Echtzeit, Mehrspieler, Notizbuch, Taktik

**App Store 关键词字段（≤100 字符，逗号分隔、不带空格；2026-09-08 拟）**——刻意不重复 App 名与副标题里已被索引的词
（`Nivara` / `Notebook` / `Wars` / `Real-time` / `tower defense` 已在 §0.1 那两个字段里）：

```
tactics,pvp,multiplayer,card battle,lane,army,castle,sketch,doodle,paper,rts
```

76 字符。Play / 微信 / CrazyGames 的标签字段各有自己的形态与上限，按上面那行中/英/德词表现取现填。

### 0.3 数据收集口径（隐私标签/数据安全表统一来源）
以 [`privacy-policy §2`](../legal/privacy-policy.zh.md) 为准，简表：

| 数据 | 是否收集 | 关联身份 | 是否用于跟踪 | 用途 |
|---|---|---|---|---|
| 设备 ID（deviceId） | 是 | 是 | 否 | 账号/防作弊 |
| 邮箱/登录 ID | 可选 | 是 | 否 | 账号/云存档 |
| 昵称 | 可选 | 是 | 否 | 社交展示 |
| 购买记录 | 是（充值时） | 是 | 否 | 内购履约 |
| 行为埋点 | 是（EU/UK 需同意） | 假名化 | 否 | 运营分析 |
| 私聊/通信 | 是（用社交时） | 是 | 否 | 通讯/治理 |
| 精确位置/通讯录/相机/麦克风 | **否** | — | — | — |
| 跨 App 广告跟踪标识 | **否**（不做 ATT 跟踪） | — | — | — |

### 0.4 游戏截图采集管线（2026-08-18 打通）

截图**不靠手机录屏**——客户端本身是响应式的，把浏览器视口设成商店要求的**确切像素**再渲染真实游戏，出来就是原生像素（不放大），还能覆盖没有实体设备的 iPad 12.9"。

- 脚本：[`art/scripts/capture-store-screenshots.mjs`](../../../art/scripts/capture-store-screenshots.mjs)（Playwright 驱动 `TARGET=web-e2e` 的 `window.__nwE2E`，脚本头部写了完整前置条件）+ [`art/scripts/seed-screenshot-account.cjs`](../../../art/scripts/seed-screenshot-account.cjs)（给账号灌进度/皮肤/段位，让画面不是空存档）。
- 后端：本地一套即可，**不需要 Docker**——`mongod --replSet rs0`（worldsvc 要事务，单节点副本集就够）+ metaserver + commercial + worldsvc，Redis 可缺省。
- 金币走 dev IAP 桩（`shopCb.recharge()`）真实发放，不手改存档（metaserver 会按 commercial 账本对账，手改的余额下次登录即被清零）。
- **图标 / 横幅（2026-08-18 同批打通，都不需要 AI 出图）**：
  - [`art/scripts/make-store-icons.mjs`](../../../art/scripts/make-store-icons.mjs) 从现有 `art/logo/logo-simple.png`（扁平简版，当年就是为小尺寸做的）派生 iOS 1024 + Play 512。**选简版不是随手**：把手绘版 `logo.png` 和简版一起缩到 60/120px 并排比过——手绘版的细墨线 + 横格纸纹在 60px 全塌，简版三支笔交叉仍清晰。深蓝底板 `#2E4055` + 压平去 alpha + 不带圆角（Apple 硬性要求，圆角由系统裁）。
  - [`art/scripts/render-store-banners.mjs`](../../../art/scripts/render-store-banners.mjs) 出 Play 特征图 1024×500 + 微信分享图 500×400。**在浏览器里用 HTML/CSS 渲染再截图**，因为这两个是唯一带文字的素材，而游戏 UI 本身就是 `monospace` + 纸面 + 横格/红边距（`sketchUi.ts`）——同一媒介出图才不会"外面做的图跟游戏不像一家"。刻意不用游戏截图：Play 官方口径是特征图放 logo + 极简文字（会被裁切并叠平台 UI），游戏画面的活由截图承担。
  - CrazyGames 横版缩略图直接取截图管线的 `battle__landscape_16x9`（那个位就是"游戏画面"位）。
- 首批产物（英文一套，2026-08-18）：`art/store/en/<场景>__<设备>.png`，7 个场景 × 5 尺寸 = 35 张 —— 场景 lobby / campaign（关卡选择）/ prep（出战准备）/ battle / gacha / shop / world；尺寸 1290×2796、1242×2688、2048×2732、1080×1920、**1280×720 横版**（后者供 CrazyGames，顺带实拍核对横屏布局分支）。首轮拍完发现的三处真 UI bug 已修（§0.5），当前 28 张是修复后重拍的版本。

### 0.5 首批截图暴露的问题（已全部处理，2026-08-18）

| 现象 | 结论 | 处置 |
|---|---|---|
| 大世界地图在 1290×2796 下只铺出屏幕中央一条窄竖带，四周留白 | **不是布局 bug，是采集脚本抢拍**：世界地图进场有一层"橡皮擦擦除"揭示动画（`WorldMapRenderer/loadingReveal.ts`），首轮只等了 6s，`loadingEraseT` 才 0.62——拍到的是半擦开的纸。等到 `=1`（t+26s）地图完整铺满视口 | 脚本 world 场景等待 6s → **18s**，并在注释里写明这个坑；无代码改动 |
| 大世界头部：返回键被 Home/Shop/Auction 压住，资源读数横跨按钮并冲出右边界 | **真 bug**（竖屏 `designWidth` 钉 1080、按钮尺寸却跟拉长的高度轴走） | 已修，见 [`UI_DESIGN_LOG_2026-08.md` §35①](../../game/UI_DESIGN_LOG_2026-08.md)：竖屏资源读数移到头部下方独立带子、三按钮改正方形图标键 |
| 兵力卡 `10000/10000` 压在右栏 Territory 上；栏间分隔线根本没画在卡里 | **真 bug**（两处，同一段代码） | 已修，§35② |
| 大厅 START MATCH 副标题 `Ranked · 5-10 min per game` 左右出血被裁 | **真 bug**（字号跟高度轴长、字符串定长） | 已修，§35③ |
| 战斗截图场上只有 4–6 个单位，读起来像空棋盘 | 采集问题 | 脚本改为等 AI 起势后**用真实指针拖拽出牌**（`GameSceneCallbacks` 没有出牌回调，只能拖 canvas），现在一屏约 20 个单位 + 己方英雄 |

三处代码修复由 `client/test/ui/worldMapPortraitHeaderFit.ui.ts`（9 例）护住；`art/store/en/` 的 28 张是修复后重拍的版本。

### 0.6 iPad 留白 → 做成"纸页摊在桌面上"（已实现，2026-08-18）

**量出来的留白**（实测 `art/store/en/*__ipad_12.9.png` 加公式复核，见 [`PortraitLayout.ts:84`](../../../client/src/layout/PortraitLayout.ts:84)）：只在**左右**，上下恒为 0（高度一格不浪费）。之所以第一眼像四边都有，是留白色正好是 App 自己的纸白 `#F5F0E8`。

| 机型 | 面板 | 内容 | 每侧留白 | 死像素占比 |
|---|---|---|---|---|
| iPad Pro 12.9" | 2048×2732 | 1537×2732 | 256px | **25.0%** |
| iPad 10.2" | 1620×2160 | 1215×2160 | 203px | **25.0%** |
| iPad Pro 11" | 1668×2388 | 1343×2388 | 163px | 19.5% |
| iPad Air 10.9" | 1640×2360 | 1328×2360 | 156px | 19.0% |
| iPad mini | 1488×2266 | 1275×2266 | 107px | 14.3% |
| 任何 iPhone | — | 满幅 | 0 | 0% |

4:3 的两款最惨，越方越惨；iPhone 全 0（2026-07-21 动态设计高那次修掉的）。

**方案对比与拍板**：

| 方案 | 代价 | 结论 |
|---|---|---|
| A 照现状 | 0 | 不破裂但观感像未适配 |
| **B 把留白做成桌面**（已采用） | 1 文件 + 1 测试，**设计矩形内零改动** | ✅ 实现见下 |
| C 竖屏设计宽跟着方屏拉伸（镜像 `LandscapeLayout`） | 场景里 **281 处 `w * 0.x`** 全部变成疑点（正是已咬过两次的 bug 类：Develop 侧栏 `w*0.2`、§34 榜单列宽），另有 52 个测试文件写死 1080 | 留待 iPad 真占可观装机比例再评估 |
| C′ 直接降 1920 下限 | **算术上不通**：70(顶 HUD) + 1512(18 行 × 84) + 70 + 268(手牌) = 正好 1920，再低棋盘就压进手牌，必须让格子尺寸动态化 → 动到 grid↔screen 输入映射 + 一批战斗测试 | 否 |
| D 放弃 iPad（`TARGETED_DEVICE_FAMILY` 改 `"1"`） | 小 | 否——iPad 用户改跑 iPhone 兼容模式，留白**比现在更大** |

**B 的实现**：`ScalingManager` 新增 `deskLayer`（屏幕空间 `PIXI.Graphics`，位于最底层），把留白带画成"书页摊在桌面上"——kraft 色桌面 + 极淡斜纹 + 页边软阴影 + 一道墨线页缘（`drawDeskSurround()`，纯函数、已导出供测试）。必须是屏幕空间：它要框住 `gameLayer` **缩放后**的矩形，而 `bgLayer` 是 Cover、`gameLayer` 是 Contain，两者比例在有留白时天然不同，任何设计空间图层都对不齐。手机（`pageX < 2`）一个图元都不画、`visible=false`，常见路径零开销。这就是游戏自己的 diegetic 框架（`art-direction.md §〇`：整个游戏发生在这本笔记本上）。

回归测试 [`client/test/ui/deskSurround.ui.ts`](../../../client/test/ui/deskSurround.ui.ts)（5 例）：iPad 画且带只在左右、手机一个图元都不画、桌面覆盖整块面板不留未涂像素、重绘不累积图元、从 iPad 缩放回手机会清空而不是留在屏上。`art/store/en/*__ipad_12.9.png` 已重拍。

---

## 1. Apple App Store（iOS）

### 1.1 图标 / 截图规格
| 素材 | 规格 | 状态 |
|---|---|---|
| App 图标 | 1024×1024 PNG（无圆角、无 alpha） | ✅ `art/store/icons/ios_appicon_1024.png`（3 通道无 alpha，见 §0.4） |
| iPhone **6.9"** 槽位 | 1320×2868 **或 1290×2796**，最少 3 张、最多 10 张 | ✅ `art/store/en/*__iphone_6.7.png` = 1290×2796（7 场景）；**文件名里的 6.7 是拍图当时的槽位名** |
| iPhone **6.5"** 槽位 | 1242×2688 或 1284×2778 | ✅ `art/store/en/*__iphone_6.5.png` = 1242×2688 |
| iPad **13"** 槽位 | 2064×2752 或 **2048×2732** | ✅ `art/store/en/*__ipad_12.9.png` = 2048×2732（通用 App 必需，`TARGETED_DEVICE_FAMILY = "1,2"`） |
| Apple Watch | — | 无 watch app，槽位留空 |
| App 预览视频（可选） | 各设备分辨率，15–30s | 待美术（可选） |

> ⚠️ **文件名 ≠ 槽位名，这是 2026-09-08 实际上传时踩到的**：`__iphone_6.7.png` 那一组是 1290×2796，
> 属于现在叫 **6.9"** 的槽位；把它拖进 6.5" 框会被 ASC 直接拒（那个框只收 1242×2688 / 1284×2778）。
> 拒绝理由只说尺寸不符，不会告诉你「你拖错格子了」，很容易误判成「当初拍的图尺寸不对」。
> **实测复核过的三件事**（`art/store/en/` 全 35 张）：像素尺寸逐张精确、PNG `colortype 2`（RGB，**无 alpha**）、
> 无圆角无设备边框——ASC 最常见的三类拒绝理由都不成立。
>
> **Apple 现在只强制 iPhone 6.9" + iPad 13" 两组**，更小的 iPhone 尺寸留空即由 6.9" 自动缩放。
> 6.5" 那一组我们有现成文件，填不填都行；省事就只填两个必需槽位。
>
> **建议顺序**（商店搜索结果只露前 3 张）：`battle` → `campaign` → `world` → `prep` → `gacha` → `lobby`。
> `shop` 不上——纯付费界面占一个截图位不划算。

### 1.2 元数据
- 名称（≤30 字符）、副标题（≤30）、描述、关键词（≤100 字符逗号分隔）、推广文本——三语（见 §0.1）。
- 隐私政策 URL：`https://nivara.gamestao.com/privacy`（必填；`/privacy.html` 会 307 到无后缀形式，填无后缀的）。
- **支持 URL（必填）**：`https://nivara.gamestao.com/support` — `client/public/web/support.html`（2026-09-08 新建）。
- **营销 URL（可选，建议填）**：`https://nivara.gamestao.com/about` — `client/public/web/about.html`（2026-09-08 新建）。

> **这两页为什么是新建的，而不是复用 `home.html`**：`home.html` 是给 Paddle 审核看的落地页，
> 它**明码标价 USD 币包并直链 `/pricing` → Paddle 收银台**。而支持/营销 URL 是 Apple 会去抓的 metadata，
> 3.1.1 管到 metadata（同 §1.3 里 Age Suitability URL 不能填 `/home` `/pricing` 的那条），所以把 Apple
> 指向 `home.html` 等于把「原生包里清干净的网页支付通道」从 metadata 这扇门又请回来一次
> （原生包那轮清理见 [`IOS_RELEASE.md §10`](../../game/IOS_RELEASE.md)）。
> 在此之前唯一能填的候选是 `privacy.html`（它底部恰好有一个 `mailto:`）——用隐私政策充当支持页。
>
> 两页刻意**不链任何购买面**：无 `/pricing`、无 `/pay`、无 `/home`。
> `about.html` 连「在浏览器里玩」这个链接都没有——这是其中唯一不显然的一条：网页版自己的 Store 页
> 是走 Paddle 卖币的，所以一个 Play 按钮就是「Apple 读的 metadata → 两跳到站外支付」。
> 描述游戏、并如实披露「含付费随机道具、概率游戏内公示」不是购买号召；递给读者一扇通往网页收银台的门才是。
> `support.html` 唯一保留的商业相邻链接是 `/refunds`——「怎么退款」是真实支持问题，而那一页开头第一句
> 就是「App Store 买的找 Apple 退」，它是政策不是收银台。
>
> ⚠️ **核对这两个 URL 上线，必须看 `<title>`，不能看状态码。** `wrangler/client.jsonc` 里
> `not_found_handling: "single-page-application"`——任何不存在的路径都回 **200 + `index.html`**（游戏本体），
> 不会 404。也就是说 URL 拼错、或部署压根没跑，`curl -o /dev/null -w %{http_code}` 照样给 200，
> 而审核员点进去看到的是一块游戏画布而不是支持页面。判据：
> `curl -sS https://nivara.gamestao.com/support | grep -o "<title>[^<]*"` 要是 `Support — Nivara`
> （`/about` 是 `About Nivara — Notebook Wars`）；读到 `Nivara — Notebook Wars` 就是 SPA 兜底，没上线。

> 门禁：`client/test/nativePaymentIsolation.test.ts` 新增一例，**读这两个 HTML 的文本**逐个 `href` 断言
> 不含 `/pricing` `/pay` `/home` `paddle.com`——真正的风险是几个月后有人顺手加一个 `<a>`，
> 而那个人不会读到这段话。两页同时也不进 mobile/crazygames 产物（同一 CopyPlugin 分组，理由不同：
> 它们只是网站页，游戏里没有任何入口指向它们）。

### 1.2b 「1.0 Prepare for Submission」逐字段照抄（2026-09-08 整理）

版本页（App Store → iOS App → 1.0 Prepare for Submission）上的每一格。文案三语见 §0.1 / §0.1b。

| 字段 | 填什么 |
|---|---|
| App Previews and Screenshots | 见 §1.1（**iPhone 6.9" 槽位放 `__iphone_6.7.png` 那组**；iPad 13" 放 `__ipad_12.9.png`；Apple Watch 留空） |
| Promotional Text（≤170，改它不用重审） | `Gold refills, your hand cycles, both castles are in reach. Campaign, real-time PvP and a shared world map. Free to play.` |
| Description（≤4000） | §0.1b 三语长描述，逐语言复制 |
| Keywords（≤100） | §0.2 那一行 76 字符的串 |
| Support URL（必填） | `https://nivara.gamestao.com/support` |
| Marketing URL（可选） | `https://nivara.gamestao.com/about` |
| Version | `1.0`（与 `client/ios/App/App.xcodeproj/project.pbxproj` 的 `MARKETING_VERSION = 1.0` 一致） |
| Copyright | `2026 Tao Wang`（运营主体见 `terms.html §1`：德国个体经营，非公司） |
| Routing App Coverage File | 留空（不是导航类 App） |
| Build | 选 **CFBundleVersion = 7** 那个（2026-09-08，run `34201608554`，head `e2e307e45`，36.5 MB）——**唯一带 StoreKit 2 的包**；CFBundleVersion=4 的两个是 B 批之前的代码 |
| Export Compliance | **不会问**：`client/ios/App/App/Info.plist` 已有 `ITSAppUsesNonExemptEncryption = false` |
| Version Release | Manually release this version（自己控制放出时机） |

#### 审核账号：**必须给，`Sign-in required` 要勾「是」**

**首启不是匿名进游戏，是登录页。** `client/src/app/nav/auth.ts` 的 `resolveEntry()`：
只有 `cred.kind === 'wx'`（微信）才走 `saveManager.bootstrap()`（那条路才用 `/auth/device`）自动进大厅；
iOS/web 拿不到 token 就 `goLogin()`，落在 `LoginScene` 的三个按钮上——**Log in / Sign up / Play offline**。
`auth.offlineHint` 写得很明白：`Offline: campaign & vs-AI only. Log in for online / shop.`
也就是说不给账号的审核员只能玩离线战役，**买不了内购、打不了 PvP、进不了大世界和社交**——
`3.1.1` 要求审核员能实测内购，这一条会直接撞上 2.1。

> ⚠️ 这条曾被误判过一次（2026-09-08 会话里先答成「Sign-in required: No，匿名设备登录」）。
> 误判的来源是 `IOS_RELEASE.md §9` 那句「匿名设备登录（`getAuthCredential` device）」——它**是真的**，
> 但那是 gateway/NetSession 用的设备凭据，不是账号入口；账号入口是 loginId + password
> （`server/metaserver/src/accounts/password.ts`）。**「有匿名凭据」和「首启能匿名进游戏」是两件事。**

**✅ 2026-09-08 已在生产建好并灌完。**

| 项 | 值 |
|---|---|
| loginId | `appstore.review@gamestao.com` |
| 密码 | **不写进仓库**——见本节末尾 |
| displayName | `AppReview` |
| accountId | `f100cdee-6663-4d41-8f58-94737ae7a920` |
| publicId | `104496720` |
| 环境 | 生产 `api.gamestao.com`（iOS 包烘的就是它）；走公开 `POST /api/auth/register` 注册，所以口令散列、`publicId`、starter 发卡全是正常路径产出的，没有手捏文档 |

灌了什么，以及**故意没灌**什么：

| 项 | 结果 |
|---|---|
| **通关第一章** | ✅ `save.progress.cleared` = `ch1_lv1..ch1_lv10`，`stars` 各 3 星。这是大世界的软门（`isFirstChapterCleared`，`client/src/game/campaign/progress.ts`；`LobbyScene/core.ts:215`、`mainContent.ts:169` 未过则 WORLD 入口置灰、提示 `lobby.world.locked`）——不灌的话审核员看不到长描述里承诺的「大世界」这一整块。写法是 `saves` 集合上一次 rev 守护的 `findOneAndUpdate`（`PUT /save` 那个通用回写端点早就删了，客户端只 GET，不会把旧存档推回来覆盖） |
| 英雄卡 | ✅ 3 张（`lichuang` / `chenshou` / `suyuan`），**注册时 `maybeGrantStarterCards` 自动给的，没有额外灌**——这就是新玩家的正常状态，审核员看到的和真实用户一样 |
| **PvP 卡组不用灌**（原先这张表写了「灌卡」，是误判） | `PVP_BASE_CARDS` 那 10 张（`client/src/game/meta/pvpLoadout.ts`）对所有人无条件开放，而 `PVP_DECK_SIZE` 正好 = 10，`PVP_UNLOCK_TIERS` 的门槛从 elo **1500** 才开始——新号 elo 1000 的卡组自动填满且合法。**战斗卡和 `cardInv` 里的英雄卡是两套东西**，前者不受收集进度影响 |
| **金币：故意 0** | 沙盒 Apple ID 走 StoreKit 沙盒真买即可，服务端照常验单发币；手改余额下次登录会被 metaserver 按 commercial 账本对账清零（同 §0.4 截图账号那条）。审核员买一笔正好也是 3.1.1 要的那次实测 |
| 体力 | 120（注册默认），够跑战役 |

**复核方式**（不碰数据库，走玩家路径）：`POST /api/auth/login` 拿 token → `GET /api/save`，
确认 `rev=3`、`progress.cleared` 十个齐、`wallet.coins=0`。

**密码要故意选得好打，不要选强。** 第一版我生成的是 `Review-` + 12 位混合随机串，被用户当场否掉——
**审核员是在 iPhone 软键盘上手输这个口令的**，大小写混排 + 连字符意味着一路切 shift 和数字面板，
输错一次就是一次「登录失败」的坏印象，而这个账号里**没有任何值得保护的东西**（0 金币、3 张新手卡、
没有真人数据）。行业惯例就是短、全小写、加两位数字。现用口令 14 字符、纯小写字母 + 末尾两位数字，
整段只需切一次数字面板；`MIN_PASSWORD_LEN` 是 6，所以还有很大余量。

抵御暴力猜测靠的不是口令强度，而是另外两件事：服务端的 `allowAuthAttempt` 认证限流（`429 RATE_LIMITED`），
以及**过审后轮换或停用这个账号**（loginId 在 ASC 里对 Apple 可见，别让它长期挂着一个弱口令）。

**存放**：只在会话里交给用户，**不进 git**。要长期存就放加密凭证库
（`D:\secrets`，`github.com/bigtaoo/secrets`，`sops`+`age`，见记忆 `credential-store-sops-age-2026-09-05`），
别写进本文件或任何 `.env`。要改口令：`POST /auth/password/change` 需要 bearer token（先登进去，
知道旧口令时可用，2026-09-08 就是这么换的），彻底忘了则走 admin 的账号管理重设
（`server/admin/src/service/accounts.ts`）。

#### App Review Information → Notes（直接贴）

```
ACCOUNT / SIGN-IN
The first screen is a login screen (Log in / Sign up / Play offline). Please use the demo
account above — "Play offline" reaches only the single-player campaign and cannot test
in-app purchases, PvP, the open world, or chat.

FIRST LAUNCH — two gates before the lobby
1. A neutral age-declaration screen (self-declared, no identity verification). Enter any
   adult age to continue.
2. A privacy / terms consent dialog. Both links open in Safari.
Then you land on the lobby; the bottom tab bar reaches everything.

WHERE TO FIND WHAT YOU USUALLY CHECK
- Privacy Policy / Terms: tap your name at the top of the lobby to open Profile -> "Legal"
  (also in the first-launch consent dialog).
  https://nivara.gamestao.com/privacy and /terms
- Account deletion (5.1.1(v)): Profile -> Account -> "Delete Account" (red), with a second
  confirmation. 7-day grace period, then permanent.
- Paid random items (loot box) odds (3.1.1): Store tab -> Gacha -> the (i) button at the
  top right of the banner -> full per-rarity draw rates and pity guarantees.
- Report / block a player (1.2): tap any player name to open their profile popup ->
  Report / Block. Reports go to a human review queue; blocking is immediate.
- In-app purchases: Store tab -> Coins / Packs. All purchases go through StoreKit 2.
  The native build contains no web checkout and no link that steers to one.

CONTENT
- Real-time lane-pushing battles (tower defense), a single-player campaign, and a shared
  open-world map. Matches are server-authoritative and sync inputs, not outcomes.
- Player-chosen nicknames are visible to other players. There is 1:1 friend chat and group
  chat inside families/sects. No feed, no sharing or amplification, no discovery.
- Rewarded video ads via AdMob, non-personalized only (npa=1). No ATT prompt, no IDFA
  read.

CONTACT: support@gamestao.com
```

Contact 三格填 Tao Wang / `support@gamestao.com` / 本人电话。

---

### 1.3 年龄分级（Apple 自有问卷）

> **2026-09-08 重写**：Apple 换了问卷与尺度，旧记录的两条勾选与「12+」落点都已失效。
> **全球尺度现在是 4+ / 9+ / 13+ / 16+ / 18+，没有 12+**；新版问卷自 **2026-01-31** 起强制，
> 不填会卡住所有版本提交。下面是逐行答案与依据（每一条都用代码核过，别照旧稿抄）。

**Step 1 — In-App Controls / Capabilities**

| 行 | 答 | 依据 |
|---|---|---|
| Parental Controls | 否 | 包里没有家长监护/消费限额功能（中国区分龄限额仍在 §3.2 未做项里） |
| Age Assurance | **是** | 首启中性年龄声明门，`client/src/ui/dialogs/AgeGateDialog.ts`（2026-09-08 实装，见 [`COMPLIANCE_GLOBAL §3.4`](../../game/COMPLIANCE_GLOBAL.md)）。⚠️ 它是**自我声明**，不是身份核验——若问卷有核验方式的追问，照实答自我声明 |
| Unrestricted Web Access | 否 | 没有内嵌浏览器（无 `@capacitor/browser`），只有隐私政策/用户协议两个**固定** URL 跳系统浏览器（`SettingsScene/panels.ts`、`ConsentDialog.ts`） |
| User-Generated Content | 是 | 玩家自选昵称出现在排行榜/世界地图/对战界面；家族/宗门聊天对成员群发。**少报是危险方向** |
| Social Media | 否 | 没有信息流、没有转发/放大、没有发现机制——只有私聊与组织内群聊 |
| Social Media Disabled for Users Under 13 | 否 | 这是给上一行答「是」的 App 用的减档项，要求调用 Declared Age Range API；我们两者都没有（该行若被自动灰掉就跳过） |
| Messaging and Chat | 是 | 好友私聊 + 家族聊天（`socialsvc/src/family/chat.ts`）+ 宗门聊天（`worldsvc/src/sect/chat.ts`） |
| Advertising | 是 | AdMob 激励视频（`NWBridgeViewController.swift`）；与是否个性化无关 |

**内容类问题**：暴力/性/药物/恐怖等一律**无**。**模拟赌博答「无」**——这一问指赌场式玩法
（老虎机/扑克），答「频繁」会把分级顶到 18+；抽卡走**随机付费道具（loot box）**那一问。

**随机付费道具答「是」**（必答，概率公示页 `GachaScene/odds.ts` 就是 3.1.1 要的那个）。**后果要接受**：
巴西商店被强制 **18+**、澳大利亚 **16+**（15+ 已于 2026-06-18 取消）。

**✅ 2026-09-08 实际填完，问卷算出 13+**（与预期一致）。**Override 选 `Not Applicable`，Age Suitability URL 留空**：
override 到更高档会让商店页面与三处已定口径（§3.4 自我定级 / 三语政策 §9 / 年龄门的 13 岁门槛）互相打架——
商店写 16+ 而门仍放 13 岁进来，等于自己声明的东西自己不执行；而分区的更高分级（巴西 18+、澳大利亚 16+）
是 loot box 声明**自动**带来的，不需要 override。Age Suitability URL 那个字段**尤其不能填 `/home` 或
`/pricing`**——两页都通向 Paddle 网页结账，而 3.1.1 管到 metadata（同 §1.2 营销 URL 那条）。

- 预期落点：全球 **13+**（Messaging and Chat 决定的下限，与 §3.4 的 13+ 自我定级一致），
  巴西 18+、澳大利亚 16+；**EU 侧按 PEGI 16 预期**（[`COMPLIANCE_GLOBAL §6.1`](../../game/COMPLIANCE_GLOBAL.md) 已写明
  含付费随机道具默认 PEGI 16）。不得勾成全年龄/儿童档，见 [`COMPLIANCE_GLOBAL §3.4`](../../game/COMPLIANCE_GLOBAL.md)。

### 1.4 隐私营养标签（Privacy Nutrition Label）

> ✅ **口径已定（2026-09-03）：不跟踪，按下面照填。** 曾经有过一处自相矛盾——本节写着「不做跟踪、免 ATT」，
> 而客户端因为接了 AdMob 激励视频，`Info.plist` 带 `NSUserTrackingUsageDescription`、`AppDelegate.swift`
> 播广告前真的会弹 ATT。已按「不跟踪」这一侧统一：AdMob 改为**只请求非个性化广告**（`npa=1`，
> `nonPersonalizedRequest()`），ATT 请求与 `NSUserTrackingUsageDescription` 双双删除，不再读取 IDFA。
>
> `SKAdNetworkItems`（47 条）**保留**：Apple 自己的 App Privacy 口径把 SKAdNetwork 排除在 tracking 之外
> （聚合层面的安装归因，无用户级标识符，不需要 ATT），AdMob 发布方侧的归因要用它。
> 代价是 eCPM 会低一些，换到的是「标签写的和二进制干的是同一件事」。
> 详见 [`IOS_RELEASE.md §12`](../../game/IOS_RELEASE.md) 与三语隐私政策 §6.3。

> **✅ 2026-09-08 已在 ASC 填写并发布**，但**只填了 6 个数据类型，还差两个真实收集项**（下面「已发布状态」一节）。

按 §0.3 填写：
- **Data Used to Track You**：无（声明不做跨 App 跟踪 → 免 ATT 弹窗）。
- **Data Linked to You**：标识符（设备 ID）、联系信息（邮箱，可选）、用户内容（昵称/私聊）、购买、使用数据（埋点）。
- **Data Not Linked to You**：诊断（如崩溃日志，假名化）。
- 是否加密传输：是；是否可请求删除：是（应用内删除账号）。

#### 1.4b 已发布状态与欠账（2026-09-08）

**已填并发布的 6 项**（设置全部正确）：Email Address（App 功能/关联）、User ID（App 功能/关联）、
Device ID（App 功能 **+ 第三方广告** /关联）、Product Interaction（分析/不关联）、
Crash Data、Performance Data（分析/不关联）。跟踪那一问答「否」。
**Privacy Policy URL 当天补填** `https://nivara.gamestao.com/privacy`——它是**必填项**，
发布时是空的（`–`）；User Privacy Choices URL 可选，留空。

**⚠️ 还差两项真实收集项**（用户 2026-09-08 主动延后，提审前必须补，否则是 5.1.2 方向的漏报）：

| 缺的类型 | 该填 | 代码依据 |
|---|---|---|
| **Purchases → Purchase History** | App 功能 / 关联 / 不跟踪 | `commercial/src/db.ts` 的 `orders` `recharges` `ledger` `appleTransactionLinks` 四个集合都以 accountId 为键 |
| **User Content → Other User Content** | App 功能 / 关联 / 不跟踪 | 聊天存在服务端：`socialsvc/src/family/chat.ts:68` 往 `familyMessages` `insertOne`，好友会话走 `friendSvc.getMessages(accountId, convId, before, limit)`（客户端「加载更早的消息」就是它） |

补上后「Data Linked to You」摘要会变成 Identifiers / Contact Info / **Purchases** / **User Content**。

**两处可选加强（AdMob 口径，同日延后）**：`Usage Data → Advertising Data`（第三方广告/不关联/不跟踪）；
给 `Product Interaction` 再加一个 `Third-Party Advertising` 用途——Google 的披露指引写明
「user product interactions … may be used to improve advertising performance」，即使 `npa=1`
曝光与频次控制仍会记录。不加也说得过去（都不涉及跟踪判定），加了更贴近官方口径。

---

### 1.5 合规硬门（上架前必过，见 COMPLIANCE_GLOBAL §8 iOS 专属）
- [x] **生产环境的审核用 demo 账号**（2026-09-08 建好并灌完）—— `appstore.review@gamestao.com`，
      通关第一章已灌、金币故意留 0、PvP 卡组无需灌（那 10 张对所有 elo 开放）。
      `Sign-in required` 必须勾「是」。账号信息与复核方式见 §1.2b「审核账号」
- [x] **支持 URL / 营销 URL 有了专门的页面**（2026-09-08）—— `client/public/web/support.html` → `/support`、
      `about.html` → `/about`，两页零购买面，门禁在 `nativePaymentIsolation.test.ts`。理由见 §1.2
- [ ] 平台 IAP 接入（替换 dev 桩）+ 服务端票据校验 —— **代码侧已完成**（StoreKit 2 桥 + App Store Server API
      验单，fail closed，2026-09-07 A/B 两批，ADR-081/082）；ASC 建 9 个商品已完成。
      **凭据与通知 URL 也已完成（2026-09-07）**：In-App Purchase Key 的四个 `NW_APPLE_IAP_*` / `NW_APPLE_APP_ID`
      已进 VPS，通知 V2 的 URL 生产与沙盒都指向 `https://api.gamestao.com/api/iap/apple/notifications`
      （见 [`IOS_RELEASE.md §12`](../../game/IOS_RELEASE.md)，步骤在 §4.0）。
      **本条唯一还开着的是真机沙盒对账**：5 个币档 + 4 个非币商品各买一次、自动续订演练一次，
      依赖一个带 StoreKit 2 的 TestFlight 构建（见 `IOS_RELEASE.md §12`）
- [x] **原生包内不含网页支付通道**（2026-09-03 审计 + 修复，详见 [`IOS_RELEASE.md §10`](../../game/IOS_RELEASE.md)）：
      `home/pricing/refunds/pay/terms/privacy.html` 六个静态页曾随 `mobile` 构建进入 iOS 包与每个 OTA 包，
      Paddle 结账模块曾编进原生 bundle，桥丢失时 `iapKind()` 曾回落 `paddle`——均已堵上，`nativePaymentIsolation.test.ts` 护住
- [x] **隐私政策补 Apple 支付口径**（2026-09-03）：`privacy.html §3` 已分列 web(Paddle) 与 iOS(Apple)，
      `terms.html §3` 点明两个渠道的销售主体，`refunds.html §0` 写明「App Store 买的找 Apple 退」，三语 `.md` 同步
- [x] 应用内删除账号入口（5.1.1(v)）—— `SettingsScene/panels.ts` 的 `drawAccount()` 在退出登录下方给出红色入口，
      二次确认在 `overlays.ts` 的 `drawDeleteConfirm()`（Track 1 L1-2，登录态可见）
- [x] 抽卡概率公示页（3.1.1）—— `GachaScene/page.ts` 卡池横幅右上角的 ⓘ 入口 → `GachaScene/odds.ts` 概率详情
- [x] 隐私政策 URL 可点（2026-09-04）—— 首启同意弹窗 (`ConsentDialog`) **以及设置页**「法律条款」区两条链接，
      均走 `legalUrl()`：网页相对路径、原生壳绝对 https（`capacitor://` 会被 iOS 静默丢弃）。
      **补设置页入口的原因**：同意弹窗一辈子只出现一次，审核员的设备上早已同意过——在此之前 App 内根本找不到隐私政策。
      门禁 `client/test/ui/settingsLegalLinks.ui.ts`（9 例，含四种视口的几何核对与两种壳下的真实 URL）

---

## 2. Google Play（Android）

### 2.1 图标 / 截图 / 图形
| 素材 | 规格 | 状态 |
|---|---|---|
| 应用图标 | 512×512 PNG（32-bit, alpha） | ✅ `art/store/icons/play_icon_512.png`（与 iOS 同源同底，见 §0.4） |
| 特征图（Feature Graphic） | 1024×500 | ✅ `art/store/icons/play_feature_1024x500.png`（见 §0.4） |
| 手机截图 | 16:9 或 9:16，最少 2 张（建议 4–8），1080p+ | 🟡 初版已出（`art/store/en/*__android_9x16.png`，1080×1920，7 场景） |
| 平板截图（如支持） | 7"/10" 各一组 | 待美术 / 视支持 |
| 宣传视频（可选） | YouTube 链接 | 可选 |

### 2.2 元数据
- 应用名称（≤30）、简短描述（≤80）、完整描述（≤4000）——三语（见 §0.1）。
- 隐私政策 URL：`https://nivara.gamestao.com/privacy`（必填；`/privacy.html` 会 307 到无后缀形式，填无后缀的）。

### 2.3 年龄分级（IARC 问卷）
- 含**随机付费道具（gacha）/ 模拟赌博**：如实勾。
- 含**用户互动 / 可分享内容 / 用户间通信**：是。
- 预期：**Teen / PEGI 12** 档（以问卷为准）。

### 2.4 数据安全表（Data Safety）
按 §0.3 声明：收集项、是否加密传输（是）、是否可请求删除（是）、是否与第三方共享（IAP/分析/广告 SDK，见隐私政策 §5）、是否用于跟踪（否）。

### 2.5 合规硬门（COMPLIANCE_GLOBAL §8 Google Play 专属）
- [ ] Play Billing 接入 + 校验
- [ ] 数据安全表填写（对齐 §0.3）
- [ ] IARC 分级问卷
- [ ] 删除账号入口（Apple 已要求，Play 跟进）

---

## 3. 微信小游戏（中国大陆）

> ⚠️ 中国区受版号/实名/防沉迷约束，**跟版号流程走**，海外测试期不阻断（见 [`COMPLIANCE_CN.md`](../../game/COMPLIANCE_CN.md)）。本节列素材需求；版号相关合规项另由 Track 2 L2-4 实现。

### 3.1 素材规格
| 素材 | 规格 | 状态 |
|---|---|---|
| 小游戏图标 | 192×192 + 圆形版本 | ✅ 素材就绪 `art/logo/derived/logo-512.png`（ADR-027）；**无代码接入点 → 须在微信公众平台后台手动上传** |
| 分享图 | 5:4（建议 500×400） | ✅ `art/store/icons/wechat_share_500x400.png`（中文文案，见 §0.4） |
| 截图 | 按微信后台要求 | 🟡 可从 `art/store/en/` 那批改中文再出（脚本换 locale 即可，见 §0.4） |
| 小游戏名称/简介 | 中文 | 见 §0.1 中文 |

### 3.2 资质 / 合规（中国区硬门，依版号流程）
- [ ] **网络游戏版号（ISBN）**——前置一切（Track 2 L2-4 / 发行方）。
- [ ] 实名认证接入。
- [ ] 未成年人防沉迷限时（时段+时长）。
- [ ] 分龄充值限额（<8 拒付 / 8–16 / 16–18 上限）。
- [ ] 抽卡概率公示页。
- [ ] **健康游戏忠告 + 适龄提示标识**（见 §5）。
- [ ] 微信支付接入（非 Apple/Google IAP）。
- [ ] 隐私政策（中国区版本，含 PIPL 条款）。

### 3.3 分级 / 适龄提示
- 适龄提示标识（8+/12+/16+，依《网络游戏适龄提示》团标，落点待评估，预期 **12+**）。

---

## 4. CrazyGames（Web 聚合平台）

### 4.1 素材规格
| 素材 | 规格 | 状态 |
|---|---|---|
| 缩略图 | 按 CrazyGames 开发者要求（通常 16:9，建议 1280×720） | ✅ `art/store/icons/crazygames_thumb_1280x720.png`（横屏战斗实拍） |
| 游戏标题/描述 | 英文（见 §0.1 EN） | — |
| 操作说明 | 鼠标/触屏操作说明 | 待补 |

### 4.2 合规 / 平台要求（COMPLIANCE_GLOBAL §8 Web 专属）
- [x] **隐私政策 URL 可访问 + 客户端可点**（2026-09-04 修，真机核对过）：同意弹层的两个链接此前是根相对 `/privacy.html`，在门户域名下必然 404；`legalUrl()` 现按「是否跑在自家源上」分叉，CrazyGames 与原生壳一样给绝对 https（`ConsentDialog.ts`）。**这条修的时候顺带挖出一个更大的洞**：分叉依据 `clientPlatformName()` 读的是 `globalThis.TARGET`，而 DefinePlugin 那一行 key 是裸的 `TARGET`，**根本没替换成员表达式**——所以这个函数在任何真实构建里都返回 `'web'`（影响面不止本条，见 [`ANALYTICS_DESIGN §3.3`](../../game/ANALYTICS_DESIGN.md)）。补 key + 真编译探针后，在 crazygames dev 构建里实测：两个链接确实 `window.open('https://nivara.gamestao.com/privacy' | '/terms')`，`GET /bootstrap?platform=crazygames` 也终于报对了平台。⚠️ 仍只有**首启同意弹层**一处入口，设置页没有常驻链接（与 iOS §1.5 同一条欠账）。
- [x] cookie/同意条（若用分析 cookie）+ EU/UK 同意弹层（Track 1 L1-1）：`ConsentDialog` 首启阻塞，**全区玩家都弹**（不按地区分叉），所以门户玩家一定见得到上面那两个链接。⚠️ 门户自己也有一套 GDPR 流程，是否重复需按开发者后台口径确认。
- [x] **支付渠道合规**（2026-09-04 修）：`iapKind()` 早已返回 `null`（金币页/月卡年卡按钮不出现），但**构建产物**里还带着整套 Paddle 网页支付面（`pay/pricing/refunds/home/terms/privacy.html`）+ 编进 bundle 的 Paddle 结账模块——那是要整包上传给门户的东西。现按 iOS 同一套办法堵上：copy 规则与 `paddleCheckout` stub 替换都扩到 `crazygames`。虚拟道具条款见用户协议 §5/§6。
- [x] **广告 SDK 接线**（2026-09-04 修）：①`adStarted` → 广告播放期间整机静音（门户 QA 明确检查这条），四条退出路径（finish/error/throw/超时）都恢复；②`sdkGameLoadingStart()` 此前从未调用（只调了 Stop），现与 `init()` 一起放进构造函数，与 `onLoadingComplete()` 的 Stop 配成一对；③激励视频补上与插屏同款的超时兜底（有了静音之后，卡住的 SDK 会让整个会话哑掉，不只是转圈）。
- [ ] CrazyGames 内容政策逐条核对（外链限制、账号系统、加载时长要求）——需对着开发者后台逐条过。
- [ ] 抽卡概率公示页可达（代码侧已有，`GachaScene/odds.ts`，待冒烟实测）。
- [ ] **四平台冒烟的 CrazyGames 那一列**（[`acceptance-smoke.md §1`](../../game/release/acceptance-smoke.md)）——9 行全空，这条路从没在门户环境里真跑过。

### 4.3 构建与上传配方（2026-09-04 补）

门户**托管我们上传的整包**，因此这个 target 和原生壳属于同一类：包不跑在自家源上。两条推论都已固化进 `webpack.config.js`（`isOffOrigin` / `bakesRemoteBases` 两个谓词，回归测试 [`client/test/crazyGamesPortalIsolation.test.ts`](../../../client/test/crazyGamesPortalIsolation.test.ts) 20 例）：

1. **后端地址必须烘死**。此前 `build:crazygames` 走的是「生产 = 空串 = 同源」这一档，而同源在门户上是 crazygames.com → `net/config.ts` 拿到 null → **整包退化成纯离线**（登录/云存档/PvP/大世界全没了，而且不报错）。现在生产构建默认烘 `https://api.gamestao.com`（五个服务全烘，含 social/auction，绕过 2026-08-02 那条派生端口守卫）。
2. **网页支付面不进包**（见 §4.2 第三条）。

```bash
# 门户上传包（默认已烘生产地址，env 仅在打 staging 包时才需要覆盖）
cd client && NW_BUILD_VERSION=$(git rev-parse --short HEAD) npm run build:crazygames
# → client/dist/ 整个目录打 zip 上传；index.html 里已带门户 SDK 的 <script>
```

- **本地开发照旧**：`npm run start:crazygames` 是 webpack-dev-server，仍指 localhost 那套（`bakesRemoteBases` 只在生产模式对这个 target 生效）。
- **CI 里没有这条流水线**：`.github/workflows/` 只有 `client-deploy.yml`（Cloudflare 的 web 包）。门户是手动上传，暂不建 job；真要建时照 §4.3 这条命令即可。
- 体积参考（2026-09-04 实测）：`dist/` 约 25 MB，主包 2.1 MiB JS。门户对首屏加载时长有要求，上传前值得实测一次。

---

## 5. 健康游戏忠告 / 适龄提示 文案

### 5.1 中国区「健康游戏忠告」（标准文案，启动页/设置页展示）
> 抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。
> 适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。

- 配套展示：实名/防沉迷规则说明、适龄提示标识（预期 12+）、抽卡概率入口。

### 5.2 全球版「健康提示」（轻量，设置页/首启可选展示）

| 语言 | 文案 |
|---|---|
| 中文 | 温馨提示：适度游戏，合理安排时间，注意休息。本游戏含付费随机道具，概率详情见游戏内公示。 |
| English | A friendly reminder: play in moderation, take breaks, and manage your time. This game includes paid random items; see in-game odds disclosure for details. |
| Deutsch | Freundlicher Hinweis: Spielen Sie in Maßen, machen Sie Pausen und teilen Sie Ihre Zeit gut ein. Dieses Spiel enthält kostenpflichtige Zufallsgegenstände; Einzelheiten zur Wahrscheinlichkeit finden Sie in der In-Game-Offenlegung. |

---

## 6. 上架前总核对（汇总）

| 渠道 | 素材就绪 | 分级问卷 | 隐私标签/数据表 | 合规硬门 | 健康忠告 |
|---|---|---|---|---|---|
| iOS | ✅ 图标 + 截图齐（预览视频可选，未做） | §1.3 待填 | §1.4 待填 | §1.5 | 全球版 §5.2 |
| Google Play | ✅ 图标 + 特征图 + 截图齐 | §2.3 待填 | §2.4 待填 | §2.5 | 全球版 §5.2 |
| 微信小游戏 | ✅ 图标（既有 logo-512）+ 分享图齐；截图仍是英文版，中文版待跑 | §3.3 待评估 | 隐私政策(CN) | §3.2（依版号） | 中国区 §5.1 |
| CrazyGames | ✅ 横版缩略图齐；操作说明文案待补（§4.1） | 平台要求 | 隐私政策 | §4.2 四条已修，剩内容政策核对 + 冒烟 | 全球版 §5.2 |

> **依赖提醒**：图标 / 横幅 / 截图**全部已出且可一键复跑**（§0.4 三个脚本）。剩余美术类缺口只有可选的 App 预览视频；剩余非美术缺口是中文/德文截图（脚本换 locale 即可）与 iPad 横版适配（见 §0.6）。隐私标签答案依赖 §0.3 定稿（已与隐私政策对齐）；中国区整块依赖版号流程（Track 2 L2-4）。
