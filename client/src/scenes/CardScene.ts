// CardScene — Hero Roster UI (CHARACTER_CARDS_DESIGN §10). Thin assembly file.
//
// The scene is split by domain — each part lives in ./CardScene/*.ts and is composed via the mixin
// chain below over CardSceneBase (./CardScene/base.ts, which owns all instance state + the layer
// scaffold + render dispatcher + shared portrait/modal/toast primitives + input/lifecycle). To add a
// handler: find the matching domain mixin (list / detail / feed / actions) or add a new one to the
// chain — do NOT grow this file. CardCallbacks / CardActionResult are re-exported so existing importers
// (`from './CardScene'`) keep resolving to this file, not the directory.
import type { Scene } from './SceneManager';
import { CardSceneBase } from './CardScene/base';
import { ListMixin } from './CardScene/list';
import { DetailMixin } from './CardScene/detail';
import { FeedMixin } from './CardScene/feed';
import { ActionsMixin } from './CardScene/actions';

export type { CardCallbacks, CardActionResult } from './CardScene/base';

const Assembled = ActionsMixin(
  FeedMixin(
    DetailMixin(
      ListMixin(CardSceneBase),
    ),
  ),
);

/**
 * CardScene — the Hero Roster scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over CardSceneBase.
 */
export class CardScene extends Assembled implements Scene {}
