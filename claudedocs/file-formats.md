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
