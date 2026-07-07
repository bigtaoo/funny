// ShopScene (S2-6 + B-PROMO) — direct-purchase shop. Thin assembly file.
//
// The scene is split by domain — each part lives in ./ShopScene/*.ts and is composed via the mixin
// chain below over ShopSceneBase (./ShopScene/base.ts, which owns all instance state + the constructor +
// the render dispatcher + shared card/button/toast primitives + hidden-input + input/lifecycle). To add
// a handler: find the matching domain mixin (shop / coins / actions) or add a new one to the chain — do
// NOT grow this file. ShopSceneCallbacks / ShopActionResult are re-exported so existing importers
// (`from './ShopScene'`) keep resolving to this file, not the directory.
import type { Scene } from './SceneManager';
import { ShopSceneBase } from './ShopScene/base';
import { ShopMixin } from './ShopScene/shop';
import { CoinsMixin } from './ShopScene/coins';
import { ActionsMixin } from './ShopScene/actions';

export type { ShopSceneCallbacks, ShopActionResult } from './ShopScene/base';

const Assembled = ActionsMixin(
  CoinsMixin(
    ShopMixin(ShopSceneBase),
  ),
);

/**
 * ShopScene — the direct-purchase shop registered against SceneManager.
 * Assembled from the per-domain mixin chain over ShopSceneBase.
 */
export class ShopScene extends Assembled implements Scene {}
