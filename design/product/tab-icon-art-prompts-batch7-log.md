# 批次 7：出图/接线/重出记录（spec 见 [`tab-icon-art-prompts-batch7.md`](tab-icon-art-prompts-batch7.md)）

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

### `atk` v5：造型终于对了，比例是我自己的 prompt 算出来的 —— 顺带补上了守卫的漏洞（2026-08-26）

v5 把**造型**全部做对了：实心宽刀身、清晰的刀尖、护手是一根小实心横条、三道迸溅线又短又粗又贴尖、彼此分离。28px 上它确实读成匕首，v1 的两处缺陷都不在了。

**问题出在比例：28×128 = 4.57:1。** 这是 `brush` v2（27×128，4.74:1）的翻版——在 28px 格子里只画到约 6px 宽，剩下 22px 空白。放进词条行里就是一道竖着的细黑条，跟旁边的 `weapon`/`hammer` 完全不在一个体量上。源图进 `_rejected/tabicon_atk_v5_sliver28x128.webp`。

**这一次的责任在 prompt 的算术，不在模型。** v5 prompt 里写着：

- 刀身「约为自身长度的四分之一宽」→ 刀身本身就是 1:4
- 护手「约为刀身宽度的一倍半」→ 整图最宽处 = 1.5 × 刀身宽 = 0.375 × 刀身长
- 于是整图 ≈ 刀身长 × 1.4（含护手+柄+迸溅）÷ (0.375 × 刀身长) ≈ **3.7:1**

**模型照做了，结果就是我算出来的那个数。** 我在 v5 里删掉「近正方」是对的（那条约束确实制造了锤子和直升机），但删掉之后**没有换上任何宽度纪律**，反而写进了一组本身就通向细长的数字。三轮的账：v3/v4 是**约束选错**，v5 是**约束删对了、但替换它的数字没算**。

**顺带暴露了守卫的一个真漏洞，已修。** 上一轮我把 `atk` 写进 `ELONGATED_ON_PURPOSE` 时给的是**无条件豁免**——于是 4.57:1 的 v5 会被 `iconArtAspect.test.ts` **静默放行**，而且偏偏是「因为它被允许长，所以没人再量它」这条因果。这正是这份测试当初为 `brush` v2 存在的那个失败。改法：白名单从 `Set` 改成 `Map<base, 该 kind 自己的上限>`（`weapon` 3.6 / `event` 3.0 / `atk` 2.5），豁免不再是「关掉门禁」而是「把门槛抬到论证过的高度」。两条附带发现：

- 上限要按**长宽比最大的那个变体**定，不是 `active`：未加粗的墨色跳过 `dilateAlpha` 的膨胀，所以 `weapon` 是 active 3.28、content/inactive **3.46**。第一版上限 3.4 当场被这两张打红——测试自己抓到了我。
- 按本文档「给美术加守卫前先拿被打回的那版跑一遍」那条规矩，新上限拿 v5 实跑过：`atk_active.png 28x128 = 4.57:1 (limit 2.5)` 变红，确认这道门禁真的关得住它，而不是只写得好看。

**`atk` v6 prompt**（造型措辞一字不改，只重算三个数，并给出双边界）：

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an upright dagger pointing straight up — a SHORT, BROAD, STUBBY dagger, not a slender one. The blade is a broad leaf shape filled in as ONE SOLID BLACK MASS, about HALF as wide as it is long, coming to a clear sharp point at the very top with clear empty white space around that point. Beneath the blade sits one crossguard drawn as a short SOLID BLACK BAR, about TWICE the blade's width. Below that, a short plain handle no longer than a third of the blade. Three SHORT thick spark strokes sit just above the point — one straight up, one to the upper left, one to the upper right — each no longer than a quarter of the blade's length, each starting almost touching the point and radiating OUTWARD AND UPWARD, each clearly separate from the blade and from the other two. PROPORTION CHECK, and this is a hard requirement: measure the whole drawing's bounding box — its total height must be between about 1.8 and 2.3 times its total width, and must NEVER exceed 2.4 times. It is a tall icon, but it is not a sliver: if the drawing is more than twice and a half as tall as it is wide, the blade is too narrow and must be redrawn broader. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the blade and the crossguard are flat solid black areas, the handle is bare line art. Must stay clearly recognizable as a DAGGER when scaled down to 28x28 pixels, where the heavy black blade is what reads. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a narrow needle-thin or spike-like blade, a blade more than three times as long as it is wide, a very tall thin composition, a total height more than 2.4 times the total width, long sparks, sparks that sweep backwards or droop downwards like wings or rotor blades, sparks that merge into each other or into the blade's outline, a blade with no visible point, anything that reads as a helicopter, insect, dragonfly or mosquito, a crossguard that is the largest shape in the picture, a T-shaped silhouette, anything that reads as a hammer, mallet, anvil, rubber stamp or a tool resting on a bar, a squat or square composition, a hollow outlined blade, a fuller or blood groove line, a long two-handed sword, an ornate pommel, two crossed blades, a shield behind it, a hand gripping it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

**三轮下来，`atk` 这一格真正的教训**：这套 prompt 里凡是写成「A 是 B 的 N 倍」的句子，都要**先把整图的长宽比乘出来再写进去**。`brush` v2、`atk` v3/v4/v5 四次返工全是同一件事的不同面——局部比例约束会算出一个整体比例，模型交付的就是那个算出来的数，而不是你脑子里的那张图。

### `atk` v6 过了，批次 7 收工（2026-08-26）

v6 一版过：实心宽刀身（约为自身长度的一半宽）、清晰刀尖、护手是刀身两倍宽的实心横条、短柄带一个环形柄头、三道短粗迸溅线分立在尖上方。**打包实测 64×128 = 2.00:1**——v5 是 4.57、v1 是 2.33，这一版比原图还宽，在 28px 词条行里是整行唯一有实心墨块的字形，跟旁边 `weapon`（细线剑）一眼分得开。

改的只有 v5 里那三个数字，造型措辞一字未动。**四轮的完整账**：

| 版本 | 改了什么 | 28px 上读成 | 长宽比 |
|---|---|---|---|
| v1 | —（批次 7 原图） | 一把很淡的细刀，迸溅线消失 | 2.33 |
| v3 | 加「近正方」 | 锤子 / 铁砧（宽度焊在护手上） | 1.02 |
| v4 | 护手改小，宽度交给迸溅线 | 直升机 / 昆虫（宽度焊在迸溅线上） | 1.08 |
| v5 | 删掉「近正方」 | 匕首，但只有 6px 宽 | 4.57 |
| v6 | 重算比例数字 + 双边界 | **匕首** | **2.00** |

**`ELONGATED_ON_PURPOSE` 里的 `atk` 已随之删除**——2.00 低于 2.2 的通用门槛，「豁免陈旧」那条测试当场变红要求删掉它，这正是它该有的结局：**豁免是一笔债，不是这个 kind 的属性**。上一轮我把它写成「永久留在名单里」是错的（那时以为匕首天生就得细长），v6 证明了不是。名单现在只剩 `weapon` 3.6 / `event` 3.0 两条带上限的行。

至此批次 7 **全部收工**：43 张自有美术 + 6 个别名 = 49 个 ink kind，无待办、无「记录在案的弱图」。

**这一格留下的四条可复用规律**（按发生顺序）：

1. **28px 上活下来的是实心块，死掉的是细节。** 沙漏 v1→v2、`globe`、`armor` 家族、`scrap` 全是这一条。
2. **返工到第三轮，问的不该是「这张画得对不对」，而是「我给它的题目对不对」。** `brush` 三轮后发现**主体**选错（不该是画笔），`atk` 三轮后发现**约束**选错（不该要求近正方）。
3. **「A 是 B 的 N 倍」这类局部比例约束会乘出一个整体长宽比，模型交付的是算出来的那个数。** 写之前先自己乘一遍——`brush` v2（4.74）和 `atk` v5（4.57）是同一个算术错误的两次发生。
4. **给美术加自动化守卫时，豁免要带上限，且上限按最宽的那个变体定。** 无条件豁免会在最需要门禁的那个 kind 上把门禁关掉；未加粗的墨色跳过 `dilateAlpha`，所以 `active` 不是最坏情况。加之前先拿被打回的那版跑一遍，跑不红就别加。
