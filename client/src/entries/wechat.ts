// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';

// WeChat has no fetch: all assets go through wx.downloadFile + local cache (ASSET_PACKAGING §4).
// Asset URLs are baked in at build time via webpack publicPath (absolute CDN URLs when NW_ASSET_CDN is set, otherwise package-relative paths).
setAssetIO(new WechatAssetIO());

startApp(new WechatPlatform()).catch(console.error);
