// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';
import { setAudioBus } from '../audio/audioBus';
import { WechatAudioBus } from '../platform/wechat/WechatAudioBus';

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
// library 2.19.0, and this project pins 3.15.1. So WechatAudioBus reuses the pipeline verbatim
// and the InnerAudioContext pool §5 called for is not needed for SFX; see WechatAudioBus.ts.
setAudioBus(new WechatAudioBus());
startApp(new WechatPlatform()).catch(console.error);
