// GachaScene (S2-6) — single / ten-pull lootbox with pity + reveal. Thin assembly file.
//
// The scene is split by domain — each part lives in ./GachaScene/*.ts and is composed via the
// mixin chain below over GachaSceneBase (./GachaScene/base.ts, which owns all instance state, the
// constructor, the Scene lifecycle, the draw/redeem actions, input handling, the render dispatcher
// and the shared helpers). The legendary border-trail math is not a mixin at all: it is stateless
// geometry/colour used by both reveal.ts and the base's update() loop, so it lives in
// ./GachaScene/trail.ts. To add a renderer: find the matching domain mixin (page / reveal / odds)
// or add a new one to the chain — do NOT grow this file. GachaSceneCallbacks and the draw-result
// types are re-exported so existing importers (`from './GachaScene'`) keep resolving to this file,
// not the directory.
import { GachaSceneBase } from './GachaScene/base';
import { PageMixin } from './GachaScene/page';
import { RevealMixin } from './GachaScene/reveal';
import { OddsMixin } from './GachaScene/odds';

export type { GachaSceneCallbacks, GachaDrawResult, FateRedeemResult } from './GachaScene/base';

const Assembled = OddsMixin(RevealMixin(PageMixin(GachaSceneBase)));

/**
 * GachaScene — the lootbox scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over GachaSceneBase.
 */
export class GachaScene extends Assembled {}
