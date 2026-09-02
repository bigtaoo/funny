/**
 * wechatHost.ts — 微信小游戏宿主表面（ASSET_PACKAGING §4.3 / LOG §17）。
 *
 * **这个文件必须是 `entries/wechat.ts` 的第一个 import，早于 `@pixi/unsafe-eval`。**
 * 理由不是洁癖：`@pixi/settings/lib/utils/isMobile.mjs` 在**模块顶层**执行
 * `isMobileCall(globalThis.navigator)`。ESM 先把所有 import 求值完才跑模块体，所以写在入口
 * 函数体里的一句 `install()` **来不及**——必须靠 import 顺序。本文件因此**零 import**
 * （PIXI 那半在 `wechatPixiAdapter.ts`，它可以晚一步）。
 *
 * ## 为什么需要它：微信构建一直靠别人的兼容层活着
 *
 * PIXI v7 有两类宿主依赖：走 `settings.ADAPTER` 的（干净接缝，见 `wechatPixiAdapter.ts`），
 * 和**绕过 adapter 直接嗅探 DOM 的**：
 *
 * | 调用点 | 摸什么 | 不满足时 |
 * |---|---|---|
 * | `CanvasResource.test` | `source instanceof HTMLCanvasElement` | 「Unrecognized source type」——2026-09-01 黑屏本体 |
 * | `ImageResource.test` | `typeof HTMLImageElement !== 'undefined'`，然后 `new Image()` | 字符串 url 匹配不到任何 resource，抛 |
 * | `determineCrossOrigin` | `new URL(url, document.baseURI)` | 相对路径直接抛 TypeError |
 * | `EventSystem.addEvents` | `globalThis.navigator.msPointerEnabled`、`globalThis.document.addEventListener` | 抛（funny 有 61 处 `eventMode`，删不掉这个系统） |
 * | `EventsTicker` | `globalThis.document.dispatchEvent(new PointerEvent(...))` | 抛 |
 * | `isMobile`（模块顶层） | `globalThis.navigator` | import 期就抛 |
 *
 * 这些以前全由**基础库自带的 DOM 兼容层**兜着，没人声明过这层依赖。canary 3.17.2 少了几个
 * 全局类绑定，第一个症状就是黑屏。
 *
 * ## ⚠️ 最贵的一条（来自 `D:\daydayup` 的 `design/04-wechat.md`，他们为此付了两次线上 bug）
 *
 * > **`document` 在开发者工具模拟器里存在，在真机上不存在。**
 *
 * 所以本文件**绝不从 `document` 派生任何东西**——类绑定一律从 `wx.createCanvas()` /
 * `wx.createImage()` 的**实际产物**上取。模拟器里 `document.createElement('canvas')` 确实能用、
 * 甚至 `constructor.name` 恰好就是 `HTMLCanvasElement`（本机实测），照它写会在模拟器里全绿、
 * 到真机上 `ReferenceError`。**funny 至今没在真机上跑过，所以这条我们还没付过费，是白捡的。**
 *
 * 相应地这里补的 `document` 是**极小实现**，故意**不含 `createElement`**：任何真需要它的路径
 * 应该响亮地失败，而不是在模拟器里假装健康。
 */

/** 本文件用到的 wx 表面切片（`wx.d.ts` 里有完整声明）。 */
declare const wx: {
  createCanvas(): unknown;
  createImage(): unknown;
  getSystemInfoSync?(): { pixelRatio?: number };
};

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

/**
 * 上屏 canvas，只解析一次。
 *
 * 裸全局 `canvas` 从来不是文档 API（适配层给的，基础库 3.17.2 canary 起不再提供）。文档契约是
 * `wx.createCanvas()`：**第一次**调用返回上屏 canvas，之后都是离屏 2D 子 canvas。两条承重约束：
 *
 * - **必须是进程里第一个 `createCanvas`**。本文件是入口第一个 import，且下面的类嗅探**复用这张
 *   上屏 canvas**（同一个工厂 ⇒ 同一个类），不会多要一张把上屏偷掉。
 * - **必须记忆化**，否则第二次 `getCanvas()` 拿到离屏 canvas，渲染进虚空——同一个黑屏，隔了一层。
 */
let screen: unknown;
export function screenCanvas(): unknown {
  if (screen) return screen;
  screen =
    (g.canvas as unknown) ??
    ((g.GameGlobal as Globals | undefined)?.canvas as unknown) ??
    wx.createCanvas();
  return screen;
}

/** 装过没有——`install` 幂等，重复调用不重复嗅探。 */
let installed = false;

/**
 * 把这个运行时缺的宿主表面补上。**全部 `??=` 语义**（缺了才补），所以：
 * - 旧基础库 / 模拟器上是几乎完全的 no-op（它们自带 shim）；
 * - 真机上我们自己提供；
 * 一份代码两处都能跑，这也是为什么 P4「已发布库上也必须绿」是验收条件的一半。
 */
export function installWechatHost(): void {
  if (installed) return;
  installed = true;

  // ── 类绑定：实现都在，只是没挂到全局 ──────────────────────────────────────
  // 依据（本机 host-probe 实测）：`wx.createCanvas()` 的 constructor.name 是 `HTMLElement`，
  // `wx.createImage()` 的是 `HTMLImageElement`，`document.createElement('canvas')` 的是
  // `HTMLCanvasElement`——**前两者才是真机上一定存在的东西**，所以绑前两者。
  //
  // 注意 canvas 那条：上屏 canvas 与之后的离屏子 canvas 出自同一个工厂、同一个类，所以用上屏那
  // 张来嗅探是安全的，而且省掉一次「第一次 createCanvas」的争夺。
  g.HTMLCanvasElement ??= (screenCanvas() as { constructor: unknown }).constructor;

  if (g.HTMLImageElement === undefined || g.Image === undefined) {
    const probe = wx.createImage() as { constructor: unknown };
    g.HTMLImageElement ??= probe.constructor;
    // `new Image()`：构造函数返回对象时 `new` 就用那个对象，所以这个工厂足够。
    // PIXI 的 `ImageResource` 随后设 `.src`、读 `.complete`/`.width`/`.height`、挂
    // `onload`/`onerror`——wx image 全都有，除了 `complete`（缺席即 falsy，正好走 onload 那条）。
    g.Image ??= function Image(): unknown { return wx.createImage(); };
  }

  // ── navigator：模块顶层就被 isMobile 读，救不了的那个 ────────────────────
  // UA 用一个不冒充浏览器的常量串（与 daydayup 的 WeChatAdapter 一致）。后果是 `isMobile.phone`
  // 为假 ⇒ `maxRecommendedTextures` 不降到 4——这在小游戏上是想要的：那条降级是给 iOS<11 /
  // Android<7 的旧浏览器准备的。埋点不受影响：`analytics/index.ts` 在微信上走
  // `wx.getSystemInfoSync()` 分支，从不读 `navigator.userAgent`。
  g.navigator ??= {
    userAgent: 'wechat-minigame',
    msPointerEnabled: false, // EventSystem.addEvents 读它
  };

  // ── document：极小，每个键都对应一个具体调用点 ───────────────────────────
  // **故意不含 `createElement`**——见文件头。需要 2D canvas 的路径必须走
  // `settings.ADAPTER.createCanvas()`（`wechatPixiAdapter.ts`）。
  g.document ??= {
    addEventListener: (): void => { /* EventSystem.addEvents */ },
    removeEventListener: (): void => { /* EventSystem.removeEvents */ },
    dispatchEvent: (): boolean => false, // EventsTicker 的合成 pointermove 兜底路径
  };

  // determineCrossOrigin: `new URL(url, document.baseURI)`。必须是合法绝对 URL，否则相对资源路径
  // （无 CDN 构建就是 `cdn/<hash>.png`）会抛 TypeError。值本身无意义：它只参与「同源？」比较，结果
  // 只影响是否给 image 设 crossOrigin，而 wx image 上那个属性无副作用。
  //
  // **不能挂在上面的 `??=` 里**（2026-09-01 真机测试实测踩过，ASSET_PACKAGING_LOG.md §20）：
  // DevTools 模拟器把游戏代码跑在一个子上下文（`WAGameSubContext`）里，那个上下文**已经有**一个
  // `document`，只是它的 `baseURI` 不可用于相对路径解析（现象与 baseURI 缺席时完全一样——
  // `new URL(相对路径, 那个 baseURI)` 照样抛"Invalid URL"）。`document ??= {...}` 因此整体是
  // no-op，我们精心设的 `baseURI` 从没生效过，直到这次真机测试第一次让加载流程跑到贴图加载这一步
  // 才现形——此前的验证都停在"画面出没出来"（黑屏/canvas），从没有人验证过"贴图真的解出来了"。
  // `document.baseURI` 在真实 `document` 上是 `Node.prototype` 继承下来的只读 accessor，直接赋值
  // 是静默 no-op（这正是问题本身），`defineProperty` 建一个同名的自有属性去遮蔽它才有效。
  try {
    Object.defineProperty(g.document, 'baseURI', {
      value: 'https://wechat-minigame.local/',
      configurable: true,
    });
  } catch { /* 真的没法覆盖也别把启动炸了——退回宿主自己的 baseURI，好过整个装不上 */ }

  // EventsTicker 那条兜底路径会 `new PointerEvent(...)`。它的返回值被 dispatchEvent 吞掉，
  // 所以一个不做事的构造函数就够——但**必须存在**，否则那一行抛。
  //
  // 副作用要知道：`EventSystem` 用 `!!globalThis.PointerEvent` 决定挂 pointer 还是 mouse 那套
  // 监听。装了它就走 pointer 那套——两套在微信上都收不到任何事件（wx canvas 有
  // `addEventListener` 但没有 DOM 事件源；真正的输入走 `inputSystem/WechatAdapter.ts`），
  // 所以选哪套无关紧要，缺 `PointerEvent` 才是真会抛的那个。
  g.PointerEvent ??= class PointerEvent { };

  // ── location：determineCrossOrigin 的另一半 ──────────────────────────────
  // 它的签名是 `(url, loc = globalThis.location)`，随后读 `loc.hostname/port/protocol`。
  // `undefined` 会在那一行抛，所以这个必须有，而且要和上面的 `baseURI` **同源**——同源 ⇒ 返回
  // 空 crossOrigin ⇒ 不给 image 设任何跨域属性，这是我们想要的（包内文件无跨域一说）。
  g.location ??= {
    href: 'https://wechat-minigame.local/',
    hostname: 'wechat-minigame.local',
    port: '',
    protocol: 'https:',
  };

  // ── window / globalThis 上的监听器 ──────────────────────────────────────
  // `EventSystem.addEvents` 除了 `document.addEventListener` 还会 `globalThis.addEventListener`
  // （pointerup / mouseup 挂在全局而不是 canvas 上）。
  g.addEventListener ??= (): void => { /* EventSystem.addEvents */ };
  g.removeEventListener ??= (): void => { /* EventSystem.removeEvents */ };

  // window：`PixiAppViews` 挂 resize（微信不触发，转屏走 wx 自己的事件）、`analytics/queue.ts`
  // 挂 beforeunload。两处都只用 addEventListener——**不要**写成 `g.window ??= g`：那样
  // `window.addEventListener` 是否存在就取决于全局有没有，而真机上没有。
  g.window ??= {
    addEventListener: (): void => { /* PixiAppViews.onResize / analytics */ },
    removeEventListener: (): void => { /* 同上，teardown */ },
    location: g.location,
  };
}
