# 客户端内存泄漏复盘 + 渲染层销毁契约

> 状态：已修复（main，merge `31fcc477` / fix `3e802964`，2026-06-24）。本文既是事故复盘，也是**渲染层对象生命周期的权威约定** —— 新增任何战斗视图 / 长生命周期 PIXI 对象前必读。

## 1. 症状

连续游玩约 2 小时后，浏览器标签页内存涨到 **~16 GB**。内存随**对战局数**单调增长，不随挂机时间线性增长 —— 这是定位的第一条关键线索。

## 2. 根因

**每打完一局对战、退回大厅时，整张战斗场景图都不被销毁。**

- 六个战斗视图 —— `BoardView` / `UnitView` / `BuildingView` / `HandView` 以及 `GameRenderer` 自身 —— **原先全都没有 `destroy()` 方法**。
- [`GameRenderer.destroy()`](../client/src/render/GameRenderer.ts) 原先只清理了护送精灵 / 弹道精灵 / 弹道池 / VFX / profile 弹层，**既不销毁这些子视图，也不销毁 `this.container`**。
- [`SceneManager.goto()`](../client/src/scenes/SceneManager.ts) 切场景时只对旧场景 `removeChild(container)` + `destroy()`。`removeChild` 只是从舞台摘下，**不释放**任何 GPU / canvas 资源。

于是每局的 PIXI 显示树（`Graphics` 几何、`Text` 的 canvas 纹理、stickman sprite）只被摘下、从不销毁。

### 2.1 为什么能涨到 GB 级 —— `Ticker.shared` 这个 GC 根

光是「显示树没销毁」，若对象成了**孤岛**（无任何引用），JS GC + PIXI 的 textureGC 最终仍能回收。真正让它**永久驻留**的是全局 ticker：

受击 / 死亡 / 陨石 / 建筑生成销毁这些一次性动画，把 tick 闭包挂在 **`PIXI.Ticker.shared`** 上：

```
PIXI.Ticker.shared  ──holds──▶  tick 闭包  ──captures──▶  sprite / runtime
                                                              │
                                                              ▼
                                            UnitView ──▶ GameRenderer ──▶ 整局场景图
                                                              │
                                                              ▼
                                              所有 Graphics / Text / sprite 纹理
```

`Ticker.shared` 是进程级单例 = **GC 根**。只要退场时有**一个**在途 tick 没注销，从这个根出发就能可达整局对象树 —— 永远不会被回收。

最隐蔽的一个是 [`UnitView.playDeathEffect`](../client/src/render/UnitView.ts) 的死亡 tick：它唯一的退出条件是 `elapsed >= total`，**没有**像受击 tick 那样的 `!this.sprites.has(unitId)` 兜底；若场景在死亡动画播放途中被销毁、且 `runtime.update()` / `releaseUnit()` 因半销毁状态抛错，`remove(tick)` 就永不执行，该 tick 连同整局场景图被永久钉住。

> 每局泄漏一整张场景图（含 stickman 纹理）。几十局叠加 → 10 GB+。量级与现象吻合。

## 3. 排查中确认无辜的部分

为节省后人时间，以下都查过、确认**不是**本次泄漏源：

| 模块 | 结论 |
|---|---|
| `render/boil.ts` 沸腾特效 | 只烘焙 N 个变体一次、切可见性，零逐帧分配 |
| `net/NetClient.ts` 重连 | ping / reconnect 定时器都正确 `clear` |
| `game/replay/StateRecorder.ts` | 单槽、`MAX_FRAMES=18000` 封顶、每局 `reset()` |
| `game/meta/ReplayStore.ts` | localStorage、最近 12 局 ring |
| `analytics/queue.ts` | 内存队列 `MAX_QUEUE_SIZE=200` 封顶 |
| `render/VFXSystem.ts` | 有对象池 acquire/recycle，`destroy()` 完整 |
| `render/bake.ts` 烘焙缓存 | key 全是 `tag:WxH` 尺寸维度，有界 |
| 各场景 `update(dt)` | 无逐帧 `new`，都是计时器/脏标志 |
| `StickmanRuntime.loadAsset` | 按 url **静态缓存**，spritesheet 跨局共享、不重复解码 |

## 4. 修复

7 个文件（fix commit `3e802964`）：

1. **`cache/ObjectPool.ts`** —— 新增 `drain(dispose?)`：释放池内**已 `removeFromParent` 的游离对象**（容器树的 `destroy({children:true})` 触达不到它们）。
2. **`render/BoardView.ts` / `BuildingView.ts` / `UnitView.ts`** —— 用 `Set` 跟踪在途特效 tick；新增私有 `addEffectTick/removeEffectTick`（或 `fxTicks` 集合）；`destroy()` 时把残余的全部从 `Ticker.shared` 注销。
3. **四个战斗视图新增 `destroy()`**，统一三步：①注销在途 tick → ②销毁游离池对象 → ③`this.container.destroy({children:true})`。
4. **`render/GameRenderer.ts`** —— `destroy()` 串联调用 `boardView/unitView/buildingView/handView.destroy()`，末尾 `this.container.destroy({children:true})` 兜底清 HUD / 网络状态 / 暗角 / 各 layer。
5. **共享纹理刻意不销毁** —— spritesheet（`loadAsset` 静态缓存）、`bake()` 烘焙底图、`PIXI.Texture.from(url)`（建筑 `texBarracks/texArcher`、卡牌 `artTextures`）都跨局复用，`destroy()` 时**只解引用、不 `.destroy()`**，否则下一局白图 / 双重释放崩溃。

## 5. 渲染层销毁契约（防回归 —— 新增视图必读）

任何「战斗期创建、退场时销毁」的视图 / 长生命周期 PIXI 对象，其 `destroy()` **必须**做到：

1. **注销所有挂在 `PIXI.Ticker.shared`（及任何全局 ticker / 事件总线）上的回调。** 这是头号铁律 —— 全局 ticker 是 GC 根，漏一个闭包就钉住整棵引用树。用 `Set` 跟踪在途 tick，destroy 时遍历注销。
2. **销毁对象池里已游离（`removeFromParent`）的对象。** 它们不在容器子树下，父容器的 `destroy({children:true})` 触达不到 —— 用 `pool.drain(o => o.destroy({children:true}))`。
3. **`this.container.destroy({children:true})`** 销毁显示子树（活跃 sprite / Graphics / Text 及其**自有**纹理随之释放）。
4. **不要销毁共享 / 缓存纹理**（按 url 缓存的 spritesheet、`bake()` 底图、`Texture.from`）—— 跨局复用，只解引用。`destroy({children:true})` 默认不碰子对象的纹理，正合需要；**切勿**传 `{texture:true, baseTexture:true}`。

父级（`GameRenderer`）的 `destroy()` 负责调用所有子视图的 `destroy()`，再 `destroy()` 自己的容器兜底。`SceneManager` 已保证对旧场景 `removeChild + destroy()`，场景只要 `destroy()` 干净即无泄漏。

### 双重销毁注意
PIXI 的 `DisplayObject.destroy()` 会把自己从父容器移除。所以「先销毁子视图容器、再 `parent.container.destroy({children:true})`」是安全的：已销毁的子节点早已从 `children` 列表移除，兜底销毁不会二次命中。**不要**对同一对象既单独 `destroy()` 又靠父级 `{children:true}` 再销毁一次（如 stickman 的 `runtime.container` 是 `wrapper` 的子节点 —— 销毁 `wrapper` 即可，勿再单独 `runtime.destroy()`）。

## 6. 如何验证 / 复现

`tsc --noEmit` + webpack 生产构建 + `vitest`（396/396）只能保证不破坏现有行为，**测不出内存曲线**。要确认增长已止：

1. DevTools → Memory → 打几局对战回大厅，做 heap snapshot；再打几局，再做一次快照。
2. 用 **Comparison** 视图看 `Delta`：修复前 `GameRenderer` / `UnitView` / `PIXI.Graphics` / `Texture` 实例数随局数净增；修复后应趋平。
3. 若仍有残余净增，在快照里点该对象看 **Retainers** 链 —— 通常会指回某个未注销的全局 ticker / 事件监听闭包，按本文契约第 1 条收口。

## 7. 相关文件

- [`claudedocs/client-modules.md`](client-modules.md) —— 「渲染层销毁契约」约束条目（指向本文）
- 修复涉及：`client/src/render/{GameRenderer,BoardView,UnitView,BuildingView,HandView}.ts`、`client/src/cache/ObjectPool.ts`

## 8. 第二类泄漏：UI/overlay 场景销毁时漏掉 Text 纹理（2026-07-22）

> 状态：已修复（`worldmap-texleak` 分支）。与第 1 节的战斗场景泄漏是**不同的类** —— 这次漏的是**生成型纹理**（`PIXI.Text` 的 canvas 纹理），不是 tick 钉住的场景图。

### 8.1 症状与定位
Loki `type=mem` 埋点显示：`baseTexTop` 里按 URL 的资源纹理桶（`a.gamestao.com`）长期稳定 ~20，但 `pixiid_*`（无 URL 的生成型纹理）持续攀升——旧 build 曾冲到 baseTex 1600+/heap 3.5GB，近期 build 仍见 3 分钟内 +70 baseTex 而 `nodes` 反降。**纹理在涨、场景图节点没涨** = 生成型纹理泄漏，不是场景图残留。

### 8.2 根因
`PIXI.Text` 各自持有一张 canvas 纹理，只有 `destroy({texture:true, baseTexture:true})` 才释放。两个反模式漏掉它：
- **场景 `destroy()` 用裸 `this.container.destroy({children:true})`** —— `destroy` 的 options 传给子节点时 `texture` 默认 false，Text *对象*被销毁但 baseTexture 被遗弃。全仓库 ~30 个场景 `destroy()` 都是这个写法。
- **裸 `container.removeChildren()` / `removeChildren().forEach(c=>c.destroy())`** —— 同样不带 `texture:true`。

关键放大因素：ADR-044 起 SLG 面板（City/Family/Sect/Auction/Defense）改为 **overlay 叠在常驻的 WorldMapScene 上**（`pushOverlay`，地图不重建，见 [SceneManager](../client/src/scenes/SceneManager.ts)）。全屏场景切换时 PIXI 的 ~60s textureGC 尚能勉强跟上一屏 Text；但 overlay 一局内反复开关、且底下地图从不重建触发整体回收，漏掉的 Text 纹理便持续累积。

### 8.3 修复
1. **`tearDownChildren`（[sketchUi.ts](../client/src/render/sketchUi.ts)）改为递归** —— 之前只释放顶层 Text，嵌在滚动体/弹窗/行容器里的 Text 仍漏；现在深度遍历，任意层级的 Text 都 `destroy({texture:true, baseTexture:true})`，非 Text 叶子仍 `texture:false`（共享 bake/atlas 底图不受影响）。移除子节点后再销毁空容器，避免二次销毁（见 §5「双重销毁注意」）。
2. **SLG 根因站点接入 `tearDownChildren`** —— 5 个 overlay 场景 + `WorldMapScene`（其 `view.destroy()` 只清 sprite/token 层，HUD/header/modal 的 Text 层需另外释放）+ `FamilyScene/actions` 与 `TutorialDirector` 两处裸 `removeChildren`。
3. **护栏（[MemoryMonitor.ts](../client/src/cache/MemoryMonitor.ts)）** —— mem 报告新增 `generated`（无 URL 的 baseTex 数）+ `genDelta`（相邻采样增量）；并新增独立触发器：`generated` 超软预算 `DEFAULT_GEN_TEX_BUDGET=600` 且仍在增长时上报（可 `localStorage.nw_gentex_budget` 调）。这条不依赖 `performance.memory`（生成型纹理主要占 GPU，heap 阈值照不到），Safari/微信也能测出。

### 8.4 与 §5.4 的差别（重要）
§5.4 对战斗视图说「**切勿**传 `{texture:true, baseTexture:true}`」——那是因为战斗 sprite 的纹理是**跨局共享**的 spritesheet/`Texture.from(url)`，销毁会导致下一局白图/双重释放。**Text 纹理恰恰相反：每个 Text 独占一张 canvas 纹理，从不共享，因此 `texture:true` 对 Text 恒安全且必须。** `tearDownChildren` 正是编码了这个区分——只对 `instanceof PIXI.Text` 的节点传 `texture:true`，其余一律 `texture:false`。新增 UI 场景销毁一屏 Text 时，用 `tearDownChildren(this.container)` 再 `this.container.destroy({children:true})`，不要裸销毁容器。

### 8.5 剩余项（结论已被 §8.7 推翻，本节保留作历史记录）
其余 ~24 个全屏场景（Gacha/Shop/Login/Result/Leaderboard/Equipment/Card…）的 `destroy()` 是同款裸写法，每次导航漏一屏 Text，靠 60s textureGC 勉强跟上、非 SLG 泄漏源，未在本次一并清扫——若要根除全局该类泄漏，同样 `tearDownChildren(this.container)` 接入即可。

### 8.6 复查修复（2026-08-03，全客户端场景切换专项审计）

> 状态：已修复。见 [`claudedocs/client-modules.md`](client-modules.md) 同日条目 + 记忆 `client-scene-lifecycle-audit-2026-08-03`。

对 §7「渲染层销毁契约」和本节契约做了一次全量复核（33 个场景 + `GameRenderer` 全部子视图 + 全部 `Ticker.shared` 注册点 + 全部输入订阅点），发现并修复三处真实缺口：

1. **`GameRenderer/events.ts` 护送兵特效 tick 未注册**——`escort_died`/`escort_arrived` 的淡出/闪烁 tick 直接 `PIXI.Ticker.shared.add(tick)`，未纳入任何 `Set` 追踪，`GameRendererBase.destroy()` 也从未注销，是本文档契约第1条「注销所有挂在 `Ticker.shared` 上的回调」的字面遗漏（此前只有 `BoardView`/`BuildingView`/`UnitView` 三个子视图接了 `fxTicks`/`effectTicks`，`GameRenderer` 自己的护送兵特效被漏掉）。此前未爆是因为退出条件是纯 `elapsed`/`frames` 计数、无异常路径——修复：新增 `escortEffectTicks: Set<() => void>`，`addEscortEffectTick`/`removeEscortEffectTick` 包一层注册，`destroy()` 的 `escortSprites` 清理步骤里先遍历注销再销毁精灵。
2. **`GameRendererBase.destroy()` 顺序 + 无隔离**——四个子视图（`boardView`/`unitView`/`buildingView`/`handView`，各自已合规）的 `destroy()` 排在 `unsubs`/`drag`/`profilePopup`/`vfxSystem` 等步骤**之后**，且整个方法没有分步 try/catch：只要前面任一步抛错，四个子视图的 tick 注销代码就执行不到，原样复现 §2 事故的机制。修复：子视图 destroy 提到最前，且每一步都包一层 `safeDestroyStep(name, fn)`（try/catch + `netLog` 记录，不中断后续步骤）——这是本次审计里离“真的再炸一次”最近的一处结构性隐患。
3. **`CampaignMapScene` 翻页内反复裸销毁——审计时判定为真实泄漏，写测试验证时发现是误判，改口记在这里**：初审时看到 `showPage()`/`advanceFlip()` 的 `.destroy({children:true})` 没有先过 `tearDownChildren`，比照 §8.2 的模式（overlay 反复开关漏 Text 纹理）判定为同类泄漏并已打了 `tearDownChildren(root)` 补丁。但补充回归测试（`test/ui/campaignMapTextTeardown.ui.ts`）时用真实 `PIXI.Text.prototype.destroy` 结果（而非调用参数）做前后对比，发现**这三处原本的 `.destroy({children:true})` 已经能正确释放嵌套 Text 的纹理**——根源是这个 PIXI 版本里 `Text.destroy(options)` 内部会用 `Object.assign({}, defaultDestroyOptions, options)` 合并自己的默认值（`texture:true, baseTexture:true`），只要顶层调用带了 `children:true`（本例始终如此），无论中间层是否显式传 `texture:true`，递归到 Text 节点时都会补上 —— 也就是说本节 §8.2/§8.4 描述的"`{children:true}` 传给子节点时 texture 默认 false"这条规则，只对**非 Text**节点（Sprite/Graphics）成立，对 Text 节点本身不成立（Text 自己会補上默认值，不管上层传了什么）。真正会漏的只有两种写法：完全不传 `children:true`（如 `f.out.destroy()`）、或裸 `removeChildren()`/`removeChildren().forEach(c=>c.destroy())`（只删顶层，不递归到子容器内部更深的 Text）——用这两种写法重新跑同一份测试，纹理确实没释放，测试也确实能抓到。结论：`tearDownChildren` 补丁本身无害、且与全仓库约定一致，**但没有改变 CampaignMapScene 的实际泄漏行为**（此前也没有泄漏）；测试因此改为验证真实结果（纹理是否真被释放），而不是验证调用参数形状，这样才能在"没有实质差异"的情况下仍然扎实地防住真正危险的写法（漏 `children:true` / 裸 `removeChildren`）。**这也提示 §8.5 里"其余 ~24 个场景仍是同款裸写法、有泄漏风险"的判断可能同样过于悲观**——如果那些场景的裸写法也是 `.destroy({children:true})`（而非真的漏 `children:true` 或裸 `removeChildren`），按同样的道理它们的 Text 纹理可能也已经被正确释放，需要重新用这个方法逐一验证才能下结论，本次未对那 24 个场景重新验证（见 [[open]] 里的记录）。
4. **`TitlesScene.destroy()` 漏调用 `container.destroy()`**——只调了 `tearDownChildren`（Text 纹理已释放），容器对象本身未销毁，补了一行，非泄漏、小疵。

### 8.7 §8.5「~24 个剩余场景」逐一重新验证（2026-08-03，同日第三轮）

> 结论：**§8.5 的悲观判断不成立**——这 24 个场景全部安全，没有一个真的漏 Text 纹理。§8.5 整节判断已作废（保留原文供对照历史，不再具有指导意义）。

按 §8.6 point 3 的方法（捕获销毁前的 `PIXI.BaseTexture` 引用，销毁后直接检查 `.destroyed`，而不是看调用参数形状）逐一核实了 §8.5 点名的场景：`LoginScene`/`ChatScene`/`SettingsScene`/`ShopScene`/`FriendsScene`/`LobbyScene`/`GachaScene`/`EquipmentScene`/`IntroScene`/`CardCodexScene`/`StatsScene`/`RoomScene`/`LevelPrepScene`/`ResultScene`，以及此前从未进过 `test/ui/scenes.ui.ts` 通用注册表、因而从未被这套契约测试覆盖过的 9 个场景——`BattlePassScene`/`DeckBuilderScene`/`LeaderboardScene`/`AchievementScene`/`DailyScene`/`EventScene`/`RechargeScene`/`DefenseEditorScene`（defense 模式）/`CardScene`。

**结果**：全部 23 个场景的 `destroy()` 都是 `this.container.destroy({ children: true })`（或等价的 `for (const u of this.unsubs) u()` 之类订阅清理 + 同一行销毁），没有一个是真正危险的写法（完全不传 `children:true`，或裸 `removeChildren()`/`removeChildren().forEach(c=>c.destroy())` 只删顶层不递归）。按 §8.6 point 3 证实的 PIXI 行为——`PIXI.Text.destroy(options)` 内部合并自己的 `defaultDestroyOptions`（`texture:true, baseTexture:true`），只要 `children:true` 从顶层传下来就会递归触发——这些场景的嵌套 Text 纹理**已经**在 `.destroy({children:true})` 那一刻被正确释放，不需要 `tearDownChildren`，也从未真的泄漏过。

**落地方式**：没有另写 23 个一次性断言，而是把这个校验直接焼进 `test/ui/scenes.ui.ts` 的共享 `exercise()`——原先只断言 `container.destroyed===true`，现在额外收集销毁前所有 `PIXI.Text` 的 `baseTexture` 引用，销毁后断言全部 `.destroyed===true`。这样**已注册的全部场景**（含未来新增的）都自动获得这条 Text 纹理回归防护，不必逐场景手写。9 个此前从未注册过的场景（`BattlePassScene` 等）借这次机会一并补进注册表——它们此前完全没有 `destroy()` 回归测试（不只是 Text 纹理这一项，连 §7 的"容器真的销毁了"都没测过），这本身也是和 `TitlesScene` 同类的"漏注册"缺口。用 `RechargeScene` 故意改成 `this.container.destroy()`（不传 `children:true`）复测过，新断言确实会失败——校验有效，不是形同虚设。

**范围外**：`StatePlayerScene`/`ReplayScene`（`.destroy({children:true})`，人工读码确认安全，未进注册表——这两个是战斗视图，需要完整引擎/GameRenderer 起来，`scenes.ui.ts` 文件头本就声明"战斗类场景不在本文件范围，留给更重的 render smoke"）、`GameScene`（完全委托给 `this.renderer.destroy()`，即 `GameRenderer`，已在本文档 §8.6 point 1/2 专项审计过）。

审计同时确认：全代码库 90 处 `input.onDown/onMove/onUp/onWheel` 订阅、33 个场景的 `destroy()` 存在性均合规，无新增遗漏（唯一发现的口子已如上修复）；`DefenseEditorScene` 缺失 `SaveManager.onSaveChanged` 订阅是数据共享类问题，见 [`client-modules.md`](client-modules.md) §34 同日更新，不是本节内存契约范畴。
