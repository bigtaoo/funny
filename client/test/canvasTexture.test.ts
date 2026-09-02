/**
 * canvasTexture.test.ts — 两道保险的第二道，和「没人守着它」这件事本身。
 *
 * `wechatHost.ts` 把 `HTMLCanvasElement` 等类绑回全局，于是 PIXI 的 `autoDetectResource` 嗅探能
 * 过；`render/canvasTexture.ts` 则**指名 `CanvasResource`**，让「画面出不出来」不取决于那个全局
 * 补没补上。前者有 `wechatHost.test.ts` 守着，后者落地时（2026-09-01）没有任何用例——两个套件
 * 并集下 `textureFromCanvas` 一次都没被调用过（2026-09-02 实测）。
 *
 * 本文件两件事，缺一不可：
 *
 *   1. **这个函数真的绕过了嗅探**——同一张 wx 风格的 canvas，`PIXI.Texture.from` 抛，它不抛。
 *      直接断言这一点，而不是断言「它返回了一个 Texture」：后者在 PIXI 恢复了嗅探能力的环境里
 *      同样成立，也就测不出这个文件存在的理由。
 *   2. **调用点守卫**——今天 `src/` 里没有任何一处把 canvas 交给 PIXI 去嗅探（三处 canvas→纹理
 *      全部走本模块，其余 `Texture.from(...)` 收的都是 URL 字符串）。这个状态此前没有任何机制维持
 *      它，而下一处长出来时的症状是**真机黑屏**、错误文本与「游戏」二字毫无关联——正是
 *      `wechatHostSurface.test.ts` 开头那段病史。所以照抄它的做法：扫描 + 扫描器自测。
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as PIXI from 'pixi.js-legacy';
import { stripNonCode } from './harness/domUsageScan';
import { baseTextureFromCanvas, textureFromCanvas } from '../src/render/canvasTexture';

const ROOT = resolve(__dirname, '..');

// ── 1. 行为：指名资源类，不让 PIXI 去嗅探 ──────────────────────────────────────────────────

/**
 * `wx.createCanvas()` 交出来的东西：有 `getContext`/`width`/`height`，但**不是**任何一个全局类的
 * 实例——真机上那两个类压根不存在。这正是 `CanvasResource.test` 的
 * `source instanceof HTMLCanvasElement` 判不出来的形状。
 */
class WxCanvas {
  width = 64;
  height = 64;
  getContext(): unknown { return { canvas: this }; }
}

describe('canvasTexture：指名 CanvasResource', () => {
  const saved: Record<string, unknown> = {};
  const CLASSES = ['HTMLCanvasElement', 'OffscreenCanvas', 'HTMLImageElement', 'ImageBitmap'] as const;
  const g = globalThis as unknown as Record<string, unknown>;

  beforeEach(() => {
    // 真机形状：这几个类都不存在。node 下本来就没有，存下来只是不假设。
    for (const c of CLASSES) { saved[c] = g[c]; delete g[c]; }
  });
  afterEach(() => {
    for (const c of CLASSES) { if (saved[c] === undefined) delete g[c]; else g[c] = saved[c]; }
  });

  it('前提成立：PIXI 自己的嗅探认不出这张 canvas（这就是那个黑屏）', () => {
    expect(PIXI.CanvasResource.test(new WxCanvas())).toBeFalsy();
    expect(() => PIXI.Texture.from(new WxCanvas() as unknown as HTMLCanvasElement)).toThrow();
  });

  it('baseTextureFromCanvas 不抛，且资源确实是 CanvasResource', () => {
    const base = baseTextureFromCanvas(new WxCanvas() as unknown as HTMLCanvasElement);
    expect(base.resource).toBeInstanceOf(PIXI.CanvasResource);
  });

  it('textureFromCanvas 不抛，且包着同一个 base', () => {
    const cvs = new WxCanvas() as unknown as HTMLCanvasElement;
    const tex = textureFromCanvas(cvs);
    expect(tex).toBeInstanceOf(PIXI.Texture);
    expect(tex.baseTexture.resource).toBeInstanceOf(PIXI.CanvasResource);
    // 源真的是我们给的那张，而不是某个 PIXI 兜底造出来的空白。
    expect((tex.baseTexture.resource as PIXI.CanvasResource).source).toBe(cvs);
  });

  it('options 一路透传到 BaseTexture（调用点靠它设 scaleMode / resolution）', () => {
    const base = baseTextureFromCanvas(new WxCanvas() as unknown as HTMLCanvasElement, {
      scaleMode: PIXI.SCALE_MODES.NEAREST,
      resolution: 3,
    });
    expect(base.scaleMode).toBe(PIXI.SCALE_MODES.NEAREST);
    expect(base.resolution).toBe(3);
  });

  it('宿主补上了类绑定时行为不变——两道保险互不依赖', () => {
    // `wechatHost.installWechatHost()` 跑过之后嗅探也能过。那不该改变这条路径做什么，否则
    // 「两道保险」就成了「一道保险 + 一条平时走不到的分支」。
    g.HTMLCanvasElement = WxCanvas;
    const base = baseTextureFromCanvas(new WxCanvas() as unknown as HTMLCanvasElement);
    expect(base.resource).toBeInstanceOf(PIXI.CanvasResource);
  });
});

// ── 2. 调用点守卫 ─────────────────────────────────────────────────────────────────────────

/** PIXI 里会去嗅探源类型的三个入口。`new PIXI.BaseTexture(资源实例)` 不在内——那本身就是指名。 */
const SNIFFING_ENTRIES = /(?:PIXI\.)?(?:Base)?Texture\.from\s*\(/g;

/**
 * 一个参数表达式**看起来像 canvas 吗**。
 *
 * 故意是文本启发式而不是类型分析：这个门禁要在**新代码写下的那一刻**报警，而那时它多半还没被
 * 任何一条 import 链接进来。代价是它只认得叫得出名字的 canvas——`const c = wx.createCanvas()`
 * 传 `c` 就漏不掉吗？会漏。
 *
 * 所以真正兜底的不是这条正则，是下一个用例那条**白名单形状**断言：每一处嗅探入口的参数都必须
 * 长得像 url/src/path。`c` 两条都不满足，于是照样红——这条正则只负责让最常见的形态**先**失败，
 * 且错误信息直说「改用 canvasTexture」而不是「参数名不像 url」。
 */
const CANVAS_ISH = /(^|[^A-Za-z0-9_])(canvas|cvs|offscreen|\w*Canvas)\b/i;

interface Site { file: string; line: number; arg: string }

function findSniffingSites(files: Record<string, string>): Site[] {
  const out: Site[] = [];
  for (const [file, source] of Object.entries(files)) {
    stripNonCode(source).forEach((line, i) => {
      for (const m of line.matchAll(SNIFFING_ENTRIES)) {
        // 第一个参数：到逗号或右括号为止，够用了——这些调用点没有嵌套逗号的表达式。
        const rest = line.slice(m.index + m[0].length);
        const arg = rest.split(/[,)]/)[0].trim();
        out.push({ file, line: i + 1, arg });
      }
    });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function srcTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const abs of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    // 本模块自己就是那个指名的实现，它内部不用 `.from`，但排除掉更不容易误读。
    if (rel === 'src/render/canvasTexture.ts') continue;
    files[rel] = readFileSync(abs, 'utf8');
  }
  return files;
}

describe('调用点：不许把 canvas 丢给 PIXI 嗅探', () => {
  const sites = findSniffingSites(srcTree());

  it('没有任何 Texture.from / BaseTexture.from 收的是 canvas', () => {
    const bad = sites.filter((s) => CANVAS_ISH.test(s.arg))
      .map((s) => `${s.file}:${s.line}  ${s.arg}`);
    expect(bad, '改用 render/canvasTexture.ts 的 textureFromCanvas / baseTextureFromCanvas').toEqual([]);
  });

  it('剩下的嗅探入口全都收 URL 字符串（`ImageResource` 那条，合法）', () => {
    // 断言的是形状而不是处数：这些调用点收的是构建期烘焙出来的 url 变量或字符串常量，
    // 随时可能多一处、少一处，而那不是回归。
    for (const s of sites) {
      expect(s.arg, `${s.file}:${s.line}`).toMatch(/url|Url|URL|_URLS|src|path/);
    }
  });

  it('至少还有一处 —— 否则这个门禁在守一片空地', () => {
    expect(sites.length).toBeGreaterThan(0);
  });
});

describe('扫描器自己：抓得到，且不误报', () => {
  const scan = (src: string): Site[] => findSniffingSites({ 'src/x.ts': src });

  it('抓得到三种写法', () => {
    const found = scan([
      'const a = PIXI.Texture.from(canvas);',
      'const b = Texture.from(myCanvas);',
      'const c = PIXI.BaseTexture.from(offscreen, opts);',
    ].join('\n'));
    expect(found).toHaveLength(3);
    expect(found.every((s) => CANVAS_ISH.test(s.arg))).toBe(true);
  });

  it('URL 字符串不算', () => {
    expect(scan('const t = PIXI.Texture.from(baseTexUrl as string);')
      .filter((s) => CANVAS_ISH.test(s.arg))).toEqual([]);
  });

  it('注释里提到不算（行注释 / 块注释都要能剥掉）', () => {
    expect(scan('// gachaArt hands out PIXI.Texture.from(canvas) on a cold start')).toEqual([]);
    expect(scan('/*\n * Wraps PIXI.BaseTexture.from(canvas)\n */')).toEqual([]);
  });

  it('字符串字面量里提到不算', () => {
    expect(scan("throw new Error('do not call Texture.from(canvas) here');")).toEqual([]);
  });

  it('行号对得上，且块注释不会把后面的行号顶掉', () => {
    const found = scan('/*\n * x\n */\nconst t = Texture.from(canvas);');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(4);
  });

  it('`textureFromCanvas(...)` 本身不会被误抓', () => {
    expect(scan('const t = textureFromCanvas(cvs);')).toEqual([]);
  });
});
