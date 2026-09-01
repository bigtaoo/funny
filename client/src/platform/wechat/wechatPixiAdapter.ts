/**
 * wechatPixiAdapter.ts — PIXI v7 的 `settings.ADAPTER` 微信实现（ASSET_PACKAGING §4.3）。
 *
 * 与 `wechatHost.ts` 的分工：本文件管**PIXI 自己路由过来的**那 8 个方法（17 处 `createCanvas`、
 * 10 处 `fetch`、`getWebGLRenderingContext`、`getNavigator`、`getFontFaceSet`、
 * `getCanvasRenderingContext`、`getBaseUrl`、`parseXML`）；`wechatHost.ts` 管 PIXI **绕过 adapter
 * 直接嗅探**的那些全局。两者必须成对，缺一个都还是黑屏。
 *
 * **不用 weapp-adapter**：现代微信模板早就不发它，而 PIXI 自己就有这个官方扩展点——自己拿一个
 * 小文件，看得懂、改得动。这条与 `D:\daydayup` 的 `WeChatAdapter.ts`（PIXI v8 的
 * `DOMAdapter`）是同一个决定，那边已经在真机上跑了一个季度。
 *
 * 本文件按 import 顺序**晚于** `wechatHost.ts`（它 import 了 pixi，而宿主全局必须在 pixi 的模块
 * 体执行之前就位），但 ADAPTER 是调用期才读的，所以由入口在 `startApp()` 之前调一次即可。
 */
import { settings } from 'pixi.js-legacy';

declare const wx: {
  createCanvas(): unknown;
  createImage(): unknown;
};

/**
 * 2D 上下文的构造函数，从一张**丢弃的子 canvas**上嗅探并缓存。
 *
 * 为什么是子 canvas：`wx.createCanvas()` 第一次给上屏（那张已经被 `wechatHost.screenCanvas()`
 * 拿走了），之后给离屏子 canvas——**子 canvas 只支持 2D**，正好是这个探针要的东西。
 * 手法同 daydayup 的 `get2DContextConstructor()`。
 */
let ctx2dCtor: unknown;
function canvasRenderingContext2D(): unknown {
  if (!ctx2dCtor) {
    const probe = wx.createCanvas() as { getContext(t: string): { constructor: unknown } | null };
    ctx2dCtor = probe.getContext('2d')?.constructor ?? class CanvasRenderingContext2D { };
  }
  return ctx2dCtor;
}

/**
 * WebGL1 的构造函数。PIXI 只拿它做 `gl instanceof <ctor>` → 真=WebGL1、假=WebGL2。
 * 现代基础库把它挂成了全局（本机实测 `typeof WebGLRenderingContext === 'function'`）；缺席时给
 * 一个**永不匹配**的空类，于是 WebGL2 上下文会被正确识别为 v2（而不是被误判成 v1）。
 */
function webGLRenderingContext(): unknown {
  const g = globalThis as unknown as Record<string, unknown>;
  return g.WebGLRenderingContext ?? class WebGLRenderingContextAbsent { };
}

type Adapter = typeof settings.ADAPTER;

/** 装一次即可；`settings.ADAPTER` 是调用期读的，所以不需要抢在任何 import 之前。 */
export function installWechatPixiAdapter(): void {
  const adapter: Adapter = {
    // Text 光栅化、`fastText.ts` 的字形 atlas、`Texture.WHITE` 都走这里。
    // 必须是 `wx.createCanvas()`——**不是** `document.createElement('canvas')`：后者在模拟器里
    // 能用、在真机上不存在（daydayup design/04 的头号陷阱）。而且它与 `wechatHost.ts` 里
    // `HTMLCanvasElement` 绑定的那个类同源，`CanvasResource.test` 才会成立。
    createCanvas: (width?: number, height?: number): HTMLCanvasElement => {
      const c = wx.createCanvas() as { width: number; height: number };
      c.width = width ?? 0;
      c.height = height ?? 0;
      return c as unknown as HTMLCanvasElement;
    },
    getCanvasRenderingContext2D: () => canvasRenderingContext2D() as typeof CanvasRenderingContext2D,
    getWebGLRenderingContext: () => webGLRenderingContext() as typeof WebGLRenderingContext,
    // 只被 `maxRecommendedTextures` 用（老 iOS/Android 把纹理单元降到 4）。转发宿主那份，
    // 缺席时 `wechatHost` 已经补了一个常量 UA。
    getNavigator: () => (globalThis as unknown as { navigator: Navigator }).navigator,
    getBaseUrl: () => '',
    // v7 的 `@pixi/text` 用它等字体就绪。小游戏没有 web 字体加载（字体由系统提供），
    // 返回 null 让那条路径直接跳过。
    getFontFaceSet: () => null,
    // ⛔ 故意不实现，而且这不是遗漏——`ImageResource` 只在 `createImageBitmap` 那条路上用
    // `fetch`，而这个运行时**没有** `globalThis.createImageBitmap`（实测），于是它走
    // `new Image()` 那条（由 `wechatHost` 接到 `wx.createImage()`），根本不需要网络原语。
    // 包内资源也不该走 HTTP：`WechatAssetIO` 用 `downloadFile`/`readFileSync`。
    // 所以落到这里的一律是「有人想要远端资源」，那是打包边界的决定，应该响亮地失败。
    // （daydayup 的同一处注释记录了他们复核后的结论：真上了 Assets 也没有任何路径走到 fetch。）
    fetch: () => Promise.reject(new Error(
      'wechatPixiAdapter.fetch is not implemented — assets load via WechatAssetIO (downloadFile/readFileSync), not fetch',
    )),
    parseXML: () => { throw new Error('wechatPixiAdapter.parseXML is not implemented — no XML bitmap fonts / SVG on WeChat'); },
  };

  settings.ADAPTER = adapter;
}
