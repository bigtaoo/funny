/**
 * installHost.ts — 只做一件事：在**任何 PIXI 模块体执行之前**装上宿主表面。
 *
 * 为什么要单独一个文件而不是在 `entries/wechat.ts` 里调一句：ESM 先把所有 import 求值完才跑
 * 模块体，而 `@pixi/settings/lib/utils/isMobile.mjs` 在**模块顶层**就读 `globalThis.navigator`。
 * 所以「装宿主」必须自己是一次 import 的副作用，并且排在入口的第一位。
 *
 * `wechatHost.ts` 本身刻意保持**无副作用**（纯导出），这样 `WechatPlatform` 可以只取
 * `screenCanvas()` 而不会顺手改全局，单测也能自己控制「装之前 / 装之后」两个状态。
 *
 * 两条线并列、**不合并**（2026-09-12 加第二条）：`wechatHost` 补的是 **PIXI 绕过 adapter 直接嗅探
 * 的 DOM 面**，每一行对着一个 PIXI 调用点；`abortShim` 补的是**我们自己的网络层**无条件 `new` 的
 * 那个标准全局（缺它 ⇒ 微信包里每一个 REST 调用在进 transport 之前就抛，见该文件头）。
 */
import { installWechatHost } from './wechatHost';
import { installAbortShim } from './abortShim';

installWechatHost();
installAbortShim();
