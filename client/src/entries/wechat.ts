// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';

// WeChat has no fetch: all assets go through wx.downloadFile + local cache (ASSET_PACKAGING §4).
// Asset URLs are baked in at build time via webpack publicPath (absolute CDN URLs when NW_ASSET_CDN is set, otherwise package-relative paths).
setAssetIO(new WechatAssetIO());

// No setAudioBus() here on purpose — WeChat keeps audio/audioBus.ts's NullAudioBus, i.e. the
// mini-game is silent (AUDIO_DESIGN.md §3 "微信侧后端"). `wx.d.ts` declares only
// `createInnerAudioContext`, a play-a-URL player with no oscillators and no GainNode, so neither
// the procedural voices nor the AudioBuffer sample path can run on it at all. That backend is an
// InnerAudioContext pool of a different shape (AUDIO_DESIGN.md §3/§5) and is its own step; until
// it lands, silence is the honest state rather than a fake device that swallows every cue.
startApp(new WechatPlatform()).catch(console.error);
