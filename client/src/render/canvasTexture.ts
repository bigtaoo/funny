/**
 * canvasTexture.ts — 从一张 canvas 造纹理，**指名资源类，不让 PIXI 去嗅探**。
 *
 * `PIXI.Texture.from(canvas)` / `BaseTexture.from(canvas)` 走的是 `autoDetectResource`：它挨个问
 * 已注册的 resource「这个源是你的吗」，而 `CanvasResource.test` 的判据是
 * `source instanceof HTMLCanvasElement`（或 `OffscreenCanvas`）。**微信小游戏没有这两个全局类**
 * ——`wx.createCanvas()` 造出来的对象什么都不匹配，于是抛
 * `Unrecognized source type to auto-detect Resource`（v8 那边同一个坑的错误文本是
 * `Could not find a source type for resource`，daydayup `design/04-wechat.md` 记着他们为此付的
 * 线上 bug）。
 *
 * `platform/wechat/wechatHost.ts` 会把那两个类绑上去，所以嗅探其实也能过；这里仍然指名，理由是
 * **不该让「画面出不出来」取决于一个全局变量补没补上**。两道保险互不依赖：宿主层照顾 PIXI 内部
 * 我们改不到的地方（`Texture.WHITE`、字符串 url 走 `ImageResource`），这个函数照顾我们自己的
 * 调用点。
 */
import * as PIXI from 'pixi.js-legacy';

/** 指名 `CanvasResource` 的 `BaseTexture.from(canvas, opts)`。 */
export function baseTextureFromCanvas(
  canvas: PIXI.ICanvas | HTMLCanvasElement,
  options?: PIXI.IBaseTextureOptions,
): PIXI.BaseTexture {
  return new PIXI.BaseTexture(
    new PIXI.CanvasResource(canvas as HTMLCanvasElement),
    options,
  );
}

/** 指名 `CanvasResource` 的 `Texture.from(canvas, opts)`。 */
export function textureFromCanvas(
  canvas: PIXI.ICanvas | HTMLCanvasElement,
  options?: PIXI.IBaseTextureOptions,
): PIXI.Texture {
  return new PIXI.Texture(baseTextureFromCanvas(canvas, options));
}
