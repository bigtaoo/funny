/**
 * wechat-probe.ts — 宿主表面探针入口（`npm run build:wechat-probe`，**永不发布**）。
 *
 * `web-e2e` / `wechat-e2e` 的同族：一个不启动游戏的入口，把可测量的东西写到
 * `wx.env.USER_DATA_PATH`——在开发者工具里那是磁盘真实目录，于是整个测量过程无头（不需要网络、
 * 不用动 `urlCheck`、不用去控制台粘表达式；AUDIO_DESIGN §0.3 记了这套手法的两条死路）。
 *
 * 它回答两个问题，一次跑完：
 *  1. **这台运行时原生给了什么**（`before`）——写适配层唯一的依据，猜不出来；
 *  2. **适配层装完补齐了没有**（`after`）——同一份采集函数再跑一遍，差集就是这层的实际作用。
 *
 * 为什么留在仓库里而不是用完就删：`design/04-wechat.md`（daydayup）和 `AUDIO_DESIGN.md` §0.3
 * 都指着同一件事——**模拟器不是真机**。真机复测时要跑的正是这个入口，那时它报的
 * `before` 会与今天的模拟器结果不同，而那个差异就是全部答案。
 */
import { collectHostProbe, writeHostProbe } from '../platform/wechat/hostProbe';
import { installWechatHost } from '../platform/wechat/wechatHost';
import { probeTextMetrics } from '../render/textMetricsProbe';

declare const wx: {
  setEnableDebug(opts: { enableDebug: boolean }): void;
  createCanvas(): { getContext(type: string): unknown };
};
// Real-device "预览" ships with no attached console and no visible way to reach one — DevTools'
// own remote-debug bridge cannot even load this bundle (ASSET_PACKAGING_LOG.md §20.2), so the exit
// #3 `console.log` this file relies on is otherwise unreachable on a real phone. This turns on the
// on-screen vConsole panel unconditionally — safe only because this entry is `build:wechat-probe`,
// never shipped (see file header).
try { wx.setEnableDebug({ enableDebug: true }); } catch { /* older base library: no-op, not fatal */ }

const before = collectHostProbe();
installWechatHost();
const after = collectHostProbe();

/**
 * 文字度量（2026-09-11 加）。**这一项不是宿主表面，是版面结论的地基。**
 *
 * 全仓库每一个文字样式都写 `fontFamily: 'monospace'`，而 `fitFont` 一步算出「装得下的字号」
 * 靠的是「等宽字体的宽度随字号线性」这条假设，可读性下限（`fontFloorDesignPx`）也是一句关于
 * 「一个字最后在屏幕上有多大」的断言。两条都只在 Chrome 上量过。
 *
 * 小游戏运行时没有 DOM、canvas 来自 `wx.createCanvas()`、'monospace' 由手机自己解析（很多
 * 安卓机对 CJK 根本给不出等宽面）。**如果每字advance 不一样，那两条结论就得重新量，而不是
 * 假定能平移过来**——对照数据由 `test/browser/textMetrics.spec.ts` 在真 Chromium 上用同一个
 * 函数产出。
 *
 * 装适配层**之后**采集：正式入口跑的就是装好之后的环境。
 */
const textMetrics = probeTextMetrics(() => {
  const c = wx.createCanvas();
  return c.getContext('2d') as CanvasRenderingContext2D | null;
});

writeHostProbe({
  marker: 'NW_HOST_PROBE',
  // 装之前 / 装之后。`before.globals` 里为 'undefined' 而 `after.globals` 里不是的，
  // 就是这层补上的东西；两边都 'undefined' 的是我们**故意没补**的（fetch / DOMParser /
  // createImageBitmap / OffscreenCanvas，理由见 wechatPixiAdapter.ts）。
  before,
  after,
  textMetrics,
});
