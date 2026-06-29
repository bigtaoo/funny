// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';

// WeChat 无 fetch：所有资源经 wx.downloadFile + 本地缓存（ASSET_PACKAGING §4）。资源 URL 已在
// 构建期由 webpack publicPath 烘焙（配 NW_ASSET_CDN 则为 CDN 绝对地址，否则为包内相对路径）。
setAssetIO(new WechatAssetIO());

startApp(new WechatPlatform()).catch(console.error);
