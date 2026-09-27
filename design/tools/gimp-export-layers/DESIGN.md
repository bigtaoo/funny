# GIMP 图层导出插件 + 去杂点（gimp-export-layers）

> 代码：`tools/gimp-export-layers/`。安装与用法见同目录 `README.md`（英文）。
> 状态：已落地（2026-09-26）。

## 1. 它在管线里的位置

```
game_<unit>.xcf ──[GIMP 插件：逐可见图层裁到内容]──▶ art/units/<unit>/*.png
      ──[animator：手动把 PNG 指派到骨骼槽]──▶ <unit>.taoeditor（PNG 原字节嵌进 zip）
      ──[animator 导出]──▶ <unit>.tao ──[拷贝]──▶ client/src/assets/units/<unit>.tao
```

- `art/units/<unit>/*.png` **没有任何构建步骤读取**；进游戏的只有 `.tao`（由 animator 从 `.taoeditor` 里嵌的图导出，见 `claudedocs/file-formats.md`）。
- 所以「PNG 变小」要真正生效，必须走到 animator 重导 `.tao` 那一步。

## 2. 问题：肉眼看不见的杂点把裁剪框撑大

GIMP 的 autocrop 只要 alpha > 0 就算内容。画稿边缘常散落几颗手抖/笔刷残留的像素，裁剪框就被撑到它们那里。实测（2026-09-26，全部兵种部件图）：

| 图 | 原尺寸 | 去杂点后 |
|---|---|---|
| archer `arm-left-up` | 191×254 | 106×44 |
| archer `leg-right-down` | 167×169 | 72×169 |
| harpy `leg-l-up` | 626×672 | 290×543 |
| shieldbearer `leg-left-down` | 437×351 | 92×141 |

## 3. 判定规则（`speckle.py`）

**按透明度阈值过滤行不通**：archer 的杂点 alpha 最高到 183、甚至 255；反过来 berserker 有上千像素的大片雾状残留，alpha 只有 2–15。要同时看「多重」和「离多远」：

1. 按 8 邻接把 alpha > 0 的像素分成岛。
2. 每个岛算**墨量** `mass = Σalpha / 255`（等效几个全不透明像素）。
3. `mass ≥ 64` 的岛是**主体**（core）。一个都没有时，取最重的那个当主体，保证不会把整层删光。
4. 其余的岛满足任一条就删：
   - **淡**：岛内最大 alpha < 24（谁也看不见）；
   - **远**：周围 16 px（切比雪夫距离）内没有主体像素。
5. 离主体近的小岛**保留**：它们多半是笔画断开的碎片（harpy 发丝、infantry 阴影边缘），而且几乎不撑大裁剪框。

默认值 `core_mass=64 / near=16 / faint=24` 是拿全部兵种部件图校准的。被删岛里「看得见的」（alpha ≥ 128 且墨量 ≥ 8）全仓只有十几个，逐个放大看过，全是远离主体的孤点或断开的草稿虚线碎片。按游戏里的烘焙尺寸（单位屏高约 54 px），这些都看不见。

**实现**：纯 Python、不依赖 numpy（GIMP 自带的解释器没有）。按行游程 + 并查集做连通域，最大的图（2181×1514）约 0.16 s。和 `scipy.ndimage.label` 在全部部件图上逐个比过，岛数和像素数完全一致。

## 4. 两个入口，同一套规则

- **GIMP 插件**（`export_layers_cropped.py`）：导出前对每个图层去杂点，再按保留部分的包围盒裁剪。选目录的对话框里有一个「Remove stray pixels before cropping」勾选框，默认开启。改像素时用**图层原生格式**读写（被删像素整像素置零），所以 u16/float 精度的图也不会被降成 u8。导出完成的提示里会列出每层删了几个岛。
- **命令行**（`despeckle.py`，需要 Pillow）：处理已经导出的 `.png`（原地改写），或者处理 `.taoeditor`。`-n` 只报告不写；`--preview DIR` 输出叠图（红色 = 被删，绿框 = 新裁剪框）供人工检查。

## 5. 裁剪会让已绑好的骨骼跑偏，`.taoeditor` 模式负责修正

binding 的 `anchorX/anchorY` 是**贴图尺寸的分数**（`claudedocs/file-formats.md`）。图裁小之后，同一个分数会落到另一个像素上，部件就会移位、绕错误的关节转。animator 的「🔄 替换图片」**只换贴图，不改 anchor**。

因此 `despeckle.py <unit>.taoeditor` 在裁每个 `images/<slot>.png` 的同时，按下式重算该槽的锚点：

```
newAnchor = (oldAnchor × oldSize − cropOffset) / newSize     （x、y 各算一遍；没裁的轴不动）
```

`flipX` 是用负 scale 实现的，anchor 始终在贴图空间，所以这个公式同样成立。`scale` 按贴图像素计，和图片尺寸无关，不用改。

实测 archer：10 个槽里有 6 个被裁小。每个槽的轴心像素（`anchor × size + offset`）前后偏差不超过 3e-14；除锚点外 `editor.json` 逐字段相同；同一文件跑第二遍什么都不改；存档从 348 KB 降到 284 KB。

**已经绑过骨骼的 rig 要瘦身，按这个顺序做：**

1. `python tools/gimp-export-layers/despeckle.py art/units/<unit>/<unit>.taoeditor`
2. 在 animator 里打开它，确认画面没变，然后导出 `.tao`。
3. 把 `.tao` 拷到 `client/src/assets/units/`（上线的包必须是母版的逐字节拷贝，见 `client/test/unitRigsAreBaked.test.ts`）。

**不要**先对 PNG 跑命令行、再用「替换图片」换进已绑好的 rig：那条路会丢掉裁剪偏移，轴心必然跑偏。

## 6. 没做的

- 没有在 PNG 里记录「裁剪原点在画布上的位置」。有了它，animator 的「替换图片」就能自动保持轴心。目前没有这个需求：新图第一次绑骨不受影响，已绑的 rig 走 `.taoeditor` 模式。
- 没有批量处理仓库里现有的 rig。每个 `.taoeditor` 都需要人在 animator 里过目并重导 `.tao`，属于美术操作，按需逐个做。
