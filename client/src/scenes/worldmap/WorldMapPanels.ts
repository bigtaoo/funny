// WorldMapPanels — every panel/overlay the world map draws on top of the tile layers.
// Thin assembly file.
//
// The class is split by panel domain — each part lives in ./WorldMapPanels/*.ts and is composed
// via the mixin chain below over WorldMapPanelsBase (./WorldMapPanels/base.ts, which owns the
// single `ctx` field plus the modal/toast/deploy primitives and the panel-chrome helpers every
// panel draws itself with). To add a panel: find the matching domain mixin (hud / shop /
// territory / replay) or add a new one to the chain — do NOT grow this file. WorldMapPanels
// stays exported HERE so importers (`from './WorldMapPanels'`) keep resolving to this file,
// not the directory.
import { WorldMapPanelsBase } from './WorldMapPanels/base';
import { HudMixin } from './WorldMapPanels/hud';
import { ShopMixin } from './WorldMapPanels/shop';
import { TerritoryMixin } from './WorldMapPanels/territory';
import { ReplayMixin } from './WorldMapPanels/replay';

const Assembled = ReplayMixin(
  TerritoryMixin(
    ShopMixin(
      HudMixin(WorldMapPanelsBase),
    ),
  ),
);

/**
 * WorldMapPanels — the world map's panel layer, assembled from the per-domain mixin chain.
 * Constructed as `new WorldMapPanels(ctx)` by WorldMapScene.
 */
export class WorldMapPanels extends Assembled {}
