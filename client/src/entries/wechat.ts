// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { WechatAssetIO } from '../assets/WechatAssetIO';

// 方案 A（ASSET_PACKAGING §4）：配了 CDN 基址则资源走 CDN 下载 + 本地缓存；
// 留空则保持默认 WebAssetIO（打包内资源 identity），整包先跑。
const assetCdn = (globalThis as { __NW_ASSET_CDN__?: string }).__NW_ASSET_CDN__ ?? '';
if (assetCdn) setAssetIO(new WechatAssetIO(assetCdn));

startApp(new WechatPlatform()).catch(console.error);
