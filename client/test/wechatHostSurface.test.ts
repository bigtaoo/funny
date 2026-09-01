/**
 * wechatHostSurface.test.ts — 门禁：微信可达图里不许**新增**裸用浏览器 DOM 的代码。
 *
 * 病史：客户端的微信构建一直靠**运行时自带的 DOM 兼容层**活着，这层依赖没人声明、没人测。
 * 2026-09-01 基础库 3.17.2 (canary) 少了几个全局类绑定，症状是黑屏且控制台里那条错误
 * 与「游戏」二字毫无关联（`ASSET_PACKAGING_LOG` §17）。`platform/wechat/wechatHost.ts` 现在把
 * 这层依赖变成了我们自己声明的东西——但**没有任何机制阻止下一处长出来**，这就是本文件。
 *
 * 而且按 daydayup `design/04-wechat.md` 的实测，**模拟器有 `document`、真机没有**：这类代码在
 * 开发者工具里能全绿、到手机上才炸。所以人工 review 抓不住它，只能靠扫描。
 *
 * ## 基线不是豁免清单，是欠账清单
 *
 * `test/dom-usage-baseline.json` 里每一处都是「这段代码在微信真机上会抛」。允许它今天存在，只
 * 因为修它们各自是独立任务（14 处场景用隐藏 `<input>` 收文本）。所以：**只能变小，不能变大**，
 * 而且基线项消失时本测试会要求你把它删掉——否则「欠账」会慢慢变成「白名单」。
 *
 * 已经还掉的一笔：**REST 层的 `fetch`**（2026-09-01，ASSET_PACKAGING §4.5）。`net/transport.ts`
 * 这个接缝落地后，`ApiClient` / `WorldApiClient` / `anomaly` / `analytics` 四处共 6 个裸 `fetch`
 * 归零，基线 54 → 45。剩下那两个 `fetch`（`assets/assetIO.ts` 的 `WebAssetIO`、`platform/ota.ts`
 * 的 Capgo manifest）都是「平台默认实现」而不是共用路径，各自的平台会替换/够不着它们。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { findDomUsage, countByFile, stripNonCode, DOM_PATTERNS } from './harness/domUsageScan';
import baseline from './dom-usage-baseline.json';

const ROOT = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function realTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const abs of walk(join(ROOT, 'src'))) {
    files[relative(ROOT, abs).split('\\').join('/')] = readFileSync(abs, 'utf8');
  }
  return files;
}

describe('微信可达图：裸 DOM 用法不许增加', () => {
  const counts = countByFile(findDomUsage(realTree()));
  const expected = baseline as Record<string, number>;

  it('没有新文件开始裸用 DOM', () => {
    const added = Object.keys(counts).filter((f) => !(f in expected));
    expect(added, [
      '这些文件新增了裸 DOM 用法，微信真机上会抛。正确做法：',
      ...DOM_PATTERNS.map((p) => `  ${p.name} → ${p.instead}`),
      '有守卫（typeof window !== ...）或确实由 wechatHost 补上的，加行尾 `// dom-ok: 理由`。',
    ].join('\n')).toEqual([]);
  });

  it('已有文件里的处数没有变多', () => {
    const grown = Object.entries(counts)
      .filter(([f, n]) => f in expected && n > expected[f]!)
      .map(([f, n]) => `${f}: ${expected[f]} → ${n}`);
    expect(grown).toEqual([]);
  });

  it('基线里没有过期条目（修好了就要从基线里删掉，否则欠账变白名单）', () => {
    const stale = Object.entries(expected)
      .filter(([f, n]) => (counts[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n}，实际 ${counts[f] ?? 0}`);
    expect(stale, '把 test/dom-usage-baseline.json 更新成实际值').toEqual([]);
  });

  it('基线本身仍然是一份可读的欠账清单（数量级没有失控）', () => {
    // 2026-09-01 落地时是 21 文件 / 54 处，两类：REST 层的 fetch、场景里的隐藏 input。当天下午
    // 前一类还清（§4.5 的 transport 接缝），剩 17 文件 / 45 处，其中 30 处是隐藏 input。
    // 这个上限只防「有人把基线当垃圾桶」，不是设计目标——目标是清零，所以还完一批就往下拧。
    const total = Object.values(expected).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(45);
  });
});

describe('扫描器自己：抓得到，且不误报', () => {
  const scan = (src: string, file = 'src/scenes/Fake.ts') => findDomUsage({ [file]: src });

  it('抓 document / window / new Image / fetch / localStorage', () => {
    expect(scan('const c = document.createElement("canvas");')).toHaveLength(1);
    expect(scan('const w = window.innerWidth;')).toHaveLength(1);
    expect(scan('const i = new Image();')).toHaveLength(1);
    expect(scan('await fetch(url);')).toHaveLength(1);
    expect(scan('localStorage.setItem("k", "v");')).toHaveLength(1);
  });

  it('注释里提到不算 —— 行注释、块注释、JSDoc 三种都要能剥掉', () => {
    expect(scan('// document.createElement is not available here')).toEqual([]);
    expect(scan('/* window.innerWidth */ const a = 1;')).toEqual([]);
    expect(scan([
      '/**',
      ' * Web: navigator.userAgent；微信走 wx.getSystemInfoSync()。',
      ' */',
      'export const x = 1;',
    ].join('\n'))).toEqual([]);
  });

  it('字符串字面量里提到不算（三种引号）', () => {
    expect(scan('const s = "document.body";')).toEqual([]);
    expect(scan("const s = 'window.open';")).toEqual([]);
    expect(scan('const s = `fetch(${u})`;')).toEqual([]);
  });

  it('方法名叫 fetch 的不算（AchievementScene 有一个 private async fetch()）', () => {
    expect(scan('private async fetch(): Promise<void> { return; }')).toEqual([]);
    expect(scan('this.fetch();')).toEqual([]);
  });

  it('同一行有 typeof 守卫的不算 —— 那是我们希望新代码采用的写法', () => {
    expect(scan("const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;")).toEqual([]);
    expect(scan("if (typeof navigator !== 'undefined' && navigator.sendBeacon) { /* */ }")).toEqual([]);
    // 但守卫必须在同一行：分行写就抓不到守卫，也就仍然报——保守方向是对的
    expect(scan("if (typeof window === 'undefined') return;\nwindow.addEventListener('x', f);")).toHaveLength(1);
  });

  it('`// dom-ok: 理由` 免检，但**必须写理由**', () => {
    expect(scan('const i = new Image(); // dom-ok: wechatHost 把 Image 接到 wx.createImage()')).toEqual([]);
    // 没有冒号后的理由就不是这个标记，照样报
    expect(scan('const i = new Image(); // dom-ok')).toHaveLength(1);
  });

  it('web / crazygames / 微信平台层与入口不在扫描范围（它们应该用 DOM）', () => {
    for (const f of [
      'src/platform/web/WebPlatform.ts',
      'src/platform/crazygames/CrazyGamesPlatform.ts',
      'src/platform/wechat/wechatHost.ts',
      'src/entries/web.ts',
      'src/wx.d.ts',
    ]) {
      expect(scan('const c = document.createElement("canvas");', f)).toEqual([]);
    }
  });

  it('行号对得上（CRLF 检出上也一样 —— split 必须是 /\\r?\\n/）', () => {
    const lf = 'const a = 1;\nconst c = document.body;\n';
    expect(scan(lf)[0]!.line).toBe(2);
    expect(scan(lf.split('\n').join('\r\n'))[0]!.line).toBe(2);
  });

  it('stripNonCode 保留行数，块注释不会把后面的行号顶掉', () => {
    const src = '/*\n * document.body\n */\nconst c = window.x;';
    expect(stripNonCode(src)).toHaveLength(4);
    expect(scan(src)[0]!.line).toBe(4);
  });
});
