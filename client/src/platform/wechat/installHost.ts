/**
 * installHost.ts — 只做一件事：在**任何 PIXI 模块体执行之前**装上宿主表面。
 *
 * 为什么要单独一个文件而不是在 `entries/wechat.ts` 里调一句：ESM 先把所有 import 求值完才跑
 * 模块体，而 `@pixi/settings/lib/utils/isMobile.mjs` 在**模块顶层**就读 `globalThis.navigator`。
 * 所以「装宿主」必须自己是一次 import 的副作用，并且排在入口的第一位。
 *
 * `wechatHost.ts` 本身刻意保持**无副作用**（纯导出），这样 `WechatPlatform` 可以只取
 * `screenCanvas()` 而不会顺手改全局，单测也能自己控制「装之前 / 装之后」两个状态。
 */
import { installWechatHost } from './wechatHost';

installWechatHost();
