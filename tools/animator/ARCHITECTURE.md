# Stickman Animation Editor — Architecture Document

> 版本 v0.2 · 2026-05-26（对照 REQUIREMENTS.md v0.1 全量审查后更新）

---

## 1. 背景与问题

现有代码为"函数式模块"风格（基于 TypeScript，但写法接近 JS 模块）。核心问题：

| 问题 | 描述 |
|------|------|
| 隐式共享状态 | `state` 和 `currentDeltas` 是导出的全局对象，所有模块直接读写，没有边界 |
| 模块级变量当实例变量 | `timeline.ts` 中 `let canvas`, `let ctx`, `let isScrubbing` 本质是私有字段，但散落在模块顶层 |
| 事件系统无类型 | `emit(STATUS, msg)` / `on(BONE_SELECT, fn)` 均为 `any`，重构时无编译器保护 |
| 坐标换算错误 | `getRendererSize()` 返回物理像素（logical × devicePixelRatio），导致鼠标坐标与骨骼坐标系不匹配，无法选中骨骼 |
| `initXxx()` 模式 | 每个模块有生命周期和内部状态，本质是未写出来的 class |

---

## 2. 设计目标

1. **强类型** — 全程 TypeScript strict，无 `any`，事件 payload 编译期可验证
2. **职责明确** — 每个 class 只做一件事，依赖方向单向（向下/向内）
3. **可测试** — 核心逻辑（FK、动画插值、hit-test）是纯函数，无 DOM/PIXI 依赖
4. **坐标正确** — 鼠标坐标统一由 `Renderer.toStageCoords()` 转换，不在外部手动换算
5. **可撤销** — 所有破坏性操作通过 Command 模式提交，支持 Undo/Redo

---

## 3. 整体架构

```
App
├── EventBus<AppEvents>          ← 强类型事件总线
├── AppState                     ← UI + 绑定状态，setter 自动 emit
├── CommandManager               ← Undo/Redo 栈（新增）
├── Skeleton (static)            ← 骨骼定义 + FK 纯函数，不实例化
├── AtlasController              ← Atlas 导入/解析/管理（新增）
├── AnimationController          ← 动画数据管理 + 播放引擎
├── Renderer                     ← PixiJS 薄封装，draw(RenderData)
├── InteractionController        ← 鼠标/键盘，hit-test → Command
├── TimelineView                 ← Canvas 时间轴渲染 + scrub + KF 拖拽
├── AnimListPanel                ← 左侧动画列表面板
├── BoneInspectorPanel           ← 右侧骨骼属性 + Sprite 绑定面板
├── AtlasPanel                   ← 右侧 Atlas 帧浏览（新增）
├── ToolbarPanel                 ← 顶部工具栏（含预览模式切换）
├── StatusBar                    ← 底部状态栏（含 Undo label）
└── IOController                 ← JSON 导入/导出
```

`App` 是唯一持有所有子系统引用的根对象。子系统之间不直接引用彼此，通过 `EventBus` 通信。  
**例外**：`CommandManager` 被注入到需要提交操作的控制器（AnimationController、InteractionController、AtlasController），这是有意的直接依赖。

---

## 4. 目录结构

```
src/
  core/
    EventBus.ts                  # EventBus<T> + AppEvents interface
    AppState.ts                  # UI + 绑定状态 class，setter 内部 emit
    CommandManager.ts            # Command 接口 + Undo/Redo 栈（新增）
    types.ts                     # 纯数据接口（无逻辑）
  skeleton/
    Skeleton.ts                  # static FK utils，BoneDef 定义，BONE_MAP
  atlas/
    AtlasController.ts           # Atlas 导入/解析/管理（新增）
  animation/
    AnimationController.ts       # play/pause/stop, keyframe CRUD, lerp
    interpolate.ts               # 插值 + easing 纯函数（可独立测试）
    presets.ts                   # 内置预设动画数据
  rendering/
    Renderer.ts                  # PixiJS 薄封装
  interaction/
    InteractionController.ts     # 鼠标/键盘事件，hit-test → Command
  timeline/
    TimelineView.ts              # Canvas 时间轴
    ContextMenu.ts               # 右键菜单组件（新增）
  ui/
    AnimListPanel.ts
    BoneInspectorPanel.ts
    AtlasPanel.ts                # Atlas 帧浏览面板（新增）
    ToolbarPanel.ts
    StatusBar.ts
  io/
    IOController.ts
  App.ts                         # 根协调器
  index.ts                       # 唯一入口：new App(document.body)

runtime/                         # 游戏侧 runtime（共享 core/types.ts）
  StickmanRuntime.ts
  README.md
```

---

## 5. 核心模块规格

### 5.1 `types.ts`（完整定义）

```ts
// ── 骨骼定义 ───────────────────────────────────────────────────────────────────

export interface BoneDef {
  id: string;
  parent: string | null;
  len: number;
  rwa: number;        // rest world angle (degrees)
  rla: number;        // rest local angle = rwa - parent.rwa
  outerW?: number;
  innerW?: number;
  isHead?: boolean;
  label: string;
}

export interface WorldPose {
  sx: number; sy: number;   // pivot (start)
  ex: number; ey: number;   // tip (end)
  wa: number;               // world angle (degrees)
}

export type WorldPositions = ReadonlyMap<string, WorldPose>;

// ── Easing ────────────────────────────────────────────────────────────────────

export type EasingType =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'step';           // 跳变，用于精灵切换

// ── 关键帧 ────────────────────────────────────────────────────────────────────

/** 单块骨骼在单个关键帧的所有可动画属性。所有字段可选，缺省时插值使用默认值。 */
export interface BoneKeyframe {
  rotation?:   number;        // delta degrees，default 0
  scaleX?:     number;        // default 1
  scaleY?:     number;        // default 1
  translateX?: number;        // px，default 0
  translateY?: number;        // px，default 0
  alpha?:      number;        // 0–1，default 1
  frameId?:    string | null; // 精灵切换，null = 隐藏，undefined = 沿用 binding
  easing?:     EasingType;    // 出点曲线，default 'linear'
}

/** 插值计算后的骨骼完整变换（所有字段均有值）。 */
export interface ResolvedBoneTransform {
  rotation:   number;
  scaleX:     number;
  scaleY:     number;
  translateX: number;
  translateY: number;
  alpha:      number;
  frameId:    string | null;  // null = 隐藏该骨骼精灵
}

export interface Keyframe {
  time:  number;
  bones: Map<string, BoneKeyframe>;
}

export interface AnimationClip {
  duration:  number;
  loop:      boolean;
  keyframes: Keyframe[];
}

export type AnimationStore = Map<string, AnimationClip>;

// ── Sprite 绑定 ────────────────────────────────────────────────────────────────

/** 结构性配置：描述精灵如何挂在骨骼上，整个项目不变，不可关键帧化。 */
export interface SpriteBinding {
  frameId: string;    // atlas 默认帧 id
  anchorX: number;    // 0–1，默认 0.5
  anchorY: number;    // 0–1，默认 0.5
  flipX:   boolean;
}

// ── Atlas ─────────────────────────────────────────────────────────────────────

export interface AtlasFrame {
  x: number; y: number;
  w: number; h: number;
  pivotX: number; pivotY: number;
}

export interface AtlasAsset {
  id:     string;                       // 文件名（不含扩展名）
  frames: Map<string, AtlasFrame>;      // frameId → AtlasFrame
  // PIXI.Texture 由 AtlasController 在内部管理，不放在此接口
}
```

---

### 5.2 `EventBus<T>`

```ts
interface AppEvents {
  // 骨骼交互
  'bone:select':    string | null;
  'bone:rotate':    { id: string; delta: number };

  // 时间 / 播放
  'time:change':    number;
  'play:state':     boolean;

  // 动画管理
  'anim:select':    string;
  'anim:list':      void;
  'kf:change':      void;

  // Atlas / 绑定（新增）
  'atlas:change':   void;                        // atlas 加载/删除
  'binding:change': string;                      // boneId，绑定变更

  // 预览模式（新增）
  'preview:mode':   'skeleton' | 'sprite';

  // Undo/Redo（新增）
  'history:change': { canUndo: boolean; canRedo: boolean; label: string };

  // 其他
  'status':         string;
  'pose:reset':     void;
}

class EventBus<T extends Record<string, unknown>> {
  on<K extends keyof T>(event: K, fn: (payload: T[K]) => void): () => void;
  off<K extends keyof T>(event: K, fn: (payload: T[K]) => void): void;
  emit<K extends keyof T>(event: K, payload: T[K]): void;
}
```

---

### 5.3 `CommandManager`（新增）

```ts
interface Command {
  execute(): void;
  undo(): void;
  readonly label: string;
}

class CommandManager {
  constructor(private bus: EventBus<AppEvents>) {}

  /** 执行并入栈。清空 redoStack。 */
  execute(cmd: Command): void;

  undo(): void;
  redo(): void;

  get canUndo(): boolean;
  get canRedo(): boolean;
  get undoLabel(): string;   // "Undo: Add Keyframe @ 0.250s"
  get redoLabel(): string;

  clear(): void;             // 加载新项目时清空

  // 栈上限 100 条，超出丢弃最旧
}
```

**Command 使用原则**：
- `AnimationController` 的所有数据变更方法均为**纯变更**（不提交 Command）
- 调用方（InteractionController、UI panels）负责包装 Command 并提交给 CommandManager
- 骨骼拖拽期间直接调用 `animCtrl.setBoneDelta()`（实时预览），**mouseUp 时**才提交一条 `RotateBoneCommand`

---

### 5.4 `AppState`

```ts
class AppState {
  constructor(private bus: EventBus<AppEvents>) {}

  // ── UI 状态 ──────────────────────────────────────────────────────────────────
  get selectedBone(): string | null
  get currentTime(): number
  get isPlaying(): boolean
  get playSpeed(): number
  get looping(): boolean
  get panOffsetX(): number
  get panOffsetY(): number
  get selectedKfTime(): number | null
  get rootX(): number
  get rootY(): number

  setSelectedBone(id: string | null): void    // emit 'bone:select'
  setCurrentTime(t: number): void              // emit 'time:change'
  setPlaying(v: boolean): void                 // emit 'play:state'
  setPlaySpeed(v: number): void
  setLooping(v: boolean): void
  setPanOffset(x: number, y: number): void
  setRootPos(x: number, y: number): void
  setSelectedKfTime(t: number | null): void

  // ── 预览模式（新增）─────────────────────────────────────────────────────────
  get previewMode(): 'skeleton' | 'sprite'
  get showSkeletonOverlay(): boolean          // 精灵模式下叠加骨架线
  get showJoints(): boolean
  get showOnion(): boolean
  get showGuide(): boolean
  get showPivots(): boolean                   // 显示 pivot 点（新增）
  get backgroundColor(): number              // hex color（新增）

  setPreviewMode(mode: 'skeleton' | 'sprite'): void  // emit 'preview:mode'
  setShowSkeletonOverlay(v: boolean): void
  setShowJoints(v: boolean): void
  setShowOnion(v: boolean): void
  setShowGuide(v: boolean): void
  setShowPivots(v: boolean): void
  setBackgroundColor(hex: number): void

  // ── Sprite 绑定（新增）──────────────────────────────────────────────────────
  get boneBindings(): ReadonlyMap<string, SpriteBinding>

  setBinding(boneId: string, binding: SpriteBinding): void   // emit 'binding:change'
  removeBinding(boneId: string): void                         // emit 'binding:change'
  getBinding(boneId: string): SpriteBinding | undefined
}
```

---

### 5.5 `Skeleton`（static）

```ts
class Skeleton {
  static readonly BONE_DEFS: BoneDef[];
  static readonly BONE_MAP: ReadonlyMap<string, BoneDef>;
  static readonly DRAW_ORDER: readonly string[];
  static readonly SELECTABLE_BONES: readonly string[];
  static readonly TIMELINE_BONES: readonly string[];
  static readonly HEAD_R = 24;

  /** Forward kinematics：计算所有骨骼的世界坐标。纯函数，无副作用。 */
  static computeFK(rootX: number, rootY: number, transforms: Map<string, ResolvedBoneTransform>): WorldPositions;
  // 注：rotation 字段用于 FK 计算，scaleXY/translateXY 用于精灵变换，由 Renderer 分开处理
}
```

---

### 5.6 `AtlasController`（新增）

```ts
class AtlasController {
  constructor(
    private bus: EventBus<AppEvents>,
    private cmdManager: CommandManager,
  ) {}

  /** 从 File 对象导入（JSON + PNG 一起或分开传入）。 */
  async importAtlas(jsonFile: File, imageFile: File): Promise<void>;

  removeAtlas(atlasId: string): void;   // 同时解绑使用该 atlas 帧的骨骼 → Command

  get atlases(): ReadonlyMap<string, AtlasAsset>
  getFrame(frameId: string): AtlasFrame | undefined
  getTexture(frameId: string): PIXI.Texture | undefined   // 内部维护 PIXI.Texture 缓存
  getAllFrameIds(): string[]
}
```

---

### 5.7 `animation/interpolate.ts`（新提取）

插值逻辑从 `AnimationController` 中分离为纯函数，方便测试和 runtime 共享。

```ts
/** 对单个属性应用 easing。 */
export function applyEasing(t: number, type: EasingType): number;

/** 在两个 BoneKeyframe 之间插值，返回 ResolvedBoneTransform。 */
export function interpolateBone(
  kf1: BoneKeyframe,
  kf2: BoneKeyframe,
  f: number,           // easing 计算后的插值因子
): ResolvedBoneTransform;

/** 在整个 AnimationClip 中采样时间 t，返回每块骨骼的完整变换。 */
export function sampleClip(
  clip: AnimationClip,
  t: number,
): Map<string, ResolvedBoneTransform>;
```

---

### 5.8 `AnimationController`

```ts
class AnimationController {
  constructor(
    private bus: EventBus<AppEvents>,
    private state: AppState,
  ) {}

  // ── 数据访问 ─────────────────────────────────────────────────────────────────
  get store(): Readonly<AnimationStore>
  get currentClip(): AnimationClip | null

  /** 当前时间的插值结果（含拖拽中的实时 delta）。 */
  getCurrentFrame(): Map<string, ResolvedBoneTransform>

  /** 供 onion skin 使用：返回相邻关键帧时间点的变换。 */
  getOnionFrames(): Map<string, ResolvedBoneTransform>[]

  // ── 播放控制 ─────────────────────────────────────────────────────────────────
  play(): void
  pause(): void
  stop(): void
  toggle(): void

  // ── 关键帧操作（纯数据变更，不提交 Command，由调用方包装） ──────────────────
  addKeyframeAt(time: number, bones?: Map<string, BoneKeyframe>): void
  deleteKeyframeAt(time: number): void
  moveKeyframe(oldTime: number, newTime: number): void           // 时间轴拖拽
  updateKeyframeProp(time: number, boneId: string, props: Partial<BoneKeyframe>): void
  copyKeyframe(time: number): void                               // 存入内部剪贴板
  pasteKeyframe(time: number): void                              // 从剪贴板粘贴
  getPrevKeyframe(): Keyframe | null
  getNextKeyframe(): Keyframe | null

  // ── Clip 管理（不提交 Command） ───────────────────────────────────────────────
  createClip(name: string): void
  deleteClip(name: string): void
  renameClip(oldName: string, newName: string): void
  selectClip(name: string): void
  setDuration(seconds: number): void
  loadPreset(name: string): void

  // ── 实时拖拽（不提交 Command，mouseUp 时由 InteractionController 提交） ──────
  setBoneDelta(boneId: string, rotationDelta: number): void
  resetPose(): void
}
```

---

### 5.9 `Renderer`

```ts
/** 每帧传入 Renderer 的完整渲染数据。 */
interface RenderData {
  // 骨骼变换（FK 位置 + 插值属性）
  worldPose:    WorldPositions;
  boneTransforms: Map<string, ResolvedBoneTransform>;  // 含 scale/alpha/translate/frameId

  // 精灵资源
  bindings:     ReadonlyMap<string, SpriteBinding>;
  getTexture:   (frameId: string) => PIXI.Texture | undefined;

  // 渲染选项
  previewMode:          'skeleton' | 'sprite';
  selectedBone:         string | null;
  showJoints:           boolean;
  showSkeletonOverlay:  boolean;   // 精灵模式下叠加骨架线
  showGuide:            boolean;
  showPivots:           boolean;
  backgroundColor:      number;
  rootX:                number;
  rootY:                number;
  onionData:            Array<{
    worldPose: WorldPositions;
    boneTransforms: Map<string, ResolvedBoneTransform>;
  }>;
}

class Renderer {
  constructor(container: HTMLElement) {}

  draw(data: RenderData): void

  /** 屏幕坐标 → PixiJS stage 逻辑坐标（修复 devicePixelRatio 问题）。 */
  toStageCoords(clientX: number, clientY: number): { x: number; y: number }

  get logicalSize(): { w: number; h: number }
  resize(w: number, h: number): void
  destroy(): void

  // 内部实现：logicalSize 除以 resolution 得到逻辑像素
}
```

---

### 5.10 `InteractionController`

```ts
class InteractionController {
  constructor(
    private renderer: Renderer,
    private bus: EventBus<AppEvents>,
    private state: AppState,
    private animCtrl: AnimationController,
    private cmdManager: CommandManager,         // 新增
  ) {}

  private findBoneAt(stageX: number, stageY: number): string | null;
  private onMouseDown(e: MouseEvent): void;
  private onMouseMove(e: MouseEvent): void;
  private onMouseUp(): void;    // 提交 RotateBoneCommand（若有拖拽）
  private onKeyDown(e: KeyboardEvent): void;
  // Tab → state.setPreviewMode(toggle)
  // Ctrl+Z → cmdManager.undo()
  // Ctrl+Shift+Z / Ctrl+Y → cmdManager.redo()
  // K → addKeyframe Command
  // Delete → deleteKeyframe Command
}
```

---

### 5.11 `TimelineView`

```ts
class TimelineView {
  constructor(
    private canvasEl: HTMLCanvasElement,
    private labelContainer: HTMLElement,
    private bus: EventBus<AppEvents>,
    private state: AppState,
    private animCtrl: AnimationController,
    private cmdManager: CommandManager,         // 新增，KF 拖拽提交 Command
  ) {}

  render(): void
  destroy(): void

  // 内部：KF 拖拽结束 → MoveKeyframeCommand → cmdManager.execute()
  // 内部：右键 KF → ContextMenu（edit easing / copy / paste / delete）
}
```

---

### 5.12 UI Panels

```ts
class AnimListPanel {
  constructor(
    el: HTMLElement,
    bus: EventBus<AppEvents>,
    animCtrl: AnimationController,
    cmdManager: CommandManager,
  ) {}
}

class BoneInspectorPanel {
  constructor(
    el: HTMLElement,
    bus: EventBus<AppEvents>,
    state: AppState,
    animCtrl: AnimationController,
    atlasCtrl: AtlasController,        // 新增，帧选择器需要
    cmdManager: CommandManager,
  ) {}
}

class AtlasPanel {                      // 新增
  constructor(
    el: HTMLElement,
    bus: EventBus<AppEvents>,
    atlasCtrl: AtlasController,
  ) {}
}

class ToolbarPanel {
  constructor(
    el: HTMLElement,
    bus: EventBus<AppEvents>,
    state: AppState,
    animCtrl: AnimationController,
    cmdManager: CommandManager,
  ) {}
  // 新增：预览模式切换按钮、Undo/Redo 按钮（绑定 history:change 事件更新 disabled 状态）
}

class StatusBar {
  constructor(el: HTMLElement, bus: EventBus<AppEvents>) {}
  // history:change → 显示 "Undo: RotateBone" 等提示
}
```

---

### 5.13 `IOController`

```ts
class IOController {
  constructor(
    private state: AppState,
    private animCtrl: AnimationController,
    private atlasCtrl: AtlasController,
    private cmdManager: CommandManager,
    private bus: EventBus<AppEvents>,
  ) {}

  exportProject(): void;    // 序列化 bindings + animations → .animator.json
  importProject(file: File): Promise<void>;   // 反序列化，cmdManager.clear()
}
```

---

### 5.14 `App`

```ts
class App {
  constructor(rootEl: HTMLElement) {
    // 1. 基础设施
    const bus        = new EventBus<AppEvents>();
    const state      = new AppState(bus);
    const cmdManager = new CommandManager(bus);

    // 2. 渲染
    const renderer = new Renderer(rootEl.querySelector('#canvas-wrap')!);

    // 3. 控制器
    const atlasCtrl = new AtlasController(bus, cmdManager);
    const animCtrl  = new AnimationController(bus, state);
    const interaction = new InteractionController(renderer, bus, state, animCtrl, cmdManager);

    // 4. 视图 + panels
    const timeline = new TimelineView(
      rootEl.querySelector('#timeline-canvas') as HTMLCanvasElement,
      rootEl.querySelector('#tl-labels')!,
      bus, state, animCtrl, cmdManager,
    );
    new AnimListPanel(rootEl.querySelector('#anim-list')!,     bus, animCtrl, cmdManager);
    new BoneInspectorPanel(rootEl.querySelector('.right-panel')!, bus, state, animCtrl, atlasCtrl, cmdManager);
    new AtlasPanel(rootEl.querySelector('#atlas-panel')!,      bus, atlasCtrl);
    new ToolbarPanel(rootEl.querySelector('.toolbar')!,        bus, state, animCtrl, cmdManager);
    new StatusBar(rootEl.querySelector('#status-text')!,       bus);
    new IOController(state, animCtrl, atlasCtrl, cmdManager, bus);

    // 5. 主渲染循环
    renderer.pixiApp.ticker.add(() => {
      const frame     = animCtrl.getCurrentFrame();
      const worldPose = Skeleton.computeFK(state.rootX, state.rootY, frame);
      renderer.draw({
        worldPose,
        boneTransforms:       frame,
        bindings:             state.boneBindings,
        getTexture:           (id) => atlasCtrl.getTexture(id),
        previewMode:          state.previewMode,
        selectedBone:         state.selectedBone,
        showJoints:           state.showJoints,
        showSkeletonOverlay:  state.showSkeletonOverlay,
        showGuide:            state.showGuide,
        showPivots:           state.showPivots,
        backgroundColor:      state.backgroundColor,
        rootX:                state.rootX,
        rootY:                state.rootY,
        onionData:            state.showOnion ? animCtrl.getOnionFrames().map(f => ({
          worldPose: Skeleton.computeFK(state.rootX, state.rootY, f),
          boneTransforms: f,
        })) : [],
      });
    });

    // 6. 时间轴循环
    (function tlLoop() { timeline.render(); requestAnimationFrame(tlLoop); })();

    // 7. 预设
    (['idle', 'walk', 'attack', 'hurt', 'death', 'spawn'] as const)
      .forEach(name => animCtrl.loadPreset(name));
    animCtrl.selectClip('walk');
  }
}
```

---

## 6. 数据流（更新）

```
用户点击 canvas
  → InteractionController.onMouseDown()
  → renderer.toStageCoords()             ← 正确坐标转换
  → findBoneAt()                         ← hit-test（纯函数）
  → state.setSelectedBone(id)            ← emit 'bone:select'
      → BoneInspectorPanel 更新 DOM
      → TimelineView 高亮骨骼行

用户拖拽骨骼
  → onMouseMove() → animCtrl.setBoneDelta()   ← 实时预览，不提交 Command
  → onMouseUp()   → cmdManager.execute(new RotateBoneCommand(...))
                  → emit 'history:change'
                  → ToolbarPanel 更新 Undo 按钮状态

用户 Ctrl+Z
  → InteractionController.onKeyDown()
  → cmdManager.undo()
  → 对应 Command.undo() 恢复数据
  → emit 'kf:change' / 'bone:select' 等
  → emit 'history:change'

Atlas 导入
  → AtlasController.importAtlas()
  → 解析 JSON + 加载图片 → 创建 PIXI.Texture 缓存
  → emit 'atlas:change'
      → AtlasPanel 刷新缩略图列表
      → BoneInspectorPanel 帧选择器更新

绑定精灵到骨骼
  → BoneInspectorPanel 用户选择帧
  → cmdManager.execute(new SetBindingCommand(boneId, binding))
      → state.setBinding(boneId, binding)   ← emit 'binding:change'
      → animCtrl.addKeyframeAt(0, ...)      ← 若 t=0 无该骨骼 KF，自动创建
  → emit 'kf:change' → TimelineView 刷新

播放动画
  → AnimationController RAF loop
  → state.setCurrentTime(t)           ← emit 'time:change'
  → sampleClip(clip, t)               ← 返回 Map<boneId, ResolvedBoneTransform>
  → ticker 帧：renderer.draw()        ← 精灵 + 骨架同步渲染
```

---

## 7. 游戏侧 Runtime（`runtime/`）

与编辑器共享 `src/core/types.ts` 和 `src/animation/interpolate.ts`，不依赖任何编辑器 UI 模块。

```ts
// runtime/StickmanRuntime.ts

interface RuntimeOptions {
  atlasJson:  string;              // URL
  atlasImage: string;              // URL
  animData:   string;              // URL，.animator.json
  container:  PIXI.Container;
}

class StickmanRuntime {
  constructor(options: RuntimeOptions) {}

  async load(): Promise<void>

  play(name: string, opts?: { loop?: boolean; onComplete?: () => void }): void
  pause(): void
  stop(): void
  setSpeed(v: number): void
  destroy(): void
}
```

内部循环：`sampleClip(clip, t)` → 对每块 `PIXI.Container` 设置 `rotation / scale / position / alpha` → 更新 `PIXI.Sprite.texture`。

---

## 8. 重构顺序（建议）

按依赖从底向上，每步独立可验证：

1. `core/types.ts` — 完整类型定义（BoneKeyframe、ResolvedBoneTransform、EasingType 等）
2. `core/EventBus.ts` — 泛型 EventBus + AppEvents
3. `skeleton/Skeleton.ts` — static class，computeFK 接受 `Map<string, ResolvedBoneTransform>`
4. `animation/interpolate.ts` — 纯函数，可单独单测
5. `core/CommandManager.ts` — Command 接口 + 栈管理
6. `core/AppState.ts` — 含 boneBindings、previewMode 等新字段
7. `atlas/AtlasController.ts`
8. `animation/AnimationController.ts` — 注入新依赖，更新 API
9. `rendering/Renderer.ts` — 更新 RenderData，支持精灵渲染
10. `interaction/InteractionController.ts` — 注入 CommandManager，Tab / Ctrl+Z 快捷键
11. `timeline/TimelineView.ts` + `ContextMenu.ts`
12. UI Panels（BoneInspectorPanel、AtlasPanel、ToolbarPanel、StatusBar、AnimListPanel）
13. `io/IOController.ts`
14. `App.ts` + `index.ts`
15. `runtime/StickmanRuntime.ts`（可独立开发）
