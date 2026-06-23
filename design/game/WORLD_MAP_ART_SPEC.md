# 大世界地图 — 美术资产规格书

> 权威来源：`WorldMapScene.ts`（渲染代码）、`design/game/SLG_DESIGN.md`（功能设计）。
> 本文列出所有需要替换程序占位色块的美术资产，按优先级排列。

---

## 一、格子地形底图（Tile Background）

每格在三档缩放下均会显示底色。L1（76px）最精细，L2（38px）次之，L3（20px）仅色块。
美术资产优先提供 **96×96 px PNG**（L1 用，L2/L3 缩放取样即可）。

| 资产名 | 描述 | 临时程序色 |
|---|---|---|
| `tile_neutral.png` | 空地（未占领） | `#f5f0e8` 纸底米白 |
| `tile_food.png` | 食物资源格（麦穗/农田） | `#a8d870` 嫩草绿 |
| `tile_wood.png` | 木材资源格（树林） | `#90b860` 深草绿 |
| `tile_iron.png` | 铁矿资源格（矿石） | `#a0b8c8` 灰蓝 |
| `tile_familyKeep.png` | 战略要点（险地，家族争夺） | `#ffd060` 琥珀黄 |
| `tile_center.png` | 世界中心（唯一，全图标志性） | `#ffe88a` 浅金 |
| `tile_obstacle.png` | 不可通行地形（山脉/河流） | `#9a9488` 石灰灰 |
| `tile_gate.png` | 关隘/桥（可通行的地形节点） | `#c8a878` 沙棕 |
| `tile_stronghold.png` | 险地 NPC 据点（攻克前为系统守备） | `#8a4a4a` 暗砖红 |

**要求**：
- 手绘笔记本风，铅笔/钢笔线条感，轻微纹理，无卡通描边
- 格子边缘留 1px 透明，由程序控制间距
- 提供 @1x（96px）即可；若需要 @2x 高清请另行通知

---

## 二、占领叠加色（Occupation Overlay）

占领状态目前用纯色半透明覆盖。计划用叠加纹理或旗帜图标替换。

| 资产名 | 描述 | 临时程序色 |
|---|---|---|
| `overlay_mine.png` | 我方领地叠层（半透明红墨纹理） | `#e69090` α=0.85 |
| `overlay_mine_base.png` | 我方主城叠层（浓红墨） | `#cc3333` α=0.85 |
| `overlay_enemy.png` | 敌方领地叠层（蓝墨） | `#90a8e6` α=0.85 |
| `overlay_enemy_base.png` | 敌方主城叠层（浓蓝墨） | `#4477cc` α=0.85 |
| `overlay_ally.png` | 家族盟友领地叠层（绿墨） | `#9cd6a4` α=0.85 |
| `overlay_ally_base.png` | 家族盟友主城叠层（浓绿墨） | `#46a85a` α=0.85 |
| `overlay_fog.png` | 视野外迷雾叠层（铅笔灰半透明） | `#6b6458` α=0.4 |

**要求**：
- 96×96 px，RGBA PNG
- 主题：墨水晕染感，非像素/卡通风格
- 叠加方式为 multiply 或 alpha overlay，由程序合成

---

## 三、格内标记图标（In-tile Icons，L1 档展示）

仅在 L1（76px 格）下可见，L2/L3 不显示。图标绘制在格子内部。

| 资产名 | 描述 | 尺寸 | 当前程序占位 |
|---|---|---|---|
| `icon_watchtower.png` | 瞭望塔（己方领地建造，扩视野） | 32×32 | 几何三角塔身（程序绘制） |
| `icon_level_dot.png` | 等级指示圆点（格子升级后右上角） | 12×12 | 实心圆，颜色按归属 |
| `icon_allysect_border.png` | 联盟宗门黄色内描边（重复九宫格拼接） | 96×96 | 程序描边 |

---

## 四、覆盖层建筑（Overlay Buildings，L1 档，独立图层）

计划作为独立 `Sprite` 放在格子中央，需单独图层。

| 资产名 | 描述 | 尺寸 | 备注 |
|---|---|---|---|
| `building_base_mine.png` | 我方主城（城池轮廓） | 64×64 | 笔记本手绘城堡图 |
| `building_base_enemy.png` | 敌方主城 | 64×64 | 同上，蓝色调 |
| `building_base_ally.png` | 盟友主城 | 64×64 | 同上，绿色调 |
| `building_keep.png` | 战略要点建筑 | 64×64 | 城楼/箭塔感 |
| `building_stronghold.png` | 险地 NPC 据点 | 64×64 | 暗色石垒 |

---

## 五、覆盖层标记（Overlay Markers，叠加在 overlayGfx 层）

| 资产名 | 描述 | 尺寸 | 当前程序占位 |
|---|---|---|---|
| `marker_capital_owned.png` | 首府星标（已被占领） | 32×32 | 实心五角星金色 |
| `marker_capital_free.png` | 首府星标（未占领） | 32×32 | 空心五角星米色 |
| `arrow_attack.png` | 行军箭头—攻击 | 32×8 | 程序直线+圆点 |
| `arrow_reinforce.png` | 行军箭头—增援 | 32×8 | 同上 |
| `arrow_scout.png` | 行军箭头—侦察 | 32×8 | 同上 |
| `arrow_return.png` | 行军箭头—回师 | 32×8 | 同上 |
| `arrow_occupy.png` | 行军箭头—占领 | 32×8 | 同上 |

**行军箭头颜色对照**（待替换后保留色值用于 tint）：
- 攻击 `#cc3333`，增援 `#44aacc`，侦察 `#9b59b6`，回师 `#44cc88`，占领 `#cc8844`
- 敌方行军统一 `#4477cc`，线宽 2.5px（己方 1.5px）

---

## 六、资源图标（HUD 内显示）

| 资产名 | 描述 | 尺寸 |
|---|---|---|
| `res_food.png` | 食物图标（当前临时用 🌾 emoji） | 24×24 |
| `res_wood.png` | 木材图标（当前临时用 🪵 emoji） | 24×24 |
| `res_iron.png` | 铁矿图标（当前临时用 ⛏️ emoji） | 24×24 |

---

## 七、提供格式与命名规约

```
art/world/
  tiles/          tile_*.png
  overlays/       overlay_*.png
  icons/          icon_*.png
  buildings/      building_*.png
  markers/        marker_*.png  arrow_*.png
  hud/            res_*.png
```

- **格式**：PNG-32（RGBA），无压缩或 PNG-OPT 压缩
- **分辨率**：@1x 对应 96px 格（tile/overlay/buildings），图标类 32px 以下
- **风格**：手绘笔记本铅笔/墨水质感，与 `sketch.ts` 程序笔触一致，不要卡通描边
- **命名**：小写下划线，无空格，`.png` 后缀
- **交付**：所有资产放入 `art/world/` 对应子目录后告知，程序侧替换 `Graphics` 占位为 `PIXI.Sprite`

---

## 八、实现计划（程序侧）

当前所有效果由 `WorldMapScene.ts` 的 `drawTileL1()` / `drawTileL2()` / `renderOverlay()` 用 `PIXI.Graphics` 程序绘制。

收到美术资产后改造：
1. 在 `build()` 阶段 `PIXI.Loader.shared.add()` 预加载所有地图资产
2. `drawTileSlot()` 改为 `Sprite`（底图）+ `Sprite`（叠加层）复用，颜色改为 `tint`
3. 标记类图标改为每格固定 `Sprite` 子节点，按 `visible` 切换显示
4. L2/L3 仍可继续用色块（减少 draw call），或改用 `RenderTexture` 批量
