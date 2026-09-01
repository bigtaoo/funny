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

declare const wx: { setEnableDebug(opts: { enableDebug: boolean }): void };
// Real-device "预览" ships with no attached console and no visible way to reach one — DevTools'
// own remote-debug bridge cannot even load this bundle (ASSET_PACKAGING_LOG.md §20.2), so the exit
// #3 `console.log` this file relies on is otherwise unreachable on a real phone. This turns on the
// on-screen vConsole panel unconditionally — safe only because this entry is `build:wechat-probe`,
// never shipped (see file header).
try { wx.setEnableDebug({ enableDebug: true }); } catch { /* older base library: no-op, not fatal */ }

const before = collectHostProbe();
installWechatHost();
const after = collectHostProbe();

writeHostProbe({
  marker: 'NW_HOST_PROBE',
  // 装之前 / 装之后。`before.globals` 里为 'undefined' 而 `after.globals` 里不是的，
  // 就是这层补上的东西；两边都 'undefined' 的是我们**故意没补**的（fetch / DOMParser /
  // createImageBitmap / OffscreenCanvas，理由见 wechatPixiAdapter.ts）。
  before,
  after,
});
