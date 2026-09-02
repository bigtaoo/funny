/**
 * hostProbe.ts — 微信小游戏宿主环境探针（ASSET_PACKAGING_LOG §17 第 1 阶段）。
 *
 * 为什么需要它：客户端的微信构建一直靠**运行时自带的 DOM 兼容层**跑起来——PIXI 的
 * `settings.ADAPTER` 默认实现是 `document.createElement('canvas')`，`CanvasResource.test` /
 * `ImageResource.test` 判的是 `instanceof HTMLCanvasElement` / `HTMLImageElement`，
 * `EventSystem.addEvents()` 直接摸 `globalThis.document` 和 `globalThis.navigator`。这层依赖
 * 没人声明、没人测，直到基础库 3.17.2 (canary) 动了它，游戏黑屏。
 *
 * 要写自己的适配层，先得知道那个运行时**到底还剩什么**——猜是不行的。所以这里只做一件事：
 * 把宿主表面如实抄一份下来。
 *
 * **三个出口**（磁盘 / `GameGlobal` / `console.log`）：磁盘上什么都没有时，「探针崩了」和
 * 「根本没跑到这里」是等价的，而两者修法完全不同。
 *
 * 报告落在 `wx.env.USER_DATA_PATH/host-probe.json`——开发者工具里那是磁盘真实目录
 * （`.../WeappSimulator/WeappFileSystem/<user>/<appid>/usr/`），于是全程无头。
 */

declare const wx: {
  env: { USER_DATA_PATH: string };
  createCanvas(): unknown;
  createImage(): unknown;
  getFileSystemManager(): { writeFileSync(p: string, data: string, enc: 'utf8'): void };
  getSystemInfoSync?(): unknown;
};

/** `typeof` 一个全局，不触发 ReferenceError（裸标识符会）。 */
function q(name: string): string {
  return typeof (globalThis as Record<string, unknown>)[name];
}

/** 一个对象的构造函数名 + 它是否是某个全局类的实例（类不存在时报 null，而不是 false）。 */
function shape(obj: unknown, className: string): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const ctor = (obj as { constructor?: { name?: string } } | null)?.constructor;
  const Cls = g[className] as (abstract new () => unknown) | undefined;
  return {
    ctor: ctor?.name ?? null,
    [`is${className}`]: Cls ? obj instanceof Cls : null,
    keys: obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 12) : null,
  };
}

export function collectHostProbe(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const doc = g.document as Record<string, unknown> | undefined;
  const nav = g.navigator as Record<string, unknown> | undefined;

  let cvs: Record<string, unknown> = { error: 'not attempted' };
  try {
    const c = wx.createCanvas() as Record<string, unknown>;
    cvs = {
      ...shape(c, 'HTMLCanvasElement'),
      getContext: typeof c.getContext,
      addEventListener: typeof c.addEventListener,
      style: typeof c.style,
      width: c.width,
      height: c.height,
      ctx2dCtor: (() => {
        try {
          const ctx = (c.getContext as (t: string) => unknown)('2d');
          return (ctx as { constructor?: { name?: string } } | null)?.constructor?.name ?? null;
        } catch (e) { return `threw: ${String(e)}`; }
      })(),
    };
  } catch (e) { cvs = { error: String(e) }; }

  let img: Record<string, unknown> = { error: 'not attempted' };
  try { img = shape(wx.createImage(), 'HTMLImageElement'); }
  catch (e) { img = { error: String(e) }; }

  let docCreated: Record<string, unknown> = { error: 'no document.createElement' };
  if (typeof doc?.createElement === 'function') {
    try {
      const made = (doc.createElement as (t: string) => unknown)('canvas');
      docCreated = { ...shape(made, 'HTMLCanvasElement'), getContext: typeof (made as Record<string, unknown>).getContext };
    } catch (e) { docCreated = { error: String(e) }; }
  }

  return {
    // 全局类/函数在不在
    globals: {
      document: q('document'), window: q('window'), navigator: q('navigator'),
      Image: q('Image'), HTMLCanvasElement: q('HTMLCanvasElement'),
      HTMLImageElement: q('HTMLImageElement'), HTMLVideoElement: q('HTMLVideoElement'),
      OffscreenCanvas: q('OffscreenCanvas'), ImageBitmap: q('ImageBitmap'),
      createImageBitmap: q('createImageBitmap'), fetch: q('fetch'), URL: q('URL'),
      DOMParser: q('DOMParser'), XMLHttpRequest: q('XMLHttpRequest'),
      WebGLRenderingContext: q('WebGLRenderingContext'),
      CanvasRenderingContext2D: q('CanvasRenderingContext2D'),
      requestAnimationFrame: q('requestAnimationFrame'), performance: q('performance'),
      // 裸全局 canvas：3.17.2 起消失，正是 §17.1 那个黑屏
      canvas: q('canvas'),
      GameGlobalCanvas: typeof (g.GameGlobal as Record<string, unknown> | undefined)?.canvas,
    },
    // document / navigator 的哪几样成员还在（PIXI 裸摸的就是这几样）
    document: doc ? {
      createElement: typeof doc.createElement,
      addEventListener: typeof doc.addEventListener,
      baseURI: typeof doc.baseURI === 'string' ? doc.baseURI : typeof doc.baseURI,
      fonts: typeof doc.fonts,
      keys: Object.keys(doc).slice(0, 20),
    } : null,
    navigator: nav ? {
      userAgent: typeof nav.userAgent === 'string' ? nav.userAgent : typeof nav.userAgent,
      msPointerEnabled: typeof nav.msPointerEnabled,
      hardwareConcurrency: nav.hardwareConcurrency ?? null,
      keys: Object.keys(nav).slice(0, 20),
    } : null,
    // 三种拿 canvas 的方式各自给出什么
    wxCreateCanvas: cvs,
    wxCreateImage: img,
    documentCreateElementCanvas: docCreated,
  };
}

/**
 * 采集 + 三个出口写出。永不抛——探针崩掉不许连累启动。
 *
 * `report` 可以外部传入（`entries/wechat-probe.ts` 传的是「装适配层之前 / 之后」两份快照，
 * 那才是能回答「这层到底补上了没有」的形状）；不传就现采一份。
 */
export function writeHostProbe(report?: Record<string, unknown>): void {
  if (!report) {
    try { report = collectHostProbe(); }
    catch (e) { report = { fatal: String(e) }; }
  }

  const json = JSON.stringify(report, null, 2);
  try { (globalThis as Record<string, unknown>).__nwHostProbe = report; } catch { /* 出口 2 */ }
  try { console.log('[nw-host-probe]', json); } catch { /* 出口 3 */ }
  try {
    wx.getFileSystemManager().writeFileSync(`${wx.env.USER_DATA_PATH}/host-probe.json`, json, 'utf8');
  } catch (e) {
    try { console.log('[nw-host-probe] write failed', String(e)); } catch { /* 尽力 */ }
  }
}
