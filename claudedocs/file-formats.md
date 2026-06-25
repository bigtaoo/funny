# 文件格式

## `.tao`（游戏引擎导出）

ZIP 内含 `animation.json`（v2）+ `spritesheet.png`（shelf bin-packing）+ `spritesheet.json`（boneId→rect）

```json
{
  "version": 2,
  "bindings": { "spine": { "anchorX": 0.5, "anchorY": 0.5, "flipX": false, "zOrder": 6, "rotation": 0, "scaleX": 1, "scaleY": 1 } },
  "animations": { "walk": { "duration": 0.5, "loop": true, "keyframes": [...] } },
  "attachmentPoints": [{ "id": "shadow", "parentBone": "root", "offsetX": 0, "offsetY": 52 }],
  "boneLengthScales": { "spine": 1.4 }
}
```

`boneLengthScales` 稀疏对象，只记录非 1.0 的骨骼；缺省或缺键均视为 1.0。

### 阴影（shadow）—— 待定架构（2026-06-25 记录，未决）

阴影**不画进角色立绘**，是 rig + 引擎单独处理的（立绘出图阶段无需管阴影；绑骨阶段补）：

- `.tao` 里 `shadow` 是一个 `attachmentPoint`（`id === 'shadow'`），挂脚底骨，带可选 `shadowW/shadowH`（椭圆半径，animator 像素）。
- 渲染：`shadow.png` 只是**一张通用柔边深色椭圆晕斑**，被引擎**缩放**到 `shadowW×shadowH`（`scale = shadowW*2 / tex.width`），`alpha=0.55`、`rotation=0` 永远贴地不随肢体转；其上再叠程序画的阵营地面标记（我蓝敌红，`UnitView.drawUnitMarker` / `drawFactionMarker`）。见 `client/src/render/stickman/StickmanRuntime.ts` 的 `_applyShadowPose` / `getShadowGround`。
- **结论：阴影形状通用，差异只靠 `shadowW/H` 缩放参数**——不必为每个角色手绘定制阴影，多个单位可共享同一张 `shadow.png`。

**待决问题（用户在权衡，先不动）**：既然阴影是通用图，每个 `.tao` 各自打包一份 `shadow.png` 属冗余。三种处理：
1. **A 现状**：每个 `.tao` 各自打包。冗余但便宜（柔边椭圆几十 KB）。
2. **B 共享图**：抽一张公共 `shadow.png` 所有 rig 引用。去重，但仍保留贴图资源 + 特殊加载分支。
3. **C 程序画（推荐方向）**：彻底不要这张图，像阵营地面标记那样用 `PIXI.Graphics` 画柔边椭圆，只吃 `shadowW/H`。最干净——零贴图、零打包、可删 `_applyShadowPose` 的 `textures.get('shadow')` 特殊分支。

> C 的代价：要动 animator 导出（不再吐 shadow.png）+ runtime 加载/渲染 + 可能 level/vfx 编辑器对 `.tao` 的解析；收益是架构干净而非性能。另：现有 archer/infantry 的 `shadow.png` 字节数不同（~60KB / ~34KB），做 B/C 前需先确认能统一。要做时先摸完整调用链（animator 导出 → runtime → 各编辑器）出改动清单。

## `.tao.editor`（编辑器存档）

ZIP 内含 `editor.json`（v1，动画+绑定+挂点+编辑器状态）+ `images/*.png`（各骨骼原始 PNG，无损）

保存用 File System Access API（`showSaveFilePicker`），Firefox 退回 `<a download>`。
