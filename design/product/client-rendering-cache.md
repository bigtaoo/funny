# 客户端渲染缓存设计

## 概述

客户端渲染缓存分为两层：

- **资源缓存（Asset Cache）**：管理纹理、图集、音频等原始资源，按需加载，永不释放。
- **对象池（Object Pool）**：管理 PixiJS 显示对象（Sprite、AnimatedSprite、Container 等），用完归还，不销毁。

两层缓存共同保证：运行期间零 GC 压力、零重复加载、零重复实例化。

---

## 一、资源缓存（Asset Cache）

### 原则

- 游戏启动时只加载当前场景所需资源（主菜单、lobby 等）。
- 进入新场景或新对局前，增量加载该场景所需资源。
- 已加载的资源**永不从缓存中移除**。

### 实现

使用 PixiJS 内置的 `Assets` 模块作为底层加载器，在其上封装一个单例 `AssetCache`：

```typescript
// src/client/cache/AssetCache.ts

import { Assets, Texture, Spritesheet } from "pixi.js";

type AssetKey = string; // e.g. "units/archer", "ui/card-frame"

class AssetCache {
  private loaded = new Set<AssetKey>();

  /**
   * 加载一批资源，已加载的自动跳过。
   * manifest 中的 key 对应 assets 配置中的 bundle 名或单个资源别名。
   */
  async load(keys: AssetKey[]): Promise<void> {
    const pending = keys.filter((k) => !this.loaded.has(k));
    if (pending.length === 0) return;

    await Assets.load(pending);
    pending.forEach((k) => this.loaded.add(k));
  }

  getTexture(key: AssetKey): Texture {
    return Assets.get<Texture>(key);
  }

  getSpritesheet(key: AssetKey): Spritesheet {
    return Assets.get<Spritesheet>(key);
  }

  isLoaded(key: AssetKey): boolean {
    return this.loaded.has(key);
  }
}

export const assetCache = new AssetCache();
```

### 资源清单（Asset Manifest）

在项目初始化时向 PixiJS 注册所有资源的路径，按 bundle 分组，对应游戏场景/功能模块：

```typescript
// src/client/cache/assetManifest.ts

import { Assets } from "pixi.js";

export async function initAssetManifest() {
  await Assets.init({
    manifest: {
      bundles: [
        {
          name: "ui-common",
          assets: [
            { alias: "ui/card-frame", src: "assets/ui/card-frame.png" },
            { alias: "ui/health-bar", src: "assets/ui/health-bar.png" },
            // ...
          ],
        },
        {
          name: "units",
          assets: [
            { alias: "units/archer", src: "assets/units/archer.json" }, // spritesheet
            { alias: "units/knight", src: "assets/units/knight.json" },
            // ...
          ],
        },
        {
          name: "effects",
          assets: [
            { alias: "fx/explosion", src: "assets/fx/explosion.json" },
            // ...
          ],
        },
      ],
    },
  });
}
```

### 加载时机

| 时机 | 加载内容 |
|---|---|
| 应用启动 | `ui-common` |
| 进入对局大厅 | 当前卡组涉及的 `units` bundle |
| 对局开始前（loading screen）| `effects`、地图相关资源 |
| 新卡牌/单位首次出现前 | 按需增量加载对应 key |

---

## 二、对象池（Object Pool）

### 原则

- 所有频繁创建销毁的显示对象（单位 Sprite、特效、伤害数字、子弹等）都通过对象池管理。
- `acquire()` 从池中取出对象并重置状态；`release()` 将对象归还池中（不销毁）。
- 池中对象从父容器移除但不 destroy，下次复用时重新 addChild。

### 实现

```typescript
// src/client/cache/ObjectPool.ts

type Factory<T> = () => T;
type Resetter<T> = (obj: T) => void;

export class ObjectPool<T> {
  private pool: T[] = [];
  private factory: Factory<T>;
  private resetter: Resetter<T>;

  constructor(factory: Factory<T>, resetter: Resetter<T>, prewarm = 0) {
    this.factory = factory;
    this.resetter = resetter;
    for (let i = 0; i < prewarm; i++) {
      this.pool.push(factory());
    }
  }

  acquire(): T {
    const obj = this.pool.length > 0 ? this.pool.pop()! : this.factory();
    return obj;
  }

  release(obj: T): void {
    this.resetter(obj);
    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }
}
```

### 使用示例：单位 Sprite

```typescript
// src/client/pools/unitSpritePool.ts

import { AnimatedSprite } from "pixi.js";
import { ObjectPool } from "../cache/ObjectPool";
import { assetCache } from "../cache/AssetCache";

function createUnitSprite(): AnimatedSprite {
  // 使用占位纹理初始化，acquire 后再设置正确纹理
  const sprite = new AnimatedSprite([Texture.EMPTY]);
  sprite.anchor.set(0.5);
  return sprite;
}

function resetUnitSprite(sprite: AnimatedSprite): void {
  sprite.stop();
  sprite.removeFromParent();
  sprite.visible = false;
  sprite.alpha = 1;
  sprite.scale.set(1);
  sprite.rotation = 0;
}

export const unitSpritePool = new ObjectPool(createUnitSprite, resetUnitSprite, 20);
```

```typescript
// 对局中使用
const sprite = unitSpritePool.acquire();
sprite.textures = assetCache.getSpritesheet("units/archer").animations["walk"];
sprite.visible = true;
sprite.play();
stage.addChild(sprite);

// 单位死亡后
unitSpritePool.release(sprite);
```

### 推荐为以下类型建立对象池

| 对象类型 | 预热数量（参考） |
|---|---|
| 单位 AnimatedSprite | 20 |
| 特效 AnimatedSprite | 30 |
| 子弹 / 抛射物 Sprite | 40 |
| 伤害数字 Text | 20 |
| 卡牌 Container | 手牌上限 × 2 |

---

## 三、初始化流程

```
App 启动
  └─ initAssetManifest()          注册所有资源路径
  └─ assetCache.load(["ui-common"])  加载首屏资源
  └─ 进入主菜单

用户进入大厅 / 选卡组
  └─ assetCache.load([...卡组相关 keys])

对局 Loading Screen
  └─ assetCache.load(["effects", ...地图 keys])
  └─ 预热各对象池

对局开始
  └─ 所有资源已就绪，对象池通过 acquire/release 复用
```

---

## 四、注意事项

- **纹理引用安全**：`Assets.get()` 返回的是已缓存的 Texture 引用，多个 Sprite 共享同一 Texture 是安全的，不要 clone 或 destroy。
- **AnimatedSprite textures 切换**：复用对象时只需替换 `textures` 数组，不需要重建对象。
- **release 时机**：确保对象从舞台移除后再归还池，避免池内对象仍在渲染树中被访问。
- **内存预算**：无内存回收意味着峰值内存即为最终占用。建议在开发阶段用 Chrome DevTools Memory 面板评估全量资源的纹理内存总量，桌面端通常 512MB 以内是安全的。

---

## 五、程序绘制的烘焙与增量更新

除资源缓存与对象池外，手绘笔记本风格靠 `SketchPen` 程序绘制的图形还有第三层复用策略：**静态一次烘焙、动态分层增量重绘**。

### 5.1 静态图形烘焙（draw-once → bake → reuse）

- `src/render/bake.ts`：`bake` / `bakeLazy` 通过 `renderer.generateTexture` / `RenderTexture` 把 `SketchPen` 画的静态美术（棋盘纸/方格/边框）烘焙成 GPU 纹理并按 key 缓存，之后只发 `PIXI.Sprite`，每帧零成本。
- `src/ui/widgets/uiCache.ts`：`bake` 的 UI 封装（`getCachedTexture` / `getCachedDisplay`），返回键约定 `widget+size+variant`。返回键、卡框、稀有度边框、图标（`icons.ts`）都走它。
- 无渲染器（headless 测试）时自动回退到实时绘制，调用方无需分支。

### 5.2 动态图形的增量更新（HandView 卡牌）

对内容频繁变化、不宜烘焙的动态图形（如手牌），采用**卡槽持久化 + 按变化频率分层、各层独立按需重绘**，替代「每次 `syncKey` 变化就全量 `teardown` + 重建 6 张卡」：

| 层 | 触发重绘的条件 | 说明 |
|---|---|---|
| 内容层（bg 手绘/涂色/角标 + art + name/cost 文本） | `卡id / 选中 / 卡尺寸` 变化（`slotContentKey`） | 最贵的一层（SketchPen 路径 + 文本布局 + 纹理适配），几帧才变一次 |
| 可负担层（cost 徽章色 + 变暗遮罩） | `canAfford` 翻转（`slotAfford`） | ink 频繁变但不跨越 cost 阈值时零成本 |
| 刷新条 | 像素签名 `barW:color:alpha` 变化（`slotBarSig`） | 每 tick 变；不同卡独立刷新，一张卡倒计时不再连累其余卡重绘 |
| 闪白 | 过期动画进行中 | 逐帧，动画结束即 `clear` |

顶层仍保留 `syncKey` 空闲帧早退，tick 之间的帧零成本。卡槽随手牌大小通过对象池 `ensureSlotCount` 增删；纹理异步加载完成时须同时失效 `slotContentKey`（`fill('')`）以触发内容层重建。
