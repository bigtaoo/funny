/**
 * wechatHost.test.ts — 微信宿主表面 + PIXI adapter（ASSET_PACKAGING §4.3 / LOG §17）。
 *
 * 断言的**不是我们自己的函数**，而是**真实的 PIXI 判定函数**：`CanvasResource.test`、
 * `ImageResource.test`、`determineCrossOrigin`、`Texture.WHITE`。这层要防的故障恰恰发生在
 * PIXI 内部我们改不到的地方，所以「装完之后 PIXI 自己怎么答」才是唯一有意义的问题。
 *
 * **harness 的关键一条（抄 daydayup `render/wechatRuntimeFake.ts`）：小游戏没有的浏览器全局
 * 要在测试里真的 `delete` 掉，而不是「碰巧没用到」。** Node 自带 `fetch`、`URL`、
 * `HTMLCanvasElement`（jsdom 环境下更多），留着它们的话，一个仍然依赖 DOM 的实现会在这里全绿、
 * 到真机上崩——那正是这一整轮要根治的病。
 *
 * 跑在纯 node 环境（无 jsdom），fake 只有 `wx` 一个；它上面的东西全是真的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** 小游戏运行时**没有**的浏览器全局。整轮测试期间从 globalThis 上摘掉。 */
const ABSENT = [
  'document', 'window', 'navigator', 'location',
  'Image', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement',
  'OffscreenCanvas', 'ImageBitmap', 'createImageBitmap',
  'fetch', 'DOMParser', 'XMLHttpRequest', 'PointerEvent',
  'addEventListener', 'removeEventListener',
] as const;

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

/** 一张 wx 风格的 canvas：类名不叫 HTMLCanvasElement（真机实测是 `HTMLElement`）。 */
class WxCanvas {
  width = 0;
  height = 0;
  readonly __is_wx_canvas = true;
  getContext(kind: string): unknown {
    return kind === '2d' ? new WxCanvasContext2D() : null;
  }
  addEventListener(): void { /* wx canvas 有这个方法，但没有 DOM 事件源 */ }
  readonly style: Record<string, string> = {};
}
class WxCanvasContext2D {
  fillStyle = '';
  fillRect(): void { /* Texture.WHITE 会调 */ }
  drawImage(): void { /* fastText 的字形 atlas 会调 */ }
  measureText(): { width: number } { return { width: 1 }; }
}
/** 一个 wx 风格的 image：类名恰好就是 HTMLImageElement（真机实测），但没挂到全局。 */
class WxImage {
  src = '';
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

interface FakeWx {
  createCanvas: ReturnType<typeof vi.fn>;
  createImage: ReturnType<typeof vi.fn>;
}

let saved: Map<string, { had: boolean; value: unknown }>;
let wxFake: FakeWx;

beforeEach(() => {
  saved = new Map();
  for (const key of ABSENT) {
    saved.set(key, { had: key in g, value: g[key] });
    delete g[key];
  }
  wxFake = {
    createCanvas: vi.fn(() => new WxCanvas()),
    createImage: vi.fn(() => new WxImage()),
  };
  vi.stubGlobal('wx', wxFake);
  vi.resetModules(); // PIXI 也要重新求值：Texture.WHITE / isMobile 都是模块级状态
});

afterEach(() => {
  for (const [key, { had, value }] of saved) {
    if (had) g[key] = value; else delete g[key];
  }
  // install 直接写 globalThis（不是 stubGlobal），所以这些要手动清，否则漏到别的文件
  for (const key of ABSENT) if (!saved.get(key)?.had) delete g[key];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pixi() { return import('pixi.js-legacy'); }
async function installHost() {
  const mod = await import('../src/platform/wechat/wechatHost');
  mod.installWechatHost();
  return mod;
}
async function installAdapter() {
  const mod = await import('../src/platform/wechat/wechatPixiAdapter');
  mod.installWechatPixiAdapter();
}

describe('装之前：PIXI 认不出这个运行时的东西（2026-09-01 黑屏的本体）', () => {
  it('CanvasResource 认不出 wx canvas —— 缺 HTMLCanvasElement 全局', async () => {
    const PIXI = await pixi();
    expect(PIXI.CanvasResource.test(new WxCanvas())).toBeFalsy();
  });

  it('ImageResource 认不出字符串 url —— 缺 HTMLImageElement 全局', async () => {
    const PIXI = await pixi();
    expect(PIXI.ImageResource.test('cdn/abc.png')).toBeFalsy();
  });

  it('autoDetectResource 因此对两者都抛，错误文本就是控制台里看到的那句', async () => {
    const PIXI = await pixi();
    expect(() => PIXI.autoDetectResource(new WxCanvas() as unknown as HTMLCanvasElement))
      .toThrow(/Unrecognized source type/);
  });
});

describe('装之后：PIXI 自己的判定全部成立', () => {
  it('CanvasResource 认得 wx canvas', async () => {
    const PIXI = await pixi();
    await installHost();
    expect(PIXI.CanvasResource.test(new WxCanvas())).toBe(true);
  });

  it('ImageResource 认得字符串 url，且真造一个不抛（走 new Image() → wx.createImage()）', async () => {
    const PIXI = await pixi();
    await installHost();
    expect(PIXI.ImageResource.test('cdn/abc.png')).toBe(true);
    let res: unknown;
    expect(() => { res = new PIXI.ImageResource('cdn/abc.png'); }).not.toThrow();
    expect(wxFake.createImage).toHaveBeenCalled();
    expect((res as { url: string }).url).toBe('cdn/abc.png');
  });

  it('Texture.WHITE 建得出来 —— 这是当时报错的那一行（Graphics → FillStyle → WHITE）', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    expect(() => PIXI.Texture.WHITE).not.toThrow();
    expect(PIXI.Texture.WHITE.baseTexture.resource).toBeInstanceOf(PIXI.CanvasResource);
  });

  it('determineCrossOrigin 不再抛（缺 document.baseURI / location 时它必抛）', async () => {
    const PIXI = await pixi();
    await installHost();
    // 同源 ⇒ 空串 ⇒ 不给 image 设任何跨域属性，这是包内文件想要的结果
    expect(PIXI.utils.determineCrossOrigin('cdn/abc.png')).toBe('');
  });
});

describe('宿主已经提供时一个都不覆盖（旧基础库 / 模拟器上是 no-op）', () => {
  it('已有的 document / navigator / Image / 类绑定原样保留', async () => {
    const hostDoc = { baseURI: 'https://host.example/', addEventListener() {}, marker: 'host' };
    const hostNav = { userAgent: 'real-ua', msPointerEnabled: false };
    class HostCanvasClass { }
    g.document = hostDoc;
    g.navigator = hostNav;
    g.HTMLCanvasElement = HostCanvasClass;
    await installHost();
    expect(g.document).toBe(hostDoc);
    expect(g.navigator).toBe(hostNav);
    expect(g.HTMLCanvasElement).toBe(HostCanvasClass);
  });

  it('缺的那些仍然会补上（部分缺失是 3.17.2 的真实形状）', async () => {
    g.document = { baseURI: 'https://host.example/', addEventListener() {} };
    await installHost();
    expect(typeof g.HTMLCanvasElement).toBe('function');
    expect(typeof g.Image).toBe('function');
  });
});

describe('上屏 canvas：第一次 wx.createCanvas() 不许被类嗅探偷走', () => {
  it('install + screenCanvas() 一共只要一张 canvas', async () => {
    const mod = await installHost();
    const screen = mod.screenCanvas();
    expect(wxFake.createCanvas).toHaveBeenCalledTimes(1);
    // 文档契约：第一次 createCanvas 才是上屏，之后都是离屏。所以这张必须是同一张。
    expect(mod.screenCanvas()).toBe(screen);
    expect(wxFake.createCanvas).toHaveBeenCalledTimes(1);
  });

  it('裸全局 canvas 存在时优先用它（旧基础库），也不额外造 canvas', async () => {
    const bare = new WxCanvas();
    g.canvas = bare;
    const mod = await installHost();
    expect(mod.screenCanvas()).toBe(bare);
    expect(wxFake.createCanvas).not.toHaveBeenCalled();
    delete g.canvas;
  });
});

describe('PIXI adapter：8 个方法各自的答案', () => {
  it('createCanvas 走 wx，尺寸落到对象上，且产物能通过 CanvasResource.test', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    const c = PIXI.settings.ADAPTER.createCanvas(4, 5) as unknown as WxCanvas;
    expect(c).toBeInstanceOf(WxCanvas);
    expect([c.width, c.height]).toEqual([4, 5]);
    expect(PIXI.CanvasResource.test(c)).toBe(true);
  });

  it('2D 上下文构造函数从丢弃的子 canvas 上嗅探（不碰 document）', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    expect(PIXI.settings.ADAPTER.getCanvasRenderingContext2D()).toBe(WxCanvasContext2D);
  });

  it('WebGL1 构造函数：宿主有就用宿主的；没有就给永不匹配的空类（WebGL2 才不会被误判成 v1）', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    const absent = PIXI.settings.ADAPTER.getWebGLRenderingContext();
    expect({} instanceof absent).toBe(false);

    class HostGL { }
    g.WebGLRenderingContext = HostGL;
    vi.resetModules();
    await installHost();
    await installAdapter();
    const PIXI2 = await pixi();
    expect(PIXI2.settings.ADAPTER.getWebGLRenderingContext()).toBe(HostGL);
    delete g.WebGLRenderingContext;
  });

  it('fetch / parseXML 故意不实现，且失败信息指向真正的加载路径', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    await expect(PIXI.settings.ADAPTER.fetch('https://x/y.png')).rejects.toThrow(/WechatAssetIO/);
    expect(() => PIXI.settings.ADAPTER.parseXML('<a/>')).toThrow(/not implemented/);
  });

  it('getFontFaceSet 返回 null（小游戏没有 web 字体加载）', async () => {
    const PIXI = await pixi();
    await installHost();
    await installAdapter();
    expect(PIXI.settings.ADAPTER.getFontFaceSet()).toBeNull();
  });
});

describe('文字：letterSpacing 那条不许被打开', () => {
  it('experimentalLetterSpacing 保持关闭', async () => {
    const PIXI = await pixi();
    // daydayup 在这个运行时上付过一次线上 bug：`context.letterSpacing = '0px'` 会**毒化上下文**
    // ——赋值之后 measureText 返回非有限宽度、fillText 一个像素都不画，游戏里每个 label 都是空白，
    // 而 glGetError 为 0、纹理尺寸正常、调用次数正常。v7 把那句赋值关在这个开关后面（默认关），
    // 所以我们只需要保证没人去开它。
    expect(PIXI.TextMetrics.experimentalLetterSpacing).toBe(false);
  });
});
