# 批次 7：剩余全部程序矢量图标 — Prompt 文档

> 创建：2026-08-25 · 判断+prompt 定稿：2026-08-25 · 出图+接线：**已完成 2026-08-25**（44 张全部落地）· 重出：v2 5 张过、1 张（`brush`）**改成 `skinIcon` 别名、已定案**（2026-08-26）· v3（另 4 条「可用但偏弱」）：**已出图并打包 2026-08-26**——`globe`/`armor`/`armorHeavy`/`scrap` 四张过，`atk` 经 v3/v4/v5 三次打回后、**v6 一版过（2.00:1）**
> 前六批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（试点/批次 2/3/4，19 张）· [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md)（页面标题+剩余页签，24 张）· [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)（大厅首页主视觉，3 张）
> 配套代码（接线后）：[`client/src/render/icons.ts`](../../client/src/render/icons.ts)（只剩两表分派，`DrawableIconKind`/`DRAW` 已删）· [`client/src/render/icons/inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts)（**本批落地处**：`InkIconKind` + `INK_ICON_ART` + `buildInkIcon` 运行时染色）· [`client/src/render/icons/tabIconRaster.ts`](../../client/src/render/icons/tabIconRaster.ts)（前六批的页签表，未改）· [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)
> 已删除的矢量画法：`client/src/render/icons/{equipment,ui,slg,motifs,titles,currency,primitives}.ts` 七个文件整体删除（`DRAW` 清零后全部变死代码）
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6
> 状态：**全部完成**（最终账：43 张自有美术 + 6 个别名 = 49 个 ink kind，无待办）；v3 五张中 `globe`/`armor`/`armorHeavy`/`scrap` 四张一版过，`atk` 经 v3/v4/v5 三次打回后 v6 过（2.00:1）；`iconArtAspect.test.ts` 的豁免同时从「无条件」改成「带上限」，并因 v6 变宽而删掉了 `atk` 那一行

## 背景：前六批 + 金币收口之后，还剩的就是这些

前六批处理的是"页签条 + 页面标题 + 大厅首页"三类**导航类**位置，2026-08-25 的金币图标收口处理的是"货币/奖励"这一类。做完这两件事，`DrawableIconKind`（`icons.ts` 的 `DRAW` 表）里剩下的 49 个矢量 kind，全部是批次 3 当时明确点名"不在这批范围"的那类——装备词条数值徽标、结算页/强化按钮这类动作按钮、SLG 建筑与时长道具、通用 UI 图钉符号（✕/✓/▶ 等）、段位称号墙——见 `tab-icon-art-prompts.md` 那句原话：

> 没有一并处理的相邻点……这些要么是内容态数值徽标（装备属性、结算奖励行），要么是动作按钮（结算页操作、装备强化/卸下），要么是头像底色装饰——不是导航页签，不在"页签主图标"范围内，维持程序绘制。

用户本轮提问的起点正是其中最显眼的一处：装备详情弹窗里"攻击/护甲/生命"三个词条图标，被误认成缺失美术资源的占位符（见本文档同一轮对话记录，非本文件内容）。核实后确认这只是"该出图但还没出"，于是有了这一批。

## 判断结果总表：49 个矢量 kind 里，5 个复用、44 个出新图

先过一遍去重——延续前几批"同一个概念不重复出图"的判据，逐个检查这 49 个是否已经跟某张现成光栅图撞了概念：

| kind | 剩余调用点 | 判断 | 理由 |
|---|---|---|---|
| `swords` | `ResultScene.ts`（重开对战按钮） | **复用 `pvpTabIcon`**（交叉双剑） | `AchievementScene.ts` 的 pvp 分类早就判过这条复用（`tab-icon-art-prompts.md` 已有记录），`ResultScene` 这处剩余调用点是同一个"对战/PVP"概念，没有理由另起一张 |
| `home` | `WorldMapPanels/headerHud.ts` 的 `entryBtn('home', …)`（世界地图头栏"回家"按钮） | **复用 `homeTabIcon`**（三角顶小房子） | `LobbyScene/bottomNav.ts` 的 `home` 早就复用了 `homeTabIcon`，这是同一个"房子"概念的最后一个漏网调用点 |
| `capsule` | `GachaScene/page.ts`（奖池稀有度徽标）、`BattlePassScene/cell.ts`/`FriendsScene/mail.ts`/`RechargeScene.ts`（奖励图标兜底）、`ShopScene/shop.ts`（`starter_draw` 商品图标） | **复用 `gachaTabIcon`**（扭蛋球） | Shop 组 hub 的 `capsule`→`gachaTabIcon` 复用早就接了线（`tab-icon-art-prompts.md` §批次 3），这些是散落在其它屏幕、还没跟上那次复用的剩余调用点——概念完全相同，都是"这是一次扭蛋/抽卡性质的奖励" |
| `gift` | `FriendsScene/mail.ts`（邮件附件标记）、`ShopScene/shop.ts`（`starter_growth` 商品图标） | **复用 `weeklyTabIcon`**（系丝带的礼物方盒） | `weeklyTabIcon` 的判断原话就是"系十字丝带的礼物方盒"，跟 `gift` 矢量画法的"箱体+盖沿+中央缎带+双环蝴蝶结"是同一件东西，只是叫法不同 |
| `tag` | `WorldMapPanels/headerHud.ts` 的 `entryBtn('tag', t('world.auction'), …)`（世界地图头栏"拍卖行"按钮）、`WorldMapPanels/shop.ts`（商品兜底图标）、`AuctionScene/itemLabels.ts`（非拍卖模式兜底） | **复用 `auctionTabIcon`**（竞价号牌） | 三处剩余调用点全部是"拍卖/上架"语义，`AuctionScene/list.ts` 自己的 `all` 页签早就从 `tag` 切到了 `shopTabIcon`（另一个复用决策）；世界地图头栏那个按钮字面标签就是 `world.auction`，直接指向拍卖场，没有理由不用 `auctionTabIcon` |

**接线结果（2026-08-25，与本表原计划不同）**：原计划是把这 5 处的调用点字符串改成 `'pvpTabIcon'` 等。实际接线时发现其中 4 个的调用点在传**有意义的颜色**（胜负绿红 / 拍卖红 / 附件金 / 奖励自身色），换成页签 kind 会走 `tabIconVariant` 把颜色抹平，于是改成**美术别名**：这 5 个 kind 留在 `INK_ICON_ART` 里、url 指向被复用那张图已有的白母版。「同一概念只画一次」的去重结论不变（不多出任何一张图），tint 保住，约 15 个调用点零改动。详见文末「出图与接线结果」。

剩下 44 个按优先级分 8 档，判据是"平均玩家实际见到的频率"，不是字母序或代码里的声明顺序：

| 档 | 范围 | 数量 | 排序理由 |
|---|---|---|---|
| P0 | 装备词条图标 | 6 | 本轮问题的起点——出现在每一张装备卡、每一次强化/详情面板 |
| P1 | 装备详情弹窗其余元素 | 5 | 跟 P0 挤在**同一屏**（强化消耗材料+强化按钮本身+皮肤刷子标签），P0 修完这里还留着一半矢量图，观感不完整 |
| P2 | 战斗内货币 | 1 | 每一局战斗的 HUD 常驻元素，可见度极高 |
| P3 | 高频通用 UI | 8 | 结算页/卡池/收藏点等一堆页面复用同一批图钉符号 |
| P4 | 次高频通用 UI | 2 | 特定页面高频但不是全局常驻 |
| P5 | SLG 建筑与时长道具 | 6 | 仅 SLG 玩家可见，但对他们而言是高频 |
| P6 | 旧概念 fallback | 5 | 前六批已经把这几个概念的**主要**出场位置换成了专属新图，剩下的都是边缘兜底位置（toast 默认图、"新增皮肤"格子、年卡角标） |
| P7 | 段位称号墙 | 11 | 全游戏最小众的一屏（称号墙浏览动态称号），且是唯一的"递进家族"，出图风险/迭代成本最高，放最后 |

## Prompt 骨架（沿用前六批，不重复贴共用部分）

> 除非在个别 prompt 里特别写明，一律用以下骨架：`Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: …. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, …, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.` 每条 prompt 只贴 `Subject` 和该条专属的 `Avoid` 追加项，两者都要通读组装成完整 prompt 才能用。

---

## P0 装备词条图标（6 条）

装备详情/卡片上"攻击 +10% / 护甲 +5 / 生命 +8%"这几行前面的小图标（`client/src/scenes/EquipmentScene/detail.ts` 的 `affixIconKind`）。矢量原型见 `icons/equipment.ts` 的 `drawAtk/drawHp/drawArmor/drawArmorHeavy/drawSpd/drawAtkspd`。

| # | kind | 造型 | 避让 |
|---|---|---|---|
| 1 | `atk` | 一把上指的匕首，简单十字护手，刀尖处几道短促的迸溅线表示"打击力" | 不是完整长剑（那是 `weaponTabIcon` 的装备槽筛选语义）；不是交叉双剑（`pvpTabIcon`） |
| 2 | `hp` | 单个对称心形 | — |
| 3 | `armor` | 小圆盾正面：圆形+中央凸钉+一条横向加固带+边缘几颗铆钉 | 不是鸢形/水滴形盾（`equipIcon`）；不是胸甲剪影（`armorslotTabIcon`） |
| 4 | `armorHeavy` | 同 armor 的圆盾，但明显加固：多一圈外环+更粗的边框+横带两侧铆钉加倍 | 必须保持跟 armor 同一个盾家族，只是"更厚重"，不能换成鸢形/胸甲 |
| 5 | `spd` | 两个前进的尖角箭头前后叠放（像">>"号），指向右方 | — |
| 6 | `atkspd` | 单条锯齿闪电 | — |

### 1 攻击（`tabicon_atk`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single upward-pointing dagger blade with a small plain straight crossguard and a short handle below it, and a few short radiating spark lines bursting from the blade's tip suggesting impact and power. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a long two-handed sword, an ornate pommel, two crossed blades, a shield or crest behind it, a hand gripping it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 生命（`tabicon_hp`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single simple symmetric heart shape, two rounded lobes meeting at a point at the bottom. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a pulse/heartbeat line through it, a crack or break in it, wings, an arrow through it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 3 护甲（`tabicon_armor`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a small round buckler shield seen face-on — a plain circle with one raised boss/rivet in the very center, one horizontal reinforcing band crossing the middle, and a few small rivets spaced around the rim. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no metal-texture hatching. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a kite-shaped or teardrop-shaped shield, a pointed bottom, a breastplate or torso-armor shape, a sword or crossed swords behind it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 4 护甲·加固档（`tabicon_armorHeavy`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the same small round riveted buckler shield as a plain armor icon, but visibly reinforced: an extra outer ring around the rim, a noticeably thicker border, and rivets doubled up on both ends of the horizontal reinforcing band. Must read as clearly heavier/more armored than the plain version at a glance. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no metal-texture hatching. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing to a kite-shaped or teardrop shield, a breastplate shape, spikes sticking outward, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 5 移速（`tabicon_spd`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: two simple forward-pointing chevron arrow shapes stacked one after another like a ">>" motion mark, both pointing to the right, evenly spaced. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a single arrow, three or more chevrons, a full arrow with a shaft and head, wings or feet, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 6 攻速（`tabicon_atkspd`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single jagged lightning bolt, one continuous zigzag shape. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two or more bolts, a cloud around it, sparkle marks, a circle or badge frame around it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P1 装备详情弹窗其余元素（5 条）

跟 P0 挤在同一个强化面板/成本行里：三种材料（`client/src/render/icons/equipment.ts`）、强化按钮本身的锤子（`icons/slg.ts` 的 `drawHammer`，虽然文件在 slg.ts，但剩余调用点已经是装备强化按钮为主）、皮肤页的刷子标签。

| # | kind | 造型 | 避让 |
|---|---|---|---|
| 7 | `scrap` | 一张撕边残页，两条淡横线 | — |
| 8 | `lead` | 单独的削尖铅笔芯（只有笔芯，没有笔身） | 不画完整铅笔（那是 `pencils`/`duelTabIcon` 的活） |
| 9 | `binding` | 孤立的螺旋装订圈（三圈弹簧线，周围没有书页/封面） | 不能带出书页轮廓（`campaignTabIcon` 的翻开笔记本已经用了装订圈做背景细节，这张必须只画圈本身） |
| 10 | `hammer` | 平头锻造锤：直柄+矩形锤头，侧视 | 不是圆头双面法槌（`bidTabIcon`）；不是铁砧（`craftTabIcon`）；锤头不能斜置挥动姿态 |
| 11 | `brush` | ~~直立毛笔：木柄+一道金属箍+散开笔锋+笔尖一滴墨~~ **作废：三轮后判为不该出图，改成 `skinIcon` 别名，见文末** | — |

### 7 旧纸片（`tabicon_scrap`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single torn scrap of notebook paper with ragged, uneven torn edges all around, and two short faint horizontal lines across it suggesting ruled paper lines. Single object, centered, filling the frame, on a plain pure-white background, no grid lines beyond the two suggested lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a neat rectangular sheet with straight edges, a folded corner, more than two ruled lines, a spiral binding, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 8 铅笔芯（`tabicon_lead`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single sharpened pencil-lead tip by itself — a narrow cone shape coming to a point at the top, with a flat cut base at the bottom, no wooden barrel or pencil body around it at all. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a whole pencil with a wooden barrel, an eraser end, two pencils, a hexagonal cross-section, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 9 装订线（`tabicon_binding`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an isolated spiral notebook-binding coil floating alone — three diagonal loops of spring wire, one after another, with nothing else drawn around or behind it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, any book pages or cover edges around it, a closed ring binder, fewer than three or more than four loops, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 10 强化锤（`tabicon_hammer`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single blacksmith's hammer seen in profile, standing upright — a short straight handle with a plain flat-ended rectangular block head fixed at a right angle across the top. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a round double-faced gavel head, a claw on the head, a swung/angled pose, an anvil beneath it, sparks or impact lines, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 11 毛笔（`tabicon_brush`）— **作废，见文末「`brush` 收在了别名上」**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single upright calligraphy writing brush — a plain round wooden handle, one thin metal ferrule band partway down, and a slightly splayed, fanned-out bristle tip at the bottom with one small ink drop just below the tip. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a paintbrush lying flat, a tightly-pointed unsplayed tip, ink dripping in multiple drops, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P2 战斗内货币（1 条）

`client/src/render/HUDView.ts` 的墨水瓶图标（战斗内货币"墨汁"），矢量原型 `icons/currency.ts` 的 `drawInk`。文件头注释自己写着"Placeholder until the AI-drawn glyph lands"——等了很久的一张。

### 12 墨水（`tabicon_ink`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a squat stationery inkwell bottle — a rounded rectangular body with a narrower neck and a flat rim at the top, ink shown filling roughly the lower half of the bottle, and one small teardrop-shaped ink drop poised in mid-air just above the open rim. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a fountain pen or quill, a cork or stopper, multiple drops, ink splashing or spilling out, a label on the bottle, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P3 高频通用 UI（8 条）

结算页操作按钮、卡池稀有度点、收藏/锁定标记等一批到处复用的图钉符号。矢量原型见 `icons/ui.ts`。

| # | kind | 造型 | 避让 |
|---|---|---|---|
| 13 | `replay` | 近 300° 圆弧箭头 | — |
| 14 | `share` | 浅托盘+向上直箭头 | — |
| 15 | `star` | 实心五角星 | — |
| 16 | `lock` | 挂锁：拱形锁梁+方体锁身+锁孔 | — |
| 17 | `medal` | 单个圆牌+两条短绶带，牌面完全空白（颜色染色区分名次） | 不能加刻面/皇冠/月桂——那是段位称号家族（P7）的语言，`medal` 必须保持全游戏最朴素的那一枚 |
| 18 | `close` | 两笔交叉的 ✕ | — |
| 19 | `check` | 两段折线的 ✓ | — |
| 20 | `play` | 单独一个实心右向三角，不带任何外框 | 不能套圆角屏幕框（那是 `adsTabIcon` 的复合形状——这张只要裸三角） |

### 13 重播（`tabicon_replay`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single circular arrow sweeping almost all the way around — about 300 degrees of a circle — with a clear triangular arrowhead at one end showing the direction of rotation. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a full closed circle with no gap, two arrowheads, a clock face, hands or numbers inside it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 14 分享（`tabicon_share`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a shallow open tray shape (like a wide U seen from the front) with a single straight arrow pointing straight up out of the middle of it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a closed box, a curved or branching arrow, multiple arrows, a phone or screen shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 15 星标（`tabicon_star`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single solid five-pointed star. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no sparkle lines radiating from it. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an outlined/hollow star, more or fewer than five points, sparkle rays around it, multiple stars, a circle behind it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 16 锁定（`tabicon_lock`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a padlock seen face-on — an arched shackle on top and a rounded rectangular body below it, with one small round keyhole in the middle of the body. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an open/unlocked shackle, a key inserted or beside it, a chain, a keyhole shaped like a teardrop, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 17 名次奖牌（`tabicon_medal`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single plain round medal disc hanging below two short ribbon tails above it, the disc face left completely blank — no facets, no rays, no crown, no wreath, the plainest possible medal shape (rank is shown by tint colour alone, not by the artwork). Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, facets or cut edges on the disc, a crown on top, a laurel wreath around it, a star shape instead of a disc, a number on the disc, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 18 关闭（`tabicon_close`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: two straight ink strokes crossing each other to form a simple X mark. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a circle around the X, more than two strokes, curved strokes, a trash-can shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 19 确认（`tabicon_check`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single checkmark — one short stroke angling down and to the right, meeting one longer stroke angling up and to the right, forming a simple tick shape. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a circle around the tick, a double checkmark, a curled/looped stroke, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 20 播放/重开（`tabicon_play`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single solid triangle pointing to the right, standing alone with nothing around or behind it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a rounded screen or frame around the triangle, a circle around it, a pause bar beside it, an outlined/hollow triangle, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P4 次高频通用 UI（2 条）

| # | kind | 造型 | 避让 |
|---|---|---|---|
| 21 | `zoom` | 放大镜：镜圈+斜向粗柄 | — |
| 22 | `cards` | 两张叠放卡片（背卡+正卡）+角标圆点+一条分隔线 | 不是扇形展开三张牌（`deckTabIcon`）；牌面不画人物剪影（那是 `rosterIcon` 的活，这张要保持纯粹的"这是卡类道具"通用标记） |

### 21 放大镜（`tabicon_zoom`）

`WorldMapScene` HUD 的缩放循环按钮。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a magnifying glass — a circular lens ring with a short thick straight handle angled down and out from the lower-right of the ring. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no reflection lines inside the lens. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a plus or minus sign inside the lens, a very long or thin handle, a second magnifying glass, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 22 卡牌通用徽标（`tabicon_cards`）

拍卖行"我的挂单"页签的通用图标（判断为不动，见 `tab-icon-art-prompts.md` 相关记录：这个 tab 混装卡/装备/材料/皮肤，硬套 `rosterIcon` 那张具体的"战斗小人卡"反而制造语义偏差，所以保留一张纯粹的"这是卡类道具"通用标记，出的是新图不是复用）。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: two plain rounded-corner card-shaped rectangles stacked with a slight offset — one card behind and one card overlapping it in front, both card faces completely blank except for one small round dot badge tucked in a top corner of the front card and one short horizontal divider line across its face. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, three or more cards fanned out, a figure or portrait drawn on either card, playing-card suit symbols, a single card only, text, letters, numbers, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P5 SLG 建筑与时长道具（6 条）

`CityScene` 建筑网格图标 + 世界地图占领标记 + 头栏商店的加速/防护档位。矢量原型见 `icons/slg.ts`。

| # | kind | 造型 | 避让 |
|---|---|---|---|
| 23 | `flag` | 单根旗杆+一面小三角旗，插在地上 | 不是一串多面小旗（`eventTabIcon` 的彩旗串）——这张必须只有一根杆一面旗 |
| 24 | `desk` | 简单办公桌：一块桌面+左侧一条腿+右侧带把手的抽屉柜 | — |
| 25 | `cabinet` | 三层抽屉档案柜，每层一条短把手线 | — |
| 26 | `hourglassSm` | 木盖沙漏，仅下方一粒沙+一道细流，上方几乎是空的 | — |
| 27 | `hourglassMd` | 同一只沙漏，半满：下方沙堆明显更大、两粒沙+两道流，上方还剩一些沙 | 必须比 Sm 档明显"更满" |
| 28 | `hourglassLg` | 同一只沙漏，快溢出：下方几乎堆满、三粒沙+三道流，上方只剩一点点 | 必须是三档里最满的 |

### 23 据点旗（`tabicon_flag`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single flagpole planted upright in the ground, with one small triangular pennant flag near the top, the flag left blank. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a string of multiple small flags, a rectangular flag, a mound or hill under the pole, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 24 主城办公桌（`tabicon_desk`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a simple office desk seen from a slight angle — a flat rectangular desktop on one plain straight leg at the left end, and a tall drawer unit with one small handle at the right end. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, four legs, a chair, papers or a lamp on top, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 25 档案柜（`tabicon_cabinet`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a tall rectangular filing cabinet with three stacked drawers, each drawer marked by one short horizontal handle line. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two or four drawers instead of three, an open drawer, wheels or legs, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 26 沙漏·小档（`tabicon_hourglassSm`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an hourglass with a plain flat wooden cap at the top and bottom and a pinched narrow waist in the middle, with just a thin trickle of a couple of sand grains and one short falling-sand line in the lower bulb, the upper bulb almost completely empty. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a full/overflowing lower bulb, a stand or legs under it, wings, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 27 沙漏·中档（`tabicon_hourglassMd`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the same plain wooden hourglass shape as a smaller tier, but roughly half full — a noticeably bigger pile of sand filling about half the lower bulb, two grains and two short falling-sand lines, and some sand still visible sitting in the upper bulb. Must read as clearly fuller than a bare-trickle version at a glance. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing the overall hourglass silhouette, an almost-empty lower bulb, an almost-empty upper bulb, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 28 沙漏·大档（`tabicon_hourglassLg`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the same plain wooden hourglass shape again, now nearly brimming — the lower bulb almost overflowing with sand, three grains and three short falling-sand lines, and only a small amount of sand left sitting in the upper bulb. Must read as clearly the fullest of a three-tier set at a glance. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing the overall hourglass silhouette, sand spilling outside the glass, a full upper bulb, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P6 旧概念 fallback（5 条）

`book`/`globe`/`trophy`/`castle`/`pencils` 这五个是最早一批的矢量图标，前六批陆续把它们的**主要**出场位置换成了专属新图（`book`→`statsTabIcon`/`pveTabIcon`、`globe`→`socialTabIcon`、`trophy`→`achievementTabIcon`/`honorTabIcon`/`leaderboardTabIcon`、`castle`→`cityTabIcon`、`pencils`→`duelTabIcon`），但每一个都还留着一两个**边缘兜底**位置没跟上：

| # | kind | 剩余调用点 | 造型 | 避让（对应哪张现成图，说明为什么不能直接复用） |
|---|---|---|---|---|
| 29 | `book` | `CityScene/icons.ts`（书院建筑图标） | 摊开练习本，双页平放、书脊为一条直线（不做张开透视） | 不是 `campaignTabIcon` 那张戏剧性张开的大厅主视觉——这张是小尺寸配角图标，书脊用直线不用装订圈 |
| 30 | `globe` | `LobbyScene/overlays.ts`（信息 toast 默认图标） | 简单地球：一个圆+一条经线+一条纬线 | 不能跟 `socialTabIcon` 的地球画法一样精细/加粗——这张是配角小图标，比它更朴素 |
| 31 | `trophy` | `LobbyScene/overlays.ts`（成就 toast 默认图标）、`render/avatar.ts`（称号图标兜底）、`ShopScene/shop.ts`（年卡角标）、`WorldMapPanels/shop.ts`（battle_pass 商品图标兜底） | 奖杯剪影：杯身+两耳+短柄+底座，不加光芒/刻面 | 比 `achievementTabIcon` 更朴素——那张是成就页 tab 的主图标，这张只是到处兜底用的小徽标 |
| 32 | `castle` | `CityScene/icons.ts`（城墙建筑图标）、`ResultScene.ts`/`WorldMapPanels`（据点数统计图标） | 城堡剪影：两座方塔+中央一座更高的主塔，简单雉堞，主塔上一面小旗 | 必须跟 `cityTabIcon`（城门楼，无中央高塔、有拱门）区分开：这张要有明显更高的**中央主塔**，且**不画拱门开口** |
| 33 | `pencils` | `CardScene/skins.ts`（"新增皮肤"占位格） | 交叉两支铅笔，笔尖朝下朝外、橡皮头朝上朝外，交点**不加墨渍** | 跟 `duelTabIcon`（大厅英雄水印，笔尖朝上、交点有墨渍迸溅）区分：这张笔尖朝下、无墨渍，是配角小图标不是主视觉 |

### 29 学院/书本（`tabicon_book`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an open exercise book seen face-on at a slight angle, its two pages lying flat and blank with a plain straight spine line down the middle — a calmer, flatter open book than a dramatic splayed-open one. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, pages curving dramatically upward and outward, a spiral binding coil, a rolled-up scroll, a closed book, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 30 地球（消息兜底，`tabicon_globe`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a simple globe — one plain circle outline with one curved vertical meridian line and one slightly curved horizontal equator line crossing it, nothing else drawn on the surface. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, continents or landmasses drawn on it, more than two internal lines, a stand or axis through it, a flat unfolded paper map instead of a sphere, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 31 奖杯（兜底徽标，`tabicon_trophy`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a plain trophy cup — a rounded cup bowl with two curved handle "ears" on either side, sitting on a short stem and a small flat base. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no shine marks or facets on the cup. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, sunburst rays behind it, a lid on the cup, laurel leaves around it, a star or number on the cup, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 32 城堡（兜底徽标，`tabicon_castle`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a castle silhouette with two square corner towers joined by a wall, and a THIRD, TALLER keep tower rising in the center behind them so the skyline clearly steps up in the middle, simple square crenellations along all the tops, one small pennant flag on the tallest central tower. No gateway opening anywhere in the wall. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no brick or stone texture lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a flat two-tower skyline with no central height, an arched gateway or door opening in the wall, windows, brick pattern, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 33 交叉铅笔（皮肤占位格，`tabicon_pencils`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette, no scattered separate pieces. Subject: two ordinary wooden pencils crossed in a plain X, both sharpened tips pointing downward and outward, blunt eraser ends pointing upward and outward — no ink splat or mark at the crossing point, just a clean simple crossing. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an ink splat or burst at the crossing point, tips pointing upward, three or more pencils, a single pencil, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---

## P7 段位称号墙（11 条）

`TitlesScene` 的动态称号墙（非永久称号的 fallback 展示），矢量原型 `icons/titles.ts`：9 级阶梯（bronze→king，逐级叠加细节）+ 2 个 SLG 赛季称号（盾形，Champion 带皇冠）。这是唯一的"**递进家族**"——11 张图必须互相看得出等级差，比前面任何一档都难保证一次过，所以排最后、优先级最低。

**出图建议**：这一档很可能需要"先出全套草稿看阶梯感够不够，再挑着重出"的迭代节奏，不要按前面几档"一张过了就定稿"的节奏处理；9 级阶梯建议**同一批一次性丢给模型**（同一对话/同一 batch 请求）而不是分开单独出，靠"沿用上一张的构图，只加这一处细节"的连续性提示保证家族感，比 11 次互相独立的请求更容易维持一致的画风/线宽/视角。

| # | kind | 造型（在上一级基础上新增的部分，粗体） | 避让 |
|---|---|---|---|
| 34 | `titleBronze` | 圆牌+两条短绶带，牌面空白（阶梯起点） | 不能跟 `medal`（P3 #17）撞成同一张图——这张是称号墙"最低阶"，允许比 `medal` 更朴素或完全相同都行，因为两者本来就没有共存的场景，但画法上仍按此处单独出图，不复用 |
| 35 | `titleSilver` | bronze + **牌面内多一圈同心内环** | — |
| 36 | `titleGold` | silver + **内环中心多几道短射线（十字光）** | 不要画成完整太阳/满天射线，只要中心几道短光 |
| 37 | `titlePlatinum` | gold，但圆牌边缘改切成**六边形刻面**（棱角分明） | 圆变六边，光线保留 |
| 38 | `titleDiamond` | platinum 基础上，刻面从六边形变成**更多棱角的放射状切割**（钻石切割感，比六边形更尖锐密集） | 不要变成一整个星形——切面感为主，仍是圆盘轮廓的变体 |
| 39 | `titleStar` | 牌身**直接变成一个五角星实体**（不再是圆盘），绶带保留在下方 | 与 P3 #15 的纯 `star`（无绶带、无阶梯语境）区分——这张必须带绶带 |
| 40 | `titleMaster` | titleStar + **星体一侧缠绕一小簇月桂叶** | — |
| 41 | `titleGrandmaster` | master + **星体顶部多一顶小皇冠** | 皇冠要明显小于下一级 |
| 42 | `titleKing` | grandmaster，但**皇冠更大更华丽**，且**牌身后方多几道放射光线**（比 gold 那圈光更大更外扩） | 这是阶梯顶点，必须是 11 张里最繁复的一张 |
| 43 | `titleChampion` | **盾形**轮廓（不是圆盘/星形）+ 缠绕一圈月桂叶 + 顶部一顶小皇冠 | 与 titleGrandmaster/King 的皇冠+星体组合区分：底形必须是盾，不是星 |
| 44 | `titleTop3` | 同 titleChampion 的盾形+月桂叶，但**不带皇冠** | 与 titleChampion 的唯一差异就是有没有皇冠，两者必须能在 28px 一眼分辨 |

### 34 称号·青铜（`tabicon_titleBronze`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the first, plainest rank in a nine-step medal progression — a single round medal disc hanging below two short ribbon tails, the disc face completely blank. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, any inner ring, facets, rays, a crown, a wreath, a star shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 35 称号·白银（`tabicon_titleSilver`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the second rank in a nine-step medal progression, one step up from the plainest bronze version — the same round medal disc hanging below two short ribbon tails, but now with one extra plain concentric inner circle drawn inside the disc face. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as one small step more elaborate than an entirely blank medal. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, rays or facets, a crown, a wreath, a star shape, more than one inner ring, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 36 称号·黄金（`tabicon_titleGold`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the third rank in a nine-step medal progression, one step up from the silver version — the same round medal disc with one concentric inner ring, hanging below two short ribbon tails, now with a few short rays radiating outward from the center like a small burst of light layered over the ring. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as one small step more elaborate than the plain-ring version. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a full sunburst covering the whole disc, facets or a hexagonal edge, a crown, a wreath, a star shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 37 称号·铂金（`tabicon_titlePlatinum`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the fourth rank in a nine-step medal progression, one step up from the gold version — the same medal with the center light-ray burst, hanging below two short ribbon tails, but the outer disc is now cut into a plain hexagonal facet shape instead of a smooth circle, sharp straight edges all around. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as one small step more elaborate than the round gold version. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a smooth round disc, more than six facet edges, a crown, a wreath, a star shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 38 称号·钻石（`tabicon_titleDiamond`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the fifth rank in a nine-step medal progression, one step up from the hexagonal platinum version — the same medal hanging below two short ribbon tails, but now cut into many more, sharper angular facets radiating outward like a dense diamond-cut gem, more pointed and busier than a plain hexagon while still clearly reading as one round-ish disc overall. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as one small step more elaborate than the six-sided platinum version. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, turning into a five-pointed star outline, a smooth hexagon, a crown, a wreath, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 39 称号·星耀（`tabicon_titleStar`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the sixth rank in a nine-step medal progression, one step up from the faceted diamond disc — the medal body itself is now a single solid five-pointed star shape instead of a round disc, still hanging below the same two short ribbon tails. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and the ribbon tails below it must stay visible so it still reads as a medal, not a bare star. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, no ribbons at all (a bare star with nothing hanging below it), a wreath, a crown, more or fewer than five points, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 40 称号·大师（`tabicon_titleMaster`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the seventh rank in a nine-step medal progression, one step up from the plain star version — the same five-pointed star medal hanging below two short ribbon tails, now with a small sprig of laurel leaves (three or four simple leaf shapes on a thin stem) wrapped around one side of the star. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as one small step more elaborate than the bare star version. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a full wreath wrapping all the way around, a crown, more than one small laurel sprig, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 41 称号·宗师（`tabicon_titleGrandmaster`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the eighth rank in a nine-step medal progression, one step up from the laurel-sprig star version — the same five-pointed star with a laurel sprig on one side, hanging below two short ribbon tails, now with one small simple crown sitting on top of the star. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and the crown must be noticeably small and simple — a smaller, plainer crown than a top-tier version would have. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a large ornate crown, radiating light rays behind the medal, a shield shape instead of a star, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 42 称号·王者（`tabicon_titleKing`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the ninth and top rank in a nine-step medal progression, one step up from the small-crown grandmaster version, the most elaborate of the whole set — the same five-pointed star with a laurel sprig on one side, hanging below two short ribbon tails, topped with a noticeably bigger and more ornate crown than the previous rank, and with a few extra light-ray lines fanning outward from behind the whole medal. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels despite being the busiest icon in the set — keep the extra rays few and short rather than crowding the silhouette. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a tiny plain crown, no rays at all, a shield shape instead of a star, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 43 赛季称号·冠军（`tabicon_titleChampion`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a plain heraldic shield outline (not a star, not a round disc) with a small sprig of laurel leaves wrapped around one side of it, and one small simple crown sitting on top of the shield. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a star or round disc instead of a shield, a kite-shaped equipment shield with a center boss (that reads as armor, not a badge), a full wreath around the whole shield, ribbon tails, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 44 赛季称号·前三（`tabicon_titleTop3`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the same plain heraldic shield outline with a small sprig of laurel leaves wrapped around one side of it as a companion "champion" badge, but with NO crown on top at all — this is the one clear difference between the two, so leave the top of the shield completely bare. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, and the absence of a crown must be unambiguous even at that size. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, any crown or crown-like shape on top, a star or round disc instead of a shield, a kite-shaped equipment shield with a center boss, a full wreath around the whole shield, ribbon tails, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

---
本批的出图/接线结果、重出记录（v2/v3）、回归测试见 [`tab-icon-art-prompts-batch7-log.md`](tab-icon-art-prompts-batch7-log.md)。
