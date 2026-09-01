// ⚠️ 这两行的顺序是承重的，别调换、别在中间插东西（ASSET_PACKAGING §4.3）：
//
// 1. `installHost` 必须是**第一个** import。微信运行时没有完整的 DOM，而 PIXI 有一批依赖是
//    **模块顶层**求值的（`@pixi/settings` 的 `isMobile` 直接读 `globalThis.navigator`）。ESM 先
//    把所有 import 求值完才跑模块体，所以任何写在下面函数体里的「装宿主」都来不及。
// 2. `@pixi/unsafe-eval` 紧随其后：这个运行时禁 `eval`/`new Function`，PIXI 默认用它们生成
//    uniform 上传代码。
import '../platform/wechat/installHost';
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';
import { setAudioBus } from '../audio/audioBus';
import { installWechatPixiAdapter } from '../platform/wechat/wechatPixiAdapter';
import { WechatAudioBus } from '../platform/wechat/WechatAudioBus';

// PIXI 自己路由的那 8 个 DOM 调用（`createCanvas` / 上下文构造函数探针 / navigator / …）。
// 与上面的宿主全局成对：全局管 PIXI **绕过 adapter 直接嗅探**的部分，这里管它**主动问**的部分。
// ADAPTER 是调用期读的，所以放在模块体里就够——但必须早于第一次建 PIXI 对象。
installWechatPixiAdapter();

// WeChat has no fetch: all assets go through wx.downloadFile + local cache (ASSET_PACKAGING §4).
// Asset URLs are baked in at build time via webpack publicPath (absolute CDN URLs when NW_ASSET_CDN is set, otherwise package-relative paths).
setAssetIO(new WechatAssetIO());

// Audio device (AUDIO_DESIGN.md §3, §7 step 5). Installed exactly like setAssetIO above.
//
// This line replaces a comment that claimed the opposite — that the mini-game runtime has "no
// oscillators and no GainNode", so the whole audio/ pipeline could not run and NullAudioBus
// (silence) was the honest state. That claim read `client/src/wx.d.ts`, which declared only
// `createInnerAudioContext`, as if it described the runtime. It described our typings. The real
// runtime has offered `wx.createWebAudioContext()` — a standard Web Audio surface — since base
// library 2.19.0, and this project pins 3.17.2. So WechatAudioBus reuses the pipeline verbatim
// and the InnerAudioContext pool §5 called for is not needed for SFX; see WechatAudioBus.ts.
setAudioBus(new WechatAudioBus());
startApp(new WechatPlatform()).catch(console.error);
