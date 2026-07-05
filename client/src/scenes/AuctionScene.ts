// AuctionScene — SLG auction scene (S8-5). Thin assembly file.
//
// The scene is split by domain — each part lives in ./AuctionScene/*.ts and is composed via the mixin
// chain below over AuctionSceneBase (./AuctionScene/base.ts, which owns all instance state + data loading +
// the render dispatcher + shared item-label/icon helpers + modal/toast primitives + the Scene interface). To
// add a handler: find the matching domain mixin (or add a new one to the chain) — do NOT grow this file.
// AuctionSceneCallbacks is re-exported so existing importers (`from './AuctionScene'`) keep resolving to
// this file, not the directory.
import type { Scene } from './SceneManager';
import { AuctionSceneBase } from './AuctionScene/base';
import { ListMixin } from './AuctionScene/list';
import { PickerMixin } from './AuctionScene/picker';
import { CreateFormMixin } from './AuctionScene/createForm';
import { BidMixin } from './AuctionScene/bid';
import { TradeActionsMixin } from './AuctionScene/tradeActions';

export type { AuctionSceneCallbacks } from './AuctionScene/base';

const Assembled = TradeActionsMixin(
  BidMixin(
    CreateFormMixin(
      PickerMixin(
        ListMixin(AuctionSceneBase),
      ),
    ),
  ),
);

/**
 * AuctionScene — the SLG auction scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over AuctionSceneBase.
 */
export class AuctionScene extends Assembled implements Scene {}
