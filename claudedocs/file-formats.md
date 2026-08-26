# 文件格式

## `.tao`（游戏引擎导出）

ZIP 内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing）+ `spritesheet.json`（boneId→rect）

```json
{
  "version": 2,
  "bindings": { "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6, "rotation": 0, "scaleX": 1, "scaleY": 1 } },
  "animations": { "walk": { "duration": 0.5, "loop": true, "keyframes": [...] } },
  "attachmentPoints": [{ "id": "shadow", "parentBone": "root", "offsetX": 0, "offsetY": 52 }],
  "boneLengthScales": { "spine": 1.4 },
  "unitHeight": { "tier": "M", "targetScreenPx": 54, "naturalHeight": 178, "supersample": 2 }
}
```

`boneLengthScales` 稀疏对象，只记录非 1.0 的骨骼；缺省或缺键均视为 1.0。

### 两半份契约：写侧 `taoExport.ts` ／ 读侧 `taoFormat.ts`（2026-08-26 补）

- **写**：`tools/animator/src/io/taoExport.ts`（`SerializedProject` / `SpritesheetJson`）+ `io/clipSerialization.ts`（`SerializedClip`）。
- **读**：`client/src/render/stickman/taoFormat.ts`。以前这边是 `JSON.parse(...) as any` 直接下标，于是两边**没有任何东西连着**：写侧改字段名不会让任何地方报错，client 只是读到 `undefined` 后 fallback。
- 读侧比写侧**故意宽松**（字段大多 optional）：`src/assets/*.tao` 里有早于几次格式修订的包（无 `unitHeight` / 无 `boneLengthScales`），靠 `?? 默认值` 才能加载。required 只给「缺了就加不载」的字段。
- 两份声明**故意重复**（animator 和 client 是两个包、无共享类型依赖，而 `.tao` 是磁盘/CDN 上的文件，版本真的可以不一致）：手动保同步，实在对不上就 bump `version`。

### `binding` 的七个字段 —— 没有 `offsetX/offsetY`（2026-08-26 定案）

`bindings[boneId]` **只有** `anchorX/anchorY/flipX/zOrder/rotation/scaleX/scaleY` 七个字段。静态位移一律走 **`anchorX/anchorY` 允许超出 0–1** 这条路（image-space、随贴图缩放），**不存在** binding 级的世界坐标偏移通道。

历史与已定案的处理：

- `SpriteBinding` 曾在 **2026-06-05 ~ 06-09** 短暂带过 `offsetX/offsetY`（世界坐标像素偏移）。**2026-06-09（`0f438040`）删除**：同一个 commit 里去掉了类型字段、去掉了 animator `Renderer.ts` 的应用（sprite 位置 + anchor gizmo 连线），并把 anchor 的注释从"0–1"改成"**允许超出 0–1**"——即以放宽 anchor 取代该通道。
- 但那次删除**没迁移数据、也漏了客户端**：`client/src/assets` 里 18 个包中有 **7 个**仍带非零值（`harpy` / `infantry` / `ironclad` / `medic` / `runner` / `skins/skin_infantry` / `splitter`），对应 `art/**/*.tao.editor` 母版同样带；而客户端 `pose.ts` 一直在 `sprite.x/y` 上加这两个值。
- 数据能存活十周，是因为写侧每一跳都是**无类型对象展开**（`{ ...b }`，`editorProject.ts` / `taoExport.ts`），会捎带类型从未声明的键——类型检查和画师都看不见它。
- **它不是美术意图**：animator 预览从 2026-06-09 起就不应用这两个值，所以画师**从来没看见过它们的效果**，也没有任何 UI 能编辑；而 7 个包里的偏移值**逐字节相同**（`l_lower_arm(-1,13)` / `r_upper_leg(-12,7)` / `r_lower_leg(-8,0)` / `l_upper_leg(16,0)` / `l_lower_leg(2,0)`），而同一批 binding 的 anchor/rotation/scale 却每个单位都单独调过（`harpy` scale 0.3 vs `infantry` 0.55，rotation −40 vs −97，`splitter` 甚至 `anchorX: 1.2` 已超出 0–1）。这是模板项目里冻住的一组常量，不是逐单位调出来的美术数值。
- **结论：判定为死字段，画面以 animator 预览（画师验收的那一版）为准。**
  - 客户端 `assetLoader.ts` **不再读**、`pose.ts` **不再加**这两个值——`pose.ts` 那句"composite formula (matches animator Renderer.ts)"从此才真正成立（此前恰恰在这两个字段上不一致）。
  - 写侧新增 `io/bindingSerialization.ts`，**逐字段构造** binding 取代 `{ ...b }` 展开：类型删掉的字段不再写出，加字段则会在此处编译报错。加载 `.tao.editor` 时同样过一遍，老存档打开即归一化。
  - **不做批量重导出**：既然没人再读这两个键，包里的残留就是死字节；且 `art/**` 母版与 `client/src/assets/**` 已分叉（见下方 2026-07-17 note），重导出风险远大于收益。画师下次打开并保存对应 `.tao.editor` 时会自然清掉。
  - 画面影响：这 7 个单位的相关肢体各移动 **1.2–2.1 屏幕像素**（偏移在 rig 空间最大 16，乘 `targetScreenPx ÷ naturalHeight` ≈ 0.074–0.130；单位屏高 54px）。方向是**回到画师在 animator 里对齐的关节位置**。

### `easing`：字段存在，但真包里一次都没出现过

同一轮扫描（108 clips / 445 keyframes / 1968 个 bone delta）里 `easing` 出现 **0 次**——animator 从没写过，所以现在所有关键帧实际都是线性插值。写侧类型把它当 `string`，运行时是 `EasingType` 联合；读侧用 `taoFormat.ts` 的 `asEasing()` 收窄（不认识的值 → `undefined` → `interpolate.ts` 当 `'linear'`，跟以前那个 `as BoneKeyframe` 直接断言的行为一致）。

### 单位身高档（`unitHeight`）—— 导出元数据（art-direction §4.5.3）

导出时按所选**身高档**（animator 导出面板 `Tier` 下拉 S/M/L/XL）把贴图烘到**绝对目标分辨率**，并写入这一块作**记录/自描述**：

- `tier`：所选档（`S` | `M` | `L` | `XL`）。
- `targetScreenPx`：该档目标屏高（`TARGET_SCREEN_PX[tier]`，镜像自 `client/src/render/unitSize.ts`）。
- `naturalHeight`：导出时算出的角色**自然 FK 包围盒高度** H_nat（animator px，rest pose + 全部关键帧 FK 极值并集，`Skeleton.computeNaturalHeight`）。
- `supersample`：烘焙超采样系数（`SUPERSAMPLE`，现为 2）。

烘焙系数 `G = supersample × targetScreenPx ÷ naturalHeight` 叠进 per-bone bake（取代旧的 1.5 headroom），`binding.scaleX/Y /= bake` 照旧补偿——**runtime 画面不变，仅贴图分辨率收敛到目标**。

> ⚠ **运行时不读这块**：游戏侧 `StickmanRuntime` 按 **UnitType → 档** 自己从 `unitSize.ts` 取 `targetScreenHeight`，并运行时量 H_nat（同一 `computeNaturalHeight`）算 per-unit 缩放 `target ÷ H_nat`，取代旧的一刀切 `STICKMAN_SCALE`。`unitHeight` 仅为自描述/调试（"这份贴图当初按哪档烘的"）。缺省（§4.5 之前导出的旧 `.tao`）安全忽略——旧包运行时仍按 UnitType 正确缩放，只是贴图未瘦身、需在 animator 里选档重导出才省体积。

### 阴影（shadow）—— 统一程序绘制（方案 C，2026-06-27 落地）

阴影**不画进角色立绘**，也**不再作为图片打包进 `.tao`**——是一张全局统一、运行时**程序绘制**的柔边椭圆，按挂点尺寸缩放：

- `.tao` 里 `shadow` 只是一个 `attachmentPoint`（`id === 'shadow'`），挂脚底骨，带可选 `shadowW/shadowH`（椭圆半径，animator 像素）。**只有位置 + 尺寸参数，没有图片。**
- 渲染：运行时用 canvas 径向渐变**一次性生成**一张 128×128 柔边深色椭圆纹理（全局共享），缩放到 `shadowW×shadowH`（`scale = shadowW*2 / tex.width`），`alpha=0.55`、`rotation=0` 永远贴地不随肢体转；其上再叠程序画的阵营地面标记（我蓝敌红，`UnitView.drawUnitMarker` / `drawFactionMarker`）。见 `client/src/render/stickman/StickmanRuntime.ts` 的 `getShadowTexture` / `_applyShadowPose` / `getShadowGround`。
- **结论：阴影形状/纹理全局统一，单位间差异只靠 `shadowW/H` 缩放参数**——零贴图、零打包。

实现要点（完整调用链）：
- **animator 导出**（`tools/animator/src/io/IOController.ts`）：`buildExportImages` / `buildEditorBlob` 不再把 `shadow` 槽打进 spritesheet / `.tao.editor`。
- **animator 编辑**：阴影槽已从图片面板（`ImageController.ALL_SLOTS` 去掉 shadow）移除，只在 `AttachmentPanel` 调挂点位置 + `shadowW/H`；预览（`Renderer.ts`）改用同一份程序生成纹理（`shadowTexture()`），与游戏一致。
- **runtime**（`StickmanRuntime.ts`）：构造时若有 `shadow` 挂点就建一个底层 sprite 用程序纹理；加载 spritesheet 时**跳过任何 `shadow` 帧**，所以**旧 `.tao`（仍打包了 shadow.png）也走统一程序绘制**，无需重导出。
- 旧 `.tao` 内残留的 `shadow.png` 成为死字节，运行时忽略；如需瘦身可在 animator 里重新导出覆盖。
- **2026-07-17 瘦身**：`client/src/assets` 里 `infantry/max/shieldbearer` 三个仍带 `shadow` 帧的旧包，已用脚本外科式删掉 `spritesheet.json` 的 `shadow` 帧条目（`animation.json` 的 shadow 挂点 + `spritesheet.png` 字节不动，程序阴影照常渲染）。注意 `art/units/*/*.tao` 母版早已重导出为无 shadow 帧，但与 `src/assets/*` 已**分叉**（不同版本、PNG 体积差很大），故不可用母版覆盖 src/assets——只能就地删帧。

## `.tao.editor`（编辑器存档）

ZIP 内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始 PNG，无损）

保存用 File System Access API（`showSaveFilePicker`），Firefox 退回 `<a download>`。

## `client/src/assets` 的 png —— 必须是"发布态"，可直接核查

**约定**：`art/<category>/<name>/*` 是画师原始母版（`.xcf`/超大 `.png`，永不进包，见 ASSET_PACKAGING §1）；`client/src/assets/**/*.png` 必须是**已按母版导出、已压缩、可以直接发布**的最终字节——不是"顺手从 art/ 复制一份"。webpack 的 `asset/resource` 规则（`client/webpack.config.js:76`）只是原样拷贝，不接 imagemin/pngquant/oxipng 之类的压缩步骤，`client/src/assets` 里放什么字节，产物就是什么字节，压缩这一步必须在导入前的处理脚本里做完。

**兵种卡图**（2026-08-20 落地）：`art/scripts/exportUnitCardArt.mjs` 从 `art/units/<name>/*.png` + `art/skins/<name>/<name>.png` 母版重新导出 `client/src/assets/units/*.png`——用 sharp（已在 `client/node_modules` 里，vendored libimagequant）量化到 ≤256 色调色板 PNG（`quality:90`，比默认 100 再挤掉一截，medic/runner 这类头像省 10-25%；这批线稿+交叉排线风格的立绘容错高，quality:90 视觉上零差异，已逐张肉眼比对过），效果/压缩都拉满（`effort:10`/`compressionLevel:9`）。

分辨率上限按真实展示尺寸分两档核查过：本体卡图（`UNITS`）largest 用法是 `GachaScene` 抽卡揭示卡（portrait 常规 ~648 逻辑 px，宽屏桌面边界情况 ~1150px），封 `2200px`——现有母版都没超过，这批的省字节几乎全来自换编码方式而非缩分辨率；`archer/infantry/shieldbearer` 此前是从母版原样复制、从未处理过，收益最大（60-86%），其余单位早年已手工量化过一轮，字节数基本打平（±5% 内）。皮肤（`SKINS`）只在 `ShopScene` 换装购买卡出现，是 ~300px 见方的 contain-box，从来没有揭示卡那种大图待遇，封 `900px`（300×3x DPR）——几个母版（756-940px 原生）因此被裁到 900，取代了各皮肤此前互不一致、未留文档的手工缩放（560-940px 不等，比例从 0.6 到 1.0 都有），`skin_shieldbearer` 因为原来手工缩得比 900 更小，按统一政策重导出后字节数略增（+21%），但换来的是"分辨率上限有文档、可推导"，而不是"当年不知道谁裁的"。

**改母版后重新导出**：改完 `art/units/<name>/` 或 `art/skins/<name>/` 下的立绘，跑一遍 `node art/scripts/exportUnitCardArt.mjs`（全量重导出全部 12 兵种 + 6 皮肤，无 CLI 参数），再肉眼核对输出（该脚本会打印每张的 前/后 字节数 + 调色板/真彩两种编码各自的大小，方便判断该单位是否吃量化）。新增兵种/皮肤时记得把它的母版路径加进脚本顶部的 `UNITS`/`SKINS` 映射。

**⚠️ sharp 的隐藏坑：`effort` 单独传就会悄悄量化**（2026-08-20 核实，`sharp.versions.sharp` 现为 0.35.3，[[merged-atlas-repack-pipeline-broken]] 里 2026-08-02 记的 sharp 0.32 同款坑仍在）——`png({ effort: 10 })`（不带 `palette`/`quality`）照样把 colorType 从 6（真彩+alpha）压成 3（调色板），`compressionLevel` 单独传则保持真彩不变。所以本文里说的"效果拉满"跟"量化"其实是同一个开关，`palette: true` 只是把这件事写明给读代码的人看，不是独立生效的选项。**这也是为什么 `pack_resources.cjs` 的 lossless 编码只能传 `{ compressionLevel: 9 }`、一个 `effort`/`palette`/`quality`/`colours`/`dither` 都不能碰**——它的灰度值要精确对应关卡读数（§6 契约），量化引入的哪怕几个色阶漂移都会读错关卡。改这类脚本前先读一遍它自己的编码调用附近有没有类似"为什么不能量化"的注释。

**这套约定不止 units**（2026-08-20 扩展）：`art/` 下还有一整套同类型的 `pack_*.{js,cjs}` 打包脚本（spells/titles/buildings/tabicons/decos/decos-b/decos-c/camps 等 15 个），各自把 AI 生成的白底线稿处理成透明 PNG 或图集。逐个检查后：
- **spells/titles/buildings(arrow_tower)/tabicons/decos(Group A)**：原来就走 sharp 默认 `.png()`（无任何选项，即真彩、零优化），现已加上跟 units 一致的 `{ palette: true, quality: 90, effort: 10, compressionLevel: 9 }`，实测省 45-70%。
- **base_atlas / faction_atlas**：原来已有 `compressionLevel`/`effort` 但漏了 `palette`+`quality`，补齐到同一档。
- **city_atlas / playerbase_atlas / emblem_atlas / shop / city_bld / buildings(slg) / terrain**：之前的会话已经做过这一批（已带 `palette:true` 等），这次未改动。
- **pack_resources.cjs 例外**：见上一条，禁止碰。
- **顺手挖到两个既有 bug**（连带修了，不算"扩展压缩流程"范围外）：`pack_spells.cjs`/`pack_titles.cjs` 的 `OUT_DIR` 一直写去 `client/src/assets/` 平铺根目录，而 `cardArt.ts`/`titleArt.ts` 实际从 `assets/spells/`、`assets/titles/` 子目录导入——跟 `pack_base_atlas.js` 2026-08-19 修过的那个"改目录忘改脚本"是同一类坑，脚本跑了但游戏读不到，已连带修正路径并重新导出。`pack_faction_atlas.js` 的 `OUT_DIR`（`client/src/assets/factions/`）现在确实不存在——但那是因为 2026-07-27 的资源合并（072131d8）把它跑出的 `tao`/`anna` 两帧真实并入了共享 L0 图集 `client/src/assets/icons/icons_atlas.{png,json}`，再删掉了这个中间产物目录，不是"从未跑过"（本条之前的表述是错的，已用 sharp 裁出 `icons_atlas.png` 里 `tao`/`anna` 两帧的像素肉眼核对过，是白线龙纹徽 / 鹰徽真图，非占位图）。`factionIcon.ts` import `iconsAtlas` 正是这次合并后的产物，功能本身是接好的、线上生效的（唯一展示点：`CardScene/detail.ts` 卡牌详情弹窗）。本次给 `pack_faction_atlas.js` 补的 `palette`/`quality` 压缩选项只影响"以后重新生成这两帧美术时"的编码质量，不影响当前已上线的产物；若要真的替换美术，重新跑完这个脚本后还需要 `node art/scripts/patchMergedAtlas.js client/src/assets/factions/factions.json client/src/assets/icons/icons_atlas.json` 把新字节"扎"回 `icons_atlas.png`（`mergeAssetAtlases.js` 已死，理由同 §8 decos 那条）。
- **decos-b(labels)/decos-c → decor_merged_atlas.png 已合回**（2026-08-20 收尾）：`node art/ui/decos-b/pack_labels.cjs` + `node art/ui/decos-c/pack_decos_c.cjs` 重新生成的（不提交的）中间产物，逐帧核对与合并页里已有条目**尺寸完全一致**（`label_*` 256×N，`decoc_*` 128×N）——都走 `patchMergedAtlas.js` 的**同尺寸原地 stamp** 路径，不触发 reflow，`decor_merged_atlas.json` 的 frame 坐标零改动（git diff 该文件为 0）。`decoc_*` 12 帧有 `pack_decos_c.cjs` 自带的 `decor_c_atlas.json`，直接喂给 `patchMergedAtlas.js`；`label_*` 4 帧各自只是散装 PNG（没有 json 清单——`mergeAssetAtlases.js` 里这几个原本是按 `{ png, frameName }` 单帧特例合并的），逐个现拼一份最小单帧 json（`frame:{x:0,y:0,w,h}` 取自 sharp 读到的实际尺寸）喂给同一个工具，等价于跑了 4 次单帧 patch。验证：① 用 sharp 解码 patch 前后整页原始像素，未涉及的 12 帧（decor A 组）逐字节比对 = 0 差异；② 16 个新帧（4 label + 12 decoc）新旧裁出的 crop 肉眼比对（`label_boss`/`label_win`/`decoc_castle`/`decoc_crown` 等）视觉零差异；③ 起 dev server 实测 webpack 产出的哈希文件字节数与本地重新生成的完全一致（135471 字节），证明构建管线确实在用新字节。
  - **⚠️ 反直觉：合并页字节数不降反升**（101,285 → 135,471 字节，+34%）——不是 bug。用 PNG IHDR 的 colorType 字段查发现 patch 前的 `decor_merged_atlas.png` 其实是 **colorType 3（调色板/量化）**：它是当年 `mergeAtlasPages.js` 用 `.png({ compressionLevel: 9, effort: 10 })` 生成的（`effort` 单独传即触发量化，见上面 sharp 隐藏坑那条——`mergeAtlasPages.js` 这个调用点从未被那次修复覆盖到），一直悄悄丢着（预计同样是 12-38/255 的 alpha 漂移、锚点线条卡边）。`patchMergedAtlas.js` 的 in-place 路径只传 `compressionLevel`，重编码整页时把它转正成 **colorType 6（真彩+alpha，无损）**——这单独一步跟本次子图集重打包的压缩收益无关，是在"顺手修掉一个和 world_atlas 曾经一样的量化 bug"，跟 [[merged-atlas-repack-pipeline-broken]] 里 world_atlas "1092→1747 KB" 那次涨字节是同一类必要代价，不是本次任务的失败信号。
  - **顺手挖到同款 bug 尚未修：`icons_atlas.png` 仍是 colorType 3**（未在本次范围内动它）——同一 IHDR 检查显示 `client/src/assets/icons/icons_atlas.png`（equipment/material/factions/avatars 合并页）也是调色板编码，`world_atlas.png` 已经是 colorType 6（2026-08-19 那次 reflow 顺带修的），`decor_merged_atlas.png` 现在也是 6 了，`icons_atlas` 是三个合并页里唯一还没被无损修过的。触发路径同上（`mergeAtlasPages.js` 的 `effort:10`），不是某个 pack 脚本的问题。修法应该跟本条一致——挑一个已经在改的子图集（比如上面提到的 `pack_faction_atlas.js` 的 `factions.json` → `patchMergedAtlas.js ... icons_atlas.json`）走一次 in-place patch，副作用就会把整页转正。这个页面被几乎所有场景引用（`grep decorCLayer`/`iconsAtlas` 命中 30+ 个 scene 文件），blast radius 比 decor 组更大，留给单独任务评估。
  - **补的回归测试**：`client/test/ui/decorMergedAtlasEncoding.ui.ts`（`npm run test:ui`）——① `label_*`/`decoc_*` 16 帧齐全、非退化尺寸、长边命中各自 packer 的 `LONG_EDGE`；② `decor_merged_atlas.png` 未被量化。②沿用 `worldMapResMotifLevelRead.ui.ts` 里 `metadata().paletteBitDepth` 的判据（而不是 sharp 的 `isPalette` 字段）——实测在当前钉住的 sharp 0.35.3 下，对这两个合并页做一次 fresh `png({effort:10})` 重量化都会稳定给出 `paletteBitDepth:8`，而 `isPalette` 只在"旧文件本来就是别的 sharp/imagequant 版本写出来的调色板 PNG"时才为 `true`，对本仓库工具链今天写出的量化文件反而是 `undefined`——用它当判据会让测试在真实回归发生时静默通过。已用 `png({effort:10})` 重新量化 `decor_merged_atlas.png` 实测验证过这条测试会红。
