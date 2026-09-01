/**
 * domUsageScan.ts — 「微信可达图里不许裸用浏览器 DOM」这条约定的扫描器（纯函数）。
 *
 * 为什么需要它：客户端的微信构建一直靠**运行时自带的 DOM 兼容层**活着，没人声明过这层依赖，
 * 也没人拦得住新代码再长出一处。2026-09-01 的黑屏是第一次收费（`ASSET_PACKAGING_LOG` §17）。
 * 而按 daydayup `design/04-wechat.md` 的实测，**模拟器有 `document`、真机没有**——所以这类代码
 * 在开发者工具里能全绿，到手机上才炸。指望人工 review 抓这个是不现实的。
 *
 * 扫描器是纯函数（`findDomUsage(files)`），因此**门禁自己可以做变异测试**：喂合成源码断言它抓
 * 得到 / 不误报，再喂真实仓库对基线。
 *
 * ## 基线的读法（重要）
 *
 * 基线**不是豁免清单，是欠账清单**：里面每一处都是「这段代码在微信真机上会抛」。它今天允许
 * 存在，只是因为修它们各自是独立任务（REST 层没有 `fetch`、14 处场景用隐藏 `<input>` 收文本）。
 * 所以基线只能变小，不能变大。
 */

/** 一条被禁的宿主用法。 */
export interface DomPattern {
  readonly name: string;
  readonly re: RegExp;
  /** 微信上正确的做法，报错时直接说给人听。 */
  readonly instead: string;
}

export const DOM_PATTERNS: readonly DomPattern[] = [
  { name: 'document', re: /\bdocument\s*[.[]/, instead: '经 platform 层，或 PIXI 的 settings.ADAPTER（微信真机没有 document）' },
  { name: 'window', re: /\bwindow\s*[.[]/, instead: '经 platform 层（IPlatform.getScreenSize / devicePixelRatio）' },
  { name: 'new Image', re: /\bnew\s+Image\s*\(/, instead: 'assetIO().textureSource(url) → PIXI，或 wx.createImage()（platform/wechat）' },
  { name: 'fetch', re: /(?<![.\w])(?<!\b(?:async|function|private|public|protected|static|get)\s)fetch\s*\(/, instead: 'assetIO().loadBinary，或一个 platform 层的请求接缝（微信只有 wx.request/downloadFile）' },
  { name: 'navigator', re: /\bnavigator\s*[.[]/, instead: 'platform 层（微信走 wx.getSystemInfoSync / wx.getNetworkType）' },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/, instead: '同 fetch' },
  { name: 'localStorage', re: /\blocalStorage\s*[.[]/, instead: 'platform.storage（IStorage，微信走 wx.setStorageSync）' },
];

/**
 * 不在微信可达图里的路径：web/crazygames 的平台实现与入口（它们**应该**用 DOM），
 * 微信平台层自己（那儿是适配层，用 `wx.*` 和受控的全局补丁），以及纯类型声明。
 */
export const OFF_PATH = [
  /^src\/platform\/(web|crazygames)\//,
  /^src\/platform\/wechat\//,
  /^src\/entries\/(web|crazygames|mobile)/,
  /^src\/render\/sketchDemo\.ts$/, // web-only 的手绘 demo，不被任何入口 import
  /\.d\.ts$/,
];

/**
 * 把注释和字符串字面量刷成空白，只留可执行文本。
 *
 * 用 `split(/\r?\n/)` 而不是 `split('\n')`：CRLF 检出上留下的尾部 `\r` 是 ECMAScript
 * LineTerminator，会让以 `$` 锚定的行内正则一个字符都剥不掉——这个守卫会在 CI（LF）永远绿、
 * 在每个 Windows 检出上永远红（`claudedocs/client-testing.md` 记了这条）。
 */
export function stripNonCode(source: string): string[] {
  // 块注释整体刷白但保留换行，行号才不会漂。
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split(/\r?\n/).map((line) => line
    .replace(/\/\/.*$/, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``'));
}

/**
 * 两个免检口子，都只在**同一行**上成立：
 *
 * - `typeof window !== 'undefined' && ...` 这类**守卫**。有守卫就意味着微信上会走 fallback，
 *   而不是抛——那正是我们希望新代码采用的写法，不该报红。
 * - 行尾的 `// dom-ok: 理由`。给「`platform/wechat/wechatHost.ts` 已经显式补上了这个全局」这种
 *   情况留的压力阀：必须写理由，于是它是**可审计的**，而不是一个静默豁免。
 */
function exempt(rawLine: string, strippedLine: string, pattern: DomPattern): boolean {
  if (/\/\/\s*dom-ok:/.test(rawLine)) return true;
  // 守卫写法：`typeof <name> !==` / `typeof <name> ===`（RHS 已被刷成 '' 了，所以只看左半）
  const name = pattern.name.replace(/^new /, '');
  return new RegExp(`typeof\\s+${name}\\s*[!=]==`).test(strippedLine);
}

export interface DomUsage {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
  readonly instead: string;
}

/** `files`：仓库相对路径（正斜杠）→ 源码文本。返回微信可达图里的全部裸 DOM 用法。 */
export function findDomUsage(files: Record<string, string>): DomUsage[] {
  const out: DomUsage[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (OFF_PATH.some((re) => re.test(file))) continue;
    const raw = source.split(/\r?\n/);
    stripNonCode(source).forEach((code, i) => {
      for (const p of DOM_PATTERNS) {
        if (!p.re.test(code)) continue;
        if (exempt(raw[i] ?? '', code, p)) continue;
        out.push({ file, line: i + 1, pattern: p.name, text: code.trim().slice(0, 100), instead: p.instead });
      }
    });
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** 按文件汇总成 `{ 文件: 处数 }`，即基线的形状。 */
export function countByFile(usages: readonly DomUsage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of usages) counts[u.file] = (counts[u.file] ?? 0) + 1;
  return counts;
}
