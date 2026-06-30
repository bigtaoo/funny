# SLG 主城图片 Prompt

用途：在大世界地图 tile 上显示玩家/敌方/友军城池。  
4 张图覆盖 10 级（Tier1=Lv1-2，Tier2=Lv3-5，Tier3=Lv6-8，Tier4=Lv9-10）。  
生成后放入 `client/public/assets/slg/`，命名 `city_t1.png … city_t4.png`。

---

## 通用 Style（每条 prompt 末尾附加）

```
hand-drawn doodle illustration on graph paper, fountain pen blue ink lines,
slightly scratchy student sketch strokes, light watercolor marker fill,
gentle isometric perspective (25° tilt), isolated on transparent background,
512x512px, notebook doodle aesthetic, no text, no labels
```

---

## Tier 1 — Lv 1-2「小营地」

```
A tiny military camp: 2 small tents made of triangles, a low wooden fence
drawn as zigzag lines around the perimeter, a small flag on a stick in the
center. Humble and sparse, like a student's first doodle. Blue ink outline,
minimal color fill (pale yellow-green tint inside fence).
[+ style]
```

## Tier 2 — Lv 3-5「木寨小镇」

```
A small walled town: a rough rectangular wooden palisade wall (vertical plank
lines), 3-4 blocky buildings inside, one taller central watchtower, a wooden
gate with crossbar, tiny smoke wisps from a chimney. Charming and slightly
messy. Blue ink, warm orange-brown fill for wood.
[+ style]
```

## Tier 3 — Lv 6-8「石头堡垒」

```
A stone fortress: thick crenellated castle walls forming a square, two round
corner towers with arrow-slit windows, a central keep taller than the walls,
a drawbridge gate with portcullis (grid of lines). Cross-hatching on stone
surfaces for texture. Blue ink outline, cool grey-blue fill for stone.
[+ style]
```

## Tier 4 — Lv 9-10「书院大城」

```
An elaborate multi-tower citadel: four tall towers connected by high stone
walls, a grand central spire with a pennant flag, layered battlements, dense
cross-hatching and ruler-straight parallel lines suggesting a grand fortress.
The most complex and imposing structure on the map. Deep blue ink, multiple
layers of detail, slight gold accent on spire tip.
[+ style]
```

---

## 接入说明

目前代码用程序绘制（`drawCityIcon`）作占位，4 个档位对应 `lv <= 2 / 5 / 8 / 10`。  
AI 图就位后，在 `WorldMapScene.ts` 的 `drawTileL1` base 分支换成 `PIXI.Sprite`，tint 区分阵营：

| 阵营 | tint |
|---|---|
| 自己 | `0xcc2222`（红） |
| 友军 | `0x2e8b40`（绿） |
| 敌方 | `0x224488`（蓝） |
