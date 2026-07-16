// WorldMapRenderer — SLG overworld map/tile rendering + view transforms. Thin assembly file.
//
// The renderer is split by concern — each part lives in ./WorldMapRenderer/*.ts and is composed via the
// mixin chain below over WorldMapRendererBase (./WorldMapRenderer/base.ts, which owns `ctx` + the memoized
// NPC-city node list). To add behavior: find the matching domain mixin (build / viewport / pool / city /
// fog / lifecycle) or add a new one to the chain — do NOT grow this file. Importers resolve
// `from './WorldMapRenderer'` to this file (not the directory), so the class export stays stable.
import { WorldMapRendererBase } from './WorldMapRenderer/base';
import { BuildMixin } from './WorldMapRenderer/build';
import { ViewportMixin } from './WorldMapRenderer/viewport';
import { PoolMixin } from './WorldMapRenderer/pool';
import { CityMixin } from './WorldMapRenderer/city';
import { FogMixin } from './WorldMapRenderer/fog';
import { VignetteMixin } from './WorldMapRenderer/vignette';
import { LifecycleMixin } from './WorldMapRenderer/lifecycle';

const Assembled = LifecycleMixin(
  VignetteMixin(
    FogMixin(
      CityMixin(
        PoolMixin(
          ViewportMixin(
            BuildMixin(WorldMapRendererBase),
          ),
        ),
      ),
    ),
  ),
);

/**
 * WorldMapRenderer — the map/tile renderer wired into WorldMapScene via ctx.view.
 * Assembled from the per-domain mixin chain over WorldMapRendererBase.
 */
export class WorldMapRenderer extends Assembled {}
