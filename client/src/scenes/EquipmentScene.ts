// EquipmentScene — Equipment system client UI (E5, EQUIPMENT_DESIGN §11). Thin assembly file.
//
// The scene is split by domain — each part lives in ./EquipmentScene/*.ts and is composed via the mixin
// chain below over EquipmentSceneBase (./EquipmentScene/base.ts, which owns all instance state + the
// chrome/render dispatcher + shared cost/rarity/glyph helpers). To add a handler: find the matching
// domain mixin (or add a new one to the chain) — do NOT grow this file. EquipmentCallbacks / EquipResult /
// EnhanceResult are re-exported so existing importers (`from './EquipmentScene'`) keep resolving here.
//
// Server-authoritative (L2): material/coin deduction, enhance dice rolls, and inventory state all live on
// the server. This scene only sends intent and reads receipts; cost/success-rate previews are mirrored
// from equipmentDefs, and the true result uses the server-pushed SaveData as the source of truth.
import type { Scene } from './SceneManager';
import { EquipmentSceneBase } from './EquipmentScene/base';
import { InventoryMixin } from './EquipmentScene/inventory';
import { CraftMixin } from './EquipmentScene/craft';
import { DetailMixin } from './EquipmentScene/detail';
import { AssignMixin } from './EquipmentScene/assign';
import { ReforgeMixin } from './EquipmentScene/reforge';

export type { EquipmentCallbacks, EquipResult, EnhanceResult } from './EquipmentScene/base';

const Assembled = ReforgeMixin(
  AssignMixin(
    DetailMixin(
      CraftMixin(
        InventoryMixin(EquipmentSceneBase),
      ),
    ),
  ),
);

/**
 * EquipmentScene — the equipment hub scene registered against SceneManager.
 * Assembled from the per-domain mixin chain over EquipmentSceneBase.
 */
export class EquipmentScene extends Assembled implements Scene {}
