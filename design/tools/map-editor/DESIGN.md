# Notebook Wars — SLG 地图编辑器设计文档

> 创建：2026-07-04。地形骨架已拍板（2026-07-05，见 [DECISIONS.md ADR-034](../../DECISIONS.md)），代码重写已完成（2026-07-05），编辑器工程骨架+城池拖拽+栅格化发布到服务端模板+等距贴图美术对齐游戏客户端+中英文切换已搭（2026-07-05，见 §8）；河流/山脉笔刷最初是矢量路径模型，2026-07-06 改为直接格子笔刷（见 §8"矢量路径笔刷改为直接格子笔刷"）。
> 配套阅读：`../../game/SLG_DESIGN.md`（§2.4 国家系统 / §3.2 地图规格 / **§24 地图模板与编辑器**——本节的服务端持久化就是接到 §24 已实现的 admin 模板 API，不是新建一套）、`../../DECISIONS.md`（ADR-032 地图尺寸/等级、ADR-034 环形地形骨架，**注意**：曾短暂存在一版同日的 ADR-033"10 首府三层同心环"方案，与本文档方向不同，当天即被撤销/作废，本文档只跟 ADR-034 对应）、`../../game/SGZ_LAND_REFERENCE.md`（三战地块/城池调研，§5 环形结构 / §8 城池系统）、`server/shared/src/slg/`（已按本文档重写，god-file split 后拆成 `province.ts`/`mapgen.ts`/`mapEdit.ts` 等：`provinceIdxAt()`/`provinceCapitalPositions()` 替代 `nearestCapitalIdx()`/`CAPITAL_FRACTIONS`，新增地形带+城池节点+按环等级分布表+编辑层栅格化）、`../level-editor/DESIGN.md`（工程化参照）、根 `../../../CLAUDE.md`。
> 讨论期用一次性 HTML/JS 原型（Artifact，未提交仓库）快速试错定稿，迭代记录见 §7；正式编辑器工具（`tools/map-editor`）§8 为工程现状，§6 是其需求清单（编辑交互尚未实现）。

---

## 0. TL;DR

- 起因：500×500 程序化地图（`proceduralTile()`）和国家分区（`nearestCapitalIdx()` 对 10 个固定首府做 Voronoi）曾是**两条互不感知的纯函数管线**——地形噪声不知道国界在哪，国界切割不管地形长什么样，导致边界随机穿山、无法手工修正。
- **地形骨架已拍板**（ADR-034）：环形分层结构（6 出生州 + 3 资源州 + 1 核心州，角度扇区归属而非点 Voronoi）+ 两类天然隔离地形（折痕岭=山脉、墨河=河流）+ 两类通道节点（关隘/桥=自由通行、城池=须攻城）。详见 §2-§4。
- 编辑器方向不变：不做"手绘 25 万格"，而是**参数化生成 + 编辑器覆盖**——山脉/河流存成**矢量路径**（折线 + 宽度），城池存成**点节点**（坐标 + 等级 + 归属），生成时按路径/节点栅格化到 tile，而不是维护一张 25 万格的逐格覆盖表。
- 编辑器 MVP 需要的交互（本轮新定，§6）：画河流、画山脉（路径笔刷）、拖拽调整城池位置。
- 工具形态不变：仿 `tools/level-editor` 的独立 Web 工具，暂定 `tools/map-editor`，端口 **9095**。
- **代码现状**：`server/shared/src/slg/`（god-file split 后的 `province.ts`/`mapgen.ts` 等）已按本文档 §2-§4 整体重写（2026-07-05）——`provinceIdxAt()`/`provinceCapitalPositions()` 替代旧的 Voronoi `nearestCapitalIdx()`/固定表 `CAPITAL_FRACTIONS`；新增环形地形带（折痕岭主环/内环+墨河弦+出生州间支脉支流）、城池节点（州府+世界中心 9×9+关隘城池+每出生州 9 座分级城池）、按环（outer/resource/core）等级分布表。城池落地为现有 `ProceduralTile` 的 `familyKeep`/`center` 类型（不是独立 collection/带驻军HP的节点），因为 §5 城池驻军/耐久数值尚未拍板——这是本轮实现的刻意范围收窄，非疏漏。受影响的 `server/worldsvc` e2e（`nation-bonus`/`season-ops`/`fog`/`service`/`httpApi`/`pathfinding`）已同步修完，`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+test 全绿。
- **编辑器工程骨架**（2026-07-05，§8）：`tools/map-editor` 已搭好 webpack/ts 工程（仿 `tools/level-editor`），端口 9095；`src/index.ts` 直接 `import { proceduralTile, ... } from '@nw/shared/slg'`，整图 Canvas ImageData 渲染当前世界（按 tile type 上色、level 调亮度），hover 显示 tile 详情，可切换 world seed。webpack alias 只指向 `server/shared/src/slg/index.ts`（不是整个 `@nw/shared` barrel），因为 barrel 还 re-export 了 `mongo`/`jwt` 等 Node-only 模块，会污染浏览器包——这是刻意的窄别名，不是疏漏。`tsc --noEmit` + `webpack --mode production` 均过。
- **河流/山脉路径笔刷**（2026-07-05，§8）：`src/state/paths.ts` 是纯数据层（`PathStore`：增删/JSON 序列化+反序列化/线段最近距离），`src/index.ts` 用 base canvas + 叠加的 overlay canvas 两层实现——base 只在 regenerate/路径改动落地时重绘，overlay 每次交互都轻量重绘，避免每次拖点都重跑整图 500×500 噪声。工具切换（Select/River/Mountain）、点击加点+双击/回车结束+Esc 取消草稿、Select 模式下拖端点/点击选中路径/Delete 键删除、宽度输入框（默认落在 `TERRAIN_BAND_WIDTH_MIN/MAX`=5–11 随机区间，复用生成侧同款常量）均已实现；Export/Import JSON 面板可把内存态路径序列化成 §6.2 的 `{ type, points, width }` 数组、也可反向导入校验。
- **城池拖拽**（2026-07-05，§8）：`server/shared/src/slg/mapgen.ts` 新增导出 `allCityNodes(worldId)`（+`MapEditorCityNode` 类型）——纯加法改动，给 `_CityNode` 内部接口加了 `kind`/`provinceIdx` 标记，再拼出世界中心（1）+ 州府（9，核心州除外——它的"州府"就是世界中心）+ `_worldCityNodes` 里的分级城池/关隘城池，`proceduralTile()` 原有查表逻辑不受影响；`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+`server/shared` 526 例单测全绿。编辑器侧第三层 `#city-canvas`（最上层，统一承接所有鼠标事件，按当前工具分派逻辑）+ `src/state/cities.ts`（`CityStore`：按 seed 从生成器加载/JSON 序列化反序列化，不做增删——城池集合由生成器决定，不像路径是自由绘制）。新增 City 工具：拖拽移动城池坐标（世界中心 9×9 footprint 拖拽时用外框可视化，保持占地形状不变，边界钳制保证 footprint 不越界）、点击查看详情（kind/level/province/坐标）、Reset Cities 按钮丢弃编辑重新按当前 seed 生成、独立的 Export/Import JSON 面板。关隘/桥（§2.4，自由通行那类）不是城池，本轮没有对应的可编辑节点，仍是地形生成的一部分——这条留白不受本轮改动影响。
- **栅格化 + 发布到服务端模板**（2026-07-05，§8）：路径/城池两层编辑一直是"矢量覆盖层"（DESIGN.md §6.2），发布时才一次性"烘焙"成 tile 级 diff，不做双向同步——服务端模板不会反向生成回矢量图层，继续用已有的 Export/Import JSON 保存可编辑源数据（§6.2 的数据形态本身没变，只是新增了"怎么落地"这一步）。
  - `server/shared/src/slg/mapEdit.ts`（新文件，纯函数，`rasterizeMapEdits(worldId, paths, cities)`）：路径按线段包围盒 + 点到线段距离栅格化成 `type:'obstacle', level:1`（河流/山脉在 ADR-034 里本就是同一种不可通行地形，无需区分渲染类型）；城池按 footprint 方框栅格化成 `type:'center'`（世界中心）或 `'familyKeep'`（其余三种 kind），resType 用 `mapgen.ts` 里原本内部的 `biomeAt()`（本轮改为 `export`）现场采样，不依赖该格原有地形；城池覆盖顺序在路径之后，保证拖到路径上的城池能"盖过"路径。只返回跟 `proceduralTile(worldId,x,y)` 基线比较后真正不同的格子（§24"只上发本次改动的格子"同款约束），未改动的地块完全不进 diff。`biomeAt` 从内部函数改成 `export`——纯加法，不影响任何现有调用方。新增 `server/shared/test/mapEdit.test.ts`（6 例，覆盖空输入/路径栅格化/城池栅格化/worldCenter 特判/城池盖过路径/跟基线相同时不产生 diff），`server/shared` 532 例全绿。
  - **发布是单向操作，不是双向草稿同步**：这是本轮刻意的架构选择，不是遗留 gap——已存的模板 tile（含之前发布过的编辑）没有标记"哪些格子是编辑过的 diff、哪些是生成时的原始值"，无法从服务端反推出矢量路径/城池位置；本地矢量图层的持久化继续靠 Export/Import JSON（已实现），发布只负责把当前矢量图层的结果推上去，覆盖服务端模板上同名格子的旧值（后保存者覆盖，跟 §24"不做锁"的既有约束一致）。
  - **服务端持久化直接接现有 §24 API，没有新建一套**：`tools/map-editor` 新增 `src/api.ts`（复刻 `tools/ops/src/api.ts` 的 Bearer token + localStorage 套路，localStorage key 换成 `nw_map_editor_admin_*` 避免跟 ops 撞车），只暴露本工具要用的几个方法（login/me/logout + `listMapTemplates`/`generateMapTemplate`/`saveMapTemplateTiles`/`activateMapTemplate`/`deleteMapTemplate`），对应 `/admin/slg/map-templates/*`（`slg.map.view`/`slg.map.manage`，同 §24 已实现的 admin 路由）。UI 新增"Publish to Server"面板：未登录显示行内登录表单（Admin API base / 用户名 / 密码），登录后显示 templateId 输入框 + "Generate Template"（按当前 `SLG_MAP_W`×`SLG_MAP_H` 用 `proceduralTile()` 播种，等价直接调 §24 的 generate endpoint）+ "Publish Edits"（跑 `rasterizeMapEdits` 拿 diff，按 `MAP_TEMPLATE_SAVE_MAX_TILES`=5000 分批 PUT）。
  - **已知限制**：单个 templateId 只能对应固定 `SLG_MAP_W`×`SLG_MAP_H`（同 §24 已知限制 1，`proceduralTile()` 尚未参数化尺寸）；发布仍不做"从服务端拉取已有编辑回显"——见下条模板列表只是元数据浏览，不读回 tile 内容。
- **模板列表 + Activate/Delete**（2026-07-05，§8）：Publish 面板登录后自动拉取 `listMapTemplates()` 并渲染成可点选列表（templateId/尺寸/tileCount/version/是否 active），点一行就把 `template-id` 输入框填成该行的 templateId（复用既有输入框，不引入第二套"当前选中模板"状态）；Generate/Publish 成功后自动刷新列表，保持 tileCount/version/updatedAt 跟服务端一致。新增 Activate（`activateMapTemplate`，标记为"创建新世界用"）和 Delete（`deleteMapTemplate`，浏览器原生 `confirm()` 二次确认）按钮，都作用于当前选中/手填的 templateId；worldsvc 侧既有的"不能删除 active 模板"校验（§24）原样生效，失败信息直接透传到状态栏。**已知限制**：列表只展示元数据，不支持按 viewport 读取/预览模板已存的 tile 内容（`getMapTemplateTiles` 尚未接线——不是本轮需要的功能，模板内容预览要等到"从模板加载回编辑器"这类需求出现再做）。
- **美术表现对齐游戏内渲染**（2026-07-05，§8）：此前的整图 Canvas ImageData 渲染是纯程序化调试色块（按 tile type 上色+level 调亮度），跟游戏客户端 `client/src/scenes/worldmap/` 的贴图图集等距渲染完全不是一回事——用户明确要求"编辑器里的美术表现必须和游戏内完全一样"。改为 PixiJS 等距（2:1 diamond）视口相机渲染，直接复用游戏客户端同款资源与算法：
  - `src/render/isoGrid.ts` 是 `client/src/render/isoGrid.ts` 的逐字节拷贝（纯投影数学，无依赖，两边保持一致靠人工同步，未抽成共享包——`tools/*` 和 `client/` 目前没有共享前端代码的先例，为这一个文件建共享包不值得）。
  - `src/render/{terrain,res,building}AtlasLoader.ts` 拷贝自客户端同名文件，仅去掉 `assetIO` 间接层（编辑器只跑在 Web，`assetIO` 是给微信小游戏 CDN 缓存用的一层indirection，编辑器直接用 atlas URL 当 `PIXI.BaseTexture` source）；**没有拷贝 `cityAtlasLoader.ts`**——城池贴图对应的 tile type 是 `'base'`，只在玩家加入世界后由 worldsvc 运行时写入，`proceduralTile()`/模板基线永远不会产生 `'base'` 格子，编辑器的"city 节点"（capital/gateCity/worldCenter/garrison）栅格化后落地的是 `'center'`/`'familyKeep'`，走的是 `terrain_center`/`terrain_keep` 地面贴图，不是城池建筑贴图。
  - `src/render/tileGraphics.ts` 是 `client/src/scenes/worldmap/tileGraphics.ts` 的裁剪版：保留地面贴图填色/资源图案(`drawResMotif`)/keep·stronghold 地标建筑贴图(`placeBuildingSprite`)三段，砍掉全部运行时态渲染（ownership 染色、fog、base 城池贴图、HP 条、瞭望塔、允许结盟边框、等级点）——这些只有活着的世界才有，模板编辑器永远看不到。
  - 资源产出四张贴图集共 `~590KB`（terrain 358KB 最大），编辑器 `webpack.config.js` 新增 `{ test: /\.png$/, type: 'asset/resource' }` 规则（跟 client 一致的 webpack5 内置资源模块，非 url-loader）；`tsconfig.json` 已有 `resolveJsonModule: true`，`.json` 走 TS 原生解析，不需要额外声明；新增 `src/custom.d.ts` 补 `declare module '*.png';`。`package.json` 新增 `pixi.js-legacy@^7.4.3`（跟 client 同版本）。
  - **交互从"整图 1:1 CSS 缩放"改成"视口相机"**：原先 500×500 tile 直接 1:1 铺满一张 Canvas、缩放靠 CSS `width/height` 缩放整块；等距投影下一个 tile 的屏幕宽度就是缩放本身（`tp`，tile pixel width，10–56px 可调），不可能再整图铺开（500 格 diamond 投影后跨度远超屏幕），改成固定视口（900×620）+ 相机平移（新增 Pan 工具，或任意工具下按住鼠标中键拖动）+ 滚轮/Zoom 滑块缩放（缩放锚点是鼠标位置，同游戏客户端 `WorldMapRenderer.setZoom()` 的"缩放前后同一格保持在同一屏幕位置"手法）。视口按 1.5× 视口尺寸多渲染一圈 tile 作为缓冲，纯平移只挪 `worldLayer` 的 PIXI 容器位置（零重绘），只有平移结束(mouseup)/缩放/编辑提交才重新铺 tile Graphics——地图越大（500×500 全量约 1.4 万格视口内）单次重铺约 1.4–1.7 秒，可接受（不是每帧发生）。
  - **河流/山脉/城池编辑仍然精确所见即所得**：草稿中的路径描边、城池 footprint 选中框是轻量矢量 UI chrome（未采用贴图，因为编辑中的半成品不是"游戏画面"，是编辑器交互提示）；但一旦提交（双击结束路径/松开鼠标完成拖拽），base 层立刻用 `rasterizeMapEdits()`（跟发布用的是同一个函数）重新栅格化并整视口重绘——发布前看到的贴图效果跟发布后服务端模板生效的效果保证是同一份计算结果，不会走两套逻辑分叉。
  - 验证：`tsc --noEmit` + `webpack --mode production` 均过；额外用 PixiJS `renderer.extract.pixels()` 直接读取帧缓冲采样验证（因为该会话的浏览器自动化 `screenshot` 工具对这个 WebGL canvas 页面反复超时，原因未查——不影响功能，只是取证手段换了一种），确认河流路径提交后落地格子的像素色确为 `terrain_river` 贴图色调而非纯色色块。
- **中英文切换**（2026-07-05，§8）：新增 `src/i18n.ts`（en/zh 双字典 + `t(key, vars)` 插值 + `localStorage`（key `map-editor-locale`）持久化选择），工具栏右侧新增切换按钮（显示对方语言名，中文界面下显示"EN"，反之显示"中文"）。静态 UI 文案（按钮/label/title/placeholder）走 HTML `data-i18n`/`data-i18n-title`/`data-i18n-placeholder` 属性 + `applyStaticI18n()` 统一扫描赋值；动态文案（状态栏消息、tile/city 详情、路径/模板计数标题）改造成 `t()` 调用，状态栏额外用一个"渲染函数"（而非预格式化字符串）记住上一条消息——因为消息里嵌了 `tileCountLabel()`/`pathCountLabel()`/`cityCountLabel()` 这类带单复数的组合标签，若只存最终字符串，切换语言后旧语言的复数词会残留（已踩过这个坑并修复）。地形/城池图例的枚举名（`neutral`/`capital`/…）刻意不翻译，保留跟 `TileType`/城池 `kind` 一致的技术标识，避免引入不准确的游戏内术语。验证：`tsc --noEmit` + `webpack --mode production` 均过，浏览器内实测切换按钮双向切换、刷新后语言保持、切换后状态栏/详情栏文案同步更新。
- **河流/山脉改为拖拽实时画笔**（2026-07-05，§8）：原交互是"点击加点 + 双击/回车结束草稿"（选起止点/多点折线，提交才落地），用户反馈体验应该跟刷 tilemap 一样——按住拖动就直接改地形，而不是先选起止点。改法没有动数据模型（矢量路径 `{ points, width }` + `rasterizeMapEdits()` 栅格化的架构不变，§6.2），只改了 `src/index.ts` 的输入状态机：`mousedown` 开始一笔（`painting=true`，`draft=[t,t]`——立即复制一个点形成零长度线段，纯点击也能画出一个笔刷大小的点，不用非拖不可），`mousemove` 期间持续把光标位置写进 `draft` 最后一个点（笔刷宽度输入框改名"Brush Size"/"笔刷大小"，语义不变，`min=1 max=20`），移动超过 `PAINT_MIN_SPACING`（0.4 格）阈值才 freeze 成新的折线定点，避免生成过密的点；`mouseup` 自动调用原有的 `finishDraft()` 收尾（原来挂在双击/回车上的那个函数，逻辑完全没变——只是触发时机从"双击"改成"松开鼠标"）。关键是 `renderBaseMap()` 现在会把"正在画的笔画"（`painting && draft`）当成一条临时路径，跟 `store.paths` 一起传给 `rasterizeMapEdits()`——所以拖动过程中每一次 `mousemove` 都会立刻重新栅格化+重绘 base 层，地形跟着笔刷实时变化，不再是先看一条矢量草稿描边、等提交那一下才变成贴图（松手时机不再有"落地那一下"的视觉跳变，因为提交前后走的是同一份栅格化结果）。原来挂在 river/mountain 上的 `dblclick`（双击结束路径）监听器整个删掉——现在每次 `mouseup` 都会话完一笔，双击等价于连续两次单点画笔，不再有特殊含义。Esc/Backspace 取消草稿/撤销草稿最后一点的行为保留（`cancelDraft()`/`undoDraftPoint()` 现在会在 `painting` 为真时额外触发一次 `renderBaseMap()`，撤销笔画中的点也要同步撤销已经画上去的地形）。验证：`tsc --noEmit` 过；浏览器内用合成 `MouseEvent` 模拟 mousedown→多次 mousemove→mouseup 拖拽，确认落点格子 hover 详情立刻变成 `type: obstacle`（山脉/河流栅格化目标类型）且路径列表实时新增一条；额外验证纯点击（mousedown 后原地 mouseup，不移动）也能画出一条 2 点、零长度的路径（笔刷大小生效的一个点）。
- **画笔实时预览卡顿修复**（2026-07-06，§8）：用户反馈拖拽画笔时明显卡顿。根因是上条改动引入的"每次 `mousemove` 都重新栅格化+重绘"策略本身没有节流也没有增量——`renderBaseMap()`（`src/index.ts`）每次调用都对`store.paths` 全量 + 当前笔画重跑一遍 `rasterizeMapEdits()`，再把视口内（1.5× padding）所有已渲染的 `PIXI.Graphics` 全部 `destroy()` 后重新 `new PIXI.Graphics()` 逐格重绘，而鼠标 `mousemove` 触发频率通常远超屏幕刷新率，三者叠加导致单次拖拽的开销随"视口格子数 × 已有路径总长度 × 鼠标事件数"增长。三处修复，均不改变数据模型（矢量路径+`rasterizeMapEdits()`栅格化架构不变）：(1) 新增 `scheduleRender()`，用 `requestAnimationFrame` 把同一帧内的多次 `mousemove` 合并成一次渲染，替换掉画笔/拖点/拖城池三处 `mousemove` 分支里直接同步调用 `renderBaseMap`+`redrawAll` 的写法；(2) 新增 `strokeBaseDiffCache`：笔刷落笔（`mousedown`）时快照一次"已提交路径+城池"的栅格化结果，拖动期间每帧只重新栅格化当前这一笔（短），跟快照合并，而不是每帧重扫全部已提交路径；抬笔/取消草稿时清空快照。(3) `renderBaseMap()` 新增 `tileGraphicsCache`（tx:ty → 已绘制 Graphics + 一份能代表其地形的签名字符串），每帧只对"签名变了"的格子销毁重建，其余格子直接复用已有 Graphics 对象——这一步同时惠及所有调用 `renderBaseMap` 的路径（不仅是画笔拖拽），把单帧开销从 O(视口格子数) 降到 O(实际改动格子数)。验证：`tsc --noEmit` + `webpack --mode production` 均过。
- **矢量路径笔刷改为直接格子笔刷**（2026-07-06，§6.2/§8，破坏性重写）：用户反馈"拖动再判断起始点"的矢量画笔模型不符合直觉，要求改成图片编辑器那种笔刷——选好笔刷大小（格数），点/拖到哪个格子，那个格子立刻变成当前地形，不再有"路径/起止点/折线"这层中间表示。三处决策（用户拍板）：笔刷形状=圆形（沿用原 `width/2` 距离判定的手感）；旧存盘 JSON（`{type,points,width}` 矢量格式）=自动迁移，导入时按原算法栅格化成格子，不作废；擦除=独立的 Eraser 工具按钮（不是右键，右键与已有 contextmenu 无关）。改动：
  - **数据模型**：`src/state/paths.ts`（`PathStore`/`TerrainPath`/`distToSegment`/`distToPath`）整个删除，新增 `src/state/terrainGrid.ts`（`TerrainGridStore`：`cells: Map<"x:y", 'river'|'mountain'>`——格子本身就是持久层，不再有矢量图形需要"重建")。`paintCircle`/`eraseCircle` 按圆形笔刷直接写格子；`strokeCircle(from, to, kind, diameter)` 沿两点间插值多次 `paintCircle`，防止 `mousemove` 采样间隔内鼠标移动过快漏格（同类图片编辑器画笔的常规处理，不是"重新引入矢量"）。`loadFromJSON` 同时识别新格式（`{x,y,type}[]`）和旧矢量格式（`{points,width}` 存在即判定为旧格式），旧格式按原分段圆形栅格化迁移进格子。
  - **`server/shared/src/slg/mapEdit.ts`**：`rasterizeMapEdits()` 的路径参数从 `MapEditPathInput[]`（`{type,points,width}` 折线）改为 `MapEditTileInput[]`（`{x,y,type}` 单格），栅格化逻辑从"点到线段距离＋包围盒扫描"简化成直接把每个输入格子标记为 `obstacle/level1`（越界格子跳过）——不再需要 `_distToSegment`。城池那半逻辑完全不变。`server/shared/test/mapEdit.test.ts` 同步改写路径相关用例为格子输入，新增越界格子测试，7 例全绿（含新增 1 例）。这是本轮唯一动 `server/shared`（`@nw/shared`）导出签名的改动，但确认全仓库只有 `tools/map-editor` 消费 `rasterizeMapEdits`，无其它下游调用方。
  - **`src/index.ts` 输入状态机**：`mousedown` 直接按当前工具类型 `paintCircle`/`eraseCircle` 一次（点击即生效，不用等抬笔提交），`mousemove` 期间 `strokeCircle(lastPaintPos, pos, ...)` 补线，`mouseup` 只是停止画（`painting=false`）——没有"草稿"/"提交"两阶段，格子改动即时就是最终态。删除的整套机制：`draft`/`PAINT_MIN_SPACING`/`strokeBaseDiffCache`（渲染不再需要"已提交 vs 本笔"两层快照，因为格子写入本身就是 O(1) 的 Map 操作，`renderBaseMap()` 直接对 `cityStore` 走一次城池栅格化 + 直接遍历 `store.cells` 覆盖成 obstacle диff，省掉了对整张地形重新距离判定的开销）、Select 工具及配套的 `findNearestPoint`/`findNearestPath`/端点拖拽/`Undo Point`/`Delete Path` 按钮（矢量模型退场后没有"选中一条路径"这个概念了；撤销单个笔画的能力也一并让位给 Eraser 工具，这是用户拍板接受的取舍，未额外加整体 undo/redo）。保留：`scheduleRender()`/`tileGraphicsCache` 这两处上一条纯性能修复原样不动（跟数据模型解耦，格子模型下依然适用且更快）。新增 `drawBrushCursor()`：跟随鼠标悬停位置画一个笔刷大小的圆形描边（按等距投影采样圆周点再逐点 `tileToScreen` 投影成正确的椭圆轮廓），复刻图片编辑器"画笔预览圈"的观感。
  - **UI/i18n**：工具栏 Select 按钮删除、新增 Eraser 工具按钮；`Undo Point`/`Delete Path` 按钮删除；侧栏"Paths (n)"面板从"路径列表+可点选删除"简化成一行"Painted Terrain (n tiles)"计数（不再有可寻址的单条路径概念）；Export/Import JSON 面板文案从"Paths"改成"Terrain"；`i18n.ts` 同步删掉 `tool.select.*`/`toolbar.undoPoint*`/`toolbar.deletePath*`/`unit.path(s)`，新增 `tool.eraser.*`/`insp.terrainTitle`，`status.pathsExported/Imported` 改名 `status.terrainExported/Imported`。
  - **验证**：`server/shared` `tsc --noEmit` + 536 例单测全绿；`tools/map-editor` `tsc --noEmit` + `webpack --mode production` 均过；`webpack serve` 起本地实例，用合成 `MouseEvent` 模拟 mousedown→mousemove→mouseup 验证：单次拖拽（笔刷 10 格）刷出 119 格 `obstacle`，切到 Eraser 工具再拖一遍能擦掉绝大部分；粘贴一段旧矢量 JSON（`{type:'mountain',points:[...],width:5}`）导入后自动迁移成 71 个格子且能正常导出成新格式；全程浏览器控制台无报错。这次浏览器自动化的 `screenshot` 工具依旧对该 WebGL canvas 页面超时（沿用上上条记录过的已知限制，换用 accessibility snapshot + hover tile-info 文本 + 状态栏计数取证）。
- **河流/山脉/城池真实美术 = 游戏内效果（2026-07-06，§6.3/§8，端到端渲染对齐）**：用户要求"编辑器里看到的山脉/河流/资源/城池图片就是最终游戏内效果"。改动落在**共享数据模型 + 两端渲染器**（不动世界 API/持久化——见下"已知限制"）：
  - **河流 vs 山脉端到端可分**（用户拍板"改数据模型，游戏也区分"）：`@nw/shared` 给瓦片加可选 `obstacleKind: 'river'|'mountain'`（`core.ts`），**类型仍是 `obstacle`**，所以寻路/不可通行判定一字未改（纯美术标签）。`proceduralTile` 现在给自己生成的阻挡带打标：环边界折痕岭=`mountain`、墨河弦=`river`、6 条支脉按 `k` 奇偶交替山/河（`_branchKindAt` 取代 `_isOnBranch`）。`rasterizeMapEdits` 把画笔的 `river/mountain` 原样带进 `MapTemplateTile.obstacleKind`（发布回环保留）。两端 `terrainTextureName(type,tx,ty,obstacleKind?)` 有 kind 就用对应贴图、没有才回退旧的位置哈希。**无需动世界 API**：阻挡格永远是确定性地形（不会被 DB 覆盖），客户端 `WorldMapRenderer.drawTileSlot` 直接本地 `proceduralTile` 取 kind。
  - **城池按等级出图 + 按等级占地**（用户拍板"每级一张图 + 按 tier 递增 3/5/7/9"）：`cityFootprint(level)`=3/5/7/9（Lv1-2/3-5/6-8/9-10），`allCityNodes` 的 footprint 改由它派生（世界中心仍 9×9=顶档）。图集加**每级取图** `getCityTextureForLevel(level)`：先 `city_l{level}`（10 张一套），回退旧 4 档帧 `city_lv{tier}`——6 张新图（`city_l2/l4/l5/l7/l8/l10`）就位后零改代码，未就位时按档回退（当前视觉不变）。出图 prompt 见 [`../../product/city-image-prompts.md`](../../product/city-image-prompts.md)。
  - **城池在两端都画真实精灵**：游戏 `WorldMapRenderer.refreshCityLayer` 现在除玩家主城外，也为 `allCityNodes`（州府/关隘城/分级城/世界中心）各放一个按 footprint 缩放的城池精灵（NPC 城是确定性地形，map-wide 可见、不受战争迷雾影响，与据点/险地贴图一致）。编辑器拷入 `city_atlas.{png,json}` + 新 `render/cityAtlasLoader.ts`（去 assetIO，仿 terrainAtlasLoader），新增 `citySpriteLayer` + `refreshCitySprites()` 用同函数同缩放画城——只在换种子/缩放/拖动城池后重建（不随笔刷每帧重建）；城池 footprint 方框只在 City 工具下作为可拖拽提示显示。**资源**早已用 `res_atlas` 真实图案（`drawResMotif`），本轮不动。
  - **验证**：`@nw/shared` `tsc` + 537 例单测 + dist build 全绿；`client`/`tools/map-editor` `tsc --noEmit` + `webpack --mode production` 均过。按 CLAUDE.md 约定用 tsc+webpack 验证，不启动游戏截图。
  - **已知限制（本轮不做，另起任务）**：编辑器"发布"的改动当前仍到不了运行中的游戏——`worldsvc` `getMap/getTile` 只读 `proceduralTile`，从不读世界创建时克隆进 `mapBaselines` 的模板 tile（管线半接线）。所以本轮做的是**"生成地图"的两端渲染对齐**（编辑器与游戏都从同一份 `proceduralTile`/`allCityNodes` 本地派生，故一致）；让**发布的编辑真正进入游戏**需把 `mapBaselines` 接进热读路径（含把 `obstacleKind` 带进 `MapBaselineTileDoc`），是另一条更重、碰地图读热路径的改动，已单列任务。
- **资源格去掉红色危险角标 + 支持按等级真实出图（2026-07-06）**：用户反馈地图上"靠近城池处红色边框格密集"看起来像禁建区/领地标记，实际是 `drawResMotif` 里 lv≥8 的程序化红色危险角标装饰（`0xcc3333` 描边），跟领地/禁建无关（`worldsvc` 里目前没有任何禁建区/领地半径概念，唯一的半径机制是纯战争迷雾用的视野半径，见 `siege.ts` 的 `VISION_*_RADIUS`）；且该视觉规律的根因也不是"越靠近城池等级越高"——mapgen 的等级分布是**州（province）级**的（角度扇区+半径环，跟地图几何中心而非城池位置有关），州内所有格子共用同一张分布表，格子噪声只做区域内平滑，不含"到城池距离"信息（`mapgen.ts` `_levelFromRing`/`provinceIdxAt`）；该行为符合预期，未改。改动的是：① 删掉 lv≥8 红色危险角标（两端 `tileGraphics.ts` 的 `drawResMotif`），保留 lv4+/lv7+ 的棕色防御栅栏描边（跟"资源美术"是两回事，不动）；② 仿照城池 `getCityTextureForLevel` 的"每级一张图，缺则回退"模式，`resAtlasLoader.ts` 两端新增 `getResLevelTexture(resType, level)`：优先取 `res_{resType}_l{level}` 精确等级帧，画一张真实等级图（不再叠加 count/alpha 模拟），查不到才回退到现有的"单图×图标数量(1-4)×透明度"模拟——`res_atlas.json` 目前还没有任何 `_l{n}` 分级帧，所以在美术资产就位前视觉完全不变，跟城池那批"6 张就位、4 张待补"的过渡方式一致。
  - **验证**：`client`、`tools/map-editor` `tsc --noEmit` 均过；渲染逻辑改动不启动游戏截图（按 CLAUDE.md 约定）。
- **资源母题级差看不清 + 视口格子数没对齐游戏（2026-07-07）**：用户反馈两件事。① paper 现已补齐 `res_paper_l1..l10` 十级美术（`res_atlas.json`），满分辨率原图 l1↔l10 密度差一眼可辨，但在编辑器里几乎看不出——根因是 `drawResMotif`（两端 `tileGraphics.ts`）把母题缩到 `tp*0.34/max(w,h)`≈11px（tp=34 时），级差被压成一个几乎相同的小疙瘩；且用 `max(w,h)` 归一化恰好抵消了级别信号——十级图都是 **128px 宽、靠高度编码级别**（l1 高 82、l10 高 125），按 `max` 缩放会把"越高级越高/越密"的线索归一化掉。改法：系数 `0.34→0.55`（约 19px），并**改按宽度缩放**（`tp*0.55/tex.width`）让高度差保留；关键坑——只有 paper 有分级帧，ink/graphite/metal 无、回退到通用帧且那些是**竖长**的（w<h），故加分支：拿到分级帧才按宽度缩放，通用回退帧仍按 `max(w,h)` 防竖向溢出；client 雾遮路径同步到 0.55，揭雾时不跳变。② 编辑器视口"一直很多格子"（用户已自行 28→34 调过两次仍不对）——根因是编辑器写死 `tp=34`px，而游戏客户端 L1 详细视图把地块尺寸算成 `floor(视口宽/16)`（`client/src/scenes/worldmap/zoom.ts`），900px 视口下=56px/格，即编辑器比玩家最详细视图多约 2× 格子；`ZOOM_MAX` 本就=56（=900/16）说明当初就想让最大缩放≈客户端 L1，只是默认值没挪过去。改法：默认 `tp=Math.floor(VIEW_W/16)`（复用客户端同一除数，不写魔数），`ZOOM_MAX` 抬到 84 留往里放大余量。
  - **验证**：`client`、`tools/map-editor` `tsc --noEmit` + `tools/map-editor` `webpack --mode production` 均过；渲染逻辑改动不启动游戏截图（按 CLAUDE.md 约定）。
- **资源图重新全绘（反转 `0f26b4a7`，2026-07-08）**：`0f26b4a7`（2026-07-07 17:23「去掉资源 motif，改用按生态染色的地表表达资源」）把两端 `drawTileL1`/`drawEditorTile` 里的 `drawResMotif` 调用注释掉，资源格只剩 `RES_TEX_TINT` 地表色调、无任何图标。但用户在该 commit 之后仍持续出 ink/sticker/metal 的 l1–l10 分级图（分级缩放专门做了高度台阶），意图已变成"要在地图上看到资源图"；用户拍板 **每格都画（接受密集）**——`resourceDensity=1.0`（[`core.ts`](../../../server/shared/src/slg/core.ts) 未改，仍每格皆资源），故整图铺满资源图案属预期。改动：两端 `tileGraphics.ts` 在地面填充后对 `type==='resource' && resType` 的格子重新调用 `drawResMotif`；客户端在地标建筑前调用、**恒传 `fogged=false`**（资源图含等级细节属地形层，§18.6 拍板雾中照样全绘，motif 是 `addChild` sprite 恒渲染于雾罩之上），编辑器无雾参数。保持"编辑器/客户端渲染 lockstep"铁律。
  - **验证**：`client`、`tools/map-editor` `tsc --noEmit` + `tools/map-editor` `webpack --mode production` 均过；渲染逻辑改动不启动游戏截图（按 CLAUDE.md 约定）。

## 1. 问题定义（现状，ADR-032 之前）

| 维度 | 现状 | 代码位置 |
|---|---|---|
| 地形生成 | `proceduralTile(world, x, y)` 纯函数：按到地图中心的距离 `dr` + 若干层 value-noise 决定 obstacle / gate / familyKeep / stronghold / resource / neutral，**不接收国家信息作为输入** | `server/shared/src/slg.ts` `proceduralTile()` |
| 国家分区 | 10 个固定首府坐标（`CAPITAL_FRACTIONS`，8 边缘+1 内环+1 居中），每格按最近首府做 Voronoi 分配（`nearestCapitalIdx`），**不接收地形信息作为输入** | 同上 `nearestCapitalIdx()` / `CAPITAL_FRACTIONS` |
| 两者关系 | 运行时各自独立求值，从未合流校验——国界可能直接切穿一片 obstacle 山脉、切穿资源大区、或让某国大半地块被关隘/障碍圈住 | — |

结论：靠调噪声参数无法保证"国界不切山、每国资源均衡、关隘卡在国境线上"这类**位置相关**的诉求——这是纯参数化生成的天花板，需要人工介入的编辑手段。以下 §2-§4 是本轮讨论收敛出的新地形骨架，用来替代"10 首府点 Voronoi"这套旧模型。

---

## 2. 地形骨架（ADR-034，已拍板）

### 2.1 三层环形结构

放弃"10 首府点 Voronoi"，改为**角度扇区 + 半径分层**：

```
6 个"出生州"（外圈，角度各占 60°）
  ↕ 折痕岭/墨河隔开彼此（§2.3 支脉/支流）
  ↓ 折痕岭主环（关隘/桥自由通行）
3 个"资源州"（中环，角度各占 120°，每州对齐 2 个出生州)
  ↓ 折痕岭/墨河内环（关隘/桥自由通行）
1 个"核心州"（地图中心圆域，含世界中心巨城）
```

- 归属由**角度扇区**决定（`floor(angle / sectorWidth) % count`），不是最近点 Voronoi——出生州每 60° 一份，资源州每 120° 一份，天然嵌套对齐（资源州 i 正对出生州 2i、2i+1）。
- "国"与"州"概念等价，本文档统一用"州"；三层半径边界（核心州半径、资源州外边界）可调，当前讨论定的量级：核心州半径比例 **0.11**、资源州外边界比例 **0.39**（相对地图半对角线 `maxDist`），供后续实现时作初始默认值，非最终锁死数字。

### 2.2 地形隔离：折痕岭（山脉）+ 墨河（河流）

背景故事挂钩（`design/product/world.md`）：Nivara 大陆是陶画进笔记本里的想象世界，SLG 是"这个想象世界长大后的宗门-家族版图争霸"；已有"陶的东方笔记本 + Anna 的西方笔记本叠在一起，重叠处显露墨痕"的设定。

- **折痕岭**（3 条，山脉）：出生州↔资源州的环形边界本身——大陆是一整张被反复折叠的稿纸，折痕硬化成山。6 个出生州边界按 2 段一组分成 3 条命名山脉。
- **墨河**（2 条，河流）：全新一层，横穿整张地图（出生州→资源州→擦边核心州），对应陶、Anna 两本笔记本叠压处渗出的墨迹（"东墨河/西墨河"）。走向/位置随种子随机（近似一条过图心的弦，噪声扰动出自然弯曲）。
- 两者都是**完全不可通行**地形，厚度随机 **5–11 格**（每处独立随机，不是全局统一值）。

### 2.3 出生州之间的隔离：支脉 / 支流

6 个出生州彼此间不能只靠角度扇区"隐性"分开——折痕岭/墨河从各自的环形边界向地图边缘方向**延伸出支脉/支流**，把 6 个出生州两两隔开：

- 每条支脉起点 = 折痕岭主环（出生州↔资源州边界）稍外侧，终点 = 地图方形边界（沿该角度射线与画布边缘的交点，天然带长度差异：指向对角方向的支脉比指向边中点方向的长）。
- 6 条支脉按类型交替：单双号交替为"山脉支脉"/"河流支流"，视觉/隔离效果与主体一致。
- **通道只能是攻城点**：支脉上没有免费关隘，只有**关隘城池**（§3）——按支脉实际长度排序，**长的一半（3 条）配 2 座关隘城池，短的一半配 1 座**，城池位置沿支脉随机偏移（不卡在正中间）。

### 2.4 通道：关隘/桥 vs 城池（两套不同机制）

调研三战城池系统（[`SGZ_LAND_REFERENCE.md` §8](../../game/SGZ_LAND_REFERENCE.md)）后明确两者**不能混为一谈**：

| 维度 | 关隘 / 桥 | 城池 |
|---|---|---|
| 出现位置 | 折痕岭主环、墨河主体（出生州↔资源州、资源州↔核心州两条大环边界） | 支脉/支流（出生州与出生州之间）+ 各州州府 + 世界中心 |
| 通行方式 | **免费通行**，占领方及盟友可过；未占领视为阻挡 | **须先攻城**（清驻军+破城墙耐久，参三战机制）才能通过/占领 |
| 位置/宽度 | 每处独立随机偏移+随机宽度 **3–8 格**，不卡在扇区正中心 | 点状节点，独立于地块，位置随机偏移 |
| 驻军/耐久数值 | 无（占领即通行） | **待定**（下一轮拍板） |

---

## 3. 城池体系（ADR-034，结构已拍板，数值待定）

城池是跟地块**并列的独立节点类型**（§8.1 三战调研结论：驻城部队+城防军+城墙耐久三层，跟地块单一守军值不同），本轮拍板了城池的**种类、数量、大致位置规则**，驻军/耐久等战斗数值留后续。

| 城池类型 | 数量 | 等级 | 位置规则 |
|---|---|---|---|
| 州府（出生州） | 6（每州 1 座） | 待定 | 出生州环带内随机偏移（角度=州扇区中心+抖动，半径=资源州边界外侧margin~地图边缘 margin 之间） |
| 州府（资源州） | 3（每州 1 座） | 待定 | 资源州环带内随机偏移，同上逻辑 |
| 关隘城池（支脉/支流通道） | 6-9（每条出生州间支脉 1-2 座，按 §2.3 长度分配） | 待定 | 沿支脉方向随机偏移 |
| 世界中心巨城 | 1（固定居中，不随机） | 待定 | 地图正中心，**9×9 格**实体（同 `BASE_FOOTPRINT` 概念但更大），核心州的赛季争夺目标 |
| 出生州分级城池（新增，本轮拍板） | **每出生州 9 座**（2×3级 + 2×4级 + 2×5级 + 1×6级 + 1×7级 + 1×8级），全图共 54 座 | 如左，按州府之外的固定配额 | 出生州环带内随机散布（角度在本州扇区内、留出与支脉的安全边距；半径在资源州边界外侧~地图边缘之间），呼应三战"州内多级城池梯度"（[`SGZ_LAND_REFERENCE.md` §8.5](../../game/SGZ_LAND_REFERENCE.md)），但本项目版本按州固定配额而非玩家经验配额 |

- 世界中心巨城本质也是"城池"，只是 footprint 更大（9×9 而非 1 格点）——跟州府/关隘城池共用视觉与机制家族，不是第四种概念。
- 资源州、核心州目前只有州府一级城池，尚未定"资源州/核心州是否也要类似出生州的分级城池梯度"——留 §5 开放问题。

---

## 4. 等级分布（ADR-034，已拍板）

三层环各自独立的等级权重表（平滑噪声取值，同一片区域等级连续，不是纯随机撒点）：

| 等级 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| 出生州（占比%） | 34 | 26 | 16 | 10 | 6 | 4 | 3 | **1** | — | — |
| 资源州（占比%） | 14 | 10 | 7 | 6 | 16 | 14 | 12 | 9 | 7 | **5** |
| 核心州（占比%） | 3 | 5 | 6 | 8 | 8 | 10 | 12 | 14 | 16 | **18** |

约束（均已在原型验证达标，见 §7）：出生州**封顶 8 级**且占比极低（~1%）；资源州**5 级+占比 ≥60%**（含约 5% 的 10 级）；核心州 **10 级占比明显高于资源州**（18% vs 5%）。

---

## 5. 开放问题（尚未拍板）

- **城池驻军/耐久数值**：三战有"驻城部队+城防军+城墙耐久"三层，本项目要不要照搬、还是复用现有 `familyKeep`/G8 `stronghold` 的"围攻"机制改造？留后续。
- **资源州/核心州是否也要分级城池梯度**（目前只有出生州拍板了 9 座/州的配额）？
- **数据形态最终定案**（§6.2 是当前倾向，尚未在真正的编辑器工程里验证）。
- **生效方式**：编辑结果是"下一赛季开新世界生效"（对齐 level-editor 思路），还是要支持修正当前运行中的世界？倾向前者，后者留后续。
- **国家国民加成**（`NATION_BONUS_PRODUCTION`/`NATION_BONUS_DEFENSE`，`slg.ts` `provinceIdxAt()` 附近）跟新的三层环形结构怎么对应——本轮重写维持"州级统一加成"不变（仍是同一套 flat 数值，只是省份归属判定换成角度扇区），环形分层后要不要按层级给不同加成（三战式"越靠核心加成越薄"）仍待拍板。

---

## 6. 编辑器需求（本轮新定，工程尚未开始）

### 6.1 交互需求

- **画河流**：路径笔刷——点选起止点或多点折线，工具按折痕岭/墨河同款算法（噪声扰动中心线）生成河道；可指定或随机宽度（默认落在 5–11 格随机区间内，允许手动覆盖）。
- **画山脉**：同上，笔刷产出山脊折线，视觉复用"折痕岭"纹理。
- **调整城池位置**：州府 / 关隘城池 / 出生州分级城池 / 世界中心，均可在地图上拖拽改坐标（世界中心的 9×9 footprint 拖拽时保持其占地形状）。
- 关隘/桥的位置微调：留意 §2.4 关隘和城池是两套不同东西，编辑器交互上要分得清（比如不同的选中/编辑面板）。

### 6.2 数据形态（工程现状，2026-07-06 起改为直接格子笔刷，见 §8"矢量路径笔刷改为直接格子笔刷"）

- **地形（河流/山脉）**：逐格覆盖表 `{ x, y, type: 'river'|'mountain' }[]`——笔刷点/拖到哪个格子，哪个格子就直接进这张表，格子本身即最终态，不经过矢量中间层。旧版矢量路径 `{ type, points: [{x,y}], width }` 格式仍可导入，导入时自动按原分段圆形算法栅格化迁移成格子。
- **城池**：点节点列表 `{ id, kind: 'capital'|'gateCity'|'worldCenter'|'garrison', ownerHint: nationIdx|provinceIdx, x, y, level, footprint }`（未变）。
- 两者都是**覆盖在 `proceduralTile()` 之上的编辑层**，不是替代它——`proceduralTile()` 继续负责等级/资源类型的噪声分布，编辑层只决定"这里是不是河/山/城"。

### 6.3 渲染

- **美术表现必须跟游戏客户端一致**（2026-07-05 用户拍板）：不是程序化调试色块，编辑器直接复用游戏客户端 `client/src/scenes/worldmap/` 同款贴图图集（地形/资源/建筑）+ 等距 2:1 diamond 投影（`isoGrid.ts`），所见即所得。原型阶段验证过的"整图 Canvas 一次性 ImageData 渲染"方案已废弃——那是纯色块调试视图，等距贴图渲染下 500×500 全图铺开的屏幕跨度远超视口，改为§8 的视口相机（平移+缩放）方案，见§8"美术表现对齐游戏内渲染"条目的实现细节。

---

## 7. 讨论原型迭代记录

讨论期没有在仓库里搭建编辑器代码，而是用一份自包含的 HTML/JS 原型（Canvas 渲染 + 参数滑块）快速试错，验证环形结构、地形隔离、城池位置、等级分布是否符合预期，确认后再写入本文档定稿。原型本身**未提交仓库**（Artifact 会话产物，链接会过期），仅记录关键迭代节点：

1. 8 出生州 + 4 资源州（角度 Voronoi 扇区）+ 折痕岭/墨河雏形 + 关隘随机宽度/位置。
2. 改成 6 出生州 + 3 资源州（用户纠正数量）。
3. 加等级分布表（§4）+ 关隘/城池位置随机化 + 参数改为 rCore=0.11/rMid=0.39 + 关隘宽度 3–8/边界墙厚 5–11 随机区间。
4. 州府/关隘城池改为"攻城点"视觉（跟自由通行的关隘区分）。
5. 加出生州之间的支脉/支流隔离（§2.3）+ 按支脉长度分 1-2 座关隘城池。
6. 世界中心并入"城池"家族，9×9 footprint（不再是独立的"争夺点"概念）。
7. 加每出生州 9 座分级城池（§3 表格最后一行）。
8. 与并行会话落地的另一版"ADR-033"（10 首府三层同心环+距离衰减）撞车，用户拍板以本文档方案为准，旧版全部作废（见 [DECISIONS.md ADR-033 撤销记录](../../DECISIONS.md) / [ADR-034](../../DECISIONS.md)）。

---

## 8. 启动（骨架已搭，2026-07-05）

```bash
cd tools/map-editor
npm install     # 首次进入需要装依赖（worktree 各自独立）
npm run start   # webpack dev server，端口 9095
```

当前功能：PixiJS 等距视口渲染，贴图跟游戏客户端一致（切 world seed 输入框 + Regenerate 按钮，Pan 工具/中键拖动平移，滚轮/Zoom 滑块缩放，Center View 按钮回中）、hover 显示 tile 坐标/类型（阻挡格附带 river/mountain）/等级/资源、图例；河流/山脉格子笔刷（River/Mountain/Eraser 工具切换，点击或拖动直接把笔刷覆盖的格子改成当前地形/清回程序化地形——跟图片编辑器笔刷一样即点即变，无需先选起止点，笔刷大小可调，光标跟随一个笔刷大小的圆形描边，Clear All 清空、Export/Import JSON 支持导入旧版矢量路径 JSON 自动迁移；**河流画成河、山脉画成山**——不再是位置哈希随机选贴图，与游戏内一致）；城池（City 工具，拖动移动坐标、点击查看详情、Reset Cities、独立 Export/Import JSON）——**按等级渲染真实城池精灵**（`city_atlas`，每级取图、footprint 3/5/7/9 随等级变大），与游戏 `WorldMapRenderer` 城池层同款；地形格子/城池栅格化回地块+发布到服务端模板（Publish to Server 面板，含登录/模板生成/模板列表/Activate/Delete）均已实现。**资源**用 `res_atlas` 手绘图案显示。（发布进运行中世界的接线是另一条任务，见 §0"已知限制"。）

### 排查记录：用户反馈"山/河笔刷画完不显示"（2026-07-06，结论：非代码缺陷）

用户反馈用 River/Mountain 笔刷改地图后画面没变化。排查覆盖笔刷落格（`terrainGrid.ts`）→ 栅格化合并 diffCache（`index.ts` `renderBaseMap()`）→ 选贴图（`tileStyle.ts:terrainTextureName`）→ 绘制（`terrainAtlasLoader`/`tileGraphics.ts`）全链路的静态审查，并起 9095 服务用 preview 工具实机模拟落笔验证：落笔后 Tile 面板正确显示 `obstacle (mountain/river)`、Painted Terrain 计数正确递增、PIXI 场景图对应 Graphics 节点 `visible/renderable` 均为真、`terrain_atlas.png` 里 mountain/river 帧的美术内容确认与 grass 明显不同（岩石纹理 vs 波浪纹理）。曾怀疑 `drawBrushCursor()` 里 `TERRAIN_COLORS[tool]` 取不到 river/mountain 颜色，核实后是虚惊——`index.ts` 顶部本来就单独声明了一份 `Record<TerrainKind, number>` 的 `TERRAIN_COLORS`（专供笔刷光标用，和 `tileStyle.ts` 同名导出互不影响），取值正常。

**未发现渲染链路缺陷。** 最可能的解释：`proceduralTile()` 生成的程序化底图本身就大量分布着 `obstacle` 类型格子，未标记 `obstacleKind` 时按 `(tx*31+ty*17)%2` 哈希在 mountain/river 贴图间随机选（`tileStyle.ts:39`）——默认 `preview` 世界早已铺满和笔刷画出来视觉上完全一样的纹理，若笔刷落在已有 obstacle 密集区，新画的地块会和周围融为一体，造成"没有生效"的错觉。下次复现建议：在明显是平原/资源的空地上测试笔刷，画完用 Export → 导出 JSON 核对数据是否真的写入。
