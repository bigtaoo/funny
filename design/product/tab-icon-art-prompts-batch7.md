# 批次 7：剩余全部程序矢量图标 — Prompt 文档

> 创建：2026-08-25 · 判断+prompt 定稿：2026-08-25 · 出图+接线：**已完成 2026-08-25**（44 张全部落地）· 重出：v2 5 张过、1 张（`brush`）**改成 `skinIcon` 别名、已定案**（2026-08-26）· v3（另 4 条「可用但偏弱」）：**已出图并打包 2026-08-26**——`globe`/`armor`/`armorHeavy`/`scrap` 四张过，`atk` 打回；v4 也打回（读成直升机），**v5 改掉头接受竖长构图**
> 前六批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（试点/批次 2/3/4，19 张）· [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md)（页面标题+剩余页签，24 张）· [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)（大厅首页主视觉，3 张）
> 配套代码（接线后）：[`client/src/render/icons.ts`](../../client/src/render/icons.ts)（只剩两表分派，`DrawableIconKind`/`DRAW` 已删）· [`client/src/render/icons/inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts)（**本批落地处**：`InkIconKind` + `INK_ICON_ART` + `buildInkIcon` 运行时染色）· [`client/src/render/icons/tabIconRaster.ts`](../../client/src/render/icons/tabIconRaster.ts)（前六批的页签表，未改）· [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)
> 已删除的矢量画法：`client/src/render/icons/{equipment,ui,slg,motifs,titles,currency,primitives}.ts` 七个文件整体删除（`DRAW` 清零后全部变死代码）
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6
> 状态：**接线全部完成**（最终账：43 张自有美术 + 6 个别名 = 49 个 ink kind）；**剩下的只有 `atk` 一张**：v3 五张里 `globe`/`armor`/`armorHeavy`/`scrap` 已验收并打包上线，`atk` v3 读成锤子/铁砧、v4 读成直升机，源图一直是 v1；v5 已放弃「近正方」这条错误约束，prompt 见文末

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

## 出图与接线结果（2026-08-25 当日完成）

### 落地方式：第三条路（运行时染色），跟批次 6 的结论相反

批次 6 遇到「光栅墨色打包时烤死、调用点却按状态传色」这个问题时，选的是**不给 pack 加烤色、由调用点显式声明变体**——因为那四处的颜色在卡片边框/墨条/chip 边框上都有冗余承载。这 44 个不能照抄那条：`medal` 的金/银/铜**就是**排行榜第几名、`star` 的颜色**就是**卡池稀有度、称号墙的金色**就是**「已装备」、`check` 的绿**就是**成功、HUD 墨水瓶的蓝**就是**「我方的墨」。颜色是唯一载体，映射成 `tabIconVariant` 的预烤灰会静默抹平全部这些区分（而且编译器一句话都不会说）。

所以这批走第三条路：

- **pack 脚本每张只烤一张白色母版**（JOBS 行加 `inks: ['active']`，44 张 PNG 而不是 132 张）。
- **新增 `client/src/render/icons/inkIconRaster.ts`**：`InkIconKind`（49 个 = 43 自有 + 6 别名）+ `INK_ICON_ART`（kind → 白母版 url）+ `buildInkIcon(url, s, color)`，后者 `sprite.tint = color`——白 × tint 精确等于 tint，于是 `color` 恢复成「按字面用」，跟矢量时代的契约一模一样。这不是新发明：`render/titleArt.ts` 从一开始就这么给四枚永久称号的 PNG 染色；pack 脚本头部那条「烤色、别运行时染色」说的是**成品全彩图**（金币位图），那种图没有单一墨色可乘。
- `buildIcon` 先查 `TAB_ICON_RASTER`（页签表，`color` 是明暗提示）、落到 `INK_ICON_ART`（内容表，`color` 是字面墨色）。两表不许出现同名 kind——查表顺序会让 ink 那行被静默忽略、连带丢掉 tint，所以有测试专门盯这一条。

### 「纯复用」最终做成了美术别名，不是改字符串（5 处 + 后来的 `brush`）

原计划（下方判断表）是把 `swords`→`pvpTabIcon` 这类调用点字符串直接换掉。实际接线时发现**这 5 个里有 4 个的调用点在传有意义的颜色**：`StatsScene` 按胜/负给 `swords` 染绿/红、`AuctionScene` 给拍卖模式的 `tag` 徽标染红、`FriendsScene` 的邮件附件 `gift` 是金色、`BattlePassScene` 把奖励自身的颜色传给 `capsule`。换成页签 kind 就会走 `tabIconVariant`，这些颜色全部丢失。

改成：**这 5 个 kind 留在 `INK_ICON_ART` 里，但 url 指向被复用那张图已有的白母版**（`swords`→`pvp_active.png`、`home`→`home_active.png`、`capsule`→`gacha_active.png`、`gift`→`weekly_active.png`、`tag`→`auction_active.png`）。「同一个概念只画一次」这个去重结论照旧成立（不多出任何一张图），tint 保住，而且约 15 个调用点一行都不用改。别名清单在 `INK_ICON_ALIASES` 里导出，测试用它把「有自己美术的 44 个」和「别名的 5 个」两套契约分开检查。

顺带一条**没有改**的：`AuctionScene/itemLabels.ts` 的 `saleModeKind()` 拍卖档仍返回 `hammer`。新的 `hammer` 是平头锻造锤（prompt 明确避让 `bidTabIcon` 的拍卖槌），严格说不是槌——但矢量时代那里画的也是锤子，语义没有退步，而且这一屏里 `bidTabIcon` 只出现在别处，不并排。留作已知的小语义妥协，不为它单开一个 kind。

### 资产命名：base name 就是 kind name

跟页签表的 `fooTabIcon` ↔ `foo_active.png` 后缀转换不同，这一批**源图/产出图的 base 名与 `IconKind` 完全一致**，大小写都保留：`tabicon_armorHeavy.webp` → `armorHeavy_active.png` → kind `armorHeavy`。理由是让 `inkIconArt.test.ts` 能直接拿 `Object.keys(INK_ICON_ART)` 去磁盘上对账，不必再维护第二张「kind → 文件名」映射表（那张表就是最容易和现实漂移的东西）。

### 接线改动清单（实际做了什么）

1. `art/ui/tabicons/`：44 张源图按 `tabicon_<kind>.{webp,png}` 命名归位（40 张 webp + 4 张 png），`pack_tab_icons.cjs` 的 `JOBS` 加 44 行（全部 `inks: ['active']`），跑脚本产出 44 张 `<kind>_active.png`。
2. 新增 `client/src/render/icons/inkIconRaster.ts`（见上）。
3. `client/src/render/icons.ts` 瘦成纯分派：删掉 `DrawableIconKind`/`DRAW`/`getCachedDisplay` 那条路径，`IconKind = InkIconKind | RasterIconKind`；新增 `preloadIconArt()`（同时预热两张表）。
4. 删除 `client/src/render/icons/{motifs,equipment,slg,ui,titles,currency,primitives}.ts`。
5. `HUDView.ts`：`drawInk` 的最后一个调用点改走 `buildIcon('ink', 28, factionInk.friend)`。因为光栅图解码前画不出东西、而 HUD 一局只构建一次，墨水瓶单独放在一个持久 `Container` 里，`preloadInkIconTextures()` resolve 后只重填这一个 holder（不重建整个 HUD）。
6. **`preloadTabIconTextures` → `preloadIconArt` 的 6 个场景调用点**（`CardScene`/`EquipmentScene`/`FamilyScene`/`SectScene`/`LobbyScene/core`/`LoginScene` + `rewardIcon.ts`）。这条不是收拾干净而已：装备词条/UI 图钉/称号这些新图**不在**页签表里，还调旧函数的页面会只预热一半，另一半永久空白。`test/tabIconWarmupCallSites.test.ts` 的静态断言跟着改成新符号。
7. 测试：新增 `client/test/render/inkIconArt.test.ts`（磁盘/表两半对账）；`icons.test.ts` 的 `DRAW` 分派用例换成两表分派用例；`rewardIcon.test.ts` 的「别退回程序 glyph」交叉校验改成查 `INK_ICON_ART`；`tabIconContentVariant.test.ts` 的三墨色契约排除这 44 个 base（它们只有一张母版，且**必须**没有另外两张——那正是「被悄悄改回预烤灰」的形态）；删除 `test/ui/icons.ui.ts`（几何 smoke check，随 draw 函数一起没了）与 `test/render/iconArtPromptCoverage.test.ts`（它的存在意义就是在出图前盯住这份 backlog，已到期）。两个 HUD 测试（`hudHeartHpBar`/`hudSurrenderLabel`）的 pixi mock 补了 `MIPMAP_MODES`/`removeChildren`/`BaseTexture.from`——HUDView 现在会拉起 `render/cardArt` 那条图。`test/ui/resultSceneBuilderCallSites.ui.ts` 原本靠「同一 kind 两个尺寸的 glyph 宽度不同」反推参数，光栅图在无头环境下宽度恒为 0，改成读 title 的 y（同样由 `iconSize` 推出）。

### 28px 验收：40 张过、4 张待重出

在 28px（页签/词条实际尺寸）纸底+深底两种衬底上逐张看过 contact sheet，另外用 Playwright 实拍了称号墙（11 张一屏）、结算页、装备背包+强化弹窗三处真实界面。**4 张需要重出**（v2 prompt 见下方「重出 prompt（v2）」一节，重出时只换源图、重跑 pack 脚本，代码零改动）。**v2 已回来：其中 3 条（沙漏三档 / `lead` / `titleGrandmaster`）验收通过，`brush` 还要一版 v3——见该节末尾「v2 验收结果」。**

| kind | 问题 | 重出时要改的措辞 |
|---|---|---|
| `hourglassSm`/`Md`/`Lg` | 三档在 28px 上**几乎分不开**：沙量差异靠点状沙粒，缩小后全糊；且三张外框不一致（无立柱 / 细立柱 / 带旋钮粗立柱），破了「同一只沙漏、只有沙不同」的家族感 | 沙堆改成**实心大色块**而不是点阵，并明确要求三张外框逐笔相同（建议同一批请求里一次出三张，跟 P7 阶梯同样的做法） |
| `brush` | 笔锋在 28px 只剩一根竖棍，读成铅笔而不是毛笔 | 笔锋要**更宽更短、明显外扩**，与笔柄形成粗细对比；笔尖那滴墨可以去掉（28px 上本来就看不见） |
| `lead` | 画成了纯锥形，28px 上读成三角形，跟 `play` 的实心三角容易混 | 要求**保留一小段方形笔杆截面**或在锥体上加一道横向断口，让它读成「一截笔芯」而不是几何三角 |
| `titleGrandmaster` | 与 `titleMaster` 的差异只有一顶很小的皇冠，28px 上勉强 | 皇冠要**明显大一档**（但仍小于 `titleKing` 那顶）；这一档的原则「明显小于下一级」在 28px 上过头了 |

其余 40 张验收通过。次弱但可用、当时记录在案不重出的（**2026-08-26 改为重出：4 张已上线、`atk` 待 v4，见文末「重出 prompt（v3）」**）：`atk`（匕首细、迸溅线在 28px 消失）、`scrap`（撕边糊成一块纸）、`armor`/`armorHeavy`（28px 上都是「一个忙碌的圆」，只看得出后者更重）、`globe`（读成球而不是地球，但它只是 toast 兜底图）。

## 重出 prompt（v2，2026-08-25 当日）

上一节点名的 4 条（6 张图）的重出 prompt。**改的不是画风，只是导致返工的那一处措辞**——每条下面先写「v1 为什么塌」再给完整 prompt，重出时不要凭印象改别的地方。落地方式不变：存成 `art/ui/tabicons/tabicon_<kind>.{webp,png}`（**大小写照抄 kind 名**，会直接覆盖现有源图），重跑 `node art/ui/tabicons/pack_tab_icons.cjs`，代码零改动、测试不用碰。

### 沙漏三档（`tabicon_hourglassSm` / `Md` / `Lg`，3 张）

**v1 为什么塌**：①沙量用「几粒沙 + 几道下落线」表达，这是**点状细节**，缩到 28px 全部消失，三档看起来一样；②三张的外框各画各的（无立柱 / 细立柱 / 带旋钮的粗立柱），破了「同一只沙漏、只有沙不同」的家族感，反而让人以为是三个不同道具。

**v2 的两条硬约束**：①沙子改成**一整块实心黑色沙堆**，堆的**高度**就是唯一的档位信号——不画沙粒、不画点阵纹理、不画下落线、不画右侧加速刻度；②上半球**三档一律空的**（沙已流下去，物理上也说得通），外框措辞三张逐字相同、且明确不画立柱。**三张务必放在同一个请求/同一段对话里连续出**，靠「沿用上一张的构图，只改沙堆高度」保证外框一致——这跟 P7 阶梯是同一个理由。

**26 小档（`tabicon_hourglassSm`）**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a plain hourglass — one flat rectangular wooden cap across the top, one across the bottom, and between them two triangular glass bulbs meeting at a pinched narrow waist in the middle; no side posts, pillars or frame of any kind joining the caps. The lower bulb holds a small mound of sand drawn as ONE SOLID FILLED BLACK SHAPE resting on the bottom cap, filling only about the bottom fifth of the lower bulb. The upper bulb is completely empty. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the sand is a flat solid black area, everything else is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, individual sand grains, dotted or stippled sand texture, falling-sand streak lines, speed/tick marks beside the glass, side posts or a stand or legs, wings, sand in the upper bulb, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**27 中档（`tabicon_hourglassMd`）**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the SAME hourglass as the previous image, drawn the same way stroke for stroke — one flat rectangular wooden cap across the top, one across the bottom, two triangular glass bulbs meeting at a pinched narrow waist, no side posts, pillars or frame of any kind. The only difference is the amount of sand: the lower bulb is now a little over HALF filled with sand, drawn as ONE SOLID FILLED BLACK SHAPE resting on the bottom cap, its flat top edge sitting clearly above the halfway line of the lower bulb. The upper bulb is completely empty. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the sand is a flat solid black area, everything else is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, and the sand mass must read as unmistakably larger than a bottom-fifth version at that size. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing the hourglass outline or cap shapes in any way, individual sand grains, dotted or stippled sand texture, falling-sand streak lines, speed/tick marks beside the glass, side posts or a stand or legs, sand in the upper bulb, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**28 大档（`tabicon_hourglassLg`）**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the SAME hourglass as the previous two images, drawn the same way stroke for stroke — one flat rectangular wooden cap across the top, one across the bottom, two triangular glass bulbs meeting at a pinched narrow waist, no side posts, pillars or frame of any kind. The only difference is the amount of sand: the lower bulb is now almost entirely filled with sand, drawn as ONE SOLID FILLED BLACK SHAPE that reaches nearly up to the pinched waist, leaving only a thin sliver of empty glass. The upper bulb is completely empty. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the sand is a flat solid black area, everything else is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as unmistakably the fullest of a three-tier set at that size. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing the hourglass outline or cap shapes in any way, individual sand grains, dotted or stippled sand texture, falling-sand streak lines, speed/tick marks beside the glass, side posts or a stand or legs, sand spilling outside the glass, sand in the upper bulb, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 11 毛笔（`tabicon_brush`）

**v1 为什么塌**：笔锋只是「略微散开的尖」，本身就细，28px 一缩只剩一根竖棍，读成铅笔——而铅笔恰好是这套图里最挤的语义（`lead`/`pencils`/`duelTabIcon` 都在那一带）。笔尖那滴墨在 28px 上根本看不见，纯属噪点。

**v2 的改法**：笔锋改成**实心黑色的宽扇形**，明确要求「宽度是笔柄的两三倍」，形成「细杆 + 底部一大块黑」的强对比；墨滴删掉；金属箍留一道（它在 28px 上刚好还能当一个断点，把杆和锋分开）。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single upright calligraphy writing brush, held vertically: a thin plain round handle taking up the upper two thirds, one short metal ferrule band across it, and below that a broad fanned-out bristle tip filled in as ONE SOLID BLACK WEDGE — the bristle head must be two to three times WIDER than the handle and short rather than long, so the whole icon reads as a thin stick with a heavy dark brush head at the bottom. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the bristle head is a flat solid black area, the handle is bare line art, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels, where the wide dark bristle head is what separates it from a pencil. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a narrow or tightly-pointed bristle tip, thin separate hair strokes instead of one solid head, a bristle head no wider than the handle, an ink drop below the tip, a brush lying flat or held at an angle, a pencil-like sharpened cone, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 8 铅笔芯（`tabicon_lead`）

**v1 为什么塌**：v1 的避让把「完整铅笔」堵得太死（怕撞 `pencils`/`duelTabIcon`），结果模型交出一个**纯几何锥形**——28px 上就是个三角形，跟 `play` 的实心右向三角容易混，而且完全读不出「笔芯」。

**v2 的改法**：不再要求「只有笔芯、一点笔身都不许有」，改成画**一小截折断的笔尖**：削尖的锥体 + 底部一圈削出来的木质斜面 + 断口是毛糙的，锥尖填实。这样它有了「被削过、被折断」的具体特征，不再是几何三角；同时它仍然是「一小截」，不会跟整支交叉铅笔撞。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a short snapped-off pencil point standing upright, tip pointing up — the sharpened graphite cone at the top is filled in solid black, below it a short collar of pale shaved wood whittled into a few visible flat facets that flare out slightly wider than the cone, and the very bottom is a ragged, uneven snapped-off break line rather than a clean cut. It must read as a broken-off pencil tip, NOT as a plain geometric triangle or cone. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the graphite cone is a flat solid black area, the wooden collar is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, where the flared faceted wooden collar and the ragged base are what stop it reading as a triangle. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a plain smooth triangle or cone with nothing at its base, a solid triangle pointing left or right, an equilateral triangle, a whole full-length pencil with a long barrel, an eraser end, two pencils, a straight clean flat cut at the bottom, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 41 称号·宗师（`tabicon_titleGrandmaster`）

**v1 为什么塌**：v1 的措辞是「皇冠要明显小、比顶级那顶朴素」——本意是保住阶梯，结果在 28px 上小到看不出有皇冠，跟下一级 `titleMaster`（星+桂冠，无皇冠）分不开。**皇冠有无这件事本身要在 28px 上成立，才谈得上「比王者朴素」。**

**v2 的改法**：皇冠放大到「约星体宽度的三分之一、三个尖、冠带填实」，改由**另一条**特征跟 `titleKing` 拉开——王者有**背后的放射光线**且皇冠更高更繁复，宗师**一根光线都没有**。也就是说：跟下一级比「有没有光线」，跟上一级比「有没有皇冠」，两个方向各由一个 28px 上立得住的特征承担。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the eighth rank in a nine-step medal progression — a five-pointed star medal hanging below two short ribbon tails, with a small sprig of laurel leaves (three or four simple leaf shapes on a thin stem) wrapped around one side of the star, and a plain three-pointed crown sitting on top of the star. The crown must be clearly visible at small sizes: roughly one third as wide as the star itself, with three distinct points and a filled-in solid band across its base — noticeably present, but plain and squat rather than tall or ornate. There are NO light rays anywhere behind or around the medal. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading. Must stay clearly recognizable when scaled down to 28x28 pixels, where the presence of the crown is what separates it from the same star-and-laurel medal without one. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a tiny crown that disappears at small sizes, a tall ornate crown, a cross or orb on top of the crown, radiating light rays or a burst behind the medal, a full wreath wrapping all the way around, a shield shape instead of a star, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### v2 验收结果（2026-08-25 晚）：5 张过，`brush` 还差一版

v1 的源图按约定移进了 `art/ui/tabicons/_rejected/`（`tabicon_<kind>_v1_<原因>.<ext>`，与 `material`/`recharge`/`social` 那三张同一命名）。

| kind | 结论 | 说明 |
|---|---|---|
| `hourglassSm`/`Md`/`Lg` | **过** | 实心沙堆这一招成立：28px 上三档一眼分得开（细条 / 半满 / 满到收口），外框三张一致。这一条从「三档看起来一样」到「一眼分开」，改的只有"沙子别用点阵"这一句 |
| `lead` | **过** | 实心锥 + 外张的木质切面 + 毛糙断口，28px 上是明确的「削尖的笔尖」，跟 `play` 的实心三角并排毫无歧义 |
| `titleGrandmaster` | **过** | 皇冠在 28px 上是一条带尖的实心暗带，跟 `titleMaster`（无皇冠）、`titleKing`（更高更繁复 + 放射光线）三张并排都拉得开。**残留小瑕疵**（不重出）：它的绶带比 `titleMaster` 短一截、星体在画框里偏大，家族里的比例不算完全统一——但区分度由皇冠承担，够用 |
| `brush` | **不再出图，改成 `skinIcon` 别名** | v2 的笔锋照要求做成了实心宽楔形、也确实比笔柄宽两三倍——但整张图长宽比 27:128（1:4.74），见下；v3 把构图收成近正方形（108:128）解决了存在感，却读成钟形/蘑菇。第四轮之前先回头看了一眼**这个图标该不该是画笔**，答案是不该——见下 |

**`brush` 暴露的是一条通用陷阱，值得单独记一笔**：`pack_tab_icons.cjs` 会先把源图裁到内容边界，再让**长边**等于 `LONG_EDGE`；运行时 `buildInkIcon`/`buildRasterTabIcon` 又是 contain-fit 进一个**正方形**盒子。所以**一张细长的图在 28px 格子里只占宽度的一小半**——1:4.74 的 brush 实际只画到约 6px 宽，剩下 22px 是空白，缩下去就是一根头发丝加一个小黑点，比 v1 更没存在感。**prompt 里写「笔锋比笔柄宽两三倍」是不够的**：那只约束了图内两个部件的相对比例，没约束整张图的外轮廓比例，模型完全可以画一根又细又长的杆来满足它。

实测全套 44 张的长宽比，brush 的 4.74 是**唯一的离群值**（第二名 `weapon` 3.28 是一把竖立的剑、已上线可接受，`atk` 2.33、`atkspd` 2.13、`flag` 2.10 都在可用区间）。**结论：新图的外轮廓长宽比尽量不超过 2:1**；确实必须细长的（竖剑、旗杆）要有意识地知道自己在放弃一半画框。

**`brush` v3 prompt**（只改一件事：把手柄砍成短柄、并显式约束整张图接近正方形）：

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the business end of a calligraphy writing brush, seen upright and CLOSE UP: a broad fanned-out bristle head filling the lower half of the picture, drawn as ONE SOLID BLACK WEDGE, above it one short metal ferrule band, and above that only a SHORT STUB of the plain round handle — the handle is cut off by the top edge of the picture rather than drawn in full. COMPOSITION IS CRITICAL: the whole drawing must roughly fill a SQUARE — its total height must be no more than about 1.5 times its total width — so the bristle head is big and dominant instead of a thin stick in a tall frame. The bristle head should be about as wide as half the picture. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the bristle head is a flat solid black area, the handle stub is bare line art, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels, where the wide dark bristle head is what separates it from a pencil. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a tall narrow composition, a long thin handle running the height of the picture, the whole brush drawn end to end, a narrow or tightly-pointed bristle tip, thin separate hair strokes instead of one solid head, an ink drop below the tip, a brush lying flat or held at an angle, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

本轮 5 张已打包接线（`brush` 暂时留 v2，比 v1 的细线稿仍强一档），`tsc --noEmit` + 图标契约测试全绿。

### `brush` 收在了别名上，不是第四张图（2026-08-26）

v3（近正方形构图，`_rejected/tabicon_brush_v3_bellshape.webp`）解决了 v2 的存在感问题——28px 上终于有真正的墨量——但笔锋是向下**外扩并收成圆底**，读成钟形/蘑菇/吸盘；毛笔应该在金属箍处最宽、往下**收窄**成散开的笔尖。本来要出 v4 改这一条，改之前回头看了一眼更上游的问题：**这个图标该不该是一支画笔。**

答案是不该。`art-direction-map-ui.md` 记着当年定 `skinIcon`（戏剧面具）的原话：

> 皮肤则是"文具/画笔"这条思路本身跟装备材料图标（也是文具）语义撞车，改走"戏剧面具"完全跳出文具语言才定案。

也就是说**项目早就判定「画笔」不适合表达皮肤**——而 `brush` 至今是 6 处皮肤内容徽标（`AuctionScene` 的 `itemKind('skin')`、`CardScene` 皮肤格、`GachaScene` 稀有度点、`ShopScene` 皮肤商品、`CardScene/detail` 徽标、拍卖上架选择器），等于把当年特意绕开的撞车又搬了回来。更直接的证据：这两张图**同屏出现**（拍卖选择器里皮肤筛选片是面具、行内徽标是画笔；卡牌皮肤页标题是面具、格子是画笔），同一个概念两套画法。

所以 `brush` 不再有自己的美术，改成 **`skinIcon` 的别名**（第 6 个别名，与 `swords`/`home`/`capsule`/`gift`/`tag` 同一手法：`INK_ICON_ART` 里保留 kind、url 指向 `skin_active.png`）。6 个调用点一行不改，`GachaScene` 按稀有度染色照旧生效，零新资产。**批次 7 的最终账：43 张自有美术 + 6 个别名 = 49 个 ink kind**（原计划 44 + 5）。

**2026-08-26 用户拍板：皮肤就是面具，不再出画笔版本。** 本文上一节那段 v3 prompt、以及 `_rejected/tabicon_brush_v{1,2,3}_*.webp` 三张落选稿，从此只作归档读（里面的“笔锋应当在金属箍处最宽、往下收窄”那句 v4 措辞不会再用上），不是待办项。

这一格的教训不在画笔本身，而在**返工到第三轮时该往上一层看**：v1→v2→v3 每一轮都在修「这支画笔画得对不对」，而真正的问题是「这里不该是画笔」——这个判断三个月前就做过一次，只是没有落到这 6 个调用点上。

### 重出后的验收口径

跟本轮一样：打包后在 **28px** 纸底+深底两种衬底上看 contact sheet，沙漏三档必须**并排**看（单看一张永远觉得没问题，这正是 v1 过关的原因）；`lead` 要跟 `play` 并排，`brush` 要跟 `lead`/`pencils` 并排，`titleGrandmaster` 要跟 `titleMaster`/`titleKing` 三张并排。

## 回归测试

出图前这份文档的回归测试是 `client/test/render/iconArtPromptCoverage.test.ts`——断言 `DRAW` 表里每个还活着的矢量 kind 都在本文档里有交代，防止有人改 `DRAW` 却忘了同步这份 backlog（清单本身腐烂比没有清单更危险）。**接线完成后它已按原计划整份删除**：`DRAW` 表不存在了，backlog 也清空了，它守的东西两头都没了。

接手它的是 `client/test/render/inkIconArt.test.ts`，守的是不一样的东西——不再是「文档别腐烂」，而是「表和磁盘别漂移」：

- 磁盘一半：44 个有自己美术的 kind 各有且仅有一张 `<kind>_active.png`，且**没有** `_inactive`/`_content`/`_accent`（多烤出来那两张正是「被悄悄改回预烤灰、丢掉全部 tint」的形态）；每个 kind 有且仅有一张 `tabicon_<kind>.*` 源图（落选稿按约定进 `_rejected/`）。
- 表一半：`INK_ICON_ART` 覆盖 49 个 kind；与 `TAB_ICON_RASTER` 无同名 kind（`buildIcon` 先查页签表，同名会让 ink 行被静默忽略）；5 个别名各自指向被复用那张图的 `active` url。

vitest 下所有 `.png` import 会塌成同一个 data URI，所以 url 身份只在磁盘一半有意义、key 存在性只在表一半有意义——两半互相盖不住，跟 `tabIconContentVariant.test.ts` 同样的拆法、同样的理由。

批次 7 收尾又补了两条（细节见 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md) 末节）：

- `client/test/render/buildIconDispatch.test.ts`——mock 掉两个子模块，钉住**分派方向**：ink kind 的 `color` 必须原封不动传下去，页签 kind 必须传变体 url 且不能把颜色带过去。上面两份测试都不管这个方向，而"把某个 kind 挪错表"正是会让所有 tint 静默塌成灰的那种改动。顺带钉 `preloadIconArt()` 真的预热两张表。
- `client/test/render/iconArtAspect.test.ts`——长短边比 > 2.2 就红（白名单 `weapon`/`event`/`atk` + 理由）。这条是 `brush` v2 那一轮的直接产物：27×128 的图在正方形格子里只占约 6px 宽，而它满足 prompt 的每个字。

**没加的那一条也记在案**：沙漏三档的"墨量逐档递增"断言抓不到 v1 的点阵沙问题（v1 的增幅 ×1.78/×1.71 反而比 v2 的 ×1.25/×1.12 大），只会放行坏的那套。给美术加守卫前先拿被打回的那版跑一遍，跑不红就别留。

## 重出 prompt（v3，2026-08-26）：记录在案的那 4 条弱图

「28px 验收」那一节末尾点名了 4 条**次弱但可用、当时决定不重出**的图：`atk`、`scrap`、`armor`/`armorHeavy`、`globe`（5 张）。本节给它们的重出 prompt。

四条塌的是**同一件事**，跟沙漏 v1 一模一样：**28px 上活下来的是实心块，死掉的是细节**。`atk` 的迸溅线、`scrap` 的细锯齿、`armor` 家族的小铆钉环、`globe` 的两条内线——全是高频线条，缩到 28px 就平均成一片灰。所以四条 v3 的改法都是同一句：**把区分度从「线」搬到「块」**，另外顺手把 `atk` 的外轮廓从 2.33:1 压回近正方（那条已经写进 `iconArtAspect.test.ts` 的白名单，见下）。

落地方式跟前两轮一样：存成 `art/ui/tabicons/tabicon_<kind>.{webp,png}`（大小写照抄 kind 名，直接覆盖现有源图），旧图按约定移进 `_rejected/`（`tabicon_<kind>_v1_<原因>.<ext>`），重跑 `node art/ui/tabicons/pack_tab_icons.cjs`。

**唯一的代码改动在 `atk`**：`client/test/render/iconArtAspect.test.ts` 的 `ELONGATED_ON_PURPOSE` 白名单里有 `atk`（2.33:1，理由写的就是「已记录为批次 7 较弱的一张」）。v3 明确要求近正方构图，一旦重出成功，那条豁免就成了陈旧项——`lists nothing in ELONGATED_ON_PURPOSE that no longer needs the exemption` 会红。**重出 `atk` 时必须同时把 `atk` 连同它那行注释从白名单里删掉**（这正是那条测试存在的意义：豁免必须是被论证过的，不是历史遗留）。其余 4 张不碰代码、不碰测试。

### 1 攻击（`tabicon_atk`）

**v1 为什么弱**：三处叠加。①刀身是**空心线稿**且很窄，中间还有一道血槽线，28px 上整把刀只剩两条快要并到一起的细线；②五道迸溅线又细又短、而且**离刀尖有一段距离**，缩小后先于刀身消失，「打击力」这层意思整个没了；③整张图 2.33:1，在正方形格子里只画到一半宽度（跟 `brush` v2 同一个陷阱，只是没那么极端）。

**v3 的改法**：刀身**填实**并加宽（宽度约为高度的三分之一）；迸溅线砍到三道、加粗、**起点几乎贴着刀尖**；靠「短刀身 + 宽护手」把整图压成近正方，而不是把刀整体缩小。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a short, broad dagger pointing straight up. The blade is a wide leaf shape filled in as ONE SOLID BLACK MASS, roughly a third as wide as it is tall, with no fuller groove or any line drawn inside it. Below the blade sits one straight crossguard bar that is clearly WIDER than the blade, and below that a short stubby plain handle. Three short THICK spark strokes fan out from the very tip of the blade, each one starting so close to the point that it almost touches it. COMPOSITION IS CRITICAL: the whole drawing must roughly fill a SQUARE — its total height must be no more than about 1.3 times its total width — and this must be achieved by keeping the blade SHORT and the crossguard WIDE, not by shrinking the whole dagger. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the blade is a flat solid black area, the guard and handle are bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, where the heavy black blade and the three thick sparks at its point are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a tall narrow composition, a long slender blade, a hollow outlined blade, a fuller or blood groove line down the blade, thin hairline spark strokes, sparks floating in empty space away from the tip, more than four sparks, a long two-handed sword, an ornate pommel, two crossed blades, a shield or crest behind it, a hand gripping it, wrapping or binding lines on the handle, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 旧纸片（`tabicon_scrap`）

**v1 为什么弱**：四条边**全部**是高频细锯齿——28px 上一平均就还原成一条直边，于是整张图退化成「一个方框」；而内部只有两条发丝格线，墨量几乎为零，什么都撑不住。**「撕」这件事必须由低频的大缺口承担，不能由锯齿的密度承担。**

**v3 的改法**：撕口**只留一条边**（底边），另外三边干净笔直；撕口画成 **4-5 个大缺口**，每个约整宽的十分之一深，而不是细锯齿；纸片整体略微倾斜（约 10°），跟界面里的方卡片拉开；两条格线加粗、横贯整页，并且下面那条**被撕口切断**——这一下让「撕」有了因果，不只是边缘装饰。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a single torn-off piece of ruled notebook paper, roughly square, tilted about 10 degrees off upright. Three of its edges are CLEAN and STRAIGHT; only the BOTTOM edge is torn, and that tear is drawn as four or five LARGE deep notches — each notch about a tenth of the paper's width across and clearly visible on its own — not as fine sawtooth serration. Two BOLD ruled lines run horizontally right across the sheet from one side edge to the other, and the lower of the two is interrupted part-way along by one of the tear's notches. Single object, centered, filling the frame, on a plain pure-white background, no grid lines beyond the two bold ruled lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels, where the few big notches along the bottom are what say "torn". Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, fine sawtooth or hair-thin serration, ragged edges on all four sides, many small notches, a neat untilted rectangle with four straight edges, hairline faint ruled lines, more than two ruled lines, a folded or curled corner, a spiral binding, crumple or fold creases, a rolled scroll, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 3 护甲 + 护甲·加固档（`tabicon_armor` / `tabicon_armorHeavy`，2 张）

**v1 为什么弱**：两张都是「一个忙碌的圆」——双层同心细圆环 + 一圈**小空心铆钉环** + 一条细横带，全是高频细节，28px 上一律糊成灰圈；而两档的差异（多一圈外环、铆钉加倍）**恰好也全在那些高频细节上**，所以只看得出后者更重一点点，看不出重在哪。另外两张现在都读成车轮/宝可梦球，还跟 `coin`（粗双环）在同一个「细环圆」形态区里挤着。

**v3 的改法**：两件事分开做。①**身份**改由填充承担——圆盘用一竖一横切成四等份，**左上和右下两格填实黑**（纹章式四分），中心压一个实心黑盾钉，其余留白；这个黑白相间的圆在 28px 上跟 `coin` 的空心环、`globe` 的球一眼分得开，而且它仍然是圆盾、没有碰 `equipIcon` 的鸢形和 `armorslotTabIcon` 的胸甲。②**档位**改由一块低频墨承担——加固档在**外沿加一圈粗实心黑边**，别的一笔不改。小铆钉环全部删掉。

**两张务必放在同一个请求/同一段对话里连续出**（跟沙漏三档同一个理由：家族感靠「沿用上一张、只改一处」保证，而不是靠两次独立请求碰巧一致）。

**护甲（`tabicon_armor`）**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a small round buckler shield seen face-on — one plain circle. The face inside the circle is split into four quarters by one vertical and one horizontal line through the centre; the UPPER-LEFT and LOWER-RIGHT quarters are filled in as SOLID BLACK areas, and the other two quarters are left plain white. Over the centre, where the two dividing lines cross, sits one solid black round boss about a quarter as wide as the whole shield. Nothing else is drawn on the shield at all — no rivets, no second ring, no rim band, no hatching. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the two quarters and the boss are flat solid black areas, everything else is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, where the black-and-white quartered face is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, small open rivet circles around the rim, a second concentric ring inside the rim, a thick band around the rim, an all-white unfilled face, filling all four quarters, a plain double-ring coin, a wheel with spokes, a ball split by a single horizontal line, a kite-shaped or teardrop shield, a pointed bottom, a breastplate or torso-armor shape, a sword or crossed swords behind it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**护甲·加固档（`tabicon_armorHeavy`）**
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the SAME quartered round buckler shield as the previous image, drawn the same way stroke for stroke — the same circle, the same four quarters with the upper-left and lower-right filled solid black and the other two left white, the same solid black round boss at the centre. The ONE difference: a BROAD SOLID BLACK BAND now runs all the way around the rim of the circle, about a tenth of the shield's width thick, so the shield reads as edged with heavy metal and is visibly darker and heavier overall than the plain version. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the rim band, the two quarters and the boss are flat solid black areas, everything else is bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, and must read as unmistakably the heavier of the two at that size. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, changing the circle, the quarter fills or the centre boss in any way, filling the two white quarters as well, a thin outline ring instead of a broad filled band, a second ring separated by a white gap, small open rivet circles, spikes sticking outward, a kite-shaped or teardrop shield, a breastplate shape, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 4 地球（`tabicon_globe`）

**v1 为什么弱**：圆 + 一条竖线 + 一条横线，28px 上就是个十字准星或一只球——图里**没有任何一处说明它是地球**。而 v1 的 Avoid 里那句 `continents or landmasses drawn on it` 恰好把唯一能救它的东西给禁掉了：当时怕海岸线太碎，结果连低频的大墨块一起挡在了门外。

**v3 的改法**：把大陆放回来，但按沙漏那条规矩画——**2-3 块实心黑色大墨团**，合计约占圆面的三分之一，且**至少有一块要顶到圆边、被圆切断**（这一条是关键：贴边被切才读成球面上的陆地，浮在中间就只是几个墨点）；赤道留一条弯的，经线删掉；海岸线不要细节，就是软边大块。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a simple globe — one plain circle outline, with two or three big rounded landmass shapes filled in as SOLID BLACK MASSES sitting on the sphere, and one gently curved horizontal equator line crossing behind and between them. The landmasses must be large soft blobs with smooth simple outlines, together covering roughly a third of the circle, and AT LEAST ONE of them must run right up to the edge of the circle and be cut off by it, so they read as continents wrapping a sphere rather than as spots floating inside a ring. There is no vertical meridian line. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the landmasses are flat solid black areas, the circle and the equator are bare line art. Must stay clearly recognizable when scaled down to 28x28 pixels, where the solid black landmasses are the only thing that says "earth" rather than "ball". Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a vertical meridian line, straight lines crossing the circle like a crosshair, an empty circle with nothing drawn on it, detailed or recognisable real-world coastlines, many small scattered islands or dots, a latitude and longitude grid, a stand or axis through it, a flat unfolded paper map, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### v3 的验收口径

跟前两轮同口径，逐条指定并排对象：`atk` 跟 `weapon`（竖剑）、`hp`、`spd` 一行并排看装备词条行；`scrap` 跟 `cards`/`book` 并排（都是纸）；`armor` 与 `armorHeavy` **必须并排**，另外各自跟 `coin`、`globe` 并排一次（这一轮它们要解决的正是「细环圆」的形态撞车）；`globe` 单看即可（它只是 toast 兜底图）。此外重出 `atk` 后先跑 `npm test -- iconArtAspect`：白名单没删干净会红，删对了那条测试自己会说话；`armorHeavy/armor` 的墨量比也由同一份测试兜着（下限 1.15，v3 的粗黑边预计在 1.3 以上）。

### v3 出图结果（2026-08-26）：4 条过、`atk` 打回

五张图当天出回来，按 v3 验收口径在 28px 纸底 + 深底两套衬底上并排看过（生成脚本走的是真实链路：`pack_tab_icons.cjs` 出白色母版 → 染色 → contain-fit 进 28×28 → 最近邻放大观察）。

| kind | 结论 | 说明 |
|---|---|---|
| `globe` | **过（提升最大的一张）** | 三块实心大陆、其中两块顶到圆边被切断，28px 上是毫无歧义的地球，不再是十字准星球。**「把被禁的东西放回来」才是这条的解法**——v1 那句 `no continents or landmasses` 挡掉的不是碎海岸线，是唯一能说明它是地球的东西 |
| `armor` / `armorHeavy` | **过** | 纹章式四分圆成立：两张一眼分得开（加固档的粗黑外沿把白扇区压小了一圈），跟 `coin` 的空心环、`equip` 的鸢形盾、`armorslot` 的胸甲三张并排都没有歧义，「忙碌的圆」问题解决。**残留**：它更像纹章/饼图而不是「护甲」，语义靠词条文字承担；这是拿「28px 分得开 + 不撞车」换来的，接受 |
| `scrap` | **过（偏弱）** | 大缺口这一招成立，28px 上读得出「撕下来的纸」，比 v1 那个纯方框强一档。**残留两点**：①墨量仍是全套最低的一档（28px 实测 162，`globe` 363、`armor` 379），整张几乎全是线稿；②底边的大齿跟 `castle` 的城垛是上下镜像关系，两者不同屏，暂不处理 |
| `atk` | **打回，源图退回 v1** | 见下 |

**`atk` v3 为什么打回**：模型用**把护手撑成一个巨大空心长方形**的办法去满足「近正方」，同时刀身缩成一个小黑块——28px 上整张图是「一根短柄插在一条横杠上」，跟 `hammer`（锤子）、`craft`（铁砧）并排看是同一个「工具压在横条上」的家族，读不出匕首。**v3 比 v1 更糟**（v1 至少还是把刀），所以源图退回 v1（`_rejected/tabicon_atk_v3_hollowbarreadsashammer.webp`），`ELONGATED_ON_PURPOSE` 里的 `atk` 那行**保持不动**，等 v4。

这条的教训是**约束的代价会落在没被约束的那个部件上**：v3 只写了「护手要比刀身宽」和「整图近正方」，没写护手**不许是画面里最大的形状**，于是模型拿最省事的一条路满足了两句话。跟 `brush` v2「笔锋比笔柄宽两三倍却画成一根细长杆」是同一个形状的错误——**局部比例约束不构成整体构图约束**。

**`atk` v4 prompt**（只改一件事：宽度预算从护手挪到迸溅扇形）：

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a dagger pointing straight up. THE BLADE IS THE DOMINANT SHAPE: a leaf-shaped blade filled in as ONE SOLID BLACK MASS, coming to a clear point at the top, and taking up about three fifths of the icon's whole height on its own — nothing else in the picture may be bigger than it. Directly beneath the blade sits a SHORT crossguard drawn as one small SOLID BLACK BAR, only about one and a half times as wide as the blade and quite thin — it is a minor detail, not a platform. Below that, a short stubby plain handle. Three thick spark strokes spring from the blade's point and FAN OUT WIDE — one to the upper left, one straight up, one to the upper right — and it is this wide spark fan, NOT a wide crossguard, that makes the drawing roughly as wide as it is tall. COMPOSITION: total height no more than about 1.4 times total width. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the blade and the crossguard are flat solid black areas, the handle is bare line art. Must stay clearly recognizable as a DAGGER when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a hollow open rectangle as the crossguard, a crossguard wider than half the picture, a crossguard that is the largest shape in the picture, a short stubby blade, a blade shorter than the crossguard is wide, a T-shaped or cross-shaped silhouette, anything that reads as a hammer, mallet, anvil, rubber stamp or a tool resting on a bar, a tall narrow composition, a long slender blade, a hollow outlined blade, a fuller or blood groove line, thin hairline sparks, sparks floating away from the tip, more than four sparks, a long two-handed sword, an ornate pommel, two crossed blades, a shield behind it, a hand gripping it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**顺带记一条测试口径**：`iconArtAspect.test.ts` 的 `armorHeavy/armor` 墨量下限是 1.15，v1 实测 1.48、v3 实测 **1.21**——比值反而降了，因为 v3 的**基础档**本身就重了一倍多（28px 墨量 164 → 379）。也就是说这个比值同时受两档影响，**它是防「加固档不再更重」的地板，不是「区分度」的度量**（跟沙漏那条同一个道理，见本文档「没加的那一条也记在案」）。v3 的两档在 28px 上并排一眼分得开，比值 1.21 不是问题；但下次再调 `armor` 时要知道离地板只剩 0.06。

### `atk` v4 也不行 —— 第三轮了，问题在上一层（2026-08-26）

v4 把 v3 的错处全改对了：护手确实缩成了一根小实心横条、不再是画面里最大的形状，刀身也是实心的。但**宽度这次由迸溅线承担**——两道侧线被画得又长又向下后掠，并且跟刀尖连成一体，于是 28px 上是一架**直升机**（旋翼 + 机身 + 起落架），远看也像蜻蜓/蚊子。刀尖因为跟迸溅线交汇，反而没有可见的尖了。源图进 `_rejected/tabicon_atk_v4_sparksreadashelicopter.webp`，`atk` 仍留 v1。

两轮连起来看，因果就很清楚了：

| 轮次 | 「近正方」这条约束由谁满足 | 结果读成 |
|---|---|---|
| v3 | 护手撑成巨大空心横杠 | 锤子 / 铁砧 |
| v4 | 迸溅线拉长、外张、后掠 | 直升机 / 昆虫 |

**匕首天生是竖长物体。要把它撑成正方形，只能在两侧焊一个宽部件——焊在哪儿，它就变成以那个部件为主体的另一样东西。** 所以 v3/v4 不是两次失手，是同一条错误约束的两个必然出口。

按本文档自己那条规矩（**返工到第三轮要往上一层看**，`brush` 那一节），上一层的问题是：**这个图标需不需要近正方？** 不需要。`iconArtAspect.test.ts` 的 `ELONGATED_ON_PURPOSE` 白名单存在的意义就是「主题天生就长，压扁比浪费画框更糟」——`weapon`（3.28:1，一把竖剑）已上线且没人有意见，`atk`（2.33:1）本来就在名单里。**当初把「近正方」写进 v3 prompt 是把一条工程约束（别浪费格子）当成了美术目标，代价是丢掉了主体本身。**

于是 v5 放弃正方，回到竖长匕首，**只修 v1 那两处真正的缺陷**——空心细刀身 → 实心宽刀身；迸溅线又细又离尖远 → 短、粗、起点贴着刀尖——构图一个字不改。`atk` 因此**永久留在** `ELONGATED_ON_PURPOSE`，那一行的理由已改写成这段经过。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an upright dagger pointing straight up, drawn TALLER THAN IT IS WIDE — roughly twice as tall as it is wide, the natural proportions of a dagger. Do NOT try to make the picture square. The blade is a broad leaf shape filled in as ONE SOLID BLACK MASS, about a quarter as wide as it is long, coming to a clear sharp point at the very top with clear empty white space around that point. Beneath the blade sits one small crossguard drawn as a short SOLID BLACK BAR, about one and a half times the blade's width. Below that, a short plain handle. Three SHORT thick spark strokes sit just above the point — one straight up, one to the upper left, one to the upper right — each no longer than a quarter of the blade's length, each starting almost touching the point and radiating OUTWARD AND UPWARD, each clearly separate from the blade and from the other two. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the blade and the crossguard are flat solid black areas, the handle is bare line art. Must stay clearly recognizable as a DAGGER when scaled down to 28x28 pixels, where the heavy black blade is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, long sparks, sparks that sweep backwards or droop downwards like wings or rotor blades, sparks that merge into each other or into the blade's outline, a blade with no visible point, anything that reads as a helicopter, insect, dragonfly or mosquito, a crossguard wider than the blade is long, a crossguard that is the largest shape in the picture, a T-shaped silhouette, anything that reads as a hammer, mallet, anvil, rubber stamp or a tool resting on a bar, a squat or square composition, a hollow outlined blade, a fuller or blood groove line, a needle-thin blade, a long two-handed sword, an ornate pommel, two crossed blades, a shield behind it, a hand gripping it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**这一格的教训，跟 `brush` 那一格是同一条但方向相反**：`brush` 是「三轮之后发现主体选错了」，`atk` 是「三轮之后发现**约束**选错了」。共同点是——第三轮该问的不是「这张画得对不对」，而是「我给它的题目对不对」。
