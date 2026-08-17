# SLG 主城内政建筑格图标 — city_bld_atlas prompt

状态：**5/6 已出图，`academy`（书院）待出图**——2026-07-17 那批（`desk`/`cabinet`/`drillYard`/`wall`/`satchel`）是用户直接投喂的 AI 成图，没有留过书面 prompt；`academy` 当时被漏掉，一直还是 `icons.ts` 的程序化线稿字形（`book`）+ emoji 兜底（`📚`），是目前 SLG 范围内唯一还没出图的真缺口（2026-08-17 全量审计确认）。本文档 §1 补写现有 5 张的风格规范（供以后重出/校验用），§2 给 `academy` 的新 prompt。

关联：接入管线见 [`SLG_CITY_DESIGN.md` "建筑图标出图（2026-07-17）"](../game/SLG_CITY_DESIGN.md)；渲染代码 [`CityScene/icons.ts`](../../client/src/scenes/CityScene/icons.ts)（`BLD_GLYPH`/`BLD_ATLAS` 映射）；打包脚本 [`pack_city_bld.cjs`](../../art/slg/slg-desk/pack_city_bld.cjs)；踩坑记录见会话记忆 `city-bld-icons-pack-pipeline-2026-07-17`。

---

## 1. 现有风格规范（回溯，2026-08-17 补写）

这批图跟 `slg-map`/`slg-building-art.md` 那套"West of Loathing 手绘涂鸦"风格是**两套不同美术语言**——不要混用彼此的 prompt：

1. **写实钢笔产品插画**，不是涂鸦速写：线条工整、排线细密（羽毛笔尖阴影/木纹/皮革缝线级别的细节），更接近专利图/产品手册插画，不是"5秒涂鸦"。
2. **构图**：单个物件居中，四周留白（不是"填满画幅"那条规则——这批渲染在内政格子里当**图标**用，实际尺寸约 60px，参照 `res_atlas` 母题的"居中留白"惯例，不是覆盖建筑层"立在菱形格上撑满构图"的规则）。
3. 视角按物件自然形态选：家具类物件（`desk` 书桌）用俯视 3/4；有"建筑/结构"感的（`wall` 城墙、`cabinet` 柜子）用正面偏 3/4 立面；纯道具堆叠（`drillYard` 尺规圆规）用平铺构图。
4. **纯黑白线稿 + 排线阴影**，不上色，不用色块渐变。
5. **纯白/近白背景**——出图管线用**硬阈值抠图 + 连通域降噪**（不是 `pack_buildings.cjs` 那套连续 alpha 公式）：AI 出图常在空白处留有意画的"纸纹颗粒"，连续 alpha 会把它们渲染成一片朦胧噪点，必须二值化 + 去掉小连通块才干净。出新图前提醒生成方"背景纯白、无颗粒纹理"能省掉这道工序的风险，但即使有颗粒，管线也扛得住。
6. **文具/校园母题的直白具象转译**：书桌=木课桌+墨水瓶+铅笔+尺；文件柜=抽屉柜+活页夹+回形针；柜墙=螺旋笔记本堆成的城墙+铅笔旗杆；演武场=交叉的尺规圆规+一圈立铅笔（像日晷/阵型）；书包=帆布双肩包+文具袋。**允许写实道具上出现少量无意义英文字样**（如书包上的 "FOCUS STUDY GROW" 织标）当作道具自带细节，不是 UI 文字，判定不违规。
7. **不画**：游戏 UI 文字/数字（道具自带的写实标签除外）、人物、色彩、阴影投影（跟排线阴影是两回事）、地面/场景背景。

---

## 2. `academy`（书院）新 prompt

语义：内政建筑网格里的"科技树"入口（`buildSiegeBlueprints` 军事科技升级），概念上是"做研究/查资料"的场所，跟 `drillYard`（体能/队列）、`wall`（城防）分工不同——用"书本堆叠成的小型建筑"呼应"学问/藏书"，而不是再画一堆铅笔道具（跟 `drillYard` 撞构图语言）。

### Prompt

```
Realistic pen-and-ink product-illustration sketch of a small schoolhouse-like
structure built entirely from stacked hardcover books — the books' spines
face outward and are layered like bricks to form short walls, with a
mortarboard graduation cap perched slightly askew on top like a rooftop.
A fountain pen or quill stands upright behind the cap like a small spire
or chimney. An open book lies flat at the base like a front step or
doorway threshold. A magnifying glass leans against one side of the
structure. Clean, detailed cross-hatch shading (fine linework showing
paper texture on the book covers and pages), single object centered in
frame with generous white space around it — not filling the frame edge
to edge. Plain white background, no color, no additional text or UI
labels, no ground texture, no cast shadow, no people. Same visual family
as an existing set of reference icons: a crossed ruler-and-compass drill
formation, a castle wall built from stacked spiral notebooks with a
pencil flagpole, a wooden school desk, a wooden filing cabinet, a canvas
backpack — match their level of realistic detail and linework density.
```

### 负向

```
doodle style, loose scribble, cartoon outline, color, colored ink,
painterly, flat fill, gradient, glow, 3d render, photorealistic photo,
watermark, game UI text, numbers, flags, banners, faction colors,
people, characters, drop shadow, ground texture, grass, horizon, sky,
filling the entire frame edge to edge, empty stark black background
```

### 验收标准

1. 跟现有 5 张摆在一起，排线密度/写实感一眼是同一批，不是涂鸦风混进来。
2. 单个物件居中留白，不是撑满画幅（这条跟 `slg-building-art.md` 的覆盖建筑规则相反，别搞混）。
3. 语义上跟 `drillYard`（尺规演武场）、`wall`（笔记本城墙）不撞构图/母题——书本堆叠 + 学士帽是"学问"的具象，不是又一堆铅笔/尺子。
4. 出图后用 [`client-run-and-visual-verify`] 同款方法（构造一个 headless `CityScene` 渲染建筑网格，`toDataURL()` 截图核对）或直接对照 `res_atlas`/`city_bld_atlas` 已有帧做像素级降采样模拟（同 `icon_arrowTower` 那次的方法），确认在实际渲染尺寸（约 60px）下不糊成看不出轮廓的墨团。

### 接入步骤（拿到图之后）

1. 源图落 `art/slg/slg-desk/`，语义命名或沿用 UUID 均可（`pack_city_bld.cjs` 的 `JOBS` 表按文件名映射帧名，加一行 `{ src: '<file>', name: 'bld_academy' }`）。
2. `node art/slg/slg-desk/pack_city_bld.cjs` 重新打包 `city_bld_atlas.{png,json}`（6 帧）。
3. 合并进 `world_atlas`——`cityBldAtlasLoader.ts` 复用的是共享 `worldAtlas` 单例（`bld_*` 帧和 `building_*`/`icon_*`/`res_*`/`terrain_*`/`city_*` 同一张图集），不是独立文件，所以这步不能跳过。`bld_academy` 是全新帧，照 `icon_arrowTower` 那次的做法：`NODE_PATH="$(pwd)/client/node_modules" node art/scripts/appendAtlasFrames.js client/src/assets/slg/city_bld_atlas.json client/src/assets/slg/world_atlas.json bld_academy`，跑完删掉临时的 `city_bld_atlas.{png,json}`（本不进仓库）。
4. `CityScene/icons.ts` 的 `BLD_ATLAS` 加一行 `academy: 'bld_academy'`。
5. 更新本文档状态行 + `SLG_CITY_DESIGN.md` 建筑图标出图那条记录，把 `academy` 加进"已出图"名单。
