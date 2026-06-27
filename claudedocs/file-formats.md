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

## `.tao.editor`（编辑器存档）

ZIP 内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始 PNG，无损）

保存用 File System Access API（`showSaveFilePicker`），Firefox 退回 `<a download>`。
